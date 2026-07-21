export const SOURCE_PRIVATE_TAGS = Object.freeze([
  'input',
  'option',
  'output',
  'textarea',
] as const);

// Keep select state bounded by the same order of magnitude as the mirror graph.
// A lower cap would silently erase valid selection state before the graph budget
// has a chance to reject an oversized document.
export const MAX_SOURCE_SELECTED_OPTION_INDEXES = 50_000;
const MAX_SOURCE_SELECT_DESCENDANTS = 50_000;
const MAX_SOURCE_SELECT_LABEL_DESCENDANTS = 512;
const MAX_SOURCE_SELECT_LABEL_NODES = 1_024;
const MAX_SOURCE_SELECT_LABEL_TEXT = 3_500;

const SOURCE_NON_CONTENT_TAGS = new Set([
  'datalist', 'embed', 'form', 'frame', 'iframe', 'noscript', 'object',
  'output', 'portal', 'script', 'style', 'template', 'webview',
]);

export const SOURCE_TEXT_CONTROL_TYPES = Object.freeze([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
] as const);

export type SourceControlTextKind = 'value' | 'placeholder' | 'label';

export interface SourceControlText {
  readonly kind: SourceControlTextKind;
  readonly text: string;
}

export const SOURCE_PRIVATE_ROLES = Object.freeze([
  'checkbox',
  'combobox',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
] as const);

/**
 * Structural menu roles expose public labels rather than editable values.
 * Their editable descendants still start their own private regions, and an
 * editable combobox remains private through SOURCE_PRIVATE_ROLES.
 */
export const SOURCE_PUBLIC_MENU_ROLES = Object.freeze([
  'listbox',
  'menu',
  'option',
] as const);

export const SOURCE_ACTIVATION_TAGS = Object.freeze([
  'button',
] as const);

export const SOURCE_ACTIVATION_ROLES = Object.freeze([
  'button',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'treeitem',
] as const);

const PRIVATE_TAG_SET = new Set<string>(SOURCE_PRIVATE_TAGS);
const PRIVATE_ROLE_SET = new Set<string>(SOURCE_PRIVATE_ROLES);
const PUBLIC_MENU_ROLE_SET = new Set<string>(SOURCE_PUBLIC_MENU_ROLES);
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
    isSourcePublicMenuRoleValue(attributes.role) ||
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

/** Native option labels are public only inside a select and absent private roles. */
export function sourceElementStartsPrivateRegionInContext(
  tagName: string,
  attributes: Readonly<Record<string, unknown>>,
  nativeSelectRegion: boolean,
): boolean {
  const tag = tagName.trim().toLowerCase();
  if (tag === 'option' && nativeSelectRegion) {
    return sourceAttributesArePrivate(attributes);
  }
  return sourceElementStartsPrivateRegion(tag, attributes);
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
    const select = element as HTMLSelectElement;
    const options = select.options;
    if (!options || options.length > MAX_SOURCE_SELECT_DESCENDANTS) {
      return undefined;
    }
    const multiple = select.multiple === true || element.hasAttribute('multiple');
    if (!multiple && typeof select.selectedIndex === 'number') {
      const selectedIndex = select.selectedIndex;
      if (selectedIndex < 0) return Object.freeze([]);
      const option = options.item(selectedIndex);
      return option && sourceSelectOptionPathIsPublic(option, element)
        ? Object.freeze([selectedIndex])
        : Object.freeze([]);
    }
    const selected: number[] = [];
    const selectedOptions = select.selectedOptions;
    if (multiple && selectedOptions) {
      if (selectedOptions.length > MAX_SOURCE_SELECTED_OPTION_INDEXES) {
        return undefined;
      }
      for (let position = 0; position < selectedOptions.length; position += 1) {
        const option = selectedOptions.item(position);
        if (!option) return undefined;
        if (
          !sourceSelectOptionPathIsPublic(option, element)
        ) continue;
        const index = option.index;
        if (!Number.isSafeInteger(index) || index < 0 || index >= options.length) {
          return undefined;
        }
        selected.push(index);
      }
      return Object.freeze(selected);
    }
    // DOM test doubles and older implementations may omit selectedIndex or
    // selectedOptions. Keep that compatibility path bounded and allocation
    // free; real Chromium takes the constant/sparse branches above.
    for (let index = 0; index < options.length; index += 1) {
      const option = options.item(index);
      if (!option?.selected) continue;
      if (
        !sourceSelectOptionPathIsPublic(option, element)
      ) continue;
      selected.push(index);
      if (!multiple) break;
    }
    return Object.freeze(selected);
  } catch {
    return undefined;
  }
}

