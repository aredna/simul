import type { SourceImageDescriptor } from './contracts';
import {
  isSourceImageFileUrl,
  MAX_SOURCE_IMAGE_PIXELS_DATA_URL_LENGTH,
  MAX_SOURCE_IMAGE_TAB_PIXELS,
  readImageSourceControllerMessage,
  readImageSourcePortSessionId,
  type ImageSourceRecorderMessage,
  type SourceImageAccessibilityTextEvidence,
  type SourceImageCaptureMetrics,
  type SourceImageFileEvidence,
} from './image-source-protocol';
import {
  computeImageFilePlacement,
  readImageFileLayout,
  type ImageFilePlacement,
} from './image-file-pixels';
import { MAX_OCR_BITMAP_DIMENSION } from './contracts';
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
  sourceControlledContentIsControlledRegion,
  sourceControlledContentIsWithheld,
  type SourceControlledContentPolicy,
} from '../replica/source-privacy-policy';
import {
  askAboutSourceShadowRootsAbove,
  probeSourceShadowRoot,
  readSourceShadowRoot,
} from '../replica/source-shadow-root';
import {
  sourceDocumentSecretClassifier,
  type StickySourceSecretClassifier,
} from '../replica/source-secret-classifier';
import type { ReplicaSourceDocumentIdentity } from '../replica/source-identity';
import type { SourceDocumentSecretScan } from '../replica/semantic-source-session';
import { readVisualViewportSnapshot } from '../primary-scroll';
import { canonicalizeLanguageTag } from '../translation-provider';
import { normalizeAccessibilityImageText } from './accessibility-image-text';
import {
  imageTransformIsAxisAligned,
  styleAllowsImageCapture,
  styleReplacesImagePicture,
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

/**
 * How long a rectangle may wait for the frame that paints an image's new
 * picture. A tab that is not painting (hidden, or its window covered) fires
 * no frame at all; the rectangle is then given as it was before this wait.
 */
export const PICTURE_PAINT_WAIT_LIMIT_MS = 250;
/**
 * How long a rectangle may wait for the file of an image's new CSS picture
 * to decode (D172). Nothing reports the load of a picture that CSS gives, so
 * the same file is decoded through an `Image()`; a screenshot made before
 * showed an empty box. Shorter than the panel's wait for a rectangle: past
 * it the rectangle is given, and the image is reported again once its file
 * has decoded.
 */
export const CSS_PICTURE_DECODE_WAIT_MS = 1_000;
/** Addresses at most read from one computed `content`. */
const MAX_CSS_PICTURE_FILES = 4;
/** Addresses remembered as decoded, so a picture seen again waits for none. */
const MAX_DECODED_CSS_PICTURE_FILES = 256;
/** Rectangles that may wait for a frame at once. */
const MAX_WAITING_MEASURES = 32;
/** Further requests held pending for that paint; beyond this they are refused. */
const MAX_OVERFLOW_MEASURES = 32;

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
  /**
   * The injection-time scan for that classifier. Images are looked at only
   * once it is done; the start answers in its own task when it is (D163).
   */
  readonly secretScan?: SourceDocumentSecretScan;
  /**
   * Draws a region of a loaded image and returns it as a PNG data URL, or
   * undefined when the page may not read it (a cross-origin image without
   * CORS taints the canvas). Tests inject a stand-in.
   */
  readonly encodeImageRegion?: ImageRegionEncoder;
  /**
   * The names the page's style rules mention (the mirror's census), for the
   * observer to leave out changes no rule names (D182).
   */
  readonly styleNames?: SourceImageObserverEnvironment['styleNames'];
  readonly onDispose?: () => void;
}

export type ImageRegionEncoder = (
  image: HTMLImageElement,
  region: {
    readonly sourceX: number;
    readonly sourceY: number;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly width: number;
    readonly height: number;
  },
) => Promise<string | undefined>;

/**
 * Document-targeted image facts and capture metrics, torn down with its Port.
 * Scheduling facts never carry URLs, pixels, text, or source tokens. Only an
 * explicit request for one eligible image answers with its accessibility
 * text, or with its file facts: its HTTP(S) URL, where it paints, and (when
 * the page may read them) its pixels.
 */
/**
 * The one file a CSS picture shows whole: a computed `content` of a single
 * `url()` (with or without a text alternative) and no view box. An
 * `image-set()`, a gradient, several images or a view box is `undefined`:
 * which part, or which candidate, is painted is the screen's to say.
 */
function cssPictureWholeFile(
  view: Window,
  image: HTMLImageElement,
): string | undefined {
  const style = safeComputedStyle(view, image);
  if (!style) return undefined;
  const viewBox = (style.getPropertyValue?.('object-view-box') ?? '').trim();
  if (viewBox !== '' && viewBox !== 'none') return undefined;
  const match = /^url\("((?:[^"\\]|\\.)*)"\)(?:\s*\/.*)?$/su
    .exec((style.content ?? '').trim());
  if (!match) return undefined;
  const file = (match[1] ?? '').replace(/\\(.)/gu, '$1');
  return /^(?:https?:|data:image\/|blob:)/iu.test(file) ? file : undefined;
}

