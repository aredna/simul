import type { SourceImageDescriptor } from './contracts';
import {
  readImageSourceControllerMessage,
  readImageSourcePortSessionId,
  type ImageSourceRecorderMessage,
  type SourceImageAccessibilityTextEvidence,
  type SourceImageCaptureMetrics,
} from './image-source-protocol';
import { SourceImageModel } from './source-image-model';
import {
  SourceImageObserver,
  type SourceImageObservationEvent,
  type SourceImageObserverEnvironment,
} from './source-image-observer';
import {
  createSourceControlledContentPolicy,
  hasSourceControlOrEditableElementAncestor,
  hasSourceCredentialSecretAncestor,
  readSourceFlatTreeElementPath,
  sourceControlledContentLayoutMayChange,
  sourceControlledContentMutationsMayChange,
  sourceControlledContentIsWithheld,
  type SourceControlledContentPolicy,
} from '../replica/source-privacy-policy';
import {
  sourceDocumentSecretClassifier,
  type StickySourceSecretClassifier,
} from '../replica/source-secret-classifier';
import type { ReplicaSourceDocumentIdentity } from '../replica/source-identity';
import { canonicalizeLanguageTag } from '../translation-provider';
import { normalizeAccessibilityImageText } from './accessibility-image-text';
import {
  imageTransformIsAxisAligned,
  styleAllowsImageCapture,
} from './image-capture-style';

interface MessageEventPort {
  addListener(listener: (message: unknown) => void): void;
  removeListener(listener: (message: unknown) => void): void;
}

interface DisconnectEventPort {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
}

export interface ImageSourcePort {
  readonly name: string;
  readonly onMessage: MessageEventPort;
  readonly onDisconnect: DisconnectEventPort;
  postMessage(message: ImageSourceRecorderMessage): void;
  disconnect(): void;
}

export interface ImageSourceSessionEnvironment {
  readonly port: ImageSourcePort;
  readonly document: Document;
  readonly window: Window;
  readonly resolveNode: (nodeId: number) => Node | null;
  readonly createObserver: (
    environment: SourceImageObserverEnvironment,
  ) => SourceImageObserver;
  readonly getNodeId: (image: HTMLImageElement) => number | undefined;
  /** Share one sticky classifier for the lifetime of the source document. */
  readonly secretClassifier?: StickySourceSecretClassifier;
  readonly onDispose?: () => void;
}

/**
 * Document-targeted image facts and capture metrics. The session never emits
 * URLs, pixels, text, or source tokens and is torn down with its Port.
 */
