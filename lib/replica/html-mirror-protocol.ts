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
  createHtmlMirrorShellLedger,
  htmlMirrorJsonBytes,
  readHtmlMirrorAdoptedStyleSheets,
  readHtmlMirrorDocumentContent,
  readHtmlMirrorCanvasBackgroundColor,
  readHtmlMirrorFillChildren,
  readHtmlMirrorNode,
  readHtmlMirrorRepresentability,
  type HtmlMirrorCheckpointFill,
  type HtmlMirrorDocumentContent,
  type HtmlMirrorElementNode,
  type HtmlMirrorNamespace,
  type HtmlMirrorDocumentMode,
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
  MAX_SCROLL_PANES,
  PRIMARY_SCROLL_MAX,
  VISUAL_SCALE_MAX,
} from '../primary-scroll';
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
    readonly documentMode: HtmlMirrorDocumentMode;
    readonly byteLength: number;
    readonly captureMs: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly documentWidth: number;
    readonly documentHeight: number;
    readonly representability: HtmlMirrorRepresentabilitySummary;
    /**
     * How many `checkpoint-part` messages of the same sequence fill the
     * root's `childrenFollow` nodes (D163). Absent or 0: the root is whole.
     */
    readonly partCount?: number;
    /**
     * A preview (D163): far boxes are `placeholder`s. It is shown until the
     * full copy of a later sequence commits, and never patched.
     */
    readonly preview?: true;
  };
}

/**
 * One part of a checkpoint read in slices (D163): what some of the
 * checkpoint's `childrenFollow` nodes hold. Parts carry the checkpoint's
 * sequence and may come in any order; each shell is filled exactly once.
 */
export interface HtmlMirrorCheckpointPart {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v2:checkpoint-part';
  readonly identity: ReplicaDocumentIdentity;
  readonly index: number;
  readonly fills: readonly HtmlMirrorCheckpointFill[];
  readonly byteLength: number;
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
      readonly selectPresentationStyle?: string;
      readonly canvasBackgroundColor?: string;
      readonly resolvedStyleSheetText?: string;
      /**
       * `resolvedStyleSheetText` is what follows the first so many
       * characters of the text the mirror holds for this `<style>` (D143):
       * a page that adds rules by appending text to a style had the whole
       * sheet sent at every append.
       */
      readonly resolvedStyleSheetTextFrom?: number;
      readonly customElementDefined?: true;
      readonly assignedNodeIds?: readonly number[];
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
  /**
   * The other patches of the same frame of the page, in order, each with
   * this one's sequence (D143). The page changed in one step: the mirror
   * applies the patches of that step one after the other and all or none,
   * so that it never shows a state the page was not in.
   */
  readonly more?: readonly HtmlMirrorPatchBatch[];
}

/** Patches one frame of the page can take: what `<html>` holds, the lists, the rest. */
export const MAX_HTML_MIRROR_FRAME_PATCHES = 3;

/**
 * One message for the patches of one frame of the page, which share a
 * sequence. A single patch is itself.
 */
export function createHtmlMirrorPatchFrame(
  patches: readonly HtmlMirrorPatchBatch[],
): HtmlMirrorPatchBatch | undefined {
  const [first, ...more] = patches;
  if (
    !first || patches.length > MAX_HTML_MIRROR_FRAME_PATCHES ||
    patches.some((patch) =>
      patch.more !== undefined ||
      patch.firstSequence !== first.firstSequence ||
      patch.lastSequence !== first.lastSequence ||
      patch.identity.sequence !== first.identity.sequence ||
      !sameDocument(patch.identity, first.identity))
  ) return undefined;
  return more.length === 0
    ? first
    : Object.freeze({ ...first, more: Object.freeze(more) });
}

/** The patches of a message in the order they are applied. */
export function htmlMirrorFramePatches(
  batch: HtmlMirrorPatchBatch,
): readonly HtmlMirrorPatchBatch[] {
  return batch.more ? [batch, ...batch.more] : [batch];
}

/** Panes the mirror follows at once; the most recently scrolled are kept. */
export const MAX_HTML_MIRROR_SCROLL_PANES = MAX_SCROLL_PANES;

/**
 * A pane that scrolls on its own, apart from the document (D122): the id the
 * mirror already holds for the element, and how far it is scrolled inside
 * its own range. An offset is negative where the page counts it that way (a
 * right-to-left strip, a reversed column). Layout numbers only: no text,
 * address or attribute.
 */
export interface HtmlMirrorPaneScroll {
  readonly nodeId: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly maxScrollX: number;
  readonly maxScrollY: number;
  /**
   * Other panes at this very place: rows that a script keeps in step are
   * named together, with one set of numbers for all of them.
   */
  readonly alsoNodeIds?: readonly number[];
}

/** The version of the pane boxes this build sends and reads (D180). */
export const HTML_MIRROR_PANE_BOXES_VERSION = 1 as const;
/** Pane boxes one message names, at most (D180). */
export const MAX_HTML_MIRROR_PANE_BOXES = 1_024;

/**
 * A pane the reader met that the reader can scroll (D180), at its start or
 * not: its box in the tab's document, in CSS pixels from the document's
 * top left corner (where the page's own scrolling does not move it), and
 * its scroll ranges. For the panel's test of which pane the wheel is over.
 * A box of no width and no height says the element is no longer a pane.
 */
export interface HtmlMirrorPaneBox {
  readonly nodeId: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly maxScrollX: number;
  readonly maxScrollY: number;
}

