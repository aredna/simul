import type { ReplicaTextProjection } from '../translation/replica-translation-coordinator';
import type {
  ReplicaSourceTextChange,
  ReplicaSourceTextRecord,
} from './source-text-record';
import {
  StickySourceSecretClassifier,
  classifySourceEvidence,
  isMaskableInputFacts,
  sourceFactsAreSecret,
  type SourceClassificationFacts,
} from './source-secret-classifier';
import {
  semanticSourceProofIdentity,
  semanticSourceProofSignature,
  semanticSourceRecordId,
  type SemanticSourceBatch,
  type SemanticSourceProof,
  type SemanticSourcePresentation,
  type SemanticSourceRecord,
  isSemanticAriaStateValue,
  type SemanticAriaState,
} from './semantic-source-protocol';
import {
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from './source-identity';
import { readSourceFlatTreeElementPath } from './source-privacy-policy';
import {
  MAX_STRUCTURAL_MENU_TRIGGERS,
  isPlainStructuralMenuTrigger,
  isStructuralMenuPanelElement,
  structuralMenuOpening,
  structuralMenuPanelCandidates,
  type StructuralMenuOpening,
} from './structural-menu-shape';

export interface SemanticSourceReceiverEnvironment {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replicaDocument: Document;
  readonly resolveNode: (nodeId: number) => Node | null | undefined;
  /** Atomically projects only receiver-validated typed state/relationships. */
  readonly applyProofs?: (
    proofs: readonly ResolvedSemanticSourceProof[],
  ) => boolean;
  /** Told how many records and proofs a committed batch dropped (D96). */
  readonly reportDroppedItems?: (records: number, proofs: number) => void;
}

export type ResolvedSemanticSourceProof =
  | {
      readonly kind: 'select-state';
      readonly proof: Extract<SemanticSourceProof, { kind: 'select-state' }>;
      readonly target: HTMLSelectElement;
      readonly selectedOptions: readonly HTMLOptionElement[];
    }
  | {
      readonly kind: 'select-presentation';
      readonly proof: Extract<SemanticSourceProof, {
        kind: 'select-presentation';
      }>;
      readonly target: HTMLSelectElement;
    }
  | {
      readonly kind: 'choice-state';
      readonly proof: Extract<SemanticSourceProof, { kind: 'choice-state' }>;
      readonly target: HTMLInputElement;
    }
  | {
      readonly kind: 'masked-length';
      readonly proof: Extract<SemanticSourceProof, { kind: 'masked-length' }>;
      readonly target: HTMLInputElement;
    }
  | {
      readonly kind: 'control-state';
      readonly proof: Extract<SemanticSourceProof, { kind: 'control-state' }>;
      readonly target: HTMLElement;
    }
  | {
      readonly kind: 'aria-state';
      readonly proof: Extract<SemanticSourceProof, { kind: 'aria-state' }>;
      readonly target: HTMLElement;
    }
  | {
      readonly kind: 'popover-open';
      readonly proof: Extract<SemanticSourceProof, { kind: 'popover-open' }>;
      readonly target: HTMLElement;
    }
  | {
      readonly kind: 'aria-relationship';
      readonly proof: Extract<SemanticSourceProof, {
        kind: 'aria-relationship';
      }>;
      readonly target: HTMLElement;
      /** Replica references in author order, filtered to represented, safe,
       * same-tree-scope nodes. */
      readonly references: readonly HTMLElement[];
    }
  | {
      readonly kind: 'tab-state';
      readonly proof: Extract<SemanticSourceProof, { kind: 'tab-state' }>;
      readonly trigger: HTMLElement;
      readonly panel: HTMLElement;
      /** Receiver-validated existing CSS/ARIA identity, when safe and unique. */
      readonly panelId: string | undefined;
    }
  | {
      readonly kind: 'disclosure-state';
      readonly proof: Extract<SemanticSourceProof, { kind: 'disclosure-state' }>;
      readonly trigger: HTMLElement;
      readonly panel: HTMLElement;
    }
  | {
      readonly kind: 'structural-menu';
      readonly proof: Extract<SemanticSourceProof, { kind: 'structural-menu' }>;
      readonly container: HTMLElement;
      readonly trigger: HTMLElement;
      /** A second trigger in the container: an arrow button beside a link. */
      readonly otherTriggers: readonly HTMLElement[];
      readonly panel: HTMLElement;
      /** On hover in navigation; on a click only for a button menu elsewhere. */
      readonly opening: StructuralMenuOpening;
    };

interface SemanticBinding {
  readonly target: Node;
  readonly presentation: SemanticSourcePresentation;
  /**
   * False for an accessible name: nothing draws it, so it is kept for the
   * dropdown and menu logic but not translated.
   */
  readonly translatable: boolean;
  write(text: string): boolean;
  restore(): boolean;
  reapply(): boolean;
  snapshot(): (() => boolean) | undefined;
}

interface SemanticEntry {
  readonly sourceRecord: SemanticSourceRecord;
  readonly translationRecord: ReplicaSourceTextRecord;
  readonly binding: SemanticBinding;
}

interface SemanticIdentityHistory {
  readonly nodeId: number;
  readonly presentation: SemanticSourcePresentation;
  readonly revision: number;
  readonly signature: string;
}

interface SemanticProofHistory {
  readonly revision: number;
  readonly signature: string;
}

const SEMANTIC_SELECTION_TEXT = new WeakMap<Element, string>();
/**
 * Every admitted text is shown as the page has it; only text with a letter
 * or a digit is offered for translation (D132). `$`, `★★★` or `--` as an
 * option's label used to be dropped on the page side, and the row was blank.
 */
const TRANSLATABLE_SOURCE_TEXT = /[\p{L}\p{N}]/u;
/** Editor text of one batch that is tried again; see `placeArrivedNodes`. */
const MAX_UNPLACED_EDITOR_TEXT = 256;

/**
 * Returns renderer-owned semantic selection text without encoding source text
 * in a replica attribute or in an element of the mirror.
 */
export function semanticSelectionTextFor(element: Element): string | undefined {
  return SEMANTIC_SELECTION_TEXT.get(element);
}

/**
 * Revalidates source claims against the inert replica node and exposes them as
 * negative translation identities, keeping native bridge IDs collision-free.
 */
export class SemanticSourceReceiver {
  readonly #entries = new Map<number, SemanticEntry>();
  readonly #identityHistory = new Map<number, SemanticIdentityHistory>();
  readonly #proofHistory = new Map<string, SemanticProofHistory>();
  readonly #proofs = new Map<string, ResolvedSemanticSourceProof>();
  readonly #classifier = new StickySourceSecretClassifier();
  #lastSequence = 0;
  #proofPresentationHealthy = true;
  /**
   * The last batch taken, and the nodes it names that the replica did not
   * have (D132). A batch is the page's whole state and is sent once; see
   * `placeArrivedNodes`.
   */
  #lastBatch: SemanticSourceBatch | undefined;
  #missingNodeIds = new Set<number>();
  /** Where one pass notes the nodes it cannot find. */
  #missingNodeNotes: Set<number> | undefined;
  /**
   * Text of the last batch whose node the replica held and did not yet take
   * for editor text; see `placeArrivedNodes`.
   */
  #unplacedEditorText: SemanticSourceRecord[] = [];
  #unplacedEditorTextNotes: SemanticSourceRecord[] | undefined;
  /**
   * For one pass: whether an element or anything above it is secret. The
   * options of one dropdown share every ancestor, so the walk up is made
   * once for all of them.
   */
  #passSecretAncestors: Map<Element, boolean> | undefined;

  constructor(private readonly environment: SemanticSourceReceiverEnvironment) {}

  records(): readonly ReplicaSourceTextRecord[] {
    const records: ReplicaSourceTextRecord[] = [];
    for (const entry of this.#entries.values()) {
      if (entryIsTranslated(entry)) records.push(entry.translationRecord);
    }
    return Object.freeze(records);
  }

  get(projectionNodeId: number): ReplicaSourceTextRecord | undefined {
    return this.#entries.get(projectionNodeId)?.translationRecord;
  }

  get proofPresentationHealthy(): boolean {
    return this.#proofPresentationHealthy;
  }

  applyBatch(batch: SemanticSourceBatch): readonly ReplicaSourceTextChange[] | undefined {
    if (
      !sameSourceDocument(batch.document, this.environment.document) ||
      batch.sequence !== this.#lastSequence + 1
    ) {
      return undefined;
    }
    const changes = this.#placeBatch(batch);
    if (!changes) return undefined;
    this.#lastSequence = batch.sequence;
    this.#lastBatch = batch;
    return changes;
  }

  /**
   * Called after a change to the page's structure has been applied. The
   * page's structure and its labels travel separately, and a label or state
   * can arrive before its element does: it is dropped (D96), the page counts
   * it as delivered and does not send it again while its own view is
   * unchanged. So when a node the last batch named and the replica lacked is
   * there now, that batch is gone through again (D132; a dropdown the page
   * added while the mirror was open stayed blank). The same for the text of
   * a box that has just become an editor: it comes before the attribute that
   * says so, and without this the box stayed blank until the page next
   * changed. Undefined when there was nothing to place.
   */
  placeArrivedNodes(): readonly ReplicaSourceTextChange[] | undefined {
    const batch = this.#lastBatch;
    if (!batch) return undefined;
    let arrived = false;
    for (const nodeId of this.#missingNodeIds) {
      if (this.#nodeIsPresent(nodeId)) {
        arrived = true;
        break;
      }
    }
    arrived ||= this.#unplacedEditorText.some(
      (record) => this.#resolveAndValidate(record) !== undefined,
    );
    if (!arrived) return undefined;
    const changes = this.#placeBatch(batch);
    // A pass that could not be committed is not tried again at every change:
    // the page's next batch starts afresh.
    if (!changes) {
      this.#missingNodeIds = new Set();
      this.#unplacedEditorText = [];
    }
    return changes;
  }

  #placeBatch(
    batch: SemanticSourceBatch,
  ): readonly ReplicaSourceTextChange[] | undefined {
    const missing = new Set<number>();
    const unplacedEditorText: SemanticSourceRecord[] = [];
    this.#missingNodeNotes = missing;
    this.#unplacedEditorTextNotes = unplacedEditorText;
    this.#passSecretAncestors = new Map();
    try {
      const changes = this.#placeBatchRecordsAndProofs(batch);
      if (changes) {
        this.#missingNodeIds = missing;
        this.#unplacedEditorText = unplacedEditorText;
      }
      return changes;
    } finally {
      this.#missingNodeNotes = undefined;
      this.#unplacedEditorTextNotes = undefined;
      this.#passSecretAncestors = undefined;
    }
  }

  #placeBatchRecordsAndProofs(
    batch: SemanticSourceBatch,
  ): readonly ReplicaSourceTextChange[] | undefined {
    const plans = new Map<number, {
      readonly sourceRecord: SemanticSourceRecord;
      readonly translationRecord: ReplicaSourceTextRecord;
      readonly binding: SemanticBinding;
      readonly changed: boolean;
    }>();
    // A batch is refused whole only when the stream itself is broken (a
    // forged or repeated identity, a revision rewind). A record or proof the
    // replica cannot place is dropped by itself (D96): one refused item used
    // to refuse the batch, which purged every label, menu and control state
    // and kept them away for as long as the page sent it (D62).
    let droppedRecords = 0;
    for (const sourceRecord of batch.records) {
      if (
        semanticSourceRecordId(
          sourceRecord.nodeId,
          sourceRecord.presentation,
        ) !== sourceRecord.recordId
      ) return undefined;
      const projectionNodeId = semanticProjectionNodeId(sourceRecord.recordId);
      if (projectionNodeId === undefined || plans.has(projectionNodeId)) return undefined;
      const signature = sourceRecordSignature(sourceRecord);
      const history = this.#identityHistory.get(sourceRecord.recordId);
      if (
        history &&
        (
          history.nodeId !== sourceRecord.nodeId ||
          history.presentation !== sourceRecord.presentation ||
          sourceRecord.nodeRevision < history.revision ||
          (sourceRecord.nodeRevision === history.revision &&
            signature !== history.signature)
        )
      ) return undefined;
      const current = this.#entries.get(projectionNodeId);
      const target = this.#resolveAndValidate(sourceRecord);
      // Its node is missing or the replica classifies it differently: any
      // earlier presentation is withdrawn, as for a record no longer sent.
      if (!target) {
        droppedRecords += 1;
        continue;
      }
      const sameBinding = current?.binding.target === target &&
        current.sourceRecord.presentation === sourceRecord.presentation;
      const unchanged = Boolean(
        sameBinding && current &&
        current.sourceRecord.nodeId === sourceRecord.nodeId &&
        current.sourceRecord.nodeRevision === sourceRecord.nodeRevision &&
        current.sourceRecord.text === sourceRecord.text &&
        current.sourceRecord.gate === sourceRecord.gate &&
        current.sourceRecord.category === sourceRecord.category,
      );
      let binding: SemanticBinding | undefined;
      try {
        binding = sameBinding && current
          ? current.binding
          : this.#createBinding(target, sourceRecord.presentation);
      } catch {
        binding = undefined;
      }
      if (!binding) {
        droppedRecords += 1;
        continue;
      }
      plans.set(projectionNodeId, {
        sourceRecord,
        translationRecord: toTranslationRecord(
          this.environment.document,
          projectionNodeId,
          sourceRecord,
        ),
        binding,
        changed: !unchanged,
      });
    }
    const admittedRecords = [...plans.values()].map(({ sourceRecord }) => sourceRecord);
    const proofResolution = this.#resolveProofs(batch.proofs, admittedRecords);
    if (!proofResolution) return undefined;
    const proofPlans = proofResolution.resolved;
    const proofPresentationChanged = !sameResolvedProofSet(
      this.#proofs,
      proofPlans,
    );
    const previousProofs = Object.freeze([...this.#proofs.values()]);

    const changes: ReplicaSourceTextChange[] = [];
    const removals: Array<readonly [number, SemanticEntry]> = [];
    for (const [projectionNodeId, current] of this.#entries) {
      if (plans.has(projectionNodeId)) continue;
      removals.push(Object.freeze([projectionNodeId, current] as const));
      if (!entryIsTranslated(current)) continue;
      changes.push(Object.freeze({
        kind: 'remove',
        document: this.environment.document,
        nodeId: projectionNodeId,
        revision: current.translationRecord.revision + 1,
      }));
    }
    const affectedBindings = new Set<SemanticBinding>();
    for (const [, current] of removals) affectedBindings.add(current.binding);
    for (const [projectionNodeId, plan] of plans) {
      const current = this.#entries.get(projectionNodeId);
      if (!plan.changed && current) continue;
      if (current && current.binding !== plan.binding) {
        affectedBindings.add(current.binding);
      }
      affectedBindings.add(plan.binding);
      if (entryIsTranslated(plan)) {
        changes.push(Object.freeze({ kind: 'upsert', record: plan.translationRecord }));
      } else if (current && entryIsTranslated(current)) {
        // Its new text is not for the translator: the old text's translation
        // goes.
        changes.push(Object.freeze({
          kind: 'remove',
          document: this.environment.document,
          nodeId: projectionNodeId,
          revision: current.translationRecord.revision + 1,
        }));
      }
    }

    const rollbacks: Array<() => boolean> = [];
    for (const binding of affectedBindings) {
      const rollback = binding.snapshot();
      if (!rollback) return undefined;
      rollbacks.push(rollback);
    }
    let committed = true;
    for (const [, current] of removals) {
      if (!current.binding.restore()) {
        committed = false;
        break;
      }
    }
    if (committed) {
      for (const [projectionNodeId, plan] of plans) {
        const current = this.#entries.get(projectionNodeId);
        if (!plan.changed && current) continue;
        if (current && current.binding !== plan.binding &&
          !current.binding.restore()) {
          committed = false;
          break;
        }
        if (!plan.binding.write(plan.sourceRecord.text)) {
          committed = false;
          break;
        }
      }
    }
    if (
      committed && proofPresentationChanged && this.environment.applyProofs
    ) {
      try {
        committed = this.environment.applyProofs(
          Object.freeze([...proofPlans.values()]),
        ) === true;
      } catch {
        committed = false;
      }
    }
    if (!committed) {
      for (let index = rollbacks.length - 1; index >= 0; index -= 1) {
        try {
          rollbacks[index]?.();
        } catch {
          // Continue restoring every captured presentation slot.
        }
      }
      try {
        this.environment.applyProofs?.(previousProofs);
      } catch {
        // A rejected batch remains rejected even if presentation restore fails.
      }
      return undefined;
    }

    this.#entries.clear();
    for (const [projectionNodeId, plan] of plans) {
      this.#entries.set(projectionNodeId, Object.freeze({
        sourceRecord: plan.sourceRecord,
        translationRecord: plan.translationRecord,
        binding: plan.binding,
      }));
      this.#identityHistory.set(plan.sourceRecord.recordId, Object.freeze({
        nodeId: plan.sourceRecord.nodeId,
        presentation: plan.sourceRecord.presentation,
        revision: plan.sourceRecord.nodeRevision,
        signature: sourceRecordSignature(plan.sourceRecord),
      }));
    }
    this.#proofs.clear();
    for (const [proofId, resolved] of proofPlans) {
      this.#proofs.set(proofId, resolved);
      this.#proofHistory.set(proofId, Object.freeze({
        revision: resolved.proof.revision,
        signature: semanticSourceProofSignature(resolved.proof),
      }));
    }
    if (droppedRecords > 0 || proofResolution.dropped > 0) {
      try {
        this.environment.reportDroppedItems?.(
          droppedRecords,
          proofResolution.dropped,
        );
      } catch {
        // Reporting is diagnostic only.
      }
    }
    this.#proofPresentationHealthy = true;
    return Object.freeze(changes);
  }

  /** Restore canonical admitted source before a new translation epoch. */
  restoreSources(): void {
    for (const entry of this.#entries.values()) {
      if (this.#entryIsStillSafe(entry)) {
        entry.binding.write(entry.sourceRecord.text);
      }
    }
    this.#presentCurrentProofs();
  }

  /**
   * Called after base replay patches. Unsafe or disconnected bindings are
   * purged; safe translated/source presentations are reasserted.
   */
  refreshBindings(
    refreshProofPresentation = true,
  ): readonly ReplicaSourceTextChange[] {
    // A node that has gone may come back, as one that never came may arrive.
    this.#missingNodeNotes = this.#missingNodeIds;
    this.#passSecretAncestors = new Map();
    try {
      return this.#refreshBindings(refreshProofPresentation);
    } finally {
      this.#missingNodeNotes = undefined;
      this.#passSecretAncestors = undefined;
    }
  }

  #refreshBindings(
    refreshProofPresentation: boolean,
  ): readonly ReplicaSourceTextChange[] {
    const changes: ReplicaSourceTextChange[] = [];
    for (const [projectionNodeId, entry] of this.#entries) {
      if (this.#entryIsStillSafe(entry) && entry.binding.reapply()) continue;
      const rebound = this.#rebind(entry);
      if (rebound) {
        this.#entries.set(projectionNodeId, rebound);
        if (entryIsTranslated(rebound)) {
          changes.push(Object.freeze({
            kind: 'upsert',
            record: rebound.translationRecord,
          }));
        }
        continue;
      }
      entry.binding.restore();
      this.#entries.delete(projectionNodeId);
      if (!entry.binding.target.isConnected) {
        this.#missingNodeIds.add(entry.sourceRecord.nodeId);
      }
      if (!entryIsTranslated(entry)) continue;
      changes.push(Object.freeze({
        kind: 'remove',
        document: this.environment.document,
        nodeId: projectionNodeId,
        revision: entry.translationRecord.revision + 1,
      }));
    }
    if (!refreshProofPresentation) return Object.freeze(changes);
    const retainedProofs = new Map<string, ResolvedSemanticSourceProof>();
    for (const resolved of this.#proofs.values()) {
      const refreshed = this.#resolveProof(resolved.proof);
      if (refreshed) {
        retainedProofs.set(semanticSourceProofIdentity(resolved.proof), refreshed);
      }
    }
    // A menu whose panel text is gone is no longer presented; the others are.
    const menuTextHolders = this.#elementsHoldingMenuText(
      [...this.#entries.values()].map(({ sourceRecord }) => sourceRecord),
    );
    for (const [proofId, resolved] of retainedProofs) {
      if (
        resolved.kind === 'structural-menu' &&
        !menuTextHolders?.has(resolved.panel)
      ) retainedProofs.delete(proofId);
    }
    let presented = true;
    try {
      presented = this.environment.applyProofs?.(
        Object.freeze([...retainedProofs.values()]),
      ) ?? true;
    } catch {
      presented = false;
    }
    this.#proofPresentationHealthy = presented;
    this.#proofs.clear();
    if (presented) {
      for (const [proofId, proof] of retainedProofs) this.#proofs.set(proofId, proof);
    } else {
      try {
        this.environment.applyProofs?.(Object.freeze([]));
      } catch {
        // Presentation stays fail-closed after a refresh failure.
      }
    }
    return Object.freeze(changes);
  }

  project(projection: ReplicaTextProjection): boolean {
    const entry = this.#entries.get(projection.nodeId);
    if (
      !entry || !this.#entryIsStillSafe(entry) ||
      entry.translationRecord.nodeType !== projection.nodeType ||
      entry.translationRecord.revision !== projection.sourceRevision ||
      entry.translationRecord.source !== projection.source ||
      (entry.translationRecord.nodeType === 1 &&
        (projection.nodeType !== 1 ||
          entry.translationRecord.controlTarget !== projection.controlTarget))
    ) return false;
    const rollback = entry.binding.snapshot();
    if (!rollback || !entry.binding.write(projection.translated)) return false;
    if (this.#presentCurrentProofs()) return true;
    rollback();
    return false;
  }

  /**
   * The element in which a projected record's text shows, for its language
   * (D124): the parent of a text node, the control whose value, placeholder
   * or label it is, or the select whose trigger draws the current choice.
   * Editable text held by itself is drawn nowhere.
   */
  elementShowing(nodeId: number): Element | undefined {
    const binding = this.#entries.get(nodeId)?.binding;
    if (!binding) return undefined;
    const { target, presentation } = binding;
    if (target.nodeType === 3) return target.parentElement ?? undefined;
    return target.nodeType === 1 && presentation !== 'editable'
      ? target as Element
      : undefined;
  }

  clear(): readonly ReplicaSourceTextChange[] {
    try {
      this.environment.applyProofs?.(Object.freeze([]));
    } catch {
      // Text cleanup still proceeds if an owned presenter was already lost.
    }
    this.#proofPresentationHealthy = true;
    this.#proofs.clear();
    const changes: ReplicaSourceTextChange[] = [];
    for (const [projectionNodeId, entry] of this.#entries) {
      entry.binding.restore();
      if (!entryIsTranslated(entry)) continue;
      changes.push(Object.freeze({
        kind: 'remove',
        document: this.environment.document,
        nodeId: projectionNodeId,
        revision: entry.translationRecord.revision + 1,
      }));
    }
    this.#entries.clear();
    this.#lastBatch = undefined;
    this.#missingNodeIds.clear();
    return Object.freeze(changes);
  }

  /**
   * Resolves each proof on its own; `records` are the batch's admitted
   * records. Undefined only for a broken stream (a repeated identity or a
   * revision rewind). A proof the replica cannot place, and every proof in a
   * conflict (two tabs or menus claiming one node, a select state that
   * contradicts its shape), is dropped by itself (D96).
   */
  #resolveProofs(
    proofs: readonly SemanticSourceProof[],
    records: readonly SemanticSourceRecord[],
  ): {
    readonly resolved: Map<string, ResolvedSemanticSourceProof>;
    readonly dropped: number;
  } | undefined {
    const resolved = new Map<string, ResolvedSemanticSourceProof>();
    const seen = new Set<string>();
    let dropped = 0;
    const drop = (proofId: string): void => {
      if (resolved.delete(proofId)) dropped += 1;
    };
    for (const proof of proofs) {
      const proofId = semanticSourceProofIdentity(proof);
      if (seen.has(proofId)) return undefined;
      seen.add(proofId);
      const signature = semanticSourceProofSignature(proof);
      const history = this.#proofHistory.get(proofId);
      if (
        history &&
        (
          proof.revision < history.revision ||
          (proof.revision === history.revision && signature !== history.signature)
        )
      ) return undefined;
      const next = this.#resolveProof(proof);
      if (!next) {
        dropped += 1;
        continue;
      }
      resolved.set(proofId, next);
    }
    // A field whose value travels as text never also shows dots.
    for (const [proofId, value] of resolved) {
      if (value.kind === 'masked-length' && records.some((record) =>
        record.nodeId === value.proof.nodeId && record.presentation === 'value'
      )) resolved.delete(proofId);
    }
    const presentations = new Map<number, Extract<ResolvedSemanticSourceProof, {
      kind: 'select-presentation';
    }>>();
    for (const value of resolved.values()) {
      if (value.kind === 'select-presentation') {
        presentations.set(value.proof.nodeId, value);
      }
    }
    for (const [proofId, value] of [...resolved]) {
      if (value.kind !== 'select-state') continue;
      const presentation = presentations.get(value.proof.nodeId);
      if ((!value.proof.multiple && value.selectedOptions.length > 1) ||
        (value.proof.multiple && value.proof.pickerOpen) ||
        (presentation &&
          presentation.proof.multiple !== value.proof.multiple)) {
        // The select's state and shape disagree: neither is presented.
        drop(proofId);
        if (presentation) {
          drop(semanticSourceProofIdentity(presentation.proof));
        }
      }
    }
    // Two tab or menu relationships claiming one node are ambiguous; every
    // relationship involved is dropped, and the others stay.
    const dropClaimConflicts = (
      claims: (value: ResolvedSemanticSourceProof) => readonly string[] | undefined,
    ): void => {
      const owners = new Map<string, string[]>();
      for (const [proofId, value] of resolved) {
        for (const claim of claims(value) ?? []) {
          owners.set(claim, [...owners.get(claim) ?? [], proofId]);
        }
      }
      for (const proofIds of owners.values()) {
        if (proofIds.length > 1) proofIds.forEach(drop);
      }
    };
    dropClaimConflicts((value) => value.kind === 'tab-state'
      ? [`trigger:${value.proof.tabNodeId}`, `panel:${value.proof.panelNodeId}`]
      : undefined);
    dropClaimConflicts((value) => value.kind === 'structural-menu'
      ? [
          `container:${value.proof.containerNodeId}`,
          `trigger:${value.proof.triggerNodeId}`,
          `panel:${value.proof.panelNodeId}`,
        ]
      : undefined);
    // A menu is presented only with admitted panel text.
    const menuTextHolders = this.#elementsHoldingMenuText(records);
    for (const [proofId, value] of [...resolved]) {
      if (
        value.kind === 'structural-menu' &&
        !menuTextHolders?.has(value.panel)
      ) drop(proofId);
    }
    return { resolved, dropped };
  }

  #resolveProof(
    proof: SemanticSourceProof,
  ): ResolvedSemanticSourceProof | undefined {
    if (proof.kind === 'select-state') {
      const target = this.#resolveElement(proof.nodeId);
      if (!target || target.localName.toLowerCase() !== 'select' ||
        !this.#proofTargetIsSafe(target, true)) return undefined;
      const selectedOptions: HTMLOptionElement[] = [];
      for (const nodeId of proof.selectedOptionNodeIds) {
        const option = this.#resolveElement(nodeId);
        if (!option || option.localName.toLowerCase() !== 'option' ||
          option.ownerDocument !== target.ownerDocument ||
          !target.contains(option) || !this.#proofTargetIsSafe(option, false)) {
          return undefined;
        }
        selectedOptions.push(option as HTMLOptionElement);
      }
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLSelectElement,
        selectedOptions: Object.freeze(selectedOptions),
      });
    }
    if (proof.kind === 'select-presentation') {
      const target = this.#resolveElement(proof.nodeId);
      if (!target || target.localName.toLowerCase() !== 'select' ||
        !this.#proofTargetIsSafe(target, false)) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLSelectElement,
      });
    }
    if (proof.kind === 'choice-state') {
      const target = this.#resolveElement(proof.nodeId);
      const type = target ? safeAttribute(target, 'type').trim().toLowerCase() : '';
      if (!target || target.localName.toLowerCase() !== 'input' ||
        (type !== 'checkbox' && type !== 'radio') ||
        (type === 'radio' && proof.indeterminate) ||
        !this.#proofTargetIsSafe(target, true)) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLInputElement,
      });
    }
    if (proof.kind === 'masked-length') {
      // Only a count travels, so no replica check can leak anything; the
      // field must simply be one that draws its value as text.
      const target = this.#resolveElement(proof.nodeId);
      if (!target || !isMaskableInputFacts({
        tagName: target.localName.toLowerCase(),
        type: safeAttribute(target, 'type'),
      })) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLInputElement,
      });
    }
    if (proof.kind === 'control-state') {
      const target = this.#resolveElement(proof.nodeId);
      if (!target || !receiverControlCanBeDisabled(target) ||
        !this.#proofTargetIsSafe(target, false)) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLElement,
      });
    }
    if (proof.kind === 'aria-state') {
      const target = this.#resolveElement(proof.nodeId);
      // `expanded` is what the page shows, as a disabled state is; the others
      // are what the user chose.
      if (!target || !receiverAriaStateMatches(target, proof.state, proof.value) ||
        !this.#proofTargetIsSafe(target, proof.state !== 'expanded')) {
        return undefined;
      }
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLElement,
      });
    }
    if (proof.kind === 'popover-open') {
      // Only an element the replica holds as a popover can be shown as one.
      const target = this.#resolveElement(proof.nodeId);
      if (!target || safeNullableAttribute(target, 'popover') === null ||
        !this.#proofTargetIsSafe(target, false)) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLElement,
      });
    }
    if (proof.kind === 'aria-relationship') {
      const target = this.#resolveElement(proof.nodeId);
      if (!target || !this.#proofTargetIsSafe(target, false)) return undefined;
      const references: HTMLElement[] = [];
      const seen = new Set<Element>();
      for (const refNodeId of proof.targetNodeIds) {
        const ref = this.#resolveElement(refNodeId);
        if (
          !ref || ref === target || seen.has(ref) ||
          ref.ownerDocument !== target.ownerDocument ||
          ref.getRootNode() !== target.getRootNode() ||
          !this.#proofTargetIsSafe(ref, false)
        ) continue;
        seen.add(ref);
        references.push(ref as HTMLElement);
      }
      // Individual references that are not represented, not safe, or in another
      // tree scope are filtered out rather than voiding the whole batch (unlike
      // a select's contained options); an empty result presents as a no-op.
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLElement,
        references: Object.freeze(references),
      });
    }
    if (proof.kind === 'tab-state') {
      const trigger = this.#resolveElement(proof.tabNodeId);
      const panel = this.#resolveElement(proof.panelNodeId);
      if (
        !trigger || !panel || trigger === panel ||
        trigger.ownerDocument !== panel.ownerDocument ||
        trigger.getRootNode() !== panel.getRootNode() ||
        trigger.contains(panel) || panel.contains(trigger) ||
        !receiverTabRelationshipIsSafe(trigger, panel) ||
        !this.#proofTargetIsSafe(trigger, false) ||
        !this.#proofTargetIsSafe(panel, false) ||
        !receiverDisclosureSubtreeIsSafe(panel, (element) =>
          this.#proofTargetIsSafe(element, false))
      ) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        trigger: trigger as HTMLElement,
        panel: panel as HTMLElement,
        panelId: receiverUniqueBoundedPanelId(panel),
      });
    }
    if (proof.kind === 'structural-menu') {
      const container = this.#resolveElement(proof.containerNodeId);
      const trigger = this.#resolveElement(proof.triggerNodeId);
      const panel = this.#resolveElement(proof.panelNodeId);
      const shape = container && trigger && panel
        ? receiverStructuralMenuShape(container, trigger, panel, proof.relationId)
        : undefined;
      if (
        !container || !trigger || !panel || !shape ||
        !this.#proofTargetIsSafe(container, false) ||
        !this.#proofTargetIsSafe(trigger, false) ||
        !shape.otherTriggers.every((other) =>
          this.#proofTargetIsSafe(other, false)) ||
        !this.#proofTargetIsSafe(panel, false) ||
        // A menu's panel may hold a field; never a credential (D132).
        !receiverDisclosureSubtreeIsSafe(panel, (element) =>
          this.#proofTargetIsSafe(element, false), true)
      ) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        container: container as HTMLElement,
        trigger: trigger as HTMLElement,
        otherTriggers: shape.otherTriggers,
        panel: panel as HTMLElement,
        opening: shape.opening,
      });
    }
    const trigger = this.#resolveElement(proof.triggerNodeId);
    const panel = this.#resolveElement(proof.panelNodeId);
    if (
      !trigger || !panel || trigger === panel ||
      trigger.ownerDocument !== panel.ownerDocument ||
      trigger.contains(panel) || panel.contains(trigger) ||
      !receiverDisclosureTriggerIsSafe(trigger) ||
      !receiverDisclosureRoleMatches(panel, proof.popupRole) ||
      !this.#proofTargetIsSafe(trigger, false) ||
      !this.#proofTargetIsSafe(panel, false) ||
      !receiverDisclosureSubtreeIsSafe(panel, (element) =>
        this.#proofTargetIsSafe(element, false))
    ) return undefined;
    return Object.freeze({
      kind: proof.kind,
      proof,
      trigger: trigger as HTMLElement,
      panel: panel as HTMLElement,
    });
  }

  /**
   * A live patch can replace the replica node a record was written to (a
   * rematerialized subtree, as when a hover on the page repaints the header).
   * The same source node then resolves to the new replica node, which gets the
   * record again instead of losing its text until the source changes.
   */
  #rebind(entry: SemanticEntry): SemanticEntry | undefined {
    if (entry.binding.target.isConnected) return undefined;
    const target = this.#resolveAndValidate(entry.sourceRecord);
    if (!target || target === entry.binding.target) return undefined;
    let binding: SemanticBinding | undefined;
    try {
      binding = this.#createBinding(target, entry.sourceRecord.presentation);
    } catch {
      return undefined;
    }
    if (!binding?.write(entry.sourceRecord.text)) return undefined;
    return Object.freeze({ ...entry, binding });
  }

  /**
   * Every element with admitted menu text somewhere inside it, by one walk up
   * from each text record. A menu is asked for with one lookup: going
   * through the records again for each menu cost menus times records, which
   * the old limits hid and a table with a menu on every row did not (D132).
   * Undefined when a node cannot be read. A walk stops at a shadow root, as
   * `contains` does.
   */
  #elementsHoldingMenuText(
    records: readonly SemanticSourceRecord[],
  ): ReadonlySet<Node> | undefined {
    const holders = new Set<Node>();
    for (const record of records) {
      if (
        record.gate !== 'disclosureContent' ||
        record.presentation !== 'text' ||
        record.text.trim() === ''
      ) continue;
      let node: Node | null | undefined;
      try {
        node = this.environment.resolveNode(record.nodeId);
      } catch {
        return undefined;
      }
      if (
        node?.nodeType !== 3 ||
        node.ownerDocument !== this.environment.replicaDocument
      ) continue;
      for (
        let current: Node | null = node.parentNode;
        current && !holders.has(current);
        current = current.parentNode
      ) holders.add(current);
    }
    return holders;
  }

  #presentCurrentProofs(): boolean {
    if (!this.environment.applyProofs) {
      this.#proofPresentationHealthy = true;
      return true;
    }
    try {
      this.#proofPresentationHealthy = this.environment.applyProofs(
        Object.freeze([...this.#proofs.values()]),
      ) === true;
    } catch {
      this.#proofPresentationHealthy = false;
    }
    return this.#proofPresentationHealthy;
  }

  #resolveElement(nodeId: number): Element | undefined {
    let target: Node | null | undefined;
    try {
      target = this.environment.resolveNode(nodeId);
    } catch {
      return undefined;
    }
    if (!target?.isConnected) this.#missingNodeNotes?.add(nodeId);
    return target?.nodeType === 1 && target.isConnected &&
        target.ownerDocument === this.environment.replicaDocument
      ? target as Element
      : undefined;
  }

  #nodeIsPresent(nodeId: number): boolean {
    try {
      const target = this.environment.resolveNode(nodeId);
      return Boolean(
        target?.isConnected &&
        target.ownerDocument === this.environment.replicaDocument,
      );
    } catch {
      return false;
    }
  }

  #proofTargetIsSafe(element: Element, valueBearing: boolean): boolean {
    const facts = this.#classificationFacts(
      element,
      valueBearing ? 'selection' : 'label',
    );
    return !sourceFactsAreSecret(facts) &&
      this.#classifier.classify(element, facts) !== 'secret';
  }

  #resolveAndValidate(record: SemanticSourceRecord): Node | undefined {
    let target: Node | null | undefined;
    try {
      target = this.environment.resolveNode(record.nodeId);
    } catch {
      return undefined;
    }
    if (!target?.isConnected) this.#missingNodeNotes?.add(record.nodeId);
    if (
      !target || target.ownerDocument !== this.environment.replicaDocument ||
      !target.isConnected
    ) return undefined;
    const element = evidenceElement(target, record);
    if (!element || element.localName.toLowerCase() !== record.tagName) {
      if (
        record.category === 'editable' && record.presentation === 'text' &&
        (this.#unplacedEditorTextNotes?.length ?? MAX_UNPLACED_EDITOR_TEXT) <
          MAX_UNPLACED_EDITOR_TEXT
      ) this.#unplacedEditorTextNotes?.push(record);
      return undefined;
    }
    const facts = this.#classificationFacts(element, record.presentation);
    const stickyCategory = this.#classifier.classify(element, facts);
    if (sourceFactsAreSecret(facts) ||
      !replicaCategoryIsConsistent(record.category, classifySourceEvidence(facts)) ||
      stickyCategory === 'secret') return undefined;
    if (record.presentation === 'text' && target.nodeType !== 3) return undefined;
    if ((record.presentation === 'value' || record.presentation === 'placeholder') &&
      element.localName.toLowerCase() !== 'input' &&
      element.localName.toLowerCase() !== 'textarea') return undefined;
    if (record.presentation === 'selection' &&
      element.localName.toLowerCase() !== 'select') return undefined;
    return target;
  }

  #entryIsStillSafe(entry: SemanticEntry): boolean {
    const target = entry.binding.target;
    if (
      !target.isConnected ||
      target.ownerDocument !== this.environment.replicaDocument
    ) return false;
    const element = evidenceElement(target, entry.sourceRecord);
    if (!element || element.localName.toLowerCase() !== entry.sourceRecord.tagName) {
      return false;
    }
    const facts = this.#classificationFacts(
      element,
      entry.sourceRecord.presentation,
    );
    const stickyCategory = this.#classifier.classify(element, facts);
    return !sourceFactsAreSecret(facts) &&
      replicaCategoryIsConsistent(
        entry.sourceRecord.category,
        classifySourceEvidence(facts),
      ) && stickyCategory !== 'secret';
  }

  #classificationFacts(
    element: Element,
    presentation: SemanticSourcePresentation,
  ): SourceClassificationFacts {
    let secretAncestor = false;
    const path = readSourceFlatTreeElementPath(element);
    if (!path) {
      return replicaClassificationFacts(element, presentation, true);
    }
    const remembered = this.#passSecretAncestors;
    const walked: Element[] = [];
    for (let index = 1; index < path.length; index += 1) {
      const ancestor = path[index]!;
      const known = remembered?.get(ancestor);
      if (known !== undefined) {
        secretAncestor = known;
        break;
      }
      walked.push(ancestor);
      const ancestorFacts = replicaClassificationFacts(ancestor, 'label');
      if (this.#classifier.classify(ancestor, ancestorFacts) === 'secret') {
        secretAncestor = true;
        break;
      }
    }
    // Each ancestor walked past is not secret itself, so it shares the answer
    // found above it.
    if (remembered) {
      for (const ancestor of walked) remembered.set(ancestor, secretAncestor);
    }
    return replicaClassificationFacts(element, presentation, secretAncestor);
  }

  #createBinding(
    target: Node,
    presentation: SemanticSourcePresentation,
  ): SemanticBinding | undefined {
    if (presentation === 'text') return textBinding(target);
    if (target.nodeType !== 1) return undefined;
    const element = target as Element;
    if (presentation === 'value') return propertyBinding(element, 'value');
    if (presentation === 'placeholder') {
      return propertyBinding(element, 'placeholder');
    }
    if (presentation === 'label') {
      const tag = element.localName.toLowerCase();
      if (tag === 'option' || tag === 'optgroup') {
        return attributeBinding(element, 'label');
      }
      if (tag === 'input') {
        const type = safeAttribute(element, 'type').trim().toLowerCase();
        if (type === 'button' || type === 'reset' || type === 'submit') {
          return propertyBinding(element, 'value');
        }
      }
    }
    return heldTextBinding(element, presentation);
  }
}

