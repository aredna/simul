import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PADDLE_OCR_JS_VERSION = '0.4.2';
export const PADDLE_OCR_JS_GIT_HEAD =
  'e5046169b225bcdfbe25d45b4e809ff0f1a69c2c';
export const ONNXRUNTIME_WEB_VERSION = '1.24.3';
export const APPROVED_PADDLE_OCR_WORKER_SHA256 =
  '477db3f009c118823a5f9ebe15f1e96c1c464165715ba28a9884290f61addf52';
export const APPROVED_ONNXRUNTIME_WASM_SHA256 =
  'be0e129949062ad50290ef94683fac8be5bb6156f709e030b7a5f1661a2f6c17';
export const APPROVED_ONNXRUNTIME_LOADER_SHA256 =
  '5687566b1bc1c8cf628d76c2ddb16b2a3b81a7997273d4666564880495088e57';
export const PADDLE_MODEL_NAMES = Object.freeze([
  'PP-OCRv6_tiny_det',
  'PP-OCRv6_tiny_rec',
]);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(root, 'vendor/ocr/paddle');
const nodeModules = path.resolve(root, 'node_modules');

const packagePins = Object.freeze({
  '@paddleocr/paddleocr-js': PADDLE_OCR_JS_VERSION,
  '@techstark/opencv-js': '4.10.0-release.1',
  'clipper-lib': '6.4.2',
  'js-yaml': '4.3.0',
  'onnxruntime-web': ONNXRUNTIME_WEB_VERSION,
});

const downloads = Object.freeze([
  {
    path: 'models/PP-OCRv6_tiny_det_onnx_infer.tar',
    role: 'detection-model-archive',
    source:
      'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_det_onnx_infer.tar',
    sha256: 'ff6ab415b0a6e0c488550f2fb5d5046f1719848df220b2dc21b56402a65bc05d',
    maximumBytes: 3 * 1024 * 1024,
    modelName: 'PP-OCRv6_tiny_det',
  },
  {
    path: 'models/PP-OCRv6_tiny_rec_onnx_infer.tar',
    role: 'recognition-model-archive',
    source:
      'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv6_tiny_rec_onnx_infer.tar',
    sha256: '1e13b22717b1edd89d4cde4fda272b6c17d5b505c97c2baea99da1a3a2d54b29',
    maximumBytes: 6 * 1024 * 1024,
    modelName: 'PP-OCRv6_tiny_rec',
  },
  {
    path: 'licenses/PADDLEOCR_APACHE-2.0.txt',
    role: 'license',
    source:
      `https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/${PADDLE_OCR_JS_GIT_HEAD}/LICENSE`,
    sha256: '3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e',
    maximumBytes: 32 * 1024,
  },
  {
    path: 'licenses/ONNXRUNTIME_MIT.txt',
    role: 'license',
    source:
      `https://raw.githubusercontent.com/microsoft/onnxruntime/v${ONNXRUNTIME_WEB_VERSION}/LICENSE`,
    sha256: '2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c',
    maximumBytes: 8 * 1024,
  },
  {
    path: 'licenses/CLIPPER_BOOST-1.0.txt',
    role: 'license',
    source: 'https://www.boost.org/LICENSE_1_0.txt',
    sha256: 'c9bff75738922193e67fa726fa225535870d2aa1059f91452c411736284ad566',
    maximumBytes: 8 * 1024,
  },
]);

export const EXPECTED_PADDLE_CATALOG_PATHS = Object.freeze([
  'licenses/CLIPPER_BOOST-1.0.txt',
  'licenses/JS-YAML_MIT.txt',
  'licenses/ONNXRUNTIME_MIT.txt',
  'licenses/OPENCV_APACHE-2.0.txt',
  'licenses/PADDLEOCR_APACHE-2.0.txt',
  'models/PP-OCRv6_tiny_det_onnx_infer.tar',
  'models/PP-OCRv6_tiny_rec_onnx_infer.tar',
  'runtime/ort-wasm-simd-threaded.mjs',
  'runtime/ort-wasm-simd-threaded.wasm',
  'THIRD_PARTY_NOTICES.md',
  'worker/worker-entry.js',
]);

