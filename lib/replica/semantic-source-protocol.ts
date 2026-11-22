import { MAX_HTML_MIRROR_NODES_SETTING } from './html-mirror-limits';
import {
  MAX_PAGE_LINKED_SHEETS,
  MAX_PAGE_LINKED_SHEET_HREF_LENGTH,
  type PageLinkedSheets,
} from './style-sheet-reach';
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

/**
 * Version 3 lets a batch carry only what changed since the batch before
 * (D179). A start or an ACK says which version the panel speaks; a page of
 * this build answers a panel of version 2 with whole-state batches stamped
 * 2, and a panel of version 2 refuses a start of version 3, so a stale pair
 * after an update reads whole states or nothing, never half a state. The
 * port prefix and the message kinds keep their `v2` names: they are names.
 */
export const SEMANTIC_SOURCE_PROTOCOL_VERSION = 3;

/**
 * The `contentEditable` fact of an editor the page made without the
 * attribute (D192): a document in design mode, or an element typed into
 * that the page's style makes editable (D181). The mirror's element carries
 * no attribute, so the panel takes the page's word for it, through this
 * mark, where the record's tag names an element above the text.
 */
export const SEMANTIC_PAGE_EDITOR_MARK = 'simul-page-editor';
/** The version that knows whole-state batches only (before D179). */
export const SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION = 2;
export type SemanticSourceProtocolVersion =
  | typeof SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION
  | typeof SEMANTIC_SOURCE_PROTOCOL_VERSION;
export const SEMANTIC_SOURCE_PORT_PREFIX = 'simul:semantic-source-v2:';
// One batch is one message, and its counted bytes are its limit: 8 MiB, well
// inside the 64 MiB Chrome carries (D63). The counts below only follow from
// that: no record is counted smaller than 128 bytes and no proof smaller than
// 176. They were once 128 each, then 1,024 records and 2,048 proofs, and each
// time real pages passed them: country, nationality, dialling-code and
// time-zone lists together, or a table with a dropdown on every row, left the
// dropdowns further down blank and the site menus shut (D132). Measured in
// Chrome with every label read: a page with 1,600 options pauses less at a
// change than it did (46 ms, 159 ms before), one with 10,000 the same
// (about 220 ms), one with 40,000 about 1.6 s.
export const MAX_SEMANTIC_SOURCE_BATCH_BYTES = 8 * 1024 * 1024;
export const MIN_SEMANTIC_SOURCE_RECORD_BYTES = 128;
export const MIN_SEMANTIC_SOURCE_PROOF_BYTES = 176;
export const MAX_SEMANTIC_SOURCE_RECORDS = Math.floor(
  MAX_SEMANTIC_SOURCE_BATCH_BYTES / MIN_SEMANTIC_SOURCE_RECORD_BYTES,
);
export const MAX_SEMANTIC_SOURCE_PROOFS = Math.floor(
  MAX_SEMANTIC_SOURCE_BATCH_BYTES / MIN_SEMANTIC_SOURCE_PROOF_BYTES,
);
export const MAX_SEMANTIC_SELECTED_OPTION_NODE_IDS = 32;
export const MAX_SEMANTIC_SELECT_SIZE = 1_000;
/** The most dots a masked credential field shows in the replica (D91). */
export const MAX_SEMANTIC_MASKED_LENGTH = 256;
export const MAX_SEMANTIC_SOURCE_TEXT = 3_500;
export const MAX_SEMANTIC_SOURCE_UNACKED_BATCHES = 4;
// Never below the mirror's node cap, whatever it is set to: a walk that runs
// out of identities treats the whole document as secret.
export const MAX_SEMANTIC_SOURCE_NODE_IDENTITIES = MAX_HTML_MIRROR_NODES_SETTING;

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
  readonly protocolVersion: SemanticSourceProtocolVersion;
  readonly kind: 'simul:semantic-source-v2:start';
  readonly bridge: SemanticSourceBridgeId;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly policyFingerprint: string;
  readonly scope: ReplicaReadScope;
}

