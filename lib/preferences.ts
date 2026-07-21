export const COMPANION_PREFERENCES_STORAGE_KEY =
  'simul.companionPreferences.v1';

/** Kept short for browser.storage adapters that prefer a generic key import. */
export const STORAGE_KEY = COMPANION_PREFERENCES_STORAGE_KEY;

export const AUTO_TRANSLATION_MODES = ['off', 'site', 'all'] as const;

export type AutoTranslationMode = (typeof AUTO_TRANSLATION_MODES)[number];

import {
  isSupportedLanguage,
  type SupportedLanguage,
} from './translation-provider';

export const MIRROR_DISPLAY_MODES = ['fit', 'actual', 'custom'] as const;

export type MirrorDisplayMode = (typeof MIRROR_DISPLAY_MODES)[number];

export const TEXT_LAYOUT_MODES = ['adaptive', 'faithful'] as const;

export type TextLayoutMode = (typeof TEXT_LAYOUT_MODES)[number];

export const REPLICA_ENGINE_PREFERENCES = ['isolated-html', 'rrweb'] as const;

export type ReplicaEnginePreference =
  (typeof REPLICA_ENGINE_PREFERENCES)[number];

export const REPLICA_VIEW_MODES = ['translated', 'source-only'] as const;

export type ReplicaViewMode = (typeof REPLICA_VIEW_MODES)[number];

export const COMPANION_LAUNCH_BEHAVIORS = [
  'last-used',
  'side-panel',
  'popout',
] as const;

export type CompanionLaunchBehavior =
  (typeof COMPANION_LAUNCH_BEHAVIORS)[number];

export const COMPANION_SURFACES = ['side-panel', 'popout'] as const;

export type CompanionSurface = (typeof COMPANION_SURFACES)[number];

export const POPOUT_TAB_MODES = ['locked', 'active'] as const;

export type PopoutTabMode = (typeof POPOUT_TAB_MODES)[number];

export type SourceLanguagePreference = 'auto' | SupportedLanguage;

import {
  isImageScanPolicy,
  type ImageScanPolicy,
} from './ocr/contracts';
import {
  IMAGE_TEXT_PROVIDER_IDS,
  repairImageTextProviderOrder,
  type ImageTextProviderId,
} from './ocr/known-provider-ids';

export const MIN_ZOOM_PERCENT = 25;
export const MAX_ZOOM_PERCENT = 300;

export const ALL_SITES_PERMISSION_ORIGINS = [
  '<all_urls>',
] as const;

/**
 * Previous builds requested these patterns for automatic translation. They
 * cannot authorize tabs.captureVisibleTab(), so new grants use the literal
 * canonical pattern above. The coordinator only uses this pair to reconcile
 * existing installs during the migration.
 */
export const LEGACY_ALL_SITES_PERMISSION_ORIGINS = [
  'http://*/*',
  'https://*/*',
] as const;

export interface CompanionPreferences {
  /** Whether every HTTP(S) origin is opted in to automatic translation. */
  autoTranslateAllSites: boolean;
  /** Canonical HTTP(S) origins individually opted in by the user. */
  autoTranslateOrigins: string[];
  displayMode: MirrorDisplayMode;
  sourceLanguage: SourceLanguagePreference;
  targetLanguage: SupportedLanguage;
  zoomPercent: number;
  syncScroll: boolean;
  textLayoutMode: TextLayoutMode;
  replicaEngine: ReplicaEnginePreference;
  replicaViewMode: ReplicaViewMode;
  launchBehavior: CompanionLaunchBehavior;
  lastLaunchSurface: CompanionSurface;
  popoutTabMode: PopoutTabMode;
  imageTranslationEnabled: boolean;
  imageTextProviderOrder: ImageTextProviderId[];
  imageScanPolicy: ImageScanPolicy;
  skipSmallImages: boolean;
  usePromptForImageLanguage: boolean;
  usePromptForImageText: boolean;
}

