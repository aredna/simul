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
  hasPrivateHtmlMirrorAttribute,
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
  sourceElementStartsPrivateRegion,
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

export const ISOLATED_HTML_SHELL_MARKER = 'isolated-html-v1';
const ISOLATED_HTML_SHELL_DOCUMENT = `<html><head><meta charset="utf-8" data-simul-owned-shell="charset"><meta name="simul-isolated-shell" content="${ISOLATED_HTML_SHELL_MARKER}" data-simul-owned-shell="marker"><meta http-equiv="Content-Security-Policy" data-simul-owned-shell="csp" content="default-src 'none'; script-src 'none'; worker-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline' http: https: data:; font-src http: https: data:"><style data-simul-owned-shell="inert">html,body{margin:0;min-width:100%;min-height:100%;pointer-events:none}*{pointer-events:none!important}</style></head><body></body></html>`;
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
  readonly onLiveApplied?: () => void;
  readonly onLayoutChanged?: () => void;
  readonly onSourceCommit?: (commit: ReplicaSourceCommit) => void;
  readonly onLiveFailure?: (code: ReplicaDiagnosticCode) => void;
  readonly onInfo?: (info: IsolatedMirrorInfo) => void;
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

  constructor(private readonly options: IsolatedHtmlEngineOptions) {}

  async run(
    request: ReplicaCaptureRequest,
    signal?: AbortSignal,
  ): Promise<ReplicaRunResult> {
    if (this.#disposed) return this.#failed('stream_failed');
    const runVersion = ++this.#runVersion;
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
      this.#commitState(state, 'checkpoint');
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
      records: Object.freeze([...state.records.values()]),
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
      applyDocumentGraph(
        iframeDocument,
        graph,
        content.adoptedStyleSheets,
        nodes,
        textMetadata,
        controlMetadata,
        ownedAdoptedStyles,
      );
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
      const revisions = new Map(previous?.revisions ?? []);
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
      installStateLayoutObservers(state, () => this.#refreshExtent(state));
      this.#applyRetainedProjections(state);
      this.#stagingLease = undefined;
      this.#candidate = state;
      return state;
    } catch (error) {
      if (this.#stagingLease === lease) this.#stagingLease = undefined;
      lease.release();
      throw error;
    }
  }

  #commitState(
    state: HtmlMirrorDomState,
    reason: ReplicaSourceCommit['reason'],
  ): void {
    const extent = measureExtent(state.iframe);
    state.lease.commit(state.iframe, extent);
    const previous = this.#committed;
    const previousLanguage = previous && !previous.released
      ? readDocumentLanguage(previous)
      : undefined;
    const changes = checkpointChanges(state, previous);
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
    const applied = applyPatchBatch(state, batch.operations);
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
    this.#notifySourceCommit(
      state,
      'batch',
      applied.changes,
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
        this.#commitState(state, 'recovery');
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
        records: Object.freeze([...state.records.values()]),
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
  }

  #refreshExtent(state: HtmlMirrorDomState): void {
    if (this.#committed !== state || state.released) return;
    queueMicrotask(() => {
      if (this.#committed !== state || state.released) return;
      this.options.presentationHost.refreshExtent(state.iframe, measureExtent(state.iframe));
      this.options.onLayoutChanged?.();
    });
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
  setAttributes(node, input.attributes);
  applyElementHints(node, input);
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
    if (built) node.append(built);
  }
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
  return node;
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
    | 'controlText'
    | 'canvasBackgroundColor'
    | 'resolvedStyleSheetText'
  >,
): void {
  applyControlText(element, hints.controlText);
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
  if (!hints.visuallyHidden || !styled.style) return;
  element.setAttribute('data-simul-visually-hidden', 'v1');
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
    revisions.set(node.id, revision);
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
    revisions.set(nodeId, revision);
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
    readonly operation: Extract<StructuralOperation, { kind: 'children' }>;
    readonly target: Node;
    readonly oldChildren: readonly Node[];
    readonly fragment: DocumentFragment;
    readonly nodes: Map<number, Node>;
    readonly textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>;
    readonly controlMetadata: Map<number, HtmlMirrorControlText>;
    readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
  }
  interface ReconcilePlan {
    readonly operation: Extract<StructuralOperation, { kind: 'reconcile-children' }>;
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
    targetOperations.push({ operation, target });
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
        operation.controlText &&
        (
          currentContext.privateAttributeRegion ||
          prospectiveContext.privateAttributeRegion ||
          currentContext.nonContentRegion ||
          prospectiveContext.nonContentRegion
        )
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
        const retained = state.nodes.get(entry.nodeId);
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

  const childrenPlans: ChildrenPlan[] = [];
  const reconcilePlans: ReconcilePlan[] = [];
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
        );
        if (built) fragment.append(built);
      }
      childrenPlans.push({
        operation,
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
          const retained = state.nodes.get(entry.nodeId);
          if (!retained) return undefined;
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
        );
        if (!built) return undefined;
        insertedNodeCount += htmlMirrorGraphNodeCount(entry.node);
        desiredChildren.push(built);
      }
      reconcilePlans.push({
        operation,
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
  for (const plan of childrenPlans) {
    for (const child of plan.oldChildren) {
      removedNodeCount += domMirrorNodeCount(child, knownBeforeBatch);
    }
  }
  for (const plan of reconcilePlans) {
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
        const plan = childrenPlans.find(
          ({ operation: candidate }) => candidate === operation,
        );
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
      const plan = reconcilePlans.find(
        ({ operation: candidate }) => candidate === operation,
      );
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
      state.revisions.set(old.nodeId, revision);
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
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
}

const PUBLIC_DOM_CONTEXT: DomContentContext = Object.freeze({
  privateRegion: false,
  privateAttributeRegion: false,
  nonContentRegion: false,
  styleRegion: false,
});

function hasDomId(state: HtmlMirrorDomState, node: Node): boolean {
  for (const candidate of state.nodes.values()) {
    if (candidate === node) return true;
  }
  return false;
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
    const privateRegion = inherited.privateRegion ||
      sourceElementStartsPrivateRegion(tagName, attributes);
    return {
      privateRegion,
      privateAttributeRegion: inherited.privateAttributeRegion ||
        privateRegion ||
        isSourceActivationTagName(tagName) ||
        isSourceActivationRoleValue(attributes.role),
      nonContentRegion: inherited.nonContentRegion ||
        tagName === 'head' || tagName === 'style' || tagName === 'title',
      styleRegion: inherited.styleRegion || tagName === 'style',
    };
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
  let privateRegion = false;
  let privateAttributeRegion = false;
  let nonContentRegion = false;
  let styleRegion = false;
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
    const currentPrivate = sourceElementStartsPrivateRegion(tagName, values);
    privateRegion ||= currentPrivate;
    privateAttributeRegion ||= currentPrivate ||
      isSourceActivationTagName(tagName) ||
      isSourceActivationRoleValue(values.role);
    nonContentRegion ||= tagName === 'head' || tagName === 'style' ||
      tagName === 'title';
    styleRegion ||= tagName === 'style';
  }
  return { privateRegion, privateAttributeRegion, nonContentRegion, styleRegion };
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
    current.privateAttributeRegion !== prospective.privateAttributeRegion;
}

function domElementContext(element: Element): DomContentContext {
  let privateRegion = false;
  let privateAttributeRegion = false;
  let nonContentRegion = false;
  let styleRegion = false;
  for (
    let current: Element | undefined = element;
    current;
    current = composedParentElement(current)
  ) {
    const tagName = current.localName.toLowerCase();
    const attributes = Object.fromEntries(
      [...current.attributes].map(({ name, value }) => [name, value]),
    );
    const currentPrivateRegion = sourceElementStartsPrivateRegion(
      tagName,
      attributes,
    );
    privateRegion ||= currentPrivateRegion;
    privateAttributeRegion ||= currentPrivateRegion ||
      isSourceActivationTagName(tagName) ||
      isSourceActivationRoleValue(current.getAttribute('role'));
    nonContentRegion ||= tagName === 'head' || tagName === 'style' || tagName === 'title';
    styleRegion ||= tagName === 'style';
  }
  return { privateRegion, privateAttributeRegion, nonContentRegion, styleRegion };
}

function validGraphForContext(
  node: HtmlMirrorNode,
  inherited: DomContentContext,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  if (node.kind === 'text') {
    return validTextForContext(node, inherited, fidelityPolicy);
  }
  const attributes = Object.fromEntries(node.attributes);
  const privateRegion = inherited.privateRegion ||
    sourceElementStartsPrivateRegion(node.tagName, attributes);
  const privateAttributeRegion = inherited.privateAttributeRegion ||
    privateRegion ||
    isSourceActivationTagName(node.tagName) ||
    isSourceActivationRoleValue(attributes.role);
  const nonContentRegion = inherited.nonContentRegion ||
    node.tagName === 'head' || node.tagName === 'style' || node.tagName === 'title';
  const styleRegion = inherited.styleRegion || node.tagName === 'style';
  const context = {
    privateRegion,
    privateAttributeRegion,
    nonContentRegion,
    styleRegion,
  };
  return (!privateAttributeRegion || !hasPrivateHtmlMirrorAttribute(node.attributes)) &&
    (!privateAttributeRegion || !node.controlText) &&
    node.children.every(
      (child) => validGraphForContext(child, context, fidelityPolicy),
    ) &&
    (!node.shadowRoot || node.shadowRoot.children.every(
      (child) => validGraphForContext(child, context, fidelityPolicy),
    ));
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
      state.revisions.set(record.nodeId, revision);
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

function readDocumentLanguage(state: HtmlMirrorDomState): string | undefined {
  const root = [...state.nodes.values()].find(
    (node) => node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).localName.toLowerCase() === 'html',
  ) as Element | undefined;
  const value = root?.getAttribute('lang')?.trim();
  return value && value.length <= 128 ? value : undefined;
}

function nextRevision(revisions: Map<number, number>, nodeId: number): number {
  const next = (revisions.get(nodeId) ?? 0) + 1;
  return Number.isSafeInteger(next) ? next : 1;
}

function protectIframe(iframe: HTMLIFrameElement): void {
  iframe.setAttribute('sandbox', 'allow-same-origin');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.setAttribute('inert', '');
  iframe.setAttribute('tabindex', '-1');
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.style.pointerEvents = 'none';
  iframe.style.border = '0';
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
