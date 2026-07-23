import {
  sourceDocumentSecretClassifier,
  sourceFactsAreSecret,
  type StickySourceSecretClassifier,
} from './source-secret-classifier';

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
const MAX_SOURCE_FLAT_TREE_ANCESTORS = 1_024;
const MAX_SOURCE_NAVIGATION_URL_LENGTH = 16 * 1024;
const SOURCE_STATEFUL_NAVIGATION_ATTRIBUTES = Object.freeze([
  'aria-pressed',
] as const);

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
const SOURCE_IMAGE_CONTROL_TAG_SET = new Set([
  'button', 'input', 'label', 'meter', 'option', 'output', 'progress',
  'select', 'summary', 'textarea',
]);

export function isSourcePrivateTagName(value: string): boolean {
  return PRIVATE_TAG_SET.has(value.trim().toLowerCase());
}

/**
 * Returns the rendered flat-tree element path surrounding `node`. Elements
 * start their own path; directly slotted Text nodes start at their assigned
 * slot. Assigned slots take precedence over DOM parents, then open/closed
 * shadow ancestry continues through the host. An unreadable, malformed,
 * cyclic, or unreasonably deep path fails closed as `undefined`.
 */
export function readSourceFlatTreeElementPath(
  node: Node,
): readonly Element[] | undefined {
  try {
    const path: Element[] = [];
    const seen = new Set<Element>();
    let current = node.nodeType === 1
      ? node as Element
      : sourceFlatTreeParentElement(node);
    while (current) {
      if (
        seen.has(current) ||
        path.length >= MAX_SOURCE_FLAT_TREE_ANCESTORS
      ) return undefined;
      seen.add(current);
      path.push(current);
      current = sourceFlatTreeParentElement(current);
    }
    return Object.freeze(path);
  } catch {
    return undefined;
  }
}

function sourceFlatTreeParentElement(node: Node): Element | undefined {
  const assignedSlot = (node as Node & {
    readonly assignedSlot?: Element | null;
  }).assignedSlot;
  if (assignedSlot !== undefined && assignedSlot !== null) {
    if (
      assignedSlot.nodeType !== 1 ||
      assignedSlot.localName.toLowerCase() !== 'slot' ||
      assignedSlot.ownerDocument !== node.ownerDocument
    ) throw new Error('Invalid assigned-slot ancestry.');
    return assignedSlot;
  }
  const parent = node.parentElement;
  if (parent) return parent;
  const root = node.getRootNode();
  if (root.nodeType !== 11 || !('host' in root)) return undefined;
  const host = (root as ShadowRoot).host;
  if (host.nodeType !== 1 || host.ownerDocument !== node.ownerDocument) {
    throw new Error('Invalid shadow-host ancestry.');
  }
  return host;
}

/** Native control text is readable only for the narrow release-approved set. */
export function isEligibleSourceTextControl(
  tagName: string,
  attributes: Readonly<Record<string, unknown>>,
): boolean {
  const tag = tagName.trim().toLowerCase();
  if (sourceFactsAreSecret({
    tagName: tag,
    type: stringAttribute(attributes.type),
    autocomplete: stringAttribute(attributes.autocomplete),
    role: stringAttribute(attributes.role),
    contentEditable: stringAttribute(attributes.contenteditable),
  })) return false;
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
  const attributes = readSourceStructuralAttributes(element);
  if (
    !isEligibleSourceTextControl(tagName, attributes) ||
    hasSourceCredentialSecretAncestor(element)
  ) return undefined;
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
    readSourceStructuralAttributes(element),
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
    readSourceStructuralAttributes(element),
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
        const text = readBoundedSourceSelectText(legend);
        if (text === undefined) return undefined;
        label = text;
      }
    } else if (!hasAuthoritativeAttributeLabel) {
      const text = readBoundedSourceSelectText(element);
      if (text === undefined) return undefined;
      label = text;
    }
    return label ? Object.freeze({ kind: 'label', text: label }) : undefined;
  } catch {
    return undefined;
  }
}