export async function vendorPaddleOcr({ fetchImpl = fetch } = {}) {
  for (const [name, version] of Object.entries(packagePins)) {
    await assertPinnedPackage(name, version);
  }

  const catalogParent = path.dirname(outputRoot);
  await mkdir(catalogParent, { recursive: true });
  const stagedDirectory = await mkdtemp(
    path.join(catalogParent, '.paddle-stage-'),
  );
  const files = [];

  try {
    for (const download of downloads) {
      const data = await downloadPinned(download, { fetchImpl });
      if (download.modelName) validateModelArchive(data, download.modelName);
      await emitCatalogFile(
        stagedDirectory,
        files,
        download.path,
        data,
        download.role,
        download.source,
      );
    }

    const [ortLoader, ortWasm] = await Promise.all([
      readFile(path.resolve(
        nodeModules,
        'onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
      )),
      readFile(path.resolve(
        nodeModules,
        'onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
      )),
    ]);
    assertApprovedSourceHash(
      ortLoader,
      APPROVED_ONNXRUNTIME_LOADER_SHA256,
      'Pinned ONNX Runtime module loader',
    );
    assertApprovedSourceHash(
      ortWasm,
      APPROVED_ONNXRUNTIME_WASM_SHA256,
      'Pinned ONNX Runtime Wasm',
    );
    await emitCatalogFile(
      stagedDirectory,
      files,
      'runtime/ort-wasm-simd-threaded.mjs',
      ortLoader,
      'wasm-module-loader',
      `npm:onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}/dist/ort-wasm-simd-threaded.mjs`,
    );
    await emitCatalogFile(
      stagedDirectory,
      files,
      'runtime/ort-wasm-simd-threaded.wasm',
      ortWasm,
      'wasm-runtime',
      `npm:onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}/dist/ort-wasm-simd-threaded.wasm`,
    );

    const workerDirectory = path.resolve(
      nodeModules,
      '@paddleocr/paddleocr-js/dist/assets',
    );
    const workerCandidates = (await readdir(workerDirectory))
      .filter((name) => /^worker-entry-[A-Za-z0-9_-]+\.js$/u.test(name));
    if (workerCandidates.length !== 1) {
      throw new Error(
        'The pinned PaddleOCR.js package must contain one module Worker.',
      );
    }
    const workerName = workerCandidates[0];
    const rawWorker = await readFile(path.resolve(workerDirectory, workerName));
    assertApprovedSourceHash(
      rawWorker,
      APPROVED_PADDLE_OCR_WORKER_SHA256,
      'Pinned PaddleOCR.js module Worker',
    );
    await emitCatalogFile(
      stagedDirectory,
      files,
      'worker/worker-entry.js',
      Buffer.from(patchPaddleDirectModule(rawWorker.toString('utf8'))),
      'sandbox-direct-module',
      `npm:@paddleocr/paddleocr-js@${PADDLE_OCR_JS_VERSION}/dist/assets/${workerName}`,
    );
    await emitCatalogFile(
      stagedDirectory,
      files,
      'licenses/OPENCV_APACHE-2.0.txt',
      await readFile(path.resolve(nodeModules, '@techstark/opencv-js/LICENSE')),
      'license',
      'npm:@techstark/opencv-js@4.10.0-release.1/LICENSE',
    );
    await emitCatalogFile(
      stagedDirectory,
      files,
      'licenses/JS-YAML_MIT.txt',
      await readFile(path.resolve(nodeModules, 'js-yaml/LICENSE')),
      'license',
      'npm:js-yaml@4.3.0/LICENSE',
    );
    await emitCatalogFile(
      stagedDirectory,
      files,
      'THIRD_PARTY_NOTICES.md',
      await readFile(path.resolve(
        root,
        'legal/paddleocr-js-v0.4.2-third-party-notices.md',
      )),
      'notice',
      'repo:legal/paddleocr-js-v0.4.2-third-party-notices.md',
    );

    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const manifest = {
      schemaVersion: 1,
      paddleOcrJsVersion: PADDLE_OCR_JS_VERSION,
      paddleOcrJsGitHead: PADDLE_OCR_JS_GIT_HEAD,
      onnxruntimeWebVersion: ONNXRUNTIME_WEB_VERSION,
      modelNames: PADDLE_MODEL_NAMES,
      workerMode: false,
      sandboxDirectMode: true,
      runtime: {
        backend: 'wasm',
        numThreads: 1,
        simd: true,
        proxy: false,
      },
      detectorThreshold: 0.45,
      detectorBoxThreshold: 0.75,
      recognitionScoreThreshold: 0,
      totalBytes: files.reduce((total, file) => total + file.bytes, 0),
      files,
    };
    await writeFile(
      path.resolve(stagedDirectory, 'asset-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await validatePaddleCatalog(stagedDirectory, manifest);
    await replaceGeneratedCatalog({
      stagedDirectory,
      targetDirectory: outputRoot,
      validateDirectory: (directory) =>
        validatePaddleCatalog(directory, manifest),
    });
    return outputRoot;
  } finally {
    await rm(stagedDirectory, { recursive: true, force: true });
  }
}

async function assertPinnedPackage(name, version) {
  const packageManifest = JSON.parse(await readFile(
    path.resolve(nodeModules, `${name}/package.json`),
    'utf8',
  ));
  if (packageManifest.version !== version) {
    throw new Error(`${name} must be exactly ${version}.`);
  }
}

export async function downloadPinned(
  { source, sha256, maximumBytes },
  { fetchImpl = fetch } = {},
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('Pinned Paddle asset maximumBytes must be a positive integer.');
  }
  const response = await fetchImpl(source, { redirect: 'follow' });
  if (
    !response?.ok ||
    typeof response.url !== 'string' ||
    response.url.startsWith('https://') === false
  ) {
    throw new Error(
      `Could not download pinned Paddle asset: ${response?.status ?? 'unknown'}`,
    );
  }

  const contentLengthText = response.headers?.get?.('content-length');
  if (contentLengthText != null && /^\d+$/u.test(contentLengthText.trim())) {
    const contentLength = Number(contentLengthText);
    if (!Number.isSafeInteger(contentLength) || contentLength > maximumBytes) {
      throw new Error(
        `Pinned Paddle asset exceeds maximumBytes: ${contentLengthText}.`,
      );
    }
  }
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw new Error('Pinned Paddle asset response has no readable body.');
  }

  const reader = response.body.getReader();
  const chunks = [];
  const hash = createHash('sha256');
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await cancelReader(reader);
      throw new Error('Pinned Paddle asset response emitted invalid bytes.');
    }
    if (value.byteLength === 0) continue;
    if (value.byteLength > maximumBytes - totalBytes) {
      await cancelReader(reader);
      throw new Error(
        `Pinned Paddle asset exceeds maximumBytes: more than ${maximumBytes}.`,
      );
    }
    totalBytes += value.byteLength;
    hash.update(value);
    chunks.push(Buffer.from(value));
  }
  if (totalBytes < 1) {
    throw new Error('Pinned Paddle asset has an unexpected size: 0.');
  }
  const actual = hash.digest('hex');
  if (actual !== sha256) {
    throw new Error(
      `Pinned Paddle asset hash changed: expected ${sha256}, received ${actual}.`,
    );
  }
  return Buffer.concat(chunks, totalBytes);
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // The size rejection remains authoritative if stream cancellation fails.
  }
}

