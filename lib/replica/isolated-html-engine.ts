import {
  emptyReplicaDiagnostics,
  type ReplicaCaptureRequest,
  type ReplicaDiagnosticCode,
  type ReplicaDiagnostics,
  type ReplicaEngine,
  type ReplicaImageAnchor,
  type ReplicaImageSurface,
  type ReplicaRunResult,
} from './contracts';
import {
  HtmlMirrorClientError,
  type HtmlMirrorStreamFactory,
  type HtmlMirrorStreamLease,
} from './html-mirror-client';
import {
  aggregatePaintedSemanticLabelText,
  paintedSemanticLabelHostsToLookAgain,
  removePaintedSemanticLabelPresentation,
  synchronizePaintedSemanticLabelPresentation,
} from './painted-semantic-label';
import {
  htmlMirrorFramePatches,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchBatch,
  type HtmlMirrorPatchOperation,
  type HtmlMirrorReconcileChild,
  type HtmlMirrorScrollState,
  type HtmlMirrorScrollUpdate,
} from './html-mirror-protocol';
import {
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_NODES,
  MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT,
  PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE,
  PAGE_XML_LANGUAGE_ATTRIBUTE,
  createHtmlMirrorShellLedger,
  HTML_MIRROR_LEFT_OUT_ATTRIBUTE,
  hasPrivateHtmlMirrorAttribute,
  isHtmlMirrorLeftOutTagName,
  isAutonomousCustomElementName,
  readHtmlMirrorDocumentContent,
  isTransportableStyleSheetText,
  readHtmlMirrorNode,
  sanitizeCss,
  type HtmlMirrorControlText,
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
  type HtmlMirrorRepresentabilitySummary,
  type HtmlMirrorShadowRoot,
} from './html-mirror-sanitizer';
import {
  DEFAULT_HTML_MIRROR_LIMIT_SETTINGS,
  applyHtmlMirrorLimitSettings,
  type HtmlMirrorLimitSettings,
} from './html-mirror-limits';
import {
  SOURCE_PRIVACY_FILTERS_OFF,
  applySourcePrivacyFiltersOff,
} from './source-privacy-mode';
import {
  isSourceActivationRoleValue,
  isSourceActivationTagName,
  isSourcePublicMenuRoleValue,
  sourceElementStartsPrivateRegionInContext,
} from './source-privacy-policy';
import {
  sameSourceDocument,
  sourceDocumentIdentity,
  type ReplicaSourceDocumentIdentity,
} from './source-identity';
import type {
  ReplicaSourceTextChange,
  ReplicaSourceTextRecord,
} from './source-text-record';
import type {
  ReplayPresentationHost,
  VisibleReplayCandidateLease,
  VisibleReplayExtent,
} from './visible-replay-host';
import type {
  ReplicaProjectionContext,
  ReplicaSourceCommit,
  ReplicaTextProjection,
  ReplicaTranslationSnapshot,
  ReplicaTranslationSurface,
} from '../translation/replica-translation-coordinator';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';
import {
  closeReadOnlyReplicaDisclosures,
  isReadOnlyReplicaDisclosurePressEcho,
  disposeReadOnlyReplicaDisclosures,
  installReadOnlyReplicaDisclosure,
  isReadOnlyReplicaDisclosureEvent,
  snapshotOpenReadOnlyReplicaDisclosures,
  type ReadOnlyReplicaDisclosure,
} from './read-only-disclosure';
import {
  FULL_VISIBLE_REPLICA_READ_SCOPE,
  PAGE_ONLY_REPLICA_READ_SCOPE,
  type ReplicaReadScope,
} from './read-scope-policy';
import {
  clearReplicaAttributeOverride,
  pageAttribute,
  pageAttributes,
  reapplyReplicaAttributeOverrides,
  setReplicaAttributeOverride,
} from './replica-attribute-override';
import type {
  SemanticSourceStreamFactory,
  SemanticSourceStreamLease,
} from './semantic-source-client';
import {
  SemanticSourceReceiver,
  semanticRefreshScope,
  semanticSelectionTextFor,
} from './semantic-source-receiver';
import { SemanticProofPresenter } from './semantic-proof-presenter';
import {
  ReplicaNodeMap,
  ReplicaTextMap,
  replicaTextBytes,
} from './replica-state-maps';
import {
  RetainedReplicaLedger,
  walkRetainedReplica,
} from './retained-replica-ledger';
import { isSourceSecretPlaceholderTagName } from './source-secret-classifier';
import { hasStructuralPatchTargetConflict } from './structural-patch-conflict';
import { canonicalSvgAttributeName } from './svg-attribute-names';
import {
  TranslatedGeometryLock,
  type TranslatedGeometryEntry,
} from './translated-geometry';
import {
  TranslatedLanguageTags,
  XML_NAMESPACE,
  copyTranslatedLanguage,
  documentContentLanguage,
  forgetPageXmlLanguage,
  pageXmlLanguage,
  refreshImageLanguages,
  showDocumentLanguage,
  shownTranslationLanguage,
  translationLanguageTag,
  writePageXmlLanguage,
} from './translated-language';
import type { TextLayoutMode } from '../preferences';
import { registerTrustedShells, trustedShellHtml } from '../trusted-types';
import {
  sourceAttributeList,
  sourceCall,
  sourceChildNodeList,
  sourceLocalName,
  sourceNodeType,
  sourceProperty,
} from './source-node-accessors';

export const ISOLATED_HTML_SHELL_MARKER = 'isolated-html-v1';
const ISOLATED_SECRET_PLACEHOLDER_CSS =
  ':host,:host::before,:host::after{all:initial!important;display:none!important;content:none!important;background:none!important;background-image:none!important;border:0!important;border-image-source:none!important;cursor:default!important;filter:none!important;list-style:none!important;list-style-image:none!important;mask:none!important;mask-image:none!important;-webkit-mask-image:none!important;pointer-events:none!important}';
// The shell leaves html and body at the browser's own defaults, as the source
// has them; only pointer input is owned. Chrome injects
// `body{font-family:<system font>;font-size:75%}` into every extension-origin
// document, which this same-origin srcdoc frame is, so the shell resets body
// font to inheritance. It sits after that injected sheet at equal
// specificity, and any source rule for body still overrides it.
// Chrome draws its own play bar on every video in a frame without scripts,
// and the replica cannot play video, so the bar is hidden (D87). Document
// rules do not reach into shadow trees, so each replica shadow root gets the
// same rule in its own Simul-owned style.
export const ISOLATED_MEDIA_CONTROLS_CSS = 'video::-webkit-media-controls,video::-webkit-media-controls-enclosure,video::-webkit-media-controls-overlay-play-button,video::-webkit-media-controls-start-playback-button{display:none!important}';
/**
 * The rules every replica tree needs from Simul, document or shadow root:
 * no video controls (D87), and translated text drawn in the fonts of the
 * page's own language (D124).
 */
const ISOLATED_HTML_SHELL_DOCUMENT = `<html><head><meta charset="utf-8" data-simul-owned-shell="charset"><meta name="simul-isolated-shell" content="${ISOLATED_HTML_SHELL_MARKER}" data-simul-owned-shell="marker"><meta http-equiv="Content-Security-Policy" data-simul-owned-shell="csp" content="default-src 'none'; script-src 'none'; worker-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline' http: https: data:; font-src http: https: data:"><style data-simul-owned-shell="inert">html,body{pointer-events:none}body{font-family:inherit;font-size:inherit}*{pointer-events:none!important}[data-simul-replica-disclosure-trigger="v1"],[data-simul-replica-disclosure-panel="v1"],[data-simul-replica-disclosure-overlay="v1"]{pointer-events:auto!important}${ISOLATED_MEDIA_CONTROLS_CSS}</style></head><body></body></html>`;
const ISOLATED_SELECT_SHADOW_CSS = `:host{pointer-events:auto!important;background-image:none!important;border-image-source:none!important;cursor:default!important;filter:none!important;list-style-image:none!important;mask-image:none!important;-webkit-mask-image:none!important}:host([data-simul-select-hidden="v1"]){display:none!important}:host::before,:host::after{content:none!important;display:none!important;background-image:none!important}[data-simul-owned-select-trigger="v1"]{all:unset!important;box-sizing:border-box!important;color:inherit!important;cursor:default!important;display:block!important;font:inherit!important;overflow:hidden!important;text-align:inherit!important;text-overflow:ellipsis!important;white-space:nowrap!important;width:100%!important}:host([data-simul-select-transparent="v1"]) [data-simul-owned-select-trigger="v1"]{opacity:0!important}[data-simul-owned-select-options="v1"]{background:Canvas!important;box-sizing:border-box!important;color:CanvasText!important;max-height:min(18rem,70vh)!important;min-width:100%!important;overflow:auto!important;overscroll-behavior:contain!important;pointer-events:auto!important;width:max-content!important;z-index:2147483647!important}[data-simul-owned-select-option="v1"],[data-simul-owned-select-optgroup-label="v1"]{box-sizing:border-box!important;display:block!important;min-height:1.5em!important;padding-inline:.5rem!important;pointer-events:none!important;white-space:normal!important}[data-simul-owned-select-optgroup-label="v1"]{font-weight:600!important}select[data-simul-select-facsimile="v1"]{display:none!important;pointer-events:none!important}[data-simul-owned-select-sizer="v1"]{display:none!important}:host([data-simul-select-unsized="v1"][data-simul-select-presentation="popup"]) [data-simul-owned-select-sizer="v1"]{display:block!important;height:0!important;overflow:hidden!important;visibility:hidden!important;white-space:nowrap!important;padding-inline:4px 16px!important;pointer-events:none!important}:host([data-simul-select-unsized="v1"][data-simul-select-presentation="popup"]) [data-simul-owned-select-trigger="v1"]{padding-block:1px!important;padding-inline:4px 16px!important}`;
const ISOLATED_DISCLOSURE_IFRAME_MARKER = 'css-disclosure-v1';
const ISOLATED_DISCLOSURE_BLOCKED_EVENTS = Object.freeze([
  'auxclick', 'beforeinput', 'change', 'click', 'contextmenu', 'dblclick',
  'dragstart', 'drop', 'input', 'keydown', 'keypress', 'keyup', 'mousedown',
  'mouseup', 'pointerdown', 'pointerup', 'reset', 'selectstart', 'submit',
  'touchend', 'touchstart',
]);
const ISOLATED_SELECT_HOSTS = new WeakSet<Element>();
const ISOLATED_OWNED_SHADOW_SHELL_STYLES = new WeakSet<Node>();
/**
 * The replica's roots that assign their slots by script, by replica
 * document, and for each of their slots the mirror ids of the nodes the
 * page's slot holds; see `assignIsolatedManualSlots`.
 */
const ISOLATED_MANUAL_SLOT_ROOTS = new WeakMap<Document, Set<ShadowRoot>>();
const ISOLATED_MANUAL_SLOT_NODE_IDS = new WeakMap<Element, readonly number[]>();
interface IsolatedSelectFacsimile {
  readonly panel: HTMLElement;
  readonly select: HTMLSelectElement;
  readonly trigger: HTMLButtonElement;
  controller?: ReadOnlyReplicaDisclosure;
  /** What `controller` was installed for: `popup` or `list`, and its rows. */
  controllerShape?: string;
  contentSignature?: string;
  /** The page's own picker was open at the last refresh. */
  pickerOpen?: boolean;
}
const ISOLATED_SELECT_FACSIMILES = new WeakMap<HTMLElement, IsolatedSelectFacsimile>();
/**
 * The select facsimile hosts of each replica document, in the order they
 * were built. A refresh visits the page's dropdowns, not every node of the
 * page; a host a patch removed is dropped on the next refresh (R3). Native
 * picker state has at most one open list, so this order decides no visible
 * survivor; two open non-page-shown popups cannot legitimately reach it
 * (S2).
 */
const ISOLATED_SELECT_HOSTS_BY_DOCUMENT = new WeakMap<Document, Set<HTMLElement>>();

/**
 * The elements an ARIA disclosure can be built from: those with an `id` a
 * trigger might name, and those with `aria-controls`. Kept in step with the
 * nodes a patch adds and removes (R3); once the replica has a ledger, with
 * every element the ledger saw added, removed, or given another `id` or
 * `aria-controls`, by a patch or by Simul (D165). Without one, rebuilt from
 * the replica when attributes change behind it.
 */
interface IsolatedAriaIndex {
  readonly ids: Map<string, HTMLElement[]>;
  /** The id each element is listed under, which its attribute may no
   * longer say (D165). */
  readonly listedIds: Map<Element, string>;
  readonly triggers: Set<HTMLElement>;
  dirty: boolean;
}
const ISOLATED_ARIA_INDEXES = new WeakMap<Document, IsolatedAriaIndex>();
/** The ledger of each committed replica's document, once it has one (D165). */
const RETAINED_LEDGERS = new WeakMap<Document, RetainedReplicaLedger>();
let isolatedSelectHostSequence = 0;
export const ISOLATED_HTML_SHELL = `<!doctype html>
${ISOLATED_HTML_SHELL_DOCUMENT}`;
export const ISOLATED_HTML_QUIRKS_SHELL = ISOLATED_HTML_SHELL_DOCUMENT;
/** A doctype that puts the written shell in limited-quirks mode (D97). */
export const ISOLATED_HTML_LIMITED_QUIRKS_DOCTYPE_PUBLIC_ID =
  '-//W3C//DTD XHTML 1.0 Transitional//EN';
export const ISOLATED_HTML_LIMITED_QUIRKS_SHELL =
  `<!DOCTYPE html PUBLIC "${ISOLATED_HTML_LIMITED_QUIRKS_DOCTYPE_PUBLIC_ID}" ` +
  `"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
${ISOLATED_HTML_SHELL_DOCUMENT}`;
// The only HTML Simul's pages write as a string (Trusted Types, D161).
registerTrustedShells(
  ISOLATED_HTML_SHELL,
  ISOLATED_HTML_QUIRKS_SHELL,
  ISOLATED_HTML_LIMITED_QUIRKS_SHELL,
);

export type IsolatedMirrorInfoStage =
  | 'connected'
  | 'checkpoint'
  | 'patch'
  | 'recovery'
  | 'failed';

/**
 * Who asked for a recovery's whole read (D183): the page reader (`page`),
 * the panel because a patch came out of order (`out-of-order`), or the
 * panel because it refused a patch (`refused`, with the check that did).
 */
export type IsolatedMirrorRecoveryCause = 'page' | 'out-of-order' | 'refused';

export interface IsolatedMirrorInfo {
  readonly stage: IsolatedMirrorInfoStage;
  readonly code?: ReplicaDiagnosticCode;
  readonly recoveryCause?: IsolatedMirrorRecoveryCause;
  /** For a refused patch: the check that refused it, a fixed label. */
  readonly refusal?: string;
  readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
  readonly replicaRequestsMayOccur: boolean;
  readonly nodeCount: number;
  readonly textCount: number;
  readonly imageCount: number;
  readonly operationCount: number;
  readonly textOperationCount: number;
  readonly attributeOperationCount: number;
  readonly childrenOperationCount: number;
  readonly reconcileChildrenOperationCount: number;
  readonly dimensionOperationCount: number;
  readonly replacementNodeCount: number;
  readonly largestReplacementNodeCount: number;
  readonly retainedNodeCount: number;
  readonly insertedNodeCount: number;
  readonly movedNodeCount: number;
  readonly removedNodeCount: number;
  readonly fullReplacementFallbackCount: number;
  readonly reconciliationRejectedCount: number;
  readonly unsafeElementOmissionCount: number;
  readonly unsupportedNodeOmissionCount: number;
  readonly depthBoundaryOmissionCount: number;
  readonly privateTextRedactionCount: number;
  readonly strippedActiveAttributeCount: number;
  readonly strippedUnsafeResourceCount: number;
  readonly unreadableStyleCount: number;
  readonly capacityOmissionCount: number;
  readonly customElementHostCount: number;
  readonly customElementHostWithoutAccessibleOpenRootCount: number;
  readonly accessibleOpenShadowRootCount: number;
  readonly missingReconciliationProofFallbackCount: number;
  readonly coveredDirtyBranchFallbackCount: number;
  readonly attributeContextFallbackCount: number;
  readonly crossParentFallbackCount: number;
  readonly preservedStyleSheetCount: number;
  readonly flattenedStyleSheetCount: number;
  readonly omittedStyleSheetCount: number;
  readonly preservedSvgResourceCount: number;
  readonly blockedSvgResourceCount: number;
  readonly replicaRequestCapableResourceCount: number;
  readonly executionRiskBlockCount: number;
  readonly navigationBlockCount: number;
  readonly unsupportedSchemeBlockCount: number;
  readonly browserInaccessibleResourceCount: number;
  readonly strictResourcePolicyBlockCount: number;
  readonly eventRepresentability: HtmlMirrorRepresentabilitySummary;
  readonly openShadowRootCount: number;
  readonly adoptedStyleCount: number;
  readonly visuallyHiddenCount: number;
  readonly selectedImageSourceCount: number;
  readonly stylesheetLinkCount: number;
  readonly stylesheetLoadedCount: number;
  readonly stylesheetErrorCount: number;
  readonly stylesheetTimedOutCount: number;
  readonly sequence: number;
}

interface ReplicaStyleReadiness {
  readonly stylesheetLinkCount: number;
  readonly stylesheetLoadedCount: number;
  readonly stylesheetErrorCount: number;
  readonly stylesheetTimedOutCount: number;
}

interface IsolatedHtmlEngineOptions {
  readonly presentationHost: ReplayPresentationHost;
  readonly openStream: HtmlMirrorStreamFactory;
  readonly getReplicaFidelityPolicy?: () => SelectableReplicaFidelityPolicy;
  /** The Advanced size limits; applied here and sent to the page (D64). */
  readonly getMirrorLimits?: () => HtmlMirrorLimitSettings;
  /**
   * The Advanced "Show everything (testing)" switch; applied here and sent to
   * the page (D75). While it is on the semantic channel reads at Full visible.
   */
  readonly getShowEverything?: () => boolean;
  readonly getReplicaReadScope?: () => ReplicaReadScope;
  /** "Keep geometry" holds boxes with translated text at the page's size. */
  readonly getTextLayoutMode?: () => TextLayoutMode;
  readonly openSemanticStream?: SemanticSourceStreamFactory;
  readonly onLiveApplied?: () => void;
  readonly onLayoutChanged?: () => void;
  /**
   * Files dragged from the computer and dropped on the mirror (D107). The
   * frame never takes them; without this option a drop there does nothing.
   */
  readonly onFileDrop?: (files: readonly File[]) => void;
  readonly onSourceScroll?: (scroll: HtmlMirrorScrollState) => void;
  readonly onSourceCommit?: (commit: ReplicaSourceCommit) => void;
  readonly onLiveFailure?: (code: ReplicaDiagnosticCode) => void;
  readonly onInfo?: (info: IsolatedMirrorInfo) => void;
  readonly scheduleLayoutRefresh?: (callback: () => void) => void;
  readonly setSemanticReconnectTimer?: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  readonly clearSemanticReconnectTimer?: (timer: unknown) => void;
  readonly iframeDeadlineMs?: number;
  readonly styleSettleDeadlineMs?: number;
  readonly initializeIframe?: (
    iframe: HTMLIFrameElement,
    shell: string,
    signal?: AbortSignal,
  ) => Promise<Document>;
}

interface HtmlMirrorDomState {
  readonly lease: VisibleReplayCandidateLease;
  readonly iframe: HTMLIFrameElement;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
  /**
   * A preview (D163): far boxes are empty boxes of their height. It is
   * shown until the full copy of a later sequence replaces it, and never
   * patched.
   */
  readonly preview: boolean;
  /** The replica's `<html>`, the document's own. Read on every commit; kept
   * here so that reading the document's language is not a walk of every
   * mirrored node (R3). */
  readonly root: Element | undefined;
  /** By id, with each node's id kept beside it (D165). */
  readonly nodes: ReplicaNodeMap;
  /** With the bytes they count toward the budget kept as a total (D165). */
  readonly textMetadata: ReplicaTextMap<Extract<HtmlMirrorNode, { kind: 'text' }>>;
  readonly controlMetadata: ReplicaTextMap<HtmlMirrorControlText>;
  readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
  readonly paintedLabelHosts: Map<number, HTMLElement>;
  /**
   * Text records whose translation was shown since the mirror's layout was
   * last settled: whether each is a label painted as a picture is looked at
   * then, for all of them over one layout (see `#settlePaintedLabels`).
   */
  readonly pendingPaintedLabels: Set<number>;
  readonly geometry: TranslatedGeometryLock;
  /** `lang` on the elements that show a translation (D124). */
  readonly languages: TranslatedLanguageTags;
  readonly records: Map<number, ReplicaSourceTextRecord>;
  readonly revisions: Map<number, number>;
  sequence: number;
  readonly replayLease: number;
  dimensions: HtmlMirrorLiveDimensions;
  representability: HtmlMirrorRepresentabilitySummary;
  replicaRequestsMayOccur: boolean;
  readonly styleReadiness: ReplicaStyleReadiness;
  readonly cleanup: Set<() => void>;
  released: boolean;
  /**
   * What the panel keeps of this replica, counted as it changes (D165):
   * made at the first live patch, from one walk of the replica.
   */
  ledger?: RetainedReplicaLedger;
}

type HtmlMirrorLiveDimensions = HtmlMirrorCheckpoint['payload'] & Readonly<{
  canvasBackgroundColor?: string;
}>;

const HTML_MIRROR_RECOVERY_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_RECOVERY_PATCHES = 4;
const SEMANTIC_RECONNECT_BASE_DELAY_MS = 250;
const SEMANTIC_RECONNECT_MAX_DELAY_MS = 8_000;

const NAMESPACE_URIS = Object.freeze({
  html: 'http://www.w3.org/1999/xhtml',
  svg: 'http://www.w3.org/2000/svg',
  mathml: 'http://www.w3.org/1998/Math/MathML',
});

