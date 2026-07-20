import type {
  ReplicaCheckpointEnvelope,
  ReplicaDocumentIdentity,
} from './contracts';
import {
  MAX_REPLICA_LIVE_BATCH_BYTES,
  MAX_REPLICA_LIVE_EVENT_BYTES,
  MAX_REPLICA_LIVE_EVENTS_PER_BATCH,
  MAX_REPLICA_LIVE_HISTORY_BATCHES,
  MAX_REPLICA_LIVE_HISTORY_BYTES,
  MAX_REPLICA_LIVE_SUBSCRIBERS,
  MAX_REPLICA_LIVE_UNACKED_BATCHES,
  createLiveBatchEnvelope,
  createLiveStreamError,
} from './live-protocol';
import type { RecorderOptions, RecorderStart } from './page-recorder';
import {
  createCheckpointEnvelope,
  createReplicaIdentity,
  sanitizeCssText,
} from './protocol-v2';
import { RrwebStreamSanitizer } from './rrweb-stream-sanitizer';

interface RecorderSessionSubscriber {
  readonly identity: ReplicaDocumentIdentity;
  readonly send: (message: unknown) => void;
  lastAck: number;
  highestSent: number;
  unacked: number[];
  waitingForCheckpoint: boolean;
  checkpointPendingSequence: number | undefined;
  checkpointAfterAck: boolean;
  recoveryNotified: boolean;
}

interface RecorderHistoryBatch {
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly events: readonly unknown[];
  readonly byteLength: number;
}

export interface LiveRecorderSessionEnvironment {
  readonly document: Document;
  readonly window: Window;
  readonly now: () => number;
  readonly start: RecorderStart;
  readonly takeFullSnapshot: () => void;
  readonly preflight?: () => 'checkpoint_too_large' | 'capture_failed' | undefined;
  readonly scheduleFrame: (callback: () => void) => unknown;
  readonly cancelFrame: (handle: unknown) => void;
  readonly resolveNode?: (id: number) => Node | null;
}

export type LiveRecorderSubscriptionResult =
  | 'subscribed'
  | 'rejected'
  | 'failed';

/** One rrweb recorder and event sequence shared by bounded document viewers. */
export class LiveRecorderSession {
  readonly #subscribers = new Map<string, RecorderSessionSubscriber>();
  readonly #history: RecorderHistoryBatch[] = [];
  readonly #sanitizer = new RrwebStreamSanitizer();
  readonly #checkoutTargets = new Set<string>();
  readonly #pendingEvents: unknown[] = [];
  #historyBytes = 0;
  #sequence = 0;
  #checkpointSequence = 0;
  #checkpointEvents: readonly unknown[] | undefined;
  #pendingMeta: unknown | undefined;
  #captureStartedAt = 0;
  #stop: (() => void) | undefined;
  #frameHandle: unknown | undefined;
  #checkoutInFlight = false;
  #disposed = false;

  constructor(private readonly environment: LiveRecorderSessionEnvironment) {}

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  get sequence(): number {
    return this.#sequence;
  }

