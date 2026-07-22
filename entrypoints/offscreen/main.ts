import {
  compiledOcrProviderRunnerFactories,
} from 'virtual:simul-ocr-provider-runtime-registry';

import { OffscreenComputeHost } from '../../lib/ocr/offscreen-host';
import { OffscreenOcrProviderRouter } from '../../lib/ocr/offscreen-provider-router';
import { readOffscreenOcrCommand } from '../../lib/ocr/offscreen-protocol';
import {
  createProbeOcrProviderResponse,
  readProbeOcrProviderCommand,
} from '../../lib/ocr/provider-status-protocol';
import { IndexedDbTransientImageStore } from '../../lib/ocr/transient-image-store';

const router = new OffscreenOcrProviderRouter(
  compiledOcrProviderRunnerFactories,
);
const host = new OffscreenComputeHost(
  new IndexedDbTransientImageStore(),
  router,
);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id) return;
  const probe = readProbeOcrProviderCommand(message);
  if (probe) {
    void router.probe(probe.providerId).then(
      (provider) => sendResponse(createProbeOcrProviderResponse(provider)),
      () => sendResponse(createProbeOcrProviderResponse({
        status: 'unavailable',
        providerId: probe.providerId,
        reason: 'probe-failed',
      })),
    );
    return true;
  }
  const command = readOffscreenOcrCommand(message);
  if (!command) return;
  void host.handle(command).then(
    (response) => sendResponse(response),
    () => sendResponse(undefined),
  );
  return true;
});

window.addEventListener('pagehide', () => void host.dispose(), { once: true });
