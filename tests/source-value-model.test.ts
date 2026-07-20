import { describe, expect, it } from 'vitest';

import type { ReplicaDocumentIdentity } from '../lib/replica/contracts';
import { SourceValueModel } from '../lib/replica/source-value-model';

const identity: ReplicaDocumentIdentity = {
  protocolVersion: 2,
  sessionId: 'session-source',
  pageEpoch: 4,
  generation: 4,
  documentId: 'document-source',
  frameId: 0,
  sequence: 0,
};

describe('SourceValueModel', () => {
  it('commits sanitized text transactionally and excludes private/style regions', () => {
    const model = new SourceValueModel();
    const prepared = model.prepareCheckpoint(identity, checkpointEvents());

    expect(prepared).toBeDefined();
    expect(model.records()).toEqual([]);
    expect(prepared?.records.map(({ nodeId, source }) => ({ nodeId, source }))).toEqual([
      { nodeId: 4, source: 'Hola' },
    ]);
    expect(JSON.stringify(prepared)).not.toContain('private-canary');
    expect(JSON.stringify(prepared)).not.toContain('body { color: red }');

    prepared?.commit();
    expect(model.get(4)).toMatchObject({ revision: 1, source: 'Hola' });
  });

  it('advances only changed revisions while equal writes request a reproject', () => {
    const model = readyModel();
    const equal = model.prepareBatch(
      { ...identity, sequence: 1 },
      [mutationEvent(10, { texts: [{ id: 4, value: 'Hola' }] })],
    );
    expect(equal?.changes).toEqual([
      { kind: 'upsert', record: expect.objectContaining({ nodeId: 4, revision: 1 }) },
    ]);
    equal?.commit();

    const changed = model.prepareBatch(
      { ...identity, sequence: 2 },
      [mutationEvent(20, { texts: [{ id: 4, value: 'Adiós' }] })],
    );
    expect(model.get(4)?.source).toBe('Hola');
    expect(changed?.changes).toEqual([
      {
        kind: 'upsert',
        record: expect.objectContaining({ nodeId: 4, revision: 2, source: 'Adiós' }),
      },
    ]);
    changed?.commit();
    expect(model.get(4)).toMatchObject({ revision: 2, source: 'Adiós' });
  });

  it('emits tombstones and preserves monotonic revisions when IDs return', () => {
    const model = readyModel();
    const removed = model.prepareBatch(
      { ...identity, sequence: 1 },
      [mutationEvent(10, { removes: [{ parentId: 3, id: 4 }] })],
    );
    removed?.commit();
    expect(model.get(4)).toBeUndefined();
    expect(removed?.changes).toEqual([
      expect.objectContaining({ kind: 'remove', nodeId: 4, revision: 2 }),
    ]);

    const added = model.prepareBatch(
      { ...identity, sequence: 2 },
      [
        mutationEvent(20, {
          adds: [
            {
              parentId: 3,
              previousId: null,
              nextId: null,
              node: { id: 4, type: 3, textContent: 'De vuelta' },
            },
          ],
        }),
      ],
    );
    added?.commit();
    expect(model.get(4)).toMatchObject({ revision: 3, source: 'De vuelta' });
  });

  it('reconciles same-document checkpoints without resetting revisions', () => {
    const model = readyModel();
    const changed = model.prepareBatch(
      { ...identity, sequence: 1 },
      [mutationEvent(10, { texts: [{ id: 4, value: 'Adiós' }] })],
    );
    changed?.commit();

    const recovery = model.prepareCheckpoint(
      { ...identity, sequence: 8 },
      checkpointEvents('Adiós'),
    );
    expect(recovery?.records[0]).toMatchObject({ revision: 2, source: 'Adiós' });
    expect(model.get(4)).toMatchObject({ revision: 2, source: 'Adiós' });
    recovery?.commit();
    expect(model.get(4)).toMatchObject({ revision: 2, source: 'Adiós' });
  });

  it('rejects live work for another exact document', () => {
    const model = readyModel();
    expect(
      model.prepareBatch(
        { ...identity, documentId: 'other', sequence: 1 },
        [mutationEvent(10, { texts: [{ id: 4, value: 'wrong' }] })],
      ),
    ).toBeUndefined();
    expect(model.get(4)?.source).toBe('Hola');
  });

  it('tracks the exact HTML language as committed source metadata', () => {
    const model = new SourceValueModel();
    const initial = model.prepareCheckpoint(identity, checkpointEvents('Hola', 'es'));
    expect(initial).toMatchObject({
      documentLanguage: 'es',
      documentLanguageChanged: true,
    });
    initial?.commit();

    const changed = model.prepareBatch(
      { ...identity, sequence: 1 },
      [mutationEvent(10, { attributes: [{ id: 2, attributes: { lang: 'ja' } }] })],
    );
    expect(changed).toMatchObject({
      documentLanguage: 'ja',
      documentLanguageChanged: true,
      changes: [],
    });
    expect(model.documentLanguage).toBe('es');
    changed?.commit();
    expect(model.documentLanguage).toBe('ja');
  });

  it('ignores admitted Comment and CDATA character-data writes', () => {
    const model = new SourceValueModel();
    const initial = model.prepareCheckpoint(
      identity,
      checkpointEvents('Hola', undefined, [
        { id: 9, type: 4, textContent: 'CDATA source' },
        { id: 10, type: 5, textContent: 'comment source' },
      ]),
    );
    initial?.commit();

    const changed = model.prepareBatch(
      { ...identity, sequence: 1 },
      [mutationEvent(10, {
        texts: [
          { id: 9, value: 'changed CDATA' },
          { id: 10, value: 'changed comment' },
        ],
      })],
    );

    expect(changed).toMatchObject({ changes: [] });
    changed?.commit();
    expect(model.records().map(({ nodeId, source }) => ({ nodeId, source }))).toEqual([
      { nodeId: 4, source: 'Hola' },
    ]);
  });

  it('treats role=button content as a private control boundary', () => {
    const model = new SourceValueModel();
    const prepared = model.prepareCheckpoint(
      identity,
      checkpointEvents('Hola', undefined, [{
        id: 9,
        type: 2,
        tagName: 'div',
        attributes: { role: 'button presentation' },
        childNodes: [{ id: 10, type: 3, textContent: 'role-button-canary' }],
      }]),
    );

    expect(prepared?.records.map(({ nodeId, source }) => ({ nodeId, source }))).toEqual([
      { nodeId: 4, source: 'Hola' },
    ]);
    expect(JSON.stringify(prepared)).not.toContain('role-button-canary');
  });

  it('recomputes HTML language after document-element replacement and removal', () => {
    const model = new SourceValueModel();
    model.prepareCheckpoint(identity, checkpointEvents('Hola', 'es'))?.commit();

    const replacement = model.prepareBatch(
      { ...identity, sequence: 1 },
      [mutationEvent(10, {
        removes: [{ parentId: 1, id: 2 }],
        adds: [{
          parentId: 1,
          previousId: null,
          nextId: null,
          node: {
            id: 20,
            type: 2,
            tagName: 'html',
            attributes: { lang: 'ja' },
            childNodes: [{
              id: 21,
              type: 2,
              tagName: 'body',
              attributes: {},
              childNodes: [{ id: 22, type: 3, textContent: 'こんにちは' }],
            }],
          },
        }],
      })],
    );

    expect(replacement).toMatchObject({
      documentLanguage: 'ja',
      documentLanguageChanged: true,
    });
    replacement?.commit();
    expect(model.documentLanguage).toBe('ja');

    const removal = model.prepareBatch(
      { ...identity, sequence: 2 },
      [mutationEvent(20, { removes: [{ parentId: 1, id: 20 }] })],
    );
    expect(removal?.documentLanguage).toBeUndefined();
    expect(removal?.documentLanguageChanged).toBe(true);
    removal?.commit();
    expect(model.documentLanguage).toBeUndefined();
  });

  it('fails closed at the tombstone bound while retaining reused-ID revisions', () => {
    const model = new SourceValueModel({ maxRevisionEntries: 2 });
    const checkpoint = model.prepareCheckpoint(identity, checkpointEvents());
    checkpoint?.commit();
    const stale = model.get(4);

    const removeOriginal = model.prepareBatch(
      { ...identity, sequence: 1 },
      [mutationEvent(10, { removes: [{ parentId: 3, id: 4 }] })],
    );
    removeOriginal?.commit();
    const reuseOriginal = model.prepareBatch(
      { ...identity, sequence: 2 },
      [mutationEvent(20, {
        adds: [{
          parentId: 3,
          previousId: null,
          nextId: null,
          node: { id: 4, type: 3, textContent: 'reused' },
        }],
      })],
    );
    reuseOriginal?.commit();
    expect(model.get(4)).toMatchObject({ revision: 3, source: 'reused' });
    expect(stale && model.isCurrent(stale)).toBe(false);

    model.prepareBatch(
      { ...identity, sequence: 3 },
      [mutationEvent(30, { removes: [{ parentId: 3, id: 4 }] })],
    )?.commit();
    model.prepareBatch(
      { ...identity, sequence: 4 },
      [mutationEvent(40, {
        adds: [{
          parentId: 3,
          previousId: null,
          nextId: null,
          node: { id: 9, type: 3, textContent: 'second identity' },
        }],
      })],
    )?.commit();
    model.prepareBatch(
      { ...identity, sequence: 5 },
      [mutationEvent(50, { removes: [{ parentId: 3, id: 9 }] })],
    )?.commit();

    const overflow = model.prepareBatch(
      { ...identity, sequence: 6 },
      [mutationEvent(60, {
        adds: [{
          parentId: 3,
          previousId: null,
          nextId: null,
          node: { id: 10, type: 3, textContent: 'overflow identity' },
        }],
      })],
    );
    expect(overflow).toBeUndefined();
    expect(model.get(10)).toBeUndefined();
  });
});

