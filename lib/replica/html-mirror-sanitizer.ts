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
  isEligibleSourceTextControl,
  isSourceNativeTextControlTagName,
  isSourceOptionInsideNativeSelect,
  isSourcePublicMenuRoleValue,
  isSourceSelectEntryVisuallyHidden,
  isSourceTransparentSelectClickTarget,
  readSourceFlatTreeElementPath,
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
import {
  isSourceSecretPlaceholderTagName,
  sourceSecretPlaceholderTagName,
} from './source-secret-classifier';
import { isSafeStaticSvgDataImage } from './static-svg-data-image';
import { SOURCE_PRIVACY_FILTERS_OFF } from './source-privacy-mode';
import {
  listSourceHeldAnimations,
  readSourceHeldAnimationStyle,
} from './source-held-animation';
import {
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

export class HtmlMirrorCapacityError extends Error {
  constructor(readonly diagnosticRecorded = false) {
    super('HTML mirror budget exceeded.');
    this.name = 'HtmlMirrorCapacityError';
  }
}

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

/** True only when reading this text would be admitted by the base serializer. */
export function sourceBaseTextIsPublic(
  source: Node,
  policy: SourceBaseReadPolicy,
): boolean {
  if (policy.controlledContent.incomplete) return false;
  try {
    const element = nearestElement(source);
    return !element || !hasSourceBaseWithheldAncestor(
      element,
      policy.controlledContent,
    );
  } catch {
    // A detached non-element has no element privacy boundary to inherit.
    return source.nodeType !== 1;
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

type NativeSelectParentContext = false | 'select' | 'optgroup' | 'option';

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
  'noscript',
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
  'profile',
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

function isPrivateBaseAttribute(tagName: string, name: string): boolean {
  if (SOURCE_PRIVACY_FILTERS_OFF) {
    return REPLICA_OWNED_DISCLOSURE_ATTRIBUTES.has(name);
  }
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
    const locale = root.ownerDocument?.defaultView?.getComputedStyle(root)
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
  const probe = root.ownerDocument.createElement('span');
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
    const attributes = element.attributes;
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
  select: new Set(['role']),
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
    if (sourceDocument.compatMode === 'BackCompat') return 'quirks';
    const doctype = sourceDocument.doctype;
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
    sheets = owner.adoptedStyleSheets;
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
  )?.[0];
}

/** Serializes only the supplied roots while sharing one global source budget. */
export function sanitizeSourceSubtrees(
  sources: readonly Node[],
  registry: HtmlMirrorIdRegistry,
  baseUrl = sources[0]?.ownerDocument?.baseURI ?? 'about:blank',
  representability = createHtmlMirrorRepresentabilityCollector(),
  budget = createHtmlMirrorReadBudget(),
  styleWork = createHtmlMirrorStyleWorkBudget(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  slotReadings?: SourceSlotReadings,
): readonly (HtmlMirrorNode | undefined)[] | undefined {
  try {
    const controlledContent = createSourceControlledContentPolicy(
      sources[0]?.ownerDocument,
    );
    if (controlledContent.incomplete) throw new HtmlMirrorCapacityError();
    const secretAncestors = createSourceSecretAncestorMemo();
    const slotRegions = new Map<Element, SourceSlotRegion>();
    return Object.freeze(sources.map((source) => {
      const sourceElement = nearestElement(source);
      const inheritedElement = source.nodeType === Node.ELEMENT_NODE && sourceElement
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
    const host = source.nodeType === Node.ELEMENT_NODE &&
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
        visibilityHidden: slotRegion && child.nodeType === Node.TEXT_NODE
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
    return sanitizeAttributes(
      source,
      source.localName.toLowerCase(),
      hasSourceBaseWithheldAncestor(
        source,
        controlledContent,
      ),
      hasSourceActivationElementAncestor(source),
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
  const tagName = source.localName.toLowerCase();
  const hidden = tagName === 'select'
    ? isSourceSelectVisuallyHidden(source)
    : (tagName === 'option' || tagName === 'optgroup')
      ? isSourceSelectEntryVisuallyHidden(source)
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
  const canvasBackgroundColor = tagName === 'html'
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
    !isAutonomousCustomElementName(source.localName)
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
  const documentElement = sourceDocument.documentElement;
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
    incrementRepresentability(representability, 'capacityOmissionCount');
    return undefined;
  }
  const root = serializeNode(documentElement, {
    registry,
    baseUrl: sourceDocument.baseURI,
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
    sourceDocument.baseURI,
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
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
  nativeSelectParent: NativeSelectParentContext = false,
  attributeSentinel = false,
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
      'opaquePlaceholder',
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
  if (
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
      ], ['slotAssignment']) ||
      !isNodeId(input.shadowRoot.id) ||
      input.shadowRoot.mode !== 'open' ||
      (input.shadowRoot.slotAssignment !== undefined &&
        input.shadowRoot.slotAssignment !== 'manual') ||
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
        fidelityPolicy,
        transportedNativeSelectParent,
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
    shadowRoot = Object.freeze({
      id: input.shadowRoot.id,
      mode: 'open',
      children: Object.freeze(shadowChildren),
      adoptedStyleSheets,
      ...(input.shadowRoot.slotAssignment === 'manual'
        ? { slotAssignment: 'manual' as const }
        : {}),
    });
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
): HtmlMirrorDocumentContent | undefined {
  const ids = new Set<number>();
  const budget = createHtmlMirrorReadBudget(ids);
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
  if (!isNodeId(id) || context.budget.ids.has(id)) return undefined;
  // Directly slotted Text can render inside a credential boundary that is
  // absent from its DOM-parent chain. Apply the shared Node-aware boundary
  // before evaluating nodeValue, and before an inherited hard-secret context
  // returns, so the Text identity itself becomes sticky.
  if (
    live.nodeType === Node.TEXT_NODE &&
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
    live.nodeType === Node.ELEMENT_NODE &&
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
  if (live.nodeType === Node.TEXT_NODE) {
    // Establish the structural/computed privacy boundary before touching page
    // content.  Accessors for withheld text are never evaluated. Stylesheet
    // text is presentation rather than page content, so a hidden or controlled
    // disclosure region keeps its CSS (those rules are often what hides it);
    // a privacy or menu boundary still withholds it.
    const withholdText = (context.privateRegion || context.visibilityHidden) &&
      !(context.styleRegion && !context.privacyRegion);
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
  if (live.nodeType !== Node.ELEMENT_NODE) {
    incrementRepresentability(
      context.representability,
      'unsupportedNodeOmissionCount',
    );
    return undefined;
  }
  const liveElement = live as Element;
  const tagName = liveElement.localName.toLowerCase();
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
  const children: HtmlMirrorNode[] = [];
  // Open or closed (D125). Read before the element's own children: they are
  // drawn where this root slots them, not where they sit in the page (D135).
  const sourceShadow = readSourceShadowRoot(liveElement);
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
    for (const liveChild of sourceStructuralChildNodes(liveElement)) {
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
        visibilityHidden: slotRegion && liveChild.nodeType === Node.TEXT_NODE
          ? slotRegion.visibilityHidden
          : visibilityHidden,
        depth: context.depth + 1,
      });
      if (child) children.push(child);
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
    if (!isNodeId(shadowId) || context.budget.ids.has(shadowId)) return undefined;
    admitNode(context.budget, shadowId, 32, context.representability);
    const shadowChildren: HtmlMirrorNode[] = [];
    for (const childNode of sourceShadow.childNodes) {
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
    if (!adoptedStyleSheets) return undefined;
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
    element.localName.toLowerCase() !== 'input'
  ) return undefined;
  const attributes = sanitizeAttributes(
    element,
    'input',
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
  credentialShell: boolean,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): readonly (readonly [string, string])[] | undefined {
  if (element.attributes.length > MAX_HTML_MIRROR_ATTRIBUTES) {
    incrementRepresentability(representability, 'capacityOmissionCount');
    return undefined;
  }
  const result: Array<readonly [string, string]> = [];
  // What a script animation that has ended still holds the element at is
  // drawn as if the element's own style said it, and is read with it: an
  // element that has no `style` gets one for it. Where the page has one
  // under another spelling, the held values join that one, and the name is
  // still sent once (below).
  const heldStyle = readSourceHeldAnimationStyle(element);
  const sourceAttributes: Iterable<SourceAttribute> =
    heldStyle && !element.hasAttribute('style')
      ? [...element.attributes, HELD_STYLE_ATTRIBUTE]
      : element.attributes;
  for (const attribute of sourceAttributes) {
    const xmlLanguage = isXmlNamespaceLanguage(attribute);
    const name = xmlLanguage
      ? PAGE_XML_LANGUAGE_ATTRIBUTE
      : attribute.name.toLowerCase();
    if (!xmlLanguage && isTwinOfSentName(element, attribute, name)) continue;
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
      isPrivateBaseAttribute(tagName, name) ||
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
        tagName === 'source' && element.parentElement?.localName === 'picture';
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
  if (tagName === 'html' && element === element.ownerDocument?.documentElement) {
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
      sheet.href ?? baseUrl,
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
      const importLike = /^@\s*import\b/iu.test(rule.cssText);
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
          importedSheet.href ?? baseUrl,
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
  const tagName = element.localName.toLowerCase();
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
      sheet.href ?? baseUrl,
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
  if (element.localName.toLowerCase() !== 'style') return undefined;
  const text = element.textContent ?? '';
  const Sheet = element.ownerDocument?.defaultView?.CSSStyleSheet;
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
    fidelityPolicy !== 'passive' ||
    (tagName !== 'style' && tagName !== 'link') ||
    typeof input !== 'string' ||
    input.length > MAX_HTML_MIRROR_STRING ||
    sanitizeCss(
      input,
      'about:blank',
      false,
      undefined,
      fidelityPolicy,
    ) !== input
  ) return undefined;
  budget.bytes += input.length * 2 + 24;
  return budget.bytes <= MAX_HTML_MIRROR_BYTES ? input : undefined;
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
  return rewritten === undefined || !namesScripting
    ? rewritten
    : answerCssScriptingQueries(rewritten, true);
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
    edits.push(...answers);
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
      edits.push(...block.edits);
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
    if (!('word' in token)) edits.push(...token.edits);
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
  const view = element.ownerDocument?.defaultView;
  if (
    element.localName.toLowerCase() !== 'select' ||
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
function stripCssCommentsOutsideStrings(
  css: string,
  sheet = false,
): string | undefined {
  const parts: string[] = [];
  let segmentStart = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      if (character === '\\') {
        // A backslash and the line break after it are part of the string.
        index += css[index + 1] === '\r' && css[index + 2] === '\n' ? 2 : 1;
      } else if (character === quote) {
        quote = undefined;
      } else if (
        sheet &&
        (character === '\n' || character === '\r' || character === '\f')
      ) {
        return undefined;
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
      continue;
    }
    if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close < 0) return undefined;
      parts.push(css.slice(segmentStart, index));
      index = close + 1;
      segmentStart = close + 2;
    }
  }
  if (quote) return undefined;
  parts.push(css.slice(segmentStart));
  return parts.join('');
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
    const match = /^url\s*\(/iu.exec(css.slice(index));
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

function normalizeCssUrlFunction(
  body: string,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector | undefined,
): string | undefined {
  const content = body.trim();
  let raw = content;
  const quote = content[0];
  if (quote === '"' || quote === "'") {
    const end = findCssStringEnd(content, quote);
    if (end === undefined || content.slice(end + 1).trim() !== '') {
      return undefined;
    }
    raw = content.slice(1, end);
  } else if (/["'()]/u.test(content)) {
    return undefined;
  }
  const decodedUrl = decodeCssEscapes(raw.trim());
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
      if (/^@\s*import\b/iu.test(decodedPrefix)) {
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
      !/^@\s*import\b/iu.test(decodeCssEscapes(css.slice(index, index + 128)))
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

function extractCssImportUrl(statement: string): string | undefined {
  const match = /^@\s*import\s+(?:url\(\s*(["']?)([\s\S]*?)\1\s*\)|(["'])([\s\S]*?)\3)/iu.exec(
    statement,
  );
  const value = match?.[2] ?? match?.[4];
  return value ? decodeCssEscapes(value.trim()) : undefined;
}

function normalizePassiveCssImport(
  statement: string,
  baseUrl: string,
): string | undefined {
  const match = /^@\s*import\s+(?:url\(\s*(["']?)([\s\S]*?)\1\s*\)|(["'])([\s\S]*?)\3)\s*([\s\S]*);$/iu.exec(
    statement,
  );
  if (!match) return undefined;
  const rawUrl = decodeCssEscapes((match[2] ?? match[4] ?? '').trim());
  const conditions = (match[5] ?? '').trim();
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
      const canvas = element.ownerDocument.createElement('canvas');
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
  const view = element.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return false;
  try {
    const style = view.getComputedStyle(element);
    const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`
      .trim()
      .toLowerCase();
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
      ? sourceElementScalesItselfToNothing(element)
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
        (!opened || sourceElementHidesItselfByVisibility(element))) ||
      (Number(style.opacity) === 0 &&
        !isSourceTransparentSelectClickTarget(element, view, style)) ||
      style.getPropertyValue('content-visibility').trim().toLowerCase() === 'hidden' ||
      positionedOffscreen ||
      transformCollapses ||
      (overflow.split(/\s+/u).some((value) => value === 'hidden' || value === 'clip') &&
        (width === 0 || height === 0));
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
  const view = source.ownerDocument?.defaultView;
  if (!view || typeof view.getComputedStyle !== 'function') return undefined;
  for (const candidate of [source, source.ownerDocument?.body]) {
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
  if (isPrivateBaseAttribute(tagName, name)) return true;
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
  const tagName = element.localName.toLowerCase();
  if (isUnsafeElement(tagName, fidelityPolicy)) return true;
  if (tagName !== 'video') return false;
  const poster = element.getAttribute('poster');
  return !poster || passiveUrl(poster, baseUrl, true) === undefined;
}

function elementStartsPrivateRegion(
  element: Element,
  secretAncestors?: SourceSecretAncestorMemo,
): boolean {
  if (
    hasSourceCredentialSecretAncestor(element, undefined, undefined, secretAncestors)
  ) return true;
  return sourceElementStartsPrivateRegionInContext(
    element.localName,
    readSourceStructuralAttributes(element),
    isSourceOptionInsideNativeSelect(element),
  );
}

interface SourceHiddenRegionState {
  /** The element starts a withheld region: hidden, collapsed or controlled. */
  readonly starts: boolean;
  /** Its own computed `visibility` hides its text (see SerializeContext). */
  readonly visibilityHidden: boolean;
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
    const view = element.ownerDocument.defaultView;
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
    const state = (starts: boolean): SourceHiddenRegionState =>
      Object.freeze({ starts, visibilityHidden });
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
    return state(!hasSourcePositivePaintBox(element));
  } catch {
    return SOURCE_REGION_WITHHELD;
  }
}

function elementStartsHiddenOrControlledDisclosureRegion(
  element: Element,
  controlledContent: SourceControlledContentPolicy,
): boolean {
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
 * control that acts counts for it. `undefined` for a node that is not
 * assigned to a slot: it is read as its host is, as it always was. A slot's
 * boxes are looked at once in a walk.
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
  if (!slot) return undefined;
  const kept = known.get(slot);
  if (kept) return kept;
  let region = SOURCE_SLOT_REGION_UNREADABLE;
  const path = readSourceFlatTreeElementPath(slot);
  if (path) {
    region = Object.freeze({
      withheld: path.some((current) =>
        elementStartsHiddenOrControlledDisclosureRegion(current, controlledContent)),
      // A dropdown too: what is slotted into one of its options is not
      // drawn, and nothing inside a dropdown is page text.
      privacy: path.some((current) =>
        elementStartsPrivateRegion(current, secretAncestors) ||
        current.localName.toLowerCase() === 'select'),
      activation: path.some(elementStartsActivationRegion),
      visibilityHidden:
        readSourceHiddenRegionState(slot, controlledContent).visibilityHidden,
    });
  }
  known.set(slot, region);
  return region;
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
  const visibilityHidden = child.nodeType === Node.TEXT_NODE &&
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
    !region && child.nodeType === Node.TEXT_NODE &&
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

function hasSourceWithheldAncestor(
  element: Element,
  controlledContent: SourceControlledContentPolicy | undefined,
): boolean {
  if (hasSourcePrivateElementAncestor(element)) return true;
  const path = readSourceFlatTreeElementPath(element);
  if (!path) return true;
  for (const current of path) {
    const tagName = current.localName.toLowerCase();
    if (
      tagName === 'select' ||
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
export function sourceStructuralChildNodes(node: Node): Iterable<Node> {
  if (node.nodeType !== Node.ELEMENT_NODE) return node.childNodes;
  const element = node as Element;
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') return node.childNodes;
  return readSourceSelectEntries(element) ?? node.childNodes;
}

/** Whether the mirror holds `source` as a child of `target`; see above. */
export function isSourceStructuralChildOf(source: Node, target: Node): boolean {
  if (source.parentNode === target) return true;
  if (
    source.nodeType !== Node.ELEMENT_NODE || target.nodeType !== Node.ELEMENT_NODE
  ) return false;
  const tagName = (source as Element).localName.toLowerCase();
  return (tagName === 'option' || tagName === 'optgroup') &&
    readSourceSelectEntryOwner(source as Element) === target;
}

function isRepresentableSourceNativeSelectChild(node: Node): boolean {
  const parentTag = node.parentElement?.localName.toLowerCase();
  if (!parentTag || !isNativeSelectSemanticTag(parentTag)) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const tagName = (node as Element).localName.toLowerCase();
  if (parentTag === 'select') {
    return tagName === 'option' || tagName === 'optgroup';
  }
  if (parentTag === 'optgroup') return tagName === 'option';
  return false;
}

function elementStartsActivationRegion(element: Element): boolean {
  const role = element.getAttribute('role');
  return isSourceActivationTagName(element.localName) ||
    (isSourceActivationRoleValue(role) &&
      !isSourceNativeSelectImplicitRole(element.localName, role));
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

function hasNonContentAncestor(element: Element): boolean {
  for (let current: Element | undefined = element; current;) {
    if (NON_CONTENT_ELEMENTS.has(current.localName.toLowerCase())) return true;
    current = composedParentElement(current);
  }
  return false;
}

function hasSourcePrivateAttributeElementAncestor(element: Element): boolean {
  if (hasSourcePrivateOrActivationElementAncestor(element)) return true;
  for (let current: Element | undefined = element; current;) {
    if (
      !isNativeSelectSemanticTag(current.localName.toLowerCase()) &&
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
  if (node.nodeType === 1) return node as Element;
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
