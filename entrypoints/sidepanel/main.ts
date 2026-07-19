import { ChromeTranslatorProvider } from '../../lib/chrome-translator';
import {
  LatestWorkCoordinator,
  automaticTranslationAction,
  type GenerationWork,
} from '../../lib/companion-lifecycle';
import { resolveSourceLanguage } from '../../lib/language-detection';
import {
  captureLivePageDelta,
  installLivePageObserver,
  parseLivePageDelta,
  readLivePageDirtyMessage,
  readLivePageObserverInstallation,
  readLivePageScrollMessage,
  unregisterLivePageObserver,
  type LivePageDirtyMessage,
  type LivePageDelta,
  type LiveVisualNode,
} from '../../lib/live-page-mirror';
import {
  type CapturedPageIdentity,
  isSamePageIdentity,
  parseDetachedPageIdentityHint,
} from '../../lib/page-identity';
import {
  capturePageSnapshot,
  parsePageSnapshot,
  type PageSnapshot,
  type SnapshotTextRole,
} from '../../lib/page-snapshot';
import {
  PREFERENCE_LOCK_NAME,
  readPreferenceCommandResult,
  type PreferenceCommand,
  type PreferenceCommandResult,
} from '../../lib/preference-coordinator';
import {
  DEFAULT_COMPANION_PREFERENCES,
  STORAGE_KEY,
  autoTranslationModeForPage,
  clampZoomPercent,
  isAutoTranslationEnabled,
  isAutoTranslationMode,
  isMirrorDisplayMode,
  isTextLayoutMode,
  parseCompanionPreferences,
  permissionOriginsForMode,
  withAutoTranslationMode,
  withViewSettings,
  type AutoTranslationMode,
  type CompanionPreferences,
  type CompanionViewSettings,
  type CompanionViewSettingsPatch,
} from '../../lib/preferences';
import { translateWithSession } from '../../lib/translation-pipeline';
import {
  SUPPORTED_LANGUAGES,
  languageName,
  type SupportedLanguage,
  type TranslationAvailability,
  type TranslationPair,
  type TranslationSession,
} from '../../lib/translation-provider';
import {
  applyLivePageDelta,
  applyMirrorTextLayout,
  countVisualMirrorTranslationFields,
  computeMirrorExtent,
  computeMirrorScale,
  createVisualMirror,
  resetVisualMirrorText,
  translateVisualMirror,
} from '../../lib/visual-renderer';

interface CaptureRequest {
  identity: CapturedPageIdentity;
  reason:
    | 'initial'
    | 'manual'
    | 'navigation'
    | 'authorized'
    | 'preference'
    | 'desynchronized';
}

interface AuthorizedTabMessage {
  type: 'simul:authorized-tab';
  tabId: number;
  windowId: number;
  url: string;
}

interface PendingLiveUpdate {
  generation: number;
  firstSequence: number;
  sequence: number;
  nodeIds: Set<string>;
}

const NAVIGATION_DEBOUNCE_MS = 350;
const CAPTURE_TIMEOUT_MS = 12_000;

const sourceSelect = requireElement<HTMLSelectElement>('#source-language');
const targetSelect = requireElement<HTMLSelectElement>('#target-language');
const autoTranslateSelect = requireElement<HTMLSelectElement>('#auto-translate-mode');
const displayModeSelect = requireElement<HTMLSelectElement>('#mirror-display-mode');
const textLayoutSelect = requireElement<HTMLSelectElement>('#text-layout-mode');
const syncScrollInput = requireElement<HTMLInputElement>('#sync-scroll');
const zoomInput = requireElement<HTMLInputElement>('#zoom');
const zoomOutput = requireElement<HTMLOutputElement>('#zoom-value');
const zoomInButton = requireElement<HTMLButtonElement>('#zoom-in');
const zoomOutButton = requireElement<HTMLButtonElement>('#zoom-out');
const swapButton = requireElement<HTMLButtonElement>('#swap-languages');
const translateButton = requireElement<HTMLButtonElement>('#translate');
const refreshButton = requireElement<HTMLButtonElement>('#refresh');
const cancelButton = requireElement<HTMLButtonElement>('#cancel');
const toggleSettingsButton = requireElement<HTMLButtonElement>('#toggle-settings');
const closeSettingsButton = requireElement<HTMLButtonElement>('#close-settings');
const popoutButton = requireElement<HTMLButtonElement>('#open-popout');
const compactToolbar = requireElement<HTMLElement>('#compact-toolbar');
const controlsOverlay = requireElement<HTMLElement>('#control-overlay');
const statusElement = requireElement<HTMLElement>('#status');
const statusDot = requireElement<HTMLElement>('#status-dot');
const detectedLanguageElement = requireElement<HTMLElement>('#detected-language');
const captureNotes = requireElement<HTMLElement>('#capture-notes');
const progressRegion = requireElement<HTMLElement>('#progress-region');
const progressLabel = requireElement<HTMLLabelElement>('#progress-label');
const progressElement = requireElement<HTMLProgressElement>('#progress');
const placementGuidance = requireElement<HTMLElement>('#placement-guidance');
const snapshotContainer = requireElement<HTMLElement>('#snapshot');
const composerInput = requireElement<HTMLTextAreaElement>('#composer-input');
const composerOutput = requireElement<HTMLTextAreaElement>('#composer-output');
const translateComposerButton = requireElement<HTMLButtonElement>('#translate-composer');
const copyComposerButton = requireElement<HTMLButtonElement>('#copy-composer');

const provider = new ChromeTranslatorProvider();
const captureCoordinator = new LatestWorkCoordinator<CaptureRequest>();
const detachedIdentityHint = parseDetachedPageIdentityHint(window.location.search);
const liveSessionId = crypto.randomUUID();

let preferences: CompanionPreferences = parseCompanionPreferences(
  DEFAULT_COMPANION_PREFERENCES,
);
let snapshot: PageSnapshot | undefined;
let followedPageIdentity: CapturedPageIdentity | undefined;
let capturedPageIdentity: CapturedPageIdentity | undefined;
let resolvedSourceLanguage: SupportedLanguage | undefined;
let availability: TranslationAvailability = 'unavailable';
let availabilityRequestId = 0;
let identityRequestId = 0;
let captureInFlight = false;
let translationInFlight = false;
let permissionInFlight = false;
let composerInFlight = false;
let translationDesired = false;
let translationComplete = false;
let activeAbortController: AbortController | undefined;
let activeTranslationKey: string | undefined;
let composerAbortController: AbortController | undefined;
let liveDeltaAbortController: AbortController | undefined;
let activeTranslationTask: Promise<void> | undefined;
let navigationTimer: ReturnType<typeof setTimeout> | undefined;
let mirrorResizeObserver: ResizeObserver | undefined;
let panelWindowId: number | undefined;
let visualRoot: HTMLElement | undefined;
let mirrorScroller: HTMLElement | undefined;
let mirrorStage: HTMLElement | undefined;
let mirrorScaleLayer: HTMLElement | undefined;
let mirrorViewportWidth = 1;
let mirrorDocumentWidth = 1;
let mirrorDocumentHeight = 1;
let currentMirrorScale = 1;
let liveDeltaInFlight = false;
let pendingLiveUpdate: PendingLiveUpdate | undefined;
let latestLiveSequence = 0;
let highestReceivedLiveSequence = 0;
let liveSequenceBaselineReady = false;
let liveObservationAvailable = true;
let lastSourceScroll: ReturnType<typeof readLivePageScrollMessage>;
let availabilityCheckedForPair: string | undefined;
const translationCache = new Map<string, string>();
let translationCacheCharacters = 0;
let viewPreferenceRevision = 0;
const pendingViewPreferences = new Map<
  keyof CompanionViewSettings,
  { revision: number; value: CompanionViewSettings[keyof CompanionViewSettings] }
>();

const MAX_TRANSLATION_CACHE_ENTRIES = 512;
const MAX_TRANSLATION_CACHE_CHARACTERS = 500_000;

populateLanguageOptions();

toggleSettingsButton.addEventListener('click', () =>
  setOverlayOpen(controlsOverlay.hasAttribute('hidden')),
);
closeSettingsButton.addEventListener('click', () => setOverlayOpen(false));
popoutButton.addEventListener('click', () => void openDetachedWindow());

