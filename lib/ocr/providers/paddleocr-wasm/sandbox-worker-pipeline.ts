import {
  PADDLE_OCR_DETECTION_MODEL_NAME,
  PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
  PADDLE_OCR_DETECTOR_THRESHOLD,
  PADDLE_OCR_RECOGNITION_MODEL_NAME,
  PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
} from './constants';
import type { PaddleSandboxAssetUrls } from './sandbox-protocol';

type PaddleDirectRequestType = 'init' | 'predict' | 'dispose';
type PaddleDirectHandler = (
  type: PaddleDirectRequestType,
  payload: Record<string, unknown>,
) => Promise<unknown>;

export const PADDLE_DIRECT_RUNTIME_EXPORT =
  'createPaddleOCRDirectHandler' as const;

export interface PaddleDirectPipeline {
  predict(input: Blob): Promise<unknown>;
  terminate(): void;
  dispose(): Promise<void>;
}

export interface PaddleDirectPipelineEnvironment {
  readonly importRuntimeModule?: (url: string) => Promise<unknown>;
  readonly importRuntimeLoader?: (url: string) => Promise<unknown>;
  readonly decode?: (encoded: Blob) => Promise<ImageBitmap>;
}

/** Runs the pinned Paddle handler directly in the unprivileged sandbox. */
export async function createPaddleDirectPipeline(
  assets: PaddleSandboxAssetUrls,
  environment: PaddleDirectPipelineEnvironment = {},
): Promise<PaddleDirectPipeline> {
  await loadRuntimeLoader(
    assets.runtimeLoader,
    environment.importRuntimeLoader ?? importPackagedRuntimeModule,
  );
  const handler = await loadDirectHandler(
    assets.runtimeModule,
    environment.importRuntimeModule ?? importPackagedRuntimeModule,
  );
  const pipeline = new DirectHandlerPipeline(
    handler,
    environment.decode ?? ((encoded) => createImageBitmap(encoded)),
  );
  try {
    await handler('init', {
      options: {
        pipelineConfig: {
          pipelineName: 'OCR',
          raw: {},
          warnings: [],
          unsupportedFeatures: [],
          modelSelection: {
            textDetectionModelName: PADDLE_OCR_DETECTION_MODEL_NAME,
            textRecognitionModelName: PADDLE_OCR_RECOGNITION_MODEL_NAME,
          },
          assets: {
            det: { url: assets.detectionModel },
            rec: { url: assets.recognitionModel },
          },
          runtimeDefaults: {
            text_det_limit_side_len: 960,
            text_det_limit_type: 'max',
            text_det_max_side_limit: 4000,
            text_det_thresh: PADDLE_OCR_DETECTOR_THRESHOLD,
            text_det_box_thresh: PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
            text_det_unclip_ratio: 2,
            text_rec_score_thresh: PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
          },
          pipelineBatchSize: 1,
          textDetectionBatchSize: 1,
          textRecognitionBatchSize: 1,
        },
        ortOptions: {
          backend: 'wasm',
          wasmPaths: {
            mjs: assets.runtimeLoader,
            wasm: assets.runtimeWasm,
          },
          numThreads: 1,
          simd: true,
          proxy: false,
          disableWasmProxy: true,
        },
      },
    });
    return pipeline;
  } catch (error) {
    await pipeline.dispose().catch(() => undefined);
    throw error instanceof PaddleRuntimeStartupError
      ? error
      : new PaddleRuntimeStartupError({ cause: error });
  }
}

class DirectHandlerPipeline implements PaddleDirectPipeline {
  #disposed = false;

  constructor(
    private readonly handler: PaddleDirectHandler,
    private readonly decode: (encoded: Blob) => Promise<ImageBitmap>,
  ) {}

  async predict(input: Blob): Promise<unknown> {
    if (this.#disposed) throw new PaddleWorkerLostError();
    const bitmap = await this.decode(input);
    if (this.#disposed) {
      safelyCloseBitmap(bitmap);
      throw new PaddleWorkerLostError();
    }
    try {
      return await this.handler('predict', {
        sources: [{ kind: 'imageBitmap', imageBitmap: bitmap }],
        params: {
          textDetThresh: PADDLE_OCR_DETECTOR_THRESHOLD,
          textDetBoxThresh: PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
          textRecScoreThresh: PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
        },
      });
    } catch (error) {
      // The direct handler normally closes its ImageBitmap during source
      // cleanup. A pre-conversion failure still leaves ownership here.
      safelyCloseBitmap(bitmap);
      throw error;
    }
  }

  terminate(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.handler('dispose', {}).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.handler('dispose', {});
  }
}

async function loadDirectHandler(
  url: string,
  importRuntimeModule: (url: string) => Promise<unknown>,
): Promise<PaddleDirectHandler> {
  try {
    const imported = await importRuntimeModule(url);
    if (!isRecord(imported)) throw new TypeError('Invalid Paddle module.');
    const factory = imported[PADDLE_DIRECT_RUNTIME_EXPORT];
    if (typeof factory !== 'function') {
      throw new TypeError('The Paddle direct handler export is missing.');
    }
    const handler: unknown = factory();
    if (typeof handler !== 'function') {
      throw new TypeError('The Paddle direct handler is invalid.');
    }
    return handler as PaddleDirectHandler;
  } catch (error) {
    throw new PaddleRuntimeStartupError({ cause: error });
  }
}

function importPackagedRuntimeModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url) as Promise<unknown>;
}

async function loadRuntimeLoader(
  url: string,
  importRuntimeLoader: (url: string) => Promise<unknown>,
): Promise<void> {
  try {
    const imported = await importRuntimeLoader(url);
    if (!isRecord(imported) || typeof imported.default !== 'function') {
      throw new TypeError('Invalid Paddle runtime loader module.');
    }
  } catch (error) {
    throw new PaddleRuntimeLoaderError({ cause: error });
  }
}

function safelyCloseBitmap(bitmap: ImageBitmap): void {
  try {
    bitmap.close();
  } catch {
    // The handler may already have closed the direct sandbox source.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class PaddleRuntimeLoaderError extends Error {
  override readonly name = 'PaddleRuntimeLoaderError';

  constructor(options?: ErrorOptions) {
    super('The pinned Paddle runtime loader could not be loaded.', options);
  }
}

export class PaddleRuntimeStartupError extends Error {
  override readonly name = 'PaddleRuntimeStartupError';

  constructor(options?: ErrorOptions) {
    super('The Paddle runtime could not initialize.', options);
  }
}

export class PaddleWorkerLostError extends Error {
  override readonly name = 'PaddleWorkerLostError';
}
