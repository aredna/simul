/**
 * What Chrome's PDF viewer tells the page that embeds it, and how Simul's
 * tab-side bridge passes it to the panel (D108). The viewer's `viewport`
 * message is undocumented: it gives where the most visible page sits on
 * screen and the viewport's size, never which page that is.
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
  return viewport && { kind: 'viewport', ...viewport, time };
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
