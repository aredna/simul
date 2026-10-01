import {
  PDF_VIEWER_HELLO_TYPE,
  PDF_VIEWER_ORIGIN,
  isPdfViewerPortName,
  readPdfViewerViewport,
  type PdfViewerPortMessage,
} from './pdf-viewer-protocol';

/** Hellos until the viewer answers; it answers once its page has loaded. */
export const PDF_VIEWER_HELLO_INTERVAL_MS = 1_000;
export const PDF_VIEWER_MAX_HELLOS = 60;

interface PortLike {
  readonly name: string;
  postMessage(message: PdfViewerPortMessage): void;
  readonly onDisconnect: { addListener(listener: () => void): void };
}

interface MessageEventLike {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

interface ViewerFrame {
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface PdfViewerBridgeEnvironment {
  readonly global?: object;
  readonly runtime?: { onConnect: { addListener(listener: (port: PortLike) => void): void } };
  readonly document?: Pick<Document, 'body'>;
  readonly window?: {
    addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  };
  /** `chrome.dom.openOrClosedShadowRoot`: Chrome puts the viewer in a closed root. */
  readonly openShadowRoot?: (element: HTMLElement) => ShadowRoot | null | undefined;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/**
 * Runs in the PDF tab's top document (D108). For each panel that connects,
 * it says hello to Chrome's PDF viewer frame, so the viewer reports its
 * viewport to this document, and passes each `viewport` report on: five
 * numbers and the time, nothing else. Reports are taken only from the
 * viewer's frame and origin. Nothing is sent to the viewer but the hello,
 * whose type the viewer ignores.
 */
export function installPdfViewerBridge(environment: PdfViewerBridgeEnvironment = {}): void {
  const isolatedGlobal = (environment.global ?? globalThis) as {
    __simulPdfViewerBridgeV1?: boolean;
  };
  if (isolatedGlobal.__simulPdfViewerBridgeV1) return;
  isolatedGlobal.__simulPdfViewerBridgeV1 = true;
  const runtime = environment.runtime ??
    (browser.runtime as unknown as NonNullable<PdfViewerBridgeEnvironment['runtime']>);
  const sourceDocument = environment.document ?? document;
  const sourceWindow = environment.window ??
    (window as unknown as NonNullable<PdfViewerBridgeEnvironment['window']>);
  const openShadowRoot = environment.openShadowRoot ?? ((element: HTMLElement) =>
    (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?(e: HTMLElement): ShadowRoot } } })
      .chrome?.dom?.openOrClosedShadowRoot?.(element));
  const now = environment.now ?? (() => performance.now());
  const startTimer = environment.setInterval ??
    ((callback: () => void, ms: number) => setInterval(callback, ms));
  const stopTimer = environment.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));

  const findViewer = (): ViewerFrame | undefined => {
    const body = sourceDocument.body;
    if (!body) return undefined;
    let root: ShadowRoot | null | undefined;
    try {
      root = openShadowRoot(body);
    } catch {
      return undefined;
    }
    const frame = root?.querySelector('iframe[type="application/pdf"]') as
      | ViewerFrame
      | null
      | undefined;
    return frame ?? undefined;
  };

  // The viewer answers a hello once per embedding window, so a later panel
  // (Refresh, the separate window) gets no `documentLoaded` of its own.
  let viewerAnswered = false;

  runtime.onConnect.addListener((port) => {
    if (!isPdfViewerPortName(port.name)) return;
    let viewer: ViewerFrame | undefined;
    let hellos = 0;
    let timer: unknown;
    let open = true;
    const stopHellos = () => {
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
    };
    const close = () => {
      if (!open) return;
      open = false;
      stopHellos();
      sourceWindow.removeEventListener('message', onMessage);
    };
    const hello = () => {
      hellos += 1;
      viewer ??= findViewer();
      try {
        viewer?.contentWindow?.postMessage({ type: PDF_VIEWER_HELLO_TYPE }, PDF_VIEWER_ORIGIN);
      } catch {
        // A frame between documents takes the next hello.
      }
      if (viewerAnswered || hellos >= PDF_VIEWER_MAX_HELLOS) stopHellos();
    };
    const onMessage = (event: MessageEventLike) => {
      if (
        !open ||
        event.origin !== PDF_VIEWER_ORIGIN ||
        !viewer?.contentWindow ||
        event.source !== viewer.contentWindow
      ) return;
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === 'documentLoaded') {
        viewerAnswered = true;
        stopHellos();
        return;
      }
      if (type !== 'viewport') return;
      const viewport = readPdfViewerViewport(event.data);
      if (!viewport) return;
      viewerAnswered = true;
      stopHellos();
      try {
        port.postMessage({ kind: 'viewport', ...viewport, time: now() });
      } catch {
        close();
      }
    };
    sourceWindow.addEventListener('message', onMessage);
    port.onDisconnect.addListener(close);
    hello();
    if (open && !viewerAnswered && hellos < PDF_VIEWER_MAX_HELLOS) {
      timer = startTimer(hello, PDF_VIEWER_HELLO_INTERVAL_MS);
    }
  });
}