function entryIsTranslated(
  entry: Pick<SemanticEntry, 'binding' | 'sourceRecord'>,
): boolean {
  return entry.binding.translatable &&
    TRANSLATABLE_SOURCE_TEXT.test(entry.sourceRecord.text);
}

function sameResolvedProofSet(
  current: ReadonlyMap<string, ResolvedSemanticSourceProof>,
  next: ReadonlyMap<string, ResolvedSemanticSourceProof>,
): boolean {
  if (current.size !== next.size) return false;
  for (const [proofId, right] of next) {
    const left = current.get(proofId);
    if (!left || !sameResolvedProof(left, right)) return false;
  }
  return true;
}

function sameResolvedProof(
  left: ResolvedSemanticSourceProof,
  right: ResolvedSemanticSourceProof,
): boolean {
  if (
    left.kind !== right.kind ||
    semanticSourceProofSignature(left.proof) !==
      semanticSourceProofSignature(right.proof)
  ) return false;
  if (left.kind === 'select-state') {
    return right.kind === 'select-state' && left.target === right.target &&
      sameNodeList(left.selectedOptions, right.selectedOptions);
  }
  if (left.kind === 'select-presentation') {
    return right.kind === 'select-presentation' && left.target === right.target;
  }
  if (left.kind === 'choice-state') {
    return right.kind === 'choice-state' && left.target === right.target;
  }
  if (left.kind === 'masked-length') {
    return right.kind === 'masked-length' && left.target === right.target;
  }
  if (left.kind === 'control-state') {
    return right.kind === 'control-state' && left.target === right.target;
  }
  if (left.kind === 'aria-state') {
    return right.kind === 'aria-state' && left.target === right.target;
  }
  if (left.kind === 'popover-open') {
    return right.kind === 'popover-open' && left.target === right.target;
  }
  if (left.kind === 'aria-relationship') {
    return right.kind === 'aria-relationship' && left.target === right.target &&
      sameNodeList(left.references, right.references);
  }
  if (left.kind === 'tab-state') {
    return right.kind === 'tab-state' && left.trigger === right.trigger &&
      left.panel === right.panel && left.panelId === right.panelId;
  }
  if (left.kind === 'structural-menu') {
    return right.kind === 'structural-menu' &&
      left.container === right.container && left.trigger === right.trigger &&
      left.panel === right.panel && left.opening === right.opening &&
      sameNodeList(left.otherTriggers, right.otherTriggers);
  }
  return right.kind === 'disclosure-state' && left.trigger === right.trigger &&
    left.panel === right.panel;
}