export const DEFAULT_COMPANION_PREFERENCES: Readonly<CompanionPreferences> =
  Object.freeze({
    autoTranslateAllSites: false,
    autoTranslateOrigins: Object.freeze([]) as unknown as string[],
    displayMode: 'fit',
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    zoomPercent: 100,
    syncScroll: true,
    textLayoutMode: 'adaptive',
    replicaEngine: 'isolated-html',
    replicaViewMode: 'translated',
    launchBehavior: 'last-used',
    lastLaunchSurface: 'side-panel',
    popoutTabMode: 'locked',
    imageTranslationEnabled: false,
    imageTextProviderOrder: Object.freeze([
      ...IMAGE_TEXT_PROVIDER_IDS,
    ]) as unknown as ImageTextProviderId[],
    imageScanPolicy: 'visible-first-background-prescan',
    skipSmallImages: true,
    usePromptForImageLanguage: false,
    usePromptForImageText: false,
  });

const MAX_SAVED_ORIGINS = 256;

/** Parse untrusted persisted data without allowing it to broaden site access. */
export function parseCompanionPreferences(
  input: unknown,
): CompanionPreferences {
  if (!isRecord(input)) return createDefaultPreferences();

  const autoTranslateOrigins: string[] = [];
  const seenOrigins = new Set<string>();
  const rawOrigins = input.autoTranslateOrigins;

  if (Array.isArray(rawOrigins)) {
    for (const value of rawOrigins) {
      const origin = parseStoredOrigin(value);
      if (!origin || seenOrigins.has(origin)) continue;

      seenOrigins.add(origin);
      autoTranslateOrigins.push(origin);
      if (autoTranslateOrigins.length >= MAX_SAVED_ORIGINS) break;
    }
  }

  return {
    autoTranslateAllSites: input.autoTranslateAllSites === true,
    autoTranslateOrigins,
    displayMode: isMirrorDisplayMode(input.displayMode)
      ? input.displayMode
      : DEFAULT_COMPANION_PREFERENCES.displayMode,
    sourceLanguage:
      input.sourceLanguage === 'auto' || isSupportedLanguage(input.sourceLanguage)
        ? input.sourceLanguage
        : DEFAULT_COMPANION_PREFERENCES.sourceLanguage,
    targetLanguage: isSupportedLanguage(input.targetLanguage)
      ? input.targetLanguage
      : DEFAULT_COMPANION_PREFERENCES.targetLanguage,
    zoomPercent: parseZoomPercent(input.zoomPercent),
    syncScroll:
      typeof input.syncScroll === 'boolean'
        ? input.syncScroll
        : DEFAULT_COMPANION_PREFERENCES.syncScroll,
    textLayoutMode: isTextLayoutMode(input.textLayoutMode)
      ? input.textLayoutMode
      : DEFAULT_COMPANION_PREFERENCES.textLayoutMode,
    replicaEngine: isReplicaEnginePreference(input.replicaEngine)
      ? input.replicaEngine
      : DEFAULT_COMPANION_PREFERENCES.replicaEngine,
    replicaViewMode: isReplicaViewMode(input.replicaViewMode)
      ? input.replicaViewMode
      : DEFAULT_COMPANION_PREFERENCES.replicaViewMode,
    launchBehavior: isCompanionLaunchBehavior(input.launchBehavior)
      ? input.launchBehavior
      : DEFAULT_COMPANION_PREFERENCES.launchBehavior,
    lastLaunchSurface: isCompanionSurface(input.lastLaunchSurface)
      ? input.lastLaunchSurface
      : DEFAULT_COMPANION_PREFERENCES.lastLaunchSurface,
    popoutTabMode: isPopoutTabMode(input.popoutTabMode)
      ? input.popoutTabMode
      : DEFAULT_COMPANION_PREFERENCES.popoutTabMode,
    imageTranslationEnabled:
      typeof input.imageTranslationEnabled === 'boolean'
        ? input.imageTranslationEnabled
        : DEFAULT_COMPANION_PREFERENCES.imageTranslationEnabled,
    imageTextProviderOrder: repairImageTextProviderOrder(
      input.imageTextProviderOrder,
    ),
    imageScanPolicy: isImageScanPolicy(input.imageScanPolicy)
      ? input.imageScanPolicy
      : DEFAULT_COMPANION_PREFERENCES.imageScanPolicy,
    skipSmallImages:
      typeof input.skipSmallImages === 'boolean'
        ? input.skipSmallImages
        : DEFAULT_COMPANION_PREFERENCES.skipSmallImages,
    usePromptForImageLanguage:
      typeof input.usePromptForImageLanguage === 'boolean'
        ? input.usePromptForImageLanguage
        : DEFAULT_COMPANION_PREFERENCES.usePromptForImageLanguage,
    usePromptForImageText:
      typeof input.usePromptForImageText === 'boolean'
        ? input.usePromptForImageText
        : DEFAULT_COMPANION_PREFERENCES.usePromptForImageText,
  };
}

