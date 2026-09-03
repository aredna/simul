import { describe, expect, it } from 'vitest';

import {
  PageAccessError,
  assertSnapshotIsCurrent,
  hasNonDefaultPort,
  identityFromTab,
  isSupportedPage,
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

describe('page access helpers', () => {
  it('normalizes and classifies page URLs', () => {
    expect(normalizedPageUrl('https://user:pw@example.com/a?q=1#h')).toBe('https://example.com/a');
    expect(normalizedPageUrl('not a url')).toBe('not a url');
    expect(isSupportedPage('https://example.com/')).toBe(true);
    expect(isSupportedPage('chrome://extensions')).toBe(false);
    expect(isSupportedPage(undefined)).toBe(false);
    expect(hasNonDefaultPort('https://example.com:8443/')).toBe(true);
    expect(hasNonDefaultPort('https://example.com/')).toBe(false);
  });

  it('reads a tab identity only for active, supported pages', () => {
    expect(identityFromTab({ id: 4, windowId: 2, url: 'https://a.test/', active: true })).toEqual({
      tabId: 4,
      windowId: 2,
      url: 'https://a.test/',
    });
    expect(identityFromTab({ id: 4, windowId: 2, active: false }, 'https://b.test/', false))
      .toEqual({ tabId: 4, windowId: 2, url: 'https://b.test/' });
    expect(() => identityFromTab({ id: 4, windowId: 2, url: 'https://a.test/', active: false }))
      .toThrow(PageAccessError);
    expect(() => identityFromTab({ id: 4, windowId: 2, url: 'chrome://x', active: true }))
      .toThrow(PageAccessError);
    expect(() => identityFromTab(undefined)).toThrow(PageAccessError);
  });

  it('asserts the captured identity still matches the tab', () => {
    const identity = { tabId: 4, windowId: 2, url: 'https://a.test/page' };
    const tab = { id: 4, windowId: 2, url: 'https://a.test/page', active: true };
    expect(() => assertSnapshotIsCurrent(tab, identity, true)).not.toThrow();
    expect(() => assertSnapshotIsCurrent({ ...tab, active: false }, identity, true))
      .toThrow(PageAccessError);
    expect(() => assertSnapshotIsCurrent({ ...tab, active: false }, identity, false))
      .not.toThrow();
    expect(() => assertSnapshotIsCurrent({ ...tab, url: 'https://a.test/other' }, identity, false))
      .toThrow(PageAccessError);
  });

  it('validates the toolbar authorization message and its launch stamp', () => {
    const base = { type: 'simul:authorized-tab', tabId: 4, windowId: 2, url: 'https://a.test/' };
    expect(readAuthorizedTabMessage(base)).toEqual({
      identity: { tabId: 4, windowId: 2, url: 'https://a.test/' },
    });
    expect(readAuthorizedTabMessage({ ...base, launchEpoch: 'e', launchSequence: 3 })).toEqual({
      identity: { tabId: 4, windowId: 2, url: 'https://a.test/' },
      launchStamp: { epoch: 'e', sequence: 3 },
    });
    expect(readAuthorizedTabMessage({ ...base, launchEpoch: '', launchSequence: 3 })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...base, launchSequence: 0 })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...base, url: 'chrome://x' })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...base, tabId: -1 })).toBeUndefined();
    expect(readAuthorizedTabMessage({ ...base, type: 'other' })).toBeUndefined();
  });

  it('rephrases access errors and enforces a page timeout', async () => {
    expect(readPageError(new PageAccessError('custom'))).toBe('custom');
    expect(readPageError(new Error('Cannot access contents of url'))).toContain('no longer has access');
    expect(readPageError(new Error('plain failure'))).toBe('plain failure');
    expect(readableError('x')).toBe('Something went wrong. Retry the current step.');

    await expect(withPageTimeout(Promise.resolve(1), 50)).resolves.toBe(1);
    await expect(withPageTimeout(new Promise(() => undefined), 5)).rejects.toBeInstanceOf(
      PageAccessError,
    );
  });
});
