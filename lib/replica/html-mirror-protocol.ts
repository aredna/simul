import type { ReplicaDiagnosticCode, ReplicaDocumentIdentity } from './contracts';
import {
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_NODES,
  createHtmlMirrorReadBudget,
  createHtmlMirrorRepresentabilityCollector,
  htmlMirrorJsonBytes,
  readHtmlMirrorDocumentContent,
  readHtmlMirrorNode,
  readHtmlMirrorRepresentability,
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
  type HtmlMirrorRepresentabilitySummary,
} from './html-mirror-sanitizer';
import {
  createReplicaIdentity,
  readReplicaIdentity,
} from './protocol-v2';

export const HTML_MIRROR_PROTOCOL_VERSION = 1 as const;
export const HTML_MIRROR_PORT_PREFIX = 'simul:html-mirror-v1:';
export const MAX_HTML_MIRROR_PATCH_OPERATIONS = 1_000;
export const MAX_HTML_MIRROR_UNACKED_BATCHES = 4;

export interface HtmlMirrorCheckpoint {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v1:checkpoint';
  readonly identity: ReplicaDocumentIdentity;
  readonly payload: {
    readonly root: HtmlMirrorElementNode;
    readonly adoptedStyleSheets: readonly string[];
    readonly byteLength: number;
    readonly captureMs: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly documentWidth: number;
    readonly documentHeight: number;
    readonly representability: HtmlMirrorRepresentabilitySummary;
  };
}

export type HtmlMirrorReconcileChild =
  | {
      readonly kind: 'retain';
      readonly nodeId: number;
    }
  | {
      readonly kind: 'graph';
      readonly node: HtmlMirrorNode;
    };

export type HtmlMirrorPatchOperation =
  | {
      readonly kind: 'text';
      readonly nodeId: number;
      readonly node: Extract<HtmlMirrorNode, { kind: 'text' }>;
    }
  | {
      readonly kind: 'attributes';
      readonly nodeId: number;
      readonly tagName: string;
      readonly attributes: readonly (readonly [string, string])[];
      readonly visuallyHidden?: true;
      readonly selectedImageSource?: string;
    }
  | {
      readonly kind: 'children';
      readonly nodeId: number;
      readonly children: readonly HtmlMirrorNode[];
    }
  | {
      readonly kind: 'reconcile-children';
      readonly nodeId: number;
      readonly children: readonly HtmlMirrorReconcileChild[];
    }
  | {
      readonly kind: 'dimensions';
      readonly viewportWidth: number;
      readonly viewportHeight: number;
      readonly documentWidth: number;
      readonly documentHeight: number;
    };

export interface HtmlMirrorPatchBatch {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v1:patch';
  readonly identity: ReplicaDocumentIdentity;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly operations: readonly HtmlMirrorPatchOperation[];
  readonly representability: HtmlMirrorRepresentabilitySummary;
  readonly byteLength: number;
}

export interface HtmlMirrorStreamError {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v1:error';
  readonly identity: ReplicaDocumentIdentity;
  readonly code: Extract<
    ReplicaDiagnosticCode,
    'stream_gap' | 'stream_overflow' | 'stream_failed' | 'privacy_rejected'
  >;
  readonly representability: HtmlMirrorRepresentabilitySummary;
}

export type HtmlMirrorSourceMessage =
  | HtmlMirrorCheckpoint
  | HtmlMirrorPatchBatch
  | HtmlMirrorStreamError;

export type HtmlMirrorControllerMessage =
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v1:start';
      readonly identity: ReplicaDocumentIdentity;
    }
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v1:ack';
      readonly identity: ReplicaDocumentIdentity;
    }
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v1:checkpoint-request';
      readonly identity: ReplicaDocumentIdentity;
    };

export function createHtmlMirrorPortName(sessionId: string): string {
  if (!isSafeToken(sessionId)) throw new Error('Invalid HTML mirror session.');
  return `${HTML_MIRROR_PORT_PREFIX}${sessionId}`;
}

export function readHtmlMirrorPortSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(HTML_MIRROR_PORT_PREFIX)) {
    return undefined;
  }
  const sessionId = value.slice(HTML_MIRROR_PORT_PREFIX.length);
  return isSafeToken(sessionId) ? sessionId : undefined;
}

export function createHtmlMirrorStart(
  identity: ReplicaDocumentIdentity,
): HtmlMirrorControllerMessage {
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v1:start',
    identity,
  });
}

export function createHtmlMirrorAck(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): HtmlMirrorControllerMessage {
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v1:ack',
    identity: withSequence(identity, sequence),
  });
}

