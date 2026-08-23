import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const installer = fileURLToPath(
  new URL('../tools/git-hooks/install.mjs', import.meta.url),
);
const temporaryRepositories: string[] = [];
const isolatedGitEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function run(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: isolatedGitEnvironment,
  });
}

function createRepository(branch = 'feature/hooks') {
  const repository = mkdtempSync(join(tmpdir(), 'simul-hooks-test-'));
  temporaryRepositories.push(repository);
  const initialized = run(
    'git',
    ['init', '--quiet', `--initial-branch=${branch}`],
    repository,
  );
  expect(initialized.status, initialized.stderr).toBe(0);
  return repository;
}

function install(repository: string) {
  return run(process.execPath, [installer], repository);
}

afterEach(() => {
  for (const repository of temporaryRepositories.splice(0)) {
    rmSync(repository, { force: true, recursive: true });
  }
});

describe('tracked Git hook installer', () => {
  it('installs executable guards and is byte-for-byte idempotent', () => {
    const repository = createRepository();
    const first = install(repository);
    expect(first.status, first.stderr).toBe(0);

    const hooksDirectory = join(repository, '.git', 'hooks');
    const preCommit = join(hooksDirectory, 'pre-commit');
    const prePush = join(hooksDirectory, 'pre-push');
    const firstPreCommit = readFileSync(preCommit);
    const firstPrePush = readFileSync(prePush);

    expect(statSync(preCommit).mode & 0o111).not.toBe(0);
    expect(statSync(prePush).mode & 0o111).not.toBe(0);
    expect(run(preCommit, [], repository).status).toBe(0);

    const blockedPush = run(prePush, [], repository);
    expect(blockedPush.status).toBe(1);
    expect(blockedPush.stderr).toContain('every push');

    const second = install(repository);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('0 installed, 2 unchanged');
    expect(readFileSync(preCommit).equals(firstPreCommit)).toBe(true);
    expect(readFileSync(prePush).equals(firstPrePush)).toBe(true);
  });

  it.each(['main', 'master'])('rejects commits on %s', (branch) => {
    const repository = createRepository(branch);
    const installed = install(repository);
    expect(installed.status, installed.stderr).toBe(0);

    const preCommit = join(repository, '.git', 'hooks', 'pre-commit');
    const blockedCommit = run(preCommit, [], repository);
    expect(blockedCommit.status).toBe(1);
    expect(blockedCommit.stderr).toContain(`commits on '${branch}' are blocked`);
  });

  it('refuses every conflict before installing an absent sibling hook', () => {
    const repository = createRepository();
    const hooksDirectory = join(repository, '.git', 'hooks');
    const preCommit = join(hooksDirectory, 'pre-commit');
    const prePush = join(hooksDirectory, 'pre-push');
    const unrelatedHook = '#!/bin/sh\nprintf "existing hook\\n" >&2\nexit 0\n';
    writeFileSync(prePush, unrelatedHook);
    chmodSync(prePush, 0o755);

    const attempted = install(repository);
    expect(attempted.status).toBe(1);
    expect(attempted.stderr).toContain('Refusing to overwrite existing Git hook');
    expect(existsSync(preCommit)).toBe(false);
    expect(readFileSync(prePush, 'utf8')).toBe(unrelatedHook);
  });

  it('installs into an active repository-relative core.hooksPath', () => {
    const repository = createRepository();
    const configured = run(
      'git',
      ['config', 'core.hooksPath', '.local-hooks'],
      repository,
    );
    expect(configured.status, configured.stderr).toBe(0);

    const installed = install(repository);
    expect(installed.status, installed.stderr).toBe(0);
    expect(existsSync(join(repository, '.local-hooks', 'pre-commit'))).toBe(true);
    expect(existsSync(join(repository, '.local-hooks', 'pre-push'))).toBe(true);
    expect(existsSync(join(repository, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });
});
