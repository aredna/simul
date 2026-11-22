/**
 * What Chrome's PDF viewer tells the page that embeds it, and how Simul's
 * tab-side bridge passes it to the panel (D108). The viewer's `viewport`
 * message is undocumented: it gives where the most visible page sits on
 * screen and the viewport's size, never which page that is. The bridge adds
 * how wide the tab draws a scrollbar, which the viewer does not say (D134).
 */

/** Chrome's PDF viewer, a component extension; Edge's viewer differs. */
export const PDF_VIEWER_ORIGIN = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai';
/**
 * Any message makes the viewer answer the page that sent it. This type is
 * one the viewer ignores, so saying hello asks it to do nothing.
 */
export const PDF_VIEWER_HELLO_TYPE = 'simul:follow';

const PORT_PREFIX = 'simul-pdf-viewer:';
// Screen lengths beyond this are not a real viewer's.
const MAX_LENGTH = 10_000_000;
/** No browser draws a scrollbar wider than this (CSS px). */
export const PDF_VIEWER_MAX_SCROLLBAR = 64;
// A screen's device pixels per CSS pixel are within these.
const MIN_SCREEN_SCALE = 0.2;
const MAX_SCREEN_SCALE = 16;

/** The viewer's report: CSS pixels of the viewer's own scrolling viewport. */
export interface PdfViewerViewport {
  /** The most visible page's left and top edges, from the viewport's. */
  readonly pageX: number;
  readonly pageY: number;
  /** The most visible page's width on screen. */
  readonly pageWidth: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

/** One report as the bridge passes it on, with the tab's time in ms. */
export interface PdfViewerPortMessage extends PdfViewerViewport {
  readonly kind: 'viewport';
  readonly time: number;
  /**
   * How wide the tab draws a scrollbar, in CSS pixels (D134): 0 where
   * scrollbars lie over the page. The viewer's reports give its viewport
   * with its scrollbars, so the bottom of a PDF wider than the view is this
   * much higher than they say. Absent when the tab could not tell.
   */
  readonly scrollbar?: number;
  /**
   * The screen's device pixels per CSS pixel in the tab (D134). Chrome lays
   * the viewer out in device pixels: on a screen scaled by a fraction
   * (125%, 150%) the bottom of the PDF is up to 2 px from where whole CSS
   * pixels put it. Absent when the tab could not tell.
   */
  readonly scale?: number;
}

/** The five numbers of a viewer report, or `undefined` when it is not one. */
export function readPdfViewerViewport(data: unknown): PdfViewerViewport | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const pageX = record.pageX;
  const pageY = record.pageY;
  const pageWidth = record.pageWidth;
  const viewportWidth = record.viewportWidth;
  const viewportHeight = record.viewportHeight;
  if (
    !isLength(pageX) ||
    !isLength(pageY) ||
    !isLength(pageWidth) ||
    !isLength(viewportWidth) ||
    !isLength(viewportHeight) ||
    !(pageWidth > 0) ||
    !(viewportWidth > 0) ||
    !(viewportHeight > 0)
  ) return undefined;
  return { pageX, pageY, pageWidth, viewportWidth, viewportHeight };
}

/** A bridge message the panel can use, or `undefined`. */
export function readPdfViewerPortMessage(message: unknown): PdfViewerPortMessage | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const record = message as Record<string, unknown>;
  const time = record.time;
  if (record.kind !== 'viewport' || typeof time !== 'number' || !Number.isFinite(time)) {
    return undefined;
  }
  const viewport = readPdfViewerViewport(record);
  if (!viewport) return undefined;
  const scrollbar = readPdfViewerScrollbar(record.scrollbar);
  const scale = readPdfViewerScale(record.scale);
  return {
    kind: 'viewport',
    ...viewport,
    time,
    ...(scrollbar === undefined ? {} : { scrollbar }),
    ...(scale === undefined ? {} : { scale }),
  };
}

/** A screen's device pixels per CSS pixel, or `undefined` when it is not one. */
export function readPdfViewerScale(value: unknown): number | undefined {
  return typeof value === 'number' && value >= MIN_SCREEN_SCALE && value <= MAX_SCREEN_SCALE
    ? value
    : undefined;
}

// Chrome's PDF toolbar above the viewer's viewport, in the viewer's CSS px.
const VIEWER_TOOLBAR_HEIGHT = 56;
// A ratio this near 1 is no zoom.
const NO_ZOOM = 0.01;
// Chrome's zooms run from 25% to 500%.
const MIN_PAGE_ZOOM = 0.25;
const MAX_PAGE_ZOOM = 5;

/**
 * The default zoom of Chrome's settings on the tab's own document, which
 * Chrome does not apply to the viewer's frame (D184): the viewer's CSS px
 * per the tab's. The viewer fills the tab, its toolbar 56 px above the
 * viewport it reports, so the ratio of the two heights tells it. A toolbar
 * the PDF's address hides (`toolbar`, below) leaves the viewport the whole
 * height (D189: 813 px of a tab 979 px tall at 83%, which read as 89% with
 * the toolbar counted). Else a viewport as tall as the tab is a toolbar
 * hidden some other way at 100%. 1 when it cannot be told. The tab's
 * `devicePixelRatio` and the scrollbar it measures carry that zoom (a
 * scrollbar of 18 px at 83%, where the viewer leaves 14).
 */
export function pdfViewerPageZoom(
  viewportHeight: number,
  tabHeight: number | undefined,
  toolbar = true,
): number {
  if (
    !(typeof tabHeight === 'number' && tabHeight > 0 && Number.isFinite(tabHeight)) ||
    !(viewportHeight > 0)
  ) return 1;
  if (Math.abs(viewportHeight / tabHeight - 1) < NO_ZOOM) return 1;
  const zoom = (viewportHeight + (toolbar ? VIEWER_TOOLBAR_HEIGHT : 0)) / tabHeight;
  if (Math.abs(zoom - 1) < NO_ZOOM) return 1;
  return zoom >= MIN_PAGE_ZOOM && zoom <= MAX_PAGE_ZOOM ? zoom : 1;
}

/**
 * Whether Chrome's viewer shows its toolbar for a PDF at an address with
 * this fragment: `toolbar=0` among its open parameters hides it (D189).
 */
export function pdfViewerShowsToolbar(hash: string | undefined): boolean {
  if (!hash) return true;
  const parameters = hash.replace(/^#/u, '').split('&');
  return !parameters.some((parameter) => parameter.trim().toLowerCase() === 'toolbar=0');
}

/** A scrollbar's width in CSS pixels, or `undefined` when it is not one. */
export function readPdfViewerScrollbar(value: unknown): number | undefined {
  return typeof value === 'number' && value >= 0 && value <= PDF_VIEWER_MAX_SCROLLBAR
    ? value
    : undefined;
}

export function createPdfViewerPortName(sessionId: string): string {
  if (!/^[A-Za-z0-9-]{1,64}$/u.test(sessionId)) throw new Error('Invalid PDF viewer session.');
  return `${PORT_PREFIX}${sessionId}`;
}

export function isPdfViewerPortName(name: unknown): boolean {
  return typeof name === 'string' &&
    name.startsWith(PORT_PREFIX) &&
    /^[A-Za-z0-9-]{1,64}$/u.test(name.slice(PORT_PREFIX.length));
}

function isLength(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_LENGTH;
}
