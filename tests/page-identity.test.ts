import { describe, expect, it, vi } from 'vitest';

import {
  PAGE_ACCESS_GUIDANCE,
  PAGE_ACCESS_LOST_GUIDANCE,
  PAGE_CHANGED_GUIDANCE,
  PageAccessError,
  assertSourceTabIsCurrent,
  hasNonDefaultPort,
  identityFromTab,
  isSamePageIdentity,
  isSupportedPage,
  navigationPageIdentityKey,
  navigationPageScopeKey,
  normalizedPageUrl,
  parseDetachedPageIdentityHint,
  readAuthorizedTabMessage,
  readPageError,
  readableError,
  withPageTimeout,
} from '../lib/page-identity';

describe('parseDetachedPageIdentityHint', () => {
  it('keeps the query-free native side panel in native mode', () => {
    expect(parseDetachedPageIdentityHint('')).toBeUndefined();
    expect(parseDetachedPageIdentityHint('?unrelated=1')).toBeUndefined();
  });

  it('accepts only an explicit safe tab and window identity', () => {
    expect(
      parseDetachedPageIdentityHint('?sourceTabId=17&sourceWindowId=4'),
    ).toEqual({ tabId: 17, windowId: 4 });
    expect(
      parseDetachedPageIdentityHint('?sourceTabId=&sourceWindowId=4'),
    ).toBeUndefined();
    expect(
      parseDetachedPageIdentityHint('?sourceTabId=17&sourceWindowId=4.5'),
    ).toBeUndefined();
  });
});

describe('isSamePageIdentity', () => {
  const captured = {
    tabId: 7,
    windowId: 3,
    url: 'https://example.com/page?version=1',
  };

  it('requires an exact tab, window, and URL match', () => {
    expect(isSamePageIdentity(captured, {
      id: 7,
      windowId: 3,
      url: captured.url,
    })).toBe(true);
    expect(isSamePageIdentity(captured, {
      id: 7,
      windowId: 3,
      url: 'https://example.com/page?version=2',
    })).toBe(false);
    expect(isSamePageIdentity(captured, {
      id: 8,
      windowId: 3,
      url: captured.url,
    })).toBe(false);
    expect(isSamePageIdentity(captured, {
      id: 7,
      windowId: 4,
      url: captured.url,
    })).toBe(false);
  });

  it('treats a missing current URL as stale', () => {
    expect(isSamePageIdentity(captured, { id: 7, windowId: 3 })).toBe(false);
  });
});

describe('identityFromTab', () => {
  const tab = { id: 7, windowId: 3, url: 'https://example.com/a', active: true };

  it('reads the tab, window and URL of an active supported tab', () => {
    expect(identityFromTab(tab)).toEqual({
      tabId: 7,
      windowId: 3,
      url: 'https://example.com/a',
    });
  });

  it('falls back to the followed URL when the tab hides its own', () => {
    expect(identityFromTab({ id: 7, windowId: 3, active: true }, 'https://example.com/b'))
      .toEqual({ tabId: 7, windowId: 3, url: 'https://example.com/b' });
  });

  it('rejects inactive, restricted and incomplete tabs with page-access guidance', () => {
    expect(() => identityFromTab({ ...tab, active: false })).toThrow(PageAccessError);
    expect(() => identityFromTab({ ...tab, url: 'chrome://extensions' }))
      .toThrow(PAGE_ACCESS_GUIDANCE);
    expect(() => identityFromTab({ ...tab, id: undefined })).toThrow(PageAccessError);
    expect(() => identityFromTab({ ...tab, windowId: undefined })).toThrow(PageAccessError);
    expect(() => identityFromTab(undefined)).toThrow(PageAccessError);
    // A locked detached window follows its tab whether or not it is active.
    expect(identityFromTab({ ...tab, active: false }, undefined, false).tabId).toBe(7);
  });
});

describe('assertSourceTabIsCurrent', () => {
  const identity = { tabId: 7, windowId: 3, url: 'https://example.com/a' };

  it('passes for the exact tab and requires activity only when asked', () => {
    const current = { id: 7, windowId: 3, url: identity.url, active: true };
    expect(() => assertSourceTabIsCurrent(current, identity, true)).not.toThrow();
    expect(() => assertSourceTabIsCurrent({ ...current, active: false }, identity, false))
      .not.toThrow();
    expect(() => assertSourceTabIsCurrent({ ...current, active: false }, identity, true))
      .toThrow(PAGE_CHANGED_GUIDANCE);
  });

  it('fails when the tab navigated or its URL is no longer readable', () => {
    expect(() => assertSourceTabIsCurrent(
      { id: 7, windowId: 3, url: 'https://example.com/b', active: true },
      identity,
      true,
    )).toThrow(PageAccessError);
    expect(() => assertSourceTabIsCurrent({ id: 7, windowId: 3, active: true }, identity, true))
      .toThrow(PageAccessError);
  });
});

