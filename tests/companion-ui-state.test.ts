import { describe, expect, it } from 'vitest';

import {
  nextCompanionOverlay,
  reverseTranslationPair,
  toolbarActivityLabel,
  toolbarProgressState,
  type ToolbarActivity,
} from '../lib/companion-ui-state';

const IDLE_ACTIVITY: ToolbarActivity = {
  captureInFlight: false,
  translationInFlight: false,
  permissionInFlight: false,
  composerInFlight: false,
  liveDeltaInFlight: false,
  imageTranslationInFlight: false,
  surfaceTransitionInFlight: false,
};

describe('companion UI state', () => {
  it('reverses the page pair for a quick reply and stays unresolved safely', () => {
    expect(reverseTranslationPair({
      sourceLanguage: 'ja',
      targetLanguage: 'en',
    })).toEqual({
      sourceLanguage: 'en',
      targetLanguage: 'ja',
    });
    expect(reverseTranslationPair(undefined)).toBeUndefined();
  });

  it('clamps determinate translation progress', () => {
    expect(toolbarProgressState({
      ...IDLE_ACTIVITY,
      translationInFlight: true,
      determinateRatio: -1,
    })).toEqual({ kind: 'determinate', ratio: 0 });
    expect(toolbarProgressState({
      ...IDLE_ACTIVITY,
      translationInFlight: true,
      determinateRatio: 0.45,
    })).toEqual({ kind: 'determinate', ratio: 0.45 });
    expect(toolbarProgressState({
      ...IDLE_ACTIVITY,
      translationInFlight: true,
      determinateRatio: 4,
    })).toEqual({ kind: 'determinate', ratio: 1 });
  });

  it.each([
    'captureInFlight',
    'translationInFlight',
    'permissionInFlight',
    'composerInFlight',
    'liveDeltaInFlight',
    'imageTranslationInFlight',
    'surfaceTransitionInFlight',
  ] as const)('shows indeterminate progress for %s', (activity) => {
    expect(toolbarProgressState({
      ...IDLE_ACTIVITY,
      [activity]: true,
    })).toEqual({ kind: 'indeterminate' });
  });

  it('returns to idle and keeps panels mutually exclusive', () => {
    expect(toolbarProgressState(IDLE_ACTIVITY)).toEqual({ kind: 'idle' });
    expect(nextCompanionOverlay(undefined, 'settings')).toBe('settings');
    expect(nextCompanionOverlay('settings', 'quick-translate'))
      .toBe('quick-translate');
    expect(nextCompanionOverlay('quick-translate', 'quick-translate'))
      .toBeUndefined();
  });

  it('gives indeterminate work a concise accessible label', () => {
    expect(toolbarActivityLabel({
      ...IDLE_ACTIVITY,
      liveDeltaInFlight: true,
    })).toBe('Updating live mirror');
    expect(toolbarActivityLabel({
      ...IDLE_ACTIVITY,
      composerInFlight: true,
    })).toBe('Translating quick draft');
    expect(toolbarActivityLabel(IDLE_ACTIVITY)).toBe('Companion idle');
  });
});