  addSubscriber(
    identity: ReplicaDocumentIdentity,
    send: (message: unknown) => void,
  ): LiveRecorderSubscriptionResult {
    const existing = this.#subscribers.get(identity.sessionId);
    if (
      this.#disposed ||
      identity.frameId !== 0 ||
      identity.sequence !== 0 ||
      this.environment.window.top !== this.environment.window ||
      (existing
        ? !canReplaceSubscriber(existing.identity, identity)
        : this.#subscribers.size >= MAX_REPLICA_LIVE_SUBSCRIBERS)
    ) return 'rejected';
    const subscriber: RecorderSessionSubscriber = {
      identity,
      send,
      lastAck: 0,
      highestSent: 0,
      unacked: [],
      waitingForCheckpoint: true,
      checkpointPendingSequence: undefined,
      checkpointAfterAck: false,
      recoveryNotified: false,
    };
    this.#checkoutTargets.delete(identity.sessionId);
    this.#subscribers.set(identity.sessionId, subscriber);
    if (!this.#stop) {
      this.#startRecorder();
    } else if (this.#checkpointEvents) {
      this.#sendCheckpointAndCatchup(subscriber);
    }
    return this.#disposed ? 'failed' : 'subscribed';
  }

  removeSubscriber(identity: ReplicaDocumentIdentity): void {
    const subscriber = this.#currentSubscriber(identity);
    if (!subscriber) return;
    this.#subscribers.delete(identity.sessionId);
    this.#checkoutTargets.delete(identity.sessionId);
    if (this.#subscribers.size === 0) this.dispose();
    else this.#requestCheckout();
  }

  acknowledge(identity: ReplicaDocumentIdentity, sequence: number): void {
    const subscriber = this.#currentSubscriber(identity);
    if (
      !subscriber ||
      sequence < subscriber.lastAck ||
      sequence > subscriber.highestSent
    ) return;
    subscriber.lastAck = sequence;
    subscriber.unacked = subscriber.unacked.filter((last) => last > sequence);
  }

  acknowledgeCheckpoint(identity: ReplicaDocumentIdentity, sequence: number): void {
    const subscriber = this.#currentSubscriber(identity);
    if (!subscriber || subscriber.checkpointPendingSequence !== sequence) return;
    subscriber.lastAck = Math.max(subscriber.lastAck, sequence);
    subscriber.checkpointPendingSequence = undefined;
    subscriber.recoveryNotified = false;
    if (subscriber.checkpointAfterAck) {
      subscriber.checkpointAfterAck = false;
      subscriber.waitingForCheckpoint = true;
      this.#checkoutTargets.add(identity.sessionId);
      this.#requestCheckout();
      return;
    }
    const catchup = this.#readBoundedCatchup(sequence);
    if (!catchup) {
      subscriber.waitingForCheckpoint = true;
      this.#checkoutTargets.add(identity.sessionId);
      this.#requestCheckout();
      return;
    }
    subscriber.waitingForCheckpoint = false;
    for (const batch of catchup) this.#sendBatch(subscriber, batch);
    this.#requestCheckout();
  }

  requestCheckpoint(identity: ReplicaDocumentIdentity): void {
    const subscriber = this.#currentSubscriber(identity);
    if (!subscriber) return;
    if (subscriber.checkpointPendingSequence !== undefined) {
      this.#deferCheckpointUntilAck(subscriber, false);
      return;
    }
    if (subscriber.waitingForCheckpoint) return;
    subscriber.waitingForCheckpoint = true;
    this.#checkoutTargets.add(identity.sessionId);
    this.#requestCheckout();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#frameHandle !== undefined) {
      this.environment.cancelFrame(this.#frameHandle);
      this.#frameHandle = undefined;
    }
    try {
      this.#stop?.();
    } catch {
      // The document owns the recorder and may already be unloading.
    }
    this.#stop = undefined;
    this.#subscribers.clear();
    this.#checkoutTargets.clear();
    this.#pendingEvents.length = 0;
    this.#history.length = 0;
    this.#historyBytes = 0;
  }

  #startRecorder(): void {
    const preflightError = this.environment.preflight?.();
    if (preflightError) {
      this.#failAll(
        preflightError === 'checkpoint_too_large'
          ? 'stream_overflow'
          : 'stream_failed',
      );
      return;
    }
    this.#captureStartedAt = this.environment.now();
    try {
      const stop = this.environment.start(
        createLiveRecorderOptions((event, isCheckout) =>
          this.#handleRecorderEvent(event, isCheckout === true),
        ),
      );
      if (!stop) {
        this.#failAll();
        return;
      }
      if (this.#disposed) {
        try {
          stop();
        } catch {
          // A synchronous recorder failure already disposed the session.
        }
        return;
      }
      this.#stop = stop;
    } catch {
      this.#failAll();
    }
  }

