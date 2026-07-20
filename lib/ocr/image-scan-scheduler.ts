import {
  isImageScanPolicy,
  readSourceImageChange,
  type ImageScanPolicy,
  type SourceImageChange,
  type SourceImageDescriptor,
} from './contracts';
import {
  decideSmallImageEligibility,
  type SmallImageDecisionReason,
} from './small-image-policy';
import {
  readSourceDocumentIdentity,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';

export const MAX_IMAGE_SCAN_RECORDS = 10_000;
export const MAX_IMAGE_SCAN_QUEUE = 512;
export const MAX_ACTIVE_IMAGE_SCANS = 1;

export interface ImageScanGates {
  readonly replicaCommitted: boolean;
  readonly documentReady: boolean;
  readonly translationIdle: boolean;
  readonly mutationQuiet: boolean;
}

export type ImageScanPriority = 'manual' | 'visible' | 'near' | 'background';

export interface ImageScanJob {
  readonly descriptor: SourceImageDescriptor;
  readonly priority: ImageScanPriority;
  readonly manualOverride: boolean;
}

export interface ImageScanCancellation {
  readonly job: ImageScanJob;
  readonly reason: 'superseded' | 'removed' | 'policy' | 'overflow';
}

export type ImageScanUpdateResult =
  | { readonly status: 'queued' | 'coalesced' }
  | {
      readonly status: 'skipped';
      readonly reason: SmallImageDecisionReason | 'visibility-gate';
    }
  | { readonly status: 'rejected' | 'overflow' };

interface SchedulerRecord {
  descriptor: SourceImageDescriptor;
  completedContentRevision?: number;
}

interface QueuedJob extends ImageScanJob {
  readonly enqueueOrder: number;
}

const CLOSED_GATES: Readonly<ImageScanGates> = Object.freeze({
  replicaCommitted: false,
  documentReady: false,
  translationIdle: false,
  mutationQuiet: false,
});

/** Deterministic policy queue. It does not capture pixels or run OCR. */
export class ImageScanScheduler {
  readonly #document: ReplicaSourceDocumentIdentity;
  readonly #maxRecords: number;
  readonly #maxQueue: number;
  readonly #records = new Map<number, SchedulerRecord>();
  readonly #pending = new Map<number, QueuedJob>();
  readonly #active = new Map<number, ImageScanJob>();
  readonly #manualOverrides = new Map<number, number>();
  readonly #decisions = new Map<
    number,
    SmallImageDecisionReason | 'visibility-gate'
  >();
  readonly #overflows = new Set<number>();
  readonly #cancellations: ImageScanCancellation[] = [];
  #policy: ImageScanPolicy;
  #skipSmallImages: boolean;
  #gates: ImageScanGates = CLOSED_GATES;
  #enqueueOrder = 0;

  constructor(
    document: ReplicaSourceDocumentIdentity,
    options: {
      readonly policy?: ImageScanPolicy;
      readonly skipSmallImages?: boolean;
      readonly maxRecords?: number;
      readonly maxQueue?: number;
    } = {},
  ) {
    const parsedDocument = readSourceDocumentIdentity(document);
    if (!parsedDocument) {
      throw new Error('Invalid image scan source document identity.');
    }
    this.#document = parsedDocument;
    this.#policy = options.policy ?? 'visible-first-background-prescan';
    this.#skipSmallImages = options.skipSmallImages ?? true;
    this.#maxRecords = positiveInteger(
      options.maxRecords,
      MAX_IMAGE_SCAN_RECORDS,
    );
    this.#maxQueue = positiveInteger(options.maxQueue, MAX_IMAGE_SCAN_QUEUE);
  }

  get size(): number {
    return this.#records.size;
  }

  get queued(): number {
    return this.#pending.size;
  }

  get active(): number {
    return this.#active.size;
  }

  configure(input: {
    readonly policy: ImageScanPolicy;
    readonly skipSmallImages: boolean;
  }): boolean {
    if (
      !isExactRecord(input, ['policy', 'skipSmallImages']) ||
      !isImageScanPolicy(input.policy) ||
      typeof input.skipSmallImages !== 'boolean'
    ) return false;
    if (
      this.#policy === input.policy &&
      this.#skipSmallImages === input.skipSmallImages
    ) return true;
    this.#policy = input.policy;
    this.#skipSmallImages = input.skipSmallImages;
    this.#reconcileAll();
    return true;
  }

  setGates(gates: ImageScanGates): boolean {
    if (!validGates(gates)) return false;
    if (sameGates(this.#gates, gates)) return true;
    this.#gates = Object.freeze({
      replicaCommitted: gates.replicaCommitted,
      documentReady: gates.documentReady,
      translationIdle: gates.translationIdle,
      mutationQuiet: gates.mutationQuiet,
    });
    this.#reconcileAll();
    return true;
  }

  apply(change: SourceImageChange): ImageScanUpdateResult {
    const parsed = readSourceImageChange(change);
    if (!parsed) return { status: 'rejected' };
    if (!sameSourceDocument(
      parsed.kind === 'upsert' ? parsed.descriptor.document : parsed.document,
      this.#document,
    )) return { status: 'rejected' };
    const result = parsed.kind === 'remove'
      ? this.#remove(parsed)
      : this.#upsert(parsed.descriptor);
    this.#reconsiderOverflowed();
    return result;
  }

  overrideCurrent(
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
    contentRevision: number,
  ): boolean {
    const parsedDocument = readSourceDocumentIdentity(document);
    if (!parsedDocument || !sameSourceDocument(parsedDocument, this.#document)) {
      return false;
    }
    const record = this.#records.get(nodeId);
    if (!record || record.descriptor.contentRevision !== contentRevision) {
      return false;
    }
    this.#manualOverrides.set(nodeId, contentRevision);
    record.completedContentRevision = undefined;
    this.#reconcileNode(nodeId);
    this.#reconsiderOverflowed();
    return true;
  }

  takeNext(): ImageScanJob | undefined {
    if (this.#active.size >= MAX_ACTIVE_IMAGE_SCANS) return undefined;
    const next = this.#orderedPending()[0];
    if (!next) return undefined;
    this.#pending.delete(next.descriptor.nodeId);
    const job: ImageScanJob = Object.freeze({
      descriptor: next.descriptor,
      priority: next.priority,
      manualOverride: next.manualOverride,
    });
    this.#active.set(job.descriptor.nodeId, job);
    this.#reconsiderOverflowed();
    return job;
  }

  /** Settle only a still-current active content revision. */
  settle(job: ImageScanJob): boolean {
    const active = this.#active.get(job.descriptor.nodeId);
    const record = this.#records.get(job.descriptor.nodeId);
    if (!active || !sameJob(active, job)) return false;
    this.#active.delete(job.descriptor.nodeId);
    if (!record || !sameContent(record.descriptor, job.descriptor)) {
      this.#reconsiderOverflowed();
      return false;
    }
    record.completedContentRevision = record.descriptor.contentRevision;
    this.#pending.delete(job.descriptor.nodeId);
    this.#overflows.delete(job.descriptor.nodeId);
    if (
      this.#manualOverrides.get(job.descriptor.nodeId) ===
      record.descriptor.contentRevision
    ) this.#manualOverrides.delete(job.descriptor.nodeId);
    this.#reconsiderOverflowed();
    return true;
  }

  retry(job: ImageScanJob): boolean {
    const active = this.#active.get(job.descriptor.nodeId);
    if (!active || !sameJob(active, job)) return false;
    this.#active.delete(job.descriptor.nodeId);
    this.#reconcileNode(job.descriptor.nodeId);
    this.#reconsiderOverflowed();
    return true;
  }

  queueSnapshot(): readonly ImageScanJob[] {
    return Object.freeze(
      this.#orderedPending().map((job) => Object.freeze({
        descriptor: job.descriptor,
        priority: job.priority,
        manualOverride: job.manualOverride,
      })),
    );
  }

  decisionFor(
    nodeId: number,
  ): SmallImageDecisionReason | 'visibility-gate' | undefined {
    return this.#decisions.get(nodeId);
  }

  drainCancellations(): readonly ImageScanCancellation[] {
    const result = Object.freeze([...this.#cancellations]);
    this.#cancellations.length = 0;
    return result;
  }

  clear(): void {
    for (const job of this.#active.values()) {
      this.#recordCancellation(job, 'removed');
    }
    for (const job of this.#pending.values()) {
      this.#recordCancellation(job, 'removed');
    }
    this.#records.clear();
    this.#pending.clear();
    this.#active.clear();
    this.#manualOverrides.clear();
    this.#decisions.clear();
    this.#overflows.clear();
  }

  #upsert(descriptor: SourceImageDescriptor): ImageScanUpdateResult {
    const previous = this.#records.get(descriptor.nodeId);
    if (!previous && this.#records.size >= this.#maxRecords) {
      return { status: 'overflow' };
    }
    if (previous) {
      const before = previous.descriptor;
      if (
        descriptor.contentRevision < before.contentRevision ||
        descriptor.observationRevision < before.observationRevision ||
        (descriptor.contentRevision > before.contentRevision &&
          descriptor.observationRevision <= before.observationRevision)
      ) return { status: 'rejected' };
      if (
        descriptor.contentRevision === before.contentRevision &&
        descriptor.observationRevision === before.observationRevision
      ) {
        return sameDescriptor(descriptor, before)
          ? this.#resultFor(descriptor.nodeId, 'coalesced')
          : { status: 'rejected' };
      }

      const contentChanged =
        descriptor.contentRevision !== before.contentRevision;
      if (contentChanged) {
        this.#cancelNode(descriptor.nodeId, 'superseded');
        this.#manualOverrides.delete(descriptor.nodeId);
      }
      this.#records.set(descriptor.nodeId, {
        descriptor,
        ...(!contentChanged &&
        previous.completedContentRevision !== undefined
          ? { completedContentRevision: previous.completedContentRevision }
          : {}),
      });
    } else {
      this.#records.set(descriptor.nodeId, { descriptor });
    }
    this.#overflows.delete(descriptor.nodeId);
    this.#reconcileNode(descriptor.nodeId);
    return this.#resultFor(descriptor.nodeId, 'queued');
  }

  #remove(
    change: Extract<SourceImageChange, { kind: 'remove' }>,
  ): ImageScanUpdateResult {
    const record = this.#records.get(change.nodeId);
    if (!record) return { status: 'coalesced' };
    if (
      change.contentRevision <= record.descriptor.contentRevision ||
      change.observationRevision <= record.descriptor.observationRevision
    ) return { status: 'rejected' };
    this.#cancelNode(change.nodeId, 'removed');
    this.#records.delete(change.nodeId);
    this.#manualOverrides.delete(change.nodeId);
    this.#decisions.delete(change.nodeId);
    this.#overflows.delete(change.nodeId);
    return { status: 'coalesced' };
  }

  #reconcileAll(): void {
    for (const nodeId of this.#records.keys()) this.#reconcileNode(nodeId);
    this.#reconsiderOverflowed();
  }

  #reconcileNode(nodeId: number): void {
    const record = this.#records.get(nodeId);
    if (!record) return;
    this.#overflows.delete(nodeId);

    const active = this.#active.get(nodeId);
    if (active) {
      if (sameContent(active.descriptor, record.descriptor)) return;
      this.#active.delete(nodeId);
      this.#recordCancellation(active, 'superseded');
    }

    const manualOverride =
      this.#manualOverrides.get(nodeId) === record.descriptor.contentRevision;
    if (
      record.completedContentRevision === record.descriptor.contentRevision &&
      !manualOverride
    ) {
      this.#pending.delete(nodeId);
      return;
    }

    const smallDecision = decideSmallImageEligibility(record.descriptor, {
      skipSmallImages: this.#skipSmallImages,
      manualOverride,
    });
    if (!smallDecision.eligible) {
      this.#dropPending(nodeId, 'policy');
      this.#decisions.set(nodeId, smallDecision.reason);
      return;
    }
    const priority = priorityFor(
      record.descriptor,
      this.#policy,
      this.#gates,
      manualOverride,
    );
    if (!priority) {
      this.#dropPending(nodeId, 'policy');
      this.#decisions.set(nodeId, 'visibility-gate');
      return;
    }

    this.#decisions.set(nodeId, smallDecision.reason);
    const existing = this.#pending.get(nodeId);
    if (
      existing &&
      existing.priority === priority &&
      existing.manualOverride === manualOverride &&
      sameDescriptor(existing.descriptor, record.descriptor)
    ) return;

    const candidate: QueuedJob = Object.freeze({
      descriptor: record.descriptor,
      priority,
      manualOverride,
      enqueueOrder: existing?.enqueueOrder ?? ++this.#enqueueOrder,
    });
    if (existing) this.#pending.delete(nodeId);
    this.#admit(candidate);
  }

  #admit(candidate: QueuedJob): void {
    if (this.#pending.size < this.#maxQueue) {
      this.#pending.set(candidate.descriptor.nodeId, candidate);
      this.#overflows.delete(candidate.descriptor.nodeId);
      return;
    }
    const worst = this.#orderedPending().at(-1);
    if (
      !worst ||
      priorityRank(candidate.priority) >= priorityRank(worst.priority)
    ) {
      this.#overflows.add(candidate.descriptor.nodeId);
      return;
    }
    this.#pending.delete(worst.descriptor.nodeId);
    this.#recordCancellation(worst, 'overflow');
    this.#overflows.add(worst.descriptor.nodeId);
    this.#pending.set(candidate.descriptor.nodeId, candidate);
    this.#overflows.delete(candidate.descriptor.nodeId);
  }

  #reconsiderOverflowed(): void {
    if (this.#pending.size >= this.#maxQueue || this.#overflows.size === 0) {
      return;
    }
    for (const nodeId of [...this.#overflows]) {
      if (this.#pending.size >= this.#maxQueue) break;
      this.#overflows.delete(nodeId);
      this.#reconcileNode(nodeId);
    }
  }

  #orderedPending(): QueuedJob[] {
    return [...this.#pending.values()].sort(compareQueuedJobs);
  }

  #resultFor(
    nodeId: number,
    success: 'queued' | 'coalesced',
  ): ImageScanUpdateResult {
    if (this.#pending.has(nodeId) || this.#active.has(nodeId)) {
      return { status: success };
    }
    const record = this.#records.get(nodeId);
    if (
      record?.completedContentRevision === record?.descriptor.contentRevision
    ) return { status: 'coalesced' };
    if (this.#overflows.has(nodeId)) return { status: 'overflow' };
    const reason = this.#decisions.get(nodeId);
    return reason
      ? { status: 'skipped', reason }
      : { status: 'overflow' };
  }

  #cancelNode(
    nodeId: number,
    reason: ImageScanCancellation['reason'],
  ): void {
    const pending = this.#pending.get(nodeId);
    if (pending) this.#recordCancellation(pending, reason);
    const active = this.#active.get(nodeId);
    if (active) this.#recordCancellation(active, reason);
    this.#pending.delete(nodeId);
    this.#active.delete(nodeId);
    this.#overflows.delete(nodeId);
  }

  #dropPending(
    nodeId: number,
    reason: ImageScanCancellation['reason'],
  ): void {
    const pending = this.#pending.get(nodeId);
    if (pending) this.#recordCancellation(pending, reason);
    this.#pending.delete(nodeId);
    this.#overflows.delete(nodeId);
  }

  #recordCancellation(
    job: ImageScanJob,
    reason: ImageScanCancellation['reason'],
  ): void {
    if (this.#cancellations.length >= this.#maxQueue) {
      this.#cancellations.shift();
    }
    this.#cancellations.push(Object.freeze({ job, reason }));
  }
}

