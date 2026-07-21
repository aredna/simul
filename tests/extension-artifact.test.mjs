import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  APPROVED_OCR_CSP,
  APPROVED_OCR_PERMISSIONS,
  APPROVED_OPTIONAL_HOST_PERMISSIONS,
  APPROVED_PERMISSIONS,
  IMPLEMENTED_OCR_PROVIDER_IDS,
  REQUIRED_OCR_RUNTIME_MARKERS,
  REQUIRED_ISOLATED_SANDBOX_MARKERS,
  REQUIRED_REPLICA_RUNTIME_MARKERS,
  REQUIRED_UNLISTED_BUNDLES,
  assertOcrProviderDependenciesApproved,
  assertCanonicalSyncTarget,
  buildProductionArtifact,
  canonicalArtifactDirectory,
  checkArtifact,
  compareArtifactDirectories,
  syncArtifact,
  validateArtifact,
} from '../tools/extension-artifact.mjs';

const cleanupDirectories = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('validateArtifact', () => {
  it('accepts a complete, local MV3 artifact with the approved boundary', async () => {
    const artifact = await createTemporaryArtifact();

    const validation = await validateArtifact(artifact);

    expect(validation.manifest).toMatchObject({
      manifest_version: 3,
      minimum_chrome_version: '138',
      permissions: APPROVED_PERMISSIONS,
      optional_host_permissions: APPROVED_OPTIONAL_HOST_PERMISSIONS,
    });
    expect(validation.files).toContain('manifest.json');
    expect(validation.files).toContain('assets/popup.css');
    expect(validation.files).toContain(REQUIRED_UNLISTED_BUNDLES[0]);
    expect(validation.files).toContain(REQUIRED_UNLISTED_BUNDLES[1]);
  });

  it('accepts only the exact packaged Tesseract profile and detects asset drift', async () => {
    const artifact = await createTemporaryOcrArtifact();

    await expect(validateArtifact(artifact)).resolves.toMatchObject({
      ocrEnabled: true,
      ocrProviderIds: IMPLEMENTED_OCR_PROVIDER_IDS,
    });

    await writeFile(
      path.join(artifact, 'ocr/tesseract/licenses/WORKER_THIRD_PARTY.txt'),
      'changed',
    );
    await expect(validateArtifact(artifact)).rejects.toThrow(
      /byte count changed|hash changed/u,
    );
  });

  it('requires the offscreen entry module graph to contain the OCR runtime', async () => {
    const artifact = await createTemporaryOcrArtifact();
    await writeFile(
      path.join(artifact, 'offscreen.html'),
      [
        '<script type="module" src="/offscreen.js"></script>',
        '<link rel="modulepreload" href="/host.js">',
      ].join(''),
    );
    await writeFile(
      path.join(artifact, 'offscreen.js'),
      'console.info("no-op offscreen entry");',
    );

    await expect(validateArtifact(artifact)).rejects.toThrow(
      /OCR compute host is missing required immutable runtime marker/u,
    );
  });

  it.each([
    ['drifted', 'changed notices'],
    ['empty', ''],
  ])('rejects %s packaged third-party notices', async (_label, contents) => {
    const artifact = await createTemporaryOcrArtifact();
    await writeFile(path.join(artifact, 'ocr/THIRD_PARTY_NOTICES.md'), contents);

    await expect(validateArtifact(artifact)).rejects.toThrow(
      'third-party notices differ from the reviewed vendor notices',
    );
  });

  it('rejects excess required permissions and required host permissions', async () => {
    const excess = await createTemporaryArtifact({
      manifest: { permissions: [...APPROVED_PERMISSIONS, 'tabs'] },
    });
    await expect(validateArtifact(excess)).rejects.toThrow(
      'permissions must be exactly',
    );

    const hostAccess = await createTemporaryArtifact({
      manifest: { host_permissions: ['https://example.com/*'] },
    });
    await expect(validateArtifact(hostAccess)).rejects.toThrow(
      'must not contain host_permissions',
    );
  });

  it('rejects a toolbar popup that would reintroduce a surface chooser', async () => {
    const artifact = await createTemporaryArtifact({
      manifest: { action: { default_popup: 'popup.html' } },
    });
    await expect(validateArtifact(artifact)).rejects.toThrow(
      'must launch the saved companion surface directly',
    );
  });

  it('requires the complete OCR profile and rejects OCR runtime drift when disabled', async () => {
    const offscreenPermission = await createTemporaryArtifact({
      manifest: { permissions: [...APPROVED_PERMISSIONS, 'offscreen'] },
    });
    await expect(validateArtifact(offscreenPermission)).rejects.toThrow(
      'requires the packaged offscreen.html',
    );

    const relaxedCsp = await createTemporaryOcrArtifact();
    const relaxedManifestPath = path.join(relaxedCsp, 'manifest.json');
    const relaxedManifest = JSON.parse(
      await readFile(relaxedManifestPath, 'utf8'),
    );
    relaxedManifest.content_security_policy.extension_pages =
      `${APPROVED_OCR_CSP} connect-src https://example.com`;
    await writeFile(relaxedManifestPath, JSON.stringify(relaxedManifest));
    await expect(validateArtifact(relaxedCsp)).rejects.toThrow(
      'requires the exact extension page CSP',
    );

    for (const filename of [
      'offscreen.html',
      'ocr-worker.js',
      'worker.js',
      'models/latin.onnx',
      'weights/latin.txt',
      'runtime/latin.model',
      'runtime/latin.bin',
      'runtime/latin.ort',
      'runtime/latin.tflite',
      'tessdata/jpn.traineddata',
      'runtime/core.wasm',
      'ocr/readme.md',
      'ocr/NOTICE',
    ]) {
      const artifact = await createTemporaryArtifact();
      const absolutePath = path.join(artifact, filename);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(
        absolutePath,
        /\.m?js$/u.test(filename)
          ? 'console.info("not a real runtime");'
          : 'not a real runtime',
      );
      await expect(validateArtifact(artifact)).rejects.toThrow(
        /OCR runtime|OCR compute-host/u,
      );
    }
  });

  it.each([
    [undefined, 'missing'],
    [['http://*/*', 'https://*/*'], 'legacy wildcard pair'],
    [
      [...APPROVED_OPTIONAL_HOST_PERMISSIONS, 'https://example.com/*'],
      'excess site access',
    ],
    [
      [
        APPROVED_OPTIONAL_HOST_PERMISSIONS[0],
        APPROVED_OPTIONAL_HOST_PERMISSIONS[0],
      ],
      'duplicate access',
    ],
  ])('rejects %s optional host permissions (%s)', async (permissions) => {
    const artifact = await createTemporaryArtifact({
      manifest: { optional_host_permissions: permissions },
    });

    await expect(validateArtifact(artifact)).rejects.toThrow(
      'optional_host_permissions must be exactly',
    );
  });

  it('rejects optional named permissions outside the approved boundary', async () => {
    const artifact = await createTemporaryArtifact({
      manifest: { optional_permissions: ['tabs'] },
    });

    await expect(validateArtifact(artifact)).rejects.toThrow(
      'must not contain optional_permissions',
    );
  });

  it.each([
    [{ name: '' }, 'name must be a non-empty string'],
    [{ version: '01.2.3' }, 'version must contain'],
    [{ version: '0.0.0' }, 'version must contain'],
    [{ version: '65536' }, 'version must contain'],
  ])('rejects an invalid required manifest identity field', async (manifest, message) => {
    const artifact = await createTemporaryArtifact({ manifest });

    await expect(validateArtifact(artifact)).rejects.toThrow(message);
  });

  it('scans a manifest service worker as executable even without a file extension', async () => {
    const artifact = await createTemporaryArtifact({
      manifest: { background: { service_worker: 'worker' } },
    });
    await writeFile(
      path.join(artifact, 'worker'),
      'import "https://example.com/remote.js";',
    );

    await expect(validateArtifact(artifact)).rejects.toThrow(
      'Remote executable code reference',
    );
  });

  it.each([
    [
      'an unquoted remote script',
      '<script src=https://example.com/app.js></script>',
      'Remote artifact reference',
    ],
    [
      'a missing srcset candidate',
      '<img srcset="/missing-1.png 1x, /missing-2.png 2x">',
      'missing-1.png',
    ],
    [
      'a missing video poster',
      '<video poster="/missing-poster.png"></video>',
      'missing-poster.png',
    ],
    [
      'a missing object resource',
      '<object data="/missing-document.pdf"></object>',
      'missing-document.pdf',
    ],
  ])('rejects HTML containing %s', async (_label, popupHtml, message) => {
    const artifact = await createTemporaryArtifact();
    await writeFile(path.join(artifact, 'popup.html'), popupHtml);

    await expect(validateArtifact(artifact)).rejects.toThrow(message);
  });

  it('rejects maps, environment files, key material, and remote executable code', async () => {
    const mapArtifact = await createTemporaryArtifact();
    await writeFile(path.join(mapArtifact, 'side.js.map'), '{}');
    await expect(validateArtifact(mapArtifact)).rejects.toThrow(
      'Source map is forbidden',
    );

    const mapReferenceArtifact = await createTemporaryArtifact();
    await writeFile(
      path.join(mapReferenceArtifact, 'side.js'),
      `console.info(${JSON.stringify(REQUIRED_REPLICA_RUNTIME_MARKERS[1])});\n//# sourceMappingURL=side.js.map`,
    );
    await expect(validateArtifact(mapReferenceArtifact)).rejects.toThrow(
      'Source map reference is forbidden',
    );

    const inlineMapReferenceArtifact = await createTemporaryArtifact();
    await writeFile(
      path.join(inlineMapReferenceArtifact, 'side.js'),
      `console.info(${JSON.stringify(REQUIRED_REPLICA_RUNTIME_MARKERS[1])}); //# sourceMappingURL=side.js.map`,
    );
    await expect(validateArtifact(inlineMapReferenceArtifact)).rejects.toThrow(
      'Source map reference is forbidden',
    );

    const inertMapSyntaxArtifact = await createTemporaryArtifact();
    await writeFile(
      path.join(inertMapSyntaxArtifact, 'popup.js'),
      'const generatedCss = "/*# sourceMappingURL="; console.info(generatedCss);',
    );
    await expect(validateArtifact(inertMapSyntaxArtifact)).resolves.toBeDefined();

    const environmentArtifact = await createTemporaryArtifact();
    await writeFile(path.join(environmentArtifact, '.env.production'), 'TOKEN=x');
    await expect(validateArtifact(environmentArtifact)).rejects.toThrow(
      'Secret or key file is forbidden',
    );

    const keyArtifact = await createTemporaryArtifact();
    await writeFile(
      path.join(keyArtifact, 'popup.js'),
      '-----BEGIN PRIVATE KEY-----\nnot-a-real-key',
    );
    await expect(validateArtifact(keyArtifact)).rejects.toThrow(
      'Possible credential material',
    );

    const remoteArtifact = await createTemporaryArtifact();
    await writeFile(
      path.join(remoteArtifact, 'popup.html'),
      '<script src="https://example.com/app.js"></script>',
    );
    await expect(validateArtifact(remoteArtifact)).rejects.toThrow(
      'Remote executable code reference',
    );
  });

  it('requires the packaged recorder and local replica runtime markers', async () => {
    const missingRecorder = await createTemporaryArtifact();
    await rm(path.join(missingRecorder, REQUIRED_UNLISTED_BUNDLES[0]));
    await expect(validateArtifact(missingRecorder)).rejects.toThrow(
      'missing required local bundle',
    );

    const missingMarker = await createTemporaryArtifact();
    await writeFile(path.join(missingMarker, 'side.js'), 'console.info("side");');
    await expect(validateArtifact(missingMarker)).rejects.toThrow(
      'missing required local replica runtime marker',
    );

    const misplacedRecorderMarker = await createTemporaryArtifact();
    await writeFile(
      path.join(misplacedRecorderMarker, REQUIRED_UNLISTED_BUNDLES[0]),
      'console.info("recorder missing");',
    );
    await writeFile(
      path.join(misplacedRecorderMarker, 'side.js'),
      `console.info(${JSON.stringify(REQUIRED_REPLICA_RUNTIME_MARKERS)});`,
    );
    await expect(validateArtifact(misplacedRecorderMarker)).rejects.toThrow(
      REQUIRED_REPLICA_RUNTIME_MARKERS[0],
    );

    const commentOnlyCaptureMarker = await createTemporaryArtifact();
    await writeFile(
      path.join(commentOnlyCaptureMarker, REQUIRED_UNLISTED_BUNDLES[0]),
      `// ${REQUIRED_REPLICA_RUNTIME_MARKERS[0]}\nconsole.info("recorder");`,
    );
    await expect(validateArtifact(commentOnlyCaptureMarker)).rejects.toThrow(
      REQUIRED_REPLICA_RUNTIME_MARKERS[0],
    );

    const commentOnlyReplayMarker = await createTemporaryArtifact();
    await writeFile(
      path.join(commentOnlyReplayMarker, 'side.js'),
      `// ${REQUIRED_REPLICA_RUNTIME_MARKERS[1]}\nconsole.info("side");`,
    );
    await expect(validateArtifact(commentOnlyReplayMarker)).rejects.toThrow(
      REQUIRED_REPLICA_RUNTIME_MARKERS[1],
    );

    const missingSandboxMarker = await createTemporaryArtifact();
    await writeFile(
      path.join(missingSandboxMarker, 'side.js'),
      `console.info(${JSON.stringify([
        REQUIRED_REPLICA_RUNTIME_MARKERS[1],
        REQUIRED_REPLICA_RUNTIME_MARKERS[3],
      ])});`,
    );
    await expect(validateArtifact(missingSandboxMarker)).rejects.toThrow(
      'isolated iframe sandbox/CSP markers',
    );
  });

  it.each([
    'fetch("https://cdn.example.test/runtime.wasm")',
    'fetch(`https://cdn.example.test/runtime.wasm`)',
    'fetch("https:" + "//cdn.example.test/runtime.wasm")',
    'new URL("https://cdn.example.test/runtime.js", import.meta.url)',
    'new Worker(`https://cdn.example.test/runtime.js`)',
    'new SharedWorker("https:" + "//cdn.example.test/runtime.js")',
    'new Worker(new URL("./runtime.js", "https://cdn.example.test/"))',
    'importScripts("https:" + "//cdn.example.test/runtime.js")',
    'import("https://cdn.example.test/runtime.js")',
    'import runtime from "https://cdn.example.test/runtime.js"',
    'export { runtime } from "https://cdn.example.test/runtime.js"',
    'new Function(`return import("${"https:" + "//cdn.example.test/runtime.js"}")`)',
    'script["src"]="https://cdn.example.test/runtime.js"',
    'script.setAttribute("src", `https://cdn.example.test/runtime.js`)',
    'script.setAttributeNS(null, "xlink:href", "https://cdn.example.test/runtime.js")',
  ])('rejects a remote executable fallback: %s', async (source) => {
    const artifact = await createTemporaryArtifact();
    await writeFile(
      path.join(artifact, 'side.js'),
      `${source};console.info(${JSON.stringify(REQUIRED_REPLICA_RUNTIME_MARKERS)});`,
    );

    await expect(validateArtifact(artifact)).rejects.toThrow(
      'Remote executable code reference',
    );
  });

  it('rejects symlinks and missing referenced assets', async () => {
    const symlinkArtifact = await createTemporaryArtifact();
    await symlink(
      path.join(symlinkArtifact, 'popup.js'),
      path.join(symlinkArtifact, 'linked.js'),
    );
    await expect(validateArtifact(symlinkArtifact)).rejects.toThrow(
      'Symlink is forbidden',
    );

    const missingArtifact = await createTemporaryArtifact();
    await rm(path.join(missingArtifact, 'assets', 'popup.css'));
    await expect(validateArtifact(missingArtifact)).rejects.toThrow(
      'Referenced artifact file is missing',
    );
  });

  it.each([
    ['production.env', 'SETTING=value'],
    ['.npmrc', '//registry.example.test/:_authToken=value'],
    ['notes.txt', `ghp_${'a'.repeat(36)}`],
    ['settings.txt', `AIza${'a'.repeat(35)}`],
    ['headers.txt', `authorization = Bearer ${'a'.repeat(24)}`],
  ])('rejects private configuration or credential material in %s', async (filename, contents) => {
    const artifact = await createTemporaryArtifact();
    await writeFile(path.join(artifact, filename), contents);

    await expect(validateArtifact(artifact)).rejects.toThrow(
      /Secret or key file|Possible credential material/u,
    );
  });
});