/**
 * The scrollable panes' boxes (D180), beside the list of panes that are
 * not at their start. `whole`: every pane, any other is none; otherwise
 * the boxes that changed. Versioned on its own, so a later change to it
 * leaves the scroll message's other fields as they are.
 */
export interface HtmlMirrorPaneBoxes {
  readonly version: typeof HTML_MIRROR_PANE_BOXES_VERSION;
  readonly whole: boolean;
  readonly boxes: readonly HtmlMirrorPaneBox[];
}

export interface HtmlMirrorScrollState {
  /** The document's place and its scroll ranges. */
  readonly scrollX: number;
  readonly scrollY: number;
  readonly maxScrollX: number;
  readonly maxScrollY: number;
  /**
   * Every pane the mirror knows that is not at its start (D122); a pane that
   * is not listed is at its start, and an empty list means none is scrolled.
   * The whole list travels with every checkpoint. One message names at most
   * `MAX_HTML_MIRROR_SCROLL_PANES` panes, in `panes` or in `movedPanes`,
   * never in both.
   */
  readonly panes?: readonly HtmlMirrorPaneScroll[];
  /**
   * The panes that moved since the last list, and no others: every other
   * pane is where the lists before put it. A pane that went back to its
   * start is named with its offsets at 0. A message with neither list means
   * that no pane moved, so plain page scrolling names none, and a page with
   * thousands of scrolled panes names the one that moves.
   */
  readonly movedPanes?: readonly HtmlMirrorPaneScroll[];
  /**
   * The viewport-scale pane the tab scrolls in place of its document, sent
   * only with a list: one of `panes`, or with `movedPanes` any pane named
   * so far that is not at its start. A list without it says there is none.
   * The replica scrolls it like any other pane; where the replica cannot,
   * its progress moves the replica document instead (D100).
   */
  readonly primaryPaneId?: number;
  /** Every scrollable pane the reader met, with its box (D180). */
  readonly paneBoxes?: HtmlMirrorPaneBoxes;
  /**
   * Pinch zoom (D115): how many times the tab magnifies the page on top of
   * its browser zoom, and where the magnified view's corner is inside the
   * layout viewport, in CSS pixels. All three are absent while the page is
   * not magnified.
   */
  readonly visualScale?: number;
  readonly visualOffsetX?: number;
  readonly visualOffsetY?: number;
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
  | HtmlMirrorCheckpointPart
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

/** What a checkpoint holds besides its graph. */
export type HtmlMirrorCheckpointValues = Omit<
  HtmlMirrorCheckpoint['payload'],
  | 'root' | 'adoptedStyleSheets' | 'byteLength' | 'representability'
  | 'documentMode' | 'partCount' | 'preview'
> & {
  readonly documentMode?: HtmlMirrorDocumentMode;
  readonly representability?: HtmlMirrorRepresentabilitySummary;
};

export function createHtmlMirrorCheckpoint(
  identity: ReplicaDocumentIdentity,
  input: Omit<
    HtmlMirrorCheckpoint['payload'],
    'byteLength' | 'representability' | 'documentMode'
  > & {
    readonly documentMode?: HtmlMirrorDocumentMode;
    readonly representability?: HtmlMirrorRepresentabilitySummary;
  },
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): HtmlMirrorCheckpoint | undefined {
  const shape = readCheckpointShape(input.partCount, input.preview);
  if (!shape) return undefined;
  // Shells only where the checkpoint says (D163): `childrenFollow` in one
  // sent in parts, and it has at least one; `placeholder` in a preview.
  const shells = createHtmlMirrorShellLedger({
    childrenFollow: shape.partCount > 0,
    placeholder: shape.preview,
  });
  const content = readHtmlMirrorDocumentContent(
    input.root,
    input.adoptedStyleSheets,
    fidelityPolicy,
    shells,
  );
  if (!content || (shape.partCount > 0 && shells.pending.size === 0)) {
    return undefined;
  }
  return finishHtmlMirrorCheckpoint(identity, content, input, shape);
}

/** A checkpoint's `partCount` and `preview`: never both. */
function readCheckpointShape(
  partCount: unknown,
  preview: unknown,
): { readonly partCount: number; readonly preview: boolean } | undefined {
  if (
    (partCount !== undefined && (
      !Number.isSafeInteger(partCount) || (partCount as number) < 0 ||
      (partCount as number) > MAX_HTML_MIRROR_NODES
    )) ||
    (preview !== undefined && preview !== true)
  ) return undefined;
  const count = (partCount as number | undefined) ?? 0;
  if (preview === true && count > 0) return undefined;
  return { partCount: count, preview: preview === true };
}

/** The checkpoint of a graph already checked. */
function finishHtmlMirrorCheckpoint(
  identity: ReplicaDocumentIdentity,
  content: HtmlMirrorDocumentContent,
  input: HtmlMirrorCheckpointValues,
  shape: { readonly partCount: number; readonly preview: boolean } = {
    partCount: 0,
    preview: false,
  },
): HtmlMirrorCheckpoint | undefined {
  const { root, adoptedStyleSheets } = content;
  const documentMode = input.documentMode === 'quirks' ||
      input.documentMode === 'limited-quirks'
    ? input.documentMode
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
      ...(shape.partCount > 0 ? { partCount: shape.partCount } : {}),
      ...(shape.preview ? { preview: true as const } : {}),
    }),
  });
}

