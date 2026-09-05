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
const MAX_SOURCE_CONTROLLED_RELATIONSHIPS = 1_024;
const MAX_SOURCE_CONTROLLED_ID_LENGTH = 16 * 1_024;
const MAX_SOURCE_CONTROLLED_ID_BYTES = 4 * 1_024 * 1_024;
const MAX_SOURCE_ARIA_CONTROLS_LENGTH = 1 * 1_024 * 1_024;
const MAX_SOURCE_CONTROLLED_MUTATION_NODES = 2_048;
const MAX_SOURCE_PAINT_RECTS = 256;
const DEFAULT_MAX_SOURCE_CONTROLLED_NODES = 50_000;
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

export interface SourceControlledTabRelationship {
  readonly trigger: Element;
  readonly panel: Element;
  readonly selected: boolean;
}

export interface SourceControlledContentPolicy {
  /** Every resolved target is withheld unless it is a uniquely proven open tab. */
  readonly targets: ReadonlyMap<Element, 'open-tab' | 'withheld'>;
  readonly tabs: readonly SourceControlledTabRelationship[];
  /** Identity-only context used to avoid rescanning for unrelated mutations. */
  readonly controllers: ReadonlySet<Element>;
  readonly referencedIds: ReadonlySet<string>;
  readonly contextElements: ReadonlySet<Element>;
  readonly idElements: ReadonlySet<Element>;
  /** Oversized/unindexable IDs fail closed on that element, not the page. */
  readonly unindexableIdTargets: ReadonlySet<Element>;
  /** Only an unresolvable controller forces its own root's ID targets closed. */
  readonly withheldIdRoots: ReadonlySet<Node>;
  readonly overflow: boolean;
  /** True when the bounded scan did not inspect the complete source graph. */
  readonly incomplete: boolean;
}

type SourceElementPaintState = 'visible' | 'hidden' | 'unknown';

interface SourceElementPaintInputs {
  readonly state: SourceElementPaintState;
  readonly rects: readonly SourcePaintBounds[] | undefined;
  /**
   * The padding box, which is what an overflow clip actually confines
   * descendants to; the border box in `rects` over-approximates it. Absent
   * when the element has several fragments or no client geometry.
   */
  readonly clipRects: readonly SourcePaintBounds[] | undefined;
  readonly overflow: { readonly x: boolean; readonly y: boolean } | undefined;
  readonly readable: boolean;
}

/** One proof-generation cache; callers must discard it after the current scan. */
export interface SourcePaintScanCache {
  readonly paths: Map<Element, readonly Element[] | undefined>;
  readonly inputs: Map<Element, SourceElementPaintInputs>;
}

export function createSourcePaintScanCache(): SourcePaintScanCache {
  return {
    paths: new Map(),
    inputs: new Map(),
  };
}

/**
 * Builds one content-free relationship index shared by both base serializers
 * and the typed semantic channel. A controlled target becomes ordinary base
 * content only when one same-root, unique tab relationship has consistent
 * selected/expanded and painted visibility state.
 */
