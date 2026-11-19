import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // The suite runs the dev edition, where every option is live; tests of the
  // public edition pass the edition to the code under test (lib/edition.ts).
  define: {
    __SIMUL_EDITION__: JSON.stringify('dev'),
  },
  test: {
    // Fails the run with a clear message on a Node runtime the PDF stack
    // cannot use, before test collection (O6).
    globalSetup: ['./tools/node-version-preflight.ts'],
    // Local tool folders (worktrees of this repository) hold copies of the
    // tests; only this checkout's own tests run.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