sourceSelect.addEventListener('change', () => void languageSelectionChanged());
targetSelect.addEventListener('change', () => void languageSelectionChanged());
swapButton.addEventListener('click', () => {
  if (!resolvedSourceLanguage) return;
  const previousTarget = targetSelect.value;
  sourceSelect.value = previousTarget;
  targetSelect.value = resolvedSourceLanguage;
  void languageSelectionChanged();
});

autoTranslateSelect.addEventListener('change', () => {
  const mode = isAutoTranslationMode(autoTranslateSelect.value)
    ? autoTranslateSelect.value
    : 'off';
  void changeAutoTranslationMode(mode);
});

displayModeSelect.addEventListener('change', () => {
  const mode = isMirrorDisplayMode(displayModeSelect.value)
    ? displayModeSelect.value
    : 'fit';
  void commitViewPreferencePatch({ displayMode: mode });
  updateMirrorLayout();
});

textLayoutSelect.addEventListener('change', () => {
  const mode = isTextLayoutMode(textLayoutSelect.value)
    ? textLayoutSelect.value
    : 'adaptive';
  void commitViewPreferencePatch({ textLayoutMode: mode });
  if (visualRoot) applyMirrorTextLayout(visualRoot, mode);
  updateMirrorLayout();
});

syncScrollInput.addEventListener('change', () => {
  void commitViewPreferencePatch({ syncScroll: syncScrollInput.checked });
  if (preferences.syncScroll && lastSourceScroll) followSourceScroll(lastSourceScroll);
});

zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
zoomInButton.addEventListener('click', () => setZoom(preferences.zoomPercent + 10));
zoomOutButton.addEventListener('click', () => setZoom(preferences.zoomPercent - 10));
refreshButton.addEventListener('click', () => void refreshFollowedPage('manual'));
translateButton.addEventListener('click', () => {
  translationDesired = true;
  void startTranslation(false, captureCoordinator.generation);
});
cancelButton.addEventListener('click', () => {
  activeAbortController?.abort();
  composerAbortController?.abort();
  setStatus('Cancelling on-device translation…');
});
translateComposerButton.addEventListener('click', () => void translateComposer());
copyComposerButton.addEventListener('click', () => void copyComposerOutput());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !controlsOverlay.hasAttribute('hidden')) {
    setOverlayOpen(false);
  }
});
window.addEventListener('pagehide', () => releaseLiveSession());

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const authorizedTab = readAuthorizedTabMessage(message);
  if (authorizedTab) {
    void acceptAuthorizedTab(authorizedTab);
    return;
  }
  const dirty = readLivePageDirtyMessage(message);
  if (
    dirty &&
    isMessageFromFollowedTab(
      sender.tab,
      dirty.sessionId,
      dirty.generation,
      dirty.url,
    )
  ) {
    queueLiveUpdate(dirty);
    return;
  }
  const scroll = readLivePageScrollMessage(message);
  if (
    scroll &&
    isMessageFromFollowedTab(
      sender.tab,
      scroll.sessionId,
      scroll.generation,
      scroll.url,
    )
  ) {
    lastSourceScroll = scroll;
    if (preferences.syncScroll) followSourceScroll(scroll);
  }
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (
    !detachedIdentityHint &&
    followedPageIdentity?.windowId === windowId &&
    followedPageIdentity.tabId !== tabId
  ) {
    identityRequestId += 1;
    followedPageIdentity = undefined;
    clearNavigationTimer();
    invalidateCompanion(
      'The active tab changed. Select the extension on the page you want to follow.',
    );
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const followed = followedPageIdentity;
  if (!followed || followed.tabId !== tabId) return;
  const nextUrl = changeInfo.url ?? tab.url ?? followed.url;
  if (!isSupportedPage(nextUrl)) {
    if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
      clearNavigationTimer();
      invalidateCompanion(
        'The source tab opened a restricted page. Return to a regular HTTP or HTTPS page and select the extension again.',
      );
    }
    return;
  }
  const nextIdentity = { tabId, windowId: followed.windowId, url: nextUrl };
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    identityRequestId += 1;
    captureCoordinator.invalidate();
    availabilityRequestId += 1;
    activeAbortController?.abort();
    liveDeltaAbortController?.abort();
    invalidateComposerOutput();
    pendingLiveUpdate = undefined;
    followedPageIdentity = nextIdentity;
    clearNavigationTimer();
    setStatus('The source page is changing; the current mirror stays visible until the new page is ready.');
  }
  if (
    changeInfo.status === 'complete' ||
    (typeof changeInfo.url === 'string' && changeInfo.status !== 'loading')
  ) {
    scheduleNavigationRefresh(nextIdentity);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (followedPageIdentity?.tabId === tabId) {
    invalidateCompanion('The source tab was closed.');
  }
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
  const previous = preferences;
  preferences = mergePendingViewPreferences(
    parseCompanionPreferences(changes[STORAGE_KEY]?.newValue),
  );
  syncPreferenceControls();
  updateMirrorLayout();
  if (visualRoot) applyMirrorTextLayout(visualRoot, preferences.textLayoutMode);
  if (
    snapshot &&
    (previous.sourceLanguage !== preferences.sourceLanguage ||
      previous.targetLanguage !== preferences.targetLanguage)
  ) {
    activeAbortController?.abort();
    liveDeltaAbortController?.abort();
    invalidateComposerOutput();
    translationDesired = true;
    translationComplete = false;
    clearTranslationCache();
    availabilityCheckedForPair = undefined;
    resetVisualMirrorTextIfPresent();
    void applyLanguagePreferences(false);
  }
});

void initialize();

async function initialize(): Promise<void> {
  await Promise.all([loadPreferences(), loadPanelWindowId()]);
  await Promise.allSettled([checkPanelPlacement(), initializeSourcePage()]);
}

async function initializeSourcePage(): Promise<void> {
  if (detachedIdentityHint) {
    const tab = await browser.tabs.get(detachedIdentityHint.tabId);
    followedPageIdentity = identityFromTab(tab, undefined, false);
    queueCapture({ identity: followedPageIdentity, reason: 'initial' });
    return;
  }
  await refreshFollowedPage('initial');
}

async function loadPanelWindowId(): Promise<void> {
  try {
    panelWindowId = (await browser.windows.getCurrent()).id;
  } catch {
    panelWindowId = undefined;
  }
}

async function loadPreferences(): Promise<void> {
  try {
    preferences = (await sendPreferenceCommand({ type: 'simul:preferences:reconcile' })).preferences;
  } catch {
    try {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      preferences = parseCompanionPreferences(stored[STORAGE_KEY]);
    } catch {
      preferences = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
    }
  }
  syncPreferenceControls();
}

async function sendPreferenceCommand(
  command: PreferenceCommand,
): Promise<PreferenceCommandResult> {
  const response: unknown = await browser.runtime.sendMessage(command);
  const result = readPreferenceCommandResult(response);
  if (!result) throw new Error('The preference service returned an invalid response.');
  return result;
}

async function commitViewPreferencePatch(
  patch: CompanionViewSettingsPatch,
): Promise<void> {
  preferences = withViewSettings(preferences, patch);
  syncPreferenceControls();
  const revision = ++viewPreferenceRevision;
  for (const [key, value] of Object.entries(patch)) {
    pendingViewPreferences.set(key as keyof CompanionViewSettings, {
      revision,
      value: value as CompanionViewSettings[keyof CompanionViewSettings],
    });
  }
  try {
    const result =
      await sendPreferenceCommand({
        type: 'simul:preferences:patch-view',
        patch,
      });
    clearCommittedViewPreferences(patch, revision);
    preferences = mergePendingViewPreferences(result.preferences);
    syncPreferenceControls();
    updateMirrorLayout();
    if (visualRoot) {
      applyMirrorTextLayout(visualRoot, preferences.textLayoutMode);
    }
  } catch (error) {
    clearCommittedViewPreferences(patch, revision);
    try {
      preferences = mergePendingViewPreferences(await readStoredPreferences());
      syncPreferenceControls();
      updateMirrorLayout();
      if (visualRoot) {
        applyMirrorTextLayout(visualRoot, preferences.textLayoutMode);
      }
    } catch {
      // Keep the optimistic controls visible; a later storage event can repair them.
    }
    setStatus(`Could not save options: ${readableError(error)}`, 'error');
  }
}

function clearCommittedViewPreferences(
  patch: CompanionViewSettingsPatch,
  revision: number,
): void {
  for (const key of Object.keys(patch) as Array<keyof CompanionViewSettings>) {
    if (pendingViewPreferences.get(key)?.revision === revision) {
      pendingViewPreferences.delete(key);
    }
  }
}

