import { parse, type Comment } from 'acorn';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'wxt';
import {
  createOcrBuildProfilePlugin,
  readOcrBuildProfile,
} from './tools/ocr-build-profile';

const ocrBuildProfile = readOcrBuildProfile(process.env);
const betaBuildSuffix = 'beta v.20260828.1';
const tesseractEnabled = ocrBuildProfile.enabledProviderIds.includes('tesseract');
const offscreenOcrEnabled = ocrBuildProfile.enabledProviderIds.some((id) =>
  id === 'tesseract' || id === 'chrome-text-detector',
);
const privilegedOcrCsp =
  "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';";
const selectedEntrypoints = Object.freeze([
  'background',
  ...(offscreenOcrEnabled ? ['offscreen'] : []),
  'page-mirror',
  'sidepanel',
]);
const releaseLegalFiles = Object.freeze([
  { source: new URL('./LICENSE', import.meta.url), fileName: 'LICENSE' },
  {
    source: new URL('./THIRD_PARTY_NOTICES.md', import.meta.url),
    fileName: 'THIRD_PARTY_NOTICES.md',
  },
]);
const selectedOcrAssets = Object.freeze([
  ...(tesseractEnabled
    ? [
        ...collectFiles(
          new URL('./vendor/ocr/tesseract/', import.meta.url),
          'ocr/tesseract',
        ),
        {
          source: new URL('./vendor/ocr/THIRD_PARTY_NOTICES.md', import.meta.url),
          fileName: 'ocr/THIRD_PARTY_NOTICES.md',
        },
      ]
    : []),
]);

function collectFiles(
  directory: URL,
  outputPrefix: string,
): Array<{ readonly source: URL; readonly fileName: string }> {
  const root = resolve(fileURLToPath(directory));
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const sourcePath = resolve(entry.parentPath, entry.name);
      return {
        source: pathToFileURL(sourcePath),
        fileName: `${outputPrefix}/${relative(root, sourcePath).replaceAll('\\', '/')}`,
      };
    });
}

function stripSourceMapDirectives(code: string): string {
  const comments: Comment[] = [];
  parse(code, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    onComment: comments,
  });
  const ranges = comments
    .filter((comment) => /^[#@][\t ]*sourceMappingURL[\t ]*=/u.test(comment.value))
    .map((comment) => ({ start: comment.start, end: comment.end }));
  let stripped = code;
  for (const range of ranges.reverse()) {
    const whitespace = stripped
      .slice(range.start, range.end)
      .replace(/[^\r\n]/gu, ' ');
    stripped = stripped.slice(0, range.start) + whitespace + stripped.slice(range.end);
  }
  return stripped.replace(
    /(^|\r?\n)[\t ]*\/\/[#@][\t ]*sourceMappingURL[\t ]*=[^\r\n]*/gu,
    '$1',
  );
}

function removeRemoteTesseractFallbacks(code: string): string {
  return code
    .replaceAll(
      'https://cdn.jsdelivr.net/npm/tesseract.js@v',
      '__SIMUL_LOCAL_WORKER_REQUIRED__',
    )
    .replaceAll(
      'https://cdn.jsdelivr.net/npm/tesseract.js-core@v',
      '__SIMUL_LOCAL_CORE_REQUIRED__',
    )
    .replaceAll(
      'https://cdn.jsdelivr.net/npm/@tesseract.js-data/',
      '__SIMUL_LOCAL_LANG_REQUIRED__/',
    );
}

export default defineConfig({
  outDir: process.env.SIMUL_WXT_OUT_DIR || '.output',
  publicDir: 'public',
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      manifest.version_name = `${manifest.version} ${betaBuildSuffix}`;
      // The toolbar action launches the saved surface directly. Retaining a
      // default popup would suppress action.onClicked and reintroduce a
      // two-button chooser before every detached-window launch.
      if (manifest.action) delete manifest.action.default_popup;
    },
  },
  filterEntrypoints: [...selectedEntrypoints],
  vite: () => ({
    build: {
      target: 'chrome138',
      cssTarget: 'chrome138',
    },
    esbuild: {
      legalComments: 'none',
    },
    plugins: [
      createOcrBuildProfilePlugin(process.env),
      {
        name: 'simul-release-legal-files',
        generateBundle() {
          for (const legalFile of [
            ...releaseLegalFiles,
            ...selectedOcrAssets,
          ]) {
            this.emitFile({
              type: 'asset',
              fileName: legalFile.fileName,
              source: readFileSync(legalFile.source),
            });
          }
        },
      },
      {
        name: 'simul-strip-vendored-worker-sourcemap-directives',
        enforce: 'post',
        renderChunk(code) {
          // Vendored workers can contain raw source-map directives. The
          // installable artifact must not retain them, including in strings.
          const stripped = removeRemoteTesseractFallbacks(
            stripSourceMapDirectives(code),
          );
          return stripped === code ? null : { code: stripped, map: null };
        },
        generateBundle(_options, bundle) {
          // Vite's inline-worker plugin can append the worker source after
          // renderChunk, so enforce the same release invariant on final chunks.
          for (const artifact of Object.values(bundle)) {
            if (artifact.type !== 'chunk') continue;
            artifact.code = removeRemoteTesseractFallbacks(
              stripSourceMapDirectives(artifact.code),
            );
          }
        },
      },
    ],
  }),
  manifest: {
    name: 'Simul',
    description:
      'Follow a page in a live read-only mirror and translate it on-device in Chrome.',
    minimum_chrome_version: '138',
    action: {
      default_title: 'Simul',
    },
    permissions: [
      'activeTab',
      'scripting',
      'sidePanel',
      'storage',
      ...(offscreenOcrEnabled ? ['offscreen' as const] : []),
    ],
    optional_host_permissions: ['<all_urls>'],
    ...(tesseractEnabled
      ? {
          content_security_policy: {
            extension_pages: privilegedOcrCsp,
          },
        }
      : {}),
  },
});
