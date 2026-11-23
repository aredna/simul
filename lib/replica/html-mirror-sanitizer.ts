import {
  readSourceOwnAccessor,
  sourceAnswersFieldNames,
  sourceAttributeList,
  sourceCall,
  sourceChildNodeList,
  sourceLocalName,
  sourceNodeType,
  sourceProperty,
} from './source-node-accessors';
import {
  MAX_SOURCE_SELECTED_OPTION_INDEXES,
  createSourceControlledContentPolicy,
  createSourceSecretAncestorMemo,
  hasSourceActivationElementAncestor,
  hasSourceCredentialSecretAncestor,
  hasSourcePrivateElementAncestor,
  hasSourcePrivateOrActivationElementAncestor,
  isSourceActivationRoleValue,
  isSourceNativeSelectImplicitRole,
  isSourceActivationTagName,
  isSourcePrivateRoleValue,
  isSourcePrivateTagName,
  isEligibleSourceTextControl,
  isSourceNativeTextControlTagName,
  isSourceOptionInsideNativeSelect,
  isSourcePublicMenuRoleValue,
  isSourceSelectEntryLeftOutOfList,
  isSourceSelectEntryVisuallyHidden,
  isSourceTransparentSelectClickTarget,
  readSourceFlatTreeElementPath,
  readSourceFlatTreeParentElement,
  readSourceSelectEntries,
  readSourceSelectEntryOwner,
  readSourceSelectRevealer,
  readSourceStructuralAttributes,
  sourceAttributesArePrivate,
  sourceControlledContentIsWithheld,
  sourceElementStartsPrivateRegionInContext,
  type SourceControlText,
  type SourceControlledContentPolicy,
  type SourceSecretAncestorMemo,
} from './source-privacy-policy';
import {
  sourceElementHidesItselfByVisibility,
  sourceElementScalesItselfToNothing,
} from './source-own-hiding';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';
import { readSourceSheetBase } from './source-sheet-base';
import {
  isSourceSecretPlaceholderTagName,
  sourceSecretPlaceholderTagName,
} from './source-secret-classifier';
import { isSafeStaticSvgDataImage } from './static-svg-data-image';
import { SOURCE_PRIVACY_FILTERS_OFF } from './source-privacy-mode';
import {
  beginSourceHeldAnimationPass,
  listSourceHeldAnimations,
  readSourceHeldAnimationStyle,
} from './source-held-animation';
import {
  beginSourceShadowRootWalk,
  canHostAuthorShadowRoot,
  readSourceAssignedSlot,
  readSourceShadowRoot,
} from './source-shadow-root';
import {
  MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER,
  MAX_ADOPTED_STYLE_RULES_PER_OWNER,
  MAX_HTML_MIRROR_ADOPTED_STYLE_RULES,
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_NODES,
  MAX_HTML_MIRROR_STRING,
} from './html-mirror-limits';
import { hasExactKeysWithOptional } from '../exact-record';
import { canonicalSvgAttributeName } from './svg-attribute-names';

// The size caps (any one string, the page, nodes, and the rule caps that
// follow them) are the Advanced settings in html-mirror-limits.ts: live
// values, re-exported here. They keep the tab and the panel responsive; they
// do not protect data (owner ruling, D63).
export {
  MAX_ADOPTED_STYLE_RULES_PER_OWNER,
  MAX_HTML_MIRROR_ADOPTED_STYLE_RULES,
  MAX_HTML_MIRROR_BYTES,
  MAX_HTML_MIRROR_NODES,
  MAX_HTML_MIRROR_STRING,
};
export const MAX_HTML_MIRROR_DEPTH = 256;
export const MAX_HTML_MIRROR_ATTRIBUTES = 512;
export const MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS = 4_096;
export const MAX_HTML_MIRROR_DIAGNOSTIC_COUNT = 1_000_000;
const MAX_ADOPTED_STYLE_SHEETS_PER_OWNER = 256;
const MAX_BROKEN_CONTROL_ICON_EDGE = 64;

/**
 * Whether the page holds more nodes than the mirror's cap, counted as the
 * walk of relationships counts them (every node from the root, with each
 * shadow root's), up to one past the cap (D210). A walk that reports itself
 * incomplete on a page within the cap stopped for another reason (a throw
 * it caught: D162's page of 131,000 children, refused as "too large"), and
 * that is said as a read that failed, not as one past the limits. Unreadable
 * counts as within it: no "too large" that cannot be shown.
 */
export function sourceDocumentPassesNodeCap(
  sourceDocument: Document | null | undefined,
): boolean {
  const root = sourceDocumentProperty(sourceDocument, 'documentElement');
  if (!root) return false;
  try {
    const pending: Node[] = [root];
    let counted = 0;
    while (pending.length > 0) {
      const node = pending.pop()!;
      counted += 1;
      if (counted > MAX_HTML_MIRROR_NODES) return true;
      const type = sourceNodeType(node);
      if (type !== 1 && type !== 11) continue;
      for (const child of sourceChildNodeList(node)) pending.push(child);
      if (type === 1) {
        const shadow = readSourceShadowRoot(node as Element);
        if (shadow) pending.push(shadow);
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * A document's base URL past its named elements (D207): a string of its
 * own is its base URL; anything else (an `<img name="baseURI">`) is read
 * again by the prototypes' accessor.
 */
function sourceDocumentBaseUrl(sourceDocument: Document): string {
  const own = sourceDocument.baseURI as unknown;
  return typeof own === 'string'
    ? own
    : readSourceOwnAccessor(sourceDocument, 'baseURI') as string;
}

/** A property of a document past its named elements (D207), or undefined without one. */
function sourceDocumentProperty<K extends keyof Document>(
  document: Document | null | undefined,
  name: K,
): Document[K] | undefined {
  return document ? sourceProperty(document, name) : undefined;
}

export class HtmlMirrorCapacityError extends Error {
  constructor(readonly diagnosticRecorded = false) {
    super('HTML mirror budget exceeded.');
    this.name = 'HtmlMirrorCapacityError';
  }
}

export type HtmlMirrorNamespace = 'html' | 'svg' | 'mathml';

/** The elements the mirror holds a place for where the reader leaves them out. */
export const HTML_MIRROR_LEFT_OUT_TAG_NAMES = Object.freeze([
  'audio', 'embed', 'iframe', 'noscript', 'object', 'script', 'template',
] as const);
export type HtmlMirrorLeftOutTagName = typeof HTML_MIRROR_LEFT_OUT_TAG_NAMES[number];
/** The attribute the mirror writes a left-out element's name in (D208). */
export const HTML_MIRROR_LEFT_OUT_ATTRIBUTE = 'data-simul-left-out';

export interface HtmlMirrorElementNode {
  readonly kind: 'element';
  readonly id: number;
  readonly namespace: HtmlMirrorNamespace;
  readonly tagName: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly children: readonly HtmlMirrorNode[];
  readonly visuallyHidden?: true;
  readonly selectedImageSource?: string;
  readonly selectedOptionIndexes?: readonly number[];
  readonly selectPickerOpen?: true;
  readonly selectPresentationStyle?: string;
  readonly controlText?: HtmlMirrorControlText;
  readonly canvasBackgroundColor?: string;
  readonly resolvedStyleSheetText?: string;
  /** The page has defined this autonomous custom element (D83). */
  readonly customElementDefined?: true;
  /** See `HtmlMirrorElementHints`. */
  readonly assignedNodeIds?: readonly number[];
  readonly shadowRoot?: HtmlMirrorShadowRoot;
  /** Canonical extension-owned shell replacing one hard-secret source root. */
  readonly opaquePlaceholder?: true;
  /**
   * On an opaque placeholder for an element the reader leaves out (D181):
   * the element's own name, which the mirror writes on it as
   * `data-simul-left-out` for the page's type selectors (D208). Never on a
   * placeholder for a secret.
   */
  readonly leftOutTagName?: HtmlMirrorLeftOutTagName;
  /**
   * The element's children (and its root's, which then says so too) come
   * in a part of the same checkpoint (D163): a read in slices stopped here.
   * It has none of its own until the part fills it.
   */
  readonly childrenFollow?: true;
  /**
   * Only in a preview (D163): the element is a box of this border-box
   * height, in CSS pixels, and nothing of what it holds was read.
   */
  readonly placeholder?: HtmlMirrorPlaceholder;
}

/** What a preview keeps of an element far from the viewport: its height (D163). */
export interface HtmlMirrorPlaceholder {
  readonly height: number;
}

/** The tallest box a placeholder may stand for, as the page's own size. */
export const MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT = 1_000_000;

/**
 * What a part of a checkpoint brings for one node marked `childrenFollow`
 * (D163): an element's children or a shadow root's.
 */
export interface HtmlMirrorCheckpointFill {
  readonly nodeId: number;
  readonly children: readonly HtmlMirrorNode[];
  /**
   * More of the node's children follow in a later fill, appended in order
   * (D163): a slice ran out in the middle of a long list. The node stays
   * waiting until a fill without it.
   */
  readonly more?: true;
}

export interface HtmlMirrorElementHints {
  readonly visuallyHidden?: true;
  readonly selectedImageSource?: string;
  readonly selectedOptionIndexes?: readonly number[];
  readonly selectPickerOpen?: true;
  readonly selectPresentationStyle?: string;
  readonly controlText?: HtmlMirrorControlText;
  readonly canvasBackgroundColor?: string;
  readonly resolvedStyleSheetText?: string;
  readonly customElementDefined?: true;
  /**
   * On a `<slot>` of a root that assigns its slots by script
   * (`slotAssignment: 'manual'`): the nodes the page's slot holds, in the
   * slot's order, by their mirror ids. No attribute says which they are, and
   * the mirror runs no page code, so the panel assigns them itself.
   */
  readonly assignedNodeIds?: readonly number[];
}

export interface HtmlMirrorControlText extends SourceControlText {
  readonly translatable: true;
}

/**
 * A shadow root of the page, open or closed (D125). `mode` is the mode of
 * the root the replica builds, which is always open: the replica runs no
 * page code, so nothing in it can tell the two apart, and Simul's own panel
 * code has to reach into the roots it builds. Whether the page closed its
 * root therefore does not travel.
 */
export interface HtmlMirrorShadowRoot {
  readonly id: number;
  readonly mode: 'open';
  readonly children: readonly HtmlMirrorNode[];
  readonly adoptedStyleSheets: readonly string[];
  /**
   * The page's root assigns its slots by script. A root can only be made
   * that way when it is attached, so the mirror has to know before it
   * builds the root; see `HtmlMirrorElementHints.assignedNodeIds`.
   */
  readonly slotAssignment?: 'manual';
  /** Its children come in a part of the checkpoint; see the element's. */
  readonly childrenFollow?: true;
}

export interface HtmlMirrorTextNode {
  readonly kind: 'text';
  readonly id: number;
  readonly text: string;
  readonly translatable: boolean;
}

export type HtmlMirrorNode = HtmlMirrorElementNode | HtmlMirrorTextNode;

/**
 * The source's parsing mode: `quirks` (no or an old doctype), `limited-quirks`
 * (the XHTML 1.0 and HTML 4.01 Transitional and Frameset doctypes, which
 * Chrome reports as `CSS1Compat` like standards mode, D97), or `standards`.
 */
export type HtmlMirrorDocumentMode = 'standards' | 'quirks' | 'limited-quirks';

export interface HtmlMirrorDocumentGraph {
  readonly root: HtmlMirrorElementNode;
  readonly adoptedStyleSheets: readonly string[];
  readonly documentMode: HtmlMirrorDocumentMode;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export interface HtmlMirrorRepresentabilitySummary {
  readonly unsafeElementOmissionCount: number;
  readonly unsupportedNodeOmissionCount: number;
  readonly depthBoundaryOmissionCount: number;
  readonly privateTextRedactionCount: number;
  readonly strippedActiveAttributeCount: number;
  readonly strippedUnsafeResourceCount: number;
  readonly unreadableStyleCount: number;
  readonly capacityOmissionCount: number;
  readonly customElementHostCount: number;
  /**
   * These two keep their names on the wire. Since D125 they count the roots
   * the mirror reads, open or closed, and the custom elements with none.
   */
  readonly customElementHostWithoutAccessibleOpenRootCount: number;
  readonly accessibleOpenShadowRootCount: number;
  readonly missingReconciliationProofFallbackCount: number;
  readonly coveredDirtyBranchFallbackCount: number;
  readonly attributeContextFallbackCount: number;
  readonly crossParentFallbackCount: number;
  readonly preservedStyleSheetCount: number;
  readonly flattenedStyleSheetCount: number;
  readonly omittedStyleSheetCount: number;
  readonly preservedSvgResourceCount: number;
  readonly blockedSvgResourceCount: number;
  readonly replicaRequestCapableResourceCount: number;
  readonly executionRiskBlockCount: number;
  readonly navigationBlockCount: number;
  readonly unsupportedSchemeBlockCount: number;
  readonly browserInaccessibleResourceCount: number;
  readonly strictResourcePolicyBlockCount: number;
}

export type HtmlMirrorRepresentabilityCollector = {
  -readonly [Key in keyof HtmlMirrorRepresentabilitySummary]: number;
};

export function createHtmlMirrorRepresentabilityCollector():
  HtmlMirrorRepresentabilityCollector {
  return {
    unsafeElementOmissionCount: 0,
    unsupportedNodeOmissionCount: 0,
    depthBoundaryOmissionCount: 0,
    privateTextRedactionCount: 0,
    strippedActiveAttributeCount: 0,
    strippedUnsafeResourceCount: 0,
    unreadableStyleCount: 0,
    capacityOmissionCount: 0,
    customElementHostCount: 0,
    customElementHostWithoutAccessibleOpenRootCount: 0,
    accessibleOpenShadowRootCount: 0,
    missingReconciliationProofFallbackCount: 0,
    coveredDirtyBranchFallbackCount: 0,
    attributeContextFallbackCount: 0,
    crossParentFallbackCount: 0,
    preservedStyleSheetCount: 0,
    flattenedStyleSheetCount: 0,
    omittedStyleSheetCount: 0,
    preservedSvgResourceCount: 0,
    blockedSvgResourceCount: 0,
    replicaRequestCapableResourceCount: 0,
    executionRiskBlockCount: 0,
    navigationBlockCount: 0,
    unsupportedSchemeBlockCount: 0,
    browserInaccessibleResourceCount: 0,
    strictResourcePolicyBlockCount: 0,
  };
}

export function snapshotHtmlMirrorRepresentability(
  value: HtmlMirrorRepresentabilitySummary,
): HtmlMirrorRepresentabilitySummary {
  return Object.freeze({ ...value });
}

const HTML_MIRROR_REPRESENTABILITY_KEYS = Object.freeze([
  'unsafeElementOmissionCount',
  'unsupportedNodeOmissionCount',
  'depthBoundaryOmissionCount',
  'privateTextRedactionCount',
  'strippedActiveAttributeCount',
  'strippedUnsafeResourceCount',
  'unreadableStyleCount',
  'capacityOmissionCount',
  'customElementHostCount',
  'customElementHostWithoutAccessibleOpenRootCount',
  'accessibleOpenShadowRootCount',
  'missingReconciliationProofFallbackCount',
  'coveredDirtyBranchFallbackCount',
  'attributeContextFallbackCount',
  'crossParentFallbackCount',
  'preservedStyleSheetCount',
  'flattenedStyleSheetCount',
  'omittedStyleSheetCount',
  'preservedSvgResourceCount',
  'blockedSvgResourceCount',
  'replicaRequestCapableResourceCount',
  'executionRiskBlockCount',
  'navigationBlockCount',
  'unsupportedSchemeBlockCount',
  'browserInaccessibleResourceCount',
  'strictResourcePolicyBlockCount',
] as const satisfies readonly (keyof HtmlMirrorRepresentabilitySummary)[]);

export function readHtmlMirrorRepresentability(
  input: unknown,
): HtmlMirrorRepresentabilitySummary | undefined {
  if (!isRecord(input) || !hasExactKeys(input, HTML_MIRROR_REPRESENTABILITY_KEYS)) {
    return undefined;
  }
  for (const key of HTML_MIRROR_REPRESENTABILITY_KEYS) {
    const value = input[key];
    if (
      !Number.isSafeInteger(value) || Number(value) < 0 ||
      Number(value) > MAX_HTML_MIRROR_DIAGNOSTIC_COUNT
    ) return undefined;
  }
  return Object.freeze({
    unsafeElementOmissionCount: input.unsafeElementOmissionCount as number,
    unsupportedNodeOmissionCount: input.unsupportedNodeOmissionCount as number,
    depthBoundaryOmissionCount: input.depthBoundaryOmissionCount as number,
    privateTextRedactionCount: input.privateTextRedactionCount as number,
    strippedActiveAttributeCount: input.strippedActiveAttributeCount as number,
    strippedUnsafeResourceCount: input.strippedUnsafeResourceCount as number,
    unreadableStyleCount: input.unreadableStyleCount as number,
    capacityOmissionCount: input.capacityOmissionCount as number,
    customElementHostCount: input.customElementHostCount as number,
    customElementHostWithoutAccessibleOpenRootCount:
      input.customElementHostWithoutAccessibleOpenRootCount as number,
    accessibleOpenShadowRootCount: input.accessibleOpenShadowRootCount as number,
    missingReconciliationProofFallbackCount:
      input.missingReconciliationProofFallbackCount as number,
    coveredDirtyBranchFallbackCount:
      input.coveredDirtyBranchFallbackCount as number,
    attributeContextFallbackCount: input.attributeContextFallbackCount as number,
    crossParentFallbackCount: input.crossParentFallbackCount as number,
    preservedStyleSheetCount: input.preservedStyleSheetCount as number,
    flattenedStyleSheetCount: input.flattenedStyleSheetCount as number,
    omittedStyleSheetCount: input.omittedStyleSheetCount as number,
    preservedSvgResourceCount: input.preservedSvgResourceCount as number,
    blockedSvgResourceCount: input.blockedSvgResourceCount as number,
    replicaRequestCapableResourceCount:
      input.replicaRequestCapableResourceCount as number,
    executionRiskBlockCount: input.executionRiskBlockCount as number,
    navigationBlockCount: input.navigationBlockCount as number,
    unsupportedSchemeBlockCount: input.unsupportedSchemeBlockCount as number,
    browserInaccessibleResourceCount:
      input.browserInaccessibleResourceCount as number,
    strictResourcePolicyBlockCount:
      input.strictResourcePolicyBlockCount as number,
  });
}

export interface HtmlMirrorIdRegistry {
  getId(node: Node): number;
}

export interface HtmlMirrorReadBudget {
  nodes: number;
  inspectedNodes: number;
  bytes: number;
  /** Distinct adopted stylesheet texts in this message. */
  styleSheets: number;
  styleRules: number;
  readonly ids: Set<number>;
  /**
   * Each distinct adopted stylesheet text in this message and its rule
   * count. Web components adopt the same few sheets into every shadow root
   * (Reddit: 45 sheets in 204 roots); a text is counted, checked and sent
   * once per message, and every further use costs one index (D84).
   */
  readonly adoptedStyleTexts: Map<string, number>;
}

export interface SourceBaseReadPolicy {
  readonly controlledContent: SourceControlledContentPolicy;
}

/** Precomputes the bounded relationship facts shared by base-content readers. */
export function createSourceBaseReadPolicy(
  sourceDocument: Document,
): SourceBaseReadPolicy {
  return Object.freeze({
    controlledContent: createSourceControlledContentPolicy(sourceDocument),
  });
}

/**
 * A controlled-content policy that also names text nodes to withhold apart
 * from the element that holds them (D203): text straight in a boxless
 * `aria-controls` target that the page does not paint, where the target's
 * painted elements are read. Optional: a policy without it withholds no
 * text on its own.
 */
export type SourceControlledContentPolicyWithTexts = SourceControlledContentPolicy & {
  readonly withheldTexts?: ReadonlySet<Node>;
};

/**
 * Whether the policy withholds this text node on its own (D203). It is
 * sent as an empty text node, as text in a hidden region is, so the tree
 * keeps its shape and a later read that paints it fills it in place.
 */
export function sourceControlledTextIsWithheld(
  text: Node,
  policy: SourceControlledContentPolicy,
): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
  const texts = (policy as SourceControlledContentPolicyWithTexts).withheldTexts;
  return texts !== undefined && texts.has(text);
}

/** True only when reading this text would be admitted by the base serializer. */
export function sourceBaseTextIsPublic(
  source: Node,
  policy: SourceBaseReadPolicy,
): boolean {
  if (policy.controlledContent.incomplete) return false;
  if (sourceControlledTextIsWithheld(source, policy.controlledContent)) return false;
  try {
    const element = nearestElement(source);
    return !element || !hasSourceBaseWithheldAncestor(
      element,
      policy.controlledContent,
    );
  } catch {
    // A detached non-element has no element privacy boundary to inherit.
    return sourceNodeType(source) !== 1;
  }
}

interface AdoptedStyleSheetRead {
  readonly cssText: string;
  readonly ruleCount: number;
}

type ReadableStyleSheetRulesResult =
  | { readonly status: 'readable'; readonly value: AdoptedStyleSheetRead }
  | { readonly status: 'unreadable' }
  | { readonly status: 'blocked' };

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
  /**
   * True when page text is withheld for a privacy reason (a private control
   * or a native select). It is a subset of `privateRegion`, which also
   * withholds hidden and controlled disclosure regions; stylesheet text is
   * kept in those.
   */
  readonly privacyRegion: boolean;
  readonly privateAttributeRegion: boolean;
  readonly activationRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
  /**
   * True for the text of a `<style>` whose CSSOM text travels as
   * `resolvedStyleSheetText`. The receiver replaces that text with the
   * resolved sheet, so it is not sent (or budgeted) twice.
   */
  readonly styleResolved?: boolean;
  /** True only below a hard-secret boundary that was already replaced. */
  readonly hardSecretRegion: boolean;
  /**
   * The parent's computed `visibility` hides its text. Unlike `display:
   * none`, a descendant can set `visibility: visible` and paint again, so
   * this is decided per element, not inherited as a withheld region (D76).
   */
  readonly visibilityHidden: boolean;
  readonly depth: number;
  readonly representability: HtmlMirrorRepresentabilityCollector;
  readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
  readonly controlledContent: SourceControlledContentPolicy;
  /** Shared by one walk; see SourceSecretAncestorMemo. */
  readonly secretAncestors: SourceSecretAncestorMemo;
  /** Shared by one walk; see `readSourceSlotRegion`. */
  readonly slotRegions: Map<Element, SourceSlotRegion>;
  /** The note of the reader this read is for; see `SourceSlotReadings`. */
  readonly slotReadings: SourceSlotReadings | undefined;
  /** A read in slices, or a preview, may leave content for later (D163). */
  readonly cut?: SourceReadCut;
}

/**
 * How a read leaves an element's content out (D163). The sliced read
 * (`beginSourceDocumentRead`) stops descending once its slice has run out
 * and queues what it left; the preview (`sanitizeSourcePreview`) stands a
 * box of the element's size in for what it holds.
 */
interface SourceReadCut {
  /** The sliced read: the slice has run out. */
  readonly expired?: () => boolean;
  /**
   * The preview: the most nodes it reads, also past elements no cut takes
   * (D180). `placeholder` asks only elements with children, so 131,000
   * empty elements in one box were read whole, in one task, as a preview.
   */
  readonly maxNodes?: number;
  /** The sliced read: an element whose content follows in a unit. */
  readonly defer?: (unit: SourceReadUnit) => void;
  /**
   * The sliced read: the first children of an element (or of its root)
   * whose list a slice stopped in, and the elements among them, which the
   * index of what is painted adds with this step.
   */
  readonly prefill?: (
    fill: HtmlMirrorCheckpointFill,
    elements: readonly Element[],
  ) => void;
  /** The preview: the height to keep instead of the content, if any. */
  readonly placeholder?: (
    element: Element,
    tagName: string,
    budget: HtmlMirrorReadBudget,
  ) => number | undefined;
  /**
   * The preview: the height of a box to stand in for an element that is
   * never cut (a dropdown) when reading it whole would pass the preview's
   * limit (D171); undefined to read it whole.
   */
  readonly wholeBox?: (
    element: Element,
    tagName: string,
    budget: HtmlMirrorReadBudget,
  ) => number | undefined;
  /**
   * The preview: a node a box before it already stands for (D169), left
   * out of the read.
   */
  readonly skip?: (node: Node) => boolean;
  /**
   * The sliced read: where the queued units, first fills and index roots
   * stand now, and taking back what was queued since (D171). An element
   * left out after a slice cut some of what it holds (a cap of adopted
   * sheets, a root whose id cannot be read) takes its cuts with it, as the
   * one-task read leaves its content out with it: else their fills went
   * out for shells no part holds, the part was refused, and the whole read
   * failed as over the limit.
   */
  readonly mark?: () => SourceReadCutMark;
  readonly rollback?: (mark: SourceReadCutMark) => void;
  /** A node was met a second time in this read: it moved while read. */
  metTwice: boolean;
}

/** See `SourceReadCut.mark` (D171). */
interface SourceReadCutMark {
  readonly units: number;
  readonly prefills: number;
  readonly indexRoots: number;
}

/**
 * An element whose content a slice left (D163): its children, and its
 * root's when it hosts one, are read later as one unit, in what the element
 * gave them when it was cut. What its ancestors say then is added to that.
 */
interface SourceReadUnit {
  readonly element: Element;
  /** Its parent when it was cut: a unit that moved since is not read. */
  readonly parent: Node | null;
  readonly nodeId: number;
  readonly shadow: ShadowRoot | undefined;
  readonly shadowId: number | undefined;
  /**
   * Which list the unit reads from: the element's own children, then its
   * root's (D135 order); and the node of that list it goes on from, when a
   * slice stopped in the middle of the list. Undefined: from the start.
   */
  readonly phase: 'light' | 'shadow';
  readonly cursor: Node | undefined;
  /** The depth its children are read at. */
  readonly depth: number;
  readonly privateRegion: boolean;
  readonly privacyRegion: boolean;
  readonly privateAttributeRegion: boolean;
  readonly activationRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly visibilityHidden: boolean;
}

/** What the boxes around a slot do to the nodes drawn in that slot. */
interface SourceSlotRegion {
  /** The slot sits in a hidden or collapsed box. */
  readonly withheld: boolean;
  /** The slot sits in a box that is edited: a text editor, a dropdown. */
  readonly privacy: boolean;
  /** The slot sits in a button or another control that acts. */
  readonly activation: boolean;
  /** Text put straight into the slot is hidden by `visibility`. */
  readonly visibilityHidden: boolean;
}

export type NativeSelectParentContext = false | 'select' | 'optgroup' | 'option';

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
  'foreignobject',
  'iframe',
  'mpath',
  'object',
  'portal',
  'script',
  'set',
  'template',
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
  'attributionsrc',
  'autofocus',
  'browsingtopics',
  'cite',
  'classid',
  'code',
  'codebase',
  // crossorigin changes how the replica fetches a resource and can carry
  // credentials or announce the extension origin; a scriptless mirror never
  // needs it on any element.
  'crossorigin',
  'data',
  'download',
  'dynsrc',
  'formaction',
  'formmethod',
  'formenctype',
  'formtarget',
  'imagesizes',
  'imagesrcset',
  'lowsrc',
  'manifest',
  'ping',
  'poster',
  'privatetoken',
  'profile',
  // A per-element referrer policy overrides the mirror frame's
  // `no-referrer` and can announce the extension URL to a resource host.
  'referrerpolicy',
  'sharedstoragewritable',
  'srcdoc',
  'target',
  'usemap',
  'xml:base',
  'xlink:href',
]);

/**
 * Control state and values the semantic channel restores under the read
 * scope. Author-written text (`alt`, `aria-label`, `title`) is page text and
 * travels with its element (D76): a stylesheet can draw it with
 * `content: attr(...)`, and a broken image shows its alt text.
 */
const PRIVATE_ATTRIBUTES = new Set([
  'aria-checked',
  'aria-controls',
  'aria-current',
  'aria-describedby',
  'aria-details',
  'aria-expanded',
  'aria-haspopup',
  'aria-labelledby',
  'aria-owns',
  'aria-pressed',
  'aria-selected',
  'aria-valuenow',
  'aria-valuetext',
  'autocomplete',
  'checked',
  'disabled',
  'label',
  'multiple',
  'name',
  'placeholder',
  'selected',
  'value',
]);

/**
 * The replica's dropdown previews set these on a trigger and read them back
 * as their own (receiverStructuralTriggerIsUnclaimed), so a source value never
 * travels, even with "Show everything (testing)" on (D75).
 */
const REPLICA_OWNED_DISCLOSURE_ATTRIBUTES = new Set([
  'aria-controls',
  'aria-expanded',
  'aria-haspopup',
]);

/**
 * State a component reflects as an attribute and draws itself by (D181,
 * owner ruling D175): `<sp-tab-panel selected>` shown by `:host([selected])`,
 * a component checkbox's checked look, a component button's disabled look,
 * the current page of a navigation styled by `[aria-current="page"]`. On an
 * element that is no native form control and holds no value these say what
 * the page draws, as `open` does, and travel; on a native control, on an
 * element that holds a value, and in a region whose attributes are private
 * (an editor, a control that acts, a menu, a hidden or collapsed panel) they
 * stay withheld as control state.
 */
const REFLECTED_STATE_ATTRIBUTES = new Set([
  'aria-current',
  'checked',
  'disabled',
  'selected',
]);

/** HTML elements whose state is the reader's own choice or a form's. */
const NATIVE_FORM_CONTROL_TAGS = new Set([
  'button',
  'datalist',
  'fieldset',
  'input',
  'meter',
  'optgroup',
  'option',
  'output',
  'progress',
  'select',
  'textarea',
]);

/** What holds a value the reader may have given: never read, only named. */
const VALUE_HOLDER_ATTRIBUTES = ['value', 'aria-valuenow', 'aria-valuetext'];

/**
 * Whether the element's reflected state may travel (see
 * `REFLECTED_STATE_ATTRIBUTES`): it is no native form control and holds no
 * value. Only the presence of a value attribute is asked.
 */
function reflectedStateMayTravel(element: Element, tagName: string): boolean {
  if (NATIVE_FORM_CONTROL_TAGS.has(tagName)) return false;
  for (const name of VALUE_HOLDER_ATTRIBUTES) {
    if (element.hasAttribute(name)) return false;
  }
  return true;
}

/**
 * Words an author writes on an element (D76). Inside a hidden or collapsed
 * region, a closed panel that a control names above all, they stay behind
 * with the region's text (D181): the mirror does not draw the region, and
 * they travelled and were held there while it was closed. In an editor
 * they still travel (D76): the editor is drawn, and its text alone is what
 * the person edits.
 */
const AUTHOR_WORD_ATTRIBUTES = new Set(['alt', 'aria-label', 'title']);

/**
 * `reflectedState`: the attribute stands on an element whose reflected state
 * may travel, outside a region whose attributes are private. The receiver,
 * which knows the tag alone, asks with `true` for what may cross at all and
 * with `false` inside a region whose attributes are private.
 */
function isPrivateBaseAttribute(
  tagName: string,
  name: string,
  reflectedState = false,
): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) {
    return REPLICA_OWNED_DISCLOSURE_ATTRIBUTES.has(name);
  }
  if (
    reflectedState && REFLECTED_STATE_ATTRIBUTES.has(name) &&
    !NATIVE_FORM_CONTROL_TAGS.has(tagName)
  ) return false;
  // A stylesheet's disabled bit is presentation state, not user-authored
  // control state.  It is required to keep a captured stylesheet inert.
  if (name === 'disabled' && (tagName === 'link' || tagName === 'style')) {
    return false;
  }
  // Slot names are inert tree-layout metadata, unlike form submission names.
  if (name === 'name' && tagName === 'slot') return false;
  // `open` is not in the list: it says what the page shows. An open details
  // or dialog shows its content, and without the attribute the replica drew
  // it closed (D75); a web component's `:host([open])` rule shows its menu
  // the same way, and without it the replica never did (D132).
  return PRIVATE_ATTRIBUTES.has(name);
}

const RAW_CONTROL_TEXT_ATTRIBUTES = new Set(['placeholder', 'value']);
/**
 * Names only Simul writes on a mirrored element: its `data-simul-*`
 * bookkeeping, and `simul:lang`, the page's language beside a translation's
 * `lang` (D124). A page attribute of such a name does not travel.
 */
function isSimulOwnedAttributeName(name: string): boolean {
  return name.startsWith('data-simul-') || name.startsWith('simul:');
}

const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';
const XLINK_NAMESPACE_URI = 'http://www.w3.org/1999/xlink';
/**
 * The name a page's `lang` in the XML namespace travels under: `xml:lang` as
 * an XHTML document writes it, as the HTML parser reads it on SVG and MathML,
 * and as a script sets it with `setAttributeNS`. Chrome draws by it before
 * the plain `lang`. An attribute of an HTML element merely named `xml:lang`
 * does nothing; it travels under its own name, so the two had to differ on
 * the wire. The mirror writes this one back into the XML namespace.
 */
export const PAGE_XML_LANGUAGE_ATTRIBUTE = 'simul:xml-lang';

/**
 * The name the document's own language travels under, on the root element:
 * what Chrome takes for the page's language where no element declares one.
 * A `<meta http-equiv="content-language">` gives it, or the HTTP header of
 * the same name; Chrome follows the pragma it read last, whatever its place
 * in the document, and never forgets one. Chrome draws by it and names it
 * in its accessibility tree. No pragma of the page travels: the page side
 * asks Chrome what the language is (`readSourceDocumentLanguage`), and the
 * mirror is given one pragma of Simul's own that says it.
 */
export const PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE = 'simul:document-lang';

/**
 * What travels as a document's language: language tags, one or a list
 * (`en_US` is written too, and Chrome takes it as it is), or nothing at all.
 */
export function isDocumentLanguageValue(value: string): boolean {
  return value.length <= 256 && /^[A-Za-z0-9_, -]*$/u.test(value);
}

/**
 * The document's language as the page's Chrome has it, or `undefined` where
 * it cannot be asked. Chrome shows it in one place a script can read: the
 * root's computed font language, while the root declares none itself. With a
 * `lang` or an `xml:lang` on the root nothing in the page is drawn by the
 * document's language, and it cannot be read.
 *
 * Chrome takes whatever the pragma holds for the language, a refresh's
 * content included, and then matches no `:lang()` rule by it. Such a value
 * does not travel: it is sent empty, a language that names none, and the
 * mirror matches no `:lang()` rule either.
 *
 * A page rule can set the root's font language too (`-webkit-locale`); that
 * is not the document's language. So Chrome is asked a second time, with
 * `:lang()`, which no rule can change. Where the root does not match, the
 * value may still be the document's: newer versions of Chrome match a
 * well-formed tag only (see `languageCanMatch`), and a document can be given
 * any. Such a value travels as it is, and the mirror's Chrome makes of it
 * what the tab's does.
 */
export function readSourceDocumentLanguage(root: Element): string | undefined {
  try {
    if (
      root.hasAttribute('lang') || root.hasAttributeNS(XML_NAMESPACE_URI, 'lang')
    ) return undefined;
    const locale = sourceDocumentProperty(root.ownerDocument, 'defaultView')?.getComputedStyle(root)
      .getPropertyValue('-webkit-locale') ?? '';
    const language = quotedCssText(locale);
    if (language === undefined) return undefined;
    if (!isDocumentLanguageValue(language)) return '';
    // Chrome answers `:lang()` for one tag only.
    if (/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u.test(language)) {
      let said = true;
      try {
        // An identifier cannot begin with a digit unless it is escaped.
        const selector = `:lang(${language.replace(/^[0-9]/u, '\\3$& ')})`;
        said = root.matches(selector) ||
          !languageCanMatch(root, language, selector);
      } catch {
        // A DOM that cannot answer is taken at its word.
      }
      if (!said) return undefined;
    }
    return language;
  } catch {
    return undefined;
  }
}

/**
 * Whether this Chrome's `:lang()` matches `language` for any element at all.
 * Chrome 138 matches whatever an element says; Chrome 154 only a well-formed
 * tag (letters first, no part over eight characters), and for any other
 * value matches nothing. It is asked of an element that says the language
 * itself and is never put into the page.
 */
function languageCanMatch(
  root: Element,
  language: string,
  selector: string,
): boolean {
  const probe = sourceCall(root.ownerDocument, 'createElement', 'span');
  probe.setAttribute('lang', language);
  return probe.matches(selector);
}

/**
 * The text between the quotes of a computed CSS string; `auto` and the like:
 * none. Chrome writes anything but plain text with a backslash, which no
 * language that travels holds, so nothing is unescaped.
 */
function quotedCssText(value: string): string | undefined {
  const text = value.trim();
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1)
    : undefined;
}

/**
 * Names travel in lowercase, and a page can hold two attributes that would
 * travel under one name: `CLASS` beside `class` in an XHTML document, or set
 * with `setAttributeNS(null, 'CLASS', …)` in an HTML one; a `class` put into
 * some namespace beside the plain one; on an SVG element an `xlink:href` a
 * script set by `setAttribute` (which is in no namespace) beside the real
 * one. Chrome reads one of them as the attribute, and it is the one the
 * mirror writes under that name: without a namespace and spelled exactly so
 * (lowercase; an SVG name in its own case, `viewBox`), or for an SVG
 * `xlink:href` the `href` of the XLink namespace. The other is some other
 * attribute to Chrome, and sending both under one name stopped the mirror
 * for good (the panel refuses an element that names an attribute twice). So
 * an attribute that is not that one stays behind when the element has that
 * one. Alone, it travels as it always did.
 */
function isTwinOfSentName(
  element: Element,
  attribute: SourceAttribute,
  name: string,
): boolean {
  const svg = element.namespaceURI === 'http://www.w3.org/2000/svg';
  if (svg && name === 'xlink:href') {
    if (attribute.namespaceURI === XLINK_NAMESPACE_URI) return false;
    const attributes = sourceAttributeList(element);
    for (let index = 0; index < attributes.length; index += 1) {
      const other = attributes[index]!;
      if (
        other.namespaceURI === XLINK_NAMESPACE_URI &&
        other.localName === 'href'
      ) return true;
    }
    return false;
  }
  const spelling = svg ? canonicalSvgAttributeName(name) : name;
  if (attribute.name === spelling && !attribute.namespaceURI) return false;
  return element.hasAttributeNS(null, spelling);
}

const XMLNS_NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';

/**
 * Whether Chrome reads no attribute of the page under the name `attribute`
 * would travel by (D181, owner ruling D175), in an HTML document. There an
 * attribute name means something in lowercase without a namespace (an SVG
 * name in its own case, `viewBox`), and an SVG `xlink:href` in the XLink
 * namespace. `CLASS` set with `setAttributeNS(null, 'CLASS', …)`, a `class`
 * put into some namespace, an `xlink:href` a script set on an SVG `use` with
 * `setAttribute` (in no namespace, so the tab draws nothing): alone, each
 * travelled under a name the mirror reads, and styled or drew there what the
 * tab does not. Nothing a page's selector names without a namespace matches
 * them either. Such an attribute stays behind. An attribute of the XML,
 * XLink or XMLNS namespace keeps its old way (it means in the mirror what it
 * means in the tab, or nothing in either). An XHTML page is read as it was:
 * its own case-sensitive selectors (`[CLASS="x"]`) style by such a name, and
 * the lowercase name keeps that right.
 */
