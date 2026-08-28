import { describe, expect, it } from 'vitest';

import {
  isSamePageIdentity,
  parseDetachedPageIdentityHint,
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
