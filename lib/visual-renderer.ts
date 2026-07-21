import {
  SNAPSHOT_LIMITS,
  type PageSnapshot,
  type VisualElementNode,
  type VisualNode,
  type VisualPage,
  type VisualStyle,
  type VisualTextNode,
} from './page-snapshot';
import type {
  LivePageDelta,
  LiveVisualElementNode,
  LiveVisualNode,
} from './live-page-mirror';
import {
  displayTranslation,
  type TranslatedSnapshot,
} from './translation-pipeline';

export type MirrorDisplayMode = 'fit' | 'actual' | 'custom';

interface MirrorTextBinding {
  kind: 'text';
  node: Text;
  source: string;
  group: string;
  replica: boolean;
}

interface MirrorAttributeBinding {
  kind: 'attribute';
  node: Element;
  attribute: 'alt';
  source: string;
  group: string;
}

type MirrorTranslationBinding = MirrorTextBinding | MirrorAttributeBinding;

type MirrorTextLayoutMode = 'adaptive' | 'faithful';

interface SavedStyleValue {
  value: string;
  priority: string;
}

interface MirrorController {
  bindings: MirrorTranslationBinding[];
  groupSources: Map<string, string>;
  nextGroup: number;
  textLayoutMode: MirrorTextLayoutMode;
  layoutOverrides: Map<HTMLElement, Map<string, SavedStyleValue>>;
}

const mirrorControllers = new WeakMap<HTMLElement, MirrorController>();

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

const CLIPPING_OVERFLOW_VALUES = new Set([
  'auto',
  'clip',
  'hidden',
  'scroll',
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
  const controller = createMirrorController(
    new Map(
      page.items.flatMap((item) =>
        item.kind === 'text' ? [[item.id, item.text] as const] : [],
      ),
    ),
  );
  const rendered = renderNode(
    page.visual.root,
    page.visual,
    translations,
    textReplacements,
    targetDocument,
    false,
    controller,
  );
  if (rendered.nodeType !== 1) return undefined;
  const root = rendered as HTMLElement;
  prepareMirrorRoot(root);
  mirrorControllers.set(root, controller);
  return root;
}

function createMirrorController(
  groupSources: Map<string, string> = new Map(),
): MirrorController {
  return {
    bindings: [],
    groupSources,
    nextGroup: 1,
    textLayoutMode: 'adaptive',
    layoutOverrides: new Map(),
  };
}

function prepareMirrorRoot(root: HTMLElement): void {
  root.classList.add('visual-page-root');
  root.style.pointerEvents = 'none';
  root.setAttribute('data-simul-inert-mirror', '');
}

export function computeMirrorScale(
  availableWidth: number,
  sourceWidth: number,
  mode: MirrorDisplayMode,
  zoomPercent = 100,
): number {
  if (mode === 'actual') return 1;
  if (mode === 'custom') {
    const zoom = Number.isFinite(zoomPercent) ? zoomPercent : 100;
    return Math.min(3, Math.max(0.25, zoom / 100));
  }
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
  controller: MirrorController,
): Node {
  if (node.kind === 'text') {
    const groupedReplacement = textReplacements.get(node);
    if (groupedReplacement !== undefined) {
      const textNode = targetDocument.createTextNode(groupedReplacement);
      bindText(controller, textNode, node.text, node.itemId);
      return textNode;
    }
    const translated = node.itemId
      ? translations.get(node.itemId)?.text
      : undefined;
    const textNode = targetDocument.createTextNode(
      translated === undefined
        ? node.text
        : preserveBoundaryWhitespace(node.text, translated),
    );
    bindText(controller, textNode, node.text, node.itemId);
    return textNode;
  }

  if (node.kind === 'placeholder') {
    const placeholder = targetDocument.createElement('div');
    applyStyle(placeholder, visual, node.styleId);
    placeholder.className = 'visual-placeholder';
    placeholder.textContent = node.label;
    placeholder.setAttribute('aria-label', node.label);
    applyNodeId(placeholder, node.nodeId);
    return placeholder;
  }

  return renderElement(
    node,
    visual,
    translations,
    textReplacements,
    targetDocument,
    insideSvg,
    controller,
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
  controller: MirrorController,
): Element {
  const svg = insideSvg || node.tag === 'svg';
  const sourceStyle = visual.styles[node.styleId];
  const inertTag =
    node.controlShell === 'select'
      ? 'details'
      : node.controlShell
        ? sourceStyle?.display?.startsWith('inline')
          ? 'span'
          : 'div'
        : node.tag;
  const element = svg && SVG_TAGS.has(inertTag)
    ? targetDocument.createElementNS(SVG_NAMESPACE, inertTag)
    : targetDocument.createElement(inertTag);
  applyStyle(element, visual, node.styleId, {
    omitBackgroundImage: node.controlShell === 'select',
  });
  applyAttributes(element, node, translations, controller);
  applyNodeId(element, node.nodeId);
  if (!svg && 'tabIndex' in element) {
    (element as HTMLElement).tabIndex = -1;
  }

  if (node.controlShell) {
    const htmlElement = element as HTMLElement;
    htmlElement.tabIndex = -1;
    htmlElement.setAttribute('aria-disabled', 'true');
    htmlElement.dataset.simulControlShell = node.controlShell;
    if (node.controlShell === 'select') {
      renderSelectFacsimile(
        htmlElement,
        node,
        visual,
        targetDocument,
        controller,
      );
      return element;
    }
    if (node.controlShell !== 'button') {
      return element;
    }
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
        controller,
      ),
    );
  }
  return element;
}

