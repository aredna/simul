import { describe, expect, it, vi } from 'vitest';

import {
  readOffscreenOcrJob,
  type OffscreenOcrJob,
} from '../lib/ocr/offscreen-protocol';
import { TESSERACT_MODEL_VERSION } from '../lib/ocr/providers/tesseract/language-catalog';
import { normalizeDirectTesseractTextItems } from '../lib/ocr/providers/tesseract-wasm-direct/normalize';
import {
  TesseractWasmDirectOffscreenRunner,
} from '../lib/ocr/providers/tesseract-wasm-direct/runtime';
import { OCR_NATIVE_PREPROCESSING_VERSION } from '../lib/ocr/preprocessing-profile';

describe('direct Tesseract-Wasm provider', () => {
  it('strictly validates its separately versioned offscreen job', () => {
    const candidate = job('eng');
    expect(readOffscreenOcrJob(candidate)).toEqual(candidate);
    expect(readOffscreenOcrJob({
      ...candidate,
      providerVersion: 'tesseract.js-7.0.0',
    })).toBeUndefined();
  });

  it('normalizes direct line boxes and native [0, 1] confidence', () => {
    const normalized = normalizeDirectTesseractTextItems([
      {
        text: ' hello ',
        confidence: 0.91,
        rect: { left: 10.2, top: 20.7, right: 80.1, bottom: 40.2 },
      },
      {
        text: 'world',
        confidence: 0.73,
        rect: { left: -5, top: 45, right: 220, bottom: 70 },
      },
    ], 200, 100);

    expect(normalized).toMatchObject({
      providerId: 'tesseract-wasm-direct',
      transcript: 'hello\nworld',
      regions: [
        {
          text: 'hello',
          confidence: 0.91,
          boundingBox: { x: 10, y: 20, width: 71, height: 21 },
        },
        {
          text: 'world',
          confidence: 0.73,
          boundingBox: { x: 0, y: 45, width: 200, height: 25 },
        },
      ],
    });
    expect(normalized?.transcriptConfidence).toBeCloseTo(0.82);
    expect(normalized?.geometryConfidence).toBeCloseTo(0.82);
    expect(normalizeDirectTesseractTextItems([], 0, 100)).toBeUndefined();
  });

  it('rejects malformed, out-of-range, and cumulatively oversized output', () => {
    expect(normalizeDirectTesseractTextItems([{
      text: 'missing geometry',
      confidence: 0.9,
    }], 200, 100)).toBeUndefined();
    expect(normalizeDirectTesseractTextItems([{
      text: 'wrong confidence scale',
      confidence: 90,
      rect: { left: 1, top: 1, right: 20, bottom: 12 },
    }], 200, 100)).toBeUndefined();
    expect(normalizeDirectTesseractTextItems(
      Array.from({ length: 11 }, () => ({
        text: 'x'.repeat(100_000),
        confidence: 0.9,
        rect: { left: 1, top: 1, right: 20, bottom: 12 },
      })),
      200,
      100,
    )).toBeUndefined();
  });

  it('uses only packaged Worker, Wasm, and shared model paths and reuses a group', async () => {
    const first = fakeClient('first');
    const second = fakeClient('second');
    const clients = [first, second];
    const createClient = vi.fn((..._args: unknown[]) => clients.shift()!.client);
    const loadArrayBuffer = vi.fn(async (_url: string) =>
      new Uint8Array([1, 2, 3]).buffer);
    const decompressGzip = vi.fn(async (input: ArrayBuffer) => input);
    const runner = new TesseractWasmDirectOffscreenRunner({
      createClient,
      getUrl: (path) => `chrome-extension://id${path}`,
      loadArrayBuffer,
      decompressGzip,
      decodeImage: vi.fn(async () => ({ close: vi.fn() }) as never),
      supportsFastBuild: () => true,
    });
    const signal = new AbortController().signal;
    const encoded = new Blob([new Uint8Array([1])], { type: 'image/png' });

    await expect(runner.recognize(job('eng'), encoded, signal)).resolves
      .toMatchObject({ providerId: 'tesseract-wasm-direct', transcript: 'first' });
    await expect(runner.recognize(job('eng'), encoded, signal)).resolves
      .toMatchObject({ transcript: 'first' });
    await expect(runner.recognize(job('jpn'), encoded, signal)).resolves
      .toMatchObject({ transcript: 'second' });

    expect(createClient).toHaveBeenCalledTimes(2);
    expect(createClient.mock.calls[0]?.[0]).toMatchObject({
      workerURL:
        'chrome-extension://id/ocr/tesseract-wasm/worker/tesseract-worker.js',
      wasmBinary: expect.any(ArrayBuffer),
      createWorker: expect.any(Function),
    });
    expect(loadArrayBuffer.mock.calls.map(([url]) => url)).toEqual([
      'chrome-extension://id/ocr/tesseract-wasm/core/tesseract-core.wasm',
      'chrome-extension://id/ocr/tesseract/lang/eng.traineddata.gz',
      'chrome-extension://id/ocr/tesseract-wasm/core/tesseract-core.wasm',
      'chrome-extension://id/ocr/tesseract/lang/jpn.traineddata.gz',
    ]);
    expect(decompressGzip).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(second.client.loadModel).toHaveBeenCalledOnce();
    expect(second.client.loadImage).toHaveBeenCalledOnce();
    expect(second.client.clearImage).toHaveBeenCalledOnce();
    await runner.dispose();
    expect(second.destroy).toHaveBeenCalledOnce();
  });

  it('fails a composite model group instead of silently loading only one model', async () => {
    const loadArrayBuffer = vi.fn(async (_url: string) =>
      new Uint8Array([1]).buffer);
    const runner = new TesseractWasmDirectOffscreenRunner({
      createClient: () => fakeClient('unused').client,
      getUrl: (path) => `chrome-extension://id${path}`,
      loadArrayBuffer,
    });

    await expect(runner.recognize(
      job('jpn+jpn_vert'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: 'UnsupportedLanguageError' });
    expect(loadArrayBuffer).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('aborts in-flight packaged asset loading when preparation times out', async () => {
    let preparationSignal: AbortSignal | undefined;
    const runner = new TesseractWasmDirectOffscreenRunner({
      createClient: () => fakeClient('unused').client,
      getUrl: (path) => `chrome-extension://id${path}`,
      loadArrayBuffer: (_url, signal) => {
        preparationSignal = signal;
        return new Promise<ArrayBuffer>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
      },
      jobTimeoutMs: 1,
    });

    await expect(runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: 'WorkerLostError' });
    expect(preparationSignal?.aborted).toBe(true);
    await runner.dispose();
  });

  it('selects the packaged fallback core when Wasm SIMD is unavailable', async () => {
    const fake = fakeClient('fallback');
    const loadArrayBuffer = vi.fn(async (_url: string) =>
      new Uint8Array([1]).buffer);
    const runner = new TesseractWasmDirectOffscreenRunner({
      createClient: () => fake.client,
      getUrl: (path) => `chrome-extension://id${path}`,
      loadArrayBuffer,
      decompressGzip: async (input) => input,
      decodeImage: async () => ({}) as never,
      supportsFastBuild: () => false,
    });

    await runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    );

    expect(loadArrayBuffer).toHaveBeenCalledWith(
      'chrome-extension://id/ocr/tesseract-wasm/core/tesseract-core-fallback.wasm',
      expect.any(AbortSignal),
    );
    await runner.dispose();
  });
});

function job(languageGroup: string): OffscreenOcrJob {
  return {
    jobId: crypto.randomUUID(),
    clientId: 'client-tesseract-wasm-direct',
    attempt: 0,
    document: {
      sessionId: 'session-direct',
      pageEpoch: 1,
      generation: 1,
      documentId: 'document-direct',
      frameId: 0,
    },
    nodeId: 4,
    contentRevision: 1,
    observationRevision: 1,
    inputKey: 'input-direct',
    pixelHash: 'ab'.repeat(32),
    bitmapWidth: 200,
    bitmapHeight: 100,
    providerId: 'tesseract-wasm-direct',
    languageGroup,
    providerVersion: 'tesseract-wasm-0.11.0',
    modelVersion: TESSERACT_MODEL_VERSION,
    preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
    qualityPolicyVersion: 'precision-v1',
    minimumConfidence: 0.65,
    schemaVersion: 1,
  };
}

function fakeClient(text: string) {
  const destroy = vi.fn(async () => undefined);
  return {
    destroy,
    client: {
      loadModel: vi.fn(async () => undefined),
      loadImage: vi.fn(async () => undefined),
      getTextBoxes: vi.fn(async () => [{
        text,
        confidence: 0.9,
        flags: 0,
        rect: { left: 1, top: 1, right: 20, bottom: 12 },
      }]),
      clearImage: vi.fn(async () => undefined),
      destroy,
    },
  };
}