  #handleRecorderEvent(event: unknown, isCheckout: boolean): void {
    if (this.#disposed || !isRecord(event)) return;
    if (event.type === 4) {
      this.#pendingMeta = event;
      if (isCheckout) this.#checkoutInFlight = true;
      return;
    }
    if (event.type === 2) {
      if (!this.#pendingMeta) {
        this.#failAll();
        return;
      }
      const checkpoint = this.#createCheckpoint(
        [this.#pendingMeta, event],
        this.#firstIdentity(),
        this.#sequence,
        true,
      );
      this.#pendingMeta = undefined;
      if (!checkpoint) {
        this.#failAll();
        return;
      }
      this.#checkpointEvents = checkpoint.payload.events;
      this.#checkpointSequence = this.#sequence;
      if (!this.#sanitizer.reset(checkpoint.payload.events)) {
        this.#failAll();
        return;
      }
      const targets = this.#checkoutTargets.size > 0
        ? [...this.#checkoutTargets]
        : [...this.#subscribers.keys()];
      this.#checkoutTargets.clear();
      this.#checkoutInFlight = false;
      for (const sessionId of targets) {
        const subscriber = this.#subscribers.get(sessionId);
        if (subscriber) this.#sendCheckpointAndCatchup(subscriber);
      }
      return;
    }
    if (event.type !== 3) return;
    const projectedEvent = this.environment.resolveNode
      ? rewriteLiveIncrementalStyleSheets(event, this.environment.resolveNode)
      : event;
    if (!projectedEvent) {
      this.#checkpointAll();
      return;
    }
    const rawEventBytes = jsonByteLength(projectedEvent);
    if (rawEventBytes < 1 || rawEventBytes > MAX_REPLICA_LIVE_EVENT_BYTES) {
      this.#checkpointAll();
      return;
    }
    if (isViewportResizeEvent(projectedEvent)) {
      this.#checkpointAll();
      return;
    }
    this.#pendingEvents.push(projectedEvent);
    if (this.#pendingEvents.length >= MAX_REPLICA_LIVE_EVENTS_PER_BATCH) {
      this.#flushPendingEvents();
    } else if (this.#frameHandle === undefined) {
      this.#frameHandle = this.environment.scheduleFrame(() => {
        this.#frameHandle = undefined;
        this.#flushPendingEvents();
      });
    }
  }

  #flushPendingEvents(): void {
    if (this.#disposed || this.#pendingEvents.length === 0) return;
    while (this.#pendingEvents.length > 0) {
      const rawEvents: unknown[] = [];
      let bytes = 2;
      while (
        rawEvents.length < MAX_REPLICA_LIVE_EVENTS_PER_BATCH &&
        this.#pendingEvents.length > 0
      ) {
        const next = this.#pendingEvents[0];
        const nextBytes = jsonByteLength(next) + (rawEvents.length > 0 ? 1 : 0);
        if (rawEvents.length > 0 && bytes + nextBytes > MAX_REPLICA_LIVE_BATCH_BYTES) {
          break;
        }
        this.#pendingEvents.shift();
        rawEvents.push(next);
        bytes += nextBytes;
      }
      if (rawEvents.length === 0) {
        this.#pendingEvents.shift();
        this.#checkpointAll();
        continue;
      }
      if (
        this.environment.resolveNode &&
        rawEvents.some((event) => nodeCssEventNeedsCanonicalCheckpoint(
          event,
          this.environment.resolveNode!,
        ))
      ) {
        this.#pendingEvents.length = 0;
        this.#checkpointAll();
        return;
      }
      const result = this.#sanitizer.sanitizeRecorderBatch(rawEvents);
      if (result.status === 'checkpoint') {
        // The full snapshot includes every mutation observed through this
        // point, so no raw tail may be sequenced again after that checkpoint.
        this.#pendingEvents.length = 0;
        this.#checkpointAll();
        return;
      }
      const events = [...result.events];
      if (events.length === 0) continue;
      if (events.some((event) => {
        const eventBytes = jsonByteLength(event);
        return eventBytes < 1 || eventBytes > MAX_REPLICA_LIVE_EVENT_BYTES;
      })) {
        this.#pendingEvents.length = 0;
        this.#checkpointAll();
        return;
      }
      const firstSequence = this.#sequence + 1;
      const lastSequence = firstSequence + events.length - 1;
      const batch: RecorderHistoryBatch = {
        firstSequence,
        lastSequence,
        events: Object.freeze(events),
        byteLength: jsonByteLength(events),
      };
      this.#sequence = lastSequence;
      this.#history.push(batch);
      this.#historyBytes += batch.byteLength;
      this.#trimHistory();
      for (const subscriber of this.#subscribers.values()) {
        this.#sendBatch(subscriber, batch);
      }
      this.#requestCheckout();
    }
  }