function sameNodeList(
  left: readonly Node[],
  right: readonly Node[],
): boolean {
  return left.length === right.length &&
    left.every((node, index) => node === right[index]);
}

export function semanticProjectionNodeId(recordId: number): number | undefined {
  return Number.isSafeInteger(recordId) && recordId > 0 ? -recordId : undefined;
}

function sourceRecordSignature(record: SemanticSourceRecord): string {
  return [
    record.bridge,
    record.nodeId,
    record.presentation,
    record.category,
    record.gate,
    record.tagName,
    record.type,
    record.autocomplete,
    record.role,
    record.contentEditable,
    record.text,
  ].join('\u0000');
}

function toTranslationRecord(
  document: ReplicaSourceDocumentIdentity,
  nodeId: number,
  record: SemanticSourceRecord,
): ReplicaSourceTextRecord {
  if (record.presentation === 'text') {
    return Object.freeze({
      document,
      nodeId,
      nodeType: 3,
      revision: record.nodeRevision,
      source: record.text,
    });
  }
  return Object.freeze({
    document,
    nodeId,
    nodeType: 1,
    controlTarget: record.presentation === 'value'
      ? 'value'
      : record.presentation === 'placeholder' ? 'placeholder' : 'label',
    revision: record.nodeRevision,
    source: record.text,
  });
}

