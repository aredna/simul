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
import {
  isSelectableReplicaFidelityPolicy,
  type SelectableReplicaFidelityPolicy,
} from './replica/fidelity-policy';
import {
  PAGE_ONLY_REPLICA_READ_SCOPE,
  REPLICA_READ_SCOPE_SETUP_VERSION,
  repairReplicaReadScope,
  type ReplicaReadScope,
} from './replica/read-scope-policy';

export const MIRROR_DISPLAY_MODES = ['fit', 'actual', 'custom'] as const;

export type MirrorDisplayMode = (typeof MIRROR_DISPLAY_MODES)[number];

export const TEXT_LAYOUT_MODES = ['adaptive', 'faithful'] as const;

export type TextLayoutMode = (typeof TEXT_LAYOUT_MODES)[number];

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
  repairDisabledImageTextProviderIds,
  repairImageTextProviderOrder,
  type ImageTextProviderId,
} from './ocr/known-provider-ids';
import {
  DEFAULT_OCR_MINIMUM_CONFIDENCE,
  repairOcrMinimumConfidence,
  type OcrMinimumConfidence,
} from './ocr/result-quality';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  IMAGE_READING_METHOD_IDS,
  isOcrImageReadingMethod,
  repairDisabledImageReadingMethodIds,
  repairImageReadingMethodOrder,
  type ImageReadingMethodId,
} from './ocr/image-reading-methods';

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
  /**
   * Host permission patterns Simul itself relies on and may release again.
   * Automatic reconciliation revokes only these; a grant the user made in
   * chrome://extensions that Simul never asked for is left alone.
   */
  grantedPermissionOrigins: string[];
  displayMode: MirrorDisplayMode;
  sourceLanguage: SourceLanguagePreference;
  targetLanguage: SupportedLanguage;
  zoomPercent: number;
  syncScroll: boolean;
  textLayoutMode: TextLayoutMode;
  replicaFidelityPolicy: SelectableReplicaFidelityPolicy;
  replicaViewMode: ReplicaViewMode;
  launchBehavior: CompanionLaunchBehavior;
  lastLaunchSurface: CompanionSurface;
  popoutTabMode: PopoutTabMode;
  /** Six independent, runtime-selectable source evidence gates. */
  replicaReadScope: ReplicaReadScope;
  /** Zero means first-load setup is required and Page-only is effective. */
  readScopeSetupVersion: number;
  /** Monotonic revision for ordering committed preference snapshots. */
  settingsRevision: number;
  /** Monotonic generation guarding all durable settings writes. */
  resetRevision: number;
  /** Non-zero while post-reset permission/transient cleanup is retryable. */
  resetCleanupPendingRevision: number;
  imageTranslationEnabled: boolean;
  ocrMinimumConfidence: OcrMinimumConfidence;
  /** Canonical priority list spanning semantic and OCR image methods. */
  imageReadingMethodOrder: ImageReadingMethodId[];
  disabledImageReadingMethodIds: ImageReadingMethodId[];
  /** Compatibility mirrors consumed by OCR-only runtime components. */
  imageTextProviderOrder: ImageTextProviderId[];
  disabledImageTextProviderIds: ImageTextProviderId[];
  imageScanPolicy: ImageScanPolicy;
  skipSmallImages: boolean;
  usePromptForImageLanguage: boolean;
  usePromptForImageText: boolean;
}

export const DEFAULT_COMPANION_PREFERENCES: Readonly<CompanionPreferences> =
  Object.freeze({
    autoTranslateAllSites: false,
    autoTranslateOrigins: Object.freeze([]) as unknown as string[],
    grantedPermissionOrigins: Object.freeze([]) as unknown as string[],
    displayMode: 'fit',
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    zoomPercent: 100,
    syncScroll: true,
    textLayoutMode: 'adaptive',
    replicaFidelityPolicy: 'passive',
    replicaViewMode: 'translated',
    launchBehavior: 'last-used',
    lastLaunchSurface: 'side-panel',
    popoutTabMode: 'locked',
    replicaReadScope: PAGE_ONLY_REPLICA_READ_SCOPE,
    readScopeSetupVersion: 0,
    settingsRevision: 0,
    resetRevision: 0,
    resetCleanupPendingRevision: 0,
    imageTranslationEnabled: false,
    ocrMinimumConfidence: DEFAULT_OCR_MINIMUM_CONFIDENCE,
    imageReadingMethodOrder: Object.freeze([
      ...IMAGE_READING_METHOD_IDS,
    ]) as unknown as ImageReadingMethodId[],
    disabledImageReadingMethodIds: Object.freeze([
      ACCESSIBILITY_TEXT_METHOD_ID,
    ]) as unknown as ImageReadingMethodId[],
    imageTextProviderOrder: Object.freeze([
      ...IMAGE_TEXT_PROVIDER_IDS,
    ]) as unknown as ImageTextProviderId[],
    disabledImageTextProviderIds: Object.freeze(
      [],
    ) as unknown as ImageTextProviderId[],
    imageScanPolicy: 'visible-first-background-prescan',
    skipSmallImages: true,
    usePromptForImageLanguage: false,
    usePromptForImageText: false,
  });

