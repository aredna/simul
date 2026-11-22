import { describe, expect, it } from 'vitest';

import {
  MAX_SEMANTIC_SOURCE_PROOFS,
  SEMANTIC_SOURCE_PROTOCOL_VERSION,
  SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION,
  applySemanticSourceOrderPlacements,
  createSemanticSourceAck,
  semanticSourceOrderPlacements,
  createSemanticSourceBatch,
  createSemanticSourcePortName,
  createSemanticSourceStart,
  readSemanticSourceProof,
  semanticSourceProofSignature,
  semanticSourceProofIdentity,
  readSemanticSourceControllerMessage,
  readSemanticSourceBatch,
  readSemanticSourcePortIdentity,
  readSemanticSourceRecord,
  semanticDisclosureRelationId,
  semanticStructuralMenuRelationId,
  semanticTabRelationId,
  semanticSourceBatchByteLength,
} from '../lib/replica/semantic-source-protocol';
import {
  FULL_VISIBLE_REPLICA_READ_SCOPE,
  PAGE_ONLY_REPLICA_READ_SCOPE,
} from '../lib/replica/read-scope-policy';

const documentIdentity = {
  sessionId: 'semantic-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'semantic-document',
  frameId: 0,
};

const ordinaryRecord = {
  bridge: 'isolated-html',
  recordId: 35,
  nodeId: 4,
  nodeRevision: 2,
  category: 'ordinary-form',
  gate: 'formValues',
  tagName: 'input',
  type: 'text',
  autocomplete: '',
  role: '',
  contentEditable: '',
  text: 'visible draft',
  presentation: 'value',
  classifierVersion: 1,
} as const;

const selectProof = {
  kind: 'select-state',
  bridge: 'isolated-html',
  nodeId: 7,
  revision: 2,
  gate: 'formValues',
  selectedOptionNodeIds: [8, 9],
  multiple: true,
  pickerOpen: false,
  classifierVersion: 1,
} as const;

const selectPresentationProof = {
  kind: 'select-presentation',
  bridge: 'isolated-html',
  nodeId: 7,
  revision: 1,
  gate: 'controlSemantics',
  multiple: true,
  size: 4,
  classifierVersion: 1,
} as const;

const disclosureProof = {
  kind: 'disclosure-state',
  bridge: 'isolated-html',
  relationId: semanticDisclosureRelationId(10, 11)!,
  revision: 1,
  gate: 'disclosureContent',
  triggerNodeId: 10,
  panelNodeId: 11,
  popupRole: 'menu',
  expanded: false,
  classifierVersion: 1,
} as const;

const tabProof = {
  kind: 'tab-state',
  bridge: 'isolated-html',
  relationId: semanticTabRelationId(14, 15)!,
  revision: 1,
  gate: 'controlSemantics',
  tabNodeId: 14,
  panelNodeId: 15,
  selected: true,
  classifierVersion: 1,
} as const;

const structuralMenuProof = {
  kind: 'structural-menu',
  bridge: 'isolated-html',
  relationId: semanticStructuralMenuRelationId(16, 17, 18)!,
  revision: 1,
  gate: 'disclosureContent',
  containerNodeId: 16,
  triggerNodeId: 17,
  panelNodeId: 18,
  popupRole: 'menu',
  expanded: false,
  classifierVersion: 1,
} as const;

const choiceProof = {
  kind: 'choice-state',
  bridge: 'isolated-html',
  nodeId: 12,
  revision: 3,
  gate: 'formValues',
  checked: true,
  indeterminate: false,
  classifierVersion: 1,
} as const;

const controlProof = {
  kind: 'control-state',
  bridge: 'isolated-html',
  nodeId: 12,
  revision: 2,
  gate: 'controlSemantics',
  disabled: true,
  classifierVersion: 1,
} as const;

const ariaProof = {
  kind: 'aria-state',
  bridge: 'isolated-html',
  nodeId: 13,
  revision: 1,
  gate: 'formValues',
  state: 'checked',
  value: 'mixed',
  classifierVersion: 1,
} as const;

