import { ChromeTranslatorProvider } from '../../lib/chrome-translator';
import {
  LatestWorkCoordinator,
  automaticTranslationAction,
  type GenerationWork,
} from '../../lib/companion-lifecycle';
import {
  type CapturedPageIdentity,
  isSamePageIdentity,
} from '../../lib/page-identity';
import {
  type PageSnapshot,
  type SnapshotTextRole,
  capturePageSnapshot,
  parsePageSnapshot,
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
  isAutoTranslationEnabled,
  isAutoTranslationMode,
  isMirrorDisplayMode,
  parseCompanionPreferences,
  permissionOriginsForMode,
  withAutoTranslationMode,
  withDisplayMode,
  type AutoTranslationMode,
  type CompanionPreferences,
} from '../../lib/preferences';
import {
  type TranslatedSnapshot,
  type TranslationValue,
  countIncompleteTranslations,
  displayTranslation,
  retryIncompleteTranslations,
  translateSnapshot,
} from '../../lib/translation-pipeline';
import {
  type SupportedLanguage,
  type TranslationAvailability,
  type TranslationPair,
  type TranslationSession,
  languageName,
} from '../../lib/translation-provider';
import {
  computeMirrorExtent,
  computeMirrorScale,
  createVisualMirror,
} from '../../lib/visual-renderer';

interface CaptureRequest {
  identity: CapturedPageIdentity;
  reason: 'initial' | 'manual' | 'navigation' | 'authorized' | 'preference';
}

interface AuthorizedTabMessage {
  type: 'simul:authorized-tab';
  tabId: number;
  windowId: number;
  url: string;
}

const NAVIGATION_DEBOUNCE_MS = 350;
const CAPTURE_TIMEOUT_MS = 10_000;

const sourceSelect = requireElement<HTMLSelectElement>('#source-language');
const targetSelect = requireElement<HTMLSelectElement>('#target-language');
const autoTranslateSelect =
  requireElement<HTMLSelectElement>('#auto-translate-mode');
const displayModeSelect =
  requireElement<HTMLSelectElement>('#mirror-display-mode');
const swapButton = requireElement<HTMLButtonElement>('#swap-languages');
const translateButton = requireElement<HTMLButtonElement>('#translate');
const refreshButton = requireElement<HTMLButtonElement>('#refresh');
const cancelButton = requireElement<HTMLButtonElement>('#cancel');
const statusElement = requireElement<HTMLElement>('#status');
const progressRegion = requireElement<HTMLElement>('#progress-region');
const progressLabel = requireElement<HTMLLabelElement>('#progress-label');
const progressElement = requireElement<HTMLProgressElement>('#progress');
const placementGuidance = requireElement<HTMLElement>('#placement-guidance');
const snapshotContainer = requireElement<HTMLElement>('#snapshot');
const provider = new ChromeTranslatorProvider();
const captureCoordinator = new LatestWorkCoordinator<CaptureRequest>();

let preferences: CompanionPreferences = parseCompanionPreferences(
  DEFAULT_COMPANION_PREFERENCES,
);
let snapshot: PageSnapshot | undefined;
let translatedSnapshot: TranslatedSnapshot | undefined;
let followedPageIdentity: CapturedPageIdentity | undefined;
let capturedPageIdentity: CapturedPageIdentity | undefined;
let availability: TranslationAvailability = 'unavailable';
let availabilityRequestId = 0;
let captureInFlight = false;
let translationInFlight = false;
let permissionInFlight = false;
let activeAbortController: AbortController | undefined;
let activeTranslationTask: Promise<void> | undefined;
let navigationTimer: ReturnType<typeof setTimeout> | undefined;
let mirrorResizeObserver: ResizeObserver | undefined;
let panelWindowId: number | undefined;
let identityRequestId = 0;

swapButton.addEventListener('click', () => {
  const previousSource = sourceSelect.value;
  sourceSelect.value = targetSelect.value;
  targetSelect.value = previousSource;
  void directionChanged();
});

sourceSelect.addEventListener('change', () => {
  targetSelect.value = sourceSelect.value === 'ja' ? 'en' : 'ja';
  void directionChanged();
});

targetSelect.addEventListener('change', () => {
  sourceSelect.value = targetSelect.value === 'ja' ? 'en' : 'ja';
  void directionChanged();
});

autoTranslateSelect.addEventListener('change', () => {
  const mode = isAutoTranslationMode(autoTranslateSelect.value)
    ? autoTranslateSelect.value
    : 'off';
  void changeAutoTranslationMode(mode);
});

