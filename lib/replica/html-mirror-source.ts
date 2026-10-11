import { ImageSourceSession } from '../ocr/image-source-session';
import { readImageSourcePortSessionId } from '../ocr/image-source-protocol';
import { SourceImageObserver } from '../ocr/source-image-observer';
import type { ReplicaDocumentIdentity } from './contracts';
import {
  HTML_MIRROR_PORT_PREFIX,
  MAX_HTML_MIRROR_SCROLL_PANES,
  MAX_HTML_MIRROR_UNACKED_BATCHES,
  createHtmlMirrorCheckpoint,
  createHtmlMirrorError,
  createHtmlMirrorPatch,
  createHtmlMirrorPatchFrame,
  createHtmlMirrorScrollUpdate,
  groupHtmlMirrorScrollPanes,
  encodeHtmlMirrorWireMessage,
  readHtmlMirrorControllerMessage,
  readHtmlMirrorPortSessionId,
  type HtmlMirrorPaneScroll,
  type HtmlMirrorPatchBatch,
  type HtmlMirrorReconcileChild,
  type HtmlMirrorPatchOperation,
} from './html-mirror-protocol';
import {
  isDocumentScrollTarget,
  MIN_PRIMARY_PANE_RANGE,
  readDocumentScrollSnapshot,
  readNestedScrollSnapshot,
  readPaneScrollPlace,
  readVisualViewportSnapshot,
} from '../primary-scroll';
import {
  MAX_HTML_MIRROR_STRING,
  MAX_HTML_MIRROR_NODES,
  MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
  HtmlMirrorCapacityError,
  createHtmlMirrorReadBudget,
  createHtmlMirrorRepresentabilityCollector,
  createHtmlMirrorStyleWorkBudget,
  isSourceSelectVisuallyHidden,
  isSourceStructuralChildOf,
  readSourceSelectPresentationStyle,
  appendedStyleSheetText,
  sanitizeSourceAdoptedStyleSheets,
  sanitizeSourceAttributes,
  sanitizeSourceChildren,
  sanitizeSourceDocument,
  sanitizeSourceElementHints,
  sanitizeSourceSubtree,
  sanitizeSourceSubtrees,
  sourceDeclaredHiddenRegionIsWithheld,
  beginSourceSlotReadingWalk,
  createSourceSlotReadings,
  sourceSlotReadingChanged,
  snapshotHtmlMirrorRepresentability,
  sourceStructuralChildNodes,
  type HtmlMirrorIdRegistry,
  type HtmlMirrorElementNode,
  type HtmlMirrorNamespace,
  type HtmlMirrorRepresentabilityCollector,
  type HtmlMirrorRepresentabilitySummary,
  type HtmlMirrorStyleWorkBudget,
} from './html-mirror-sanitizer';
import {
  MAX_HTML_MIRROR_NODES_SETTING,
  applyHtmlMirrorLimitSettings,
} from './html-mirror-limits';
import { applySourcePrivacyFiltersOff } from './source-privacy-mode';
import { createReplicaIdentity } from './replica-identity';
import { minimizeConnectedComposedTargets } from './composed-targets';
import {
  beginSourceHeldAnimationPass,
  listenForSourceHeldAnimations,
} from './source-held-animation';
import { readSemanticSourcePortIdentity } from './semantic-source-protocol';
import {
  SOURCE_EVIDENCE_ATTRIBUTE_FILTER,
  SemanticSourceSession,
  eagerlyClassifySourceDocumentSecrets,
  eagerlyClassifySourceDocumentSubtree,
  rememberSourceMutationSecrets,
} from './semantic-source-session';
import {
  sourceDocumentSecretClassifier,
  type StickySourceSecretClassifier,
} from './source-secret-classifier';
import {
  createSourceControlledContentPolicy,
  hasSourceCredentialSecretAncestor,
  isSourceSelectWrapper,
  sourceControlledContentBoundaryChanged,
  sourceControlledContentChangedTargets,
  sourceControlledContentLayoutMayChange,
  sourceControlledContentMutationsMayChange,
  type SourceControlledContentPolicy,
} from './source-privacy-policy';
import {
  SourceVisibilityBoundaryIndex,
  type SourceVisibilityBoundaryRefresh,
} from './source-visibility-boundary';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';
import { StableSignatureTracker } from './stable-signature-tracker';
import { sourceMutationMayChangeCurrentValue } from './source-mutation-filter';
import {
  askAboutSourceShadowRootsAbove,
  askAboutSourceShadowRootsWithin,
  beginSourceShadowRootWalk,
  canHostAuthorShadowRoot,
  chromeSourceShadowRootReader,
  installSourceShadowRootReader,
  isSourceShadowRoot,
  listenForSourceShadowRoots,
  probeSourceShadowRoot,
  readSourceShadowRoot,
  type SourceShadowRootReader,
} from './source-shadow-root';

export class WeakNodeIdRegistry implements HtmlMirrorIdRegistry {
  readonly #ids = new WeakMap<Node, number>();
  readonly #nodes = new Map<number, WeakRef<Node>>();
  #nextId = 1;
  #allocationsSincePrune = 0;

  /** Room for the largest node cap plus removed nodes not yet collected. */
  static readonly MAX_TRACKED_NODES = MAX_HTML_MIRROR_NODES_SETTING * 4;
  static readonly PRUNE_INTERVAL = 256;

  getId(node: Node): number {
    const existing = this.#ids.get(node);
    if (existing) return existing;
    if (this.#nodes.size >= WeakNodeIdRegistry.MAX_TRACKED_NODES) {
      this.prune();
      if (this.#nodes.size >= WeakNodeIdRegistry.MAX_TRACKED_NODES) {
        throw new HtmlMirrorCapacityError();
      }
    }
    const id = this.#nextId++;
    if (!Number.isSafeInteger(id)) throw new HtmlMirrorCapacityError();
    this.#ids.set(node, id);
    this.#nodes.set(id, new WeakRef(node));
    this.#allocationsSincePrune += 1;
    // A prune visits every tracked node, so on a large page it waits until
    // as many new IDs as tracked ones: pruning stays linear overall.
    if (
      this.#allocationsSincePrune >= Math.max(
        WeakNodeIdRegistry.PRUNE_INTERVAL,
        this.#nodes.size,
      ) ||
      this.#nodes.size > WeakNodeIdRegistry.MAX_TRACKED_NODES
    ) this.prune();
    return id;
  }

  peekId(node: Node): number | undefined {
    return this.#ids.get(node);
  }

  getNode(id: number): Node | undefined {
    const node = this.#nodes.get(id)?.deref();
    if (!node) this.#nodes.delete(id);
    return node;
  }

  prune(): void {
    this.#allocationsSincePrune = 0;
    for (const [id, reference] of this.#nodes) {
      if (!reference.deref()) this.#nodes.delete(id);
    }
  }

  get trackedNodeCount(): number {
    return this.#nodes.size;
  }
}

export interface HtmlMirrorSourceBridgeEnvironment {
  readonly global?: typeof globalThis & {
    __simulHtmlMirrorV2Installed?: boolean;
    __simulHtmlMirrorV2SecretObserver?: Pick<
      MutationObserver,
      'disconnect'
    >;
    __simulHtmlMirrorV1SecretObserver?: Pick<MutationObserver, 'disconnect'>;
  };
  readonly runtime?: Pick<typeof browser.runtime, 'onConnect'>;
  readonly document?: Document;
  readonly window?: Window;
  readonly now?: () => number;
  readonly createMutationObserver?: (
    callback: MutationCallback,
  ) => Pick<MutationObserver, 'observe' | 'disconnect'>;
  readonly scheduleFrame?: (callback: () => void) => unknown;
  readonly cancelFrame?: (handle: unknown) => void;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  readonly createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => Pick<ResizeObserver, 'observe' | 'disconnect'>;
  readonly registry?: WeakNodeIdRegistry;
  /**
   * `chrome.dom.openOrClosedShadowRoot`: how the page's closed shadow roots
   * are read (D125). Every reader of the page uses the one installed here.
   */
  readonly openShadowRoot?: SourceShadowRootReader;
}

/** Installs a page-owned HTML and image identity bridge. */
export function installHtmlMirrorSourceBridge(
  environment: HtmlMirrorSourceBridgeEnvironment = {},
): void {
  const isolatedGlobal = (environment.global ?? globalThis) as typeof globalThis & {
    __simulHtmlMirrorV2Installed?: boolean;
    __simulHtmlMirrorV2SecretObserver?: Pick<
      MutationObserver,
      'disconnect'
    >;
    __simulHtmlMirrorV1SecretObserver?: Pick<MutationObserver, 'disconnect'>;
  };
  if (isolatedGlobal.__simulHtmlMirrorV2Installed) return;
  isolatedGlobal.__simulHtmlMirrorV2Installed = true;
  isolatedGlobal.__simulHtmlMirrorV1SecretObserver?.disconnect();
  const runtime = environment.runtime ?? browser.runtime;
  const sourceDocument = environment.document ?? document;
  const sourceWindow = environment.window ?? window;
  const registry = environment.registry ?? new WeakNodeIdRegistry();
  // Before anything walks the page: the credential classifier below must
  // see into every root the mirror will read (D125).
  installSourceShadowRootReader(
    sourceDocument,
    environment.openShadowRoot ?? chromeSourceShadowRootReader(),
  );
  const documentSecretClassifier = sourceDocumentSecretClassifier(sourceDocument);
  let secretObserver: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  try {
    const createSecretObserver = environment.createMutationObserver ??
      ((callback: MutationCallback) => new MutationObserver(callback));
    secretObserver = createSecretObserver((records) => {
      rememberSourceMutationSecrets(
        records,
        sourceWindow,
        documentSecretClassifier,
        { freshRoots: true },
      );
    });
    secretObserver.observe(sourceDocument, SOURCE_LIFETIME_RECORD_OPTIONS);
    // Keep the observer alive for the isolated-world document lifetime so
    // newly created credential nodes remain sticky before and between mirror
    // Port connections.
    isolatedGlobal.__simulHtmlMirrorV2SecretObserver = secretObserver;
  } catch {
    secretObserver = undefined;
  }
  if (secretObserver) {
    // The document's records stop at a shadow root. Every root a reader
    // meets, open or closed, from the walk below on, is watched the same
    // way, so a field added to it while no panel is open is still known as
    // a password when the page later shows it in clear (D125).
    const observer = secretObserver;
    listenForSourceShadowRoots(sourceDocument, (shadow) => {
      try {
        observer.observe(shadow, SOURCE_LIFETIME_RECORD_OPTIONS);
      } catch {
        documentSecretClassifier.classify(shadow.host, {
          tagName: shadow.host.localName,
          secretAncestor: true,
        });
      }
    });
  }
  eagerlyClassifySourceDocumentSecrets(
    sourceDocument,
    sourceWindow,
    documentSecretClassifier,
  );
  if (!secretObserver) {
    const root = sourceDocument.documentElement;
    if (root) {
      documentSecretClassifier.classify(root, {
        tagName: root.localName,
        secretAncestor: true,
      });
    }
  }
  // A root attached to an element already in the page fires nothing, but a
  // person who clicks into a field inside it, types, or presses its "show"
  // button does: the roots around the input are asked about before the
  // component's own handlers run, panel open or closed (D125). A listener
  // the page put on the window before this script ran runs first.
  const onUserInput = (event: Event): void => {
    askAboutSourceShadowRootsAtInput(event, sourceWindow, documentSecretClassifier);
  };
  for (const type of SOURCE_USER_INPUT_EVENTS) {
    try {
      sourceWindow.addEventListener(type, onUserInput, { capture: true, passive: true });
    } catch {
      // A window that takes no listener: the observer and the walks remain.
    }
  }

  // The site menus the semantic channel has read, kept for the document: a
  // menu the page has open when the mirror is built again is then still a
  // menu to the session that reads the page anew.
  const structuralMenus = new WeakMap<Element, {
    readonly trigger: Element;
    readonly panel: Element;
  }>();
  runtime.onConnect.addListener((port) => {
    if (readHtmlMirrorPortSessionId(port.name)) {
      new HtmlMirrorSourceSession({
        port,
        document: sourceDocument,
        window: sourceWindow,
        registry,
        secretClassifier: documentSecretClassifier,
        now: environment.now ?? (() => performance.now()),
        createMutationObserver: environment.createMutationObserver ??
          ((callback) => new MutationObserver(callback)),
        scheduleFrame: environment.scheduleFrame ??
          ((callback) => requestAnimationFrame(callback)),
        cancelFrame: environment.cancelFrame ??
          ((handle) => cancelAnimationFrame(Number(handle))),
        setTimer: environment.setTimer ??
          ((callback, milliseconds) => setTimeout(callback, milliseconds)),
        clearTimer: environment.clearTimer ??
          ((handle) => clearTimeout(Number(handle))),
        createResizeObserver: environment.createResizeObserver ??
          (typeof ResizeObserver === 'function'
            ? ((callback) => new ResizeObserver(callback))
            : undefined),
      });
      return;
    }
    if (readImageSourcePortSessionId(port.name, 'isolated-html')) {
      new ImageSourceSession({
        port,
        document: sourceDocument,
        window: sourceWindow,
        resolveNode: (nodeId) => registry.getNode(nodeId) ?? null,
        getNodeId: (image) => registry.getId(image),
        createObserver: (observerEnvironment) =>
          new SourceImageObserver(observerEnvironment),
        secretClassifier: documentSecretClassifier,
      });
      return;
    }
    if (!readSemanticSourcePortIdentity(port.name, 'isolated-html')) return;
    new SemanticSourceSession({
      port,
      document: sourceDocument,
      window: sourceWindow,
      bridge: 'isolated-html',
      secretClassifier: documentSecretClassifier,
      structuralMenus,
      getNodeId: (node) => registry.getId(node),
      createMutationObserver: environment.createMutationObserver,
      schedule: (callback) => queueMicrotask(callback),
    });
  });
}

interface HtmlMirrorSourceSessionEnvironment {
  readonly port: Browser.runtime.Port;
  readonly document: Document;
  readonly window: Window;
  readonly registry: WeakNodeIdRegistry;
  readonly secretClassifier?: StickySourceSecretClassifier;
  readonly now: () => number;
  readonly createMutationObserver: (
    callback: MutationCallback,
  ) => Pick<MutationObserver, 'observe' | 'disconnect'>;
  readonly scheduleFrame: (callback: () => void) => unknown;
  readonly cancelFrame: (handle: unknown) => void;
  readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly createResizeObserver?: (
    callback: ResizeObserverCallback,
  ) => Pick<ResizeObserver, 'observe' | 'disconnect'>;
}

/**
 * One bounded shadow-root observation pass. A mutation batch shares a
 * single walk across its records so nested targets are traversed once, and
 * the node budget keeps a hostile page from stalling the observer callback.
 */
interface ShadowObservationWalk {
  readonly visited: WeakSet<Node>;
  remaining: number;
  exhausted: boolean;
}

/** The input of a person, which comes before a field is shown in clear. */
const SOURCE_USER_INPUT_EVENTS = Object.freeze([
  'focusin',
  'pointerdown',
  'keydown',
  'beforeinput',
] as const);
/** Roots followed below the event's own path, through the focus or the pointer. */
const MAX_SOURCE_INPUT_ROOT_DEPTH = 32;

/**
 * Asks Chrome about the root of every element above the event's target and,
 * below the outermost closed host (where the event's path ends as seen from
 * here), along the focus or the pointer through the roots known by then. A
 * root that turns up is watched from then on (the listeners) and what it
 * holds is classified at once, while a password field in it is still one
 * (D125). No timer: the work is bounded by the path and its depth; below
 * that depth what the follow reached is read in one fresh walk.
 */
function askAboutSourceShadowRootsAtInput(
  event: Event,
  sourceWindow: Window,
  classifier: StickySourceSecretClassifier,
): void {
  const found: ShadowRoot[] = [];
  let beyond: Element | undefined;
  try {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const target = path[0] ?? event.target;
    if (!target || typeof (target as Node).nodeType !== 'number') return;
    const asked = new Set<Node>();
    found.push(...askAboutSourceShadowRootsAbove(target as Node, asked));
    const point = event.type === 'pointerdown'
      ? [(event as PointerEvent).clientX, (event as PointerEvent).clientY] as const
      : undefined;
    let current: Node | null = target as Node;
    let depth = 0;
    for (; current && depth < MAX_SOURCE_INPUT_ROOT_DEPTH; depth += 1) {
      if (current.nodeType !== 1) break;
      const root = readSourceShadowRoot(current as Element);
      if (!root) break;
      const next: Element | null = point
        ? root.elementFromPoint(point[0], point[1])
        : root.activeElement;
      if (!next || next === current) break;
      found.push(...askAboutSourceShadowRootsAbove(next, asked));
      current = next;
    }
    // The follow stopped at its bound, not at the input: a root attached
    // deeper still is found by reading what lies below in a fresh walk.
    if (depth === MAX_SOURCE_INPUT_ROOT_DEPTH && current?.nodeType === 1) {
      beyond = current as Element;
    }
  } catch {
    // An unreadable path: the observer and the walks remain.
  }
  for (const root of found) {
    if (!root.host) continue;
    eagerlyClassifySourceDocumentSubtree(root.host, sourceWindow, classifier, {
      freshRoots: true,
    });
  }
  if (beyond) {
    eagerlyClassifySourceDocumentSubtree(beyond, sourceWindow, classifier, {
      freshRoots: true,
    });
  }
}

/**
 * What the mirror's observer records, on the document and on every shadow
 * root. Without the old values a removed attribute reads as unchanged and is
 * dropped, and a credential type that changes is not remembered (D125).
 */
const SOURCE_SECRET_RECORD_OPTIONS: MutationObserverInit = Object.freeze({
  attributes: true,
  attributeOldValue: true,
  characterData: true,
  characterDataOldValue: true,
  childList: true,
  subtree: true,
});
/**
 * What the document-lifetime credential observer records: added and removed
 * nodes, and the attributes an old value of which can be credential evidence
 * (`rememberSourceMutationSecrets`). It runs while no panel is open, on the
 * document and on every root met, so an animation or a ticker inside a
 * component records nothing for it (D125).
 */
const SOURCE_LIFETIME_RECORD_OPTIONS: MutationObserverInit = Object.freeze({
  attributes: true,
  attributeOldValue: true,
  attributeFilter: [...SOURCE_EVIDENCE_ATTRIBUTE_FILTER],
  childList: true,
  subtree: true,
});
const MAX_HTML_MIRROR_PENDING_TARGETS = 4_000;
const SHADOW_DISCOVERY_INTERVAL_MS = 500;
const MAX_SHADOW_HOSTS_PER_TICK = 1_000;
const MAX_SHADOW_OBSERVATION_NODES = 20_000;
const MAX_STYLE_SHEETS_PER_TICK = 512;
const MAX_STYLE_RULES_PER_TICK = 25_000;
const MAX_STYLE_CHARACTERS_PER_TICK = 1024 * 1024;
const STYLE_CHANGE_STABILITY_OBSERVATIONS = 3;
const OVERSIZED_STYLE_RETRY_PASSES = 120;
/**
 * A sheet past either size is watched by its shape (D88): its rule count and
 * its first and last rules, which is what a script inserting or removing
 * rules changes. Reading its whole text every half second would take the
 * whole polling budget, so a page carrying one large sheet (Wise's 2.4 M
 * character design system) used to have no style polling at all.
 */
const MAX_FULL_SIGNATURE_RULES_PER_SHEET = 4_000;
const MAX_FULL_SIGNATURE_CHARACTERS_PER_SHEET = 256 * 1024;
/*
 * Many medium sheets can also outgrow the per-tick budget together. When an
 * owner's pass starts with the whole budget, a sheet that no longer fits is
 * watched by its shape from then on as well (D95), so such a page keeps its
 * style polling instead of being quarantined. Shape reads are bounded by the
 * sheet count (two rules of at most `MAX_SHALLOW_SIGNATURE_RULE_CHARACTERS`
 * each), not by the full-read budget they would otherwise find spent.
 */
