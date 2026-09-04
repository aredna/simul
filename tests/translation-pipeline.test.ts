import { describe, expect, it, vi } from 'vitest';

import {
  splitText,
  splitTextSegments,
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

describe('splitTextSegments', () => {
  it('keeps the source whitespace between chunks as separators', () => {
    expect(splitTextSegments('One sentence. Two sentence. Three', 15)).toEqual([
      { text: 'One sentence.', separator: ' ' },
      { text: 'Two sentence.', separator: ' ' },
      { text: 'Three', separator: '' },
    ]);
    expect(splitTextSegments('Para one.\n\nPara two.', 10)).toEqual([
      { text: 'Para one.', separator: '\n\n' },
      { text: 'Para two.', separator: '' },
    ]);
    expect(splitTextSegments('Line one.\r\n\tLine two.', 10)).toEqual([
      { text: 'Line one.', separator: '\r\n\t' },
      { text: 'Line two.', separator: '' },
    ]);
  });

  it('separates punctuation-only boundaries with a single space', () => {
    expect(splitTextSegments('一二三。四五六。七八', 5)).toEqual([
      { text: '一二三。', separator: ' ' },
      { text: '四五六。', separator: ' ' },
      { text: '七八', separator: '' },
    ]);
  });

  it('folds whitespace-only chunks into the neighboring gap', () => {
    expect(splitTextSegments(`abc${' '.repeat(12)}\n\ndef`, 5)).toEqual([
      { text: 'abc', separator: `${' '.repeat(12)}\n\n` },
      { text: 'def', separator: '' },
    ]);
    expect(splitTextSegments(`${' '.repeat(12)}abc`, 5)).toEqual([
      { text: 'abc', separator: '' },
    ]);
    expect(splitTextSegments('short', 10)).toEqual([
      { text: 'short', separator: '' },
    ]);
  });

  it('matches splitText chunk for chunk', () => {
    const source = `${'😀abc '.repeat(2_000)}tail`;
    expect(splitTextSegments(source, 257).map((segment) => segment.text))
      .toEqual(splitText(source, 257));
  });
});

describe('translateWithSession', () => {
  it('preserves paragraph breaks between translated chunks', async () => {
    const calls: string[] = [];
    const session: TranslationSession = {
      translate: async (text) => {
        calls.push(text);
        return `<${text}>`;
      },
      destroy: vi.fn(),
    };

    const translated = await translateWithSession(
      session,
      'Para one.\n\n  Para two.\nPara three.',
      undefined,
      12,
    );

    expect(calls).toEqual(['Para one.', 'Para two.', 'Para three.']);
    expect(translated).toBe('<Para one.>\n\n  <Para two.>\n<Para three.>');
  });

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