function isAttributeChromeDoesNotRead(
  element: Element,
  attribute: SourceAttribute,
  name: string,
): boolean {
  if (!sourceDocumentIsHtml(element.ownerDocument)) return false;
  const namespace = attribute.namespaceURI;
  const svg = element.namespaceURI === 'http://www.w3.org/2000/svg';
  if (svg && name === 'xlink:href') return namespace !== XLINK_NAMESPACE_URI;
  if (!namespace) {
    return attribute.name !== (svg ? canonicalSvgAttributeName(name) : name);
  }
  return namespace !== XLINK_NAMESPACE_URI &&
    namespace !== XML_NAMESPACE_URI &&
    namespace !== XMLNS_NAMESPACE_URI;
}

/** An HTML document, not an XML one (XHTML, an SVG file). */
function sourceDocumentIsHtml(document: Document | null | undefined): boolean {
  try {
    return !/xml/iu.test(document?.contentType ?? '');
  } catch {
    return false;
  }
}

/** Whether `attribute` is the element's `lang` in the XML namespace. */
function isXmlNamespaceLanguage(attribute: SourceAttribute): boolean {
  return attribute.namespaceURI === XML_NAMESPACE_URI &&
    attribute.localName === 'lang';
}

/** What is read of one attribute of an element of the page. */
type SourceAttribute = Pick<Attr, 'name' | 'value' | 'namespaceURI' | 'localName'>;

/**
 * The `style` attribute an element is read with when it has none and a
 * script animation holds it at something: the plain one, in no namespace.
 */
const HELD_STYLE_ATTRIBUTE: SourceAttribute = Object.freeze({
  name: 'style',
  value: '',
  namespaceURI: null,
  localName: 'style',
});
const NATIVE_SELECT_PRESENTATION_ATTRIBUTES = Object.freeze({
  // A dropdown's `class` and `id` go to the panel's stand-in, so that the
  // page's rules for them (Bootstrap's floating label) apply (D181).
  select: new Set(['class', 'id', 'role']),
  option: new Set(['role']),
  optgroup: new Set(['role']),
});
const NATIVE_SELECT_SAFE_STYLE_PROPERTIES = new Set([
  'align-self', 'appearance', 'background-color', 'bottom', 'box-sizing',
  'clear', 'color', 'direction', 'display', 'float', 'font-family', 'font-size',
  'font-stretch', 'font-style', 'font-variant', 'font-weight', 'height', 'left',
  'letter-spacing', 'line-height', 'max-height', 'max-width', 'min-height',
  'min-width', 'opacity', 'order', 'position', 'right', 'text-align',
  'text-indent', 'text-transform', 'top', 'transform', 'transform-origin',
  'unicode-bidi', 'vertical-align', 'visibility', 'white-space', 'width',
  'word-spacing', 'writing-mode', 'z-index',
]);
const NATIVE_SELECT_COMPUTED_STYLE_PROPERTIES = Object.freeze([
  ...NATIVE_SELECT_SAFE_STYLE_PROPERTIES,
  'border-bottom-color', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'border-bottom-style', 'border-bottom-width',
  'border-left-color', 'border-left-style', 'border-left-width',
  'border-right-color', 'border-right-style', 'border-right-width',
  'border-top-color', 'border-top-left-radius', 'border-top-right-radius',
  'border-top-style', 'border-top-width', 'margin-block', 'margin-block-end',
  'margin-block-start', 'margin-bottom', 'margin-inline', 'margin-inline-end',
  'margin-inline-start', 'margin-left', 'margin-right', 'margin-top',
  'padding-block', 'padding-block-end', 'padding-block-start', 'padding-bottom',
  'padding-inline', 'padding-inline-end', 'padding-inline-start', 'padding-left',
  'padding-right', 'padding-top',
] as const);
const LOCAL_SVG_FRAGMENT_PATTERN = /^#[A-Za-z0-9_.:-]{1,256}$/u;
const SVG_URL_PRESENTATION_ATTRIBUTES = new Set([
  'clip-path',
  'cursor',
  'fill',
  'filter',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
]);

const PASSIVE_IMAGE_ELEMENTS = new Set(['img', 'image']);
const LEGACY_BACKGROUND_ELEMENTS = new Set([
  'body', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
]);
const PASSIVE_SVG_RESOURCE_ELEMENTS = new Set(['feimage', 'image', 'use']);
const LOCAL_SVG_REFERENCE_ELEMENTS = new Set([
  'feimage',
  'image',
  'lineargradient',
  'pattern',
  'radialgradient',
  'textpath',
  'use',
]);
const MEDIA_ACTIVE_ATTRIBUTES = new Set([
  'autoplay', 'controls', 'crossorigin', 'loop', 'muted', 'playsinline',
  'preload',
]);

/**
 * `document.compatMode` tells quirks mode apart but reports limited-quirks as
 * `CSS1Compat`, so the doctype decides that one, by the HTML parser's own
 * rule for the initial insertion mode (D97).
 */
export function sourceDocumentMode(sourceDocument: Document): HtmlMirrorDocumentMode {
  try {
    if (sourceProperty(sourceDocument, 'compatMode') === 'BackCompat') return 'quirks';
    const doctype = sourceProperty(sourceDocument, 'doctype');
    if (!doctype) return 'standards';
    const publicId = doctype.publicId.toLowerCase();
    const hasSystemId = doctype.systemId !== '';
    if (
      publicId.startsWith('-//w3c//dtd xhtml 1.0 frameset//') ||
      publicId.startsWith('-//w3c//dtd xhtml 1.0 transitional//') ||
      (hasSystemId && (
        publicId.startsWith('-//w3c//dtd html 4.01 frameset//') ||
        publicId.startsWith('-//w3c//dtd html 4.01 transitional//')
      ))
    ) return 'limited-quirks';
  } catch {
    // An unreadable doctype keeps the standards shell, as before D97.
  }
  return 'standards';
}

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
  representability = createHtmlMirrorRepresentabilityCollector(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): readonly string[] | undefined {
  let sheets: ArrayLike<CSSStyleSheet>;
  try {
    sheets = sourceProperty(owner, 'adoptedStyleSheets');
  } catch {
    incrementRepresentability(representability, 'unreadableStyleCount');
    return Object.freeze([]);
  }
  let length: number;
  try {
    length = sheets.length;
  } catch {
    incrementRepresentability(representability, 'unreadableStyleCount');
    return Object.freeze([]);
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_ADOPTED_STYLE_SHEETS_PER_OWNER
  ) {
    work.exhausted = true;
    incrementRepresentability(representability, 'capacityOmissionCount');
    return undefined;
  }
  const result: string[] = [];
  // The work budget pays for reading a sheet; a sheet this read has already
  // cached (the same one adopted by another root) costs nothing more (D84).
  let ownerRules = 0;
  let ownerCharacters = 0;
  for (let index = 0; index < length; index += 1) {
    let sheet: unknown;
    try {
      sheet = sheets[index];
    } catch {
      incrementRepresentability(representability, 'unreadableStyleCount');
      continue;
    }
    if ((typeof sheet !== 'object' && typeof sheet !== 'function') || !sheet) {
      continue;
    }
    try {
      if ((sheet as CSSStyleSheet).disabled === true) continue;
    } catch {
      incrementRepresentability(representability, 'unreadableStyleCount');
      continue;
    }
    const cacheMiss = !work.cache.has(sheet);
    const classifiedBefore = classifiedStyleOmissionCount(representability);
    let cached = work.cache.get(sheet);
    if (cacheMiss) {
      if (work.sheets + 1 > work.maxSheets) {
        work.exhausted = true;
        incrementRepresentability(representability, 'capacityOmissionCount');
        return undefined;
      }
      work.sheets += 1;
      cached = readAdoptedStyleSheet(
        sheet as CSSStyleSheet,
        baseUrl,
        work,
        representability,
        fidelityPolicy,
      );
      if (work.exhausted) return undefined;
      work.cache.set(sheet, cached ?? null);
    }
    if (!cached) {
      if (
        cacheMiss &&
        classifiedStyleOmissionCount(representability) === classifiedBefore
      ) {
        incrementRepresentability(representability, 'unreadableStyleCount');
        incrementRepresentability(
          representability,
          'browserInaccessibleResourceCount',
        );
      }
      continue;
    }
    ownerRules += cached.ruleCount;
    ownerCharacters += cached.cssText.length;
    if (
      (cacheMiss && (
        work.rules + cached.ruleCount > work.maxRules ||
        work.characters + cached.cssText.length > work.maxCharacters
      )) ||
      ownerRules > MAX_ADOPTED_STYLE_RULES_PER_OWNER ||
      ownerCharacters > MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER
    ) {
      work.exhausted = true;
      incrementRepresentability(representability, 'capacityOmissionCount');
      return undefined;
    }
    if (cacheMiss) {
      work.rules += cached.ruleCount;
      work.characters += cached.cssText.length;
    }
    result.push(cached.cssText);
    incrementRepresentability(representability, 'preservedStyleSheetCount');
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
  representability = createHtmlMirrorRepresentabilityCollector(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  slotReadings?: SourceSlotReadings,
  precomputedControlledContent?: SourceControlledContentPolicy,
): HtmlMirrorNode | undefined {
  return sanitizeSourceSubtrees(
    [source],
    registry,
    baseUrl,
    representability,
    undefined,
    undefined,
    fidelityPolicy,
    slotReadings,
    precomputedControlledContent,
  )?.[0];
}

/**
 * Serializes only the supplied roots while sharing one global source budget.
 * A live patch gives the policy its session holds, as it does for a list of
 * children and for attributes (D145): the policy made here when none is
 * given walks the whole document for every call and stops at its default
 * bound, a quarter of the mirror's own, so that a changed text or an added
 * element on a larger page was refused and the page read afresh.
 */
export function sanitizeSourceSubtrees(
  sources: readonly Node[],
  registry: HtmlMirrorIdRegistry,
  baseUrl = sources[0]?.ownerDocument?.baseURI ?? 'about:blank',
  representability = createHtmlMirrorRepresentabilityCollector(),
  budget = createHtmlMirrorReadBudget(),
  styleWork = createHtmlMirrorStyleWorkBudget(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  slotReadings?: SourceSlotReadings,
  precomputedControlledContent?: SourceControlledContentPolicy,
): readonly (HtmlMirrorNode | undefined)[] | undefined {
  try {
    const controlledContent = precomputedControlledContent ??
      createSourceControlledContentPolicy(sources[0]?.ownerDocument);
    if (controlledContent.incomplete) throw new HtmlMirrorCapacityError();
    const secretAncestors = createSourceSecretAncestorMemo();
    const slotRegions = new Map<Element, SourceSlotRegion>();
    return Object.freeze(sources.map((source) => {
      const sourceElement = nearestElement(source);
      const inheritedElement = sourceNodeType(source) === Node.ELEMENT_NODE && sourceElement
        ? composedParentElement(sourceElement)
        : sourceElement;
      const visibilityHidden = inheritedElement
        ? readSourceHiddenRegionState(inheritedElement, controlledContent)
          .visibilityHidden
        : false;
      noteSourceSlotReadingOfRoot(
        slotReadings,
        source,
        controlledContent,
        slotRegions,
        secretAncestors,
        visibilityHidden,
      );
      return serializeNode(source, {
        registry,
        baseUrl,
        budget,
        styleWork,
        privateRegion: inheritedElement
          ? hasSourceBaseWithheldAncestor(inheritedElement, controlledContent)
          : false,
        privacyRegion: inheritedElement
          ? hasSourcePrivacyWithheldAncestor(inheritedElement)
          : false,
        privateAttributeRegion: inheritedElement
          ? hasSourcePrivateAttributeElementAncestor(inheritedElement)
          : false,
        activationRegion: inheritedElement
          ? hasSourceActivationElementAncestor(inheritedElement)
          : false,
        nonContentRegion: inheritedElement
          ? hasNonContentAncestor(inheritedElement)
          : false,
        styleRegion: Boolean(sourceElement?.closest('style')),
        hardSecretRegion: inheritedElement
          ? hasSourceCredentialSecretAncestor(inheritedElement)
          : false,
        visibilityHidden,
        depth: 0,
        representability,
        fidelityPolicy,
        controlledContent,
        secretAncestors,
        slotRegions,
        slotReadings,
      });
    }));
  } catch (error) {
    if (error instanceof HtmlMirrorCapacityError && !error.diagnosticRecorded) {
      incrementRepresentability(representability, 'capacityOmissionCount');
    }
    return undefined;
  }
}

export function sanitizeSourceChildren(
  source: Node,
  registry: HtmlMirrorIdRegistry,
  baseUrl = source.ownerDocument?.baseURI ?? 'about:blank',
  representability = createHtmlMirrorRepresentabilityCollector(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  sharedBudget?: HtmlMirrorReadBudget,
  sharedStyleWork?: HtmlMirrorStyleWorkBudget,
  precomputedControlledContent?: SourceControlledContentPolicy,
  slotReadings?: SourceSlotReadings,
): readonly HtmlMirrorNode[] | undefined {
  try {
    const budget = sharedBudget ?? createHtmlMirrorReadBudget();
    const styleWork = sharedStyleWork ?? createHtmlMirrorStyleWorkBudget();
    const controlledContent = precomputedControlledContent ??
      createSourceControlledContentPolicy(source.ownerDocument);
    if (controlledContent.incomplete) throw new HtmlMirrorCapacityError();
    const result: HtmlMirrorNode[] = [];
    const parentElement = nearestElement(source);
    const privateRegion = parentElement
      ? hasSourceBaseWithheldAncestor(parentElement, controlledContent)
      : false;
    const privacyRegion = parentElement
      ? hasSourcePrivacyWithheldAncestor(parentElement)
      : false;
    const privateAttributeRegion = parentElement
      ? hasSourcePrivateAttributeElementAncestor(parentElement)
      : false;
    const activationRegion = parentElement
      ? hasSourceActivationElementAncestor(parentElement)
      : false;
    const nonContentRegion = parentElement
      ? hasNonContentAncestor(parentElement)
      : false;
    const styleRegion = Boolean(parentElement?.closest('style'));
    const hardSecretRegion = parentElement
      ? hasSourceCredentialSecretAncestor(parentElement)
      : false;
    const visibilityHidden = parentElement
      ? readSourceHiddenRegionState(parentElement, controlledContent)
        .visibilityHidden
      : false;
    const secretAncestors = createSourceSecretAncestorMemo();
    const slotRegions = new Map<Element, SourceSlotRegion>();
    noteSourceSlotReadingOfRoot(
      slotReadings,
      source,
      controlledContent,
      slotRegions,
      secretAncestors,
      false,
    );
    // The children of a host are drawn where the host's root slots them.
    const host = sourceNodeType(source) === Node.ELEMENT_NODE &&
      readSourceShadowRoot(source as Element)
      ? source as Element
      : undefined;
    for (const child of sourceStructuralChildNodes(source)) {
      const slotRegion = host
        ? readSourceSlotRegion(
            child,
            controlledContent,
            slotRegions,
            secretAncestors,
          )
        : undefined;
      if (host) {
        noteSourceSlotReading(slotReadings, child, slotRegion, visibilityHidden);
      }
      const serialized = serializeNode(child, {
        registry,
        baseUrl,
        budget,
        styleWork,
        privateRegion: privateRegion || slotRegion?.withheld === true ||
          slotRegion?.privacy === true,
        privacyRegion: privacyRegion || slotRegion?.privacy === true,
        privateAttributeRegion,
        activationRegion: activationRegion || slotRegion?.activation === true,
        nonContentRegion,
        styleRegion,
        hardSecretRegion,
        visibilityHidden: slotRegion && sourceNodeType(child) === Node.TEXT_NODE
          ? slotRegion.visibilityHidden
          : visibilityHidden,
        depth: 0,
        representability,
        fidelityPolicy,
        controlledContent,
        secretAncestors,
        slotRegions,
        slotReadings,
      });
      if (serialized) result.push(serialized);
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof HtmlMirrorCapacityError && !error.diagnosticRecorded) {
      incrementRepresentability(representability, 'capacityOmissionCount');
    }
    return undefined;
  }
}

export function sanitizeSourceAttributes(
  source: Element,
  baseUrl = source.ownerDocument?.baseURI ?? 'about:blank',
  representability = createHtmlMirrorRepresentabilityCollector(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  precomputedControlledContent?: SourceControlledContentPolicy,
): readonly (readonly [string, string])[] | undefined {
  try {
    // A hard-secret node is represented only by a fresh structural
    // checkpoint. Never let an attribute patch preserve its original tag,
    // selectors, resources, or inline presentation.
    if (hasSourceCredentialSecretAncestor(source)) return undefined;
    if (isUnsafeSourceElement(source, fidelityPolicy, baseUrl)) return undefined;
    const controlledContent = precomputedControlledContent ??
      createSourceControlledContentPolicy(source.ownerDocument);
    if (controlledContent.incomplete) {
      incrementRepresentability(representability, 'capacityOmissionCount');
      return undefined;
    }
    const privateRegion = hasSourceBaseWithheldAncestor(
      source,
      controlledContent,
    );
    const activationRegion = hasSourceActivationElementAncestor(source);
    return sanitizeAttributes(
      source,
      sourceLocalName(source).toLowerCase(),
      privateRegion,
      activationRegion,
      privateRegion || activationRegion ||
        hasSourcePrivateAttributeElementAncestor(source),
      privateRegion && !hasSourcePrivacyWithheldAncestor(source),
      false,
      baseUrl,
      representability,
      fidelityPolicy,
    );
  } catch {
    return undefined;
  }
}

/** Captures only bounded presentation facts that cannot reveal page content. */
export function sanitizeSourceElementHints(
  source: Element,
  baseUrl = source.ownerDocument?.baseURI ?? 'about:blank',
  representability?: HtmlMirrorRepresentabilityCollector,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  styleWork?: HtmlMirrorStyleWorkBudget,
  precomputedControlledContent?: SourceControlledContentPolicy,
  secretAncestors?: SourceSecretAncestorMemo,
  registry?: HtmlMirrorIdRegistry,
): HtmlMirrorElementHints {
  // This function is also used by live attribute refreshes. Establish the
  // credential boundary before reading selected image sources, CSSOM, canvas
  // color, native-control presentation, or any other authored hint.
  if (
    hasSourceCredentialSecretAncestor(source, undefined, undefined, secretAncestors)
  ) return Object.freeze({});
  const tagName = sourceLocalName(source).toLowerCase();
  const hidden = tagName === 'select'
    ? isSourceSelectVisuallyHidden(source)
    : (tagName === 'option' || tagName === 'optgroup')
      // Whether the dropdown's own list leaves it out, wherever the
      // dropdown is: the mirror's list has no row for it (D145).
      ? isSourceSelectEntryLeftOutOfList(source)
      : isCanonicalClippedSourceElement(source);
  // A dropdown that only something above it hides keeps its box in the
  // mirror, out of sight, for when the mirror opens what hides it.
  const heldOutOfSight = hidden && tagName === 'select' &&
    isSourceSelectHeldOutOfSight(source);
  const visuallyHidden = hidden && !heldOutOfSight;
  const selectedImageSource = tagName === 'img'
    && (() => {
      // A checkpoint or live patch already holds the document's policy; the
      // fallback rebuild is a bounded whole-document walk per image.
      const controlledContent = precomputedControlledContent ??
        createSourceControlledContentPolicy(source.ownerDocument);
      return !controlledContent.incomplete &&
        !hasSourceBaseWithheldAncestor(source, controlledContent);
    })()
    ? selectedSourceFor(source, baseUrl)
    : undefined;
  // The document's own `<html>`: one inside the page is an element like any
  // other, and paints no canvas.
  const canvasBackgroundColor = tagName === 'html' &&
      source === sourceDocumentProperty(source.ownerDocument, 'documentElement')
    ? readSourceCanvasBackgroundColor(source)
    : undefined;
  const resolvedStyleSheetText = fidelityPolicy === 'passive'
    ? readResolvedElementStyleSheet(
        source,
        baseUrl,
        representability,
        fidelityPolicy,
        styleWork,
      )
    : undefined;
  const selectPresentationStyle = tagName === 'select'
    ? readSourceSelectPresentationStyle(source, fidelityPolicy, heldOutOfSight)
    : undefined;
  const assignedNodeIds = tagName === 'slot' && registry
    ? readSourceManualSlotNodeIds(source, registry)
    : undefined;
  return Object.freeze({
    ...(assignedNodeIds ? { assignedNodeIds } : {}),
    ...(visuallyHidden ? { visuallyHidden: true as const } : {}),
    ...(selectedImageSource ? { selectedImageSource } : {}),
    ...(selectPresentationStyle ? { selectPresentationStyle } : {}),
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
    ...(resolvedStyleSheetText !== undefined
      ? { resolvedStyleSheetText }
      : {}),
    ...(isSourceCustomElementDefined(source)
      ? { customElementDefined: true as const }
      : {}),
  });
}

/**
 * The nodes a slot holds, by their mirror ids, where its root assigns slots
 * by script; undefined for any other slot. Only which nodes they are is
 * read: each travels, or is withheld, by its own rules.
 */
function readSourceManualSlotNodeIds(
  slot: Element,
  registry: HtmlMirrorIdRegistry,
): readonly number[] | undefined {
  if (slot.namespaceURI !== 'http://www.w3.org/1999/xhtml') return undefined;
  const root = slot.getRootNode() as Partial<ShadowRoot>;
  if (root.slotAssignment !== 'manual') return undefined;
  const ids: number[] = [];
  for (const node of (slot as HTMLSlotElement).assignedNodes()) {
    if (node.parentNode === root.host) ids.push(registry.getId(node));
  }
  return Object.freeze(ids);
}

/**
 * Whether the page has defined this autonomous custom element. Page CSS often
 * styles `:not(:defined)` (Reddit hides its sort bar and sizes placeholders
 * until its elements upgrade); the replica runs no page code, so it registers
 * an empty class of its own for the name instead (D83).
 */
function isSourceCustomElementDefined(source: Element): boolean {
  if (
    source.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    !isAutonomousCustomElementName(sourceLocalName(source))
  ) return false;
  try {
    return source.matches(':defined');
  } catch {
    return false;
  }
}

export function sanitizeSourceDocument(
  sourceDocument: Document,
  sourceWindow: Window,
  registry: HtmlMirrorIdRegistry,
  representability = createHtmlMirrorRepresentabilityCollector(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  precomputedControlledContent?: SourceControlledContentPolicy,
  slotReadings?: SourceSlotReadings,
): HtmlMirrorDocumentGraph | undefined {
  const documentElement = sourceProperty(sourceDocument, 'documentElement');
  if (!documentElement) return undefined;
  const budget = createHtmlMirrorReadBudget();
  const styleWork = createHtmlMirrorStyleWorkBudget();
  const controlledContent = precomputedControlledContent ??
    createSourceControlledContentPolicy(
      sourceDocument,
      sourceWindow,
      MAX_HTML_MIRROR_NODES,
    );
  if (controlledContent.incomplete) {
    if (sourceDocumentPassesNodeCap(sourceDocument)) {
      incrementRepresentability(representability, 'capacityOmissionCount');
    }
    return undefined;
  }
  const root = serializeNode(documentElement, {
    registry,
    baseUrl: sourceDocumentBaseUrl(sourceDocument),
    budget,
    styleWork,
    privateRegion: false,
    privacyRegion: false,
    privateAttributeRegion: false,
    activationRegion: false,
    nonContentRegion: false,
    styleRegion: false,
    hardSecretRegion: false,
    visibilityHidden: false,
    depth: 0,
    representability,
    fidelityPolicy,
    controlledContent,
    secretAncestors: createSourceSecretAncestorMemo(),
    slotRegions: new Map(),
    slotReadings,
  });
  if (!root || root.kind !== 'element' || root.tagName !== 'html') return undefined;
  const adoptedStyleSheets = captureAdoptedStyleSheets(
    sourceDocument,
    sourceDocumentBaseUrl(sourceDocument),
    budget,
    styleWork,
    representability,
    fidelityPolicy,
  );
  if (!adoptedStyleSheets) return undefined;
  return Object.freeze({
    root,
    adoptedStyleSheets,
    documentMode: sourceDocumentMode(sourceDocument),
    viewportWidth: boundedDimension(sourceWindow.innerWidth),
    viewportHeight: boundedDimension(sourceWindow.innerHeight),
    documentWidth: boundedDimension(Math.max(
      documentElement.scrollWidth,
      sourceProperty(sourceDocument, 'body')?.scrollWidth ?? 0,
    )),
    documentHeight: boundedDimension(Math.max(
      documentElement.scrollHeight,
      sourceProperty(sourceDocument, 'body')?.scrollHeight ?? 0,
    )),
  });
}

/**
 * The context a shell's children are checked in (D163): what the graph
 * above the shell says, as `readHtmlMirrorNode` passes it down.
 */
export interface HtmlMirrorShellContext {
  readonly depth: number;
  readonly privateRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
  readonly privateAttributeRegion: boolean;
  readonly activationRegion: boolean;
  readonly nativeSelectParent: NativeSelectParentContext;
}

/**
 * Which shells a graph being checked may hold, and the ones it held (D163):
 * `childrenFollow` only in a checkpoint sent in parts and in its parts,
 * `placeholder` only in a preview. Each `childrenFollow` node checked is
 * noted with the context its children are to be checked in, by its id;
 * `readHtmlMirrorFillChildren` takes it off.
 */
export interface HtmlMirrorShellLedger {
  readonly childrenFollow: boolean;
  readonly placeholder: boolean;
  readonly pending: Map<number, HtmlMirrorShellContext>;
}

export function createHtmlMirrorShellLedger(
  allowed: { readonly childrenFollow?: boolean; readonly placeholder?: boolean },
): HtmlMirrorShellLedger {
  return {
    childrenFollow: allowed.childrenFollow === true,
    placeholder: allowed.placeholder === true,
    pending: new Map(),
  };
}

/**
 * Checks what a part brings for one shell, in the context the shell was
 * checked in, against the budget the shell's graph was checked with: the
 * ids, nodes and bytes of every part are counted as one graph's. The fill
 * may hold shells of its own. Undefined for a node that is no pending shell
 * (unknown, or filled already) and for children that do not pass.
 */
export function readHtmlMirrorFillChildren(
  nodeId: unknown,
  input: unknown,
  budget: HtmlMirrorReadBudget,
  ledger: HtmlMirrorShellLedger,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  /** More of the shell's children follow (D163): it stays pending. */
  more = false,
): readonly HtmlMirrorNode[] | undefined {
  if (!isNodeId(nodeId) || !Array.isArray(input)) return undefined;
  const context = ledger.pending.get(nodeId);
  if (!context) return undefined;
  if (!more) ledger.pending.delete(nodeId);
  const children: HtmlMirrorNode[] = [];
  for (const child of input) {
    const parsed = readHtmlMirrorNode(
      child,
      budget.ids,
      context.depth,
      budget,
      context.privateRegion,
      context.nonContentRegion,
      context.styleRegion,
      context.privateAttributeRegion,
      context.activationRegion,
      fidelityPolicy,
      context.nativeSelectParent,
      false,
      ledger,
    );
    if (!parsed) return undefined;
    children.push(parsed);
  }
  return Object.freeze(children);
}

/**
 * Whether a node may stand without its content (D163): not a dropdown or
 * anything in one, not a style sheet or anything in one, nothing void, and
 * not a secret root's shell, which holds nothing anyway.
 */
function isValidTransportedShell(
  tagName: string,
  styleRegion: boolean,
  nativeSelectParent: NativeSelectParentContext,
  opaquePlaceholder: boolean,
  childCount: number,
): boolean {
  return childCount === 0 && !opaquePlaceholder && !styleRegion &&
    nativeSelectParent === false && tagName !== 'style' &&
    !isNativeSelectSemanticTag(tagName) && !isVoidElement(tagName);
}

function readTransportedPlaceholder(
  input: unknown,
): HtmlMirrorPlaceholder | undefined {
  if (
    !isRecord(input) || !hasExactKeys(input, ['height']) ||
    typeof input.height !== 'number' || !Number.isFinite(input.height) ||
    input.height < 0 || input.height > MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT
  ) return undefined;
  return Object.freeze({ height: input.height });
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
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  nativeSelectParent: NativeSelectParentContext = false,
  attributeSentinel = false,
  shells?: HtmlMirrorShellLedger,
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
      nativeSelectParent !== false ||
      (privateRegion && input.text !== '') ||
      ((privateRegion || nonContentRegion) && input.translatable) ||
      (styleRegion && sanitizeCss(
        input.text,
        'about:blank',
        false,
        undefined,
        fidelityPolicy,
      ) !== input.text)
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
    ], [
      'visuallyHidden', 'selectedImageSource', 'selectedOptionIndexes',
      'selectPickerOpen', 'selectPresentationStyle', 'controlText',
      'canvasBackgroundColor', 'resolvedStyleSheetText',
      'customElementDefined', 'assignedNodeIds', 'shadowRoot',
      'opaquePlaceholder', 'leftOutTagName', 'childrenFollow', 'placeholder',
    ]) ||
    !isNamespace(input.namespace) ||
    !isSafeTagName(input.tagName) ||
    !isRepresentableTagName(input.tagName, input.namespace) ||
    isUnsafeElement(input.tagName, fidelityPolicy) ||
    !Array.isArray(input.attributes) ||
    input.attributes.length > MAX_HTML_MIRROR_ATTRIBUTES ||
    !Array.isArray(input.children)
  ) return undefined;
  const opaquePlaceholder = input.opaquePlaceholder === true;
  const leftOutTagName = input.leftOutTagName;
  if (
    (leftOutTagName !== undefined &&
      (!opaquePlaceholder || !isHtmlMirrorLeftOutTagName(leftOutTagName))) ||
    (input.opaquePlaceholder !== undefined && !opaquePlaceholder) ||
    (opaquePlaceholder
      ? (
        input.namespace !== 'html' ||
        !isSourceSecretPlaceholderTagName(input.tagName, Number(input.id)) ||
        input.attributes.length !== 0 ||
        input.children.length !== 0 ||
        input.visuallyHidden !== undefined ||
        input.selectedImageSource !== undefined ||
        input.selectedOptionIndexes !== undefined ||
        input.selectPickerOpen !== undefined ||
        input.selectPresentationStyle !== undefined ||
        input.controlText !== undefined ||
        input.canvasBackgroundColor !== undefined ||
        input.resolvedStyleSheetText !== undefined ||
        input.customElementDefined !== undefined ||
        input.shadowRoot !== undefined
      )
      : isSourceSecretPlaceholderTagName(input.tagName))
  ) return undefined;
  // A shell (D163): allowed only where the ledger says, and only where the
  // panel can put the content back in.
  const childrenFollow = input.childrenFollow !== undefined;
  const placeholder = input.placeholder !== undefined
    ? readTransportedPlaceholder(input.placeholder)
    : undefined;
  if (
    (childrenFollow && (
      input.childrenFollow !== true || !shells?.childrenFollow ||
      input.placeholder !== undefined ||
      !isValidTransportedShell(
        input.tagName,
        styleRegion,
        nativeSelectParent,
        opaquePlaceholder,
        input.children.length,
      )
    )) ||
    (input.placeholder !== undefined && (
      !placeholder || !shells?.placeholder ||
      !(
        isValidTransportedShell(
          input.tagName,
          styleRegion,
          nativeSelectParent,
          opaquePlaceholder,
          input.children.length,
        ) ||
        // The preview's box of a dropdown (D171), with nothing chosen.
        (
          input.tagName === 'select' && input.namespace === 'html' &&
          input.children.length === 0 && !opaquePlaceholder && !styleRegion &&
          nativeSelectParent === false &&
          input.selectedOptionIndexes === undefined &&
          input.selectPickerOpen === undefined
        )
      ) ||
      // Nothing of a placeholder's root travels either.
      input.shadowRoot !== undefined
    ))
  ) return undefined;
  if (placeholder) budget.bytes += 24;
  const assignedNodeIds = readHtmlMirrorAssignedNodeIds(
    input.assignedNodeIds,
    input.namespace,
    input.tagName,
  );
  if (input.assignedNodeIds !== undefined && !assignedNodeIds) return undefined;
  // Counted against the page; the element's own size is checked below.
  if (assignedNodeIds) budget.bytes += assignedNodeIds.length * 8 + 16;
  if (
    !isValidTransportedNativeSelectPlacement(
      input.namespace,
      input.tagName,
      nativeSelectParent,
    ) ||
    (isNativeSelectSemanticTag(input.tagName) && input.shadowRoot !== undefined) ||
    (input.tagName === 'option' && input.children.length !== 0)
  ) return undefined;
  if (
    (input.visuallyHidden !== undefined && input.visuallyHidden !== true) ||
    (input.customElementDefined !== undefined && (
      input.customElementDefined !== true ||
      input.namespace !== 'html' ||
      !isAutonomousCustomElementName(input.tagName)
    )) ||
    input.selectPickerOpen !== undefined ||
    input.selectedOptionIndexes !== undefined ||
    input.controlText !== undefined ||
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
  const selectedOptionIndexes = readHtmlMirrorSelectedOptionIndexes(
    input.selectedOptionIndexes,
    input.tagName,
  );
  if (input.selectedOptionIndexes !== undefined) return undefined;
  if (selectedOptionIndexes) {
    budget.bytes += selectedOptionIndexes.length * 8 + 16;
    if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
  }
  const selectPresentationStyle = readTransportedSelectPresentationStyle(
    input.selectPresentationStyle,
    input.tagName,
    budget,
    fidelityPolicy,
  );
  if (
    input.selectPresentationStyle !== undefined &&
    selectPresentationStyle === undefined
  ) return undefined;
  const canvasBackgroundColor = input.tagName === 'html'
    ? readHtmlMirrorCanvasBackgroundColor(input.canvasBackgroundColor)
    : undefined;
  if (
    input.canvasBackgroundColor !== undefined && !canvasBackgroundColor
  ) return undefined;
  if (canvasBackgroundColor) {
    budget.bytes += canvasBackgroundColor.length * 2 + 16;
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
      isUnsafeTransportedAttribute(
        input.namespace,
        input.tagName,
        attribute[0],
        attribute[1],
        fidelityPolicy,
      )
    ) return undefined;
    seenAttributes.add(attribute[0]);
    budget.bytes += (attribute[0].length + attribute[1].length) * 2 + 8;
    attributes.push(Object.freeze([attribute[0], attribute[1]] as const));
  }
  const attributeValues = Object.fromEntries(attributes);
  if (
    input.tagName === 'video' &&
    fidelityPolicy === 'passive' &&
    typeof attributeValues.poster !== 'string'
  ) return undefined;
  const currentPrivateRegion = opaquePlaceholder ||
    sourceElementStartsPrivateRegionInContext(
      input.tagName,
      attributeValues,
      nativeSelectParent === 'select' || nativeSelectParent === 'optgroup',
    );
  const transportedPrivateRegion = privateRegion || currentPrivateRegion;
  const transportedActivationElement =
    isSourceActivationTagName(input.tagName) ||
    (isSourceActivationRoleValue(attributeValues.role) &&
      !isSourceNativeSelectImplicitRole(input.tagName, attributeValues.role));
  const transportedActivationRegion = activationRegion ||
    transportedActivationElement;
  const transportedPrivateAttributeRegion = privateAttributeRegion ||
    transportedPrivateRegion || transportedActivationElement ||
    (!isNativeSelectSemanticTag(input.tagName) &&
      isSourcePublicMenuRoleValue(attributeValues.role));
  const transportedNonContentRegion = nonContentRegion ||
    NON_CONTENT_ELEMENTS.has(input.tagName);
  const transportedStyleRegion = styleRegion || input.tagName === 'style';
  const transportedNativeSelectParent = nextNativeSelectParentContext(
    input.tagName,
    nativeSelectParent,
  );
  const controlText = readTransportedControlText(
    input.controlText,
    input.tagName,
    attributeValues,
    transportedPrivateAttributeRegion || transportedNonContentRegion,
    nativeSelectParent,
  );
  if (input.controlText !== undefined) return undefined;
  if (controlText) {
    budget.bytes += controlText.text.length * 2 + 24;
    if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
  }
  const resolvedStyleSheetText = readTransportedResolvedStyleSheetText(
    input.resolvedStyleSheetText,
    input.tagName,
    budget,
    fidelityPolicy,
  );
  if (
    input.resolvedStyleSheetText !== undefined &&
    resolvedStyleSheetText === undefined
  ) return undefined;
  if (
    input.tagName === 'link' &&
    (
      attributeValues.rel !== undefined ||
      attributeValues.href !== undefined ||
      resolvedStyleSheetText !== undefined
    ) &&
    attributeValues.rel !== 'stylesheet'
  ) return undefined;
  const children: HtmlMirrorNode[] = [];
  if (
    transportedPrivateAttributeRegion &&
    hasPrivateHtmlMirrorAttribute(input.tagName, attributes)
  ) {
    return undefined;
  }
  if (transportedPrivateAttributeRegion && selectedOptionIndexes !== undefined) {
    return undefined;
  }
  if (transportedPrivateAttributeRegion && input.selectPickerOpen !== undefined) {
    return undefined;
  }
  if (
    transportedPrivateAttributeRegion &&
    isNativeSelectSemanticTag(input.tagName) &&
    attributeValues.label !== undefined
  ) return undefined;
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
      fidelityPolicy,
      transportedNativeSelectParent,
      false,
      shells,
    );
    if (!parsed) return undefined;
    children.push(parsed);
  }
  if (
    !attributeSentinel &&
    selectedOptionIndexes !== undefined &&
    (
      selectedOptionIndexes.some(
        (index) => index >= nativeSelectOptionCount(children),
      ) ||
      (attributeValues.multiple === undefined &&
        selectedOptionIndexes.length > 1)
    )
  ) return undefined;
  budget.bytes += input.tagName.length * 2 + 64;
  if (budget.bytes > MAX_HTML_MIRROR_BYTES) return undefined;
  let shadowRoot: HtmlMirrorShadowRoot | undefined;
  if (input.shadowRoot !== undefined) {
    if (
      !isRecord(input.shadowRoot) ||
      !hasExactKeysWithOptional(input.shadowRoot, [
        'id', 'mode', 'children', 'adoptedStyleSheets',
      ], ['slotAssignment', 'childrenFollow']) ||
      !isNodeId(input.shadowRoot.id) ||
      input.shadowRoot.mode !== 'open' ||
      (input.shadowRoot.slotAssignment !== undefined &&
        input.shadowRoot.slotAssignment !== 'manual') ||
      !Array.isArray(input.shadowRoot.children) ||
      budget.ids.has(input.shadowRoot.id)
    ) return undefined;
    // A root whose children follow in a part of the checkpoint (D163).
    const transportedShadow: Record<string, unknown> = input.shadowRoot;
    const shadowFollows = transportedShadow.childrenFollow !== undefined;
    if (shadowFollows && (
      transportedShadow.childrenFollow !== true || !shells?.childrenFollow ||
      (transportedShadow.children as readonly unknown[]).length !== 0
    )) return undefined;
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
        fidelityPolicy,
        transportedNativeSelectParent,
        false,
        shells,
      );
      if (!parsed) return undefined;
      shadowChildren.push(parsed);
    }
    const adoptedStyleSheets = readTransportedAdoptedStyleSheets(
      input.shadowRoot.adoptedStyleSheets,
      budget,
      fidelityPolicy,
    );
    if (!adoptedStyleSheets) return undefined;
    if (shadowFollows) {
      shells!.pending.set(transportedShadow.id as number, Object.freeze({
        depth: depth + 1,
        privateRegion: transportedPrivateRegion,
        nonContentRegion: transportedNonContentRegion,
        styleRegion: transportedStyleRegion,
        privateAttributeRegion: transportedPrivateAttributeRegion,
        activationRegion: transportedActivationRegion,
        nativeSelectParent: transportedNativeSelectParent,
      }));
    }
    shadowRoot = Object.freeze({
      id: input.shadowRoot.id,
      mode: 'open',
      children: Object.freeze(shadowChildren),
      adoptedStyleSheets,
      ...(input.shadowRoot.slotAssignment === 'manual'
        ? { slotAssignment: 'manual' as const }
        : {}),
      ...(shadowFollows ? { childrenFollow: true as const } : {}),
    });
  }
  if (childrenFollow) {
    shells!.pending.set(input.id, Object.freeze({
      depth: depth + 1,
      privateRegion: transportedPrivateRegion,
      nonContentRegion: transportedNonContentRegion,
      styleRegion: transportedStyleRegion,
      privateAttributeRegion: transportedPrivateAttributeRegion,
      activationRegion: transportedActivationRegion,
      nativeSelectParent: transportedNativeSelectParent,
    }));
  }
  return Object.freeze({
    kind: 'element',
    id: input.id,
    namespace: input.namespace,
    tagName: input.tagName,
    attributes: Object.freeze(attributes),
    children: Object.freeze(children),
    ...(assignedNodeIds ? { assignedNodeIds } : {}),
    ...(input.visuallyHidden === true ? { visuallyHidden: true as const } : {}),
    ...(typeof input.selectedImageSource === 'string'
      ? { selectedImageSource: input.selectedImageSource }
      : {}),
    ...(selectedOptionIndexes !== undefined ? { selectedOptionIndexes } : {}),
    ...(input.selectPickerOpen === true ? { selectPickerOpen: true as const } : {}),
    ...(selectPresentationStyle ? { selectPresentationStyle } : {}),
    ...(controlText ? { controlText } : {}),
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
    ...(resolvedStyleSheetText !== undefined
      ? { resolvedStyleSheetText }
      : {}),
    ...(input.customElementDefined === true
      ? { customElementDefined: true as const }
      : {}),
    ...(shadowRoot ? { shadowRoot } : {}),
    ...(opaquePlaceholder ? { opaquePlaceholder: true as const } : {}),
    ...(isHtmlMirrorLeftOutTagName(leftOutTagName) ? { leftOutTagName } : {}),
    ...(childrenFollow ? { childrenFollow: true as const } : {}),
    ...(placeholder ? { placeholder } : {}),
  });
}