async function emitCatalogFile(outputDirectory, files, relativePath, data, role, source) {
  assertSafeCatalogPath(relativePath);
  const target = path.resolve(outputDirectory, ...relativePath.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  files.push({
    path: relativePath,
    role,
    source,
    bytes: data.length,
    sha256: digest(data),
  });
}

export async function validatePaddleCatalog(directory, expectedManifest) {
  const catalogRoot = path.resolve(directory);
  const rootStat = await safeLstat(catalogRoot);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Paddle catalog is not a real directory: ${catalogRoot}.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(
      path.resolve(catalogRoot, 'asset-manifest.json'),
      'utf8',
    ));
  } catch (error) {
    throw new Error('Paddle catalog has no valid asset-manifest.json.', {
      cause: error,
    });
  }
  if (expectedManifest &&
      JSON.stringify(manifest) !== JSON.stringify(expectedManifest)) {
    throw new Error('Paddle catalog manifest differs from the generated catalog.');
  }
  if (
    manifest?.schemaVersion !== 1 ||
    manifest?.paddleOcrJsVersion !== PADDLE_OCR_JS_VERSION ||
    manifest?.paddleOcrJsGitHead !== PADDLE_OCR_JS_GIT_HEAD ||
    manifest?.onnxruntimeWebVersion !== ONNXRUNTIME_WEB_VERSION ||
    !Array.isArray(manifest?.files)
  ) {
    throw new Error('Paddle catalog manifest has unexpected pinned metadata.');
  }

  const manifestPaths = manifest.files.map((entry) => entry?.path);
  if (!sameOrderedStrings(manifestPaths, EXPECTED_PADDLE_CATALOG_PATHS)) {
    throw new Error('Paddle catalog manifest does not list the complete catalog.');
  }
  const inspected = await collectCatalogEntries(catalogRoot);
  const expectedFiles = [...EXPECTED_PADDLE_CATALOG_PATHS, 'asset-manifest.json']
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!sameOrderedStrings(inspected.files, expectedFiles)) {
    throw new Error('Paddle catalog contains missing or unexpected files.');
  }
  const expectedDirectories = [...new Set(
    EXPECTED_PADDLE_CATALOG_PATHS.map((entry) => path.posix.dirname(entry))
      .filter((entry) => entry !== '.'),
  )].sort((left, right) => left.localeCompare(right, 'en'));
  if (!sameOrderedStrings(inspected.directories, expectedDirectories)) {
    throw new Error('Paddle catalog contains missing or unexpected directories.');
  }

  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error(`Paddle catalog manifest entry is invalid: ${entry?.path}.`);
    }
    const data = await readFile(
      path.resolve(catalogRoot, ...entry.path.split('/')),
    );
    if (data.length !== entry.bytes || digest(data) !== entry.sha256) {
      throw new Error(`Paddle catalog asset failed validation: ${entry.path}.`);
    }
    totalBytes += data.length;
  }
  if (manifest.totalBytes !== totalBytes) {
    throw new Error('Paddle catalog totalBytes does not match its assets.');
  }
  return Object.freeze({ files: inspected.files, totalBytes });
}

