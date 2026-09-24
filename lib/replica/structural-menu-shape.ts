import { readSourceFlatTreeElementPath } from './source-privacy-policy';

/**
 * Where a menu without ARIA relations is recognized from its shape: inside
 * navigation or a page header, or as a list item (the common
 * `ul > li > trigger + panel` dropdown). The page side and the replica side
 * both apply this one rule, so a menu one side infers the other accepts.
 */
export function hasStructuralMenuContext(container: Element): boolean {
  if (readLocalName(container) === 'li') return true;
  const path = readSourceFlatTreeElementPath(container);
  return Boolean(path?.some((ancestor) => {
    const tagName = readLocalName(ancestor);
    const role = readRole(ancestor);
    return tagName === 'nav' || tagName === 'header' ||
      role === 'navigation' || role === 'banner';
  }));
}

const PLAIN_STRUCTURAL_MENU_TRIGGER_TAGS = new Set([
  'a', 'b', 'div', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
  'span', 'strong',
]);

const NESTED_CONTROL_SELECTOR = [
  'a[href]', 'area[href]', 'button', 'input', 'select', 'summary', 'textarea',
  '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
].join(',');

/**
 * A menu heading the page opens on hover with CSS or a script: plain text
 * such as a span, a heading or an anchor without an href, with no role and no
 * link or button inside (a wrapper around a real control is not the trigger;
 * the control is). Buttons, links with an href and control roles are
 * activation controls and are checked by each side's own activation rule.
 */
export function isPlainStructuralMenuTrigger(element: Element): boolean {
  if (
    !PLAIN_STRUCTURAL_MENU_TRIGGER_TAGS.has(readLocalName(element)) ||
    readRole(element) !== ''
  ) return false;
  try {
    return element.querySelector(NESTED_CONTROL_SELECTOR) === null;
  } catch {
    return false;
  }
}

const NON_PANEL_TAGS = new Set([
  'a', 'area', 'button', 'input', 'label', 'option', 'select', 'summary',
  'textarea',
]);

/**
 * A menu panel is a container of items, never a single link or control. A
 * hidden sibling link is usually the page's mobile-only copy of the heading.
 */
export function isStructuralMenuPanelElement(element: Element): boolean {
  return !NON_PANEL_TAGS.has(readLocalName(element));
}

function readLocalName(element: Element): string {
  try {
    return element.localName.toLowerCase();
  } catch {
    return '';
  }
}

function readRole(element: Element): string {
  try {
    return (element.getAttribute('role') ?? '').trim().toLowerCase();
  } catch {
    return 'unreadable';
  }
}