describe('OCR provider package boundary', () => {
  it('requires exact Tesseract pins and rejects every unapproved provider', async () => {
    await expect(
      assertOcrProviderDependenciesApproved(),
    ).resolves.toBeUndefined();

    const projectRoot = await createTemporaryDirectory('simul-ocr-deps-');
    const packageJson = {
      dependencies: {
        'tesseract.js': '7.0.0',
        'tesseract.js-core': '7.0.0',
      },
    };
    const packageLock = {
      packages: {
        '': { dependencies: { ...packageJson.dependencies } },
        'node_modules/tesseract.js': { version: '7.0.0' },
        'node_modules/tesseract.js-core': { version: '7.0.0' },
      },
    };
    await writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify(packageJson),
    );
    await writeFile(
      path.join(projectRoot, 'package-lock.json'),
      JSON.stringify(packageLock),
    );
    await expect(
      assertOcrProviderDependenciesApproved(projectRoot),
    ).resolves.toBeUndefined();

    packageJson.dependencies['tesseract.js'] = '^7.0.0';
    await writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify(packageJson),
    );
    await expect(
      assertOcrProviderDependenciesApproved(projectRoot),
    ).rejects.toThrow('pinned exactly');

    packageJson.dependencies['tesseract.js'] = '7.0.0';
    packageJson.dependencies.localOcr = 'npm:tesseract.js@7.0.0';
    await writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify(packageJson),
    );
    await expect(
      assertOcrProviderDependenciesApproved(projectRoot),
    ).rejects.toThrow('cannot be aliased');

    delete packageJson.dependencies.localOcr;
    packageLock.packages[
      'node_modules/wrapper/node_modules/@xenova/transformers'
    ] = { version: '2.0.0' };
    await writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify(packageJson),
    );
    await writeFile(
      path.join(projectRoot, 'package-lock.json'),
      JSON.stringify(packageLock),
    );
    await expect(
      assertOcrProviderDependenciesApproved(projectRoot),
    ).rejects.toThrow('@xenova/transformers');
  });
});

