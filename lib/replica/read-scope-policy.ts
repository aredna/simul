/**
 * Runtime-readable evidence capabilities.  This policy never controls replica
 * actions: navigation, form submission and source event forwarding remain
 * permanently unavailable in the renderer/sanitizer boundary.
 */
export const REPLICA_READ_SCOPE_KEYS = Object.freeze([
  'controlSemantics',
  'controlImages',
  'disclosureContent',
  'formValues',
  'personalDataValues',
  'editableContent',
] as const);

export type ReplicaReadScopeKey = (typeof REPLICA_READ_SCOPE_KEYS)[number];

export interface ReplicaReadScope {
  readonly controlSemantics: boolean;
  readonly controlImages: boolean;
  readonly disclosureContent: boolean;
  readonly formValues: boolean;
  readonly personalDataValues: boolean;
  readonly editableContent: boolean;
}

export const REPLICA_READ_SCOPE_SETUP_VERSION = 1;
export const REPLICA_READ_SCOPE_SCHEMA_VERSION = 1;

export const REPLICA_READ_SCOPE_PROFILE_IDS = Object.freeze([
  'page-only',
  'standard',
  'full-visible',
] as const);

export type ReplicaReadScopeProfileId =
  (typeof REPLICA_READ_SCOPE_PROFILE_IDS)[number];
export type DerivedReplicaReadScopeProfileId =
  | ReplicaReadScopeProfileId
  | 'custom';

const PAGE_ONLY: ReplicaReadScope = Object.freeze({
  controlSemantics: false,
  controlImages: false,
  disclosureContent: false,
  formValues: false,
  personalDataValues: false,
  editableContent: false,
});

const STANDARD: ReplicaReadScope = Object.freeze({
  controlSemantics: true,
  controlImages: true,
  disclosureContent: true,
  formValues: false,
  personalDataValues: false,
  editableContent: false,
});

const FULL_VISIBLE: ReplicaReadScope = Object.freeze({
  controlSemantics: true,
  controlImages: true,
  disclosureContent: true,
  formValues: true,
  personalDataValues: true,
  editableContent: true,
});

export const PAGE_ONLY_REPLICA_READ_SCOPE = PAGE_ONLY;
export const STANDARD_REPLICA_READ_SCOPE = STANDARD;
export const FULL_VISIBLE_REPLICA_READ_SCOPE = FULL_VISIBLE;

export function replicaReadScopeForProfile(
  profile: ReplicaReadScopeProfileId,
): ReplicaReadScope {
  if (profile === 'standard') return cloneScope(STANDARD);
  if (profile === 'full-visible') return cloneScope(FULL_VISIBLE);
  return cloneScope(PAGE_ONLY);
}

/** Persisted-data repair is deliberately fail-closed, including partial data. */
export function repairReplicaReadScope(input: unknown): ReplicaReadScope {
  return readExactReplicaReadScope(input) ?? cloneScope(PAGE_ONLY);
}

/** Strict parser used at command/protocol boundaries. */
export function readExactReplicaReadScope(
  input: unknown,
): ReplicaReadScope | undefined {
  if (!isRecord(input)) return undefined;
  const keys = Object.keys(input);
  if (
    keys.length !== REPLICA_READ_SCOPE_KEYS.length ||
    keys.some((key) => !(REPLICA_READ_SCOPE_KEYS as readonly string[]).includes(key))
  ) return undefined;
  for (const key of REPLICA_READ_SCOPE_KEYS) {
    if (typeof input[key] !== 'boolean') return undefined;
  }
  // Personal values are meaningful only with the ordinary form-value gate.
  // Reject rather than silently widening formValues.
  if (input.personalDataValues && !input.formValues) return undefined;
  return Object.freeze({
    controlSemantics: input.controlSemantics === true,
    controlImages: input.controlImages === true,
    disclosureContent: input.disclosureContent === true,
    formValues: input.formValues === true,
    personalDataValues: input.personalDataValues === true,
    editableContent: input.editableContent === true,
  });
}

export function deriveReplicaReadScopeProfile(
  input: ReplicaReadScope,
): DerivedReplicaReadScopeProfileId {
  const scope = repairReplicaReadScope(input);
  if (sameReplicaReadScope(scope, PAGE_ONLY)) return 'page-only';
  if (sameReplicaReadScope(scope, STANDARD)) return 'standard';
  if (sameReplicaReadScope(scope, FULL_VISIBLE)) return 'full-visible';
  return 'custom';
}

export function sameReplicaReadScope(
  left: ReplicaReadScope,
  right: ReplicaReadScope,
): boolean {
  return REPLICA_READ_SCOPE_KEYS.every((key) => left[key] === right[key]);
}

/** Safe intersection used while a narrowing commit is unresolved. */
export function intersectReplicaReadScopes(
  left: ReplicaReadScope,
  right: ReplicaReadScope,
): ReplicaReadScope {
  const first = repairReplicaReadScope(left);
  const second = repairReplicaReadScope(right);
  return Object.freeze({
    controlSemantics: first.controlSemantics && second.controlSemantics,
    controlImages: first.controlImages && second.controlImages,
    disclosureContent: first.disclosureContent && second.disclosureContent,
    formValues: first.formValues && second.formValues,
    personalDataValues:
      first.formValues && second.formValues &&
      first.personalDataValues && second.personalDataValues,
    editableContent: first.editableContent && second.editableContent,
  });
}

export function replicaReadScopeNarrows(
  before: ReplicaReadScope,
  after: ReplicaReadScope,
): boolean {
  const oldScope = repairReplicaReadScope(before);
  const newScope = repairReplicaReadScope(after);
  return REPLICA_READ_SCOPE_KEYS.some(
    (key) => oldScope[key] && !newScope[key],
  );
}

/** Stable, content-free policy identity for exact-document protocol epochs. */
export function replicaReadScopeFingerprint(scope: ReplicaReadScope): string {
  const normalized = repairReplicaReadScope(scope);
  const bits = REPLICA_READ_SCOPE_KEYS.map((key) => normalized[key] ? '1' : '0')
    .join('');
  return `read-v${REPLICA_READ_SCOPE_SCHEMA_VERSION}-${bits}`;
}

export function effectiveReplicaReadScope(
  configured: ReplicaReadScope,
  setupVersion: number,
): ReplicaReadScope {
  return setupVersion === REPLICA_READ_SCOPE_SETUP_VERSION
    ? repairReplicaReadScope(configured)
    : cloneScope(PAGE_ONLY);
}

function cloneScope(scope: ReplicaReadScope): ReplicaReadScope {
  return {
    controlSemantics: scope.controlSemantics,
    controlImages: scope.controlImages,
    disclosureContent: scope.disclosureContent,
    formValues: scope.formValues,
    personalDataValues: scope.personalDataValues,
    editableContent: scope.editableContent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