const pressedProof = {
  ...ariaProof, nodeId: 21, state: 'pressed', value: 'true',
} as const;
const currentProof = {
  ...ariaProof, nodeId: 22, gate: 'controlSemantics', state: 'current',
  value: 'page',
} as const;
const rangeProof = {
  ...ariaProof, nodeId: 23, gate: 'controlSemantics', state: 'valuenow',
  value: '42.5',
} as const;
const valueInputProof = {
  ...ariaProof, nodeId: 24, gate: 'formValues', state: 'valueinput',
  value: '7',
} as const;

const relationshipProof = {
  kind: 'aria-relationship',
  bridge: 'isolated-html',
  nodeId: 30,
  revision: 1,
  gate: 'controlSemantics',
  relation: 'labelledby',
  targetNodeIds: [31, 32],
  classifierVersion: 1,
} as const;

describe('semantic source protocol', () => {
  it('accepts exact classified, policy-bound records', () => {
    expect(readSemanticSourceRecord(ordinaryRecord)).toEqual(ordinaryRecord);
    expect(readSemanticSourceProof(selectProof)).toEqual(selectProof);
    expect(readSemanticSourceProof(selectPresentationProof))
      .toEqual(selectPresentationProof);
    expect(readSemanticSourceProof(disclosureProof)).toEqual(disclosureProof);
    expect(readSemanticSourceProof(tabProof)).toEqual(tabProof);
    expect(readSemanticSourceProof(structuralMenuProof)).toEqual(structuralMenuProof);
    // A menu offered cut says so (D219); `cut` is `true` or absent.
    const cutMenu = { ...structuralMenuProof, cut: true as const };
    expect(readSemanticSourceProof(cutMenu)).toEqual(cutMenu);
    expect(readSemanticSourceProof({ ...structuralMenuProof, cut: false })).toBeUndefined();
    expect(semanticSourceProofSignature(cutMenu))
      .not.toBe(semanticSourceProofSignature(structuralMenuProof));
    expect(readSemanticSourceProof(choiceProof)).toEqual(choiceProof);
    expect(readSemanticSourceProof(controlProof)).toEqual(controlProof);
    expect(readSemanticSourceProof(ariaProof)).toEqual(ariaProof);
    expect(readSemanticSourceProof(pressedProof)).toEqual(pressedProof);
    expect(readSemanticSourceProof(currentProof)).toEqual(currentProof);
    expect(readSemanticSourceProof(rangeProof)).toEqual(rangeProof);
    expect(readSemanticSourceProof(valueInputProof)).toEqual(valueInputProof);
    expect(readSemanticSourceProof(relationshipProof)).toEqual(relationshipProof);
    expect(readSemanticSourceProof({
      ...relationshipProof, relation: 'describedby',
    })).toEqual({ ...relationshipProof, relation: 'describedby' });
    expect(readSemanticSourceProof({ ...pressedProof, value: 'mixed' }))
      .toEqual({ ...pressedProof, value: 'mixed' });
    expect(readSemanticSourceProof({ ...rangeProof, value: '-7' }))
      .toEqual({ ...rangeProof, value: '-7' });
    const proofs = [
      selectProof, selectPresentationProof, disclosureProof, choiceProof,
      controlProof, ariaProof, valueInputProof, relationshipProof, tabProof,
      structuralMenuProof,
    ] as const;
    const computedBytes = semanticSourceBatchByteLength([ordinaryRecord], proofs);
    expect(readSemanticSourceBatch({
      protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
      kind: 'simul:semantic-source-v2:batch',
      document: documentIdentity,
      policyFingerprint: 'read-v1-111111',
      sequence: 1,
      records: [ordinaryRecord],
      proofs,
      byteLength: computedBytes,
    }, documentIdentity, 'read-v1-111111', 'isolated-html',
    FULL_VISIBLE_REPLICA_READ_SCOPE)).toBeDefined();
  });

  it('carries the length of a credential field only as a bounded count (D91)', () => {
    const masked = {
      kind: 'masked-length', bridge: 'isolated-html', nodeId: 12, revision: 1,
      gate: 'formValues', length: 8, classifierVersion: 1,
    } as const;
    expect(readSemanticSourceProof(masked)).toEqual(masked);
    expect(readSemanticSourceProof({ ...masked, length: 0 }))
      .toEqual({ ...masked, length: 0 });
    expect(readSemanticSourceProof({ ...masked, length: 256 }))
      .toEqual({ ...masked, length: 256 });
    for (const forged of [
      { ...masked, length: 257 },
      { ...masked, length: -1 },
      { ...masked, length: 2.5 },
      { ...masked, length: '8' },
      { ...masked, gate: 'controlSemantics' },
      { ...masked, text: 'hunter22' },
      { ...masked, nodeId: 0 },
    ]) {
      expect(readSemanticSourceProof(forged)).toBeUndefined();
    }
  });

  it('carries what the page shows that no attribute says: expanded, and an open popover (D132)', () => {
    const expanded = {
      ...ariaProof, nodeId: 25, gate: 'controlSemantics', state: 'expanded',
      value: 'true',
    } as const;
    expect(readSemanticSourceProof(expanded)).toEqual(expanded);
    expect(readSemanticSourceProof({ ...expanded, value: 'false' }))
      .toEqual({ ...expanded, value: 'false' });
    expect(semanticSourceProofIdentity(expanded))
      .toBe('semantic-aria-state-v1:25:expanded');
    const popover = {
      kind: 'popover-open', bridge: 'isolated-html', nodeId: 26, revision: 1,
      gate: 'controlSemantics', classifierVersion: 1,
    } as const;
    expect(readSemanticSourceProof(popover)).toEqual(popover);
    expect(semanticSourceProofIdentity(popover))
      .toBe('semantic-popover-open-v1:26');
    for (const forged of [
      // Page state, never under the form-value setting; a plain yes or no.
      { ...expanded, gate: 'formValues' },
      { ...expanded, value: 'mixed' },
      { ...expanded, value: 'menu' },
      { ...popover, gate: 'formValues' },
      { ...popover, nodeId: 0 },
      { ...popover, open: true },
      { ...popover, text: 'Menu' },
    ]) {
      expect(readSemanticSourceProof(forged)).toBeUndefined();
    }
    const batch = createSemanticSourceBatch(
      documentIdentity, 'read-v1-111111', 1, [], [expanded, popover],
    );
    expect(readSemanticSourceBatch(batch, documentIdentity, 'read-v1-111111'))
      .toEqual(batch);
  });

  it('rejects unsafe or malformed aria relationship proofs', () => {
    // Page-authored relationship, so it must read under controlSemantics.
    expect(readSemanticSourceProof({ ...relationshipProof, gate: 'formValues' }))
      .toBeUndefined();
    // Only labelledby/describedby travel; controls/owns/details do not.
    expect(readSemanticSourceProof({ ...relationshipProof, relation: 'owns' }))
      .toBeUndefined();
    // At least one, no self-reference, no duplicates, all positive integers.
    expect(readSemanticSourceProof({ ...relationshipProof, targetNodeIds: [] }))
      .toBeUndefined();
    expect(readSemanticSourceProof({ ...relationshipProof, targetNodeIds: [30] }))
      .toBeUndefined();
    expect(readSemanticSourceProof({
      ...relationshipProof, targetNodeIds: [31, 31],
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...relationshipProof, targetNodeIds: [31, 0],
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...relationshipProof,
      targetNodeIds: Array.from({ length: 33 }, (_unused, index) => index + 31),
    })).toBeUndefined();
    // labelledby and describedby on one node are distinct proof identities.
    expect(semanticSourceProofIdentity(relationshipProof)).not.toBe(
      semanticSourceProofIdentity({
        ...relationshipProof, relation: 'describedby',
      }),
    );
  });

  it('binds start/ack parsing to the exact bridge, document and scope', () => {
    expect(SEMANTIC_SOURCE_PROTOCOL_VERSION).toBe(3);
    const portName = createSemanticSourcePortName(
      documentIdentity.sessionId,
      'isolated-html',
    );
    const port = readSemanticSourcePortIdentity(portName, 'isolated-html')!;
    expect(portName).toBe(
      `simul:semantic-source-v2:isolated-html:${documentIdentity.sessionId}`,
    );
    expect(readSemanticSourcePortIdentity(
      `simul:semantic-source-v1:isolated-html:${documentIdentity.sessionId}`,
    )).toBeUndefined();
    const start = createSemanticSourceStart(
      'isolated-html',
      documentIdentity,
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    );
    expect(readSemanticSourceControllerMessage(start, port)).toEqual(start);
    expect(readSemanticSourceControllerMessage({
      ...start,
      bridge: 'legacy',
    }, port)).toBeUndefined();
    expect(readSemanticSourceControllerMessage({
      ...start,
      policyFingerprint: 'read-v1-000000',
    }, port)).toBeUndefined();
  });

  it('rejects forged categories, secret facts, extra keys and stale policy', () => {
    expect(readSemanticSourceRecord({
      ...ordinaryRecord,
      category: 'public-semantic',
    })).toBeUndefined();
    expect(readSemanticSourceRecord({
      ...ordinaryRecord,
      type: 'password',
      category: 'secret',
    })).toBeUndefined();
    expect(readSemanticSourceRecord({
      ...ordinaryRecord,
      sourceValue: 'leak',
    })).toBeUndefined();
    expect(readSemanticSourceBatch({
      protocolVersion: 1,
      kind: 'simul:semantic-source-v2:batch',
      document: documentIdentity,
      policyFingerprint: 'read-v1-111111',
      sequence: 1,
      records: [],
      proofs: [],
      byteLength: 0,
    }, documentIdentity, 'read-v1-000000')).toBeUndefined();
  });

  it('rejects forged proof identity, shape, scope, and duplicate identities', () => {
    expect(readSemanticSourceProof({
      ...disclosureProof,
      relationId: 'semantic-relation-v1:10:12',
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...tabProof,
      relationId: semanticTabRelationId(14, 16),
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...tabProof,
      gate: 'disclosureContent',
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...structuralMenuProof,
      relationId: semanticStructuralMenuRelationId(16, 17, 19),
    })).toBeUndefined();
    // A structural menu reports whether the source page shows it (D82), but
    // only as a boolean.
    expect(readSemanticSourceProof({
      ...structuralMenuProof,
      expanded: true,
    })).toEqual(expect.objectContaining({ expanded: true }));
    expect(readSemanticSourceProof({
      ...structuralMenuProof,
      expanded: 'true',
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...structuralMenuProof,
      containerNodeId: structuralMenuProof.triggerNodeId,
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...selectProof,
      selectedOptionNodeIds: [8, 8],
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...selectProof,
      selectedOptionNodeIds: Array.from({ length: 33 }, (_, index) => index + 20),
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...selectPresentationProof,
      size: 1_001,
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...selectPresentationProof,
      gate: 'formValues',
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...disclosureProof,
      revision: 0,
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...choiceProof,
      gate: 'controlSemantics',
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...choiceProof,
      sourceChecked: 'leak',
    })).toBeUndefined();
    expect(readSemanticSourceProof({
      ...ariaProof,
      state: 'selected',
    })).toBeUndefined();
    // Page state never reads under the choice gate and choice state never
    // reads under the structure gate.
    expect(readSemanticSourceProof({ ...ariaProof, state: 'current' }))
      .toBeUndefined();
    expect(readSemanticSourceProof({ ...currentProof, gate: 'formValues' }))
      .toBeUndefined();
    expect(readSemanticSourceProof({ ...pressedProof, gate: 'controlSemantics' }))
      .toBeUndefined();
    // Bounded tokens and decimals only.
    expect(readSemanticSourceProof({ ...currentProof, value: 'mixed' }))
      .toBeUndefined();
    expect(readSemanticSourceProof({ ...currentProof, value: 'Page' }))
      .toBeUndefined();
    for (const value of ['1e3', '0x10', '.5', '01', '1.', '12345678901234567', 'NaN', '']) {
      expect(readSemanticSourceProof({ ...rangeProof, value })).toBeUndefined();
    }
    expect(readSemanticSourceProof({ ...rangeProof, value: 42.5 }))
      .toBeUndefined();

    const proofs = [selectProof, { ...selectProof, revision: 3 }] as const;
    expect(readSemanticSourceBatch({
      protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
      kind: 'simul:semantic-source-v2:batch',
      document: documentIdentity,
      policyFingerprint: 'read-v1-111111',
      sequence: 1,
      records: [],
      proofs,
      byteLength: semanticSourceBatchByteLength([], proofs),
    }, documentIdentity, 'read-v1-111111', 'isolated-html',
    FULL_VISIBLE_REPLICA_READ_SCOPE)).toBeUndefined();

    expect(readSemanticSourceBatch({
      protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
      kind: 'simul:semantic-source-v2:batch',
      document: documentIdentity,
      policyFingerprint: 'read-v1-000000',
      sequence: 1,
      records: [],
      proofs: [disclosureProof],
      byteLength: semanticSourceBatchByteLength([], [disclosureProof]),
    }, documentIdentity, 'read-v1-000000', 'isolated-html',
    PAGE_ONLY_REPLICA_READ_SCOPE)).toBeUndefined();

    expect(readSemanticSourceBatch({
      protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
      kind: 'simul:semantic-source-v2:batch',
      document: documentIdentity,
      policyFingerprint: 'read-v1-111111',
      sequence: 1,
      records: [],
      proofs: [],
      byteLength: 0,
    }, documentIdentity, undefined, 'isolated-html',
    PAGE_ONLY_REPLICA_READ_SCOPE)).toBeUndefined();

    const tooManyProofs = Array.from({ length: MAX_SEMANTIC_SOURCE_PROOFS + 1 }, (_, index) => ({
      ...choiceProof,
      nodeId: 100 + index,
    }));
    expect(readSemanticSourceBatch({
      protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
      kind: 'simul:semantic-source-v2:batch',
      document: documentIdentity,
      policyFingerprint: 'read-v1-111111',
      sequence: 1,
      records: [],
      proofs: tooManyProofs,
      byteLength: semanticSourceBatchByteLength([], tooManyProofs),
    })).toBeUndefined();
  });

  it('binds inline tab state to control semantics independently of disclosure text', () => {
    const controlOnly = {
      controlSemantics: true,
      controlImages: false,
      disclosureContent: false,
      formValues: false,
      personalDataValues: false,
      editableContent: false,
    } as const;
    const controlBatch = {
      protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
      kind: 'simul:semantic-source-v2:batch',
      document: documentIdentity,
      policyFingerprint: 'read-v1-100000',
      sequence: 1,
      records: [],
      proofs: [tabProof],
      byteLength: semanticSourceBatchByteLength([], [tabProof]),
    } as const;
    expect(readSemanticSourceBatch(
      controlBatch,
      documentIdentity,
      'read-v1-100000',
      'isolated-html',
      controlOnly,
    )).toBeDefined();

    const disclosureOnly = {
      ...controlOnly,
      controlSemantics: false,
      disclosureContent: true,
    } as const;
    expect(readSemanticSourceBatch(
      { ...controlBatch, policyFingerprint: 'read-v1-001000' },
      documentIdentity,
      'read-v1-001000',
      'isolated-html',
      disclosureOnly,
    )).toBeUndefined();
  });

  it('binds record identity to exactly one bridge node and presentation slot', () => {
    expect(readSemanticSourceRecord({
      ...ordinaryRecord,
      nodeId: ordinaryRecord.nodeId + 1,
    })).toBeUndefined();
    expect(readSemanticSourceRecord({
      ...ordinaryRecord,
      presentation: 'placeholder',
    })).toBeUndefined();
  });

  it('admits public labels for ordinary and personal controls independently', () => {
    expect(readSemanticSourceRecord({
      ...ordinaryRecord,
      recordId: 33,
      nodeRevision: 1,
      gate: 'controlSemantics',
      presentation: 'label',
      text: 'Search',
    })).toBeDefined();
    expect(readSemanticSourceRecord({
      ...ordinaryRecord,
      recordId: 41,
      nodeId: 5,
      nodeRevision: 1,
      category: 'personal',
      gate: 'controlSemantics',
      type: 'email',
      presentation: 'label',
      text: 'Email address',
    })).toBeDefined();
  });

  // D179: a batch carries only what changed since the batch before.
  it('places what is new or moved so that the receiver gets the page\'s order back', () => {
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 300; round += 1) {
      const previous = Array.from({ length: Math.floor(next() * 40) }, (_, index) =>
        index + 1);
      // Keep some, drop some, shuffle a little, add some new ones anywhere.
      const kept = previous.filter(() => next() < 0.8);
      for (let swap = 0; kept.length > 1 && swap < Math.floor(next() * 4); swap += 1) {
        const left = Math.floor(next() * kept.length);
        const right = Math.floor(next() * kept.length);
        [kept[left], kept[right]] = [kept[right]!, kept[left]!];
      }
      const order = [...kept];
      for (let add = 0; add < Math.floor(next() * 6); add += 1) {
        order.splice(Math.floor(next() * (order.length + 1)), 0, 1_000 + round * 10 + add);
      }
      const removed = new Set(previous.filter((id) => !order.includes(id)));
      const placements = semanticSourceOrderPlacements(previous, order, 0);
      expect(applySemanticSourceOrderPlacements(previous, removed, placements, 0))
        .toEqual(order);
    }
    // Nothing moved: only the new id is placed, after the one before it.
    expect(semanticSourceOrderPlacements([1, 2, 3], [1, 2, 9, 3], 0)).toEqual([9, 2]);
    expect(semanticSourceOrderPlacements(['a', 'b'], ['a', 'b'], '')).toEqual([]);
    // Two pairs after one id, or one after an id not there, do not fit.
    expect(applySemanticSourceOrderPlacements([1, 2], new Set(), [5, 1, 6, 1], 0))
      .toBeUndefined();
    expect(applySemanticSourceOrderPlacements([1, 2], new Set(), [5, 7], 0))
      .toBeUndefined();
    expect(applySemanticSourceOrderPlacements([1, 2], new Set([2]), [5, 2], 0))
      .toBeUndefined();
  });

  it('reads a batch of what changed only in version 3 and only in its shape', () => {
    const proofId = semanticSourceProofIdentity(selectProof);
    const delta = {
      base: 4,
      removedRecordIds: [43],
      removedProofIds: [semanticSourceProofIdentity(choiceProof)],
      recordPlacements: [35, 0],
      proofPlacements: [proofId, ''],
      recordCount: 1,
      proofCount: 1,
    };
    const batch = createSemanticSourceBatch(
      documentIdentity,
      'read-v1-111111',
      5,
      [ordinaryRecord],
      [selectProof],
      { delta },
    );
    expect(batch.delta).toEqual(delta);
    expect(batch.protocolVersion).toBe(SEMANTIC_SOURCE_PROTOCOL_VERSION);
    expect(batch.byteLength).toBeGreaterThan(
      semanticSourceBatchByteLength([ordinaryRecord], [selectProof]),
    );
    const read = (change: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
      const changed = { ...delta, ...change };
      return readSemanticSourceBatch({
        protocolVersion: SEMANTIC_SOURCE_PROTOCOL_VERSION,
        kind: 'simul:semantic-source-v2:batch',
        document: documentIdentity,
        policyFingerprint: 'read-v1-111111',
        sequence: 5,
        records: [ordinaryRecord],
        proofs: [selectProof],
        byteLength: semanticSourceBatchByteLength(
          [ordinaryRecord],
          [selectProof],
          changed as typeof delta,
        ),
        delta: changed,
        ...extra,
      }, documentIdentity, 'read-v1-111111', 'isolated-html',
      FULL_VISIBLE_REPLICA_READ_SCOPE);
    };
    expect(read({})).toEqual(batch);
    // Not the batch before; an id removed and carried; removed twice;
    // placed twice; placed after a removed one; an odd list; no counts.
    expect(read({ base: 3 })).toBeUndefined();
    expect(read({ removedRecordIds: [35] })).toBeUndefined();
    expect(read({ removedRecordIds: [43, 43] })).toBeUndefined();
    expect(read({ recordPlacements: [35, 0, 35, 0] })).toBeUndefined();
    expect(read({ recordPlacements: [35, 43] })).toBeUndefined();
    expect(read({ recordPlacements: [35] })).toBeUndefined();
    expect(read({ proofPlacements: ['not a proof id', ''] })).toBeUndefined();
    expect(read({ recordCount: -1 })).toBeUndefined();
    expect(read({ extra: true })).toBeUndefined();
    // A whole-state panel of version 2 never takes one.
    expect(read({}, { protocolVersion: SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION }))
      .toBeUndefined();
    // A first batch has nothing before it.
    expect(() => createSemanticSourceBatch(
      documentIdentity,
      'read-v1-111111',
      1,
      [],
      [],
      { delta: { ...delta, base: 0, removedRecordIds: [], removedProofIds: [], recordPlacements: [], proofPlacements: [], recordCount: 0, proofCount: 0 } },
    )).toThrow();
  });

  it('takes a start and an ACK of version 2, and stamps a whole state with it', () => {
    const port = readSemanticSourcePortIdentity(createSemanticSourcePortName(
      documentIdentity.sessionId,
      'isolated-html',
    ), 'isolated-html')!;
    const start = createSemanticSourceStart(
      'isolated-html',
      documentIdentity,
      FULL_VISIBLE_REPLICA_READ_SCOPE,
      SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION,
    );
    expect(readSemanticSourceControllerMessage(start, port)?.protocolVersion).toBe(2);
    const ack = createSemanticSourceAck(
      documentIdentity,
      start.policyFingerprint,
      1,
      SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION,
    );
    expect(readSemanticSourceControllerMessage(ack, port)?.protocolVersion).toBe(2);
    expect(readSemanticSourceControllerMessage({ ...ack, protocolVersion: 4 }, port))
      .toBeUndefined();
    const whole = createSemanticSourceBatch(
      documentIdentity,
      start.policyFingerprint,
      1,
      [ordinaryRecord],
      [],
      { protocolVersion: SEMANTIC_SOURCE_WHOLE_STATE_PROTOCOL_VERSION },
    );
    // The shape a panel of version 2 reads: no key it does not know.
    expect(Object.keys(whole).sort()).toEqual([
      'byteLength', 'document', 'kind', 'policyFingerprint', 'proofs',
      'protocolVersion', 'records', 'sequence',
    ]);
    expect(whole.protocolVersion).toBe(2);
  });
});

