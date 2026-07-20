import { describe, expect, it } from 'vitest';

import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
  isNewerCompanionLaunchStamp,
  resolveCompanionLaunchSurface,
  sameCompanionSourcePage,
  shouldFollowActivatedTab,
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

  it('creates an identity-bound local URL without retaining stale parameters', () => {
    expect(createDetachedCompanionUrl(
      'chrome-extension://simul/sidepanel.html?old=1',
      { tabId: 17, windowId: 4, url: 'https://example.com/private' },
    )).toBe(
      'chrome-extension://simul/sidepanel.html?old=1&sourceTabId=17&sourceWindowId=4',
    );
  });

  it('matches exposed source-window bounds and remains a normal resizable popup', () => {
    expect(createDetachedWindowData('chrome-extension://simul/sidepanel.html', {
      width: 1440,
      height: 900,
      left: -1440,
      top: 0,
    })).toEqual({
      url: 'chrome-extension://simul/sidepanel.html',
      type: 'popup',
      focused: true,
      width: 1440,
      height: 900,
      left: -1440,
      top: 0,
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
});
