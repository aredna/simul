import { record } from '@rrweb/record';

import {
  type ReplicaCheckpointErrorEnvelope,
  type ReplicaCheckpointResponse,
  type ReplicaDocumentIdentity,
} from './contracts';
import { LiveRecorderSession, createLiveRecorderOptions } from './live-recorder-session';
import {
  createLiveStreamError,
  readLiveControllerMessage,
  readReplicaLivePortSessionId,
  sameReplicaDocument,
} from './live-protocol';
import {
  MAX_REPLICA_CHECKPOINT_BYTES,
  MAX_REPLICA_NODE_DEPTH,
  MAX_REPLICA_NODES,
  MAX_REPLICA_STRING_LENGTH,
  createCheckpointEnvelope,
  createCheckpointError,
  readCheckpointCommand,
} from './protocol-v2';

export const RECORDER_CAPTURE_TIMEOUT_MS = 3_000;

export interface RecorderOptions {
  readonly emit: (event: unknown, isCheckout?: boolean) => void;
  readonly maskAllInputs: true;
  readonly maskTextSelector: string;
  readonly maskInputFn: (value: string) => string;
  readonly maskTextFn: (value: string) => string;
  readonly inlineStylesheet: true;
  readonly inlineImages: false;
  readonly recordCanvas: false;
  readonly recordCrossOriginIframes: false;
  readonly collectFonts: false;
  readonly userTriggeredOnInput: false;
  readonly recordAfter: 'DOMContentLoaded';
  readonly blockSelector: string;
  readonly sampling: {
    readonly mousemove: false;
    readonly mouseInteraction: false;
  };
  readonly keepIframeSrcFn: () => false;
}

export type RecorderStart = (options: RecorderOptions) => (() => void) | undefined;

interface RecorderEnvironment {
  readonly document: Document;
  readonly window: Window;
  readonly now: () => number;
  readonly start: RecorderStart;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
}

export interface PageRecorderBridgeEnvironment {
  readonly global?: typeof globalThis & {
    __simulReplicaRecorderV2Installed?: boolean;
  };
  readonly runtime?: Pick<typeof browser.runtime, 'onConnect' | 'onMessage'>;
  readonly document?: Document;
  readonly window?: Window;
  readonly now?: () => number;
  readonly start?: RecorderStart;
  readonly takeFullSnapshot?: () => void;
  readonly preflight?: () => 'checkpoint_too_large' | 'capture_failed' | undefined;
  readonly scheduleFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
  readonly captureCheckpoint?: (
    identity: ReplicaDocumentIdentity,
  ) => Promise<ReplicaCheckpointResponse>;
}

class RecorderCaptureError extends Error {
  constructor(
    readonly code: ReplicaCheckpointErrorEnvelope['payload']['code'],
  ) {
    super(code);
    this.name = 'RecorderCaptureError';
  }
}

/**
 * Installs one idempotent, on-demand listener in Chrome's isolated world. The
 * recorder does no work until the document-targeted controller command arrives.
 */