  #sendBatch(
    subscriber: RecorderSessionSubscriber,
    batch: RecorderHistoryBatch,
  ): void {
    if (
      subscriber.waitingForCheckpoint ||
      batch.lastSequence <= subscriber.highestSent
    ) {
      return;
    }
    if (
      batch.firstSequence !== subscriber.highestSent + 1 ||
      subscriber.unacked.length >= MAX_REPLICA_LIVE_UNACKED_BATCHES
    ) {
      this.#pressureResync(subscriber);
      return;
    }
    const envelope = createLiveBatchEnvelope(
      subscriber.identity,
      batch.firstSequence,
      batch.events,
    );
    if (!envelope) {
      this.#pressureResync(subscriber);
      return;
    }
    subscriber.send(envelope);
    subscriber.highestSent = batch.lastSequence;
    subscriber.unacked.push(batch.lastSequence);
  }

  #sendCheckpointAndCatchup(subscriber: RecorderSessionSubscriber): void {
    if (!this.#checkpointEvents) return;
    const checkpoint = this.#createCheckpoint(
      this.#checkpointEvents,
      subscriber.identity,
      this.#checkpointSequence,
    );
    if (!checkpoint) {
      subscriber.send(createLiveStreamError(subscriber.identity, 'stream_failed'));
      return;
    }
    if (!this.#readBoundedCatchup(this.#checkpointSequence)) {
      subscriber.waitingForCheckpoint = true;
      this.#checkoutTargets.add(subscriber.identity.sessionId);
      this.#requestCheckout();
      return;
    }
    subscriber.highestSent = this.#checkpointSequence;
    subscriber.unacked = [];
    // A transport delivery is not an applied-state proof. Keep this viewer
    // paused until the replica atomically commits and ACKs the checkpoint;
    // only then may bounded post-checkpoint history be delivered.
    subscriber.waitingForCheckpoint = true;
    subscriber.checkpointPendingSequence = this.#checkpointSequence;
    subscriber.checkpointAfterAck = false;
    subscriber.recoveryNotified = false;
    subscriber.send(checkpoint);
    this.#requestCheckout();
  }

  #readBoundedCatchup(sequence: number): RecorderHistoryBatch[] | undefined {
    if (sequence > this.#sequence) return undefined;
    if (sequence === this.#sequence) return [];
    const catchup = this.#history.filter(
      (batch) => batch.firstSequence > sequence,
    );
    if (
      catchup.length === 0 ||
      catchup.length > MAX_REPLICA_LIVE_UNACKED_BATCHES
    ) return undefined;
    let expectedSequence = sequence + 1;
    for (const batch of catchup) {
      if (batch.firstSequence !== expectedSequence) return undefined;
      expectedSequence = batch.lastSequence + 1;
    }
    return expectedSequence === this.#sequence + 1 ? catchup : undefined;
  }

  #createCheckpoint(
    events: readonly unknown[],
    identity: ReplicaDocumentIdentity | undefined,
    sequence: number,
    rewriteSourceStyles = false,
  ): ReplicaCheckpointEnvelope | undefined {
    if (!identity) return undefined;
    const checkpointEvents = rewriteSourceStyles && this.environment.resolveNode
      ? rewriteLiveCheckpointStyleSheets(
          events,
          this.environment.resolveNode,
        )
      : events;
    if (!checkpointEvents) return undefined;
    const documentElement = this.environment.document.documentElement;
    const body = this.environment.document.body;
    const result = createCheckpointEnvelope(
      createReplicaIdentity({
        sessionId: identity.sessionId,
        pageEpoch: identity.pageEpoch,
        generation: identity.generation,
        documentId: identity.documentId,
        frameId: identity.frameId,
        sequence,
      }),
      {
        events: checkpointEvents,
        captureMs: Math.max(0, this.environment.now() - this.#captureStartedAt),
        viewportWidth: Math.max(1, this.environment.window.innerWidth),
        viewportHeight: Math.max(1, this.environment.window.innerHeight),
        documentWidth: Math.max(
          1,
          documentElement?.scrollWidth ?? 0,
          body?.scrollWidth ?? 0,
        ),
        documentHeight: Math.max(
          1,
          documentElement?.scrollHeight ?? 0,
          body?.scrollHeight ?? 0,
        ),
      },
    );
    return result.kind === 'simul:replica-v2:checkpoint' ? result : undefined;
  }

  #trimHistory(): void {
    while (
      this.#history.length > MAX_REPLICA_LIVE_HISTORY_BATCHES ||
      this.#historyBytes > MAX_REPLICA_LIVE_HISTORY_BYTES
    ) {
      const removed = this.#history.shift();
      if (!removed) break;
      this.#historyBytes -= removed.byteLength;
      for (const subscriber of this.#subscribers.values()) {
        if (!subscriber.waitingForCheckpoint && subscriber.lastAck < removed.lastSequence) {
          this.#pressureResync(subscriber);
        }
      }
    }
  }

  #pressureResync(subscriber: RecorderSessionSubscriber): void {
    if (subscriber.waitingForCheckpoint) return;
    if (subscriber.checkpointPendingSequence !== undefined) {
      this.#deferCheckpointUntilAck(subscriber, true);
      return;
    }
    subscriber.waitingForCheckpoint = true;
    subscriber.send(
      createLiveStreamError(
        createReplicaIdentity({
          sessionId: subscriber.identity.sessionId,
          pageEpoch: subscriber.identity.pageEpoch,
          generation: subscriber.identity.generation,
          documentId: subscriber.identity.documentId,
          frameId: subscriber.identity.frameId,
          sequence: subscriber.highestSent,
        }),
        'stream_overflow',
      ),
    );
    this.#checkoutTargets.add(subscriber.identity.sessionId);
  }

  #deferCheckpointUntilAck(
    subscriber: RecorderSessionSubscriber,
    notifyRecovery: boolean,
  ): void {
    subscriber.waitingForCheckpoint = true;
    subscriber.checkpointAfterAck = true;
    if (!notifyRecovery || subscriber.recoveryNotified) return;
    subscriber.recoveryNotified = true;
    try {
      subscriber.send(createLiveStreamError(
        createReplicaIdentity({
          sessionId: subscriber.identity.sessionId,
          pageEpoch: subscriber.identity.pageEpoch,
          generation: subscriber.identity.generation,
          documentId: subscriber.identity.documentId,
          frameId: subscriber.identity.frameId,
          sequence: subscriber.highestSent,
        }),
        'stream_overflow',
      ));
    } catch {
      // The Port owner performs final removal on disconnect.
    }
  }

  #checkpointAll(): void {
    for (const subscriber of this.#subscribers.values()) {
      if (subscriber.checkpointPendingSequence !== undefined) {
        // The viewer is already staging an authoritative replacement. Queue a
        // newer checkpoint behind its commit ACK without turning ordinary
        // source churn into a terminal recovery-within-recovery error.
        this.#deferCheckpointUntilAck(subscriber, false);
      } else if (!subscriber.waitingForCheckpoint) {
        subscriber.waitingForCheckpoint = true;
        this.#checkoutTargets.add(subscriber.identity.sessionId);
      }
    }
    this.#requestCheckout();
  }

  #requestCheckout(): void {
    if (
      this.#disposed ||
      this.#checkoutInFlight ||
      this.#checkoutTargets.size === 0
    ) return;
    this.#checkoutInFlight = true;
    try {
      // The checkpoint is defined at the latest admitted sequence. Flush first
      // so no pre-checkpoint mutation is replayed again as post-checkpoint
      // catch-up against DOM that already contains it.
      this.#flushPendingEvents();
      if (this.#disposed || this.#checkoutTargets.size === 0) {
        this.#checkoutInFlight = false;
        return;
      }
      if (
        this.#sanitizer.hasConstructedStyleIdentity &&
        !this.#promoteCheckoutAcrossConstructedStyleNamespace()
      ) {
        this.#checkoutInFlight = false;
        return;
      }
      this.environment.takeFullSnapshot();
      if (this.#checkoutInFlight) {
        this.#checkoutInFlight = false;
        this.#failAll();
      }
    } catch {
      this.#checkoutInFlight = false;
      this.#failAll();
    }
  }

  #promoteCheckoutAcrossConstructedStyleNamespace(): boolean {
    let checkpointPending = false;
    for (const subscriber of this.#subscribers.values()) {
      this.#checkoutTargets.add(subscriber.identity.sessionId);
      if (subscriber.checkpointPendingSequence !== undefined) {
        this.#deferCheckpointUntilAck(subscriber, false);
        checkpointPending = true;
      } else {
        subscriber.waitingForCheckpoint = true;
      }
    }
    return !checkpointPending;
  }

  #failAll(code: 'stream_overflow' | 'stream_failed' = 'stream_failed'): void {
    for (const subscriber of this.#subscribers.values()) {
      try {
        subscriber.send(createLiveStreamError(subscriber.identity, code));
      } catch {
        // One closed Port cannot prevent every other subscriber from failing
        // closed and the shared recorder from stopping.
      }
    }
    this.dispose();
  }

  #firstIdentity(): ReplicaDocumentIdentity | undefined {
    return this.#subscribers.values().next().value?.identity;
  }

  #currentSubscriber(
    identity: ReplicaDocumentIdentity,
  ): RecorderSessionSubscriber | undefined {
    const subscriber = this.#subscribers.get(identity.sessionId);
    return subscriber && sameSubscriberGeneration(subscriber.identity, identity)
      ? subscriber
      : undefined;
  }
}

