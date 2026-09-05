import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
} from '../../lib/companion-surface';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import {
  isSupportedPage,
  readableError,
  type DetachedPageIdentityHint,
  type PageTabLike,
} from '../../lib/page-identity';
import type { CompanionSurface } from '../../lib/preferences';
import type { CompanionState } from './companion-state';

type SourceWindow = Parameters<typeof createDetachedWindowData>[1];

/** The browser calls the switcher makes; faked in tests. */
export interface SurfaceBrowser {
  getWindow(windowId: number): Promise<SourceWindow>;
  createWindow(data: ReturnType<typeof createDetachedWindowData>): Promise<unknown>;
  removeWindow(windowId: number): Promise<void>;
  queryActiveTab(windowId: number): Promise<PageTabLike | undefined>;
  openSidePanel(windowId: number): Promise<void>;
  /** Present on Chrome builds that expose sidePanel.close. */
  readonly closeSidePanel?: ((windowId: number) => Promise<void>) | undefined;
  setSidePanelOptions(options: { enabled: boolean }): Promise<void>;
  /** Present on Chrome builds that expose sidePanel.getLayout. */
  readonly getSidePanelLayout?: (() => Promise<{ side: string }>) | undefined;
  sendMessage(message: unknown): Promise<unknown>;
  /** The extension URL of the companion page. */
  sidePanelUrl(): string;
  /** Closes this window when Chrome did not report its id. */
  closeSelf(): void;
}

export interface SurfaceSwitcherEnvironment {
  readonly state: CompanionState;
  readonly browser: SurfaceBrowser;
  readonly detachedIdentityHint: DetachedPageIdentityHint | undefined;
  readonly elements: {
    readonly popoutButton: HTMLButtonElement;
    readonly placementGuidance: HTMLElement;
  };
  readonly rememberSurface: (surface: CompanionSurface) => Promise<unknown>;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  readonly updateControls: () => void;
}

/**
 * Moves the companion between the native side panel and a detached window
 * and remembers the last-used surface. Returning to the side panel keeps the
 * open call before the first await, as Chrome requires for a user gesture.
 */
export class SurfaceSwitcher {
  constructor(private readonly environment: SurfaceSwitcherEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  /** Labels the surface button for the direction it will move. */
  configureButton(): void {
    if (!this.#state.isDetachedWindow) return;
    const { popoutButton } = this.environment.elements;
    popoutButton.textContent = '↙';
    popoutButton.setAttribute('aria-label', 'Return companion to the side panel');
    popoutButton.title = 'Return to side panel';
  }

  /** The surface button was clicked. */
  toggle(): void {
    const state = this.#state;
    if (state.surfaceTransitionInFlight) return;
    state.surfaceTransitionInFlight = true;
    this.environment.updateControls();
    void (state.isDetachedWindow ? this.returnToSidePanel() : this.openDetachedWindow())
      .finally(() => {
        state.surfaceTransitionInFlight = false;
        this.environment.updateControls();
      });
  }

  async openDetachedWindow(): Promise<void> {
    const { browser, setStatus } = this.environment;
    const identity = this.#state.capturedOrFollowedIdentity;
    if (!identity) {
      setStatus('Open a regular page before detaching the companion.', 'warning');
      return;
    }
    try {
      const sourceWindow = await browser.getWindow(identity.windowId);
      const url = createDetachedCompanionUrl(browser.sidePanelUrl(), identity);
      await browser.createWindow(createDetachedWindowData(url, sourceWindow));
      let preferenceSaveFailed = false;
      try {
        await this.environment.rememberSurface('popout');
      } catch {
        preferenceSaveFailed = true;
      }
      const closed = await this.#closeNativeSidePanel(identity.windowId);
      if (!closed || preferenceSaveFailed) {
        setStatus(
          !closed
            ? 'Detached window opened, but Chrome could not close the old side panel automatically. Close it manually.'
            : 'Detached window opened, but Chrome could not remember it as the last-used surface.',
          'warning',
        );
      }
    } catch (error) {
      setStatus(`Chrome could not open a detached window: ${readableError(error)}`, 'error');
    }
  }

  async returnToSidePanel(): Promise<void> {
    const state = this.#state;
    const { browser, setStatus } = this.environment;
    const sourceWindowId =
      state.followedPageIdentity?.windowId ??
      state.detachedSourceWindowId ??
      this.environment.detachedIdentityHint?.windowId;
    if (sourceWindowId === undefined) return;

    // Keep this call before the first await. Chrome requires sidePanel.open()
    // to remain directly associated with the user's button gesture.
    const openPromise = browser.openSidePanel(sourceWindowId);
    const activeTabPromise = browser.queryActiveTab(sourceWindowId);
    try {
      const [, tab] = await Promise.all([openPromise, activeTabPromise]);
      try {
        await this.environment.rememberSurface('side-panel');
      } catch {
        // A successfully opened side panel remains authoritative even if the
        // optional last-used preference could not be persisted.
      }
      if (tab?.id !== undefined && isSupportedPage(tab.url)) {
        await browser.sendMessage({
          type: 'simul:authorized-tab',
          tabId: tab.id,
          windowId: sourceWindowId,
          url: tab.url,
        }).catch((error: unknown) => {
          if (!/receiving end does not exist|could not establish connection/iu.test(
            readableError(error),
          )) throw error;
        });
      }
      if (state.panelWindowId !== undefined) {
        await browser.removeWindow(state.panelWindowId);
      } else {
        browser.closeSelf();
      }
    } catch (error) {
      setStatus(`Chrome could not return to the side panel: ${readableError(error)}`, 'error');
    }
  }

  /** Shows the placement note when the native panel sits on the left. */
  async checkPanelPlacement(): Promise<void> {
    const { browser, elements } = this.environment;
    if (this.environment.detachedIdentityHint) return;
    if (typeof browser.getSidePanelLayout !== 'function') return;
    try {
      const layout = await browser.getSidePanelLayout();
      elements.placementGuidance.hidden = layout.side !== 'left';
    } catch {
      // Chrome 138 does not expose placement inspection in every channel.
    }
  }

  async #closeNativeSidePanel(windowId: number): Promise<boolean> {
    const { browser } = this.environment;
    if (typeof browser.closeSidePanel === 'function') {
      try {
        await browser.closeSidePanel(windowId);
        return true;
      } catch {
        // Fall through to the pre-close API teardown below.
      }
    }
    try {
      await browser.setSidePanelOptions({ enabled: false });
      await browser.setSidePanelOptions({ enabled: true });
      return true;
    } catch {
      return false;
    }
  }
}
