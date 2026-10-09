import {
  SourceTabCaptureError,
  captureVisibleSourceTabPromptly,
} from '../../lib/ocr/pixel-acquisition';
import type { RgbaPixels } from '../../lib/pdf/colour-sample';
import {
  PDF_PAGE_BOX_INK_HEIGHTS,
  PDF_TOOLBAR_HEIGHT,
  composePdfPageBoxLine,
  findPdfPageBox,
  pdfPageFromBoxText,
  type PdfPageBoxLine,
  type PdfPageBoxMissing,
} from '../../lib/pdf/pdf-page-box';
import type { PdfViewerDoubt } from '../../lib/pdf/pdf-viewer-tracker';

/** A capture of the visible tab, with the tab's size in CSS pixels. */
export interface PdfTabCapture {
  /** The captured image (an `ImageBitmap`): something a canvas can draw. */
  readonly image: {
    readonly width: number;
    readonly height: number;
    close?(): void;
  };
  readonly tabWidth: number;
  readonly tabHeight: number;
}

/** The picture of the page box and the count that Simul's text recognition reads. */
export interface PdfPageBoxPicture {
  /** A PNG, `width` by `height` pixels: dark ink on white. */
  readonly encoded: Blob;
  readonly width: number;
  readonly height: number;
}

interface ReaderCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): {
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: ImageSmoothingQuality;
    fillStyle: string | CanvasGradient | CanvasPattern;
    fillRect(x: number, y: number, width: number, height: number): void;
    drawImage(
      image: never,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void;
    getImageData(x: number, y: number, width: number, height: number): {
      readonly data: ArrayLike<number>;
    };
    createImageData(width: number, height: number): { readonly data: Uint8ClampedArray };
    putImageData(data: never, x: number, y: number): void;
  } | null;
}

/** Chrome does not let the panel capture this tab. */
export const PDF_CAPTURE_REFUSED = 'refused';

/** The tab is not of a size worth capturing: nothing was asked of Chrome. */
export const PDF_CAPTURE_UNWANTED = 'unwanted';

/** Looking again is no use in this tab: Chrome does not allow the capture. */
export const PDF_LOCATE_STOP = 'stop';

/** The page found (0-based), none, or that looking again is no use. */
export type PdfLocateResult = number | undefined | typeof PDF_LOCATE_STOP;

/** Content-free: an outcome, what was missing and a time only. */
export interface PdfLocateDiagnostic {
  readonly stage: 'locate';
  /**
   * `read`: the page box gave a page (the tracker takes it unless the viewer
   * has moved since). `kept`: it did not, and the guess stays (`why` says
   * what was missing). `refused`: Chrome does not allow a capture of this
   * tab. `no-capture`: the capture failed otherwise (the tab is not the one
   * in view).
   */
  readonly outcome: 'read' | 'kept' | 'refused' | 'no-capture';
  /**
   * `size`: the capture is not the tab's size. `toolbar`: the viewer's view
   * does not start under a toolbar. `bar`, `box`, `count`, `number`: what
   * the toolbar's picture lacks. `unread`: the picture gave no text.
   * `text`: the text is not a page number and this PDF's page count.
   * `differ`: the picture read at another size names another page.
   * `page`: the page read does not fit where the viewer reports the page.
   */
  readonly why?:
    | 'size'
    | 'toolbar'
    | PdfPageBoxMissing
    | 'unread'
    | 'text'
    | 'differ'
    | 'page';
  readonly milliseconds: number;
}

export interface PdfPageBoxReaderDependencies {
  /**
   * One capture of the tab while it shows, if `wanted` says so of the tab's
   * size in CSS pixels (else `unwanted`, with nothing asked of Chrome).
   * `refused` when Chrome does not allow it (no grant for the tab);
   * `undefined` when it failed otherwise (the tab is not the one in view).
   */
  readonly capture: (
    tabId: number,
    signal: AbortSignal,
    wanted: (tabWidth: number, tabHeight: number) => boolean,
  ) => Promise<
    PdfTabCapture | typeof PDF_CAPTURE_REFUSED | typeof PDF_CAPTURE_UNWANTED | undefined
  >;
  /** A canvas to cut the toolbar out with and draw the picture on; the panel's own by default. */
  readonly createCanvas?: (width: number, height: number) => ReaderCanvas;
  /**
   * The canvas as a PNG. By default through `toDataURL`, which encodes at
   * once: `convertToBlob` and `toBlob` wait for an idle moment, up to a
   * second when the panel has none.
   */
  readonly encode?: (canvas: ReaderCanvas) => Blob | Promise<Blob>;
  readonly now?: () => number;
  readonly onDiagnostic?: (diagnostic: PdfLocateDiagnostic) => void;
}

