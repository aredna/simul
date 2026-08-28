import { describe, expect, it } from 'vitest';

import {
  SEMANTIC_SOURCE_PROTOCOL_VERSION,
  createSemanticSourcePortName,
  createSemanticSourceStart,
  readSemanticSourceProof,
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

describe('semantic source protocol', () => {
  it('accepts exact classified, policy-bound records', () => {
    expect(readSemanticSourceRecord(ordinaryRecord)).toEqual(ordinaryRecord);
    expect(readSemanticSourceProof(selectProof)).toEqual(selectProof);
    expect(readSemanticSourceProof(selectPresentationProof))
      .toEqual(selectPresentationProof);
    expect(readSemanticSourceProof(disclosureProof)).toEqual(disclosureProof);
    expect(readSemanticSourceProof(tabProof)).toEqual(tabProof);
    expect(readSemanticSourceProof(structuralMenuProof)).toEqual(structuralMenuProof);
    expect(readSemanticSourceProof(choiceProof)).toEqual(choiceProof);
    expect(readSemanticSourceProof(controlProof)).toEqual(controlProof);
    expect(readSemanticSourceProof(ariaProof)).toEqual(ariaProof);
    const proofs = [
      selectProof, selectPresentationProof, disclosureProof, choiceProof,
      controlProof, ariaProof, tabProof, structuralMenuProof,
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

  it('binds start/ack parsing to the exact bridge, document and scope', () => {
    expect(SEMANTIC_SOURCE_PROTOCOL_VERSION).toBe(2);
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
    expect(readSemanticSourceProof({
      ...structuralMenuProof,
      expanded: true,
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

    const tooManyProofs = Array.from({ length: 129 }, (_, index) => ({
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
});