describe('readAuthorizedTabMessage', () => {
  const message = {
    type: 'simul:authorized-tab',
    tabId: 7,
    windowId: 3,
    url: 'https://example.com/a',
  };

  it('accepts a well-formed message with or without a launch stamp', () => {
    expect(readAuthorizedTabMessage(message)).toEqual({
      identity: { tabId: 7, windowId: 3, url: 'https://example.com/a' },
    });
    expect(readAuthorizedTabMessage({ ...message, launchEpoch: 'e1', launchSequence: 2 }))
      .toEqual({
        identity: { tabId: 7, windowId: 3, url: 'https://example.com/a' },
        launchStamp: { epoch: 'e1', sequence: 2 },
      });
  });

  it('rejects other messages, restricted URLs and malformed stamps', () => {
    expect(readAuthorizedTabMessage(undefined)).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...message, type: 'other' })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...message, url: 'chrome://newtab' })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...message, tabId: -1 })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...message, tabId: 1.5 })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...message, launchEpoch: 'e1' })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...message, launchEpoch: '', launchSequence: 1 }))
      .toBeUndefined();
    expect(readAuthorizedTabMessage({ ...message, launchEpoch: 'e1', launchSequence: 0 }))
      .toBeUndefined();
    expect(readAuthorizedTabMessage({
      ...message,
      launchEpoch: 'x'.repeat(129),
      launchSequence: 1,
    })).toBeUndefined();
  });
});

describe('page URL helpers', () => {
  it('normalizes away credentials, query and hash for same-page checks', () => {
    expect(normalizedPageUrl('https://u:p@example.com/a?x=1#top'))
      .toBe('https://example.com/a');
    expect(normalizedPageUrl('not a url')).toBe('not a url');
  });

  it('keys navigation documents by query but not by hash', () => {
    const base = { tabId: 7, windowId: 3 };
    expect(navigationPageIdentityKey({ ...base, url: 'https://example.com/a#one' }))
      .toBe(navigationPageIdentityKey({ ...base, url: 'https://example.com/a#two' }));
    expect(navigationPageIdentityKey({ ...base, url: 'https://example.com/a?tab=1' }))
      .not.toBe(navigationPageIdentityKey({ ...base, url: 'https://example.com/a?tab=2' }));
    expect(navigationPageIdentityKey({ ...base, url: 'https://u:p@example.com/a' }))
      .toBe('7:3:https://example.com/a');
    expect(navigationPageIdentityKey({ ...base, url: 'opaque' })).toBe('7:3:opaque');
    expect(navigationPageScopeKey({ ...base, url: 'https://example.com/a' })).toBe('7:3');
  });

  it('recognizes readable pages and non-default ports', () => {
    expect(isSupportedPage('https://example.com')).toBe(true);
    expect(isSupportedPage('http://example.com')).toBe(true);
    expect(isSupportedPage('chrome://extensions')).toBe(false);
    expect(isSupportedPage('file:///tmp/a.html')).toBe(false);
    expect(isSupportedPage(undefined)).toBe(false);
    expect(isSupportedPage('nope')).toBe(false);
    expect(hasNonDefaultPort('https://example.com:8443/a')).toBe(true);
    expect(hasNonDefaultPort('https://example.com/a')).toBe(false);
    expect(hasNonDefaultPort(undefined)).toBe(false);
    expect(hasNonDefaultPort('nope')).toBe(false);
  });
});

describe('page error messages', () => {
  it('keeps page-access guidance and rephrases Chrome access errors', () => {
    expect(readPageError(new PageAccessError('custom'))).toBe('custom');
    expect(readPageError(new Error('Cannot access contents of url "chrome://x"')))
      .toBe(PAGE_ACCESS_LOST_GUIDANCE);
    expect(readPageError(new Error('The extensions gallery cannot be scripted.')))
      .toBe(PAGE_ACCESS_LOST_GUIDANCE);
    expect(readPageError(new Error('boom'))).toBe('boom');
    expect(readPageError('string')).toBe('Something went wrong. Retry the current step.');
  });

  it('reads a message only from an Error with text', () => {
    expect(readableError(new Error('  '))).toBe('Something went wrong. Retry the current step.');
    expect(readableError(new Error('detail'))).toBe('detail');
    expect(readableError(42)).toBe('Something went wrong. Retry the current step.');
  });
});

describe('withPageTimeout', () => {
  it('passes a settled value through and clears its timer', async () => {
    vi.useFakeTimers();
    try {
      await expect(withPageTimeout(Promise.resolve(1), 1_000)).resolves.toBe(1);
      await expect(withPageTimeout(Promise.reject(new Error('x')), 1_000))
        .rejects.toThrow('x');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with a PageAccessError once the deadline passes', async () => {
    vi.useFakeTimers();
    try {
      const pending = withPageTimeout(new Promise<never>(() => undefined), 50);
      const settled = pending.catch((error: unknown) => error);
      vi.advanceTimersByTime(50);
      const error = await settled;
      expect(error).toBeInstanceOf(PageAccessError);
      expect((error as Error).message).toContain('took too long');
    } finally {
      vi.useRealTimers();
    }
  });
});
