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
import type {
  HtmlMirrorStreamFactory,
  HtmlMirrorStreamLease,
} from './html-mirror-client';
import { HtmlMirrorClientError } from './html-mirror-client';
import type {
  HtmlMirrorCheckpoint,
  HtmlMirrorPatchBatch,
  HtmlMirrorPatchOperation,
} from './html-mirror-protocol';
import {
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_NODES,
  hasPrivateHtmlMirrorAttribute,
  hasPublicMenuResourceAttribute,
  readHtmlMirrorDocumentContent,
  readHtmlMirrorNode,
  sanitizeCss,
  type HtmlMirrorControlText,
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
  type HtmlMirrorRepresentabilitySummary,
} from './html-mirror-sanitizer';
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
} from './source-value-model';
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
  disposeReadOnlyReplicaDisclosures,
  installReadOnlyReplicaDisclosure,
  isReadOnlyReplicaDisclosureEvent,
  type ReadOnlyReplicaDisclosure,
} from './read-only-disclosure';
import {
  PAGE_ONLY_REPLICA_READ_SCOPE,
  type ReplicaReadScope,
} from './read-scope-policy';
import type {
  SemanticSourceStreamFactory,
  SemanticSourceStreamLease,
} from './semantic-source-client';
import {
  SemanticSourceReceiver,
  semanticSelectionTextFor,
} from './semantic-source-receiver';
import { SemanticProofPresenter } from './semantic-proof-presenter';
import { isSourceSecretPlaceholderTagName } from './source-secret-classifier';

export const ISOLATED_HTML_SHELL_MARKER = 'isolated-html-v1';
const ISOLATED_SECRET_PLACEHOLDER_CSS =
  ':host,:host::before,:host::after{all:initial!important;display:none!important;content:none!important;background:none!important;background-image:none!important;border:0!important;border-image-source:none!important;cursor:default!important;filter:none!important;list-style:none!important;list-style-image:none!important;mask:none!important;mask-image:none!important;-webkit-mask-image:none!important;pointer-events:none!important}';
const ISOLATED_HTML_SHELL_DOCUMENT = `<html><head><meta charset="utf-8" data-simul-owned-shell="charset"><meta name="simul-isolated-shell" content="${ISOLATED_HTML_SHELL_MARKER}" data-simul-owned-shell="marker"><meta http-equiv="Content-Security-Policy" data-simul-owned-shell="csp" content="default-src 'none'; script-src 'none'; worker-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline' http: https: data:; font-src http: https: data:"><style data-simul-owned-shell="inert">html,body{margin:0;min-width:100%;min-height:100%;pointer-events:none}*{pointer-events:none!important}[data-simul-replica-disclosure-trigger="v1"],[data-simul-replica-disclosure-panel="v1"],[data-simul-replica-disclosure-overlay="v1"]{pointer-events:auto!important}</style></head><body></body></html>`;
const ISOLATED_SELECT_SHADOW_CSS = `:host{pointer-events:auto!important;background-image:none!important;border-image-source:none!important;cursor:default!important;filter:none!important;list-style-image:none!important;mask-image:none!important;-webkit-mask-image:none!important}:host([data-simul-select-hidden="v1"]){display:none!important}:host::before,:host::after{content:none!important;display:none!important;background-image:none!important}[data-simul-owned-select-trigger="v1"]{all:unset!important;box-sizing:border-box!important;color:inherit!important;cursor:default!important;display:block!important;font:inherit!important;overflow:hidden!important;text-align:inherit!important;text-overflow:ellipsis!important;white-space:nowrap!important;width:100%!important}[data-simul-owned-select-options="v1"]{background:Canvas!important;box-sizing:border-box!important;color:CanvasText!important;max-height:min(18rem,70vh)!important;min-width:100%!important;overflow:auto!important;overscroll-behavior:contain!important;pointer-events:auto!important;width:max-content!important;z-index:2147483647!important}[data-simul-owned-select-option="v1"],[data-simul-owned-select-optgroup-label="v1"]{box-sizing:border-box!important;display:block!important;min-height:1.5em!important;padding-inline:.5rem!important;pointer-events:none!important;white-space:normal!important}[data-simul-owned-select-optgroup-label="v1"]{font-weight:600!important}select[data-simul-select-facsimile="v1"]{display:none!important;pointer-events:none!important}`;
export const ISOLATED_PUBLIC_MENU_SHADOW_CSS = `:host{all:initial!important;display:block!important;box-sizing:border-box!important;max-width:100%!important;color:inherit!important;font:inherit!important;background:none!important;border:0!important;filter:none!important;list-style:none!important;mask:none!important;pointer-events:none!important}:host([data-simul-replica-disclosure-panel="v1"][hidden]){display:none!important}:host([data-simul-replica-disclosure-overlay="v1"]){box-sizing:border-box!important;display:block!important;inset:auto!important;left:var(--simul-replica-disclosure-left,0px)!important;margin:0!important;max-height:var(--simul-replica-disclosure-max-height,70vh)!important;max-width:var(--simul-replica-disclosure-max-width,calc(100vw - 16px))!important;min-width:var(--simul-replica-disclosure-min-width,0px)!important;overflow-x:hidden!important;overflow-y:auto!important;overscroll-behavior:contain!important;pointer-events:auto!important;position:fixed!important;top:var(--simul-replica-disclosure-top,0px)!important;visibility:var(--simul-replica-disclosure-visibility,hidden)!important;z-index:2147483647!important}:host::before,:host::after{content:none!important;display:none!important;background:none!important}:host *{box-sizing:border-box!important;max-width:100%!important;background:none!important;border-image:none!important;filter:none!important;list-style-image:none!important;mask:none!important;pointer-events:none!important}:host([data-simul-replica-disclosure-overlay="v1"])>*:not(style){display:block!important;visibility:visible!important;opacity:1!important}:host *::before,:host *::after{content:none!important;display:none!important;background:none!important}`;
const ISOLATED_DISCLOSURE_IFRAME_MARKER = 'css-disclosure-v1';
const ISOLATED_DISCLOSURE_BLOCKED_EVENTS = Object.freeze([
  'auxclick', 'beforeinput', 'change', 'click', 'contextmenu', 'dblclick',
  'dragstart', 'drop', 'input', 'keydown', 'keypress', 'keyup', 'mousedown',
  'mouseup', 'pointerdown', 'pointerup', 'reset', 'selectstart', 'submit',
  'touchend', 'touchstart',
]);
const ISOLATED_SELECT_HOSTS = new WeakSet<Element>();
const ISOLATED_PUBLIC_MENU_HOSTS = new WeakSet<Element>();
interface IsolatedSelectFacsimile {
  readonly panel: HTMLElement;
  readonly select: HTMLSelectElement;
  readonly trigger: HTMLButtonElement;
  controller?: ReadOnlyReplicaDisclosure;
}
interface IsolatedPublicMenuFacsimile {
  readonly role: 'listbox' | 'menu';
}
const ISOLATED_SELECT_FACSIMILES = new WeakMap<HTMLElement, IsolatedSelectFacsimile>();
const ISOLATED_PUBLIC_MENU_FACSIMILES = new WeakMap<
  HTMLElement,
  IsolatedPublicMenuFacsimile
>();
let isolatedSelectHostSequence = 0;
export const ISOLATED_HTML_SHELL = `<!doctype html>
${ISOLATED_HTML_SHELL_DOCUMENT}`;
export const ISOLATED_HTML_QUIRKS_SHELL = ISOLATED_HTML_SHELL_DOCUMENT;

export type IsolatedMirrorInfoStage =
  | 'connected'
  | 'checkpoint'
  | 'patch'
  | 'recovery'
  | 'failed';

export interface IsolatedMirrorInfo {
  readonly stage: IsolatedMirrorInfoStage;
  readonly code?: ReplicaDiagnosticCode;
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
  readonly getReplicaReadScope?: () => ReplicaReadScope;
  readonly openSemanticStream?: SemanticSourceStreamFactory;
  readonly onLiveApplied?: () => void;
  readonly onLayoutChanged?: () => void;
  readonly onSourceCommit?: (commit: ReplicaSourceCommit) => void;
  readonly onLiveFailure?: (code: ReplicaDiagnosticCode) => void;
  readonly onInfo?: (info: IsolatedMirrorInfo) => void;
  readonly scheduleLayoutRefresh?: (callback: () => void) => void;
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
  readonly nodes: Map<number, Node>;
  readonly textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>;
  readonly controlMetadata: Map<number, HtmlMirrorControlText>;
  readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
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
}

type HtmlMirrorLiveDimensions = HtmlMirrorCheckpoint['payload'] & Readonly<{
  canvasBackgroundColor?: string;
}>;

const HTML_MIRROR_RECOVERY_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_RECOVERY_PATCHES = 4;
const MAX_RETAINED_REPLICA_BYTES = MAX_HTML_MIRROR_BYTES * 4;

const NAMESPACE_URIS = Object.freeze({
  html: 'http://www.w3.org/1999/xhtml',
  svg: 'http://www.w3.org/2000/svg',
  mathml: 'http://www.w3.org/1998/Math/MathML',
});