export interface SemanticSourceAckMessage {
  readonly protocolVersion: SemanticSourceProtocolVersion;
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
  /**
   * Shown as the page has it and never offered for translation (D223): the
   * text of a menu's panel past its cut (D219), which the mirror withholds
   * as hidden text and would otherwise draw blank. Absent for other text.
   */
  readonly untranslated?: true;
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
 * A strict non-ARIA menu inferred from one common wrapper. The relationship is
 * structural only: the replica opens it on the reader's hover and while the
 * source page shows it, and never dispatches source activation.
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
  /**
   * The panel is offered cut at 8,192 nodes (D219, the owner's D218): text
   * past the cut is sent flagged `untranslated` and shown as the page has
   * it (D223). Only in a batch of version 3; absent for a whole panel.
   */
  readonly cut?: true;
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

/**
 * How many characters a credential input holds (D91): a password, card-number
 * or one-time-code field the page draws as dots. Only the count travels,
 * capped at `MAX_SEMANTIC_MASKED_LENGTH`; the replica draws that many dots.
 */
export interface SemanticMaskedLengthProof {
  readonly kind: 'masked-length';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of the credential input. */
  readonly nodeId: number;
  /** Monotonic revision for this proof identity. */
  readonly revision: number;
  readonly gate: 'formValues';
  readonly length: number;
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
 * slider/spinbutton `valueinput` are user input (formValues); `current`,
 * `expanded` and the read-only indicator `valuenow` are page state
 * (controlSemantics). Every value is a bounded token or a bounded decimal;
 * `aria-valuetext` (free text) never travels. `valueinput` carries the same
 * `aria-valuenow` attribute as `valuenow`, but from a user-editable
 * slider/spinbutton, so it reads under the form-value gate rather than the
 * page-state gate.
 *
 * `expanded` is there for the page's stylesheet (D132): a rule such as
 * `button[aria-expanded="true"] + ul` shows a menu, and the base graph never
 * carries the attribute, since the replica's own menu previews write it on
 * their triggers. It is sent only for an element no preview claims.
 */
export type SemanticAriaState =
  | 'checked'
  | 'selected'
  | 'pressed'
  | 'current'
  | 'expanded'
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
    value === 'current' || value === 'expanded' || value === 'valuenow' ||
    value === 'valueinput';
}

/** User input reads under formValues; read-only page state under controlSemantics. */
export function semanticAriaStateGate(
  state: SemanticAriaState,
): SemanticAriaStateGate {
  return state === 'current' || state === 'expanded' || state === 'valuenow'
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
  if (state === 'selected' || state === 'expanded') {
    return value === 'true' || value === 'false';
  }
  return value === 'true' || value === 'false' || value === 'mixed';
}

/**
 * A popover the page is showing (D132). The Popover API opens one without
 * changing any attribute, so nothing in the base graph says it is open and
 * the replica kept it hidden. Only the fact travels, and only while it holds:
 * a closed popover has no proof.
 */
export interface SemanticPopoverOpenProof {
  readonly kind: 'popover-open';
  readonly bridge: SemanticSourceBridgeId;
  /** Native bridge identity of the element with the `popover` attribute. */
  readonly nodeId: number;
  /** Monotonic revision for this proof identity. */
  readonly revision: number;
  readonly gate: 'controlSemantics';
  readonly classifierVersion: typeof SOURCE_SECRET_CLASSIFIER_VERSION;
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
  | SemanticMaskedLengthProof
  | SemanticControlStateProof
  | SemanticAriaStateProof
  | SemanticAriaRelationshipProof
  | SemanticPopoverOpenProof;

/**
 * What a batch of version 3 changes in the state the batch before it left
 * (D179). The receiver holds the page's state in the page's order:
 *
 * 1. every id in `removedRecordIds` and `removedProofIds` leaves it;
 * 2. every record and proof the batch carries replaces the one of its id in
 *    place, or is new;
 * 3. every id named in the placements is taken out of the order (a new one
 *    was never in it), and then, pair by pair, put right after the id the
 *    pair names (`0` or `''`: first). That id is one left in the order or
 *    one placed by an earlier pair, and no two pairs name the same one.
 *
 * The counts are the sizes of the state after the change. A batch that
 * breaks any of this is a broken stream: the panel lets the session go and
 * the next one starts with a whole state.
 */
export interface SemanticSourceBatchDelta {
  /** The sequence of the batch this one changes: the one before it. */
  readonly base: number;
  readonly removedRecordIds: readonly number[];
  readonly removedProofIds: readonly string[];
  /** `[recordId, afterRecordId]` pairs, flattened, in the new order. */
  readonly recordPlacements: readonly number[];
  /** `[proofId, afterProofId]` pairs, flattened, in the new order. */
  readonly proofPlacements: readonly string[];
  readonly recordCount: number;
  readonly proofCount: number;
}

/**
 * The admitted semantic set for one policy epoch: whole (a checkpoint), or,
 * in version 3 with `delta`, what changed since the batch before (D179).
 */
export interface SemanticSourceBatch {
  readonly protocolVersion: SemanticSourceProtocolVersion;
  readonly kind: 'simul:semantic-source-v2:batch';
  readonly document: ReplicaSourceDocumentIdentity;
  readonly policyFingerprint: string;
  readonly sequence: number;
  /** A whole state, or with `delta` the records that are new or changed. */
  readonly records: readonly SemanticSourceRecord[];
  readonly proofs: readonly SemanticSourceProof[];
  readonly byteLength: number;
  readonly delta?: SemanticSourceBatchDelta;
  /**
   * Only in version 3: how far the rules of the page's stylesheet links
   * that make text secret reach, for the links the page could read (D191).
   * The panel cannot read a sheet of another origin in its frame; absent,
   * or a link not named, it asks everything again at every live patch.
   */
  readonly linkedSheets?: PageLinkedSheets;
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
  protocolVersion: SemanticSourceProtocolVersion = SEMANTIC_SOURCE_PROTOCOL_VERSION,
): SemanticSourceStartMessage {
  const exactScope = readExactReplicaReadScope(scope);
  if (!exactScope) throw new Error('Invalid semantic read scope.');
  return Object.freeze({
    protocolVersion,
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
  protocolVersion: SemanticSourceProtocolVersion = SEMANTIC_SOURCE_PROTOCOL_VERSION,
): SemanticSourceAckMessage {
  if (!isPolicyFingerprint(policyFingerprint) || !positiveSafeInteger(sequence)) {
    throw new Error('Invalid semantic source acknowledgement.');
  }
  return Object.freeze({
    protocolVersion,
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
  if (!isRecord(input) || !isSemanticSourceProtocolVersion(input.protocolVersion)) {
    return undefined;
  }
  const protocolVersion = input.protocolVersion;
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
      protocolVersion,
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
    protocolVersion,
    kind: input.kind,
    document,
    policyFingerprint: input.policyFingerprint,
    sequence: input.sequence,
  });
}

export function isSemanticSourceProtocolVersion(
  value: unknown,
): value is SemanticSourceProtocolVersion {
  return value === SEMANTIC_SOURCE_PROTOCOL_VERSION ||
    value === SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION;
}

export function createSemanticSourceBatch(
  document: ReplicaSourceDocumentIdentity,
  policyFingerprint: string,
  sequence: number,
  records: readonly SemanticSourceRecord[],
  proofs: readonly SemanticSourceProof[] = [],
  options: {
    readonly protocolVersion?: SemanticSourceProtocolVersion;
    /** Only in version 3: the batch carries what changed (D179). */
    readonly delta?: SemanticSourceBatchDelta;
    /** Only in version 3: what the page read of its links (D191). */
    readonly linkedSheets?: PageLinkedSheets;
  } = {},
): SemanticSourceBatch {
  if (!isPolicyFingerprint(policyFingerprint) || !positiveSafeInteger(sequence)) {
    throw new Error('Invalid semantic source batch identity.');
  }
  const protocolVersion = options.protocolVersion ?? SEMANTIC_SOURCE_PROTOCOL_VERSION;
  const delta = options.delta && Object.freeze({
    base: options.delta.base,
    removedRecordIds: Object.freeze([...options.delta.removedRecordIds]),
    removedProofIds: Object.freeze([...options.delta.removedProofIds]),
    recordPlacements: Object.freeze([...options.delta.recordPlacements]),
    proofPlacements: Object.freeze([...options.delta.proofPlacements]),
    recordCount: options.delta.recordCount,
    proofCount: options.delta.proofCount,
  });
  const linkedSheets = options.linkedSheets && Object.freeze({
    reach: options.linkedSheets.reach,
    hrefs: Object.freeze([...options.linkedSheets.hrefs]),
  });
  const byteLength = semanticSourceBatchByteLength(records, proofs, delta, linkedSheets);
  const batch = {
    protocolVersion,
    kind: 'simul:semantic-source-v2:batch' as const,
    document,
    policyFingerprint,
    sequence,
    records: Object.freeze([...records]),
    proofs: Object.freeze([...proofs]),
    byteLength,
    ...(delta ? { delta } : {}),
    ...(linkedSheets ? { linkedSheets } : {}),
  };
  const read = readSemanticSourceBatch(batch, document, policyFingerprint);
  if (!read) throw new Error('Invalid semantic source batch.');
  return read;
}

export function semanticSourceBatchByteLength(
  records: readonly SemanticSourceRecord[],
  proofs: readonly SemanticSourceProof[] = [],
  delta?: SemanticSourceBatchDelta,
  linkedSheets?: PageLinkedSheets,
): number {
  let bytes = 0;
  if (linkedSheets) {
    bytes += 32;
    for (const href of linkedSheets.hrefs) bytes += href.length * 2 + 16;
  }
  if (delta) {
    // Each id as a record would count its number, and each proof id its
    // characters, beside a fixed part for the counts (D179).
    bytes += 64 + (delta.removedRecordIds.length + delta.recordPlacements.length) * 16;
    for (const proofId of delta.removedProofIds) bytes += proofId.length * 2 + 16;
    for (const proofId of delta.proofPlacements) bytes += proofId.length * 2 + 16;
  }
  for (const record of records) {
    bytes += record.text.length * 2 + record.tagName.length +
      record.type.length + record.autocomplete.length + record.role.length +
      record.contentEditable.length + record.gate.length +
      record.presentation.length + MIN_SEMANTIC_SOURCE_RECORD_BYTES +
      (record.untranslated ? 24 : 0);
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
      bytes += MIN_SEMANTIC_SOURCE_PROOF_BYTES;
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
  if (!isRecord(input) ||
    !isSemanticSourceProtocolVersion(input.protocolVersion) ||
    // Only version 3 knows a batch of what changed (D179).
    !hasExactKeys(input, [
      ...SEMANTIC_SOURCE_BATCH_KEYS,
      // Only version 3 knows these (D179, D191).
      ...input.protocolVersion === SEMANTIC_SOURCE_PROTOCOL_VERSION
        ? (['delta', 'linkedSheets'] as const).filter((key) => Object.hasOwn(input, key))
        : [],
    ]) ||
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
  const delta = Object.hasOwn(input, 'delta')
    ? readSemanticSourceBatchDelta(input.delta, input.sequence, recordIds, proofIds)
    : undefined;
  if (Object.hasOwn(input, 'delta') && !delta) return undefined;
  const linkedSheets = Object.hasOwn(input, 'linkedSheets')
    ? readPageLinkedSheetsField(input.linkedSheets)
    : undefined;
  if (Object.hasOwn(input, 'linkedSheets') && !linkedSheets) return undefined;
  const computedBytes = semanticSourceBatchByteLength(records, proofs, delta, linkedSheets);
  const byteLength = Number(input.byteLength);
  if (byteLength !== computedBytes || computedBytes > MAX_SEMANTIC_SOURCE_BATCH_BYTES) {
    return undefined;
  }
  return Object.freeze({
    protocolVersion: input.protocolVersion,
    kind: input.kind,
    document,
    policyFingerprint: input.policyFingerprint,
    sequence: input.sequence,
    records: Object.freeze(records),
    proofs: Object.freeze(proofs),
    byteLength,
    ...(delta ? { delta } : {}),
    ...(linkedSheets ? { linkedSheets } : {}),
  });
}

/** The shape of what the page says of its links (D191). */
function readPageLinkedSheetsField(value: unknown): PageLinkedSheets | undefined {
  if (
    !isRecord(value) || !hasExactKeys(value, ['reach', 'hrefs']) ||
    (value.reach !== 'subtree' && value.reach !== 'siblings' && value.reach !== 'everything') ||
    !Array.isArray(value.hrefs) || value.hrefs.length > MAX_PAGE_LINKED_SHEETS
  ) return undefined;
  const hrefs: string[] = [];
  for (const href of value.hrefs) {
    if (
      typeof href !== 'string' || href.length > MAX_PAGE_LINKED_SHEET_HREF_LENGTH ||
      !/^https?:/iu.test(href) || hrefs.includes(href)
    ) return undefined;
    hrefs.push(href);
  }
  return Object.freeze({ reach: value.reach, hrefs: Object.freeze(hrefs) });
}

const SEMANTIC_SOURCE_BATCH_KEYS = Object.freeze([
  'protocolVersion', 'kind', 'document', 'policyFingerprint', 'sequence',
  'records', 'proofs', 'byteLength',
]);
/** The longest proof id: a structural menu's names three bridge ids. */
const MAX_SEMANTIC_SOURCE_PROOF_ID_LENGTH = 128;

/**
 * The shape of what a batch changes (D179); whether it fits the state it
 * changes is the receiver's to check. An id is removed at most once, placed
 * at most once, never both removed and carried, and every pair names a real
 * id after one placed earlier or none.
 */
function readSemanticSourceBatchDelta(
  input: unknown,
  sequence: number,
  carriedRecordIds: ReadonlySet<number>,
  carriedProofIds: ReadonlySet<string>,
): SemanticSourceBatchDelta | undefined {
  if (!isRecord(input) || !hasExactKeys(input, [
    'base', 'removedRecordIds', 'removedProofIds', 'recordPlacements',
    'proofPlacements', 'recordCount', 'proofCount',
  ]) ||
    !positiveSafeInteger(input.base) || input.base !== sequence - 1 ||
    !Array.isArray(input.removedRecordIds) ||
    input.removedRecordIds.length > MAX_SEMANTIC_SOURCE_RECORDS ||
    !Array.isArray(input.removedProofIds) ||
    input.removedProofIds.length > MAX_SEMANTIC_SOURCE_PROOFS ||
    !Array.isArray(input.recordPlacements) ||
    input.recordPlacements.length % 2 !== 0 ||
    input.recordPlacements.length > MAX_SEMANTIC_SOURCE_RECORDS * 2 ||
    !Array.isArray(input.proofPlacements) ||
    input.proofPlacements.length % 2 !== 0 ||
    input.proofPlacements.length > MAX_SEMANTIC_SOURCE_PROOFS * 2 ||
    !Number.isSafeInteger(input.recordCount) || Number(input.recordCount) < 0 ||
    Number(input.recordCount) > MAX_SEMANTIC_SOURCE_RECORDS ||
    !Number.isSafeInteger(input.proofCount) || Number(input.proofCount) < 0 ||
    Number(input.proofCount) > MAX_SEMANTIC_SOURCE_PROOFS
  ) return undefined;
  const removedRecordIds = new Set<number>();
  for (const recordId of input.removedRecordIds) {
    if (
      !positiveSafeInteger(recordId) || removedRecordIds.has(recordId) ||
      carriedRecordIds.has(recordId)
    ) return undefined;
    removedRecordIds.add(recordId);
  }
  const removedProofIds = new Set<string>();
  for (const proofId of input.removedProofIds) {
    if (
      !isSemanticSourceProofId(proofId) || removedProofIds.has(proofId) ||
      carriedProofIds.has(proofId)
    ) return undefined;
    removedProofIds.add(proofId);
  }
  const placedRecordIds = new Set<number>();
  for (let index = 0; index < input.recordPlacements.length; index += 2) {
    const recordId = input.recordPlacements[index];
    const after = input.recordPlacements[index + 1];
    if (
      !positiveSafeInteger(recordId) || removedRecordIds.has(recordId) ||
      placedRecordIds.has(recordId) ||
      !Number.isSafeInteger(after) || Number(after) < 0 || after === recordId ||
      removedRecordIds.has(after as number)
    ) return undefined;
    placedRecordIds.add(recordId);
  }
  const placedProofIds = new Set<string>();
  for (let index = 0; index < input.proofPlacements.length; index += 2) {
    const proofId = input.proofPlacements[index];
    const after = input.proofPlacements[index + 1];
    if (
      !isSemanticSourceProofId(proofId) || removedProofIds.has(proofId) ||
      placedProofIds.has(proofId) ||
      typeof after !== 'string' || after === proofId ||
      (after !== '' && (!isSemanticSourceProofId(after) || removedProofIds.has(after)))
    ) return undefined;
    placedProofIds.add(proofId);
  }
  return Object.freeze({
    base: input.base,
    removedRecordIds: Object.freeze([...removedRecordIds]),
    removedProofIds: Object.freeze([...removedProofIds]),
    recordPlacements: Object.freeze([...input.recordPlacements as number[]]),
    proofPlacements: Object.freeze([...input.proofPlacements as string[]]),
    recordCount: input.recordCount as number,
    proofCount: input.proofCount as number,
  });
}

function isSemanticSourceProofId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 &&
    value.length <= MAX_SEMANTIC_SOURCE_PROOF_ID_LENGTH &&
    /^semantic-[a-z-]+-v1:[0-9a-z:]+$/u.test(value);
}

/**
 * Where each id of `next` that is new or out of the old order goes (D179):
 * the ids of `previous` that stay in the same order among themselves (the
 * longest such run) stay; every other id of `next` is placed right after
 * the id before it in `next`, or first (`head`). Pairs come flattened, in
 * the order of `next`, as `SemanticSourceBatchDelta` reads them.
 */
export function semanticSourceOrderPlacements<Id>(
  previous: readonly Id[],
  next: readonly Id[],
  head: Id,
): Id[] {
  const previousIndex = new Map<Id, number>();
  previous.forEach((id, index) => previousIndex.set(id, index));
  // The longest increasing run of old positions, in the order of `next`
  // (patience sorting: n log n).
  const positions: number[] = [];
  const indexes: number[] = [];
  for (let index = 0; index < next.length; index += 1) {
    const position = previousIndex.get(next[index]!);
    if (position === undefined) continue;
    positions.push(position);
    indexes.push(index);
  }
  const tails: number[] = [];
  const tailIndexes: number[] = [];
  const parents = new Array<number>(positions.length).fill(-1);
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index]!;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (tails[middle]! < position) low = middle + 1;
      else high = middle;
    }
    if (low > 0) parents[index] = tailIndexes[low - 1]!;
    tails[low] = position;
    tailIndexes[low] = index;
  }
  const stays = new Set<number>();
  for (
    let index = tailIndexes.length > 0 ? tailIndexes[tailIndexes.length - 1]! : -1;
    index >= 0;
    index = parents[index]!
  ) stays.add(indexes[index]!);
  const placements: Id[] = [];
  for (let index = 0; index < next.length; index += 1) {
    if (stays.has(index)) continue;
    placements.push(next[index]!, index > 0 ? next[index - 1]! : head);
  }
  return placements;
}

/**
 * The order a delta leaves (D179), from the order before it: undefined when
 * the delta does not fit it. `kept` says whether an id is still in the state
 * (not removed); new ids must be placed, and every placed id must be in the
 * state once placed.
 */
export function applySemanticSourceOrderPlacements<Id>(
  previous: readonly Id[],
  removed: ReadonlySet<Id>,
  placements: readonly Id[],
  head: Id,
): Id[] | undefined {
  const placed = new Set<Id>();
  for (let index = 0; index < placements.length; index += 2) placed.add(placements[index]!);
  const positioned = new Set<Id>();
  const stable: Id[] = [];
  for (const id of previous) {
    if (removed.has(id) || placed.has(id)) continue;
    stable.push(id);
    positioned.add(id);
  }
  const chain = new Map<Id, Id>();
  for (let index = 0; index < placements.length; index += 2) {
    const id = placements[index]!;
    const after = placements[index + 1]!;
    if (positioned.has(id) || chain.has(after) || (after !== head && !positioned.has(after))) {
      return undefined;
    }
    chain.set(after, id);
    positioned.add(id);
  }
  const order: Id[] = [];
  const follow = (from: Id): void => {
    for (let id = chain.get(from); id !== undefined; id = chain.get(id)) order.push(id);
  };
  follow(head);
  for (const id of stable) {
    order.push(id);
    follow(id);
  }
  return order.length === positioned.size ? order : undefined;
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
  if (input.kind === 'masked-length') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate', 'length',
      'classifierVersion',
    ]) || input.gate !== 'formValues' ||
      !positiveSafeInteger(input.nodeId) ||
      !Number.isSafeInteger(input.length) || Number(input.length) < 0 ||
      Number(input.length) > MAX_SEMANTIC_MASKED_LENGTH
    ) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: input.gate,
      length: input.length as number,
      classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
    });
  }
  if (input.kind === 'popover-open') {
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'nodeId', 'revision', 'gate', 'classifierVersion',
    ]) || input.gate !== 'controlSemantics' ||
      !positiveSafeInteger(input.nodeId)
    ) return undefined;
    return Object.freeze({
      kind: input.kind,
      bridge: input.bridge,
      nodeId: input.nodeId,
      revision: input.revision,
      gate: input.gate,
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
    const cut = Object.hasOwn(input, 'cut');
    if (!hasExactKeys(input, [
      'kind', 'bridge', 'relationId', 'revision', 'gate', 'containerNodeId',
      'triggerNodeId', 'panelNodeId', 'popupRole', 'expanded',
      'classifierVersion', ...(cut ? ['cut'] : []),
    ]) || (cut && input.cut !== true) || input.gate !== 'disclosureContent' ||
      !positiveSafeInteger(input.containerNodeId) ||
      !positiveSafeInteger(input.triggerNodeId) ||
      !positiveSafeInteger(input.panelNodeId) ||
      input.popupRole !== 'menu' || typeof input.expanded !== 'boolean' ||
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
      ...(cut ? { cut: true as const } : {}),
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
  if (proof.kind === 'masked-length') {
    return `semantic-masked-length-v1:${proof.nodeId}`;
  }
  if (proof.kind === 'control-state') return `semantic-control-v1:${proof.nodeId}`;
  if (proof.kind === 'popover-open') {
    return `semantic-popover-open-v1:${proof.nodeId}`;
  }
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
  if (proof.kind === 'masked-length') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, proof.length,
    proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'control-state') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, Number(proof.disabled),
    proof.classifierVersion,
  ].join('\u0000');
  if (proof.kind === 'popover-open') return [
    proof.bridge, proof.kind, proof.nodeId, proof.gate, proof.classifierVersion,
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
    // A whole panel signs as before D219.
    ...(proof.cut ? ['cut'] : []),
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
  const untranslated = isRecord(input) && Object.hasOwn(input, 'untranslated');
  if (!isRecord(input) || !hasExactKeys(input, [
    'bridge', 'recordId', 'nodeId', 'nodeRevision', 'category', 'gate',
    'tagName', 'type', 'autocomplete', 'role', 'contentEditable', 'text',
    'presentation', 'classifierVersion', ...(untranslated ? ['untranslated'] : []),
  ]) ||
    // Only a menu's text past its cut (D223).
    (untranslated && (
      input.untranslated !== true || input.gate !== 'disclosureContent' ||
      input.presentation !== 'text'
    )) ||
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
    ...(untranslated ? { untranslated: true as const } : {}),
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
