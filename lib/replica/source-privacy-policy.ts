export const SOURCE_PRIVATE_TAGS = Object.freeze([
  'input',
  'option',
  'output',
  'textarea',
] as const);

export const MAX_SOURCE_SELECTED_OPTION_INDEXES = 512;

export const SOURCE_TEXT_CONTROL_TYPES = Object.freeze([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
] as const);

export type SourceControlTextKind = 'value' | 'placeholder';

export interface SourceControlText {
  readonly kind: SourceControlTextKind;
  readonly text: string;
}

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

/** Native control text is readable only for the narrow release-approved set. */
export function isEligibleSourceTextControl(
  tagName: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  const tag = tagName.trim().toLowerCase();
  const autocomplete = stringAttribute(attributes.autocomplete).toLowerCase();
  if (passwordAutocomplete(autocomplete)) return false;
  // A native input with an ARIA widget/editor role is no longer part of the
  // narrowly approved native-control surface. Fail closed here so capture,
  // mutation fingerprinting, and receiver validation all make the same
  // decision even when the role is placed on the control itself.
  if (
    sourceAttributesArePrivate(attributes) ||
    isSourceActivationRoleValue(attributes.role)
  ) return false;
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const type = stringAttribute(attributes.type).trim().toLowerCase();
  return (SOURCE_TEXT_CONTROL_TYPES as readonly string[]).includes(type);
}

/** Attribute-only classification shared by capture and receiver validation. */
export function sourceElementStartsPrivateRegion(
  tagName: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  const tag = tagName.trim().toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    return !isEligibleSourceTextControl(tag, attributes);
  }
  return isSourcePrivateTagName(tag) || sourceAttributesArePrivate(attributes);
}

/** Reads only current, user-visible native text-control state and fails closed. */
export function readSourceControlText(
  element: Element,
): SourceControlText | undefined {
  const tagName = element.localName.toLowerCase();
  const attributes = sourceElementAttributes(element);
  if (!isEligibleSourceTextControl(tagName, attributes)) return undefined;
  try {
    const control = element as Element & {
      readonly value?: unknown;
      readonly placeholder?: unknown;
    };
    if (typeof control.value !== 'string' ||
      typeof control.placeholder !== 'string') return undefined;
    if (control.value.length > 0) {
      return Object.freeze({ kind: 'value', text: control.value });
    }
    if (control.placeholder.length > 0) {
      return Object.freeze({ kind: 'placeholder', text: control.placeholder });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function isSourceNativeTextControlTagName(value: string): boolean {
  const tag = value.trim().toLowerCase();
  return tag === 'input' || tag === 'textarea';
}

export function isSourceNativeSelectTagName(value: string): boolean {
  return value.trim().toLowerCase() === 'select';
}

/** A native select is readable only when it has no explicit private/editor role. */
export function isEligibleSourceSelect(
  tagName: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  return isSourceNativeSelectTagName(tagName) &&
    !sourceAttributesArePrivate(attributes) &&
    !isSourceActivationRoleValue(attributes.role);
}

/** Reads indices only; raw option values and names never enter the protocol. */
export function readSourceSelectedOptionIndexes(
  element: Element,
): readonly number[] | undefined {
  if (!isEligibleSourceSelect(
    element.localName,
    sourceElementAttributes(element),
  )) return undefined;
  try {
    const options = [...element.querySelectorAll('option')];
    const selected: number[] = [];
    for (let index = 0; index < options.length; index += 1) {
      if (!(options[index] as Element & { readonly selected?: unknown }).selected) {
        continue;
      }
      if (selected.length >= MAX_SOURCE_SELECTED_OPTION_INDEXES) return undefined;
      selected.push(index);
    }
    return Object.freeze(selected);
  } catch {
    return undefined;
  }
}

/** Standalone/datalist options stay private; only select descendants are public. */
export function isSourceOptionInsideNativeSelect(element: Element): boolean {
  if (element.localName.toLowerCase() !== 'option') return false;
  for (let current = element.parentElement; current; current = current.parentElement) {
    const tagName = current.localName.toLowerCase();
    if (tagName === 'select') return true;
    if (tagName === 'datalist') return false;
  }
  return false;
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
    if (!isSourceOptionInsideNativeSelect(current) && sourceElementStartsPrivateRegion(
      current.localName,
      sourceElementAttributes(current),
    )) return true;
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
      (!isSourceOptionInsideNativeSelect(current) && sourceElementStartsPrivateRegion(
        current.localName,
        sourceElementAttributes(current),
      )) ||
      isSourceActivationTagName(current.tagName) ||
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

/** Public activation labels remain mirrorable even though control pixels do not. */
export function hasSourceActivationElementAncestor(element: Element): boolean {
  for (let current: Element | undefined = element; current;) {
    if (
      isSourceActivationTagName(current.tagName) ||
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

function sourceElementAttributes(element: Element): Record<string, string> {
  const result: Record<string, string> = {};
  try {
    for (const attribute of element.attributes) {
      result[attribute.name.toLowerCase()] = attribute.value;
    }
  } catch {
    // Missing attributes leave native controls outside the approved set.
    result.autocomplete = 'current-password';
  }
  return result;
}

/**
 * Autocomplete tokens whose values are secrets even inside a text-typed
 * control: passwords, one-time codes, and every payment-card field.
 */
function passwordAutocomplete(value: string): boolean {
  return value.split(/\s+/u).some(
    (token) =>
      token === 'current-password' ||
      token === 'new-password' ||
      token === 'one-time-code' ||
      token.startsWith('cc-'),
  );
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
