import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { Currency } from '../entrypoints/sidepanel/currency';
import { SourceFollower, type FollowerBrowser } from '../entrypoints/sidepanel/source-follower';
import type { PageTabLike } from '../lib/page-identity';
import { withViewSettings } from '../lib/preferences';

interface Options {
  detached?: { tabId: number; windowId: number };
  popoutTabMode?: 'locked' | 'active';
  panelWindowId?: number;
  tabs?: PageTabLike[];
  windowTypes?: Record<number, string>;
}

function setup(options: Options = {}) {
  const tabs = new Map((options.tabs ?? []).map((tab) => [tab.id, tab]));
  const browser: FollowerBrowser = {
    getTab: vi.fn(async (tabId) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('No tab with id');
      return tab;
    }),
    queryActiveTab: vi.fn(async (windowId) =>
      [...tabs.values()].find((tab) => tab.active && (windowId === undefined || tab.windowId === windowId))),
    getWindow: vi.fn(async (windowId) => ({ id: windowId, type: options.windowTypes?.[windowId] ?? 'normal' })),
    getCurrentWindowId: vi.fn(async () => options.panelWindowId),
    getLastFocusedNormalWindowId: vi.fn(async () => 1),
    windowIdNone: -1,
  };
  const state = new CompanionState({
    isDetachedWindow: options.detached !== undefined,
    ...(options.detached ? { detachedSourceWindowId: options.detached.windowId } : {}),
  });
  state.panelWindowId = options.panelWindowId;
  if (options.popoutTabMode) {
    state.preferences = withViewSettings(state.preferences, { popoutTabMode: options.popoutTabMode });
  }
  const environment = {
    queueCapture: vi.fn(),
    invalidateCompanion: vi.fn(),
    onSourceNavigationStarted: vi.fn(),
    onFollowedTabActivated: vi.fn(),
    setStatus: vi.fn(),
    renderError: vi.fn(),
    updateControls: vi.fn(),
  };
  const currency = new Currency();
  const follower = new SourceFollower({
    state,
    currency,
    browser,
    detachedIdentityHint: options.detached,
    navigationDebounceMs: 350,
    ...environment,
  });
  return { follower, state, currency, browser, tabs, ...environment };
}

const page = (id: number, windowId: number, url: string, active = true): PageTabLike =>
  ({ id, windowId, url, active });