/**
 * Revalidates the nodes a slot is said to hold: a list of distinct node ids,
 * on an HTML `<slot>` only. Which root the slot is in, and whether the nodes
 * are children of that root's host, is for the builder of the replica.
 */
function readHtmlMirrorAssignedNodeIds(
  input: unknown,
  namespace: unknown,
  tagName: unknown,
): readonly number[] | undefined {
  if (
    namespace !== 'html' || tagName !== 'slot' || !Array.isArray(input) ||
    input.length > MAX_HTML_MIRROR_NODES ||
    !input.every(isNodeId) || new Set(input).size !== input.length
  ) return undefined;
  return Object.freeze([...input as number[]]);
}

export interface HtmlMirrorDocumentContent {
  readonly root: HtmlMirrorElementNode;
  readonly adoptedStyleSheets: readonly string[];
}

/** Revalidates one canonical document payload with a shared global budget. */
export function readHtmlMirrorDocumentContent(
  rootInput: unknown,
  adoptedStyleSheetsInput: unknown,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  shells?: HtmlMirrorShellLedger,
  budget: HtmlMirrorReadBudget = createHtmlMirrorReadBudget(),
): HtmlMirrorDocumentContent | undefined {
  const ids = budget.ids;
  const root = readHtmlMirrorNode(
    rootInput,
    ids,
    0,
    budget,
    false,
    false,
    false,
    false,
    false,
    fidelityPolicy,
    false,
    false,
    shells,
  );
  if (!root || root.kind !== 'element' || root.tagName !== 'html') {
    return undefined;
  }
  const adoptedStyleSheets = readTransportedAdoptedStyleSheets(
    adoptedStyleSheetsInput,
    budget,
    fidelityPolicy,
  );
  if (!adoptedStyleSheets) return undefined;
  return Object.freeze({ root, adoptedStyleSheets });
}

/**
 * Revalidates the adopted sheets of a document (or of anything read with
 * `budget`): each distinct text is checked and counted once per budget.
 */
export function readHtmlMirrorAdoptedStyleSheets(
  input: unknown,
  budget: HtmlMirrorReadBudget,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): readonly string[] | undefined {
  return readTransportedAdoptedStyleSheets(input, budget, fidelityPolicy);
}

export function htmlMirrorJsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * The text a `<style>`'s sheet is made of, as the serialized graph holds it.
 * A style can hold several text nodes; the browser reads them as one sheet
 * (R1/R9).
 */
function serializedStyleSheetText(
  children: readonly HtmlMirrorNode[],
): string {
  let text = '';
  for (const child of children) {
    text += child.kind === 'text'
      ? child.text
      : serializedStyleSheetText(child.children);
  }
  return text;
}

/**
 * Replaces the graph's style text with one sheet text, keeping the node
 * identities: the first text holds the text and the rest are empty. A page
 * that split a sheet over text nodes then keeps a mirror that the receiver
 * accepts, instead of losing it at checkpoint (R9).
 */
function rewriteSerializedStyleSheetText(
  children: readonly HtmlMirrorNode[],
  text: string,
): readonly HtmlMirrorNode[] {
  let delivered = false;
  const rewrite = (
    nodes: readonly HtmlMirrorNode[],
  ): readonly HtmlMirrorNode[] => {
    let changed = false;
    const next = nodes.map((node) => {
      if (node.kind === 'text') {
        const value = delivered ? '' : text;
        delivered = true;
        if (value === node.text) return node;
        changed = true;
        return Object.freeze({ ...node, text: value });
      }
      const rewritten = rewrite(node.children);
      if (rewritten === node.children) return node;
      changed = true;
      return Object.freeze({ ...node, children: rewritten });
    });
    return changed ? Object.freeze(next) : nodes;
  };
  return rewrite(children);
}