describe('disabled OCR production profile', () => {
  it('omits the compute host, permission, CSP, and every OCR runtime asset', async () => {
    const temporaryRoot = await createTemporaryDirectory('simul-disabled-build-');
    const artifact = await buildProductionArtifact({
      temporaryRoot,
      ocrEnabled: false,
    });

    const validation = await validateArtifact(artifact);

    expect(validation.ocrEnabled).toBe(false);
    expect(validation.manifest.version).toBe('0.2.3');
    expect(validation.manifest.permissions).toEqual(APPROVED_PERMISSIONS);
    expect(validation.manifest).not.toHaveProperty('content_security_policy');
    expect(validation.files).not.toContain('offscreen.html');
    expect(validation.files.some((file) => file.startsWith('ocr/'))).toBe(false);
    const sidepanelHtml = await readFile(
      path.join(artifact, 'sidepanel.html'),
      'utf8',
    );
    expect(sidepanelHtml).toContain('id="build-version"');
    expect(sidepanelHtml).toContain('id="compact-refresh"');
    const javaScriptSources = await Promise.all(
      validation.files
        .filter((file) => /\.m?js$/u.test(file))
        .map((file) => readFile(path.join(artifact, file), 'utf8')),
    );
    expect(
      javaScriptSources.some((source) =>
        source.includes('[Simul] Companion ready. '),
      ),
    ).toBe(true);
    expect(
      javaScriptSources.some((source) =>
        source.includes('[Simul] Background service worker ready. '),
      ),
    ).toBe(true);
    expect(javaScriptSources.some((source) => source.includes('Build ')))
      .toBe(true);
  }, 20_000);
});