export class ImageSourceSession {
  readonly #sessionId: string;
  #documentIdentity: ReplicaSourceDocumentIdentity | undefined;
  #model: SourceImageModel | undefined;
  #observer: SourceImageObserver | undefined;
  readonly #secretClassifier: StickySourceSecretClassifier;
  #controlledContentPolicy: SourceControlledContentPolicy | undefined;
  #policyFingerprint: string | undefined;
  #controlImages = false;
  #accessibilityTextEnabled = false;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(private readonly environment: ImageSourceSessionEnvironment) {
    const sessionId = readImageSourcePortSessionId(environment.port.name);
    if (!sessionId) throw new Error('Invalid image source Port.');
    this.#sessionId = sessionId;
    this.#secretClassifier = environment.secretClassifier ??
      sourceDocumentSecretClassifier(environment.document);
    environment.port.onMessage.addListener(this.#onMessage);
    environment.port.onDisconnect.addListener(this.#onDisconnect);
  }

  dispose(disconnect = false): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.environment.port.onMessage.removeListener(this.#onMessage);
    this.environment.port.onDisconnect.removeListener(this.#onDisconnect);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#observer?.dispose();
    this.#observer = undefined;
    this.#model?.clear();
    this.#model = undefined;
    this.#documentIdentity = undefined;
    this.#controlledContentPolicy = undefined;
    try {
      this.environment.onDispose?.();
    } catch {
      // Disposal remains final even when an owner cleanup callback fails.
    }
    if (disconnect) {
      try {
        this.environment.port.disconnect();
      } catch {
        // The source document may already have destroyed the Port.
      }
    }
  }

  /** Re-scan the same document after its owning identity source advances. */
  refresh(): void {
    if (this.#disposed) return;
    this.#observer?.refreshAll();
  }

  /** Re-prove image admission and capture safety after a CSSOM-only change. */
  refreshAfterStyleChange(): void {
    if (this.#disposed) return;
    this.#observer?.refreshAfterStyleChange();
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed) return;
    const message = readImageSourceControllerMessage(
      input,
      this.#sessionId,
      this.#documentIdentity,
    );
    if (!message) {
      this.dispose(true);
      return;
    }
    if (message.kind === 'simul:image-source-v2:start') {
      if (this.#documentIdentity) {
        this.dispose(true);
        return;
      }
      this.#start(
        message.document,
        message.policyFingerprint,
        message.controlImages === true,
        message.accessibilityTextEnabled === true,
      );
      return;
    }
    if (!this.#documentIdentity || !this.#model || !this.#observer) {
      this.dispose(true);
      return;
    }
    const requestedNode = this.environment.resolveNode(message.descriptor.nodeId);
    if (isImageElement(requestedNode)) {
      this.#observer.refreshImage(requestedNode);
    }
    const descriptor = this.#model.get(message.descriptor.nodeId);
    if (!descriptor || !this.#model.isCurrent(message.descriptor)) {
      this.#post(message.kind === 'simul:image-source-v2:accessibility-text'
        ? {
            kind: message.kind,
            requestId: message.requestId,
            descriptor: message.descriptor,
            status: 'stale',
          }
        : {
            kind: 'simul:image-source-v2:metrics',
            requestId: message.requestId,
            status: 'stale',
          });
      return;
    }
    if (message.kind === 'simul:image-source-v2:accessibility-text') {
      if (
        !this.#accessibilityTextEnabled ||
        message.policyFingerprint !== this.#policyFingerprint ||
        message.controlImages !== this.#controlImages
      ) {
        this.#post({
          kind: message.kind,
          requestId: message.requestId,
          descriptor,
          status: 'blocked',
        });
        return;
      }
      const result = this.#readAccessibilityText(
        descriptor,
        message.controlImages,
      );
      this.#post(result.status === 'ready'
        ? {
            kind: message.kind,
            requestId: message.requestId,
            descriptor,
            status: 'ready',
            evidence: result.evidence,
          }
        : {
            kind: message.kind,
            requestId: message.requestId,
            descriptor,
            status: result.status,
          });
      return;
    }
    const metrics = this.#measure(descriptor);
    this.#post(metrics
      ? {
          kind: 'simul:image-source-v2:metrics',
          requestId: message.requestId,
          status: 'ready',
          metrics,
        }
      : {
          kind: 'simul:image-source-v2:metrics',
          requestId: message.requestId,
          status: 'hidden',
        });
  };

  readonly #onDisconnect = (): void => this.dispose(false);

  #start(
    documentIdentity: ReplicaSourceDocumentIdentity,
    policyFingerprint?: string,
    controlImages = false,
    accessibilityTextEnabled = false,
  ): void {
    const model = new SourceImageModel();
    if (!model.beginDocument(documentIdentity)) {
      this.dispose(true);
      return;
    }
    this.#documentIdentity = documentIdentity;
    this.#policyFingerprint = policyFingerprint;
    this.#controlImages = controlImages;
    this.#accessibilityTextEnabled = accessibilityTextEnabled;
    this.#model = model;
    this.#refreshControlledContentPolicy();
    try {
      const observer = this.environment.createObserver({
        document: this.environment.document,
        documentIdentity,
        getNodeId: this.environment.getNodeId,
        createIntersectionObserver: (callback, options) =>
          new IntersectionObserver(
            callback as IntersectionObserverCallback,
            options,
          ),
        createResizeObserver: (callback) =>
          new ResizeObserver(
            callback as ResizeObserverCallback,
          ),
        createMutationObserver: (callback) =>
          new MutationObserver(
            callback as MutationCallback,
          ),
        beforeRefreshAll: () => this.#refreshControlledContentPolicy(),
        beforeMutationRead: (records) =>
          this.#refreshControlledContentPolicyForMutations(records),
        layoutSettleRequiresRefreshAll: (target) =>
          this.#controlledContentLayoutMayChange(target),
        isPrivateImage: (image: HTMLImageElement) =>
          this.#hasStickySecretAncestor(image) ||
          (!this.#controlImages &&
            (
              hasSourceControlOrEditableElementAncestor(image) ||
              this.#imageIsInWithheldControlledContent(image)
            )),
      });
      this.#observer = observer;
      this.#unsubscribe = observer.subscribe(this.#onObservation);
      this.#post({
        kind: 'simul:image-source-v2:ready',
        document: documentIdentity,
        summary: observer.readySummary,
      });
    } catch {
      this.dispose(true);
    }
  }

  readonly #onObservation = (event: SourceImageObservationEvent): void => {
    const model = this.#model;
    if (!model || this.#disposed) return;
    const result = event.kind === 'upsert'
      ? model.upsert(event.input)
      : model.remove(event.document, event.nodeId);
    if (result.status !== 'changed') return;
    this.#post({ kind: 'simul:image-source-v2:change', change: result.change });
  };

  #measure(descriptor: SourceImageDescriptor): SourceImageCaptureMetrics | undefined {
    const node = this.environment.resolveNode(descriptor.nodeId);
    if (!isImageElement(node) || !node.isConnected) return undefined;
    if (this.#hasStickySecretAncestor(node)) return undefined;
    if (
      !this.#controlImages &&
      (
        hasSourceControlOrEditableElementAncestor(node) ||
        this.#imageIsInWithheldControlledContent(node)
      )
    ) return undefined;
    const rect = node.getBoundingClientRect();
    const viewportWidth = finitePositive(this.environment.window.innerWidth);
    const viewportHeight = finitePositive(this.environment.window.innerHeight);
    const width = finitePositive(rect.width);
    const height = finitePositive(rect.height);
    if (!viewportWidth || !viewportHeight || !width || !height) return undefined;
    const left = finiteNumber(rect.left);
    const top = finiteNumber(rect.top);
    if (left === undefined || top === undefined) return undefined;
    if (
      left >= viewportWidth ||
      top >= viewportHeight ||
      left + width <= 0 ||
      top + height <= 0
    ) return undefined;
    if (!hasSafeCaptureGeometry(
      node,
      rect,
      this.environment.document,
      this.environment.window,
      {
        allowControlImages: this.#controlImages,
        isSecret: (candidate) => this.#hasStickySecretAncestor(candidate),
      },
    )) return undefined;
    const nearestElementLanguage = nearestValidElementLanguage(node);
    return Object.freeze({
      document: descriptor.document,
      nodeId: descriptor.nodeId,
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
      left,
      top,
      width,
      height,
      viewportWidth,
      viewportHeight,
      scrollX: boundedScroll(this.environment.window.scrollX),
      scrollY: boundedScroll(this.environment.window.scrollY),
      devicePixelRatio: boundedRatio(this.environment.window.devicePixelRatio),
      ...(nearestElementLanguage
        ? { nearestElementLanguage }
        : {}),
    });
  }

  #readAccessibilityText(
    descriptor: SourceImageDescriptor,
    controlImages: boolean,
  ):
    | { readonly status: 'ready'; readonly evidence: SourceImageAccessibilityTextEvidence }
    | { readonly status: 'none' | 'blocked' } {
    const node = this.environment.resolveNode(descriptor.nodeId);
    if (!isImageElement(node) || !node.isConnected) return { status: 'blocked' };
    if (this.#hasStickySecretAncestor(node)) return { status: 'blocked' };
    if (!controlImages && (
      hasSourceControlOrEditableElementAncestor(node) ||
      this.#imageIsInWithheldControlledContent(node)
    )) {
      return { status: 'blocked' };
    }
    if (!imageAccessibilityTextIsVisible(node, this.environment.window)) {
      return { status: 'blocked' };
    }
    let rect: DOMRect;
    try {
      rect = node.getBoundingClientRect();
    } catch {
      return { status: 'blocked' };
    }
    if (hasProtectedSiblingOverlap(
      node,
      rect,
      this.environment.document,
      this.environment.window,
      (candidate) => this.#hasStickySecretAncestor(candidate),
    )) return { status: 'blocked' };
    const direct = readDirectImageAccessibilityText(node);
    if (!direct) return { status: 'none' };
    const nearestElementLanguage = nearestValidElementLanguage(node);
    return {
      status: 'ready',
      evidence: Object.freeze({
        document: descriptor.document,
        nodeId: descriptor.nodeId,
        contentRevision: descriptor.contentRevision,
        observationRevision: descriptor.observationRevision,
        text: direct.text,
        source: direct.source,
        ...(nearestElementLanguage ? { nearestElementLanguage } : {}),
      }),
    };
  }

  #hasStickySecretAncestor(element: Element): boolean {
    return hasSourceCredentialSecretAncestor(element, this.#secretClassifier);
  }

  #refreshControlledContentPolicy(): void {
    this.#controlledContentPolicy = this.#controlImages
      ? undefined
      : createSourceControlledContentPolicy(
          this.environment.document,
          this.environment.window,
        );
  }

  /**
   * Refresh a relationship index before the observer can discover or inspect
   * any image affected by the same mutation delivery. A false result is still
   * a prepared decision: the observer must not apply its generic relationship
   * fallback to a batch proven irrelevant to this read capability.
   */
  #refreshControlledContentPolicyForMutations(
    records: readonly MutationRecord[],
  ): boolean {
    // Relationship state is deliberately irrelevant when the user permits
    // control images. Returning a prepared `false` suppresses the observer's
    // conservative aria-controls/id global fallback while leaving ordinary
    // targeted style and geometry refreshes intact.
    if (this.#controlImages) return false;
    const current = this.#controlledContentPolicy;
    if (
      current &&
      !sourceControlledContentMutationsMayChange(records, current)
    ) return false;
    this.#refreshControlledContentPolicy();
    return true;
  }

  /**
   * A transition inside, around, or above a known controller/target can change
   * painted tab proof without another DOM mutation. Unrelated carousel tracks
   * stay on the targeted settle path and do not rebuild the relationship map.
   */
  #controlledContentLayoutMayChange(target: Element): boolean {
    if (this.#controlImages) return false;
    const policy = this.#controlledContentPolicy;
    return !policy || sourceControlledContentLayoutMayChange(target, policy);
  }

  #imageIsInWithheldControlledContent(element: Element): boolean {
    return hasSourceAriaControlledRegionAncestor(
      element,
      this.#controlledContentPolicy,
    );
  }

  #post(message: ImageSourceRecorderMessage): void {
    if (this.#disposed) return;
    try {
      this.environment.port.postMessage(message);
    } catch {
      this.dispose(false);
    }
  }
}