/** A scriptless real-DOM mirror with private identity and ordered patches. */
export class IsolatedHtmlReplicaEngine
  implements ReplicaEngine, ReplicaTranslationSurface, ReplicaImageSurface {
  readonly id = 'isolated-html-v1' as const;
  #disposed = false;
  #runVersion = 0;
  #stream: HtmlMirrorStreamLease | undefined;
  #semanticStream: SemanticSourceStreamLease | undefined;
  #semanticReceiver: SemanticSourceReceiver | undefined;
  #semanticReconnectTimer: unknown;
  #semanticReconnectAttempt = 0;
  #stagingLease: VisibleReplayCandidateLease | undefined;
  #candidate: HtmlMirrorDomState | undefined;
  #committed: HtmlMirrorDomState | undefined;
  #recoveryTask: Promise<void> | undefined;
  #recoveryRequested = false;
  #recoveryAbort: AbortController | undefined;
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  #recoveryToken = 0;
  #bufferedRecoveryPatches: HtmlMirrorPatchBatch[] = [];
  /** The sequence of the checkpoint the recovery task stages (D163). */
  #stagingSequence: number | undefined;
  /**
   * A newer checkpoint that came while one was staged: the page answered a
   * request that the copy in flight had already answered (D163). Staged
   * once that one is committed.
   */
  #nextCheckpoint: HtmlMirrorCheckpoint | undefined;
  /**
   * The lease of the preview the committed copy replaced (D163): a
   * translation run that began on the preview goes on over the copy.
   */
  #replacedPreviewLease: number | undefined;
  /** Translation runs waiting for the full copy of a preview (D163). */
  readonly #textWaiters = new Set<() => void>();
  #replayLease = 0;
  #activeFidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative';
  #projectionContext: ReplicaProjectionContext = {
    translationEpoch: 0,
    pairKey: undefined,
  };
  #projections = new Map<number, ReplicaTextProjection>();
  /** The language the current pair translates to, when it says so (D124). */
  #projectionLanguage: string | undefined;
  #extentRefreshQueued = false;
  #pendingExtentState: HtmlMirrorDomState | undefined;

  constructor(private readonly options: IsolatedHtmlEngineOptions) {}

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (this.#disposed) return this.#failed('stream_failed');
    // A superseded request must not tear down the stream, semantic source or
    // staging candidate of the replica that is still current; check currency
    // before releasing anything.
    if (!request.isCurrent() || signal?.aborted) {
      return this.#skipped('stale_identity');
    }
    const runVersion = ++this.#runVersion;
    this.#cancelSemanticReconnect();
    this.#purgeSemantic(true);
    this.#releaseStream();
    this.#releaseCandidate();
    let stream: HtmlMirrorStreamLease | undefined;
    const fidelityPolicy = this.options.getReplicaFidelityPolicy?.() ??
      'conservative';
    this.#activeFidelityPolicy = fidelityPolicy;
    const limits = this.options.getMirrorLimits?.() ??
      DEFAULT_HTML_MIRROR_LIMIT_SETTINGS;
    applyHtmlMirrorLimitSettings(limits);
    const showEverything = this.options.getShowEverything?.() === true;
    applySourcePrivacyFiltersOff(showEverything);
    try {
      stream = await this.options.openStream(
        request,
        fidelityPolicy,
        signal,
        limits,
        showEverything,
      );
      if (!this.#isCurrent(runVersion, request, signal)) {
        stream.dispose();
        return this.#skipped('stale_identity');
      }
      this.options.onInfo?.(emptyInfo(
        'connected',
        undefined,
        EMPTY_REPRESENTABILITY,
        fidelityPolicy,
      ));
      const checkpoint = await stream.initialCheckpoint;
      if (!this.#isCurrent(runVersion, request, signal)) {
        stream.dispose();
        return this.#skipped('stale_identity');
      }
      const state = await this.#stageCheckpoint(
        checkpoint,
        fidelityPolicy,
        signal,
      );
      if (!this.#isCurrent(runVersion, request, signal)) {
        if (this.#candidate === state) this.#candidate = undefined;
        releaseState(state);
        stream.dispose();
        return this.#skipped('stale_identity');
      }
      this.#commitState(state, 'checkpoint', request, runVersion, signal);
      this.#stream = stream;
      stream.setObserver({
        onPatch: (batch) => this.#onPatch(batch, request, runVersion),
        onCheckpoint: (next) => this.#onRecoveryCheckpoint(
          next,
          request,
          runVersion,
        ),
        onScroll: (update) => this.#onSourceScroll(
          update,
          request,
          runVersion,
        ),
        onFailure: (code, representability) => this.#onStreamFailure(
          code,
          request,
          runVersion,
          representability ?? EMPTY_REPRESENTABILITY,
        ),
        onProgress: () => this.#onStreamProgress(request, runVersion),
      });
      // setObserver() synchronously drains anything queued after the initial
      // checkpoint. A queued terminal failure releases this stream, so never
      // acknowledge or report a successful run after that drain.
      if (this.#stream !== stream) {
        return this.#isCurrent(runVersion, request, signal)
          ? this.#failed('stream_failed')
          : this.#skipped('stale_identity');
      }
      stream.acknowledge(checkpoint.identity.sequence);
      this.options.onInfo?.(stateInfo('checkpoint', state, 0));
      const diagnostics = this.#diagnostics(checkpoint, state);
      return { status: 'complete', diagnostics };
    } catch (error) {
      stream?.dispose();
      if (!this.#isCurrent(runVersion, request, signal)) {
        return this.#skipped('stale_identity');
      }
      const reported = error instanceof HtmlMirrorClientError
        ? error.code
        : error instanceof DOMException && error.name === 'AbortError'
          ? 'stale_identity'
          : 'replay_failed';
      if (reported === 'stale_identity') return this.#skipped(reported);
      // The page could not be read whole because it is over the mirror's
      // limits: say so, rather than a failure a retry could mend (D162).
      const code: ReplicaDiagnosticCode = reported === 'stream_overflow' &&
        error instanceof HtmlMirrorClientError &&
        error.representability.capacityOmissionCount > 0
        ? 'checkpoint_too_large'
        : reported;
      this.options.onInfo?.(emptyInfo(
        'failed',
        code,
        error instanceof HtmlMirrorClientError
          ? error.representability
          : EMPTY_REPRESENTABILITY,
        fidelityPolicy,
      ));
      return this.#failed(code);
    }
  }

  beginProjection(context: ReplicaProjectionContext): void {
    if (
      !Number.isSafeInteger(context.translationEpoch) ||
      context.translationEpoch < 0 ||
      (context.pairKey !== undefined && context.pairKey.length > 128)
    ) return;
    this.#projectionContext = Object.freeze({ ...context });
    this.#projectionLanguage = context.pairKey === undefined
      ? undefined
      : translationLanguageTag(context.targetLanguage);
    this.#projections.clear();
    const state = this.#committed;
    if (!state) return;
    clearIsolatedPaintedLabels(state);
    // Before the select facsimiles are drawn again from the page's text.
    state.languages.release();
    for (const record of state.records.values()) {
      const node = state.nodes.get(record.nodeId);
      if (record.nodeType === 3 && (node != null && sourceNodeType(node) === Node.TEXT_NODE)) {
        node.nodeValue = record.source;
      } else if (record.nodeType === 1 && (node != null && sourceNodeType(node) === Node.ELEMENT_NODE)) {
        applyControlText(node as Element, {
          kind: record.controlTarget,
          text: record.source,
          translatable: true,
        });
      }
    }
    this.#semanticReceiver?.restoreSources();
    markIsolatedAriaIndexDirty(state.iframe.contentDocument ?? undefined);
    refreshIsolatedNativeSelectFacsimiles(state.iframe.contentDocument);
    this.#refreshExtent(state);
  }

  /**
   * A preview is shown and its full copy is coming (D163): a translation
   * run waits for the copy's text instead of ending on the preview's.
   */
  isReading(): boolean {
    const state = this.#committed;
    return Boolean(state && !state.released && state.preview && this.#stream);
  }

  /**
   * Resolves at the next commit, or when the full copy can no longer come
   * (the stream failed, the mirror was released); rejects when `signal`
   * aborts.
   */
  waitForText(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const abort = (): void => {
        this.#textWaiters.delete(wake);
        reject(signal.reason);
      };
      const wake = (): void => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      this.#textWaiters.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Whether the committed copy replaced the preview of lease `replayLease` (D163). */
  extendsLease(replayLease: number): boolean {
    return this.#committed !== undefined &&
      replayLease === this.#replacedPreviewLease;
  }

  snapshot(): ReplicaTranslationSnapshot | undefined {
    const state = this.#committed;
    if (!state || state.released) return undefined;
    const documentLanguage = readDocumentLanguage(state);
    return Object.freeze({
      document: state.document,
      ...(documentLanguage ? { documentLanguage } : {}),
      replayLease: state.replayLease,
      records: this.#combinedRecords(state),
    });
  }

  project(projection: ReplicaTextProjection): boolean {
    const state = this.#committed;
    if (
      !state || state.released ||
      projection.replayLease !== state.replayLease ||
      projection.translationEpoch !== this.#projectionContext.translationEpoch ||
      projection.pairKey !== this.#projectionContext.pairKey ||
      !sameSourceDocument(projection.document, state.document) ||
      projection.translated.length > 1_000_000
    ) return false;
    if (projection.nodeId < 0) {
      const record = this.#semanticReceiver?.get(projection.nodeId);
      if (
        !record || record.nodeType !== projection.nodeType ||
        record.revision !== projection.sourceRevision ||
        record.source !== projection.source ||
        !this.#semanticReceiver?.project(projection)
      ) return false;
      this.#projections.set(projection.nodeId, Object.freeze({ ...projection }));
      state.languages.show(
        projection.nodeId,
        this.#semanticReceiver.elementShowing(projection.nodeId),
        this.#languageOf(projection),
      );
      refreshIsolatedNativeSelectFacsimiles(state.iframe.contentDocument);
      this.#refreshExtent(state);
      return true;
    }
    const record = state.records.get(projection.nodeId);
    const node = state.nodes.get(projection.nodeId);
    if (
      !record ||
      record.nodeType !== projection.nodeType ||
      record.revision !== projection.sourceRevision ||
      record.source !== projection.source
    ) return false;
    if (projection.nodeType === 3) {
      if (node == null || sourceNodeType(node) !== Node.TEXT_NODE) return false;
      node.nodeValue = projection.translated;
      state.languages.show(
        projection.nodeId,
        composedParentElement(node),
        this.#languageOf(projection),
      );
      state.pendingPaintedLabels.add(projection.nodeId);
    } else {
      if (
        (node == null || sourceNodeType(node) !== Node.ELEMENT_NODE) ||
        record.nodeType !== 1 ||
        record.controlTarget !== projection.controlTarget
      ) return false;
      applyControlText(node as Element, {
        kind: projection.controlTarget,
        text: projection.translated,
        translatable: true,
      });
      // Before the select facsimile copies the option's language.
      state.languages.show(
        projection.nodeId,
        node as Element,
        this.#languageOf(projection),
      );
      syncContainingIsolatedSelectFacsimile(node as Element);
    }
    this.#projections.set(projection.nodeId, Object.freeze({ ...projection }));
    this.#refreshExtent(state);
    return true;
  }

  showsLineBreaks(nodeId: number): boolean {
    const state = this.#committed;
    if (!state || state.released) return false;
    if (nodeId < 0) {
      return elementShowsLineBreaks(
        this.#semanticReceiver?.elementShowing(nodeId),
      );
    }
    const node = state.nodes.get(nodeId);
    if (node != null && sourceNodeType(node) === Node.TEXT_NODE) {
      // A slotted text takes its style from the slot, not from the host.
      return elementShowsLineBreaks(
        (node as Text).assignedSlot ?? composedParentElement(node),
      );
    }
    return (node != null && sourceNodeType(node) === Node.ELEMENT_NODE) &&
      elementShowsLineBreaks(node as Element);
  }

  resolveImageAnchor(
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ): ReplicaImageAnchor | undefined {
    const state = this.#committed;
    if (!state || state.released || !sameSourceDocument(state.document, document)) {
      return undefined;
    }
    const node = state.nodes.get(nodeId);
    if (
      !node ||
      sourceNodeType(node) !== Node.ELEMENT_NODE ||
      sourceLocalName((node as Element)).toLowerCase() !== 'img' ||
      !sourceProperty(node, 'isConnected') ||
      sourceProperty(node, 'ownerDocument') !== state.iframe.contentDocument
    ) return undefined;
    return Object.freeze({
      document: state.document,
      replayLease: state.replayLease,
      image: node as HTMLImageElement,
      iframe: state.iframe,
    });
  }

  releasePresentation(): void {
    this.#runVersion += 1;
    this.#cancelSemanticReconnect();
    this.#purgeSemantic(false);
    this.#releaseStream();
    this.#releaseCandidate();
    releaseState(this.#committed);
    this.#committed = undefined;
    this.#replacedPreviewLease = undefined;
    this.#projections.clear();
    this.#replayLease += 1;
    this.options.presentationHost.clearPresentation();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releasePresentation();
  }

  async #stageCheckpoint(
    checkpoint: HtmlMirrorCheckpoint,
    fidelityPolicy: SelectableReplicaFidelityPolicy,
    signal?: AbortSignal,
  ): Promise<HtmlMirrorDomState> {
    signal?.throwIfAborted();
    const preview = checkpoint.payload.preview === true;
    // A checkpoint read in parts reaches the engine assembled; only a
    // preview's empty boxes are shells here (D163).
    const content = readHtmlMirrorDocumentContent(
      checkpoint.payload.root,
      checkpoint.payload.adoptedStyleSheets,
      fidelityPolicy,
      createHtmlMirrorShellLedger({ placeholder: preview }),
    );
    const graph = content?.root;
    if (!content || !graph || graph.tagName !== 'html') {
      throw new Error('Invalid isolated HTML checkpoint.');
    }
    if (!validStyleSheetTextInGraph(graph, fidelityPolicy)) {
      // A `<style>` split over several text nodes whose joined text is not a
      // fixed point: the mirror would build the sheet the page did not show
      // (R1).
      throw new Error('Invalid isolated HTML checkpoint.');
    }
    const lease = this.options.presentationHost.createCandidate({
      viewportWidth: checkpoint.payload.viewportWidth,
      viewportHeight: checkpoint.payload.viewportHeight,
      documentWidth: checkpoint.payload.documentWidth,
      documentHeight: checkpoint.payload.documentHeight,
      ...(graph.canvasBackgroundColor
        ? { canvasBackgroundColor: graph.canvasBackgroundColor }
        : {}),
    });
    this.#stagingLease = lease;
    const iframe = sourceProperty(lease.mount, 'ownerDocument').createElement('iframe');
    protectIframe(iframe);
    let disposeStagedDisclosureGuards: (() => void) | undefined;
    const documentMode = checkpoint.payload.documentMode;
    const iframeShell = documentMode === 'quirks'
      ? ISOLATED_HTML_QUIRKS_SHELL
      : documentMode === 'limited-quirks'
        ? ISOLATED_HTML_LIMITED_QUIRKS_SHELL
        : ISOLATED_HTML_SHELL;
    try {
      let iframeDocument: Document;
      if (this.options.initializeIframe) {
        iframe.srcdoc = trustedShellHtml(iframeShell);
        sourceCall(lease.mount, 'append', iframe);
        iframeDocument = await this.options.initializeIframe(
          iframe,
          iframeShell,
          signal,
        );
      } else if (documentMode !== 'standards') {
        iframeDocument = writeQuirksIframeDocument(
          iframe,
          lease.mount,
          iframeShell,
          documentMode,
        );
      } else {
        iframeDocument = await initializeIframeDocument(
          iframe,
          lease.mount,
          iframeShell,
          this.options.iframeDeadlineMs ?? 5_000,
          signal,
        );
      }
      if (this.#stagingLease !== lease) {
        throw new DOMException('Isolated iframe staging was cancelled.', 'AbortError');
      }
      if (!iframeDocument) throw new Error('Isolated iframe document unavailable.');
      const nodes = new ReplicaNodeMap();
      const textMetadata = new ReplicaTextMap<
        Extract<HtmlMirrorNode, { kind: 'text' }>
      >();
      const controlMetadata = new ReplicaTextMap<HtmlMirrorControlText>();
      const ownedAdoptedStyles = new Set<HTMLStyleElement>();
      const disposeDisclosureGuards = installIsolatedDisclosureGuards(
        iframeDocument,
        iframe,
        this.options.onFileDrop,
      );
      disposeStagedDisclosureGuards = disposeDisclosureGuards;
      applyDocumentGraph(
        iframeDocument,
        graph,
        content.adoptedStyleSheets,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
      );
      refreshIsolatedReplicaDisclosures(iframeDocument);
      const styleReadiness = await settleReplicaStyles(
        iframeDocument,
        this.options.styleSettleDeadlineMs ?? 300,
        signal,
      );
      const document = sourceDocumentIdentity(checkpoint.identity);
      const previous = this.#committed && sameSourceDocument(
        this.#committed.document,
        document,
      ) && this.#committed.fidelityPolicy === fidelityPolicy
        ? this.#committed
        : undefined;
      let previousRevision = previous?.revisions.get(0) ?? 0;
      for (const record of previous?.records.values() ?? []) {
        previousRevision = Math.max(previousRevision, record.revision);
      }
      const revisions = new Map<number, number>([[0, previousRevision]]);
      const records = buildRecords(
        document,
        textMetadata,
        controlMetadata,
        revisions,
        previous?.records,
      );
      const replayLease = this.#replayLease + 1;
      const state: HtmlMirrorDomState = {
        lease,
        iframe,
        document,
        fidelityPolicy,
        preview,
        root: iframeDocument.documentElement,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
        paintedLabelHosts: new Map(),
        pendingPaintedLabels: new Set(),
        geometry: new TranslatedGeometryLock(),
        languages: new TranslatedLanguageTags(),
        records,
        revisions,
        sequence: checkpoint.identity.sequence,
        replayLease,
        dimensions: {
          ...checkpoint.payload,
          ...(graph.canvasBackgroundColor
            ? { canvasBackgroundColor: graph.canvasBackgroundColor }
            : {}),
        },
        representability: checkpoint.payload.representability,
        replicaRequestsMayOccur:
          checkpoint.payload.representability
            .replicaRequestCapableResourceCount > 0,
        styleReadiness,
        cleanup: new Set(),
        released: false,
      };
      state.cleanup.add(disposeDisclosureGuards);
      state.cleanup.add(() => disposeReadOnlyReplicaDisclosures(iframeDocument));
      disposeStagedDisclosureGuards = undefined;
      installStateLayoutObservers(state, () => this.#refreshExtent(state));
      this.#applyRetainedProjections(state);
      this.#stagingLease = undefined;
      this.#candidate = state;
      return state;
    } catch (error) {
      disposeStagedDisclosureGuards?.();
      if (this.#stagingLease === lease) this.#stagingLease = undefined;
      lease.release();
      throw error;
    }
  }

  #commitState(
    state: HtmlMirrorDomState,
    reason: ReplicaSourceCommit['reason'],
    request: ReplicaCaptureRequest,
    runVersion: number,
    signal?: AbortSignal,
  ): void {
    this.#settlePaintedLabels(state);
    this.#applyTextLayout(state);
    const extent = measureExtent(state.iframe);
    // The host finds a pane the tab scrolled by its node id (D122).
    state.lease.commit(
      state.iframe,
      extent,
      (nodeId) => state.nodes.get(nodeId),
    );
    const previous = this.#committed;
    const previousLanguage = previous && !previous.released
      ? readDocumentLanguage(previous)
      : undefined;
    this.#cancelSemanticReconnect();
    const semanticRemovals = this.#purgeSemantic(false);
    const changes = Object.freeze([
      ...checkpointChanges(state, previous),
      ...semanticRemovals,
    ]);
    const documentLanguageChanged = readDocumentLanguage(state) !== previousLanguage;
    // The full copy of a preview (D163): a run that began on the preview
    // goes on over it.
    const replacesPreview = Boolean(
      previous && !previous.released && previous.preview && !state.preview &&
        sameSourceDocument(previous.document, state.document),
    );
    if (replacesPreview) {
      // A translation shown on the preview while the copy was staged.
      this.#applyRetainedProjections(state);
      this.#settlePaintedLabels(state);
    }
    this.#candidate = undefined;
    this.#committed = state;
    this.#replayLease = state.replayLease;
    this.#replacedPreviewLease = replacesPreview
      ? previous!.replayLease
      : undefined;
    this.#recoveryRequested = false;
    releaseState(previous);
    this.options.presentationHost.markLive(state.iframe);
    this.#notifySourceCommit(
      state,
      reason,
      changes,
      documentLanguageChanged,
    );
    // The page's semantic reader starts with a scan of the whole page: it
    // waits for the full copy, which replaces the preview's boxes (D163).
    if (!state.preview) {
      this.#openSemanticSource(state, request, runVersion, signal);
    }
    this.options.onLayoutChanged?.();
    this.#wakeTextWaiters();
  }

  #wakeTextWaiters(): void {
    const waiters = [...this.#textWaiters];
    this.#textWaiters.clear();
    for (const wake of waiters) wake();
  }

  #onPatch(
    batch: HtmlMirrorPatchBatch,
    request: ReplicaCaptureRequest,
    runVersion: number,
  ): void {
    if (this.#recoveryRequested || this.#recoveryTask) {
      if (this.#bufferedRecoveryPatches.length >= MAX_BUFFERED_RECOVERY_PATCHES) {
        this.#failLive('stream_overflow');
        return;
      }
      this.#bufferedRecoveryPatches.push(batch);
      return;
    }
    this.#applyLivePatch(batch, request, runVersion);
  }

  #onSourceScroll(
    update: HtmlMirrorScrollUpdate,
    request: ReplicaCaptureRequest,
    runVersion: number,
  ): void {
    const state = this.#committed;
    if (
      !state || !this.#isCurrent(runVersion, request) ||
      !sameSourceDocument(sourceDocumentIdentity(update.identity), state.document)
    ) return;
    this.options.onSourceScroll?.(update.scroll);
  }

  /**
   * One message: a patch, or the patches of one frame of the page. A page
   * changes in one step, and what it changed in a frame can take up to
   * three patches; applied in tasks of their own, the browser drew between
   * them and the reader saw a dialog without its styles, or the old view
   * beside the new one, for a moment the page never showed (D143).
   */
  #applyLivePatch(
    batch: HtmlMirrorPatchBatch,
    request: ReplicaCaptureRequest,
    runVersion: number,
  ): void {
    const state = this.#committed;
    const stream = this.#stream;
    if (!state || !stream || !this.#isCurrent(runVersion, request)) return;
    if (
      // A preview is never patched: the page sends patches after the full
      // copy's ACK, never its preview's (D163).
      state.preview ||
      batch.firstSequence !== state.sequence + 1 ||
      batch.lastSequence !== batch.firstSequence
    ) {
      this.#requestRecovery(
        'stream_gap',
        EMPTY_PATCH_METRICS,
        batch.representability,
        'out-of-order',
      );
      return;
    }
    const frame = htmlMirrorFramePatches(batch);
    const last = frame[frame.length - 1]!;
    const operations = frame.length === 1
      ? batch.operations
      : frame.flatMap((patch) => patch.operations);
    // Read only by the diagnostics listener (D165).
    const replacementMetrics = this.options.onInfo
      ? readPatchMetrics(state, operations)
      : EMPTY_PATCH_METRICS;
    const replicaDocument = state.iframe.contentDocument;
    const disclosureBindingsMayHaveChanged = operations.some(
      ({ kind }) => kind !== 'dimensions' && kind !== 'text',
    );
    const changedRoots = operations.flatMap((operation) => {
      if (operation.kind === 'dimensions') return [];
      const target = state.nodes.get(operation.nodeId);
      return target ? [target] : [];
    });
    const retainedOpenDisclosures =
      replicaDocument && disclosureBindingsMayHaveChanged
      ? snapshotOpenReadOnlyReplicaDisclosures(replicaDocument)
      : undefined;
    if (replicaDocument && disclosureBindingsMayHaveChanged) {
      // The site menus on or around what the patch changes come down; the
      // rest stay up through it (D185).
      this.#semanticReceiver?.beforeLivePatch(changedRoots);
      disposeReadOnlyReplicaDisclosures(replicaDocument, true);
    }
    const retainedPaintedLabelIds = [...state.paintedLabelHosts.keys()];
    clearIsolatedPaintedLabels(state);
    const pageLanguages = patchedPageLanguages(state, operations);
    const contentLanguage = disclosureBindingsMayHaveChanged
      ? documentContentLanguage(replicaDocument)
      : undefined;
    let applied: AppliedPatchBatch | undefined;
    takePatchRefusal();
    try {
      applied = applyPatchFrame(state, frame.map((patch) => patch.operations));
    } finally {
      if (replicaDocument && disclosureBindingsMayHaveChanged) {
        refreshIsolatedReplicaDisclosures(
          replicaDocument,
          retainedOpenDisclosures,
          applied ? changedRoots : undefined,
        );
      }
    }
    if (!applied) {
      reconcileIsolatedPaintedLabels(state, this.#projections, retainedPaintedLabelIds);
      const reconciliationRejected = operations.some(
        ({ kind }) => kind === 'reconcile-children',
      );
      this.#requestRecovery(
        reconciliationRejected ? 'stream_gap' : 'privacy_rejected',
        Object.freeze({
          ...replacementMetrics,
          reconciliationRejectedCount: reconciliationRejected ? 1 : 0,
        }),
        last.representability,
        'refused',
        takePatchRefusal(),
      );
      return;
    }
    const patchMetrics = Object.freeze({
      ...replacementMetrics,
      retainedNodeCount: applied.retainedNodeCount,
      insertedNodeCount: applied.insertedNodeCount,
      movedNodeCount: applied.movedNodeCount,
      removedNodeCount: applied.removedNodeCount,
    });
    state.sequence = batch.lastSequence;
    state.replicaRequestsMayOccur ||= frame.some(
      (patch) => patch.representability.replicaRequestCapableResourceCount > 0,
    );
    stream.acknowledge(state.sequence);
    if (operations.some(({ kind }) => kind === 'dimensions')) {
      this.options.presentationHost.refreshDimensions?.(
        state.iframe,
        state.dimensions,
      );
    }
    this.options.presentationHost.markLive(state.iframe);
    const semanticReceiver = this.#semanticReceiver;
    const semanticBindingsMayHaveChanged = operations.some(
      ({ kind }) => kind !== 'dimensions',
    );
    const semanticProofsMayHaveChanged = operations.some(
      ({ kind }) => kind !== 'dimensions' && kind !== 'text',
    );
    let semanticChanges = semanticBindingsMayHaveChanged
      ? semanticReceiver?.refreshBindings(
        semanticProofsMayHaveChanged,
        // Only what the patch touched is asked again (D185).
        semanticRefreshScope(operations, (nodeId) => state.nodes.get(nodeId)),
      ) ?? []
      : [];
    if (
      semanticReceiver && semanticBindingsMayHaveChanged &&
      !semanticProofsMayHaveChanged
    ) refreshIsolatedNativeSelectFacsimiles(replicaDocument);
    // The patch may have brought an element whose label or state came before
    // it (D132).
    const arrivedChanges = operations.some(
      ({ kind }) => kind === 'children' || kind === 'reconcile-children',
    )
      ? semanticReceiver?.placeArrivedNodes()
      : undefined;
    if (arrivedChanges) {
      semanticChanges = Object.freeze([...semanticChanges, ...arrivedChanges]);
      refreshIsolatedNativeSelectFacsimiles(replicaDocument);
    }
    if (semanticReceiver && !semanticReceiver.proofPresentationHealthy) {
      semanticChanges = Object.freeze([
        ...semanticChanges,
        ...this.#purgeSemantic(false),
      ]);
      this.#scheduleSemanticReconnect(state, request, runVersion);
    }
    const sourceChanges = Object.freeze([
      ...applied.changes,
      ...semanticChanges,
    ]);
    for (const change of sourceChanges) {
      this.#dropProjection(state, sourceChangeNodeId(change));
    }
    // The page changed a `lang` or an `xml:lang`: inside that element, what
    // counts as already in the language translated to may have changed with
    // it (D124). A change of the document's own language is the same for
    // every element that declares none.
    const relanguaged = new Set<Element>();
    for (const [element, language, xmlLanguage] of pageLanguages) {
      if (
        pageAttribute(element, 'lang') !== language ||
        pageXmlLanguage(element) !== xmlLanguage
      ) relanguaged.add(element);
    }
    if (
      disclosureBindingsMayHaveChanged && replicaDocument?.documentElement &&
      documentContentLanguage(replicaDocument) !== contentLanguage
    ) relanguaged.add(replicaDocument.documentElement);
    if (relanguaged.size > 0) {
      // The select facsimiles were drawn while the patch was applied, with
      // the tags as they were before it.
      syncIsolatedSelectFacsimilesShowing(
        state.languages.refresh(relanguaged),
      );
      // The image projector tags the images it names.
      if (replicaDocument) refreshImageLanguages(replicaDocument);
    }
    reconcileIsolatedPaintedLabels(
      state,
      this.#projections,
      retainedPaintedLabelIds,
    );
    // An element whose attributes the patch changed (a class that gives a
    // logo its picture) may have become a painted label: its translated text
    // is looked at when the layout is next settled (D173). So may an element
    // passed over as no label inside one of those, or anywhere in the replica
    // when a sheet changed (D204).
    const lookAgain = (element: Node): void => {
      for (const child of sourceChildNodeList(element)) {
        if (sourceNodeType(child) !== Node.TEXT_NODE) continue;
        const nodeId = state.nodes.idOf(child);
        if (nodeId !== undefined && this.#projections.has(nodeId)) {
          state.pendingPaintedLabels.add(nodeId);
        }
      }
    };
    const changedElements: Element[] = [];
    let sheetsChanged = false;
    for (const operation of operations) {
      if (operation.kind === 'dimensions') continue;
      const target = state.nodes.get(operation.nodeId);
      if (!target) continue;
      if (
        holdsReplicaSheet(target) ||
        holdsReplicaSheet(sourceProperty(target, 'parentNode'))
      ) sheetsChanged = true;
      if (operation.kind === 'children' || operation.kind === 'reconcile-children') {
        if (operation.children.some(bringsReplicaSheet)) sheetsChanged = true;
        continue;
      }
      if (operation.kind !== 'attributes') continue;
      lookAgain(target);
      if (sourceNodeType(target) === Node.ELEMENT_NODE) changedElements.push(target as Element);
    }
    for (const host of paintedSemanticLabelHostsToLookAgain(
      changedElements,
      sheetsChanged ? replicaDocument ?? undefined : undefined,
    )) lookAgain(host);
    this.#notifySourceCommit(
      state,
      'batch',
      sourceChanges,
      frame.some(changesDocumentLanguage),
    );
    this.options.onLiveApplied?.();
    this.#refreshExtent(state);
    this.options.onInfo?.(stateInfo(
      'patch',
      state,
      operations.length,
      undefined,
      patchMetrics,
      last.representability,
    ));
  }

  #onRecoveryCheckpoint(
    checkpoint: HtmlMirrorCheckpoint,
    request: ReplicaCaptureRequest,
    runVersion: number,
  ): void {
    if (!this.#isCurrent(runVersion, request)) return;
    if (checkpoint.payload.preview) {
      // Only the stream's first checkpoint may be a preview (D163).
      this.#failLive('stream_failed');
      return;
    }
    const committed = this.#committed;
    if (this.#recoveryTask) {
      if (
        this.#stagingSequence !== undefined &&
        checkpoint.identity.sequence > this.#stagingSequence
      ) this.#nextCheckpoint = checkpoint;
      return;
    }
    if (!this.#recoveryRequested) {
      // Unasked for, only a copy newer than the mirror's replaces it: the
      // full copy of a preview, or the page's answer to a request the copy
      // in flight had already answered (D163). Anything else is ignored.
      if (!committed || checkpoint.identity.sequence <= committed.sequence) return;
      this.#recoveryAbort?.abort();
      this.#recoveryAbort = new AbortController();
    }
    if (
      committed &&
      checkpoint.identity.sequence < committed.sequence
    ) {
      // A checkpoint from before the mirror's committed sequence would
      // rewind it, and the buffered patches would then be replayed over
      // newer state. The source answers a recovery request with a checkpoint
      // of the sequence it has acknowledged, which is never older than the
      // mirror's; anything else is out of contract (R7).
      this.#failLive('stream_failed');
      return;
    }
    const token = this.#recoveryToken;
    const recoverySignal = this.#recoveryAbort?.signal;
    const fidelityPolicy = this.#committed?.fidelityPolicy ??
      this.options.getReplicaFidelityPolicy?.() ?? 'conservative';
    // A copy that replaces the mirror's, asked for or the full copy of a
    // preview (D163): its text is new to the panel, as a live change's is,
    // so the page's language is looked at again with all of it.
    const requested = this.#recoveryRequested;
    this.#stagingSequence = checkpoint.identity.sequence;
    this.#nextCheckpoint = undefined;
    const staging = this.#stageCheckpoint(
      checkpoint,
      fidelityPolicy,
      recoverySignal,
    );
    // Assigned before the first await below lets the finally block read it.
    let task!: Promise<void>;
    task = (async () => {
      try {
        const state = await staging;
        if (
          !this.#isCurrent(runVersion, request) ||
          token !== this.#recoveryToken ||
          recoverySignal?.aborted
        ) {
          if (this.#candidate === state) this.#candidate = undefined;
          releaseState(state);
          return;
        }
        const buffered = this.#bufferedRecoveryPatches.splice(0);
        this.#commitState(
          state,
          'recovery',
          request,
          runVersion,
          recoverySignal,
        );
        this.#stream?.acknowledge(checkpoint.identity.sequence);
        this.#finishRecoveryWatch(token);
        this.#recoveryTask = undefined;
        this.#stagingSequence = undefined;
        this.options.onInfo?.(stateInfo(
          requested ? 'recovery' : 'checkpoint',
          state,
          0,
        ));
        const next = this.#nextCheckpoint;
        this.#nextCheckpoint = undefined;
        if (next && next.identity.sequence > state.sequence) {
          // Patches follow the newest copy only.
          this.#onRecoveryCheckpoint(next, request, runVersion);
          return;
        }
        for (const batch of buffered) {
          const current = this.#committed;
          if (!current || batch.lastSequence <= current.sequence) continue;
          this.#applyLivePatch(batch, request, runVersion);
          if (this.#recoveryRequested || !this.#stream) break;
        }
      } catch {
        if (
          token === this.#recoveryToken &&
          this.#isCurrent(runVersion, request)
        ) this.#failLive('stream_failed');
      } finally {
        if (token === this.#recoveryToken && this.#recoveryTask === task) {
          this.#recoveryTask = undefined;
          this.#stagingSequence = undefined;
        }
      }
    })();
    this.#recoveryTask = task;
  }

  /**
   * A part of a checkpoint arrived (D163): a recovery that waits for the
   * page's checkpoint waits on while the page reads. A stall still times out.
   */
  #onStreamProgress(request: ReplicaCaptureRequest, runVersion: number): void {
    if (
      !this.#isCurrent(runVersion, request) ||
      !this.#recoveryRequested || this.#recoveryTask ||
      this.#recoveryTimer === undefined
    ) return;
    this.#armRecoveryTimer(this.#recoveryToken);
  }

  #armRecoveryTimer(token: number): void {
    if (this.#recoveryTimer !== undefined) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = setTimeout(() => {
      if (token !== this.#recoveryToken || !this.#recoveryRequested) return;
      this.#recoveryAbort?.abort(
        new Error('HTML mirror recovery checkpoint timed out.'),
      );
      this.#failLive('stream_failed');
    }, HTML_MIRROR_RECOVERY_TIMEOUT_MS);
  }

  #onStreamFailure(
    code: Extract<ReplicaDiagnosticCode, 'stream_gap' | 'stream_overflow' | 'stream_failed' | 'privacy_rejected'>,
    request: ReplicaCaptureRequest,
    runVersion: number,
    representability: HtmlMirrorRepresentabilitySummary,
  ): void {
    if (!this.#isCurrent(runVersion, request)) return;
    const state = this.#committed;
    if (
      code === 'stream_overflow' &&
      representability.capacityOmissionCount > 0 &&
      state && !state.released && state.preview
    ) {
      // A preview is shown and the page is over the mirror's limits: its
      // full copy cannot come, and a recovery would read the page whole
      // again only to overflow again. Say so, as a first read would (D163).
      this.#failLive('checkpoint_too_large', representability);
      return;
    }
    if (code === 'stream_failed') {
      this.#failLive(code, representability);
    } else {
      this.#requestRecovery(code, EMPTY_PATCH_METRICS, representability, 'page');
    }
  }

  #requestRecovery(
    code: ReplicaDiagnosticCode,
    metrics: IsolatedMirrorPatchMetrics,
    eventRepresentability: HtmlMirrorRepresentabilitySummary,
    cause: IsolatedMirrorRecoveryCause,
    refusal?: string,
  ): void {
    const state = this.#committed;
    if (this.#recoveryRequested) return;
    if (!state || !this.#stream) {
      this.#failLive(code);
      return;
    }
    this.#recoveryRequested = true;
    this.#bufferedRecoveryPatches = [];
    const token = ++this.#recoveryToken;
    this.#recoveryAbort?.abort();
    this.#recoveryAbort = new AbortController();
    this.#armRecoveryTimer(token);
    this.options.onInfo?.(Object.freeze({
      ...stateInfo('recovery', state, 0, code, metrics, eventRepresentability),
      recoveryCause: cause,
      ...(refusal ? { refusal } : {}),
    }));
    this.#stream.requestCheckpoint(state.sequence);
  }

  #failLive(
    code: ReplicaDiagnosticCode,
    eventRepresentability: HtmlMirrorRepresentabilitySummary =
      EMPTY_REPRESENTABILITY,
  ): void {
    const state = this.#committed;
    this.options.onInfo?.(
      state && !state.released
        ? stateInfo(
            'failed',
            state,
            0,
            code,
            EMPTY_PATCH_METRICS,
            eventRepresentability,
          )
        : emptyInfo(
            'failed',
            code,
            eventRepresentability,
            this.#activeFidelityPolicy,
          ),
    );
    this.#releaseStream();
    this.options.onLiveFailure?.(code);
  }

  #notifySourceCommit(
    state: HtmlMirrorDomState,
    reason: ReplicaSourceCommit['reason'],
    changes: readonly ReplicaSourceTextChange[],
    documentLanguageChanged: boolean,
  ): void {
    try {
      const documentLanguage = readDocumentLanguage(state);
      this.options.onSourceCommit?.({
        document: state.document,
        ...(documentLanguage ? { documentLanguage } : {}),
        documentLanguageChanged,
        replayLease: state.replayLease,
        records: this.#combinedRecords(state),
        changes,
        reason,
      });
    } catch {
      // Translation is derived work and cannot affect source acknowledgement.
    }
  }

  /** The language a projection is shown in, if the translator changed it. */
  #languageOf(projection: ReplicaTextProjection): string | undefined {
    return shownTranslationLanguage(
      this.#projectionLanguage,
      projection.source,
      projection.translated,
    );
  }

  #applyRetainedProjections(state: HtmlMirrorDomState): void {
    const retained = new Map<number, ReplicaTextProjection>();
    for (const projection of this.#projections.values()) {
      const record = state.records.get(projection.nodeId);
      const node = state.nodes.get(projection.nodeId);
      if (
        !record || record.nodeType !== projection.nodeType ||
        !sameSourceDocument(projection.document, state.document) ||
        record.source !== projection.source ||
        record.revision !== projection.sourceRevision ||
        projection.translationEpoch !== this.#projectionContext.translationEpoch ||
        projection.pairKey !== this.#projectionContext.pairKey
      ) continue;
      if (projection.nodeType === 3) {
        if (node == null || sourceNodeType(node) !== Node.TEXT_NODE) continue;
        node.nodeValue = projection.translated;
        state.languages.show(
          projection.nodeId,
          composedParentElement(node),
          this.#languageOf(projection),
        );
        state.pendingPaintedLabels.add(projection.nodeId);
      } else {
        if (
          (node == null || sourceNodeType(node) !== Node.ELEMENT_NODE) ||
          record.nodeType !== 1 ||
          record.controlTarget !== projection.controlTarget
        ) continue;
        applyControlText(node as Element, {
          kind: projection.controlTarget,
          text: projection.translated,
          translatable: true,
        });
        state.languages.show(
          projection.nodeId,
          node as Element,
          this.#languageOf(projection),
        );
      }
      retained.set(projection.nodeId, Object.freeze({
        ...projection,
        document: state.document,
        replayLease: state.replayLease,
      }));
    }
    this.#projections = retained;
    refreshIsolatedNativeSelectFacsimiles(state.iframe.contentDocument);
  }

  #combinedRecords(state: HtmlMirrorDomState): readonly ReplicaSourceTextRecord[] {
    return Object.freeze([
      ...state.records.values(),
      ...(this.#semanticReceiver?.records() ?? []),
    ]);
  }

  #openSemanticSource(
    state: HtmlMirrorDomState,
    request: ReplicaCaptureRequest,
    runVersion: number,
    signal?: AbortSignal,
  ): void {
    const open = this.options.openSemanticStream;
    const scope = SOURCE_PRIVACY_FILTERS_OFF
      ? FULL_VISIBLE_REPLICA_READ_SCOPE
      : this.options.getReplicaReadScope?.() ?? PAGE_ONLY_REPLICA_READ_SCOPE;
    if (!open || !hasSemanticReadScope(scope)) return;
    const replicaDocument = state.iframe.contentDocument;
    if (!replicaDocument) return;
    let retainedOpenDisclosures: ReadonlySet<HTMLElement> | undefined;
    const presenter = new SemanticProofPresenter({
      document: replicaDocument,
      iframe: state.iframe,
      setAncestorAccessibility: (accessible) =>
        this.options.presentationHost.setInteractiveAccessibility?.(
          state.iframe,
          accessible,
        ) ?? true,
      beforeApply: () => {
        retainedOpenDisclosures = snapshotOpenReadOnlyReplicaDisclosures(
          replicaDocument,
        );
      },
      afterApply: () => {
        // The presenter writes relations (`id`, `aria-controls`): the
        // ledger names the elements it changed, when there is one (D165).
        if (!RETAINED_LEDGERS.has(replicaDocument)) {
          markIsolatedAriaIndexDirty(replicaDocument);
        }
        refreshIsolatedNativeSelectFacsimiles(replicaDocument);
        refreshIsolatedReplicaDisclosures(
          replicaDocument,
          retainedOpenDisclosures,
        );
        retainedOpenDisclosures = undefined;
      },
    });
    const receiver = new SemanticSourceReceiver({
      document: state.document,
      replicaDocument,
      resolveNode: (nodeId) => state.nodes.get(nodeId),
      applyProofs: (proofs) => presenter.apply(proofs),
      takeDownTouchedProofs: (roots) => presenter.takeDownMenusTouching(roots),
      reportDroppedItems: (records, proofs) => {
        if (import.meta.env?.DEV) {
          console.info(
            `[Simul semantic] dropped records=${records}; proofs=${proofs}`,
          );
        }
      },
    });
    this.#semanticReceiver = receiver;
    const reconnect = (): void => {
      if (this.#semanticReceiver !== receiver) return;
      this.#purgeSemantic(true);
      this.#scheduleSemanticReconnect(state, request, runVersion, signal);
    };
    const opening = open(request, 'isolated-html', scope, signal);
    void (async () => {
      try {
        const lease = await opening;
        if (
          !this.#isCurrent(runVersion, request, signal) ||
          this.#committed !== state || this.#semanticReceiver !== receiver
        ) {
          lease.dispose();
          return;
        }
        this.#semanticStream = lease;
        lease.setObserver({
          onBatch: (batch) => {
            if (
              this.#committed !== state || this.#semanticReceiver !== receiver ||
              !this.#isCurrent(runVersion, request, signal)
            ) return false;
            const changes = receiver.applyBatch(batch);
            if (!changes) return false;
            this.#semanticReconnectAttempt = 0;
            for (const change of changes) {
              this.#dropProjection(state, sourceChangeNodeId(change));
            }
            refreshIsolatedNativeSelectFacsimiles(replicaDocument);
            this.#notifySourceCommit(state, 'batch', changes, false);
            this.#refreshExtent(state);
            return true;
          },
          onFailure: reconnect,
        });
      } catch {
        reconnect();
      }
    })();
  }

  #scheduleSemanticReconnect(
    state: HtmlMirrorDomState,
    request: ReplicaCaptureRequest,
    runVersion: number,
    signal?: AbortSignal,
  ): void {
    if (
      this.#semanticReconnectTimer !== undefined ||
      !this.options.openSemanticStream ||
      this.#committed !== state ||
      !this.#isCurrent(runVersion, request, signal)
    ) return;
    this.#semanticReconnectAttempt += 1;
    const delay = Math.min(
      SEMANTIC_RECONNECT_MAX_DELAY_MS,
      SEMANTIC_RECONNECT_BASE_DELAY_MS *
        2 ** Math.min(5, this.#semanticReconnectAttempt - 1),
    );
    const setTimer = this.options.setSemanticReconnectTimer ??
      ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
    this.#semanticReconnectTimer = setTimer(() => {
      this.#semanticReconnectTimer = undefined;
      if (
        this.#committed !== state ||
        !this.#isCurrent(runVersion, request, signal)
      ) return;
      this.#openSemanticSource(state, request, runVersion, signal);
    }, delay);
  }

  #cancelSemanticReconnect(): void {
    if (this.#semanticReconnectTimer !== undefined) {
      const clearTimer = this.options.clearSemanticReconnectTimer ??
        ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
      clearTimer(this.#semanticReconnectTimer);
    }
    this.#semanticReconnectTimer = undefined;
    this.#semanticReconnectAttempt = 0;
  }

  #purgeSemantic(notify: boolean): readonly ReplicaSourceTextChange[] {
    this.#semanticStream?.dispose();
    this.#semanticStream = undefined;
    const receiver = this.#semanticReceiver;
    this.#semanticReceiver = undefined;
    const changes = receiver?.clear() ?? Object.freeze([]);
    const state = this.#committed;
    markIsolatedAriaIndexDirty(state?.iframe.contentDocument ?? undefined);
    for (const change of changes) {
      this.#dropProjection(state, sourceChangeNodeId(change));
    }
    if (notify && state && !state.released && changes.length > 0) {
      this.#notifySourceCommit(state, 'batch', changes, false);
      this.#refreshExtent(state);
    }
    return changes;
  }

  /** A record's text changed or went: its translation no longer shows. */
  #dropProjection(state: HtmlMirrorDomState | undefined, nodeId: number): void {
    if (state) {
      clearIsolatedPaintedLabel(state, nodeId);
      hideTranslatedLanguage(state, nodeId);
    }
    this.#projections.delete(nodeId);
  }

  /**
   * A translated label that the page paints as a picture (a logo link whose
   * text is pushed out of its box) gets Simul's own drawn label. Finding one
   * reads the element's style and box, which makes Chrome lay the mirror out
   * again after every text that changed before it. Looked at as each
   * translation landed, a page of 9,000 translated elements whose
   * translations arrived together spent tens of seconds on those layouts,
   * in one task. So the question waits here until the layout is settled
   * anyway (before each extent measurement, which is before the next paint)
   * and is asked for every new translation over one layout. A translation
   * that has gone by then (its text changed, the pair changed) is passed
   * over: only one that still shows is looked at.
   */
  #settlePaintedLabels(state: HtmlMirrorDomState): void {
    if (state.pendingPaintedLabels.size === 0) return;
    const pending = [...state.pendingPaintedLabels];
    state.pendingPaintedLabels.clear();
    reconcileIsolatedPaintedLabels(state, this.#projections, pending);
  }

  /** Applies a changed "Translated text" setting to the visible replica. */
  refreshTextLayout(): void {
    const state = this.#committed;
    if (state && !state.released) this.#refreshExtent(state);
  }

  /**
   * With "Keep geometry", every box showing translated text keeps the size it
   * has with the page's text, and text that no longer fits shrinks. Runs
   * before each extent measurement, so a new translation, a patch, a resize
   * or a late image never paints at the translated size.
   */
  #applyTextLayout(state: HtmlMirrorDomState): void {
    const view = state.iframe.contentWindow;
    if (this.options.getTextLayoutMode?.() !== 'faithful' || !view) {
      state.geometry.release();
      return;
    }
    const entries: TranslatedGeometryEntry[] = [];
    for (const projection of this.#projections.values()) {
      if (projection.nodeId < 0) continue;
      const record = state.records.get(projection.nodeId);
      const node = state.nodes.get(projection.nodeId);
      if (
        !record || !node ||
        record.nodeType !== projection.nodeType ||
        record.source !== projection.source ||
        record.revision !== projection.sourceRevision
      ) continue;
      if (projection.nodeType === 3) {
        if (sourceNodeType(node) !== Node.TEXT_NODE) continue;
        // The language tag stays where it is: the element is drawn by the
        // page's language with it or without it (D124).
        entries.push({
          node,
          showSource: () => { node.nodeValue = record.source; },
          showTranslation: () => { node.nodeValue = projection.translated; },
        });
      } else if (
        sourceNodeType(node) === Node.ELEMENT_NODE &&
        record.nodeType === 1 &&
        record.controlTarget === projection.controlTarget
      ) {
        const kind = record.controlTarget;
        entries.push({
          node,
          showSource: () => {
            applyControlText(node as Element, {
              kind, text: record.source, translatable: true,
            });
          },
          showTranslation: () => {
            applyControlText(node as Element, {
              kind, text: projection.translated, translatable: true,
            });
          },
        });
      }
    }
    state.geometry.lock(entries, view);
  }

  #refreshExtent(state: HtmlMirrorDomState): void {
    if (this.#committed !== state || state.released) return;
    this.#pendingExtentState = state;
    if (this.#extentRefreshQueued) return;
    this.#extentRefreshQueued = true;
    const refresh = (): void => {
      this.#extentRefreshQueued = false;
      const pending = this.#pendingExtentState;
      this.#pendingExtentState = undefined;
      if (!pending || this.#committed !== pending || pending.released) return;
      this.#settlePaintedLabels(pending);
      this.#applyTextLayout(pending);
      this.options.presentationHost.refreshExtent(
        pending.iframe,
        measureExtent(pending.iframe),
      );
      this.options.onLayoutChanged?.();
    };
    const view = state.iframe.ownerDocument?.defaultView;
    if (this.options.scheduleLayoutRefresh) {
      this.options.scheduleLayoutRefresh(refresh);
    } else if (typeof view?.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(refresh);
    } else {
      queueMicrotask(refresh);
    }
  }

  #isCurrent(
    version: number,
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): boolean {
    return !this.#disposed && !signal?.aborted &&
      version === this.#runVersion && request.isCurrent();
  }

  #releaseStream(): void {
    this.#stream?.dispose();
    this.#stream = undefined;
    this.#recoveryRequested = false;
    this.#cancelRecoveryWatch();
    // No full copy of a preview comes now: a run waiting for one goes on
    // (D163).
    this.#wakeTextWaiters();
  }

  #finishRecoveryWatch(token: number): void {
    if (token !== this.#recoveryToken) return;
    if (this.#recoveryTimer !== undefined) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    this.#recoveryAbort = undefined;
  }

  #cancelRecoveryWatch(): void {
    this.#recoveryToken += 1;
    if (this.#recoveryTimer !== undefined) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = undefined;
    this.#recoveryAbort?.abort();
    this.#recoveryAbort = undefined;
    this.#recoveryTask = undefined;
    this.#stagingSequence = undefined;
    this.#nextCheckpoint = undefined;
    this.#bufferedRecoveryPatches = [];
  }

  #releaseCandidate(): void {
    this.#stagingLease?.release();
    this.#stagingLease = undefined;
    releaseState(this.#candidate);
    this.#candidate = undefined;
  }

  #diagnostics(
    checkpoint: HtmlMirrorCheckpoint,
    state: HtmlMirrorDomState,
  ): ReplicaDiagnostics {
    const extent = measureExtent(state.iframe);
    return {
      engine: this.id,
      code: 'isolated_complete',
      bytes: checkpoint.payload.byteLength,
      eventCount: state.nodes.size,
      captureMs: checkpoint.payload.captureMs,
      replayMs: 0,
      sourceViewportWidth: checkpoint.payload.viewportWidth,
      sourceViewportHeight: checkpoint.payload.viewportHeight,
      sourceDocumentWidth: checkpoint.payload.documentWidth,
      sourceDocumentHeight: checkpoint.payload.documentHeight,
      replayDocumentWidth: extent.width,
      replayDocumentHeight: extent.height,
    };
  }

  #skipped(code: ReplicaDiagnosticCode): ReplicaRunResult {
    return { status: 'skipped', diagnostics: emptyReplicaDiagnostics(this.id, code) };
  }

  #failed(code: ReplicaDiagnosticCode): ReplicaRunResult {
    return { status: 'failed', diagnostics: emptyReplicaDiagnostics(this.id, code) };
  }
}