const MAX_SHALLOW_SIGNATURE_RULE_CHARACTERS = 4_096;
const SHAPE_SIGNATURE_SHEETS = new WeakSet<CSSStyleSheet>();
/** Elements read again when the resource they name has loaded or failed. */
const CAPTURED_RESOURCE_ELEMENTS: ReadonlySet<string> = new Set(['img', 'link']);
const MAX_MIRRORED_IMAGE_CANDIDATES = 4_000;
const MAX_IMAGE_EVENT_ROOTS = 4_000;
const MAX_VISIBILITY_MUTATION_RECORDS = 2_048;
/**
 * Nodes of a slot read again one by one when what the slot shows changes;
 * past this their host's children are read again in one piece (D135).
 */
const MAX_SLOTTED_NODES = 256;
/**
 * Elements whose style is read again in one flush because what their script
 * animations hold has changed; the rest wait for the next frame. A page may
 * end thousands of animations at once, and `MAX_HTML_MIRROR_PENDING_TARGETS`
 * is all the pending work one flush may hold.
 */
const MAX_HELD_ANIMATION_CHANGES = 1_000;
/**
 * The longest the periodic look at the page's animations waits on a page at
 * rest, in half seconds: four seconds. An animation that a timer starts and
 * that ends between two looks, with nothing else happening, is found that
 * much later at worst.
 */
const MAX_HELD_LOOK_WAIT = 8;
const CONTROLLED_LAYOUT_SETTLE_EVENTS = Object.freeze([
  'transitionend',
  'transitioncancel',
  'animationend',
  'animationcancel',
] as const);
const VISUAL_VIEWPORT_EVENTS = Object.freeze(['resize', 'scroll'] as const);
const VISIBILITY_INTERACTION_EVENTS = Object.freeze([
  'pointerover',
  'pointerout',
  'pointerdown',
  'pointerup',
  'click',
  'focusin',
  'focusout',
  'keydown',
  'keyup',
  'beforeinput',
  'input',
  'change',
  'beforetoggle',
  'toggle',
] as const);

type ReconciliationDecision =
  | 'reconcile'
  | 'missingReconciliationProofFallbackCount'
  | 'coveredDirtyBranchFallbackCount'
  | 'attributeContextFallbackCount'
  | 'crossParentFallbackCount';

/** Pending changes set aside for a later patch of the same frame. */
interface HeldChanges {
  readonly children: readonly Node[];
  readonly attributes: readonly Element[];
  readonly text: readonly Text[];
  readonly sheets: readonly Element[];
  /** Slots, filled by a script, whose list of nodes is to be sent. */
  readonly slotLists: readonly Element[];
  readonly dimensions: boolean;
}

type StylePollResult = 'changed' | 'unchanged' | 'capacity';
type StylePollChannel = 'ordinary' | 'adopted';

function oppositeStylePollChannel(
  channel: StylePollChannel,
): StylePollChannel {
  return channel === 'ordinary' ? 'adopted' : 'ordinary';
}

function stylePollChannelMask(channel: StylePollChannel): number {
  return channel === 'ordinary' ? 1 : 2;
}

