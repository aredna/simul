/**
 * Attributes Simul writes over the page's own on a mirrored element while a
 * translation shows there: `lang` beside translated text, the page's own
 * language beside that for CSS, and the translated name of an image (D124).
 * The page's own value is kept here and put back when the translation goes.
 * A page patch that rewrites the element's attributes changes what is put
 * back, not what shows.
 */

interface AttributeOverride {
  /** What the page has for this attribute; `null` when it has none. */
  page: string | null;
  value: string;
  /** The namespace Simul writes the attribute in, if any. */
  namespace: string | null;
}

const overrides = new WeakMap<Element, Map<string, AttributeOverride>>();

/**
 * Shows `value` for `name`, remembering the page's own value the first time.
 * `name` is the attribute's whole name; with `namespace` it is written in
 * that namespace, and still read and removed by its name.
 */
export function setReplicaAttributeOverride(
  element: Element,
  name: string,
  value: string,
  namespace: string | null = null,
): void {
  let own = overrides.get(element);
  if (!own) {
    own = new Map();
    overrides.set(element, own);
  }
  const existing = own.get(name);
  if (existing) {
    existing.value = value;
  } else {
    own.set(name, { page: element.getAttribute(name), value, namespace });
  }
  if (element.getAttribute(name) !== value) {
    writeAttribute(element, name, namespace, value);
  }
}

/** Puts back exactly what the page has for `name`: its value, or nothing. */
export function clearReplicaAttributeOverride(element: Element, name: string): void {
  const own = overrides.get(element);
  const existing = own?.get(name);
  if (!own || !existing) return;
  own.delete(name);
  if (own.size === 0) overrides.delete(element);
  if (existing.page === null) element.removeAttribute(name);
  else writeAttribute(element, name, existing.namespace, existing.page);
}

/** The page's own value of `name`, whatever Simul shows in its place. */
export function pageAttribute(element: Element, name: string): string | null {
  const existing = overrides.get(element)?.get(name);
  return existing ? existing.page : element.getAttribute(name);
}

/** The element's attributes as the page has them, without Simul's overrides. */
export function pageAttributes(
  element: Element,
): readonly (readonly [string, string])[] {
  const own = overrides.get(element);
  const attributes: (readonly [string, string])[] = [];
  for (const { name, value } of [...element.attributes]) {
    if (!own?.has(name)) attributes.push([name, value] as const);
  }
  for (const [name, existing] of own ?? []) {
    if (existing.page !== null) attributes.push([name, existing.page] as const);
  }
  return attributes;
}

/**
 * Called after the page's attributes were written onto `element` again (an
 * attribute patch, a rollback). What is there now is the page's, so it becomes
 * what will be put back, and each override shows again.
 */
export function reapplyReplicaAttributeOverrides(element: Element): void {
  const own = overrides.get(element);
  if (!own) return;
  for (const [name, existing] of own) {
    existing.page = element.getAttribute(name);
    writeAttribute(element, name, existing.namespace, existing.value);
  }
}

function writeAttribute(
  element: Element,
  name: string,
  namespace: string | null,
  value: string,
): void {
  if (namespace === null) element.setAttribute(name, value);
  else element.setAttributeNS(namespace, name, value);
}
