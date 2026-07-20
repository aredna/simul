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
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
} from './html-mirror-sanitizer';
import {
  isSourcePrivateContentEditableValue,
  isSourcePrivateRoleValue,
  isSourcePrivateTagName,
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

export const ISOLATED_HTML_SHELL_MARKER = 'isolated-html-v1';
export const ISOLATED_HTML_SHELL = `<!doctype html>
<html><head><meta charset="utf-8" data-simul-owned-shell="charset"><meta name="simul-isolated-shell" content="${ISOLATED_HTML_SHELL_MARKER}" data-simul-owned-shell="marker"><meta http-equiv="Content-Security-Policy" data-simul-owned-shell="csp" content="default-src 'none'; script-src 'none'; worker-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; child-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline' http: https:; font-src http: https: data:"><style data-simul-owned-shell="inert">html,body{margin:0;min-width:100%;min-height:100%;pointer-events:none}*{pointer-events:none!important}</style></head><body></body></html>`;

export type IsolatedMirrorInfoStage =
  | 'connected'
  | 'checkpoint'
  | 'patch'
  | 'recovery'
  | 'failed';

export interface IsolatedMirrorInfo {
  readonly stage: IsolatedMirrorInfoStage;
  readonly code?: ReplicaDiagnosticCode;
  readonly nodeCount: number;
  readonly textCount: number;
  readonly imageCount: number;
  readonly operationCount: number;
  readonly sequence: number;
}

interface IsolatedHtmlEngineOptions {
  readonly presentationHost: ReplayPresentationHost;
  readonly openStream: HtmlMirrorStreamFactory;
  readonly onLiveApplied?: () => void;
  readonly onLayoutChanged?: () => void;
  readonly onSourceCommit?: (commit: ReplicaSourceCommit) => void;
  readonly onLiveFailure?: (code: ReplicaDiagnosticCode) => void;
  readonly onInfo?: (info: IsolatedMirrorInfo) => void;
  readonly iframeDeadlineMs?: number;
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
  readonly nodes: Map<number, Node>;
  readonly textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>;
  readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
  readonly records: Map<number, ReplicaSourceTextRecord>;
  readonly revisions: Map<number, number>;
  sequence: number;
  readonly replayLease: number;
  dimensions: HtmlMirrorCheckpoint['payload'];
  readonly cleanup: Set<() => void>;
  released: boolean;
}

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
    try {
      stream = await this.options.openStream(request, signal);
      if (!this.#isCurrent(runVersion, request, signal)) {
        stream.dispose();
        return this.#skipped('stale_identity');
      }
      this.options.onInfo?.(emptyInfo('connected'));
      const checkpoint = await stream.initialCheckpoint;
      if (!this.#isCurrent(runVersion, request, signal)) {
        stream.dispose();
        return this.#skipped('stale_identity');
      }
      const state = await this.#stageCheckpoint(checkpoint, signal);
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
        onFailure: (code) => this.#onStreamFailure(
          code,
          request,
          runVersion,
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
      this.options.onInfo?.(emptyInfo('failed', code));
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
      if (node?.nodeType === Node.TEXT_NODE) node.nodeValue = record.source;
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
      projection.nodeType !== 3 ||
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
      record.revision !== projection.sourceRevision ||
      record.source !== projection.source ||
      node?.nodeType !== Node.TEXT_NODE
    ) return false;
    node.nodeValue = projection.translated;
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
    signal?: AbortSignal,
  ): Promise<HtmlMirrorDomState> {
    signal?.throwIfAborted();
    const content = readHtmlMirrorDocumentContent(
      checkpoint.payload.root,
      checkpoint.payload.adoptedStyleSheets,
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
    });
    this.#stagingLease = lease;
    const iframe = lease.mount.ownerDocument.createElement('iframe');
    protectIframe(iframe);
    try {
      let iframeDocument: Document;
      if (this.options.initializeIframe) {
        iframe.srcdoc = ISOLATED_HTML_SHELL;
        lease.mount.append(iframe);
        iframeDocument = await this.options.initializeIframe(
          iframe,
          ISOLATED_HTML_SHELL,
          signal,
        );
      } else {
        iframeDocument = await initializeIframeDocument(
          iframe,
          lease.mount,
          ISOLATED_HTML_SHELL,
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
      const ownedAdoptedStyles = new Set<HTMLStyleElement>();
      applyDocumentGraph(
        iframeDocument,
        graph,
        content.adoptedStyleSheets,
        nodes,
        textMetadata,
        ownedAdoptedStyles,
      );
      const document = sourceDocumentIdentity(checkpoint.identity);
      const previous = this.#committed && sameSourceDocument(
        this.#committed.document,
        document,
      ) ? this.#committed : undefined;
      const revisions = new Map(previous?.revisions ?? []);
      const records = buildRecords(
        document,
        textMetadata,
        revisions,
        previous?.records,
      );
      const replayLease = this.#replayLease + 1;
      const state: HtmlMirrorDomState = {
        lease,
        iframe,
        document,
        nodes,
        textMetadata,
        ownedAdoptedStyles,
        records,
        revisions,
        sequence: checkpoint.identity.sequence,
        replayLease,
        dimensions: checkpoint.payload,
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
      this.#requestRecovery('stream_gap');
      return;
    }
    const changes = applyPatchBatch(state, batch.operations);
    if (!changes) {
      this.#requestRecovery('privacy_rejected');
      return;
    }
    state.sequence = batch.lastSequence;
    stream.acknowledge(state.sequence);
    this.options.presentationHost.refreshDimensions?.(state.iframe, state.dimensions);
    this.options.presentationHost.markLive(state.iframe);
    this.#notifySourceCommit(state, 'batch', changes, changesDocumentLanguage(batch));
    this.options.onLiveApplied?.();
    this.#refreshExtent(state);
    this.options.onInfo?.(stateInfo('patch', state, batch.operations.length));
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
    this.#recoveryTask = this.#stageCheckpoint(checkpoint, recoverySignal)
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
  ): void {
    if (!this.#isCurrent(runVersion, request)) return;
    if (code === 'stream_failed') {
      this.#failLive(code);
    } else {
      this.#requestRecovery(code);
    }
  }

  #requestRecovery(code: ReplicaDiagnosticCode): void {
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
    this.options.onInfo?.(stateInfo('recovery', state, 0));
    this.#stream.requestCheckpoint(state.sequence);
  }

  #failLive(code: ReplicaDiagnosticCode): void {
    const state = this.#committed;
    this.options.onInfo?.(
      state && !state.released
        ? stateInfo('failed', state, 0, code)
        : emptyInfo('failed', code),
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
        !record || node?.nodeType !== Node.TEXT_NODE ||
        !sameSourceDocument(projection.document, state.document) ||
        record.source !== projection.source ||
        record.revision !== projection.sourceRevision ||
        projection.translationEpoch !== this.#projectionContext.translationEpoch ||
        projection.pairKey !== this.#projectionContext.pairKey
      ) continue;
      node.nodeValue = projection.translated;
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
  ownedAdoptedStyles: Set<HTMLStyleElement>,
): void {
  const html = target.documentElement;
  const head = target.head;
  const body = target.body;
  if (!html || !head || !body) throw new Error('Incomplete isolated iframe shell.');
  setAttributes(html, root.attributes);
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
    nodes.set(sourceHead.id, head);
    for (const child of sourceHead.children) {
      const built = buildNode(
        target,
        child,
        nodes,
        textMetadata,
        ownedAdoptedStyles,
      );
      if (built) head.append(built);
    }
  }
  body.replaceChildren();
  if (sourceBody) {
    setAttributes(body, sourceBody.attributes);
    nodes.set(sourceBody.id, body);
    for (const child of sourceBody.children) {
      const built = buildNode(
        target,
        child,
        nodes,
        textMetadata,
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
  nodes.set(input.id, node);
  for (const child of input.children) {
    const built = buildNode(
      target,
      child,
      nodes,
      textMetadata,
      ownedAdoptedStyles,
    );
    if (built) node.append(built);
  }
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
  for (const [name, value] of attributes) element.setAttribute(name, value);
}

function buildRecords(
  document: ReplicaSourceDocumentIdentity,
  metadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>,
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
  return records;
}

function applyPatchBatch(
  state: HtmlMirrorDomState,
  operations: readonly HtmlMirrorPatchOperation[],
): readonly ReplicaSourceTextChange[] | undefined {
  interface ChildrenPlan {
    readonly operation: Extract<HtmlMirrorPatchOperation, { kind: 'children' }>;
    readonly target: Node;
    readonly oldChildren: readonly Node[];
    readonly fragment: DocumentFragment;
    readonly nodes: Map<number, Node>;
    readonly textMetadata: Map<number, Extract<HtmlMirrorNode, { kind: 'text' }>>;
    readonly ownedAdoptedStyles: Set<HTMLStyleElement>;
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

  // Validate every target and payload before touching visible state.
  for (const operation of operations) {
    if (operation.kind === 'dimensions') continue;
    const target = state.nodes.get(operation.nodeId);
    if (!target) return undefined;
    targetOperations.push({ operation, target });
    if (operation.kind === 'text') {
      const node = readHtmlMirrorNode(operation.node);
      if (
        target.nodeType !== Node.TEXT_NODE ||
        !node || node.kind !== 'text' || node.id !== operation.nodeId ||
        !validTextForContext(node, domTextContext(target))
      ) return undefined;
      parsedText.set(operation.nodeId, node);
      continue;
    }
    if (operation.kind === 'attributes') {
      if (
        target.nodeType !== Node.ELEMENT_NODE ||
        (target as Element).localName.toLowerCase() !== operation.tagName
      ) return undefined;
      const prospectiveContext = containerContext(target, operation.attributes);
      if (
        prospectiveContext.privateRegion &&
        hasPrivateHtmlMirrorAttribute(operation.attributes)
      ) return undefined;
      try {
        const sentinel = target.ownerDocument?.createElementNS(
          (target as Element).namespaceURI,
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
    if (
      target.nodeType !== Node.ELEMENT_NODE &&
      target.nodeType !== Node.DOCUMENT_FRAGMENT_NODE
    ) return undefined;
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
        (first.operation.kind === 'children' || second.operation.kind === 'children') &&
        (containsComposed(first.target, second.target) ||
          containsComposed(second.target, first.target))
      ) return undefined;
    }
  }

  const removedIds = new Set<number>();
  const childrenOperations = operations.filter(
    (operation): operation is Extract<HtmlMirrorPatchOperation, { kind: 'children' }> =>
      operation.kind === 'children',
  );
  const oldChildren = new Map<number, readonly Node[]>();
  for (const operation of childrenOperations) {
    const target = state.nodes.get(operation.nodeId) as Node;
    const mirrored = [...target.childNodes].filter((child) => hasDomId(state, child));
    oldChildren.set(operation.nodeId, mirrored);
    for (const child of mirrored) collectDomIds(state, child, removedIds);
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

  const childrenPlans: ChildrenPlan[] = [];
  try {
    for (const operation of childrenOperations) {
      const target = state.nodes.get(operation.nodeId) as Node;
      const context = containerContext(
        target,
        attributeOperations.get(operation.nodeId)?.attributes,
      );
      if (!operation.children.every((child) => validGraphForContext(child, context))) {
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
      const ownedAdoptedStyles = new Set<HTMLStyleElement>();
      for (const child of operation.children) {
        const built = buildNode(
          ownerDocument,
          child,
          nodes,
          textMetadata,
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
        ownedAdoptedStyles,
      });
    }
  } catch {
    return undefined;
  }

  const previous = new Map(state.records);
  const forceUpserts = new Set<number>();
  try {
    for (const operation of operations) {
      if (operation.kind === 'dimensions') {
        state.dimensions = {
          ...state.dimensions,
          viewportWidth: operation.viewportWidth,
          viewportHeight: operation.viewportHeight,
          documentWidth: operation.documentWidth,
          documentHeight: operation.documentHeight,
        };
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
        setAttributes(target as Element, operation.attributes);
        continue;
      }
      const plan = childrenPlans.find(
        ({ operation: candidate }) => candidate === operation,
      );
      if (!plan) return undefined;
      const retainedAdoptedStyles = [...state.ownedAdoptedStyles].filter(
        (style) => style.parentNode === plan.target,
      );
      for (const child of plan.oldChildren) {
        removeDomTree(state, child);
        child.parentNode?.removeChild(child);
      }
      plan.target.appendChild(plan.fragment);
      for (const style of retainedAdoptedStyles) {
        plan.target.appendChild(style);
      }
      for (const style of plan.ownedAdoptedStyles) {
        state.ownedAdoptedStyles.add(style);
      }
      for (const [id, node] of plan.nodes) state.nodes.set(id, node);
      for (const [id, node] of plan.textMetadata) {
        state.textMetadata.set(id, node);
      }
      for (const child of operation.children) collectTranslatableIds(child, forceUpserts);
    }
  } catch {
    return undefined;
  }
  const next = buildRecords(state.document, state.textMetadata, state.revisions, previous);
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
    if (!old || old.source !== record.source || forceUpserts.has(record.nodeId)) {
      changes.push(Object.freeze({ kind: 'upsert', record }));
    }
  }
  return Object.freeze(changes);
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
    state.records.delete(id);
    break;
  }
}

function collectTranslatableIds(node: HtmlMirrorNode, ids: Set<number>): void {
  if (node.kind === 'text') {
    if (node.translatable) ids.add(node.id);
    return;
  }
  if (node.shadowRoot) {
    for (const child of node.shadowRoot.children) collectTranslatableIds(child, ids);
  }
  for (const child of node.children) collectTranslatableIds(child, ids);
}

interface DomContentContext {
  readonly privateRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
}

const PUBLIC_DOM_CONTEXT: DomContentContext = Object.freeze({
  privateRegion: false,
  nonContentRegion: false,
  styleRegion: false,
});

function hasDomId(state: HtmlMirrorDomState, node: Node): boolean {
  for (const candidate of state.nodes.values()) {
    if (candidate === node) return true;
  }
  return false;
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
    return {
      privateRegion: inherited.privateRegion ||
        isSourcePrivateTagName(tagName) || tagName === 'button' ||
        isSourcePrivateContentEditableValue(attributes.contenteditable) ||
        isSourcePrivateRoleValue(attributes.role),
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

function domTextContext(node: Node): DomContentContext {
  const parent = composedParentElement(node);
  return parent
    ? domElementContext(parent)
    : PUBLIC_DOM_CONTEXT;
}

function domElementContext(element: Element): DomContentContext {
  let privateRegion = false;
  let nonContentRegion = false;
  let styleRegion = false;
  for (
    let current: Element | undefined = element;
    current;
    current = composedParentElement(current)
  ) {
    const tagName = current.localName.toLowerCase();
    privateRegion ||= isSourcePrivateTagName(tagName) || tagName === 'button' ||
      isSourcePrivateContentEditableValue(
        current.hasAttribute('contenteditable')
          ? current.getAttribute('contenteditable') ?? ''
          : undefined,
      ) || isSourcePrivateRoleValue(current.getAttribute('role'));
    nonContentRegion ||= tagName === 'head' || tagName === 'style' || tagName === 'title';
    styleRegion ||= tagName === 'style';
  }
  return { privateRegion, nonContentRegion, styleRegion };
}

function validGraphForContext(
  node: HtmlMirrorNode,
  inherited: DomContentContext,
): boolean {
  if (node.kind === 'text') return validTextForContext(node, inherited);
  const attributes = Object.fromEntries(node.attributes);
  const privateRegion = inherited.privateRegion ||
    isSourcePrivateTagName(node.tagName) || node.tagName === 'button' ||
    isSourcePrivateContentEditableValue(attributes.contenteditable) ||
    isSourcePrivateRoleValue(attributes.role);
  const nonContentRegion = inherited.nonContentRegion ||
    node.tagName === 'head' || node.tagName === 'style' || node.tagName === 'title';
  const styleRegion = inherited.styleRegion || node.tagName === 'style';
  const context = {
    privateRegion,
    nonContentRegion,
    styleRegion,
  };
  return node.children.every((child) => validGraphForContext(child, context)) &&
    (!node.shadowRoot || node.shadowRoot.children.every(
      (child) => validGraphForContext(child, context),
    ));
}

function validTextForContext(
  node: Extract<HtmlMirrorNode, { kind: 'text' }>,
  context: DomContentContext,
): boolean {
  return (!context.privateRegion || node.text === '') &&
    (!(context.privateRegion || context.nonContentRegion) || !node.translatable) &&
    (!context.styleRegion || sanitizeCss(node.text, 'about:blank') === node.text);
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
): IsolatedMirrorInfo {
  let imageCount = 0;
  for (const node of state.nodes.values()) {
    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).localName.toLowerCase() === 'img'
    ) imageCount += 1;
  }
  return Object.freeze({
    stage,
    ...(code ? { code } : {}),
    nodeCount: state.nodes.size,
    textCount: state.records.size,
    imageCount,
    operationCount,
    sequence: state.sequence,
  });
}

function emptyInfo(
  stage: IsolatedMirrorInfoStage,
  code?: ReplicaDiagnosticCode,
): IsolatedMirrorInfo {
  return Object.freeze({
    stage,
    ...(code ? { code } : {}),
    nodeCount: 0,
    textCount: 0,
    imageCount: 0,
    operationCount: 0,
    sequence: 0,
  });
}