describe('SourceFollower in the side panel', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the active tab of the current window on start', async () => {
    const harness = setup({ panelWindowId: 1, tabs: [page(4, 1, 'https://a.example/')] });
    await harness.follower.initializeSourcePage();
    expect(harness.state.followedPageIdentity).toEqual({ tabId: 4, windowId: 1, url: 'https://a.example/' });
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 4, windowId: 1, url: 'https://a.example/' },
      reason: 'initial',
    });
  });

  it('shows the access error when no readable page is active', async () => {
    const harness = setup({ panelWindowId: 1, tabs: [page(4, 1, 'chrome://extensions')] });
    await harness.follower.refreshFollowedPage('manual');
    expect(harness.queueCapture).not.toHaveBeenCalled();
    expect(harness.renderError).toHaveBeenCalled();
    expect(harness.setStatus).toHaveBeenCalledWith(expect.stringContaining('Open a regular HTTP'), 'error');
  });

  it('invalidates when another tab in the same window becomes active', () => {
    const harness = setup({ panelWindowId: 1 });
    harness.state.followedPageIdentity = { tabId: 4, windowId: 1, url: 'https://a.example/' };
    const pending = harness.currency.begin('identity');
    harness.follower.handleTabActivated(5, 1);
    expect(harness.currency.isCurrent(pending)).toBe(false);
    expect(harness.state.followedPageIdentity).toBeUndefined();
    expect(harness.invalidateCompanion).toHaveBeenCalledWith(expect.stringContaining('The active tab changed'));
  });

  it('resumes deferred image work when the followed tab is activated again', () => {
    const harness = setup({ panelWindowId: 1 });
    harness.state.followedPageIdentity = { tabId: 4, windowId: 1, url: 'https://a.example/' };
    harness.follower.handleTabActivated(4, 1);
    expect(harness.onFollowedTabActivated).toHaveBeenCalled();
    expect(harness.invalidateCompanion).not.toHaveBeenCalled();
  });

  it('accepts a toolbar authorization only for its own window and newest launch', async () => {
    const harness = setup({ panelWindowId: 1 });
    await harness.follower.acceptAuthorizedTab({
      identity: { tabId: 7, windowId: 2, url: 'https://b.example/' },
    });
    expect(harness.queueCapture).not.toHaveBeenCalled();

    await harness.follower.acceptAuthorizedTab({
      identity: { tabId: 7, windowId: 1, url: 'https://b.example/' },
      launchStamp: { epoch: 'e', sequence: 2 },
    });
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 7, windowId: 1, url: 'https://b.example/' },
      reason: 'authorized',
    });
    await harness.follower.acceptAuthorizedTab({
      identity: { tabId: 8, windowId: 1, url: 'https://c.example/' },
      launchStamp: { epoch: 'e', sequence: 1 },
    });
    expect(harness.queueCapture).toHaveBeenCalledTimes(1);
  });

  it('keeps the page on a same-document URL change and rebuilds after a load', () => {
    const harness = setup({ panelWindowId: 1 });
    const identity = { tabId: 4, windowId: 1, url: 'https://a.example/page' };
    harness.state.followedPageIdentity = identity;
    harness.state.capturedPageIdentity = identity;

    harness.follower.handleTabUpdated(4, { url: 'https://a.example/page#section' }, { windowId: 1 });
    expect(harness.onSourceNavigationStarted).not.toHaveBeenCalled();
    expect(harness.state.followedPageIdentity?.url).toBe('https://a.example/page#section');
    expect(harness.state.capturedPageIdentity?.url).toBe('https://a.example/page#section');
    expect(harness.follower.navigationRefreshPending).toBe(false);

    harness.follower.handleTabUpdated(4, { status: 'loading', url: 'https://a.example/next' }, { windowId: 1 });
    expect(harness.onSourceNavigationStarted).toHaveBeenCalledTimes(1);
    expect(harness.state.followedPageIdentity?.url).toBe('https://a.example/next');
    expect(harness.setStatus).toHaveBeenCalledWith(expect.stringContaining('The source page is changing'));

    harness.follower.handleTabUpdated(4, { status: 'complete' }, { windowId: 1, url: 'https://a.example/next' });
    expect(harness.follower.navigationRefreshPending).toBe(true);
    vi.advanceTimersByTime(349);
    expect(harness.queueCapture).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 4, windowId: 1, url: 'https://a.example/next' },
      reason: 'navigation',
    });
  });

  it('invalidates when the followed tab opens a restricted page or closes', () => {
    const harness = setup({ panelWindowId: 1 });
    harness.state.followedPageIdentity = { tabId: 4, windowId: 1, url: 'https://a.example/' };
    harness.follower.handleTabUpdated(4, { status: 'loading', url: 'chrome://settings' }, { windowId: 1 });
    expect(harness.invalidateCompanion).toHaveBeenCalledWith(expect.stringContaining('restricted page'));
    harness.follower.handleTabRemoved(4);
    expect(harness.invalidateCompanion).toHaveBeenCalledWith('The source tab was closed.');
  });
});

