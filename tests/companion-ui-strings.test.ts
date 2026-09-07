import { describe, expect, it } from 'vitest';

import {
  ALL_UI_STRINGS,
  UI_STRINGS,
  formatUiTemplate,
} from '../lib/companion-ui-strings';

describe('formatUiTemplate', () => {
  it('fills numbered placeholders in order', () => {
    expect(formatUiTemplate('{0} to {1} on-device.', ['A', 'B'])).toBe('A to B on-device.');
  });

  it('reorders placeholders as a localized frame requires', () => {
    expect(formatUiTemplate('{1} から {0}', ['A', 'B'])).toBe('B から A');
  });

  it('accepts numeric arguments', () => {
    expect(formatUiTemplate('Translating {0} of {1}…', [3, 7])).toBe('Translating 3 of 7…');
  });

  it('leaves a placeholder literal when its argument is missing', () => {
    expect(formatUiTemplate('{0} and {1}', ['only'])).toBe('only and {1}');
  });

  it('repeats an argument used by more than one placeholder', () => {
    expect(formatUiTemplate('{0}/{0}', ['x'])).toBe('x/x');
  });
});

describe('UI_STRINGS catalogue', () => {
  const values = Object.values(UI_STRINGS);

  it('has no empty strings', () => {
    expect(values.every((value) => value.trim().length > 0)).toBe(true);
  });

  it('numbers every template frame from {0} contiguously', () => {
    for (const value of values) {
      const indices = [...value.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1]));
      if (indices.length === 0) continue;
      const unique = [...new Set(indices)].sort((a, b) => a - b);
      expect(unique[0]).toBe(0);
      expect(unique.at(-1)).toBe(unique.length - 1);
    }
  });

  it('exposes every distinct string once through ALL_UI_STRINGS', () => {
    expect(new Set(ALL_UI_STRINGS).size).toBe(ALL_UI_STRINGS.length);
    expect(new Set(ALL_UI_STRINGS)).toEqual(new Set(values));
  });
});
