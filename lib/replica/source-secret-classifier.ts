import type { ReplicaReadScope } from './read-scope-policy';

export const SOURCE_SECRET_CLASSIFIER_VERSION = 1;

/**
 * Reserved, extension-owned element name used when a hard-secret source
 * region must retain only its mirror identity. The source node ID suffix
 * prevents captured page selectors from addressing the placeholder by its
 * original tag, id, class, attributes, or other authored selector surface.
 */
export const SOURCE_SECRET_PLACEHOLDER_TAG_PREFIX =
  'simul-opaque-region-';

export function sourceSecretPlaceholderTagName(nodeId: number): string {
  if (!Number.isSafeInteger(nodeId) || nodeId < 1) {
    throw new Error('Invalid secret placeholder identity.');
  }
  return `${SOURCE_SECRET_PLACEHOLDER_TAG_PREFIX}${nodeId.toString(36)}`;
}

export function isSourceSecretPlaceholderTagName(
  value: unknown,
  nodeId?: number,
): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith(SOURCE_SECRET_PLACEHOLDER_TAG_PREFIX)) {
    return false;
  }
  if (nodeId === undefined) {
    return /^[a-z0-9]+$/u.test(
      normalized.slice(SOURCE_SECRET_PLACEHOLDER_TAG_PREFIX.length),
    );
  }
  if (!Number.isSafeInteger(nodeId) || nodeId < 1) return false;
  return normalized === sourceSecretPlaceholderTagName(nodeId);
}

export const SOURCE_SECRET_AUTOCOMPLETE_TOKENS = Object.freeze([
  'current-password',
  'new-password',
  'one-time-code',
  'webauthn',
] as const);

/** Exact non-payment autocomplete tokens that a user may opt in to reading. */
export const SOURCE_PERSONAL_AUTOCOMPLETE_TOKENS = Object.freeze([
  'name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name',
  'honorific-suffix', 'nickname', 'username', 'email', 'organization-title',
  'organization', 'street-address', 'address-line1', 'address-line2',
  'address-line3', 'address-level4', 'address-level3', 'address-level2',
  'address-level1', 'country', 'country-name', 'postal-code', 'bday',
  'bday-day', 'bday-month', 'bday-year', 'sex', 'tel', 'tel-country-code',
  'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix',
  'tel-local-suffix', 'tel-extension',
] as const);

export type SourceEvidenceCategory =
  | 'secret'
  | 'personal'
  | 'ordinary-form'
  | 'editable'
  | 'public-semantic'
  | 'withheld';

export interface SourceClassificationFacts {
  readonly tagName: string;
  readonly type?: string;
  readonly autocomplete?: string;
  readonly role?: string;
  readonly contentEditable?: string;
  readonly computedTextSecurity?: string;
  readonly secretAncestor?: boolean;
  readonly valueBearing?: boolean;
}

const PERSONAL_AUTOCOMPLETE_SET = new Set<string>(
  SOURCE_PERSONAL_AUTOCOMPLETE_TOKENS,
);
const SECRET_AUTOCOMPLETE_SET = new Set<string>(
  SOURCE_SECRET_AUTOCOMPLETE_TOKENS,
);
const HARMLESS_AUTOCOMPLETE_TOKENS = new Set([
  'on', 'off', 'shipping', 'billing', 'home', 'work', 'mobile', 'fax',
  'pager',
]);

export function normalizeAutocompleteTokens(value: unknown): readonly string[] {
  if (typeof value !== 'string') return Object.freeze([]);
  return Object.freeze(value.trim().toLowerCase().split(/\s+/u).filter(Boolean));
}

export function sourceFactsAreSecret(
  facts: SourceClassificationFacts,
): boolean {
  const tag = normalized(facts.tagName);
  const type = normalized(facts.type);
  if (isSourceSecretPlaceholderTagName(tag)) return true;
  if (facts.secretAncestor === true) return true;
  if (tag === 'input' && (type === 'password' || type === 'hidden' || type === 'file')) {
    return true;
  }
  const textSecurity = normalized(facts.computedTextSecurity);
  if (textSecurity && textSecurity !== 'none') return true;
  return normalizeAutocompleteTokens(facts.autocomplete).some(
    (token) => SECRET_AUTOCOMPLETE_SET.has(token) || token.startsWith('cc-'),
  );
}

