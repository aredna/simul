import {
  hasSourceActivationElementAncestor,
  hasSourcePrivateElementAncestor,
  hasSourcePrivateOrActivationElementAncestor,
  isSourceActivationRoleValue,
  isSourceActivationTagName,
  isSourcePrivateContentEditableValue,
  isSourcePrivateRoleValue,
  isSourcePrivateTagName,
} from './source-privacy-policy';

export const MAX_HTML_MIRROR_BYTES = 8 * 1024 * 1024;
export const MAX_HTML_MIRROR_NODES = 50_000;
export const MAX_HTML_MIRROR_DEPTH = 64;
export const MAX_HTML_MIRROR_STRING = 512 * 1024;
export const MAX_HTML_MIRROR_ATTRIBUTES = 512;
export const MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS = 4_096;
export const MAX_HTML_MIRROR_ADOPTED_STYLE_RULES = 100_000;
const MAX_ADOPTED_STYLE_SHEETS_PER_OWNER = 256;
const MAX_ADOPTED_STYLE_RULES_PER_OWNER = 20_000;
const MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER = MAX_HTML_MIRROR_STRING;
const MAX_BROKEN_CONTROL_ICON_EDGE = 64;

export type HtmlMirrorNamespace = 'html' | 'svg' | 'mathml';

export interface HtmlMirrorElementNode {
  readonly kind: 'element';
  readonly id: number;
  readonly namespace: HtmlMirrorNamespace;
  readonly tagName: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly children: readonly HtmlMirrorNode[];
  readonly visuallyHidden?: true;
  readonly selectedImageSource?: string;
  readonly shadowRoot?: HtmlMirrorShadowRoot;
}

export interface HtmlMirrorElementHints {
  readonly visuallyHidden?: true;
  readonly selectedImageSource?: string;
}

export interface HtmlMirrorShadowRoot {
  readonly id: number;
  readonly mode: 'open';
  readonly children: readonly HtmlMirrorNode[];
  readonly adoptedStyleSheets: readonly string[];
}

export interface HtmlMirrorTextNode {
  readonly kind: 'text';
  readonly id: number;
  readonly text: string;
  readonly translatable: boolean;
}

export type HtmlMirrorNode = HtmlMirrorElementNode | HtmlMirrorTextNode;

