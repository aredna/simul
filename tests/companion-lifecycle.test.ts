import { describe, expect, it } from 'vitest';

import {
  LatestWorkCoordinator,
  automaticTranslationAction,
} from '../lib/companion-lifecycle';

describe('automaticTranslationAction', () => {
  it('skips automatic translation when the page is not opted in', () => {
    expect(automaticTranslationAction(false, 'available')).toBe('skip');
    expect(automaticTranslationAction(false, 'downloadable')).toBe('skip');
  });

  it('translates only with an already prepared model', () => {
    expect(automaticTranslationAction(true, 'available')).toBe('translate');
    expect(automaticTranslationAction(true, 'downloadable')).toBe(
      'needs-user-action',
    );
    expect(automaticTranslationAction(true, 'downloading')).toBe(
      'needs-user-action',
    );
    expect(automaticTranslationAction(true, 'unavailable')).toBe('unavailable');
  });
});

describe('LatestWorkCoordinator', () => {
  it('starts idle work immediately and identifies its generation', () => {
    const coordinator = new LatestWorkCoordinator<string>();
    const enqueued = coordinator.enqueue('first');

    expect(enqueued).toEqual({
      work: { generation: 1, value: 'first' },
      startNow: true,
    });
    expect(coordinator.generation).toBe(1);
    expect(coordinator.hasRunningWork).toBe(true);
    expect(coordinator.hasQueuedWork).toBe(false);
    expect(coordinator.isCurrent(enqueued.work.generation)).toBe(true);
    expect(coordinator.finish(enqueued.work.generation)).toBeUndefined();
    expect(coordinator.hasRunningWork).toBe(false);
  });

  it('coalesces pending requests to the newest generation', () => {
    const coordinator = new LatestWorkCoordinator<string>();
    const first = coordinator.enqueue('first');
    const second = coordinator.enqueue('second');
    const third = coordinator.enqueue('third');

    expect(first.startNow).toBe(true);
    expect(second.startNow).toBe(false);
    expect(third.startNow).toBe(false);
    expect(coordinator.hasQueuedWork).toBe(true);
    expect(coordinator.isCurrent(first.work.generation)).toBe(false);
    expect(coordinator.isCurrent(second.work.generation)).toBe(false);
    expect(coordinator.isCurrent(third.work.generation)).toBe(true);

    expect(coordinator.finish(second.work.generation)).toBeUndefined();
    expect(coordinator.hasRunningWork).toBe(true);

    const promoted = coordinator.finish(first.work.generation);
    expect(promoted).toEqual(third.work);
    expect(coordinator.hasRunningWork).toBe(true);
    expect(coordinator.hasQueuedWork).toBe(false);
    expect(coordinator.finish(third.work.generation)).toBeUndefined();
    expect(coordinator.hasRunningWork).toBe(false);
  });

  it('invalidates stale work and drops an obsolete queued request', () => {
    const coordinator = new LatestWorkCoordinator<string>();
    const running = coordinator.enqueue('old-running');
    coordinator.enqueue('old-queued');

    const invalidatedAt = coordinator.invalidate();
    expect(invalidatedAt).toBe(3);
    expect(coordinator.isCurrent(running.work.generation)).toBe(false);
    expect(coordinator.hasQueuedWork).toBe(false);

    const latest = coordinator.enqueue('new-page');
    expect(latest.startNow).toBe(false);
    expect(coordinator.isCurrent(latest.work.generation)).toBe(true);
    expect(coordinator.finish(running.work.generation)).toEqual(latest.work);
    expect(coordinator.finish(latest.work.generation)).toBeUndefined();
  });
});
