export interface OcrOffscreenBrowser {
  getContexts(filter: {
    readonly contextTypes: readonly ['OFFSCREEN_DOCUMENT'];
    readonly documentUrls: readonly string[];
  }): Promise<readonly unknown[]>;
  createDocument(parameters: {
    readonly url: string;
    readonly reasons: readonly ['WORKERS'];
    readonly justification: string;
  }): Promise<void>;
  getUrl(path: string): string;
  closeDocument?(): Promise<void>;
}

/** Serializes Chrome's one-offscreen-document creation boundary. */
export class OcrOffscreenDocumentManager {
  #creating: Promise<boolean> | undefined;
  #closing: Promise<void> | undefined;
  #generation = 0;
  #resetEpoch = 0;

  constructor(private readonly browser: OcrOffscreenBrowser) {}

  ensure(resetEpoch: number): Promise<boolean> {
    if (!isResetEpoch(resetEpoch) || resetEpoch !== this.#resetEpoch) {
      return Promise.resolve(false);
    }
    if (this.#closing) {
      return this.#closing.then(
        () => false,
        () => false,
      );
    }
    if (this.#creating) return this.#creating;
    const generation = this.#generation;
    const operation = this.#ensure(generation, resetEpoch);
    const tracked = operation.finally(() => {
      if (this.#creating === tracked) this.#creating = undefined;
    });
    this.#creating = tracked;
    return tracked;
  }

  /** Advance monotonically and close any host created by the older epoch. */
  async advanceResetEpoch(resetEpoch: number): Promise<boolean> {
    if (!isResetEpoch(resetEpoch) || resetEpoch < this.#resetEpoch) return false;
    if (resetEpoch === this.#resetEpoch) return true;
    this.#resetEpoch = resetEpoch;
    await this.close();
    return true;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#generation += 1;
    const creating = this.#creating;
    const operation = (async () => {
      await creating?.catch(() => undefined);
      const documentUrl = this.browser.getUrl('/offscreen.html');
      const contexts = await this.browser.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl],
      });
      if (contexts.length === 0) return;
      if (!this.browser.closeDocument) {
        throw new Error('Offscreen document shutdown is unavailable.');
      }
      try {
        await this.browser.closeDocument();
      } catch (error) {
        // Chrome can race an independently closing document. Treat the close
        // as successful only after the same exact context is proven absent.
        const after = await this.browser.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [documentUrl],
        });
        if (after.length > 0) throw error;
      }
    })();
    const tracked = operation.finally(() => {
      if (this.#closing === tracked) this.#closing = undefined;
    });
    this.#closing = tracked;
    return tracked;
  }

  async #ensure(generation: number, resetEpoch: number): Promise<boolean> {
    if (
      generation !== this.#generation ||
      resetEpoch !== this.#resetEpoch
    ) return false;
    const documentUrl = this.browser.getUrl('/offscreen.html');
    const contexts = await this.browser.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    });
    if (
      generation !== this.#generation ||
      resetEpoch !== this.#resetEpoch
    ) return false;
    if (contexts.length > 0) return true;
    try {
      await this.browser.createDocument({
        url: '/offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run user-enabled local image text recognition off the visible companion thread.',
      });
      return generation === this.#generation &&
        resetEpoch === this.#resetEpoch;
    } catch (error) {
      // A concurrent service-worker wake may have won the single-document race.
      const after = await this.browser.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl],
      });
      if (
        generation !== this.#generation ||
        resetEpoch !== this.#resetEpoch
      ) return false;
      if (after.length > 0) return true;
      throw error;
    }
  }
}

function isResetEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function createBrowserOcrOffscreenManager(): OcrOffscreenDocumentManager {
  return new OcrOffscreenDocumentManager({
    getContexts: (filter) => browser.runtime.getContexts({
      contextTypes: [...filter.contextTypes],
      documentUrls: [...filter.documentUrls],
    }),
    createDocument: (parameters) => browser.offscreen.createDocument({
      url: parameters.url,
      reasons: [...parameters.reasons],
      justification: parameters.justification,
    }),
    getUrl: (path) => (browser.runtime.getURL as (value: string) => string)(path),
    closeDocument: () => browser.offscreen.closeDocument(),
  });
}
