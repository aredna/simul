import { describe, expect, it } from 'vitest';

import {
  PreferenceCoordinator,
  readPreferenceCommand,
  readPreferenceCommandResult,
  type PreferenceCoordinatorAdapter,
  type PreferenceResetRuntimeAdapter,
} from '../lib/preference-coordinator';
import {
  ALL_SITES_PERMISSION_ORIGINS,
  DEFAULT_COMPANION_PREFERENCES,
  parseCompanionPreferences,
  permissionOriginsForMode,
  type CompanionPreferences,
} from '../lib/preferences';

describe('preference coordinator', () => {
  it('commits selectable read scope only at the current reset/setup revision', async () => {
    const adapter = new MemoryPreferenceAdapter();
    const coordinator = new PreferenceCoordinator(adapter);
    const scope = {
      controlSemantics: true,
      controlImages: true,
      disclosureContent: true,
      formValues: false,
      personalDataValues: false,
      editableContent: false,
    } as const;

    const committed = await coordinator.run({
      type: 'simul:preferences:complete-read-scope-setup',
      expectedResetRevision: 0,
      expectedSetupVersion: 0,
      expectedReadScopeFingerprint: 'read-v1-000000',
      patch: { replicaReadScope: scope },
    });
    expect(committed).toMatchObject({
      applied: true,
      preferences: { replicaReadScope: scope, readScopeSetupVersion: 1 },
    });
    const overwritten = await coordinator.run({
      type: 'simul:preferences:complete-read-scope-setup',
      expectedResetRevision: 0,
      expectedSetupVersion: 0,
      expectedReadScopeFingerprint: 'read-v1-111000',
      patch: {
        replicaReadScope: {
          ...scope,
          formValues: true,
          personalDataValues: true,
          editableContent: true,
        },
      },
    });
    expect(overwritten).toMatchObject({
      applied: false,
      code: 'stale-setup-version',
      preferences: { replicaReadScope: scope, readScopeSetupVersion: 1 },
    });
    const stale = await coordinator.run({
      type: 'simul:preferences:patch-read-scope',
      expectedResetRevision: 9,
      expectedReadScopeFingerprint: 'read-v1-111000',
      patch: { replicaReadScope: scope },
    });
    expect(stale).toMatchObject({
      applied: false,
      code: 'stale-reset-revision',
    });
  });

  it('lets an explicit setup replace any non-current persisted setup version', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      replicaReadScope: {
        controlSemantics: true,
        controlImages: true,
        disclosureContent: true,
        formValues: true,
        personalDataValues: true,
        editableContent: true,
      },
      readScopeSetupVersion: 2,
      settingsRevision: 7,
    });
    const coordinator = new PreferenceCoordinator(adapter);
    const standard = {
      controlSemantics: true,
      controlImages: true,
      disclosureContent: true,
      formValues: false,
      personalDataValues: false,
      editableContent: false,
    } as const;

    const result = await coordinator.run({
      type: 'simul:preferences:complete-read-scope-setup',
      expectedResetRevision: 0,
      expectedSetupVersion: 2,
      expectedReadScopeFingerprint: 'read-v1-000000',
      patch: { replicaReadScope: standard },
    });

    expect(result).toMatchObject({
      applied: true,
      preferences: {
        replicaReadScope: standard,
        readScopeSetupVersion: 1,
        settingsRevision: 8,
      },
    });
    expect(result.preferences.disabledImageReadingMethodIds).not.toContain(
      'accessibility-text',
    );
  });

  it('rejects a concurrent panel that writes from an obsolete read scope', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      replicaReadScope: {
        controlSemantics: true,
        controlImages: true,
        disclosureContent: true,
        formValues: true,
        personalDataValues: true,
        editableContent: true,
      },
      readScopeSetupVersion: 1,
      settingsRevision: 7,
    });
    const coordinator = new PreferenceCoordinator(adapter);
    const pageOnly = {
      controlSemantics: false,
      controlImages: false,
      disclosureContent: false,
      formValues: false,
      personalDataValues: false,
      editableContent: false,
    } as const;
    const standard = {
      ...pageOnly,
      controlSemantics: true,
      controlImages: true,
      disclosureContent: true,
    } as const;

    const first = await coordinator.run({
      type: 'simul:preferences:patch-read-scope',
      expectedResetRevision: 0,
      expectedReadScopeFingerprint: 'read-v1-111111',
      patch: { replicaReadScope: pageOnly },
    });
    const delayedSecondPanel = await coordinator.run({
      type: 'simul:preferences:patch-read-scope',
      expectedResetRevision: 0,
      expectedReadScopeFingerprint: 'read-v1-111111',
      patch: { replicaReadScope: standard },
    });

    expect(first).toMatchObject({
      applied: true,
      preferences: { settingsRevision: 8, replicaReadScope: pageOnly },
    });
    expect(delayedSecondPanel).toMatchObject({
      applied: false,
      code: 'stale-read-scope',
      preferences: { settingsRevision: 8, replicaReadScope: pageOnly },
    });
  });

  it('commits safe defaults before revoking managed origins on reset', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      imageTranslationEnabled: true,
      autoTranslateAllSites: true,
      readScopeSetupVersion: 1,
    });
    adapter.grant('<all_urls>', 'https://site.example/*');
    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reset-all',
      expectedResetRevision: 0,
    });

    expect(result).toMatchObject({
      applied: true,
      cleanup: { status: 'complete', remainingManagedOrigins: 0 },
      preferences: {
        imageTranslationEnabled: false,
        autoTranslateAllSites: false,
        readScopeSetupVersion: 0,
        resetRevision: 1,
        resetCleanupPendingRevision: 0,
      },
    });
    expect(adapter.hasGrant('<all_urls>')).toBe(false);
    expect(adapter.hasGrant('https://site.example/*')).toBe(false);
  });

  it('keeps reset cleanup durable until permission, transient, and offscreen cleanup all succeed', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      imageTranslationEnabled: true,
    });
    adapter.grant('<all_urls>', 'https://orphan.example/*');
    const runtime = new MemoryResetRuntime();
    runtime.failTransientStore = true;

    const first = await new PreferenceCoordinator(adapter, runtime).run({
      type: 'simul:preferences:reset-all',
      expectedResetRevision: 0,
    });

    expect(first).toMatchObject({
      applied: false,
      code: 'cleanup-pending',
      cleanup: { status: 'pending', remainingManagedOrigins: 0 },
      preferences: {
        resetRevision: 1,
        resetCleanupPendingRevision: 1,
      },
    });
    expect(runtime.clearTransientStoreCalls).toBe(1);
    expect(runtime.closeOffscreenDocumentCalls).toBe(1);
    expect(adapter.hasGrant('<all_urls>')).toBe(false);
    expect(adapter.hasGrant('https://orphan.example/*')).toBe(false);

    runtime.failTransientStore = false;
    const resumed = await new PreferenceCoordinator(adapter, runtime).run({
      type: 'simul:preferences:reconcile',
    });

    expect(resumed).toMatchObject({
      applied: true,
      cleanup: { status: 'complete', remainingManagedOrigins: 0 },
      preferences: { resetCleanupPendingRevision: 0 },
    });
    expect(runtime.clearTransientStoreCalls).toBe(2);
    expect(runtime.closeOffscreenDocumentCalls).toBe(2);
  });

  it('keeps reset cleanup pending when permission removal cannot be verified', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      imageTranslationEnabled: true,
    });
    adapter.grant('<all_urls>');
    adapter.failGetAllOriginsOnCall = 2;
    const coordinator = new PreferenceCoordinator(adapter);

    const first = await coordinator.run({
      type: 'simul:preferences:reset-all',
      expectedResetRevision: 0,
    });
    expect(first).toMatchObject({
      applied: false,
      code: 'cleanup-pending',
      preferences: { resetCleanupPendingRevision: 1 },
    });

    adapter.failGetAllOriginsOnCall = undefined;
    const retried = await coordinator.run({
      type: 'simul:preferences:reconcile',
    });
    expect(retried).toMatchObject({
      applied: true,
      preferences: { resetCleanupPendingRevision: 0 },
    });
  });

  it('does not run reset cleanup for a stale reset command', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      resetRevision: 2,
    });
    adapter.grant('https://kept.example/*');
    const runtime = new MemoryResetRuntime();

    const stale = await new PreferenceCoordinator(adapter, runtime).run({
      type: 'simul:preferences:reset-all',
      expectedResetRevision: 1,
    });

    expect(stale).toMatchObject({
      applied: false,
      code: 'stale-reset-revision',
    });
    expect(runtime.clearTransientStoreCalls).toBe(0);
    expect(runtime.closeOffscreenDocumentCalls).toBe(0);
    expect(adapter.hasGrant('https://kept.example/*')).toBe(true);
  });

  it('preserves managed origins desired by the latest pending-reset preferences', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateOrigins: ['https://kept.example'],
      imageTranslationEnabled: true,
      resetRevision: 4,
      resetCleanupPendingRevision: 4,
    });
    adapter.grant(
      '<all_urls>',
      'https://kept.example/*',
      'https://orphan.example/*',
    );

    const reconciled = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reconcile',
    });

    expect(reconciled.preferences.resetCleanupPendingRevision).toBe(0);
    expect(adapter.hasGrant('<all_urls>')).toBe(true);
    expect(adapter.hasGrant('https://kept.example/*')).toBe(true);
    expect(adapter.hasGrant('https://orphan.example/*')).toBe(false);
  });

  it('rejects every stale settings writer after a reset revision advances', async () => {
    const adapter = new MemoryPreferenceAdapter();
    adapter.grant('https://site.example/*');
    const coordinator = new PreferenceCoordinator(adapter);
    const reset = await coordinator.run({
      type: 'simul:preferences:reset-all',
      expectedResetRevision: 0,
    });
    expect(reset.preferences.resetRevision).toBe(1);

    const results = await Promise.all([
      coordinator.run({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { targetLanguage: 'ja' },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { imageTranslationEnabled: true },
      }),
      coordinator.run({
        type: 'simul:preferences:commit-auto',
        expectedResetRevision: 0,
        mode: 'site',
        pageUrl: 'https://site.example/page',
      }),
    ]);

    expect(results).toEqual(results.map((result) => expect.objectContaining({
      applied: false,
      code: 'stale-reset-revision',
    })));
    expect(adapter.preferences).toMatchObject({
      resetRevision: 1,
      targetLanguage: 'en',
      imageTranslationEnabled: false,
      autoTranslateOrigins: [],
    });
  });

  it('rejects a permission transaction based on an obsolete settings snapshot', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      settingsRevision: 4,
    });
    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision: 0,
      expectedSettingsRevision: 3,
      patch: { imageTranslationEnabled: true },
    });

    expect(result).toMatchObject({
      applied: false,
      code: 'stale-settings-revision',
      preferences: {
        settingsRevision: 4,
        imageTranslationEnabled: false,
      },
    });
    expect(adapter.saveCalls).toBe(0);
  });

  it('does not resurrect an image method disabled by another panel', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      settingsRevision: 4,
      readScopeSetupVersion: 1,
      disabledImageReadingMethodIds: [],
    });
    const coordinator = new PreferenceCoordinator(adapter);

    const firstPanel = await coordinator.run({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision: 0,
      expectedSettingsRevision: 4,
      patch: { disabledImageReadingMethodIds: ['chrome-text-detector'] },
    });
    const staleSecondPanel = await coordinator.run({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision: 0,
      expectedSettingsRevision: 4,
      patch: { disabledImageReadingMethodIds: ['tesseract'] },
    });

    expect(firstPanel).toMatchObject({
      applied: true,
      preferences: {
        settingsRevision: 5,
        disabledImageReadingMethodIds: ['chrome-text-detector'],
      },
    });
    expect(staleSecondPanel).toMatchObject({
      applied: false,
      code: 'stale-settings-revision',
      preferences: {
        settingsRevision: 5,
        disabledImageReadingMethodIds: ['chrome-text-detector'],
      },
    });
    expect(adapter.preferences.disabledImageReadingMethodIds).toEqual([
      'chrome-text-detector',
    ]);
  });

  it('persists the repaired OCR confidence during reconciliation', async () => {
    const adapter = new MemoryPreferenceAdapter();
    adapter.loadValue = {
      ...adapter.preferences,
      ocrMinimumConfidence: 0.66,
    };
    const coordinator = new PreferenceCoordinator(adapter);

    const result = await coordinator.run({
      type: 'simul:preferences:reconcile',
    });

    expect(result.preferences.ocrMinimumConfidence).toBe(0.65);
    expect(adapter.preferences.ocrMinimumConfidence).toBe(0.65);
    expect(adapter.saveCalls).toBe(1);
  });

  it('persists legacy disabled OCR providers in the canonical method list', async () => {
    const adapter = new MemoryPreferenceAdapter();
    const legacy = {
      ...adapter.preferences,
      readScopeSetupVersion: 1,
      disabledImageTextProviderIds: ['tesseract'],
    } as Record<string, unknown>;
    delete legacy.imageReadingMethodOrder;
    delete legacy.disabledImageReadingMethodIds;
    adapter.loadValue = legacy;

    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reconcile',
    });

    expect(result.preferences.disabledImageReadingMethodIds).toEqual([
      'tesseract',
    ]);
    expect(adapter.preferences.disabledImageReadingMethodIds).toEqual([
      'tesseract',
    ]);
    expect(adapter.saveCalls).toBe(1);
  });

  it('removes a retired replica-engine preference during reconciliation', async () => {
    const adapter = new MemoryPreferenceAdapter();
    adapter.loadValue = {
      ...adapter.preferences,
      replicaEngine: 'rrweb',
    };

    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reconcile',
    });

    expect(Object.hasOwn(result.preferences, 'replicaEngine')).toBe(false);
    expect(Object.hasOwn(adapter.preferences, 'replicaEngine')).toBe(false);
    expect(adapter.saveCalls).toBe(1);
  });

  it('loads the current stored value for each serialized side-panel commit', async () => {
    const adapter = new MemoryPreferenceAdapter();
    adapter.grant(...permissionOriginsForMode('site', 'https://one.example/'));
    const coordinator = new PreferenceCoordinator(adapter);

    const first = await coordinator.run({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'site',
      pageUrl: 'https://one.example/page',
    });
    adapter.grant(...permissionOriginsForMode('site', 'https://two.example/'));
    const second = await coordinator.run({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'site',
      pageUrl: 'https://two.example/page',
    });

    expect(first).toMatchObject({ applied: true });
    expect(second).toMatchObject({
      applied: true,
      preferences: {
        autoTranslateOrigins: [
          'https://one.example',
          'https://two.example',
        ],
      },
    });
    expect(adapter.preferences.autoTranslateOrigins).toEqual([
      'https://one.example',
      'https://two.example',
    ]);
  });

  it('reconciles every retained site after a denied all-sites narrowing', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: true,
      autoTranslateOrigins: [
        'https://kept.example',
        'https://revoked.example',
      ],
      displayMode: 'fit',
    });
    adapter.grant('https://kept.example/*');
    adapter.grant('https://denied.example/*');
    const coordinator = new PreferenceCoordinator(adapter);

    const result = await coordinator.run({
      type: 'simul:preferences:abort-auto',
      expectedResetRevision: 0,
      mode: 'site',
      pageUrl: 'https://denied.example/page',
    });

    expect(result).toMatchObject({
      applied: false,
      preferences: {
        autoTranslateAllSites: false,
        autoTranslateOrigins: ['https://kept.example'],
      },
    });
    expect(adapter.hasGrant('https://denied.example/*')).toBe(false);
  });

  it('keeps exact grants while all-sites automation is enabled', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: false,
      autoTranslateOrigins: ['https://kept.example'],
      displayMode: 'fit',
    });
    adapter.grant('https://kept.example/*', ...ALL_SITES_PERMISSION_ORIGINS);
    const coordinator = new PreferenceCoordinator(adapter);

    const result = await coordinator.run({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'all',
      pageUrl: 'https://current.example/page',
    });

    expect(result.applied).toBe(true);
    expect(adapter.hasGrant('https://kept.example/*')).toBe(true);
  });

  it('removes partial wildcard grants but keeps an exact grant Simul never relied on', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: true,
      autoTranslateOrigins: ['https://kept.example'],
      displayMode: 'fit',
    });
    // The wildcard shape is only ever Simul's own; the exact grant for
    // orphan.example was made outside Simul (it is in no saved intent and
    // not in the ledger), so it is not Simul's to revoke.
    adapter.grant(
      'https://*/*',
      'https://kept.example/*',
      'https://orphan.example/*',
    );
    const coordinator = new PreferenceCoordinator(adapter);

    const result = await coordinator.run({
      type: 'simul:preferences:reconcile',
    });

    expect(result.preferences).toMatchObject({
      autoTranslateAllSites: false,
      autoTranslateOrigins: ['https://kept.example'],
      grantedPermissionOrigins: ['https://kept.example/*'],
    });
    expect(adapter.hasGrant('https://*/*')).toBe(false);
    expect(adapter.hasGrant('https://kept.example/*')).toBe(true);
    expect(adapter.hasGrant('https://orphan.example/*')).toBe(true);
  });

  it('releases a grant it once relied on when the intent behind it is gone', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      grantedPermissionOrigins: ['https://stale.example/*'],
    });
    adapter.grant('https://stale.example/*', 'https://user.example/*');

    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reconcile',
    });

    expect(adapter.hasGrant('https://stale.example/*')).toBe(false);
    expect(adapter.hasGrant('https://user.example/*')).toBe(true);
    expect(result.preferences.grantedPermissionOrigins).toEqual([]);
  });

  it('keeps a broad grant the user made outside Simul and lets it cover site intent', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateOrigins: ['https://kept.example'],
    });
    // Granted in chrome://extensions: no saved intent asked for it.
    adapter.grant('<all_urls>');
    const coordinator = new PreferenceCoordinator(adapter);

    const reconciled = await coordinator.run({
      type: 'simul:preferences:reconcile',
    });
    expect(reconciled.preferences).toMatchObject({
      autoTranslateAllSites: false,
      autoTranslateOrigins: ['https://kept.example'],
      grantedPermissionOrigins: [],
    });
    expect(adapter.hasGrant('<all_urls>')).toBe(true);

    // Choosing this site does not drop the user's broad grant to prove the
    // narrower one; the intent is kept under the user's coverage instead.
    const committed = await coordinator.run({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'site',
      pageUrl: 'https://another.example/page',
    });
    expect(committed).toMatchObject({
      applied: true,
      preferences: {
        autoTranslateOrigins: ['https://kept.example', 'https://another.example'],
      },
    });
    expect(adapter.hasGrant('<all_urls>')).toBe(true);
  });

  it('owns the broad grant once all-sites automation relies on it and releases it with the intent', async () => {
    const adapter = new MemoryPreferenceAdapter();
    // The side panel requested and received the grant before committing.
    adapter.grant('<all_urls>');
    const coordinator = new PreferenceCoordinator(adapter);

    const enabled = await coordinator.run({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'all',
      pageUrl: 'https://current.example/page',
    });
    expect(enabled.preferences).toMatchObject({
      autoTranslateAllSites: true,
      grantedPermissionOrigins: ['<all_urls>'],
    });

    const disabled = await coordinator.run({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'off',
      pageUrl: 'https://current.example/page',
    });
    expect(disabled.preferences).toMatchObject({
      autoTranslateAllSites: false,
      grantedPermissionOrigins: [],
    });
    expect(adapter.hasGrant('<all_urls>')).toBe(false);
  });

  it('adopts every managed grant once when stored preferences predate the ledger', async () => {
    const adapter = new MemoryPreferenceAdapter();
    const { grantedPermissionOrigins: _ledger, ...legacyStored } =
      parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
    adapter.loadValue = legacyStored;
    adapter.grant('<all_urls>', 'https://old.example/*');
    const coordinator = new PreferenceCoordinator(adapter);

    // Pre-ledger installs keep the cleanup they always had: grants no intent
    // needs are released on the first reconcile after the update.
    const migrated = await coordinator.run({
      type: 'simul:preferences:reconcile',
    });
    expect(migrated.preferences.grantedPermissionOrigins).toEqual([]);
    expect(adapter.saveCalls).toBe(1);
    expect(adapter.hasGrant('<all_urls>')).toBe(false);
    expect(adapter.hasGrant('https://old.example/*')).toBe(false);

    // From then on a grant the user makes stays theirs.
    adapter.grant('https://user.example/*');
    await coordinator.run({ type: 'simul:preferences:reconcile' });
    expect(adapter.hasGrant('https://user.example/*')).toBe(true);
  });

  it('still releases every managed grant on an explicit reset', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      readScopeSetupVersion: 1,
    });
    adapter.grant('<all_urls>', 'https://user.example/*');

    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reset-all',
      expectedResetRevision: 0,
    });

    expect(result).toMatchObject({
      applied: true,
      cleanup: { status: 'complete', remainingManagedOrigins: 0 },
    });
    expect(adapter.hasGrant('<all_urls>')).toBe(false);
    expect(adapter.hasGrant('https://user.example/*')).toBe(false);
  });

  it('merges display and automatic changes through one current stored value', async () => {
    const adapter = new MemoryPreferenceAdapter();
    adapter.grant('https://one.example/*');
    const coordinator = new PreferenceCoordinator(adapter);

    await Promise.all([
      coordinator.run({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { imageTranslationEnabled: true },
      }),
      coordinator.run({
        type: 'simul:preferences:set-display',
        expectedResetRevision: 0,
        displayMode: 'actual',
      }),
      coordinator.run({
        type: 'simul:preferences:commit-auto',
        expectedResetRevision: 0,
        mode: 'site',
        pageUrl: 'https://one.example/page',
      }),
    ]);

    expect(adapter.preferences).toEqual({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: false,
      autoTranslateOrigins: ['https://one.example'],
      grantedPermissionOrigins: ['https://one.example/*'],
      displayMode: 'actual',
      imageTranslationEnabled: true,
      settingsRevision: 3,
    });
  });

  it('applies a validated companion-view patch without replacing other fields', async () => {
    const adapter = new MemoryPreferenceAdapter();
    const coordinator = new PreferenceCoordinator(adapter);

    const result = await coordinator.run({
      type: 'simul:preferences:patch-view',
      expectedResetRevision: 0,
      patch: {
        targetLanguage: 'ja',
        displayMode: 'custom',
        zoomPercent: 185,
        replicaFidelityPolicy: 'conservative',
        replicaViewMode: 'source-only',
      },
    });

    expect(result.applied).toBe(true);
    expect(adapter.preferences).toMatchObject({
      imageTranslationEnabled: false,
      sourceLanguage: 'auto',
      targetLanguage: 'ja',
      displayMode: 'custom',
      zoomPercent: 185,
      replicaFidelityPolicy: 'conservative',
      replicaViewMode: 'source-only',
      syncScroll: true,
      textLayoutMode: 'adaptive',
    });
  });

  it('serializes concurrent view patches without stale fields overwriting each other', async () => {
    const adapter = new MemoryPreferenceAdapter();
    const coordinator = new PreferenceCoordinator(adapter);

    await Promise.all([
      coordinator.run({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { displayMode: 'custom', zoomPercent: 165 },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: {
          syncScroll: false,
          replicaFidelityPolicy: 'conservative',
        },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: {
          textLayoutMode: 'faithful',
          replicaViewMode: 'source-only',
        },
      }),
    ]);

    expect(adapter.preferences).toMatchObject({
      displayMode: 'custom',
      zoomPercent: 165,
      syncScroll: false,
      replicaFidelityPolicy: 'conservative',
      textLayoutMode: 'faithful',
      replicaViewMode: 'source-only',
    });
  });

  it('serializes image-analysis patches and preserves concurrently changed sibling fields', async () => {
    const adapter = new MemoryPreferenceAdapter();
    const coordinator = new PreferenceCoordinator(adapter);

    await Promise.all([
      coordinator.run({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { imageTranslationEnabled: true },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { imageScanPolicy: 'eager-all' },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { skipSmallImages: false },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { usePromptForImageLanguage: true },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { ocrMinimumConfidence: 0.8 },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { syncScroll: false },
      }),
    ]);

    expect(adapter.preferences).toMatchObject({
      imageTranslationEnabled: true,
      ocrMinimumConfidence: 0.8,
      imageScanPolicy: 'eager-all',
      skipSmallImages: false,
      usePromptForImageLanguage: true,
      usePromptForImageText: false,
      syncScroll: false,
    });
  });

  it('preserves saved image-translation intent when pixel access is missing', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      imageTranslationEnabled: true,
    });
    const coordinator = new PreferenceCoordinator(adapter);

    const result = await coordinator.run({
      type: 'simul:preferences:reconcile',
    });

    expect(result.preferences.imageTranslationEnabled).toBe(true);
    expect(adapter.hasGrant('<all_urls>')).toBe(false);
  });

  it('retains the literal capture grant for either broad-access owner', async () => {
    const imageAdapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      imageTranslationEnabled: true,
    });
    imageAdapter.grant('<all_urls>');
    await new PreferenceCoordinator(imageAdapter).run({
      type: 'simul:preferences:reconcile',
    });
    expect(imageAdapter.hasGrant('<all_urls>')).toBe(true);

    const automaticAdapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: true,
      imageTranslationEnabled: true,
    });
    automaticAdapter.grant('<all_urls>');
    await new PreferenceCoordinator(automaticAdapter).run({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision: 0,
      patch: { imageTranslationEnabled: false },
    });
    expect(automaticAdapter.preferences.autoTranslateAllSites).toBe(true);
    expect(automaticAdapter.hasGrant('<all_urls>')).toBe(true);
  });

  it('releases the literal capture grant after the last owner turns off', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      imageTranslationEnabled: true,
    });
    adapter.grant('<all_urls>');

    await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision: 0,
      patch: { imageTranslationEnabled: false },
    });

    expect(adapter.hasGrant('<all_urls>')).toBe(false);
  });

  it('retains image capture access when automatic translation narrows', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: true,
      imageTranslationEnabled: true,
    });
    adapter.grant('<all_urls>');
    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'site',
      pageUrl: 'https://one.example/page',
    });

    expect(result.applied).toBe(true);
    expect(adapter.hasGrant('<all_urls>')).toBe(true);
  });

  it('clears revoked automatic-all intent but keeps image intent paused', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: true,
      imageTranslationEnabled: true,
    });
    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reconcile',
    });

    expect(result.preferences).toMatchObject({
      autoTranslateAllSites: false,
      imageTranslationEnabled: true,
    });
  });

  it('does not treat a broad grant Simul owns as proof of an exact-site grant', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateOrigins: ['https://one.example'],
      // Left over from an earlier all-sites intent: Simul's own grant, which
      // no current intent needs, so it is released rather than relied on.
      grantedPermissionOrigins: ['<all_urls>'],
    });
    adapter.grant('<all_urls>');
    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reconcile',
    });

    expect(result.preferences.autoTranslateOrigins).toEqual([]);
    expect(result.preferences.grantedPermissionOrigins).toEqual([]);
    expect(adapter.hasGrant('<all_urls>')).toBe(false);
  });

  it('drops broad-dependent site intent after image access is revoked', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      imageTranslationEnabled: true,
      autoTranslateOrigins: ['https://one.example'],
    });
    const result = await new PreferenceCoordinator(adapter).run({
      type: 'simul:preferences:reconcile',
    });

    expect(result.preferences).toMatchObject({
      imageTranslationEnabled: true,
      autoTranslateOrigins: [],
    });
  });
});