displayModeSelect.addEventListener('change', () => {
  const displayMode = isMirrorDisplayMode(displayModeSelect.value)
    ? displayModeSelect.value
    : 'fit';
  void changeDisplayMode(displayMode);
});

refreshButton.addEventListener('click', () => {
  void refreshFollowedPage('manual');
});

translateButton.addEventListener('click', () => {
  void startTranslation(false, captureCoordinator.generation);
});

cancelButton.addEventListener('click', () => {
  activeAbortController?.abort();
  setStatus('Cancelling local translation…');
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const authorizedTab = readAuthorizedTabMessage(message);
  if (!authorizedTab) return;
  void acceptAuthorizedTab(authorizedTab);
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (
    followedPageIdentity?.windowId === windowId &&
    followedPageIdentity.tabId !== tabId
  ) {
    identityRequestId += 1;
    followedPageIdentity = undefined;
    clearNavigationTimer();
    invalidateCompanion(
      'The active tab changed. Select Simul from the toolbar on the page you want to follow.',
    );
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const followed = followedPageIdentity;
  if (!followed || followed.tabId !== tabId) return;

  const nextUrl = changeInfo.url ?? tab.url ?? followed.url;
  const nextIdentity = isSupportedPage(nextUrl)
    ? { tabId, windowId: followed.windowId, url: nextUrl }
    : followed;

  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    identityRequestId += 1;
    followedPageIdentity = nextIdentity;
    syncPreferenceControls();
    clearNavigationTimer();
    invalidateCompanion(
      'The source page is changing. Simul will refresh after it finishes loading.',
      true,
    );
  }

  if (
    changeInfo.status === 'complete' ||
    (typeof changeInfo.url === 'string' && changeInfo.status !== 'loading')
  ) {
    scheduleNavigationRefresh(nextIdentity);
  }
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
  const nextPreferences = parseCompanionPreferences(
    changes[STORAGE_KEY]?.newValue,
  );
  const displayChanged = nextPreferences.displayMode !== preferences.displayMode;
  preferences = nextPreferences;
  syncPreferenceControls();
  if (displayChanged && snapshot) renderSnapshot(snapshot, translatedSnapshot);
});

void initialize();

async function initialize(): Promise<void> {
  await Promise.all([loadPreferences(), loadPanelWindowId()]);
  await Promise.allSettled([checkPanelPlacement(), refreshFollowedPage('initial')]);
}

async function loadPanelWindowId(): Promise<void> {
  try {
    panelWindowId = (await browser.windows.getCurrent()).id;
  } catch {
    panelWindowId = undefined;
  }
}

async function acceptAuthorizedTab(
  authorizedTab: CapturedPageIdentity,
): Promise<void> {
  if (panelWindowId === undefined) await loadPanelWindowId();
  if (panelWindowId === undefined || authorizedTab.windowId !== panelWindowId) {
    return;
  }

  identityRequestId += 1;
  clearNavigationTimer();
  followedPageIdentity = authorizedTab;
  syncPreferenceControls();
  queueCapture({ identity: authorizedTab, reason: 'authorized' });
}

async function loadPreferences(): Promise<void> {
  try {
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:reconcile',
    });
    preferences = result.preferences;
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

async function readStoredPreferences(): Promise<CompanionPreferences> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return parseCompanionPreferences(stored[STORAGE_KEY]);
}

async function reloadPreferencesFromStorage(): Promise<void> {
  try {
    preferences = await readStoredPreferences();
  } catch {
    preferences = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
  }
  syncPreferenceControls();
}

async function sendPreferenceCommand(
  command: PreferenceCommand,
): Promise<PreferenceCommandResult> {
  const response: unknown = await browser.runtime.sendMessage(command);
  const result = readPreferenceCommandResult(response);
  if (!result) {
    throw new Error('The preference service returned an invalid response.');
  }
  return result;
}

async function changeDisplayMode(
  displayMode: CompanionPreferences['displayMode'],
): Promise<void> {
  preferences = withDisplayMode(preferences, displayMode);
  if (snapshot) renderSnapshot(snapshot, translatedSnapshot);

  try {
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:set-display',
      displayMode,
    });
    preferences = result.preferences;
    syncPreferenceControls();
  } catch (error) {
    await reloadPreferencesFromStorage();
    setStatus(
      `Could not save the display preference: ${readableError(error)}`,
      'error',
    );
  }
}

