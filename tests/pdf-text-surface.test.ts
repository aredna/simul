import { describe, expect, it, vi } from 'vitest';

import { PdfTextSurface, type PdfSurfaceBlock } from '../lib/pdf/pdf-text-surface';
import type { PdfTextBlock } from '../lib/pdf/text-blocks';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import type { ReplicaTextProjection } from '../lib/translation/replica-translation-coordinator';

const DOCUMENT: ReplicaSourceDocumentIdentity = {
  sessionId: 'session',
  pageEpoch: 3,
  generation: 3,
  documentId: 'DOC',
  frameId: 0,
};

function block(text: string): PdfTextBlock {
  const box = { left: 10, top: 10, width: 100, height: 12 };
  return {
    text,
    lines: [box],
    box,
    fontSize: 10,
    lineHeight: 1.2,
    fontFamily: 'serif',
    fontId: 'f1',
    align: 'left',
  };
}

function setup() {
  const pages = new Map<number, readonly PdfSurfaceBlock[]>();
  const shown: Array<[number, string, string | undefined]> = [];
  const sink = {
    setPageText: vi.fn((index: number, blocks: readonly PdfSurfaceBlock[]) => {
      pages.set(index, blocks);
    }),
    showTranslation: vi.fn((id: number, text: string, language: string | undefined) => {
      shown.push([id, text, language]);
    }),
    hideTranslations: vi.fn(),
  };
  const surface = new PdfTextSurface(sink);
  return { surface, sink, pages, shown };
}

function projection(
  surface: PdfTextSurface,
  nodeId: number,
  source: string,
  overrides: Partial<ReplicaTextProjection> = {},
): ReplicaTextProjection {
  return {
    document: DOCUMENT,
    replayLease: surface.replayLease,
    nodeId,
    nodeType: 3,
    sourceRevision: 1,
    source,
    translationEpoch: 4,
    pairKey: 'fr>en',
    translated: `EN ${source}`,
    ...overrides,
  } as ReplicaTextProjection;
}

