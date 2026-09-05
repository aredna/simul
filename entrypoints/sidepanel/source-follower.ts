import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import {
  isFocusedNormalBrowserWindow,
  isNewerCompanionLaunchStamp,
  sameCompanionSourcePage,
  shouldFollowActivatedTab,
  shouldIgnoreInactiveFollowedTabUpdate,
  shouldRecoverRemovedActiveSource,
} from '../../lib/companion-surface';
import { shouldRebuildStaleFollowedReplica } from '../../lib/followed-replica-currency';
import {
  isUrlOnlyNavigationSignal,
  resolveNavigationUpdateStatus,
  type NavigationRefreshGate,
} from '../../lib/navigation-refresh-gate';
import {
  identityFromTab,
  isSupportedPage,
  navigationPageIdentityKey,
  navigationPageScopeKey,
  normalizedPageUrl,
  readPageError,
  type AuthorizedTabRequest,
  type CapturedPageIdentity,
  type DetachedPageIdentityHint,
  type PageTabLike,
} from '../../lib/page-identity';
import type { CaptureReason, CaptureRequest, CompanionState } from './companion-state';
import type { Currency, CurrencyToken } from './currency';

export interface FollowerWindow {
  readonly id?: number | undefined;
  readonly type?: string | undefined;
  readonly focused?: boolean | undefined;
}

export interface FollowerTab extends PageTabLike {
  readonly status?: string | undefined;
}

/** The browser calls the follower makes; faked in tests. */
export interface FollowerBrowser {
  getTab(tabId: number): Promise<FollowerTab>;
  /** The active tab of a window, or of the current window when omitted. */
  queryActiveTab(windowId?: number): Promise<FollowerTab | undefined>;
  getWindow(windowId: number): Promise<FollowerWindow>;
  getCurrentWindowId(): Promise<number | undefined>;
  getLastFocusedNormalWindowId(): Promise<number | undefined>;
  readonly windowIdNone: number;
}

export interface TabChangeInfo {
  readonly status?: string | undefined;
  readonly url?: string | undefined;
}

export interface UpdatedTab {
  readonly windowId: number;
  readonly url?: string | undefined;
  readonly active?: boolean | undefined;
  readonly status?: string | undefined;
}

export interface RemovedTabInfo {
  readonly windowId: number;
  readonly isWindowClosing: boolean;
}

export interface SourceFollowerEnvironment {
  readonly state: CompanionState;
  readonly currency: Currency;
  readonly browser: FollowerBrowser;
  readonly detachedIdentityHint: DetachedPageIdentityHint | undefined;
  readonly navigationDebounceMs: number;
  readonly navigationRefreshGate: NavigationRefreshGate;
  readonly queueCapture: (request: CaptureRequest) => void;
  readonly invalidateCompanion: (message: string) => void;
  /** The source tab started loading another document; page work is stale. */
  readonly onSourceNavigationStarted: (next: CapturedPageIdentity) => void;
  /** The followed document's URL changed without a new document load. */
  readonly onFollowedUrlChanged: (next: CapturedPageIdentity) => void;
  /** The followed tab became the active tab again. */
  readonly onFollowedTabActivated: () => void;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  readonly renderError: (message: string) => void;
  readonly updateControls: () => void;
}

/**
 * Decides which tab the companion follows. Every asynchronous resolution
 * carries an identity token; a newer tab event supersedes it, so a slow
 * lookup for a tab the user already left cannot replace the followed page.
 * A navigation refresh is debounced and re-validates the followed identity
 * when it fires, so focus moving between windows leaves it armed.
 */