/** A scriptless real-DOM mirror with rrweb-independent identity and patches. */
export class IsolatedHtmlReplicaEngine
  implements ReplicaEngine, ReplicaTranslationSurface, ReplicaImageSurface {
  readonly id = 'isolated-html-v1' as const;
  #disposed = false;
  #runVersion = 0;
  #stream: HtmlMirrorStreamLease | undefined;
  #semanticStream: SemanticSourceStreamLease | undefined;
  #semanticReceiver: SemanticSourceReceiver | undefined;
  #stagingLease: VisibleReplayCandidateLease | undefined;
  #candidate: HtmlMirrorDomState | undefined;
  #committed: HtmlMirrorDomState | undefined;
  #recoveryTask: Promise<void> | undefined;
  #recoveryRequested = false;
  #recoveryAbort: AbortController | undefined;
  #recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  #recoveryToken = 0;
  #bufferedRecoveryPatches: HtmlMirrorPatchBatch[] = [];
  #replayLease = 0;
  #activeFidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative';
  #projectionContext: ReplicaProjectionContext = {
    translationEpoch: 0,
    pairKey: undefined,
  };
  #projections = new Map<number, ReplicaTextProjection>();
  #extentRefreshQueued = false;
  #pendingExtentState: HtmlMirrorDomState | undefined;

  constructor(private readonly options: IsolatedHtmlEngineOptions) {}

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (this.#disposed) return this.#failed('stream_failed');
    const runVersion = ++this.#runVersion;
    this.#purgeSemantic(true);
    this.#releaseStream();
    this.#releaseCandidate();
    if (!request.isCurrent() || signal?.aborted) {
      return this.#skipped('stale_identity');
    }
    let stream: HtmlMirrorStreamLease | undefined;
    const fidelityPolicy = this.options.getReplicaFidelityPolicy?.() ??
      'conservative';
    this.#activeFidelityPolicy = fidelityPolicy;
    try {
      stream = await this.options.openStream(request, fidelityPolicy, signal);
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
        onFailure: (code, representability) => this.#onStreamFailure(
          code,
          request,
          runVersion,
          representability ?? EMPTY_REPRESENTABILITY,
        ),
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
      const code = error instanceof HtmlMirrorClientError
        ? error.code
        : error instanceof DOMException && error.name === 'AbortError'
          ? 'stale_identity'
          : 'replay_failed';
      if (code === 'stale_identity') return this.#skipped(code);
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
    this.#projections.clear();
    const state = this.#committed;
    if (!state) return;
    for (const record of state.records.values()) {
      const node = state.nodes.get(record.nodeId);
      if (record.nodeType === 3 && node?.nodeType === Node.TEXT_NODE) {
        node.nodeValue = record.source;
      } else if (record.nodeType === 1 && node?.nodeType === Node.ELEMENT_NODE) {
        applyControlText(node as Element, {
          kind: record.controlTarget,
          text: record.source,
          translatable: true,
        });
      }
    }
    this.#semanticReceiver?.restoreSources();
    refreshIsolatedNativeSelectFacsimiles(state.iframe.contentDocument);
    this.#refreshExtent(state);
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
      if (node?.nodeType !== Node.TEXT_NODE) return false;
      node.nodeValue = projection.translated;
    } else {
      if (
        node?.nodeType !== Node.ELEMENT_NODE ||
        record.nodeType !== 1 ||
        record.controlTarget !== projection.controlTarget
      ) return false;
      applyControlText(node as Element, {
        kind: projection.controlTarget,
        text: projection.translated,
        translatable: true,
      });
      syncContainingIsolatedSelectFacsimile(node as Element);
    }
    this.#projections.set(projection.nodeId, Object.freeze({ ...projection }));
    this.#refreshExtent(state);
    return true;
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
      node.nodeType !== Node.ELEMENT_NODE ||
      (node as Element).localName.toLowerCase() !== 'img' ||
      !node.isConnected ||
      node.ownerDocument !== state.iframe.contentDocument
    ) return undefined;
    return Object.freeze({
      document: state.document,
      replayLease: state.replayLease,
      image: node as HTMLImageElement,
      iframe: state.iframe,
    });
  }

  releasePresentation(showFallbackLabel = true): void {
    this.#runVersion += 1;
    this.#purgeSemantic(false);
    this.#releaseStream();
    this.#releaseCandidate();
    releaseState(this.#committed);
    this.#committed = undefined;
    this.#projections.clear();
    this.#replayLease += 1;
    this.options.presentationHost.showLegacy(showFallbackLabel);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.releasePresentation(false);
  }

  async #stageCheckpoint(
    checkpoint: HtmlMirrorCheckpoint,
    fidelityPolicy: SelectableReplicaFidelityPolicy,
    signal?: AbortSignal,
  ): Promise<HtmlMirrorDomState> {
    signal?.throwIfAborted();
    const content = readHtmlMirrorDocumentContent(
      checkpoint.payload.root,
      checkpoint.payload.adoptedStyleSheets,
      fidelityPolicy,
    );
    const graph = content?.root;
    if (!content || !graph || graph.tagName !== 'html') {
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
    const iframe = lease.mount.ownerDocument.createElement('iframe');
    protectIframe(iframe);
    let disposeStagedDisclosureGuards: (() => void) | undefined;
    const iframeShell = checkpoint.payload.documentMode === 'quirks'
      ? ISOLATED_HTML_QUIRKS_SHELL
      : ISOLATED_HTML_SHELL;
    try {
      let iframeDocument: Document;
      if (this.options.initializeIframe) {
        iframe.srcdoc = iframeShell;
        lease.mount.append(iframe);
        iframeDocument = await this.options.initializeIframe(
          iframe,
          iframeShell,
          signal,
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
      const nodes = new Map<number, Node>();
      const textMetadata = new Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>();
      const controlMetadata = new Map<number, HtmlMirrorControlText>();
      const ownedAdoptedStyles = new Set<HTMLStyleElement>();
      const disposeDisclosureGuards = installIsolatedDisclosureGuards(
        iframeDocument,
        iframe,
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
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
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
    const extent = measureExtent(state.iframe);
    state.lease.commit(state.iframe, extent);
    const previous = this.#committed;
    const previousLanguage = previous && !previous.released
      ? readDocumentLanguage(previous)
      : undefined;
    const semanticRemovals = this.#purgeSemantic(false);
    const changes = Object.freeze([
      ...checkpointChanges(state, previous),
      ...semanticRemovals,
    ]);
    const documentLanguageChanged = readDocumentLanguage(state) !== previousLanguage;
    this.#candidate = undefined;
    this.#committed = state;
    this.#replayLease = state.replayLease;
    this.#recoveryRequested = false;
    releaseState(previous);
    this.options.presentationHost.markLive(state.iframe);
    this.#notifySourceCommit(
      state,
      reason,
      changes,
      documentLanguageChanged,
    );
    this.#openSemanticSource(state, request, runVersion, signal);
    this.options.onLayoutChanged?.();
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

  #applyLivePatch(
    batch: HtmlMirrorPatchBatch,
    request: ReplicaCaptureRequest,
    runVersion: number,
  ): void {
    const state = this.#committed;
    const stream = this.#stream;
    if (!state || !stream || !this.#isCurrent(runVersion, request)) return;
    if (
      batch.firstSequence !== state.sequence + 1 ||
      batch.lastSequence !== batch.firstSequence
    ) {
      this.#requestRecovery(
        'stream_gap',
        EMPTY_PATCH_METRICS,
        batch.representability,
      );
      return;
    }
    const replacementMetrics = readPatchMetrics(state, batch.operations);
    const replicaDocument = state.iframe.contentDocument;
    if (replicaDocument) disposeReadOnlyReplicaDisclosures(replicaDocument);
    let applied: AppliedPatchBatch | undefined;
    try {
      applied = applyPatchBatch(state, batch.operations);
    } finally {
      if (replicaDocument) refreshIsolatedReplicaDisclosures(replicaDocument);
    }
    if (!applied) {
      const reconciliationRejected = batch.operations.some(
        ({ kind }) => kind === 'reconcile-children',
      );
      this.#requestRecovery(
        reconciliationRejected ? 'stream_gap' : 'privacy_rejected',
        Object.freeze({
          ...replacementMetrics,
          reconciliationRejectedCount: reconciliationRejected ? 1 : 0,
        }),
        batch.representability,
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
    state.replicaRequestsMayOccur ||=
      batch.representability.replicaRequestCapableResourceCount > 0;
    stream.acknowledge(state.sequence);
    this.options.presentationHost.refreshDimensions?.(state.iframe, state.dimensions);
    this.options.presentationHost.markLive(state.iframe);
    const semanticChanges = this.#semanticReceiver?.refreshBindings() ?? [];
    for (const change of semanticChanges) {
      this.#projections.delete(sourceChangeNodeId(change));
    }
    this.#notifySourceCommit(
      state,
      'batch',
      Object.freeze([...applied.changes, ...semanticChanges]),
      changesDocumentLanguage(batch),
    );
    this.options.onLiveApplied?.();
    this.#refreshExtent(state);
    this.options.onInfo?.(stateInfo(
      'patch',
      state,
      batch.operations.length,
      undefined,
      patchMetrics,
      batch.representability,
    ));
  }

  #onRecoveryCheckpoint(
    checkpoint: HtmlMirrorCheckpoint,
    request: ReplicaCaptureRequest,
    runVersion: number,
  ): void {
    if (
      !this.#isCurrent(runVersion, request) ||
      !this.#recoveryRequested ||
      this.#recoveryTask
    ) return;
    const token = this.#recoveryToken;
    const recoverySignal = this.#recoveryAbort?.signal;
    const fidelityPolicy = this.#committed?.fidelityPolicy ??
      this.options.getReplicaFidelityPolicy?.() ?? 'conservative';
    this.#recoveryTask = this.#stageCheckpoint(
      checkpoint,
      fidelityPolicy,
      recoverySignal,
    )
      .then((state) => {
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
        this.options.onInfo?.(stateInfo('recovery', state, 0));
        for (const batch of buffered) {
          const current = this.#committed;
          if (!current || batch.lastSequence <= current.sequence) continue;
          this.#applyLivePatch(batch, request, runVersion);
          if (this.#recoveryRequested || !this.#stream) break;
        }
      })
      .catch(() => {
        if (
          token === this.#recoveryToken &&
          this.#isCurrent(runVersion, request)
        ) this.#failLive('stream_failed');
      })
      .finally(() => {
        if (token === this.#recoveryToken) this.#recoveryTask = undefined;
      });
  }

  #onStreamFailure(
    code: Extract<ReplicaDiagnosticCode, 'stream_gap' | 'stream_overflow' | 'stream_failed' | 'privacy_rejected'>,
    request: ReplicaCaptureRequest,
    runVersion: number,
    representability: HtmlMirrorRepresentabilitySummary,
  ): void {
    if (!this.#isCurrent(runVersion, request)) return;
    if (code === 'stream_failed') {
      this.#failLive(code, representability);
    } else {
      this.#requestRecovery(code, EMPTY_PATCH_METRICS, representability);
    }
  }

  #requestRecovery(
    code: ReplicaDiagnosticCode,
    metrics: IsolatedMirrorPatchMetrics = EMPTY_PATCH_METRICS,
    eventRepresentability: HtmlMirrorRepresentabilitySummary =
      EMPTY_REPRESENTABILITY,
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
    if (this.#recoveryTimer !== undefined) clearTimeout(this.#recoveryTimer);
    this.#recoveryTimer = setTimeout(() => {
      if (token !== this.#recoveryToken || !this.#recoveryRequested) return;
      this.#recoveryAbort?.abort(
        new Error('HTML mirror recovery checkpoint timed out.'),
      );
      this.#failLive('stream_failed');
    }, HTML_MIRROR_RECOVERY_TIMEOUT_MS);
    this.options.onInfo?.(stateInfo(
      'recovery',
      state,
      0,
      code,
      metrics,
      eventRepresentability,
    ));
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
        if (node?.nodeType !== Node.TEXT_NODE) continue;
        node.nodeValue = projection.translated;
      } else {
        if (
          node?.nodeType !== Node.ELEMENT_NODE ||
          record.nodeType !== 1 ||
          record.controlTarget !== projection.controlTarget
        ) continue;
        applyControlText(node as Element, {
          kind: projection.controlTarget,
          text: projection.translated,
          translatable: true,
        });
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
    const scope = this.options.getReplicaReadScope?.() ??
      PAGE_ONLY_REPLICA_READ_SCOPE;
    if (!open || !hasSemanticReadScope(scope)) return;
    const replicaDocument = state.iframe.contentDocument;
    if (!replicaDocument) return;
    const presenter = new SemanticProofPresenter({
      document: replicaDocument,
      iframe: state.iframe,
      mode: 'isolated-html',
      setAncestorAccessibility: (accessible) =>
        this.options.presentationHost.setInteractiveAccessibility?.(
          state.iframe,
          accessible,
        ) ?? true,
      afterApply: () => {
        refreshIsolatedNativeSelectFacsimiles(replicaDocument);
        refreshIsolatedReplicaDisclosures(replicaDocument);
      },
    });
    const receiver = new SemanticSourceReceiver({
      document: state.document,
      replicaDocument,
      resolveNode: (nodeId) => state.nodes.get(nodeId),
      applyProofs: (proofs) => presenter.apply(proofs),
    });
    this.#semanticReceiver = receiver;
    void open(request, 'isolated-html', scope, signal).then((lease) => {
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
          for (const change of changes) {
            this.#projections.delete(sourceChangeNodeId(change));
          }
          refreshIsolatedNativeSelectFacsimiles(replicaDocument);
          this.#notifySourceCommit(state, 'batch', changes, false);
          this.#refreshExtent(state);
          return true;
        },
        onFailure: () => {
          if (this.#semanticReceiver === receiver) this.#purgeSemantic(true);
        },
      });
    }).catch(() => {
      if (this.#semanticReceiver === receiver) this.#purgeSemantic(true);
    });
  }

  #purgeSemantic(notify: boolean): readonly ReplicaSourceTextChange[] {
    this.#semanticStream?.dispose();
    this.#semanticStream = undefined;
    const receiver = this.#semanticReceiver;
    this.#semanticReceiver = undefined;
    const changes = receiver?.clear() ?? Object.freeze([]);
    for (const change of changes) {
      this.#projections.delete(sourceChangeNodeId(change));
    }
    const state = this.#committed;
    if (notify && state && !state.released && changes.length > 0) {
      this.#notifySourceCommit(state, 'batch', changes, false);
      this.#refreshExtent(state);
    }
    return changes;
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
  const sourceHead = root.children.find(
    (node): node is HtmlMirrorElementNode => node.kind === 'element' && node.tagName === 'head',
  );
  const sourceBody = root.children.find(
    (node): node is HtmlMirrorElementNode => node.kind === 'element' && node.tagName === 'body',
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
  body.replaceChildren();
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
      if (built) body.append(built);
    }
  }
  appendOwnedAdoptedStyles(
    body,
    adoptedStyleSheets,
    ownedAdoptedStyles,
    'document',
  );
}