export interface HtmlMirrorDocumentGraph {
  readonly root: HtmlMirrorElementNode;
  readonly adoptedStyleSheets: readonly string[];
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export interface HtmlMirrorIdRegistry {
  getId(node: Node): number;
}

export interface HtmlMirrorReadBudget {
  nodes: number;
  bytes: number;
  styleSheets: number;
  styleRules: number;
  readonly ids: Set<number>;
}

interface AdoptedStyleSheetRead {
  readonly cssText: string;
  readonly ruleCount: number;
}

export interface HtmlMirrorStyleWorkBudget {
  readonly maxSheets: number;
  readonly maxRules: number;
  readonly maxCharacters: number;
  readonly cache: Map<object, AdoptedStyleSheetRead | null>;
  sheets: number;
  rules: number;
  characters: number;
  exhausted: boolean;
}

interface SerializeContext {
  readonly registry: HtmlMirrorIdRegistry;
  readonly baseUrl: string;
  readonly budget: HtmlMirrorReadBudget;
  readonly styleWork: HtmlMirrorStyleWorkBudget;
  readonly privateRegion: boolean;
  readonly privateAttributeRegion: boolean;
  readonly activationRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
  readonly depth: number;
}

const UNSAFE_ELEMENTS = new Set([
  'animate',
  'animatecolor',
  'animatemotion',
  'animatetransform',
  'applet',
  'base',
  'discard',
  'embed',
  'fencedframe',
  'frame',
  'frameset',
  'iframe',
  'mpath',
  'noscript',
  'object',
  'portal',
  'script',
  'set',
  'template',
  'video',
  'audio',
  'webview',
]);

const NON_CONTENT_ELEMENTS = new Set([
  'head',
  'style',
  'title',
]);

const ACTIVE_OR_NAVIGATIONAL_ATTRIBUTES = new Set([
  'action',
  'archive',
  'autofocus',
  'cite',
  'classid',
  'code',
  'codebase',
  'data',
  'download',
  'dynsrc',
  'formaction',
  'formmethod',
  'formenctype',
  'formtarget',
  'manifest',
  'ping',
  'poster',
  'profile',
  'srcdoc',
  'target',
  'usemap',
  'xlink:href',
]);

const PRIVATE_ATTRIBUTES = new Set([
  'aria-label',
  'aria-valuenow',
  'aria-valuetext',
  'autocomplete',
  'checked',
  'name',
  'placeholder',
  'selected',
  'title',
  'value',
]);

const PASSIVE_IMAGE_ELEMENTS = new Set(['img', 'image']);

export function createHtmlMirrorStyleWorkBudget(
  limits: Partial<Pick<
    HtmlMirrorStyleWorkBudget,
    'maxSheets' | 'maxRules' | 'maxCharacters'
  >> = {},
): HtmlMirrorStyleWorkBudget {
  return {
    maxSheets: boundedWorkLimit(
      limits.maxSheets,
      MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS,
    ),
    maxRules: boundedWorkLimit(
      limits.maxRules,
      MAX_HTML_MIRROR_ADOPTED_STYLE_RULES,
    ),
    maxCharacters: boundedWorkLimit(
      limits.maxCharacters,
      Math.floor(MAX_HTML_MIRROR_BYTES / 2),
    ),
    cache: new Map(),
    sheets: 0,
    rules: 0,
    characters: 0,
    exhausted: false,
  };
}

/** Reads only locally accessible CSSOM and returns ordered, sanitized text. */
export function sanitizeSourceAdoptedStyleSheets(
  owner: Document | ShadowRoot,
  baseUrl: string,
  work: HtmlMirrorStyleWorkBudget,
): readonly string[] | undefined {
  let sheets: ArrayLike<CSSStyleSheet>;
  try {
    sheets = owner.adoptedStyleSheets;
  } catch {
    return Object.freeze([]);
  }
  let length: number;
  try {
    length = sheets.length;
  } catch {
    return Object.freeze([]);
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_ADOPTED_STYLE_SHEETS_PER_OWNER ||
    work.sheets + length > work.maxSheets
  ) {
    work.exhausted = true;
    return undefined;
  }
  const result: string[] = [];
  const startingRules = work.rules;
  const startingCharacters = work.characters;
  for (let index = 0; index < length; index += 1) {
    work.sheets += 1;
    let sheet: unknown;
    try {
      sheet = sheets[index];
    } catch {
      continue;
    }
    if ((typeof sheet !== 'object' && typeof sheet !== 'function') || !sheet) {
      continue;
    }
    let cached = work.cache.get(sheet);
    if (cached === undefined && !work.cache.has(sheet)) {
      cached = readAdoptedStyleSheet(
        sheet as CSSStyleSheet,
        baseUrl,
        work,
      );
      if (work.exhausted) return undefined;
      work.cache.set(sheet, cached ?? null);
    }
    if (!cached) continue;
    if (
      work.rules + cached.ruleCount > work.maxRules ||
      work.characters + cached.cssText.length > work.maxCharacters ||
      work.rules - startingRules + cached.ruleCount >
        MAX_ADOPTED_STYLE_RULES_PER_OWNER ||
      work.characters - startingCharacters + cached.cssText.length >
        MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER
    ) {
      work.exhausted = true;
      return undefined;
    }
    work.rules += cached.ruleCount;
    work.characters += cached.cssText.length;
    result.push(cached.cssText);
  }
  return Object.freeze(result);
}

/**
 * Synchronously snapshots directly into Simul's typed value graph. Avoiding
 * cloneNode is deliberate: Chrome may run a custom element constructor while
 * cloning. The graph is detached data before it crosses the runtime boundary.
 */
export function sanitizeSourceSubtree(
  source: Node,
  registry: HtmlMirrorIdRegistry,
  baseUrl = source.ownerDocument?.baseURI ?? 'about:blank',
): HtmlMirrorNode | undefined {
  try {
    const budget = createHtmlMirrorReadBudget();
    const styleWork = createHtmlMirrorStyleWorkBudget();
    const sourceElement = nearestElement(source);
    const inheritedElement = source.nodeType === Node.ELEMENT_NODE && sourceElement
      ? composedParentElement(sourceElement)
      : sourceElement;
    return serializeNode(source, {
      registry,
      baseUrl,
      budget,
      styleWork,
      privateRegion: inheritedElement
        ? hasSourcePrivateElementAncestor(inheritedElement)
        : false,
      privateAttributeRegion: inheritedElement
        ? hasSourcePrivateOrActivationElementAncestor(inheritedElement)
        : false,
      activationRegion: inheritedElement
        ? hasSourceActivationElementAncestor(inheritedElement)
        : false,
      nonContentRegion: inheritedElement
        ? hasNonContentAncestor(inheritedElement)
        : false,
      styleRegion: Boolean(sourceElement?.closest('style')),
      depth: 0,
    });
  } catch {
    return undefined;
  }
}

export function sanitizeSourceChildren(
  source: Node,
  registry: HtmlMirrorIdRegistry,
  baseUrl = source.ownerDocument?.baseURI ?? 'about:blank',
): readonly HtmlMirrorNode[] | undefined {
  try {
    const budget = createHtmlMirrorReadBudget();
    const styleWork = createHtmlMirrorStyleWorkBudget();
    const result: HtmlMirrorNode[] = [];
    const parentElement = nearestElement(source);
    const privateRegion = parentElement
      ? hasSourcePrivateElementAncestor(parentElement)
      : false;
    const privateAttributeRegion = parentElement
      ? hasSourcePrivateOrActivationElementAncestor(parentElement)
      : false;
    const activationRegion = parentElement
      ? hasSourceActivationElementAncestor(parentElement)
      : false;
    const nonContentRegion = parentElement
      ? hasNonContentAncestor(parentElement)
      : false;
    const styleRegion = Boolean(parentElement?.closest('style'));
    for (const child of source.childNodes) {
      const serialized = serializeNode(child, {
        registry,
        baseUrl,
        budget,
        styleWork,
        privateRegion,
        privateAttributeRegion,
        activationRegion,
        nonContentRegion,
        styleRegion,
        depth: 0,
      });
      if (serialized) result.push(serialized);
    }
    return Object.freeze(result);
  } catch {
    return undefined;
  }
}

export function sanitizeSourceAttributes(
  source: Element,
  baseUrl = source.ownerDocument?.baseURI ?? 'about:blank',
): readonly (readonly [string, string])[] | undefined {
  try {
    return sanitizeAttributes(
      source,
      source.localName.toLowerCase(),
      hasSourcePrivateElementAncestor(source),
      hasSourceActivationElementAncestor(source),
      baseUrl,
    );
  } catch {
    return undefined;
  }
}

/** Captures only bounded presentation facts that cannot reveal page content. */
export function sanitizeSourceElementHints(
  source: Element,
  baseUrl = source.ownerDocument?.baseURI ?? 'about:blank',
): HtmlMirrorElementHints {
  const tagName = source.localName.toLowerCase();
  const visuallyHidden = isCanonicalClippedSourceElement(source);
  const selectedImageSource = tagName === 'img'
    ? selectedSourceFor(source, baseUrl)
    : undefined;
  return Object.freeze({
    ...(visuallyHidden ? { visuallyHidden: true as const } : {}),
    ...(selectedImageSource ? { selectedImageSource } : {}),
  });
}

export function sanitizeSourceDocument(
  sourceDocument: Document,
  sourceWindow: Window,
  registry: HtmlMirrorIdRegistry,
): HtmlMirrorDocumentGraph | undefined {
  const documentElement = sourceDocument.documentElement;
  if (!documentElement) return undefined;
  const budget = createHtmlMirrorReadBudget();
  const styleWork = createHtmlMirrorStyleWorkBudget();
  const root = serializeNode(documentElement, {
    registry,
    baseUrl: sourceDocument.baseURI,
    budget,
    styleWork,
    privateRegion: false,
    privateAttributeRegion: false,
    activationRegion: false,
    nonContentRegion: false,
    styleRegion: false,
    depth: 0,
  });
  if (!root || root.kind !== 'element' || root.tagName !== 'html') return undefined;
  const adoptedStyleSheets = captureAdoptedStyleSheets(
    sourceDocument,
    sourceDocument.baseURI,
    budget,
    styleWork,
  );
  if (!adoptedStyleSheets) return undefined;
  return Object.freeze({
    root,
    adoptedStyleSheets,
    viewportWidth: boundedDimension(sourceWindow.innerWidth),
    viewportHeight: boundedDimension(sourceWindow.innerHeight),
    documentWidth: boundedDimension(Math.max(
      documentElement.scrollWidth,
      sourceDocument.body?.scrollWidth ?? 0,
    )),
    documentHeight: boundedDimension(Math.max(
      documentElement.scrollHeight,
      sourceDocument.body?.scrollHeight ?? 0,
    )),
  });
}

/** Revalidates a transported graph and returns an immutable safe copy. */
export function readHtmlMirrorNode(
  input: unknown,
  sharedIds: Set<number> = new Set(),
  depth = 0,
  budget: HtmlMirrorReadBudget = createHtmlMirrorReadBudget(sharedIds),
  privateRegion = false,
  nonContentRegion = false,
  styleRegion = false,
  privateAttributeRegion = false,
  activationRegion = false,
): HtmlMirrorNode | undefined {
  if (!isRecord(input) || depth > MAX_HTML_MIRROR_DEPTH) return undefined;
  budget.nodes += 1;
  if (budget.nodes > MAX_HTML_MIRROR_NODES) return undefined;
  if (!isNodeId(input.id) || budget.ids.has(input.id)) return undefined;
  budget.ids.add(input.id);
  if (input.kind === 'text') {
    if (
      !hasExactKeys(input, ['kind', 'id', 'text', 'translatable']) ||
      typeof input.text !== 'string' ||
      input.text.length > MAX_HTML_MIRROR_STRING ||
      typeof input.translatable !== 'boolean' ||
      (privateRegion && input.text !== '') ||
      ((privateRegion || nonContentRegion) && input.translatable) ||
      (styleRegion && sanitizeCss(input.text, 'about:blank') !== input.text)
    ) return undefined;
    budget.bytes += input.text.length * 2 + 32;
    if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
    return Object.freeze({
      kind: 'text',
      id: input.id,
      text: input.text,
      translatable: input.translatable,
    });
  }
  if (
    input.kind !== 'element' ||
    !hasExactKeysWithOptional(input, [
      'kind', 'id', 'namespace', 'tagName', 'attributes', 'children',
    ], ['visuallyHidden', 'selectedImageSource', 'shadowRoot']) ||
    !isNamespace(input.namespace) ||
    !isSafeTagName(input.tagName) ||
    UNSAFE_ELEMENTS.has(input.tagName) ||
    !Array.isArray(input.attributes) ||
    input.attributes.length > MAX_HTML_MIRROR_ATTRIBUTES ||
    !Array.isArray(input.children)
  ) return undefined;
  if (
    (input.visuallyHidden !== undefined && input.visuallyHidden !== true) ||
    (input.selectedImageSource !== undefined &&
      (
        input.tagName !== 'img' ||
        typeof input.selectedImageSource !== 'string' ||
        passiveUrl(input.selectedImageSource, 'about:blank', true) !==
          input.selectedImageSource
      ))
  ) return undefined;
  if (typeof input.selectedImageSource === 'string') {
    budget.bytes += input.selectedImageSource.length * 2;
    if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
  }
  const attributes: Array<readonly [string, string]> = [];
  const seenAttributes = new Set<string>();
  for (const attribute of input.attributes) {
    if (
      !Array.isArray(attribute) || attribute.length !== 2 ||
      typeof attribute[0] !== 'string' ||
      typeof attribute[1] !== 'string' ||
      !isSafeAttributeName(attribute[0]) ||
      attribute[1].length > MAX_HTML_MIRROR_STRING ||
      seenAttributes.has(attribute[0]) ||
      isUnsafeTransportedAttribute(input.tagName, attribute[0], attribute[1])
    ) return undefined;
    seenAttributes.add(attribute[0]);
    budget.bytes += (attribute[0].length + attribute[1].length) * 2 + 8;
    attributes.push(Object.freeze([attribute[0], attribute[1]] as const));
  }
  const children: HtmlMirrorNode[] = [];
  const transportedPrivateRegion = privateRegion ||
    isSourcePrivateTagName(input.tagName) ||
    transportedAttributesArePrivate(attributes);
  const transportedActivationElement =
    isSourceActivationTagName(input.tagName) ||
    isSourceActivationRoleValue(Object.fromEntries(attributes).role);
  const transportedActivationRegion = activationRegion ||
    transportedActivationElement;
  const transportedPrivateAttributeRegion = privateAttributeRegion ||
    transportedPrivateRegion ||
    transportedActivationElement;
  const transportedNonContentRegion = nonContentRegion ||
    NON_CONTENT_ELEMENTS.has(input.tagName);
  const transportedStyleRegion = styleRegion || input.tagName === 'style';
  if (
    transportedPrivateAttributeRegion &&
    hasPrivateHtmlMirrorAttribute(attributes)
  ) {
    return undefined;
  }
  for (const child of input.children) {
    const parsed = readHtmlMirrorNode(
      child,
      sharedIds,
      depth + 1,
      budget,
      transportedPrivateRegion,
      transportedNonContentRegion,
      transportedStyleRegion,
      transportedPrivateAttributeRegion,
      transportedActivationRegion,
    );
    if (!parsed) return undefined;
    children.push(parsed);
  }
  budget.bytes += input.tagName.length * 2 + 64;
  if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
  let shadowRoot: HtmlMirrorShadowRoot | undefined;
  if (input.shadowRoot !== undefined) {
    if (
      !isRecord(input.shadowRoot) ||
      !hasExactKeys(input.shadowRoot, [
        'id', 'mode', 'children', 'adoptedStyleSheets',
      ]) ||
      !isNodeId(input.shadowRoot.id) ||
      input.shadowRoot.mode !== 'open' ||
      !Array.isArray(input.shadowRoot.children) ||
      budget.ids.has(input.shadowRoot.id)
    ) return undefined;
    budget.nodes += 1;
    budget.bytes += 32;
    budget.ids.add(input.shadowRoot.id);
    if (
      budget.nodes > MAX_HTML_MIRROR_NODES ||
      budget.bytes > MAX_HTML_MIRROR_BYTES
    ) return undefined;
    const shadowChildren: HtmlMirrorNode[] = [];
    for (const child of input.shadowRoot.children) {
      const parsed = readHtmlMirrorNode(
        child,
        sharedIds,
        depth + 1,
        budget,
        transportedPrivateRegion,
        transportedNonContentRegion,
        transportedStyleRegion,
        transportedPrivateAttributeRegion,
        transportedActivationRegion,
      );
      if (!parsed) return undefined;
      shadowChildren.push(parsed);
    }
    const adoptedStyleSheets = readTransportedAdoptedStyleSheets(
      input.shadowRoot.adoptedStyleSheets,
      budget,
    );
    if (!adoptedStyleSheets) return undefined;
    shadowRoot = Object.freeze({
      id: input.shadowRoot.id,
      mode: 'open',
      children: Object.freeze(shadowChildren),
      adoptedStyleSheets,
    });
  }
  return Object.freeze({
    kind: 'element',
    id: input.id,
    namespace: input.namespace,
    tagName: input.tagName,
    attributes: Object.freeze(attributes),
    children: Object.freeze(children),
    ...(input.visuallyHidden === true ? { visuallyHidden: true as const } : {}),
    ...(typeof input.selectedImageSource === 'string'
      ? { selectedImageSource: input.selectedImageSource }
      : {}),
    ...(shadowRoot ? { shadowRoot } : {}),
  });
}

export interface HtmlMirrorDocumentContent {
  readonly root: HtmlMirrorElementNode;
  readonly adoptedStyleSheets: readonly string[];
}

/** Revalidates one canonical document payload with a shared global budget. */
export function readHtmlMirrorDocumentContent(
  rootInput: unknown,
  adoptedStyleSheetsInput: unknown,
): HtmlMirrorDocumentContent | undefined {
  const ids = new Set<number>();
  const budget = createHtmlMirrorReadBudget(ids);
  const root = readHtmlMirrorNode(rootInput, ids, 0, budget);
  if (!root || root.kind !== 'element' || root.tagName !== 'html') {
    return undefined;
  }
  const adoptedStyleSheets = readTransportedAdoptedStyleSheets(
    adoptedStyleSheetsInput,
    budget,
  );
  if (!adoptedStyleSheets) return undefined;
  return Object.freeze({ root, adoptedStyleSheets });
}

export function htmlMirrorJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function serializeNode(
  live: Node,
  context: SerializeContext,
): HtmlMirrorNode | undefined {
  if (context.depth > MAX_HTML_MIRROR_DEPTH) return undefined;
  const id = context.registry.getId(live);
  if (!isNodeId(id) || context.budget.ids.has(id)) return undefined;
  if (live.nodeType === Node.TEXT_NODE) {
    const rawText = live.nodeValue ?? '';
    const styledText = context.styleRegion
      ? sanitizeCss(rawText, context.baseUrl) ?? ''
      : rawText;
    const text = context.privateRegion ? '' : styledText;
    if (text.length > MAX_HTML_MIRROR_STRING) return undefined;
    admitNode(context.budget, id, text.length * 2 + 32);
    return Object.freeze({
      kind: 'text',
      id,
      text,
      translatable:
        !context.privateRegion && !context.nonContentRegion && text.trim().length > 0,
    });
  }
  if (live.nodeType !== Node.ELEMENT_NODE) {
    return undefined;
  }
  const liveElement = live as Element;
  const tagName = liveElement.localName.toLowerCase();
  if (!isSafeTagName(tagName) || UNSAFE_ELEMENTS.has(tagName)) return undefined;
  const namespace = readNamespace(liveElement.namespaceURI);
  if (!namespace) return undefined;
  const privateRegion = context.privateRegion || elementStartsPrivateRegion(liveElement);
  const activationRegion = context.activationRegion ||
    elementStartsActivationRegion(liveElement);
  const privateAttributeRegion = context.privateAttributeRegion ||
    privateRegion ||
    activationRegion;
  const nonContentRegion = context.nonContentRegion || NON_CONTENT_ELEMENTS.has(tagName);
  const styleRegion = context.styleRegion || tagName === 'style';
  const attributes = sanitizeAttributes(
    liveElement,
    tagName,
    privateRegion,
    activationRegion,
    context.baseUrl,
  );
  if (!attributes) return undefined;
  const hints = sanitizeSourceElementHints(liveElement, context.baseUrl);
  admitNode(
    context.budget,
    id,
    tagName.length * 2 + attributes.reduce(
      (total, [name, value]) => total + (name.length + value.length) * 2 + 8,
      64,
    ) + (hints.selectedImageSource?.length ?? 0) * 2,
  );
  const children: HtmlMirrorNode[] = [];
  if (!isVoidElement(tagName)) {
    for (const liveChild of live.childNodes) {
      const child = serializeNode(liveChild, {
        ...context,
        privateRegion,
        privateAttributeRegion,
        activationRegion,
        nonContentRegion,
        styleRegion,
        depth: context.depth + 1,
      });
      if (child) children.push(child);
    }
  }
  let shadowRoot: HtmlMirrorShadowRoot | undefined;
  const sourceShadow = liveElement.shadowRoot;
  if (sourceShadow?.mode === 'open') {
    const shadowId = context.registry.getId(sourceShadow);
    if (!isNodeId(shadowId) || context.budget.ids.has(shadowId)) return undefined;
    admitNode(context.budget, shadowId, 32);
    const shadowChildren: HtmlMirrorNode[] = [];
    for (const childNode of sourceShadow.childNodes) {
      const child = serializeNode(childNode, {
        ...context,
        privateRegion,
        privateAttributeRegion,
        activationRegion,
        nonContentRegion,
        styleRegion,
        depth: context.depth + 1,
      });
      if (child) shadowChildren.push(child);
    }
    const adoptedStyleSheets = captureAdoptedStyleSheets(
      sourceShadow,
      context.baseUrl,
      context.budget,
      context.styleWork,
    );
    if (!adoptedStyleSheets) return undefined;
    shadowRoot = Object.freeze({
      id: shadowId,
      mode: 'open',
      children: Object.freeze(shadowChildren),
      adoptedStyleSheets,
    });
  }
  return Object.freeze({
    kind: 'element',
    id,
    namespace,
    tagName,
    attributes,
    children: Object.freeze(children),
    ...hints,
    ...(shadowRoot ? { shadowRoot } : {}),
  });
}

function sanitizeAttributes(
  element: Element,
  tagName: string,
  privateRegion: boolean,
  activationRegion: boolean,
  baseUrl: string,
): readonly (readonly [string, string])[] | undefined {
  if (element.attributes.length > MAX_HTML_MIRROR_ATTRIBUTES) return undefined;
  const result: Array<readonly [string, string]> = [];
  const privateAttributes = privateRegion || activationRegion ||
    isSourceActivationTagName(tagName) ||
    isSourceActivationRoleValue(element.getAttribute('role'));
  for (const attribute of element.attributes) {
    const name = attribute.name.toLowerCase();
    if (
      !isSafeAttributeName(name) ||
      name.startsWith('on') ||
      name === 'nonce' ||
      ACTIVE_OR_NAVIGATIONAL_ATTRIBUTES.has(name) ||
      (privateAttributes &&
        (PRIVATE_ATTRIBUTES.has(name) || name.startsWith('data-')))
    ) continue;
    if (name === 'alt' && privateRegion) continue;
    let value = attribute.value;
    if (
      name === 'alt' &&
      activationRegion &&
      isSmallBrokenSourceControlIcon(element, tagName)
    ) value = '';
    if (value.length > MAX_HTML_MIRROR_STRING) return undefined;
    if (name === 'href') {
      if (tagName !== 'link' || !isPassiveStylesheet(element)) continue;
      const url = passiveUrl(value, baseUrl, false);
      if (!url) continue;
      value = url;
    } else if (name === 'src') {
      if (!PASSIVE_IMAGE_ELEMENTS.has(tagName)) continue;
      const url = passiveUrl(value, baseUrl, true);
      if (!url) continue;
      value = url;
    } else if (name === 'srcset') {
      if (tagName !== 'img') continue;
      const sourceSet = sanitizeSrcset(value, baseUrl);
      if (!sourceSet) continue;
      value = sourceSet;
    } else if (name === 'style') {
      const style = sanitizeCss(value, baseUrl, true);
      if (!style) continue;
      value = style;
    } else if (name === 'rel' && tagName === 'link') {
      if (!isPassiveStylesheet(element)) continue;
      value = 'stylesheet';
    } else if (name === 'http-equiv' || name === 'content') {
      if (tagName === 'meta') continue;
    }
    result.push(Object.freeze([name, value] as const));
  }
  if (tagName === 'form') result.push(Object.freeze(['inert', ''] as const));
  return Object.freeze(result);
}

export function createHtmlMirrorReadBudget(
  ids: Set<number> = new Set(),
): HtmlMirrorReadBudget {
  return { nodes: 0, bytes: 0, styleSheets: 0, styleRules: 0, ids };
}

function captureAdoptedStyleSheets(
  owner: Document | ShadowRoot,
  baseUrl: string,
  budget: HtmlMirrorReadBudget,
  work: HtmlMirrorStyleWorkBudget,
): readonly string[] | undefined {
  const styles = sanitizeSourceAdoptedStyleSheets(owner, baseUrl, work);
  if (!styles) return undefined;
  if (budget.styleSheets + styles.length > MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS) {
    return undefined;
  }
  budget.styleSheets += styles.length;
  for (const cssText of styles) {
    const styleRules = countCssRuleBlocks(cssText);
    if (budget.styleRules + styleRules > MAX_HTML_MIRROR_ADOPTED_STYLE_RULES) {
      return undefined;
    }
    budget.styleRules += styleRules;
    budget.bytes += cssText.length * 2 + 16;
    if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
  }
  return styles;
}

function readTransportedAdoptedStyleSheets(
  input: unknown,
  budget: HtmlMirrorReadBudget,
): readonly string[] | undefined {
  if (
    !Array.isArray(input) ||
    input.length > MAX_ADOPTED_STYLE_SHEETS_PER_OWNER ||
    budget.styleSheets + input.length > MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS
  ) return undefined;
  budget.styleSheets += input.length;
  const styles: string[] = [];
  let ownerCharacters = 0;
  let ownerRules = 0;
  for (const cssText of input) {
    if (
      typeof cssText !== 'string' ||
      cssText.length > MAX_HTML_MIRROR_STRING ||
      sanitizeCss(cssText, 'about:blank') !== cssText
    ) return undefined;
    const styleRules = countCssRuleBlocks(cssText);
    ownerCharacters += cssText.length;
    ownerRules += styleRules;
    if (
      ownerCharacters > MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER ||
      ownerRules > MAX_ADOPTED_STYLE_RULES_PER_OWNER ||
      budget.styleRules + styleRules > MAX_HTML_MIRROR_ADOPTED_STYLE_RULES
    ) return undefined;
    budget.styleRules += styleRules;
    budget.bytes += cssText.length * 2 + 16;
    if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
    styles.push(cssText);
  }
  return Object.freeze(styles);
}

function readAdoptedStyleSheet(
  sheet: CSSStyleSheet,
  baseUrl: string,
  work: HtmlMirrorStyleWorkBudget,
): AdoptedStyleSheetRead | undefined {
  try {
    if (sheet.disabled) return undefined;
    const mediaText = sheet.media?.mediaText?.trim() ?? '';
    if (mediaText.length > MAX_HTML_MIRROR_STRING) return undefined;
    const rules = sheet.cssRules;
    const length = rules.length;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      work.rules + length > work.maxRules
    ) {
      work.exhausted = true;
      return undefined;
    }
    const parts: string[] = [];
    let characters = 0;
    for (let index = 0; index < length; index += 1) {
      const rule = rules[index] ?? rules.item(index);
      if (!rule || typeof rule.cssText !== 'string') return undefined;
      const separator = parts.length > 0 ? 1 : 0;
      if (characters + separator + rule.cssText.length > MAX_HTML_MIRROR_STRING) {
        return undefined;
      }
      parts.push(rule.cssText);
      characters += separator + rule.cssText.length;
    }
    const rulesText = parts.join('\n');
    const cssText = sanitizeCss(
      mediaText ? `@media ${mediaText}{${rulesText}}` : rulesText,
      baseUrl,
    );
    return cssText === undefined
      ? undefined
      : Object.freeze({
          cssText,
          ruleCount: countCssRuleBlocks(cssText),
        });
  } catch {
    return undefined;
  }
}

function boundedWorkLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) >= 1
    ? Math.min(Number(value), fallback)
    : fallback;
}

/** Conservatively counts CSS rule blocks without treating escaped/string braces as rules. */
function countCssRuleBlocks(cssText: string): number {
  let count = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < cssText.length; index += 1) {
    const character = cssText[index]!;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') count += 1;
  }
  return count;
}

export function sanitizeCss(
  css: string,
  baseUrl: string,
  declarationList = false,
): string | undefined {
  const commentless = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const decoded = decodeCssEscapes(commentless);
  if (
    css.length > MAX_HTML_MIRROR_STRING ||
    /(?:expression\s*\(|-moz-binding\s*:|javascript\s*:)/iu.test(decoded) ||
    containsLegacyBehaviorDeclaration(decoded, declarationList)
  ) return undefined;
  const withoutImports = stripCssImports(commentless);
  const decodedWithoutImports = decodeCssEscapes(withoutImports);
  const decodedUrlCount = decodedWithoutImports.match(/\burl\s*\(/giu)?.length ?? 0;
  const literalUrlCount = withoutImports.match(/\burl\s*\(/giu)?.length ?? 0;
  // Preserve meaningful selector/string escapes, but reject an escaped URL
  // function name that the literal rewriter below cannot safely isolate.
  if (decodedUrlCount !== literalUrlCount) return undefined;
  return withoutImports.replace(
    /\burl\s*\(\s*(['"]?)(.*?)\1\s*\)/giu,
    (_match, _quote: string, raw: string) => {
      const url = passiveUrl(decodeCssEscapes(raw.trim()), baseUrl, true);
      return url ? `url("${url.replaceAll('"', '%22')}")` : 'none';
    },
  );
}

function containsLegacyBehaviorDeclaration(
  css: string,
  declarationList: boolean,
): boolean {
  const boundary = declarationList ? '(?:^|;)' : '(?:[;{])';
  return new RegExp(`${boundary}\\s*[*_]?\\s*behavior\\s*:`, 'iu').test(css);
}

/** Removes escaped/comment-obfuscated imports without discarding passive CSS. */
function stripCssImports(css: string): string {
  let output = '';
  let index = 0;
  let quote: '"' | "'" | undefined;
  while (index < css.length) {
    const character = css[index]!;
    if (quote) {
      output += character;
      if (character === '\\' && index + 1 < css.length) {
        output += css[index + 1]!;
        index += 2;
        continue;
      }
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === '@') {
      const decodedPrefix = decodeCssEscapes(css.slice(index, index + 128));
      if (/^@\s*import\b/iu.test(decodedPrefix)) {
        let depth = 0;
        let importQuote: '"' | "'" | undefined;
        while (index < css.length) {
          const next = css[index]!;
          if (importQuote) {
            if (next === '\\') {
              index += Math.min(2, css.length - index);
              continue;
            }
            if (next === importQuote) importQuote = undefined;
          } else if (next === '\\') {
            index += Math.min(2, css.length - index);
            continue;
          } else if (next === '"' || next === "'") {
            importQuote = next;
          } else if (next === '(') {
            depth += 1;
          } else if (next === ')') {
            depth = Math.max(0, depth - 1);
          } else if (next === ';' && depth === 0) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}

function sanitizeSrcset(value: string, baseUrl: string): string | undefined {
  const candidates: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (
      offset < value.length &&
      (value[offset] === ',' || isAsciiWhitespace(value[offset]!))
    ) {
      offset += 1;
    }
    if (offset >= value.length) break;

    // Follow the important boundary from the HTML srcset parser: the URL is
    // collected through its first whitespace, not split at every comma. Data
    // URLs contain a required comma, so a generic comma split can otherwise
    // reinterpret their payload as a page-relative network request.
    const urlStart = offset;
    while (offset < value.length && !isAsciiWhitespace(value[offset]!)) {
      offset += 1;
    }
    let rawUrl = value.slice(urlStart, offset);
    let endedAtComma = false;
    while (rawUrl.endsWith(',')) {
      rawUrl = rawUrl.slice(0, -1);
      endedAtComma = true;
    }

    let suffix = '';
    if (!endedAtComma) {
      while (offset < value.length && isAsciiWhitespace(value[offset]!)) {
        offset += 1;
      }
      const descriptorStart = offset;
      while (offset < value.length && value[offset] !== ',') offset += 1;
      suffix = value.slice(descriptorStart, offset).trim();
      if (offset < value.length) offset += 1;
    }

    const url = rawUrl ? passiveUrl(rawUrl, baseUrl, true) : undefined;
    if (!url) continue;
    if (suffix && !/^(?:\d+(?:\.\d+)?x|\d+w)$/u.test(suffix)) continue;
    candidates.push(suffix ? `${url} ${suffix}` : url);
  }
  return candidates.length > 0 ? candidates.join(', ') : undefined;
}

function isAsciiWhitespace(character: string): boolean {
  return character === '\t' || character === '\n' || character === '\f' ||
    character === '\r' || character === ' ';
}

function passiveUrl(
  raw: string,
  baseUrl: string,
  allowDataImage: boolean,
): string | undefined {
  if (allowDataImage && /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/iu.test(raw)) {
    return raw.length <= MAX_HTML_MIRROR_STRING ? raw : undefined;
  }
  if (allowDataImage && isSafeStaticSvgDataImage(raw)) return raw;
  try {
    const parsed = new URL(raw, baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    parsed.username = '';
    parsed.password = '';
    return parsed.href.length <= MAX_HTML_MIRROR_STRING ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function selectedSourceFor(
  element: Element,
  baseUrl: string,
): string | undefined {
  const raw = (element as Element & { readonly currentSrc?: unknown }).currentSrc;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const selected = passiveUrl(raw, baseUrl, true);
  if (!selected) return undefined;
  const declaredRaw = element.getAttribute('src') ?? '';
  const declared = declaredRaw ? passiveUrl(declaredRaw, baseUrl, true) : undefined;
  return selected !== declared ? selected : undefined;
}

function isSmallBrokenSourceControlIcon(
  element: Element,
  tagName: string,
): boolean {
  if (tagName !== 'img') return false;
  const image = element as Element & {
    readonly complete?: unknown;
    readonly naturalWidth?: unknown;
    readonly naturalHeight?: unknown;
  };
  if (
    image.complete !== true ||
    (image.naturalWidth !== 0 && image.naturalHeight !== 0)
  ) return false;
  const dimensions = [
    renderedImageDimensions(element),
    declaredImageDimensions(element),
  ].filter((value): value is { readonly width: number; readonly height: number } =>
    value !== undefined,
  );
  return dimensions.length > 0 && dimensions.every(
    ({ width, height }) =>
      width <= MAX_BROKEN_CONTROL_ICON_EDGE &&
      height <= MAX_BROKEN_CONTROL_ICON_EDGE,
  );
}

function renderedImageDimensions(
  element: Element,
): { readonly width: number; readonly height: number } | undefined {
  try {
    const bounds = element.getBoundingClientRect();
    const width = boundedPositiveGeometry(bounds.width);
    const height = boundedPositiveGeometry(bounds.height);
    return width !== undefined && height !== undefined
      ? { width, height }
      : undefined;
  } catch {
    return undefined;
  }
}

function declaredImageDimensions(
  element: Element,
): { readonly width: number; readonly height: number } | undefined {
  const width = declaredImageDimension(element.getAttribute('width'));
  const height = declaredImageDimension(element.getAttribute('height'));
  return width !== undefined && height !== undefined
    ? { width, height }
    : undefined;
}

function declaredImageDimension(value: string | null): number | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/u.test(value.trim())) return undefined;
  return boundedPositiveGeometry(Number(value));
}

function boundedPositiveGeometry(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000
    ? value
    : undefined;
}

/**
 * Recognize only the canonical screen-reader-only recipe used by component
 * libraries: a clipped 1px box taken out of normal flow. This is deliberately
 * narrower than transporting arbitrary computed styles.
 */
function isCanonicalClippedSourceElement(element: Element): boolean {
  const candidate = `${element.localName} ${element.getAttribute('class') ?? ''} ${
    element.getAttribute('style') ?? ''
  }`;
  if (!/(?:screen-reader|sr-only|visually-hidden|a11y|clip(?:-path)?\s*:)/iu.test(
    candidate,
  )) return false;
  const view = element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  try {
    const style = view.getComputedStyle(element);
    const position = style.position.trim().toLowerCase();
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`
      .toLowerCase();
    const clip = style.clip.replaceAll(' ', '').toLowerCase();
    const clipPath = style.clipPath.replaceAll(' ', '').toLowerCase();
    const width = cssPixelValue(style.width);
    const height = cssPixelValue(style.height);
    const clipped = /^rect\((?:0|1)px,(?:0|1)px,(?:0|1)px,(?:0|1)px\)$/u
      .test(clip) || /^inset\((?:50%|1px)(?:round0)?\)$/u.test(clipPath);
    return (position === 'absolute' || position === 'fixed') &&
      overflow.includes('hidden') &&
      clipped &&
      width !== undefined && width <= 1 &&
      height !== undefined && height <= 1;
  } catch {
    return false;
  }
}

function cssPixelValue(value: string): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?)px$/u.exec(value.trim().toLowerCase());
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isUnsafeTransportedAttribute(
  tagName: string,
  name: string,
  value: string,
): boolean {
  if (
    name.startsWith('on') ||
    name === 'nonce' ||
    ACTIVE_OR_NAVIGATIONAL_ATTRIBUTES.has(name)
  ) return true;
  if (name === 'href') {
    return tagName !== 'link' || !/^https?:\/\//u.test(value);
  }
  if (name === 'src') {
    return !PASSIVE_IMAGE_ELEMENTS.has(tagName) ||
      passiveUrl(value, 'about:blank', true) !== value;
  }
  if (name === 'srcset') {
    return tagName !== 'img' || sanitizeSrcset(value, 'about:blank') !== value;
  }
  if (name === 'style') {
    return sanitizeCss(value, 'about:blank', true) !== value;
  }
  return false;
}

function elementStartsPrivateRegion(element: Element): boolean {
  return isSourcePrivateTagName(element.localName) ||
    isSourcePrivateContentEditableValue(
      element.hasAttribute('contenteditable')
        ? element.getAttribute('contenteditable') ?? ''
        : undefined,
    ) ||
    isSourcePrivateRoleValue(element.getAttribute('role'));
}

function elementStartsActivationRegion(element: Element): boolean {
  return isSourceActivationTagName(element.localName) ||
    isSourceActivationRoleValue(element.getAttribute('role'));
}

const STATIC_SVG_ELEMENTS = new Set([
  'circle',
  'ellipse',
  'g',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  'svg',
]);

const STATIC_SVG_ATTRIBUTES = new Set([
  'aria-hidden',
  'class',
  'clip-rule',
  'cx',
  'cy',
  'd',
  'fill',
  'fill-opacity',
  'fill-rule',
  'focusable',
  'height',
  'id',
  'linecap',
  'linejoin',
  'opacity',
  'points',
  'preserveaspectratio',
  'r',
  'role',
  'rx',
  'ry',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'transform',
  'vector-effect',
  'viewbox',
  'width',
  'x',
  'x1',
  'x2',
  'xmlns',
  'y',
  'y1',
  'y2',
]);

/**
 * Admit only a small, URL-encoded, shape-only SVG profile. It deliberately
 * excludes CSS, links, references, animation, text, entities, and every
 * resource-bearing element so an image cannot become a second active graph.
 */
function isSafeStaticSvgDataImage(value: string): boolean {
  if (value.length > MAX_HTML_MIRROR_STRING) return false;
  const match = /^data:image\/svg\+xml(?:;charset=(?:utf-8|us-ascii))?,([\s\S]*)$/iu.exec(
    value,
  );
  if (!match) return false;
  let xml: string;
  try {
    xml = decodeURIComponent(match[1]!);
  } catch {
    return false;
  }
  if (
    xml.length === 0 ||
    xml.length > MAX_HTML_MIRROR_STRING ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(xml) ||
    /(?:<!|<\?|&|\burl\s*\(|javascript\s*:|data\s*:)/iu.test(xml)
  ) return false;

  const stack: string[] = [];
  let rootSeen = false;
  let offset = 0;
  const tokens = xml.matchAll(/<[^<>]*>/gu);
  for (const token of tokens) {
    const index = token.index;
    if (index === undefined || xml.slice(offset, index).trim() !== '') return false;
    const rawToken = token[0];
    offset = index + rawToken.length;
    const parsed = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)\s*([\s\S]*?)\s*(\/?)>$/iu.exec(
      rawToken,
    );
    if (!parsed) return false;
    const closing = parsed[1] === '/';
    const tagName = parsed[2]!.toLowerCase();
    const attributeText = parsed[3] ?? '';
    const selfClosing = parsed[4] === '/';
    if (!STATIC_SVG_ELEMENTS.has(tagName)) return false;
    if (closing) {
      if (selfClosing || attributeText.trim() !== '' || stack.pop() !== tagName) {
        return false;
      }
      continue;
    }
    if (!rootSeen) {
      if (tagName !== 'svg' || stack.length !== 0) return false;
      rootSeen = true;
    } else if (stack.length === 0) {
      return false;
    }
    if (!readSafeStaticSvgAttributes(attributeText, tagName === 'svg')) return false;
    if (!selfClosing) stack.push(tagName);
  }
  return rootSeen && stack.length === 0 && xml.slice(offset).trim() === '';
}

function readSafeStaticSvgAttributes(
  source: string,
  root: boolean,
): boolean {
  const seen = new Set<string>();
  let offset = 0;
  while (offset < source.length) {
    while (offset < source.length && /\s/u.test(source[offset]!)) offset += 1;
    if (offset >= source.length) break;
    const attribute = /^([a-z][a-z0-9-]*)\s*=\s*(["'])([\s\S]*?)\2/iu.exec(
      source.slice(offset),
    );
    if (!attribute) return false;
    const name = attribute[1]!.toLowerCase();
    const value = attribute[3] ?? '';
    const decodedValue = decodeCssEscapes(value);
    if (
      seen.has(name) ||
      !STATIC_SVG_ATTRIBUTES.has(name) ||
      value.length > 16_384 ||
      /[<>\u0000-\u001f\u007f]/u.test(value) ||
      /[<>\u0000-\u001f\u007f]/u.test(decodedValue) ||
      (name === 'xmlns'
        ? !root || value !== 'http://www.w3.org/2000/svg'
        : /(?:\burl\s*\(|javascript\s*:|https?\s*:|data\s*:)/iu.test(
          decodedValue,
        ))
    ) return false;
    seen.add(name);
    offset += attribute[0].length;
  }
  return true;
}

function transportedAttributesArePrivate(
  attributes: readonly (readonly [string, string])[],
): boolean {
  const values = Object.fromEntries(attributes);
  return isSourcePrivateContentEditableValue(values.contenteditable) ||
    isSourcePrivateRoleValue(values.role);
}

function hasNonContentAncestor(element: Element): boolean {
  for (let current: Element | undefined = element; current;) {
    if (NON_CONTENT_ELEMENTS.has(current.localName.toLowerCase())) return true;
    current = composedParentElement(current);
  }
  return false;
}

export function hasPrivateHtmlMirrorAttribute(
  attributes: readonly (readonly [string, string])[],
): boolean {
  return attributes.some(
    ([name]) => PRIVATE_ATTRIBUTES.has(name) || name.startsWith('data-'),
  );
}

function composedParentElement(element: Element): Element | undefined {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : undefined;
}

function nearestElement(node: Node): Element | undefined {
  if (node.nodeType === Node.ELEMENT_NODE) return node as Element;
  if (node.parentElement) return node.parentElement;
  const root = node.getRootNode();
  return root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
    ? (root as ShadowRoot).host
    : undefined;
}

function decodeCssEscapes(value: string): string {
  return value.replace(
    /\\(?:([0-9a-fA-F]{1,6})[\t\n\f\r ]?|([^\n\r\f0-9a-fA-F]))/gu,
    (_match, hex: string | undefined, escaped: string | undefined) => {
      if (hex) {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '\uFFFD';
      }
      return escaped ?? '';
    },
  );
}

function isPassiveStylesheet(element: Element): boolean {
  const rel = element.getAttribute('rel')?.toLowerCase().split(/\s+/u) ?? [];
  return rel.includes('stylesheet') && !rel.includes('alternate');
}

function readNamespace(value: string | null): HtmlMirrorNamespace | undefined {
  if (!value || value === 'http://www.w3.org/1999/xhtml') return 'html';
  if (value === 'http://www.w3.org/2000/svg') return 'svg';
  if (value === 'http://www.w3.org/1998/Math/MathML') return 'mathml';
  return undefined;
}

function isNamespace(value: unknown): value is HtmlMirrorNamespace {
  return value === 'html' || value === 'svg' || value === 'mathml';
}

function isSafeTagName(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 && value.length <= 128 &&
    /^[a-z][a-z0-9._:-]*$/u.test(value);
}

function isSafeAttributeName(value: string): boolean {
  return value.length >= 1 && value.length <= 128 &&
    /^[a-z_][a-z0-9_.:-]*$/u.test(value);
}

function isVoidElement(tagName: string): boolean {
  return new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
  ]).has(tagName);
}

function admitNode(
  budget: HtmlMirrorReadBudget,
  id: number,
  bytes: number,
): void {
  budget.nodes += 1;
  budget.bytes += bytes;
  budget.ids.add(id);
  if (
    budget.nodes > MAX_HTML_MIRROR_NODES ||
    budget.bytes > MAX_HTML_MIRROR_BYTES
  ) throw new Error('HTML mirror budget exceeded.');
}

function boundedDimension(value: number): number {
  return Number.isFinite(value)
    ? Math.max(1, Math.min(1_000_000, Math.round(value)))
    : 1;
}

function isNodeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key));
}
