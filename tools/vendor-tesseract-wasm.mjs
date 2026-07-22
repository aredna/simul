import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TESSERACT_WASM_VERSION = '0.11.0';
export const TESSERACT_WASM_GIT_COMMIT =
  '9aab28490d27a424019187e8169a62a64a50a028';
export const TESSERACT_WASM_TESSERACT_COMMIT =
  '080da83cc51c4ef8b324a7e03146fe0bd7e0944b';
export const TESSERACT_WASM_LEPTONICA_COMMIT =
  'b667978e86c4bf74f7fdd75f833127d2de327550';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(root, 'vendor/ocr/tesseract-wasm');
const sourceRoot = resolve(root, 'node_modules');
const files = [];

await assertPinnedPackages();
await rm(outputRoot, { recursive: true, force: true });

for (const [sourcePath, targetPath, role] of [
  ['dist/tesseract-core.wasm', 'core/tesseract-core.wasm', 'wasm-core'],
  [
    'dist/tesseract-core-fallback.wasm',
    'core/tesseract-core-fallback.wasm',
    'wasm-core-fallback',
  ],
  ['dist/tesseract-worker.js', 'worker/tesseract-worker.js', 'worker'],
]) {
  let bytes = await readFile(
    resolve(sourceRoot, 'tesseract-wasm', sourcePath),
  );
  if (role === 'worker') {
    bytes = Buffer.from(patchWorkerLocalFallbacks(bytes.toString('utf8')));
    assertNoRemoteExecutableReferences(bytes.toString('utf8'));
  }
  await emit(
    targetPath,
    bytes,
    role,
    `npm:tesseract-wasm@${TESSERACT_WASM_VERSION}/${sourcePath}${
      role === 'worker' ? '#simul-local-paths' : ''
    }`,
  );
}

await emit(
  'licenses/TESSERACT_WASM_BSD-2-CLAUSE.md',
  await readFile(resolve(sourceRoot, 'tesseract-wasm/LICENSE.md')),
  'license',
  `npm:tesseract-wasm@${TESSERACT_WASM_VERSION}/LICENSE.md`,
);
await emit(
  'licenses/COMLINK_APACHE-2.0.txt',
  await readFile(resolve(sourceRoot, 'comlink/LICENSE')),
  'license',
  'npm:comlink@4.4.2/LICENSE',
);
await emitRemoteLicense(
  'licenses/TESSERACT_CORE_APACHE-2.0.txt',
  `https://raw.githubusercontent.com/tesseract-ocr/tesseract/${TESSERACT_WASM_TESSERACT_COMMIT}/LICENSE`,
);
await emitRemoteLicense(
  'licenses/LEPTONICA_BSD-2-CLAUSE.txt',
  `https://raw.githubusercontent.com/DanBloomberg/leptonica/${TESSERACT_WASM_LEPTONICA_COMMIT}/leptonica-license.txt`,
);

const provenance = `TESSERACT-WASM DIRECT RUNTIME PROVENANCE
========================================

Simul's test-only direct runtime packages tesseract-wasm ${TESSERACT_WASM_VERSION}
from tag v${TESSERACT_WASM_VERSION}, resolved source commit
${TESSERACT_WASM_GIT_COMMIT}. That release pins Tesseract OCR 5.3.0 at
${TESSERACT_WASM_TESSERACT_COMMIT} and Leptonica 1.83.1 at
${TESSERACT_WASM_LEPTONICA_COMMIT}. The JavaScript library and Worker include
Comlink 4.4.2. The runtime reuses Simul's separately pinned Apache-2.0
tessdata_fast catalog and never downloads executable code or models.
The vendored Worker changes only its unreachable default URL fallbacks to
point at the packaged sibling core directory; Simul always supplies both the
Worker URL and Wasm bytes explicitly.

The direct adapter is an A/B runtime for the same Tesseract recognition family
as Tesseract.js; it is not an independent corroborating OCR engine.
`;
await emit(
  'PROVENANCE.txt',
  Buffer.from(provenance),
  'notice',
  `repo:tools/vendor-tesseract-wasm.mjs@${TESSERACT_WASM_GIT_COMMIT}`,
);

files.sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  schemaVersion: 1,
  tesseractWasmVersion: TESSERACT_WASM_VERSION,
  tesseractWasmGitCommit: TESSERACT_WASM_GIT_COMMIT,
  tesseractCommit: TESSERACT_WASM_TESSERACT_COMMIT,
  leptonicaCommit: TESSERACT_WASM_LEPTONICA_COMMIT,
  comlinkVersion: '4.4.2',
  reusesTessdataCatalog: '../tesseract/asset-manifest.json',
  totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  files,
};
await writeFile(
  resolve(outputRoot, 'asset-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

async function assertPinnedPackages() {
  const direct = JSON.parse(await readFile(
    resolve(sourceRoot, 'tesseract-wasm/package.json'),
    'utf8',
  ));
  const comlink = JSON.parse(await readFile(
    resolve(sourceRoot, 'comlink/package.json'),
    'utf8',
  ));
  if (direct.version !== TESSERACT_WASM_VERSION || comlink.version !== '4.4.2') {
    throw new Error('Direct Tesseract-Wasm dependencies are not exactly pinned.');
  }
}

async function emitRemoteLicense(path, source) {
  const response = await fetch(source, { redirect: 'error' });
  if (!response.ok) throw new Error(`Could not fetch license: ${source}`);
  const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
  await emit(path, Buffer.from(`${text.trimEnd()}\n`), 'license', source);
}

async function emit(path, data, role, source) {
  const target = resolve(outputRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  files.push({
    path,
    role,
    source,
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
}

function assertNoRemoteExecutableReferences(source) {
  const patterns = [
    /\b(?:importScripts|fetch)\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    /\bnew\s+(?:SharedWorker|Worker|URL)\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    /\bimport\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
  ];
  if (patterns.some((pattern) => pattern.test(source))) {
    throw new Error('Direct Tesseract-Wasm Worker contains remote executable code.');
  }
}

function patchWorkerLocalFallbacks(source) {
  const workerBaseFallback =
    "new URL('tesseract-worker.js', document.baseURI).href";
  const coreUrlFallback = 'new URL("tesseract-core.wasm",';
  const fastCoreFallback = '"./tesseract-core.wasm"';
  const relaxedCoreFallback = '"./tesseract-core-fallback.wasm"';
  for (const requiredFallback of [
    workerBaseFallback,
    coreUrlFallback,
    fastCoreFallback,
    relaxedCoreFallback,
  ]) {
    if (!source.includes(requiredFallback)) {
      throw new Error(
        `The pinned Worker fallback is missing: ${requiredFallback}`,
      );
    }
  }
  const patched = source
    .replaceAll(
      workerBaseFallback,
      'document.baseURI',
    )
    .replaceAll(
      coreUrlFallback,
      'new URL("../core/tesseract-core.wasm",',
    )
    .replaceAll(fastCoreFallback, '"../core/tesseract-core.wasm"')
    .replaceAll(
      relaxedCoreFallback,
      '"../core/tesseract-core-fallback.wasm"',
    )
    .replace(/[\t ]+$/gmu, '');
  if (
    [
      workerBaseFallback,
      coreUrlFallback,
      fastCoreFallback,
      relaxedCoreFallback,
    ].some((fallback) => patched.includes(fallback)) ||
    !patched.includes('../core/tesseract-core.wasm') ||
    !patched.includes('../core/tesseract-core-fallback.wasm')
  ) {
    throw new Error(
      'The pinned Worker local-path patch did not replace every fallback.',
    );
  }
  return patched;
}