function mergePendingViewPreferences(
  stored: CompanionPreferences,
): CompanionPreferences {
  const pending = Object.fromEntries(
    [...pendingViewPreferences].map(([key, entry]) => [key, entry.value]),
  ) as CompanionViewSettingsPatch;
  return withViewSettings(stored, pending);
}

async function acceptAuthorizedTab(authorized: CapturedPageIdentity): Promise<void> {
  if (detachedIdentityHint && authorized.tabId !== detachedIdentityHint.tabId) return;
  if (!detachedIdentityHint) {
    if (panelWindowId === undefined) await loadPanelWindowId();
    if (panelWindowId === undefined || authorized.windowId !== panelWindowId) return;
  }
  identityRequestId += 1;
  clearNavigationTimer();
  followedPageIdentity = authorized;
  queueCapture({ identity: authorized, reason: 'authorized' });
}

async function refreshFollowedPage(reason: CaptureRequest['reason']): Promise<void> {
  const requestId = ++identityRequestId;
  try {
    const identity = followedPageIdentity
      ? await readCurrentFollowedIdentity(followedPageIdentity)
      : await readActivePageIdentity();
    if (requestId !== identityRequestId) return;
    followedPageIdentity = identity;
    queueCapture({ identity, reason });
  } catch (error) {
    if (requestId !== identityRequestId) return;
    const message = readPageError(error);
    if (!snapshot) renderErrorState(message);
    setStatus(message, 'error');
    updateControls();
  }
}

function queueCapture(request: CaptureRequest): void {
  const previousIdentity = capturedPageIdentity ?? followedPageIdentity;
  const samePage = Boolean(
    previousIdentity &&
      previousIdentity.tabId === request.identity.tabId &&
      previousIdentity.windowId === request.identity.windowId &&
      normalizedPageUrl(previousIdentity.url) === normalizedPageUrl(request.identity.url),
  );
  const retainTranslationIntent =
    samePage &&
    (request.reason === 'manual' ||
      request.reason === 'desynchronized' ||
      request.reason === 'preference');
  if (!retainTranslationIntent) {
    translationDesired = false;
    translationComplete = false;
    clearTranslationCache();
    availabilityCheckedForPair = undefined;
    invalidateComposerOutput();
  }
  if (previousIdentity && previousIdentity.tabId !== request.identity.tabId) {
    releaseLiveSession(previousIdentity);
  }
  activeAbortController?.abort();
  liveDeltaAbortController?.abort();
  availabilityRequestId += 1;
  pendingLiveUpdate = undefined;
  latestLiveSequence = 0;
  highestReceivedLiveSequence = 0;
  liveSequenceBaselineReady = false;
  followedPageIdentity = request.identity;
  if (!snapshot) renderLoadingState();
  setStatus(
    request.reason === 'desynchronized'
      ? 'A live update could not be reconciled. Rebuilding once while keeping the current mirror visible…'
      : request.reason === 'navigation'
        ? 'Building the live mirror for the newly loaded page…'
        : 'Building the initial live read-only mirror…',
  );
  const enqueued = captureCoordinator.enqueue(request);
  updateControls();
  if (enqueued.startNow) void runCaptureWork(enqueued.work);
}

async function runCaptureWork(work: GenerationWork<CaptureRequest>): Promise<void> {
  captureInFlight = true;
  updateControls();
  try {
    await capturePage(work);
  } finally {
    const next = captureCoordinator.finish(work.generation);
    if (next) {
      void runCaptureWork(next);
      return;
    }
    captureInFlight = false;
    updateControls();
    void processPendingLiveUpdate();
  }
}

async function capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
  const identity = work.value.identity;
  try {
    const observerResults = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: installLivePageObserver,
        args: [liveSessionId, work.generation],
      }),
    );
    const observerInstallation = readLivePageObserverInstallation(
      observerResults[0]?.result,
    );
    if (
      !observerInstallation ||
      observerInstallation.generation !== work.generation
    ) {
      throw new PageAccessError('The page could not start its live update bridge.');
    }
    liveObservationAvailable = observerInstallation.installed;
    if (observerInstallation.installed) {
      initializeLiveSequenceBaseline(
        work.generation,
        observerInstallation.sequence,
      );
    }
    const results = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: capturePageSnapshot,
      }),
    );
    const nextSnapshot = parsePageSnapshot(results[0]?.result);
    const currentTab = await browser.tabs.get(identity.tabId);
    assertSnapshotIsCurrent(currentTab, identity);
    if (!captureCoordinator.isCurrent(work.generation)) return;

    snapshot = nextSnapshot;
    capturedPageIdentity = identity;
    followedPageIdentity = identity;
    translationComplete = false;
    clearTranslationCache();
    renderSnapshot(nextSnapshot);
    showCaptureNotes(nextSnapshot);
    await resolveSelectedSourceLanguage();

    if (countVisualMirrorTranslationFields(visualRoot as HTMLElement) === 0) {
      availability = 'unavailable';
      availabilityCheckedForPair = undefined;
      const accessWasRevoked = await reconcileAutomaticAccess(identity.url);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      setStatus(
        accessWasRevoked
          ? 'Chrome removed a saved automatic-access grant. The mirror is waiting for page text.'
          : liveObservationAvailable
            ? 'The page mirror is live and will prepare translation when visible text arrives.'
            : 'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
        'warning',
      );
      return;
    }
    await checkAvailability(work.generation);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const accessWasRevoked = await reconcileAutomaticAccess(identity.url);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (accessWasRevoked) {
      setStatus('Chrome removed a saved automatic-access grant, so that scope was turned off.', 'warning');
      return;
    }
    await maybeTranslateAutomatically(work.generation, identity.url);
    if (!liveObservationAvailable && captureCoordinator.isCurrent(work.generation)) {
      setStatus(
        'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
        'warning',
      );
    }
  } catch (error) {
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const message = readPageError(error);
    if (!snapshot) renderErrorState(message);
    setStatus(message, 'error');
  } finally {
    updateControls();
  }
}

interface LiveLanguageContext {
  documentLanguage?: string;
  visibleText: string;
  preserveOnUnknown: boolean;
}

async function resolveSelectedSourceLanguage(
  liveContext?: LiveLanguageContext,
): Promise<boolean> {
  if (!snapshot) {
    resolvedSourceLanguage = undefined;
    return true;
  }
  if (liveContext) {
    const { documentLanguage: _previousLanguage, ...snapshotWithoutLanguage } =
      snapshot;
    snapshot = liveContext.documentLanguage
      ? {
          ...snapshotWithoutLanguage,
          documentLanguage: liveContext.documentLanguage,
        }
      : snapshotWithoutLanguage;
  }
  const requestedSnapshot = snapshot;
  const requestedPreference = preferences.sourceLanguage;
  const previousLanguage = resolvedSourceLanguage;
  const detectionSnapshot = liveContext
    ? { ...requestedSnapshot, items: [] }
    : requestedSnapshot;
  const detected = await resolveSourceLanguage(
    requestedPreference,
    detectionSnapshot,
    async (text) => browser.i18n.detectLanguage(text),
    liveContext?.visibleText ?? mirrorLanguageSample(),
  );
  if (
    snapshot !== requestedSnapshot ||
    preferences.sourceLanguage !== requestedPreference
  ) return false;
  resolvedSourceLanguage =
    detected.language ??
    (liveContext?.preserveOnUnknown ? previousLanguage : undefined);
  detectedLanguageElement.textContent = resolvedSourceLanguage
    ? requestedPreference === 'auto'
      ? detected.language
        ? `Detected ${languageName(resolvedSourceLanguage)} from ${detected.source === 'html' ? 'the page language' : 'visible page text'}.`
        : `Using the previously detected ${languageName(resolvedSourceLanguage)} source language.`
      : ''
    : 'The page language could not be detected. Choose a From language.';
  detectedLanguageElement.hidden = !detectedLanguageElement.textContent;
  return true;
}

function mirrorLanguageSample(): string {
  if (!visualRoot) return '';
  const parts = [visualRoot.textContent ?? ''];
  for (const image of visualRoot.querySelectorAll('img[alt]')) {
    const alt = image.getAttribute('alt');
    if (alt) parts.push(alt);
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 20_000);
}

