import {
  sourceDocumentSecretClassifier,
  sourceFactsAreSecret,
  type StickySourceSecretClassifier,
} from './source-secret-classifier';
import { SOURCE_PRIVACY_FILTERS_OFF } from './source-privacy-mode';
import {
  readSourceAssignedSlot,
  readSourceShadowRoot,
} from './source-shadow-root';

/**
 * Native elements whose text is a value the user typed or chose. `output`
 * shows a result the page calculated and is page text (D76).
 */
export const SOURCE_PRIVATE_TAGS = Object.freeze([
  'input',
  'option',
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
/** How far below a target without a box held elements without one are looked through. */
const MAX_SOURCE_CONTROLLED_LOOK_THROUGH_DEPTH = 2;
const MAX_SOURCE_CONTROLLED_LOOKED_THROUGH_ELEMENTS = 2_048;
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

/**
 * Roles whose content is text the user is editing. A checkbox, radio or
 * switch shows its label, which is page text, and a combobox, slider or
 * spinbutton that is not an editable input shows its current choice or value
 * the way a button shows its label; those are activation roles (D75, D76).
 * An editable combobox or spinbutton is an input or a contenteditable region
 * and stays private through those.
 */
export const SOURCE_PRIVATE_ROLES = Object.freeze([
  'searchbox',
  'textbox',
] as const);

/**
 * Structural menu roles expose public labels rather than editable values.
 * Their editable descendants still start their own private regions, and an
 * editable combobox (an input or a contenteditable region) stays private.
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
  'checkbox',
  'combobox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'slider',
  'spinbutton',
  'switch',
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

/**
 * A resolved `aria-controls` target is withheld unless it is a uniquely proven
 * open tab, or the page paints it (a carousel slide, an open accordion panel;
 * D75). Such a controlled region is ordinary page content rather than a
 * collapsed disclosure; the hidden-region rules still apply to it.
 */
export type SourceControlledTargetState =
  | 'open-tab'
  | 'controlled-region'
  | 'withheld';

export interface SourceControlledContentPolicy {
  /** Every resolved target is withheld unless it is a proven open tab or a painted controlled region. */
  readonly targets: ReadonlyMap<Element, SourceControlledTargetState>;
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

/**
 * `boxless`: displayed and not hidden, with no box of positive area of its
 * own. A `display: contents` wrapper, every `<slot>`, and a block of no
 * height that holds a positioned menu or dialog are all this. Such an
 * element paints nothing itself and hides nothing: what it holds is painted
 * or not by its own boxes and by whatever clips it (D135; it used to count
 * as unknown, so nothing inside one was ever proven painted, and content
 * shown there later was never read).
 */
type SourceElementPaintState = 'visible' | 'boxless' | 'hidden' | 'unknown';

/** Whether an ancestor in this state leaves what it holds to be painted. */
function sourcePaintStateShowsDescendants(state: SourceElementPaintState): boolean {
  return state === 'visible' || state === 'boxless';
}

interface SourceElementPaintInputs {
  readonly state: SourceElementPaintState;
  /** `display: contents`: no box at all, so its overflow clips nothing. */
  readonly contents: boolean;
  /** Its `display` is read and is not `none`. */
  readonly displayed: boolean;
  /** Its own computed `visibility` hides it (`hidden` or `collapse`). */
  readonly visibilityHidden: boolean;
  readonly rects: readonly SourcePaintBounds[] | undefined;
  /**
   * The padding box, which is what an overflow clip actually confines
   * descendants to; the border box in `rects` over-approximates it. Absent
   * when the element has several fragments or no client geometry, and for
   * an element that clips nothing, where nobody asks for it (D144: four
   * layout reads an element, a seventh of a whole comparison).
   */
  readonly clipRects: readonly SourcePaintBounds[] | undefined;
  readonly overflow: { readonly x: boolean; readonly y: boolean } | undefined;
  readonly readable: boolean;
}

/** One proof-generation cache; callers must discard it after the current scan. */
export interface SourcePaintScanCache {
  readonly paths: Map<Element, readonly Element[] | undefined>;
  readonly inputs: Map<Element, SourceElementPaintInputs>;
  /** Per-element painted-path facts, each derived from its parent's. */
  readonly paintedPaths: Map<Element, SourcePaintedPathMemo>;
}

export function createSourcePaintScanCache(): SourcePaintScanCache {
  return {
    paths: new Map(),
    inputs: new Map(),
    paintedPaths: new Map(),
  };
}

/**
 * The rectangle an element's ancestors (the element included) clip its
 * flat-tree children to: `unclipped` for none, `empty` when nothing can
 * survive (or an ancestor's overflow is unreadable), and `complex` when an
 * ancestor clips to several fragments, which only the full path walk handles.
 * An axis no ancestor clips is unbounded.
 */
type SourceChildClip =
  | { readonly kind: 'unclipped' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'complex' }
  | { readonly kind: 'rect'; readonly bounds: SourcePaintBounds };

interface SourcePaintedPathMemo {
  /** Every element of the flat-tree path is readable and hides nothing. */
  readonly pathVisible: boolean;
  /** Every element of the flat-tree path is displayed (see `displayed`). */
  readonly pathDisplayed: boolean;
  /**
   * The element's own computed `visibility` hides it. Read only where the
   * path is displayed; false elsewhere, where nobody asks.
   */
  readonly visibilityHidden: boolean;
  /** Elements in the flat-tree path, the element included. */
  readonly depth: number;
  /** What this element's children are clipped to. */
  readonly childClip: SourceChildClip;
  /** The memoized `sourceElementPathIsPainted` result. */
  readonly painted: boolean;
}

const UNCLIPPED: SourceChildClip = Object.freeze({ kind: 'unclipped' });
const EMPTY_CLIP: SourceChildClip = Object.freeze({ kind: 'empty' });
const COMPLEX_CLIP: SourceChildClip = Object.freeze({ kind: 'complex' });

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
  const targets = new Map<Element, SourceControlledTargetState>();
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
    // A controlled region the page actually paints is ordinary page content,
    // whatever state its controls carry (D75): a carousel slide whose dots
    // are tabs, an accordion panel that is open. Until D75 only regions whose
    // every controller was stateless qualified, so a slider whose tab dots
    // were not painted lost every slide's text. A panel collapsed to zero
    // height, faded out or clipped away (bug-hunt P2) stays withheld until a
    // layout change proves it painted.
    for (const panel of relations.keys()) {
      if (
        targets.get(panel) === 'withheld' &&
        sourceElementBoxIsPainted(panel, sourceWindow, paintCache)
      ) targets.set(panel, 'controlled-region');
    }
    lookThroughBoxlessSourceControlledTargets(
      relations.keys(),
      targets,
      sourceWindow,
      paintCache,
    );
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
  if (policy.unindexableIdTargets.has(element)) return true;
  if (policy.withheldIdRoots.has(element.getRootNode()) && Boolean(
    safelyReadSourceAttribute(element, 'id'),
  )) return true;
  const state = policy.targets.get(element);
  return state !== undefined && state !== 'open-tab' &&
    state !== 'controlled-region';
}

/**
 * True when `element` is an `aria-controls` target that stays readable only
 * because the page paints it. Image policy still treats such a region as
 * control-adjacent.
 */
export function sourceControlledContentIsControlledRegion(
  element: Element,
  policy: SourceControlledContentPolicy,
): boolean {
  return policy.targets.get(element) === 'controlled-region';
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
  targets: ReadonlyMap<Element, SourceControlledTargetState>,
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
  targets: Map<Element, SourceControlledTargetState>,
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
  targets: Map<Element, SourceControlledTargetState>,
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
    (ancestor) => !sourcePaintStateShowsDescendants(
      sourceElementPaintState(ancestor, sourceWindow, paintCache),
    ),
  )) return undefined;
  return selected;
}