function priorityFor(
  descriptor: SourceImageDescriptor,
  policy: ImageScanPolicy,
  gates: ImageScanGates,
  manualOverride: boolean,
): ImageScanPriority | undefined {
  if (manualOverride) return 'manual';
  if (descriptor.visibility === 'visible') return 'visible';
  if (policy === 'visible-only') return undefined;
  if (descriptor.visibility === 'near') return 'near';
  if (policy === 'eager-all') return 'background';
  return backgroundGatesOpen(gates) ? 'background' : undefined;
}

function backgroundGatesOpen(gates: ImageScanGates): boolean {
  return (
    gates.replicaCommitted &&
    gates.documentReady &&
    gates.translationIdle &&
    gates.mutationQuiet
  );
}

function compareQueuedJobs(left: QueuedJob, right: QueuedJob): number {
  return (
    priorityRank(left.priority) - priorityRank(right.priority) ||
    left.enqueueOrder - right.enqueueOrder ||
    left.descriptor.nodeId - right.descriptor.nodeId
  );
}

function priorityRank(priority: ImageScanPriority): number {
  if (priority === 'manual') return 0;
  if (priority === 'visible') return 1;
  if (priority === 'near') return 2;
  return 3;
}

function sameContent(
  left: SourceImageDescriptor,
  right: SourceImageDescriptor,
): boolean {
  return (
    sameSourceDocument(left.document, right.document) &&
    left.nodeId === right.nodeId &&
    left.contentRevision === right.contentRevision
  );
}

