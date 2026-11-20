import type {
  ImageTranslationConfiguration,
} from '../../lib/ocr/image-translation-controller';
import type { ReplicaCaptureRequest } from '../../lib/replica/contracts';
import type { ReplicaSourceDocumentIdentity } from '../../lib/replica/source-identity';

/** The part of the real controller this facade forwards. */
export interface ImageTranslationControllerLike {
  readonly busy: boolean;
  configure(configuration: ImageTranslationConfiguration): void;
  activateReplica(
    request: ReplicaCaptureRequest,
    sourceWindowId: number,
    replayLease: number,
  ): boolean;
  notifyReplicaCommit(
    document: ReplicaSourceDocumentIdentity,
    replayLease: number,
  ): boolean;
  resume(): void;
  refreshOverlays(): void;
  cancelCurrent(): boolean;
  releaseReplica(): void;
  setTopPageOrigin(pageUrl: string | undefined): void;
  purgeSourceDerivedCache(): void;
  dispose(): void;
}

export interface LazyImageTranslationControllerOptions {
  readonly load: () => Promise<ImageTranslationControllerLike>;
  /** Development diagnostics for a stack that could not be loaded. */
  readonly onLoadError?: (error: unknown) => void;
}

/**
 * Defers the image-translation controller and its OCR stack until image
 * translation is first enabled and a replica is activated (O8). Calls made
 * before then are replayed on the real controller in their original order
 * relative to the latest configuration, so the first image use works
 * exactly as it did when the controller was constructed eagerly.
 */
export class LazyImageTranslationController
implements ImageTranslationControllerLike {
  readonly #load: () => Promise<ImageTranslationControllerLike>;
  readonly #onLoadError: ((error: unknown) => void) | undefined;
  #controller: ImageTranslationControllerLike | undefined;
  #loadPromise: Promise<void> | undefined;
  #disposed = false;
  #latestConfiguration: ImageTranslationConfiguration | undefined;
  #topPageOrigin: { readonly set: true; readonly value: string | undefined } | undefined;
  #pendingActivation:
    | {
        readonly request: ReplicaCaptureRequest;
        readonly sourceWindowId: number;
        readonly replayLease: number;
      }
    | undefined;
  #pendingNotify:
    | {
        readonly document: ReplicaSourceDocumentIdentity;
        readonly replayLease: number;
      }
    | undefined;
  #releasePending = false;
  #purgeRequested = false;
  #resumeRequested = false;
  #refreshRequested = false;

  constructor(options: LazyImageTranslationControllerOptions) {
    this.#load = options.load;
    this.#onLoadError = options.onLoadError;
  }

  get busy(): boolean {
    return this.#controller?.busy ?? false;
  }

  configure(configuration: ImageTranslationConfiguration): void {
    this.#latestConfiguration = configuration;
    if (this.#controller) {
      this.#controller.configure(configuration);
      return;
    }
    // Configuration alone is not a use: the panel configures image
    // translation on every preference sync, including while it is off.
    if (!this.#disposed && configuration.enabled && this.#pendingActivation) {
      this.#ensureLoaded();
    }
  }

  activateReplica(
    request: ReplicaCaptureRequest,
    sourceWindowId: number,
    replayLease: number,
  ): boolean {
    if (this.#disposed) return false;
    this.#pendingActivation = { request, sourceWindowId, replayLease };
    this.#pendingNotify = undefined;
    this.#releasePending = false;
    if (this.#controller) {
      const accepted = this.#controller.activateReplica(
        request,
        sourceWindowId,
        replayLease,
      );
      if (accepted) this.#pendingActivation = undefined;
      return accepted;
    }
    // A disabled controller has nothing to do; keep the activation for the
    // configure that turns image translation on.
    if (this.#latestConfiguration === undefined || this.#latestConfiguration.enabled) {
      this.#ensureLoaded();
    }
    return true;
  }

  notifyReplicaCommit(
    document: ReplicaSourceDocumentIdentity,
    replayLease: number,
  ): boolean {
    if (this.#controller) {
      return this.#controller.notifyReplicaCommit(document, replayLease);
    }
    if (this.#disposed || !this.#pendingActivation) return false;
    this.#pendingNotify = { document, replayLease };
    return true;
  }

  resume(): void {
    if (this.#controller) {
      this.#controller.resume();
      return;
    }
    if (!this.#disposed) this.#resumeRequested = true;
  }

  refreshOverlays(): void {
    if (this.#controller) {
      this.#controller.refreshOverlays();
      return;
    }
    if (!this.#disposed) this.#refreshRequested = true;
  }

  cancelCurrent(): boolean {
    return this.#controller?.cancelCurrent() ?? false;
  }

  releaseReplica(): void {
    if (this.#controller) {
      this.#controller.releaseReplica();
      return;
    }
    this.#releasePending = true;
    this.#pendingActivation = undefined;
    this.#pendingNotify = undefined;
  }

  setTopPageOrigin(pageUrl: string | undefined): void {
    this.#topPageOrigin = { set: true, value: pageUrl };
    this.#controller?.setTopPageOrigin(pageUrl);
  }

  purgeSourceDerivedCache(): void {
    if (this.#controller) {
      this.#controller.purgeSourceDerivedCache();
      return;
    }
    this.#purgeRequested = true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#pendingActivation = undefined;
    this.#pendingNotify = undefined;
    this.#purgeRequested = false;
    this.#resumeRequested = false;
    this.#refreshRequested = false;
    const controller = this.#controller;
    this.#controller = undefined;
    controller?.dispose();
  }

  #ensureLoaded(): void {
    if (this.#controller || this.#loadPromise || this.#disposed) return;
    const loading = this.#load();
    const pending = (async () => {
      try {
        const controller = await loading;
        this.#loadPromise = undefined;
        if (this.#disposed) {
          controller.dispose();
          return;
        }
        this.#controller = controller;
        this.#applyPending(controller);
      } catch (error) {
        this.#loadPromise = undefined;
        this.#onLoadError?.(error);
      }
    })();
    this.#loadPromise = pending;
  }

  #applyPending(controller: ImageTranslationControllerLike): void {
    if (this.#latestConfiguration) {
      controller.configure(this.#latestConfiguration);
    }
    if (this.#topPageOrigin) {
      controller.setTopPageOrigin(this.#topPageOrigin.value);
    }
    // Nothing of this controller was derived yet, so the purge is a no-op
    // that keeps the security boundary visible for a later reviewer.
    if (this.#purgeRequested) controller.purgeSourceDerivedCache();
    if (this.#releasePending) controller.releaseReplica();
    const activation = this.#pendingActivation;
    if (activation) {
      this.#pendingActivation = undefined;
      controller.activateReplica(
        activation.request,
        activation.sourceWindowId,
        activation.replayLease,
      );
    }
    const notify = this.#pendingNotify;
    if (notify) {
      this.#pendingNotify = undefined;
      controller.notifyReplicaCommit(notify.document, notify.replayLease);
    }
    if (this.#resumeRequested) controller.resume();
    if (this.#refreshRequested) controller.refreshOverlays();
    this.#purgeRequested = false;
    this.#resumeRequested = false;
    this.#refreshRequested = false;
    this.#releasePending = false;
  }
}