import type { ReplicaDocumentIdentity } from './contracts';
import {
  sameSourceDocument,
  sourceDocumentIdentity,
  type ReplicaSourceDocumentIdentity,
} from './source-identity';
import {
  isSourcePrivateTagName,
  sourceAttributesArePrivate,
} from './source-privacy-policy';

export {
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from './source-identity';

const FULL_SNAPSHOT_EVENT = 2;
const INCREMENTAL_EVENT = 3;
const MUTATION_SOURCE = 0;
const TEXT_NODE = 3;
const CDATA_NODE = 4;
const COMMENT_NODE = 5;
export const MAX_SOURCE_REVISION_ENTRIES = 100_000;

const NON_CONTENT_TAGS = new Set([
  'head',
  'noscript',
  'script',
  'style',
  'template',
]);

export interface ReplicaSourceDomTextRecord {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly nodeType: 3;
  readonly revision: number;
  readonly source: string;
}

export interface ReplicaSourceControlTextRecord {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly nodeType: 1;
  readonly controlTarget: 'value' | 'placeholder';
  readonly revision: number;
  readonly source: string;
}

export type ReplicaSourceTextRecord =
  | ReplicaSourceDomTextRecord
  | ReplicaSourceControlTextRecord;

export type ReplicaSourceTextChange =
  | {
      readonly kind: 'upsert';
      readonly record: ReplicaSourceTextRecord;
    }
  | {
      readonly kind: 'remove';
      readonly document: ReplicaSourceDocumentIdentity;
      readonly nodeId: number;
      readonly revision: number;
    };

export interface PreparedSourceValueUpdate {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly documentLanguage?: string;
  readonly documentLanguageChanged: boolean;
  readonly records: readonly ReplicaSourceTextRecord[];
  readonly changes: readonly ReplicaSourceTextChange[];
  commit(): void;
}

export interface SourceValueModelOptions {
  readonly maxRevisionEntries?: number;
}

interface SourceNodeState {
  readonly id: number;
  readonly nodeType: number;
  readonly tagName?: string;
  readonly parentId?: number;
  readonly privateRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly children: Set<number>;
  readonly source?: string;
  readonly language?: string;
}

interface ModelState {
  readonly document: ReplicaSourceDocumentIdentity | undefined;
  readonly documentLanguage: string | undefined;
  readonly nodes: Map<number, SourceNodeState>;
  readonly records: Map<number, ReplicaSourceTextRecord>;
  readonly revisions: Map<number, number>;
}

/**
 * Canonical source text for one exact rrweb document. Updates are prepared
 * transactionally and become observable only after replay has cast the same
 * admitted events. Translated projections never enter this model.
 */
export class SourceValueModel {
  #state: ModelState = emptyState();
  readonly #maxRevisionEntries: number;

  constructor(options: SourceValueModelOptions = {}) {
    this.#maxRevisionEntries = positiveInteger(
      options.maxRevisionEntries,
      MAX_SOURCE_REVISION_ENTRIES,
    );
  }

  fork(): SourceValueModel {
    const fork = new SourceValueModel({
      maxRevisionEntries: this.#maxRevisionEntries,
    });
    fork.#state = {
      document: this.#state.document,
      documentLanguage: this.#state.documentLanguage,
      nodes: cloneNodes(this.#state.nodes),
      records: new Map(this.#state.records),
      revisions: new Map(this.#state.revisions),
    };
    return fork;
  }

  get document(): ReplicaSourceDocumentIdentity | undefined {
    return this.#state.document;
  }

  get documentLanguage(): string | undefined {
    return this.#state.documentLanguage;
  }

  records(): readonly ReplicaSourceTextRecord[] {
    return Object.freeze([...this.#state.records.values()]);
  }

  get(nodeId: number): ReplicaSourceTextRecord | undefined {
    return this.#state.records.get(nodeId);
  }

  isCurrent(record: ReplicaSourceTextRecord): boolean {
    const current = this.#state.records.get(record.nodeId);
    return Boolean(
      current &&
        sameSourceDocument(current.document, record.document) &&
        current.revision === record.revision &&
        current.source === record.source,
    );
  }

  prepareCheckpoint(
    identity: ReplicaDocumentIdentity,
    events: readonly unknown[],
  ): PreparedSourceValueUpdate | undefined {
    const document = sourceDocumentIdentity(identity);
    const snapshot = events.find(
      (event): event is Record<string, unknown> =>
        isRecord(event) && event.type === FULL_SNAPSHOT_EVENT,
    );
    if (!snapshot || !isRecord(snapshot.data) || !('node' in snapshot.data)) {
      return undefined;
    }

    const sameDocument = this.#state.document
      ? sameSourceDocument(this.#state.document, document)
      : false;
    const revisions = sameDocument
      ? new Map(this.#state.revisions)
      : new Map<number, number>();
    const nodes = new Map<number, SourceNodeState>();
    if (!registerTree(snapshot.data.node, undefined, false, false, nodes, 0)) {
      return undefined;
    }
    const records = buildRecords(document, nodes, revisions, this.#state, sameDocument);
    const changes = checkpointChanges(
      document,
      records,
      revisions,
      this.#state,
      sameDocument,
    );
    if (revisions.size > this.#maxRevisionEntries) return undefined;
    const documentLanguage = readDocumentLanguage(nodes);
    return this.#prepared(
      { document, documentLanguage, nodes, records, revisions },
      changes,
      documentLanguage !== this.#state.documentLanguage,
    );
  }

  prepareBatch(
    identity: ReplicaDocumentIdentity,
    events: readonly unknown[],
  ): PreparedSourceValueUpdate | undefined {
    const document = sourceDocumentIdentity(identity);
    if (
      !this.#state.document ||
      !sameSourceDocument(this.#state.document, document)
    ) return undefined;

    const nodes = cloneNodes(this.#state.nodes);
    const records = new Map(this.#state.records);
    const revisions = new Map(this.#state.revisions);
    const changes = new Map<number, ReplicaSourceTextChange>();
    let documentLanguage = this.#state.documentLanguage;

    for (const event of events) {
      if (!isRecord(event) || event.type !== INCREMENTAL_EVENT) continue;
      if (!isRecord(event.data) || event.data.source !== MUTATION_SOURCE) continue;
      const languageResult = applyDocumentLanguageMutation(
        event.data,
        nodes,
        documentLanguage,
      );
      if (!languageResult.valid) return undefined;
      documentLanguage = languageResult.language;
      if (!applyMutation(event.data, document, nodes, records, revisions, changes)) {
        return undefined;
      }
      // Structural mutations can replace or remove the document element, so
      // committed language metadata must be derived from the resulting tree.
      documentLanguage = readDocumentLanguage(nodes);
      if (revisions.size > this.#maxRevisionEntries) return undefined;
    }

    return this.#prepared(
      { document, documentLanguage, nodes, records, revisions },
      Object.freeze([...changes.values()]),
      documentLanguage !== this.#state.documentLanguage,
    );
  }

  clear(): void {
    this.#state = emptyState();
  }

  #prepared(
    next: ModelState,
    changes: readonly ReplicaSourceTextChange[],
    documentLanguageChanged: boolean,
  ): PreparedSourceValueUpdate {
    let committed = false;
    const records = Object.freeze([...next.records.values()]);
    return {
      document: next.document as ReplicaSourceDocumentIdentity,
      ...(next.documentLanguage
        ? { documentLanguage: next.documentLanguage }
        : {}),
      documentLanguageChanged,
      records,
      changes: Object.freeze([...changes]),
      commit: () => {
        if (committed) return;
        committed = true;
        this.#state = next;
      },
    };
  }
}

function emptyState(): ModelState {
  return {
    document: undefined,
    documentLanguage: undefined,
    nodes: new Map(),
    records: new Map(),
    revisions: new Map(),
  };
}

function buildRecords(
  document: ReplicaSourceDocumentIdentity,
  nodes: Map<number, SourceNodeState>,
  revisions: Map<number, number>,
  previous: ModelState,
  sameDocument: boolean,
): Map<number, ReplicaSourceTextRecord> {
  const records = new Map<number, ReplicaSourceTextRecord>();
  for (const node of nodes.values()) {
    if (!isEligibleText(node)) continue;
    const source = node.source ?? '';
    const old = sameDocument ? previous.records.get(node.id) : undefined;
    const revision = old?.source === source
      ? old.revision
      : nextRevision(revisions, node.id);
    revisions.set(node.id, revision);
    records.set(node.id, sourceRecord(document, node.id, revision, source));
  }
  return records;
}

function checkpointChanges(
  document: ReplicaSourceDocumentIdentity,
  records: Map<number, ReplicaSourceTextRecord>,
  revisions: Map<number, number>,
  previous: ModelState,
  sameDocument: boolean,
): readonly ReplicaSourceTextChange[] {
  const changes: ReplicaSourceTextChange[] = [...records.values()].map(
    (record) => ({ kind: 'upsert', record }),
  );
  if (sameDocument) {
    for (const old of previous.records.values()) {
      if (records.has(old.nodeId)) continue;
      const revision = nextRevision(revisions, old.nodeId);
      revisions.set(old.nodeId, revision);
      changes.push({ kind: 'remove', document, nodeId: old.nodeId, revision });
    }
  }
  return Object.freeze(changes);
}

function applyMutation(
  data: Record<string, unknown>,
  document: ReplicaSourceDocumentIdentity,
  nodes: Map<number, SourceNodeState>,
  records: Map<number, ReplicaSourceTextRecord>,
  revisions: Map<number, number>,
  changes: Map<number, ReplicaSourceTextChange>,
): boolean {
  if (
    !Array.isArray(data.texts) ||
    !Array.isArray(data.attributes) ||
    !Array.isArray(data.removes) ||
    !Array.isArray(data.adds)
  ) return false;

  for (const input of data.texts) {
    if (!isRecord(input) || !isNodeId(input.id) || typeof input.value !== 'string') {
      return false;
    }
    const nodeId = Number(input.id);
    const node = nodes.get(nodeId);
    if (!node) return false;
    if (node.nodeType !== TEXT_NODE) {
      // rrweb character-data mutations also target admitted Comment and CDATA
      // nodes. They are intentionally outside the translatable source model.
      if (node.nodeType === CDATA_NODE || node.nodeType === COMMENT_NODE) continue;
      return false;
    }
    if (!isEligibleText(node)) continue;
    const previous = records.get(nodeId);
    const revision = previous?.source === input.value
      ? previous.revision
      : nextRevision(revisions, nodeId);
    revisions.set(nodeId, revision);
    const nextNode: SourceNodeState = { ...node, source: input.value };
    nodes.set(nodeId, nextNode);
    const record = sourceRecord(document, nodeId, revision, input.value);
    records.set(nodeId, record);
    // Even an equal-value rrweb write overwrites the projection and therefore
    // needs a cache-backed reproject without inventing a new source revision.
    changes.set(nodeId, { kind: 'upsert', record });
  }

  for (const input of data.removes) {
    if (!isRecord(input) || !isNodeId(input.id)) return false;
    const nodeId = Number(input.id);
    if (!nodes.has(nodeId)) return false;
    removeTree(nodeId, document, nodes, records, revisions, changes);
  }

  for (const input of data.adds) {
    if (
      !isRecord(input) ||
      !isNodeId(input.parentId) ||
      !('node' in input)
    ) return false;
    const parentId = Number(input.parentId);
    const parent = nodes.get(parentId);
    if (!parent) return false;
    const added = new Map<number, SourceNodeState>();
    if (
      !registerTree(
        input.node,
        parentId,
        parent.privateRegion,
        parent.nonContentRegion,
        added,
        0,
        nodes,
      )
    ) return false;
    for (const node of added.values()) nodes.set(node.id, node);
    const root = firstNode(added);
    if (!root) return false;
    nodes.get(parentId)?.children.add(root.id);
    for (const node of added.values()) {
      if (!isEligibleText(node)) continue;
      const revision = nextRevision(revisions, node.id);
      revisions.set(node.id, revision);
      const record = sourceRecord(
        document,
        node.id,
        revision,
        node.source ?? '',
      );
      records.set(node.id, record);
      changes.set(node.id, { kind: 'upsert', record });
    }
  }
  return true;
}

function applyDocumentLanguageMutation(
  data: Record<string, unknown>,
  nodes: Map<number, SourceNodeState>,
  current: string | undefined,
): { readonly valid: boolean; readonly language: string | undefined } {
  if (!Array.isArray(data.attributes)) return { valid: false, language: current };
  let language = current;
  for (const input of data.attributes) {
    if (
      !isRecord(input) ||
      !isNodeId(input.id) ||
      !isRecord(input.attributes)
    ) return { valid: false, language: current };
    const nodeId = Number(input.id);
    const node = nodes.get(nodeId);
    if (!node) return { valid: false, language: current };
    if (node.tagName !== 'html') continue;
    const entry = Object.entries(input.attributes).find(
      ([name]) => name.toLowerCase() === 'lang',
    );
    if (!entry) continue;
    const next = entry[1] === null
      ? undefined
      : typeof entry[1] === 'string'
        ? normalizeLanguage(entry[1])
        : null;
    if (next === null) return { valid: false, language: current };
    language = next;
    nodes.set(nodeId, {
      ...node,
      ...(next ? { language: next } : { language: undefined }),
    });
  }
  return { valid: true, language };
}

function removeTree(
  nodeId: number,
  document: ReplicaSourceDocumentIdentity,
  nodes: Map<number, SourceNodeState>,
  records: Map<number, ReplicaSourceTextRecord>,
  revisions: Map<number, number>,
  changes: Map<number, ReplicaSourceTextChange>,
): void {
  const node = nodes.get(nodeId);
  if (!node) return;
  for (const child of node.children) {
    removeTree(child, document, nodes, records, revisions, changes);
  }
  if (records.delete(nodeId)) {
    const revision = nextRevision(revisions, nodeId);
    revisions.set(nodeId, revision);
    changes.set(nodeId, { kind: 'remove', document, nodeId, revision });
  }
  if (node.parentId !== undefined) nodes.get(node.parentId)?.children.delete(nodeId);
  nodes.delete(nodeId);
}

function registerTree(
  input: unknown,
  parentId: number | undefined,
  parentPrivate: boolean,
  parentNonContent: boolean,
  target: Map<number, SourceNodeState>,
  depth: number,
  existing: Map<number, SourceNodeState> = target,
): boolean {
  if (
    !isRecord(input) ||
    depth > 128 ||
    !isNodeId(input.id) ||
    !Number.isSafeInteger(input.type) ||
    target.has(Number(input.id)) ||
    existing.has(Number(input.id))
  ) return false;
  const id = Number(input.id);
  const nodeType = Number(input.type);
  const tagName = nodeType === 2 && typeof input.tagName === 'string'
    ? input.tagName.toLowerCase()
    : undefined;
  const attributes = nodeType === 2 && isRecord(input.attributes)
    ? input.attributes
    : undefined;
  const privateRegion =
    parentPrivate ||
    Boolean(tagName && isSourcePrivateTagName(tagName)) ||
    Boolean(attributes && sourceAttributesArePrivate(attributes));
  const nonContentRegion =
    parentNonContent ||
    Boolean(tagName && NON_CONTENT_TAGS.has(tagName)) ||
    input.isStyle === true;
  const node: SourceNodeState = {
    id,
    nodeType,
    ...(tagName ? { tagName } : {}),
    ...(parentId === undefined ? {} : { parentId }),
    privateRegion,
    nonContentRegion,
    children: new Set(),
    ...(nodeType === TEXT_NODE && typeof input.textContent === 'string'
      ? { source: input.textContent }
      : {}),
    ...(tagName === 'html' && attributes
      ? languageFromAttributes(attributes)
        ? { language: languageFromAttributes(attributes) }
        : {}
      : {}),
  };
  target.set(id, node);
  if ('childNodes' in input) {
    if (!Array.isArray(input.childNodes)) return false;
    for (const child of input.childNodes) {
      if (
        !registerTree(
          child,
          id,
          privateRegion,
          nonContentRegion,
          target,
          depth + 1,
          existing,
        )
      ) return false;
      const childRecord = target.get(Number((child as Record<string, unknown>).id));
      if (childRecord) node.children.add(childRecord.id);
    }
  }
  return true;
}

function cloneNodes(
  source: Map<number, SourceNodeState>,
): Map<number, SourceNodeState> {
  return new Map(
    [...source].map(([id, node]) => [id, { ...node, children: new Set(node.children) }]),
  );
}

function readDocumentLanguage(
  nodes: Map<number, SourceNodeState>,
): string | undefined {
  for (const node of nodes.values()) {
    if (node.tagName === 'html') return node.language;
  }
  return undefined;
}

function languageFromAttributes(
  attributes: Record<string, unknown>,
): string | undefined {
  const entry = Object.entries(attributes).find(
    ([name]) => name.toLowerCase() === 'lang',
  );
  return typeof entry?.[1] === 'string'
    ? normalizeLanguage(entry[1])
    : undefined;
}

function normalizeLanguage(value: string): string | undefined {
  const normalized = value.trim().slice(0, 128);
  return normalized || undefined;
}

function sourceRecord(
  document: ReplicaSourceDocumentIdentity,
  nodeId: number,
  revision: number,
  source: string,
): ReplicaSourceTextRecord {
  return Object.freeze({ document, nodeId, nodeType: 3, revision, source });
}

function isEligibleText(node: SourceNodeState): boolean {
  return (
    node.nodeType === TEXT_NODE &&
    !node.privateRegion &&
    !node.nonContentRegion &&
    typeof node.source === 'string'
  );
}

function nextRevision(revisions: Map<number, number>, nodeId: number): number {
  return (revisions.get(nodeId) ?? 0) + 1;
}

function firstNode(nodes: Map<number, SourceNodeState>): SourceNodeState | undefined {
  return nodes.values().next().value;
}

function isNodeId(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}