function sameDescriptor(
  left: SourceImageDescriptor,
  right: SourceImageDescriptor,
): boolean {
  return (
    sameContent(left, right) &&
    left.sourceKind === right.sourceKind &&
    left.observationRevision === right.observationRevision &&
    left.visibility === right.visibility &&
    left.connected === right.connected &&
    left.renderedWidth === right.renderedWidth &&
    left.renderedHeight === right.renderedHeight &&
    left.intrinsicWidth === right.intrinsicWidth &&
    left.intrinsicHeight === right.intrinsicHeight
  );
}

function sameJob(left: ImageScanJob, right: ImageScanJob): boolean {
  return (
    left.priority === right.priority &&
    left.manualOverride === right.manualOverride &&
    sameDescriptor(left.descriptor, right.descriptor)
  );
}

function validGates(gates: ImageScanGates): boolean {
  return (
    isExactRecord(gates, [
      'replicaCommitted',
      'documentReady',
      'translationIdle',
      'mutationQuiet',
    ]) &&
    typeof gates.replicaCommitted === 'boolean' &&
    typeof gates.documentReady === 'boolean' &&
    typeof gates.translationIdle === 'boolean' &&
    typeof gates.mutationQuiet === 'boolean'
  );
}

function sameGates(left: ImageScanGates, right: ImageScanGates): boolean {
  return (
    left.replicaCommitted === right.replicaCommitted &&
    left.documentReady === right.documentReady &&
    left.translationIdle === right.translationIdle &&
    left.mutationQuiet === right.mutationQuiet
  );
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? value as number
    : fallback;
}