function readyModel(): SourceValueModel {
  const model = new SourceValueModel();
  const prepared = model.prepareCheckpoint(identity, checkpointEvents());
  if (!prepared) throw new Error('fixture checkpoint rejected');
  prepared.commit();
  return model;
}

function checkpointEvents(
  source = 'Hola',
  language?: string,
  extraBodyChildren: readonly unknown[] = [],
): unknown[] {
  return [
    { type: 4, data: { href: 'about:blank', width: 800, height: 600 }, timestamp: 1 },
    {
      type: 2,
      data: {
        node: {
          id: 1,
          type: 0,
          childNodes: [
            {
              id: 2,
              type: 2,
              tagName: 'html',
              attributes: language ? { lang: language } : {},
              childNodes: [
                {
                  id: 3,
                  type: 2,
                  tagName: 'body',
                  attributes: {},
                  childNodes: [
                    { id: 4, type: 3, textContent: source },
                    {
                      id: 5,
                      type: 2,
                      tagName: 'input',
                      attributes: {},
                      childNodes: [
                        { id: 6, type: 3, textContent: 'private-canary' },
                      ],
                    },
                    {
                      id: 7,
                      type: 2,
                      tagName: 'style',
                      attributes: {},
                      childNodes: [
                        { id: 8, type: 3, textContent: 'body { color: red }' },
                      ],
                    },
                    ...extraBodyChildren,
                  ],
                },
              ],
            },
          ],
        },
        initialOffset: { left: 0, top: 0 },
      },
      timestamp: 2,
    },
  ];
}

function mutationEvent(
  timestamp: number,
  patch: {
    texts?: unknown[];
    attributes?: unknown[];
    removes?: unknown[];
    adds?: unknown[];
  },
): unknown {
  return {
    type: 3,
    timestamp,
    data: {
      source: 0,
      texts: patch.texts ?? [],
      attributes: patch.attributes ?? [],
      removes: patch.removes ?? [],
      adds: patch.adds ?? [],
    },
  };
}
