import {
  PDF_VIEWER_HELLO_TYPE,
  PDF_VIEWER_ORIGIN,
  isPdfViewerPortName,
  pdfViewerPageZoom,
  pdfViewerShowsToolbar,
  readPdfViewerScale,
  readPdfViewerScrollbar,
  readPdfViewerViewport,
  type PdfViewerPortMessage,
} from './pdf-viewer-protocol';

/** Hellos until the viewer answers; it answers once its page has loaded. */
export const PDF_VIEWER_HELLO_INTERVAL_MS = 1_000;
/**
 * How often the frame is looked for once the viewer has answered: Chrome
 * replaces the viewer's iframe when its page reloads, and the new frame needs
 * a hello of its own.
 */
export const PDF_VIEWER_WATCH_INTERVAL_MS = 5_000;
/**
 * An answered viewer this long without a report may have reloaded its document
 * in place (the same window): say hello again, within the hello budget.
 */
export const PDF_VIEWER_REHELLO_AFTER_MS = 60_000;
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
  /**
   * How wide this document draws a scrollbar, in CSS pixels; `undefined`
   * when it cannot be measured.
   */
  readonly measureScrollbar?: () => number | undefined;
  /** The screen's pixels per CSS pixel: a scrollbar's width changes with it. */
  readonly devicePixelRatio?: () => number;
  /** The tab's height in its CSS pixels, which tells a default zoom (D184). */
  readonly innerHeight?: () => number;
  /** The fragment of the PDF's address, which may hide the viewer's toolbar (D189). */
  readonly locationHash?: () => string;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/**
 * Runs in the PDF tab's top document (D108). For each panel that connects,
 * it says hello to Chrome's PDF viewer frame, so the viewer reports its
 * viewport to this document, and passes each `viewport` report on: five
 * numbers, the time, how wide this document draws a scrollbar and the
 * screen's scale (D134), nothing else. Reports are taken only from the
 * viewer's frame and origin.
 * Nothing is sent to the viewer but the hello, whose type the viewer
 * ignores.
 *
 * The viewer reports its viewport with its scrollbars and measures them
 * itself, so this document, which draws them as wide, measures one the
 * same way: a box that is not shown, added to the document and taken out
 * again at once.
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
  const measureScrollbar = environment.measureScrollbar ?? measureDocumentScrollbar;
  const devicePixelRatio = environment.devicePixelRatio ??
    (() => (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1);
  const innerHeight = environment.innerHeight ??
    (() => (globalThis as { innerHeight?: number }).innerHeight ?? Number.NaN);
  const locationHash = environment.locationHash ??
    (() => (globalThis as { location?: { hash?: string } }).location?.hash ?? '');
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
  // (Refresh, the separate window) gets no `documentLoaded` of its own. The
  // window that answered is remembered: a frame Chrome replaced (a viewer
  // reload) is another window, which has not answered yet.
  let answeredWindow: unknown;

  // Measured once, and again when the window is on a screen of another
  // scale (a scrollbar is a whole number of screen pixels wide).
  let scrollbar: {
    readonly width: number | undefined;
    /** The scale as read, and as it is passed on (`undefined`: not known). */
    readonly ratio: number | undefined;
    readonly scale: number | undefined;
  } | undefined;
  const screen = (): { readonly width: number | undefined; readonly scale: number | undefined } => {
    let ratio: number | undefined;
    try {
      ratio = devicePixelRatio();
    } catch {
      ratio = undefined;
    }
    if (!scrollbar || !Object.is(scrollbar.ratio, ratio)) {
      let width: number | undefined;
      try {
        width = readPdfViewerScrollbar(measureScrollbar());
      } catch {
        width = undefined;
      }
      scrollbar = { width, ratio, scale: readPdfViewerScale(ratio) };
    }
    return scrollbar;
  };

  runtime.onConnect.addListener((port) => {
    if (!isPdfViewerPortName(port.name)) return;
    let viewer: ViewerFrame | undefined;
    let hellos = 0;
    /** The viewer window this panel has said hello to. */
    let saidHelloTo: unknown;
    /** When an accepted message last came from the viewer, by `now`. */
    let lastHeardAt = now();
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
      // Chrome may replace the viewer's iframe when its page reloads: find it
      // again every time, and say hello to whichever frame is embedded now.
      const found = findViewer();
      if (found) viewer = found;
      const answered = viewer !== undefined && viewer.contentWindow === answeredWindow;
      // An answered viewer that has gone quiet may have reloaded its document
      // in place: the same window, so nothing else tells, and it sends no
      // reports until it is said hello to again.
      const quiet = answered &&
        saidHelloTo === viewer?.contentWindow &&
        now() - lastHeardAt >= PDF_VIEWER_REHELLO_AFTER_MS;
      // A later panel says one hello even to a viewer that answered another,
      // so the viewer reports to it; after that it only looks for the frame.
      if (!answered || saidHelloTo !== viewer?.contentWindow || quiet) {
        if (quiet) lastHeardAt = now();
        hellos += 1;
        saidHelloTo = viewer?.contentWindow;
        try {
          viewer?.contentWindow?.postMessage(
            { type: PDF_VIEWER_HELLO_TYPE },
            PDF_VIEWER_ORIGIN,
          );
        } catch {
          // A frame between documents takes the next hello.
        }
        if (hellos >= PDF_VIEWER_MAX_HELLOS) return;
      }
      timer = startTimer(hello, answered ? PDF_VIEWER_WATCH_INTERVAL_MS : PDF_VIEWER_HELLO_INTERVAL_MS);
    };
    const onMessage = (event: MessageEventLike) => {
      if (!open || event.origin !== PDF_VIEWER_ORIGIN) return;
      if (event.source !== viewer?.contentWindow) {
        // The report is not from the frame we knew: Chrome may have replaced
        // it. Take a report from the frame embedded now, none from any other.
        const found = findViewer();
        if (!found || event.source !== found.contentWindow) return;
        viewer = found;
      }
      const type = (event.data as { type?: unknown } | null)?.type;
      if (type === 'documentLoaded') {
        answeredWindow = event.source;
        lastHeardAt = now();
        return;
      }
      if (type !== 'viewport') return;
      const viewport = readPdfViewerViewport(event.data);
      if (!viewport) return;
      answeredWindow = event.source;
      lastHeardAt = now();
      const measured = screen();
      // In the viewer's own pixels: a default zoom scales the tab's (D184).
      let zoom = 1;
      try {
        zoom = pdfViewerPageZoom(
          viewport.viewportHeight,
          innerHeight(),
          pdfViewerShowsToolbar(locationHash()),
        );
      } catch {
        zoom = 1;
      }
      const width = measured.width === undefined
        ? undefined
        : readPdfViewerScrollbar(measured.width * zoom);
      const scale = measured.scale === undefined
        ? undefined
        : readPdfViewerScale(measured.scale / zoom);
      try {
        port.postMessage({
          kind: 'viewport',
          ...viewport,
          time: now(),
          ...(width === undefined ? {} : { scrollbar: width }),
          ...(scale === undefined ? {} : { scale }),
        });
      } catch {
        close();
      }
    };
    sourceWindow.addEventListener('message', onMessage);
    port.onDisconnect.addListener(close);
    hello();
  });
}