async function checkPanelPlacement(): Promise<void> {
  const sidePanel = browser.sidePanel as typeof browser.sidePanel & {
    getLayout?: () => Promise<{ side: string }>;
  };

  if (typeof sidePanel.getLayout !== 'function') return;

  try {
    const layout = await sidePanel.getLayout();
    placementGuidance.hidden = layout.side !== 'left';
  } catch {
    // Older supported Chrome versions have no layout inspection API.
  }
}

async function refreshFollowedPage(reason: CaptureRequest['reason']): Promise<void> {
  const requestId = ++identityRequestId;
  try {
    const identity = followedPageIdentity
      ? await readCurrentFollowedIdentity(followedPageIdentity)
      : await readActivePageIdentity();
    if (requestId !== identityRequestId) return;
    followedPageIdentity = identity;
    syncPreferenceControls();
    queueCapture({ identity, reason });
  } catch (error) {
    if (requestId !== identityRequestId) return;
    const message = readPageError(error);
    clearSnapshotState();
    renderErrorState(message);
    setStatus(message, 'error');
    updateControls();
  }
}

function queueCapture(request: CaptureRequest): void {
  activeAbortController?.abort();
  availabilityRequestId += 1;
  clearSnapshotState();
  followedPageIdentity = request.identity;
  renderLoadingState();
  setStatus(
    request.reason === 'navigation'
      ? 'Refreshing the companion for the newly loaded page…'
      : 'Reading a safe visual snapshot from the source page…',
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
  }
}

async function capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
  const candidateIdentity = work.value.identity;

  try {
    const results = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: candidateIdentity.tabId, frameIds: [0] },
        func: capturePageSnapshot,
      }),
    );
    const nextSnapshot = parsePageSnapshot(results[0]?.result);
    const currentTab = await browser.tabs.get(candidateIdentity.tabId);
    assertSnapshotIsCurrent(currentTab, candidateIdentity);
    if (!captureCoordinator.isCurrent(work.generation)) return;

    snapshot = nextSnapshot;
    translatedSnapshot = undefined;
    capturedPageIdentity = candidateIdentity;
    followedPageIdentity = candidateIdentity;
    renderSnapshot(nextSnapshot);
    syncPreferenceControls();

    const fields = countTranslationFields(nextSnapshot);
    if (fields === 0) {
      availability = 'unavailable';
      setStatus(
        nextSnapshot.items.length === 0
          ? 'No visible, eligible page content was found.'
          : 'The snapshot has no text or accessible image labels to translate.',
        'warning',
      );
      return;
    }

    await checkAvailability(work.generation);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const accessWasRevoked = await reconcileAutomaticAccess(
      candidateIdentity.url,
    );
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (accessWasRevoked) {
      setStatus(
        'Chrome no longer grants the saved automatic scope, so Simul turned that scope off. Manual translation is still available.',
        'warning',
      );
      return;
    }
    await maybeTranslateAutomatically(work.generation, candidateIdentity.url);
  } catch (error) {
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const message = readPageError(error);
    clearSnapshotState();
    renderErrorState(message);
    setStatus(message, 'error');
  } finally {
    updateControls();
  }
}

async function directionChanged(): Promise<void> {
  translatedSnapshot = undefined;
  if (snapshot) renderSnapshot(snapshot);
  await checkAvailability(captureCoordinator.generation);
}

async function checkAvailability(generation: number): Promise<void> {
  const requestId = ++availabilityRequestId;
  const requestedSnapshot = snapshot;
  const pair = selectedPair();
  if (!requestedSnapshot || countTranslationFields(requestedSnapshot) === 0) {
    availability = 'unavailable';
    updateControls();
    return;
  }

  availability = 'unavailable';
  updateControls();
  try {
    const nextAvailability = await provider.availability(pair);
    if (
      !isCurrentAvailabilityRequest(
        requestId,
        requestedSnapshot,
        pair,
        generation,
      )
    ) {
      return;
    }
    availability = nextAvailability;
    switch (nextAvailability) {
      case 'available':
        setStatus('Ready to translate locally with Chrome.');
        break;
      case 'downloadable':
        setStatus(
          'Ready. Choose Translate once so Chrome can prepare the local language pack.',
        );
        break;
      case 'downloading':
        setStatus(
          'Chrome is preparing this pair. Choose Translate to continue from a user action.',
        );
        break;
      default:
        setStatus(
          `${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} is unavailable on this device.`,
          'error',
        );
    }
  } catch (error) {
    if (
      !isCurrentAvailabilityRequest(
        requestId,
        requestedSnapshot,
        pair,
        generation,
      )
    ) {
      return;
    }
    availability = 'unavailable';
    setStatus(readableError(error), 'error');
  } finally {
    if (
      isCurrentAvailabilityRequest(
        requestId,
        requestedSnapshot,
        pair,
        generation,
      )
    ) {
      updateControls();
    }
  }
}