async function languageSelectionChanged(): Promise<void> {
  const sourceLanguage = sourceSelect.value === 'auto'
    ? 'auto'
    : readLanguage(sourceSelect.value);
  const targetLanguage = readLanguage(targetSelect.value);
  activeAbortController?.abort();
  liveDeltaAbortController?.abort();
  invalidateComposerOutput();
  translationDesired = true;
  translationComplete = false;
  clearTranslationCache();
  availabilityCheckedForPair = undefined;
  resetVisualMirrorTextIfPresent();
  await commitViewPreferencePatch({ sourceLanguage, targetLanguage });
  await applyLanguagePreferences(true);
}

async function applyLanguagePreferences(fromUserAction: boolean): Promise<void> {
  if (!snapshot) return;
  await resolveSelectedSourceLanguage();
  await checkAvailability(captureCoordinator.generation);
  if (availability === 'available') {
    await startTranslation(!fromUserAction, captureCoordinator.generation);
  } else if (availability === 'downloadable' || availability === 'downloading') {
    setStatus('This language pair needs its on-device pack. Choose Translate once to prepare it.', 'warning');
  }
}

async function checkAvailability(generation: number): Promise<void> {
  const requestId = ++availabilityRequestId;
  const requestedSnapshot = snapshot;
  const pair = selectedPair();
  if (
    !requestedSnapshot ||
    !visualRoot ||
    !pair ||
    countVisualMirrorTranslationFields(visualRoot) === 0
  ) {
    availability = 'unavailable';
    availabilityCheckedForPair = undefined;
    if (!pair && requestedSnapshot) {
      setStatus('Choose a From language because automatic detection was inconclusive.', 'warning');
    }
    updateControls();
    return;
  }
  const checkedPairKey = availabilityPairKey(pair, generation);
  availabilityCheckedForPair = checkedPairKey;
  availability = 'unavailable';
  updateControls();
  if (pair.sourceLanguage === pair.targetLanguage) {
    availability = 'available';
    resetVisualMirrorTextIfPresent();
    translationComplete = true;
    setStatus('The source and target languages match, so the original text is unchanged.', 'success');
    updateControls();
    return;
  }
  try {
    const next = await provider.availability(pair);
    if (!isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair, generation)) return;
    availability = next;
    switch (next) {
      case 'available':
        setStatus(`Ready to translate ${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} on-device.`);
        break;
      case 'downloadable':
      case 'downloading':
        setStatus('Choose Translate once so Chrome can prepare this on-device language pair.', 'warning');
        break;
      default:
        setStatus(`${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} is unavailable on this device.`, 'error');
    }
  } catch (error) {
    if (!isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair, generation)) return;
    availability = 'unavailable';
    setStatus(readableError(error), 'error');
  } finally {
    if (isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair, generation)) updateControls();
  }
}

async function maybeTranslateAutomatically(
  generation: number,
  pageUrl: string,
): Promise<void> {
  const enabled = isAutoTranslationEnabled(preferences, pageUrl) || translationDesired;
  const action = automaticTranslationAction(enabled, availability);
  if (action === 'translate') {
    await startTranslation(true, generation);
  } else if (action === 'needs-user-action') {
    setStatus('Automatic translation is ready, but this pair needs one Translate click to prepare its local pack.', 'warning');
  }
}

function startTranslation(automatic: boolean, generation: number): Promise<void> {
  const requestedKey = currentTranslationTaskKey(generation);
  if (activeTranslationTask) {
    if (activeTranslationKey === requestedKey) return activeTranslationTask;
    activeAbortController?.abort();
    const previousTask = activeTranslationTask;
    return previousTask.catch(() => undefined).then(async () => {
      if (
        !captureCoordinator.isCurrent(generation) ||
        currentTranslationTaskKey(generation) !== requestedKey
      ) return;
      await startTranslation(automatic, generation);
    });
  }
  const task = runTranslation(automatic, generation);
  activeTranslationTask = task;
  activeTranslationKey = requestedKey;
  void task.then(() => {
    if (activeTranslationTask === task) {
      activeTranslationTask = undefined;
      activeTranslationKey = undefined;
    }
    void processPendingLiveUpdate();
  }, () => {
    if (activeTranslationTask === task) {
      activeTranslationTask = undefined;
      activeTranslationKey = undefined;
    }
    void processPendingLiveUpdate();
  });
  return task;
}

async function runTranslation(automatic: boolean, generation: number): Promise<void> {
  const pair = selectedPair();
  const root = visualRoot;
  const identity = capturedPageIdentity;
  if (
    !pair ||
    !root ||
    !identity ||
    translationInFlight ||
    availability === 'unavailable' ||
    (automatic && availability !== 'available')
  ) return;
  if (pair.sourceLanguage === pair.targetLanguage) {
    resetVisualMirrorText(root);
    translationComplete = true;
    updateControls();
    return;
  }

  const abortController = new AbortController();
  activeAbortController = abortController;
  translationInFlight = true;
  translationDesired = true;
  translationComplete = false;
  showProgress('Preparing Chrome\'s on-device language model…', 0, 1);
  updateControls();
  let session: TranslationSession | undefined;
  try {
    session = await provider.createSession(pair, {
      signal: abortController.signal,
      onDownloadProgress: (progress) =>
        showProgress(`Downloading language pack… ${Math.round(progress * 100)}%`, progress, 1),
    });
    abortController.signal.throwIfAborted();
    const tab = await browser.tabs.get(identity.tabId);
    assertSnapshotIsCurrent(tab, identity);
    if (
      !captureCoordinator.isCurrent(generation) ||
      visualRoot !== root ||
      !isCurrentTranslationPair(pair)
    ) return;
    availability = 'available';
    availabilityCheckedForPair = availabilityPairKey(pair, generation);
    const result = await translateVisualMirror(
      root,
      (source, signal) => translateCached(pair, session as TranslationSession, source, signal),
      {
        signal: abortController.signal,
        onProgress: (completed, total) =>
          showProgress(`Translating ${completed} of ${total}…`, completed, Math.max(1, total)),
      },
    );
    if (
      !captureCoordinator.isCurrent(generation) ||
      visualRoot !== root ||
      !isCurrentTranslationPair(pair)
    ) return;
    translationComplete = result.failed === 0;
    setStatus(
      result.failed
        ? `${result.failed} text segment(s) could not be translated; the original remains for those parts.`
        : automatic
          ? 'Automatic translation is complete and live updates will translate as they arrive.'
          : 'Translation is complete and live updates will translate as they arrive.',
      result.failed ? 'warning' : 'success',
    );
  } catch (error) {
    if (isAbortError(error) || abortController.signal.aborted) {
      if (
        captureCoordinator.isCurrent(generation) &&
        visualRoot === root &&
        isCurrentTranslationPair(pair)
      ) {
        setStatus('Translation cancelled. Existing translated text was kept.', 'warning');
      }
    } else {
      setStatus(readableError(error), 'error');
    }
  } finally {
    session?.destroy();
    if (activeAbortController === abortController) activeAbortController = undefined;
    translationInFlight = false;
    hideProgress();
    updateControls();
  }
}

async function translateCached(
  pair: TranslationPair,
  session: TranslationSession,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  const key = `${pair.sourceLanguage}>${pair.targetLanguage}\u0000${source}`;
  const cached = translationCache.get(key);
  if (cached !== undefined) {
    // Refresh insertion order so frequently reused segments survive eviction.
    translationCache.delete(key);
    translationCache.set(key, cached);
    return cached;
  }
  const translated = await translateWithSession(session, source, signal);
  cacheTranslation(key, translated);
  return translated;
}

function cacheTranslation(key: string, translated: string): void {
  const characters = key.length + translated.length;
  if (characters > MAX_TRANSLATION_CACHE_CHARACTERS) return;

  const replaced = translationCache.get(key);
  if (replaced !== undefined) {
    translationCacheCharacters -= key.length + replaced.length;
    translationCache.delete(key);
  }
  translationCache.set(key, translated);
  translationCacheCharacters += characters;

  while (
    translationCache.size > MAX_TRANSLATION_CACHE_ENTRIES ||
    translationCacheCharacters > MAX_TRANSLATION_CACHE_CHARACTERS
  ) {
    const oldest = translationCache.entries().next().value as
      | [string, string]
      | undefined;
    if (!oldest) break;
    translationCache.delete(oldest[0]);
    translationCacheCharacters -= oldest[0].length + oldest[1].length;
  }
}

function clearTranslationCache(): void {
  translationCache.clear();
  translationCacheCharacters = 0;
}

