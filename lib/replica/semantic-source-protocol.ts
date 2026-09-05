import {
  readExactReplicaReadScope,
  replicaReadScopeFingerprint,
  type ReplicaReadScope,
  type ReplicaReadScopeKey,
} from './read-scope-policy';
import {
  readSourceDocumentIdentity,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from './source-identity';
import {
  SOURCE_SECRET_CLASSIFIER_VERSION,
  classifySourceEvidence,
  type SourceEvidenceCategory,
} from './source-secret-classifier';

export const SEMANTIC_SOURCE_PROTOCOL_VERSION = 2;
export const SEMANTIC_SOURCE_PORT_PREFIX = 'simul:semantic-source-v2:';
export const MAX_SEMANTIC_SOURCE_RECORDS = 128;
export const MAX_SEMANTIC_SOURCE_PROOFS = 128;
export const MAX_SEMANTIC_SELECTED_OPTION_NODE_IDS = 32;
export const MAX_SEMANTIC_SELECT_SIZE = 1_000;
export const MAX_SEMANTIC_SOURCE_BATCH_BYTES = 256 * 1024;
export const MAX_SEMANTIC_SOURCE_TEXT = 3_500;
export const MAX_SEMANTIC_SOURCE_UNACKED_BATCHES = 4;
export const MAX_SEMANTIC_SOURCE_NODE_IDENTITIES = 50_000;

export type SemanticSourceBridgeId = 'isolated-html';
export type SemanticSourceRecordCategory = Exclude<
  SourceEvidenceCategory,
  'secret' | 'withheld'
>;
export type SemanticSourceGate = Exclude<ReplicaReadScopeKey, 'controlImages'>;
export type SemanticSourcePresentation =
  | 'label'
  | 'placeholder'
  | 'value'
  | 'editable'
  | 'selection'
  | 'text';
export type SemanticDisclosurePopupRole =
  | 'dialog'
  | 'grid'
  | 'listbox'
  | 'menu'
  | 'region'
  | 'tree';

const SEMANTIC_SOURCE_PRESENTATION_SLOT = Object.freeze({
  label: 1,
  placeholder: 2,
  value: 3,
  editable: 4,
  selection: 5,
  text: 6,
} satisfies Record<SemanticSourcePresentation, number>);

export interface SemanticSourcePortIdentity {
  readonly bridge: SemanticSourceBridgeId;
  readonly sessionId: string;
}

export interface SemanticSourceStartMessage {
  readonly protocolVersion: typeof SEMANTIC_SOURCE_PROTOCOL_VERSION;
  readonly kind: 'simul:semantic-source-v2:start';
  readonly bridge: SemanticSourceBridgeId;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly policyFingerprint: string;
  readonly scope: ReplicaReadScope;
}

export interface SemanticSourceAckMessage {
  readonly protocolVersion: typeof SEMANTIC_SOURCE_PROTOCOL_VERSION;
  readonly kind: 'simul:semantic-source-v2:ack';
  readonly document: ReplicaSourceDocumentIdentity;
  readonly policyFingerprint: string;
  readonly sequence: number;
}

export type SemanticSourceControllerMessage =
  | SemanticSourceStartMessage
  | SemanticSourceAckMessage;

export interface SemanticSourceRecord {
  readonly bridge: SemanticSourceBridgeId;
  /** Stable source-document identity for this presentation slot. */
  readonly recordId: number;
  /** Native bridge identity of the exact source/replica node to mutate. */
  readonly nodeId: number;
  readonly nodeRevision: number;
  readonly category: SemanticSourceRecordCategory;
  readonly gate: SemanticSourceGate;
  readonly tagName: string;
  readonly type: string;
  readonly autocomplete: string;
  readonly role: string;
  readonly contentEditable: string;
  readonly text: string;
  readonly presentation: SemanticSourcePresentation;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export interface SemanticSelectStateProof {
  readonly kind: 'select-state';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of the exact source/replica select node. */
  readonly nodeId: number;
  /** Monotonic revision for this select proof identity. */
  readonly revision: number;
  readonly gate: 'formValues';
  /** Native bridge identities only; source-authored option IDs never travel. */
  readonly selectedOptionNodeIds: readonly number[];
  /** Selection interpretation only; UI shape requires select-presentation. */
  readonly multiple: boolean;
  readonly pickerOpen: boolean;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export interface SemanticSelectPresentationProof {
  readonly kind: 'select-presentation';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of the exact source/replica select node. */
  readonly nodeId: number;
  /** Monotonic revision for this presentation proof identity. */
  readonly revision: number;
  readonly gate: 'controlSemantics';
  readonly multiple: boolean;
  /** A bounded, canonical authored size, or null when none was authored. */
  readonly size: number | null;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export interface SemanticDisclosureStateProof {
  readonly kind: 'disclosure-state';
  readonly bridge: SemanticSourceBridgeId;
  /** Replica-owned identity derived only from the two native bridge IDs. */
  readonly relationId: string;
  /** Monotonic revision for this relationship proof identity. */
  readonly revision: number;
  readonly gate: 'disclosureContent';
  readonly triggerNodeId: number;
  readonly panelNodeId: number;
  readonly popupRole: SemanticDisclosurePopupRole;
  readonly expanded: boolean;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

/**
 * A strict non-ARIA navigation menu inferred from one common wrapper. The
 * relationship is structural only: opening is owned entirely by the inert
 * replica and never reflects or dispatches source activation.
 */
export interface SemanticStructuralMenuProof {
  readonly kind: 'structural-menu';
  readonly bridge: SemanticSourceBridgeId;
  /** Replica-owned identity derived only from the three native bridge IDs. */
  readonly relationId: string;
  /** Monotonic revision for this structural relationship. */
  readonly revision: number;
  readonly gate: 'disclosureContent';
  readonly containerNodeId: number;
  readonly triggerNodeId: number;
  readonly panelNodeId: number;
  /** Canonical replica presentation; structural candidates are always menus. */
  readonly popupRole: 'menu';
  /** Current source-painted state after the relationship was safely inferred. */
  readonly expanded: boolean;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export interface SemanticTabStateProof {
  readonly kind: 'tab-state';
  readonly bridge: SemanticSourceBridgeId;
  /** Replica-owned identity derived only from the two native bridge IDs. */
  readonly relationId: string;
  /** Monotonic revision for this inline tab relationship. */
  readonly revision: number;
  readonly gate: 'controlSemantics';
  readonly tabNodeId: number;
  readonly panelNodeId: number;
  readonly selected: boolean;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export interface SemanticChoiceStateProof {
  readonly kind: 'choice-state';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of a checkbox or radio input. */
  readonly nodeId: number;
  /** Monotonic revision for this choice proof identity. */
  readonly revision: number;
  readonly gate: 'formValues';
  readonly checked: boolean;
  readonly indeterminate: boolean;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export interface SemanticControlStateProof {
  readonly kind: 'control-state';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of a disableable control. */
  readonly nodeId: number;
  /** Monotonic revision for this control proof identity. */
  readonly revision: number;
  readonly gate: 'controlSemantics';
  readonly disabled: boolean;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

/**
 * Typed ARIA widget state. `checked`, `selected`, `pressed` and the
 * slider/spinbutton `valueinput` are user input (formValues); `current` and
 * the read-only indicator `valuenow` are page state (controlSemantics). Every
 * value is a bounded token or a bounded decimal; `aria-valuetext` (free text)
 * never travels. `valueinput` carries the same `aria-valuenow` attribute as
 * `valuenow`, but from a user-editable slider/spinbutton, so it reads under
 * the form-value gate rather than the page-state gate.
 */
export type SemanticAriaState =
  | 'checked'
  | 'selected'
  | 'pressed'
  | 'current'
  | 'valuenow'
  | 'valueinput';
export type SemanticAriaStateGate = 'formValues' | 'controlSemantics';
const SEMANTIC_ARIA_CURRENT_VALUES = new Set([
  'page', 'step', 'location', 'date', 'time', 'true', 'false',
]);
/** Up to 15 integer digits and 6 fraction digits; no exponent, no sign noise. */
const SEMANTIC_ARIA_DECIMAL_VALUE = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/u;

export interface SemanticAriaStateProof {
  readonly kind: 'aria-state';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of the exact ARIA widget node. */
  readonly nodeId: number;
  /** Monotonic revision for this typed ARIA-state identity. */
  readonly revision: number;
  readonly gate: SemanticAriaStateGate;
  readonly state: SemanticAriaState;
  /** Validated by `isSemanticAriaStateValue` for the proof's state. */
  readonly value: string;
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export function isSemanticAriaState(value: unknown): value is SemanticAriaState {
  return value === 'checked' || value === 'selected' || value === 'pressed' ||
    value === 'current' || value === 'valuenow' || value === 'valueinput';
}

/** User input reads under formValues; read-only page state under controlSemantics. */
export function semanticAriaStateGate(
  state: SemanticAriaState,
): SemanticAriaStateGate {
  return state === 'current' || state === 'valuenow'
    ? 'controlSemantics'
    : 'formValues';
}

/**
 * The source attribute a state reads from. `valueinput` shares the numeric
 * `aria-valuenow` attribute of `valuenow`; every other state reads its own
 * `aria-<state>`.
 */
export function semanticAriaStateAttribute(state: SemanticAriaState): string {
  return state === 'valueinput' ? 'aria-valuenow' : `aria-${state}`;
}

export function isSemanticAriaStateValue(
  state: SemanticAriaState,
  value: unknown,
): value is string {
  if (typeof value !== 'string') return false;
  if (state === 'current') return SEMANTIC_ARIA_CURRENT_VALUES.has(value);
  if (state === 'valuenow' || state === 'valueinput') {
    return value.length <= 24 && SEMANTIC_ARIA_DECIMAL_VALUE.test(value);
  }
  if (state === 'selected') return value === 'true' || value === 'false';
  return value === 'true' || value === 'false' || value === 'mixed';
}

export const MAX_SEMANTIC_ARIA_RELATIONSHIP_TARGETS = 32;
export type SemanticAriaRelation = 'labelledby' | 'describedby';

/**
 * A safe accessible-name/description relationship carried as native bridge
 * identities, never as label text. The base sanitizer strips `aria-labelledby`
 * and `aria-describedby` as private ID-reference surface, so a control named
 * only by referenced visible text arrives unnamed. This proof lets the
 * presenter re-point the control at the already-present replica nodes it named
 * (assigning them replica-owned ids as needed), restoring the accessible name
 * or description without duplicating the referenced text. Page state, so it
 * reads under `controlSemantics`.
 */
export interface SemanticAriaRelationshipProof {
  readonly kind: 'aria-relationship';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of the control that carries the reference. */
  readonly nodeId: number;
  /** Monotonic revision for this relationship identity. */
  readonly revision: number;
  readonly gate: 'controlSemantics';
  readonly relation: SemanticAriaRelation;
  /** Native bridge identities of the referenced nodes, in author order. */
  readonly targetNodeIds: readonly number[];
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
}

export function isSemanticAriaRelation(
  value: unknown,
): value is SemanticAriaRelation {
  return value === 'labelledby' || value === 'describedby';
}

export type SemanticSourceProof =
  | SemanticSelectStateProof
  | SemanticSelectPresentationProof
  | SemanticTabStateProof
  | SemanticDisclosureStateProof
  | SemanticStructuralMenuProof
  | SemanticChoiceStateProof
  | SemanticControlStateProof
  | SemanticAriaStateProof
  | SemanticAriaRelationshipProof;

/** A complete replacement of the admitted semantic set for one policy epoch. */
export interface SemanticSourceBatch {
  readonly protocolVersion: typeof SEMANTIC_SOURCE_PROTOCOL_VERSION;
  readonly kind: 'simul:semantic-source-v2:batch';
  readonly document: ReplicaSourceDocumentIdentity;
  readonly policyFingerprint: string;
  readonly sequence: number;
  readonly records: readonly SemanticSourceRecord[];
  readonly proofs: readonly SemanticSourceProof[];
  readonly byteLength: number;
}

export function createSemanticSourcePortName(
  sessionId: string,
  bridge: SemanticSourceBridgeId,
): string {
  if (!isSafeToken(sessionId)) throw new Error('Invalid semantic source session.');
  return `${SEMANTIC_SOURCE_PORT_PREFIX}${bridge}:${sessionId}`;
}

export function readSemanticSourcePortIdentity(
  name: unknown,
  expectedBridge?: SemanticSourceBridgeId,
): SemanticSourcePortIdentity | undefined {
  if (typeof name !== 'string' || !name.startsWith(SEMANTIC_SOURCE_PORT_PREFIX)) {
    return undefined;
  }
  const suffix = name.slice(SEMANTIC_SOURCE_PORT_PREFIX.length);
  const separator = suffix.indexOf(':');
  if (separator < 1) return undefined;
  const bridge = suffix.slice(0, separator);
  const sessionId = suffix.slice(separator + 1);
  if (
    bridge !== 'isolated-html' ||
    (expectedBridge !== undefined && bridge !== expectedBridge) ||
    !isSafeToken(sessionId)
  ) return undefined;
  return Object.freeze({ bridge, sessionId });
}

export function createSemanticSourceStart(
  bridge: SemanticSourceBridgeId,
  document: ReplicaSourceDocumentIdentity,
  scope: ReplicaReadScope,
): SemanticSourceStartMessage {
  const exactScope = readExactReplicaReadScope(scope);
  if (!exactScope) throw new Error('Invalid semantic read scope.');
  return Object.freeze({
    protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
    kind: 'simul:semantic-source-v2:start',
    bridge,
    document,
    policyFingerprint: replicaReadScopeFingerprint(exactScope),
    scope: exactScope,
  });
}

export function createSemanticSourceAck(
  document: ReplicaSourceDocumentIdentity,
  policyFingerprint: string,
  sequence: number,
): SemanticSourceAckMessage {
  if (!isPolicyFingerprint(policyFingerprint) || !positiveSafeInteger(sequence)) {
    throw new Error('Invalid semantic source acknowledgement.');
  }
  return Object.freeze({
    protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
    kind: 'simul:semantic-source-v2:ack',
    document,
    policyFingerprint,
    sequence,
  });
}

export function readSemanticSourceControllerMessage(
  input: unknown,
  port: SemanticSourcePortIdentity,
  expectedDocument?: ReplicaSourceDocumentIdentity,
  expectedPolicyFingerprint?: string,
): SemanticSourceControllerMessage | undefined {
  if (!isRecord(input) || input.protocolVersion !== SEMANTIC_SOURCE_PROTOCOL_VERSION) {
    return undefined;
  }
  if (input.kind === 'simul:semantic-source-v2:start') {
    if (!hasExactKeys(input, [
      'protocolVersion', 'kind', 'bridge', 'document', 'policyFingerprint',
      'scope',
    ]) || input.bridge !== port.bridge || !isPolicyFingerprint(input.policyFingerprint)) {
      return undefined;
    }
    const document = readSourceDocumentIdentity(input.document);
    const scope = readExactReplicaReadScope(input.scope);
    if (
      !document || document.sessionId !== port.sessionId || !scope ||
      replicaReadScopeFingerprint(scope) !== input.policyFingerprint ||
      (expectedDocument && !sameSourceDocument(document, expectedDocument)) ||
      (expectedPolicyFingerprint &&
        input.policyFingerprint !== expectedPolicyFingerprint)
    ) return undefined;
    return Object.freeze({
      protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
      kind: input.kind,
      bridge: port.bridge,
      document,
      policyFingerprint: input.policyFingerprint,
      scope,
    });
  }
  if (input.kind !== 'simul:semantic-source-v2:ack' || !hasExactKeys(input, [
    'protocolVersion', 'kind', 'document', 'policyFingerprint', 'sequence',
  ]) || !isPolicyFingerprint(input.policyFingerprint) ||
    !positiveSafeInteger(input.sequence)) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  if (
    !document || document.sessionId !== port.sessionId ||
    (expectedDocument && !sameSourceDocument(document, expectedDocument)) ||
    (expectedPolicyFingerprint &&
      input.policyFingerprint !== expectedPolicyFingerprint)
  ) return undefined;
  return Object.freeze({
    protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
    kind: input.kind,
    document,
    policyFingerprint: input.policyFingerprint,
    sequence: input.sequence,
  });
}

export function createSemanticSourceBatch(
  document: ReplicaSourceDocumentIdentity,
  policyFingerprint: string,
  sequence: number,
  records: readonly SemanticSourceRecord[],
  proofs: readonly SemanticSourceProof[] = [],
): SemanticSourceBatch {
  if (!isPolicyFingerprint(policyFingerprint) || !positiveSafeInteger(sequence)) {
    throw new Error('Invalid semantic source batch identity.');
  }
  const byteLength = semanticSourceBatchByteLength(records, proofs);
  const batch = {
    protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
    kind: 'simul:semantic-source-v2:batch' as const,
    document,
    policyFingerprint,
    sequence,
    records: Object.freeze([...records]),
    proofs: Object.freeze([...proofs]),
    byteLength,
  };
  const read = readSemanticSourceBatch(batch, document, policyFingerprint);
  if (!read) throw new Error('Invalid semantic source batch.');
  return read;
}

export function semanticSourceBatchByteLength(
  records: readonly SemanticSourceRecord[],
  proofs: readonly SemanticSourceProof[] = [],
): number {
  let bytes = 0;
  for (const record of records) {
    bytes += record.text.length * 2 + record.tagName.length +
      record.type.length + record.autocomplete.length + record.role.length +
      record.contentEditable.length + record.gate.length +
      record.presentation.length + 128;
  }
  for (const proof of proofs) {
    if (proof.kind === 'select-state') {
      bytes += proof.selectedOptionNodeIds.length * 16 + 192;
    } else if (proof.kind === 'disclosure-state') {
      bytes += proof.relationId.length + proof.popupRole.length + 192;
    } else if (proof.kind === 'structural-menu') {
      bytes += proof.relationId.length + 208;
    } else if (proof.kind === 'tab-state') {
      bytes += proof.relationId.length + 192;
    } else if (proof.kind === 'aria-relationship') {
      bytes += proof.targetNodeIds.length * 16 + proof.relation.length + 176;
    } else {
      bytes += 176;
    }
  }
  return bytes;
}

export function readSemanticSourceBatch(
  input: unknown,
  expectedDocument?: ReplicaSourceDocumentIdentity,
  expectedPolicyFingerprint?: string,
  expectedBridge?: SemanticSourceBridgeId,
  expectedScope?: ReplicaReadScope,
): SemanticSourceBatch | undefined {
  if (!isRecord(input) || !hasExactKeys(input, [
    'protocolVersion', 'kind', 'document', 'policyFingerprint', 'sequence',
    'records', 'proofs', 'byteLength',
  ]) ||
    input.protocolVersion !== SEMANTIC_SOURCE_PROTOCOL_VERSION ||
    input.kind !== 'simul:semantic-source-v2:batch' ||
    !isPolicyFingerprint(input.policyFingerprint) ||
    (expectedPolicyFingerprint !== undefined &&
      input.policyFingerprint !== expectedPolicyFingerprint) ||
    !positiveSafeInteger(input.sequence) ||
    !Array.isArray(input.records) ||
    input.records.length > MAX_SEMANTIC_SOURCE_RECORDS ||
    !Array.isArray(input.proofs) ||
    input.proofs.length > MAX_SEMANTIC_SOURCE_PROOFS ||
    !Number.isSafeInteger(input.byteLength) ||
    Number(input.byteLength) < 0 ||
    Number(input.byteLength) > MAX_SEMANTIC_SOURCE_BATCH_BYTES
  ) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  if (!document || (expectedDocument &&
    !sameSourceDocument(document, expectedDocument))) return undefined;
  const scope = expectedScope && readExactReplicaReadScope(expectedScope);
  if (expectedScope && !scope) return undefined;
  if (scope && replicaReadScopeFingerprint(scope) !== input.policyFingerprint) {
    return undefined;
  }
  const records: SemanticSourceRecord[] = [];
  const recordIds = new Set<number>();
  for (const value of input.records) {
    const record = readSemanticSourceRecord(value);
    if (
      !record || recordIds.has(record.recordId) ||
      (expectedBridge !== undefined && record.bridge !== expectedBridge) ||
      (scope && !scope[record.gate])
    ) return undefined;
    recordIds.add(record.recordId);
    records.push(record);
  }
  const proofs: SemanticSourceProof[] = [];
  const proofIds = new Set<string>();
  for (const value of input.proofs) {
    const proof = readSemanticSourceProof(value);
    if (!proof) return undefined;
    const proofId = semanticSourceProofIdentity(proof);
    if (
      proofIds.has(proofId) ||
      (expectedBridge !== undefined && proof.bridge !== expectedBridge) ||
      (scope && !scope[proof.gate])
    ) return undefined;
    proofIds.add(proofId);
    proofs.push(proof);
  }
  const computedBytes = semanticSourceBatchByteLength(records, proofs);
  const byteLength = Number(input.byteLength);
  if (byteLength !== computedBytes || computedBytes > MAX_SEMANTIC_SOURCE_BATCH_BYTES) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
    kind: input.kind,
    document,
    policyFingerprint: input.policyFingerprint,
    sequence: input.sequence,
    records: Object.freeze(records),
    proofs: Object.freeze(proofs),
    byteLength,
  });
}

export function readSemanticSourceProof(
  input: unknown,
): SemanticSourceProof | undefined {
  if (!isRecord(input) ||
    input.bridge !== 'isolated-html' ||
    !positiveSafeInteger(input.revision) ||
    input.classifierVersion !== SOURCE_SECRET_CLASSIFIER_VERSION
  ) return undefined;
  if (input.kind === 'select-state') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate',
      'selectedOptionNodeIds', 'multiple', 'pickerOpen',
      'classifierVersion',
    ]) || input.gate !== 'formValues' ||
      !positiveSafeInteger(input.nodeId) ||
      !Array.isArray(input.selectedOptionNodeIds) ||
      input.selectedOptionNodeIds.length > MAX_SEMANTIC_SELECTED_OPTION_NODE_IDS ||
      typeof input.multiple !== 'boolean' ||
      typeof input.pickerOpen !== 'boolean'
    ) return undefined;
    const selectedOptionNodeIds: number[] = [];
    const seen = new Set<number>();
    for (const value of input.selectedOptionNodeIds) {
      if (!positiveSafeInteger(value) || value === input.nodeId || seen.has(value)) {
        return undefined;
      }
      seen.add(value);
      selectedOptionNodeIds.push(value);
    }
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: input.gate,
      selectedOptionNodeIds: Object.freeze(selectedOptionNodeIds),
      multiple: input.multiple,
      pickerOpen: input.pickerOpen,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'select-presentation') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate', 'multiple', 'size',
      'classifierVersion',
    ]) || input.gate !== 'controlSemantics' ||
      !positiveSafeInteger(input.nodeId) ||
      typeof input.multiple !== 'boolean' ||
      (input.size !== null && (
        !Number.isSafeInteger(input.size) || Number(input.size) < 1 ||
        Number(input.size) > MAX_SEMANTIC_SELECT_SIZE
      ))
    ) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: input.gate,
      multiple: input.multiple,
      size: input.size as number | null,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'choice-state') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate', 'checked',
      'indeterminate', 'classifierVersion',
    ]) || input.gate !== 'formValues' ||
      !positiveSafeInteger(input.nodeId) ||
      typeof input.checked !== 'boolean' ||
      typeof input.indeterminate !== 'boolean'
    ) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: input.gate,
      checked: input.checked,
      indeterminate: input.indeterminate,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'control-state') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate', 'disabled',
      'classifierVersion',
    ]) || input.gate !== 'controlSemantics' ||
      !positiveSafeInteger(input.nodeId) ||
      typeof input.disabled !== 'boolean'
    ) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: input.gate,
      disabled: input.disabled,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'aria-state') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate', 'state', 'value',
      'classifierVersion',
    ]) ||
      !positiveSafeInteger(input.nodeId) ||
      !isSemanticAriaState(input.state) ||
      input.gate !== semanticAriaStateGate(input.state) ||
      !isSemanticAriaStateValue(input.state, input.value)
    ) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: semanticAriaStateGate(input.state),
      state: input.state,
      value: input.value,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'aria-relationship') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate', 'relation',
      'targetNodeIds', 'classifierVersion',
    ]) || input.gate !== 'controlSemantics' ||
      !positiveSafeInteger(input.nodeId) ||
      !isSemanticAriaRelation(input.relation) ||
      !Array.isArray(input.targetNodeIds) ||
      input.targetNodeIds.length < 1 ||
      input.targetNodeIds.length > MAX_SEMANTIC_ARIA_RELATIONSHIP_TARGETS
    ) return undefined;
    const targetNodeIds: number[] = [];
    const seen = new Set<number>();
    for (const value of input.targetNodeIds) {
      if (!positiveSafeInteger(value) || value === input.nodeId || seen.has(value)) {
        return undefined;
      }
      seen.add(value);
      targetNodeIds.push(value);
    }
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: input.gate,
      relation: input.relation,
      targetNodeIds: Object.freeze(targetNodeIds),
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'tab-state') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'relationId', 'revision', 'gate', 'tabNodeId',
      'panelNodeId', 'selected', 'classifierVersion',
    ]) || input.gate !== 'controlSemantics' ||
      !positiveSafeInteger(input.tabNodeId) ||
      !positiveSafeInteger(input.panelNodeId) ||
      input.tabNodeId === input.panelNodeId ||
      typeof input.selected !== 'boolean'
    ) return undefined;
    const relationId = semanticTabRelationId(
      input.tabNodeId,
      input.panelNodeId,
    );
    if (!relationId || input.relationId !== relationId) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      relationId,
      revision: input.revision,
      gate: input.gate,
      tabNodeId: input.tabNodeId,
      panelNodeId: input.panelNodeId,
      selected: input.selected,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'structural-menu') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'relationId', 'revision', 'gate', 'containerNodeId',
      'triggerNodeId', 'panelNodeId', 'popupRole', 'expanded',
      'classifierVersion',
    ]) || input.gate !== 'disclosureContent' ||
      !positiveSafeInteger(input.containerNodeId) ||
      !positiveSafeInteger(input.triggerNodeId) ||
      !positiveSafeInteger(input.panelNodeId) ||
      input.popupRole !== 'menu' || input.expanded !== false ||
      new Set([
        input.containerNodeId,
        input.triggerNodeId,
        input.panelNodeId,
      ]).size !== 3
    ) return undefined;
    const relationId = semanticStructuralMenuRelationId(
      input.containerNodeId,
      input.triggerNodeId,
      input.panelNodeId,
    );
    if (!relationId || input.relationId !== relationId) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      relationId,
      revision: input.revision,
      gate: input.gate,
      containerNodeId: input.containerNodeId,
      triggerNodeId: input.triggerNodeId,
      panelNodeId: input.panelNodeId,
      popupRole: input.popupRole,
      expanded: input.expanded,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind !== 'disclosure-state' || !hasExactKeys(input, [
    'kind', 'bridge', 'relationId', 'revision', 'gate', 'triggerNodeId',
    'panelNodeId', 'popupRole', 'expanded', 'classifierVersion',
  ]) || input.gate !== 'disclosureContent' ||
    !positiveSafeInteger(input.triggerNodeId) ||
    !positiveSafeInteger(input.panelNodeId) ||
    input.triggerNodeId === input.panelNodeId ||
    !isDisclosurePopupRole(input.popupRole) ||
    typeof input.expanded !== 'boolean'
  ) return undefined;
  const relationId = semanticDisclosureRelationId(
    input.triggerNodeId,
    input.panelNodeId,
  );
  if (!relationId || input.relationId !== relationId) return undefined;
  return Object.freeze({
    kind: input.kind,
    bridge: input.bridge,
    relationId,
    revision: input.revision,
    gate: input.gate,
    triggerNodeId: input.triggerNodeId,
    panelNodeId: input.panelNodeId,
    popupRole: input.popupRole,
    expanded: input.expanded,
    classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
  });
}

