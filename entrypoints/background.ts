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
  COMPANION_LAUNCH_GENERATION_STORAGE_KEY,
  allocateCompanionLaunchGeneration,
  createCompanionLaunchEpoch,
} from '../lib/companion-surface';
import { compiledImageTextProviderIds } from '../lib/ocr/provider-registry';
import { hasOcrRuntimeProvider } from '../lib/ocr/runtime-provider-readiness';
import { createBrowserOcrOffscreenManager } from '../lib/ocr/offscreen-document-manager';
import { IndexedDbTransientImageStore } from '../lib/ocr/transient-image-store';
import { readEnsureOcrHostCommand } from '../lib/ocr/offscreen-protocol';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  parseCompanionPreferences,
  selectLiveCompanionPreferenceChange,
  selectLatestCompanionPreferences,
  type CompanionSurface,
} from '../lib/preferences';
import {
  PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY,
  PREFERENCE_SAFETY_PORT_NAME,
  PreferenceSafetyCoordinator,
  type PreferenceSafetyJournalAdapter,
  type PreferenceSafetyOperation,
  type PreferenceSafetyPort,
  type PreferenceSafetyTicket,
} from '../lib/preference-safety-coordinator';
import { isWindowAuthorizationRequest } from '../lib/page-identity';
import { ToolbarLauncher } from '../lib/toolbar-launch';
import {
  PAGE_ONLY_REPLICA_READ_SCOPE,
  effectiveReplicaReadScope,
  replicaReadScopeFingerprint,
  replicaReadScopeNarrows,
  type ReplicaReadScope,
} from '../lib/replica/read-scope-policy';