export function classifySourceEvidence(
  facts: SourceClassificationFacts,
): SourceEvidenceCategory {
  if (sourceFactsAreSecret(facts)) return 'secret';
  const tag = normalized(facts.tagName);
  const type = normalized(facts.type);
  const role = normalized(facts.role);
  const tokens = normalizeAutocompleteTokens(facts.autocomplete);
  if (
    (tag === 'input' && (type === 'email' || type === 'tel')) ||
    tokens.some((token) => PERSONAL_AUTOCOMPLETE_SET.has(token))
  ) return 'personal';
  if (
    tag === 'textarea' ||
    (tag === 'select' && facts.valueBearing === true) ||
    (tag === 'input' &&
      ['', 'text', 'search', 'url', 'range', 'number'].includes(type) &&
      tokens.every(isHarmlessAutocompleteToken))
  ) return 'ordinary-form';
  const contentEditable = normalized(facts.contentEditable);
  if (
    (contentEditable !== '' && contentEditable !== 'false') ||
    (tag !== 'input' && tag !== 'textarea' &&
      (role === 'textbox' || role === 'searchbox'))
  ) return 'editable';
  if (facts.valueBearing === true) return 'withheld';
  return 'public-semantic';
}

export function replicaReadScopeAdmits(
  scope: ReplicaReadScope,
  category: SourceEvidenceCategory,
): boolean {
  if (category === 'secret' || category === 'withheld') return false;
  if (category === 'ordinary-form') return scope.formValues;
  if (category === 'personal') {
    return scope.formValues && scope.personalDataValues;
  }
  if (category === 'editable') return scope.editableContent;
  return scope.controlSemantics;
}

/**
 * Keeps credential classification sticky for one source-document lifetime.
 * Callers key by the source Node without ever putting content in this ledger.
 */
export class StickySourceSecretClassifier {
  readonly #secrets = new WeakSet<object>();
  #revision = 0;

  /**
   * Monotonic, content-free proof that this document's sticky secret ledger
   * has not learned another identity since an authoritative checkpoint.
   */
  get revision(): number {
    return this.#revision;
  }

  classify(
    identity: object,
    facts: SourceClassificationFacts,
  ): SourceEvidenceCategory {
    if (this.#secrets.has(identity)) return 'secret';
    const category = classifySourceEvidence(facts);
    if (category === 'secret') {
      this.#secrets.add(identity);
      this.#revision += 1;
    }
    return category;
  }

  isSecret(identity: object): boolean {
    return this.#secrets.has(identity);
  }
}

const SOURCE_DOCUMENT_SECRET_CLASSIFIER_KEY = Symbol.for(
  'simul.source-document-secret-classifiers.v1',
);
const FALLBACK_SOURCE_DOCUMENT_SECRET_CLASSIFIERS = new WeakMap<
  object,
  StickySourceSecretClassifier
>();

/**
 * Returns the one credential ledger owned by a source-document lifetime.
 * Every source-reading channel in the same injected bridge must use this
 * instance so reconnecting a Port can never erase a prior secret decision.
 */
export function sourceDocumentSecretClassifier(
  sourceDocument: object,
): StickySourceSecretClassifier {
  const registry = sharedSourceDocumentSecretClassifierRegistry();
  const existing = registry.get(sourceDocument);
  if (existing) return existing;
  const created = new StickySourceSecretClassifier();
  registry.set(sourceDocument, created);
  return created;
}

function sharedSourceDocumentSecretClassifierRegistry(): WeakMap<
  object,
  StickySourceSecretClassifier
> {
  try {
    const carrier = globalThis as unknown as Record<PropertyKey, unknown>;
    const existing = carrier[SOURCE_DOCUMENT_SECRET_CLASSIFIER_KEY];
    if (existing instanceof WeakMap) {
      return existing as WeakMap<object, StickySourceSecretClassifier>;
    }
    const created = new WeakMap<object, StickySourceSecretClassifier>();
    Object.defineProperty(carrier, SOURCE_DOCUMENT_SECRET_CLASSIFIER_KEY, {
      value: created,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return created;
  } catch {
    return FALLBACK_SOURCE_DOCUMENT_SECRET_CLASSIFIERS;
  }
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isHarmlessAutocompleteToken(token: string): boolean {
  return HARMLESS_AUTOCOMPLETE_TOKENS.has(token) ||
    (token.startsWith('section-') && token.length > 'section-'.length);
}
