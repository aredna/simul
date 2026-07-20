import type { ReplicaImageSurface } from './contracts';
import type { ReplicaSourceDocumentIdentity } from './source-identity';
import type {
  ReplicaProjectionContext,
  ReplicaTextProjection,
  ReplicaTranslationSnapshot,
  ReplicaTranslationSurface,
} from '../translation/replica-translation-coordinator';

export type ReplicaProjectionSurface =
  ReplicaTranslationSurface & ReplicaImageSurface;

/** Routes derived translation/OCR work only to the currently selected engine. */
export class ReplicaSurfaceRouter
  implements ReplicaTranslationSurface, ReplicaImageSurface {
  #surface: ReplicaProjectionSurface | undefined;
  #projectionContext: ReplicaProjectionContext = {
    translationEpoch: 0,
    pairKey: undefined,
  };

  select(surface: ReplicaProjectionSurface | undefined): void {
    if (surface === this.#surface) return;
    this.#surface?.beginProjection({
      translationEpoch: this.#projectionContext.translationEpoch + 1,
      pairKey: undefined,
    });
    this.#surface = surface;
    surface?.beginProjection(this.#projectionContext);
  }

  beginProjection(context: ReplicaProjectionContext): void {
    this.#projectionContext = Object.freeze({ ...context });
    this.#surface?.beginProjection(context);
  }

  snapshot(): ReplicaTranslationSnapshot | undefined {
    return this.#surface?.snapshot();
  }

  project(projection: ReplicaTextProjection): boolean {
    return this.#surface?.project(projection) ?? false;
  }

  resolveImageAnchor(
    document: ReplicaSourceDocumentIdentity,
    nodeId: number,
  ) {
    return this.#surface?.resolveImageAnchor(document, nodeId);
  }
}