interface SourceCssRule {
  readonly type?: unknown;
  readonly cssText?: unknown;
  readonly styleSheet?: unknown;
  readonly media?: { readonly mediaText?: unknown };
  readonly layerName?: unknown;
  readonly supportsText?: unknown;
}

interface SourceStyleSheet {
  readonly cssRules?: ArrayLike<SourceCssRule>;
}

const INLINED_IMPORT_MEDIA = '@media all, (simul-inlined-import)';

/** Replaces rrweb's flattened imports with one inert, index-stable wrapper. */
export function rewriteLiveCheckpointStyleSheets(
  events: readonly unknown[],
  resolveNode: (id: number) => Node | null,
): readonly unknown[] | undefined {
  try {
    return events.map((event) => {
      if (!isRecord(event) || event.type !== 2 || !isRecord(event.data)) {
        return event;
      }
      const node = rewriteSerializedStyleNode(event.data.node, resolveNode, {
        count: 0,
        sheets: new Set<unknown>(),
      });
      if (!node) throw new Error('live_style_rewrite_failed');
      return { ...event, data: { ...event.data, node } };
    });
  } catch {
    return undefined;
  }
}

/** Canonicalizes newly serialized style/link nodes before later CSSOM events. */
export function rewriteLiveIncrementalStyleSheets(
  event: Record<string, unknown>,
  resolveNode: (id: number) => Node | null,
): Record<string, unknown> | undefined {
  try {
    if (!isRecord(event.data) || event.data.source !== 0) return event;
    if (!Array.isArray(event.data.adds)) return event;
    const budget = { count: 0, sheets: new Set<unknown>() };
    const adds: unknown[] = [];
    for (const addition of event.data.adds) {
      if (!isRecord(addition) || !('node' in addition)) {
        adds.push(addition);
        continue;
      }
      const node = rewriteSerializedStyleNode(
        addition.node,
        resolveNode,
        budget,
      );
      if (!node) return undefined;
      adds.push({ ...addition, node });
    }
    return { ...event, data: { ...event.data, adds } };
  } catch {
    return undefined;
  }
}

