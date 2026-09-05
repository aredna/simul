import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { CompanionState } from '../entrypoints/sidepanel/companion-state';
import { SurfaceSwitcher, type SurfaceBrowser } from '../entrypoints/sidepanel/surface-switcher';

const IDENTITY = { tabId: 4, windowId: 1, url: 'https://example.com/a' };

function setup(options: {
  detached?: { tabId: number; windowId: number };
  canClose?: boolean;
  layoutSide?: string;
  failRemember?: boolean;
} = {}) {
  const { document } = parseHTML('<html><body><button id="popout"></button><p id="placement" hidden></p></body></html>');
  const state = new CompanionState({
    isDetachedWindow: options.detached !== undefined,
    ...(options.detached ? { detachedSourceWindowId: options.detached.windowId } : {}),
  });
  const calls: string[] = [];
  const browser: SurfaceBrowser = {
    getWindow: vi.fn(async () => ({ width: 1200, height: 800, left: 0, top: 0 })),
    createWindow: vi.fn(async (data) => calls.push(`create:${(data as { url: string }).url}`)),
    removeWindow: vi.fn(async (windowId) => {
      calls.push(`remove:${windowId}`);
    }),
    queryActiveTab: vi.fn(async () => ({ id: 4, windowId: 1, url: IDENTITY.url, active: true })),
    openSidePanel: vi.fn(async (windowId) => {
      calls.push(`open:${windowId}`);
    }),
    closeSidePanel: options.canClose === false ? undefined : vi.fn(async (windowId) => {
      calls.push(`close:${windowId}`);
    }),
    setSidePanelOptions: vi.fn(async (opts) => {
      calls.push(`options:${opts.enabled}`);
    }),
    getSidePanelLayout: options.layoutSide ? async () => ({ side: options.layoutSide! }) : undefined,
    sendMessage: vi.fn(async (message) => calls.push(`message:${(message as { type: string }).type}`)),
    sidePanelUrl: () => 'chrome-extension://id/sidepanel.html',
    closeSelf: vi.fn(),
  };
  const statuses: string[] = [];
  const rememberSurface = vi.fn(async () => {
    if (options.failRemember) throw new Error('no save');
    return true;
  });
  const switcher = new SurfaceSwitcher({
    state,
    browser,
    detachedIdentityHint: options.detached,
    elements: {
      popoutButton: document.getElementById('popout') as unknown as HTMLButtonElement,
      placementGuidance: document.getElementById('placement') as unknown as HTMLElement,
    },
    rememberSurface,
    setStatus: (message) => statuses.push(message),
    updateControls: () => calls.push('controls'),
  });
  return { switcher, state, browser, calls, statuses, rememberSurface, document };
}

describe('SurfaceSwitcher', () => {
  it('opens a detached window for the captured page and closes the native panel', async () => {
    const harness = setup();
    harness.state.capturedPageIdentity = IDENTITY;
    await harness.switcher.openDetachedWindow();
    expect(harness.calls).toEqual([
      'create:chrome-extension://id/sidepanel.html?sourceTabId=4&sourceWindowId=1',
      'close:1',
    ]);
    expect(harness.rememberSurface).toHaveBeenCalledWith('popout');
    expect(harness.statuses).toEqual([]);
  });

  it('asks for a page first and reports a panel that would not close', async () => {
    const harness = setup({ canClose: false });
    await harness.switcher.openDetachedWindow();
    expect(harness.statuses.at(-1)).toContain('Open a regular page');

    harness.state.followedPageIdentity = IDENTITY;
    (harness.browser.setSidePanelOptions as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error('no'));
    await harness.switcher.openDetachedWindow();
    expect(harness.statuses.at(-1)).toContain('could not close the old side panel');

    const unsaved = setup({ failRemember: true });
    unsaved.state.followedPageIdentity = IDENTITY;
    await unsaved.switcher.openDetachedWindow();
    expect(unsaved.statuses.at(-1)).toContain('could not remember it as the last-used surface');
  });

  it('returns to the side panel, re-authorizes the active tab and closes its window', async () => {
    const harness = setup({ detached: { tabId: 4, windowId: 1 } });
    harness.state.panelWindowId = 9;
    await harness.switcher.returnToSidePanel();
    expect(harness.calls).toEqual(['open:1', 'message:simul:authorized-tab', 'remove:9']);
    expect(harness.rememberSurface).toHaveBeenCalledWith('side-panel');

    const noId = setup({ detached: { tabId: 4, windowId: 1 } });
    await noId.switcher.returnToSidePanel();
    expect(noId.browser.closeSelf).toHaveBeenCalled();
  });

  it('runs one transition at a time from the button', async () => {
    const harness = setup({ detached: { tabId: 4, windowId: 1 } });
    harness.switcher.configureButton();
    expect(harness.document.getElementById('popout')?.getAttribute('aria-label'))
      .toBe('Return companion to the side panel');
    harness.switcher.toggle();
    expect(harness.state.surfaceTransitionInFlight).toBe(true);
    harness.switcher.toggle();
    await vi.waitFor(() => expect(harness.state.surfaceTransitionInFlight).toBe(false));
    expect(harness.browser.openSidePanel).toHaveBeenCalledTimes(1);
  });

  it('shows the placement note only for a left-docked native panel', async () => {
    const left = setup({ layoutSide: 'left' });
    await left.switcher.checkPanelPlacement();
    expect(left.document.getElementById('placement')?.hasAttribute('hidden')).toBe(false);
    const right = setup({ layoutSide: 'right' });
    await right.switcher.checkPanelPlacement();
    expect(right.document.getElementById('placement')?.hasAttribute('hidden')).toBe(true);
    const detached = setup({ detached: { tabId: 4, windowId: 1 }, layoutSide: 'left' });
    await detached.switcher.checkPanelPlacement();
    expect(detached.document.getElementById('placement')?.hasAttribute('hidden')).toBe(true);
  });
});
