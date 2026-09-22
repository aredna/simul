import { describe, expect, it } from 'vitest';

import {
  nextCompanionOverlay,
  reverseTranslationPair,
  toolbarActivityLabel,
  toolbarOcrClickAction,
  toolbarProgressState,
  type ToolbarActivity,
} from '../lib/companion-ui-state';
import { ALL_UI_STRINGS } from '../lib/companion-ui-strings';

const IDLE_ACTIVITY: ToolbarActivity = {
  captureInFlight: false,
  translationInFlight: false,
  permissionInFlight: false,
  composerInFlight: false,
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
      composerInFlight: true,
    })).toBe('Translating quick draft');
    expect(toolbarActivityLabel(IDLE_ACTIVITY)).toBe('Companion idle');
  });

  it('draws every activity label from the atomic localization set', () => {
    // The progressbar aria-labels are localized through the catalogue, so each
    // must be a registered string or it silently stays English (finding F1).
    const activities: readonly (keyof ToolbarActivity)[] = [
      'captureInFlight',
      'translationInFlight',
      'permissionInFlight',
      'composerInFlight',
      'imageTranslationInFlight',
      'surfaceTransitionInFlight',
    ];
    for (const activity of activities) {
      const label = toolbarActivityLabel({ ...IDLE_ACTIVITY, [activity]: true });
      expect(ALL_UI_STRINGS).toContain(label);
    }
    expect(ALL_UI_STRINGS).toContain(toolbarActivityLabel(IDLE_ACTIVITY));
  });
});

describe('toolbar OCR click (G3)', () => {
  const click = (overrides: Partial<Parameters<typeof toolbarOcrClickAction>[0]>) =>
    toolbarOcrClickAction({
      enabled: true,
      accessGranted: false,
      usablePixelProviders: 1,
      accessDeclined: false,
      ...overrides,
    });

  it('asks for image access from the default "on" state, then turns OCR off once Chrome refused', () => {
    expect(click({})).toBe('request-access');
    expect(click({ accessDeclined: true })).toBe('disable');
  });

  it('turns OCR on when off and off when it has access or nothing to ask for', () => {
    expect(click({ enabled: false, accessDeclined: true })).toBe('enable');
    expect(click({ accessGranted: true })).toBe('disable');
    expect(click({ usablePixelProviders: 0 })).toBe('disable');
  });
});