function serializeNode(
  live: Node,
  context: SerializeContext,
): HtmlMirrorNode | undefined {
  if (context.cut?.skip?.(live)) return undefined;
  context.budget.inspectedNodes += 1;
  if (context.budget.inspectedNodes > MAX_HTML_MIRROR_NODES) {
    incrementRepresentability(context.representability, 'capacityOmissionCount');
    throw new HtmlMirrorCapacityError(true);
  }
  if (context.depth > MAX_HTML_MIRROR_DEPTH) {
    incrementRepresentability(
      context.representability,
      'depthBoundaryOmissionCount',
    );
    return undefined;
  }
  if (!isRepresentableSourceNativeSelectChild(live)) {
    incrementRepresentability(
      context.representability,
      'unsupportedNodeOmissionCount',
    );
    return undefined;
  }
  const id = context.registry.getId(live);
  if (!isNodeId(id)) return undefined;
  if (context.budget.ids.has(id)) {
    // Met before in this read. A read in slices meets a node twice only when
    // the page moved it from what was read into what was not (D163).
    if (context.cut) context.cut.metTwice = true;
    return undefined;
  }
  // Directly slotted Text can render inside a credential boundary that is
  // absent from its DOM-parent chain. Apply the shared Node-aware boundary
  // before evaluating nodeValue, and before an inherited hard-secret context
  // returns, so the Text identity itself becomes sticky.
  if (
    sourceNodeType(live) === Node.TEXT_NODE &&
    hasSourceCredentialSecretAncestor(
      live,
      undefined,
      undefined,
      context.secretAncestors,
    )
  ) {
    incrementRepresentability(
      context.representability,
      'privateTextRedactionCount',
    );
    return undefined;
  }
  // A serializer invoked on a descendant of an already-replaced secret root
  // must never create a second graph entry or inspect descendant content.
  if (context.hardSecretRegion) {
    incrementRepresentability(
      context.representability,
      'privateTextRedactionCount',
    );
    return undefined;
  }
  if (
    sourceNodeType(live) === Node.ELEMENT_NODE &&
    hasSourceCredentialSecretAncestor(
      live as Element,
      undefined,
      undefined,
      context.secretAncestors,
    )
  ) {
    const credentialInput = serializeCredentialInputShell(
      live as Element,
      id,
      context,
    );
    if (credentialInput) return credentialInput;
    // Replace any other hard-secret boundary before reading its original tag,
    // attributes, resources, descendants, shadow root, or style hints.
    // The node ID is retained solely for exact-document mirror identity.
    const tagName = sourceSecretPlaceholderTagName(id);
    admitNode(
      context.budget,
      id,
      tagName.length * 2 + 64,
      context.representability,
    );
    incrementRepresentability(
      context.representability,
      'privateTextRedactionCount',
    );
    return Object.freeze({
      kind: 'element',
      id,
      namespace: 'html',
      tagName,
      attributes: Object.freeze([]),
      children: Object.freeze([]),
      opaquePlaceholder: true as const,
    });
  }
  if (sourceNodeType(live) === Node.TEXT_NODE) {
    // Establish the structural/computed privacy boundary before touching page
    // content.  Accessors for withheld text are never evaluated. Stylesheet
    // text is presentation rather than page content, so a hidden or controlled
    // disclosure region keeps its CSS (those rules are often what hides it);
    // a privacy or menu boundary still withholds it.
    const withholdText = ((context.privateRegion || context.visibilityHidden) &&
      !(context.styleRegion && !context.privacyRegion)) ||
      sourceControlledTextIsWithheld(live, context.controlledContent);
    const rawText = withholdText || context.styleResolved
      ? ''
      : (live.nodeValue ?? '');
    const classifiedBefore = classifiedStyleOmissionCount(
      context.representability,
    );
    const sanitizedStyleText = context.styleRegion
      ? sanitizeCss(
          rawText,
          context.baseUrl,
          false,
          context.representability,
          context.fidelityPolicy,
        )
      : rawText;
    if (context.styleRegion && sanitizedStyleText === undefined && rawText) {
      if (
        classifiedStyleOmissionCount(context.representability) ===
        classifiedBefore
      ) {
        incrementRepresentability(
          context.representability,
          'unreadableStyleCount',
        );
      }
      incrementRepresentability(context.representability, 'omittedStyleSheetCount');
    }
    const styledText = sanitizedStyleText ?? '';
    const text = withholdText ? '' : styledText;
    if (withholdText) {
      incrementRepresentability(
        context.representability,
        'privateTextRedactionCount',
      );
    }
    if (text.length > MAX_HTML_MIRROR_STRING) {
      incrementRepresentability(context.representability, 'capacityOmissionCount');
      return undefined;
    }
    admitNode(
      context.budget,
      id,
      text.length * 2 + 32,
      context.representability,
    );
    return Object.freeze({
      kind: 'text',
      id,
      text,
      translatable:
        !context.privateRegion && !context.nonContentRegion && text.trim().length > 0,
    });
  }
  if (sourceNodeType(live) !== Node.ELEMENT_NODE) {
    incrementRepresentability(
      context.representability,
      'unsupportedNodeOmissionCount',
    );
    return undefined;
  }
  const liveElement = live as Element;
  const tagName = sourceLocalName(liveElement).toLowerCase();
  if (
    !isSafeTagName(tagName) ||
    isUnsafeSourceElement(
      liveElement,
      context.fidelityPolicy,
      context.baseUrl,
    )
  ) {
    incrementRepresentability(
      context.representability,
      'unsafeElementOmissionCount',
    );
    incrementRepresentability(
      context.representability,
      tagName === 'video'
        ? 'strictResourcePolicyBlockCount'
        : 'executionRiskBlockCount',
    );
    if (
      isHtmlMirrorLeftOutTagName(tagName) &&
      (liveElement.namespaceURI === 'http://www.w3.org/1999/xhtml' ||
        // A drawing's script holds its place too (D216): in the mirror an
        // HTML element there draws nothing, and `script + circle` counts.
        (tagName === 'script' &&
          liveElement.namespaceURI === 'http://www.w3.org/2000/svg'))
    ) return serializeLeftOutPlaceholder(id, context, tagName);
    return undefined;
  }
  const namespace = readNamespace(liveElement.namespaceURI);
  if (!namespace) {
    incrementRepresentability(
      context.representability,
      'unsupportedNodeOmissionCount',
    );
    return undefined;
  }
  if (!isRepresentableTagName(tagName, namespace)) {
    incrementRepresentability(
      context.representability,
      'unsafeElementOmissionCount',
    );
    incrementRepresentability(
      context.representability,
      'executionRiskBlockCount',
    );
    return undefined;
  }
  const customElementHost = namespace === 'html' && (
    tagName.includes('-') ||
    isCustomElementName(liveElement.getAttribute('is'))
  );
  if (customElementHost) {
    incrementRepresentability(context.representability, 'customElementHostCount');
  }
  // A painted ARIA menu or listbox shows its labels, so its text travels
  // (D75); a collapsed one is hidden and withheld until painted like any
  // other region.
  const privacyRegion = context.privacyRegion ||
    elementStartsPrivateRegion(liveElement, context.secretAncestors) ||
    tagName === 'select';
  const hiddenState = readSourceHiddenRegionState(
    liveElement,
    context.controlledContent,
  );
  const privateRegion = context.privateRegion ||
    privacyRegion ||
    hiddenState.starts;
  const visibilityHidden = hiddenState.visibilityHidden;
  const activationRegion = context.activationRegion ||
    elementStartsActivationRegion(liveElement);
  const privateAttributeRegion = context.privateAttributeRegion ||
    privateRegion ||
    activationRegion ||
    (!isNativeSelectSemanticTag(tagName) &&
      isSourcePublicMenuRoleValue(liveElement.getAttribute('role')));
  const nonContentRegion = context.nonContentRegion || NON_CONTENT_ELEMENTS.has(tagName);
  const styleRegion = context.styleRegion || tagName === 'style';
  const attributes = sanitizeAttributes(
    liveElement,
    tagName,
    privateRegion,
    activationRegion,
    privateAttributeRegion,
    privateRegion && !privacyRegion,
    false,
    context.baseUrl,
    context.representability,
    context.fidelityPolicy,
  );
  if (!attributes) return undefined;
  const hints = sanitizeSourceElementHints(
    liveElement,
    context.baseUrl,
    context.representability,
    context.fidelityPolicy,
    context.styleWork,
    context.controlledContent,
    context.secretAncestors,
    context.registry,
  );
  admitNode(
    context.budget,
    id,
    tagName.length * 2 + attributes.reduce(
      (total, [name, value]) => total + (name.length + value.length) * 2 + 8,
      64,
    ) + (hints.assignedNodeIds ? hints.assignedNodeIds.length * 8 + 16 : 0) +
      (hints.selectedImageSource?.length ?? 0) * 2 +
      (hints.selectPresentationStyle?.length ?? 0) * 2 +
      (hints.canvasBackgroundColor?.length ?? 0) * 2 +
      (hints.resolvedStyleSheetText?.length ?? 0) * 2,
    context.representability,
  );
  let children: HtmlMirrorNode[] = [];
  // Open or closed (D125). Read before the element's own children: they are
  // drawn where this root slots them, not where they sit in the page (D135).
  const sourceShadow = readSourceShadowRoot(liveElement);
  const cutFacts: SourceCutFacts | undefined = context.cut &&
    isSourceCutCandidate(liveElement, tagName, styleRegion, sourceShadow)
    ? {
      liveElement,
      id,
      namespace,
      tagName,
      attributes,
      hints,
      sourceShadow,
      customElementHost,
      depth: context.depth + 1,
      privateRegion,
      privacyRegion,
      privateAttributeRegion,
      activationRegion,
      nonContentRegion,
      visibilityHidden,
    }
    : undefined;
  if (cutFacts) {
    const cut = cutSourceElement(context, context.cut!, cutFacts);
    if (cut !== false) return cut;
  } else if (
    context.cut?.maxNodes !== undefined &&
    context.budget.nodes > context.cut.maxNodes
  ) throw new HtmlMirrorCapacityError();
  const wholeBoxHeight = context.cut?.wholeBox && !styleRegion
    ? context.cut.wholeBox(liveElement, tagName, context.budget)
    : undefined;
  if (wholeBoxHeight !== undefined) {
    // The preview's box of a dropdown (D171): what it holds, and what is
    // chosen in it, are not read.
    const {
      selectedOptionIndexes: _selected,
      selectPickerOpen: _open,
      ...boxHints
    } = hints;
    context.budget.bytes += 24;
    if (context.budget.bytes > MAX_HTML_MIRROR_BYTES) {
      incrementRepresentability(context.representability, 'capacityOmissionCount');
      throw new HtmlMirrorCapacityError(true);
    }
    return Object.freeze({
      kind: 'element',
      id,
      namespace,
      tagName,
      attributes,
      children: Object.freeze([]),
      ...boxHints,
      placeholder: Object.freeze({ height: wholeBoxHeight }),
    });
  }
  // A read in slices may stop in the middle of this element's list, or its
  // root's, once it has read a child of it (D163): what follows comes in a
  // later fill, appended. The elements read are kept for the index.
  const split = cutFacts && context.cut?.defer ? context.cut : undefined;
  const lightElements: Element[] | undefined = split ? [] : undefined;
  // Left out after its content was read (D171): what was cut in it goes too.
  const cutMark = split?.mark?.();
  const leftOut = (): undefined => {
    if (cutMark) split!.rollback?.(cutMark);
    return undefined;
  };
  // What its elements' ended script animations hold is worked out for the
  // root as one, before any of them is read.
  if (sourceShadow) listSourceHeldAnimations(sourceShadow);
  if (!isVoidElement(tagName) && !isSourceNativeTextControlTagName(tagName)) {
    const styleResolved = tagName === 'style' &&
      hints.resolvedStyleSheetText !== undefined;
    const childRepresentability = styleResolved
      ? createHtmlMirrorRepresentabilityCollector()
      : context.representability;
    const childFidelityPolicy = tagName === 'style' && context.styleWork.exhausted
      ? 'conservative'
      : context.fidelityPolicy;
    let lightRead = 0;
    // The preview (D193): a list that alone passes the preview's limit and
    // whose elements hold nothing, so none of them can be a box, is read
    // whole by any reading: the preview is given up before it is read
    // (131,000 empty elements in one box read 12,000 of them, 62–72 ms).
    if (
      context.cut?.maxNodes !== undefined &&
      previewListCannotFit(liveElement, context.budget.nodes, context.cut.maxNodes)
    ) throw new HtmlMirrorCapacityError();
    for (const liveChild of sourceStructuralChildNodes(liveElement)) {
      if (split && lightElements && lightRead > 0 && split.expired?.() === true) {
        const resumed = cutSourceElement(context, split, cutFacts!, {
          cursor: liveChild,
          read: children,
          elements: lightElements,
        });
        return resumed === false || resumed === undefined ? leftOut() : resumed;
      }
      lightRead += 1;
      if (lightElements && sourceNodeType(liveChild) === Node.ELEMENT_NODE) {
        lightElements.push(liveChild as Element);
      }
      const slotRegion = sourceShadow
        ? readSourceSlotRegion(
            liveChild,
            context.controlledContent,
            context.slotRegions,
            context.secretAncestors,
          )
        : undefined;
      if (sourceShadow) {
        noteSourceSlotReading(
          context.slotReadings,
          liveChild,
          slotRegion,
          visibilityHidden,
        );
      }
      const child = serializeNode(liveChild, {
        ...context,
        representability: childRepresentability,
        fidelityPolicy: childFidelityPolicy,
        privateRegion: privateRegion || slotRegion?.withheld === true ||
          slotRegion?.privacy === true,
        privacyRegion: privacyRegion || slotRegion?.privacy === true,
        privateAttributeRegion,
        activationRegion: activationRegion || slotRegion?.activation === true,
        nonContentRegion,
        styleRegion,
        styleResolved,
        visibilityHidden: slotRegion && sourceNodeType(liveChild) === Node.TEXT_NODE
          ? slotRegion.visibilityHidden
          : visibilityHidden,
        depth: context.depth + 1,
      });
      if (child) children.push(child);
    }
    if (tagName === 'style' && !styleResolved && children.length > 0) {
      // The receiver checks a style's whole text as one sheet and refuses a
      // graph that is not a fixed point. Sanitize the joined text here so a
      // legitimate split sheet still crosses, and the receiver's refusal is
      // reserved for a graph no serializer made (R9).
      const joined = serializedStyleSheetText(children);
      if (
        joined &&
        sanitizeCss(
          joined,
          'about:blank',
          false,
          undefined,
          childFidelityPolicy,
        ) !== joined
      ) {
        const normalized = sanitizeCss(
          joined,
          context.baseUrl,
          false,
          context.representability,
          childFidelityPolicy,
        ) ?? '';
        const receiverSafe = sanitizeCss(
          normalized,
          'about:blank',
          false,
          undefined,
          childFidelityPolicy,
        ) ?? '';
        const transported = sanitizeCss(
          receiverSafe,
          'about:blank',
          false,
          undefined,
          childFidelityPolicy,
        ) === receiverSafe ? receiverSafe : '';
        children = [...rewriteSerializedStyleSheetText(children, transported)];
      }
    }
  }
  let shadowRoot: HtmlMirrorShadowRoot | undefined;
  // The root's content goes through this same walk: each node is classified
  // before it is read, and every limit applies.
  if (customElementHost && !sourceShadow) {
    incrementRepresentability(
      context.representability,
      'customElementHostWithoutAccessibleOpenRootCount',
    );
  }
  if (sourceShadow) {
    incrementRepresentability(
      context.representability,
      'accessibleOpenShadowRootCount',
    );
    const shadowId = context.registry.getId(sourceShadow);
    if (!isNodeId(shadowId) || context.budget.ids.has(shadowId)) return leftOut();
    admitNode(context.budget, shadowId, 32, context.representability);
    const shadowChildren: HtmlMirrorNode[] = [];
    const shadowElements: Element[] | undefined = split ? [] : undefined;
    let shadowRead = 0;
    for (const childNode of sourceShadow.childNodes) {
      if (split && shadowElements && shadowRead > 0 && split.expired?.() === true) {
        return splitSourceShadowContent(context, split, cutFacts!, {
          shadow: sourceShadow,
          shadowId,
          cursor: childNode,
          read: shadowChildren,
          elements: [...lightElements ?? [], ...shadowElements],
          children,
        }) ?? leftOut();
      }
      shadowRead += 1;
      if (shadowElements && sourceNodeType(childNode) === Node.ELEMENT_NODE) {
        shadowElements.push(childNode as Element);
      }
      const child = serializeNode(childNode, {
        ...context,
        privateRegion,
        privacyRegion,
        privateAttributeRegion,
        activationRegion,
        nonContentRegion,
        styleRegion,
        visibilityHidden,
        depth: context.depth + 1,
      });
      if (child) shadowChildren.push(child);
    }
    const adoptedStyleSheets = captureAdoptedStyleSheets(
      sourceShadow,
      context.baseUrl,
      context.budget,
      context.styleWork,
      context.representability,
      context.fidelityPolicy,
    );
    if (!adoptedStyleSheets) return leftOut();
    shadowRoot = Object.freeze({
      id: shadowId,
      mode: 'open',
      children: Object.freeze(shadowChildren),
      adoptedStyleSheets,
      ...((sourceShadow as Partial<ShadowRoot>).slotAssignment === 'manual'
        ? { slotAssignment: 'manual' as const }
        : {}),
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

/**
 * Whether a read may leave this element's content for later (D163). Never a
 * dropdown or anything in one (the panel takes a dropdown whole, and its
 * chosen entries are counted against its options), never a style sheet or
 * anything in one (its text is checked as one sheet), and only an element
 * that holds something: children or a root.
 */
function isSourceCutCandidate(
  element: Element,
  tagName: string,
  styleRegion: boolean,
  sourceShadow: ShadowRoot | undefined,
): boolean {
  if (
    styleRegion ||
    isNativeSelectSemanticTag(tagName) ||
    // The whole read reads nothing of these.
    isVoidElement(tagName) ||
    isSourceNativeTextControlTagName(tagName)
  ) return false;
  return sourceShadow !== undefined || sourceChildNodeList(element).length > 0;
}

/** What `serializeNode` knows of an element when a read may cut it. */
interface SourceCutFacts {
  readonly liveElement: Element;
  readonly id: number;
  readonly namespace: HtmlMirrorNamespace;
  readonly tagName: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly hints: HtmlMirrorElementHints;
  readonly sourceShadow: ShadowRoot | undefined;
  readonly customElementHost: boolean;
  readonly depth: number;
  readonly privateRegion: boolean;
  readonly privacyRegion: boolean;
  readonly privateAttributeRegion: boolean;
  readonly activationRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly visibilityHidden: boolean;
}

/**
 * Emits an element without its content when the read leaves it (D163):
 * `false` when the content is read now, as always. The element itself was
 * admitted and decided as in any read; only what it holds is left.
 */
function cutSourceElement(
  context: SerializeContext,
  cut: SourceReadCut,
  facts: SourceCutFacts,
  /**
   * The slice stopped in the element's own list (D163): the children read
   * go as the first fill, with `more`, and the unit goes on from `cursor`.
   */
  resume?: {
    readonly cursor: Node;
    readonly read: readonly HtmlMirrorNode[];
    readonly elements: readonly Element[];
  },
): HtmlMirrorNode | undefined | false {
  const shell = {
    kind: 'element' as const,
    id: facts.id,
    namespace: facts.namespace,
    tagName: facts.tagName,
    attributes: facts.attributes,
    children: Object.freeze([]) as readonly HtmlMirrorNode[],
    ...facts.hints,
  };
  if (cut.placeholder && !resume) {
    const height = cut.placeholder(facts.liveElement, facts.tagName, context.budget);
    if (height === undefined) return false;
    context.budget.bytes += 24;
    if (context.budget.bytes > MAX_HTML_MIRROR_BYTES) {
      incrementRepresentability(context.representability, 'capacityOmissionCount');
      throw new HtmlMirrorCapacityError(true);
    }
    return Object.freeze({
      ...shell,
      placeholder: Object.freeze({ height }),
    });
  }
  if (!cut.defer || (!resume && cut.expired?.() !== true)) return false;
  // Counted as the whole read counts them, so that the counts of a read in
  // slices are the one-task read's.
  if (facts.customElementHost && !facts.sourceShadow) {
    incrementRepresentability(
      context.representability,
      'customElementHostWithoutAccessibleOpenRootCount',
    );
  }
  let shadowRoot: HtmlMirrorShadowRoot | undefined;
  let shadowId: number | undefined;
  if (facts.sourceShadow) {
    incrementRepresentability(
      context.representability,
      'accessibleOpenShadowRootCount',
    );
    shadowId = context.registry.getId(facts.sourceShadow);
    if (!isNodeId(shadowId)) return undefined;
    if (context.budget.ids.has(shadowId)) {
      cut.metTwice = true;
      return undefined;
    }
    admitNode(context.budget, shadowId, 32, context.representability);
    // The root's adopted sheets are read with the shell, before its content
    // (the whole read reads them after it): the shell carries them. Only
    // which sheet runs into a style limit first can differ.
    const adoptedStyleSheets = captureAdoptedStyleSheets(
      facts.sourceShadow,
      context.baseUrl,
      context.budget,
      context.styleWork,
      context.representability,
      context.fidelityPolicy,
    );
    if (!adoptedStyleSheets) return undefined;
    shadowRoot = Object.freeze({
      id: shadowId,
      mode: 'open',
      children: Object.freeze([]),
      adoptedStyleSheets,
      ...((facts.sourceShadow as Partial<ShadowRoot>).slotAssignment === 'manual'
        ? { slotAssignment: 'manual' as const }
        : {}),
      childrenFollow: true as const,
    });
  }
  if (resume) {
    cut.prefill?.(Object.freeze({
      nodeId: facts.id,
      children: Object.freeze([...resume.read]),
      more: true as const,
    }), resume.elements);
  }
  cut.defer({
    element: facts.liveElement,
    parent: facts.liveElement.parentNode,
    nodeId: facts.id,
    shadow: facts.sourceShadow,
    shadowId,
    phase: 'light',
    cursor: resume?.cursor,
    depth: facts.depth,
    privateRegion: facts.privateRegion,
    privacyRegion: facts.privacyRegion,
    privateAttributeRegion: facts.privateAttributeRegion,
    activationRegion: facts.activationRegion,
    nonContentRegion: facts.nonContentRegion,
    visibilityHidden: facts.visibilityHidden,
  });
  return Object.freeze({
    ...shell,
    ...(shadowRoot ? { shadowRoot } : {}),
    childrenFollow: true as const,
  });
}

/**
 * The slice stopped in the list of an element's root, after the element's
 * own children were read whole (D163): the element goes with its children,
 * its root as a shell carrying its adopted sheets, the root's children read
 * so far as the root's first fill (`more`), and the unit goes on from
 * `cursor` in the root's list.
 */
function splitSourceShadowContent(
  context: SerializeContext,
  cut: SourceReadCut,
  facts: SourceCutFacts,
  split: {
    readonly shadow: ShadowRoot;
    readonly shadowId: number;
    readonly cursor: Node;
    readonly read: readonly HtmlMirrorNode[];
    readonly elements: readonly Element[];
    readonly children: readonly HtmlMirrorNode[];
  },
): HtmlMirrorNode | undefined {
  const adoptedStyleSheets = captureAdoptedStyleSheets(
    split.shadow,
    context.baseUrl,
    context.budget,
    context.styleWork,
    context.representability,
    context.fidelityPolicy,
  );
  if (!adoptedStyleSheets) return undefined;
  cut.prefill?.(Object.freeze({
    nodeId: split.shadowId,
    children: Object.freeze([...split.read]),
    more: true as const,
  }), split.elements);
  cut.defer?.({
    element: facts.liveElement,
    parent: facts.liveElement.parentNode,
    nodeId: facts.id,
    shadow: split.shadow,
    shadowId: split.shadowId,
    phase: 'shadow',
    cursor: split.cursor,
    depth: facts.depth,
    privateRegion: facts.privateRegion,
    privacyRegion: facts.privacyRegion,
    privateAttributeRegion: facts.privateAttributeRegion,
    activationRegion: facts.activationRegion,
    nonContentRegion: facts.nonContentRegion,
    visibilityHidden: facts.visibilityHidden,
  });
  return Object.freeze({
    kind: 'element',
    id: facts.id,
    namespace: facts.namespace,
    tagName: facts.tagName,
    attributes: facts.attributes,
    children: Object.freeze([...split.children]),
    ...facts.hints,
    shadowRoot: Object.freeze({
      id: split.shadowId,
      mode: 'open',
      children: Object.freeze([]),
      adoptedStyleSheets,
      ...((split.shadow as Partial<ShadowRoot>).slotAssignment === 'manual'
        ? { slotAssignment: 'manual' as const }
        : {}),
      childrenFollow: true as const,
    }),
  });
}

/** What every slice of one read shares (D163). */
interface SourceReadShared {
  readonly registry: HtmlMirrorIdRegistry;
  readonly baseUrl: string;
  readonly budget: HtmlMirrorReadBudget;
  readonly styleWork: HtmlMirrorStyleWorkBudget;
  readonly representability: HtmlMirrorRepresentabilityCollector;
  readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
  readonly controlledContent: SourceControlledContentPolicy;
  readonly slotReadings: SourceSlotReadings | undefined;
}

/** What one run of a unit read (D163). */
type SourceReadUnitRun =
  | {
      readonly fills: readonly HtmlMirrorCheckpointFill[];
      /** The elements of the lists it read, for the index of what is painted. */
      readonly elements: readonly Element[];
      /** The rest of the unit, when the slice ran out in the middle of it. */
      readonly rest?: SourceReadUnit;
    }
  /** The element left the page or its parent: the live path's to patch. */
  | 'skipped'
  /** The child it was to go on from is no child of it any more. */
  | 'restart';

/**
 * Reads one unit, or as much of it as the slice allows: what an element
 * that a slice left holds, its root's content after its own children as the
 * whole read has them (D135). It reads one child at least; when the slice
 * runs out after that, what it read goes as a fill with `more`, and the
 * rest of the unit goes on from the next child in a later step. Each run
 * takes the element's context from what it gave its content when it was
 * cut, and adds what its ancestors in the page say now, as a children read
 * of the live path rebuilds it: an ancestor hidden, edited or made secret
 * since is honoured, and nothing is let through that the cut withheld.
 *
 * A run that goes on in a list checks that the child it goes on from is
 * still a child of the element (or its root); if not, the read starts
 * again. Children put in before that child, or taken out of the part
 * already read, are not looked for: the element is mirrored, and the
 * childList record of that change is replayed by the live path after the
 * copy is acknowledged.
 */
function readSourceReadUnit(
  unit: SourceReadUnit,
  shared: SourceReadShared,
  secretAncestors: SourceSecretAncestorMemo,
  slotRegions: Map<Element, SourceSlotRegion>,
  cut: SourceReadCut,
): SourceReadUnitRun {
  const element = unit.element;
  if (
    !element.isConnected ||
    element.parentNode !== unit.parent ||
    readSourceShadowRoot(element) !== unit.shadow
  ) return 'skipped';
  const { controlledContent } = shared;
  const context: SerializeContext = {
    registry: shared.registry,
    baseUrl: shared.baseUrl,
    budget: shared.budget,
    styleWork: shared.styleWork,
    privateRegion: unit.privateRegion ||
      hasSourceBaseWithheldAncestor(element, controlledContent),
    privacyRegion: unit.privacyRegion ||
      hasSourcePrivacyWithheldAncestor(element),
    privateAttributeRegion: unit.privateAttributeRegion ||
      hasSourcePrivateAttributeElementAncestor(element),
    activationRegion: unit.activationRegion ||
      hasSourceActivationElementAncestor(element),
    nonContentRegion: unit.nonContentRegion || hasNonContentAncestor(element),
    styleRegion: Boolean(element.closest('style')),
    hardSecretRegion: hasSourceCredentialSecretAncestor(
      element,
      undefined,
      undefined,
      secretAncestors,
    ),
    visibilityHidden: unit.visibilityHidden ||
      readSourceHiddenRegionState(element, controlledContent).visibilityHidden,
    depth: unit.depth,
    representability: shared.representability,
    fidelityPolicy: shared.fidelityPolicy,
    controlledContent,
    secretAncestors,
    slotRegions,
    slotReadings: shared.slotReadings,
    cut,
  };
  // Each run is a step of its own, whose pass has not listed the root.
  if (unit.shadow) listSourceHeldAnimations(unit.shadow);
  const fills: HtmlMirrorCheckpointFill[] = [];
  const elements: Element[] = [];
  let read = 0;
  // Where a run may stop: after one child at least, once the slice is out.
  const stops = (): boolean => read > 0 && cut.expired?.() === true;
  /**
   * The list from the run's own place in it; undefined when that is lost.
   * A list of the holder's own children is walked on from the cursor, a
   * child of the holder still, by its next siblings (D209): copied and
   * searched at every run, a list of 131,000 children cost 20 ms a slice
   * on Chrome 154. A dropdown's entries are a list of their own.
   */
  const listFrom = (
    holder: Node,
    list: Iterable<Node>,
    cursor: Node | undefined,
  ): Iterable<Node> | undefined => {
    if (Array.isArray(list)) {
      if (!cursor) return list;
      const at = list.indexOf(cursor);
      return at < 0 ? undefined : list.slice(at);
    }
    if (!cursor) return sourceChildrenFrom(sourceProperty(holder, 'firstChild'));
    return sourceProperty(cursor, 'parentNode') === holder
      ? sourceChildrenFrom(cursor)
      : undefined;
  };
  if (unit.phase === 'light') {
    const nodes = listFrom(element, sourceStructuralChildNodes(element), unit.cursor);
    if (!nodes) return 'restart';
    const children: HtmlMirrorNode[] = [];
    for (const liveChild of nodes) {
      if (stops()) {
        fills.push(Object.freeze({
          nodeId: unit.nodeId,
          children: Object.freeze(children),
          more: true as const,
        }));
        return { fills, elements, rest: { ...unit, cursor: liveChild } };
      }
      read += 1;
      if (sourceNodeType(liveChild) === Node.ELEMENT_NODE) elements.push(liveChild as Element);
      const slotRegion = unit.shadow
        ? readSourceSlotRegion(
            liveChild,
            controlledContent,
            slotRegions,
            secretAncestors,
          )
        : undefined;
      if (unit.shadow) {
        noteSourceSlotReading(
          shared.slotReadings,
          liveChild,
          slotRegion,
          context.visibilityHidden,
        );
      }
      const child = serializeNode(liveChild, {
        ...context,
        privateRegion: context.privateRegion || slotRegion?.withheld === true ||
          slotRegion?.privacy === true,
        privacyRegion: context.privacyRegion || slotRegion?.privacy === true,
        activationRegion: context.activationRegion ||
          slotRegion?.activation === true,
        visibilityHidden: slotRegion && sourceNodeType(liveChild) === Node.TEXT_NODE
          ? slotRegion.visibilityHidden
          : context.visibilityHidden,
      });
      if (child) children.push(child);
    }
    fills.push(Object.freeze({
      nodeId: unit.nodeId,
      children: Object.freeze(children),
    }));
    if (!unit.shadow || unit.shadowId === undefined) return { fills, elements };
    if (stops()) {
      return {
        fills,
        elements,
        rest: { ...unit, phase: 'shadow', cursor: undefined },
      };
    }
  }
  const shadow = unit.shadow!;
  const shadowId = unit.shadowId!;
  const nodes = listFrom(
    shadow,
    shadow.childNodes,
    unit.phase === 'shadow' ? unit.cursor : undefined,
  );
  if (!nodes) return 'restart';
  const shadowChildren: HtmlMirrorNode[] = [];
  for (const childNode of nodes) {
    if (stops()) {
      fills.push(Object.freeze({
        nodeId: shadowId,
        children: Object.freeze(shadowChildren),
        more: true as const,
      }));
      return {
        fills,
        elements,
        rest: { ...unit, phase: 'shadow', cursor: childNode },
      };
    }
    read += 1;
    if (sourceNodeType(childNode) === Node.ELEMENT_NODE) elements.push(childNode as Element);
    const child = serializeNode(childNode, context);
    if (child) shadowChildren.push(child);
  }
  fills.push(Object.freeze({
    nodeId: shadowId,
    children: Object.freeze(shadowChildren),
  }));
  return { fills, elements };
}

/** A node and the siblings after it, each read as the list is then (D209). */
function* sourceChildrenFrom(first: Node | null): Generator<Node, void, undefined> {
  for (let node = first; node; node = sourceProperty(node, 'nextSibling')) yield node;
}

/**
 * Where a step left the index of what is painted to be built (D163): the
 * document's root at the first step, and each element of a list a step read
 * (with what it holds, down to the step's `deferred` elements).
 */
export interface SourceDocumentReadIndexRoot {
  readonly element: Element;
  /** The element itself was read in this step too. */
  readonly includeSelf: boolean;
}

/** The whole-document values a read takes at its end, as fresh as can be. */
export interface SourceDocumentReadValues {
  readonly adoptedStyleSheets: readonly string[];
  readonly documentMode: HtmlMirrorDocumentMode;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly documentWidth: number;
  readonly documentHeight: number;
}

export type SourceDocumentReadStep =
  | {
      /** `done`: nothing is left, and `document` holds the end's values. */
      readonly outcome: 'continue' | 'done';
      /** The first step only: the document's root, with shells. */
      readonly root?: HtmlMirrorElementNode;
      /** What this step read for the shells, in order. */
      readonly fills: readonly HtmlMirrorCheckpointFill[];
      /** The subtrees this step read, for `SourceVisibilityBoundaryIndex.beginBuild`. */
      readonly indexRoots: readonly SourceDocumentReadIndexRoot[];
      /** The elements this step left as shells: an index walk stops at each. */
      readonly deferred: ReadonlySet<Element>;
      /** Units not read: the element left the page or its parent. */
      readonly skippedUnits: number;
      readonly document?: SourceDocumentReadValues;
    }
  /** A node was met twice: the page moved it into what was not read yet. */
  | { readonly outcome: 'restart' }
  /** Over a limit: today's capacity omission (`stream_overflow`). */
  | { readonly outcome: 'overflow' }
  /** The document has no `<html>` root that the mirror can hold. */
  | { readonly outcome: 'failed' };

export interface SourceDocumentReadOptions {
  readonly representability?: HtmlMirrorRepresentabilityCollector;
  readonly fidelityPolicy?: SelectableReplicaFidelityPolicy;
  /**
   * The policy of the whole page (built in slices before the read starts).
   * Without one, one is built whole here.
   */
  readonly controlledContent?: SourceControlledContentPolicy;
  readonly slotReadings?: SourceSlotReadings;
  /** The clock of each step's held-animation pass. */
  readonly now?: () => number;
  /**
   * `false`: the caller opens a fresh shadow-root walk around each step and
   * what it reads beside it in the same task (the controlled-content
   * policy, the marks), so that each element's root is asked about once in
   * that task, as in the one-task read. Each step then walks inside it.
   */
  readonly freshRootWalk?: boolean;
}

/** A read of the whole document in slices; see `beginSourceDocumentRead`. */
export interface SourceDocumentRead {
  readonly representability: HtmlMirrorRepresentabilityCollector;
  /** Nodes admitted and bytes counted so far, over every step. */
  readonly budget: Readonly<Pick<HtmlMirrorReadBudget, 'nodes' | 'bytes' | 'inspectedNodes'>>;
  /** Units queued and not read yet. */
  readonly pendingUnits: number;
  /** No further step: done, restarted, over a limit or failed. */
  readonly finished: boolean;
  /**
   * The policy the steps after this one read with (D171): the page's
   * controlled content changed between two steps, and the policy was read
   * again. What was read already stays as it was read.
   */
  setControlledContent(policy: SourceControlledContentPolicy): void;
  /**
   * Reads until `clock` runs out, and at least one unit (the root, at the
   * first step). Every cache of one walk (the secret-ancestor memo, the slot
   * boxes, the shadow-root walk, the held-animation pass) is opened and
   * closed within the step: nothing is kept across the caller's yield.
   */
  step(clock: { expired(): boolean }): SourceDocumentReadStep;
}

/**
 * Reads the document as `sanitizeSourceDocument` does, in steps (D163).
 * When a step's clock runs out, every element it has not descended into yet
 * is emitted as a shell (`childrenFollow`, no children) and queued; a later
 * step reads what it holds as a unit and returns it as fills. For a page
 * that does not change in between, the root filled with every fill is the
 * one-task read's graph (with the same registry), and the counts are its
 * counts: one node budget, one byte counter, one style budget and one
 * adopted-sheet table count every step. A step on a page that changed reads
 * each unit as it is then: every node is classified for secrets as it is
 * read, as always. A node met a second time (moved from what was read into
 * what was not) ends the read with `restart`; a unit whose element left is
 * skipped and filled empty, for the live path to patch.
 *
 * The first step lists the document's script animations; each step lists
 * the roots it enters, as the whole read does.
 */
export function beginSourceDocumentRead(
  sourceDocument: Document,
  sourceWindow: Window,
  registry: HtmlMirrorIdRegistry,
  options: SourceDocumentReadOptions = {},
): SourceDocumentRead {
  const representability = options.representability ??
    createHtmlMirrorRepresentabilityCollector();
  const budget = createHtmlMirrorReadBudget();
  const queue: SourceReadUnit[] = [];
  let queueHead = 0;
  let started = false;
  let finished = false;
  let root: HtmlMirrorElementNode | undefined;
  let shared: SourceReadShared | undefined;
  let controlledOverride: SourceControlledContentPolicy | undefined;
  const end = (outcome: 'restart' | 'overflow' | 'failed'): SourceDocumentReadStep => {
    finished = true;
    queue.length = 0;
    queueHead = 0;
    return Object.freeze({ outcome });
  };
  const step = (clock: { expired(): boolean }): SourceDocumentReadStep => {
    if (finished) return Object.freeze({ outcome: 'failed' as const });
    const documentElement = sourceProperty(sourceDocument, 'documentElement');
    if (!documentElement) return end('failed');
    if (!shared) {
      const controlledContent = controlledOverride ??
        options.controlledContent ??
        createSourceControlledContentPolicy(
          sourceDocument,
          sourceWindow,
          MAX_HTML_MIRROR_NODES,
        );
      if (controlledContent.incomplete) {
        if (!sourceDocumentPassesNodeCap(sourceDocument)) return end('failed');
        incrementRepresentability(representability, 'capacityOmissionCount');
        return end('overflow');
      }
      shared = {
        registry,
        baseUrl: sourceDocumentBaseUrl(sourceDocument),
        budget,
        styleWork: createHtmlMirrorStyleWorkBudget(),
        representability,
        fidelityPolicy: options.fidelityPolicy ?? 'conservative',
        controlledContent,
        slotReadings: options.slotReadings,
      };
    }
    const deferred = new Set<Element>();
    const fills: HtmlMirrorCheckpointFill[] = [];
    const indexRoots: SourceDocumentReadIndexRoot[] = [];
    // The first fills of lists a slice stopped in, as one read made them:
    // inner lists stop first, so they are handed on outermost first, after
    // the fill or root that holds the outermost shell.
    const prefills: HtmlMirrorCheckpointFill[] = [];
    const addElements = (elements: readonly Element[]): void => {
      for (const element of elements) {
        indexRoots.push(Object.freeze({ element, includeSelf: true }));
      }
    };
    const handOnPrefills = (): void => {
      for (let index = prefills.length - 1; index >= 0; index -= 1) {
        fills.push(prefills[index]!);
      }
      prefills.length = 0;
    };
    const cut: SourceReadCut = {
      expired: () => clock.expired(),
      defer: (unit) => {
        queue.push(unit);
        deferred.add(unit.element);
      },
      prefill: (fill, elements) => {
        prefills.push(fill);
        addElements(elements);
      },
      mark: () => ({
        units: queue.length,
        prefills: prefills.length,
        indexRoots: indexRoots.length,
      }),
      rollback: (mark) => {
        // What was queued since the mark is all inside the element left
        // out: the read is depth first and synchronous within a step.
        for (let index = mark.units; index < queue.length; index += 1) {
          deferred.delete(queue[index]!.element);
        }
        if (queue.length > mark.units) queue.length = mark.units;
        if (prefills.length > mark.prefills) prefills.length = mark.prefills;
        if (indexRoots.length > mark.indexRoots) indexRoots.length = mark.indexRoots;
      },
      metTwice: false,
    };
    let skippedUnits = 0;
    let stepRoot: HtmlMirrorElementNode | undefined;
    const rootWalk = beginSourceShadowRootWalk({
      fresh: options.freshRootWalk !== false,
    });
    const heldPass = beginSourceHeldAnimationPass(
      sourceDocument,
      true,
      options.now,
    );
    try {
      // Fresh for this step: none of these may outlive it.
      const secretAncestors = createSourceSecretAncestorMemo();
      const slotRegions = new Map<Element, SourceSlotRegion>();
      if (!started) {
        started = true;
        heldPass.list(sourceDocument);
        const serialized = serializeNode(documentElement, {
          registry,
          baseUrl: shared.baseUrl,
          budget,
          styleWork: shared.styleWork,
          privateRegion: false,
          privacyRegion: false,
          privateAttributeRegion: false,
          activationRegion: false,
          nonContentRegion: false,
          styleRegion: false,
          hardSecretRegion: false,
          visibilityHidden: false,
          depth: 0,
          representability,
          fidelityPolicy: shared.fidelityPolicy,
          controlledContent: shared.controlledContent,
          secretAncestors,
          slotRegions,
          slotReadings: shared.slotReadings,
          cut,
        });
        if (cut.metTwice) return end('restart');
        if (
          !serialized || serialized.kind !== 'element' ||
          serialized.tagName !== 'html'
        ) return end('failed');
        root = serialized;
        stepRoot = serialized;
        indexRoots.push(Object.freeze({
          element: documentElement,
          includeSelf: true,
        }));
        handOnPrefills();
      }
      while (queueHead < queue.length) {
        // A step reads at least one unit, and the root's step may go on.
        if ((stepRoot || fills.length > 0 || skippedUnits > 0) && clock.expired()) {
          break;
        }
        const unit = queue[queueHead]!;
        queueHead += 1;
        const run = readSourceReadUnit(
          unit,
          shared,
          secretAncestors,
          slotRegions,
          cut,
        );
        if (cut.metTwice || run === 'restart') return end('restart');
        if (run !== 'skipped') {
          for (const item of run.fills) fills.push(item);
          handOnPrefills();
          addElements(run.elements);
          if (run.rest) queue.push(run.rest);
        } else {
          // Ended with an empty fill, so that every shell is completed once:
          // the live path patches what the element's parent holds now.
          prefills.length = 0;
          skippedUnits += 1;
          if (unit.phase === 'light') {
            fills.push(Object.freeze({
              nodeId: unit.nodeId,
              children: Object.freeze([]),
            }));
          }
          if (unit.shadowId !== undefined) {
            fills.push(Object.freeze({
              nodeId: unit.shadowId,
              children: Object.freeze([]),
            }));
          }
        }
      }
      if (queueHead >= queue.length) {
        queue.length = 0;
        queueHead = 0;
      }
      let values: SourceDocumentReadValues | undefined;
      if (queue.length === 0) {
        const adoptedStyleSheets = captureAdoptedStyleSheets(
          sourceDocument,
          shared.baseUrl,
          budget,
          shared.styleWork,
          representability,
          shared.fidelityPolicy,
        );
        if (!adoptedStyleSheets) return end('overflow');
        values = readSourceDocumentReadValues(
          sourceDocument,
          sourceWindow,
          documentElement,
          adoptedStyleSheets,
        );
        finished = true;
      }
      return Object.freeze({
        outcome: values ? 'done' as const : 'continue' as const,
        ...(stepRoot ? { root: stepRoot } : {}),
        fills: Object.freeze(fills),
        indexRoots: Object.freeze(indexRoots),
        deferred,
        skippedUnits,
        ...(values ? { document: values } : {}),
      });
    } catch (error) {
      if (error instanceof HtmlMirrorCapacityError) {
        if (!error.diagnosticRecorded) {
          incrementRepresentability(representability, 'capacityOmissionCount');
        }
        return end('overflow');
      }
      finished = true;
      throw error;
    } finally {
      heldPass.end();
      rootWalk.end();
    }
  };
  return {
    representability,
    budget,
    get pendingUnits() {
      return queue.length - queueHead;
    },
    get finished() {
      return finished;
    },
    setControlledContent(policy: SourceControlledContentPolicy) {
      if (shared) shared = { ...shared, controlledContent: policy };
      else controlledOverride = policy;
    },
    step,
  };
}

function readSourceDocumentReadValues(
  sourceDocument: Document,
  sourceWindow: Window,
  documentElement: Element,
  adoptedStyleSheets: readonly string[],
): SourceDocumentReadValues {
  return Object.freeze({
    adoptedStyleSheets,
    documentMode: sourceDocumentMode(sourceDocument),
    viewportWidth: boundedDimension(sourceWindow.innerWidth),
    viewportHeight: boundedDimension(sourceWindow.innerHeight),
    documentWidth: boundedDimension(Math.max(
      documentElement.scrollWidth,
      sourceProperty(sourceDocument, 'body')?.scrollWidth ?? 0,
    )),
    documentHeight: boundedDimension(Math.max(
      documentElement.scrollHeight,
      sourceProperty(sourceDocument, 'body')?.scrollHeight ?? 0,
    )),
  });
}

/**
 * Whether a sibling of a box may be left to it in the preview (D169): an
 * HTML element that the read would cut, with something in it, and none of
 * what the preview never makes a box of.
 */
function standsInRunOfBoxes(element: Element): boolean {
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
  const tagName = sourceLocalName(element).toLowerCase();
  if (
    tagName === 'style' || tagName === 'link' || tagName === 'script' ||
    tagName === 'template' || tagName === 'noscript' || tagName === 'meta' ||
    tagName === 'slot' ||
    isNativeSelectSemanticTag(tagName) ||
    isVoidElement(tagName) ||
    isSourceNativeTextControlTagName(tagName)
  ) return false;
  return sourceChildNodeList(element).length > 0 ||
    readSourceShadowRoot(element) !== undefined;
}

/** Elements the preview's count leaves out: the read may drop them (D193). */
const PREVIEW_UNCOUNTED_TAGS: ReadonlySet<string> = new Set([
  'script', 'noscript', 'template', 'style', 'link', 'meta', 'base', 'title',
  'iframe', 'frame', 'object', 'embed', 'slot', 'select', 'option', 'optgroup',
]);

/**
 * Whether `element`'s own list passes `maxNodes` from `read` with nodes the
 * preview reads whatever it does (D193): an element that holds nothing
 * (only an element with children can be a box, and it ends a run of
 * boxes) and a text that shows. Counted only for a list long enough by its
 * length alone, and over at most that list.
 */
function previewListCannotFit(element: Element, read: number, maxNodes: number): boolean {
  try {
    if (sourceLocalName(element).toLowerCase() === 'select') return false;
    const nodes = sourceChildNodeList(element);
    if (!(read + nodes.length > maxNodes)) return false;
    let always = read;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index]!;
      const type = sourceNodeType(node);
      if (type === 1) {
        // Counted low where unsure: an element the read may leave out
        // (a script, a frame, a template's hidden content) does not count.
        const child = node as Element;
        if (
          child.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
          !PREVIEW_UNCOUNTED_TAGS.has(sourceLocalName(child).toLowerCase()) &&
          sourceChildNodeList(child).length === 0 &&
          readSourceShadowRoot(child) === undefined
        ) always += 1;
      } else if (type === 3) {
        if ((node.nodeValue ?? '').trim() !== '') always += 1;
      }
      if (always > maxNodes) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** How many nodes a preview reads before every further box is a placeholder. */
export const DEFAULT_HTML_MIRROR_PREVIEW_READ_NODES = 3_000;
/** The least share of the preview's read cap a block in view gets (D215). */
const MIN_PREVIEW_REGION_SHARE = 300;
/** Past this many nodes, placeholders included, a page gets no preview. */
export const DEFAULT_HTML_MIRROR_PREVIEW_MAX_NODES = 12_000;

export interface SourcePreviewOptions {
  readonly representability?: HtmlMirrorRepresentabilityCollector;
  readonly fidelityPolicy?: SelectableReplicaFidelityPolicy;
  readonly controlledContent?: SourceControlledContentPolicy;
  /** Nodes read in full before every further box is a placeholder. */
  readonly maxReadNodes?: number;
  /** Nodes in all; a page past it gets no preview (`undefined`). */
  readonly maxNodes?: number;
  readonly now?: () => number;
}

/**
 * A preview of the document in one task (D163): what is near the viewport
 * as the whole read has it, and every block-level box (not inline, not
 * `display: contents`) whose border box lies wholly outside the viewport
 * stretched by its own height above and below as an element with
 * `placeholder: { height }` and nothing of its content. Each element's own
 * privacy decisions are the whole read's: a secret root is its shell, a
 * withheld element keeps its withheld attributes. Nothing in `<head>`,
 * no dropdown and no style sheet becomes a placeholder, and nothing outside
 * HTML. Past `maxReadNodes` nodes every box that holds something is one,
 * whatever its place; past `maxNodes` in all there is no preview.
 */
export function sanitizeSourcePreview(
  sourceDocument: Document,
  sourceWindow: Window,
  registry: HtmlMirrorIdRegistry,
  options: SourcePreviewOptions = {},
): HtmlMirrorDocumentGraph | undefined {
  const representability = options.representability ??
    createHtmlMirrorRepresentabilityCollector();
  const documentElement = sourceProperty(sourceDocument, 'documentElement');
  if (!documentElement) return undefined;
  const maxReadNodes = Math.max(
    1,
    Math.floor(options.maxReadNodes ?? DEFAULT_HTML_MIRROR_PREVIEW_READ_NODES),
  );
  const maxNodes = Math.min(
    MAX_HTML_MIRROR_NODES,
    Math.max(maxReadNodes, Math.floor(
      options.maxNodes ?? DEFAULT_HTML_MIRROR_PREVIEW_MAX_NODES,
    )),
  );
  const viewportWidth = Number(sourceWindow.innerWidth);
  const viewportHeight = Number(sourceWindow.innerHeight);
  if (
    !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 || viewportHeight <= 0
  ) return undefined;
  const placeholder = (
    element: Element,
    tagName: string,
    budget: HtmlMirrorReadBudget,
  ): number | undefined => {
    if (budget.nodes > maxNodes) {
      throw new HtmlMirrorCapacityError();
    }
    if (
      element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      tagName === 'html' || tagName === 'head' || tagName === 'body' ||
      (element.parentElement
        ? sourceLocalName(element.parentElement).toLowerCase()
        : undefined) === 'head'
    ) return undefined;
    const display = readSourceOuterDisplay(element, sourceWindow);
    // No box at all (D171): a `display: none` menu or panel paints nothing,
    // and the whole read withholds its text, so it is a box of no height
    // here, near or far, and costs the preview's read nothing. A header of
    // closed menus of thousands of nodes used to spend the read cap before
    // the content in view was read. Not when it holds what paints elsewhere:
    // a style sheet, or SVG symbols other elements draw.
    if (display === 'none' && !holdsSourcePaintForOthers(element)) return 0;
    if (display === 'none') return undefined;
    let rect: DOMRect;
    try {
      rect = element.getBoundingClientRect();
    } catch {
      return undefined;
    }
    const height = Number.isFinite(rect.height)
      ? Math.max(0, Math.min(
          MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT,
          Math.round(rect.height),
        ))
      : 0;
    const cap = readCapOf(element);
    if (budget.nodes >= cap) {
      // Past the cap only a box that keeps a height is one (D171): an
      // inline element (`span`, `a`) ignores the height it is given, so the
      // block read when the cap was reached came out shorter. It is read
      // on, and what it holds is a box by this same rule.
      if (!sourceOuterDisplayKeepsHeight(display)) return undefined;
      return boxOfRun(element, rect, height, (next) =>
        sourceOuterDisplayKeepsHeight(readSourceOuterDisplay(next, sourceWindow)));
    }
    if (!sourceOuterDisplayIsBlockValue(display)) return undefined;
    if (isNear(rect)) {
      shareReadCap(element, rect, cap, budget);
      return undefined;
    }
    return boxOfRun(element, rect, height, (next, nextRect) =>
      !isNear(nextRect) &&
      sourceOuterDisplayIsBlockValue(readSourceOuterDisplay(next, sourceWindow)));
  };
  // The read cap shared by what is in view (D215): a header, sidebar or
  // open menu that is displayed and holds more than the cap spent all of it
  // in document order, and the content in view beside or below it was
  // boxes until the copy came. A block in view that cannot be read whole in
  // what is left of its cap gets a share of it as large as its part of the
  // viewport (at least `MIN_PREVIEW_REGION_SHARE`), and what it holds past
  // that is boxes, by the rule past the cap; what follows it reads on in
  // what it left.
  const regionCaps = new WeakMap<Element, number>();
  const viewportArea = viewportWidth * viewportHeight;
  const readCapOf = (element: Element): number => {
    let cap = maxReadNodes;
    try {
      for (
        let current = sourceProperty(element, 'parentElement');
        current;
        current = sourceProperty(current, 'parentElement')
      ) {
        const own = regionCaps.get(current);
        if (own !== undefined && own < cap) cap = own;
      }
    } catch {
      // A broken chain: the page's own cap.
    }
    return cap;
  };
  const shareReadCap = (
    element: Element,
    rect: DOMRect,
    cap: number,
    budget: HtmlMirrorReadBudget,
  ): void => {
    const left = cap - budget.nodes;
    let holds: number;
    try {
      // Each element and, about, a text: twice the elements.
      holds = (sourceCall(element, 'getElementsByTagName', '*').length ||
        sourceCall(element, 'querySelectorAll', '*').length) * 2;
    } catch {
      return;
    }
    if (holds <= left) return;
    const width = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
    const part = width > 0 && height > 0 ? (width * height) / viewportArea : 0;
    const share = Math.max(
      Math.min(left, MIN_PREVIEW_REGION_SHARE),
      Math.floor(left * Math.min(1, part)),
    );
    regionCaps.set(element, budget.nodes + share);
  };
  // A dropdown is never cut (D163), so one of tens of thousands of options
  // was read whole, past the preview's limit, and the preview was given up
  // after it (D171). One that would pass what is left of the limit is a
  // box of its height instead; the copy reads it whole, as before.
  const wholeBox = (
    element: Element,
    tagName: string,
    budget: HtmlMirrorReadBudget,
  ): number | undefined => {
    if (tagName !== 'select') return undefined;
    let estimate: number;
    try {
      // Each option and group (their text travels on the option).
      estimate = element.getElementsByTagName('*').length ||
        element.querySelectorAll('*').length;
    } catch {
      return undefined;
    }
    if (budget.nodes + estimate <= maxNodes) return undefined;
    let height = 0;
    try {
      const rect = element.getBoundingClientRect();
      if (Number.isFinite(rect.height)) {
        height = Math.max(0, Math.min(
          MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT,
          Math.round(rect.height),
        ));
      }
    } catch {
      // A box of no height.
    }
    return height;
  };
  const isNear = (rect: DOMRect): boolean =>
    rect.bottom > -viewportHeight &&
    rect.top < viewportHeight * 2 &&
    rect.right > 0 && rect.left < viewportWidth;
  // One box stands for the siblings after it that would each be a box by
  // the same rule (D169): on a page of 54,000–72,000 elements the preview
  // made 6,000–8,000 boxes, one after another, each read, checked, given an
  // id and sent, and took 64–90 ms of one task. Its height runs from its top
  // to the lowest bottom of the run, so the page keeps its height. A run
  // ends at what is not a box: text that shows, a style sheet, a script, a
  // dropdown, a field, anything outside HTML.
  const skipped = new Set<Node>();
  const boxOfRun = (
    first: Element,
    firstRect: DOMRect,
    firstHeight: number,
    alsoBox: (next: Element, nextRect: DOMRect) => boolean,
  ): number => {
    if (!Number.isFinite(firstRect.top) || !Number.isFinite(firstRect.bottom)) {
      return firstHeight;
    }
    const top = firstRect.top;
    let bottom = firstRect.bottom;
    let between: Node[] = [];
    for (let next = first.nextSibling; next; next = next.nextSibling) {
      if (sourceNodeType(next) === 3) {
        if ((next.nodeValue ?? '').trim() !== '') break;
        between.push(next);
        continue;
      }
      if (sourceNodeType(next) === 8) {
        between.push(next);
        continue;
      }
      if (sourceNodeType(next) !== 1) break;
      const element = next as Element;
      if (!standsInRunOfBoxes(element)) break;
      let nextRect: DOMRect;
      try {
        nextRect = element.getBoundingClientRect();
      } catch {
        break;
      }
      if (!Number.isFinite(nextRect.bottom) || !alsoBox(element, nextRect)) break;
      const nextBottom = Math.max(bottom, nextRect.bottom);
      if (nextBottom - top > MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT) break;
      for (const node of between) skipped.add(node);
      between = [];
      skipped.add(element);
      bottom = nextBottom;
    }
    return Math.max(firstHeight, Math.min(
      MAX_HTML_MIRROR_PLACEHOLDER_HEIGHT,
      Math.round(bottom - top),
    ));
  };
  const cut: SourceReadCut = {
    placeholder,
    wholeBox,
    maxNodes,
    skip: (node) => skipped.has(node),
    metTwice: false,
  };
  const budget = createHtmlMirrorReadBudget();
  const styleWork = createHtmlMirrorStyleWorkBudget();
  const fidelityPolicy = options.fidelityPolicy ?? 'conservative';
  const rootWalk = beginSourceShadowRootWalk({ fresh: true });
  const heldPass = beginSourceHeldAnimationPass(
    sourceDocument,
    true,
    options.now,
  );
  try {
    const controlledContent = options.controlledContent ??
      createSourceControlledContentPolicy(
        sourceDocument,
        sourceWindow,
        MAX_HTML_MIRROR_NODES,
      );
    if (controlledContent.incomplete) return undefined;
    heldPass.list(sourceDocument);
    const root = serializeNode(documentElement, {
      registry,
      baseUrl: sourceDocumentBaseUrl(sourceDocument),
      budget,
      styleWork,
      privateRegion: false,
      privacyRegion: false,
      privateAttributeRegion: false,
      activationRegion: false,
      nonContentRegion: false,
      styleRegion: false,
      hardSecretRegion: false,
      visibilityHidden: false,
      depth: 0,
      representability,
      fidelityPolicy,
      controlledContent,
      secretAncestors: createSourceSecretAncestorMemo(),
      slotRegions: new Map(),
      slotReadings: undefined,
      cut,
    });
    if (!root || root.kind !== 'element' || root.tagName !== 'html') {
      return undefined;
    }
    const adoptedStyleSheets = captureAdoptedStyleSheets(
      sourceDocument,
      sourceDocumentBaseUrl(sourceDocument),
      budget,
      styleWork,
      representability,
      fidelityPolicy,
    );
    if (!adoptedStyleSheets) return undefined;
    return Object.freeze({
      root,
      ...readSourceDocumentReadValues(
        sourceDocument,
        sourceWindow,
        documentElement,
        adoptedStyleSheets,
      ),
    });
  } catch (error) {
    if (error instanceof HtmlMirrorCapacityError) return undefined;
    throw error;
  } finally {
    heldPass.end();
    rootWalk.end();
  }
}

/**
 * Whether an element's outer display is block-level: not inline (or ruby),
 * not `display: contents`, not an inner part of a table, and displayed.
 */
/** The element's computed `display`, lower case; undefined when unreadable. */
function readSourceOuterDisplay(
  element: Element,
  sourceWindow: Window,
): string | undefined {
  try {
    return sourceWindow.getComputedStyle(element).display
      ?.trim().toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

function sourceOuterDisplayIsBlockValue(display: string | undefined): boolean {
  if (!display) return false;
  return !(
    display === 'none' || display === 'contents' ||
    display.startsWith('inline') || display.startsWith('ruby') ||
    display.startsWith('table-')
  );
}

/**
 * Whether a box of this `display` takes the height it is given (D171):
 * not an inline box (`inline`, `inline flow`, `ruby`), and not one with no
 * box of its own (`contents`, `none`). An atomic inline (`inline-block`,
 * `inline-flex`, `inline-table`) does, and so do table rows and cells.
 */
function sourceOuterDisplayKeepsHeight(display: string | undefined): boolean {
  if (!display) return false;
  return !(
    display === 'none' || display === 'contents' ||
    display === 'inline' || display === 'inline flow' ||
    display.startsWith('ruby')
  );
}

/**
 * Whether what an element holds paints outside it (D171): a style sheet, or
 * SVG symbols and definitions that other elements draw with `<use>` or
 * `url(#…)`. Such an element is read, even with no box of its own.
 */
function holdsSourcePaintForOthers(element: Element): boolean {
  try {
    return element.querySelector('style, link, symbol, defs') !== null;
  } catch {
    return true;
  }
}

/**
 * The only attributes a credential input's empty field carries: what draws
 * the box. Nothing that can hold text about the field (value, placeholder,
 * labels, `data-*`) is read.
 */
const CREDENTIAL_SHELL_ATTRIBUTES = new Set([
  'class', 'dir', 'height', 'hidden', 'id', 'lang', 'maxlength', 'minlength',
  'readonly', 'required', 'size', 'style', 'type', 'width',
  PAGE_XML_LANGUAGE_ATTRIBUTE,
]);

/**
 * A credential input (a password, card-number or one-time-code field) is
 * drawn as the empty field the page shows instead of vanishing (D76): only
 * `CREDENTIAL_SHELL_ATTRIBUTES` travel, and no value is read. Any other
 * credential region keeps the opaque identity shell, since it can hold
 * content such as a sign-in QR code.
 */
function serializeCredentialInputShell(
  element: Element,
  id: number,
  context: SerializeContext,
): HtmlMirrorElementNode | undefined {
  if (
    element.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    sourceLocalName(element).toLowerCase() !== 'input'
  ) return undefined;
  const attributes = sanitizeAttributes(
    element,
    'input',
    true,
    false,
    true,
    false,
    true,
    context.baseUrl,
    context.representability,
    context.fidelityPolicy,
  );
  if (!attributes) return undefined;
  admitNode(
    context.budget,
    id,
    attributes.reduce(
      (total, [name, value]) => total + (name.length + value.length) * 2 + 8,
      74,
    ),
    context.representability,
  );
  incrementRepresentability(
    context.representability,
    'privateTextRedactionCount',
  );
  return Object.freeze({
    kind: 'element',
    id,
    namespace: 'html',
    tagName: 'input',
    attributes,
    children: Object.freeze([]),
  });
}

function sanitizeAttributes(
  element: Element,
  tagName: string,
  privateRegion: boolean,
  activationRegion: boolean,
  privateAttributeRegion: boolean,
  disclosureWithheld: boolean,
  credentialShell: boolean,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): readonly (readonly [string, string])[] | undefined {
  if (sourceAttributeList(element).length > MAX_HTML_MIRROR_ATTRIBUTES) {
    incrementRepresentability(representability, 'capacityOmissionCount');
    return undefined;
  }
  const result: Array<readonly [string, string]> = [];
  const reflectedState = !privateAttributeRegion && !credentialShell &&
    reflectedStateMayTravel(element, tagName);
  // What a script animation that has ended still holds the element at is
  // drawn as if the element's own style said it, and is read with it: an
  // element that has no `style` gets one for it. Where the page has one
  // under another spelling, the held values join that one, and the name is
  // still sent once (below).
  const heldStyle = readSourceHeldAnimationStyle(element);
  const sourceAttributes: Iterable<SourceAttribute> =
    heldStyle && !element.hasAttribute('style')
      ? [...sourceAttributeList(element), HELD_STYLE_ATTRIBUTE]
      : sourceAttributeList(element);
  for (const attribute of sourceAttributes) {
    const xmlLanguage = isXmlNamespaceLanguage(attribute);
    const name = xmlLanguage
      ? PAGE_XML_LANGUAGE_ATTRIBUTE
      : attribute.name.toLowerCase();
    if (
      !xmlLanguage && (
        isTwinOfSentName(element, attribute, name) ||
        isAttributeChromeDoesNotRead(element, attribute, name)
      )
    ) continue;
    const svgResourceReferenceAttribute =
      element.namespaceURI === 'http://www.w3.org/2000/svg' &&
      PASSIVE_SVG_RESOURCE_ELEMENTS.has(tagName) &&
      (name === 'href' || name === 'xlink:href');
    if (!isSafeAttributeName(name)) {
      incrementRepresentability(representability, 'strippedActiveAttributeCount');
      continue;
    }
    if (
      name.startsWith('on') || name === 'nonce' ||
      (!xmlLanguage && isSimulOwnedAttributeName(name)) ||
      (isNativeSelectSemanticTag(tagName) &&
        !isNativeSelectPresentationAttribute(tagName, name)) ||
      ((tagName === 'option' || tagName === 'optgroup') && name === 'style') ||
      (isNativeSelectSemanticTag(tagName) &&
        (privateRegion || activationRegion) && name === 'label') ||
      (tagName === 'video' && MEDIA_ACTIVE_ATTRIBUTES.has(name)) ||
      (isSourceNativeTextControlTagName(tagName) &&
        RAW_CONTROL_TEXT_ATTRIBUTES.has(name) &&
        !SOURCE_PRIVACY_FILTERS_OFF) ||
      isPrivateBaseAttribute(tagName, name, reflectedState) ||
      (disclosureWithheld && AUTHOR_WORD_ATTRIBUTES.has(name)) ||
      // `data-*` is the page's own markup and travels (D76); a credential
      // input's empty field keeps only what draws its box.
      (credentialShell && !CREDENTIAL_SHELL_ATTRIBUTES.has(name))
    ) {
      incrementRepresentability(representability, 'strippedActiveAttributeCount');
      incrementRepresentability(
        representability,
        svgResourceReferenceAttribute
          ? 'strictResourcePolicyBlockCount'
          : name === 'attributionsrc' || name === 'browsingtopics' ||
            name === 'lowsrc' || name === 'sharedstoragewritable' ||
            name === 'xml:base'
          ? 'strictResourcePolicyBlockCount'
          : name === 'href' || name === 'xlink:href' || name === 'target' ||
          name === 'download' || name === 'action' || name === 'formaction'
          ? 'navigationBlockCount'
          : 'executionRiskBlockCount',
      );
      if (svgResourceReferenceAttribute) {
        incrementRepresentability(representability, 'blockedSvgResourceCount');
      }
      continue;
    }
    let value = attribute.value;
    const localSvgReference = isLocalSvgReference(
      element,
      tagName,
      name,
      value,
    );
    const passiveSvgReference = fidelityPolicy === 'passive' &&
      isPassiveSvgVisualReference(element, tagName, name, value);
    const passivePoster = fidelityPolicy === 'passive' &&
      tagName === 'video' && name === 'poster';
    if (
      (ACTIVE_OR_NAVIGATIONAL_ATTRIBUTES.has(name) &&
        !localSvgReference && !passiveSvgReference && !passivePoster)
    ) {
      incrementRepresentability(representability, 'strippedActiveAttributeCount');
      incrementRepresentability(
        representability,
        svgResourceReferenceAttribute
          ? 'strictResourcePolicyBlockCount'
          : name === 'attributionsrc' || name === 'browsingtopics' ||
            name === 'lowsrc' || name === 'sharedstoragewritable' ||
            name === 'xml:base'
          ? 'strictResourcePolicyBlockCount'
          : name === 'href' || name === 'xlink:href' || name === 'target' ||
            name === 'download' || name === 'action' || name === 'formaction'
          ? 'navigationBlockCount'
          : 'executionRiskBlockCount',
      );
      if (svgResourceReferenceAttribute) {
        incrementRepresentability(representability, 'blockedSvgResourceCount');
      }
      continue;
    }
    if (tagName === 'select' && name === 'size') {
      const size = canonicalNativeSelectSize(value);
      if (!size) {
        incrementRepresentability(
          representability,
          'strippedActiveAttributeCount',
        );
        continue;
      }
      value = size;
    }
    if (isNativeSelectSemanticTag(tagName) && name === 'role') {
      if (isSourcePrivateRoleValue(value)) value = 'textbox';
      else if (
        isSourceActivationRoleValue(value) &&
        !isSourceNativeSelectImplicitRole(tagName, value)
      ) value = 'button';
      else {
        incrementRepresentability(
          representability,
          'strippedActiveAttributeCount',
        );
        continue;
      }
    }
    if (
      name === 'alt' &&
      activationRegion &&
      isSmallBrokenSourceControlIcon(element, tagName)
    ) value = '';
    if (value.length > MAX_HTML_MIRROR_STRING) {
      incrementRepresentability(representability, 'capacityOmissionCount');
      return undefined;
    }
    if ((name === 'href' || name === 'xlink:href') && localSvgReference) {
      // Same-document symbol references cannot execute or fetch a resource.
      incrementRepresentability(representability, 'preservedSvgResourceCount');
    } else if (
      (name === 'href' || name === 'xlink:href') &&
      passiveSvgReference
    ) {
      const url = passiveUrl(
        value,
        baseUrl,
        tagName === 'image' || tagName === 'feimage',
      );
      if (!url) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        incrementRepresentability(representability, 'blockedSvgResourceCount');
        recordBlockedResourceScheme(value, baseUrl, representability);
        continue;
      }
      value = url;
      incrementRepresentability(representability, 'preservedSvgResourceCount');
      if (/^https?:\/\//u.test(url)) {
        incrementRepresentability(
          representability,
          'replicaRequestCapableResourceCount',
        );
      }
    } else if (name === 'href') {
      if (fidelityPolicy === 'passive' && tagName === 'a') {
        const url = passiveUrl(value, baseUrl, false);
        if (!url) {
          incrementRepresentability(representability, 'strippedUnsafeResourceCount');
          recordBlockedResourceScheme(value, baseUrl, representability);
          continue;
        }
        value = url;
      } else if (tagName !== 'link' || !isPassiveStylesheet(element)) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        incrementRepresentability(
          representability,
          tagName === 'a' || (
            element.namespaceURI === 'http://www.w3.org/2000/svg' &&
            PASSIVE_SVG_RESOURCE_ELEMENTS.has(tagName)
          )
            ? 'strictResourcePolicyBlockCount'
            : 'navigationBlockCount',
        );
        if (
          element.namespaceURI === 'http://www.w3.org/2000/svg' &&
          PASSIVE_SVG_RESOURCE_ELEMENTS.has(tagName)
        ) {
          incrementRepresentability(representability, 'blockedSvgResourceCount');
        }
        continue;
      } else {
        const url = passiveUrl(value, baseUrl, false);
        if (!url) {
          incrementRepresentability(representability, 'strippedUnsafeResourceCount');
          recordBlockedResourceScheme(value, baseUrl, representability);
          continue;
        }
        value = url;
        incrementRepresentability(representability, 'preservedStyleSheetCount');
        incrementRepresentability(
          representability,
          'replicaRequestCapableResourceCount',
        );
      }
    } else if (name === 'poster' && passivePoster) {
      const url = passiveUrl(value, baseUrl, true);
      if (!url) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        if (/^data:image\/svg\+xml/iu.test(value)) {
          incrementRepresentability(representability, 'blockedSvgResourceCount');
        }
        recordBlockedResourceScheme(value, baseUrl, representability);
        continue;
      }
      value = url;
      if (/^https?:\/\//u.test(url)) {
        incrementRepresentability(
          representability,
          'replicaRequestCapableResourceCount',
        );
      }
    } else if (name === 'src') {
      if (!PASSIVE_IMAGE_ELEMENTS.has(tagName)) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        continue;
      }
      const url = passiveUrl(value, baseUrl, true);
      if (!url) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        recordBlockedResourceScheme(value, baseUrl, representability);
        continue;
      }
      value = url;
      if (/^https?:\/\//u.test(url)) {
        incrementRepresentability(
          representability,
          'replicaRequestCapableResourceCount',
        );
      }
    } else if (name === 'srcset') {
      const passivePictureSource = fidelityPolicy === 'passive' &&
        tagName === 'source' && element.parentElement !== null &&
        sourceLocalName(element.parentElement) === 'picture';
      if (tagName !== 'img' && !passivePictureSource) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        incrementRepresentability(
          representability,
          'strictResourcePolicyBlockCount',
        );
        continue;
      }
      const sourceSet = sanitizeSrcset(value, baseUrl, representability);
      if (!sourceSet) continue;
      value = sourceSet;
    } else if (name === 'background') {
      if (
        fidelityPolicy !== 'passive' ||
        !LEGACY_BACKGROUND_ELEMENTS.has(tagName)
      ) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        incrementRepresentability(
          representability,
          'strictResourcePolicyBlockCount',
        );
        continue;
      }
      const url = passiveUrl(value, baseUrl, true);
      if (!url) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        recordBlockedResourceScheme(value, baseUrl, representability);
        continue;
      }
      value = url;
      if (/^https?:\/\//u.test(url)) {
        incrementRepresentability(
          representability,
          'replicaRequestCapableResourceCount',
        );
      }
    } else if (name === 'style') {
      const classifiedBefore = classifiedStyleOmissionCount(representability);
      const sanitizeStyle = (text: string): string | undefined =>
        tagName === 'select'
          ? sanitizeNativeSelectStyle(
              text,
              baseUrl,
              representability,
              fidelityPolicy,
            )
          : sanitizeCss(
              text,
              baseUrl,
              true,
              representability,
              fidelityPolicy,
            );
      const own = sanitizeStyle(value);
      if (
        own === undefined &&
        classifiedStyleOmissionCount(representability) === classifiedBefore
      ) {
        incrementRepresentability(representability, 'unreadableStyleCount');
      }
      // What the element's ended script animations hold is read apart from
      // the page's own declarations and stands after them: a style the page
      // cut off in a bracket or a string, or one that is refused, does not
      // take it along. If the two together would not read as they were
      // written, the held values, which are what is drawn, travel alone.
      let held: string | undefined;
      if (heldStyle) {
        // Thousands of elements often hold the same few values (every
        // card of a page that fades its cards in): one that came through
        // as it was is not gone through again for each of them.
        const known = `${fidelityPolicy}|${tagName === 'select'}|${heldStyle}`;
        if (CLEAN_HELD_STYLES.has(known)) {
          held = heldStyle;
        } else {
          held = sanitizeStyle(heldStyle);
          if (held === heldStyle && held.length <= MAX_CLEAN_HELD_STYLE_LENGTH) {
            if (CLEAN_HELD_STYLES.size >= MAX_CLEAN_HELD_STYLES) {
              CLEAN_HELD_STYLES.clear();
            }
            CLEAN_HELD_STYLES.add(known);
          }
        }
      }
      let style = own;
      if (held) {
        style = held;
        if (own?.trim()) {
          const joined = `${closeCssBlocks(own)};${held}`;
          if (sanitizeStyle(joined) === joined) style = joined;
        }
      }
      if (!style) continue;
      value = style;
    } else if (
      element.namespaceURI === 'http://www.w3.org/2000/svg' &&
      SVG_URL_PRESENTATION_ATTRIBUTES.has(name)
    ) {
      if (hasBareSvgResourceScheme(value)) {
        incrementRepresentability(representability, 'strippedUnsafeResourceCount');
        recordBlockedResourceScheme(value, baseUrl, representability);
        continue;
      }
      const classifiedBefore = classifiedStyleOmissionCount(representability);
      const presentation = sanitizeCss(
        value,
        baseUrl,
        true,
        representability,
        fidelityPolicy,
      );
      if (presentation === undefined) {
        if (
          classifiedStyleOmissionCount(representability) === classifiedBefore
        ) {
          incrementRepresentability(representability, 'unreadableStyleCount');
        }
        continue;
      }
      value = presentation;
    } else if (name === 'rel' && tagName === 'link') {
      if (!isPassiveStylesheet(element)) continue;
      value = 'stylesheet';
    } else if (
      (name === 'media' &&
        (tagName === 'link' || tagName === 'style' || tagName === 'source')) ||
      (name === 'sizes' && (tagName === 'img' || tagName === 'source'))
    ) {
      // A sheet's or a picture source's media query, and the conditions of
      // an image's sizes, are read as the tab reads them.
      value = answerScriptingMediaFeatures(value);
    } else if (name === 'http-equiv' || name === 'content') {
      if (tagName === 'meta') continue;
    }
    // One name is sent once, whatever the page did (see `isTwinOfSentName`).
    if (result.some(([sent]) => sent === name)) continue;
    result.push(Object.freeze([name, value] as const));
  }
  if (tagName === 'html' && element === sourceDocumentProperty(element.ownerDocument, 'documentElement')) {
    const language = readSourceDocumentLanguage(element);
    if (language !== undefined) {
      result.push(
        Object.freeze([PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE, language] as const),
      );
    }
  }
  if (
    (tagName === 'link' || tagName === 'style') &&
    !result.some(([name]) => name === 'disabled') &&
    sourceStyleSheetDisabled(element)
  ) {
    result.unshift(Object.freeze(['disabled', ''] as const));
  }
  // A form is not made inert: that would also block Simul's own dropdowns
  // inside it (most real select boxes sit in a form). Submission stays
  // impossible through the frame sandbox (no allow-forms), the shell CSP's
  // form-action 'none', and the document-wide activation guard.
  return Object.freeze(result);
}