function applyDocumentGraph(
  target: Document,
  root: HtmlMirrorElementNode,
  adoptedStyleSheets: readonly string[],
  nodes: Map<number, Node>,
  textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
  controlMetadata: Map<number, HtmlMirrorControlText>,
  ownedAdoptedStyles: Set<HTMLStyleElement>,
): void {
  const html = target.documentElement;
  const head = target.head;
  const body = target.body;
  if (!html || !head || !body) throw new Error('Incomplete isolated iframe shell.');
  setAttributes(html, root.attributes);
  applyElementHints(html, root);
  nodes.set(root.id, html);
  // The page's own head and body: the first of each under `<html>`.
  const sourceHead = root.children.find(
    (node): node is HtmlMirrorElementNode =>
      isDocumentShellChild(node) && node.tagName === 'head',
  );
  const sourceBody = root.children.find(
    (node): node is HtmlMirrorElementNode =>
      isDocumentShellChild(node) && node.tagName === 'body',
  );
  // Retain the Simul-owned CSP and inert style; source nodes follow them.
  if (sourceHead) {
    setAttributes(head, sourceHead.attributes);
    applyElementHints(head, sourceHead);
    nodes.set(sourceHead.id, head);
    for (const child of sourceHead.children) {
      const built = buildNode(
        target,
        child,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
      );
      if (built) head.append(built);
    }
  }
  sourceCall(body, 'replaceChildren');
  if (sourceBody) {
    setAttributes(body, sourceBody.attributes);
    applyElementHints(body, sourceBody);
    nodes.set(sourceBody.id, body);
    for (const child of sourceBody.children) {
      const built = buildNode(
        target,
        child,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
      );
      if (built) sourceCall(body, 'append', built);
    }
    // A page may hang its whole content in a root on `<body>` (D135).
    if (sourceBody.shadowRoot) {
      buildShadowRoot(
        target,
        body,
        sourceBody.shadowRoot,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
      );
    }
  }
  // What else sits under `<html>`: a dialog or an overlay a page, or another
  // extension, appends beside `<body>`, and the white space between the two
  // (D135). Built in the page's order around the shell's own head and body,
  // so a later patch of `<html>`'s children finds every child it names. A
  // second `<head>` or `<body>` is built like any other element (D143): the
  // page draws it as one.
  const ordered: Node[] = [];
  for (const child of root.children) {
    if (child === sourceHead) {
      ordered.push(head);
    } else if (child === sourceBody) {
      ordered.push(body);
    } else {
      const built = buildNode(
        target,
        child,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
      );
      if (built) ordered.push(built);
    }
  }
  let anchor: Node | null = null;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const child = ordered[index]!;
    if (sourceProperty(child, 'parentNode') !== html || sourceProperty(child, 'nextSibling') !== anchor) {
      sourceCall(html, 'insertBefore', child, anchor);
    }
    anchor = child;
  }
  if (
    adoptedStyleSheets.length > 0 &&
    !adoptOwnedSheets(target, adoptedStyleSheets)
  ) {
    appendOwnedAdoptedStyles(
      body,
      adoptedStyleSheets,
      ownedAdoptedStyles,
      'document',
    );
  }
  assignIsolatedManualSlots(target, nodes);
}

/**
 * A frame in which the page put a new head or body in place of its own (a
 * Turbo-style visit: `document.body.replaceWith(next)`), read for the
 * mirror (D190). The mirror keeps its own two, which hold what Simul puts
 * there, so `<html>`'s list keeps the mirror's element where the new one
 * stands, and a part after it brings the new element's attributes and
 * children to the mirror's: the same checks as any list of children sent.
 * Then the mirror's element takes the new one's id (`rebinds`, by the index
 * of that part). Anything else of the kind stays refused: a head or body
 * added beside the page's own, one moved, or one with a shadow root.
 */
function splitDocumentShellReplacement(
  state: HtmlMirrorDomState,
  parts: readonly (readonly HtmlMirrorPatchOperation[])[],
): {
  readonly parts: readonly (readonly HtmlMirrorPatchOperation[])[];
  readonly rebinds: ReadonlyMap<number, readonly (readonly [number, number])[]>;
} {
  const html = state.iframe.contentDocument?.documentElement;
  const htmlId = html ? state.nodes.idOf(html) : undefined;
  if (htmlId === undefined) return { parts, rebinds: new Map() };
  const split: (readonly HtmlMirrorPatchOperation[])[] = [];
  const rebinds = new Map<number, Array<readonly [number, number]>>();
  for (const operations of parts) {
    const index = operations.findIndex((operation) =>
      operation.kind === 'reconcile-children' && operation.nodeId === htmlId);
    const operation = operations[index] as Extract<
      HtmlMirrorPatchOperation,
      { kind: 'reconcile-children' }
    > | undefined;
    if (!operation) {
      split.push(operations);
      continue;
    }
    const children = [...operation.children];
    const following: HtmlMirrorPatchOperation[] = [];
    const pairs: Array<readonly [number, number]> = [];
    for (const element of replicaDocumentShell(sourceChildNodeList(html!))) {
      const oldId = state.nodes.idOf(element);
      const tagName = sourceLocalName((element as Element));
      const at = children.findIndex((entry) =>
        entry.kind === 'graph' && isDocumentShellChild(entry.node) &&
        entry.node.tagName === tagName);
      if (oldId === undefined || at < 0) continue;
      const node = (children[at] as { readonly node: HtmlMirrorElementNode }).node;
      if (
        children.some((entry) => entry.kind === 'retain' && entry.nodeId === oldId) ||
        children.some((entry, other) => other !== at && entry.kind === 'graph' &&
          isDocumentShellChild(entry.node) && entry.node.tagName === tagName) ||
        node.shadowRoot || sourceProperty((element as Element), 'shadowRoot') ||
        node.childrenFollow || node.placeholder || node.opaquePlaceholder ||
        state.nodes.has(node.id)
      ) continue;
      children[at] = Object.freeze({ kind: 'retain', nodeId: oldId });
      following.push(Object.freeze({
        kind: 'attributes',
        nodeId: oldId,
        namespace: node.namespace,
        tagName: node.tagName,
        attributes: node.attributes,
        ...(node.visuallyHidden ? { visuallyHidden: true as const } : {}),
        ...(node.canvasBackgroundColor
          ? { canvasBackgroundColor: node.canvasBackgroundColor }
          : {}),
        ...(node.customElementDefined
          ? { customElementDefined: true as const }
          : {}),
      }));
      following.push(Object.freeze({
        kind: 'children',
        nodeId: oldId,
        children: node.children,
      }));
      pairs.push([oldId, node.id] as const);
    }
    if (pairs.length === 0) {
      split.push(operations);
      continue;
    }
    const changed = [...operations];
    changed[index] = Object.freeze({ ...operation, children: Object.freeze(children) });
    split.push(Object.freeze(changed));
    // The head's list and the body's go in one part: each is a list of
    // children sent whole, which a part may hold several of.
    split.push(Object.freeze(following));
    rebinds.set(split.length - 1, pairs);
  }
  return { parts: split, rebinds };
}

/**
 * A `<head>` or `<body>` element. Under `<html>` the first of each is the
 * page's own, which the mirror holds as its shell's; anywhere else, and any
 * further one, it is an element like any other (D143).
 */
function isDocumentShellChild(node: HtmlMirrorNode): node is HtmlMirrorElementNode {
  return node.kind === 'element' && node.namespace === 'html' &&
    (node.tagName === 'head' || node.tagName === 'body');
}

/** The mirror's own head and body among `children`, the mirror's `<html>`'s. */
function replicaDocumentShell(children: Iterable<Node>): Node[] {
  const shell: Node[] = [];
  for (const tagName of ['head', 'body']) {
    for (const child of children) {
      if (
        sourceNodeType(child) === Node.ELEMENT_NODE &&
        sourceProperty((child as Element), 'namespaceURI') === NAMESPACE_URIS.html &&
        sourceLocalName((child as Element)) === tagName
      ) {
        shell.push(child);
        break;
      }
    }
  }
  return shell;
}

function isReplicaDocumentElement(node: Node): boolean {
  return sourceNodeType(node) === Node.ELEMENT_NODE &&
    node === sourceProperty(node, 'ownerDocument')?.documentElement;
}

/**
 * Builds a page's shadow root on `host`, a replica element without one. The
 * replica's root is always open (see `HtmlMirrorShadowRoot`).
 */
function buildShadowRoot(
  target: Document,
  host: Element,
  input: HtmlMirrorShadowRoot,
  nodes: Map<number, Node>,
  textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
  controlMetadata: Map<number, HtmlMirrorControlText>,
  ownedAdoptedStyles: Set<HTMLStyleElement>,
): void {
  const manual = input.slotAssignment === 'manual';
  const shadow = (host as Element & {
    attachShadow?: (init: ShadowRootInit) => ShadowRoot;
  }).attachShadow?.({
    mode: 'open',
    ...(manual ? { slotAssignment: 'manual' as const } : {}),
  });
  if (!shadow) throw new Error('Open shadow root could not be reconstructed.');
  if (nodes.has(input.id)) {
    throw new Error('Duplicate isolated mirror shadow root ID.');
  }
  nodes.set(input.id, shadow);
  if (manual) {
    let roots = ISOLATED_MANUAL_SLOT_ROOTS.get(target);
    if (!roots) ISOLATED_MANUAL_SLOT_ROOTS.set(target, roots = new Set());
    roots.add(shadow);
  }
  for (const child of input.children) {
    const built = buildNode(
      target,
      child,
      nodes,
      textMetadata,
      controlMetadata,
      ownedAdoptedStyles,
    );
    if (built) shadow.append(built);
  }
  if (!adoptOwnedSheets(
    shadow,
    [ISOLATED_MEDIA_CONTROLS_CSS, ...input.adoptedStyleSheets],
  )) {
    appendOwnedShadowShellStyle(shadow);
    appendOwnedAdoptedStyles(
      shadow,
      input.adoptedStyleSheets,
      ownedAdoptedStyles,
      'shadow',
    );
  }
}

function buildNode(
  target: Document,
  input: HtmlMirrorNode,
  nodes: Map<number, Node>,
  textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
  controlMetadata: Map<number, HtmlMirrorControlText>,
  ownedAdoptedStyles: Set<HTMLStyleElement>,
): Node | undefined {
  if (nodes.has(input.id)) throw new Error('Duplicate isolated mirror node ID.');
  if (input.kind === 'text') {
    const node = target.createTextNode(input.text);
    nodes.set(input.id, node);
    textMetadata.set(input.id, input);
    return node;
  }
  // An `<html>`, `<head>` or `<body>` element that is not the document's own
  // (one a script made inside a block, a parsed document hung in a shadow
  // root, a second body) is an element like any other, and is built as one
  // (D143). Refused, it left a page that holds one without a mirror.
  const node = createMirrorElement(target, input.namespace, input.tagName);
  if (input.opaquePlaceholder) {
    if (
      input.namespace !== 'html' ||
      !isSourceSecretPlaceholderTagName(input.tagName, input.id) ||
      input.attributes.length !== 0 ||
      input.children.length !== 0 ||
      input.shadowRoot ||
      (input.leftOutTagName !== undefined &&
        !isHtmlMirrorLeftOutTagName(input.leftOutTagName))
    ) throw new Error('Non-canonical secret placeholder rejected.');
    protectIsolatedOpaquePlaceholder(node);
    // The place held for an element the reader leaves out carries its name,
    // for the page's type selectors (`script + p`), as the sheets are
    // written to read it (D208).
    if (input.leftOutTagName !== undefined) {
      sourceCall(node, 'setAttribute', HTML_MIRROR_LEFT_OUT_ATTRIBUTE, input.leftOutTagName);
    }
    nodes.set(input.id, node);
    return node;
  }
  setAttributes(node, input.attributes, input.resolvedStyleSheetText);
  applyElementHints(node, input);
  if (input.placeholder) applyPlaceholderBox(node, input.placeholder.height);
  nodes.set(input.id, node);
  if (input.controlText) controlMetadata.set(input.id, input.controlText);
  for (const child of input.children) {
    const built = buildNode(
      target,
      child,
      nodes,
      textMetadata,
      controlMetadata,
      ownedAdoptedStyles,
    );
    if (built) sourceCall(node, 'append', built);
  }
  applySelectedOptionIndexes(node, input.selectedOptionIndexes);
  configureNativeSelectFacsimile(node);
  applyResolvedStyleSheetText(node, input.resolvedStyleSheetText);
  if (input.shadowRoot) {
    buildShadowRoot(
      target,
      node,
      input.shadowRoot,
      nodes,
      textMetadata,
      controlMetadata,
      ownedAdoptedStyles,
    );
  }
  return wrapNativeSelectFacsimile(node);
}

/**
 * Gives the slots of the replica's roots that assign by script the nodes the
 * page's slots hold (`HtmlMirrorElementHints.assignedNodeIds`). The replica
 * runs no page code, so nothing in it calls `slot.assign()`: the panel does,
 * from outside, after the page is first built and after every change. A
 * change may have built anew a node a slot held, or the slot itself, and
 * only nodes that are children of the root's host can be assigned. A slot
 * that cannot be given its nodes is left as it is: the rest of the page is
 * still drawn. A page without such a root pays nothing here.
 */
function assignIsolatedManualSlots(
  target: Document,
  nodes: ReadonlyMap<number, Node>,
): void {
  const roots = ISOLATED_MANUAL_SLOT_ROOTS.get(target);
  if (!roots || roots.size === 0) return;
  for (const root of [...roots]) {
    if (!sourceProperty(root.host, 'isConnected')) {
      roots.delete(root);
      continue;
    }
    for (const slot of root.querySelectorAll('slot')) {
      const ids = ISOLATED_MANUAL_SLOT_NODE_IDS.get(slot);
      if (!ids) continue;
      const held: Array<Element | Text> = [];
      for (const id of ids) {
        const node = nodes.get(id);
        // A dropdown is drawn by the box Simul puts around it.
        const drawn = node && presentationNodeForMirrorNode(node);
        if (drawn && sourceProperty(drawn, 'parentNode') === root.host) held.push(drawn as Element | Text);
      }
      try {
        const now = (slot as HTMLSlotElement).assignedNodes();
        if (
          now.length === held.length &&
          now.every((node, index) => node === held[index])
        ) continue;
        // `assign` takes its nodes only as arguments, so a slot given more
        // than the engine's limit on arguments (about 125,000) throws and is
        // left as it is (D210).
        (slot as HTMLSlotElement).assign(...held);
      } catch {
        // Left as it is.
      }
    }
  }
}

/**
 * A closed extension-owned shadow scope prevents captured author selectors,
 * including pseudo-element rules, from regenerating content on the identity
 * shell. Important shadow declarations outrank outer author declarations at
 * the encapsulation boundary.
 */
export function protectIsolatedOpaquePlaceholder(node: Element): void {
  const host = node as Element & {
    attachShadow?: (init: ShadowRootInit) => ShadowRoot;
  };
  const shadow = host.attachShadow?.({ mode: 'closed' });
  if (!shadow) throw new Error('Secret placeholder isolation unavailable.');
  const style = sourceProperty(node, 'ownerDocument').createElement('style');
  style.textContent = ISOLATED_SECRET_PLACEHOLDER_CSS;
  shadow.append(style);
  sourceCall(node, 'setAttribute', 'aria-hidden', 'true');
  sourceCall(node, 'setAttribute', 'inert', '');
  sourceCall(node, 'setAttribute', 'tabindex', '-1');
}

/**
 * The sheets Simul makes in the mirror's frame, one for each text (D183).
 * A component root's own rules and the sheets the page's roots and document
 * adopt are adopted there too, as the page adopts them: no element of
 * Simul's then stands among the root's children, where the page's
 * `:last-child`, `:only-child` and `:nth-last-child()` counted it. Roots
 * are only made with what holds them, so a refused patch takes its new
 * roots away whole and the roots it found keep their sheets. Kept for the
 * document's life: what the sheets hold counts toward the mirror's budget,
 * and a mirror over it is read again whole, into a new document.
 */
const OWNED_SHEETS = new WeakMap<Document, OwnedSheets>();

interface OwnedSheets {
  readonly byText: Map<string, CSSStyleSheet>;
  bytes: number;
}

/**
 * Adopts a sheet of each text on `owner`, after what it has; false, with
 * nothing changed, where the frame makes no sheets (an older engine, a test
 * document): the caller writes style elements instead, as before.
 */
function adoptOwnedSheets(
  owner: Document | ShadowRoot,
  texts: readonly string[],
): boolean {
  const target = sourceNodeType(owner) === Node.DOCUMENT_NODE
    ? owner as Document
    : owner.ownerDocument;
  const Sheet = (target?.defaultView as (Window & typeof globalThis) | null)
    ?.CSSStyleSheet;
  if (
    !target || typeof Sheet !== 'function' ||
    typeof Sheet.prototype.replaceSync !== 'function' ||
    !('adoptedStyleSheets' in owner)
  ) return false;
  let owned = OWNED_SHEETS.get(target);
  const made: Array<readonly [string, CSSStyleSheet]> = [];
  const sheets: CSSStyleSheet[] = [];
  try {
    for (const text of texts) {
      let sheet = owned?.byText.get(text) ??
        made.find(([madeText]) => madeText === text)?.[1];
      if (!sheet) {
        sheet = new Sheet();
        sheet.replaceSync(text);
        made.push([text, sheet] as const);
      }
      sheets.push(sheet);
    }
    owner.adoptedStyleSheets = [...owner.adoptedStyleSheets, ...sheets];
  } catch {
    return false;
  }
  if (!owned) OWNED_SHEETS.set(target, owned = { byText: new Map(), bytes: 0 });
  for (const [text, sheet] of made) {
    owned.byText.set(text, sheet);
    owned.bytes += text.length * 2 + 48;
  }
  return true;
}

/**
 * What the sheets Simul made in `target` hold, and how many of them are
 * the page's (the roots' own rules are Simul's).
 */
function ownedSheetTotals(target: Document | null | undefined): {
  readonly bytes: number;
  readonly count: number;
} {
  const owned = target ? OWNED_SHEETS.get(target) : undefined;
  if (!owned) return { bytes: 0, count: 0 };
  const shell = owned.byText.has(ISOLATED_MEDIA_CONTROLS_CSS) ? 1 : 0;
  return { bytes: owned.bytes, count: owned.byText.size - shell };
}

/**
 * A replica shadow root's own shell rules, where the frame makes no sheets
 * (`adoptOwnedSheets`). The style is not a mirrored node,
 * so patches of the root's children and adopted sheets leave it in place.
 */
function appendOwnedShadowShellStyle(shadow: ShadowRoot): void {
  const target = shadow.ownerDocument;
  if (!target) throw new Error('Shadow root owner has no document.');
  const style = target.createElement('style');
  style.setAttribute('data-simul-owned-shadow-shell', 'v1');
  style.textContent = ISOLATED_MEDIA_CONTROLS_CSS;
  shadow.append(style);
  ISOLATED_OWNED_SHADOW_SHELL_STYLES.add(style);
}

function appendOwnedAdoptedStyles(
  owner: ParentNode,
  adoptedStyleSheets: readonly string[],
  ownedAdoptedStyles: Set<HTMLStyleElement>,
  scope: 'document' | 'shadow',
): void {
  const target = sourceProperty(owner, 'ownerDocument');
  if (!target) throw new Error('Adopted stylesheet owner has no document.');
  for (const cssText of adoptedStyleSheets) {
    const style = target.createElement('style');
    style.setAttribute('data-simul-adopted-style', scope);
    style.textContent = cssText;
    sourceCall(owner, 'appendChild', style);
    ownedAdoptedStyles.add(style);
  }
}