export function installPageRecorderBridge(
  environment: PageRecorderBridgeEnvironment = {},
): void {
  const isolatedGlobal = (environment.global ?? globalThis) as typeof globalThis & {
    __simulReplicaRecorderV2Installed?: boolean;
  };
  if (isolatedGlobal.__simulReplicaRecorderV2Installed) return;
  isolatedGlobal.__simulReplicaRecorderV2Installed = true;
  const runtime = environment.runtime ?? browser.runtime;
  const sourceDocument = environment.document ?? document;
  const sourceWindow = environment.window ?? window;
  const now = environment.now ?? (() => performance.now());
  const start = environment.start ?? (record as RecorderStart);
  const takeFullSnapshot = environment.takeFullSnapshot ??
    (() => record.takeFullSnapshot(true));
  const preflight = environment.preflight ??
    (() => preflightSourceDocument(sourceDocument));
  const scheduleFrame = environment.scheduleFrame ??
    ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame = environment.cancelFrame ??
    ((handle: unknown) => cancelAnimationFrame(Number(handle)));
  const captureCheckpoint = environment.captureCheckpoint ??
    ((identity: ReplicaDocumentIdentity) => captureMaskedCheckpoint(identity));

  let captureActive = false;
  let liveSession: LiveRecorderSession | undefined;
  runtime.onConnect.addListener((port) => {
    const portSessionId = readReplicaLivePortSessionId(port.name);
    if (!portSessionId) return;
    let boundIdentity: ReplicaDocumentIdentity | undefined;
    let ownedSession: LiveRecorderSession | undefined;
    let subscribed = false;
    const onMessage = (message: unknown): void => {
      const command = readLiveControllerMessage(message, portSessionId);
      if (!command) {
        port.disconnect();
        return;
      }
      if (command.kind === 'simul:replica-v2:start-live') {
        if (boundIdentity || command.identity.sequence !== 0 || captureActive) {
          if (captureActive) {
            port.postMessage(createLiveStreamError(command.identity, 'stream_failed'));
          }
          port.disconnect();
          return;
        }
        const session = liveSession ??= new LiveRecorderSession({
          document: sourceDocument,
          window: sourceWindow,
          now,
          start,
          takeFullSnapshot,
          preflight,
          scheduleFrame,
          cancelFrame,
          resolveNode: (id) => record.mirror.getNode(id),
        });
        const subscription = session.addSubscriber(command.identity, (outgoing) => {
          try {
            port.postMessage(outgoing);
          } catch {
            session.removeSubscriber(command.identity);
            if (liveSession === session && session.subscriberCount === 0) {
              liveSession = undefined;
            }
          }
        });
        if (subscription !== 'subscribed') {
          if (liveSession === session && session.subscriberCount === 0) {
            liveSession = undefined;
          }
          if (subscription === 'rejected') {
            port.postMessage(createLiveStreamError(command.identity, 'stream_overflow'));
          }
          port.disconnect();
          return;
        }
        boundIdentity = command.identity;
        ownedSession = session;
        subscribed = true;
        return;
      }
      if (
        !boundIdentity ||
        !sameReplicaDocument(command.identity, boundIdentity)
      ) {
        port.disconnect();
        return;
      }
      if (command.kind === 'simul:replica-v2:ack') {
        ownedSession?.acknowledge(command.identity, command.identity.sequence);
      } else if (command.kind === 'simul:replica-v2:checkpoint-ack') {
        ownedSession?.acknowledgeCheckpoint(
          command.identity,
          command.identity.sequence,
        );
      } else {
        ownedSession?.requestCheckpoint(command.identity);
      }
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      port.onMessage.removeListener(onMessage);
      if (boundIdentity && subscribed && ownedSession) {
        ownedSession.removeSubscriber(boundIdentity);
      }
      if (liveSession === ownedSession && ownedSession?.subscriberCount === 0) {
        liveSession = undefined;
      }
    });
  });
  runtime.onMessage.addListener((message: unknown) => {
    const command = readCheckpointCommand(message);
    if (!command) return undefined;
    if (captureActive || (liveSession?.subscriberCount ?? 0) > 0) {
      return Promise.resolve(
        createCheckpointError(command.identity, 'capture_busy'),
      );
    }
    captureActive = true;
    return captureCheckpoint(command.identity).finally(() => {
      captureActive = false;
    });
  });
}

export async function captureMaskedCheckpoint(
  identity: ReplicaDocumentIdentity,
  environment: Partial<RecorderEnvironment> = {},
): Promise<ReplicaCheckpointResponse> {
  const sourceDocument = environment.document ?? document;
  const sourceWindow = environment.window ?? window;
  const now = environment.now ?? (() => performance.now());
  const startedAt = now();

  try {
    if (sourceWindow.top !== sourceWindow || identity.frameId !== 0) {
      return createCheckpointError(identity, 'capture_failed');
    }
    const preflightError = preflightSourceDocument(sourceDocument);
    if (preflightError) return createCheckpointError(identity, preflightError);
    const events = await captureInitialCheckpointEvents({
      document: sourceDocument,
      window: sourceWindow,
      now,
      start: environment.start ?? (record as RecorderStart),
      setTimer: environment.setTimer ?? setTimeout,
      clearTimer: environment.clearTimer ?? clearTimeout,
    });
    const documentElement = sourceDocument.documentElement;
    const body = sourceDocument.body;
    return createCheckpointEnvelope(identity, {
      events,
      captureMs: Math.max(0, now() - startedAt),
      viewportWidth: Math.max(1, sourceWindow.innerWidth),
      viewportHeight: Math.max(1, sourceWindow.innerHeight),
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
    });
  } catch (error) {
    return createCheckpointError(
      identity,
      error instanceof RecorderCaptureError ? error.code : 'capture_failed',
    );
  }
}

