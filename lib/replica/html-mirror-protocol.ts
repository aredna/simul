import type { ReplicaDiagnosticCode, ReplicaDocumentIdentity } from './contracts';
import {
  MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS,
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_DEPTH,
  MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
  MAX_HTML_MIRROR_NODES,
  MAX_HTML_MIRROR_STRING,
  createHtmlMirrorReadBudget,
  createHtmlMirrorRepresentabilityCollector,
  htmlMirrorJsonBytes,
  readHtmlMirrorDocumentContent,
  readHtmlMirrorCanvasBackgroundColor,
  readHtmlMirrorSelectedOptionIndexes,
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
} from './replica-identity';
import {
  isSelectableReplicaFidelityPolicy,
  type SelectableReplicaFidelityPolicy,
} from './fidelity-policy';
import { hasExactKeysWithOptional } from '../exact-record';
import {
  DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
  readHtmlMirrorLimitSettings,
  type HtmlMirrorLimitSettings,
} from './html-mirror-limits';

export const HTML_MIRROR_PROTOCOL_VERSION = 2 as const;
export const HTML_MIRROR_PORT_PREFIX = 'simul:html-mirror-v2:';
export const MAX_HTML_MIRROR_PATCH_OPERATIONS = 1_000;
export const MAX_HTML_MIRROR_UNACKED_BATCHES = 4;

export interface HtmlMirrorCheckpoint {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v2:checkpoint';
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
      readonly selectedOptionIndexes?: readonly number[];
      readonly selectPickerOpen?: true;
      readonly selectPresentationStyle?: string;
      readonly controlText?: HtmlMirrorControlText;
      readonly canvasBackgroundColor?: string;
      readonly resolvedStyleSheetText?: string;
      readonly customElementDefined?: true;
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
  readonly kind: 'simul:html-mirror-v2:patch';
  readonly identity: ReplicaDocumentIdentity;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly operations: readonly HtmlMirrorPatchOperation[];
  readonly representability: HtmlMirrorRepresentabilitySummary;
  readonly byteLength: number;
}

export interface HtmlMirrorScrollState {
  readonly scrollTarget: 'document' | 'nested';
  readonly scrollX: number;
  readonly scrollY: number;
  readonly maxScrollX: number;
  readonly maxScrollY: number;
  readonly nestedOwnerKey?: number;
  readonly nestedOwnerOrdinal?: number;
  readonly documentScrollX: number;
  readonly documentScrollY: number;
  readonly documentMaxScrollX: number;
  readonly documentMaxScrollY: number;
}

export interface HtmlMirrorScrollUpdate {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v2:scroll';
  readonly identity: ReplicaDocumentIdentity;
  readonly scroll: HtmlMirrorScrollState;
}

export interface HtmlMirrorStreamError {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v2:error';
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
  | HtmlMirrorScrollUpdate
  | HtmlMirrorStreamError;

export type HtmlMirrorControllerMessage =
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v2:start';
      readonly identity: ReplicaDocumentIdentity;
      readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
      /** The size limits both sides of this mirror use (D64). */
      readonly limits: HtmlMirrorLimitSettings;
      /** Advanced "Show everything (testing)": no privacy filtering (D75). */
      readonly showEverything: boolean;
    }
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v2:ack';
      readonly identity: ReplicaDocumentIdentity;
    }
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v2:checkpoint-request';
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
  limits: HtmlMirrorLimitSettings = DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
  showEverything = false,
): HtmlMirrorControllerMessage {
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v2:start',
    identity,
    fidelityPolicy,
    limits,
    showEverything,
  });
}

export function createHtmlMirrorAck(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): HtmlMirrorControllerMessage {
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v2:ack',
    identity: withSequence(identity, sequence),
  });
}