export function createHtmlMirrorCheckpointRequest(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): HtmlMirrorControllerMessage {
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v1:checkpoint-request',
    identity: withSequence(identity, sequence),
  });
}

export function readHtmlMirrorControllerMessage(
  input: unknown,
  expectedSessionId: string,
  expectedDocument?: ReplicaDocumentIdentity,
): HtmlMirrorControllerMessage | undefined {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['protocolVersion', 'kind', 'identity']) ||
    input.protocolVersion !== HTML_MIRROR_PROTOCOL_VERSION ||
    (input.kind !== 'simul:html-mirror-v1:start' &&
      input.kind !== 'simul:html-mirror-v1:ack' &&
      input.kind !== 'simul:html-mirror-v1:checkpoint-request')
  ) return undefined;
  const identity = readReplicaIdentity(input.identity);
  if (
    !identity ||
    identity.sessionId !== expectedSessionId ||
    (expectedDocument && !sameDocument(identity, expectedDocument))
  ) return undefined;
  if (input.kind === 'simul:html-mirror-v1:start' && identity.sequence !== 0) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: input.kind,
    identity,
  });
}

export function createHtmlMirrorCheckpoint(
  identity: ReplicaDocumentIdentity,
  input: Omit<
    HtmlMirrorCheckpoint['payload'],
    'byteLength' | 'representability'
  > & { readonly representability?: HtmlMirrorRepresentabilitySummary },
): HtmlMirrorCheckpoint | undefined {
  const content = readHtmlMirrorDocumentContent(
    input.root,
    input.adoptedStyleSheets,
  );
  if (!content) return undefined;
  const { root, adoptedStyleSheets } = content;
  const dimensions = readDimensions(input);
  if (!dimensions) return undefined;
  const representability = readHtmlMirrorRepresentability(
    input.representability ?? createHtmlMirrorRepresentabilityCollector(),
  );
  if (!representability) return undefined;
  const byteLength = htmlMirrorJsonBytes({
    root,
    adoptedStyleSheets,
    representability,
  });
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_HTML_MIRROR_BYTES) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v1:checkpoint',
    identity,
    payload: Object.freeze({
      root,
      adoptedStyleSheets,
      byteLength,
      captureMs: boundedDuration(input.captureMs),
      ...dimensions,
      representability,
    }),
  });
}

export function createHtmlMirrorPatch(
  identity: ReplicaDocumentIdentity,
  firstSequence: number,
  lastSequence: number,
  operations: readonly HtmlMirrorPatchOperation[],
  representabilityInput: HtmlMirrorRepresentabilitySummary =
    createHtmlMirrorRepresentabilityCollector(),
): HtmlMirrorPatchBatch | undefined {
  const parsed = readOperations(operations);
  const representability = readHtmlMirrorRepresentability(
    representabilityInput,
  );
  if (
    !parsed || !representability ||
    !isSequence(firstSequence) ||
    !isSequence(lastSequence) ||
    firstSequence > lastSequence ||
    identity.sequence !== lastSequence
  ) return undefined;
  const byteLength = htmlMirrorJsonBytes({
    operations: parsed,
    representability,
  });
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_HTML_MIRROR_BYTES) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v1:patch',
    identity,
    firstSequence,
    lastSequence,
    operations: parsed,
    representability,
    byteLength,
  });
}

export function createHtmlMirrorError(
  identity: ReplicaDocumentIdentity,
  code: HtmlMirrorStreamError['code'],
  representabilityInput: HtmlMirrorRepresentabilitySummary =
    createHtmlMirrorRepresentabilityCollector(),
): HtmlMirrorStreamError {
  const representability = readHtmlMirrorRepresentability(
    representabilityInput,
  );
  if (!representability) {
    throw new Error('Invalid HTML mirror error diagnostics.');
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v1:error',
    identity,
    code,
    representability,
  });
}

