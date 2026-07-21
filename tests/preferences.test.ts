import { describe, expect, it } from 'vitest';

import {
  ALL_SITES_PERMISSION_ORIGINS,
  DEFAULT_COMPANION_PREFERENCES,
  autoTranslationModeForPage,
  clampZoomPercent,
  isAutoTranslationEnabled,
  pageOrigin,
  parseCompanionPreferences,
  permissionOriginsForMode,
  permissionOriginsForPreferences,
  sitePermissionPattern,
  withAutoTranslationMode,
  withDisplayMode,
  withViewSettings,
  type CompanionPreferences,
} from '../lib/preferences';
import {
  isReplicaFidelityPolicy,
  isSelectableReplicaFidelityPolicy,
} from '../lib/replica/fidelity-policy';

describe('parseCompanionPreferences', () => {
  it('uses privacy-preserving defaults for absent or invalid data', () => {
    expect(parseCompanionPreferences(undefined)).toEqual({
      autoTranslateAllSites: false,
      autoTranslateOrigins: [],
      displayMode: 'fit',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      zoomPercent: 100,
      syncScroll: true,
      textLayoutMode: 'adaptive',
      replicaEngine: 'isolated-html',
      replicaFidelityPolicy: 'passive',
      replicaViewMode: 'translated',
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'locked',
      imageTranslationEnabled: false,
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'paddleocr-wasm',
        'chromium-screen-ai',
      ],
      imageScanPolicy: 'visible-first-background-prescan',
      skipSmallImages: true,
      usePromptForImageLanguage: false,
      usePromptForImageText: false,
    });
    expect(parseCompanionPreferences('all')).toEqual(
      DEFAULT_COMPANION_PREFERENCES,
    );
    expect(parseCompanionPreferences({
      autoTranslateAllSites: 'yes',
      displayMode: 'giant',
    })).toEqual({
      autoTranslateAllSites: false,
      autoTranslateOrigins: [],
      displayMode: 'fit',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      zoomPercent: 100,
      syncScroll: true,
      textLayoutMode: 'adaptive',
      replicaEngine: 'isolated-html',
      replicaFidelityPolicy: 'passive',
      replicaViewMode: 'translated',
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'locked',
      imageTranslationEnabled: false,
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'paddleocr-wasm',
        'chromium-screen-ai',
      ],
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
      displayMode: 'actual',
      sourceLanguage: 'auto',
      targetLanguage: 'en',
      zoomPercent: 100,
      syncScroll: true,
      textLayoutMode: 'adaptive',
      replicaEngine: 'isolated-html',
      replicaFidelityPolicy: 'passive',
      replicaViewMode: 'translated',
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'locked',
      imageTranslationEnabled: false,
      imageTextProviderOrder: [
        'chrome-text-detector',
        'tesseract',
        'transformers',
        'paddleocr-wasm',
        'chromium-screen-ai',
      ],
      imageScanPolicy: 'visible-first-background-prescan',
      skipSmallImages: true,
      usePromptForImageLanguage: false,
      usePromptForImageText: false,
    });
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
      popoutTabMode: 'active',
    })).toMatchObject({
      launchBehavior: 'popout',
      lastLaunchSurface: 'popout',
      popoutTabMode: 'active',
    });
    expect(parseCompanionPreferences({
      launchBehavior: 'chooser',
      lastLaunchSurface: 'panel',
      popoutTabMode: 'all-windows',
    })).toMatchObject({
      launchBehavior: 'last-used',
      lastLaunchSurface: 'side-panel',
      popoutTabMode: 'locked',
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
    const rawOrder = ['paddleocr-wasm', 'unknown', 'paddleocr-wasm', 'tesseract'];
    const parsed = parseCompanionPreferences({
      imageTranslationEnabled: true,
      imageTextProviderOrder: rawOrder,
      imageScanPolicy: 'visible-only',
      skipSmallImages: false,
      usePromptForImageLanguage: true,
      usePromptForImageText: true,
    });

    expect(parsed).toMatchObject({
      imageTranslationEnabled: true,
      imageTextProviderOrder: [
        'paddleocr-wasm',
        'tesseract',
        'chrome-text-detector',
        'transformers',
        'chromium-screen-ai',
      ],
      imageScanPolicy: 'visible-only',
      skipSmallImages: false,
      usePromptForImageLanguage: true,
      usePromptForImageText: true,
    });
    parsed.imageTextProviderOrder.reverse();
    expect(rawOrder).toEqual([
      'paddleocr-wasm',
      'unknown',
      'paddleocr-wasm',
      'tesseract',
    ]);
    expect(parseCompanionPreferences(undefined).imageTextProviderOrder).toEqual([
      'chrome-text-detector',
      'tesseract',
      'transformers',
      'paddleocr-wasm',
      'chromium-screen-ai',
    ]);
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