export class HtmlMirrorSourceSession {
  readonly #sessionId: string;
  #identity: ReplicaDocumentIdentity | undefined;
  #fidelityPolicy: SelectableReplicaFidelityPolicy | undefined;
  #observer: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  #resizeObserver: Pick<ResizeObserver, 'observe' | 'disconnect'> | undefined;
  #pendingChildren = new Set<Node>();
  #pendingAttributes = new Set<Element>();
  #pendingText = new Set<Text>();
  /**
   * Elements whose style sheet is sent again: a `<style>` whose text
   * changed, a `<link>` whose sheet has loaded, the element of a sheet the
   * poll found changed (D143). Sent as attributes are, and in a patch of
   * their own when lists of children change in the same frame: see
   * `#readAndPostInTurns`.
   */
  #pendingSheets = new Set<Element>();
  /**
   * Shadow roots whose slots changed, and children of hosts given another
   * slot name: what may be drawn in other boxes than it was; see
   * `#queueChangedSlotReadings`.
   */
  #slotChanges = new Set<Node>();
  /** Slots, filled by a script, whose list of nodes is to be sent. */
  #pendingSlotLists = new Set<Element>();
  /**
   * How this reader last read each child of a shadow host into its own
   * mirror. One connection's note is not another's: the page script makes a
   * reader a connection, and each mirror is told of a change by its own.
   */
  readonly #slotReadings = createSourceSlotReadings();
  #pendingDimensions = false;
  #lastDimensions: ReturnType<typeof readSourceDimensions> | undefined;
  #pendingOverflow = false;
  #mirroredNodes = new WeakSet<Node>();
  #mirroredOpaqueSecrets = new WeakSet<Element>();
  #emittedChildren = new WeakMap<Node, readonly Node[]>();
  #emittedParent = new WeakMap<Node, Node>();
  #emittedNodeSignatures = new WeakMap<Node, string>();
  #mirroredImageCandidates: Element[] = [];
  #knownMirroredImageCandidates = new WeakSet<Element>();
  #selectedImageSources = new WeakMap<Element, string>();
  #imageRefreshRequested = false;
  readonly #imageEventRoots = new Set<Document | ShadowRoot>();
  readonly #observedShadowRoots = new WeakSet<ShadowRoot>();
  #shadowHostCandidates: Element[] = [];
  #knownShadowHostCandidates = new WeakSet<Element>();
  #settledShadowHostCandidates = new WeakSet<Element>();
  #shadowDiscoveryCursor = 0;
  #shadowObservationOmissionCount = 0;
  #shadowObservationVisitCount = 0;
  #stylePollingCursor = 0;
  #stylePollingPass = 0;
  #stylePollingPhases = new WeakMap<object, StylePollChannel>();
  #styleCapacityChannels = new WeakMap<object, number>();
  #styleCapacityRetryPasses = new WeakMap<object, readonly [number, number]>();
  readonly #adoptedStyleSignatures = new StableSignatureTracker(
    STYLE_CHANGE_STABILITY_OBSERVATIONS,
  );
  readonly #ordinaryStyleSignatures = new StableSignatureTracker(
    STYLE_CHANGE_STABILITY_OBSERVATIONS,
  );
  /**
   * Each owner's sheets as the poll last settled on them, so that a change
   * names the sheets it is in. See `#rereadChangedStyleSheets`.
   */
  #ordinaryStyleSheets = new WeakMap<object, readonly OrdinaryStyleSheetRead[]>();
  /**
   * The `<style>` elements the mirror holds by their sheet's text
   * (`resolvedStyleSheetText`), as a whole read sends them (D143).
   */
  #sheetTextStyles = new WeakSet<Element>();
  /**
   * For each element the page declares hidden: whether what it holds was
   * withheld when it was last sent. See `#readStyleDerivedAgain`.
   */
  #declaredHiddenSent = new WeakMap<Element, boolean>();
  /**
   * A style sheet changed: what the reader takes from an element's style
   * is taken again at the next flush. See `#readStyleDerivedAgain`.
   */
  #styleDerivedPending = false;
  #shadowDiscoveryTimer: unknown;
  /** When a layout change last asked about every element's root. */
  #lastFreshLayoutWalk = Number.NEGATIVE_INFINITY;
  /** The fresh walk owed to a layout change inside the interval. */
  #trailingLayoutTimer: unknown;
  #frame: unknown;
  #scrollFrame: unknown;
  /**
   * Elements that are not at their scroll start, the most recently scrolled
   * last (D122), each with what the panel was last told of it: nothing for
   * one kept in mind without being named (hidden, or not sent yet). A
   * scroll message names the ones whose place is no longer what was told.
   */
  #scrolledPanes = new Map<Element, HtmlMirrorPaneScroll | undefined>();
  /** Panes that a scroll message has named. */
  #listedPanes = new WeakSet<Element>();
  /** Elements whose scroll event waits for the frame's one read. */
  #pendingPanes = new Set<Element>();
  /** More elements scrolled in this frame than the mirror follows. */
  #pendingPaneBurst = false;
  /**
   * Elements met scrolled with no scroll event to tell of it: when they
   * were sent, or when they were shown. See `#meetPane`.
   */
  #metPanes = new Set<Element>();
  /** The viewport-scale pane the tab scrolls in place of its document. */
  #primaryPane: Element | undefined;
  #pendingDocumentScroll = false;
  #lastDocumentScroll:
    ReturnType<typeof readDocumentScrollSnapshot> | undefined;
  /** The last place sent, to tell a frame in which nothing moved. */
  #lastReportedPlace: string | undefined;
  /** The pane last named as the one scrolled in place of the document. */
  #lastReportedPrimaryPaneId: number | undefined;
  /** A list could not be sent: the next one is the whole list. */
  #restatePanes = false;
  #sequence = 0;
  #acknowledged = 0;
  #paused = false;
  #recoveryCheckpointSequence: number | undefined;
  #shadowReconciliationPending = false;
  /**
   * Closed roots found, by any reader of the page, on an element that had
   * been read without one: attached since. See `#takeLateShadowRoots`.
   */
  #lateShadowRoots: ShadowRoot[] = [];
  #stopListeningForShadowRoots: (() => void) | undefined;
  #stopListeningForHeldAnimations: (() => void) | undefined;
  /**
   * Roots the last checkpoint could not hold: their host is inside a
   * credential shell or under an element the mirror leaves out. Another
   * checkpoint would not hold them either, so meeting one again asks for
   * none (D125). Before, every change above such an open root rebuilt the
   * mirror, and closed roots would have joined them.
   */
  #unheldShadowRoots = new WeakSet<ShadowRoot>();
  /** The walk that follows a checkpoint is noting those roots. */
  #notingUnheldShadowRoots = false;
  #controlledContentPolicy: SourceControlledContentPolicy | undefined;
  #controlledLayoutSettlePending = false;
  #visibilityBoundaryIndex: SourceVisibilityBoundaryIndex | undefined;
  #visibilityMutationRecords: MutationRecord[] = [];
  #visibilityMutationOverflow = false;
  #visibilityInteractionTargets = new Set<Element>();
  #visibilityFullRefreshPending = false;
  /**
   * Elements whose ended script animations hold other values than were last
   * read, as the last listing of the page's animations found. Their style is
   * read again, a bounded number of them in one patch.
   */
  #heldChanged = new Set<Element>();
  /**
   * How the reader's periodic look at the page's animations waits: `every`
   * half seconds between two looks, `in` of them until the next. A look
   * that changes nothing doubles the wait, up to `MAX_HELD_LOOK_WAIT`, so a
   * page at rest that holds thousands of values is not listed twice a
   * second for as long as the panel is open; any flush (a change of the
   * page, a pointer or key event, the end of an animation) and any whole
   * read bring it back to half a second.
   */
  #heldLook = { every: 1, in: 1 };
  /**
   * Those of them this flush reads. Only what such an element holds can be
   * shown or hidden by what its animation holds, so only that is compared
   * again, not the page.
   */
  #heldAnimationTargets = new Set<Element>();
  #disposed = false;

  constructor(private readonly environment: HtmlMirrorSourceSessionEnvironment) {
    const sessionId = readHtmlMirrorPortSessionId(environment.port.name);
    if (!sessionId) throw new Error('Invalid HTML mirror Port.');
    this.#sessionId = sessionId;
    environment.port.onMessage.addListener(this.#onMessage);
    environment.port.onDisconnect.addListener(this.#onDisconnect);
  }

  /**
   * Nodes visited by shadow-root observation walks since construction.
   * A content-free traversal counter for tests and diagnostics.
   */
  get shadowObservationVisitCount(): number {
    return this.#shadowObservationVisitCount;
  }

  dispose(disconnect = false): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.environment.port.onMessage.removeListener(this.#onMessage);
    this.environment.port.onDisconnect.removeListener(this.#onDisconnect);
    this.#stopListeningForShadowRoots?.();
    this.#stopListeningForShadowRoots = undefined;
    this.#stopListeningForHeldAnimations?.();
    this.#stopListeningForHeldAnimations = undefined;
    this.#heldChanged.clear();
    this.#lateShadowRoots = [];
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.environment.window.removeEventListener('resize', this.#onLayoutChange);
    this.environment.window.removeEventListener('scroll', this.#onScroll, true);
    for (const type of VISUAL_VIEWPORT_EVENTS) {
      this.environment.window.visualViewport?.removeEventListener?.(
        type,
        this.#onVisualViewportChange,
      );
    }
    this.environment.window.removeEventListener(
      'hashchange',
      this.#onLayoutChange,
    );
    for (const type of CONTROLLED_LAYOUT_SETTLE_EVENTS) {
      this.environment.document.removeEventListener(
        type,
        this.#onControlledLayoutSettle,
        true,
      );
    }
    for (const type of VISIBILITY_INTERACTION_EVENTS) {
      this.environment.document.removeEventListener(
        type,
        this.#onVisibilityInteraction,
        true,
      );
    }
    for (const root of this.#imageEventRoots) {
      root.removeEventListener('load', this.#onCapturedResourceLoad, true);
      root.removeEventListener('error', this.#onCapturedResourceError, true);
      root.removeEventListener('scroll', this.#onScroll, true);
      root.removeEventListener('slotchange', this.#onSlotChange, true);
    }
    this.#imageEventRoots.clear();
    this.environment.document.fonts?.removeEventListener?.(
      'loadingdone',
      this.#onFontLoadingDone,
    );
    if (this.#frame !== undefined) this.environment.cancelFrame(this.#frame);
    this.#frame = undefined;
    if (this.#scrollFrame !== undefined) {
      this.environment.cancelFrame(this.#scrollFrame);
    }
    this.#scrollFrame = undefined;
    if (this.#shadowDiscoveryTimer !== undefined) {
      this.environment.clearTimer(this.#shadowDiscoveryTimer);
    }
    this.#shadowDiscoveryTimer = undefined;
    if (this.#trailingLayoutTimer !== undefined) {
      this.environment.clearTimer(this.#trailingLayoutTimer);
    }
    this.#trailingLayoutTimer = undefined;
    this.#shadowHostCandidates = [];
    this.#knownShadowHostCandidates = new WeakSet<Element>();
    this.#settledShadowHostCandidates = new WeakSet<Element>();
    this.#unheldShadowRoots = new WeakSet<ShadowRoot>();
    this.#shadowDiscoveryCursor = 0;
    this.#stylePollingCursor = 0;
    this.#stylePollingPass = 0;
    this.#stylePollingPhases = new WeakMap<object, StylePollChannel>();
    this.#styleCapacityChannels = new WeakMap<object, number>();
    this.#styleCapacityRetryPasses = new WeakMap<
      object,
      readonly [number, number]
    >();
    this.#mirroredImageCandidates = [];
    this.#knownMirroredImageCandidates = new WeakSet<Element>();
    this.#selectedImageSources = new WeakMap<Element, string>();
    this.#imageRefreshRequested = false;
    this.#scrolledPanes.clear();
    this.#listedPanes = new WeakSet<Element>();
    this.#pendingPanes.clear();
    this.#pendingPaneBurst = false;
    this.#metPanes.clear();
    this.#primaryPane = undefined;
    this.#pendingDocumentScroll = false;
    this.#lastDocumentScroll = undefined;
    this.#lastReportedPlace = undefined;
    this.#lastReportedPrimaryPaneId = undefined;
    this.#restatePanes = false;
    this.#lastDimensions = undefined;
    this.#emittedNodeSignatures = new WeakMap<Node, string>();
    this.#adoptedStyleSignatures.reset();
    this.#ordinaryStyleSignatures.reset();
    this.#ordinaryStyleSheets = new WeakMap();
    this.#sheetTextStyles = new WeakSet<Element>();
    this.#declaredHiddenSent = new WeakMap<Element, boolean>();
    this.#styleDerivedPending = false;
    this.#controlledContentPolicy = undefined;
    this.#controlledLayoutSettlePending = false;
    this.#visibilityBoundaryIndex?.dispose();
    this.#visibilityBoundaryIndex = undefined;
    this.#visibilityMutationRecords = [];
    this.#visibilityMutationOverflow = false;
    this.#visibilityInteractionTargets.clear();
    this.#visibilityFullRefreshPending = false;
    this.#clearPending();
    if (disconnect) {
      try {
        this.environment.port.disconnect();
      } catch {
        // The exact document may already be gone.
      }
    }
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed) return;
    const message = readHtmlMirrorControllerMessage(
      input,
      this.#sessionId,
      this.#identity,
    );
    if (!message) {
      this.dispose(true);
      return;
    }
    if (message.kind === 'simul:html-mirror-v2:start') {
      if (this.#identity || message.identity.frameId !== 0) {
        this.dispose(true);
        return;
      }
      // Both sides of this mirror use the panel's size limits and its
      // "Show everything (testing)" switch.
      applyHtmlMirrorLimitSettings(message.limits);
      applySourcePrivacyFiltersOff(message.showEverything);
      this.#start(message.identity, message.fidelityPolicy);
      return;
    }
    if (!this.#identity) {
      this.dispose(true);
      return;
    }
    if (message.kind === 'simul:html-mirror-v2:ack') {
      if (
        message.identity.sequence < this.#acknowledged ||
        message.identity.sequence > this.#sequence
      ) {
        this.#post(createHtmlMirrorError(
          this.#identityAt(this.#sequence),
          'stream_gap',
        ));
        return;
      }
      this.#acknowledged = message.identity.sequence;
      if (
        this.#recoveryCheckpointSequence !== undefined &&
        message.identity.sequence >= this.#recoveryCheckpointSequence
      ) {
        this.#recoveryCheckpointSequence = undefined;
        if (this.#pendingOverflow) {
          this.#pendingOverflow = false;
          this.#post(createHtmlMirrorError(
            this.#identityAt(this.#sequence),
            'stream_overflow',
          ));
          return;
        }
        this.#paused = false;
        if (this.#shadowReconciliationPending) {
          this.#signalShadowReconciliation();
          return;
        }
        this.#scheduleFlush();
      }
      return;
    }
    if (
      message.identity.sequence < this.#acknowledged ||
      message.identity.sequence > this.#sequence
    ) {
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'stream_gap',
      ));
      return;
    }
    this.#acknowledged = message.identity.sequence;
    this.#paused = true;
    this.#recoveryCheckpointSequence = this.#sequence;
    this.#pendingOverflow = false;
    if (this.#frame !== undefined) this.environment.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#clearPending();
    this.#postCheckpoint();
  };

  readonly #onDisconnect = (): void => this.dispose(false);

  #start(
    identity: ReplicaDocumentIdentity,
    fidelityPolicy: SelectableReplicaFidelityPolicy,
  ): void {
    if (this.environment.window.top !== this.environment.window) {
      this.#post(createHtmlMirrorError(identity, 'stream_failed'));
      this.dispose(true);
      return;
    }
    this.#identity = identity;
    this.#fidelityPolicy = fidelityPolicy;
    try {
      this.#observer = this.environment.createMutationObserver(
        (records) => this.#onMutations(records),
      );
      this.#observer.observe(this.environment.document.documentElement, {
        attributes: true,
        attributeOldValue: true,
        characterData: true,
        characterDataOldValue: true,
        childList: true,
        subtree: true,
      });
      // The semantic and image readers ask about the roots above what they
      // send, and may find one first (D125).
      this.#stopListeningForShadowRoots = listenForSourceShadowRoots(
        this.environment.document,
        (shadow, late) => {
          if (!late || this.#disposed) return;
          this.#lateShadowRoots.push(shadow);
          this.#scheduleFlush();
        },
      );
      // What a script animation holds after its end changes what its
      // element is drawn with and records nothing. Each listing of the
      // page's animations says whose held values are other than were read;
      // the end of one that was running asks for a listing.
      this.#stopListeningForHeldAnimations = listenForSourceHeldAnimations(
        this.environment.document,
        {
          changed: (element) => {
            this.#heldChanged.add(element);
          },
          // A frame, with nothing else to send: its pass lists them again.
          ended: () => this.#scheduleFlush(true),
        },
      );
      this.environment.window.addEventListener('resize', this.#onLayoutChange);
      this.environment.window.addEventListener('scroll', this.#onScroll, {
        capture: true,
        passive: true,
      });
      // A pinch zoom and panning inside it fire here only (D115).
      for (const type of VISUAL_VIEWPORT_EVENTS) {
        this.environment.window.visualViewport?.addEventListener?.(
          type,
          this.#onVisualViewportChange,
          { passive: true },
        );
      }
      this.environment.window.addEventListener(
        'hashchange',
        this.#onLayoutChange,
      );
      for (const type of CONTROLLED_LAYOUT_SETTLE_EVENTS) {
        this.environment.document.addEventListener(
          type,
          this.#onControlledLayoutSettle,
          true,
        );
      }
      for (const type of VISIBILITY_INTERACTION_EVENTS) {
        this.environment.document.addEventListener(
          type,
          this.#onVisibilityInteraction,
          true,
        );
      }
      this.#observeImageEvents(this.environment.document);
      this.environment.document.fonts?.addEventListener?.(
        'loadingdone',
        this.#onFontLoadingDone,
      );
      if (this.environment.createResizeObserver) {
        this.#resizeObserver = this.environment.createResizeObserver(
          () => this.#onLayoutChange(),
        );
        this.#resizeObserver.observe(this.environment.document.documentElement);
        if (this.environment.document.body) {
          this.#resizeObserver.observe(this.environment.document.body);
        }
      }
      // The extension must construct and validate its inert iframe before it
      // can consume live patches. Hold mutations behind the initial
      // checkpoint ACK so dynamic pages coalesce startup work instead of
      // overflowing the client's bounded pre-observer queue.
      this.#paused = true;
      this.#recoveryCheckpointSequence = this.#sequence;
      this.#postCheckpoint();
    } catch {
      this.#post(createHtmlMirrorError(identity, 'stream_failed'));
      this.dispose(true);
    }
  }

  #postCheckpoint(): void {
    // A checkpoint sends the whole page, so it asks about every element's
    // root again instead of trusting an earlier "none": it holds every root
    // attached so far, as it always did for open ones (D125).
    const rootWalk = beginSourceShadowRootWalk({ fresh: true });
    // The page's script animations are listed, tree by tree as the read
    // enters each, and what they hold is read with each element's style.
    const heldPass = beginSourceHeldAnimationPass(
      this.environment.document,
      true,
      this.environment.now,
    );
    try {
      heldPass.list(this.environment.document);
      this.#readAndPostCheckpoint();
    } finally {
      heldPass.end();
      rootWalk.end();
      this.#lateShadowRoots = [];
      // The whole page was read: nothing of it is owed.
      this.#heldChanged.clear();
      this.#heldLook = { every: 1, in: 1 };
    }
  }

  #readAndPostCheckpoint(): void {
    const identity = this.#identity;
    const fidelityPolicy = this.#fidelityPolicy;
    if (!identity || !fidelityPolicy || this.#disposed) return;
    const startedAt = this.environment.now();
    const representability = createHtmlMirrorRepresentabilityCollector();
    try {
      const controlledContentPolicy = createSourceControlledContentPolicy(
        this.environment.document,
        this.environment.window,
        MAX_HTML_MIRROR_NODES,
      );
      const graph = sanitizeSourceDocument(
        this.environment.document,
        this.environment.window,
        this.environment.registry,
        representability,
        fidelityPolicy,
        controlledContentPolicy,
        this.#slotReadings,
      );
      const checkpoint = graph && createHtmlMirrorCheckpoint(
        this.#identityAt(this.#sequence),
        {
          root: graph.root,
          adoptedStyleSheets: graph.adoptedStyleSheets,
          documentMode: graph.documentMode,
          captureMs: Math.max(0, this.environment.now() - startedAt),
          viewportWidth: graph.viewportWidth,
          viewportHeight: graph.viewportHeight,
          documentWidth: graph.documentWidth,
          documentHeight: graph.documentHeight,
          representability: this.#summarizeRepresentability(representability),
        },
        fidelityPolicy,
      );
      if (!checkpoint) {
        if (graph && representability.capacityOmissionCount === 0) {
          incrementSourceRepresentability(
            representability,
            'capacityOmissionCount',
          );
        }
        this.#post(createHtmlMirrorError(
          this.#identityAt(this.#sequence),
          representability.capacityOmissionCount > 0
            ? 'stream_overflow'
            : 'privacy_rejected',
          snapshotHtmlMirrorRepresentability(representability),
        ));
        return;
      }
      this.#mirroredNodes = new WeakSet<Node>();
      this.#mirroredOpaqueSecrets = new WeakSet<Element>();
      this.#emittedChildren = new WeakMap<Node, readonly Node[]>();
      this.#emittedParent = new WeakMap<Node, Node>();
      this.#emittedNodeSignatures = new WeakMap<Node, string>();
      this.#shadowHostCandidates = [];
      this.#knownShadowHostCandidates = new WeakSet<Element>();
      this.#shadowDiscoveryCursor = 0;
      this.#stylePollingCursor = 0;
      this.#mirroredImageCandidates = [];
      this.#knownMirroredImageCandidates = new WeakSet<Element>();
      this.#selectedImageSources = new WeakMap<Element, string>();
      this.#imageRefreshRequested = false;
      this.#adoptedStyleSignatures.reset();
      this.#adoptedStyleSignatures.prime(
        this.environment.document,
        adoptedStyleSignature(checkpoint.payload.adoptedStyleSheets),
      );
      this.#ordinaryStyleSignatures.reset();
      this.#controlledContentPolicy = controlledContentPolicy;
      this.#visibilityBoundaryIndex?.dispose();
      this.#visibilityBoundaryIndex = new SourceVisibilityBoundaryIndex(
        this.environment.document,
        this.environment.window,
        MAX_HTML_MIRROR_NODES,
      );
      this.#markMirroredGraph(checkpoint.payload.root);
      this.#lastDimensions = Object.freeze({
        viewportWidth: checkpoint.payload.viewportWidth,
        viewportHeight: checkpoint.payload.viewportHeight,
        documentWidth: checkpoint.payload.documentWidth,
        documentHeight: checkpoint.payload.documentHeight,
        ...(checkpoint.payload.root.canvasBackgroundColor
          ? { canvasBackgroundColor: checkpoint.payload.root.canvasBackgroundColor }
          : {}),
      });
      this.#unheldShadowRoots = new WeakSet<ShadowRoot>();
      this.#notingUnheldShadowRoots = true;
      try {
        this.#observeShadowRoots(this.environment.document.documentElement);
      } finally {
        this.#notingUnheldShadowRoots = false;
      }
      this.#primeOrdinaryStyleSignatures();
      this.#shadowReconciliationPending = false;
      this.#post(checkpoint);
      // A pane scrolled before this mirror was built fires no event: the
      // scrolled ones were met while the page was sent, so the first report
      // puts them at their place. The replica is built anew, so this report
      // carries the whole pane list.
      this.#takeMetPanes();
      this.#postScroll(false, true);
      this.#scheduleShadowDiscovery();
    } catch (error) {
      if (
        error instanceof HtmlMirrorCapacityError &&
        !error.diagnosticRecorded
      ) {
        incrementSourceRepresentability(
          representability,
          'capacityOmissionCount',
        );
      }
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        representability.capacityOmissionCount > 0
          ? 'stream_overflow'
          : 'privacy_rejected',
        snapshotHtmlMirrorRepresentability(representability),
      ));
    }
  }

  #onMutations(records: MutationRecord[]): void {
    if (this.#disposed || !this.#identity) return;
    try {
      this.#queueMutationRecords(records);
    } catch {
      // An exception here used to drop the whole batch silently, after which
      // the replica drifted with no diagnostic. Reuse the bounded checkpoint
      // reconciliation signal: the receiver requests a fresh checkpoint and
      // the stream stays paused until that checkpoint is acknowledged.
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
    }
  }

  #queueMutationRecords(records: MutationRecord[]): void {
    rememberSourceMutationSecrets(
      records,
      this.environment.window,
      this.environment.secretClassifier ?? sourceDocumentSecretClassifier(
        this.environment.document,
      ),
    );
    // Chrome takes a document's language from the pragma it read last, and
    // reads one again when it is put into the document or when one of its
    // attributes is written, even with the value it had (which the filter
    // below drops as no change). The root's attributes carry that language
    // (`readSourceDocumentLanguage`): they are read again, and sent if the
    // answer is another.
    if (records.some(sourceMutationReadsPragma)) this.#queueDocumentLanguage();
    // Native observers can report an attribute/character assignment whose
    // final value is exactly its old value. Keep the sticky secret ledger
    // above authoritative, then discard only these provable DOM no-ops before
    // they consume the bounded pending-target budget and force recovery.
    if (!records.every(sourceMutationMayChangeCurrentValue)) {
      records = records.filter(sourceMutationMayChangeCurrentValue);
    }
    if (records.length === 0) return;
    let accepted = false;
    let visibilityQueued = false;
    const visibilityRecords = this.#visibilityBoundaryIndex
      ? records.filter((record) =>
          belongsToSourceDocument(record.target, this.environment.document)
        )
      : [];
    if (this.#visibilityBoundaryIndex && visibilityRecords.length > 0) {
      visibilityQueued = true;
      if (
        this.#visibilityMutationOverflow ||
        this.#visibilityMutationRecords.length + visibilityRecords.length >
          MAX_VISIBILITY_MUTATION_RECORDS
      ) {
        this.#visibilityMutationRecords = [];
        this.#visibilityMutationOverflow = true;
      } else {
        this.#visibilityMutationRecords.push(...visibilityRecords);
      }
    }
    if (this.#controlledContentPolicy &&
      sourceControlledContentMutationsMayChange(
        records,
        this.#controlledContentPolicy,
      )) {
      accepted = this.#refreshControlledContentPolicy() || accepted;
    }
    // One bounded walk per batch: nested records share the visited set so a
    // descendant subtree is not traversed again for each ancestor record.
    const walk = this.#createShadowObservationWalk();
    for (const record of records) {
      // The top-document observer must never turn a same-origin embedded
      // browsing context into an accidental second mirror surface. This is a
      // defensive boundary for synthetic/polyfilled observers as well as the
      // normal browser observer, which does not cross Document boundaries.
      if (!belongsToSourceDocument(record.target, this.environment.document)) {
        continue;
      }
      const mutationElement = sourceMutationOwnerElement(record.target);
      if (
        mutationElement &&
        hasSourceCredentialSecretAncestor(
          mutationElement,
          this.environment.secretClassifier ?? sourceDocumentSecretClassifier(
            this.environment.document,
          ),
          this.environment.window,
        )
      ) {
        // A public graph node cannot be converted into the canonical opaque
        // shell by a patch: the shell deliberately has a new extension-owned
        // tag and no authored attributes, descendants, or presentation hints.
        // Rebuild once, then ignore every later mutation under that shell for
        // the rest of this document lifetime.
        if (
          this.#mirroredNodes.has(mutationElement) &&
          !this.#mirroredOpaqueSecrets.has(mutationElement)
        ) {
          this.#shadowReconciliationPending = true;
          this.#signalShadowReconciliation();
          return;
        }
        continue;
      }
      const structuralSelectOwner = sourceNativeSelectStructuralOwner(record.target);
      // A slot added to a root, taken out of it or renamed: the root's
      // slots may take other nodes of its host than they did (D135).
      const slotRoot = sourceMutationChangesSlots(record);
      if (slotRoot) this.#slotsChanged(slotRoot);
      // The text of a `<style>` the mirror holds by its sheet's text: the
      // element is sent again with that text, as a whole read sends it, and
      // its text nodes, which the mirror shows nowhere, are not (D143). The
      // change used to travel as text, and then once more as the whole
      // page when the style poll saw the sheet change.
      const sheetStyle = sourceMutationStyleElement(record);
      if (sheetStyle && this.#sheetTextStyles.has(sheetStyle)) {
        accepted = true;
        this.#queuePending(this.#pendingSheets, sheetStyle);
        this.#styleDerivedPending = true;
        if (sourceMutationChangesTextOnly(record)) continue;
      }
      if (record.type === 'childList') {
        accepted = true;
        this.#observeShadowRoots(record.target, walk);
        if (!structuralSelectOwner || structuralSelectOwner === record.target) {
          this.#queuePending(this.#pendingChildren, record.target);
        } else if (
          record.target instanceof Element &&
          holdsSourceNativeSelectEntries(record.target, structuralSelectOwner)
        ) {
          // A dropdown's structure is sent whole from the dropdown itself:
          // the panel takes no patch for one of its groups, and one sent for
          // it was refused and rebuilt the whole mirror (D132). The group,
          // or the wrapper around some of the options (D135), stays queued
          // beside its dropdown so the dropdown's list is read afresh, not
          // compared child by child.
          this.#queuePending(this.#pendingChildren, structuralSelectOwner);
          this.#queuePending(this.#pendingChildren, record.target);
        }
        // Anything else inside a dropdown is an option's own text or a
        // group's legend. Neither is in the mirror's structure: the label
        // travels on the semantic channel.
        for (const added of record.addedNodes) {
          this.#observeShadowRoots(added, walk);
        }
      } else if (record.type === 'attributes' && record.target instanceof Element) {
        accepted = true;
        this.#observeShadowRoots(record.target, walk);
        const changesPrivacyContext =
          record.attributeName === 'role' ||
          record.attributeName === 'contenteditable' ||
          record.attributeName === 'type' ||
          record.attributeName === 'autocomplete';
        if (changesPrivacyContext && structuralSelectOwner) {
          // Public/private transitions replace select grammar and state in one
          // root-level batch so an old public label cannot survive recovery.
          this.#queuePending(this.#pendingChildren, structuralSelectOwner);
          this.#queuePending(this.#pendingAttributes, structuralSelectOwner);
        } else {
          this.#queuePending(
            this.#pendingAttributes,
            record.target,
          );
        }
        if (changesPrivacyContext) {
          // A children patch can re-sanitize a host's light DOM, but it cannot
          // replace that host's already-mirrored ShadowRoot. Rebuild the whole
          // graph whenever the host's privacy context can change.
          if (readSourceShadowRoot(record.target)) {
            this.#shadowReconciliationPending = true;
            this.#signalShadowReconciliation();
            return;
          }
          if (!structuralSelectOwner) {
            this.#queuePending(this.#pendingChildren, record.target);
          }
          // A box of a root that becomes an editor, or stops being one,
          // does so for what its slots hold too, none of which is inside
          // it: see `#queueChangedSlotReadings`.
          const root = record.target.getRootNode();
          if (isSourceShadowRoot(root)) this.#slotChanges.add(root);
        } else if (
          record.attributeName === 'slot' &&
          record.target.parentElement &&
          readSourceShadowRoot(record.target.parentElement)
        ) {
          // A child of a host given another slot name may be drawn inside
          // other boxes: see `#queueChangedSlotReadings`.
          this.#slotChanges.add(record.target);
        }
      } else if (record.type === 'characterData' && record.target instanceof Text) {
        accepted = true;
        this.#observeShadowRoots(record.target, walk);
        this.#queuePending(this.#pendingText, record.target);
      }
    }
    if (!accepted && !visibilityQueued) return;
    if (accepted) this.#pendingDimensions = true;
    this.#scheduleFlush();
  }

  /** Has the root's attributes, which carry the document's language, read again. */
  #queueDocumentLanguage(): void {
    const root = this.environment.document.documentElement;
    if (!root || !this.#mirroredNodes.has(root)) return;
    this.#queuePending(this.#pendingAttributes, root);
    this.#scheduleFlush();
  }

  #flush(): void {
    const fidelityPolicy = this.#fidelityPolicy;
    if (
      this.#disposed || !this.#identity || !fidelityPolicy || this.#paused
    ) return;
    if (
      this.#sequence - this.#acknowledged >=
      MAX_HTML_MIRROR_UNACKED_BATCHES
    ) {
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'stream_overflow',
      ));
      return;
    }
    // Something happened on the page: the periodic look is half a second off.
    this.#heldLook = { every: 1, in: 1 };
    // One walk of the roots for all of it: what is painted is asked about
    // the children of the same hosts as what is sent (a closed root that
    // assigns 4,000 nodes by script had its slots' lists gone through once
    // a child).
    const rootWalk = beginSourceShadowRootWalk();
    try {
      // One listing of the page's animations serves the whole flush: what
      // is compared and what is read see the same held values.
      const heldPass = beginSourceHeldAnimationPass(
        this.environment.document,
        false,
        this.environment.now,
      );
      try {
        this.#listHeldAnimations(heldPass);
        this.#takeHeldAnimationChanges();
        this.#flushChanges(fidelityPolicy);
      } finally {
        heldPass.end();
        // More elements than one patch takes, or some met while this one
        // was read: the next frame's.
        if (this.#heldChanged.size > 0) this.#scheduleFlush();
      }
    } finally {
      rootWalk.end();
    }
  }

  /** Lists the animations of every tree the mirror holds, once in the open pass. */
  #listHeldAnimations(
    pass: ReturnType<typeof beginSourceHeldAnimationPass>,
  ): void {
    if (!pass.lists) return;
    for (const tree of this.#styleOwners()) pass.list(tree);
  }

  /**
   * Queues the elements whose held values changed for their style to be
   * read again, at most `MAX_HELD_ANIMATION_CHANGES` of them in one flush:
   * thousands of animations that end together are a few patches, not more
   * pending work than the stream takes at once.
   */
  #takeHeldAnimationChanges(): void {
    let taken = 0;
    for (const element of this.#heldChanged) {
      if (taken >= MAX_HELD_ANIMATION_CHANGES) break;
      this.#heldChanged.delete(element);
      taken += 1;
      this.#heldAnimationTargets.add(element);
      this.#queuePending(this.#pendingAttributes, element);
    }
  }

  #flushChanges(fidelityPolicy: SelectableReplicaFidelityPolicy): void {
    if (this.#controlledLayoutSettlePending) {
      this.#controlledLayoutSettlePending = false;
      this.#refreshControlledContentPolicy();
      if (this.#paused || this.#shadowReconciliationPending) return;
    }
    if (this.#visibilityBoundaryIndex) {
      const mutationRecords = this.#visibilityMutationRecords;
      const requiresFullRefresh = this.#visibilityFullRefreshPending ||
        this.#visibilityMutationOverflow ||
        this.#visibilityInteractionTargets.size > 0;
      // Either of the first two compares the whole page, the elements whose
      // held values changed with it.
      const visibilityRefresh = requiresFullRefresh
        ? this.#visibilityBoundaryIndex.refreshAll()
        : mutationRecords.length > 0
          ? this.#visibilityBoundaryIndex.refreshMutations(mutationRecords)
          : this.#visibilityBoundaryIndex.refreshWithin(
              [...this.#heldAnimationTargets],
            );
      this.#visibilityMutationRecords = [];
      this.#visibilityMutationOverflow = false;
      this.#visibilityFullRefreshPending = false;
      this.#visibilityInteractionTargets.clear();
      this.#heldAnimationTargets.clear();
      // Chrome gives a pane that is shown again its old scroll offset, with
      // no scroll event.
      for (
        const element of this.#visibilityBoundaryIndex.takeShownElements()
      ) this.#meetPane(element);
      this.#applyVisibilityBoundaryRefresh(visibilityRefresh);
      if (this.#paused || this.#shadowReconciliationPending) return;
    }
    if (this.#styleDerivedPending) {
      this.#styleDerivedPending = false;
      this.#readStyleDerivedAgain();
      if (this.#paused || this.#shadowReconciliationPending) return;
    }
    if (this.#imageRefreshRequested) {
      this.#imageRefreshRequested = false;
      this.#refreshChangedImageSources();
      if (this.#paused) return;
    }
    if (this.#takeLateShadowRoots()) return;
    // A change of slots first asks what it changes (the walk of the roots
    // is open around the whole flush).
    if (this.#queueChangedSlotReadings()) {
      this.#readAndPostInTurns(fidelityPolicy);
    }
    // A change to the page may have lengthened a scrolled pane, hidden it,
    // shown it again or put it back at its start, none of which fires a
    // scroll event, and it need not have made a patch: a pane taken out of
    // the page and put back where it was is reset by Chrome and changes
    // nothing the mirror holds. So after every change the reader hears of,
    // patch or no patch, the panes are read afresh, with the ones met
    // scrolled in what was just sent or shown, and reported if they are not
    // where they were (D122).
    this.#takeMetPanes();
    if (this.#scrolledPanes.size > 0) this.#postScroll(true);
  }

  /**
   * One frame's changes, in up to three patches sent as one message
   * (D143). A parent's changed list of children is sent as "these stay,
   * these are new" only when nothing else in the batch changed inside that
   * parent; otherwise every list in the batch is read again and sent whole.
   * Two kinds of change made that the rule, so each goes in a patch of its
   * own:
   *
   * - What was added to `<html>` itself or taken from it, first. Everything
   *   is inside `<html>`, and its whole list is the page, which the mirror
   *   refuses: a dialog put beside `<body>` with a scroll lock on `<body>`,
   *   the usual pair, had the page read afresh.
   * - The elements whose style sheet is sent again, last. A page that
   *   writes a style sheet while it adds elements (a part of a page loaded
   *   late, which brings its styles) had the `<head>` and every other
   *   changed list sent whole.
   * - What changed inside a child that stays of a list that changed too,
   *   last as well. A page that adds a view to `<body>` while a style
   *   sheet hides the old one, or adds a row while it writes into another,
   *   had the whole of `<body>` sent.
   *
   * A child that stays keeps what it holds, and what a later patch names
   * inside something an earlier one has just sent is found unchanged and
   * not sent twice. The page made these changes in one step, so the mirror
   * is given them in one message and applies them in one step: sent apart,
   * the panel drew the dialog before its styles had arrived.
   */
  #readAndPostInTurns(fidelityPolicy: SelectableReplicaFidelityPolicy): boolean {
    const patches: HtmlMirrorPatchBatch[] = [];
    for (const turn of ['document', 'lists', 'rest'] as const) {
      const held = turn === 'rest' ? undefined : this.#holdBack(turn);
      if (!held && turn !== 'rest') continue;
      const patch = this.#readChanges(fidelityPolicy);
      // The page is read afresh, or the stream has stopped: what was read
      // of this frame is not sent, and a whole read follows.
      if (this.#paused || this.#disposed) return false;
      if (patch) patches.push(patch);
      this.#takeBack(held, patch);
    }
    const frame = createHtmlMirrorPatchFrame(patches);
    if (!frame) return false;
    this.#sequence = frame.lastSequence;
    this.#post(frame);
    return true;
  }

  /**
   * Takes out of the pending changes what a later turn sends, and returns
   * it; nothing when this turn has nothing to send apart. `document`: all
   * but `<html>`'s own list. `lists`: when a list changes, the elements
   * whose sheet is sent again, and what changed inside a child of that
   * list that stays.
   */
  #holdBack(turn: 'document' | 'lists'): HeldChanges | undefined {
    const html = this.environment.document.documentElement;
    const dimensions = this.#pendingDimensions;
    if (turn === 'lists') {
      if (this.#pendingChildren.size === 0) return undefined;
      const held: HeldChanges = {
        children: [...this.#pendingChildren].filter(
          (node) => this.#changedInsideKeptChild(node),
        ),
        attributes: [...this.#pendingAttributes].filter(
          (node) => this.#changedInsideKeptChild(node),
        ),
        text: [...this.#pendingText].filter(
          (node) => this.#changedInsideKeptChild(node),
        ),
        sheets: [...this.#pendingSheets],
        // A slot's list is sent on the slot, as an attribute is.
        slotLists: [...this.#pendingSlotLists].filter(
          (node) => this.#changedInsideKeptChild(node),
        ),
        dimensions,
      };
      if (
        held.children.length + held.attributes.length + held.text.length +
          held.sheets.length + held.slotLists.length === 0
      ) return undefined;
      for (const node of held.children) this.#pendingChildren.delete(node);
      for (const node of held.attributes) this.#pendingAttributes.delete(node);
      for (const node of held.text) this.#pendingText.delete(node);
      for (const node of held.slotLists) this.#pendingSlotLists.delete(node);
      this.#pendingSheets.clear();
      this.#pendingDimensions = false;
      return held;
    }
    if (!html || !this.#pendingChildren.has(html)) return undefined;
    const held: HeldChanges = {
      children: [...this.#pendingChildren].filter((node) => node !== html),
      attributes: [...this.#pendingAttributes],
      text: [...this.#pendingText],
      sheets: [...this.#pendingSheets],
      slotLists: [...this.#pendingSlotLists],
      dimensions,
    };
    if (
      held.children.length + held.attributes.length + held.text.length +
        held.sheets.length + held.slotLists.length === 0
    ) return undefined;
    this.#pendingChildren.clear();
    this.#pendingAttributes.clear();
    this.#pendingText.clear();
    this.#pendingSheets.clear();
    this.#pendingSlotLists.clear();
    this.#pendingChildren.add(html);
    this.#pendingDimensions = false;
    return held;
  }

  /**
   * Whether `node` is, or is inside, a child that stays of a list that
   * changed too: the outermost such list above it. A dropdown is left out:
   * its list is read afresh when one of its groups changes, and the group
   * is queued beside it to say so (D132).
   */
  #changedInsideKeptChild(node: Node): boolean {
    let list: Node | undefined;
    let child: Node | undefined;
    for (let current: Node | undefined = node; current;) {
      const parent: Node | undefined = current.parentNode ??
        (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in current
          ? (current as ShadowRoot).host
          : undefined);
      if (parent && this.#pendingChildren.has(parent)) {
        list = parent;
        child = current;
      }
      current = parent;
    }
    return list !== undefined && child !== undefined &&
      this.#emittedParent.get(child) === list &&
      !sourceNativeSelectStructuralOwner(list);
  }

  /**
   * Puts back what was held for a later turn. `sent`: the patch read while
   * it was held. A list that patch sent whole holds every list inside it
   * as the page has it now, so those are not read a second time; an
   * element or a text inside it is read again and found unchanged.
   */
  #takeBack(held: HeldChanges | undefined, sent?: HtmlMirrorPatchBatch): void {
    if (!held) return;
    const sentWhole: Node[] = [];
    for (const operation of sent?.operations ?? []) {
      if (operation.kind !== 'children') continue;
      const target = this.environment.registry.getNode(operation.nodeId);
      if (target) sentWhole.push(target);
    }
    for (const node of held.children) {
      if (sentWhole.some((target) => containsComposedSource(target, node))) continue;
      this.#queuePending(this.#pendingChildren, node);
    }
    for (const node of held.attributes) this.#queuePending(this.#pendingAttributes, node);
    for (const node of held.text) this.#queuePending(this.#pendingText, node);
    for (const node of held.sheets) this.#queuePending(this.#pendingSheets, node);
    for (const node of held.slotLists) this.#pendingSlotLists.add(node);
    this.#pendingDimensions ||= held.dimensions;
  }

  /**
   * Reads what is pending into one patch, with the sequence the frame's
   * message will carry, and notes it as sent. Nothing when nothing changed,
   * or when the stream stopped instead.
   */
  #readChanges(
    fidelityPolicy: SelectableReplicaFidelityPolicy,
  ): HtmlMirrorPatchBatch | undefined {
    // An element whose sheet is sent again is sent as attributes are.
    for (const element of this.#pendingSheets) this.#pendingAttributes.add(element);
    this.#pendingSheets.clear();
    // A host whose children are read again while something inside its own
    // root changed too: a patch of the host's children does not carry the
    // root, so the root is read again whole, beside its host (D135; it was
    // the whole page, at every such change). A root the mirror does not
    // hold cannot be patched: the page is read afresh.
    for (const target of [...this.#pendingChildren]) {
      if (!this.#coversOwnShadowWork(target)) continue;
      const shadow = readSourceShadowRoot(target as Element);
      if (!shadow || !this.#mirroredNodes.has(shadow)) {
        this.#shadowReconciliationPending = true;
        this.#signalShadowReconciliation();
        return undefined;
      }
      this.#queuePending(this.#pendingChildren, shadow);
      if (this.#paused) return undefined;
    }
    const childrenTargets = minimizeConnectedComposedTargets(
      this.#pendingChildren,
    );
    const covered = (node: Node): boolean =>
      childrenTargets.some(
        (target) => target !== node && containsComposedSource(target, node),
      );
    const operations: HtmlMirrorPatchOperation[] = [];
    const representability = createHtmlMirrorRepresentabilityCollector();
    const batchBudget = createHtmlMirrorReadBudget();
    const styleWork = createHtmlMirrorStyleWorkBudget();
    // The whole sheet text of a style whose patch carries only what was
    // added to it: what is noted as sent for the element.
    const wholeSignatures = new Map<number, string>();
    try {
      // Nothing is sent for a node before every element above it, and
      // every element of a subtree read again, has been asked about its
      // root in this batch. A root attached since the last read records no
      // change; one found here turns the patch into a checkpoint (D125).
      const askedAbove = new Set<Node>();
      for (const targets of [
        this.#pendingChildren,
        this.#pendingAttributes,
        this.#pendingSlotLists,
        this.#pendingText,
      ] as Iterable<Node>[]) {
        for (const target of targets) {
          askAboutSourceShadowRootsAbove(target, askedAbove);
        }
      }
      if (this.#takeLateShadowRoots()) return undefined;
      const askedWithin = new Set<Node>();
      const withinBudget = { nodes: MAX_HTML_MIRROR_NODES };
      const askWithin = (sources: readonly Node[]): boolean => {
        for (const source of sources) {
          if (!askAboutSourceShadowRootsWithin(source, askedWithin, withinBudget)) {
            this.#shadowReconciliationPending = true;
            this.#signalShadowReconciliation();
            return false;
          }
        }
        return !this.#takeLateShadowRoots();
      };
      const childCaptures: Array<{
        readonly target: Node;
        readonly nodeId: number;
        readonly sources: readonly Node[];
        readonly previous: readonly Node[];
        readonly reconciliation: ReconciliationDecision;
      }> = [];
      for (const target of childrenTargets) {
        if (!target.isConnected || !this.#mirroredNodes.has(target)) continue;
        const sources = Object.freeze([...sourceStructuralChildNodes(target)]);
        childCaptures.push({
          target,
          nodeId: this.environment.registry.peekId(target) as number,
          sources,
          previous: this.#emittedChildren.get(target) ?? [],
          reconciliation: this.#reconciliationDecision(target, sources),
        });
      }
      // Cross-parent churn and covered descendant changes are intentionally
      // kept on the conservative replacement path for the whole structural
      // batch. This prevents a mixed batch from accidentally treating a move
      // as same-parent identity retention.
      for (const { reconciliation } of childCaptures) {
        if (reconciliation === 'reconcile') continue;
        incrementSourceRepresentability(representability, reconciliation);
      }
      const useReconciliation = childCaptures.every(
        ({ reconciliation }) => reconciliation === 'reconcile',
      );
      if (
        !useReconciliation &&
        childCaptures.some(({ target }) =>
          target === this.environment.document.documentElement)
      ) {
        // The whole list of `<html>`'s children is the page: the mirror
        // takes it only as a whole read (an element moved between `<html>`
        // and `<body>`, for one).
        this.#shadowReconciliationPending = true;
        this.#signalShadowReconciliation();
        return undefined;
      }
      if (!useReconciliation) {
        if (!askWithin(childCaptures.flatMap(({ sources }) => sources))) {
          return undefined;
        }
        for (const capture of childCaptures) {
          const children = sanitizeSourceChildren(
            capture.target,
            this.environment.registry,
            this.environment.document.baseURI,
            representability,
            fidelityPolicy,
            batchBudget,
            styleWork,
            this.#controlledContentPolicy,
            this.#slotReadings,
          );
          if (!children) throw new Error('Unsafe children patch.');
          const sources = children.map(
            (child) => this.environment.registry.getNode(child.id),
          );
          if (sources.some(
            (source) => !source || !isSourceStructuralChildOf(source, capture.target),
          )) throw new Error('Unstable children patch.');
          operations.push(Object.freeze({
            kind: 'children',
            nodeId: capture.nodeId,
            children,
          }));
        }
      } else {
        for (const capture of childCaptures) {
          const previous = new Set(capture.previous);
          const newSources = capture.sources.filter(
            (source) => !previous.has(source),
          );
          if (
            capture.target === this.environment.document.documentElement &&
            sourceDocumentShellChanged(capture.previous, capture.sources)
          ) {
            // The page's own head or body is another element now, or
            // `<html>` holds one more: the mirror keeps its own two in
            // place, so this is a whole read.
            this.#shadowReconciliationPending = true;
            this.#signalShadowReconciliation();
            return undefined;
          }
          if (!askWithin(newSources)) return undefined;
          const serialized = sanitizeSourceSubtrees(
            newSources,
            this.environment.registry,
            this.environment.document.baseURI,
            representability,
            batchBudget,
            styleWork,
            fidelityPolicy,
            this.#slotReadings,
          );
          if (!serialized) throw new Error('Unsafe new children patch.');
          const newGraphs = new Map<Node, import(
            './html-mirror-sanitizer'
          ).HtmlMirrorNode>();
          serialized.forEach((graph, index) => {
            if (!graph) return;
            const source = newSources[index]!;
            if (
              this.environment.registry.getNode(graph.id) !== source ||
              !isSourceStructuralChildOf(source, capture.target)
            ) throw new Error('Unstable new children patch.');
            newGraphs.set(source, graph);
          });
          const entries: HtmlMirrorReconcileChild[] = [];
          for (const source of capture.sources) {
            if (previous.has(source)) {
              const nodeId = this.environment.registry.peekId(source);
              if (
                !nodeId || !isSourceStructuralChildOf(source, capture.target) ||
                this.#emittedParent.get(source) !== capture.target
              ) throw new Error('Unstable retained child.');
              entries.push(Object.freeze({ kind: 'retain', nodeId }));
              continue;
            }
            const graph = newGraphs.get(source);
            if (graph) entries.push(Object.freeze({ kind: 'graph', node: graph }));
          }
          if (!reconciliationMatchesEmittedChildren(
            entries,
            capture.previous,
            this.environment.registry,
          )) {
            operations.push(Object.freeze({
              kind: 'reconcile-children',
              nodeId: capture.nodeId,
              children: Object.freeze(entries),
            }));
          }
        }
      }
      for (const target of new Set([
        ...this.#pendingAttributes,
        ...this.#pendingSlotLists,
      ])) {
        if (
          !target.isConnected || !this.#mirroredNodes.has(target) ||
          (this.#pendingAttributes.has(target)
            ? covered(target)
            : childrenTargets.some(
                (above) => readsSourceSlotAgain(above, target),
              ))
        ) continue;
        const attributes = sanitizeSourceAttributes(
          target,
          this.environment.document.baseURI,
          representability,
          fidelityPolicy,
          this.#controlledContentPolicy,
        );
        if (!attributes) throw new Error('Unsafe attributes patch.');
        const hints = sanitizeSourceElementHints(
          target,
          this.environment.document.baseURI,
          representability,
          fidelityPolicy,
          styleWork,
          this.#controlledContentPolicy,
          undefined,
          this.environment.registry,
        );
        if (target.localName.toLowerCase() === 'img') {
          this.#selectedImageSources.set(
            target,
            hints.selectedImageSource ?? '',
          );
        }
        if (
          hints.resolvedStyleSheetText === undefined &&
          this.#sheetTextStyles.has(target)
        ) {
          // The mirror holds this style by its sheet's text and the sheet
          // can no longer be read (the element's type changed, or the batch
          // is too large): its own text nodes were never sent, so the page
          // is read afresh.
          this.#shadowReconciliationPending = true;
          this.#signalShadowReconciliation();
          return undefined;
        }
        const operation = Object.freeze({
          kind: 'attributes',
          nodeId: this.environment.registry.peekId(target) as number,
          namespace: sourceElementNamespace(target),
          tagName: target.localName.toLowerCase(),
          attributes,
          ...hints,
        } as const);
        const signature = emittedElementSignature(operation);
        const sent = this.#emittedNodeSignatures.get(target);
        if (signature === sent) continue;
        // A page that adds rules by appending text to a `<style>` (rules
        // written one by one as parts of the page are drawn) had the whole
        // sheet sent at every append: what was added is sent, and the
        // mirror adds it to the text it holds (D143).
        const appended = operation.tagName === 'style' &&
            hints.resolvedStyleSheetText !== undefined
          ? appendedStyleSheetText(
              emittedStyleSheetText(sent),
              hints.resolvedStyleSheetText,
              fidelityPolicy,
            )
          : undefined;
        if (appended === undefined) {
          operations.push(operation);
          continue;
        }
        wholeSignatures.set(operation.nodeId, signature);
        operations.push(Object.freeze({
          ...operation,
          resolvedStyleSheetText: appended,
          resolvedStyleSheetTextFrom:
            (hints.resolvedStyleSheetText as string).length - appended.length,
        }));
      }
      for (const target of this.#pendingText) {
        if (
          !target.isConnected || covered(target) ||
          !this.#mirroredNodes.has(target)
        ) continue;
        const node = sanitizeSourceSubtree(
          target,
          this.environment.registry,
          this.environment.document.baseURI,
          representability,
          fidelityPolicy,
          this.#slotReadings,
        );
        if (!node || node.kind !== 'text') throw new Error('Unsafe text patch.');
        const operation = Object.freeze({
          kind: 'text',
          nodeId: node.id,
          node,
        } as const);
        if (
          emittedTextSignature(node) === this.#emittedNodeSignatures.get(target)
        ) continue;
        operations.push(operation);
      }
      let emittedDimensions:
        ReturnType<typeof readSourceDimensions> | undefined;
      if (this.#pendingDimensions) {
        const dimensions = readSourceDimensions(
          this.environment.document,
          this.environment.window,
        );
        if (!sameSourceDimensions(dimensions, this.#lastDimensions)) {
          emittedDimensions = dimensions;
          operations.push(Object.freeze({
            kind: 'dimensions',
            ...dimensions,
          }));
        }
      }
      // A root found while the patch was read: the replica lacks it.
      if (this.#takeLateShadowRoots()) return undefined;
      if (operations.length === 0) {
        this.#clearPending();
        return undefined;
      }
      // Every patch of a frame carries the sequence of the frame's message.
      const sequence = this.#sequence + 1;
      const batch = createHtmlMirrorPatch(
        this.#identityAt(sequence),
        sequence,
        sequence,
        operations,
        this.#summarizeRepresentability(representability),
        fidelityPolicy,
      );
      if (!batch) {
        incrementSourceRepresentability(
          representability,
          'capacityOmissionCount',
        );
        throw new HtmlMirrorCapacityError(true);
      }
      for (const operation of batch.operations) {
        if (operation.kind === 'children') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) this.#recordEmittedChildren(target, operation.children);
        } else if (operation.kind === 'reconcile-children') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) this.#recordReconciledChildren(target, operation.children);
        } else if (operation.kind === 'attributes') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) {
            this.#emittedNodeSignatures.set(
              target,
              wholeSignatures.get(operation.nodeId) ??
                emittedElementSignature(operation),
            );
            this.#noteSheetTextStyle(target, operation);
          }
        } else if (operation.kind === 'text') {
          const target = this.environment.registry.getNode(operation.nodeId);
          if (target) {
            this.#emittedNodeSignatures.set(
              target,
              emittedTextSignature(operation.node),
            );
          }
        }
      }
      this.#clearPending();
      if (emittedDimensions) this.#lastDimensions = emittedDimensions;
      return batch;
    } catch (error) {
      if (
        error instanceof HtmlMirrorCapacityError &&
        !error.diagnosticRecorded
      ) {
        incrementSourceRepresentability(
          representability,
          'capacityOmissionCount',
        );
      }
      this.#clearPending();
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        representability.capacityOmissionCount > 0
          ? 'stream_overflow'
          : 'privacy_rejected',
        this.#summarizeRepresentability(representability),
      ));
    }
    return undefined;
  }

  /**
   * Snapshots a batch's diagnostics and folds in the bounded, content-free
   * count of observation walks that ran out of budget since the last summary.
   * The collector itself stays untouched so its overflow decisions are not
   * affected by a deferred walk omission.
   */
  #summarizeRepresentability(
    representability: HtmlMirrorRepresentabilityCollector,
  ): HtmlMirrorRepresentabilitySummary {
    const omitted = this.#shadowObservationOmissionCount;
    this.#shadowObservationOmissionCount = 0;
    if (omitted === 0) return snapshotHtmlMirrorRepresentability(representability);
    return snapshotHtmlMirrorRepresentability({
      ...representability,
      capacityOmissionCount: Math.min(
        MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
        representability.capacityOmissionCount + omitted,
      ),
    });
  }

  #identityAt(sequence: number): ReplicaDocumentIdentity {
    const identity = this.#identity;
    if (!identity) throw new Error('HTML mirror session has no identity.');
    return createReplicaIdentity({
      sessionId: identity.sessionId,
      pageEpoch: identity.pageEpoch,
      generation: identity.generation,
      documentId: identity.documentId,
      frameId: identity.frameId,
      sequence,
    });
  }

  #post(message: unknown): void {
    if (this.#disposed) return;
    try {
      this.environment.port.postMessage(encodeHtmlMirrorWireMessage(message));
    } catch {
      this.dispose(false);
    }
  }

  #clearPending(): void {
    this.#pendingChildren.clear();
    this.#pendingAttributes.clear();
    this.#pendingText.clear();
    this.#pendingSheets.clear();
    this.#slotChanges.clear();
    this.#pendingSlotLists.clear();
    this.#pendingDimensions = false;
    this.#styleDerivedPending = false;
    this.#controlledLayoutSettlePending = false;
    this.#visibilityMutationRecords = [];
    this.#visibilityMutationOverflow = false;
    this.#visibilityInteractionTargets.clear();
    this.#visibilityFullRefreshPending = false;
  }

  readonly #onLayoutChange = (): void => {
    if (this.#disposed || !this.#identity) return;
    this.#lookForRootsAfterLayoutChange();
    this.#refreshControlledContentPolicy();
    this.#visibilityFullRefreshPending = true;
    this.#imageRefreshRequested = true;
    this.#pendingDimensions = true;
    this.#scheduleFlush();
    this.#postScroll();
  };

  /**
   * This walk is where an open root attached since shows: a root that
   * renders anything usually changes the layout. It asks about closed ones
   * too, at most once a discovery interval, and once more, the walk alone,
   * when an interval with a change in it ends: a root attached just after
   * the last fresh walk would otherwise wait for the rotation (D125).
   */
  #lookForRootsAfterLayoutChange(): void {
    const now = this.environment.now();
    const fresh = now - this.#lastFreshLayoutWalk >= SHADOW_DISCOVERY_INTERVAL_MS;
    if (fresh) {
      this.#lastFreshLayoutWalk = now;
    } else if (this.#trailingLayoutTimer === undefined) {
      this.#trailingLayoutTimer = this.environment.setTimer(() => {
        this.#trailingLayoutTimer = undefined;
        if (!this.#disposed && this.#identity) this.#lookForRootsAfterLayoutChange();
      }, SHADOW_DISCOVERY_INTERVAL_MS - (now - this.#lastFreshLayoutWalk));
    }
    const rootWalk = beginSourceShadowRootWalk({ fresh });
    try {
      this.#observeShadowRoots(this.environment.document.documentElement);
    } finally {
      rootWalk.end();
    }
  }

  readonly #onScroll = (event: Event): void => {
    if (this.#disposed || !this.#identity) return;
    // Inside a shadow root the window hears the event as the host's: the
    // element that scrolled is the first of the composed path. (A closed
    // root's path is whole only for the listener on that root itself.)
    const target = scrolledTarget(event);
    if (isDocumentScrollTarget(
      target,
      this.environment.document,
      this.environment.window,
    )) {
      this.#pendingDocumentScroll = true;
    } else if (target instanceof Element) {
      // Any other element is a pane that scrolls on its own (D122). Its
      // place is read once a frame, not once an event.
      if (this.#pendingPanes.size < MAX_HTML_MIRROR_SCROLL_PANES) {
        this.#pendingPanes.add(target);
      } else if (!this.#pendingPanes.has(target)) {
        this.#pendingPaneBurst = true;
      }
    } else {
      return;
    }
    this.#scheduleScroll();
  };

  readonly #onVisualViewportChange = (): void => {
    if (this.#disposed || !this.#identity) return;
    this.#scheduleScroll();
  };

  #scheduleScroll(): void {
    if (
      this.#disposed || !this.#identity || this.#scrollFrame !== undefined
    ) return;
    this.#scrollFrame = this.environment.scheduleFrame(() => {
      this.#scrollFrame = undefined;
      this.#postScroll(true, false, true);
    });
  }

  /**
   * Reports the document's place and the panes that moved. With
   * `wholeState` (a checkpoint: the replica is built anew) every pane that
   * is not at its start is listed; otherwise only the ones whose place is
   * no longer what the panel was told. With `onlyIfMoved`, for a frame of
   * scroll events or a posted patch, nothing is sent when nothing the mirror
   * follows moved (a text field scrolled, or an element the mirror does not
   * know). With `scrolledOnly`, for a frame of scroll events, only the
   * panes those events came from are read: a page with thousands of
   * scrolled panes pays for the one that moves.
   */
  #postScroll(
    onlyIfMoved = false,
    wholeState = false,
    scrolledOnly = false,
  ): void {
    if (this.#disposed || !this.#identity) return;
    const documentScroll = readDocumentScrollSnapshot(
      this.environment.document,
      this.environment.window,
    );
    const documentMoved = this.#lastDocumentScroll !== undefined &&
      (documentScroll.scrollX !== this.#lastDocumentScroll.scrollX ||
        documentScroll.scrollY !== this.#lastDocumentScroll.scrollY);
    // Ids the panel was told of, of panes that are followed no longer.
    const dropped: number[] = [];
    const scrolled = [...this.#pendingPanes];
    const burst = this.#pendingPaneBurst;
    if (burst) {
      // More elements scrolled in one frame than the mirror follows: rows
      // that a script keeps in step. Following a part of them would tear
      // them apart in the mirror, so none of them is followed.
      for (const pane of scrolled) this.#forgetPane(pane, dropped);
      // The events past the bound were not kept, so a pane followed before
      // that is no longer where the panel was told moved in this frame too.
      // It is one of them and is forgotten with them: left alone it would
      // stay at a place that is neither its start nor the tab's.
      for (const [pane, told] of this.#scrolledPanes) {
        if (!told) continue;
        const place = readPaneScrollPlace(pane, this.environment.document);
        if (
          !place || place.scrollX !== told.scrollX ||
          place.scrollY !== told.scrollY
        ) this.#forgetPane(pane, dropped);
      }
    } else {
      for (const pane of scrolled) {
        // Scrolled again: it is the most recent one now.
        const told = this.#scrolledPanes.get(pane);
        this.#scrolledPanes.delete(pane);
        this.#scrolledPanes.set(pane, told);
      }
    }
    this.#pendingPanes.clear();
    this.#pendingPaneBurst = false;

    // Past the bound the least recently scrolled are forgotten: the
    // replica's then go back to their start.
    for (const pane of this.#scrolledPanes.keys()) {
      if (this.#scrolledPanes.size <= MAX_HTML_MIRROR_SCROLL_PANES) break;
      this.#forgetPane(pane, dropped);
    }
    let whole = wholeState || this.#restatePanes;
    let panes = this.#readPanePlaces(
      whole || !scrolledOnly ? [...this.#scrolledPanes.keys()] : scrolled,
      whole,
      dropped,
    );
    if (panes.length > MAX_HTML_MIRROR_SCROLL_PANES) {
      // More moved than one message names: the whole list is shorter.
      whole = true;
      panes = this.#readPanePlaces([...this.#scrolledPanes.keys()], true, []);
    }

    // The last viewport-scale pane this frame's events came from, if any.
    let scrolledPrimaryPane: Element | undefined;
    if (!burst) {
      for (const pane of scrolled) {
        // A pane just read with no vertical range to speak of is not one,
        // and is not asked again: nearly every strip and carousel.
        const told = this.#scrolledPanes.get(pane);
        if (
          (!told || told.maxScrollY >= MIN_PRIMARY_PANE_RANGE) &&
          this.#isViewportScalePane(pane)
        ) scrolledPrimaryPane = pane;
      }
    }
    if (this.#pendingDocumentScroll) {
      this.#primaryPane = undefined;
    } else if (scrolledPrimaryPane) {
      this.#primaryPane = scrolledPrimaryPane;
    } else if (
      documentMoved ||
      (this.#primaryPane && !this.#isViewportScalePane(this.#primaryPane))
    ) {
      this.#primaryPane = undefined;
    }
    this.#lastDocumentScroll = documentScroll;
    this.#pendingDocumentScroll = false;
    // Named only while the panel has it listed: at its start it moves
    // nothing.
    const primaryPaneId = this.#primaryPane === undefined
      ? undefined
      : this.#scrolledPanes.get(this.#primaryPane)?.nodeId;
    const place = {
      scrollX: documentScroll.scrollX,
      scrollY: documentScroll.scrollY,
      maxScrollX: documentScroll.maxScrollX,
      maxScrollY: documentScroll.maxScrollY,
      ...readVisualViewportSnapshot(this.environment.window),
    };
    const reportedPlace = JSON.stringify(place);
    // No list when no pane moved: the panel keeps what it has, and a page
    // that only scrolls sends what it sent before there were panes.
    const withPanes = whole || panes.length > 0 ||
      primaryPaneId !== this.#lastReportedPrimaryPaneId;
    if (
      onlyIfMoved && !withPanes && reportedPlace === this.#lastReportedPlace
    ) return;
    const update = createHtmlMirrorScrollUpdate(
      this.#identityAt(this.#sequence),
      {
        ...place,
        ...(withPanes
          ? {
              [whole ? 'panes' : 'movedPanes']:
                groupHtmlMirrorScrollPanes(panes),
              ...(primaryPaneId !== undefined ? { primaryPaneId } : {}),
            }
          : {}),
      },
    );
    if (!update) {
      // What the panel was told is no longer what is noted here.
      this.#restatePanes = true;
      return;
    }
    this.#lastReportedPlace = reportedPlace;
    if (withPanes) this.#lastReportedPrimaryPaneId = primaryPaneId;
    if (whole) this.#restatePanes = false;
    this.#post(update);
  }

  #isViewportScalePane(pane: Element): boolean {
    return readNestedScrollSnapshot(
      pane,
      this.environment.document,
      this.environment.window,
    ) !== undefined;
  }

  /**
   * Reads the places of `panes` (D122) and returns the ones to name, each
   * by the id the mirror already holds for it: with `whole` every pane that
   * is not at its start, otherwise the ones whose place is not what the
   * panel was told, and each of `dropped`, and each pane that went back to
   * its start, with its offsets at 0. A withheld or secret shell, a text
   * field and a pane back at its start are forgotten until they scroll
   * again.
   */
  #readPanePlaces(
    panes: readonly Element[],
    whole: boolean,
    dropped: number[],
  ): HtmlMirrorPaneScroll[] {
    const named: HtmlMirrorPaneScroll[] = [];
    for (const pane of panes) {
      // Forgotten a moment ago: a burst, or the bound.
      if (!this.#scrolledPanes.has(pane)) continue;
      const told = this.#scrolledPanes.get(pane);
      const place = this.#mirroredOpaqueSecrets.has(pane)
        ? undefined
        : readPaneScrollPlace(pane, this.environment.document);
      if (!place) {
        this.#forgetPane(pane, dropped);
        continue;
      }
      if (place.scrollX === 0 && place.scrollY === 0) {
        // A hidden pane has no box and reads as at its start. Chrome gives
        // it its place back when it is shown again, with no scroll event, so
        // a pane that was listed is kept in mind while it has no box.
        if (
          !this.#listedPanes.has(pane) ||
          pane.clientWidth > 0 || pane.clientHeight > 0
        ) {
          this.#forgetPane(pane, dropped);
        } else if (told) {
          dropped.push(told.nodeId);
          this.#scrolledPanes.set(pane, undefined);
        }
        continue;
      }
      // A pane made and put at its place in one go can scroll before the
      // patch that carries it: the mirror holds no id for it yet. It sends
      // nothing, and is kept in mind for the report that follows the patch.
      const nodeId = this.#mirroredPaneId(pane);
      if (nodeId === undefined) {
        if (told) {
          dropped.push(told.nodeId);
          this.#scrolledPanes.set(pane, undefined);
        }
        continue;
      }
      this.#listedPanes.add(pane);
      if (
        whole || !told || told.nodeId !== nodeId ||
        told.scrollX !== place.scrollX || told.scrollY !== place.scrollY ||
        told.maxScrollX !== place.maxScrollX ||
        told.maxScrollY !== place.maxScrollY
      ) {
        const entry = Object.freeze({ nodeId, ...place });
        this.#scrolledPanes.set(pane, entry);
        named.push(entry);
      }
    }
    if (!whole) {
      for (const nodeId of dropped) {
        named.push(Object.freeze({
          nodeId, scrollX: 0, scrollY: 0, maxScrollX: 0, maxScrollY: 0,
        }));
      }
    }
    return named;
  }

  /** Follows `pane` no longer; the panel is told when it knew of it. */
  #forgetPane(pane: Element, dropped: number[]): void {
    const told = this.#scrolledPanes.get(pane);
    this.#scrolledPanes.delete(pane);
    if (told) dropped.push(told.nodeId);
  }

  /** The id the mirror holds for an element it shows; none is made here. */
  #mirroredPaneId(pane: Element): number | undefined {
    return this.#mirroredNodes.has(pane) &&
        !this.#mirroredOpaqueSecrets.has(pane)
      ? this.environment.registry.peekId(pane)
      : undefined;
  }

  /**
   * An element the page reader has just sent, or has just seen shown: when
   * it is not at its scroll start it may be a pane to follow, though no
   * scroll event told of it. A pane scrolled before the mirror was built
   * fired its events before anyone listened, and Chrome gives a pane that
   * is shown again its old offset back silently. Two number reads an
   * element, no style and no walk of its own: every element is met where
   * it is sent (`#markMirroredGraph`) or where the index of what the page
   * paints sees it get a box. Whether it is a pane the mirror follows is
   * decided where its place is read.
   */
  #meetPane(element: Element): void {
    if (
      (!element.scrollTop && !element.scrollLeft) ||
      this.#scrolledPanes.has(element)
    ) return;
    this.#metPanes.add(element);
  }

  /**
   * Keeps the panes met since the last report in mind, to be read with the
   * next one. When more were met than the mirror follows, none is taken, as
   * for a burst of scroll events: a part of a set of rows that scroll
   * together would show them torn apart. Each is then followed from its own
   * next scroll.
   */
  #takeMetPanes(): void {
    const met = this.#metPanes;
    if (met.size === 0) return;
    this.#metPanes = new Set<Element>();
    if (met.size > MAX_HTML_MIRROR_SCROLL_PANES) return;
    for (const pane of met) {
      if (!this.#scrolledPanes.has(pane)) this.#scrolledPanes.set(pane, undefined);
    }
  }

  readonly #onControlledLayoutSettle = (event: Event): void => {
    const target = event.target;
    if (
      this.#disposed || !this.#identity ||
      !target || typeof target !== 'object' ||
      (target as Node).nodeType !== 1
    ) return;
    const element = target as Element;
    this.#visibilityInteractionTargets.add(element);
    const controlledMayChange = this.#controlledContentPolicy &&
      sourceControlledContentLayoutMayChange(
        element,
        this.#controlledContentPolicy,
      );
    if (!controlledMayChange && !this.#visibilityBoundaryIndex) return;
    // A final transition/animation style can reveal or withdraw a selected
    // panel without another mutation. Refresh admission inside the same one
    // post-paint frame used for the resulting patch; bursts remain coalesced.
    this.#controlledLayoutSettlePending = Boolean(controlledMayChange);
    this.#pendingDimensions = true;
    this.#scheduleFlush();
  };

  readonly #onVisibilityInteraction = (event: Event): void => {
    const target = event.target;
    if (
      this.#disposed || !this.#identity ||
      !target || typeof target !== 'object' ||
      (target as Node).nodeType !== 1 ||
      !this.#visibilityBoundaryIndex
    ) return;
    this.#visibilityInteractionTargets.add(target as Element);
    this.#scheduleFlush();
  };

  /**
   * A script gave a slot other nodes (a root that assigns by hand, D135):
   * nothing else tells of it. The slot's list of nodes is sent, and what the
   * host holds is asked how it is read now.
   */
  readonly #onSlotChange = (event: Event): void => {
    const slot = event.target;
    if (
      this.#disposed || !this.#identity ||
      !slot || typeof slot !== 'object' || (slot as Node).nodeType !== 1
    ) return;
    const root = (slot as Element).getRootNode();
    if (!isSourceShadowRoot(root)) return;
    this.#pendingSlotLists.add(slot as Element);
    this.#slotsChanged(root);
  };

  /**
   * A slot was added to `root`, taken out of it, renamed or filled by a
   * script: its slots may take other nodes than they did. See
   * `#queueChangedSlotReadings`; what the page paints is compared afresh
   * too (D135).
   */
  #slotsChanged(root: ShadowRoot): void {
    this.#slotChanges.add(root);
    if (this.#visibilityBoundaryIndex) this.#visibilityFullRefreshPending = true;
    this.#scheduleFlush();
  }

  /**
   * What a host holds is read by the boxes around its slot: hidden, edited,
   * inside a control that acts. A slot that is added, removed, renamed or
   * filled by a script, and a child given another slot name, move nodes
   * between boxes, and most such moves change nothing of what is sent (a
   * slot that takes nothing, two slots that swap, a node moved from one
   * plain box to another). So each child is asked how it is read now, and
   * only one that is read otherwise than it last was is read again, as what
   * a box holds is when the box is shown or hidden. Reading them all again
   * sent the whole of a host at every slot its root recreated. False when
   * the page has to be read afresh.
   */
  #queueChangedSlotReadings(): boolean {
    if (this.#slotChanges.size === 0) return true;
    const children = new Set<Node>();
    for (const changed of this.#slotChanges) {
      if (isSourceShadowRoot(changed)) {
        for (const child of changed.host.childNodes) children.add(child);
      } else {
        children.add(changed);
      }
    }
    this.#slotChanges.clear();
    const walk = beginSourceSlotReadingWalk(
      this.#slotReadings,
      this.environment.document,
      this.#controlledContentPolicy,
    );
    const readOtherwise: Node[] = [];
    for (const child of children) {
      // What the mirror does not hold is never read again: not asked.
      if (
        this.#mirroredNodes.has(child) &&
        sourceSlotReadingChanged(child, walk)
      ) readOtherwise.push(child);
    }
    this.#queueSlotted(readOtherwise, true);
    for (const child of readOtherwise) {
      if (
        child.nodeType === Node.ELEMENT_NODE &&
        !this.#queueSlottedContent(child as Element)
      ) return false;
    }
    return true;
  }

  /**
   * Queues what of `nodes` the mirror holds to be read again: the text, and
   * with `elements` the elements too. Many of them are not read one by one:
   * the children of each host among their parents are read again in one
   * piece, with the host's root.
   */
  #queueSlotted(nodes: readonly Node[], elements: boolean): void {
    const wanted = nodes.filter((node) => this.#mirroredNodes.has(node) && (
      node.nodeType === Node.TEXT_NODE ||
      (elements && node.nodeType === Node.ELEMENT_NODE)
    ));
    if (wanted.length <= MAX_SLOTTED_NODES) {
      for (const node of wanted) {
        if (node.nodeType === Node.TEXT_NODE) {
          this.#queuePending(this.#pendingText, node as Text);
        } else {
          this.#queueVisibilityTarget(node as Element);
        }
      }
      return;
    }
    const hosts = new Set<Element>();
    for (const node of wanted) {
      const parent = node.parentNode;
      if (parent?.nodeType === Node.ELEMENT_NODE) hosts.add(parent as Element);
    }
    for (const host of hosts) {
      if (this.#mirroredNodes.has(host)) this.#queueVisibilityTarget(host);
    }
  }

  /** An element shown or hidden: it and what it holds are read again. */
  #queueVisibilityTarget(target: Element): void {
    if (target === this.environment.document.documentElement) {
      // `<html>` shown or hidden is the page shown or hidden: a whole read.
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return;
    }
    this.#queuePending(this.#pendingChildren, target);
    this.#queuePending(this.#pendingAttributes, target);
    // What a host's own root holds is hidden and shown with the host, and
    // a patch for the host's children does not carry it: the text of a
    // menu a web component shows by `:host([open])` never arrived (D132).
    const shadow = readSourceShadowRoot(target);
    if (shadow && this.#mirroredNodes.has(shadow)) {
      this.#queuePending(this.#pendingChildren, shadow);
    }
  }

  /**
   * What a shadow host holds is drawn in the slots of the host's root, so a
   * box of the root that is shown or hidden shows or hides what its slots
   * hold, none of which is inside the box: that is read again with it. The
   * index of what is painted counts it as inside the box too, not as a
   * change of its own (D135). What a slot holds may itself hold a slot of
   * the root it sits in (the panel one component hands to another: a
   * dropdown's menu is slotted into a panel, and the panel into a popup's
   * box); what that slot holds is drawn inside the box as well, and is
   * inside nothing the box holds, so each node found is looked through for
   * slots in turn. Only the tree is walked, never a text.
   */
  #queueSlottedContent(target: Element): boolean {
    try {
      const held = new Set<Node>();
      const boxes: Element[] = [target];
      while (boxes.length > 0) {
        const box = boxes.pop() as Element;
        const slots: Element[] = box.localName === 'slot' ? [box] : [];
        slots.push(...box.querySelectorAll('slot'));
        for (const slot of slots) {
          for (const node of (slot as HTMLSlotElement).assignedNodes?.({
            flatten: true,
          }) ?? []) {
            if (held.has(node)) continue;
            held.add(node);
            if (node.nodeType === Node.ELEMENT_NODE) boxes.push(node as Element);
          }
        }
      }
      this.#queueSlotted([...held], true);
      return true;
    } catch {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return false;
    }
  }

  readonly #onFontLoadingDone = (): void => this.#onLayoutChange();

  readonly #onCapturedResourceLoad = (event: Event): void => {
    this.#onLayoutChange();
    this.#queueCapturedImageAttributeRefresh(event);
  };

  readonly #onCapturedResourceError = (event: Event): void => {
    this.#onLayoutChange();
    this.#queueCapturedImageAttributeRefresh(event);
  };

  /**
   * A style sheet changed, and the page is not read afresh for it any more
   * (D143): what the reader takes from an element's style is taken again,
   * as that whole read took it. What is shown and what is hidden, to the
   * eye or at all, is compared by the index of what is painted, and the
   * page's size and canvas colour are read with the dimensions. Three
   * things are left, read here for every element the mirror holds:
   *
   * - Text the page masks (`-webkit-text-security`). An element whose text
   *   a sheet has just masked is in the mirror with that text; the mirror
   *   takes the shell that stands for it only in a whole read, so the page
   *   is read afresh, once.
   * - What an element holds that the page declares hidden (`hidden`,
   *   `aria-hidden="true"`): it is read while the element's box is really
   *   painted, which a sheet changes with no change of `display` or
   *   `visibility` (a box faded out, clipped away, or of no size). The
   *   element is read again with what it holds when the answer differs
   *   from the one it was sent with.
   * - What the mirror draws of a dropdown from the dropdown's own style,
   *   and whether a dropdown inside a menu the reader may open hides
   *   itself (D138): the dropdown is read again, and sent if that differs
   *   from what was sent.
   * - How each child of a shadow host is read, which comes from the boxes
   *   around its slot (D142): the host's root is noted as one whose slots
   *   may show other things, and each child is asked again.
   *
   * What an ended animation holds (D141) is listed with every flush and
   * needs nothing here.
   */
  #readStyleDerivedAgain(): void {
    const view = this.environment.window;
    const root = this.environment.document.documentElement;
    const pending: Element[] = root ? [root] : [];
    let inspected = 0;
    while (pending.length > 0) {
      const element = pending.pop() as Element;
      // What an opaque shell stands for is not in the mirror.
      if (this.#mirroredOpaqueSecrets.has(element)) continue;
      inspected += 1;
      const mirrored = this.#mirroredNodes.has(element);
      if (
        inspected > MAX_HTML_MIRROR_NODES || (
          mirrored && sourceStyleMasksText(element, view) &&
          hasSourceCredentialSecretAncestor(
            element,
            this.#secretClassifier(),
            view,
          )
        )
      ) {
        this.#shadowReconciliationPending = true;
        this.#signalShadowReconciliation();
        return;
      }
      if (mirrored && element.localName.toLowerCase() === 'select') {
        this.#queuePending(this.#pendingAttributes, element);
      }
      const withheld = mirrored ? this.#declaredHiddenSent.get(element) : undefined;
      if (
        withheld !== undefined && this.#controlledContentPolicy &&
        sourceDeclaredHiddenRegionIsWithheld(
          element,
          this.#controlledContentPolicy,
        ) !== withheld
      ) {
        // As a box the index of what is painted finds shown or hidden.
        this.#queueVisibilityTarget(element);
        if (!this.#queueSlottedContent(element)) return;
      }
      for (
        let child = element.lastElementChild;
        child;
        child = child.previousElementSibling
      ) pending.push(child);
      const shadow = readSourceShadowRoot(element);
      if (shadow && this.#mirroredNodes.has(shadow)) {
        // How a child of the host is read comes from the boxes around its
        // slot in this root, which a sheet restyles: each child is asked
        // again, and read again if it is read otherwise than it was (D142).
        this.#slotChanges.add(shadow);
        for (
          let child = shadow.lastElementChild;
          child;
          child = child.previousElementSibling
        ) pending.push(child);
      }
    }
  }

  #refreshControlledContentPolicy(): boolean {
    const previous = this.#controlledContentPolicy;
    if (!previous) return false;
    const next = createSourceControlledContentPolicy(
      this.environment.document,
      this.environment.window,
      MAX_HTML_MIRROR_NODES,
    );
    this.#controlledContentPolicy = next;
    if (sourceControlledContentBoundaryChanged(previous, next)) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return true;
    }
    const changed = sourceControlledContentChangedTargets(previous, next);
    for (const panel of changed) {
      this.#queuePending(this.#pendingChildren, panel);
      this.#queuePending(this.#pendingAttributes, panel);
    }
    return changed.length > 0;
  }

  #applyVisibilityBoundaryRefresh(
    refresh: SourceVisibilityBoundaryRefresh,
  ): boolean {
    if (refresh.overflow) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return true;
    }
    // A remote selector change (a sibling's attribute through `~` or `:has()`)
    // can paint a selected panel without touching any participant, so no
    // mutation record refreshed the controlled-content policy. Re-admit the
    // panel before it is re-emitted, or the retained policy would still
    // sanitize it as withheld and leave it blank.
    const policy = this.#controlledContentPolicy;
    let accepted = false;
    if (
      policy &&
      refresh.changedTargets.some((target) =>
        sourceControlledContentLayoutMayChange(target, policy))
    ) {
      accepted = this.#refreshControlledContentPolicy();
      if (this.#shadowReconciliationPending) return true;
    }
    for (const target of refresh.changedTargets) {
      this.#queueVisibilityTarget(target);
      if (!this.#queueSlottedContent(target)) return true;
    }
    return accepted || refresh.changedTargets.length > 0;
  }

  #scheduleFlush(evenWithNothingPending = false): void {
    if (this.#paused || this.#frame !== undefined || this.#disposed) return;
    if (
      !evenWithNothingPending &&
      this.#pendingChildren.size === 0 &&
      this.#pendingAttributes.size === 0 &&
      this.#pendingText.size === 0 &&
      this.#pendingSheets.size === 0 &&
      !this.#pendingDimensions &&
      !this.#styleDerivedPending &&
      !this.#controlledLayoutSettlePending &&
      this.#visibilityMutationRecords.length === 0 &&
      !this.#visibilityMutationOverflow &&
      !this.#visibilityFullRefreshPending &&
      this.#visibilityInteractionTargets.size === 0 &&
      this.#lateShadowRoots.length === 0 &&
      this.#heldChanged.size === 0
    ) return;
    this.#frame = this.environment.scheduleFrame(() => {
      this.#frame = undefined;
      this.#flush();
    });
  }

  #queuePending<T extends Node>(targets: Set<T>, target: T): void {
    if (this.#pendingOverflow) return;
    if (targets.has(target)) return;
    const size = this.#pendingChildren.size + this.#pendingAttributes.size +
      this.#pendingText.size + this.#pendingSheets.size;
    if (size >= MAX_HTML_MIRROR_PENDING_TARGETS) {
      this.#clearPending();
      this.#pendingOverflow = true;
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'stream_overflow',
      ));
      return;
    }
    targets.add(target);
  }

  #secretClassifier(): StickySourceSecretClassifier {
    return this.environment.secretClassifier ??
      sourceDocumentSecretClassifier(this.environment.document);
  }

  #markMirroredGraph(node: import('./html-mirror-sanitizer').HtmlMirrorNode): void {
    const source = this.environment.registry.getNode(node.id);
    if (source) {
      this.#mirroredNodes.add(source);
      this.#emittedNodeSignatures.set(
        source,
        node.kind === 'text'
          ? emittedTextSignature(node)
          : emittedElementSignature(node),
      );
      if (node.kind === 'element') {
        this.#noteSheetTextStyle(source, node);
        this.#noteDeclaredHidden(source);
      }
      if (source instanceof Element) {
        // A credential input is mirrored as an empty field (D76) and, like
        // an opaque shell, is refreshed only by a fresh structural read.
        if (
          node.kind === 'element' && (
            node.opaquePlaceholder === true ||
            (node.tagName === 'input' && this.#secretClassifier().isSecret(source))
          )
        ) {
          this.#mirroredOpaqueSecrets.add(source);
        }
        this.#registerShadowHostCandidate(source);
        // Sent now: scrolled already, it is a pane no event told of.
        this.#meetPane(source);
        if (node.kind === 'element' && node.tagName === 'img') {
          this.#registerMirroredImageCandidate(
            source,
            node.selectedImageSource ?? '',
          );
        }
      }
    }
    if (node.kind === 'text') return;
    if (node.shadowRoot) {
      const shadow = this.environment.registry.getNode(node.shadowRoot.id);
      if (shadow) {
        this.#mirroredNodes.add(shadow);
        this.#adoptedStyleSignatures.prime(
          shadow,
          adoptedStyleSignature(node.shadowRoot.adoptedStyleSheets),
        );
        // Every mirrored root is observed here, while the graph is still
        // bounded by the sanitizer's own capacity, so the budgeted DOM walk
        // only has to find roots the emitted graph does not carry.
        if (isSourceShadowRoot(shadow)) this.#observeShadowRoot(shadow);
      }
      for (const child of node.shadowRoot.children) this.#markMirroredGraph(child);
      if (shadow) this.#setEmittedChildren(shadow, node.shadowRoot.children);
    }
    for (const child of node.children) this.#markMirroredGraph(child);
    if (source) this.#setEmittedChildren(source, node.children);
  }

  /** Keeps `#sheetTextStyles` in step with what was last sent for `source`. */
  #noteSheetTextStyle(
    source: Node,
    sent: Pick<HtmlMirrorElementNode, 'tagName' | 'resolvedStyleSheetText'>,
  ): void {
    if (sent.tagName !== 'style') return;
    if (sent.resolvedStyleSheetText !== undefined) {
      this.#sheetTextStyles.add(source as Element);
    } else {
      this.#sheetTextStyles.delete(source as Element);
    }
  }

  /**
   * Notes, for an element the page declares hidden, whether what it holds
   * is withheld, when the element is sent with what it holds.
   */
  #noteDeclaredHidden(source: Node): void {
    const policy = this.#controlledContentPolicy;
    if (!policy || source.nodeType !== Node.ELEMENT_NODE) return;
    const withheld = sourceDeclaredHiddenRegionIsWithheld(source as Element, policy);
    if (withheld === undefined) this.#declaredHiddenSent.delete(source as Element);
    else this.#declaredHiddenSent.set(source as Element, withheld);
  }

  #recordEmittedChildren(
    target: Node,
    children: readonly import('./html-mirror-sanitizer').HtmlMirrorNode[],
  ): void {
    this.#noteDeclaredHidden(target);
    for (const child of children) this.#markMirroredGraph(child);
    this.#setEmittedChildren(target, children);
  }

  #recordReconciledChildren(
    target: Node,
    children: readonly HtmlMirrorReconcileChild[],
  ): void {
    for (const child of children) {
      if (child.kind === 'graph') this.#markMirroredGraph(child.node);
    }
    const sources = children.map((child) => this.environment.registry.getNode(
      child.kind === 'retain' ? child.nodeId : child.node.id,
    ));
    if (sources.some((source) => !source)) {
      throw new Error('Reconciled source node is unavailable.');
    }
    this.#setEmittedSourceChildren(target, sources as Node[]);
  }

  #setEmittedChildren(
    target: Node,
    children: readonly import('./html-mirror-sanitizer').HtmlMirrorNode[],
  ): void {
    const sources: Node[] = [];
    for (const child of children) {
      const source = this.environment.registry.getNode(child.id);
      if (source) sources.push(source);
    }
    this.#setEmittedSourceChildren(target, sources);
  }

  #setEmittedSourceChildren(target: Node, sources: readonly Node[]): void {
    const previous = this.#emittedChildren.get(target) ?? [];
    const next = new Set(sources);
    for (const child of previous) {
      if (!next.has(child) && this.#emittedParent.get(child) === target) {
        this.#emittedParent.delete(child);
      }
    }
    for (const child of sources) this.#emittedParent.set(child, target);
    this.#emittedChildren.set(target, Object.freeze(sources));
  }

  #reconciliationDecision(
    target: Node,
    children: readonly Node[],
  ): ReconciliationDecision {
    const previous = this.#emittedChildren.get(target);
    if (!previous) return 'missingReconciliationProofFallbackCount';
    if (this.#pendingAttributes.has(target as Element)) {
      return 'attributeContextFallbackCount';
    }
    const previousSet = new Set(previous);
    // Something else that changed inside a child that stays would be lost,
    // so the list is read again whole. Inside a child that is new it is
    // read with that child (D143): an element added empty and filled in the
    // same frame, the usual way to add a `<style>`, had its parent's whole
    // list sent, the `<head>` with every sheet in it.
    const added = new Set(children.filter((child) => !previousSet.has(child)));
    const changesKeptChild = (values: Iterable<Node>): boolean => {
      for (const value of values) {
        if (value === target) continue;
        const holder = composedChildHolding(target, value);
        if (holder && !added.has(holder)) return true;
      }
      return false;
    };
    if (
      changesKeptChild(this.#pendingChildren) ||
      changesKeptChild(this.#pendingAttributes) ||
      changesKeptChild(this.#pendingText)
    ) return 'coveredDirtyBranchFallbackCount';
    // A slot below whose list is to be sent comes with it, read again.
    for (const slot of this.#pendingSlotLists) {
      if (readsSourceSlotAgain(target, slot)) {
        return 'coveredDirtyBranchFallbackCount';
      }
    }

    for (const child of children) {
      if (!previousSet.has(child)) continue;
      if (
        this.environment.registry.peekId(child) === undefined ||
        this.#emittedParent.get(child) !== target
      ) return 'missingReconciliationProofFallbackCount';
    }
    const newRoots = children.filter((child) => !previousSet.has(child));
    const incomingSources = collectLiveSubtreeNodes(newRoots);
    if (!incomingSources) return 'missingReconciliationProofFallbackCount';
    for (const current of incomingSources) {
      const oldParent = this.#emittedParent.get(current);
      // A currently-emitted node whose prior parent is outside this new graph
      // would collide with receiver state. Internal parents are allowed for a
      // whole subtree that was removed in an earlier emitted batch and is now
      // being reinserted as a graph.
      if (oldParent && !incomingSources.has(oldParent)) {
        return 'crossParentFallbackCount';
      }
    }
    return 'reconcile';
  }

  #coversOwnShadowWork(target: Node): boolean {
    if (target.nodeType !== Node.ELEMENT_NODE) return false;
    const shadow = readSourceShadowRoot(target as Element);
    if (!shadow) return false;
    // The root itself is read again, beside its host (D132).
    if (this.#pendingChildren.has(shadow)) return false;
    return iterableContainsComposedSource(this.#pendingChildren, shadow) ||
      iterableContainsComposedSource(this.#pendingAttributes, shadow) ||
      iterableContainsComposedSource(this.#pendingText, shadow);
  }

  #registerShadowHostCandidate(element: Element): void {
    if (
      this.#knownShadowHostCandidates.has(element) ||
      this.#settledShadowHostCandidates.has(element)
    ) return;
    // Only an element the page can attach a root to waits for one (D125):
    // a custom element or one of the tags `attachShadow` allows.
    if (!canHostAuthorShadowRoot(element)) return;
    if (readSourceShadowRoot(element)) {
      // A host's shadow root cannot be detached or replaced. Its existing root
      // is captured by the checkpoint walk, so only unresolved hosts belong in
      // the periodic late-attachment discovery rotation.
      this.#settledShadowHostCandidates.add(element);
      return;
    }
    if (this.#shadowHostCandidates.length >= MAX_HTML_MIRROR_NODES) {
      this.#compactShadowHostCandidates();
    }
    if (this.#shadowHostCandidates.length >= MAX_HTML_MIRROR_NODES) return;
    this.#knownShadowHostCandidates.add(element);
    this.#shadowHostCandidates.push(element);
  }

  #registerMirroredImageCandidate(element: Element, selectedSource: string): void {
    this.#selectedImageSources.set(element, selectedSource);
    if (this.#knownMirroredImageCandidates.has(element)) return;
    if (
      this.#mirroredImageCandidates.length >= MAX_MIRRORED_IMAGE_CANDIDATES
    ) this.#compactMirroredImageCandidates();
    if (
      this.#mirroredImageCandidates.length >= MAX_MIRRORED_IMAGE_CANDIDATES
    ) return;
    this.#knownMirroredImageCandidates.add(element);
    this.#mirroredImageCandidates.push(element);
  }

  #compactMirroredImageCandidates(): void {
    const retained = this.#mirroredImageCandidates.filter(
      (element) => element.isConnected && this.#mirroredNodes.has(element),
    );
    this.#mirroredImageCandidates = retained;
    this.#knownMirroredImageCandidates = new WeakSet(retained);
  }

  #refreshChangedImageSources(): void {
    this.#compactMirroredImageCandidates();
    for (const image of this.#mirroredImageCandidates) {
      let selectedSource: string;
      try {
        selectedSource = sanitizeSourceElementHints(
          image,
          this.environment.document.baseURI,
          undefined,
          this.#fidelityPolicy ?? 'conservative',
          undefined,
          this.#controlledContentPolicy,
        ).selectedImageSource ?? '';
      } catch {
        continue;
      }
      if (selectedSource === this.#selectedImageSources.get(image)) continue;
      this.#queuePending(this.#pendingAttributes, image);
      if (this.#pendingOverflow) return;
    }
  }

  /**
   * An image that has loaded or failed is read again: its picture may be
   * another. So is a `<link>`: a linked style sheet's rules are not there
   * when the element is added, and are sent, on the element, as soon as
   * they are (D143). The style poll would find them 1.5 s later.
   */
  #queueCapturedImageAttributeRefresh(event: Event): void {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !CAPTURED_RESOURCE_ELEMENTS.has(target.localName.toLowerCase()) ||
      !belongsToSourceDocument(target, this.environment.document) ||
      !target.isConnected ||
      !this.#mirroredNodes.has(target)
    ) return;
    if (target.localName.toLowerCase() === 'link') {
      this.#queuePending(this.#pendingSheets, target);
      this.#styleDerivedPending = true;
    } else {
      this.#queuePending(this.#pendingAttributes, target);
    }
    this.#pendingDimensions = true;
    this.#scheduleFlush();
  }

  #observeImageEvents(root: Document | ShadowRoot): void {
    if (this.#imageEventRoots.has(root)) return;
    if (this.#imageEventRoots.size >= MAX_IMAGE_EVENT_ROOTS) {
      this.#compactImageEventRoots();
    }
    if (this.#imageEventRoots.size >= MAX_IMAGE_EVENT_ROOTS) return;
    this.#imageEventRoots.add(root);
    root.addEventListener('load', this.#onCapturedResourceLoad, true);
    root.addEventListener('error', this.#onCapturedResourceError, true);
    root.addEventListener('scroll', this.#onScroll, true);
    // A root that assigns its slots by hand: no mutation tells of it, only
    // the slot's own event, which does not leave the root. Where the browser
    // assigns by name every change is a mutation (see `#queueMutationRecords`).
    if ((root as Partial<ShadowRoot>).slotAssignment === 'manual') {
      root.addEventListener('slotchange', this.#onSlotChange, true);
    }
  }

  #compactImageEventRoots(): void {
    for (const root of this.#imageEventRoots) {
      if (root === this.environment.document || ('host' in root && root.host.isConnected)) {
        continue;
      }
      root.removeEventListener('load', this.#onCapturedResourceLoad, true);
      root.removeEventListener('error', this.#onCapturedResourceError, true);
      root.removeEventListener('scroll', this.#onScroll, true);
      root.removeEventListener('slotchange', this.#onSlotChange, true);
      this.#imageEventRoots.delete(root);
    }
  }

  #compactShadowHostCandidates(): void {
    const retained = this.#shadowHostCandidates.filter(
      (element) =>
        element.isConnected &&
        this.#mirroredNodes.has(element) &&
        !this.#settledShadowHostCandidates.has(element),
    );
    this.#shadowHostCandidates = retained;
    this.#knownShadowHostCandidates = new WeakSet(retained);
    this.#shadowDiscoveryCursor = retained.length === 0
      ? 0
      : this.#shadowDiscoveryCursor % retained.length;
  }

  #scheduleShadowDiscovery(): void {
    if (this.#disposed || this.#shadowDiscoveryTimer !== undefined) return;
    this.#shadowDiscoveryTimer = this.environment.setTimer(() => {
      this.#shadowDiscoveryTimer = undefined;
      this.#discoverNewShadowRoots();
      this.#scheduleShadowDiscovery();
    }, SHADOW_DISCOVERY_INTERVAL_MS);
  }

  #discoverNewShadowRoots(): void {
    if (this.#pendingOverflow || this.#paused) return;
    if (this.#shadowReconciliationPending) return;
    const candidateCount = this.#shadowHostCandidates.length;
    if (candidateCount > 0) {
      let processed = 0;
      let asked = 0;
      let compact = false;
      while (processed < candidateCount && asked < MAX_SHADOW_HOSTS_PER_TICK) {
        const index = (this.#shadowDiscoveryCursor + processed) % candidateCount;
        const element = this.#shadowHostCandidates[index];
        processed += 1;
        if (!element?.isConnected || !this.#mirroredNodes.has(element)) {
          // A removed element is dropped, not charged to the tick: on a page
          // that replaces its content, removed ones used to take most of
          // each tick and a new root waited for many rounds (D125).
          compact = true;
          continue;
        }
        asked += 1;
        // Nothing fires when a root is attached. An open one shows on the
        // element; for a closed one Chrome is asked again, a bounded number
        // of elements a tick (D125).
        const shadow = probeSourceShadowRoot(element);
        if (!shadow) continue;
        this.#settledShadowHostCandidates.add(element);
        compact = true;
        this.#observeShadowRoot(shadow);
        if (this.#shadowReconciliationPending) return;
      }
      this.#shadowDiscoveryCursor =
        (this.#shadowDiscoveryCursor + processed) % candidateCount;
      if (compact) this.#compactShadowHostCandidates();
    }
    this.#lookForHeldAnimations();
    this.#pollStyleChanges();
  }

  /**
   * Nothing tells that a script starts an animation, or lets go of what one
   * holds. With the reader's other periodic work the page's animations are
   * listed, so that one a timer started while nothing else happened is met,
   * and what it holds after its end is read: within half a second on a page
   * where something happened lately, and within `MAX_HELD_LOOK_WAIT` half
   * seconds on one that has been at rest (see `#heldLook`).
   */
  #lookForHeldAnimations(): void {
    const look = this.#heldLook;
    look.in -= 1;
    if (look.in > 0) return;
    const pass = beginSourceHeldAnimationPass(
      this.environment.document,
      false,
      this.environment.now,
    );
    try {
      this.#listHeldAnimations(pass);
    } finally {
      pass.end();
    }
    // A look that changes nothing doubles the wait; the flush that one
    // which found something asks for brings it back to half a second.
    look.every = Math.min(look.every * 2, MAX_HELD_LOOK_WAIT);
    look.in = look.every;
    if (this.#heldChanged.size > 0) this.#scheduleFlush();
  }

  #adoptedStylesChanged(
    owner: Document | ShadowRoot,
    work: HtmlMirrorStyleWorkBudget,
  ): StylePollResult {
    const styles = sanitizeSourceAdoptedStyleSheets(
      owner,
      this.environment.document.baseURI,
      work,
      undefined,
      this.#fidelityPolicy ?? 'conservative',
    );
    if (!styles) return work.exhausted ? 'capacity' : 'unchanged';
    const signature = adoptedStyleSignature(styles);
    return this.#adoptedStyleSignatures.observe(owner, signature)
      ? 'changed'
      : 'unchanged';
  }

  /**
   * `changed` asks for the whole page. A change in sheets whose `<style>`
   * or `<link>` elements the mirror holds does not: those elements are read
   * again (D143).
   */
  #ordinaryStylesChanged(
    owner: Document | ShadowRoot,
    work: HtmlMirrorStyleWorkBudget,
  ): StylePollResult {
    const read = ordinaryStyleSignature(owner, work, budgetUnused(work));
    if (read.kind === 'capacity') return 'capacity';
    const signature = read.signature;
    if (signature === undefined) return 'unchanged';
    // The first look at an owner is what the mirror holds of it.
    const settled = this.#ordinaryStyleSignatures.has(owner)
      ? this.#ordinaryStyleSheets.get(owner)
      : undefined;
    const changed = this.#ordinaryStyleSignatures.observe(owner, signature);
    if (changed || !settled) this.#ordinaryStyleSheets.set(owner, read.sheets ?? []);
    if (!changed) return 'unchanged';
    return settled && this.#rereadChangedStyleSheets(settled, read.sheets ?? [])
      ? 'unchanged'
      : 'changed';
  }

  /**
   * A sheet changed with no change to the page's tree: a script added or
   * took out a rule through the sheet's own interface, a linked sheet
   * arrived, a sheet was switched off (D88). The element that owns each
   * changed sheet is read again, as a whole read would read it, and sent
   * if that differs from what the mirror was last sent: a `<style>` whose
   * text changed has travelled with that change already. What is shown may
   * have changed with the sheet, as after a resize. False when a changed
   * sheet has no element the mirror holds: only a whole read can tell.
   */
  #rereadChangedStyleSheets(
    settled: readonly OrdinaryStyleSheetRead[],
    current: readonly OrdinaryStyleSheetRead[],
  ): boolean {
    const known = new Map(settled.map(({ owner, signature }) => [owner, signature]));
    const changed: Element[] = [];
    for (const { owner, signature } of current) {
      if (known.get(owner) === signature) continue;
      if (
        !(owner instanceof Element) || !owner.isConnected ||
        !this.#mirroredNodes.has(owner) || this.#mirroredOpaqueSecrets.has(owner)
      ) return false;
      changed.push(owner);
    }
    for (const element of changed) {
      this.#queuePending(this.#pendingSheets, element);
    }
    // Also when a sheet is only gone: its rules no longer apply.
    this.#styleDerivedPending = true;
    this.#onLayoutChange();
    return true;
  }

  #primeOrdinaryStyleSignatures(): void {
    const owners = this.#styleOwners();
    if (owners.length === 0) return;
    const work = this.#createStylePollingBudget();
    const scanCount = Math.min(
      owners.length,
      MAX_SHADOW_HOSTS_PER_TICK + 1,
    );
    let processed = 0;
    for (let offset = 0; offset < scanCount; offset += 1) {
      const index = (this.#stylePollingCursor + offset) % owners.length;
      const owner = owners[index]!;
      processed += 1;
      const read = ordinaryStyleSignature(owner, work, budgetUnused(work));
      if (read.kind === 'signature' && read.signature !== undefined) {
        this.#ordinaryStyleSignatures.prime(owner, read.signature);
        this.#ordinaryStyleSheets.set(owner, read.sheets ?? []);
      }
      if (read.kind === 'capacity') break;
    }
    this.#stylePollingCursor =
      (this.#stylePollingCursor + processed) % owners.length;
  }

  #pollStyleChanges(): void {
    this.#stylePollingPass += 1;
    const owners = this.#styleOwners();
    if (owners.length === 0) return;
    const work = this.#createStylePollingBudget();
    const scanCount = Math.min(
      owners.length,
      MAX_SHADOW_HOSTS_PER_TICK + 1,
    );
    let processed = 0;
    for (let offset = 0; offset < scanCount; offset += 1) {
      const index = (this.#stylePollingCursor + offset) % owners.length;
      const owner = owners[index]!;
      processed += 1;
      const firstChannel = this.#stylePollingPhases.get(owner) ?? 'ordinary';
      const channels = [
        firstChannel,
        oppositeStylePollChannel(firstChannel),
      ] as const;
      for (const channel of channels) {
        const wasCapacity = ((this.#styleCapacityChannels.get(owner) ?? 0) &
          stylePollChannelMask(channel)) !== 0;
        if (wasCapacity && this.#styleCapacityRetryPending(owner, channel)) {
          continue;
        }
        const channelStartedWithUnusedBudget = work.sheets === 0 &&
          work.rules === 0 && work.characters === 0;
        const result = channel === 'ordinary'
          ? this.#ordinaryStylesChanged(owner, work)
          : this.#adoptedStylesChanged(owner, work);
        if (result === 'changed' || (wasCapacity && result === 'unchanged')) {
          this.#clearStyleCapacity(owner, channel);
          this.#stylePollingPhases.set(
            owner,
            oppositeStylePollChannel(channel),
          );
          this.#advanceStylePollingCursor(processed, owners.length);
          this.#shadowReconciliationPending = true;
          this.#signalShadowReconciliation();
          return;
        }
        if (result === 'capacity') {
          // Retry the channel that could not fit first on the owner's next
          // turn. This prevents a large ordinary sheet from permanently
          // starving adopted sheets (and vice versa).
          this.#stylePollingPhases.set(owner, channel);
          this.#advanceStylePollingCursor(processed, owners.length);
          if (channelStartedWithUnusedBudget) {
            this.#suppressOversizedStyleChannel(owner, channel);
          }
          return;
        }
        this.#clearStyleCapacity(owner, channel);
      }
      this.#stylePollingPhases.set(
        owner,
        oppositeStylePollChannel(firstChannel),
      );
    }
    this.#advanceStylePollingCursor(processed, owners.length);
  }

  #styleOwners(): readonly (Document | ShadowRoot)[] {
    this.#compactImageEventRoots();
    return [...this.#imageEventRoots].filter((root) =>
      root === this.environment.document ||
      ('host' in root && root.host.isConnected && this.#mirroredNodes.has(root))
    );
  }

  #createStylePollingBudget(): HtmlMirrorStyleWorkBudget {
    return createHtmlMirrorStyleWorkBudget({
      maxSheets: MAX_STYLE_SHEETS_PER_TICK,
      maxRules: MAX_STYLE_RULES_PER_TICK,
      maxCharacters: MAX_STYLE_CHARACTERS_PER_TICK,
    });
  }

  #advanceStylePollingCursor(processed: number, ownerCount: number): void {
    this.#stylePollingCursor = ownerCount === 0
      ? 0
      : (this.#stylePollingCursor + processed) % ownerCount;
  }

  #clearStyleCapacity(
    owner: Document | ShadowRoot,
    channel: StylePollChannel,
  ): void {
    const next = (this.#styleCapacityChannels.get(owner) ?? 0) &
      ~stylePollChannelMask(channel);
    if (next === 0) {
      this.#styleCapacityChannels.delete(owner);
      this.#styleCapacityRetryPasses.delete(owner);
    } else {
      this.#styleCapacityChannels.set(owner, next);
      const retries = this.#styleCapacityRetryPasses.get(owner) ?? [0, 0];
      this.#styleCapacityRetryPasses.set(
        owner,
        channel === 'ordinary'
          ? [0, retries[1]]
          : [retries[0], 0],
      );
    }
  }

  #styleCapacityRetryPending(
    owner: Document | ShadowRoot,
    channel: StylePollChannel,
  ): boolean {
    const retries = this.#styleCapacityRetryPasses.get(owner);
    const retryPass = retries?.[channel === 'ordinary' ? 0 : 1] ??
      Number.MAX_SAFE_INTEGER;
    return this.#stylePollingPass < retryPass;
  }

  #suppressOversizedStyleChannel(
    owner: Document | ShadowRoot,
    channel: StylePollChannel,
  ): void {
    const mask = stylePollChannelMask(channel);
    const reported = this.#styleCapacityChannels.get(owner) ?? 0;
    this.#styleCapacityChannels.set(owner, reported | mask);
    const retries = this.#styleCapacityRetryPasses.get(owner) ?? [0, 0];
    const retryPass = this.#stylePollingPass + OVERSIZED_STYLE_RETRY_PASSES;
    this.#styleCapacityRetryPasses.set(
      owner,
      channel === 'ordinary'
        ? [retryPass, retries[1]]
        : [retries[0], retryPass],
    );
  }

  #createShadowObservationWalk(): ShadowObservationWalk {
    return {
      visited: new WeakSet<Node>(),
      remaining: MAX_SHADOW_OBSERVATION_NODES,
      exhausted: false,
    };
  }

  /**
   * Iterative and bounded: a hostile DOM depth must not overflow the stack
   * inside the MutationObserver callback, and one oversized subtree must not
   * stall the page. Subtrees already covered by the same walk are skipped.
   * Once the node budget is spent the walk stops and records one bounded,
   * content-free capacity omission for the next representability summary
   * instead of stopping silently; mirrored roots are observed as their graph
   * is marked, so the budget only defers the discovery of unmirrored roots.
   */
  #observeShadowRoots(
    root: Node,
    walk: ShadowObservationWalk = this.#createShadowObservationWalk(),
  ): void {
    const stack: Node[] = [root];
    while (stack.length > 0) {
      const node = stack.pop() as Node;
      if (walk.visited.has(node)) continue;
      if (walk.remaining === 0) {
        if (!walk.exhausted) {
          walk.exhausted = true;
          this.#shadowObservationOmissionCount = Math.min(
            MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
            this.#shadowObservationOmissionCount + 1,
          );
        }
        return;
      }
      walk.remaining -= 1;
      walk.visited.add(node);
      this.#shadowObservationVisitCount += 1;
      if (isSourceShadowRoot(node)) this.#observeShadowRoot(node);
      if (node.nodeType === Node.ELEMENT_NODE) {
        const shadow = readSourceShadowRoot(node as Element);
        if (shadow) {
          this.#observeShadowRoot(shadow);
          for (let child = shadow.lastChild; child; child = child.previousSibling) {
            stack.push(child);
          }
        }
      }
      for (let child = node.lastChild; child; child = child.previousSibling) {
        stack.push(child);
      }
    }
  }

  #observeShadowRoot(shadow: ShadowRoot): void {
    this.#observeImageEvents(shadow);
    if (!this.#observedShadowRoots.has(shadow)) {
      this.#observedShadowRoots.add(shadow);
      // The same options as for the document (D125).
      this.#observer?.observe(shadow, SOURCE_SECRET_RECORD_OPTIONS);
    }
    if (this.#mirroredNodes.has(shadow)) return;
    if (this.#notingUnheldShadowRoots) {
      this.#unheldShadowRoots.add(shadow);
      return;
    }
    if (this.#unheldShadowRoots.has(shadow)) return;
    this.#shadowReconciliationPending = true;
    this.#signalShadowReconciliation();
  }

  /**
   * Hands the closed roots found since on elements read before without one
   * to `#observeShadowRoot`: the replica lacks them, so a checkpoint follows
   * and nothing read beside them is sent (D125). True when it does.
   */
  #takeLateShadowRoots(): boolean {
    const roots = this.#lateShadowRoots;
    if (roots.length === 0) return false;
    this.#lateShadowRoots = [];
    for (const shadow of roots) this.#observeShadowRoot(shadow);
    return this.#shadowReconciliationPending;
  }

  #signalShadowReconciliation(): void {
    if (
      this.#disposed ||
      !this.#identity ||
      !this.#shadowReconciliationPending ||
      this.#paused
    ) return;
    this.#paused = true;
    if (this.#frame !== undefined) this.environment.cancelFrame(this.#frame);
    this.#frame = undefined;
    this.#clearPending();
    // A checkpoint is the bounded, already-validated reconciliation path for
    // adding a ShadowRoot to an existing host graph. The client requests it
    // after this recoverable signal and keeps the last-good replica visible.
    this.#post(createHtmlMirrorError(
      this.#identityAt(this.#sequence),
      'stream_gap',
    ));
  }
}

