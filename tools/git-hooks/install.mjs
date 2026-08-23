#!/usr/bin/env node

import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HOOK_NAMES = ['pre-commit', 'pre-push'];
const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

function runGit(args, { allowMissing = false } = {}) {
  const run = spawnSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (run.status === 0) {
    return run.stdout.trim();
  }
  if (allowMissing && run.status === 1) {
    return undefined;
  }

  const detail = run.stderr.trim() || run.error?.message || 'unknown Git error';
  throw new Error(`Cannot locate this repository's hooks directory: ${detail}`);
}

function resolveHooksDirectory() {
  const repositoryRoot = runGit(['rev-parse', '--show-toplevel']);
  const configuredPath = runGit(
    ['config', '--path', '--get', 'core.hooksPath'],
    { allowMissing: true },
  );

  if (configuredPath) {
    return isAbsolute(configuredPath)
      ? configuredPath
      : resolve(repositoryRoot, configuredPath);
  }

  const gitHooksPath = runGit(['rev-parse', '--git-path', 'hooks']);
  return isAbsolute(gitHooksPath)
    ? gitHooksPath
    : resolve(process.cwd(), gitHooksPath);
}

function sameBytes(left, right) {
  const leftBytes = readFileSync(left);
  const rightBytes = readFileSync(right);
  return leftBytes.equals(rightBytes);
}

function inspectTarget(source, target) {
  let targetStat;
  try {
    targetStat = lstatSync(target);
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return 'absent';
    }
    throw error;
  }

  if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
    return 'conflict';
  }

  return sameBytes(source, target) ? 'managed' : 'conflict';
}

function installHooks() {
  const hooksDirectory = resolveHooksDirectory();
  const hooks = HOOK_NAMES.map((name) => {
    const source = join(SOURCE_DIRECTORY, name);
    const target = join(hooksDirectory, name);
    return { name, source, target, state: inspectTarget(source, target) };
  });
  const conflicts = hooks.filter(({ state }) => state === 'conflict');

  if (conflicts.length > 0) {
    const listed = conflicts.map(({ target }) => `  ${target}`).join('\n');
    throw new Error(
      `Refusing to overwrite existing Git hook${conflicts.length === 1 ? '' : 's'}:\n${listed}\n`
      + 'Move or remove the conflicting hook explicitly, then run the installer again.',
    );
  }

  mkdirSync(hooksDirectory, { recursive: true });
  const createdHooks = [];

  try {
    for (const hook of hooks) {
      if (hook.state === 'absent') {
        copyFileSync(hook.source, hook.target, constants.COPYFILE_EXCL);
        createdHooks.push(hook);
      }
    }

    for (const hook of hooks) {
      chmodSync(hook.target, 0o755);
    }
  } catch (error) {
    for (const hook of createdHooks.reverse()) {
      if (existsSync(hook.target) && sameBytes(hook.source, hook.target)) {
        unlinkSync(hook.target);
      }
    }
    throw error;
  }

  const installed = hooks.filter(({ state }) => state === 'absent').length;
  const unchanged = hooks.length - installed;
  process.stdout.write(
    `Simul Git hooks ready in ${hooksDirectory} (${installed} installed, ${unchanged} unchanged).\n`,
  );
}

try {
  installHooks();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Simul hook installer: ${message}\n`);
  process.exitCode = 1;
}
