import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const background = readFileSync(
  new URL('../entrypoints/background.ts', import.meta.url),
  'utf8',
);
const offscreen = readFileSync(
  new URL('../entrypoints/offscreen/main.ts', import.meta.url),
  'utf8',
);

// The OCR host wiring is entrypoint code with no behavioral harness: importing
// the entrypoint needs WXT's defineBackground and the full browser API surface.
// These tests therefore pin the source contract and ordering only. They do not
// prove the sweep actually runs or that the listener answers a sender; those
// behaviours are tested on their own in transient-image-store.test.ts (sweep)
// and offscreen-ocr.test.ts (the sender predicate).
describe('background OCR host wiring', () => {
  it('sweeps expired transient image inputs when the worker starts (C3)', () => {
    expect(background).toContain('sweepExpiredTransientImageInputs,');
    const startup = background.slice(
      background.indexOf('const transientImageStore = new IndexedDbTransientImageStore();'),
      background.indexOf('const coordinator = new PreferenceCoordinator('),
    );
    expect(startup).toContain('const transientImageStore = new IndexedDbTransientImageStore();');
    expect(startup).toContain('void sweepExpiredTransientImageInputs(transientImageStore);');
    // The sweep uses the store constructed just above it and runs before the
    // coordinator (and therefore before any host can exist).
    expect(startup.indexOf('void sweepExpiredTransientImageInputs(transientImageStore);'))
      .toBeGreaterThan(startup.indexOf('const transientImageStore = new IndexedDbTransientImageStore();'));
  });

  it('rejects an untrusted ensure-host sender with ready false (C9)', () => {
    const listener = background.slice(
      background.indexOf('browser.runtime.onMessage.addListener('),
      background.indexOf('browser.permissions.onRemoved.addListener('),
    );
    const trusted = listener.indexOf(
      'const trusted = isTrustedOffscreenMessageSender(sender, browser.runtime.id);',
    );
    const authorization = listener.indexOf(
      'if (isWindowAuthorizationRequest(message)) {',
    );
    const ensureHost = listener.indexOf('if (ensureHost) {');
    const trustCheck = listener.indexOf('if (!trusted) {', ensureHost);

    // The sender is judged once, before any message is read (D158).
    expect(trusted).toBeGreaterThanOrEqual(0);
    expect(authorization).toBeGreaterThan(trusted);
    expect(ensureHost).toBeGreaterThan(authorization);
    // Only a companion page gets its window authorization; a script in a
    // web page gets null.
    expect(listener.slice(authorization, ensureHost)).toContain('trusted\n');
    expect(listener.slice(authorization, ensureHost)).toContain(': null,');
    expect(trustCheck).toBeGreaterThan(ensureHost);
    const rejected = listener.slice(
      trustCheck,
      listener.indexOf('if (!hasOcrRuntimeProvider(', trustCheck),
    );
    expect(rejected).toContain('ready: false,');
    expect(rejected).toContain('return;');
    // Preference commands from an untrusted sender are not run.
    expect(listener).toContain('if (!command || !trusted) return;');
  });

  it('refuses preference-safety ports and panel messages from web-page scripts (D158)', () => {
    const connect = background.slice(
      background.indexOf('browser.runtime.onConnect.addListener('),
      background.indexOf('browser.runtime.onMessage.addListener('),
    );
    expect(connect).toContain(
      'if (!isTrustedOffscreenMessageSender(port.sender, browser.runtime.id)) return;',
    );
    expect(connect.indexOf('isTrustedOffscreenMessageSender'))
      .toBeLessThan(connect.indexOf('preferenceSafety.connect('));
    const panel = readFileSync(
      new URL('../entrypoints/sidepanel/main.ts', import.meta.url),
      'utf8',
    );
    const panelListener = panel.slice(
      panel.indexOf('browser.runtime.onMessage.addListener('),
      panel.indexOf('browser.tabs.onActivated.addListener('),
    );
    const gate = 'if (!isTrustedOffscreenMessageSender(sender, browser.runtime.id)) return;';
    expect(panelListener).toContain(gate);
    expect(panelListener.indexOf(gate))
      .toBeLessThan(panelListener.indexOf('namesCompanionWindow('));
  });

  it('gates the offscreen host listener with the same sender predicate (C9)', () => {
    const listener = offscreen.slice(
      offscreen.indexOf('browser.runtime.onMessage.addListener('),
      offscreen.indexOf("window.addEventListener('pagehide'"),
    );
    const gate = "if (!isTrustedOffscreenMessageSender(sender, browser.runtime.id)) return;";
    expect(listener).toContain(gate);
    // The gate runs before any command is read or handled.
    expect(listener.indexOf(gate))
      .toBeLessThan(listener.indexOf('readProbeOcrProviderCommand('));
    expect(listener.indexOf(gate))
      .toBeLessThan(listener.indexOf('readOffscreenOcrCommand('));
  });
});