const openButton = requireElement<HTMLButtonElement>('#open-panel');
const statusElement = requireElement<HTMLElement>('#status');

openButton.addEventListener('click', () => {
  void openTranslationPanel();
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
    if (!tab?.id || !isSupportedPage(tab.url)) {
      throw new Error(
        'The panel is open, but this page cannot be read. Use a regular HTTP or HTTPS page.',
      );
    }
    setStatus('Translation panel opened beside this page.', false);
  } catch (error) {
    setStatus(readableError(error), true);
    openButton.disabled = false;
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