export function createHtmlMirrorCheckpointRequest(
  identity: ReplicaDocumentIdentity,
  sequence: number,
): HtmlMirrorControllerMessage {
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v2:checkpoint-request',
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
      ['fidelityPolicy', 'limits', 'showEverything'],
    ) ||
    input.protocolVersion !== HTML_MIRROR_PROTOCOL_VERSION ||
    (input.kind !== 'simul:html-mirror-v2:start' &&
      input.kind !== 'simul:html-mirror-v2:ack' &&
      input.kind !== 'simul:html-mirror-v2:checkpoint-request')
  ) return undefined;
  const identity = readReplicaIdentity(input.identity);
  if (
    !identity ||
    identity.sessionId !== expectedSessionId ||
    (expectedDocument && !sameDocument(identity, expectedDocument))
  ) return undefined;
  if (input.kind === 'simul:html-mirror-v2:start' && identity.sequence !== 0) {
    return undefined;
  }
  // A start without limits (an older panel) uses the defaults.
  const limits = input.kind === 'simul:html-mirror-v2:start'
    ? (input.limits === undefined
      ? DEFAULT_HTML_MIRROR_LIMIT_SETTINGS
      : readHtmlMirrorLimitSettings(input.limits))
    : undefined;
  if (
    input.kind === 'simul:html-mirror-v2:start' &&
    (
      !hasExactKeysWithOptional(input, [
        'protocolVersion', 'kind', 'identity', 'fidelityPolicy',
      ], ['limits', 'showEverything']) ||
      !isSelectableReplicaFidelityPolicy(input.fidelityPolicy) ||
      !limits ||
      (input.showEverything !== undefined &&
        typeof input.showEverything !== 'boolean')
    )
  ) return undefined;
  if (
    input.kind !== 'simul:html-mirror-v2:start' &&
    (
      Object.hasOwn(input, 'fidelityPolicy') ||
      Object.hasOwn(input, 'limits') ||
      Object.hasOwn(input, 'showEverything')
    )
  ) return undefined;
  if (input.kind === 'simul:html-mirror-v2:start') {
    return Object.freeze({
      protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
      kind: input.kind,
      identity,
      fidelityPolicy: input.fidelityPolicy as SelectableReplicaFidelityPolicy,
      limits: limits!,
      // An older panel sends no switch; it filters as before.
      showEverything: input.showEverything === true,
    });
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: input.kind,
    identity,
  });
}

const ADOPTED_STYLE_SHEETS_KEY = 'adoptedStyleSheets';
const ADOPTED_STYLE_SHEET_TEXTS_KEY = 'adoptedStyleSheetTexts';

/**
 * The wire form of a checkpoint or patch sends each distinct adopted
 * stylesheet once (D84). Web components adopt the same few sheets into every
 * shadow root: sent per root, Reddit's feed turned 0.34 MB of CSS into 23 MB,
 * and a longer feed or a thread could not be mirrored at all. Every
 * `adoptedStyleSheets` list becomes indexes into one table of texts; a
 * message without adopted sheets is sent unchanged.
 */
export function encodeHtmlMirrorWireMessage(message: unknown): unknown {
  const texts: string[] = [];
  const indexes = new Map<string, number>();
  const encode = (value: unknown, key?: string): unknown => {
    if (Array.isArray(value)) {
      if (key !== ADOPTED_STYLE_SHEETS_KEY) {
        return value.map((item) => encode(item));
      }
      return value.map((cssText: string) => {
        let index = indexes.get(cssText);
        if (index === undefined) {
          index = texts.length;
          texts.push(cssText);
          indexes.set(cssText, index);
        }
        return index;
      });
    }
    if (typeof value !== 'object' || value === null) return value;
    const copy: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(value)) {
      copy[name] = encode(child, name);
    }
    return copy;
  };
  const encoded = encode(message);
  return texts.length === 0
    ? message
    : { ...(encoded as object), [ADOPTED_STYLE_SHEET_TEXTS_KEY]: texts };
}

/**
 * Restores the adopted stylesheet texts of a wire message in place, before
 * the message is validated. Anything malformed (a table that is not a list
 * of bounded strings, an index outside it, an unused entry, nesting beyond
 * the mirror's depth) makes the whole message invalid.
 */
export function decodeHtmlMirrorWireMessage(input: unknown): unknown {
  if (!isRecord(input) || !Object.hasOwn(input, ADOPTED_STYLE_SHEET_TEXTS_KEY)) {
    return input;
  }
  const texts = input[ADOPTED_STYLE_SHEET_TEXTS_KEY];
  if (
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS ||
    !texts.every((text) =>
      typeof text === 'string' && text.length <= MAX_HTML_MIRROR_STRING)
  ) return undefined;
  const used = new Set<number>();
  const maxDepth = MAX_HTML_MIRROR_DEPTH * 4 + 32;
  const decode = (value: unknown, depth: number): boolean => {
    if (depth > maxDepth) return false;
    if (Array.isArray(value)) {
      return value.every((item) => decode(item, depth + 1));
    }
    if (!isRecord(value)) return true;
    for (const [name, child] of Object.entries(value)) {
      if (name === ADOPTED_STYLE_SHEETS_KEY && Array.isArray(child)) {
        for (let index = 0; index < child.length; index += 1) {
          const entry = child[index];
          if (
            !Number.isSafeInteger(entry) ||
            (entry as number) < 0 ||
            (entry as number) >= texts.length
          ) return false;
          used.add(entry as number);
          child[index] = texts[entry as number];
        }
      } else if (!decode(child, depth + 1)) {
        return false;
      }
    }
    return true;
  };
  delete input[ADOPTED_STYLE_SHEET_TEXTS_KEY];
  return decode(input, 0) && used.size === texts.length ? input : undefined;
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
  const byteLength = htmlMirrorJsonBytes(encodeHtmlMirrorWireMessage({
    root,
    adoptedStyleSheets,
    documentMode,
    representability: receiverRepresentability,
  }));
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_HTML_MIRROR_BYTES) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v2:checkpoint',
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
  const byteLength = htmlMirrorJsonBytes(encodeHtmlMirrorWireMessage({
    operations: parsed,
    representability: receiverRepresentability,
  }));
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_HTML_MIRROR_BYTES) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v2:patch',
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
    kind: 'simul:html-mirror-v2:error',
    identity,
    code,
    representability,
  });
}

