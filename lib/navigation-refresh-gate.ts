/**
 * Coalesces Chrome's loading/url/complete event fan-out without retaining page
 * content. Callers own the opaque identity key and never expose it as a
 * diagnostic.
 */
export class NavigationRefreshGate {
  #pendingScope: string | undefined;
  #pendingKey: string | undefined;
  #sameDocumentScope: string | undefined;
  #sameDocumentKey: string | undefined;
  #lastScheduledKey: string | undefined;

  beginDocumentLoad(scope: string, key: string): boolean {
    if (!scope || !key) return false;
    this.#sameDocumentScope = undefined;
    this.#sameDocumentKey = undefined;
    if (this.#pendingScope === scope && this.#pendingKey === key) return false;
    this.#pendingScope = scope;
    this.#pendingKey = key;
    return true;
  }

  observeSameDocumentUrl(scope: string, key: string): boolean {
    if (!scope || !key) return false;
    if (this.#pendingScope === scope) {
      // Redirects and canonical/history rewrites can change the URL between
      // Chrome's loading and complete signals. Retarget the unfinished load
      // instead of consuming it as a same-document navigation.
      this.#pendingKey = key;
      return false;
    }
    // Signals are scoped to one opaque tab/document identity. A pending load
    // from a previously followed identity must not suppress the current
    // document's history update.
    this.#clearPendingLoad();
    const retargetsScheduledDocument = this.#lastScheduledKey !== undefined &&
      this.#lastScheduledKey !== key;
    this.#sameDocumentScope = scope;
    this.#sameDocumentKey = key;
    return retargetsScheduledDocument;
  }

  /**
   * Records a capture accepted through a manual, recovery, or debounced path.
   * Completed/same-document fan-out is consumed, while an unfinished document
   * retains its one authoritative Chrome `complete` capture.
   */
  consumeCapture(scope: string, key: string): void {
    if (!scope || !key) return;
    // A capture requested while Chrome still reports `loading` may observe an
    // incomplete document. Preserve that pending completion so the finished
    // page still receives its authoritative capture.
    if (this.#pendingScope === scope) return;
    // A capture for another followed identity supersedes stale loading state;
    // otherwise its eventual `complete` would trigger a redundant rebuild of
    // this already-current document and discard reusable OCR evidence.
    this.#clearPendingLoad();
    this.#sameDocumentScope = undefined;
    this.#sameDocumentKey = undefined;
    this.#lastScheduledKey = key;
  }

  shouldScheduleComplete(
    scope: string,
    key: string,
    currentCapturedKey?: string,
  ): boolean {
    if (!scope || !key) return false;
    if (this.#pendingScope === scope) {
      this.#clearPendingLoad();
      this.#sameDocumentScope = undefined;
      this.#sameDocumentKey = undefined;
      this.#lastScheduledKey = key;
      return true;
    }
    this.#clearPendingLoad();
    if (
      this.#sameDocumentScope === scope &&
      this.#sameDocumentKey === key
    ) {
      this.#sameDocumentScope = undefined;
      this.#sameDocumentKey = undefined;
      this.#lastScheduledKey = key;
      return false;
    }
    if (key === currentCapturedKey || key === this.#lastScheduledKey) {
      return false;
    }
    this.#lastScheduledKey = key;
    return true;
  }

  reset(): void {
    this.#clearPendingLoad();
    this.#sameDocumentScope = undefined;
    this.#sameDocumentKey = undefined;
    this.#lastScheduledKey = undefined;
  }

  #clearPendingLoad(): void {
    this.#pendingScope = undefined;
    this.#pendingKey = undefined;
  }
}