/** Chrome exposes :open for customizable selects; the boolean carries no content. */
export function readSourceSelectPickerOpen(element: Element): true | undefined {
  if (!isEligibleSourceSelect(
    element.localName,
    sourceElementAttributes(element),
  )) return undefined;
  try {
    return element.matches(':open') ? true : undefined;
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

/** Reads only the visible label of an option/optgroup in an eligible select. */
export function readSourceSelectLabel(
  element: Element,
): SourceControlText | undefined {
  const tagName = element.localName.toLowerCase();
  if (!isSourceSelectLabelElementPublic(element)) return undefined;
  if (isSourceSelectEntryVisuallyHidden(element)) return undefined;
  try {
    const rawAttributeLabel = element.getAttribute('label');
    const hasAuthoritativeAttributeLabel = rawAttributeLabel !== null &&
      rawAttributeLabel !== '';
    let label = hasAuthoritativeAttributeLabel
      ? rawAttributeLabel.slice(0, MAX_SOURCE_SELECT_LABEL_TEXT).trim()
      : '';
    if (tagName === 'optgroup') {
      const legend = directOptgroupLegend(element);
      if (legend) {
        if (!sourceSelectLabelSubtreeIsPublic(legend)) return undefined;
        label = readBoundedSourceSelectText(legend);
      }
    } else if (!hasAuthoritativeAttributeLabel) {
      label = readBoundedSourceSelectText(element);
    }
    return label ? Object.freeze({ kind: 'label', text: label }) : undefined;
  } catch {
    return undefined;
  }
}

export function isSourceSelectEntryVisuallyHidden(element: Element): boolean {
  const view = element.ownerDocument?.defaultView;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute('hidden')) return true;
    if (view && typeof view.getComputedStyle === 'function') {
      try {
        const style = view.getComputedStyle(current);
        const opacity = style.opacity.trim();
        if (
          style.display.trim().toLowerCase() === 'none' ||
          ['hidden', 'collapse'].includes(
            style.visibility.trim().toLowerCase(),
          ) ||
          (opacity !== '' && Number(opacity) === 0) ||
          style.getPropertyValue('content-visibility').trim().toLowerCase() ===
            'hidden'
        ) return true;
        if (
          current.localName.toLowerCase() === 'select' &&
          sourceSelectHasNoRenderedDocumentBox(current, view, style)
        ) return true;
      } catch {
        // A browser-inaccessible computed style is not proof of invisibility.
      }
    }
  }
  return false;
}

function sourceSelectHasNoRenderedDocumentBox(
  select: Element,
  view: Window,
  style: CSSStyleDeclaration,
): boolean {
  try {
    if (
      typeof select.getClientRects === 'function' &&
      select.getClientRects().length === 0
    ) return true;
    if (typeof select.getBoundingClientRect !== 'function') return false;
    const rect = select.getBoundingClientRect();
    if (
      ![rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height]
        .every(Number.isFinite)
    ) return false;
    if (rect.width <= 0 || rect.height <= 0) return true;
    const position = style.position.trim().toLowerCase();
    const fixed = position === 'fixed';
    const transformed = !['', 'none'].includes(
      style.transform.trim().toLowerCase(),
    );
    // A static element may be above a nested scrollport while remaining a
    // legitimate, user-reachable control. Geometry is only evidence of a
    // visually hidden backing select when positioning or transforms move it.
    if (!fixed && position !== 'absolute' && !transformed) return false;
    const documentRight = rect.right + (fixed ? 0 : finiteScrollOffset(view.scrollX));
    const documentBottom = rect.bottom + (fixed ? 0 : finiteScrollOffset(view.scrollY));
    return documentRight <= 0 || documentBottom <= 0;
  } catch {
    return false;
  }
}