/**
 * Checks a checkpoint read in slices part by part (D163), every part in the
 * context its shell was checked in and against one budget: the ids, nodes
 * and bytes of the root and all its parts are counted as one graph's, as
 * the whole checkpoint's are. The page runs it on what it sends, the panel
 * on what it receives. Any failure fails the whole assembly.
 */
export class HtmlMirrorCheckpointAssembly {
  readonly #fidelityPolicy: SelectableReplicaFidelityPolicy;
  readonly #budget = createHtmlMirrorReadBudget();
  readonly #shells = createHtmlMirrorShellLedger({ childrenFollow: true });
  readonly #fills = new Map<number, readonly HtmlMirrorNode[]>();
  #root: HtmlMirrorElementNode | undefined;
  #adoptedStyleSheets: readonly string[] | undefined;
  #failed = false;

  constructor(fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative') {
    this.#fidelityPolicy = fidelityPolicy;
  }

  /** Nodes and bytes counted so far, over the root and every fill. */
  get nodes(): number {
    return this.#budget.nodes;
  }

  get bytes(): number {
    return this.#budget.bytes;
  }

  /** Shells checked and not filled yet. */
  get pendingShells(): number {
    return this.#shells.pending.size;
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** A shell waiting for its fill, if any, the first noted first. */
  nextPendingShell(): number | undefined {
    for (const nodeId of this.#shells.pending.keys()) return nodeId;
    return undefined;
  }

  /** Checks the checkpoint's own root, once, before any fill. */
  readRoot(input: unknown): HtmlMirrorElementNode | undefined {
    if (this.#failed || this.#root) return this.#fail();
    const root = readHtmlMirrorNode(
      input,
      this.#budget.ids,
      0,
      this.#budget,
      false,
      false,
      false,
      false,
      false,
      this.#fidelityPolicy,
      false,
      false,
      this.#shells,
    );
    if (!root || root.kind !== 'element' || root.tagName !== 'html') {
      return this.#fail();
    }
    this.#root = root;
    return root;
  }

  /** Checks the document's adopted sheets, once. */
  readAdoptedStyleSheets(input: unknown): readonly string[] | undefined {
    if (this.#failed || this.#adoptedStyleSheets) return this.#fail();
    const sheets = readHtmlMirrorAdoptedStyleSheets(
      input,
      this.#budget,
      this.#fidelityPolicy,
    );
    if (!sheets) return this.#fail();
    this.#adoptedStyleSheets = sheets;
    return sheets;
  }

  /**
   * Checks what one fill brings for a shell already checked. With `more`,
   * the shell's further children come in later fills, appended in order,
   * and it stays pending until one comes without (D163).
   */
  readFill(
    nodeId: unknown,
    children: unknown,
    more = false,
  ): readonly HtmlMirrorNode[] | undefined {
    if (this.#failed || !this.#root || typeof more !== 'boolean') {
      return this.#fail();
    }
    const parsed = readHtmlMirrorFillChildren(
      nodeId,
      children,
      this.#budget,
      this.#shells,
      this.#fidelityPolicy,
      more,
    );
    if (!parsed) return this.#fail();
    const before = this.#fills.get(nodeId as number);
    this.#fills.set(
      nodeId as number,
      before ? Object.freeze([...before, ...parsed]) : parsed,
    );
    return parsed;
  }

  /**
   * The checkpoint as it is sent before its parts: the root with its shells,
   * `partCount` parts to come (D163).
   */
  shellCheckpoint(
    identity: ReplicaDocumentIdentity,
    input: HtmlMirrorCheckpointValues,
    partCount: number,
  ): HtmlMirrorCheckpoint | undefined {
    if (
      this.#failed || !this.#root || !this.#adoptedStyleSheets ||
      !Number.isSafeInteger(partCount) || partCount < 1 ||
      partCount > MAX_HTML_MIRROR_NODES
    ) return undefined;
    return finishHtmlMirrorCheckpoint(
      identity,
      { root: this.#root, adoptedStyleSheets: this.#adoptedStyleSheets },
      input,
      { partCount, preview: false },
    );
  }

  /** The root with every shell filled, once nothing is pending. */
  finish(): HtmlMirrorDocumentContent | undefined {
    if (
      this.#failed || !this.#root || !this.#adoptedStyleSheets ||
      this.#shells.pending.size > 0
    ) return undefined;
    const root = fillHtmlMirrorNode(this.#root, this.#fills);
    if (root.kind !== 'element') return undefined;
    return Object.freeze({ root, adoptedStyleSheets: this.#adoptedStyleSheets });
  }

  /** A plain checkpoint of the filled root: what a read in one task sends. */
  assembledCheckpoint(
    identity: ReplicaDocumentIdentity,
    input: HtmlMirrorCheckpointValues,
  ): HtmlMirrorCheckpoint | undefined {
    const content = this.finish();
    return content
      ? finishHtmlMirrorCheckpoint(identity, content, input)
      : undefined;
  }

  #fail(): undefined {
    this.#failed = true;
    return undefined;
  }
}

/**
 * Puts each fill into its shell, all the way down: a node without a shell
 * below it is kept as it is. The shells' marks go.
 */
function fillHtmlMirrorNode(
  node: HtmlMirrorNode,
  fills: ReadonlyMap<number, readonly HtmlMirrorNode[]>,
): HtmlMirrorNode {
  if (node.kind === 'text') return node;
  const ownChildren = node.childrenFollow
    ? fills.get(node.id) ?? node.children
    : node.children;
  const children = fillHtmlMirrorChildren(ownChildren, fills);
  // A node of the mirror's graph, not of the page.
  const ownRoot = node.shadowRoot;
  let shadowRoot = ownRoot;
  if (shadowRoot) {
    const shadowOwn = shadowRoot.childrenFollow
      ? fills.get(shadowRoot.id) ?? shadowRoot.children
      : shadowRoot.children;
    const shadowChildren = fillHtmlMirrorChildren(shadowOwn, fills);
    if (shadowChildren !== shadowRoot.children || shadowRoot.childrenFollow) {
      const { childrenFollow: _follows, ...rest } = shadowRoot;
      shadowRoot = Object.freeze({ ...rest, children: shadowChildren });
    }
  }
  if (
    children === node.children && shadowRoot === ownRoot &&
    !node.childrenFollow
  ) return node;
  const { childrenFollow: _follows, ...rest } = node;
  return Object.freeze({
    ...rest,
    children,
    ...(shadowRoot ? { shadowRoot } : {}),
  });
}

function fillHtmlMirrorChildren(
  children: readonly HtmlMirrorNode[],
  fills: ReadonlyMap<number, readonly HtmlMirrorNode[]>,
): readonly HtmlMirrorNode[] {
  let filled: HtmlMirrorNode[] | undefined;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const next = fillHtmlMirrorNode(child, fills);
    if (next !== child) filled ??= children.slice(0, index);
    filled?.push(next);
  }
  return filled ? Object.freeze(filled) : children;
}

/**
 * Makes one part of a checkpoint (D163). With `assembly`, each fill is
 * checked in its shell's context and counted with the rest of the
 * checkpoint (what the page does with what it sends); without, on its own,
 * as the panel checks a part that arrives: the shells are not known yet.
 * A part holds one fill at least, under the page's node and byte limits.
 */
export function createHtmlMirrorCheckpointPart(
  identity: ReplicaDocumentIdentity,
  index: number,
  fills: readonly HtmlMirrorCheckpointFill[],
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  assembly?: HtmlMirrorCheckpointAssembly,
): HtmlMirrorCheckpointPart | undefined {
  if (
    !Number.isSafeInteger(index) || index < 0 ||
    index >= MAX_HTML_MIRROR_NODES ||
    !Array.isArray(fills) || fills.length < 1 ||
    fills.length > MAX_HTML_MIRROR_NODES
  ) return undefined;
  const budget = createHtmlMirrorReadBudget();
  const shells = createHtmlMirrorShellLedger({ childrenFollow: true });
  const nodeIds = new Set<number>();
  // Shells this part goes on filling: a fill with `more` before (D163).
  const continued = new Set<number>();
  // Shells this part holds and fills too.
  const local = new Set<number>();
  const parsed: HtmlMirrorCheckpointFill[] = [];
  for (const fill of fills as readonly unknown[]) {
    if (
      !isRecord(fill) ||
      !hasExactKeysWithOptional(fill, ['nodeId', 'children'], ['more']) ||
      (fill.more !== undefined && fill.more !== true) ||
      !isNodeId(fill.nodeId) ||
      (nodeIds.has(fill.nodeId) && !continued.has(fill.nodeId)) ||
      !Array.isArray(fill.children)
    ) return undefined;
    const more = fill.more === true;
    nodeIds.add(fill.nodeId);
    if (more) continued.add(fill.nodeId);
    else continued.delete(fill.nodeId);
    let children: readonly HtmlMirrorNode[] | undefined;
    if (assembly) {
      children = assembly.readFill(fill.nodeId, fill.children, more);
    } else if (shells.pending.has(fill.nodeId)) {
      // A shell of this part: the first children of a list a slice stopped
      // in follow the fill that holds its node (D163).
      local.add(fill.nodeId);
      children = readHtmlMirrorFillChildren(
        fill.nodeId,
        fill.children,
        budget,
        shells,
        fidelityPolicy,
        more,
      );
    } else {
      const own: HtmlMirrorNode[] = [];
      for (const child of fill.children) {
        const node = readHtmlMirrorNode(
          child,
          budget.ids,
          1,
          budget,
          false,
          false,
          false,
          false,
          false,
          fidelityPolicy,
          false,
          false,
          shells,
        );
        if (!node) return undefined;
        own.push(node);
      }
      children = Object.freeze(own);
    }
    if (!children) return undefined;
    parsed.push(Object.freeze({
      nodeId: fill.nodeId,
      children,
      ...(more ? { more: true as const } : {}),
    }));
  }
  // A fill is for a node of another message; the same node in this one is a
  // second copy of it.
  for (const nodeId of nodeIds) {
    if (budget.ids.has(nodeId) && !local.has(nodeId)) return undefined;
  }
  const frozenFills = Object.freeze(parsed);
  const byteLength = htmlMirrorJsonBytes(encodeHtmlMirrorWireMessage({
    fills: frozenFills,
  }));
  if (!Number.isSafeInteger(byteLength) || byteLength > MAX_HTML_MIRROR_BYTES) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: HTML_MIRROR_PROTOCOL_VERSION,
    kind: 'simul:html-mirror-v2:checkpoint-part',
    identity,
    index,
    fills: frozenFills,
    byteLength,
  });
}

/**
 * Extension-side check of a part as it arrives (D163): its shape, each
 * fill's nodes on their own, and its limits. Where each fill goes, and in
 * which context it is checked, is for `assembleHtmlMirrorCheckpoint`.
 */
export function readHtmlMirrorCheckpointPart(
  input: unknown,
  expectedIdentity: ReplicaDocumentIdentity,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): HtmlMirrorCheckpointPart | undefined {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      'protocolVersion', 'kind', 'identity', 'index', 'fills', 'byteLength',
    ]) ||
    input.protocolVersion !== HTML_MIRROR_PROTOCOL_VERSION ||
    input.kind !== 'simul:html-mirror-v2:checkpoint-part' ||
    !Array.isArray(input.fills)
  ) return undefined;
  const identity = readReplicaIdentity(input.identity);
  if (!identity || !sameDocument(identity, expectedIdentity)) return undefined;
  const part = createHtmlMirrorCheckpointPart(
    identity,
    input.index as number,
    input.fills as HtmlMirrorCheckpointFill[],
    fidelityPolicy,
  );
  return part && part.byteLength === input.byteLength ? part : undefined;
}

