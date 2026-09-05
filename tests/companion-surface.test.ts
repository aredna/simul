import { describe, expect, it } from 'vitest';

import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
  isFocusedNormalBrowserWindow,
  allocateCompanionLaunchGeneration,
  createCompanionLaunchEpoch,
  isNewerCompanionLaunchStamp,
  readCompanionLaunchEpochGeneration,
  resolveCompanionLaunchSurface,
  sameCompanionSourcePage,
  shouldFollowActivatedTab,
  shouldIgnoreInactiveFollowedTabUpdate,
  shouldCloseStalePreopenedSidePanel,
  shouldPreopenSidePanel,
  shouldRecoverRemovedActiveSource,
  shouldReuseDetachedWindow,
} from '../lib/companion-surface';

describe('companion surface launch decisions', () => {
  it('uses the last surface by default and honors explicit launch routes', () => {
    expect(resolveCompanionLaunchSurface({
      launchBehavior: 'last-used',
      lastLaunchSurface: 'popout',
    })).toBe('popout');
    expect(resolveCompanionLaunchSurface({
      launchBehavior: 'side-panel',
      lastLaunchSurface: 'popout',
    })).toBe('side-panel');
    expect(resolveCompanionLaunchSurface({
      launchBehavior: 'popout',
      lastLaunchSurface: 'side-panel',
    })).toBe('popout');
  });

  it('preopens a side panel only while launch preferences are unknown or select it', () => {
    const popout = {
      launchBehavior: 'popout' as const,
      lastLaunchSurface: 'side-panel' as const,
    };
    expect(shouldPreopenSidePanel(popout, false)).toBe(true);
    expect(shouldPreopenSidePanel(popout, true)).toBe(false);
    expect(shouldPreopenSidePanel({
      launchBehavior: 'side-panel',
      lastLaunchSurface: 'popout',
    }, true)).toBe(true);
    expect(shouldPreopenSidePanel({
      launchBehavior: 'last-used',
      lastLaunchSurface: 'popout',
    }, true)).toBe(false);
  });

  it('closes only superseded eager panels from a different window', () => {
    expect(shouldCloseStalePreopenedSidePanel(1, 2, 4, 8, true)).toBe(true);
    expect(shouldCloseStalePreopenedSidePanel(1, 2, 4, 4, true)).toBe(false);
    expect(shouldCloseStalePreopenedSidePanel(2, 2, 4, 8, true)).toBe(false);
    expect(shouldCloseStalePreopenedSidePanel(1, 2, 4, 8, false)).toBe(false);
    expect(shouldCloseStalePreopenedSidePanel(
      1,
      2,
      undefined,
      8,
      true,
    )).toBe(false);
  });

  it('reuses an open detached window for any tab in active mode and only its own tab when locked', () => {
    expect(shouldReuseDetachedWindow('active', 17, 17)).toBe(true);
    expect(shouldReuseDetachedWindow('active', 17, 42)).toBe(true);
    expect(shouldReuseDetachedWindow('locked', 17, 17)).toBe(true);
    expect(shouldReuseDetachedWindow('locked', 17, 42)).toBe(false);
    expect(shouldReuseDetachedWindow('active', undefined, 17)).toBe(false);
    expect(shouldReuseDetachedWindow('locked', undefined, 17)).toBe(false);
  });

  it('creates an identity-bound local URL without retaining stale parameters', () => {
    expect(createDetachedCompanionUrl(
      'chrome-extension://simul/sidepanel.html?old=1',
      { tabId: 17, windowId: 4, url: 'https://example.com/private' },
    )).toBe(
      'chrome-extension://simul/sidepanel.html?old=1&sourceTabId=17&sourceWindowId=4',
    );
  });

  it('docks to the right edge of the source window and remains a normal resizable popup', () => {
    // 45% of the source width: 1440 * 0.45 = 648, left = -1440 + 1440 - 648.
    expect(createDetachedWindowData('chrome-extension://simul/sidepanel.html', {
      width: 1440,
      height: 900,
      left: -1440,
      top: 0,
    })).toEqual({
      url: 'chrome-extension://simul/sidepanel.html',
      type: 'popup',
      focused: true,
      width: 648,
      height: 900,
      left: -648,
      top: 0,
    });
    // Narrow sources keep a usable minimum width but never exceed the source.
    expect(createDetachedWindowData('chrome-extension://simul/sidepanel.html', {
      width: 800,
      height: 600,
      left: 100,
      top: 50,
    })).toMatchObject({ width: 480, height: 600, left: 420, top: 50 });
    expect(createDetachedWindowData('chrome-extension://simul/sidepanel.html', {
      width: 400,
      height: 600,
      left: 100,
    })).toMatchObject({ width: 400, left: 100 });
    // Without a source left edge there is nothing to dock against.
    expect(createDetachedWindowData('chrome-extension://simul/sidepanel.html', {
      width: 1000,
      height: 600,
      top: 20,
    })).toEqual({
      url: 'chrome-extension://simul/sidepanel.html',
      type: 'popup',
      focused: true,
      width: 480,
      height: 600,
      top: 20,
    });
    expect(createDetachedWindowData('chrome-extension://simul/sidepanel.html', {
      width: 0,
      height: Number.NaN,
      left: 1.5,
    }, { width: 720, height: 800 })).toEqual({
      url: 'chrome-extension://simul/sidepanel.html',
      type: 'popup',
      focused: true,
      width: 720,
      height: 800,
    });
  });

  it('follows activation only for opted-in detached windows outside the companion window', () => {
    expect(shouldFollowActivatedTab(true, 'active', 9, 4)).toBe(true);
    expect(shouldFollowActivatedTab(true, 'locked', 9, 4)).toBe(false);
    expect(shouldFollowActivatedTab(false, 'active', 9, 4)).toBe(false);
    expect(shouldFollowActivatedTab(true, 'active', 9, 9)).toBe(false);
  });

  it('accepts follow candidates only from the focused normal browser window', () => {
    expect(isFocusedNormalBrowserWindow({ type: 'normal', focused: true }))
      .toBe(true);
    expect(isFocusedNormalBrowserWindow({ type: 'normal', focused: false }))
      .toBe(false);
    expect(isFocusedNormalBrowserWindow({ type: 'popup', focused: true }))
      .toBe(false);
    expect(isFocusedNormalBrowserWindow({})).toBe(true);
  });

  it('ignores stale updates from the tab being left only in active-follow mode', () => {
    expect(shouldIgnoreInactiveFollowedTabUpdate(true, 'active', false)).toBe(
      true,
    );
    expect(shouldIgnoreInactiveFollowedTabUpdate(true, 'active', true)).toBe(
      false,
    );
    expect(shouldIgnoreInactiveFollowedTabUpdate(true, 'locked', false)).toBe(
      false,
    );
    expect(shouldIgnoreInactiveFollowedTabUpdate(false, 'active', false)).toBe(
      false,
    );
    expect(shouldIgnoreInactiveFollowedTabUpdate(
      true,
      'active',
      true,
      true,
    )).toBe(true);
    expect(shouldIgnoreInactiveFollowedTabUpdate(
      true,
      'locked',
      true,
      true,
    )).toBe(false);
  });

  it('reacquires a neighboring tab after the active source closes', () => {
    expect(shouldRecoverRemovedActiveSource(
      true,
      'active',
      9,
      4,
      false,
    )).toBe(true);
    expect(shouldRecoverRemovedActiveSource(
      true,
      'locked',
      9,
      4,
      false,
    )).toBe(false);
    expect(shouldRecoverRemovedActiveSource(
      true,
      'active',
      9,
      4,
      true,
    )).toBe(false);
    expect(shouldRecoverRemovedActiveSource(
      true,
      'active',
      9,
      9,
      false,
    )).toBe(false);
  });

  it('treats a moved tab as a new exact source identity', () => {
    const source = { tabId: 3, windowId: 7, url: 'https://example.test/#one' };
    expect(sameCompanionSourcePage(
      source,
      { ...source, url: 'https://example.test/#two' },
      (url) => url.split('#')[0] ?? url,
    )).toBe(true);
    expect(sameCompanionSourcePage(
      source,
      { ...source, windowId: 8 },
      (url) => url.split('#')[0] ?? url,
    )).toBe(false);
  });

  it('orders toolbar authorization by click-time sequence within a worker epoch', () => {
    expect(isNewerCompanionLaunchStamp(undefined, {
      epoch: 'worker-a',
      sequence: 2,
    })).toBe(true);
    expect(isNewerCompanionLaunchStamp({
      epoch: 'worker-a',
      sequence: 2,
    }, {
      epoch: 'worker-a',
      sequence: 1,
    })).toBe(false);
    expect(isNewerCompanionLaunchStamp({
      epoch: 'worker-a',
      sequence: 2,
    }, {
      epoch: 'worker-b',
      sequence: 1,
    })).toBe(true);
  });

  it('orders launch epochs by their persisted generation across worker lifecycles', () => {
    const older = createCompanionLaunchEpoch(41, 'nonce-a');
    const newer = createCompanionLaunchEpoch(42, 'nonce-b');
    expect(readCompanionLaunchEpochGeneration(older)).toBe(41);
    expect(readCompanionLaunchEpochGeneration('worker-a')).toBeUndefined();
    expect(readCompanionLaunchEpochGeneration('0.nonce')).toBeUndefined();
    expect(readCompanionLaunchEpochGeneration('99999999999999999.nonce'))
      .toBeUndefined();

    // A delayed message from the older lifecycle no longer supersedes the
    // newer one, whatever its click sequence.
    expect(isNewerCompanionLaunchStamp(
      { epoch: newer, sequence: 1 },
      { epoch: older, sequence: 7 },
    )).toBe(false);
    expect(isNewerCompanionLaunchStamp(
      { epoch: older, sequence: 7 },
      { epoch: newer, sequence: 1 },
    )).toBe(true);
    expect(isNewerCompanionLaunchStamp(
      { epoch: newer, sequence: 2 },
      { epoch: newer, sequence: 1 },
    )).toBe(false);
    expect(isNewerCompanionLaunchStamp(undefined, { epoch: newer, sequence: 0 }))
      .toBe(false);

    // Two lifecycles that read the same persisted generation, or an older
    // build's bare UUID, have no shared order and keep the previous rule.
    expect(isNewerCompanionLaunchStamp(
      { epoch: createCompanionLaunchEpoch(42, 'nonce-a'), sequence: 5 },
      { epoch: createCompanionLaunchEpoch(42, 'nonce-b'), sequence: 1 },
    )).toBe(true);
    expect(isNewerCompanionLaunchStamp(
      { epoch: 'legacy-uuid', sequence: 5 },
      { epoch: newer, sequence: 1 },
    )).toBe(true);
    expect(isNewerCompanionLaunchStamp(
      { epoch: newer, sequence: 5 },
      { epoch: 'legacy-uuid', sequence: 1 },
    )).toBe(true);
  });

  it('allocates a generation above the persisted one and never below the clock', async () => {
    let stored: unknown;
    const store = {
      read: async () => stored,
      write: async (generation: number) => {
        stored = generation;
      },
    };
    await expect(allocateCompanionLaunchGeneration(store, () => 1_000))
      .resolves.toBe(1_000);
    expect(stored).toBe(1_000);
    // Clock rollback: the persisted generation still advances.
    await expect(allocateCompanionLaunchGeneration(store, () => 900))
      .resolves.toBe(1_001);
    // Clock ahead: the clock wins, so a later lifecycle without storage still
    // orders after this one.
    await expect(allocateCompanionLaunchGeneration(store, () => 5_000))
      .resolves.toBe(5_000);
    expect(stored).toBe(5_000);
    // A corrupt persisted value falls back to the clock.
    stored = 'not a number';
    await expect(allocateCompanionLaunchGeneration(store, () => 6_000))
      .resolves.toBe(6_000);
  });

  it('degrades to clock order when session storage is unavailable', async () => {
    const failing = {
      read: async (): Promise<unknown> => {
        throw new Error('no session storage');
      },
      write: async () => {
        throw new Error('no session storage');
      },
    };
    await expect(allocateCompanionLaunchGeneration(failing, () => 7_000))
      .resolves.toBe(7_000);
    await expect(allocateCompanionLaunchGeneration(failing, () => Number.NaN))
      .resolves.toBe(1);
  });
});
