export const SOURCE_PRIVATE_TAGS = Object.freeze([
  'button',
  'input',
  'option',
  'output',
  'select',
  'textarea',
] as const);

export const SOURCE_PRIVATE_ROLES = Object.freeze([
  'button',
  'checkbox',
  'combobox',
  'listbox',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
] as const);

const PRIVATE_TAG_SET = new Set<string>(SOURCE_PRIVATE_TAGS);
const PRIVATE_ROLE_SET = new Set<string>(SOURCE_PRIVATE_ROLES);

export function isSourcePrivateTagName(value: string): boolean {
  return PRIVATE_TAG_SET.has(value.trim().toLowerCase());
}

export function isSourcePrivateRoleValue(value: unknown): boolean {
  return typeof value === 'string' && value
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .some((role) => PRIVATE_ROLE_SET.has(role));
}

export function isSourcePrivateContentEditableValue(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  return !(
    typeof value === 'string' &&
    value.trim().toLowerCase() === 'false'
  );
}

export function sourceAttributesArePrivate(
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  for (const [rawName, rawValue] of Object.entries(attributes)) {
    const name = rawName.toLowerCase();
    if (
      (name === 'contenteditable' &&
        isSourcePrivateContentEditableValue(rawValue)) ||
      (name === 'role' && isSourcePrivateRoleValue(rawValue))
    ) return true;
  }
  return false;
}

export function hasSourcePrivateElementAncestor(element: Element): boolean {
  for (let current: Element | undefined = element; current;) {
    if (isSourcePrivateTagName(current.tagName)) return true;
    if (
      isSourcePrivateContentEditableValue(
        current.hasAttribute('contenteditable')
          ? current.getAttribute('contenteditable') ?? ''
          : undefined,
      ) ||
      isSourcePrivateRoleValue(current.getAttribute('role'))
    ) return true;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = root.nodeType === 11 && 'host' in root
      ? (root as ShadowRoot).host
      : undefined;
  }
  return false;
}