/**
 * Content-free proof that an element has a positive painted box through its
 * complete flat-tree clipping path. Unknown style or geometry fails closed.
 * An ancestor without a box of its own is no obstacle (see `boxless`), and a
 * `display: contents` element counts as painted where its own children could
 * be: it never has a box to show, and its text is drawn all the same.
 */
export function sourceElementPathIsPainted(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  return sourcePaintedPathMemo(element, sourceWindow, paintCache).painted;
}

/**
 * Whether nothing above an element, nor the element itself, hides it: every
 * element of its flat-tree path is displayed, shown and readable. Less than
 * `sourceElementPathIsPainted`, which also wants a box that survives every
 * clip: a block of no height whose text hangs out of it is not hidden,
 * though it has no box to prove painted.
 */
export function sourceElementPathIsShown(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  return sourcePaintedPathMemo(element, sourceWindow, paintCache).pathVisible;
}

/**
 * Whether what an element holds may be painted: the element is proven
 * painted, or it shows what it holds without a box of its own. A header's
 * wrapper of no height around a positioned menu, and a list item whose link
 * floats, have no box to prove and still show what they hold.
 */
export function sourceElementPathHoldsPaint(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  return sourcePaintedPathMemo(element, sourceWindow, paintCache).painted ||
    sourceElementPathShowsWithoutBox(element, sourceWindow, paintCache);
}

/**
 * Whether an element is shown, has no box of its own (see `boxless`) and
 * clips nothing away: it draws nothing and takes no room, and what it holds
 * is drawn all the same. One that clips its overflow shows nothing.
 */
export function sourceElementPathShowsWithoutBox(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  const memo = sourcePaintedPathMemo(element, sourceWindow, paintCache);
  return memo.pathVisible &&
    sourceElementPaintState(element, sourceWindow, paintCache) === 'boxless' &&
    (memo.childClip.kind === 'unclipped' || memo.childClip.kind === 'rect');
}

/**
 * Less again: no element of its flat-tree path is `display: none`, whatever
 * else hides it for now. A dialog that has just lost its `hidden` attribute
 * and is still at the first frame of a fade is displayed and not yet shown;
 * the page reader's hidden-region rule already reads it as shown.
 */
export function sourceElementPathIsDisplayed(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  return sourcePaintedPathMemo(element, sourceWindow, paintCache).pathDisplayed;
}

/** The answers above about one element, from one look at its path. */
export interface SourceElementPathPaint {
  /** `sourceElementPathIsPainted`. */
  readonly painted: boolean;
  /** `sourceElementPathIsShown`. */
  readonly pathVisible: boolean;
  /** `sourceElementPathIsDisplayed`. */
  readonly pathDisplayed: boolean;
  /**
   * Nothing above it is `display: none`, and its own computed `visibility`
   * hides it. The page reader withholds the text of such an element and
   * sends that of one that is only faded out, so the two are told apart
   * (D144): a menu that goes from `visibility: hidden` to visible at the
   * first frame of a fade from `opacity: 0` is neither shown nor painted
   * before or after, and its text arrived only when the fade ended.
   */
  readonly visibilityHidden: boolean;
}

/**
 * `sourceElementPathIsPainted`, `sourceElementPathIsShown` and
 * `sourceElementPathIsDisplayed` in one, with whether the element's own
 * `visibility` hides it: the index of what the page paints asks all of it
 * of every element at every comparison.
 */
export function readSourceElementPathPaint(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): SourceElementPathPaint {
  return sourcePaintedPathMemo(element, sourceWindow, paintCache);
}

/**
 * The same proof by walking the element's whole path: O(depth) per element,
 * which made a scan O(nodes x depth). Kept for the rare path whose clipping
 * ancestors have several fragments, and as the reference the memoized form is
 * tested against.
 */
export function sourceElementPathIsPaintedByPath(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache = createSourcePaintScanCache(),
): boolean {
  const path = sourcePaintPath(element, paintCache);
  if (!path || !path.every(
    (current) => sourcePaintStateShowsDescendants(
      sourceElementPaintState(current, sourceWindow, paintCache),
    ),
  )) return false;
  return sourcePaintSurvivesClipping(element, path, sourceWindow, paintCache);
}

/**
 * Derives an element's painted-path facts from its flat-tree parent's, so a
 * scan reads each element's style, geometry and parent link once. The
 * results equal `sourceElementPathIsPaintedByPath`: the path is visible when
 * the parent's is and the element's own state is; the element survives
 * clipping when one of its rectangles overlaps its ancestors' clip rectangle
 * with a positive area, which does not depend on the order the path walk
 * intersects them in.
 */