export function createSourceControlledContentPolicy(
  sourceDocument: Document | null | undefined,
  sourceWindow: Window | null | undefined = sourceDocument?.defaultView,
  maximumNodes = DEFAULT_MAX_SOURCE_CONTROLLED_NODES,
): SourceControlledContentPolicy {
  const targets = new Map<Element, 'open-tab' | 'withheld'>();
  const tabs: SourceControlledTabRelationship[] = [];
  const controllers = new Set<Element>();
  const referencedIds = new Set<string>();
  const idElements = new Set<Element>();
  const unindexableIdTargets = new Set<Element>();
  const withheldIdRoots = new Set<Node>();
  const root = sourceDocument?.documentElement;
  if (!root || !Number.isSafeInteger(maximumNodes) || maximumNodes < 1) {
    return finishSourceControlledContentPolicy(
      targets,
      tabs,
      controllers,
      referencedIds,
      idElements,
      unindexableIdTargets,
      withheldIdRoots,
      Boolean(root),
      Boolean(root),
    );
  }
  try {
    const paintCache = createSourcePaintScanCache();
    const idsByRoot = new Map<Node, Map<string, Element[]>>();
    const idsAcrossRoots = new Map<string, Element[]>();
    const pending: Node[] = [root];
    let visited = 0;
    let indexedIdBytes = 0;
    while (pending.length > 0 && visited < maximumNodes) {
      const node = pending.pop();
      if (!node) break;
      visited += 1;
      if (node.nodeType === 11) {
        pending.push(...node.childNodes);
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const scope = element.getRootNode();
      const id = safelyReadSourceAttribute(element, 'id');
      if (id) {
        idElements.add(element);
        const byteLength = sourceControlledStringByteLength(id);
        if (
          id.length > MAX_SOURCE_CONTROLLED_ID_LENGTH ||
          !Number.isFinite(byteLength) ||
          indexedIdBytes + byteLength > MAX_SOURCE_CONTROLLED_ID_BYTES
        ) {
          unindexableIdTargets.add(element);
        } else {
          indexedIdBytes += byteLength;
          let rootIds = idsByRoot.get(scope);
          if (!rootIds) idsByRoot.set(scope, rootIds = new Map());
          appendSourceControlledId(rootIds, id, element);
          appendSourceControlledId(idsAcrossRoots, id, element);
        }
      }
      if (safelyHasSourceAttribute(element, 'aria-controls')) {
        controllers.add(element);
      }
      pending.push(...element.childNodes);
      const shadowRoot = safelyReadSourceShadowRoot(element);
      if (shadowRoot) pending.push(shadowRoot);
    }
    if (
      pending.length > 0 ||
      controllers.size > MAX_SOURCE_CONTROLLED_RELATIONSHIPS
    ) {
      markResolvedSourceControlledTargets(
        [...controllers].slice(0, MAX_SOURCE_CONTROLLED_RELATIONSHIPS),
        idsByRoot,
        idsAcrossRoots,
        targets,
      );
      return finishSourceControlledContentPolicy(
        targets,
        tabs,
        controllers,
        referencedIds,
        idElements,
        unindexableIdTargets,
        controllerOverflowRoots(controllers),
        true,
        pending.length > 0,
      );
    }

    const relations = new Map<Element, Array<{
      readonly trigger: Element;
      readonly structurallyUnique: boolean;
    }>>();
    let referencedIdBytes = 0;
    let unresolved = false;
    for (const trigger of controllers) {
      const rawControls = safelyReadSourceAttribute(trigger, 'aria-controls');
      if (
        rawControls === undefined || rawControls === null ||
        rawControls.length > MAX_SOURCE_ARIA_CONTROLS_LENGTH
      ) {
        withheldIdRoots.add(trigger.getRootNode());
        unresolved = true;
        continue;
      }
      const rawIds = (rawControls ?? '').trim().split(/\s+/u).filter(Boolean);
      for (const id of rawIds) {
        const byteLength = sourceControlledStringByteLength(id);
        if (id.length > MAX_SOURCE_CONTROLLED_ID_LENGTH ||
          !Number.isFinite(byteLength)) continue;
        if (referencedIdBytes + byteLength > MAX_SOURCE_CONTROLLED_ID_BYTES) {
          withheldIdRoots.add(trigger.getRootNode());
          unresolved = true;
          break;
        }
        referencedIdBytes += byteLength;
        referencedIds.add(id);
        const sameRoot = idsByRoot.get(trigger.getRootNode())?.get(id) ?? [];
        const candidates = sameRoot.length > 0
          ? sameRoot
          : idsAcrossRoots.get(id) ?? [];
        for (const panel of candidates) {
          targets.set(panel, 'withheld');
          const entries = relations.get(panel) ?? [];
          entries.push(Object.freeze({
            trigger,
            structurallyUnique: rawIds.length === 1 &&
              isSafeSourceControlledId(id) &&
              sameRoot.length === 1 && sameRoot[0] === panel,
          }));
          relations.set(panel, entries);
        }
      }
    }

    for (const [panel, entries] of relations) {
      if (entries.length !== 1 || !entries[0]?.structurallyUnique) continue;
      const trigger = entries[0].trigger;
      const selected = readSourceControlledTabSelection(
        trigger,
        panel,
        sourceWindow,
        paintCache,
      );
      if (selected === undefined) continue;
      if (selected) targets.set(panel, 'open-tab');
      tabs.push(Object.freeze({ trigger, panel, selected }));
    }
    withholdContradictoryTablists(tabs, targets);
    return finishSourceControlledContentPolicy(
      targets,
      tabs,
      controllers,
      referencedIds,
      idElements,
      unindexableIdTargets,
      withheldIdRoots,
      unresolved,
      false,
    );
  } catch {
    return finishSourceControlledContentPolicy(
      targets,
      tabs,
      controllers,
      referencedIds,
      idElements,
      unindexableIdTargets,
      new Set<Node>([root.getRootNode()]),
      true,
      true,
    );
  }
}

export function sourceControlledContentIsWithheld(
  element: Element,
  policy: SourceControlledContentPolicy,
): boolean {
  if (policy.unindexableIdTargets.has(element)) return true;
  if (policy.withheldIdRoots.has(element.getRootNode()) && Boolean(
    safelyReadSourceAttribute(element, 'id'),
  )) return true;
  const state = policy.targets.get(element);
  return state !== undefined && state !== 'open-tab';
}

/** Identity-only target diff used to rematerialize privacy-context changes. */
export function sourceControlledContentChangedTargets(
  previous: SourceControlledContentPolicy,
  next: SourceControlledContentPolicy,
): readonly Element[] {
  const changed: Element[] = [];
  const targets = new Set<Element>([
    ...previous.targets.keys(),
    ...next.targets.keys(),
    ...previous.unindexableIdTargets,
    ...next.unindexableIdTargets,
    ...previous.idElements,
    ...next.idElements,
  ]);
  for (const target of targets) {
    if (
      previous.targets.get(target) !== next.targets.get(target) ||
      sourceControlledContentIsWithheld(target, previous) !==
        sourceControlledContentIsWithheld(target, next)
    ) {
      changed.push(target);
    }
  }
  return Object.freeze(changed);
}

/** A root-wide fallback or incomplete-scan transition needs a checkpoint. */
export function sourceControlledContentBoundaryChanged(
  previous: SourceControlledContentPolicy,
  next: SourceControlledContentPolicy,
): boolean {
  return previous.overflow !== next.overflow ||
    previous.incomplete !== next.incomplete ||
    !sameSourceNodeSet(previous.withheldIdRoots, next.withheldIdRoots);
}

/**
 * Returns whether a mutation can affect the precomputed controlled-content
 * policy. It deliberately ignores unrelated carousel/class churn while still
 * following known controllers, targets, their flat-tree ancestors, and newly
 * introduced relationship-bearing nodes.
 */
export function sourceControlledContentMutationsMayChange(
  records: readonly MutationRecord[],
  policy: SourceControlledContentPolicy,
): boolean {
  for (const record of records) {
    if (record.type === 'attributes') {
      if (record.target.nodeType !== 1) continue;
      const element = record.target as Element;
      const name = record.attributeName?.toLowerCase() ?? '';
      if (name === 'aria-controls') {
        if (policy.controllers.has(element) ||
          safelyHasSourceAttribute(element, 'aria-controls')) return true;
        continue;
      }
      if (name === 'aria-selected' || name === 'aria-expanded') {
        if (policy.controllers.has(element)) return true;
        continue;
      }
      if (name === 'id') {
        const id = safelyReadSourceAttribute(element, 'id');
        if (
          policy.idElements.has(element) ||
          policy.unindexableIdTargets.has(element) ||
          policy.withheldIdRoots.has(element.getRootNode()) ||
          (id !== undefined && id !== null &&
            id.length > MAX_SOURCE_CONTROLLED_ID_LENGTH) ||
          (id !== undefined && id !== null && policy.referencedIds.has(id))
        ) return true;
        continue;
      }
      if (name === 'role') {
        if (policy.controllers.has(element) || policy.targets.has(element)) {
          return true;
        }
        continue;
      }
      // Every remaining attribute is CSS selector surface. A custom state such
      // as `data-state="open"` on a participant or on one of its flat-tree
      // ancestors reveals or withdraws a panel exactly as `hidden` does, so
      // the same bounded layout check decides instead of a fixed name list.
      if (sourceControlledContentLayoutMayChange(element, policy)) return true;
      continue;
    }
    if (record.type === 'characterData') {
      if (
        (policy.controllers.size > 0 || policy.targets.size > 0) &&
        record.target.parentElement?.localName.toLowerCase() === 'style'
      ) return true;
      continue;
    }
    if (record.type !== 'childList') continue;
    const mutationElement = record.target.nodeType === 1
      ? record.target as Element
      : undefined;
    if (
      (mutationElement?.localName.toLowerCase() === 'style' &&
        (policy.controllers.size > 0 || policy.targets.size > 0)) ||
      (mutationElement && (
        policy.controllers.has(mutationElement) ||
        policy.targets.has(mutationElement) ||
        (sourceControlledContentLayoutMayChange(mutationElement, policy) &&
          mutationElement !== mutationElement.ownerDocument.documentElement &&
          mutationElement !== mutationElement.ownerDocument.body)
      )) ||
      controlledMutationNodesMayChange(record.addedNodes, policy) ||
      controlledMutationNodesMayChange(record.removedNodes, policy)
    ) return true;
  }
  return false;
}

/**
 * Returns whether layout work at `element` can change the painted proof of a
 * known tab/controller relationship. This covers participants, their
 * ancestors, and descendants whose collapse can change a participant's
 * painted bounds. The flat-tree walk is bounded by the same privacy path cap;
 * an unreadable path fails closed only when a relationship actually exists.
 */
export function sourceControlledContentLayoutMayChange(
  element: Element,
  policy: SourceControlledContentPolicy,
): boolean {
  if (policy.overflow || policy.incomplete) return true;
  if (policy.contextElements.has(element)) return true;
  if (policy.controllers.size === 0 && policy.targets.size === 0) return false;
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  return path.some((current) =>
    policy.controllers.has(current) || policy.targets.has(current)
  );
}

function finishSourceControlledContentPolicy(
  targets: ReadonlyMap<Element, 'open-tab' | 'withheld'>,
  tabs: readonly SourceControlledTabRelationship[],
  controllers: ReadonlySet<Element>,
  referencedIds: ReadonlySet<string>,
  idElements: ReadonlySet<Element>,
  unindexableIdTargets: ReadonlySet<Element>,
  withheldIdRoots: ReadonlySet<Node>,
  overflow: boolean,
  incomplete: boolean,
): SourceControlledContentPolicy {
  const contextElements = new Set<Element>();
  for (const participant of [...controllers, ...targets.keys()]) {
    const path = readSourceFlatTreeElementPath(participant);
    if (!path) continue;
    for (const element of path) contextElements.add(element);
  }
  return Object.freeze({
    targets,
    tabs: Object.freeze([...tabs]),
    controllers,
    referencedIds,
    contextElements,
    idElements,
    unindexableIdTargets,
    withheldIdRoots,
    overflow,
    incomplete,
  });
}

function controlledMutationNodesMayChange(
  nodes: NodeList | readonly Node[],
  policy: SourceControlledContentPolicy,
): boolean {
  const pending = Array.from(nodes);
  let visited = 0;
  while (pending.length > 0) {
    if (visited >= MAX_SOURCE_CONTROLLED_MUTATION_NODES) return true;
    const node = pending.pop();
    if (!node) break;
    visited += 1;
    if (node.nodeType === 11) {
      pending.push(...node.childNodes);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (
      policy.controllers.has(element) || policy.targets.has(element) ||
      safelyHasSourceAttribute(element, 'aria-controls')
    ) return true;
    const id = safelyReadSourceAttribute(element, 'id');
    if (
      id !== undefined && id !== null &&
      (id.length > MAX_SOURCE_CONTROLLED_ID_LENGTH ||
        policy.withheldIdRoots.has(element.getRootNode()) ||
        policy.referencedIds.has(id))
    ) return true;
    if (element.localName.toLowerCase() === 'style' &&
      (policy.controllers.size > 0 || policy.targets.size > 0)) return true;
    pending.push(...element.childNodes);
    const shadowRoot = safelyReadSourceShadowRoot(element);
    if (shadowRoot) pending.push(shadowRoot);
  }
  return false;
}

function markResolvedSourceControlledTargets(
  controllers: readonly Element[],
  idsByRoot: ReadonlyMap<Node, ReadonlyMap<string, readonly Element[]>>,
  idsAcrossRoots: ReadonlyMap<string, readonly Element[]>,
  targets: Map<Element, 'open-tab' | 'withheld'>,
): void {
  for (const controller of controllers) {
    const raw = safelyReadSourceAttribute(controller, 'aria-controls');
    if (raw === undefined || raw === null ||
      raw.length > MAX_SOURCE_ARIA_CONTROLS_LENGTH) continue;
    for (const id of raw.trim().split(/\s+/u).filter(Boolean)) {
      const sameRoot = idsByRoot.get(controller.getRootNode())?.get(id) ?? [];
      const matches = sameRoot.length > 0
        ? sameRoot
        : idsAcrossRoots.get(id) ?? [];
      for (const target of matches) targets.set(target, 'withheld');
    }
  }
}

function controllerOverflowRoots(
  controllers: ReadonlySet<Element>,
): ReadonlySet<Node> {
  const roots = new Set<Node>();
  let index = 0;
  for (const controller of controllers) {
    const raw = safelyReadSourceAttribute(controller, 'aria-controls');
    if (
      index >= MAX_SOURCE_CONTROLLED_RELATIONSHIPS || raw === undefined ||
      raw === null || raw.length > MAX_SOURCE_ARIA_CONTROLS_LENGTH
    ) roots.add(controller.getRootNode());
    index += 1;
  }
  return roots;
}

function sameSourceNodeSet(
  left: ReadonlySet<Node>,
  right: ReadonlySet<Node>,
): boolean {
  if (left.size !== right.size) return false;
  for (const node of left) {
    if (!right.has(node)) return false;
  }
  return true;
}

function appendSourceControlledId(
  index: Map<string, Element[]>,
  id: string,
  element: Element,
): void {
  const entries = index.get(id) ?? [];
  entries.push(element);
  index.set(id, entries);
}

/**
 * Each tab/panel pair is proven on its own, so two tabs of one tablist that
 * both claim selection with both panels painted would each be admitted. That
 * contradicts the unique-selection contract; every panel of such a tablist is
 * withheld instead. Tabs with no tablist ancestor cannot be related this way
 * and keep their individual proofs.
 */
function withholdContradictoryTablists(
  tabs: SourceControlledTabRelationship[],
  targets: Map<Element, 'open-tab' | 'withheld'>,
): void {
  const groups = new Map<Element, SourceControlledTabRelationship[]>();
  for (const tab of tabs) {
    const tablist = closestSourceTablist(tab.trigger);
    if (!tablist) continue;
    const group = groups.get(tablist) ?? [];
    group.push(tab);
    groups.set(tablist, group);
  }
  const contradictory = new Set<SourceControlledTabRelationship>();
  for (const group of groups.values()) {
    if (group.filter((tab) => tab.selected).length <= 1) continue;
    for (const tab of group) contradictory.add(tab);
  }
  if (contradictory.size === 0) return;
  for (const tab of contradictory) targets.set(tab.panel, 'withheld');
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const tab = tabs[index];
    if (tab && contradictory.has(tab)) tabs.splice(index, 1);
  }
}

function closestSourceTablist(trigger: Element): Element | undefined {
  const path = readSourceFlatTreeElementPath(trigger);
  if (!path) return undefined;
  for (const element of path.slice(1)) {
    if (normalizedSourceRole(element) === 'tablist') return element;
  }
  return undefined;
}

function readSourceControlledTabSelection(
  trigger: Element,
  panel: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): boolean | undefined {
  if (
    normalizedSourceRole(trigger) !== 'tab' ||
    normalizedSourceRole(panel) !== 'tabpanel' ||
    trigger === panel ||
    trigger.ownerDocument !== panel.ownerDocument ||
    trigger.getRootNode() !== panel.getRootNode() ||
    trigger.contains(panel) ||
    panel.contains(trigger) ||
    !sourceElementPathIsPainted(trigger, sourceWindow, paintCache)
  ) return undefined;
  const selected = normalizedSourceBooleanAttribute(trigger, 'aria-selected');
  if (selected === undefined) return undefined;
  const rawExpanded = safelyReadSourceAttribute(trigger, 'aria-expanded');
  if (rawExpanded === undefined) return undefined;
  if (rawExpanded !== null && rawExpanded.trim() !== '') {
    const expanded = normalizedSourceBoolean(rawExpanded);
    if (expanded === undefined || expanded !== selected) return undefined;
  }
  const panelState = sourceElementPaintState(panel, sourceWindow, paintCache);
  if (panelState !== (selected ? 'visible' : 'hidden')) return undefined;
  if (selected) {
    return sourceElementPathIsPainted(panel, sourceWindow, paintCache)
      ? true
      : undefined;
  }
  const panelPath = sourcePaintPath(panel, paintCache);
  if (!panelPath || panelPath.slice(1).some(
    (ancestor) =>
      sourceElementPaintState(ancestor, sourceWindow, paintCache) !== 'visible',
  )) return undefined;
  return selected;
}

/**
 * Content-free proof that an element has a positive painted box through its
 * complete flat-tree clipping path. Unknown style or geometry fails closed.
 */
export function sourceElementPathIsPainted(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  const path = sourcePaintPath(element, paintCache);
  if (!path || !path.every(
    (current) =>
      sourceElementPaintState(current, sourceWindow, paintCache) === 'visible',
  )) return false;
  let intersections = sourcePaintInputs(element, sourceWindow, paintCache).rects;
  if (!intersections || intersections.length === 0) return false;
  for (const ancestor of path.slice(1)) {
    if (
      ancestor === ancestor.ownerDocument.documentElement ||
      ancestor === ancestor.ownerDocument.body
    ) continue;
    const ancestorInputs = sourcePaintInputs(ancestor, sourceWindow, paintCache);
    const clipped = ancestorInputs.overflow;
    if (!clipped) return false;
    if (!clipped.x && !clipped.y) continue;
    const clips = ancestorInputs.clipRects ?? ancestorInputs.rects;
    if (!clips || clips.length === 0) return false;
    const nextIntersections: SourcePaintBounds[] = [];
    for (const intersection of intersections) {
      for (const clip of clips) {
        const next = {
          left: clipped.x
            ? Math.max(intersection.left, clip.left)
            : intersection.left,
          right: clipped.x
            ? Math.min(intersection.right, clip.right)
            : intersection.right,
          top: clipped.y
            ? Math.max(intersection.top, clip.top)
            : intersection.top,
          bottom: clipped.y
            ? Math.min(intersection.bottom, clip.bottom)
            : intersection.bottom,
        };
        if (next.right <= next.left || next.bottom <= next.top) continue;
        if (nextIntersections.length >= MAX_SOURCE_PAINT_RECTS) return false;
        nextIntersections.push(next);
      }
    }
    intersections = nextIntersections;
    if (intersections.length === 0) return false;
  }
  return true;
}

/**
 * Proves that every style, attribute, flat-tree, rectangle, and clipping input
 * consumed by `sourceElementPathIsPainted` is readable. A false result does
 * not classify authored content; it tells incremental callers that they must
 * use their conservative recovery path instead of treating two opaque reads
 * as an unchanged visibility boundary.
 */
export function sourceElementPaintInputsAreReadable(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  const path = sourcePaintPath(element, paintCache);
  if (!path) return false;
  return path.every((current) =>
    sourcePaintInputs(current, sourceWindow, paintCache).readable
  );
}

function sourceElementPaintState(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): SourceElementPaintState {
  return sourcePaintInputs(element, sourceWindow, paintCache).state;
}

interface SourcePaintBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

function sourcePaintPath(
  element: Element,
  paintCache: SourcePaintScanCache,
): readonly Element[] | undefined {
  if (paintCache.paths.has(element)) return paintCache.paths.get(element);
  const path = readSourceFlatTreeElementPath(element);
  paintCache.paths.set(element, path);
  return path;
}

function sourcePaintInputs(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): SourceElementPaintInputs {
  const retained = paintCache.inputs.get(element);
  if (retained) return retained;
  let result: SourceElementPaintInputs;
  try {
    const getComputedStyle = sourceWindow?.getComputedStyle;
    if (typeof getComputedStyle !== 'function') {
      throw new Error('Computed style is unavailable.');
    }
    const hiddenAttribute = element.hasAttribute('hidden');
    const rawAriaHidden = element.getAttribute('aria-hidden');
    const ariaHidden = rawAriaHidden === null || rawAriaHidden.trim() === ''
      ? false
      : normalizedSourceBoolean(rawAriaHidden);
    const style = getComputedStyle.call(sourceWindow, element);
    const display = style.display.trim().toLowerCase();
    const visibility = style.visibility.trim().toLowerCase();
    const opacity = style.opacity.trim();
    const contentVisibility = style.getPropertyValue('content-visibility')
      .trim().toLowerCase();
    const clip = style.getPropertyValue('clip').trim().toLowerCase();
    const clipPath = style.getPropertyValue('clip-path').trim().toLowerCase();
    const overflowX = (style.overflowX || style.getPropertyValue('overflow-x'))
      .trim().toLowerCase();
    const overflowY = (style.overflowY || style.getPropertyValue('overflow-y'))
      .trim().toLowerCase();
    const rects = readSourceElementPaintRects(element);
    if (!rects) throw new Error('Paint geometry is unreadable.');
    const computedHidden = display === 'none' || visibility === 'hidden' ||
      visibility === 'collapse' || contentVisibility === 'hidden' ||
      (opacity !== '' && Number(opacity) === 0);
    const authoredHidden = ariaHidden === undefined
      ? undefined
      : hiddenAttribute || ariaHidden;
    const state: SourceElementPaintState =
      authoredHidden === undefined || authoredHidden !== computedHidden
        ? 'unknown'
        : computedHidden
          ? 'hidden'
          : (clip !== '' && clip !== 'auto' && clip !== 'none') ||
              (clipPath !== '' && clipPath !== 'none') ||
              !sourceElementPaintBounds(rects)
            ? 'unknown'
            : 'visible';
    const clips = (value: string): boolean =>
      value === 'hidden' || value === 'clip' || value === 'scroll' ||
      value === 'auto' || value === 'overlay';
    result = Object.freeze({
      state,
      rects,
      clipRects: readSourceElementPaddingBoxRects(element, rects),
      overflow: Object.freeze({ x: clips(overflowX), y: clips(overflowY) }),
      readable: true,
    });
  } catch {
    result = Object.freeze({
      state: 'unknown',
      rects: undefined,
      clipRects: undefined,
      overflow: undefined,
      readable: false,
    });
  }
  paintCache.inputs.set(element, result);
  return result;
}

function sourceElementPaintBounds(
  rects: readonly SourcePaintBounds[],
): SourcePaintBounds | undefined {
  if (!rects || rects.length === 0) return undefined;
  const bounds = rects.reduce<SourcePaintBounds>((current, rect) => ({
    left: Math.min(current.left, rect.left),
    top: Math.min(current.top, rect.top),
    right: Math.max(current.right, rect.right),
    bottom: Math.max(current.bottom, rect.bottom),
  }), rects[0]!);
  return Object.freeze(bounds);
}

function readSourceElementPaintRects(
  element: Element,
): readonly SourcePaintBounds[] | undefined {
  try {
    if (typeof element.getClientRects !== 'function') return undefined;
    const rects = element.getClientRects();
    if (rects.length > MAX_SOURCE_PAINT_RECTS) return undefined;
    const painted: SourcePaintBounds[] = [];
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects.item(index);
      if (
        rect && [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height]
          .every(Number.isFinite) && rect.width > 0 && rect.height > 0
      ) {
        painted.push(Object.freeze({
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        }));
      }
    }
    return Object.freeze(painted);
  } catch {
    return undefined;
  }
}

