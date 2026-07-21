import type { ReplicaDiagnosticCode, ReplicaDocumentIdentity } from './contracts';
import {
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
  MAX_HTML_MIRROR_NODES,
  createHtmlMirrorReadBudget,
  createHtmlMirrorRepresentabilityCollector,
  htmlMirrorJsonBytes,
  readHtmlMirrorDocumentContent,
  readHtmlMirrorCanvasBackgroundColor,
  readHtmlMirrorNode,
  readHtmlMirrorRepresentability,
  type HtmlMirrorElementNode,
  type HtmlMirrorNamespace,
  type HtmlMirrorControlText,
  type HtmlMirrorNode,
  type HtmlMirrorRepresentabilitySummary,
} from './html-mirror-sanitizer';
import {
  createReplicaIdentity,
  readReplicaIdentity,
} from './protocol-v2';
import {
  isSelectableReplicaFidelityPolicy,
  type SelectableReplicaFidelityPolicy,
} from './fidelity-policy';

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
    readonly documentMode: 'standards' | 'quirks';
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
      readonly namespace: HtmlMirrorNamespace;
      readonly tagName: string;
      readonly attributes: readonly (readonly [string, string])[];
      readonly visuallyHidden?: true;
      readonly selectedImageSource?: string;
      readonly controlText?: HtmlMirrorControlText;
      readonly canvasBackgroundColor?: string;
      readonly resolvedStyleSheetText?: string;
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
      readonly canvasBackgroundColor?: string;
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
      readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
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
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): HtmlMirrorControllerMessage {
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v1:start',
    identity,
    fidelityPolicy,
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
    !hasExactKeysWithOptional(
      input,
      ['protocolVersion', 'kind', 'identity'],
      ['fidelityPolicy'],
    ) ||
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
  if (
    input.kind === 'simul:html-mirror-v1:start' &&
    (
      !hasExactKeys(input, [
        'protocolVersion', 'kind', 'identity', 'fidelityPolicy',
      ]) ||
      !isSelectableReplicaFidelityPolicy(input.fidelityPolicy)
    )
  ) return undefined;
  if (
    input.kind !== 'simul:html-mirror-v1:start' &&
    Object.hasOwn(input, 'fidelityPolicy')
  ) return undefined;
  if (input.kind === 'simul:html-mirror-v1:start') {
    return Object.freeze({
      protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
      kind: input.kind,
      identity,
      fidelityPolicy: input.fidelityPolicy as SelectableReplicaFidelityPolicy,
    });
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
    'byteLength' | 'representability' | 'documentMode'
  > & {
    readonly documentMode?: 'standards' | 'quirks';
    readonly representability?: HtmlMirrorRepresentabilitySummary;
  },
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): HtmlMirrorCheckpoint | undefined {
  const content = readHtmlMirrorDocumentContent(
    input.root,
    input.adoptedStyleSheets,
    fidelityPolicy,
  );
  if (!content) return undefined;
  const { root, adoptedStyleSheets } = content;
  const documentMode = input.documentMode === 'quirks'
    ? 'quirks'
    : input.documentMode === undefined || input.documentMode === 'standards'
      ? 'standards'
      : undefined;
  if (!documentMode) return undefined;
  const dimensions = readDimensions(input);
  if (!dimensions) return undefined;
  const representability = readHtmlMirrorRepresentability(
    input.representability ?? createHtmlMirrorRepresentabilityCollector(),
  );
  if (!representability) return undefined;
  const receiverRepresentability = mergeReceiverResourceInventory(
    representability,
    inventoryDocumentResources(root, adoptedStyleSheets),
  );
  const byteLength = htmlMirrorJsonBytes({
    root,
    adoptedStyleSheets,
    documentMode,
    representability: receiverRepresentability,
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
      documentMode,
      byteLength,
      captureMs: boundedDuration(input.captureMs),
      ...dimensions,
      representability: receiverRepresentability,
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
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): HtmlMirrorPatchBatch | undefined {
  const parsed = readOperations(operations, fidelityPolicy);
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
  const receiverRepresentability = mergeReceiverResourceInventory(
    representability,
    inventoryOperationResources(parsed),
  );
  const byteLength = htmlMirrorJsonBytes({
    operations: parsed,
    representability: receiverRepresentability,
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
    representability: receiverRepresentability,
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
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
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
        'root', 'adoptedStyleSheets', 'documentMode', 'byteLength', 'captureMs',
        'viewportWidth', 'viewportHeight', 'documentWidth', 'documentHeight',
        'representability',
      ])
    ) return undefined;
    const checkpoint = createHtmlMirrorCheckpoint(identity, {
      root: input.payload.root as HtmlMirrorElementNode,
      adoptedStyleSheets: input.payload.adoptedStyleSheets as readonly string[],
      documentMode: input.payload.documentMode as 'standards' | 'quirks',
      captureMs: input.payload.captureMs as number,
      viewportWidth: input.payload.viewportWidth as number,
      viewportHeight: input.payload.viewportHeight as number,
      documentWidth: input.payload.documentWidth as number,
      documentHeight: input.payload.documentHeight as number,
      representability: input.payload.representability as HtmlMirrorRepresentabilitySummary,
    }, fidelityPolicy);
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
    fidelityPolicy,
  );
  return batch && batch.byteLength === input.byteLength ? batch : undefined;
}

function readOperations(
  input: readonly unknown[],
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): readonly HtmlMirrorPatchOperation[] | undefined {
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
      hasExactKeysWithOptional(
        raw,
        [
          'kind', 'viewportWidth', 'viewportHeight', 'documentWidth',
          'documentHeight',
        ],
        ['canvasBackgroundColor'],
      )
    ) {
      if (hasDimensions) return undefined;
      const dimensions = readDimensions(raw as unknown as {
        viewportWidth: number;
        viewportHeight: number;
        documentWidth: number;
        documentHeight: number;
        canvasBackgroundColor?: unknown;
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
      const node = readHtmlMirrorNode(
        raw.node,
        graphIds,
        0,
        graphBudget,
        false,
        false,
        false,
        false,
        false,
        fidelityPolicy,
      );
      if (!node || node.kind !== 'text' || node.id !== raw.nodeId) return undefined;
      operations.push(Object.freeze({ kind: 'text', nodeId: raw.nodeId, node }));
      continue;
    }
    if (
      raw.kind === 'attributes' &&
      hasExactKeysWithOptional(
        raw,
        ['kind', 'nodeId', 'namespace', 'tagName', 'attributes'],
        [
          'visuallyHidden', 'selectedImageSource', 'controlText',
          'canvasBackgroundColor', 'resolvedStyleSheetText',
        ],
      ) &&
      (raw.namespace === 'html' || raw.namespace === 'svg' ||
        raw.namespace === 'mathml') &&
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
        namespace: raw.namespace,
        tagName: raw.tagName,
        attributes: raw.attributes,
        children: [],
        ...(raw.visuallyHidden === true ? { visuallyHidden: true } : {}),
        ...(typeof raw.selectedImageSource === 'string'
          ? { selectedImageSource: raw.selectedImageSource }
          : {}),
        ...(raw.controlText !== undefined
          ? { controlText: raw.controlText }
          : {}),
        ...(raw.canvasBackgroundColor !== undefined
          ? { canvasBackgroundColor: raw.canvasBackgroundColor }
          : {}),
        ...(raw.resolvedStyleSheetText !== undefined
          ? { resolvedStyleSheetText: raw.resolvedStyleSheetText }
          : {}),
      }, graphIds, 0, graphBudget, false, false, false, false, false, fidelityPolicy);
      if (!sentinel || sentinel.kind !== 'element') return undefined;
      operations.push(Object.freeze({
        kind: 'attributes',
        nodeId: raw.nodeId,
        namespace: sentinel.namespace,
        tagName: sentinel.tagName,
        attributes: sentinel.attributes,
        ...(sentinel.visuallyHidden ? { visuallyHidden: true as const } : {}),
        ...(sentinel.selectedImageSource
          ? { selectedImageSource: sentinel.selectedImageSource }
          : {}),
        ...(sentinel.controlText
          ? { controlText: sentinel.controlText }
          : {}),
        ...(sentinel.canvasBackgroundColor
          ? { canvasBackgroundColor: sentinel.canvasBackgroundColor }
          : {}),
        ...(sentinel.resolvedStyleSheetText !== undefined
          ? { resolvedStyleSheetText: sentinel.resolvedStyleSheetText }
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
        const node = readHtmlMirrorNode(
          child,
          graphIds,
          0,
          graphBudget,
          false,
          false,
          false,
          false,
          false,
          fidelityPolicy,
        );
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
          const node = readHtmlMirrorNode(
            child.node,
            graphIds,
            0,
            graphBudget,
            false,
            false,
            false,
            false,
            false,
            fidelityPolicy,
          );
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

interface ReceiverResourceInventory {
  requestCapable: number;
  preservedStyleSheets: number;
  preservedSvgResources: number;
}

function inventoryDocumentResources(
  root: HtmlMirrorElementNode,
  adoptedStyleSheets: readonly string[],
): ReceiverResourceInventory {
  const inventory = emptyResourceInventory();
  inventoryNodeResources(root, inventory);
  for (const cssText of adoptedStyleSheets) {
    incrementInventory(inventory, 'preservedStyleSheets');
    addRequestUrls(inventory, cssText);
  }
  return inventory;
}

function inventoryOperationResources(
  operations: readonly HtmlMirrorPatchOperation[],
): ReceiverResourceInventory {
  const inventory = emptyResourceInventory();
  for (const operation of operations) {
    if (operation.kind === 'attributes') {
      inventoryElementResources({
        namespace: operation.namespace,
        tagName: operation.tagName,
        attributes: operation.attributes,
        selectedImageSource: operation.selectedImageSource,
        resolvedStyleSheetText: operation.resolvedStyleSheetText,
      }, inventory);
    } else if (operation.kind === 'children') {
      for (const child of operation.children) {
        inventoryNodeResources(child, inventory);
      }
    } else if (operation.kind === 'reconcile-children') {
      for (const child of operation.children) {
        if (child.kind === 'graph') inventoryNodeResources(child.node, inventory);
      }
    }
  }
  return inventory;
}

function inventoryNodeResources(
  node: HtmlMirrorNode,
  inventory: ReceiverResourceInventory,
): void {
  if (node.kind === 'text') return;
  inventoryElementResources(node, inventory);
  const resolvedStyle = node.tagName === 'style' &&
    node.resolvedStyleSheetText !== undefined;
  for (const child of node.children) {
    if (resolvedStyle && child.kind === 'text') continue;
    inventoryNodeResources(child, inventory);
  }
  if (!node.shadowRoot) return;
  for (const cssText of node.shadowRoot.adoptedStyleSheets) {
    incrementInventory(inventory, 'preservedStyleSheets');
    addRequestUrls(inventory, cssText);
  }
  for (const child of node.shadowRoot.children) {
    inventoryNodeResources(child, inventory);
  }
}

function inventoryElementResources(
  node: Pick<
    HtmlMirrorElementNode,
    | 'namespace'
    | 'tagName'
    | 'attributes'
    | 'selectedImageSource'
    | 'resolvedStyleSheetText'
  >,
  inventory: ReceiverResourceInventory,
): void {
  const attributes = Object.fromEntries(node.attributes);
  const resolvedStyle = node.resolvedStyleSheetText;
  if (
    node.tagName === 'style' ||
    (node.tagName === 'link' && attributes.rel === 'stylesheet')
  ) {
    incrementInventory(inventory, 'preservedStyleSheets');
  }
  if (resolvedStyle !== undefined) addRequestUrls(inventory, resolvedStyle);
  if (node.selectedImageSource) {
    addRequestUrls(inventory, node.selectedImageSource);
  }
  for (const [name, value] of node.attributes) {
    if (
      resolvedStyle !== undefined && node.tagName === 'link' && name === 'href' ||
      node.selectedImageSource !== undefined &&
        (name === 'src' || name === 'srcset' || name === 'sizes')
    ) continue;
    if (attributeCanRequest(node.namespace, node.tagName, name)) {
      addRequestUrls(inventory, value);
    }
    if (
      node.namespace === 'svg' &&
      (
        (name === 'href' || name === 'xlink:href') ||
        SVG_PRESENTATION_RESOURCE_ATTRIBUTES.has(name)
      )
    ) {
      incrementInventory(inventory, 'preservedSvgResources');
    } else if (
      (name === 'src' || name === 'poster') &&
      /^data:image\/svg\+xml/iu.test(value)
    ) {
      incrementInventory(inventory, 'preservedSvgResources');
    }
  }
}

const SVG_PRESENTATION_RESOURCE_ATTRIBUTES = new Set([
  'clip-path', 'cursor', 'fill', 'filter', 'marker', 'marker-end',
  'marker-mid', 'marker-start', 'mask', 'stroke',
]);

function attributeCanRequest(
  namespace: HtmlMirrorNamespace,
  tagName: string,
  name: string,
): boolean {
  if (name === 'style' || name === 'background' || name === 'poster') return true;
  if (name === 'src' || name === 'srcset') return tagName === 'img' ||
    tagName === 'source' || tagName === 'image';
  if (name === 'href' || name === 'xlink:href') {
    return tagName === 'link' || namespace === 'svg' &&
      (tagName === 'image' || tagName === 'feimage' || tagName === 'use');
  }
  return namespace === 'svg' && SVG_PRESENTATION_RESOURCE_ATTRIBUTES.has(name);
}

function addRequestUrls(
  inventory: ReceiverResourceInventory,
  value: string,
): void {
  const matches = value.match(/https?:\/\//giu)?.length ?? 0;
  for (let index = 0; index < matches; index += 1) {
    incrementInventory(inventory, 'requestCapable');
  }
}

function emptyResourceInventory(): ReceiverResourceInventory {
  return {
    requestCapable: 0,
    preservedStyleSheets: 0,
    preservedSvgResources: 0,
  };
}

function incrementInventory(
  inventory: ReceiverResourceInventory,
  key: keyof ReceiverResourceInventory,
): void {
  inventory[key] = Math.min(
    MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
    inventory[key] + 1,
  );
}

function mergeReceiverResourceInventory(
  reported: HtmlMirrorRepresentabilitySummary,
  inventory: ReceiverResourceInventory,
): HtmlMirrorRepresentabilitySummary {
  return Object.freeze({
    ...reported,
    preservedStyleSheetCount: Math.max(
      reported.preservedStyleSheetCount,
      inventory.preservedStyleSheets,
    ),
    preservedSvgResourceCount: Math.max(
      reported.preservedSvgResourceCount,
      inventory.preservedSvgResources,
    ),
    replicaRequestCapableResourceCount: Math.max(
      reported.replicaRequestCapableResourceCount,
      inventory.requestCapable,
    ),
  });
}

function readDimensions(input: {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  canvasBackgroundColor?: unknown;
}): Readonly<{
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  canvasBackgroundColor?: string;
}> | undefined {
  if (
    !isDimension(input.viewportWidth) ||
    !isDimension(input.viewportHeight) ||
    !isDimension(input.documentWidth) ||
    !isDimension(input.documentHeight)
  ) return undefined;
  const hasCanvasBackground = Object.hasOwn(input, 'canvasBackgroundColor');
  const canvasBackgroundColor = hasCanvasBackground
    ? readHtmlMirrorCanvasBackgroundColor(input.canvasBackgroundColor)
    : undefined;
  if (hasCanvasBackground && !canvasBackgroundColor) return undefined;
  return {
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    documentWidth: input.documentWidth,
    documentHeight: input.documentHeight,
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
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
