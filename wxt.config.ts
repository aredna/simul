import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: process.env.SIMUL_WXT_OUT_DIR || '.output',
  manifest: {
    name: 'Simul',
    description:
      'Compare a page with a local Japanese or English translation in Chrome\'s side panel.',
    minimum_chrome_version: '138',
    permissions: ['activeTab', 'scripting', 'sidePanel'],
  },
});
