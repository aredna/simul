export const SNAPSHOT_VERSION = 1 as const;

export const SNAPSHOT_LIMITS = {
  maxItems: 350,
  maxCharacters: 60_000,
  maxTextLength: 3_500,
  maxVisitedNodes: 20_000,
  maxTitleLength: 300,
  maxUrlLength: 100_000,
} as const;

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
  let characterCount = 0;
  let boundaryTruncated = false;

  for (const rawItem of rawItems.slice(0, SNAPSHOT_LIMITS.maxItems)) {
    if (!isRecord(rawItem) || typeof rawItem.kind !== 'string') {
      continue;
    }

    if (rawItem.kind === 'text') {
      boundaryTruncated ||= isTextOverLimit(
        rawItem.text,
        SNAPSHOT_LIMITS.maxTextLength,
      );
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
      items.push({
        id: `text-${items.length + 1}`,
        kind: 'text',
        role,
        text,
      });
      continue;
    }

    if (rawItem.kind === 'image' && typeof rawItem.src === 'string') {
      if (!isSafeImageSource(rawItem.src)) {
        continue;
      }

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
      const image: SnapshotImageItem = {
        id: `image-${items.length + 1}`,
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
    }
  }

  const rawOmissions = isRecord(input.omissions) ? input.omissions : {};
  const title = readText(input.title, SNAPSHOT_LIMITS.maxTitleLength);
  const url = readHttpPageUrl(input.url);
  const documentLanguage = readText(input.documentLanguage, 35);
  const capturedAt = readIsoDate(input.capturedAt);

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
  };
}

/**
 * Runs inside the active page through chrome.scripting.executeScript. Keep all
 * runtime helpers nested: Chrome serializes this function rather than its
 * module closure.
 */