function replicaClassificationFacts(
  element: Element,
  presentation: SemanticSourcePresentation,
  secretAncestor = false,
): SourceClassificationFacts {
  let computedTextSecurity = '';
  const view = element.ownerDocument.defaultView;
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
      const style = getComputedStyle.call(view, element);
      if (typeof style?.getPropertyValue !== 'function') {
        computedStyleUnreadable = true;
      } else {
        computedTextSecurity = style.getPropertyValue('-webkit-text-security');
      }
    } catch {
      computedStyleUnreadable = true;
    }
  }
  if (computedStyleUnreadable) computedTextSecurity = 'simul-unreadable';
  return {
    tagName: element.localName.toLowerCase(),
    type: safeAttribute(element, 'type'),
    autocomplete: safeAttribute(element, 'autocomplete'),
    role: safeAttribute(element, 'role'),
    contentEditable: safeAttribute(element, 'contenteditable'),
    computedTextSecurity,
    secretAncestor,
    valueBearing: presentation === 'value' || presentation === 'selection' ||
      presentation === 'editable',
  };
}

function replicaCategoryIsConsistent(
  claimed: SemanticSourceRecord['category'],
  actual: ReturnType<typeof classifySourceEvidence>,
): boolean {
  if (actual === 'secret' || actual === 'withheld') return false;
  if (claimed === actual) return true;
  // A base sanitizer may remove personal autocomplete metadata. A source
  // claim that keeps the stronger personal gate is still safe; downgrading a
  // replica-observable personal field to ordinary is never accepted.
  return claimed === 'personal' && actual === 'ordinary-form';
}

