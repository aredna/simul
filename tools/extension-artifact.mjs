import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from 'acorn';
import { parseHTML } from 'linkedom';

export const APPROVED_PERMISSIONS = Object.freeze([
  'activeTab',
  'scripting',
  'sidePanel',
  'storage',
]);
export const APPROVED_OCR_PERMISSIONS = Object.freeze([
  ...APPROVED_PERMISSIONS,
  'offscreen',
]);
export const APPROVED_OCR_CSP =
  "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';";
export const MAX_UNPACKED_ARTIFACT_BYTES = 42 * 1024 * 1024;
export const APPROVED_OPTIONAL_HOST_PERMISSIONS = Object.freeze([
  'http://*/*',
  'https://*/*',
]);
export const MINIMUM_CHROME_VERSION = 138;
export const REQUIRED_UNLISTED_BUNDLES = Object.freeze([
  'page-recorder.js',
  'page-mirror.js',
]);
export const REQUIRED_REPLICA_RUNTIME_MARKERS = Object.freeze([
  'simul:replica-v2:capture-checkpoint',
  'rrweb-shadow-v2',
  'simul:html-mirror-v1:',
  'isolated-html-v1',
]);
export const REQUIRED_ISOLATED_SANDBOX_MARKERS = Object.freeze([
  'simul-isolated-shell',
  'allow-same-origin',
  "script-src 'none'",
  "connect-src 'none'",
]);
export const FORBIDDEN_OCR_FOUNDATION_DEPENDENCIES = Object.freeze([
  '@huggingface/transformers',
  '@xenova/transformers',
  '@paddleocr/paddleocr-js',
  '@techstark/opencv-js',
  'onnxruntime-web',
  'opencv.js',
]);
export const APPROVED_OCR_PROVIDER_DEPENDENCIES = Object.freeze({
  'tesseract.js': '7.0.0',
  'tesseract.js-core': '7.0.0',
});
export const APPROVED_TESSDATA_FAST_COMMIT =
  '87416418657359cb625c412a48b6e1d6d41c29bd';
export const APPROVED_TESSERACT_LANGUAGE_CODES = Object.freeze([
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
export const APPROVED_TESSERACT_TRAINEDDATA_CODES = Object.freeze([
  'ara',
  'ben',
  'chi_sim',
  'chi_tra',
  'deu',
  'eng',
  'fra',
  'heb',
  'hin',
  'ita',
  'jpn_vert',
  'jpn',
  'kan',
  'kor',
  'mar',
  'por',
  'rus',
  'spa',
  'tam',
  'tel',
  'ukr',
  'vie',
]);
export const APPROVED_TESSERACT_CORE_PATHS = Object.freeze([
  'core/tesseract-core-lstm.wasm.js',
  'core/tesseract-core-relaxedsimd-lstm.wasm.js',
  'core/tesseract-core-simd-lstm.wasm.js',
]);
export const APPROVED_TESSERACT_WORKER_PATH = 'worker/worker.min.js';
export const APPROVED_TESSERACT_LICENSE_PATHS = Object.freeze([
  'licenses/TESSDATA_FAST_APACHE-2.0.txt',
  'licenses/TESSERACT_CORE_APACHE-2.0.txt',
  'licenses/TESSERACT_JS_APACHE-2.0.txt',
  'licenses/WORKER_THIRD_PARTY.txt',
]);
export const REQUIRED_OCR_HOST_RUNTIME_MARKERS = Object.freeze([
  'simul:ocr-v1:run',
]);
export const REQUIRED_TEXT_DETECTOR_RUNTIME_MARKERS = Object.freeze([
  'simul-chrome-text-detector-offscreen-v1',
]);
export const REQUIRED_TESSERACT_RUNTIME_MARKERS = Object.freeze([
  'tesseract.js-7.0.0',
  '/ocr/tesseract/worker/worker.min.js',
  '/ocr/tesseract/core',
  '/ocr/tesseract/lang',
]);
export const REQUIRED_OCR_RUNTIME_MARKERS = Object.freeze([
  ...REQUIRED_OCR_HOST_RUNTIME_MARKERS,
  ...REQUIRED_TEXT_DETECTOR_RUNTIME_MARKERS,
  ...REQUIRED_TESSERACT_RUNTIME_MARKERS,
]);
export const IMPLEMENTED_OCR_PROVIDER_IDS = Object.freeze([
  'chrome-text-detector',
  'tesseract',
]);

const TOOL_FILE = fileURLToPath(import.meta.url);
export const PROJECT_ROOT = path.resolve(path.dirname(TOOL_FILE), '..');

const TEXT_EXTENSIONS = new Set([
  '.css',
  '.htm',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.svg',
  '.txt',
  '.xml',
]);
const EXECUTABLE_EXTENSIONS = new Set(['.htm', '.html', '.js', '.mjs']);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);
const FORBIDDEN_MODEL_EXTENSIONS = new Set([
  '.bin',
  '.model',
  '.onnx',
  '.ort',
  '.pb',
  '.tflite',
  '.traineddata',
  '.wasm',
  '.weights',
]);
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bgh(?:p|o|s|u|r)_[A-Za-z0-9]{36,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{50,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\b(?:access[_-]?token|bearer[_-]?token)\s*[:=]\s*["'`]?(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{20,}/iu,
  /\bauthorization\s*[:=]\s*["'`]?Bearer\s+[A-Za-z0-9._~+/=-]{20,}/iu,
];

export class ArtifactError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ArtifactError';
  }
}

export function canonicalArtifactDirectory(projectRoot = PROJECT_ROOT) {
  return path.join(path.resolve(projectRoot), 'dist', 'chrome-unpacked');
}

export async function buildProductionArtifact({
  projectRoot = PROJECT_ROOT,
  temporaryRoot,
  ocrEnabled = true,
  ocrProviderIds,
} = {}) {
  if (!temporaryRoot) {
    throw new ArtifactError('A temporary build root is required.');
  }

  const resolvedRoot = path.resolve(projectRoot);
  const enabledOcrProviderIds = normalizeBuildOcrProviderIds(
    ocrProviderIds ?? (ocrEnabled ? IMPLEMENTED_OCR_PROVIDER_IDS : []),
  );
  await assertOcrProviderDependenciesApproved(resolvedRoot);
  const outputBase = path.join(path.resolve(temporaryRoot), 'wxt-output');
  const wxtCli = path.join(resolvedRoot, 'node_modules', 'wxt', 'bin', 'wxt.mjs');
  await access(wxtCli);

  await runProcess(
    process.execPath,
    [wxtCli, 'build', '--browser', 'chrome', '--mode', 'production'],
    {
      cwd: resolvedRoot,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        NODE_ENV: 'production',
        SIMUL_WXT_OUT_DIR: outputBase,
        SIMUL_OCR_TEXT_DETECTOR:
          enabledOcrProviderIds.includes('chrome-text-detector') ? '1' : '0',
        SIMUL_OCR_TESSERACT:
          enabledOcrProviderIds.includes('tesseract') ? '1' : '0',
        SIMUL_OCR_TRANSFORMERS: '0',
        SIMUL_OCR_PADDLE: '0',
        SIMUL_OCR_SCREEN_AI: '0',
      },
    },
  );

  return path.join(outputBase, 'chrome-mv3');
}

export async function validateArtifact(artifactDirectory) {
  const root = path.resolve(artifactDirectory);
  const rootStat = await safeLstat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ArtifactError(
      `Extension artifact is missing or is not a real directory: ${root}`,
    );
  }

  const entries = await collectEntries(root, { rejectSymlinks: true });
  const files = entries.filter((entry) => entry.type === 'file');
  const filePaths = new Set(files.map((entry) => entry.path));
  if (!filePaths.has('manifest.json')) {
    throw new ArtifactError('Extension artifact is missing manifest.json at its root.');
  }
  for (const requiredBundle of REQUIRED_UNLISTED_BUNDLES) {
    if (!filePaths.has(requiredBundle)) {
      throw new ArtifactError(
        `Extension artifact is missing required local bundle: ${requiredBundle}`,
      );
    }
  }

  const executableTextByPath = new Map();
  let unpackedBytes = 0;

  for (const entry of files) {
    assertSafeArtifactFilename(entry.path);
    const absolutePath = path.join(root, ...entry.path.split('/'));
    const extension = path.posix.extname(entry.path).toLowerCase();
    const contents = await readFile(absolutePath);
    unpackedBytes += contents.byteLength;
    assertNoSecretContent(entry.path, contents);

    if (TEXT_EXTENSIONS.has(extension)) {
      const text = contents.toString('utf8');
      if (hasSourceMapDirective(text, JAVASCRIPT_EXTENSIONS.has(extension))) {
        throw new ArtifactError(
          `Source map reference is forbidden in artifact file: ${entry.path}`,
        );
      }
      if (EXECUTABLE_EXTENSIONS.has(extension)) {
        assertNoRemoteExecutableReference(entry.path, text);
        executableTextByPath.set(entry.path, text);
      }
      await validateTextReferences(root, entry.path, text, filePaths);
    }
  }

  assertReplicaRuntimeMarkers(executableTextByPath, filePaths);

  const manifestPath = path.join(root, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new ArtifactError('manifest.json is not valid JSON.', { cause: error });
  }
  const offscreenOcrEnabled = validateManifest(manifest, filePaths);
  const ocrProviderIds = offscreenOcrEnabled
    ? detectOcrRuntimeProfile(executableTextByPath, filePaths)
    : Object.freeze([]);
  validateOcrProfileManifest(manifest, ocrProviderIds);
  if (ocrProviderIds.includes('tesseract')) {
    await validateTesseractRuntimeAssets({
      root,
      files,
      filePaths,
      executableTextByPath,
      unpackedBytes,
      requiredRuntimeMarkers: Object.freeze([
        ...REQUIRED_OCR_HOST_RUNTIME_MARKERS,
        ...(ocrProviderIds.includes('chrome-text-detector')
          ? REQUIRED_TEXT_DETECTOR_RUNTIME_MARKERS
          : []),
        ...REQUIRED_TESSERACT_RUNTIME_MARKERS,
      ]),
    });
  } else if (ocrProviderIds.includes('chrome-text-detector')) {
    validateAssetFreeOcrRuntime({
      files,
      filePaths,
      executableTextByPath,
      requiredRuntimeMarkers: Object.freeze([
        ...REQUIRED_OCR_HOST_RUNTIME_MARKERS,
        ...REQUIRED_TEXT_DETECTOR_RUNTIME_MARKERS,
      ]),
    });
  } else {
    for (const entry of files) assertNoOcrRuntimeArtifact(entry.path);
  }
  await validateManifestSemanticResources(root, manifest, filePaths);

  return {
    directory: root,
    files: [...filePaths].sort(),
    manifest,
    ocrEnabled: ocrProviderIds.length > 0,
    ocrProviderIds,
    unpackedBytes,
  };
}