async function maybeTranslateAutomatically(
  generation: number,
  pageUrl: string,
): Promise<void> {
  const enabled = isAutoTranslationEnabled(preferences, pageUrl);
  const action = automaticTranslationAction(enabled, availability);
  if (action === 'skip' || action === 'unavailable') return;
  if (action === 'needs-user-action') {
    setStatus(
      'Automatic translation is enabled. Choose Translate once to prepare this language pair; later page loads can run automatically.',
      'warning',
    );
    return;
  }

  if (activeTranslationTask) {
    await activeTranslationTask.catch(() => undefined);
  }
  if (!captureCoordinator.isCurrent(generation)) return;
  await startTranslation(true, generation);
}

function startTranslation(
  automatic: boolean,
  generation: number,
): Promise<void> {
  if (activeTranslationTask) return activeTranslationTask;
  const task = runTranslation(automatic, generation);
  activeTranslationTask = task;
  void task.finally(() => {
    if (activeTranslationTask === task) activeTranslationTask = undefined;
  });
  return task;
}

async function runTranslation(
  automatic: boolean,
  generation: number,
): Promise<void> {
  if (
    !snapshot ||
    translationInFlight ||
    availability === 'unavailable' ||
    (automatic && availability !== 'available')
  ) {
    return;
  }

  const runSnapshot = snapshot;
  const runIdentity = capturedPageIdentity;
  const previousTranslation = translatedSnapshot;
  if (!runIdentity) return;

  const abortController = new AbortController();
  activeAbortController = abortController;
  translationInFlight = true;
  updateControls();
  showProgress(
    automatic
      ? 'Starting prepared automatic translation…'
      : 'Preparing Chrome\'s local language model…',
    0,
    1,
  );
  setStatus(
    automatic
      ? 'Translating the newly loaded page automatically.'
      : 'Preparing on-device text translation.',
  );

  let session: TranslationSession | undefined;
  try {
    // Manual calls reach this line synchronously from the click handler, which
    // preserves the user activation Chrome requires for first-time downloads.
    session = await provider.createSession(selectedPair(), {
      signal: abortController.signal,
      onDownloadProgress: (progress) => {
        showProgress(
          `Downloading language pack… ${Math.round(progress * 100)}%`,
          progress,
          1,
        );
      },
    });
    const activeTab = await browser.tabs.get(runIdentity.tabId);
    assertSnapshotIsCurrent(activeTab, runIdentity);

    const runOptions = {
      signal: abortController.signal,
      onProgress: (progress: { completed: number; total: number }) => {
        showProgress(
          `Translating ${progress.completed} of ${progress.total}…`,
          progress.completed,
          Math.max(1, progress.total),
        );
      },
    };

    const nextTranslation = previousTranslation
      ? await retryIncompleteTranslations(
          previousTranslation,
          session,
          runOptions,
        )
      : await translateSnapshot(runSnapshot, session, runOptions);

    const tabAfterTranslation = await browser.tabs.get(runIdentity.tabId);
    assertSnapshotIsCurrent(tabAfterTranslation, runIdentity);
    if (
      !captureCoordinator.isCurrent(generation) ||
      snapshot !== runSnapshot ||
      !isSamePageIdentity(capturedPageIdentity, tabAfterTranslation)
    ) {
      throw new PageAccessError(
        'The page changed during translation. Simul discarded the stale result.',
      );
    }

    translatedSnapshot = nextTranslation;
    renderSnapshot(runSnapshot, nextTranslation);
    if (nextTranslation.state === 'cancelled') {
      setStatus(
        'Translation cancelled. Choose Continue to finish remaining text.',
        'warning',
      );
    } else if (nextTranslation.state === 'partial') {
      setStatus(
        `${nextTranslation.failed} translation segment(s) failed. Successful parts are shown; retry the remainder.`,
        'warning',
      );
    } else {
      setStatus(
        automatic
          ? 'Automatic translation complete. The source page was not changed.'
          : 'Translation complete. The source page was not changed.',
        'success',
      );
    }
  } catch (error) {
    if (!captureCoordinator.isCurrent(generation)) {
      // A newer capture owns the UI and stale translation results are ignored.
    } else if (error instanceof PageAccessError) {
      clearSnapshotState();
      renderErrorState(error.message);
      setStatus(error.message, 'warning');
    } else if (isAbortError(error) || abortController.signal.aborted) {
      setStatus(
        'Translation cancelled. Choose Translate to try again.',
        'warning',
      );
    } else {
      setStatus(readableError(error), 'error');
    }
  } finally {
    session?.destroy();
    if (activeAbortController === abortController) {
      activeAbortController = undefined;
    }
    hideProgress();
    translationInFlight = false;
    updateControls();
  }
}

