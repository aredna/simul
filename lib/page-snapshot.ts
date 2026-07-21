export const SNAPSHOT_VERSION = 1 as const;

export const SNAPSHOT_LIMITS = {
  maxItems: 1_200,
  maxCharacters: 150_000,
  maxTextLength: 3_500,
  maxVisitedNodes: 50_000,
  maxVisualNodes: 10_000,
  maxVisualDepth: 80,
  maxVisualStyles: 2_000,
  maxVisualValueLength: 500,
  maxVisualAttributeLength: 2_048,
  maxVisualTextCharacters: 300_000,
  maxVisualStyleCharacters: 2_000_000,
  maxVisualAttributeCharacters: 500_000,
  maxImageUrlCharacters: 200_000,
  maxDocumentDimension: 100_000,
  maxTitleLength: 300,
  maxUrlLength: 100_000,
} as const;

export const VISUAL_STYLE_PROPERTIES = [
  'align-content',
  'align-items',
  'align-self',
  'aspect-ratio',
  'background-attachment',
  'background-clip',
  'background-color',
  'background-image',
  'background-origin',
  'background-position',
  'background-repeat',
  'background-size',
  'border-bottom-color',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'border-bottom-style',
  'border-bottom-width',
  'border-collapse',
  'border-left-color',
  'border-left-style',
  'border-left-width',
  'border-right-color',
  'border-right-style',
  'border-right-width',
  'border-spacing',
  'border-top-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-top-style',
  'border-top-width',
  'bottom',
  'box-shadow',
  'box-sizing',
  'break-after',
  'break-before',
  'break-inside',
  'caption-side',
  'clear',
  'color',
  'column-count',
  'column-fill',
  'column-gap',
  'column-rule-color',
  'column-rule-style',
  'column-rule-width',
  'column-width',
  'direction',
  'display',
  'empty-cells',
  'flex-basis',
  'flex-direction',
  'flex-grow',
  'flex-shrink',
  'flex-wrap',
  'float',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'gap',
  'grid-auto-columns',
  'grid-auto-flow',
  'grid-auto-rows',
  'grid-column',
  'grid-row',
  'grid-template-columns',
  'grid-template-areas',
  'grid-template-rows',
  'height',
  'hyphens',
  'justify-content',
  'justify-items',
  'justify-self',
  'left',
  'letter-spacing',
  'line-height',
  'list-style-position',
  'list-style-type',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'object-fit',
  'object-position',
  'opacity',
  'order',
  'overflow-wrap',
  'overflow-x',
  'overflow-y',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'position',
  'right',
  'row-gap',
  'table-layout',
  'text-align',
  'text-decoration-color',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-thickness',
  'text-indent',
  'text-overflow',
  'text-shadow',
  'text-transform',
  'top',
  'transform',
  'transform-origin',
  'vertical-align',
  'visibility',
  'white-space',
  'width',
  'word-break',
  'word-spacing',
  'writing-mode',
  'z-index',
] as const;

export type VisualStyleProperty = (typeof VISUAL_STYLE_PROPERTIES)[number];
export type VisualStyle = Partial<Record<VisualStyleProperty, string>>;

export type VisualControlShell = 'button' | 'input' | 'select' | 'textarea';

export interface VisualSelectState {
  disabled: boolean;
  multiple: boolean;
  open: boolean;
}

export interface VisualOptionState {
  disabled: boolean;
  selected: boolean;
}

export interface VisualOptgroupState {
  disabled: boolean;
}

export interface VisualTextNode {
  kind: 'text';
  text: string;
  itemId?: string;
  nodeId?: string;
}

export interface VisualElementNode {
  kind: 'element';
  tag: string;
  styleId: number;
  itemId?: string;
  controlShell?: VisualControlShell;
  selectState?: VisualSelectState;
  optionState?: VisualOptionState;
  optgroupState?: VisualOptgroupState;
  nodeId?: string;
  attributes?: Record<string, string>;
  children: VisualNode[];
}

export interface VisualPlaceholderNode {
  kind: 'placeholder';
  styleId: number;
  label: string;
  nodeId?: string;
}

export type VisualNode =
  | VisualTextNode
  | VisualElementNode
  | VisualPlaceholderNode;

export interface VisualPage {
  viewportWidth: number;
  viewportHeight: number;
  documentWidth: number;
  documentHeight: number;
  styles: VisualStyle[];
  root: VisualElementNode;
}

export type SnapshotTextRole =
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'heading-4'
  | 'heading-5'
  | 'heading-6'
  | 'paragraph'
  | 'list-item'
  | 'quote'
  | 'code'
  | 'text';

export interface SnapshotTextItem {
  id: string;
  kind: 'text';
  role: SnapshotTextRole;
  text: string;
}

export interface SnapshotImageItem {
  id: string;
  kind: 'image';
  src: string;
  altText?: string;
  caption?: string;
}

export type SnapshotItem = SnapshotTextItem | SnapshotImageItem;

export interface SnapshotOmissions {
  hidden: number;
  controls: number;
  frames: number;
  unsafeImages: number;
  truncated: boolean;
}

export interface PageSnapshot {
  version: typeof SNAPSHOT_VERSION;
  title: string;
  url: string;
  documentLanguage?: string;
  capturedAt: string;
  items: SnapshotItem[];
  omissions: SnapshotOmissions;
  visual?: VisualPage;
}

const TEXT_ROLES = new Set<SnapshotTextRole>([
  'heading-1',
  'heading-2',
  'heading-3',
  'heading-4',
  'heading-5',
  'heading-6',
  'paragraph',
  'list-item',
  'quote',
  'code',
  'text',
]);

const VISUAL_STYLE_PROPERTY_SET = new Set<string>(VISUAL_STYLE_PROPERTIES);
const SAFE_VISUAL_TAGS = new Set([
  'address',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'button',
  'caption',
  'circle',
  'code',
  'col',
  'colgroup',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'ellipse',
  'figcaption',
  'figure',
  'footer',
  'g',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'i',
  'img',
  'input',
  'label',
  'li',
  'line',
  'main',
  'mark',
  'nav',
  'ol',
  'optgroup',
  'option',
  'p',
  'path',
  'picture',
  'polygon',
  'polyline',
  'pre',
  'rect',
  'section',
  'select',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'svg',
  'table',
  'tbody',
  'td',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
]);
const SAFE_VISUAL_ATTRIBUTES = new Set([
  'alt',
  'colspan',
  'cx',
  'cy',
  'd',
  'fill',
  'height',
  'open',
  'points',
  'preserveAspectRatio',
  'r',
  'rowspan',
  'rx',
  'ry',
  'src',
  'start',
  'stroke',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-width',
  'transform',
  'viewBox',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
]);

export class InvalidPageSnapshotError extends Error {
  constructor(message = 'The page returned an invalid snapshot.') {
    super(message);
    this.name = 'InvalidPageSnapshotError';
  }
}

export function normalizeVisibleText(value: string, limit: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, Math.max(0, limit));
}

export function isSafeImageSource(value: string): boolean {
  if (value.length === 0 || value.length > SNAPSHOT_LIMITS.maxUrlLength) {
    return false;
  }

  try {
    const url = new URL(value);

    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return true;
    }

    return /^data:image\/(?:avif|gif|jpeg|png|webp);/iu.test(value);
  } catch {
    return false;
  }
}

/**
 * Treat data crossing the scripting boundary as untrusted. This rebuilds a
 * snapshot from known typed fields and deliberately drops HTML, handlers, and
 * every other property a hostile page might try to return.
 */