function sourceStyleSheetDisabled(element: Element): boolean {
  try {
    return (element as Element & {
      readonly sheet?: CSSStyleSheet | null;
    }).sheet?.disabled === true;
  } catch {
    return false;
  }
}

export function createHtmlMirrorReadBudget(
  ids: Set<number> = new Set(),
): HtmlMirrorReadBudget {
  return {
    nodes: 0,
    inspectedNodes: 0,
    bytes: 0,
    styleSheets: 0,
    styleRules: 0,
    ids,
    adoptedStyleTexts: new Map(),
  };
}

/** What one more use of an already counted adopted sheet costs: its index. */
const ADOPTED_STYLE_REFERENCE_BYTES = 8;

function captureAdoptedStyleSheets(
  owner: Document | ShadowRoot,
  baseUrl: string,
  budget: HtmlMirrorReadBudget,
  work: HtmlMirrorStyleWorkBudget,
  representability: HtmlMirrorRepresentabilityCollector,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): readonly string[] | undefined {
  const styles = sanitizeSourceAdoptedStyleSheets(
    owner,
    baseUrl,
    work,
    representability,
    fidelityPolicy,
  );
  if (!styles) return undefined;
  for (const cssText of styles) {
    budget.bytes += ADOPTED_STYLE_REFERENCE_BYTES;
    if (!budget.adoptedStyleTexts.has(cssText)) {
      const styleRules = countCssRuleBlocks(cssText);
      if (
        budget.styleSheets + 1 > MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS ||
        budget.styleRules + styleRules > MAX_HTML_MIRROR_ADOPTED_STYLE_RULES
      ) {
        incrementRepresentability(representability, 'capacityOmissionCount');
        return undefined;
      }
      budget.adoptedStyleTexts.set(cssText, styleRules);
      budget.styleSheets += 1;
      budget.styleRules += styleRules;
      budget.bytes += cssText.length * 2 + 16;
    }
    if (budget.bytes > MAX_HTML_MIRROR_BYTES) {
      incrementRepresentability(representability, 'capacityOmissionCount');
      return undefined;
    }
  }
  return styles;
}

function readTransportedAdoptedStyleSheets(
  input: unknown,
  budget: HtmlMirrorReadBudget,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): readonly string[] | undefined {
  if (
    !Array.isArray(input) ||
    input.length > MAX_ADOPTED_STYLE_SHEETS_PER_OWNER
  ) return undefined;
  const styles: string[] = [];
  let ownerCharacters = 0;
  let ownerRules = 0;
  for (const cssText of input) {
    if (typeof cssText !== 'string') return undefined;
    let styleRules = budget.adoptedStyleTexts.get(cssText);
    if (styleRules === undefined) {
      if (
        cssText.length > MAX_HTML_MIRROR_STRING ||
        sanitizeCss(
          cssText,
          'about:blank',
          false,
          undefined,
          fidelityPolicy,
        ) !== cssText
      ) return undefined;
      styleRules = countCssRuleBlocks(cssText);
      if (
        budget.styleSheets + 1 > MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS ||
        budget.styleRules + styleRules > MAX_HTML_MIRROR_ADOPTED_STYLE_RULES
      ) return undefined;
      budget.adoptedStyleTexts.set(cssText, styleRules);
      budget.styleSheets += 1;
      budget.styleRules += styleRules;
      budget.bytes += cssText.length * 2 + 16;
    }
    ownerCharacters += cssText.length;
    ownerRules += styleRules;
    budget.bytes += ADOPTED_STYLE_REFERENCE_BYTES;
    if (
      ownerCharacters > MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER ||
      ownerRules > MAX_ADOPTED_STYLE_RULES_PER_OWNER ||
      budget.bytes > MAX_HTML_MIRROR_BYTES
    ) return undefined;
    styles.push(cssText);
  }
  return Object.freeze(styles);
}

function readAdoptedStyleSheet(
  sheet: CSSStyleSheet,
  baseUrl: string,
  work: HtmlMirrorStyleWorkBudget,
  representability: HtmlMirrorRepresentabilityCollector,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): AdoptedStyleSheetRead | undefined {
  try {
    const mediaText = sheet.media?.mediaText?.trim() ?? '';
    if (mediaText.length > MAX_HTML_MIRROR_STRING) {
      work.exhausted = true;
      incrementRepresentability(representability, 'capacityOmissionCount');
      return undefined;
    }
    const capacityBefore = representability.capacityOmissionCount;
    const serialized = serializeReadableStyleSheetRules(
      sheet,
      // Where a redirected sheet came from (D180).
      readSourceSheetBase(sheet) ?? sheet.href ?? baseUrl,
      fidelityPolicy,
      representability,
      new Set(),
      0,
    );
    if (serialized.status !== 'readable') {
      if (representability.capacityOmissionCount > capacityBefore) {
        work.exhausted = true;
      }
      return undefined;
    }
    const flattened = serialized.value;
    if (!flattened || work.rules + flattened.ruleCount > work.maxRules) {
      work.exhausted = Boolean(flattened);
      return undefined;
    }
    const rulesText = flattened.cssText;
    const cssText = sanitizeCss(
      mediaText ? `@media ${mediaText}{${rulesText}}` : rulesText,
      baseUrl,
      false,
      // Individual readable rules were already normalized and counted while
      // flattening. This pass validates only the final media wrapper; feeding
      // the public collector through it would double-count every CSS URL.
      undefined,
      fidelityPolicy,
    );
    return cssText === undefined
      ? undefined
      : Object.freeze({
          cssText,
          ruleCount: flattened.ruleCount,
        });
  } catch {
    return undefined;
  }
}

function serializeReadableStyleSheetRules(
  sheet: CSSStyleSheet,
  baseUrl: string,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
  representability: HtmlMirrorRepresentabilityCollector,
  visited: Set<object>,
  depth: number,
): ReadableStyleSheetRulesResult {
  if (depth > 8 || visited.has(sheet)) {
    incrementRepresentability(representability, 'capacityOmissionCount');
    return { status: 'blocked' };
  }
  visited.add(sheet);
  try {
    const rules = sheet.cssRules;
    if (
      !Number.isSafeInteger(rules.length) ||
      rules.length < 0
    ) {
      incrementRepresentability(
        representability,
        'browserInaccessibleResourceCount',
      );
      return { status: 'unreadable' };
    }
    if (rules.length > MAX_ADOPTED_STYLE_RULES_PER_OWNER) {
      incrementRepresentability(representability, 'capacityOmissionCount');
      return { status: 'blocked' };
    }
    const parts: string[] = [];
    let ruleCount = 0;
    let characters = 0;
    for (let index = 0; index < rules.length; index += 1) {
      const rule = rules[index] ?? rules.item(index);
      if (!rule || typeof rule.cssText !== 'string') {
        incrementRepresentability(
          representability,
          'browserInaccessibleResourceCount',
        );
        return { status: 'unreadable' };
      }
      let cssText: string | undefined;
      const importLike = /^@import\b/iu.test(rule.cssText);
      const importedSheet = importLike
        ? (rule as CSSRule & { readonly styleSheet?: CSSStyleSheet | null })
            .styleSheet
        : undefined;
      if (importedSheet) {
        const classifiedBefore = classifiedStyleOmissionCount(
          representability,
        );
        const nested = serializeReadableStyleSheetRules(
          importedSheet,
          readSourceSheetBase(importedSheet) ?? importedSheet.href ?? baseUrl,
          fidelityPolicy,
          representability,
          visited,
          depth + 1,
        );
        cssText = nested.status === 'readable'
          ? wrapFlattenedImport(rule, nested.value.cssText)
          : undefined;
        if (nested.status === 'blocked') {
          // A readable CSSOM import that cannot be flattened must never fall
          // back to its original request-bearing @import. Omit only that
          // branch so later safe rules retain their cascade position.
          incrementRepresentability(
            representability,
            'omittedStyleSheetCount',
          );
          if (
            classifiedStyleOmissionCount(representability) ===
            classifiedBefore
          ) {
            incrementRepresentability(
              representability,
              'browserInaccessibleResourceCount',
            );
          }
          continue;
        }
        if (nested.status === 'readable') {
          ruleCount += nested.value.ruleCount;
          incrementRepresentability(
            representability,
            'flattenedStyleSheetCount',
          );
        }
      }
      if (cssText === undefined) {
        cssText = sanitizeCss(
          rule.cssText,
          baseUrl,
          false,
          representability,
          fidelityPolicy,
        );
        ruleCount += countCssRuleBlocks(cssText ?? '');
      }
      if (cssText === undefined) return { status: 'blocked' };
      if (!cssText) continue;
      const separator = parts.length > 0 ? 1 : 0;
      characters += separator + cssText.length;
      if (characters > MAX_HTML_MIRROR_STRING) {
        incrementRepresentability(representability, 'capacityOmissionCount');
        return { status: 'blocked' };
      }
      parts.push(cssText);
    }
    return Object.freeze({
      status: 'readable' as const,
      value: Object.freeze({ cssText: parts.join('\n'), ruleCount }),
    });
  } catch {
    incrementRepresentability(
      representability,
      'browserInaccessibleResourceCount',
    );
    return { status: 'unreadable' };
  } finally {
    visited.delete(sheet);
  }
}

function wrapFlattenedImport(rule: CSSRule, cssText: string): string {
  const imported = rule as CSSRule & {
    readonly media?: MediaList;
    readonly layerName?: string | null;
    readonly supportsText?: string | null;
  };
  let wrapped = cssText;
  const media = imported.media?.mediaText?.trim();
  if (media) wrapped = `@media ${media}{${wrapped}}`;
  const supports = imported.supportsText?.trim();
  if (supports) wrapped = `@supports ${supports}{${wrapped}}`;
  if (imported.layerName !== undefined && imported.layerName !== null) {
    const layerName = imported.layerName.trim();
    wrapped = layerName
      ? `@layer ${layerName}{${wrapped}}`
      : `@layer{${wrapped}}`;
  }
  return wrapped;
}

function readResolvedElementStyleSheet(
  element: Element,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector | undefined,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
  sharedWork?: HtmlMirrorStyleWorkBudget,
): string | undefined {
  const tagName = sourceLocalName(element).toLowerCase();
  if (tagName !== 'style' && tagName !== 'link') return undefined;
  if (tagName === 'link' && !isPassiveStylesheet(element)) return undefined;
  let sheet: CSSStyleSheet | null | undefined;
  try {
    sheet = (element as Element & { readonly sheet?: CSSStyleSheet | null }).sheet;
  } catch {
    sheet = undefined;
  }
  if (!sheet) {
    if (representability && tagName === 'link') {
      incrementRepresentability(
        representability,
        'browserInaccessibleResourceCount',
      );
    }
    return undefined;
  }
  const work = sharedWork ?? createHtmlMirrorStyleWorkBudget({
    maxSheets: 1,
    maxRules: MAX_ADOPTED_STYLE_RULES_PER_OWNER,
    maxCharacters: MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER,
  });
  if (work.exhausted) {
    work.exhausted = true;
    if (representability) {
      incrementRepresentability(representability, 'capacityOmissionCount');
    }
    return undefined;
  }
  // A `<style>` whose sheet a script switched off applies no rule. The
  // element has no attribute that says so (a `<link>` has), and the mirror
  // makes its sheet anew from the text it is given: an empty text (D143).
  if (tagName === 'style' && sourceStyleSheetDisabled(element)) return '';
  const cacheMiss = !work.cache.has(sheet);
  const classifiedBefore = representability
    ? classifiedStyleOmissionCount(representability)
    : 0;
  let resolved = work.cache.get(sheet);
  if (cacheMiss) {
    if (work.sheets + 1 > work.maxSheets) {
      work.exhausted = true;
      if (representability) {
        incrementRepresentability(representability, 'capacityOmissionCount');
      }
      return undefined;
    }
    work.sheets += 1;
    resolved = readAdoptedStyleSheet(
      sheet,
      readSourceSheetBase(sheet) ?? sheet.href ?? baseUrl,
      work,
      representability ?? createHtmlMirrorRepresentabilityCollector(),
      fidelityPolicy,
    ) ?? null;
    if (resolved && LOST_SHORTHAND_DECLARATION.test(resolved.cssText)) {
      const cssText = readStyleElementSourceText(
        element,
        sheet,
        baseUrl,
        fidelityPolicy,
      );
      if (cssText !== undefined) {
        resolved = Object.freeze({ cssText, ruleCount: resolved.ruleCount });
      }
    }
    if (
      resolved &&
      (
        work.rules + resolved.ruleCount > work.maxRules ||
        work.characters + resolved.cssText.length > work.maxCharacters
      )
    ) {
      work.exhausted = true;
      resolved = null;
    } else if (resolved) {
      work.rules += resolved.ruleCount;
      work.characters += resolved.cssText.length;
    }
    work.cache.set(sheet, resolved);
  }
  if (work.exhausted) {
    if (representability) {
      incrementRepresentability(representability, 'capacityOmissionCount');
    }
    return undefined;
  }
  if (!resolved && representability) {
    if (
      cacheMiss &&
      classifiedStyleOmissionCount(representability) === classifiedBefore
    ) {
      incrementRepresentability(representability, 'unreadableStyleCount');
      incrementRepresentability(
        representability,
        'browserInaccessibleResourceCount',
      );
    }
  } else if (resolved && representability) {
    incrementRepresentability(representability, 'preservedStyleSheetCount');
  }
  return resolved?.cssText;
}

/**
 * Chrome's CSSOM cannot write back a shorthand that holds var() once a later
 * declaration in the same rule sets one of its longhands: `font:var(--f);
 * line-height:2` reads as `font-style: ; font-weight: ; …`, and the replica
 * drops those empty longhands, losing the whole font (Reddit's buttons, D83).
 * Custom properties may be empty on purpose; standard properties never are.
 */
const LOST_SHORTHAND_DECLARATION = /[{;]\s*[a-z][a-z-]*\s*:\s*[;}]/u;

/**
 * A `<style>` element's own text, when it still holds exactly the rules its
 * sheet has: re-parsing it must give the same rules, so text a script has
 * since changed through the CSSOM (insertRule, CSS-in-JS) is never used.
 */
function readStyleElementSourceText(
  element: Element,
  sheet: CSSStyleSheet,
  baseUrl: string,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): string | undefined {
  if (sourceLocalName(element).toLowerCase() !== 'style') return undefined;
  const text = element.textContent ?? '';
  const Sheet = sourceDocumentProperty(element.ownerDocument, 'defaultView')?.CSSStyleSheet;
  if (!text || text.length > MAX_HTML_MIRROR_STRING || typeof Sheet !== 'function') {
    return undefined;
  }
  try {
    const parsed = new Sheet();
    parsed.replaceSync(text);
    const live = sheet.cssRules;
    if (parsed.cssRules.length !== live.length) return undefined;
    for (let index = 0; index < live.length; index += 1) {
      if (parsed.cssRules[index]?.cssText !== live[index]?.cssText) {
        return undefined;
      }
    }
    const mediaText = sheet.media?.mediaText?.trim() ?? '';
    return sanitizeCss(
      mediaText ? `@media ${mediaText}{${text}}` : text,
      baseUrl,
      false,
      // The CSSOM read already counted this sheet's URLs.
      undefined,
      fidelityPolicy,
    );
  } catch {
    return undefined;
  }
}

function readTransportedResolvedStyleSheetText(
  input: unknown,
  tagName: string,
  budget: HtmlMirrorReadBudget,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): string | undefined {
  if (input === undefined) return undefined;
  if (
    (tagName !== 'style' && tagName !== 'link') ||
    typeof input !== 'string' ||
    !isTransportableStyleSheetText(input, fidelityPolicy)
  ) return undefined;
  budget.bytes += input.length * 2 + 24;
  return budget.bytes <= MAX_HTML_MIRROR_BYTES ? input : undefined;
}

/**
 * Whether the mirror takes `cssText` as a sheet's text: nothing in it that
 * the page reader would have taken out or rewritten.
 */
export function isTransportableStyleSheetText(
  cssText: string,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  return fidelityPolicy === 'passive' &&
    cssText.length <= MAX_HTML_MIRROR_STRING &&
    sanitizeCss(cssText, 'about:blank', false, undefined, fidelityPolicy) ===
      cssText;
}

/**
 * What was added to the end of a sheet's text since the mirror was last sent
 * it, when that is all that changed and the mirror takes it on its own: a
 * page that adds rules by appending text to a `<style>` (D143). Nothing when
 * the sheet must be sent whole.
 */
