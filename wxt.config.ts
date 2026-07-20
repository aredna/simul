import { parse, type Comment } from 'acorn';
import { defineConfig } from 'wxt';
import {
  createOcrBuildProfilePlugin,
  readOcrBuildProfile,
} from './tools/ocr-build-profile';

const ocrBuildProfile = readOcrBuildProfile(process.env);
const tesseractEnabled = ocrBuildProfile.enabledProviderIds.includes('tesseract');

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

export default defineConfig({
  outDir: process.env.SIMUL_WXT_OUT_DIR || '.output',
  publicDir: tesseractEnabled ? 'vendor' : 'public',
  ...(tesseractEnabled
    ? {}
    : {
        filterEntrypoints: [
          'background',
          'page-recorder',
          'page-snapshot',
          'popup',
          'sidepanel',
        ],
      }),
  vite: () => ({
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
    permissions: [
      'activeTab',
      'scripting',
      'sidePanel',
      'storage',
      ...(tesseractEnabled ? ['offscreen' as const] : []),
    ],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
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
