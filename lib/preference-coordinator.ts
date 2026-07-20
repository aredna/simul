import {
  ALL_SITES_PERMISSION_ORIGINS,
  STORAGE_KEY,
  autoTranslationModeForPage,
  isAutoTranslationMode,
  isMirrorDisplayMode,
  isTextLayoutMode,
  parseCompanionPreferences,
  permissionOriginsForMode,
  withAutoTranslationMode,
  withDisplayMode,
  withImageAnalysisSettings,
  withViewSettings,
  type AutoTranslationMode,
  type CompanionPreferences,
  type CompanionImageAnalysisSettingsPatch,
  type CompanionViewSettingsPatch,
  type MirrorDisplayMode,
} from './preferences';
import { isImageScanPolicy } from './ocr/contracts';
import { readExactImageTextProviderOrder } from './ocr/known-provider-ids';
import { isSupportedLanguage } from './translation-provider';

export const PREFERENCE_LOCK_NAME = 'simul:companion-preferences';

export type PreferenceCommand =
  | {
      type: 'simul:preferences:set-display';
      displayMode: MirrorDisplayMode;
    }
  | {
      type: 'simul:preferences:patch-view';
      patch: CompanionViewSettingsPatch;
    }
  | {
      type: 'simul:preferences:patch-image-analysis';
      patch: CompanionImageAnalysisSettingsPatch;
    }
  | {
      type: 'simul:preferences:commit-auto';
      mode: AutoTranslationMode;
      pageUrl?: string;
    }
  | {
      type: 'simul:preferences:reconcile';
    }
  | {
      type: 'simul:preferences:abort-auto';
      mode: AutoTranslationMode;
      pageUrl?: string;
    };

export interface PreferenceCommandResult {
  type: 'simul:preferences:result';
  preferences: CompanionPreferences;
  applied: boolean;
}

export interface PreferenceCoordinatorAdapter {
  load(): Promise<unknown>;
  save(preferences: CompanionPreferences): Promise<void>;
  contains(origins: string[]): Promise<boolean>;
  getAllOrigins(): Promise<string[]>;
  remove(origins: string[]): Promise<boolean>;
}

/**
 * Serialize preference changes in the extension service worker. Side panels
 * can exist in several Chrome windows, so a renderer-local flag cannot prevent
 * stale read/modify/write cycles across those contexts.
 */