export function parsePageSnapshot(input: unknown): PageSnapshot {
  if (!isRecord(input) || input.version !== SNAPSHOT_VERSION) {
    throw new InvalidPageSnapshotError();
  }

  const rawItems = Array.isArray(input.items) ? input.items : [];
  const items: SnapshotItem[] = [];
  const normalizedItemIds = new Map<string, string>();
  let characterCount = 0;
  let imageUrlCharacters = 0;
  let boundaryTruncated = false;

  for (const rawItem of rawItems.slice(0, SNAPSHOT_LIMITS.maxItems)) {
    if (!isRecord(rawItem) || typeof rawItem.kind !== 'string') {
      continue;
    }

    if (rawItem.kind === 'text') {
      const textWasTruncated = isTextOverLimit(
        rawItem.text,
        SNAPSHOT_LIMITS.maxTextLength,
      );
      boundaryTruncated ||= textWasTruncated;
      const text = readText(rawItem.text, SNAPSHOT_LIMITS.maxTextLength);
      const role = readRole(rawItem.role);

      if (
        !text ||
        !role ||
        characterCount + text.length > SNAPSHOT_LIMITS.maxCharacters
      ) {
        if (text && role) boundaryTruncated = true;
        continue;
      }

      characterCount += text.length;
      const id = `text-${items.length + 1}`;
      items.push({
        id,
        kind: 'text',
        role,
        text,
      });
      if (!textWasTruncated) {
        rememberItemId(normalizedItemIds, rawItem.id, id);
      }
      continue;
    }

    if (rawItem.kind === 'image' && typeof rawItem.src === 'string') {
      if (!isSafeImageSource(rawItem.src)) {
        continue;
      }
      if (
        imageUrlCharacters + rawItem.src.length >
        SNAPSHOT_LIMITS.maxImageUrlCharacters
      ) {
        boundaryTruncated = true;
        continue;
      }
      imageUrlCharacters += rawItem.src.length;

      boundaryTruncated ||= isTextOverLimit(
        rawItem.altText,
        SNAPSHOT_LIMITS.maxTextLength,
      );
      boundaryTruncated ||= isTextOverLimit(
        rawItem.caption,
        SNAPSHOT_LIMITS.maxTextLength,
      );
      const altText = readText(rawItem.altText, SNAPSHOT_LIMITS.maxTextLength);
      const caption = readText(rawItem.caption, SNAPSHOT_LIMITS.maxTextLength);
      const id = `image-${items.length + 1}`;
      const image: SnapshotImageItem = {
        id,
        kind: 'image',
        src: rawItem.src,
      };

      if (altText && characterCount + altText.length <= SNAPSHOT_LIMITS.maxCharacters) {
        image.altText = altText;
        characterCount += altText.length;
      } else if (altText) {
        boundaryTruncated = true;
      }

      if (caption && characterCount + caption.length <= SNAPSHOT_LIMITS.maxCharacters) {
        image.caption = caption;
        characterCount += caption.length;
      } else if (caption) {
        boundaryTruncated = true;
      }

      items.push(image);
      rememberItemId(normalizedItemIds, rawItem.id, id);
    }
  }

  const rawOmissions = isRecord(input.omissions) ? input.omissions : {};
  const title = readText(input.title, SNAPSHOT_LIMITS.maxTitleLength);
  const url = readHttpPageUrl(input.url);
  const documentLanguage = readText(input.documentLanguage, 35);
  const capturedAt = readIsoDate(input.capturedAt);
  const visual = parseVisualPage(input.visual, normalizedItemIds);

  return {
    version: SNAPSHOT_VERSION,
    title: title || 'Untitled page',
    url,
    ...(documentLanguage ? { documentLanguage } : {}),
    capturedAt,
    items,
    omissions: {
      hidden: readCount(rawOmissions.hidden),
      controls: readCount(rawOmissions.controls),
      frames: readCount(rawOmissions.frames),
      unsafeImages: readCount(rawOmissions.unsafeImages),
      truncated:
        rawOmissions.truncated === true ||
        boundaryTruncated ||
        rawItems.length > SNAPSHOT_LIMITS.maxItems,
    },
    ...(visual ? { visual } : {}),
  };
}

/**
 * Runs inside the active page through chrome.scripting.executeScript. Keep all
 * runtime helpers nested: Chrome serializes this function rather than its
 * module closure.
 */