describe('PdfTextSurface', () => {
  it('publishes nothing until a PDF is mounted', () => {
    const { surface, sink } = setup();
    surface.addPage({ index: 0, blocks: [block('Bonjour')] });
    expect(surface.snapshot()).toBeUndefined();
    expect(sink.setPageText).not.toHaveBeenCalled();
  });

  it('publishes nothing until every page is read, so a half-read PDF never shows', () => {
    const { surface } = setup();
    surface.mount(DOCUMENT, 2);
    surface.addPage({ index: 0, blocks: [block('Un')] });
    expect(surface.snapshot()).toBeUndefined();
    expect(surface.document).toEqual(DOCUMENT);

    surface.markTextComplete();
    expect(surface.snapshot()?.records.map((record) => record.source)).toEqual(['Un']);
    // A new document starts incomplete again.
    surface.mount({ ...DOCUMENT, generation: 4, pageEpoch: 4 }, 1);
    expect(surface.snapshot()).toBeUndefined();
    surface.clear();
    surface.markTextComplete();
    expect(surface.snapshot()).toBeUndefined();
  });

  it('turns page blocks into text records in page order, with the /Lang', () => {
    const { surface, pages } = setup();
    surface.mount(DOCUMENT, 3);
    surface.addPage({ index: 1, blocks: [block('Deux'), block('  ')], language: 'fr-FR' });
    surface.addPage({ index: 0, blocks: [block('Un')], language: 'de' });
    surface.markTextComplete();

    const snapshot = surface.snapshot()!;
    expect(snapshot.document).toEqual(DOCUMENT);
    expect(snapshot.replayLease).toBe(1);
    expect(snapshot.documentLanguage).toBe('fr-FR');
    expect(snapshot.records.map((record) => record.source)).toEqual(['Un', 'Deux']);
    expect(snapshot.records.every((record) => record.nodeType === 3 && record.revision === 1))
      .toBe(true);
    // The view gets every block as soon as the page is read.
    expect(pages.get(1)?.map((each) => each.text)).toEqual(['Deux', '  ']);
    expect(surface.hasText).toBe(true);
    expect(surface.hasPage(0)).toBe(true);
    expect(surface.hasPage(2)).toBe(false);
  });

  it('ignores a page read twice or outside the document', () => {
    const { surface, sink } = setup();
    surface.mount(DOCUMENT, 1);
    surface.addPage({ index: 0, blocks: [block('Un')] });
    surface.addPage({ index: 0, blocks: [block('Autre')] });
    surface.addPage({ index: 5, blocks: [block('Loin')] });
    surface.markTextComplete();

    expect(surface.snapshot()!.records.map((record) => record.source)).toEqual(['Un']);
    expect(sink.setPageText).toHaveBeenCalledOnce();
  });

  it('keeps a page whose view failed to take it', () => {
    const { surface, sink } = setup();
    sink.setPageText.mockImplementationOnce(() => {
      throw new Error('Layout failed');
    });
    surface.mount(DOCUMENT, 1);

    expect(() => surface.addPage({ index: 0, blocks: [block('Un')] })).toThrow('Layout failed');
    surface.markTextComplete();
    expect(surface.snapshot()!.records.map((record) => record.source)).toEqual(['Un']);
  });

  it('shows only current, non-empty translations, with the target language', () => {
    const { surface, shown } = setup();
    surface.mount(DOCUMENT, 1);
    surface.addPage({ index: 0, blocks: [block('Bonjour')] });
    surface.markTextComplete();
    const id = surface.snapshot()!.records[0]!.nodeId;
    surface.beginProjection({ translationEpoch: 4, pairKey: 'fr>en' });

    expect(surface.project(projection(surface, id, 'Bonjour'))).toBe(true);
    expect(shown).toEqual([[id, 'EN Bonjour', 'en']]);

    for (const refused of [
      { translationEpoch: 3 },
      { pairKey: 'fr>de' },
      { replayLease: surface.replayLease + 1 },
      { source: 'Salut' },
      { sourceRevision: 2 },
      { nodeId: id + 100 },
      { document: { ...DOCUMENT, documentId: 'OTHER' } },
      { translated: '' },
      { translated: '  \n' },
    ] as Partial<ReplicaTextProjection>[]) {
      expect(surface.project(projection(surface, id, 'Bonjour', refused))).toBe(false);
    }
    expect(shown).toHaveLength(1);
  });

  it('hides every translation when a new projection begins', () => {
    const { surface, sink } = setup();
    surface.mount(DOCUMENT, 1);
    surface.addPage({ index: 0, blocks: [block('Bonjour')] });
    surface.markTextComplete();
    const id = surface.snapshot()!.records[0]!.nodeId;
    surface.beginProjection({ translationEpoch: 4, pairKey: 'fr>en' });
    surface.beginProjection({ translationEpoch: 5, pairKey: undefined });

    expect(sink.hideTranslations).toHaveBeenCalledTimes(2);
    expect(surface.project(projection(surface, id, 'Bonjour', { translationEpoch: 5 })))
      .toBe(false);
  });

  it('orders translation from the reading page on, then the pages before it, nearest first', () => {
    const { surface } = setup();
    surface.mount(DOCUMENT, 5);
    for (const index of [0, 1, 2, 3, 4]) {
      surface.addPage({ index, blocks: [block(`P${index}`)] });
    }
    surface.markTextComplete();
    const idOf = new Map(surface.snapshot()!.records.map((record) => [record.source, record.nodeId]));

    surface.readingPage = 2;
    expect([...surface.translationOrder()]).toEqual(
      ['P2', 'P3', 'P4', 'P1', 'P0'].map((source) => idOf.get(source)),
    );
    surface.readingPage = 99;
    expect([...surface.translationOrder()][0]).toBe(idOf.get('P4'));
  });

  it('starts a new lease per mount and forgets everything on clear', () => {
    const { surface } = setup();
    surface.mount(DOCUMENT, 1);
    surface.addPage({ index: 0, blocks: [block('Un')] });
    surface.markTextComplete();
    const first = surface.snapshot()!;
    surface.readingPage = 0;
    surface.mount({ ...DOCUMENT, generation: 4, pageEpoch: 4 }, 1);
    surface.markTextComplete();

    expect(surface.snapshot()!.replayLease).toBe(first.replayLease + 1);
    expect(surface.snapshot()!.records).toEqual([]);
    expect(surface.resolveImageAnchor()).toBeUndefined();

    surface.clear();
    expect(surface.snapshot()).toBeUndefined();
    expect(surface.hasText).toBe(false);
  });
});
