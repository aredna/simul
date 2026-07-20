import {
  MAX_REPLICA_NODE_DEPTH,
  MAX_REPLICA_NODES,
  MAX_REPLICA_STRING_LENGTH,
  maskRrwebPrivateText,
  sanitizeCssText,
  sanitizeCssTextDetailed,
  sanitizeRrwebIncrementalAttributes,
  sanitizeRrwebIncrementalNode,
} from './protocol-v2';

const RRWEB_INCREMENTAL_EVENT = 3;
const MUTATION = 0;
const SCROLL = 3;
const VIEWPORT_RESIZE = 4;
const STYLE_SHEET_RULE = 8;
const STYLE_DECLARATION = 13;
const ADOPTED_STYLE_SHEET = 15;
export const MAX_REPLICA_STREAM_STYLE_IDS = 4_096;
export const MAX_REPLICA_STREAM_STYLE_RULES = 50_000;

const IGNORED_SOURCES = new Set([1, 2, 5, 6, 7, 9, 10, 11, 12, 14, 16]);
const PRIVATE_TAGS = new Set(['input', 'option', 'output', 'select', 'textarea']);
const PRIVATE_ROLES = new Set([
  'checkbox',
  'combobox',
  'listbox',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
]);

interface StreamNodeState {
  readonly id: number;
  readonly nodeType: number;
  readonly tagName?: string;
  readonly parentId?: number;
  readonly privateRegion: boolean;
  readonly styleRegion: boolean;
  readonly children: Set<number>;
  readonly shadowHost: boolean;
  readonly shadowChild: boolean;
  styleSheetEnabled: boolean;
  textContent?: string;
  styleTextOverride?: string;
}

interface StyleRuleTopology {
  readonly kind: StyleRuleKind;
  readonly namespacePrelude?: string;
  readonly styleCapable: boolean;
  readonly mutableChildren: boolean;
  readonly removable: boolean;
  readonly children: StyleRuleTopology[];
}

type StyleRuleKind =
  | 'font-face'
  | 'grouping'
  | 'import-wrapper'
  | 'keyframe'
  | 'keyframes'
  | 'namespace'
  | 'other'
  | 'page'
  | 'page-margin'
  | 'style';

type StyleSheetTopology = StyleRuleTopology[];

interface StyleTarget {
  readonly kind: 'node' | 'constructed';
  readonly id: number;
  readonly wireTarget: Record<string, number>;
  readonly topology: StyleSheetTopology;
}

interface ParsedInsertedRule {
  readonly cssText: string;
  readonly topology: StyleRuleTopology;
}

interface SanitizerState {
  nodes: Map<number, StreamNodeState>;
  omitted: Set<number>;
  sourceParents: Map<number, number | undefined>;
  sourceChildren: Map<number, number[]>;
  styleIds: Set<number>;
  nodeStyleSheets: Map<number, StyleSheetTopology | null>;
  constructedStyleSheets: Map<number, StyleSheetTopology>;
  styleRuleCount: number;
  readonly cssDocument: Document | undefined;
  lastTimestamp: number;
}

export type RrwebStreamEventResult =
  | { readonly status: 'accepted'; readonly event: unknown }
  | { readonly status: 'ignored' }
  | { readonly status: 'checkpoint' };

export interface PreparedRrwebStreamBatch {
  readonly events: readonly unknown[];
  commit(): void;
}

export type RecorderRrwebStreamBatchResult =
  | { readonly status: 'accepted'; readonly events: readonly unknown[] }
  | { readonly status: 'checkpoint' };

/**
 * Stateful second validator for live rrweb events. It tracks private/style
 * ancestry and mirror IDs from the accepted checkpoint, then exposes a
 * transactional batch projection so receiver state advances only after the
 * Replayer casts every event.
 */
export class RrwebStreamSanitizer {
  #state: SanitizerState;
  #ready = false;

  constructor(cssDocument: Document | undefined = createCssParsingDocument()) {
    this.#state = createEmptyState(cssDocument);
  }

  get hasConstructedStyleIdentity(): boolean {
    return this.#ready && this.#state.styleIds.size > 0;
  }

