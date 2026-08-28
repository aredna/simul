import {
  ALL_SITES_PERMISSION_ORIGINS,
  LEGACY_ALL_SITES_PERMISSION_ORIGINS,
  STORAGE_KEY,
  advanceCompanionSettingsRevision,
  autoTranslationModeForPage,
  isAutoTranslationMode,
  isCompanionLaunchBehavior,
  isCompanionSurface,
  isMirrorDisplayMode,
  isPopoutTabMode,
  isReplicaViewMode,
  isTextLayoutMode,
  parseCompanionPreferences,
  permissionOriginsForMode,
  resetCompanionPreferences,
  withAutoTranslationMode,
  withDisplayMode,
  withImageAnalysisSettings,
  withReadSettings,
  withViewSettings,
  type AutoTranslationMode,
  type CompanionPreferences,
  type CompanionImageAnalysisSettingsPatch,
  type CompanionReadSettingsPatch,
  type CompanionViewSettingsPatch,
  type MirrorDisplayMode,
} from './preferences';
import { isImageScanPolicy } from './ocr/contracts';
import {
  readExactDisabledImageTextProviderIds,
  readExactImageTextProviderOrder,
} from './ocr/known-provider-ids';
import { isOcrMinimumConfidence } from './ocr/result-quality';
import { isSelectableReplicaFidelityPolicy } from './replica/fidelity-policy';
import { isSupportedLanguage } from './translation-provider';
import {
  REPLICA_READ_SCOPE_SETUP_VERSION,
  effectiveReplicaReadScope,
  readExactReplicaReadScope,
  replicaReadScopeFingerprint,
} from './replica/read-scope-policy';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  readExactDisabledImageReadingMethodIds,
  readExactImageReadingMethodOrder,
} from './ocr/image-reading-methods';

export const PREFERENCE_LOCK_NAME = 'simul:companion-preferences';

export type PreferenceCommand =
  | {
      type: 'simul:preferences:set-display';
      expectedResetRevision: number;
      displayMode: MirrorDisplayMode;
    }
  | {
      type: 'simul:preferences:patch-view';
      expectedResetRevision: number;
      patch: CompanionViewSettingsPatch;
    }
  | {
      type: 'simul:preferences:patch-image-analysis';
      expectedResetRevision: number;
      expectedSettingsRevision?: number;
      patch: CompanionImageAnalysisSettingsPatch;
    }
  | {
      type: 'simul:preferences:patch-read-scope';
      expectedResetRevision: number;
      expectedReadScopeFingerprint: string;
      patch: CompanionReadSettingsPatch;
    }
  | {
      type: 'simul:preferences:complete-read-scope-setup';
      expectedResetRevision: number;
      expectedSetupVersion: number;
      expectedReadScopeFingerprint: string;
      patch: CompanionReadSettingsPatch;
    }
  | {
      type: 'simul:preferences:reset-all';
      expectedResetRevision: number;
    }
  | {
      type: 'simul:preferences:retry-reset-cleanup';
      expectedResetRevision: number;
    }
  | {
      type: 'simul:preferences:commit-auto';
      expectedResetRevision: number;
      expectedSettingsRevision?: number;
      mode: AutoTranslationMode;
      pageUrl?: string;
    }
  | {
      type: 'simul:preferences:reconcile';
    }
  | {
      type: 'simul:preferences:abort-auto';
      expectedResetRevision: number;
      expectedSettingsRevision?: number;
      mode: AutoTranslationMode;
      pageUrl?: string;
    };

export interface PreferenceCommandResult {
  type: 'simul:preferences:result';
  preferences: CompanionPreferences;
  applied: boolean;
  code?:
    | 'stale-reset-revision'
    | 'stale-settings-revision'
    | 'stale-setup-version'
    | 'stale-read-scope'
    | 'safety-ack-failed'
    | 'cleanup-pending';
  cleanup?: {
    readonly status: 'complete' | 'pending';
    readonly remainingManagedOrigins: number;
  };
}

