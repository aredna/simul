import {
  access,
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
  APPROVED_PERMISSIONS,
  assertCanonicalSyncTarget,
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
    });
    expect(validation.files).toContain('manifest.json');
    expect(validation.files).toContain('assets/popup.css');
  });

  it('rejects excess permissions and host permissions', async () => {
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
    await createValidArtifact(committed, { popupScript: 'committed' });

    await expect(
      checkArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, { popupScript: 'fresh build' });
          return built;
        },
      }),
    ).rejects.toThrow(/content changed: popup\.js[\s\S]*artifact:sync/u);
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'committed',
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
    await createValidArtifact(committed, { popupScript: 'old' });
    const unrelated = path.join(projectRoot, 'dist', 'keep.txt');
    await writeFile(unrelated, 'untouched');

    await syncArtifact({
      projectRoot,
      buildArtifact: async ({ temporaryRoot }) => {
        const built = path.join(temporaryRoot, 'built');
        await createValidArtifact(built, { popupScript: 'new' });
        return built;
      },
    });

    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe('new');
    expect(await readFile(unrelated, 'utf8')).toBe('untouched');
    await expect(
      assertCanonicalSyncTarget(path.join(projectRoot, 'dist', 'wrong'), projectRoot),
    ).rejects.toThrow('Refusing artifact sync outside exact target');
  });

  it('does not replace the existing release when the new build is unsafe', async () => {
    const projectRoot = await createTemporaryDirectory('simul-unsafe-sync-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, { popupScript: 'known-good' });

    await expect(
      syncArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, { popupScript: 'unsafe replacement' });
          await writeFile(path.join(built, '.env'), 'SECRET=value');
          return built;
        },
      }),
    ).rejects.toThrow('Secret or key file is forbidden');
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'known-good',
    );
  });

  it('restores the previous release when post-promotion validation fails', async () => {
    const projectRoot = await createTemporaryDirectory('simul-restore-sync-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, { popupScript: 'known-good' });

    await expect(
      syncArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, { popupScript: 'replacement' });
          return built;
        },
        validatePromotedArtifact: async () => {
          throw new Error('simulated post-promotion corruption');
        },
      }),
    ).rejects.toThrow('previous release was restored');
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe(
      'known-good',
    );
  });

  it('reports cleanup failure accurately while leaving the new release active', async () => {
    const projectRoot = await createTemporaryDirectory('simul-cleanup-sync-');
    const committed = canonicalArtifactDirectory(projectRoot);
    await createValidArtifact(committed, { popupScript: 'old' });

    let backupPath;
    await expect(
      syncArtifact({
        projectRoot,
        buildArtifact: async ({ temporaryRoot }) => {
          const built = path.join(temporaryRoot, 'built');
          await createValidArtifact(built, { popupScript: 'new' });
          return built;
        },
        removeBackup: async (target) => {
          backupPath = target;
          throw new Error('simulated cleanup failure');
        },
      }),
    ).rejects.toThrow('new validated release is active');
    expect(await readFile(path.join(committed, 'popup.js'), 'utf8')).toBe('new');
    await expect(access(backupPath)).resolves.toBeUndefined();
  });
});

async function createTemporaryArtifact(options) {
  const root = await createTemporaryDirectory('simul-artifact-');
  await createValidArtifact(root, options);
  return root;
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
    background: { service_worker: 'background.js' },
    action: { default_popup: 'popup.html' },
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
    writeFile(path.join(directory, 'side.js'), 'console.info("side");'),
  ]);
  return directory;
}
