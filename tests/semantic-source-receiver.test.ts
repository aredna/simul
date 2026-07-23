import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  SemanticSourceReceiver,
  type ResolvedSemanticSourceProof,
} from '../lib/replica/semantic-source-receiver';
import {
  createSemanticSourceBatch,
  type SemanticSourceBatch,
  type SemanticSourceRecord,
} from '../lib/replica/semantic-source-protocol';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const identity: ReplicaSourceDocumentIdentity = {
  sessionId: 'semantic-receiver-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'semantic-receiver-document',
  frameId: 0,
};

describe('semantic source receiver', () => {
  it('binds a negative translation identity, projects, and restores masked base state', () => {
    const { document } = parseHTML(
      '<html><body><input id="draft" type="text" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodeId === 7 ? input : undefined,
    });
    const record = valueRecord();
    const changes = receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [record],
    ));
    expect(changes).toHaveLength(1);
    expect(input.value).toBe('visible draft');
    expect(receiver.records()[0]).toMatchObject({
      nodeId: -record.recordId,
      nodeType: 1,
      controlTarget: 'value',
      source: 'visible draft',
    });

    expect(receiver.project({
      document: identity,
      replayLease: 2,
      nodeId: -record.recordId,
      nodeType: 1,
      controlTarget: 'value',
      sourceRevision: 1,
      source: 'visible draft',
      translationEpoch: 3,
      pairKey: 'en:ja',
      translated: '表示される下書き',
    })).toBe(true);
    expect(input.value).toBe('表示される下書き');
    receiver.clear();
    expect(input.value).toBe('***');
  });

  it('rejects a forged safe claim when the bound replica node is secret', () => {
    const { document } = parseHTML(
      '<html><body><input id="secret" type="password" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#secret')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [valueRecord()],
    ))).toBeUndefined();
    expect(input.value).toBe('***');
    expect(receiver.records()).toEqual([]);
  });

  it('rejects unreadable computed text security before touching a value', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="draft" type="text"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    let valueReads = 0;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => {
        valueReads += 1;
        throw new Error('value must remain unread');
      },
      set: () => undefined,
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      get: () => {
        throw new Error('computed security unavailable');
      },
    });
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });

    const applied = receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [valueRecord()],
    ));
    Reflect.deleteProperty(window, 'getComputedStyle');
    expect(applied).toBeUndefined();
    expect(valueReads).toBe(0);
    expect(receiver.records()).toEqual([]);
  });

  it('purges a formerly safe binding after a credential mutation', () => {
    const { document } = parseHTML(
      '<html><body><input id="draft" type="text" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });
    receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [valueRecord()],
    ));
    input.type = 'password';
    expect(receiver.refreshBindings()).toMatchObject([{ kind: 'remove' }]);
    expect(input.value).toBe('***');
    expect(receiver.records()).toEqual([]);
  });

  it('rejects evidence nested under a composed secret ancestor', () => {
    const { document } = parseHTML(
      '<html><body><section autocomplete="current-password"><input id="draft" type="text" value="***"></section></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [valueRecord()],
    ))).toBeUndefined();
    expect(input.value).toBe('***');
  });

  it('rejects evidence below an assigned-slot secret ancestor', () => {
    const { document } = parseHTML(
      '<html><body><div id="host"><input id="draft" type="text" value="***"></div></body></html>',
    );
    const host = document.querySelector('#host')!;
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section autocomplete="one-time-code"><slot></slot></section>';
    Object.defineProperty(input, 'assignedSlot', {
      configurable: true,
      value: shadow.querySelector('slot'),
    });
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [valueRecord()],
    ))).toBeUndefined();
    expect(input.value).toBe('***');
  });

  it('keeps a receiver-side secret transition sticky after attributes revert', () => {
    const { document } = parseHTML(
      '<html><body><input id="draft" type="text" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [valueRecord()],
    ))).toBeDefined();
    input.type = 'password';
    expect(receiver.refreshBindings()).toMatchObject([{ kind: 'remove' }]);
    input.type = 'text';
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [valueRecord()],
    ))).toBeUndefined();
    expect(input.value).toBe('***');
  });

  it('rejects revision rewinds and same-revision content changes', () => {
    const { document } = parseHTML(
      '<html><body><input id="draft" type="text" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [valueRecord({ nodeRevision: 2 })],
    ))).toBeDefined();
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [valueRecord({ nodeRevision: 1 })],
    ))).toBeUndefined();
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [valueRecord({
        nodeRevision: 2,
        text: 'retargeted content',
      })],
    ))).toBeUndefined();
    expect(input.value).toBe('visible draft');
  });

  it('rejects a non-deterministic record identity at the receiver boundary', () => {
    const { document } = parseHTML(
      '<html><body><input id="draft" type="text" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });
    const valid = createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [valueRecord()],
    );
    const retargeted = {
      ...valid,
      records: [{ ...valid.records[0]!, recordId: 60 }],
    } as SemanticSourceBatch;
    expect(receiver.applyBatch(retargeted)).toBeUndefined();
    expect(input.value).toBe('***');
    expect(receiver.records()).toEqual([]);
  });

  it('rolls back the complete full-state batch when a later write fails', () => {
    const { document } = parseHTML(
      '<html><body><input id="first" type="text"><input id="second" type="text"></body></html>',
    );
    const first = document.querySelector<HTMLInputElement>('#first')!;
    const second = document.querySelector<HTMLInputElement>('#second')!;
    first.value = '***';
    let secondValue = '***';
    Object.defineProperty(second, 'value', {
      configurable: true,
      get: () => secondValue,
      set: (value: string) => {
        if (value === 'second draft') throw new Error('write failure');
        secondValue = value;
      },
    });
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodeId === 7 ? first : nodeId === 8 ? second : undefined,
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [
        valueRecord({ text: 'first draft' }),
        valueRecord({ recordId: 67, nodeId: 8, text: 'second draft' }),
      ],
    ))).toBeUndefined();
    expect(first.value).toBe('***');
    expect(second.value).toBe('***');
    expect(receiver.records()).toEqual([]);
  });

  it('projects an ordinary control label without admitting or replacing its value', () => {
    const { document } = parseHTML(
      '<html><body><input id="draft" type="text" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
    });
    const label = valueRecord({
      recordId: 57,
      category: 'ordinary-form',
      gate: 'controlSemantics',
      text: 'Search',
      presentation: 'label',
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [label],
    ))).toBeDefined();
    expect(input.value).toBe('***');
    expect(document.querySelector('[data-simul-semantic-source="v1"]')?.textContent)
      .toBe('Search');
  });

  it('admits custom-scope multiple selection but requires duplicate shape proofs to agree', () => {
    const { document } = parseHTML(
      '<html><body><select><option>One</option><option>Two</option></select></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('select')!;
    const options = [...select.options];
    const presented: Array<readonly ResolvedSemanticSourceProof[]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => new Map<number, Node>([
        [7, select], [8, options[0]!], [9, options[1]!],
      ]).get(nodeId),
      applyProofs: (proofs) => {
        presented.push(proofs);
        return true;
      },
    });
    const state = {
      kind: 'select-state', bridge: 'rrweb', nodeId: 7, revision: 1,
      gate: 'formValues', selectedOptionNodeIds: [8, 9], multiple: true,
      pickerOpen: false, classifierVersion: 1,
    } as const;
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [state],
    ))).toBeDefined();
    expect(presented.at(-1)?.map(({ kind }) => kind)).toEqual(['select-state']);

    const mismatchedPresentation = {
      kind: 'select-presentation', bridge: 'rrweb', nodeId: 7, revision: 1,
      gate: 'controlSemantics', multiple: false, size: null,
      classifierVersion: 1,
    } as const;
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      2,
      [],
      [state, mismatchedPresentation],
    ))).toBeUndefined();

    const presentation = { ...mismatchedPresentation, multiple: true } as const;
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [], [state, presentation],
    ))).toBeDefined();
    expect(presented.at(-1)?.map(({ kind }) => kind))
      .toEqual(['select-state', 'select-presentation']);
  });
});

function valueRecord(
  overrides: Partial<SemanticSourceRecord> = {},
): SemanticSourceRecord {
  return {
    bridge: 'rrweb',
    recordId: 59,
    nodeId: 7,
    nodeRevision: 1,
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
    ...overrides,
  };
}