function sourcePaintedPathMemo(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): SourcePaintedPathMemo {
  const known = paintCache.paintedPaths.get(element);
  if (known) return known;
  // Climb to the nearest memoized ancestor, then fill in top-down.
  const chain: Element[] = [];
  let parentMemo: SourcePaintedPathMemo | undefined;
  let invalid = false;
  let current: Element | undefined = element;
  while (current) {
    chain.push(current);
    if (chain.length > MAX_SOURCE_FLAT_TREE_ANCESTORS) {
      invalid = true;
      break;
    }
    let parent: Element | undefined;
    try {
      parent = readSourceFlatTreeParentElement(current);
    } catch {
      invalid = true;
      break;
    }
    if (!parent) break;
    parentMemo = paintCache.paintedPaths.get(parent);
    if (parentMemo) break;
    current = parent;
  }
  if (invalid) {
    // An unreadable parent link or an over-deep path voids every element
    // whose path runs through it, as the path walk does.
    const failed = Object.freeze({
      pathVisible: false,
      pathDisplayed: false,
      visibilityHidden: false,
      depth: MAX_SOURCE_FLAT_TREE_ANCESTORS + 1,
      childClip: EMPTY_CLIP,
      painted: false,
    });
    for (const member of chain) paintCache.paintedPaths.set(member, failed);
    return failed;
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const member = chain[index]!;
    const memo = derivePaintedPathMemo(
      member,
      parentMemo,
      sourceWindow,
      paintCache,
    );
    paintCache.paintedPaths.set(member, memo);
    parentMemo = memo;
  }
  return parentMemo!;
}

function derivePaintedPathMemo(
  element: Element,
  parent: SourcePaintedPathMemo | undefined,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): SourcePaintedPathMemo {
  const depth = (parent?.depth ?? 0) + 1;
  if (depth > MAX_SOURCE_FLAT_TREE_ANCESTORS) {
    return Object.freeze({
      pathVisible: false,
      pathDisplayed: false,
      visibilityHidden: false,
      depth,
      childClip: EMPTY_CLIP,
      painted: false,
    });
  }
  if (parent && !parent.pathVisible) {
    // Inside something that is not shown, an element is neither shown nor
    // painted, whatever it is itself, and nothing below it asks what it
    // clips. Only whether it is displayed, and whether its own
    // `visibility` hides it, is left to read, and not even that inside
    // something that is not displayed: a closed menu of a thousand
    // entries, or a page under `aria-hidden` behind a dialog, was read
    // style by style and box by box at every comparison (D144).
    const own = parent.pathDisplayed
      ? readSourceElementDisplay(element, sourceWindow, paintCache)
      : NOT_DISPLAYED;
    return Object.freeze({
      pathVisible: false,
      pathDisplayed: own.displayed,
      visibilityHidden: own.displayed && own.visibilityHidden,
      depth,
      childClip: EMPTY_CLIP,
      painted: false,
    });
  }
  const inputs = sourcePaintInputs(element, sourceWindow, paintCache);
  const pathVisible = (parent?.pathVisible ?? true) &&
    sourcePaintStateShowsDescendants(inputs.state);
  const pathDisplayed = (parent?.pathDisplayed ?? true) && inputs.displayed;
  const ancestorClip = parent?.childClip ?? UNCLIPPED;
  let painted = false;
  if (pathVisible) {
    painted = ancestorClip.kind === 'complex'
      ? sourceElementPathIsPaintedByPath(element, sourceWindow, paintCache)
      : inputs.contents
        ? ancestorClip.kind !== 'empty'
        : rectsSurviveClip(inputs.rects, ancestorClip);
  }
  return Object.freeze({
    pathVisible,
    pathDisplayed,
    visibilityHidden: pathDisplayed && inputs.visibilityHidden,
    depth,
    childClip: childClipOf(element, inputs, ancestorClip),
    painted,
  });
}

/** Adds an element's own overflow clip to what its ancestors clip to. */
function childClipOf(
  element: Element,
  inputs: SourceElementPaintInputs,
  ancestorClip: SourceChildClip,
): SourceChildClip {
  if (ancestorClip.kind === 'empty' || ancestorClip.kind === 'complex') {
    return ancestorClip;
  }
  // The path walk never treats the root or body as a clipping ancestor.
  if (
    element === element.ownerDocument.documentElement ||
    element === element.ownerDocument.body
  ) return ancestorClip;
  const clipped = inputs.overflow;
  if (!clipped) return EMPTY_CLIP;
  if (inputs.contents || (!clipped.x && !clipped.y)) return ancestorClip;
  const clips = inputs.clipRects ?? inputs.rects;
  if (!clips || clips.length === 0) return EMPTY_CLIP;
  if (clips.length !== 1) return COMPLEX_CLIP;
  const clip = clips[0]!;
  const current = ancestorClip.kind === 'rect'
    ? ancestorClip.bounds
    : { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
  const bounds = {
    left: clipped.x ? Math.max(current.left, clip.left) : current.left,
    right: clipped.x ? Math.min(current.right, clip.right) : current.right,
    top: clipped.y ? Math.max(current.top, clip.top) : current.top,
    bottom: clipped.y ? Math.min(current.bottom, clip.bottom) : current.bottom,
  };
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    return EMPTY_CLIP;
  }
  return Object.freeze({ kind: 'rect', bounds: Object.freeze(bounds) });
}

const EVERYWHERE: readonly SourcePaintBounds[] = Object.freeze([Object.freeze({
  left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity,
})]);

function rectsSurviveClip(
  rects: readonly SourcePaintBounds[] | undefined,
  clip: SourceChildClip,
): boolean {
  if (!rects || rects.length === 0 || clip.kind === 'empty') return false;
  if (clip.kind !== 'rect') return true;
  const { bounds } = clip;
  return rects.some((rect) =>
    Math.min(rect.right, bounds.right) > Math.max(rect.left, bounds.left) &&
    Math.min(rect.bottom, bounds.bottom) > Math.max(rect.top, bounds.top));
}

