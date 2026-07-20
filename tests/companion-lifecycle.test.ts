import { describe, expect, it } from 'vitest';

import {
  LatestWorkCoordinator,
  automaticTranslationAction,
  isAvailabilityRequestCurrent,
  mergeLiveUpdateBatches,
  replicaViewTranslationAction,
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

describe('replicaViewTranslationAction', () => {
  it('never translates a source-only replica', () => {
    expect(
      replicaViewTranslationAction('source-only', true, true, 'available'),
    ).toBe('skip');
  });

  it('respects saved automation and retained manual intent in translated mode', () => {
    expect(
      replicaViewTranslationAction('translated', false, false, 'available'),
    ).toBe('skip');
    expect(
      replicaViewTranslationAction('translated', true, false, 'available'),
    ).toBe('translate');
    expect(
      replicaViewTranslationAction('translated', false, true, 'available'),
    ).toBe('translate');
  });
});

describe('isAvailabilityRequestCurrent', () => {
  const current = {
    replicaViewMode: 'translated' as const,
    requestMatches: true,
    generationMatches: true,
    snapshotMatches: true,
    pairMatches: true,
  };

  it('accepts a fully current translated-mode request', () => {
    expect(isAvailabilityRequestCurrent(current)).toBe(true);
  });

  it('rejects a completed request after source-only mode takes over', () => {
    expect(
      isAvailabilityRequestCurrent({
        ...current,
        replicaViewMode: 'source-only',
      }),
    ).toBe(false);
  });

  it.each([
    'requestMatches',
    'generationMatches',
    'snapshotMatches',
    'pairMatches',
  ] as const)('rejects stale %s state', (field) => {
    expect(
      isAvailabilityRequestCurrent({
        ...current,
        [field]: false,
      }),
    ).toBe(false);
  });
});

describe('mergeLiveUpdateBatches', () => {
  it('requeues an interrupted chunk alongside an already queued remainder', () => {
    expect(mergeLiveUpdateBatches(
      {
        generation: 7,
        firstSequence: 12,
        sequence: 14,
        nodeIds: new Set(['remainder']),
      },
      {
        generation: 7,
        firstSequence: 10,
        sequence: 14,
        nodeIds: new Set(['active', 'remainder']),
      },
    )).toEqual({
      generation: 7,
      firstSequence: 10,
      sequence: 14,
      nodeIds: new Set(['remainder', 'active']),
    });
  });

  it('keeps the newest generation instead of reviving stale live work', () => {
    expect(mergeLiveUpdateBatches(
      {
        generation: 9,
        firstSequence: 1,
        sequence: 1,
        nodeIds: new Set(['new']),
      },
      {
        generation: 8,
        firstSequence: 30,
        sequence: 30,
        nodeIds: new Set(['stale']),
      },
    ).nodeIds).toEqual(new Set(['new']));
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
