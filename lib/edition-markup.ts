import type { SimulEdition } from './edition';

/** An element only one edition keeps: `data-edition="dev"` or `"public"`. */
export const EDITION_ATTRIBUTE = 'data-edition';
/**
 * An element the public edition moves: `data-public-move="slot-id"` replaces
 * the public-only placeholder with that id, so one control can sit in a
 * different group per edition without being written twice.
 */
export const PUBLIC_MOVE_ATTRIBUTE = 'data-public-move';

/**
 * Turns the side panel markup into one edition's markup, in place: moves the
 * public edition's relocated controls into their slots, then removes every
 * element marked for the other edition. Runs at build time (wxt.config.ts)
 * and in the tests, so both see exactly what each edition ships.
 */
export function applyEditionToDocument(
  document: Document,
  edition: SimulEdition,
): void {
  for (const element of [
    ...document.querySelectorAll<HTMLElement>(`[${PUBLIC_MOVE_ATTRIBUTE}]`),
  ]) {
    const slotId = element.getAttribute(PUBLIC_MOVE_ATTRIBUTE) ?? '';
    element.removeAttribute(PUBLIC_MOVE_ATTRIBUTE);
    if (edition !== 'public') continue;
    const slot = document.getElementById(slotId);
    if (!slot) {
      throw new Error(`Missing public edition slot: ${slotId}`);
    }
    slot.replaceWith(element);
  }
  for (const element of [
    ...document.querySelectorAll<HTMLElement>(`[${EDITION_ATTRIBUTE}]`),
  ]) {
    if (element.getAttribute(EDITION_ATTRIBUTE) === edition) {
      element.removeAttribute(EDITION_ATTRIBUTE);
    } else {
      element.remove();
    }
  }
}

/** Whether a page's markup carries edition markers at all. */
export function hasEditionMarkers(html: string): boolean {
  return html.includes(EDITION_ATTRIBUTE) || html.includes(PUBLIC_MOVE_ATTRIBUTE);
}
