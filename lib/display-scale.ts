import type { MirrorDisplayMode } from './preferences';

/** Custom zoom stays at or above this multiple of the size the tab shows. */
export const MIN_CUSTOM_DISPLAY_SCALE = 0.25;
/**
 * Neither Fit nor custom zoom shows a page more than this many times its CSS
 * size (Chrome's own largest zoom is 500%), so a tiny or degenerate source
 * width cannot blow the page up hundreds of times.
 */
export const MAX_DISPLAY_SCALE = 5;

/** A tab zoom factor as Chrome reports it, or 1 when it is missing or invalid. */
export function normalizeZoomFactor(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 1;
}

/**
 * How much larger than its own CSS size a page is shown (D104). The mirror
 * and the PDF view share this rule:
 * - Fit: `fitScale` (the available width over the page width), so it grows
 *   as well as shrinks, up to 5; an invalid `fitScale` falls back to 1.
 * - 1:1: the tab's zoom, so the page is the size the tab shows it.
 * - Custom: the zoom percentage times the tab's zoom, within 0.25–5.
 */
export function displayScale(
  mode: MirrorDisplayMode,
  fitScale: number,
  zoomPercent: number,
  sourceZoomFactor: unknown,
): number {
  const tabZoom = normalizeZoomFactor(sourceZoomFactor);
  if (mode === 'actual') return tabZoom;
  if (mode === 'custom') {
    const zoom = Number.isFinite(zoomPercent) ? zoomPercent : 100;
    return Math.min(
      MAX_DISPLAY_SCALE,
      Math.max(MIN_CUSTOM_DISPLAY_SCALE, (zoom / 100) * tabZoom),
    );
  }
  return Number.isFinite(fitScale) && fitScale > 0
    ? Math.min(MAX_DISPLAY_SCALE, fitScale)
    : 1;
}