function buildNode(
  target: Document,
  input: HtmlMirrorNode,
  nodes: Map<number, Node>,
  textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
  controlMetadata: Map<number, HtmlMirrorControlText>,
  ownedAdoptedStyles: Set<HTMLStyleElement>,
  inheritedPublicMenuRegion = false,
): Node | undefined {
  if (nodes.has(input.id)) throw new Error('Duplicate isolated mirror node ID.');
  if (input.kind === 'text') {
    const node = target.createTextNode(input.text);
    nodes.set(input.id, node);
    textMetadata.set(input.id, input);
    return node;
  }
  if (input.tagName === 'html' || input.tagName === 'head' || input.tagName === 'body') {
    throw new Error('Nested document element rejected.');
  }
  const node = target.createElementNS(NAMESPACE_URIS[input.namespace], input.tagName);
  if (input.opaquePlaceholder) {
    if (
      input.namespace !== 'html' ||
      !isSourceSecretPlaceholderTagName(input.tagName, input.id) ||
      input.attributes.length !== 0 ||
      input.children.length !== 0 ||
      input.shadowRoot
    ) throw new Error('Non-canonical secret placeholder rejected.');
    protectIsolatedOpaquePlaceholder(node);
    nodes.set(input.id, node);
    return node;
  }
  setAttributes(node, input.attributes);
  applyElementHints(node, input);
  nodes.set(input.id, node);
  const attributes = Object.fromEntries(input.attributes);
  const startsPublicMenuRegion =
    !['select', 'optgroup', 'option'].includes(input.tagName) &&
    isSourcePublicMenuRoleValue(attributes.role);
  const publicMenuRegion =
    inheritedPublicMenuRegion || startsPublicMenuRegion;
  if (input.controlText) controlMetadata.set(input.id, input.controlText);
  for (const child of input.children) {
    const built = buildNode(
      target,
      child,
      nodes,
      textMetadata,
      controlMetadata,
      ownedAdoptedStyles,
      publicMenuRegion,
    );
    if (built) node.append(built);
  }
  applySelectedOptionIndexes(node, input.selectedOptionIndexes);
  configureNativeSelectFacsimile(node);
  applyResolvedStyleSheetText(node, input.resolvedStyleSheetText);
  if (input.shadowRoot) {
    const shadow = (node as Element & {
      attachShadow?: (init: ShadowRootInit) => ShadowRoot;
    }).attachShadow?.({ mode: 'open' });
    if (!shadow) throw new Error('Open shadow root could not be reconstructed.');
    if (nodes.has(input.shadowRoot.id)) {
      throw new Error('Duplicate isolated mirror shadow root ID.');
    }
    nodes.set(input.shadowRoot.id, shadow);
    for (const child of input.shadowRoot.children) {
      const built = buildNode(
        target,
        child,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
        publicMenuRegion,
      );
      if (built) shadow.append(built);
    }
    appendOwnedAdoptedStyles(
      shadow,
      input.shadowRoot.adoptedStyleSheets,
      ownedAdoptedStyles,
      'shadow',
    );
  }
  const presentation = wrapNativeSelectFacsimile(node);
  return startsPublicMenuRegion && !inheritedPublicMenuRegion
    ? wrapPublicMenuFacsimile(presentation)
    : presentation;
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
  const style = node.ownerDocument.createElement('style');
  style.textContent = ISOLATED_SECRET_PLACEHOLDER_CSS;
  shadow.append(style);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('inert', '');
  node.setAttribute('tabindex', '-1');
}

function appendOwnedAdoptedStyles(
  owner: ParentNode,
  adoptedStyleSheets: readonly string[],
  ownedAdoptedStyles: Set<HTMLStyleElement>,
  scope: 'document' | 'shadow',
): void {
  const target = owner.ownerDocument;
  if (!target) throw new Error('Adopted stylesheet owner has no document.');
  for (const cssText of adoptedStyleSheets) {
    const style = target.createElement('style');
    style.setAttribute('data-simul-adopted-style', scope);
    style.textContent = cssText;
    owner.appendChild(style);
    ownedAdoptedStyles.add(style);
  }
}

function setAttributes(
  element: Element,
  attributes: readonly (readonly [string, string])[],
): void {
  for (const attribute of [...element.attributes]) {
    element.removeAttribute(attribute.name);
  }
  for (const [name, value] of attributes) {
    if (
      element.namespaceURI === 'http://www.w3.org/2000/svg' &&
      name === 'xlink:href'
    ) {
      element.setAttributeNS(
        'http://www.w3.org/1999/xlink',
        'xlink:href',
        value,
      );
    } else {
      element.setAttribute(
        element.namespaceURI === 'http://www.w3.org/2000/svg'
          ? canonicalSvgAttributeName(name)
          : name,
        value,
      );
    }
  }
  const tagName = element.localName.toLowerCase();
  if (
    element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    (tagName === 'link' || tagName === 'style')
  ) {
    try {
      (element as Element & { disabled: boolean }).disabled = attributes.some(
        ([name]) => name === 'disabled',
      );
    } catch {
      // The content attribute remains the browser-owned fallback.
    }
  }
}

function canonicalSvgAttributeName(name: string): string {
  return SVG_CASE_SENSITIVE_ATTRIBUTES.get(name) ?? name;
}