function rewriteSerializedStyleNode(
  input: unknown,
  resolveNode: (id: number) => Node | null,
  budget: { count: number; sheets: Set<unknown> },
): Record<string, unknown> | undefined {
  if (!isRecord(input) || !Number.isSafeInteger(input.id)) return undefined;
  const children = 'childNodes' in input
    ? Array.isArray(input.childNodes)
      ? input.childNodes.map((child) =>
          rewriteSerializedStyleNode(child, resolveNode, budget),
        )
      : undefined
    : undefined;
  if (children?.some((child) => !child)) return undefined;
  const result: Record<string, unknown> = {
    ...input,
    ...(children ? { childNodes: children } : {}),
  };
  const tagName = typeof input.tagName === 'string'
    ? input.tagName.toLowerCase()
    : undefined;
  if (
    (tagName !== 'style' && tagName !== 'link') ||
    !isRecord(input.attributes)
  ) return result;
  const sourceNode = resolveNode(Number(input.id)) as (Node & {
    readonly sheet?: SourceStyleSheet | null;
  }) | null;
  if (!sourceNode?.sheet) return result;
  const cssText = serializeSourceStyleSheet(sourceNode.sheet, budget, 0);
  // Cross-origin sheets expose `sheet` but throw on `cssRules`. rrweb cannot
  // observe their CSSOM either, so retain the already resource-stripped node.
  if (cssText === undefined) return result;
  result.attributes = {
    ...input.attributes,
    _cssText: tagName === 'link' && cssText.length === 0 ? ' ' : cssText,
  };
  return result;
}