async function collectCatalogEntries(rootDirectory) {
  const files = [];
  const directories = [];

  async function walk(absoluteDirectory, relativeDirectory) {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const absolutePath = path.resolve(absoluteDirectory, child.name);
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Paddle catalog symlink is forbidden: ${relativePath}.`);
      }
      if (stat.isDirectory()) {
        directories.push(relativePath);
        await walk(absolutePath, relativePath);
      } else if (stat.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`Paddle catalog entry type is forbidden: ${relativePath}.`);
      }
    }
  }

  await walk(rootDirectory, '');
  files.sort((left, right) => left.localeCompare(right, 'en'));
  directories.sort((left, right) => left.localeCompare(right, 'en'));
  return { files, directories };
}

export async function replaceGeneratedCatalog({
  stagedDirectory,
  targetDirectory,
  validateDirectory,
  renameEntry = rename,
  removeEntry = removeDirectory,
}) {
  const stage = path.resolve(stagedDirectory);
  const target = path.resolve(targetDirectory);
  assertCatalogSwapPaths(stage, target);
  if (typeof validateDirectory !== 'function') {
    throw new Error('Paddle catalog replacement requires a validator.');
  }
  const stageStat = await safeLstat(stage);
  if (!stageStat?.isDirectory() || stageStat.isSymbolicLink()) {
    throw new Error('Paddle catalog stage must be a real directory.');
  }
  const targetStat = await safeLstat(target);
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
    throw new Error('Existing Paddle catalog must be a real directory.');
  }
  await validateDirectory(stage);

  const backup = path.join(
    path.dirname(target),
    `.paddle-backup-${process.pid}-${randomUUID()}`,
  );
  let backupPresent = false;
  let promoted = false;

  if (targetStat) {
    await renameEntry(target, backup);
    backupPresent = true;
  }

  try {
    await renameEntry(stage, target);
    promoted = true;
    await validateDirectory(target);
  } catch (error) {
    let restoreError;
    try {
      if (promoted && await safeLstat(target)) {
        try {
          await renameEntry(target, stage);
        } catch {
          await removeEntry(target);
        }
        promoted = false;
      }
      if (backupPresent) {
        await renameEntry(backup, target);
        backupPresent = false;
      }
    } catch (candidateRestoreError) {
      restoreError = candidateRestoreError;
    }
    if (restoreError) {
      throw new Error(
        `Paddle catalog swap failed and restoration also failed; the previous catalog remains at ${backup}.`,
        { cause: restoreError },
      );
    }
    throw new Error(
      targetStat
        ? 'Paddle catalog swap failed; the previous catalog was restored.'
        : 'Paddle catalog swap failed; no previous catalog existed.',
      { cause: error },
    );
  }

  if (backupPresent) {
    try {
      await removeEntry(backup);
      backupPresent = false;
    } catch (error) {
      throw new Error(
        `The new validated Paddle catalog is active, but its previous-catalog backup could not be removed: ${backup}.`,
        { cause: error },
      );
    }
  }
  return target;
}

function assertCatalogSwapPaths(stage, target) {
  if (
    stage === target ||
    path.dirname(stage) !== path.dirname(target) ||
    path.basename(target) !== 'paddle' ||
    !path.basename(stage).startsWith('.paddle-stage-')
  ) {
    throw new Error('Paddle catalog stage and target failed their sibling path guard.');
  }
}

function assertSafeCatalogPath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length < 1 ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith('../') ||
    relativePath.includes('\\')
  ) {
    throw new Error(`Unsafe Paddle catalog path: ${relativePath}.`);
  }
}

function validateModelArchive(data, expectedModelName) {
  const entries = readTarEntries(data);
  const onnx = [...entries].find(([name]) => name.endsWith('/inference.onnx'));
  const yaml = [...entries].find(([name]) => name.endsWith('/inference.yml'));
  if (!onnx || !yaml || onnx[1].length < 1 || yaml[1].length < 1) {
    throw new Error(`${expectedModelName} archive is missing its ONNX model or config.`);
  }
  const config = yaml[1].toString('utf8');
  if (!new RegExp(`(?:^|\\n)\\s*model_name:\\s*["']?${expectedModelName}["']?\\s*(?:\\n|$)`, 'u').test(config)) {
    throw new Error(`${expectedModelName} archive has a mismatched model_name.`);
  }
}

function readTarEntries(data) {
  const entries = new Map();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = readTarString(header, 0, 100);
    const sizeText = readTarString(header, 124, 12).replaceAll('\0', '').trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    if (!name || !Number.isSafeInteger(size) || size < 0) {
      throw new Error('Pinned Paddle model archive is not valid ustar data.');
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > data.length) {
      throw new Error('Pinned Paddle model archive is truncated.');
    }
    if (header[156] !== 53) entries.set(name, data.subarray(dataStart, dataEnd));
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function readTarString(data, start, length) {
  const end = data.indexOf(0, start);
  return data.subarray(start, end >= start && end < start + length
    ? end
    : start + length).toString('utf8').trim();
}

function assertApprovedSourceHash(data, expected, label) {
  const actual = digest(data);
  if (actual !== expected) {
    throw new Error(
      `${label} hash changed: expected ${expected}, received ${actual}.`,
    );
  }
}

function digest(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sameOrderedStrings(candidate, expected) {
  return Array.isArray(candidate) &&
    candidate.length === expected.length &&
    expected.every((entry, index) => candidate[index] === entry);
}

async function safeLstat(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeDirectory(target) {
  await rm(target, { recursive: true, force: true });
}

export function patchPaddleDirectModule(source) {
  const modelBase =
    'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/';
  const ortCdn =
    `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ONNXRUNTIME_WEB_VERSION}/dist/`;
  const workerAttach =
    'attachWorkerMessageHandler(createPaddleOCRWorkerMessageHandler());';
  const directExport = [
    'function createPaddleOCRDirectHandler() {',
    '  return createPaddleOCRWorkerMessageHandler();',
    '}',
    'export { createPaddleOCRDirectHandler };',
  ].join('\n');
  if (source.split(workerAttach).length !== 2) {
    throw new Error(
      'The pinned Paddle bundle no longer has exactly one reviewed Worker attach call.',
    );
  }
  const patched = source
    .replaceAll(modelBase, '/__SIMUL_EXPLICIT_LOCAL_PADDLE_MODEL_REQUIRED__/')
    .replaceAll(ortCdn, '/__SIMUL_EXPLICIT_LOCAL_ORT_REQUIRED__/')
    .replace(workerAttach, directExport)
    .replace(
      /(?:^|\r?\n)\s*\/\/[#@]\s*sourceMappingURL\s*=\s*[^\r\n]*\s*$/u,
      '',
    );
  if (
    patched.includes(modelBase) ||
    patched.includes(ortCdn) ||
    patched.includes(workerAttach) ||
    !patched.includes('export { createPaddleOCRDirectHandler };')
  ) {
    throw new Error('The Paddle direct module patch did not close its runtime boundary.');
  }
  return patched;
}

async function main() {
  const target = await vendorPaddleOcr();
  console.log(`Vendored validated Paddle OCR catalog: ${target}`);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Paddle OCR vendoring error: ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