function renderSnapshot(
  page: PageSnapshot,
  translated?: TranslatedSnapshot,
): void {
  mirrorResizeObserver?.disconnect();
  mirrorResizeObserver = undefined;

  const article = document.createElement('article');
  article.className = 'page-copy';
  article.append(renderSnapshotHeader(page));

  const mirror = createVisualMirror(page, translated, document);
  if (mirror && page.visual) {
    const scroller = document.createElement('div');
    scroller.className = 'mirror-scroll';
    const stage = document.createElement('div');
    stage.className = 'mirror-stage';
    const scaleLayer = document.createElement('div');
    scaleLayer.className = 'mirror-scale-layer';
    scaleLayer.style.width = `${page.visual.viewportWidth}px`;
    scaleLayer.style.minHeight = `${page.visual.documentHeight}px`;
    mirror.style.width = `${page.visual.viewportWidth}px`;
    scaleLayer.append(mirror);
    stage.append(scaleLayer);
    scroller.append(stage);
    article.append(scroller);

    const resizeMirror = (): void => {
      const scale = computeMirrorScale(
        scroller.clientWidth,
        page.visual?.viewportWidth ?? 1,
        preferences.displayMode,
      );
      const extent = computeMirrorExtent(
        scale,
        page.visual?.documentWidth ?? 1,
        page.visual?.documentHeight ?? 1,
        Math.max(scaleLayer.scrollWidth, mirror.scrollWidth),
        Math.max(scaleLayer.scrollHeight, mirror.scrollHeight),
      );
      scaleLayer.style.transform = `scale(${scale})`;
      stage.style.width = `${extent.width}px`;
      stage.style.height = `${extent.height}px`;
    };
    resizeMirror();
    if (typeof ResizeObserver === 'function') {
      mirrorResizeObserver = new ResizeObserver(resizeMirror);
      mirrorResizeObserver.observe(scroller);
      mirrorResizeObserver.observe(scaleLayer);
    }
    requestAnimationFrame(resizeMirror);

    const disclosure = document.createElement('p');
    disclosure.className = 'mirror-disclosure';
    disclosure.textContent =
      preferences.displayMode === 'fit'
        ? 'Fitted from the source viewport. Translation can change line wrapping and page height.'
        : 'Shown at the source viewport\'s 1:1 size; scroll horizontally to compare.';
    article.append(disclosure);
  } else {
    renderFlatSnapshot(article, page, translated);
  }

  const omissionText = describeOmissions(page);
  if (omissionText) {
    const omissions = document.createElement('p');
    omissions.className = 'omissions';
    omissions.textContent = omissionText;
    article.append(omissions);
  }

  snapshotContainer.replaceChildren(article);
}

function renderSnapshotHeader(page: PageSnapshot): HTMLElement {
  const header = document.createElement('header');
  header.className = 'page-copy__header';
  const title = document.createElement('h2');
  title.textContent = page.title;
  title.dir = 'auto';
  const source = document.createElement('p');
  source.className = 'page-copy__source';
  source.textContent = sourceLabel(page.url);
  header.append(title, source);
  return header;
}

function renderFlatSnapshot(
  article: HTMLElement,
  page: PageSnapshot,
  translated?: TranslatedSnapshot,
): void {
  const translatedItems = translated?.items;
  page.items.forEach((item, index) => {
    const translatedItem = translatedItems?.[index];
    if (item.kind === 'text') {
      const value =
        translatedItem?.kind === 'text'
          ? translatedItem.translation
          : undefined;
      article.append(
        renderText(
          item.role,
          value ? displayTranslation(value) : item.text,
          value,
        ),
      );
      return;
    }

    const translatedImage =
      translatedItem?.kind === 'image' ? translatedItem : undefined;
    article.append(renderImage(item, translatedImage));
  });

  if (page.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No eligible visible content was found on this page.';
    article.append(empty);
  }
}