const MAX_SAVED_ORIGINS = 256;
const MAX_GRANTED_PERMISSION_ORIGINS = 512;

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

  let imageTextProviderOrder = repairImageTextProviderOrder(
    input.imageTextProviderOrder,
  );
  const imageReadingMethodOrder = repairImageReadingMethodOrder(
    input.imageReadingMethodOrder,
    imageTextProviderOrder,
  );
  if (Array.isArray(input.imageReadingMethodOrder)) {
    imageTextProviderOrder = imageReadingMethodOrder.filter(
      isOcrImageReadingMethod,
    );
  }
  const setupVersion = parseNonNegativeRevision(input.readScopeSetupVersion);
  const legacyDisabledImageTextProviderIds =
    repairDisabledImageTextProviderIds(input.disabledImageTextProviderIds);
  let disabledImageReadingMethodIds =
    input.disabledImageReadingMethodIds === undefined
      ? [
          ...(setupVersion === REPLICA_READ_SCOPE_SETUP_VERSION
            ? []
            : [ACCESSIBILITY_TEXT_METHOD_ID]),
          ...legacyDisabledImageTextProviderIds,
        ]
      : repairDisabledImageReadingMethodIds(
          input.disabledImageReadingMethodIds,
        );
  if (
    setupVersion !== REPLICA_READ_SCOPE_SETUP_VERSION &&
    !disabledImageReadingMethodIds.includes(ACCESSIBILITY_TEXT_METHOD_ID)
  ) {
    disabledImageReadingMethodIds = [
      ACCESSIBILITY_TEXT_METHOD_ID,
      ...disabledImageReadingMethodIds,
    ];
  }
  const disabledImageTextProviderIds =
    imageTextProviderOrder.filter((id) =>
      disabledImageReadingMethodIds.includes(id),
    );

  return {
    autoTranslateAllSites: input.autoTranslateAllSites === true,
    autoTranslateOrigins,
    grantedPermissionOrigins: parseGrantedPermissionOrigins(
      input.grantedPermissionOrigins,
    ),
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
    replicaFidelityPolicy: isSelectableReplicaFidelityPolicy(
      input.replicaFidelityPolicy,
    )
      ? input.replicaFidelityPolicy
      : DEFAULT_COMPANION_PREFERENCES.replicaFidelityPolicy,
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
    replicaReadScope: repairReplicaReadScope(input.replicaReadScope),
    readScopeSetupVersion: setupVersion,
    settingsRevision: parseNonNegativeRevision(input.settingsRevision),
    resetRevision: parseNonNegativeRevision(input.resetRevision),
    resetCleanupPendingRevision: parseNonNegativeRevision(
      input.resetCleanupPendingRevision,
    ),
    imageTranslationEnabled:
      typeof input.imageTranslationEnabled === 'boolean'
        ? input.imageTranslationEnabled
        : DEFAULT_COMPANION_PREFERENCES.imageTranslationEnabled,
    ocrMinimumConfidence: repairOcrMinimumConfidence(
      input.ocrMinimumConfidence,
    ),
    imageReadingMethodOrder,
    disabledImageReadingMethodIds,
    imageTextProviderOrder,
    disabledImageTextProviderIds,
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
  replicaFidelityPolicy: SelectableReplicaFidelityPolicy;
  replicaViewMode: ReplicaViewMode;
  launchBehavior: CompanionLaunchBehavior;
  lastLaunchSurface: CompanionSurface;
  popoutTabMode: PopoutTabMode;
}

export type CompanionViewSettingsPatch = Partial<CompanionViewSettings>;