export function appendedStyleSheetText(
  previous: string | undefined,
  current: string,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): string | undefined {
  if (
    !previous || current.length <= previous.length ||
    !current.startsWith(previous)
  ) return undefined;
  const appended = current.slice(previous.length);
  return isTransportableStyleSheetText(appended, fidelityPolicy)
    ? appended
    : undefined;
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
  representability?: HtmlMirrorRepresentabilityCollector,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
): string | undefined {
  if (css.length > MAX_HTML_MIRROR_STRING) {
    if (representability) {
      incrementRepresentability(
        representability,
        'capacityOmissionCount',
      );
    }
    return undefined;
  }
  {
    // A string that a line break cuts is read as Chrome reads it (D202; in
    // a `style` attribute since D216).
    const read = readCssSheetBadStrings(css, declarationList);
    if (read === undefined) return undefined;
    css = read;
  }
  let commentless = stripCssCommentsOutsideStrings(css, !declarationList);
  if (commentless === undefined) return undefined;
  // Queries about scripts are answered in the text as it came, where a
  // comment still parts two names; a declaration list holds no rule. Most
  // sheets do not name the feature and are not gone through.
  const namesScripting = !declarationList && NAMES_SCRIPTING.test(commentless);
  if (namesScripting) {
    const answered = answerCssScriptingQueries(css, false);
    if (answered !== css) {
      // Its strings are the ones that were just read.
      commentless = stripCssCommentsOutsideStrings(answered);
      if (commentless === undefined) return undefined;
    }
  }
  const decodedExecutable = decodeCssEscapes(
    cssExecutableProjection(commentless),
  );
  if (
    /(?:expression\s*\(|-moz-binding\s*:|javascript\s*:)/iu.test(
      decodedExecutable,
    ) ||
    containsLegacyBehaviorDeclaration(decodedExecutable, declarationList)
  ) {
    if (representability) {
      incrementRepresentability(
        representability,
        'strippedUnsafeResourceCount',
      );
      incrementRepresentability(
        representability,
        'executionRiskBlockCount',
      );
    }
    return undefined;
  }
  const withoutImports = fidelityPolicy === 'passive'
    ? rewritePassiveCssImports(commentless, baseUrl, representability)
    : stripCssImports(commentless, () => {
        if (representability) {
          incrementRepresentability(
            representability,
            'strippedUnsafeResourceCount',
          );
          incrementRepresentability(
            representability,
            'omittedStyleSheetCount',
          );
          incrementRepresentability(
            representability,
            'strictResourcePolicyBlockCount',
          );
        }
      });
  if (withoutImports === undefined) return undefined;
  const literalExecutableWithoutImports = cssExecutableProjection(withoutImports);
  const decodedWithoutImports = decodeCssEscapes(
    literalExecutableWithoutImports,
    true,
  );
  const decodedImageSetCount = decodedWithoutImports.match(
    /(?:-webkit-)?image-set\s*\(/giu,
  )?.length ?? 0;
  const literalImageSetCount = literalExecutableWithoutImports.match(
    /(?:-webkit-)?image-set\s*\(/giu,
  )?.length ?? 0;
  if (decodedImageSetCount !== literalImageSetCount) {
    if (representability) {
      incrementRepresentability(
        representability,
        'strippedUnsafeResourceCount',
      );
    }
    return undefined;
  }
  const normalizedImageSets = rewriteCssImageSetStrings(
    withoutImports,
    baseUrl,
    representability,
  );
  if (normalizedImageSets === undefined) return undefined;
  const literalExecutableNormalizedCss = cssExecutableProjection(
    normalizedImageSets,
  );
  const decodedNormalizedCss = decodeCssEscapes(
    literalExecutableNormalizedCss,
    true,
  );
  const decodedUrlCount = decodedNormalizedCss.match(/\burl\s*\(/giu)?.length ?? 0;
  const literalUrlCount = literalExecutableNormalizedCss.match(
    /\burl\s*\(/giu,
  )?.length ?? 0;
  // Preserve meaningful selector/string escapes, but reject an escaped URL
  // function name that the literal rewriter below cannot safely isolate.
  if (decodedUrlCount !== literalUrlCount) {
    if (representability) {
      incrementRepresentability(
        representability,
        'strippedUnsafeResourceCount',
      );
    }
    return undefined;
  }
  const rewritten = rewriteCssUrlsOutsideStrings(
    normalizedImageSets,
    baseUrl,
    representability,
  );
  // Taking the comments out joins what stood on either side of each. A
  // feature that only that made (`(scrip/**/ting)`, or a rule named
  // `@med/**/ia`) is none to the tab, and is written as none.
  const answered = rewritten === undefined || !namesScripting
    ? rewritten
    : answerCssScriptingQueries(rewritten, true);
  return answered === undefined || declarationList
    ? answered
    : rewriteStandInSelectors(rewriteAlertRoleSelectors(answered));
}

/**
 * The attribute the mirror keeps a page's alert role in (D178): it takes
 * `role="alert"` off, and `alertdialog` down to `dialog`, so that a screen
 * reader hears an alert once, from the tab.
 */
const PAGE_ROLE_ATTRIBUTE = 'data-simul-page-role';

/**
 * A page's rules for its alerts still apply in the mirror (D181): a
 * selector `[role="alert"]`, `[role=alertdialog]`, `[role~=alert]` and the
 * like, or `[role]`, also matches the element by the role the mirror keeps
 * for it: `[role="alert"]` is written `:is([role="alert"],[data-simul-page-
 * role="alert"])`, with the page's own operator, value and flag. Only a
 * selector (one a `{` follows before a `;` or a `}`) is written so, never a
 * value such as a grid line named `[role]`, and never a string. Written
 * once: one already inside such an `:is(` is left as it is, so the text is
 * read the same when the panel reads it again.
 */
function rewriteAlertRoleSelectors(css: string): string {
  if (!/role/iu.test(css)) return css;
  const projection = cssExecutableProjection(css);
  const parts: string[] = [];
  let segmentStart = 0;
  const pattern = /\[[ \t\n\r\f]*role[ \t\n\r\f]*(?:[~|^$*]?=|\])/giu;
  for (let match = pattern.exec(projection); match; match = pattern.exec(projection)) {
    const start = match.index;
    const close = projection.indexOf(']', start);
    if (close < 0) break;
    pattern.lastIndex = close + 1;
    if (css.slice(Math.max(0, start - 4), start).toLowerCase() === ':is(') continue;
    const selector = css.slice(start, close + 1);
    const lower = selector.toLowerCase();
    if (!lower.includes('alert') && !/^\[[ \t\n\r\f]*role[ \t\n\r\f]*\]$/u.test(lower)) {
      continue;
    }
    if (!cssPositionStartsBlock(projection, close + 1)) continue;
    const name = lower.indexOf('role');
    parts.push(
      css.slice(segmentStart, start),
      `:is(${selector},[${PAGE_ROLE_ATTRIBUTE}${selector.slice(name + 4)})`,
    );
    segmentStart = close + 1;
  }
  if (segmentStart === 0) return css;
  parts.push(css.slice(segmentStart));
  return parts.join('');
}

/** The mark of the label Simul adds to an image-replaced link or list item. */
const PAINTED_LABEL_OVERLAY_SELECTOR =
  ':where(:not([data-simul-painted-semantic-label-overlay]))';
/**
 * What else each type selector names in the mirror: the element that stands
 * in a dropdown's place, and the places held for what the reader leaves out.
 */
const TYPE_STAND_IN_SELECTORS: ReadonlyMap<string, string> = new Map([
  ['select', ':where([data-simul-owned-select-host])'],
  ...HTML_MIRROR_LEFT_OUT_TAG_NAMES.map((name) => [
    name,
    `:where([${HTML_MIRROR_LEFT_OUT_ATTRIBUTE}="${name}"])`,
  ] as const),
]);
const NAMES_STAND_IN_SELECTOR =
  /last-child|only-child|select|script|template|iframe|noscript|object|embed|audio/iu;
/** Functions whose arguments are selectors. */
const CSS_SELECTOR_FUNCTIONS = new Set([
  'has', 'host', 'host-context', 'is', 'matches', 'not', 'slotted', 'where',
  '-webkit-any',
]);

/**
 * A page's selectors still count and name its own elements where the mirror
 * adds one or stands in for one (D202), at the specificity they had:
 *
 * - the label Simul appends to an image-replaced link or list item (D178)
 *   is no child to `:last-child`, `:only-child` or `:nth-last-child()`
 *   (`:last-child` is written `:nth-last-child(1 of :where(:not([…])))`),
 *   and it is a `bdi`, so the `-of-type` counts of the page's own types are
 *   as in the tab (D208);
 * - the type selector `select` also names the element that stands in for a
 *   dropdown (D62), so `select + .hint` and `.field:has(select)` match;
 * - `script`, `iframe` and the other elements the reader leaves out also
 *   name the place the mirror holds for each (D181), which carries the
 *   name in `data-simul-left-out` (D208), so `script + p` matches.
 *
 * Only selectors are written so: a style rule's prelude, an `@scope`'s
 * bounds and the selector arguments in them, never another at-rule's
 * prelude (`@supports selector()` asks whether a selector is understood,
 * which the written one is as well), a declaration or an attribute
 * selector. Written once: the text it writes reads the same when the panel
 * reads it again.
 */
function rewriteStandInSelectors(css: string): string {
  if (!NAMES_STAND_IN_SELECTOR.test(css)) return css;
  const { tokens } = tokenizeCssForBadStrings(css);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const text = (index: number): string => {
    const token = tokens[index];
    return token ? css.slice(token.start, token.end) : '';
  };
  const blockEnd = (open: number): number => {
    const closers: string[] = [tokens[open]!.closer!];
    let index = open + 1;
    for (; index < tokens.length && closers.length > 0; index += 1) {
      const token = tokens[index]!;
      if (token.kind === 'open') closers.push(token.closer!);
      else if (token.kind === 'close' && token.closer === closers[closers.length - 1]) {
        closers.pop();
      }
    }
    return index;
  };
  const rewritePrelude = (from: number, to: number, scope = false): void => {
    // For each open block: whether selectors stand in it. In an `@scope`
    // prelude they stand in its bare parentheses only.
    const selectorBlocks: boolean[] = [];
    const inSelector = () => selectorBlocks.length === 0
      ? !scope
      : selectorBlocks[selectorBlocks.length - 1]!;
    for (let index = from; index < to; index += 1) {
      const token = tokens[index]!;
      if (token.kind === 'open') {
        const before = tokens[index - 1];
        const named = before?.kind === 'other' && before.end === token.start
          ? text(index - 1).toLowerCase()
          : '';
        const colon = tokens[index - 2]?.kind === 'colon';
        const selectors = (token.closer === ')' && colon &&
          CSS_SELECTOR_FUNCTIONS.has(named) && inSelector()) ||
          (scope && selectorBlocks.length === 0 && token.closer === ')' && !named);
        if (
          token.closer === ')' && colon && named === 'nth-last-child' && inSelector()
        ) {
          const close = blockEnd(index) - 1;
          let of = false;
          for (let inner = index + 1; inner < close; inner += 1) {
            if (text(inner).toLowerCase() === 'of') of = true;
          }
          if (!of && close > index && tokens[close]?.kind === 'close') {
            edits.push({
              start: tokens[close]!.start,
              end: tokens[close]!.start,
              text: ` of ${PAINTED_LABEL_OVERLAY_SELECTOR}`,
            });
          }
          index = close;
          continue;
        }
        selectorBlocks.push(selectors);
        continue;
      }
      if (token.kind === 'close') {
        selectorBlocks.pop();
        continue;
      }
      if (token.kind !== 'other' || !inSelector()) continue;
      const name = text(index).toLowerCase();
      const before = tokens[index - 1];
      const pseudoClass = before?.kind === 'colon' && before.end === token.start &&
        tokens[index - 2]?.kind !== 'colon';
      const followedByCall = tokens[index + 1]?.kind === 'open' &&
        tokens[index + 1]!.closer === ')' && tokens[index + 1]!.start === token.end;
      if (pseudoClass && !followedByCall && name === 'last-child') {
        edits.push({
          start: token.start,
          end: token.end,
          text: `nth-last-child(1 of ${PAINTED_LABEL_OVERLAY_SELECTOR})`,
        });
      } else if (pseudoClass && !followedByCall && name === 'only-child') {
        edits.push({
          start: before!.start,
          end: token.end,
          text: `:where(:first-child):nth-last-child(1 of ${PAINTED_LABEL_OVERLAY_SELECTOR})`,
        });
      } else if (TYPE_STAND_IN_SELECTORS.has(name) && !followedByCall) {
        const standIn = TYPE_STAND_IN_SELECTORS.get(name)!;
        const previous = before ? text(index - 1) : '';
        const typePosition = index === from || !before || before.kind === 'space' ||
          before.kind === 'comma' || (before.kind === 'open' && before.closer === ')') ||
          previous === '>' || previous === '+' || previous === '~';
        const next = text(index + 1);
        // Written already: the first argument of the `:is(` this writes.
        const written = before?.kind === 'open' && text(index - 2).toLowerCase() === 'is' &&
          css.startsWith(`,${standIn})`, token.end);
        if (typePosition && next !== '|' && !written) {
          edits.push({
            start: token.start,
            end: token.end,
            text: `:is(${css.slice(token.start, token.end)},${standIn})`,
          });
        }
      }
    }
  };
  // `top`: a list of rules, where a `;` ends no rule; `outermost`: the
  // sheet's own list, where a stray `}` closes nothing. Every other list
  // ends at its block's `}`, a group rule's too (D226: a group rule's read
  // ran on past its `}`, and each group rule after it read the rest of the
  // sheet again, so a sheet's time doubled with each one).
  const readList = (
    index: number,
    top: boolean,
    depth: number,
    outermost = false,
  ): number => {
    if (depth > MAX_CSS_BAD_STRING_NESTING) return tokens.length;
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token.kind === 'space' || token.kind === 'semicolon') {
        index += 1;
        continue;
      }
      if (token.kind === 'close' && token.closer === '}') {
        if (!outermost) return index;
        index += 1;
        continue;
      }
      const start = index;
      const atRule = token.kind === 'at';
      const custom = !top && !atRule && text(index).startsWith('--');
      let preludeEnd = -1;
      let end = index;
      for (; end < tokens.length; end += 1) {
        const current = tokens[end]!;
        if (current.kind === 'open') {
          if (current.closer === '}' && !custom) {
            preludeEnd = end;
            break;
          }
          end = blockEnd(end) - 1;
          continue;
        }
        if (current.kind === 'close' && current.closer === '}') break;
        if (current.kind === 'semicolon' && (!top || atRule)) {
          end += 1;
          break;
        }
      }
      if (preludeEnd < 0) {
        index = end;
        continue;
      }
      const close = blockEnd(preludeEnd);
      const atName = atRule ? text(start).slice(1).toLowerCase() : '';
      if (!atRule) rewritePrelude(start, preludeEnd);
      else if (atName === 'scope') rewritePrelude(start + 1, preludeEnd, true);
      // Keyframe selectors and declarations are not selectors.
      if (atName !== 'keyframes' && atName !== '-webkit-keyframes' &&
        !(atRule && !CSS_RULE_LIST_AT_RULES.has(atName))) {
        readList(preludeEnd + 1, top && atRule, depth + 1);
      }
      index = close;
    }
    return index;
  };
  readList(0, true, 0, true);
  if (edits.length === 0) return css;
  edits.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    parts.push(css.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(css.slice(cursor));
  return parts.join('');
}

/** Whether a `{` comes before a `;` or a `}` outside brackets from `from`. */
function cssPositionStartsBlock(projection: string, from: number): boolean {
  let depth = 0;
  for (let index = from; index < projection.length; index += 1) {
    const character = projection[index];
    if (character === '\\') {
      index += 1;
    } else if (character === '(' || character === '[') {
      depth += 1;
    } else if (character === ')' || character === ']') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      if (character === '{') return true;
      if (character === ';' || character === '}') return false;
    }
  }
  return false;
}

/**
 * Whether the page being read runs scripts, asked of the page itself: this
 * code runs in the tab when it reads a sheet, and in the panel when it
 * checks one that has travelled, where nothing is left to answer.
 */
function sourceRunsScripts(): boolean {
  try {
    return globalThis.matchMedia?.('(scripting: none)').matches !== true;
  } catch {
    return true;
  }
}

/**
 * Whether a text may name the feature at all; most do not. Its letters, or
 * a backslash where a rule's name or query stands, which may spell them.
 * (No `@` between the two: from each `@` the text is then looked through
 * once, not once more for every `@` before it.)
 */
const NAMES_SCRIPTING = /scripting|@[^{};@]*\\/i;
/** The same for an attribute's value, which is a query from its start. */
const QUERY_NAMES_SCRIPTING = /scripting|\\/i;
/** A test that every viewport passes, and one that none does. */
const MEDIA_FEATURE_ALWAYS = '(width >= 0px)';
const MEDIA_FEATURE_NEVER = '(width < 0px)';
/** Two names in brackets: no feature at all, which makes its query one that never applies. */
const MEDIA_FEATURE_NONE = '(scrip ting)';

interface CssEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface CssScriptingReading {
  readonly css: string;
  /**
   * The text has been through `stripCssCommentsOutsideStrings`: a feature
   * found in it now was none in the page's text, and is written as none.
   */
  readonly joined: boolean;
  runsScripts: boolean | undefined;
}

/** A pair of plain brackets in a media query. */
interface CssMediaBlock {
  readonly end: number;
  /**
   * The answer, if it is the feature; the answers inside it, if it holds
   * conditions only. They count if every pair around it holds conditions only.
   */
  readonly edits: readonly CssEdit[];
}

/**
 * Answers the `scripting` features of one media query list as the tab
 * answers them. The mirror's frame runs no scripts, so in it
 * `(scripting: none)` matches and `(scripting: enabled)` does not, whatever
 * the tab does: a page that hides what needs scripts from browsers without
 * them had it hidden in the mirror (a documentation site hid every live
 * example that way). Each such feature is replaced by a width test that
 * always passes or never does, so `not`, `and`, `or` and the commas around
 * it go on meaning what they meant.
 *
 * The feature is answered where a browser's parser sees it and nowhere
 * else, so the text is read token by token as CSS reads it: a pair of plain
 * brackets holding the name alone, or the name, a colon and one of the
 * feature's three values, at the top of the list or inside brackets that
 * group conditions. Only CSS white space parts tokens (a no-break space is
 * a letter of a name), a comment parts two names, an escape spells a
 * letter, a line break ends a string that was not closed, and the brackets
 * of `layer(…)`, `supports(…)`, `calc(…)` or `not(…)` are a function's, not
 * a condition's.
 */
export function answerScriptingMediaFeatures(query: string): string {
  if (!QUERY_NAMES_SCRIPTING.test(query)) return query;
  const edits: CssEdit[] = [];
  readCssMediaQueryList(
    { css: query, joined: false, runsScripts: undefined },
    0,
    false,
    edits,
  );
  return applyCssEdits(query, edits);
}

/**
 * The same for a whole sheet: the media queries of its `@media` rules,
 * nested ones too, and of its `@import` rules. A rule is one where a rule
 * can begin: at the start, or after `{`, `}` or `;`. Nothing else in the
 * sheet is read as a query: not a selector, a string, or the value of a
 * custom property, which may hold any text at all.
 */
function answerCssScriptingQueries(css: string, joined: boolean): string {
  const reading: CssScriptingReading = { css, joined, runsScripts: undefined };
  const edits: CssEdit[] = [];
  let index = 0;
  let ruleStart = true;
  for (;;) {
    index = skipCssTrivia(css, index);
    const character = css[index];
    if (character === undefined) break;
    if (character === '{' || character === '}' || character === ';') {
      ruleStart = true;
      index += 1;
      continue;
    }
    if (ruleStart) {
      ruleStart = false;
      if (character === '@') {
        const keyword = readCssName(css, index + 1);
        index = keyword.name === 'media'
          ? readCssMediaQueryList(reading, keyword.end, true, edits)
          : keyword.name === 'import'
            ? readCssImportConditions(reading, keyword.end, edits)
            : keyword.end;
        continue;
      }
      if (character === '-' || character === '\\') {
        const word = readCssName(css, index);
        const colon = skipCssTrivia(css, word.end);
        if (word.name.startsWith('--') && css[colon] === ':') {
          index = skipCssDeclarationValue(css, colon + 1);
          continue;
        }
      }
    }
    if (character === '"' || character === "'") {
      index = skipCssString(css, index);
    } else if (character === '(' || character === '[') {
      index = skipCssBlock(css, index);
    } else if (character === '\\') {
      index += 2;
    } else {
      // Nothing else can begin or end a rule, a string or a block: on to
      // the next character that can (a sheet is mostly this).
      CSS_PLAIN_RUN.lastIndex = index + 1;
      CSS_PLAIN_RUN.test(css);
      index = Math.max(CSS_PLAIN_RUN.lastIndex, index + 1);
    }
  }
  return applyCssEdits(css, edits);
}

/** Characters that begin or end no rule, string, block, comment or escape. */
const CSS_PLAIN_RUN = /[^{};"'(\[\\/]*/y;

/**
 * The conditions of an import. Whether an import travels is for the
 * sanitizer's own passes to say, after the features are answered, by what
 * its conditions hold: they drop one whose conditions hold a backslash, or
 * are longer than 2,048 characters. So nothing they go by is changed here.
 * A feature spelled with a backslash is left as it is, and the import is
 * dropped as it was; and conditions longer than half that length, which an
 * answer could bring to one side of it or the other, are not read at all.
 */
function readCssImportConditions(
  reading: CssScriptingReading,
  from: number,
  edits: CssEdit[],
): number {
  const answers: CssEdit[] = [];
  const end = readCssMediaQueryList(reading, from, true, answers);
  // What is found after those passes (`joined`) changes nothing for them.
  if (reading.joined) {
    for (const item of answers) edits.push(item);
  } else if (end - from <= MAX_IMPORT_CONDITIONS_ANSWERED) {
    for (const answer of answers) {
      if (!reading.css.slice(answer.start, answer.end).includes('\\')) {
        edits.push(answer);
      }
    }
  }
  return end;
}

const MAX_IMPORT_CONDITIONS_ANSWERED = 1_024;

function applyCssEdits(css: string, edits: readonly CssEdit[]): string {
  if (edits.length === 0) return css;
  const parts: string[] = [];
  let copied = 0;
  // They come in the order they stand in, and none inside another.
  for (const edit of edits) {
    parts.push(css.slice(copied, edit.start), edit.text);
    copied = edit.end;
  }
  parts.push(css.slice(copied));
  return parts.join('');
}

/** CSS white space. Nothing else parts tokens: a no-break space is part of a name. */
function isCssWhiteSpace(character: string | undefined): boolean {
  return character === ' ' || character === '\t' || character === '\n' ||
    character === '\r' || character === '\f';
}

/** A character a CSS name may hold: a letter, a digit, `_`, `-`, or anything past ASCII. */
function isCssNameCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x2d ||
    code >= 0x80;
}

/** A backslash that spells a character: not one before a line break or at the end. */
function isCssEscape(css: string, index: number): boolean {
  const next = css[index + 1];
  return css[index] === '\\' && next !== undefined && next !== '\n' &&
    next !== '\r' && next !== '\f';
}

/**
 * Reads a name from `from`: its letters as written and as escapes spell
 * them, in lower case. `end` is `from` when no name stands there. CSS
 * matches its names by ASCII letters only; no letter outside ASCII lowers to
 * one of the names looked for here (a long s is not an `s`, a dotted capital
 * I not an `i`; only the kelvin sign lowers to a `k`, which none of them has).
 */
function readCssName(
  css: string,
  from: number,
): { readonly name: string; readonly end: number } {
  // What escapes spelled so far; the letters since stand in the text itself.
  let spelled = '';
  let plainFrom = from;
  let index = from;
  for (;;) {
    if (isCssNameCharacter(css[index])) {
      index += 1;
    } else if (isCssEscape(css, index)) {
      spelled += css.slice(plainFrom, index);
      const hex = /^[0-9a-f]{1,6}/iu.exec(css.slice(index + 1, index + 7));
      if (hex) {
        const code = Number.parseInt(hex[0], 16);
        // Past the last character there is none to spell.
        spelled += code > 0x10ffff ? '\ufffd' : String.fromCodePoint(code);
        index += 1 + hex[0].length;
        // One white space after the digits belongs to the escape.
        if (css[index] === '\r' && css[index + 1] === '\n') index += 2;
        else if (isCssWhiteSpace(css[index])) index += 1;
      } else {
        spelled += css[index + 1];
        index += 2;
      }
      plainFrom = index;
    } else {
      break;
    }
  }
  return {
    name: (spelled + css.slice(plainFrom, index)).toLowerCase(),
    end: index,
  };
}

/** From a quote to past its end: the closing quote, or a line break, which ends a string too. */
function skipCssString(css: string, from: number): number {
  const quote = css[from];
  let index = from + 1;
  while (index < css.length) {
    const character = css[index]!;
    if (character === quote) return index + 1;
    if (character === '\n' || character === '\r' || character === '\f') return index;
    if (character === '\\') {
      index += css[index + 1] === '\r' && css[index + 2] === '\n' ? 3 : 2;
    } else {
      index += 1;
    }
  }
  return css.length;
}

/** Passes over white space and comments. */
function skipCssTrivia(css: string, from: number): number {
  let index = from;
  for (;;) {
    if (isCssWhiteSpace(css[index])) {
      index += 1;
    } else if (css[index] === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      index = close < 0 ? css.length : close + 2;
    } else {
      return index;
    }
  }
}

/**
 * Where the address of a `url(` written without quotes ends, from the
 * bracket: it runs to its `)`, quotes and brackets and all. `undefined` for
 * any other function, and for an address in quotes.
 */
function skipCssUnquotedUrl(
  css: string,
  name: string,
  open: number,
): number | undefined {
  if (name !== 'url') return undefined;
  let index = open + 1;
  while (isCssWhiteSpace(css[index])) index += 1;
  if (css[index] === '"' || css[index] === "'") return undefined;
  while (index < css.length && css[index] !== ')') {
    index += css[index] === '\\' ? 2 : 1;
  }
  return Math.min(index + 1, css.length);
}

/**
 * From an opening bracket to past the one that closes it, whatever it
 * holds. The brackets still open are counted, not walked into: a text may
 * nest them as deep as it is long.
 */
function skipCssBlock(css: string, open: number): number {
  const closers: string[] = [];
  let index = open;
  for (;;) {
    index = skipCssTrivia(css, index);
    const character = css[index];
    if (character === undefined) return index;
    if (character === '(' || character === '[' || character === '{') {
      closers.push(character === '(' ? ')' : character === '[' ? ']' : '}');
      index += 1;
    } else if (character === closers[closers.length - 1]) {
      closers.pop();
      index += 1;
      if (closers.length === 0) return index;
    } else if (character === '"' || character === "'") {
      index = skipCssString(css, index);
    } else if (isCssNameCharacter(character) || character === '\\') {
      const word = readCssName(css, index);
      if (word.end === index) {
        index += 1;
      } else if (css[word.end] === '(') {
        // A function's bracket is counted with the rest.
        index = skipCssUnquotedUrl(css, word.name, word.end) ?? word.end;
      } else {
        index = word.end;
      }
    } else {
      index += 1;
    }
  }
}

/**
 * One token that is no white space or comment: a string, a block, a
 * function with its brackets, a name (`word`), or one character.
 */
function readCssAtom(
  css: string,
  index: number,
): { readonly end: number; readonly word?: string } {
  const character = css[index]!;
  if (character === '"' || character === "'") {
    return { end: skipCssString(css, index) };
  }
  if (character === '(' || character === '[' || character === '{') {
    return { end: skipCssBlock(css, index) };
  }
  if (isCssNameCharacter(character) || character === '\\') {
    const word = readCssName(css, index);
    if (word.end === index) return { end: index + 1 };
    if (css[word.end] !== '(') return { end: word.end, word: word.name };
    return {
      end: skipCssUnquotedUrl(css, word.name, word.end) ??
        skipCssBlock(css, word.end),
    };
  }
  return { end: index + 1 };
}

/** The value of a custom property: to its `;`, or to the end of the block it stands in. */
function skipCssDeclarationValue(css: string, from: number): number {
  let index = from;
  for (;;) {
    index = skipCssTrivia(css, index);
    const character = css[index];
    if (character === undefined || character === ';' || character === '}') {
      return index;
    }
    index = readCssAtom(css, index).end;
  }
}

/**
 * Reads a media query list from `from` and answers its `scripting`
 * features. In a sheet (`prelude`) the list ends at its rule's block, at its
 * `;`, or with the block the rule stands in; an attribute's value is the
 * list. Returns where it ended.
 */
function readCssMediaQueryList(
  reading: CssScriptingReading,
  from: number,
  prelude: boolean,
  edits: CssEdit[],
): number {
  const { css } = reading;
  let index = from;
  for (;;) {
    index = skipCssTrivia(css, index);
    const character = css[index];
    if (character === undefined) return index;
    if (
      prelude && (character === '{' || character === ';' || character === '}')
    ) return index;
    if (character === '(') {
      const block = readCssMediaBlock(reading, index, 1);
      for (const item of block.edits) edits.push(item);
      index = block.end;
    } else {
      index = readCssAtom(css, index).end;
    }
  }
}

const MEDIA_CONDITION_WORDS = new Set(['not', 'and', 'or']);
const SCRIPTING_VALUES = new Set(['none', 'enabled', 'initial-only']);
/**
 * Brackets around conditions are read this deep; what is nested deeper is
 * passed over like any other block. Queries nest two or three deep.
 */
const MAX_MEDIA_CONDITION_DEPTH = 32;

/** Reads a pair of plain brackets in a media query, from its `(`. */
function readCssMediaBlock(
  reading: CssScriptingReading,
  open: number,
  depth: number,
): CssMediaBlock {
  const { css } = reading;
  // What stands straight inside: names, colons, blocks; `undefined` for the rest.
  const tokens: Array<{ readonly word: string } | ':' | CssMediaBlock | undefined> = [];
  let index = open + 1;
  for (;;) {
    index = skipCssTrivia(css, index);
    const character = css[index];
    // The end of the text closes what is open, as it does for a browser.
    if (character === undefined) break;
    if (character === ')') {
      index += 1;
      break;
    }
    if (character === '(' && depth < MAX_MEDIA_CONDITION_DEPTH) {
      const block = readCssMediaBlock(reading, index, depth + 1);
      tokens.push(block);
      index = block.end;
    } else if (character === ':') {
      tokens.push(':');
      index += 1;
    } else {
      const atom = readCssAtom(css, index);
      tokens.push(atom.word === undefined ? undefined : { word: atom.word });
      index = atom.end;
    }
  }
  const word = (token: (typeof tokens)[number]): string | undefined =>
    token !== undefined && token !== ':' && 'word' in token ? token.word : undefined;
  const value = tokens.length === 1
    ? ''
    : tokens.length === 3 && tokens[1] === ':'
      ? word(tokens[2])
      : undefined;
  if (
    word(tokens[0]) === 'scripting' && value !== undefined &&
    (value === '' || SCRIPTING_VALUES.has(value))
  ) {
    let text = MEDIA_FEATURE_NONE;
    if (!reading.joined) {
      reading.runsScripts ??= sourceRunsScripts();
      // The bare feature asks whether scripts run at all; `initial-only` is
      // a page that ran them once and no longer does, which no tab is.
      const matches = value === 'initial-only'
        ? false
        : value === 'none' ? !reading.runsScripts : reading.runsScripts;
      text = matches ? MEDIA_FEATURE_ALWAYS : MEDIA_FEATURE_NEVER;
      // A comment right before it will be taken out: a space in its place
      // keeps the answer apart from the word before (`not/**/(scripting)`).
      if (css[open - 1] === '/' && css[open - 2] === '*') text = ` ${text}`;
    }
    return { end: index, edits: [{ start: open, end: index, text }] };
  }
  // Brackets around conditions: what they hold counts. Anything else (a
  // feature with its value, say) is left as it is, whatever it holds.
  const edits: CssEdit[] = [];
  for (const token of tokens) {
    if (token === undefined || token === ':') return { end: index, edits: [] };
    if (!('word' in token)) for (const item of token.edits) edits.push(item);
    else if (!MEDIA_CONDITION_WORDS.has(token.word)) return { end: index, edits: [] };
  }
  return { end: index, edits };
}

/**
 * Held values that came through `sanitizeCss` unchanged, by policy and kind
 * of element: short ones only, and no more than this many at a time.
 */
const CLEAN_HELD_STYLES = new Set<string>();
const MAX_CLEAN_HELD_STYLES = 256;
const MAX_CLEAN_HELD_STYLE_LENGTH = 512;

/**
 * Closes whatever string and brackets a declaration list leaves open, as the
 * end of the text does for a browser, so that what is put after it stands
 * outside them.
 */
function closeCssBlocks(css: string): string {
  const open: string[] = [];
  let quote: string | undefined;
  let text = css;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (character === '\\') {
      index += 1;
      // A backslash at the very end spells nothing, and would spell what follows.
      if (index >= css.length) text = css.slice(0, -1);
    } else if (quote !== undefined) {
      // A line break ends a string that was not closed.
      if (
        character === quote || character === '\n' || character === '\r' ||
        character === '\f'
      ) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      open.push(')');
    } else if (character === '[') {
      open.push(']');
    } else if (character === '{') {
      open.push('}');
    } else if (character === open.at(-1)) {
      open.pop();
    }
  }
  return text + (quote ?? '') + open.reverse().join('');
}

/**
 * Native-select styling is layout presentation, not a resource channel. Keep
 * inert declarations such as width/position/typography, but remove an entire
 * declaration when it can carry or disclose a URL.
 */
function sanitizeNativeSelectStyle(
  css: string,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector | undefined,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): string | undefined {
  const declarations = splitCssTopLevel(css, ';');
  if (!declarations) return undefined;
  const retained: string[] = [];
  for (const declaration of declarations) {
    const normalized = declaration.trim();
    if (!normalized) continue;
    const colon = normalized.indexOf(':');
    if (colon <= 0) return undefined;
    const property = decodeCssEscapes(normalized.slice(0, colon))
      .trim()
      .toLowerCase();
    const allowedProperty = NATIVE_SELECT_SAFE_STYLE_PROPERTIES.has(property) ||
      /^(?:border-(?:bottom|left|right|top)-(?:color|style|width)|border-(?:bottom-left|bottom-right|top-left|top-right)-radius|margin-(?:block|block-end|block-start|bottom|inline|inline-end|inline-start|left|right|top)|padding-(?:block|block-end|block-start|bottom|inline|inline-end|inline-start|left|right|top))$/u
        .test(property);
    if (!allowedProperty) {
      if (representability) {
        incrementRepresentability(
          representability,
          'strippedActiveAttributeCount',
        );
      }
      continue;
    }
    const executable = decodeCssEscapes(normalized);
    if (
      /(?:url|(?:-webkit-)?image-set)\s*\(|(?:https?|blob|data|file)\s*:/iu
        .test(executable)
    ) {
      if (representability) {
        incrementRepresentability(
          representability,
          'strippedUnsafeResourceCount',
        );
        incrementRepresentability(
          representability,
          'strictResourcePolicyBlockCount',
        );
      }
      continue;
    }
    retained.push(normalized);
  }
  const candidate = retained.join(';');
  if (!candidate) return '';
  return sanitizeCss(
    candidate,
    baseUrl,
    true,
    representability,
    fidelityPolicy,
  );
}

/**
 * `outOfSight`: the dropdown is hidden only by something above it (see
 * `isSourceSelectHeldOutOfSight`). Its own style is read as ever, and its
 * `visibility` is sent as hidden whatever it computes to: under a panel
 * collapsed with `display` it computes to visible, and the mirror's box for
 * a dropdown takes no `visibility` from what is around it.
 */
export function readSourceSelectPresentationStyle(
  element: Element,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  outOfSight = false,
): string | undefined {
  const view = sourceDocumentProperty(element.ownerDocument, 'defaultView');
  if (
    sourceLocalName(element).toLowerCase() !== 'select' ||
    !view ||
    typeof view.getComputedStyle !== 'function'
  ) return undefined;
  try {
    const computed = view.getComputedStyle(element);
    const declarations: string[] = [];
    for (const property of NATIVE_SELECT_COMPUTED_STYLE_PROPERTIES) {
      const value = outOfSight && property === 'visibility'
        ? 'hidden'
        : computed.getPropertyValue(property).trim();
      if (!value || value.length > 500) continue;
      declarations.push(`${property}:${value}`);
    }
    const style = sanitizeNativeSelectStyle(
      declarations.join(';'),
      'about:blank',
      undefined,
      fidelityPolicy,
    );
    return style && style.length <= 32_768 ? style : undefined;
  } catch {
    return undefined;
  }
}

function readTransportedSelectPresentationStyle(
  input: unknown,
  tagName: string,
  budget: HtmlMirrorReadBudget,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): string | undefined {
  if (input === undefined) return undefined;
  if (
    tagName !== 'select' ||
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > 32_768 ||
    sanitizeNativeSelectStyle(
      input,
      'about:blank',
      undefined,
      fidelityPolicy,
    ) !== input
  ) return undefined;
  budget.bytes += input.length * 2 + 24;
  return budget.bytes <= MAX_HTML_MIRROR_BYTES ? input : undefined;
}

// The CSS passes below copy unchanged runs as slices rather than one
// character at a time: a stylesheet may be several megabytes, and building
// it character by character spent most of the time in garbage collection.

/**
 * `sheet`: the text is a sheet's, not a declaration list's. For a browser a
 * string that was not closed ends at a line break, and what follows is the
 * sheet again. The passes after this one end a string only at its quote, so
 * they took what follows, up to the next quote wherever it stood, for the
 * string's text and looked at none of it: an `@import` there stayed in
 * under the conservative reading, and the mirror asked the network for it.
 * A sheet in which a line break cuts a string is refused, as one whose
 * string never ends already is.
 */
/**
 * A sheet read past a string that a line break cuts, as Chrome's CSS parser
 * reads it (D202). The tokenizer ends such a string at the line break (a
 * bad string) and reads on; the parser then drops what holds it:
 *
 * - a declaration, from its name to its `;` at its own nesting (blocks it
 *   opens after the bad string hold their `;`) or the end of its block;
 * - a rule whose prelude holds it: a style rule or a keyframe with its
 *   block (at the top of a sheet a `;` does not end a prelude; nested, it
 *   ends the rule), an at-rule up to its `;` or with its block;
 * - in `@media`, only the query that holds it, which reads `not all`.
 *
 * What it drops goes; nothing else changes. With no cut string the text is
 * returned as it is. Undefined past the nesting this reads.
 */
const MAX_CSS_BAD_STRING_NESTING = 256;
/** At-rules whose block is a list of rules. */
const CSS_RULE_LIST_AT_RULES = new Set([
  'container', 'document', 'keyframes', '-webkit-keyframes', 'layer', 'media',
  'scope', 'starting-style', 'supports',
]);

interface CssScanToken {
  readonly kind: 'open' | 'close' | 'semicolon' | 'comma' | 'colon' | 'at' |
    'bad' | 'other' | 'space';
  readonly start: number;
  readonly end: number;
  /** For `open` and `close`: the character that closes the block. */
  readonly closer?: string;
}

function isCssScanNameCode(code: number): boolean {
  return code >= 0x80 || code === 0x2d || code === 0x5f ||
    (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a);
}

function isCssScanSpaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0c ||
    code === 0x0d;
}

/** Whether a line break cuts a string of `css` (comments are skipped). */
function cssHasCutString(css: string): boolean {
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (character === '\\') {
      index += 1;
    } else if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close < 0) return false;
      index = close + 1;
    } else if (character === '"' || character === "'") {
      for (index += 1; index < css.length; index += 1) {
        const inside = css[index]!;
        if (inside === character) break;
        if (inside === '\\') {
          index += 1;
        } else if (inside === '\n' || inside === '\r' || inside === '\f') {
          return true;
        }
      }
    }
  }
  return false;
}

function tokenizeCssForBadStrings(css: string): {
  readonly tokens: readonly CssScanToken[];
  readonly bad: boolean;
} {
  const tokens: CssScanToken[] = [];
  let bad = false;
  const isBreak = (character: string | undefined) =>
    character === '\n' || character === '\r' || character === '\f';
  for (let index = 0; index < css.length;) {
    const character = css[index]!;
    const start = index;
    if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      index = close < 0 ? css.length : close + 2;
      tokens.push({ kind: 'space', start, end: index });
      continue;
    }
    if (character === '"' || character === "'") {
      index += 1;
      let cut = false;
      while (index < css.length) {
        const inside = css[index]!;
        if (inside === character) {
          index += 1;
          break;
        }
        if (inside === '\\') {
          index += css[index + 1] === '\r' && css[index + 2] === '\n' ? 3 : 2;
          continue;
        }
        if (isBreak(inside)) {
          cut = true;
          break;
        }
        index += 1;
      }
      if (cut) bad = true;
      tokens.push({ kind: cut ? 'bad' : 'other', start, end: Math.min(index, css.length) });
      continue;
    }
    if (character === '\\') {
      index += isBreak(css[index + 1]) || index + 1 >= css.length ? 1 : 2;
      tokens.push({ kind: 'other', start, end: index });
      continue;
    }
    // An unquoted `url(`: one token to its `)`, quotes and all.
    if (
      (character === 'u' || character === 'U') &&
      css.slice(index, index + 4).toLowerCase() === 'url(' &&
      (index === 0 || !isCssScanNameCode(css.charCodeAt(index - 1)))
    ) {
      let scan = index + 4;
      while (scan < css.length && isCssScanSpaceCode(css.charCodeAt(scan))) scan += 1;
      if (css[scan] !== '"' && css[scan] !== "'") {
        while (scan < css.length && css[scan] !== ')') {
          scan += css[scan] === '\\' ? 2 : 1;
        }
        index = Math.min(scan + 1, css.length);
        tokens.push({ kind: 'other', start, end: index });
        continue;
      }
    }
    // An at-keyword or a name: one token.
    const nameStart = character === '@' ? index + 1 : index;
    let nameEnd = nameStart;
    while (nameEnd < css.length && isCssScanNameCode(css.charCodeAt(nameEnd))) {
      nameEnd += 1;
    }
    if (nameEnd > nameStart) {
      index = nameEnd;
      tokens.push({ kind: character === '@' ? 'at' : 'other', start, end: index });
      continue;
    }
    index += 1;
    if (character === '{' || character === '(' || character === '[') {
      tokens.push({
        kind: 'open', start, end: index,
        closer: character === '{' ? '}' : character === '(' ? ')' : ']',
      });
    } else if (character === '}' || character === ')' || character === ']') {
      tokens.push({ kind: 'close', start, end: index, closer: character });
    } else if (character === ';') {
      tokens.push({ kind: 'semicolon', start, end: index });
    } else if (character === ',') {
      tokens.push({ kind: 'comma', start, end: index });
    } else if (character === ':') {
      tokens.push({ kind: 'colon', start, end: index });
    } else if (character === '@') {
      tokens.push({ kind: 'at', start, end: index });
    } else if (isCssScanSpaceCode(character.charCodeAt(0))) {
      tokens.push({ kind: 'space', start, end: index });
    } else {
      tokens.push({ kind: 'other', start, end: index });
    }
  }
  return { tokens, bad };
}

export function readCssSheetBadStrings(
  css: string,
  /**
   * A `style` attribute's declarations (D216): each declaration that holds
   * a cut string goes up to its own `;`, a custom property's too, whose
   * blocks hold what follows the line break (`--x: ("a` + line break +
   * `;b)` is one invalid declaration), as Chrome reads it.
   */
  declarationList = false,
): string | undefined {
  if (!cssHasCutString(css)) return css;
  const { tokens, bad } = tokenizeCssForBadStrings(css);
  if (!bad) return css;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  /** The token after the block `open` opens, matched by its own closer. */
  const blockEnd = (open: number): number => {
    const closers: string[] = [tokens[open]!.closer!];
    let index = open + 1;
    for (; index < tokens.length && closers.length > 0; index += 1) {
      const token = tokens[index]!;
      if (token.kind === 'open') closers.push(token.closer!);
      else if (token.kind === 'close' && token.closer === closers[closers.length - 1]) {
        closers.pop();
      }
    }
    return index;
  };
  const holdsBad = (from: number, to: number): boolean => {
    for (let index = from; index < to; index += 1) {
      if (tokens[index]!.kind === 'bad') return true;
    }
    return false;
  };
  const textOf = (from: number, to: number): string =>
    from < to ? css.slice(tokens[from]!.start, tokens[to - 1]!.end) : '';
  const drop = (from: number, to: number): void => {
    if (from < to) {
      edits.push({ start: tokens[from]!.start, end: tokens[to - 1]!.end, text: '' });
    }
  };
  /** The queries of an `@media` prelude that hold a bad string read `not all`. */
  const answerMedia = (from: number, to: number): void => {
    let segment = from;
    const finish = (end: number) => {
      if (!holdsBad(segment, end)) return;
      let first = segment;
      while (first < end && tokens[first]!.kind === 'space') first += 1;
      edits.push({
        start: first < end ? tokens[first]!.start : tokens[segment]!.start,
        end: tokens[end - 1]!.end,
        text: 'not all',
      });
    };
    for (let index = from; index < to; index += 1) {
      const token = tokens[index]!;
      if (token.kind === 'open') {
        index = blockEnd(index) - 1;
      } else if (token.kind === 'comma') {
        finish(index);
        segment = index + 1;
      }
    }
    finish(to);
  };
  /**
   * Reads a list of rules and declarations from `index` to the closer of
   * its block (or the end); returns the index of that closer. `top`: a list
   * of rules; `outermost`: the sheet's own, where a stray `}` closes
   * nothing. A group rule's list ends at its `}` (D226).
   */
  const readList = (
    index: number,
    top: boolean,
    depth: number,
    outermost = false,
  ): number => {
    if (depth > MAX_CSS_BAD_STRING_NESTING) throw new Error('nesting');
    while (index < tokens.length) {
      const token = tokens[index]!;
      if (token.kind === 'space' || (top && token.kind === 'semicolon')) {
        index += 1;
        continue;
      }
      if (token.kind === 'close' && token.closer === '}') {
        if (!outermost) return index;
        index += 1;
        continue;
      }
      const start = index;
      const atRule = token.kind === 'at';
      // A custom property holds blocks of any kind in its value.
      const custom = !top && !atRule &&
        /^--/u.test(css.slice(token.start, token.start + 2));
      let preludeEnd = -1;
      let end = index;
      for (; end < tokens.length; end += 1) {
        const current = tokens[end]!;
        if (current.kind === 'open') {
          if (current.closer === '}' && !custom) {
            preludeEnd = end;
            break;
          }
          end = blockEnd(end) - 1;
          continue;
        }
        if (current.kind === 'close' && current.closer === '}') break;
        if (current.kind === 'semicolon' && (!top || atRule)) {
          end += 1;
          break;
        }
      }
      if (preludeEnd < 0) {
        // A declaration, a statement at-rule, or a rule a `;` ended.
        if (holdsBad(start, end)) {
          if (atRule && /^@media$/iu.test(textOf(start, start + 1))) {
            answerMedia(start + 1, end - (tokens[end - 1]?.kind === 'semicolon' ? 1 : 0));
          } else {
            drop(start, end);
          }
        }
        index = end;
        continue;
      }
      const close = blockEnd(preludeEnd);
      // A group rule of the sheet's own list holds a list of rules, read as
      // the sheet's; in a style rule, or as a style rule's block, it holds
      // declarations and rules.
      const listed = top && atRule &&
        CSS_RULE_LIST_AT_RULES.has(textOf(start, start + 1).slice(1).toLowerCase());
      if (holdsBad(start, preludeEnd)) {
        if (atRule && /^@media$/iu.test(textOf(start, start + 1))) {
          answerMedia(start + 1, preludeEnd);
          readList(preludeEnd + 1, listed, depth + 1);
        } else {
          drop(start, close);
        }
      } else {
        readList(preludeEnd + 1, listed, depth + 1);
      }
      index = close;
    }
    return index;
  };
  try {
    if (!declarationList) readList(0, true, 0, true);
    else {
      // A `}` of the attribute's own closes nothing: what follows is read on.
      for (let index = 0; index < tokens.length; index += 1) {
        index = readList(index, false, 0);
      }
    }
  } catch {
    return undefined;
  }
  edits.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    parts.push(css.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  parts.push(css.slice(cursor));
  return parts.join('');
}

function stripCssCommentsOutsideStrings(
  css: string,
  sheet = false,
): string | undefined {
  const parts: string[] = [];
  let segmentStart = 0;
  let quote: '"' | "'" | undefined;
  let stringStart = 0;
  // In a `style` attribute, the blocks still open: the end of the text
  // closes them, as the browser reads it (D187), so a cut-off `url("…`
  // or `calc(…` is written closed.
  // In a sheet the end of its own text closes them, but a string that
  // ends there is closed with the functions around it (`url("a.png`), for
  // the passes that read addresses (D216).
  const open: string[] = [];
  const closed = (): string => sheet ? '' : open.reverse().join('');
  const functionsClosed = (): string =>
    open.filter((closer) => closer !== '}').reverse().join('');
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === '\\') {
        // A backslash and the line break after it are part of the string.
        index += css[index + 1] === '\r' && css[index + 2] === '\n' ? 2 : 1;
      } else if (character === quote) {
        quote = undefined;
      } else if (
        character === '\n' || character === '\r' || character === '\f'
      ) {
        if (sheet) return undefined;
        // In a `style` attribute a line break ends the string, as the
        // browser reads it (a bad string), and what follows is read as the
        // declarations again (D181): an address there is made absolute and
        // `expression(` is looked for. The declaration the string stood in
        // is invalid to the browser; a `!` with no `important` after it
        // keeps it invalid in the mirror, and the string's text stays
        // behind.
        parts.push(css.slice(segmentStart, stringStart), '!');
        segmentStart = index;
        quote = undefined;
      }
      continue;
    }
    // An escaped character outside a string belongs to a name, as in the
    // Tailwind selector `.content-\[\'x\'\]`; it opens no string (D83).
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      stringStart = index;
      continue;
    }
    {
      if (character === '(') open.push(')');
      else if (character === '[') open.push(']');
      else if (character === '{') open.push('}');
      else if (character === open[open.length - 1]) open.pop();
    }
    // An unquoted url body takes `/` and `*` as URL code points, not as a
    // comment: stripping one there would request a URL the page never
    // wrote (R4). Copy such a body verbatim. A quoted body keeps the string
    // path above, which already holds its comments as text.
    if (
      (character === 'u' || character === 'U') &&
      (css[index + 1] === 'r' || css[index + 1] === 'R') &&
      (css[index + 2] === 'l' || css[index + 2] === 'L') &&
      css[index + 3] === '('
    ) {
      const bodyStart = index + 4;
      let scan = bodyStart;
      while (scan < css.length && isAsciiWhitespace(css[scan]!)) scan += 1;
      if (css[scan] !== '"' && css[scan] !== "'") {
        const close = findCssFunctionClose(css, index + 3);
        if (close !== undefined) {
          let quoted = false;
          for (let position = bodyStart; position < close; position += 1) {
            const bodyCharacter = css[position]!;
            if (bodyCharacter === '\\') {
              position += 1;
              continue;
            }
            if (bodyCharacter === '"' || bodyCharacter === "'") {
              quoted = true;
              break;
            }
          }
          if (!quoted) {
            parts.push(css.slice(segmentStart, close + 1));
            index = close;
            segmentStart = close + 1;
            continue;
          }
        } else if (
          !sheet && !/["'()]/u.test(css.slice(bodyStart))
        ) {
          // A `style` attribute cut off inside an unquoted `url(`: the
          // browser closes it at the end of the text and applies the
          // declarations before it (D181).
          parts.push(css.slice(segmentStart), ')', closed());
          return parts.join('');
        }
      }
    }
    if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close < 0) {
        // A text that ends inside a comment: the comment runs to the end of
        // the text, as the browser reads it (D181; a sheet too since D216).
        parts.push(css.slice(segmentStart, index), closed());
        return parts.join('');
      }
      parts.push(css.slice(segmentStart, index));
      // A comment parts tokens: removing it must not join the material
      // around it into a function, at-keyword, or name the page never
      // wrote (a split `url(`, a split `@import`, a split class name) (R4).
      if (commentJoinsTokens(css, index, close)) {
        parts.push(commentSeparator(css, index));
      }
      index = close + 1;
      segmentStart = close + 2;
    }
  }
  if (quote) {
    // The end of the text ends a string, as the browser reads it (D181; a
    // sheet too since D216, whose blocks the end of its own text closes). A
    // backslash just before the end escapes nothing and is dropped.
    let rest = css.slice(segmentStart);
    if (/(?:^|[^\\])(?:\\\\)*\\$/u.test(rest)) rest = rest.slice(0, -1);
    parts.push(rest, quote, sheet ? functionsClosed() : closed());
    return parts.join('');
  }
  parts.push(css.slice(segmentStart), closed());
  return parts.join('');
}

/** Whether a character can be part of a CSS identifier (an ident code point). */
function isCssIdentChar(character: string): boolean {
  return /[a-zA-Z0-9_\-\u0080-\uFFFF]/u.test(character);
}

/**
 * Whether removing a comment would join the material around it into one
 * token the browser never saw. A comment parts tokens, so the text must
 * keep them parted: identifier halves (a split `url` name, `.a` and `b`,
 * `1` and `px`), a name and its parenthesis (a split `url(`), an at-sign
 * or hash and a name (a split `@import`, a split `#id`), a sign or digit
 * and a number. A hex escape reaches over its terminating white space,
 * and an escape opens on either side of the comment.
 */
function commentJoinsTokens(
  css: string,
  commentStart: number,
  commentEnd: number,
): boolean {
  const before = css[commentStart - 1];
  const after = css[commentEnd + 2];
  if (before === undefined || after === undefined) return false;
  const afterIdent = isCssIdentChar(after) || after === '\\';
  const beforeWindow = css.slice(Math.max(0, commentStart - 8), commentStart);
  const beforeIdent = isCssIdentChar(before) || before === '\\' ||
    /\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?$/u.test(beforeWindow);
  if (beforeIdent && (afterIdent || after === '(')) return true;
  if ((before === '@' || before === '#') && afterIdent) return true;
  // `/` and `*` would open a comment the page never wrote: `*//**/*/`.
  if (before === '/' && after === '*') return true;
  if (/[0-9]/u.test(before) && (after === '.' || after === '%')) return true;
  if (before === '+' && (/[0-9]/u.test(after) || after === '.')) return true;
  return false;
}