/**
 * A target without a box of its own (a `display: contents` component host
 * with its popup in its root; a `display: contents` or no-height wrapper
 * around a header menu the page plainly shows) never passes the test below,
 * and used to stay withheld for good. It opens nothing by itself: it is
 * looked through. Each element it holds, among its children and its root's,
 * is judged as a target of its own would be, by that same test, and must not
 * be placed off the page; one that passes is read, and every other one is
 * withheld, so a painted button or search box never opens the closed popup
 * beside it. A held element that has no box either is looked through the
 * same way, a few levels deep. A target that holds text of its own, which no
 * box could vouch for, or nothing that passes, stays withheld whole.
 */
function lookThroughBoxlessSourceControlledTargets(
  panels: Iterable<Element>,
  targets: Map<Element, SourceControlledTargetState>,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): void {
  const budget = { left: MAX_SOURCE_CONTROLLED_LOOKED_THROUGH_ELEMENTS };
  const looked = new Map<Element, boolean>();
  const lookThrough = (element: Element, depth: number): boolean => {
    const known = looked.get(element);
    if (known !== undefined) return known;
    looked.set(element, false);
    const held = depth > MAX_SOURCE_CONTROLLED_LOOK_THROUGH_DEPTH
      ? undefined
      : readSourceElementsHeldWithoutBox(element, sourceWindow, paintCache);
    if (!held || held.length > budget.left) return false;
    budget.left -= held.length;
    const readable = held.map((child) => {
      const own = targets.get(child);
      // A target of its own keeps its own answer, looked through in its turn.
      return own === undefined
        ? (sourceElementBoxIsPainted(child, sourceWindow, paintCache) &&
          !sourceElementBoxIsOffPage(child, sourceWindow, paintCache)) ||
          lookThrough(child, depth + 1)
        : (own !== 'withheld' || lookThrough(child, 0)) &&
          !sourceElementBoxIsOffPage(child, sourceWindow, paintCache);
    });
    // Nothing it holds is painted: it stays the boundary it was.
    if (!readable.includes(true)) return false;
    held.forEach((child, index) => {
      if (!readable[index]) targets.set(child, 'withheld');
      else if ((targets.get(child) ?? 'withheld') === 'withheld') {
        targets.set(child, 'controlled-region');
      }
    });
    looked.set(element, true);
    return true;
  };
  for (const panel of panels) {
    if (targets.get(panel) === 'withheld' && lookThrough(panel, 0)) {
      targets.set(panel, 'controlled-region');
    }
  }
}

/**
 * What an element without a box of its own holds, when it can be looked
 * through: it is shown and clips nothing away, and has no text of its own.
 * Its element children and its root's; a `<slot>` among them stands for its
 * fallback content (what is slotted into it is the host's own children,
 * which are in the list already).
 */
function readSourceElementsHeldWithoutBox(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): readonly Element[] | undefined {
  if (!sourceElementPathShowsWithoutBox(element, sourceWindow, paintCache)) {
    return undefined;
  }
  try {
    const held: Element[] = [];
    const pending: Node[] = [element];
    const root = safelyReadSourceShadowRoot(element);
    if (root) pending.push(root);
    while (pending.length > 0) {
      const holder = pending.pop()!;
      for (const node of holder.childNodes) {
        if (node.nodeType === 3) {
          if ((node.nodeValue ?? '').trim() !== '') return undefined;
          continue;
        }
        if (node.nodeType !== 1) continue;
        const child = node as Element;
        if (child.localName.toLowerCase() === 'slot') pending.push(child);
        else held.push(child);
        if (held.length + pending.length > MAX_SOURCE_PAINT_RECTS) return undefined;
      }
    }
    return held;
  } catch {
    return undefined;
  }
}

/**
 * Whether an element's box lies wholly to the left of the page or above it,
 * where no scrolling reaches: how a closed popup is often put away
 * (`left: -9999px`). An element without a box is placed nowhere.
 */
function sourceElementBoxIsOffPage(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): boolean {
  const rects = sourcePaintInputs(element, sourceWindow, paintCache).rects;
  if (!rects || rects.length === 0) return false;
  // In the window, or right of it or below it: on the page.
  if (rects.some((rect) => rect.right > 0 && rect.bottom > 0)) return false;
  try {
    const fixed = sourceWindow!.getComputedStyle(element).position
      .trim().toLowerCase() === 'fixed';
    const x = fixed ? 0 : finiteScrollOffset(sourceWindow!.scrollX);
    const y = fixed ? 0 : finiteScrollOffset(sourceWindow!.scrollY);
    return rects.every((rect) => rect.right + x <= 0 || rect.bottom + y <= 0);
  } catch {
    return true;
  }
}

/**
 * The element's own box is painted (displayed, visible, not faded, skipped or
 * clipped, positive size) and some of it survives every overflow-clipping
 * ancestor. Unlike `sourceElementPathIsPainted`, ancestors are not required to
 * prove their own paint state; hidden-region rules already withhold content
 * under a hidden ancestor. Unknown geometry fails closed.
 *
 * An element that does not clip its own overflow also counts as painted when
 * one of its painted children survives the same clipping. A carousel track is
 * the case: Swiper translates the wrapper so its own box sits beside the
 * carousel window while the slide it overflows into is on screen. A panel
 * collapsed with `overflow: hidden`, faded out, or clipped away by an
 * ancestor still fails, because its children are clipped or faded with it.
 */
function sourceElementBoxIsPainted(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): boolean {
  if (sourceElementPaintState(element, sourceWindow, paintCache) !== 'visible') {
    return false;
  }
  const path = sourcePaintPath(element, paintCache);
  if (!path) return false;
  if (sourcePaintSurvivesClipping(element, path, sourceWindow, paintCache)) {
    return true;
  }
  const overflow = sourcePaintInputs(element, sourceWindow, paintCache).overflow;
  if (!overflow || overflow.x || overflow.y) return false;
  let children: readonly Element[];
  try {
    children = [...element.children];
  } catch {
    return false;
  }
  if (children.length > MAX_SOURCE_PAINT_RECTS) return false;
  return children.some((child) =>
    sourceElementPaintState(child, sourceWindow, paintCache) === 'visible' &&
    sourcePaintSurvivesClipping(
      child,
      [child, ...path],
      sourceWindow,
      paintCache,
    ));
}

