const openButton = requireElement<HTMLButtonElement>('#open-panel');
const openWindowButton = requireElement<HTMLButtonElement>('#open-window');
const statusElement = requireElement<HTMLElement>('#status');

openButton.addEventListener('click', () => {
  void openTranslationPanel();
});
openWindowButton.addEventListener('click', () => {
  void openDetachedWindow();
});

async function openTranslationPanel(): Promise<void> {
  openButton.disabled = true;
  setStatus('Opening the companion…', false);

  try {
    // Invoke open synchronously in the click task so Chrome retains the user
    // gesture required by sidePanel.open. The manifest already declares the
    // default side-panel path.
    const openPromise = browser.sidePanel.open({
      windowId: browser.windows.WINDOW_ID_CURRENT,
    });
    const tabPromise = browser.tabs.query({ active: true, currentWindow: true });
    const [[tab]] = await Promise.all([tabPromise, openPromise]);
    if (tab?.id === undefined || !isSupportedPage(tab.url)) {
      throw new Error(
        'The panel is open, but this page cannot be read. Use a regular HTTP or HTTPS page.',
      );
    }
    try {
      await browser.runtime.sendMessage({
        type: 'simul:authorized-tab',
        tabId: tab.id,
        windowId: tab.windowId,
        url: tab.url,
      });
    } catch (error) {
      // A newly created side panel may still be loading. Its own initializer
      // will read this activeTab grant; an already-open panel receives the
      // target-locked message and refreshes immediately.
      if (!/receiving end does not exist|could not establish connection/iu.test(
        readableError(error),
      )) {
        throw error;
      }
    }
    setStatus('Translation panel opened beside this page.', false);
  } catch (error) {
    setStatus(readableError(error), true);
    openButton.disabled = false;
  }
}

async function openDetachedWindow(): Promise<void> {
  openWindowButton.disabled = true;
  setStatus('Opening the detached companion…', false);
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !isSupportedPage(tab.url)) {
      throw new Error('Use a regular HTTP or HTTPS page before opening the companion.');
    }
    const url = new URL(browser.runtime.getURL('/sidepanel.html'));
    url.searchParams.set('sourceTabId', String(tab.id));
    url.searchParams.set('sourceWindowId', String(tab.windowId));
    await browser.windows.create({
      url: url.toString(),
      type: 'popup',
      width: 720,
      height: Math.max(600, Math.min(960, screen.availHeight - 80)),
      focused: true,
    });
    setStatus('Detached companion opened for this tab.', false);
  } catch (error) {
    setStatus(readableError(error), true);
    openWindowButton.disabled = false;
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

function setStatus(message: string, isError: boolean): void {
  statusElement.textContent = message;
  statusElement.classList.toggle('status--error', isError);
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Chrome could not open the translation panel. Try again.';
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing popup element: ${selector}`);
  return element;
}

export {};