/** Deterministic replica-owned identity; it never contains a source DOM ID. */
export function semanticDisclosureRelationId(
  triggerNodeId: number,
  panelNodeId: number,
): string | undefined {
  if (!positiveSafeInteger(triggerNodeId) || !positiveSafeInteger(panelNodeId) ||
    triggerNodeId === panelNodeId) return undefined;
  return `semantic-relation-v1:${triggerNodeId}:${panelNodeId}`;
}

/** Deterministic identity for an inline tab relationship, never a popup. */
export function semanticTabRelationId(
  tabNodeId: number,
  panelNodeId: number,
): string | undefined {
  if (!positiveSafeInteger(tabNodeId) || !positiveSafeInteger(panelNodeId) ||
    tabNodeId === panelNodeId) return undefined;
  return `semantic-tab-relation-v1:${tabNodeId}:${panelNodeId}`;
}

/** Deterministic identity for one receiver-revalidated structural menu. */
export function semanticStructuralMenuRelationId(
  containerNodeId: number,
  triggerNodeId: number,
  panelNodeId: number,
): string | undefined {
  if (
    !positiveSafeInteger(containerNodeId) ||
    !positiveSafeInteger(triggerNodeId) ||
    !positiveSafeInteger(panelNodeId) ||
    new Set([containerNodeId, triggerNodeId, panelNodeId]).size !== 3
  ) return undefined;
  return `semantic-structural-menu-v1:${containerNodeId}:${triggerNodeId}:${panelNodeId}`;
}