function sourceElementNamespace(element: Element): HtmlMirrorNamespace {
  if (element.namespaceURI === 'http://www.w3.org/2000/svg') return 'svg';
  if (element.namespaceURI === 'http://www.w3.org/1998/Math/MathML') {
    return 'mathml';
  }
  return 'html';
}

function sourceMutationOwnerElement(node: Node): Element | undefined {
  if (node instanceof Element) return node;
  if (isSourceShadowRoot(node)) return node.host;
  return node.parentElement ?? undefined;
}

/**
 * Hashes of recently signed sheet texts. Every shadow root of a web component
 * adopts the same sheets, so one poll would otherwise hash the same text once
 * per root (tens of megabytes on Reddit's feed, D84).
 */
const STYLE_TEXT_HASHES = new Map<string, readonly [number, number]>();
const MAX_STYLE_TEXT_HASHES = 256;

function styleTextHash(cssText: string): readonly [number, number] {
  const known = STYLE_TEXT_HASHES.get(cssText);
  if (known) return known;
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let index = 0; index < cssText.length; index += 1) {
    const code = cssText.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ code) >>> 0;
  }
  if (STYLE_TEXT_HASHES.size >= MAX_STYLE_TEXT_HASHES) STYLE_TEXT_HASHES.clear();
  const hash = [fnv, djb] as const;
  STYLE_TEXT_HASHES.set(cssText, hash);
  return hash;
}