const SVG_CASE_SENSITIVE_ATTRIBUTES = new Map<string, string>([
  ['attributename', 'attributeName'],
  ['attributetype', 'attributeType'],
  ['basefrequency', 'baseFrequency'],
  ['baseprofile', 'baseProfile'],
  ['calcmode', 'calcMode'],
  ['clippathunits', 'clipPathUnits'],
  ['diffuseconstant', 'diffuseConstant'],
  ['edgemode', 'edgeMode'],
  ['filterunits', 'filterUnits'],
  ['gradienttransform', 'gradientTransform'],
  ['gradientunits', 'gradientUnits'],
  ['kernelmatrix', 'kernelMatrix'],
  ['kernelunitlength', 'kernelUnitLength'],
  ['keypoints', 'keyPoints'],
  ['keysplines', 'keySplines'],
  ['keytimes', 'keyTimes'],
  ['lengthadjust', 'lengthAdjust'],
  ['limitingconeangle', 'limitingConeAngle'],
  ['markerheight', 'markerHeight'],
  ['markerunits', 'markerUnits'],
  ['markerwidth', 'markerWidth'],
  ['maskcontentunits', 'maskContentUnits'],
  ['maskunits', 'maskUnits'],
  ['numoctaves', 'numOctaves'],
  ['pathlength', 'pathLength'],
  ['patterncontentunits', 'patternContentUnits'],
  ['patterntransform', 'patternTransform'],
  ['patternunits', 'patternUnits'],
  ['pointsatx', 'pointsAtX'],
  ['pointsaty', 'pointsAtY'],
  ['pointsatz', 'pointsAtZ'],
  ['preservealpha', 'preserveAlpha'],
  ['preserveaspectratio', 'preserveAspectRatio'],
  ['primitiveunits', 'primitiveUnits'],
  ['refx', 'refX'],
  ['refy', 'refY'],
  ['repeatcount', 'repeatCount'],
  ['repeatdur', 'repeatDur'],
  ['requiredextensions', 'requiredExtensions'],
  ['requiredfeatures', 'requiredFeatures'],
  ['specularconstant', 'specularConstant'],
  ['specularexponent', 'specularExponent'],
  ['spreadmethod', 'spreadMethod'],
  ['startoffset', 'startOffset'],
  ['stddeviation', 'stdDeviation'],
  ['stitchtiles', 'stitchTiles'],
  ['surfacescale', 'surfaceScale'],
  ['systemlanguage', 'systemLanguage'],
  ['tablevalues', 'tableValues'],
  ['targetx', 'targetX'],
  ['targety', 'targetY'],
  ['textlength', 'textLength'],
  ['viewbox', 'viewBox'],
  ['viewtarget', 'viewTarget'],
  ['xchannelselector', 'xChannelSelector'],
  ['ychannelselector', 'yChannelSelector'],
  ['zoomandpan', 'zoomAndPan'],
]);

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
    | 'resolvedStyleSheetText'
  >,
): void {
  applyControlText(element, hints.controlText);
  applySelectedOptionIndexes(element, hints.selectedOptionIndexes);
  if (element.localName.toLowerCase() === 'select') {
    if (hints.selectPresentationStyle) {
      element.setAttribute(
        'data-simul-select-presentation-style',
        hints.selectPresentationStyle,
      );
    } else {
      element.removeAttribute('data-simul-select-presentation-style');
    }
    if (hints.selectPickerOpen) {
      element.setAttribute('data-simul-source-picker-open', 'v1');
    } else {
      element.removeAttribute('data-simul-source-picker-open');
    }
  }
  if (
    hints.canvasBackgroundColor &&
    element.localName.toLowerCase() === 'html'
  ) {
    // This is the source browser's resolved canvas color (html first, then
    // body), not an authored declaration. Keep it authoritative even when a
    // transported stylesheet contains a light-theme `!important` fallback.
    applyReplicaCanvasBackground(element, hints.canvasBackgroundColor);
  }
  if (hints.selectedImageSource && element.localName.toLowerCase() === 'img') {
    element.setAttribute('src', hints.selectedImageSource);
    element.removeAttribute('srcset');
    element.setAttribute('data-simul-selected-image-source', 'v1');
  }
  if (
    hints.resolvedStyleSheetText !== undefined &&
    element.localName.toLowerCase() === 'link'
  ) {
    // The source SRI hash covers the original response, not Simul's bounded,
    // sanitized CSSOM serialization. Keeping it would make Chrome reject the
    // local data stylesheet and silently erase otherwise readable styling.
    element.removeAttribute('integrity');
    element.setAttribute(
      'href',
      `data:text/css;charset=utf-8,${encodeURIComponent(
        hints.resolvedStyleSheetText,
      )}`,
    );
    element.setAttribute('data-simul-resolved-stylesheet', 'v1');
  }
  const styled = element as Element & { readonly style?: CSSStyleDeclaration };
  if (
    element.namespaceURI === 'http://www.w3.org/2000/svg' &&
    styled.style
  ) {
    // Static SVG is part of the current fidelity contract. Simul-owned inline
    // declarations outrank retained author stylesheets (including unreadable
    // cross-origin sheets), so CSS cannot turn the reconstructed SVG tree into
    // an animation channel while the saved animation option is absent/off.
    styled.style.setProperty('animation', 'none', 'important');
    styled.style.setProperty('transition', 'none', 'important');
  }
  if (hints.visuallyHidden && styled.style) {
    element.setAttribute('data-simul-visually-hidden', 'v1');
    if (
      element.localName.toLowerCase() === 'option' ||
      element.localName.toLowerCase() === 'optgroup'
    ) {
      element.setAttribute('hidden', '');
      styled.style.setProperty('display', 'none', 'important');
    }
    styled.style.setProperty('position', 'absolute', 'important');
    styled.style.setProperty('width', '1px', 'important');
    styled.style.setProperty('height', '1px', 'important');
    styled.style.setProperty('padding', '0', 'important');
    styled.style.setProperty('margin', '-1px', 'important');
    styled.style.setProperty('overflow', 'hidden', 'important');
    styled.style.setProperty('clip', 'rect(0, 0, 0, 0)', 'important');
    styled.style.setProperty('clip-path', 'inset(50%)', 'important');
    styled.style.setProperty('white-space', 'nowrap', 'important');
  }
  if (element.localName.toLowerCase() === 'select') {
    configureNativeSelectFacsimile(element);
  }
}

function applySelectedOptionIndexes(
  element: Element,
  selectedOptionIndexes: readonly number[] | undefined,
): void {
  if (element.localName.toLowerCase() !== 'select') return;
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
  if (element.localName.toLowerCase() !== 'select') return;
  element.setAttribute('data-simul-select-facsimile', 'v1');
  element.setAttribute('inert', '');
  element.setAttribute('aria-hidden', 'true');
  element.setAttribute('aria-disabled', 'true');
  element.setAttribute('tabindex', '-1');
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
    node.nodeType !== Node.ELEMENT_NODE ||
    (node as Element).localName.toLowerCase() !== 'select'
  ) return node;
  const select = node as HTMLSelectElement;
  const document = select.ownerDocument;
  isolatedSelectHostSequence += 1;
  const entropy = globalThis.crypto?.randomUUID?.()
    .replace(/[^a-z0-9-]/giu, '')
    .toLowerCase() ?? isolatedSelectHostSequence.toString(36);
  const host = document.createElement(`simul-owned-select-${entropy}`);
  ISOLATED_SELECT_HOSTS.add(host);
  host.setAttribute('data-simul-owned-select-host', 'v1');
  const shadow = host.attachShadow({ mode: 'open' });
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
  shadow.append(style, trigger, panel, select);
  for (const type of ISOLATED_DISCLOSURE_BLOCKED_EVENTS) {
    shadow.addEventListener(type, blockIsolatedDisclosureActivation, true);
  }
  ISOLATED_SELECT_FACSIMILES.set(host, { panel, select, trigger });
  syncNativeSelectFacsimileHost(select);
  queueMicrotask(() => {
    if (isIsolatedOwnedHostConnected(host)) {
      syncNativeSelectFacsimileHost(select);
    }
  });
  return host;
}

/**
 * Public ARIA menu labels remain visible and translatable, but their website
 * selectors must not make the replica fetch images or generate rich content.
 * A random extension-owned shadow host severs the source stylesheet cascade.
 */
function wrapPublicMenuFacsimile(node: Node): Node {
  if (node.nodeType !== Node.ELEMENT_NODE) return node;
  const element = node as Element;
  const document = element.ownerDocument;
  isolatedSelectHostSequence += 1;
  const entropy = globalThis.crypto?.randomUUID?.()
    .replace(/[^a-z0-9-]/giu, '')
    .toLowerCase() ?? isolatedSelectHostSequence.toString(36);
  const host = document.createElement(`simul-owned-menu-${entropy}`);
  ISOLATED_PUBLIC_MENU_HOSTS.add(host);
  host.style.setProperty('display', 'block', 'important');
  host.style.setProperty('max-width', '100%', 'important');
  host.style.setProperty('background', 'none', 'important');
  host.style.setProperty('border', '0', 'important');
  host.style.setProperty('filter', 'none', 'important');
  host.style.setProperty('mask', 'none', 'important');
  host.style.setProperty('pointer-events', 'none', 'important');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.setAttribute('data-simul-owned-menu-style', 'v1');
  style.textContent = ISOLATED_PUBLIC_MENU_SHADOW_CSS;
  shadow.append(style, element);
  const role = isolatedPublicMenuRole(element);
  if (role) ISOLATED_PUBLIC_MENU_FACSIMILES.set(host, { role });
  return host;
}

function syncNativeSelectFacsimileHost(element: Element): void {
  const host = isolatedSelectFacsimileHost(element);
  if (!host) return;
  for (const attribute of [...host.attributes]) {
    if (!attribute.name.startsWith('data-simul-')) {
      host.removeAttribute(attribute.name);
    }
  }
  host.setAttribute('data-simul-owned-select-host', 'v1');
  if (element.getAttribute('data-simul-source-picker-open') === 'v1') {
    host.setAttribute('data-simul-source-picker-open', 'v1');
  } else {
    host.removeAttribute('data-simul-source-picker-open');
  }
  for (const { name, value } of [...element.attributes]) {
    if (
      name.startsWith('data-simul-') || name === 'inert' || name === 'size' ||
      name === 'style' || name === 'tabindex' || name === 'aria-disabled' ||
      name === 'aria-hidden'
    ) continue;
    try {
      host.setAttribute(name, value);
    } catch {
      // Sanitized presentation attributes are optional on the random host.
    }
  }
  element.removeAttribute('style');
  host.style.setProperty('all', 'initial', 'important');
  let hasPresentationDisplay = false;
  const presentation = element.getAttribute(
    'data-simul-select-presentation-style',
  );
  if (presentation) {
    const parser = element.ownerDocument.createElement('span');
    parser.setAttribute('style', presentation);
    for (let index = 0; index < parser.style.length; index += 1) {
      const property = parser.style.item(index);
      if (!property || property === 'all') continue;
      const value = parser.style.getPropertyValue(property);
      if (!value) continue;
      host.style.setProperty(property, value, 'important');
      if (property === 'display') hasPresentationDisplay = true;
    }
  }
  host.style.setProperty('pointer-events', 'auto', 'important');
  host.style.setProperty('background-image', 'none', 'important');
  host.style.setProperty('border-image-source', 'none', 'important');
  host.style.setProperty('clip-path', 'none', 'important');
  host.style.setProperty('content', 'normal', 'important');
  host.style.setProperty('cursor', 'default', 'important');
  host.style.setProperty('filter', 'none', 'important');
  host.style.setProperty('list-style-image', 'none', 'important');
  host.style.setProperty('mask-image', 'none', 'important');
  host.style.setProperty('-webkit-mask-image', 'none', 'important');
  if (element.getAttribute('data-simul-visually-hidden') === 'v1') {
    ISOLATED_SELECT_FACSIMILES.get(host)?.controller?.close();
    host.setAttribute('data-simul-select-hidden', 'v1');
    host.style.setProperty('display', 'none', 'important');
    return;
  }
  host.removeAttribute('data-simul-select-hidden');
  if (!hasPresentationDisplay) {
    host.style.setProperty('display', 'inline-block', 'important');
  }
  syncIsolatedNativeSelectFacsimile(host);
}

