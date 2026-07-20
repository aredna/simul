import {
  PREFERENCE_LOCK_NAME,
  PreferenceCoordinator,
  createBrowserPreferenceAdapter,
  readPreferenceCommand,
  type PreferenceCommand,
  type PreferenceCommandResult,
} from '../lib/preference-coordinator';
import { createExtensionBuildIdentity } from '../lib/build-identity';
import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
  resolveCompanionLaunchSurface,
} from '../lib/companion-surface';
import { compiledImageTextProviderIds } from '../lib/ocr/provider-registry';
import { createBrowserOcrOffscreenManager } from '../lib/ocr/offscreen-document-manager';
import { readEnsureOcrHostCommand } from '../lib/ocr/offscreen-protocol';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  parseCompanionPreferences,
  withViewSettings,
  type CompanionSurface,
} from '../lib/preferences';

export default defineBackground(() => {
  const buildIdentity = createExtensionBuildIdentity(
    browser.runtime.getManifest(),
  );
  console.info(buildIdentity.backgroundReadyMessage);

  const coordinator = new PreferenceCoordinator(
    createBrowserPreferenceAdapter(),
  );
  const offscreenManager = createBrowserOcrOffscreenManager();
  let launchPreferences = parseCompanionPreferences(
    DEFAULT_COMPANION_PREFERENCES,
  );
  let launchPreferenceRevision = 0;
  let toolbarBehaviorQueue = Promise.resolve();
  let toolbarClickSequence = 0;
  const toolbarLaunchEpoch = crypto.randomUUID();

  // The action handler below must remain Chrome's authorization boundary.
  // Correct any behavior persisted by an older build as soon as the worker
  // starts so browser-owned side-panel routing cannot swallow action.onClicked.
  queueToolbarBehaviorSync();

  const loadRevision = launchPreferenceRevision;
  const launchPreferencesReady = browser.storage.local.get(STORAGE_KEY).then(
    (stored) => {
      if (launchPreferenceRevision === loadRevision) {
        launchPreferences = parseCompanionPreferences(stored[STORAGE_KEY]);
      }
      queueToolbarBehaviorSync();
    },
    () => {
      queueToolbarBehaviorSync();
    },
  );

  function queueToolbarBehaviorSync(): void {
    toolbarBehaviorQueue = toolbarBehaviorQueue.then(
      () => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
      () => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
    ).catch(() => undefined);
  }

  browser.action.onClicked.addListener((tab) => {
    const clickSequence = ++toolbarClickSequence;
    // sidePanel.open() stays in the synchronous event branch because Chrome
    // requires a direct user gesture. The follow-up message reauthorizes an
    // already-running global panel for the tab that was actually clicked.
    let preopenedSidePanel: Promise<void> | undefined;
    if (tab.windowId !== undefined) {
      preopenedSidePanel = browser.sidePanel.open({ windowId: tab.windowId });
      void preopenedSidePanel.catch(() => undefined);
    }
    void launchToolbarCompanion(
      tab,
      clickSequence,
      preopenedSidePanel,
    ).catch((error: unknown) => {
      console.info('[Simul toolbar launch]', {
        state: 'failed',
        code: launchErrorCode(error),
      });
    });
  });

  async function launchToolbarCompanion(
    tab: Browser.tabs.Tab,
    clickSequence: number,
    preopenedSidePanel?: Promise<void>,
  ): Promise<void> {
    await launchPreferencesReady;
    if (clickSequence !== toolbarClickSequence) return;
    const surface = resolveCompanionLaunchSurface(launchPreferences);
    if (surface === 'side-panel') {
      if (tab.windowId !== undefined) {
        // The panel was synchronously opened at click time before storage
        // hydration so Chrome preserves the user gesture and activeTab grant.
        await finishToolbarSidePanelLaunch(
          tab,
          clickSequence,
          preopenedSidePanel,
        );
      }
      return;
    }
    if (
      tab.id === undefined ||
      tab.windowId === undefined ||
      !isSupportedPage(tab.url)
    ) return;

    const identity = {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
    };
    const sourceWindow = await browser.windows.get(tab.windowId);
    if (clickSequence !== toolbarClickSequence) return;
    const url = createDetachedCompanionUrl(
      browser.runtime.getURL('/sidepanel.html'),
      identity,
    );
    const createdWindow = await browser.windows.create(
      createDetachedWindowData(url, sourceWindow),
    );
    if (clickSequence !== toolbarClickSequence) {
      await closeStaleDetachedWindow(createdWindow?.id);
      return;
    }
    try {
      await rememberSurface('popout');
    } catch {
      // The popup is already a valid companion. Preference persistence is
      // secondary and must not leave two live surfaces or encourage a retry
      // that creates another popup.
      console.info('[Simul toolbar launch]', {
        state: 'preference-save-failed',
        code: 'surface_not_remembered',
      });
    }
    if (clickSequence !== toolbarClickSequence) {
      await closeStaleDetachedWindow(createdWindow?.id);
      return;
    }
    await preopenedSidePanel?.catch(() => undefined);
    await closeSidePanelIfSupported(tab.windowId);
  }

  async function finishToolbarSidePanelLaunch(
    tab: Browser.tabs.Tab,
    clickSequence: number,
    open?: Promise<void>,
  ): Promise<void> {
    await open?.catch(() => undefined);
    if (clickSequence !== toolbarClickSequence) return;
    if (
      tab.id !== undefined &&
      tab.windowId !== undefined &&
      isSupportedPage(tab.url)
    ) {
      await browser.runtime.sendMessage({
        type: 'simul:authorized-tab',
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
        launchEpoch: toolbarLaunchEpoch,
        launchSequence: clickSequence,
      }).catch((error: unknown) => {
        if (!isMissingMessageReceiver(error)) throw error;
      });
    }
    if (clickSequence !== toolbarClickSequence) return;
    await rememberSurface('side-panel');
  }

  async function rememberSurface(surface: CompanionSurface): Promise<void> {
    launchPreferences = withViewSettings(launchPreferences, {
      lastLaunchSurface: surface,
    });
    await coordinator.run({
      type: 'simul:preferences:patch-view',
      patch: { lastLaunchSurface: surface },
    });
  }

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse) => {
      const ensureHost = readEnsureOcrHostCommand(message);
      if (ensureHost) {
        if (!compiledImageTextProviderIds.some(
          (id) => id === 'tesseract' || id === 'chrome-text-detector',
        )) {
          sendResponse({
            kind: 'simul:ocr-v1:host-ready',
            version: 1,
            ready: false,
          });
          return;
        }
        void offscreenManager.ensure().then(
          (ready) => sendResponse({
            kind: 'simul:ocr-v1:host-ready',
            version: 1,
            ready,
          }),
          () => sendResponse({
            kind: 'simul:ocr-v1:host-ready',
            version: 1,
            ready: false,
          }),
        );
        return true;
      }
      const command = readPreferenceCommand(message);
      if (!command) return;

      // Chrome 138 requires the callback + literal-true response pattern.
      // Native Promise-returning onMessage listeners arrived much later.
      void runPreferenceCommand(coordinator, command).then(
        (result) => sendResponse(result),
        (error: unknown) =>
          sendResponse({
            type: 'simul:preferences:error',
            message: readableError(error),
          }),
      );
      return true;
    },
  );

  browser.permissions.onRemoved.addListener(() => {
    void navigator.locks.request(
      PREFERENCE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (lock) {
          await coordinator.run({ type: 'simul:preferences:reconcile' });
        }
      },
    );
  });

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
    launchPreferenceRevision += 1;
    launchPreferences = parseCompanionPreferences(
      changes[STORAGE_KEY]?.newValue,
    );
  });
});

