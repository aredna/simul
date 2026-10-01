import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  APPROVED_PDFJS_CMAP_COUNT,
  APPROVED_PDFJS_COMMIT,
  APPROVED_PDFJS_PACKAGE_LOCK_METADATA,
  APPROVED_PDFJS_VERSION,
  approvedPdfjsAssetLayout,
  findUnreviewedPdfjsUrls,
} from '../tools/extension-artifact.mjs';

const vendorRoot = resolve('vendor/pdfjs');
const packageRoot = resolve('node_modules/pdfjs-dist');

async function readManifest() {
  return JSON.parse(await readFile(resolve(vendorRoot, 'asset-manifest.json'), 'utf8'));
}

async function listFiles(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      paths.push(...await listFiles(resolve(directory, entry.name), `${relative}/`));
    } else {
      paths.push(relative);
    }
  }
  return paths;
}

function runProbe(...args) {
  return JSON.parse(
    execFileSync(process.execPath, ['tests/support/pdfjs-node-probe.mjs', ...args], {
      encoding: 'utf8',
    }),
  );
}

describe('vendored pdf.js catalog', () => {
  it('pins pdfjs-dist exactly, as a development source that is never bundled', async () => {
    const packageManifest = JSON.parse(await readFile('package.json', 'utf8'));
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));

    // The shipped copy is vendor/pdfjs; the package supplies it and the types.
    expect(packageManifest.devDependencies['pdfjs-dist']).toBe(APPROVED_PDFJS_VERSION);
    expect(packageManifest.dependencies['pdfjs-dist']).toBeUndefined();
    expect(lock.packages[''].devDependencies['pdfjs-dist']).toBe(APPROVED_PDFJS_VERSION);
    expect(lock.packages['node_modules/pdfjs-dist']).toMatchObject({
      ...APPROVED_PDFJS_PACKAGE_LOCK_METADATA,
      dev: true,
    });
    // The Node canvas pdf.js draws with in tests: no install script, not shipped.
    expect(packageManifest.devDependencies['@napi-rs/canvas']).toBe('1.0.9');
    expect(lock.packages['node_modules/@napi-rs/canvas']).toMatchObject({
      dev: true,
      license: 'MIT',
    });
    expect(lock.packages['node_modules/@napi-rs/canvas'].hasInstallScript).toBeUndefined();
  });

  it('uses the approved layout, with every npm CMap', async () => {
    const manifest = await readManifest();
    const cmapNames = (await readdir(resolve(packageRoot, 'cmaps')))
      .filter((name) => name.endsWith('.bcmap'))
      .sort();

    expect(cmapNames).toHaveLength(APPROVED_PDFJS_CMAP_COUNT);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      pdfjsVersion: APPROVED_PDFJS_VERSION,
      pdfjsCommit: APPROVED_PDFJS_COMMIT,
    });
    expect(manifest.files.map(({ path, role, source }) => ({ path, role, source })))
      .toEqual(approvedPdfjsAssetLayout(cmapNames));
  });

  it('matches every declared byte and hash, and holds no other file', async () => {
    const manifest = await readManifest();
    let totalBytes = 0;
    for (const entry of manifest.files) {
      const bytes = await readFile(resolve(vendorRoot, entry.path));
      totalBytes += bytes.length;
      expect(bytes.length, entry.path).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), entry.path).toBe(entry.sha256);
    }
    expect(totalBytes).toBe(manifest.totalBytes);
    expect((await listFiles(vendorRoot)).sort()).toEqual(
      [
        'THIRD_PARTY_NOTICES.md',
        'asset-manifest.json',
        ...manifest.files.map(({ path }) => path),
      ].sort(),
    );
  });

  it('ships npm files byte-identical to pdfjs-dist and Simul files from tools/pdfjs', async () => {
    const manifest = await readManifest();
    for (const entry of manifest.files) {
      const vendored = await readFile(resolve(vendorRoot, entry.path));
      const npm = /^npm:pdfjs-dist@[^/]+\/(.+)$/u.exec(entry.source)?.[1];
      const repo = /^repo:(.+)$/u.exec(entry.source)?.[1];
      if (npm) {
        expect(vendored.equals(await readFile(resolve(packageRoot, npm))), entry.path).toBe(true);
      } else if (repo) {
        expect(vendored.equals(await readFile(repo)), entry.path).toBe(true);
      } else {
        expect(entry.path).toBe('LICENSE_BROTLI');
        expect(vendored.toString('utf8')).toMatch(
          /^Copyright \(c\) 2009, 2010, 2013-2016 by the Brotli Authors\.[\s\S]*Permission is hereby granted/u,
        );
      }
    }
  });

  it('leaves out GPL fonts, fallbacks, scripting, the viewer and source maps', async () => {
    const paths = await listFiles(vendorRoot);
    for (const path of paths) {
      expect(path).not.toMatch(
        /Liberation|_nowasm_fallback|quickjs|pdf_viewer|image_decoders|legacy|sandbox|\.map$|\.ttf$/u,
      );
    }
    expect(paths.filter((path) => path.endsWith('.wasm')).sort()).toEqual([
      'wasm/jbig2.wasm',
      'wasm/openjpeg.wasm',
      'wasm/qcms_bg.wasm',
    ]);
  });

  it('contains no URL outside the reviewed inert list in any module', async () => {
    const manifest = await readManifest();
    for (const entry of manifest.files.filter(({ path }) => path.endsWith('.mjs'))) {
      const text = await readFile(resolve(vendorRoot, entry.path), 'utf8');
      expect(findUnreviewedPdfjsUrls(text), entry.path).toEqual([]);
      expect(text, entry.path).not.toMatch(/sourceMappingURL/u);
    }
    expect(findUnreviewedPdfjsUrls('import("https://cdn.jsdelivr.net/npm/pdfjs-dist")'))
      .toEqual(['https://cdn.jsdelivr.net/npm/pdfjs-dist']);
  });

  it('names every packaged component in the notices', async () => {
    const vendorNotices = await readFile(resolve(vendorRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const rootNotices = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
    for (const component of [
      'PDF.js',
      'Brotli',
      'Emscripten',
      'wasm-bindgen',
      'OpenJPEG',
      'JBIG2',
      'qcms',
      'Adobe',
      'Foxit',
      'CGATS001Compat-v2-micro',
    ]) {
      expect(vendorNotices, component).toContain(component);
      expect(rootNotices, component).toContain(component);
    }
  });
});