function isIsolatedOwnedHostConnected(host: HTMLElement): boolean {
  const document = host.ownerDocument;
  let current: Node = host;
  for (let depth = 0; depth <= 64; depth += 1) {
    if (current === document || document.documentElement?.contains(current)) {
      return true;
    }
    const root = current.getRootNode();
    if (
      root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE ||
      !('host' in root)
    ) return false;
    const shadow = root as ShadowRoot;
    if (shadow.host.shadowRoot !== shadow) return false;
    current = shadow.host;
  }
  return false;
}

function collectIsolatedSelectHosts(root: Node): HTMLElement[] {
  const hosts: HTMLElement[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (ISOLATED_SELECT_HOSTS.has(element)) hosts.push(element as HTMLElement);
      if (element.shadowRoot) pending.push(element.shadowRoot);
    }
    for (const child of node.childNodes) pending.push(child);
  }
  return hosts;
}

function collectIsolatedElements(root: Node): HTMLElement[] {
  const elements: HTMLElement[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      elements.push(element);
      if (element.shadowRoot) pending.push(element.shadowRoot);
    }
    for (const child of node.childNodes) pending.push(child);
  }
  return elements;
}

function isolatedSelectFacsimileHost(element: Element): HTMLElement | undefined {
  const root = element.getRootNode();
  if (
    root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE ||
    !(root as ShadowRoot).host
  ) return undefined;
  const host = (root as ShadowRoot).host as HTMLElement;
  return ISOLATED_SELECT_HOSTS.has(host) ? host : undefined;
}

function isolatedPublicMenuFacsimileHost(
  element: Element,
): HTMLElement | undefined {
  const root = element.getRootNode();
  if (
    root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE ||
    !(root as ShadowRoot).host
  ) return undefined;
  const host = (root as ShadowRoot).host as HTMLElement;
  return ISOLATED_PUBLIC_MENU_HOSTS.has(host) ? host : undefined;
}

function isolatedPublicMenuRole(
  element: Element,
): 'listbox' | 'menu' | undefined {
  for (const token of element.getAttribute('role')?.trim().toLowerCase()
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
  host.setAttribute('data-simul-select-presentation', presentation);
  if (presentation === 'list') {
    trigger.setAttribute('hidden', '');
    trigger.style.setProperty('display', 'none', 'important');
  } else {
    trigger.removeAttribute('hidden');
    trigger.style.removeProperty('display');
  }
  panel.replaceChildren();
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-disabled', 'true');
  if (select.multiple || select.hasAttribute('multiple')) {
    panel.setAttribute('aria-multiselectable', 'true');
  } else {
    panel.removeAttribute('aria-multiselectable');
  }

  const selectedLabels: string[] = [];
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
    if (selected && label) selectedLabels.push(label);
    parent.append(row);
  };

  for (const child of [...select.children]) {
    if (child.localName.toLowerCase() === 'option') {
      appendOption(child as HTMLOptionElement, panel, false);
      continue;
    }
    if (child.localName.toLowerCase() !== 'optgroup') continue;
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
      group.append(label);
    }
    for (const option of [...groupElement.children]) {
      if (option.localName.toLowerCase() === 'option') {
        appendOption(option as HTMLOptionElement, group, groupDisabled);
      }
    }
    panel.append(group);
  }
  const semanticSelection = exposesSelection
    ? semanticSelectionTextFor(select)?.trim()
    : undefined;
  trigger.textContent = exposesSelection
    ? semanticSelection || selectedLabels.join(', ') || '\u2014'
    : 'Options';
}

function syncContainingIsolatedSelectFacsimile(element: Element): void {
  const select = element.localName.toLowerCase() === 'select'
    ? element as HTMLSelectElement
    : element.closest('select');
  const host = select ? isolatedSelectFacsimileHost(select) : undefined;
  if (host) syncIsolatedNativeSelectFacsimile(host);
}

function refreshIsolatedNativeSelectFacsimiles(
  document: Document | null,
): void {
  if (!document?.documentElement) return;
  for (const host of collectIsolatedSelectHosts(document.documentElement)) {
    syncIsolatedNativeSelectFacsimile(host);
  }
}

function refreshIsolatedReplicaDisclosures(document: Document): void {
  disposeReadOnlyReplicaDisclosures(document);
  if (!document.documentElement) return;
  const elements = collectIsolatedElements(document.documentElement);
  for (const host of elements.filter((element) => ISOLATED_SELECT_HOSTS.has(element))) {
    const facsimile = ISOLATED_SELECT_FACSIMILES.get(host);
    if (!facsimile) continue;
    facsimile.controller = undefined;
    syncIsolatedNativeSelectFacsimile(host);
    const presentation = isolatedSelectPresentation(facsimile.select);
    const rawSize = facsimile.select.getAttribute('size');
    const size = rawSize && /^[1-9]\d{0,3}$/u.test(rawSize)
      ? Number(rawSize)
      : 8;
    facsimile.controller = installReadOnlyReplicaDisclosure({
      anchor: host,
      panel: facsimile.panel,
      presentation,
      ...(presentation === 'popup' ? { trigger: facsimile.trigger } : {}),
      manageTriggerExpanded: presentation === 'popup',
      initiallyOpen: presentation === 'popup' &&
        facsimile.select.getAttribute('data-simul-source-picker-open') === 'v1',
      visibleRows: size,
    });
  }
  installValidatedIsolatedAriaDisclosures(document, elements);
}

/**
 * Custom ARIA disclosure is admitted only for a unique, same-document target
 * with matching menu/listbox semantics. Ambiguous and unsupported mappings
 * remain static and pointer-inert.
 */
function installValidatedIsolatedAriaDisclosures(
  document: Document,
  elements: readonly HTMLElement[],
): void {
  const ids = new Map<string, HTMLElement[]>();
  for (const element of elements) {
    const id = element.getAttribute('id')?.trim();
    if (!id) continue;
    const existing = ids.get(id);
    if (existing) existing.push(element);
    else ids.set(id, [element]);
  }
  const usedPanels = new Set<HTMLElement>();
  for (const trigger of elements) {
    if (
      ISOLATED_SELECT_HOSTS.has(trigger) ||
      ISOLATED_PUBLIC_MENU_HOSTS.has(trigger)
    ) continue;
    const controls = trigger.getAttribute('aria-controls')?.trim() ?? '';
    if (!controls || /\s/u.test(controls) || controls.length > 256) continue;
    const targets = ids.get(controls);
    if (targets?.length !== 1) continue;
    const target = targets[0]!;
    if (target.ownerDocument !== document || target === trigger) continue;
    const hasPopup = trigger.getAttribute('aria-haspopup')?.trim().toLowerCase();
    const expectedRole = hasPopup === 'true' ? 'menu' : hasPopup;
    if (expectedRole !== 'menu' && expectedRole !== 'listbox') continue;
    if (
      !isSourceActivationTagName(trigger.localName) &&
      !isSourceActivationRoleValue(trigger.getAttribute('role'))
    ) continue;

    let panel = isolatedPublicMenuFacsimileHost(target);
    const targetRole = isolatedPublicMenuRole(target);
    if (!panel || targetRole !== expectedRole) {
      if (!roleHasToken(target, 'region')) continue;
      const candidates = elements.filter((candidate) => {
        const host = isolatedPublicMenuFacsimileHost(candidate);
        return Boolean(
          host && isolatedPublicMenuRole(candidate) === expectedRole &&
          composedElementContains(target, host),
        );
      });
      if (candidates.length !== 1) continue;
      panel = isolatedPublicMenuFacsimileHost(candidates[0]!);
    }
    if (!panel || usedPanels.has(panel)) continue;
    const metadata = ISOLATED_PUBLIC_MENU_FACSIMILES.get(panel);
    if (!metadata || metadata.role !== expectedRole) continue;
    usedPanels.add(panel);
    installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      manageTriggerExpanded: false,
      initiallyOpen: trigger.getAttribute('aria-expanded') === 'true',
    });
  }
}

function roleHasToken(element: Element, token: string): boolean {
  return element.getAttribute('role')?.trim().toLowerCase()
    .split(/\s+/u).includes(token) ?? false;
}

function composedElementContains(container: Element, candidate: Element): boolean {
  let current: Node | null = candidate;
  for (let depth = 0; current && depth <= 128; depth += 1) {
    if (current === container) return true;
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    const root = current.getRootNode();
    current = root.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
        'host' in root
      ? (root as ShadowRoot).host
      : null;
  }
  return false;
}

function applyResolvedStyleSheetText(
  element: Element,
  cssText: string | undefined,
): void {
  if (cssText === undefined || element.localName.toLowerCase() !== 'style') return;
  const textNodes = [...element.childNodes].filter(
    (node) => node.nodeType === Node.TEXT_NODE,
  );
  if (textNodes.length === 0) {
    element.append(element.ownerDocument.createTextNode(cssText));
  } else {
    textNodes[0]!.nodeValue = cssText;
    for (const extra of textNodes.slice(1)) extra.nodeValue = '';
  }
  element.setAttribute('data-simul-resolved-stylesheet', 'v1');
}

function applyReplicaCanvasBackground(
  element: Element,
  color: string | undefined,
): void {
  const styled = element as HTMLElement;
  if (color) {
    styled.style.setProperty('background-color', color, 'important');
    element.setAttribute('data-simul-canvas-background', 'v1');
    return;
  }
  if (element.getAttribute('data-simul-canvas-background') !== 'v1') return;
  styled.style.removeProperty('background-color');
  if (!element.getAttribute('style')?.trim()) element.removeAttribute('style');
  element.removeAttribute('data-simul-canvas-background');
}

