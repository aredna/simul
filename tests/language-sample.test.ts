import { describe, expect, it } from 'vitest';

import { buildBoundedLanguageSample } from '../lib/translation/language-sample';

describe('buildBoundedLanguageSample', () => {
  it('normalizes record boundaries and whitespace within the requested bound', () => {
    expect(buildBoundedLanguageSample([
      '  Hola\n mundo  ',
      '\tde la web ',
    ], 15)).toBe('Hola mundo de l');
  });

  it('stops consuming records as soon as the sample is full', () => {
    function* sources(): Generator<string> {
      yield '12345';
      throw new Error('The unneeded record must not be consumed.');
    }

    expect(buildBoundedLanguageSample(sources(), 5)).toBe('12345');
  });

  it('does not split a multi-unit character at the boundary', () => {
    expect(buildBoundedLanguageSample(['ab😀'], 3)).toBe('ab');
  });
});