/**
 * The space a parting comment leaves. An unterminated hex escape takes the
 * first space as its own terminator, so a second one is what actually
 * parts the names: without it the halves still join once decoded.
 */
function commentSeparator(css: string, commentStart: number): string {
  const beforeWindow = css.slice(Math.max(0, commentStart - 8), commentStart);
  return /\\[0-9a-fA-F]{1,6}$/u.test(beforeWindow) ? '  ' : ' ';
}

/** Replaces each string, quotes included, with spaces of the same length. */
function cssExecutableProjection(css: string): string {
  const parts: string[] = [];
  let segmentStart = 0;
  for (let index = 0; index < css.length; index += 1) {
    const quote = css[index]!;
    if (quote === '\\') {
      index += 1;
      continue;
    }
    if (quote !== '"' && quote !== "'") continue;
    parts.push(css.slice(segmentStart, index));
    const stringStart = index;
    index += 1;
    while (index < css.length) {
      const character = css[index]!;
      if (character === quote) break;
      index += character === '\\' ? 2 : 1;
    }
    const stringEnd = Math.min(index + 1, css.length);
    parts.push(' '.repeat(stringEnd - stringStart));
    segmentStart = stringEnd;
    index = stringEnd - 1;
  }
  parts.push(css.slice(segmentStart));
  return parts.join('');
}

function rewriteCssUrlsOutsideStrings(
  css: string,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector | undefined,
): string | undefined {
  let output = '';
  let cursor = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === '\\') {
        index += css[index + 1] === '\r' && css[index + 2] === '\n' ? 2 : 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character.toLowerCase() !== 'u') continue;
    const previous = css[index - 1];
    if (previous && /[a-z0-9_-]/iu.test(previous)) continue;
    // A CSS `url(` token has no space between the name and the parenthesis;
    // `url (x)` and `url\u00A0(x)` are not functions the browser fetches for
    // (R4).
    const match = /^url\(/iu.exec(css.slice(index));
    if (!match) continue;
    const openParenthesis = index + match[0].lastIndexOf('(');
    const closeParenthesis = findCssFunctionClose(css, openParenthesis);
    if (closeParenthesis === undefined) return undefined;
    const normalized = normalizeCssUrlFunction(
      css.slice(openParenthesis + 1, closeParenthesis),
      baseUrl,
      representability,
    );
    if (normalized === undefined) return undefined;
    output += css.slice(cursor, index) + normalized;
    cursor = closeParenthesis + 1;
    index = closeParenthesis;
  }
  return output + css.slice(cursor);
}

const DATA_FONT_URL_PATTERN =
  /^data:(?:font\/(?:woff2?|ttf|otf|sfnt|collection)|application\/(?:font-woff2?|x-font-woff|x-font-ttf|x-font-otf|x-font-opentype|font-sfnt|vnd\.ms-fontobject|octet-stream))(?:;[a-z0-9=._-]+)*;base64,[A-Za-z0-9+/=]*$/iu;

/** A base64 font data URL within the string cap; nothing in it can execute. */
function isPassiveDataFontUrl(value: string): boolean {
  return value.length <= MAX_HTML_MIRROR_STRING &&
    DATA_FONT_URL_PATTERN.test(value);
}

/** CSS white space is ASCII only; a no-break space is a character of a value. */
function trimCssWhitespace(value: string): string {
  return value.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/gu, '');
}

/**
 * Whether an unquoted `url()` body holds CSS white space that parts the token.
 * The space that ends a hexadecimal escape is part of the escape, not of the
 * value (`url(\23 brand)` is `url(#brand)`), and so is an escaped one.
 */
function hasUnescapedCssWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '\\') {
      let end = index + 1;
      if (end < value.length && /[0-9a-f]/iu.test(value[end]!)) {
        let digits = 0;
        while (
          end < value.length && digits < 6 &&
          /[0-9a-f]/iu.test(value[end]!)
        ) {
          end += 1;
          digits += 1;
        }
        // One white space after a hexadecimal escape terminates it.
        if (end < value.length && isAsciiWhitespace(value[end]!)) end += 1;
      } else {
        end += 1;
      }
      index = end - 1;
      continue;
    }
    if (isAsciiWhitespace(character)) return true;
  }
  return false;
}

function normalizeCssUrlFunction(
  body: string,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector | undefined,
): string | undefined {
  // CSS parts a url token only by its own white space; a no-break space is a
  // character of the value, as it is to the browser's tokenizer (R4).
  const content = body.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/gu, '');
  let raw = content;
  const quote = content[0];
  if (quote === '"' || quote === "'") {
    const end = findCssStringEnd(content, quote);
    if (
      end === undefined ||
      content.slice(end + 1).replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/gu, '') !== ''
    ) {
      return undefined;
    }
    raw = content.slice(1, end);
  } else if (
    /["'()]/u.test(content) || hasUnescapedCssWhitespace(content)
  ) {
    // An unquoted url token ends at white space: `url(foo bar)` is a
    // `bad-url` token in the page, and must not become a live request here.
    return undefined;
  }
  const decodedUrl = decodeCssEscapes(trimCssWhitespace(raw));
  // A fragment-only CSS URL resolves inside the reconstructed document.
  if (LOCAL_SVG_FRAGMENT_PATTERN.test(decodedUrl)) {
    return `url("${decodedUrl}")`;
  }
  // An embedded web font (often a large CJK font) is inert data the page
  // already loaded; without it the replica falls back to another font (D72).
  if (isPassiveDataFontUrl(decodedUrl)) {
    return `url("${decodedUrl}")`;
  }
  if (decodedUrl.startsWith('#')) {
    if (representability) {
      incrementRepresentability(
        representability,
        'strippedUnsafeResourceCount',
      );
    }
    return 'none';
  }
  const url = passiveUrl(decodedUrl, baseUrl, true);
  if (url) {
    if (/^https?:\/\//u.test(url) && representability) {
      incrementRepresentability(
        representability,
        'replicaRequestCapableResourceCount',
      );
    }
    if (/^data:image\/svg\+xml/iu.test(url) && representability) {
      incrementRepresentability(
        representability,
        'preservedSvgResourceCount',
      );
    }
    return `url("${url.replaceAll('"', '%22')}")`;
  }
  if (representability) {
    incrementRepresentability(
      representability,
      'strippedUnsafeResourceCount',
    );
    recordBlockedResourceScheme(decodedUrl, baseUrl, representability);
  }
  return 'none';
}

function rewriteCssImageSetStrings(
  css: string,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector | undefined,
  depth = 0,
): string | undefined {
  if (depth > 8) return undefined;
  let output = '';
  let cursor = 0;
  while (cursor < css.length) {
    const found = findNextCssImageSet(css, cursor);
    if (!found) {
      output += css.slice(cursor);
      break;
    }
    const close = findCssFunctionClose(css, found.openParenthesis);
    if (close === undefined) return undefined;
    output += css.slice(cursor, found.openParenthesis + 1);
    const body = css.slice(found.openParenthesis + 1, close);
    if (/(?:^|[^a-z0-9_-])(?:var|attr)\s*\(/iu.test(
      decodeCssEscapes(body),
    )) {
      if (representability) {
        incrementRepresentability(
          representability,
          'strippedUnsafeResourceCount',
        );
      }
      return undefined;
    }
    const options = splitCssTopLevel(body, ',');
    if (!options) return undefined;
    const rewritten: string[] = [];
    for (const option of options) {
      const normalized = rewriteCssImageSetOption(
        option,
        baseUrl,
        representability,
        depth,
      );
      if (normalized === undefined) return undefined;
      rewritten.push(normalized);
    }
    output += `${rewritten.join(',')})`;
    cursor = close + 1;
  }
  return output;
}

function rewriteCssImageSetOption(
  option: string,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector | undefined,
  depth: number,
): string | undefined {
  const leadingLength = option.length - option.trimStart().length;
  const leading = option.slice(0, leadingLength);
  const content = option.slice(leadingLength);
  const quote = content[0];
  if (quote !== '"' && quote !== "'") {
    const nested = rewriteCssImageSetStrings(
      content,
      baseUrl,
      representability,
      depth + 1,
    );
    return nested === undefined ? undefined : `${leading}${nested}`;
  }
  const end = findCssStringEnd(content, quote);
  if (end === undefined) return undefined;
  const raw = decodeCssEscapes(content.slice(1, end));
  const url = passiveUrl(raw, baseUrl, true);
  if (!url) {
    if (representability) {
      incrementRepresentability(
        representability,
        'strippedUnsafeResourceCount',
      );
      recordBlockedResourceScheme(raw, baseUrl, representability);
    }
    return undefined;
  }
  return `${leading}url("${url.replaceAll('"', '%22')}")${content.slice(end + 1)}`;
}

/** Sticky: matches only at `lastIndex`, without slicing the stylesheet. */
const CSS_IMAGE_SET_AT_INDEX = /(?:-webkit-)?image-set\s*\(/iuy;

function findNextCssImageSet(
  css: string,
  start: number,
): { readonly openParenthesis: number } | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === '\\') {
        index += css[index + 1] === '\r' && css[index + 2] === '\n' ? 2 : 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    // Only these can start a match (no other character case-folds to i).
    if (character !== '-' && character !== 'i' && character !== 'I') continue;
    CSS_IMAGE_SET_AT_INDEX.lastIndex = index;
    const match = CSS_IMAGE_SET_AT_INDEX.exec(css);
    if (!match) continue;
    const previous = css[index - 1];
    if (previous && /[a-z0-9_-]/iu.test(previous)) continue;
    return { openParenthesis: index + match[0].lastIndexOf('(') };
  }
  return undefined;
}

function findCssFunctionClose(
  css: string,
  openParenthesis: number,
): number | undefined {
  let depth = 1;
  let quote: '"' | "'" | undefined;
  for (let index = openParenthesis + 1; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === '\\') {
        index += css[index + 1] === '\r' && css[index + 2] === '\n' ? 2 : 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '\\') index += 1;
    else if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index;
  }
  return undefined;
}

function splitCssTopLevel(value: string, separator: string): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === '\\') {
        index += value[index + 1] === '\r' && value[index + 2] === '\n' ? 2 : 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '\\') index += 1;
    else if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') {
      if (depth === 0) return undefined;
      depth -= 1;
    } else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || depth !== 0) return undefined;
  parts.push(value.slice(start));
  return parts;
}

function findCssStringEnd(value: string, quote: string): number | undefined {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += value[index + 1] === '\r' && value[index + 2] === '\n' ? 2 : 1;
    } else if (value[index] === quote) {
      return index;
    }
  }
  return undefined;
}

function containsLegacyBehaviorDeclaration(
  css: string,
  declarationList: boolean,
): boolean {
  const boundary = declarationList ? '(?:^|;)' : '(?:[;{])';
  return new RegExp(`${boundary}\\s*[*_]?\\s*behavior\\s*:`, 'iu').test(css);
}

/** Removes escaped/comment-obfuscated imports without discarding passive CSS. */
function stripCssImports(css: string, onStrip?: () => void): string {
  const parts: string[] = [];
  let segmentStart = 0;
  let index = 0;
  let quote: '"' | "'" | undefined;
  while (index < css.length) {
    const character = css[index]!;
    if (quote) {
      if (character === '\\' && index + 1 < css.length) {
        index += 2;
        continue;
      }
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === '@') {
      const decodedPrefix = decodeCssEscapes(css.slice(index, index + 128));
      if (/^@import\b/iu.test(decodedPrefix)) {
        onStrip?.();
        parts.push(css.slice(segmentStart, index));
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
        segmentStart = index;
        continue;
      }
    }
    index += 1;
  }
  parts.push(css.slice(segmentStart));
  return parts.join('');
}

/** Retains only canonical passive HTTP(S) imports under Passive Fidelity. */
function rewritePassiveCssImports(
  css: string,
  baseUrl: string,
  representability?: HtmlMirrorRepresentabilityCollector,
): string | undefined {
  const parts: string[] = [];
  let segmentStart = 0;
  let index = 0;
  let quote: '"' | "'" | undefined;
  while (index < css.length) {
    const character = css[index]!;
    if (quote) {
      if (character === '\\' && index + 1 < css.length) {
        index += 2;
        continue;
      }
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (
      character !== '@' ||
      !/^@import\b/iu.test(decodeCssEscapes(css.slice(index, index + 128)))
    ) {
      index += 1;
      continue;
    }

    const start = index;
    parts.push(css.slice(segmentStart, start));
    let depth = 0;
    let importQuote: '"' | "'" | undefined;
    let terminated = false;
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
        terminated = true;
        break;
      }
      index += 1;
    }
    if (!terminated) return undefined;
    const statement = css.slice(start, index);
    const importUrl = extractCssImportUrl(statement) ?? '';
    const executableImport = /^\s*javascript\s*:/iu.test(
      decodeCssEscapes(importUrl),
    );
    const normalized = executableImport
      ? undefined
      : normalizePassiveCssImport(statement, baseUrl);
    if (normalized) {
      parts.push(normalized);
      if (representability) {
        incrementRepresentability(
          representability,
          'preservedStyleSheetCount',
        );
        // The normalized url(...) is inventoried once by the shared CSS URL
        // pass below; counting it here as well would double-report one import.
      }
    } else if (representability) {
      incrementRepresentability(
        representability,
        'strippedUnsafeResourceCount',
      );
      incrementRepresentability(
        representability,
        'omittedStyleSheetCount',
      );
      recordBlockedResourceScheme(importUrl, baseUrl, representability);
      if (!executableImport && isHttpResourceCandidate(importUrl, baseUrl)) {
        incrementRepresentability(
          representability,
          importUrl.length > MAX_HTML_MIRROR_STRING
            ? 'capacityOmissionCount'
            : 'strictResourcePolicyBlockCount',
        );
      }
    }
    if (executableImport) return undefined;
    segmentStart = index;
  }
  parts.push(css.slice(segmentStart));
  return parts.join('');
}

/**
 * Reads the URL an `@import` statement begins with, and where it ends. The
 * CSS string scanner is used rather than a regular expression that stops at
 * the first quote: an escaped quote stands before the one that closes the
 * string, and the expression cut the URL there and left the rest behind as
 * a malformed statement (R5).
 */