function applyControlText(
  element: Element,
  controlText: HtmlMirrorControlText | undefined,
): void {
  const tagName = element.localName.toLowerCase();
  if (
    (tagName === 'option' || tagName === 'optgroup') &&
    controlText?.kind === 'label'
  ) {
    element.setAttribute('label', controlText.text);
    return;
  }
  if (tagName !== 'input' && tagName !== 'textarea') return;
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
  const tagName = element.localName.toLowerCase();
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

function applyPatchBatch(
  state: HtmlMirrorDomState,
  operations: readonly HtmlMirrorPatchOperation[],
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

  const targetOperations: Array<{
    readonly operation: Exclude<HtmlMirrorPatchOperation, { kind: 'dimensions' }>;
    readonly target: Node;
  }> = [];
  const parsedText = new Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>();
  const attributeOperations = new Map<
    number,
    Extract<HtmlMirrorPatchOperation, { kind: 'attributes' }>
  >();
  const prospectiveAttributeOperations = new Map(
    operations.flatMap((operation) => operation.kind === 'attributes'
      ? [[operation.nodeId, operation] as const]
      : []),
  );

  // Validate every target and payload before touching visible state.
  for (const operation of operations) {
    if (operation.kind === 'dimensions') continue;
    const target = state.nodes.get(operation.nodeId);
    if (!target) return undefined;
    if (
      target.nodeType === Node.ELEMENT_NODE &&
      isSourceSecretPlaceholderTagName((target as Element).localName)
    ) {
      // The placeholder is immutable for its document lifetime. Any source
      // mutation at that ID requires a fresh graph so no descendant/resource
      // patch can repopulate the erased hard-secret region.
      return undefined;
    }
    targetOperations.push({ operation, target });
    if (
      (operation.kind === 'children' ||
        operation.kind === 'reconcile-children') &&
      target.nodeType === Node.ELEMENT_NODE
    ) {
      const targetElement = target as Element;
      const select = targetElement.localName.toLowerCase() === 'select'
        ? targetElement
        : targetElement.closest('select');
      // Native select structure is transported atomically at the select root;
      // never accept a partial optgroup/option children patch that could make
      // the browser invent a new selectedIndex before owner state arrives.
      if (select && targetElement !== select) return undefined;
      const selectNodeId = select ? findDomNodeId(state, select) : undefined;
      const structuralIndex = operations.indexOf(operation);
      const selectStateOperation = operations.find(
        (candidate) => candidate.kind === 'attributes' &&
          candidate.nodeId === selectNodeId,
      );
      const attributesIndex = selectStateOperation
        ? operations.indexOf(selectStateOperation)
        : -1;
      const selectStateAttributes = selectStateOperation?.kind === 'attributes'
        ? Object.fromEntries(selectStateOperation.attributes)
        : undefined;
      const explicitlyPrivateSelect = selectStateOperation?.kind === 'attributes' &&
        selectStateAttributes !== undefined &&
        (
          sourceElementStartsPrivateRegionInContext(
            'select',
            selectStateAttributes,
            false,
          ) ||
          isSourceActivationRoleValue(selectStateAttributes.role)
        );
      // The source emits select structure first and its current IDL selection
      // state second. Reject reversed/partial batches rather than allowing the
      // browser to invent a default selected option during child replacement.
      if (
        select &&
        (
          selectNodeId === undefined ||
          attributesIndex <= structuralIndex ||
          selectStateOperation?.kind !== 'attributes' ||
          (selectStateOperation.selectedOptionIndexes === undefined &&
            !explicitlyPrivateSelect)
        )
      ) {
        return undefined;
      }
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
        target.nodeType !== Node.TEXT_NODE ||
        !node || node.kind !== 'text' || node.id !== operation.nodeId ||
        !validTextForContext(
          node,
          domTextContext(target),
          state.fidelityPolicy,
        )
      ) return undefined;
      parsedText.set(operation.nodeId, node);
      continue;
    }
    if (operation.kind === 'attributes') {
      if (
        target.nodeType !== Node.ELEMENT_NODE ||
        (target as Element).namespaceURI !== NAMESPACE_URIS[operation.namespace] ||
        (target as Element).localName.toLowerCase() !== operation.tagName
      ) return undefined;
      const currentContext = containerContext(target);
      const prospectiveContext = batchContainerContext(
        state,
        target,
        prospectiveAttributeOperations,
      );
      if (
        (
          operation.selectedOptionIndexes !== undefined ||
          operation.selectPickerOpen !== undefined
        ) &&
        (
          currentContext.privateAttributeRegion ||
          prospectiveContext.privateAttributeRegion
        )
      ) return undefined;
      if (
        operation.selectedOptionIndexes !== undefined &&
        !validPatchSelectedOptionIndexes(
          state,
          target as Element,
          operation,
          operations,
        )
      ) return undefined;
      if (
        operation.controlText &&
        (
          currentContext.privateAttributeRegion ||
          prospectiveContext.privateAttributeRegion ||
          currentContext.nonContentRegion ||
          prospectiveContext.nonContentRegion ||
          (operation.controlText.kind === 'label' &&
            !prospectiveContext.nativeSelectRegion)
        )
      ) return undefined;
      if (
        currentContext.publicMenuRegion !== prospectiveContext.publicMenuRegion
      ) return undefined;
      if (
        privacyContextChanges(currentContext, prospectiveContext) &&
        (
          (target as Element).shadowRoot ||
          !operations.some(
            (candidate) =>
              candidate.kind === 'children' &&
              candidate.nodeId === operation.nodeId,
          )
        )
      ) return undefined;
      if (
        prospectiveContext.privateAttributeRegion &&
        hasPrivateHtmlMirrorAttribute(operation.attributes)
      ) return undefined;
      try {
        const sentinel = target.ownerDocument?.createElementNS(
          NAMESPACE_URIS[operation.namespace],
          operation.tagName,
        );
        if (!sentinel) return undefined;
        setAttributes(sentinel, operation.attributes);
      } catch {
        return undefined;
      }
      attributeOperations.set(operation.nodeId, operation);
      continue;
    }
    if (operation.kind === 'children' || operation.kind === 'reconcile-children') {
      if (
        target.nodeType !== Node.ELEMENT_NODE &&
        target.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
      ) return undefined;
      if (!isConnectedReplicaNode(state, target)) return undefined;
      continue;
    }
    return undefined;
  }

  // A parent replacement and a descendant operation cannot be made atomic:
  // the descendant identity ceases to exist. The source normally minimizes
  // these, while the extension treats a malicious/confused batch as recovery.
  for (let left = 0; left < targetOperations.length; left += 1) {
    for (let right = left + 1; right < targetOperations.length; right += 1) {
      const first = targetOperations[left]!;
      const second = targetOperations[right]!;
      if (first.target === second.target) continue;
      if (
        (
          first.operation.kind === 'children' ||
          first.operation.kind === 'reconcile-children' ||
          second.operation.kind === 'children' ||
          second.operation.kind === 'reconcile-children'
        ) &&
        (containsComposed(first.target, second.target) ||
          containsComposed(second.target, first.target))
      ) return undefined;
    }
  }

  const structuralOperations = operations.filter(
    (operation): operation is StructuralOperation =>
      operation.kind === 'children' || operation.kind === 'reconcile-children',
  );
  if (
    structuralOperations.some(({ kind }) => kind === 'children') &&
    structuralOperations.some(({ kind }) => kind === 'reconcile-children')
  ) return undefined;

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
    const mirrored = [...target.childNodes].filter((child) => hasDomId(state, child));
    oldChildren.set(operation.nodeId, mirrored);
    if (operation.kind === 'children') {
      for (const child of mirrored) collectDomIds(state, child, removedIds);
    }
  }

  const incomingIds = new Set<number>();
  for (const operation of childrenOperations) {
    for (const child of operation.children) {
      if (!collectGraphIds(child, incomingIds) || containsDocumentElement(child)) {
        return undefined;
      }
    }
  }
  for (const id of incomingIds) {
    if (state.nodes.has(id) && !removedIds.has(id)) return undefined;
  }

  const retainedIds = new Set<number>();
  const reconcileGraphIds = new Set<number>();
  for (const operation of reconcileOperations) {
    const target = state.nodes.get(operation.nodeId) as Node;
    const directChildren = new Set(oldChildren.get(operation.nodeId) ?? []);
    for (const entry of operation.children) {
      if (entry.kind === 'retain') {
        const retainedSource = state.nodes.get(entry.nodeId);
        const retained = retainedSource
          ? presentationNodeForMirrorNode(retainedSource)
          : undefined;
        if (
          !retained || retainedIds.has(entry.nodeId) ||
          reconcileGraphIds.has(entry.nodeId) ||
          retained.parentNode !== target || !directChildren.has(retained) ||
          retained.ownerDocument !== target.ownerDocument ||
          !isConnectedReplicaNode(state, retained)
        ) return undefined;
        retainedIds.add(entry.nodeId);
        continue;
      }
      if (
        !collectGraphIds(entry.node, reconcileGraphIds) ||
        containsDocumentElement(entry.node)
      ) {
        return undefined;
      }
    }
  }
  for (const id of reconcileGraphIds) {
    if (state.nodes.has(id) || retainedIds.has(id)) return undefined;
  }

  const allRemovedIds = new Set(removedIds);
  for (const operation of reconcileOperations) {
    for (const child of oldChildren.get(operation.nodeId) ?? []) {
      const childId = findDomNodeId(state, child);
      if (childId !== undefined && retainedIds.has(childId)) continue;
      collectDomIds(state, child, allRemovedIds);
    }
  }
  const prospectiveNodeCount = state.nodes.size - allRemovedIds.size +
    incomingIds.size + reconcileGraphIds.size;
  if (
    prospectiveNodeCount < 0 ||
    prospectiveNodeCount > MAX_HTML_MIRROR_NODES
  ) return undefined;

  const prospectiveText = new Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>(
    [...state.textMetadata].filter(([id]) => !allRemovedIds.has(id)),
  );
  const prospectiveControls = new Map<number, HtmlMirrorControlText>(
    [...state.controlMetadata].filter(([id]) => !allRemovedIds.has(id)),
  );
  for (const operation of childrenOperations) {
    for (const child of operation.children) {
      collectGraphTextState(child, prospectiveText, prospectiveControls);
    }
  }
  for (const operation of reconcileOperations) {
    for (const child of operation.children) {
      if (child.kind === 'graph') {
        collectGraphTextState(child.node, prospectiveText, prospectiveControls);
      }
    }
  }
  for (const [id, node] of parsedText) prospectiveText.set(id, node);
  for (const [id, operation] of attributeOperations) {
    if (operation.controlText) prospectiveControls.set(id, operation.controlText);
    else prospectiveControls.delete(id);
  }
  let prospectiveTextBytes = 0;
  for (const node of prospectiveText.values()) {
    prospectiveTextBytes += node.text.length * 2 + 32;
    if (prospectiveTextBytes > MAX_HTML_MIRROR_BYTES) return undefined;
  }
  for (const control of prospectiveControls.values()) {
    prospectiveTextBytes += control.text.length * 2 + 32;
    if (prospectiveTextBytes > MAX_HTML_MIRROR_BYTES) return undefined;
  }

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
        return undefined;
      }
      const ownerDocument = target.ownerDocument;
      if (!ownerDocument) return undefined;
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
          context.publicMenuRegion,
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
      const ownerDocument = target.ownerDocument;
      if (!ownerDocument) return undefined;
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
          if (!retainedSource) return undefined;
          const retained = presentationNodeForMirrorNode(retainedSource);
          retainedChildren.add(retained);
          desiredChildren.push(retained);
          continue;
        }
        if (!validGraphForContext(
          entry.node,
          context,
          state.fidelityPolicy,
        )) return undefined;
        const built = buildNode(
          ownerDocument,
          entry.node,
          nodes,
          textMetadata,
          controlMetadata,
          ownedAdoptedStyles,
          context.publicMenuRegion,
        );
        if (!built) return undefined;
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
    return undefined;
  }

  const previous = new Map(state.records);
  const forceUpserts = new Set<number>();
  const rollback = capturePatchRollback(state, targetOperations);
  const knownBeforeBatch = new Set(rollback.nodes.values());
  let retainedNodeCount = 0;
  let insertedNodeCount = 0;
  let movedNodeCount = 0;
  let removedNodeCount = 0;
  for (const plan of childrenPlans.values()) {
    for (const child of plan.oldChildren) {
      removedNodeCount += domMirrorNodeCount(child, knownBeforeBatch);
    }
  }
  for (const plan of reconcilePlans.values()) {
    for (const child of plan.oldChildren) {
      if (plan.retainedChildren.has(child)) {
        retainedNodeCount += domMirrorNodeCount(child, knownBeforeBatch);
      } else {
        removedNodeCount += domMirrorNodeCount(child, knownBeforeBatch);
      }
    }
  }
  try {
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
        const previousControl = state.controlMetadata.get(operation.nodeId);
        setAttributes(target as Element, operation.attributes);
        applyElementHints(target as Element, operation);
        state.controlMetadata.delete(operation.nodeId);
        if (operation.controlText) {
          state.controlMetadata.set(operation.nodeId, operation.controlText);
        }
        if (previousControl || operation.controlText) {
          forceUpserts.add(operation.nodeId);
        }
        continue;
      }
      if (operation.kind === 'children') {
        const plan = childrenPlans.get(operation);
        if (!plan) throw new Error('Missing children replacement plan.');
        const retainedAdoptedStyles = [...state.ownedAdoptedStyles].filter(
          (style) => style.parentNode === plan.target,
        );
        for (const child of plan.oldChildren) {
          removeDomTree(state, child);
          child.parentNode?.removeChild(child);
        }
        plan.target.appendChild(plan.fragment);
        for (const style of retainedAdoptedStyles) plan.target.appendChild(style);
        for (const style of plan.ownedAdoptedStyles) {
          state.ownedAdoptedStyles.add(style);
        }
        for (const [id, node] of plan.nodes) state.nodes.set(id, node);
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
        child.parentNode?.removeChild(child);
      }
      for (const style of plan.ownedAdoptedStyles) {
        state.ownedAdoptedStyles.add(style);
      }
      for (const [id, node] of plan.nodes) state.nodes.set(id, node);
      for (const [id, node] of plan.textMetadata) state.textMetadata.set(id, node);
      for (const [id, control] of plan.controlMetadata) {
        state.controlMetadata.set(id, control);
      }
      insertedNodeCount += plan.insertedNodeCount;
      let anchor: ChildNode | null = [...plan.target.childNodes].find(
        (child) => state.ownedAdoptedStyles.has(child as HTMLStyleElement),
      ) ?? null;
      for (let index = plan.desiredChildren.length - 1; index >= 0; index -= 1) {
        const child = plan.desiredChildren[index]!;
        if (
          !plan.stableRetainedChildren.has(child) &&
          (child.parentNode !== plan.target || child.nextSibling !== anchor)
        ) {
          if (plan.retainedChildren.has(child)) movedNodeCount += 1;
          plan.target.insertBefore(child, anchor);
        }
        anchor = child as ChildNode;
      }
      for (const entry of operation.children) {
        if (entry.kind === 'graph') collectTranslatableIds(entry.node, forceUpserts);
      }
    }
    if (!retainedReplicaStateFitsBudget(state)) {
      throw new Error('Replica retained-state budget exceeded.');
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
    return Object.freeze({
      changes: Object.freeze(changes),
      retainedNodeCount,
      insertedNodeCount,
      movedNodeCount,
      removedNodeCount,
    });
  } catch {
    restorePatchRollback(state, rollback);
    return undefined;
  }
}