function renderText(
  role: SnapshotTextRole,
  text: string,
  value?: TranslationValue,
): HTMLElement {
  const element = createTextElement(role);
  element.classList.add('translated-text', `translated-text--${role}`);
  element.textContent = text;
  element.dir = 'auto';

  if (value?.state === 'failed' || value?.state === 'cancelled') {
    element.classList.add('translation-fallback');
    const note = document.createElement('span');
    note.className = 'field-error';
    note.textContent = value.error ?? 'Not translated';
    element.append(note);
  }
  return element;
}

function renderImage(
  imageItem: Extract<PageSnapshot['items'][number], { kind: 'image' }>,
  translatedItem?: Extract<
    TranslatedSnapshot['items'][number],
    { kind: 'image' }
  >,
): HTMLElement {
  const figure = document.createElement('figure');
  figure.className = 'translated-image';
  const image = document.createElement('img');
  image.src = imageItem.src;
  image.alt = translatedItem?.altTranslation
    ? displayTranslation(translatedItem.altTranslation)
    : (imageItem.altText ?? '');
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => {
    image.remove();
    const placeholder = document.createElement('p');
    placeholder.className = 'image-placeholder';
    placeholder.textContent = 'The original image could not be loaded here.';
    figure.prepend(placeholder);
  });
  figure.append(image);

  const captionValue = translatedItem?.captionTranslation;
  const altValue = translatedItem?.altTranslation;
  const visibleLabel = captionValue
    ? displayTranslation(captionValue)
    : altValue
      ? displayTranslation(altValue)
      : imageItem.caption || imageItem.altText;
  if (visibleLabel) {
    const caption = document.createElement('figcaption');
    caption.textContent = visibleLabel;
    caption.dir = 'auto';
    figure.append(caption);
  }

  const disclosure = document.createElement('p');
  disclosure.className = 'image-disclosure';
  disclosure.textContent = 'Original image pixels — not translated';
  figure.append(disclosure);
  return figure;
}

function createTextElement(role: SnapshotTextRole): HTMLElement {
  if (role.startsWith('heading-')) {
    const level = Number(role.at(-1));
    return document.createElement(
      `h${Math.min(6, Math.max(2, level))}` as keyof HTMLElementTagNameMap,
    );
  }
  if (role === 'quote') return document.createElement('blockquote');
  if (role === 'code') return document.createElement('pre');
  return document.createElement('p');
}

async function changeAutoTranslationMode(
  mode: AutoTranslationMode,
): Promise<void> {
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
        ? 'Chrome cannot grant narrow access to one non-default port. Use the toolbar gesture or choose All sites.'
        : 'Open a regular HTTP or HTTPS page before enabling this-site automation.',
      'warning',
    );
    return;
  }

  permissionInFlight = true;
  updateControls();
  try {
    if (!navigator.locks) {
      throw new Error('Chrome Web Locks are unavailable in this extension page.');
    }
    const outcome = await navigator.locks.request(
      PREFERENCE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return { kind: 'busy' } as const;
        return performLockedAutoTranslationChange(
          mode,
          pageUrl,
          requestedOrigins,
        );
      },
    );

    if (outcome.kind === 'busy') {
      await reloadPreferencesFromStorage();
      setStatus(
        'Another Simul window is updating automatic access. Try this setting again.',
        'warning',
      );
      return;
    }
    if (outcome.kind === 'activation') {
      await reloadPreferencesFromStorage();
      setStatus(
        'Chrome no longer sees the setting change as a user action. Choose the setting again.',
        'warning',
      );
      return;
    }
    if (outcome.kind === 'limit') {
      preferences = outcome.preferences;
      syncPreferenceControls();
      setStatus(
        'Simul has reached its saved-site limit. Turn off an existing site before adding another.',
        'warning',
      );
      return;
    }
    if (outcome.kind === 'failed') {
      if (outcome.result) preferences = outcome.result.preferences;
      else await reloadPreferencesFromStorage();
      syncPreferenceControls();
      setStatus(
        `Chrome could not update automatic access: ${readableError(outcome.error)}`,
        'error',
      );
      return;
    }

    preferences = outcome.result.preferences;
    syncPreferenceControls();
    if (outcome.kind === 'denied') {
      setStatus(
        'Chrome did not grant automatic access. Saved scopes were reconciled with Chrome permissions.',
        'warning',
      );
      return;
    }
    if (outcome.kind === 'not-applied') {
      setStatus(
        'Chrome did not retain the requested access, so automatic translation stayed off for this scope.',
        'warning',
      );
      return;
    }

    setStatus(
      mode === 'off'
        ? 'Automatic translation is off for this scope.'
        : mode === 'all'
          ? 'Automatic translation is enabled for regular HTTP and HTTPS pages.'
          : 'Automatic translation is enabled for this site.',
      'success',
    );
    if (mode !== 'off') await refreshFollowedPage('preference');
  } catch (error) {
    const repaired = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    if (repaired) preferences = repaired.preferences;
    else await reloadPreferencesFromStorage();
    syncPreferenceControls();
    setStatus(
      `Chrome could not update automatic access: ${readableError(error)}`,
      'error',
    );
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
    const candidate = withAutoTranslationMode(
      freshPreferences,
      pageUrl,
      mode,
    );
    if (
      mode === 'site' &&
      autoTranslationModeForPage(candidate, pageUrl) !== 'site'
    ) {
      return {
        kind: 'limit',
        preferences: freshPreferences,
      } as const;
    }

    const needsPermissionPrompt = mode === 'site' || mode === 'all';
    if (needsPermissionPrompt && !navigator.userActivation.isActive) {
      return { kind: 'activation' } as const;
    }

    // A wildcard grant makes an exact-origin request look satisfied. Drop it
    // first when narrowing so Chrome records the site grant separately.
    if (mode === 'site') {
      await browser.permissions.remove({
        origins: permissionOriginsForMode('all'),
      });
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
    return {
      kind: result.applied ? 'complete' : 'not-applied',
      result,
    } as const;
  } catch (error) {
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    return { kind: 'failed', error, result } as const;
  }
}