function initializeLiveSequenceBaseline(generation: number, sequence: number): void {
  if (!captureCoordinator.isCurrent(generation)) return;
  latestLiveSequence = sequence;
  highestReceivedLiveSequence = sequence;
  liveSequenceBaselineReady = true;
  if (!pendingLiveUpdate || pendingLiveUpdate.generation !== generation) return;
  if (pendingLiveUpdate.sequence <= sequence) {
    pendingLiveUpdate = undefined;
    return;
  }
  if (pendingLiveUpdate.firstSequence > sequence + 1) {
    pendingLiveUpdate = undefined;
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'desynchronized' });
    return;
  }
  highestReceivedLiveSequence = pendingLiveUpdate.sequence;
}

function queueLiveUpdate(message: LivePageDirtyMessage): void {
  if (message.sequence <= latestLiveSequence) return;
  if (
    liveSequenceBaselineReady &&
    highestReceivedLiveSequence > 0 &&
    message.sequence > highestReceivedLiveSequence + 1
  ) {
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) {
      setStatus('A live update was missed. Rebuilding once while keeping the current mirror visible…', 'warning');
      queueCapture({ identity, reason: 'desynchronized' });
    }
    return;
  }
  if (message.sequence <= highestReceivedLiveSequence) return;
  highestReceivedLiveSequence = message.sequence;
  if (!pendingLiveUpdate || pendingLiveUpdate.generation !== message.generation) {
    pendingLiveUpdate = {
      generation: message.generation,
      firstSequence: message.sequence,
      sequence: message.sequence,
      nodeIds: new Set(message.nodeIds),
    };
  } else {
    pendingLiveUpdate.sequence = Math.max(pendingLiveUpdate.sequence, message.sequence);
    for (const nodeId of message.nodeIds) pendingLiveUpdate.nodeIds.add(nodeId);
  }
  void processPendingLiveUpdate();
}

async function processPendingLiveUpdate(): Promise<void> {
  if (
    liveDeltaInFlight ||
    captureInFlight ||
    translationInFlight ||
    !pendingLiveUpdate ||
    !capturedPageIdentity ||
    !visualRoot
  ) return;
  const update = pendingLiveUpdate;
  pendingLiveUpdate = undefined;
  const requestedNodeIds = [...update.nodeIds];
  const nodeIds = requestedNodeIds.slice(0, 48);
  if (requestedNodeIds.length > nodeIds.length) {
    pendingLiveUpdate = {
      generation: update.generation,
      firstSequence: update.firstSequence,
      sequence: update.sequence,
      nodeIds: new Set(requestedNodeIds.slice(48)),
    };
  }
  if (!captureCoordinator.isCurrent(update.generation)) return;
  const identity = capturedPageIdentity;
  const beforeRoot = visualRoot;
  const abortController = new AbortController();
  liveDeltaAbortController = abortController;
  liveDeltaInFlight = true;
  statusDot.dataset.busy = 'true';
  let session: TranslationSession | undefined;
  try {
    const results = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: captureLivePageDelta,
        args: [liveSessionId, update.generation, update.sequence, nodeIds],
      }),
    );
    const delta = parseLivePageDelta(results[0]?.result);
    if (
      !captureCoordinator.isCurrent(delta.generation) ||
      delta.sequence < latestLiveSequence ||
      normalizedPageUrl(delta.url) !== normalizedPageUrl(identity.url)
    ) return;
    if (delta.desynchronized) {
      queueCapture({ identity: capturedPageIdentity, reason: 'desynchronized' });
      return;
    }
    const pairBeforeRefresh = selectedPair();
    let pairChanged = false;
    const visibleLanguageText = liveDeltaLanguageSample(delta);
    if (preferences.sourceLanguage === 'auto') {
      const resolutionCommitted = await resolveSelectedSourceLanguage({
        documentLanguage: delta.documentLanguage,
        visibleText: visibleLanguageText,
        preserveOnUnknown: true,
      });
      if (
        !resolutionCommitted ||
        abortController.signal.aborted ||
        visualRoot !== beforeRoot ||
        !captureCoordinator.isCurrent(delta.generation)
      ) return;
      const refreshedPair = selectedPair();
      pairChanged = !sameTranslationPair(pairBeforeRefresh, refreshedPair);
      if (pairChanged) {
        clearTranslationCache();
        availabilityCheckedForPair = undefined;
        translationComplete = false;
        invalidateComposerOutput();
        resetVisualMirrorText(beforeRoot);
      }
      await checkAvailability(delta.generation);
      if (
        abortController.signal.aborted ||
        visualRoot !== beforeRoot ||
        !captureCoordinator.isCurrent(delta.generation) ||
        (refreshedPair && !isCurrentTranslationPair(refreshedPair))
      ) return;
    }

    const pair = selectedPair();
    const wantsTranslation =
      translationDesired || isAutoTranslationEnabled(preferences, identity.url);
    const shouldTranslate = Boolean(
      pair &&
      pair.sourceLanguage !== pair.targetLanguage &&
      wantsTranslation &&
      !pairChanged &&
      availability === 'available',
    );
    if (shouldTranslate && pair) {
      session = await provider.createSession(pair, { signal: abortController.signal });
    }
    const applied = await applyLivePageDelta(beforeRoot, delta, {
      textLayoutMode: preferences.textLayoutMode,
      signal: abortController.signal,
      ...(shouldTranslate && pair && session
        ? {
            translate: (source: string, signal?: AbortSignal) =>
              translateCached(pair, session as TranslationSession, source, signal),
          }
        : {}),
    });
    if (
      abortController.signal.aborted ||
      visualRoot !== beforeRoot ||
      !captureCoordinator.isCurrent(delta.generation) ||
      (pair && !isCurrentTranslationPair(pair))
    ) return;
    visualRoot = applied.root;
    mirrorDocumentWidth = delta.documentWidth;
    mirrorDocumentHeight = delta.documentHeight;
    latestLiveSequence = delta.sequence;
    updateMirrorLayout();
    if (applied.missingTarget) {
      queueCapture({ identity, reason: 'desynchronized' });
      return;
    }
    if (applied.translation.failed > 0) {
      translationComplete = false;
      setStatus(
        `${applied.translation.failed} changed text segment(s) could not be translated; their original text remains.`,
        'warning',
      );
      return;
    }

    let translationStatusWasHandled = shouldTranslate;
    if (shouldTranslate && applied.applied > 0) {
      setStatus('Live page changes were mirrored and translated.', 'success');
    }
    if (countVisualMirrorTranslationFields(visualRoot) > 0) {
      const currentPair = selectedPair();
      const pairKey = currentPair
        ? availabilityPairKey(currentPair, update.generation)
        : undefined;
      if (!currentPair || availabilityCheckedForPair !== pairKey) {
        await checkAvailability(update.generation);
      }
      if ((!shouldTranslate || pairChanged) && wantsTranslation) {
        translationStatusWasHandled = true;
        await maybeTranslateAutomatically(update.generation, identity.url);
      }
    }
    if (applied.applied > 0 && !translationStatusWasHandled) {
      setStatus(
        'Live page changes were mirrored.',
        'success',
      );
    }
  } catch (error) {
    if (!abortController.signal.aborted && capturedPageIdentity) {
      setStatus(`A live update could not be applied: ${readableError(error)}`, 'warning');
      queueCapture({ identity: capturedPageIdentity, reason: 'desynchronized' });
    }
  } finally {
    session?.destroy();
    if (liveDeltaAbortController === abortController) {
      liveDeltaAbortController = undefined;
    }
    liveDeltaInFlight = false;
    delete statusDot.dataset.busy;
    void processPendingLiveUpdate();
  }
}

function liveDeltaLanguageSample(delta: LivePageDelta): string {
  const parts: string[] = [];
  let characters = 0;
  const append = (value: string | undefined): void => {
    if (!value || characters >= 20_000) return;
    const remaining = 20_000 - characters;
    const text = value.replace(/\s+/gu, ' ').trim().slice(0, remaining);
    if (!text) return;
    parts.push(text);
    characters += text.length + 1;
  };
  const visit = (node: LiveVisualNode): void => {
    if (characters >= 20_000) return;
    if (node.kind === 'text') {
      append(node.text);
      return;
    }
    if (node.kind === 'placeholder') return;
    append(node.attributes?.alt);
    for (const child of node.children) visit(child);
  };
  for (const replacement of delta.replacements) {
    if (replacement.node) visit(replacement.node);
  }
  return parts.join(' ');
}