interface RenderedSelectOption {
  disabled: boolean;
  group: string;
  label: string;
  selected: boolean;
}

function renderSelectFacsimile(
  element: HTMLElement,
  node: VisualElementNode,
  visual: VisualPage,
  targetDocument: Document,
  controller: MirrorController,
): void {
  const summary = targetDocument.createElement('summary');
  summary.dataset.simulSelectSummary = '';
  summary.tabIndex = 0;
  summary.setAttribute('aria-label', 'Show translated options');
  summary.style.cursor = 'default';
  summary.style.display = 'block';
  summary.style.overflow = 'hidden';
  summary.style.textOverflow = 'ellipsis';
  summary.style.whiteSpace = 'nowrap';

  const list = targetDocument.createElement('div');
  list.dataset.simulSelectOptions = '';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-disabled', 'true');
  if (node.selectState?.multiple) {
    list.setAttribute('aria-multiselectable', 'true');
  }
  list.style.background = selectPopupBackground(visual.styles[node.styleId]);
  list.style.boxSizing = 'border-box';
  list.style.color = 'inherit';
  list.style.insetInlineStart = '0';
  list.style.maxHeight = 'min(20rem, 50vh)';
  list.style.minWidth = '100%';
  list.style.overflowX = 'hidden';
  list.style.overflowY = 'auto';
  list.style.pointerEvents = 'auto';
  list.style.position = 'absolute';
  list.style.top = '100%';
  list.style.width = 'max-content';
  list.style.zIndex = '2147483646';

  element.dataset.simulSelectFacsimile = '';
  element.dataset.simulSelectMultiple = node.selectState?.multiple
    ? 'true'
    : 'false';
  element.dataset.simulSelectDisabled = node.selectState?.disabled
    ? 'true'
    : 'false';
  if (node.selectState?.open) element.setAttribute('open', '');
  element.style.overflow = 'visible';
  element.style.pointerEvents = 'auto';
  if (!element.style.position || element.style.position === 'static') {
    element.style.position = 'relative';
  }

  const options: RenderedSelectOption[] = [];
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    if (child.tag === 'option') {
      const option = renderSelectOption(
        child,
        list,
        visual,
        targetDocument,
        controller,
        false,
      );
      if (option) options.push(option);
      continue;
    }
    if (child.tag !== 'optgroup') continue;
    const group = targetDocument.createElement('div');
    group.dataset.simulSelectOptgroup = '';
    group.setAttribute('role', 'group');
    applyStyle(group, visual, child.styleId, { omitBackgroundImage: true });
    normalizeSelectRowStyle(group);
    const groupDisabled = child.optgroupState?.disabled === true;
    if (groupDisabled) {
      group.setAttribute('aria-disabled', 'true');
      group.style.opacity = '0.65';
    }
    const groupLabel = directVisualText(child.children);
    if (groupLabel) {
      const label = targetDocument.createElement('div');
      label.dataset.simulSelectOptgroupLabel = '';
      label.style.fontWeight = '600';
      label.style.paddingInline = '0.5rem';
      appendSelectBoundText(label, groupLabel, controller);
      group.append(label);
    }
    for (const optionNode of child.children) {
      if (optionNode.kind !== 'element' || optionNode.tag !== 'option') continue;
      const option = renderSelectOption(
        optionNode,
        group,
        visual,
        targetDocument,
        controller,
        groupDisabled,
      );
      if (option) options.push(option);
    }
    list.append(group);
  }

  const selected = options.filter((option) => option.selected);
  const summaries = selected;
  if (summaries.length === 0) {
    summary.append(targetDocument.createTextNode('\u2014'));
  } else {
    summaries.forEach((option, index) => {
      if (index > 0) summary.append(targetDocument.createTextNode(', '));
      const text = targetDocument.createTextNode(option.label);
      bindText(controller, text, option.label, undefined, {
        group: option.group,
        replica: true,
      });
      summary.append(text);
    });
  }

  element.append(summary, list);
}

