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
  return isStructuralMenuButton(trigger) && isStructuralMenuList(panel);
}

/**
 * The same shape before the panel is known: a button beside a list, or
 * beside wrappers around one (see `structuralMenuPanelCandidates`). The
 * button is asked first: most pairs of elements on a page hold none.
 */
export function mayBeStructuralButtonMenu(trigger: Element, held: Element): boolean {
  return isStructuralMenuButton(trigger) &&
    structuralMenuPanelCandidates(held).some(isStructuralMenuList);
}

function isStructuralMenuButton(trigger: Element): boolean {
  const role = readRole(trigger);
  return readLocalName(trigger) === 'button'
    ? role === '' || role === 'button'
    : role === 'button';
}

function isStructuralMenuList(panel: Element): boolean {
  const role = readRole(panel);
  return LIST_PANEL_TAGS.has(readLocalName(panel))
    ? role === '' || role === 'list' || role === 'menu'
    : role === 'menu';
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

/**
 * How many wrappers deep a menu's panel may sit under its container: one.
 * The shape this is for is a header's block of no height around a
 * positioned list. Deeper wrappers took cards, answers and tooltips hidden
 * inside nested blocks for menus as readily as they took menus.
 */
export const MAX_STRUCTURAL_MENU_PANEL_WRAPPERS = 1;

/**
 * What may be a menu's panel under one child of its container: the child,
 * and what it wraps. Headers often put the panel in a wrapper that holds
 * nothing else (a block of no height around a positioned list). A wrapper
 * holds one element and no text of its own, and is itself something a panel
 * could be: nothing is looked for inside a link or a control. The page side
 * looks inside a wrapper only when it takes no room (no box of its own, and
 * a panel placed out of the flow), and takes the outermost candidate it
 * finds collapsed; the replica side, which cannot tell a box, accepts a
 * panel that is one of them.
 */
export function structuralMenuPanelCandidates(child: Element): readonly Element[] {
  const candidates = [child];
  while (candidates.length <= MAX_STRUCTURAL_MENU_PANEL_WRAPPERS) {
    const wrapped = structuralMenuWrappedElement(
      candidates[candidates.length - 1]!,
    );
    if (!wrapped) break;
    candidates.push(wrapped);
  }
  return candidates;
}

function structuralMenuWrappedElement(wrapper: Element): Element | undefined {
  if (!isStructuralMenuPanelElement(wrapper)) return undefined;
  try {
    let wrapped: Element | undefined;
    for (const node of wrapper.childNodes) {
      if (node.nodeType === 1) {
        if (wrapped) return undefined;
        wrapped = node as Element;
      } else if (node.nodeType === 3 && (node.nodeValue ?? '').trim() !== '') {
        return undefined;
      }
    }
    return wrapped;
  } catch {
    return undefined;
  }
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
