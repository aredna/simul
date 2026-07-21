import { describe, expect, it, vi } from 'vitest';

import {
  ImageRecognitionCoordinator,
} from '../lib/ocr/image-analysis-coordinator';
import type { ImageTextResult, SourceImageDescriptor } from '../lib/ocr/contracts';
import { OcrOffscreenDocumentManager } from '../lib/ocr/offscreen-document-manager';
import { OffscreenComputeHost } from '../lib/ocr/offscreen-host';
import { OffscreenOcrProviderRouter } from '../lib/ocr/offscreen-provider-router';
import {
  readOffscreenOcrCommand,
  readOffscreenOcrJob,
  readOffscreenOcrResponse,
  type OffscreenOcrJob,
} from '../lib/ocr/offscreen-protocol';
import type { AcquiredImagePixels } from '../lib/ocr/pixel-acquisition';
import {
  OCR_NATIVE_PREPROCESSING_VERSION,
  OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
} from '../lib/ocr/preprocessing-profile';
import type { TransientImageInputStore } from '../lib/ocr/transient-image-store';

const documentIdentity = {
  sessionId: 'session-ocr',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document-ocr',
  frameId: 0,
};
const descriptor: SourceImageDescriptor = {
  document: documentIdentity,
  nodeId: 4,
  sourceKind: 'img',
  contentRevision: 2,
  observationRevision: 3,
  visibility: 'visible',
  connected: true,
  renderedWidth: 200,
  renderedHeight: 100,
};
const pixels: AcquiredImagePixels = {
  descriptor,
  pixelHash: 'ab'.repeat(32),
  encoded: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  bitmapWidth: 400,
  bitmapHeight: 200,
  preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
  cropOffsetXCss: 0,
  cropOffsetYCss: 0,
  cropWidthCss: 200,
  cropHeightCss: 100,
  renderedWidthCss: 200,
  renderedHeightCss: 100,
};