function adoptedStyleSignature(styles: readonly string[]): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  let characters = 0;
  for (let sheetIndex = 0; sheetIndex < styles.length; sheetIndex += 1) {
    const cssText = styles[sheetIndex] as string;
    const [sheetFnv, sheetDjb] = styleTextHash(cssText);
    fnv = Math.imul(fnv ^ sheetFnv, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ sheetDjb) >>> 0;
    characters += cssText.length;
    fnv = Math.imul(fnv ^ (sheetIndex + 1), 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ (sheetIndex + 1)) >>> 0;
  }
  return `${styles.length}:${characters}:${fnv}:${djb}`;
}

type OrdinaryStyleSignatureRead = Readonly<{
  kind: 'signature';
  signature: string | undefined;
  /** An owner's read only: each sheet on its own, in the owner's order. */
  sheets?: readonly OrdinaryStyleSheetRead[];
}> | Readonly<{
  kind: 'capacity';
}>;

/** One sheet of an owner: the node that owns it (or the sheet) and its state. */
type OrdinaryStyleSheetRead = Readonly<{ owner: object; signature: string }>;

function budgetUnused(work: HtmlMirrorStyleWorkBudget): boolean {
  return work.sheets === 0 && work.rules === 0 && work.characters === 0;
}

/**
 * `shapeOnOverflow`: the owner's read started with the whole budget, so a
 * sheet that does not fit is watched by its shape (D95) rather than failing
 * the pass. Without it, the owner is retried with a fresh budget next turn.
 */
