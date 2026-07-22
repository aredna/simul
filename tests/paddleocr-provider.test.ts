import { describe, expect, it, vi } from 'vitest';

import type { ImageTextResult } from '../lib/ocr/contracts';
import type { OffscreenOcrJob } from '../lib/ocr/offscreen-protocol';
import {
  PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
  PADDLE_OCR_DETECTOR_THRESHOLD,
  PADDLE_OCR_MODEL_VERSION,
  PADDLE_OCR_PROVIDER_VERSION,
  PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
} from '../lib/ocr/providers/paddleocr-wasm/constants';
import { normalizePaddleOcrResult } from '../lib/ocr/providers/paddleocr-wasm/normalize';
import {
  PaddleOcrOffscreenRunner,
  PaddleRecognitionError,
  PaddleRuntimeLoaderError,
  PaddleSandboxUnavailableError,
  PaddleRuntimeStartupError,
  UnsupportedLanguageError,
  WorkerLostError,
  type PaddleSandboxClient,
  type PaddleSandboxClientCreateOptions,
} from '../lib/ocr/providers/paddleocr-wasm/runtime';
import {
  PADDLE_SANDBOX_MAX_INPUT_BYTES,
  readPaddleSandboxRunRequest,
} from '../lib/ocr/providers/paddleocr-wasm/sandbox-protocol';
import {
  createPaddleDirectPipeline,
  PaddleRuntimeLoaderError as SandboxPaddleRuntimeLoaderError,
  PaddleRuntimeStartupError as SandboxPaddleRuntimeStartupError,
} from '../lib/ocr/providers/paddleocr-wasm/sandbox-worker-pipeline';
import { OCR_NATIVE_PREPROCESSING_VERSION } from '../lib/ocr/preprocessing-profile';