describe('pdf.js under the Chrome 138 built-ins', () => {
  it('runs in a Node 24 that lacks the six built-ins the shim adds', () => {
    // Written as plain text: `node -p` colours its output when FORCE_COLOR is set.
    const missing = execFileSync(
      process.execPath,
      [
        '-e',
        `process.stdout.write(String([Uint8Array.prototype.toHex, Uint8Array.prototype.toBase64,
          Uint8Array.fromBase64, Map.prototype.getOrInsert, Map.prototype.getOrInsertComputed,
          Math.sumPrecise].every((builtIn) => builtIn === undefined)))`,
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(missing).toBe('true');
  });

  it('opens every fixture with the shim, and fails without it', async () => {
    const fixtures = (await readdir('tests/fixtures/pdf')).filter((name) => name.endsWith('.pdf'));
    const shimmed = runProbe();
    const bare = runProbe('--no-shim');
    // Node's own advice to use the legacy build is the only allowed message; a
    // missing CMap, font or Wasm file would log a warning here.
    const nodeNotice = 'warn: Warning: Please use the `legacy` build in Node.js environments.';

    expect(shimmed.error).toBeUndefined();
    expect(shimmed.unhandled).toEqual([]);
    expect(shimmed.messages.filter((message) => message !== nodeNotice)).toEqual([]);
    expect(Object.keys(shimmed.fixtures).sort()).toEqual(fixtures.sort());
    for (const [name, result] of Object.entries(shimmed.fixtures)) {
      expect(result.error, name).toBeUndefined();
      expect(result.pages.length, name).toBeGreaterThan(0);
    }
    expect(bare.error).toBeUndefined();
    expect(Object.keys(bare.fixtures)).toHaveLength(fixtures.length);
    for (const [name, result] of Object.entries(bare.fixtures)) {
      expect(result.error, name).toMatch(/is not a function/u);
    }
  }, 30_000);

  it('stands in for the six built-ins as pdf.js uses them', () => {
    const script = `
      await import(${JSON.stringify(new URL('../vendor/pdfjs/simul-shim.mjs', import.meta.url).href)});
      const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
      const map = new Map();
      const weak = new WeakMap();
      const key = {};
      const throws = (run) => { try { run(); return 'none'; } catch (error) { return error.name; } };
      process.stdout.write(JSON.stringify({
        hex: bytes.toHex(),
        base64: bytes.toBase64(),
        roundTrip: [...Uint8Array.fromBase64(bytes.toBase64())],
        large: Uint8Array.fromBase64(new Uint8Array(100000).fill(7).toBase64()).length,
        badBase64: throws(() => Uint8Array.fromBase64('%%%')),
        urlAlphabet: throws(() => bytes.toBase64({ alphabet: 'base64url' })),
        inserted: [map.getOrInsert('a', 1), map.getOrInsert('a', 2)],
        computed: [map.getOrInsertComputed('b', (k) => k + '!'), weak.getOrInsertComputed(key, () => 3)],
        sum: Math.sumPrecise([1, 2, 3.5]),
        emptySumIsNegativeZero: Object.is(Math.sumPrecise([]), -0),
        badSum: throws(() => Math.sumPrecise(['1'])),
        enumerable: [...Object.keys(Uint8Array.prototype), ...Object.keys(Map.prototype)],
      }));
    `;
    const result = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' }),
    );

    expect(result).toEqual({
      hex: '00017f80feff',
      base64: 'AAF/gP7/',
      roundTrip: [0, 1, 127, 128, 254, 255],
      large: 100000,
      badBase64: 'SyntaxError',
      urlAlphabet: 'TypeError',
      inserted: [1, 1],
      computed: ['b!', 3],
      sum: 6.5,
      emptySumIsNegativeZero: true,
      badSum: 'TypeError',
      enumerable: [],
    });
  });
});