function ordinaryStyleSignature(
  owner: Document | ShadowRoot,
  work: HtmlMirrorStyleWorkBudget,
  shapeOnOverflow = false,
): OrdinaryStyleSignatureRead {
  let sheets: ArrayLike<CSSStyleSheet>;
  try {
    sheets = (owner as Document & {
      readonly styleSheets: ArrayLike<CSSStyleSheet>;
    }).styleSheets;
  } catch {
    return Object.freeze({ kind: 'signature', signature: undefined });
  }
  if (!sheets) {
    return Object.freeze({ kind: 'signature', signature: undefined });
  }
  const sheetCount = sheets.length;
  if (
    !Number.isSafeInteger(sheetCount) ||
    sheetCount < 0
  ) return Object.freeze({ kind: 'signature', signature: undefined });
  if (work.sheets + sheetCount > work.maxSheets) {
    work.exhausted = true;
    return Object.freeze({ kind: 'capacity' });
  }
  const parts: string[] = [];
  const read: OrdinaryStyleSheetRead[] = [];
  const visited = new Set<object>();
  for (let index = 0; index < sheetCount; index += 1) {
    const sheet = sheets[index];
    if (!sheet) continue;
    work.sheets += 1;
    let disabled = false;
    let media = '';
    let owner: object = sheet;
    try {
      disabled = sheet.disabled === true;
      media = sheet.media?.mediaText ?? '';
      owner = sheet.ownerNode ?? sheet;
    } catch {
      parts.push(`${index}:unreadable`);
      read.push(Object.freeze({ owner, signature: 'unreadable' }));
      continue;
    }
    const rules = cssomRuleSignature(sheet, work, visited, 0, shapeOnOverflow);
    if (rules.kind === 'capacity') return rules;
    const state = `${disabled ? 1 : 0}:${media}:${rules.signature}`;
    parts.push(`${index}:${state}`);
    read.push(Object.freeze({ owner, signature: state }));
  }
  return Object.freeze({
    kind: 'signature',
    signature: adoptedStyleSignature(parts),
    sheets: Object.freeze(read),
  });
}