/**
 * How wide the document draws a scrollbar, as Chrome's viewer measures its
 * own (`getScrollbarWidth` in its `viewport.ts`), to a fraction of a pixel:
 * on a screen scaled by 125% a scrollbar of 19 screen pixels is 15.2 wide.
 * The box is in a closed shadow root of an element that hangs from
 * `<html>`, where it has a layout whatever the body holds: a style sheet
 * put into this document (an extension that restyles scrollbars) does not
 * reach in there, as it does not reach into the viewer's frame. Nothing of
 * it is shown.
 */
function measureDocumentScrollbar(): number | undefined {
  const root = document.documentElement;
  if (!root) return undefined;
  const host = document.createElement('div');
  host.style.cssText =
    'all:initial!important;display:block!important;position:absolute!important;' +
    'top:-9999px!important;left:0!important;width:100px!important;' +
    'height:100px!important;visibility:hidden!important;pointer-events:none!important';
  const shadow = host.attachShadow({ mode: 'closed' });
  const box = document.createElement('div');
  box.style.cssText = 'width:100px;height:100px;overflow:scroll';
  const content = document.createElement('div');
  content.style.cssText = 'width:100%;height:1px';
  box.appendChild(content);
  shadow.appendChild(box);
  root.appendChild(host);
  try {
    const outer = box.getBoundingClientRect().width;
    const inner = content.getBoundingClientRect().width;
    return outer > 0 && inner > 0 ? Math.max(0, outer - inner) : undefined;
  } finally {
    host.remove();
  }
}