describe('SourceFollower in a detached window', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('follows the opening tab in locked mode even when it is not active', async () => {
    const harness = setup({
      detached: { tabId: 4, windowId: 1 },
      panelWindowId: 9,
      tabs: [page(4, 1, 'https://a.example/', false)],
    });
    await harness.follower.initializeSourcePage();
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 4, windowId: 1, url: 'https://a.example/' },
      reason: 'initial',
    });
  });

  it('ignores toolbar authorizations for other tabs while locked', async () => {
    const harness = setup({ detached: { tabId: 4, windowId: 1 }, panelWindowId: 9 });
    await harness.follower.acceptAuthorizedTab({
      identity: { tabId: 5, windowId: 1, url: 'https://b.example/' },
    });
    expect(harness.queueCapture).not.toHaveBeenCalled();
  });

  it('follows a newly activated tab in active mode and skips its own window', async () => {
    const harness = setup({
      detached: { tabId: 4, windowId: 1 },
      popoutTabMode: 'active',
      panelWindowId: 9,
      tabs: [page(6, 2, 'https://c.example/')],
    });
    harness.follower.handleTabActivated(6, 9);
    await vi.runAllTimersAsync();
    expect(harness.queueCapture).not.toHaveBeenCalled();

    harness.follower.handleTabActivated(6, 2);
    await vi.runAllTimersAsync();
    expect(harness.state.detachedSourceWindowId).toBe(2);
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 6, windowId: 2, url: 'https://c.example/' },
      reason: 'navigation',
    });
  });

  it('rebuilds a stale replica when the same tab is re-activated after a missed refresh', async () => {
    const harness = setup({
      detached: { tabId: 4, windowId: 1 },
      popoutTabMode: 'active',
      panelWindowId: 9,
      tabs: [page(4, 1, 'https://a.example/new')],
    });
    harness.state.followedPageIdentity = { tabId: 4, windowId: 1, url: 'https://a.example/new' };
    harness.state.capturedPageIdentity = { tabId: 4, windowId: 1, url: 'https://a.example/old' };
    harness.follower.handleTabActivated(4, 1);
    await vi.runAllTimersAsync();
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 4, windowId: 1, url: 'https://a.example/new' },
      reason: 'navigation',
    });
  });

  it('leaves the navigation refresh armed while focus moves between windows', async () => {
    const harness = setup({
      detached: { tabId: 4, windowId: 1 },
      popoutTabMode: 'active',
      panelWindowId: 9,
      tabs: [page(4, 1, 'https://a.example/next')],
    });
    harness.state.followedPageIdentity = { tabId: 4, windowId: 1, url: 'https://a.example/next' };
    harness.follower.handleTabUpdated(4, { status: 'complete' }, { windowId: 1, url: 'https://a.example/next' });
    expect(harness.follower.navigationRefreshPending).toBe(true);
    harness.follower.handleWindowFocusChanged(1);
    expect(harness.follower.navigationRefreshPending).toBe(true);
    await vi.advanceTimersByTimeAsync(350);
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 4, windowId: 1, url: 'https://a.example/next' },
      reason: 'navigation',
    });
  });

  it('drops a slow window lookup that a newer tab event superseded', async () => {
    let releaseWindow!: () => void;
    const harness = setup({
      detached: { tabId: 4, windowId: 1 },
      popoutTabMode: 'active',
      panelWindowId: 9,
      tabs: [page(6, 2, 'https://c.example/'), page(7, 3, 'https://d.example/')],
    });
    const getWindow = harness.browser.getWindow as ReturnType<typeof vi.fn>;
    getWindow.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseWindow = () => resolve({ id: 2, type: 'normal' });
      }),
    );
    harness.follower.handleTabActivated(6, 2);
    harness.follower.handleTabActivated(7, 3);
    await vi.runAllTimersAsync();
    releaseWindow();
    await vi.runAllTimersAsync();
    expect(harness.queueCapture).toHaveBeenCalledTimes(1);
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 7, windowId: 3, url: 'https://d.example/' },
      reason: 'navigation',
    });
  });

  it('follows the locked tab into a new window when it is moved', async () => {
    const harness = setup({
      detached: { tabId: 4, windowId: 1 },
      panelWindowId: 9,
      tabs: [page(4, 5, 'https://a.example/', false)],
    });
    harness.state.followedPageIdentity = { tabId: 4, windowId: 1, url: 'https://a.example/' };
    harness.follower.handleTabAttached(4, 5);
    await vi.runAllTimersAsync();
    expect(harness.state.detachedSourceWindowId).toBe(5);
    expect(harness.queueCapture).toHaveBeenCalledWith({
      identity: { tabId: 4, windowId: 5, url: 'https://a.example/' },
      reason: 'navigation',
    });
  });
});