export function createHtmlMirrorScrollUpdate(
  identity: ReplicaDocumentIdentity,
  input: HtmlMirrorScrollState,
): HtmlMirrorScrollUpdate | undefined {
  const scroll = readScrollState(input);
  if (!scroll) return undefined;
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v2:scroll',
    identity,
    scroll,
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
  if (input.kind === 'simul:html-mirror-v2:error') {
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
  if (input.kind === 'simul:html-mirror-v2:scroll') {
    if (
      !hasExactKeys(input, ['protocolVersion', 'kind', 'identity', 'scroll']) ||
      !isRecord(input.scroll)
    ) return undefined;
    return createHtmlMirrorScrollUpdate(
      identity,
      input.scroll as unknown as HtmlMirrorScrollState,
    );
  }
  if (input.kind === 'simul:html-mirror-v2:checkpoint') {
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
    input.kind !== 'simul:html-mirror-v2:patch' ||
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
          'visuallyHidden', 'selectedImageSource', 'selectedOptionIndexes',
          'selectPickerOpen', 'selectPresentationStyle', 'controlText',
          'canvasBackgroundColor', 'resolvedStyleSheetText',
          'customElementDefined',
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
          typeof raw.selectedImageSource !== 'string') ||
        (raw.selectedOptionIndexes !== undefined &&
          !Array.isArray(raw.selectedOptionIndexes)) ||
        (raw.selectPresentationStyle !== undefined &&
          typeof raw.selectPresentationStyle !== 'string') ||
        (raw.selectPickerOpen !== undefined && raw.selectPickerOpen !== true)
      ) return undefined;
      const selectedOptionIndexes = readHtmlMirrorSelectedOptionIndexes(
        raw.selectedOptionIndexes,
        raw.tagName,
      );
      if (
        raw.selectedOptionIndexes !== undefined &&
        selectedOptionIndexes === undefined
      ) return undefined;
      if (selectedOptionIndexes) {
        graphBudget.bytes += selectedOptionIndexes.length * 8 + 16;
        if (graphBudget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
      }
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
        ...(raw.selectPickerOpen === true
          ? { selectPickerOpen: true }
          : {}),
        ...(typeof raw.selectPresentationStyle === 'string'
          ? { selectPresentationStyle: raw.selectPresentationStyle }
          : {}),
        ...(raw.canvasBackgroundColor !== undefined
          ? { canvasBackgroundColor: raw.canvasBackgroundColor }
          : {}),
        ...(raw.resolvedStyleSheetText !== undefined
          ? { resolvedStyleSheetText: raw.resolvedStyleSheetText }
          : {}),
        ...(raw.customElementDefined !== undefined
          ? { customElementDefined: raw.customElementDefined }
          : {}),
      }, graphIds, 0, graphBudget, false, false, false, false, false,
      fidelityPolicy,
      raw.tagName === 'option' || raw.tagName === 'optgroup'
        ? 'select'
        : false,
      true);
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
        ...(selectedOptionIndexes !== undefined
          ? { selectedOptionIndexes }
          : {}),
        ...(sentinel.selectPickerOpen
          ? { selectPickerOpen: true as const }
          : {}),
        ...(sentinel.selectPresentationStyle
          ? { selectPresentationStyle: sentinel.selectPresentationStyle }
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
        ...(sentinel.customElementDefined
          ? { customElementDefined: true as const }
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
          detachedNativeSelectParent(child),
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
            detachedNativeSelectParent(child.node),
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

function detachedNativeSelectParent(input: unknown): false | 'select' {
  return isRecord(input) &&
    (input.tagName === 'option' || input.tagName === 'optgroup')
    ? 'select'
    : false;
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
  const styleUrls = new Map<string, number>();
  inventoryNodeResources(root, inventory, styleUrls);
  for (const cssText of adoptedStyleSheets) {
    inventoryAdoptedStyleSheet(inventory, cssText, styleUrls);
  }
  return inventory;
}

/** Counts one use of an adopted sheet; its URLs are scanned once (D84). */
function inventoryAdoptedStyleSheet(
  inventory: ReceiverResourceInventory,
  cssText: string,
  styleUrls: Map<string, number>,
): void {
  incrementInventory(inventory, 'preservedStyleSheets');
  let urls = styleUrls.get(cssText);
  if (urls === undefined) {
    urls = countRequestUrls(cssText);
    styleUrls.set(cssText, urls);
  }
  for (let index = 0; index < urls; index += 1) {
    incrementInventory(inventory, 'requestCapable');
  }
}

function inventoryOperationResources(
  operations: readonly HtmlMirrorPatchOperation[],
): ReceiverResourceInventory {
  const inventory = emptyResourceInventory();
  const styleUrls = new Map<string, number>();
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
        inventoryNodeResources(child, inventory, styleUrls);
      }
    } else if (operation.kind === 'reconcile-children') {
      for (const child of operation.children) {
        if (child.kind === 'graph') {
          inventoryNodeResources(child.node, inventory, styleUrls);
        }
      }
    }
  }
  return inventory;
}