function sameTranslationPair(
  left: TranslationPair | undefined,
  right: TranslationPair | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.sourceLanguage === right.sourceLanguage &&
      left.targetLanguage === right.targetLanguage,
  ) || (!left && !right);
}

function renderSnapshot(page: PageSnapshot): void {
  disconnectMirror();
  const article = document.createElement('article');
  article.className = 'page-copy';
  const mirror = createVisualMirror(page, undefined, document);
  if (mirror && page.visual) {
    const scroller = document.createElement('div');
    scroller.className = 'mirror-scroll';
    const stage = document.createElement('div');
    stage.className = 'mirror-stage';
    const scaleLayer = document.createElement('div');
    scaleLayer.className = 'mirror-scale-layer';
    scaleLayer.append(mirror);
    stage.append(scaleLayer);
    scroller.append(stage);
    article.append(scroller);
    snapshotContainer.replaceChildren(article);

    visualRoot = mirror;
    mirrorScroller = scroller;
    mirrorStage = stage;
    mirrorScaleLayer = scaleLayer;
    mirrorViewportWidth = page.visual.viewportWidth;
    mirrorDocumentWidth = page.visual.documentWidth;
    mirrorDocumentHeight = page.visual.documentHeight;
    applyMirrorTextLayout(mirror, preferences.textLayoutMode);
    updateMirrorLayout();
    if (typeof ResizeObserver === 'function') {
      mirrorResizeObserver = new ResizeObserver(updateMirrorLayout);
      mirrorResizeObserver.observe(scroller);
      mirrorResizeObserver.observe(scaleLayer);
    }
    requestAnimationFrame(updateMirrorLayout);
    return;
  }
  renderFlatSnapshot(article, page);
  snapshotContainer.replaceChildren(article);
}

function updateMirrorLayout(): void {
  if (!mirrorScroller || !mirrorStage || !mirrorScaleLayer || !visualRoot) return;
  const scale = computeMirrorScale(
    mirrorScroller.clientWidth,
    mirrorViewportWidth,
    preferences.displayMode,
    preferences.zoomPercent,
  );
  currentMirrorScale = scale;
  mirrorScaleLayer.style.width = `${mirrorViewportWidth}px`;
  mirrorScaleLayer.style.minHeight = `${mirrorDocumentHeight}px`;
  visualRoot.style.width = `${mirrorViewportWidth}px`;
  const extent = computeMirrorExtent(
    scale,
    mirrorDocumentWidth,
    mirrorDocumentHeight,
    Math.max(mirrorScaleLayer.scrollWidth, visualRoot.scrollWidth),
    Math.max(mirrorScaleLayer.scrollHeight, visualRoot.scrollHeight),
  );
  mirrorScaleLayer.style.transform = `scale(${scale})`;
  mirrorStage.style.width = `${extent.width}px`;
  mirrorStage.style.height = `${extent.height}px`;
  if (preferences.syncScroll && lastSourceScroll) followSourceScroll(lastSourceScroll);
}

function followSourceScroll(scroll: NonNullable<typeof lastSourceScroll>): void {
  if (!mirrorScroller) return;
  const maxMirrorX = Math.max(0, mirrorScroller.scrollWidth - mirrorScroller.clientWidth);
  const maxMirrorY = Math.max(0, mirrorScroller.scrollHeight - mirrorScroller.clientHeight);
  const faithful = preferences.textLayoutMode === 'faithful';
  mirrorScroller.scrollLeft = faithful
    ? Math.min(maxMirrorX, scroll.scrollX * currentMirrorScale)
    : scroll.maxScrollX > 0
      ? (scroll.scrollX / scroll.maxScrollX) * maxMirrorX
      : 0;
  mirrorScroller.scrollTop = faithful
    ? Math.min(maxMirrorY, scroll.scrollY * currentMirrorScale)
    : scroll.maxScrollY > 0
      ? (scroll.scrollY / scroll.maxScrollY) * maxMirrorY
      : 0;
}

function disconnectMirror(): void {
  mirrorResizeObserver?.disconnect();
  mirrorResizeObserver = undefined;
  visualRoot = undefined;
  mirrorScroller = undefined;
  mirrorStage = undefined;
  mirrorScaleLayer = undefined;
}

function resetVisualMirrorTextIfPresent(): void {
  if (visualRoot) resetVisualMirrorText(visualRoot);
}

function renderFlatSnapshot(article: HTMLElement, page: PageSnapshot): void {
  for (const item of page.items) {
    if (item.kind === 'text') {
      article.append(renderText(item.role, item.text));
      continue;
    }
    const image = document.createElement('img');
    image.className = 'translated-image';
    image.src = item.src;
    image.alt = item.altText ?? '';
    image.referrerPolicy = 'no-referrer';
    article.append(image);
  }
  if (page.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No eligible visible content was found.';
    article.append(empty);
  }
}

function renderText(role: SnapshotTextRole, text: string): HTMLElement {
  const element = role.startsWith('heading-')
    ? document.createElement(
        `h${Math.min(6, Math.max(2, Number(role.at(-1))))}` as keyof HTMLElementTagNameMap,
      )
    : role === 'quote'
      ? document.createElement('blockquote')
      : role === 'code'
        ? document.createElement('pre')
        : document.createElement('p');
  element.className = 'translated-text';
  element.textContent = text;
  element.dir = 'auto';
  return element;
}

function setOverlayOpen(open: boolean): void {
  controlsOverlay.hidden = !open;
  compactToolbar.hidden = open;
  toggleSettingsButton.setAttribute('aria-expanded', String(open));
  if (open) closeSettingsButton.focus();
  else toggleSettingsButton.focus();
}

function populateLanguageOptions(): void {
  sourceSelect.replaceChildren(createLanguageOption('auto', 'Auto-detect'));
  targetSelect.replaceChildren();
  for (const language of SUPPORTED_LANGUAGES) {
    sourceSelect.append(createLanguageOption(language, languageName(language)));
    targetSelect.append(createLanguageOption(language, languageName(language)));
  }
}

function createLanguageOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function setZoom(value: number): void {
  const zoomPercent = clampZoomPercent(value);
  void commitViewPreferencePatch({
    displayMode: 'custom',
    zoomPercent,
  });
  updateMirrorLayout();
}

function syncPreferenceControls(): void {
  const pageUrl = followedPageIdentity?.url ?? capturedPageIdentity?.url;
  sourceSelect.value = preferences.sourceLanguage;
  targetSelect.value = preferences.targetLanguage;
  autoTranslateSelect.value = autoTranslationModeForPage(preferences, pageUrl);
  displayModeSelect.value = preferences.displayMode;
  textLayoutSelect.value = preferences.textLayoutMode;
  syncScrollInput.checked = preferences.syncScroll;
  zoomInput.value = String(preferences.zoomPercent);
  zoomOutput.value = `${preferences.zoomPercent}%`;
  zoomInput.disabled = preferences.displayMode !== 'custom';
}

async function openDetachedWindow(): Promise<void> {
  const identity = capturedPageIdentity ?? followedPageIdentity;
  if (!identity) {
    setStatus('Open a regular page before detaching the companion.', 'warning');
    return;
  }
  try {
    const url = new URL(browser.runtime.getURL('/sidepanel.html'));
    url.searchParams.set('sourceTabId', String(identity.tabId));
    url.searchParams.set('sourceWindowId', String(identity.windowId));
    await browser.windows.create({
      url: url.toString(),
      type: 'popup',
      width: Math.max(480, Math.min(1_200, Math.round(window.outerWidth * 1.4))),
      height: Math.max(560, Math.min(1_000, window.screen.availHeight - 80)),
      focused: true,
    });
    setStatus('Detached companion window opened.', 'success');
  } catch (error) {
    setStatus(`Chrome could not open a detached window: ${readableError(error)}`, 'error');
  }
}

