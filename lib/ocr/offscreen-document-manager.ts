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
}

/** Serializes Chrome's one-offscreen-document creation boundary. */
export class OcrOffscreenDocumentManager {
  #creating: Promise<boolean> | undefined;

  constructor(private readonly browser: OcrOffscreenBrowser) {}

  ensure(): Promise<boolean> {
    return this.#creating ??= this.#ensure().finally(() => {
      this.#creating = undefined;
    });
  }

  async #ensure(): Promise<boolean> {
    const documentUrl = this.browser.getUrl('/offscreen.html');
    const contexts = await this.browser.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl],
    });
    if (contexts.length > 0) return true;
    try {
      await this.browser.createDocument({
        url: '/offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Run user-enabled local image text recognition off the visible companion thread.',
      });
      return true;
    } catch (error) {
      // A concurrent service-worker wake may have won the single-document race.
      const after = await this.browser.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [documentUrl],
      });
      if (after.length > 0) return true;
      throw error;
    }
  }
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
  });
}
