import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
export const APPROVED_OPTIONAL_HOST_PERMISSIONS = Object.freeze([
  'http://*/*',
  'https://*/*',
]);
export const MINIMUM_CHROME_VERSION = 138;
export const REQUIRED_UNLISTED_BUNDLES = Object.freeze([
  'page-recorder.js',
]);
export const REQUIRED_REPLICA_RUNTIME_MARKERS = Object.freeze([
  'simul:replica-v2:capture-checkpoint',
  'rrweb-shadow-v2',
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
} = {}) {
  if (!temporaryRoot) {
    throw new ArtifactError('A temporary build root is required.');
  }

  const resolvedRoot = path.resolve(projectRoot);
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

  for (const entry of files) {
    assertSafeArtifactFilename(entry.path);
    const absolutePath = path.join(root, ...entry.path.split('/'));
    const extension = path.posix.extname(entry.path).toLowerCase();
    const contents = await readFile(absolutePath);
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
  validateManifest(manifest, filePaths);
  await validateManifestSemanticResources(root, manifest, filePaths);

  return {
    directory: root,
    files: [...filePaths].sort(),
    manifest,
  };
}

function assertReplicaRuntimeMarkers(executableTextByPath, filePaths) {
  const [captureMarker, replayMarker] = REQUIRED_REPLICA_RUNTIME_MARKERS;
  const recorderText = executableTextByPath.get(REQUIRED_UNLISTED_BUNDLES[0]);
  if (!recorderText || !hasJavaScriptStringMarker(recorderText, captureMarker)) {
    throw new ArtifactError(
      `Extension artifact is missing required local replica runtime marker: ${captureMarker}`,
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
    !sidepanelScripts.some((script) =>
      hasJavaScriptStringMarker(
        executableTextByPath.get(script),
        replayMarker,
      ),
    )
  ) {
    throw new ArtifactError(
      `Extension artifact is missing required local replica runtime marker: ${replayMarker}`,
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
  if (
    permissions.length !== APPROVED_PERMISSIONS.length ||
    new Set(permissions).size !== APPROVED_PERMISSIONS.length ||
    !APPROVED_PERMISSIONS.every((permission) => permissions.includes(permission))
  ) {
    throw new ArtifactError(
      `manifest.json permissions must be exactly: ${APPROVED_PERMISSIONS.join(', ')}.`,
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

  const requiredReferences = [
    ['background.service_worker', manifest.background?.service_worker],
    ['action.default_popup', manifest.action?.default_popup],
    ['side_panel.default_path', manifest.side_panel?.default_path],
  ];
  for (const [label, reference] of requiredReferences) {
    if (typeof reference !== 'string' || !reference) {
      throw new ArtifactError(`manifest.json is missing ${label}.`);
    }
    assertReferenceExists('manifest.json', reference, filePaths);
  }

  const extensionCsp = manifest.content_security_policy?.extension_pages;
  if (
    typeof extensionCsp === 'string' &&
    (/https?:/iu.test(extensionCsp) || /'unsafe-eval'/iu.test(extensionCsp))
  ) {
    throw new ArtifactError('manifest.json contains unsafe extension page CSP.');
  }

  for (const reference of collectManifestReferences(manifest)) {
    assertReferenceExists('manifest.json', reference, filePaths);
  }
}

async function validateManifestSemanticResources(root, manifest, filePaths) {
  const resources = [
    {
      path: manifest.background?.service_worker,
      type: 'javascript',
    },
    {
      path: manifest.action?.default_popup,
      type: 'html',
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
    const importPatterns = [
      /\bfrom\s*["']([^"']+)["']/gu,
      /\bimport\s*["']([^"']+)["']/gu,
      /\bimport\s*\(\s*["']([^"']+)["']/gu,
      /\bimportScripts\s*\(\s*["']([^"']+)["']/gu,
      /\b(?:SharedWorker|Worker)\s*\(\s*["']([^"']+)["']/gu,
      /\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url/gu,
    ];
    for (const pattern of importPatterns) {
      for (const match of text.matchAll(pattern)) references.push(match[1]);
    }
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
