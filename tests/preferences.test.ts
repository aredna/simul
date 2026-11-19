import { afterEach, describe, expect, it } from 'vitest';

import {
  ALL_SITES_PERMISSION_ORIGINS,
  DEFAULT_COMPANION_PREFERENCES,
  PUBLIC_EDITION_PINNED_PREFERENCE_KEYS,
  advanceCompanionSettingsRevision,
  applyEditionToPreferences,
  autoTranslationModeForPage,
  clampZoomPercent,
  configureDefaultTargetLanguage,
  defaultTargetLanguageForUiLanguage,
  isAutoTranslationEnabled,
  pageOrigin,
  parseCompanionPreferences,
  parseStoredCompanionPreferences,
  permissionOriginsForMode,
  permissionOriginsForPreferences,
  readValidStoredCompanionPreferences,
  resetCompanionPreferences,
  selectLiveCompanionPreferenceChange,
  selectLatestCompanionPreferences,
  sitePermissionPattern,
  withAutoTranslationMode,
  withDisplayMode,
  withImageAnalysisSettings,
  withViewSettings,
  type CompanionPreferences,
} from '../lib/preferences';
import {
  isReplicaFidelityPolicy,
  isSelectableReplicaFidelityPolicy,
} from '../lib/replica/fidelity-policy';
import {
  DEFAULT_REPLICA_READ_SCOPE,
  REPLICA_READ_SCOPE_SETUP_VERSION,
  replicaReadScopeForProfile,
} from '../lib/replica/read-scope-policy';