function sourcePaintSurvivesClipping(
  element: Element,
  path: readonly Element[],
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): boolean {
  const inputs = sourcePaintInputs(element, sourceWindow, paintCache);
  // A `display: contents` element has no box to clip: it survives wherever
  // its ancestors leave anything at all.
  let intersections = inputs.contents && inputs.rects ? EVERYWHERE : inputs.rects;
  if (!intersections || intersections.length === 0) return false;
  for (const ancestor of path.slice(1)) {
    if (
      ancestor === ancestor.ownerDocument.documentElement ||
      ancestor === ancestor.ownerDocument.body
    ) continue;
    const ancestorInputs = sourcePaintInputs(ancestor, sourceWindow, paintCache);
    const clipped = ancestorInputs.overflow;
    if (!clipped) return false;
    if (ancestorInputs.contents || (!clipped.x && !clipped.y)) continue;
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
    const contents = display === 'contents';
    const authoredHidden = ariaHidden === undefined
      ? undefined
      : hiddenAttribute || ariaHidden;
    let state: SourceElementPaintState;
    if (contents) {
      // No box: what fades, skips or clips a box does nothing here, and
      // there is no box for a declared `hidden` to be checked against. Only
      // `visibility`, which is inherited, reaches what the element holds.
      const inherited = visibility === 'hidden' || visibility === 'collapse';
      state = authoredHidden === undefined
        ? 'unknown'
        : !inherited
          ? 'boxless'
          : authoredHidden ? 'hidden' : 'unknown';
    } else {
      const computedHidden = display === 'none' || visibility === 'hidden' ||
        visibility === 'collapse' || contentVisibility === 'hidden' ||
        (opacity !== '' && Number(opacity) === 0);
      state = authoredHidden === undefined || authoredHidden !== computedHidden
        ? 'unknown'
        : computedHidden
          ? 'hidden'
          : (clip !== '' && clip !== 'auto' && clip !== 'none') ||
              (clipPath !== '' && clipPath !== 'none')
            ? 'unknown'
            : sourceElementPaintBounds(rects)
              ? 'visible'
              : 'boxless';
    }
    const clips = (value: string): boolean =>
      value === 'hidden' || value === 'clip' || value === 'scroll' ||
      value === 'auto' || value === 'overlay';
    const overflow = Object.freeze({ x: clips(overflowX), y: clips(overflowY) });
    result = Object.freeze({
      state,
      contents,
      displayed: display !== 'none' && display !== '',
      visibilityHidden: visibility === 'hidden' || visibility === 'collapse',
      rects,
      // Read only where it is asked for: by an element that clips.
      clipRects: !contents && (overflow.x || overflow.y)
        ? readSourceElementPaddingBoxRects(element, rects)
        : undefined,
      overflow,
      readable: true,
    });
  } catch {
    result = Object.freeze({
      state: 'unknown',
      contents: false,
      displayed: false,
      visibilityHidden: false,
      rects: undefined,
      clipRects: undefined,
      overflow: undefined,
      readable: false,
    });
  }
  paintCache.inputs.set(element, result);
  return result;
}

interface SourceElementDisplay {
  readonly displayed: boolean;
  readonly visibilityHidden: boolean;
}

// A plain constant, not frozen: a call here would be kept in the side
// panel's bundle, which never reads the page's styles.
const NOT_DISPLAYED: SourceElementDisplay = {
  displayed: false,
  visibilityHidden: false,
};

/**
 * `sourcePaintInputs(element)`'s `displayed` and `visibilityHidden` by two
 * style reads, for an element of which nothing else is asked (see
 * `derivePaintedPathMemo`). Inputs already read answer first.
 */
function readSourceElementDisplay(
  element: Element,
  sourceWindow: Window | null | undefined,
  paintCache: SourcePaintScanCache,
): SourceElementDisplay {
  const retained = paintCache.inputs.get(element);
  if (retained) return retained;
  try {
    const getComputedStyle = sourceWindow?.getComputedStyle;
    if (typeof getComputedStyle !== 'function') return NOT_DISPLAYED;
    const style = getComputedStyle.call(sourceWindow, element);
    const display = style.display.trim().toLowerCase();
    if (display === 'none' || display === '') return NOT_DISPLAYED;
    const visibility = style.visibility.trim().toLowerCase();
    return {
      displayed: true,
      visibilityHidden: visibility === 'hidden' || visibility === 'collapse',
    };
  } catch {
    return NOT_DISPLAYED;
  }
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
      if (!rect) continue;
      // Each number is read once: these six reads, for every element of
      // the page, are a tenth of a whole comparison.
      const { left, top, right, bottom, width, height } = rect;
      if (
        Number.isFinite(left) && Number.isFinite(top) &&
        Number.isFinite(right) && Number.isFinite(bottom) &&
        Number.isFinite(width) && Number.isFinite(height) &&
        width > 0 && height > 0
      ) painted.push(Object.freeze({ left, top, right, bottom }));
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
    return readSourceShadowRoot(element);
  } catch {
    return undefined;
  }
}

function isSafeSourceControlledId(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_SOURCE_CONTROLLED_ID_LENGTH &&
    !/[\s\u0000-\u001f\u007f]/u.test(value);
}

/**
 * The length of `value` in UTF-8, as `TextEncoder` gives it (a surrogate
 * without its other half counts as the three bytes of U+FFFD), counted here:
 * an encoder and a buffer for every `id` of the page, at every read of the
 * relationships, was a fifth of that read on a page of 8,000 ids (D144).
 */
export function sourceControlledStringByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function isSourcePrivateTagName(value: string): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
  return PRIVATE_TAG_SET.has(value.trim().toLowerCase());
}

/**
 * Returns the rendered flat-tree element path surrounding `node`. Elements
 * start their own path; directly slotted Text nodes start at their assigned
 * slot. Assigned slots take precedence over DOM parents, then open/closed
 * shadow ancestry continues through the host. A slot in a closed root is
 * found too (D125), so what the root wraps around the slot counts for a
 * slotted node as it does in an open root. An unreadable, malformed,
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
      : readSourceFlatTreeParentElement(node);
    while (current) {
      if (
        seen.has(current) ||
        path.length >= MAX_SOURCE_FLAT_TREE_ANCESTORS
      ) return undefined;
      seen.add(current);
      path.push(current);
      current = readSourceFlatTreeParentElement(current);
    }
    return Object.freeze(path);
  } catch {
    return undefined;
  }
}

/**
 * One step of `readSourceFlatTreeElementPath`: the element `node` is drawn
 * in. Throws where that path would be `undefined`.
 */
