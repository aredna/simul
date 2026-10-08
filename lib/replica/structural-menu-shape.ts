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

/** How a menu recognized by its shape opens in the replica. */
export type StructuralMenuOpening = 'hover' | 'click';

/** A menu's container holds one collapsed panel and one or two triggers. */
export const MAX_STRUCTURAL_MENU_TRIGGERS = 2;

const LIST_PANEL_TAGS = new Set(['ol', 'ul']);

/**
 * Outside navigation, a header or a list only the plainest menu is taken for
 * one: a button followed or preceded by a list (a table row's "actions"
 * menu). A `div` beside a button is as often an accordion's body or a
 * dialog.
 */
export function isStructuralButtonMenu(trigger: Element, panel: Element): boolean {
  const triggerRole = readRole(trigger);
  const panelRole = readRole(panel);
  const button = readLocalName(trigger) === 'button'
    ? triggerRole === '' || triggerRole === 'button'
    : triggerRole === 'button';
  const list = LIST_PANEL_TAGS.has(readLocalName(panel))
    ? panelRole === '' || panelRole === 'list' || panelRole === 'menu'
    : panelRole === 'menu';
  return button && list;
}

/**
 * Where a menu of this shape may be, and how the replica opens it. Inside
 * navigation, a header or a list item it opens on hover, as such menus do on
 * the page, with one trigger or two (a link and the arrow button beside it).
 * Anywhere else a single button beside a list opens on a click only:
 * hovering a button that happens to sit beside a hidden list shows nothing.
 * The page side and the replica side both apply this one rule.
 */
export function structuralMenuOpening(
  container: Element,
  triggers: readonly Element[],
  panel: Element,
): StructuralMenuOpening | undefined {
  if (triggers.length < 1 || triggers.length > MAX_STRUCTURAL_MENU_TRIGGERS) {
    return undefined;
  }
  if (hasStructuralMenuContext(container)) return 'hover';
  return triggers.length === 1 && isStructuralButtonMenu(triggers[0]!, panel)
    ? 'click'
    : undefined;
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
