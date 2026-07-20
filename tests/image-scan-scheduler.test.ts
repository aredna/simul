import { describe, expect, it } from 'vitest';

import {
  ImageScanScheduler,
  type ImageScanGates,
} from '../lib/ocr/image-scan-scheduler';
import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const documentIdentity: ReplicaSourceDocumentIdentity = {
  sessionId: 'session-a',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document-a',
  frameId: 0,
};
const openGates: ImageScanGates = {
  replicaCommitted: true,
  documentReady: true,
  translationIdle: true,
  mutationQuiet: true,
};

describe('ImageScanScheduler', () => {
  it('implements the three policies and all background-prescan gates', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'visible-only',
    });
    expect(scheduler.apply(upsert(descriptor(1, 'background')))).toEqual({
      status: 'skipped',
      reason: 'visibility-gate',
    });
    expect(scheduler.apply(upsert(descriptor(2, 'visible')))).toMatchObject({
      status: 'queued',
    });
    expect(scheduler.queueSnapshot().map((job) => job.descriptor.nodeId)).toEqual([2]);

    scheduler.configure({
      policy: 'visible-first-background-prescan',
      skipSmallImages: true,
    });
    expect(scheduler.apply(upsert(descriptor(3, 'near')))).toMatchObject({
      status: 'queued',
    });
    expect(scheduler.queueSnapshot().map((job) => job.priority)).toEqual([
      'visible',
      'near',
    ]);
    scheduler.setGates({ ...openGates, mutationQuiet: false });
    expect(scheduler.queued).toBe(2);
    scheduler.setGates(openGates);
    expect(scheduler.queueSnapshot().map((job) => job.priority)).toEqual([
      'visible',
      'near',
      'background',
    ]);

    const eager = new ImageScanScheduler(documentIdentity, {
      policy: 'eager-all',
    });
    expect(eager.apply(upsert(descriptor(8, 'background')))).toMatchObject({
      status: 'queued',
    });
  });

  it('orders manual, visible, near, and background jobs deterministically', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'eager-all',
      skipSmallImages: false,
    });
    scheduler.apply(upsert(descriptor(1, 'background')));
    scheduler.apply(upsert(descriptor(2, 'near')));
    scheduler.apply(upsert(descriptor(3, 'visible')));
    scheduler.apply(upsert(descriptor(4, 'background', {
      renderedWidth: 10,
      renderedHeight: 10,
    })));
    expect(scheduler.overrideCurrent(documentIdentity, 4, 1)).toBe(true);

    expect(scheduler.queueSnapshot().map((job) => [
      job.descriptor.nodeId,
      job.priority,
    ])).toEqual([
      [4, 'manual'],
      [3, 'visible'],
      [2, 'near'],
      [1, 'background'],
    ]);
  });

  it('coalesces duplicates, cancels stale work, and scopes override to content revision', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'visible-only',
    });
    const smallHidden = descriptor(7, 'background', {
      renderedWidth: 10,
      renderedHeight: 10,
    });
    expect(scheduler.apply(upsert(smallHidden))).toMatchObject({ status: 'skipped' });
    expect(scheduler.overrideCurrent(documentIdentity, 7, 1)).toBe(true);
    const active = scheduler.takeNext()!;
    expect(active.priority).toBe('manual');
    expect(scheduler.apply(upsert({
      ...smallHidden,
      contentRevision: 2,
      observationRevision: 2,
    }))).toMatchObject({ status: 'skipped' });
    expect(scheduler.drainCancellations()).toMatchObject([
      { reason: 'superseded' },
    ]);
    expect(scheduler.settle(active)).toBe(false);
    expect(scheduler.overrideCurrent(documentIdentity, 7, 1)).toBe(false);
  });

  it('preempts queued background work on bounded overflow but rejects equal-priority excess', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'eager-all',
      maxQueue: 2,
    });
    expect(scheduler.apply(upsert(descriptor(1, 'background')))).toMatchObject({ status: 'queued' });
    expect(scheduler.apply(upsert(descriptor(2, 'background')))).toMatchObject({ status: 'queued' });
    expect(scheduler.apply(upsert(descriptor(3, 'background')))).toEqual({ status: 'overflow' });
    expect(scheduler.apply(upsert(descriptor(4, 'visible')))).toMatchObject({ status: 'queued' });
    expect(scheduler.queueSnapshot().map((job) => job.descriptor.nodeId)).toEqual([4, 1]);
    expect(scheduler.drainCancellations()).toMatchObject([
      { job: { descriptor: { nodeId: 2 } }, reason: 'overflow' },
    ]);
  });

  it('recomputes policy without canceling already-active content', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'eager-all',
    });
    const image = descriptor(9, 'background');
    scheduler.apply(upsert(image));
    const active = scheduler.takeNext()!;
    scheduler.configure({ policy: 'visible-only', skipSmallImages: true });

    expect(scheduler.queued).toBe(0);
    expect(scheduler.active).toBe(1);
    expect(scheduler.drainCancellations()).toEqual([]);
    expect(scheduler.settle(active)).toBe(true);
  });

  it('rejects wrong-document, stale, malformed, and record-overflow changes', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, { maxRecords: 1 });
    expect(scheduler.apply(upsert(descriptor(1, 'visible')))).toMatchObject({ status: 'queued' });
    expect(scheduler.apply(upsert(descriptor(2, 'visible')))).toEqual({ status: 'overflow' });
    expect(scheduler.apply(upsert({
      ...descriptor(1, 'visible'),
      document: { ...documentIdentity, pageEpoch: 2 },
    }))).toEqual({ status: 'rejected' });
    expect(scheduler.apply(upsert({
      ...descriptor(1, 'visible'),
      renderedHeight: Number.POSITIVE_INFINITY,
    }))).toEqual({ status: 'rejected' });
    expect(scheduler.apply({
      ...upsert(descriptor(1, 'visible')),
      privateSource: 'forbidden',
    } as never)).toEqual({ status: 'rejected' });
  });

  it('reconsiders overflow deterministically as queue capacity opens', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'eager-all',
      maxQueue: 1,
    });
    scheduler.apply(upsert(descriptor(1, 'background')));
    expect(scheduler.apply(upsert(descriptor(2, 'background')))).toEqual({
      status: 'overflow',
    });

    const first = scheduler.takeNext()!;
    expect(first.descriptor.nodeId).toBe(1);
    expect(scheduler.queueSnapshot().map((job) => job.descriptor.nodeId))
      .toEqual([2]);
    expect(scheduler.takeNext()).toBeUndefined();
    expect(scheduler.active).toBe(1);

    expect(scheduler.settle(first)).toBe(true);
    expect(scheduler.takeNext()?.descriptor.nodeId).toBe(2);
  });

  it('completes by content revision while observation and policy changes stay non-destructive', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'eager-all',
    });
    scheduler.apply(upsert(descriptor(1, 'background')));
    const active = scheduler.takeNext()!;

    expect(scheduler.apply(upsert(descriptor(1, 'visible', {
      observationRevision: 2,
      renderedWidth: 240,
    })))).toMatchObject({ status: 'queued' });
    expect(scheduler.apply(upsert(descriptor(2, 'visible')))).toMatchObject({
      status: 'queued',
    });
    expect(scheduler.active).toBe(1);
    expect(scheduler.drainCancellations()).toEqual([]);
    expect(scheduler.settle(active)).toBe(true);

    expect(scheduler.apply(upsert(descriptor(1, 'near', {
      observationRevision: 3,
    })))).toEqual({ status: 'coalesced' });
    expect(scheduler.queued).toBe(1);
    expect(scheduler.overrideCurrent(documentIdentity, 1, 1)).toBe(true);
    expect(scheduler.queueSnapshot().map((job) => [
      job.descriptor.nodeId,
      job.priority,
    ])).toEqual([
      [1, 'manual'],
      [2, 'visible'],
    ]);
  });

  it('rejects a stale settle after content supersession', () => {
    const scheduler = new ImageScanScheduler(documentIdentity, {
      policy: 'eager-all',
    });
    scheduler.apply(upsert(descriptor(5, 'background')));
    const stale = scheduler.takeNext()!;
    scheduler.apply(upsert(descriptor(5, 'background', {
      contentRevision: 2,
      observationRevision: 2,
    })));

    expect(scheduler.drainCancellations()).toMatchObject([
      { reason: 'superseded', job: { descriptor: { contentRevision: 1 } } },
    ]);
    expect(scheduler.settle(stale)).toBe(false);
  });
});

function descriptor(
  nodeId: number,
  visibility: SourceImageDescriptor['visibility'],
  overrides: Partial<SourceImageDescriptor> = {},
): SourceImageDescriptor {
  return {
    document: documentIdentity,
    nodeId,
    sourceKind: 'img',
    contentRevision: 1,
    observationRevision: 1,
    visibility,
    connected: true,
    renderedWidth: 200,
    renderedHeight: 100,
    intrinsicWidth: 800,
    intrinsicHeight: 400,
    ...overrides,
  };
}

function upsert(descriptorValue: SourceImageDescriptor) {
  return { kind: 'upsert' as const, descriptor: descriptorValue };
}