function assertReplicaRuntimeMarkers(executableTextByPath, filePaths) {
  const [captureMarker, replayMarker, htmlMirrorMarker, isolatedMarker] =
    REQUIRED_REPLICA_RUNTIME_MARKERS;
  const recorderText = executableTextByPath.get(REQUIRED_UNLISTED_BUNDLES[0]);
  if (!recorderText || !hasJavaScriptStringMarker(recorderText, captureMarker)) {
    throw new ArtifactError(
      `Extension artifact is missing required local replica runtime marker: ${captureMarker}`,
    );
  }
  const mirrorText = executableTextByPath.get(REQUIRED_UNLISTED_BUNDLES[1]);
  if (!mirrorText || !hasJavaScriptStringMarker(mirrorText, htmlMirrorMarker)) {
    throw new ArtifactError(
      `Extension artifact is missing required local replica runtime marker: ${htmlMirrorMarker}`,
    );
  }

  const sidepanelText = executableTextByPath.get('sidepanel.html');
  const sidepanelScripts = sidepanelText
    ? discoverHtmlResourceReferences('sidepanel.html', sidepanelText)
        .map((reference) =>
          assertReferenceExists('sidepanel.html', reference, filePaths),
        )
        .filter((reference) => /\.m?js$/iu.test(reference))
    : [];
  if (
    sidepanelScripts.length === 0 ||
    !sidepanelScripts.some((script) => {
      const text = executableTextByPath.get(script);
      return hasJavaScriptStringMarker(text, replayMarker) &&
        hasJavaScriptStringMarker(text, isolatedMarker);
    })
  ) {
    throw new ArtifactError(
      `Extension artifact is missing required local replica runtime markers: ${replayMarker}, ${isolatedMarker}`,
    );
  }
  const isolatedRuntime = sidepanelScripts.find((script) => {
    const text = executableTextByPath.get(script);
    return REQUIRED_ISOLATED_SANDBOX_MARKERS.every(
      (marker) => hasJavaScriptStringMarker(text, marker),
    );
  });
  if (!isolatedRuntime) {
    throw new ArtifactError(
      `Extension artifact is missing isolated iframe sandbox/CSP markers: ${REQUIRED_ISOLATED_SANDBOX_MARKERS.join(', ')}`,
    );
  }
}

export async function compareArtifactDirectories(expectedDirectory, actualDirectory) {
  const expectedRoot = path.resolve(expectedDirectory);
  const actualRoot = path.resolve(actualDirectory);
  const [expectedEntries, actualEntries] = await Promise.all([
    collectEntries(expectedRoot, { rejectSymlinks: true }),
    collectEntries(actualRoot, { rejectSymlinks: true }),
  ]);
  const expected = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const actual = new Map(actualEntries.map((entry) => [entry.path, entry]));
  const allPaths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const differences = [];

  for (const relativePath of allPaths) {
    const expectedEntry = expected.get(relativePath);
    const actualEntry = actual.get(relativePath);
    if (!actualEntry) {
      differences.push({ kind: 'missing', path: relativePath });
      continue;
    }
    if (!expectedEntry) {
      differences.push({ kind: 'unexpected', path: relativePath });
      continue;
    }
    if (expectedEntry.type !== actualEntry.type) {
      differences.push({ kind: 'type-changed', path: relativePath });
      continue;
    }
    if (expectedEntry.type !== 'file') continue;

    const [expectedBytes, actualBytes] = await Promise.all([
      readFile(path.join(expectedRoot, ...relativePath.split('/'))),
      readFile(path.join(actualRoot, ...relativePath.split('/'))),
    ]);
    if (!expectedBytes.equals(actualBytes)) {
      differences.push({ kind: 'byte-changed', path: relativePath });
    }
  }

  return differences;
}

export async function checkArtifact({
  projectRoot = PROJECT_ROOT,
  buildArtifact = buildProductionArtifact,
} = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const committedDirectory = canonicalArtifactDirectory(resolvedRoot);

  return withTemporaryDirectory(async (temporaryRoot) => {
    let builtDirectory;
    try {
      builtDirectory = await buildArtifact({
        projectRoot: resolvedRoot,
        temporaryRoot,
      });
      await validateArtifact(builtDirectory);
    } catch (error) {
      throw new ArtifactError(
        [
          `Fresh production build is unsafe or invalid: ${errorMessage(error)}`,
          'Fix the source or build configuration. The committed release was not changed, and artifact sync will reject this build.',
        ].join('\n'),
        { cause: error },
      );
    }

    try {
      await validateArtifact(committedDirectory);
      const differences = await compareArtifactDirectories(
        builtDirectory,
        committedDirectory,
      );
      if (differences.length > 0) {
        throw new ArtifactError(
          [
            'Committed Chrome artifact differs from the production build:',
            ...formatDifferences(differences),
            'Run `npm run artifact:sync` to intentionally refresh it.',
          ].join('\n'),
        );
      }
    } catch (error) {
      if (
        error instanceof ArtifactError &&
        error.message.includes('artifact:sync')
      ) {
        throw error;
      }
      throw new ArtifactError(
        `${errorMessage(error)}\nRun \`npm run artifact:sync\` to intentionally refresh it.`,
        { cause: error },
      );
    }

    return { committedDirectory };
  });
}

