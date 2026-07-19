import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Simul',
    description:
      'Compare a page with a local Japanese or English translation in Chrome\'s side panel.',
    minimum_chrome_version: '138',
    permissions: ['activeTab', 'scripting', 'sidePanel'],
  },
});
