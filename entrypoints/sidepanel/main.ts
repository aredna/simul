import { ChromeTranslatorProvider } from '../../lib/chrome-translator';
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

const sourceSelect = requireElement<HTMLSelectElement>('#source-language');
const targetSelect = requireElement<HTMLSelectElement>('#target-language');
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

let snapshot: PageSnapshot | undefined;
let translatedSnapshot: TranslatedSnapshot | undefined;
let capturedPageIdentity: CapturedPageIdentity | undefined;
let availability: TranslationAvailability = 'unavailable';
let availabilityRequestId = 0;
let invalidationId = 0;
let isBusy = false;
let activeAbortController: AbortController | undefined;

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

refreshButton.addEventListener('click', () => {
  void refreshSnapshot();
});

translateButton.addEventListener('click', () => {
  void runTranslation();
});

cancelButton.addEventListener('click', () => {
  activeAbortController?.abort();
  setStatus('Cancelling local translation…');
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  if (
    capturedPageIdentity?.windowId === windowId &&
    tabId !== capturedPageIdentity.tabId
  ) {
    invalidateCompanion(
      'The active tab changed. Reopen Simul from the page you want to translate.',
    );
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    capturedPageIdentity?.tabId === tabId &&
    (changeInfo.status === 'loading' || typeof changeInfo.url === 'string')
  ) {
    invalidateCompanion(
      'The source page navigated or reloaded. Refresh the snapshot before translating.',
    );
  }
});

void initialize();

async function initialize(): Promise<void> {
  await Promise.allSettled([checkPanelPlacement(), refreshSnapshot()]);
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
    // Chrome 138 and 139 have no layout inspection. The neutral footer still
    // explains that placement belongs to Chrome rather than Simul.
  }
}

async function refreshSnapshot(): Promise<void> {
  if (isBusy) return;
  setBusy(true, false);
  snapshot = undefined;
  translatedSnapshot = undefined;
  capturedPageIdentity = undefined;
  availability = 'unavailable';
  availabilityRequestId += 1;
  setStatus('Reading visible, eligible content from the active page…');
  renderLoadingState();

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !isSupportedPage(tab.url)) {
      throw new PageAccessError(
        'Open a regular HTTP or HTTPS page, then open Simul from its toolbar icon.',
      );
    }

    const candidateIdentity = {
      tabId: tab.id,
      windowId: tab.windowId,
      url: tab.url,
    };
    const results = await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: capturePageSnapshot,
    });
    const rawSnapshot = results[0]?.result;
    const nextSnapshot = parsePageSnapshot(rawSnapshot);
    const [currentTab] = await queryActiveTab();
    assertSnapshotIsCurrent(currentTab, candidateIdentity);

    snapshot = nextSnapshot;
    capturedPageIdentity = candidateIdentity;
    renderSnapshot(nextSnapshot);

    const fields = countTranslationFields(nextSnapshot);
    if (fields === 0) {
      availability = 'unavailable';
      setStatus(
        nextSnapshot.items.length === 0
          ? 'No visible, eligible page content was found.'
          : 'The snapshot has no text or accessible image labels to translate.',
        'warning',
      );
    } else {
      await checkAvailability();
    }
  } catch (error) {
    renderErrorState(readPageError(error));
    setStatus(readPageError(error), 'error');
  } finally {
    setBusy(false, false);
    updateButtons();
  }
}

async function directionChanged(): Promise<void> {
  translatedSnapshot = undefined;
  if (snapshot) renderSnapshot(snapshot);
  await checkAvailability();
}

async function checkAvailability(): Promise<void> {
  const requestId = ++availabilityRequestId;
  const requestedSnapshot = snapshot;
  const pair = selectedPair();
  if (!requestedSnapshot || countTranslationFields(requestedSnapshot) === 0) {
    availability = 'unavailable';
    updateButtons();
    return;
  }

  availability = 'unavailable';
  updateButtons();
  try {
    const nextAvailability = await provider.availability(pair);
    if (!isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair)) {
      return;
    }
    availability = nextAvailability;
    switch (nextAvailability) {
      case 'available':
        setStatus('Ready to translate locally with Chrome.');
        break;
      case 'downloadable':
        setStatus(
          'Ready. Chrome will download the local language pack after you choose Translate.',
        );
        break;
      case 'downloading':
        setStatus('Chrome is preparing this local language pair.');
        break;
      default:
        setStatus(
          `${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} is unavailable on this device.`,
          'error',
        );
    }
  } catch (error) {
    if (!isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair)) {
      return;
    }
    availability = 'unavailable';
    setStatus(readableError(error), 'error');
  } finally {
    if (isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair)) {
      updateButtons();
    }
  }
}