async function reconcileAutomaticAccess(
  pageUrl: string | undefined,
): Promise<boolean> {
  const before = autoTranslationModeForPage(preferences, pageUrl);
  const result = await sendPreferenceCommand({
    type: 'simul:preferences:reconcile',
  });
  preferences = result.preferences;
  syncPreferenceControls();
  return before !== autoTranslationModeForPage(preferences, pageUrl);
}

function scheduleNavigationRefresh(identity: CapturedPageIdentity): void {
  clearNavigationTimer();
  navigationTimer = setTimeout(() => {
    navigationTimer = undefined;
    if (
      followedPageIdentity?.tabId !== identity.tabId ||
      followedPageIdentity.windowId !== identity.windowId
    ) {
      return;
    }
    queueCapture({ identity, reason: 'navigation' });
  }, NAVIGATION_DEBOUNCE_MS);
}

function clearNavigationTimer(): void {
  if (navigationTimer !== undefined) clearTimeout(navigationTimer);
  navigationTimer = undefined;
}

function withCaptureTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new PageAccessError(
          'The page took too long to capture. Simul stopped waiting so you can retry the newest page.',
        ),
      );
    }, CAPTURE_TIMEOUT_MS);
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

function invalidateCompanion(message: string, retainFollowedPage = false): void {
  captureCoordinator.invalidate();
  availabilityRequestId += 1;
  activeAbortController?.abort();
  if (!retainFollowedPage) followedPageIdentity = undefined;
  clearSnapshotState();
  if (retainFollowedPage) renderLoadingState();
  else renderErrorState(message);
  setStatus(message, 'warning');
  syncPreferenceControls();
  updateControls();
}

function clearSnapshotState(): void {
  snapshot = undefined;
  translatedSnapshot = undefined;
  capturedPageIdentity = undefined;
  availability = 'unavailable';
  mirrorResizeObserver?.disconnect();
  mirrorResizeObserver = undefined;
}

function renderLoadingState(): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  const text = document.createElement('p');
  text.textContent = 'Preparing a safe, read-only visual snapshot…';
  wrapper.append(text);
  snapshotContainer.replaceChildren(wrapper);
}

function renderErrorState(message: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state empty-state--error';
  const heading = document.createElement('h2');
  heading.textContent = 'Page unavailable';
  const text = document.createElement('p');
  text.textContent = message;
  wrapper.append(heading, text);
  snapshotContainer.replaceChildren(wrapper);
}

async function readActivePageIdentity(): Promise<CapturedPageIdentity> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return identityFromTab(tab);
}

async function readCurrentFollowedIdentity(
  followed: CapturedPageIdentity,
): Promise<CapturedPageIdentity> {
  const tab = await browser.tabs.get(followed.tabId);
  if (!tab.active || tab.windowId !== followed.windowId) {
    throw new PageAccessError(
      'The followed tab is no longer active. Select Simul from the toolbar on the page you want to follow.',
    );
  }
  return identityFromTab(tab, followed.url);
}

