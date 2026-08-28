import { describe, expect, it, vi } from 'vitest';

import {
  splitText,
  translateWithSession,
} from '../lib/translation-pipeline';
import type { TranslationSession } from '../lib/translation-provider';

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

  it('chunks large inputs without losing code points across the moving cursor', () => {
    const source = `${'😀abc '.repeat(20_000)}tail`;
    const chunks = splitText(source, 257);

    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.every((chunk) => [...chunk].length <= 257)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/gu, ' ')).toBe(
      source.replace(/\s+/gu, ' '),
    );
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