function renderSelectOption(
  node: VisualElementNode,
  parent: HTMLElement,
  visual: VisualPage,
  targetDocument: Document,
  controller: MirrorController,
  groupDisabled: boolean,
): RenderedSelectOption | undefined {
  const label = directVisualText(node.children);
  const row = targetDocument.createElement('div');
  row.dataset.simulSelectOption = '';
  row.setAttribute('role', 'option');
  applyStyle(row, visual, node.styleId, { omitBackgroundImage: true });
  normalizeSelectRowStyle(row);
  const selected = node.optionState?.selected === true;
  const disabled = groupDisabled || node.optionState?.disabled === true;
  row.setAttribute('aria-selected', selected ? 'true' : 'false');
  if (disabled) {
    row.setAttribute('aria-disabled', 'true');
    row.style.opacity = '0.65';
  }
  if (selected) row.dataset.simulSelectSelected = '';
  const group = `select-${controller.nextGroup++}`;
  if (label) appendSelectBoundText(row, label, controller, group);
  else row.append(targetDocument.createTextNode('\u00a0'));
  parent.append(row);
  return { disabled, group, label, selected };
}

function appendSelectBoundText(
  parent: HTMLElement,
  source: string,
  controller: MirrorController,
  group = `select-${controller.nextGroup++}`,
): void {
  const text = parent.ownerDocument.createTextNode(source);
  bindText(controller, text, source, undefined, { group });
  parent.append(text);
}

function directVisualText(nodes: VisualNode[]): string {
  return nodes
    .filter((child): child is VisualTextNode => child.kind === 'text')
    .map((child) => child.text)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeSelectRowStyle(element: HTMLElement): void {
  element.style.boxSizing = 'border-box';
  element.style.height = 'auto';
  element.style.maxHeight = 'none';
  element.style.minHeight = '1.5em';
  element.style.overflow = 'visible';
  element.style.pointerEvents = 'none';
  element.style.position = 'static';
  element.style.whiteSpace = 'normal';
  element.style.width = 'auto';
}

function selectPopupBackground(style: VisualStyle | undefined): string {
  const background = style?.['background-color']?.trim();
  return background &&
    background !== 'transparent' &&
    background !== 'rgba(0, 0, 0, 0)'
    ? background
    : 'Canvas';
}

function bindText(
  controller: MirrorController,
  node: Text,
  source: string,
  itemId?: string,
  options: { group?: string; replica?: boolean } = {},
): void {
  const group = options.group ?? itemId ?? `live-${controller.nextGroup++}`;
  controller.bindings.push({
    kind: 'text',
    node,
    source,
    group,
    replica: options.replica === true,
  });
  if (!controller.groupSources.has(group)) {
    controller.groupSources.set(group, source.replace(/\s+/gu, ' ').trim());
  }
}

function bindImageAlt(
  controller: MirrorController,
  image: HTMLImageElement,
  source: string,
  group: string,
): void {
  const normalizedSource = source.replace(/\s+/gu, ' ').trim();
  if (!normalizedSource) return;
  controller.bindings.push({
    kind: 'attribute',
    node: image,
    attribute: 'alt',
    source: normalizedSource,
    group,
  });
  controller.groupSources.set(group, normalizedSource);
}

function applyNodeId(element: Element, nodeId: string | undefined): void {
  if (nodeId) element.setAttribute('data-simul-node-id', nodeId);
}

export interface MirrorTranslationOptions {
  signal?: AbortSignal;
  groups?: ReadonlySet<string>;
  onProgress?: (completed: number, total: number) => void;
}

export interface MirrorTranslationResult {
  completed: number;
  failed: number;
  total: number;
}

export function countVisualMirrorTranslationFields(root: HTMLElement): number {
  const controller = mirrorControllers.get(root);
  if (!controller) return 0;
  pruneBindings(controller, root);
  return translatableBindingGroups(controller).length;
}

export async function translateVisualMirror(
  root: HTMLElement,
  translate: (source: string, signal?: AbortSignal) => Promise<string>,
  options: MirrorTranslationOptions = {},
): Promise<MirrorTranslationResult> {
  const controller = mirrorControllers.get(root);
  if (!controller) return { completed: 0, failed: 0, total: 0 };
  pruneBindings(controller, root);
  const grouped = translatableBindingGroups(controller).filter(
    ([group]) => !options.groups || options.groups.has(group),
  );
  let completed = 0;
  let failed = 0;
  let acceptedCharacters = 0;
  for (const [group, bindings] of grouped) {
    options.signal?.throwIfAborted();
    const source = controller.groupSources.get(group) ?? bindings
      .map((binding) => binding.source)
      .join('')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!source) {
      completed += 1;
      options.onProgress?.(completed, grouped.length);
      continue;
    }
    if (
      completed >= SNAPSHOT_LIMITS.maxVisualNodes ||
      acceptedCharacters + source.length >
        SNAPSHOT_LIMITS.maxVisualTextCharacters
    ) {
      failed += 1;
      completed += 1;
      applyGroupSource(bindings);
      options.onProgress?.(completed, grouped.length);
      continue;
    }
    acceptedCharacters += source.length;
    try {
      const translated = await translate(source, options.signal);
      options.signal?.throwIfAborted();
      if (!translated.trim()) throw new Error('Empty translation');
      applyGroupTranslation(bindings, translated);
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      failed += 1;
      applyGroupSource(bindings);
    }
    completed += 1;
    options.onProgress?.(completed, grouped.length);
  }
  refreshTranslatedTextLayout(root, controller);
  return { completed, failed, total: grouped.length };
}