export function semanticSourceProofIdentity(proof: SemanticSourceProof): string {
  if (proof.kind === 'select-state') return `semantic-select-v1:${proof.nodeId}`;
  if (proof.kind === 'select-presentation') {
    return `semantic-select-presentation-v1:${proof.nodeId}`;
  }
  if (proof.kind === 'choice-state') return `semantic-choice-v1:${proof.nodeId}`;
  if (proof.kind === 'control-state') return `semantic-control-v1:${proof.nodeId}`;
  if (proof.kind === 'aria-state') {
    return `semantic-aria-state-v1:${proof.nodeId}:${proof.state}`;
  }
  if (proof.kind === 'aria-relationship') {
    return `semantic-aria-relationship-v1:${proof.nodeId}:${proof.relation}`;
  }
  if (proof.kind === 'tab-state') return proof.relationId;
  if (proof.kind === 'structural-menu') return proof.relationId;
  return proof.relationId;
}

/** Stable state signature used to advance one proof identity's revision. */
export function semanticSourceProofSignature(proof: SemanticSourceProof): string {
  if (proof.kind === 'select-state') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate,
    proof.selectedOptionNodeIds.join(','), Number(proof.multiple),
    Number(proof.pickerOpen), proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'select-presentation') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, Number(proof.multiple),
    proof.size ?? '', proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'choice-state') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, Number(proof.checked),
    Number(proof.indeterminate), proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'control-state') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, Number(proof.disabled),
    proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'aria-state') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, proof.state, proof.value,
    proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'aria-relationship') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, proof.relation,
    proof.targetNodeIds.join(','), proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'tab-state') return [
    proof.bridge, proof.kind, proof.relationId, proof.gate,
    proof.tabNodeId, proof.panelNodeId, Number(proof.selected),
    proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'structural-menu') return [
    proof.bridge, proof.kind, proof.relationId, proof.gate,
    proof.containerNodeId, proof.triggerNodeId, proof.panelNodeId,
    proof.popupRole, Number(proof.expanded), proof.classifierVersion,
  ].join('\u0000');
  return [
    proof.bridge, proof.kind, proof.relationId, proof.gate,
    proof.triggerNodeId, proof.panelNodeId, proof.popupRole,
    Number(proof.expanded), proof.classifierVersion,
  ].join('\u0000');
}