async function translateComposer(): Promise<void> {
  const text = composerInput.value.trim();
  const forwardPair = selectedPair();
  if (!text || !forwardPair || composerInFlight) return;
  const pair: TranslationPair = {
    sourceLanguage: forwardPair.targetLanguage,
    targetLanguage: forwardPair.sourceLanguage,
  };
  composerAbortController?.abort();
  const abortController = new AbortController();
  composerAbortController = abortController;
  composerInFlight = true;
  composerOutput.value = '';
  copyComposerButton.disabled = true;
  updateControls();
  let session: TranslationSession | undefined;
  try {
    let translated: string;
    if (pair.sourceLanguage === pair.targetLanguage) {
      translated = text;
    } else {
      const composerAvailability = await provider.availability(pair);
      abortController.signal.throwIfAborted();
      if (composerAvailability === 'unavailable') {
        throw new Error('The reverse language pair is unavailable on this device.');
      }
      session = await provider.createSession(pair, { signal: abortController.signal });
      translated = await translateWithSession(session, text, abortController.signal);
    }
    const currentForwardPair = selectedPair();
    if (
      abortController.signal.aborted ||
      composerAbortController !== abortController ||
      composerInput.value.trim() !== text ||
      !currentForwardPair ||
      currentForwardPair.sourceLanguage !== forwardPair.sourceLanguage ||
      currentForwardPair.targetLanguage !== forwardPair.targetLanguage
    ) return;
    composerOutput.value = translated;
    copyComposerButton.disabled = composerOutput.value.length === 0;
    setStatus('Reply translation is ready to copy. It was not saved.', 'success');
  } catch (error) {
    if (!isAbortError(error) && !abortController.signal.aborted) {
      setStatus(`Could not translate the reply: ${readableError(error)}`, 'error');
    }
  } finally {
    session?.destroy();
    if (composerAbortController === abortController) composerAbortController = undefined;
    composerInFlight = false;
    updateControls();
  }
}

function invalidateComposerOutput(): void {
  composerAbortController?.abort();
  composerOutput.value = '';
  copyComposerButton.disabled = true;
  updateControls();
}

async function copyComposerOutput(): Promise<void> {
  if (!composerOutput.value) return;
  try {
    await navigator.clipboard.writeText(composerOutput.value);
    setStatus('Translated reply copied.', 'success');
  } catch {
    composerOutput.focus();
    composerOutput.select();
    setStatus('Chrome could not copy automatically. The result is selected for copying.', 'warning');
  }
}

async function checkPanelPlacement(): Promise<void> {
  if (detachedIdentityHint) return;
  const sidePanel = browser.sidePanel as typeof browser.sidePanel & {
    getLayout?: () => Promise<{ side: string }>;
  };
  if (typeof sidePanel.getLayout !== 'function') return;
  try {
    const layout = await sidePanel.getLayout();
    placementGuidance.hidden = layout.side !== 'left';
  } catch {
    // Chrome 138 does not expose placement inspection in every channel.
  }
}

async function changeAutoTranslationMode(mode: AutoTranslationMode): Promise<void> {
  if (permissionInFlight) {
    syncPreferenceControls();
    return;
  }
  const pageUrl = followedPageIdentity?.url ?? capturedPageIdentity?.url;
  const requestedOrigins = permissionOriginsForMode(mode, pageUrl);
  if (mode === 'site' && requestedOrigins.length === 0) {
    syncPreferenceControls();
    setStatus(
      hasNonDefaultPort(pageUrl)
        ? 'Chrome cannot grant narrow one-site access to a non-default port.'
        : 'Open a regular HTTP or HTTPS page before enabling this-site automation.',
      'warning',
    );
    return;
  }
  permissionInFlight = true;
  updateControls();
  try {
    if (!navigator.locks) throw new Error('Chrome Web Locks are unavailable.');
    const outcome = await navigator.locks.request(
      PREFERENCE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return { kind: 'busy' } as const;
        return performLockedAutoTranslationChange(mode, pageUrl, requestedOrigins);
      },
    );
    if (outcome.kind === 'busy') {
      await reloadPreferencesFromStorage();
      setStatus('Another companion window is saving this setting. Try again.', 'warning');
      return;
    }
    if (outcome.kind === 'activation') {
      await reloadPreferencesFromStorage();
      setStatus('Choose the setting again so Chrome can show its access prompt.', 'warning');
      return;
    }
    if (outcome.kind === 'limit') {
      preferences = mergePendingViewPreferences(outcome.preferences);
      syncPreferenceControls();
      setStatus('The saved-site limit has been reached.', 'warning');
      return;
    }
    if (outcome.kind === 'failed') {
      if (outcome.result) {
        preferences = mergePendingViewPreferences(outcome.result.preferences);
      }
      else await reloadPreferencesFromStorage();
      syncPreferenceControls();
      setStatus(`Chrome could not update automatic access: ${readableError(outcome.error)}`, 'error');
      return;
    }
    preferences = mergePendingViewPreferences(outcome.result.preferences);
    syncPreferenceControls();
    if (outcome.kind === 'denied' || outcome.kind === 'not-applied') {
      setStatus('Chrome did not retain the requested automatic-access scope.', 'warning');
      return;
    }
    setStatus(
      mode === 'off'
        ? 'Automatic translation is off for this scope.'
        : mode === 'all'
          ? 'Automatic translation is enabled for regular web pages.'
          : 'Automatic translation is enabled for this site.',
      'success',
    );
    if (mode !== 'off' && snapshot) {
      translationDesired = true;
      await maybeTranslateAutomatically(captureCoordinator.generation, pageUrl ?? '');
    }
  } catch (error) {
    const repaired = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    if (repaired) preferences = mergePendingViewPreferences(repaired.preferences);
    else await reloadPreferencesFromStorage();
    syncPreferenceControls();
    setStatus(`Chrome could not update automatic access: ${readableError(error)}`, 'error');
  } finally {
    permissionInFlight = false;
    updateControls();
  }
}

async function performLockedAutoTranslationChange(
  mode: AutoTranslationMode,
  pageUrl: string | undefined,
  requestedOrigins: string[],
) {
  try {
    const freshPreferences = await readStoredPreferences();
    const candidate = withAutoTranslationMode(freshPreferences, pageUrl, mode);
    if (mode === 'site' && autoTranslationModeForPage(candidate, pageUrl) !== 'site') {
      return { kind: 'limit', preferences: freshPreferences } as const;
    }
    if ((mode === 'site' || mode === 'all') && !navigator.userActivation.isActive) {
      return { kind: 'activation' } as const;
    }
    if (mode === 'site') {
      await browser.permissions.remove({ origins: permissionOriginsForMode('all') });
    }
    const granted =
      requestedOrigins.length === 0 ||
      (await browser.permissions.request({ origins: requestedOrigins }));
    if (!granted) {
      const result = await sendPreferenceCommand({
        type: 'simul:preferences:abort-auto',
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      });
      return { kind: 'denied', result } as const;
    }
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:commit-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    });
    return { kind: result.applied ? 'complete' : 'not-applied', result } as const;
  } catch (error) {
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    return { kind: 'failed', error, result } as const;
  }
}

async function reconcileAutomaticAccess(pageUrl: string | undefined): Promise<boolean> {
  const before = autoTranslationModeForPage(preferences, pageUrl);
  const result = await sendPreferenceCommand({ type: 'simul:preferences:reconcile' });
  preferences = mergePendingViewPreferences(result.preferences);
  syncPreferenceControls();
  return before !== autoTranslationModeForPage(preferences, pageUrl);
}

async function readStoredPreferences(): Promise<CompanionPreferences> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return parseCompanionPreferences(stored[STORAGE_KEY]);
}

async function reloadPreferencesFromStorage(): Promise<void> {
  try {
    preferences = mergePendingViewPreferences(await readStoredPreferences());
  } catch {
    preferences = mergePendingViewPreferences(
      parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
    );
  }
  syncPreferenceControls();
}

function scheduleNavigationRefresh(identity: CapturedPageIdentity): void {
  clearNavigationTimer();
  navigationTimer = setTimeout(() => {
    navigationTimer = undefined;
    if (
      followedPageIdentity?.tabId !== identity.tabId ||
      followedPageIdentity.windowId !== identity.windowId
    ) return;
    queueCapture({ identity, reason: 'navigation' });
  }, NAVIGATION_DEBOUNCE_MS);
}

function clearNavigationTimer(): void {
  if (navigationTimer !== undefined) clearTimeout(navigationTimer);
  navigationTimer = undefined;
}

function withCaptureTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new PageAccessError('The page took too long to respond. Retry the current page.')),
      CAPTURE_TIMEOUT_MS,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function invalidateCompanion(message: string): void {
  identityRequestId += 1;
  releaseLiveSession(capturedPageIdentity ?? followedPageIdentity);
  captureCoordinator.invalidate();
  availabilityRequestId += 1;
  activeAbortController?.abort();
  liveDeltaAbortController?.abort();
  invalidateComposerOutput();
  followedPageIdentity = undefined;
  snapshot = undefined;
  capturedPageIdentity = undefined;
  resolvedSourceLanguage = undefined;
  availability = 'unavailable';
  availabilityCheckedForPair = undefined;
  translationDesired = false;
  translationComplete = false;
  pendingLiveUpdate = undefined;
  latestLiveSequence = 0;
  highestReceivedLiveSequence = 0;
  liveSequenceBaselineReady = false;
  disconnectMirror();
  renderErrorState(message);
  setStatus(message, 'warning');
  updateControls();
}

function releaseLiveSession(
  identity: CapturedPageIdentity | undefined = capturedPageIdentity ?? followedPageIdentity,
): void {
  if (!identity) return;
  void browser.scripting.executeScript({
    target: { tabId: identity.tabId, frameIds: [0] },
    func: unregisterLivePageObserver,
    args: [liveSessionId],
  }).catch(() => undefined);
}

function renderLoadingState(): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  const text = document.createElement('p');
  text.textContent = 'Preparing the live read-only mirror…';
  wrapper.append(text);
  snapshotContainer.replaceChildren(wrapper);
}

function renderErrorState(message: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state empty-state--error';
  const text = document.createElement('p');
  text.textContent = message;
  wrapper.append(text);
  snapshotContainer.replaceChildren(wrapper);
}

async function readActivePageIdentity(): Promise<CapturedPageIdentity> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return identityFromTab(tab, undefined, true);
}

async function readCurrentFollowedIdentity(
  followed: CapturedPageIdentity,
): Promise<CapturedPageIdentity> {
  const tab = await browser.tabs.get(followed.tabId);
  return identityFromTab(tab, followed.url, !detachedIdentityHint);
}

function identityFromTab(
  tab: Browser.tabs.Tab | undefined,
  fallbackUrl?: string,
  requireActive = true,
): CapturedPageIdentity {
  const url = tab?.url ?? fallbackUrl;
  if (
    tab?.id === undefined ||
    !url ||
    !isSupportedPage(url) ||
    (requireActive && !tab.active)
  ) {
    throw new PageAccessError('Open a regular HTTP or HTTPS page, then select the extension from that page.');
  }
  return { tabId: tab.id, windowId: tab.windowId, url };
}

function assertSnapshotIsCurrent(
  tab: Browser.tabs.Tab | undefined,
  identity: CapturedPageIdentity,
): void {
  if (
    (!detachedIdentityHint && !tab?.active) ||
    !isSamePageIdentity(identity, tab)
  ) {
    throw new PageAccessError('The source page changed or access expired. Select the extension on the source page to authorize it again.');
  }
}

function readAuthorizedTabMessage(message: unknown): CapturedPageIdentity | undefined {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'simul:authorized-tab' ||
    !('tabId' in message) ||
    !Number.isSafeInteger(message.tabId) ||
    Number(message.tabId) < 0 ||
    !('windowId' in message) ||
    !Number.isSafeInteger(message.windowId) ||
    Number(message.windowId) < 0 ||
    !('url' in message) ||
    typeof message.url !== 'string' ||
    !isSupportedPage(message.url)
  ) return undefined;
  const authorized = message as AuthorizedTabMessage;
  return {
    tabId: authorized.tabId,
    windowId: authorized.windowId,
    url: authorized.url,
  };
}

function isMessageFromFollowedTab(
  tab: Browser.tabs.Tab | undefined,
  sessionId: string,
  generation: number,
  url: string,
): boolean {
  const followed = followedPageIdentity ?? capturedPageIdentity;
  return Boolean(
    sessionId === liveSessionId &&
      followed &&
      tab?.id === followed.tabId &&
      tab.windowId === followed.windowId &&
      captureCoordinator.isCurrent(generation) &&
      normalizedPageUrl(url) === normalizedPageUrl(followed.url),
  );
}

function isCurrentAvailabilityRequest(
  requestId: number,
  requestedSnapshot: PageSnapshot,
  pair: TranslationPair,
  generation: number,
): boolean {
  const currentPair = selectedPair();
  return Boolean(
    requestId === availabilityRequestId &&
      captureCoordinator.isCurrent(generation) &&
      snapshot === requestedSnapshot &&
      currentPair &&
      currentPair.sourceLanguage === pair.sourceLanguage &&
      currentPair.targetLanguage === pair.targetLanguage,
  );
}

function selectedPair(): TranslationPair | undefined {
  return resolvedSourceLanguage
    ? {
        sourceLanguage: resolvedSourceLanguage,
        targetLanguage: preferences.targetLanguage,
      }
    : undefined;
}

function isCurrentTranslationPair(pair: TranslationPair): boolean {
  const current = selectedPair();
  return Boolean(
    current &&
      current.sourceLanguage === pair.sourceLanguage &&
      current.targetLanguage === pair.targetLanguage,
  );
}

function availabilityPairKey(pair: TranslationPair, generation: number): string {
  return `${generation}:${pair.sourceLanguage}>${pair.targetLanguage}`;
}

function currentTranslationTaskKey(generation: number): string {
  const pair = selectedPair();
  return pair
    ? availabilityPairKey(pair, generation)
    : `${generation}:unresolved`;
}

function readLanguage(value: string): SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
    ? (value as SupportedLanguage)
    : 'en';
}

function showCaptureNotes(page: PageSnapshot): void {
  const details: string[] = [];
  if (page.omissions.controls) details.push('private form contents');
  if (page.omissions.frames) details.push('embedded frame contents');
  if (page.omissions.hidden) details.push('hidden content');
  if (page.omissions.unsafeImages) details.push('unsupported image sources');
  if (page.omissions.truncated) details.push('content beyond the bounded mirror limit');
  if (!liveObservationAvailable) {
    details.push('live updates because too many companion views are open');
  }
  captureNotes.textContent = details.length > 0 ? `Safely omitted: ${details.join(', ')}.` : '';
  captureNotes.hidden = details.length === 0;
}

function updateControls(): void {
  const busy = captureInFlight || translationInFlight || permissionInFlight || composerInFlight;
  sourceSelect.disabled = busy;
  targetSelect.disabled = busy;
  swapButton.disabled = busy || !resolvedSourceLanguage;
  autoTranslateSelect.disabled = busy;
  displayModeSelect.disabled = busy;
  textLayoutSelect.disabled = busy;
  syncScrollInput.disabled = busy || !liveObservationAvailable;
  zoomInButton.disabled = busy;
  zoomOutButton.disabled = busy;
  refreshButton.disabled = captureInFlight;
  popoutButton.disabled = !capturedPageIdentity;
  cancelButton.hidden = !translationInFlight && !composerInFlight;
  cancelButton.disabled = !translationInFlight && !composerInFlight;
  translateComposerButton.disabled = busy || !composerInput.value.trim() || !selectedPair();
  translateButton.disabled =
    busy ||
    !snapshot ||
    !visualRoot ||
    !selectedPair() ||
    availability === 'unavailable' ||
    translationComplete;
  translateButton.textContent = translationComplete ? 'Translation current' : 'Translate page';
  statusDot.dataset.busy = String(busy || liveDeltaInFlight);
}

composerInput.addEventListener('input', () => {
  invalidateComposerOutput();
  updateControls();
});

function showProgress(label: string, value: number, max: number): void {
  progressRegion.hidden = false;
  progressLabel.textContent = label;
  progressElement.max = Math.max(1, max);
  progressElement.value = Math.min(progressElement.max, Math.max(0, value));
}

function hideProgress(): void {
  progressRegion.hidden = true;
  progressElement.value = 0;
}

function setStatus(
  message: string,
  tone: 'normal' | 'success' | 'warning' | 'error' = 'normal',
): void {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
  statusDot.dataset.tone = tone;
  statusDot.title = message;
}

function normalizedPageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isSupportedPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function hasNonDefaultPort(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).port.length > 0;
  } catch {
    return false;
  }
}

function readPageError(error: unknown): string {
  if (error instanceof PageAccessError) return error.message;
  const message = readableError(error);
  return /cannot access|permission|extensions gallery|chrome:\/\//iu.test(message)
    ? 'The extension no longer has access to this page. Select its toolbar icon on the source page to authorize it again.'
    : message;
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Something went wrong. Retry the current step.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing companion element: ${selector}`);
  return element;
}

class PageAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageAccessError';
  }
}
