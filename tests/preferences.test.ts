import { describe, expect, it } from 'vitest';

import {
  ALL_SITES_PERMISSION_ORIGINS,
  DEFAULT_COMPANION_PREFERENCES,
  autoTranslationModeForPage,
  isAutoTranslationEnabled,
  pageOrigin,
  parseCompanionPreferences,
  permissionOriginsForMode,
  permissionOriginsForPreferences,
  sitePermissionPattern,
  withAutoTranslationMode,
  withDisplayMode,
} from '../lib/preferences';

describe('parseCompanionPreferences', () => {
  it('uses privacy-preserving defaults for absent or invalid data', () => {
    expect(parseCompanionPreferences(undefined)).toEqual({
      autoTranslateAllSites: false,
      autoTranslateOrigins: [],
      displayMode: 'fit',
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
  });

  it('derives only the persisted preference scopes', () => {
    expect(
      permissionOriginsForPreferences({
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
        autoTranslateAllSites: true,
        autoTranslateOrigins: ['https://one.example'],
        displayMode: 'fit',
      }),
    ).toEqual([...ALL_SITES_PERMISSION_ORIGINS]);
  });
});

describe('preference updates', () => {
  const initial = {
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

  it('refuses to add a site beyond the persisted-origin bound', () => {
    const full = {
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
