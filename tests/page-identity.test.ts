import { describe, expect, it } from 'vitest';

import { parseDetachedPageIdentityHint } from '../lib/page-identity';

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
