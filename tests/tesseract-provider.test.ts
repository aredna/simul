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

  it('keeps the words of a line with their boxes, all of them or none (D121)', () => {
    const word = (text: unknown, x0: number, x1: number) => ({
      text,
      confidence: 91,
      bbox: { x0, y0: 20, x1, y1: 40 },
      symbols: [],
    });
    const line = (text: string, words: unknown) => ({
      text,
      confidence: 90,
      bbox: { x0: 10, y0: 20, x1: 190, y1: 40 },
      words,
    });
    const page = (lines: readonly unknown[]) => ({
      text: 'x',
      blocks: [{ paragraphs: [{ lines: lines as never }] }],
    });
    const regions = (lines: readonly unknown[]) =>
      normalizeTesseractPage(page(lines), 200, 100, true)?.regions;

    expect(regions([
      line('Rapport annuel Page 1\n', [
        word('Rapport', 10.4, 70.2), word(' ', 70, 74), word('annuel', 78, 120),
        word('Page', 140, 170), word('1', 176, 205),
      ]),
    ])).toEqual([{
      text: 'Rapport annuel Page 1',
      confidence: 0.9,
      boundingBox: { x: 10, y: 20, width: 180, height: 20 },
      // Only the text and the box travel, the box inside the bitmap.
      words: [
        { text: 'Rapport', boundingBox: { x: 10, y: 20, width: 61, height: 20 } },
        { text: 'annuel', boundingBox: { x: 78, y: 20, width: 42, height: 20 } },
        { text: 'Page', boundingBox: { x: 140, y: 20, width: 30, height: 20 } },
        { text: '1', boundingBox: { x: 176, y: 20, width: 24, height: 20 } },
      ],
    }]);

    for (const words of [
      undefined,
      null,
      'Rapport annuel',
      // One word says nothing the line does not.
      [word('Rapport', 10, 70)],
      // A word that cannot be placed: the line stays whole.
      [word('Rapport', 10, 70), { text: 'annuel' }],
      [word('Rapport', 10, 70), word('annuel', 250, 300)],
      [word('Rapport', 10, 70), word('a'.repeat(1_001), 78, 120)],
      Array.from({ length: 513 }, () => word('a', 10, 20)),
    ]) {
      const [region] = regions([line('Rapport annuel', words)]) ?? [];
      expect(region).toMatchObject({ text: 'Rapport annuel' });
      expect(region).not.toHaveProperty('words');
    }

    // A result carries 50,000 words at most: later lines carry none.
    const many = regions(Array.from({ length: 101 }, () => line(
      'a',
      Array.from({ length: 500 }, () => word('a', 10, 20)),
    )));
    expect(many).toHaveLength(101);
    expect(many?.filter((region) => region.words).length).toBe(100);
    expect(many?.[100]).not.toHaveProperty('words');

    // Only a job that asks gets words: a web image's result is as it was.
    expect(normalizeTesseractPage(page([
      line('Rapport annuel', [word('Rapport', 10, 70), word('annuel', 78, 120)]),
    ]), 200, 100)?.regions).toEqual([{
      text: 'Rapport annuel',
      confidence: 0.9,
      boundingBox: { x: 10, y: 20, width: 180, height: 20 },
    }]);
  });

  it('cuts a web image line where its words lie far apart, not a PDF page line (D235)', () => {
    const word = (text: string, x0: number, x1: number) => ({
      text, confidence: 91, bbox: { x0, y0: 20, x1, y1: 40 }, symbols: [],
    });
    // Two cards side by side in one picture, read as one line 20 px tall.
    const line = {
      text: 'SIMロック解除済のみ 業界基準最多の28項目',
      confidence: 80,
      bbox: { x0: 40, y0: 20, x1: 900, y1: 40 },
      words: [
        word('SIMロック', 40, 140), word('解除済のみ', 145, 260),
        word('業界基準最多の', 520, 700), word('28項目', 705, 900),
      ],
    };
    const page = { text: 'x', blocks: [{ paragraphs: [{ lines: [line] }] }] };

    expect(normalizeTesseractPage(page as never, 1000, 100)?.regions).toEqual([
      { text: 'SIMロック解除済のみ', confidence: 0.8, boundingBox: { x: 40, y: 20, width: 220, height: 20 } },
      { text: '業界基準最多の28項目', confidence: 0.8, boundingBox: { x: 520, y: 20, width: 380, height: 20 } },
    ]);
    // A PDF page's line is cut by its own rules (D184).
    expect(normalizeTesseractPage(page as never, 1000, 100, true)?.regions).toHaveLength(1);
    // Ordinary word spacing, or a word not found in the line's text, leaves it whole.
    const close = { ...line, words: [word('SIMロック', 40, 140), word('解除済のみ', 150, 260)] };
    const unknown = { ...line, words: [...line.words.slice(0, 2), word('???', 520, 700)] };
    for (const whole of [close, unknown]) {
      expect(normalizeTesseractPage(
        { text: 'x', blocks: [{ paragraphs: [{ lines: [whole] }] }] } as never, 1000, 100,
      )?.regions).toHaveLength(1);
    }
  });

  it('gives a job the words only when it asks for them (D121)', async () => {
    const worker = fakeWorker('hello world');
    worker.worker.recognize.mockImplementation(async () => ({
      data: {
        text: 'hello world',
        confidence: 90,
        blocks: [{
          paragraphs: [{
            lines: [{
              text: 'hello world',
              confidence: 90,
              bbox: { x0: 1, y0: 1, x1: 90, y1: 12 },
              words: [
                { text: 'hello', bbox: { x0: 1, y0: 1, x1: 40, y1: 12 } },
                { text: 'world', bbox: { x0: 50, y0: 1, x1: 90, y1: 12 } },
              ],
            }],
          }],
        }],
      },
    }));
    const runner = new TesseractOffscreenRunner({
      createWorker: vi.fn(async () => worker.worker) as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });
    const blob = new Blob([new Uint8Array([1])], { type: 'image/png' });

    const plain = await runner.recognize(job('eng'), blob, new AbortController().signal);
    expect(plain.regions).toEqual([{
      text: 'hello world',
      confidence: 0.9,
      boundingBox: { x: 1, y: 1, width: 89, height: 11 },
    }]);
    const asked = await runner.recognize(
      { ...job('eng'), words: true },
      blob,
      new AbortController().signal,
    );
    expect(asked.regions[0]?.words).toEqual([
      { text: 'hello', boundingBox: { x: 1, y: 1, width: 39, height: 11 } },
      { text: 'world', boundingBox: { x: 50, y: 1, width: 40, height: 11 } },
    ]);
    await runner.dispose();
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
      workerPath: 'chrome-extension://id/ocr/tesseract/worker/simul-worker.js',
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
    // Every recognition carries its own segmentation mode (C1).
    expect(firstWorker.worker.setParameters).toHaveBeenCalledTimes(2);
    expect(secondWorker.worker.setParameters).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(0);
    await runner.dispose();
  });

  it('detaches worker-loss listeners after every successful operation', async () => {
    const worker = fakeWorker('bounded-listeners');
    const lossController = new AbortController();
    const add = vi.spyOn(lossController.signal, 'addEventListener');
    const remove = vi.spyOn(lossController.signal, 'removeEventListener');
    const runner = new TesseractOffscreenRunner({
      createWorker: vi.fn(async () => worker.worker) as never,
      createWorkerLossController: () => lossController,
      getUrl: (path) => `chrome-extension://id${path}`,
    });

    await runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([1])]),
      new AbortController().signal,
    );
    await runner.recognize(
      job('eng'),
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    );

    // Worker acquisition, the job's segmentation and the recognition: three
    // loss races for the first job, two for the second.
    expect(add).toHaveBeenCalledTimes(5);
    expect(remove).toHaveBeenCalledTimes(add.mock.calls.length);
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

    // The mode is job-scoped: the banner jobs set SINGLE_LINE before their
    // own recognition and the multi-line job sets SINGLE_BLOCK before its.
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(1, {
      tessedit_pageseg_mode: '7',
    }, bannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(2, {
      tessedit_pageseg_mode: '7',
    }, highDpiBannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(3, {
      tessedit_pageseg_mode: '7',
    }, downscaledBannerJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenNthCalledWith(4, {
      tessedit_pageseg_mode: '6',
    }, nativeMultiLineJob.jobId);
    expect(worker.worker.setParameters).toHaveBeenCalledTimes(4);
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

    // Bootstrap deadline, recognition deadline and idle timer: one set and
    // one clear each, all invoked without a receiver.
    expect(receivers).toEqual(Array.from({ length: 6 }, () => undefined));
  });

  it('applies a bootstrap deadline to worker creation and terminates a late worker', async () => {
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
        bootstrapTimeoutMs: 25,
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

  it('starts the recognition deadline once worker creation completes', async () => {
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
      // Bootstrap time is not charged against the recognition budget.
      await vi.advanceTimersByTimeAsync(5);
      expect(rejection).toBeUndefined();
      await vi.advanceTimersByTimeAsync(20);
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

  it('settles cancellation while keeping the worker warm for the next job', async () => {
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
    // A caller-side cancel abandons the job but keeps the worker; only
    // disposal terminates it.
    expect(stalledTerminate).not.toHaveBeenCalled();
    await runner.dispose();
    expect(stalledTerminate).toHaveBeenCalledOnce();
  });

  it('sets its own segmentation mode before every recognition (C1)', async () => {
    const calls: string[] = [];
    let completeBanner!: (value: unknown) => void;
    const bannerRecognition = new Promise((resolve) => {
      completeBanner = resolve;
    });
    const worker = fakeWorker('next');
    const bannerJob: OffscreenOcrJob = {
      ...job('eng'),
      preprocessingVersion: OCR_SHALLOW_BANNER_PREPROCESSING_VERSION,
    };
    const nextJob = job('eng');
    worker.worker.setParameters = vi.fn(async (
      parameters: { readonly tessedit_pageseg_mode: string },
      jobId: string,
    ) => {
      calls.push(`mode:${parameters.tessedit_pageseg_mode}:${jobId}`);
      return { data: undefined };
    }) as never;
    worker.worker.recognize = vi.fn((
      _encoded: Blob,
      _options: unknown,
      _output: unknown,
      jobId: string,
    ) => {
      calls.push(`recognize:${jobId}`);
      return jobId === bannerJob.jobId
        ? bannerRecognition
        : Promise.resolve({
            data: {
              text: 'next',
              confidence: 90,
              blocks: [{
                paragraphs: [{
                  lines: [{
                    text: 'next',
                    confidence: 90,
                    bbox: { x0: 1, y0: 1, x1: 20, y1: 12 },
                  }],
                }],
              }],
            },
          });
    }) as never;
    const runner = new TesseractOffscreenRunner({
      createWorker: vi.fn(async () => worker.worker) as never,
      getUrl: (path) => `chrome-extension://id${path}`,
    });
    const abortController = new AbortController();
    const banner = runner.recognize(
      bannerJob,
      new Blob([new Uint8Array([1])]),
      abortController.signal,
    );
    await vi.waitFor(() => expect(calls).toContain(
      `recognize:${bannerJob.jobId}`,
    ));
    abortController.abort();
    await expect(banner).rejects.toMatchObject({ name: 'AbortError' });

    // The abandoned banner job has not drained from the worker yet. The next
    // job must still set its own multi-line mode instead of inheriting the
    // banner's SINGLE_LINE.
    await expect(runner.recognize(
      nextJob,
      new Blob([new Uint8Array([2])]),
      new AbortController().signal,
    )).resolves.toMatchObject({ transcript: 'next' });
    expect(calls).toEqual([
      `mode:7:${bannerJob.jobId}`,
      `recognize:${bannerJob.jobId}`,
      `mode:6:${nextJob.jobId}`,
      `recognize:${nextJob.jobId}`,
    ]);

    completeBanner({
      data: {
        text: 'banner',
        confidence: 90,
        blocks: [{
          paragraphs: [{
            lines: [{
              text: 'banner',
              confidence: 90,
              bbox: { x0: 1, y0: 1, x1: 20, y1: 12 },
            }],
          }],
        }],
      },
    });
    await runner.dispose();
  });

  it('disposes a worker that arrives after its bootstrap was cancelled (C2)', async () => {
    vi.useFakeTimers();
    try {
      const worker = fakeWorker('late');
      let resolveCreation!: (value: typeof worker.worker) => void;
      const creation = new Promise<typeof worker.worker>((resolve) => {
        resolveCreation = resolve;
      });
      const runner = new TesseractOffscreenRunner({
        createWorker: vi.fn(() => creation) as never,
        getUrl: (path) => `chrome-extension://id${path}`,
        idleTimeoutMs: 50,
      });
      const abortController = new AbortController();
      const recognition = runner.recognize(
        job('eng'),
        new Blob([new Uint8Array([1])]),
        abortController.signal,
      );
      void recognition.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      abortController.abort();
      await expect(recognition).rejects.toMatchObject({ name: 'AbortError' });

      resolveCreation(worker.worker);
      await vi.advanceTimersByTimeAsync(1);
      // The bootstrap finished with no recognize left to own it: the runner
      // must put it on the idle clock instead of leaking the worker and WASM.
      expect(worker.terminate).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(50);
      expect(worker.terminate).toHaveBeenCalledOnce();
      await runner.dispose();
    } finally {
      vi.useRealTimers();
    }
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
    qualityPolicyVersion: 'precision-v1',
    minimumConfidence: 0.65,
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
