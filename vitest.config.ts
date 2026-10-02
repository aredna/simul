import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Local tool folders (worktrees of this repository) hold copies of the
    // tests; only this checkout's own tests run.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