export default defineBackground(() => {
  const buildIdentity = createExtensionBuildIdentity(
    browser.runtime.getManifest(),
  );
  if (import.meta.env.DEV) {
    console.info(buildIdentity.backgroundReadyMessage);
  }

  const offscreenManager = createBrowserOcrOffscreenManager();
  const transientImageStore = new IndexedDbTransientImageStore();
  const coordinator = new PreferenceCoordinator(
    createBrowserPreferenceAdapter(),
    {
      clearTransientStore: () => transientImageStore.clearAll(),
      closeOffscreenDocument: async () => {
        const stored = await browser.storage.local.get(STORAGE_KEY);
        const latest = parseCompanionPreferences(stored[STORAGE_KEY]);
        const advanced = await offscreenManager.advanceResetEpoch(
          latest.resetRevision,
        );
        if (!advanced) throw new Error('Stale OCR reset epoch.');
        await offscreenManager.close();
      },
    },
  );
  const preferenceSafetyJournal: PreferenceSafetyJournalAdapter = {
    load: async () => {
      const stored = await browser.storage.local.get(
        PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY,
      );
      return stored[PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY];
    },
    save: async (snapshot) => {
      await browser.storage.local.set({
        [PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY]: snapshot,
      });
    },
    hasStoredPreferences: async () =>
      (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] !== undefined,
  };
  const preferenceSafety = new PreferenceSafetyCoordinator(
    2_000,
    () => crypto.randomUUID(),
    preferenceSafetyJournal,
  );
  let launchPreferences = parseCompanionPreferences(
    DEFAULT_COMPANION_PREFERENCES,
  );
  let livePreferenceStorageFailClosed = false;
  let launchPreferenceRevision = 0;
  let launchPreferencesHydrated = false;
  let toolbarBehaviorQueue = Promise.resolve();
  // Toolbar authorizations are ordered across worker lifecycles by a
  // generation persisted in session storage; the nonce keeps two lifecycles
  // that read the same generation apart. Resolved once, before the first
  // authorized-tab message is sent; allocation never rejects.
  const toolbarLaunchEpoch = allocateCompanionLaunchGeneration({
    read: async () => (await browser.storage.session.get(
      COMPANION_LAUNCH_GENERATION_STORAGE_KEY,
    ))[COMPANION_LAUNCH_GENERATION_STORAGE_KEY],
    write: async (generation) => {
      await browser.storage.session.set({
        [COMPANION_LAUNCH_GENERATION_STORAGE_KEY]: generation,
      });
    },
  }).then((generation) => createCompanionLaunchEpoch(
    generation,
    crypto.randomUUID(),
  ));
  // The action handler below must remain Chrome's authorization boundary.
  // Correct any behavior persisted by an older build as soon as the worker
  // starts so browser-owned side-panel routing cannot swallow action.onClicked.
  queueToolbarBehaviorSync();

  const loadRevision = launchPreferenceRevision;
  const launchPreferencesReady = browser.storage.local.get(STORAGE_KEY).then(
    async (stored) => {
      const loaded = parseCompanionPreferences(stored[STORAGE_KEY]);
      await offscreenManager.advanceResetEpoch(loaded.resetRevision);
      if (launchPreferenceRevision === loadRevision) {
        launchPreferences = selectLatestCompanionPreferences(
          launchPreferences,
          loaded,
        );
        await preferenceSafety.observeCommittedReadScope(
          effectiveReplicaReadScope(
            loaded.replicaReadScope,
            loaded.readScopeSetupVersion,
          ),
        );
      }
      if (loaded.resetCleanupPendingRevision > 0) {
        const reconciled = await runPreferenceCommand(coordinator, {
          type: 'simul:preferences:reconcile',
        }, preferenceSafety).catch(() => undefined);
        if (reconciled && launchPreferenceRevision === loadRevision) {
          launchPreferences = selectLatestCompanionPreferences(
            launchPreferences,
            reconciled.preferences,
          );
        }
      }
      queueToolbarBehaviorSync();
    },
    () => {
      queueToolbarBehaviorSync();
    },
  ).finally(() => {
    launchPreferencesHydrated = true;
  });

  function queueToolbarBehaviorSync(): void {
    toolbarBehaviorQueue = toolbarBehaviorQueue.then(
      () => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
      () => browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
    ).catch(() => undefined);
  }

  // The launch itself is in lib/toolbar-launch.ts. sidePanel.open() needs a
  // direct user gesture, so click() runs in the listener's own turn.
  const toolbarLauncher = new ToolbarLauncher({
    sidePanel: browser.sidePanel,
    windows: browser.windows,
    sendMessage: (message) => browser.runtime.sendMessage(message),
    companionPageUrl: () => browser.runtime.getURL('/sidepanel.html'),
    preferences: () => launchPreferences,
    preferencesHydrated: () => launchPreferencesHydrated,
    preferencesReady: launchPreferencesReady,
    launchEpoch: toolbarLaunchEpoch,
    rememberSurface,
    report: (state, code) => {
      if (import.meta.env.DEV) {
        console.info('[Simul toolbar launch]', { state, code });
      }
    },
  });

  browser.action.onClicked.addListener((tab) => {
    void toolbarLauncher.click(tab).catch((error: unknown) => {
      if (import.meta.env.DEV) {
        console.info('[Simul toolbar launch]', {
          state: 'failed',
          code: launchErrorCode(error),
        });
      }
    });
  });

  browser.windows.onRemoved.addListener((windowId) => {
    toolbarLauncher.windowRemoved(windowId);
  });

  async function rememberSurface(surface: CompanionSurface): Promise<void> {
    const result = await coordinator.run({
      type: 'simul:preferences:patch-view',
      expectedResetRevision: launchPreferences.resetRevision,
      patch: { lastLaunchSurface: surface },
    });
    launchPreferences = selectLatestCompanionPreferences(
      launchPreferences,
      result.preferences,
    );
    if (!livePreferenceStorageFailClosed) {
      await preferenceSafety.observeCommittedReadScope(
        currentLaunchReadScope(),
      );
    }
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PREFERENCE_SAFETY_PORT_NAME) return;
    preferenceSafety.connect(port as PreferenceSafetyPort);
  });

  browser.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (isWindowAuthorizationRequest(message)) {
        // A companion window that has just started asks for the toolbar
        // authorization it could not yet receive (D121).
        sendResponse(
          toolbarLauncher.windowAuthorization(sender.tab?.windowId) ?? null,
        );
        return;
      }
      const ensureHost = readEnsureOcrHostCommand(message);
      if (ensureHost) {
        if (!hasOcrRuntimeProvider(compiledImageTextProviderIds)) {
          sendResponse({
            kind: 'simul:ocr-v1:host-ready',
            version: 1,
            ready: false,
          });
          return;
        }
        void offscreenManager.ensure(ensureHost.resetEpoch).then(
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
      void runPreferenceCommand(coordinator, command, preferenceSafety).then(
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
    if (areaName !== 'local') return;
    if (PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY in changes) {
      void preferenceSafety.observeJournalStorageChange(
        changes[PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY]?.newValue,
      ).catch(() => undefined);
    }
    if (!(STORAGE_KEY in changes)) return;
    launchPreferenceRevision += 1;
    const liveChange = selectLiveCompanionPreferenceChange(
      launchPreferences,
      livePreferenceStorageFailClosed,
      changes[STORAGE_KEY]?.newValue,
    );
    livePreferenceStorageFailClosed = liveChange.failClosed;
    if (liveChange.status !== 'accepted') return;
    launchPreferences = liveChange.preferences;
    void preferenceSafety.observeCommittedReadScope(
      currentLaunchReadScope(),
    ).catch(() => undefined);
    void offscreenManager.advanceResetEpoch(
      launchPreferences.resetRevision,
    ).catch(() => undefined);
  });

  function currentLaunchReadScope(): ReplicaReadScope {
    return livePreferenceStorageFailClosed
      ? PAGE_ONLY_REPLICA_READ_SCOPE
      : effectiveReplicaReadScope(
          launchPreferences.replicaReadScope,
          launchPreferences.readScopeSetupVersion,
        );
  }
});