function setAttributes(
  element: Element,
  attributes: readonly (readonly [string, string])[],
  resolvedStyleSheetText?: string,
): void {
  // A `<link>` fetches its sheet again when `rel` or `href` is taken off
  // and put back, and the mirror is without the sheet meanwhile: what did
  // not change on a link stays (D143).
  const link = sourceProperty(element, 'namespaceURI') === 'http://www.w3.org/1999/xhtml' &&
    sourceLocalName(element).toLowerCase() === 'link';
  if (link) {
    attributes = replicaLinkAttributes(attributes, resolvedStyleSheetText);
    const wanted = new Map(attributes);
    for (const attribute of [...sourceAttributeList(element)]) {
      if (wanted.get(attribute.name) !== attribute.value) {
        sourceCall(element, 'removeAttribute', attribute.name);
      }
    }
    attributes = attributes.filter(
      ([name, value]) => sourceCall(element, 'getAttribute', name) !== value,
    );
  } else {
    for (const attribute of [...sourceAttributeList(element)]) {
      sourceCall(element, 'removeAttribute', attribute.name);
    }
  }
  forgetPageXmlLanguage(element);
  for (const [name, value] of inWriteOrder(attributes)) {
    writeReplicaAttribute(element, name, value);
  }
  const tagName = sourceLocalName(element).toLowerCase();
  if (
    sourceProperty(element, 'namespaceURI') === 'http://www.w3.org/1999/xhtml' &&
    (tagName === 'link' || tagName === 'style')
  ) {
    try {
      const sheetOwner = element as Element & { disabled: boolean };
      const disabled = sourceCall(element, 'hasAttribute', 'disabled');
      if (sheetOwner.disabled !== disabled) sheetOwner.disabled = disabled;
    } catch {
      // The content attribute remains the browser-owned fallback.
    }
  }
  finishReplicaAttributes(element);
}

/**
 * What the mirror's own `<link>` carries when its rules came with it
 * (D143): it points at those rules, and is never given the page's address.
 * Written first and replaced, that address was asked for once at every
 * patch of the link. The page's integrity hash covers the page's response,
 * not these rules, so it is left out.
 */
function replicaLinkAttributes(
  attributes: readonly (readonly [string, string])[],
  resolvedStyleSheetText: string | undefined,
): readonly (readonly [string, string])[] {
  if (resolvedStyleSheetText === undefined) return attributes;
  return [
    ...attributes.filter(([name]) => name !== 'href' && name !== 'integrity'),
    ['href', `data:text/css;charset=utf-8,${encodeURIComponent(
      resolvedStyleSheetText,
    )}`],
    ['data-simul-resolved-stylesheet', 'v1'],
  ];
}

/**
 * Whether a patch switches a mirror `<link>` off. The mirror asks for a
 * sheet itself, a little later than the page did, and Chrome applies a
 * sheet that arrives after its link was switched off, whatever is written
 * on the link then: a theme that a page loads from another site and
 * switches off in its `load` handler stayed applied in the mirror for good
 * (D143). A link that is not in the document applies nothing, so the link
 * is taken out and a new one, made switched off, stands in its place: it
 * has asked for nothing, and asks when the page switches it on.
 */
function switchesReplicaLinkOff(
  element: Element,
  attributes: readonly (readonly [string, string])[],
): boolean {
  return sourceProperty(element, 'namespaceURI') === 'http://www.w3.org/1999/xhtml' &&
    sourceLocalName(element).toLowerCase() === 'link' &&
    !sourceCall(element, 'hasAttribute', 'disabled') &&
    attributes.some(([name]) => name === 'disabled');
}

/**
 * The order a page's attributes are written in: its `lang` of the XML
 * namespace last. A page can also hold an attribute that is merely named
 * `xml:lang` (the HTML parser makes one on an HTML element; so does
 * `xml:LANG` of an XHTML page, whose name travels in lowercase).
 * `setAttribute` finds an attribute by its name alone, so written after the
 * real one it would be written over it, and the element would be drawn by
 * the wrong language. Written first, it is an attribute of its own.
 */
function inWriteOrder(
  attributes: readonly (readonly [string, string])[],
): readonly (readonly [string, string])[] {
  const last = attributes.findIndex(
    ([name]) => name === PAGE_XML_LANGUAGE_ATTRIBUTE,
  );
  if (last < 0 || last === attributes.length - 1) return attributes;
  return [
    ...attributes.slice(0, last),
    ...attributes.slice(last + 1),
    attributes[last]!,
  ];
}

/**
 * Writes one of the page's attributes onto a replica element, in the
 * namespace it has in the page: an SVG element's `xlink:href`, and a `lang`
 * of the XML namespace, which travels under a name of its own. The
 * document's own language, which travels on the root, is no attribute: the
 * mirror's document is given it. (An attribute patch is first tried on a
 * spare element, which is no document's root and gives nothing.)
 */
function writeReplicaAttribute(
  element: Element,
  name: string,
  value: string,
): void {
  if (name === PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE) {
    const document = sourceProperty(element, 'ownerDocument');
    if (document?.documentElement === element) {
      showDocumentLanguage(document, value);
    }
  } else if (name === PAGE_XML_LANGUAGE_ATTRIBUTE) {
    writePageXmlLanguage(element, value);
  } else if (
    sourceProperty(element, 'namespaceURI') === 'http://www.w3.org/2000/svg' &&
    name === 'xlink:href'
  ) {
    sourceCall(element, 'setAttributeNS', 'http://www.w3.org/1999/xlink', 'xlink:href', value);
  } else {
    sourceCall(element, 'setAttribute', sourceProperty(element, 'namespaceURI') === 'http://www.w3.org/2000/svg'
        ? canonicalSvgAttributeName(name)
        : name, value);
  }
}

/**
 * The page's attributes on a replica element as a patch would send them,
 * without what Simul shows over them: what a rollback writes back.
 */
function replicaPageAttributes(
  element: Element,
): readonly (readonly [string, string])[] {
  const xmlLanguage = pageXmlLanguage(element);
  // Nothing of the XML namespace is listed by its name in the mirror: the
  // page's `lang` there goes back under the name it travels by.
  const attributes = [...pageAttributes(
    element,
    (attribute) => attribute.namespaceURI === XML_NAMESPACE,
  )];
  if (xmlLanguage !== null) {
    attributes.push([PAGE_XML_LANGUAGE_ATTRIBUTE, xmlLanguage] as const);
  }
  // So does the document's language, on the root.
  const document = sourceProperty(element, 'ownerDocument');
  const language = document?.documentElement === element
    ? documentContentLanguage(document)
    : undefined;
  if (language !== undefined) {
    attributes.push([PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, language] as const);
  }
  return attributes;
}

/**
 * What every write of the page's attributes onto a replica element ends
 * with: the mirror's own rules for the element, then whatever Simul shows
 * there over the page's value while a translation is up (D124).
 */
function finishReplicaAttributes(element: Element): void {
  reapplyReplicaAttributeOverrides(element);
  quietReplicaAlertRole(element);
  silenceReplicaLiveRegion(element);
}

/** The roles Chrome raises its alert event for, whatever `aria-live` says. */
const ALERT_ROLES: ReadonlySet<string> = new Set(['alert', 'alertdialog']);

/**
 * Chrome raises its alert event for an element with `role="alert"` or
 * `alertdialog` when it is made, shown again or given the role, and for every
 * alert at each rebuild of the mirror, whatever `aria-live` says: the tab has
 * announced it already. In the mirror the role is taken off (an
 * `alertdialog` stays a `dialog`) and the page's value kept in
 * `data-simul-page-role` (D178). Both are overrides: a rollback and a patch
 * see the page's own role. Page rules on `[role="alert"]` no longer match
 * there: the mirrored sheets are written by the page reader.
 */
function quietReplicaAlertRole(element: Element): void {
  const role = pageAttribute(element, 'role');
  const tokens = role?.trim().toLowerCase().split(/\s+/u) ?? [];
  if (role === null || !tokens.some((token) => ALERT_ROLES.has(token))) {
    clearReplicaAttributeOverride(element, 'role');
    clearReplicaAttributeOverride(element, PAGE_ROLE_ATTRIBUTE);
    return;
  }
  const quiet = tokens
    .filter((token) => token !== 'alert')
    .map((token) => token === 'alertdialog' ? 'dialog' : token)
    .join(' ');
  setReplicaAttributeOverride(element, 'role', quiet || null);
  setReplicaAttributeOverride(element, PAGE_ROLE_ATTRIBUTE, role);
}

const PAGE_ROLE_ATTRIBUTE = 'data-simul-page-role';

/** Roles that are live regions without saying so; `output` is a status. */
const IMPLICIT_LIVE_REGION_ROLES: ReadonlySet<string> = new Set([
  'alert', 'log', 'status',
]);

/**
 * The mirror announces nothing by itself: the tab is where a page's alerts
 * and status lines are announced, and the mirror would say each one again
 * when its patch lands and once more when its translation does (D124).
 * `aria-live="off"` is what stops Chrome treating an element as a live
 * region, on one the page marked and on a role that is live by default. The
 * role stays: page CSS selects on it, and it still says what the element is.
 * `marquee` and `timer` are off by default.
 */
function silenceReplicaLiveRegion(element: Element): void {
  if (
    sourceCall(element, 'hasAttribute', 'aria-live') ||
    (sourceProperty(element, 'namespaceURI') === NAMESPACE_URIS.html &&
      sourceLocalName(element).toLowerCase() === 'output') ||
    pageAttribute(element, 'role')?.trim().toLowerCase().split(/\s+/u)
      .some((token) => IMPLICIT_LIVE_REGION_ROLES.has(token))
  ) sourceCall(element, 'setAttribute', 'aria-live', 'off');
}

/**
 * Create a replica element from its transported lowercase tag name.
 *
 * HTML names go through createElement so a colon-prefixed legacy name such as
 * `o:p` becomes the same inert HTMLUnknownElement the source parser produced;
 * createElementNS would read the colon as a namespace prefix and materialize
 * the real local element (`x:iframe` -> HTMLIFrameElement), bypassing every
 * tag-keyed rule. The sanitizer rejects colon names outside the HTML
 * namespace. SVG names are restored to their case-sensitive spelling because
 * Chrome's SVG element factory does not recognize `lineargradient` or
 * `clippath` and would create unknown elements instead.
 */
export function createMirrorElement(
  target: Document,
  namespace: keyof typeof NAMESPACE_URIS,
  tagName: string,
): Element {
  if (namespace === 'html') return target.createElement(tagName);
  return target.createElementNS(
    NAMESPACE_URIS[namespace],
    namespace === 'svg' ? canonicalSvgElementName(tagName) : tagName,
  );
}

export function canonicalSvgElementName(tagName: string): string {
  return SVG_CASE_SENSITIVE_ELEMENTS.get(tagName) ?? tagName;
}

const SVG_CASE_SENSITIVE_ELEMENTS = new Map<string, string>(
  [
    'altGlyph',
    'altGlyphDef',
    'altGlyphItem',
    'animateColor',
    'animateMotion',
    'animateTransform',
    'clipPath',
    'feBlend',
    'feColorMatrix',
    'feComponentTransfer',
    'feComposite',
    'feConvolveMatrix',
    'feDiffuseLighting',
    'feDisplacementMap',
    'feDistantLight',
    'feDropShadow',
    'feFlood',
    'feFuncA',
    'feFuncB',
    'feFuncG',
    'feFuncR',
    'feGaussianBlur',
    'feImage',
    'feMerge',
    'feMergeNode',
    'feMorphology',
    'feOffset',
    'fePointLight',
    'feSpecularLighting',
    'feSpotLight',
    'feTile',
    'feTurbulence',
    'foreignObject',
    'glyphRef',
    'linearGradient',
    'radialGradient',
    'textPath',
  ].map((name) => [name.toLowerCase(), name] as const),
);

function applyElementHints(
  element: Element,
  hints: Pick<
    HtmlMirrorElementNode,
    | 'visuallyHidden'
    | 'selectedImageSource'
    | 'selectedOptionIndexes'
    | 'selectPickerOpen'
    | 'selectPresentationStyle'
    | 'controlText'
    | 'canvasBackgroundColor'
    | 'customElementDefined'
    | 'assignedNodeIds'
  >,
): void {
  if (hints.customElementDefined) defineReplicaCustomElement(element);
  if (hints.assignedNodeIds) {
    ISOLATED_MANUAL_SLOT_NODE_IDS.set(element, hints.assignedNodeIds);
  }
  applyControlText(element, hints.controlText);
  applySelectedOptionIndexes(element, hints.selectedOptionIndexes);
  if (sourceLocalName(element).toLowerCase() === 'select') {
    if (hints.selectPresentationStyle) {
      sourceCall(element, 'setAttribute', 'data-simul-select-presentation-style', hints.selectPresentationStyle);
    } else {
      sourceCall(element, 'removeAttribute', 'data-simul-select-presentation-style');
    }
    if (hints.selectPickerOpen) {
      sourceCall(element, 'setAttribute', 'data-simul-source-picker-open', 'v1');
    } else {
      sourceCall(element, 'removeAttribute', 'data-simul-source-picker-open');
    }
  }
  if (
    hints.canvasBackgroundColor &&
    sourceLocalName(element).toLowerCase() === 'html'
  ) {
    // This is the source browser's resolved canvas color (html first, then
    // body), not an authored declaration. Keep it authoritative even when a
    // transported stylesheet contains a light-theme `!important` fallback.
    applyReplicaCanvasBackground(element, hints.canvasBackgroundColor);
  }
  if (hints.selectedImageSource && sourceLocalName(element).toLowerCase() === 'img') {
    sourceCall(element, 'setAttribute', 'src', hints.selectedImageSource);
    sourceCall(element, 'removeAttribute', 'srcset');
    sourceCall(element, 'setAttribute', 'data-simul-selected-image-source', 'v1');
  }
  const styled = element as Element & { readonly style?: CSSStyleDeclaration };
  const style = sourceProperty(styled, 'style');
  if (
    sourceProperty(element, 'namespaceURI') === 'http://www.w3.org/2000/svg' &&
    style
  ) {
    // Static SVG is part of the current fidelity contract. Simul-owned inline
    // declarations outrank retained author stylesheets (including unreadable
    // cross-origin sheets), so CSS cannot turn the reconstructed SVG tree into
    // an animation channel while the saved animation option is absent/off.
    style.setProperty('animation', 'none', 'important');
    style.setProperty('transition', 'none', 'important');
  }
  if (hints.visuallyHidden && style) {
    sourceCall(element, 'setAttribute', 'data-simul-visually-hidden', 'v1');
    if (
      sourceLocalName(element).toLowerCase() === 'option' ||
      sourceLocalName(element).toLowerCase() === 'optgroup'
    ) {
      sourceCall(element, 'setAttribute', 'hidden', '');
      style.setProperty('display', 'none', 'important');
    }
    style.setProperty('position', 'absolute', 'important');
    style.setProperty('width', '1px', 'important');
    style.setProperty('height', '1px', 'important');
    style.setProperty('padding', '0', 'important');
    style.setProperty('margin', '-1px', 'important');
    style.setProperty('overflow', 'hidden', 'important');
    style.setProperty('clip', 'rect(0, 0, 0, 0)', 'important');
    style.setProperty('clip-path', 'inset(50%)', 'important');
    style.setProperty('white-space', 'nowrap', 'important');
  }
  if (sourceLocalName(element).toLowerCase() === 'select') {
    configureNativeSelectFacsimile(element);
  }
}

/**
 * A preview's empty box (D163): the element keeps the page's border-box
 * height whatever its rules say, and shows nothing past it, so the
 * preview is as tall as the page and a scroll's share of the range lands
 * where it does on the page. Simul-owned declarations, as the other hints:
 * the page's own `style` was written before them and they outrank it.
 */
function applyPlaceholderBox(element: Element, height: number): void {
  const styled = element as Element & { readonly style?: CSSStyleDeclaration };
  const style = sourceProperty(styled, 'style');
  if (!style || !Number.isFinite(height)) return;
  const pixels = `${Math.min(Math.max(0, height), MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT)}px`;
  style.setProperty('box-sizing', 'border-box', 'important');
  style.setProperty('height', pixels, 'important');
  style.setProperty('min-height', pixels, 'important');
  style.setProperty('max-height', pixels, 'important');
  style.setProperty('overflow', 'clip', 'important');
}

/**
 * Registers an empty Simul-owned class for a custom element the page has
 * defined, so the page's `:defined` and `:not(:defined)` rules match as they
 * do on the page. No page code runs: the class has no body, and the replica's
 * sandbox still blocks its own scripts. Registering a name upgrades the
 * elements that already have it (D83).
 */
function defineReplicaCustomElement(element: Element): void {
  const name = sourceLocalName(element);
  if (
    sourceProperty(element, 'namespaceURI') !== 'http://www.w3.org/1999/xhtml' ||
    !isAutonomousCustomElementName(name)
  ) return;
  try {
    const view = sourceProperty(element, 'ownerDocument')?.defaultView;
    const registry = view?.customElements;
    if (!view || !registry || registry.get(name)) return;
    registry.define(name, class extends view.HTMLElement {});
  } catch {
    // A name the browser refuses stays undefined, as before.
  }
}

function applySelectedOptionIndexes(
  element: Element,
  selectedOptionIndexes: readonly number[] | undefined,
): void {
  if (sourceLocalName(element).toLowerCase() !== 'select') return;
  const select = element as HTMLSelectElement;
  if (selectedOptionIndexes === undefined) {
    select.selectedIndex = -1;
    syncContainingIsolatedSelectFacsimile(select);
    return;
  }
  const selected = new Set(selectedOptionIndexes);
  const options = select.options;
  if (select.multiple || select.hasAttribute('multiple')) {
    for (let index = 0; index < options.length; index += 1) {
      options.item(index)!.selected = selected.has(index);
    }
    syncContainingIsolatedSelectFacsimile(select);
    return;
  }
  select.selectedIndex = selectedOptionIndexes[0] ?? -1;
  syncContainingIsolatedSelectFacsimile(select);
}

function configureNativeSelectFacsimile(element: Element): void {
  if (sourceLocalName(element).toLowerCase() !== 'select') return;
  sourceCall(element, 'setAttribute', 'data-simul-select-facsimile', 'v1');
  sourceCall(element, 'setAttribute', 'inert', '');
  sourceCall(element, 'setAttribute', 'aria-hidden', 'true');
  sourceCall(element, 'setAttribute', 'aria-disabled', 'true');
  sourceCall(element, 'setAttribute', 'tabindex', '-1');
  syncNativeSelectFacsimileHost(element);
}

/**
 * Isolate the disclosure control from source styles without changing the
 * transported select/option graph used by patches and translations. Website
 * CSS can still style the host for layout, but it cannot collapse or activate
 * the extension-owned select inside this shadow boundary.
 */
function wrapNativeSelectFacsimile(node: Node): Node {
  if (
    sourceNodeType(node) !== Node.ELEMENT_NODE ||
    sourceLocalName((node as Element)).toLowerCase() !== 'select'
  ) return node;
  const select = node as HTMLSelectElement;
  const document = select.ownerDocument;
  isolatedSelectHostSequence += 1;
  const entropy = globalThis.crypto?.randomUUID?.()
    .replace(/[^a-z0-9-]/giu, '')
    .toLowerCase() ?? isolatedSelectHostSequence.toString(36);
  const host = document.createElement(`simul-owned-select-${entropy}`);
  ISOLATED_SELECT_HOSTS.add(host);
  sourceCall(host, 'setAttribute', 'data-simul-owned-select-host', 'v1');
  const shadow = sourceCall(host, 'attachShadow', { mode: 'open' });
  const style = document.createElement('style');
  style.setAttribute('data-simul-owned-select-style', 'v1');
  style.textContent = ISOLATED_SELECT_SHADOW_CSS;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.setAttribute('data-simul-owned-select-trigger', 'v1');
  trigger.setAttribute('aria-label', 'Show translated options');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-readonly', 'true');
  const panel = document.createElement('div');
  panel.setAttribute('data-simul-owned-select-options', 'v1');
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-disabled', 'true');
  panel.style.setProperty('background', 'Canvas', 'important');
  panel.style.setProperty('color', 'CanvasText', 'important');
  panel.style.setProperty('min-width', '100%', 'important');
  panel.style.setProperty('width', 'max-content', 'important');
  panel.style.setProperty('z-index', '2147483647', 'important');
  // A dropdown the page gave no size (it had no box when read: in a menu's
  // panel collapsed by `display`) is as wide as Chrome draws one: its widest
  // label and 20px, one line and 2px high (D173). The labels stand here, out
  // of sight and of no height, only to give that width.
  const sizer = document.createElement('div');
  sizer.setAttribute('data-simul-owned-select-sizer', 'v1');
  sizer.setAttribute('aria-hidden', 'true');
  shadow.append(style, trigger, sizer, panel, select);
  for (const type of ISOLATED_DISCLOSURE_BLOCKED_EVENTS) {
    shadow.addEventListener(type, blockIsolatedDisclosureActivation, true);
  }
  ISOLATED_SELECT_FACSIMILES.set(host, { panel, select, trigger });
  registerIsolatedSelectHost(host);
  syncNativeSelectFacsimileHost(select);
  queueMicrotask(() => {
    if (isIsolatedOwnedHostConnected(host)) {
      syncNativeSelectFacsimileHost(select);
    }
  });
  return host;
}

function syncNativeSelectFacsimileHost(element: Element): void {
  const host = isolatedSelectFacsimileHost(element);
  if (!host) return;
  for (const attribute of [...sourceAttributeList(host)]) {
    if (!attribute.name.startsWith('data-simul-')) {
      sourceCall(host, 'removeAttribute', attribute.name);
    }
  }
  sourceCall(host, 'setAttribute', 'data-simul-owned-select-host', 'v1');
  if (sourceCall(element, 'getAttribute', 'data-simul-source-picker-open') === 'v1') {
    sourceCall(host, 'setAttribute', 'data-simul-source-picker-open', 'v1');
  } else {
    sourceCall(host, 'removeAttribute', 'data-simul-source-picker-open');
  }
  // The page's own attributes: a `lang` Simul put on the select for a
  // translated choice goes to the trigger's text instead (D124).
  for (const [name, value] of pageAttributes(element)) {
    if (
      name.startsWith('data-simul-') || name === 'inert' || name === 'size' ||
      name === 'style' || name === 'tabindex' || name === 'aria-disabled' ||
      name === 'aria-hidden'
    ) continue;
    try {
      sourceCall(host, 'setAttribute', name, value);
    } catch {
      // Sanitized presentation attributes are optional on the random host.
    }
  }
  sourceCall(element, 'removeAttribute', 'style');
  sourceProperty(host, 'style').setProperty('all', 'initial', 'important');
  let hasPresentationDisplay = false;
  let transparent = false;
  const presentation = sourceCall(element, 'getAttribute', 'data-simul-select-presentation-style');
  if (presentation) {
    const parser = sourceProperty(element, 'ownerDocument').createElement('span');
    parser.setAttribute('style', presentation);
    for (let index = 0; index < parser.style.length; index += 1) {
      const property = parser.style.item(index);
      if (!property || property === 'all') continue;
      const value = parser.style.getPropertyValue(property);
      if (!value) continue;
      if (property === 'opacity' && Number(value) === 0) {
        // A transparent source select is the click target over the page's
        // own styled label. Only the trigger goes transparent; the options
        // panel inside this host must stay visible when it opens.
        transparent = true;
        continue;
      }
      sourceProperty(host, 'style').setProperty(property, value, 'important');
      if (property === 'display') hasPresentationDisplay = true;
    }
  }
  if (transparent) {
    sourceCall(host, 'setAttribute', 'data-simul-select-transparent', 'v1');
  } else {
    sourceCall(host, 'removeAttribute', 'data-simul-select-transparent');
  }
  // No width from the page: it had no box to measure (D173).
  const width = sourceProperty(host, 'style').getPropertyValue('width').trim().toLowerCase();
  if (width === '' || width === 'auto') {
    sourceCall(host, 'setAttribute', 'data-simul-select-unsized', 'v1');
  } else {
    sourceCall(host, 'removeAttribute', 'data-simul-select-unsized');
  }
  sourceProperty(host, 'style').setProperty('pointer-events', 'auto', 'important');
  sourceProperty(host, 'style').setProperty('background-image', 'none', 'important');
  sourceProperty(host, 'style').setProperty('border-image-source', 'none', 'important');
  sourceProperty(host, 'style').setProperty('clip-path', 'none', 'important');
  sourceProperty(host, 'style').setProperty('content', 'normal', 'important');
  sourceProperty(host, 'style').setProperty('cursor', 'default', 'important');
  sourceProperty(host, 'style').setProperty('filter', 'none', 'important');
  sourceProperty(host, 'style').setProperty('list-style-image', 'none', 'important');
  sourceProperty(host, 'style').setProperty('mask-image', 'none', 'important');
  sourceProperty(host, 'style').setProperty('-webkit-mask-image', 'none', 'important');
  if (sourceCall(element, 'getAttribute', 'data-simul-visually-hidden') === 'v1') {
    ISOLATED_SELECT_FACSIMILES.get(host)?.controller?.close();
    sourceCall(host, 'setAttribute', 'data-simul-select-hidden', 'v1');
    sourceProperty(host, 'style').setProperty('display', 'none', 'important');
    return;
  }
  sourceCall(host, 'removeAttribute', 'data-simul-select-hidden');
  if (!hasPresentationDisplay) {
    sourceProperty(host, 'style').setProperty('display', 'inline-block', 'important');
  }
  // A dropdown under something hidden is not marked hidden: it keeps its
  // box, out of sight, for when the mirror opens what hides it (a site
  // menu's panel). A list left open has nothing to hang from then.
  if (sourceProperty(host, 'style').getPropertyValue('visibility') === 'hidden') {
    ISOLATED_SELECT_FACSIMILES.get(host)?.controller?.close();
  }
  syncIsolatedNativeSelectFacsimile(host);
}

function isIsolatedOwnedHostConnected(host: HTMLElement): boolean {
  const document = sourceProperty(host, 'ownerDocument');
  let current: Node = host;
  for (let depth = 0; depth <= 64; depth += 1) {
    if (current === document || document.documentElement?.contains(current)) {
      return true;
    }
    const root = sourceCall(current, 'getRootNode');
    if (
      sourceNodeType(root) !== Node.DOCUMENT_FRAGMENT_NODE ||
      !('host' in root)
    ) return false;
    const shadow = root as ShadowRoot;
    if (sourceProperty(shadow.host, 'shadowRoot') !== shadow) return false;
    current = shadow.host;
  }
  return false;
}

function registerIsolatedSelectHost(host: HTMLElement): void {
  const document = sourceProperty(host, 'ownerDocument');
  let hosts = ISOLATED_SELECT_HOSTS_BY_DOCUMENT.get(document);
  if (!hosts) {
    hosts = new Set();
    ISOLATED_SELECT_HOSTS_BY_DOCUMENT.set(document, hosts);
  }
  hosts.add(host);
}

/** The connected facsimile hosts of a document; removed ones are dropped. */
function isolatedSelectHosts(document: Document): HTMLElement[] {
  const hosts = ISOLATED_SELECT_HOSTS_BY_DOCUMENT.get(document);
  if (!hosts) return [];
  const live: HTMLElement[] = [];
  for (const host of [...hosts]) {
    if (ISOLATED_SELECT_HOSTS.has(host) && isIsolatedOwnedHostConnected(host)) {
      live.push(host);
    } else {
      hosts.delete(host);
      ISOLATED_SELECT_HOSTS.delete(host);
      ISOLATED_SELECT_FACSIMILES.delete(host);
    }
  }
  return live;
}

/**
 * The select hosts a patch can have changed: a select the patch names, an
 * ancestor of one it replaces, or a subtree the patch added inside one.
 */
function selectHostsInChangedRoots(
  document: Document,
  roots: readonly Node[],
): Set<HTMLElement> {
  const hosts = new Set<HTMLElement>();
  const registered = isolatedSelectHosts(document);
  for (const root of roots) {
    let element: Element | undefined;
    if (sourceNodeType(root) === Node.ELEMENT_NODE) element = root as Element;
    else if (sourceNodeType(root) === Node.TEXT_NODE) {
      element = sourceProperty(root, 'parentElement') ?? undefined;
    }
    if (!element) continue;
    const containing = containingIsolatedSelectFacsimileHost(element);
    if (containing) hosts.add(containing);
    for (const host of registered) {
      if (
        host === element ||
        composedElementContains(element, host) ||
        composedElementContains(host, element)
      ) hosts.add(host);
    }
  }
  return hosts;
}

function releaseIsolatedDocumentHosts(document: Document | undefined): void {
  if (!document) return;
  const hosts = ISOLATED_SELECT_HOSTS_BY_DOCUMENT.get(document);
  if (hosts) {
    for (const host of hosts) {
      ISOLATED_SELECT_HOSTS.delete(host);
      ISOLATED_SELECT_FACSIMILES.delete(host);
    }
    ISOLATED_SELECT_HOSTS_BY_DOCUMENT.delete(document);
  }
  ISOLATED_ARIA_INDEXES.delete(document);
}

function registerIsolatedAriaIndexElement(
  index: IsolatedAriaIndex,
  element: Element,
): void {
  const id = sourceCall(element, 'getAttribute', 'id')?.trim();
  const listed = index.listedIds.get(element);
  if (listed !== undefined && listed !== id) {
    unregisterIsolatedAriaIndexElement(index, element);
  }
  if (id) {
    index.listedIds.set(element, id);
    const existing = index.ids.get(id);
    if (!existing) index.ids.set(id, [element as HTMLElement]);
    else if (!existing.includes(element as HTMLElement)) {
      existing.push(element as HTMLElement);
    }
  }
  const controls = sourceCall(element, 'getAttribute', 'aria-controls')?.trim();
  if (controls) index.triggers.add(element as HTMLElement);
}

function unregisterIsolatedAriaIndexElement(
  index: IsolatedAriaIndex,
  element: Element,
): void {
  const id = index.listedIds.get(element);
  index.listedIds.delete(element);
  if (id) {
    const existing = index.ids.get(id);
    if (existing) {
      const remaining = existing.filter((candidate) => candidate !== element);
      if (remaining.length > 0) index.ids.set(id, remaining);
      else index.ids.delete(id);
    }
  }
  index.triggers.delete(element as HTMLElement);
}

function rebuildIsolatedAriaIndex(
  document: Document,
  index: IsolatedAriaIndex,
): void {
  index.ids.clear();
  index.listedIds.clear();
  index.triggers.clear();
  index.dirty = false;
  const root = document.documentElement;
  if (!root) return;
  for (const element of collectIsolatedElements(root)) {
    registerIsolatedAriaIndexElement(index, element);
  }
}

function isolatedAriaIndex(document: Document): IsolatedAriaIndex {
  let index = ISOLATED_ARIA_INDEXES.get(document);
  if (!index) {
    index = {
      ids: new Map(),
      listedIds: new Map(),
      triggers: new Set(),
      dirty: true,
    };
    ISOLATED_ARIA_INDEXES.set(document, index);
  }
  // With a ledger, the elements added, removed, or whose `id` or
  // `aria-controls` changed since the index was last read, by a patch or by
  // Simul (the semantic presenter's relations), are listed again: the index
  // was read from every element after every semantic batch (D165).
  const ledger = RETAINED_LEDGERS.get(document);
  if (ledger) {
    const elements = ledger.takeAriaElements();
    if (!elements) index.dirty = true;
    else if (!index.dirty) {
      for (const element of elements) {
        unregisterIsolatedAriaIndexElement(index, element);
        if (ledger.contains(element)) {
          registerIsolatedAriaIndexElement(index, element);
        }
      }
    }
  }
  if (index.dirty) rebuildIsolatedAriaIndex(document, index);
  return index;
}