export async function syncArtifact({
  projectRoot = PROJECT_ROOT,
  buildArtifact = buildProductionArtifact,
  validatePromotedArtifact = validateArtifact,
  removeBackup = removeDirectory,
} = {}) {
  const resolvedRoot = path.resolve(projectRoot);
  const target = canonicalArtifactDirectory(resolvedRoot);
  await assertCanonicalSyncTarget(target, resolvedRoot);

  return withTemporaryDirectory(async (temporaryRoot) => {
    const builtDirectory = await buildArtifact({
      projectRoot: resolvedRoot,
      temporaryRoot,
    });
    await validateArtifact(builtDirectory);
    await replaceCanonicalDirectory({
      projectRoot: resolvedRoot,
      sourceDirectory: builtDirectory,
      targetDirectory: target,
      validatePromotedArtifact,
      removeBackup,
    });
    return target;
  });
}

export async function assertCanonicalSyncTarget(
  targetDirectory,
  projectRoot = PROJECT_ROOT,
) {
  const root = path.resolve(projectRoot);
  const expected = canonicalArtifactDirectory(root);
  const target = path.resolve(targetDirectory);
  if (target !== expected) {
    throw new ArtifactError(
      `Refusing artifact sync outside exact target: ${expected}`,
    );
  }

  const dist = path.dirname(expected);
  if (path.dirname(dist) !== root || path.basename(dist) !== 'dist') {
    throw new ArtifactError('Canonical artifact parent failed its path guard.');
  }
  const distStat = await safeLstat(dist);
  if (distStat && (!distStat.isDirectory() || distStat.isSymbolicLink())) {
    throw new ArtifactError('Refusing artifact sync through a non-directory or symlinked dist path.');
  }
  const targetStat = await safeLstat(expected);
  if (targetStat && (!targetStat.isDirectory() || targetStat.isSymbolicLink())) {
    throw new ArtifactError('Refusing to replace a non-directory or symlinked canonical artifact.');
  }
  return expected;
}

