import {
  MAX_SOURCE_SELECTED_OPTION_INDEXES,
  hasSourceActivationElementAncestor,
  hasSourcePrivateElementAncestor,
  hasSourcePrivateOrActivationElementAncestor,
  isSourceActivationRoleValue,
  isSourceActivationTagName,
  isSourcePrivateRoleValue,
  isEligibleSourceTextControl,
  isSourceNativeTextControlTagName,
  isSourceOptionInsideNativeSelect,
  isSourcePublicMenuRoleValue,
  isSourceSelectEntryVisuallyHidden,
  readSourceControlText,
  readSourceSelectLabel,
  readSourceSelectPickerOpen,
  readSourceSelectedOptionIndexes,
  sourceAttributesArePrivate,
  sourceElementStartsPrivateRegionInContext,
  type SourceControlText,
} from './source-privacy-policy';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';

export const MAX_HTML_MIRROR_BYTES = 8 * 1024 * 1024;
export const MAX_HTML_MIRROR_NODES = 50_000;
export const MAX_HTML_MIRROR_DEPTH = 64;
export const MAX_HTML_MIRROR_STRING = 512 * 1024;
export const MAX_HTML_MIRROR_ATTRIBUTES = 512;
export const MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS = 4_096;
export const MAX_HTML_MIRROR_ADOPTED_STYLE_RULES = 100_000;
export const MAX_HTML_MIRROR_DIAGNOSTIC_COUNT = 1_000_000;
const MAX_ADOPTED_STYLE_SHEETS_PER_OWNER = 256;
const MAX_ADOPTED_STYLE_RULES_PER_OWNER = 20_000;
const MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER = MAX_HTML_MIRROR_STRING;
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
  readonly shadowRoot?: HtmlMirrorShadowRoot;
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
}