describe('preference coordinator message boundary', () => {
  it('accepts known commands and rejects malformed values', () => {
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:commit-auto',
        mode: 'site',
        pageUrl: 'https://example.com/',
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:commit-auto',
        expectedResetRevision: 0,
        mode: 'site',
        pageUrl: 'https://example.com/',
      }),
    ).toEqual({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: 0,
      mode: 'site',
      pageUrl: 'https://example.com/',
    });
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: {
          imageTextProviderOrder: [
            'transformers',
            'tesseract',
            'chrome-text-detector',
            'chromium-screen-ai',
          ],
          disabledImageTextProviderIds: ['chrome-text-detector'],
          imageScanPolicy: 'visible-only',
          imageTranslationEnabled: true,
          ocrMinimumConfidence: 0.8,
          skipSmallImages: false,
        },
      }),
    ).toEqual({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision: 0,
      patch: {
        imageTextProviderOrder: [
          'transformers',
          'tesseract',
          'chrome-text-detector',
          'chromium-screen-ai',
        ],
        disabledImageTextProviderIds: ['chrome-text-detector'],
        imageScanPolicy: 'visible-only',
        imageTranslationEnabled: true,
        ocrMinimumConfidence: 0.8,
        skipSmallImages: false,
      },
    });
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: {
          imageTextProviderOrder: [
            'tesseract',
            'tesseract',
            'transformers',
            'chromium-screen-ai',
          ],
        },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: {
          disabledImageTextProviderIds: ['tesseract', 'tesseract'],
        },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { imageScanPolicy: 'later', skipSmallImages: 'yes' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { ocrMinimumConfidence: 0.66 },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { ocrMinimumConfidence: '0.80' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: 0,
        patch: { imageScanPolicy: 'visible-only' },
        silentlyRepair: true,
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:commit-auto',
        expectedResetRevision: 0,
        mode: 'everything',
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: {
          targetLanguage: 'ja',
          zoomPercent: 160,
          syncScroll: false,
          launchBehavior: 'last-used',
          lastLaunchSurface: 'popout',
          popoutTabMode: 'active',
          replicaFidelityPolicy: 'conservative',
          replicaViewMode: 'source-only',
        },
      }),
    ).toEqual({
      type: 'simul:preferences:patch-view',
      expectedResetRevision: 0,
      patch: {
        targetLanguage: 'ja',
        zoomPercent: 160,
        syncScroll: false,
        launchBehavior: 'last-used',
        lastLaunchSurface: 'popout',
        popoutTabMode: 'active',
        replicaFidelityPolicy: 'conservative',
        replicaViewMode: 'source-only',
      },
    });
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { replicaFidelityPolicy: 'strict-local' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { replicaFidelityPolicy: 'maximum' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { targetLanguage: 'not-supported' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { launchBehavior: 'chooser' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { replicaViewMode: 'unsafe-copy' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: {},
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: 0,
        patch: { syncScroll: true, unexpected: 'field' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-read-scope',
        expectedResetRevision: 0,
        expectedReadScopeFingerprint: 'read-v1-000000',
        patch: {
          replicaReadScope: {
            controlSemantics: true,
            controlImages: true,
            disclosureContent: true,
            formValues: false,
            personalDataValues: false,
            editableContent: false,
          },
        },
      }),
    ).toMatchObject({
      type: 'simul:preferences:patch-read-scope',
      expectedReadScopeFingerprint: 'read-v1-000000',
    });
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-read-scope',
        expectedResetRevision: 0,
        patch: { readScopeSetupVersion: 1 },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:complete-read-scope-setup',
        expectedResetRevision: 0,
        expectedSetupVersion: 1,
        patch: {
          replicaReadScope: {
            controlSemantics: true,
            controlImages: true,
            disclosureContent: true,
            formValues: false,
            personalDataValues: false,
            editableContent: false,
          },
          readScopeSetupVersion: 99,
        },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommandResult({
        type: 'simul:preferences:result',
        applied: true,
        preferences: { displayMode: 'actual' },
      }),
    ).toMatchObject({
      applied: true,
      preferences: { displayMode: 'actual' },
    });
  });
});