export function isSourceSelectEntryVisuallyHidden(element: Element): boolean {
  const view = element.ownerDocument?.defaultView;
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
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
  const optionAttributes = readSourceStructuralAttributes(option);
  if (
    option.localName.toLowerCase() !== 'option' ||
    sourceAttributesArePrivate(optionAttributes) ||
    isSourceActivationRoleValue(optionAttributes.role) ||
    isSourceSelectEntryVisuallyHidden(option)
  ) return false;
  let current = option.parentElement;
  while (current && current.localName.toLowerCase() !== 'select') {
    if (current.localName.toLowerCase() !== 'optgroup') return false;
    const attributes = readSourceStructuralAttributes(current);
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
    isEligibleSourceSelect(
      current.localName,
      readSourceStructuralAttributes(current),
    ) &&
    sourceSelectLabelSubtreeIsPublic(option);
}

export function isSourceSelectLabelElementPublic(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  if (tagName !== 'option' && tagName !== 'optgroup') return false;
  const attributes = readSourceStructuralAttributes(element);
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
    if (
      isSourceSelectEntryVisuallyHidden(element) ||
      hasSourceCredentialSecretAncestor(element)
    ) return false;
    const rootTag = element.localName.toLowerCase();
    const rootAttributes = readSourceStructuralAttributes(element);
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
      const descendantAttributes = readSourceStructuralAttributes(descendant);
      if (
        hasSourceCredentialSecretAncestor(descendant) ||
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

function readBoundedSourceSelectText(element: Element): string | undefined {
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
      // A directly slotted Text node can render under a credential boundary
      // that is absent from its DOM-parent chain. Classify its flat-tree
      // ancestry before evaluating nodeValue.
      if (hasSourceCredentialSecretAncestor(current)) return undefined;
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
  if (hasSourceCredentialSecretAncestor(element)) return true;
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
    if (sourceElementStartsPrivateRegionInContext(
      current.localName,
      readSourceStructuralAttributes(current),
      isSourceOptionInsideNativeSelect(current),
    )) return true;
  }
  return false;
}

/**
 * Hard credential floor shared by semantic and image admission.  It examines
 * only structural metadata/computed masking, never value, label or alt text.
 */
export function hasSourceCredentialSecretAncestor(
  node: Node,
  classifier: StickySourceSecretClassifier = sourceDocumentSecretClassifier(
    node.ownerDocument ?? node,
  ),
  sourceWindow: Window | null | undefined = node.ownerDocument?.defaultView,
): boolean {
  if (classifier.isSecret(node)) return true;
  const path = readSourceFlatTreeElementPath(node);
  if (!path) {
    classifier.classify(node, {
      tagName: node.nodeType === 3 ? '#text' : '#node',
      secretAncestor: true,
    });
    return true;
  }
  let secretAncestor = false;
  for (const current of [...path].reverse()) {
    let computedTextSecurity = '';
    const view = sourceWindow;
    let getComputedStyle:
      ((element: Element) => CSSStyleDeclaration) | undefined;
    let computedStyleUnreadable = false;
    let computedStyleApiPresent = false;
    try {
      computedStyleApiPresent = Boolean(view && 'getComputedStyle' in view);
      if (computedStyleApiPresent) getComputedStyle = view?.getComputedStyle;
    } catch {
      computedStyleUnreadable = true;
    }
    if (computedStyleApiPresent && typeof getComputedStyle !== 'function') {
      computedStyleUnreadable = true;
    }
    if (typeof getComputedStyle === 'function') {
      try {
        const style = getComputedStyle.call(view, current);
        if (typeof style?.getPropertyValue !== 'function') {
          computedStyleUnreadable = true;
        } else {
          computedTextSecurity = style.getPropertyValue('-webkit-text-security');
        }
      } catch {
        computedStyleUnreadable = true;
      }
    }
    // A present-but-unreadable computed security boundary is secret. This
    // sentinel is deliberately nonempty so the shared classifier withholds
    // descendants, image evidence, and value-bearing access.
    if (computedStyleUnreadable) computedTextSecurity = 'simul-unreadable';
    const attributes = readSourceStructuralAttributes(current);
    const category = classifier.classify(current, {
      tagName: current.localName,
      type: attributes.type,
      autocomplete: attributes.autocomplete,
      role: attributes.role,
      contentEditable: attributes.contenteditable,
      computedTextSecurity,
      secretAncestor,
    });
    if (category === 'secret') secretAncestor = true;
  }
  // Elements are classified while walking `path`. A directly slotted Text
  // node is not an element path member, so persist the same document-lifetime
  // decision on its own identity before any caller may read its content.
  if (secretAncestor && node.nodeType !== 1) {
    classifier.classify(node, {
      tagName: node.nodeType === 3 ? '#text' : '#node',
      secretAncestor: true,
    });
  }
  return secretAncestor;
}

/** Pixel capture keeps activation controls private even though their labels are public. */
export function hasSourcePrivateOrActivationElementAncestor(
  element: Element,
): boolean {
  if (hasSourceCredentialSecretAncestor(element)) return true;
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
    if (
      sourceElementStartsPrivateRegionInContext(
        current.localName,
        readSourceStructuralAttributes(current),
        isSourceOptionInsideNativeSelect(current),
      ) ||
      isSourcePrivateTagName(current.localName) ||
      isSourceActivationTagName(current.tagName) ||
      isSourceActivationRoleValue(current.getAttribute('role'))
    ) return true;
  }
  return false;
}

/**
 * Images inside any native/ARIA control or editable region are one selectable
 * read capability. This is intentionally broader than activation-only checks:
 * non-secret textbox, select, status and contenteditable ancestry must obey the
 * same control-images switch for both semantic labels and painted pixels.
 */
export function hasSourceControlOrEditableElementAncestor(
  element: Element,
): boolean {
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
    const tagName = current.localName.toLowerCase();
    const attributes = readSourceStructuralAttributes(current);
    const nativeNavigation = (tagName === 'a' || tagName === 'area') &&
      safelyHasSourceAttribute(current, 'href');
    const mediaControl = (tagName === 'audio' || tagName === 'video') &&
      safelyHasSourceAttribute(current, 'controls');
    if (
      SOURCE_IMAGE_CONTROL_TAG_SET.has(tagName) ||
      nativeNavigation ||
      mediaControl ||
      sourceAttributesArePrivate(attributes) ||
      isSourcePublicMenuRoleValue(attributes.role) ||
      isSourceActivationRoleValue(attributes.role)
    ) return true;
  }
  return false;
}