/**
 * The addresses a computed `content` names: each `url()`, alone or as a
 * candidate of an `image-set()`. Gradients name none.
 */
function cssPictureFiles(view: Window, image: HTMLImageElement): string[] {
  const style = safeComputedStyle(view, image);
  const content = style?.content ?? '';
  const files: string[] = [];
  for (const match of content.matchAll(/url\("((?:[^"\\]|\\.)*)"\)/gu)) {
    const file = (match[1] ?? '').replace(/\\(.)/gu, '$1');
    if (!/^(?:https?:|data:image\/|blob:)/iu.test(file)) continue;
    if (!files.includes(file)) files.push(file);
    if (files.length >= MAX_CSS_PICTURE_FILES) break;
  }
  return files;
}

/** The media features followed besides the device pixel ratio (D172). */
const PICTURE_MEDIA_QUERIES = Object.freeze([
  '(prefers-color-scheme: dark)',
  '(prefers-contrast: more)',
  '(prefers-contrast: less)',
  '(forced-colors: active)',
] as const);

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
  /** An image was refused a rectangle because the tab was pinch-zoomed. */
  #refusedWhileMagnified = false;
  /**
   * Media features a page's CSS may hang pictures on with no change to the
   * document: the colour scheme, the contrast asked for, forced colours
   * (D172), and the device pixel ratio that picks an `image-set()`
   * candidate (D172), whose query is made again at each change.
   */
  readonly #pictureMedia: MediaQueryList[] = [];
  #resolutionMedia: MediaQueryList | undefined;
  /**
   * Images whose picture changed and has not been painted since, each with
   * the frame wait that will clear it; and the rectangles asked for them
   * meanwhile. A change is reported before the tab paints it, and a
   * screenshot taken at once would show the picture before.
   */
  readonly #unpainted = new Map<number, object>();
  #openPaintWait: Set<number> | undefined;
  #waitingMeasures: {
    readonly requestId: string;
    readonly descriptor: SourceImageDescriptor;
  }[] = [];
  /**
   * Measures that arrived while the wait queue was full. They are not
   * answered with pre-paint geometry; they stay pending and are moved to the
   * wait queue or answered once a slot frees or their picture paints (C11).
   */
  #overflowMeasures: {
    readonly requestId: string;
    readonly descriptor: SourceImageDescriptor;
  }[] = [];
  readonly #paintTimers = new Set<number>();
  /** Files of CSS pictures that have decoded in this page (D172). */
  readonly #decodedFiles = new Set<string>();
  /** Images whose CSS picture's file is decoding, and its wait. */
  readonly #decoding = new Map<number, { readonly picture: number; timedOut: boolean }>();
  #unsubscribe: (() => void) | undefined;
  #disposed = false;
  /** A start waits for the injection-time credential scan (D163). */
  #startPending = false;

  constructor(private readonly environment: ImageSourceSessionEnvironment) {
    const sessionId = readImageSourcePortSessionId(environment.port.name);
    if (!sessionId) throw new Error('Invalid image source Port.');
    this.#sessionId = sessionId;
    this.#secretClassifier = environment.secretClassifier ??
      sourceDocumentSecretClassifier(environment.document);
    environment.port.onMessage.addListener(this.#onMessage);
    environment.port.onDisconnect.addListener(this.#onDisconnect);
    // A pinch zoom fires here only, as it changes and when it ends.
    try {
      environment.window.visualViewport?.addEventListener?.(
        'resize',
        this.#onVisualViewportResize,
        { passive: true },
      );
    } catch {
      // Without the event an image waits for the page's next change.
    }
    // A change of these is no change to the document either.
    for (const query of PICTURE_MEDIA_QUERIES) {
      try {
        const media = environment.window.matchMedia?.(query);
        if (!media) continue;
        media.addEventListener?.('change', this.#onColorSchemeChange);
        this.#pictureMedia.push(media);
      } catch {
        // Without the query such a picture waits for the image's next look.
      }
    }
    this.#watchResolution();
  }

  dispose(disconnect = false): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.environment.port.onMessage.removeListener(this.#onMessage);
    this.environment.port.onDisconnect.removeListener(this.#onDisconnect);
    try {
      this.environment.window.visualViewport?.removeEventListener?.(
        'resize',
        this.#onVisualViewportResize,
      );
    } catch {
      // The window may already be gone.
    }
    for (const media of this.#pictureMedia) {
      try {
        media.removeEventListener?.('change', this.#onColorSchemeChange);
      } catch {
        // As above.
      }
    }
    this.#pictureMedia.length = 0;
    try {
      this.#resolutionMedia?.removeEventListener?.(
        'change',
        this.#onResolutionChange,
      );
    } catch {
      // As above.
    }
    this.#resolutionMedia = undefined;
    for (const timer of this.#paintTimers) {
      try {
        this.environment.window.clearTimeout(timer);
      } catch {
        // As above.
      }
    }
    this.#paintTimers.clear();
    this.#unpainted.clear();
    this.#decoding.clear();
    this.#decodedFiles.clear();
    this.#openPaintWait = undefined;
    this.#waitingMeasures = [];
    this.#overflowMeasures = [];
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
      if (this.#documentIdentity || this.#startPending) {
        this.dispose(true);
        return;
      }
      const secretScan = this.environment.secretScan;
      if (secretScan && !secretScan.done) {
        void this.#startAfterSecretScan(
          secretScan,
          message.document,
          message.policyFingerprint,
          message.controlImages === true,
          message.accessibilityTextEnabled === true,
        );
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
    // A read that does not look at the screen is answered while the image's
    // content is the one asked about, whatever moved since (D172); it is
    // answered for the descriptor it was asked for.
    const screenless =
      message.kind === 'simul:image-source-v2:accessibility-text' ||
      message.kind === 'simul:image-source-v2:pixels';
    const known = this.#model.get(message.descriptor.nodeId);
    // A rectangle is given for the image as it is now while only where it
    // is has changed since it was asked about (D182): it names the
    // observation asked about, and the panel compares the rectangles around
    // its screenshot, so a move fails there.
    const descriptor = screenless || (
      known && !this.#model.isCurrent(message.descriptor)
    )
      ? message.descriptor
      : known;
    if (
      !known ||
      !descriptor ||
      !(screenless
        ? this.#model.isContentCurrent(message.descriptor)
        : this.#model.isCurrent(message.descriptor) ||
          this.#model.isCaptureCurrent(message.descriptor))
    ) {
      this.#post(
        message.kind === 'simul:image-source-v2:accessibility-text' ||
          message.kind === 'simul:image-source-v2:pixels'
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
            },
      );
      return;
    }
    if (message.kind === 'simul:image-source-v2:pixels') {
      void this.#answerPixels(
        message.requestId,
        descriptor,
        message.includePixels,
      );
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
    if (this.#unpainted.has(descriptor.nodeId)) {
      if (this.#waitingMeasures.length < MAX_WAITING_MEASURES) {
        // The rectangle is for a screenshot: it is given once the tab has
        // painted the picture that the descriptor stands for.
        this.#waitingMeasures.push({ requestId: message.requestId, descriptor });
        return;
      }
      if (this.#overflowMeasures.length < MAX_OVERFLOW_MEASURES) {
        // The wait queue is full. Answering now would attach the old
        // picture's geometry to the new contentRevision, but answering
        // `stale` loses the image on a static page: the scheduler makes a
        // deferred job eligible only on a later observation revision. Keep
        // the request pending instead; it is answered when a wait slot frees
        // or this picture paints (C11).
        this.#overflowMeasures.push({ requestId: message.requestId, descriptor });
        return;
      }
      // Beyond the bounded overflow nothing more may be held; the caller is
      // told to defer rather than given the pre-paint geometry.
      this.#post({
        kind: 'simul:image-source-v2:metrics',
        requestId: message.requestId,
        status: 'stale',
      });
      return;
    }
    this.#answerMeasure(message.requestId, descriptor);
  };

  #answerMeasure(requestId: string, descriptor: SourceImageDescriptor): void {
    if (
      !this.#model?.isCurrent(descriptor) &&
      !this.#model?.isCaptureCurrent(descriptor)
    ) {
      this.#post({
        kind: 'simul:image-source-v2:metrics',
        requestId,
        status: 'stale',
      });
      return;
    }
    const metrics = this.#measure(descriptor);
    this.#post(metrics
      ? {
          kind: 'simul:image-source-v2:metrics',
          requestId,
          status: 'ready',
          metrics,
        }
      : {
          kind: 'simul:image-source-v2:metrics',
          requestId,
          status: 'hidden',
        });
  }

  /**
   * Marks an image's picture as not yet painted, until the tab has produced
   * the frame that holds it: the first frame callback after the change runs
   * before that frame is painted, the second after it. Images that change
   * before the first callback share one wait.
   */
  #awaitPaint(nodeId: number): void {
    let wait = this.#openPaintWait;
    if (!wait) {
      const opened = new Set<number>();
      wait = opened;
      this.#openPaintWait = opened;
      const view = this.environment.window;
      let settled = false;
      let timer: number | undefined;
      const close = (): void => {
        if (this.#openPaintWait === opened) this.#openPaintWait = undefined;
      };
      const settle = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          this.#paintTimers.delete(timer);
          try {
            view.clearTimeout(timer);
          } catch {
            // The window may already be gone.
          }
        }
        close();
        this.#painted(opened);
      };
      try {
        timer = view.setTimeout(settle, PICTURE_PAINT_WAIT_LIMIT_MS);
        this.#paintTimers.add(timer);
        view.requestAnimationFrame(() => {
          close();
          try {
            view.requestAnimationFrame(settle);
          } catch {
            settle();
          }
        });
      } catch {
        // No frames to wait for: the timer answers, or nothing waits.
        if (timer === undefined) {
          close();
          return;
        }
      }
    }
    wait.add(nodeId);
    this.#unpainted.set(nodeId, wait);
  }

  /**
   * Holds an image's rectangle until the files its CSS picture names have
   * decoded, then waits for the frame that paints them (D172). Past
   * CSS_PICTURE_DECODE_WAIT_MS the rectangle is given; a file that decodes
   * later has the image reported again as a new capture of its picture.
   */
  #awaitDecode(nodeId: number, picture: number): void {
    const image = this.environment.resolveNode(nodeId);
    if (!isImageElement(image)) return;
    const files = cssPictureFiles(this.environment.window, image)
      .filter((file) => !this.#decodedFiles.has(file));
    if (files.length === 0) return;
    const view = this.environment.window;
    const ImageConstructor = (view as { Image?: typeof Image }).Image;
    if (typeof ImageConstructor !== 'function') return;
    const record = { picture, timedOut: false };
    this.#decoding.set(nodeId, record);
    const wait = new Set<number>([nodeId]);
    this.#unpainted.set(nodeId, wait);
    let timer: number | undefined;
    try {
      timer = view.setTimeout(() => {
        if (timer !== undefined) this.#paintTimers.delete(timer);
        if (this.#decoding.get(nodeId) !== record) return;
        record.timedOut = true;
        // The rectangle is given as before this wait.
        this.#painted(wait);
      }, CSS_PICTURE_DECODE_WAIT_MS);
      this.#paintTimers.add(timer);
    } catch {
      timer = undefined;
    }
    const decodes = files.map(async (file) => {
      const loader = new ImageConstructor();
      loader.decoding = 'async';
      loader.src = file;
      await loader.decode();
      return file;
    });
    void Promise.allSettled(decodes).then((results) => {
      if (this.#disposed || this.#decoding.get(nodeId) !== record) return;
      this.#decoding.delete(nodeId);
      if (timer !== undefined) {
        this.#paintTimers.delete(timer);
        try {
          view.clearTimeout(timer);
        } catch {
          // The window may already be gone.
        }
      }
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        if (this.#decodedFiles.size >= MAX_DECODED_CSS_PICTURE_FILES) {
          this.#decodedFiles.clear();
        }
        this.#decodedFiles.add(result.value);
      }
      const current = this.#model?.get(nodeId);
      if (current?.cssPicture !== picture) return;
      if (record.timedOut) {
        // Its rectangle went out before the file was there: a screenshot
        // may have shown an empty box. The image is looked at again.
        this.#observer?.refreshLoadedPicture(image);
        return;
      }
      // A file that failed to decode paints nothing either way. Now the
      // frame that paints the picture.
      if (this.#unpainted.get(nodeId) === wait) this.#awaitPaint(nodeId);
    });
  }

  #painted(wait: Set<number>): void {
    if (this.#disposed) return;
    for (const nodeId of wait) {
      // An image that changed again waits for its later frame.
      if (this.#unpainted.get(nodeId) === wait) this.#unpainted.delete(nodeId);
    }
    const waiting = this.#waitingMeasures;
    this.#waitingMeasures = [];
    for (const entry of waiting) {
      if (this.#disposed) return;
      if (this.#unpainted.has(entry.descriptor.nodeId)) {
        this.#waitingMeasures.push(entry);
      } else {
        this.#answerMeasure(entry.requestId, entry.descriptor);
      }
    }
    this.#drainOverflowMeasures();
  }

  /**
   * Moves overflowed measures to the wait queue when a slot is free, or
   * answers them once their picture has painted. An entry whose image is gone
   * answers stale through #answerMeasure's currency check.
   */
  #drainOverflowMeasures(): void {
    if (this.#disposed || this.#overflowMeasures.length === 0) return;
    const overflow = this.#overflowMeasures;
    this.#overflowMeasures = [];
    for (const entry of overflow) {
      if (this.#disposed) return;
      if (!this.#unpainted.has(entry.descriptor.nodeId)) {
        this.#answerMeasure(entry.requestId, entry.descriptor);
      } else if (this.#waitingMeasures.length < MAX_WAITING_MEASURES) {
        this.#waitingMeasures.push(entry);
      } else {
        this.#overflowMeasures.push(entry);
      }
    }
  }

  readonly #onDisconnect = (): void => this.dispose(false);

  /**
   * The end of a pinch zoom changes nothing the image observer watches, so
   * an image refused a rectangle while it lasted would wait for the page's
   * next change. Once the magnification is gone, the images on screen are
   * offered again. Nothing is sent unless one was refused, and nothing
   * while the tab is still magnified.
   */
  readonly #onVisualViewportResize = (): void => {
    if (
      this.#disposed ||
      !this.#refusedWhileMagnified ||
      readVisualViewportSnapshot(this.environment.window)
    ) return;
    this.#refusedWhileMagnified = false;
    this.#observer?.advanceVisibleObservation();
  };

  /**
   * A picture that `@media (prefers-color-scheme)` swaps changes with no
   * mutation, load or resize. The images on screen are looked at again;
   * only one whose picture CSS now decides differently is a change.
   */
  readonly #onColorSchemeChange = (): void => {
    if (this.#disposed) return;
    this.#observer?.refreshVisiblePictures();
  };

  /** A query for the present device pixel ratio, made again when it ends. */
  #watchResolution(): void {
    try {
      const ratio = this.environment.window.devicePixelRatio;
      if (!(typeof ratio === 'number' && ratio > 0)) return;
      const media = this.environment.window.matchMedia?.(
        `(resolution: ${ratio}dppx)`,
      );
      if (!media) return;
      media.addEventListener?.('change', this.#onResolutionChange);
      this.#resolutionMedia = media;
    } catch {
      this.#resolutionMedia = undefined;
    }
  }

  readonly #onResolutionChange = (): void => {
    if (this.#disposed) return;
    // The query was for the ratio that has ended: one for the new ratio
    // takes its place.
    try {
      this.#resolutionMedia?.removeEventListener?.(
        'change',
        this.#onResolutionChange,
      );
    } catch {
      // The old query is dropped either way.
    }
    this.#resolutionMedia = undefined;
    this.#watchResolution();
    this.#observer?.refreshVisiblePictures();
  };

  /**
   * No image is looked at before the injection-time credential scan has met
   * every node (D163). A request that comes meanwhile ends the session, as
   * one before a start does; the panel asks for nothing before `ready`.
   */
  async #startAfterSecretScan(
    secretScan: SourceDocumentSecretScan,
    documentIdentity: ReplicaSourceDocumentIdentity,
    policyFingerprint: string | undefined,
    controlImages: boolean,
    accessibilityTextEnabled: boolean,
  ): Promise<void> {
    this.#startPending = true;
    await secretScan.finished;
    this.#startPending = false;
    if (this.#disposed) return;
    this.#start(
      documentIdentity,
      policyFingerprint,
      controlImages,
      accessibilityTextEnabled,
    );
  }

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
        ...(this.environment.styleNames
          ? { styleNames: this.environment.styleNames }
          : {}),
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
    const before = event.kind === 'upsert'
      ? model.get(event.input.nodeId)
      : undefined;
    const result = event.kind === 'upsert'
      ? model.upsert(event.input)
      : model.remove(event.document, event.nodeId);
    if (result.status !== 'changed') return;
    const change = result.change;
    if (change.kind === 'remove') {
      this.#unpainted.delete(change.nodeId);
    } else if (
      !before ||
      before.contentRevision !== change.descriptor.contentRevision ||
      before.captureRevision !== change.descriptor.captureRevision
    ) {
      // Another picture, or the same one elsewhere: not on screen yet.
      this.#awaitPaint(change.descriptor.nodeId);
      const picture = change.descriptor.cssPicture;
      if (picture !== undefined && before?.cssPicture !== picture) {
        this.#awaitDecode(change.descriptor.nodeId, picture);
      }
    }
    this.#post({ kind: 'simul:image-source-v2:change', change });
    if (change.kind === 'remove') this.#drainOverflowMeasures();
  };

  #measure(descriptor: SourceImageDescriptor): SourceImageCaptureMetrics | undefined {
    const node = this.environment.resolveNode(descriptor.nodeId);
    if (!isImageElement(node) || !node.isConnected) return undefined;
    if (!this.#askedAboutRootsAbove(node)) return undefined;
    if (this.#hasStickySecretAncestor(node)) return undefined;
    if (
      !this.#controlImages &&
      (
        hasSourceControlOrEditableElementAncestor(node) ||
        this.#imageIsInWithheldControlledContent(node)
      )
    ) return undefined;
    // A pinch zoom makes the tab's pixels show the magnified view, while
    // this rectangle is measured in the layout viewport: a crop taken then
    // is of another part of the page (D119). The image is not on screen as
    // measured, so its own file is read instead; when that cannot be done
    // the image is offered again once the magnification ends.
    if (readVisualViewportSnapshot(this.environment.window)) {
      this.#refusedWhileMagnified = true;
      return undefined;
    }
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
    let covered = false;
    if (!hasSafeCaptureGeometry(
      node,
      rect,
      this.environment.document,
      this.environment.window,
      {
        allowControlImages: this.#controlImages,
        isSecret: (candidate) => this.#hasStickySecretAncestor(candidate),
        onPublicControlOverlap: () => {
          covered = true;
        },
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
      ...(covered ? { covered: true as const } : {}),
    });
  }

  async #answerPixels(
    requestId: string,
    descriptor: SourceImageDescriptor,
    includePixels: boolean,
  ): Promise<void> {
    let file: SourceImageFileEvidence | undefined;
    try {
      file = await this.#readFile(descriptor, includePixels);
    } catch {
      file = undefined;
    }
    if (this.#disposed || !this.#model) return;
    if (!this.#model.isContentCurrent(descriptor)) {
      this.#post({
        kind: 'simul:image-source-v2:pixels',
        requestId,
        descriptor,
        status: 'stale',
      });
      return;
    }
    this.#post(file
      ? {
          kind: 'simul:image-source-v2:pixels',
          requestId,
          descriptor,
          status: 'ready',
          file,
        }
      : {
          kind: 'simul:image-source-v2:pixels',
          requestId,
          descriptor,
          status: 'blocked',
        });
  }

  /**
   * File pixels hold only the image itself: no overlay, neighbour or secret
   * control painted over it. So unlike a screenshot the image need not be on
   * screen, unclipped or uncovered; it must be admitted by the same read
   * policy and painted by its own style path. A lazy image the tab has not
   * fetched yet is still described (layout and URL), so the extension can
   * read a copy of it.
   */
  async #readFile(
    descriptor: SourceImageDescriptor,
    includePixels: boolean,
  ): Promise<SourceImageFileEvidence | undefined> {
    const node = this.environment.resolveNode(descriptor.nodeId);
    if (!isImageElement(node) || !node.isConnected) return undefined;
    if (!this.#askedAboutRootsAbove(node)) return undefined;
    if (this.#hasStickySecretAncestor(node)) return undefined;
    if (
      !this.#controlImages &&
      (
        hasSourceControlOrEditableElementAncestor(node) ||
        this.#imageIsInWithheldControlledContent(node)
      )
    ) return undefined;
    if (!imageFileIsPainted(
      node,
      this.environment.window,
      (candidate) => this.#hasStickySecretAncestor(candidate),
    )) return undefined;
    // CSS shows another picture than the file's, or a part of it: the file
    // would give the words of a picture that is not on the page. One file
    // shown whole in its place (`content: url(X)`, no view box) is read
    // instead, as the image's own would be (D172).
    if (imageShowsCssPicture(node, this.environment.window)) {
      const cssFile = cssPictureWholeFile(this.environment.window, node);
      return cssFile
        ? await this.#readCssPictureFile(descriptor, node, cssFile, includePixels)
        : undefined;
    }
    const layout = readImageFileLayout(node, this.environment.window);
    if (!layout) return undefined;
    const loaded = node.complete && node.naturalWidth > 0 &&
      node.naturalHeight > 0;
    const url = node.currentSrc || node.getAttribute('src') || '';
    const fileUrl = isSourceImageFileUrl(url) ? url : undefined;
    // Nothing to read yet: not loaded here and no URL to fetch it from.
    if (!loaded && !fileUrl) return undefined;
    const placement = loaded
      ? computeImageFilePlacement({
          ...layout,
          naturalWidth: node.naturalWidth,
          naturalHeight: node.naturalHeight,
        })
      : undefined;
    const pixels = includePixels && placement
      ? await readTabImagePixels(
          node,
          placement,
          this.environment.encodeImageRegion ?? encodeImageRegionAsPngDataUrl,
        )
      : undefined;
    const nearestElementLanguage = nearestValidElementLanguage(node);
    return Object.freeze({
      document: descriptor.document,
      nodeId: descriptor.nodeId,
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
      layout,
      ...(loaded
        ? { naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight }
        : {}),
      ...(fileUrl ? { url: fileUrl } : {}),
      ...(pixels ? { pixels } : {}),
      ...(nearestElementLanguage ? { nearestElementLanguage } : {}),
    });
  }

  /**
   * The file a CSS picture shows whole, described as an image's own file
   * is: its size from an `Image()` of it, its region read here when the
   * page may read it, and its address for the extension to fetch a copy
   * otherwise (all sites are granted, D166).
   */
  async #readCssPictureFile(
    descriptor: SourceImageDescriptor,
    node: HTMLImageElement,
    cssFile: string,
    includePixels: boolean,
  ): Promise<SourceImageFileEvidence | undefined> {
    const layout = readImageFileLayout(node, this.environment.window);
    if (!layout) return undefined;
    const ImageConstructor = (this.environment.window as { Image?: typeof Image })
      .Image;
    let loader: HTMLImageElement | undefined;
    if (typeof ImageConstructor === 'function') {
      try {
        const candidate = new ImageConstructor();
        candidate.decoding = 'async';
        candidate.src = cssFile;
        await candidate.decode();
        if (candidate.naturalWidth > 0 && candidate.naturalHeight > 0) {
          loader = candidate;
        }
      } catch {
        loader = undefined;
      }
    }
    if (this.#disposed || !node.isConnected) return undefined;
    // The picture may have changed while its file was decoding.
    if (cssPictureWholeFile(this.environment.window, node) !== cssFile) {
      return undefined;
    }
    const fileUrl = isSourceImageFileUrl(cssFile) ? cssFile : undefined;
    if (!loader && !fileUrl) return undefined;
    const placement = loader
      ? computeImageFilePlacement({
          ...layout,
          naturalWidth: loader.naturalWidth,
          naturalHeight: loader.naturalHeight,
        })
      : undefined;
    const pixels = includePixels && loader && placement
      ? await readTabImagePixels(
          loader,
          placement,
          this.environment.encodeImageRegion ?? encodeImageRegionAsPngDataUrl,
        )
      : undefined;
    const nearestElementLanguage = nearestValidElementLanguage(node);
    return Object.freeze({
      document: descriptor.document,
      nodeId: descriptor.nodeId,
      contentRevision: descriptor.contentRevision,
      observationRevision: descriptor.observationRevision,
      layout,
      ...(loader
        ? { naturalWidth: loader.naturalWidth, naturalHeight: loader.naturalHeight }
        : {}),
      ...(fileUrl ? { url: fileUrl } : {}),
      ...(pixels ? { pixels } : {}),
      ...(nearestElementLanguage ? { nearestElementLanguage } : {}),
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
    if (!this.#askedAboutRootsAbove(node)) return { status: 'blocked' };
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

  /**
   * Asks about the root of every element above the image before anything
   * about it is read: one attached since it was last read fires nothing,
   * and the checks that follow climb through it once it is known (D125).
   * False when the climb cannot be finished.
   */
  #askedAboutRootsAbove(node: Element): boolean {
    try {
      askAboutSourceShadowRootsAbove(node, new Set());
      return true;
    } catch {
      return false;
    }
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

/** Every element on the image's path paints it and none is secret. */
function imageFileIsPainted(
  image: HTMLImageElement,
  sourceWindow: Window,
  isSecret: (element: Element) => boolean,
): boolean {
  const path = readSourceFlatTreeElementPath(image);
  if (!path) return false;
  for (const current of path) {
    if (safeSecretClassification(current, isSecret)) return false;
    const style = safeComputedStyle(sourceWindow, current);
    if (
      !style ||
      !styleAllowsImageCapture(style) ||
      !imageTransformIsAxisAligned(style)
    ) return false;
  }
  let rect: DOMRect;
  try {
    rect = image.getBoundingClientRect();
  } catch {
    return false;
  }
  return finitePositive(rect.width) !== undefined &&
    finitePositive(rect.height) !== undefined;
}

/** Unreadable counts as yes: the file is then not known to be the picture. */
function imageShowsCssPicture(
  image: HTMLImageElement,
  sourceWindow: Window,
): boolean {
  const style = safeComputedStyle(sourceWindow, image);
  if (!style) return true;
  let file = '';
  try {
    file = typeof image.currentSrc === 'string' ? image.currentSrc : '';
  } catch {
    return true;
  }
  let naturalSize: { width: number; height: number } | undefined;
  try {
    naturalSize = { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    naturalSize = undefined;
  }
  return styleReplacesImagePicture(style, file, naturalSize);
}

/**
 * Reads the painted region of a loaded image inside the page, scaled under
 * the OCR pixel budget. A cross-origin image without CORS cannot be read here;
 * the encoder then returns undefined and the extension uses another copy.
 */
async function readTabImagePixels(
  image: HTMLImageElement,
  placement: ImageFilePlacement,
  encode: ImageRegionEncoder,
): Promise<SourceImageFileEvidence['pixels']> {
  const sourceX = placement.sourceX * image.naturalWidth;
  const sourceY = placement.sourceY * image.naturalHeight;
  const sourceWidth = placement.sourceWidth * image.naturalWidth;
  const sourceHeight = placement.sourceHeight * image.naturalHeight;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return undefined;
  const factor = Math.min(
    1,
    Math.sqrt(MAX_SOURCE_IMAGE_TAB_PIXELS / (sourceWidth * sourceHeight)),
    MAX_OCR_BITMAP_DIMENSION / sourceWidth,
    MAX_OCR_BITMAP_DIMENSION / sourceHeight,
  );
  let width = Math.max(1, Math.floor(sourceWidth * factor));
  let height = Math.max(1, Math.floor(sourceHeight * factor));
  while (width * height > MAX_SOURCE_IMAGE_TAB_PIXELS) {
    if (width >= height) width -= 1;
    else height -= 1;
  }
  const dataUrl = await encode(image, {
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    width,
    height,
  });
  if (
    !dataUrl ||
    !dataUrl.startsWith('data:image/png;base64,') ||
    dataUrl.length > MAX_SOURCE_IMAGE_PIXELS_DATA_URL_LENGTH
  ) return undefined;
  return Object.freeze({ dataUrl, width, height });
}

export const encodeImageRegionAsPngDataUrl: ImageRegionEncoder = async (
  image,
  region,
) => {
  try {
    const canvas = new OffscreenCanvas(region.width, region.height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(
      image,
      region.sourceX,
      region.sourceY,
      region.sourceWidth,
      region.sourceHeight,
      0,
      0,
      region.width,
      region.height,
    );
    // A tainted canvas rejects here with a SecurityError.
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(
        typeof reader.result === 'string' ? reader.result : undefined,
      );
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
};

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
  // A stateless controlled region (a carousel's slide container) stays
  // readable in the base graph, but its images remain control-adjacent for
  // image policy, exactly as before.
  return path.some((current) =>
    sourceControlledContentIsWithheld(current, policy) ||
    sourceControlledContentIsControlledRegion(current, policy)
  );
}

export const MAX_CAPTURE_OVERLAP_ELEMENTS = 50_000;
/** Bounded descent through shadow roots under a covering element. */
const MAX_TEXT_COVER_SHADOW_DEPTH = 16;
/** How far below a covering element its own text is still looked for. */
const MAX_TEXT_COVER_WALK_DEPTH = 3;
/** How many descendants of a covering element are inspected at most. */
const MAX_TEXT_COVER_WALK_NODES = 64;

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
    /** Told when a public control is painted over a part of the image. */
    readonly onPublicControlOverlap?: () => void;
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
    options.onPublicControlOverlap,
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
  onPublicControlOverlap?: () => void,
): boolean {
  const candidates = collectCaptureOverlapElements(sourceDocument);
  if (!candidates) return true;
  // Element.contains() stops at a shadow boundary. An image inside an open
  // shadow root is composed under its host and the host's ancestors, and none
  // of those is a foreign element painted over the image. The flat-tree path
  // covers both cases; an unreadable path fails closed.
  const imagePath = readSourceFlatTreeElementPath(image);
  if (!imagePath) return true;
  const imageAncestry = new Set<Element>(imagePath);
  for (const candidate of candidates) {
    if (imageAncestry.has(candidate)) continue;
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
    // What the element paints may come from a root attached since it was
    // read, which fires nothing and which no walk above saw. Asked again, a
    // root that turns up refuses this capture; it is known from now on, so
    // the next one classifies what it holds (D125).
    if (sourceShadowRootAttachedSince(candidate)) return true;
    // Classify every painted overlap, not only controls and ARIA role nodes.
    // Generic div/span overlays can carry sticky password, OTP, payment,
    // WebAuthn, or computed text-security classification too.
    if (safeSecretClassification(candidate, isSecret)) return true;
    if (onPublicControlOverlap && elementIsPublicControl(candidate)) {
      onPublicControlOverlap();
    }
  }
  return false;
}

/** A link, button, field or other control a reader may act on (D172). */
function elementIsPublicControl(element: Element): boolean {
  try {
    return element.matches(PUBLIC_CONTROL_SELECTOR);
  } catch {
    return true;
  }
}

const PUBLIC_CONTROL_SELECTOR = [
  'a[href]', 'area[href]', 'button', 'input', 'label', 'select', 'summary',
  'textarea', '[role="button"]', '[role="link"]', '[role="tab"]',
  '[role="menuitem"]', '[contenteditable]',
].join(',');

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
  // Without a hit test the cover cannot be ruled out: defer the capture
  // instead of assuming it is safe (C8).
  if (typeof elementFromPoint !== 'function') return true;
  const ancestors = new Set<Element>(imagePath);
  // Nine fixed samples are a bounded heuristic, not a proof: a thin caption
  // that falls between them is still missed. The set is kept small on purpose.
  const samples: ReadonlyArray<readonly [number, number]> = [
    [0.5, 0.5],
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
    // Edge midpoints: a thin caption, bar or toast can sit between the
    // centre and the corners (C8).
    [0.5, 0.1],
    [0.5, 0.9],
    [0.1, 0.5],
    [0.9, 0.5],
  ];
  for (const [fx, fy] of samples) {
    const x = imageRect.left + imageRect.width * fx;
    const y = imageRect.top + imageRect.height * fy;
    let top: Element | null;
    try {
      top = elementFromPoint.call(sourceDocument, x, y);
      // The document-level hit test stops at a shadow host; descend so a
      // text overlay inside a shadow tree, open or closed (D125), is not
      // mistaken for its text-free host.
      for (let depth = 0; top && depth < MAX_TEXT_COVER_SHADOW_DEPTH; depth += 1) {
        if (ancestors.has(top)) break;
        // A root attached since the element was read is asked about again,
        // and covers the image until it is known (D125).
        if (sourceShadowRootAttachedSince(top)) return true;
        const shadow = readSourceShadowRoot(top);
        if (!shadow) break;
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

/**
 * Whether Chrome now reports a root for an element that every reader so far
 * took to have none. Unreadable counts as yes.
 */
function sourceShadowRootAttachedSince(element: Element): boolean {
  try {
    return !readSourceShadowRoot(element) && Boolean(probeSourceShadowRoot(element));
  } catch {
    return true;
  }
}

function elementHasOwnVisibleText(element: Element): boolean {
  // Bounded depth-first walk below the covering element. It finds a caption
  // inside a couple of wrappers, but it is not a general text search: text
  // four or more element levels down escapes, and when the node budget is
  // exhausted the stack visits later siblings first, so earlier subtrees are
  // cut. These are accepted bounds, not a claim that deeper text is layout.
  const pending: Array<{ readonly node: Node; readonly depth: number }> = [
    { node: element, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_TEXT_COVER_WALK_NODES) {
    const current = pending.pop()!;
    visited += 1;
    for (const child of current.node.childNodes) {
      if (child.nodeType === 3) {
        if ((child.nodeValue ?? '').trim().length > 0) return true;
        continue;
      }
      if (
        child.nodeType === 1 &&
        current.depth < MAX_TEXT_COVER_WALK_DEPTH
      ) {
        pending.push({ node: child, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

/**
 * Enumerates the document and every shadow tree, open or closed, once. Going
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
        const shadow = readSourceShadowRoot(element);
        if (shadow) roots.push(shadow);
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