export function readDirectImageAccessibilityText(
  image: HTMLImageElement,
): { readonly text: string; readonly source: 'aria-label' | 'alt' } | undefined {
  if (imageIsAccessibilityDecorative(image)) return undefined;
  for (const source of ['aria-label', 'alt'] as const) {
    let raw: string | null;
    try {
      raw = image.getAttribute(source);
    } catch {
      return undefined;
    }
    const text = normalizeAccessibilityImageText(raw);
    if (text) return Object.freeze({ text, source });
  }
  return undefined;
}

function imageAccessibilityTextIsVisible(
  image: HTMLImageElement,
  sourceWindow: Window,
): boolean {
  if (imageIsAccessibilityDecorative(image)) return false;
  const path = readSourceFlatTreeElementPath(image);
  if (!path) return false;
  for (const current of path) {
    if (current.hasAttribute('hidden') ||
      current.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') {
      return false;
    }
    const style = safeComputedStyle(sourceWindow, current);
    if (!style || !styleAllowsImageCapture(style)) return false;
  }
  const rect = image.getBoundingClientRect();
  return finitePositive(rect.width) !== undefined &&
    finitePositive(rect.height) !== undefined;
}

function imageIsAccessibilityDecorative(image: HTMLImageElement): boolean {
  try {
    const path = readSourceFlatTreeElementPath(image);
    if (!path) return true;
    for (const current of path) {
      if (current.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true') {
        return true;
      }
    }
    const roles = image.getAttribute('role')?.trim().toLowerCase().split(/\s+/u) ?? [];
    return roles.includes('none') || roles.includes('presentation');
  } catch {
    return true;
  }
}

