import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const background = readFileSync(
  new URL('../entrypoints/background.ts', import.meta.url),
  'utf8',
);

// The launch itself is lib/toolbar-launch.ts, driven with fakes in
// toolbar-launch.test.ts. These check the entrypoint's wiring.
describe('background toolbar launch wiring', () => {
  it('runs the launch in the click listener\'s own turn', () => {
    const listener = background.slice(
      background.indexOf('browser.action.onClicked.addListener((tab) => {'),
      background.indexOf('browser.windows.onRemoved.addListener('),
    );
    expect(listener).toContain('void toolbarLauncher.click(tab).catch(');
    // Chrome needs sidePanel.open() inside the gesture: nothing is awaited
    // before the launcher is called.
    expect(listener.slice(0, listener.indexOf('toolbarLauncher.click(tab)')))
      .not.toContain('await');
  });

  it('hands the launcher Chrome\'s own side panel and window APIs and the live preferences', () => {
    const wiring = background.slice(
      background.indexOf('const toolbarLauncher = new ToolbarLauncher({'),
      background.indexOf('browser.action.onClicked.addListener('),
    );
    expect(wiring).toContain('sidePanel: browser.sidePanel,');
    expect(wiring).toContain('windows: browser.windows,');
    expect(wiring).toContain('preferences: () => launchPreferences,');
    expect(wiring).toContain('preferencesHydrated: () => launchPreferencesHydrated,');
    expect(wiring).toContain('preferencesReady: launchPreferencesReady,');
    expect(wiring).toContain('launchEpoch: toolbarLaunchEpoch,');
    expect(wiring).toContain("browser.runtime.getURL('/sidepanel.html')");
  });

  it('orders authorizations across worker lifecycles with a persisted generation', () => {
    expect(background).not.toContain('const toolbarLaunchEpoch = crypto.randomUUID();');
    expect(background).toContain('allocateCompanionLaunchGeneration({');
    expect(background).toContain('browser.storage.session.get(');
    expect(background).toContain('browser.storage.session.set({');
    expect(background).toContain('createCompanionLaunchEpoch(');
  });

  it('answers a starting companion window with the authorization kept for it (D121)', () => {
    const listener = background.slice(
      background.indexOf('browser.runtime.onMessage.addListener('),
      background.indexOf('browser.permissions.onRemoved.addListener('),
    );
    expect(listener).toContain('if (isWindowAuthorizationRequest(message)) {');
    // Only the window the message was sent to is answered: the sender's own.
    expect(listener).toContain(
      'toolbarLauncher.windowAuthorization(sender.tab?.windowId) ?? null',
    );
  });

  it('forgets the window once it closes', () => {
    expect(background).toContain('browser.windows.onRemoved.addListener(');
    expect(background).toContain('toolbarLauncher.windowRemoved(windowId);');
  });
});