export function isAutoTranslationMode(
  value: unknown,
): value is AutoTranslationMode {
  return AUTO_TRANSLATION_MODES.includes(value as AutoTranslationMode);
}

export function isMirrorDisplayMode(
  value: unknown,
): value is MirrorDisplayMode {
  return MIRROR_DISPLAY_MODES.includes(value as MirrorDisplayMode);
}

export function isTextLayoutMode(value: unknown): value is TextLayoutMode {
  return TEXT_LAYOUT_MODES.includes(value as TextLayoutMode);
}

export function isReplicaEnginePreference(
  value: unknown,
): value is ReplicaEnginePreference {
  return REPLICA_ENGINE_PREFERENCES.includes(value as ReplicaEnginePreference);
}

export function isReplicaViewMode(value: unknown): value is ReplicaViewMode {
  return REPLICA_VIEW_MODES.includes(value as ReplicaViewMode);
}

export function isCompanionLaunchBehavior(
  value: unknown,
): value is CompanionLaunchBehavior {
  return COMPANION_LAUNCH_BEHAVIORS.includes(
    value as CompanionLaunchBehavior,
  );
}

export function isCompanionSurface(value: unknown): value is CompanionSurface {
  return COMPANION_SURFACES.includes(value as CompanionSurface);
}

export function isPopoutTabMode(value: unknown): value is PopoutTabMode {
  return POPOUT_TAB_MODES.includes(value as PopoutTabMode);
}

/** Return a canonical origin only for ordinary HTTP(S) page URLs. */
export function pageOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return undefined;
    }

    return parsed.origin;
  } catch {
    return undefined;
  }
}

/** Build the narrowest Chrome host match pattern for the page's origin. */
export function sitePermissionPattern(
  url: string | undefined,
): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.port
    ) {
      return undefined;
    }
    return `${parsed.origin}/*`;
  } catch {
    return undefined;
  }
}

export function permissionOriginsForMode(
  mode: AutoTranslationMode,
  url?: string,
): string[] {
  if (mode === 'all') return [...ALL_SITES_PERMISSION_ORIGINS];
  if (mode === 'off') return [];

  const pattern = sitePermissionPattern(url);
  return pattern ? [pattern] : [];
}

export function permissionOriginsForPreferences(
  preferences: CompanionPreferences,
): string[] {
  const normalized = parseCompanionPreferences(preferences);
  if (normalized.autoTranslateAllSites) {
    return [...ALL_SITES_PERMISSION_ORIGINS];
  }

  return normalized.autoTranslateOrigins.flatMap((origin) => {
    const pattern = sitePermissionPattern(origin);
    return pattern ? [pattern] : [];
  });
}

export function autoTranslationModeForPage(
  preferences: CompanionPreferences,
  url: string | undefined,
): AutoTranslationMode {
  const normalized = parseCompanionPreferences(preferences);
  if (normalized.autoTranslateAllSites) return 'all';

  const origin = pageOrigin(url);
  return origin && normalized.autoTranslateOrigins.includes(origin)
    ? 'site'
    : 'off';
}

export function isAutoTranslationEnabled(
  preferences: CompanionPreferences,
  url: string | undefined,
): boolean {
  return autoTranslationModeForPage(preferences, url) !== 'off';
}

