import { describe, expect, it, vi } from 'vitest';

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
  UnsupportedLanguageError,
  WorkerLostError,
} from '../lib/ocr/providers/paddleocr-wasm/runtime';
import { OCR_NATIVE_PREPROCESSING_VERSION } from '../lib/ocr/preprocessing-profile';

describe('packaged PaddleOCR.js provider', () => {
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

  it('uses only exact local assets, fixed detector thresholds, and one reusable Worker pipeline', async () => {
    const pipeline = fakePipeline(rawResult([{
      text: 'hello',
      score: 0.9,
      poly: [[10, 10], [90, 10], [90, 30], [10, 30]],
    }]));
    const createPipeline = vi.fn(async (_options: unknown) => pipeline);
    const createWorker = vi.fn();
    const runner = new PaddleOcrOffscreenRunner({
      createPipeline: createPipeline as never,
      createWorker: createWorker as never,
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

    expect(createPipeline).toHaveBeenCalledOnce();
    expect(createPipeline.mock.calls[0]?.[0]).toMatchObject({
      workerUrl: 'chrome-extension://trial/ocr/paddle/worker/worker-entry.js',
      detectionModelUrl:
        'chrome-extension://trial/ocr/paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar',
      recognitionModelUrl:
        'chrome-extension://trial/ocr/paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
      runtimeWasmUrl:
        'chrome-extension://trial/ocr/paddle/runtime/ort-wasm-simd-threaded.wasm',
    });
    expect(JSON.stringify(createPipeline.mock.calls[0]?.[0])).not.toMatch(
      /https?:\/\//u,
    );
    expect(pipeline.predict).toHaveBeenCalledTimes(2);
    expect(pipeline.predict).toHaveBeenCalledWith(expect.any(Blob), {
      textDetThresh: PADDLE_OCR_DETECTOR_THRESHOLD,
      textDetBoxThresh: PADDLE_OCR_DETECTOR_BOX_THRESHOLD,
      textRecScoreThresh: PADDLE_OCR_RECOGNITION_SCORE_THRESHOLD,
    });
    expect(createWorker).not.toHaveBeenCalled();
    await runner.dispose();
    expect(pipeline.terminate).toHaveBeenCalledOnce();
  });

  it('initializes ORT with the exact packaged Wasm file and no loader lookup', async () => {
    const messages: Array<{
      readonly type: string;
      readonly payload: Record<string, unknown>;
      readonly requestId: number;
    }> = [];
    const worker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      postMessage(message: unknown) {
        const request = message as (typeof messages)[number];
        messages.push(request);
        const payload = request.type === 'predict'
          ? rawResult([{
              text: 'local',
              score: 0.9,
              poly: [[10, 10], [90, 10], [90, 30], [10, 30]],
            }])
          : {};
        queueMicrotask(() => this.onmessage?.({
          data: {
            kind: 'worker-transport-response',
            status: 'success',
            requestId: request.requestId,
            payload,
          },
        } as MessageEvent<unknown>));
      },
      terminate: vi.fn(),
    };
    const runner = new PaddleOcrOffscreenRunner({
      createWorker: vi.fn(() => worker as unknown as Worker),
      decode: vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap),
      getUrl: (assetPath) => `chrome-extension://trial${assetPath}`,
    });

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'local' });

    expect(messages[0]).toMatchObject({
      type: 'init',
      payload: {
        options: {
          ortOptions: {
            backend: 'wasm',
            wasmPaths: {
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
    expect(JSON.stringify(messages[0])).not.toContain('.jsep.mjs');
    await runner.dispose();
  });

  it('releases a pending default-pipeline init when cancellation terminates its Worker', async () => {
    type WorkerRequest = {
      readonly type: string;
      readonly requestId: number;
    };
    const firstMessages: WorkerRequest[] = [];
    const firstWorker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      postMessage: vi.fn((message: unknown) => {
        firstMessages.push(message as WorkerRequest);
      }),
      terminate: vi.fn(),
    };
    const secondMessages: WorkerRequest[] = [];
    const secondWorker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      postMessage(message: unknown) {
        const request = message as WorkerRequest;
        secondMessages.push(request);
        const payload = request.type === 'predict'
          ? rawResult([{
              text: 'fresh',
              score: 0.95,
              poly: [[10, 10], [90, 10], [90, 30], [10, 30]],
            }])
          : {};
        queueMicrotask(() => this.onmessage?.({
          data: {
            kind: 'worker-transport-response',
            status: 'success',
            requestId: request.requestId,
            payload,
          },
        } as MessageEvent<unknown>));
      },
      terminate: vi.fn(),
    };
    const workers = [firstWorker, secondWorker];
    const createWorker = vi.fn(() =>
      workers.shift() as unknown as Worker);
    const runner = new PaddleOcrOffscreenRunner({
      createWorker,
      decode: vi.fn(async () => ({ close: vi.fn() }) as unknown as ImageBitmap),
      getUrl: (assetPath) => `chrome-extension://trial${assetPath}`,
    });
    const abortController = new AbortController();
    const recognition = runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      abortController.signal,
    );
    void recognition.catch(() => undefined);
    await vi.waitFor(() => expect(firstMessages[0]).toMatchObject({
      type: 'init',
    }));

    abortController.abort();
    await runner.cancelActive();
    await expect(recognition).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();

    const firstRequestId = firstMessages[0]?.requestId;
    if (!firstRequestId) throw new Error('Expected a pending init request.');
    firstWorker.onmessage?.({
      data: {
        kind: 'worker-transport-response',
        status: 'success',
        requestId: firstRequestId,
        payload: {},
      },
    } as MessageEvent<unknown>);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(firstMessages.map(({ type }) => type)).toEqual(['init']);
    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'fresh' });
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(secondMessages.map(({ type }) => type)).toEqual([
      'init',
      'predict',
    ]);
    await runner.dispose();
  });

  it('fails unsupported languages before creating the local pipeline', async () => {
    const createPipeline = vi.fn();
    const runner = new PaddleOcrOffscreenRunner({
      createPipeline: createPipeline as never,
    });

    await expect(runner.recognize(
      job('th'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(UnsupportedLanguageError);
    expect(createPipeline).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('terminates immediately on cancellation and ignores a stale late result', async () => {
    let resolveFirst!: (value: unknown) => void;
    const first = fakePipeline(new Promise((resolve) => {
      resolveFirst = resolve;
    }));
    const second = fakePipeline(rawResult([{
      text: 'fresh',
      score: 0.95,
      poly: [[10, 10], [90, 10], [90, 30], [10, 30]],
    }]));
    const createPipeline = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const runner = new PaddleOcrOffscreenRunner({
      createPipeline: createPipeline as never,
      getUrl: (assetPath) => `chrome-extension://trial${assetPath}`,
    });
    const abortController = new AbortController();
    const recognition = runner.recognize(
      job('en'),
      new Blob([new Uint8Array([1])]),
      abortController.signal,
    );
    await vi.waitFor(() => expect(first.predict).toHaveBeenCalledOnce());

    abortController.abort();
    await expect(recognition).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.terminate).toHaveBeenCalledOnce();
    resolveFirst(rawResult([{
      text: 'stale',
      score: 0.99,
      poly: [[10, 10], [90, 10], [90, 30], [10, 30]],
    }]));
    await Promise.resolve();

    await expect(runner.recognize(
      job('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'fresh' });
    expect(createPipeline).toHaveBeenCalledTimes(2);
    await runner.dispose();
  });

  it('terminates a stalled pipeline at the total job deadline', async () => {
    vi.useFakeTimers();
    try {
      const pipeline = fakePipeline(new Promise(() => undefined));
      const runner = new PaddleOcrOffscreenRunner({
        createPipeline: vi.fn(async () => pipeline) as never,
        getUrl: (assetPath) => `chrome-extension://trial${assetPath}`,
        jobTimeoutMs: 25,
      });
      const recognition = runner.recognize(
        job('en'),
        new Blob([new Uint8Array([1])]),
        new AbortController().signal,
      );
      void recognition.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(25);

      await expect(recognition).rejects.toBeInstanceOf(WorkerLostError);
      expect(pipeline.terminate).toHaveBeenCalledOnce();
      await runner.dispose();
    } finally {
      vi.useRealTimers();
    }
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

function fakePipeline(result: unknown | Promise<unknown>) {
  return {
    predict: vi.fn(async () => result),
    terminate: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
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