function identityFromTab(
  tab: Browser.tabs.Tab | undefined,
  fallbackUrl?: string,
): CapturedPageIdentity {
  const url = tab?.url ?? fallbackUrl;
  if (!tab?.id || !url || !isSupportedPage(url)) {
    throw new PageAccessError(
      'Open a regular HTTP or HTTPS page, then select Simul from its toolbar icon.',
    );
  }
  return { tabId: tab.id, windowId: tab.windowId, url };
}

function assertSnapshotIsCurrent(
  tab: Browser.tabs.Tab | undefined,
  identity: CapturedPageIdentity,
): void {
  if (!tab?.active || !isSamePageIdentity(identity, tab)) {
    throw new PageAccessError(
      'The active page changed or access expired. Select Simul from the toolbar on the source page to authorize and refresh it.',
    );
  }
}

function readAuthorizedTabMessage(
  message: unknown,
): CapturedPageIdentity | undefined {
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
  ) {
    return undefined;
  }

  const authorized = message as AuthorizedTabMessage;
  return {
    tabId: authorized.tabId,
    windowId: authorized.windowId,
    url: authorized.url,
  };
}

function isCurrentAvailabilityRequest(
  requestId: number,
  requestedSnapshot: PageSnapshot,
  pair: TranslationPair,
  generation: number,
): boolean {
  const currentPair = selectedPair();
  return (
    requestId === availabilityRequestId &&
    captureCoordinator.isCurrent(generation) &&
    snapshot === requestedSnapshot &&
    currentPair.sourceLanguage === pair.sourceLanguage &&
    currentPair.targetLanguage === pair.targetLanguage
  );
}

function countTranslationFields(page: PageSnapshot): number {
  return page.items.reduce((count, item) => {
    if (item.kind === 'text') return count + 1;
    return count + Number(Boolean(item.altText)) + Number(Boolean(item.caption));
  }, 0);
}

function describeOmissions(page: PageSnapshot): string {
  const total =
    page.omissions.hidden +
    page.omissions.controls +
    page.omissions.frames +
    page.omissions.unsafeImages;
  if (total === 0 && !page.omissions.truncated) return '';

  const details: string[] = [];
  if (page.omissions.controls) details.push('private control contents');
  if (page.omissions.frames) details.push('embedded frame contents');
  if (page.omissions.hidden) details.push('hidden content');
  if (page.omissions.unsafeImages) details.push('unsupported image sources');
  if (page.omissions.truncated) details.push('content beyond safety limits');
  return `Safely omitted: ${details.join(', ')}.`;
}

function selectedPair(): TranslationPair {
  return {
    sourceLanguage: readLanguage(sourceSelect.value),
    targetLanguage: readLanguage(targetSelect.value),
  };
}

function readLanguage(value: string): SupportedLanguage {
  return value === 'en' ? 'en' : 'ja';
}

function syncPreferenceControls(): void {
  const pageUrl = followedPageIdentity?.url ?? capturedPageIdentity?.url;
  autoTranslateSelect.value = autoTranslationModeForPage(preferences, pageUrl);
  displayModeSelect.value = preferences.displayMode;
}

function updateControls(): void {
  const busy = captureInFlight || translationInFlight || permissionInFlight;
  sourceSelect.disabled = busy;
  targetSelect.disabled = busy;
  swapButton.disabled = busy;
  autoTranslateSelect.disabled = busy;
  displayModeSelect.disabled = busy;
  refreshButton.disabled = false;
  cancelButton.hidden = !translationInFlight;
  cancelButton.disabled = !translationInFlight;

  const hasWork = snapshot ? countTranslationFields(snapshot) > 0 : false;
  const incomplete = translatedSnapshot
    ? countIncompleteTranslations(translatedSnapshot)
    : 0;
  const complete = translatedSnapshot?.state === 'complete';
  translateButton.disabled =
    busy || !hasWork || availability === 'unavailable' || complete;
  translateButton.textContent = incomplete
    ? translatedSnapshot?.state === 'cancelled'
      ? `Continue translation (${incomplete})`
      : `Retry unfinished (${incomplete})`
    : complete
      ? 'Translation complete'
      : 'Translate page';
}

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

function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return 'Active page';
  }
}

function readPageError(error: unknown): string {
  if (error instanceof PageAccessError) return error.message;
  const message = readableError(error);
  if (/cannot access|permission|extensions gallery|chrome:\/\//iu.test(message)) {
    return 'Simul no longer has access to this page. Select its toolbar icon on the source page to authorize and refresh without closing the panel.';
  }
  return message;
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
  if (!element) throw new Error(`Missing side-panel element: ${selector}`);
  return element;
}

class PageAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageAccessError';
  }
}