/** Extension-side validation. Source-side output is never trusted directly. */
export function readHtmlMirrorSourceMessage(
  input: unknown,
  expectedIdentity: ReplicaDocumentIdentity,
): HtmlMirrorSourceMessage | undefined {
  if (
    !isRecord(input) ||
    input.protocolVersion !== HTML_MIRROR_PROTOCOL_VERSION ||
    typeof input.kind !== 'string' ||
    !('identity' in input)
  ) return undefined;
  const identity = readReplicaIdentity(input.identity);
  if (!identity || !sameDocument(identity, expectedIdentity)) return undefined;
  if (input.kind === 'simul:html-mirror-v1:error') {
    if (
      !hasExactKeys(input, [
        'protocolVersion', 'kind', 'identity', 'code', 'representability',
      ]) ||
      (input.code !== 'stream_gap' && input.code !== 'stream_overflow' &&
        input.code !== 'stream_failed' && input.code !== 'privacy_rejected')
    ) return undefined;
    const representability = readHtmlMirrorRepresentability(
      input.representability,
    );
    return representability
      ? createHtmlMirrorError(identity, input.code, representability)
      : undefined;
  }
  if (input.kind === 'simul:html-mirror-v1:checkpoint') {
    if (
      !hasExactKeys(input, ['protocolVersion', 'kind', 'identity', 'payload']) ||
      !isRecord(input.payload) ||
      !hasExactKeys(input.payload, [
        'root', 'adoptedStyleSheets', 'byteLength', 'captureMs',
        'viewportWidth', 'viewportHeight', 'documentWidth', 'documentHeight',
        'representability',
      ])
    ) return undefined;
    const checkpoint = createHtmlMirrorCheckpoint(identity, {
      root: input.payload.root as HtmlMirrorElementNode,
      adoptedStyleSheets: input.payload.adoptedStyleSheets as readonly string[],
      captureMs: input.payload.captureMs as number,
      viewportWidth: input.payload.viewportWidth as number,
      viewportHeight: input.payload.viewportHeight as number,
      documentWidth: input.payload.documentWidth as number,
      documentHeight: input.payload.documentHeight as number,
      representability: input.payload.representability as HtmlMirrorRepresentabilitySummary,
    });
    return checkpoint && checkpoint.payload.byteLength === input.payload.byteLength
      ? checkpoint
      : undefined;
  }
  if (
    input.kind !== 'simul:html-mirror-v1:patch' ||
    !hasExactKeys(input, [
      'protocolVersion', 'kind', 'identity', 'firstSequence', 'lastSequence',
      'operations', 'representability', 'byteLength',
    ]) ||
    !Array.isArray(input.operations)
  ) return undefined;
  const batch = createHtmlMirrorPatch(
    identity,
    input.firstSequence as number,
    input.lastSequence as number,
    input.operations as HtmlMirrorPatchOperation[],
    input.representability as HtmlMirrorRepresentabilitySummary,
  );
  return batch && batch.byteLength === input.byteLength ? batch : undefined;
}