function serializeSourceStyleSheet(
  sheet: SourceStyleSheet,
  budget: { count: number; sheets: Set<unknown> },
  depth: number,
): string | undefined {
  if (depth > 64 || budget.sheets.has(sheet)) return undefined;
  const rules = readSourceCssRules(sheet);
  if (!rules) return undefined;
  const containsImport = rules.some(isSourceImportRule);
  const containsNamespace = rules.some(isSourceNamespaceRule);
  if (
    containsNamespace &&
    (containsImport || depth > 0)
  ) {
    // Replacing an import with a grouping rule would move a following
    // namespace out of CSS's protected prelude. Likewise, a namespace from an
    // imported sheet cannot remain valid inside the grouping wrapper. Either
    // case drops rules and shifts every later CSSOM index, so fail closed.
    throw new Error('live_style_import_namespace_unsupported');
  }
  budget.sheets.add(sheet);
  try {
    const output: string[] = [];
    for (const rule of rules) {
      if (++budget.count > 50_000 || typeof rule.cssText !== 'string') {
        return undefined;
      }
      if (isSourceImportRule(rule)) {
        const importedSheet = isRecord(rule.styleSheet)
          ? rule.styleSheet as SourceStyleSheet
          : undefined;
        const imported = importedSheet
          ? serializeSourceStyleSheet(importedSheet, budget, depth + 1)
          : '';
        if (imported === undefined) return undefined;
        let body = imported;
        const mediaText = typeof rule.media?.mediaText === 'string'
          ? sanitizeCssText(rule.media.mediaText)
          : '';
        if (mediaText && mediaText.toLowerCase() !== 'all') {
          body = `@media ${mediaText} {${body}}`;
        }
        if (typeof rule.supportsText === 'string' && rule.supportsText) {
          body = `@supports ${sanitizeCssText(rule.supportsText)} {${body}}`;
        }
        if (typeof rule.layerName === 'string') {
          const layer = sanitizeCssText(rule.layerName);
          body = layer ? `@layer ${layer} {${body}}` : `@layer {${body}}`;
        }
        output.push(`${INLINED_IMPORT_MEDIA} {${body}}`);
      } else {
        output.push(sanitizeCssText(rule.cssText));
      }
    }
    return output.join('');
  } finally {
    budget.sheets.delete(sheet);
  }
}