export class SourceFollower {
  #navigationTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly environment: SourceFollowerEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  get #isDetachedWindow(): boolean {
    return this.#state.isDetachedWindow;
  }

  /** True while a navigation refresh is armed for the followed tab. */
  get navigationRefreshPending(): boolean {
    return this.#navigationTimer !== undefined;
  }

  /** Drops an armed navigation refresh; a capture is about to run anyway. */
  cancelNavigationRefresh(): void {
    this.#clearNavigationTimer();
  }

  async loadPanelWindowId(): Promise<void> {
    try {
      this.#state.panelWindowId = await this.environment.browser.getCurrentWindowId();
    } catch {
      this.#state.panelWindowId = undefined;
    }
  }

  /** Follows the page the companion was opened for. */
  async initializeSourcePage(): Promise<void> {
    const hint = this.environment.detachedIdentityHint;
    if (hint) {
      const identity = this.#state.preferences.popoutTabMode === 'active'
        ? await this.#readActivePageIdentity(hint.windowId)
        : identityFromTab(await this.environment.browser.getTab(hint.tabId), undefined, false);
      this.#state.followedPageIdentity = identity;
      this.environment.queueCapture({ identity, reason: 'initial' });
      return;
    }
    await this.refreshFollowedPage('initial');
  }

  /** The background worker authorized a tab from the toolbar. */
  async acceptAuthorizedTab(authorization: AuthorizedTabRequest): Promise<void> {
    const state = this.#state;
    const { currency } = this.environment;
    const authorized = authorization.identity;
    const lockedIdentity = state.followedPageIdentity ?? this.environment.detachedIdentityHint;
    if (
      this.#isDetachedWindow &&
      lockedIdentity &&
      state.preferences.popoutTabMode === 'locked' &&
      (authorized.windowId !== lockedIdentity.windowId ||
        authorized.tabId !== lockedIdentity.tabId)
    ) return;
    if (authorization.launchStamp) {
      if (!isNewerCompanionLaunchStamp(
        state.latestToolbarLaunchStamp,
        authorization.launchStamp,
      )) return;
      state.latestToolbarLaunchStamp = authorization.launchStamp;
    }
    const request = currency.begin('identity');
    if (!this.#isDetachedWindow) {
      if (state.panelWindowId === undefined) await this.loadPanelWindowId();
      if (
        !currency.isCurrent(request) ||
        state.panelWindowId === undefined ||
        authorized.windowId !== state.panelWindowId
      ) return;
    }
    if (!currency.isCurrent(request)) return;
    this.#clearNavigationTimer();
    state.followedPageIdentity = authorized;
    this.environment.queueCapture({ identity: authorized, reason: 'authorized' });
  }

  /** Re-reads the followed tab (or the active tab) and rebuilds it. */
  async refreshFollowedPage(reason: CaptureReason): Promise<void> {
    const state = this.#state;
    const { currency } = this.environment;
    const request = currency.begin('identity');
    try {
      const identity = state.followedPageIdentity
        ? await this.#readCurrentFollowedIdentity(state.followedPageIdentity)
        : await this.#readActivePageIdentity();
      if (!currency.isCurrent(request)) return;
      state.followedPageIdentity = identity;
      this.environment.queueCapture({ identity, reason });
    } catch (error) {
      if (!currency.isCurrent(request)) return;
      const message = readPageError(error);
      if (!state.snapshot) this.environment.renderError(message);
      this.environment.setStatus(message, 'error');
      this.environment.updateControls();
    }
  }

  /** In active mode, follows whichever tab is active in the source window. */
  async followCurrentActiveSourceTab(): Promise<void> {
    const state = this.#state;
    const { currency, browser, detachedIdentityHint } = this.environment;
    if (!detachedIdentityHint || state.preferences.popoutTabMode !== 'active') return;
    const request = currency.begin('identity');
    state.activeFollowRequest = request;
    this.#clearNavigationTimer();
    try {
      const lastFocusedId = await browser.getLastFocusedNormalWindowId();
      if (!currency.isCurrent(request) || state.preferences.popoutTabMode !== 'active') return;
      const sourceWindowId =
        lastFocusedId ??
        state.followedPageIdentity?.windowId ??
        state.detachedSourceWindowId ??
        detachedIdentityHint.windowId;
      const tab = await browser.queryActiveTab(sourceWindowId);
      if (!currency.isCurrent(request) || state.preferences.popoutTabMode !== 'active') return;
      if (tab?.id === undefined) {
        this.environment.invalidateCompanion('The source browser window has no active readable tab.');
        return;
      }
      await this.followActivatedSourceTab(tab.id, sourceWindowId, tab, request);
    } catch (error) {
      if (!currency.isCurrent(request)) return;
      this.environment.invalidateCompanion(
        `${readPageError(error)} Active-tab following needs page access for each newly selected site.`,
      );
    } finally {
      this.#finishActiveFollowRequest(request);
    }
  }

  async followActivatedSourceTab(
    tabId: number,
    windowId: number,
    knownTab?: FollowerTab,
    existingRequest?: CurrencyToken,
  ): Promise<void> {
    const state = this.#state;
    const { currency, browser } = this.environment;
    if (
      !shouldFollowActivatedTab(
        this.#isDetachedWindow,
        state.preferences.popoutTabMode,
        state.panelWindowId,
        windowId,
      )
    ) return;

    const request = existingRequest ?? currency.begin('identity');
    if (!currency.isCurrent(request)) return;
    state.activeFollowRequest = request;
    // A pending navigation refresh stays armed (see handleWindowFocusChanged);
    // queueCapture cancels it once a different page is followed.
    try {
      const sourceWindow = await browser.getWindow(windowId);
      if (!currency.isCurrent(request) || state.preferences.popoutTabMode !== 'active') return;
      if (!isFocusedNormalBrowserWindow(sourceWindow)) return;
      const tab = knownTab ?? await browser.getTab(tabId);
      const identity = identityFromTab(tab, undefined, true);
      if (!currency.isCurrent(request) || state.preferences.popoutTabMode !== 'active') return;
      state.detachedSourceWindowId = windowId;
      if (sameCompanionSourcePage(state.followedPageIdentity, identity, normalizedPageUrl)) {
        // Already following this page. If the rendered replica is still an
        // older page of the same tab (a navigation whose refresh never ran),
        // rebuild now instead of leaving the stale mirror frozen (review M1).
        if (shouldRebuildStaleFollowedReplica({
          captureInFlight: state.captureInFlight,
          navigationRefreshPending: this.navigationRefreshPending,
          tabStatus: tab.status,
          captured: state.capturedPageIdentity,
          identity,
          normalizeUrl: normalizedPageUrl,
        })) {
          this.environment.queueCapture({ identity, reason: 'navigation' });
        }
        return;
      }
      this.environment.queueCapture({ identity, reason: 'navigation' });
    } catch (error) {
      if (!currency.isCurrent(request)) return;
      this.environment.invalidateCompanion(
        `${readPageError(error)} Active-tab following needs page access for each newly selected site.`,
      );
    } finally {
      this.#finishActiveFollowRequest(request);
    }
  }

  // --- Browser event handlers.

  handleTabActivated(tabId: number, windowId: number): void {
    const state = this.#state;
    // Images deferred while the followed tab was inactive can be captured
    // again now that it is the active tab.
    if (state.followedPageIdentity?.tabId === tabId) this.environment.onFollowedTabActivated();
    if (
      shouldFollowActivatedTab(
        this.#isDetachedWindow,
        state.preferences.popoutTabMode,
        state.panelWindowId,
        windowId,
      )
    ) {
      void this.followActivatedSourceTab(tabId, windowId);
      return;
    }
    if (
      !this.#isDetachedWindow &&
      state.followedPageIdentity?.windowId === windowId &&
      state.followedPageIdentity.tabId !== tabId
    ) {
      this.environment.currency.supersede('identity');
      state.followedPageIdentity = undefined;
      this.#clearNavigationTimer();
      this.environment.invalidateCompanion(
        'The active tab changed. Select the extension on the page you want to follow.',
      );
    }
  }

  handleWindowFocusChanged(windowId: number): void {
    const state = this.#state;
    if (
      !this.#isDetachedWindow ||
      state.preferences.popoutTabMode !== 'active' ||
      windowId === this.environment.browser.windowIdNone ||
      windowId === state.panelWindowId
    ) return;
    // The pending navigation refresh is left armed: its callback re-validates
    // the followed identity, and clearing it here lost the refresh whenever
    // focus moved within the debounce window (review M1).
    const request = this.environment.currency.begin('identity');
    void this.#followFocusedBrowserWindow(windowId, request);
  }

  handleTabAttached(tabId: number, newWindowId: number): void {
    const state = this.#state;
    if (
      this.#isDetachedWindow &&
      state.followedPageIdentity?.tabId === tabId &&
      newWindowId !== state.panelWindowId
    ) {
      if (state.preferences.popoutTabMode === 'active') {
        void this.followActivatedSourceTab(tabId, newWindowId);
      } else {
        const request = this.environment.currency.begin('identity');
        this.#clearNavigationTimer();
        void this.#followMovedLockedSourceTab(tabId, newWindowId, request);
      }
    }
  }

  handleTabUpdated(tabId: number, changeInfo: TabChangeInfo, tab: UpdatedTab): void {
    const state = this.#state;
    const { navigationRefreshGate } = this.environment;
    const followed = state.followedPageIdentity;
    if (!followed || followed.tabId !== tabId) return;
    // An update from the tab being left can race the activation event for the
    // newly selected tab. In active-follow mode it is stale immediately and
    // must not invalidate the newer identity request.
    if (shouldIgnoreInactiveFollowedTabUpdate(
      this.#isDetachedWindow,
      state.preferences.popoutTabMode,
      tab.active ?? false,
      state.activeFollowRequest !== undefined,
    )) return;
    const hasUrlChange = typeof changeInfo.url === 'string';
    const navigationStatus = resolveNavigationUpdateStatus(
      changeInfo.status,
      tab.status,
      hasUrlChange,
    );
    const nextUrl = changeInfo.url ?? tab.url ?? followed.url;
    if (!isSupportedPage(nextUrl)) {
      if (navigationStatus === 'loading' || hasUrlChange) {
        this.#clearNavigationTimer();
        this.environment.invalidateCompanion(
          'The source tab opened a restricted page. Return to a regular HTTP or HTTPS page and select the extension again.',
        );
      }
      return;
    }
    const nextIdentity = { tabId, windowId: tab.windowId, url: nextUrl };
    const navigationScope = navigationPageScopeKey(nextIdentity);
    const navigationKey = navigationPageIdentityKey(nextIdentity);
    if (navigationStatus === 'loading') {
      if (!navigationRefreshGate.beginDocumentLoad(navigationScope, navigationKey)) {
        state.followedPageIdentity = nextIdentity;
        return;
      }
      this.environment.onSourceNavigationStarted(nextIdentity);
      state.followedPageIdentity = nextIdentity;
      this.#clearNavigationTimer();
      this.environment.setStatus(
        'The source page is changing; the current mirror stays visible until the new page is ready.',
      );
    } else if (isUrlOnlyNavigationSignal(navigationStatus, hasUrlChange)) {
      // Chrome emits URL-only updates for history/hash changes in the current
      // document. The isolated mirror stream owns those DOM changes; rebuilding
      // here would discard stable OCR evidence and replay the entire page.
      const retargetScheduledDocument = navigationRefreshGate
        .observeSameDocumentUrl(navigationScope, navigationKey);
      const retargetPendingDocumentCapture =
        this.navigationRefreshPending && retargetScheduledDocument;
      this.environment.onFollowedUrlChanged(nextIdentity);
      state.followedPageIdentity = nextIdentity;
      // A completed new document may update its history URL during our short
      // debounce. Keep that one authoritative initial capture, retargeted to
      // the current same-document URL, instead of letting the stale timer
      // self-drop.
      if (retargetPendingDocumentCapture) {
        this.#scheduleNavigationRefresh(nextIdentity);
      }
    }
    if (navigationStatus === 'complete') {
      // A redirect may expose its final URL only on the completion signal.
      // Keep the followed identity current before arming the debounce,
      // otherwise its stale-identity guard can discard the only
      // finished-document refresh.
      this.environment.onFollowedUrlChanged(nextIdentity);
      state.followedPageIdentity = nextIdentity;
    }
    if (
      navigationStatus === 'complete' &&
      navigationRefreshGate.shouldScheduleComplete(
        navigationScope,
        navigationKey,
        state.capturedPageIdentity
          ? navigationPageIdentityKey(state.capturedPageIdentity)
          : undefined,
      )
    ) {
      this.#scheduleNavigationRefresh(nextIdentity);
    }
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    if (this.#state.followedPageIdentity?.tabId !== removedTabId) return;
    const request = this.environment.currency.begin('identity');
    this.#clearNavigationTimer();
    void this.#followReplacedSourceTab(addedTabId, request);
  }

  handleTabRemoved(tabId: number, removeInfo: RemovedTabInfo): void {
    const state = this.#state;
    if (state.followedPageIdentity?.tabId !== tabId) return;
    if (shouldRecoverRemovedActiveSource(
      this.#isDetachedWindow,
      state.preferences.popoutTabMode,
      state.panelWindowId,
      removeInfo.windowId,
      removeInfo.isWindowClosing,
    )) {
      const request = this.environment.currency.begin('identity');
      state.activeFollowRequest = request;
      this.#clearNavigationTimer();
      queueMicrotask(() => {
        void this.#followFocusedBrowserWindow(
          removeInfo.windowId,
          request,
          'The source tab was closed and no neighboring readable tab became active.',
        );
      });
      return;
    }
    this.environment.invalidateCompanion('The source tab was closed.');
  }

  // --- Private resolution steps.

  async #followMovedLockedSourceTab(
    tabId: number,
    windowId: number,
    request: CurrencyToken,
  ): Promise<void> {
    const state = this.#state;
    const { currency } = this.environment;
    try {
      const identity = identityFromTab(
        await this.environment.browser.getTab(tabId),
        undefined,
        false,
      );
      if (
        !currency.isCurrent(request) ||
        state.preferences.popoutTabMode !== 'locked' ||
        identity.tabId !== tabId ||
        identity.windowId !== windowId
      ) return;
      state.detachedSourceWindowId = windowId;
      this.environment.queueCapture({ identity, reason: 'navigation' });
    } catch (error) {
      if (!currency.isCurrent(request)) return;
      this.environment.invalidateCompanion(
        `${readPageError(error)} The locked source tab could not be followed after it moved windows.`,
      );
    }
  }

  async #followReplacedSourceTab(tabId: number, request: CurrencyToken): Promise<void> {
    const state = this.#state;
    const { currency } = this.environment;
    if (!currency.isCurrent(request)) return;
    if (this.#isDetachedWindow && state.preferences.popoutTabMode === 'active') {
      state.activeFollowRequest = request;
    }
    try {
      const identity = identityFromTab(
        await this.environment.browser.getTab(tabId),
        undefined,
        state.requiresActiveSourceTab,
      );
      if (!currency.isCurrent(request)) return;
      state.detachedSourceWindowId = identity.windowId;
      this.environment.queueCapture({ identity, reason: 'navigation' });
    } catch (error) {
      if (!currency.isCurrent(request)) return;
      this.environment.invalidateCompanion(
        `${readPageError(error)} Chrome replaced the source tab, but its new page could not be followed.`,
      );
    } finally {
      this.#finishActiveFollowRequest(request);
    }
  }

  async #followFocusedBrowserWindow(
    windowId: number,
    request: CurrencyToken,
    missingTabMessage?: string,
  ): Promise<void> {
    const state = this.#state;
    const { currency, browser } = this.environment;
    if (!currency.isCurrent(request) || state.preferences.popoutTabMode !== 'active') {
      // handleTabRemoved marks its request before the microtask that reaches
      // here. A request superseded in that gap must still release the marker,
      // or updates for the followed tab stay ignored until the next follow.
      this.#finishActiveFollowRequest(request);
      return;
    }
    state.activeFollowRequest = request;
    try {
      const sourceWindow = await browser.getWindow(windowId);
      if (!currency.isCurrent(request) || state.preferences.popoutTabMode !== 'active') return;
      if (!isFocusedNormalBrowserWindow(sourceWindow)) return;
      const tab = await browser.queryActiveTab(windowId);
      if (!currency.isCurrent(request) || state.preferences.popoutTabMode !== 'active') return;
      state.detachedSourceWindowId = windowId;
      if (tab?.id !== undefined) {
        await this.followActivatedSourceTab(tab.id, windowId, tab, request);
      } else if (missingTabMessage && currency.isCurrent(request)) {
        this.environment.invalidateCompanion(missingTabMessage);
      }
    } catch {
      if (missingTabMessage && currency.isCurrent(request)) {
        this.environment.invalidateCompanion(missingTabMessage);
      }
      // A closing or restricted browser window is not a new source candidate.
    } finally {
      this.#finishActiveFollowRequest(request);
    }
  }

  #finishActiveFollowRequest(request: CurrencyToken): void {
    if (this.#state.activeFollowRequest?.id === request.id) {
      this.#state.activeFollowRequest = undefined;
    }
  }

  #scheduleNavigationRefresh(identity: CapturedPageIdentity): void {
    this.#clearNavigationTimer();
    this.#navigationTimer = setTimeout(() => {
      this.#navigationTimer = undefined;
      const followed = this.#state.followedPageIdentity;
      if (
        followed?.tabId !== identity.tabId ||
        followed.windowId !== identity.windowId ||
        navigationPageIdentityKey(followed) !== navigationPageIdentityKey(identity)
      ) return;
      this.environment.queueCapture({ identity, reason: 'navigation' });
    }, this.environment.navigationDebounceMs);
  }

  #clearNavigationTimer(): void {
    if (this.#navigationTimer !== undefined) clearTimeout(this.#navigationTimer);
    this.#navigationTimer = undefined;
  }

  async #readActivePageIdentity(sourceWindowId?: number): Promise<CapturedPageIdentity> {
    const tab = await this.environment.browser.queryActiveTab(sourceWindowId);
    return identityFromTab(tab, undefined, true);
  }

  async #readCurrentFollowedIdentity(
    followed: CapturedPageIdentity,
  ): Promise<CapturedPageIdentity> {
    const tab = await this.environment.browser.getTab(followed.tabId);
    return identityFromTab(tab, followed.url, this.#state.requiresActiveSourceTab);
  }
}