function readOperations(input: readonly unknown[]): readonly HtmlMirrorPatchOperation[] | undefined {
  if (input.length < 1 || input.length > MAX_HTML_MIRROR_PATCH_OPERATIONS) {
    return undefined;
  }
  const operations: HtmlMirrorPatchOperation[] = [];
  const targetKinds = new Map<number, Set<string>>();
  let hasDimensions = false;
  const graphIds = new Set<number>();
  const graphBudget = createHtmlMirrorReadBudget(graphIds);
  for (const raw of input) {
    if (!isRecord(raw)) {
      return undefined;
    }
    if (
      raw.kind === 'dimensions' &&
      hasExactKeys(raw, [
        'kind', 'viewportWidth', 'viewportHeight', 'documentWidth',
        'documentHeight',
      ])
    ) {
      if (hasDimensions) return undefined;
      const dimensions = readDimensions(raw as unknown as {
        viewportWidth: number;
        viewportHeight: number;
        documentWidth: number;
        documentHeight: number;
      });
      if (!dimensions) return undefined;
      hasDimensions = true;
      operations.push(Object.freeze({ kind: 'dimensions', ...dimensions }));
      continue;
    }
    if (!isNodeId(raw.nodeId) || typeof raw.kind !== 'string') return undefined;
    const kinds = targetKinds.get(raw.nodeId) ?? new Set<string>();
    const structural = raw.kind === 'children' || raw.kind === 'reconcile-children';
    if (
      kinds.has(raw.kind) ||
      structural && (kinds.has('children') || kinds.has('reconcile-children')) ||
      raw.kind === 'text' && kinds.size > 0 ||
      raw.kind !== 'text' && kinds.has('text')
    ) return undefined;
    kinds.add(raw.kind);
    targetKinds.set(raw.nodeId, kinds);
    if (raw.kind === 'text' && hasExactKeys(raw, ['kind', 'nodeId', 'node'])) {
      const node = readHtmlMirrorNode(raw.node, graphIds, 0, graphBudget);
      if (!node || node.kind !== 'text' || node.id !== raw.nodeId) return undefined;
      operations.push(Object.freeze({ kind: 'text', nodeId: raw.nodeId, node }));
      continue;
    }
    if (
      raw.kind === 'attributes' &&
      hasExactKeysWithOptional(
        raw,
        ['kind', 'nodeId', 'tagName', 'attributes'],
        ['visuallyHidden', 'selectedImageSource'],
      ) &&
      typeof raw.tagName === 'string' &&
      Array.isArray(raw.attributes)
    ) {
      if (
        (raw.visuallyHidden !== undefined && raw.visuallyHidden !== true) ||
        (raw.selectedImageSource !== undefined &&
          typeof raw.selectedImageSource !== 'string')
      ) return undefined;
      const sentinel = readHtmlMirrorNode({
        kind: 'element',
        id: raw.nodeId,
        namespace: 'html',
        tagName: raw.tagName,
        attributes: raw.attributes,
        children: [],
        ...(raw.visuallyHidden === true ? { visuallyHidden: true } : {}),
        ...(typeof raw.selectedImageSource === 'string'
          ? { selectedImageSource: raw.selectedImageSource }
          : {}),
      }, graphIds, 0, graphBudget);
      if (!sentinel || sentinel.kind !== 'element') return undefined;
      operations.push(Object.freeze({
        kind: 'attributes',
        nodeId: raw.nodeId,
        tagName: sentinel.tagName,
        attributes: sentinel.attributes,
        ...(sentinel.visuallyHidden ? { visuallyHidden: true as const } : {}),
        ...(sentinel.selectedImageSource
          ? { selectedImageSource: sentinel.selectedImageSource }
          : {}),
      }));
      continue;
    }
    if (
      raw.kind === 'children' &&
      hasExactKeys(raw, ['kind', 'nodeId', 'children']) &&
      Array.isArray(raw.children)
    ) {
      const children: HtmlMirrorNode[] = [];
      for (const child of raw.children) {
        const node = readHtmlMirrorNode(child, graphIds, 0, graphBudget);
        if (!node) return undefined;
        children.push(node);
      }
      operations.push(Object.freeze({
        kind: 'children',
        nodeId: raw.nodeId,
        children: Object.freeze(children),
      }));
      continue;
    }
    if (
      raw.kind === 'reconcile-children' &&
      hasExactKeys(raw, ['kind', 'nodeId', 'children']) &&
      Array.isArray(raw.children) &&
      raw.children.length <= MAX_HTML_MIRROR_NODES
    ) {
      const children: HtmlMirrorReconcileChild[] = [];
      for (const child of raw.children) {
        if (!isRecord(child) || typeof child.kind !== 'string') return undefined;
        if (
          child.kind === 'retain' &&
          hasExactKeys(child, ['kind', 'nodeId']) &&
          isNodeId(child.nodeId) &&
          !graphIds.has(child.nodeId)
        ) {
          graphBudget.nodes += 1;
          if (graphBudget.nodes > MAX_HTML_MIRROR_NODES) return undefined;
          graphIds.add(child.nodeId);
          children.push(Object.freeze({
            kind: 'retain',
            nodeId: child.nodeId,
          }));
          continue;
        }
        if (
          child.kind === 'graph' &&
          hasExactKeys(child, ['kind', 'node'])
        ) {
          const node = readHtmlMirrorNode(child.node, graphIds, 0, graphBudget);
          if (!node) return undefined;
          children.push(Object.freeze({ kind: 'graph', node }));
          continue;
        }
        return undefined;
      }
      operations.push(Object.freeze({
        kind: 'reconcile-children',
        nodeId: raw.nodeId,
        children: Object.freeze(children),
      }));
      continue;
    }
    return undefined;
  }
  return Object.freeze(operations);
}

function readDimensions(input: {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
}): Omit<
  HtmlMirrorCheckpoint['payload'],
  'root' | 'adoptedStyleSheets' | 'byteLength' | 'captureMs' | 'representability'
> | undefined {
  if (
    !isDimension(input.viewportWidth) ||
    !isDimension(input.viewportHeight) ||
    !isDimension(input.documentWidth) ||
    !isDimension(input.documentHeight)
  ) return undefined;
  return {
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    documentWidth: input.documentWidth,
    documentHeight: input.documentHeight,
  };
}

function withSequence(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): ReplicaDocumentIdentity {
  return createReplicaIdentity({
    sessionId: identity.sessionId,
    pageEpoch: identity.pageEpoch,
    generation: identity.generation,
    documentId: identity.documentId,
    frameId: identity.frameId,
    sequence,
  });
}

function sameDocument(
  left: ReplicaDocumentIdentity,
  right: ReplicaDocumentIdentity,
): boolean {
  return left.protocolVersion === right.protocolVersion &&
    left.sessionId === right.sessionId &&
    left.pageEpoch === right.pageEpoch &&
    left.generation === right.generation &&
    left.documentId === right.documentId &&
    left.frameId === right.frameId;
}

function boundedDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(60_000, value)) : 0;
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= 1 && value <= 1_000_000;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isNodeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}