export function resetVisualMirrorText(root: HTMLElement): void {
  const controller = mirrorControllers.get(root);
  if (!controller) return;
  pruneBindings(controller, root);
  for (const [, bindings] of groupBindings(controller)) {
    applyGroupSource(bindings);
  }
  restoreLayoutOverrides(controller);
}

export function applyMirrorTextLayout(
  root: HTMLElement,
  mode: MirrorTextLayoutMode,
): void {
  root.classList.toggle('visual-page-root--adaptive', mode === 'adaptive');
  root.classList.toggle('visual-page-root--faithful', mode === 'faithful');
  const controller = mirrorControllers.get(root);
  if (!controller) return;
  controller.textLayoutMode = mode;
  refreshTranslatedTextLayout(root, controller);
}

export interface ApplyLiveDeltaOptions {
  textLayoutMode: MirrorTextLayoutMode;
  translate?: (source: string, signal?: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}

export interface ApplyLiveDeltaResult {
  root: HTMLElement;
  applied: number;
  missingTarget: boolean;
  translation: MirrorTranslationResult;
}

interface LocatedLiveReplacement {
  targetId: string;
  node: LiveVisualNode | null;
  target: Element | undefined;
}

export async function applyLivePageDelta(
  currentRoot: HTMLElement,
  delta: LivePageDelta,
  options: ApplyLiveDeltaOptions,
): Promise<ApplyLiveDeltaResult> {
  const controller = mirrorControllers.get(currentRoot);
  if (!controller) {
    return {
      root: currentRoot,
      applied: 0,
      missingTarget: true,
      translation: { completed: 0, failed: 0, total: 0 },
    };
  }
  const replacements: LocatedLiveReplacement[] = delta.replacements
    .map((replacement) => ({
      ...replacement,
      target: findMirrorNode(currentRoot, replacement.targetId),
    }))
    .sort((left, right) => nodeDepth(left.target) - nodeDepth(right.target));
  if (!liveDeltaFitsTranslationBudget(currentRoot, controller, replacements)) {
    return {
      root: currentRoot,
      applied: 0,
      missingTarget: true,
      translation: { completed: 0, failed: 0, total: 0 },
    };
  }
  const rootReplacement = replacements.find(
    (replacement) => replacement.target === currentRoot,
  );
  const rootNode = rootReplacement?.node;
  if (rootReplacement && rootNode) {
    return replaceLiveRootAtomically(
      currentRoot,
      replacements,
      rootReplacement,
      rootNode,
      options,
    );
  }
  let root = currentRoot;
  let applied = 0;
  let missingTarget = false;
  const newGroups = new Set<string>();
  for (const replacement of replacements) {
    options.signal?.throwIfAborted();
    const target = findMirrorNode(root, replacement.targetId);
    if (!target) {
      missingTarget = true;
      continue;
    }
    if (!replacement.node) {
      if (target === root) {
        missingTarget = true;
        continue;
      }
      target.remove();
      applied += 1;
      continue;
    }
    const bindingStart = controller.bindings.length;
    const rendered = renderLiveNode(
      replacement.node,
      target.ownerDocument,
      controller,
      false,
    );
    if (!(rendered instanceof Element)) {
      missingTarget = true;
      continue;
    }
    target.replaceWith(rendered);
    for (const binding of controller.bindings.slice(bindingStart)) {
      controller.groupSources.set(
        binding.group,
        binding.source.replace(/\s+/gu, ' ').trim(),
      );
      newGroups.add(binding.group);
    }
    applied += 1;
  }
  pruneBindings(controller, root);
  applyMirrorTextLayout(root, options.textLayoutMode);
  let translation: MirrorTranslationResult = {
    completed: 0,
    failed: 0,
    total: 0,
  };
  if (options.translate && newGroups.size > 0) {
    translation = await translateVisualMirror(root, options.translate, {
      signal: options.signal,
      groups: newGroups,
    });
  }
  return { root, applied, missingTarget, translation };
}

function liveDeltaFitsTranslationBudget(
  root: HTMLElement,
  controller: MirrorController,
  replacements: readonly LocatedLiveReplacement[],
): boolean {
  pruneBindings(controller, root);
  const removedTargets = replacements
    .map((replacement) => replacement.target)
    .filter((target): target is Element => Boolean(target));
  let retainedVisualNodes = 0;
  const retainedElements: Element[] = [root];
  while (retainedElements.length > 0) {
    const element = retainedElements.pop();
    if (!element) continue;
    if (removedTargets.some((target) => target === element)) continue;
    if (element.hasAttribute('data-simul-node-id')) {
      retainedVisualNodes += 1;
      if (retainedVisualNodes > SNAPSHOT_LIMITS.maxVisualNodes) return false;
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      retainedElements.push(element.children[index]!);
    }
  }
  let groups = 0;
  let characters = 0;
  for (const [group, bindings] of translatableBindingGroups(controller)) {
    const retained = bindings.some((binding) =>
      !removedTargets.some((target) =>
        target === binding.node || target.contains(binding.node),
      ),
    );
    if (!retained) continue;
    retainedVisualNodes += bindings.filter(
      (binding) => binding.kind === 'text' && !binding.replica &&
        !removedTargets.some((target) => target.contains(binding.node)),
    ).length;
    const source = normalizedTranslationSource(
      controller.groupSources.get(group) ?? bindings
        .map((binding) => binding.source)
        .join(''),
    );
    if (!source) continue;
    groups += 1;
    characters += source.length;
    if (
      groups > SNAPSHOT_LIMITS.maxVisualNodes ||
      retainedVisualNodes > SNAPSHOT_LIMITS.maxVisualNodes ||
      characters > SNAPSHOT_LIMITS.maxVisualTextCharacters
    ) return false;
  }

  const pending: LiveVisualNode[] = replacements.flatMap((replacement) =>
    replacement.node ? [replacement.node] : [],
  );
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    retainedVisualNodes += 1;
    if (node.kind === 'text') {
      const source = normalizedTranslationSource(node.text);
      if (source) {
        groups += 1;
        characters += source.length;
      }
    } else if (node.kind === 'element') {
      const alt = node.tag === 'img'
        ? normalizedTranslationSource(node.attributes?.alt ?? '')
        : '';
      if (alt) {
        groups += 1;
        characters += alt.length;
      }
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]!);
      }
    }
    if (
      groups > SNAPSHOT_LIMITS.maxVisualNodes ||
      retainedVisualNodes > SNAPSHOT_LIMITS.maxVisualNodes ||
      characters > SNAPSHOT_LIMITS.maxVisualTextCharacters
    ) return false;
  }
  return true;
}