function readSourceCssRules(
  sheet: SourceStyleSheet,
): readonly SourceCssRule[] | undefined {
  try {
    const rules = sheet.cssRules;
    return rules ? Array.from(rules) : undefined;
  } catch {
    // Accessing cssRules on a cross-origin stylesheet throws SecurityError.
    return undefined;
  }
}

function isSourceImportRule(rule: SourceCssRule): boolean {
  return (
    rule.type === 3 ||
    (typeof rule.cssText === 'string' &&
      rule.cssText.trimStart().toLowerCase().startsWith('@import'))
  );
}

function isSourceNamespaceRule(rule: SourceCssRule): boolean {
  return (
    rule.type === 10 ||
    (typeof rule.cssText === 'string' &&
      rule.cssText.trimStart().toLowerCase().startsWith('@namespace'))
  );
}

function nodeCssEventNeedsCanonicalCheckpoint(
  event: unknown,
  resolveNode: (id: number) => Node | null,
): boolean {
  if (
    !isRecord(event) ||
    event.type !== 3 ||
    !isRecord(event.data) ||
    (event.data.source !== 8 && event.data.source !== 13) ||
    !Number.isSafeInteger(event.data.id)
  ) return false;
  try {
    const node = resolveNode(Number(event.data.id)) as (Node & {
      readonly sheet?: SourceStyleSheet | null;
    }) | null;
    return Boolean(node?.sheet && sourceStyleSheetContainsImport(node.sheet));
  } catch {
    return true;
  }
}

function sourceStyleSheetContainsImport(
  sheet: SourceStyleSheet,
): boolean {
  if (!sheet.cssRules) return false;
  return Array.from(sheet.cssRules).some(isSourceImportRule);
}

export function createLiveRecorderOptions(
  emit: (event: unknown, isCheckout?: boolean) => void,
): RecorderOptions {
  return {
    emit,
    maskAllInputs: true,
    maskTextSelector: '[contenteditable]:not([contenteditable="false"])',
    maskInputFn: (value: string) => '*'.repeat(Math.min(value.length, 256)),
    maskTextFn: (value: string) => '*'.repeat(Math.min(value.length, 256)),
    inlineStylesheet: true,
    inlineImages: false,
    recordCanvas: false,
    recordCrossOriginIframes: false,
    collectFonts: false,
    userTriggeredOnInput: false,
    recordAfter: 'DOMContentLoaded',
    blockSelector: 'iframe,frame',
    sampling: {
      mousemove: false,
      mouseInteraction: false,
    },
    keepIframeSrcFn: () => false,
  };
}

function jsonByteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isViewportResizeEvent(event: Record<string, unknown>): boolean {
  return isRecord(event.data) && event.data.source === 4;
}

function sameSubscriberGeneration(
  left: ReplicaDocumentIdentity,
  right: ReplicaDocumentIdentity,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.sessionId === right.sessionId &&
    left.pageEpoch === right.pageEpoch &&
    left.generation === right.generation &&
    left.documentId === right.documentId &&
    left.frameId === right.frameId
  );
}

function canReplaceSubscriber(
  current: ReplicaDocumentIdentity,
  replacement: ReplicaDocumentIdentity,
): boolean {
  // The companion deliberately keeps one stable sessionId across refreshes.
  // Only a strictly newer binding for this exact browser document may take
  // ownership; delayed work from the old generation is rejected elsewhere.
  return (
    current.protocolVersion === replacement.protocolVersion &&
    current.sessionId === replacement.sessionId &&
    current.documentId === replacement.documentId &&
    current.frameId === replacement.frameId &&
    current.pageEpoch === current.generation &&
    replacement.pageEpoch === replacement.generation &&
    replacement.generation > current.generation
  );
}