  reset(checkpointEvents: readonly unknown[]): boolean {
    const next = createEmptyState(this.#state.cssDocument);
    for (const event of checkpointEvents) {
      if (
        !isRecord(event) ||
        !isBoundedNumber(event.timestamp, next.lastTimestamp, Number.MAX_SAFE_INTEGER)
      ) {
        this.#ready = false;
        return false;
      }
      next.lastTimestamp = event.timestamp;
    }
    const snapshot = checkpointEvents.find(
      (event): event is Record<string, unknown> =>
        isRecord(event) && event.type === 2,
    );
    if (!snapshot || !isRecord(snapshot.data) || !('node' in snapshot.data)) {
      this.#ready = false;
      return false;
    }
    if (!registerSerializedTree(snapshot.data.node, undefined, false, false, next, 0)) {
      this.#ready = false;
      return false;
    }
    this.#state = next;
    this.#ready = true;
    return true;
  }

  prepareBatch(events: readonly unknown[]): PreparedRrwebStreamBatch | undefined {
    if (!this.#ready || events.length === 0) return undefined;
    const next = forkState(this.#state, events);
    const sanitized: unknown[] = [];
    for (const event of events) {
      const result = sanitizeEvent(event, next);
      if (result.status === 'checkpoint') return undefined;
      if (result.status === 'accepted') sanitized.push(result.event);
    }
    // Stream batches contain only admitted visual events. An all-ignored batch
    // indicates a sender/parser disagreement and cannot advance ACK state.
    if (sanitized.length !== events.length) return undefined;
    let committed = false;
    return {
      events: Object.freeze(sanitized),
      commit: () => {
        if (committed) return;
        committed = true;
        this.#state = next;
      },
    };
  }

  sanitizeForRecorder(event: unknown): RrwebStreamEventResult {
    const result = this.sanitizeRecorderBatch([event]);
    if (result.status === 'checkpoint') return result;
    if (result.events.length === 0) return { status: 'ignored' };
    return { status: 'accepted', event: result.events[0] };
  }

  /** Sanitizes one animation-frame batch with a single transactional clone. */
  sanitizeRecorderBatch(
    events: readonly unknown[],
  ): RecorderRrwebStreamBatchResult {
    if (!this.#ready || events.length === 0) return { status: 'checkpoint' };
    const next = forkState(this.#state, events);
    const sanitized: unknown[] = [];
    for (const event of events) {
      const result = sanitizeEvent(event, next);
      if (result.status === 'checkpoint') return result;
      if (result.status === 'accepted') sanitized.push(result.event);
    }
    this.#state = next;
    return { status: 'accepted', events: Object.freeze(sanitized) };
  }
}

function createCssParsingDocument(): Document | undefined {
  try {
    const currentDocument = globalThis.document;
    return currentDocument?.implementation?.createHTMLDocument('') ?? undefined;
  } catch {
    return undefined;
  }
}

function createEmptyState(cssDocument: Document | undefined): SanitizerState {
  return {
    nodes: new Map(),
    omitted: new Set(),
    sourceParents: new Map(),
    sourceChildren: new Map(),
    styleIds: new Set(),
    nodeStyleSheets: new Map(),
    constructedStyleSheets: new Map(),
    styleRuleCount: 0,
    cssDocument,
    lastTimestamp: 0,
  };
}

function sanitizeEvent(
  input: unknown,
  state: SanitizerState,
): RrwebStreamEventResult {
  if (
    !isRecord(input) ||
    !hasOnlyKeys(input, ['type', 'data', 'timestamp', 'delay']) ||
    input.type !== RRWEB_INCREMENTAL_EVENT ||
    !isBoundedNumber(input.timestamp, 0, Number.MAX_SAFE_INTEGER) ||
    ('delay' in input && !isBoundedNumber(input.delay, 0, 60_000)) ||
    !isRecord(input.data) ||
    !Number.isSafeInteger(input.data.source)
  ) return { status: 'checkpoint' };
  const source = Number(input.data.source);
  if (IGNORED_SOURCES.has(source)) return { status: 'ignored' };
  if (source === VIEWPORT_RESIZE) return { status: 'checkpoint' };
  if (input.timestamp < state.lastTimestamp) return { status: 'checkpoint' };

  let data: Record<string, unknown> | 'ignored' | undefined;
  switch (source) {
    case MUTATION:
      data = sanitizeMutation(input.data, state);
      break;
    case SCROLL:
      data = sanitizeScroll(input.data, state);
      break;
    case STYLE_SHEET_RULE:
      data = sanitizeStyleSheetRule(input.data, state);
      break;
    case STYLE_DECLARATION:
      data = sanitizeStyleDeclaration(input.data, state);
      break;
    case ADOPTED_STYLE_SHEET:
      data = sanitizeAdoptedStyleSheet(input.data, state);
      break;
    default:
      return { status: 'checkpoint' };
  }
  if (data === 'ignored') return { status: 'ignored' };
  if (!data) return { status: 'checkpoint' };
  state.lastTimestamp = input.timestamp;
  return {
    status: 'accepted',
    event: {
      type: RRWEB_INCREMENTAL_EVENT,
      data,
      timestamp: input.timestamp,
      ...('delay' in input ? { delay: input.delay } : {}),
    },
  };
}

function sanitizeMutation(
  input: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> | undefined {
  if (
    !hasOnlyKeys(input, [
      'source',
      'texts',
      'attributes',
      'removes',
      'adds',
      'isAttachIframe',
    ]) ||
    input.isAttachIframe === true ||
    !Array.isArray(input.texts) ||
    !Array.isArray(input.attributes) ||
    !Array.isArray(input.removes) ||
    !Array.isArray(input.adds) ||
    input.texts.length + input.attributes.length + input.removes.length + input.adds.length >
      MAX_REPLICA_NODES
  ) return undefined;

  const texts: Record<string, unknown>[] = [];
  for (const item of input.texts) {
    if (
      !isRecordWithExactKeys(item, ['id', 'value']) ||
      !isNodeId(item.id) ||
      (typeof item.value !== 'string' && item.value !== null)
    ) return undefined;
    const id = Number(item.id);
    if (state.omitted.has(id)) continue;
    const node = state.nodes.get(id);
    if (
      !node ||
      (node.nodeType !== 3 && node.nodeType !== 4 && node.nodeType !== 5) ||
      (typeof item.value === 'string' && item.value.length > MAX_REPLICA_STRING_LENGTH)
    ) {
      return undefined;
    }
    const value = item.value ?? '';
    const sanitizedValue = node.privateRegion
      ? maskRrwebPrivateText(value)
      : node.styleRegion
        ? sanitizeCssText(value)
        : value;
    if (node.styleRegion && (node.nodeType === 3 || node.nodeType === 4)) {
      // MutationObserver reports author text while the source CSSOM has already
      // parsed and canonicalized it. Rewriting raw text can turn a declaration
      // rejected by the source into a valid replay declaration, so recover from
      // the canonical checkpoint instead.
      return undefined;
    }
    texts.push({
      id,
      value: sanitizedValue,
    });
  }

  const attributes: Record<string, unknown>[] = [];
  for (const item of input.attributes) {
    if (
      !isRecordWithExactKeys(item, ['id', 'attributes']) ||
      !isNodeId(item.id) ||
      !isRecord(item.attributes)
    ) return undefined;
    const id = Number(item.id);
    if (state.omitted.has(id)) continue;
    const node = state.nodes.get(id);
    if (!node || !node.tagName) return undefined;
    if (changesPrivateBoundary(node, item.attributes)) return undefined;
    const nextAttributes = sanitizeRrwebIncrementalAttributes(
      item.attributes,
      node.tagName,
      node.privateRegion,
    );
    if (!nextAttributes) return undefined;
    if (
      Object.entries(item.attributes).some(([rawName, value]) =>
        value !== null &&
        typeof value !== 'string' &&
        !(rawName.toLowerCase() === 'style' && isRecord(value)),
      )
    ) return undefined;
    // Explicitly remove unsafe keys stripped by the sanitizer so an earlier
    // safe replica attribute can never become a live network or event hook.
    for (const rawName of Object.keys(item.attributes)) {
      if (!(rawName in nextAttributes)) nextAttributes[rawName] = null;
    }
    const cssTextEntry = Object.entries(nextAttributes).find(
      ([name]) => name === '_cssText',
    );
    const styleTypeEntry = Object.entries(nextAttributes).find(
      ([name]) => name.toLowerCase() === 'type',
    );
    if (
      styleTypeEntry &&
      (node.tagName === 'style' || node.tagName === 'link')
    ) {
      node.styleSheetEnabled = isCssStyleType(styleTypeEntry[1]);
    }
    if (cssTextEntry) {
      // rrweb may flatten accessible @imports while producing `_cssText`.
      // Only a fresh checkpoint can establish a canonical one-rule mapping.
      return undefined;
    }
    if (
      (cssTextEntry || styleTypeEntry) &&
      (node.tagName === 'style' || node.tagName === 'link') &&
      !refreshNodeStyleSheet(id, state)
    ) return undefined;
    attributes.push({ id, attributes: nextAttributes });
  }

  const removes: Record<string, unknown>[] = [];
  for (const item of input.removes) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['parentId', 'id', 'isShadow']) ||
      !isNodeId(item.parentId) ||
      !isNodeId(item.id) ||
      ('isShadow' in item && typeof item.isShadow !== 'boolean')
    ) return undefined;
    const id = Number(item.id);
    const parentId = Number(item.parentId);
    if (
      !state.sourceParents.has(id) ||
      state.sourceParents.get(id) !== parentId
    ) return undefined;
    if (state.omitted.has(id)) {
      removeSourceTree(id, state);
      continue;
    }
    const node = state.nodes.get(id);
    if (
      !node ||
      node.parentId !== parentId ||
      !state.nodes.has(parentId) ||
      (item.isShadow === true) !== node.shadowChild
    ) return undefined;
    const parent = state.nodes.get(parentId);
    if (parent?.tagName === 'style' && parent.styleTextOverride !== undefined) {
      return undefined;
    }
    removes.push({
      parentId,
      id,
      ...(item.isShadow === true ? { isShadow: true } : {}),
    });
    removeTree(id, state);
    removeSourceTree(id, state);
    if (parent?.tagName === 'style' && !refreshNodeStyleSheet(parentId, state)) {
      return undefined;
    }
  }

  const adds: Record<string, unknown>[] = [];
  for (const item of input.adds) {
    if (
      !isRecord(item) ||
      !hasOnlyKeys(item, ['parentId', 'previousId', 'nextId', 'node']) ||
      !isNodeId(item.parentId) ||
      !('node' in item) ||
      ('previousId' in item && item.previousId !== null && !isNodeId(item.previousId)) ||
      item.nextId !== null && !isNodeId(item.nextId)
    ) return undefined;
    const parentId = Number(item.parentId);
    const rawIds = collectSerializedIds(item.node);
    if (
      !rawIds ||
      [...rawIds].some((id) => state.nodes.has(id) || state.omitted.has(id)) ||
      state.nodes.size + state.omitted.size + rawIds.size > MAX_REPLICA_NODES
    ) return undefined;
    const previousId = 'previousId' in item
      ? projectSiblingAnchor(item.previousId, parentId, 'previous', state)
      : undefined;
    const nextId = projectSiblingAnchor(item.nextId, parentId, 'next', state);
    if (
      ('previousId' in item && previousId === undefined) ||
      nextId === undefined
    ) return undefined;
    if (state.omitted.has(parentId)) {
      if (!registerSourceTree(
        item.node,
        parentId,
        item.previousId,
        item.nextId,
        state,
      )) return undefined;
      for (const id of rawIds) state.omitted.add(id);
      continue;
    }
    const parent = state.nodes.get(parentId);
    if (!parent || (parent.nodeType !== 0 && parent.nodeType !== 2)) return undefined;
    if (parent.tagName === 'style' && parent.styleTextOverride !== undefined) {
      return undefined;
    }
    const existingIds = new Set([...state.nodes.keys(), ...state.omitted]);
    const sanitizedNode = sanitizeRrwebIncrementalNode(
      item.node,
      parent.privateRegion,
      parent.styleRegion,
      existingIds,
    );
    if (!sanitizedNode) {
      if (!registerSourceTree(
        item.node,
        parentId,
        item.previousId,
        item.nextId,
        state,
      )) return undefined;
      for (const id of rawIds) state.omitted.add(id);
      continue;
    }
    const sanitizedIds = collectSerializedIds(sanitizedNode);
    if (!sanitizedIds) return undefined;
    if (!registerSourceTree(
      item.node,
      parentId,
      item.previousId,
      item.nextId,
      state,
    )) return undefined;
    for (const id of rawIds) {
      if (!sanitizedIds.has(id)) state.omitted.add(id);
    }
    if (!registerSerializedTree(
      sanitizedNode,
      parentId,
      parent.privateRegion,
      parent.styleRegion,
      state,
      0,
      false,
    )) return undefined;
    if (parent.tagName === 'style' && !refreshNodeStyleSheet(parentId, state)) {
      return undefined;
    }
    adds.push({
      parentId,
      ...('previousId' in item ? { previousId } : {}),
      nextId,
      node: sanitizedNode,
    });
  }

  return { source: MUTATION, texts, attributes, removes, adds };
}

function sanitizeScroll(
  input: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> | 'ignored' | undefined {
  if (
    !isRecordWithExactKeys(input, ['source', 'id', 'x', 'y']) ||
    !isNodeId(input.id) ||
    !isBoundedNumber(input.x, -1_000_000, 1_000_000) ||
    !isBoundedNumber(input.y, -1_000_000, 1_000_000)
  ) return undefined;
  const id = Number(input.id);
  const node = state.nodes.get(id);
  if (!node) return state.omitted.has(id) ? 'ignored' : undefined;
  if (node.nodeType !== 0 && node.nodeType !== 2) return undefined;
  return { source: SCROLL, id, x: input.x, y: input.y };
}

function sanitizeStyleSheetRule(
  input: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> | undefined {
  if (!hasOnlyKeys(input, ['source', 'id', 'styleId', 'removes', 'adds', 'replace', 'replaceSync'])) {
    return undefined;
  }
  const target = sanitizeStyleTarget(input, state);
  if (!target) return undefined;
  const operationCount = [
    Array.isArray(input.adds) && input.adds.length > 0,
    Array.isArray(input.removes) && input.removes.length > 0,
    typeof input.replace === 'string',
    typeof input.replaceSync === 'string',
  ].filter(Boolean).length;
  if (operationCount !== 1) return undefined;
  // CSSStyleSheet.replace() completes asynchronously, after rrweb's event-cast
  // signal. It therefore cannot participate in an exact ACK boundary.
  if ('replace' in input) return undefined;

  const topology = cloneTopology(target.topology);
  const previousRuleCount = countTopology(topology);
  let nextRuleCount = previousRuleCount;
  let hasOperation = false;
  const result: Record<string, unknown> = {
    source: STYLE_SHEET_RULE,
    ...target.wireTarget,
  };
  if ('removes' in input) {
    if (!Array.isArray(input.removes) || input.removes.length > 10_000) return undefined;
    const removes: Record<string, unknown>[] = [];
    for (const entry of input.removes) {
      const sanitized = sanitizeRuleIndexEntry(entry);
      if (!sanitized) return undefined;
      const removedRuleCount = removeRuleTopology(topology, sanitized.index);
      if (removedRuleCount === undefined) return undefined;
      nextRuleCount -= removedRuleCount;
      removes.push(sanitized);
    }
    result.removes = removes;
    hasOperation = hasOperation || removes.length > 0;
  }
  if ('adds' in input) {
    if (!Array.isArray(input.adds) || input.adds.length > 10_000) return undefined;
    const adds: Record<string, unknown>[] = [];
    for (const entry of input.adds) {
      if (!isRecord(entry) || !hasOnlyKeys(entry, ['rule', 'index']) || typeof entry.rule !== 'string') {
        return undefined;
      }
      if (entry.rule.length > MAX_REPLICA_STRING_LENGTH) return undefined;
      const index = entry.index === undefined
        ? undefined
        : sanitizeRuleIndex(entry.index);
      if (entry.index !== undefined && index === undefined) return undefined;
      if (
        !Array.isArray(index) &&
        hasProtectedTopLevelPrelude(topology)
      ) return undefined;
      const parsed = parseInsertedRuleTopology(
        entry.rule,
        state.cssDocument,
        Array.isArray(index),
        false,
        topology.flatMap((rule) =>
          rule.namespacePrelude ? [rule.namespacePrelude] : [],
        ),
      );
      if (!parsed) return undefined;
      const addedRuleCount = countTopology([parsed.topology]);
      if (!insertRuleTopology(topology, index, parsed.topology)) return undefined;
      nextRuleCount += addedRuleCount;
      if (
        state.styleRuleCount - previousRuleCount + nextRuleCount >
        MAX_REPLICA_STREAM_STYLE_RULES
      ) return undefined;
      adds.push({
        rule: parsed.cssText,
        ...(index !== undefined ? { index } : {}),
      });
    }
    result.adds = adds;
    hasOperation = hasOperation || adds.length > 0;
  }
  if ('replaceSync' in input) {
    if (
      target.kind !== 'constructed' ||
      typeof input.replaceSync !== 'string' ||
      input.replaceSync.length > MAX_REPLICA_STRING_LENGTH
    ) {
      return undefined;
    }
    const replacement = canonicalizeStyleSheetText(
      input.replaceSync,
      state.cssDocument,
    );
    if (!replacement) return undefined;
    nextRuleCount = countTopology(replacement.topology);
    if (
      state.styleRuleCount - previousRuleCount + nextRuleCount >
      MAX_REPLICA_STREAM_STYLE_RULES
    ) return undefined;
    topology.splice(0, topology.length, ...replacement.topology);
    result.replaceSync = replacement.cssText;
    hasOperation = true;
  }
  if (!hasOperation) return undefined;
  if (!replaceStyleTargetTopology(target, topology, state)) return undefined;
  return result;
}

function sanitizeStyleDeclaration(
  input: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> | undefined {
  if (!hasOnlyKeys(input, ['source', 'id', 'styleId', 'index', 'set', 'remove'])) {
    return undefined;
  }
  if (Number('set' in input) + Number('remove' in input) !== 1) return undefined;
  const target = sanitizeStyleTarget(input, state);
  const index = sanitizeRuleIndex(input.index);
  if (
    !target ||
    !Array.isArray(index) ||
    index.length === 0 ||
    !getRuleTopology(target.topology, index)?.styleCapable
  ) return undefined;
  const result: Record<string, unknown> = {
    source: STYLE_DECLARATION,
    ...target.wireTarget,
    index,
  };
  if ('set' in input) {
    if (
      !isRecord(input.set) ||
      !hasOnlyKeys(input.set, ['property', 'value', 'priority']) ||
      !('property' in input.set) ||
      !('value' in input.set) ||
      typeof input.set.property !== 'string' ||
      !isCssPropertyName(input.set.property) ||
      input.set.property.length > 256 ||
      coerceCssOmValue(input.set.value) === undefined ||
      coerceCssOmString(input.set.priority ?? '') === undefined
    ) return undefined;
    const value = coerceCssOmValue(input.set.value);
    const priority = coerceCssOmString(input.set.priority ?? '');
    if (
      value === undefined ||
      priority === undefined ||
      value.length > MAX_REPLICA_STRING_LENGTH ||
      priority.length > 256
    ) return undefined;
    result.set = {
      property: input.set.property,
      value: sanitizeCssText(value),
      ...(priority.length > 0
        ? { priority: priority.toLowerCase() }
        : {}),
    };
  }
  if ('remove' in input) {
    if (
      !isRecordWithExactKeys(input.remove, ['property']) ||
      typeof input.remove.property !== 'string' ||
      !isCssPropertyName(input.remove.property) ||
      input.remove.property.length > 256
    ) return undefined;
    result.remove = { property: input.remove.property };
  }
  if (!('set' in result) && !('remove' in result)) return undefined;
  return result;
}

function sanitizeAdoptedStyleSheet(
  input: Record<string, unknown>,
  state: SanitizerState,
): Record<string, unknown> | undefined {
  if (
    !hasOnlyKeys(input, ['source', 'id', 'styles', 'styleIds']) ||
    !isNodeId(input.id) ||
    !state.nodes.has(Number(input.id)) ||
    !Array.isArray(input.styleIds) ||
    input.styleIds.length > 10_000 ||
    input.styleIds.some((id) => !isNodeId(id))
  ) return undefined;
  const styleIds = input.styleIds.map(Number);
  const host = state.nodes.get(Number(input.id));
  if (
    !host ||
    (host.nodeType !== 0 && !host.shadowHost)
  ) return undefined;
  const result: Record<string, unknown> = {
    source: ADOPTED_STYLE_SHEET,
    id: Number(input.id),
    styleIds,
  };
  const definedStyleIds = new Set<number>();
  const definedTopologies = new Map<number, StyleSheetTopology>();
  let addedRuleCount = 0;
  if ('styles' in input) {
    if (!Array.isArray(input.styles) || input.styles.length > 10_000) return undefined;
    const styles: Record<string, unknown>[] = [];
    for (const style of input.styles) {
      if (
        !isRecordWithExactKeys(style, ['styleId', 'rules']) ||
        !isNodeId(style.styleId) ||
        !Array.isArray(style.rules) ||
        style.rules.length > 10_000 ||
        state.styleIds.has(Number(style.styleId)) ||
        definedStyleIds.has(Number(style.styleId))
      ) return undefined;
      const styleId = Number(style.styleId);
      definedStyleIds.add(styleId);
      const rules: Record<string, unknown>[] = [];
      const topology: StyleSheetTopology = [];
      const namespacePrelude: string[] = [];
      for (const rule of style.rules) {
        if (
          !isRecord(rule) ||
          !hasOnlyKeys(rule, ['rule', 'index']) ||
          typeof rule.rule !== 'string' ||
          rule.rule.length > MAX_REPLICA_STRING_LENGTH
        ) {
          return undefined;
        }
        const index = rule.index === undefined
          ? undefined
          : sanitizeRuleIndex(rule.index);
        if (rule.index !== undefined && index === undefined) return undefined;
        if (Array.isArray(index)) return undefined;
        const parsed = parseInsertedRuleTopology(
          rule.rule,
          state.cssDocument,
          false,
          true,
          namespacePrelude,
        );
        if (!parsed || !insertRuleTopology(topology, index, parsed.topology)) {
          return undefined;
        }
        addedRuleCount += countTopology([parsed.topology]);
        if (parsed.topology.namespacePrelude) {
          namespacePrelude.push(parsed.topology.namespacePrelude);
        }
        if (state.styleRuleCount + addedRuleCount > MAX_REPLICA_STREAM_STYLE_RULES) {
          return undefined;
        }
        rules.push({
          rule: parsed.cssText,
          ...(index !== undefined ? { index } : {}),
        });
      }
      definedTopologies.set(styleId, topology);
      styles.push({ styleId, rules });
    }
    result.styles = styles;
  }
  if (
    [...definedStyleIds].some((styleId) => !styleIds.includes(styleId)) ||
    styleIds.some(
      (styleId) => !state.styleIds.has(styleId) && !definedStyleIds.has(styleId),
    ) ||
    state.styleIds.size + definedStyleIds.size > MAX_REPLICA_STREAM_STYLE_IDS
  ) return undefined;
  for (const styleId of definedStyleIds) {
    const topology = definedTopologies.get(styleId);
    if (!topology) return undefined;
    state.styleIds.add(styleId);
    state.constructedStyleSheets.set(styleId, topology);
  }
  state.styleRuleCount += addedRuleCount;
  return result;
}

function sanitizeStyleTarget(
  input: Record<string, unknown>,
  state: SanitizerState,
): StyleTarget | undefined {
  const id = isNodeId(input.id) ? Number(input.id) : undefined;
  const styleId = isNodeId(input.styleId) ? Number(input.styleId) : undefined;
  if ((id === undefined) === (styleId === undefined)) return undefined;
  if (id !== undefined) {
    if (input.styleId !== undefined) return undefined;
    const node = state.nodes.get(id);
    if (!node || (node.tagName !== 'style' && node.tagName !== 'link')) {
      return undefined;
    }
    const topology = state.nodeStyleSheets.get(id);
    if (!topology) return undefined;
    return { kind: 'node', id, wireTarget: { id }, topology };
  }
  if (
    input.id !== undefined ||
    styleId === undefined ||
    !state.styleIds.has(styleId)
  ) return undefined;
  const topology = state.constructedStyleSheets.get(styleId);
  if (!topology) return undefined;
  return {
    kind: 'constructed',
    id: styleId,
    wireTarget: { styleId },
    topology,
  };
}

function sanitizeRuleIndexEntry(input: unknown): Record<string, unknown> | undefined {
  if (!isRecordWithExactKeys(input, ['index'])) return undefined;
  const index = sanitizeRuleIndex(input.index);
  return index === undefined ? undefined : { index };
}

function sanitizeRuleIndex(input: unknown): number | number[] | undefined {
  if (Number.isSafeInteger(input) && Number(input) >= 0 && Number(input) <= 1_000_000) {
    return Number(input);
  }
  if (
    Array.isArray(input) &&
    input.length <= 64 &&
    input.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000)
  ) return input.map(Number);
  return undefined;
}

function isCssPropertyName(value: string): boolean {
  return /^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/u.test(value);
}

function coerceCssOmString(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function coerceCssOmValue(value: unknown): string | undefined {
  return value === null ? '' : coerceCssOmString(value);
}

function isRemovableRule(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized !== '@media not all {}' &&
    !normalized.startsWith('@namespace')
  );
}

function hasProtectedTopLevelPrelude(topology: StyleSheetTopology): boolean {
  return topology.some((rule) =>
    !rule.removable || rule.kind === 'import-wrapper',
  );
}

function insertRuleTopology(
  topology: StyleSheetTopology,
  index: number | number[] | undefined,
  rule: StyleRuleTopology,
): boolean {
  if (index === undefined || typeof index === 'number') {
    const insertionIndex = index ?? 0;
    if (insertionIndex > topology.length) return false;
    topology.splice(insertionIndex, 0, rule);
    return true;
  }
  if (index.length < 2) return false;
  const insertionIndex = index[index.length - 1];
  const parent = getRuleTopology(topology, index.slice(0, -1));
  if (
    insertionIndex === undefined ||
    !parent?.mutableChildren ||
    insertionIndex > parent.children.length
  ) return false;
  parent.children.splice(insertionIndex, 0, rule);
  return true;
}

function removeRuleTopology(
  topology: StyleSheetTopology,
  index: unknown,
): number | undefined {
  if (typeof index === 'number') {
    if (index >= topology.length) return undefined;
    if (!topology[index]?.removable) return undefined;
    const removed = topology.splice(index, 1)[0];
    return removed ? countTopology([removed]) : undefined;
  }
  if (!Array.isArray(index) || index.length < 2) return undefined;
  const removalIndex = index[index.length - 1];
  const parent = getRuleTopology(topology, index.slice(0, -1));
  if (
    typeof removalIndex !== 'number' ||
    !parent?.mutableChildren ||
    removalIndex >= parent.children.length
  ) return undefined;
  if (!parent.children[removalIndex]?.removable) return undefined;
  const removed = parent.children.splice(removalIndex, 1)[0];
  return removed ? countTopology([removed]) : undefined;
}

function getRuleTopology(
  topology: StyleSheetTopology,
  path: readonly number[],
): StyleRuleTopology | undefined {
  let rules = topology;
  let rule: StyleRuleTopology | undefined;
  for (const position of path) {
    rule = rules[position];
    if (!rule) return undefined;
    rules = rule.children;
  }
  return rule;
}

function parseInsertedRuleTopology(
  cssText: string,
  cssDocument: Document | undefined,
  nested: boolean,
  allowNeutralizedNamespace: boolean,
  namespacePrelude: readonly string[] = [],
): ParsedInsertedRule | undefined {
  const rawDetails = sanitizeCssTextDetailed(cssText);
  if (
    !cssDocument ||
    !isSingleCssRuleText(cssText) ||
    rawDetails.neutralizedImport ||
    (rawDetails.neutralizedNamespace && !allowNeutralizedNamespace) ||
    (nested && cssText.trimStart().startsWith('@'))
  ) return undefined;
  const source = parseSingleInsertedRule(
    cssText,
    cssDocument,
    nested,
    namespacePrelude,
  );
  if (!source) {
    if (
      allowNeutralizedNamespace &&
      rawDetails.neutralizedNamespace &&
      !supportsNamespaceInsertion(cssDocument)
    ) {
      return {
        cssText: rawDetails.text,
        topology: {
          kind: 'namespace',
          namespacePrelude: rawDetails.text,
          styleCapable: false,
          mutableChildren: false,
          removable: false,
          children: [],
        },
      };
    }
    return undefined;
  }
  const sanitized = sanitizeCssTextDetailed(source.cssText);
  if (
    sanitized.neutralizedImport ||
    (sanitized.neutralizedNamespace && !allowNeutralizedNamespace)
  ) return undefined;
  const replay = parseSingleInsertedRule(
    sanitized.text,
    cssDocument,
    nested,
    namespacePrelude,
  );
  if (!replay || !sameTopologyShape(source.topology, replay.topology)) {
    return undefined;
  }
  return { cssText: sanitized.text, topology: replay.topology };
}

function parseSingleInsertedRule(
  cssText: string,
  cssDocument: Document,
  nested: boolean,
  namespacePrelude: readonly string[],
): ParsedInsertedRule | undefined {
  let styleElement: HTMLStyleElement | undefined;
  try {
    styleElement = cssDocument.createElement('style');
    const parent = cssDocument.head ?? cssDocument.documentElement;
    if (!parent) return undefined;
    parent.append(styleElement);
    const sheet = styleElement.sheet;
    if (!sheet) return undefined;
    const scratchPrelude =
      namespacePrelude.length > 0 && !supportsNamespaceInsertion(cssDocument)
        ? []
        : namespacePrelude;
    if (!nested) {
      for (const namespaceRule of scratchPrelude) {
        sheet.insertRule(namespaceRule, sheet.cssRules.length);
      }
    }
    const candidate = nested ? `@media all { ${cssText} }` : cssText;
    const insertionIndex = nested ? 0 : sheet.cssRules.length;
    const insertedIndex = sheet.insertRule(candidate, insertionIndex);
    if (
      insertedIndex !== insertionIndex ||
      sheet.cssRules.length !== scratchPrelude.length + 1
    ) return undefined;
    const parsed = readRuleTopology(sheet.cssRules, { count: 0 });
    if (!parsed || parsed.length !== scratchPrelude.length + 1) return undefined;
    if (!nested) {
      const rule = sheet.cssRules[insertionIndex];
      const topology = parsed[insertionIndex];
      return rule && topology
        ? { cssText: rule.cssText, topology }
        : undefined;
    }
    const wrapper = sheet.cssRules[0];
    const child = (wrapper as CSSRule & { readonly cssRules?: CSSRuleList })
      ?.cssRules?.[0];
    return child && parsed[0]?.mutableChildren && parsed[0].children[0]
      ? { cssText: child.cssText, topology: parsed[0].children[0] }
      : undefined;
  } catch {
    return undefined;
  } finally {
    styleElement?.remove();
  }
}

function supportsNamespaceInsertion(cssDocument: Document): boolean {
  let styleElement: HTMLStyleElement | undefined;
  try {
    styleElement = cssDocument.createElement('style');
    const parent = cssDocument.head ?? cssDocument.documentElement;
    if (!parent) return false;
    parent.append(styleElement);
    styleElement.sheet?.insertRule('@namespace "urn:simul:probe";', 0);
    return styleElement.sheet?.cssRules.length === 1;
  } catch {
    return false;
  } finally {
    styleElement?.remove();
  }
}

function sameTopologyShape(
  source: StyleRuleTopology,
  replay: StyleRuleTopology,
): boolean {
  return (
    source.kind === replay.kind &&
    source.styleCapable === replay.styleCapable &&
    source.mutableChildren === replay.mutableChildren &&
    source.children.length === replay.children.length &&
    source.children.every((child, index) => {
      const replayChild = replay.children[index];
      return replayChild ? sameTopologyShape(child, replayChild) : false;
    })
  );
}

function canonicalizeStyleSheetText(
  cssText: string,
  cssDocument: Document | undefined,
): { readonly cssText: string; readonly topology: StyleSheetTopology } | undefined {
  if (!cssDocument || sanitizeCssTextDetailed(cssText).neutralizedImport) {
    return undefined;
  }
  let styleElement: HTMLStyleElement | undefined;
  try {
    styleElement = cssDocument.createElement('style');
    styleElement.textContent = cssText;
    const parent = cssDocument.head ?? cssDocument.documentElement;
    if (!parent) return undefined;
    parent.append(styleElement);
    const rules = styleElement.sheet?.cssRules;
    if (!rules) return undefined;
    const sourceTopology = readRuleTopology(rules, { count: 0 });
    if (!sourceTopology) return undefined;
    const canonical = Array.from(rules, (rule) => rule.cssText).join('');
    const sanitized = sanitizeCssTextDetailed(canonical);
    if (sanitized.neutralizedImport) return undefined;
    const replayTopology = parseStyleSheetTopology(sanitized.text, cssDocument);
    if (
      !replayTopology ||
      sourceTopology.length !== replayTopology.length ||
      sourceTopology.some((rule, index) => {
        const replayRule = replayTopology[index];
        return !replayRule || !sameTopologyShape(rule, replayRule);
      })
    ) return undefined;
    return { cssText: sanitized.text, topology: replayTopology };
  } catch {
    return undefined;
  } finally {
    styleElement?.remove();
  }
}

function isSingleCssRuleText(value: string): boolean {
  let quote: '"' | "'" | undefined;
  let parentheses = 0;
  let brackets = 0;
  let blocks = 0;
  let sawToken = false;
  let sawBlock = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!character) continue;
    if (quote) {
      if (character === '\\') {
        index += value[index + 1] === '\r' && value[index + 2] === '\n'
          ? 2
          : 1;
        continue;
      }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '/' && value[index + 1] === '*') {
      const commentEnd = value.indexOf('*/', index + 2);
      if (commentEnd < 0) return false;
      index = commentEnd + 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      sawToken = true;
      continue;
    }
    if (/\s/u.test(character) && !sawToken) continue;
    sawToken = true;
    if (character === '(') parentheses += 1;
    else if (character === ')') {
      if (parentheses === 0) return false;
      parentheses -= 1;
    } else if (character === '[') brackets += 1;
    else if (character === ']') {
      if (brackets === 0) return false;
      brackets -= 1;
    } else if (character === '{' && parentheses === 0 && brackets === 0) {
      blocks += 1;
      sawBlock = true;
    } else if (character === '}' && parentheses === 0 && brackets === 0) {
      if (blocks === 0) return false;
      blocks -= 1;
      if (blocks === 0) return value.slice(index + 1).trim().length === 0;
    } else if (
      character === ';' &&
      parentheses === 0 &&
      brackets === 0 &&
      blocks === 0 &&
      !sawBlock
    ) {
      return value.slice(index + 1).trim().length === 0;
    }
  }
  return false;
}

function parseStyleSheetTopology(
  cssText: string,
  cssDocument: Document | undefined,
): StyleSheetTopology | undefined {
  if (!cssDocument) return undefined;
  let styleElement: HTMLStyleElement | undefined;
  try {
    styleElement = cssDocument.createElement('style');
    styleElement.textContent = cssText;
    const parent = cssDocument.head ?? cssDocument.documentElement;
    if (!parent) return undefined;
    parent.append(styleElement);
    const rules = styleElement.sheet?.cssRules;
    if (!rules) return undefined;
    const topology = readRuleTopology(rules, { count: 0 });
    if (!topology) return undefined;
    return topology;
  } catch {
    return undefined;
  } finally {
    styleElement?.remove();
  }
}

function readRuleTopology(
  rules: CSSRuleList,
  budget: { count: number },
  depth = 0,
  parentKind?: StyleRuleKind,
): StyleSheetTopology | undefined {
  if (depth > MAX_REPLICA_NODE_DEPTH) return undefined;
  const topology: StyleSheetTopology = [];
  for (const rule of Array.from(rules)) {
    if (++budget.count > MAX_REPLICA_STREAM_STYLE_RULES) return undefined;
    const candidate = rule as CSSRule & {
      readonly cssRules?: CSSRuleList;
      readonly style?: { readonly setProperty?: unknown };
      readonly insertRule?: unknown;
      readonly deleteRule?: unknown;
    };
    const styleCapable = typeof candidate.style?.setProperty === 'function';
    const browserMutable =
      typeof candidate.insertRule === 'function' &&
      typeof candidate.deleteRule === 'function';
    const kind = classifyRuleKind(
      candidate.cssText,
      styleCapable,
      browserMutable,
      parentKind,
    );
    const children = candidate.cssRules
      ? readRuleTopology(candidate.cssRules, budget, depth + 1, kind)
      : [];
    if (!children) return undefined;
    topology.push({
      kind,
      ...(kind === 'namespace' ? { namespacePrelude: candidate.cssText } : {}),
      styleCapable,
      mutableChildren:
        browserMutable && kind !== 'import-wrapper' && kind !== 'page',
      removable: isRemovableRule(candidate.cssText),
      children,
    });
  }
  return topology;
}

function classifyRuleKind(
  cssText: string,
  styleCapable: boolean,
  mutableChildren: boolean,
  parentKind: StyleRuleKind | undefined,
): StyleRuleKind {
  const normalized = cssText.trimStart().toLowerCase();
  if (normalized.startsWith('@media all, (simul-inlined-import)')) {
    return 'import-wrapper';
  }
  if (parentKind === 'keyframes') return 'keyframe';
  if (parentKind === 'page' && normalized.startsWith('@')) return 'page-margin';
  if (normalized.startsWith('@font-face')) return 'font-face';
  if (normalized.startsWith('@namespace')) return 'namespace';
  if (normalized.startsWith('@page')) return 'page';
  if (
    normalized.startsWith('@keyframes') ||
    normalized.startsWith('@-webkit-keyframes')
  ) return 'keyframes';
  if (styleCapable) return 'style';
  if (mutableChildren) return 'grouping';
  return 'other';
}

function countTopology(topology: StyleSheetTopology): number {
  let count = 0;
  const stack = [...topology];
  while (stack.length > 0) {
    const rule = stack.pop();
    if (!rule) continue;
    count += 1;
    stack.push(...rule.children);
  }
  return count;
}

function cloneTopology(topology: StyleSheetTopology): StyleSheetTopology {
  return topology.map((rule) => ({
    kind: rule.kind,
    ...(rule.namespacePrelude
      ? { namespacePrelude: rule.namespacePrelude }
      : {}),
    styleCapable: rule.styleCapable,
    mutableChildren: rule.mutableChildren,
    removable: rule.removable,
    children: cloneTopology(rule.children),
  }));
}

function replaceStyleTargetTopology(
  target: StyleTarget,
  topology: StyleSheetTopology,
  state: SanitizerState,
): boolean {
  const previousCount = countTopology(target.topology);
  const nextCount = countTopology(topology);
  const total = state.styleRuleCount - previousCount + nextCount;
  if (total > MAX_REPLICA_STREAM_STYLE_RULES) return false;
  if (target.kind === 'node') state.nodeStyleSheets.set(target.id, topology);
  else state.constructedStyleSheets.set(target.id, topology);
  state.styleRuleCount = total;
  return true;
}

function registerSerializedTree(
  input: unknown,
  parentId: number | undefined,
  parentPrivate: boolean,
  parentStyle: boolean,
  state: SanitizerState,
  depth: number,
  registerSource = true,
): boolean {
  if (
    !isRecord(input) ||
    depth > MAX_REPLICA_NODE_DEPTH ||
    !isNodeId(input.id) ||
    !Number.isSafeInteger(input.type) ||
    (parentId === undefined
      ? input.type !== 0
      : !isContainerNode(state.nodes.get(parentId))) ||
    state.nodes.has(Number(input.id)) ||
    state.omitted.has(Number(input.id)) ||
    (registerSource && (
      state.sourceParents.has(Number(input.id)) ||
      state.sourceChildren.has(Number(input.id)) ||
      (parentId !== undefined && !state.sourceChildren.has(parentId))
    )) ||
    state.nodes.size + state.omitted.size >= MAX_REPLICA_NODES
  ) return false;
  const id = Number(input.id);
  const tagName = input.type === 2 && typeof input.tagName === 'string'
    ? input.tagName.toLowerCase()
    : undefined;
  const attributes = input.type === 2 && isRecord(input.attributes)
    ? input.attributes
    : undefined;
  const privateRegion =
    parentPrivate ||
    Boolean(tagName && PRIVATE_TAGS.has(tagName)) ||
    Boolean(attributes && attributesArePrivate(attributes));
  const styleRegion = parentStyle || tagName === 'style' || input.isStyle === true;
  const styleTextOverride = attributes
    ? getCssTextAttribute(attributes)
    : undefined;
  const node: StreamNodeState = {
    id,
    nodeType: Number(input.type),
    ...(tagName ? { tagName } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    privateRegion,
    styleRegion,
    children: new Set(),
    shadowHost: input.isShadowHost === true,
    shadowChild: input.isShadow === true,
    styleSheetEnabled: attributes ? isCssStyleTypeAttribute(attributes) : true,
    ...(typeof input.textContent === 'string'
      ? { textContent: input.textContent }
      : {}),
    ...(styleTextOverride === undefined ? {} : { styleTextOverride }),
  };
  if (
    node.shadowChild &&
    (parentId === undefined || state.nodes.get(parentId)?.shadowHost !== true)
  ) return false;
  state.nodes.set(id, node);
  if (parentId !== undefined) state.nodes.get(parentId)?.children.add(id);
  if (registerSource) {
    state.sourceParents.set(id, parentId);
    state.sourceChildren.set(id, []);
    if (parentId !== undefined) state.sourceChildren.get(parentId)?.push(id);
  }
  if ('childNodes' in input) {
    if (!Array.isArray(input.childNodes)) return false;
    for (const child of input.childNodes) {
      if (!registerSerializedTree(
        child,
        id,
        privateRegion,
        styleRegion,
        state,
        depth + 1,
        registerSource,
      )) return false;
    }
  }
  if (
    (tagName === 'style' || tagName === 'link') &&
    !initializeNodeStyleSheet(node, state)
  ) return false;
  return true;
}

function isContainerNode(node: StreamNodeState | undefined): boolean {
  return node?.nodeType === 0 || node?.nodeType === 2;
}

function getCssTextAttribute(attributes: Record<string, unknown>): string | undefined {
  const entry = Object.entries(attributes).find(([name]) => name === '_cssText');
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function isCssStyleTypeAttribute(attributes: Record<string, unknown>): boolean {
  const entry = Object.entries(attributes).find(
    ([name]) => name.toLowerCase() === 'type',
  );
  return entry ? isCssStyleType(entry[1]) : true;
}

function isCssStyleType(value: unknown): boolean {
  return (
    value === null ||
    value === '' ||
    (typeof value === 'string' && value.toLowerCase() === 'text/css')
  );
}

function materializesStyleSheet(node: StreamNodeState): boolean {
  if (!node.styleSheetEnabled) return false;
  if (node.tagName === 'link') {
    return Boolean(node.styleTextOverride);
  }
  return node.tagName === 'style';
}

function initializeNodeStyleSheet(
  node: StreamNodeState,
  state: SanitizerState,
): boolean {
  if (!materializesStyleSheet(node)) {
    state.nodeStyleSheets.set(node.id, null);
    return true;
  }
  const cssText = node.styleTextOverride ?? (
    node.tagName === 'style' ? collectStyleText(node.id, state) : undefined
  );
  if (cssText === undefined || !state.cssDocument) {
    state.nodeStyleSheets.set(node.id, null);
    return true;
  }
  const topology = parseStyleSheetTopology(cssText, state.cssDocument);
  if (!topology) {
    state.nodeStyleSheets.set(node.id, null);
    return true;
  }
  const ruleCount = countTopology(topology);
  if (state.styleRuleCount + ruleCount > MAX_REPLICA_STREAM_STYLE_RULES) return false;
  state.nodeStyleSheets.set(node.id, topology);
  state.styleRuleCount += ruleCount;
  return true;
}

function refreshNodeStyleSheet(id: number, state: SanitizerState): boolean {
  const node = state.nodes.get(id);
  if (!node || (node.tagName !== 'style' && node.tagName !== 'link')) return false;
  const previous = state.nodeStyleSheets.get(id);
  const previousCount = previous ? countTopology(previous) : 0;
  if (!materializesStyleSheet(node)) {
    state.nodeStyleSheets.set(id, null);
    state.styleRuleCount -= previousCount;
    return true;
  }
  const cssText = node.styleTextOverride ?? (
    node.tagName === 'style' ? collectStyleText(id, state) : undefined
  );
  if (cssText === undefined || !state.cssDocument) return false;
  const topology = parseStyleSheetTopology(cssText, state.cssDocument);
  if (!topology) return false;
  const nextCount = countTopology(topology);
  const total = state.styleRuleCount - previousCount + nextCount;
  if (total > MAX_REPLICA_STREAM_STYLE_RULES) return false;
  state.nodeStyleSheets.set(id, topology);
  state.styleRuleCount = total;
  return true;
}

function collectStyleText(id: number, state: SanitizerState): string {
  return (state.sourceChildren.get(id) ?? [])
    .map((childId) => {
      const child = state.nodes.get(childId);
      return child && (child.nodeType === 3 || child.nodeType === 4)
        ? child.textContent ?? ''
        : '';
    })
    .join('');
}

function attributesArePrivate(attributes: Record<string, unknown>): boolean {
  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    if (name === 'contenteditable') {
      if (rawValue === false) continue;
      if (typeof rawValue === 'string' && rawValue.trim().toLowerCase() === 'false') {
        continue;
      }
      return true;
    }
    if (name === 'role' && typeof rawValue === 'string') {
      if (
        rawValue
          .trim()
          .toLowerCase()
          .split(/\s+/u)
          .some((role) => PRIVATE_ROLES.has(role))
      ) return true;
    }
  }
  return false;
}

function changesPrivateBoundary(
  node: StreamNodeState,
  attributes: Record<string, unknown>,
): boolean {
  const relevant = Object.fromEntries(
    Object.entries(attributes).filter(([name]) => {
      const lower = name.toLowerCase();
      return lower === 'contenteditable' || lower === 'role';
    }),
  );
  if (Object.keys(relevant).length === 0) return false;
  // Any privacy-boundary mutation requests an atomic checkpoint. Determining
  // the resulting inherited state requires the complete current attribute set.
  return !node.privateRegion || Object.keys(relevant).length > 0;
}

function removeTree(id: number, state: SanitizerState): void {
  const node = state.nodes.get(id);
  if (!node) return;
  for (const child of node.children) removeTree(child, state);
  if (node.parentId !== undefined) state.nodes.get(node.parentId)?.children.delete(id);
  const topology = state.nodeStyleSheets.get(id);
  if (topology) state.styleRuleCount -= countTopology(topology);
  state.nodeStyleSheets.delete(id);
  state.nodes.delete(id);
}

function projectSiblingAnchor(
  input: unknown,
  parentId: number,
  direction: 'previous' | 'next',
  state: SanitizerState,
): number | null | undefined {
  if (input === null) return null;
  if (!isNodeId(input)) return undefined;
  const id = Number(input);
  if (
    !state.sourceParents.has(id) ||
    state.sourceParents.get(id) !== parentId
  ) return undefined;
  if (state.nodes.has(id)) return id;
  if (!state.omitted.has(id)) return undefined;
  const siblings = state.sourceChildren.get(parentId);
  const index = siblings?.indexOf(id) ?? -1;
  if (!siblings || index < 0) return undefined;
  const step = direction === 'next' ? 1 : -1;
  for (
    let siblingIndex = index + step;
    siblingIndex >= 0 && siblingIndex < siblings.length;
    siblingIndex += step
  ) {
    const siblingId = siblings[siblingIndex];
    if (siblingId !== undefined && state.nodes.has(siblingId)) return siblingId;
  }
  return null;
}

function registerSourceTree(
  input: unknown,
  parentId: number,
  previousId: unknown,
  nextId: unknown,
  state: SanitizerState,
): boolean {
  if (!isRecord(input) || !isNodeId(input.id)) return false;
  const rootId = Number(input.id);
  const siblings = state.sourceChildren.get(parentId);
  if (!siblings) return false;
  const previousIndex = previousId === null || previousId === undefined
    ? undefined
    : isNodeId(previousId)
      ? siblings.indexOf(Number(previousId))
      : -1;
  const nextIndex = nextId === null
    ? undefined
    : isNodeId(nextId)
      ? siblings.indexOf(Number(nextId))
      : -1;
  if (previousIndex === -1 || nextIndex === -1) return false;
  if (
    previousIndex !== undefined &&
    nextIndex !== undefined &&
    previousIndex + 1 !== nextIndex
  ) return false;
  const insertionIndex = nextIndex ?? (
    previousIndex === undefined ? siblings.length : previousIndex + 1
  );
  if (!registerSourceSubtree(input, parentId, state, 0, false)) return false;
  siblings.splice(insertionIndex, 0, rootId);
  return true;
}

function registerSourceSubtree(
  input: unknown,
  parentId: number | undefined,
  state: SanitizerState,
  depth: number,
  attachToParent: boolean,
): boolean {
  if (
    !isRecord(input) ||
    depth > MAX_REPLICA_NODE_DEPTH ||
    !isNodeId(input.id) ||
    state.sourceParents.has(Number(input.id)) ||
    state.sourceChildren.has(Number(input.id)) ||
    (parentId !== undefined && !state.sourceChildren.has(parentId))
  ) return false;
  const id = Number(input.id);
  state.sourceParents.set(id, parentId);
  state.sourceChildren.set(id, []);
  if (attachToParent && parentId !== undefined) {
    state.sourceChildren.get(parentId)?.push(id);
  }
  if (!('childNodes' in input)) return true;
  if (!Array.isArray(input.childNodes)) return false;
  for (const child of input.childNodes) {
    if (!registerSourceSubtree(child, id, state, depth + 1, true)) return false;
  }
  return true;
}

function removeSourceTree(id: number, state: SanitizerState): void {
  const children = [...(state.sourceChildren.get(id) ?? [])];
  for (const childId of children) removeSourceTree(childId, state);
  const parentId = state.sourceParents.get(id);
  if (parentId !== undefined) {
    const siblings = state.sourceChildren.get(parentId);
    const index = siblings?.indexOf(id) ?? -1;
    if (siblings && index >= 0) siblings.splice(index, 1);
  }
  state.sourceParents.delete(id);
  state.sourceChildren.delete(id);
  state.omitted.delete(id);
}

function collectSerializedIds(input: unknown): Set<number> | undefined {
  const ids = new Set<number>();
  const stack: Array<{ value: unknown; depth: number }> = [{ value: input, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > MAX_REPLICA_NODE_DEPTH || !isRecord(current.value)) {
      return undefined;
    }
    if (!isNodeId(current.value.id) || ids.has(Number(current.value.id))) return undefined;
    ids.add(Number(current.value.id));
    if (ids.size > MAX_REPLICA_NODES) return undefined;
    if ('childNodes' in current.value) {
      if (!Array.isArray(current.value.childNodes)) return undefined;
      for (const child of current.value.childNodes) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return ids;
}

function cloneState(state: SanitizerState): SanitizerState {
  return {
    nodes: new Map(
      [...state.nodes].map(([id, node]) => [
        id,
        { ...node, children: new Set(node.children) },
      ]),
    ),
    omitted: new Set(state.omitted),
    sourceParents: new Map(state.sourceParents),
    sourceChildren: new Map(
      [...state.sourceChildren].map(([id, children]) => [id, [...children]]),
    ),
    styleIds: new Set(state.styleIds),
    nodeStyleSheets: new Map(
      [...state.nodeStyleSheets].map(([id, topology]) => [
        id,
        topology === null ? null : cloneTopology(topology),
      ]),
    ),
    constructedStyleSheets: new Map(
      [...state.constructedStyleSheets].map(([id, topology]) => [
        id,
        cloneTopology(topology),
      ]),
    ),
    styleRuleCount: state.styleRuleCount,
    cssDocument: state.cssDocument,
    lastTimestamp: state.lastTimestamp,
  };
}

function forkState(
  state: SanitizerState,
  events: readonly unknown[],
): SanitizerState {
  if (events.some((event) => canChangeTrackedStructure(event, state))) {
    return cloneState(state);
  }
  // Scroll, text, attribute, and existing-sheet CSS updates only advance the
  // admitted timestamp. Share immutable topology for those hot-path batches;
  // DOM identity or constructed-style mutations still take a full transaction.
  return {
    nodes: state.nodes,
    omitted: state.omitted,
    sourceParents: state.sourceParents,
    sourceChildren: state.sourceChildren,
    styleIds: state.styleIds,
    nodeStyleSheets: state.nodeStyleSheets,
    constructedStyleSheets: state.constructedStyleSheets,
    styleRuleCount: state.styleRuleCount,
    cssDocument: state.cssDocument,
    lastTimestamp: state.lastTimestamp,
  };
}

function canChangeTrackedStructure(
  event: unknown,
  state: SanitizerState,
): boolean {
  if (!isRecord(event) || !isRecord(event.data)) return false;
  if (
    event.data.source === ADOPTED_STYLE_SHEET ||
    event.data.source === STYLE_SHEET_RULE
  ) return true;
  if (event.data.source !== MUTATION) return false;
  if (
    (Array.isArray(event.data.adds) && event.data.adds.length > 0) ||
    (Array.isArray(event.data.removes) && event.data.removes.length > 0)
  ) return true;
  if (
    Array.isArray(event.data.texts) &&
    event.data.texts.some((entry) =>
      isRecord(entry) &&
      isNodeId(entry.id) &&
      state.nodes.get(Number(entry.id))?.styleRegion === true)
  ) return true;
  return Array.isArray(event.data.attributes) && event.data.attributes.some((entry) => {
    if (!isRecord(entry) || !isNodeId(entry.id) || !isRecord(entry.attributes)) {
      return false;
    }
    const node = state.nodes.get(Number(entry.id));
    return (
      (node?.tagName === 'style' || node?.tagName === 'link') &&
      Object.keys(entry.attributes).some((name) => {
        const normalized = name.toLowerCase();
        return normalized === '_csstext' || normalized === 'type';
      })
    );
  });
}

function isNodeId(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isBoundedNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}