describe('independent OCR production profiles', () => {
  it('builds and validates an asset-free Chrome TextDetector-only profile', async () => {
    const temporaryRoot = await createTemporaryDirectory('simul-text-detector-build-');
    const artifact = await buildProductionArtifact({
      temporaryRoot,
      ocrProviderIds: ['chrome-text-detector'],
    });

    const validation = await validateArtifact(artifact);

    expect(validation.ocrProviderIds).toEqual(['chrome-text-detector']);
    expect(validation.manifest.permissions).toEqual(APPROVED_OCR_PERMISSIONS);
    expect(validation.manifest).not.toHaveProperty('content_security_policy');
    expect(validation.files).toContain('offscreen.html');
    expect(validation.files.some((file) => file.startsWith('ocr/'))).toBe(false);
  }, 20_000);

  it('builds and validates a packaged Tesseract-only profile', async () => {
    const temporaryRoot = await createTemporaryDirectory('simul-tesseract-build-');
    const artifact = await buildProductionArtifact({
      temporaryRoot,
      ocrProviderIds: ['tesseract'],
    });

    const validation = await validateArtifact(artifact);

    expect(validation.ocrProviderIds).toEqual(['tesseract']);
    expect(validation.manifest.permissions).toEqual(APPROVED_OCR_PERMISSIONS);
    expect(validation.manifest.content_security_policy).toEqual({
      extension_pages: APPROVED_OCR_CSP,
    });
    expect(validation.files).toContain('ocr/tesseract/asset-manifest.json');
  }, 20_000);

  it('rejects duplicate or unknown requested providers before building', async () => {
    const temporaryRoot = await createTemporaryDirectory('simul-invalid-ocr-build-');
    await expect(
      buildProductionArtifact({
        temporaryRoot,
        ocrProviderIds: ['tesseract', 'tesseract'],
      }),
    ).rejects.toThrow('must not contain duplicate');
    await expect(
      buildProductionArtifact({
        temporaryRoot,
        ocrProviderIds: ['transformers'],
      }),
    ).rejects.toThrow('Unknown or unimplemented OCR provider ID');
  });
});