describe('what the page says of its stylesheet links (D191)', () => {
  const href = 'https://cdn.example/site.css';

  it('carries it in version 3 only, and only in its exact shape', () => {
    const batch = createSemanticSourceBatch(
      documentIdentity, 'read-v1-111111', 1, [], [],
      { linkedSheets: { reach: 'siblings', hrefs: [href] } },
    );
    expect(batch.linkedSheets).toEqual({ reach: 'siblings', hrefs: [href] });
    expect(readSemanticSourceBatch(JSON.parse(JSON.stringify(batch)), documentIdentity))
      .toEqual(batch);
    const plain = createSemanticSourceBatch(documentIdentity, 'read-v1-111111', 1, []);
    const refused = (linkedSheets: unknown, protocolVersion = 3) => readSemanticSourceBatch({
      ...plain,
      protocolVersion,
      linkedSheets,
      byteLength: plain.byteLength + 32 + href.length * 2 + 16,
    }, documentIdentity);
    expect(refused({ reach: 'siblings', hrefs: [href] })).toBeDefined();
    expect(refused({ reach: 'siblings', hrefs: [href] }, 2)).toBeUndefined();
    expect(refused({ reach: 'far', hrefs: [href] })).toBeUndefined();
    expect(refused({ reach: 'subtree', hrefs: ['javascript:x'] })).toBeUndefined();
    expect(refused({ reach: 'subtree', hrefs: [href], more: 1 })).toBeUndefined();
  });
});
