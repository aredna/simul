import {
  isValidImageDimensions,
  readSourceImageDescriptor,
  type ImageDimensions,
  type ImageVisibilityTier,
  type SourceImageChange,
  type SourceImageDescriptor,
} from './contracts';
import {
  readSourceDocumentIdentity,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';
import { hasExactKeysWithOptional } from '../exact-record';

export const MAX_SOURCE_IMAGE_ENTRIES = 10_000;

export interface SourceImageUpsert extends ImageDimensions {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly contentChanged: boolean;
  readonly observationChanged: boolean;
  /** True only when capture inputs/crop may differ, not for pure motion. */
  readonly captureChanged?: boolean;
  readonly visibility: ImageVisibilityTier;
  readonly connected: true;
}

export type SourceImageModelResult =
  | { readonly status: 'changed'; readonly change: SourceImageChange }
  | { readonly status: 'unchanged' }
  | { readonly status: 'rejected' | 'overflow' };

interface ImageRevisionState {
  readonly contentRevision: number;
  readonly captureRevision: number;
  readonly observationRevision: number;
  readonly tombstoned: boolean;
}

/**
 * Exact-document image ledger. Raw source attributes never enter this model;
 * the source adapter reports only whether its private content token changed.
 */
export class SourceImageModel {
  readonly #maxEntries: number;
  #document: ReplicaSourceDocumentIdentity | undefined;
  #records = new Map<number, SourceImageDescriptor>();
  #revisions = new Map<number, ImageRevisionState>();
  #retiredRevisionFloor = 0;

  constructor(options: { readonly maxEntries?: number } = {}) {
    this.#maxEntries = positiveInteger(
      options.maxEntries,
      MAX_SOURCE_IMAGE_ENTRIES,
    );
  }

  get document(): ReplicaSourceDocumentIdentity | undefined {
    return this.#document;
  }

  beginDocument(document: ReplicaSourceDocumentIdentity): boolean {
    const parsed = readSourceDocumentIdentity(document);
    if (!parsed) return false;
    if (this.#document && sameSourceDocument(this.#document, parsed)) return true;
    this.#document = parsed;
    this.#records.clear();
    this.#revisions.clear();
    this.#retiredRevisionFloor = 0;
    return true;
  }

  records(): readonly SourceImageDescriptor[] {
    return Object.freeze([...this.#records.values()]);
  }

  get(nodeId: number): SourceImageDescriptor | undefined {
    return this.#records.get(nodeId);
  }

  upsert(input: SourceImageUpsert): SourceImageModelResult {
    const parsed = readSourceImageUpsert(input);
    if (
      !parsed ||
      !this.#document ||
      !sameSourceDocument(this.#document, parsed.document)
    ) return { status: 'rejected' };

    let revision = this.#revisions.get(parsed.nodeId);
    if (!revision && this.#revisions.size >= this.#maxEntries) {
      this.#retireOldestTombstone();
      revision = this.#revisions.get(parsed.nodeId);
      if (!revision && this.#revisions.size >= this.#maxEntries) {
        return { status: 'overflow' };
      }
    }
    const previous = this.#records.get(parsed.nodeId);
    const newIdentityRevisionFloor = revision
      ? 0
      : this.#retiredRevisionFloor;
    const needsContentRevision =
      !previous ||
      revision?.tombstoned === true ||
      parsed.contentChanged;
    const pixelGeometryChanged = !previous ||
      previous.renderedWidth !== parsed.renderedWidth ||
      previous.renderedHeight !== parsed.renderedHeight ||
      previous.intrinsicWidth !== parsed.intrinsicWidth ||
      previous.intrinsicHeight !== parsed.intrinsicHeight;
    const observationChanged =
      needsContentRevision ||
      parsed.captureChanged ||
      parsed.observationChanged ||
      !previous ||
      previous.visibility !== parsed.visibility ||
      previous.renderedWidth !== parsed.renderedWidth ||
      previous.renderedHeight !== parsed.renderedHeight ||
      previous.intrinsicWidth !== parsed.intrinsicWidth ||
      previous.intrinsicHeight !== parsed.intrinsicHeight;
    if (!observationChanged && revision && previous) {
      return { status: 'unchanged' };
    }

    const contentRevision = needsContentRevision
      ? nextRevision(revision?.contentRevision, newIdentityRevisionFloor)
      : revision?.contentRevision;
    const needsCaptureRevision = !previous ||
      revision?.tombstoned === true ||
      parsed.captureChanged ||
      pixelGeometryChanged;
    const captureRevision = needsCaptureRevision
      ? nextRevision(revision?.captureRevision, newIdentityRevisionFloor)
      : revision?.captureRevision;
    const observationRevision = nextRevision(
      revision?.observationRevision,
      newIdentityRevisionFloor,
    );
    if (!contentRevision || !captureRevision || !observationRevision) {
      return { status: 'overflow' };
    }
    const nextRevisionState: ImageRevisionState = {
      contentRevision,
      captureRevision,
      observationRevision,
      tombstoned: false,
    };
    const descriptor = createDescriptor(
      this.#document,
      parsed,
      nextRevisionState,
    );
    this.#revisions.set(parsed.nodeId, nextRevisionState);
    this.#records.set(parsed.nodeId, descriptor);
    return {
      status: 'changed',
      change: Object.freeze({ kind: 'upsert', descriptor }),
    };
  }

  remove(
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ): SourceImageModelResult {
    const parsedDocument = readSourceDocumentIdentity(document);
    if (
      !parsedDocument ||
      !this.#document ||
      !sameSourceDocument(this.#document, parsedDocument) ||
      !isNodeId(nodeId)
    ) return { status: 'rejected' };
    const previous = this.#records.get(nodeId);
    const revision = this.#revisions.get(nodeId);
    if (!previous || !revision || revision.tombstoned) {
      return { status: 'unchanged' };
    }
    const contentRevision = nextRevision(revision.contentRevision);
    const captureRevision = nextRevision(revision.captureRevision);
    const observationRevision = nextRevision(revision.observationRevision);
    if (!contentRevision || !captureRevision || !observationRevision) {
      return { status: 'overflow' };
    }
    this.#records.delete(nodeId);
    this.#revisions.set(nodeId, {
      contentRevision,
      captureRevision,
      observationRevision,
      tombstoned: true,
    });
    return {
      status: 'changed',
      change: Object.freeze({
        kind: 'remove',
        document: this.#document,
        nodeId,
        contentRevision,
        observationRevision,
      }),
    };
  }

  isCurrent(descriptor: SourceImageDescriptor): boolean {
    const parsed = readSourceImageDescriptor(descriptor);
    if (!parsed) return false;
    const current = this.#records.get(parsed.nodeId);
    return Boolean(
      current &&
      sameSourceDocument(current.document, parsed.document) &&
      current.contentRevision === parsed.contentRevision &&
      current.captureRevision === parsed.captureRevision &&
      current.observationRevision === parsed.observationRevision &&
      sameDescriptorFacts(current, parsed),
    );
  }

  clear(): void {
    this.#document = undefined;
    this.#records.clear();
    this.#revisions.clear();
    this.#retiredRevisionFloor = 0;
  }

  #retireOldestTombstone(): void {
    for (const [nodeId, revision] of this.#revisions) {
      if (!revision.tombstoned) continue;
      this.#retiredRevisionFloor = Math.max(
        this.#retiredRevisionFloor,
        revision.contentRevision,
        revision.captureRevision,
        revision.observationRevision,
      );
      this.#revisions.delete(nodeId);
      return;
    }
  }
}

function createDescriptor(
  document: ReplicaSourceDocumentIdentity,
  input: SourceImageUpsert,
  revision: ImageRevisionState,
): SourceImageDescriptor {
  return Object.freeze({
    document,
    nodeId: input.nodeId,
    sourceKind: 'img',
    contentRevision: revision.contentRevision,
    captureRevision: revision.captureRevision,
    observationRevision: revision.observationRevision,
    visibility: input.visibility,
    connected: true,
    renderedWidth: input.renderedWidth,
    renderedHeight: input.renderedHeight,
    ...(input.intrinsicWidth !== undefined && input.intrinsicHeight !== undefined
      ? {
          intrinsicWidth: input.intrinsicWidth,
          intrinsicHeight: input.intrinsicHeight,
        }
      : {}),
  });
}

function sameDescriptorFacts(
  left: SourceImageDescriptor,
  right: SourceImageDescriptor,
): boolean {
  return (
    left.sourceKind === right.sourceKind &&
    left.connected === right.connected &&
    left.visibility === right.visibility &&
    left.renderedWidth === right.renderedWidth &&
    left.renderedHeight === right.renderedHeight &&
    left.intrinsicWidth === right.intrinsicWidth &&
    left.intrinsicHeight === right.intrinsicHeight
  );
}

function isNodeId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function readSourceImageUpsert(input: unknown): SourceImageUpsert | undefined {
  if (!isRecordWithExactKeys(input, [
    'document',
    'nodeId',
    'contentChanged',
    'observationChanged',
    'visibility',
    'connected',
    'renderedWidth',
    'renderedHeight',
  ], ['intrinsicWidth', 'intrinsicHeight', 'captureChanged'])) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  const hasIntrinsicWidth = Object.hasOwn(input, 'intrinsicWidth');
  const hasIntrinsicHeight = Object.hasOwn(input, 'intrinsicHeight');
  if (hasIntrinsicWidth !== hasIntrinsicHeight) return undefined;
  const dimensions: ImageDimensions = {
    renderedWidth: input.renderedWidth as number,
    renderedHeight: input.renderedHeight as number,
    ...(hasIntrinsicWidth && hasIntrinsicHeight
      ? {
          intrinsicWidth: input.intrinsicWidth as number,
          intrinsicHeight: input.intrinsicHeight as number,
        }
      : {}),
  };
  if (
    !document ||
    !isNodeId(input.nodeId as number) ||
    typeof input.contentChanged !== 'boolean' ||
    typeof input.observationChanged !== 'boolean' ||
    (Object.hasOwn(input, 'captureChanged') &&
      typeof input.captureChanged !== 'boolean') ||
    !isVisibility(input.visibility as string) ||
    input.connected !== true ||
    !isValidImageDimensions(dimensions)
  ) return undefined;
  return Object.freeze({
    document,
    nodeId: input.nodeId as number,
    contentChanged: input.contentChanged,
    observationChanged: input.observationChanged,
    captureChanged: Object.hasOwn(input, 'captureChanged')
      ? input.captureChanged as boolean
      : input.observationChanged as boolean,
    visibility: input.visibility as ImageVisibilityTier,
    connected: true,
    renderedWidth: dimensions.renderedWidth,
    renderedHeight: dimensions.renderedHeight,
    ...(dimensions.intrinsicWidth !== undefined &&
    dimensions.intrinsicHeight !== undefined
      ? {
          intrinsicWidth: dimensions.intrinsicWidth,
          intrinsicHeight: dimensions.intrinsicHeight,
        }
      : {}),
  });
}

function isRecordWithExactKeys(
  value: unknown,
  required: readonly string[],
  optional?: readonly string[],
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return hasExactKeysWithOptional(
    value as Record<string, unknown>,
    required,
    optional,
  );
}

function isVisibility(value: string): value is ImageVisibilityTier {
  return value === 'visible' || value === 'near' || value === 'background';
}

function nextRevision(value: number | undefined, floor = 0): number | undefined {
  const next = Math.max(value ?? 0, floor) + 1;
  return Number.isSafeInteger(next) ? next : undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? value as number
    : fallback;
}
