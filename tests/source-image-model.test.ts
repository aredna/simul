import { describe, expect, it } from 'vitest';

import { SourceImageModel } from '../lib/ocr/source-image-model';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const documentIdentity: ReplicaSourceDocumentIdentity = {
  sessionId: 'session-a',
  pageEpoch: 2,
  generation: 2,
  documentId: 'document-a',
  frameId: 0,
};

describe('SourceImageModel', () => {
  it('separates content and observation revisions and emits disclosure-safe facts', () => {
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);

    const first = model.upsert(upsert(7, {
      contentChanged: true,
      visibility: 'background',
    }));
    expect(first).toMatchObject({
      status: 'changed',
      change: {
        kind: 'upsert',
        descriptor: {
          nodeId: 7,
          sourceKind: 'img',
          contentRevision: 1,
          observationRevision: 1,
          visibility: 'background',
          connected: true,
        },
      },
    });
    const firstDescriptor = model.get(7)!;
    expect(Object.keys(firstDescriptor).sort()).toEqual([
      'connected',
      'contentRevision',
      'document',
      'intrinsicHeight',
      'intrinsicWidth',
      'nodeId',
      'observationRevision',
      'renderedHeight',
      'renderedWidth',
      'sourceKind',
      'visibility',
    ]);
    expect(JSON.stringify(firstDescriptor)).not.toMatch(
      /(?:url|src|text|pixel|hash|control)/iu,
    );

    expect(model.upsert(upsert(7, {
      contentChanged: false,
      visibility: 'visible',
    }))).toMatchObject({
      change: {
        descriptor: { contentRevision: 1, observationRevision: 2 },
      },
    });
    expect(model.isCurrent(firstDescriptor)).toBe(false);

    expect(model.upsert(upsert(7, {
      contentChanged: false,
      observationChanged: true,
      visibility: 'visible',
    }))).toMatchObject({
      change: {
        descriptor: { contentRevision: 1, observationRevision: 3 },
      },
    });

    expect(model.upsert(upsert(7, {
      contentChanged: true,
      visibility: 'visible',
    }))).toMatchObject({
      change: {
        descriptor: { contentRevision: 2, observationRevision: 4 },
      },
    });
  });

  it('preserves tombstone watermarks when a node ID is removed and reused', () => {
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    model.upsert(upsert(4));

    expect(model.remove(documentIdentity, 4)).toMatchObject({
      status: 'changed',
      change: {
        kind: 'remove',
        contentRevision: 2,
        observationRevision: 2,
      },
    });
    expect(model.get(4)).toBeUndefined();
    expect(model.remove(documentIdentity, 4)).toEqual({ status: 'unchanged' });

    expect(model.upsert(upsert(4, { contentChanged: false }))).toMatchObject({
      change: {
        descriptor: { contentRevision: 3, observationRevision: 3 },
      },
    });
  });

  it('rejects wrong-document and malformed observations and fails closed at capacity', () => {
    const model = new SourceImageModel({ maxEntries: 1 });
    model.beginDocument(documentIdentity);
    expect(model.upsert(upsert(1))).toMatchObject({ status: 'changed' });
    expect(model.upsert(upsert(2))).toEqual({ status: 'overflow' });
    expect(model.upsert({
      ...upsert(1),
      document: { ...documentIdentity, documentId: 'wrong' },
    })).toEqual({ status: 'rejected' });
    expect(model.upsert({
      ...upsert(1),
      renderedWidth: Number.NaN,
    })).toEqual({ status: 'rejected' });
    expect(model.upsert({
      ...upsert(1),
      intrinsicHeight: undefined,
    })).toEqual({ status: 'rejected' });
    expect(model.upsert({
      ...upsert(1),
      undisclosedSource: 'forbidden',
    } as never)).toEqual({ status: 'rejected' });
    expect(model.remove({
      ...documentIdentity,
      extra: true,
    } as never, 1)).toEqual({ status: 'rejected' });
  });

  it('resets all records and watermarks for a new exact document', () => {
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    model.upsert(upsert(3));
    expect(model.beginDocument({
      ...documentIdentity,
      pageEpoch: documentIdentity.pageEpoch + 1,
      generation: documentIdentity.generation + 1,
    })).toBe(true);

    expect(model.records()).toEqual([]);
    expect(model.upsert({
      ...upsert(3),
      document: { ...documentIdentity, pageEpoch: 3, generation: 3 },
    })).toMatchObject({
      change: { descriptor: { contentRevision: 1, observationRevision: 1 } },
    });
  });

  it('rejects malformed document identities without replacing current state', () => {
    const model = new SourceImageModel();
    expect(model.beginDocument(documentIdentity)).toBe(true);
    expect(model.upsert(upsert(8))).toMatchObject({ status: 'changed' });

    expect(model.beginDocument({
      ...documentIdentity,
      generation: 3,
    })).toBe(false);
    expect(model.beginDocument({
      ...documentIdentity,
      extra: 'forbidden',
    } as never)).toBe(false);
    expect(model.get(8)).toBeDefined();
  });
});

function upsert(
  nodeId: number,
  overrides: Partial<Parameters<SourceImageModel['upsert']>[0]> = {},
): Parameters<SourceImageModel['upsert']>[0] {
  return {
    document: documentIdentity,
    nodeId,
    contentChanged: true,
    observationChanged: false,
    visibility: 'near',
    connected: true,
    renderedWidth: 200,
    renderedHeight: 100,
    intrinsicWidth: 800,
    intrinsicHeight: 400,
    ...overrides,
  };
}