/**
 * An overflow clip confines descendants to the padding box: the border box
 * shifted in by the border widths (`clientLeft`/`clientTop`) and sized by the
 * client box, which also excludes scrollbars. Only a single-fragment element
 * with client geometry yields one; others fall back to the border box.
 */
function readSourceElementPaddingBoxRects(
  element: Element,
  rects: readonly SourcePaintBounds[],
): readonly SourcePaintBounds[] | undefined {
  const [rect] = rects;
  if (!rect || rects.length !== 1) return undefined;
  const { clientLeft, clientTop, clientWidth, clientHeight } = element;
  if (
    ![clientLeft, clientTop, clientWidth, clientHeight].every(Number.isFinite) ||
    clientWidth <= 0 || clientHeight <= 0
  ) return undefined;
  const left = rect.left + clientLeft;
  const top = rect.top + clientTop;
  return Object.freeze([Object.freeze({
    left,
    top,
    right: Math.min(rect.right, left + clientWidth),
    bottom: Math.min(rect.bottom, top + clientHeight),
  })]);
}

function normalizedSourceRole(element: Element): string {
  const role = safelyReadSourceAttribute(element, 'role');
  if (role === undefined || role === null) return '';
  const tokens = role.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  return tokens.length === 1 ? tokens[0]! : '';
}

function normalizedSourceBooleanAttribute(
  element: Element,
  name: string,
): boolean | undefined {
  const value = safelyReadSourceAttribute(element, name);
  return value === undefined || value === null
    ? undefined
    : normalizedSourceBoolean(value);
}

function normalizedSourceBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' ? true : normalized === 'false' ? false : undefined;
}

function safelyReadSourceAttribute(
  element: Element,
  name: string,
): string | null | undefined {
  try {
    return element.getAttribute(name);
  } catch {
    return undefined;
  }
}

function safelyReadSourceShadowRoot(element: Element): ShadowRoot | undefined {
  try {
    return element.shadowRoot?.mode === 'open' ? element.shadowRoot : undefined;
  } catch {
    return undefined;
  }
}

function isSafeSourceControlledId(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_SOURCE_CONTROLLED_ID_LENGTH &&
    !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function sourceControlledStringByteLength(value: string): number {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

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