const RECEIVER_DISABLEABLE_TAGS = new Set([
  'button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea',
]);
const RECEIVER_CONTROL_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'switch', 'tab', 'treeitem',
]);
const RECEIVER_ACTIVATION_ROLES = new Set([
  'button', 'combobox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem',
]);
const RECEIVER_ARIA_CHECKED_ROLES = new Set([
  'checkbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch',
]);
const RECEIVER_ARIA_MIXED_ROLES = new Set(['checkbox', 'menuitemcheckbox']);
const RECEIVER_ARIA_SELECTED_ROLES = new Set(['option', 'treeitem']);
const RECEIVER_ARIA_PRESSED_ROLES = new Set(['button']);
const RECEIVER_ARIA_CURRENT_TAGS = new Set([
  'a', 'button', 'li', 'option', 'summary',
]);
const RECEIVER_ARIA_CURRENT_ROLES = new Set([
  'button', 'gridcell', 'link', 'listitem', 'menuitem', 'menuitemradio',
  'option', 'row', 'tab', 'treeitem',
]);
const RECEIVER_ARIA_RANGE_INDICATOR_ROLES = new Set([
  'meter', 'progressbar', 'scrollbar',
]);
const RECEIVER_ARIA_RANGE_INPUT_ROLES = new Set([
  'slider', 'spinbutton',
]);
const RECEIVER_DISCLOSURE_STATE_TAGS = new Set([
  'input', 'option', 'output', 'select', 'textarea',
]);
const RECEIVER_DISCLOSURE_STATE_ROLES = new Set([
  'combobox', 'listbox', 'searchbox', 'textbox',
]);

