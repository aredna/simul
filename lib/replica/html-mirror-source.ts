import {
  sourceAttributeList,
  sourceCall,
  sourceChildNodeList,
  sourceLocalName,
  sourceNodeType,
  sourceProperty,
} from './source-node-accessors';
import { ImageSourceSession } from '../ocr/image-source-session';
import { readImageSourcePortSessionId } from '../ocr/image-source-protocol';
import { SourceImageObserver } from '../ocr/source-image-observer';
import type { ReplicaDocumentIdentity } from './contracts';
import {
  HTML_MIRROR_PANE_BOXES_VERSION,
  HTML_MIRROR_PORT_PREFIX,
  MAX_HTML_MIRROR_PANE_BOXES,
  MAX_HTML_MIRROR_SCROLL_PANES,
  MAX_HTML_MIRROR_UNACKED_BATCHES,
  HtmlMirrorCheckpointAssembly,
  createHtmlMirrorCheckpoint,
  createHtmlMirrorCheckpointPart,
  createHtmlMirrorError,
  createHtmlMirrorPatch,
  createHtmlMirrorPatchFrame,
  createHtmlMirrorScrollUpdate,
  groupHtmlMirrorScrollPanes,
  encodeHtmlMirrorWireMessage,
  readHtmlMirrorControllerMessage,
  readHtmlMirrorPortSessionId,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPaneBox,
  type HtmlMirrorPaneBoxes,
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
  MAX_HTML_MIRROR_BYTES,
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
  beginSourceDocumentRead,
  sanitizeSourceAdoptedStyleSheets,
  sanitizeSourceAttributes,
  sanitizeSourceChildren,
  sanitizeSourceDocument,
  sanitizeSourceElementHints,
  sanitizeSourcePreview,
  sanitizeSourceSubtree,
  sanitizeSourceSubtrees,
  sourceDeclaredHiddenRegionIsWithheld,
  beginSourceSlotReadingWalk,
  beginSourceWithheldAncestorWalk,
  createSourceSlotReadings,
  noteSourceEditingTarget,
  sourceSlotReadingChanged,
  snapshotHtmlMirrorRepresentability,
  sourceStructuralChildNodes,
  type HtmlMirrorCheckpointFill,
  type HtmlMirrorIdRegistry,
  type HtmlMirrorElementNode,
  type HtmlMirrorNamespace,
  type HtmlMirrorRepresentabilityCollector,
  type HtmlMirrorRepresentabilitySummary,
  type HtmlMirrorStyleWorkBudget,
  boundedDimension,
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
  readSourceAnimationListing,
} from './source-held-animation';
import { readSemanticSourcePortIdentity } from './semantic-source-protocol';
import { learnSourceSheetBase } from './source-sheet-base';
import {
  SOURCE_EVIDENCE_ATTRIBUTE_FILTER,
  SemanticSourceSession,
  eagerlyClassifySourceDocumentSubtree,
  noteSemanticSourceStyleSheetChange,
  rememberSourceMutationSecrets,
  startSourceDocumentSecretScan,
  type SourceDocumentSecretScan,
} from './semantic-source-session';
import {
  createPassShareLedger,
  createSliceClock,
  LIVE_SLICE_BUDGET_MS,
  yieldToMain,
  type PassShareLedger,
  type SliceClock,
} from '../browser-scheduling';
import {
  sourceDocumentSecretClassifier,
  type StickySourceSecretClassifier,
} from './source-secret-classifier';
import {
  beginSourceControlledContentPolicy,
  createSourceControlledContentPolicy,
  beginSourceSecretAncestorWalk,
  createSourcePaintScanCache,
  hasSourceCredentialSecretAncestor,
  isSourceSelectWrapper,
  sourceControlledContentBoundaryChanged,
  sourceNodeIsInsideControlledTarget,
  sourceControlledContentChangedTargets,
  sourceControlledContentLayoutMayChange,
  sourceControlledContentMutationsMayChange,
  type SourceControlledContentPolicy,
} from './source-privacy-policy';
import {
  SourceVisibilityBoundaryIndex,
  type SourceVisibilityComparison,
  sourceElementLinks,
  type SourceVisibilityBoundaryRefresh,
} from './source-visibility-boundary';
import {
  SourceStyleNameCensus,
  createSourceStyleSheetCollection,
  readCrossOriginSheetFromPageCache,
  SourceCrossOriginSheetNames,
  type SourceCrossOriginSheetReader,
  sourceClassChangeNamesHidingRule,
  sourceTextChangeMayRestyle,
  sourceVisibilityEventMaySkip,
  sourceVisibilityMutationMaySkip,
  type SourceStyleNames,
  type SourceStyleSheetCollection,
} from './source-style-names';
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

/**
 * The first slice of the credential scan, in the task that installs the
 * page script (D169).
 */
