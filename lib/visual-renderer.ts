import type {
  PageSnapshot,
  VisualElementNode,
  VisualNode,
  VisualPage,
  VisualTextNode,
} from './page-snapshot';
import {
  displayTranslation,
  type TranslatedSnapshot,
} from './translation-pipeline';

export type MirrorDisplayMode = 'fit' | 'actual';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set([
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

interface TranslationDisplay {
  text?: string;
  alt?: string;
}

export function createVisualMirror(
  page: PageSnapshot,
  translated?: TranslatedSnapshot,
  targetDocument: Document = document,
): HTMLElement | undefined {
  if (!page.visual) return undefined;
  const translations = collectTranslationDisplays(translated);
  const textReplacements = collectGroupedTextReplacements(
    page.visual.root,
    translations,
  );
  const rendered = renderNode(
    page.visual.root,
    page.visual,
    translations,
    textReplacements,
    targetDocument,
    false,
  );
  if (rendered.nodeType !== 1) return undefined;
  const root = rendered as HTMLElement;
  root.classList.add('visual-page-root');
  root.style.pointerEvents = 'none';
  root.setAttribute('data-simul-inert-mirror', '');
  return root;
}

export function computeMirrorScale(
  availableWidth: number,
  sourceWidth: number,
  mode: MirrorDisplayMode,
): number {
  if (mode === 'actual') return 1;
  if (
    !Number.isFinite(availableWidth) ||
    !Number.isFinite(sourceWidth) ||
    availableWidth <= 0 ||
    sourceWidth <= 0
  ) {
    return 1;
  }
  return Math.min(1, availableWidth / sourceWidth);
}

export function computeMirrorExtent(
  scale: number,
  sourceWidth: number,
  sourceHeight: number,
  renderedWidth: number,
  renderedHeight: number,
): { width: number; height: number } {
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const width = Math.max(
    finitePositiveDimension(sourceWidth),
    finitePositiveDimension(renderedWidth),
  );
  const height = Math.max(
    finitePositiveDimension(sourceHeight),
    finitePositiveDimension(renderedHeight),
  );
  return {
    width: Math.ceil(width * safeScale),
    height: Math.ceil(height * safeScale),
  };
}

function finitePositiveDimension(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function renderNode(
  node: VisualNode,
  visual: VisualPage,
  translations: ReadonlyMap<string, TranslationDisplay>,
  textReplacements: WeakMap<VisualTextNode, string>,
  targetDocument: Document,
  insideSvg: boolean,
): Node {
  if (node.kind === 'text') {
    const groupedReplacement = textReplacements.get(node);
    if (groupedReplacement !== undefined) {
      return targetDocument.createTextNode(groupedReplacement);
    }
    const translated = node.itemId
      ? translations.get(node.itemId)?.text
      : undefined;
    return targetDocument.createTextNode(
      translated === undefined
        ? node.text
        : preserveBoundaryWhitespace(node.text, translated),
    );
  }

  if (node.kind === 'placeholder') {
    const placeholder = targetDocument.createElement('div');
    applyStyle(placeholder, visual, node.styleId);
    placeholder.className = 'visual-placeholder';
    placeholder.textContent = node.label;
    placeholder.setAttribute('aria-label', node.label);
    return placeholder;
  }

  return renderElement(
    node,
    visual,
    translations,
    textReplacements,
    targetDocument,
    insideSvg,
  );
}

function preserveBoundaryWhitespace(source: string, translated: string): string {
  const leading = source.match(/^\s+/u)?.[0] ?? '';
  const trailing = source.match(/\s+$/u)?.[0] ?? '';
  return `${leading}${translated.trim()}${trailing}`;
}

function renderElement(
  node: VisualElementNode,
  visual: VisualPage,
  translations: ReadonlyMap<string, TranslationDisplay>,
  textReplacements: WeakMap<VisualTextNode, string>,
  targetDocument: Document,
  insideSvg: boolean,
): Element {
  const svg = insideSvg || node.tag === 'svg';
  const element = svg && SVG_TAGS.has(node.tag)
    ? targetDocument.createElementNS(SVG_NAMESPACE, node.tag)
    : targetDocument.createElement(node.tag);
  applyStyle(element, visual, node.styleId);
  applyAttributes(element, node, translations);
  if (!svg && 'tabIndex' in element) {
    (element as HTMLElement).tabIndex = -1;
  }

  if (node.controlShell) {
    const htmlElement = element as HTMLElement;
    htmlElement.tabIndex = -1;
    htmlElement.setAttribute('aria-disabled', 'true');
    if ('disabled' in htmlElement) {
      (htmlElement as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = true;
    }
    if (node.controlShell === 'input' && node.tag === 'input') {
      const input = element as HTMLInputElement;
      input.type = 'text';
      input.value = '';
    }
    return element;
  }

  for (const child of node.children) {
    element.append(
      renderNode(
        child,
        visual,
        translations,
        textReplacements,
        targetDocument,
        svg,
      ),
    );
  }
  return element;
}

function applyStyle(
  element: Element,
  visual: VisualPage,
  styleId: number,
): void {
  const style = visual.styles[styleId];
  if (!style || !('style' in element)) return;
  const styled = element as HTMLElement | SVGElement;
  for (const [property, value] of Object.entries(style)) {
    if (value) styled.style.setProperty(property, value);
  }
}

function applyAttributes(
  element: Element,
  node: VisualElementNode,
  translations: ReadonlyMap<string, TranslationDisplay>,
): void {
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (node.tag === 'img') {
    const image = element as HTMLImageElement;
    const translatedAlt = node.itemId
      ? translations.get(node.itemId)?.alt
      : undefined;
    if (translatedAlt) image.alt = translatedAlt;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.tabIndex = -1;
    image.addEventListener('error', () => {
      image.classList.add('visual-image--failed');
      image.removeAttribute('src');
      image.alt = translatedAlt || image.alt || 'Image unavailable';
    });
  }
}

function collectTranslationDisplays(
  translated: TranslatedSnapshot | undefined,
): Map<string, TranslationDisplay> {
  const displays = new Map<string, TranslationDisplay>();
  if (!translated) return displays;
  for (const item of translated.items) {
    if (item.kind === 'text') {
      displays.set(item.id, { text: displayTranslation(item.translation) });
      continue;
    }
    displays.set(item.id, {
      ...(item.altTranslation
        ? { alt: displayTranslation(item.altTranslation) }
        : {}),
    });
  }
  return displays;
}

function collectGroupedTextReplacements(
  root: VisualElementNode,
  translations: ReadonlyMap<string, TranslationDisplay>,
): WeakMap<VisualTextNode, string> {
  const groups = new Map<string, VisualTextNode[]>();
  const visit = (node: VisualNode): void => {
    if (node.kind === 'text') {
      if (node.itemId && translations.get(node.itemId)?.text !== undefined) {
        const group = groups.get(node.itemId) ?? [];
        group.push(node);
        groups.set(node.itemId, group);
      }
      return;
    }
    if (node.kind === 'element') {
      for (const child of node.children) visit(child);
    }
  };
  visit(root);

  const replacements = new WeakMap<VisualTextNode, string>();
  for (const [itemId, nodes] of groups) {
    if (nodes.length < 2) continue;
    const translated = translations.get(itemId)?.text;
    if (translated === undefined) continue;
    const chunks = splitAcrossTextNodes(translated, nodes);
    nodes.forEach((node, index) => {
      replacements.set(node, chunks[index] ?? '');
    });
  }
  return replacements;
}

function splitAcrossTextNodes(
  translated: string,
  nodes: VisualTextNode[],
): string[] {
  const segments = segmentWords(translated);
  const weights = nodes.map((node) =>
    [...node.text.replace(/\s+/gu, ' ').trim()].length,
  );
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight === 0) {
    return nodes.map((_node, index) => (index === 0 ? translated : ''));
  }

  const chunks: string[] = [];
  let consumedWeight = 0;
  let previousBoundary = 0;
  for (const [index, weight] of weights.entries()) {
    consumedWeight += weight;
    const boundary =
      index === weights.length - 1
        ? segments.length
        : Math.round((segments.length * consumedWeight) / totalWeight);
    chunks.push(segments.slice(previousBoundary, boundary).join(''));
    previousBoundary = boundary;
  }
  return chunks;
}

function segmentWords(value: string): string[] {
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    return [...segmenter.segment(value)].map((part) => part.segment);
  }
  return [...value];
}
