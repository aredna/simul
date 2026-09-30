import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVED_PDFJS_BROTLI_LICENSE_SOURCE,
  APPROVED_PDFJS_COMMIT,
  APPROVED_PDFJS_STANDARD_FONTS,
  APPROVED_PDFJS_VERSION,
  APPROVED_PDFJS_WASM,
  APPROVED_PDFJS_WASM_LICENSES,
  compareCodeUnits,
  findUnreviewedPdfjsUrls,
} from './extension-artifact.mjs';

// Rebuilds vendor/pdfjs/ from the installed pdfjs-dist: the reviewed subset
// of files, byte-identical to npm, plus Simul's shim and worker entry, and an
// asset manifest the artifact gate pins. vendor/pdfjs/THIRD_PARTY_NOTICES.md
// is hand-written and kept across runs. Everything is built in a staging
// folder first, so a failed run (offline, a missing file) changes nothing.
const PDFJS_VERSION = APPROVED_PDFJS_VERSION;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const finalRoot = resolve(root, 'vendor/pdfjs');
const outputRoot = resolve(root, 'vendor/.pdfjs-staging');
const packageRoot = resolve(root, 'node_modules/pdfjs-dist');
const npmSource = (path) => `npm:pdfjs-dist@${PDFJS_VERSION}/${path}`;
const brotliLicenseUrl = APPROVED_PDFJS_BROTLI_LICENSE_SOURCE;
const files = [];

const packageManifest = JSON.parse(
  await readFile(resolve(packageRoot, 'package.json'), 'utf8'),
);
if (packageManifest.version !== PDFJS_VERSION) {
  throw new Error(`pdfjs-dist must be exactly ${PDFJS_VERSION}.`);
}
const notices = await readFile(resolve(finalRoot, 'THIRD_PARTY_NOTICES.md')).catch((error) => {
  if (error?.code === 'ENOENT') return undefined;
  throw error;
});
// The one network step goes first.
const brotliLicense = await fetch(brotliLicenseUrl, { redirect: 'error' });
if (!brotliLicense.ok) throw new Error(`Could not download LICENSE_BROTLI: ${brotliLicense.status}`);
const brotliLicenseBytes = Buffer.from(await brotliLicense.arrayBuffer());
if (!/Permission is hereby granted/u.test(brotliLicenseBytes.toString('utf8'))) {
  throw new Error('LICENSE_BROTLI is not the expected MIT licence.');
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
if (notices) await writeFile(resolve(outputRoot, 'THIRD_PARTY_NOTICES.md'), notices);

await copyFromPackage('build/pdf.min.mjs', 'pdf.min.mjs', 'module');
await copyFromPackage('build/pdf.worker.min.mjs', 'pdf.worker.min.mjs', 'worker');
await copyFromPackage('LICENSE', 'LICENSE', 'license');

const cmapNames = (await readdir(resolve(packageRoot, 'cmaps')))
  .filter((name) => name.endsWith('.bcmap'))
  .sort(compareCodeUnits);
for (const name of cmapNames) {
  await copyFromPackage(`cmaps/${name}`, `cmaps/${name}`, 'cmap');
}
await copyFromPackage('cmaps/LICENSE', 'cmaps/LICENSE', 'license');

// Browsers draw the other standard fonts with system fonts; pdf.js fetches
// only these two. The Liberation fonts are GPL and stay out.
for (const name of APPROVED_PDFJS_STANDARD_FONTS) {
  await copyFromPackage(`standard_fonts/${name}`, `standard_fonts/${name}`, 'standard-font');
}
await copyFromPackage('standard_fonts/LICENSE_FOXIT', 'standard_fonts/LICENSE_FOXIT', 'license');

for (const name of APPROVED_PDFJS_WASM) {
  await copyFromPackage(`wasm/${name}`, `wasm/${name}`, 'wasm');
}
for (const name of APPROVED_PDFJS_WASM_LICENSES) {
  await copyFromPackage(`wasm/${name}`, `wasm/${name}`, 'license');
}

await copyFromPackage(
  'iccs/CGATS001Compat-v2-micro.icc',
  'iccs/CGATS001Compat-v2-micro.icc',
  'icc',
);
await copyFromPackage('iccs/LICENSE', 'iccs/LICENSE', 'license');

await emit('LICENSE_BROTLI', brotliLicenseBytes, 'license', brotliLicenseUrl);

for (const [name, role] of [
  ['simul-shim.mjs', 'shim'],
  ['simul-worker.mjs', 'worker-entry'],
]) {
  await emit(
    name,
    await readFile(resolve(root, `tools/pdfjs/${name}`)),
    role,
    `repo:tools/pdfjs/${name}`,
  );
}

for (const file of files.filter(({ path }) => path.endsWith('.mjs'))) {
  const text = await readFile(resolve(outputRoot, file.path), 'utf8');
  const unreviewed = findUnreviewedPdfjsUrls(text);
  if (unreviewed.length > 0) {
    throw new Error(`${file.path} contains unreviewed URLs: ${unreviewed.join(', ')}`);
  }
  if (/sourceMappingURL/u.test(text)) {
    throw new Error(`${file.path} contains a source map reference.`);
  }
}

files.sort((left, right) => compareCodeUnits(left.path, right.path));
const manifest = {
  schemaVersion: 1,
  pdfjsVersion: PDFJS_VERSION,
  pdfjsCommit: APPROVED_PDFJS_COMMIT,
  totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  files,
};
await writeFile(
  resolve(outputRoot, 'asset-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await rm(finalRoot, { recursive: true, force: true });
await rename(outputRoot, finalRoot);
console.log(`vendor/pdfjs: ${files.length} files, ${manifest.totalBytes} bytes.`);
if (!notices) console.log('vendor/pdfjs/THIRD_PARTY_NOTICES.md is missing; write it before building.');

async function copyFromPackage(sourcePath, path, role) {
  await emit(
    path,
    await readFile(resolve(packageRoot, sourcePath)),
    role,
    npmSource(sourcePath),
  );
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
