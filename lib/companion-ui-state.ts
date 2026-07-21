import type { TranslationPair } from './translation-provider';

export type CompanionOverlay = 'settings' | 'quick-translate';

export type ToolbarProgressState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'determinate'; readonly ratio: number }
  | { readonly kind: 'indeterminate' };

export interface ToolbarActivity {
  readonly determinateRatio?: number;
  readonly captureInFlight: boolean;
  readonly translationInFlight: boolean;
  readonly permissionInFlight: boolean;
  readonly composerInFlight: boolean;
  readonly liveDeltaInFlight: boolean;
  readonly imageTranslationInFlight: boolean;
  readonly surfaceTransitionInFlight: boolean;
}

/** Keep compact progress derivation deterministic and independent of the DOM. */
export function toolbarProgressState(
  activity: ToolbarActivity,
): ToolbarProgressState {
  if (
    activity.translationInFlight &&
    typeof activity.determinateRatio === 'number' &&
    Number.isFinite(activity.determinateRatio)
  ) {
    return {
      kind: 'determinate',
      ratio: Math.min(1, Math.max(0, activity.determinateRatio)),
    };
  }
  if (
    activity.captureInFlight ||
    activity.translationInFlight ||
    activity.permissionInFlight ||
    activity.composerInFlight ||
    activity.liveDeltaInFlight ||
    activity.imageTranslationInFlight ||
    activity.surfaceTransitionInFlight
  ) {
    return { kind: 'indeterminate' };
  }
  return { kind: 'idle' };
}

export function toolbarActivityLabel(activity: ToolbarActivity): string {
  if (activity.surfaceTransitionInFlight) return 'Changing companion view';
  if (activity.permissionInFlight) return 'Updating site access';
  if (activity.captureInFlight) return 'Building page mirror';
  if (activity.composerInFlight) return 'Translating quick draft';
  if (activity.translationInFlight) return 'Translating page';
  if (activity.imageTranslationInFlight) return 'Recognizing image text';
  if (activity.liveDeltaInFlight) return 'Updating live mirror';
  return 'Companion idle';
}

/** The quick composer translates in the reverse direction of the page. */
export function reverseTranslationPair(
  pagePair: TranslationPair | undefined,
): TranslationPair | undefined {
  return pagePair
    ? {
        sourceLanguage: pagePair.targetLanguage,
        targetLanguage: pagePair.sourceLanguage,
      }
    : undefined;
}

export function nextCompanionOverlay(
  current: CompanionOverlay | undefined,
  requested: CompanionOverlay,
): CompanionOverlay | undefined {
  return current === requested ? undefined : requested;
}