function normalizedTranslationSource(source: string): string {
  return source.replace(/\s+/gu, ' ').trim();
}

async function replaceLiveRootAtomically(
  currentRoot: HTMLElement,
  replacements: LocatedLiveReplacement[],
  rootReplacement: LocatedLiveReplacement,
  rootNode: LiveVisualNode,
  options: ApplyLiveDeltaOptions,
): Promise<ApplyLiveDeltaResult> {
  options.signal?.throwIfAborted();
  const controller = createMirrorController();
  const renderedRoot = renderLiveNode(
    rootNode,
    currentRoot.ownerDocument,
    controller,
    false,
  );
  if (renderedRoot.nodeType !== 1) {
    return {
      root: currentRoot,
      applied: 0,
      missingTarget: true,
      translation: { completed: 0, failed: 0, total: 0 },
    };
  }

  const stagedRoot = renderedRoot as HTMLElement;
  prepareMirrorRoot(stagedRoot);
  mirrorControllers.set(stagedRoot, controller);
  let applied = 1;
  let missingTarget = false;

  try {
    for (const replacement of replacements) {
      if (replacement === rootReplacement) continue;
      options.signal?.throwIfAborted();
      const target = findMirrorNode(stagedRoot, replacement.targetId);
      if (!target || target === stagedRoot) {
        missingTarget = true;
        continue;
      }
      if (!replacement.node) {
        target.remove();
        applied += 1;
        continue;
      }
      const rendered = renderLiveNode(
        replacement.node,
        target.ownerDocument,
        controller,
        false,
      );
      if (rendered.nodeType !== 1) {
        missingTarget = true;
        continue;
      }
      target.replaceWith(rendered);
      applied += 1;
    }

    pruneBindings(controller, stagedRoot);
    applyMirrorTextLayout(stagedRoot, options.textLayoutMode);
    const newGroups = new Set(
      controller.bindings.map((binding) => binding.group),
    );
    let translation: MirrorTranslationResult = {
      completed: 0,
      failed: 0,
      total: 0,
    };
    if (options.translate && newGroups.size > 0) {
      translation = await translateVisualMirror(stagedRoot, options.translate, {
        signal: options.signal,
        groups: newGroups,
      });
    }

    // A translator may resolve after ignoring an abort signal. Keep the old
    // connected tree authoritative until this final synchronous commit.
    options.signal?.throwIfAborted();
    currentRoot.replaceWith(stagedRoot);
    mirrorControllers.delete(currentRoot);
    return { root: stagedRoot, applied, missingTarget, translation };
  } catch (error) {
    mirrorControllers.delete(stagedRoot);
    throw error;
  }
}