export class PreferenceCoordinator {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: PreferenceCoordinatorAdapter) {}

  run(command: PreferenceCommand): Promise<PreferenceCommandResult> {
    return this.enqueue(() => this.apply(command));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async apply(
    command: PreferenceCommand,
  ): Promise<PreferenceCommandResult> {
    const current = parseCompanionPreferences(await this.adapter.load());

    if (command.type === 'simul:preferences:set-display') {
      const preferences = withDisplayMode(current, command.displayMode);
      await this.adapter.save(preferences);
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:patch-view') {
      const preferences = withViewSettings(current, command.patch);
      await this.adapter.save(preferences);
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:patch-image-analysis') {
      const preferences = withImageAnalysisSettings(current, command.patch);
      await this.adapter.save(preferences);
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:reconcile') {
      const preferences = await this.reconcile(current);
      if (!samePreferences(current, preferences)) {
        await this.adapter.save(preferences);
      }
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:abort-auto') {
      const preferences = await this.reconcile(current);
      const retained = new Set(retainedPermissionOrigins(preferences));
      const cleanup = permissionOriginsForMode(
        command.mode,
        command.pageUrl,
      ).filter((origin) => !retained.has(origin));
      await this.removeIfPresent(cleanup);
      if (!samePreferences(current, preferences)) {
        await this.adapter.save(preferences);
      }
      return result(preferences, false);
    }

    const candidate = withAutoTranslationMode(
      current,
      command.pageUrl,
      command.mode,
    );
    const requestedModeWasRepresented =
      command.mode === 'off' ||
      autoTranslationModeForPage(candidate, command.pageUrl) === command.mode;

    // A global grant makes every exact-site contains() check return true. Drop
    // it before validating narrower choices so saved site scopes always have
    // their own grant and cannot become orphaned when All sites is disabled.
    if (command.mode !== 'all') {
      await this.removeIfPresent([...ALL_SITES_PERMISSION_ORIGINS]);
    }

    const preferences = await this.reconcile(candidate);
    const applied =
      requestedModeWasRepresented &&
      autoTranslationModeForPage(preferences, command.pageUrl) === command.mode;

    await this.removeNoLongerNeededPermissions(current, preferences);
    if (!applied) {
      const retained = new Set(retainedPermissionOrigins(preferences));
      const unusedRequest = permissionOriginsForMode(
        command.mode,
        command.pageUrl,
      ).filter((origin) => !retained.has(origin));
      await this.removeIfPresent(unusedRequest);
    }
    await this.adapter.save(preferences);
    return result(preferences, applied);
  }

  private async reconcile(
    candidate: CompanionPreferences,
  ): Promise<CompanionPreferences> {
    let preferences = parseCompanionPreferences(candidate);

    if (preferences.autoTranslateAllSites) {
      const hasGlobalGrant = await this.adapter.contains([
        ...ALL_SITES_PERMISSION_ORIGINS,
      ]);
      if (hasGlobalGrant) {
        await this.removeOrphanPermissions(preferences);
        return preferences;
      }
      preferences = { ...preferences, autoTranslateAllSites: false };
    }
    // contains([http, https]) is false when only one wildcard remains, so
    // remove both patterns unconditionally after global mode becomes invalid.
    await this.removeIfPresent([...ALL_SITES_PERMISSION_ORIGINS]);

    const grants = await Promise.all(
      preferences.autoTranslateOrigins.map(async (origin) => {
        const origins = permissionOriginsForMode('site', origin);
        return origins.length > 0 && this.adapter.contains(origins);
      }),
    );
    const reconciled = {
      ...preferences,
      autoTranslateOrigins: preferences.autoTranslateOrigins.filter(
        (_origin, index) => grants[index] === true,
      ),
    };
    await this.removeOrphanPermissions(reconciled);
    return reconciled;
  }

  private async removeOrphanPermissions(
    preferences: CompanionPreferences,
  ): Promise<void> {
    const retained = new Set(retainedPermissionOrigins(preferences));
    const actual = await this.adapter.getAllOrigins();
    const orphaned = actual.filter(
      (origin) => isManagedPermissionOrigin(origin) && !retained.has(origin),
    );
    await this.removeIfPresent(orphaned);
  }

  private async removeNoLongerNeededPermissions(
    before: CompanionPreferences,
    after: CompanionPreferences,
  ): Promise<void> {
    const retained = new Set(retainedPermissionOrigins(after));
    const obsolete = retainedPermissionOrigins(before).filter(
      (origin) => !retained.has(origin),
    );
    await this.removeIfPresent(obsolete);
  }

  private async removeIfPresent(origins: string[]): Promise<void> {
    if (origins.length === 0) return;
    await this.adapter.remove(origins);
  }
}

export function readPreferenceCommand(
  value: unknown,
): PreferenceCommand | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;

  if (
    value.type === 'simul:preferences:set-display' &&
    isMirrorDisplayMode(value.displayMode)
  ) {
    return { type: value.type, displayMode: value.displayMode };
  }
  if (value.type === 'simul:preferences:patch-view') {
    const patch = readViewSettingsPatch(value.patch);
    if (patch) return { type: value.type, patch };
  }
  if (value.type === 'simul:preferences:patch-image-analysis') {
    if (
      Object.keys(value).length !== 2 ||
      !('patch' in value)
    ) return undefined;
    const patch = readImageAnalysisSettingsPatch(value.patch);
    if (patch) return { type: value.type, patch };
  }
  if (
    value.type === 'simul:preferences:commit-auto' &&
    isAutoTranslationMode(value.mode) &&
    (value.pageUrl === undefined || typeof value.pageUrl === 'string')
  ) {
    return {
      type: value.type,
      mode: value.mode,
      ...(typeof value.pageUrl === 'string' ? { pageUrl: value.pageUrl } : {}),
    };
  }
  if (value.type === 'simul:preferences:reconcile') {
    return { type: value.type };
  }
  if (
    value.type === 'simul:preferences:abort-auto' &&
    isAutoTranslationMode(value.mode) &&
    (value.pageUrl === undefined || typeof value.pageUrl === 'string')
  ) {
    return {
      type: value.type,
      mode: value.mode,
      ...(typeof value.pageUrl === 'string' ? { pageUrl: value.pageUrl } : {}),
    };
  }
  return undefined;
}

export function readPreferenceCommandResult(
  value: unknown,
): PreferenceCommandResult | undefined {
  if (
    !isRecord(value) ||
    value.type !== 'simul:preferences:result' ||
    typeof value.applied !== 'boolean'
  ) {
    return undefined;
  }
  return {
    type: value.type,
    preferences: parseCompanionPreferences(value.preferences),
    applied: value.applied,
  };
}

