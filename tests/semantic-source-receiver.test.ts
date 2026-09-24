import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  SemanticSourceReceiver,
  type ResolvedSemanticSourceProof,
} from '../lib/replica/semantic-source-receiver';
import { SemanticProofPresenter } from '../lib/replica/semantic-proof-presenter';
import {
  createSemanticSourceBatch,
  semanticSourceRecordId,
  semanticStructuralMenuRelationId,
  semanticTabRelationId,
  type SemanticSourceBatch,
  type SemanticSourceProof,
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
    // Nothing draws an accessible name, so it is kept but not translated
    // (D67): no translation change and no translation record.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [label],
    ))).toEqual([]);
    expect(receiver.records()).toEqual([]);
    expect(input.value).toBe('***');
    const owned = document.querySelector<HTMLElement>('[data-simul-semantic-source="v1"]');
    expect(owned?.textContent).toBe('Search');
    // An accessible name is not painted beside the control in the source.
    expect(owned?.hidden).toBe(true);
    expect(owned?.style.getPropertyValue('display')).toBe('none');
    expect(receiver.clear()).toEqual([]);
  });

  it('restores the newest base option label after a semantic refresh', () => {
    const { document } = parseHTML(
      '<html><body><select><option label="Original">Original</option></select></body></html>',
    );
    const option = document.querySelector<HTMLOptionElement>('option')!;
    const recordId = semanticSourceRecordId(8, 'label')!;
    const record: SemanticSourceRecord = {
      bridge: 'isolated-html',
      recordId,
      nodeId: 8,
      nodeRevision: 1,
      category: 'public-semantic',
      gate: 'controlSemantics',
      tagName: 'option',
      type: '',
      autocomplete: '',
      role: '',
      contentEditable: '',
      text: 'Original',
      presentation: 'label',
      classifierVersion: 1,
    };
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => option,
    });
    // The dropdown draws option labels, so this one is translated.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [record],
    ))).toEqual([expect.objectContaining({ kind: 'upsert' })]);
    expect(receiver.records()).toHaveLength(1);
    expect(receiver.project({
      document: identity,
      replayLease: 2,
      nodeId: -recordId,
      nodeType: 1,
      controlTarget: 'label',
      sourceRevision: 1,
      source: 'Original',
      translationEpoch: 3,
      pairKey: 'en:ja',
      translated: 'Translated',
    })).toBe(true);

    option.setAttribute('label', 'Updated base');
    expect(receiver.refreshBindings(false)).toEqual([]);
    expect(option.getAttribute('label')).toBe('Translated');

    receiver.clear();
    expect(option.getAttribute('label')).toBe('Updated base');
  });

  it('reattaches an owned control label removed by a base patch', () => {
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
    document.querySelector('[data-simul-semantic-source="v1"]')?.remove();

    expect(receiver.refreshBindings(false)).toEqual([]);
    expect(document.querySelector('[data-simul-semantic-source="v1"]')?.textContent)
      .toBe('Search');
  });

  it('admits typed ARIA state only on widgets whose replica role fits the state', () => {
    const { document } = parseHTML(
      '<html><body><a id="here" href="/here">Here</a><div id="plain">Plain</div>' +
      '<div id="upload" role="progressbar"></div><div id="volume" role="slider"></div>' +
      '<button id="bold">Bold</button></body></html>',
    );
    const nodes = new Map<number, Node>([
      [1, document.querySelector('#here')!],
      [2, document.querySelector('#plain')!],
      [3, document.querySelector('#upload')!],
      [4, document.querySelector('#volume')!],
      [5, document.querySelector('#bold')!],
    ]);
    const presented: Array<readonly ResolvedSemanticSourceProof[]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => {
        presented.push(proofs);
        return true;
      },
    });
    const aria = (
      nodeId: number,
      state: 'pressed' | 'current' | 'valuenow' | 'valueinput',
      value: string,
    ) => ({
      kind: 'aria-state', bridge: 'isolated-html', nodeId, revision: 1,
      gate: state === 'pressed' || state === 'valueinput'
        ? 'formValues'
        : 'controlSemantics',
      state, value, classifierVersion: 1,
    } as const);

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [],
      [
        aria(1, 'current', 'page'), aria(3, 'valuenow', '42'),
        aria(4, 'valueinput', '7'), aria(5, 'pressed', 'true'),
      ],
    ))).toBeDefined();
    expect(presented.at(-1)?.map((proof) => proof.kind === 'aria-state'
      ? `${proof.proof.state}=${proof.proof.value}`
      : proof.kind)).toEqual([
        'current=page', 'valuenow=42', 'valueinput=7', 'pressed=true',
      ]);

    // A slider's value is user input (valueinput), never an indicator's
    // read-only valuenow; an indicator never carries the user-input value; a
    // plain div has no current-item semantics; a link is not a toggle button.
    for (const forged of [
      aria(4, 'valuenow', '7'),
      aria(3, 'valueinput', '42'),
      aria(2, 'current', 'page'),
      aria(1, 'pressed', 'true'),
    ]) {
      expect(receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 2, [], [forged],
      ))).toBeUndefined();
    }
  });

  it('re-points aria relationships at represented, safe, same-scope nodes only', () => {
    const { document } = parseHTML(
      '<html><body><h2 id="t">Billing</h2><p id="d">Desc</p>' +
      '<div id="region">Fields</div><input id="pw" type="password"></body></html>',
    );
    const nodes = new Map<number, Node>([
      [1, document.querySelector('#region')!],
      [2, document.querySelector('#t')!],
      [3, document.querySelector('#d')!],
      [4, document.querySelector('#pw')!],
    ]);
    const presented: Array<readonly ResolvedSemanticSourceProof[]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => {
        presented.push(proofs);
        return true;
      },
    });
    const rel = (
      nodeId: number,
      relation: 'labelledby' | 'describedby',
      targetNodeIds: number[],
      revision = 1,
    ) => ({
      kind: 'aria-relationship', bridge: 'isolated-html', nodeId, revision,
      gate: 'controlSemantics', relation, targetNodeIds, classifierVersion: 1,
    } as const);
    const relationshipsBy = (index: number) => presented[index]!
      .filter((proof) => proof.kind === 'aria-relationship')
      .map((proof) => proof.kind === 'aria-relationship'
        ? [proof.proof.relation,
          proof.references.map((ref) => (ref as HTMLElement).id)]
        : []);

    // The secret password reference (4) and the unknown id (9) are filtered;
    // the public heading and description survive.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [],
      [rel(1, 'labelledby', [2, 4, 9]), rel(1, 'describedby', [3])],
    ))).toBeDefined();
    expect(relationshipsBy(0)).toEqual([
      ['labelledby', ['t']],
      ['describedby', ['d']],
    ]);

    // A relationship whose every reference is unrepresented resolves to an
    // empty reference set rather than voiding the whole batch.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [], [rel(1, 'labelledby', [9], 2)],
    ))).toBeDefined();
    expect(relationshipsBy(1)).toEqual([['labelledby', []]]);
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
      kind: 'select-state', bridge: 'isolated-html', nodeId: 7, revision: 1,
      gate: 'formValues', selectedOptionNodeIds: [8, 9], multiple: true,
      pickerOpen: false, classifierVersion: 1,
    } as const;
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [state],
    ))).toBeDefined();
    expect(presented.at(-1)?.map(({ kind }) => kind)).toEqual(['select-state']);

    const mismatchedPresentation = {
      kind: 'select-presentation', bridge: 'isolated-html', nodeId: 7, revision: 1,
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

  it('reports proof presentation failure after a base replay refresh', () => {
    const { document } = parseHTML(
      '<html><body><select><option selected>One</option></select></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('select')!;
    const option = select.options[0]!;
    let rejectPresentation = false;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodeId === 7 ? select : nodeId === 8
        ? option
        : undefined,
      applyProofs: () => !rejectPresentation,
    });
    const proof = {
      kind: 'select-state', bridge: 'isolated-html', nodeId: 7, revision: 1,
      gate: 'formValues', selectedOptionNodeIds: [8], multiple: false,
      pickerOpen: false, classifierVersion: 1,
    } as const;

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [proof],
    ))).toBeDefined();
    expect(receiver.proofPresentationHealthy).toBe(true);

    rejectPresentation = true;
    expect(receiver.refreshBindings()).toEqual([]);
    expect(receiver.proofPresentationHealthy).toBe(false);
  });

  it('receiver-validates a structural menu and requires admitted panel text', () => {
    const { document } = parseHTML(`<html><body><nav><div id="wrapper">
      <a id="trigger" href="/resources">Resources</a>
      <div id="panel" class="hidden"><a id="item" href="/school">***</a></div>
    </div></nav></body></html>`);
    const container = document.querySelector<HTMLElement>('#wrapper')!;
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const text = document.querySelector('#item')!.firstChild!;
    const nodes = new Map<number, Node>([
      [16, container], [17, trigger], [18, panel], [19, text],
    ]);
    const presented: Array<readonly ResolvedSemanticSourceProof[]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => {
        presented.push(proofs);
        return true;
      },
    });
    const proof = structuralMenuProof();
    const record: SemanticSourceRecord = {
      bridge: 'isolated-html',
      recordId: semanticSourceRecordId(19, 'text')!,
      nodeId: 19,
      nodeRevision: 1,
      category: 'public-semantic',
      gate: 'disclosureContent',
      tagName: 'a',
      type: '',
      autocomplete: '',
      role: '',
      contentEditable: '',
      text: 'Startup School',
      presentation: 'text',
      classifierVersion: 1,
    };
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [record], [proof],
    ))).toBeDefined();
    expect(text.nodeValue).toBe('Startup School');
    expect(presented.at(-1)?.[0]).toMatchObject({
      kind: 'structural-menu',
      container,
      trigger,
      panel,
    });

    const missingTextReceiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
    });
    expect(missingTextReceiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [proof],
    ))).toBeUndefined();
  });

  it('presents a structural menu locally in the isolated replica', () => {
      const { document, window } = parseHTML(`<html><body><nav>
        <div id="wrapper"><a id="trigger" href="/resources">Resources</a>
        <div id="panel" class="hidden"><a id="item" href="/school">***</a></div>
        </div></nav><iframe id="frame"></iframe></body></html>`);
      const container = document.querySelector<HTMLElement>('#wrapper')!;
      const trigger = document.querySelector<HTMLElement>('#trigger')!;
      const panel = document.querySelector<HTMLElement>('#panel')!;
      const item = document.querySelector<HTMLElement>('#item')!;
      const text = item.firstChild!;
      const frame = document.querySelector('#frame') as unknown as HTMLIFrameElement;
      const nodes = new Map<number, Node>([
        [16, container], [17, trigger], [18, panel], [19, text],
      ]);
      const presenter = new SemanticProofPresenter({
        document: document as unknown as Document,
        iframe: frame,
      });
      const receiver = new SemanticSourceReceiver({
        document: identity,
        replicaDocument: document as unknown as Document,
        resolveNode: (nodeId) => nodes.get(nodeId),
        applyProofs: (proofs) => presenter.apply(proofs),
      });
      const record: SemanticSourceRecord = {
        bridge: 'isolated-html',
        recordId: semanticSourceRecordId(19, 'text')!,
        nodeId: 19,
        nodeRevision: 1,
        category: 'public-semantic',
        gate: 'disclosureContent',
        tagName: 'a',
        type: '',
        autocomplete: '',
        role: '',
        contentEditable: '',
        text: 'Startup School',
        presentation: 'text',
        classifierVersion: 1,
      };

      expect(receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1, [record], [structuralMenuProof()],
      ))).toBeDefined();
      expect(item.textContent).toBe('Startup School');
      // Closed, the panel keeps the page's own state and catches no pointer.
      expect(panel.hasAttribute('hidden')).toBe(false);
      expect(panel.style.getPropertyValue('display')).toBe('');
      expect(panel.style.getPropertyValue('pointer-events')).toBe('none');

      // Open, it is revealed where the page draws it (D82).
      trigger.dispatchEvent(new window.Event('pointerenter', { bubbles: true }));
      expect(panel.style.getPropertyValue('display')).toBe('block');
      expect(panel.style.getPropertyValue('visibility')).toBe('visible');
      expect(panel.style.getPropertyValue('opacity')).toBe('1');
      expect(panel.parentElement).toBe(container);
      expect(trigger.getAttribute('aria-expanded')).toBe('true');

      const action = new window.Event('click', { bubbles: true, cancelable: true });
      expect(item.dispatchEvent(action)).toBe(false);
      expect(action.defaultPrevented).toBe(true);
      receiver.clear();
      expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger'))
        .toBe(false);
  });

  it('presents a CSS hover menu in a header list item, open while the source shows it (D82)', () => {
    const { document } = parseHTML(`<html><body><header><ul>
      <li id="wrapper"><a id="trigger">Transfers</a>
      <ul id="panel"><li id="item">***</li></ul></li>
      </ul></header><iframe id="frame"></iframe></body></html>`);
    const { receiver, trigger, panel } = hoverMenuReplica(document, [16, 17, 18, 19]);

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'One-off transfer', 'li')],
      [{ ...structuralMenuProof(), expanded: true }],
    ))).toBeDefined();
    expect(document.querySelector('#item')!.textContent).toBe('One-off transfer');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.style.getPropertyValue('visibility')).toBe('visible');
    expect(panel.style.getPropertyValue('opacity')).toBe('1');
  });

  it('refuses a structural menu whose panel is a single link (D82)', () => {
    const { document } = parseHTML(`<html><body><nav>
      <div id="wrapper"><span id="trigger">Tax advisers</span>
      <a id="panel" href="/tax"><span id="item">***</span></a></div>
      </nav><iframe id="frame"></iframe></body></html>`);
    const { receiver } = hoverMenuReplica(document, [16, 17, 18, 19]);

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Tax advisers', 'span')],
      [structuralMenuProof()],
    ))).toBeUndefined();
  });

  it('rewrites menu text into a replica node a live patch replaced (D82)', () => {
    // A hover on the page repaints the header; the patch rebuilds the text
    // nodes of every hidden menu, and their text used to be lost.
    const { document } = parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><button id="trigger">Deposits</button>
      <div id="panel"><a id="item" href="/yen">***</a></div></li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const { receiver, nodes, trigger } = hoverMenuReplica(
      document,
      [16, 17, 18, 19],
    );
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Yen deposits')],
      [structuralMenuProof()],
    ))).toBeDefined();

    const item = document.querySelector('#item')!;
    const replacement = document.createTextNode('');
    item.replaceChild(replacement, item.firstChild!);
    nodes.set(19, replacement);
    const changes = receiver.refreshBindings();

    expect(replacement.nodeValue).toBe('Yen deposits');
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'upsert' }));
    expect(changes.some((change) => change.kind === 'remove')).toBe(false);
    expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(true);
  });

  it('stops presenting only the menu whose text is gone (D82)', () => {
    const { document } = parseHTML(`<html><body><nav><ul>
      <li id="first"><button id="first-trigger">Deposits</button>
      <div id="first-panel"><a id="first-item" href="/yen">***</a></div></li>
      <li id="second"><button id="second-trigger">Cards</button>
      <div id="second-panel"><a id="second-item" href="/debit">***</a></div></li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const first = document.querySelector('#first-item')!;
    const second = document.querySelector('#second-item')!;
    const nodes = new Map<number, Node>([
      [16, document.querySelector('#first')!],
      [17, document.querySelector('#first-trigger')!],
      [18, document.querySelector('#first-panel')!],
      [19, first.firstChild!],
      [26, document.querySelector('#second')!],
      [27, document.querySelector('#second-trigger')!],
      [28, document.querySelector('#second-panel')!],
      [29, second.firstChild!],
    ]);
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
      iframe: document.querySelector('#frame') as unknown as HTMLIFrameElement,
    });
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => presenter.apply(proofs),
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Yen deposits'), menuTextRecord(29, 'Debit card')],
      [structuralMenuProof(), {
        ...structuralMenuProof(),
        relationId: semanticStructuralMenuRelationId(26, 27, 28)!,
        containerNodeId: 26,
        triggerNodeId: 27,
        panelNodeId: 28,
      }],
    ))).toBeDefined();

    first.firstChild!.remove();
    nodes.delete(19);
    receiver.refreshBindings();

    const marked = (id: string) => document.querySelector(id)!
      .hasAttribute('data-simul-replica-disclosure-trigger');
    expect(marked('#first-trigger')).toBe(false);
    expect(marked('#second-trigger')).toBe(true);
    expect(second.textContent).toBe('Debit card');
  });

  it('keeps a presented structural menu when the next batch re-validates it', () => {
    // The presenter writes aria-controls and aria-expanded on the replica
    // trigger; the next batch must not mistake that for source state and
    // refuse the menu, and with it the whole batch.
    const { document } = parseHTML(`<html><body><nav>
      <div id="wrapper"><button id="trigger">Resources</button>
      <div id="panel" class="hidden"><a id="item" href="/school">***</a></div>
      </div></nav><iframe id="frame"></iframe></body></html>`);
    const container = document.querySelector<HTMLElement>('#wrapper')!;
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const text = document.querySelector('#item')!.firstChild!;
    const frame = document.querySelector('#frame') as unknown as HTMLIFrameElement;
    const nodes = new Map<number, Node>([
      [16, container], [17, trigger], [18, panel], [19, text],
    ]);
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
      iframe: frame,
    });
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => presenter.apply(proofs),
    });
    const record: SemanticSourceRecord = {
      bridge: 'isolated-html',
      recordId: semanticSourceRecordId(19, 'text')!,
      nodeId: 19,
      nodeRevision: 1,
      category: 'public-semantic',
      gate: 'disclosureContent',
      tagName: 'a',
      type: '',
      autocomplete: '',
      role: '',
      contentEditable: '',
      text: 'Startup School',
      presentation: 'text',
      classifierVersion: 1,
    };

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [record], [structuralMenuProof()],
    ))).toBeDefined();
    expect(trigger.getAttribute('aria-controls')).toBe(
      structuralMenuProof().relationId,
    );
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [record], [structuralMenuProof()],
    ))).toBeDefined();

    // A trigger that claims another relation is still refused.
    trigger.setAttribute('aria-controls', 'somewhere-else');
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 3, [record], [structuralMenuProof()],
    ))).toBeUndefined();
  });

  it('preserves a unique panel CSS id across inline tab apply-update-clear', () => {
    const { document } = parseHTML(`<html><head><style>#panel{display:block}</style></head>
      <body><div id="tab" role="tab" aria-selected="false"
        aria-controls="stale-control" aria-haspopup="menu">Tab</div>
      <section id="panel" role="tabpanel" aria-hidden="true">Panel</section>
      <section id="second-panel" role="tabpanel">Second</section></body></html>`);
    const trigger = document.querySelector<HTMLElement>('#tab')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const secondPanel = document.querySelector<HTMLElement>('#second-panel')!;
    const nodes = new Map<number, Node>([
      [21, trigger], [22, panel], [23, secondPanel],
    ]);
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
    });
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => presenter.apply(proofs),
    });

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [tabStateProof(1, true)],
    ))).toBeDefined();
    expect(panel.id).toBe('panel');
    expect(trigger.getAttribute('aria-controls')).toBe('panel');
    expect(trigger.getAttribute('aria-selected')).toBe('true');
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false);
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(document.querySelector('[data-simul-semantic-disclosure-host]'))
      .toBeNull();
    expect(document.querySelector('[data-simul-semantic-select-host]')).toBeNull();

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [], [tabStateProof(2, false)],
    ))).toBeDefined();
    expect(panel.id).toBe('panel');
    expect(trigger.getAttribute('aria-controls')).toBe('panel');
    expect(trigger.getAttribute('aria-selected')).toBe('false');
    expect(panel.getAttribute('aria-hidden')).toBe('true');

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 3, [], [tabStateProof(3, true)],
    ))).toBeDefined();
    expect(panel.id).toBe('panel');
    expect(trigger.getAttribute('aria-selected')).toBe('true');

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 4, [], [tabStateProof(2, false)],
    ))).toBeUndefined();
    expect(trigger.getAttribute('aria-selected')).toBe('true');

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      4,
      [],
      [tabStateProof(4, false), tabStateProof(1, true, 21, 23)],
    ))).toBeUndefined();
    expect(trigger.getAttribute('aria-selected')).toBe('true');

    panel.setAttribute('role', 'region');
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 4, [], [tabStateProof(4, false)],
    ))).toBeUndefined();
    panel.setAttribute('role', 'tabpanel');
    expect(trigger.getAttribute('aria-selected')).toBe('true');

    receiver.clear();
    expect(panel.id).toBe('panel');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.getAttribute('aria-controls')).toBe('stale-control');
    expect(trigger.getAttribute('aria-selected')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('retains unchanged proof presentation across a text-only batch', () => {
    const { document } = parseHTML(`<html><body>
      <div role="tab" aria-selected="false">Tab</div>
      <section id="panel" role="tabpanel" aria-hidden="true">Panel</section>
      <span id="label">Replica original</span></body></html>`);
    const trigger = document.querySelector<HTMLElement>('[role="tab"]')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const labelText = document.querySelector('#label')!.firstChild!;
    const applyProofs = vi.fn(() => true);
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => new Map<number, Node>([
        [21, trigger], [22, panel], [29, labelText],
      ]).get(nodeId),
      applyProofs,
    });
    const textRecord: SemanticSourceRecord = {
      bridge: 'isolated-html',
      recordId: semanticSourceRecordId(29, 'text')!,
      nodeId: 29,
      nodeRevision: 1,
      category: 'public-semantic',
      gate: 'disclosureContent',
      tagName: 'span',
      type: '',
      autocomplete: '',
      role: '',
      contentEditable: '',
      text: 'Updated label',
      presentation: 'text',
      classifierVersion: 1,
    };

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [tabStateProof(1, true)],
    ))).toBeDefined();
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [textRecord], [tabStateProof(1, true)],
    ))).toBeDefined();

    expect(labelText.nodeValue).toBe('Updated label');
    expect(applyProofs).toHaveBeenCalledOnce();
  });

  it('rolls back text and tab ARIA when proof presentation rejects a batch', () => {
    const { document } = parseHTML(`<html><body>
      <div role="tab" aria-selected="false">Tab</div>
      <section id="panel" role="tabpanel" aria-hidden="true">Panel</section>
      <p><span id="label">Replica original</span></p></body></html>`);
    const trigger = document.querySelector<HTMLElement>('[role="tab"]')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const labelText = document.querySelector('#label')!.firstChild!;
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
    });
    let rejectNext = false;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => new Map<number, Node>([
        [21, trigger], [22, panel], [29, labelText],
      ]).get(nodeId),
      applyProofs: (proofs) => {
        const applied = presenter.apply(proofs);
        if (rejectNext) {
          rejectNext = false;
          return false;
        }
        return applied;
      },
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [tabStateProof(1, true)],
    ))).toBeDefined();
    expect(trigger.getAttribute('aria-selected')).toBe('true');

    rejectNext = true;
    const textRecord: SemanticSourceRecord = {
      bridge: 'isolated-html',
      recordId: semanticSourceRecordId(29, 'text')!,
      nodeId: 29,
      nodeRevision: 1,
      category: 'public-semantic',
      gate: 'disclosureContent',
      tagName: 'span',
      type: '',
      autocomplete: '',
      role: '',
      contentEditable: '',
      text: 'Admitted source title',
      presentation: 'text',
      classifierVersion: 1,
    };
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      2,
      [textRecord],
      [tabStateProof(2, false)],
    ))).toBeUndefined();
    expect(labelText.nodeValue).toBe('Replica original');
    expect(trigger.getAttribute('aria-selected')).toBe('true');
    expect(panel.getAttribute('aria-hidden')).toBe('false');
    expect(receiver.records()).toEqual([]);
  });

  it('recreates and fully rolls back a synthetic tab panel id on updates', () => {
    const { document } = parseHTML(`<html><body>
      <div role="tab" aria-selected="false">Tab</div>
      <section role="tabpanel" aria-hidden="true">Panel</section>
    </body></html>`);
    const trigger = document.querySelector<HTMLElement>('[role="tab"]')!;
    const panel = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
    const relationId = semanticTabRelationId(21, 22)!;
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
    });
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodeId === 21 ? trigger : nodeId === 22
        ? panel
        : undefined,
      applyProofs: (proofs) => presenter.apply(proofs),
    });

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [tabStateProof(1, true)],
    ))).toBeDefined();
    expect(panel.id).toBe(relationId);
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [], [tabStateProof(2, false)],
    ))).toBeDefined();
    expect(panel.id).toBe(relationId);
    expect(trigger.getAttribute('aria-controls')).toBe(relationId);

    receiver.clear();
    expect(panel.hasAttribute('id')).toBe(false);
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
  });
});

function tabStateProof(
  revision: number,
  selected: boolean,
  tabNodeId = 21,
  panelNodeId = 22,
): Extract<SemanticSourceProof, { kind: 'tab-state' }> {
  return {
    kind: 'tab-state',
    bridge: 'isolated-html',
    relationId: semanticTabRelationId(tabNodeId, panelNodeId)!,
    revision,
    gate: 'controlSemantics',
    tabNodeId,
    panelNodeId,
    selected,
    classifierVersion: 1,
  };
}

/** A replica with one structural menu: container, trigger, panel, item text. */
function hoverMenuReplica(
  document: ReturnType<typeof parseHTML>['document'],
  [containerId, triggerId, panelId, textId]: readonly [number, number, number, number],
) {
  const container = document.querySelector<HTMLElement>('#wrapper')!;
  const trigger = document.querySelector<HTMLElement>('#trigger')!;
  const panel = document.querySelector<HTMLElement>('#panel')!;
  const nodes = new Map<number, Node>([
    [containerId, container],
    [triggerId, trigger],
    [panelId, panel],
    [textId, document.querySelector('#item')!.firstChild!],
  ]);
  const presenter = new SemanticProofPresenter({
    document: document as unknown as Document,
    iframe: document.querySelector('#frame') as unknown as HTMLIFrameElement,
  });
  const receiver = new SemanticSourceReceiver({
    document: identity,
    replicaDocument: document as unknown as Document,
    resolveNode: (nodeId) => nodes.get(nodeId),
    applyProofs: (proofs) => presenter.apply(proofs),
  });
  return { receiver, nodes, trigger, panel };
}

function menuTextRecord(
  nodeId: number,
  text: string,
  tagName = 'a',
): SemanticSourceRecord {
  return {
    bridge: 'isolated-html',
    recordId: semanticSourceRecordId(nodeId, 'text')!,
    nodeId,
    nodeRevision: 1,
    category: 'public-semantic',
    gate: 'disclosureContent',
    tagName,
    type: '',
    autocomplete: '',
    role: '',
    contentEditable: '',
    text,
    presentation: 'text',
    classifierVersion: 1,
  };
}

function structuralMenuProof(): Extract<SemanticSourceProof, {
  kind: 'structural-menu';
}> {
  return {
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
  };
}

function valueRecord(
  overrides: Partial<SemanticSourceRecord> = {},
): SemanticSourceRecord {
  return {
    bridge: 'isolated-html',
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
