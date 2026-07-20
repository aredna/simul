export const SOURCE_PRIVATE_TAGS = Object.freeze([
  'input',
  'option',
  'output',
  'select',
  'textarea',
] as const);

export const SOURCE_PRIVATE_ROLES = Object.freeze([
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

export const SOURCE_ACTIVATION_TAGS = Object.freeze([
  'button',
] as const);

export const SOURCE_ACTIVATION_ROLES = Object.freeze([
  'button',
] as const);

const PRIVATE_TAG_SET = new Set<string>(SOURCE_PRIVATE_TAGS);
const PRIVATE_ROLE_SET = new Set<string>(SOURCE_PRIVATE_ROLES);
const ACTIVATION_TAG_SET = new Set<string>(SOURCE_ACTIVATION_TAGS);
const ACTIVATION_ROLE_SET = new Set<string>(SOURCE_ACTIVATION_ROLES);

export function isSourcePrivateTagName(value: string): boolean {
  return PRIVATE_TAG_SET.has(value.trim().toLowerCase());
}

export function isSourcePrivateRoleValue(value: unknown): boolean {
  return sourceSensitiveRoleKind(value) === 'private';
}

export function isSourceActivationTagName(value: string): boolean {
  return ACTIVATION_TAG_SET.has(value.trim().toLowerCase());
}

export function isSourceActivationRoleValue(value: unknown): boolean {
  return sourceSensitiveRoleKind(value) === 'activation';
}

/**
 * ARIA permits fallback role tokens in preference order. Treat the first
 * recognized privacy-sensitive token as authoritative so activation and
 * private classifications cannot disagree for the same role value.
 */
function sourceSensitiveRoleKind(
  value: unknown,
): 'private' | 'activation' | undefined {
  if (typeof value !== 'string') return undefined;
  for (const role of value.trim().toLowerCase().split(/\s+/u)) {
    if (PRIVATE_ROLE_SET.has(role)) return 'private';
    if (ACTIVATION_ROLE_SET.has(role)) return 'activation';
  }
  return undefined;
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

/** Pixel capture keeps activation controls private even though their labels are public. */
export function hasSourcePrivateOrActivationElementAncestor(
  element: Element,
): boolean {
  for (let current: Element | undefined = element; current;) {
    if (
      isSourcePrivateTagName(current.tagName) ||
      isSourceActivationTagName(current.tagName) ||
      isSourcePrivateContentEditableValue(
        current.hasAttribute('contenteditable')
          ? current.getAttribute('contenteditable') ?? ''
          : undefined,
      ) ||
      isSourcePrivateRoleValue(current.getAttribute('role')) ||
      isSourceActivationRoleValue(current.getAttribute('role'))
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