/**
 * Whether the index lists what a fresh read of the replica would list.
 * For tests (D165).
 */
export function isolatedAriaIndexMatchesReplica(document: Document): boolean {
  const index = isolatedAriaIndex(document);
  const fresh: IsolatedAriaIndex = {
    ids: new Map(),
    listedIds: new Map(),
    triggers: new Set(),
    dirty: true,
  };
  rebuildIsolatedAriaIndex(document, fresh);
  if (
    fresh.ids.size !== index.ids.size ||
    fresh.triggers.size !== index.triggers.size
  ) return false;
  for (const trigger of fresh.triggers) {
    if (!index.triggers.has(trigger)) return false;
  }
  for (const [id, elements] of fresh.ids) {
    const listed = index.ids.get(id);
    if (
      !listed || listed.length !== elements.length ||
      !elements.every((element) => listed.includes(element))
    ) return false;
  }
  return true;
}

/**
 * An attribute written outside a patch (the semantic presenter's own
 * `id`/`aria-controls`) or a rolled-back patch: the index no longer
 * describes the replica, so it is rebuilt from it on next use. With a
 * ledger, the presenter's writes are followed instead (D165).
 */
function markIsolatedAriaIndexDirty(document: Document | undefined): void {
  if (!document) return;
  const index = ISOLATED_ARIA_INDEXES.get(document);
  if (index) index.dirty = true;
}

/** Adds the elements a patch built to the index, when it is still current. */
function registerIsolatedAriaIndexNodes(
  document: Document | undefined,
  nodes: Iterable<Node>,
): void {
  if (!document) return;
  const index = ISOLATED_ARIA_INDEXES.get(document);
  if (!index || index.dirty) return;
  for (const node of nodes) {
    if (sourceNodeType(node) === Node.ELEMENT_NODE) {
      registerIsolatedAriaIndexElement(index, node as Element);
    }
  }
}

/** The elements of a target's composed subtree with one of the menu roles. */
function isolatedComposedRoleElements(
  root: Element,
  expectedRole: 'listbox' | 'menu',
): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  const pending: Node[] = [...sourceChildNodeList(root)];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (sourceNodeType(node) === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (isolatedPublicMenuRole(element) === expectedRole) {
        candidates.push(element);
      }
      const shadowRoot = sourceProperty(element, 'shadowRoot');
      if (shadowRoot) pending.push(shadowRoot);
    }
    for (const child of sourceChildNodeList(node)) pending.push(child);
  }
  return candidates;
}

function collectIsolatedElements(root: Node): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (sourceNodeType(node) === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      elements.push(element);
      const shadowRoot = sourceProperty(element, 'shadowRoot');
      if (shadowRoot) pending.push(shadowRoot);
    }
    for (const child of sourceChildNodeList(node)) pending.push(child);
  }
  return elements;
}

function isolatedSelectFacsimileHost(element: Element): HTMLElement | undefined {
  const root = sourceCall(element, 'getRootNode');
  if (
    sourceNodeType(root) !== Node.DOCUMENT_FRAGMENT_NODE ||
    !(root as ShadowRoot).host
  ) return undefined;
  const host = (root as ShadowRoot).host as HTMLElement;
  return ISOLATED_SELECT_HOSTS.has(host) ? host : undefined;
}

function isolatedPublicMenuRole(
  element: Element,
): 'listbox' | 'menu' | undefined {
  for (const token of sourceCall(element, 'getAttribute', 'role')?.trim().toLowerCase()
    .split(/\s+/u) ?? []) {
    if (token === 'listbox' || token === 'menu') return token;
  }
  return undefined;
}

function isolatedSelectPresentation(
  select: HTMLSelectElement,
): 'list' | 'popup' {
  const rawSize = select.getAttribute('size');
  const size = rawSize && /^[1-9]\d{0,3}$/u.test(rawSize)
    ? Number(rawSize)
    : 0;
  return select.multiple || select.hasAttribute('multiple') || size > 1
    ? 'list'
    : 'popup';
}

function syncIsolatedNativeSelectFacsimile(host: HTMLElement): void {
  const facsimile = ISOLATED_SELECT_FACSIMILES.get(host);
  if (!facsimile) return;
  const { panel, select, trigger } = facsimile;
  const exposesSelection = select.getAttribute(
    'data-simul-source-selection-state',
  ) === 'v1';
  const presentation = isolatedSelectPresentation(select);
  sourceCall(host, 'setAttribute', 'data-simul-select-presentation', presentation);
  if (presentation === 'list') {
    trigger.setAttribute('hidden', '');
    trigger.style.setProperty('display', 'none', 'important');
  } else {
    trigger.removeAttribute('hidden');
    trigger.style.removeProperty('display');
  }
  sourceCall(panel, 'setAttribute', 'role', 'listbox');
  sourceCall(panel, 'setAttribute', 'aria-disabled', 'true');
  if (select.multiple || select.hasAttribute('multiple')) {
    sourceCall(panel, 'setAttribute', 'aria-multiselectable', 'true');
  } else {
    sourceCall(panel, 'removeAttribute', 'aria-multiselectable');
  }

  const semanticSelection = exposesSelection
    ? semanticSelectionTextFor(select)?.trim()
    : undefined;
  const contentSignature = isolatedSelectContentSignature(
    select,
    exposesSelection,
    semanticSelection,
  );
  if (facsimile.contentSignature === contentSignature) return;
  facsimile.contentSignature = contentSignature;
  // Drawn again while open (a translation arriving, a changed list): the
  // list keeps its place.
  const scrollTop = panel.scrollTop;
  const scrollLeft = panel.scrollLeft;
  sourceCall(panel, 'replaceChildren');

  const selectedLabels: string[] = [];
  const labels: string[] = [];
  let firstSelected: Element | undefined;
  const appendOption = (
    option: HTMLOptionElement,
    parent: HTMLElement,
    groupDisabled: boolean,
  ): void => {
    const row = select.ownerDocument.createElement('div');
    row.setAttribute('data-simul-owned-select-option', 'v1');
    row.setAttribute('role', 'option');
    row.style.setProperty('box-sizing', 'border-box', 'important');
    row.style.setProperty('display', 'block', 'important');
    row.style.setProperty('min-height', '1.5em', 'important');
    row.style.setProperty('padding-inline', '.5rem', 'important');
    row.style.setProperty('pointer-events', 'none', 'important');
    row.style.setProperty('white-space', 'normal', 'important');
    const selected = exposesSelection &&
      option.getAttribute('data-simul-source-option-selected') === 'v1';
    const disabled = groupDisabled || option.disabled === true ||
      option.hasAttribute('disabled');
    if (exposesSelection) {
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    if (disabled) {
      row.setAttribute('aria-disabled', 'true');
      row.style.setProperty('opacity', '0.65', 'important');
    }
    const label = (option.getAttribute('label') ?? option.textContent ?? '')
      .replace(/\s+/gu, ' ')
      .trim();
    row.textContent = label || '\u00a0';
    if (label) labels.push(label);
    // A translated label carries its language on the option (D124).
    copyTranslatedLanguage(option, row);
    if (selected && label) {
      firstSelected ??= option;
      selectedLabels.push(label);
    }
    sourceCall(parent, 'append', row);
  };

  for (const child of [...select.children]) {
    // No row for an option, and nothing for a group, that the page's own
    // list leaves out (D145; each was a blank row between the others).
    if (isolatedSelectEntryIsLeftOut(child)) continue;
    if (sourceLocalName(child).toLowerCase() === 'option') {
      appendOption(child as HTMLOptionElement, panel, false);
      continue;
    }
    if (sourceLocalName(child).toLowerCase() !== 'optgroup') continue;
    const groupElement = child as HTMLOptGroupElement;
    const group = select.ownerDocument.createElement('div');
    group.setAttribute('data-simul-owned-select-optgroup', 'v1');
    group.setAttribute('role', 'group');
    const groupDisabled = groupElement.disabled === true ||
      groupElement.hasAttribute('disabled');
    if (groupDisabled) group.setAttribute('aria-disabled', 'true');
    const labelText = (groupElement.getAttribute('label') ?? '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (labelText) {
      const label = select.ownerDocument.createElement('div');
      label.setAttribute('data-simul-owned-select-optgroup-label', 'v1');
      label.style.setProperty('font-weight', '600', 'important');
      label.style.setProperty('padding-inline', '.5rem', 'important');
      label.style.setProperty('pointer-events', 'none', 'important');
      label.textContent = labelText;
      copyTranslatedLanguage(groupElement, label);
      group.append(label);
    }
    for (const option of [...groupElement.children]) {
      if (
        sourceLocalName(option).toLowerCase() === 'option' &&
        !isolatedSelectEntryIsLeftOut(option)
      ) {
        appendOption(option as HTMLOptionElement, group, groupDisabled);
      }
    }
    sourceCall(panel, 'append', group);
  }
  if (scrollTop || scrollLeft) {
    panel.scrollTop = scrollTop;
    panel.scrollLeft = scrollLeft;
  }
  const sizer = sourceProperty(host, 'shadowRoot')?.querySelector('[data-simul-owned-select-sizer="v1"]');
  if (sizer) {
    // One fragment, not an argument a label: a dropdown of tens of
    // thousands of options passes the engine's limit on arguments (D186).
    const lines = select.ownerDocument.createDocumentFragment();
    for (const label of labels) {
      const line = select.ownerDocument.createElement('div');
      line.textContent = label;
      lines.append(line);
    }
    sourceCall(sizer, 'replaceChildren', lines);
  }
  const triggerText = exposesSelection
    ? semanticSelection || selectedLabels.join(', ') || '\u2014'
    : 'Options';
  // What the trigger shows is the select's current choice, or the labels of
  // its selected options.
  const shownFrom = !exposesSelection
    ? undefined
    : semanticSelection ? select : firstSelected;
  if (!shownFrom?.hasAttribute('lang')) {
    trigger.textContent = triggerText;
    return;
  }
  // The language goes on the text, not on the trigger: the trigger's name
  // is Simul's own English label (D124).
  const shown = select.ownerDocument.createElement('span');
  copyTranslatedLanguage(shownFrom, shown);
  shown.textContent = triggerText;
  trigger.replaceChildren(shown);
}

/**
 * An option or a group the page's own list leaves out: the page reader's
 * mark for one that is not displayed inside its dropdown. The mark is part
 * of what the list is drawn from, so the list is drawn again by the pass
 * that follows every patch when a patch changes it.
 */
function isolatedSelectEntryIsLeftOut(entry: Element): boolean {
  return sourceCall(entry, 'getAttribute', 'data-simul-visually-hidden') === 'v1';
}

function isolatedSelectContentSignature(
  select: HTMLSelectElement,
  exposesSelection: boolean,
  semanticSelection: string | undefined,
): string {
  const entries: unknown[] = [
    exposesSelection,
    semanticSelection ?? null,
    select.multiple || select.hasAttribute('multiple'),
    select.getAttribute('lang'),
  ];
  const appendOption = (option: HTMLOptionElement): void => {
    entries.push([
      'option',
      option.getAttribute('label') ?? option.textContent ?? '',
      option.getAttribute('data-simul-source-option-selected') === 'v1',
      option.disabled === true || option.hasAttribute('disabled'),
      option.getAttribute('lang'),
      isolatedSelectEntryIsLeftOut(option),
    ]);
  };
  for (const child of [...select.children]) {
    const tagName = sourceLocalName(child).toLowerCase();
    if (tagName === 'option') {
      appendOption(child as HTMLOptionElement);
      continue;
    }
    if (tagName !== 'optgroup') {
      entries.push(['other', tagName]);
      continue;
    }
    const group = child as HTMLOptGroupElement;
    entries.push([
      'optgroup',
      group.getAttribute('label') ?? '',
      group.disabled === true || group.hasAttribute('disabled'),
      group.getAttribute('lang'),
      isolatedSelectEntryIsLeftOut(group),
    ]);
    for (const option of [...group.children]) {
      if (sourceLocalName(option).toLowerCase() === 'option') {
        appendOption(option as HTMLOptionElement);
      } else {
        entries.push(['other', sourceLocalName(option).toLowerCase()]);
      }
    }
  }
  return JSON.stringify(entries);
}

function syncContainingIsolatedSelectFacsimile(element: Element): void {
  const host = containingIsolatedSelectFacsimileHost(element);
  if (host) syncIsolatedNativeSelectFacsimile(host);
}

function containingIsolatedSelectFacsimileHost(
  element: Element,
): HTMLElement | undefined {
  const select = sourceLocalName(element).toLowerCase() === 'select'
    ? element as HTMLSelectElement
    : sourceCall(element, 'closest', 'select');
  return select ? isolatedSelectFacsimileHost(select) : undefined;
}

/** Draws again, once each, the facsimiles of the selects among `elements`. */
function syncIsolatedSelectFacsimilesShowing(
  elements: readonly Element[],
): void {
  const hosts = new Set<HTMLElement>();
  for (const element of elements) {
    if (!isNativeSelectSemanticGraphTag(sourceLocalName(element).toLowerCase())) continue;
    const host = containingIsolatedSelectFacsimileHost(element);
    if (host) hosts.add(host);
  }
  for (const host of hosts) syncIsolatedNativeSelectFacsimile(host);
}

function refreshIsolatedNativeSelectFacsimiles(
  document: Document | null,
): void {
  if (!document?.documentElement) return;
  for (const host of isolatedSelectHosts(document)) {
    syncIsolatedNativeSelectFacsimile(host);
  }
}

/** Draws one select facsimile and keeps its dropdown controller in shape. */
function refreshIsolatedSelectHost(
  host: HTMLElement,
  retainedOpenDisclosures: ReadonlySet<HTMLElement>,
): void {
  const facsimile = ISOLATED_SELECT_FACSIMILES.get(host);
  if (!facsimile) return;
  syncIsolatedNativeSelectFacsimile(host);
  const presentation = isolatedSelectPresentation(facsimile.select);
  const rawSize = facsimile.select.getAttribute('size');
  const size = rawSize && /^[1-9]\d{0,3}$/u.test(rawSize)
    ? Number(rawSize)
    : 8;
  const pickerOpen = presentation === 'popup' &&
    facsimile.select.getAttribute('data-simul-source-picker-open') === 'v1';
  const shape = `${presentation}:${size}`;
  const current = facsimile.controller;
  // The page closed its picker (a choice, Escape, a click elsewhere): the
  // list it had opened here closes too. Only the change closes it; a list
  // the reader opened here while the page's stayed shut stays open.
  const pickerClosed = facsimile.pickerOpen === true && !pickerOpen;
  facsimile.pickerOpen = pickerOpen;
  // The button and the list are Simul's own, so nothing in a page change
  // can touch this controller. It stays unless the dropdown itself changed
  // shape: taking it down and putting it up again on every change moved an
  // open list out and back and scrolled it to the selected option, so on a
  // page with a carousel the far end of a long list could not be reached
  // (D132).
  if (current && !current.isDisposed() && facsimile.controllerShape === shape) {
    if (pickerOpen) current.open();
    else if (pickerClosed) current.close();
    current.sync();
    return;
  }
  current?.dispose();
  facsimile.controllerShape = shape;
  facsimile.controller = installReadOnlyReplicaDisclosure({
    anchor: host,
    panel: facsimile.panel,
    presentation,
    ...(presentation === 'popup' ? { trigger: facsimile.trigger } : {}),
    manageTriggerExpanded: presentation === 'popup',
    // A native select does not open on hover.
    openOnHover: false,
    survivesRefresh: true,
    initiallyOpen: presentation === 'popup' && (
      pickerOpen || (!pickerClosed && retainedOpenDisclosures.has(host))
    ),
    visibleRows: size,
  });
}

/**
 * Refreshes the replica's dropdowns and ARIA disclosures. Only the select
 * hosts a patch can have changed are drawn again; the rest keep their
 * controllers and are repositioned if open. The ARIA pass reads the
 * maintained index of ids and triggers instead of every element (R3).
 */
function refreshIsolatedReplicaDisclosures(
  document: Document,
  retainedOpenDisclosures = snapshotOpenReadOnlyReplicaDisclosures(document),
  changedRoots?: readonly Node[],
): void {
  disposeReadOnlyReplicaDisclosures(document, true);
  if (!document.documentElement) return;
  const changedHosts = changedRoots === undefined
    ? undefined
    : selectHostsInChangedRoots(document, changedRoots);
  for (const host of isolatedSelectHosts(document)) {
    if (changedHosts && !changedHosts.has(host)) {
      const controller = ISOLATED_SELECT_FACSIMILES.get(host)?.controller;
      if (controller && !controller.isDisposed()) {
        // An open list keeps its place when the layout around it moves.
        controller.sync();
        continue;
      }
    }
    refreshIsolatedSelectHost(host, retainedOpenDisclosures);
  }
  if (!installValidatedIsolatedAriaDisclosures(document, isolatedAriaIndex(document))) {
    // Two triggers named one panel: which one owns it depends on the order
    // of the page walk, so that pass decides.
    disposeReadOnlyReplicaDisclosures(document, true);
    installValidatedIsolatedAriaDisclosuresInOrder(
      document,
      collectIsolatedElements(document.documentElement),
    );
  }
}

/**
 * Custom ARIA disclosure is admitted only for a unique, same-document target
 * with matching menu/listbox semantics. Ambiguous and unsupported mappings
 * remain static and pointer-inert. The page's own menu opens in place, drawn
 * with the page's styles and images, as a structural menu does (D88; it was
 * an isolated facsimile popup that dropped both).
 */
function installValidatedIsolatedAriaDisclosuresInOrder(
  document: Document,
  elements: readonly HTMLElement[],
): void {
  const ids = new Map<string, HTMLElement[]>();
  for (const element of elements) {
    const id = sourceCall(element, 'getAttribute', 'id')?.trim();
    if (!id) continue;
    const existing = ids.get(id);
    if (existing) existing.push(element);
    else ids.set(id, [element]);
  }
  const usedPanels = new Set<HTMLElement>();
  for (const trigger of elements) {
    if (ISOLATED_SELECT_HOSTS.has(trigger)) continue;
    const controls = sourceCall(trigger, 'getAttribute', 'aria-controls')?.trim() ?? '';
    if (!controls || /\s/u.test(controls) || controls.length > 256) continue;
    const targets = ids.get(controls);
    if (targets?.length !== 1) continue;
    const target = targets[0]!;
    if (sourceProperty(target, 'ownerDocument') !== document || target === trigger) continue;
    const hasPopup = sourceCall(trigger, 'getAttribute', 'aria-haspopup')?.trim().toLowerCase();
    const expectedRole = hasPopup === 'true' ? 'menu' : hasPopup;
    if (expectedRole !== 'menu' && expectedRole !== 'listbox') continue;
    if (
      !isSourceActivationTagName(sourceLocalName(trigger)) &&
      !isSourceActivationRoleValue(sourceCall(trigger, 'getAttribute', 'role'))
    ) continue;

    let panel: HTMLElement | undefined =
      isolatedPublicMenuRole(target) === expectedRole ? target : undefined;
    if (!panel) {
      if (!roleHasToken(target, 'region')) continue;
      const candidates = elements.filter((candidate) =>
        candidate !== target &&
        isolatedPublicMenuRole(candidate) === expectedRole &&
        composedElementContains(target, candidate));
      if (candidates.length !== 1) continue;
      panel = candidates[0]!;
    }
    if (usedPanels.has(panel) || composedElementContains(panel, trigger)) {
      continue;
    }
    usedPanels.add(panel);
    installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'inline',
      manageTriggerExpanded: false,
      shownByPage: sourceCall(trigger, 'getAttribute', 'aria-expanded') === 'true',
    });
  }
}

/**
 * The same disclosures, resolved through the maintained index. Iteration
 * order does not matter unless two triggers name one panel; that case
 * returns false so the caller can run the order-sensitive pass above. The
 * conflict is defensive: the semantic protocol derives one relation id per
 * trigger/panel pair, so valid transport cannot make two triggers name one
 * panel, but a state written outside it can.
 */
function installValidatedIsolatedAriaDisclosures(
  document: Document,
  index: IsolatedAriaIndex,
): boolean {
  const usedPanels = new Set<HTMLElement>();
  for (const trigger of index.triggers) {
    if (
      ISOLATED_SELECT_HOSTS.has(trigger) ||
      !isIsolatedOwnedHostConnected(trigger)
    ) continue;
    const controls = sourceCall(trigger, 'getAttribute', 'aria-controls')?.trim() ?? '';
    if (!controls || /\s/u.test(controls) || controls.length > 256) continue;
    const targets = index.ids.get(controls);
    if (targets?.length !== 1) continue;
    const target = targets[0]!;
    if (sourceProperty(target, 'ownerDocument') !== document || target === trigger) continue;
    const hasPopup = sourceCall(trigger, 'getAttribute', 'aria-haspopup')?.trim().toLowerCase();
    const expectedRole = hasPopup === 'true' ? 'menu' : hasPopup;
    if (expectedRole !== 'menu' && expectedRole !== 'listbox') continue;
    if (
      !isSourceActivationTagName(sourceLocalName(trigger)) &&
      !isSourceActivationRoleValue(sourceCall(trigger, 'getAttribute', 'role'))
    ) continue;

    let panel: HTMLElement | undefined =
      isolatedPublicMenuRole(target) === expectedRole ? target : undefined;
    if (!panel) {
      if (!roleHasToken(target, 'region')) continue;
      const candidates = isolatedComposedRoleElements(target, expectedRole);
      if (candidates.length !== 1) continue;
      panel = candidates[0]!;
    }
    if (usedPanels.has(panel)) return false;
    if (composedElementContains(panel, trigger)) continue;
    usedPanels.add(panel);
    installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'inline',
      manageTriggerExpanded: false,
      shownByPage: sourceCall(trigger, 'getAttribute', 'aria-expanded') === 'true',
    });
  }
  return true;
}

function roleHasToken(element: Element, token: string): boolean {
  return sourceCall(element, 'getAttribute', 'role')?.trim().toLowerCase()
    .split(/\s+/u).includes(token) ?? false;
}

function composedElementContains(container: Element, candidate: Element): boolean {
  let current: Node | null = candidate;
  for (let depth = 0; current && depth <= 128; depth += 1) {
    if (current === container) return true;
    const parent: Node | null = sourceProperty(current, 'parentNode');
    if (parent) {
      current = parent;
      continue;
    }
    const root: Node = sourceCall(current, 'getRootNode');
    current = sourceNodeType(root) === Node.DOCUMENT_FRAGMENT_NODE &&
        'host' in root
      ? (root as ShadowRoot).host
      : null;
  }
  return false;
}

/**
 * The sheet text a mirror `<style>` was given, if it holds one: what its
 * own text nodes hold, which is what Chrome makes its sheet from. An
 * element inside the style is no part of it.
 */
function heldResolvedStyleSheetText(element: Element): string | undefined {
  if (sourceCall(element, 'getAttribute', 'data-simul-resolved-stylesheet') !== 'v1') {
    return undefined;
  }
  let text = '';
  for (const child of sourceChildNodeList(element)) {
    if (sourceNodeType(child) === Node.TEXT_NODE) text += child.nodeValue ?? '';
  }
  return text;
}

function applyResolvedStyleSheetText(
  element: Element,
  cssText: string | undefined,
): void {
  if (cssText === undefined || sourceLocalName(element).toLowerCase() !== 'style') return;
  const textNodes = [...sourceChildNodeList(element)].filter(
    (node) => sourceNodeType(node) === Node.TEXT_NODE,
  );
  if (textNodes.length === 0) {
    sourceCall(element, 'append', sourceProperty(element, 'ownerDocument').createTextNode(cssText));
  } else {
    textNodes[0]!.nodeValue = cssText;
    for (const extra of textNodes.slice(1)) extra.nodeValue = '';
  }
  sourceCall(element, 'setAttribute', 'data-simul-resolved-stylesheet', 'v1');
}

function applyReplicaCanvasBackground(
  element: Element,
  color: string | undefined,
): void {
  const styled = element as HTMLElement;
  if (color) {
    sourceProperty(styled, 'style').setProperty('background-color', color, 'important');
    sourceCall(element, 'setAttribute', 'data-simul-canvas-background', 'v1');
    return;
  }
  if (sourceCall(element, 'getAttribute', 'data-simul-canvas-background') !== 'v1') return;
  sourceProperty(styled, 'style').removeProperty('background-color');
  if (!sourceCall(element, 'getAttribute', 'style')?.trim()) sourceCall(element, 'removeAttribute', 'style');
  sourceCall(element, 'removeAttribute', 'data-simul-canvas-background');
}

function applyControlText(
  element: Element,
  controlText: HtmlMirrorControlText | undefined,
): void {
  const tagName = sourceLocalName(element).toLowerCase();
  if (
    (tagName === 'option' || tagName === 'optgroup') &&
    controlText?.kind === 'label'
  ) {
    sourceCall(element, 'setAttribute', 'label', controlText.text);
    return;
  }
  if (tagName !== 'input' && tagName !== 'textarea') return;
  // With "Show everything (testing)" on, the page's value and placeholder
  // attributes travel and show until the semantic channel sets live values.
  if (SOURCE_PRIVACY_FILTERS_OFF && !controlText) return;
  const control = element as Element & {
    value: string;
    placeholder: string;
  };
  control.value = controlText?.kind === 'value' ? controlText.text : '';
  control.placeholder = controlText?.kind === 'placeholder'
    ? controlText.text
    : '';
}