export function readSemanticSourceRecord(
  input: unknown,
): SemanticSourceRecord | undefined {
  if (!isRecord(input) || !hasExactKeys(input, [
    'bridge', 'recordId', 'nodeId', 'nodeRevision', 'category', 'gate',
    'tagName', 'type', 'autocomplete', 'role', 'contentEditable', 'text',
    'presentation', 'classifierVersion',
  ]) ||
    input.bridge !== 'isolated-html' ||
    !positiveSafeInteger(input.recordId) ||
    !positiveSafeInteger(input.nodeId) ||
    !positiveSafeInteger(input.nodeRevision) ||
    input.classifierVersion !== SOURCE_SECRET_CLASSIFIER_VERSION ||
    !isSemanticGate(input.gate) ||
    !isBoundedToken(input.tagName, 64) ||
    !isBoundedToken(input.type, 64, true) ||
    !isBoundedToken(input.autocomplete, 512, true) ||
    !isBoundedToken(input.role, 128, true) ||
    !isBoundedToken(input.contentEditable, 32, true) ||
    typeof input.text !== 'string' || input.text.length < 1 ||
    input.text.length > MAX_SEMANTIC_SOURCE_TEXT ||
    !isPresentation(input.presentation)
  ) return undefined;
  if (
    semanticSourceRecordId(input.nodeId, input.presentation) !== input.recordId
  ) return undefined;
  const classified = classifySourceEvidence({
    tagName: input.tagName,
    type: input.type,
    autocomplete: input.autocomplete,
    role: input.role,
    contentEditable: input.contentEditable,
    valueBearing: input.presentation === 'value' ||
      input.presentation === 'editable' || input.presentation === 'selection',
  });
  if (
    classified === 'secret' || classified === 'withheld' ||
    classified !== input.category ||
    !gateMatchesRecord(input.gate, classified, input.presentation)
  ) return undefined;
  return Object.freeze({
    bridge: input.bridge,
    recordId: input.recordId,
    nodeId: input.nodeId,
    nodeRevision: input.nodeRevision,
    category: classified,
    gate: input.gate,
    tagName: input.tagName,
    type: input.type,
    autocomplete: input.autocomplete,
    role: input.role,
    contentEditable: input.contentEditable,
    text: input.text,
    presentation: input.presentation,
    classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
  });
}