function launchErrorCode(error: unknown): string {
  const message = readableError(error).toLowerCase();
  if (message.includes('user gesture')) return 'gesture_required';
  if (message.includes('window')) return 'window_failed';
  return 'launch_failed';
}

function runPreferenceCommand(
  coordinator: PreferenceCoordinator,
  command: PreferenceCommand,
  safety: PreferenceSafetyCoordinator,
): Promise<PreferenceCommandResult> {
  return navigator.locks.request(PREFERENCE_LOCK_NAME, async () => {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const current = parseCompanionPreferences(stored[STORAGE_KEY]);
    const preparation = preferenceSafetyPreparation(command, current);
    let ticket: PreferenceSafetyTicket | undefined;
    if (preparation) {
      try {
        ticket = await safety.prepare(
          preparation.operation,
          preparation.targetReadScope,
        );
      } catch {
        return {
          type: 'simul:preferences:result',
          preferences: current,
          applied: false,
          code: 'safety-ack-failed',
        };
      }
    }
    try {
      const result = await coordinator.run(command);
      if (ticket) {
        await safety.release(
          ticket,
          result.applied ||
            (
              command.type === 'simul:preferences:reset-all' &&
              result.preferences.resetRevision > current.resetRevision
            ),
        );
        ticket = undefined;
      }
      await safety.observeCommittedReadScope(
        effectiveReplicaReadScope(
          result.preferences.replicaReadScope,
          result.preferences.readScopeSetupVersion,
        ),
      );
      return result;
    } finally {
      if (ticket) await safety.release(ticket, false);
    }
  });
}

function preferenceSafetyPreparation(
  command: PreferenceCommand,
  current: ReturnType<typeof parseCompanionPreferences>,
): {
  readonly operation: PreferenceSafetyOperation;
  readonly targetReadScope: ReplicaReadScope;
} | undefined {
  if (
    command.type === 'simul:preferences:reset-all' &&
    command.expectedResetRevision === current.resetRevision
  ) {
    return {
      operation: 'reset',
      targetReadScope: PAGE_ONLY_REPLICA_READ_SCOPE,
    };
  }
  if (
    command.type !== 'simul:preferences:patch-read-scope' &&
    command.type !== 'simul:preferences:complete-read-scope-setup'
  ) return undefined;
  if (command.expectedResetRevision !== current.resetRevision) return undefined;
  if (
    command.type === 'simul:preferences:complete-read-scope-setup' &&
    command.expectedSetupVersion !== current.readScopeSetupVersion
  ) return undefined;
  const effective = effectiveReplicaReadScope(
    current.replicaReadScope,
    current.readScopeSetupVersion,
  );
  const targetReadScope = command.patch.replicaReadScope;
  if (
    !targetReadScope ||
    command.expectedReadScopeFingerprint !==
    replicaReadScopeFingerprint(effective) ||
    !replicaReadScopeNarrows(effective, targetReadScope)
  ) return undefined;
  return {
    operation: 'read-narrow',
    targetReadScope,
  };
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The preference service could not complete the request.';
}