export interface PdfPageBoxRequest {
  readonly tabId: number;
  /** The reading the tracker is unsure of. */
  readonly doubt: PdfViewerDoubt;
  /** How many pages the shown PDF has: the count the toolbar must show. */
  readonly pageCount: number;
  /**
   * The text Simul's local recognition reads in the picture; `undefined`
   * when it reads none.
   */
  readonly read: (picture: PdfPageBoxPicture, signal: AbortSignal) => Promise<string | undefined>;
  readonly signal: AbortSignal;
}

// The view starts this close under the toolbar (CSS pixels).
const TOOLBAR_SLACK = 1;
// A toolbar that shows no page box this many looks in a row is not captured
// again for a while, as long as the tab keeps its size.
const MAX_UNREADABLE_LOOKS = 3;
const UNREADABLE_PAUSE_MS = 60_000;

/**
 * Finds which page Chrome's PDF viewer shows by reading the page box of its
 * toolbar from one capture of the tab (D133). Only the toolbar's strip is
 * taken from the capture, and only the page number and the page count from
 * the strip; the capture is let go at once and nothing is kept. The page is
 * taken only when the toolbar is where the viewer's report puts it, the
 * count beside the box is this PDF's own, the picture reads the same at two
 * sizes, and the page fits where the viewer reports the page; otherwise the
 * guess stays.
 */