export function createBrowserPreferenceAdapter(): PreferenceCoordinatorAdapter {
  return {
    async load() {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      return stored[STORAGE_KEY];
    },
    async save(preferences) {
      await browser.storage.local.set({ [STORAGE_KEY]: preferences });
    },
    async contains(origins) {
      return browser.permissions.contains({ origins });
    },
    async getAllOrigins() {
      const permissions = await browser.permissions.getAll();
      return permissions.origins ?? [];
    },
    async remove(origins) {
      return browser.permissions.remove({ origins });
    },
  };
}

function result(
  preferences: CompanionPreferences,
  applied: boolean,
): PreferenceCommandResult {
  return {
    type: 'simul:preferences:result',
    preferences,
    applied,
  };
}

function samePreferences(
  left: CompanionPreferences,
  right: CompanionPreferences,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function retainedPermissionOrigins(
  preferences: CompanionPreferences,
): string[] {
  const siteOrigins = preferences.autoTranslateOrigins.flatMap((origin) =>
    permissionOriginsForMode('site', origin),
  );
  return preferences.autoTranslateAllSites
    ? [...ALL_SITES_PERMISSION_ORIGINS, ...siteOrigins]
    : siteOrigins;
}

function isManagedPermissionOrigin(value: string): boolean {
  if ((ALL_SITES_PERMISSION_ORIGINS as readonly string[]).includes(value)) {
    return true;
  }
  if (!value.endsWith('/*')) return false;
  return permissionOriginsForMode('site', value.slice(0, -1))[0] === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const VIEW_SETTING_KEYS = new Set([
  'sourceLanguage',
  'targetLanguage',
  'displayMode',
  'zoomPercent',
  'syncScroll',
  'textLayoutMode',
]);

function readViewSettingsPatch(
  value: unknown,
): CompanionViewSettingsPatch | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(([key]) => !VIEW_SETTING_KEYS.has(key))
  ) return undefined;

  const patch: CompanionViewSettingsPatch = {};
  if ('sourceLanguage' in value) {
    if (
      value.sourceLanguage !== 'auto' &&
      !isSupportedLanguage(value.sourceLanguage)
    ) return undefined;
    patch.sourceLanguage = value.sourceLanguage;
  }
  if ('targetLanguage' in value) {
    if (!isSupportedLanguage(value.targetLanguage)) return undefined;
    patch.targetLanguage = value.targetLanguage;
  }
  if ('displayMode' in value) {
    if (!isMirrorDisplayMode(value.displayMode)) return undefined;
    patch.displayMode = value.displayMode;
  }
  if ('zoomPercent' in value) {
    if (
      typeof value.zoomPercent !== 'number' ||
      !Number.isFinite(value.zoomPercent)
    ) return undefined;
    patch.zoomPercent = value.zoomPercent;
  }
  if ('syncScroll' in value) {
    if (typeof value.syncScroll !== 'boolean') return undefined;
    patch.syncScroll = value.syncScroll;
  }
  if ('textLayoutMode' in value) {
    if (!isTextLayoutMode(value.textLayoutMode)) return undefined;
    patch.textLayoutMode = value.textLayoutMode;
  }
  return patch;
}

const IMAGE_ANALYSIS_SETTING_KEYS = new Set([
  'imageTranslationEnabled',
  'imageTextProviderOrder',
  'imageScanPolicy',
  'skipSmallImages',
  'usePromptForImageLanguage',
  'usePromptForImageText',
]);

function readImageAnalysisSettingsPatch(
  value: unknown,
): CompanionImageAnalysisSettingsPatch | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.some(([key]) => !IMAGE_ANALYSIS_SETTING_KEYS.has(key))
  ) return undefined;

  const patch: CompanionImageAnalysisSettingsPatch = {};
  if ('imageTranslationEnabled' in value) {
    if (typeof value.imageTranslationEnabled !== 'boolean') return undefined;
    patch.imageTranslationEnabled = value.imageTranslationEnabled;
  }
  if ('imageTextProviderOrder' in value) {
    const order = readExactImageTextProviderOrder(
      value.imageTextProviderOrder,
    );
    if (!order) return undefined;
    patch.imageTextProviderOrder = order;
  }
  if ('imageScanPolicy' in value) {
    if (!isImageScanPolicy(value.imageScanPolicy)) return undefined;
    patch.imageScanPolicy = value.imageScanPolicy;
  }
  for (const key of [
    'skipSmallImages',
    'usePromptForImageLanguage',
    'usePromptForImageText',
  ] as const) {
    if (key in value) {
      if (typeof value[key] !== 'boolean') return undefined;
      patch[key] = value[key];
    }
  }
  return patch;
}