export function readSourceFlatTreeParentElement(node: Node): Element | undefined {
  const assignedSlot = readSourceAssignedSlot(node);
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
    (!isSourceActivationRoleValue(attributes.role) ||
      isSourceNativeSelectImplicitRole(tagName, attributes.role));
}

/**
 * `combobox` (one row) and `listbox` (several) are a native select's own
 * implicit roles. Stating one on the select changes nothing, so it neither
 * makes the select an activation control nor hides its labels (D98).
 */
export function isSourceNativeSelectImplicitRole(
  tagName: string,
  value: unknown,
): boolean {
  if (!isSourceNativeSelectTagName(tagName) || typeof value !== 'string') {
    return false;
  }
  for (const role of value.trim().toLowerCase().split(/\s+/u)) {
    if (
      PRIVATE_ROLE_SET.has(role) || ACTIVATION_ROLE_SET.has(role) ||
      PUBLIC_MENU_ROLE_SET.has(role)
    ) return role === 'combobox' || role === 'listbox';
  }
  return false;
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

/** One run of a reader over many option labels; see the function below. */
export interface SourceSelectLabelWalk {
  end(): void;
  /**
   * Names the collapsed panels the mirror may open for the reader (a site
   * menu's). For the rest of the walk a dropdown inside one is read as the
   * mirror shows it once the panel is opened: hidden only by what stays
   * hidden then (see `readSourceSelectRevealer`). Without this its options
   * had no labels until the page itself showed the menu. `drawn` is the
   * mirror's own answer for a dropdown (whether it keeps the dropdown's box
   * for that moment): where given, a dropdown it does not draw is unread.
   */
  reveal(panels: Iterable<Element>, drawn?: (select: Element) => boolean): void;
}

let selectLabelWalk: {
  /** An element to whether it or anything above it is hidden. */
  readonly hidden: Map<Element, boolean>;
  readonly secretAncestors: SourceSecretAncestorMemo;
  /** Panels the mirror may open; see `SourceSelectLabelWalk.reveal`. */
  readonly revealed: Set<Element>;
  drawn: ((select: Element) => boolean) | undefined;
} | undefined;

/**
 * Opens a walk: one run of a reader that asks for the labels of many options
 * and that the page cannot interrupt, so no style can change during it.
 * Whether an element or anything above it is hidden, or secret, is then found
 * once. Without it every option of a dropdown walked up to the document three
 * times, reading each ancestor's style: a page with ten thousand options
 * paused for most of a second at every change once all their labels were
 * read (D132). End it in a `finally`, and never keep it across tasks.
 */
export function beginSourceSelectLabelWalk(): SourceSelectLabelWalk {
  const outer = selectLabelWalk;
  const walk: NonNullable<typeof selectLabelWalk> = {
    hidden: new Map<Element, boolean>(),
    secretAncestors: createSourceSecretAncestorMemo(),
    revealed: new Set<Element>(),
    drawn: undefined,
  };
  selectLabelWalk = walk;
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      selectLabelWalk = outer;
    },
    reveal: (panels, drawn) => {
      if (ended) return;
      for (const panel of panels) walk.revealed.add(panel);
      walk.drawn = drawn;
      // What was found hidden before the panels were named may sit in one.
      walk.hidden.clear();
    },
  };
}

export function isSourceSelectEntryVisuallyHidden(element: Element): boolean {
  const view = element.ownerDocument?.defaultView;
  const remembered = selectLabelWalk?.hidden;
  const known = remembered?.get(element);
  if (known !== undefined) return known;
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  // Inside a panel the mirror may open, only what stays hidden once it is
  // open counts; the panel and what is above it are shown then.
  const revealed = selectLabelWalk?.revealed;
  const opened = revealed && revealed.size > 0
    ? path.findIndex((current) => revealed.has(current))
    : -1;
  const walked: Element[] = [];
  let hidden = false;
  for (let index = 0; index < (opened < 0 ? path.length : opened); index += 1) {
    const current = path[index]!;
    const above = remembered?.get(current);
    if (above !== undefined) {
      hidden = above;
      break;
    }
    walked.push(current);
    if (
      opened < 0
        ? sourceSelectEntryIsItselfHidden(current, view)
        : sourceSelectEntryStaysHidden(current, view) ||
          (current.localName.toLowerCase() === 'select' &&
            selectLabelWalk?.drawn?.(current) === false)
    ) {
      hidden = true;
      break;
    }
  }
  // An element walked past is not hidden itself, so it shares the answer
  // found above it.
  if (remembered) for (const current of walked) remembered.set(current, hidden);
  return hidden;
}

/**
 * The element whose opening would show a dropdown that is hidden now: the
 * outermost hidden element above it, when the dropdown does not hide itself
 * and nothing between the two stays hidden. `undefined` when the dropdown is
 * shown, hides itself, or would stay hidden. A dropdown in a site menu's
 * collapsed panel is the case: the mirror may open that panel for the
 * reader, and the dropdown is then drawn with the rest of it (D132 left it
 * out until the page itself showed the menu).
 */
export function readSourceSelectRevealer(select: Element): Element | undefined {
  const view = select.ownerDocument?.defaultView;
  const path = readSourceFlatTreeElementPath(select);
  if (!path) return undefined;
  let revealer: Element | undefined;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const current = path[index]!;
    if (revealer) {
      if (sourceSelectEntryStaysHidden(current, view)) return undefined;
    } else if (sourceSelectEntryIsItselfHidden(current, view)) {
      // Its own style or box, or nothing above it, hides it.
      if (index === 0) return undefined;
      revealer = current;
    }
  }
  return revealer;
}

/**
 * Whether an element stays hidden when something above it is shown: by
 * `display`, the `hidden` attribute or skipped contents, which is what the
 * mirror leaves hidden inside a panel it opens. `visibility` and `opacity`
 * are how such a panel fades in, and the mirror shows what they hide. A
 * dropdown's own fade does count (the mirror draws it in a box of its own
 * that nothing fades in), and so does a box of no size or off the page,
 * where it has one to read.
 */