export class PdfPageBoxReader {
  readonly #dependencies: PdfPageBoxReaderDependencies;
  /**
   * The toolbar that last showed no page box (a tab too narrow for one, a
   * high-contrast theme, a Chrome that draws it otherwise), and how many
   * looks in a row found it so.
   */
  #unreadable: {
    readonly tabId: number;
    readonly tabWidth: number;
    readonly tabHeight: number;
    readonly pageCount: number;
    readonly missing: PdfPageBoxMissing;
    readonly looks: number;
    /** When the last of those looks was. */
    readonly at: number;
  } | undefined;

  constructor(dependencies: PdfPageBoxReaderDependencies) {
    this.#dependencies = dependencies;
  }

  async locate(request: PdfPageBoxRequest): Promise<PdfLocateResult> {
    const now = this.#dependencies.now ?? (() => performance.now());
    const started = now();
    const { doubt, pageCount, signal } = request;
    const finish = (
      outcome: PdfLocateDiagnostic['outcome'],
      why?: PdfLocateDiagnostic['why'],
    ): undefined => {
      try {
        this.#dependencies.onDiagnostic?.({
          stage: 'locate',
          outcome,
          ...(why ? { why } : {}),
          milliseconds: Math.round(now() - started),
        });
      } catch {
        // A failing log line is not a failing look.
      }
      return undefined;
    };
    // The viewer's own view takes the tab below its toolbar: with the
    // toolbar hidden (`#toolbar=0`, presenting) the top of the tab is the
    // PDF's page, which could show anything. Such a tab is not captured.
    const underToolbar = (tabHeight: number) =>
      Math.abs(tabHeight - doubt.viewport.viewportHeight - PDF_TOOLBAR_HEIGHT) <= TOOLBAR_SLACK;
    let capture: Awaited<ReturnType<PdfPageBoxReaderDependencies['capture']>>;
    // Why the tab was not worth capturing, when it was not.
    let unwanted: PdfLocateDiagnostic['why'] = 'toolbar';
    try {
      capture = await this.#dependencies.capture(
        request.tabId,
        signal,
        (tabWidth, tabHeight) => {
          if (!underToolbar(tabHeight)) return false;
          const unreadable = this.#unreadable;
          if (
            unreadable &&
            unreadable.looks >= MAX_UNREADABLE_LOOKS &&
            started - unreadable.at < UNREADABLE_PAUSE_MS &&
            unreadable.tabId === request.tabId &&
            unreadable.tabWidth === tabWidth &&
            unreadable.tabHeight === tabHeight &&
            unreadable.pageCount === pageCount
          ) {
            // The same toolbar as the last looks: it would show the same.
            unwanted = unreadable.missing;
            return false;
          }
          return true;
        },
      );
    } catch {
      capture = undefined;
    }
    if (capture === PDF_CAPTURE_REFUSED) {
      finish('refused');
      return PDF_LOCATE_STOP;
    }
    if (capture === PDF_CAPTURE_UNWANTED) return finish('kept', unwanted);
    if (!capture) return signal.aborted ? undefined : finish('no-capture');
    let strip: RgbaPixels | undefined;
    let scale = 0;
    try {
      if (signal.aborted) return undefined;
      const { image, tabWidth, tabHeight } = capture;
      scale = image.width / tabWidth;
      if (
        !(scale > 0.1 && scale < 16) ||
        Math.abs(image.height / tabHeight / scale - 1) > 0.02
      ) return finish('kept', 'size');
      if (!underToolbar(tabHeight)) return finish('kept', 'toolbar');
      strip = this.#strip(image, Math.round(PDF_TOOLBAR_HEIGHT * scale));
    } catch {
      strip = undefined;
    } finally {
      // The rest of the capture is never looked at.
      try {
        capture.image.close?.();
      } catch {
        // Already released.
      }
    }
    if (!strip) return finish('kept', 'size');
    const search = findPdfPageBox(strip, scale, pageCount);
    if (!search.found) {
      // A number that is not plain (selected, a caret) is so for a moment;
      // a toolbar without a page box stays without one.
      if (search.missing !== 'number') {
        const { tabWidth, tabHeight } = capture;
        const before = this.#unreadable;
        const again = before !== undefined &&
          before.tabId === request.tabId &&
          before.tabWidth === tabWidth &&
          before.tabHeight === tabHeight &&
          before.pageCount === pageCount;
        this.#unreadable = {
          tabId: request.tabId,
          tabWidth,
          tabHeight,
          pageCount,
          missing: search.missing,
          looks: again ? before.looks + 1 : 1,
          at: started,
        };
      }
      return finish('kept', search.missing);
    }
    this.#unreadable = undefined;
    // The number with its glyphs spaced out, and when that gives no reading,
    // as it stands in the toolbar: each is read by some fonts' digits where
    // the other is not. A page is taken from one picture's readings only.
    let page: number | undefined;
    let why: 'unread' | 'text' = 'unread';
    for (const spaced of [true, false]) {
      const line = composePdfPageBoxLine(strip, search.layout, spaced);
      let named: number | undefined;
      for (const inkHeight of PDF_PAGE_BOX_INK_HEIGHTS) {
        let text: string | undefined;
        try {
          const picture = await this.#picture(line, inkHeight);
          text = picture && await request.read(picture, signal);
        } catch {
          text = undefined;
        }
        if (signal.aborted) return undefined;
        const read = text === undefined
          ? undefined
          : pdfPageFromBoxText(text, search.layout, pageCount);
        if (read === undefined) {
          why = text === undefined ? 'unread' : 'text';
          named = undefined;
          break;
        }
        // Every reading names the same page, or none is taken.
        if (named !== undefined && read !== named) return finish('kept', 'differ');
        named = read;
      }
      if (named !== undefined) {
        page = named;
        break;
      }
    }
    if (page === undefined) return finish('kept', why);
    // Only a page that is where the viewer reports the page.
    if (!doubt.pages.includes(page - 1)) return finish('kept', 'page');
    finish('read');
    return page - 1;
  }

  /** The top `height` device pixels of the capture. */
  #strip(image: PdfTabCapture['image'], height: number): RgbaPixels | undefined {
    const width = image.width;
    if (!(width > 0) || !(height > 0) || height > image.height) return undefined;
    const canvas = this.#canvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    try {
      context.imageSmoothingEnabled = false;
      context.drawImage(image as never, 0, 0, width, height, 0, 0, width, height);
      return { width, height, data: context.getImageData(0, 0, width, height).data };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  /** The line scaled so that its digits are `inkHeight` tall, on white, as a PNG. */
  async #picture(line: PdfPageBoxLine, inkHeight: number): Promise<PdfPageBoxPicture | undefined> {
    const small = this.#canvas(line.width, line.height);
    const factor = inkHeight / line.inkHeight;
    const width = Math.max(1, Math.round(line.width * factor));
    const height = Math.max(1, Math.round(line.height * factor));
    const canvas = this.#canvas(width, height);
    try {
      const smallContext = small.getContext('2d');
      const context = canvas.getContext('2d');
      if (!smallContext || !context) return undefined;
      const pixels = smallContext.createImageData(line.width, line.height);
      for (let index = 0; index < line.data.length; index += 1) {
        const value = line.data[index]!;
        pixels.data[index * 4] = value;
        pixels.data[index * 4 + 1] = value;
        pixels.data[index * 4 + 2] = value;
        pixels.data[index * 4 + 3] = 255;
      }
      smallContext.putImageData(pixels as never, 0, 0);
      context.fillStyle = '#fff';
      context.fillRect(0, 0, width, height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(small as never, 0, 0, line.width, line.height, 0, 0, width, height);
      const encoded = await (this.#dependencies.encode ?? encodePng)(canvas);
      return { encoded, width, height };
    } finally {
      small.width = 0;
      small.height = 0;
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  #canvas(width: number, height: number): ReaderCanvas {
    const made = this.#dependencies.createCanvas?.(width, height);
    if (made) return made;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as ReaderCanvas;
  }
}

/** The panel's canvas as a PNG, encoded at once. */
function encodePng(canvas: ReaderCanvas): Blob {
  const url = (canvas as unknown as HTMLCanvasElement).toDataURL('image/png');
  const bytes = Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

/** The Chrome calls one capture of the PDF tab needs. */
export interface PdfTabCaptureEnvironment {
  readonly getTab: (tabId: number) => Promise<{
    readonly active?: boolean;
    readonly windowId?: number;
    readonly width?: number;
    readonly height?: number;
  }>;
  /** `minimized` for a window that shows nothing. */
  readonly windowState: (windowId: number) => Promise<string | undefined>;
  /** The capture as a data URL; rejects with a `SourceTabCaptureError`. */
  readonly capture: (tabId: number, windowId: number, signal: AbortSignal) => Promise<string>;
  readonly decode: (url: string) => Promise<PdfTabCapture['image']>;
}

function chromePdfTabCaptureEnvironment(): PdfTabCaptureEnvironment {
  return {
    getTab: (tabId) => browser.tabs.get(tabId),
    windowState: async (windowId) => (await browser.windows.get(windowId)).state,
    capture: (tabId, windowId, signal) => captureVisibleSourceTabPromptly(tabId, windowId, signal),
    decode: async (url) => createImageBitmap(await (await fetch(url)).blob()),
  };
}

/**
 * One capture of the PDF tab, through the same call, lock and spacing as
 * image text: Chrome allows two captures a second for the whole extension.
 * It works while the toolbar click's grant for the tab lasts, or with the
 * all-sites grant; without either Chrome refuses, and nothing is asked for.
 * Only a tab that is the one showing in a window that is not minimized is
 * captured: Chrome answers for a minimized window only when it is back,
 * and the call would hold up image text meanwhile. And only a tab of a size
 * `wanted` accepts: one that shows no toolbar is not captured at all.
 */
export async function captureChromePdfTab(
  tabId: number,
  signal: AbortSignal,
  wanted: (tabWidth: number, tabHeight: number) => boolean,
  environment: PdfTabCaptureEnvironment = chromePdfTabCaptureEnvironment(),
): Promise<PdfTabCapture | typeof PDF_CAPTURE_REFUSED | typeof PDF_CAPTURE_UNWANTED | undefined> {
  try {
    const tab = await environment.getTab(tabId);
    if (
      !tab.active ||
      tab.windowId === undefined ||
      !(tab.width && tab.width > 0) ||
      !(tab.height && tab.height > 0) ||
      (await environment.windowState(tab.windowId)) === 'minimized'
    ) return undefined;
    if (!wanted(tab.width, tab.height)) return PDF_CAPTURE_UNWANTED;
    const url = await environment.capture(tabId, tab.windowId, signal);
    if (!url.startsWith('data:image/')) return undefined;
    const image = await environment.decode(url);
    return { image, tabWidth: tab.width, tabHeight: tab.height };
  } catch (error) {
    return error instanceof SourceTabCaptureError && error.code === 'permission'
      ? PDF_CAPTURE_REFUSED
      : undefined;
  }
}