function renderLiveNode(
  node: LiveVisualNode,
  targetDocument: Document,
  controller: MirrorController,
  insideSvg: boolean,
): Node {
  if (node.kind === 'text') {
    const textNode = targetDocument.createTextNode(node.text);
    bindText(controller, textNode, node.text, `delta-${node.nodeId}`);
    return textNode;
  }
  if (node.kind === 'placeholder') {
    const placeholder = targetDocument.createElement('div');
    applyInlineStyle(placeholder, node.style);
    placeholder.className = 'visual-placeholder';
    placeholder.textContent = node.label;
    placeholder.setAttribute('aria-label', node.label);
    applyNodeId(placeholder, node.nodeId);
    return placeholder;
  }
  const svg = insideSvg || node.tag === 'svg';
  const inertTag = node.controlShell === 'select'
    ? 'details'
    : node.controlShell
      ? node.style.display?.startsWith('inline')
        ? 'span'
        : 'div'
      : node.tag;
  const element = svg && SVG_TAGS.has(inertTag)
    ? targetDocument.createElementNS(SVG_NAMESPACE, inertTag)
    : targetDocument.createElement(inertTag);
  applyInlineStyle(element, node.style, {
    omitBackgroundImage: node.controlShell === 'select',
  });
  applyLiveAttributes(element, node.attributes);
  if (node.tag === 'img') {
    const sourceAlt = node.attributes?.alt;
    if (sourceAlt) {
      bindImageAlt(
        controller,
        element as HTMLImageElement,
        sourceAlt,
        `delta-alt-${node.nodeId}`,
      );
    }
  }
  applyNodeId(element, node.nodeId);
  if (!svg && 'tabIndex' in element) (element as HTMLElement).tabIndex = -1;
  if (node.controlShell) {
    const htmlElement = element as HTMLElement;
    htmlElement.tabIndex = -1;
    htmlElement.setAttribute('aria-disabled', 'true');
    htmlElement.dataset.simulControlShell = node.controlShell;
    if (node.controlShell === 'select') {
      renderLiveSelectFacsimile(
        htmlElement,
        node,
        targetDocument,
        controller,
      );
      return element;
    }
    if (node.controlShell !== 'button') return element;
  }
  for (const child of node.children) {
    element.append(renderLiveNode(child, targetDocument, controller, svg));
  }
  return element;
}

function renderLiveSelectFacsimile(
  element: HTMLElement,
  node: LiveVisualElementNode,
  targetDocument: Document,
  controller: MirrorController,
): void {
  const summary = targetDocument.createElement('summary');
  summary.dataset.simulSelectSummary = '';
  summary.tabIndex = 0;
  summary.setAttribute('aria-label', 'Show translated options');
  summary.style.cursor = 'default';
  summary.style.display = 'block';
  summary.style.overflow = 'hidden';
  summary.style.textOverflow = 'ellipsis';
  summary.style.whiteSpace = 'nowrap';

  const list = targetDocument.createElement('div');
  list.dataset.simulSelectOptions = '';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-disabled', 'true');
  if (node.selectState?.multiple) {
    list.setAttribute('aria-multiselectable', 'true');
  }
  list.style.background = selectPopupBackground(node.style);
  list.style.boxSizing = 'border-box';
  list.style.color = 'inherit';
  list.style.insetInlineStart = '0';
  list.style.maxHeight = 'min(20rem, 50vh)';
  list.style.minWidth = '100%';
  list.style.overflowX = 'hidden';
  list.style.overflowY = 'auto';
  list.style.pointerEvents = 'auto';
  list.style.position = 'absolute';
  list.style.top = '100%';
  list.style.width = 'max-content';
  list.style.zIndex = '2147483646';

  element.dataset.simulSelectFacsimile = '';
  element.dataset.simulSelectMultiple = node.selectState?.multiple
    ? 'true'
    : 'false';
  element.dataset.simulSelectDisabled = node.selectState?.disabled
    ? 'true'
    : 'false';
  if (node.selectState?.open) element.setAttribute('open', '');
  element.style.overflow = 'visible';
  element.style.pointerEvents = 'auto';
  if (!element.style.position || element.style.position === 'static') {
    element.style.position = 'relative';
  }

  const options: RenderedSelectOption[] = [];
  for (const child of node.children) {
    if (child.kind !== 'element') continue;
    if (child.tag === 'option') {
      const option = renderLiveSelectOption(
        child,
        list,
        targetDocument,
        controller,
        false,
      );
      if (option) options.push(option);
      continue;
    }
    if (child.tag !== 'optgroup') continue;
    const group = targetDocument.createElement('div');
    group.dataset.simulSelectOptgroup = '';
    group.setAttribute('role', 'group');
    applyInlineStyle(group, child.style, { omitBackgroundImage: true });
    applyNodeId(group, child.nodeId);
    normalizeSelectRowStyle(group);
    const groupDisabled = child.optgroupState?.disabled === true;
    if (groupDisabled) {
      group.setAttribute('aria-disabled', 'true');
      group.style.opacity = '0.65';
    }
    const groupLabel = directLiveText(child.children);
    if (groupLabel) {
      const label = targetDocument.createElement('div');
      label.dataset.simulSelectOptgroupLabel = '';
      label.style.fontWeight = '600';
      label.style.paddingInline = '0.5rem';
      appendSelectBoundText(label, groupLabel, controller);
      group.append(label);
    }
    for (const optionNode of child.children) {
      if (optionNode.kind !== 'element' || optionNode.tag !== 'option') continue;
      const option = renderLiveSelectOption(
        optionNode,
        group,
        targetDocument,
        controller,
        groupDisabled,
      );
      if (option) options.push(option);
    }
    list.append(group);
  }

  const selected = options.filter((option) => option.selected);
  const summaries = selected;
  if (summaries.length === 0) {
    summary.append(targetDocument.createTextNode('\u2014'));
  } else {
    summaries.forEach((option, index) => {
      if (index > 0) summary.append(targetDocument.createTextNode(', '));
      const text = targetDocument.createTextNode(option.label);
      bindText(controller, text, option.label, undefined, {
        group: option.group,
        replica: true,
      });
      summary.append(text);
    });
  }

  element.append(summary, list);
}