/**
 * The full checkpoint from a checkpoint sent in parts and its parts, in any
 * order (D163): each `childrenFollow` node is filled by one fill, or by
 * several taken in the order they were read (by part index, then within a
 * part) of which all but the last say `more`; every fill is read in the
 * context of its shell, and the whole counted against one node and byte
 * budget. A missing or unknown fill, a fill after a shell's last, a shell
 * whose fills all say `more`, a part of another sequence or a part too
 * many, a repeated id, or totals over the limits give `undefined`. For a page that did not change while it was read, the
 * result equals the checkpoint of the one-task read.
 */
export function assembleHtmlMirrorCheckpoint(
  checkpoint: HtmlMirrorCheckpoint,
  parts: readonly HtmlMirrorCheckpointPart[],
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): HtmlMirrorCheckpoint | undefined {
  const { payload } = checkpoint;
  const partCount = payload.partCount ?? 0;
  if (payload.preview || partCount < 1 || parts.length !== partCount) {
    return undefined;
  }
  const indexes = new Set<number>();
  for (const part of parts) {
    if (
      part.kind !== 'simul:html-mirror-v2:checkpoint-part' ||
      !sameDocument(part.identity, checkpoint.identity) ||
      part.identity.sequence !== checkpoint.identity.sequence ||
      !Number.isSafeInteger(part.index) || part.index < 0 ||
      part.index >= partCount || indexes.has(part.index)
    ) return undefined;
    indexes.add(part.index);
  }
  // Each shell's fills in the order the page read them: by part, then
  // within a part. All but the last go on (`more`); the last ends (D163).
  const fills = new Map<number, Array<{ children: unknown; more: boolean }>>();
  const ended = new Set<number>();
  for (const part of [...parts].sort((left, right) => left.index - right.index)) {
    for (const fill of part.fills) {
      if (ended.has(fill.nodeId)) return undefined;
      const more = fill.more === true;
      if (!more) ended.add(fill.nodeId);
      const list = fills.get(fill.nodeId);
      if (list) list.push({ children: fill.children, more });
      else fills.set(fill.nodeId, [{ children: fill.children, more }]);
    }
  }
  for (const nodeId of fills.keys()) {
    if (!ended.has(nodeId)) return undefined;
  }
  const assembly = new HtmlMirrorCheckpointAssembly(fidelityPolicy);
  if (
    !assembly.readRoot(payload.root) ||
    !assembly.readAdoptedStyleSheets(payload.adoptedStyleSheets)
  ) return undefined;
  for (
    let nodeId = assembly.nextPendingShell();
    nodeId !== undefined;
    nodeId = assembly.nextPendingShell()
  ) {
    const list = fills.get(nodeId);
    if (!list) return undefined;
    fills.delete(nodeId);
    for (const fill of list) {
      if (!assembly.readFill(nodeId, fill.children, fill.more)) return undefined;
    }
  }
  if (fills.size > 0) return undefined;
  return assembly.assembledCheckpoint(checkpoint.identity, {
    documentMode: payload.documentMode,
    captureMs: payload.captureMs,
    viewportWidth: payload.viewportWidth,
    viewportHeight: payload.viewportHeight,
    documentWidth: payload.documentWidth,
    documentHeight: payload.documentHeight,
    representability: payload.representability,
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

/**
 * A scroll message without a pane list means the panes are where the last
 * list put them (D122). Gives such a message the list, and the named pane,
 * of the last message that carried one, so that whoever follows it has the
 * whole state. A message with its own list, or with none before it, is
 * returned as it is.
 */
export function withHtmlMirrorScrollPanes(
  update: HtmlMirrorScrollUpdate,
  last: HtmlMirrorScrollState | undefined,
): HtmlMirrorScrollUpdate {
  if (update.scroll.panes || !last?.panes) return update;
  const { panes, primaryPaneId } = last;
  return Object.freeze({
    ...update,
    scroll: Object.freeze({
      ...update.scroll,
      panes,
      ...(primaryPaneId !== undefined ? { primaryPaneId } : {}),
    }),
  });
}

/**
 * Names panes that follow one another at the very same place once, the
 * first by `nodeId` and the others in `alsoNodeIds`: a grid whose rows a
 * script keeps in step is one entry, whatever its number of rows.
 */
export function groupHtmlMirrorScrollPanes(
  panes: readonly HtmlMirrorPaneScroll[],
): HtmlMirrorPaneScroll[] {
  const grouped: Array<HtmlMirrorPaneScroll & { alsoNodeIds?: number[] }> = [];
  for (const pane of panes) {
    const last = grouped.at(-1);
    if (
      last &&
      last.scrollX === pane.scrollX && last.scrollY === pane.scrollY &&
      last.maxScrollX === pane.maxScrollX && last.maxScrollY === pane.maxScrollY
    ) {
      (last.alsoNodeIds ??= []).push(pane.nodeId, ...(pane.alsoNodeIds ?? []));
    } else {
      grouped.push({
        nodeId: pane.nodeId,
        scrollX: pane.scrollX,
        scrollY: pane.scrollY,
        maxScrollX: pane.maxScrollX,
        maxScrollY: pane.maxScrollY,
        ...(pane.alsoNodeIds ? { alsoNodeIds: [...pane.alsoNodeIds] } : {}),
      });
    }
  }
  return grouped;
}

/**
 * The panes as the panel knows them (D122). The page names the panes that
 * moved; this keeps every pane's place, the most recently moved last, and
 * gives each scroll update the whole list, a pane an entry, so that whoever
 * follows an update needs no update before it.
 */
export class HtmlMirrorScrollPaneLedger {
  readonly #places = new Map<number, HtmlMirrorPaneScroll>();
  /** Every scrollable pane's box (D180); none before the page sent one. */
  readonly #boxes = new Map<number, HtmlMirrorPaneBox>();
  #boxesSeen = false;
  /** The last list handed on; none before the page has sent one. */
  #last: HtmlMirrorScrollState | undefined;

  complete(update: HtmlMirrorScrollUpdate): HtmlMirrorScrollUpdate {
    return this.#withBoxes(this.#completePanes(update));
  }

  /**
   * Keeps the boxes the page sent (D180) and gives every update the whole
   * list once one came, as for the panes' places.
   */
  #withBoxes(update: HtmlMirrorScrollUpdate): HtmlMirrorScrollUpdate {
    const sent = update.scroll.paneBoxes;
    if (sent) {
      this.#boxesSeen = true;
      if (sent.whole) this.#boxes.clear();
      for (const box of sent.boxes) {
        this.#boxes.delete(box.nodeId);
        if (box.width > 0 || box.height > 0) this.#boxes.set(box.nodeId, box);
      }
      for (const nodeId of this.#boxes.keys()) {
        if (this.#boxes.size <= MAX_HTML_MIRROR_PANE_BOXES) break;
        this.#boxes.delete(nodeId);
      }
    }
    if (!this.#boxesSeen) return update;
    const paneBoxes: HtmlMirrorPaneBoxes = Object.freeze({
      version: HTML_MIRROR_PANE_BOXES_VERSION,
      whole: true,
      boxes: Object.freeze([...this.#boxes.values()]),
    });
    const scroll = Object.freeze({ ...update.scroll, paneBoxes });
    if (this.#last) this.#last = Object.freeze({ ...this.#last, paneBoxes });
    return Object.freeze({ ...update, scroll });
  }

  #completePanes(update: HtmlMirrorScrollUpdate): HtmlMirrorScrollUpdate {
    const { panes, movedPanes, primaryPaneId, ...place } = update.scroll;
    const named = panes ?? movedPanes;
    if (!named) return withHtmlMirrorScrollPanes(update, this.#last);
    // A whole list: every pane it leaves out is at its start.
    if (panes) this.#places.clear();
    for (const entry of named) {
      this.#place(entry.nodeId, entry);
      for (const nodeId of entry.alsoNodeIds ?? []) this.#place(nodeId, entry);
    }
    for (const nodeId of this.#places.keys()) {
      if (this.#places.size <= MAX_HTML_MIRROR_SCROLL_PANES) break;
      this.#places.delete(nodeId);
    }
    const scroll: HtmlMirrorScrollState = Object.freeze({
      ...place,
      panes: Object.freeze([...this.#places.values()]),
      ...(primaryPaneId !== undefined && this.#places.has(primaryPaneId)
        ? { primaryPaneId }
        : {}),
    });
    this.#last = scroll;
    return Object.freeze({ ...update, scroll });
  }

  #place(nodeId: number, place: HtmlMirrorPaneScroll): void {
    this.#places.delete(nodeId);
    // At its start: not listed, as in a whole list.
    if (place.scrollX === 0 && place.scrollY === 0) return;
    this.#places.set(nodeId, Object.freeze({
      nodeId,
      scrollX: place.scrollX,
      scrollY: place.scrollY,
      maxScrollX: place.maxScrollX,
      maxScrollY: place.maxScrollY,
    }));
  }
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
  if (input.kind === 'simul:html-mirror-v2:checkpoint-part') {
    // Checked on its own as it arrives; in its shells' context when the
    // checkpoint that closes the parts is assembled (D163).
    return readHtmlMirrorCheckpointPart(input, expectedIdentity, fidelityPolicy);
  }
  if (input.kind === 'simul:html-mirror-v2:checkpoint') {
    if (
      !hasExactKeys(input, ['protocolVersion', 'kind', 'identity', 'payload']) ||
      !isRecord(input.payload) ||
      !hasExactKeysWithOptional(input.payload, [
        'root', 'adoptedStyleSheets', 'documentMode', 'byteLength', 'captureMs',
        'viewportWidth', 'viewportHeight', 'documentWidth', 'documentHeight',
        'representability',
      ], ['partCount', 'preview'])
    ) return undefined;
    const checkpoint = createHtmlMirrorCheckpoint(identity, {
      root: input.payload.root as HtmlMirrorElementNode,
      adoptedStyleSheets: input.payload.adoptedStyleSheets as readonly string[],
      documentMode: input.payload.documentMode as HtmlMirrorDocumentMode,
      captureMs: input.payload.captureMs as number,
      viewportWidth: input.payload.viewportWidth as number,
      viewportHeight: input.payload.viewportHeight as number,
      documentWidth: input.payload.documentWidth as number,
      documentHeight: input.payload.documentHeight as number,
      representability: input.payload.representability as HtmlMirrorRepresentabilitySummary,
      ...(Object.hasOwn(input.payload, 'partCount')
        ? { partCount: input.payload.partCount as number }
        : {}),
      ...(Object.hasOwn(input.payload, 'preview')
        ? { preview: input.payload.preview as true }
        : {}),
    }, fidelityPolicy);
    return checkpoint && checkpoint.payload.byteLength === input.payload.byteLength
      ? checkpoint
      : undefined;
  }
  if (
    input.kind !== 'simul:html-mirror-v2:patch' ||
    !hasExactKeysWithOptional(
      input,
      [
        'protocolVersion', 'kind', 'identity', 'firstSequence', 'lastSequence',
        'operations', 'representability', 'byteLength',
      ],
      ['more'],
    ) ||
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
  if (!batch || batch.byteLength !== input.byteLength) return undefined;
  if (input.more === undefined) return batch;
  // The other patches of the frame: each is checked as a patch is, and the
  // frame as the page reader's own.
  if (!Array.isArray(input.more) || input.more.length < 1) return undefined;
  const patches: HtmlMirrorPatchBatch[] = [batch];
  for (const entry of input.more) {
    const patch = readHtmlMirrorSourceMessage(
      entry,
      expectedIdentity,
      fidelityPolicy,
    );
    if (patch?.kind !== 'simul:html-mirror-v2:patch') return undefined;
    patches.push(patch);
  }
  return createHtmlMirrorPatchFrame(patches);
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
        // Control state (selected positions, picker state, control text)
        // travels only on the semantic channel. An attributes operation that
        // names it is refused here rather than later, where the canonical
        // node reader would reject it as a malformed graph (R8).
        [
          'visuallyHidden', 'selectedImageSource', 'selectPresentationStyle',
          'canvasBackgroundColor', 'resolvedStyleSheetText',
          'resolvedStyleSheetTextFrom', 'customElementDefined',
          'assignedNodeIds',
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
        (raw.selectPresentationStyle !== undefined &&
          typeof raw.selectPresentationStyle !== 'string') ||
        // Only a `<style>` holds its sheet as text that more can be added to.
        (raw.resolvedStyleSheetTextFrom !== undefined && (
          !Number.isSafeInteger(raw.resolvedStyleSheetTextFrom) ||
          (raw.resolvedStyleSheetTextFrom as number) < 1 ||
          raw.tagName !== 'style' ||
          typeof raw.resolvedStyleSheetText !== 'string'
        ))
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
        ...(raw.assignedNodeIds !== undefined
          ? { assignedNodeIds: raw.assignedNodeIds }
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
        ...(sentinel.selectPresentationStyle
          ? { selectPresentationStyle: sentinel.selectPresentationStyle }
          : {}),
        ...(sentinel.canvasBackgroundColor
          ? { canvasBackgroundColor: sentinel.canvasBackgroundColor }
          : {}),
        ...(sentinel.resolvedStyleSheetText !== undefined
          ? { resolvedStyleSheetText: sentinel.resolvedStyleSheetText }
          : {}),
        ...(sentinel.resolvedStyleSheetText !== undefined &&
            raw.resolvedStyleSheetTextFrom !== undefined
          ? { resolvedStyleSheetTextFrom: raw.resolvedStyleSheetTextFrom as number }
          : {}),
        ...(sentinel.customElementDefined
          ? { customElementDefined: true as const }
          : {}),
        ...(sentinel.assignedNodeIds
          ? { assignedNodeIds: sentinel.assignedNodeIds }
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
      ['scrollX', 'scrollY', 'maxScrollX', 'maxScrollY'],
      [
        'panes', 'movedPanes', 'primaryPaneId', 'paneBoxes',
        'visualScale', 'visualOffsetX', 'visualOffsetY',
      ],
    ) ||
    !isVisualViewportState(input) ||
    ![
      input.scrollX,
      input.scrollY,
      input.maxScrollX,
      input.maxScrollY,
    ].every(isScrollValue) ||
    input.scrollX > input.maxScrollX ||
    input.scrollY > input.maxScrollY ||
    // The whole list or the panes that moved, never both.
    (input.panes !== undefined && input.movedPanes !== undefined)
  ) return undefined;
  const panes = input.panes === undefined
    ? undefined
    : readScrollPanes(input.panes);
  const movedPanes = input.movedPanes === undefined
    ? undefined
    : readScrollPanes(input.movedPanes);
  const paneBoxes = input.paneBoxes === undefined
    ? undefined
    : readPaneBoxes(input.paneBoxes);
  if (
    (input.paneBoxes !== undefined && !paneBoxes) ||
    (input.panes !== undefined && !panes) ||
    (input.movedPanes !== undefined && !movedPanes) ||
    (input.primaryPaneId !== undefined && (
      !isNodeId(input.primaryPaneId) ||
      // One of the whole list. Among the panes that moved it may be one
      // named earlier, which only the keeper of the list can tell.
      (!movedPanes && !panes?.some((pane) =>
        pane.nodeId === input.primaryPaneId ||
        pane.alsoNodeIds?.includes(input.primaryPaneId as number))
      )
    ))
  ) return undefined;
  return Object.freeze({
    scrollX: input.scrollX,
    scrollY: input.scrollY,
    maxScrollX: input.maxScrollX,
    maxScrollY: input.maxScrollY,
    ...(panes ? { panes } : {}),
    ...(movedPanes ? { movedPanes } : {}),
    ...(input.primaryPaneId !== undefined
      ? { primaryPaneId: input.primaryPaneId }
      : {}),
    ...(paneBoxes ? { paneBoxes } : {}),
    ...(input.visualScale !== undefined
      ? {
          visualScale: input.visualScale,
          visualOffsetX: input.visualOffsetX as number,
          visualOffsetY: input.visualOffsetY as number,
        }
      : {}),
  });
}

/**
 * The panes of one scroll message (D122): a bounded list, each pane named
 * once by a node id, alone or with the others at its place, every number
 * finite and inside the scroll bound, and no offset past its range. One bad
 * pane refuses the whole message.
 */
function readScrollPanes(
  input: unknown,
): readonly HtmlMirrorPaneScroll[] | undefined {
  if (
    !Array.isArray(input) ||
    input.length > MAX_HTML_MIRROR_SCROLL_PANES
  ) return undefined;
  const seen = new Set<number>();
  const panes: HtmlMirrorPaneScroll[] = [];
  for (const pane of input as readonly unknown[]) {
    if (
      !isRecord(pane) ||
      !hasExactKeysWithOptional(
        pane,
        ['nodeId', 'scrollX', 'scrollY', 'maxScrollX', 'maxScrollY'],
        ['alsoNodeIds'],
      ) ||
      !isNodeId(pane.nodeId) ||
      seen.has(pane.nodeId) ||
      seen.size >= MAX_HTML_MIRROR_SCROLL_PANES ||
      !isScrollValue(pane.maxScrollX) ||
      !isScrollValue(pane.maxScrollY) ||
      !isPaneOffset(pane.scrollX, pane.maxScrollX) ||
      !isPaneOffset(pane.scrollY, pane.maxScrollY)
    ) return undefined;
    seen.add(pane.nodeId);
    let alsoNodeIds: readonly number[] | undefined;
    if (pane.alsoNodeIds !== undefined) {
      const also = pane.alsoNodeIds;
      if (!Array.isArray(also) || also.length === 0) return undefined;
      for (const nodeId of also as readonly unknown[]) {
        // The bound counts panes, not entries.
        if (
          !isNodeId(nodeId) || seen.has(nodeId) ||
          seen.size >= MAX_HTML_MIRROR_SCROLL_PANES
        ) return undefined;
        seen.add(nodeId);
      }
      alsoNodeIds = Object.freeze([...also as readonly number[]]);
    }
    panes.push(Object.freeze({
      nodeId: pane.nodeId,
      scrollX: pane.scrollX,
      scrollY: pane.scrollY,
      maxScrollX: pane.maxScrollX,
      maxScrollY: pane.maxScrollY,
      ...(alsoNodeIds ? { alsoNodeIds } : {}),
    }));
  }
  return Object.freeze(panes);
}

/**
 * The pane boxes of one scroll message (D180): this version, a bounded
 * list, each pane once, every number finite and inside the scroll bound.
 * One bad box refuses the whole message.
 */
function readPaneBoxes(input: unknown): HtmlMirrorPaneBoxes | undefined {
  if (
    !isRecord(input) ||
    !hasExactKeysWithOptional(input, ['version', 'whole', 'boxes'], []) ||
    input.version !== HTML_MIRROR_PANE_BOXES_VERSION ||
    typeof input.whole !== 'boolean' ||
    !Array.isArray(input.boxes) ||
    input.boxes.length > MAX_HTML_MIRROR_PANE_BOXES
  ) return undefined;
  const seen = new Set<number>();
  const boxes: HtmlMirrorPaneBox[] = [];
  for (const box of input.boxes as readonly unknown[]) {
    if (
      !isRecord(box) ||
      !hasExactKeysWithOptional(
        box,
        ['nodeId', 'x', 'y', 'width', 'height', 'maxScrollX', 'maxScrollY'],
        [],
      ) ||
      !isNodeId(box.nodeId) || seen.has(box.nodeId) ||
      !isPaneOffset(box.x, PRIMARY_SCROLL_MAX) ||
      !isPaneOffset(box.y, PRIMARY_SCROLL_MAX) ||
      !isScrollValue(box.width) || !isScrollValue(box.height) ||
      !isScrollValue(box.maxScrollX) || !isScrollValue(box.maxScrollY)
    ) return undefined;
    seen.add(box.nodeId);
    boxes.push(Object.freeze({
      nodeId: box.nodeId,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      maxScrollX: box.maxScrollX,
      maxScrollY: box.maxScrollY,
    }));
  }
  return Object.freeze({
    version: HTML_MIRROR_PANE_BOXES_VERSION,
    whole: input.whole,
    boxes: Object.freeze(boxes),
  });
}

/** A pane's offset on one axis: either sign, never past its range. */
function isPaneOffset(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(value) <= maximum;
}

/** A pinch zoom's three numbers together and in range, or none of them. */
function isVisualViewportState(input: HtmlMirrorScrollState): boolean {
  const { visualScale, visualOffsetX, visualOffsetY } = input;
  if (
    visualScale === undefined &&
    visualOffsetX === undefined &&
    visualOffsetY === undefined
  ) return true;
  return typeof visualScale === 'number' && Number.isFinite(visualScale) &&
    visualScale >= 1 && visualScale <= VISUAL_SCALE_MAX &&
    isScrollValue(visualOffsetX) && isScrollValue(visualOffsetY);
}

function isScrollValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= 0 && value <= PRIMARY_SCROLL_MAX;
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