describe('offscreen OCR protocol and lifecycle', () => {
  it('strictly validates jobs and revision-current normalized responses', () => {
    const job = createJob('job-1', 0);
    expect(readOffscreenOcrJob(job)).toEqual(job);
    expect(readOffscreenOcrJob({ ...job, url: 'https://private.example' }))
      .toBeUndefined();
    expect(readOffscreenOcrCommand({
      kind: 'simul:ocr-v1:run',
      version: 1,
      job,
    })).toMatchObject({ job: { jobId: 'job-1' } });
    expect(readOffscreenOcrResponse(success(job), job)).toMatchObject({
      kind: 'simul:ocr-v1:result',
      pixelHash: pixels.pixelHash,
    });
    expect(readOffscreenOcrResponse({
      ...success(job),
      contentRevision: 99,
    }, job)).toBeUndefined();
  });

  it('accepts bounded TextDetector jobs and rejects out-of-bounds hints', () => {
    const job: OffscreenOcrJob = {
      ...createJob('job-text-detector', 0),
      providerId: 'chrome-text-detector',
      languageGroup: 'ja',
      providerVersion: 'chrome-text-detector-v1',
      modelVersion: 'platform',
      hints: [{
        text: '',
        boundingBox: { x: 10, y: 12, width: 80, height: 20 },
      }],
    };
    expect(readOffscreenOcrJob(job)).toEqual(job);
    expect(readOffscreenOcrJob({
      ...job,
      hints: [{
        text: '',
        boundingBox: { x: 399, y: 12, width: 80, height: 20 },
      }],
    })).toBeUndefined();
  });

  it('lazily routes offscreen jobs to only the selected compiled provider', async () => {
    const createTextDetector = vi.fn(() => ({
      recognize: async (job: OffscreenOcrJob) => imageResult(job),
      dispose: async () => undefined,
    }));
    const createTesseract = vi.fn(() => ({
      recognize: async (job: OffscreenOcrJob) => imageResult(job),
      dispose: async () => undefined,
    }));
    const router = new OffscreenOcrProviderRouter([
      { id: 'chrome-text-detector', create: createTextDetector },
      { id: 'tesseract', create: createTesseract },
    ]);

    await expect(router.recognize(
      createJob('job-router', 0),
      pixels.encoded,
      new AbortController().signal,
    )).resolves.toMatchObject({ providerId: 'tesseract' });
    expect(createTesseract).toHaveBeenCalledOnce();
    expect(createTextDetector).not.toHaveBeenCalled();
    await router.dispose();
  });

  it('serializes offscreen creation and recovers a concurrent creation race', async () => {
    let contexts: readonly unknown[] = [];
    const createDocument = vi.fn(async () => {
      contexts = [{}];
    });
    const manager = new OcrOffscreenDocumentManager({
      getContexts: vi.fn(async () => contexts),
      createDocument,
      getUrl: (path) => `chrome-extension://id${path}`,
    });
    const [first, second] = await Promise.all([manager.ensure(), manager.ensure()]);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(createDocument).toHaveBeenCalledOnce();
    expect(createDocument).toHaveBeenCalledWith(expect.objectContaining({
      reasons: ['WORKERS'],
    }));
  });

  it('runs one active and one pending job and rejects further overflow', async () => {
    const store = memoryStore();
    await store.put(pixels.encoded, 'input-1');
    const releases: Array<() => void> = [];
    const recognize = vi.fn(async (job: OffscreenOcrJob) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return imageResult(job);
    });
    const host = new OffscreenComputeHost(store, {
      recognize,
      dispose: async () => undefined,
    });
    const firstJob = createJob('job-1', 0);
    const secondJob = { ...createJob('job-2', 0), inputKey: 'input-1' };
    const thirdJob = { ...createJob('job-3', 0), inputKey: 'input-1' };
    const first = host.handle({ kind: 'simul:ocr-v1:run', version: 1, job: firstJob });
    const second = host.handle({ kind: 'simul:ocr-v1:run', version: 1, job: secondJob });
    const third = await host.handle({ kind: 'simul:ocr-v1:run', version: 1, job: thirdJob });
    expect(third).toMatchObject({ code: 'host-overflow' });
    releases.shift()?.();
    await expect(first).resolves.toMatchObject({ kind: 'simul:ocr-v1:result' });
    await vi.waitFor(() => expect(recognize).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await expect(second).resolves.toMatchObject({ kind: 'simul:ocr-v1:result' });
  });

  it('retries infrastructure loss once, deletes transient input, and reuses recognition cache', async () => {
    const store = memoryStore();
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      calls.push(command.job);
      return calls.length === 1
        ? {
            kind: 'simul:ocr-v1:error',
            version: 1,
            jobId: command.job.jobId,
            clientId: command.job.clientId,
            attempt: command.job.attempt,
            code: 'worker-lost',
          }
        : success(command.job);
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-ocr',
    });
    const route = {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    };
    await expect(coordinator.recognize(pixels, route)).resolves.toMatchObject({
      status: 'complete',
      cacheHit: false,
    });
    expect(calls.map((job) => job.attempt)).toEqual([0, 1]);
    expect(store.get('input-1')).resolves.toBeUndefined();
    await expect(coordinator.recognize(pixels, route)).resolves.toMatchObject({
      status: 'complete',
      cacheHit: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('joins exact in-flight pixels across nodes and reuses them across documents', async () => {
    const store = memoryStore();
    const put = vi.spyOn(store, 'put');
    const runJobs: OffscreenOcrJob[] = [];
    let resolveRun!: (value: unknown) => void;
    const sendMessage = vi.fn((message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return Promise.resolve({
          kind: 'simul:ocr-v1:host-ready',
          version: 1,
          ready: true,
        });
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') {
        return Promise.resolve(undefined);
      }
      runJobs.push(command.job);
      return new Promise<unknown>((resolve) => {
        resolveRun = resolve;
      });
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-join',
    });
    const route = {
      providerOrder: ['tesseract'] as const,
      sourceLanguage: 'en',
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    };
    const refreshedPixels: AcquiredImagePixels = {
      ...pixels,
      descriptor: {
        ...descriptor,
        document: {
          ...documentIdentity,
          pageEpoch: 2,
          generation: 2,
          documentId: 'document-refreshed',
        },
        nodeId: 99,
        contentRevision: 1,
        observationRevision: 1,
      },
      encoded: new Blob([new Uint8Array([9])], { type: 'image/png' }),
    };

    const first = coordinator.recognize(pixels, route);
    await vi.waitFor(() => expect(runJobs).toHaveLength(1));
    const joined = coordinator.recognize(refreshedPixels, route);
    await vi.waitFor(() => expect(coordinator.snapshotStats().inFlightJoins).toBe(1));
    resolveRun(success(runJobs[0] as OffscreenOcrJob));

    await expect(first).resolves.toMatchObject({
      status: 'complete',
      cacheAccess: 'miss',
    });
    await expect(joined).resolves.toMatchObject({
      status: 'complete',
      cacheAccess: 'join',
    });
    expect(runJobs).toHaveLength(1);
    expect(put).toHaveBeenCalledOnce();
    await expect(coordinator.recognize(refreshedPixels, route)).resolves
      .toMatchObject({ status: 'complete', cacheAccess: 'hit' });
    expect(coordinator.snapshotStats()).toEqual({
      entries: 1,
      weight: 42,
      hits: 1,
      misses: 2,
      inFlightJoins: 1,
      loads: 1,
    });
  });

  it('bounds distinct recognition loads while still admitting exact joins', async () => {
    const store = memoryStore();
    const releases: Array<(value: unknown) => void> = [];
    const runJobs: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn((message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return Promise.resolve({
          kind: 'simul:ocr-v1:host-ready',
          version: 1,
          ready: true,
        });
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') {
        return Promise.resolve(undefined);
      }
      runJobs.push(command.job);
      return new Promise<unknown>((resolve) => releases.push(resolve));
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-bounded-joins',
      maxInFlight: 1,
    });
    const route = {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    };
    const first = coordinator.recognize(pixels, route);
    await vi.waitFor(() => expect(runJobs).toHaveLength(1));
    const joined = coordinator.recognize(pixels, route);
    const overflow = await coordinator.recognize({
      ...pixels,
      pixelHash: 'cd'.repeat(32),
    }, route);

    expect(overflow).toMatchObject({
      status: 'failed',
      code: 'host-overflow',
      cacheAccess: 'miss',
    });
    releases[0]?.(success(runJobs[0] as OffscreenOcrJob));
    await expect(Promise.all([first, joined])).resolves.toEqual([
      expect.objectContaining({ cacheAccess: 'miss' }),
      expect.objectContaining({ cacheAccess: 'join' }),
    ]);
    expect(runJobs).toHaveLength(1);
    expect(coordinator.snapshotStats()).toMatchObject({
      misses: 3,
      inFlightJoins: 1,
      loads: 1,
    });
  });

  it('does not let a pre-clear recognition refill the next cache generation', async () => {
    const store = memoryStore();
    let pendingJob: OffscreenOcrJob | undefined;
    let releaseFirst!: (value: unknown) => void;
    let runCount = 0;
    const sendMessage = vi.fn((message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return Promise.resolve({
          kind: 'simul:ocr-v1:host-ready',
          version: 1,
          ready: true,
        });
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') {
        return Promise.resolve(undefined);
      }
      runCount += 1;
      if (runCount === 1) {
        pendingJob = command.job;
        return new Promise<unknown>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve(success(command.job));
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-generation',
    });
    const route = {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    };
    const obsolete = coordinator.recognize(pixels, route);
    await vi.waitFor(() => expect(pendingJob).toBeDefined());

    coordinator.clear();
    releaseFirst(success(pendingJob as OffscreenOcrJob));
    await expect(obsolete).resolves.toMatchObject({ status: 'complete' });
    expect(coordinator.snapshotStats().entries).toBe(0);

    await expect(coordinator.recognize(pixels, route)).resolves.toMatchObject({
      status: 'complete',
      cacheAccess: 'miss',
    });
    expect(runCount).toBe(2);
    expect(coordinator.snapshotStats()).toMatchObject({
      entries: 1,
      misses: 1,
      loads: 1,
    });
  });

  it('separates provider, model, language, profile, dimensions, and pixel keys', async () => {
    const store = memoryStore();
    const runJobs: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      runJobs.push(command.job);
      return success(command.job);
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-key-separation',
    });
    const baseRoute = {
      providerOrder: ['tesseract'] as const,
      sourceLanguage: 'en',
      languageGroup: 'eng',
      modelVersion: 'model-a',
    };

    await expect(coordinator.recognize(pixels, baseRoute)).resolves
      .toMatchObject({ cacheAccess: 'miss' });
    await expect(coordinator.recognize(pixels, baseRoute)).resolves
      .toMatchObject({ cacheAccess: 'hit' });
    await expect(coordinator.recognize({
      ...pixels,
      pixelHash: 'ef'.repeat(32),
    }, baseRoute)).resolves.toMatchObject({ cacheAccess: 'miss' });
    await expect(coordinator.recognize({
      ...pixels,
      bitmapWidth: pixels.bitmapWidth + 1,
    }, baseRoute)).resolves.toMatchObject({ cacheAccess: 'miss' });
    await expect(coordinator.recognize({
      ...pixels,
      preprocessingVersion: OCR_SHALLOW_BANNER_NATIVE_PREPROCESSING_VERSION,
    }, baseRoute)).resolves.toMatchObject({ cacheAccess: 'miss' });
    await expect(coordinator.recognize(pixels, {
      ...baseRoute,
      modelVersion: 'model-b',
    })).resolves.toMatchObject({ cacheAccess: 'miss' });
    await expect(coordinator.recognize(pixels, {
      ...baseRoute,
      sourceLanguage: 'es',
      languageGroup: 'spa',
    })).resolves.toMatchObject({ cacheAccess: 'miss' });
    await expect(coordinator.recognize(pixels, {
      ...baseRoute,
      providerOrder: ['chrome-text-detector', 'tesseract'],
    })).resolves.toMatchObject({ cacheAccess: 'miss' });

    expect(runJobs).toHaveLength(7);
  });

  it('evicts least-recently-used recognition results to stay within weight', async () => {
    const store = memoryStore();
    const texts = new Map([
      ['aa'.repeat(32), 'one'],
      ['bb'.repeat(32), 'two'],
      ['cc'.repeat(32), 'three'],
    ]);
    const runJobs: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      runJobs.push(command.job);
      return success(
        command.job,
        imageResultWithText(command.job, texts.get(command.job.pixelHash) ?? 'x'),
      );
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-weight-lru',
      maxCacheWeight: 100,
    });
    const route = {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    };
    const withHash = (value: string): AcquiredImagePixels => ({
      ...pixels,
      pixelHash: value.repeat(32),
    });

    await coordinator.recognize(withHash('aa'), route);
    await coordinator.recognize(withHash('bb'), route);
    await expect(coordinator.recognize(withHash('aa'), route)).resolves
      .toMatchObject({ cacheAccess: 'hit' });
    await coordinator.recognize(withHash('cc'), route);
    await expect(coordinator.recognize(withHash('aa'), route)).resolves
      .toMatchObject({ cacheAccess: 'hit' });
    await expect(coordinator.recognize(withHash('bb'), route)).resolves
      .toMatchObject({ cacheAccess: 'miss' });

    expect(runJobs.map(({ pixelHash }) => pixelHash.slice(0, 2))).toEqual([
      'aa',
      'bb',
      'cc',
      'bb',
    ]);
    expect(coordinator.snapshotStats()).toEqual({
      entries: 2,
      weight: 76,
      hits: 2,
      misses: 4,
      inFlightJoins: 0,
      loads: 4,
    });
  });

  it('does not cache a single recognition result larger than its weight budget', async () => {
    const store = memoryStore();
    let runCount = 0;
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      runCount += 1;
      return success(command.job, imageResultWithText(command.job, 'large'));
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-weight-oversize',
      maxCacheWeight: 40,
    });
    const route = {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    };

    await expect(coordinator.recognize(pixels, route)).resolves
      .toMatchObject({ cacheAccess: 'miss' });
    await expect(coordinator.recognize(pixels, route)).resolves
      .toMatchObject({ cacheAccess: 'miss' });

    expect(runCount).toBe(2);
    expect(coordinator.snapshotStats()).toEqual({
      entries: 0,
      weight: 0,
      hits: 0,
      misses: 2,
      inFlightJoins: 0,
      loads: 2,
    });
  });

  it('resets recognition cache weight and counters when cleared', async () => {
    const store = memoryStore();
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      return command?.kind === 'simul:ocr-v1:run'
        ? success(command.job)
        : undefined;
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-weight-clear',
    });

    await coordinator.recognize(pixels, {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    });
    expect(coordinator.snapshotStats().weight).toBe(42);

    coordinator.clear();

    expect(coordinator.snapshotStats()).toEqual({
      entries: 0,
      weight: 0,
      hits: 0,
      misses: 0,
      inFlightJoins: 0,
      loads: 0,
    });
  });

  it('falls through boxes-only TextDetector output and passes its geometry to Tesseract', async () => {
    const store = memoryStore();
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      calls.push(command.job);
      const result: ImageTextResult = command.job.providerId ===
        'chrome-text-detector'
        ? {
            providerId: 'chrome-text-detector',
            bitmapWidth: command.job.bitmapWidth,
            bitmapHeight: command.job.bitmapHeight,
            transcript: '',
            regions: [{
              text: '',
              boundingBox: { x: 12, y: 14, width: 90, height: 24 },
            }],
          }
        : imageResult(command.job);
      return success(command.job, result);
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-chain',
    });

    await expect(coordinator.recognize(pixels, {
      providerOrder: ['chrome-text-detector', 'tesseract'],
      sourceLanguage: 'en',
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    })).resolves.toMatchObject({
      status: 'complete',
      result: { providerId: 'tesseract' },
    });
    expect(calls.map((job) => job.providerId)).toEqual([
      'chrome-text-detector',
      'tesseract',
    ]);
    expect(calls[1]?.hints).toEqual([{
      text: '',
      boundingBox: { x: 12, y: 14, width: 90, height: 24 },
    }]);
  });

  it('filters punctuation and supplied low confidence before caching provider output', async () => {
    const store = memoryStore();
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      calls.push(command.job);
      if (command.job.providerId === 'chrome-text-detector') {
        return success(command.job, {
          providerId: 'chrome-text-detector',
          bitmapWidth: command.job.bitmapWidth,
          bitmapHeight: command.job.bitmapHeight,
          transcript: '!?\nnoise',
          regions: [
            {
              text: '!?',
              boundingBox: { x: 5, y: 6, width: 20, height: 10 },
            },
            {
              text: 'noise',
              confidence: 0.1,
              boundingBox: { x: 30, y: 6, width: 40, height: 10 },
            },
          ],
        });
      }
      return success(command.job, {
        ...imageResult(command.job),
        transcript: '日本語',
        regions: [{
          text: '日本語',
          boundingBox: { x: 10, y: 12, width: 80, height: 20 },
        }],
      });
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-quality-filter',
    });
    const route = {
      providerOrder: ['chrome-text-detector', 'tesseract'] as const,
      sourceLanguage: 'ja',
      languageGroup: 'jpn',
      modelVersion: 'tessdata-fast-87416418',
    };

    const first = await coordinator.recognize(pixels, route);
    expect(first).toMatchObject({
      status: 'complete',
      cacheAccess: 'miss',
      result: {
        providerId: 'tesseract',
        transcript: '日本語',
        regions: [{ text: '日本語' }],
      },
      quality: {
        candidateRegions: 3,
        acceptedRegions: 1,
        rejectedBlankRegions: 0,
        rejectedPunctuationRegions: 1,
        rejectedLowConfidenceRegions: 1,
      },
    });
    await expect(coordinator.recognize(pixels, route)).resolves.toMatchObject({
      cacheAccess: 'hit',
      quality: first.status === 'complete' ? first.quality : undefined,
    });
    expect(calls.map(({ providerId }) => providerId)).toEqual([
      'chrome-text-detector',
      'tesseract',
    ]);
  });

  it('returns and caches a valid no-text result after provider fallthrough', async () => {
    const store = memoryStore();
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      calls.push(command.job);
      return success(command.job, {
        providerId: command.job.providerId,
        bitmapWidth: command.job.bitmapWidth,
        bitmapHeight: command.job.bitmapHeight,
        transcript: '',
        regions: command.job.providerId === 'chrome-text-detector'
          ? [{
              text: '',
              boundingBox: { x: 12, y: 14, width: 90, height: 24 },
            }]
          : [],
      });
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-no-text-cache',
    });
    const route = {
      providerOrder: ['chrome-text-detector', 'tesseract'] as const,
      sourceLanguage: 'en',
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    };

    await expect(coordinator.recognize(pixels, route)).resolves.toMatchObject({
      status: 'complete',
      cacheHit: false,
      result: { providerId: 'tesseract', regions: [] },
    });
    await expect(coordinator.recognize(pixels, route)).resolves.toMatchObject({
      status: 'complete',
      cacheHit: false,
      result: { regions: [] },
    });
    await expect(coordinator.recognize(pixels, route)).resolves.toMatchObject({
      status: 'complete',
      cacheHit: true,
      result: { regions: [] },
    });
    expect(calls.map((job) => job.providerId)).toEqual([
      'chrome-text-detector',
      'tesseract',
      'chrome-text-detector',
      'tesseract',
    ]);
  });

  it('stops the ordered route after the one shared-host retry is exhausted', async () => {
    const store = memoryStore();
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: false };
      }
      const command = readOffscreenOcrCommand(message);
      if (command?.kind === 'simul:ocr-v1:run') calls.push(command.job);
      return undefined;
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-shared-host-bound',
    });

    await expect(coordinator.recognize(pixels, {
      providerOrder: ['chrome-text-detector', 'tesseract'],
      sourceLanguage: 'en',
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    })).resolves.toMatchObject({ status: 'failed', code: 'host-unavailable' });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(0);
  });

  it('falls through unavailable TextDetector without retrying it', async () => {
    const store = memoryStore();
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      calls.push(command.job);
      return command.job.providerId === 'chrome-text-detector'
        ? {
            kind: 'simul:ocr-v1:error',
            version: 1,
            jobId: command.job.jobId,
            clientId: command.job.clientId,
            attempt: command.job.attempt,
            code: 'provider-unavailable',
          }
        : success(command.job);
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-unavailable-fallback',
    });

    await expect(coordinator.recognize(pixels, {
      providerOrder: ['chrome-text-detector', 'tesseract'],
      sourceLanguage: 'en',
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    })).resolves.toMatchObject({
      status: 'complete',
      result: { providerId: 'tesseract' },
    });
    expect(calls.map((job) => `${job.providerId}:${job.attempt}`)).toEqual([
      'chrome-text-detector:0',
      'tesseract:0',
    ]);
  });

  it('stops at the first acceptable provider result', async () => {
    const store = memoryStore();
    const calls: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      calls.push(command.job);
      return success(command.job, {
        ...imageResult(command.job),
        providerId: 'chrome-text-detector',
      });
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-first-result',
    });

    await expect(coordinator.recognize(pixels, {
      providerOrder: ['chrome-text-detector', 'tesseract'],
      sourceLanguage: 'en',
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    })).resolves.toMatchObject({
      status: 'complete',
      result: { providerId: 'chrome-text-detector' },
    });
    expect(calls).toHaveLength(1);
  });

  it('treats ensure-host rejection as retryable without sending the failed attempt', async () => {
    const store = memoryStore();
    let ensureCalls = 0;
    const runJobs: OffscreenOcrJob[] = [];
    const sendMessage = vi.fn(async (message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') {
        ensureCalls += 1;
        if (ensureCalls === 1) throw new Error('service worker restarted');
        return { kind: 'simul:ocr-v1:host-ready', version: 1, ready: true };
      }
      const command = readOffscreenOcrCommand(message);
      if (!command || command.kind !== 'simul:ocr-v1:run') return undefined;
      runJobs.push(command.job);
      return success(command.job);
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-ensure-retry',
    });

    await expect(coordinator.recognize(pixels, {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    })).resolves.toMatchObject({ status: 'complete', cacheHit: false });
    expect(ensureCalls).toBe(2);
    expect(runJobs).toHaveLength(1);
    expect(runJobs[0]).toMatchObject({ attempt: 1 });
  });

  it('never sends run when cancellation wins the ensure-host race', async () => {
    const store = memoryStore();
    let resolveEnsure!: (value: unknown) => void;
    const ensurePending = new Promise<unknown>((resolve) => {
      resolveEnsure = resolve;
    });
    const sendMessage = vi.fn((message: unknown) => {
      const record = message as Record<string, unknown>;
      if (record.kind === 'simul:ocr-v1:ensure-host') return ensurePending;
      return Promise.resolve(undefined);
    });
    const coordinator = new ImageRecognitionCoordinator({
      store,
      sendMessage,
      clientId: 'client-ensure-cancel',
    });
    const abortController = new AbortController();
    const recognition = coordinator.recognize(pixels, {
      languageGroup: 'eng',
      modelVersion: 'tessdata-fast-87416418',
    }, abortController.signal);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    abortController.abort();
    await expect(recognition).rejects.toMatchObject({ name: 'AbortError' });
    resolveEnsure({ kind: 'simul:ocr-v1:host-ready', version: 1, ready: true });
    await Promise.resolve();

    expect(sendMessage.mock.calls.some(([message]) =>
      (message as Record<string, unknown>).kind === 'simul:ocr-v1:run',
    )).toBe(false);
    await expect(store.get('input-1')).resolves.toBeUndefined();
  });

  it('recurs transient cleanup while alive and cancels the timer on disposal', async () => {
    const store = memoryStore();
    store.clearExpired = vi.fn(async () => undefined);
    const scheduled = new Map<number, () => void>();
    const timerReceivers: unknown[] = [];
    let timerSequence = 0;
    const setTimer = vi.fn(function (
      this: unknown,
      callback: TimerHandler,
      milliseconds?: number,
    ) {
      timerReceivers.push(this);
      const id = ++timerSequence;
      if (typeof callback === 'function') {
        scheduled.set(id, callback as () => void);
      }
      expect(milliseconds).toBeLessThanOrEqual(30_000);
      return id;
    }) as unknown as typeof setTimeout;
    const clearTimer = vi.fn(function (
      this: unknown,
      id: ReturnType<typeof setTimeout>,
    ) {
      timerReceivers.push(this);
      scheduled.delete(id as unknown as number);
    }) as unknown as typeof clearTimeout;
    const dispose = vi.fn(async () => undefined);
    const host = new OffscreenComputeHost(store, {
      recognize: async (ocrJob) => imageResult(ocrJob),
      dispose,
    }, {
      setTimer,
      clearTimer,
      cleanupIntervalMs: 10_000,
    });
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledWith(
      expect.any(Function),
      10_000,
    ));

    const firstTimer = scheduled.entries().next().value as [number, () => void];
    scheduled.delete(firstTimer[0]);
    firstTimer[1]();
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(2));
    expect(store.clearExpired).toHaveBeenCalledTimes(2);
    expect(scheduled.size).toBe(1);

    const secondTimerId = scheduled.keys().next().value as number;
    await host.dispose();
    expect(clearTimer).toHaveBeenCalledWith(secondTimerId);
    expect(scheduled.size).toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(timerReceivers).toEqual([undefined, undefined, undefined]);
  });
});