function receiverControlCanBeDisabled(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  const role = safeAttribute(element, 'role').trim().toLowerCase();
  return RECEIVER_DISABLEABLE_TAGS.has(tagName) ||
    RECEIVER_CONTROL_ROLES.has(role);
}

function receiverAriaStateMatches(
  element: Element,
  state: SemanticAriaState,
  value: string,
): boolean {
  if (!isSemanticAriaStateValue(state, value)) return false;
  // Any element may say whether what it controls is shown: page CSS tests
  // the attribute wherever the page wrote it.
  if (state === 'expanded') return true;
  const role = safeAttribute(element, 'role').trim().toLowerCase();
  const tagName = element.localName.toLowerCase();
  if (state === 'selected') return RECEIVER_ARIA_SELECTED_ROLES.has(role);
  if (state === 'checked') {
    return RECEIVER_ARIA_CHECKED_ROLES.has(role) &&
      (value !== 'mixed' || RECEIVER_ARIA_MIXED_ROLES.has(role));
  }
  if (state === 'pressed') {
    return RECEIVER_ARIA_PRESSED_ROLES.has(role) ||
      (role === '' && tagName === 'button');
  }
  if (state === 'current') {
    return RECEIVER_ARIA_CURRENT_ROLES.has(role) ||
      (role === '' && RECEIVER_ARIA_CURRENT_TAGS.has(tagName));
  }
  if (state === 'valueinput') return RECEIVER_ARIA_RANGE_INPUT_ROLES.has(role);
  return RECEIVER_ARIA_RANGE_INDICATOR_ROLES.has(role);
}