async function runTranslation(): Promise<void> {
  if (!snapshot || isBusy || availability === 'unavailable') return;

  const runSnapshot = snapshot;
  const runIdentity = capturedPageIdentity;
  const runInvalidationId = invalidationId;
  const previousTranslation = translatedSnapshot;
  if (!runIdentity) return;

  const abortController = new AbortController();
  activeAbortController = abortController;
  setBusy(true, true);
  showProgress('Preparing Chrome\'s local language model…', 0, 1);
  setStatus('Preparing on-device text translation.');

  let session: TranslationSession | undefined;
  try {
    // Start model creation directly inside the click handler. This preserves
    // Chrome's user-activation requirement when a language pack is needed.
    const sessionPromise = provider.createSession(selectedPair(), {
      signal: abortController.signal,
      onDownloadProgress: (progress) => {
        showProgress(
          `Downloading language pack… ${Math.round(progress * 100)}%`,
          progress,
          1,
        );
      },
    });
    session = await sessionPromise;
    const [activeTab] = await queryActiveTab();
    assertSnapshotIsCurrent(activeTab, runIdentity);

    const runOptions = {
      signal: abortController.signal,
      onProgress: (progress: {
        completed: number;
        total: number;
      }) => {
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

    const [tabAfterTranslation] = await queryActiveTab();
    assertSnapshotIsCurrent(tabAfterTranslation, runIdentity);
    if (
      invalidationId !== runInvalidationId ||
      snapshot !== runSnapshot ||
      !isSamePageIdentity(capturedPageIdentity, tabAfterTranslation)
    ) {
      throw new PageAccessError(
        'The page changed during translation. Refresh the snapshot and try again.',
      );
    }

    translatedSnapshot = nextTranslation;
    renderSnapshot(runSnapshot, nextTranslation);
    if (nextTranslation.state === 'cancelled') {
      setStatus('Translation cancelled. Choose Continue to finish remaining text.', 'warning');
    } else if (nextTranslation.state === 'partial') {
      setStatus(
        `${nextTranslation.failed} translation segment(s) failed. The successful parts are shown; retry the remainder.`,
        'warning',
      );
    } else {
      setStatus(
        `Translation complete. The source page was not changed.`,
        'success',
      );
    }
  } catch (error) {
    if (error instanceof PageAccessError) {
      invalidateCompanion(error.message);
    } else if (invalidationId !== runInvalidationId) {
      // The tab event already cleared stale content and displayed guidance.
    } else if (isAbortError(error) || abortController.signal.aborted) {
      setStatus('Translation cancelled. Choose Translate to try again.', 'warning');
    } else {
      setStatus(readableError(error), 'error');
    }
  } finally {
    session?.destroy();
    activeAbortController = undefined;
    hideProgress();
    setBusy(false, false);
    updateButtons();
  }
}

function renderSnapshot(
  page: PageSnapshot,
  translated?: TranslatedSnapshot,
): void {
  const article = document.createElement('article');
  article.className = 'page-copy';

  const header = document.createElement('header');
  header.className = 'page-copy__header';
  const title = document.createElement('h2');
  title.textContent = page.title;
  title.dir = 'auto';
  const source = document.createElement('p');
  source.className = 'page-copy__source';
  source.textContent = sourceLabel(page.url);
  header.append(title, source);
  article.append(header);

  const translatedItems = translated?.items;
  page.items.forEach((item, index) => {
    const translatedItem = translatedItems?.[index];
    if (item.kind === 'text') {
      const value =
        translatedItem?.kind === 'text'
          ? translatedItem.translation
          : undefined;
      article.append(renderText(item.role, value ? displayTranslation(value) : item.text, value));
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

  const omissionText = describeOmissions(page);
  if (omissionText) {
    const omissions = document.createElement('p');
    omissions.className = 'omissions';
    omissions.textContent = omissionText;
    article.append(omissions);
  }

  snapshotContainer.replaceChildren(article);
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
  translatedItem?: Extract<TranslatedSnapshot['items'][number], { kind: 'image' }>,
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

  const failed = [altValue, captionValue].find(
    (field) => field?.state === 'failed' || field?.state === 'cancelled',
  );
  if (failed) {
    const note = document.createElement('p');
    note.className = 'field-error';
    note.textContent = failed.error ?? 'Image text was not translated.';
    figure.append(note);
  }
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

function renderLoadingState(): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  const text = document.createElement('p');
  text.textContent = 'Preparing a safe, read-only page snapshot…';
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

function assertSnapshotIsCurrent(
  tab: Browser.tabs.Tab | undefined,
  identity: CapturedPageIdentity,
): void {
  if (!isSamePageIdentity(identity, tab)) {
    throw new PageAccessError(
      'The active tab or page URL changed, or page access expired. Refresh Simul from the source page.',
    );
  }
}

async function queryActiveTab(): Promise<Browser.tabs.Tab[]> {
  return browser.tabs.query({ active: true, currentWindow: true });
}

function invalidateCompanion(message: string): void {
  invalidationId += 1;
  availabilityRequestId += 1;
  activeAbortController?.abort();
  snapshot = undefined;
  translatedSnapshot = undefined;
  capturedPageIdentity = undefined;
  availability = 'unavailable';
  renderErrorState(message);
  setStatus(message, 'warning');
  updateButtons();
}

function isCurrentAvailabilityRequest(
  requestId: number,
  requestedSnapshot: PageSnapshot,
  pair: TranslationPair,
): boolean {
  const currentPair = selectedPair();
  return (
    requestId === availabilityRequestId &&
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
  if (page.omissions.controls) details.push('interactive/private controls');
  if (page.omissions.frames) details.push('embedded frames');
  if (page.omissions.hidden) details.push('hidden content');
  if (page.omissions.unsafeImages) details.push('unsupported images');
  if (page.omissions.truncated) details.push('content beyond local limits');
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

function setBusy(busy: boolean, cancellable: boolean): void {
  isBusy = busy;
  sourceSelect.disabled = busy;
  targetSelect.disabled = busy;
  swapButton.disabled = busy;
  refreshButton.disabled = busy;
  cancelButton.hidden = !cancellable;
  cancelButton.disabled = !cancellable;
  updateButtons();
}

function updateButtons(): void {
  const hasWork = snapshot ? countTranslationFields(snapshot) > 0 : false;
  const incomplete = translatedSnapshot
    ? countIncompleteTranslations(translatedSnapshot)
    : 0;
  const complete = translatedSnapshot?.state === 'complete';
  translateButton.disabled =
    isBusy || !hasWork || availability === 'unavailable' || complete;
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
    return 'Chrome does not allow Simul to read this page. Open a regular website and launch Simul again.';
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
