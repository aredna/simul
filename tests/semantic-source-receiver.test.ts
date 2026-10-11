import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  SemanticSourceReceiver,
  semanticSelectionTextFor,
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

  it('names the element in which a record\'s text shows, for its language (D124)', () => {
    const { document } = parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><button id="trigger">Deposits</button>
      <div id="panel"><a id="item" href="/yen">***</a></div></li>
      </ul></nav><input id="draft" type="text" value="***"><iframe id="frame"></iframe></body></html>`);
    const { receiver, nodes } = hoverMenuReplica(document, [16, 17, 18, 19]);
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    nodes.set(7, input);
    const value = valueRecord();
    const menuText = menuTextRecord(19, 'Yen deposits');
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [value, menuText],
      [structuralMenuProof()],
    ))).toBeDefined();

    // A control shows its own value; text shows in its parent element.
    expect(receiver.elementShowing(-value.recordId)).toBe(input);
    expect(receiver.elementShowing(-menuText.recordId))
      .toBe(document.querySelector('#item'));
    expect(receiver.elementShowing(-1)).toBeUndefined();
    receiver.clear();
    expect(receiver.elementShowing(-value.recordId)).toBeUndefined();
  });

  it('drops a forged safe claim when the bound replica node is secret (D96)', () => {
    const { document } = parseHTML(
      '<html><body><input id="secret" type="password" value="***"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#secret')!;
    const drops: Array<readonly [number, number]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => input,
      reportDroppedItems: (records, proofs) => drops.push([records, proofs]),
    });
    // The record is dropped by itself; the batch commits without it.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      1,
      [valueRecord()],
    ))).toEqual([]);
    expect(input.value).toBe('***');
    expect(receiver.records()).toEqual([]);
    expect(drops).toEqual([[1, 0]]);
  });

  it('drops only the item the replica refuses; the rest of the batch applies (D96)', () => {
    // The D62 outage: one proof the receiver refused (a disabled state on a
    // plain link) refused every batch, so no label, select state or menu
    // reached the replica on any page with a link.
    const { document } = parseHTML(
      '<html><body><a id="link" href="/x">Link</a><input id="draft" type="text" value="***">' +
      '<select id="pick"><option>One</option><option>Two</option></select></body></html>',
    );
    const link = document.querySelector('#link')!;
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const select = document.querySelector<HTMLSelectElement>('#pick')!;
    const nodes = new Map<number, Node>([
      [5, link], [7, input], [30, select],
      [31, select.options[0]!], [32, select.options[1]!],
    ]);
    const presented: Array<readonly ResolvedSemanticSourceProof[]> = [];
    const drops: Array<readonly [number, number]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => {
        presented.push(proofs);
        return true;
      },
      reportDroppedItems: (records, proofs) => drops.push([records, proofs]),
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [valueRecord(), valueRecord({ recordId: semanticSourceRecordId(99, 'value')!, nodeId: 99 })],
      [
        {
          kind: 'control-state', bridge: 'isolated-html', nodeId: 5, revision: 1,
          gate: 'controlSemantics', disabled: false, classifierVersion: 1,
        },
        {
          kind: 'select-state', bridge: 'isolated-html', nodeId: 30, revision: 1,
          gate: 'formValues', selectedOptionNodeIds: [32], multiple: false,
          pickerOpen: false, classifierVersion: 1,
        },
      ],
    ))).toHaveLength(1);
    expect(input.value).toBe('visible draft');
    expect(presented.at(-1)?.map(({ kind }) => kind)).toEqual(['select-state']);
    // One record (node 99 is not in the replica) and one proof were dropped.
    expect(drops).toEqual([[1, 1]]);
    // A broken stream (a revision rewind) is still refused whole; see
    // 'rejects revision rewinds and same-revision content changes'.
  });

  it('drops a record under unreadable computed text security before touching a value', () => {
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
    expect(applied).toEqual([]);
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

  it('drops evidence nested under a composed secret ancestor', () => {
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
    ))).toEqual([]);
    expect(input.value).toBe('***');
  });

  it('drops evidence below an assigned-slot secret ancestor', () => {
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
    ))).toEqual([]);
    expect(input.value).toBe('***');
  });

  describe('editor text that is drawn through a slot, or in a root', () => {
    function editorRecord(
      id: number,
      text: string,
      overrides: Partial<SemanticSourceRecord> = {},
    ): SemanticSourceRecord {
      return {
        bridge: 'isolated-html',
        recordId: semanticSourceRecordId(id, 'text')!,
        nodeId: id,
        nodeRevision: 1,
        category: 'editable',
        gate: 'editableContent',
        tagName: 'div',
        type: '',
        autocomplete: '',
        role: '',
        contentEditable: 'true',
        text,
        presentation: 'text',
        classifierVersion: 1,
        ...overrides,
      };
    }
    /** A replica host whose root draws its children in `rootMarkup`. */
    function replicaHost(rootMarkup: string, hostAttributes = '') {
      const { document } = parseHTML(
        `<html><body><x-note id="host" ${hostAttributes}><p id="slotted"></p></x-note></body></html>`,
      );
      const host = document.querySelector('#host')!;
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = rootMarkup;
      const slotted = document.querySelector('#slotted')!;
      const text = document.createTextNode('');
      slotted.append(text);
      const direct = document.createTextNode('');
      host.append(direct);
      const give = (slot: Element | null): void => {
        for (const node of [slotted, direct]) {
          Object.defineProperty(node, 'assignedSlot', { configurable: true, value: slot });
        }
      };
      give(shadow.querySelector('slot'));
      const nodes = new Map<number, Node>([[11, text], [12, direct]]);
      const receiver = new SemanticSourceReceiver({
        document: identity,
        replicaDocument: document as unknown as Document,
        resolveNode: (id) => nodes.get(id),
      });
      return { document, host, shadow, slotted, text, direct, give, nodes, receiver };
    }

    it('places text slotted into an editor of a root', () => {
      const replica = replicaHost('<div contenteditable="true"><slot></slot></div>');
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1,
        [editorRecord(11, 'slotted draft'), editorRecord(12, 'direct draft')],
      ))).toHaveLength(2);
      expect(replica.text.nodeValue).toBe('slotted draft');
      expect(replica.direct.nodeValue).toBe('direct draft');
    });

    it('places text of the root of a host that is an editor', () => {
      const replica = replicaHost('<p id="inside"></p><slot></slot>', 'contenteditable="true"');
      const inside = replica.document.createTextNode('');
      replica.shadow.querySelector('#inside')!.append(inside);
      replica.nodes.set(13, inside);
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1,
        [editorRecord(13, 'root draft', { tagName: 'x-note' })],
      ))).toHaveLength(1);
      expect(inside.nodeValue).toBe('root draft');
    });

    it('drops text that is slotted beside the editor, and text whose editor has another tag', () => {
      const replica = replicaHost(
        '<div contenteditable="true"><slot name="edited"></slot></div><section><slot id="plain"></slot></section>',
      );
      replica.give(replica.shadow.querySelector('#plain'));
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1, [editorRecord(11, 'slotted draft')],
      ))).toEqual([]);
      expect(replica.text.nodeValue).toBe('');
      replica.give(replica.shadow.querySelector('slot'));
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 2,
        [editorRecord(11, 'slotted draft', { tagName: 'section' })],
      ))).toEqual([]);
      expect(replica.text.nodeValue).toBe('');
    });

    it('takes the nearest editor for the one that is named: an editor that is slotted before the one around its slot', () => {
      const replica = replicaHost('<span role="textbox"><slot></slot></span>');
      replica.slotted.setAttribute('contenteditable', 'true');
      const textbox = { tagName: 'span', role: 'textbox', contentEditable: '' };
      const paragraph = { tagName: 'p', contentEditable: 'true' };
      // Named by the editor around the slot, the slotted editor's own text
      // is not placed: the page names the nearest one, as this side does.
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1,
        [editorRecord(11, 'slotted draft', textbox)],
      ))).toHaveLength(0);
      expect(replica.text.nodeValue).toBe('');
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 2,
        [
          editorRecord(11, 'slotted draft', paragraph),
          editorRecord(12, 'direct draft', textbox),
        ],
      ))).toHaveLength(2);
      expect(replica.text.nodeValue).toBe('slotted draft');
      expect(replica.direct.nodeValue).toBe('direct draft');
    });

    it('places editor text that came before its box became an editor, once the box is one', () => {
      // The page's labels and its structure travel apart: the text of a box
      // that has just become an editor comes first.
      const replica = replicaHost('<div id="box"><slot></slot></div>');
      const { document } = replica;
      const light = document.createElement('div');
      const lightText = document.createTextNode('');
      light.append(lightText);
      document.body.append(light);
      replica.nodes.set(14, lightText);
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1,
        [editorRecord(11, 'slotted draft'), editorRecord(14, 'page draft')],
      ))).toEqual([]);
      // Nothing to place while the replica still says neither is an editor.
      expect(replica.receiver.placeArrivedNodes()).toBeUndefined();

      replica.shadow.querySelector('#box')!.setAttribute('contenteditable', 'true');
      light.setAttribute('contenteditable', 'true');
      expect(replica.receiver.placeArrivedNodes()).toHaveLength(2);
      expect(replica.text.nodeValue).toBe('slotted draft');
      expect(lightText.nodeValue).toBe('page draft');
      // Placed: not gone through again at the next change.
      expect(replica.receiver.placeArrivedNodes()).toBeUndefined();
    });

    it('tries no other kind of record again, and editor text a bounded number at a time', () => {
      const replica = replicaHost('<div id="box"><slot></slot></div>');
      const { document } = replica;
      // A value for a field the replica draws as another element for now.
      const field = document.createElement('textarea');
      document.body.append(field);
      replica.nodes.set(7, field);
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1, [valueRecord()],
      ))).toEqual([]);
      const input = document.createElement('input');
      input.setAttribute('type', 'text');
      replica.nodes.set(7, input);
      document.body.append(input);
      expect(replica.receiver.placeArrivedNodes()).toBeUndefined();

      // Three hundred texts of a box that is not an editor yet.
      const records: SemanticSourceRecord[] = [];
      for (let index = 0; index < 300; index += 1) {
        const text = document.createTextNode('');
        replica.slotted.append(text);
        replica.nodes.set(100 + index, text);
        records.push(editorRecord(100 + index, `draft ${index}`));
      }
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 2, records,
      ))).toEqual([]);
      const resolved = vi.spyOn(replica.nodes, 'get');
      expect(replica.receiver.placeArrivedNodes()).toBeUndefined();
      expect(resolved).toHaveBeenCalledTimes(256);
    });

    it('does not try again at every change a pass that could not be made', () => {
      const replica = replicaHost('<div id="box"><slot></slot></div>');
      expect(replica.receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1, [editorRecord(11, 'slotted draft')],
      ))).toEqual([]);
      replica.shadow.querySelector('#box')!.setAttribute('contenteditable', 'true');
      // The text cannot be written this once.
      let refuse = true;
      let value = '';
      Object.defineProperty(replica.text, 'nodeValue', {
        configurable: true,
        get: () => value,
        set: (next: string) => {
          if (refuse) throw new Error('not now');
          value = next;
        },
      });
      expect(replica.receiver.placeArrivedNodes()).toBeUndefined();
      refuse = false;
      expect(replica.receiver.placeArrivedNodes()).toBeUndefined();
      expect(value).toBe('');
    });

    describe('in an editor written as a bare attribute (D145)', () => {
      /** The mirror's copy of an editor, with a text node of id 11 in it. */
      function bareEditor(written: string) {
        const { document } = parseHTML(
          `<html><body><div id="editor" ${written}><p id="inside"></p></div></body></html>`,
        );
        const editor = document.querySelector('#editor')!;
        const direct = document.createTextNode('');
        editor.append(direct);
        const inside = document.createTextNode('');
        document.querySelector('#inside')!.append(inside);
        const nodes = new Map<number, Node>([[11, direct], [12, inside]]);
        const receiver = new SemanticSourceReceiver({
          document: identity,
          replicaDocument: document as unknown as Document,
          resolveNode: (id) => nodes.get(id),
        });
        return { receiver, direct, inside };
      }

      for (const written of ['contenteditable', 'contenteditable=""']) {
        it(`places the text of <div ${written}>`, () => {
          // The page script tells a bare attribute as `true`; the mirror's
          // copy of the attribute reads '' and was no editor here.
          const replica = bareEditor(written);
          expect(replica.receiver.applyBatch(createSemanticSourceBatch(
            identity, 'read-v1-111111', 1,
            [editorRecord(11, 'direct draft'), editorRecord(12, 'inside draft')],
          ))).toHaveLength(2);
          expect(replica.direct.nodeValue).toBe('direct draft');
          expect(replica.inside.nodeValue).toBe('inside draft');
        });

        it(`takes no text for the inside of <div ${written}> that is not sent as editor text`, () => {
          // What a page script of before this change sent for an editor
          // inside a menu: the editor's text as the menu's own.
          const replica = bareEditor(written);
          expect(replica.receiver.applyBatch(createSemanticSourceBatch(
            identity, 'read-v1-111000', 1,
            [editorRecord(11, 'typed draft', {
              category: 'public-semantic',
              gate: 'disclosureContent',
              contentEditable: '',
            })],
          ))).toEqual([]);
          expect(replica.direct.nodeValue).toBe('');
        });
      }

      it('takes none for an element that says it is not an editor', () => {
        const replica = bareEditor('contenteditable="false"');
        expect(replica.receiver.applyBatch(createSemanticSourceBatch(
          identity, 'read-v1-111111', 1, [editorRecord(11, 'direct draft')],
        ))).toEqual([]);
        expect(replica.direct.nodeValue).toBe('');
      });
    });
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
    ))).toEqual([]);
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
    // The name is kept with its record: no element of Simul's stands in the
    // mirror for it, where the page's own selectors would count it.
    expect(receiver.get(-57)?.source).toBe('Search');
    expect(document.body.childNodes).toHaveLength(1);
    expect(input.nextSibling).toBeNull();
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

  it('keeps a control label through a base patch without an element of its own', () => {
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

    expect(receiver.refreshBindings(false)).toEqual([]);
    expect(receiver.get(-57)?.source).toBe('Search');
    expect(document.body.childNodes).toHaveLength(1);
  });

  it('leaves a labelled control and its neighbours as the page has them', () => {
    // Tabs made of radio buttons (`.tab:checked + .tab-content`), an icon
    // button that is `:empty`, a link whose last child the page styles, and
    // a text area with a counter after it.
    const { document } = parseHTML(`<html><body><div id="tabs"><input id="radio"
      type="radio" aria-label="Preview" checked><div id="panel">Panel</div></div>
      <button id="icon" aria-label="Close"></button>
      <a id="link" title="Home"><span>Home</span><b id="last">!</b></a>
      <p><textarea id="area" aria-label="Message"></textarea><span id="count">0</span></p>
      <div id="tab" role="tab" aria-label="Files"></div>
    </body></html>`);
    const nodes = new Map<number, Element>([
      [1, document.querySelector('#radio')!],
      [2, document.querySelector('#icon')!],
      [3, document.querySelector('#link')!],
      [4, document.querySelector('#area')!],
      [5, document.querySelector('#tab')!],
    ]);
    const markup = document.body.innerHTML;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
    });
    const label = (
      nodeId: number,
      tagName: string,
      text: string,
      overrides: Partial<SemanticSourceRecord> = {},
    ): SemanticSourceRecord => valueRecord({
      recordId: semanticSourceRecordId(nodeId, 'label')!,
      nodeId,
      category: 'public-semantic',
      gate: 'controlSemantics',
      tagName,
      type: '',
      text,
      presentation: 'label',
      ...overrides,
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [
        label(1, 'input', 'Preview', { type: 'radio' }),
        label(2, 'button', 'Close'),
        label(3, 'a', 'Home'),
        label(4, 'textarea', 'Message', { category: 'ordinary-form' }),
        label(5, 'div', 'Files', { role: 'tab' }),
      ],
    ))).toEqual([]);

    // Every name was taken, and the mirror is the page's markup still.
    for (const nodeId of nodes.keys()) {
      expect(receiver.get(-semanticSourceRecordId(nodeId, 'label')!), String(nodeId))
        .toBeDefined();
    }
    expect(document.body.innerHTML).toBe(markup);
    expect(document.querySelector('#radio')!.nextElementSibling)
      .toBe(document.querySelector('#panel'));
    expect(document.querySelector('#icon')!.childNodes).toHaveLength(0);
    expect(document.querySelector('#link')!.lastElementChild)
      .toBe(document.querySelector('#last'));
    expect(document.querySelector('#area')!.nextElementSibling)
      .toBe(document.querySelector('#count'));
    expect(document.querySelector('#tab')!.childNodes).toHaveLength(0);

    // A new name, a refresh and the end of the session leave it so too.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [
        label(2, 'button', 'Dismiss', { nodeRevision: 2 }),
      ],
    ))).toEqual([]);
    expect(receiver.get(-semanticSourceRecordId(2, 'label')!)?.source).toBe('Dismiss');
    receiver.refreshBindings(false);
    receiver.clear();
    expect(document.body.innerHTML).toBe(markup);
  });

  it('holds a dropdown\'s current choice for its trigger without an element', () => {
    const { document } = parseHTML(
      '<html><body><p><select id="pick"><option>One</option></select><i id="after"></i></p></body></html>',
    );
    const select = document.querySelector('#pick')!;
    const markup = document.body.innerHTML;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => select,
    });
    const choice = (text: string, nodeRevision: number): SemanticSourceRecord =>
      valueRecord({
        recordId: semanticSourceRecordId(7, 'selection')!,
        tagName: 'select',
        type: '',
        text,
        presentation: 'selection',
        nodeRevision,
      });
    // The trigger draws the choice, so it is translated.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [choice('One', 1)],
    ))).toEqual([expect.objectContaining({ kind: 'upsert' })]);
    expect(semanticSelectionTextFor(select)).toBe('One');
    expect(document.body.innerHTML).toBe(markup);

    // The dropdown's own name, taken after its choice, is not its choice.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [
        choice('One', 1),
        valueRecord({
          recordId: semanticSourceRecordId(7, 'label')!,
          tagName: 'select',
          type: '',
          category: 'public-semantic',
          gate: 'controlSemantics',
          text: 'Fruit',
          presentation: 'label',
        }),
      ],
    ))).toEqual([]);
    expect(semanticSelectionTextFor(select)).toBe('One');
    expect(document.body.innerHTML).toBe(markup);

    expect(receiver.project({
      document: identity,
      replayLease: 2,
      nodeId: -semanticSourceRecordId(7, 'selection')!,
      nodeType: 1,
      controlTarget: 'label',
      sourceRevision: 1,
      source: 'One',
      translationEpoch: 3,
      pairKey: 'en:ja',
      translated: 'Ichi',
    })).toBe(true);
    expect(semanticSelectionTextFor(select)).toBe('Ichi');
    // What was written is kept through a refresh, and goes with the record.
    receiver.refreshBindings(false);
    expect(semanticSelectionTextFor(select)).toBe('Ichi');
    receiver.restoreSources();
    expect(semanticSelectionTextFor(select)).toBe('One');
    receiver.clear();
    expect(semanticSelectionTextFor(select)).toBeUndefined();
    expect(document.body.innerHTML).toBe(markup);
  });

  it('takes back a dropdown\'s choice when its batch cannot be committed', () => {
    const { document } = parseHTML(
      '<html><body><select id="pick"><option>One</option></select></body></html>',
    );
    const select = document.querySelector('#pick')!;
    let refuse = false;
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: () => select,
      applyProofs: () => !refuse,
    });
    const choice = (text: string, nodeRevision: number): SemanticSourceRecord =>
      valueRecord({
        recordId: semanticSourceRecordId(7, 'selection')!,
        tagName: 'select',
        type: '',
        text,
        presentation: 'selection',
        nodeRevision,
      });
    const state = (revision: number): SemanticSourceProof => ({
      kind: 'select-presentation', bridge: 'isolated-html', nodeId: 7, revision,
      gate: 'controlSemantics', multiple: false, size: revision === 1 ? null : 4,
      classifierVersion: 1,
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [choice('One', 1)], [state(1)],
    ))).toBeDefined();
    expect(semanticSelectionTextFor(select)).toBe('One');

    refuse = true;
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [choice('Two', 2)], [state(2)],
    ))).toBeUndefined();
    expect(semanticSelectionTextFor(select)).toBe('One');
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
    let sequence = 2;
    for (const forged of [
      aria(4, 'valuenow', '7'),
      aria(3, 'valueinput', '42'),
      aria(2, 'current', 'page'),
      aria(1, 'pressed', 'true'),
    ]) {
      // Each is dropped by itself (D96): the batch commits, and nothing is
      // presented for it.
      expect(receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', sequence, [], [forged],
      ))).toEqual([]);
      sequence += 1;
      expect(presented.at(-1)).toEqual([]);
    }
  });

  it('draws a credential field as dots from its count alone (D91)', () => {
    const { document } = parseHTML(
      '<html><body><input id="pw" type="password"><input id="card" type="text">' +
      '<input id="draft" type="text"><input id="box" type="checkbox"></body></html>',
    );
    const password = document.querySelector<HTMLInputElement>('#pw')!;
    const card = document.querySelector<HTMLInputElement>('#card')!;
    const draft = document.querySelector<HTMLInputElement>('#draft')!;
    const box = document.querySelector<HTMLInputElement>('#box')!;
    const nodes = new Map<number, Node>([
      [1, password], [2, card], [7, draft], [4, box],
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
    const masked = (nodeId: number, length: number) => ({
      kind: 'masked-length', bridge: 'isolated-html', nodeId, revision: 1,
      gate: 'formValues', length, classifierVersion: 1,
    } as const);

    // A checkbox cannot draw dots, node 99 is not in the replica, and the
    // draft's value travels as text: each count is dropped by itself, and
    // the rest of the batch still applies.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [valueRecord()],
      [masked(1, 8), masked(2, 16), masked(4, 3), masked(7, 5), masked(99, 2)],
    ))).toBeDefined();
    expect(password.value).toBe('\u2022'.repeat(8));
    expect(card.value).toBe('\u2022'.repeat(16));
    expect(draft.value).toBe('visible draft');
    expect(box.hasAttribute('data-simul-source-masked-length')).toBe(false);

    receiver.clear();
    expect(password.value).toBe('');
    expect(card.value).toBe('');
    expect(password.hasAttribute('data-simul-source-masked-length')).toBe(false);
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
    ))).toEqual([]);
    // State and shape disagree: neither is presented (D96).
    expect(presented.at(-1)).toEqual([]);

    const presentation = { ...mismatchedPresentation, multiple: true } as const;
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 3, [], [state, presentation],
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

    // Without admitted panel text the menu is dropped by itself (D96).
    const missingTextPresented: Array<readonly ResolvedSemanticSourceProof[]> = [];
    const missingTextReceiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => {
        missingTextPresented.push(proofs);
        return true;
      },
    });
    expect(missingTextReceiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [proof],
    ))).toEqual([]);
    expect(missingTextPresented.flat()).toEqual([]);
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
    const { receiver, trigger } = hoverMenuReplica(document, [16, 17, 18, 19]);

    // The menu is dropped by itself; its text still arrives (D96).
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Tax advisers', 'span')],
      [structuralMenuProof()],
    ))).toBeDefined();
    expect(trigger.hasAttribute('aria-controls')).toBe(false);
    expect(document.querySelector('#item')!.textContent).toBe('Tax advisers');
  });

  it('presents a structural menu whose panel sits inside a wrapper that holds nothing else', () => {
    // A header's wrapper of no height around its list: the page side names
    // the list, one wrapper down, and a hover reveals the list itself.
    const { document, window } = parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><a id="trigger" href="/products">Products</a>
      <div id="outer">
        <ul id="panel"><li><a id="item" href="/alpha">***</a></li></ul>
      </div></li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const { receiver, trigger, panel } = hoverMenuReplica(document, [16, 17, 18, 19]);

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Alpha')],
      [structuralMenuProof()],
    ))).toBeDefined();
    expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(true);
    expect(document.querySelector('#outer')!
      .hasAttribute('data-simul-replica-disclosure-trigger')).toBe(false);
    trigger.dispatchEvent(new window.Event('pointerenter', { bubbles: true }));
    expect(panel.style.getPropertyValue('display')).toBe('block');
    expect(panel.parentElement).toBe(document.querySelector('#outer'));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['holds text beside it', 'a', '<div>Sale <ul id="panel"><li><a id="item" href="/a">***</a></li></ul></div>'],
    ['holds another element', 'a', '<div><span></span><ul id="panel"><li><a id="item" href="/a">***</a></li></ul></div>'],
    ['is a link', 'span', '<a href="/x"><span id="panel"><span id="item">***</span></span></a>'],
    [
      'sits in a second wrapper',
      'a',
      '<div><div><ul id="panel"><li><a id="item" href="/a">***</a></li></ul></div></div>',
    ],
  ])('refuses a structural menu whose panel is inside a wrapper that %s', (_name, tag, held) => {
    const { document } = parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><span id="trigger">Products</span>${held}</li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const { receiver, trigger } = hoverMenuReplica(document, [16, 17, 18, 19]);

    // The menu is dropped by itself; its text still arrives (D96).
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Alpha', tag)],
      [structuralMenuProof()],
    ))).toBeDefined();
    expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(false);
    expect(document.querySelector('#item')!.textContent).toBe('Alpha');
  });

  it('refuses a structural menu whose panel sits inside its own trigger', () => {
    const { document } = parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><span id="trigger"><ul id="panel"><li id="item">***</li></ul></span>
      <span>Other</span></li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const { receiver, trigger } = hoverMenuReplica(document, [16, 17, 18, 19]);
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Alpha', 'li')],
      [structuralMenuProof()],
    ))).toBeDefined();
    expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(false);
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

    // A trigger that claims another relation is still refused: the menu is
    // withdrawn, and the rest of the batch commits (D96).
    trigger.setAttribute('aria-controls', 'somewhere-else');
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 3, [record], [structuralMenuProof()],
    ))).toBeDefined();
    expect(trigger.hasAttribute('data-simul-source-disclosure-state')).toBe(false);
    expect(text.nodeValue).toBe('Startup School');
  });

  it('takes no tab state for a panel that holds an editor, however the editor is written (D145)', () => {
    // A panel that holds an editor is no panel the mirror shows or hides by
    // a proof. A bare attribute was no editor here.
    const presented = (editor: string): boolean => {
      const { document } = parseHTML(`<html><body>
        <div id="tab" role="tab" aria-selected="false">Tab</div>
        <section id="panel" role="tabpanel"><p>Panel</p>${editor}</section>
        </body></html>`);
      const trigger = document.querySelector<HTMLElement>('#tab')!;
      const nodes = new Map<number, Node>([
        [21, trigger], [22, document.querySelector('#panel')!],
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
      receiver.applyBatch(createSemanticSourceBatch(
        identity, 'read-v1-111111', 1, [], [tabStateProof(1, true)],
      ));
      return trigger.getAttribute('aria-selected') === 'true';
    };
    expect(presented('')).toBe(true);
    expect(presented('<div contenteditable="false">words</div>')).toBe(true);
    for (const editor of [
      '<div contenteditable="true">draft</div>',
      '<div contenteditable>draft</div>',
      '<div contenteditable="">draft</div>',
    ]) expect(presented(editor), editor).toBe(false);
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

    // Two relations claim the tab: both are dropped, the rest of the batch
    // commits, and the trigger shows its own markup again (D96).
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity,
      'read-v1-111111',
      4,
      [],
      [tabStateProof(4, false), tabStateProof(1, true, 21, 23)],
    ))).toBeDefined();
    expect(trigger.getAttribute('aria-controls')).toBe('stale-control');
    expect(trigger.getAttribute('aria-selected')).toBe('false');

    // One relation alone is presented again.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 5, [], [tabStateProof(4, false)],
    ))).toBeDefined();
    expect(trigger.getAttribute('aria-controls')).toBe('panel');

    // The panel stops being a tab panel: the relation is dropped by itself.
    panel.setAttribute('role', 'region');
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 6, [], [tabStateProof(4, false)],
    ))).toBeDefined();
    panel.setAttribute('role', 'tabpanel');
    expect(trigger.getAttribute('aria-controls')).toBe('stale-control');

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

  it('places a label that came before its element once the element arrives (D132)', () => {
    // The page added a dropdown while the mirror was open: its labels travel
    // a moment after the change, its structure on the next animation frame.
    const { document } = parseHTML(
      '<html><body><select id="late"></select></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('#late')!;
    const nodes = new Map<number, Node>();
    const drops: Array<readonly [number, number]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      reportDroppedItems: (records, proofs) => drops.push([records, proofs]),
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [optionLabelRecord(31, 'Tokyo'), optionLabelRecord(32, 'Osaka')],
    ))).toEqual([]);
    expect(drops).toEqual([[2, 0]]);
    // Nothing has arrived: nothing is gone through again.
    expect(receiver.placeArrivedNodes()).toBeUndefined();
    expect(drops).toHaveLength(1);

    for (const nodeId of [31, 32]) {
      const option = document.createElement('option');
      select.append(option);
      nodes.set(nodeId, option);
    }
    expect(receiver.placeArrivedNodes()).toEqual([
      expect.objectContaining({ kind: 'upsert' }),
      expect.objectContaining({ kind: 'upsert' }),
    ]);
    expect([...select.options].map((option) => option.getAttribute('label')))
      .toEqual(['Tokyo', 'Osaka']);
    expect(receiver.records().map(({ source }) => source))
      .toEqual(['Tokyo', 'Osaka']);
    // Placed once; and the stream goes on where it was.
    expect(receiver.placeArrivedNodes()).toBeUndefined();
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2,
      [optionLabelRecord(31, 'Tokyo'), optionLabelRecord(32, 'Osaka')],
    ))).toEqual([]);
    expect(select.options[1]!.getAttribute('label')).toBe('Osaka');
  });

  it('places part of a batch when only some of its elements have arrived (D132)', () => {
    const { document } = parseHTML(
      '<html><body><select id="late"><option></option></select></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('#late')!;
    const nodes = new Map<number, Node>([[31, select.options[0]!]]);
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
    });
    const batch = createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [
        optionLabelRecord(31, 'Tokyo'), optionLabelRecord(32, 'Osaka'),
        optionLabelRecord(33, 'Kyoto'),
      ],
    );
    expect(receiver.applyBatch(batch)).toHaveLength(1);
    const second = document.createElement('option');
    select.append(second);
    nodes.set(32, second);
    // Only the label that could not be placed before is new.
    expect(receiver.placeArrivedNodes()).toEqual([
      expect.objectContaining({
        kind: 'upsert',
        record: expect.objectContaining({ source: 'Osaka' }),
      }),
    ]);
    const third = document.createElement('option');
    select.append(third);
    nodes.set(33, third);
    expect(receiver.placeArrivedNodes()).toHaveLength(1);
    expect([...select.options].map((option) => option.getAttribute('label')))
      .toEqual(['Tokyo', 'Osaka', 'Kyoto']);
  });

  it('presents a menu whose proof came before its elements (D132)', () => {
    const { document } = parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><button id="trigger">Deposits</button>
      <div id="panel"><a id="item" href="/yen">***</a></div></li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const { receiver, nodes, trigger } = hoverMenuReplica(document, [16, 17, 18, 19]);
    const arrived = new Map(nodes);
    nodes.clear();
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Yen deposits')],
      [structuralMenuProof()],
    ))).toEqual([]);
    expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(false);

    for (const [nodeId, node] of arrived) nodes.set(nodeId, node);
    expect(receiver.placeArrivedNodes()).toHaveLength(1);
    expect(trigger.getAttribute('data-simul-replica-disclosure-trigger')).toBe('v1');
    expect(document.querySelector('#item')!.textContent).toBe('Yen deposits');
  });

  it('gives a label back to an element that left and came back (D132)', () => {
    const { document } = parseHTML(
      '<html><body><select id="pick"><option></option></select></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('#pick')!;
    const first = select.options[0]!;
    const nodes = new Map<number, Node>([[31, first]]);
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [optionLabelRecord(31, 'Tokyo')],
    ))).toHaveLength(1);
    // One patch takes the option out, the next puts a new copy in, and the
    // page's own view is as it was: it sends nothing more.
    first.remove();
    nodes.delete(31);
    expect(receiver.refreshBindings()).toEqual([
      expect.objectContaining({ kind: 'remove' }),
    ]);
    expect(receiver.records()).toEqual([]);
    expect(receiver.placeArrivedNodes()).toBeUndefined();
    const again = document.createElement('option');
    select.append(again);
    nodes.set(31, again);
    expect(receiver.placeArrivedNodes()).toHaveLength(1);
    expect(again.getAttribute('label')).toBe('Tokyo');
  });

  it('presents the page\'s expanded state and its open popovers (D132)', () => {
    const { document } = parseHTML(`<html><body>
      <button id="toggle">More</button><ul><li>Item</li></ul>
      <div id="pop" popover="auto">Popover</div><div id="plain">Not one</div>
      <iframe id="frame"></iframe></body></html>`);
    const toggle = document.querySelector<HTMLElement>('#toggle')!;
    const pop = document.querySelector<HTMLElement>('#pop')!;
    const nodes = new Map<number, Node>([
      [40, toggle], [41, pop], [42, document.querySelector('#plain')!],
    ]);
    const calls: string[] = [];
    Object.defineProperties(pop, {
      showPopover: { value: () => calls.push(`show:${pop.getAttribute('popover')}`) },
      hidePopover: { value: () => calls.push('hide') },
    });
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
      iframe: document.querySelector('#frame') as unknown as HTMLIFrameElement,
    });
    const drops: Array<readonly [number, number]> = [];
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => presenter.apply(proofs),
      reportDroppedItems: (records, proofs) => drops.push([records, proofs]),
    });
    const expanded = (value: string, revision: number): SemanticSourceProof => ({
      kind: 'aria-state', bridge: 'isolated-html', nodeId: 40, revision,
      gate: 'controlSemantics', state: 'expanded', value, classifierVersion: 1,
    });
    const popoverOpen = (nodeId: number): SemanticSourceProof => ({
      kind: 'popover-open', bridge: 'isolated-html', nodeId, revision: 1,
      gate: 'controlSemantics', classifierVersion: 1,
    });

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [],
      [expanded('true', 1), popoverOpen(41), popoverOpen(42)],
    ))).toEqual([]);
    // What the page's stylesheet tests, marked as the page's own.
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('data-simul-source-aria-expanded-state')).toBe('v1');
    // Shown as `manual`: a click in the mirror cannot dismiss it.
    expect(calls).toEqual(['show:manual']);
    expect(pop.getAttribute('data-simul-source-popover-open')).toBe('v1');
    // An element the replica does not hold as a popover is not shown as one.
    expect(drops).toEqual([[0, 1]]);

    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [], [expanded('false', 2)],
    ))).toEqual([]);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(calls.at(-1)).toBe('hide');
    expect(pop.getAttribute('popover')).toBe('auto');
    expect(pop.hasAttribute('data-simul-source-popover-open')).toBe(false);

    receiver.clear();
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
    expect(toggle.hasAttribute('data-simul-source-aria-expanded-state')).toBe(false);

    // A popover that stays open is not hidden and shown again at each
    // presentation: that would lift it over a dropdown list the reader opened
    // inside it. It is shown again only after a patch has written the page's
    // attributes over it, which hides it.
    calls.length = 0;
    const again = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
      applyProofs: (proofs) => presenter.apply(proofs),
    });
    expect(again.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [expanded('true', 1), popoverOpen(41)],
    ))).toEqual([]);
    expect(again.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2, [], [expanded('false', 2), popoverOpen(41)],
    ))).toEqual([]);
    again.refreshBindings();
    expect(calls).toEqual(['show:manual']);
    pop.setAttribute('popover', 'auto');
    pop.removeAttribute('data-simul-source-popover-open');
    again.refreshBindings();
    expect(calls).toEqual(['show:manual', 'show:manual']);
    again.clear();
    expect(calls.at(-1)).toBe('hide');
    expect(pop.getAttribute('popover')).toBe('auto');
  });

  it('presents a menu on a trigger whose own expanded state it showed before (D132)', () => {
    const { document } = parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><button id="trigger">Deposits</button>
      <div id="panel"><a id="item" href="/yen">***</a></div></li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const { receiver, trigger } = hoverMenuReplica(document, [16, 17, 18, 19]);
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1, [], [{
        kind: 'aria-state', bridge: 'isolated-html', nodeId: 17, revision: 1,
        gate: 'controlSemantics', state: 'expanded', value: 'false',
        classifierVersion: 1,
      }],
    ))).toEqual([]);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The page's markup now has the shape of a menu: the same batch presents
    // it, though the trigger still carries the state written before.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2,
      [menuTextRecord(19, 'Yen deposits')],
      [structuralMenuProof()],
    ))).toHaveLength(1);
    expect(trigger.getAttribute('data-simul-replica-disclosure-trigger')).toBe('v1');
    expect(trigger.hasAttribute('data-simul-source-aria-expanded-state')).toBe(false);
  });

  it('presents a menu with an arrow button beside its link and a field in its panel (D132)', () => {
    const page = (field: string) => parseHTML(`<html><body><nav><ul>
      <li id="wrapper"><a id="trigger" href="/shop">Shop</a><button id="arrow">v</button>
      <div id="panel">${field}<a id="item" href="/a">***</a></div></li>
      </ul></nav><iframe id="frame"></iframe></body></html>`);
    const batch = createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Alpha')],
      [structuralMenuProof()],
    );

    const { document, window } = page('<input type="search"><select><option>EN</option></select>');
    const { receiver, trigger } = hoverMenuReplica(document, [16, 17, 18, 19]);
    const arrow = document.querySelector<HTMLElement>('#arrow')!;
    expect(receiver.applyBatch(batch)).toHaveLength(1);
    // Either trigger opens it; only the named one says whether it is open.
    for (const element of [trigger, arrow]) {
      expect(element.getAttribute('data-simul-replica-disclosure-trigger')).toBe('v1');
    }
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(arrow.hasAttribute('aria-expanded')).toBe(false);
    arrow.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    receiver.clear();
    expect(arrow.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(false);

    // Never around a credential field.
    const secret = page('<input type="password">');
    const refused = hoverMenuReplica(secret.document, [16, 17, 18, 19]);
    expect(refused.receiver.applyBatch(batch)).toBeDefined();
    expect(refused.trigger.hasAttribute('data-simul-replica-disclosure-trigger'))
      .toBe(false);
  });

  it('presents a button beside a list as a menu anywhere, opened by a click only (D132)', () => {
    const page = (panelTag: string) => parseHTML(`<html><body><main>
      <div id="wrapper"><button id="trigger">Row actions</button>
      <${panelTag} id="panel"><li><a id="item" href="/a">***</a></li></${panelTag}></div>
      </main><iframe id="frame"></iframe></body></html>`);
    const batch = createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [menuTextRecord(19, 'Alpha')],
      [structuralMenuProof()],
    );

    const { document, window } = page('ul');
    const { receiver, trigger } = hoverMenuReplica(document, [16, 17, 18, 19]);
    expect(receiver.applyBatch(batch)).toHaveLength(1);
    expect(trigger.getAttribute('data-simul-replica-disclosure-trigger')).toBe('v1');
    // Hovering a button that sits beside a hidden list shows nothing.
    trigger.dispatchEvent(new window.Event('pointerenter'));
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    receiver.clear();

    // A block beside a button is as often an accordion's body or a dialog.
    const block = page('div');
    const refused = hoverMenuReplica(block.document, [16, 17, 18, 19]);
    expect(refused.receiver.applyBatch(batch)).toBeDefined();
    expect(refused.trigger.hasAttribute('data-simul-replica-disclosure-trigger'))
      .toBe(false);
  });

  it('shows text without a letter or a digit and keeps it from the translator (D132)', () => {
    const { document } = parseHTML(
      '<html><body><select><option></option><option></option></select></body></html>',
    );
    const options = [...document.querySelectorAll<HTMLOptionElement>('option')];
    const nodes = new Map<number, Node>([[31, options[0]!], [32, options[1]!]]);
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: document as unknown as Document,
      resolveNode: (nodeId) => nodes.get(nodeId),
    });
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 1,
      [optionLabelRecord(31, '$'), optionLabelRecord(32, '★★★')],
    ))).toEqual([]);
    expect(options.map((option) => option.getAttribute('label')))
      .toEqual(['$', '★★★']);
    expect(receiver.records()).toEqual([]);

    // A label that gains letters is offered; one that loses them is taken back.
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 2,
      [optionLabelRecord(31, 'USD', 2), optionLabelRecord(32, '★★★')],
    ))).toEqual([expect.objectContaining({ kind: 'upsert' })]);
    expect(receiver.records().map(({ source }) => source)).toEqual(['USD']);
    expect(receiver.applyBatch(createSemanticSourceBatch(
      identity, 'read-v1-111111', 3,
      [optionLabelRecord(31, '$', 3), optionLabelRecord(32, '★★★')],
    ))).toEqual([expect.objectContaining({ kind: 'remove' })]);
    expect(options[0]!.getAttribute('label')).toBe('$');
    expect(receiver.records()).toEqual([]);
    expect(receiver.clear()).toEqual([]);
  });
});

function optionLabelRecord(
  nodeId: number,
  text: string,
  nodeRevision = 1,
): SemanticSourceRecord {
  return {
    bridge: 'isolated-html',
    recordId: semanticSourceRecordId(nodeId, 'label')!,
    nodeId,
    nodeRevision,
    category: 'public-semantic',
    gate: 'controlSemantics',
    tagName: 'option',
    type: '',
    autocomplete: '',
    role: '',
    contentEditable: '',
    text,
    presentation: 'label',
    classifierVersion: 1,
  };
}

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