function cssomRuleSignature(
  sheet: CSSStyleSheet,
  work: HtmlMirrorStyleWorkBudget,
  visited: Set<object>,
  depth: number,
  shapeOnOverflow: boolean,
): OrdinaryStyleSignatureRead {
  if (depth > 8 || visited.has(sheet)) {
    return Object.freeze({ kind: 'signature', signature: 'cycle' });
  }
  visited.add(sheet);
  try {
    const rules = sheet.cssRules;
    const ruleCount = rules.length;
    if (
      !Number.isSafeInteger(ruleCount) ||
      ruleCount < 0
    ) return Object.freeze({ kind: 'signature', signature: 'unreadable' });
    if (
      ruleCount > MAX_FULL_SIGNATURE_RULES_PER_SHEET ||
      SHAPE_SIGNATURE_SHEETS.has(sheet)
    ) {
      SHAPE_SIGNATURE_SHEETS.add(sheet);
      return cssomShapeSignature(rules, ruleCount, work, shapeOnOverflow);
    }
    if (work.rules + ruleCount > work.maxRules) {
      if (shapeOnOverflow) {
        SHAPE_SIGNATURE_SHEETS.add(sheet);
        return cssomShapeSignature(rules, ruleCount, work, true);
      }
      work.exhausted = true;
      return Object.freeze({ kind: 'capacity' });
    }
    const startRules = work.rules;
    const startCharacters = work.characters;
    const parts: string[] = [];
    for (let index = 0; index < ruleCount; index += 1) {
      const rule = rules[index] ?? rules.item(index);
      if (!rule || typeof rule.cssText !== 'string') {
        return Object.freeze({ kind: 'signature', signature: 'unreadable' });
      }
      if (
        work.characters - startCharacters + rule.cssText.length >
          MAX_FULL_SIGNATURE_CHARACTERS_PER_SHEET
      ) {
        // Too large to reread each pass: watch its shape from now on, and
        // give back what this read spent so the other sheets still fit.
        SHAPE_SIGNATURE_SHEETS.add(sheet);
        work.rules = startRules;
        work.characters = startCharacters;
        return cssomShapeSignature(rules, ruleCount, work, shapeOnOverflow);
      }
      if (work.characters + rule.cssText.length > work.maxCharacters) {
        if (shapeOnOverflow) {
          SHAPE_SIGNATURE_SHEETS.add(sheet);
          work.rules = startRules;
          work.characters = startCharacters;
          return cssomShapeSignature(rules, ruleCount, work, true);
        }
        work.exhausted = true;
        return Object.freeze({ kind: 'capacity' });
      }
      work.rules += 1;
      work.characters += rule.cssText.length;
      const imported = (rule as CSSRule & {
        readonly styleSheet?: CSSStyleSheet | null;
      }).styleSheet;
      if (!imported) {
        parts.push(rule.cssText);
        continue;
      }
      const nested = cssomRuleSignature(
        imported,
        work,
        visited,
        depth + 1,
        shapeOnOverflow,
      );
      if (nested.kind === 'capacity') return nested;
      parts.push(`${rule.cssText}:${nested.signature ?? 'unavailable'}`);
    }
    return Object.freeze({
      kind: 'signature',
      signature: adoptedStyleSignature(parts),
    });
  } catch {
    return Object.freeze({ kind: 'signature', signature: 'unreadable' });
  } finally {
    visited.delete(sheet);
  }
}