function renderLiveSelectOption(
  node: LiveVisualElementNode,
  parent: HTMLElement,
  targetDocument: Document,
  controller: MirrorController,
  groupDisabled: boolean,
): RenderedSelectOption | undefined {
  const label = directLiveText(node.children);
  const row = targetDocument.createElement('div');
  row.dataset.simulSelectOption = '';
  row.setAttribute('role', 'option');
  applyInlineStyle(row, node.style, { omitBackgroundImage: true });
  applyNodeId(row, node.nodeId);
  normalizeSelectRowStyle(row);
  const selected = node.optionState?.selected === true;
  const disabled = groupDisabled || node.optionState?.disabled === true;
  row.setAttribute('aria-selected', selected ? 'true' : 'false');
  if (disabled) {
    row.setAttribute('aria-disabled', 'true');
    row.style.opacity = '0.65';
  }
  if (selected) row.dataset.simulSelectSelected = '';
  const group = `select-${controller.nextGroup++}`;
  if (label) appendSelectBoundText(row, label, controller, group);
  else row.append(targetDocument.createTextNode('\u00a0'));
  parent.append(row);
  return { disabled, group, label, selected };
}

function directLiveText(nodes: LiveVisualNode[]): string {
  return nodes
    .filter((child) => child.kind === 'text')
    .map((child) => child.text)
    .join('')
    .replace(/\s+/gu, ' ')
    .trim();
}

function applyInlineStyle(
  element: Element,
  style: VisualStyle,
  options: { omitBackgroundImage?: boolean } = {},
): void {
  if (!('style' in element)) return;
  for (const [property, value] of Object.entries(style)) {
    if (options.omitBackgroundImage && property === 'background-image') continue;
    if (value) (element as HTMLElement | SVGElement).style.setProperty(property, value);
  }
}

