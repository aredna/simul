import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const vendorRoot = resolve('vendor/ocr/tesseract-wasm');
const expectedPaths = [
  'core/tesseract-core-fallback.wasm',
  'core/tesseract-core.wasm',
  'licenses/COMLINK_APACHE-2.0.txt',
  'licenses/LEPTONICA_BSD-2-CLAUSE.txt',
  'licenses/TESSERACT_CORE_APACHE-2.0.txt',
  'licenses/TESSERACT_WASM_BSD-2-CLAUSE.md',
  'PROVENANCE.txt',
  'worker/tesseract-worker.js',
];

describe('vendored direct Tesseract-Wasm runtime', () => {
  it('pins the permissively licensed npm runtime and exact upstream commits', async () => {
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
    const manifest = await readManifest();

    expect(packageManifest.dependencies['tesseract-wasm']).toBe('0.11.0');
    expect(lock.packages['node_modules/tesseract-wasm']).toMatchObject({
      version: '0.11.0',
      license: 'BSD-2-Clause',
    });
    expect(lock.packages['node_modules/comlink']).toMatchObject({
      version: '4.4.2',
      license: 'Apache-2.0',
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      tesseractWasmVersion: '0.11.0',
      tesseractWasmGitCommit: '9aab28490d27a424019187e8169a62a64a50a028',
      tesseractCommit: '080da83cc51c4ef8b324a7e03146fe0bd7e0944b',
      leptonicaCommit: 'b667978e86c4bf74f7fdd75f833127d2de327550',
      comlinkVersion: '4.4.2',
      reusesTessdataCatalog: '../tesseract/asset-manifest.json',
    });
    expect(manifest.files.map(({ path }) => path)).toEqual(expectedPaths);
    expect(manifest.files.filter(({ role }) => role === 'license')).toHaveLength(4);
  });

  it('matches every declared local byte/hash and has no remote Worker loader', async () => {
    const manifest = await readManifest();
    let totalBytes = 0;
    for (const entry of manifest.files) {
      const bytes = await readFile(resolve(vendorRoot, entry.path));
      totalBytes += bytes.length;
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), entry.path)
        .toBe(entry.sha256);
    }
    expect(totalBytes).toBe(manifest.totalBytes);
    expect(totalBytes).toBeLessThan(4 * 1024 * 1024);

    const worker = await readFile(
      resolve(vendorRoot, 'worker/tesseract-worker.js'),
      'utf8',
    );
    expect(worker).not.toMatch(
      /\b(?:importScripts|fetch)\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    );
    expect(worker).not.toMatch(
      /\bnew\s+(?:SharedWorker|Worker|URL)\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    );
    expect(worker).toContain('../core/tesseract-core.wasm');
    expect(worker).toContain('../core/tesseract-core-fallback.wasm');
    expect(worker).not.toContain(
      "new URL('tesseract-worker.js', document.baseURI).href",
    );
  });
});

async function readManifest() {
  return JSON.parse(await readFile(
    resolve(vendorRoot, 'asset-manifest.json'),
    'utf8',
  ));
}