describe('packaged PaddleOCR.js provider', () => {
  it('accepts only the exact same-extension assets and bounded encoded input', () => {
    const valid = {
      kind: 'simul:paddle-sandbox-v1:run',
      version: 1,
      requestId: 1,
      input: new Blob([new Uint8Array([1])]),
      bitmapWidth: 200,
      bitmapHeight: 100,
      assets: paddleAssets(),
    };
    expect(readPaddleSandboxRunRequest(valid)).toMatchObject(valid);
    expect(readPaddleSandboxRunRequest({
      ...valid,
      assets: {
        ...valid.assets,
        runtimeLoader:
          'chrome-extension://other/ocr/paddle/runtime/ort-wasm-simd-threaded.mjs',
      },
    })).toBeUndefined();
    expect(readPaddleSandboxRunRequest({
      ...valid,
      assets: {
        ...valid.assets,
        runtimeModule: 'chrome-extension://trial/background.js',
      },
    })).toBeUndefined();
    const oversized = new Blob();
    Object.defineProperty(oversized, 'size', {
      value: PADDLE_SANDBOX_MAX_INPUT_BYTES + 1,
    });
    expect(readPaddleSandboxRunRequest({
      ...valid,
      input: oversized,
    })).toBeUndefined();
  });

  it('strictly normalizes one scored spatial result and a clean empty result', () => {
    expect(normalizePaddleOcrResult(rawResult([{
      text: ' 日本語 ',
      score: 0.92,
      poly: [[10, 20], [90, 20], [90, 50], [10, 50]],
    }]), 200, 100)).toMatchObject({
      providerId: 'paddleocr-wasm',
      bitmapWidth: 200,
      bitmapHeight: 100,
      transcript: '日本語',
      transcriptConfidence: 0.92,
      geometryConfidence: 1,
      regions: [{
        text: '日本語',
        confidence: 0.92,
        boundingBox: { x: 10, y: 20, width: 80, height: 30 },
        polygon: [
          { x: 10, y: 20 },
          { x: 90, y: 20 },
          { x: 90, y: 50 },
          { x: 10, y: 50 },
        ],
      }],
    });
    expect(normalizePaddleOcrResult(rawResult([]), 200, 100)).toEqual({
      providerId: 'paddleocr-wasm',
      bitmapWidth: 200,
      bitmapHeight: 100,
      transcript: '',
      regions: [],
    });
  });

  it.each([
    ['wrong result count', []],
    ['wrong dimensions', [{ image: { width: 201, height: 100 }, items: [] }]],
    ['missing score', rawResult([{
      text: 'x',
      poly: [[1, 1], [2, 1], [2, 2], [1, 2]],
    }])],
    ['out-of-bounds polygon', rawResult([{
      text: 'x',
      score: 0.9,
      poly: [[-1, 1], [2, 1], [2, 2], [1, 2]],
    }])],
    ['degenerate polygon', rawResult([{
      text: 'x',
      score: 0.9,
      poly: [[1, 1], [1, 1], [1, 2], [1, 2]],
    }])],
    ['subpixel edge polygon', rawResult([{
      text: 'x',
      score: 0.9,
      poly: [[1, 1], [1.5, 1], [1.5, 10], [1, 10]],
    }])],
    ['subpixel area polygon', rawResult([{
      text: 'x',
      score: 0.9,
      poly: [[1, 10], [11, 10.04], [21, 10], [11, 9.96]],
    }])],
    ['self-intersecting polygon', rawResult([{
      text: 'x',
      score: 0.9,
      poly: [[1, 1], [10, 10], [1, 10], [10, 1]],
    }])],
    ['concave polygon', rawResult([{
      text: 'x',
      score: 0.9,
      poly: [[1, 1], [10, 1], [5, 5], [1, 10]],
    }])],
  ])('rejects malformed SDK output: %s', (_label, input) => {
    expect(normalizePaddleOcrResult(input, 200, 100)).toBeUndefined();
  });

  it('enforces the aggregate transcript budget including separators', () => {
    const withinBudget = Array.from({ length: 10 }, (_, index) => ({
      text: 'x'.repeat(index === 9 ? 99_991 : 100_000),
      score: 0.9,
      poly: [[10, 20], [90, 20], [90, 50], [10, 50]],
    }));
    const atLimit = normalizePaddleOcrResult(
      rawResult(withinBudget),
      200,
      100,
    );

    expect(atLimit).toBeDefined();
    expect(atLimit?.transcript).toHaveLength(1_000_000);

    const overBudget = withinBudget.map((item, index) => ({
      ...item,
      text: index === 9 ? 'x'.repeat(99_992) : item.text,
    }));
    expect(normalizePaddleOcrResult(
      rawResult(overBudget),
      200,
      100,
    )).toBeUndefined();
  });

  it('uses exact local sandbox assets and one reusable client', async () => {
    const client = fakeClient(normalizedResult('hello'));
    const createClient = vi.fn(async (
      _options: PaddleSandboxClientCreateOptions,
    ) => client);
    const runner = new PaddleOcrOffscreenRunner({
      createClient,
      getUrl: (assetPath) => `chrome-extension://trial${assetPath}`,
    });

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'hello' });
    await runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    );

    expect(createClient).toHaveBeenCalledOnce();
    expect(createClient.mock.calls[0]?.[0]).toMatchObject({
      sandboxUrl: 'chrome-extension://trial/paddle-ocr.html',
      assets: {
        runtimeModule:
          'chrome-extension://trial/ocr/paddle/worker/worker-entry.js',
        detectionModel:
          'chrome-extension://trial/ocr/paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar',
        recognitionModel:
          'chrome-extension://trial/ocr/paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
        runtimeLoader:
          'chrome-extension://trial/ocr/paddle/runtime/ort-wasm-simd-threaded.mjs',
        runtimeWasm:
          'chrome-extension://trial/ocr/paddle/runtime/ort-wasm-simd-threaded.wasm',
      },
    });
    expect(JSON.stringify(createClient.mock.calls[0]?.[0])).not.toMatch(
      /https?:\/\//u,
    );
    expect(client.recognize).toHaveBeenCalledTimes(2);
    expect(client.recognize).toHaveBeenCalledWith(expect.any(Blob), 200, 100);
    await runner.dispose();
    expect(client.terminate).toHaveBeenCalledOnce();
  });

  it('initializes and predicts through the exact direct sandbox module', async () => {
    const calls: Array<{
      readonly type: string;
      readonly payload: Record<string, unknown>;
    }> = [];
    const handler = vi.fn(async (
      type: string,
      payload: Record<string, unknown>,
    ) => {
      calls.push({ type, payload });
      return type === 'predict'
        ? rawResult([{
            text: 'local',
            score: 0.9,
            poly: [[10, 10], [90, 10], [90, 30], [10, 30]],
          }])
        : {};
    });
    const importRuntimeModule = vi.fn(async () => ({
      createPaddleOCRDirectHandler: () => handler,
    }));
    const importRuntimeLoader = vi.fn(async () => ({
      default: () => Promise.resolve({}),
    }));
    const close = vi.fn();
    const decode = vi.fn(async () => ({ close }) as unknown as ImageBitmap);
    const pipeline = await createPaddleDirectPipeline(paddleAssets(), {
      importRuntimeModule,
      importRuntimeLoader,
      decode,
    });
    await pipeline.predict(new Blob([new Uint8Array([1])]));

    expect(importRuntimeLoader).toHaveBeenCalledWith(
      paddleAssets().runtimeLoader,
    );
    expect(importRuntimeModule).toHaveBeenCalledWith(
      paddleAssets().runtimeModule,
    );
    expect(calls[0]).toMatchObject({
      type: 'init',
      payload: {
        options: {
          ortOptions: {
            backend: 'wasm',
            wasmPaths: {
              mjs:
                'chrome-extension://trial/ocr/paddle/runtime/ort-wasm-simd-threaded.mjs',
              wasm:
                'chrome-extension://trial/ocr/paddle/runtime/ort-wasm-simd-threaded.wasm',
            },
            numThreads: 1,
            simd: true,
            proxy: false,
          },
        },
      },
    });
    expect(JSON.stringify(calls[0])).not.toContain('https://');
    expect(calls[1]).toMatchObject({
      type: 'predict',
      payload: {
        params: {
          textDetThresh: PADDLE_OCR_DETECTOR_THRESHOLD,
          textDetBoxThresh: PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
          textRecScoreThresh: PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
        },
      },
    });
    pipeline.terminate();
  });

  it('classifies a missing direct module export as bounded startup failure', async () => {
    await expect(createPaddleDirectPipeline(paddleAssets(), {
      importRuntimeModule: async () => ({}),
      importRuntimeLoader: async () => ({ default: () => undefined }),
    })).rejects.toBeInstanceOf(SandboxPaddleRuntimeStartupError);
  });

  it('classifies an unloadable ONNX module as a bounded loader failure', async () => {
    await expect(createPaddleDirectPipeline(paddleAssets(), {
      importRuntimeLoader: async () => ({}),
    })).rejects.toBeInstanceOf(SandboxPaddleRuntimeLoaderError);
  });

  it('fails unsupported languages before creating the local sandbox', async () => {
    const createClient = vi.fn();
    const runner = new PaddleOcrOffscreenRunner({
      createClient,
      getUrl: testGetUrl,
    });

    await expect(runner.recognize(
      job('th'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(UnsupportedLanguageError);
    expect(createClient).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('terminates immediately on cancellation and ignores a stale late result', async () => {
    let resolveFirst!: (value: ImageTextResult) => void;
    const first = fakeClient(new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    const second = fakeClient(normalizedResult('fresh'));
    const createClient = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const runner = new PaddleOcrOffscreenRunner({
      createClient,
      getUrl: testGetUrl,
    });
    const abortController = new AbortController();
    const recognition = runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      abortController.signal,
    );
    void recognition.catch(() => undefined);
    await vi.waitFor(() => expect(first.recognize).toHaveBeenCalledOnce());

    abortController.abort();
    await expect(recognition).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.terminate).toHaveBeenCalledOnce();
    resolveFirst(normalizedResult('stale'));
    await Promise.resolve();

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'fresh' });
    expect(createClient).toHaveBeenCalledTimes(2);
    await runner.dispose();
  });

  it('cancels while the sandbox is still starting and disposes a late client', async () => {
    let resolveClient!: (value: PaddleSandboxClient) => void;
    const late = fakeClient(normalizedResult('late'));
    const runner = new PaddleOcrOffscreenRunner({
      createClient: vi.fn(() => new Promise<PaddleSandboxClient>((resolve) => {
        resolveClient = resolve;
      })),
      getUrl: testGetUrl,
    });
    const abortController = new AbortController();
    const recognition = runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      abortController.signal,
    );
    void recognition.catch(() => undefined);

    abortController.abort();
    await expect(recognition).rejects.toMatchObject({ name: 'AbortError' });
    resolveClient(late);
    await vi.waitFor(() => expect(late.terminate).toHaveBeenCalledOnce());
    await runner.dispose();
  });

  it('reports a stalled recognition precisely at the total job deadline', async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient(new Promise(() => undefined));
      const runner = new PaddleOcrOffscreenRunner({
        createClient: vi.fn(async () => client),
        getUrl: testGetUrl,
        jobTimeoutMs: 25,
      });
      const recognition = runner.recognize(
        job('en'),
        new Blob([new Uint8Array([1])]),
        new AbortController().signal,
      );
      void recognition.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(25);

      await expect(recognition).rejects.toBeInstanceOf(PaddleRecognitionError);
      expect(client.terminate).toHaveBeenCalledOnce();
      await runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes cold sandbox creation in the total job deadline', async () => {
    vi.useFakeTimers();
    try {
      const runner = new PaddleOcrOffscreenRunner({
        createClient: vi.fn(() =>
          new Promise<PaddleSandboxClient>(() => undefined)),
        getUrl: testGetUrl,
        jobTimeoutMs: 25,
        startupTimeoutMs: 100,
      });
      const recognition = runner.recognize(
        job('en'),
        new Blob([new Uint8Array([1])]),
        new AbortController().signal,
      );
      void recognition.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(25);

      await expect(recognition).rejects.toBeInstanceOf(PaddleRecognitionError);
      await runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transient sandbox availability failure', async () => {
    const client = fakeClient(normalizedResult('fresh'));
    const createClient = vi.fn()
      .mockRejectedValueOnce(new PaddleSandboxUnavailableError())
      .mockResolvedValueOnce(client);
    const runner = new PaddleOcrOffscreenRunner({
      createClient,
      getUrl: testGetUrl,
    });

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PaddleSandboxUnavailableError);
    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'fresh' });
    expect(createClient).toHaveBeenCalledTimes(2);
    await runner.dispose();
  });

  it('caches deterministic startup failure without retrying the sandbox', async () => {
    const createClient = vi.fn(async () => {
      throw new PaddleRuntimeStartupError();
    });
    const runner = new PaddleOcrOffscreenRunner({
      createClient,
      getUrl: testGetUrl,
    });

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PaddleRuntimeStartupError);
    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PaddleRuntimeStartupError);
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('caches a deterministic runtime-loader failure', async () => {
    const createClient = vi.fn(async () => {
      throw new PaddleRuntimeLoaderError();
    });
    const runner = new PaddleOcrOffscreenRunner({
      createClient,
      getUrl: testGetUrl,
    });

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PaddleRuntimeLoaderError);
    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PaddleRuntimeLoaderError);
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('recreates a client after a transient worker loss', async () => {
    const lost = Promise.reject<ImageTextResult>(new WorkerLostError());
    void lost.catch(() => undefined);
    const first = fakeClient(lost);
    const second = fakeClient(normalizedResult('fresh'));
    const createClient = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const runner = new PaddleOcrOffscreenRunner({
      createClient,
      getUrl: testGetUrl,
    });

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(WorkerLostError);
    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'fresh' });
    expect(createClient).toHaveBeenCalledTimes(2);
  });
});