describe('compareArtifactDirectories', () => {
  it('reports every missing, unexpected, and byte-different path deterministically', async () => {
    const expected = await createTemporaryArtifact();
    const actual = await createTemporaryArtifact();
    await rm(path.join(actual, 'side.js'));
    await writeFile(path.join(actual, 'unexpected.txt'), 'extra');
    await writeFile(path.join(actual, 'popup.js'), 'changed');

    await expect(compareArtifactDirectories(expected, actual)).resolves.toEqual([
      { kind: 'byte-changed', path: 'popup.js' },
      { kind: 'missing', path: 'side.js' },
      { kind: 'unexpected', path: 'unexpected.txt' },
    ]);
  });
});

describe('artifact orchestration', () => {
  it('checks through a temporary build without mutating the committed artifact and cleans up', async () => {
    const projectRoot = await createTemporaryDirectory('simul-project-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed);
    const before = await readFile(path.join(committed, 'popup.js'));
    let observedTemporaryRoot;

    const result = await checkArtifact({
      projectRoot,
      buildArtifact: async ({ temporaryRoot }) => {
        observedTemporaryRoot = temporaryRoot;
        const built = path.join(temporaryRoot, 'built');
        await createValidArtifact(built);
        return built;
      },
    });

    expect(result).toEqual({ committedDirectory: committed });
    expect(await readFile(path.join(committed, 'popup.js'))).toEqual(before);
    await expect(access(observedTemporaryRoot)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails stale checks actionably without changing the release', async () => {
    const projectRoot = await createTemporaryDirectory('simul-stale-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, {
      popupScript: 'console.info("committed");',
    });

    await expect(
      checkArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, {
            popupScript: 'console.info("fresh build");',
          });
          return built;
        },
      }),
    ).rejects.toThrow(/content changed: popup\.js[\s\S]*artifact:sync/u);
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'console.info("committed");',
    );
  });

  it('reports an unsafe fresh build as a source problem instead of recommending sync', async () => {
    const projectRoot = await createTemporaryDirectory('simul-invalid-build-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed);

    let error;
    try {
      await checkArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built);
          await writeFile(path.join(built, '.env'), 'SECRET=value');
          return built;
        },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Fresh production build is unsafe or invalid/u);
    expect(error.message).toMatch(/Fix the source or build configuration/u);
    expect(error.message).not.toContain('npm run artifact:sync');
  });

  it('synchronizes only the exact canonical directory and preserves unrelated paths', async () => {
    const projectRoot = await createTemporaryDirectory('simul-sync-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, { popupScript: 'console.info("old");' });
    const unrelated = path.join(projectRoot, 'dist', 'keep.txt');
    await writeFile(unrelated, 'untouched');

    await syncArtifact({
      projectRoot,
      buildArtifact: async ({ temporaryRoot }) => {
        const built = path.join(temporaryRoot, 'built');
        await createValidArtifact(built, { popupScript: 'console.info("new");' });
        return built;
      },
    });

    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'console.info("new");',
    );
    expect(await readFile(unrelated, 'utf8')).toBe('untouched');
    await expect(
      assertCanonicalSyncTarget(path.join(projectRoot, 'dist', 'wrong'), projectRoot),
    ).rejects.toThrow('Refusing artifact sync outside exact target');
  });

  it('does not replace the existing release when the new build is unsafe', async () => {
    const projectRoot = await createTemporaryDirectory('simul-unsafe-sync-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, {
      popupScript: 'console.info("known-good");',
    });

    await expect(
      syncArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, {
            popupScript: 'console.info("unsafe replacement");',
          });
          await writeFile(path.join(built, '.env'), 'SECRET=value');
          return built;
        },
      }),
    ).rejects.toThrow('Secret or key file is forbidden');
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'console.info("known-good");',
    );
  });

  it('restores the previous release when post-promotion validation fails', async () => {
    const projectRoot = await createTemporaryDirectory('simul-restore-sync-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, {
      popupScript: 'console.info("known-good");',
    });

    await expect(
      syncArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, {
            popupScript: 'console.info("replacement");',
          });
          return built;
        },
        validatePromotedArtifact: async () => {
          throw new Error('simulated post-promotion corruption');
        },
      }),
    ).rejects.toThrow('previous release was restored');
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'console.info("known-good");',
    );
  });

  it('reports cleanup failure accurately while leaving the new release active', async () => {
    const projectRoot = await createTemporaryDirectory('simul-cleanup-sync-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, { popupScript: 'console.info("old");' });

    let backupPath;
    await expect(
      syncArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, { popupScript: 'console.info("new");' });
          return built;
        },
        removeBackup: async (target) => {
          backupPath = target;
          throw new Error('simulated cleanup failure');
        },
      }),
    ).rejects.toThrow('new validated release is active');
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'console.info("new");',
    );
    await expect(access(backupPath)).resolves.toBeUndefined();
  });
});

