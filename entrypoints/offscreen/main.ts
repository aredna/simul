import {
  compiledOcrProviderRunnerFactories,
} from 'virtual:simul-ocr-provider-runtime-registry';

import { OffscreenComputeHost } from '../../lib/ocr/offscreen-host';
import { isTrustedOffscreenMessageSender } from '../../lib/ocr/offscreen-message-sender';
import { OffscreenOcrProviderRouter } from '../../lib/ocr/offscreen-provider-router';
import { readOffscreenOcrCommand } from '../../lib/ocr/offscreen-protocol';
import {
  createProbeOcrProviderResponse,
  readProbeOcrProviderCommand,
} from '../../lib/ocr/provider-status-protocol';
import { IndexedDbTransientImageStore } from '../../lib/ocr/transient-image-store';
import { settle } from '../../lib/settle';
import { installDefaultScriptUrlPolicy } from '../../lib/trusted-types';

// tesseract.js starts its worker from a URL string (Trusted Types, D161).
installDefaultScriptUrlPolicy();

const router = new OffscreenOcrProviderRouter(
  compiledOcrProviderRunnerFactories,
);
const host = new OffscreenComputeHost(
  new IndexedDbTransientImageStore(),
  router,
);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedOffscreenMessageSender(sender, browser.runtime.id)) return;
  const probe = readProbeOcrProviderCommand(message);
  if (probe) {
    void (async () => {
      const provider = await settle(router.probe(probe.providerId));
      sendResponse(createProbeOcrProviderResponse(provider.ok ? provider.value : {
        status: 'unavailable',
        providerId: probe.providerId,
        reason: 'probe-failed',
      }));
    })();
    return true;
  }
  const command = readOffscreenOcrCommand(message);
  if (!command) return;
  void (async () => {
    const response = await settle(host.handle(command));
    sendResponse(response.ok ? response.value : undefined);
  })();
  return true;
});

window.addEventListener('pagehide', () => void host.dispose(), { once: true });
