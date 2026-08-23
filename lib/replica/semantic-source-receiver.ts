import type { ReplicaTextProjection } from '../translation/replica-translation-coordinator';
import type {
  ReplicaSourceTextChange,
  ReplicaSourceTextRecord,
} from './source-value-model';
import {
  StickySourceSecretClassifier,
  classifySourceEvidence,
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
} from './semantic-source-protocol';
import {
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from './source-identity';
import { readSourceFlatTreeElementPath } from './source-privacy-policy';

export interface SemanticSourceReceiverEnvironment {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replicaDocument: Document;
  readonly resolveNode: (nodeId: number) => Node | null | undefined;
  /** Atomically projects only receiver-validated typed state/relationships. */
  readonly applyProofs?: (
    proofs: readonly ResolvedSemanticSourceProof[],
  ) => boolean;
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
      readonly kind: 'disclosure-state';
      readonly proof: Extract<SemanticSourceProof, { kind: 'disclosure-state' }>;
      readonly trigger: HTMLElement;
      readonly panel: HTMLElement;
    };

interface SemanticBinding {
  readonly target: Node;
  readonly presentation: SemanticSourcePresentation;
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
 * Returns renderer-owned semantic selection text without encoding source text
 * in a replica attribute or relying on the placement of the owned span.
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

  constructor(private readonly environment: SemanticSourceReceiverEnvironment) {}

  records(): readonly ReplicaSourceTextRecord[] {
    const records: ReplicaSourceTextRecord[] = [];
    for (const entry of this.#entries.values()) {
      records.push(entry.translationRecord);
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
    const plans = new Map<number, {
      readonly sourceRecord: SemanticSourceRecord;
      readonly translationRecord: ReplicaSourceTextRecord;
      readonly binding: SemanticBinding;
      readonly changed: boolean;
    }>();
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
      if (!target) return undefined;
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
        return undefined;
      }
      if (!binding) return undefined;
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
    const proofPlans = this.#resolveProofs(batch.proofs);
    if (!proofPlans) return undefined;
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
      changes.push(Object.freeze({ kind: 'upsert', record: plan.translationRecord }));
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
    this.#lastSequence = batch.sequence;
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
    const changes: ReplicaSourceTextChange[] = [];
    for (const [projectionNodeId, entry] of this.#entries) {
      if (this.#entryIsStillSafe(entry) && entry.binding.reapply()) continue;
      entry.binding.restore();
      this.#entries.delete(projectionNodeId);
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
      changes.push(Object.freeze({
        kind: 'remove',
        document: this.environment.document,
        nodeId: projectionNodeId,
        revision: entry.translationRecord.revision + 1,
      }));
    }
    this.#entries.clear();
    return Object.freeze(changes);
  }

  #resolveProofs(
    proofs: readonly SemanticSourceProof[],
  ): Map<string, ResolvedSemanticSourceProof> | undefined {
    const resolved = new Map<string, ResolvedSemanticSourceProof>();
    for (const proof of proofs) {
      const proofId = semanticSourceProofIdentity(proof);
      if (resolved.has(proofId)) return undefined;
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
      if (!next) return undefined;
      resolved.set(proofId, next);
    }
    const presentations = new Map<number, Extract<ResolvedSemanticSourceProof, {
      kind: 'select-presentation';
    }>>();
    for (const value of resolved.values()) {
      if (value.kind === 'select-presentation') {
        presentations.set(value.proof.nodeId, value);
      }
    }
    for (const value of resolved.values()) {
      if (value.kind !== 'select-state') continue;
      const presentation = presentations.get(value.proof.nodeId);
      if ((!value.proof.multiple && value.selectedOptions.length > 1) ||
        (value.proof.multiple && value.proof.pickerOpen) ||
        (presentation &&
          presentation.proof.multiple !== value.proof.multiple)) {
        return undefined;
      }
    }
    return resolved;
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
      if (!target || !receiverAriaStateMatches(target, proof.state, proof.value) ||
        !this.#proofTargetIsSafe(target, true)) return undefined;
      return Object.freeze({
        kind: proof.kind,
        proof,
        target: target as HTMLElement,
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
    return target?.nodeType === 1 && target.isConnected &&
        target.ownerDocument === this.environment.replicaDocument
      ? target as Element
      : undefined;
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
    if (
      !target || target.ownerDocument !== this.environment.replicaDocument ||
      !target.isConnected
    ) return undefined;
    const element = evidenceElement(target, record);
    if (!element || element.localName.toLowerCase() !== record.tagName) {
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
    for (const ancestor of path.slice(1)) {
      const ancestorFacts = replicaClassificationFacts(ancestor, 'label');
      if (this.#classifier.classify(ancestor, ancestorFacts) === 'secret') {
        secretAncestor = true;
        break;
      }
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
        return ownedTextBinding(element, 'label', true);
      }
      if (tag === 'textarea' || tag === 'select') {
        return ownedTextBinding(element, 'label', true);
      }
    }
    return ownedTextBinding(
      element,
      presentation,
      presentation === 'selection',
    );
  }
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
  if (left.kind === 'control-state') {
    return right.kind === 'control-state' && left.target === right.target;
  }
  if (left.kind === 'aria-state') {
    return right.kind === 'aria-state' && left.target === right.target;
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
const RECEIVER_ARIA_SELECTED_ROLES = new Set(['option', 'tab', 'treeitem']);
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
  state: 'checked' | 'selected',
  value: 'true' | 'false' | 'mixed',
): boolean {
  const role = safeAttribute(element, 'role').trim().toLowerCase();
  if (state === 'selected') {
    return value !== 'mixed' && RECEIVER_ARIA_SELECTED_ROLES.has(role);
  }
  return RECEIVER_ARIA_CHECKED_ROLES.has(role) &&
    (value !== 'mixed' || RECEIVER_ARIA_MIXED_ROLES.has(role));
}

function receiverDisclosureTriggerIsSafe(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  const role = safeAttribute(element, 'role').trim().toLowerCase();
  if (tagName === 'button' || tagName === 'summary' ||
    RECEIVER_ACTIVATION_ROLES.has(role)) return true;
  if (tagName !== 'input') return false;
  const type = safeAttribute(element, 'type').trim().toLowerCase();
  return type === 'button' || type === 'reset' || type === 'submit';
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
    if (
      !classify(element) || RECEIVER_DISCLOSURE_STATE_TAGS.has(tagName) ||
      RECEIVER_DISCLOSURE_STATE_ROLES.has(role) ||
      (contentEditable !== '' && contentEditable !== 'false')
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
  let element = target.parentElement ?? undefined;
  if (record.category !== 'editable') return element;
  while (element) {
    const contentEditable = safeAttribute(element, 'contenteditable')
      .trim().toLowerCase();
    const role = safeAttribute(element, 'role').trim().toLowerCase();
    if (
      (contentEditable !== '' && contentEditable !== 'false') ||
      role === 'textbox' || role === 'searchbox'
    ) return element;
    element = element.parentElement ?? undefined;
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

function ownedTextBinding(
  element: Element,
  presentation: SemanticSourcePresentation,
  adjacent: boolean,
): SemanticBinding | undefined {
  const document = element.ownerDocument;
  const owned = document.createElement('span');
  owned.setAttribute('data-simul-semantic-source', 'v1');
  owned.setAttribute('data-simul-semantic-presentation', presentation);
  owned.setAttribute('aria-hidden', 'true');
  owned.style.setProperty('pointer-events', 'none', 'important');
  owned.hidden = hasMeaningfulUnownedText(element);
  let attached = false;
  let lastWritten: string | undefined;
  const write = (text: string): boolean => {
    try {
      if (!attached) {
        if (adjacent) element.insertAdjacentElement('afterend', owned);
        else element.append(owned);
        attached = true;
      }
      owned.textContent = text;
      if (presentation === 'selection') {
        SEMANTIC_SELECTION_TEXT.set(element, text);
      }
      lastWritten = text;
      return true;
    } catch {
      try {
        owned.remove();
      } catch {
        // Ignore cleanup failure on a rejected binding.
      }
      attached = false;
      if (presentation === 'selection') {
        SEMANTIC_SELECTION_TEXT.delete(element);
      }
      return false;
    }
  };
  return {
    target: element,
    presentation,
    write,
    restore: () => {
      try {
        owned.remove();
        attached = false;
        if (presentation === 'selection') {
          SEMANTIC_SELECTION_TEXT.delete(element);
        }
        return true;
      } catch {
        return false;
      }
    },
    reapply: () => {
      if (attached && !owned.isConnected) attached = false;
      return lastWritten === undefined || write(lastWritten);
    },
    snapshot: () => {
      try {
        const parent = owned.parentNode;
        const nextSibling = owned.nextSibling;
        const text = owned.textContent;
        const hidden = owned.hidden;
        const wasAttached = attached;
        const written = lastWritten;
        const hadSelection = presentation === 'selection' &&
          SEMANTIC_SELECTION_TEXT.has(element);
        const selection = presentation === 'selection'
          ? SEMANTIC_SELECTION_TEXT.get(element)
          : undefined;
        return () => {
          try {
            owned.remove();
            if (parent) {
              if (nextSibling?.parentNode === parent) {
                parent.insertBefore(owned, nextSibling);
              } else {
                parent.appendChild(owned);
              }
            }
            owned.textContent = text;
            owned.hidden = hidden;
            attached = wasAttached;
            lastWritten = written;
            if (presentation === 'selection') {
              if (hadSelection && selection !== undefined) {
                SEMANTIC_SELECTION_TEXT.set(element, selection);
              } else {
                SEMANTIC_SELECTION_TEXT.delete(element);
              }
            }
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

function hasMeaningfulUnownedText(element: Element): boolean {
  try {
    const pending = [...element.childNodes];
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      if (node.nodeType === 3 && /[\p{L}\p{N}]/u.test(node.nodeValue ?? '')) {
        return true;
      }
      if (node.nodeType === 1 &&
        (node as Element).getAttribute('data-simul-semantic-source') !== 'v1') {
        pending.push(...node.childNodes);
      }
    }
    return false;
  } catch {
    return true;
  }
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
