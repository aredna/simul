import { describe, expect, it, vi } from 'vitest';

import type { PageSnapshot } from '../lib/page-snapshot';
import {
  countIncompleteTranslations,
  displayTranslation,
  retryIncompleteTranslations,
  splitText,
  translateSnapshot,
  translateWithSession,
} from '../lib/translation-pipeline';
import type { TranslationSession } from '../lib/translation-provider';

const snapshot: PageSnapshot = {
  version: 1,
  title: 'Test page',
  url: 'https://example.com/',
  capturedAt: '2026-07-19T00:00:00.000Z',
  items: [
    { id: 'text-1', kind: 'text', role: 'heading-1', text: 'こんにちは' },
    { id: 'text-2', kind: 'text', role: 'paragraph', text: '同じ文章' },
    { id: 'text-3', kind: 'text', role: 'paragraph', text: '同じ文章' },
    {
      id: 'image-4',
      kind: 'image',
      src: 'https://example.com/image.png',
      altText: '山',
      caption: '失敗',
    },
  ],
  omissions: {
    hidden: 0,
    controls: 0,
    frames: 0,
    unsafeImages: 0,
    truncated: false,
  },
};

describe('translateSnapshot', () => {
  it('translates sequentially in document order and deduplicates exact text', async () => {
    const calls: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const session = createSession(async (text) => {
      calls.push(text);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return `translated:${text}`;
    });
    const progress = vi.fn();

    const result = await translateSnapshot(snapshot, session, {
      onProgress: progress,
    });

    expect(calls).toEqual(['こんにちは', '同じ文章', '山', '失敗']);
    expect(maxConcurrent).toBe(1);
    expect(result.state).toBe('complete');
    expect(result).toMatchObject({ total: 4, completed: 4, failed: 0 });
    expect(result.items.map((item) => item.id)).toEqual(
      snapshot.items.map((item) => item.id),
    );

    const duplicateOne = result.items[1];
    const duplicateTwo = result.items[2];
    expect(duplicateOne?.kind).toBe('text');
    expect(duplicateTwo?.kind).toBe('text');
    if (duplicateOne?.kind === 'text' && duplicateTwo?.kind === 'text') {
      expect(displayTranslation(duplicateOne.translation)).toBe(
        'translated:同じ文章',
      );
      expect(displayTranslation(duplicateTwo.translation)).toBe(
        'translated:同じ文章',
      );
    }
    expect(progress).toHaveBeenCalledTimes(4);
  });

  it('preserves successful work and retries only failed fields', async () => {
    const initialSession = createSession(async (text) => {
      if (text === '失敗') throw new Error('Temporary local model failure');
      return `first:${text}`;
    });
    const partial = await translateSnapshot(snapshot, initialSession);

    expect(partial.state).toBe('partial');
    expect(partial.failed).toBe(1);
    expect(countIncompleteTranslations(partial)).toBe(1);

    const retryTranslate = vi.fn(async (text: string) => `retry:${text}`);
    const completed = await retryIncompleteTranslations(
      partial,
      createSession(retryTranslate),
    );

    expect(retryTranslate).toHaveBeenCalledOnce();
    expect(retryTranslate).toHaveBeenCalledWith('失敗', undefined);
    expect(completed.state).toBe('complete');
    expect(countIncompleteTranslations(completed)).toBe(0);

    const firstItem = completed.items[0];
    const image = completed.items[3];
    if (firstItem?.kind === 'text') {
      expect(firstItem.translation.translated).toBe('first:こんにちは');
    }
    if (image?.kind === 'image') {
      expect(image.captionTranslation?.translated).toBe('retry:失敗');
    }
  });

  it('returns actionable cancelled fields without mutating the snapshot', async () => {
    const controller = new AbortController();
    const original = structuredClone(snapshot);
    const session = createSession(async () => {
      controller.abort();
      throw new DOMException('Aborted', 'AbortError');
    });

    const result = await translateSnapshot(snapshot, session, {
      signal: controller.signal,
    });

    expect(result.state).toBe('cancelled');
    expect(countIncompleteTranslations(result)).toBeGreaterThan(0);
    expect(snapshot).toEqual(original);
  });

  it('marks work over configured bounds as partial instead of sending it', async () => {
    const translate = vi.fn(async (text: string) => text);
    const result = await translateSnapshot(snapshot, createSession(translate), {
      maxUniqueTexts: 1,
      maxCharacters: 10,
    });

    expect(translate).toHaveBeenCalledOnce();
    expect(result.state).toBe('partial');
    expect(result.failed).toBeGreaterThan(0);
  });

  it('reports deduplicated progress and failure counts in the same units', async () => {
    const duplicateFailure: PageSnapshot = {
      ...snapshot,
      items: [
        { id: 'a', kind: 'text', role: 'paragraph', text: 'same' },
        { id: 'b', kind: 'text', role: 'paragraph', text: 'same' },
      ],
    };
    const result = await translateSnapshot(
      duplicateFailure,
      createSession(async () => {
        throw new Error('failed once');
      }),
    );

    expect(result).toMatchObject({ total: 1, completed: 1, failed: 1 });
    expect(countIncompleteTranslations(result)).toBe(1);
  });

  it('measures and splits input so no translate request exceeds Chrome quota', async () => {
    const translatedChunks: string[] = [];
    const measuredChunks: string[] = [];
    const quotaSession: TranslationSession = {
      inputQuota: 3,
      async measureInputUsage(text) {
        measuredChunks.push(text);
        return [...text].length;
      },
      async translate(text) {
        translatedChunks.push(text);
        return text;
      },
      destroy: vi.fn(),
    };
    const quotaSnapshot: PageSnapshot = {
      ...snapshot,
      items: [
        { id: 'quota', kind: 'text', role: 'paragraph', text: '😀abcdef' },
      ],
    };

    const result = await translateSnapshot(quotaSnapshot, quotaSession, {
      maxInputCharacters: 5,
    });

    expect(result.state).toBe('complete');
    expect(measuredChunks.length).toBeGreaterThan(translatedChunks.length);
    expect(
      translatedChunks.every((chunk) => [...chunk].length <= 3),
    ).toBe(true);
    expect(translatedChunks.join('')).toContain('😀');
    expect(translatedChunks.every((chunk) => !hasUnpairedSurrogate(chunk))).toBe(
      true,
    );
  });

  it('sanitizes non-finite numeric options instead of bypassing bounds', async () => {
    const translate = vi.fn(async (text: string) => text);
    const result = await translateSnapshot(snapshot, createSession(translate), {
      maxUniqueTexts: Number.NaN,
      maxCharacters: Number.POSITIVE_INFINITY,
      maxInputCharacters: Number.NaN,
    });

    expect(result.state).toBe('complete');
    expect(translate).toHaveBeenCalledTimes(4);
  });
});

