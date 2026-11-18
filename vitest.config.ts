import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Fails the run with a clear message on a Node runtime the PDF stack
    // cannot use, before test collection (O6).
    globalSetup: ['./tools/node-version-preflight.ts'],
    // Local tool folders (worktrees of this repository) hold copies of the
    // tests; only this checkout's own tests run.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
