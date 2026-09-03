import { readdirSync } from 'node:fs';
import path from 'node:path';

import { parse, type Comment } from 'acorn';
import { defineConfig } from 'wxt';
import {
  createOcrBuildProfilePlugin,
  readOcrBuildProfile,
} from './tools/ocr-build-profile';

const ocrBuildProfile = readOcrBuildProfile(process.env);
const tesseractEnabled = ocrBuildProfile.enabledProviderIds.includes('tesseract');
const offscreenOcrEnabled = ocrBuildProfile.enabledProviderIds.some((id) =>
  id === 'tesseract' || id === 'chrome-text-detector',
);
// The experimental rrweb engine is an explicit opt-in. Release builds omit
// its recorder bundle and, through the define below, its replay library.
const rrwebEnabled = process.env.WXT_SIMUL_RRWEB_SHADOW === '1';

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
  // rrweb also packages an executable canvas Worker as a multiline string.
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

/** Every file under vendor/ocr, as WXT public-asset copy entries. */
function vendoredOcrPublicFiles(): Array<{ absoluteSrc: string; relativeDest: string }> {
  const root = path.resolve(import.meta.dirname, 'vendor', 'ocr');
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const absoluteSrc = path.join(entry.parentPath, entry.name);
      return {
        absoluteSrc,
        relativeDest: path.posix.join(
          'ocr',
          path.relative(root, absoluteSrc).split(path.sep).join('/'),
        ),
      };
    });
}

export default defineConfig({
  outDir: process.env.SIMUL_WXT_OUT_DIR || '.output',
  // public/ always ships (icons live there). The vendored OCR runtime is
  // added through the public-assets hook only for Tesseract-enabled builds,
  // instead of swapping the whole public directory and losing its contents.
  publicDir: 'public',
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      // The toolbar action launches the saved surface directly. Retaining a
      // default popup would suppress action.onClicked and reintroduce a
      // two-button chooser before every detached-window launch.
      if (manifest.action) delete manifest.action.default_popup;
    },
    'build:publicAssets': (_wxt, files) => {
      if (tesseractEnabled) files.push(...vendoredOcrPublicFiles());
    },
  },
  // Every entrypoint is listed explicitly so optional runtimes stay out of a
  // build that did not opt into them.
  filterEntrypoints: [
    'background',
    'page-live-observer',
    'page-mirror',
    'page-snapshot',
    'sidepanel',
    ...(offscreenOcrEnabled ? ['offscreen'] : []),
    ...(rrwebEnabled ? ['page-recorder'] : []),
  ],
  vite: () => ({
    define: {
      // Pinned from the same decision as filterEntrypoints so the side panel
      // can never believe rrweb is compiled while its recorder is absent.
      'import.meta.env.WXT_SIMUL_RRWEB_SHADOW': JSON.stringify(
        rrwebEnabled ? '1' : '0',
      ),
    },
    plugins: [
      createOcrBuildProfilePlugin(process.env),
      {
        name: 'simul-strip-vendored-worker-sourcemap-directives',
        enforce: 'post',
        renderChunk(code) {
          // rrweb ships an inline canvas-worker source string containing a
          // sourceMappingURL comment. Canvas recording is disabled, but the
          // installable artifact must not retain even an unreachable map
          // reference. WXT itself already builds without source maps.
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
            extension_pages:
              "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';",
          },
        }
      : {}),
  },
});