export function capturePageSnapshot(): PageSnapshot {
  const version = 1 as const;
  const maxItems = 350;
  const maxCharacters = 60_000;
  const maxTextLength = 3_500;
  const maxVisitedNodes = 20_000;
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
  let visitedNodes = 0;
  let lastTextContainer: Element | null = null;
  let lastRawText = '';
  const assignedCaptions = new WeakSet<Element>();

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
    'BUTTON',
    'DATALIST',
    'OUTPUT',
  ]);
  const controlTags = new Set([
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
    'BUTTON',
    'DATALIST',
    'OUTPUT',
  ]);
  const interactiveRoles = new Set([
    'button',
    'checkbox',
    'combobox',
    'listbox',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'radio',
    'searchbox',
    'slider',
    'spinbutton',
    'switch',
    'tab',
    'textbox',
    'treeitem',
  ]);
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
    if (
      element.hasAttribute('hidden') ||
      element.getAttribute('aria-hidden') === 'true'
    ) {
      return true;
    }

    const htmlElement = element as HTMLElement;
    if (htmlElement.inert) return true;

    const style = window.getComputedStyle(element);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    ) {
      return true;
    }

    return style.display !== 'contents' && element.getClientRects().length === 0;
  };

  const isPrivateOrInteractive = (element: Element): boolean => {
    const role = element
      .getAttribute('role')
      ?.trim()
      .toLowerCase()
      .split(/\s+/u)[0];
    return (
      excludedTags.has(element.tagName) ||
      element.hasAttribute('contenteditable') ||
      (role !== undefined && interactiveRoles.has(role))
    );
  };

  const extractEligibleText = (root: Element): string => {
    const parts: string[] = [];
    let inspected = 0;

    const collect = (node: Node): void => {
      if (inspected >= maxVisitedNodes) {
        omissions.truncated = true;
        return;
      }
      inspected += 1;

      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent ?? '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const element = node as Element;
      if (
        isPrivateOrInteractive(element) ||
        element.tagName === 'IFRAME' ||
        element.tagName === 'FRAME' ||
        isHidden(element)
      ) {
        return;
      }
      for (const child of element.childNodes) collect(child);
    };

    collect(root);
    return normalizeContent(parts.join(''), maxTextLength);
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
      current = current.parentElement;
    }
    return document.body;
  };

  const stopIfBounded = (): boolean => {
    const atLimit =
      items.length >= maxItems || characterCount >= maxCharacters;
    if (atLimit) omissions.truncated = true;
    return atLimit;
  };

  const appendText = (rawText: string, parent: Element): void => {
    if (stopIfBounded()) return;
    const normalized = normalizeContent(rawText, maxTextLength);
    if (!normalized) return;

    const container = findContainer(parent);
    const previous = items.at(-1);
    if (
      container === lastTextContainer &&
      previous?.kind === 'text' &&
      previous.text.length < maxTextLength
    ) {
      const separator = /\s$/u.test(lastRawText) || /^\s/u.test(rawText) ? ' ' : '';
      const available = Math.min(
        maxTextLength - previous.text.length,
        maxCharacters - characterCount,
      );
      const addition = `${separator}${normalized}`.slice(0, available);
      previous.text += addition;
      characterCount += addition.length;
      lastRawText = rawText;
      if (addition.length < separator.length + normalized.length) {
        omissions.truncated = true;
      }
      return;
    }

    const text = normalized.slice(0, maxCharacters - characterCount);
    if (!text) {
      omissions.truncated = true;
      return;
    }

    items.push({
      id: `text-${items.length + 1}`,
      kind: 'text',
      role: textRole(container),
      text,
    });
    characterCount += text.length;
    lastTextContainer = container;
    lastRawText = rawText;
  };

  const addImage = (image: HTMLImageElement): void => {
    if (stopIfBounded()) return;
    const rawSource = image.currentSrc || image.src;
    if (!safeImageSource(rawSource)) {
      omissions.unsafeImages += 1;
      lastTextContainer = null;
      return;
    }

    const figure = image.closest('figure');
    const captionElement = figure
      ? [...figure.children].find((child) => child.tagName === 'FIGCAPTION') ??
        null
      : null;
    const captionOwner = figure
      ? [...figure.querySelectorAll('img')]
          .slice(0, 100)
          .find(
            (candidate) =>
              candidate.closest('figure') === figure &&
              !isHidden(candidate) &&
              safeImageSource(candidate.currentSrc || candidate.src),
          )
      : undefined;
    const ownsCaption = captionOwner === image;
    if (captionElement && captionOwner) assignedCaptions.add(captionElement);

    const altText = normalizeContent(
      image.getAttribute('alt') ||
        image.getAttribute('aria-label') ||
        image.getAttribute('title') ||
        '',
      maxTextLength,
    );
    const caption =
      ownsCaption && captionElement ? extractEligibleText(captionElement) : '';
    const item: SnapshotImageItem = {
      id: `image-${items.length + 1}`,
      kind: 'image',
      src: rawSource,
    };

    if (altText && characterCount + altText.length <= maxCharacters) {
      item.altText = altText;
      characterCount += altText.length;
    } else if (altText) {
      omissions.truncated = true;
    }
    if (caption && characterCount + caption.length <= maxCharacters) {
      item.caption = caption;
      characterCount += caption.length;
    } else if (caption) {
      omissions.truncated = true;
    }

    items.push(item);
    lastTextContainer = null;
  };

  const visit = (node: Node): void => {
    if (visitedNodes >= maxVisitedNodes) {
      omissions.truncated = true;
      return;
    }
    visitedNodes += 1;
    if (stopIfBounded()) return;

    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      if (parent) appendText(node.textContent ?? '', parent);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;

    if (element.tagName === 'FIGCAPTION') {
      const figure = element.parentElement?.tagName === 'FIGURE'
        ? element.parentElement
        : null;
      const captionOwner = figure
        ? [...figure.querySelectorAll('img')]
            .slice(0, 100)
            .find(
              (candidate) =>
                candidate.closest('figure') === figure &&
                !isHidden(candidate) &&
                safeImageSource(candidate.currentSrc || candidate.src),
            )
        : undefined;
      if (captionOwner) assignedCaptions.add(element);
    }
    if (assignedCaptions.has(element)) return;

    if (element.tagName === 'IFRAME' || element.tagName === 'FRAME') {
      omissions.frames += 1;
      lastTextContainer = null;
      return;
    }

    if (excludedTags.has(element.tagName)) {
      if (controlTags.has(element.tagName)) omissions.controls += 1;
      lastTextContainer = null;
      return;
    }

    if (isPrivateOrInteractive(element)) {
      omissions.controls += 1;
      lastTextContainer = null;
      return;
    }

    if (isHidden(element)) {
      omissions.hidden += 1;
      lastTextContainer = null;
      return;
    }

    if (element instanceof HTMLImageElement) {
      addImage(element);
      return;
    }

    for (const child of element.childNodes) {
      if (visitedNodes >= maxVisitedNodes) {
        omissions.truncated = true;
        break;
      }
      visit(child);
    }
  };

  visit(document.body);

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
  };
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