export interface CompanionReadSettings {
  replicaReadScope: ReplicaReadScope;
  readScopeSetupVersion: number;
}

export type CompanionReadSettingsPatch = Partial<CompanionReadSettings>;

export interface CompanionImageAnalysisSettings {
  imageTranslationEnabled: boolean;
  ocrMinimumConfidence: OcrMinimumConfidence;
  imageReadingMethodOrder: ImageReadingMethodId[];
  disabledImageReadingMethodIds: ImageReadingMethodId[];
  imageTextProviderOrder: ImageTextProviderId[];
  disabledImageTextProviderIds: ImageTextProviderId[];
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
  const current = parseCompanionPreferences(preferences);
  const merged: Record<string, unknown> = { ...current, ...settings };
  if (
    settings.imageTextProviderOrder &&
    settings.imageReadingMethodOrder === undefined
  ) {
    const semanticIndex = current.imageReadingMethodOrder.indexOf(
      ACCESSIBILITY_TEXT_METHOD_ID,
    );
    const next: ImageReadingMethodId[] = [...settings.imageTextProviderOrder];
    next.splice(
      Math.max(0, semanticIndex),
      0,
      ACCESSIBILITY_TEXT_METHOD_ID,
    );
    merged.imageReadingMethodOrder = next;
  }
  if (
    settings.disabledImageTextProviderIds &&
    settings.disabledImageReadingMethodIds === undefined
  ) {
    merged.disabledImageReadingMethodIds = [
      ...(current.disabledImageReadingMethodIds.includes(
        ACCESSIBILITY_TEXT_METHOD_ID,
      ) ? [ACCESSIBILITY_TEXT_METHOD_ID] : []),
      ...settings.disabledImageTextProviderIds,
    ];
  }
  return parseCompanionPreferences(merged);
}

export function withReadSettings(
  preferences: CompanionPreferences,
  settings: CompanionReadSettingsPatch,
): CompanionPreferences {
  return parseCompanionPreferences({
    ...parseCompanionPreferences(preferences),
    ...settings,
  });
}

/** Canonical safe state committed before reset cleanup begins. */
export function resetCompanionPreferences(
  preferences: CompanionPreferences,
): CompanionPreferences {
  const current = parseCompanionPreferences(preferences);
  const resetRevision = nextRevision(current.resetRevision);
  return {
    ...createDefaultPreferences(),
    settingsRevision: nextRevision(current.settingsRevision),
    resetRevision,
    resetCleanupPendingRevision: resetRevision,
  };
}

/** Advance the persisted snapshot revision exactly once before a durable save. */
export function advanceCompanionSettingsRevision(
  preferences: CompanionPreferences,
): CompanionPreferences {
  const current = parseCompanionPreferences(preferences);
  return {
    ...current,
    settingsRevision: nextRevision(current.settingsRevision),
  };
}

/**
 * Select the newest committed snapshot. Reset generations take precedence so
 * even a legacy reset snapshot without a settings revision stays fail-closed.
 */
export function selectLatestCompanionPreferences(
  current: CompanionPreferences,
  candidate: CompanionPreferences,
): CompanionPreferences {
  const existing = parseCompanionPreferences(current);
  const next = parseCompanionPreferences(candidate);
  if (next.resetRevision !== existing.resetRevision) {
    return next.resetRevision > existing.resetRevision ? next : existing;
  }
  return next.settingsRevision >= existing.settingsRevision ? next : existing;
}

export type LiveCompanionPreferenceChangeStatus =
  | 'accepted'
  | 'invalid'
  | 'stale';

export interface LiveCompanionPreferenceChange {
  readonly preferences: CompanionPreferences;
  readonly failClosed: boolean;
  readonly status: LiveCompanionPreferenceChangeStatus;
}

/**
 * Accept only the complete canonical snapshot written by the coordinator.
 * The ordinary parser intentionally repairs legacy/startup data; a live
 * storage mutation is a different trust boundary because repairing a partial
 * object could preserve or synthesize a broader scope without a valid commit.
 */
export function readValidStoredCompanionPreferences(
  value: unknown,
): CompanionPreferences | undefined {
  const parsed = parseCompanionPreferences(value);
  return matchesCanonicalStoredValue(value, parsed) ? parsed : undefined;
}

/**
 * Resolve one live storage mutation without letting an invalidation epoch be
 * cleared by a delayed older snapshot. Equal revisions may recover only when
 * the exact last accepted snapshot is restored; revision equivocation fails
 * closed as malformed state.
 */