function readCssImportUrl(statement: string): {
  readonly rawUrl: string;
  readonly end: number;
} | undefined {
  const prefix = /^@import\b/iu.exec(statement);
  if (!prefix) return undefined;
  let index = prefix[0].length;
  const skipWhitespace = (): void => {
    while (index < statement.length && isAsciiWhitespace(statement[index]!)) {
      index += 1;
    }
  };
  skipWhitespace();
  const functionMatch = /^url\(/iu.exec(statement.slice(index));
  if (functionMatch) {
    index += functionMatch[0].length;
    skipWhitespace();
    const quote = statement[index];
    if (quote === '"' || quote === "'") {
      const end = findCssStringEnd(statement.slice(index), quote);
      if (end === undefined) return undefined;
      const rawUrl = statement.slice(index + 1, index + end);
      index += end + 1;
      skipWhitespace();
      if (statement[index] !== ')') return undefined;
      return { rawUrl, end: index + 1 };
    }
    const close = statement.indexOf(')', index);
    if (close < 0) return undefined;
    // The white space around an unquoted body is the tokenizer's own; what
    // stands inside it parts the token. `url(x y)` is a bad-url token the
    // browser never fetches, and must not become a live import here (R4).
    const rawUrl = statement.slice(index, close)
      .replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/gu, '');
    if (/["'(]/u.test(rawUrl) || hasUnescapedCssWhitespace(rawUrl)) {
      return undefined;
    }
    return { rawUrl, end: close + 1 };
  }
  const quote = statement[index];
  if (quote !== '"' && quote !== "'") return undefined;
  const end = findCssStringEnd(statement.slice(index), quote);
  if (end === undefined) return undefined;
  return {
    rawUrl: statement.slice(index + 1, index + end),
    end: index + end + 1,
  };
}

function extractCssImportUrl(statement: string): string | undefined {
  const read = readCssImportUrl(statement);
  if (!read) return undefined;
  const value = decodeCssEscapes(trimCssWhitespace(read.rawUrl));
  return value || undefined;
}

function normalizePassiveCssImport(
  statement: string,
  baseUrl: string,
): string | undefined {
  const read = readCssImportUrl(statement);
  if (!read || !statement.endsWith(';')) return undefined;
  const rawUrl = decodeCssEscapes(trimCssWhitespace(read.rawUrl));
  const conditions = statement.slice(read.end, -1).trim();
  if (
    conditions.length > 2_048 ||
    /[{};@\\]/u.test(conditions) ||
    /(?:url\s*\(|expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:)/iu
      .test(decodeCssEscapes(conditions)) ||
    !/^[a-z0-9\s(),.:/%_+\-<>=*"'#]*$/iu.test(conditions)
  ) return undefined;
  const url = passiveUrl(rawUrl, baseUrl, false);
  if (!url) return undefined;
  const escaped = url.replaceAll('"', '%22');
  return `@import url("${escaped}")${conditions ? ` ${conditions}` : ''};`;
}

function sanitizeSrcset(
  value: string,
  baseUrl: string,
  representability?: HtmlMirrorRepresentabilityCollector,
): string | undefined {
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
    if (!url) {
      if (representability && rawUrl) {
        incrementRepresentability(
          representability,
          'strippedUnsafeResourceCount',
        );
        if (rawUrl.length > MAX_HTML_MIRROR_STRING) {
          incrementRepresentability(
            representability,
            'capacityOmissionCount',
          );
        } else {
          recordBlockedResourceScheme(rawUrl, baseUrl, representability);
        }
      }
      continue;
    }
    if (suffix && !/^(?:\d+(?:\.\d+)?x|\d+w)$/u.test(suffix)) {
      if (representability) {
        incrementRepresentability(
          representability,
          'strippedUnsafeResourceCount',
        );
        incrementRepresentability(
          representability,
          'strictResourcePolicyBlockCount',
        );
      }
      continue;
    }
    if (representability && /^https?:\/\//u.test(url)) {
      incrementRepresentability(
        representability,
        'replicaRequestCapableResourceCount',
      );
    }
    candidates.push(suffix ? `${url} ${suffix}` : url);
  }
  return candidates.length > 0 ? candidates.join(', ') : undefined;
}

function isHttpResourceCandidate(raw: string, baseUrl: string): boolean {
  try {
    const protocol = new URL(raw, baseUrl).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
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

function recordBlockedResourceScheme(
  raw: string,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector,
): void {
  if (!raw.trim()) return;
  if (/^\s*javascript\s*:/iu.test(decodeCssEscapes(raw))) {
    incrementRepresentability(
      representability,
      'executionRiskBlockCount',
    );
    return;
  }
  try {
    const protocol = new URL(raw, baseUrl).protocol;
    if (protocol === 'blob:') {
      incrementRepresentability(
        representability,
        'browserInaccessibleResourceCount',
      );
    } else if (protocol !== 'http:' && protocol !== 'https:') {
      incrementRepresentability(
        representability,
        'unsupportedSchemeBlockCount',
      );
    }
  } catch {
    incrementRepresentability(
      representability,
      'unsupportedSchemeBlockCount',
    );
  }
}

function selectedSourceFor(
  element: Element,
  baseUrl: string,
): string | undefined {
  const raw = (element as Element & { readonly currentSrc?: unknown }).currentSrc;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const pageOnly = pageOnlyImagePixels(element, raw, baseUrl);
  if (pageOnly) return pageOnly;
  const selected = passiveUrl(raw, baseUrl, true);
  if (!selected) return undefined;
  const declaredRaw = element.getAttribute('src') ?? '';
  const declared = declaredRaw ? passiveUrl(declaredRaw, baseUrl, true) : undefined;
  return selected !== declared ? selected : undefined;
}

/** A small CORS image is copied only up to this many pixels (512 x 512). */
const MAX_PAGE_ONLY_CORS_IMAGE_PIXELS = 512 * 512;
/** A `blob:` image is copied up to 2048 x 2048 pixels. */
const MAX_PAGE_ONLY_BLOB_IMAGE_PIXELS = 2048 * 2048;
const PAGE_ONLY_IMAGE_PIXELS = new WeakMap<
  Element,
  { readonly source: string; readonly dataUrl: string | undefined }
>();

/**
 * Some images load in the page but can never load in the replica (D89): a
 * `blob:` address belongs to the page's origin, and an image the page loads
 * with `crossorigin` may be served only to the page's own origin (Fastmail's
 * account avatar answers 403 without `Origin: https://app.fastmail.com`).
 * The page has already decoded those pixels, and a CORS-approved or
 * same-origin image may be read back, so a loaded one within the size cap
 * travels as a data URL instead. A tainted canvas, an unloaded image or an
 * oversized one keeps today's address. Each image is encoded once per
 * address.
 */
function pageOnlyImagePixels(
  element: Element,
  raw: string,
  baseUrl: string,
): string | undefined {
  let blob = false;
  try {
    blob = new URL(raw, baseUrl).protocol === 'blob:';
  } catch {
    return undefined;
  }
  if (!blob && !element.hasAttribute('crossorigin')) return undefined;
  const cached = PAGE_ONLY_IMAGE_PIXELS.get(element);
  if (cached?.source === raw) return cached.dataUrl;
  const image = element as Element & {
    readonly complete?: unknown;
    readonly naturalWidth?: unknown;
    readonly naturalHeight?: unknown;
  };
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (
    image.complete !== true ||
    typeof width !== 'number' || typeof height !== 'number' ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width <= 0 || height <= 0
  ) return undefined;
  const pixels = width * height;
  let dataUrl: string | undefined;
  if (
    pixels <= (blob
      ? MAX_PAGE_ONLY_BLOB_IMAGE_PIXELS
      : MAX_PAGE_ONLY_CORS_IMAGE_PIXELS)
  ) {
    try {
      const canvas = sourceCall(element.ownerDocument, 'createElement', 'canvas') as HTMLCanvasElement;
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (context) {
        context.drawImage(element as HTMLImageElement, 0, 0);
        const encoded = pixels <= MAX_PAGE_ONLY_CORS_IMAGE_PIXELS
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/webp', 0.92);
        dataUrl = passiveUrl(encoded, baseUrl, true) === encoded
          ? encoded
          : undefined;
      }
    } catch {
      // A tainted canvas (an image the page may show but not read) keeps
      // its address.
      dataUrl = undefined;
    }
  }
  PAGE_ONLY_IMAGE_PIXELS.set(element, Object.freeze({ source: raw, dataUrl }));
  return dataUrl;
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
  const candidate = `${sourceLocalName(element)} ${element.getAttribute('class') ?? ''} ${
    element.getAttribute('style') ?? ''
  }`;
  if (!/(?:screen-reader|sr-only|visually-hidden|a11y|clip(?:-path)?\s*:)/iu.test(
    candidate,
  )) return false;
  const view = sourceDocumentProperty(element.ownerDocument, 'defaultView');
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

export function isSourceSelectVisuallyHidden(element: Element): boolean {
  return isSourceSelectEntryVisuallyHidden(element) ||
    isCanonicalClippedSourceElement(element) ||
    isComputedHiddenSourceSelect(element);
}

/**
 * A hidden dropdown that only something above it hides, and that would be
 * shown as it is once that is opened: a language picker in a site menu's
 * collapsed panel, which the mirror may open for the reader. The mirror
 * does not draw a dropdown marked hidden, so this one is not marked: it is
 * kept out of sight (`readSourceSelectPresentationStyle`) and shown with
 * the rest of the panel when the mirror opens it. One the page hides by a
 * rule of its own (a backing field under a custom dropdown) stays marked.
 */
export function isSourceSelectHeldOutOfSight(element: Element): boolean {
  return readSourceSelectRevealer(element) !== undefined &&
    !isSourceSelectHiddenByItself(element);
}

/**
 * Whether a dropdown would still not be drawn once what hides it from above
 * is shown: clipped away for screen readers, or hidden by a rule of its own.
 * The label reader asks this alone for a dropdown in a panel it was told the
 * mirror may open: that there is such a panel above, and nothing between
 * that stays hidden, it has found already, and need not walk that path once
 * more for each dropdown at every change of the page.
 */
export function isSourceSelectHiddenByItself(element: Element): boolean {
  return isCanonicalClippedSourceElement(element) ||
    isComputedHiddenSourceSelect(element, true);
}

/**
 * `opened`: as it would be once what hides it from above is shown. A
 * `visibility` it only inherits is then the panel's fade and not its own,
 * and without a box (under `display: none`) its computed transform says
 * nothing: for both, what the page itself wrote for it is asked.
 */
function isComputedHiddenSourceSelect(element: Element, opened = false): boolean {
  const view = sourceDocumentProperty(element.ownerDocument, 'defaultView');
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  try {
    const style = view.getComputedStyle(element);
    const width = cssPixelValue(style.width);
    const height = cssPixelValue(style.height);
    const signedPixels = (value: string): number | undefined => {
      const match = /^(-?\d+(?:\.\d+)?)px$/u.exec(value.trim().toLowerCase());
      if (!match) return undefined;
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const position = style.position.trim().toLowerCase();
    const left = signedPixels(style.left);
    const top = signedPixels(style.top);
    const positionedOffscreen = (position === 'absolute' || position === 'fixed') &&
      (
        (left !== undefined && width !== undefined && left + width <= 0) ||
        (top !== undefined && height !== undefined && top + height <= 0)
      );
    const transform = style.transform.trim().toLowerCase();
    const transformCollapses = opened && element.getClientRects().length === 0
      ? sourceElementScalesItselfToNothing(element, true)
      : transform !== '' && transform !== 'none' && (() => {
        try {
          const rect = element.getBoundingClientRect();
          return rect.width <= 0 || rect.height <= 0;
        } catch {
          return /(?:scale(?:3d|x|y)?\([^)]*\b0(?:[),]|\s))/u.test(transform);
        }
      })();
    return style.display.trim().toLowerCase() === 'none' ||
      (['hidden', 'collapse'].includes(style.visibility.trim().toLowerCase()) &&
        (!opened || sourceElementHidesItselfByVisibility(element, true))) ||
      (Number(style.opacity) === 0 &&
        !isSourceTransparentSelectClickTarget(element, view, style)) ||
      style.getPropertyValue('content-visibility').trim().toLowerCase() === 'hidden' ||
      positionedOffscreen ||
      transformCollapses ||
      // A dropdown of no width or no height: it clips what it holds
      // whatever its `overflow` computes to, which is `clip` on Chrome 154
      // and `visible` on Chrome 138 (D145; the rule asked for a clipping
      // `overflow`, so on 138 the labels of such a backing dropdown were
      // read while its menu was collapsed).
      width === 0 || height === 0;
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

function readSourceCanvasBackgroundColor(source: Element): string | undefined {
  const view = sourceDocumentProperty(source.ownerDocument, 'defaultView');
  if (!view || typeof view.getComputedStyle !== 'function') return undefined;
  for (const candidate of [source, sourceDocumentProperty(source.ownerDocument, 'body')]) {
    if (!candidate) continue;
    try {
      const color = readHtmlMirrorCanvasBackgroundColor(
        view.getComputedStyle(candidate).backgroundColor,
      );
      if (color && !isTransparentCanvasColor(color)) return color;
    } catch {
      // A missing computed style leaves the normal stylesheet path intact.
    }
  }
  return undefined;
}

export function readHtmlMirrorCanvasBackgroundColor(
  input: unknown,
): string | undefined {
  if (typeof input !== 'string') return undefined;
  const value = input.trim();
  if (
    value.length === 0 || value.length > 128 ||
    !/^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|rgba|hsl|hsla|lab|lch|oklab|oklch|color)\([a-z0-9#(),.%+\-/\s]+\))$/iu
      .test(value)
  ) return undefined;
  return value;
}

function isTransparentCanvasColor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'transparent' ||
    /\/\s*0(?:\.0+)?%?\s*\)$/u.test(normalized) ||
    /^(?:rgba|hsla)\([^)]+,\s*0(?:\.0+)?%?\s*\)$/u.test(normalized) ||
    /^(?:rgb|hsl)\([^,]+,[^,]+,[^,]+,\s*0(?:\.0+)?%?\s*\)$/u.test(
      normalized,
    );
}

function isUnsafeTransportedAttribute(
  namespace: HtmlMirrorNamespace,
  tagName: string,
  name: string,
  value: string,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  // These attributes are capabilities and receiver bookkeeping written only
  // after graph validation. A source page must never be able to mint them.
  // Two names of theirs travel: the page's XML-namespace `lang`, and on the
  // root alone the document's language.
  if (name === PAGE_DOCUMENT_LANGUAGE_ATTRIBUTE) {
    return namespace !== 'html' || tagName !== 'html' ||
      !isDocumentLanguageValue(value);
  }
  if (
    name !== PAGE_XML_LANGUAGE_ATTRIBUTE && isSimulOwnedAttributeName(name)
  ) return true;
  if (isPrivateBaseAttribute(tagName, name, true)) return true;
  if (
    isNativeSelectSemanticTag(tagName) &&
    !isNativeSelectPresentationAttribute(tagName, name)
  ) return true;
  if (
    isNativeSelectSemanticTag(tagName) &&
    (
      ((name === 'disabled' || name === 'multiple') && value !== '') ||
      (name === 'size' && canonicalNativeSelectSize(value) !== value) ||
      (name === 'role' && value !== 'textbox' && value !== 'button')
    )
  ) return true;
  if ((tagName === 'option' || tagName === 'optgroup') && name === 'style') {
    return true;
  }
  if (tagName === 'select' && name === 'style') {
    return sanitizeNativeSelectStyle(
      value,
      'about:blank',
      undefined,
      fidelityPolicy,
    ) !== value;
  }
  if (
    tagName === 'meta' && (name === 'http-equiv' || name === 'content')
  ) return true;
  if (
    tagName === 'link' &&
    (
      (name === 'rel' && value !== 'stylesheet') ||
      name === 'imagesrcset' || name === 'imagesizes'
    )
  ) return true;
  // The source answers `(scripting: …)` in a media query before it travels;
  // the receiver checks the answer is a fixed point, so a transported query
  // cannot make a scriptless replica apply no-script styles the tab did not.
  if (
    (name === 'media' &&
      (tagName === 'link' || tagName === 'style' || tagName === 'source')) ||
    (name === 'sizes' && (tagName === 'img' || tagName === 'source'))
  ) {
    return answerScriptingMediaFeatures(value) !== value;
  }
  const localSvgReference = namespace === 'svg' &&
    LOCAL_SVG_REFERENCE_ELEMENTS.has(tagName) &&
    (name === 'href' || name === 'xlink:href') &&
    LOCAL_SVG_FRAGMENT_PATTERN.test(value);
  const passiveSvgReference = fidelityPolicy === 'passive' &&
    namespace === 'svg' && PASSIVE_SVG_RESOURCE_ELEMENTS.has(tagName) &&
    (name === 'href' || name === 'xlink:href') &&
    passiveUrl(
      value,
      'about:blank',
      tagName === 'image' || tagName === 'feimage',
    ) === value;
  const passivePoster = fidelityPolicy === 'passive' && tagName === 'video' &&
    name === 'poster' && passiveUrl(value, 'about:blank', true) === value;
  if (
    name.startsWith('on') ||
    name === 'nonce' ||
    (ACTIVE_OR_NAVIGATIONAL_ATTRIBUTES.has(name) &&
      !localSvgReference && !passiveSvgReference && !passivePoster) ||
    (tagName === 'video' && MEDIA_ACTIVE_ATTRIBUTES.has(name)) ||
    (isSourceNativeTextControlTagName(tagName) &&
      RAW_CONTROL_TEXT_ATTRIBUTES.has(name) &&
      !SOURCE_PRIVACY_FILTERS_OFF)
  ) return true;
  if (localSvgReference || passiveSvgReference || passivePoster) return false;
  if (name === 'href') {
    return (
      tagName !== 'link' && !(fidelityPolicy === 'passive' && tagName === 'a')
    ) || passiveUrl(value, 'about:blank', false) !== value;
  }
  if (name === 'src') {
    return !PASSIVE_IMAGE_ELEMENTS.has(tagName) ||
      passiveUrl(value, 'about:blank', true) !== value;
  }
  if (name === 'srcset') {
    return (
      tagName !== 'img' && !(fidelityPolicy === 'passive' && tagName === 'source')
    ) || sanitizeSrcset(value, 'about:blank') !== value;
  }
  if (name === 'background') {
    return fidelityPolicy !== 'passive' ||
      !LEGACY_BACKGROUND_ELEMENTS.has(tagName) ||
      passiveUrl(value, 'about:blank', true) !== value;
  }
  if (name === 'style') {
    return sanitizeCss(
      value,
      'about:blank',
      true,
      undefined,
      fidelityPolicy,
    ) !== value;
  }
  if (
    namespace === 'svg' &&
    SVG_URL_PRESENTATION_ATTRIBUTES.has(name)
  ) {
    if (hasBareSvgResourceScheme(value)) return true;
    return sanitizeCss(
      value,
      'about:blank',
      true,
      undefined,
      fidelityPolicy,
    ) !== value;
  }
  return false;
}

function hasBareSvgResourceScheme(value: string): boolean {
  return /^(?:https?|blob|data|javascript)\s*:/iu.test(
    decodeCssEscapes(value).trim(),
  );
}

function isLocalSvgReference(
  element: Element,
  tagName: string,
  name: string,
  value: string,
): boolean {
  return element.namespaceURI === 'http://www.w3.org/2000/svg' &&
    LOCAL_SVG_REFERENCE_ELEMENTS.has(tagName) &&
    (name === 'href' || name === 'xlink:href') &&
    LOCAL_SVG_FRAGMENT_PATTERN.test(value);
}

function isPassiveSvgVisualReference(
  element: Element,
  tagName: string,
  name: string,
  value: string,
): boolean {
  if (
    element.namespaceURI !== 'http://www.w3.org/2000/svg' ||
    !PASSIVE_SVG_RESOURCE_ELEMENTS.has(tagName) ||
    (name !== 'href' && name !== 'xlink:href')
  ) return false;
  return passiveUrl(
    value,
    element.ownerDocument?.baseURI ?? 'about:blank',
    tagName === 'image' || tagName === 'feimage',
  ) !== undefined;
}

function isUnsafeElement(
  tagName: string,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): boolean {
  return UNSAFE_ELEMENTS.has(tagName) ||
    (tagName === 'video' && fidelityPolicy !== 'passive');
}

function isUnsafeSourceElement(
  element: Element,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
  baseUrl: string,
): boolean {
  const tagName = sourceLocalName(element).toLowerCase();
  // What a page keeps for browsers without scripts is an ordinary element
  // where the tab runs none (D181): its content is drawn there, and the
  // mirror, which runs none either, draws it too. Where the tab runs
  // scripts it holds the markup as text, and is left out.
  if (tagName === 'noscript') return sourceRunsScripts();
  if (isUnsafeElement(tagName, fidelityPolicy)) return true;
  if (tagName !== 'video') return false;
  const poster = element.getAttribute('poster');
  return !poster || passiveUrl(poster, baseUrl, true) === undefined;
}

/**
 * HTML elements the reader leaves out that the mirror holds a place for
 * (D181): an empty element of Simul's own name that no page selector
 * targets and that draws nothing, the canonical opaque placeholder. Left out
 * whole, a script or an iframe made `:first-child`, `:empty`, `:nth-child`
 * and sibling rules count otherwise than in the tab.
 */
const LEFT_OUT_PLACEHOLDER_TAGS: ReadonlySet<string> = new Set<HtmlMirrorLeftOutTagName>(
  HTML_MIRROR_LEFT_OUT_TAG_NAMES,
);

export function isHtmlMirrorLeftOutTagName(
  value: unknown,
): value is HtmlMirrorLeftOutTagName {
  return typeof value === 'string' && LEFT_OUT_PLACEHOLDER_TAGS.has(value);
}

function serializeLeftOutPlaceholder(
  id: number,
  context: SerializeContext,
  leftOutTagName: HtmlMirrorLeftOutTagName,
): HtmlMirrorElementNode {
  const tagName = sourceSecretPlaceholderTagName(id);
  admitNode(context.budget, id, tagName.length * 2 + 64, context.representability);
  return Object.freeze({
    kind: 'element',
    id,
    namespace: 'html',
    tagName,
    attributes: Object.freeze([]),
    children: Object.freeze([]),
    opaquePlaceholder: true as const,
    leftOutTagName,
  });
}

function elementStartsPrivateRegion(
  element: Element,
  secretAncestors?: SourceSecretAncestorMemo,
): boolean {
  if (
    hasSourceCredentialSecretAncestor(element, undefined, undefined, secretAncestors)
  ) return true;
  return sourceElementStartsPrivateRegionInContext(
    sourceLocalName(element),
    readSourceStructuralAttributes(element),
    isSourceOptionInsideNativeSelect(element),
  ) || sourceElementIsEditorWithoutAttribute(element);
}

/**
 * Editors a page made without the `contenteditable` attribute (D181): the
 * element at the top of what a person typed into, met by `beforeinput` or
 * `input` (`-webkit-user-modify: read-write` in a page's style, or a
 * document in design mode). Kept for the document's life, as a secret is.
 */
const SOURCE_EDITORS_WITHOUT_ATTRIBUTE = new WeakSet<Element>();

/**
 * Whether `element` is an editor the page made without the attribute: one
 * that was typed into, or the root of a document in design mode. What it
 * holds is withheld from the mirror channel as an editor's is; asking each
 * element's computed style or `isContentEditable` would cost a style read
 * an element of every read.
 */
export function sourceElementIsEditorWithoutAttribute(element: Element): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
  if (SOURCE_EDITORS_WITHOUT_ATTRIBUTE.has(element)) return true;
  try {
    const document = element.ownerDocument;
    return element === sourceDocumentProperty(document, 'documentElement') &&
      sourceDocumentProperty(document, 'designMode')?.toLowerCase() === 'on';
  } catch {
    return false;
  }
}

/**
 * For the target of a `beforeinput` or `input` event: the editor it is in,
 * when the page made that editor without the attribute and it is new to the
 * reader (D181), so that the reader reads it again as an editor; otherwise
 * `undefined`. A text field, and an editor the attribute (or a role) makes,
 * are known already. `beforeinput` comes before the typed text is put in.
 */
export function noteSourceEditingTarget(target: Element): Element | undefined {
  if (SOURCE_PRIVACY_FILTERS_OFF) return undefined;
  try {
    if (!sourceElementIsEditable(target)) return undefined;
    const path = readSourceFlatTreeElementPath(target);
    if (!path) return undefined;
    // The editor is the outermost element of the editable run.
    let editor = target;
    for (let index = 1; index < path.length; index += 1) {
      const above = path[index]!;
      if (!sourceElementIsEditable(above)) break;
      editor = above;
    }
    for (const current of path) {
      if (
        SOURCE_EDITORS_WITHOUT_ATTRIBUTE.has(current) ||
        sourceElementStartsPrivateRegionInContext(
          sourceLocalName(current),
          readSourceStructuralAttributes(current),
          isSourceOptionInsideNativeSelect(current),
        )
      ) return undefined;
    }
    SOURCE_EDITORS_WITHOUT_ATTRIBUTE.add(editor);
    return editor;
  } catch {
    return undefined;
  }
}

/**
 * Whether a person can type into `element`. Chrome 158 answers
 * `isContentEditable` false for an element its style makes editable
 * (`-webkit-user-modify: read-write`), and takes typing there all the same;
 * the computed style says it.
 */
function sourceElementIsEditable(element: Element): boolean {
  if ((element as Partial<HTMLElement>).isContentEditable === true) return true;
  const view = sourceProperty(element.ownerDocument, 'defaultView');
  const style = view?.getComputedStyle?.call(view, element);
  const value = typeof style?.getPropertyValue === 'function'
    ? style.getPropertyValue('-webkit-user-modify')
    : undefined;
  return typeof value === 'string' &&
    value.trim().toLowerCase().startsWith('read-write');
}

interface SourceHiddenRegionState {
  /** The element starts a withheld region: hidden, collapsed or controlled. */
  readonly starts: boolean;
  /** Its own computed `visibility` hides its text (see SerializeContext). */
  readonly visibilityHidden: boolean;
  /**
   * Its computed `content-visibility` is `hidden`: it draws none of what it
   * holds (D187; read from the same style, for `readSourceSkippedContentState`).
   */
  readonly contentVisibilityHidden?: boolean;
}

const SOURCE_REGION_VISIBLE: SourceHiddenRegionState = Object.freeze({
  starts: false,
  visibilityHidden: false,
});
const SOURCE_REGION_WITHHELD: SourceHiddenRegionState = Object.freeze({
  starts: true,
  visibilityHidden: false,
});

/**
 * Hidden and ARIA-controlled panels are optional disclosure payload, not base
 * page text.  This reads only visibility/relationship structure and never an
 * authored label or value.
 *
 * A `hidden` or `aria-hidden="true"` declaration alone is not proof: a site's
 * accordion script can mark collapsed content hidden while its desktop
 * stylesheet forces that content visible. Computed style decides; when it
 * shows the element, the declaration is kept only if the element has no
 * painted box, and without readable style or geometry the declaration fails
 * closed. (The strict paint proof cannot be used here: it reports a
 * declared-versus-computed contradiction as unknown by design.)
 *
 * `visibility: hidden` does not start a region (D76): a descendant can set
 * `visibility: visible` and paint, so each element reports its own computed
 * visibility and text follows its parent's.
 */
export function readSourceHiddenRegionState(
  element: Element,
  controlledContent: SourceControlledContentPolicy,
): SourceHiddenRegionState {
  // "Show everything (testing)" copies hidden text too; the page's CSS still
  // hides it in the replica (D75).
  if (SOURCE_PRIVACY_FILTERS_OFF) return SOURCE_REGION_VISIBLE;
  try {
    if (sourceControlledContentIsWithheld(element, controlledContent)) {
      return SOURCE_REGION_WITHHELD;
    }
    const declaredHidden =
      element.hasAttribute('hidden') ||
      element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
    const view = sourceProperty(element.ownerDocument, 'defaultView');
    const getComputedStyle = view?.getComputedStyle;
    if (typeof getComputedStyle !== 'function') {
      return declaredHidden ? SOURCE_REGION_WITHHELD : SOURCE_REGION_VISIBLE;
    }
    const style = getComputedStyle.call(view, element);
    const display = typeof style?.display === 'string'
      ? style.display.trim().toLowerCase()
      : undefined;
    const visibility = typeof style?.visibility === 'string'
      ? style.visibility.trim().toLowerCase()
      : undefined;
    const visibilityHidden = visibility === 'hidden' || visibility === 'collapse';
    const contentVisibility = typeof style?.getPropertyValue === 'function'
      ? style.getPropertyValue('content-visibility')
      : undefined;
    const contentVisibilityHidden = typeof contentVisibility === 'string' &&
      contentVisibility.trim().toLowerCase() === 'hidden';
    const state = (starts: boolean): SourceHiddenRegionState =>
      Object.freeze(contentVisibilityHidden
        ? { starts, visibilityHidden, contentVisibilityHidden }
        : { starts, visibilityHidden });
    if (display === 'none') return state(true);
    if (!declaredHidden) return state(false);
    // The declaration yields only to a box that is really painted, by the
    // same inputs the strict paint proof reads (bug-hunt P1): unreadable
    // style, `hidden="until-found"`, zero opacity, skipped content, or a
    // clip keep it.
    if (
      display === undefined ||
      visibility === undefined ||
      element.getAttribute('hidden')?.trim().toLowerCase() === 'until-found'
    ) return state(true);
    // An element without a box of its own (`display: contents`, as every
    // `<slot>` is) has none to check the declaration against, and nothing
    // that leaves a box unpainted applies to it: it is displayed, and what
    // it holds is shown or not by itself (D135; text drawn through
    // `<slot aria-hidden="true">` was withheld).
    if (display === 'contents') return state(false);
    if (declaredHiddenRegionIsUnpainted(style)) return state(true);
    return state(
      !hasSourcePositivePaintBox(element) &&
        !sourceDescendantPaintsOutsideEmptyBox(element, style),
    );
  } catch {
    return SOURCE_REGION_WITHHELD;
  }
}

/**
 * What Chrome draws nothing of though no box of it is hidden by the rule of
 * `readSourceHiddenRegionState` (D181, owner ruling D175): a closed
 * `<details>` draws its summary alone, and `content-visibility: hidden`
 * draws none of what an element holds. `skipped`: the element itself is not
 * drawn, since the element it is drawn in skips it. `skipsText`: the text
 * the element holds itself is not drawn. Field values and editor text there
 * count as hidden; the page's own text in a closed `<details>` keeps
 * travelling on the mirror channel (the mirror's own closed `<details>`
 * hides it again, and a reader may open it there), so the mirror's reading
 * does not ask this. Content-free: no label or value is read.
 */
export interface SourceSkippedContentState {
  readonly skipped: boolean;
  readonly skipsText: boolean;
}

const SOURCE_CONTENT_DRAWN: SourceSkippedContentState = Object.freeze({
  skipped: false,
  skipsText: false,
});

export function readSourceSkippedContentState(
  element: Element,
  /**
   * Whether an element's computed `content-visibility` is `hidden`, for a
   * reader that has its style read already (the `contentVisibilityHidden`
   * of `readSourceHiddenRegionState`).
   */
  contentVisibilityHidden: (element: Element) => boolean =
    sourceContentVisibilityIsHidden,
): SourceSkippedContentState {
  if (SOURCE_PRIVACY_FILTERS_OFF) return SOURCE_CONTENT_DRAWN;
  try {
    const parent = readSourceFlatTreeParentElement(element);
    const skipped = parent !== undefined && (
      contentVisibilityHidden(parent) ||
      (isClosedSourceDetails(parent) && !isSourceDetailsSummary(parent, element))
    );
    const skipsText = isClosedSourceDetails(element) ||
      contentVisibilityHidden(element);
    return skipped || skipsText
      ? Object.freeze({ skipped, skipsText })
      : SOURCE_CONTENT_DRAWN;
  } catch {
    return Object.freeze({ skipped: true, skipsText: true });
  }
}

function isClosedSourceDetails(element: Element): boolean {
  return element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
    sourceLocalName(element).toLowerCase() === 'details' &&
    !element.hasAttribute('open');
}

function sourceContentVisibilityIsHidden(element: Element): boolean {
  const view = sourceProperty(element.ownerDocument, 'defaultView');
  const style = view?.getComputedStyle?.call(view, element);
  const value = typeof style?.getPropertyValue === 'function'
    ? style.getPropertyValue('content-visibility')
    : undefined;
  return typeof value === 'string' && value.trim().toLowerCase() === 'hidden';
}

/** Whether `child` is the summary a closed `<details>` still draws. */
function isSourceDetailsSummary(details: Element, child: Element): boolean {
  if (
    child.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
    sourceLocalName(child).toLowerCase() !== 'summary' ||
    child.parentElement !== details
  ) return false;
  for (const sibling of details.children) {
    if (
      sibling.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      sourceLocalName(sibling).toLowerCase() === 'summary'
    ) return sibling === child;
  }
  return false;
}

function elementStartsHiddenOrControlledDisclosureRegion(
  element: Element,
  controlledContent: SourceControlledContentPolicy,
): boolean {
  return readSourceHiddenRegionState(element, controlledContent).starts ||
    sourceNodeIsUnslotted(element);
}

/**
 * Whether `node` is a child of a shadow host that the host's root assigns
 * to no slot (D181): Chrome draws it nowhere, and it is withheld as what a
 * hidden box holds is. Where the root is open Chrome says so exactly
 * (`assignedSlot` is null). Where it is closed the answer is worked out,
 * from the slot of the node's name or the lists of a root that assigns by
 * script, and only for a root the reader knows; a host with a root no
 * reader has met is read as its host is, as it always was. A wrong "no
 * slot" would blank text the tab draws.
 */
export function sourceNodeIsUnslotted(node: Node): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
  try {
    if (sourceNodeType(node) !== 1 && sourceNodeType(node) !== 3) return false;
    const host = node.parentNode;
    if (!host || sourceNodeType(host) !== 1) return false;
    // An open root's slot is the node's own `assignedSlot`; a closed
    // root's is worked out from the ledger, or not at all.
    if (!canHostAuthorShadowRoot(host as Element)) return false;
    return readSourceShadowRoot(host as Element) !== undefined &&
      readSourceAssignedSlot(node) === null;
  } catch {
    return false;
  }
}

const SOURCE_SLOT_REGION_UNSLOTTED: SourceSlotRegion = Object.freeze({
  withheld: true,
  privacy: false,
  activation: false,
  visibilityHidden: false,
});

/**
 * For an element the page declares hidden (`hidden`, `aria-hidden="true"`):
 * whether what it holds is withheld. The declaration yields to a box that
 * is really painted, so the answer is read from the element's style and
 * box, and no change of the element's `display` or `visibility` need go
 * with a change of it: a style sheet that fades the box out changes it
 * (D143). Nothing for an element with no such declaration, which `display`
 * and `visibility` decide alone.
 */
export function sourceDeclaredHiddenRegionIsWithheld(
  element: Element,
  controlledContent: SourceControlledContentPolicy,
): boolean | undefined {
  try {
    if (
      !element.hasAttribute('hidden') &&
      element.getAttribute('aria-hidden')?.trim().toLowerCase() !== 'true'
    ) return undefined;
  } catch {
    return true;
  }
  return readSourceHiddenRegionState(element, controlledContent).starts;
}

const SOURCE_SLOT_REGION_UNREADABLE: SourceSlotRegion = Object.freeze({
  withheld: true,
  privacy: true,
  activation: false,
  visibilityHidden: false,
});

/**
 * A child of a shadow host is drawn in the slot its host's root assigns it
 * to, inside whatever that root puts around the slot, and the walk down the
 * page's own tree never passes those boxes. The child is read as it would be
 * if it sat there in the page itself: a hidden or collapsed box hides it
 * (D135; text slotted into a closed dialog travelled, and was translated,
 * while it was hidden), a box that is edited withholds its text from the
 * mirror (text slotted into a component's text editor travelled under every
 * read profile, where the same text in an editor of the page did not), and a
 * control that acts counts for it. A child the host's root assigns to no
 * slot is drawn nowhere and is withheld (`sourceNodeIsUnslotted`, D181);
 * `undefined` for any other node that no slot takes (no root, or a closed
 * root no reader has met): it is read as its host is, as it always was. A
 * slot's boxes are looked at once in a walk.
 */
function readSourceSlotRegion(
  child: Node,
  controlledContent: SourceControlledContentPolicy,
  known: Map<Element, SourceSlotRegion>,
  secretAncestors: SourceSecretAncestorMemo,
): SourceSlotRegion | undefined {
  let slot: Element | null | undefined;
  try {
    slot = readSourceAssignedSlot(child);
  } catch {
    return SOURCE_SLOT_REGION_UNREADABLE;
  }
  if (!slot) {
    return sourceNodeIsUnslotted(child) ? SOURCE_SLOT_REGION_UNSLOTTED : undefined;
  }
  // In a flush, what one read learned of a slot and of the boxes above it
  // serves every read of it: many roots that reassign their slots at once
  // had the body, and every box they share, asked again for each (D222).
  const shared = ambientSlotRegions(controlledContent);
  const kept = known.get(slot) ?? shared?.regions.get(slot);
  if (kept) {
    known.set(slot, kept);
    return kept;
  }
  let region = SOURCE_SLOT_REGION_UNREADABLE;
  const path = readSourceFlatTreeElementPath(slot);
  if (path) {
    const starts = shared?.starts ?? createSourceSlotPathStarts();
    region = Object.freeze({
      withheld: memoizedPathStartsRegion(path, starts.withheld, (current) =>
        elementStartsHiddenOrControlledDisclosureRegion(current, controlledContent)),
      // A dropdown too: what is slotted into one of its options is not
      // drawn, and nothing inside a dropdown is page text.
      privacy: memoizedPathStartsRegion(path, starts.privacy, (current) =>
        elementStartsPrivateRegion(current, secretAncestors) ||
        sourceLocalName(current).toLowerCase() === 'select'),
      activation: memoizedPathStartsRegion(
        path,
        starts.activation,
        elementStartsActivationRegion,
      ),
      visibilityHidden:
        readSourceHiddenRegionState(slot, controlledContent).visibilityHidden,
    });
  }
  known.set(slot, region);
  shared?.regions.set(slot, region);
  return region;
}

/** Of each element: whether it, or a box above it, starts such a region. */
interface SourceSlotPathStarts {
  readonly withheld: Map<Element, boolean>;
  readonly privacy: Map<Element, boolean>;
  readonly activation: Map<Element, boolean>;
}

function createSourceSlotPathStarts(): SourceSlotPathStarts {
  return { withheld: new Map(), privacy: new Map(), activation: new Map() };
}

/** What a flush knows of slots under `controlledContent`; see above. */
function ambientSlotRegions(
  controlledContent: SourceControlledContentPolicy,
): {
  readonly regions: Map<Element, SourceSlotRegion>;
  readonly starts: SourceSlotPathStarts;
} | undefined {
  const memo = ambientWithheldAncestors;
  if (!memo) return undefined;
  let known = memo.slots.get(controlledContent);
  if (!known) {
    known = { regions: new Map(), starts: createSourceSlotPathStarts() };
    memo.slots.set(controlledContent, known);
  }
  return known;
}

/**
 * How one reader last read each child of a shadow host: by which of the
 * boxes around its slot (hidden, edited, a control that acts, and for text
 * the slot's visibility). Only that decides what a child's slot changes of
 * what is sent, so a child given another slot is read again only when this
 * differs; see `sourceSlotReadingChanged`. Nothing of the page's content.
 *
 * It is the note of one reader about one mirror: the reader makes it, hands
 * it to every read it makes for that mirror, and it ends with the reader. A
 * note kept for the whole page was written by the first of two mirrors of a
 * tab and believed by the second, which then kept a text the first had
 * taken back.
 */
export type SourceSlotReadings = WeakMap<Node, number>;

export function createSourceSlotReadings(): SourceSlotReadings {
  return new WeakMap();
}

function sourceSlotReading(
  child: Node,
  region: SourceSlotRegion | undefined,
  hostVisibilityHidden: boolean,
): number {
  // A child no slot takes is read as its host is.
  const visibilityHidden = sourceNodeType(child) === Node.TEXT_NODE &&
    (region ? region.visibilityHidden : hostVisibilityHidden);
  return (region?.withheld ? 1 : 0) | (region?.privacy ? 2 : 0) |
    (region?.activation ? 4 : 0) | (visibilityHidden ? 8 : 0);
}

/** A read that is for no mirror (no note is handed in) notes nothing. */
function noteSourceSlotReading(
  readings: SourceSlotReadings | undefined,
  child: Node,
  region: SourceSlotRegion | undefined,
  hostVisibilityHidden: boolean,
): void {
  readings?.set(
    child,
    sourceSlotReading(child, region, hostVisibilityHidden),
  );
}

/**
 * A node read on its own, or whose children are: where it is a child of a
 * host it is read by the boxes around its slot, as its ancestors in the
 * drawn tree say, and that is how it is read from now on. (Noted for any
 * other node too, where nothing asks for it.)
 */
function noteSourceSlotReadingOfRoot(
  readings: SourceSlotReadings | undefined,
  source: Node,
  controlledContent: SourceControlledContentPolicy,
  slotRegions: Map<Element, SourceSlotRegion>,
  secretAncestors: SourceSecretAncestorMemo,
  hostVisibilityHidden: boolean,
): void {
  noteSourceSlotReading(
    readings,
    source,
    readSourceSlotRegion(source, controlledContent, slotRegions, secretAncestors),
    hostVisibilityHidden,
  );
}

/** What one pass over the children of hosts shares; see below. */
export interface SourceSlotReadingWalk {
  readonly readings: SourceSlotReadings;
  readonly controlledContent: SourceControlledContentPolicy;
  readonly regions: Map<Element, SourceSlotRegion>;
  readonly secretAncestors: SourceSecretAncestorMemo;
}

export function beginSourceSlotReadingWalk(
  readings: SourceSlotReadings,
  sourceDocument: Document,
  precomputedControlledContent?: SourceControlledContentPolicy,
): SourceSlotReadingWalk {
  return {
    readings,
    controlledContent: precomputedControlledContent ??
      createSourceControlledContentPolicy(sourceDocument),
    regions: new Map(),
    secretAncestors: createSourceSecretAncestorMemo(),
  };
}

/**
 * Whether a child of a shadow host would now be read otherwise than the
 * reader of `walk` last read it, because it is drawn in another slot or
 * the slots of its host's root changed. True for a child that reader never
 * read as a host's child. A slot added, removed, renamed or filled by a
 * script moves what a host holds between boxes, and most moves change
 * nothing of what is sent: only a child for which this is true is sent
 * again, and reading it notes how.
 */
export function sourceSlotReadingChanged(
  child: Node,
  walk: SourceSlotReadingWalk,
): boolean {
  const region = readSourceSlotRegion(
    child,
    walk.controlledContent,
    walk.regions,
    walk.secretAncestors,
  );
  return walk.readings.get(child) !== sourceSlotReading(
    child,
    region,
    // Asked only where it counts: for text that no slot takes.
    !region && sourceNodeType(child) === Node.TEXT_NODE &&
      readSourceHiddenRegionState(
        child.parentElement as Element,
        walk.controlledContent,
      ).visibilityHidden,
  );
}

/** Content-free: computed style that leaves a displayed box unpainted. */
function declaredHiddenRegionIsUnpainted(style: CSSStyleDeclaration): boolean {
  const read = (name: string): string | undefined => {
    const value = typeof style.getPropertyValue === 'function'
      ? style.getPropertyValue(name)
      : undefined;
    return typeof value === 'string' ? value.trim().toLowerCase() : undefined;
  };
  const opacity = typeof style.opacity === 'string'
    ? style.opacity.trim()
    : read('opacity');
  if (opacity !== undefined && opacity !== '' && Number(opacity) === 0) {
    return true;
  }
  if (read('content-visibility') === 'hidden') return true;
  const clip = read('clip');
  if (
    clip !== undefined && clip !== '' && clip !== 'auto' && clip !== 'none'
  ) return true;
  const clipPath = read('clip-path');
  return clipPath !== undefined && clipPath !== '' && clipPath !== 'none';
}

/** Content-free: whether any client rect of the element has a positive size. */
function hasSourcePositivePaintBox(element: Element): boolean {
  try {
    const rects = element.getClientRects();
    for (let index = 0; index < rects.length; index += 1) {
      const rect = rects[index] ?? rects.item(index);
      if (
        rect &&
        Number.isFinite(rect.width) && Number.isFinite(rect.height) &&
        rect.width > 0 && rect.height > 0
      ) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * How many elements under a declared-hidden element with no box of its own
 * are asked for a box before it is taken as unpainted (D233).
 */
const SOURCE_EMPTY_BOX_DESCENDANT_LIMIT = 512;

/**
 * For a declared-hidden element whose own box has no size: whether
 * something it holds is drawn all the same (D233). A box of no size does not
 * clip, so a fixed or absolutely placed descendant paints wherever it is
 * placed: a consent library put its dialog under a host of zero height marked
 * `aria-hidden="true"`, and the mirror drew the dialog without a word of its
 * text. An element that clips its overflow keeps what it holds out of sight
 * (bar a fixed descendant, which is not looked for), so it is not asked. The
 * walk stops at the first descendant with a box, and after
 * `SOURCE_EMPTY_BOX_DESCENDANT_LIMIT` elements without one the element counts
 * as unpainted, as before. Content-free: only boxes are read.
 */
function sourceDescendantPaintsOutsideEmptyBox(
  element: Element,
  style: CSSStyleDeclaration,
): boolean {
  try {
    const clips = (value: unknown): boolean =>
      typeof value === 'string' && value.trim() !== '' &&
      value.trim().toLowerCase() !== 'visible';
    if (clips(style.overflowX) || clips(style.overflowY)) return false;
    const pending: Node[] = [];
    const queueChildren = (node: Node): void => {
      const children = sourceChildNodeList(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child && sourceNodeType(child) === 1) pending.push(child);
      }
    };
    const queueOwnRoot = (host: Element): void => {
      const shadow = readSourceShadowRoot(host);
      if (shadow) queueChildren(shadow);
    };
    queueOwnRoot(element);
    queueChildren(element);
    let asked = 0;
    while (pending.length > 0 && asked < SOURCE_EMPTY_BOX_DESCENDANT_LIMIT) {
      const current = pending.pop() as Element;
      asked += 1;
      if (hasSourcePositivePaintBox(current)) return true;
      queueOwnRoot(current);
      queueChildren(current);
    }
    return false;
  } catch {
    return false;
  }
}

function hasSourceBaseWithheldAncestor(
  element: Element,
  controlledContent: SourceControlledContentPolicy,
): boolean {
  return hasSourceWithheldAncestor(element, controlledContent);
}

/**
 * The privacy-only subset of `hasSourceBaseWithheldAncestor`: private
 * controls and native selects, but not hidden or controlled disclosure
 * regions.
 */
function hasSourcePrivacyWithheldAncestor(element: Element): boolean {
  return hasSourceWithheldAncestor(element, undefined);
}

/**
 * One answer an element for a run of a reader that the page cannot
 * interrupt (D181), for the questions whether a withheld region, or a
 * region whose attributes are private, lies above it. An attribute patch
 * asks them of each element it names, and each time every element above was
 * classified again, its style read at each step: a `title` set on 250
 * elements nested in one another was 70 of a 113 ms pause. Entries map an
 * element to whether it or an element above it starts such a region.
 */
interface SourceWithheldAncestorMemo {
  readonly privacy: Map<Element, boolean>;
  readonly withheld: Map<SourceControlledContentPolicy, Map<Element, boolean>>;
  readonly privateAttributes: Map<Element, boolean>;
  /** The boxes around slots (D222); see `readSourceSlotRegion`. */
  readonly slots: Map<SourceControlledContentPolicy, {
    readonly regions: Map<Element, SourceSlotRegion>;
    readonly starts: SourceSlotPathStarts;
  }>;
}

let ambientWithheldAncestors: SourceWithheldAncestorMemo | undefined;
let ambientWithheldAncestorWalks = 0;

/**
 * Opens one run of a reader that the page cannot interrupt (a flush): until
 * it is ended, the questions above share one memo. Walks nest; end each in
 * a `finally`. Never keep one open across a task.
 */
export function beginSourceWithheldAncestorWalk(): { end(): void } {
  ambientWithheldAncestorWalks += 1;
  ambientWithheldAncestors ??= {
    privacy: new Map(),
    withheld: new Map(),
    privateAttributes: new Map(),
    slots: new Map(),
  };
  let ended = false;
  return {
    end: () => {
      if (ended) return;
      ended = true;
      ambientWithheldAncestorWalks -= 1;
      if (ambientWithheldAncestorWalks === 0) {
        ambientWithheldAncestors = undefined;
      }
    },
  };
}

/**
 * Whether an element of `path` (the element first, then the elements above
 * it) starts a region by `starts`, each element asked once for the memo's
 * life: the lowest element the memo knows answers for itself and everything
 * above it.
 */
function memoizedPathStartsRegion(
  path: readonly Element[],
  known: Map<Element, boolean>,
  starts: (element: Element) => boolean,
): boolean {
  let index = 0;
  let above = false;
  for (; index < path.length; index += 1) {
    const answer = known.get(path[index]!);
    if (answer !== undefined) {
      above = answer;
      break;
    }
  }
  for (index -= 1; index >= 0; index -= 1) {
    const current = path[index]!;
    above = above || starts(current);
    known.set(current, above);
  }
  return above;
}

function sourceElementStartsWithheldRegion(
  current: Element,
  controlledContent: SourceControlledContentPolicy | undefined,
): boolean {
  const localName = sourceLocalName(current);
  return sourceElementStartsPrivateRegionInContext(
    localName,
    readSourceStructuralAttributes(current),
    isSourceOptionInsideNativeSelect(current),
  ) ||
    sourceElementIsEditorWithoutAttribute(current) ||
    localName.toLowerCase() === 'select' ||
    (controlledContent !== undefined &&
      elementStartsHiddenOrControlledDisclosureRegion(current, controlledContent));
}

function hasSourceWithheldAncestor(
  element: Element,
  controlledContent: SourceControlledContentPolicy | undefined,
): boolean {
  const memo = ambientWithheldAncestors;
  if (memo) {
    if (
      !SOURCE_PRIVACY_FILTERS_OFF && hasSourceCredentialSecretAncestor(element)
    ) return true;
    const path = readSourceFlatTreeElementPath(element);
    if (!path) return true;
    let known = memo.privacy;
    if (controlledContent) {
      known = memo.withheld.get(controlledContent) ?? new Map();
      memo.withheld.set(controlledContent, known);
    }
    return memoizedPathStartsRegion(
      path,
      known,
      (current) => sourceElementStartsWithheldRegion(current, controlledContent),
    );
  }
  if (hasSourcePrivateElementAncestor(element)) return true;
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
    const tagName = sourceLocalName(current).toLowerCase();
    if (
      tagName === 'select' ||
      sourceElementIsEditorWithoutAttribute(current) ||
      (controlledContent !== undefined &&
        elementStartsHiddenOrControlledDisclosureRegion(current, controlledContent))
    ) return true;
  }
  return false;
}

function isNativeSelectSemanticTag(tagName: string): boolean {
  return tagName === 'select' || tagName === 'option' || tagName === 'optgroup';
}

function isNativeSelectPresentationAttribute(
  tagName: string,
  name: string,
): boolean {
  if (tagName === 'select') {
    return NATIVE_SELECT_PRESENTATION_ATTRIBUTES.select.has(name);
  }
  if (tagName === 'option') {
    return NATIVE_SELECT_PRESENTATION_ATTRIBUTES.option.has(name);
  }
  return tagName === 'optgroup' &&
    NATIVE_SELECT_PRESENTATION_ATTRIBUTES.optgroup.has(name);
}

function canonicalNativeSelectSize(value: string): string | undefined {
  const normalized = value.trim();
  if (!/^\d{1,10}$/u.test(normalized)) return undefined;
  const size = Number(normalized);
  return Number.isSafeInteger(size) && size >= 1 && size <= 1_000
    ? String(size)
    : undefined;
}

function isValidTransportedNativeSelectPlacement(
  namespace: HtmlMirrorNamespace,
  tagName: string,
  parent: NativeSelectParentContext,
): boolean {
  if (isNativeSelectSemanticTag(tagName) && namespace !== 'html') return false;
  if (parent === 'select') return tagName === 'option' || tagName === 'optgroup';
  if (parent === 'optgroup') return tagName === 'option';
  if (parent === 'option') return false;
  return true;
}

function nextNativeSelectParentContext(
  tagName: string,
  parent: NativeSelectParentContext,
): NativeSelectParentContext {
  if (tagName === 'select') return 'select';
  if (tagName === 'optgroup' && parent === 'select') return 'optgroup';
  if (
    tagName === 'option' &&
    (parent === 'select' || parent === 'optgroup')
  ) return 'option';
  return false;
}

function nativeSelectOptionCount(children: readonly HtmlMirrorNode[]): number {
  let count = 0;
  for (const child of children) {
    if (child.kind !== 'element') continue;
    if (child.tagName === 'option') {
      count += 1;
      continue;
    }
    if (child.tagName === 'optgroup') {
      for (const nested of child.children) {
        if (nested.kind === 'element' && nested.tagName === 'option') count += 1;
      }
    }
  }
  return count;
}

/**
 * What the mirror holds as the children of `node`: its child nodes, except
 * under a dropdown or a group whose options sit inside wrapper elements.
 * There the mirror holds the options and groups themselves, in the page's
 * order, as Chrome lists them: a dropdown in the mirror is options and groups
 * only (D135).
 */
export {
  sourceAttributeList,
  sourceChildNodeList,
  sourceLocalName,
  sourceNodeType,
} from './source-node-accessors';

export function sourceStructuralChildNodes(node: Node): Iterable<Node> {
  if (sourceNodeType(node) !== Node.ELEMENT_NODE) return node.childNodes;
  const element = node as Element;
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
    return sourceChildNodeList(node);
  }
  return readSourceSelectEntries(element) ?? sourceChildNodeList(node);
}

/** Whether the mirror holds `source` as a child of `target`; see above. */
export function isSourceStructuralChildOf(source: Node, target: Node): boolean {
  if (source.parentNode === target) return true;
  if (
    sourceNodeType(source) !== Node.ELEMENT_NODE || sourceNodeType(target) !== Node.ELEMENT_NODE
  ) return false;
  const tagName = sourceLocalName(source as Element).toLowerCase();
  return (tagName === 'option' || tagName === 'optgroup') &&
    readSourceSelectEntryOwner(source as Element) === target;
}

function isRepresentableSourceNativeSelectChild(node: Node): boolean {
  const parent = node.parentElement;
  const parentTag = parent ? sourceLocalName(parent).toLowerCase() : undefined;
  if (!parentTag || !isNativeSelectSemanticTag(parentTag)) return true;
  if (sourceNodeType(node) !== Node.ELEMENT_NODE) return false;
  const tagName = sourceLocalName(node as Element).toLowerCase();
  if (parentTag === 'select') {
    return tagName === 'option' || tagName === 'optgroup';
  }
  if (parentTag === 'optgroup') return tagName === 'option';
  return false;
}

function elementStartsActivationRegion(element: Element): boolean {
  const role = element.getAttribute('role');
  const localName = sourceLocalName(element);
  return isSourceActivationTagName(localName) ||
    (isSourceActivationRoleValue(role) &&
      !isSourceNativeSelectImplicitRole(localName, role));
}

function readTransportedControlText(
  input: unknown,
  tagName: string,
  attributes: Readonly<Record<string, string>>,
  inheritedPrivate: boolean,
  nativeSelectParent: NativeSelectParentContext,
): HtmlMirrorControlText | undefined {
  if (input === undefined) return undefined;
  if (
    inheritedPrivate ||
    !isRecord(input) ||
    !hasExactKeys(input, ['kind', 'text', 'translatable']) ||
    (input.kind !== 'value' && input.kind !== 'placeholder' &&
      input.kind !== 'label') ||
    typeof input.text !== 'string' ||
    input.text.length === 0 ||
    input.text.length > MAX_HTML_MIRROR_STRING ||
    input.translatable !== true
  ) return undefined;
  const validTarget = input.kind === 'label'
    ? (
      (tagName === 'option' &&
        (nativeSelectParent === 'select' || nativeSelectParent === 'optgroup')) ||
      (tagName === 'optgroup' && nativeSelectParent === 'select')
    ) &&
      !sourceAttributesArePrivate(attributes) &&
      !isSourceActivationRoleValue(attributes.role)
    : isEligibleSourceTextControl(tagName, attributes);
  if (!validTarget) return undefined;
  return Object.freeze({
    kind: input.kind,
    text: input.text,
    translatable: true,
  });
}

export function readHtmlMirrorSelectedOptionIndexes(
  input: unknown,
  tagName: string,
): readonly number[] | undefined {
  if (input === undefined) return undefined;
  if (
    tagName !== 'select' ||
    !Array.isArray(input) ||
    input.length > MAX_SOURCE_SELECTED_OPTION_INDEXES
  ) return undefined;
  const result: number[] = [];
  let previous = -1;
  for (const value of input) {
    if (
      !Number.isSafeInteger(value) ||
      Number(value) < 0 ||
      Number(value) >= MAX_HTML_MIRROR_NODES ||
      Number(value) <= previous
    ) return undefined;
    previous = Number(value);
    result.push(previous);
  }
  return Object.freeze(result);
}

function hasSourceEditorWithoutAttributeAncestor(element: Element): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) return false;
  const path = readSourceFlatTreeElementPath(element);
  return path?.some(sourceElementIsEditorWithoutAttribute) ?? false;
}

function hasNonContentAncestor(element: Element): boolean {
  for (let current: Element | undefined = element; current;) {
    if (NON_CONTENT_ELEMENTS.has(sourceLocalName(current).toLowerCase())) return true;
    current = composedParentElement(current);
  }
  return false;
}

function hasSourcePrivateAttributeElementAncestor(element: Element): boolean {
  const memo = ambientWithheldAncestors;
  if (memo) {
    if (SOURCE_PRIVACY_FILTERS_OFF) return false;
    if (hasSourceCredentialSecretAncestor(element)) return true;
    const path = readSourceFlatTreeElementPath(element);
    if (!path) return true;
    return memoizedPathStartsRegion(
      path,
      memo.privateAttributes,
      (current) => {
        const localName = sourceLocalName(current);
        const tagName = localName.toLowerCase();
        const role = current.getAttribute('role');
        return sourceElementStartsPrivateRegionInContext(
          localName,
          readSourceStructuralAttributes(current),
          isSourceOptionInsideNativeSelect(current),
        ) ||
          sourceElementIsEditorWithoutAttribute(current) ||
          isSourcePrivateTagName(localName) ||
          isSourceActivationTagName(localName) ||
          isSourceActivationRoleValue(role) ||
          (!isNativeSelectSemanticTag(tagName) &&
            isSourcePublicMenuRoleValue(role));
      },
    );
  }
  if (
    hasSourcePrivateOrActivationElementAncestor(element) ||
    hasSourceEditorWithoutAttributeAncestor(element)
  ) return true;
  for (let current: Element | undefined = element; current;) {
    if (
      !isNativeSelectSemanticTag(sourceLocalName(current).toLowerCase()) &&
      isSourcePublicMenuRoleValue(current.getAttribute('role'))
    ) return true;
    current = composedParentElement(current);
  }
  return false;
}

export function hasPrivateHtmlMirrorAttribute(
  tagName: string,
  attributes: readonly (readonly [string, string])[],
): boolean {
  return attributes.some(([name]) => isPrivateBaseAttribute(tagName, name));
}

function composedParentElement(element: Element): Element | undefined {
  return readSourceFlatTreeElementPath(element)?.[1];
}

function nearestElement(node: Node): Element | undefined {
  if (sourceNodeType(node) === 1) return node as Element;
  return readSourceFlatTreeElementPath(node)?.[0];
}

/**
 * With `namesOnly`, an escape that yields anything but a name character
 * decodes to `_`: an escape is always part of a name and never opens a
 * function, so Tailwind's `.bg-\[url\(\'a\.png\'\)\]` counts no `url(`
 * while `u\72l(` still does (D83).
 */
function decodeCssEscapes(value: string, namesOnly = false): string {
  return value.replace(/\\(?:\r\n|[\n\r\f])/gu, '').replace(
    /\\(?:([0-9a-fA-F]{1,6})[\t\n\f\r ]?|([^\n\r\f0-9a-fA-F]))/gu,
    (_match, hex: string | undefined, escaped: string | undefined) => {
      let decoded = escaped ?? '';
      if (hex) {
        const codePoint = Number.parseInt(hex, 16);
        decoded = codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '\uFFFD';
      }
      return namesOnly && !/^(?:[\w-]|[^\0-\x7f])/u.test(decoded)
        ? '_'
        : decoded;
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

/**
 * Colon-prefixed names are only representable in the HTML namespace, where
 * the receiver recreates them with createElement as the same inert
 * HTMLUnknownElement the source parser produced. In the SVG and MathML
 * namespaces createElementNS would read the prefix and materialize the real
 * local element (`svg:animate` -> SVGAnimateElement), bypassing every
 * tag-keyed rule, or throw on an invalid qualified name and abort the whole
 * patch. This must run before any rule keyed on the tag name.
 */
export function isRepresentableTagName(
  tagName: string,
  namespace: HtmlMirrorNamespace,
): boolean {
  return namespace === 'html' || !tagName.includes(':');
}

function isCustomElementName(value: string | null): boolean {
  return Boolean(
    value && value.length <= 128 && value.includes('-') &&
    /^[a-z][a-z0-9._-]*$/u.test(value),
  );
}

/** Hyphenated names HTML reserves for SVG and MathML. */
const RESERVED_CUSTOM_ELEMENT_NAMES = new Set([
  'annotation-xml', 'color-profile', 'font-face', 'font-face-format',
  'font-face-name', 'font-face-src', 'font-face-uri', 'missing-glyph',
]);

/** A tag name `customElements.define` accepts. */
export function isAutonomousCustomElementName(value: string): boolean {
  return isCustomElementName(value) && !RESERVED_CUSTOM_ELEMENT_NAMES.has(value);
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
  representability: HtmlMirrorRepresentabilityCollector,
): void {
  budget.nodes += 1;
  budget.bytes += bytes;
  budget.ids.add(id);
  if (
    budget.nodes > MAX_HTML_MIRROR_NODES ||
    budget.bytes > MAX_HTML_MIRROR_BYTES
  ) {
    incrementRepresentability(representability, 'capacityOmissionCount');
    throw new HtmlMirrorCapacityError(true);
  }
}

function incrementRepresentability(
  target: HtmlMirrorRepresentabilityCollector,
  key: keyof HtmlMirrorRepresentabilitySummary,
): void {
  target[key] = Math.min(
    MAX_HTML_MIRROR_DIAGNOSTIC_COUNT,
    target[key] + 1,
  );
}

function classifiedStyleOmissionCount(
  target: HtmlMirrorRepresentabilityCollector,
): number {
  return target.strippedUnsafeResourceCount +
    target.capacityOmissionCount +
    target.executionRiskBlockCount +
    target.unsupportedSchemeBlockCount +
    target.browserInaccessibleResourceCount +
    target.strictResourcePolicyBlockCount;
}

/**
 * A page size as the protocol carries it: whole pixels from 1 to 1,000,000.
 * The first copy and every later size update both use it, or a page taller
 * than the cap fails each update and is read whole again (D162).
 */
export function boundedDimension(value: number): number {
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
