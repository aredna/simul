import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
  resolveCompanionLaunchSurface,
  shouldCloseStalePreopenedSidePanel,
  shouldPreopenSidePanel,
  shouldReuseDetachedWindow,
  type BrowserWindowGeometry,
  type DetachedCompanionWindow,
  type DetachedWindowCreateData,
} from './companion-surface';
import type {
  AuthorizedTabMessage,
  CompanionWindowClickMessage,
  UnreadableTabMessage,
} from './page-identity';
import type { CompanionPreferences, CompanionSurface } from './preferences';

/** The facts of the clicked tab the launch reads. */
export interface ToolbarLaunchTab {
  readonly id?: number;
  readonly windowId?: number;
  readonly url?: string;
  readonly pendingUrl?: string;
}

/**
 * What the launch needs from the browser and the worker. `sidePanel` and
 * `windows` have the shape of Chrome's own APIs, so the entrypoint passes
 * them through.
 */
export interface ToolbarLaunchEnvironment {
  readonly sidePanel: {
    open(options: { windowId: number }): Promise<void>;
    /** Absent before Chrome 141. */
    readonly close?: (options: { windowId: number }) => Promise<void>;
    setOptions(options: { enabled: boolean }): Promise<void>;
  };
  readonly windows: {
    get(windowId: number): Promise<BrowserWindowGeometry & { readonly type?: string }>;
    create(
      data: DetachedWindowCreateData,
    ): Promise<{ readonly id?: number } | undefined>;
    update(windowId: number, update: { focused: true }): Promise<unknown>;
    remove(windowId: number): Promise<void>;
  };
  /** Resolves with what a companion that heard the message answered, if any did. */
  sendMessage(
    message: AuthorizedTabMessage | UnreadableTabMessage | CompanionWindowClickMessage,
  ): Promise<unknown>;
  /** The address of the companion page inside the extension. */
  companionPageUrl(): string;
  /**
   * The separate companion windows open now, whoever opened them, each
   * with the tab its address names (D134). Absent in tests that need none.
   */
  readonly companionWindows?: () => Promise<readonly DetachedCompanionWindow[]>;
  /** The launch preferences as the worker holds them now. */
  preferences(): Pick<
    CompanionPreferences,
    'launchBehavior' | 'lastLaunchSurface' | 'popoutTabMode'
  >;
  /** False until the saved preferences were read after the worker started. */
  preferencesHydrated(): boolean;
  readonly preferencesReady: Promise<unknown>;
  readonly launchEpoch: Promise<string>;
  rememberSurface(surface: CompanionSurface): Promise<void>;
  /** A clock that only goes forward, in milliseconds (`performance.now()`). */
  now(): number;
  /** Development diagnostics only. */
  report?(state: string, code: string): void;
}

// How many companion pages found among the extension's contexts a click
// asks Chrome about before it opens a window of its own.
const MAX_FOUND_WINDOWS = 8;

/**
 * How long after a toolbar click the closing of a companion window can
 * still be the closing that the click fell into. Chrome keeps a closing
 * window, listed and brought forward without an error, until its page has
 * unloaded, and gives the page half a second for that: with a busy page the
 * window was gone 503 to 520 ms after the close (Chrome 138 and 154). The
 * rest is for the news to reach the worker. A window that goes later than
 * this after the click was closed after it, and stays closed.
 */
export const CLOSING_WINDOW_HOLD_MS = 600;

/**
 * Opens the companion for a toolbar click: the side panel or the separate
 * window, whichever the saved preferences select. Clicks are numbered, and a
 * click that a later one superseded stops at its next step.
 */
export class ToolbarLauncher {
  readonly #environment: ToolbarLaunchEnvironment;
  #clickSequence = 0;
  #latestClickWindowId: number | undefined;
  #latestClickAt = 0;
  // The detached companion window a toolbar click last opened or took over,
  // so a second click focuses it instead of opening another one. A window
  // the worker does not know (the panel's own button opened it, or the
  // worker has restarted since) is looked for among the open ones (D134).
  #detachedWindow: DetachedCompanionWindow | undefined;
  // The newest authorization sent to the companion window. A window that a
  // newer click took over while its page was still loading was not
  // listening when the message went out; it asks for it when it starts
  // (D121).
  #windowAuthorization:
    | { readonly windowId: number; readonly message: AuthorizedTabMessage }
    | undefined;
  // The newest click that brought a companion window forward and has not
  // heard from that window's page. Chrome still lists a window that is
  // closing, and brings it forward without an error, so only the page can
  // say that the window is there: it answers the click's message, or asks
  // for it when it starts. If the window closes first, and soon enough to
  // have been closing when it was clicked, the click opens one.
  #unanswered:
    | {
        readonly windowId: number;
        readonly tab: ToolbarLaunchTab;
        readonly clickSequence: number;
        readonly clickedAt: number;
      }
    | undefined;