function rawResult(items: readonly unknown[]) {
  return [{
    image: { width: 200, height: 100 },
    items,
    metrics: {},
    runtime: {},
  }];
}

function fakeClient(
  result: ImageTextResult | Promise<ImageTextResult>,
){
  const client = {
    recognize: vi.fn(async (
      _input: Blob,
      _bitmapWidth: number,
      _bitmapHeight: number,
    ) => result),
    terminate: vi.fn(() => undefined),
    dispose: vi.fn(async () => undefined),
  } satisfies PaddleSandboxClient;
  return client;
}

function normalizedResult(transcript: string): ImageTextResult {
  return {
    providerId: 'paddleocr-wasm',
    bitmapWidth: 200,
    bitmapHeight: 100,
    transcript,
    regions: transcript
      ? [{
          text: transcript,
          confidence: 0.9,
          boundingBox: { x: 10, y: 10, width: 80, height: 20 },
        }]
      : [],
  };
}

function paddleAssets() {
  return {
    runtimeModule:
      'chrome-extension://trial/ocr/paddle/worker/worker-entry.js',
    detectionModel:
      'chrome-extension://trial/ocr/paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar',
    recognitionModel:
      'chrome-extension://trial/ocr/paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
    runtimeLoader:
      'chrome-extension://trial/ocr/paddle/runtime/ort-wasm-simd-threaded.mjs',
    runtimeWasm:
      'chrome-extension://trial/ocr/paddle/runtime/ort-wasm-simd-threaded.wasm',
  };
}

function testGetUrl(assetPath: string): string {
  return `chrome-extension://trial${assetPath}`;
}

function job(languageGroup: string): OffscreenOcrJob {
  return {
    jobId: crypto.randomUUID(),
    clientId: 'client-paddle',
    attempt: 0,
    document: {
      sessionId: 'session-paddle',
      pageEpoch: 1,
      generation: 1,
      documentId: 'document-paddle',
      frameId: 0,
    },
    nodeId: 1,
    contentRevision: 1,
    observationRevision: 1,
    inputKey: 'input-paddle',
    pixelHash: 'ab'.repeat(32),
    bitmapWidth: 200,
    bitmapHeight: 100,
    providerId: 'paddleocr-wasm',
    languageGroup,
    providerVersion: PADDLE_OCR_PROVIDER_VERSION,
    modelVersion: PADDLE_OCR_MODEL_VERSION,
    preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
    qualityPolicyVersion: 'precision-v1',
    minimumConfidence: 0.65,
    schemaVersion: 1,
  };
}
