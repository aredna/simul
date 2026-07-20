import type { SourceImageDescriptor } from './contracts';
import {
  readImageSourceControllerMessage,
  readImageSourcePortSessionId,
  type ImageSourceRecorderMessage,
  type SourceImageCaptureMetrics,
} from './image-source-protocol';
import { SourceImageModel } from './source-image-model';
import {
  SourceImageObserver,
  type SourceImageObservationEvent,
  type SourceImageObserverEnvironment,
} from './source-image-observer';
import {
  hasSourcePrivateOrActivationElementAncestor,
} from '../replica/source-privacy-policy';
import type { ReplicaSourceDocumentIdentity } from '../replica/source-identity';
import { canonicalizeLanguageTag } from '../translation-provider';

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
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(private readonly environment: ImageSourceSessionEnvironment) {
    const sessionId = readImageSourcePortSessionId(environment.port.name);
    if (!sessionId) throw new Error('Invalid image source Port.');
    this.#sessionId = sessionId;
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
    if (disconnect) {
      try {
        this.environment.port.disconnect();
      } catch {
        // The source document may already have destroyed the Port.
      }
    }
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
    if (message.kind === 'simul:image-source-v1:start') {
      if (this.#documentIdentity) {
        this.dispose(true);
        return;
      }
      this.#start(message.document);
      return;
    }
    if (!this.#documentIdentity || !this.#model || !this.#observer) {
      this.dispose(true);
      return;
    }
    this.#observer.refreshAll();
    const descriptor = this.#model.get(message.descriptor.nodeId);
    if (!descriptor || !this.#model.isCurrent(message.descriptor)) {
      this.#post({
        kind: 'simul:image-source-v1:metrics',
        requestId: message.requestId,
        status: 'stale',
      });
      return;
    }
    const metrics = this.#measure(descriptor);
    this.#post(metrics
      ? {
          kind: 'simul:image-source-v1:metrics',
          requestId: message.requestId,
          status: 'ready',
          metrics,
        }
      : {
          kind: 'simul:image-source-v1:metrics',
          requestId: message.requestId,
          status: 'hidden',
        });
  };

  readonly #onDisconnect = (): void => this.dispose(false);

  #start(documentIdentity: ReplicaSourceDocumentIdentity): void {
    const model = new SourceImageModel();
    if (!model.beginDocument(documentIdentity)) {
      this.dispose(true);
      return;
    }
    this.#documentIdentity = documentIdentity;
    this.#model = model;
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
      });
      this.#observer = observer;
      this.#unsubscribe = observer.subscribe(this.#onObservation);
      this.#post({
        kind: 'simul:image-source-v1:ready',
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
    this.#post({ kind: 'simul:image-source-v1:change', change: result.change });
  };

  #measure(descriptor: SourceImageDescriptor): SourceImageCaptureMetrics | undefined {
    const node = this.environment.resolveNode(descriptor.nodeId);
    if (!isImageElement(node) || !node.isConnected) return undefined;
    if (hasSourcePrivateOrActivationElementAncestor(node)) return undefined;
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

  #post(message: ImageSourceRecorderMessage): void {
    if (this.#disposed) return;
    try {
      this.environment.port.postMessage(message);
    } catch {
      this.dispose(false);
    }
  }
}

const PRIVATE_CAPTURE_SELECTOR = [
  'button',
  'input',
  'option',
  'output',
  'select',
  'textarea',
  '[contenteditable]',
  '[role]',
].join(',');

/** Skip invalid lang values and continue outward to the nearest valid hint. */
export function nearestValidElementLanguage(
  element: Element,
): ReturnType<typeof canonicalizeLanguageTag> {
  for (let current: Element | null = element; current; current = current.parentElement) {
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
 * isolation. Reject geometry that cannot be mapped safely or intersects a
 * private control, rather than OCRing unrelated/secret pixels.
 */
export function hasSafeCaptureGeometry(
  image: HTMLImageElement,
  imageRect: DOMRect,
  sourceDocument: Document,
  sourceWindow: Window,
): boolean {
  if (typeof sourceWindow.getComputedStyle !== 'function') return false;
  for (let current: Element | null = image; current; current = current.parentElement) {
    const style = safeComputedStyle(sourceWindow, current);
    if (!style || !styleAllowsCapture(style) || !axisAlignedTransform(style)) {
      return false;
    }
    if (
      current !== image &&
      current !== sourceDocument.body &&
      current !== sourceDocument.documentElement &&
      clipsImage(style, imageRect, current)
    ) return false;
  }

  for (const candidate of sourceDocument.querySelectorAll(PRIVATE_CAPTURE_SELECTOR)) {
    if (candidate === image || candidate.contains(image)) continue;
    if (!hasSourcePrivateOrActivationElementAncestor(candidate)) continue;
    const style = safeComputedStyle(sourceWindow, candidate);
    if (!style || !styleAllowsCapture(style)) continue;
    let rect: DOMRect;
    try {
      rect = candidate.getBoundingClientRect();
    } catch {
      return false;
    }
    if (rectanglesOverlap(imageRect, rect)) return false;
  }
  return true;
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

function styleAllowsCapture(style: CSSStyleDeclaration): boolean {
  const opacity = Number.parseFloat(style.opacity || '1');
  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    style.contentVisibility !== 'hidden' &&
    Number.isFinite(opacity) && opacity > 0 &&
    (style.clipPath === '' || style.clipPath === 'none') &&
    (style.maskImage === '' || style.maskImage === 'none') &&
    (style.perspective === '' || style.perspective === 'none');
}

function axisAlignedTransform(style: CSSStyleDeclaration): boolean {
  const rotate = style.rotate;
  if (rotate && rotate !== 'none' && rotate !== '0deg') return false;
  const transform = style.transform;
  if (!transform || transform === 'none') return true;
  const match = /^matrix\(\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*,\s*([-+\d.e]+)\s*\)$/iu.exec(transform);
  if (!match) return false;
  const values = match.slice(1).map(Number);
  return values.every(Number.isFinite) &&
    Math.abs(values[1] ?? 1) < 1e-7 &&
    Math.abs(values[2] ?? 1) < 1e-7;
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