function finiteScrollOffset(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function sourceSelectOptionPathIsPublic(
  option: Element,
  expectedSelect?: Element,
): boolean {
  const optionAttributes = sourceElementAttributes(option);
  if (
    option.localName.toLowerCase() !== 'option' ||
    sourceAttributesArePrivate(optionAttributes) ||
    isSourceActivationRoleValue(optionAttributes.role) ||
    isSourceSelectEntryVisuallyHidden(option)
  ) return false;
  let current = option.parentElement;
  while (current && current.localName.toLowerCase() !== 'select') {
    if (current.localName.toLowerCase() !== 'optgroup') return false;
    const attributes = sourceElementAttributes(current);
    if (
      isSourceSelectEntryVisuallyHidden(current) ||
      sourceElementStartsPrivateRegionInContext(
        current.localName,
        attributes,
        true,
      ) ||
      isSourceActivationRoleValue(attributes.role)
    ) return false;
    current = current.parentElement;
  }
  return current !== null &&
    (!expectedSelect || current === expectedSelect) &&
    !isSourceSelectEntryVisuallyHidden(current) &&
    isEligibleSourceSelect(current.localName, sourceElementAttributes(current)) &&
    sourceSelectLabelSubtreeIsPublic(option);
}

export function isSourceSelectLabelElementPublic(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  if (tagName !== 'option' && tagName !== 'optgroup') return false;
  const attributes = sourceElementAttributes(element);
  if (
    sourceAttributesArePrivate(attributes) ||
    isSourceActivationRoleValue(attributes.role) ||
    !isSourceElementInsideNativeSelect(element)
  ) return false;
  const parentTag = element.parentElement?.localName.toLowerCase();
  if (
    (tagName === 'optgroup' && parentTag !== 'select') ||
    (tagName === 'option' && parentTag !== 'select' && parentTag !== 'optgroup')
  ) return false;
  return tagName === 'optgroup' ||
    sourceSelectOptionPathIsPublic(element);
}

function directOptgroupLegend(element: Element): Element | undefined {
  let inspected = 0;
  for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
    inspected += 1;
    if (inspected > MAX_SOURCE_SELECT_LABEL_DESCENDANTS) return undefined;
    if (child.localName.toLowerCase() === 'legend') return child;
  }
  return undefined;
}