function receiverDisclosureTriggerIsSafe(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  const role = safeAttribute(element, 'role').trim().toLowerCase();
  if (tagName === 'button' || tagName === 'summary' ||
    RECEIVER_ACTIVATION_ROLES.has(role)) return true;
  if (tagName === 'a') return safeAttribute(element, 'href').trim() !== '';
  if (tagName !== 'input') return false;
  const type = safeAttribute(element, 'type').trim().toLowerCase();
  return type === 'button' || type === 'reset' || type === 'submit';
}

/**
 * The shape the page side inferred, read again from the replica: a container
 * holding the named trigger, the panel, and at most one more trigger (D132).
 * The panel is the container's child or sits in that child inside wrappers
 * that hold nothing else. Undefined when the replica does not show that shape.
 */
function receiverStructuralMenuShape(
  container: Element,
  trigger: Element,
  panel: Element,
  relationId: string,
): {
  readonly otherTriggers: readonly HTMLElement[];
  readonly opening: StructuralMenuOpening;
} | undefined {
  if (
    container === trigger || container === panel || trigger === panel ||
    container.ownerDocument !== trigger.ownerDocument ||
    container.ownerDocument !== panel.ownerDocument ||
    container.getRootNode() !== trigger.getRootNode() ||
    container.getRootNode() !== panel.getRootNode() ||
    trigger.parentElement !== container ||
    !isStructuralMenuPanelElement(panel) ||
    safeNullableAttribute(container, 'hidden') !== null ||
    safeAttribute(container, 'aria-hidden').trim().toLowerCase() === 'true'
  ) return undefined;
  let children: Element[];
  try {
    children = [...container.children];
  } catch {
    return undefined;
  }
  if (
    children.length < 2 || children.length > MAX_STRUCTURAL_MENU_TRIGGERS + 1 ||
    !children.includes(trigger)
  ) return undefined;
  const held = children.find((child) =>
    child !== trigger && structuralMenuPanelCandidates(child).includes(panel));
  if (!held) return undefined;
  const triggers = children.filter((child) => child !== held);
  for (const candidate of triggers) {
    if (
      safeNullableAttribute(candidate, 'hidden') !== null ||
      safeAttribute(candidate, 'aria-hidden').trim().toLowerCase() === 'true' ||
      !receiverStructuralTriggerIsUnclaimed(candidate, relationId) ||
      (!receiverDisclosureTriggerIsSafe(candidate) &&
        !isPlainStructuralMenuTrigger(candidate))
    ) return undefined;
  }
  const opening = structuralMenuOpening(container, triggers, panel);
  if (!opening) return undefined;
  return Object.freeze({
    otherTriggers: Object.freeze(
      triggers.filter((child) => child !== trigger) as HTMLElement[],
    ),
    opening,
  });
}

/**
 * The sanitizer strips a source trigger's aria-expanded and aria-controls, so
 * in the replica they can only be Simul's own presentation. After the first
 * batch presents this menu they carry this relation's marker and id, and the
 * next batch must not refuse the menu (and with it the whole batch) for them.
 */
function receiverStructuralTriggerIsUnclaimed(
  trigger: Element,
  relationId: string,
): boolean {
  const expanded = safeNullableAttribute(trigger, 'aria-expanded');
  const controls = safeNullableAttribute(trigger, 'aria-controls');
  if (expanded === null && controls === null) return true;
  // The page's own `aria-expanded`, presented as a typed state before this
  // element was a menu's trigger (D132); the presenter takes it back before
  // it presents the menu.
  if (
    controls === null &&
    safeNullableAttribute(trigger, 'data-simul-source-aria-expanded-state') === 'v1'
  ) return true;
  return safeNullableAttribute(
    trigger,
    'data-simul-source-disclosure-state',
  ) === 'v1' && controls === relationId;
}

function receiverTabRelationshipIsSafe(
  trigger: Element,
  panel: Element,
): boolean {
  return safeAttribute(trigger, 'role').trim().toLowerCase() === 'tab' &&
    safeAttribute(panel, 'role').trim().toLowerCase() === 'tabpanel';
}

function receiverUniqueBoundedPanelId(panel: Element): string | undefined {
  const id = safeAttribute(panel, 'id');
  if (
    !id || id.length > 1_024 ||
    id.startsWith('semantic-tab-relation-v1:') ||
    /[\s\u0000-\u001f\u007f]/u.test(id)
  ) {
    return undefined;
  }
  const root = panel.getRootNode();
  const pending: Node[] = root.nodeType === 9
    ? [((root as Document).documentElement as Node | null)].filter(
        (node): node is Node => Boolean(node),
      )
    : [...root.childNodes];
  let visited = 0;
  let match: Element | undefined;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || ++visited > 50_000) return undefined;
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (safeAttribute(element, 'id') === id) {
      if (match) return undefined;
      match = element;
    }
    pending.push(...element.childNodes);
  }
  return match === panel ? id : undefined;
}