export function capturePageSnapshot(): PageSnapshot {
  const version = 1 as const;
  const maxItems = 1_200;
  const maxCharacters = 150_000;
  const maxTextLength = 3_500;
  const maxVisitedNodes = 50_000;
  const maxTitleLength = 300;
  const maxUrlLength = 100_000;
  const items: SnapshotItem[] = [];
  const omissions: SnapshotOmissions = {
    hidden: 0,
    controls: 0,
    frames: 0,
    unsafeImages: 0,
    truncated: false,
  };
  let characterCount = 0;
  let imageUrlCharacters = 0;
  let visitedNodes = 0;
  let auxiliaryNodesInspected = 0;
  const textItemIds = new WeakMap<Node, string>();
  const imageItemIds = new WeakMap<Element, string>();
  const groupedTextContainers = new WeakSet<Element>();

  const excludedTags = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'OBJECT',
    'EMBED',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'OPTGROUP',
    'DATALIST',
    'OUTPUT',
  ]);
  const controlTags = new Set([
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'OPTGROUP',
    'DATALIST',
    'OUTPUT',
  ]);
  const privateRoles = new Set([
    'checkbox',
    'combobox',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'textbox',
  ]);
  const publicControlRoles = new Set([
    'button',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'treeitem',
  ]);
  const publicMenuRoles = new Set(['listbox', 'menu', 'option']);
  type SourceRoleKind = 'private' | 'activation' | 'public-menu';
  const roleKind = (element: Element): SourceRoleKind | undefined => {
    for (const role of (
      element
        .getAttribute('role')
        ?.trim()
        .toLowerCase()
        .split(/\s+/u) ?? []
    )) {
      if (privateRoles.has(role)) return 'private';
      if (publicControlRoles.has(role)) return 'activation';
      if (publicMenuRoles.has(role)) return 'public-menu';
    }
    return undefined;
  };
  const hasPublicMenuRole = (element: Element): boolean =>
    roleKind(element) === 'public-menu';
  const blockTags = new Set([
    'ADDRESS',
    'ARTICLE',
    'ASIDE',
    'BLOCKQUOTE',
    'DD',
    'DIV',
    'DL',
    'DT',
    'FIGCAPTION',
    'FOOTER',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'HEADER',
    'LI',
    'MAIN',
    'NAV',
    'P',
    'PRE',
    'SECTION',
    'TABLE',
    'TD',
    'TH',
    'TR',
  ]);

  const normalize = (value: string, limit: number): string =>
    value.replace(/\s+/gu, ' ').trim().slice(0, Math.max(0, limit));

  const normalizeContent = (value: string, limit: number): string => {
    const normalized = value.replace(/\s+/gu, ' ').trim();
    if (normalized.length > limit) omissions.truncated = true;
    return normalized.slice(0, Math.max(0, limit));
  };

  const safeImageSource = (value: string): boolean => {
    if (!value || value.length > maxUrlLength) return false;

    try {
      const url = new URL(value, document.baseURI);
      if (url.protocol === 'http:' || url.protocol === 'https:') return true;
      return /^data:image\/(?:avif|gif|jpeg|png|webp);/iu.test(value);
    } catch {
      return false;
    }
  };

  const isHidden = (element: Element): boolean => {
    if (element.hasAttribute('hidden')) return true;

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    ) {
      return true;
    }

    if (element.tagName === 'SELECT' && selectPresentationIsCollapsed(element, style)) {
      return true;
    }

    return style.display !== 'contents' && element.getClientRects().length === 0;
  };

  const selectPresentationIsCollapsed = (
    element: Element,
    style: CSSStyleDeclaration,
  ): boolean => {
    const value = (property: string): string => {
      try {
        return style.getPropertyValue(property).trim().toLowerCase();
      } catch {
        return '';
      }
    };
    const pixels = (property: string): number | undefined => {
      const match = /^(-?\d+(?:\.\d+)?)px$/u.exec(value(property));
      if (!match) return undefined;
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const overflow = `${value('overflow')} ${value('overflow-x')} ${
      value('overflow-y')
    }`;
    const width = pixels('width');
    const height = pixels('height');
    const position = value('position');
    const left = pixels('left');
    const top = pixels('top');
    const positionedOffscreen = (position === 'absolute' || position === 'fixed') &&
      (
        (left !== undefined && width !== undefined && left + width <= 0) ||
        (top !== undefined && height !== undefined && top + height <= 0)
      );
    const transform = value('transform');
    let collapsedTransform = false;
    if (transform && transform !== 'none') {
      try {
        const rect = element.getBoundingClientRect();
        collapsedTransform = rect.width <= 0 || rect.height <= 0;
      } catch {
        collapsedTransform = /(?:scale(?:3d|x|y)?\([^)]*\b0(?:[),]|\s))/u
          .test(transform);
      }
    }
    return value('content-visibility') === 'hidden' ||
      positionedOffscreen ||
      collapsedTransform ||
      (/(?:^|\s)(?:hidden|clip)(?:\s|$)/u.test(overflow) &&
        (width === 0 || height === 0));
  };

  const hasPrivateContentEditableState = (element: Element): boolean => {
    const value = element.getAttribute('contenteditable');
    return value !== null && value.trim().toLowerCase() !== 'false';
  };

  const isPrivateOrInteractive = (element: Element): boolean => {
    return (
      excludedTags.has(element.tagName) ||
      hasPrivateContentEditableState(element) ||
      roleKind(element) === 'private'
    );
  };

  const composedParentElement = (node: Node): Element | null => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode();
    return typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot
      ? root.host
      : null;
  };

  const composedChildren = (element: Element): Node[] => {
    if (
      element.tagName === 'SLOT' &&
      'assignedNodes' in element &&
      typeof element.assignedNodes === 'function'
    ) {
      const assigned = element.assignedNodes({ flatten: true });
      return assigned.length > 0 ? assigned : [...element.childNodes];
    }
    return element.shadowRoot
      ? [...element.shadowRoot.childNodes]
      : [...element.childNodes];
  };

  const textRole = (container: Element): SnapshotTextRole => {
    switch (container.tagName) {
      case 'H1':
        return 'heading-1';
      case 'H2':
        return 'heading-2';
      case 'H3':
        return 'heading-3';
      case 'H4':
        return 'heading-4';
      case 'H5':
        return 'heading-5';
      case 'H6':
        return 'heading-6';
      case 'P':
      case 'FIGCAPTION':
        return 'paragraph';
      case 'LI':
      case 'DT':
      case 'DD':
        return 'list-item';
      case 'BLOCKQUOTE':
        return 'quote';
      case 'PRE':
      case 'CODE':
        return 'code';
      default:
        return 'text';
    }
  };

  const findContainer = (element: Element): Element => {
    let current: Element | null = element;
    while (current && current !== document.body) {
      if (blockTags.has(current.tagName)) return current;
      current = composedParentElement(current);
    }
    return document.body;
  };

  const stopIfBounded = (): boolean => {
    const atLimit =
      items.length >= maxItems || characterCount >= maxCharacters;
    if (atLimit) omissions.truncated = true;
    return atLimit;
  };

  const collectContainerTextNodes = (container: Element): Node[] => {
    const textNodes: Node[] = [];
    const collect = (node: Node, root: boolean): void => {
      if (auxiliaryNodesInspected >= maxVisitedNodes) {
        omissions.truncated = true;
        return;
      }
      auxiliaryNodesInspected += 1;
      if (node.nodeType === Node.TEXT_NODE) {
        textNodes.push(node);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const element = node as Element;
      if (
        !root &&
        (blockTags.has(element.tagName) ||
          isPrivateOrInteractive(element) ||
          element.tagName === 'IFRAME' ||
          element.tagName === 'FRAME' ||
          isHidden(element))
      ) {
        return;
      }
      for (const child of composedChildren(element)) {
        if (auxiliaryNodesInspected >= maxVisitedNodes) {
          omissions.truncated = true;
          break;
        }
        collect(child, false);
      }
    };
    collect(container, true);
    return textNodes;
  };

  const appendTextGroup = (parent: Element): void => {
    if (stopIfBounded()) return;
    const container = findContainer(parent);
    if (groupedTextContainers.has(container)) return;
    groupedTextContainers.add(container);

    const sourceNodes = collectContainerTextNodes(container);
    const normalized = sourceNodes
      .map((node) => node.textContent ?? '')
      .join('')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!normalized) return;
    if (
      normalized.length > maxTextLength ||
      characterCount + normalized.length > maxCharacters
    ) {
      omissions.truncated = true;
      return;
    }

    const id = `text-${items.length + 1}`;
    items.push({
      id,
      kind: 'text',
      role: textRole(container),
      text: normalized,
    });
    characterCount += normalized.length;
    for (const sourceNode of sourceNodes) textItemIds.set(sourceNode, id);
  };

  const addImage = (image: HTMLImageElement): void => {
    if (stopIfBounded()) return;
    const rawSource = image.currentSrc || image.src;
    if (!safeImageSource(rawSource)) {
      omissions.unsafeImages += 1;
      return;
    }
    if (imageUrlCharacters + rawSource.length > 200_000) {
      omissions.truncated = true;
      return;
    }
    imageUrlCharacters += rawSource.length;

    const altText = normalizeContent(
      image.getAttribute('alt') ||
        image.getAttribute('aria-label') ||
        image.getAttribute('title') ||
        '',
      maxTextLength,
    );
    const id = `image-${items.length + 1}`;
    const item: SnapshotImageItem = {
      id,
      kind: 'image',
      src: rawSource,
    };

    if (altText && characterCount + altText.length <= maxCharacters) {
      item.altText = altText;
      characterCount += altText.length;
    } else if (altText) {
      omissions.truncated = true;
    }
    items.push(item);
    imageItemIds.set(image, id);
  };

  const visit = (node: Node, publicMenuRegion = false): void => {
    if (visitedNodes >= maxVisitedNodes) {
      omissions.truncated = true;
      return;
    }
    visitedNodes += 1;
    if (stopIfBounded()) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const parent = composedParentElement(node);
      if (parent) appendTextGroup(parent);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    const transportedPublicMenuRegion =
      publicMenuRegion || hasPublicMenuRole(element);

    if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') {
      omissions.frames += 1;
      return;
    }

    if (excludedTags.has(element.tagName)) {
      if (controlTags.has(element.tagName)) omissions.controls += 1;
      return;
    }

    if (isPrivateOrInteractive(element)) {
      omissions.controls += 1;
      return;
    }

    if (isHidden(element)) {
      omissions.hidden += 1;
      return;
    }

    if (element instanceof HTMLImageElement) {
      if (!transportedPublicMenuRegion) addImage(element);
      return;
    }

    for (const child of composedChildren(element)) {
      if (visitedNodes >= maxVisitedNodes) {
        omissions.truncated = true;
        break;
      }
      visit(child, transportedPublicMenuRegion);
    }
  };

  visit(document.body);

  const liveRegistry = (
    globalThis as typeof globalThis & {
      __simulLiveMirrorV1?: { idFor(node: Node): string };
    }
  ).__simulLiveMirrorV1;
  const liveNodeId = (node: Node): string | undefined =>
    liveRegistry?.idFor(node);

  const visualStyleProperties = [
    'align-content', 'align-items', 'align-self', 'aspect-ratio',
    'background-attachment', 'background-clip', 'background-color',
    'background-image', 'background-origin', 'background-position',
    'background-repeat', 'background-size', 'border-bottom-color',
    'border-bottom-left-radius', 'border-bottom-right-radius',
    'border-bottom-style', 'border-bottom-width', 'border-collapse',
    'border-left-color', 'border-left-style', 'border-left-width',
    'border-right-color', 'border-right-style', 'border-right-width',
    'border-spacing', 'border-top-color', 'border-top-left-radius',
    'border-top-right-radius', 'border-top-style', 'border-top-width',
    'bottom', 'box-shadow', 'box-sizing', 'break-after', 'break-before',
    'break-inside', 'caption-side', 'clear', 'color', 'column-count',
    'column-fill', 'column-gap', 'column-rule-color', 'column-rule-style',
    'column-rule-width', 'column-width', 'direction', 'display', 'empty-cells',
    'flex-basis', 'flex-direction', 'flex-grow',
    'flex-shrink', 'flex-wrap', 'float', 'font-family', 'font-size',
    'font-style', 'font-weight', 'gap', 'grid-auto-columns',
    'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-row',
    'grid-template-areas', 'grid-template-columns', 'grid-template-rows',
    'height', 'hyphens',
    'justify-content', 'justify-items', 'justify-self', 'left',
    'letter-spacing', 'line-height', 'list-style-position',
    'list-style-type', 'margin-bottom', 'margin-left', 'margin-right',
    'margin-top', 'max-height', 'max-width', 'min-height', 'min-width',
    'object-fit', 'object-position', 'opacity', 'order', 'overflow-wrap',
    'overflow-x', 'overflow-y', 'padding-bottom', 'padding-left',
    'padding-right', 'padding-top', 'position', 'right', 'row-gap',
    'table-layout', 'text-align', 'text-decoration-color',
    'text-decoration-line', 'text-decoration-style',
    'text-decoration-thickness', 'text-indent', 'text-overflow', 'text-shadow',
    'text-transform', 'top', 'transform', 'transform-origin',
    'vertical-align', 'visibility', 'white-space', 'width', 'word-break',
    'word-spacing', 'writing-mode', 'z-index',
  ];
  const safeVisualTags = new Set([
    'address', 'article', 'aside', 'b', 'blockquote', 'br', 'button',
    'caption', 'circle', 'code', 'col', 'colgroup', 'dd', 'details', 'div',
    'dl', 'dt', 'em', 'ellipse', 'figcaption', 'figure', 'footer', 'g',
    'h1', 'h2', 'h3',
    'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img', 'input', 'label', 'li',
    'line', 'main', 'mark', 'nav', 'ol', 'option', 'p', 'path', 'picture',
    'optgroup', 'polygon', 'polyline', 'pre', 'rect', 'section', 'select', 'small',
    'source', 'span', 'strong', 'sub',
    'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'textarea', 'tfoot',
    'th', 'thead', 'tr', 'u', 'ul',
  ]);
  const safeAttributeNames = [
    'colspan', 'cx', 'cy', 'd', 'fill', 'height', 'points',
    'open', 'preserveAspectRatio', 'r', 'rowspan', 'rx', 'ry', 'start', 'stroke',
    'stroke-linecap', 'stroke-linejoin', 'stroke-width', 'transform',
    'viewBox', 'width', 'x', 'x1', 'x2', 'y', 'y1', 'y2',
  ];
  const styles: VisualStyle[] = [];
  const styleIds = new Map<string, number>();
  let visualNodes = 0;
  let visualInspectedNodes = 0;
  let visualCharacters = 0;
  let visualStyleCharacters = 0;
  let visualAttributeCharacters = 0;

  const safeBackgroundImage = (value: string): boolean => {
    if (
      /(?:image-set|cross-fade|element)\s*\(/iu.test(value) ||
      /(?:javascript:|data:(?!image\/(?:avif|gif|jpeg|png|webp);))/iu.test(value)
    ) {
      return false;
    }
    let matchedUrls = 0;
    for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
      matchedUrls += 1;
      const rawUrl = match[1];
      if (!rawUrl) return false;
      try {
        const url = new URL(rawUrl, document.baseURI);
        if (url.protocol === 'http:' || url.protocol === 'https:') continue;
        if (/^data:image\/(?:avif|gif|jpeg|png|webp);/iu.test(rawUrl)) continue;
        return false;
      } catch {
        return false;
      }
    }
    const declaredUrls = value.match(/url\s*\(/giu)?.length ?? 0;
    return matchedUrls === declaredUrls;
  };

  const readStyleValue = (
    computed: CSSStyleDeclaration,
    property: string,
  ): string => {
    if (typeof computed.getPropertyValue === 'function') {
      return computed.getPropertyValue(property).trim();
    }
    const camel = property.replace(/-([a-z])/gu, (_match, letter: string) =>
      letter.toUpperCase(),
    );
    const value = (computed as unknown as Record<string, unknown>)[camel];
    return typeof value === 'string' ? value.trim() : '';
  };

  const internStyle = (
    element: Element,
    options: { omitBackgroundImage?: boolean } = {},
  ): number => {
    const computed = window.getComputedStyle(element);
    const captured: Record<string, string> = {};
    for (const property of visualStyleProperties) {
      // Select-entry transport is intentionally limited to inert presentation
      // and typed labels/state. Do not let an option/optgroup smuggle a
      // resource-bearing URL into that narrow channel.
      if (options.omitBackgroundImage && property === 'background-image') {
        continue;
      }
      const value = readStyleValue(computed, property);
      if (!value || value.length > 500) continue;
      if (property === 'background-image' && !safeBackgroundImage(value)) {
        omissions.unsafeImages += 1;
        continue;
      }
      captured[property] = value;
    }
    const key = JSON.stringify(captured);
    const existing = styleIds.get(key);
    if (existing !== undefined) return existing;
    const capturedCharacters = Object.entries(captured).reduce(
      (total, [property, value]) => total + property.length + value.length,
      0,
    );
    if (visualStyleCharacters + capturedCharacters > 2_000_000) {
      omissions.truncated = true;
      return 0;
    }
    if (styles.length >= 2_000) {
      omissions.truncated = true;
      return 0;
    }
    const id = styles.length;
    styles.push(captured);
    styleIds.set(key, id);
    visualStyleCharacters += capturedCharacters;
    return id;
  };

  const hasActivationSemantics = (element: Element): boolean =>
    element.tagName === 'BUTTON' ||
    roleKind(element) === 'activation';

  const selectMustStayPrivate = (element: Element): boolean => {
    if (
      hasPrivateContentEditableState(element) ||
      roleKind(element) === 'private' ||
      hasActivationSemantics(element)
    ) {
      return true;
    }

    // A select nested in an activation surface contributes to that control's
    // private interaction state. Keep its labels out of the visual protocol.
    let current = composedParentElement(element);
    for (let depth = 0; current; depth += 1) {
      if (depth >= 80) {
        omissions.truncated = true;
        return true;
      }
      if (hasActivationSemantics(current)) return true;
      current = composedParentElement(current);
    }
    return false;
  };

  const controlShell = (element: Element): VisualControlShell | undefined => {
    switch (element.tagName) {
      case 'INPUT':
        return 'input';
      case 'TEXTAREA':
        return 'textarea';
      case 'SELECT':
        return selectMustStayPrivate(element) ? 'input' : 'select';
      case 'BUTTON':
        return 'button';
      case 'DATALIST':
      case 'OPTION':
      case 'OPTGROUP':
      case 'OUTPUT':
        return 'input';
      default:
        if (hasPrivateContentEditableState(element)) return 'input';
        if (roleKind(element) === 'private') return 'input';
        return roleKind(element) === 'activation'
          ? 'button'
          : undefined;
    }
  };

  const placeholderLabel = (element: Element): string | undefined => {
    switch (element.tagName) {
      case 'IFRAME':
      case 'FRAME':
        return 'Embedded frame omitted';
      case 'CANVAS':
        return 'Canvas content omitted';
      case 'VIDEO':
        return 'Video content omitted';
      case 'AUDIO':
        return 'Audio content omitted';
      default:
        return undefined;
    }
  };

  const visualTag = (element: Element): string => {
    const candidate = element.tagName.toLowerCase();
    if (safeVisualTags.has(candidate)) return candidate;
    const display = readStyleValue(window.getComputedStyle(element), 'display');
    return display.startsWith('inline') ? 'span' : 'div';
  };

  const visualAttributes = (
    element: Element,
    tag: string,
    omitResources = false,
  ): Record<string, string> | undefined => {
    const attributes: Record<string, string> = {};
    const addAttribute = (name: string, value: string): void => {
      const characters = name.length + value.length;
      if (visualAttributeCharacters + characters > 500_000) {
        omissions.truncated = true;
        return;
      }
      attributes[name] = value;
      visualAttributeCharacters += characters;
    };
    if (!omitResources && tag === 'img' && element instanceof HTMLImageElement) {
      const source = element.currentSrc || element.src;
      if (safeImageSource(source)) addAttribute('src', source);
      const alt = normalize(element.getAttribute('alt') ?? '', 500);
      if (alt) addAttribute('alt', alt);
    }
    for (const name of safeAttributeNames) {
      if (name === 'open') {
        if (tag === 'details' && element.hasAttribute('open')) {
          addAttribute('open', '');
        }
        continue;
      }
      const value = element.getAttribute(name);
      if (
        value &&
        value.length <= 2_048 &&
        (
          !omitResources ||
          !/(?:url\s*\(|https?:|data:|blob:)/iu.test(value)
        )
      ) addAttribute(name, value);
    }
    return Object.keys(attributes).length > 0 ? attributes : undefined;
  };

  const containsVisualText = (nodes: VisualNode[]): boolean =>
    nodes.some((node) =>
      node.kind === 'text'
        ? node.text.trim().length > 0
        : node.kind === 'element' && containsVisualText(node.children),
    );

  const publicControlLabel = (element: Element): string =>
    (element.getAttribute('aria-label') || element.getAttribute('title') || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 2_048);

  const currentBooleanProperty = (
    element: Element,
    property: 'disabled' | 'multiple' | 'selected',
  ): boolean => {
    const value = (element as unknown as Record<string, unknown>)[property];
    return typeof value === 'boolean'
      ? value
      : element.hasAttribute(property);
  };

  const normalizeSelectEntryLabel = (source: string): string => {
    const bounded = source.slice(0, maxTextLength + 1);
    const normalized = bounded.replace(/\s+/gu, ' ').trim();
    if (source.length > maxTextLength || normalized.length > maxTextLength) {
      omissions.truncated = true;
    }
    return normalized.slice(0, maxTextLength);
  };

  const selectElementIsHidden = (element: Element): boolean => {
    if (element.hasAttribute('hidden')) return true;
    try {
      const style = window.getComputedStyle(element);
      return style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        style.opacity === '0' ||
        style.getPropertyValue('content-visibility').trim() === 'hidden';
    } catch {
      return true;
    }
  };

  const directOptgroupLegend = (element: Element): Element | undefined => {
    let inspected = 0;
    for (let child = element.firstElementChild; child; child = child.nextElementSibling) {
      inspected += 1;
      if (inspected > 512) {
        omissions.truncated = true;
        return undefined;
      }
      if (child.tagName === 'LEGEND') return child;
    }
    return undefined;
  };

  const selectEntryLabel = (element: Element): string => {
    const rawAttributeLabel = element.getAttribute('label');
    const hasAuthoritativeAttributeLabel = rawAttributeLabel !== null &&
      rawAttributeLabel !== '';
    const attributeLabel = rawAttributeLabel?.trim() ?? '';
    const legend = element.tagName === 'OPTGROUP'
      ? directOptgroupLegend(element)
      : undefined;
    if (!legend && hasAuthoritativeAttributeLabel) {
      return normalizeSelectEntryLabel(attributeLabel);
    }
    if (element.tagName === 'OPTGROUP' && !legend) return '';
    const textRoot = legend ?? element;

    // Avoid an unbounded textContent read for rich customizable options. The
    // preceding privacy walk has already failed closed on excessive element
    // descendants; this walk independently bounds text-node fanout and bytes.
    let source = '';
    let inspected = 0;
    let current: Node | null = textRoot.firstChild;
    while (current) {
      inspected += 1;
      if (inspected > 1_024) {
        omissions.truncated = true;
        break;
      }
      if (
        current.nodeType === Node.ELEMENT_NODE &&
        selectElementIsHidden(current as Element)
      ) {
        while (current && current !== textRoot && !current.nextSibling) {
          current = current.parentNode;
        }
        if (!current || current === textRoot) break;
        current = current.nextSibling;
        continue;
      }
      if (current.nodeType === Node.TEXT_NODE) {
        const value = current.textContent ?? '';
        const remaining = Math.max(0, maxTextLength + 1 - source.length);
        source += value.slice(0, remaining);
        if (value.length > remaining || source.length > maxTextLength) {
          omissions.truncated = true;
          break;
        }
      }
      if (current.firstChild) {
        current = current.firstChild;
        continue;
      }
      while (current && current !== textRoot && !current.nextSibling) {
        current = current.parentNode;
      }
      if (!current || current === textRoot) break;
      current = current.nextSibling;
    }
    return normalizeSelectEntryLabel(source);
  };

  const selectElementHasPrivateState = (candidate: Element): boolean => {
      return hasPrivateContentEditableState(candidate) ||
        ['private', 'activation'].includes(roleKind(candidate) ?? '') ||
        [
          'BUTTON',
          'DATALIST',
          'EMBED',
          'FORM',
          'FRAME',
          'IFRAME',
          'INPUT',
          'NOSCRIPT',
          'OBJECT',
          'OUTPUT',
          'PORTAL',
          'SCRIPT',
          'SELECT',
          'STYLE',
          'TEMPLATE',
          'TEXTAREA',
          'WEBVIEW',
        ]
          .includes(candidate.tagName);
  };

  const selectEntryIsPrivate = (element: Element): boolean => {
    if (selectElementIsHidden(element)) return true;
    if (selectElementHasPrivateState(element)) return true;
    const privacyRoot = element.tagName === 'OPTION'
      ? element
      : element.tagName === 'OPTGROUP'
        ? directOptgroupLegend(element)
        : undefined;
    if (!privacyRoot) return false;
    if (
      privacyRoot !== element &&
      (selectElementIsHidden(privacyRoot) ||
        selectElementHasPrivateState(privacyRoot))
    ) return true;

    // Customizable selects may contain rich option descendants. Inspect a
    // fixed amount without materializing an attacker-sized NodeList; overflow
    // fails closed so an uninspected editor cannot leak through textContent.
    let inspected = 0;
    let current: Element | null = privacyRoot.firstElementChild;
    while (current) {
      inspected += 1;
      if (inspected > 512) {
        omissions.truncated = true;
        return true;
      }
      if (selectElementIsHidden(current)) {
        while (
          current && current !== privacyRoot && !current.nextElementSibling
        ) current = current.parentElement;
        if (!current || current === privacyRoot) break;
        current = current.nextElementSibling;
        continue;
      }
      if (selectElementHasPrivateState(current)) return true;
      if (current.firstElementChild) {
        current = current.firstElementChild;
        continue;
      }
      while (
        current && current !== privacyRoot && !current.nextElementSibling
      ) {
        current = current.parentElement;
      }
      if (!current || current === privacyRoot) break;
      current = current.nextElementSibling;
    }
    return false;
  };

  const selectPickerIsOpen = (element: Element): boolean => {
    try {
      return element.matches(':open');
    } catch {
      return false;
    }
  };

  const buildSelectLabelNode = (label: string): VisualTextNode | undefined => {
    if (!label) return undefined;
    if (visualNodes >= 10_000) {
      omissions.truncated = true;
      return undefined;
    }
    const remaining = Math.max(0, 300_000 - visualCharacters);
    if (remaining === 0) {
      omissions.truncated = true;
      return undefined;
    }
    const text = label.slice(0, remaining);
    if (text.length < label.length) omissions.truncated = true;
    visualCharacters += text.length;
    visualNodes += 1;
    return { kind: 'text', text };
  };

  const buildNativeSelectEntry = (
    element: Element,
    depth: number,
  ): VisualElementNode | undefined => {
    if (
      visualInspectedNodes >= 50_000 ||
      visualNodes >= 10_000 ||
      depth > 80 ||
      (element.tagName !== 'OPTION' && element.tagName !== 'OPTGROUP')
    ) {
      omissions.truncated = true;
      return undefined;
    }
    if (selectElementIsHidden(element)) return undefined;
    visualInspectedNodes += 1;
    visualNodes += 1;
    const nodeId = liveNodeId(element);
    const children: VisualNode[] = [];
    const privateEntry = selectEntryIsPrivate(element);
    const label = privateEntry
      ? undefined
      : buildSelectLabelNode(selectEntryLabel(element));
    if (label) children.push(label);

    if (element.tagName === 'OPTGROUP') {
      if (selectElementHasPrivateState(element)) {
        return {
          kind: 'element',
          tag: 'optgroup',
          styleId: internStyle(element, { omitBackgroundImage: true }),
          optgroupState: { disabled: true },
          ...(nodeId ? { nodeId } : {}),
          children,
        };
      }
      for (
        let child = element.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        if (visualInspectedNodes >= 50_000) {
          omissions.truncated = true;
          break;
        }
        visualInspectedNodes += 1;
        if (child.tagName !== 'OPTION') continue;
        const option = buildNativeSelectEntry(child, depth + 1);
        if (option) children.push(option);
        if (visualInspectedNodes >= 50_000 || visualNodes >= 10_000) {
          omissions.truncated = true;
          break;
        }
      }
      return {
        kind: 'element',
        tag: 'optgroup',
        styleId: internStyle(element, { omitBackgroundImage: true }),
        optgroupState: {
          disabled: currentBooleanProperty(element, 'disabled'),
        },
        ...(nodeId ? { nodeId } : {}),
        children,
      };
    }

    return {
      kind: 'element',
      tag: 'option',
      styleId: internStyle(element, { omitBackgroundImage: true }),
      optionState: {
        disabled: currentBooleanProperty(element, 'disabled'),
        selected: !privateEntry && currentBooleanProperty(element, 'selected'),
      },
      ...(nodeId ? { nodeId } : {}),
      children,
    };
  };

  const buildVisualNode = (
    node: Node,
    depth: number,
    publicMenuRegion = false,
  ): VisualNode | undefined => {
    if (
      visualInspectedNodes >= 50_000 ||
      visualNodes >= 10_000 ||
      depth > 80
    ) {
      omissions.truncated = true;
      return undefined;
    }
    visualInspectedNodes += 1;

    if (node.nodeType === Node.TEXT_NODE) {
      const rawText = node.textContent ?? '';
      if (!rawText) return undefined;
      const remaining = Math.max(0, 300_000 - visualCharacters);
      if (remaining === 0) {
        omissions.truncated = true;
        return undefined;
      }
      const text = rawText.slice(0, remaining);
      if (text.length < rawText.length) omissions.truncated = true;
      visualCharacters += text.length;
      visualNodes += 1;
      const itemId = textItemIds.get(node);
      const nodeId = liveNodeId(node);
      return {
        kind: 'text',
        text,
        ...(itemId ? { itemId } : {}),
        ...(nodeId ? { nodeId } : {}),
      };
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return undefined;
    const element = node as Element;
    const transportedPublicMenuRegion =
      publicMenuRegion || hasPublicMenuRole(element);
    if (
      [
        'BASE',
        'EMBED',
        'HEAD',
        'LINK',
        'META',
        'NOSCRIPT',
        'OBJECT',
        'SCRIPT',
        'STYLE',
        'TEMPLATE',
        'TITLE',
      ].includes(element.tagName)
    ) {
      return undefined;
    }
    if (
      transportedPublicMenuRegion &&
      ['AUDIO', 'CANVAS', 'IMG', 'PICTURE', 'SOURCE', 'VIDEO']
        .includes(element.tagName)
    ) {
      return undefined;
    }
    if (isHidden(element)) return undefined;

    const shell = controlShell(element);
    const styleId = internStyle(element, {
      // Native-select transport is labels plus presentation state only. A
      // computed resource URL must not hitchhike on the companion facsimile.
      omitBackgroundImage: shell === 'select' || transportedPublicMenuRegion,
    });
    const placeholder = placeholderLabel(element);
    const nodeId = liveNodeId(element);
    visualNodes += 1;
    if (placeholder) {
      return {
        kind: 'placeholder',
        styleId,
        label: placeholder,
        ...(nodeId ? { nodeId } : {}),
      };
    }

    // The untrusted parser requires a raw select tag and select shell to imply
    // each other. A private native select therefore travels as a generic inert
    // shell, never as a native select with a different control classification.
    const tag = ['SELECT', 'OPTION', 'OPTGROUP'].includes(element.tagName) &&
      shell !== 'select'
      ? readStyleValue(window.getComputedStyle(element), 'display')
          .startsWith('inline')
        ? 'span'
        : 'div'
      : visualTag(element);
    const itemId = transportedPublicMenuRegion
      ? undefined
      : imageItemIds.get(element);
    const children: VisualNode[] = [];
    if (shell === 'select') {
      for (
        let child = element.firstElementChild;
        child;
        child = child.nextElementSibling
      ) {
        if (visualInspectedNodes >= 50_000) {
          omissions.truncated = true;
          break;
        }
        visualInspectedNodes += 1;
        if (!['OPTION', 'OPTGROUP'].includes(child.tagName)) continue;
        const selectEntry = buildNativeSelectEntry(child, depth + 1);
        if (selectEntry) children.push(selectEntry);
        if (visualInspectedNodes >= 50_000 || visualNodes >= 10_000) {
          omissions.truncated = true;
          break;
        }
      }
    } else if (!shell || shell === 'button') {
      for (const child of composedChildren(element)) {
        if (visualInspectedNodes >= 50_000 || visualNodes >= 10_000) {
          omissions.truncated = true;
          break;
        }
        const visualChild = buildVisualNode(
          child,
          depth + 1,
          transportedPublicMenuRegion,
        );
        if (visualChild) children.push(visualChild);
      }
      if (shell === 'button' && !containsVisualText(children)) {
        const label = publicControlLabel(element);
        if (label) {
          if (
            visualNodes >= 10_000 ||
            visualCharacters + label.length > 300_000
          ) {
            omissions.truncated = true;
          } else {
            visualNodes += 1;
            visualCharacters += label.length;
            children.push({
              kind: 'text',
              text: label,
              ...(nodeId ? { nodeId } : {}),
            });
          }
        }
      }
    }
    return {
      kind: 'element',
      tag,
      styleId,
      ...(itemId ? { itemId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(shell ? { controlShell: shell } : {}),
      ...(shell === 'select'
        ? {
            selectState: {
              disabled: currentBooleanProperty(element, 'disabled'),
              multiple: currentBooleanProperty(element, 'multiple'),
              open: selectPickerIsOpen(element),
            },
          }
        : {}),
      ...(!shell
        ? {
            attributes: visualAttributes(
              element,
              tag,
              transportedPublicMenuRegion,
            ),
          }
        : {}),
      children,
    };
  };

  const builtRoot = buildVisualNode(document.documentElement, 0);
  const root: VisualElementNode =
    builtRoot?.kind === 'element'
      ? builtRoot
      : { kind: 'element', tag: 'div', styleId: 0, children: [] };
  if (styles.length === 0) styles.push({});
  const boundedDimension = (value: number, fallback: number): number =>
    Math.min(100_000, Math.max(1, Number.isFinite(value) ? value : fallback));
  const viewportWidth = boundedDimension(window.innerWidth, 1_024);
  const viewportHeight = boundedDimension(window.innerHeight, 768);
  const documentWidth = boundedDimension(
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    viewportWidth,
  );
  const documentHeight = boundedDimension(
    Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
    viewportHeight,
  );

  const pageUrl = (() => {
    try {
      const url = new URL(window.location.href);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().slice(0, 2_048);
    } catch {
      return window.location.origin;
    }
  })();
  const documentLanguage = normalize(document.documentElement.lang, 35);

  return {
    version,
    title: normalize(document.title, maxTitleLength) || 'Untitled page',
    url: pageUrl,
    ...(documentLanguage ? { documentLanguage } : {}),
    capturedAt: new Date().toISOString(),
    items,
    omissions,
    visual: {
      viewportWidth,
      viewportHeight,
      documentWidth,
      documentHeight,
      styles,
      root,
    },
  };
}

function rememberItemId(
  itemIds: Map<string, string>,
  rawId: unknown,
  normalizedId: string,
): void {
  itemIds.set(normalizedId, normalizedId);
  if (
    typeof rawId === 'string' &&
    rawId.length > 0 &&
    rawId.length <= 100 &&
    !itemIds.has(rawId)
  ) {
    itemIds.set(rawId, normalizedId);
  }
}

function parseVisualPage(
  input: unknown,
  itemIds: ReadonlyMap<string, string>,
): VisualPage | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new InvalidPageSnapshotError();

  const rawStyles = Array.isArray(input.styles) ? input.styles : [];
  if (
    rawStyles.length === 0 ||
    rawStyles.length > SNAPSHOT_LIMITS.maxVisualStyles
  ) {
    throw new InvalidPageSnapshotError();
  }
  const styleBudget = { characters: 0 };
  const attributeBudget = { characters: 0 };
  const styles = rawStyles.map((style) =>
    parseVisualStyle(style, styleBudget),
  );
  let nodeCount = 0;
  let characterCount = 0;
  type ParseContext = 'normal' | 'select' | 'optgroup' | 'option';

  const parseNode = (
    rawNode: unknown,
    depth: number,
    context: ParseContext = 'normal',
  ): VisualNode | undefined => {
    if (
      !isRecord(rawNode) ||
      depth > SNAPSHOT_LIMITS.maxVisualDepth ||
      nodeCount >= SNAPSHOT_LIMITS.maxVisualNodes
    ) {
      return undefined;
    }
    nodeCount += 1;

    if (rawNode.kind === 'text') {
      if (typeof rawNode.text !== 'string' || context === 'select') {
        return undefined;
      }
      const remaining = Math.max(
        0,
        SNAPSHOT_LIMITS.maxVisualTextCharacters - characterCount,
      );
      if (remaining === 0) return undefined;
      const text = rawNode.text.slice(0, remaining);
      characterCount += text.length;
      const itemId = readVisualItemId(rawNode.itemId, itemIds);
      const nodeId = readVisualNodeId(rawNode.nodeId);
      return {
        kind: 'text',
        text,
        ...(itemId ? { itemId } : {}),
        ...(nodeId ? { nodeId } : {}),
      };
    }

    const styleId = readStyleId(rawNode.styleId, styles.length);
    if (styleId === undefined) return undefined;
    if (rawNode.kind === 'placeholder') {
      if (context !== 'normal') return undefined;
      const labels = new Set([
        'Audio content omitted',
        'Canvas content omitted',
        'Embedded frame omitted',
        'Video content omitted',
      ]);
      const label =
        typeof rawNode.label === 'string' && labels.has(rawNode.label)
          ? rawNode.label
          : 'Unsupported content omitted';
      const nodeId = readVisualNodeId(rawNode.nodeId);
      return {
        kind: 'placeholder',
        styleId,
        label,
        ...(nodeId ? { nodeId } : {}),
      };
    }

    if (
      rawNode.kind !== 'element' ||
      typeof rawNode.tag !== 'string' ||
      !SAFE_VISUAL_TAGS.has(rawNode.tag)
    ) {
      return undefined;
    }
    const isOption = rawNode.tag === 'option';
    const isOptgroup = rawNode.tag === 'optgroup';
    if (
      (context === 'normal' && (isOption || isOptgroup)) ||
      (context === 'select' && !isOption && !isOptgroup) ||
      (context === 'optgroup' && !isOption) ||
      context === 'option'
    ) {
      return undefined;
    }
    const controlShell = readControlShell(rawNode.controlShell);
    if (
      (rawNode.controlShell !== undefined && !controlShell) ||
      ((isOption || isOptgroup) && controlShell !== undefined) ||
      (controlShell === 'select' && rawNode.tag !== 'select') ||
      (rawNode.tag === 'select' && controlShell !== 'select')
    ) {
      return undefined;
    }
    const children: VisualNode[] = [];
    const childContext: ParseContext | undefined = controlShell === 'select'
      ? 'select'
      : isOptgroup
        ? 'optgroup'
        : isOption
          ? 'option'
          : !controlShell || controlShell === 'button'
            ? 'normal'
            : undefined;
    if (childContext && Array.isArray(rawNode.children)) {
      for (const rawChild of rawNode.children) {
        const child = parseNode(rawChild, depth + 1, childContext);
        if (!child) {
          if (controlShell === 'select' || isOption || isOptgroup) {
            return undefined;
          }
        } else {
          children.push(child);
        }
        if (nodeCount >= SNAPSHOT_LIMITS.maxVisualNodes) break;
      }
    }
    const attributes = controlShell || isOption || isOptgroup
      ? undefined
      : parseVisualAttributes(
          rawNode.attributes,
          rawNode.tag,
          attributeBudget,
        );
    const selectState = controlShell === 'select'
      ? readVisualSelectState(rawNode.selectState)
      : undefined;
    const optionState = isOption
      ? readVisualOptionState(rawNode.optionState)
      : undefined;
    const optgroupState = isOptgroup
      ? readVisualOptgroupState(rawNode.optgroupState)
      : undefined;
    if (
      (controlShell === 'select' && !selectState) ||
      (isOption && !optionState) ||
      (isOptgroup && !optgroupState) ||
      (!Array.isArray(rawNode.children) &&
        (controlShell === 'select' || isOption || isOptgroup))
    ) return undefined;
    if (
      isOption && children.filter((child) => child.kind === 'text').length > 1
    ) return undefined;
    if (isOptgroup) {
      const labelIndexes = children
        .map((child, index) => child.kind === 'text' ? index : -1)
        .filter((index) => index >= 0);
      if (labelIndexes.length > 1 || labelIndexes.some((index) => index !== 0)) {
        return undefined;
      }
    }
    if (
      selectState &&
      !selectState.multiple &&
      countSelectedVisualOptions(children) > 1
    ) {
      return undefined;
    }
    const itemId = readVisualItemId(rawNode.itemId, itemIds);
    const nodeId = readVisualNodeId(rawNode.nodeId);
    return {
      kind: 'element',
      tag: rawNode.tag,
      styleId,
      ...(itemId ? { itemId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(controlShell ? { controlShell } : {}),
      ...(selectState ? { selectState } : {}),
      ...(optionState ? { optionState } : {}),
      ...(optgroupState ? { optgroupState } : {}),
      ...(attributes ? { attributes } : {}),
      children,
    };
  };

  const root = parseNode(input.root, 0);
  if (!root || root.kind !== 'element') {
    throw new InvalidPageSnapshotError();
  }
  return {
    viewportWidth: readVisualDimension(input.viewportWidth),
    viewportHeight: readVisualDimension(input.viewportHeight),
    documentWidth: readVisualDimension(input.documentWidth),
    documentHeight: readVisualDimension(input.documentHeight),
    styles,
    root,
  };
}

function countSelectedVisualOptions(nodes: readonly VisualNode[]): number {
  let selected = 0;
  for (const node of nodes) {
    if (node.kind !== 'element') continue;
    if (node.tag === 'option') {
      if (node.optionState?.selected) selected += 1;
    } else if (node.tag === 'optgroup') {
      selected += countSelectedVisualOptions(node.children);
    }
    if (selected > 1) return selected;
  }
  return selected;
}

function parseVisualStyle(
  input: unknown,
  budget: { characters: number },
): VisualStyle {
  if (!isRecord(input)) throw new InvalidPageSnapshotError();
  const style: VisualStyle = {};
  for (const [property, rawValue] of Object.entries(input)) {
    if (!VISUAL_STYLE_PROPERTY_SET.has(property)) continue;
    if (
      typeof rawValue !== 'string' ||
      rawValue.length === 0 ||
      rawValue.length > SNAPSHOT_LIMITS.maxVisualValueLength
    ) {
      continue;
    }
    if (
      property === 'background-image' &&
      !isSafeVisualBackgroundImage(rawValue)
    ) {
      continue;
    }
    const characters = property.length + rawValue.length;
    if (
      budget.characters + characters >
      SNAPSHOT_LIMITS.maxVisualStyleCharacters
    ) {
      continue;
    }
    style[property as VisualStyleProperty] = rawValue;
    budget.characters += characters;
  }
  return style;
}

function parseVisualAttributes(
  input: unknown,
  tag: string,
  budget: { characters: number },
): Record<string, string> | undefined {
  if (!isRecord(input)) return undefined;
  const attributes: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(input)) {
    if (!SAFE_VISUAL_ATTRIBUTES.has(name) || typeof rawValue !== 'string') {
      continue;
    }
    if (name === 'open') {
      if (
        tag === 'details' &&
        rawValue === '' &&
        budget.characters + name.length <=
          SNAPSHOT_LIMITS.maxVisualAttributeCharacters
      ) {
        attributes.open = '';
        budget.characters += name.length;
      }
      continue;
    }
    if (
      rawValue.length === 0 ||
      rawValue.length > SNAPSHOT_LIMITS.maxVisualAttributeLength
    ) {
      continue;
    }
    if (name === 'src') {
      if (tag !== 'img' || !isSafeImageSource(rawValue)) continue;
    }
    if (name === 'alt' && tag !== 'img') continue;
    if (
      (name === 'fill' || name === 'stroke') &&
      /(?:url\s*\(|javascript:|data:)/iu.test(rawValue)
    ) {
      continue;
    }
    const characters = name.length + rawValue.length;
    if (
      budget.characters + characters >
      SNAPSHOT_LIMITS.maxVisualAttributeCharacters
    ) {
      continue;
    }
    attributes[name] = rawValue;
    budget.characters += characters;
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined;
}

function isSafeVisualBackgroundImage(value: string): boolean {
  if (
    /(?:image-set|cross-fade|element)\s*\(/iu.test(value) ||
    /(?:javascript:|data:(?!image\/(?:avif|gif|jpeg|png|webp);))/iu.test(value)
  ) {
    return false;
  }
  let matchedUrls = 0;
  for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/giu)) {
    matchedUrls += 1;
    const rawUrl = match[1];
    if (!rawUrl) return false;
    try {
      const url = new URL(rawUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') continue;
      if (/^data:image\/(?:avif|gif|jpeg|png|webp);/iu.test(rawUrl)) continue;
      return false;
    } catch {
      return false;
    }
  }
  const declaredUrls = value.match(/url\s*\(/giu)?.length ?? 0;
  return matchedUrls === declaredUrls;
}

function readStyleId(value: unknown, styleCount: number): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < styleCount
    ? value
    : undefined;
}

function readControlShell(value: unknown): VisualControlShell | undefined {
  return value === 'button' ||
    value === 'input' ||
    value === 'select' ||
    value === 'textarea'
    ? value
    : undefined;
}

function readVisualSelectState(value: unknown): VisualSelectState | undefined {
  if (
    !isRecord(value) ||
    typeof value.disabled !== 'boolean' ||
    typeof value.multiple !== 'boolean' ||
    typeof value.open !== 'boolean'
  ) return undefined;
  return {
    disabled: value.disabled,
    multiple: value.multiple,
    open: value.open,
  };
}

function readVisualOptionState(value: unknown): VisualOptionState | undefined {
  if (
    !isRecord(value) ||
    typeof value.disabled !== 'boolean' ||
    typeof value.selected !== 'boolean'
  ) return undefined;
  return { disabled: value.disabled, selected: value.selected };
}

function readVisualOptgroupState(value: unknown): VisualOptgroupState | undefined {
  if (!isRecord(value) || typeof value.disabled !== 'boolean') return undefined;
  return { disabled: value.disabled };
}

function readVisualItemId(
  value: unknown,
  itemIds: ReadonlyMap<string, string>,
): string | undefined {
  return typeof value === 'string' ? itemIds.get(value) : undefined;
}

function readVisualNodeId(value: unknown): string | undefined {
  return typeof value === 'string' && /^n[1-9]\d{0,8}$/u.test(value)
    ? value
    : undefined;
}

function readVisualDimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidPageSnapshotError();
  }
  return Math.min(
    SNAPSHOT_LIMITS.maxDocumentDimension,
    Math.max(1, Math.round(value)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(value: unknown, limit: number): string {
  return typeof value === 'string' ? normalizeVisibleText(value, limit) : '';
}

function isTextOverLimit(value: unknown, limit: number): boolean {
  return (
    typeof value === 'string' &&
    value.replace(/\s+/gu, ' ').trim().length > Math.max(0, limit)
  );
}

function readRole(value: unknown): SnapshotTextRole | undefined {
  return typeof value === 'string' && TEXT_ROLES.has(value as SnapshotTextRole)
    ? (value as SnapshotTextRole)
    : undefined;
}

function readHttpPageUrl(value: unknown): string {
  if (typeof value !== 'string') throw new InvalidPageSnapshotError();

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new InvalidPageSnapshotError();
    }
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().slice(0, 2_048);
  } catch (error) {
    if (error instanceof InvalidPageSnapshotError) throw error;
    throw new InvalidPageSnapshotError();
  }
}

function readIsoDate(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    return new Date(0).toISOString();
  }
  return new Date(value).toISOString();
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1_000_000, Math.max(0, Math.trunc(value)))
    : 0;
}