function sourceSelectLabelSubtreeIsPublic(element: Element): boolean {
  try {
    if (isSourceSelectEntryVisuallyHidden(element)) return false;
    const rootTag = element.localName.toLowerCase();
    const rootAttributes = sourceElementAttributes(element);
    if (
      SOURCE_NON_CONTENT_TAGS.has(rootTag) ||
      sourceElementStartsPrivateRegionInContext(rootTag, rootAttributes, true) ||
      isSourceActivationTagName(rootTag) ||
      isSourceActivationRoleValue(rootAttributes.role)
    ) return false;
    const pending: Element[] = [];
    for (let child = element.lastElementChild; child; child = child.previousElementSibling) {
      if (pending.length >= MAX_SOURCE_SELECT_LABEL_DESCENDANTS) return false;
      pending.push(child);
    }
    let inspected = 0;
    while (pending.length > 0) {
      const descendant = pending.pop()!;
      inspected += 1;
      if (inspected > MAX_SOURCE_SELECT_LABEL_DESCENDANTS) return false;
      if (isSourceSelectEntryVisuallyHidden(descendant)) continue;
      const descendantTag = descendant.localName.toLowerCase();
      const descendantAttributes = sourceElementAttributes(descendant);
      if (
        SOURCE_NON_CONTENT_TAGS.has(descendantTag) ||
        descendantTag === 'select' || descendantTag === 'option' ||
        descendantTag === 'optgroup' ||
        sourceElementStartsPrivateRegionInContext(
          descendantTag,
          descendantAttributes,
          true,
        ) ||
        isSourceActivationTagName(descendantTag) ||
        isSourceActivationRoleValue(descendantAttributes.role)
      ) return false;
      for (
        let child = descendant.lastElementChild;
        child;
        child = child.previousElementSibling
      ) {
        if (inspected + pending.length >= MAX_SOURCE_SELECT_LABEL_DESCENDANTS) {
          return false;
        }
        pending.push(child);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function readBoundedSourceSelectText(element: Element): string {
  let output = '';
  let inspected = 0;
  let current: Node | null = element.firstChild;
  while (current) {
    inspected += 1;
    if (inspected > MAX_SOURCE_SELECT_LABEL_NODES) break;
    if (
      current.nodeType === Node.ELEMENT_NODE &&
      isSourceSelectEntryVisuallyHidden(current as Element)
    ) {
      while (current && current !== element && !current.nextSibling) {
        current = current.parentNode;
      }
      if (!current || current === element) break;
      current = current.nextSibling;
      continue;
    }
    if (current.nodeType === Node.TEXT_NODE) {
      const value = current.nodeValue ?? '';
      const remaining = Math.max(
        0,
        MAX_SOURCE_SELECT_LABEL_TEXT + 1 - output.length,
      );
      output += value.slice(0, remaining);
      if (value.length > remaining || output.length > MAX_SOURCE_SELECT_LABEL_TEXT) {
        break;
      }
    }
    if (current.firstChild) {
      current = current.firstChild;
      continue;
    }
    while (current && current !== element && !current.nextSibling) {
      current = current.parentNode;
    }
    if (!current || current === element) break;
    current = current.nextSibling;
  }
  return output.slice(0, MAX_SOURCE_SELECT_LABEL_TEXT).trim();
}

export function isSourcePrivateRoleValue(value: unknown): boolean {
  return sourceSensitiveRoleKind(value) === 'private';
}

export function isSourcePublicMenuRoleValue(value: unknown): boolean {
  return sourceSensitiveRoleKind(value) === 'public-menu';
}

export function isSourceActivationTagName(value: string): boolean {
  return ACTIVATION_TAG_SET.has(value.trim().toLowerCase());
}

export function isSourceActivationRoleValue(value: unknown): boolean {
  return sourceSensitiveRoleKind(value) === 'activation';
}

/**
 * ARIA permits fallback role tokens in preference order. Treat the first
 * recognized sensitive/menu token as authoritative so every engine follows
 * ARIA's ordered fallback-role semantics.
 */
function sourceSensitiveRoleKind(
  value: unknown,
): 'private' | 'activation' | 'public-menu' | undefined {
  if (typeof value !== 'string') return undefined;
  for (const role of value.trim().toLowerCase().split(/\s+/u)) {
    if (PRIVATE_ROLE_SET.has(role)) return 'private';
    if (ACTIVATION_ROLE_SET.has(role)) return 'activation';
    if (PUBLIC_MENU_ROLE_SET.has(role)) return 'public-menu';
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
    if (sourceElementStartsPrivateRegionInContext(
      current.localName,
      sourceElementAttributes(current),
      isSourceOptionInsideNativeSelect(current),
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
      sourceElementStartsPrivateRegionInContext(
        current.localName,
        sourceElementAttributes(current),
        isSourceOptionInsideNativeSelect(current),
      ) ||
      isSourcePrivateTagName(current.localName) ||
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

function isSourceElementInsideNativeSelect(element: Element): boolean {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const tagName = current.localName.toLowerCase();
    if (tagName === 'select') {
      return isEligibleSourceSelect(tagName, sourceElementAttributes(current));
    }
    if (tagName === 'datalist') return false;
    const attributes = sourceElementAttributes(current);
    if (
      tagName !== 'optgroup' ||
      sourceAttributesArePrivate(attributes) ||
      isSourceActivationRoleValue(attributes.role)
    ) return false;
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

function passwordAutocomplete(value: string): boolean {
  return value.split(/\s+/u).some(
    (token) => token === 'current-password' || token === 'new-password',
  );
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
