import { parse, type Comment } from 'acorn';
import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';
import { defineConfig } from 'wxt';
import { parseSimulEdition } from './lib/edition';
import {
  applyEditionToDocument,
  hasEditionMarkers,
} from './lib/edition-markup';
import {
  createOcrBuildProfilePlugin,
  readOcrBuildProfile,
} from './tools/ocr-build-profile';

const ocrBuildProfile = readOcrBuildProfile(process.env);
const betaBuildSuffix = 'beta v.20261121.14';
// `SIMUL_EDITION=dev` builds the owner's edition with every option; anything
// else builds the public edition (lib/edition.ts).
const simulEdition = parseSimulEdition(process.env.SIMUL_EDITION);
const editionVersionSuffix = simulEdition === 'dev' ? ' dev' : '';
const tesseractEnabled = ocrBuildProfile.enabledProviderIds.includes('tesseract');
const offscreenOcrEnabled = ocrBuildProfile.enabledProviderIds.some((id) =>
  id === 'tesseract' || id === 'chrome-text-detector',
);
// pdf.js ships in every build and needs Wasm and a module worker; Tesseract
// needs the same when it is on. No plugins and no <base> on Simul's pages
// (Modern Web Guidance security: object-src 'none', base-uri 'none').
// Trusted Types (D161): only the mirror shells become HTML, and only the
// extension's own files become script URLs (lib/trusted-types.ts).
const privilegedCsp =
  "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'none'; " +
  "require-trusted-types-for 'script'; trusted-types simul-mirror-shell default;";
const selectedEntrypoints = Object.freeze([
  'background',
  ...(offscreenOcrEnabled ? ['offscreen'] : []),
  'page-mirror',
  'pdf-viewer-bridge',
  'sidepanel',
]);
const releaseLegalFiles = Object.freeze([
  { source: new URL('./LICENSE', import.meta.url), fileName: 'LICENSE' },
  {
    source: new URL('./THIRD_PARTY_NOTICES.md', import.meta.url),
    fileName: 'THIRD_PARTY_NOTICES.md',
  },
]);
const pdfjsAssets = Object.freeze(
  collectFiles(new URL('./vendor/pdfjs/', import.meta.url), 'pdfjs'),
);
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

const TESSERACT_CHUNK_MODIFICATION_NOTICE =
  '/*! Contains tesseract.js 7.0.0 (Apache-2.0), modified by Simul: its ' +
  'remote worker, core and language-data fallback locations are replaced by ' +
  'local-only markers. See THIRD_PARTY_NOTICES.md. */\n';

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
  // public/ ships the extension icons; the vendored pdf.js and OCR runtimes
  // and the legal files are emitted by the release plugin below.
  publicDir: 'public',
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      manifest.version_name =
        `${manifest.version} ${betaBuildSuffix}${editionVersionSuffix}`;
      // The toolbar action launches the saved surface directly. Retaining a
      // default popup would suppress action.onClicked and reintroduce a
      // two-button chooser before every detached-window launch.
      if (manifest.action) delete manifest.action.default_popup;
    },
  },
  filterEntrypoints: [...selectedEntrypoints],
  vite: () => ({
    define: {
      __SIMUL_EDITION__: JSON.stringify(simulEdition),
    },
    build: {
      target: 'chrome138',
      cssTarget: 'chrome138',
      // SIMUL_NO_MINIFY=1 keeps names for CPU profiles; never for a release.
      ...(process.env.SIMUL_NO_MINIFY === '1' ? { minify: false } : {}),
      // Vite 8 bundles with rolldown; legal comments are a rolldown output
      // option now (the former esbuild option is not read for the bundle).
      rolldownOptions: {
        output: {
          comments: { legal: false },
        },
      },
    },
    plugins: [
      createOcrBuildProfilePlugin(process.env),
      {
        // Each edition's pages carry only that edition's controls; the
        // markers are resolved before Vite reads the page's scripts.
        name: 'simul-edition-markup',
        transformIndexHtml: {
          order: 'pre',
          handler(html: string) {
            if (!hasEditionMarkers(html)) return html;
            const { document } = parseHTML(html);
            applyEditionToDocument(document, simulEdition);
            return document.toString();
          },
        },
      },
      {
        name: 'simul-release-legal-files',
        generateBundle() {
          for (const legalFile of [
            ...releaseLegalFiles,
            ...pdfjsAssets,
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
            // Apache-2.0 section 4(b): the chunk carrying the patched
            // tesseract.js code states that it was changed.
            if (
              artifact.code.includes('__SIMUL_LOCAL_WORKER_REQUIRED__') &&
              !artifact.code.startsWith(TESSERACT_CHUNK_MODIFICATION_NOTICE)
            ) {
              artifact.code = `${TESSERACT_CHUNK_MODIFICATION_NOTICE}${artifact.code}`;
            }
          }
        },
      },
    ],
  }),
  manifest: {
    name: 'Simul',
    description:
      'Follow a page in a live read-only mirror and translate it on-device in Chrome.',
    // 141 has sidePanel.close(), which closes one window's side panel
    // (D176).
    minimum_chrome_version: '141',
    action: {
      default_title: 'Simul',
    },
    // Chrome falls back to these for the toolbar action; the Web Store
    // rejects a listing without them. Placeholders until the real mark lands.
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    permissions: [
      'activeTab',
      'scripting',
      'sidePanel',
      'storage',
      ...(offscreenOcrEnabled ? ['offscreen' as const] : []),
    ],
    // Every site from install (D166): the panel follows each page the
    // reader opens in the window without a click on Simul's icon on every
    // new site. The reader can withhold it in Chrome's Site access; the
    // panel then offers it again from a click.
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: privilegedCsp,
    },
  },
});