async function closeSidePanelIfSupported(windowId: number): Promise<void> {
  if (typeof browser.sidePanel.close === 'function') {
    const closed = await browser.sidePanel.close({ windowId }).then(
      () => true,
      () => false,
    );
    if (closed) return;
  }
  // Chrome before sidePanel.close() can still tear down this extension's
  // global panel by disabling its default entry. Re-enabling makes it
  // available for the next explicit action without reopening it.
  try {
    await browser.sidePanel.setOptions({ enabled: false });
    await browser.sidePanel.setOptions({ enabled: true });
  } catch {
    // The popup is already usable; inability to close an older panel degrades
    // surface cleanup only.
  }
}

async function closeStaleDetachedWindow(windowId: number | undefined): Promise<void> {
  if (windowId === undefined) return;
  await browser.windows.remove(windowId).catch(() => undefined);
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

function launchErrorCode(error: unknown): string {
  const message = readableError(error).toLowerCase();
  if (message.includes('user gesture')) return 'gesture_required';
  if (message.includes('window')) return 'window_failed';
  return 'launch_failed';
}

function isMissingMessageReceiver(error: unknown): boolean {
  return /receiving end does not exist|could not establish connection/iu.test(
    readableError(error),
  );
}

function runPreferenceCommand(
  coordinator: PreferenceCoordinator,
  command: PreferenceCommand,
): Promise<PreferenceCommandResult> {
  if (command.type !== 'simul:preferences:reconcile') {
    return coordinator.run(command);
  }

  return navigator.locks.request(PREFERENCE_LOCK_NAME, () =>
    coordinator.run(command),
  );
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The preference service could not complete the request.';
}