describe('parseCompanionPreferences', () => {
  it('uses the defaults for absent or invalid data', () => {
    // A fresh install starts set up at Full visible, following, at 1:1 (D66).
    expect(parseCompanionPreferences(undefined)).toEqual({
      autoTranslateAllSites: false,
      autoTranslateOrigins: [],
      grantedPermissionOrigins: [],
      displayMode: 'actual',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      zoomPercent: 100,
      syncScroll: true,
      textLayoutMode: 'adaptive',
      replicaFidelityPolicy: 'passive',
      mirrorLimits: { itemMegabytes: 10, pageMegabytes: 60, maxElements: 200_000 },
      mirrorShowEverything: false,
      replicaViewMode: 'translated',
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'active',
      replicaReadScope: {
        controlSemantics: true,
        controlImages: true,
        disclosureContent: true,
        formValues: true,
        personalDataValues: true,
        editableContent: true,
      },
      readScopeSetupVersion: 1,
      settingsRevision: 0,
      resetRevision: 0,
      resetCleanupPendingRevision: 0,
      imageTranslationEnabled: true,
      ocrMinimumConfidence: 0.65,
      imageReadingMethodOrder: [
        'accessibility-text',
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageReadingMethodIds: [],
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageTextProviderIds: [],
      imageScanPolicy: 'visible-first-background-prescan',
      skipSmallImages: true,
      usePromptForImageLanguage: false,
      usePromptForImageText: false,
    });
    expect(parseCompanionPreferences('all')).toEqual(
      DEFAULT_COMPANION_PREFERENCES,
    );
    // A stored record without a setup version was never set up: it keeps
    // Page-only and the setup question; view settings repair to defaults.
    expect(parseCompanionPreferences({
      autoTranslateAllSites: 'yes',
      displayMode: 'giant',
    })).toEqual({
      autoTranslateAllSites: false,
      autoTranslateOrigins: [],
      grantedPermissionOrigins: [],
      displayMode: 'actual',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      zoomPercent: 100,
      syncScroll: true,
      textLayoutMode: 'adaptive',
      replicaFidelityPolicy: 'passive',
      mirrorLimits: { itemMegabytes: 10, pageMegabytes: 60, maxElements: 200_000 },
      mirrorShowEverything: false,
      replicaViewMode: 'translated',
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'active',
      replicaReadScope: {
        controlSemantics: false,
        controlImages: false,
        disclosureContent: false,
        formValues: false,
        personalDataValues: false,
        editableContent: false,
      },
      readScopeSetupVersion: 0,
      settingsRevision: 0,
      resetRevision: 0,
      resetCleanupPendingRevision: 0,
      imageTranslationEnabled: true,
      ocrMinimumConfidence: 0.65,
      imageReadingMethodOrder: [
        'accessibility-text',
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageReadingMethodIds: ['accessibility-text'],
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageTextProviderIds: [],
      imageScanPolicy: 'visible-first-background-prescan',
      skipSmallImages: true,
      usePromptForImageLanguage: false,
      usePromptForImageText: false,
    });
  });

  it('accepts only canonical HTTP(S) origins and deduplicates them', () => {
    expect(
      parseCompanionPreferences({
        autoTranslateAllSites: true,
        autoTranslateOrigins: [
          'https://example.com',
          'https://example.com/',
          'http://localhost:3000',
          'https://example.com/private',
          'https://user:secret@example.com',
          'chrome://settings',
          'javascript:alert(1)',
          42,
        ],
        displayMode: 'actual',
      }),
    ).toEqual({
      autoTranslateAllSites: true,
      autoTranslateOrigins: ['https://example.com'],
      grantedPermissionOrigins: [],
      displayMode: 'actual',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      zoomPercent: 100,
      syncScroll: true,
      textLayoutMode: 'adaptive',
      replicaFidelityPolicy: 'passive',
      mirrorLimits: { itemMegabytes: 10, pageMegabytes: 60, maxElements: 200_000 },
      mirrorShowEverything: false,
      replicaViewMode: 'translated',
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'active',
      replicaReadScope: {
        controlSemantics: false,
        controlImages: false,
        disclosureContent: false,
        formValues: false,
        personalDataValues: false,
        editableContent: false,
      },
      readScopeSetupVersion: 0,
      settingsRevision: 0,
      resetRevision: 0,
      resetCleanupPendingRevision: 0,
      imageTranslationEnabled: true,
      ocrMinimumConfidence: 0.65,
      imageReadingMethodOrder: [
        'accessibility-text',
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageReadingMethodIds: ['accessibility-text'],
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageTextProviderIds: [],
      imageScanPolicy: 'visible-first-background-prescan',
      skipSmallImages: true,
      usePromptForImageLanguage: false,
      usePromptForImageText: false,
    });
  });

  it('keeps only managed permission patterns in the granted-origin ledger', () => {
    expect(parseCompanionPreferences({
      grantedPermissionOrigins: [
        '<all_urls>',
        'https://site.example/*',
        'https://site.example/*',
        'http://*/*',
        'https://site.example',
        'https://site.example/path/*',
        'file:///*',
        42,
      ],
    }).grantedPermissionOrigins).toEqual([
      '<all_urls>',
      'https://site.example/*',
      'http://*/*',
    ]);
    expect(parseCompanionPreferences({ grantedPermissionOrigins: 'https://x/*' })
      .grantedPermissionOrigins).toEqual([]);
  });

  it('returns fresh origin arrays so callers cannot mutate defaults or input', () => {
    const rawOrigins = ['https://example.com'];
    const first = parseCompanionPreferences({ autoTranslateOrigins: rawOrigins });
    const second = parseCompanionPreferences(undefined);

    first.autoTranslateOrigins.push('https://second.example');
    second.autoTranslateOrigins.push('https://third.example');

    expect(rawOrigins).toEqual(['https://example.com']);
    expect(parseCompanionPreferences(undefined).autoTranslateOrigins).toEqual(
      [],
    );
  });

  it('treats its own snapshots as canonical instead of validating them again (O7)', () => {
    const canonical = parseCompanionPreferences({
      autoTranslateOrigins: ['https://example.com'],
    });

    // Parsing a snapshot this module produced is the identity, so the hot
    // helpers below skip re-validation and allocation.
    expect(parseCompanionPreferences(canonical)).toBe(canonical);
    expect(autoTranslationModeForPage(canonical, 'https://example.com/page'))
      .toBe('site');
    expect(permissionOriginsForPreferences(canonical))
      .toEqual(['https://example.com/*']);
    expect(withViewSettings(canonical, { displayMode: 'fit' })).toMatchObject({
      displayMode: 'fit',
      autoTranslateOrigins: ['https://example.com'],
    });
  });

  it('migrates and bounds saved multilingual view settings', () => {
    expect(
      parseCompanionPreferences({
        sourceLanguage: 'ja',
        targetLanguage: 'zh-Hant',
        displayMode: 'custom',
        zoomPercent: 999,
        syncScroll: false,
        textLayoutMode: 'faithful',
      }),
    ).toMatchObject({
      sourceLanguage: 'ja',
      targetLanguage: 'zh-Hant',
      displayMode: 'custom',
      zoomPercent: 300,
      syncScroll: false,
      textLayoutMode: 'faithful',
    });
    expect(clampZoomPercent(-10)).toBe(25);
    expect(clampZoomPercent(137.4)).toBe(137);
  });

  it('persists valid surface launch choices and repairs damaged values', () => {
    expect(parseCompanionPreferences({
      launchBehavior: 'popout',
      lastLaunchSurface: 'popout',
      popoutTabMode: 'locked',
    })).toMatchObject({
      launchBehavior: 'popout',
      lastLaunchSurface: 'popout',
      popoutTabMode: 'locked',
    });
    expect(parseCompanionPreferences({
      launchBehavior: 'chooser',
      lastLaunchSurface: 'panel',
      popoutTabMode: 'all-windows',
    })).toMatchObject({
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'active',
    });
  });

  it('persists source-only replica mode and repairs unknown values', () => {
    expect(parseCompanionPreferences({ replicaViewMode: 'source-only' }))
      .toMatchObject({ replicaViewMode: 'source-only' });
    expect(parseCompanionPreferences({ replicaViewMode: 'raw-copy' }))
      .toMatchObject({ replicaViewMode: 'translated' });

    expect(withViewSettings(parseCompanionPreferences(undefined), {
      replicaViewMode: 'source-only',
    })).toMatchObject({ replicaViewMode: 'source-only' });
  });

  it('keeps Show everything off unless it was saved on (D75)', () => {
    expect(parseCompanionPreferences(undefined).mirrorShowEverything).toBe(false);
    expect(parseCompanionPreferences({ mirrorShowEverything: true }))
      .toMatchObject({ mirrorShowEverything: true });
    for (const damaged of ['true', 1, null]) {
      expect(parseCompanionPreferences({ mirrorShowEverything: damaged })
        .mirrorShowEverything).toBe(false);
    }
    expect(withViewSettings(parseCompanionPreferences(undefined), {
      mirrorShowEverything: true,
    })).toMatchObject({ mirrorShowEverything: true });
  });

  it('defaults and migrates replica fidelity without enabling reserved strict local', () => {
    expect(parseCompanionPreferences(undefined).replicaFidelityPolicy).toBe(
      'passive',
    );
    expect(parseCompanionPreferences({}).replicaFidelityPolicy).toBe('passive');
    expect(parseCompanionPreferences({
      replicaFidelityPolicy: 'conservative',
    }).replicaFidelityPolicy).toBe('conservative');
    expect(parseCompanionPreferences({
      replicaFidelityPolicy: 'strict-local',
    }).replicaFidelityPolicy).toBe('passive');
    expect(parseCompanionPreferences({
      replicaFidelityPolicy: 'unbounded',
    }).replicaFidelityPolicy).toBe('passive');

    expect(isReplicaFidelityPolicy('strict-local')).toBe(true);
    expect(isSelectableReplicaFidelityPolicy('strict-local')).toBe(false);
  });

  it('repairs old or damaged image-analysis settings without mutating saved order', () => {
    const rawOrder = ['retired-provider', 'unknown', 'retired-provider', 'tesseract'];
    const parsed = parseCompanionPreferences({
      imageTranslationEnabled: true,
      ocrMinimumConfidence: 0.8,
      imageTextProviderOrder: rawOrder,
      imageScanPolicy: 'visible-only',
      skipSmallImages: false,
      usePromptForImageLanguage: true,
      usePromptForImageText: true,
    });

    expect(parsed).toMatchObject({
      imageTranslationEnabled: true,
      ocrMinimumConfidence: 0.8,
      imageTextProviderOrder: [
        'tesseract',
        'chrome-text-detector',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageTextProviderIds: [],
      imageScanPolicy: 'visible-only',
      skipSmallImages: false,
      usePromptForImageLanguage: true,
      usePromptForImageText: true,
    });
    parsed.imageTextProviderOrder.reverse();
    expect(rawOrder).toEqual([
      'retired-provider',
      'unknown',
      'retired-provider',
      'tesseract',
    ]);
    expect(parseCompanionPreferences(undefined).imageTextProviderOrder).toEqual([
      'chrome-text-detector',
      'tesseract',
      'transformers',
      'chromium-screen-ai',
    ]);
    expect(parseCompanionPreferences({
      ocrMinimumConfidence: 0.66,
    }).ocrMinimumConfidence).toBe(0.65);
  });

  it('repairs provider toggles and drops retired provider IDs', () => {
    expect(parseCompanionPreferences({
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'retired-provider',
        'chromium-screen-ai',
      ],
      disabledImageTextProviderIds: [
        'tesseract',
        'unknown',
        'tesseract',
        'retired-provider',
      ],
    })).toMatchObject({
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'chromium-screen-ai',
      ],
      disabledImageReadingMethodIds: [
        'accessibility-text',
        'tesseract',
      ],
      disabledImageTextProviderIds: ['tesseract'],
    });

    expect(parseCompanionPreferences({
      readScopeSetupVersion: 1,
      disabledImageTextProviderIds: ['chrome-text-detector'],
    })).toMatchObject({
      disabledImageReadingMethodIds: ['chrome-text-detector'],
      disabledImageTextProviderIds: ['chrome-text-detector'],
    });
  });

  it('keeps accessibility text disabled until the exact setup version', () => {
    for (const readScopeSetupVersion of [0, 2, -1, '1']) {
      expect(parseCompanionPreferences({
        readScopeSetupVersion,
        disabledImageReadingMethodIds: [],
      }).disabledImageReadingMethodIds).toContain('accessibility-text');
    }
    expect(parseCompanionPreferences({
      readScopeSetupVersion: 1,
      disabledImageReadingMethodIds: [],
    }).disabledImageReadingMethodIds).not.toContain('accessibility-text');
  });

  it('does not let delayed responses replace a newer commit or reset', () => {
    const baseline = parseCompanionPreferences({
      settingsRevision: 4,
      targetLanguage: 'ja',
    });
    const newer = parseCompanionPreferences({
      settingsRevision: 5,
      targetLanguage: 'fr',
    });
    expect(selectLatestCompanionPreferences(newer, baseline).targetLanguage)
      .toBe('fr');

    const reset = resetCompanionPreferences(newer);
    expect(reset).toMatchObject({ resetRevision: 1, settingsRevision: 6 });
    expect(selectLatestCompanionPreferences(reset, newer)).toMatchObject({
      resetRevision: 1,
      targetLanguage: 'en',
    });
  });

  it('distinguishes a complete canonical stored snapshot from repairable data', () => {
    const canonical = parseCompanionPreferences({
      ...DEFAULT_COMPANION_PREFERENCES,
      replicaReadScope: replicaReadScopeForProfile('full-visible'),
      readScopeSetupVersion: 1,
      settingsRevision: 8,
    });

    expect(readValidStoredCompanionPreferences(canonical)).toEqual(canonical);
    expect(readValidStoredCompanionPreferences(undefined)).toBeUndefined();
    expect(readValidStoredCompanionPreferences({
      replicaReadScope: canonical.replicaReadScope,
      readScopeSetupVersion: 1,
      settingsRevision: 9,
    })).toBeUndefined();
    expect(readValidStoredCompanionPreferences({
      ...canonical,
      replicaReadScope: { ...canonical.replicaReadScope, formValues: 'yes' },
    })).toBeUndefined();
    expect(readValidStoredCompanionPreferences({
      ...canonical,
      unexpected: true,
    })).toBeUndefined();
  });

  it('keeps a live invalidation fail closed until a current valid snapshot arrives', () => {
    const current = parseCompanionPreferences({
      ...DEFAULT_COMPANION_PREFERENCES,
      replicaReadScope: replicaReadScopeForProfile('full-visible'),
      readScopeSetupVersion: 1,
      settingsRevision: 8,
    });
    const invalid = selectLiveCompanionPreferenceChange(
      current,
      false,
      undefined,
    );
    expect(invalid).toMatchObject({
      preferences: current,
      failClosed: true,
      status: 'invalid',
    });

    const older = parseCompanionPreferences({
      ...current,
      settingsRevision: 7,
      targetLanguage: 'fr',
    });
    expect(selectLiveCompanionPreferenceChange(
      invalid.preferences,
      invalid.failClosed,
      older,
    )).toMatchObject({
      preferences: current,
      failClosed: true,
      status: 'stale',
    });

    expect(selectLiveCompanionPreferenceChange(
      invalid.preferences,
      invalid.failClosed,
      current,
    )).toMatchObject({
      preferences: current,
      failClosed: false,
      status: 'accepted',
    });
  });

  it('rejects same-revision live storage equivocation but accepts a newer commit', () => {
    const current = parseCompanionPreferences({
      ...DEFAULT_COMPANION_PREFERENCES,
      replicaReadScope: replicaReadScopeForProfile('standard'),
      readScopeSetupVersion: 1,
      settingsRevision: 4,
      targetLanguage: 'ja',
    });
    const equivocation = parseCompanionPreferences({
      ...current,
      targetLanguage: 'fr',
    });
    expect(selectLiveCompanionPreferenceChange(
      current,
      false,
      equivocation,
    )).toMatchObject({
      preferences: current,
      failClosed: true,
      status: 'invalid',
    });

    const newer = parseCompanionPreferences({
      ...equivocation,
      settingsRevision: 5,
    });
    expect(selectLiveCompanionPreferenceChange(
      current,
      true,
      newer,
    )).toMatchObject({
      preferences: newer,
      failClosed: false,
      status: 'accepted',
    });
  });

  it('fails closed instead of reusing an exhausted revision', () => {
    const settingsExhausted = parseCompanionPreferences({
      settingsRevision: Number.MAX_SAFE_INTEGER,
    });
    const resetExhausted = parseCompanionPreferences({
      resetRevision: Number.MAX_SAFE_INTEGER,
    });

    expect(() => advanceCompanionSettingsRevision(settingsExhausted)).toThrow(
      'Preference revision exhausted.',
    );
    expect(() => resetCompanionPreferences(resetExhausted)).toThrow(
      'Preference revision exhausted.',
    );
  });
});

describe('permission scope helpers', () => {
  it('normalizes ordinary page URLs and rejects restricted schemes', () => {
    expect(pageOrigin('https://example.com:8443/path?q=1')).toBe(
      'https://example.com:8443',
    );
    expect(
      sitePermissionPattern('https://example.com:8443/path'),
    ).toBeUndefined();
    expect(sitePermissionPattern('https://example.com/path')).toBe(
      'https://example.com/*',
    );
    expect(pageOrigin('chrome://extensions')).toBeUndefined();
    expect(pageOrigin('not a url')).toBeUndefined();
  });

  it('returns exact-site or exact all-sites optional permission patterns', () => {
    expect(permissionOriginsForMode('off', 'https://example.com')).toEqual([]);
    expect(permissionOriginsForMode('site', 'https://example.com/a')).toEqual([
      'https://example.com/*',
    ]);
    expect(permissionOriginsForMode('site', 'chrome://settings')).toEqual([]);
    expect(permissionOriginsForMode('all')).toEqual([
      ...ALL_SITES_PERMISSION_ORIGINS,
    ]);
    expect(ALL_SITES_PERMISSION_ORIGINS).toEqual(['<all_urls>']);
  });

  it('derives only the persisted preference scopes', () => {
    expect(
      permissionOriginsForPreferences({
        ...parseCompanionPreferences(undefined),
        autoTranslateAllSites: false,
        autoTranslateOrigins: [
          'https://one.example',
          'http://localhost:8080',
        ],
        displayMode: 'fit',
      }),
    ).toEqual(['https://one.example/*']);

    expect(
      permissionOriginsForPreferences({
        ...parseCompanionPreferences(undefined),
        autoTranslateAllSites: true,
        autoTranslateOrigins: ['https://one.example'],
        displayMode: 'fit',
      }),
    ).toEqual([...ALL_SITES_PERMISSION_ORIGINS]);
  });
});

describe('preference updates', () => {
  const initial: CompanionPreferences = {
    ...parseCompanionPreferences(undefined),
    autoTranslateAllSites: false,
    autoTranslateOrigins: ['https://other.example'],
    displayMode: 'fit' as const,
  };

  it('enables and disables only the current site while retaining other sites', () => {
    const enabled = withAutoTranslationMode(
      initial,
      'https://current.example/article',
      'site',
    );

    expect(enabled.autoTranslateOrigins).toEqual([
      'https://other.example',
      'https://current.example',
    ]);
    expect(autoTranslationModeForPage(enabled, 'https://current.example/x')).toBe(
      'site',
    );
    expect(isAutoTranslationEnabled(enabled, 'https://other.example')).toBe(
      true,
    );

    const disabled = withAutoTranslationMode(
      enabled,
      'https://current.example/elsewhere',
      'off',
    );
    expect(disabled.autoTranslateOrigins).toEqual(['https://other.example']);
    expect(autoTranslationModeForPage(disabled, 'https://current.example')).toBe(
      'off',
    );
  });

  it('handles global mode and cannot opt a restricted page into site mode', () => {
    const allSites = withAutoTranslationMode(initial, undefined, 'all');
    expect(autoTranslationModeForPage(allSites, 'https://any.example')).toBe(
      'all',
    );

    const restricted = withAutoTranslationMode(
      allSites,
      'chrome://extensions',
      'site',
    );
    expect(restricted).toEqual(initial);
  });

  it('updates display mode without mutating its input', () => {
    expect(withDisplayMode(initial, 'actual')).toEqual({
      ...initial,
      displayMode: 'actual',
    });
    expect(initial.displayMode).toBe('fit');
  });

  it('updates all saved view settings through the validated parser', () => {
    expect(
      withViewSettings(initial, {
        sourceLanguage: 'auto',
        targetLanguage: 'ja',
        displayMode: 'custom',
        zoomPercent: 175,
        syncScroll: false,
        textLayoutMode: 'faithful',
        replicaFidelityPolicy: 'conservative',
      }),
    ).toMatchObject({
      sourceLanguage: 'auto',
      targetLanguage: 'ja',
      displayMode: 'custom',
      zoomPercent: 175,
      syncScroll: false,
      textLayoutMode: 'faithful',
      replicaFidelityPolicy: 'conservative',
    });
  });

  it('refuses to add a site beyond the persisted-origin bound', () => {
    const full = {
      ...parseCompanionPreferences(undefined),
      autoTranslateAllSites: false,
      autoTranslateOrigins: Array.from(
        { length: 256 },
        (_value, index) => `https://site-${index}.example`,
      ),
      displayMode: 'fit' as const,
    };

    const unchanged = withAutoTranslationMode(
      full,
      'https://overflow.example/page',
      'site',
    );

    expect(unchanged.autoTranslateOrigins).toHaveLength(256);
    expect(
      autoTranslationModeForPage(unchanged, 'https://overflow.example'),
    ).toBe('off');
  });
});

/** What a dev build may have saved: every hidden setting off its default. */
function testerPreferences(): CompanionPreferences {
  const base = parseStoredCompanionPreferences({
    ...DEFAULT_COMPANION_PREFERENCES,
    targetLanguage: 'ja',
    textLayoutMode: 'faithful',
    launchBehavior: 'popout',
    ocrMinimumConfidence: 0.8,
    settingsRevision: 7,
  });
  return withImageAnalysisSettings(
    withViewSettings(base, {
      mirrorLimits: { itemMegabytes: 2, pageMegabytes: 5, maxElements: 5000 },
      mirrorShowEverything: true,
      replicaViewMode: 'source-only',
      replicaFidelityPolicy: 'conservative',
    }),
    {
      imageReadingMethodOrder: [...DEFAULT_COMPANION_PREFERENCES.imageReadingMethodOrder]
        .reverse(),
      disabledImageReadingMethodIds: ['tesseract'],
      imageScanPolicy: 'eager-all',
      skipSmallImages: false,
      usePromptForImageLanguage: true,
      usePromptForImageText: true,
    },
  );
}

describe('public edition preferences', () => {
  it('pins exactly the settings the public edition does not show', () => {
    expect(PUBLIC_EDITION_PINNED_PREFERENCE_KEYS).toEqual([
      'mirrorLimits',
      'mirrorShowEverything',
      'replicaViewMode',
      'replicaFidelityPolicy',
      'imageReadingMethodOrder',
      'disabledImageReadingMethodIds',
      'imageTextProviderOrder',
      'disabledImageTextProviderIds',
      'imageScanPolicy',
      'skipSmallImages',
      'usePromptForImageLanguage',
      'usePromptForImageText',
    ]);
  });

  it('reads every hidden setting as its default in the public edition', () => {
    const stored = testerPreferences();
    const shown = parseCompanionPreferences(stored, 'public');

    for (const key of PUBLIC_EDITION_PINNED_PREFERENCE_KEYS) {
      // The fixture really moved each one, so the pin is what restores it.
      expect(stored[key], key).not.toEqual(DEFAULT_COMPANION_PREFERENCES[key]);
      expect(shown[key], key).toEqual(DEFAULT_COMPANION_PREFERENCES[key]);
    }
    expect(shown.mirrorShowEverything).toBe(false);
  });

  it('keeps the settings the public edition shows', () => {
    const shown = parseCompanionPreferences(testerPreferences(), 'public');

    expect(shown).toMatchObject({
      targetLanguage: 'ja',
      textLayoutMode: 'faithful',
      launchBehavior: 'popout',
      ocrMinimumConfidence: 0.8,
      imageTranslationEnabled: true,
      syncScroll: true,
      settingsRevision: 7,
    });
  });

  it('passes every setting through unchanged in the dev edition', () => {
    const stored = testerPreferences();

    expect(parseCompanionPreferences(stored, 'dev')).toEqual(stored);
    expect(applyEditionToPreferences(stored, 'dev')).toBe(stored);
  });

  it.each([
    ['standard plus form values', { ...replicaReadScopeForProfile('standard'), formValues: true }, 'standard'],
    ['control labels and images only', { ...replicaReadScopeForProfile('page-only'), controlSemantics: true, controlImages: true }, 'page-only'],
    ['full visible without editable content', { ...replicaReadScopeForProfile('full-visible'), editableContent: false }, 'standard'],
    ['disclosures only', { ...replicaReadScopeForProfile('page-only'), disclosureContent: true }, 'page-only'],
    ['exactly Page only', replicaReadScopeForProfile('page-only'), 'page-only'],
    ['exactly Standard', replicaReadScopeForProfile('standard'), 'standard'],
    ['exactly Full visible', replicaReadScopeForProfile('full-visible'), 'full-visible'],
  ] as const)('reads a stored %s scope as the widest profile within it', (_case, scope, profile) => {
    const stored = parseStoredCompanionPreferences({
      ...DEFAULT_COMPANION_PREFERENCES,
      replicaReadScope: scope,
    });

    expect(parseCompanionPreferences(stored, 'public').replicaReadScope)
      .toEqual(replicaReadScopeForProfile(profile));
    // The dev edition keeps the custom scope exactly as stored.
    expect(parseCompanionPreferences(stored, 'dev').replicaReadScope).toEqual(scope);
  });

  it('counts first-run setup as done at the default profile in the public edition', () => {
    const neverSetUp = parseStoredCompanionPreferences({
      ...DEFAULT_COMPANION_PREFERENCES,
      replicaReadScope: replicaReadScopeForProfile('standard'),
      readScopeSetupVersion: 0,
    });

    expect(parseCompanionPreferences(neverSetUp, 'public')).toMatchObject({
      readScopeSetupVersion: REPLICA_READ_SCOPE_SETUP_VERSION,
      replicaReadScope: DEFAULT_REPLICA_READ_SCOPE,
    });
    expect(DEFAULT_COMPANION_PREFERENCES.replicaReadScope).toEqual(DEFAULT_REPLICA_READ_SCOPE);
    expect(parseCompanionPreferences(neverSetUp, 'dev').readScopeSetupVersion).toBe(0);
  });

  it('accepts what storage holds as valid and shows the public view of it', () => {
    const stored = testerPreferences();
    const raw = JSON.parse(JSON.stringify(stored)) as unknown;
    const shown = parseCompanionPreferences(stored, 'public');

    expect(readValidStoredCompanionPreferences(raw, 'public')).toEqual(shown);
    // The same revision arriving from storage is the same snapshot, not an
    // equivocation, although storage holds values the public view pins.
    expect(selectLiveCompanionPreferenceChange(shown, false, raw, 'public'))
      .toEqual({ preferences: shown, failClosed: false, status: 'accepted' });
    expect(parseStoredCompanionPreferences(raw)).toEqual(stored);
  });

  it('is a fixed point of both parses, so view patches keep it pinned', () => {
    const shown = parseCompanionPreferences(testerPreferences(), 'public');

    expect(applyEditionToPreferences(shown, 'public')).toBe(shown);
    expect(parseStoredCompanionPreferences({ ...shown })).toEqual(shown);
    expect(withViewSettings(shown, { textLayoutMode: 'adaptive' })).toEqual({
      ...shown,
      textLayoutMode: 'adaptive',
    });
  });
});

describe('default To language', () => {
  afterEach(() => {
    configureDefaultTargetLanguage(undefined);
  });

  it.each([
    ['ja', 'ja'],
    ['de-AT', 'de'],
    ['pt-BR', 'pt'],
    ['pt_PT', 'pt'],
    ['zh-TW', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'],
    ['zh-CN', 'zh'],
    ['nb', 'no'],
    ['es-419', 'es'],
    ['en-GB', 'en'],
    ['fil', 'en'],
    ['', 'en'],
    [undefined, 'en'],
  ] as const)('starts a fresh install for UI language %j at %s', (uiLanguage, expected) => {
    expect(defaultTargetLanguageForUiLanguage(uiLanguage)).toBe(expected);
    configureDefaultTargetLanguage(uiLanguage);
    expect(parseCompanionPreferences(undefined).targetLanguage).toBe(expected);
  });

  it('never replaces a saved To language', () => {
    configureDefaultTargetLanguage('fr-CA');
    const saved = { ...DEFAULT_COMPANION_PREFERENCES, targetLanguage: 'en' };

    expect(parseCompanionPreferences(saved).targetLanguage).toBe('en');
    expect(parseCompanionPreferences({ ...saved, targetLanguage: 'ko' }).targetLanguage)
      .toBe('ko');
    // Only a missing or unusable value takes the default.
    expect(parseCompanionPreferences({ ...saved, targetLanguage: undefined }).targetLanguage)
      .toBe('fr');
    expect(parseCompanionPreferences({ ...saved, targetLanguage: 'xx' }).targetLanguage)
      .toBe('fr');
  });

  it('starts a reset from the UI language too, like a fresh install', () => {
    configureDefaultTargetLanguage('it');
    const saved = parseCompanionPreferences({
      ...DEFAULT_COMPANION_PREFERENCES,
      targetLanguage: 'en',
    });

    expect(resetCompanionPreferences(saved).targetLanguage).toBe('it');
  });
});