  constructor(environment: ToolbarLaunchEnvironment) {
    this.#environment = environment;
  }

  /** Call in the action click's own turn; resolves when the launch is over. */
  click(tab: ToolbarLaunchTab): Promise<void> {
    const clickSequence = ++this.#clickSequence;
    this.#latestClickWindowId = tab.windowId;
    this.#latestClickAt = this.#environment.now();
    // sidePanel.open() stays in the synchronous event branch because Chrome
    // requires a direct user gesture. The follow-up message reauthorizes an
    // already-running global panel for the tab that was actually clicked.
    let preopenedSidePanel: Promise<void> | undefined;
    if (
      tab.windowId !== undefined &&
      shouldPreopenSidePanel(
        this.#environment.preferences(),
        this.#environment.preferencesHydrated(),
      )
    ) {
      preopenedSidePanel = this.#environment.sidePanel.open({
        windowId: tab.windowId,
      });
      void preopenedSidePanel.catch(() => undefined);
    }
    return this.#launch(tab, clickSequence, preopenedSidePanel);
  }

  /**
   * Forgets the companion window once it closes. A click that brought this
   * window forward and never heard from its page is launched again when
   * the window goes within the time Chrome holds a closing window: it was
   * closing when it was clicked, so the click opens one. A window that goes
   * later was closed after the click, whatever kept its page from
   * answering (busy, frozen, discarded): the click is over. Like any
   * launch, the new one stops at once when a newer click has come.
   * Resolves when the launch is over.
   */
  async windowRemoved(windowId: number): Promise<void> {
    if (this.#detachedWindow?.id === windowId) this.#detachedWindow = undefined;
    if (this.#windowAuthorization?.windowId === windowId) {
      this.#windowAuthorization = undefined;
    }
    const unanswered = this.#unanswered;
    if (unanswered?.windowId !== windowId) return;
    this.#unanswered = undefined;
    if (this.#environment.now() - unanswered.clickedAt > CLOSING_WINDOW_HOLD_MS) return;
    await this.#launch(unanswered.tab, unanswered.clickSequence);
  }

  /**
   * The newest toolbar authorization sent to the companion window
   * `windowId`, for that window's page to ask for when it starts: the
   * message may have gone out before the page could listen (D121). The page
   * orders it against what it already has by its launch stamp, as it does a
   * message. A page that asks has started: the click that brought its window
   * forward has its answer.
   */
  windowAuthorization(windowId: number | undefined): AuthorizedTabMessage | undefined {
    if (windowId !== undefined && this.#unanswered?.windowId === windowId) {
      this.#unanswered = undefined;
    }
    return windowId !== undefined && this.#windowAuthorization?.windowId === windowId
      ? this.#windowAuthorization.message
      : undefined;
  }

  async #launch(
    tab: ToolbarLaunchTab,
    clickSequence: number,
    preopenedSidePanel?: Promise<void>,
  ): Promise<void> {
    await this.#environment.preferencesReady;
    if (clickSequence !== this.#clickSequence) {
      // The saved choice is not looked at here: only a panel this click
      // opened itself, ahead of it, is closed.
      await this.#closeSupersededSidePanel(
        tab,
        clickSequence,
        preopenedSidePanel,
        preopenedSidePanel !== undefined,
      );
      return;
    }
    const surface = resolveCompanionLaunchSurface(this.#environment.preferences());
    if (surface === 'side-panel') {
      if (tab.windowId !== undefined) {
        // The panel was synchronously opened at click time before storage
        // hydration so Chrome preserves the user gesture and activeTab grant.
        await this.#finishSidePanelLaunch(tab, clickSequence, preopenedSidePanel);
      }
      return;
    }
    // A tab Simul cannot read still gets the window: it says why and offers
    // a PDF from this computer, the way in for a file:// tab (D107).
    if (tab.id === undefined || tab.windowId === undefined) return;

    const identity = {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? '',
    };
    if (await this.#focusExistingDetachedWindow(tab, identity, clickSequence)) {
      await this.#closeSidePanelBesideWindow(
        tab,
        tab.windowId,
        clickSequence,
        preopenedSidePanel,
      );
      return;
    }
    if (clickSequence !== this.#clickSequence) {
      await this.#closeSupersededSidePanel(tab, clickSequence, preopenedSidePanel);
      return;
    }
    const sourceWindow = await this.#environment.windows.get(tab.windowId);
    if (clickSequence !== this.#clickSequence) {
      await this.#closeSupersededSidePanel(tab, clickSequence, preopenedSidePanel);
      return;
    }
    const url = createDetachedCompanionUrl(
      this.#environment.companionPageUrl(),
      identity,
    );
    const createdWindow = await this.#environment.windows.create(
      createDetachedWindowData(url, sourceWindow),
    );
    if (clickSequence !== this.#clickSequence) {
      await this.#closeStaleDetachedWindow(createdWindow?.id);
      await this.#closeSupersededSidePanel(tab, clickSequence, preopenedSidePanel);
      return;
    }
    if (createdWindow?.id !== undefined) {
      this.#detachedWindow = { id: createdWindow.id, sourceTabId: tab.id };
    }
    try {
      await this.#environment.rememberSurface('popout');
    } catch {
      // The popup is already a valid companion. Preference persistence is
      // secondary and must not leave two live surfaces or encourage a retry
      // that creates another popup.
      this.#environment.report?.('preference-save-failed', 'surface_not_remembered');
    }
    // The window is remembered by now, so a newer click may already have
    // taken it over: it stays open even when this click was superseded
    // (D121). Removing it here left no companion at all.
    await this.#closeSidePanelBesideWindow(
      tab,
      tab.windowId,
      clickSequence,
      preopenedSidePanel,
    );
  }

  /**
   * Reuse a companion window that is already open: the one a toolbar click
   * opened, else one found among the open windows. Returns false when there
   * is none to reuse or the click was superseded while checking, so the
   * caller's own currency check decides what happens next.
   */
  async #focusExistingDetachedWindow(
    tab: ToolbarLaunchTab,
    identity: { tabId: number; windowId: number; url: string },
    clickSequence: number,
  ): Promise<boolean> {
    const reusable = (window: DetachedCompanionWindow) => shouldReuseDetachedWindow(
      this.#environment.preferences().popoutTabMode,
      window.sourceTabId,
      identity.tabId,
    );
    let existing = this.#detachedWindow;
    if (existing && !reusable(existing)) existing = undefined;
    if (existing) {
      const known = existing;
      if (!await this.#isOpenCompanionWindow(known.id)) {
        if (this.#detachedWindow?.id === known.id) this.#detachedWindow = undefined;
        existing = undefined;
      }
    }
    if (!existing) {
      if (!this.#environment.companionWindows) return false;
      const found = await this.#findOpenDetachedWindow(identity.tabId, reusable);
      if (!found || clickSequence !== this.#clickSequence) return false;
      // Taken over: a click that is still opening this very window finds
      // that out and leaves it open.
      this.#detachedWindow = found;
      existing = found;
    }
    if (clickSequence !== this.#clickSequence) return false;
    const focused = await this.#environment.windows.update(existing.id, { focused: true }).then(
      () => true,
      () => false,
    );
    if (!focused) {
      // The window closed meanwhile (Chrome lists a closing window's page
      // for a moment): there is none to reuse, and the caller opens one.
      if (this.#detachedWindow?.id === existing.id) this.#detachedWindow = undefined;
      return false;
    }
    // The window came forward, which a closing window does too: until its
    // page answers, this click is the one that opens a window if this one
    // closes.
    if (clickSequence === this.#clickSequence) {
      this.#unanswered = {
        windowId: existing.id,
        tab,
        clickSequence,
        clickedAt: this.#latestClickAt,
      };
    }
    // A tab Simul cannot read only brings the window forward.
    if (!isSupportedPage(identity.url)) {
      await this.#sendToWindow(clickSequence, {
        type: 'simul:companion-window-click',
        companionWindowId: existing.id,
      });
      return true;
    }
    // The window retargets (or re-authorizes its locked tab) through the same
    // ordered message a side-panel launch uses.
    const message: AuthorizedTabMessage = {
      type: 'simul:authorized-tab',
      tabId: identity.tabId,
      windowId: identity.windowId,
      url: identity.url,
      launchEpoch: await this.#environment.launchEpoch,
      launchSequence: clickSequence,
      companionWindowId: existing.id,
    };
    // Kept for a window whose page is not listening yet; the newest click's
    // stays when two sends cross.
    const kept = this.#windowAuthorization;
    if (
      kept?.windowId !== existing.id ||
      (kept.message.launchSequence ?? 0) < clickSequence
    ) {
      this.#windowAuthorization = { windowId: existing.id, message };
    }
    await this.#sendToWindow(clickSequence, message);
    return true;
  }

  /**
   * Sends a click's message to the companion window it brought forward.
   * The window's page answers `true`: the click then has its window.
   */
  async #sendToWindow(
    clickSequence: number,
    message: AuthorizedTabMessage | CompanionWindowClickMessage,
  ): Promise<void> {
    if (await this.#send(message) !== true) return;
    const unanswered = this.#unanswered;
    if (
      unanswered !== undefined &&
      unanswered.windowId === message.companionWindowId &&
      unanswered.clickSequence === clickSequence
    ) this.#unanswered = undefined;
  }

  async #finishSidePanelLaunch(
    tab: ToolbarLaunchTab,
    clickSequence: number,
    open?: Promise<void>,
  ): Promise<void> {
    await open?.catch(() => undefined);
    if (clickSequence !== this.#clickSequence) return;
    // A tab Simul cannot read is told to the panel too, without its
    // address: an open panel then says why instead of keeping the page it
    // showed, and offers a PDF from this computer (D112). A panel that is
    // only now opening finds that out by itself. A tab still loading a web
    // page is neither: nothing is sent, as before.
    const message: AuthorizedTabMessage | UnreadableTabMessage | undefined =
      tab.id === undefined || tab.windowId === undefined
        ? undefined
        : isSupportedPage(tab.url)
          ? {
              type: 'simul:authorized-tab',
              tabId: tab.id,
              windowId: tab.windowId,
              url: tab.url,
              launchEpoch: await this.#environment.launchEpoch,
              launchSequence: clickSequence,
            }
          : isSupportedPage(tab.pendingUrl)
            ? undefined
            : {
                type: 'simul:unreadable-tab',
                tabId: tab.id,
                windowId: tab.windowId,
                localFile: isLocalFile(tab.url),
                launchEpoch: await this.#environment.launchEpoch,
                launchSequence: clickSequence,
              };
    if (message) await this.#send(message);
    if (clickSequence !== this.#clickSequence) return;
    await this.#environment.rememberSurface('side-panel');
  }

  /**
   * Resolves with the answer, if a companion gave one. No companion is open
   * yet when nothing receives the message.
   */
  #send(
    message: AuthorizedTabMessage | UnreadableTabMessage | CompanionWindowClickMessage,
  ): Promise<unknown> {
    return this.#environment.sendMessage(message).catch((error: unknown) => {
      if (!isMissingMessageReceiver(error)) throw error;
      return undefined;
    });
  }

  /**
   * The separate window is the companion now, so the clicked window's side
   * panel closes: the one this click opened in its own turn, or one left
   * from before.
   */
  async #closeSidePanelBesideWindow(
    tab: ToolbarLaunchTab,
    windowId: number,
    clickSequence: number,
    preopenedSidePanel: Promise<void> | undefined,
  ): Promise<void> {
    await preopenedSidePanel?.catch(() => undefined);
    if (clickSequence !== this.#clickSequence) {
      await this.#closeSupersededSidePanel(tab, clickSequence, preopenedSidePanel);
      return;
    }
    if (await this.#closeSidePanelOfWindow(windowId)) return;
    // Chrome before sidePanel.close() can still tear down this extension's
    // global panel by disabling its default entry. Re-enabling makes it
    // available for the next explicit action without reopening it.
    try {
      await this.#environment.sidePanel.setOptions({ enabled: false });
      await this.#environment.sidePanel.setOptions({ enabled: true });
    } catch {
      // The popup is already usable; inability to close an older panel degrades
      // surface cleanup only.
    }
  }

  /**
   * A click that a newer click in another window superseded closes its own
   * window's side panel, at whichever step it finds out (D121): only the
   * first step did, so the panel stayed open beside the newer click's
   * window. On the way to the separate window that is the window's panel
   * whoever opened it (`panelToClose`, true by default), as a click that
   * was not superseded closes it; at the first step, where the saved choice
   * is not looked at, only a panel this click opened itself. It closes
   * nothing else. The fallback for Chrome before 141 closes the panel in
   * every window, the newer click's too, so a click that lost never runs
   * it; there the panel stays until the newer click's own cleanup. Never
   * the same window: its newer click may be relying on that exact
   * user-gesture open.
   */
  async #closeSupersededSidePanel(
    tab: ToolbarLaunchTab,
    clickSequence: number,
    preopenedSidePanel: Promise<void> | undefined,
    panelToClose = true,
  ): Promise<void> {
    if (!this.#supersededFromAnotherWindow(tab, clickSequence, panelToClose)) return;
    await preopenedSidePanel?.catch(() => undefined);
    // A click in this window may have come while the open settled.
    if (
      tab.windowId === undefined ||
      !this.#supersededFromAnotherWindow(tab, clickSequence, panelToClose)
    ) return;
    await this.#closeSidePanelOfWindow(tab.windowId);
  }

  #supersededFromAnotherWindow(
    tab: ToolbarLaunchTab,
    clickSequence: number,
    panelToClose: boolean,
  ): boolean {
    return shouldCloseStalePreopenedSidePanel(
      clickSequence,
      this.#clickSequence,
      tab.windowId,
      this.#latestClickWindowId,
      panelToClose,
    );
  }

  /** False where Chrome has no sidePanel.close() or the close failed. */
  async #closeSidePanelOfWindow(windowId: number): Promise<boolean> {
    const sidePanel = this.#environment.sidePanel;
    if (typeof sidePanel.close !== 'function') return false;
    return sidePanel.close({ windowId }).then(
      () => true,
      () => false,
    );
  }

  async #closeStaleDetachedWindow(windowId: number | undefined): Promise<void> {
    if (windowId === undefined) return;
    // A newer click found this window among the open ones and took it over.
    if (this.#detachedWindow?.id === windowId) return;
    await this.#environment.windows.remove(windowId).catch(() => undefined);
  }

  /**
   * A companion window the worker does not know: the one opened for the
   * clicked tab, else any that may be reused for it. Only a window of its
   * own counts: the companion page shown as a tab of a browser window
   * (Chrome's "Show as tab") is no window to bring forward, nor is one
   * that is closing.
   */
  async #findOpenDetachedWindow(
    tabId: number,
    reusable: (window: DetachedCompanionWindow) => boolean,
  ): Promise<DetachedCompanionWindow | undefined> {
    let open: readonly DetachedCompanionWindow[];
    try {
      open = await this.#environment.companionWindows?.() ?? [];
    } catch {
      // Not knowing costs one more window, as before.
      return undefined;
    }
    const candidates = [
      ...open.filter((window) => window.sourceTabId === tabId),
      ...open.filter((window) => window.sourceTabId !== tabId && reusable(window)),
    ];
    for (const candidate of candidates.slice(0, MAX_FOUND_WINDOWS)) {
      if (await this.#isOpenCompanionWindow(candidate.id)) return candidate;
    }
    return undefined;
  }

  /** Whether `windowId` is an open window of the companion's own kind. */
  #isOpenCompanionWindow(windowId: number): Promise<boolean> {
    return this.#environment.windows.get(windowId).then(
      (window) => window.type === 'popup',
      () => false,
    );
  }
}

function isSupportedPage(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isLocalFile(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === 'file:';
  } catch {
    return false;
  }
}

function isMissingMessageReceiver(error: unknown): boolean {
  return /receiving end does not exist|could not establish connection/iu.test(
    error instanceof Error ? error.message : '',
  );
}
