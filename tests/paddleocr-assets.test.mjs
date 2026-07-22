import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  APPROVED_OCR_PROVIDER_DEPENDENCIES,
  APPROVED_PADDLE_OCR_JS_GIT_HEAD,
  APPROVED_PADDLE_TRANSITIVE_DEPENDENCIES,
  MAX_UNPACKED_ARTIFACT_BYTES,
} from '../tools/extension-artifact.mjs';
import {
  APPROVED_ONNXRUNTIME_WASM_SHA256,
  APPROVED_PADDLE_OCR_WORKER_SHA256,
  downloadPinned,
  replaceGeneratedCatalog,
  validatePaddleCatalog,
} from '../tools/vendor-paddle-ocr.mjs';

const vendorRoot = resolve('vendor/ocr/paddle');

describe('vendored PaddleOCR.js trial catalog', () => {
  it('pins the exact SDK, ORT runtime, git source, models, and single-thread Worker mode', async () => {
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    const manifest = JSON.parse(
      await readFile(resolve(vendorRoot, 'asset-manifest.json'), 'utf8'),
    );

    expect(packageManifest.dependencies['@paddleocr/paddleocr-js']).toBe(
      APPROVED_OCR_PROVIDER_DEPENDENCIES['@paddleocr/paddleocr-js'],
    );
    expect(packageManifest.dependencies['onnxruntime-web']).toBe(
      APPROVED_OCR_PROVIDER_DEPENDENCIES['onnxruntime-web'],
    );
    expect(lock.packages['node_modules/@paddleocr/paddleocr-js'].version)
      .toBe('0.4.2');
    expect(lock.packages['node_modules/onnxruntime-web'].version).toBe('1.24.3');
    for (const [name, version] of Object.entries(
      APPROVED_PADDLE_TRANSITIVE_DEPENDENCIES,
    )) {
      expect(lock.packages[`node_modules/${name}`].version, name).toBe(version);
    }
    expect(manifest).toMatchObject({
      paddleOcrJsVersion: '0.4.2',
      paddleOcrJsGitHead: APPROVED_PADDLE_OCR_JS_GIT_HEAD,
      onnxruntimeWebVersion: '1.24.3',
      modelNames: ['PP-OCRv6_tiny_det', 'PP-OCRv6_tiny_rec'],
      workerMode: true,
      runtime: {
        backend: 'wasm',
        numThreads: 1,
        simd: true,
        proxy: false,
      },
      detectorThreshold: 0.45,
      detectorBoxThreshold: 0.75,
      recognitionScoreThreshold: 0,
    });
    expect(manifest.totalBytes).toBeLessThan(MAX_UNPACKED_ARTIFACT_BYTES);
  });

  it('matches every reviewed byte/hash and retains all legal files', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(vendorRoot, 'asset-manifest.json'), 'utf8'),
    );
    let totalBytes = 0;
    for (const entry of manifest.files) {
      const bytes = await readFile(resolve(vendorRoot, entry.path));
      totalBytes += bytes.length;
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), entry.path)
        .toBe(entry.sha256);
    }
    expect(totalBytes).toBe(manifest.totalBytes);
    expect(manifest.files.filter(({ role }) => role === 'license')).toHaveLength(5);
    expect(manifest.files.some(({ role }) => role === 'notice')).toBe(true);
    expect(manifest.files.some(({ role }) => role === 'module-worker')).toBe(true);
    expect(manifest.files.some(({ role }) => role === 'wasm-runtime')).toBe(true);
    expect(manifest.files.filter(({ role }) => role.endsWith('model-archive')))
      .toHaveLength(2);
    await expect(validatePaddleCatalog(vendorRoot)).resolves.toMatchObject({
      totalBytes: manifest.totalBytes,
    });
  });

  it('independently pins the raw npm Worker and ORT Wasm before vendoring', async () => {
    const workerDirectory = resolve(
      'node_modules/@paddleocr/paddleocr-js/dist/assets',
    );
    const workerCandidates = (await readdir(workerDirectory))
      .filter((name) => /^worker-entry-[A-Za-z0-9_-]+\.js$/u.test(name));
    expect(workerCandidates).toHaveLength(1);

    const [worker, wasm] = await Promise.all([
      readFile(resolve(workerDirectory, workerCandidates[0])),
      readFile(resolve(
        'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
      )),
    ]);
    expect(createHash('sha256').update(worker).digest('hex')).toBe(
      APPROVED_PADDLE_OCR_WORKER_SHA256,
    );
    expect(createHash('sha256').update(wasm).digest('hex')).toBe(
      APPROVED_ONNXRUNTIME_WASM_SHA256,
    );
  });

  it('stops an oversized streamed download before accepting another chunk', async () => {
    const chunks = [
      Uint8Array.from([1, 2]),
      Uint8Array.from([3, 4]),
      Uint8Array.from([5, 6]),
    ];
    let readCount = 0;
    let cancelled = false;
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      url: 'https://assets.example.test/model.tar',
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => {
            const value = chunks[readCount];
            readCount += 1;
            return value ? { done: false, value } : { done: true };
          },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    });

    await expect(downloadPinned({
      source: 'https://assets.example.test/model.tar',
      sha256: 'unused-after-size-rejection',
      maximumBytes: 3,
    }, { fetchImpl })).rejects.toThrow('exceeds maximumBytes');
    expect(readCount).toBe(2);
    expect(cancelled).toBe(true);
  });

  it('restores the prior catalog when staged promotion fails', async () => {
    const parent = await mkdtemp(resolve(tmpdir(), 'simul-paddle-swap-'));
    const target = resolve(parent, 'paddle');
    const stage = resolve(parent, '.paddle-stage-test');
    await Promise.all([
      mkdir(target),
      mkdir(stage),
    ]);
    await Promise.all([
      writeFile(resolve(target, 'marker.txt'), 'known-good'),
      writeFile(resolve(stage, 'marker.txt'), 'replacement'),
    ]);

    try {
      await expect(replaceGeneratedCatalog({
        stagedDirectory: stage,
        targetDirectory: target,
        validateDirectory: async () => {},
        renameEntry: async (source, destination) => {
          if (source === stage && destination === target) {
            throw new Error('simulated promotion failure');
          }
          await rename(source, destination);
        },
      })).rejects.toThrow('previous catalog was restored');
      expect(await readFile(resolve(target, 'marker.txt'), 'utf8')).toBe(
        'known-good',
      );
      expect(await readFile(resolve(stage, 'marker.txt'), 'utf8')).toBe(
        'replacement',
      );
      expect((await readdir(parent)).some((name) =>
        name.startsWith('.paddle-backup-'),
      )).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('removes every model/CDN fallback from the local module Worker', async () => {
    const worker = await readFile(
      resolve(vendorRoot, 'worker/worker-entry.js'),
      'utf8',
    );
    expect(worker).toContain('worker-transport-request');
    expect(worker).toContain('worker-transport-response');
    expect(worker).toContain('__SIMUL_EXPLICIT_LOCAL_PADDLE_MODEL_REQUIRED__');
    expect(worker).not.toMatch(
      /paddle-model-ecology\.bj\.bcebos\.com|cdn\.jsdelivr\.net|unpkg\.com/iu,
    );
    expect(worker).not.toMatch(/sourceMappingURL/iu);
  });
});