/**
 * OCR may read a public navigation image even when a site's accessibility
 * script gives its native HTTP(S) anchor button semantics. The exception is
 * deliberately local to that anchor: every private, native-control, or outer
 * activation ancestor still blocks pixel capture.
 */
export function hasSourceImageCaptureBlockingAncestor(
  element: Element,
  options: { readonly allowActivationControls?: boolean } = {},
): boolean {
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
    const attributes = readSourceStructuralAttributes(current);
    const role = attributes.role;
    if (
      sourceElementStartsPrivateRegionInContext(
        current.localName,
        attributes,
        isSourceOptionInsideNativeSelect(current),
      ) ||
      isSourcePrivateTagName(current.localName) ||
      (
        !options.allowActivationControls &&
        isSourceActivationTagName(current.tagName)
      ) ||
      (
        !options.allowActivationControls &&
        isSourceActivationRoleValue(role) &&
        !(
          isSourcePublicNavigationButtonRoleValue(role) &&
          isSourceHttpNavigationAnchor(current)
        )
      )
    ) return true;
  }
  return false;
}

/** Waive only the normalized, single-token role used by a plain button link. */
function isSourcePublicNavigationButtonRoleValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'button';
}

function isSourceHttpNavigationAnchor(element: Element): boolean {
  try {
    if (
      element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      element.localName.toLowerCase() !== 'a'
    ) return false;
    if (
      SOURCE_STATEFUL_NAVIGATION_ATTRIBUTES.some((attribute) =>
        element.hasAttribute(attribute)
      )
    ) return false;
    const rawHref = element.getAttribute('href')?.trim();
    if (
      !rawHref ||
      rawHref.length > MAX_SOURCE_NAVIGATION_URL_LENGTH ||
      rawHref.startsWith('#')
    ) return false;
    const rawBase = element.baseURI;
    if (rawBase && rawBase.length > MAX_SOURCE_NAVIGATION_URL_LENGTH) return false;
    const base = rawBase ? new URL(rawBase) : undefined;
    const target = base ? new URL(rawHref, base) : new URL(rawHref);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
    if (!base || !rawHref.includes('#')) return true;
    const baseWithoutFragment = new URL(base);
    const targetWithoutFragment = new URL(target);
    baseWithoutFragment.hash = '';
    targetWithoutFragment.hash = '';
    return baseWithoutFragment.href !== targetWithoutFragment.href;
  } catch {
    return false;
  }
}

function isSourceElementInsideNativeSelect(element: Element): boolean {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const tagName = current.localName.toLowerCase();
    if (tagName === 'select') {
      return isEligibleSourceSelect(
        tagName,
        readSourceStructuralAttributes(current),
      );
    }
    if (tagName === 'datalist') return false;
    const attributes = readSourceStructuralAttributes(current);
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
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
    if (
      isSourceActivationTagName(current.tagName) ||
      isSourceActivationRoleValue(current.getAttribute('role'))
    ) return true;
  }
  return false;
}

/**
 * Reads only the four structural fields needed to classify an element. In
 * particular, this must never enumerate the source attribute collection:
 * authors can place raw form values in attributes and classification has to
 * happen before any content-bearing field is touched.
 */
export function readSourceStructuralAttributes(
  element: Element,
): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    for (const name of [
      'type',
      'autocomplete',
      'role',
      'contenteditable',
    ] as const) {
      const value = element.getAttribute(name);
      if (value !== null) result[name] = value;
    }
    return result;
  } catch {
    // Unreadable structural metadata is credential-secret, not public.
    return { autocomplete: 'current-password' };
  }
}

function safelyHasSourceAttribute(element: Element, name: string): boolean {
  try {
    return element.hasAttribute(name);
  } catch {
    return false;
  }
}

function stringAttribute(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