/** Images inside any region named by aria-controls obey controlImages too. */
export function hasSourceAriaControlledRegionAncestor(
  element: Element,
  policy: SourceControlledContentPolicy = createSourceControlledContentPolicy(
    element.ownerDocument,
    element.ownerDocument.defaultView,
  ),
): boolean {
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  if (policy.overflow) return true;
  return path.some((current) =>
    sourceControlledContentIsWithheld(current, policy)
  );
}

export const MAX_CAPTURE_OVERLAP_ELEMENTS = 50_000;
/** Bounded descent through open shadow roots under a covering element. */
const MAX_TEXT_COVER_SHADOW_DEPTH = 16;

/** Skip invalid lang values and continue outward to the nearest valid hint. */
export function nearestValidElementLanguage(
  element: Element,
): ReturnType<typeof canonicalizeLanguageTag> {
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return undefined;
  for (const current of path) {
    if (!current.hasAttribute('lang')) continue;
    const language = canonicalizeLanguageTag(
      current.getAttribute('lang') ?? undefined,
    );
    if (language) return language;
  }
  return undefined;
}

/**
 * captureVisibleTab sees painted viewport pixels, not the `<img>` bitmap in
 * isolation. Reject geometry that cannot be mapped safely, intersects a
 * credential-secret control, or is covered by foreign text, rather than
 * OCRing unrelated/secret pixels.
 */
