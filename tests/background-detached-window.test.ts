import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const background = readFileSync(
  new URL('../entrypoints/background.ts', import.meta.url),
  'utf8',
);

describe('background detached companion reuse', () => {
  it('tracks the detached window this worker opened', () => {
    expect(background).toContain(
      'let detachedWindow: { id: number; sourceTabId: number } | undefined;',
    );
    expect(background).toContain(
      'detachedWindow = { id: createdWindow.id, sourceTabId: tab.id };',
    );
  });

  it('focuses the existing window before creating another one', () => {
    const focusIndex = background.indexOf(
      'if (await focusExistingDetachedWindow(identity, clickSequence)) {',
    );
    const createIndex = background.indexOf('await browser.windows.create(');
    expect(focusIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(focusIndex);
    expect(background).toContain('shouldReuseDetachedWindow(');
    expect(background).toContain(
      'await browser.windows.update(existing.id, { focused: true })',
    );
  });

  it('only records a window whose click is still current', () => {
    const staleClose = background.indexOf(
      'await closeStaleDetachedWindow(createdWindow?.id);',
    );
    const record = background.indexOf(
      'detachedWindow = { id: createdWindow.id, sourceTabId: tab.id };',
    );
    expect(staleClose).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(staleClose);
  });

  it('re-authorizes the reused window through the ordered launch message', () => {
    const focusFunction = background.slice(
      background.indexOf('async function focusExistingDetachedWindow('),
      background.indexOf('browser.windows.onRemoved.addListener('),
    );
    expect(focusFunction).toContain("type: 'simul:authorized-tab'");
    expect(focusFunction).toContain('launchEpoch: await toolbarLaunchEpoch');
    expect(focusFunction).toContain('launchSequence: clickSequence');
  });

  it('orders authorizations across worker lifecycles with a persisted generation', () => {
    expect(background).not.toContain('const toolbarLaunchEpoch = crypto.randomUUID();');
    expect(background).toContain('allocateCompanionLaunchGeneration({');
    expect(background).toContain('browser.storage.session.get(');
    expect(background).toContain('browser.storage.session.set({');
    expect(background).toContain('createCompanionLaunchEpoch(');
    const sidePanelLaunch = background.slice(
      background.indexOf('async function finishToolbarSidePanelLaunch('),
      background.indexOf('async function rememberSurface('),
    );
    expect(sidePanelLaunch).toContain("type: 'simul:authorized-tab'");
    expect(sidePanelLaunch).toContain('launchEpoch: await toolbarLaunchEpoch');
  });

  it('forgets the window once it closes', () => {
    expect(background).toContain('browser.windows.onRemoved.addListener(');
    expect(background).toContain(
      'if (detachedWindow?.id === windowId) detachedWindow = undefined;',
    );
  });
});