function applyLiveAttributes(
  element: Element,
  attributes: Record<string, string> | undefined,
): void {
  for (const [name, value] of Object.entries(attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (element instanceof HTMLImageElement) {
    element.loading = 'lazy';
    element.decoding = 'async';
    element.referrerPolicy = 'no-referrer';
    element.tabIndex = -1;
  }
}

function findMirrorNode(root: HTMLElement, nodeId: string): Element | undefined {
  if (root.getAttribute('data-simul-node-id') === nodeId) return root;
  return [...root.querySelectorAll('[data-simul-node-id]')].find(
    (candidate) => candidate.getAttribute('data-simul-node-id') === nodeId,
  );
}

function nodeDepth(node: Element | undefined): number {
  let depth = 0;
  let current = node?.parentElement;
  while (current) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

function pruneBindings(
  controller: MirrorController,
  root: HTMLElement,
): void {
  controller.bindings = controller.bindings.filter(
    (binding) => binding.node.isConnected || root.contains(binding.node),
  );
  const retained = new Set(controller.bindings.map((binding) => binding.group));
  for (const group of controller.groupSources.keys()) {
    if (!retained.has(group)) controller.groupSources.delete(group);
  }
}

function groupBindings(
  controller: MirrorController,
): Array<[string, MirrorTranslationBinding[]]> {
  const groups = new Map<string, MirrorTranslationBinding[]>();
  for (const binding of controller.bindings) {
    const existing = groups.get(binding.group);
    if (existing) existing.push(binding);
    else groups.set(binding.group, [binding]);
  }
  return [...groups];
}

function translatableBindingGroups(
  controller: MirrorController,
): Array<[string, MirrorTranslationBinding[]]> {
  return groupBindings(controller).filter(([group, bindings]) => {
    const source = controller.groupSources.get(group) ?? bindings
      .map((binding) => binding.source)
      .join('');
    return source.trim().length > 0;
  });
}

function applyGroupTranslation(
  bindings: MirrorTranslationBinding[],
  translated: string,
): void {
  const textBindings = bindings.filter(
    (binding): binding is MirrorTextBinding => binding.kind === 'text',
  );
  const primaryTextBindings = textBindings.filter((binding) => !binding.replica);
  const chunks = primaryTextBindings.length > 1
    ? splitAcrossTextNodes(
        translated,
        primaryTextBindings.map((binding) => ({
          kind: 'text',
          text: binding.source,
        })),
      )
    : [translated];
  primaryTextBindings.forEach((binding, index) => {
    binding.node.data = preserveBoundaryWhitespace(
      binding.source,
      chunks[index] ?? '',
    );
    binding.node.parentElement?.classList.add('simul-translated-container');
  });
  for (const binding of textBindings.filter((candidate) => candidate.replica)) {
    binding.node.data = preserveBoundaryWhitespace(binding.source, translated);
    binding.node.parentElement?.classList.add('simul-translated-container');
  }
  for (const binding of bindings) {
    if (binding.kind === 'attribute') {
      binding.node.setAttribute(binding.attribute, translated.trim());
    }
  }
}

function applyGroupSource(bindings: MirrorTranslationBinding[]): void {
  for (const binding of bindings) {
    if (binding.kind === 'text') {
      binding.node.data = binding.source;
      binding.node.parentElement?.classList.remove('simul-translated-container');
    } else {
      binding.node.setAttribute(binding.attribute, binding.source);
    }
  }
}

function refreshTranslatedTextLayout(
  root: HTMLElement,
  controller: MirrorController,
): void {
  restoreLayoutOverrides(controller);
  const containers = [
    ...(root.classList.contains('simul-translated-container') ? [root] : []),
    ...root.querySelectorAll<HTMLElement>('.simul-translated-container'),
  ];
  for (const container of containers) {
    overrideTranslatedContainer(controller, container);
    let ancestor = container.parentElement;
    while (ancestor && root.contains(ancestor)) {
      const isCompanionSelectScroller =
        ancestor.dataset.simulSelectOptions !== undefined;
      if (!isCompanionSelectScroller && clipsOverflow(ancestor)) {
        overrideClippingAncestor(controller, ancestor);
      }
      if (ancestor === root) break;
      ancestor = ancestor.parentElement;
    }
  }
}

function overrideTranslatedContainer(
  controller: MirrorController,
  container: HTMLElement,
): void {
  setLayoutOverride(controller, container, 'overflow-x', 'visible');
  setLayoutOverride(controller, container, 'overflow-y', 'visible');
  setLayoutOverride(controller, container, 'text-overflow', 'clip');
  if (controller.textLayoutMode !== 'adaptive') return;
  setLayoutOverride(controller, container, 'height', 'auto');
  setLayoutOverride(controller, container, 'max-height', 'none');
  setLayoutOverride(controller, container, 'overflow-wrap', 'anywhere');
  setLayoutOverride(controller, container, 'white-space', 'normal');
}

function overrideClippingAncestor(
  controller: MirrorController,
  ancestor: HTMLElement,
): void {
  setLayoutOverride(controller, ancestor, 'overflow-x', 'visible');
  setLayoutOverride(controller, ancestor, 'overflow-y', 'visible');
  setLayoutOverride(controller, ancestor, 'text-overflow', 'clip');
  if (controller.textLayoutMode !== 'adaptive') return;
  setLayoutOverride(controller, ancestor, 'height', 'auto');
  setLayoutOverride(controller, ancestor, 'max-height', 'none');
}

function clipsOverflow(element: HTMLElement): boolean {
  return ['overflow', 'overflow-x', 'overflow-y'].some((property) =>
    CLIPPING_OVERFLOW_VALUES.has(
      element.style.getPropertyValue(property).trim().toLowerCase(),
    ),
  );
}

function setLayoutOverride(
  controller: MirrorController,
  element: HTMLElement,
  property: string,
  value: string,
): void {
  let saved = controller.layoutOverrides.get(element);
  if (!saved) {
    saved = new Map();
    controller.layoutOverrides.set(element, saved);
  }
  if (!saved.has(property)) {
    saved.set(property, {
      value: element.style.getPropertyValue(property),
      priority: typeof element.style.getPropertyPriority === 'function'
        ? element.style.getPropertyPriority(property)
        : '',
    });
  }
  element.style.setProperty(property, value, 'important');
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value);
  }
}

function restoreLayoutOverrides(controller: MirrorController): void {
  for (const [element, properties] of controller.layoutOverrides) {
    for (const [property, saved] of properties) {
      if (saved.value) {
        element.style.setProperty(property, saved.value, saved.priority);
      } else {
        element.style.removeProperty(property);
      }
    }
  }
  controller.layoutOverrides.clear();
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function applyStyle(
  element: Element,
  visual: VisualPage,
  styleId: number,
  options: { omitBackgroundImage?: boolean } = {},
): void {
  const style = visual.styles[styleId];
  if (!style || !('style' in element)) return;
  const styled = element as HTMLElement | SVGElement;
  for (const [property, value] of Object.entries(style)) {
    if (options.omitBackgroundImage && property === 'background-image') {
      continue;
    }
    if (value) styled.style.setProperty(property, value);
  }
}

function applyAttributes(
  element: Element,
  node: VisualElementNode,
  translations: ReadonlyMap<string, TranslationDisplay>,
  controller: MirrorController,
): void {
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (node.tag === 'img') {
    const image = element as HTMLImageElement;
    const sourceAlt = node.attributes?.alt;
    const translatedAlt = node.itemId
      ? translations.get(node.itemId)?.alt
      : undefined;
    if (translatedAlt) image.alt = translatedAlt;
    if (sourceAlt) {
      const group = node.itemId
        ? `image-alt-${node.itemId}`
        : `image-alt-${node.nodeId ?? controller.nextGroup++}`;
      bindImageAlt(controller, image, sourceAlt, group);
    }
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