function isNativeReplicaTextControl(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement {
  const tagName = sourceLocalName(element).toLowerCase();
  return tagName === 'input' || tagName === 'textarea';
}

function buildRecords(
  document: ReplicaSourceDocumentIdentity,
  metadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
  controlMetadata: Map<number, HtmlMirrorControlText>,
  revisions: Map<number, number>,
  previous?: Map<number, ReplicaSourceTextRecord>,
): Map<number, ReplicaSourceTextRecord> {
  const records = new Map<number, ReplicaSourceTextRecord>();
  for (const node of metadata.values()) {
    if (!node.translatable) continue;
    const old = previous?.get(node.id);
    // A record that would be made again as it is stays the same object:
    // after a patch, that is nearly every record of the mirror (D165).
    if (
      old?.nodeType === 3 && old.source === node.text &&
      old.document === document
    ) {
      records.set(node.id, old);
      continue;
    }
    const revision = old?.source === node.text
      ? old.revision
      : nextRevision(revisions, node.id);
    records.set(node.id, Object.freeze({
      document,
      nodeId: node.id,
      nodeType: 3,
      revision,
      source: node.text,
    }));
  }
  for (const [nodeId, control] of controlMetadata) {
    const old = previous?.get(nodeId);
    const same = old?.nodeType === 1 &&
      old.controlTarget === control.kind && old.source === control.text;
    if (same && old.document === document) {
      records.set(nodeId, old);
      continue;
    }
    const revision = same
      ? old.revision
      : nextRevision(revisions, nodeId);
    records.set(nodeId, Object.freeze({
      document,
      nodeId,
      nodeType: 1,
      controlTarget: control.kind,
      revision,
      source: control.text,
    }));
  }
  return records;
}

function sameReplicaTextRecord(
  left: ReplicaSourceTextRecord | undefined,
  right: ReplicaSourceTextRecord,
): boolean {
  if (
    !left || left.nodeType !== right.nodeType ||
    left.source !== right.source
  ) return false;
  return left.nodeType === 3 || (
    right.nodeType === 1 && left.controlTarget === right.controlTarget
  );
}

interface AppliedPatchBatch {
  readonly changes: readonly ReplicaSourceTextChange[];
  readonly retainedNodeCount: number;
  readonly insertedNodeCount: number;
  readonly movedNodeCount: number;
  readonly removedNodeCount: number;
}

/**
 * Applies the patches of one frame of the page, each to the mirror as the
 * one before left it, and all or none of them (D143): a patch the mirror
 * refuses, or one that fails halfway, leaves the mirror as the frame found
 * it. What is counted over the whole mirror (its records, its budget) is
 * counted once, after the last.
 */
/**
 * The check that refused the last patch, a fixed label for the diagnostics
 * (D183): which one asked for a whole read is what a real page tells.
 */
let patchRefusal: string | undefined;

function refusePatch(label: string): false {
  patchRefusal ??= label;
  return false;
}

function takePatchRefusal(): string | undefined {
  const label = patchRefusal;
  patchRefusal = undefined;
  return label;
}

function applyPatchFrame(
  state: HtmlMirrorDomState,
  parts: readonly (readonly HtmlMirrorPatchOperation[])[],
): AppliedPatchBatch | undefined {
  type StructuralOperation = Extract<
    HtmlMirrorPatchOperation,
    { kind: 'children' | 'reconcile-children' }
  >;
  interface ChildrenPlan {
    readonly target: Node;
    readonly oldChildren: readonly Node[];
    readonly fragment: DocumentFragment;
    readonly nodes: Map<number, Node>;
    readonly textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>;
    readonly controlMetadata: Map<number, HtmlMirrorControlText>;
    readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
  }
  interface ReconcilePlan {
    readonly target: Node;
    readonly oldChildren: readonly Node[];
    readonly desiredChildren: readonly Node[];
    readonly retainedChildren: ReadonlySet<Node>;
    readonly stableRetainedChildren: ReadonlySet<Node>;
    readonly nodes: Map<number, Node>;
    readonly textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>;
    readonly controlMetadata: Map<number, HtmlMirrorControlText>;
    readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
    readonly insertedNodeCount: number;
  }

  // Each node's id is kept by the map of nodes as it changes; it was built
  // from every node of the mirror for each frame (D165).
  const currentNodeIds = (): ReadonlyMap<Node, number> => state.nodes.ids;
  const setCurrentNode = (id: number, node: Node): void => {
    state.nodes.set(id, node);
  };

  // What the frame started from, taken when its first patch is about to
  // change the mirror. The records are not changed until the frame is
  // applied, so the map itself is what the frame started from (D165).
  let previous: Map<number, ReplicaSourceTextRecord> | undefined;
  const forceUpserts = new Set<number>();
  const rollbacks: PatchRollbackSnapshot[] = [];
  let retainedNodeCount = 0;
  let insertedNodeCount = 0;
  let movedNodeCount = 0;
  let removedNodeCount = 0;
  const undo = (): undefined => {
    for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
      restorePatchRollback(state, rollbacks[index]!);
    }
    // The maps by id as the frame found them: from their journals (D165).
    state.nodes.rollbackJournal();
    state.textMetadata.rollbackJournal();
    state.controlMetadata.rollbackJournal();
    if (previous) {
      (state as { records: Map<number, ReplicaSourceTextRecord> }).records =
        previous;
    }
    markIsolatedAriaIndexDirty(state.iframe.contentDocument ?? undefined);
    return undefined;
  };

  /**
   * One patch of the frame. False when the mirror refuses it, before it
   * changed anything; throws when it fails while it is applied.
   */
  const applyPart = (
    operations: readonly HtmlMirrorPatchOperation[],
  ): boolean => {
    const targetOperations: Array<{
      readonly operation: Exclude<HtmlMirrorPatchOperation, { kind: 'dimensions' }>;
      readonly target: Node;
    }> = [];
    const parsedText = new Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>();
    const attributeOperations = new Map<
      number,
      Extract<HtmlMirrorPatchOperation, { kind: 'attributes' }>
    >();
    const appendedSheetTexts = new Map<number, string>();
    // The sheet text of each style whose list of children this patch sends.
    const keptSheetTexts = new Map<number, string>();
    const prospectiveAttributeOperations = new Map<
      number,
      Extract<HtmlMirrorPatchOperation, { kind: 'attributes' }>
    >();
    const childReplacementNodeIds = new Set<number>();
    for (const [index, operation] of operations.entries()) {
      if (operation.kind === 'attributes') {
        prospectiveAttributeOperations.set(operation.nodeId, operation);
      } else if (
        operation.kind === 'children' ||
        operation.kind === 'reconcile-children'
      ) {
        if (operation.kind === 'children') {
          childReplacementNodeIds.add(operation.nodeId);
        }
      }
    }

    // Validate every target and payload before touching visible state.
    for (const operation of operations) {
      if (operation.kind === 'dimensions') continue;
      const target = state.nodes.get(operation.nodeId);
      if (!target) return refusePatch('target-missing');
      if (
        sourceNodeType(target) === Node.ELEMENT_NODE &&
        isSourceSecretPlaceholderTagName(sourceLocalName((target as Element)))
      ) {
        // The placeholder is immutable for its document lifetime. Any source
        // mutation at that ID requires a fresh graph so no descendant/resource
        // patch can repopulate the erased hard-secret region.
        return refusePatch('secret-placeholder');
      }
      targetOperations.push({ operation, target });
      if (
        (operation.kind === 'children' ||
          operation.kind === 'reconcile-children') &&
        sourceNodeType(target) === Node.ELEMENT_NODE
      ) {
        const targetElement = target as Element;
        const select = sourceLocalName(targetElement).toLowerCase() === 'select'
          ? targetElement
          : sourceCall(targetElement, 'closest', 'select');
        // Native select structure is transported whole at the select root; a
        // patch for one of its groups or options is never sent. The new options
        // come without a selection: the current choice arrives on the semantic
        // channel, and nothing is drawn from this hidden native select (D132;
        // the patch was once accepted only with selected positions the page
        // has stopped sending, so every changed list rebuilt the mirror).
        if (select && targetElement !== select) return refusePatch('select-part');
      }
      if (operation.kind === 'text') {
        const node = readHtmlMirrorNode(
          operation.node,
          undefined,
          0,
          undefined,
          false,
          false,
          false,
          false,
          false,
          state.fidelityPolicy,
        );
        if (
          sourceNodeType(target) !== Node.TEXT_NODE ||
          !node || node.kind !== 'text' || node.id !== operation.nodeId ||
          !validTextForContext(
            node,
            domTextContext(target),
            state.fidelityPolicy,
          )
        ) return refusePatch('text-context');
        parsedText.set(operation.nodeId, node);
        continue;
      }
      if (operation.kind === 'attributes') {
        if (
          sourceNodeType(target) !== Node.ELEMENT_NODE ||
          sourceProperty((target as Element), 'namespaceURI') !== NAMESPACE_URIS[operation.namespace] ||
          sourceLocalName((target as Element)).toLowerCase() !== operation.tagName
        ) return refusePatch('attribute-target');
        const currentContext = containerContext(target);
        const prospectiveContext = batchContainerContext(
          target,
          prospectiveAttributeOperations,
          currentNodeIds(),
        );
        if (
          privacyContextChanges(currentContext, prospectiveContext) &&
          (
            sourceProperty((target as Element), 'shadowRoot') ||
            !childReplacementNodeIds.has(operation.nodeId)
          )
        ) return refusePatch('attribute-shadow-host');
        if (
          prospectiveContext.privateAttributeRegion &&
          hasPrivateHtmlMirrorAttribute(operation.tagName, operation.attributes)
        ) return refusePatch('attribute-private');
        try {
          const sentinelDocument = sourceProperty(target, 'ownerDocument');
          if (!sentinelDocument) return refusePatch('attribute-document');
          const sentinel = createMirrorElement(
            sentinelDocument,
            operation.namespace,
            operation.tagName,
          );
          setAttributes(sentinel, operation.attributes);
        } catch {
          return refusePatch('attribute-sentinel');
        }
        if (operation.resolvedStyleSheetTextFrom !== undefined) {
          // What follows the text the mirror holds for this style: the two
          // together are the sheet, and are checked as a sheet sent whole
          // is. Anything else held here is a mirror out of step.
          const held = heldResolvedStyleSheetText(target as Element);
          const whole = `${held ?? ''}${operation.resolvedStyleSheetText ?? ''}`;
          if (
            held === undefined ||
            held.length !== operation.resolvedStyleSheetTextFrom ||
            !isTransportableStyleSheetText(whole, state.fidelityPolicy)
          ) return refusePatch('sheet-append');
          appendedSheetTexts.set(operation.nodeId, whole);
        }
        attributeOperations.set(operation.nodeId, operation);
        continue;
      }
      if (operation.kind === 'children' || operation.kind === 'reconcile-children') {
        if (
          sourceNodeType(target) !== Node.ELEMENT_NODE &&
          sourceNodeType(target) !== Node.DOCUMENT_FRAGMENT_NODE
        ) return refusePatch('children-target');
        if (!isConnectedReplicaNode(state, target)) return refusePatch('children-disconnected');
        // A style the mirror holds by its sheet's text keeps that text when
        // its list of children is sent. The text nodes of such a patch hold
        // the page's own text, which is not always the sheet's (a rule put
        // in through the sheet is in the sheet's text only), and the page
        // reader sends the sheet again only when the sheet changed.
        const held = sourceNodeType(target) === Node.ELEMENT_NODE &&
            sourceLocalName((target as Element)).toLowerCase() === 'style'
          ? heldResolvedStyleSheetText(target as Element)
          : undefined;
        if (held !== undefined) keptSheetTexts.set(operation.nodeId, held);
        continue;
      }
      return refusePatch('unknown-operation');
    }

    // A parent replacement and a descendant operation cannot be made atomic:
    // the descendant identity ceases to exist. The source normally minimizes
    // these, while the extension treats a malicious/confused batch as recovery.
    // A parent *attribute* update beside a descendant replacement is accepted:
    // the loop above already refused any that changes the privacy context.
    if (hasStructuralPatchTargetConflict(targetOperations.map(
      ({ operation, target }) => ({
        target,
        structural: operation.kind === 'children' ||
          operation.kind === 'reconcile-children',
      }),
    ))) return refusePatch('structural-conflict');

    const structuralOperations = operations.filter(
      (operation): operation is StructuralOperation =>
        operation.kind === 'children' || operation.kind === 'reconcile-children',
    );
    if (
      structuralOperations.some(({ kind }) => kind === 'children') &&
      structuralOperations.some(({ kind }) => kind === 'reconcile-children')
    ) return refusePatch('children-and-reconcile');

    const removedIds = new Set<number>();
    const childrenOperations = structuralOperations.filter(
      (operation): operation is Extract<StructuralOperation, { kind: 'children' }> =>
        operation.kind === 'children',
    );
    const reconcileOperations = structuralOperations.filter(
      (operation): operation is Extract<
        StructuralOperation,
        { kind: 'reconcile-children' }
      > => operation.kind === 'reconcile-children',
    );
    const oldChildren = new Map<number, readonly Node[]>();
    for (const operation of structuralOperations) {
      const target = state.nodes.get(operation.nodeId) as Node;
      const mirrored = [...sourceChildNodeList(target)].filter(
        (child) => isMirrorPresentationNode(state.nodes, child),
      );
      oldChildren.set(operation.nodeId, mirrored);
      if (operation.kind === 'children') {
        for (const child of mirrored) {
          collectDomIds(currentNodeIds(), child, removedIds);
        }
      }
    }

    const incomingIds = new Set<number>();
    for (const operation of childrenOperations) {
      // The whole list of `<html>`'s children would take the mirror's own
      // head and body with it: that is a whole read.
      if (isReplicaDocumentElement(state.nodes.get(operation.nodeId) as Node)) {
        return refusePatch('html-children');
      }
      for (const child of operation.children) {
        if (!collectGraphIds(child, incomingIds)) return refusePatch('graph-ids');
      }
    }
    for (const id of incomingIds) {
      if (state.nodes.has(id) && !removedIds.has(id)) return refusePatch('graph-id-taken');
    }

    const retainedIds = new Set<number>();
    const reconcileGraphIds = new Set<number>();
    for (const operation of reconcileOperations) {
      const target = state.nodes.get(operation.nodeId) as Node;
      const directChildren = new Set(oldChildren.get(operation.nodeId) ?? []);
      // Under `<html>` the mirror's own head and body stay, and no other head
      // or body is added: the page changed its own, which is a whole read.
      const shell = isReplicaDocumentElement(target)
        ? new Set(replicaDocumentShell(directChildren))
        : undefined;
      for (const entry of operation.children) {
        if (entry.kind === 'retain') {
          const retainedSource = state.nodes.get(entry.nodeId);
          const retained = retainedSource
            ? presentationNodeForMirrorNode(retainedSource)
            : undefined;
          if (
            !retained || retainedIds.has(entry.nodeId) ||
            reconcileGraphIds.has(entry.nodeId) ||
            sourceProperty(retained, 'parentNode') !== target || !directChildren.has(retained) ||
            sourceProperty(retained, 'ownerDocument') !== sourceProperty(target, 'ownerDocument') ||
            !isConnectedReplicaNode(state, retained)
          ) return refusePatch('retain');
          retainedIds.add(entry.nodeId);
          shell?.delete(retained);
          continue;
        }
        if (
          !collectGraphIds(entry.node, reconcileGraphIds) ||
          (shell && isDocumentShellChild(entry.node))
        ) {
          return refusePatch('reconcile-graph');
        }
      }
      if (shell && shell.size > 0) return refusePatch('reconcile-shell');
    }
    const allRemovedIds = new Set(removedIds);
    for (const operation of reconcileOperations) {
      for (const child of oldChildren.get(operation.nodeId) ?? []) {
        const childId = currentNodeIds().get(child);
        if (childId !== undefined && retainedIds.has(childId)) continue;
        collectDomIds(currentNodeIds(), child, allRemovedIds);
      }
    }
    // A child sent again in place keeps its ids: an element given a shadow
    // root since it was sent comes again whole, with its root, and what it
    // was is taken out first (D190).
    for (const id of reconcileGraphIds) {
      if (
        retainedIds.has(id) || (state.nodes.has(id) && !allRemovedIds.has(id))
      ) return refusePatch('reconcile-id-taken');
    }
    const prospectiveNodeCount = state.nodes.size - allRemovedIds.size +
      incomingIds.size + reconcileGraphIds.size;
    if (
      prospectiveNodeCount < 0 ||
      prospectiveNodeCount > MAX_HTML_MIRROR_NODES
    ) return refusePatch('node-budget');

    // The text the mirror would keep: what it keeps, less what the patch
    // removes, with what it brings. Counted from the maps' running totals
    // and the patch's own entries (D165; it was a copy of both maps).
    const incomingText = new Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>();
    const incomingControls = new Map<number, HtmlMirrorControlText>();
    for (const operation of childrenOperations) {
      for (const child of operation.children) {
        collectGraphTextState(child, incomingText, incomingControls);
      }
    }
    for (const operation of reconcileOperations) {
      for (const child of operation.children) {
        if (child.kind === 'graph') {
          collectGraphTextState(child.node, incomingText, incomingControls);
        }
      }
    }
    if (prospectiveMetadataBytes(
      state,
      allRemovedIds,
      incomingText,
      incomingControls,
      parsedText,
    ) > MAX_HTML_MIRROR_BYTES) return refusePatch('byte-budget');

    const childrenPlans = new Map<
      Extract<StructuralOperation, { kind: 'children' }>,
      ChildrenPlan
    >();
    const reconcilePlans = new Map<
      Extract<StructuralOperation, { kind: 'reconcile-children' }>,
      ReconcilePlan
    >();
    try {
      for (const operation of childrenOperations) {
        const target = state.nodes.get(operation.nodeId) as Node;
        const context = containerContext(
          target,
          attributeOperations.get(operation.nodeId)?.attributes,
        );
        if (!operation.children.every(
          (child) => validGraphForContext(child, context, state.fidelityPolicy),
        )) {
          return refusePatch('children-context');
        }
        if (
          context.styleRegion &&
          !validStyleSheetTextForChildren(
            operation.children,
            state.fidelityPolicy,
          )
        ) return refusePatch('children-sheet');
        const ownerDocument = sourceProperty(target, 'ownerDocument');
        if (!ownerDocument) return refusePatch('children-document');
        const fragment = ownerDocument.createDocumentFragment();
        const nodes = new Map<number, Node>();
        const textMetadata = new Map<
          number,
          Extract<HtmlMirrorNode, { kind: 'text' }>
        >();
        const controlMetadata = new Map<number, HtmlMirrorControlText>();
        const ownedAdoptedStyles = new Set<HTMLStyleElement>();
        for (const child of operation.children) {
          const built = buildNode(
            ownerDocument,
            child,
            nodes,
            textMetadata,
            controlMetadata,
            ownedAdoptedStyles,
          );
          if (built) fragment.append(built);
        }
        childrenPlans.set(operation, {
          target,
          oldChildren: oldChildren.get(operation.nodeId) ?? [],
          fragment,
          nodes,
          textMetadata,
          controlMetadata,
          ownedAdoptedStyles,
        });
      }
      for (const operation of reconcileOperations) {
        const target = state.nodes.get(operation.nodeId) as Node;
        const context = containerContext(target);
        if (context.styleRegion) {
          // The sheet a style holds after this reconciliation: retained
          // children as they are, the arriving ones' text (R1).
          const parts: string[] = [];
          for (const entry of operation.children) {
            if (entry.kind === 'retain') {
              const retained = state.nodes.get(entry.nodeId);
              if (!retained) return refusePatch('reconcile-sheet-retain');
              parts.push(sourceProperty(retained, 'textContent') ?? '');
            } else {
              collectStyleSheetText([entry.node], parts);
            }
          }
          if (!styleSheetTextIsFixedPoint(
            parts.join(''),
            state.fidelityPolicy,
          )) return refusePatch('reconcile-sheet');
        }
        const ownerDocument = sourceProperty(target, 'ownerDocument');
        if (!ownerDocument) return refusePatch('reconcile-document');
        const nodes = new Map<number, Node>();
        const textMetadata = new Map<
          number,
          Extract<HtmlMirrorNode, { kind: 'text' }>
        >();
        const controlMetadata = new Map<number, HtmlMirrorControlText>();
        const ownedAdoptedStyles = new Set<HTMLStyleElement>();
        const retainedChildren = new Set<Node>();
        const desiredChildren: Node[] = [];
        let insertedNodeCount = 0;
        for (const entry of operation.children) {
          if (entry.kind === 'retain') {
            const retainedSource = state.nodes.get(entry.nodeId);
            if (!retainedSource) return refusePatch('reconcile-retain-missing');
            const retained = presentationNodeForMirrorNode(retainedSource);
            retainedChildren.add(retained);
            desiredChildren.push(retained);
            continue;
          }
          if (!validGraphForContext(
            entry.node,
            context,
            state.fidelityPolicy,
          )) return refusePatch('reconcile-context');
          const built = buildNode(
            ownerDocument,
            entry.node,
            nodes,
            textMetadata,
            controlMetadata,
            ownedAdoptedStyles,
          );
          if (!built) return refusePatch('reconcile-build');
          insertedNodeCount += htmlMirrorGraphNodeCount(entry.node);
          desiredChildren.push(built);
        }
        reconcilePlans.set(operation, {
          target,
          oldChildren: oldChildren.get(operation.nodeId) ?? [],
          desiredChildren: Object.freeze(desiredChildren),
          retainedChildren,
          stableRetainedChildren: stableRetainedChildSet(
            oldChildren.get(operation.nodeId) ?? [],
            desiredChildren,
            retainedChildren,
          ),
          nodes,
          textMetadata,
          controlMetadata,
          ownedAdoptedStyles,
          insertedNodeCount,
        });
      }
    } catch {
      return refusePatch('plan-threw');
    }
    if (!previous) {
      previous = state.records;
      state.nodes.beginJournal();
      state.textMetadata.beginJournal();
      state.controlMetadata.beginJournal();
    }
    const rollback = capturePatchRollback(state, targetOperations, rollbacks[0]);
    rollbacks.push(rollback);
    // A node the mirror held when the frame began.
    const knownBefore = (node: Node): boolean =>
      state.nodes.journalStartHasNode(node);
    for (const plan of childrenPlans.values()) {
      for (const child of plan.oldChildren) {
        removedNodeCount += domMirrorNodeCount(child, knownBefore);
      }
    }
    for (const plan of reconcilePlans.values()) {
      for (const child of plan.oldChildren) {
        if (plan.retainedChildren.has(child)) {
          retainedNodeCount += domMirrorNodeCount(child, knownBefore);
        } else {
          removedNodeCount += domMirrorNodeCount(child, knownBefore);
        }
      }
    }
    for (const operation of operations) {
      if (operation.kind === 'dimensions') {
        state.dimensions = {
          ...state.dimensions,
          viewportWidth: operation.viewportWidth,
          viewportHeight: operation.viewportHeight,
          documentWidth: operation.documentWidth,
          documentHeight: operation.documentHeight,
          canvasBackgroundColor: operation.canvasBackgroundColor,
        };
        const documentElement = state.iframe.contentDocument?.documentElement;
        if (!documentElement) throw new Error('Replica canvas is unavailable.');
        applyReplicaCanvasBackground(
          documentElement,
          operation.canvasBackgroundColor,
        );
        continue;
      }
      const target = state.nodes.get(operation.nodeId) as Node;
      if (operation.kind === 'text') {
        const node = parsedText.get(operation.nodeId) as Extract<
          HtmlMirrorNode,
          { kind: 'text' }
        >;
        target.nodeValue = node.text;
        state.textMetadata.set(operation.nodeId, node);
        forceUpserts.add(operation.nodeId);
        continue;
      }
      if (operation.kind === 'attributes') {
        let element = target as Element;
        if (switchesReplicaLinkOff(element, operation.attributes)) {
          const replacement = createMirrorElement(
            sourceProperty(element, 'ownerDocument'),
            operation.namespace,
            operation.tagName,
          );
          setAttributes(
            replacement,
            operation.attributes,
            operation.resolvedStyleSheetText,
          );
          sourceCall(element, 'replaceWith', replacement);
          setCurrentNode(operation.nodeId, replacement);
          element = replacement;
          markIsolatedAriaIndexDirty(state.iframe.contentDocument ?? undefined);
        } else {
          // `setAttributes` removes every attribute first, so an operation
          // that drops an `id` or `aria-controls` changes the index just as
          // one that adds it does (R3; a stale id resolved a panel that no
          // longer has one).
          const indexedBefore = sourceCall(element, 'hasAttribute', 'id') ||
            sourceCall(element, 'hasAttribute', 'aria-controls');
          setAttributes(
            element,
            operation.attributes,
            operation.resolvedStyleSheetText,
          );
          if (
            !RETAINED_LEDGERS.has(sourceProperty(element, 'ownerDocument')) && (
              indexedBefore || operation.attributes.some(
                ([name]) => name === 'id' || name === 'aria-controls',
              )
            )
          ) {
            markIsolatedAriaIndexDirty(
              state.iframe.contentDocument ?? undefined,
            );
          }
        }
        applyElementHints(element, operation);
        state.nodes.reclassify(element);
        state.controlMetadata.delete(operation.nodeId);
        continue;
      }
      if (operation.kind === 'children') {
        const plan = childrenPlans.get(operation);
        if (!plan) throw new Error('Missing children replacement plan.');
        const retainedShellStyles = [...sourceChildNodeList(plan.target)].filter(
          (child) => ISOLATED_OWNED_SHADOW_SHELL_STYLES.has(child),
        );
        const retainedAdoptedStyles = [...state.ownedAdoptedStyles].filter(
          (style) => sourceProperty(style, 'parentNode') === plan.target,
        );
        for (const child of plan.oldChildren) {
          removeDomTree(state, child);
          const parent = sourceProperty(child, 'parentNode');
          if (parent) sourceCall(parent, 'removeChild', child);
        }
        sourceCall(plan.target, 'appendChild', plan.fragment);
        for (const style of retainedShellStyles) sourceCall(plan.target, 'appendChild', style);
        for (const style of retainedAdoptedStyles) sourceCall(plan.target, 'appendChild', style);
        for (const style of plan.ownedAdoptedStyles) {
          state.ownedAdoptedStyles.add(style);
        }
        for (const [id, node] of plan.nodes) {
          setCurrentNode(id, node);
        }
        for (const [id, node] of plan.textMetadata) state.textMetadata.set(id, node);
        for (const [id, control] of plan.controlMetadata) {
          state.controlMetadata.set(id, control);
        }
        for (const child of operation.children) {
          insertedNodeCount += htmlMirrorGraphNodeCount(child);
          collectTranslatableIds(child, forceUpserts);
        }
        continue;
      }
      const plan = reconcilePlans.get(operation);
      if (!plan) throw new Error('Missing children reconciliation plan.');
      for (const child of plan.oldChildren) {
        if (plan.retainedChildren.has(child)) continue;
        removeDomTree(state, child);
        const parent = sourceProperty(child, 'parentNode');
        if (parent) sourceCall(parent, 'removeChild', child);
      }
      for (const style of plan.ownedAdoptedStyles) {
        state.ownedAdoptedStyles.add(style);
      }
      for (const [id, node] of plan.nodes) {
        setCurrentNode(id, node);
      }
      for (const [id, node] of plan.textMetadata) state.textMetadata.set(id, node);
      for (const [id, control] of plan.controlMetadata) {
        state.controlMetadata.set(id, control);
      }
      insertedNodeCount += plan.insertedNodeCount;
      let anchor: ChildNode | null = [...sourceChildNodeList(plan.target)].find(
        (child) => state.ownedAdoptedStyles.has(child as HTMLStyleElement) ||
          ISOLATED_OWNED_SHADOW_SHELL_STYLES.has(child),
      ) ?? null;
      for (let index = plan.desiredChildren.length - 1; index >= 0; index -= 1) {
        const child = plan.desiredChildren[index]!;
        if (
          !plan.stableRetainedChildren.has(child) &&
          (sourceProperty(child, 'parentNode') !== plan.target || sourceProperty(child, 'nextSibling') !== anchor)
        ) {
          if (plan.retainedChildren.has(child)) movedNodeCount += 1;
          sourceCall(plan.target, 'insertBefore', child, anchor);
        }
        anchor = child as ChildNode;
      }
      for (const entry of operation.children) {
        if (entry.kind === 'graph') collectTranslatableIds(entry.node, forceUpserts);
      }
    }
    // A `<style>` sent again holds its sheet's text, as one built from a
    // whole read does (D143). Written last: whatever the batch did to the
    // element's text nodes, the sheet ends as the page's.
    for (const [nodeId, held] of keptSheetTexts) {
      if (attributeOperations.has(nodeId)) continue;
      applyResolvedStyleSheetText(state.nodes.get(nodeId) as Element, held);
    }
    for (const [nodeId, operation] of attributeOperations) {
      applyResolvedStyleSheetText(
        state.nodes.get(nodeId) as Element,
        appendedSheetTexts.get(nodeId) ?? operation.resolvedStyleSheetText,
      );
    }
    const replicaDocument = state.iframe.contentDocument ?? undefined;
    for (const plan of childrenPlans.values()) {
      registerIsolatedAriaIndexNodes(replicaDocument, plan.nodes.values());
    }
    for (const plan of reconcilePlans.values()) {
      registerIsolatedAriaIndexNodes(replicaDocument, plan.nodes.values());
    }
    return true;
  };

  const shellReplacement = splitDocumentShellReplacement(state, parts);
  parts = shellReplacement.parts;
  if (!validFrameStyleSheetText(state, parts)) {
    refusePatch('frame-sheet');
    return undefined;
  }
  try {
    for (const [index, operations] of parts.entries()) {
      if (!applyPart(operations)) return undo();
      // The page's new head or body is the mirror's own from now on, under
      // its own id (D190). Journaled, as every change of the map is.
      for (const [oldId, newId] of shellReplacement.rebinds.get(index) ?? []) {
        const element = state.nodes.get(oldId);
        if (!element || state.nodes.has(newId)) return undo();
        state.nodes.delete(oldId);
        state.nodes.set(newId, element);
      }
    }
    // The frame is atomic but its parts are not: a later text part can
    // complete a construct against text an earlier part inserted. Validate
    // what the whole frame left, and roll it back if the sheet is not a
    // fixed point (R1).
    if (!validFrameStyleSheetTextAfterApply(state, parts)) {
      refusePatch('frame-sheet-after');
      return undo();
    }
    if (!previous) return undefined;
    if (!retainedReplicaStateFitsBudget(state)) {
      throw new Error('Replica retained-state budget exceeded.');
    }
    const replicaDocument = state.iframe.contentDocument;
    const update = recordUpdateOfFrame(state, previous, forceUpserts);
    if (update) {
      if (replicaDocument) assignIsolatedManualSlots(replicaDocument, state.nodes);
      // Last, when nothing can fail: the frame's records are the map the
      // frame started from, changed in place.
      update.apply(state.records);
      return Object.freeze({
        changes: update.changes,
        retainedNodeCount,
        insertedNodeCount,
        movedNodeCount,
        removedNodeCount,
      });
    }
    const next = buildRecords(
      state.document,
      state.textMetadata,
      state.controlMetadata,
      state.revisions,
      previous,
    );
    (state as { records: Map<number, ReplicaSourceTextRecord> }).records = next;
    const changes: ReplicaSourceTextChange[] = [];
    for (const old of previous.values()) {
      if (next.has(old.nodeId)) continue;
      const revision = nextRevision(state.revisions, old.nodeId);
      changes.push(Object.freeze({
        kind: 'remove',
        document: state.document,
        nodeId: old.nodeId,
        revision,
      }));
    }
    for (const record of next.values()) {
      const old = previous.get(record.nodeId);
      if (!sameReplicaTextRecord(old, record) || forceUpserts.has(record.nodeId)) {
        changes.push(Object.freeze({ kind: 'upsert', record }));
      }
    }
    if (replicaDocument) assignIsolatedManualSlots(replicaDocument, state.nodes);
    return Object.freeze({
      changes: Object.freeze(changes),
      retainedNodeCount,
      insertedNodeCount,
      movedNodeCount,
      removedNodeCount,
    });
  } catch {
    refusePatch('apply-threw');
    return undo();
  } finally {
    // Applied or put back, the frame's journals end with it.
    state.nodes.endJournal();
    state.textMetadata.endJournal();
    state.controlMetadata.endJournal();
  }
}

/**
 * For tests: off, every frame builds its records again from all the text,
 * so a test can compare the two ways (D165).
 */
export const isolatedEngineTestSwitches = { recordsFromChanges: true };

/**
 * The records of a frame, read from what it changed instead of from every
 * text of the mirror (D165; D178 for text added and removed). The records
 * are the texts in the order of their map, then the controls in theirs: a
 * removed record leaves its place, a record kept where it was is replaced
 * in place, and a text or control set again or added comes last of its
 * kind, as a fresh build would put it. A text added while the mirror has
 * controls would come before them, and a text that became translated
 * keeps its place among the others: for those, undefined, and the records
 * are built again from all the text, as before. The changed records are
 * made in the order `buildRecords` meets them, which numbers their
 * revisions, and the removed ones after, in the order of the records.
 * `apply`: what makes the frame's records these, in place.
 */
function recordUpdateOfFrame(
  state: HtmlMirrorDomState,
  previous: ReadonlyMap<number, ReplicaSourceTextRecord>,
  forceUpserts: ReadonlySet<number>,
): {
  readonly changes: readonly ReplicaSourceTextChange[];
  readonly apply: (records: Map<number, ReplicaSourceTextRecord>) => void;
} | undefined {
  if (!isolatedEngineTestSwitches.recordsFromChanges) return undefined;
  const texts = state.textMetadata;
  const controls = state.controlMetadata;
  const touchedTexts = texts.journalTouchedKeys();
  const touchedControls = controls.journalTouchedKeys();
  if (!touchedTexts || !touchedControls) return undefined;
  const touched = new Set<number>();
  for (const [id] of touchedTexts) touched.add(id);
  for (const [id] of touchedControls) touched.add(id);
  for (const id of forceUpserts) if (!touched.has(id)) return undefined;
  interface Placed {
    readonly id: number;
    readonly text: boolean;
    readonly place: number;
    readonly moved: boolean;
  }
  const placed: Placed[] = [];
  const removed: Array<{ readonly id: number; readonly text: boolean; readonly place: number }> = [];
  let textComesLast = false;
  for (const id of touched) {
    const text = texts.get(id);
    const control = controls.get(id);
    if (text && control) return undefined;
    const old = previous.get(id);
    const isText = text?.translatable === true;
    const isControl = control !== undefined;
    if (!isText && !isControl) {
      if (!old) continue;
      const place = (old.nodeType === 3 ? texts : controls).journalStartPlace(id);
      if (place === undefined) return undefined;
      removed.push({ id, text: old.nodeType === 3, place });
      continue;
    }
    if (old && old.nodeType !== (isText ? 3 : 1)) return undefined;
    const map = isText ? texts : controls;
    const place = map.placeOf(id)!;
    const moved = map.journalStartPlace(id) !== place;
    if (!old && !moved) return undefined;
    if (isText && moved) textComesLast = true;
    placed.push({ id, text: isText, place, moved });
  }
  if (textComesLast && controls.size > 0) return undefined;
  const inRecordOrder = (
    left: { readonly text: boolean; readonly place: number },
    right: { readonly text: boolean; readonly place: number },
  ): number => left.text === right.text
    ? left.place - right.place
    : left.text ? -1 : 1;
  placed.sort(inRecordOrder);
  removed.sort(inRecordOrder);
  const upserts: ReplicaSourceTextChange[] = [];
  const made: Array<{ readonly record: ReplicaSourceTextRecord; readonly moved: boolean }> = [];
  // As `buildRecords` makes each.
  for (const { id, text: isText, moved } of placed) {
    const old = previous.get(id);
    let record: ReplicaSourceTextRecord;
    if (isText) {
      const text = texts.get(id)!;
      record = old?.nodeType === 3 && old.source === text.text &&
          old.document === state.document
        ? old
        : Object.freeze({
            document: state.document,
            nodeId: id,
            nodeType: 3 as const,
            revision: old?.source === text.text
              ? old.revision
              : nextRevision(state.revisions, id),
            source: text.text,
          });
    } else {
      const control = controls.get(id)!;
      const same = old?.nodeType === 1 && old.controlTarget === control.kind &&
        old.source === control.text;
      record = same && old.document === state.document
        ? old
        : Object.freeze({
            document: state.document,
            nodeId: id,
            nodeType: 1 as const,
            controlTarget: control.kind,
            revision: same ? old.revision : nextRevision(state.revisions, id),
            source: control.text,
          });
    }
    if (record !== old || moved) made.push({ record, moved });
    if (!sameReplicaTextRecord(old, record) || forceUpserts.has(id)) {
      upserts.push(Object.freeze({ kind: 'upsert' as const, record }));
    }
  }
  const changes: ReplicaSourceTextChange[] = removed.map(({ id }) => Object.freeze({
    kind: 'remove' as const,
    document: state.document,
    nodeId: id,
    revision: nextRevision(state.revisions, id),
  }));
  for (const upsert of upserts) changes.push(upsert);
  return {
    changes: Object.freeze(changes),
    apply: (records) => {
      for (const { id } of removed) records.delete(id);
      for (const { record, moved } of made) {
        if (moved) records.delete(record.nodeId);
        records.set(record.nodeId, record);
      }
    },
  };
}