export interface PreferenceCoordinatorAdapter {
  load(): Promise<unknown>;
  save(preferences: CompanionPreferences): Promise<void>;
  contains(origins: string[]): Promise<boolean>;
  getAllOrigins(): Promise<string[]>;
  remove(origins: string[]): Promise<boolean>;
}

/** Runtime state that must be cleared before a durable reset is complete. */
export interface PreferenceResetRuntimeAdapter {
  clearTransientStore(): Promise<void>;
  closeOffscreenDocument(): Promise<void>;
}

const NOOP_RESET_RUNTIME_ADAPTER: PreferenceResetRuntimeAdapter = {
  clearTransientStore: async () => undefined,
  closeOffscreenDocument: async () => undefined,
};

/**
 * Serialize preference changes in the extension service worker. Side panels
 * can exist in several Chrome windows, so a renderer-local flag cannot prevent
 * stale read/modify/write cycles across those contexts.
 */
export class PreferenceCoordinator {
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: PreferenceCoordinatorAdapter,
    private readonly resetRuntime: PreferenceResetRuntimeAdapter =
      NOOP_RESET_RUNTIME_ADAPTER,
  ) {}

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
    const stored = await this.adapter.load();
    const current = parseCompanionPreferences(stored);
    const repairStoredOcrMinimumConfidence =
      !isRecord(stored) ||
      !isOcrMinimumConfidence(stored.ocrMinimumConfidence);
    const repairStoredImageTextProviderOrder =
      !isRecord(stored) ||
      !readExactImageTextProviderOrder(stored.imageTextProviderOrder);
    const repairStoredDisabledImageTextProviders =
      !isRecord(stored) ||
      !readExactDisabledImageTextProviderIds(
        stored.disabledImageTextProviderIds,
      );
    const repairStoredImageReadingMethodOrder =
      !isRecord(stored) ||
      !readExactImageReadingMethodOrder(stored.imageReadingMethodOrder);
    const repairStoredDisabledImageReadingMethods =
      !isRecord(stored) ||
      !readExactDisabledImageReadingMethodIds(
        stored.disabledImageReadingMethodIds,
      );
    const repairStoredSettingsRevision =
      !isRecord(stored) ||
      !isNonNegativeSafeInteger(stored.settingsRevision);
    const repairStoredReplicaEngine =
      isRecord(stored) && Object.hasOwn(stored, 'replicaEngine');
    const repairStoredImageAnalysis =
      repairStoredOcrMinimumConfidence ||
      repairStoredImageTextProviderOrder ||
      repairStoredDisabledImageTextProviders ||
      repairStoredImageReadingMethodOrder ||
      repairStoredDisabledImageReadingMethods;

    if (
      'expectedResetRevision' in command &&
      command.expectedResetRevision !== current.resetRevision
    ) {
      return result(current, false, 'stale-reset-revision');
    }
    if (
      'expectedSettingsRevision' in command &&
      command.expectedSettingsRevision !== undefined &&
      command.expectedSettingsRevision !== current.settingsRevision
    ) {
      return result(current, false, 'stale-settings-revision');
    }

    if (command.type === 'simul:preferences:patch-read-scope') {
      if (!hasExpectedReadScope(current, command.expectedReadScopeFingerprint)) {
        return result(current, false, 'stale-read-scope');
      }
      const preferences = await this.saveNext(
        withReadSettings(current, command.patch),
      );
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:complete-read-scope-setup') {
      if (
        command.expectedSetupVersion !== current.readScopeSetupVersion ||
        current.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION
      ) {
        return result(current, false, 'stale-setup-version');
      }
      if (!hasExpectedReadScope(current, command.expectedReadScopeFingerprint)) {
        return result(current, false, 'stale-read-scope');
      }
      const preferences = withReadSettings(current, {
        ...command.patch,
        readScopeSetupVersion: REPLICA_READ_SCOPE_SETUP_VERSION,
      });
      const withSemanticDefault = withImageAnalysisSettings(preferences, {
        disabledImageReadingMethodIds:
          preferences.disabledImageReadingMethodIds.filter(
            (id) => id !== ACCESSIBILITY_TEXT_METHOD_ID,
          ),
      });
      const committed = await this.saveNext(withSemanticDefault);
      return result(committed, true);
    }

    if (command.type === 'simul:preferences:reset-all') {
      const safe = resetCompanionPreferences(current);
      await this.adapter.save(safe);
      return this.finishResetCleanup(safe);
    }

    if (command.type === 'simul:preferences:retry-reset-cleanup') {
      if (current.resetCleanupPendingRevision === 0) {
        return result(current, true, undefined, {
          status: 'complete',
          remainingManagedOrigins: 0,
        });
      }
      return this.finishResetCleanup(current);
    }

    if (command.type === 'simul:preferences:set-display') {
      const preferences = await this.saveNext(
        withDisplayMode(current, command.displayMode),
      );
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:patch-view') {
      const preferences = await this.saveNext(
        withViewSettings(current, command.patch),
      );
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:patch-image-analysis') {
      const preferences = withImageAnalysisSettings(current, command.patch);
      if (
        current.imageTranslationEnabled &&
        !preferences.imageTranslationEnabled
      ) {
        await this.removeNoLongerNeededPermissions(current, preferences);
        const reconciled = await this.reconcile(preferences);
        const committed = await this.saveNext(reconciled);
        return result(committed, true);
      }
      const committed = await this.saveNext(preferences);
      return result(committed, true);
    }

    if (command.type === 'simul:preferences:reconcile') {
      if (current.resetCleanupPendingRevision > 0) {
        return this.finishResetCleanup(current);
      }
      let preferences = await this.reconcile(current);
      if (
        repairStoredImageAnalysis ||
        repairStoredSettingsRevision ||
        repairStoredReplicaEngine ||
        !samePreferences(current, preferences)
      ) {
        preferences = await this.saveNext(preferences);
      }
      return result(preferences, true);
    }

    if (command.type === 'simul:preferences:abort-auto') {
      let preferences = await this.reconcile(current);
      const retained = new Set(retainedPermissionOrigins(preferences));
      const cleanup = permissionOriginsForMode(
        command.mode,
        command.pageUrl,
      ).filter((origin) => !retained.has(origin));
      await this.removeIfPresent(cleanup);
      if (
        repairStoredImageAnalysis ||
        repairStoredSettingsRevision ||
        repairStoredReplicaEngine ||
        !samePreferences(current, preferences)
      ) {
        preferences = await this.saveNext(preferences);
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
    if (command.mode !== 'all' && !current.imageTranslationEnabled) {
      await this.removeIfPresent(allBroadPermissionOrigins());
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
    const committed = await this.saveNext(preferences);
    return result(committed, applied);
  }

  private async finishResetCleanup(
    preferences: CompanionPreferences,
  ): Promise<PreferenceCommandResult> {
    const pendingRevision = preferences.resetCleanupPendingRevision;
    const latest = parseCompanionPreferences(await this.adapter.load());
    if (latest.resetCleanupPendingRevision !== pendingRevision) {
      return latest.resetCleanupPendingRevision === 0
        ? result(latest, true, undefined, {
            status: 'complete',
            remainingManagedOrigins: 0,
          })
        : this.pendingResetResult(latest);
    }

    const cleanup = await Promise.allSettled([
      this.removeResetManagedPermissions(latest),
      this.resetRuntime.clearTransientStore(),
      this.resetRuntime.closeOffscreenDocument(),
    ]);
    const permissionCleanup = cleanup[0];
    const remaining = permissionCleanup.status === 'fulfilled'
      ? permissionCleanup.value
      : await this.countUndesiredManagedOriginsBestEffort(latest);
    if (
      cleanup.some((outcome) => outcome.status === 'rejected') ||
      remaining > 0
    ) {
      return result(latest, false, 'cleanup-pending', {
        status: 'pending',
        remainingManagedOrigins: remaining,
      });
    }

    const current = parseCompanionPreferences(await this.adapter.load());
    if (current.resetCleanupPendingRevision !== pendingRevision) {
      return current.resetCleanupPendingRevision === 0
        ? result(current, true, undefined, {
            status: 'complete',
            remainingManagedOrigins: 0,
          })
        : this.pendingResetResult(current);
    }
    const completed = advanceCompanionSettingsRevision({
      ...current,
      resetCleanupPendingRevision: 0,
    });
    await this.adapter.save(completed);
    return result(completed, true, undefined, {
      status: 'complete',
      remainingManagedOrigins: 0,
    });
  }

  private async removeResetManagedPermissions(
    preferences: CompanionPreferences,
  ): Promise<number> {
    const retained = new Set(retainedPermissionOrigins(preferences));
    const actual = await this.adapter.getAllOrigins();
    const removable = actual.filter(
      (origin) => isManagedPermissionOrigin(origin) && !retained.has(origin),
    );
    if (removable.length > 0) await this.adapter.remove(removable);
    return this.countUndesiredManagedOrigins(preferences);
  }

  private async countUndesiredManagedOrigins(
    preferences: CompanionPreferences,
  ): Promise<number> {
    const retained = new Set(retainedPermissionOrigins(preferences));
    return (await this.adapter.getAllOrigins()).filter(
      (origin) => isManagedPermissionOrigin(origin) && !retained.has(origin),
    ).length;
  }

  private async countUndesiredManagedOriginsBestEffort(
    preferences: CompanionPreferences,
  ): Promise<number> {
    return this.countUndesiredManagedOrigins(preferences).catch(() => 0);
  }

  private async pendingResetResult(
    preferences: CompanionPreferences,
  ): Promise<PreferenceCommandResult> {
    return result(preferences, false, 'cleanup-pending', {
      status: 'pending',
      remainingManagedOrigins:
        await this.countUndesiredManagedOriginsBestEffort(preferences),
    });
  }

  private async reconcile(
    candidate: CompanionPreferences,
  ): Promise<CompanionPreferences> {
    let preferences = parseCompanionPreferences(candidate);
    const actualOrigins = new Set(await this.adapter.getAllOrigins());
    const hasCanonicalGlobalGrant = ALL_SITES_PERMISSION_ORIGINS.every(
      (origin) => actualOrigins.has(origin),
    );
    const hasLegacyGlobalGrant = LEGACY_ALL_SITES_PERMISSION_ORIGINS.every(
      (origin) => actualOrigins.has(origin),
    );

    if (preferences.autoTranslateAllSites) {
      if (!hasCanonicalGlobalGrant && !hasLegacyGlobalGrant) {
        preferences = { ...preferences, autoTranslateAllSites: false };
      }
    }

    if (hasCanonicalGlobalGrant && hasLegacyGlobalGrant) {
      await this.removeIfPresent([...LEGACY_ALL_SITES_PERMISSION_ORIGINS]);
    } else if (!preferences.autoTranslateAllSites) {
      await this.removeIfPresent([...LEGACY_ALL_SITES_PERMISSION_ORIGINS]);
    }
    if (
      !preferences.autoTranslateAllSites &&
      !preferences.imageTranslationEnabled
    ) {
      await this.removeIfPresent([...ALL_SITES_PERMISSION_ORIGINS]);
    }

    // A broad grant makes permissions.contains(exactSite) return true even
    // when Chrome did not retain an independent exact-site permission. Keep
    // that dependent intent only while image translation owns the canonical
    // grant; its explicit disable flow materializes exact grants first. Once
    // broad access is revoked, getAll() is the only proof a site grant remains.
    const imageOwnedBroadCoverage =
      preferences.imageTranslationEnabled && hasCanonicalGlobalGrant;
    const grants = preferences.autoTranslateOrigins.map((origin) => {
      const origins = permissionOriginsForMode('site', origin);
      return origins.length > 0 && (
        imageOwnedBroadCoverage ||
        origins.every((value) => actualOrigins.has(value))
      );
    });
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

  private async saveNext(
    candidate: CompanionPreferences,
  ): Promise<CompanionPreferences> {
    const preferences = advanceCompanionSettingsRevision(candidate);
    await this.adapter.save(preferences);
    return preferences;
  }
}

export function readPreferenceCommand(
  value: unknown,
): PreferenceCommand | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;

  if (
    value.type === 'simul:preferences:set-display' &&
    hasExactSafeRevision(value, [
      'type', 'expectedResetRevision', 'displayMode',
    ]) &&
    isMirrorDisplayMode(value.displayMode)
  ) {
    return {
      type: value.type,
      expectedResetRevision: value.expectedResetRevision,
      displayMode: value.displayMode,
    };
  }
  if (value.type === 'simul:preferences:patch-view') {
    if (!hasExactSafeRevision(value, [
      'type', 'expectedResetRevision', 'patch',
    ])) return undefined;
    const patch = readViewSettingsPatch(value.patch);
    if (patch) {
      return {
        type: value.type,
        expectedResetRevision: value.expectedResetRevision,
        patch,
      };
    }
  }
  if (value.type === 'simul:preferences:patch-image-analysis') {
    const keys = value.expectedSettingsRevision === undefined
      ? ['type', 'expectedResetRevision', 'patch']
      : [
          'type',
          'expectedResetRevision',
          'expectedSettingsRevision',
          'patch',
        ];
    if (
      !hasExactSafeRevision(value, keys) ||
      (value.expectedSettingsRevision !== undefined &&
        !isNonNegativeSafeInteger(value.expectedSettingsRevision))
    ) return undefined;
    const patch = readImageAnalysisSettingsPatch(value.patch);
    if (patch) {
      return {
        type: value.type,
        expectedResetRevision: value.expectedResetRevision,
        ...(value.expectedSettingsRevision === undefined
          ? {}
          : { expectedSettingsRevision: value.expectedSettingsRevision }),
        patch,
      };
    }
  }
  if (
    value.type === 'simul:preferences:patch-read-scope' ||
    value.type === 'simul:preferences:complete-read-scope-setup'
  ) {
    if (!hasExactSafeRevision(value, value.type ===
      'simul:preferences:complete-read-scope-setup'
      ? [
          'type',
          'expectedResetRevision',
          'expectedSetupVersion',
          'expectedReadScopeFingerprint',
          'patch',
        ]
      : [
          'type',
          'expectedResetRevision',
          'expectedReadScopeFingerprint',
          'patch',
        ])) return undefined;
    if (typeof value.expectedReadScopeFingerprint !== 'string') {
      return undefined;
    }
    const patch = readReadSettingsPatch(value.patch);
    if (!patch) return undefined;
    if (value.type === 'simul:preferences:complete-read-scope-setup') {
      if (!isNonNegativeSafeInteger(value.expectedSetupVersion)) return undefined;
      return {
        type: value.type,
        expectedResetRevision: value.expectedResetRevision,
        expectedSetupVersion: value.expectedSetupVersion,
        expectedReadScopeFingerprint: value.expectedReadScopeFingerprint,
        patch,
      };
    }
    return {
      type: value.type,
      expectedResetRevision: value.expectedResetRevision,
      expectedReadScopeFingerprint: value.expectedReadScopeFingerprint,
      patch,
    };
  }
  if (
    value.type === 'simul:preferences:reset-all' ||
    value.type === 'simul:preferences:retry-reset-cleanup'
  ) {
    if (!hasExactSafeRevision(value, ['type', 'expectedResetRevision'])) {
      return undefined;
    }
    return {
      type: value.type,
      expectedResetRevision: value.expectedResetRevision,
    };
  }
  if (
    value.type === 'simul:preferences:commit-auto' &&
    hasExactSafeRevision(value, autoCommandKeys(value)) &&
    (value.expectedSettingsRevision === undefined ||
      isNonNegativeSafeInteger(value.expectedSettingsRevision)) &&
    isAutoTranslationMode(value.mode) &&
    (value.pageUrl === undefined || typeof value.pageUrl === 'string')
  ) {
    return {
      type: value.type,
      expectedResetRevision: value.expectedResetRevision,
      ...(value.expectedSettingsRevision === undefined
        ? {}
        : { expectedSettingsRevision: value.expectedSettingsRevision }),
      mode: value.mode,
      ...(typeof value.pageUrl === 'string' ? { pageUrl: value.pageUrl } : {}),
    };
  }
  if (
    value.type === 'simul:preferences:reconcile' &&
    Object.keys(value).length === 1
  ) {
    return { type: value.type };
  }
  if (
    value.type === 'simul:preferences:abort-auto' &&
    hasExactSafeRevision(value, autoCommandKeys(value)) &&
    (value.expectedSettingsRevision === undefined ||
      isNonNegativeSafeInteger(value.expectedSettingsRevision)) &&
    isAutoTranslationMode(value.mode) &&
    (value.pageUrl === undefined || typeof value.pageUrl === 'string')
  ) {
    return {
      type: value.type,
      expectedResetRevision: value.expectedResetRevision,
      ...(value.expectedSettingsRevision === undefined
        ? {}
        : { expectedSettingsRevision: value.expectedSettingsRevision }),
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
    ...(value.code === 'stale-reset-revision' ||
      value.code === 'stale-settings-revision' ||
      value.code === 'stale-setup-version' ||
      value.code === 'stale-read-scope' ||
      value.code === 'safety-ack-failed' ||
      value.code === 'cleanup-pending'
      ? { code: value.code }
      : {}),
    ...(readCleanupStatus(value.cleanup)
      ? { cleanup: readCleanupStatus(value.cleanup) }
      : {}),
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
  code?: PreferenceCommandResult['code'],
  cleanup?: PreferenceCommandResult['cleanup'],
): PreferenceCommandResult {
  return {
    type: 'simul:preferences:result',
    preferences,
    applied,
    ...(code ? { code } : {}),
    ...(cleanup ? { cleanup } : {}),
  };
}

function samePreferences(
  left: CompanionPreferences,
  right: CompanionPreferences,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExpectedReadScope(
  preferences: CompanionPreferences,
  expectedFingerprint: string,
): boolean {
  const effective = effectiveReplicaReadScope(
    preferences.replicaReadScope,
    preferences.readScopeSetupVersion,
  );
  return replicaReadScopeFingerprint(effective) === expectedFingerprint;
}

function retainedPermissionOrigins(
  preferences: CompanionPreferences,
): string[] {
  const siteOrigins = preferences.autoTranslateOrigins.flatMap((origin) =>
    permissionOriginsForMode('site', origin),
  );
  const globalOrigins = preferences.autoTranslateAllSites
    ? [
        ...ALL_SITES_PERMISSION_ORIGINS,
        ...LEGACY_ALL_SITES_PERMISSION_ORIGINS,
      ]
    : preferences.imageTranslationEnabled
      ? [...ALL_SITES_PERMISSION_ORIGINS]
      : [];
  return [...globalOrigins, ...siteOrigins];
}

function isManagedPermissionOrigin(value: string): boolean {
  if (
    (ALL_SITES_PERMISSION_ORIGINS as readonly string[]).includes(value) ||
    (LEGACY_ALL_SITES_PERMISSION_ORIGINS as readonly string[]).includes(value)
  ) {
    return true;
  }
  if (!value.endsWith('/*')) return false;
  return permissionOriginsForMode('site', value.slice(0, -1))[0] === value;
}

function allBroadPermissionOrigins(): string[] {
  return [
    ...ALL_SITES_PERMISSION_ORIGINS,
    ...LEGACY_ALL_SITES_PERMISSION_ORIGINS,
  ];
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
  'replicaFidelityPolicy',
  'replicaViewMode',
  'launchBehavior',
  'lastLaunchSurface',
  'popoutTabMode',
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
  if ('replicaFidelityPolicy' in value) {
    if (!isSelectableReplicaFidelityPolicy(value.replicaFidelityPolicy)) {
      return undefined;
    }
    patch.replicaFidelityPolicy = value.replicaFidelityPolicy;
  }
  if ('replicaViewMode' in value) {
    if (!isReplicaViewMode(value.replicaViewMode)) return undefined;
    patch.replicaViewMode = value.replicaViewMode;
  }
  if ('launchBehavior' in value) {
    if (!isCompanionLaunchBehavior(value.launchBehavior)) return undefined;
    patch.launchBehavior = value.launchBehavior;
  }
  if ('lastLaunchSurface' in value) {
    if (!isCompanionSurface(value.lastLaunchSurface)) return undefined;
    patch.lastLaunchSurface = value.lastLaunchSurface;
  }
  if ('popoutTabMode' in value) {
    if (!isPopoutTabMode(value.popoutTabMode)) return undefined;
    patch.popoutTabMode = value.popoutTabMode;
  }
  return patch;
}

const IMAGE_ANALYSIS_SETTING_KEYS = new Set([
  'imageTranslationEnabled',
  'ocrMinimumConfidence',
  'imageReadingMethodOrder',
  'disabledImageReadingMethodIds',
  'imageTextProviderOrder',
  'disabledImageTextProviderIds',
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
  if ('ocrMinimumConfidence' in value) {
    if (!isOcrMinimumConfidence(value.ocrMinimumConfidence)) return undefined;
    patch.ocrMinimumConfidence = value.ocrMinimumConfidence;
  }
  if ('imageReadingMethodOrder' in value) {
    const order = readExactImageReadingMethodOrder(
      value.imageReadingMethodOrder,
    );
    if (!order) return undefined;
    patch.imageReadingMethodOrder = order;
  }
  if ('disabledImageReadingMethodIds' in value) {
    const disabled = readExactDisabledImageReadingMethodIds(
      value.disabledImageReadingMethodIds,
    );
    if (!disabled) return undefined;
    patch.disabledImageReadingMethodIds = disabled;
  }
  if ('imageTextProviderOrder' in value) {
    const order = readExactImageTextProviderOrder(
      value.imageTextProviderOrder,
    );
    if (!order) return undefined;
    patch.imageTextProviderOrder = order;
  }
  if ('disabledImageTextProviderIds' in value) {
    const disabled = readExactDisabledImageTextProviderIds(
      value.disabledImageTextProviderIds,
    );
    if (!disabled) return undefined;
    patch.disabledImageTextProviderIds = disabled;
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

function readReadSettingsPatch(
  value: unknown,
): CompanionReadSettingsPatch | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== 'replicaReadScope'
  ) return undefined;
  const scope = readExactReplicaReadScope(value.replicaReadScope);
  return scope ? { replicaReadScope: scope } : undefined;
}

function hasExactSafeRevision(
  value: Record<string, unknown>,
  keys: readonly string[],
): value is Record<string, unknown> & { expectedResetRevision: number } {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key)) &&
    isNonNegativeSafeInteger(value.expectedResetRevision);
}

function autoCommandKeys(value: Record<string, unknown>): string[] {
  return [
    'type',
    'expectedResetRevision',
    ...(value.expectedSettingsRevision === undefined
      ? []
      : ['expectedSettingsRevision']),
    'mode',
    ...(value.pageUrl === undefined ? [] : ['pageUrl']),
  ];
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function readCleanupStatus(
  value: unknown,
): PreferenceCommandResult['cleanup'] | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    (value.status !== 'complete' && value.status !== 'pending') ||
    !isNonNegativeSafeInteger(value.remainingManagedOrigins)
  ) return undefined;
  return {
    status: value.status,
    remainingManagedOrigins: value.remainingManagedOrigins,
  };
}
