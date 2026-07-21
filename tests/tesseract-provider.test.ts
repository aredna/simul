import { describe, expect, it, vi } from 'vitest';

import type { OffscreenOcrJob } from '../lib/ocr/offscreen-protocol';
import {
  TESSERACT_LANGUAGE_CODES,
  TESSERACT_MODEL_VERSION,
  resolveTesseractLanguageRoute,
  routeTesseractLanguage,
} from '../lib/ocr/providers/tesseract/language-catalog';
import { normalizeTesseractPage } from '../lib/ocr/providers/tesseract/normalize';
import {
  OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION,
  OCR_NATIVE_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
} from '../lib/ocr/preprocessing-profile';
import {
  TesseractOffscreenRunner,
  WorkerLostError,
} from '../lib/ocr/providers/tesseract/runtime';

describe('packaged Tesseract provider', () => {
  it('retains the approved 22-file catalog and routes trusted hints in order', () => {
    expect(TESSERACT_LANGUAGE_CODES).toHaveLength(22);
    expect(new Set(TESSERACT_LANGUAGE_CODES).size).toBe(22);
    expect(TESSERACT_LANGUAGE_CODES).toEqual(expect.arrayContaining([
      'eng', 'jpn', 'jpn_vert', 'kor', 'chi_sim', 'chi_tra',
      'rus', 'ukr', 'ara', 'heb', 'hin', 'mar', 'ben', 'kan', 'tam', 'tel',
    ]));
    expect(routeTesseractLanguage({
      nearestElementLanguage: 'ja-JP',
      explicitSourceLanguage: 'es',
      detectedPageLanguage: 'en',
    })).toBe('jpn+jpn_vert');
    expect(routeTesseractLanguage({
      nearestElementLanguage: 'xx',
      explicitSourceLanguage: 'zh-Hant',
    })).toBe('chi_tra');
    expect(routeTesseractLanguage({ detectedPageLanguage: 'th' })).toBeUndefined();
    expect(resolveTesseractLanguageRoute({
      nearestElementLanguage: 'th',
      explicitSourceLanguage: 'es',
      detectedPageLanguage: 'en',
    })).toEqual({ sourceLanguage: 'es', languageGroup: 'spa' });
  });

  it('normalizes line geometry/confidence and rejects unusable dimensions', () => {
    const normalized = normalizeTesseractPage({
      text: 'hello\nworld',
      confidence: 92,
      blocks: [{
        paragraphs: [{
          lines: [
            { text: ' hello ', confidence: 90, bbox: { x0: 10, y0: 20, x1: 80, y1: 40 } },
            { text: 'world', confidence: 80, bbox: { x0: -4, y0: 45, x1: 220, y1: 70 } },
          ],
        }],
      }],
    }, 200, 100);
    expect(normalized).toMatchObject({
      providerId: 'tesseract',
      transcript: 'hello\nworld',
      transcriptConfidence: 0.92,
      regions: [
        { text: 'hello', confidence: 0.9, boundingBox: { x: 10, y: 20, width: 70, height: 20 } },
        { text: 'world', confidence: 0.8, boundingBox: { x: 0, y: 45, width: 200, height: 25 } },
      ],
    });
    expect(normalized?.geometryConfidence).toBeCloseTo(0.85);
    expect(normalizeTesseractPage({ text: 'x', blocks: [] }, 0, 100))
      .toBeUndefined();
  });

  it('leaves unavailable confidence absent instead of treating it as zero', () => {
    const normalized = normalizeTesseractPage({
      text: '日本語',
      blocks: [{
        paragraphs: [{
          lines: [{
            text: '日本語',
            bbox: { x0: 10, y0: 20, x1: 80, y1: 40 },
          }],
        }],
      }],
    }, 200, 100);

    expect(normalized?.regions).toEqual([{
      text: '日本語',
      boundingBox: { x: 10, y: 20, width: 70, height: 20 },
    }]);
    expect(normalized).not.toHaveProperty('transcriptConfidence');
    expect(normalized).not.toHaveProperty('geometryConfidence');
  });

  it('uses only local paths, reuses an exact group, and terminates on group change', async () => {
    const firstWorker = fakeWorker('one');
    const secondWorker = fakeWorker('two');
    const workers = [firstWorker, secondWorker];
    const createWorker = vi.fn(async (..._args: unknown[]) => workers.shift()!.worker);
    const runner = new TesseractOffscreenRunner({
      createWorker: createWorker as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const first = await runner.recognize(job('eng'), blob, new AbortController().signal);
    const second = await runner.recognize(job('eng'), blob, new AbortController().signal);
    const third = await runner.recognize(job('jpn+jpn_vert'), blob, new AbortController().signal);

    expect(first.transcript).toBe('one');
    expect(second.transcript).toBe('one');
    expect(third.transcript).toBe('two');
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(createWorker.mock.calls[0]?.[2]).toMatchObject({
      workerPath: 'chrome-extension://id/ocr/tesseract/worker/worker.min.js',
      corePath: 'chrome-extension://id/ocr/tesseract/core',
      langPath: 'chrome-extension://id/ocr/tesseract/lang',
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      legacyCore: false,
      legacyLang: false,
    });
    expect(createWorker.mock.calls[0]?.[2]).not.toEqual(
      expect.objectContaining({ workerPath: expect.stringMatching(/^https?:/u) }),
    );
    expect(firstWorker.worker.setParameters).not.toHaveBeenCalled();
    expect(workers).toHaveLength(0);
    await runner.dispose();
  });

  it('uses profile-selected banner segmentation and never infers it from dimensions', async () => {
    const worker = fakeWorker('banner');
    const runner = new TesseractOffscreenRunner({
      createWorker: vi.fn(async () => worker.worker) as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });
    const bannerJob: OffscreenOcrJob = {
      ...job('jpn+jpn_vert'),
      bitmapWidth: 550,
      bitmapHeight: 60,
      preprocessingVersion: OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
    };
    const highDpiBannerJob: OffscreenOcrJob = {
      ...job('jpn+jpn_vert'),
      bitmapWidth: 1_375,
      bitmapHeight: 150,
      preprocessingVersion: OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
    };
    const downscaledBannerJob: OffscreenOcrJob = {
      ...job('jpn+jpn_vert'),
      bitmapWidth: 32_768,
      bitmapHeight: 32,
      preprocessingVersion: OCR_SHALLOW_BANNER_DOWNSCALED_PREPROCESSING_VERSION,
    };
    const nativeMultiLineJob = {
      ...job('jpn+jpn_vert'),
      bitmapWidth: 500,
      bitmapHeight: 100,
    };

    await runner.recognize(
      bannerJob,
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    );
    await runner.recognize(
      highDpiBannerJob,
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    );
    await runner.recognize(
      downscaledBannerJob,
      new Blob([new Uint8Array([3])]),
      new AbortController().signal,
    );
    await runner.recognize(
      nativeMultiLineJob,
      new Blob([new Uint8Array([4])]),
      new AbortController().signal,
    );

    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(1, {
      tessedit_pageseg_mode: '7',
    }, bannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(2, {
      tessedit_pageseg_mode: '6',
    }, bannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(3, {
      tessedit_pageseg_mode: '7',
    }, highDpiBannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(4, {
      tessedit_pageseg_mode: '6',
    }, highDpiBannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(5, {
      tessedit_pageseg_mode: '7',
    }, downscaledBannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(6, {
      tessedit_pageseg_mode: '6',
    }, downscaledBannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenCalledTimes(6);
    await runner.dispose();
  });

  it('keeps offscreen deadline and idle timer callbacks receiver-free', async () => {
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
    const worker = fakeWorker('receiver-safe');
    const runner = new TesseractOffscreenRunner({
      createWorker: vi.fn(async () => worker.worker) as never,
      getUrl: (path) => `chrome-extension://id${path}`,
      setTimer,
      clearTimer,
    });

    await expect(runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'receiver-safe' });
    await runner.dispose();

    expect(receivers).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('applies one total deadline to worker creation and terminates a late worker', async () => {
    vi.useFakeTimers();
    try {
      const late = fakeWorker('late');
      let resolveCreation!: (worker: typeof late.worker) => void;
      const creation = new Promise<typeof late.worker>((resolve) => {
        resolveCreation = resolve;
      });
      const createWorker = vi.fn(() => creation);
      const runner = new TesseractOffscreenRunner({
        createWorker: createWorker as never,
        getUrl: (path) => `chrome-extension://id${path}`,
        jobTimeoutMs: 25,
      });
      const recognition = runner.recognize(
        job('eng'),
        new Blob([new Uint8Array([1])]),
        new AbortController().signal,
      );
      void recognition.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(createWorker).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(25);
      await expect(recognition).rejects.toBeInstanceOf(WorkerLostError);
      resolveCreation(late.worker);
      await Promise.resolve();
      await Promise.resolve();
      expect(late.terminate).toHaveBeenCalledOnce();
      await runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reset the total deadline after worker creation completes', async () => {
    vi.useFakeTimers();
    try {
      const terminate = vi.fn(async () => undefined);
      const recognize = vi.fn(() => new Promise<never>(() => undefined));
      const createWorker = vi.fn(() => new Promise<never>((resolve) => {
        setTimeout(() => resolve({
          setParameters: vi.fn(async () => ({ data: undefined })),
          recognize,
          terminate,
        } as never), 20);
      }));
      const runner = new TesseractOffscreenRunner({
        createWorker: createWorker as never,
        getUrl: (path) => `chrome-extension://id${path}`,
        jobTimeoutMs: 25,
      });
      const recognition = runner.recognize(
        job('eng'),
        new Blob([new Uint8Array([1])]),
        new AbortController().signal,
      );
      let rejection: unknown;
      void recognition.catch((error: unknown) => {
        rejection = error;
      });

      await vi.advanceTimersByTimeAsync(20);
      expect(recognize).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5);
      expect(rejection).toBeInstanceOf(WorkerLostError);
      expect(terminate).toHaveBeenCalledOnce();
      await runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a timed-out job and replaces its worker when termination stalls', async () => {
    vi.useFakeTimers();
    try {
      const stale = fakeWorker('stale');
      const fresh = fakeWorker('fresh');
      const stalledTerminate = vi.fn(() => new Promise<void>(() => undefined));
      stale.worker.recognize = vi.fn(() => new Promise<never>(() => undefined)) as never;
      stale.worker.terminate = stalledTerminate as never;
      const createWorker = vi.fn()
        .mockResolvedValueOnce(stale.worker)
        .mockResolvedValueOnce(fresh.worker);
      const runner = new TesseractOffscreenRunner({
        createWorker: createWorker as never,
        getUrl: (path) => `chrome-extension://id${path}`,
        jobTimeoutMs: 25,
      });
      const recognition = runner.recognize(
        job('eng'),
        new Blob([new Uint8Array([1])]),
        new AbortController().signal,
      );
      let rejection: unknown;
      void recognition.catch((error: unknown) => {
        rejection = error;
      });

      await vi.advanceTimersByTimeAsync(25);
      expect(rejection).toBeInstanceOf(WorkerLostError);
      expect(stalledTerminate).toHaveBeenCalledOnce();
      await expect(runner.recognize(
        job('eng'),
        new Blob([new Uint8Array([2])]),
        new AbortController().signal,
      )).resolves.toMatchObject({ transcript: 'fresh' });
      expect(createWorker).toHaveBeenCalledTimes(2);
      await runner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles cancellation without waiting for stalled worker termination', async () => {
    const stale = fakeWorker('stale');
    const stalledTerminate = vi.fn(() => new Promise<void>(() => undefined));
    stale.worker.recognize = vi.fn(() => new Promise<never>(() => undefined)) as never;
    stale.worker.terminate = stalledTerminate as never;
    const runner = new TesseractOffscreenRunner({
      createWorker: vi.fn(async () => stale.worker) as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });
    const abortController = new AbortController();
    const recognition = runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      abortController.signal,
    );
    await vi.waitFor(() => expect(stale.worker.recognize).toHaveBeenCalledOnce());

    abortController.abort();
    let cancellationSettled = false;
    void runner.cancelActive().then(() => {
      cancellationSettled = true;
    });
    let rejection: unknown;
    void recognition.catch((error: unknown) => {
      rejection = error;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(cancellationSettled).toBe(true);
    expect(rejection).toMatchObject({ name: 'AbortError' });
    expect(stalledTerminate).toHaveBeenCalledOnce();
    await runner.dispose();
  });

  it('terminates and reports worker loss for recognition infrastructure rejection', async () => {
    const worker = fakeWorker('failed');
    worker.worker.recognize = vi.fn(async () => {
      throw new Error('worker transport failed');
    }) as never;
    const runner = new TesseractOffscreenRunner({
      createWorker: vi.fn(async () => worker.worker) as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });

    await expect(runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(WorkerLostError);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await runner.dispose();
  });

  it('uses errorHandler to evict a poisoned worker and reject active recognition', async () => {
    const terminate = vi.fn(async () => undefined);
    const recognize = vi.fn(() => new Promise<never>(() => undefined));
    let reportWorkerError!: (error: unknown) => void;
    const createWorker = vi.fn(async (...args: unknown[]) => {
      const options = args[2] as { errorHandler?: (error: unknown) => void };
      reportWorkerError = options.errorHandler!;
      return {
        setParameters: vi.fn(async () => ({ data: undefined })),
        recognize,
        terminate,
      } as never;
    });
    const runner = new TesseractOffscreenRunner({
      createWorker: createWorker as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });
    const recognition = runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledOnce());

    reportWorkerError(new Error('worker exited'));
    await expect(recognition).rejects.toBeInstanceOf(WorkerLostError);
    expect(terminate).toHaveBeenCalledOnce();
    await runner.dispose();
  });

  it('keeps invalid normalized output non-retryable without poisoning the worker', async () => {
    const worker = fakeWorker('valid');
    const validRecognition = await worker.worker.recognize(
      new Blob([new Uint8Array([1])]),
    );
    worker.worker.recognize = vi.fn()
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce(validRecognition) as never;
    const createWorker = vi.fn(async () => worker.worker);
    const runner = new TesseractOffscreenRunner({
      createWorker: createWorker as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });

    await expect(runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).rejects.toMatchObject({ name: 'InvalidNormalizedOcrOutputError' });
    expect(worker.terminate).not.toHaveBeenCalled();
    await expect(runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'valid' });
    expect(createWorker).toHaveBeenCalledOnce();
    await runner.dispose();
  });
});

function job(languageGroup: string): OffscreenOcrJob {
  return {
    jobId: crypto.randomUUID(),
    clientId: 'client-tesseract',
    attempt: 0,
    document: {
      sessionId: 'session-tesseract',
      pageEpoch: 1,
      generation: 1,
      documentId: 'document-tesseract',
      frameId: 0,
    },
    nodeId: 4,
    contentRevision: 1,
    observationRevision: 1,
    inputKey: 'input-tesseract',
    pixelHash: 'ab'.repeat(32),
    bitmapWidth: 200,
    bitmapHeight: 100,
    providerId: 'tesseract',
    languageGroup,
    providerVersion: 'tesseract.js-7.0.0',
    modelVersion: TESSERACT_MODEL_VERSION,
    preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
    schemaVersion: 1,
  };
}

function fakeWorker(text: string) {
  const terminate = vi.fn(async () => undefined);
  return {
    terminate,
    worker: {
      setParameters: vi.fn(async () => ({ data: undefined })),
      recognize: vi.fn(async (..._args: unknown[]) => ({
        data: {
          text,
          confidence: 90,
          blocks: [{
            paragraphs: [{
              lines: [{
                text,
                confidence: 90,
                bbox: { x0: 1, y0: 1, x1: 20, y1: 12 },
              }],
            }],
          }],
        },
      })),
      terminate,
    },
  };
}