function gateMatchesRecord(
  gate: SemanticSourceGate,
  category: SemanticSourceRecordCategory,
  presentation: SemanticSourcePresentation,
): boolean {
  if (gate === 'controlSemantics') {
    return (
      category === 'public-semantic' || category === 'ordinary-form' ||
      category === 'personal'
    ) && presentation === 'label';
  }
  if (gate === 'disclosureContent') {
    return category === 'public-semantic' && presentation === 'text';
  }
  if (gate === 'personalDataValues') {
    return category === 'personal' && presentation === 'value';
  }
  if (gate === 'editableContent') {
    return category === 'editable' &&
      (presentation === 'editable' || presentation === 'text');
  }
  return category === 'ordinary-form' &&
    (presentation === 'value' || presentation === 'placeholder' ||
      presentation === 'selection');
}

/** Deterministically binds one bridge node and presentation slot to a record. */
export function semanticSourceRecordId(
  nodeId: number,
  presentation: SemanticSourcePresentation,
): number | undefined {
  if (!positiveSafeInteger(nodeId)) return undefined;
  const slot = SEMANTIC_SOURCE_PRESENTATION_SLOT[presentation];
  const value = nodeId * 8 + slot;
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isSemanticGate(value: unknown): value is SemanticSourceGate {
  return value === 'controlSemantics' || value === 'disclosureContent' ||
    value === 'formValues' || value === 'personalDataValues' ||
    value === 'editableContent';
}

function isPresentation(value: unknown): value is SemanticSourcePresentation {
  return value === 'label' || value === 'placeholder' || value === 'value' ||
    value === 'editable' || value === 'selection' || value === 'text';
}

function isDisclosurePopupRole(
  value: unknown,
): value is SemanticDisclosurePopupRole {
  return value === 'dialog' || value === 'grid' || value === 'listbox' ||
    value === 'menu' || value === 'region' || value === 'tree';
}

function isPolicyFingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^read-v\d+-[01]{6}$/u.test(value);
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isBoundedToken(
  value: unknown,
  maximum: number,
  empty = false,
): value is string {
  return typeof value === 'string' &&
    (empty || value.length > 0) && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function positiveSafeInteger(value: unknown): value is number {
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
  return actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}
