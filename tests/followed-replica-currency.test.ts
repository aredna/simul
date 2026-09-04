import { describe, expect, it } from 'vitest';

import { shouldRebuildStaleFollowedReplica } from '../lib/followed-replica-currency';

const stripHash = (url: string): string => url.replace(/#.*$/u, '');

const settled = {
  captureInFlight: false,
  navigationRefreshPending: false,
  tabStatus: 'complete',
  normalizeUrl: stripHash,
} as const;

const olderPage = { tabId: 7, windowId: 2, url: 'https://example.com/one' };
const newerPage = { tabId: 7, windowId: 2, url: 'https://example.com/two' };

describe('shouldRebuildStaleFollowedReplica', () => {
  it('rebuilds when the rendered replica is an older page of the followed tab', () => {
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      captured: olderPage,
      identity: newerPage,
    })).toBe(true);
  });

  it('leaves a replica of the same page alone, ignoring normalized differences', () => {
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      captured: olderPage,
      identity: { ...olderPage, url: 'https://example.com/one#section' },
    })).toBe(false);
    expect(shouldRebuildStaleFollowedReplica({
      captureInFlight: false,
      navigationRefreshPending: false,
      tabStatus: 'complete',
      captured: olderPage,
      identity: olderPage,
    })).toBe(false);
  });

  it('defers to a capture or navigation refresh that is already on the way', () => {
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      captureInFlight: true,
      captured: olderPage,
      identity: newerPage,
    })).toBe(false);
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      navigationRefreshPending: true,
      captured: olderPage,
      identity: newerPage,
    })).toBe(false);
  });

  it('waits for a loading tab, whose completion schedules its own refresh', () => {
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      tabStatus: 'loading',
      captured: olderPage,
      identity: newerPage,
    })).toBe(false);
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      tabStatus: undefined,
      captured: olderPage,
      identity: newerPage,
    })).toBe(true);
  });

  it('never retries a follow whose replica belongs to another tab or is missing', () => {
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      captured: { ...olderPage, tabId: 8 },
      identity: newerPage,
    })).toBe(false);
    expect(shouldRebuildStaleFollowedReplica({
      ...settled,
      captured: undefined,
      identity: newerPage,
    })).toBe(false);
  });
});