export function selectLiveCompanionPreferenceChange(
  current: CompanionPreferences,
  failClosed: boolean,
  value: unknown,
): LiveCompanionPreferenceChange {
  const existing = parseCompanionPreferences(current);
  const candidate = readValidStoredCompanionPreferences(value);
  if (!candidate) {
    return { preferences: existing, failClosed: true, status: 'invalid' };
  }

  if (
    candidate.resetRevision < existing.resetRevision ||
    (
      candidate.resetRevision === existing.resetRevision &&
      candidate.settingsRevision < existing.settingsRevision
    )
  ) {
    return { preferences: existing, failClosed, status: 'stale' };
  }

  if (
    candidate.resetRevision === existing.resetRevision &&
    candidate.settingsRevision === existing.settingsRevision &&
    !matchesCanonicalStoredValue(candidate, existing)
  ) {
    return { preferences: existing, failClosed: true, status: 'invalid' };
  }

  return {
    preferences: selectLatestCompanionPreferences(existing, candidate),
    failClosed: false,
    status: 'accepted',
  };
}

export function clampZoomPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPANION_PREFERENCES.zoomPercent;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, Math.round(value)));
}

function createDefaultPreferences(): CompanionPreferences {
  return {
    autoTranslateAllSites: false,
    autoTranslateOrigins: [],
    grantedPermissionOrigins: [],
    displayMode: 'fit',
    sourceLanguage: 'auto',
    targetLanguage: 'en',
    zoomPercent: 100,
    syncScroll: true,
    textLayoutMode: 'adaptive',
    replicaFidelityPolicy: 'passive',
    replicaViewMode: 'translated',
    launchBehavior: 'last-used',
    lastLaunchSurface: 'side-panel',
    popoutTabMode: 'locked',
    replicaReadScope: { ...PAGE_ONLY_REPLICA_READ_SCOPE },
    readScopeSetupVersion: 0,
    settingsRevision: 0,
    resetRevision: 0,
    resetCleanupPendingRevision: 0,
    imageTranslationEnabled: false,
    ocrMinimumConfidence: DEFAULT_OCR_MINIMUM_CONFIDENCE,
    imageReadingMethodOrder: [...IMAGE_READING_METHOD_IDS],
    disabledImageReadingMethodIds: [ACCESSIBILITY_TEXT_METHOD_ID],
    imageTextProviderOrder: [...IMAGE_TEXT_PROVIDER_IDS],
    disabledImageTextProviderIds: [],
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

function parseNonNegativeRevision(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : 0;
}

function matchesCanonicalStoredValue(
  value: unknown,
  canonical: unknown,
): boolean {
  if (Array.isArray(canonical)) {
    return Array.isArray(value) &&
      value.length === canonical.length &&
      canonical.every((entry, index) =>
        matchesCanonicalStoredValue(value[index], entry),
      );
  }
  if (isRecord(canonical)) {
    if (!isRecord(value)) return false;
    const canonicalKeys = Object.keys(canonical);
    const valueKeys = Object.keys(value);
    return valueKeys.length === canonicalKeys.length &&
      canonicalKeys.every((key) =>
        Object.prototype.hasOwnProperty.call(value, key) &&
        matchesCanonicalStoredValue(value[key], canonical[key]),
      );
  }
  return Object.is(value, canonical);
}

function nextRevision(value: number): number {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Preference revision exhausted.');
  }
  return value + 1;
}

/**
 * A host permission pattern Simul manages: the canonical or legacy all-sites
 * patterns, or the exact-site pattern Simul requests for one origin.
 */
export function isManagedPermissionOriginPattern(value: string): boolean {
  if (
    (ALL_SITES_PERMISSION_ORIGINS as readonly string[]).includes(value) ||
    (LEGACY_ALL_SITES_PERMISSION_ORIGINS as readonly string[]).includes(value)
  ) {
    return true;
  }
  if (!value.endsWith('/*')) return false;
  return permissionOriginsForMode('site', value.slice(0, -1))[0] === value;
}

function parseGrantedPermissionOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      seen.has(entry) ||
      !isManagedPermissionOriginPattern(entry)
    ) continue;
    seen.add(entry);
    origins.push(entry);
    if (origins.length >= MAX_GRANTED_PERMISSION_ORIGINS) break;
  }
  return origins;
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