/**
 * The shape of a large sheet: its rule count and its first and last rules,
 * each read up to a bounded length. Inserting or deleting rules, which is
 * how scripts change a sheet, changes it.
 */
function cssomShapeSignature(
  rules: CSSRuleList,
  ruleCount: number,
  work: HtmlMirrorStyleWorkBudget,
  unbudgeted: boolean,
): OrdinaryStyleSignatureRead {
  const ends = ruleCount === 0
    ? []
    : ruleCount === 1 ? [0] : [0, ruleCount - 1];
  const parts = [`shape:${ruleCount}`];
  for (const index of ends) {
    const rule = rules[index] ?? rules.item(index);
    if (!rule || typeof rule.cssText !== 'string') {
      return Object.freeze({ kind: 'signature', signature: 'unreadable' });
    }
    const text = rule.cssText.slice(0, MAX_SHALLOW_SIGNATURE_RULE_CHARACTERS);
    if (!unbudgeted) {
      if (
        work.rules + 1 > work.maxRules ||
        work.characters + text.length > work.maxCharacters
      ) {
        work.exhausted = true;
        return Object.freeze({ kind: 'capacity' });
      }
      work.rules += 1;
      work.characters += text.length;
    }
    parts.push(`${rule.cssText.length}:${text}`);
  }
  return Object.freeze({
    kind: 'signature',
    signature: adoptedStyleSignature(parts),
  });
}

function collectLiveSubtreeNodes(
  roots: readonly Node[],
): ReadonlySet<Node> | undefined {
  try {
    const sources = new Set<Node>();
    const stack = [...roots];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (sources.has(current)) continue;
      if (sources.size >= MAX_HTML_MIRROR_NODES) return undefined;
      sources.add(current);
      if (current.nodeType === Node.ELEMENT_NODE) {
        const shadow = readSourceShadowRoot(current as Element);
        if (shadow) stack.push(shadow);
      }
      stack.push(...current.childNodes);
    }
    return sources;
  } catch {
    return undefined;
  }
}

/**
 * Whether reading the children of `target` again reads `slot` again, with
 * the list of nodes a script gave it. Not for the slot's own host: its
 * children are replaced and its root stays where it is, so the slot's list
 * is sent beside them. The root, or anything above the host, takes the slot
 * with it.
 */
function readsSourceSlotAgain(target: Node, slot: Element): boolean {
  const root = slot.getRootNode();
  return !(isSourceShadowRoot(root) && root.host === target) &&
    target !== slot && containsComposedSource(target, slot);
}

function containsComposedSource(ancestor: Node, descendant: Node): boolean {
  for (let current: Node | undefined = descendant; current;) {
    if (current === ancestor) return true;
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in current) {
      current = (current as ShadowRoot).host;
      continue;
    }
    const root = current.getRootNode();
    current = root !== current && root.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      'host' in root
      ? (root as ShadowRoot).host
      : undefined;
  }
  return false;
}

/**
 * The child of `ancestor`, or its shadow root, that holds `descendant` (or
 * is it); none when `descendant` is not inside `ancestor`.
 */
function composedChildHolding(ancestor: Node, descendant: Node): Node | undefined {
  for (let current: Node | undefined = descendant; current;) {
    const parent: Node | undefined = current.parentNode ??
      (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in current
        ? (current as ShadowRoot).host
        : undefined);
    if (parent === ancestor) return current;
    current = parent;
  }
  return undefined;
}

function reconciliationMatchesEmittedChildren(
  entries: readonly HtmlMirrorReconcileChild[],
  previous: readonly Node[],
  registry: WeakNodeIdRegistry,
): boolean {
  return entries.length === previous.length && entries.every((entry, index) =>
    entry.kind === 'retain' && registry.peekId(previous[index]!) === entry.nodeId);
}

function emittedElementSignature(
  element: Pick<HtmlMirrorElementNode,
    | 'namespace'
    | 'tagName'
    | 'attributes'
    | 'visuallyHidden'
    | 'selectedImageSource'
    | 'selectedOptionIndexes'
    | 'selectPickerOpen'
    | 'selectPresentationStyle'
    | 'controlText'
    | 'canvasBackgroundColor'
    | 'resolvedStyleSheetText'
    | 'customElementDefined'
    | 'assignedNodeIds'
  >,
): string {
  const controlText = element.controlText;
  return JSON.stringify([
    element.namespace,
    element.tagName,
    element.attributes,
    element.visuallyHidden === true,
    element.selectedImageSource ?? null,
    element.selectedOptionIndexes ?? null,
    element.selectPickerOpen === true,
    element.selectPresentationStyle ?? null,
    controlText
      ? [controlText.kind, controlText.text, controlText.translatable]
      : null,
    element.canvasBackgroundColor ?? null,
    element.resolvedStyleSheetText ?? null,
    element.customElementDefined === true,
    element.assignedNodeIds ?? null,
  ]);
}

/** The sheet text in what was last sent for an element, if it had one. */
function emittedStyleSheetText(signature: string | undefined): string | undefined {
  if (signature === undefined) return undefined;
  const sheetText = (JSON.parse(signature) as unknown[])[10];
  return typeof sheetText === 'string' ? sheetText : undefined;
}

/**
 * Whether the element's own style masks its text. The reader's rule for
 * what is secret decides; this is the one input of it that a style sheet
 * changes, read alone because it is read for every element.
 */
function sourceStyleMasksText(element: Element, view: Window): boolean {
  try {
    if (typeof view.getComputedStyle !== 'function') return false;
    const masking = view.getComputedStyle(element)
      .getPropertyValue('-webkit-text-security').trim().toLowerCase();
    return masking !== '' && masking !== 'none';
  } catch {
    // A style that cannot be read is taken as masking, as the rule takes it.
    return true;
  }
}

function emittedTextSignature(
  text: Readonly<{ text: string; translatable: boolean }>,
): string {
  return JSON.stringify([text.text, text.translatable]);
}

function sameSourceDimensions(
  current: ReturnType<typeof readSourceDimensions>,
  previous: ReturnType<typeof readSourceDimensions> | undefined,
): boolean {
  return Boolean(
    previous &&
    current.viewportWidth === previous.viewportWidth &&
    current.viewportHeight === previous.viewportHeight &&
    current.documentWidth === previous.documentWidth &&
    current.documentHeight === previous.documentHeight &&
    current.canvasBackgroundColor === previous.canvasBackgroundColor
  );
}

function incrementSourceRepresentability(
  target: HtmlMirrorRepresentabilityCollector,
  key: keyof HtmlMirrorRepresentabilityCollector,
): void {
  target[key] = Math.min(
    MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
    target[key] + 1,
  );
}

/** Finds the DOM owner even while its privacy role is changing. */
function sourceNativeSelectStructuralOwner(node: Node): Element | undefined {
  let current = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement ?? undefined;
  for (; current; current = composedSourceParentElement(current)) {
    const tagName = current.localName.toLowerCase();
    if (tagName === 'datalist') return undefined;
    if (tagName === 'select') return current;
  }
  return undefined;
}

/**
 * The shadow root whose slots a mutation adds, removes or renames, if any.
 * Only the kind of each node is read.
 */
function sourceMutationChangesSlots(record: MutationRecord): ShadowRoot | undefined {
  const target = record.target;
  let changes = false;
  if (record.type === 'attributes') {
    changes = record.attributeName === 'name' && target.nodeType === 1 &&
      (target as Element).localName === 'slot';
  } else if (record.type === 'childList') {
    const holdsSlot = (node: Node): boolean => node.nodeType === 1 && (
      (node as Element).localName === 'slot' ||
      (node as Element).querySelector('slot') !== null
    );
    for (const node of record.addedNodes) changes ||= holdsSlot(node);
    for (const node of record.removedNodes) changes ||= holdsSlot(node);
  }
  if (!changes) return undefined;
  const root = target.getRootNode();
  return isSourceShadowRoot(root) ? root : undefined;
}

/**
 * The `<style>` element whose own text a mutation changes, if any: a sheet
 * is made of the text nodes straight inside its element.
 */
function sourceMutationStyleElement(record: MutationRecord): Element | undefined {
  const holder = record.type === 'childList'
    ? record.target
    : record.type === 'characterData' ? record.target.parentNode : null;
  return holder?.nodeType === 1 &&
      (holder as Element).localName.toLowerCase() === 'style'
    ? holder as Element
    : undefined;
}

/**
 * Whether `<html>` has another head or body than it had: its own (the first
 * of each) is another element or gone, or it holds one more. One of several
 * taken out leaves the page's own in place.
 */
function sourceDocumentShellChanged(
  previous: readonly Node[],
  current: readonly Node[],
): boolean {
  const named = (node: Node, name: string): boolean => node.nodeType === 1 &&
    (node as Element).namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    (node as Element).localName === name;
  const known = new Set(previous);
  for (const name of ['head', 'body']) {
    if (
      previous.find((node) => named(node, name)) !==
        current.find((node) => named(node, name)) ||
      current.some((node) => named(node, name) && !known.has(node))
    ) return true;
  }
  return false;
}

/** Whether a mutation adds, removes or changes nothing but text nodes. */
function sourceMutationChangesTextOnly(record: MutationRecord): boolean {
  if (record.type === 'characterData') return true;
  if (record.type !== 'childList') return false;
  for (const node of record.addedNodes) if (node.nodeType !== 3) return false;
  for (const node of record.removedNodes) if (node.nodeType !== 3) return false;
  return true;
}

/**
 * Whether `target`, inside the dropdown `select`, may hold options or groups
 * of it: a group, or a wrapper around some (`<select><div><option>`), with
 * nothing but those between it and the dropdown.
 */
function holdsSourceNativeSelectEntries(target: Element, select: Element): boolean {
  let current: Element | null = target;
  for (let depth = 0; current && depth <= 32; depth += 1) {
    if (current === select) return true;
    if (
      current.localName.toLowerCase() !== 'optgroup' &&
      !isSourceSelectWrapper(current)
    ) return false;
    current = current.parentElement;
  }
  return false;
}

function composedSourceParentElement(element: Element): Element | undefined {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === 11 && 'host' in root
    ? (root as ShadowRoot).host
    : undefined;
}

/** Whether Chrome may have read a content-language pragma because of `record`. */
function sourceMutationReadsPragma(record: MutationRecord): boolean {
  if (record.type === 'attributes') return isSourceMetaElement(record.target);
  if (record.type !== 'childList') return false;
  for (const added of record.addedNodes) {
    if (
      isSourceMetaElement(added) ||
      (added.nodeType === 1 && (added as Element).querySelector?.('meta'))
    ) return true;
  }
  return false;
}

function isSourceMetaElement(node: Node): boolean {
  return node.nodeType === 1 &&
    (node as Element).localName.toLowerCase() === 'meta';
}

function belongsToSourceDocument(node: Node, sourceDocument: Document): boolean {
  return node === sourceDocument || node.ownerDocument === sourceDocument;
}

/** What a scroll event scrolled, also when it is retargeted to a shadow host. */
function scrolledTarget(event: Event): EventTarget | null {
  try {
    const first = typeof event.composedPath === 'function'
      ? event.composedPath()[0]
      : undefined;
    if (first) return first;
  } catch {
    // Fall back to the event's own target.
  }
  return event.target;
}

function iterableContainsComposedSource(
  values: Iterable<Node>,
  root: Node,
  excluded?: Node,
): boolean {
  for (const value of values) {
    if (value !== excluded && containsComposedSource(root, value)) return true;
  }
  return false;
}

function readSourceDimensions(document: Document, window: Window): {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  canvasBackgroundColor?: string;
} {
  const html = document.documentElement;
  const body = document.body;
  const viewportWidth = Math.max(1, Math.round(window.innerWidth || html?.clientWidth || 1));
  const viewportHeight = Math.max(1, Math.round(window.innerHeight || html?.clientHeight || 1));
  const canvasBackgroundColor = html
    ? sanitizeSourceElementHints(html, document.baseURI).canvasBackgroundColor
    : undefined;
  return {
    viewportWidth,
    viewportHeight,
    documentWidth: Math.max(
      viewportWidth,
      html?.scrollWidth ?? 0,
      body?.scrollWidth ?? 0,
    ),
    documentHeight: Math.max(
      viewportHeight,
      html?.scrollHeight ?? 0,
      body?.scrollHeight ?? 0,
    ),
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
  };
}

// Kept in the emitted bundle as an artifact marker even after minification.
export const HTML_MIRROR_RUNTIME_MARKER = HTML_MIRROR_PORT_PREFIX;
