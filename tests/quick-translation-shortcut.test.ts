import { describe, expect, it } from 'vitest';

import { isQuickTranslationShortcut } from '../lib/quick-translation-shortcut';

describe('isQuickTranslationShortcut', () => {
  it('accepts the platform submit shortcuts', () => {
    expect(isQuickTranslationShortcut({
      key: 'Enter', ctrlKey: true, metaKey: false,
    })).toBe(true);
    expect(isQuickTranslationShortcut({
      key: 'Enter', ctrlKey: false, metaKey: true,
    })).toBe(true);
  });

  it('keeps ordinary multiline typing available', () => {
    expect(isQuickTranslationShortcut({
      key: 'Enter', ctrlKey: false, metaKey: false,
    })).toBe(false);
    expect(isQuickTranslationShortcut({
      key: 'a', ctrlKey: true, metaKey: false,
    })).toBe(false);
  });

  it('ignores composition, repeats, and alternate-key chords', () => {
    expect(isQuickTranslationShortcut({
      key: 'Enter', ctrlKey: true, metaKey: false, isComposing: true,
    })).toBe(false);
    expect(isQuickTranslationShortcut({
      key: 'Enter', ctrlKey: true, metaKey: false, repeat: true,
    })).toBe(false);
    expect(isQuickTranslationShortcut({
      key: 'Enter', ctrlKey: true, metaKey: false, altKey: true,
    })).toBe(false);
  });
});