interface PatchRollbackSnapshot {
  readonly dimensions: HtmlMirrorLiveDimensions;
  readonly revisions: Map<number, number>;
  readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
  readonly childLists: ReadonlyMap<Node, readonly Node[]>;
  readonly attributes: ReadonlyMap<Element, readonly (readonly [string, string])[]>;
  readonly textValues: ReadonlyMap<Node, string | null>;
  readonly controlValues: ReadonlyMap<
    Element,
    Readonly<{ value: string; placeholder: string }>
  >;
  readonly selectValues: ReadonlyMap<
    HTMLSelectElement,
    Readonly<{
      selectedIndexes: readonly number[];
      host?: HTMLElement;
      hostAttributes?: readonly (readonly [string, string])[];
    }>
  >;
  readonly canvasElement?: Element;
  readonly canvasStyle: string | null;
  readonly canvasMarker: string | null;
}

/**
 * What a patch is about to change, to put back if it fails. `first`: the
 * snapshot of the frame's first patch, when this is a later one. What the
 * mirror keeps by id is put back as the frame found it: the nodes and the
 * text by their journals, the records because the frame changes them only
 * once it is applied (D165; the maps were copied whole for every frame).
 * The revision counter and the adopted styles are small, and copied.
 */
function capturePatchRollback(
  state: HtmlMirrorDomState,
  targets: readonly {
    readonly operation: Exclude<HtmlMirrorPatchOperation, { kind: 'dimensions' }>;
    readonly target: Node;
  }[],
  first?: PatchRollbackSnapshot,
): PatchRollbackSnapshot {
  const childLists = new Map<Node, readonly Node[]>();
  const attributes = new Map<Element, readonly (readonly [string, string])[]>();
  const textValues = new Map<Node, string | null>();
  const controlValues = new Map<
    Element,
    Readonly<{ value: string; placeholder: string }>
  >();
  const selectValues = new Map<
    HTMLSelectElement,
    Readonly<{
      selectedIndexes: readonly number[];
      host?: HTMLElement;
      hostAttributes?: readonly (readonly [string, string])[];
    }>
  >();
  const canvasElement = state.iframe.contentDocument?.documentElement;
  for (const { operation, target } of targets) {
    if (operation.kind === 'children' || operation.kind === 'reconcile-children') {
      childLists.set(target, Object.freeze([...sourceChildNodeList(target)]));
    } else if (operation.kind === 'attributes') {
      const element = target as Element;
      // The page's attributes: a restore writes them back as a patch does,
      // and what Simul shows over them is shown again (D124).
      attributes.set(
        element,
        Object.freeze(replicaPageAttributes(element).map(
          ([name, value]) => Object.freeze([name, value] as const),
        )),
      );
      // A link that is switched off is replaced by a new element: its
      // parent's list puts the old one back.
      const parent = sourceProperty(element, 'parentNode');
      if (
        parent && !childLists.has(parent) &&
        switchesReplicaLinkOff(element, operation.attributes)
      ) childLists.set(parent, Object.freeze([...sourceChildNodeList(parent)]));
      if (
        operation.resolvedStyleSheetText !== undefined &&
        sourceLocalName(element).toLowerCase() === 'style'
      ) {
        // The sheet's text is written into the element's text nodes.
        if (!childLists.has(element)) {
          childLists.set(element, Object.freeze([...sourceChildNodeList(element)]));
        }
        for (const child of sourceChildNodeList(element)) {
          if (sourceNodeType(child) === Node.TEXT_NODE) {
            textValues.set(child, child.nodeValue);
          }
        }
      }
      if (isNativeReplicaTextControl(element)) {
        controlValues.set(element, Object.freeze({
          value: element.value,
          placeholder: element.placeholder,
        }));
      } else if (sourceLocalName(element).toLowerCase() === 'select') {
        const select = element as HTMLSelectElement;
        const selectedIndexes: number[] = [];
        for (let index = 0; index < select.options.length; index += 1) {
          if (select.options.item(index)?.selected) selectedIndexes.push(index);
        }
        const host = isolatedSelectFacsimileHost(select);
        selectValues.set(select, Object.freeze({
          selectedIndexes: Object.freeze(selectedIndexes),
          ...(host
            ? {
                host,
                hostAttributes: Object.freeze([...sourceAttributeList(host)].map(
                  ({ name, value }) => Object.freeze([name, value] as const),
                )),
              }
            : {}),
        }));
      }
    } else if (operation.kind === 'text') {
      textValues.set(target, target.nodeValue);
    }
  }
  return {
    dimensions: first?.dimensions ?? state.dimensions,
    revisions: first?.revisions ?? new Map(state.revisions),
    ownedAdoptedStyles: first?.ownedAdoptedStyles ??
      new Set(state.ownedAdoptedStyles),
    childLists,
    attributes,
    textValues,
    controlValues,
    selectValues,
    ...(canvasElement ? { canvasElement } : {}),
    canvasStyle: canvasElement?.getAttribute('style') ?? null,
    canvasMarker: canvasElement?.getAttribute('data-simul-canvas-background') ?? null,
  };
}

function restorePatchRollback(
  state: HtmlMirrorDomState,
  snapshot: PatchRollbackSnapshot,
): void {
  for (const [target, children] of snapshot.childLists) {
    restoreChildList(target as ParentNode, children);
  }
  for (const [target, attributes] of snapshot.attributes) {
    restoreAttributeList(target, attributes);
    state.nodes.reclassify(target);
  }
  for (const [target, values] of snapshot.controlValues) {
    try {
      const control = target as HTMLInputElement | HTMLTextAreaElement;
      control.value = values.value;
      control.placeholder = values.placeholder;
    } catch {
      // Continue restoring every independent target before recovery.
    }
  }
  for (const [select, values] of snapshot.selectValues) {
    try {
      const selected = new Set(values.selectedIndexes);
      for (let index = 0; index < select.options.length; index += 1) {
        select.options.item(index)!.selected = selected.has(index);
      }
      if (!select.multiple) select.selectedIndex = values.selectedIndexes[0] ?? -1;
    } catch {
      // Recovery remains authoritative if a browser-owned select resists IDL restoration.
    }
    if (values.host && values.hostAttributes) {
      restoreAttributeList(values.host, values.hostAttributes);
    }
  }
  for (const [target, value] of snapshot.textValues) {
    try {
      target.nodeValue = value;
    } catch {
      // Continue restoring every independent target before recovery.
    }
  }
  if (snapshot.canvasElement) {
    restoreOptionalAttribute(snapshot.canvasElement, 'style', snapshot.canvasStyle);
    restoreOptionalAttribute(
      snapshot.canvasElement,
      'data-simul-canvas-background',
      snapshot.canvasMarker,
    );
  }
  state.dimensions = snapshot.dimensions;
  restoreMap(state.revisions, snapshot.revisions);
  restoreSet(state.ownedAdoptedStyles, snapshot.ownedAdoptedStyles);
}

function restoreOptionalAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  try {
    if (value === null) sourceCall(element, 'removeAttribute', name);
    else sourceCall(element, 'setAttribute', name, value);
  } catch {
    // Continue restoring independent state before requesting recovery.
  }
}

function restoreChildList(target: ParentNode, children: readonly Node[]): void {
  try {
    // A fragment, not an argument a child (D186): a list of more than about
    // 125,000 children passes the engine's limit on arguments.
    const fragment = (sourceProperty(target, 'ownerDocument') ?? (target as Document)).createDocumentFragment();
    for (const child of children) fragment.appendChild(child);
    sourceCall(target, 'replaceChildren', fragment);
    return;
  } catch {
    // Fall through to primitive operations so a host-level replaceChildren
    // failure cannot prevent restoration of this or later independent targets.
  }
  try {
    for (const child of [...sourceChildNodeList(target)]) sourceCall(target, 'removeChild', child);
    for (const child of children) sourceCall(target, 'appendChild', child);
  } catch {
    // A recovery checkpoint remains authoritative if the host DOM refuses
    // both restoration strategies.
  }
}

function restoreAttributeList(
  target: Element,
  attributes: readonly (readonly [string, string])[],
): void {
  try {
    setAttributes(target, attributes);
    return;
  } catch {
    // Try every primitive independently before allowing checkpoint recovery.
  }
  for (const attribute of [...sourceAttributeList(target)]) {
    try {
      sourceCall(target, 'removeAttribute', attribute.name);
    } catch {
      // Continue with remaining attributes and targets.
    }
  }
  forgetPageXmlLanguage(target);
  for (const [name, value] of inWriteOrder(attributes)) {
    try {
      writeReplicaAttribute(target, name, value);
    } catch {
      // Continue with remaining attributes and targets.
    }
  }
  try {
    finishReplicaAttributes(target);
  } catch {
    // A recovery checkpoint remains authoritative.
  }
}

function restoreMap<Key, Value>(
  target: Map<Key, Value>,
  source: ReadonlyMap<Key, Value>,
): void {
  target.clear();
  for (const [key, value] of source) target.set(key, value);
}

function restoreSet<Value>(target: Set<Value>, source: ReadonlySet<Value>): void {
  target.clear();
  for (const value of source) target.add(value);
}

function removeDomTree(state: HtmlMirrorDomState, node: Node): void {
  const ariaIndex = ISOLATED_ARIA_INDEXES.get(
    state.iframe.contentDocument ?? state.iframe.ownerDocument,
  );
  if (
    ariaIndex && !ariaIndex.dirty && sourceNodeType(node) === Node.ELEMENT_NODE
  ) {
    unregisterIsolatedAriaIndexElement(ariaIndex, node as Element);
  }
  for (const child of [...sourceChildNodeList(node)]) {
    removeDomTree(state, child);
  }
  if (sourceNodeType(node) === Node.ELEMENT_NODE) {
    const shadow = sourceProperty((node as Element), 'shadowRoot');
    if (shadow) removeDomTree(state, shadow);
  }
  if (state.ownedAdoptedStyles.has(node as HTMLStyleElement)) {
    state.ownedAdoptedStyles.delete(node as HTMLStyleElement);
  }
  // The records are left as they are: the frame builds new ones from the
  // text once it is applied, and keeps them as they were if it fails.
  const id = state.nodes.idOf(node);
  if (id !== undefined) {
    state.nodes.delete(id);
    state.textMetadata.delete(id);
    state.controlMetadata.delete(id);
  }
}

/**
 * Whether a child is a node of the mirror, or the box Simul draws a
 * mirrored dropdown in (`presentationNodeForMirrorNode`). Asked of the
 * child, instead of a set of every node of the mirror (D165).
 */
function isMirrorPresentationNode(nodes: ReplicaNodeMap, child: Node): boolean {
  if (nodes.hasNode(child)) return true;
  if (
    sourceNodeType(child) !== Node.ELEMENT_NODE ||
    !ISOLATED_SELECT_HOSTS.has(child as Element)
  ) return false;
  const shadow = sourceProperty((child as Element), 'shadowRoot');
  if (!shadow) return false;
  // The selects of the box's own tree, not of a root inside it.
  const pending: Node[] = [...sourceChildNodeList(shadow)];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (sourceNodeType(node) !== Node.ELEMENT_NODE) continue;
    if (
      sourceLocalName((node as Element)).toLowerCase() === 'select' &&
      nodes.hasNode(node)
    ) return true;
    for (const inner of sourceChildNodeList(node)) pending.push(inner);
  }
  return false;
}

/**
 * The bytes of text the mirror would keep after a patch: the maps' totals,
 * less the entries of the nodes it removes, with the entries it brings. The
 * patch's new ids are checked above to be none the mirror keeps, so its
 * entries only add to the totals; a text patch replaces an entry (D165).
 */
function prospectiveMetadataBytes(
  state: HtmlMirrorDomState,
  removedIds: ReadonlySet<number>,
  incomingText: ReadonlyMap<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
  incomingControls: ReadonlyMap<number, HtmlMirrorControlText>,
  parsedText: ReadonlyMap<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
): number {
  let bytes = state.textMetadata.bytes + state.controlMetadata.bytes;
  for (const id of removedIds) {
    const text = state.textMetadata.get(id);
    if (text) bytes -= replicaTextBytes(text);
    const control = state.controlMetadata.get(id);
    if (control) bytes -= replicaTextBytes(control);
  }
  const kept = (id: number): boolean => !removedIds.has(id);
  for (const [id, text] of incomingText) {
    const held = kept(id) ? state.textMetadata.get(id) : undefined;
    if (held) bytes -= replicaTextBytes(held);
    if (!parsedText.has(id)) bytes += replicaTextBytes(text);
  }
  for (const [id, control] of incomingControls) {
    const held = kept(id) ? state.controlMetadata.get(id) : undefined;
    if (held) bytes -= replicaTextBytes(held);
    bytes += replicaTextBytes(control);
  }
  for (const [id, text] of parsedText) {
    if (!incomingText.has(id)) {
      const held = kept(id) ? state.textMetadata.get(id) : undefined;
      if (held) bytes -= replicaTextBytes(held);
    }
    bytes += replicaTextBytes(text);
  }
  return bytes;
}

function collectTranslatableIds(node: HtmlMirrorNode, ids: Set<number>): void {
  if (node.kind === 'text') {
    if (node.translatable) ids.add(node.id);
    return;
  }
  if (node.controlText) ids.add(node.id);
  if (node.shadowRoot) {
    for (const child of node.shadowRoot.children) collectTranslatableIds(child, ids);
  }
  for (const child of node.children) collectTranslatableIds(child, ids);
}

interface DomContentContext {
  readonly privateRegion: boolean;
  readonly privateAttributeRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
  readonly nativeSelectRegion: boolean;
  readonly nativeSelectParent: false | 'select' | 'optgroup' | 'option';
}

const PUBLIC_DOM_CONTEXT: DomContentContext = Object.freeze({
  privateRegion: false,
  privateAttributeRegion: false,
  nonContentRegion: false,
  styleRegion: false,
  nativeSelectRegion: false,
  nativeSelectParent: false,
});

function presentationNodeForMirrorNode(node: Node): Node {
  if (sourceNodeType(node) === Node.ELEMENT_NODE) {
    const root = sourceCall(node, 'getRootNode');
    if (
      sourceNodeType(root) === Node.DOCUMENT_FRAGMENT_NODE &&
      'host' in root &&
      ISOLATED_SELECT_HOSTS.has((root as ShadowRoot).host)
    ) {
      const host = (root as ShadowRoot).host;
      if (sourceLocalName((node as Element)).toLowerCase() === 'select') return host;
    }
  }
  return node;
}

function isConnectedReplicaNode(state: HtmlMirrorDomState, node: Node): boolean {
  if (sourceProperty(node, 'ownerDocument') !== state.iframe.contentDocument) return false;
  let current = node;
  for (let depth = 0; depth <= 64; depth += 1) {
    if (sourceProperty(current, 'isConnected')) return true;
    const root = sourceNodeType(current) === Node.DOCUMENT_FRAGMENT_NODE &&
      'host' in current
      ? current as ShadowRoot
      : sourceCall(current, 'getRootNode');
    if (sourceNodeType(root) !== Node.DOCUMENT_FRAGMENT_NODE || !('host' in root)) {
      return false;
    }
    const shadow = root as ShadowRoot;
    if (sourceProperty(shadow.host, 'shadowRoot') !== shadow) return false;
    current = shadow.host;
  }
  return false;
}

function stableRetainedChildSet(
  oldChildren: readonly Node[],
  desiredChildren: readonly Node[],
  retainedChildren: ReadonlySet<Node>,
): ReadonlySet<Node> {
  const oldIndices = new Map<Node, number>();
  oldChildren.forEach((child, index) => oldIndices.set(child, index));
  const desiredRetained: Node[] = [];
  const oldOrder: number[] = [];
  for (const child of desiredChildren) {
    if (!retainedChildren.has(child)) continue;
    const oldIndex = oldIndices.get(child);
    if (oldIndex === undefined) continue;
    desiredRetained.push(child);
    oldOrder.push(oldIndex);
  }
  if (oldOrder.length === 0) return new Set();

  const predecessors = new Array<number>(oldOrder.length).fill(-1);
  const tailPositions: number[] = [];
  for (let index = 0; index < oldOrder.length; index += 1) {
    let low = 0;
    let high = tailPositions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (oldOrder[tailPositions[middle]!]! < oldOrder[index]!) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    if (low > 0) predecessors[index] = tailPositions[low - 1]!;
    tailPositions[low] = index;
  }

  const stable = new Set<Node>();
  let position = tailPositions.at(-1) ?? -1;
  while (position >= 0) {
    stable.add(desiredRetained[position]!);
    position = predecessors[position]!;
  }
  return stable;
}

/** `white-space-collapse` values, and `white-space` ones, that show a newline. */
const LINE_BREAKS_SHOWN = new Set([
  'preserve', 'preserve-breaks', 'break-spaces', 'pre', 'pre-wrap', 'pre-line',
]);

/** Whether the mirror shows the line breaks of the text in `element`. */
function elementShowsLineBreaks(element: Element | null | undefined): boolean {
  const view = element ? sourceProperty(element, 'ownerDocument').defaultView : undefined;
  if (!element || !view) return false;
  const style = view.getComputedStyle(element);
  const value = style.getPropertyValue('white-space-collapse') ||
    style.getPropertyValue('white-space');
  return LINE_BREAKS_SHOWN.has(value.trim());
}

function composedParentElement(node: Node): Element | undefined {
  const parentElement = sourceProperty(node, 'parentElement');
  if (parentElement) return parentElement;
  const root = sourceCall(node, 'getRootNode');
  return sourceNodeType(root) === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : undefined;
}

function containerContext(
  target: Node,
  pendingAttributes?: readonly (readonly [string, string])[],
): DomContentContext {
  if (sourceNodeType(target) === Node.ELEMENT_NODE) {
    const element = target as Element;
    if (!pendingAttributes) return domElementContext(element);
    const inherited = composedParentElement(element)
      ? domElementContext(composedParentElement(element) as Element)
      : PUBLIC_DOM_CONTEXT;
    const attributes = Object.fromEntries(pendingAttributes);
    const tagName = sourceLocalName(element).toLowerCase();
    return extendDomContentContext(inherited, tagName, attributes);
  }
  const host = sourceNodeType(target) === Node.DOCUMENT_FRAGMENT_NODE && 'host' in target
    ? (target as ShadowRoot).host
    : undefined;
  return host ? domElementContext(host) : PUBLIC_DOM_CONTEXT;
}

function batchContainerContext(
  target: Node,
  pending: ReadonlyMap<
    number,
    Extract<HtmlMirrorPatchOperation, { kind: 'attributes' }>
  >,
  nodeIds: ReadonlyMap<Node, number>,
): DomContentContext {
  let element = sourceNodeType(target) === Node.ELEMENT_NODE
    ? target as Element
    : sourceNodeType(target) === Node.DOCUMENT_FRAGMENT_NODE && 'host' in target
      ? (target as ShadowRoot).host
      : undefined;
  if (!element) return PUBLIC_DOM_CONTEXT;
  const chain: Element[] = [];
  for (; element; element = composedParentElement(element)) chain.push(element);
  let context = PUBLIC_DOM_CONTEXT;
  for (const current of chain.reverse()) {
    const nodeId = nodeIds.get(current);
    const attributes = nodeId === undefined
      ? undefined
      : pending.get(nodeId)?.attributes;
    const values = attributes
      ? Object.fromEntries(attributes)
      : Object.fromEntries(
          [...sourceAttributeList(current)].map(({ name, value }) => [name, value]),
        );
    const tagName = sourceLocalName(current).toLowerCase();
    context = extendDomContentContext(context, tagName, values);
  }
  return context;
}

function domTextContext(node: Node): DomContentContext {
  const parent = composedParentElement(node);
  return parent
    ? domElementContext(parent)
    : PUBLIC_DOM_CONTEXT;
}

function privacyContextChanges(
  current: DomContentContext,
  prospective: DomContentContext,
): boolean {
  return current.privateRegion !== prospective.privateRegion ||
    current.privateAttributeRegion !== prospective.privateAttributeRegion;
}

function domElementContext(element: Element): DomContentContext {
  const chain: Element[] = [];
  for (
    let current: Element | undefined = element;
    current;
    current = composedParentElement(current)
  ) chain.push(current);
  let context = PUBLIC_DOM_CONTEXT;
  for (const current of chain.reverse()) {
    const tagName = sourceLocalName(current).toLowerCase();
    const attributes = Object.fromEntries(
      [...sourceAttributeList(current)].map(({ name, value }) => [name, value]),
    );
    context = extendDomContentContext(context, tagName, attributes);
  }
  return context;
}

function isNativeSelectSemanticGraphTag(tagName: string): boolean {
  return tagName === 'select' || tagName === 'optgroup' || tagName === 'option';
}

function validNativeSelectGraphPlacement(
  node: Extract<HtmlMirrorNode, { kind: 'element' }>,
  parent: DomContentContext['nativeSelectParent'],
): boolean {
  if (isNativeSelectSemanticGraphTag(node.tagName) && node.namespace !== 'html') {
    return false;
  }
  if (parent === 'select' && node.tagName !== 'option' && node.tagName !== 'optgroup') {
    return false;
  }
  if (parent === 'optgroup' && node.tagName !== 'option') return false;
  if (parent === 'option') return false;
  return node.tagName !== 'option' || node.children.length === 0;
}

function validNativeSelectLabelPlacement(
  tagName: string,
  parent: DomContentContext['nativeSelectParent'],
): boolean {
  return tagName === 'option'
    ? parent === 'select' || parent === 'optgroup'
    : tagName === 'optgroup' && parent === 'select';
}

function nextDomNativeSelectParent(
  tagName: string,
  parent: DomContentContext['nativeSelectParent'],
): DomContentContext['nativeSelectParent'] {
  if (tagName === 'select') return 'select';
  if (tagName === 'optgroup' && parent === 'select') return 'optgroup';
  if (
    tagName === 'option' &&
    (parent === 'select' || parent === 'optgroup')
  ) return 'option';
  return false;
}

/** A `<style>`, `<link>` or `<head>` of the replica: a change in it may change a sheet (D204). */
function holdsReplicaSheet(node: Node | null | undefined): boolean {
  if (!node || sourceNodeType(node) !== Node.ELEMENT_NODE) return false;
  const name = sourceLocalName(node as Element);
  return name === 'style' || name === 'link' || name === 'head';
}

/** Whether a child a patch brings is a `<style>` or `<link>` (D204). */
function bringsReplicaSheet(child: HtmlMirrorNode | HtmlMirrorReconcileChild): boolean {
  const node = child.kind === 'graph' ? child.node : child;
  return node.kind === 'element' && (node.tagName === 'style' || node.tagName === 'link');
}

/**
 * The text a `<style>` element's sheet is made of: the text of its light-DOM
 * children, in order. Validating each text node on its own is not enough: two
 * nodes that each pass can be read by the browser as one `@import` or one
 * `expression(`, so the sheet's own text is checked as one text (R1).
 */
function collectStyleSheetText(
  children: readonly HtmlMirrorNode[],
  parts: string[],
): void {
  for (const child of children) {
    if (child.kind === 'text') parts.push(child.text);
    else collectStyleSheetText(child.children, parts);
  }
}

function styleSheetTextIsFixedPoint(
  text: string,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  return sanitizeCss(text, 'about:blank', false, undefined, fidelityPolicy) ===
    text;
}

function validStyleSheetTextForChildren(
  children: readonly HtmlMirrorNode[],
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  const parts: string[] = [];
  collectStyleSheetText(children, parts);
  return styleSheetTextIsFixedPoint(parts.join(''), fidelityPolicy);
}

/** Every `<style>` in a graph, its own text re-validated as one sheet. */
function validStyleSheetTextInGraph(
  node: HtmlMirrorNode,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  if (node.kind === 'text') return true;
  if (
    node.tagName === 'style' &&
    !validStyleSheetTextForChildren(node.children, fidelityPolicy)
  ) return false;
  return node.children.every(
    (child) => validStyleSheetTextInGraph(child, fidelityPolicy),
  ) && (!node.shadowRoot || node.shadowRoot.children.every(
    (child) => validStyleSheetTextInGraph(child, fidelityPolicy),
  ));
}

/**
 * The nearest `<style>` a text node is part of, through elements a script
 * may have put inside it. The browser makes the sheet from the style's whole
 * light-DOM text, however it is nested (R1).
 */
function owningStyleElement(node: Node): Element | undefined {
  for (
    let current: Node | null = sourceProperty(node, 'parentNode');
    current;
    current = sourceProperty(current, 'parentNode')
  ) {
    if (
      sourceNodeType(current) === Node.ELEMENT_NODE &&
      sourceLocalName((current as Element)).toLowerCase() === 'style'
    ) return current as Element;
  }
  return undefined;
}

/** The style's sheet text as it will be after the frame's text patches. */
function collectStyleSheetDomText(
  parent: Node,
  replacements: ReadonlyMap<Text, string>,
  parts: string[],
): void {
  for (const child of sourceChildNodeList(parent)) {
    if (sourceNodeType(child) === Node.TEXT_NODE) {
      parts.push(replacements.get(child as Text) ?? child.nodeValue ?? '');
    } else {
      collectStyleSheetDomText(child, replacements, parts);
    }
  }
}

/**
 * Validates the joined text of every style the frame's text operations
 * touch, after all of them. Each text node can pass on its own while two
 * of them assemble an `@import` or an `expression(`, and a frame is atomic:
 * the check must see the text the batch leaves, not one node against its
 * pre-batch siblings (R1).
 */
function validFrameStyleSheetText(
  state: HtmlMirrorDomState,
  parts: readonly (readonly HtmlMirrorPatchOperation[])[],
): boolean {
  const replacements = new Map<Text, string>();
  for (const operations of parts) {
    for (const operation of operations) {
      if (operation.kind !== 'text') continue;
      const target = state.nodes.get(operation.nodeId);
      if (target != null && sourceNodeType(target) === Node.TEXT_NODE) {
        replacements.set(target as Text, operation.node.text);
      }
    }
  }
  if (replacements.size === 0) return true;
  const styles = new Set<Element>();
  for (const target of replacements.keys()) {
    const style = owningStyleElement(target);
    if (style) styles.add(style);
  }
  for (const style of styles) {
    const textParts: string[] = [];
    collectStyleSheetDomText(style, replacements, textParts);
    if (!styleSheetTextIsFixedPoint(
      textParts.join(''),
      state.fidelityPolicy,
    )) return false;
  }
  return true;
}

/**
 * Notes the styles a frame could have changed, read after the frame is
 * applied: a text operation's own style, and every style the graph of a
 * structural operation brought. A retained node's text did not change, but a
 * text operation on a node an earlier part created is only visible now.
 */
function noteFrameStyleSheetTargets(
  state: HtmlMirrorDomState,
  node: HtmlMirrorNode,
  styles: Set<Element>,
): void {
  if (node.kind === 'text') {
    const text = state.nodes.get(node.id);
    const style = text ? owningStyleElement(text) : undefined;
    if (style) styles.add(style);
    return;
  }
  const element = state.nodes.get(node.id);
  if (
    (element != null && sourceNodeType(element) === Node.ELEMENT_NODE) &&
    sourceLocalName((element as Element)).toLowerCase() === 'style'
  ) styles.add(element as Element);
  for (const child of node.children) {
    noteFrameStyleSheetTargets(state, child, styles);
  }
  if (node.shadowRoot) {
    for (const child of node.shadowRoot.children) {
      noteFrameStyleSheetTargets(state, child, styles);
    }
  }
}

/**
 * After the last part, a style the frame touched must still hold a sheet
 * that is a fixed point. The pre-frame check cannot see text nodes an earlier
 * part inserted or created; only the applied frame can (R1).
 */
function validFrameStyleSheetTextAfterApply(
  state: HtmlMirrorDomState,
  parts: readonly (readonly HtmlMirrorPatchOperation[])[],
): boolean {
  const styles = new Set<Element>();
  for (const operations of parts) {
    for (const operation of operations) {
      if (operation.kind === 'dimensions') continue;
      const target = state.nodes.get(operation.nodeId);
      if (operation.kind === 'text') {
        const style = target ? owningStyleElement(target) : undefined;
        if (style) styles.add(style);
        continue;
      }
      if (
        operation.kind === 'attributes' &&
        (target != null && sourceNodeType(target) === Node.ELEMENT_NODE) &&
        sourceLocalName((target as Element)).toLowerCase() === 'style'
      ) {
        styles.add(target as Element);
        continue;
      }
      if (operation.kind === 'children') {
        if ((target != null && sourceNodeType(target) === Node.ELEMENT_NODE) &&
            sourceLocalName((target as Element)).toLowerCase() === 'style') {
          styles.add(target as Element);
        }
        for (const child of operation.children) {
          noteFrameStyleSheetTargets(state, child, styles);
        }
        continue;
      }
      if (operation.kind === 'reconcile-children') {
        if ((target != null && sourceNodeType(target) === Node.ELEMENT_NODE) &&
            sourceLocalName((target as Element)).toLowerCase() === 'style') {
          styles.add(target as Element);
        }
        for (const entry of operation.children) {
          if (entry.kind === 'graph') {
            noteFrameStyleSheetTargets(state, entry.node, styles);
          }
        }
      }
    }
  }
  for (const style of styles) {
    const textParts: string[] = [];
    collectStyleSheetDomText(style, new Map<Text, string>(), textParts);
    if (!styleSheetTextIsFixedPoint(
      textParts.join(''),
      state.fidelityPolicy,
    )) return false;
  }
  return true;
}

function validGraphForContext(
  node: HtmlMirrorNode,
  inherited: DomContentContext,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  if (node.kind === 'text') {
    return inherited.nativeSelectParent === false &&
      validTextForContext(node, inherited, fidelityPolicy);
  }
  if (!validNativeSelectGraphPlacement(node, inherited.nativeSelectParent)) {
    return false;
  }
  const attributes = Object.fromEntries(node.attributes);
  const context = extendDomContentContext(inherited, node.tagName, attributes);
  return (
    !context.privateAttributeRegion ||
    !hasPrivateHtmlMirrorAttribute(node.tagName, node.attributes)
  ) &&
    (!context.privateAttributeRegion || !node.controlText) &&
    (!context.privateAttributeRegion || node.selectedOptionIndexes === undefined) &&
    (!context.privateAttributeRegion || node.selectPickerOpen === undefined) &&
    (!node.controlText || node.controlText.kind !== 'label' ||
      validNativeSelectLabelPlacement(node.tagName, inherited.nativeSelectParent)) &&
    (!isNativeSelectSemanticGraphTag(node.tagName) || !node.shadowRoot) &&
    (node.tagName !== 'style' ||
      validStyleSheetTextForChildren(node.children, fidelityPolicy)) &&
    node.children.every(
      (child) => validGraphForContext(child, context, fidelityPolicy),
    ) &&
    (!node.shadowRoot || node.shadowRoot.children.every(
      (child) => validGraphForContext(child, context, fidelityPolicy),
    ));
}