const FIRST_SECRET_SCAN_SLICE_MS = 10;

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
  /**
   * Gives the page a turn between slices of the page script's long work
   * (D163): `yieldToMain`, a task at the page's own priority, by default (D180).
   */
  readonly yieldToMain?: () => Promise<void>;
  /**
   * Reads a cross-origin style sheet's text for its names alone (D180):
   * `readCrossOriginSheetFromPageCache` by default.
   */
  readonly readCrossOriginStyleSheet?: SourceCrossOriginSheetReader;
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
  let secretObserver: (Pick<MutationObserver, 'observe' | 'disconnect'> & {
    readonly takeRecords?: () => MutationRecord[];
  }) | undefined;
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
    const setTimer = environment.setTimer ??
      ((callback: () => void, milliseconds: number) =>
        setTimeout(callback, milliseconds));
    // Kept by how strongly the page holds a root, not the other way round:
    // the observer watches a root while it is in the page. A root that left
    // is let go and one the page holds again is watched again by a bounded
    // maintenance pass, whether or not another root is met meanwhile (A3).
    const watchedRoots = new Set<WeakRef<ShadowRoot>>();
    let observedRoots = new WeakSet<ShadowRoot>();
    let maintenanceTimer: unknown;
    const observeRoot = (shadow: ShadowRoot): void => {
      try {
        observer.observe(shadow, SOURCE_LIFETIME_RECORD_OPTIONS);
        observedRoots.add(shadow);
      } catch {
        documentSecretClassifier.classify(shadow.host, {
          tagName: sourceLocalName(shadow.host),
          secretAncestor: true,
        });
      }
    };
    const rememberPending = (): void => {
      // A detached tree's last records are remembered before the observer
      // lets go of it: disconnecting drops what it has queued.
      try {
        const pending = observer.takeRecords?.() ?? [];
        if (pending.length > 0) {
          rememberSourceMutationSecrets(
            pending,
            sourceWindow,
            documentSecretClassifier,
            { freshRoots: true },
          );
        }
      } catch {
        // A record that cannot be read leaves the ledger as it was.
      }
    };
    const maintainWatchedRoots = (): void => {
      let rebind = false;
      for (const reference of watchedRoots) {
        const root = reference.deref();
        if (!root) {
          watchedRoots.delete(reference);
          continue;
        }
        const connected = root.host?.isConnected !== false;
        if (connected === observedRoots.has(root)) continue;
        rebind = true;
      }
      if (!rebind) return;
      rememberPending();
      observer.disconnect();
      observedRoots = new WeakSet();
      try {
        observer.observe(sourceDocument, SOURCE_LIFETIME_RECORD_OPTIONS);
      } catch {
        // The document cannot be watched any more; nothing is either.
      }
      for (const reference of watchedRoots) {
        const root = reference.deref();
        if (!root) {
          watchedRoots.delete(reference);
          continue;
        }
        if (root.host?.isConnected === false) continue;
        observeRoot(root);
      }
    };
    const scheduleMaintenance = (): void => {
      if (maintenanceTimer !== undefined || watchedRoots.size === 0) return;
      maintenanceTimer = setTimer(() => {
        maintenanceTimer = undefined;
        maintainWatchedRoots();
        scheduleMaintenance();
      }, SECRET_ROOT_MAINTENANCE_INTERVAL_MS);
    };
    const watchRoot = (shadow: ShadowRoot): void => {
      watchedRoots.add(new WeakRef(shadow));
      if (shadow.host?.isConnected !== false) observeRoot(shadow);
      scheduleMaintenance();
    };
    listenForSourceShadowRoots(sourceDocument, (shadow) => {
      maintainWatchedRoots();
      watchRoot(shadow);
    });
  }
  // In slices with a turn for the page between them (D163): 185 ms in one
  // task on a page of 54,000 elements. A small page is scanned in this task.
  // The sessions below read nothing before it is done; meanwhile the
  // observer above keeps what the page changes in the ledger. The live
  // passes' slice, except the first: it shares its task with the compiling
  // of this script and the setup above, 50–61 ms in all with a slice of 30
  // on a page of 54,000 elements (D165), so it gets 10 ms, which a small
  // page's scan still fits in (D169).
  const secretScan = startSourceDocumentSecretScan(
    sourceDocument,
    sourceWindow,
    documentSecretClassifier,
    createSliceClock({
      now: environment.now,
      yield: environment.yieldToMain ?? yieldToMain,
      budgetMs: LIVE_SLICE_BUDGET_MS,
      firstBudgetMs: FIRST_SECRET_SCAN_SLICE_MS,
    }),
  );
  if (!secretObserver) {
    const root = sourceProperty(sourceDocument, 'documentElement');
    if (root) {
      documentSecretClassifier.classify(root, {
        tagName: sourceLocalName(root),
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
  const now = environment.now ?? (() => performance.now());
  // The live whole-page passes, the semantic scan and the comparison of what
  // the page paints, share one fifth of the tab's time, for the document
  // (D164).
  const passShare = createPassShareLedger({ now });
  // The mirror of the document that runs now: its census of the names the
  // page's style rules mention tells the image reader which changes restyle
  // nothing (D182, D201).
  let liveMirror: HtmlMirrorSourceSession | undefined;
  runtime.onConnect.addListener((port) => {
    if (readHtmlMirrorPortSessionId(port.name)) {
      liveMirror = new HtmlMirrorSourceSession({
        port,
        document: sourceDocument,
        window: sourceWindow,
        registry,
        secretClassifier: documentSecretClassifier,
        secretScan,
        now,
        yieldToMain: environment.yieldToMain ?? yieldToMain,
        readCrossOriginStyleSheet: environment.readCrossOriginStyleSheet,
        passShare,
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
        secretScan,
        styleNames: () => liveMirror?.mentionedStyleNames(),
        // What a change asks of the whole document is read in slices, in
        // the share of the tab's time of the live passes (D164, D201).
        passShare,
        now,
        yieldToMain: environment.yieldToMain ?? yieldToMain,
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
      secretScan,
      structuralMenus,
      getNodeId: (node) => registry.getId(node),
      createMutationObserver: environment.createMutationObserver,
      schedule: (callback) => queueMicrotask(callback),
      // Read in slices with a turn for the page between them, and at most
      // a fifth of the tab's time with the comparison (D164).
      now,
      yieldToMain: environment.yieldToMain ?? yieldToMain,
      sliceBudgetMs: LIVE_SLICE_BUDGET_MS,
      passShare,
    });
  });
}

interface HtmlMirrorSourceSessionEnvironment {
  readonly port: Browser.runtime.Port;
  readonly document: Document;
  readonly window: Window;
  readonly registry: WeakNodeIdRegistry;
  readonly secretClassifier?: StickySourceSecretClassifier;
  /** The injection-time credential scan; the first read waits for it (D163). */
  readonly secretScan?: SourceDocumentSecretScan;
  readonly now: () => number;
  /**
   * Gives the page a turn between the slices of a checkpoint read (D163):
   * `yieldToMain` by default (D180).
   */
  readonly yieldToMain?: () => Promise<void>;
  /** See `HtmlMirrorSourceBridgeEnvironment.readCrossOriginStyleSheet` (D180). */
  readonly readCrossOriginStyleSheet?: SourceCrossOriginSheetReader;
  /**
   * The share of the tab's time the live whole-page passes keep to, shared
   * with the semantic scan (D164): the comparison of what the page paints
   * waits for it. Without it a comparison never waits.
   */
  readonly passShare?: PassShareLedger;
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
  /**
   * A root found on a host the mirror holds is sent with its host, read
   * again in its parent's list (D190): set for the walks of the page's
   * changes, which a patch follows.
   */
  readonly resendHeldHosts?: true;
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
    if (!target || typeof sourceNodeType(target as Node) !== 'number') return;
    const asked = new Set<Node>();
    // One by one, not as arguments (D213, as D180 and D186).
    for (const above of askAboutSourceShadowRootsAbove(target as Node, asked)) found.push(above);
    const point = event.type === 'pointerdown'
      ? [(event as PointerEvent).clientX, (event as PointerEvent).clientY] as const
      : undefined;
    let current: Node | null = target as Node;
    let depth = 0;
    for (; current && depth < MAX_SOURCE_INPUT_ROOT_DEPTH; depth += 1) {
      if (sourceNodeType(current) !== 1) break;
      const root = readSourceShadowRoot(current as Element);
      if (!root) break;
      const next: Element | null = point
        ? root.elementFromPoint(point[0], point[1])
        : root.activeElement;
      if (!next || next === current) break;
      for (const above of askAboutSourceShadowRootsAbove(next, asked)) found.push(above);
      current = next;
    }
    // The follow stopped at its bound, not at the input: a root attached
    // deeper still is found by reading what lies below in a fresh walk.
    if (depth === MAX_SOURCE_INPUT_ROOT_DEPTH && current && sourceNodeType(current) === 1) {
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
/** How often the document-lifetime secret observer revisits its roots (A3). */
const SECRET_ROOT_MAINTENANCE_INTERVAL_MS = 1_000;
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
/**
 * The most one look at the elements the page declares hidden takes after a
 * comparison, in milliseconds (D180); the rest wait for the next.
 */
const DECLARED_HIDDEN_LOOK_MS = 8;
/** Credential fields sized by their content whose scrollers are kept (D180). */
const MAX_CREDENTIAL_SCROLL_FREEZES = 16;
const MAX_CREDENTIAL_SCROLL_ANCESTORS = 256;
/** See `#credentialScrollFreezes` (D180). */
interface CredentialScrollFreeze {
  readonly axis: 'x' | 'y';
  readonly document: { readonly offset: number; readonly max: number };
  readonly panes: ReadonlyMap<Element, { readonly offset: number; readonly max: number }>;
}
/**
 * How far the comparison after a change of a class a hiding rule names may
 * run ahead of the share (D180), in milliseconds.
 */
const HIDING_CLASS_MAX_ADVANCE_MS = 1_000;
/** Elements with more content than room kept to be asked (D180). */
const MAX_PANE_BOX_CANDIDATES = 4_096;
/** Time for asking them, per read of the boxes (D180), in milliseconds. */
const PANE_BOX_LOOK_MS = 4;

/** The box that says an element is a pane no longer (D180). */
function noPaneBox(nodeId: number): HtmlMirrorPaneBox {
  return { nodeId, x: 0, y: 0, width: 0, height: 0, maxScrollX: 0, maxScrollY: 0 };
}

/** How many roots a full set refuses between two compactions (D171). */
const IMAGE_EVENT_ROOT_COMPACTION_EVERY = 256;
/**
 * Attributes that change how an element's children are read (D180): when
 * one of them changes in the frame the element's list does, the list is
 * read whole with it, as before.
 */
const SOURCE_CHILD_READING_ATTRIBUTES: ReadonlySet<string> = new Set([
  'role',
  'contenteditable',
  'hidden',
  'aria-hidden',
  'inert',
  'type',
  'autocomplete',
]);
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

/**
 * What a person does on purpose: a comparison it asks for starts at once,
 * without waiting for the share of time the live passes keep to; it still
 * runs in slices, one pass at a time, and its work counts against the
 * share of the passes after it (D164, the owner's choice). Pointer moves,
 * focus changes and key releases come too often to skip the wait.
 */
const USER_INPUT_EVENTS: ReadonlySet<string> = new Set([
  'click',
  'keydown',
  'beforeinput',
  'input',
  'change',
  'beforetoggle',
  'toggle',
]);

/**
 * A page of this many elements or more is sent first as a preview (D163):
 * what is near the viewport, every other block a box of its height, while
 * the whole page is read in slices. Counted by `getElementsByTagName('*')`,
 * which costs next to nothing.
 */
const HTML_MIRROR_PREVIEW_MIN_ELEMENTS = 4_000;
/**
 * The share of a slice the reader takes (D163). What it read is checked,
 * marked and added to the index of what is painted in the same slice, and
 * those take about as long as the reading: 375 ms of reading against 439 ms
 * of the rest on a page of 54,000 elements (D162).
 */
const CHECKPOINT_READ_SHARE = 0.5;
/**
 * The share of a slice that reading and staging together aim at (D186);
 * the checks of a part and the turn's own work take the rest.
 */
const CHECKPOINT_STAGED_SLICE_SHARE = 0.8;
/** The least the reader is given of a slice, whatever staging costs. */
const MIN_CHECKPOINT_READING_MS = 3;
/**
 * A read in slices that meets a node twice (the page moved it into what was
 * not read yet) starts again; after this many the page is read in one task,
 * as before (D163).
 */
const MAX_CHECKPOINT_READ_RESTARTS = 2;
/**
 * How many times a read in parts reads the controlled-content policy again
 * because the page changed it between two slices (D171), until a restart
 * that builds it anew; past it the replay of the kept changes after the
 * copy follows the policy, as before. A page that flips a panel every frame
 * does not hold the read.
 */
const MAX_CHECKPOINT_POLICY_REBUILDS = 2;
/**
 * Mutation records kept while a checkpoint is read in slices, to be judged
 * against the new copy once it is sent (D163). A page that changes more
 * than this meanwhile is read again.
 */
const MAX_CHECKPOINT_READ_RECORDS = 20_000;
/**
 * Loaded images and style sheets kept the same way, and elements whose
 * held animation values changed after they were read (D163).
 */
const MAX_CHECKPOINT_READ_LOADS = 4_000;

/**
 * What `#markMirroredGraph` writes and a checkpoint replaces: built for a
 * read in slices beside what the mirror holds, and put in its place in the
 * task that sends the checkpoint (D163).
 */
interface MirroredGraphState {
  mirroredNodes: WeakSet<Node>;
  mirroredOpaqueSecrets: WeakSet<Element>;
  emittedChildren: WeakMap<Node, readonly Node[]>;
  emittedParent: WeakMap<Node, Node>;
  emittedNodeSignatures: WeakMap<Node, string>;
  shadowHostCandidates: Element[];
  knownShadowHostCandidates: WeakSet<Element>;
  shadowDiscoveryCursor: number;
  mirroredImageCandidates: Element[];
  knownMirroredImageCandidates: WeakSet<Element>;
  selectedImageSources: WeakMap<Element, string>;
  controlledContentPolicy: SourceControlledContentPolicy | undefined;
  adoptedStyleSignatures: StableSignatureTracker;
}

/**
 * A checkpoint read that is running (D163). A newer one, or the end of the
 * session, cancels it: each of its turns asks whether it is still the
 * session's read before it does anything.
 */
interface CheckpointRead {
  readonly generation: number;
  /** What the page changed meanwhile, kept raw. */
  records: MutationRecord[];
  recordsOverflow: boolean;
  /** The nodes those records name, which the copy's patches would read again. */
  readonly recordTargets: Set<Node>;
  /** Images and style sheets that loaded meanwhile. */
  readonly loaded: Set<Element>;
  /**
   * Elements read already whose script animations came to hold other
   * values meanwhile: the listing tells of each once, and the copy holds
   * what was read before (D163).
   */
  readonly held: Set<Element>;
  /** What a read in slices has marked so far. */
  staged?: MirroredGraphState;
  /**
   * How many of `records` were judged against the read's policy (D171):
   * those after it may have changed it since.
   */
  policyChecked: number;
  /** Policies read again between slices since the policy was built (D171). */
  policyRebuilds: number;
  /**
   * A kept change may have moved the policy and it was not read again (the
   * rebuilds ran out): the replay after the copy reads it again (D171).
   */
  policyStale: boolean;
  /**
   * Elements read already whose state in the policy changed when it was
   * read again between slices (D171): sent again after the copy's ACK.
   */
  readonly policyRequeue: Set<Element>;
}

/** The slices of one checkpoint read (D163). */
interface CheckpointReadSlices {
  readonly clock: SliceClock;
  /** The reader's share of the current slice is used. */
  readonly reading: { expired(): boolean };
  /**
   * What a step's reading and its staging took (D186): the reader's share
   * of the next slices is what leaves the staging room in the slice.
   */
  noteStep(readMs: number, stageMs: number): void;
  next(): Promise<void>;
}

/**
 * A comparison of what the page paints that is running (D164). It took the
 * requests that started it; what asks for one meanwhile waits for the next.
 * A checkpoint, a recovery or the end of the session cancels it.
 */
interface ComparisonRun {
  readonly generation: number;
  readonly index: SourceVisibilityBoundaryIndex;
  readonly comparison: SourceVisibilityComparison;
  readonly clock: SliceClock;
  /** Whether the slice has done its share: the clock, asked every few elements. */
  readonly expired: () => boolean;
  /** The work of its slices, not the time it waited between them. */
  busyMs: number;
  /** It has given the page a turn. */
  yielded: boolean;
  /**
   * The size of what the resize observer watches, read before the first
   * turn: the size the comparison of the whole page began at (D163's rule).
   */
  sizeAtStart: string | undefined;
}

/**
 * Elements a comparison compares between two looks at its slice clock: a
 * look is a call of `performance.now()`, and a comparison of 54,000
 * elements took 200 ms, about 4 µs an element.
 */
const COMPARISON_CLOCK_EVERY = 32;

/**
 * How long changes wait for a panel a full window of batches behind
 * (D164): a panel that has not answered by then is taken to have stopped,
 * and the stream runs over as it did before D164, which a fresh copy ends.
 */
const ACK_HOLD_LIMIT_MS = 5_000;

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
  /**
   * Elements whose pending attributes change how their children are read
   * (D180): a role, `contenteditable`, `hidden`, `aria-hidden`, `inert`, a
   * field's type or autocomplete, an element shown or hidden, a panel the
   * policy reads otherwise. Their list goes with them in one patch, read
   * whole; any other element's attributes may follow its list in a later
   * patch of the frame (see `#holdBack`).
   */
  #readWithChildren = new Set<Element>();
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
  /**
   * Roots refused since the set of roots was last compacted, when it is
   * full (D171): compacted again only every so often, not for each.
   */
  #imageEventRootsRefused = 0;
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
  #adoptedStyleSignatures = new StableSignatureTracker(
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
   * The same elements, to go through (D180): asked again after each
   * comparison of what the page paints, which a class or the end of an
   * animation asks for (`#askDeclaredHiddenAgain`). The index of what is
   * painted takes such an element for unknown before a fade and after it.
   */
  #declaredHiddenElements = new Set<Element>();
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
  /**
   * Scrollable elements the reader met, at their start or not, each with
   * the box the panel was last told (D180): the panel tests the wheel
   * against them. In the order they were met; at most
   * `MAX_HTML_MIRROR_PANE_BOXES`.
   */
  #paneBoxes = new Map<Element, HtmlMirrorPaneBox | undefined>();
  /** Elements met with more content than room, whose overflow is asked next. */
  #paneBoxCandidates = new Set<Element>();
  /** What the panel was told of the boxes is not what is noted here. */
  #restatePaneBoxes = false;
  /** The panel holds boxes from this stream: an empty list is news to it. */
  #paneBoxesSent = false;
  /** The viewport-scale pane the tab scrolls in place of its document. */
  #primaryPane: Element | undefined;
  #pendingDocumentScroll = false;
  #lastDocumentScroll:
    ReturnType<typeof readDocumentScrollSnapshot> | undefined;
  /**
   * For each credential field sized by its content (`field-sizing:
   * content`), the place of every scroller around it, the document's
   * included, on the field's inline axis, as it was before the field was
   * first typed into (D180). Such a field grows a character at a time, and
   * the scroll numbers would carry the length of the password; they are
   * reported at these places while the field is in the page.
   */
  #credentialScrollFreezes = new Map<Element, CredentialScrollFreeze>();
  /** The names of the page's cross-origin sheets, from its cache (D180). */
  #crossOriginSheets: SourceCrossOriginSheetNames | undefined;
  readonly #crossOriginNames = (
    sheet: CSSStyleSheet,
  ): SourceStyleNames | undefined => {
    if (!this.#crossOriginSheets) {
      let origin = '';
      try {
        origin = this.environment.window.location?.origin ?? '';
      } catch {
        origin = '';
      }
      this.#crossOriginSheets = new SourceCrossOriginSheetNames(
        this.environment.readCrossOriginStyleSheet ??
          readCrossOriginSheetFromPageCache(this.environment.window),
        origin,
      );
    }
    return this.#crossOriginSheets.names(sheet);
  };
  /** The last place sent, to tell a frame in which nothing moved. */
  #lastReportedPlace: string | undefined;
  /** The pane last named as the one scrolled in place of the document. */
  #lastReportedPrimaryPaneId: number | undefined;
  /** A list could not be sent: the next one is the whole list. */
  #restatePanes = false;
  #sequence = 0;
  #acknowledged = 0;
  /** A flush waited for the panel to acknowledge (D164). */
  #heldForAck = false;
  /** Ends a hold for the ACK that lasts `ACK_HOLD_LIMIT_MS`. */
  #ackHoldTimer: unknown;
  #paused = false;
  #recoveryCheckpointSequence: number | undefined;
  #shadowReconciliationPending = false;
  /**
   * Closed roots found, by any reader of the page, on an element that had
   * been read without one: attached since. See `#takeLateShadowRoots`.
   */
  #lateShadowRoots: ShadowRoot[] = [];
  /**
   * Roots met on a host the mirror does not hold yet (D180): a component a
   * page made, gave a root and filled before it put it in the page. The
   * patch that adds the host carries its root, so it is asked about after
   * that patch (`#rootsAwaitingPatchHeld`), not taken for a root the mirror
   * lacks: each such card or row was a whole read.
   */
  #rootsAwaitingPatch = new Set<ShadowRoot>();
  /**
   * Hosts the mirror holds that have a root since (D190): each is sent
   * again whole, with its root, in its parent's list, as a host the mirror
   * does not hold comes with its root (D180). It was a whole read.
   */
  #hostsSentAgain = new Set<Element>();
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
  /** A person's input asked for the next comparison: it skips the share (D164). */
  #userInputPending = false;
  /**
   * The style names the index's kept style answers were read under (D186);
   * none while it keeps none.
   */
  #styleMemoryNames: SourceStyleNames | undefined;
  /**
   * A class a hiding rule names changed since the last comparison began
   * (D180): it hides or shows a panel, which the mirror shows until the
   * comparison notices, so the comparison waits for no share while the
   * share owes at most `HIDING_CLASS_MAX_ADVANCE_MS`.
   */
  #hidingClassPending = false;
  /** The policy read again in slices after a change of layout (D165). */
  #policyRefreshRunning = false;
  #policyRefreshGeneration = 0;
  /**
   * The running policy read was begun by the replay of a read's kept
   * changes (D171): no flush runs until it is done, so nothing is sent
   * under the policy the copy was read with.
   */
  #policyRefreshHoldsFlush = false;
  /**
   * While a read's kept changes are replayed (D171): whether they may still
   * move the policy (`sliced`: read it again in slices, the first flush held)
   * or were judged against it already between the slices (`skip`).
   */
  #replayPolicy: 'sliced' | 'skip' | undefined;
  #visibilityFullRefreshPending = false;
  /** The comparison of what the page paints that is running, if any (D164). */
  #comparisonRun: ComparisonRun | undefined;
  #comparisonGeneration = 0;
  /** The comparison waits for its share of the tab's time (D164). */
  #comparisonShareTimer: unknown;
  /**
   * The names the page's style sheets mention, as the style poll reads
   * them: a change no rule names is not compared (D164).
   */
  readonly #styleNames = new SourceStyleNameCensus();
  /**
   * The layout changed and the frame that follows has not yet looked for
   * new roots and read the relationships of controlled content again: once
   * a frame, however many events told of it. See `#layoutChanged`.
   */
  #layoutChangePending = false;
  /**
   * The size of what the resize observer watches when the whole page was
   * last compared in a frame, and how many whole comparisons the index had
   * made by then. See `#onObservedResize`.
   */
  #comparedAtSize: string | undefined;
  #wholeComparisonsSeen = 0;
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
  /** The checkpoint read that is running, if any: see `#postCheckpoint` (D163). */
  #checkpointRead: CheckpointRead | undefined;
  #checkpointReadGeneration = 0;
  /** Only the session's first read may send a preview first (D163). */
  #previewAllowed = true;
  /**
   * The sequence the last checkpoint part carried (D163): a later read in
   * parts, or a checkpoint after them, takes the next, so that the panel
   * can tell the parts of a cancelled read from the new ones.
   */
  #partsSequence: number | undefined;
  /** The walk after a read met a root attached to a host read without one. */
  #rootAttachedDuringRead = false;
  /** The fresh walk of the current slice of a checkpoint read (D163). */
  #sliceRootWalk: ReturnType<typeof beginSourceShadowRootWalk> | undefined;

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
    // A read in slices that is running stops at its next turn (D163).
    this.#checkpointRead = undefined;
    this.environment.port.onMessage.removeListener(this.#onMessage);
    this.environment.port.onDisconnect.removeListener(this.#onDisconnect);
    this.#stopListeningForShadowRoots?.();
    this.#stopListeningForShadowRoots = undefined;
    this.#stopListeningForHeldAnimations?.();
    this.#stopListeningForHeldAnimations = undefined;
    this.#heldChanged.clear();
    this.#lateShadowRoots = [];
    this.#rootsAwaitingPatch.clear();
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
      sourceCall(this.environment.document, 'removeEventListener', type, this.#onControlledLayoutSettle, true);
    }
    for (const type of VISIBILITY_INTERACTION_EVENTS) {
      sourceCall(this.environment.document, 'removeEventListener', type, this.#onVisibilityInteraction, true);
    }
    for (const root of this.#imageEventRoots) {
      sourceCall(root, 'removeEventListener', 'load', this.#onCapturedResourceLoad, true);
      sourceCall(root, 'removeEventListener', 'error', this.#onCapturedResourceError, true);
      sourceCall(root, 'removeEventListener', 'scroll', this.#onScroll, true);
      sourceCall(root, 'removeEventListener', 'slotchange', this.#onSlotChange, true);
    }
    this.#imageEventRoots.clear();
    sourceProperty(this.environment.document, 'fonts')?.removeEventListener?.(
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
    this.#paneBoxes.clear();
    this.#paneBoxCandidates.clear();
    this.#restatePaneBoxes = false;
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
    this.#declaredHiddenElements.clear();
    this.#styleDerivedPending = false;
    this.#controlledContentPolicy = undefined;
    this.#cancelPolicyRefresh();
    this.#controlledLayoutSettlePending = false;
    this.#cancelComparison();
    if (this.#comparisonShareTimer !== undefined) {
      this.environment.clearTimer(this.#comparisonShareTimer);
    }
    this.#comparisonShareTimer = undefined;
    this.#releaseAckHold();
    this.#styleNames.reset();
    this.#visibilityBoundaryIndex?.dispose();
    this.#visibilityBoundaryIndex = undefined;
    this.#visibilityMutationRecords = [];
    this.#visibilityMutationOverflow = false;
    this.#visibilityInteractionTargets.clear();
    this.#userInputPending = false;
    this.#hidingClassPending = false;
    this.#visibilityFullRefreshPending = false;
    this.#layoutChangePending = false;
    this.#comparedAtSize = undefined;
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
        message.identity.sequence >= this.#recoveryCheckpointSequence &&
        // Only the copy being read, once sent, is what the panel can
        // acknowledge; a preview's sequence is older (D163).
        !this.#checkpointRead
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
        return;
      }
      // Changes held while the panel was a full window of batches behind
      // go out now (D164).
      if (this.#heldForAck) {
        this.#releaseAckHold();
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
      this.#observer.observe(sourceProperty(this.environment.document, 'documentElement'), {
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
            const read = this.#checkpointRead;
            if (read?.staged?.mirroredNodes.has(element)) {
              if (read.held.size < MAX_CHECKPOINT_READ_LOADS) read.held.add(element);
              else read.recordsOverflow = true;
            }
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
        sourceCall(this.environment.document, 'addEventListener', type, this.#onControlledLayoutSettle, true);
      }
      for (const type of VISIBILITY_INTERACTION_EVENTS) {
        sourceCall(this.environment.document, 'addEventListener', type, this.#onVisibilityInteraction, true);
      }
      this.#observeImageEvents(this.environment.document);
      sourceProperty(this.environment.document, 'fonts')?.addEventListener?.(
        'loadingdone',
        this.#onFontLoadingDone,
      );
      if (this.environment.createResizeObserver) {
        this.#resizeObserver = this.environment.createResizeObserver(
          () => this.#onObservedResize(),
        );
        this.#resizeObserver.observe(sourceProperty(this.environment.document, 'documentElement'));
        if (sourceProperty(this.environment.document, 'body')) {
          this.#resizeObserver.observe(sourceProperty(this.environment.document, 'body'));
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

  /**
   * Reads the whole page for a checkpoint and sends it (D163). A page whose
   * read fits one slice is read and sent in this task, as before. A larger
   * one is read in slices with a turn for the page between them: first, on
   * the session's first read of a page of `HTML_MIRROR_PREVIEW_MIN_ELEMENTS`
   * elements or more, a preview; then the page in parts, each checked and
   * sent as soon as it is read; then the checkpoint that closes them. What
   * the mirror holds is built beside what it holds now and takes its place
   * in the task that sends that checkpoint; what the page changed meanwhile
   * is then judged against it. A checkpoint asked for while one is read
   * cancels that read and starts anew.
   *
   * Sequences: a checkpoint sent whole carries the current sequence, as
   * before. A preview carries the current sequence `S` and the copy that
   * follows it `S + 1`, so that the preview's ACK resumes nothing. A read
   * sent in parts carries a sequence no part has carried yet: the next one
   * when the current one carried the parts of a read restarted or
   * cancelled, and a checkpoint sent whole after such parts does the same.
   * Patches follow the copy's sequence.
   */
  #postCheckpoint(): void {
    const read: CheckpointRead = {
      generation: (this.#checkpointReadGeneration += 1),
      records: [],
      recordsOverflow: false,
      recordTargets: new Set(),
      loaded: new Set(),
      held: new Set(),
      policyChecked: 0,
      policyRebuilds: 0,
      policyStale: false,
      policyRequeue: new Set(),
    };
    // The copy brings its own policy: a read of it begun before is of no
    // use, and must not hold the first flush after this copy (D171).
    this.#cancelPolicyRefresh();
    this.#checkpointRead = read;
    // A recovery or a fresh start: nothing waits for an older ACK (D164).
    this.#releaseAckHold();
    // The copy compares the whole page anew: a comparison running on the
    // index it replaces is of no use (D164).
    this.#cancelComparison();
    // Whatever was owed is read with the page. What is met from here on in
    // what was read already is kept for the copy that is sent.
    this.#lateShadowRoots = [];
    this.#rootsAwaitingPatch.clear();
    this.#imageRefreshRequested = false;
    void this.#readCheckpoint(read);
  }

  /** Whether `read` is still the session's read (D163). */
  #readIsCurrent(read: CheckpointRead): boolean {
    return !this.#disposed && this.#checkpointRead === read &&
      this.#checkpointReadGeneration === read.generation;
  }

  async #readCheckpoint(read: CheckpointRead): Promise<void> {
    try {
      // Every node has met the injection-time credential scan first.
      const secretScan = this.environment.secretScan;
      const waitedForScan = secretScan !== undefined && !secretScan.done;
      if (secretScan && !secretScan.done) {
        await secretScan.finished;
        if (!this.#readIsCurrent(read)) return;
      }
      const slices = this.#checkpointReadSlices();
      this.#openSliceRootWalk();
      const expired = (): boolean => slices.clock.expired();
      // The scan's last slice ends in this task (D215): the policy's first
      // slice after it made one task of both, 51–61 ms on a page of one box
      // of 131,000 children. A turn for the page first.
      if (waitedForScan) {
        await slices.next();
        if (!this.#readIsCurrent(read)) return;
      }
      // Built in slices; a page whose policy fits the first is read on in
      // this task (no await on that path: a small page is sent in it).
      let builder = this.#beginControlledContentPolicy(read);
      let policy = this.#withoutOwnLateRoots(() => builder.step(expired));
      while (!policy) {
        await slices.next();
        if (!this.#readIsCurrent(read)) return;
        policy = this.#withoutOwnLateRoots(() => builder.step(expired));
      }
      // Only the session's first read of a large page, and only its first
      // attempt, offers a preview.
      let offerPreview = this.#previewAllowed &&
        this.#countSourceElements() >= HTML_MIRROR_PREVIEW_MIN_ELEMENTS;
      this.#previewAllowed = false;
      for (let restarts = 0; ; restarts += 1) {
        if (restarts > MAX_CHECKPOINT_READ_RESTARTS) {
          // The page keeps moving what was read into what was not: it is
          // read in one task, as before.
          this.#readAndPostCheckpoint(read);
          return;
        }
        const outcome = await this.#readCheckpointInSlices(
          read,
          slices,
          policy,
          offerPreview,
        );
        offerPreview = false;
        if (outcome !== 'restart' || !this.#readIsCurrent(read)) return;
        // The policy the attempt ended with: read again between its slices
        // when the page moved it (D171).
        policy = read.staged?.controlledContentPolicy ?? policy;
        await slices.next();
        if (!this.#readIsCurrent(read)) return;
        // What the policy was built from may have changed meanwhile.
        if (
          read.recordsOverflow ||
          sourceControlledContentMutationsMayChange(read.records, policy)
        ) {
          builder = this.#beginControlledContentPolicy(read);
          let rebuilt = this.#withoutOwnLateRoots(() => builder.step(expired));
          while (!rebuilt) {
            await slices.next();
            if (!this.#readIsCurrent(read)) return;
            rebuilt = this.#withoutOwnLateRoots(() => builder.step(expired));
          }
          policy = rebuilt;
        }
      }
    } catch {
      if (!this.#readIsCurrent(read)) return;
      this.#checkpointRead = undefined;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'privacy_rejected',
      ));
    } finally {
      this.#closeSliceRootWalk();
    }
  }

  /**
   * A checkpoint asks about every element's root again instead of trusting
   * an earlier "none": it holds every root attached so far, as it always did
   * for open ones (D125). One fresh walk a slice serves all of the slice's
   * reading (the policy, the read, the marks), so that each root is asked
   * about once in it; it is closed before each turn the page is given
   * (D163), and a read in one task is one slice.
   */
  #openSliceRootWalk(): void {
    this.#sliceRootWalk ??= beginSourceShadowRootWalk({ fresh: true });
  }

  #closeSliceRootWalk(): void {
    const walk = this.#sliceRootWalk;
    this.#sliceRootWalk = undefined;
    walk?.end();
  }

  /** The slices of one checkpoint read, on the session's clock (D163). */
  #checkpointReadSlices(): CheckpointReadSlices {
    const now = this.environment.now;
    const clock = createSliceClock({
      now,
      yield: this.environment.yieldToMain ?? yieldToMain,
    });
    const sliceBudget = clock.budgetMs * CHECKPOINT_STAGED_SLICE_SHARE;
    let readingBudget = clock.budgetMs * CHECKPOINT_READ_SHARE;
    let startedAt = now();
    return {
      clock,
      reading: { expired: () => now() - startedAt >= readingBudget },
      noteStep: (readMs, stageMs) => {
        // Steps too short to tell anything leave the share as it is.
        if (!(readMs >= 2) || !Number.isFinite(stageMs)) return;
        // Staging costs `stageMs / readMs` of every millisecond read: on a
        // box of 131,000 children it took 26–38 ms after 15 ms of reading,
        // and slices ran to 58–76 ms (D186).
        const share = sliceBudget / (1 + Math.max(0, stageMs) / readMs);
        readingBudget = Math.min(
          clock.budgetMs * CHECKPOINT_READ_SHARE,
          Math.max(MIN_CHECKPOINT_READING_MS, share),
        );
      },
      next: async () => {
        this.#closeSliceRootWalk();
        await clock.next();
        startedAt = now();
        this.#openSliceRootWalk();
      },
    };
  }

  /**
   * Starts the policy of the page's controlled content, to be built in
   * slices (D163). What the page changes from here on is kept, and judged
   * against the copy once it is sent, its relationships among it.
   */
  #beginControlledContentPolicy(
    read: CheckpointRead,
  ): ReturnType<typeof beginSourceControlledContentPolicy> {
    // A read anew reads all of these as they are now.
    read.records = [];
    read.recordTargets.clear();
    read.loaded.clear();
    read.held.clear();
    read.recordsOverflow = false;
    read.policyChecked = 0;
    read.policyRebuilds = 0;
    read.policyStale = false;
    read.policyRequeue.clear();
    return beginSourceControlledContentPolicy(
      this.environment.document,
      this.environment.window,
      MAX_HTML_MIRROR_NODES,
    );
  }

  /**
   * Reads the controlled-content policy of a read in parts again when what
   * the page changed since it was judged may have moved it (D171). Before,
   * the policy was built once before the read: a panel painted then and
   * collapsed before its slice went into the copy with its text. Read in
   * slices of its own (the read waits); what it changes of what is read
   * already is sent again after the copy's ACK, and what is not read yet
   * is read with it. A change of the policy's own bounds starts the read
   * again. Past `MAX_CHECKPOINT_POLICY_REBUILDS` the replay after the copy
   * follows the policy, as before.
   */
  async #followControlledContentPolicy(
    read: CheckpointRead,
    slices: CheckpointReadSlices,
    reader: ReturnType<typeof beginSourceDocumentRead>,
    staged: MirroredGraphState,
  ): Promise<'ended' | 'restart' | undefined> {
    for (;;) {
      const policy = staged.controlledContentPolicy;
      if (!policy || read.policyChecked >= read.records.length) return undefined;
      const fresh = read.records.slice(read.policyChecked);
      read.policyChecked = read.records.length;
      if (!sourceControlledContentMutationsMayChange(fresh, policy)) continue;
      if (read.policyRebuilds >= MAX_CHECKPOINT_POLICY_REBUILDS) {
        read.policyStale = true;
        return undefined;
      }
      read.policyRebuilds += 1;
      const builder = beginSourceControlledContentPolicy(
        this.environment.document,
        this.environment.window,
        MAX_HTML_MIRROR_NODES,
      );
      const expired = (): boolean => slices.clock.expired();
      let next = this.#withoutOwnLateRoots(() => builder.step(expired));
      while (!next) {
        await slices.next();
        if (!this.#readIsCurrent(read)) return 'ended';
        if (read.recordsOverflow) return 'restart';
        next = this.#withoutOwnLateRoots(() => builder.step(expired));
      }
      if (next.incomplete || sourceControlledContentBoundaryChanged(policy, next)) {
        return 'restart';
      }
      for (const target of sourceControlledContentChangedTargets(policy, next)) {
        if (staged.mirroredNodes.has(target)) {
          read.policyRequeue.add(target);
          continue;
        }
        // Not read yet, but what a slot in it draws may be: the host's own
        // children are read before its root (D135).
        const root = target.getRootNode();
        if (
          isSourceShadowRoot(root) && staged.mirroredNodes.has(root.host) &&
          (sourceLocalName(target) === 'slot' || target.querySelector('slot'))
        ) return 'restart';
      }
      if (read.policyRequeue.size > MAX_HTML_MIRROR_PENDING_TARGETS) return 'restart';
      reader.setControlledContent(next);
      staged.controlledContentPolicy = next;
    }
  }

  /**
   * Runs one slice of the read. A root its own fresh walk finds on an
   * element read before without one is read with it: only roots that other
   * readers find between the slices, in what was read already, are owed.
   */
  #withoutOwnLateRoots<T>(work: () => T): T {
    const before = this.#lateShadowRoots.length;
    try {
      return work();
    } finally {
      if (this.#lateShadowRoots.length > before) {
        this.#lateShadowRoots.length = before;
      }
    }
  }

  #countSourceElements(): number {
    let count = 0;
    try {
      const document = this.environment.document;
      // Outside a browser (a test's DOM) `*` may name no element at all.
      count = sourceCall(document, 'getElementsByTagName', '*').length ||
        sourceCall(document, 'querySelectorAll', '*').length;
      if (count >= HTML_MIRROR_PREVIEW_MIN_ELEMENTS) return count;
      // A page of web components holds most of itself in shadow roots,
      // which `*` does not count (D171): the roots' elements are counted
      // too, until the threshold. At most that many elements are asked for
      // a root, in the slice's own walk of the roots.
      return this.#withoutOwnLateRoots(() => {
        const visit = (scope: Document | ShadowRoot): void => {
          for (const element of sourceCall(scope, 'querySelectorAll', '*')) {
            if (count >= HTML_MIRROR_PREVIEW_MIN_ELEMENTS) return;
            const root = readSourceShadowRoot(element);
            if (!root) continue;
            count += root.querySelectorAll('*').length;
            visit(root);
          }
        };
        visit(document);
        return count;
      });
    } catch {
      return count;
    }
  }

  /**
   * Sends the preview (D163) at the current sequence, with the document's
   * place (the preview holds what is near it), and moves to the next
   * sequence for the copy. False when the page gives none: the copy then
   * comes without it. Offered only once the read has not fitted its first
   * slice: a large page read that fast needs none.
   */
  #postPreview(policy: SourceControlledContentPolicy): boolean {
    const fidelityPolicy = this.#fidelityPolicy;
    if (!fidelityPolicy || !this.#identity) return false;
    const { document, window, registry, now } = this.environment;
    const startedAt = now();
    const representability = createHtmlMirrorRepresentabilityCollector();
    let checkpoint: HtmlMirrorCheckpoint | undefined;
    try {
      const graph = this.#withoutOwnLateRoots(() => sanitizeSourcePreview(
        document,
        window,
        registry,
        {
          representability,
          fidelityPolicy,
          controlledContent: policy,
          now,
        },
      ));
      checkpoint = graph && createHtmlMirrorCheckpoint(
        this.#identityAt(this.#sequence),
        {
          root: graph.root,
          adoptedStyleSheets: graph.adoptedStyleSheets,
          documentMode: graph.documentMode,
          captureMs: Math.max(0, now() - startedAt),
          viewportWidth: graph.viewportWidth,
          viewportHeight: graph.viewportHeight,
          documentWidth: graph.documentWidth,
          documentHeight: graph.documentHeight,
          representability: snapshotHtmlMirrorRepresentability(representability),
          preview: true,
        },
        fidelityPolicy,
      );
    } catch {
      return false;
    }
    if (!checkpoint) return false;
    this.#post(checkpoint);
    // Only the document's place: no pane is the mirror's before the copy.
    const documentScroll = this.#withoutCredentialLength(
      readDocumentScrollSnapshot(document, window),
    );
    const scroll = createHtmlMirrorScrollUpdate(
      this.#identityAt(this.#sequence),
      {
        scrollX: documentScroll.scrollX,
        scrollY: documentScroll.scrollY,
        maxScrollX: documentScroll.maxScrollX,
        maxScrollY: documentScroll.maxScrollY,
        ...readVisualViewportSnapshot(window),
      },
    );
    if (scroll) this.#post(scroll);
    this.#takeNextSequence();
    return true;
  }

  /** Moves to the next sequence; only the copy sent at it resumes the stream. */
  #takeNextSequence(): void {
    this.#sequence += 1;
    this.#recoveryCheckpointSequence = this.#sequence;
  }

  /** The sequence of a checkpoint sent whole: the current one, unless parts carried it. */
  #wholeCheckpointSequence(): number {
    if (this.#partsSequence === this.#sequence) this.#takeNextSequence();
    return this.#sequence;
  }

  /** The sequence of a checkpoint sent in parts: one no part has carried yet. */
  #partsCheckpointSequence(): number {
    if (this.#partsSequence === this.#sequence) this.#takeNextSequence();
    this.#partsSequence = this.#sequence;
    return this.#sequence;
  }

  /**
   * One attempt at reading the page in slices (D163). Each step's root and
   * fills are checked with the checkpoint's other parts (one node and one
   * byte budget for all), sent as a part, marked into fresh structures and
   * added to the fresh index of what is painted, all in the step's task.
   */
  async #readCheckpointInSlices(
    read: CheckpointRead,
    slices: CheckpointReadSlices,
    policyAtStart: SourceControlledContentPolicy,
    offerPreview: boolean,
  ): Promise<'restart' | 'ended'> {
    let policy = policyAtStart;
    const fidelityPolicy = this.#fidelityPolicy;
    if (!fidelityPolicy || !this.#identity) return 'ended';
    if (slices.clock.expired()) {
      await slices.next();
      if (!this.#readIsCurrent(read)) return 'ended';
    }
    if (read.recordsOverflow) return 'restart';
    const { document, window, registry, now } = this.environment;
    const startedAt = now();
    const sizeAtStart = this.#readObservedSize();
    const representability = createHtmlMirrorRepresentabilityCollector();
    const reader = beginSourceDocumentRead(document, window, registry, {
      representability,
      fidelityPolicy,
      controlledContent: policy,
      slotReadings: this.#slotReadings,
      now,
      freshRootWalk: false,
    });
    const staged = this.#createMirroredGraphState(policy);
    read.staged = staged;
    // After each turn the page had (D171): the read goes on, ends, or
    // starts again; the policy is read again first when what the page
    // changed in the turn may have moved it.
    const afterTurn = async (): Promise<'ended' | 'restart' | undefined> => {
      if (!this.#readIsCurrent(read)) return 'ended';
      if (read.recordsOverflow) return 'restart';
      const outcome = await this.#followControlledContentPolicy(
        read,
        slices,
        reader,
        staged,
      );
      if (outcome === undefined) policy = staged.controlledContentPolicy!;
      return outcome;
    };
    const index = SourceVisibilityBoundaryIndex.beginBuild(
      document,
      window,
      MAX_HTML_MIRROR_NODES,
    );
    let assembly: HtmlMirrorCheckpointAssembly | undefined;
    let sequence: number | undefined;
    let partCount = 0;
    let partBytes = 0;
    // Checks and sends a step's fills as the next part; false when they
    // cannot be sent (over a limit, or refused by the checks).
    const sendPart = (
      fills: readonly HtmlMirrorCheckpointFill[],
      checked: HtmlMirrorCheckpointAssembly,
    ): boolean => {
      sequence ??= this.#partsCheckpointSequence();
      const part = createHtmlMirrorCheckpointPart(
        this.#identityAt(sequence),
        partCount,
        fills,
        fidelityPolicy,
        checked,
      );
      partBytes += part?.byteLength ?? 0;
      if (!part || partBytes > MAX_HTML_MIRROR_BYTES) return false;
      this.#post(part);
      partCount += 1;
      return true;
    };
    // The first step's fills, held until the preview is sent: the parts
    // carry the sequence after the preview's.
    let heldFills: readonly HtmlMirrorCheckpointFill[] | undefined;
    // The children staged so far of each node whose list goes on in a
    // later fill (`more`, D163).
    const continued = new Map<number, Node[]>();
    try {
      for (;;) {
        const readStarted = now();
        const step = this.#withoutOwnLateRoots(() => reader.step(slices.reading));
        const readMs = now() - readStarted;
        if (step.outcome === 'restart') return 'restart';
        if (step.outcome === 'overflow' || step.outcome === 'failed') {
          this.#failCheckpointRead(representability, step.outcome === 'overflow');
          return 'ended';
        }
        const root = step.root;
        if (step.outcome === 'done' && !assembly) {
          // Read whole in one step: the checkpoint of before, in this task.
          const values = step.document;
          const checkpoint = root && values && createHtmlMirrorCheckpoint(
            this.#identityAt(this.#wholeCheckpointSequence()),
            {
              root,
              adoptedStyleSheets: values.adoptedStyleSheets,
              documentMode: values.documentMode,
              captureMs: Math.max(0, now() - startedAt),
              viewportWidth: values.viewportWidth,
              viewportHeight: values.viewportHeight,
              documentWidth: values.documentWidth,
              documentHeight: values.documentHeight,
              representability: this.#summarizeRepresentability(representability),
            },
            fidelityPolicy,
          );
          if (!checkpoint) {
            this.#failCheckpointRead(representability, Boolean(root));
            return 'ended';
          }
          this.#stageReadStep(staged, index, step.fills, step, root, continued);
          this.#installCheckpoint(read, checkpoint, staged, index.finish(), sizeAtStart);
          return 'ended';
        }
        if (root) {
          assembly = new HtmlMirrorCheckpointAssembly(fidelityPolicy);
          if (!assembly.readRoot(root)) {
            this.#failCheckpointRead(representability, true);
            return 'ended';
          }
        }
        if (!assembly) {
          this.#failCheckpointRead(representability, false);
          return 'ended';
        }
        // Marked and indexed in the task that read it: the index of what is
        // painted must hold what was read, not what the page shows after a
        // turn of its own.
        const stageStarted = now();
        this.#stageReadStep(staged, index, step.fills, step, root, continued);
        slices.noteStep(readMs, now() - stageStarted);
        // A step whose reading and staging used the slice sends its part
        // in the next one (D163): the checks of the part are work too.
        let yielded = false;
        if (step.fills.length > 0 && !offerPreview && slices.clock.expired()) {
          await slices.next();
          const turned = await afterTurn();
          if (turned) return turned;
          yielded = true;
        }
        if (step.fills.length > 0) {
          if (offerPreview) {
            heldFills = step.fills;
          } else if (!sendPart(step.fills, assembly)) {
            this.#failCheckpointRead(representability, true);
            return 'ended';
          }
        }
        if (step.outcome === 'done') {
          const values = step.document;
          const checkpoint = values && sequence !== undefined &&
            assembly.readAdoptedStyleSheets(values.adoptedStyleSheets) &&
            assembly.pendingShells === 0
            ? assembly.shellCheckpoint(
                this.#identityAt(sequence),
                {
                  documentMode: values.documentMode,
                  captureMs: Math.max(0, now() - startedAt),
                  viewportWidth: values.viewportWidth,
                  viewportHeight: values.viewportHeight,
                  documentWidth: values.documentWidth,
                  documentHeight: values.documentHeight,
                  representability: this.#summarizeRepresentability(
                    representability,
                  ),
                },
                partCount,
              )
            : undefined;
          if (
            !checkpoint ||
            partBytes + checkpoint.payload.byteLength > MAX_HTML_MIRROR_BYTES
          ) {
            this.#failCheckpointRead(representability, true);
            return 'ended';
          }
          this.#installCheckpoint(read, checkpoint, staged, index.finish(), sizeAtStart);
          return 'ended';
        }
        if (!yielded || slices.clock.expired()) {
          await slices.next();
          const turned = await afterTurn();
          if (turned) return turned;
        }
        if (offerPreview) {
          // The read does not fit one slice: the panel is shown a preview
          // meanwhile, in a task of its own (D163).
          offerPreview = false;
          if (this.#postPreview(policy)) {
            await slices.next();
            const turned = await afterTurn();
            if (turned) return turned;
          }
          if (heldFills && !sendPart(heldFills, assembly)) {
            this.#failCheckpointRead(representability, true);
            return 'ended';
          }
          heldFills = undefined;
          // The held part had this slice: the next step reads in its own.
          if (slices.clock.expired()) {
            await slices.next();
            const turned = await afterTurn();
            if (turned) return turned;
          }
        }
      }
    } catch (error) {
      if (!this.#readIsCurrent(read)) return 'ended';
      if (
        error instanceof HtmlMirrorCapacityError &&
        !error.diagnosticRecorded
      ) {
        incrementSourceRepresentability(
          representability,
          'capacityOmissionCount',
        );
      }
      this.#failCheckpointRead(representability, false);
      return 'ended';
    } finally {
      // Nothing of a slice outlives it, whichever way the read ends here.
      this.#closeSliceRootWalk();
    }
  }

  /**
   * Marks what a step read into the read's own structures, and adds it to
   * the read's own index of what is painted (D163): the mirror's are left
   * as they are until the checkpoint is sent.
   */
  #stageReadStep(
    staged: MirroredGraphState,
    index: ReturnType<typeof SourceVisibilityBoundaryIndex.beginBuild>,
    fills: readonly HtmlMirrorCheckpointFill[],
    step: {
      readonly indexRoots: readonly { readonly element: Element; readonly includeSelf: boolean }[];
      readonly deferred: ReadonlySet<Element>;
    },
    root: HtmlMirrorElementNode | undefined,
    continued: Map<number, Node[]>,
  ): void {
    this.#exchangeMirroredGraphState(staged);
    try {
      if (root) this.#markMirroredGraph(root);
      for (const fill of fills) {
        const target = this.environment.registry.getNode(fill.nodeId);
        for (const child of fill.children) this.#markMirroredGraph(child);
        if (!target) continue;
        // A list read over several fills is the node's children once its
        // last fill is staged (D163).
        const sources = continued.get(fill.nodeId) ?? [];
        for (const child of fill.children) {
          const source = this.environment.registry.getNode(child.id);
          if (source) sources.push(source);
        }
        if (fill.more) {
          continued.set(fill.nodeId, sources);
        } else {
          continued.delete(fill.nodeId);
          this.#setEmittedSourceChildren(target, sources);
        }
      }
    } finally {
      this.#exchangeMirroredGraphState(staged);
    }
    // One paint memo for the step's roots (D186): they are staged in one
    // task, and a memo of each root's own read its ancestors' style and
    // boxes again for every one of them (26–43 ms a step on a box of
    // 131,000 children, whose children are each a root).
    const paintCache = createSourcePaintScanCache();
    for (const indexRoot of step.indexRoots) {
      index.add(indexRoot.element, {
        includeSelf: indexRoot.includeSelf,
        stopAt: step.deferred,
        paintCache,
      });
    }
  }

  #createMirroredGraphState(
    policy: SourceControlledContentPolicy,
  ): MirroredGraphState {
    return {
      mirroredNodes: new WeakSet<Node>(),
      mirroredOpaqueSecrets: new WeakSet<Element>(),
      emittedChildren: new WeakMap<Node, readonly Node[]>(),
      emittedParent: new WeakMap<Node, Node>(),
      emittedNodeSignatures: new WeakMap<Node, string>(),
      shadowHostCandidates: [],
      knownShadowHostCandidates: new WeakSet<Element>(),
      shadowDiscoveryCursor: 0,
      mirroredImageCandidates: [],
      knownMirroredImageCandidates: new WeakSet<Element>(),
      selectedImageSources: new WeakMap<Element, string>(),
      controlledContentPolicy: policy,
      adoptedStyleSignatures: new StableSignatureTracker(
        STYLE_CHANGE_STABILITY_OBSERVATIONS,
      ),
    };
  }

  /** Swaps what the mirror holds with `state`: twice puts both back. */
  #exchangeMirroredGraphState(state: MirroredGraphState): void {
    [this.#mirroredNodes, state.mirroredNodes] =
      [state.mirroredNodes, this.#mirroredNodes];
    [this.#mirroredOpaqueSecrets, state.mirroredOpaqueSecrets] =
      [state.mirroredOpaqueSecrets, this.#mirroredOpaqueSecrets];
    [this.#emittedChildren, state.emittedChildren] =
      [state.emittedChildren, this.#emittedChildren];
    [this.#emittedParent, state.emittedParent] =
      [state.emittedParent, this.#emittedParent];
    [this.#emittedNodeSignatures, state.emittedNodeSignatures] =
      [state.emittedNodeSignatures, this.#emittedNodeSignatures];
    [this.#shadowHostCandidates, state.shadowHostCandidates] =
      [state.shadowHostCandidates, this.#shadowHostCandidates];
    [this.#knownShadowHostCandidates, state.knownShadowHostCandidates] =
      [state.knownShadowHostCandidates, this.#knownShadowHostCandidates];
    [this.#shadowDiscoveryCursor, state.shadowDiscoveryCursor] =
      [state.shadowDiscoveryCursor, this.#shadowDiscoveryCursor];
    [this.#mirroredImageCandidates, state.mirroredImageCandidates] =
      [state.mirroredImageCandidates, this.#mirroredImageCandidates];
    [this.#knownMirroredImageCandidates, state.knownMirroredImageCandidates] =
      [state.knownMirroredImageCandidates, this.#knownMirroredImageCandidates];
    [this.#selectedImageSources, state.selectedImageSources] =
      [state.selectedImageSources, this.#selectedImageSources];
    // The copy brings its own policy: a read begun before it is dropped.
    this.#cancelPolicyRefresh();
    [this.#controlledContentPolicy, state.controlledContentPolicy] =
      [state.controlledContentPolicy, this.#controlledContentPolicy];
    [this.#adoptedStyleSignatures, state.adoptedStyleSignatures] =
      [state.adoptedStyleSignatures, this.#adoptedStyleSignatures];
  }

  /** Today's answer to a read that cannot be sent: over a limit, or rejected. */
  #failCheckpointRead(
    representability: HtmlMirrorRepresentabilityCollector,
    overLimit: boolean,
  ): void {
    if (overLimit && representability.capacityOmissionCount === 0) {
      incrementSourceRepresentability(
        representability,
        'capacityOmissionCount',
      );
    }
    this.#checkpointRead = undefined;
    this.#post(createHtmlMirrorError(
      this.#identityAt(this.#sequence),
      representability.capacityOmissionCount > 0
        ? 'stream_overflow'
        : 'privacy_rejected',
      snapshotHtmlMirrorRepresentability(representability),
    ));
  }

  /**
   * The page read in one task, as before D163: after a read in slices
   * restarted `MAX_CHECKPOINT_READ_RESTARTS` times.
   */
  #readAndPostCheckpoint(read: CheckpointRead): void {
    const fidelityPolicy = this.#fidelityPolicy;
    if (!fidelityPolicy || !this.#identity || this.#disposed) return;
    const { document, window, registry, now } = this.environment;
    // A checkpoint sends the whole page, so it asks about every element's
    // root again instead of trusting an earlier "none": it holds every root
    // attached so far, as it always did for open ones (D125).
    const rootWalk = beginSourceShadowRootWalk({ fresh: true });
    // The page's script animations are listed, tree by tree as the read
    // enters each, and what they hold is read with each element's style.
    const heldPass = beginSourceHeldAnimationPass(document, true, now);
    const startedAt = now();
    const representability = createHtmlMirrorRepresentabilityCollector();
    try {
      heldPass.list(document);
      const sizeAtStart = this.#readObservedSize();
      const controlledContentPolicy = createSourceControlledContentPolicy(
        document,
        window,
        MAX_HTML_MIRROR_NODES,
      );
      // Built after every change kept so far, as the copy is read (D171).
      read.policyChecked = read.records.length;
      read.policyStale = false;
      read.policyRequeue.clear();
      const graph = sanitizeSourceDocument(
        document,
        window,
        registry,
        representability,
        fidelityPolicy,
        controlledContentPolicy,
        this.#slotReadings,
      );
      const checkpoint = graph && createHtmlMirrorCheckpoint(
        this.#identityAt(this.#wholeCheckpointSequence()),
        {
          root: graph.root,
          adoptedStyleSheets: graph.adoptedStyleSheets,
          documentMode: graph.documentMode,
          captureMs: Math.max(0, now() - startedAt),
          viewportWidth: graph.viewportWidth,
          viewportHeight: graph.viewportHeight,
          documentWidth: graph.documentWidth,
          documentHeight: graph.documentHeight,
          representability: this.#summarizeRepresentability(representability),
        },
        fidelityPolicy,
      );
      if (!checkpoint) {
        this.#failCheckpointRead(representability, Boolean(graph));
        return;
      }
      const staged = this.#createMirroredGraphState(controlledContentPolicy);
      this.#exchangeMirroredGraphState(staged);
      try {
        this.#markMirroredGraph(checkpoint.payload.root);
      } finally {
        this.#exchangeMirroredGraphState(staged);
      }
      const index = new SourceVisibilityBoundaryIndex(
        document,
        window,
        MAX_HTML_MIRROR_NODES,
      );
      this.#installCheckpoint(read, checkpoint, staged, index, sizeAtStart);
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
      this.#failCheckpointRead(representability, false);
    } finally {
      heldPass.end();
      rootWalk.end();
    }
  }

  /**
   * Puts a read's structures in place of the mirror's and sends its
   * checkpoint, in one task (D163); then reports the panes met while it
   * was read, and judges what the page did meanwhile against the new copy.
   */
  #installCheckpoint(
    read: CheckpointRead,
    checkpoint: HtmlMirrorCheckpoint,
    staged: MirroredGraphState,
    index: SourceVisibilityBoundaryIndex,
    sizeAtStart: string | undefined,
  ): void {
    const { document } = this.environment;
    this.#exchangeMirroredGraphState(staged);
    this.#stylePollingCursor = 0;
    this.#adoptedStyleSignatures.prime(
      document,
      adoptedStyleSignature(checkpoint.payload.adoptedStyleSheets),
    );
    this.#ordinaryStyleSignatures.reset();
    this.#cancelComparison();
    this.#visibilityBoundaryIndex?.dispose();
    this.#visibilityBoundaryIndex = index;
    // The index has just compared the whole page. The resize observer can
    // tell only the size of <html> and <body>, and its first report comes
    // after every read (its first observation): at the size read here it
    // tells nothing new. Changes made since reach the index as at any other
    // time (mutations, events, the style poll). Before, that report compared
    // the whole page again, 200 ms of a page of 54,000 elements (D162).
    this.#comparedAtSize = this.#readObservedSize();
    // Read in slices, the index was built over several tasks: when the size
    // changed meanwhile, what was read first may be painted otherwise now
    // (D163). Read in one task, the two sizes are one.
    if (this.#comparedAtSize !== sizeAtStart) {
      this.#visibilityFullRefreshPending = true;
    }
    this.#wholeComparisonsSeen = 0;
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
    this.#rootAttachedDuringRead = false;
    this.#notingUnheldShadowRoots = true;
    try {
      this.#observeShadowRoots(sourceProperty(document, 'documentElement'));
    } finally {
      this.#notingUnheldShadowRoots = false;
    }
    this.#primeOrdinaryStyleSignatures();
    // A root attached between the slices to an element read without one is
    // not in the copy: another checkpoint follows its ACK.
    this.#shadowReconciliationPending = this.#rootAttachedDuringRead;
    // The whole page was read: nothing of it is owed but what changed in
    // its slices after it was read (D163).
    this.#heldChanged = new Set(read.held);
    this.#heldLook = { every: 1, in: 1 };
    this.#checkpointRead = undefined;
    this.#releaseAckHold();
    this.#post(checkpoint);
    // A pane scrolled before this mirror was built fires no event: the
    // scrolled ones were met while the page was sent, so the first report
    // puts them at their place. The replica is built anew, so this report
    // carries the whole pane list.
    this.#takeMetPanes();
    this.#postScroll(false, true);
    this.#scheduleShadowDiscovery();
    // Read already when the policy was read again between the slices, and
    // moved by it (D171): sent again after the ACK under the new policy.
    for (const target of read.policyRequeue) {
      if (!target.isConnected || !this.#mirroredNodes.has(target)) continue;
      this.#queueReadWithChildren(target);
    }
    // What the page changed while it was read in slices: each record is
    // judged against the copy just sent, as any record after it is, and
    // what changed in what was read already is patched after the ACK.
    // The records judged against the policy between the slices need no
    // second look at it; when others may move it, it is read again in
    // slices and the first flush waits for it (D171).
    if (read.records.length > 0) {
      const policy = this.#controlledContentPolicy;
      this.#replayPolicy = policy && (
        read.policyStale ||
        sourceControlledContentMutationsMayChange(
          read.records.slice(read.policyChecked),
          policy,
        )
      ) ? 'sliced' : 'skip';
      try {
        this.#onMutations(read.records);
      } finally {
        this.#replayPolicy = undefined;
      }
    }
    for (const target of read.loaded) this.#queueCapturedResourceRefresh(target);
  }

  #onMutations(records: MutationRecord[]): void {
    if (this.#disposed || !this.#identity) return;
    // One batch, which the page cannot interrupt: each record asks whether
    // its element is inside a secret, and the elements above are shared.
    const secretWalk = beginSourceSecretAncestorWalk();
    try {
      const read = this.#checkpointRead;
      if (read) this.#keepForCheckpointRead(read, records);
      else this.#queueMutationRecords(records);
    } catch {
      // An exception here used to drop the whole batch silently, after which
      // the replica drifted with no diagnostic. Reuse the bounded checkpoint
      // reconciliation signal: the receiver requests a fresh checkpoint and
      // the stream stays paused until that checkpoint is acknowledged.
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
    } finally {
      secretWalk.end();
    }
  }

  /**
   * While a checkpoint is read in slices (D163): the records are kept raw,
   * to be judged against the new copy once it is sent. The ledger of
   * secrets is not kept waiting: a node secret at any moment since
   * injection stays secret, and the slices read after see it so.
   */
  #keepForCheckpointRead(read: CheckpointRead, records: MutationRecord[]): void {
    rememberSourceMutationSecrets(
      records,
      this.environment.window,
      this.#secretClassifier(),
    );
    if (read.recordsOverflow) return;
    if (read.records.length + records.length > MAX_CHECKPOINT_READ_RECORDS) {
      // The page changed more than is worth judging piece by piece: the
      // read starts again.
      read.records = [];
      read.recordTargets.clear();
      read.recordsOverflow = true;
      return;
    }
    for (const record of records) {
      read.records.push(record);
      read.recordTargets.add(record.target);
    }
    if (read.recordTargets.size > MAX_HTML_MIRROR_PENDING_TARGETS) {
      // Replayed after the copy, these would overflow its first patch and
      // have it read again, and again while the page goes on (D163): the
      // read starts again, and after its restarts is read in one task.
      read.records = [];
      read.recordTargets.clear();
      read.recordsOverflow = true;
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
    // A `<style>` or `<link>` that changed: its owner's names are read
    // again before they are believed (D164).
    for (const record of records) this.#forgetStyleNamesOf(record);
    // A change of an attribute no style sheet of the page names, and that
    // has no effect of its own on what is painted, is sent and not compared
    // (D164); the names are looked up once for the batch.
    let names: SourceStyleNames | undefined | null = null;
    const mentionedNames = (): SourceStyleNames | undefined =>
      names === null ? (names = this.#mentionedStyleNames()) : names;
    const visibilityRecords = this.#visibilityBoundaryIndex
      ? records.filter((record) =>
          belongsToSourceDocument(record.target, this.environment.document) &&
          !sourceVisibilityMutationMaySkip(record, mentionedNames)
        )
      : [];
    if (this.#visibilityBoundaryIndex && visibilityRecords.length > 0) {
      visibilityQueued = true;
      if (
        !this.#hidingClassPending &&
        visibilityRecords.some((record) =>
          sourceClassChangeNamesHidingRule(record, mentionedNames()))
      ) this.#hidingClassPending = true;
      if (
        this.#visibilityMutationOverflow ||
        this.#visibilityMutationRecords.length + visibilityRecords.length >
          MAX_VISIBILITY_MUTATION_RECORDS
      ) {
        this.#visibilityMutationRecords = [];
        this.#visibilityMutationOverflow = true;
      } else {
        for (const item of visibilityRecords) this.#visibilityMutationRecords.push(item);
      }
    }
    const replayPolicy = this.#replayPolicy;
    if (replayPolicy === 'sliced') {
      // The replay of a read's kept changes (D171): the policy is read
      // again in slices with the first flush held, not whole in the task
      // that installs the copy (45–75 ms at 54,000–72,000 elements).
      this.#beginPolicyRefresh(true);
    } else if (
      replayPolicy === undefined && this.#controlledContentPolicy &&
      sourceControlledContentMutationsMayChange(
        records,
        this.#controlledContentPolicy,
      )
    ) {
      accepted = this.#refreshControlledContentPolicy() || accepted;
    }
    // One bounded walk per batch: nested records share the visited set so a
    // descendant subtree is not traversed again for each ancestor record.
    const walk: ShadowObservationWalk = {
      ...this.#createShadowObservationWalk(),
      resendHeldHosts: true,
    };
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
      // What an opaque placeholder stands for (a script, an iframe: D181)
      // is not in the mirror: its own changes change nothing there.
      if (mutationElement && this.#mirroredOpaqueSecrets.has(mutationElement)) {
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
          this.#queueReadWithChildren(structuralSelectOwner);
        } else {
          this.#queuePending(
            this.#pendingAttributes,
            record.target,
          );
          if (
            changesPrivacyContext ||
            SOURCE_CHILD_READING_ATTRIBUTES.has(record.attributeName ?? '')
          ) this.#readWithChildren.add(record.target);
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
    const root = sourceProperty(this.environment.document, 'documentElement');
    if (!root || !this.#mirroredNodes.has(root)) return;
    this.#queuePending(this.#pendingAttributes, root);
    this.#scheduleFlush();
  }

  /**
   * Holds what changed for the panel's ACK (D164). The first hold sets a
   * timer: a panel that has not answered when it fires gets the overflow
   * it got before D164, and asks for a fresh copy.
   */
  #holdForAck(): void {
    if (this.#heldForAck) return;
    this.#heldForAck = true;
    this.#ackHoldTimer = this.environment.setTimer(() => {
      this.#ackHoldTimer = undefined;
      if (this.#disposed || !this.#heldForAck || !this.#identity) return;
      this.#heldForAck = false;
      this.#paused = true;
      this.#post(createHtmlMirrorError(
        this.#identityAt(this.#sequence),
        'stream_overflow',
      ));
    }, ACK_HOLD_LIMIT_MS);
  }

  /** An ACK, a checkpoint or the end of the session ends the hold. */
  #releaseAckHold(): void {
    this.#heldForAck = false;
    if (this.#ackHoldTimer === undefined) return;
    this.environment.clearTimer(this.#ackHoldTimer);
    this.#ackHoldTimer = undefined;
  }

  #flush(): void {
    const fidelityPolicy = this.#fidelityPolicy;
    if (
      this.#disposed || !this.#identity || !fidelityPolicy || this.#paused
    ) return;
    // The policy is read again after a copy (D171): its end flushes.
    if (this.#policyRefreshHoldsFlush) return;
    if (
      this.#sequence - this.#acknowledged >=
      MAX_HTML_MIRROR_UNACKED_BATCHES
    ) {
      // The panel is a full window of batches behind. What changed stays
      // pending (a change of the same node joins it) and goes out with the
      // next ACK. Before D164 this was an overflow and a fresh copy: once
      // the comparison no longer took a few hundred milliseconds of every
      // frame, a page changing every frame outran a panel that applies a
      // patch to a mirror of 54,000 elements in 160-180 ms. A panel that
      // stops answering still ends in the pending targets' overflow, or,
      // when nothing more changes, in the overflow of a hold no ACK ends.
      this.#holdForAck();
      return;
    }
    // Something happened on the page: the periodic look is half a second off.
    this.#heldLook = { every: 1, in: 1 };
    // One walk of the roots for all of it: what is painted is asked about
    // the children of the same hosts as what is sent (a closed root that
    // assigns 4,000 nodes by script had its slots' lists gone through once
    // a child).
    const rootWalk = beginSourceShadowRootWalk();
    // And one answer an element about the secrets above it, and about the
    // hidden and private regions above it (D181).
    const secretWalk = beginSourceSecretAncestorWalk();
    const withheldWalk = beginSourceWithheldAncestorWalk();
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
      withheldWalk.end();
      secretWalk.end();
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
    if (this.#readsInsidePanelWithControl()) {
      // What is read inside a panel is judged by the policy as it is now.
      this.#controlledLayoutSettlePending = false;
      this.#refreshControlledContentPolicy();
      if (this.#paused || this.#shadowReconciliationPending) return;
    } else if (this.#controlledLayoutSettlePending) {
      // The end of a transition or an animation: read in slices (D165).
      this.#controlledLayoutSettlePending = false;
      this.#beginPolicyRefresh();
    }
    if (this.#visibilityBoundaryIndex) {
      this.#compareWhatIsPainted(this.#visibilityBoundaryIndex);
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
   * Compares what the page paints, as the flush asks (D164). A comparison
   * that fits one slice runs, and is applied, in this flush, with no await
   * on the way, as before. A longer one goes on in slices with a turn for
   * the page between them; later flushes read and send the page's changes
   * meanwhile and start no second comparison, and its end applies it and
   * asks for a flush. The requests are taken when it starts: one that comes
   * while it runs is kept for the next. With the semantic scan it keeps to
   * a fifth of the tab's time, and waits for it.
   */
  #compareWhatIsPainted(index: SourceVisibilityBoundaryIndex): void {
    // Running: its end applies it, and what asked since waits.
    if (this.#comparisonRun) return;
    const mutationRecords = this.#visibilityMutationRecords;
    const requiresFullRefresh = this.#visibilityFullRefreshPending ||
      this.#visibilityMutationOverflow ||
      this.#visibilityInteractionTargets.size > 0;
    if (!requiresFullRefresh && mutationRecords.length === 0) {
      // Only what script animations hold changed: compared within the
      // elements that hold it, in this task (a part, not the page).
      const refresh = index.refreshWithin([...this.#heldAnimationTargets]);
      this.#heldAnimationTargets.clear();
      this.#applyComparison(index, refresh);
      return;
    }
    if (
      this.#waitForComparisonShare(
        this.#userInputPending,
        this.#hidingClassPending,
      )
    ) return;
    this.#userInputPending = false;
    this.#hidingClassPending = false;
    this.#visibilityMutationRecords = [];
    this.#visibilityMutationOverflow = false;
    this.#visibilityFullRefreshPending = false;
    this.#visibilityInteractionTargets.clear();
    const styleOptions = this.#comparisonStyleOptions(
      requiresFullRefresh,
      mutationRecords,
    );
    // Either of the first two compares the whole page, the elements whose
    // held values changed with it.
    this.#heldAnimationTargets.clear();
    const comparison = requiresFullRefresh
      ? index.beginRefreshAll(styleOptions)
      : index.beginRefreshMutations(mutationRecords, styleOptions);
    const now = this.environment.now;
    const clock = createSliceClock({
      now,
      yield: this.environment.yieldToMain ?? yieldToMain,
      budgetMs: LIVE_SLICE_BUDGET_MS,
    });
    let looks = 0;
    const run: ComparisonRun = {
      generation: (this.#comparisonGeneration += 1),
      index,
      comparison,
      clock,
      expired: () =>
        (looks += 1) % COMPARISON_CLOCK_EVERY === 0 && clock.expired(),
      busyMs: 0,
      yielded: false,
      sizeAtStart: undefined,
    };
    this.#comparisonRun = run;
    // The semantic scan does not start while the comparison runs (D164).
    this.environment.passShare?.begin(this);
    this.#continueComparison(run, true);
  }

  /**
   * Whether the comparison keeps the style answers it reads, and whether it
   * may answer from those the last one kept (D186). Kept only where a change
   * of text alone cannot restyle anything: no sheet holds a pseudo-class
   * that reads text or a rule that reads layout, and nothing animates.
   * Recalled only for a batch of text changes outside any style sheet, with
   * the very names the answers were kept under (a sheet changed since gives
   * other names, or none), and nothing else asked for since: an event, a
   * held animation value, a resize or a slot asks for a whole comparison,
   * which keeps answers afresh.
   */
  #comparisonStyleOptions(
    requiresFullRefresh: boolean,
    records: readonly MutationRecord[],
  ): { readonly keepStyles?: boolean; readonly stylesUnchanged?: boolean } {
    const kept = this.#styleMemoryNames;
    this.#styleMemoryNames = undefined;
    // Only a batch of text changes is looked at: any other comparison keeps
    // nothing, and the first of such batches keeps for the next.
    if (
      requiresFullRefresh || records.length === 0 ||
      !records.every((record) => {
        if (record.type !== 'characterData') return false;
        const parent = record.target.parentNode;
        return !parent || sourceNodeType(parent) !== 1 ||
          String(sourceLocalName(parent as Element)).toLowerCase() !== 'style';
      })
    ) return {};
    const names = this.#mentionedStyleNames();
    const document = this.environment.document;
    let quiet = !sourceTextChangeMayRestyle(names, records) &&
      !readSourceAnimationListing(document).running;
    if (quiet) {
      // The ledger lists at each change sent; an animation a script started
      // since, with no change to the page, is seen here.
      try {
        const read = (document as { getAnimations?: () => readonly unknown[] })
          .getAnimations;
        quiet = typeof read === 'function' && read.call(document).length === 0;
      } catch {
        quiet = false;
      }
    }
    if (!quiet) return {};
    this.#styleMemoryNames = names;
    return {
      keepStyles: true,
      stylesUnchanged: kept === names && this.#heldAnimationTargets.size === 0,
    };
  }

  /**
   * Runs a slice of the comparison in this task (D164). Each slice touches
   * the comparison's hold on the page: a long one keeps it.
   */
  #continueComparison(run: ComparisonRun, inFlush: boolean): void {
    const now = this.environment.now;
    this.environment.passShare?.touch(this);
    const startedAt = now();
    let refresh: SourceVisibilityBoundaryRefresh | undefined;
    try {
      refresh = run.comparison.step(run.expired);
    } catch (error) {
      run.busyMs += now() - startedAt;
      if (this.#comparisonRun === run) {
        this.#comparisonRun = undefined;
        this.#endPassShare(run.busyMs);
      }
      throw error;
    }
    run.busyMs += now() - startedAt;
    if (!this.#comparisonIsCurrent(run)) return;
    if (!refresh) {
      if (!run.yielded) {
        run.yielded = true;
        // Nothing of the page changed in this task: its size is the size
        // the comparison began at.
        if (run.comparison.whole) run.sizeAtStart = this.#readObservedSize();
      }
      void this.#continueComparisonAfterTurn(run);
      return;
    }
    this.#finishComparison(run, refresh, inFlush);
  }

  async #continueComparisonAfterTurn(run: ComparisonRun): Promise<void> {
    try {
      await run.clock.next();
    } catch {
      // A turn that cannot be given: the comparison goes on now.
    }
    if (!this.#comparisonIsCurrent(run)) return;
    if (this.#paused) {
      // The stream stopped for a recovery, which reads the page whole.
      this.#cancelComparison();
      this.#visibilityFullRefreshPending = true;
      return;
    }
    // A slice opens its own walk of the roots, as a flush does.
    const rootWalk = beginSourceShadowRootWalk();
    const secretWalk = beginSourceSecretAncestorWalk();
    try {
      this.#continueComparison(run, false);
    } catch {
      // What cannot be compared is read whole.
      if (!this.#disposed && this.#identity && !this.#paused) {
        this.#applyVisibilityBoundaryRefresh({
          changedTargets: [],
          overflow: true,
        });
      }
    } finally {
      secretWalk.end();
      rootWalk.end();
    }
  }

  #comparisonIsCurrent(run: ComparisonRun): boolean {
    return !this.#disposed && this.#comparisonRun === run &&
      run.generation === this.#comparisonGeneration &&
      this.#visibilityBoundaryIndex === run.index;
  }

  /**
   * The comparison ended: its busy time goes to the share, what it found
   * is queued, and, when it ended after turns, a flush sends it. A
   * comparison of the whole page in slices notes the size it ended at and
   * asks for another when that is not the size it began at (D163's rule);
   * one in a single task notes the size as before.
   */
  #finishComparison(
    run: ComparisonRun,
    refresh: SourceVisibilityBoundaryRefresh,
    inFlush: boolean,
  ): void {
    this.#comparisonRun = undefined;
    this.environment.passShare?.note(run.busyMs, this);
    if (run.yielded && run.comparison.whole) {
      this.#wholeComparisonsSeen = run.index.wholeComparisons;
      this.#comparedAtSize = this.#readObservedSize();
      if (this.#comparedAtSize !== run.sizeAtStart) {
        this.#visibilityFullRefreshPending = true;
      }
      this.#applyComparison(run.index, refresh, false);
    } else {
      this.#applyComparison(run.index, refresh);
    }
    if (!inFlush) this.#scheduleFlush(true);
  }

  #applyComparison(
    index: SourceVisibilityBoundaryIndex,
    refresh: SourceVisibilityBoundaryRefresh,
    noteSize = true,
  ): void {
    if (noteSize) this.#noteComparedSize();
    // Chrome gives a pane that is shown again its old scroll offset, with
    // no scroll event.
    for (const element of index.takeShownElements()) this.#meetPane(element);
    this.#applyVisibilityBoundaryRefresh(refresh);
    if (this.#paused || this.#shadowReconciliationPending) return;
    this.#askDeclaredHiddenAgain();
  }

  #cancelComparison(): void {
    const run = this.#comparisonRun;
    if (!run) return;
    this.#comparisonRun = undefined;
    this.#comparisonGeneration += 1;
    this.#endPassShare(run.busyMs);
    run.comparison.cancel();
  }

  /**
   * A comparison ended before its end (cancelled, or failed): the work it
   * did goes to the share all the same, so a page that keeps cancelling
   * comparisons still waits for its rest (D164). One that did none frees
   * the page with no rest.
   */
  #endPassShare(busyMs: number): void {
    const share = this.environment.passShare;
    if (!share) return;
    if (busyMs > 0) share.note(busyMs, this);
    else share.release(this);
  }

  /**
   * Whether the comparison must wait for its share of the tab's time
   * (D164); if so, a timer asks for a flush when the wait is over, and the
   * requests stay as they are.
   */
  #waitForComparisonShare(userInput: boolean, hidingClass = false): boolean {
    const share = this.environment.passShare;
    if (!share) return false;
    // A person's input waits only for a pass that holds the page; so does
    // a class a hiding rule names, while the share owes little (D180). The
    // pass's time is noted all the same, and its rest comes on top of what
    // is owed: a carousel that keeps changing such a class runs ahead by
    // that much at most and keeps to the fifth over time.
    const ahead = hidingClass &&
      share.waitMs(this) <= HIDING_CLASS_MAX_ADVANCE_MS;
    const wait = share.waitMs(this, userInput || ahead);
    if (!(wait > 0)) return false;
    if (this.#comparisonShareTimer === undefined) {
      this.#comparisonShareTimer = this.environment.setTimer(() => {
        this.#comparisonShareTimer = undefined;
        this.#scheduleFlush(true);
      }, wait);
    }
    return true;
  }

  /**
   * Drops the names of an owner of sheets when the record's target is a
   * `<style>` or `<link>` (or text inside a `<style>`), or one was added or
   * removed (D164). That is all it sees: a sheet changed any other way (a
   * rule inserted, a sheet adopted or disabled) is found by `stillAsRead`,
   * whose look at the sheets and their rule counts turns the skip off
   * until the poll reads the names again.
   */
  #forgetStyleNamesOf(record: MutationRecord): void {
    const isSheetOwner = (node: Node | null | undefined): boolean => {
      if (!node || sourceNodeType(node) !== 1) return false;
      const tag = String(sourceLocalName(node as Element)).toLowerCase();
      return tag === 'style' || tag === 'link';
    };
    let owner: Node | null | undefined;
    if (record.type === 'characterData') {
      if (isSheetOwner(record.target.parentNode)) owner = record.target;
    } else if (isSheetOwner(record.target)) {
      owner = record.target;
    } else if (record.type === 'childList') {
      for (const list of [record.addedNodes, record.removedNodes]) {
        for (const node of list) {
          if (isSheetOwner(node)) owner = record.target;
        }
      }
    }
    if (!owner) return;
    try {
      this.#styleNames.forget(owner.getRootNode());
    } catch {
      this.#styleNames.reset();
    }
  }

  /**
   * What the page's style sheets mention, for the image reader (D201):
   * nothing once this mirror has stopped, since its census is then no longer
   * told of changed sheets.
   */
  mentionedStyleNames(): SourceStyleNames | undefined {
    return this.#disposed ? undefined : this.#mentionedStyleNames();
  }

  /**
   * What the page's style sheets mention (D164), or undefined when every
   * name counts: some owner of sheets is not read whole yet, a sheet is
   * not as it was read, or the mirror does not know every root.
   */
  #mentionedStyleNames(): SourceStyleNames | undefined {
    if (
      this.#imageEventRoots.size >= MAX_IMAGE_EVENT_ROOTS ||
      this.#lateShadowRoots.length > 0 || this.#shadowReconciliationPending
    ) return undefined;
    const owners = this.#styleOwners();
    if (!owners.includes(this.environment.document)) return undefined;
    return this.#styleNames.names(owners);
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
    this.#readWithChildren.clear();
    if (!this.#rootsAwaitingPatchHeld()) return false;
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
    const html = sourceProperty(this.environment.document, 'documentElement');
    const dimensions = this.#pendingDimensions;
    if (turn === 'lists') {
      if (this.#pendingChildren.size === 0) return undefined;
      const held: HeldChanges = {
        children: [...this.#pendingChildren].filter(
          (node) => this.#changedInsideKeptChild(node),
        ),
        attributes: [...this.#pendingAttributes].filter(
          (node) => this.#changedInsideKeptChild(node) ||
            this.#attributesFollowList(node),
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
   * Whether an element's attributes, changed in the frame its own list of
   * children changed, can follow that list in a later patch (D180): its
   * list is then sent as "these stay, these are new" instead of whole.
   * Not when they change how its children are read (`#readWithChildren`),
   * and not for a dropdown, whose list is read whole anyway. Opening a
   * site's search put a class on `<body>` in the frame it added a child
   * to it, and the whole `<body>` was sent (635,226 characters).
   */
  #attributesFollowList(element: Element): boolean {
    return this.#pendingChildren.has(element) &&
      !this.#readWithChildren.has(element) &&
      this.#emittedChildren.has(element) &&
      !sourceNativeSelectStructuralOwner(element);
  }

  /**
   * Queues an element and its list of children to be read again in one
   * patch: what changed changes how its children are read (D180).
   */
  #queueReadWithChildren(element: Element): void {
    this.#queuePending(this.#pendingChildren, element);
    this.#queuePending(this.#pendingAttributes, element);
    if (this.#pendingAttributes.has(element)) this.#readWithChildren.add(element);
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
        (sourceNodeType(current) === Node.DOCUMENT_FRAGMENT_NODE && 'host' in current
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
          target === sourceProperty(this.environment.document, 'documentElement'))
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
            sourceProperty(this.environment.document, 'baseURI'),
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
          // A host sent again with its root comes as a new child (D190),
          // under the ids it has.
          const previous = new Set(capture.previous.filter(
            (source) => !this.#hostsSentAgain.has(source as Element),
          ));
          const newSources = capture.sources.filter(
            (source) => !previous.has(source),
          );
          if (
            capture.target === sourceProperty(this.environment.document, 'documentElement') &&
            sourceDocumentShellChanged(capture.previous, capture.sources)
          ) {
            // The page's own head or body moved, or `<html>` holds one
            // more: the mirror keeps its own two in place, so this is a
            // whole read. One put in place of the page's own comes as any
            // new child does, and the mirror's takes it in (D190).
            this.#shadowReconciliationPending = true;
            this.#signalShadowReconciliation();
            return undefined;
          }
          if (!askWithin(newSources)) return undefined;
          const serialized = sanitizeSourceSubtrees(
            newSources,
            this.environment.registry,
            sourceProperty(this.environment.document, 'baseURI'),
            representability,
            batchBudget,
            styleWork,
            fidelityPolicy,
            this.#slotReadings,
            this.#controlledContentPolicy,
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
          sourceProperty(this.environment.document, 'baseURI'),
          representability,
          fidelityPolicy,
          this.#controlledContentPolicy,
        );
        if (!attributes) throw new Error('Unsafe attributes patch.');
        const hints = sanitizeSourceElementHints(
          target,
          sourceProperty(this.environment.document, 'baseURI'),
          representability,
          fidelityPolicy,
          styleWork,
          this.#controlledContentPolicy,
          undefined,
          this.environment.registry,
        );
        if (sourceLocalName(target).toLowerCase() === 'img') {
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
          tagName: sourceLocalName(target).toLowerCase(),
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
          sourceProperty(this.environment.document, 'baseURI'),
          representability,
          fidelityPolicy,
          this.#slotReadings,
          this.#controlledContentPolicy,
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
        this.#clearPending(false);
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
      this.#clearPending(false);
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

  /**
   * `comparison` false: a patch was read. What asks for a comparison is
   * kept, since a comparison running in slices meanwhile did not see it
   * (D164); everything else that clears what is pending ends that one too.
   */
  #clearPending(comparison = true): void {
    this.#pendingChildren.clear();
    this.#hostsSentAgain.clear();
    this.#pendingAttributes.clear();
    this.#pendingText.clear();
    this.#pendingSheets.clear();
    this.#slotChanges.clear();
    this.#pendingSlotLists.clear();
    this.#pendingDimensions = false;
    this.#styleDerivedPending = false;
    this.#controlledLayoutSettlePending = false;
    // A patch of the frame was read: what a later patch of the same frame
    // takes back keeps its mark (`#readAndPostInTurns` clears it).
    if (!comparison) return;
    this.#readWithChildren.clear();
    this.#cancelComparison();
    this.#visibilityMutationRecords = [];
    this.#visibilityMutationOverflow = false;
    this.#visibilityInteractionTargets.clear();
    this.#userInputPending = false;
    this.#hidingClassPending = false;
    this.#visibilityFullRefreshPending = false;
  }

  readonly #onLayoutChange = (): void => this.#layoutChanged(true);

  /**
   * The layout changed, or may have. The frame that follows looks for new
   * roots, reads the relationships of controlled content again, compares
   * what is painted (`compare`), and reads the images and the page's size:
   * all of it once, however many events told of the change. The look and
   * the relationships used to be read at each event, each a walk of the
   * whole document: 300 `<style>` elements added in one go fire 300 `load`
   * events, and stopped a page of 20,000 elements for 16 s (D144).
   */
  #layoutChanged(compare: boolean): void {
    if (this.#disposed || !this.#identity) return;
    // While a checkpoint is read (D163) the look and the policy wait for
    // the copy: the read sees what is there when its slice comes, and the
    // frame after the ACK looks at the rest.
    if (this.#documentIsHidden() && !this.#checkpointRead) {
      // No animation frame comes in a tab that is not shown (another tab
      // in front, with the mirror in its own window): the look and the
      // read are made here, as they were before D144, or a root attached
      // late would wait for the rotation over waiting hosts.
      this.#lookForRootsAfterLayoutChange();
      this.#refreshControlledContentPolicy();
    } else {
      this.#layoutChangePending = true;
    }
    if (compare) this.#visibilityFullRefreshPending = true;
    this.#imageRefreshRequested = true;
    this.#pendingDimensions = true;
    this.#scheduleFlush();
    this.#postScroll();
  }

  /** Whether the page is in a tab that is not shown: no frame will come. */
  #documentIsHidden(): boolean {
    try {
      return sourceProperty(this.environment.document, 'visibilityState') === 'hidden';
    } catch {
      return false;
    }
  }

  /** In the frame, before its flush: what `#layoutChanged` left for it. */
  #takeLayoutChange(): void {
    if (
      !this.#layoutChangePending || this.#disposed || !this.#identity ||
      this.#paused
    ) return;
    this.#layoutChangePending = false;
    this.#lookForRootsAfterLayoutChange();
    // Read in slices from the next turn on (D165).
    this.#beginPolicyRefresh();
    // Asked for just now: the end of a transition in this frame asks no
    // second.
    this.#controlledLayoutSettlePending = false;
  }

  /**
   * The resize observer reports that the page or its body has another size
   * than it last reported. When that is the size the whole page was last
   * compared at, the comparison was made in this very frame, after the
   * change that the observer now reports (the observer speaks at the end of
   * the frame whose start ran the flush): there is nothing new to compare,
   * and the second walk of every element that used to follow each change
   * of the page's height is left out (D144). Everything else a change of
   * layout asks for is done as before.
   */
  readonly #onObservedResize = (): void => {
    // While a checkpoint is read in slices, its end compares the size it
    // began at with the size then (D163): the observer's first report comes
    // during the read and tells nothing more.
    if (this.#checkpointRead) {
      this.#layoutChanged(false);
      return;
    }
    // While the whole page is compared in slices, the size it began at is
    // the size compared at (D164).
    const run = this.#comparisonRun;
    const compared = run?.yielded && run.comparison.whole
      ? run.sizeAtStart
      : this.#comparedAtSize;
    this.#layoutChanged(
      compared === undefined || this.#readObservedSize() !== compared,
    );
  };

  /** After the comparison of a flush: when it was of the whole page, its size. */
  #noteComparedSize(): void {
    const whole = this.#visibilityBoundaryIndex?.wholeComparisons ?? 0;
    if (whole === this.#wholeComparisonsSeen) return;
    this.#wholeComparisonsSeen = whole;
    this.#comparedAtSize = this.#readObservedSize();
  }

  /**
   * The content boxes the resize observer watches, as numbers that are the
   * same exactly when those boxes are: each element's box, what its
   * scroll bars leave of it, its padding and its borders. Undefined when
   * they cannot be read, which never equals a size compared at.
   */
  #readObservedSize(): string | undefined {
    try {
      const view = this.environment.window;
      const parts: Array<string | number> = [];
      for (const element of [
        sourceProperty(this.environment.document, 'documentElement'),
        sourceProperty(this.environment.document, 'body'),
      ]) {
        if (!element) {
          parts.push('none');
          continue;
        }
        const rect = element.getBoundingClientRect();
        const style = view.getComputedStyle(element);
        const numbers: unknown[] = [
          rect.width, rect.height, element.clientWidth, element.clientHeight,
        ];
        const lengths: unknown[] = [
          style.paddingTop, style.paddingRight, style.paddingBottom,
          style.paddingLeft, style.borderTopWidth, style.borderRightWidth,
          style.borderBottomWidth, style.borderLeftWidth,
        ];
        // Numbers and lengths only: anything else (a field of a form that
        // a page has named `body`, standing in for a property) is no size.
        if (
          !numbers.every((value) => typeof value === 'number' && Number.isFinite(value)) ||
          !lengths.every((value) => typeof value === 'string')
        ) return undefined;
        for (const value of [...numbers, ...lengths]) parts.push(value as number | string);
      }
      return parts.join(' ');
    } catch {
      return undefined;
    }
  }

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
      // A root found on a host the mirror holds goes with its host in a
      // patch (D190).
      this.#observeShadowRoots(sourceProperty(this.environment.document, 'documentElement'), {
        ...this.#createShadowObservationWalk(),
        resendHeldHosts: true,
      });
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
    // While a checkpoint is read, nothing of the copy is the panel's yet:
    // the checkpoint's own report carries the whole state (D163).
    if (this.#disposed || !this.#identity || this.#checkpointRead) return;
    const documentScroll = this.#withoutCredentialLength(readDocumentScrollSnapshot(
      this.environment.document,
      this.environment.window,
    ));
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
        const read = readPaneScrollPlace(pane, this.environment.document);
        const place = read && this.#withoutCredentialLength(read, pane);
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
    // The boxes are read where the layout may have changed: a checkpoint,
    // a patch, a look; not for each frame of scroll events (D180).
    const paneBoxes = scrolledOnly && !wholeState && !this.#restatePaneBoxes
      ? undefined
      : this.#readPaneBoxes(wholeState);
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
      onlyIfMoved && !withPanes && !paneBoxes &&
      reportedPlace === this.#lastReportedPlace
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
        ...(paneBoxes ? { paneBoxes } : {}),
      },
    );
    if (!update) {
      // What the panel was told is no longer what is noted here.
      this.#restatePanes = true;
      if (paneBoxes) this.#restatePaneBoxes = true;
      return;
    }
    if (paneBoxes?.whole) this.#restatePaneBoxes = false;
    if (paneBoxes) this.#paneBoxesSent = paneBoxes.boxes.length > 0 || !paneBoxes.whole;
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
      const read = this.#mirroredOpaqueSecrets.has(pane)
        ? undefined
        : readPaneScrollPlace(pane, this.environment.document);
      if (!read) {
        this.#forgetPane(pane, dropped);
        continue;
      }
      const place = this.#withoutCredentialLength(read, pane);
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

  /**
   * Asks the elements met with more content than room whether the reader
   * can scroll them (an `overflow` of `auto`, `scroll` or `overlay` on an
   * axis with a range), in a time box (D180). The ones not asked yet wait
   * for the next read.
   */
  #takePaneBoxCandidates(): void {
    const candidates = this.#paneBoxCandidates;
    if (candidates.size === 0) return;
    const view = this.environment.window as Window & {
      getComputedStyle?: Window['getComputedStyle'];
    };
    if (typeof view.getComputedStyle !== 'function') {
      candidates.clear();
      return;
    }
    const clock = this.environment.now ?? (() => Date.now());
    const started = clock();
    for (const element of candidates) {
      candidates.delete(element);
      if (this.#paneBoxes.size >= MAX_HTML_MIRROR_PANE_BOXES) {
        candidates.clear();
        return;
      }
      if (this.#paneBoxes.has(element) || !element.isConnected) continue;
      let style: CSSStyleDeclaration;
      try {
        style = view.getComputedStyle(element);
      } catch {
        continue;
      }
      const scrolls = (value: string) => /^(?:auto|scroll|overlay)$/u.test(value);
      if (
        (scrolls(style.overflowY) && element.scrollHeight > element.clientHeight) ||
        (scrolls(style.overflowX) && element.scrollWidth > element.clientWidth)
      ) this.#paneBoxes.set(element, undefined);
      if (clock() - started >= PANE_BOX_LOOK_MS) return;
    }
  }

  /**
   * The boxes of the scrollable panes met (D180): with `whole` every one,
   * otherwise the ones whose box or ranges changed since the panel was
   * told, and a box of no size for each that is a pane no longer (gone,
   * hidden, or with no range). A pane the mirror holds no id for yet is
   * kept in mind and named after its patch.
   */
  #readPaneBoxes(wholeState: boolean): HtmlMirrorPaneBoxes | undefined {
    this.#takePaneBoxCandidates();
    const whole = wholeState || this.#restatePaneBoxes;
    if (this.#paneBoxes.size === 0) {
      return whole && this.#paneBoxesSent
        ? { version: HTML_MIRROR_PANE_BOXES_VERSION, whole: true, boxes: [] }
        : undefined;
    }
    const sourceWindow = this.environment.window;
    const offsetX = Number.isFinite(sourceWindow.scrollX) ? sourceWindow.scrollX : 0;
    const offsetY = Number.isFinite(sourceWindow.scrollY) ? sourceWindow.scrollY : 0;
    const round = (value: number) => Math.round(value * 100) / 100;
    const boxes: HtmlMirrorPaneBox[] = [];
    for (const [pane, told] of this.#paneBoxes) {
      const nodeId = this.#mirroredPaneId(pane);
      if (nodeId === undefined && pane.isConnected) {
        if (told) {
          if (!whole) boxes.push(noPaneBox(told.nodeId));
          this.#paneBoxes.set(pane, undefined);
        }
        continue;
      }
      const place = nodeId === undefined
        ? undefined
        : readPaneScrollPlace(pane, this.environment.document);
      let rect: DOMRect | undefined;
      try {
        rect = place ? pane.getBoundingClientRect() : undefined;
      } catch {
        rect = undefined;
      }
      if (
        nodeId === undefined || !place || !rect ||
        (place.maxScrollX === 0 && place.maxScrollY === 0) ||
        (rect.width <= 0 && rect.height <= 0)
      ) {
        // Met again when it is sent or shown again.
        this.#paneBoxes.delete(pane);
        if (told && !whole) boxes.push(noPaneBox(told.nodeId));
        continue;
      }
      const box: HtmlMirrorPaneBox = {
        nodeId,
        x: round(rect.left + offsetX),
        y: round(rect.top + offsetY),
        width: round(rect.width),
        height: round(rect.height),
        maxScrollX: place.maxScrollX,
        maxScrollY: place.maxScrollY,
      };
      if (
        whole || !told || told.nodeId !== box.nodeId ||
        told.x !== box.x || told.y !== box.y ||
        told.width !== box.width || told.height !== box.height ||
        told.maxScrollX !== box.maxScrollX || told.maxScrollY !== box.maxScrollY
      ) {
        if (told && told.nodeId !== box.nodeId && !whole) {
          boxes.push(noPaneBox(told.nodeId));
        }
        this.#paneBoxes.set(pane, box);
        boxes.push(box);
      }
    }
    if (!whole && boxes.length === 0) return undefined;
    return { version: HTML_MIRROR_PANE_BOXES_VERSION, whole, boxes };
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
    // More content than room: it may be a pane the wheel scrolls, at its
    // start or not (D180). Two more number reads; its overflow is asked
    // when the boxes are next read.
    if (
      !this.#paneBoxes.has(element) &&
      this.#paneBoxCandidates.size < MAX_PANE_BOX_CANDIDATES &&
      (element.scrollHeight > element.clientHeight ||
        element.scrollWidth > element.clientWidth)
    ) this.#paneBoxCandidates.add(element);
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
      sourceNodeType(target as Node) !== 1
    ) return;
    const element = target as Element;
    this.#visibilityInteractionTargets.add(element);
    const controlledMayChange = this.#controlledContentPolicy &&
      sourceControlledContentLayoutMayChange(
        element,
        this.#controlledContentPolicy,
      );
    // While a checkpoint is read (D163), kept for the index being built.
    if (
      !controlledMayChange && !this.#visibilityBoundaryIndex &&
      !this.#checkpointRead
    ) return;
    // A final transition/animation style can reveal or withdraw a selected
    // panel without another mutation. Refresh admission inside the same one
    // post-paint frame used for the resulting patch; bursts remain coalesced.
    this.#controlledLayoutSettlePending = Boolean(controlledMayChange);
    this.#pendingDimensions = true;
    this.#scheduleFlush();
  };

  readonly #onVisibilityInteraction = (event: Event): void => {
    const target = event.target;
    if (event.type === 'keydown' || event.type === 'beforeinput') {
      this.#freezeCredentialScroll(event);
    }
    if (event.type === 'beforeinput' || event.type === 'input') {
      this.#noteEditorWithoutAttribute(event);
    }
    if (
      this.#disposed || !this.#identity ||
      !target || typeof target !== 'object' ||
      sourceNodeType(target as Node) !== 1 ||
      (!this.#visibilityBoundaryIndex && !this.#checkpointRead)
    ) return;
    // A pointer, focus or key event no style sheet of the page reacts to
    // changes nothing painted: not compared (D164). A click, an input or a
    // toggle always is.
    if (
      !this.#checkpointRead &&
      sourceVisibilityEventMaySkip(event.type, () => this.#mentionedStyleNames())
    ) {
      // As a flush would: the page is in use, its animations looked at soon.
      this.#heldLook = { every: 1, in: 1 };
      return;
    }
    this.#visibilityInteractionTargets.add(target as Element);
    if (USER_INPUT_EVENTS.has(event.type)) this.#userInputPending = true;
    this.#scheduleFlush();
  };

  /**
   * A key or an input into a credential field sized by its content, before
   * the character is put in (D180): the places of the scrollers around it
   * on its inline axis are kept, and reported from then on.
   */
  #freezeCredentialScroll(event: Event): void {
    if (this.#disposed || !this.#identity) return;
    const target = (event.composedPath?.()[0] ?? event.target) as Node | null;
    if (
      !target || typeof target !== 'object' || sourceNodeType(target) !== 1 ||
      this.#credentialScrollFreezes.has(target as Element) ||
      this.#credentialScrollFreezes.size >= MAX_CREDENTIAL_SCROLL_FREEZES
    ) return;
    const field = target as Element;
    let axis: 'x' | 'y';
    try {
      if (!this.#secretClassifier().isSecret(field)) return;
      const style = this.environment.window.getComputedStyle(field);
      if (style.getPropertyValue('field-sizing').trim() !== 'content') return;
      const mode = style.getPropertyValue('writing-mode').trim();
      axis = mode.startsWith('vertical') || mode.startsWith('sideways') ? 'y' : 'x';
    } catch {
      return;
    }
    const frozen = (place: { readonly scrollX: number; readonly scrollY: number;
      readonly maxScrollX: number; readonly maxScrollY: number }) =>
      axis === 'x'
        ? { offset: place.scrollX, max: place.maxScrollX }
        : { offset: place.scrollY, max: place.maxScrollY };
    const panes = new Map<Element, { offset: number; max: number }>();
    let depth = 0;
    for (
      let node: Node | null = field.parentNode;
      node && depth < MAX_CREDENTIAL_SCROLL_ANCESTORS;
      depth += 1
    ) {
      if (sourceNodeType(node) === Node.DOCUMENT_FRAGMENT_NODE && 'host' in node) {
        node = (node as ShadowRoot).host;
        continue;
      }
      if (sourceNodeType(node) !== Node.ELEMENT_NODE) break;
      const place = readPaneScrollPlace(node as Element, this.environment.document);
      if (place) panes.set(node as Element, frozen(place));
      node = node.parentNode;
    }
    this.#credentialScrollFreezes.set(field, {
      axis,
      document: frozen(readDocumentScrollSnapshot(
        this.environment.document,
        this.environment.window,
      )),
      panes,
    });
  }

  /**
   * A place as it is reported: on the inline axis of a credential field
   * sized by its content, the place before it was typed into (D180).
   * `scroller` is a pane, or undefined for the document.
   */
  #withoutCredentialLength<T extends {
    readonly scrollX: number;
    readonly scrollY: number;
    readonly maxScrollX: number;
    readonly maxScrollY: number;
  }>(place: T, scroller?: Element): T {
    if (this.#credentialScrollFreezes.size === 0) return place;
    let result = place;
    for (const [field, freeze] of this.#credentialScrollFreezes) {
      if (!field.isConnected) {
        this.#credentialScrollFreezes.delete(field);
        continue;
      }
      const kept = scroller ? freeze.panes.get(scroller) : freeze.document;
      if (!kept) continue;
      result = freeze.axis === 'x'
        ? { ...result, scrollX: kept.offset, maxScrollX: kept.max }
        : { ...result, scrollY: kept.offset, maxScrollY: kept.max };
    }
    return result;
  }

  /**
   * An editor the page made without the attribute is known by what is typed
   * into it (D181): `beforeinput` comes before the text is put in, and the
   * editor is read again as an editor.
   */
  #noteEditorWithoutAttribute(event: Event): void {
    if (this.#disposed || !this.#identity) return;
    const target = (event.composedPath?.()[0] ?? event.target) as Node | null;
    if (!target || typeof target !== 'object' || sourceNodeType(target) !== 1) return;
    const editor = noteSourceEditingTarget(target as Element);
    if (!editor || !this.#mirroredNodes.has(editor) || this.#checkpointRead) {
      return;
    }
    this.#queueReadWithChildren(editor);
    this.#scheduleFlush();
  }

  /**
   * A script gave a slot other nodes (a root that assigns by hand, D135):
   * nothing else tells of it. The slot's list of nodes is sent, and what the
   * host holds is asked how it is read now.
   */
  readonly #onSlotChange = (event: Event): void => {
    const slot = event.target;
    if (
      this.#disposed || !this.#identity ||
      !slot || typeof slot !== 'object' || sourceNodeType(slot as Node) !== 1
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
    if (this.#visibilityBoundaryIndex || this.#checkpointRead) {
      this.#visibilityFullRefreshPending = true;
    }
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
        for (const child of sourceChildNodeList(changed.host)) children.add(child);
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
        sourceNodeType(child) === Node.ELEMENT_NODE &&
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
      sourceNodeType(node) === Node.TEXT_NODE ||
      (elements && sourceNodeType(node) === Node.ELEMENT_NODE)
    ));
    if (wanted.length <= MAX_SLOTTED_NODES) {
      for (const node of wanted) {
        if (sourceNodeType(node) === Node.TEXT_NODE) {
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
      if (parent && sourceNodeType(parent) === Node.ELEMENT_NODE) hosts.add(parent as Element);
    }
    for (const host of hosts) {
      if (this.#mirroredNodes.has(host)) this.#queueVisibilityTarget(host);
    }
  }

  /** An element shown or hidden: it and what it holds are read again. */
  #queueVisibilityTarget(target: Element): void {
    if (target === sourceProperty(this.environment.document, 'documentElement')) {
      // `<html>` shown or hidden is the page shown or hidden: a whole read.
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return;
    }
    this.#queueReadWithChildren(target);
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
        const slots: Element[] = sourceLocalName(box) === 'slot' ? [box] : [];
        for (const item of box.querySelectorAll('slot')) slots.push(item);
        for (const slot of slots) {
          for (const node of (slot as HTMLSlotElement).assignedNodes?.({
            flatten: true,
          }) ?? []) {
            if (held.has(node)) continue;
            held.add(node);
            if (sourceNodeType(node) === Node.ELEMENT_NODE) boxes.push(node as Element);
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
    // A `<style>` that imports nothing tells of nothing by its `load`: its
    // rules applied when its text was written, and that was a change of
    // the page, compared in its own frame. The event used to start a second
    // comparison of the whole page after every change of a style's text.
    if (!sourceStyleLoadChangesNothing(event)) this.#onLayoutChange();
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
    const root = sourceProperty(this.environment.document, 'documentElement');
    const pending: Element[] = root ? [root] : [];
    // The children of an element are stepped through by the accessors its
    // prototype defines, never by a read on the element itself: a form
    // answers `form.lastElementChild` with one of its fields when a field
    // is named so (D144).
    const links = sourceElementLinks(root);
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
      if (mirrored && sourceLocalName(element).toLowerCase() === 'select') {
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
        let child = links.last(element);
        child;
        child = links.previous(child)
      ) pending.push(child);
      const shadow = readSourceShadowRoot(element);
      if (shadow && this.#mirroredNodes.has(shadow)) {
        // How a child of the host is read comes from the boxes around its
        // slot in this root, which a sheet restyles: each child is asked
        // again, and read again if it is read otherwise than it was (D142).
        // The root is stepped through by its own accessors too: page script
        // holding it can define an own property of either name (A7).
        this.#slotChanges.add(shadow);
        const shadowLinks = sourceElementLinks(shadow);
        for (
          let child = shadowLinks.last(shadow);
          child;
          child = shadowLinks.previous(child)
        ) pending.push(child);
      }
    }
  }

  /**
   * Whether this frame reads a changed text or a changed list of children
   * inside a panel that a control names. Such a panel is read or withheld by
   * its state, and the policy the session keeps holds the state it had when
   * the policy was last made: a panel can close with no record that makes
   * the policy again (a class on a sibling, a checkbox a script unchecks),
   * and the index of what is painted does not see every closing (a popup
   * put off the page; anything under a box that is declared hidden and
   * painted all the same). A changed text there was read by that old state:
   * the text of a closed panel travelled under every profile (D145; found
   * by the review, which build `.16`'s walk of the whole document for every
   * such patch had caught). The policy is made again, once, before the
   * frame is read, so the panel's state is the one it has now. A change
   * anywhere else costs no walk.
   */
  #readsInsidePanelWithControl(): boolean {
    const policy = this.#controlledContentPolicy;
    if (!policy || policy.targets.size === 0) return false;
    for (const pending of [this.#pendingText, this.#pendingChildren]) {
      for (const node of pending) {
        if (sourceNodeIsInsideControlledTarget(node, policy)) return true;
      }
    }
    return false;
  }

  #refreshControlledContentPolicy(): boolean {
    const previous = this.#controlledContentPolicy;
    if (!previous) return false;
    // Built whole in this task: one read in slices is not needed any more.
    this.#cancelPolicyRefresh();
    const next = createSourceControlledContentPolicy(
      this.environment.document,
      this.environment.window,
      MAX_HTML_MIRROR_NODES,
    );
    return this.#adoptControlledContentPolicy(previous, next);
  }

  /**
   * Reads the policy again in slices, after a change of layout (D165): the
   * panel opening beside the tab is one, and the whole read took 37–50 ms
   * of one task on a page of 72,000 elements. The policy in force stays
   * until the new one is read. A change of the page that may change the
   * policy reads it whole at once, from the observer that is called
   * between the slices, and this read is dropped: what it would adopt
   * never mixes the page before such a change with the page after it.
   */
  #beginPolicyRefresh(holdFlush = false): void {
    if (!this.#controlledContentPolicy) return;
    // A read that replaces one holding the flush holds it too (D171).
    const hold = holdFlush ||
      (this.#policyRefreshRunning && this.#policyRefreshHoldsFlush);
    const generation = (this.#policyRefreshGeneration += 1);
    this.#policyRefreshRunning = true;
    this.#policyRefreshHoldsFlush = hold;
    const builder = beginSourceControlledContentPolicy(
      this.environment.document,
      this.environment.window,
      MAX_HTML_MIRROR_NODES,
    );
    const clock = createSliceClock({
      now: this.environment.now,
      yield: this.environment.yieldToMain ?? yieldToMain,
      budgetMs: LIVE_SLICE_BUDGET_MS,
    });
    void this.#continuePolicyRefresh(generation, builder, clock);
  }

  #cancelPolicyRefresh(): void {
    if (!this.#policyRefreshRunning) return;
    this.#policyRefreshRunning = false;
    this.#policyRefreshGeneration += 1;
    // Cancelled by a policy read whole, a copy or the end (D171): what the
    // hold kept goes out with the next flush.
    if (this.#policyRefreshHoldsFlush) {
      this.#policyRefreshHoldsFlush = false;
      this.#scheduleFlush();
    }
  }

  async #continuePolicyRefresh(
    generation: number,
    builder: ReturnType<typeof beginSourceControlledContentPolicy>,
    clock: ReturnType<typeof createSliceClock>,
  ): Promise<void> {
    // One that holds the flush runs while the copy waits for its ACK (D171).
    const current = (): boolean =>
      this.#policyRefreshGeneration === generation && !this.#disposed &&
      !!this.#identity && (!this.#paused || this.#policyRefreshHoldsFlush) &&
      !!this.#controlledContentPolicy;
    for (;;) {
      // The first slice too comes after a turn: the frame that asked for
      // the read runs its flush on its own.
      try {
        await clock.next();
      } catch {
        // A turn that cannot be given: the read goes on now.
      }
      if (!current()) return;
      let next: SourceControlledContentPolicy | undefined;
      try {
        next = builder.step(() => clock.expired());
      } catch {
        // What cannot be read in slices is read whole.
        const held = this.#policyRefreshHoldsFlush;
        this.#policyRefreshRunning = false;
        this.#policyRefreshHoldsFlush = false;
        if (this.#refreshControlledContentPolicy() || held) this.#scheduleFlush();
        return;
      }
      if (!next) continue;
      const held = this.#policyRefreshHoldsFlush;
      this.#policyRefreshRunning = false;
      this.#policyRefreshHoldsFlush = false;
      this.#policyRefreshGeneration += 1;
      if (
        this.#adoptControlledContentPolicy(this.#controlledContentPolicy!, next) ||
        held
      ) {
        this.#scheduleFlush();
      }
      return;
    }
  }

  /** Puts `next` in force, and queues what it changes against `previous`. */
  #adoptControlledContentPolicy(
    previous: SourceControlledContentPolicy,
    next: SourceControlledContentPolicy,
  ): boolean {
    this.#controlledContentPolicy = next;
    if (sourceControlledContentBoundaryChanged(previous, next)) {
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return true;
    }
    const changed = sourceControlledContentChangedTargets(previous, next);
    for (const panel of changed) this.#queueReadWithChildren(panel);
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
      !this.#layoutChangePending &&
      this.#visibilityInteractionTargets.size === 0 &&
      this.#lateShadowRoots.length === 0 &&
      this.#heldChanged.size === 0
    ) return;
    this.#frame = this.environment.scheduleFrame(() => {
      this.#frame = undefined;
      this.#takeLayoutChange();
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
    if (!policy || sourceNodeType(source) !== Node.ELEMENT_NODE) return;
    const withheld = sourceDeclaredHiddenRegionIsWithheld(source as Element, policy);
    if (withheld === undefined) {
      this.#declaredHiddenSent.delete(source as Element);
      this.#declaredHiddenElements.delete(source as Element);
    } else {
      this.#declaredHiddenSent.set(source as Element, withheld);
      this.#declaredHiddenElements.add(source as Element);
    }
  }

  /**
   * Asks each element the page declares hidden whether what it holds is
   * withheld as it was when it was sent, and queues the ones that changed
   * (D180): a class on such a box, or an animation, that fades it in or
   * out. A page can declare hundreds of icons hidden, so at most
   * `DECLARED_HIDDEN_LOOK_MS` goes to it at a time, and the ones asked go
   * to the end of the list for the next time.
   */
  #askDeclaredHiddenAgain(): void {
    const policy = this.#controlledContentPolicy;
    const elements = this.#declaredHiddenElements;
    if (!policy || elements.size === 0) return;
    const now = this.environment.now;
    const started = now();
    let left = elements.size;
    let queued = false;
    for (const element of elements) {
      if (left === 0) break;
      left -= 1;
      elements.delete(element);
      const withheld = this.#declaredHiddenSent.get(element);
      if (
        withheld === undefined || !element.isConnected ||
        !this.#mirroredNodes.has(element)
      ) continue;
      elements.add(element);
      if (sourceDeclaredHiddenRegionIsWithheld(element, policy) !== withheld) {
        this.#queueVisibilityTarget(element);
        queued = true;
        if (this.#paused || !this.#queueSlottedContent(element)) return;
      }
      if (now() - started >= DECLARED_HIDDEN_LOOK_MS) break;
    }
    if (queued) this.#scheduleFlush();
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
    // A host sent again with its root counts as a new child (D190).
    const previousSet = new Set(previous.filter(
      (child) => !this.#hostsSentAgain.has(child as Element),
    ));
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
    const sentAgain = (child: Node): boolean =>
      this.#hostsSentAgain.has(child as Element) &&
      this.#emittedParent.get(child) === target;
    const newRoots = children.filter((child) => !previousSet.has(child));
    const incomingSources = collectLiveSubtreeNodes(newRoots);
    if (!incomingSources) return 'missingReconciliationProofFallbackCount';
    for (const current of incomingSources) {
      const oldParent = this.#emittedParent.get(current);
      // A currently-emitted node whose prior parent is outside this new graph
      // would collide with receiver state. Internal parents are allowed for a
      // whole subtree that was removed in an earlier emitted batch and is now
      // being reinserted as a graph.
      if (
        oldParent && !incomingSources.has(oldParent) &&
        !(oldParent === target && sentAgain(current))
      ) {
        return 'crossParentFallbackCount';
      }
    }
    return 'reconcile';
  }

  #coversOwnShadowWork(target: Node): boolean {
    if (sourceNodeType(target) !== Node.ELEMENT_NODE) return false;
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
          sourceProperty(this.environment.document, 'baseURI'),
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
    if (!(target instanceof Element)) return;
    const read = this.#checkpointRead;
    if (read) {
      // Judged against the copy being read, once it is sent (D163); more
      // than are kept, and the read starts again.
      if (read.loaded.size < MAX_CHECKPOINT_READ_LOADS) read.loaded.add(target);
      else read.recordsOverflow = true;
      return;
    }
    this.#queueCapturedResourceRefresh(target);
  }

  #queueCapturedResourceRefresh(target: Element): void {
    if (
      !CAPTURED_RESOURCE_ELEMENTS.has(sourceLocalName(target).toLowerCase()) ||
      !belongsToSourceDocument(target, this.environment.document) ||
      !target.isConnected ||
      !this.#mirroredNodes.has(target)
    ) return;
    if (sourceLocalName(target).toLowerCase() === 'link') {
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
    // A full set was compacted for every root offered: on a page of more
    // than 4,000 roots each further root walked all of them, 25–30 ms of
    // every slice of the first read at 54,000 elements in 5,400 roots
    // (D171). It is compacted once per 256 roots refused.
    if (
      this.#imageEventRoots.size >= MAX_IMAGE_EVENT_ROOTS &&
      this.#imageEventRootsRefused % IMAGE_EVENT_ROOT_COMPACTION_EVERY === 0
    ) {
      this.#compactImageEventRoots();
    }
    if (this.#imageEventRoots.size >= MAX_IMAGE_EVENT_ROOTS) {
      this.#imageEventRootsRefused += 1;
      return;
    }
    this.#imageEventRoots.add(root);
    sourceCall(root, 'addEventListener', 'load', this.#onCapturedResourceLoad, true);
    sourceCall(root, 'addEventListener', 'error', this.#onCapturedResourceError, true);
    sourceCall(root, 'addEventListener', 'scroll', this.#onScroll, true);
    // A root that assigns its slots by hand: no mutation tells of it, only
    // the slot's own event, which does not leave the root. Where the browser
    // assigns by name every change is a mutation (see `#queueMutationRecords`).
    if ((root as Partial<ShadowRoot>).slotAssignment === 'manual') {
      sourceCall(root, 'addEventListener', 'slotchange', this.#onSlotChange, true);
    }
  }

  #compactImageEventRoots(): void {
    this.#imageEventRootsRefused = 0;
    for (const root of this.#imageEventRoots) {
      if (root === this.environment.document || ('host' in root && root.host.isConnected)) {
        continue;
      }
      sourceCall(root, 'removeEventListener', 'load', this.#onCapturedResourceLoad, true);
      sourceCall(root, 'removeEventListener', 'error', this.#onCapturedResourceError, true);
      sourceCall(root, 'removeEventListener', 'scroll', this.#onScroll, true);
      sourceCall(root, 'removeEventListener', 'slotchange', this.#onSlotChange, true);
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
    const listing = readSourceAnimationListing(this.environment.document);
    if (listing.running) {
      // An animation runs (D180): it may lengthen or shorten a pane with
      // nothing the reader hears of, so the panes are read again, as after
      // a change, every half second while it runs.
      this.#takeMetPanes();
      if (this.#scrolledPanes.size > 0) this.#postScroll(true);
    }
    const look = this.#heldLook;
    look.in -= 1;
    if (look.in > 0) return;
    if (!listing.script) {
      // The last listing held no animation a script made (D180): the look
      // is for those, and a page of endless spinners was listed every few
      // seconds for nothing. One a timer starts is met at the next change
      // the reader hears of, which lists the animations again.
      look.every = Math.min(look.every * 2, MAX_HELD_LOOK_WAIT);
      look.in = look.every;
      return;
    }
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
      sourceProperty(this.environment.document, 'baseURI'),
      work,
      undefined,
      this.#fidelityPolicy ?? 'conservative',
    );
    if (!styles) return work.exhausted ? 'capacity' : 'unchanged';
    const signature = adoptedStyleSignature(styles);
    this.#styleNames.noteAdopted(owner, signature);
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
    const collection = createSourceStyleSheetCollection(this.#crossOriginNames);
    const read = ordinaryStyleSignature(
      owner,
      work,
      budgetUnused(work),
      collection,
    );
    if (read.kind === 'capacity') return 'capacity';
    this.#styleNames.noteOrdinary(owner, read.signature, collection);
    this.#learnRedirectedSheetBases(owner);
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
   * Asks where each redirected linked sheet of `owner` came from, once a
   * sheet (D180): its relative `url()`s are the tab's only against that
   * address. A sheet whose address is learned is sent again with its
   * element.
   */
  #learnRedirectedSheetBases(owner: Document | ShadowRoot): void {
    let sheets: ArrayLike<CSSStyleSheet>;
    try {
      sheets = sourceProperty(owner, 'styleSheets');
    } catch {
      return;
    }
    const count = Math.min(sheets?.length ?? 0, MAX_STYLE_SHEETS_PER_TICK);
    for (let index = 0; index < count; index += 1) {
      const sheet = sheets[index];
      if (!sheet) continue;
      learnSourceSheetBase(sheet, this.environment.window, (learned) => {
        if (this.#disposed) return;
        const element = learned.ownerNode;
        if (
          !element || sourceNodeType(element) !== Node.ELEMENT_NODE ||
          !(element as Element).isConnected ||
          !this.#mirroredNodes.has(element)
        ) return;
        this.#queuePending(this.#pendingSheets, element as Element);
        this.#scheduleFlush();
      });
    }
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
    // The poll counts this as no change of the page, so the field reader
    // hears of it here: a rule put into a held sheet may show or hide a
    // field, as one the poll reports does (D185, D203).
    noteSemanticSourceStyleSheetChange(this.environment.document);
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
      const collection = createSourceStyleSheetCollection(this.#crossOriginNames);
      const read = ordinaryStyleSignature(
        owner,
        work,
        budgetUnused(work),
        collection,
      );
      if (read.kind === 'signature') {
        this.#styleNames.noteOrdinary(owner, read.signature, collection);
      }
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
          // A rule put into a sheet may show or hide a field (D185).
          if (result === 'changed') noteSemanticSourceStyleSheetChange(this.environment.document);
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
      if (isSourceShadowRoot(node)) {
        this.#observeShadowRoot(node, walk.resendHeldHosts);
      }
      if (sourceNodeType(node) === Node.ELEMENT_NODE) {
        const shadow = readSourceShadowRoot(node as Element);
        if (shadow) {
          this.#observeShadowRoot(shadow, walk.resendHeldHosts);
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

  #observeShadowRoot(shadow: ShadowRoot, resendHeldHost = false): void {
    this.#observeImageEvents(shadow);
    if (!this.#observedShadowRoots.has(shadow)) {
      this.#observedShadowRoots.add(shadow);
      // The same options as for the document (D125).
      this.#observer?.observe(shadow, SOURCE_SECRET_RECORD_OPTIONS);
    }
    if (this.#mirroredNodes.has(shadow)) return;
    if (this.#notingUnheldShadowRoots) {
      // Attached, between the slices of the read, to a host the read met
      // without one (D163): not a root the copy cannot hold, but one it
      // missed. Read in one task, no root comes in between.
      if (this.#knownShadowHostCandidates.has(shadow.host)) {
        this.#rootAttachedDuringRead = true;
        return;
      }
      this.#unheldShadowRoots.add(shadow);
      return;
    }
    if (this.#unheldShadowRoots.has(shadow)) return;
    if (!this.#mirroredNodes.has(shadow.host)) {
      // A host the mirror does not hold: the patch that adds it carries
      // its root (D180).
      this.#rootsAwaitingPatch.add(shadow);
      return;
    }
    if (
      this.#hostsSentAgain.has(shadow.host) ||
      (resendHeldHost && this.#sendHostAgain(shadow.host))
    ) return;
    this.#shadowReconciliationPending = true;
    this.#signalShadowReconciliation();
  }

  /**
   * Queues `host`, which the mirror holds without the root it has now, to
   * be sent again whole in its parent's list (D190). The patch reads it as
   * any new child: its root, its children, every check. False where the
   * mirror would not take that: a host right under `<html>`, one held in
   * another list than its own, one inside a dropdown, a placeholder.
   */
  #sendHostAgain(host: Element): boolean {
    const parent = host.parentNode;
    if (
      !parent || !host.isConnected ||
      parent === sourceProperty(this.environment.document, 'documentElement') ||
      !this.#mirroredNodes.has(parent) ||
      this.#emittedParent.get(host) !== parent ||
      !isSourceStructuralChildOf(host, parent) ||
      sourceNativeSelectStructuralOwner(host) ||
      this.#mirroredOpaqueSecrets.has(host)
    ) return false;
    this.#hostsSentAgain.add(host);
    this.#queuePending(this.#pendingChildren, parent);
    this.#scheduleFlush();
    return true;
  }

  /**
   * After a frame's patches are read: whether the mirror holds every root
   * met on a host it did not hold (D180). A host still not held needs no
   * root (a host the mirror leaves out, or one taken out again); one held
   * now without its root asks for a checkpoint, as a root attached to a
   * held host does.
   */
  #rootsAwaitingPatchHeld(): boolean {
    if (this.#rootsAwaitingPatch.size === 0) return true;
    const roots = this.#rootsAwaitingPatch;
    this.#rootsAwaitingPatch = new Set();
    for (const shadow of roots) {
      if (
        !this.#mirroredNodes.has(shadow.host) ||
        this.#mirroredNodes.has(shadow) ||
        this.#unheldShadowRoots.has(shadow)
      ) continue;
      this.#shadowReconciliationPending = true;
      this.#signalShadowReconciliation();
      return false;
    }
    return true;
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

/**
 * Whether a `load` event is that of a `<style>` element whose sheet holds
 * no `@import`: such a sheet has nothing to wait for, and applied when the
 * element's text was written or the element put into the page. Imports can
 * only stand at a sheet's start, after layer statements, so only those
 * rules are looked at. A sheet that cannot be read answers no.
 */
function sourceStyleLoadChangesNothing(event: Event): boolean {
  try {
    const target = event.target as Partial<HTMLStyleElement> | null;
    if (
      !target || target.nodeType !== 1 ||
      String(target.localName).toLowerCase() !== 'style'
    ) return false;
    const rules = target.sheet?.cssRules;
    if (!rules) return false;
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index] as CSSRule & {
        readonly styleSheet?: unknown;
        readonly nameList?: unknown;
      };
      if (rule.type === 3 || 'styleSheet' in rule) return false;
      // A layer statement (`@layer a, b;`) may stand before an import.
      if (!('nameList' in rule)) break;
    }
    return true;
  } catch {
    return false;
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
  collection?: SourceStyleSheetCollection,
): OrdinaryStyleSignatureRead {
  let sheets: ArrayLike<CSSStyleSheet>;
  try {
    sheets = sourceProperty((owner as Document & {
      readonly styleSheets: ArrayLike<CSSStyleSheet>;
    }), 'styleSheets');
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
      if (collection) collection.complete = false;
      continue;
    }
    const rules = cssomRuleSignature(
      sheet,
      work,
      visited,
      0,
      shapeOnOverflow,
      collection,
    );
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
  collection?: SourceStyleSheetCollection,
): OrdinaryStyleSignatureRead {
  if (depth > 8 || visited.has(sheet)) {
    // Imported deeper than this: not read, so not every name is known.
    if (depth > 8 && collection) collection.complete = false;
    return Object.freeze({ kind: 'signature', signature: 'cycle' });
  }
  visited.add(sheet);
  // A sheet watched by its shape, or one that cannot be read, leaves the
  // names the page mentions unknown (D164).
  const incomplete = (
    read: OrdinaryStyleSignatureRead,
  ): OrdinaryStyleSignatureRead => {
    if (collection) collection.complete = false;
    return read;
  };
  try {
    const rules = sheet.cssRules;
    const ruleCount = rules.length;
    if (
      !Number.isSafeInteger(ruleCount) ||
      ruleCount < 0
    ) return incomplete(Object.freeze({ kind: 'signature', signature: 'unreadable' }));
    if (
      ruleCount > MAX_FULL_SIGNATURE_RULES_PER_SHEET ||
      SHAPE_SIGNATURE_SHEETS.has(sheet)
    ) {
      SHAPE_SIGNATURE_SHEETS.add(sheet);
      return incomplete(
        cssomShapeSignature(rules, ruleCount, work, shapeOnOverflow),
      );
    }
    if (work.rules + ruleCount > work.maxRules) {
      if (shapeOnOverflow) {
        SHAPE_SIGNATURE_SHEETS.add(sheet);
        return incomplete(cssomShapeSignature(rules, ruleCount, work, true));
      }
      work.exhausted = true;
      return Object.freeze({ kind: 'capacity' });
    }
    collection?.ruleCounts.push([sheet, ruleCount]);
    const startRules = work.rules;
    const startCharacters = work.characters;
    const parts: string[] = [];
    for (let index = 0; index < ruleCount; index += 1) {
      const rule = rules[index] ?? rules.item(index);
      if (!rule || typeof rule.cssText !== 'string') {
        return incomplete(Object.freeze({ kind: 'signature', signature: 'unreadable' }));
      }
      const cssText = rule.cssText;
      if (
        work.characters - startCharacters + cssText.length >
          MAX_FULL_SIGNATURE_CHARACTERS_PER_SHEET
      ) {
        // Too large to reread each pass: watch its shape from now on, and
        // give back what this read spent so the other sheets still fit.
        SHAPE_SIGNATURE_SHEETS.add(sheet);
        work.rules = startRules;
        work.characters = startCharacters;
        return incomplete(
          cssomShapeSignature(rules, ruleCount, work, shapeOnOverflow),
        );
      }
      if (work.characters + cssText.length > work.maxCharacters) {
        if (shapeOnOverflow) {
          SHAPE_SIGNATURE_SHEETS.add(sheet);
          work.rules = startRules;
          work.characters = startCharacters;
          return incomplete(cssomShapeSignature(rules, ruleCount, work, true));
        }
        work.exhausted = true;
        return Object.freeze({ kind: 'capacity' });
      }
      work.rules += 1;
      work.characters += cssText.length;
      collection?.texts.push(cssText);
      const imported = (rule as CSSRule & {
        readonly styleSheet?: CSSStyleSheet | null;
      }).styleSheet;
      if (!imported) {
        parts.push(cssText);
        continue;
      }
      const nested = cssomRuleSignature(
        imported,
        work,
        visited,
        depth + 1,
        shapeOnOverflow,
        collection,
      );
      if (nested.kind === 'capacity') return nested;
      parts.push(`${cssText}:${nested.signature ?? 'unavailable'}`);
    }
    return Object.freeze({
      kind: 'signature',
      signature: adoptedStyleSignature(parts),
    });
  } catch {
    // Another origin's sheet: its names, once the page's copy of it has
    // been read (D180), and no rules.
    const names = collection?.crossOrigin?.(sheet);
    if (names) {
      collection!.names.push(names);
      return Object.freeze({ kind: 'signature', signature: 'cross-origin' });
    }
    return incomplete(Object.freeze({ kind: 'signature', signature: 'unreadable' }));
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
      if (sourceNodeType(current) === Node.ELEMENT_NODE) {
        const shadow = readSourceShadowRoot(current as Element);
        if (shadow) stack.push(shadow);
      }
      for (const item of sourceChildNodeList(current)) stack.push(item);
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
    if (sourceNodeType(current) === Node.DOCUMENT_FRAGMENT_NODE && 'host' in current) {
      current = (current as ShadowRoot).host;
      continue;
    }
    const root = current.getRootNode();
    current = root !== current && sourceNodeType(root) === Node.DOCUMENT_FRAGMENT_NODE &&
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
      (sourceNodeType(current) === Node.DOCUMENT_FRAGMENT_NODE && 'host' in current
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
  let current = sourceNodeType(node) === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement ?? undefined;
  for (; current; current = composedSourceParentElement(current)) {
    const tagName = sourceLocalName(current).toLowerCase();
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
    changes = record.attributeName === 'name' && sourceNodeType(target) === 1 &&
      sourceLocalName(target as Element) === 'slot';
  } else if (record.type === 'childList') {
    const holdsSlot = (node: Node): boolean => sourceNodeType(node) === 1 && (
      sourceLocalName(node as Element) === 'slot' ||
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
  return holder !== null && sourceNodeType(holder) === 1 &&
      sourceLocalName(holder as Element).toLowerCase() === 'style'
    ? holder as Element
    : undefined;
}

/**
 * Whether `<html>` has another head or body than it had: its own (the first
 * of each) is another element or gone, or it holds one more. One of several
 * taken out leaves the page's own in place, and so does a new one put in
 * place of the page's own, which is gone (a Turbo-style visit,
 * `document.body.replaceWith(next)`): the mirror's own takes that one's
 * attributes and children (D190). One with a shadow root it cannot take.
 */
function sourceDocumentShellChanged(
  previous: readonly Node[],
  current: readonly Node[],
): boolean {
  const named = (node: Node, name: string): boolean => sourceNodeType(node) === 1 &&
    (node as Element).namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    sourceLocalName(node as Element) === name;
  const known = new Set(previous);
  for (const name of ['head', 'body']) {
    const before = previous.find((node) => named(node, name));
    const now = current.find((node) => named(node, name));
    const added = current.filter((node) => named(node, name) && !known.has(node));
    if (before === now && added.length === 0) continue;
    if (
      before && now && added.length === 1 && added[0] === now &&
      !current.includes(before) && !readSourceShadowRoot(now as Element)
    ) continue;
    return true;
  }
  return false;
}

/** Whether a mutation adds, removes or changes nothing but text nodes. */
function sourceMutationChangesTextOnly(record: MutationRecord): boolean {
  if (record.type === 'characterData') return true;
  if (record.type !== 'childList') return false;
  for (const node of record.addedNodes) if (sourceNodeType(node) !== 3) return false;
  for (const node of record.removedNodes) if (sourceNodeType(node) !== 3) return false;
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
      sourceLocalName(current).toLowerCase() !== 'optgroup' &&
      !isSourceSelectWrapper(current)
    ) return false;
    current = current.parentElement;
  }
  return false;
}

function composedSourceParentElement(element: Element): Element | undefined {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return sourceNodeType(root) === 11 && 'host' in root
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
      (sourceNodeType(added) === 1 && (added as Element).querySelector?.('meta'))
    ) return true;
  }
  return false;
}

function isSourceMetaElement(node: Node): boolean {
  return sourceNodeType(node) === 1 &&
    sourceLocalName(node as Element).toLowerCase() === 'meta';
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
  const html = sourceProperty(document, 'documentElement');
  const body = sourceProperty(document, 'body');
  const viewportWidth = boundedDimension(window.innerWidth || html?.clientWidth || 1);
  const viewportHeight = boundedDimension(window.innerHeight || html?.clientHeight || 1);
  const canvasBackgroundColor = html
    ? sanitizeSourceElementHints(html, sourceProperty(document, 'baseURI')).canvasBackgroundColor
    : undefined;
  return {
    viewportWidth,
    viewportHeight,
    documentWidth: boundedDimension(Math.max(
      viewportWidth,
      html?.scrollWidth ?? 0,
      body?.scrollWidth ?? 0,
    )),
    documentHeight: boundedDimension(Math.max(
      viewportHeight,
      html?.scrollHeight ?? 0,
      body?.scrollHeight ?? 0,
    )),
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
  };
}

// Kept in the emitted bundle as an artifact marker even after minification.
export const HTML_MIRROR_RUNTIME_MARKER = HTML_MIRROR_PORT_PREFIX;
