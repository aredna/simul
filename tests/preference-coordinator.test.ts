import { describe, expect, it } from 'vitest';

import {
  PreferenceCoordinator,
  readPreferenceCommand,
  readPreferenceCommandResult,
  type PreferenceCoordinatorAdapter,
} from '../lib/preference-coordinator';
import {
  ALL_SITES_PERMISSION_ORIGINS,
  DEFAULT_COMPANION_PREFERENCES,
  parseCompanionPreferences,
  permissionOriginsForMode,
  type CompanionPreferences,
} from '../lib/preferences';

describe('preference coordinator', () => {
  it('loads the current stored value for each serialized side-panel commit', async () => {
    const adapter = new MemoryPreferenceAdapter();
    adapter.grant(...permissionOriginsForMode('site', 'https://one.example/'));
    const coordinator = new PreferenceCoordinator(adapter);

    const first = await coordinator.run({
      type: 'simul:preferences:commit-auto',
      mode: 'site',
      pageUrl: 'https://one.example/page',
    });
    adapter.grant(...permissionOriginsForMode('site', 'https://two.example/'));
    const second = await coordinator.run({
      type: 'simul:preferences:commit-auto',
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
      mode: 'all',
      pageUrl: 'https://current.example/page',
    });

    expect(result.applied).toBe(true);
    expect(adapter.hasGrant('https://kept.example/*')).toBe(true);
  });

  it('removes partial wildcard and untracked exact grants during reconciliation', async () => {
    const adapter = new MemoryPreferenceAdapter({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: true,
      autoTranslateOrigins: ['https://kept.example'],
      displayMode: 'fit',
    });
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
    });
    expect(adapter.hasGrant('https://*/*')).toBe(false);
    expect(adapter.hasGrant('https://kept.example/*')).toBe(true);
    expect(adapter.hasGrant('https://orphan.example/*')).toBe(false);
  });

  it('merges display and automatic changes through one current stored value', async () => {
    const adapter = new MemoryPreferenceAdapter();
    adapter.grant('https://one.example/*');
    const coordinator = new PreferenceCoordinator(adapter);

    await Promise.all([
      coordinator.run({
        type: 'simul:preferences:set-display',
        displayMode: 'actual',
      }),
      coordinator.run({
        type: 'simul:preferences:commit-auto',
        mode: 'site',
        pageUrl: 'https://one.example/page',
      }),
    ]);

    expect(adapter.preferences).toEqual({
      ...parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
      autoTranslateAllSites: false,
      autoTranslateOrigins: ['https://one.example'],
      displayMode: 'actual',
    });
  });

  it('applies a validated companion-view patch without replacing other fields', async () => {
    const adapter = new MemoryPreferenceAdapter();
    const coordinator = new PreferenceCoordinator(adapter);

    const result = await coordinator.run({
      type: 'simul:preferences:patch-view',
      patch: {
        targetLanguage: 'ja',
        displayMode: 'custom',
        zoomPercent: 185,
      },
    });

    expect(result.applied).toBe(true);
    expect(adapter.preferences).toMatchObject({
      sourceLanguage: 'auto',
      targetLanguage: 'ja',
      displayMode: 'custom',
      zoomPercent: 185,
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
        patch: { displayMode: 'custom', zoomPercent: 165 },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-view',
        patch: { syncScroll: false },
      }),
      coordinator.run({
        type: 'simul:preferences:patch-view',
        patch: { textLayoutMode: 'faithful' },
      }),
    ]);

    expect(adapter.preferences).toMatchObject({
      displayMode: 'custom',
      zoomPercent: 165,
      syncScroll: false,
      textLayoutMode: 'faithful',
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
    ).toEqual({
      type: 'simul:preferences:commit-auto',
      mode: 'site',
      pageUrl: 'https://example.com/',
    });
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:commit-auto',
        mode: 'everything',
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        patch: {
          targetLanguage: 'ja',
          zoomPercent: 160,
          syncScroll: false,
        },
      }),
    ).toEqual({
      type: 'simul:preferences:patch-view',
      patch: {
        targetLanguage: 'ja',
        zoomPercent: 160,
        syncScroll: false,
      },
    });
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        patch: { targetLanguage: 'not-supported' },
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        patch: {},
      }),
    ).toBeUndefined();
    expect(
      readPreferenceCommand({
        type: 'simul:preferences:patch-view',
        patch: { syncScroll: true, unexpected: 'field' },
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
  private readonly grants = new Set<string>();

  constructor(initial?: CompanionPreferences) {
    this.preferences = parseCompanionPreferences(initial);
  }

  async load(): Promise<unknown> {
    return structuredClone(this.preferences);
  }

  async save(preferences: CompanionPreferences): Promise<void> {
    this.preferences = structuredClone(preferences);
  }

  async contains(origins: string[]): Promise<boolean> {
    return origins.every((origin) => this.isCovered(origin));
  }

  async getAllOrigins(): Promise<string[]> {
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
    if (origin.startsWith('http://')) {
      return this.grants.has('http://*/*');
    }
    if (origin.startsWith('https://')) {
      return this.grants.has('https://*/*');
    }
    return false;
  }
}