function createJob(jobId: string, attempt: 0 | 1): OffscreenOcrJob {
  return {
    jobId,
    clientId: 'client-ocr',
    attempt,
    document: documentIdentity,
    nodeId: descriptor.nodeId,
    contentRevision: descriptor.contentRevision,
    observationRevision: descriptor.observationRevision,
    inputKey: 'input-1',
    pixelHash: pixels.pixelHash,
    bitmapWidth: pixels.bitmapWidth,
    bitmapHeight: pixels.bitmapHeight,
    providerId: 'tesseract',
    languageGroup: 'eng',
    providerVersion: 'tesseract.js-7.0.0',
    modelVersion: 'tessdata-fast-87416418',
    preprocessingVersion: OCR_NATIVE_PREPROCESSING_VERSION,
    schemaVersion: 1,
  };
}

function imageResult(job: OffscreenOcrJob): ImageTextResult {
  return imageResultWithText(job, 'hello');
}

function imageResultWithText(
  job: OffscreenOcrJob,
  text: string,
): ImageTextResult {
  return {
    providerId: job.providerId,
    bitmapWidth: job.bitmapWidth,
    bitmapHeight: job.bitmapHeight,
    transcript: text,
    transcriptConfidence: 0.9,
    geometryConfidence: 0.9,
    regions: [{
      text,
      confidence: 0.9,
      boundingBox: { x: 10, y: 12, width: 80, height: 20 },
    }],
  };
}

function success(job: OffscreenOcrJob, result = imageResult(job)) {
  return {
    kind: 'simul:ocr-v1:result' as const,
    version: 1 as const,
    jobId: job.jobId,
    clientId: job.clientId,
    attempt: job.attempt,
    document: job.document,
    nodeId: job.nodeId,
    contentRevision: job.contentRevision,
    observationRevision: job.observationRevision,
    pixelHash: job.pixelHash,
    result,
  };
}

function memoryStore(): TransientImageInputStore {
  const records = new Map<string, Blob>();
  let sequence = 0;
  return {
    put: async (blob, id = `input-${++sequence}`) => {
      records.set(id, blob);
      return id;
    },
    get: async (id) => records.get(id),
    remove: async (id) => {
      records.delete(id);
    },
    clearExpired: async () => undefined,
  };
}
