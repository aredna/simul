import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const TESSERACT_VERSION = '7.0.0';
export const TESSDATA_FAST_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';
export const TESSDATA_CODES = Object.freeze([
  'eng',
  'spa',
  'fra',
  'deu',
  'por',
  'ita',
  'vie',
  'jpn',
  'jpn_vert',
  'kor',
  'chi_sim',
  'chi_tra',
  'rus',
  'ukr',
  'ara',
  'heb',
  'hin',
  'mar',
  'ben',
  'kan',
  'tam',
  'tel',
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = resolve(root, 'vendor/ocr/tesseract');
const sourceRoot = resolve(root, 'node_modules');
const coreFiles = Object.freeze([
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm.js',
]);
const files = [];

await assertPinnedPackage('tesseract.js');
await assertPinnedPackage('tesseract.js-core');
await rm(outputRoot, { recursive: true, force: true });
await mkdir(resolve(outputRoot, 'worker'), { recursive: true });
await mkdir(resolve(outputRoot, 'core'), { recursive: true });
await mkdir(resolve(outputRoot, 'lang'), { recursive: true });
await mkdir(resolve(outputRoot, 'licenses'), { recursive: true });

const workerSource = await readFile(
  resolve(sourceRoot, 'tesseract.js/dist/worker.min.js'),
  'utf8',
);
const worker = patchRemoteFallbacks(workerSource);
await emit('worker/worker.min.js', Buffer.from(worker), 'worker',
  `npm:tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`);

for (const file of coreFiles) {
  await emit(
    `core/${file}`,
    await readFile(resolve(sourceRoot, `tesseract.js-core/${file}`)),
    'wasm-core-loader',
    `npm:tesseract.js-core@${TESSERACT_VERSION}/${file}`,
  );
}

for (const code of TESSDATA_CODES) {
  const source = `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_FAST_COMMIT}/${code}.traineddata`;
  const response = await fetch(source, { redirect: 'error' });
  if (!response.ok) throw new Error(`Could not download ${code}: ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  if (raw.length < 1 || raw.length > 16 * 1024 * 1024) {
    throw new Error(`Unexpected ${code} traineddata size: ${raw.length}`);
  }
  const compressed = gzipSync(raw, { level: 9, mtime: 0 });
  await emit(`lang/${code}.traineddata.gz`, compressed, 'traineddata', source);
}

await emit(
  'licenses/TESSERACT_JS_APACHE-2.0.txt',
  await readFile(resolve(sourceRoot, 'tesseract.js/LICENSE.md')),
  'license',
  `npm:tesseract.js@${TESSERACT_VERSION}/LICENSE.md`,
);
await emit(
  'licenses/TESSERACT_CORE_APACHE-2.0.txt',
  await readFile(resolve(sourceRoot, 'tesseract.js-core/LICENSE')),
  'license',
  `npm:tesseract.js-core@${TESSERACT_VERSION}/LICENSE`,
);
await emit(
  'licenses/WORKER_THIRD_PARTY.txt',
  await readFile(resolve(sourceRoot, 'tesseract.js/dist/worker.min.js.LICENSE.txt')),
  'license',
  `npm:tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js.LICENSE.txt`,
);
const tessdataLicenseUrl =
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${TESSDATA_FAST_COMMIT}/LICENSE`;
const tessdataLicenseResponse = await fetch(tessdataLicenseUrl, { redirect: 'error' });
if (!tessdataLicenseResponse.ok) throw new Error('Could not download tessdata license.');
await emit(
  'licenses/TESSDATA_FAST_APACHE-2.0.txt',
  Buffer.from(await tessdataLicenseResponse.arrayBuffer()),
  'license',
  tessdataLicenseUrl,
);

files.sort((left, right) => left.path.localeCompare(right.path));
const manifest = {
  schemaVersion: 1,
  tesseractVersion: TESSERACT_VERSION,
  tesseractCoreVersion: TESSERACT_VERSION,
  tessdataFastCommit: TESSDATA_FAST_COMMIT,
  preprocessingVersion: 'visible-crop-v2',
  languageCodes: TESSDATA_CODES,
  totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  files,
};
await writeFile(
  resolve(outputRoot, 'asset-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

async function assertPinnedPackage(name) {
  const manifest = JSON.parse(await readFile(resolve(sourceRoot, `${name}/package.json`), 'utf8'));
  if (manifest.version !== TESSERACT_VERSION) {
    throw new Error(`${name} must be exactly ${TESSERACT_VERSION}.`);
  }
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

function patchRemoteFallbacks(source) {
  const replacements = [
    ['https://cdn.jsdelivr.net/npm/tesseract.js-core@v', '__SIMUL_LOCAL_CORE_REQUIRED__'],
    ['https://cdn.jsdelivr.net/npm/@tesseract.js-data/', '__SIMUL_LOCAL_LANG_REQUIRED__/'],
  ];
  let patched = source;
  for (const [from, to] of replacements) patched = patched.replaceAll(from, to);
  patched = patched.replace(
    /(?:^|\r?\n)\s*\/\/[#@]\s*sourceMappingURL\s*=\s*[^\r\n]*\s*$/u,
    '',
  );
  if (/https?:\/\//u.test(patched)) {
    const executableUrls = [...patched.matchAll(/https?:\/\/[^"'\s]+/gu)]
      .map((match) => match[0])
      .filter((url) => !url.includes('github.com/DanBloomberg'));
    if (executableUrls.length > 0) {
      throw new Error(`Patched Worker retains remote URLs: ${executableUrls.join(', ')}`);
    }
  }
  return patched;
}