function inventoryNodeResources(
  node: HtmlMirrorNode,
  inventory: ReceiverResourceInventory,
  styleUrls: Map<string, number>,
): void {
  if (node.kind === 'text') return;
  inventoryElementResources(node, inventory);
  const resolvedStyle = node.tagName === 'style' &&
    node.resolvedStyleSheetText !== undefined;
  for (const child of node.children) {
    if (resolvedStyle && child.kind === 'text') continue;
    inventoryNodeResources(child, inventory, styleUrls);
  }
  if (!node.shadowRoot) return;
  for (const cssText of node.shadowRoot.adoptedStyleSheets) {
    inventoryAdoptedStyleSheet(inventory, cssText, styleUrls);
  }
  for (const child of node.shadowRoot.children) {
    inventoryNodeResources(child, inventory, styleUrls);
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
  const matches = countRequestUrls(value);
  for (let index = 0; index < matches; index += 1) {
    incrementInventory(inventory, 'requestCapable');
  }
}

function countRequestUrls(value: string): number {
  return value.match(/https?:\/\//giu)?.length ?? 0;
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

function readScrollState(input: HtmlMirrorScrollState): HtmlMirrorScrollState | undefined {
  if (
    !hasExactKeysWithOptional(
      input as unknown as Record<string, unknown>,
      [
        'scrollTarget', 'scrollX', 'scrollY', 'maxScrollX', 'maxScrollY',
        'documentScrollX', 'documentScrollY', 'documentMaxScrollX',
        'documentMaxScrollY',
      ],
      ['nestedOwnerKey', 'nestedOwnerOrdinal'],
    ) ||
    (input.scrollTarget !== 'document' && input.scrollTarget !== 'nested') ||
    ![
      input.scrollX,
      input.scrollY,
      input.maxScrollX,
      input.maxScrollY,
      input.documentScrollX,
      input.documentScrollY,
      input.documentMaxScrollX,
      input.documentMaxScrollY,
    ].every(isScrollValue) ||
    input.scrollX > input.maxScrollX ||
    input.scrollY > input.maxScrollY ||
    input.documentScrollX > input.documentMaxScrollX ||
    input.documentScrollY > input.documentMaxScrollY ||
    (input.scrollTarget === 'document' &&
      (input.nestedOwnerKey !== undefined || input.nestedOwnerOrdinal !== undefined)) ||
    (input.nestedOwnerKey !== undefined &&
      (!isSequence(input.nestedOwnerKey) || input.nestedOwnerKey === 0)) ||
    (input.nestedOwnerOrdinal !== undefined &&
      (!Number.isSafeInteger(input.nestedOwnerOrdinal) ||
        input.nestedOwnerOrdinal < 0))
  ) return undefined;
  return Object.freeze({
    scrollTarget: input.scrollTarget,
    scrollX: input.scrollX,
    scrollY: input.scrollY,
    maxScrollX: input.maxScrollX,
    maxScrollY: input.maxScrollY,
    ...(input.scrollTarget === 'nested' && input.nestedOwnerKey !== undefined
      ? { nestedOwnerKey: input.nestedOwnerKey }
      : {}),
    ...(input.scrollTarget === 'nested' && input.nestedOwnerOrdinal !== undefined
      ? { nestedOwnerOrdinal: input.nestedOwnerOrdinal }
      : {}),
    documentScrollX: input.documentScrollX,
    documentScrollY: input.documentScrollY,
    documentMaxScrollX: input.documentMaxScrollX,
    documentMaxScrollY: input.documentMaxScrollY,
  });
}

function isScrollValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= 0 && value <= 100_000;
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