function sourceSelectEntryStaysHidden(
  current: Element,
  view: (Window & typeof globalThis) | null | undefined,
): boolean {
  if (current.hasAttribute('hidden')) return true;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  try {
    const style = view.getComputedStyle(current);
    if (
      style.display.trim().toLowerCase() === 'none' ||
      style.getPropertyValue('content-visibility').trim().toLowerCase() ===
        'hidden'
    ) return true;
    if (current.localName.toLowerCase() !== 'select') return false;
    const opacity = style.opacity.trim();
    if (opacity !== '' && Number(opacity) === 0) return true;
    // Under `display: none` it has no box at all: none to judge.
    return typeof current.getClientRects === 'function' &&
      current.getClientRects().length > 0 &&
      sourceSelectHasNoRenderedDocumentBox(current, view, style);
  } catch {
    // As for `sourceSelectEntryIsItselfHidden`: no proof of invisibility.
    return false;
  }
}

function sourceSelectEntryIsItselfHidden(
  current: Element,
  view: (Window & typeof globalThis) | null | undefined,
): boolean {
  if (current.hasAttribute('hidden')) return true;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  try {
    const style = view.getComputedStyle(current);
    const opacity = style.opacity.trim();
    if (
      style.display.trim().toLowerCase() === 'none' ||
      ['hidden', 'collapse'].includes(
        style.visibility.trim().toLowerCase(),
      ) ||
      (opacity !== '' && Number(opacity) === 0 &&
        !isSourceTransparentSelectClickTarget(current, view, style)) ||
      style.getPropertyValue('content-visibility').trim().toLowerCase() ===
        'hidden'
    ) return true;
    return current.localName.toLowerCase() === 'select' &&
      sourceSelectHasNoRenderedDocumentBox(current, view, style);
  } catch {
    // A browser-inaccessible computed style is not proof of invisibility.
    return false;
  }
}

/**
 * A select at zero opacity that still takes pointer input over a rendered box
 * is the page's click target for a styled label drawn beneath it (Wikipedia's
 * search language picker). Clicking there opens its options in the page, so it
 * is not hidden: its option labels stay readable and the replica keeps its box
 * with a transparent trigger.
 */
export function isSourceTransparentSelectClickTarget(
  select: Element,
  view: Window,
  style: CSSStyleDeclaration,
): boolean {
  try {
    const opacity = style.opacity.trim();
    return select.localName.toLowerCase() === 'select' &&
      opacity !== '' && Number(opacity) === 0 &&
      style.pointerEvents.trim().toLowerCase() !== 'none' &&
      !sourceSelectHasNoRenderedDocumentBox(select, view, style);
  } catch {
    return false;
  }
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
    if (current.localName.toLowerCase() !== 'optgroup') {
      if (!isSourceSelectWrapper(current)) return false;
      current = current.parentElement;
      continue;
    }
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
  const parentTag = readSourceSelectEntryOwner(element)?.localName.toLowerCase();
  if (
    (tagName === 'optgroup' && parentTag !== 'select') ||
    (tagName === 'option' && parentTag !== 'select' && parentTag !== 'optgroup')
  ) return false;
  return tagName === 'optgroup' ||
    sourceSelectOptionPathIsPublic(element);
}

/** Wrappers passed between a dropdown and one of its options or groups. */
const MAX_SOURCE_SELECT_WRAPPER_DEPTH = 16;

/**
 * A plain element between a dropdown and its options, or between a group
 * and its options: `<select><div><option>`. Chrome keeps such a wrapper and
 * lists the options inside it as the dropdown's own, so the mirror passes
 * through it (D135; the dropdown used to show no rows). An element that
 * makes what it holds private, or that acts, is not passed.
 */
export function isSourceSelectWrapper(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  if (
    element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    tagName === 'select' || tagName === 'option' || tagName === 'optgroup' ||
    SOURCE_NON_CONTENT_TAGS.has(tagName) || isSourceActivationTagName(tagName)
  ) return false;
  const attributes = readSourceStructuralAttributes(element);
  return !sourceElementStartsPrivateRegion(tagName, attributes) &&
    !isSourceActivationRoleValue(attributes.role);
}

/**
 * The dropdown or group that holds an option or a group as one of its
 * entries (`readSourceSelectEntries`): its parent, or the one above the
 * wrappers around it. An option in a group inside a group belongs to the
 * outer group; a group inside a group belongs to nothing. `undefined` also
 * when what is between them is not a plain wrapper, or there are too many.
 */