async function captureInitialCheckpointEvents(
  environment: RecorderEnvironment,
): Promise<readonly unknown[]> {
  return new Promise<readonly unknown[]>((resolve, reject) => {
    const events: unknown[] = [];
    let stop: (() => void) | undefined;
    let settled = false;
    const finish = (error?: RecorderCaptureError): void => {
      if (settled) return;
      settled = true;
      environment.clearTimer(timeout);
      try {
        stop?.();
      } catch {
        // Stopping after a frame navigates can fail; the bounded result still
        // wins and the isolated world will be destroyed with that document.
      }
      if (error) reject(error);
      else resolve(Object.freeze(events));
    };
    const timeout = environment.setTimer(
      () => finish(new RecorderCaptureError('capture_timeout')),
      RECORDER_CAPTURE_TIMEOUT_MS,
    );

    try {
      stop = environment.start(createLiveRecorderOptions(
        (event: unknown) => {
          if (!isRecord(event)) return;
          if (event.type !== 4 && event.type !== 2) return;
          events.push(event);
          if (event.type === 2) queueMicrotask(() => finish());
        },
      ));
      if (!stop) finish(new RecorderCaptureError('capture_failed'));
    } catch {
      finish(new RecorderCaptureError('capture_failed'));
    }
  });
}

export function preflightSourceDocument(
  sourceDocument: Document,
): 'checkpoint_too_large' | 'capture_failed' | undefined {
  if (typeof sourceDocument.nodeType !== 'number') return undefined;
  const stack: Array<{ node: Node; depth: number }> = [
    { node: sourceDocument, depth: 0 },
  ];
  let nodeCount = 0;
  let estimatedBytes = 0;

  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      nodeCount += 1;
      estimatedBytes += 96;
      if (
        nodeCount > MAX_REPLICA_NODES ||
        current.depth > MAX_REPLICA_NODE_DEPTH ||
        estimatedBytes > MAX_REPLICA_CHECKPOINT_BYTES
      ) return 'checkpoint_too_large';

      const node = current.node;
      if (node.nodeType === 3 || node.nodeType === 4) {
        const length = node.nodeValue?.length ?? 0;
        if (length > MAX_REPLICA_STRING_LENGTH) return 'checkpoint_too_large';
        estimatedBytes += length * 2;
      }

      if (node.nodeType === 1) {
        const element = node as Element;
        if (element.attributes.length > 512) return 'checkpoint_too_large';
        for (const attribute of element.attributes) {
          if (
            attribute.name.length > 128 ||
            attribute.value.length > MAX_REPLICA_STRING_LENGTH
          ) return 'checkpoint_too_large';
          estimatedBytes += (attribute.name.length + attribute.value.length) * 2;
        }
        const shadowRoot = element.shadowRoot;
        if (shadowRoot) {
          if (nodeCount + stack.length >= MAX_REPLICA_NODES) {
            return 'checkpoint_too_large';
          }
          stack.push({ node: shadowRoot, depth: current.depth + 1 });
        }
      }

      const children = node.childNodes;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (nodeCount + stack.length >= MAX_REPLICA_NODES) {
          return 'checkpoint_too_large';
        }
        const child = children.item(index);
        if (child) stack.push({ node: child, depth: current.depth + 1 });
      }
    }

    let stylesheetEntries = 0;
    for (const stylesheet of sourceDocument.styleSheets) {
      let rules: CSSRuleList;
      try {
        rules = stylesheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules) {
        stylesheetEntries += 1;
        if (stylesheetEntries > MAX_REPLICA_NODES) {
          return 'checkpoint_too_large';
        }
        if (rule.cssText.length > MAX_REPLICA_STRING_LENGTH) {
          return 'checkpoint_too_large';
        }
        estimatedBytes += rule.cssText.length * 2;
        if (estimatedBytes > MAX_REPLICA_CHECKPOINT_BYTES) {
          return 'checkpoint_too_large';
        }
      }
    }
  } catch {
    return 'capture_failed';
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