export function hasSafeCaptureGeometry(
  image: HTMLImageElement,
  imageRect: DOMRect,
  sourceDocument: Document,
  sourceWindow: Window,
  options: {
    readonly allowControlImages?: boolean;
    readonly isSecret?: (element: Element) => boolean;
  } = {},
): boolean {
  if (typeof sourceWindow.getComputedStyle !== 'function') return false;
  const path = readSourceFlatTreeElementPath(image);
  if (!path) return false;
  const classifySecret = options.isSecret ?? hasSourceCredentialSecretAncestor;
  for (const current of path) {
    if (safeSecretClassification(current, classifySecret)) return false;
    const style = safeComputedStyle(sourceWindow, current);
    if (
      !style ||
      !styleAllowsImageCapture(style) ||
      !imageTransformIsAxisAligned(style)
    ) {
      return false;
    }
    if (
      current !== image &&
      current !== sourceDocument.body &&
      current !== sourceDocument.documentElement &&
      clipsImage(style, imageRect, current)
    ) return false;
  }

  if (hasProtectedSiblingOverlap(
    image,
    imageRect,
    sourceDocument,
    sourceWindow,
    classifySecret,
  )) return false;
  return !isCoveredByForeignText(image, imageRect, path, sourceDocument);
}

/**
 * An image contained by a control is governed by controlImages. A different
 * element painted over that image is never part of the image; it blocks pixel
 * capture and accessibility-label reads only when it is credential-secret
 * (password, one-time-code, payment-card and other secret autocompletes,
 * hidden/file inputs, CSS-masked text, or a sticky secret classification).
 * A public text control, button or link painted over the image exposes
 * nothing the replica does not already show as text, so it does not block.
 */
export function hasProtectedSiblingOverlap(
  image: HTMLImageElement,
  imageRect: DOMRect,
  sourceDocument: Document,
  sourceWindow: Window,
  isSecret: (element: Element) => boolean = hasSourceCredentialSecretAncestor,
): boolean {
  const candidates = collectCaptureOverlapElements(sourceDocument);
  if (!candidates) return true;
  for (const candidate of candidates) {
    if (candidate === image || candidate.contains(image)) continue;
    let rect: DOMRect;
    try {
      rect = candidate.getBoundingClientRect();
    } catch {
      return true;
    }
    if (!rectanglesOverlap(imageRect, rect)) continue;
    // Geometry and computed paint visibility are content-free prefilters. Run
    // the ancestry/computed-security classifier only for elements that can
    // actually contribute pixels to this crop.
    const style = safeComputedStyle(sourceWindow, candidate);
    if (!style) return true;
    if (!styleAllowsImageCapture(style)) continue;
    // Classify every painted overlap, not only controls and ARIA role nodes.
    // Generic div/span overlays can carry sticky password, OTP, payment,
    // WebAuthn, or computed text-security classification too.
    if (safeSecretClassification(candidate, isSecret)) return true;
  }
  return false;
}

/**
 * captureVisibleTab paints whatever is on top. A fixed header, caption, or
 * dialog with text lying over the image would be recognized and projected as
 * if it were part of the picture. Sample a few points and defer while a
 * non-ancestor element carrying its own text covers one of them. Transparent
 * link overlays and wrappers without text are deliberately allowed; an
 * unreadable hit test fails closed.
 */
function isCoveredByForeignText(
  image: HTMLImageElement,
  imageRect: DOMRect,
  imagePath: readonly Element[],
  sourceDocument: Document,
): boolean {
  const elementFromPoint = sourceDocument.elementFromPoint;
  if (typeof elementFromPoint !== 'function') return false;
  const ancestors = new Set<Element>(imagePath);
  const samples: ReadonlyArray<readonly [number, number]> = [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
  ];
  for (const [fx, fy] of samples) {
    const x = imageRect.left + imageRect.width * fx;
    const y = imageRect.top + imageRect.height * fy;
    let top: Element | null;
    try {
      top = elementFromPoint.call(sourceDocument, x, y);
      // The document-level hit test stops at a shadow host; descend so a
      // text overlay inside an open shadow tree is not mistaken for its
      // text-free host.
      for (let depth = 0; top && depth < MAX_TEXT_COVER_SHADOW_DEPTH; depth += 1) {
        const shadow = top.shadowRoot;
        if (!shadow || shadow.mode !== 'open' || ancestors.has(top)) break;
        const shadowHit = shadow.elementFromPoint;
        if (typeof shadowHit !== 'function') break;
        const inner = shadowHit.call(shadow, x, y);
        if (!inner || inner === top) break;
        top = inner;
      }
    } catch {
      return true;
    }
    if (!top || ancestors.has(top)) continue;
    if (elementHasOwnVisibleText(top)) return true;
  }
  return false;
}

