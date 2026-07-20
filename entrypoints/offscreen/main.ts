import {
  compiledOcrProviderRunnerFactories,
} from 'virtual:simul-ocr-provider-runtime-registry';

import { OffscreenComputeHost } from '../../lib/ocr/offscreen-host';
import { OffscreenOcrProviderRouter } from '../../lib/ocr/offscreen-provider-router';
import { readOffscreenOcrCommand } from '../../lib/ocr/offscreen-protocol';
import { IndexedDbTransientImageStore } from '../../lib/ocr/transient-image-store';

const host = new OffscreenComputeHost(
  new IndexedDbTransientImageStore(),
  new OffscreenOcrProviderRouter(compiledOcrProviderRunnerFactories),
);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return;
  const command = readOffscreenOcrCommand(message);
  if (!command) return;
  void host.handle(command).then(
    (response) => sendResponse(response),
    () => sendResponse(undefined),
  );
  return true;
});

window.addEventListener('pagehide', () => void host.dispose(), { once: true });