async function replaceCanonicalDirectory({
  projectRoot,
  sourceDirectory,
  targetDirectory,
  validatePromotedArtifact,
  removeBackup,
}) {
  await assertCanonicalSyncTarget(targetDirectory, projectRoot);
  const distDirectory = path.dirname(targetDirectory);
  await mkdir(distDirectory, { recursive: true });

  const nonce = `${process.pid}-${randomUUID()}`;
  const stage = path.join(distDirectory, `.chrome-unpacked-stage-${nonce}`);
  const backup = path.join(distDirectory, `.chrome-unpacked-backup-${nonce}`);
  let backupPresent = false;
  let targetPromoted = false;
  let backupCleanupFailed = false;

  try {
    await cp(sourceDirectory, stage, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: false,
    });
    await validateArtifact(stage);

    if (await safeLstat(targetDirectory)) {
      await rename(targetDirectory, backup);
      backupPresent = true;
    }

    try {
      await rename(stage, targetDirectory);
      targetPromoted = true;
    } catch (error) {
      if (backupPresent && !(await safeLstat(targetDirectory))) {
        await rename(backup, targetDirectory);
        backupPresent = false;
      }
      throw new ArtifactError(
        'Artifact promotion failed; the previous release was restored.',
        { cause: error },
      );
    }

    try {
      await validatePromotedArtifact(targetDirectory);
    } catch (error) {
      await rm(targetDirectory, { recursive: true, force: true });
      targetPromoted = false;
      if (backupPresent) {
        await rename(backup, targetDirectory);
        backupPresent = false;
        throw new ArtifactError(
          'Promoted artifact failed validation; the previous release was restored.',
          { cause: error },
        );
      }
      throw new ArtifactError(
        'Promoted artifact failed validation and was removed; no previous release existed.',
        { cause: error },
      );
    }

    if (backupPresent) {
      try {
        await removeBackup(backup);
        backupPresent = false;
      } catch (error) {
        backupCleanupFailed = true;
        throw new ArtifactError(
          `The new validated release is active, but the previous-release backup could not be removed: ${backup}`,
          { cause: error },
        );
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
    if (backupPresent && !targetPromoted && !backupCleanupFailed) {
      await rm(backup, { recursive: true, force: true });
    }
  }
}

async function collectEntries(rootDirectory, { rejectSymlinks }) {
  const root = path.resolve(rootDirectory);
  const rootStat = await safeLstat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ArtifactError(`Directory cannot be inspected: ${root}`);
  }
  const entries = [];

  async function walk(absoluteDirectory, relativeDirectory) {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      const absolutePath = path.join(absoluteDirectory, child.name);
      const childStat = await lstat(absolutePath);
      if (childStat.isSymbolicLink()) {
        if (rejectSymlinks) {
          throw new ArtifactError(`Symlink is forbidden in artifact: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: 'symlink' });
      } else if (childStat.isDirectory()) {
        entries.push({ path: relativePath, type: 'directory' });
        await walk(absolutePath, relativePath);
      } else if (childStat.isFile()) {
        entries.push({ path: relativePath, type: 'file' });
      } else {
        throw new ArtifactError(`Unsupported filesystem entry in artifact: ${relativePath}`);
      }
    }
  }

  await walk(root, '');
  return entries;
}

function validateManifest(manifest, filePaths) {
  if (!isRecord(manifest) || manifest.manifest_version !== 3) {
    throw new ArtifactError('manifest.json must declare Manifest V3.');
  }
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new ArtifactError('manifest.json name must be a non-empty string.');
  }
  if (!isValidChromeExtensionVersion(manifest.version)) {
    throw new ArtifactError(
      'manifest.json version must contain 1-4 numeric components from 0 to 65535 without leading zeros.',
    );
  }
  const chromeVersion = manifest.minimum_chrome_version;
  const minimumVersion =
    typeof chromeVersion === 'string' && /^\d+(?:\.\d+){0,3}$/u.test(chromeVersion)
      ? Number(chromeVersion.split('.')[0])
      : Number.NaN;
  if (!Number.isFinite(minimumVersion) || minimumVersion < MINIMUM_CHROME_VERSION) {
    throw new ArtifactError(
      `manifest.json must require Chrome ${MINIMUM_CHROME_VERSION} or newer.`,
    );
  }

  const permissions = Array.isArray(manifest.permissions)
    ? manifest.permissions
    : [];
  const ocrEnabled = permissions.includes('offscreen');
  const approvedPermissions = ocrEnabled
    ? APPROVED_OCR_PERMISSIONS
    : APPROVED_PERMISSIONS;
  if (
    permissions.length !== approvedPermissions.length ||
    new Set(permissions).size !== approvedPermissions.length ||
    !approvedPermissions.every((permission) => permissions.includes(permission))
  ) {
    throw new ArtifactError(
      `manifest.json permissions must be exactly one approved profile: ${APPROVED_PERMISSIONS.join(', ')} or ${APPROVED_OCR_PERMISSIONS.join(', ')}.`,
    );
  }
  const optionalHostPermissions = Array.isArray(
    manifest.optional_host_permissions,
  )
    ? manifest.optional_host_permissions
    : [];
  if (
    optionalHostPermissions.length !==
      APPROVED_OPTIONAL_HOST_PERMISSIONS.length ||
    new Set(optionalHostPermissions).size !==
      APPROVED_OPTIONAL_HOST_PERMISSIONS.length ||
    !APPROVED_OPTIONAL_HOST_PERMISSIONS.every((permission) =>
      optionalHostPermissions.includes(permission),
    )
  ) {
    throw new ArtifactError(
      `manifest.json optional_host_permissions must be exactly: ${APPROVED_OPTIONAL_HOST_PERMISSIONS.join(', ')}.`,
    );
  }
  for (const field of ['host_permissions', 'optional_permissions']) {
    if (field in manifest) {
      throw new ArtifactError(`manifest.json must not contain ${field}.`);
    }
  }
  if ('content_scripts' in manifest) {
    throw new ArtifactError('Static content scripts are outside the approved release boundary.');
  }
  if (!isRecord(manifest.action)) {
    throw new ArtifactError('manifest.json is missing the direct toolbar action.');
  }
  if ('default_popup' in manifest.action) {
    throw new ArtifactError(
      'manifest.json toolbar action must launch the saved companion surface directly without a popup chooser.',
    );
  }

  const requiredReferences = [
    ['background.service_worker', manifest.background?.service_worker],
    ['side_panel.default_path', manifest.side_panel?.default_path],
  ];
  for (const [label, reference] of requiredReferences) {
    if (typeof reference !== 'string' || !reference) {
      throw new ArtifactError(`manifest.json is missing ${label}.`);
    }
    assertReferenceExists('manifest.json', reference, filePaths);
  }

  if (ocrEnabled) {
    if (!filePaths.has('offscreen.html')) {
      throw new ArtifactError(
        'The OCR profile requires the packaged offscreen.html compute host.',
      );
    }
  }

  for (const reference of collectManifestReferences(manifest)) {
    assertReferenceExists('manifest.json', reference, filePaths);
  }
  return ocrEnabled;
}

function normalizeBuildOcrProviderIds(providerIds) {
  if (!Array.isArray(providerIds)) {
    throw new ArtifactError('ocrProviderIds must be an array of implemented provider IDs.');
  }
  if (new Set(providerIds).size !== providerIds.length) {
    throw new ArtifactError('ocrProviderIds must not contain duplicate provider IDs.');
  }
  for (const providerId of providerIds) {
    if (
      typeof providerId !== 'string' ||
      !IMPLEMENTED_OCR_PROVIDER_IDS.includes(providerId)
    ) {
      throw new ArtifactError(
        `Unknown or unimplemented OCR provider ID: ${String(providerId)}.`,
      );
    }
  }
  return Object.freeze(
    IMPLEMENTED_OCR_PROVIDER_IDS.filter((providerId) =>
      providerIds.includes(providerId),
    ),
  );
}

function detectOcrRuntimeProfile(executableTextByPath, filePaths) {
  const offscreenResources = collectStaticJavaScriptModuleClosure(
    'offscreen.html',
    executableTextByPath,
    filePaths,
  );
  assertOcrRuntimeMarkers(
    offscreenResources,
    executableTextByPath,
    REQUIRED_OCR_HOST_RUNTIME_MARKERS,
  );

  const detected = [];
  for (const [providerId, markers] of [
    ['chrome-text-detector', REQUIRED_TEXT_DETECTOR_RUNTIME_MARKERS],
    ['tesseract', REQUIRED_TESSERACT_RUNTIME_MARKERS],
  ]) {
    const markerPresence = markers.map((marker) =>
      [...offscreenResources].some((modulePath) =>
        hasJavaScriptStringMarker(executableTextByPath.get(modulePath), marker),
      ),
    );
    // The protocol intentionally retains Tesseract's result-version literal in
    // every build. Asset path markers are the provider-specific anchors.
    const providerSpecificPresence = providerId === 'tesseract'
      ? markerPresence.slice(1)
      : markerPresence;
    if (
      providerSpecificPresence.some(Boolean) &&
      !markerPresence.every(Boolean)
    ) {
      throw new ArtifactError(
        `OCR compute host contains a partial ${providerId} runtime marker set.`,
      );
    }
    if (
      providerSpecificPresence.length > 0 &&
      providerSpecificPresence.every(Boolean) &&
      markerPresence.every(Boolean)
    ) {
      detected.push(providerId);
    }
  }
  if (detected.length === 0) {
    throw new ArtifactError(
      'OCR compute host does not contain an implemented provider runtime.',
    );
  }
  return Object.freeze(detected);
}

function validateOcrProfileManifest(manifest, providerIds) {
  const tesseractEnabled = providerIds.includes('tesseract');
  if (tesseractEnabled) {
    if (
      !isRecord(manifest.content_security_policy) ||
      Object.keys(manifest.content_security_policy).length !== 1 ||
      manifest.content_security_policy.extension_pages !== APPROVED_OCR_CSP
    ) {
      throw new ArtifactError(
        `The Tesseract OCR profile requires the exact extension page CSP: ${APPROVED_OCR_CSP}`,
      );
    }
    return;
  }
  if ('content_security_policy' in manifest) {
    throw new ArtifactError(
      providerIds.length > 0
        ? 'The asset-free OCR profile must use Chrome\'s default extension page CSP.'
        : 'manifest.json must not relax or override extension page CSP when OCR is disabled.',
    );
  }
}

async function validateManifestSemanticResources(root, manifest, filePaths) {
  const resources = [
    {
      path: manifest.background?.service_worker,
      type: 'javascript',
    },
    {
      path: manifest.side_panel?.default_path,
      type: 'html',
    },
  ];
  const scanned = new Set();

  for (const resource of resources) {
    const relativePath = assertReferenceExists(
      'manifest.json',
      resource.path,
      filePaths,
    );
    const scanKey = `${resource.type}:${relativePath}`;
    if (scanned.has(scanKey)) continue;
    scanned.add(scanKey);

    const text = await readFile(
      path.join(root, ...relativePath.split('/')),
      'utf8',
    );
    if (hasSourceMapDirective(text, resource.type === 'javascript')) {
      throw new ArtifactError(
        `Source map reference is forbidden in artifact file: ${relativePath}`,
      );
    }
    assertNoRemoteExecutableReference(relativePath, text);
    await validateTextReferences(
      root,
      relativePath,
      text,
      filePaths,
      resource.type,
    );
  }
}

function collectManifestReferences(manifest) {
  const references = [];
  const add = (value) => {
    if (typeof value === 'string') references.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (isRecord(value)) Object.values(value).forEach(add);
  };

  add(manifest.icons);
  add(manifest.action?.default_icon);
  add(manifest.chrome_url_overrides);
  add(manifest.options_page);
  add(manifest.options_ui?.page);
  add(manifest.devtools_page);
  add(manifest.sandbox?.pages);
  if (Array.isArray(manifest.web_accessible_resources)) {
    for (const resourceGroup of manifest.web_accessible_resources) {
      add(resourceGroup?.resources);
    }
  }
  return references;
}

function discoverHtmlResourceReferences(sourcePath, text) {
  let document;
  try {
    ({ document } = parseHTML(text));
  } catch (error) {
    throw new ArtifactError(`HTML resource cannot be parsed: ${sourcePath}`, {
      cause: error,
    });
  }

  const references = [];
  for (const element of document.querySelectorAll('[src]')) {
    references.push(element.getAttribute('src'));
  }
  for (const element of document.querySelectorAll('[srcset]')) {
    references.push(...parseSrcset(element.getAttribute('srcset') ?? ''));
  }
  for (const element of document.querySelectorAll('[poster]')) {
    references.push(element.getAttribute('poster'));
  }
  for (const element of document.querySelectorAll('object[data]')) {
    references.push(element.getAttribute('data'));
  }
  for (const link of document.querySelectorAll('link[href]')) {
    const relations = new Set(
      (link.getAttribute('rel') ?? '')
        .toLowerCase()
        .split(/\s+/u)
        .filter(Boolean),
    );
    if (
      ['icon', 'modulepreload', 'preload', 'stylesheet'].some((relation) =>
        relations.has(relation),
      )
    ) {
      references.push(link.getAttribute('href'));
    }
  }
  return references.filter(
    (reference) => typeof reference === 'string' && reference.length > 0,
  );
}

function discoverHtmlScriptReferences(sourcePath, text) {
  let document;
  try {
    ({ document } = parseHTML(text));
  } catch (error) {
    throw new ArtifactError(`HTML resource cannot be parsed: ${sourcePath}`, {
      cause: error,
    });
  }
  return [...document.querySelectorAll('script[src]')]
    .map((script) => script.getAttribute('src'))
    .filter((reference) =>
      typeof reference === 'string' && reference.length > 0,
    );
}

function parseSrcset(value) {
  const references = [];
  let position = 0;

  while (position < value.length) {
    while (position < value.length && /[\s,]/u.test(value[position])) {
      position += 1;
    }
    if (position >= value.length) break;

    const start = position;
    while (position < value.length && !/\s/u.test(value[position])) {
      position += 1;
    }
    let reference = value.slice(start, position);
    const trailingCommas = reference.match(/,+$/u)?.[0].length ?? 0;
    if (trailingCommas > 0) {
      reference = reference.slice(0, -trailingCommas);
    }
    if (reference) references.push(reference);

    if (trailingCommas === 0) {
      let parentheses = 0;
      while (position < value.length) {
        const character = value[position];
        if (character === '(') parentheses += 1;
        else if (character === ')' && parentheses > 0) parentheses -= 1;
        else if (character === ',' && parentheses === 0) {
          position += 1;
          break;
        }
        position += 1;
      }
    }
  }
  return references;
}

async function validateTextReferences(
  root,
  sourcePath,
  text,
  filePaths,
  semanticType,
) {
  const extension = path.posix.extname(sourcePath).toLowerCase();
  const resourceType =
    semanticType ??
    (extension === '.html' || extension === '.htm'
      ? 'html'
      : extension === '.css'
        ? 'css'
        : extension === '.js' || extension === '.mjs'
          ? 'javascript'
          : 'other');
  const references = [];
  if (resourceType === 'html') {
    references.push(...discoverHtmlResourceReferences(sourcePath, text));
  } else if (resourceType === 'css') {
    for (const match of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
      references.push(match[1]);
    }
    for (const match of text.matchAll(/@import\s*["']([^"']+)["']/giu)) {
      references.push(match[1]);
    }
  } else if (resourceType === 'javascript') {
    references.push(...discoverJavaScriptResourceReferences(text));
  }

  for (const reference of references) {
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) {
      continue;
    }
    assertReferenceExists(sourcePath, reference, filePaths);
  }

  // Keep the root parameter part of this boundary so callers cannot validate
  // a reference list detached from the directory they already inspected.
  if (!path.isAbsolute(root)) {
    throw new ArtifactError('Artifact reference validation requires an absolute root.');
  }
}

function discoverJavaScriptResourceReferences(text) {
  const references = [];
  const stack = [parseJavaScript(text)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      const reference = staticStringValue(node.source);
      if (reference !== undefined) references.push(reference);
    } else if (node.type === 'ImportExpression') {
      const reference = staticStringValue(node.source);
      if (reference !== undefined) references.push(reference);
    } else if (
      node.type === 'CallExpression' &&
      expressionName(node.callee) === 'importScripts'
    ) {
      for (const argument of node.arguments) {
        const reference = staticStringValue(argument);
        if (reference !== undefined) references.push(reference);
      }
    } else if (node.type === 'NewExpression') {
      const constructor = expressionName(node.callee);
      if (constructor === 'Worker' || constructor === 'SharedWorker') {
        const reference = staticUrlValue(node.arguments[0]);
        if (reference !== undefined) references.push(reference);
      } else if (constructor === 'URL') {
        const reference = staticStringValue(node.arguments[0]);
        if (reference !== undefined && reference !== '.' && reference !== './') {
          references.push(reference);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return references;
}

function discoverJavaScriptModuleReferences(text) {
  const references = [];
  const stack = [parseJavaScript(text)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration'
    ) {
      const reference = staticStringValue(node.source);
      if (reference !== undefined) references.push(reference);
    } else if (node.type === 'ImportExpression') {
      const reference = staticStringValue(node.source);
      if (reference !== undefined) references.push(reference);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return references;
}

function assertReferenceExists(sourcePath, rawReference, filePaths) {
  if (typeof rawReference !== 'string' || !rawReference) return;
  if (/^(?:https?:)?\/\//iu.test(rawReference)) {
    throw new ArtifactError(`Remote artifact reference is forbidden in ${sourcePath}: ${rawReference}`);
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(rawReference)) {
    throw new ArtifactError(`Non-local artifact reference is forbidden in ${sourcePath}: ${rawReference}`);
  }

  const withoutSuffix = rawReference.split(/[?#]/u, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch {
    throw new ArtifactError(`Invalid encoded artifact reference in ${sourcePath}: ${rawReference}`);
  }
  const sourceDirectory = path.posix.dirname(sourcePath);
  const resolved = decoded.startsWith('/')
    ? path.posix.normalize(decoded.slice(1))
    : path.posix.normalize(path.posix.join(sourceDirectory, decoded));
  if (
    !resolved ||
    resolved === '.' ||
    resolved === '..' ||
    resolved.startsWith('../') ||
    path.posix.isAbsolute(resolved)
  ) {
    throw new ArtifactError(`Artifact reference escapes its root in ${sourcePath}: ${rawReference}`);
  }
  if (!filePaths.has(resolved)) {
    throw new ArtifactError(`Referenced artifact file is missing: ${resolved} (from ${sourcePath})`);
  }
  return resolved;
}

function assertSafeArtifactFilename(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  const base = path.posix.basename(lowerPath);
  const segments = lowerPath.split('/');
  if (lowerPath.endsWith('.map')) {
    throw new ArtifactError(`Source map is forbidden in artifact: ${relativePath}`);
  }
  if (
    segments.some(
      (segment) => segment === '.env' || segment.startsWith('.env.'),
    ) ||
    segments.some(
      (segment) =>
        segment === '.npmrc' ||
        segment === '.envrc' ||
        /(?:^|\.)env(?:\.|$)/u.test(segment),
    ) ||
    /\.(?:jks|key|keystore|p12|pem|pfx)$/u.test(base) ||
    /(?:^|[-_.])(?:api[-_.]?keys?|auth[-_.]?tokens?|client[-_.]?secrets?|credentials?|id_ed25519|id_rsa|secrets?|service[-_.]?accounts?|tokens?)(?:[._-]|$)/u.test(
      base,
    )
  ) {
    throw new ArtifactError(`Secret or key file is forbidden in artifact: ${relativePath}`);
  }
}

function assertNoOcrRuntimeArtifact(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  const extension = path.posix.extname(lowerPath);
  if (lowerPath === 'ocr' || lowerPath.startsWith('ocr/')) {
    throw new ArtifactError(
      `OCR runtime asset is forbidden in the foundation artifact: ${relativePath}`,
    );
  }
  if (FORBIDDEN_MODEL_EXTENSIONS.has(extension)) {
    throw new ArtifactError(
      `OCR runtime or model asset is forbidden in the foundation artifact: ${relativePath}`,
    );
  }
  if (
    /(?:^|\/)offscreen(?:[._/-]|$)/u.test(lowerPath) ||
    /(?:^|\/)(?:models?|weights?|tessdata|ocr-models?|onnx-models?)(?:\/|$)/u.test(lowerPath) ||
    /^(?:worker|worker[-_.][a-z0-9_-]+|[a-z0-9_-]+[._-]worker(?:[-_.][a-z0-9_-]+)?)\.m?js$/u.test(
      path.posix.basename(lowerPath),
    ) ||
    /(?:ocr|tesseract|transformers|paddle|onnx|opencv|text-detector|screen-ai)[-_.].*worker|worker.*(?:ocr|tesseract|transformers|paddle|onnx|opencv|text-detector|screen-ai)/u.test(
      path.posix.basename(lowerPath),
    )
  ) {
    throw new ArtifactError(
      `OCR compute-host, Worker, or model artifact is forbidden in Checkpoint E: ${relativePath}`,
    );
  }
}

async function validateTesseractRuntimeAssets({
  root,
  files,
  filePaths,
  executableTextByPath,
  unpackedBytes,
  requiredRuntimeMarkers,
}) {
  if (unpackedBytes > MAX_UNPACKED_ARTIFACT_BYTES) {
    throw new ArtifactError(
      `OCR artifact is ${unpackedBytes} bytes; the approved maximum is ${MAX_UNPACKED_ARTIFACT_BYTES} bytes.`,
    );
  }

  const manifestPath = 'ocr/tesseract/asset-manifest.json';
  const noticesPath = 'ocr/THIRD_PARTY_NOTICES.md';
  for (const requiredPath of [manifestPath, noticesPath]) {
    if (!filePaths.has(requiredPath)) {
      throw new ArtifactError(`OCR artifact is missing required local asset: ${requiredPath}`);
    }
  }

  const artifactManifestBytes = await readFile(
    path.join(root, ...manifestPath.split('/')),
  );
  const approvedManifestBytes = await readFile(
    path.join(PROJECT_ROOT, 'vendor', 'ocr', 'tesseract', 'asset-manifest.json'),
  );
  if (!artifactManifestBytes.equals(approvedManifestBytes)) {
    throw new ArtifactError(
      'Packaged Tesseract asset manifest differs from the reviewed vendor manifest.',
    );
  }
  const artifactNoticesBytes = await readFile(
    path.join(root, ...noticesPath.split('/')),
  );
  const approvedNoticesBytes = await readFile(
    path.join(PROJECT_ROOT, 'vendor', 'ocr', 'THIRD_PARTY_NOTICES.md'),
  );
  if (
    artifactNoticesBytes.byteLength === 0 ||
    !artifactNoticesBytes.equals(approvedNoticesBytes)
  ) {
    throw new ArtifactError(
      'Packaged OCR third-party notices differ from the reviewed vendor notices.',
    );
  }

  let assetManifest;
  try {
    assetManifest = JSON.parse(artifactManifestBytes.toString('utf8'));
  } catch (error) {
    throw new ArtifactError('Packaged Tesseract asset manifest is invalid JSON.', {
      cause: error,
    });
  }
  if (
    assetManifest?.schemaVersion !== 1 ||
    assetManifest?.tesseractVersion !== APPROVED_OCR_PROVIDER_DEPENDENCIES['tesseract.js'] ||
    assetManifest?.tesseractCoreVersion !== APPROVED_OCR_PROVIDER_DEPENDENCIES['tesseract.js-core'] ||
    assetManifest?.tessdataFastCommit !== APPROVED_TESSDATA_FAST_COMMIT ||
    assetManifest?.preprocessingVersion !== 'visible-crop-v2' ||
    !sameOrderedStrings(
      assetManifest?.languageCodes,
      APPROVED_TESSERACT_LANGUAGE_CODES,
    ) ||
    !Array.isArray(assetManifest.files)
  ) {
    throw new ArtifactError('Packaged Tesseract asset manifest has unapproved metadata.');
  }
  assertApprovedTesseractAssetLayout(assetManifest.files);

  const approvedRuntimePaths = new Set([manifestPath, noticesPath]);
  let declaredBytes = 0;
  for (const asset of assetManifest.files) {
    if (
      !isRecord(asset) ||
      typeof asset.path !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(asset.path) ||
      asset.path.split('/').includes('..') ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 0 ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256)
    ) {
      throw new ArtifactError('Packaged Tesseract asset manifest contains an invalid entry.');
    }
    const relativePath = `ocr/tesseract/${asset.path}`;
    if (approvedRuntimePaths.has(relativePath)) {
      throw new ArtifactError(`Packaged Tesseract asset manifest repeats: ${relativePath}`);
    }
    approvedRuntimePaths.add(relativePath);
    if (!filePaths.has(relativePath)) {
      throw new ArtifactError(`OCR artifact is missing declared asset: ${relativePath}`);
    }
    const contents = await readFile(path.join(root, ...relativePath.split('/')));
    if (contents.byteLength !== asset.bytes) {
      throw new ArtifactError(`OCR asset byte count changed: ${relativePath}`);
    }
    const digest = createHash('sha256').update(contents).digest('hex');
    if (digest !== asset.sha256) {
      throw new ArtifactError(`OCR asset hash changed: ${relativePath}`);
    }
    declaredBytes += contents.byteLength;
  }
  if (
    declaredBytes !== assetManifest.totalBytes ||
    declaredBytes > MAX_UNPACKED_ARTIFACT_BYTES
  ) {
    throw new ArtifactError(
      `Tesseract asset budget mismatch: declared ${assetManifest.totalBytes}, measured ${declaredBytes}.`,
    );
  }

  for (const relativePath of filePaths) {
    if (relativePath.startsWith('ocr/') && !approvedRuntimePaths.has(relativePath)) {
      throw new ArtifactError(`Unapproved OCR runtime asset: ${relativePath}`);
    }
  }

  const offscreenResources = collectStaticJavaScriptModuleClosure(
    'offscreen.html',
    executableTextByPath,
    filePaths,
  );
  assertOcrRuntimeMarkers(
    offscreenResources,
    executableTextByPath,
    requiredRuntimeMarkers,
  );
  for (const entry of files) {
    if (
      entry.path === 'offscreen.html' ||
      offscreenResources.has(entry.path) ||
      approvedRuntimePaths.has(entry.path)
    ) {
      continue;
    }
    assertNoOcrRuntimeArtifact(entry.path);
  }

  const remoteRuntimePattern =
    /(?:cdn\.jsdelivr\.net|unpkg\.com)\/(?:npm\/)?(?:@tesseract\.js-data|tesseract\.js(?:-core)?)(?:@|\/)|raw\.githubusercontent\.com\/tesseract-ocr\/tessdata/iu;
  for (const [relativePath, text] of executableTextByPath) {
    if (remoteRuntimePattern.test(text)) {
      throw new ArtifactError(
        `Remote OCR runtime fallback found in artifact: ${relativePath}`,
      );
    }
  }
}

function validateAssetFreeOcrRuntime({
  files,
  filePaths,
  executableTextByPath,
  requiredRuntimeMarkers,
}) {
  const offscreenResources = collectStaticJavaScriptModuleClosure(
    'offscreen.html',
    executableTextByPath,
    filePaths,
  );
  assertOcrRuntimeMarkers(
    offscreenResources,
    executableTextByPath,
    requiredRuntimeMarkers,
  );
  for (const entry of files) {
    if (entry.path === 'offscreen.html' || offscreenResources.has(entry.path)) {
      continue;
    }
    assertNoOcrRuntimeArtifact(entry.path);
  }
}

function assertApprovedTesseractAssetLayout(files) {
  const expected = [
    ...APPROVED_TESSERACT_CORE_PATHS.map((assetPath) => ({
      path: assetPath,
      role: 'wasm-core-loader',
      source: `npm:tesseract.js-core@7.0.0/${path.posix.basename(assetPath)}`,
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
  if (
    files.length !== expected.length ||
    !expected.every((approved, index) => {
      const candidate = files[index];
      return isRecord(candidate) &&
        candidate.path === approved.path &&
        candidate.role === approved.role &&
        candidate.source === approved.source;
    })
  ) {
    throw new ArtifactError(
      'Packaged Tesseract asset manifest has an unapproved path, role, source, or ordering.',
    );
  }
}

function collectStaticJavaScriptModuleClosure(
  htmlPath,
  executableTextByPath,
  filePaths,
) {
  const htmlText = executableTextByPath.get(htmlPath);
  if (typeof htmlText !== 'string') {
    throw new ArtifactError(`OCR compute host is unreadable: ${htmlPath}`);
  }
  const pending = discoverHtmlScriptReferences(htmlPath, htmlText).map(
    (reference) => assertReferenceExists(htmlPath, reference, filePaths),
  ).filter((reference) => /\.m?js$/iu.test(reference));
  if (pending.length === 0) {
    throw new ArtifactError(
      'OCR compute host must load at least one local JavaScript module.',
    );
  }

  const closure = new Set();
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (closure.has(modulePath)) continue;
    const moduleText = executableTextByPath.get(modulePath);
    if (typeof moduleText !== 'string') {
      throw new ArtifactError(`OCR compute host module is unreadable: ${modulePath}`);
    }
    closure.add(modulePath);
    for (const reference of discoverJavaScriptModuleReferences(moduleText)) {
      const importedPath = assertReferenceExists(
        modulePath,
        reference,
        filePaths,
      );
      if (/\.m?js$/iu.test(importedPath) && !closure.has(importedPath)) {
        pending.push(importedPath);
      }
    }
  }
  return closure;
}

function assertOcrRuntimeMarkers(
  modulePaths,
  executableTextByPath,
  markers = REQUIRED_OCR_RUNTIME_MARKERS,
) {
  for (const marker of markers) {
    const present = [...modulePaths].some((modulePath) =>
      hasJavaScriptStringMarker(executableTextByPath.get(modulePath), marker),
    );
    if (!present) {
      throw new ArtifactError(
        `OCR compute host is missing required immutable runtime marker: ${marker}`,
      );
    }
  }
}

function sameOrderedStrings(candidate, approved) {
  return Array.isArray(candidate) &&
    candidate.length === approved.length &&
    approved.every((value, index) => candidate[index] === value);
}

export async function assertOcrProviderDependenciesApproved(
  projectRoot = PROJECT_ROOT,
) {
  const root = path.resolve(projectRoot);
  const packagePath = path.join(root, 'package.json');
  const lockPath = path.join(root, 'package-lock.json');
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  } catch (error) {
    throw new ArtifactError('package.json is missing or invalid.', { cause: error });
  }
  const directDependencies = isRecord(packageJson?.dependencies)
    ? packageJson.dependencies
    : {};
  for (const [name, version] of Object.entries(
    APPROVED_OCR_PROVIDER_DEPENDENCIES,
  )) {
    if (directDependencies[name] !== version) {
      throw new ArtifactError(
        `Approved OCR provider dependency must be pinned exactly: ${name}@${version}.`,
      );
    }
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = packageJson?.[field];
    if (!isRecord(dependencies)) continue;
    if (field !== 'dependencies') {
      for (const name of Object.keys(APPROVED_OCR_PROVIDER_DEPENDENCIES)) {
        if (name in dependencies) {
          throw new ArtifactError(
            `Approved OCR provider dependency must be a production dependency: ${name}.`,
          );
        }
      }
    }
    assertDependencyRecordAbsent(
      dependencies,
      `package.json ${field}`,
      'OCR provider dependency is forbidden before its approved provider checkpoint',
    );
  }

  let lockJson;
  try {
    lockJson = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    throw new ArtifactError('package-lock.json is missing or invalid.', { cause: error });
  }
  const packages = isRecord(lockJson?.packages) ? lockJson.packages : {};
  const lockRootDependencies = isRecord(packages['']?.dependencies)
    ? packages[''].dependencies
    : {};
  for (const [name, version] of Object.entries(
    APPROVED_OCR_PROVIDER_DEPENDENCIES,
  )) {
    if (
      lockRootDependencies[name] !== version ||
      packages[`node_modules/${name}`]?.version !== version
    ) {
      throw new ArtifactError(
        `package-lock.json must pin the approved OCR provider exactly: ${name}@${version}.`,
      );
    }
  }
  for (const [packagePath, metadata] of Object.entries(packages)) {
    const pathDependency = forbiddenDependencyFromPackagePath(packagePath);
    if (pathDependency) throwLockDependencyError(pathDependency);
    if (!isRecord(metadata)) continue;
    const metadataDependency = forbiddenDependencyName(metadata.name);
    if (metadataDependency) throwLockDependencyError(metadataDependency);
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
      'requires',
    ]) {
      if (!isRecord(metadata[field])) continue;
      assertDependencyRecordAbsent(
        metadata[field],
        `package-lock.json packages.${packagePath}.${field}`,
        'OCR provider dependency leaked into package-lock.json before approval',
      );
    }
  }
  inspectLegacyLockDependencies(lockJson?.dependencies);
}

function assertDependencyRecordAbsent(dependencies, context, prefix) {
  for (const [name, specifier] of Object.entries(dependencies)) {
    const forbidden = forbiddenDependencyName(name) ??
      forbiddenDependencyFromAlias(specifier);
    if (forbidden) {
      throw new ArtifactError(`${prefix}: ${forbidden} (${context})`);
    }
    const approvedAlias = dependencyFromAlias(
      specifier,
      Object.keys(APPROVED_OCR_PROVIDER_DEPENDENCIES),
    );
    if (approvedAlias && name !== approvedAlias) {
      throw new ArtifactError(
        `Approved OCR provider dependency cannot be aliased: ${approvedAlias} (${context}).`,
      );
    }
  }
}

function inspectLegacyLockDependencies(dependencies) {
  if (!isRecord(dependencies)) return;
  for (const [name, metadata] of Object.entries(dependencies)) {
    const forbidden = forbiddenDependencyName(name);
    if (forbidden) throwLockDependencyError(forbidden);
    if (!isRecord(metadata)) continue;
    const aliased = forbiddenDependencyFromAlias(metadata.version) ??
      forbiddenDependencyName(metadata.name);
    if (aliased) throwLockDependencyError(aliased);
    for (const field of [
      'requires',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      if (!isRecord(metadata[field])) continue;
      assertDependencyRecordAbsent(
        metadata[field],
        `package-lock.json dependencies.${name}.${field}`,
        'OCR provider dependency leaked into package-lock.json before approval',
      );
    }
    inspectLegacyLockDependencies(metadata.dependencies);
  }
}

function forbiddenDependencyFromPackagePath(packagePath) {
  if (typeof packagePath !== 'string') return undefined;
  const normalized = packagePath.replaceAll('\\', '/').replace(/^\.\//u, '');
  for (const dependency of FORBIDDEN_OCR_FOUNDATION_DEPENDENCIES) {
    const marker = `node_modules/${dependency}`;
    if (normalized === marker || normalized.endsWith(`/${marker}`)) {
      return dependency;
    }
  }
  return undefined;
}

function forbiddenDependencyFromAlias(specifier) {
  return dependencyFromAlias(specifier, FORBIDDEN_OCR_FOUNDATION_DEPENDENCIES);
}

function dependencyFromAlias(specifier, dependencies) {
  if (typeof specifier !== 'string' || !specifier.startsWith('npm:')) {
    return undefined;
  }
  const alias = specifier.slice(4);
  const name = alias.startsWith('@')
    ? alias.match(/^(@[^/]+\/[^@]+)(?:@|$)/u)?.[1]
    : alias.match(/^([^@]+)(?:@|$)/u)?.[1];
  return dependencies.includes(name) ? name : undefined;
}

function forbiddenDependencyName(name) {
  return typeof name === 'string' &&
    FORBIDDEN_OCR_FOUNDATION_DEPENDENCIES.includes(name)
    ? name
    : undefined;
}

function throwLockDependencyError(name) {
  throw new ArtifactError(
    `OCR provider dependency leaked into package-lock.json before approval: ${name}`,
  );
}

function assertNoSecretContent(relativePath, contents) {
  const text = contents.toString('utf8');
  for (const pattern of SECRET_CONTENT_PATTERNS) {
    if (pattern.test(text)) {
      throw new ArtifactError(`Possible credential material found in artifact: ${relativePath}`);
    }
  }
}

function assertNoRemoteExecutableReference(relativePath, text) {
  const patterns = [
    /<script\b[^>]*\bsrc\s*=\s*["'`]\s*(?:https?:)?\/\//iu,
    /\bimport\s*["'`]\s*(?:https?:)?\/\//iu,
    /\b(?:import|importScripts)\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    /\bfrom\s*["'`]\s*(?:https?:)?\/\//iu,
    /\b(?:SharedWorker|Worker)\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    /\bnew\s+URL\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    /\b(?:eval|Function)\s*\(\s*["'`][^"'`]*(?:https?:)?\/\//iu,
    /\bfetch\s*\(\s*["'`]\s*(?:https?:)?\/\//iu,
    /\b(?:src|href)\s*=\s*["'`]\s*(?:https?:)?\/\//iu,
  ];
  if (
    patterns.some((pattern) => pattern.test(text)) ||
    (/\.m?js$/iu.test(relativePath) && hasRemoteExecutableSyntax(text))
  ) {
    throw new ArtifactError(`Remote executable code reference found in artifact: ${relativePath}`);
  }
}

function hasSourceMapDirective(text, parseAsJavaScript = false) {
  const embeddedLineDirective =
    /(?:^|\r?\n)[\t ]*\/\/[#@][\t ]*sourceMappingURL[\t ]*=/u.test(text);
  if (parseAsJavaScript) {
    const comments = [];
    parseJavaScript(text, comments);
    if (
      comments.some((comment) =>
        /^[\t ]*[#@][\t ]*sourceMappingURL[\t ]*=/u.test(comment.value),
      )
    ) return true;
    // rrweb embeds canvas Worker source as a multiline JavaScript string. A
    // line directive inside that string would become active if the Worker
    // were ever enabled, so retain this deliberately narrow raw check.
    return embeddedLineDirective;
  }

  // CSS directives are comments in their own grammar, not JavaScript comments.
  return (
    /\/\*[#@][\t ]*sourceMappingURL[\t ]*=/u.test(text) ||
    embeddedLineDirective
  );
}

function hasRemoteExecutableSyntax(text) {
  const source = parseJavaScript(text);
  const stack = [source];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }

    if (isRemoteExecutableNode(node)) return true;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return false;
}

function isRemoteExecutableNode(node) {
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportNamedDeclaration' ||
      node.type === 'ExportAllDeclaration') &&
    isRemoteReference(staticStringValue(node.source))
  ) return true;

  if (
    node.type === 'ImportExpression' &&
    isRemoteReference(staticUrlValue(node.source))
  ) return true;

  if (node.type === 'CallExpression') {
    const callee = expressionName(node.callee);
    const first = staticUrlValue(node.arguments[0]);
    if (
      (callee === 'fetch' || callee === 'importScripts') &&
      isRemoteReference(first)
    ) return true;
    if (
      (callee === 'eval' || callee === 'Function') &&
      containsRemoteReference(staticStringValue(node.arguments[0]))
    ) return true;
    if (callee === 'URL' && isRemoteReference(staticUrlConstructorValue(node.arguments))) {
      return true;
    }
    if (callee === 'setAttribute' || callee === 'setAttributeNS') {
      const nameIndex = callee === 'setAttribute' ? 0 : 1;
      const valueIndex = callee === 'setAttribute' ? 1 : 2;
      const attribute = staticStringValue(node.arguments[nameIndex])?.toLowerCase();
      if (
        isExecutableUrlAttribute(attribute) &&
        isRemoteReference(staticUrlValue(node.arguments[valueIndex]))
      ) return true;
    }
  }

  if (node.type === 'NewExpression') {
    const constructor = expressionName(node.callee);
    if (
      constructor === 'Function' &&
      node.arguments.some((argument) =>
        containsRemoteReference(staticStringValue(argument)),
      )
    ) return true;
    if (
      (constructor === 'Worker' || constructor === 'SharedWorker') &&
      isRemoteReference(staticUrlValue(node.arguments[0]))
    ) return true;
    if (
      constructor === 'URL' &&
      isRemoteReference(staticUrlConstructorValue(node.arguments))
    ) return true;
  }

  if (
    node.type === 'AssignmentExpression' &&
    isExecutableUrlAttribute(memberPropertyName(node.left)?.toLowerCase()) &&
    isRemoteReference(staticUrlValue(node.right))
  ) return true;

  return false;
}

function hasJavaScriptStringMarker(text, marker) {
  if (typeof text !== 'string') return false;
  const stack = [parseJavaScript(text)];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (
      node.type === 'Literal' &&
      typeof node.value === 'string' &&
      node.value.includes(marker)
    ) return true;
    if (
      node.type === 'TemplateLiteral' &&
      staticStringValue(node)?.includes(marker)
    ) return true;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return false;
}

function parseJavaScript(text, comments) {
  return parse(text, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    allowHashBang: true,
    ...(comments ? { onComment: comments } : {}),
  });
}

function staticUrlValue(node) {
  if (
    node &&
    (node.type === 'NewExpression' || node.type === 'CallExpression') &&
    expressionName(node.callee) === 'URL'
  ) return staticUrlConstructorValue(node.arguments);
  return staticStringValue(node);
}

function staticUrlConstructorValue(argumentsList = []) {
  const reference = staticStringValue(argumentsList[0]);
  const base = staticStringValue(argumentsList[1]);
  if (reference === undefined || base === undefined) return reference;
  try {
    return new URL(reference, base).href;
  } catch {
    return reference;
  }
}

function staticStringValue(node) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'ParenthesizedExpression' || node.type === 'ChainExpression') {
    return staticStringValue(node.expression);
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node.type === 'TemplateLiteral') {
    let value = '';
    for (let index = 0; index < node.quasis.length; index += 1) {
      value += node.quasis[index].value.cooked ?? node.quasis[index].value.raw;
      if (index >= node.expressions.length) continue;
      const expression = staticStringValue(node.expressions[index]);
      if (expression === undefined) return undefined;
      value += expression;
    }
    return value;
  }
  return undefined;
}

function expressionName(node) {
  if (node?.type === 'Identifier') return node.name;
  return memberPropertyName(node);
}

function memberPropertyName(node) {
  if (node?.type !== 'MemberExpression') return undefined;
  if (!node.computed && node.property.type === 'Identifier') {
    return node.property.name;
  }
  return staticStringValue(node.property);
}

function isExecutableUrlAttribute(value) {
  return value === 'src' || value === 'href' || value?.endsWith(':href');
}

function isRemoteReference(value) {
  return typeof value === 'string' && /^(?:https?:)?\/\//iu.test(value.trim());
}

function containsRemoteReference(value) {
  return typeof value === 'string' && /(?:https?:)?\/\//iu.test(value);
}

function formatDifferences(differences) {
  const labels = {
    missing: 'missing',
    unexpected: 'unexpected',
    'type-changed': 'type changed',
    'byte-changed': 'content changed',
  };
  return differences.map(
    (difference) => `- ${labels[difference.kind] ?? difference.kind}: ${difference.path}`,
  );
}

async function withTemporaryDirectory(callback) {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), 'simul-extension-artifact-'),
  );
  try {
    return await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function runProcess(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new ArtifactError(
            `Production extension build failed${signal ? ` (${signal})` : ` (exit ${code ?? 'unknown'})`}.`,
          ),
        );
      }
    });
  });
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidChromeExtensionVersion(value) {
  if (typeof value !== 'string') return false;
  const components = value.split('.');
  return (
    components.length >= 1 &&
    components.length <= 4 &&
    components.some((component) => Number(component) !== 0) &&
    components.every(
      (component) =>
        /^(?:0|[1-9]\d*)$/u.test(component) && Number(component) <= 65_535,
    )
  );
}

function errorMessage(error) {
  return error instanceof Error && error.message
    ? error.message
    : 'Unknown artifact verification error.';
}

async function main() {
  const command = process.argv[2];
  if (command === 'check') {
    const { committedDirectory } = await checkArtifact();
    console.log(`Verified committed Chrome artifact: ${committedDirectory}`);
    return;
  }
  if (command === 'sync') {
    const target = await syncArtifact();
    console.log(`Synchronized validated Chrome artifact: ${target}`);
    return;
  }
  throw new ArtifactError(
    'Usage: node tools/extension-artifact.mjs <check|sync>',
  );
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Artifact error: ${errorMessage(error)}`);
    process.exitCode = 1;
  });
}
