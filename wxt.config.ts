import { defineConfig } from 'wxt';

export default defineConfig({
  outDir: process.env.SIMUL_WXT_OUT_DIR || '.output',
  manifest: {
    name: 'Simul',
    description:
      'Follow a page in a live read-only mirror and translate it on-device in Chrome.',
    minimum_chrome_version: '138',
    permissions: ['activeTab', 'scripting', 'sidePanel', 'storage'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
  },
});