function elementHasOwnVisibleText(element: Element): boolean {
  for (const child of element.childNodes) {
    if (child.nodeType === 3 && (child.nodeValue ?? '').trim().length > 0) {
      return true;
    }
  }
  // Text nested one level down (a caption span inside an overlay) counts too;
  // deeper structure is treated as layout rather than a text cover.
  for (const child of element.children) {
    for (const grandchild of child.childNodes) {
      if (
        grandchild.nodeType === 3 &&
        (grandchild.nodeValue ?? '').trim().length > 0
      ) return true;
    }
  }
  return false;
}

/**
 * Enumerates the document and every accessible open shadow tree once. Going
 * over the mirror-size ceiling fails closed instead of leaving an overlapping
 * painted element outside the OCR classifier.
 */
function collectCaptureOverlapElements(
  sourceDocument: Document,
): readonly Element[] | undefined {
  const elements: Element[] = [];
  const seen = new Set<Element>();
  const roots: Array<Document | ShadowRoot> = [sourceDocument];
  try {
    while (roots.length > 0) {
      const root = roots.pop()!;
      for (const element of root.querySelectorAll('*')) {
        if (seen.has(element)) continue;
        if (elements.length >= MAX_CAPTURE_OVERLAP_ELEMENTS) return undefined;
        seen.add(element);
        elements.push(element);
        const shadow = element.shadowRoot;
        if (shadow?.mode === 'open') roots.push(shadow);
      }
    }
  } catch {
    return undefined;
  }
  return Object.freeze(elements);
}

function safeSecretClassification(
  element: Element,
  classify: (element: Element) => boolean,
): boolean {
  try {
    return classify(element);
  } catch {
    return true;
  }
}

function safeComputedStyle(
  sourceWindow: Window,
  element: Element,
): CSSStyleDeclaration | undefined {
  try {
    return sourceWindow.getComputedStyle(element);
  } catch {
    return undefined;
  }
}

function clipsImage(
  style: CSSStyleDeclaration,
  imageRect: DOMRect,
  ancestor: Element,
): boolean {
  const clipsX = clipsOverflow(style.overflowX);
  const clipsY = clipsOverflow(style.overflowY);
  if (!clipsX && !clipsY) return false;
  let rect: DOMRect;
  try {
    rect = ancestor.getBoundingClientRect();
  } catch {
    return true;
  }
  const epsilon = 0.5;
  return (clipsX &&
      (imageRect.left < rect.left - epsilon ||
        imageRect.right > rect.right + epsilon)) ||
    (clipsY &&
      (imageRect.top < rect.top - epsilon ||
        imageRect.bottom > rect.bottom + epsilon));
}

function clipsOverflow(value: string): boolean {
  return value === 'hidden' || value === 'clip' ||
    value === 'scroll' || value === 'auto';
}

function rectanglesOverlap(left: DOMRect, right: DOMRect): boolean {
  return left.width > 0 && left.height > 0 &&
    right.width > 0 && right.height > 0 &&
    Math.max(left.left, right.left) < Math.min(left.right, right.right) &&
    Math.max(left.top, right.top) < Math.min(left.bottom, right.bottom);
}

function isImageElement(node: Node | null): node is HTMLImageElement {
  return Boolean(
    node &&
    node.nodeType === 1 &&
    'tagName' in node &&
    String((node as Element).tagName).toLowerCase() === 'img',
  );
}

function finitePositive(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000
    ? value
    : undefined;
}

function finiteNumber(value: number): number | undefined {
  return Number.isFinite(value) && Math.abs(value) <= 1_000_000
    ? value
    : undefined;
}

function boundedScroll(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, value)) : 0;
}

function boundedRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(0.1, Math.min(16, value)) : 1;
}