async function createTemporaryArtifact(options) {
  const root = await createTemporaryDirectory('simul-artifact-');
  await createValidArtifact(root, options);
  return root;
}

async function createTemporaryOcrArtifact() {
  const artifact = await createTemporaryArtifact({
    manifest: {
      permissions: [...APPROVED_OCR_PERMISSIONS],
      content_security_policy: { extension_pages: APPROVED_OCR_CSP },
    },
  });
  await cp(path.resolve('vendor/ocr'), path.join(artifact, 'ocr'), {
    recursive: true,
  });
  await writeFile(
    path.join(artifact, 'offscreen.html'),
    '<script type="module" src="/offscreen.js"></script>',
  );
  await writeFile(
    path.join(artifact, 'offscreen.js'),
    'import "./host.js";',
  );
  await writeFile(
    path.join(artifact, 'host.js'),
    `globalThis.__simulOcrRuntime = Object.freeze(${JSON.stringify(REQUIRED_OCR_RUNTIME_MARKERS)});`,
  );
  return artifact;
}

async function createTemporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupDirectories.push(directory);
  return directory;
}

async function createValidArtifact(
  directory,
  { manifest: manifestOverrides = {}, popupScript = 'console.info("popup");' } = {},
) {
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  const manifest = {
    manifest_version: 3,
    name: 'Simul',
    version: '0.1.0',
    minimum_chrome_version: '138',
    permissions: [...APPROVED_PERMISSIONS],
    optional_host_permissions: [...APPROVED_OPTIONAL_HOST_PERMISSIONS],
    background: { service_worker: 'background.js' },
    action: { default_title: 'Simul' },
    side_panel: { default_path: 'sidepanel.html' },
    ...manifestOverrides,
  };
  await Promise.all([
    writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(path.join(directory, 'background.js'), 'console.info("background");'),
    writeFile(
      path.join(directory, 'popup.html'),
      '<script src="/popup.js"></script><link rel="stylesheet" href="/assets/popup.css">',
    ),
    writeFile(path.join(directory, 'popup.js'), popupScript),
    writeFile(path.join(directory, 'assets', 'popup.css'), 'body { color: black; }'),
    writeFile(path.join(directory, 'sidepanel.html'), '<script src="/side.js"></script>'),
    writeFile(
      path.join(directory, 'side.js'),
      `console.info("side", ${JSON.stringify([
        REQUIRED_REPLICA_RUNTIME_MARKERS[1],
        REQUIRED_REPLICA_RUNTIME_MARKERS[3],
        ...REQUIRED_ISOLATED_SANDBOX_MARKERS,
      ])});`,
    ),
    writeFile(
      path.join(directory, REQUIRED_UNLISTED_BUNDLES[0]),
      `console.info(${JSON.stringify(REQUIRED_REPLICA_RUNTIME_MARKERS[0])});`,
    ),
    writeFile(
      path.join(directory, REQUIRED_UNLISTED_BUNDLES[1]),
      `console.info(${JSON.stringify(REQUIRED_REPLICA_RUNTIME_MARKERS[2])});`,
    ),
  ]);
  return directory;
}