export interface HtmlMirrorControlText extends SourceControlText {
  readonly translatable: true;
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
  readonly documentMode: 'standards' | 'quirks';
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
  styleSheets: number;
  styleRules: number;
  readonly ids: Set<number>;
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
  readonly privateAttributeRegion: boolean;
  readonly publicMenuRegion: boolean;
  readonly activationRegion: boolean;
  readonly nonContentRegion: boolean;
  readonly styleRegion: boolean;
  readonly depth: number;
  readonly representability: HtmlMirrorRepresentabilityCollector;
  readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
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
const PUBLIC_MENU_RESOURCE_ATTRIBUTES = new Set([
  'alt',
  'background',
  'href',
  'imagesizes',
  'imagesrcset',
  'poster',
  'src',
  'srcset',
  'style',
  'xlink:href',
]);
const PUBLIC_MENU_RICH_RESOURCE_ELEMENTS = new Set([
  'audio',
  'canvas',
  'img',
  'picture',
  'source',
  'video',
]);

const RAW_CONTROL_TEXT_ATTRIBUTES = new Set(['placeholder', 'value']);
const NATIVE_SELECT_PRESENTATION_ATTRIBUTES = Object.freeze({
  select: new Set(['disabled', 'multiple', 'role']),
  option: new Set(['disabled', 'role']),
  optgroup: new Set(['disabled', 'role']),
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
    length > MAX_ADOPTED_STYLE_SHEETS_PER_OWNER ||
    work.sheets + length > work.maxSheets
  ) {
    work.exhausted = true;
    incrementRepresentability(representability, 'capacityOmissionCount');
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
    if (
      work.rules + cached.ruleCount > work.maxRules ||
      work.characters + cached.cssText.length > work.maxCharacters ||
      work.rules - startingRules + cached.ruleCount >
        MAX_ADOPTED_STYLE_RULES_PER_OWNER ||
      work.characters - startingCharacters + cached.cssText.length >
        MAX_ADOPTED_STYLE_CHARACTERS_PER_OWNER
    ) {
      work.exhausted = true;
      incrementRepresentability(representability, 'capacityOmissionCount');
      return undefined;
    }
    work.rules += cached.ruleCount;
    work.characters += cached.cssText.length;
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
): HtmlMirrorNode | undefined {
  return sanitizeSourceSubtrees(
    [source],
    registry,
    baseUrl,
    representability,
    undefined,
    undefined,
    fidelityPolicy,
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
): readonly (HtmlMirrorNode | undefined)[] | undefined {
  try {
    return Object.freeze(sources.map((source) => {
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
          ? hasSourcePrivateAttributeElementAncestor(inheritedElement)
          : false,
        publicMenuRegion: inheritedElement
          ? hasSourcePublicMenuElementAncestor(inheritedElement)
          : false,
        activationRegion: inheritedElement
          ? hasSourceActivationElementAncestor(inheritedElement)
          : false,
        nonContentRegion: inheritedElement
          ? hasNonContentAncestor(inheritedElement)
          : false,
        styleRegion: Boolean(sourceElement?.closest('style')),
        depth: 0,
        representability,
        fidelityPolicy,
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
): readonly HtmlMirrorNode[] | undefined {
  try {
    const budget = sharedBudget ?? createHtmlMirrorReadBudget();
    const styleWork = sharedStyleWork ?? createHtmlMirrorStyleWorkBudget();
    const result: HtmlMirrorNode[] = [];
    const parentElement = nearestElement(source);
    const privateRegion = parentElement
      ? hasSourcePrivateElementAncestor(parentElement)
      : false;
    const privateAttributeRegion = parentElement
      ? hasSourcePrivateAttributeElementAncestor(parentElement)
      : false;
    const publicMenuRegion = parentElement
      ? hasSourcePublicMenuElementAncestor(parentElement)
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
        publicMenuRegion,
        activationRegion,
        nonContentRegion,
        styleRegion,
        depth: 0,
        representability,
        fidelityPolicy,
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
): readonly (readonly [string, string])[] | undefined {
  try {
    if (isUnsafeSourceElement(source, fidelityPolicy, baseUrl)) return undefined;
    return sanitizeAttributes(
      source,
      source.localName.toLowerCase(),
      hasSourcePrivateElementAncestor(source),
      hasSourceActivationElementAncestor(source),
      hasSourcePrivateAttributeElementAncestor(source),
      hasSourcePublicMenuElementAncestor(source),
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
): HtmlMirrorElementHints {
  const tagName = source.localName.toLowerCase();
  const visuallyHidden = tagName === 'select'
    ? isSourceSelectVisuallyHidden(source)
    : (tagName === 'option' || tagName === 'optgroup')
      ? isSourceSelectEntryVisuallyHidden(source)
      : isCanonicalClippedSourceElement(source);
  const selectedImageSource = tagName === 'img'
    && !hasSourcePublicMenuElementAncestor(source)
    ? selectedSourceFor(source, baseUrl)
    : undefined;
  const canvasBackgroundColor = tagName === 'html'
    ? readSourceCanvasBackgroundColor(source)
    : undefined;
  const resolvedStyleSheetText = fidelityPolicy === 'passive'
      && !hasSourcePublicMenuElementAncestor(source)
    ? readResolvedElementStyleSheet(
        source,
        baseUrl,
        representability,
        fidelityPolicy,
        styleWork,
      )
    : undefined;
  const controlParent = composedParentElement(source);
  const selectedOptionIndexes = tagName === 'select' &&
      (!controlParent || !hasSourcePrivateOrActivationElementAncestor(controlParent))
    ? readSourceSelectedOptionIndexes(source)
    : undefined;
  const selectPickerOpen = tagName === 'select' &&
      (!controlParent || !hasSourcePrivateOrActivationElementAncestor(controlParent))
    ? readSourceSelectPickerOpen(source)
    : undefined;
  const selectPresentationStyle = tagName === 'select'
    ? readSourceSelectPresentationStyle(source, fidelityPolicy)
    : undefined;
  const sourceControlText = controlParent &&
      hasSourcePrivateOrActivationElementAncestor(controlParent)
    ? undefined
    : readSourceControlText(source) ?? readSourceSelectLabel(source);
  let controlText: HtmlMirrorControlText | undefined;
  if (
    sourceControlText &&
    sourceControlText.text.length > MAX_HTML_MIRROR_STRING
  ) {
    if (representability) {
      incrementRepresentability(representability, 'capacityOmissionCount');
    }
  } else if (sourceControlText) {
    controlText = Object.freeze({
      ...sourceControlText,
      translatable: true as const,
    });
  }
  return Object.freeze({
    ...(visuallyHidden ? { visuallyHidden: true as const } : {}),
    ...(selectedImageSource ? { selectedImageSource } : {}),
    ...(selectedOptionIndexes !== undefined ? { selectedOptionIndexes } : {}),
    ...(selectPickerOpen ? { selectPickerOpen: true as const } : {}),
    ...(selectPresentationStyle ? { selectPresentationStyle } : {}),
    ...(controlText ? { controlText } : {}),
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
    ...(resolvedStyleSheetText !== undefined
      ? { resolvedStyleSheetText }
      : {}),
  });
}

export function sanitizeSourceDocument(
  sourceDocument: Document,
  sourceWindow: Window,
  registry: HtmlMirrorIdRegistry,
  representability = createHtmlMirrorRepresentabilityCollector(),
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
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
    publicMenuRegion: false,
    activationRegion: false,
    nonContentRegion: false,
    styleRegion: false,
    depth: 0,
    representability,
    fidelityPolicy,
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
    documentMode: sourceDocument.compatMode === 'BackCompat'
      ? 'quirks'
      : 'standards',
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
  publicMenuRegion = false,
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
      'canvasBackgroundColor', 'resolvedStyleSheetText', 'shadowRoot',
    ]) ||
    !isNamespace(input.namespace) ||
    !isSafeTagName(input.tagName) ||
    isUnsafeElement(input.tagName, fidelityPolicy) ||
    !Array.isArray(input.attributes) ||
    input.attributes.length > MAX_HTML_MIRROR_ATTRIBUTES ||
    !Array.isArray(input.children)
  ) return undefined;
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
    (input.selectPickerOpen !== undefined &&
      (input.selectPickerOpen !== true || input.tagName !== 'select')) ||
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
  if (
    input.selectedOptionIndexes !== undefined &&
    selectedOptionIndexes === undefined
  ) return undefined;
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
  const currentPrivateRegion = sourceElementStartsPrivateRegionInContext(
    input.tagName,
    attributeValues,
    nativeSelectParent === 'select' || nativeSelectParent === 'optgroup',
  );
  const transportedPrivateRegion = privateRegion || currentPrivateRegion;
  const transportedActivationElement =
    isSourceActivationTagName(input.tagName) ||
    isSourceActivationRoleValue(attributeValues.role);
  const transportedActivationRegion = activationRegion ||
    transportedActivationElement;
  const transportedPrivateAttributeRegion = privateAttributeRegion ||
    transportedPrivateRegion || transportedActivationElement ||
    (!isNativeSelectSemanticTag(input.tagName) &&
      isSourcePublicMenuRoleValue(attributeValues.role));
  const transportedPublicMenuRegion = publicMenuRegion ||
    (!isNativeSelectSemanticTag(input.tagName) &&
      isSourcePublicMenuRoleValue(attributeValues.role));
  const transportedNonContentRegion = nonContentRegion ||
    NON_CONTENT_ELEMENTS.has(input.tagName);
  const transportedStyleRegion = styleRegion || input.tagName === 'style';
  const transportedNativeSelectParent = nextNativeSelectParentContext(
    input.tagName,
    nativeSelectParent,
  );
  if (
    transportedPublicMenuRegion &&
    (
      input.tagName === 'link' || input.tagName === 'style' ||
      hasPublicMenuResourceAttribute(attributes) ||
      input.selectedImageSource !== undefined ||
      input.resolvedStyleSheetText !== undefined ||
      input.canvasBackgroundColor !== undefined ||
      (input.shadowRoot !== undefined &&
        isRecord(input.shadowRoot) &&
        Array.isArray(input.shadowRoot.adoptedStyleSheets) &&
        input.shadowRoot.adoptedStyleSheets.length > 0)
    )
  ) return undefined;
  if (
    input.tagName === 'select' &&
    !attributeSentinel &&
    !transportedPrivateAttributeRegion &&
    selectedOptionIndexes === undefined
  ) return undefined;
  const controlText = readTransportedControlText(
    input.controlText,
    input.tagName,
    attributeValues,
    transportedPrivateAttributeRegion || transportedNonContentRegion,
    nativeSelectParent,
  );
  if (input.controlText !== undefined && !controlText) return undefined;
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
    hasPrivateHtmlMirrorAttribute(attributes)
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
      transportedPublicMenuRegion,
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
        fidelityPolicy,
        transportedNativeSelectParent,
        false,
        transportedPublicMenuRegion,
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
    ...(selectedOptionIndexes !== undefined ? { selectedOptionIndexes } : {}),
    ...(input.selectPickerOpen === true ? { selectPickerOpen: true as const } : {}),
    ...(selectPresentationStyle ? { selectPresentationStyle } : {}),
    ...(controlText ? { controlText } : {}),
    ...(canvasBackgroundColor ? { canvasBackgroundColor } : {}),
    ...(resolvedStyleSheetText !== undefined
      ? { resolvedStyleSheetText }
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
  if (live.nodeType === Node.TEXT_NODE) {
    const rawText = live.nodeValue ?? '';
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
    const text = context.privateRegion ? '' : styledText;
    if (context.privateRegion && rawText.length > 0) {
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
  const customElementHost = namespace === 'html' && (
    tagName.includes('-') ||
    isCustomElementName(liveElement.getAttribute('is'))
  );
  if (customElementHost) {
    incrementRepresentability(context.representability, 'customElementHostCount');
  }
  const privateRegion = context.privateRegion || elementStartsPrivateRegion(liveElement);
  const activationRegion = context.activationRegion ||
    elementStartsActivationRegion(liveElement);
  const privateAttributeRegion = context.privateAttributeRegion ||
    privateRegion ||
    activationRegion ||
    (!isNativeSelectSemanticTag(tagName) &&
      isSourcePublicMenuRoleValue(liveElement.getAttribute('role')));
  const publicMenuRegion = context.publicMenuRegion ||
    (!isNativeSelectSemanticTag(tagName) &&
      isSourcePublicMenuRoleValue(liveElement.getAttribute('role')));
  if (
    publicMenuRegion &&
    (
      tagName === 'link' || tagName === 'style' ||
      PUBLIC_MENU_RICH_RESOURCE_ELEMENTS.has(tagName)
    )
  ) {
    incrementRepresentability(
      context.representability,
      'strictResourcePolicyBlockCount',
    );
    return undefined;
  }
  const nonContentRegion = context.nonContentRegion || NON_CONTENT_ELEMENTS.has(tagName);
  const styleRegion = context.styleRegion || tagName === 'style';
  const attributes = sanitizeAttributes(
    liveElement,
    tagName,
    privateRegion,
    activationRegion,
    privateAttributeRegion,
    publicMenuRegion,
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
  );
  if (
    tagName === 'select' &&
    !privateAttributeRegion &&
    hints.selectedOptionIndexes === undefined
  ) {
    incrementRepresentability(context.representability, 'capacityOmissionCount');
    return undefined;
  }
  admitNode(
    context.budget,
    id,
    tagName.length * 2 + attributes.reduce(
      (total, [name, value]) => total + (name.length + value.length) * 2 + 8,
      64,
    ) + (hints.selectedImageSource?.length ?? 0) * 2 +
      (hints.selectedOptionIndexes?.length ?? 0) * 8 +
      (hints.selectPresentationStyle?.length ?? 0) * 2 +
      (hints.controlText?.text.length ?? 0) * 2 +
      (hints.canvasBackgroundColor?.length ?? 0) * 2 +
      (hints.resolvedStyleSheetText?.length ?? 0) * 2,
    context.representability,
  );
  const children: HtmlMirrorNode[] = [];
  if (!isVoidElement(tagName) && !isSourceNativeTextControlTagName(tagName)) {
    const childRepresentability = tagName === 'style' &&
        hints.resolvedStyleSheetText !== undefined
      ? createHtmlMirrorRepresentabilityCollector()
      : context.representability;
    const childFidelityPolicy = tagName === 'style' && context.styleWork.exhausted
      ? 'conservative'
      : context.fidelityPolicy;
    for (const liveChild of live.childNodes) {
      const child = serializeNode(liveChild, {
        ...context,
        representability: childRepresentability,
        fidelityPolicy: childFidelityPolicy,
        privateRegion,
        privateAttributeRegion,
        publicMenuRegion,
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
  if (customElementHost && sourceShadow?.mode !== 'open') {
    incrementRepresentability(
      context.representability,
      'customElementHostWithoutAccessibleOpenRootCount',
    );
  }
  if (sourceShadow?.mode === 'open') {
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
        privateAttributeRegion,
        publicMenuRegion,
        activationRegion,
        nonContentRegion,
        styleRegion,
        depth: context.depth + 1,
      });
      if (child) shadowChildren.push(child);
    }
    const adoptedStyleSheets = publicMenuRegion
      ? Object.freeze([])
      : captureAdoptedStyleSheets(
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
  inheritedPrivateAttributes: boolean,
  publicMenuRegion: boolean,
  baseUrl: string,
  representability: HtmlMirrorRepresentabilityCollector,
  fidelityPolicy: SelectableReplicaFidelityPolicy,
): readonly (readonly [string, string])[] | undefined {
  if (element.attributes.length > MAX_HTML_MIRROR_ATTRIBUTES) {
    incrementRepresentability(representability, 'capacityOmissionCount');
    return undefined;
  }
  const result: Array<readonly [string, string]> = [];
  const privateAttributes = inheritedPrivateAttributes ||
    privateRegion || activationRegion ||
    isSourceNativeTextControlTagName(tagName) ||
    isSourceActivationTagName(tagName) ||
    isSourceActivationRoleValue(element.getAttribute('role')) ||
    (!isNativeSelectSemanticTag(tagName) &&
      isSourcePublicMenuRoleValue(element.getAttribute('role')));
  for (const attribute of element.attributes) {
    const name = attribute.name.toLowerCase();
    const localSvgReference = isLocalSvgReference(
      element,
      tagName,
      name,
      attribute.value,
    );
    const passiveSvgReference = fidelityPolicy === 'passive' &&
      isPassiveSvgVisualReference(element, tagName, name, attribute.value);
    const passivePoster = fidelityPolicy === 'passive' &&
      tagName === 'video' && name === 'poster';
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
      (isNativeSelectSemanticTag(tagName) &&
        !isNativeSelectPresentationAttribute(tagName, name)) ||
      ((tagName === 'option' || tagName === 'optgroup') && name === 'style') ||
      (isNativeSelectSemanticTag(tagName) &&
        (privateRegion || activationRegion) && name === 'label') ||
      (ACTIVE_OR_NAVIGATIONAL_ATTRIBUTES.has(name) &&
        !localSvgReference && !passiveSvgReference && !passivePoster) ||
      (tagName === 'video' && MEDIA_ACTIVE_ATTRIBUTES.has(name)) ||
      (isSourceNativeTextControlTagName(tagName) &&
        RAW_CONTROL_TEXT_ATTRIBUTES.has(name)) ||
      (privateAttributes &&
        (PRIVATE_ATTRIBUTES.has(name) || name.startsWith('data-'))) ||
      (publicMenuRegion && publicMenuResourceAttribute(name, attribute.value))
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
    if (name === 'alt' && privateRegion) {
      incrementRepresentability(representability, 'strippedActiveAttributeCount');
      continue;
    }
    let value = attribute.value;
    if (
      isNativeSelectSemanticTag(tagName) &&
      (name === 'disabled' || name === 'multiple')
    ) value = '';
    if (isNativeSelectSemanticTag(tagName) && name === 'role') {
      if (isSourcePrivateRoleValue(value)) value = 'combobox';
      else if (isSourceActivationRoleValue(value)) value = 'button';
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
      const style = tagName === 'select'
        ? sanitizeNativeSelectStyle(
            value,
            baseUrl,
            representability,
            fidelityPolicy,
          )
        : sanitizeCss(
            value,
            baseUrl,
            true,
            representability,
            fidelityPolicy,
          );
      if (style === undefined) {
        if (
          classifiedStyleOmissionCount(representability) === classifiedBefore
        ) {
          incrementRepresentability(representability, 'unreadableStyleCount');
        }
        continue;
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
    } else if (name === 'http-equiv' || name === 'content') {
      if (tagName === 'meta') continue;
    }
    result.push(Object.freeze([name, value] as const));
  }
  if (
    (tagName === 'link' || tagName === 'style') &&
    !result.some(([name]) => name === 'disabled') &&
    sourceStyleSheetDisabled(element)
  ) {
    result.unshift(Object.freeze(['disabled', ''] as const));
  }
  if (
    tagName === 'form' &&
    !result.some(([name]) => name === 'inert')
  ) {
    result.push(Object.freeze(['inert', ''] as const));
  }
  return Object.freeze(result);
}

function publicMenuResourceAttribute(name: string, value: string): boolean {
  return PUBLIC_MENU_RESOURCE_ATTRIBUTES.has(name) ||
    /(?:https?|blob|data|file|javascript)\s*:|(?:url|image-set)\s*\(/iu.test(
      decodeCssEscapes(value),
    );
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
  };
}

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
  if (budget.styleSheets + styles.length > MAX_HTML_MIRROR_ADOPTED_STYLE_SHEETS) {
    incrementRepresentability(representability, 'capacityOmissionCount');
    return undefined;
  }
  budget.styleSheets += styles.length;
  for (const cssText of styles) {
    const styleRules = countCssRuleBlocks(cssText);
    if (budget.styleRules + styleRules > MAX_HTML_MIRROR_ADOPTED_STYLE_RULES) {
      incrementRepresentability(representability, 'capacityOmissionCount');
      return undefined;
    }
    budget.styleRules += styleRules;
    budget.bytes += cssText.length * 2 + 16;
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
      sanitizeCss(
        cssText,
        'about:blank',
        false,
        undefined,
        fidelityPolicy,
      ) !== cssText
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
  const commentless = stripCssCommentsOutsideStrings(css);
  if (commentless === undefined) return undefined;
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
  const decodedWithoutImports = decodeCssEscapes(literalExecutableWithoutImports);
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
  const decodedNormalizedCss = decodeCssEscapes(literalExecutableNormalizedCss);
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
  return rewriteCssUrlsOutsideStrings(
    normalizedImageSets,
    baseUrl,
    representability,
  );
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

export function readSourceSelectPresentationStyle(
  element: Element,
  fidelityPolicy: SelectableReplicaFidelityPolicy = 'conservative',
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
      const value = computed.getPropertyValue(property).trim();
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

function stripCssCommentsOutsideStrings(css: string): string | undefined {
  let output = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      output += character;
      if (character === '\\' && index + 1 < css.length) {
        output += css[index + 1]!;
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close < 0) return undefined;
      index = close + 1;
      continue;
    }
    output += character;
  }
  return quote ? undefined : output;
}

function cssExecutableProjection(css: string): string {
  let output = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]!;
    if (quote) {
      output += ' ';
      if (character === '\\' && index + 1 < css.length) {
        output += ' ';
        index += 1;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += ' ';
    } else {
      output += character;
    }
  }
  return output;
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
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const match = /^(?:-webkit-)?image-set\s*\(/iu.exec(css.slice(index));
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
    if (character === '"' || character === "'") quote = character;
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
    if (character === '"' || character === "'") quote = character;
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
        onStrip?.();
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

/** Retains only canonical passive HTTP(S) imports under Passive Fidelity. */
function rewritePassiveCssImports(
  css: string,
  baseUrl: string,
  representability?: HtmlMirrorRepresentabilityCollector,
): string | undefined {
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
    if (
      character !== '@' ||
      !/^@\s*import\b/iu.test(decodeCssEscapes(css.slice(index, index + 128)))
    ) {
      output += character;
      index += 1;
      continue;
    }

    const start = index;
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
      output += normalized;
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
  }
  return output;
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

export function isSourceSelectVisuallyHidden(element: Element): boolean {
  return isSourceSelectEntryVisuallyHidden(element) ||
    isCanonicalClippedSourceElement(element) ||
    isComputedHiddenSourceSelect(element);
}

function isComputedHiddenSourceSelect(element: Element): boolean {
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
    const transformCollapses = transform !== '' && transform !== 'none' && (() => {
      try {
        const rect = element.getBoundingClientRect();
        return rect.width <= 0 || rect.height <= 0;
      } catch {
        return /(?:scale(?:3d|x|y)?\([^)]*\b0(?:[),]|\s))/u.test(transform);
      }
    })();
    return style.display.trim().toLowerCase() === 'none' ||
      ['hidden', 'collapse'].includes(style.visibility.trim().toLowerCase()) ||
      Number(style.opacity) === 0 ||
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
  if (
    isNativeSelectSemanticTag(tagName) &&
    !isNativeSelectPresentationAttribute(tagName, name)
  ) return true;
  if (
    isNativeSelectSemanticTag(tagName) &&
    (
      ((name === 'disabled' || name === 'multiple') && value !== '') ||
      (name === 'role' && value !== 'combobox' && value !== 'button')
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
      RAW_CONTROL_TEXT_ATTRIBUTES.has(name))
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

function elementStartsPrivateRegion(element: Element): boolean {
  return sourceElementStartsPrivateRegionInContext(
    element.localName,
    Object.fromEntries([...element.attributes].map(
      ({ name, value }) => [name.toLowerCase(), value],
    )),
    isSourceOptionInsideNativeSelect(element),
  );
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
      count += child.children.filter(
        (nested) => nested.kind === 'element' && nested.tagName === 'option',
      ).length;
    }
  }
  return count;
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
  return isSourceActivationTagName(element.localName) ||
    isSourceActivationRoleValue(element.getAttribute('role'));
}

const STATIC_SVG_ELEMENTS = new Set([
  'circle',
  'clippath',
  'defs',
  'ellipse',
  'feblend',
  'fecolormatrix',
  'fecomposite',
  'fedropshadow',
  'feflood',
  'fegaussianblur',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fetile',
  'feturbulence',
  'filter',
  'g',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialgradient',
  'rect',
  'stop',
  'svg',
  'symbol',
  'use',
]);

const STATIC_SVG_ATTRIBUTES = new Set([
  'aria-hidden',
  'basefrequency',
  'class',
  'clip-path',
  'clip-rule',
  'clippathunits',
  'color-interpolation-filters',
  'cx',
  'cy',
  'd',
  'dx',
  'dy',
  'edgemode',
  'fill',
  'fill-opacity',
  'fill-rule',
  'focusable',
  'filter',
  'filterunits',
  'flood-color',
  'flood-opacity',
  'fx',
  'fy',
  'gradienttransform',
  'gradientunits',
  'height',
  'href',
  'id',
  'in',
  'in2',
  'k1',
  'k2',
  'k3',
  'k4',
  'linecap',
  'linejoin',
  'marker-end',
  'marker-mid',
  'marker-start',
  'markerheight',
  'markerunits',
  'markerwidth',
  'mask',
  'maskcontentunits',
  'maskunits',
  'mode',
  'numoctaves',
  'offset',
  'opacity',
  'operator',
  'orient',
  'patterncontentunits',
  'patterntransform',
  'patternunits',
  'points',
  'preserveaspectratio',
  'primitiveunits',
  'r',
  'radius',
  'refx',
  'refy',
  'result',
  'role',
  'rx',
  'ry',
  'scale',
  'seed',
  'stddeviation',
  'stitchtiles',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'transform',
  'type',
  'values',
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
  'xchannelselector',
  'ychannelselector',
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
    /(?:<!|<\?|&|javascript\s*:|data\s*:)/iu.test(xml)
  ) return false;

  const stack: string[] = [];
  let rootSeen = false;
  let elementCount = 0;
  let filterPrimitiveCount = 0;
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
    elementCount += 1;
    if (elementCount > 512) return false;
    if (tagName.startsWith('fe')) {
      filterPrimitiveCount += 1;
      if (filterPrimitiveCount > 64) return false;
    }
    if (!readSafeStaticSvgAttributes(attributeText, tagName)) return false;
    if (!selfClosing) {
      if (stack.length >= MAX_HTML_MIRROR_DEPTH) return false;
      stack.push(tagName);
    }
  }
  return rootSeen && stack.length === 0 && xml.slice(offset).trim() === '';
}

function readSafeStaticSvgAttributes(
  source: string,
  tagName: string,
): boolean {
  const root = tagName === 'svg';
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
      !isBoundedStaticSvgAttribute(name, decodedValue) ||
      (name === 'xmlns'
        ? !root || value !== 'http://www.w3.org/2000/svg'
        : name === 'href'
          ? !LOCAL_SVG_FRAGMENT_PATTERN.test(decodedValue)
          : /\burl\s*\(/iu.test(decodedValue)
            ? !/^url\(\s*["']?#[A-Za-z0-9_.:-]{1,256}["']?\s*\)$/u.test(
                decodedValue,
              )
            : /(?:javascript\s*:|https?\s*:|data\s*:)/iu.test(decodedValue))
    ) return false;
    seen.add(name);
    offset += attribute[0].length;
  }
  return true;
}

const STATIC_SVG_DIMENSION_ATTRIBUTES = new Set([
  'height', 'markerheight', 'markerwidth', 'width',
]);

function isBoundedStaticSvgAttribute(name: string, value: string): boolean {
  const normalized = value.trim();
  if (name === 'viewbox') {
    const values = readStaticSvgNumbers(normalized, 4);
    return Boolean(
      values && values.length === 4 &&
      Math.abs(values[0]!) <= 1_000_000 &&
      Math.abs(values[1]!) <= 1_000_000 &&
      values[2]! >= 0 && values[2]! <= 1_000_000 &&
      values[3]! >= 0 && values[3]! <= 1_000_000,
    );
  }
  if (STATIC_SVG_DIMENSION_ATTRIBUTES.has(name)) {
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(%|px|pt|pc|cm|mm|in|em|ex|rem|ch|vw|vh|vmin|vmax)?$/iu.exec(
      normalized,
    );
    if (!match) return false;
    const numeric = Number(match[1]);
    const maximum = match[2] === '%' ? 10_000 : 32_768;
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= maximum;
  }
  if (name === 'numoctaves') {
    const numeric = Number(normalized);
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 8;
  }
  if (name === 'basefrequency') {
    const values = readStaticSvgNumbers(normalized, 2);
    return Boolean(values && values.length >= 1 && values.every(
      (numeric) => numeric >= 0 && numeric <= 16,
    ));
  }
  if (name === 'stddeviation' || name === 'radius') {
    const values = readStaticSvgNumbers(normalized, 2);
    return Boolean(values && values.length >= 1 && values.every(
      (numeric) => numeric >= 0 && numeric <= 1_024,
    ));
  }
  if (name === 'scale' || name === 'surfacescale') {
    const numeric = Number(normalized);
    return Number.isFinite(numeric) && Math.abs(numeric) <= 1_024;
  }
  if (name === 'seed') {
    const numeric = Number(normalized);
    return Number.isSafeInteger(numeric) && Math.abs(numeric) <= 1_000_000;
  }
  return true;
}

function readStaticSvgNumbers(
  value: string,
  maximumCount: number,
): readonly number[] | undefined {
  const parts = value.split(/[\s,]+/u).filter(Boolean);
  if (parts.length < 1 || parts.length > maximumCount) return undefined;
  const numbers = parts.map(Number);
  return numbers.every(Number.isFinite) ? numbers : undefined;
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

function hasSourcePublicMenuElementAncestor(element: Element): boolean {
  for (let current: Element | undefined = element; current;) {
    if (
      !isNativeSelectSemanticTag(current.localName.toLowerCase()) &&
      isSourcePublicMenuRoleValue(current.getAttribute('role'))
    ) return true;
    current = composedParentElement(current);
  }
  return false;
}

export function hasPublicMenuResourceAttribute(
  attributes: readonly (readonly [string, string])[],
): boolean {
  return attributes.some(([name, value]) =>
    publicMenuResourceAttribute(name, value));
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
  return value.replace(/\\(?:\r\n|[\n\r\f])/gu, '').replace(
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

function isCustomElementName(value: string | null): boolean {
  return Boolean(
    value && value.length <= 128 && value.includes('-') &&
    /^[a-z][a-z0-9._-]*$/u.test(value),
  );
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