function receiverDisclosureRoleMatches(
  panel: Element,
  popupRole: Extract<SemanticSourceProof, {
    kind: 'disclosure-state';
  }>['popupRole'],
): boolean {
  const role = safeAttribute(panel, 'role').trim().toLowerCase();
  if (!role) return true;
  if (popupRole === 'dialog') return role === 'dialog' || role === 'alertdialog';
  if (popupRole === 'region') return role === 'region';
  return role === popupRole;
}

function receiverDisclosureSubtreeIsSafe(
  panel: Element,
  classify: (element: Element) => boolean,
  /** A menu's panel may hold a field that `classify` passes (D132). */
  allowFields = false,
): boolean {
  const pending: Node[] = [panel];
  let visited = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || ++visited > 1_024 || node.ownerDocument !== panel.ownerDocument) {
      return false;
    }
    if (node.nodeType === 11) {
      pending.push(...node.childNodes);
      continue;
    }
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const tagName = element.localName.toLowerCase();
    const role = safeAttribute(element, 'role').trim().toLowerCase();
    const contentEditable = safeAttribute(element, 'contenteditable')
      .trim().toLowerCase();
    if (!classify(element)) return false;
    if (
      !allowFields && (
        RECEIVER_DISCLOSURE_STATE_TAGS.has(tagName) ||
        RECEIVER_DISCLOSURE_STATE_ROLES.has(role) ||
        (contentEditable !== '' && contentEditable !== 'false')
      )
    ) return false;
    pending.push(...element.childNodes);
    try {
      if (element.shadowRoot?.mode === 'open') pending.push(element.shadowRoot);
    } catch {
      return false;
    }
  }
  return true;
}

function evidenceElement(
  target: Node,
  record: SemanticSourceRecord,
): Element | undefined {
  if (record.presentation !== 'text') {
    return target.nodeType === 1 ? target as Element : undefined;
  }
  if (record.category !== 'editable') return target.parentElement ?? undefined;
  // The editor the text is drawn in: above it in the page's own tree, around
  // the slot that takes it, or the host of the root it sits in.
  for (const element of readSourceFlatTreeElementPath(target) ?? []) {
    const contentEditable = safeAttribute(element, 'contenteditable')
      .trim().toLowerCase();
    const role = safeAttribute(element, 'role').trim().toLowerCase();
    if (
      (contentEditable !== '' && contentEditable !== 'false') ||
      role === 'textbox' || role === 'searchbox'
    ) return element;
  }
  return undefined;
}

function textBinding(target: Node): SemanticBinding | undefined {
  if (target.nodeType !== 3) return undefined;
  let original = target.nodeValue;
  let lastWritten: string | undefined;
  return {
    target,
    presentation: 'text',
    translatable: true,
    write: (text) => {
      try {
        target.nodeValue = text;
        lastWritten = text;
        return true;
      } catch {
        return false;
      }
    },
    restore: () => {
      try {
        if (lastWritten === undefined || target.nodeValue === lastWritten) {
          target.nodeValue = original;
        }
        return true;
      } catch {
        return false;
      }
    },
    reapply: () => {
      if (lastWritten === undefined) return true;
      try {
        if (target.nodeValue !== lastWritten) original = target.nodeValue;
      } catch {
        return false;
      }
      return writeNodeValue(target, lastWritten);
    },
    snapshot: () => {
      try {
        const value = target.nodeValue;
        const written = lastWritten;
        return () => {
          try {
            target.nodeValue = value;
            lastWritten = written;
            return true;
          } catch {
            return false;
          }
        };
      } catch {
        return undefined;
      }
    },
  };
}

function propertyBinding(
  element: Element,
  property: 'value' | 'placeholder',
): SemanticBinding | undefined {
  const control = element as Element & Record<typeof property, string>;
  let original: string;
  try {
    original = String(control[property] ?? '');
  } catch {
    return undefined;
  }
  let lastWritten: string | undefined;
  const write = (text: string): boolean => {
    try {
      control[property] = text;
      lastWritten = text;
      return true;
    } catch {
      return false;
    }
  };
  return {
    target: element,
    presentation: property,
    translatable: true,
    write,
    restore: () => {
      try {
        if (lastWritten === undefined || control[property] === lastWritten) {
          control[property] = original;
        }
        return true;
      } catch {
        return false;
      }
    },
    reapply: () => {
      if (lastWritten === undefined) return true;
      try {
        const current = control[property];
        if (current !== lastWritten) {
          original = String(current ?? '');
        }
      } catch {
        return false;
      }
      return write(lastWritten);
    },
    snapshot: () => {
      try {
        const value = control[property];
        const written = lastWritten;
        return () => {
          try {
            control[property] = value;
            lastWritten = written;
            return true;
          } catch {
            return false;
          }
        };
      } catch {
        return undefined;
      }
    },
  };
}

function attributeBinding(
  element: Element,
  attribute: string,
): SemanticBinding {
  let original = safeNullableAttribute(element, attribute);
  let lastWritten: string | undefined;
  const write = (text: string): boolean => {
    try {
      element.setAttribute(attribute, text);
      lastWritten = text;
      return true;
    } catch {
      return false;
    }
  };
  return {
    target: element,
    presentation: 'label',
    translatable: true,
    write,
    restore: () => {
      try {
        if (lastWritten !== undefined && element.getAttribute(attribute) !== lastWritten) {
          return true;
        }
        if (original === null) element.removeAttribute(attribute);
        else element.setAttribute(attribute, original);
        return true;
      } catch {
        return false;
      }
    },
    reapply: () => {
      if (lastWritten === undefined) return true;
      try {
        const current = element.getAttribute(attribute);
        if (current !== lastWritten) original = current;
      } catch {
        return false;
      }
      return write(lastWritten);
    },
    snapshot: () => {
      try {
        const present = element.hasAttribute(attribute);
        const value = element.getAttribute(attribute);
        const written = lastWritten;
        return () => {
          try {
            if (present && value !== null) element.setAttribute(attribute, value);
            else element.removeAttribute(attribute);
            lastWritten = written;
            return true;
          } catch {
            return false;
          }
        };
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * An accessible name (`aria-label`, `title`) or a select's current choice
 * is not painted as text beside the control in the source page: the name is
 * drawn nowhere (D67), the choice by the dropdown's own trigger, which reads
 * it from `semanticSelectionTextFor`. So the text is held here and no
 * element of Simul's is put into the mirror for it. A hidden `<span>` used
 * to carry it, after an input or as the last child of a button or a link,
 * where the page's own selectors counted it: `input:checked + .panel` (tabs
 * made of radio buttons) no longer found the panel, and `:empty`,
 * `:last-child` and `:only-child` changed for a labelled button. Nothing
 * ever read the span.
 */
function heldTextBinding(
  element: Element,
  presentation: SemanticSourcePresentation,
): SemanticBinding {
  const selection = presentation === 'selection';
  return {
    target: element,
    presentation,
    // A select's current choice is drawn by its dropdown trigger; an
    // accessible name is drawn nowhere (D67).
    translatable: presentation !== 'label',
    write: (text) => {
      if (selection) SEMANTIC_SELECTION_TEXT.set(element, text);
      return true;
    },
    restore: () => {
      if (selection) SEMANTIC_SELECTION_TEXT.delete(element);
      return true;
    },
    // Nothing of it is in the mirror for a patch to take away.
    reapply: () => true,
    snapshot: () => {
      const held = SEMANTIC_SELECTION_TEXT.get(element);
      return () => {
        if (!selection) return true;
        if (held === undefined) SEMANTIC_SELECTION_TEXT.delete(element);
        else SEMANTIC_SELECTION_TEXT.set(element, held);
        return true;
      };
    },
  };
}

function writeNodeValue(target: Node, text: string): boolean {
  try {
    target.nodeValue = text;
    return true;
  } catch {
    return false;
  }
}

function safeAttribute(element: Element, name: string): string {
  return safeNullableAttribute(element, name) ?? '';
}

function safeNullableAttribute(element: Element, name: string): string | null {
  try {
    return element.getAttribute(name);
  } catch {
    return null;
  }
}