class MemoryPreferenceAdapter implements PreferenceCoordinatorAdapter {
  preferences: CompanionPreferences;
  loadValue: unknown | undefined;
  saveCalls = 0;
  getAllOriginsCalls = 0;
  failGetAllOriginsOnCall: number | undefined;
  private readonly grants = new Set<string>();

  constructor(initial?: CompanionPreferences) {
    this.preferences = parseCompanionPreferences(initial);
  }

  async load(): Promise<unknown> {
    return structuredClone(this.loadValue ?? this.preferences);
  }

  async save(preferences: CompanionPreferences): Promise<void> {
    this.saveCalls += 1;
    this.preferences = structuredClone(preferences);
    this.loadValue = undefined;
  }

  async contains(origins: string[]): Promise<boolean> {
    return origins.every((origin) => this.isCovered(origin));
  }

  async getAllOrigins(): Promise<string[]> {
    this.getAllOriginsCalls += 1;
    if (this.getAllOriginsCalls === this.failGetAllOriginsOnCall) {
      throw new Error('permission query failed');
    }
    return [...this.grants];
  }

  async remove(origins: string[]): Promise<boolean> {
    let removed = false;
    for (const origin of origins) {
      removed = this.grants.delete(origin) || removed;
    }
    return removed;
  }

  grant(...origins: string[]): void {
    for (const origin of origins) this.grants.add(origin);
  }

  hasGrant(origin: string): boolean {
    return this.grants.has(origin);
  }

  private isCovered(origin: string): boolean {
    if (this.grants.has(origin)) return true;
    if (this.grants.has('<all_urls>')) return true;
    if (origin.startsWith('http://')) {
      return this.grants.has('http://*/*');
    }
    if (origin.startsWith('https://')) {
      return this.grants.has('https://*/*');
    }
    return false;
  }
}

class MemoryResetRuntime implements PreferenceResetRuntimeAdapter {
  clearTransientStoreCalls = 0;
  closeOffscreenDocumentCalls = 0;
  failTransientStore = false;
  failOffscreenClose = false;

  async clearTransientStore(): Promise<void> {
    this.clearTransientStoreCalls += 1;
    if (this.failTransientStore) throw new Error('transient cleanup failed');
  }

  async closeOffscreenDocument(): Promise<void> {
    this.closeOffscreenDocumentCalls += 1;
    if (this.failOffscreenClose) throw new Error('offscreen close failed');
  }
}