describe('splitText', () => {
  it('chunks long translator input on useful boundaries', () => {
    const chunks = splitText('One sentence. Two sentence. Three', 15);
    expect(chunks.every((chunk) => [...chunk].length <= 15)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/gu, ' ')).toBe(
      'One sentence. Two sentence. Three',
    );
  });

  it('never splits surrogate pairs or emits a maxLength + 1 chunk', () => {
    const chunks = splitText('😀😀😀 abcdef', 3);

    expect(chunks.every((chunk) => [...chunk].length <= 3)).toBe(true);
    expect(chunks.every((chunk) => !hasUnpairedSurrogate(chunk))).toBe(true);
    expect(chunks.join('').replace(/\s+/gu, '')).toBe('😀😀😀abcdef');
  });

  it('uses a finite default when maxLength is not finite', () => {
    expect(splitText('short', Number.NaN)).toEqual(['short']);
    expect(splitText('short', Number.POSITIVE_INFINITY)).toEqual(['short']);
  });
});

describe('translateWithSession', () => {
  it('is reusable for single values and honors measured session quota', async () => {
    const calls: string[] = [];
    const session: TranslationSession = {
      inputQuota: 2,
      measureInputUsage: async (text) => [...text].length,
      translate: async (text) => {
        calls.push(text);
        return `<${text}>`;
      },
      destroy: vi.fn(),
    };

    const translated = await translateWithSession(
      session,
      'abcdef',
      undefined,
      6,
    );

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((chunk) => [...chunk].length <= 2)).toBe(true);
    expect(translated).toBe(calls.map((chunk) => `<${chunk}>`).join(' '));
  });
});

function createSession(
  translate: (text: string, signal?: AbortSignal) => Promise<string>,
): TranslationSession {
  return {
    translate,
    destroy: vi.fn(),
  };
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
