import { describe, expect, it, vi } from 'vitest';

import type { OffscreenOcrJob } from '../lib/ocr/offscreen-protocol';
import { OCR_NATIVE_PREPROCESSING_VERSION } from '../lib/ocr/preprocessing-profile';
import { normalizeChromeTextDetection } from '../lib/ocr/providers/chrome-text-detector/normalize';
import { probeChromeTextDetector } from '../lib/ocr/providers/chrome-text-detector/probe';
import {
  ChromeTextDetectorOffscreenRunner,
  UnsupportedLanguageError,
} from '../lib/ocr/providers/chrome-text-detector/runtime';

describe('Chrome TextDetector provider', () => {
  it('normalizes recognized text, clamped boxes, and corner geometry', () => {
    expect(normalizeChromeTextDetection([{
      rawValue: ' hello ',
      boundingBox: { x: -2, y: 4, width: 50.2, height: 20.1 },
      cornerPoints: [
        { x: -2, y: 4 },
        { x: 49, y: 4 },
        { x: 49, y: 25 },
        { x: -2, y: 25 },
      ],
    }], 40, 30)).toMatchObject({
      providerId: 'chrome-text-detector',
      transcript: 'hello',
      regions: [{
        text: 'hello',
        boundingBox: { x: 0, y: 4, width: 40, height: 21 },
        polygon: [
          { x: 0, y: 4 },
          { x: 40, y: 4 },
          { x: 40, y: 25 },
          { x: 0, y: 25 },
        ],
      }],
    });
  });

  it('preserves boxes-only output as empty-text region hints', () => {
    expect(normalizeChromeTextDetection([{
      boundingBox: { x: 3, y: 4, width: 20, height: 10 },
      cornerPoints: [],
    }], 100, 50)).toMatchObject({
      transcript: '',
      regions: [{
        text: '',
        boundingBox: { x: 3, y: 4, width: 20, height: 10 },
      }],
    });
  });

  it('uses a real local detect call for its capability probe', async () => {
    const detect = vi.fn(async () => []);
    const create = vi.fn(async () => ({ detect }));
    const capability = await probeChromeTextDetector({
      getApi: () => ({ create } as unknown as TextDetectorConstructor),
      createProbeSource: () => ({ local: true } as unknown as ImageBitmapSource),
    });

    expect(capability).toEqual({ status: 'available' });
    expect(create).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledWith({ local: true });
    await expect(probeChromeTextDetector({
      getApi: () => undefined,
    })).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('keeps probe and offscreen deadline callbacks receiver-free', async () => {
    const receivers: unknown[] = [];
    let timerSequence = 0;
    const setTimer = function (
      this: unknown,
      _callback: () => void,
      _milliseconds?: number,
    ): ReturnType<typeof setTimeout> {
      receivers.push(this);
      timerSequence += 1;
      return timerSequence as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer = function (
      this: unknown,
      _handle: ReturnType<typeof setTimeout>,
    ): void {
      receivers.push(this);
    };
    const detect = vi.fn(async () => []);
    const create = vi.fn(async () => ({ detect }));

    await expect(probeChromeTextDetector({
      getApi: () => ({ create } as unknown as TextDetectorConstructor),
      createProbeSource: () => ({ local: true } as unknown as ImageBitmapSource),
      setTimer,
      clearTimer,
    })).resolves.toEqual({ status: 'available' });

    const close = vi.fn();
    const runner = new ChromeTextDetectorOffscreenRunner({
      getApi: () => ({ create } as unknown as TextDetectorConstructor),
      decode: async () => ({ width: 100, height: 50, close } as ImageBitmap),
      setTimer,
      clearTimer,
    });
    await expect(runner.recognize(
      textDetectorJob('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: '' });
    await runner.dispose();

    expect(receivers).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('runs in the offscreen adapter and fails closed for unsupported languages', async () => {
    const close = vi.fn();
    const detect = vi.fn(async () => [{
      rawValue: 'hola',
      boundingBox: { x: 1, y: 2, width: 20, height: 8 },
      cornerPoints: [],
    }]);
    const availability = vi.fn(async () => 'available' as const);
    const create = vi.fn(async () => ({ detect }));
    const runner = new ChromeTextDetectorOffscreenRunner({
      getApi: () => ({
        availability,
        create,
      } as unknown as TextDetectorConstructor),
      decode: async () => ({ width: 100, height: 50, close } as ImageBitmap),
    });

    await expect(runner.recognize(
      textDetectorJob('es'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'hola' });
    expect(availability).toHaveBeenCalledWith({ languages: ['es'] });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      languages: ['es'],
      signal: expect.any(AbortSignal),
    }));
    expect(close).toHaveBeenCalledOnce();

    const unavailable = new ChromeTextDetectorOffscreenRunner({
      getApi: () => ({
        availability: async () => 'unavailable',
        create,
      } as unknown as TextDetectorConstructor),
      decode: async () => ({ width: 100, height: 50, close } as ImageBitmap),
    });
    await expect(unavailable.recognize(
      textDetectorJob('ja'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(UnsupportedLanguageError);
    await runner.dispose();
    await unavailable.dispose();
  });

  it('closes a timed-out bitmap and replaces the still-busy detector', async () => {
    const timers = deadlineFixture();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const firstDetect = vi.fn(() => new Promise<readonly DetectedText[]>(() => {}));
    const secondDetect = vi.fn(async () => []);
    const create = vi.fn()
      .mockResolvedValueOnce({ detect: firstDetect })
      .mockResolvedValueOnce({ detect: secondDetect });
    const decode = vi.fn()
      .mockResolvedValueOnce({ width: 100, height: 50, close: firstClose })
      .mockResolvedValueOnce({ width: 100, height: 50, close: secondClose });
    const runner = new ChromeTextDetectorOffscreenRunner({
      getApi: () => ({ create } as unknown as TextDetectorConstructor),
      decode: decode as (encoded: Blob) => Promise<ImageBitmap>,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      jobTimeoutMs: 5,
    });

    const first = runner.recognize(
      textDetectorJob('en'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(firstDetect).toHaveBeenCalledOnce());
    timers.fireNext();

    await expect(first).rejects.toMatchObject({ name: 'TextDetectorTimeoutError' });
    expect(firstClose).toHaveBeenCalledOnce();
    await expect(runner.recognize(
      textDetectorJob('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: '' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(firstDetect).toHaveBeenCalledOnce();
    expect(secondDetect).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    await runner.dispose();
  });

  it('closes an aborted bitmap and replaces the still-busy detector', async () => {
    const timers = deadlineFixture();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const firstDetect = vi.fn(() => new Promise<readonly DetectedText[]>(() => {}));
    const secondDetect = vi.fn(async () => []);
    const create = vi.fn()
      .mockResolvedValueOnce({ detect: firstDetect })
      .mockResolvedValueOnce({ detect: secondDetect });
    const decode = vi.fn()
      .mockResolvedValueOnce({ width: 100, height: 50, close: firstClose })
      .mockResolvedValueOnce({ width: 100, height: 50, close: secondClose });
    const runner = new ChromeTextDetectorOffscreenRunner({
      getApi: () => ({ create } as unknown as TextDetectorConstructor),
      decode: decode as (encoded: Blob) => Promise<ImageBitmap>,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const controller = new AbortController();

    const first = runner.recognize(
      textDetectorJob('en'),
      new Blob([new Uint8Array([1])]),
      controller.signal,
    );
    await vi.waitFor(() => expect(firstDetect).toHaveBeenCalledOnce());
    controller.abort();

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(firstClose).toHaveBeenCalledOnce();
    await expect(runner.recognize(
      textDetectorJob('en'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: '' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(firstDetect).toHaveBeenCalledOnce();
    expect(secondDetect).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    await runner.dispose();
  });
});

function deadlineFixture() {
  const callbacks: Array<() => void> = [];
  const setTimer = vi.fn((callback: () => void) => {
    callbacks.push(callback);
    return callback as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimer = vi.fn((handle: ReturnType<typeof setTimeout>) => {
    const index = callbacks.indexOf(handle as unknown as () => void);
    if (index >= 0) callbacks.splice(index, 1);
  });
  return {
    setTimer,
    clearTimer,
    fireNext: () => {
      const callback = callbacks.shift();
      if (!callback) throw new Error('Expected a pending detector deadline.');
      callback();
    },
  };
}

function textDetectorJob(language: string): OffscreenOcrJob {
  return {
    jobId: crypto.randomUUID(),
    clientId: 'client-text-detector',
    attempt: 0,
    document: {
      sessionId: 'session-text-detector',
      pageEpoch: 1,
      generation: 1,
      documentId: 'document-text-detector',
      frameId: 0,
    },
    nodeId: 1,
    contentRevision: 1,
    observationRevision: 1,
    inputKey: 'input-text-detector',
    pixelHash: 'ab'.repeat(32),
    bitmapWidth: 100,
    bitmapHeight: 50,
    providerId: 'chrome-text-detector',
    languageGroup: language,
    providerVersion: 'chrome-text-detector-v1',
    modelVersion: 'platform',
    preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
    schemaVersion: 1,
  };
}
