/**
 * Which runtime messages may reach the OCR offscreen host and its host-creation
 * path. Matching `sender.id` is not enough on its own: a content script carries
 * the same extension id as an extension page and reports the page's URL. The
 * URL is authoritative: an extension page has a chrome-extension://<id>/ URL,
 * including a tab-hosted popout, while a content script reports its page. A
 * sender that reports no URL is trusted only when it also has no tab, which
 * covers the background service worker; a tab-hosted sender without an
 * extension URL cannot prove that it is an extension page.
 */
export interface OffscreenMessageSender {
  readonly id?: string;
  readonly tab?: unknown;
  readonly url?: string;
}

export function isTrustedOffscreenMessageSender(
  sender: OffscreenMessageSender | undefined,
  extensionId: string,
): boolean {
  if (!extensionId || !sender || sender.id !== extensionId) return false;
  const url = sender.url;
  if (url !== undefined && url !== '') {
    if (typeof url !== 'string') return false;
    return url.startsWith(`chrome-extension://${extensionId}/`);
  }
  // No URL: only a sender without a tab (the service worker) is trusted.
  return sender.tab === undefined || sender.tab === null;
}