export function readSourceSelectEntryOwner(entry: Element): Element | undefined {
  const group = entry.localName.toLowerCase() === 'optgroup';
  let outer: Element | undefined;
  let current = entry.parentElement;
  for (let depth = 0; current && depth <= MAX_SOURCE_SELECT_WRAPPER_DEPTH; depth += 1) {
    const tagName = current.localName.toLowerCase();
    if (tagName === 'select') return outer ?? current;
    if (tagName === 'optgroup') {
      if (group) return undefined;
      outer = current;
    } else if (!isSourceSelectWrapper(current)) {
      return undefined;
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * The options and groups of a dropdown, or the options of a group, in the
 * page's order, with those inside plain wrappers as the dropdown's own.
 * `undefined` when the owner holds no wrapper with an entry in it: its own
 * children are then its entries, as they always were.
 */
export function readSourceSelectEntries(
  owner: Element,
): readonly Element[] | undefined {
  const ownerTag = owner.localName.toLowerCase();
  if (ownerTag !== 'select' && ownerTag !== 'optgroup') return undefined;
  let wrapped = false;
  for (let child = owner.firstElementChild; child; child = child.nextElementSibling) {
    const tagName = child.localName.toLowerCase();
    if (tagName === 'option' || tagName === 'optgroup') continue;
    if (
      isSourceSelectWrapper(child) &&
      child.querySelector('option,optgroup') !== null
    ) {
      wrapped = true;
      break;
    }
  }
  if (!wrapped) return undefined;
  const entries: Element[] = [];
  const pending: Array<{ readonly element: Element; readonly depth: number }> = [];
  const push = (parent: Element, depth: number): void => {
    for (let child = parent.lastElementChild; child; child = child.previousElementSibling) {
      pending.push({ element: child, depth });
    }
  };
  push(owner, 0);
  let inspected = 0;
  while (pending.length > 0) {
    const { element, depth } = pending.pop()!;
    inspected += 1;
    if (inspected > MAX_SOURCE_SELECT_DESCENDANTS) break;
    const tagName = element.localName.toLowerCase();
    if (tagName === 'option') {
      entries.push(element);
    } else if (tagName === 'optgroup') {
      // A group inside a group has no place in a dropdown: its options
      // count as the outer group's.
      if (ownerTag === 'select') entries.push(element);
      else if (depth < MAX_SOURCE_SELECT_WRAPPER_DEPTH) push(element, depth + 1);
    } else if (
      depth < MAX_SOURCE_SELECT_WRAPPER_DEPTH && isSourceSelectWrapper(element)
    ) {
      push(element, depth + 1);
    }
  }
  return Object.freeze(entries);
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
      hasSourceCredentialSecretAncestor(
        element, undefined, undefined, selectLabelWalk?.secretAncestors,
      )
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
        hasSourceCredentialSecretAncestor(
          descendant, undefined, undefined, selectLabelWalk?.secretAncestors,
        ) ||
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
      if (hasSourceCredentialSecretAncestor(
        current, undefined, undefined, selectLabelWalk?.secretAncestors,
      )) return undefined;
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

/**
 * An ARIA menu or listbox is a privacy class for its attributes and for OCR
 * capture; the replica draws it as ordinary page content either way (D88).
 * "Show everything (testing)" turns the class off (D75).
 */
export function isSourcePublicMenuRoleValue(value: unknown): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
 * Ancestor results reused within one synchronous walk of the source document.
 * The page cannot run, so its DOM and computed styles cannot change, during
 * such a walk; without this, every node re-classified its whole ancestor path
 * (a large page spent seconds there). Create one per walk and never keep it
 * across tasks. Entries map an element to whether it or an ancestor is secret,
 * and are dropped whenever the classifier learns a new secret.
 */
export interface SourceSecretAncestorMemo {
  classifier: StickySourceSecretClassifier | undefined;
  revision: number;
  readonly results: Map<Element, boolean>;
  /** Each memoized element's flat-tree depth, so a lookup can stop there. */
  readonly depths: Map<Element, number>;
}

export function createSourceSecretAncestorMemo(): SourceSecretAncestorMemo {
  return {
    classifier: undefined,
    revision: -1,
    results: new Map(),
    depths: new Map(),
  };
}

let ambientSecretAncestors: SourceSecretAncestorMemo | undefined;
let ambientSecretAncestorWalks = 0;

/**
 * Opens one run of a reader that the page cannot interrupt: until it is
 * ended, every `hasSourceCredentialSecretAncestor` asked without a memo of
 * its own shares one. A patch asks about each element it names several
 * times, and each time every element above it was classified again: a
 * `title` set on 250 elements nested in one another was 31,000
 * classifications, three times over (D144). Walks nest; end each in a
 * `finally`.
 */
export function beginSourceSecretAncestorWalk(): { end(): void } {
  ambientSecretAncestorWalks += 1;
  ambientSecretAncestors ??= createSourceSecretAncestorMemo();
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      ambientSecretAncestorWalks -= 1;
      if (ambientSecretAncestorWalks === 0) ambientSecretAncestors = undefined;
    },
  };
}

/**
 * The part of a node's flat-tree path below its nearest memoized ancestor,
 * so a lookup reads only the parent links it has not seen (D93); reading the
 * whole path first made each lookup O(depth). Undefined when the path is
 * unreadable or deeper than the limit, as `readSourceFlatTreeElementPath`.
 */
function readSourceUnmemoizedPath(
  node: Node,
  memo: SourceSecretAncestorMemo,
): {
  readonly path: readonly Element[];
  readonly secretAncestor: boolean;
  readonly baseDepth: number;
} | undefined {
  try {
    const path: Element[] = [];
    let current = node.nodeType === 1
      ? node as Element
      : readSourceFlatTreeParentElement(node);
    while (current) {
      const known = memo.results.get(current);
      if (known !== undefined) {
        const baseDepth = memo.depths.get(current);
        if (
          baseDepth === undefined ||
          baseDepth + path.length > MAX_SOURCE_FLAT_TREE_ANCESTORS
        ) return undefined;
        return { path, secretAncestor: known, baseDepth };
      }
      if (path.length >= MAX_SOURCE_FLAT_TREE_ANCESTORS) return undefined;
      path.push(current);
      current = readSourceFlatTreeParentElement(current);
    }
    return { path, secretAncestor: false, baseDepth: 0 };
  } catch {
    return undefined;
  }
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
  ownMemo?: SourceSecretAncestorMemo,
): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
  if (classifier.isSecret(node)) return true;
  const memo = ownMemo ?? ambientSecretAncestors;
  if (
    memo &&
    (memo.classifier !== classifier || memo.revision !== classifier.revision)
  ) {
    memo.results.clear();
    memo.depths.clear();
    memo.classifier = classifier;
    memo.revision = classifier.revision;
  }
  // `path` runs from the node up to the root, or up to just below the
  // nearest ancestor this walk already classified; classify from the top
  // down.
  const unmemoized = memo
    ? readSourceUnmemoizedPath(node, memo)
    : (() => {
        const full = readSourceFlatTreeElementPath(node);
        return full && { path: full, secretAncestor: false, baseDepth: 0 };
      })();
  if (!unmemoized) {
    classifier.classify(node, {
      tagName: node.nodeType === 3 ? '#text' : '#node',
      secretAncestor: true,
    });
    return true;
  }
  const { path, baseDepth } = unmemoized;
  let secretAncestor = unmemoized.secretAncestor;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const current = path[index]!;
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
    memo?.results.set(current, secretAncestor);
    memo?.depths.set(current, baseDepth + path.length - index);
  }
  if (memo && memo.revision !== classifier.revision) {
    // A new secret was learned on this path: start the next lookup afresh.
    memo.results.clear();
    memo.depths.clear();
    memo.revision = classifier.revision;
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
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
    if (tagName !== 'optgroup') {
      if (!isSourceSelectWrapper(current)) return false;
      continue;
    }
    const attributes = readSourceStructuralAttributes(current);
    if (
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