function extendDomContentContext(
  inherited: DomContentContext,
  tagName: string,
  attributes: Readonly<Record<string, string>>,
): DomContentContext {
  const currentPrivate = sourceElementStartsPrivateRegionInContext(
    tagName,
    attributes,
    inherited.nativeSelectParent === 'select' ||
      inherited.nativeSelectParent === 'optgroup',
  );
  const privateRegion = inherited.privateRegion || currentPrivate;
  return {
    privateRegion,
    privateAttributeRegion: inherited.privateAttributeRegion ||
      privateRegion ||
      isSourceActivationTagName(tagName) ||
      isSourceActivationRoleValue(attributes.role) ||
      (!isNativeSelectSemanticGraphTag(tagName) &&
        isSourcePublicMenuRoleValue(attributes.role)),
    nonContentRegion: inherited.nonContentRegion ||
      tagName === 'head' || tagName === 'style' || tagName === 'title',
    styleRegion: inherited.styleRegion || tagName === 'style',
    nativeSelectRegion: inherited.nativeSelectRegion ||
      (tagName === 'select' && !privateRegion),
    nativeSelectParent: nextDomNativeSelectParent(
      tagName,
      inherited.nativeSelectParent,
    ),
  };
}

function validTextForContext(
  node: Extract<HtmlMirrorNode, { kind: 'text' }>,
  context: DomContentContext,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  return (!context.privateRegion || node.text === '') &&
    (!(context.privateRegion || context.nonContentRegion) || !node.translatable) &&
    (!context.styleRegion || sanitizeCss(
      node.text,
      'about:blank',
      false,
      undefined,
      fidelityPolicy,
    ) === node.text);
}

function collectDomIds(
  nodeIds: ReadonlyMap<Node, number>,
  node: Node,
  ids: Set<number>,
): void {
  const id = nodeIds.get(node);
  if (id !== undefined) ids.add(id);
  for (const child of [...sourceChildNodeList(node)]) collectDomIds(nodeIds, child, ids);
  if (sourceNodeType(node) === Node.ELEMENT_NODE) {
    const shadow = sourceProperty((node as Element), 'shadowRoot');
    if (shadow) collectDomIds(nodeIds, shadow, ids);
  }
}

function collectGraphIds(node: HtmlMirrorNode, ids: Set<number>): boolean {
  if (ids.has(node.id)) return false;
  ids.add(node.id);
  if (node.kind === 'text') return true;
  if (node.shadowRoot) {
    if (ids.has(node.shadowRoot.id)) return false;
    ids.add(node.shadowRoot.id);
    if (!node.shadowRoot.children.every((child) => collectGraphIds(child, ids))) {
      return false;
    }
  }
  return node.children.every((child) => collectGraphIds(child, ids));
}

function collectGraphTextState(
  node: HtmlMirrorNode,
  text: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
  controls: Map<number, HtmlMirrorControlText>,
): void {
  if (node.kind === 'text') {
    text.set(node.id, node);
    return;
  }
  if (node.controlText) controls.set(node.id, node.controlText);
  else controls.delete(node.id);
  for (const child of node.children) collectGraphTextState(child, text, controls);
  for (const child of node.shadowRoot?.children ?? []) {
    collectGraphTextState(child, text, controls);
  }
}

function checkpointChanges(
  state: HtmlMirrorDomState,
  previous?: HtmlMirrorDomState,
): readonly ReplicaSourceTextChange[] {
  const changes: ReplicaSourceTextChange[] = [...state.records.values()].map(
    (record) => Object.freeze({ kind: 'upsert' as const, record }),
  );
  if (previous && sameSourceDocument(previous.document, state.document)) {
    for (const record of previous.records.values()) {
      if (state.records.has(record.nodeId)) continue;
      const revision = nextRevision(state.revisions, record.nodeId);
      changes.push(Object.freeze({
        kind: 'remove' as const,
        document: state.document,
        nodeId: record.nodeId,
        revision,
      }));
    }
  }
  return Object.freeze(changes);
}

function changesDocumentLanguage(batch: HtmlMirrorPatchBatch): boolean {
  return batch.operations.some(
    (operation) => operation.kind === 'attributes' && operation.tagName === 'html',
  );
}

function hasSemanticReadScope(scope: ReplicaReadScope): boolean {
  return scope.controlSemantics || scope.disclosureContent ||
    scope.formValues || scope.personalDataValues || scope.editableContent;
}

function sourceChangeNodeId(change: ReplicaSourceTextChange): number {
  return change.kind === 'remove' ? change.nodeId : change.record.nodeId;
}

function hideTranslatedLanguage(state: HtmlMirrorDomState, nodeId: number): void {
  const element = state.languages.hide(nodeId);
  // The select facsimile draws an option's label with the option's language.
  if (
    element &&
    isNativeSelectSemanticGraphTag(sourceLocalName(element).toLowerCase())
  ) syncContainingIsolatedSelectFacsimile(element);
}

/**
 * The page's `lang` and `xml:lang` on each element an attribute patch is
 * about to rewrite.
 */
function patchedPageLanguages(
  state: HtmlMirrorDomState,
  operations: readonly HtmlMirrorPatchOperation[],
): readonly (readonly [Element, string | null, string | null])[] {
  const languages: (readonly [Element, string | null, string | null])[] = [];
  for (const operation of operations) {
    if (operation.kind !== 'attributes') continue;
    const target = state.nodes.get(operation.nodeId);
    if (target == null || sourceNodeType(target) !== Node.ELEMENT_NODE) continue;
    const element = target as Element;
    languages.push([
      element,
      pageAttribute(element, 'lang'),
      pageXmlLanguage(element),
    ]);
  }
  return languages;
}

function synchronizeIsolatedPaintedLabel(
  state: HtmlMirrorDomState,
  nodeId: number,
  node: Text,
  translatedText: string,
): void {
  const host = node.parentElement;
  const previous = state.paintedLabelHosts.get(nodeId);
  if (previous && previous !== host) clearIsolatedPaintedLabel(state, nodeId);
  if (!host) return;
  const hostText = aggregatePaintedSemanticLabelText(host) ?? translatedText;
  if (synchronizePaintedSemanticLabelPresentation(host, hostText)) {
    state.paintedLabelHosts.set(nodeId, host);
    return;
  }
  clearIsolatedPaintedLabelHost(state, host);
}

function clearIsolatedPaintedLabel(
  state: HtmlMirrorDomState,
  nodeId: number,
): void {
  const host = state.paintedLabelHosts.get(nodeId);
  if (host) clearIsolatedPaintedLabelHost(state, host);
}

function clearIsolatedPaintedLabelHost(
  state: HtmlMirrorDomState,
  host: HTMLElement,
): void {
  removePaintedSemanticLabelPresentation(host);
  for (const [nodeId, candidate] of state.paintedLabelHosts) {
    if (candidate === host) state.paintedLabelHosts.delete(nodeId);
  }
}

function clearIsolatedPaintedLabels(state: HtmlMirrorDomState): void {
  const hosts = new Set(state.paintedLabelHosts.values());
  state.paintedLabelHosts.clear();
  for (const host of hosts) removePaintedSemanticLabelPresentation(host);
}

function reconcileIsolatedPaintedLabels(
  state: HtmlMirrorDomState,
  projections: ReadonlyMap<number, ReplicaTextProjection>,
  nodeIds: readonly number[],
): void {
  for (const nodeId of new Set(nodeIds)) {
    const projection = projections.get(nodeId);
    const record = state.records.get(nodeId);
    const node = state.nodes.get(nodeId);
    if (
      !projection || !record || projection.nodeType !== 3 ||
      record.nodeType !== 3 || (node == null || sourceNodeType(node) !== Node.TEXT_NODE) ||
      record.source !== projection.source ||
      record.revision !== projection.sourceRevision
    ) continue;
    synchronizeIsolatedPaintedLabel(
      state,
      nodeId,
      node as Text,
      projection.translated,
    );
  }
}

function readDocumentLanguage(state: HtmlMirrorDomState): string | undefined {
  const value = state.root?.getAttribute('lang')?.trim();
  return value && value.length <= 128 ? value : undefined;
}

/**
 * The panel keeps the previous replica while it stages the next one, so
 * the replica it keeps, Simul's own nodes with it, is held to four times
 * the page budget, and its nodes to three times. Checked after every patch:
 * the ledger counts what each change added and removed, and the full walk
 * answers only when the replica is near a limit or every so often (D165;
 * it was a walk of every node after every patch).
 */
function retainedReplicaStateFitsBudget(state: HtmlMirrorDomState): boolean {
  try {
    const document = state.iframe.contentDocument;
    const root = document?.documentElement;
    if (!document || !root) return false;
    const maxBytes = MAX_HTML_MIRROR_BYTES * 4;
    const maxNodes = MAX_HTML_MIRROR_NODES * 3 + 32;
    const metadataBytes = state.textMetadata.bytes + state.controlMetadata.bytes +
      ownedSheetTotals(document).bytes;
    let ledger = state.ledger;
    if (ledger && ledger.root !== root) {
      releaseRetainedLedger(state);
      ledger = undefined;
    }
    if (!ledger) {
      const Observer = document.defaultView?.MutationObserver ??
        globalThis.MutationObserver;
      if (!Observer) {
        const walked = walkRetainedReplica(
          root,
          state.ownedAdoptedStyles,
          maxBytes,
          maxNodes,
        );
        return Boolean(walked) &&
          walked!.bytes + metadataBytes <= maxBytes &&
          state.revisions.size <= 1;
      }
      ledger = new RetainedReplicaLedger({
        root,
        ownedAdoptedStyles: state.ownedAdoptedStyles,
        MutationObserver: Observer,
      });
      state.ledger = ledger;
      // The ARIA index follows the ledger from here. Until now it was kept
      // in step by the patches, or marked to be read again, so it describes
      // the replica the ledger starts from.
      RETAINED_LEDGERS.set(document, ledger);
    }
    return ledger.fits(metadataBytes, maxBytes, maxNodes) &&
      state.revisions.size <= 1;
  } catch {
    return false;
  }
}

function releaseRetainedLedger(state: HtmlMirrorDomState): void {
  const ledger = state.ledger;
  if (!ledger) return;
  state.ledger = undefined;
  ledger.dispose();
  const document = state.iframe.contentDocument;
  if (document && RETAINED_LEDGERS.get(document) === ledger) {
    RETAINED_LEDGERS.delete(document);
  }
}

function nextRevision(revisions: Map<number, number>, _nodeId: number): number {
  const next = (revisions.get(0) ?? 0) + 1;
  const revision = Number.isSafeInteger(next) ? next : 1;
  revisions.set(0, revision);
  return revision;
}

function protectIframe(iframe: HTMLIFrameElement): void {
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.removeAttribute('inert');
  iframe.setAttribute(
    'data-simul-interaction-boundary',
    ISOLATED_DISCLOSURE_IFRAME_MARKER,
  );
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.setProperty('pointer-events', 'auto', 'important');
  iframe.style.border = '0';
}

/**
 * The iframe contains no website code. These parent-installed guards make the
 * sole pointer-enabled surface disclosure-only. Only Simul-marked local
 * triggers/panels bypass activation blocking; website nodes remain inert.
 */
function installIsolatedDisclosureGuards(
  document: Document,
  iframe: HTMLIFrameElement,
  onFileDrop?: (files: readonly File[]) => void,
): () => void {
  // Files dragged from the computer go to the panel, never into the frame.
  // Registered before the activation guard, which stops every later drop
  // listener.
  const onFileDrag = (event: DragEvent): void => {
    const transfer = event.dataTransfer;
    if (!transfer?.types.includes('Files')) return;
    if (event.cancelable) event.preventDefault();
    if (event.type === 'dragover') {
      transfer.dropEffect = onFileDrop ? 'copy' : 'none';
      return;
    }
    // Re-made in the panel's realm: opening the file releases this frame, and
    // a read started on the frame's own File would never settle after that.
    onFileDrop?.([...transfer.files].map((file) => new File([file], file.name, {
      type: file.type,
      lastModified: file.lastModified,
    })));
  };
  document.addEventListener('dragover', onFileDrag, true);
  document.addEventListener('drop', onFileDrag, true);
  for (const type of ISOLATED_DISCLOSURE_BLOCKED_EVENTS) {
    document.addEventListener(type, blockIsolatedDisclosureActivation, true);
  }
  const onWheel = (event: WheelEvent): void => {
    if (isReadOnlyReplicaDisclosureEvent(event)) return;
    const scroller = iframe.parentElement?.closest('.replica-replay-scroll');
    if (!(scroller instanceof HTMLElement)) return;
    const factor = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? Math.max(1, scroller.clientHeight)
        : 1;
    scroller.scrollLeft += event.deltaX * factor;
    scroller.scrollTop += event.deltaY * factor;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    document.removeEventListener('dragover', onFileDrag, true);
    document.removeEventListener('drop', onFileDrag, true);
    for (const type of ISOLATED_DISCLOSURE_BLOCKED_EVENTS) {
      document.removeEventListener(type, blockIsolatedDisclosureActivation, true);
    }
    document.removeEventListener('wheel', onWheel, true);
  };
}

function blockIsolatedDisclosureActivation(event: Event): void {
  // This guard is deliberately document-wide. Passive source CSS is allowed
  // for fidelity and can beat a pointer-events cascade, but it must never turn
  // an anchor, form, control, or arbitrary source node into an active surface.
  // The bypass marker is written only after receiver validation.
  if (isReadOnlyReplicaDisclosureEvent(event)) return;
  // Tab only moves focus, and focus must be able to leave: a screen reader
  // puts it on a mirror link or control, and with every key cancelled it
  // stayed there (D118).
  if (isFocusMoveKeyEvent(event)) return;
  const currentTarget = event.currentTarget;
  if (
    currentTarget && 'nodeType' in currentTarget &&
    currentTarget.nodeType === Node.DOCUMENT_NODE &&
    !isReadOnlyReplicaDisclosurePressEcho(event)
  ) closeReadOnlyReplicaDisclosures(currentTarget as Document);
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

function isFocusMoveKeyEvent(event: Event): boolean {
  return (
    event.type === 'keydown' || event.type === 'keypress' || event.type === 'keyup'
  ) && (event as KeyboardEvent).key === 'Tab';
}

/**
 * `writtenFromUrl` is the panel's URL for a shell written into a blank frame,
 * which takes its writer's URL; otherwise only an `srcdoc` shell is trusted.
 */
export function isTrustedIsolatedShellDocument(
  document: Document | null | undefined,
  writtenFromUrl?: string,
): document is Document {
  if (!document?.head || !document.body) return false;
  const href = document.location?.href;
  if (
    typeof href === 'string' &&
    href.length > 0 &&
    href !== (writtenFromUrl ?? 'about:srcdoc')
  ) {
    return false;
  }
  const marker = document.head.querySelector(
    'meta[name="simul-isolated-shell"][data-simul-owned-shell="marker"]',
  );
  const csp = document.head.querySelector(
    'meta[http-equiv="Content-Security-Policy"][data-simul-owned-shell="csp"]',
  );
  const inertStyle = document.head.querySelector(
    'style[data-simul-owned-shell="inert"]',
  );
  const policy = csp?.getAttribute('content') ?? '';
  return marker?.getAttribute('content') === ISOLATED_HTML_SHELL_MARKER &&
    policy.includes("script-src 'none'") &&
    policy.includes("connect-src 'none'") &&
    Boolean(inertStyle);
}

/**
 * An `srcdoc` document is always in no-quirks mode, whatever its doctype. A
 * quirks source's replica is therefore a blank frame whose doctype-free shell
 * is written from here, which leaves it in quirks mode like the source; a
 * limited-quirks source's shell carries the XHTML 1.0 Transitional doctype
 * (D97). The frame keeps the same sandbox and shell CSP; written from the
 * panel, it takes the panel's URL, the base URL an `srcdoc` shell inherits
 * anyway.
 */
function writeQuirksIframeDocument(
  iframe: HTMLIFrameElement,
  mount: HTMLElement,
  shell: string,
  mode: 'quirks' | 'limited-quirks',
): Document {
  sourceCall(mount, 'append', iframe);
  const iframeDocument = iframe.contentDocument;
  if (!iframeDocument) throw new Error('Isolated iframe document unavailable.');
  iframeDocument.open();
  iframeDocument.write(trustedShellHtml(shell));
  iframeDocument.close();
  if (
    !isTrustedIsolatedShellDocument(
      iframeDocument,
      sourceProperty(mount, 'ownerDocument').location.href,
    ) ||
    (mode === 'quirks'
      ? iframeDocument.compatMode !== 'BackCompat'
      : iframeDocument.compatMode !== 'CSS1Compat' ||
        iframeDocument.doctype?.publicId !==
          ISOLATED_HTML_LIMITED_QUIRKS_DOCTYPE_PUBLIC_ID)
  ) throw new Error('Isolated quirks shell was not written.');
  return iframeDocument;
}

async function initializeIframeDocument(
  iframe: HTMLIFrameElement,
  mount: HTMLElement,
  shell: string,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<Document> {
  signal?.throwIfAborted();
  const iframeDocument = await new Promise<Document>((resolve, reject) => {
    let settled = false;
    const finish = (document?: Document, error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      iframe.removeEventListener('load', onLoad);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else if (document) resolve(document);
      else reject(new Error('Isolated iframe document unavailable.'));
    };
    const onLoad = (): void => {
      const candidate = iframe.contentDocument;
      // Chrome can dispatch an initial about:blank load before replacing it
      // with srcdoc. Only the cryptographically local shell marker is ready.
      if (isTrustedIsolatedShellDocument(candidate)) finish(candidate);
    };
    const onAbort = (): void => finish(
      undefined,
      signal?.reason ?? new DOMException('HTML mirror cancelled.', 'AbortError'),
    );
    const timer = setTimeout(
      () => finish(
        undefined,
        new Error('Isolated iframe initialization timed out.'),
      ),
      deadlineMs,
    );
    iframe.addEventListener('load', onLoad);
    signal?.addEventListener('abort', onAbort, { once: true });
    iframe.srcdoc = trustedShellHtml(shell);
    sourceCall(mount, 'append', iframe);
  });
  return iframeDocument;
}

function measureExtent(iframe: HTMLIFrameElement): VisibleReplayExtent {
  const target = iframe.contentDocument;
  const html = target?.documentElement;
  const body = target?.body;
  return {
    width: Math.max(1, html?.scrollWidth ?? 0, body?.scrollWidth ?? 0),
    height: Math.max(1, html?.scrollHeight ?? 0, body?.scrollHeight ?? 0),
  };
}

async function settleReplicaStyles(
  target: Document,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<ReplicaStyleReadiness> {
  signal?.throwIfAborted();
  const boundedDeadline = Number.isFinite(deadlineMs)
    ? Math.max(0, Math.min(2_000, deadlineMs))
    : 300;
  const deadlineAt = Date.now() + boundedDeadline;
  const links = collectReplicaStylesheetLinks(target);
  let loaded = 0;
  let errors = 0;
  const pending: Element[] = [];
  for (const link of links) {
    if (hasLoadedStylesheet(link)) loaded += 1;
    else pending.push(link);
  }

  const unresolved = new Set(pending);
  if (unresolved.size > 0 && deadlineAt > Date.now()) {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        for (const link of pending) {
          sourceCall(link, 'removeEventListener', 'load', onLoad);
          sourceCall(link, 'removeEventListener', 'error', onError);
        }
        signal?.removeEventListener('abort', onAbort);
        if (timer !== undefined) clearTimeout(timer);
      };
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const settleLink = (event: Event, failed: boolean): void => {
        const link = event.currentTarget as Element | null;
        if (!link || !unresolved.delete(link)) return;
        if (failed) errors += 1;
        else loaded += 1;
        if (unresolved.size === 0) finish();
      };
      const onLoad = (event: Event): void => settleLink(event, false);
      const onError = (event: Event): void => settleLink(event, true);
      const onAbort = (): void => finish(
        signal?.reason ?? new DOMException('Style settling cancelled.', 'AbortError'),
      );
      for (const link of pending) {
        sourceCall(link, 'addEventListener', 'load', onLoad, { once: true });
        sourceCall(link, 'addEventListener', 'error', onError, { once: true });
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        finish(
          signal.reason ??
            new DOMException('Style settling cancelled.', 'AbortError'),
        );
        return;
      }
      // A stylesheet can become ready after the first sheet check but before
      // its load listener is installed. Recheck only after every listener is
      // active so that neither side of that race can strand the candidate.
      for (const link of pending) {
        if (!unresolved.has(link) || !hasLoadedStylesheet(link)) continue;
        unresolved.delete(link);
        loaded += 1;
      }
      if (unresolved.size === 0) {
        finish();
        return;
      }
      const remaining = Math.max(0, deadlineAt - Date.now());
      if (remaining === 0) {
        finish();
        return;
      }
      timer = setTimeout(() => finish(), remaining);
    });
  }
  signal?.throwIfAborted();
  await waitForReplicaPaint(target, deadlineAt, signal);
  await waitForReplicaPaint(target, deadlineAt, signal);
  return Object.freeze({
    stylesheetLinkCount: links.length,
    stylesheetLoadedCount: loaded,
    stylesheetErrorCount: errors,
    stylesheetTimedOutCount: unresolved.size,
  });
}

function collectReplicaStylesheetLinks(target: Document): Element[] {
  const links = new Set<Element>();
  const visited = new Set<Document | ShadowRoot>();
  const visit = (root: Document | ShadowRoot): void => {
    if (visited.has(root)) return;
    visited.add(root);
    for (const link of root.querySelectorAll('link[rel~="stylesheet"]')) {
      links.add(link);
    }
    for (const element of root.querySelectorAll('*')) {
      const shadow = sourceProperty(element, 'shadowRoot');
      if (shadow) visit(shadow);
    }
  };
  visit(target);
  return [...links];
}

function hasLoadedStylesheet(link: Element): boolean {
  try {
    return Boolean((link as HTMLLinkElement).sheet);
  } catch {
    return false;
  }
}

async function waitForReplicaPaint(
  target: Document,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const remaining = Math.max(0, deadlineAt - Date.now());
  if (remaining === 0) return;
  const view = target.defaultView;
  if (!view || typeof view.requestAnimationFrame !== 'function') {
    await Promise.resolve();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let frame: number | undefined;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (frame !== undefined && error) view.cancelAnimationFrame(frame);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = (): void => finish(
      signal?.reason ?? new DOMException('Style settling cancelled.', 'AbortError'),
    );
    const timer = setTimeout(() => finish(), Math.min(50, remaining));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      finish(
        signal.reason ??
          new DOMException('Style settling cancelled.', 'AbortError'),
      );
      return;
    }
    frame = view.requestAnimationFrame(() => finish());
  });
}

function installStateLayoutObservers(
  state: HtmlMirrorDomState,
  onLayout: () => void,
): void {
  const target = state.iframe.contentDocument;
  if (!target) return;
  const onLoad = (): void => onLayout();
  target.addEventListener('load', onLoad, true);
  state.cleanup.add(() => target.removeEventListener('load', onLoad, true));

  const fonts = target.fonts;
  const onFonts = (): void => onLayout();
  fonts?.addEventListener?.('loadingdone', onFonts);
  state.cleanup.add(() => fonts?.removeEventListener?.('loadingdone', onFonts));

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => onLayout());
    if (target.documentElement) observer.observe(target.documentElement);
    if (target.body) observer.observe(target.body);
    state.cleanup.add(() => observer.disconnect());
  }
}

function releaseState(state: HtmlMirrorDomState | undefined): void {
  if (!state || state.released) return;
  state.released = true;
  clearIsolatedPaintedLabels(state);
  for (const cleanup of state.cleanup) {
    try {
      cleanup();
    } catch {
      // Teardown is best effort after document replacement/navigation.
    }
  }
  state.cleanup.clear();
  releaseRetainedLedger(state);
  releaseIsolatedDocumentHosts(state.iframe.contentDocument ?? undefined);
  state.nodes.clear();
  state.textMetadata.clear();
  state.records.clear();
  state.ownedAdoptedStyles.clear();
  state.lease.release();
}

function stateInfo(
  stage: IsolatedMirrorInfoStage,
  state: HtmlMirrorDomState,
  operationCount: number,
  code?: ReplicaDiagnosticCode,
  metrics: IsolatedMirrorPatchMetrics = EMPTY_PATCH_METRICS,
  eventRepresentability: HtmlMirrorRepresentabilitySummary =
    state.representability,
): IsolatedMirrorInfo {
  // Kept by the map of nodes as it changes: they were counted from every
  // node after every patch (D165).
  const imageCount = state.nodes.imageCount;
  const openShadowRootCount = state.nodes.shadowRootCount;
  const visuallyHiddenCount = state.nodes.visuallyHiddenCount;
  const selectedImageSourceCount = state.nodes.selectedImageSourceCount;
  return Object.freeze({
    stage,
    ...(code ? { code } : {}),
    fidelityPolicy: state.fidelityPolicy,
    replicaRequestsMayOccur: state.replicaRequestsMayOccur,
    nodeCount: state.nodes.size,
    textCount: state.records.size,
    imageCount,
    operationCount,
    ...metrics,
    ...state.representability,
    eventRepresentability,
    openShadowRootCount,
    // Style elements where the frame makes no sheets; else the sheets made,
    // one for each text, however many roots adopt it (D183).
    adoptedStyleCount: state.ownedAdoptedStyles.size +
      ownedSheetTotals(state.iframe.contentDocument).count,
    visuallyHiddenCount,
    selectedImageSourceCount,
    ...state.styleReadiness,
    sequence: state.sequence,
  });
}

function emptyInfo(
  stage: IsolatedMirrorInfoStage,
  code?: ReplicaDiagnosticCode,
  eventRepresentability: HtmlMirrorRepresentabilitySummary =
    EMPTY_REPRESENTABILITY,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): IsolatedMirrorInfo {
  return Object.freeze({
    stage,
    ...(code ? { code } : {}),
    fidelityPolicy,
    replicaRequestsMayOccur: false,
    nodeCount: 0,
    textCount: 0,
    imageCount: 0,
    operationCount: 0,
    ...EMPTY_PATCH_METRICS,
    ...EMPTY_REPRESENTABILITY,
    eventRepresentability,
    openShadowRootCount: 0,
    adoptedStyleCount: 0,
    visuallyHiddenCount: 0,
    selectedImageSourceCount: 0,
    ...EMPTY_STYLE_READINESS,
    sequence: 0,
  });
}

const EMPTY_STYLE_READINESS: ReplicaStyleReadiness = Object.freeze({
  stylesheetLinkCount: 0,
  stylesheetLoadedCount: 0,
  stylesheetErrorCount: 0,
  stylesheetTimedOutCount: 0,
});

const EMPTY_REPRESENTABILITY: HtmlMirrorRepresentabilitySummary = Object.freeze({
  unsafeElementOmissionCount: 0,
  unsupportedNodeOmissionCount: 0,
  depthBoundaryOmissionCount: 0,
  privateTextRedactionCount: 0,
  strippedActiveAttributeCount: 0,
  strippedUnsafeResourceCount: 0,
  unreadableStyleCount: 0,
  capacityOmissionCount: 0,
  customElementHostCount: 0,
  customElementHostWithoutAccessibleOpenRootCount: 0,
  accessibleOpenShadowRootCount: 0,
  missingReconciliationProofFallbackCount: 0,
  coveredDirtyBranchFallbackCount: 0,
  attributeContextFallbackCount: 0,
  crossParentFallbackCount: 0,
  preservedStyleSheetCount: 0,
  flattenedStyleSheetCount: 0,
  omittedStyleSheetCount: 0,
  preservedSvgResourceCount: 0,
  blockedSvgResourceCount: 0,
  replicaRequestCapableResourceCount: 0,
  executionRiskBlockCount: 0,
  navigationBlockCount: 0,
  unsupportedSchemeBlockCount: 0,
  browserInaccessibleResourceCount: 0,
  strictResourcePolicyBlockCount: 0,
});

interface IsolatedMirrorPatchMetrics {
  readonly textOperationCount: number;
  readonly attributeOperationCount: number;
  readonly childrenOperationCount: number;
  readonly reconcileChildrenOperationCount: number;
  readonly dimensionOperationCount: number;
  readonly replacementNodeCount: number;
  readonly largestReplacementNodeCount: number;
  readonly retainedNodeCount: number;
  readonly insertedNodeCount: number;
  readonly movedNodeCount: number;
  readonly removedNodeCount: number;
  readonly fullReplacementFallbackCount: number;
  readonly reconciliationRejectedCount: number;
}

const EMPTY_PATCH_METRICS: IsolatedMirrorPatchMetrics = Object.freeze({
  textOperationCount: 0,
  attributeOperationCount: 0,
  childrenOperationCount: 0,
  reconcileChildrenOperationCount: 0,
  dimensionOperationCount: 0,
  replacementNodeCount: 0,
  largestReplacementNodeCount: 0,
  retainedNodeCount: 0,
  insertedNodeCount: 0,
  movedNodeCount: 0,
  removedNodeCount: 0,
  fullReplacementFallbackCount: 0,
  reconciliationRejectedCount: 0,
});

function readPatchMetrics(
  state: HtmlMirrorDomState,
  operations: readonly HtmlMirrorPatchOperation[],
): IsolatedMirrorPatchMetrics {
  let textOperationCount = 0;
  let attributeOperationCount = 0;
  let childrenOperationCount = 0;
  let reconcileChildrenOperationCount = 0;
  let dimensionOperationCount = 0;
  let replacementNodeCount = 0;
  let largestReplacementNodeCount = 0;
  // Looked up by the map's index of ids: a set of every node made each
  // patch cost the whole mirror (D165).
  const known = (node: Node): boolean => state.nodes.hasNode(node);
  for (const operation of operations) {
    if (operation.kind === 'text') textOperationCount += 1;
    else if (operation.kind === 'attributes') attributeOperationCount += 1;
    else if (operation.kind === 'dimensions') dimensionOperationCount += 1;
    else if (operation.kind === 'children') {
      childrenOperationCount += 1;
      const incomingCount = operation.children.reduce(
        (total, child) => total + htmlMirrorGraphNodeCount(child),
        0,
      );
      const target = state.nodes.get(operation.nodeId);
      const outgoingCount = target
        ? [...sourceChildNodeList(target)].reduce(
            (total, child) => total + domMirrorNodeCount(child, known),
            0,
          )
        : 0;
      const count = Math.max(incomingCount, outgoingCount);
      replacementNodeCount += count;
      largestReplacementNodeCount = Math.max(
        largestReplacementNodeCount,
        count,
      );
    } else {
      reconcileChildrenOperationCount += 1;
    }
  }
  return Object.freeze({
    textOperationCount,
    attributeOperationCount,
    childrenOperationCount,
    reconcileChildrenOperationCount,
    dimensionOperationCount,
    replacementNodeCount,
    largestReplacementNodeCount,
    retainedNodeCount: 0,
    insertedNodeCount: 0,
    movedNodeCount: 0,
    removedNodeCount: 0,
    fullReplacementFallbackCount: childrenOperationCount,
    reconciliationRejectedCount: 0,
  });
}

function htmlMirrorGraphNodeCount(node: HtmlMirrorNode): number {
  if (node.kind === 'text') return 1;
  let count = 1;
  for (const child of node.children) count += htmlMirrorGraphNodeCount(child);
  if (node.shadowRoot) {
    count += 1;
    for (const child of node.shadowRoot.children) {
      count += htmlMirrorGraphNodeCount(child);
    }
  }
  return count;
}

function domMirrorNodeCount(
  node: Node,
  known: (node: Node) => boolean,
): number {
  let count = known(node) ? 1 : 0;
  for (const child of [...sourceChildNodeList(node)]) {
    count += domMirrorNodeCount(child, known);
  }
  if (sourceNodeType(node) === Node.ELEMENT_NODE) {
    const shadowRoot = sourceProperty((node as Element), 'shadowRoot');
    if (shadowRoot) count += domMirrorNodeCount(shadowRoot, known);
  }
  return count;
}