interface PatchRollbackSnapshot {
  readonly dimensions: HtmlMirrorLiveDimensions;
  readonly nodes: Map<number, Node>;
  readonly textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>;
  readonly controlMetadata: Map<number, HtmlMirrorControlText>;
  readonly records: Map<number, ReplicaSourceTextRecord>;
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

function capturePatchRollback(
  state: HtmlMirrorDomState,
  targets: readonly {
    readonly operation: Exclude<HtmlMirrorPatchOperation, { kind: 'dimensions' }>;
    readonly target: Node;
  }[],
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
      childLists.set(target, Object.freeze([...target.childNodes]));
    } else if (operation.kind === 'attributes') {
      const element = target as Element;
      attributes.set(
        element,
        Object.freeze([...element.attributes].map(
          ({ name, value }) => Object.freeze([name, value] as const),
        )),
      );
      if (isNativeReplicaTextControl(element)) {
        controlValues.set(element, Object.freeze({
          value: element.value,
          placeholder: element.placeholder,
        }));
      } else if (element.localName.toLowerCase() === 'select') {
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
                hostAttributes: Object.freeze([...host.attributes].map(
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
    dimensions: state.dimensions,
    nodes: new Map(state.nodes),
    textMetadata: new Map(state.textMetadata),
    controlMetadata: new Map(state.controlMetadata),
    records: new Map(state.records),
    revisions: new Map(state.revisions),
    ownedAdoptedStyles: new Set(state.ownedAdoptedStyles),
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
  restoreMap(state.nodes, snapshot.nodes);
  restoreMap(state.textMetadata, snapshot.textMetadata);
  restoreMap(state.controlMetadata, snapshot.controlMetadata);
  restoreMap(state.revisions, snapshot.revisions);
  restoreSet(state.ownedAdoptedStyles, snapshot.ownedAdoptedStyles);
  (state as { records: Map<number, ReplicaSourceTextRecord> }).records =
    new Map(snapshot.records);
}

function restoreOptionalAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  try {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  } catch {
    // Continue restoring independent state before requesting recovery.
  }
}

function restoreChildList(target: ParentNode, children: readonly Node[]): void {
  try {
    target.replaceChildren(...children);
    return;
  } catch {
    // Fall through to primitive operations so a host-level replaceChildren
    // failure cannot prevent restoration of this or later independent targets.
  }
  try {
    for (const child of [...target.childNodes]) target.removeChild(child);
    for (const child of children) target.appendChild(child);
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
  for (const attribute of [...target.attributes]) {
    try {
      target.removeAttribute(attribute.name);
    } catch {
      // Continue with remaining attributes and targets.
    }
  }
  for (const [name, value] of attributes) {
    try {
      target.setAttribute(name, value);
    } catch {
      // Continue with remaining attributes and targets.
    }
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
  for (const child of [...node.childNodes]) removeDomTree(state, child);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const shadow = (node as Element).shadowRoot;
    if (shadow) removeDomTree(state, shadow);
  }
  if (state.ownedAdoptedStyles.has(node as HTMLStyleElement)) {
    state.ownedAdoptedStyles.delete(node as HTMLStyleElement);
  }
  for (const [id, candidate] of state.nodes) {
    if (candidate !== node) continue;
    state.nodes.delete(id);
    state.textMetadata.delete(id);
    state.controlMetadata.delete(id);
    state.records.delete(id);
    break;
  }
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
  readonly publicMenuRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
  readonly nativeSelectRegion: boolean;
  readonly nativeSelectParent: false | 'select' | 'optgroup' | 'option';
}

const PUBLIC_DOM_CONTEXT: DomContentContext = Object.freeze({
  privateRegion: false,
  privateAttributeRegion: false,
  publicMenuRegion: false,
  nonContentRegion: false,
  styleRegion: false,
  nativeSelectRegion: false,
  nativeSelectParent: false,
});

function hasDomId(state: HtmlMirrorDomState, node: Node): boolean {
  for (const candidate of state.nodes.values()) {
    if (candidate === node || presentationNodeForMirrorNode(candidate) === node) {
      return true;
    }
  }
  return false;
}

function presentationNodeForMirrorNode(node: Node): Node {
  if (node.nodeType === Node.ELEMENT_NODE) {
    const root = node.getRootNode();
    if (
      root.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      'host' in root &&
      (
        ISOLATED_SELECT_HOSTS.has((root as ShadowRoot).host) ||
        ISOLATED_PUBLIC_MENU_HOSTS.has((root as ShadowRoot).host)
      )
    ) {
      const shadow = root as ShadowRoot;
      const host = shadow.host;
      if (
        (
          ISOLATED_PUBLIC_MENU_HOSTS.has(host) &&
          node.parentNode === shadow
        ) ||
        (node as Element).localName.toLowerCase() === 'select'
      ) return host;
    }
  }
  return node;
}

function isConnectedReplicaNode(state: HtmlMirrorDomState, node: Node): boolean {
  if (node.ownerDocument !== state.iframe.contentDocument) return false;
  let current = node;
  for (let depth = 0; depth <= 64; depth += 1) {
    if (current.isConnected) return true;
    const root = current.nodeType === Node.DOCUMENT_FRAGMENT_NODE &&
      'host' in current
      ? current as ShadowRoot
      : current.getRootNode();
    if (root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE || !('host' in root)) {
      return false;
    }
    const shadow = root as ShadowRoot;
    if (shadow.host.shadowRoot !== shadow) return false;
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

function composedParentElement(node: Node): Element | undefined {
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : undefined;
}

function containsComposed(ancestor: Node, descendant: Node): boolean {
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

function containerContext(
  target: Node,
  pendingAttributes?: readonly (readonly [string, string])[],
): DomContentContext {
  if (target.nodeType === Node.ELEMENT_NODE) {
    const element = target as Element;
    if (!pendingAttributes) return domElementContext(element);
    const inherited = composedParentElement(element)
      ? domElementContext(composedParentElement(element) as Element)
      : PUBLIC_DOM_CONTEXT;
    const attributes = Object.fromEntries(pendingAttributes);
    const tagName = element.localName.toLowerCase();
    return extendDomContentContext(inherited, tagName, attributes);
  }
  const host = target.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in target
    ? (target as ShadowRoot).host
    : undefined;
  return host ? domElementContext(host) : PUBLIC_DOM_CONTEXT;
}

function batchContainerContext(
  state: HtmlMirrorDomState,
  target: Node,
  pending: ReadonlyMap<
    number,
    Extract<HtmlMirrorPatchOperation, { kind: 'attributes' }>
  >,
): DomContentContext {
  let element = target.nodeType === Node.ELEMENT_NODE
    ? target as Element
    : target.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in target
      ? (target as ShadowRoot).host
      : undefined;
  if (!element) return PUBLIC_DOM_CONTEXT;
  const chain: Element[] = [];
  for (; element; element = composedParentElement(element)) chain.push(element);
  let context = PUBLIC_DOM_CONTEXT;
  for (const current of chain.reverse()) {
    const nodeId = findDomNodeId(state, current);
    const attributes = nodeId === undefined
      ? undefined
      : pending.get(nodeId)?.attributes;
    const values = attributes
      ? Object.fromEntries(attributes)
      : Object.fromEntries(
          [...current.attributes].map(({ name, value }) => [name, value]),
        );
    const tagName = current.localName.toLowerCase();
    context = extendDomContentContext(context, tagName, values);
  }
  return context;
}

function findDomNodeId(
  state: HtmlMirrorDomState,
  target: Node,
): number | undefined {
  for (const [nodeId, node] of state.nodes) {
    if (node === target) return nodeId;
  }
  return undefined;
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
    current.privateAttributeRegion !== prospective.privateAttributeRegion ||
    current.publicMenuRegion !== prospective.publicMenuRegion;
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
    const tagName = current.localName.toLowerCase();
    const attributes = Object.fromEntries(
      [...current.attributes].map(({ name, value }) => [name, value]),
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

function validPatchSelectedOptionIndexes(
  state: HtmlMirrorDomState,
  target: Element,
  operation: Extract<HtmlMirrorPatchOperation, { kind: 'attributes' }>,
  operations: readonly HtmlMirrorPatchOperation[],
): boolean {
  if (target.localName.toLowerCase() !== 'select') return false;
  const structural = operations.find(
    (candidate) =>
      (candidate.kind === 'children' || candidate.kind === 'reconcile-children') &&
      candidate.nodeId === operation.nodeId,
  );
  if (
    structural &&
    operations.indexOf(structural) > operations.indexOf(operation)
  ) return false;
  let optionCount: number;
  if (structural?.kind === 'children') {
    optionCount = nativeSelectGraphOptionCount(structural.children);
  } else if (structural?.kind === 'reconcile-children') {
    optionCount = structural.children.reduce((total, child) => {
      if (child.kind === 'graph') {
        return total + nativeSelectGraphOptionCount([child.node]);
      }
      const retained = state.nodes.get(child.nodeId);
      return total + (retained ? nativeSelectDomOptionCount(retained) : 0);
    }, 0);
  } else {
    optionCount = nativeSelectDomOptionCount(target);
  }
  const indexes = operation.selectedOptionIndexes ?? [];
  return indexes.every((index) => index < optionCount) &&
    (
      operation.attributes.some(([name]) => name === 'multiple') ||
      indexes.length <= 1
    );
}

function nativeSelectGraphOptionCount(nodes: readonly HtmlMirrorNode[]): number {
  let count = 0;
  for (const node of nodes) {
    if (node.kind !== 'element') continue;
    if (node.tagName === 'option') {
      count += 1;
    } else if (node.tagName === 'optgroup') {
      count += node.children.filter(
        (child) => child.kind === 'element' && child.tagName === 'option',
      ).length;
    }
  }
  return count;
}

function nativeSelectDomOptionCount(node: Node): number {
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const element = node as Element;
  const tagName = element.localName.toLowerCase();
  if (tagName === 'option') return 1;
  if (tagName === 'optgroup') {
    return [...element.children].filter(
      (child) => child.localName.toLowerCase() === 'option',
    ).length;
  }
  if (tagName !== 'select') return 0;
  return [...element.children].reduce((total, child) => {
    const childTag = child.localName.toLowerCase();
    if (childTag === 'option') return total + 1;
    return childTag === 'optgroup'
      ? total + nativeSelectDomOptionCount(child)
      : total;
  }, 0);
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
  return (!context.privateAttributeRegion || !hasPrivateHtmlMirrorAttribute(node.attributes)) &&
    (!context.publicMenuRegion ||
      (
        node.tagName !== 'link' && node.tagName !== 'style' &&
        !hasPublicMenuResourceAttribute(node.attributes) &&
        node.selectedImageSource === undefined &&
        node.resolvedStyleSheetText === undefined &&
        node.canvasBackgroundColor === undefined &&
        (node.shadowRoot?.adoptedStyleSheets.length ?? 0) === 0
      )) &&
    (!context.privateAttributeRegion || !node.controlText) &&
    (!context.privateAttributeRegion || node.selectedOptionIndexes === undefined) &&
    (!context.privateAttributeRegion || node.selectPickerOpen === undefined) &&
    (!node.controlText || node.controlText.kind !== 'label' ||
      validNativeSelectLabelPlacement(node.tagName, inherited.nativeSelectParent)) &&
    (!isNativeSelectSemanticGraphTag(node.tagName) || !node.shadowRoot) &&
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
  const publicMenuRegion = inherited.publicMenuRegion ||
    (!isNativeSelectSemanticGraphTag(tagName) &&
      isSourcePublicMenuRoleValue(attributes.role));
  return {
    privateRegion,
    publicMenuRegion,
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
  state: HtmlMirrorDomState,
  node: Node,
  ids: Set<number>,
): void {
  for (const [id, candidate] of state.nodes) {
    if (candidate === node) {
      ids.add(id);
      break;
    }
  }
  for (const child of [...node.childNodes]) collectDomIds(state, child, ids);
  if (node.nodeType === Node.ELEMENT_NODE) {
    const shadow = (node as Element).shadowRoot;
    if (shadow) collectDomIds(state, shadow, ids);
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

function containsDocumentElement(node: HtmlMirrorNode): boolean {
  return node.kind === 'element' &&
    (node.tagName === 'html' || node.tagName === 'head' || node.tagName === 'body' ||
      node.children.some(containsDocumentElement) ||
      Boolean(node.shadowRoot?.children.some(containsDocumentElement)));
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

function readDocumentLanguage(state: HtmlMirrorDomState): string | undefined {
  const root = [...state.nodes.values()].find(
    (node) => node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).localName.toLowerCase() === 'html',
  ) as Element | undefined;
  const value = root?.getAttribute('lang')?.trim();
  return value && value.length <= 128 ? value : undefined;
}

function retainedReplicaStateFitsBudget(state: HtmlMirrorDomState): boolean {
  try {
    const root = state.iframe.contentDocument?.documentElement;
    if (!root) return false;
    const pending: Node[] = [root];
    const seen = new Set<Node>();
    let bytes = 0;
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node || seen.has(node)) continue;
      seen.add(node);
      if (seen.size > MAX_HTML_MIRROR_NODES * 3 + 32) return false;
      bytes += 48;
      if (node.nodeType === 3 || node.nodeType === 8) {
        bytes += (node.nodeValue?.length ?? 0) * 2;
      } else if (node.nodeType === 1) {
        const element = node as Element;
        bytes += element.localName.length * 2;
        for (const { name, value } of [...element.attributes]) {
          bytes += (name.length + value.length) * 2 + 16;
          if (bytes > MAX_RETAINED_REPLICA_BYTES) return false;
        }
        if (isNativeReplicaTextControl(element)) {
          bytes += (element.value.length + element.placeholder.length) * 2;
        }
        const shadow = element.shadowRoot;
        if (shadow) pending.push(shadow);
      }
      for (const child of [...node.childNodes]) pending.push(child);
      if (bytes > MAX_RETAINED_REPLICA_BYTES) return false;
    }
    for (const metadata of state.textMetadata.values()) {
      bytes += metadata.text.length * 2 + 32;
      if (bytes > MAX_RETAINED_REPLICA_BYTES) return false;
    }
    for (const control of state.controlMetadata.values()) {
      bytes += control.text.length * 2 + 32;
      if (bytes > MAX_RETAINED_REPLICA_BYTES) return false;
    }
    return state.revisions.size <= 1;
  } catch {
    return false;
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
): () => void {
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
  const currentTarget = event.currentTarget;
  if (
    currentTarget && 'nodeType' in currentTarget &&
    currentTarget.nodeType === Node.DOCUMENT_NODE
  ) closeReadOnlyReplicaDisclosures(currentTarget as Document);
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

export function isTrustedIsolatedShellDocument(
  document: Document | null | undefined,
): document is Document {
  if (!document?.head || !document.body) return false;
  const href = document.location?.href;
  if (typeof href === 'string' && href.length > 0 && href !== 'about:srcdoc') {
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
    iframe.srcdoc = shell;
    mount.append(iframe);
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
          link.removeEventListener('load', onLoad);
          link.removeEventListener('error', onError);
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
        link.addEventListener('load', onLoad, { once: true });
        link.addEventListener('error', onError, { once: true });
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
      const shadow = element.shadowRoot;
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
  for (const cleanup of state.cleanup) {
    try {
      cleanup();
    } catch {
      // Teardown is best effort after document replacement/navigation.
    }
  }
  state.cleanup.clear();
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
  let imageCount = 0;
  let openShadowRootCount = 0;
  let visuallyHiddenCount = 0;
  let selectedImageSourceCount = 0;
  for (const node of state.nodes.values()) {
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).localName.toLowerCase() === 'img'
    ) imageCount += 1;
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in node) {
      openShadowRootCount += 1;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      if (element.getAttribute('data-simul-visually-hidden') === 'v1') {
        visuallyHiddenCount += 1;
      }
      if (element.getAttribute('data-simul-selected-image-source') === 'v1') {
        selectedImageSourceCount += 1;
      }
    }
  }
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
    adoptedStyleCount: state.ownedAdoptedStyles.size,
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
  const knownNodes = new Set(state.nodes.values());
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
        ? [...target.childNodes].reduce(
            (total, child) => total + domMirrorNodeCount(child, knownNodes),
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

function domMirrorNodeCount(node: Node, knownNodes: ReadonlySet<Node>): number {
  let count = knownNodes.has(node) ? 1 : 0;
  for (const child of [...node.childNodes]) {
    count += domMirrorNodeCount(child, knownNodes);
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const shadowRoot = (node as Element).shadowRoot;
    if (shadowRoot) count += domMirrorNodeCount(shadowRoot, knownNodes);
  }
  return count;
}