/**
 * Apply a scope choice for the current page. Other site-specific choices are
 * retained, while choosing Off removes only the current site and disables a
 * global opt-in.
 */
export function withAutoTranslationMode(
  preferences: CompanionPreferences,
  url: string | undefined,
  mode: AutoTranslationMode,
): CompanionPreferences {
  const normalized = parseCompanionPreferences(preferences);
  const origin = pageOrigin(url);

  if (mode === 'all') {
    return { ...normalized, autoTranslateAllSites: true };
  }

  const origins = origin
    ? normalized.autoTranslateOrigins.filter((candidate) => candidate !== origin)
    : [...normalized.autoTranslateOrigins];

  if (mode === 'site' && origin) {
    if (origins.length >= MAX_SAVED_ORIGINS) return normalized;
    origins.push(origin);
  }

  return {
    ...normalized,
    autoTranslateAllSites: false,
    autoTranslateOrigins: origins,
  };
}

export function withDisplayMode(
  preferences: CompanionPreferences,
  displayMode: MirrorDisplayMode,
): CompanionPreferences {
  return {
    ...parseCompanionPreferences(preferences),
    displayMode,
  };
}

export interface CompanionViewSettings {
  displayMode: MirrorDisplayMode;
  sourceLanguage: SourceLanguagePreference;
  targetLanguage: SupportedLanguage;
  zoomPercent: number;
  syncScroll: boolean;
  textLayoutMode: TextLayoutMode;
  replicaEngine: ReplicaEnginePreference;
  replicaViewMode: ReplicaViewMode;
  launchBehavior: CompanionLaunchBehavior;
  lastLaunchSurface: CompanionSurface;
  popoutTabMode: PopoutTabMode;
}

export type CompanionViewSettingsPatch = Partial<CompanionViewSettings>;

export interface CompanionImageAnalysisSettings {
  imageTranslationEnabled: boolean;
  imageTextProviderOrder: ImageTextProviderId[];
  imageScanPolicy: ImageScanPolicy;
  skipSmallImages: boolean;
  usePromptForImageLanguage: boolean;
  usePromptForImageText: boolean;
}

export type CompanionImageAnalysisSettingsPatch =
  Partial<CompanionImageAnalysisSettings>;

export function withViewSettings(
  preferences: CompanionPreferences,
  settings: CompanionViewSettingsPatch,
): CompanionPreferences {
  return parseCompanionPreferences({
    ...parseCompanionPreferences(preferences),
    ...settings,
  });
}

export function withImageAnalysisSettings(
  preferences: CompanionPreferences,
  settings: CompanionImageAnalysisSettingsPatch,
): CompanionPreferences {
  return parseCompanionPreferences({
    ...parseCompanionPreferences(preferences),
    ...settings,
  });
}

export function clampZoomPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPANION_PREFERENCES.zoomPercent;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(value)));
}

function createDefaultPreferences(): CompanionPreferences {
  return {
    autoTranslateAllSites: false,
    autoTranslateOrigins: [],
    displayMode: 'fit',
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    zoomPercent: 100,
    syncScroll: true,
    textLayoutMode: 'adaptive',
    replicaEngine: 'isolated-html',
    replicaViewMode: 'translated',
    launchBehavior: 'last-used',
    lastLaunchSurface: 'side-panel',
    popoutTabMode: 'locked',
    imageTranslationEnabled: false,
    imageTextProviderOrder: [...IMAGE_TEXT_PROVIDER_IDS],
    imageScanPolicy: 'visible-first-background-prescan',
    skipSmallImages: true,
    usePromptForImageLanguage: false,
    usePromptForImageText: false,
  };
}

function parseZoomPercent(value: unknown): number {
  return typeof value === 'number'
    ? clampZoomPercent(value)
    : DEFAULT_COMPANION_PREFERENCES.zoomPercent;
}

function parseStoredOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.port ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }

    // Stored values are origins, not URLs that may silently expand scope.
    if (value !== parsed.origin && value !== `${parsed.origin}/`) {
      return undefined;
    }

    return parsed.origin;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
