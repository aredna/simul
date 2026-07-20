import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APPROVED_TESSDATA_FAST_COMMIT,
  APPROVED_TESSERACT_CORE_PATHS,
  APPROVED_TESSERACT_LANGUAGE_CODES,
  APPROVED_TESSERACT_LICENSE_PATHS,
  APPROVED_TESSERACT_TRAINEDDATA_CODES,
  APPROVED_TESSERACT_WORKER_PATH,
} from '../tools/extension-artifact.mjs';

const vendorRoot = resolve('vendor/ocr/tesseract');

describe('vendored Tesseract artifact catalog', () => {
  it('pins exact dependencies and the approved complete 22-model catalog', async () => {
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    const manifest = JSON.parse(
      await readFile(resolve(vendorRoot, 'asset-manifest.json'), 'utf8'),
    );

    expect(packageManifest.dependencies['tesseract.js']).toBe('7.0.0');
    expect(packageManifest.dependencies['tesseract.js-core']).toBe('7.0.0');
    expect(lock.packages['node_modules/tesseract.js'].version).toBe('7.0.0');
    expect(lock.packages['node_modules/tesseract.js-core'].version).toBe('7.0.0');
    expect(manifest.tessdataFastCommit).toBe(APPROVED_TESSDATA_FAST_COMMIT);
    expect(manifest.languageCodes).toEqual(APPROVED_TESSERACT_LANGUAGE_CODES);
    expect(manifest.files.filter(({ role }) => role === 'traineddata'))
      .toHaveLength(APPROVED_TESSERACT_TRAINEDDATA_CODES.length);
    expect(manifest.files.filter(({ role }) => role === 'wasm-core-loader'))
      .toHaveLength(APPROVED_TESSERACT_CORE_PATHS.length);
    expect(manifest.totalBytes).toBeLessThan(42 * 1024 * 1024);
  });

  it('uses the exact approved path, role, order, and source layout', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(vendorRoot, 'asset-manifest.json'), 'utf8'),
    );
    const expected = [
      ...APPROVED_TESSERACT_CORE_PATHS.map((assetPath) => ({
        path: assetPath,
        role: 'wasm-core-loader',
        source: `npm:tesseract.js-core@7.0.0/${assetPath.split('/').at(-1)}`,
      })),
      ...APPROVED_TESSERACT_TRAINEDDATA_CODES.map((code) => ({
        path: `lang/${code}.traineddata.gz`,
        role: 'traineddata',
        source: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${APPROVED_TESSDATA_FAST_COMMIT}/${code}.traineddata`,
      })),
      {
        path: APPROVED_TESSERACT_LICENSE_PATHS[0],
        role: 'license',
        source: `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${APPROVED_TESSDATA_FAST_COMMIT}/LICENSE`,
      },
      {
        path: APPROVED_TESSERACT_LICENSE_PATHS[1],
        role: 'license',
        source: 'npm:tesseract.js-core@7.0.0/LICENSE',
      },
      {
        path: APPROVED_TESSERACT_LICENSE_PATHS[2],
        role: 'license',
        source: 'npm:tesseract.js@7.0.0/LICENSE.md',
      },
      {
        path: APPROVED_TESSERACT_LICENSE_PATHS[3],
        role: 'license',
        source: 'npm:tesseract.js@7.0.0/dist/worker.min.js.LICENSE.txt',
      },
      {
        path: APPROVED_TESSERACT_WORKER_PATH,
        role: 'worker',
        source: 'npm:tesseract.js@7.0.0/dist/worker.min.js',
      },
    ];

    expect(manifest.files.map(({ path, role, source }) => ({
      path,
      role,
      source,
    }))).toEqual(expected);
  });

  it('matches every declared byte/hash and contains all required licenses', async () => {
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
    expect(manifest.files.filter(({ role }) => role === 'license').length)
      .toBeGreaterThanOrEqual(4);
    const notices = await stat('vendor/ocr/THIRD_PARTY_NOTICES.md');
    expect(notices.size).toBeGreaterThan(0);
  });

  it('contains no remote runtime fallback in packaged Worker/core loaders', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(vendorRoot, 'asset-manifest.json'), 'utf8'),
    );
    for (const entry of manifest.files.filter(
      ({ role }) => role === 'worker' || role === 'wasm-core-loader',
    )) {
      const source = await readFile(resolve(vendorRoot, entry.path), 'utf8');
      expect(source, entry.path).not.toMatch(
        /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com)/u,
      );
    }
  });
});
