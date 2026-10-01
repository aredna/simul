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

describe('PdfTextSurface scanned pages', () => {
  function mounted() {
    const harness = setup();
    harness.surface.mount(DOCUMENT, 4);
    harness.surface.addPage({ index: 0, blocks: [block('Texte')] });
    harness.surface.addPage({ index: 1, blocks: [], scanned: true });
    harness.surface.addPage({ index: 2, blocks: [], scanned: true });
    harness.surface.addPage({ index: 3, blocks: [], scanned: true });
    harness.surface.markTextComplete();
    return harness;
  }

  it('counts pages without text as scanned pages still to read', () => {
    const { surface } = mounted();
    expect(surface.scannedPages()).toEqual([1, 2, 3]);
    expect(surface.unreadScannedPages()).toEqual([1, 2, 3]);
    expect(surface.snapshot()?.records.map((record) => record.source)).toEqual(['Texte']);
  });

  it('does not count a page without blocks that pdf.js did not find empty', () => {
    const { surface } = setup();
    surface.mount(DOCUMENT, 3);
    // Timed out or failed, and only rotated text: no blocks, not scanned.
    surface.addPage({ index: 0, blocks: [] });
    surface.addPage({ index: 1, blocks: [], scanned: false });
    surface.addPage({ index: 2, blocks: [], scanned: true });
    expect(surface.scannedPages()).toEqual([2]);
  });

  it('adds a scanned page\'s text with new ids, in reading order, and marks it read', () => {
    const { surface, pages } = mounted();
    const before = surface.snapshot();
    surface.setScannedPage(2, [block('Numérisé')], 'fra');
    surface.setScannedPage(1, [], 'fra');
    const after = surface.snapshot();
    expect(after).not.toBe(before);
    expect(after?.replayLease).toBe(before?.replayLease);
    expect(after?.records.map((record) => record.source)).toEqual(['Texte', 'Numérisé']);
    expect(pages.get(2)?.map((each) => each.text)).toEqual(['Numérisé']);
    expect(surface.unreadScannedPages()).toEqual([3]);
    surface.readingPage = 2;
    const ids = [...surface.translationOrder()];
    expect(ids[0]).toBe(pages.get(2)![0]!.id);
    // A page with text from pdf.js is not a scanned page.
    surface.setScannedPage(0, [block('Autre')], 'fra');
    expect(surface.snapshot()?.records.map((record) => record.source)).toEqual(['Texte', 'Numérisé']);
  });

  describe('with a little typed text over the scan', () => {
    const at = (text: string, top: number): PdfTextBlock => {
      const box = { left: 10, top, width: 100, height: 12 };
      return { ...block(text), lines: [box], box };
    };

    function stamped() {
      const harness = setup();
      harness.surface.mount(DOCUMENT, 2);
      harness.surface.addPage({
        index: 0,
        blocks: [at('Case 17', 20), at('Page 1 of 2', 760)],
        littleText: true,
      });
      harness.surface.addPage({ index: 1, blocks: [at('Page 2 of 2', 760)], littleText: true });
      harness.surface.markTextComplete();
      return harness;
    }

    it('counts the page as a scanned page still to read, and keeps its text', () => {
      const { surface, pages } = stamped();
      expect(surface.scannedPages()).toEqual([0, 1]);
      expect(surface.unreadScannedPages()).toEqual([0, 1]);
      // Only its pictures tell whether it is a scan.
      expect(surface.isUnconfirmedScan(0)).toBe(true);
      surface.confirmScannedPage(0);
      expect(surface.isUnconfirmedScan(0)).toBe(false);
      expect(surface.unreadScannedPages()).toEqual([0, 1]);
      expect(surface.typedText(0).map((each) => each.text)).toEqual(['Case 17', 'Page 1 of 2']);
      expect(pages.get(0)?.map((each) => each.text)).toEqual(['Case 17', 'Page 1 of 2']);
      expect(surface.snapshot()?.records.map((record) => record.source))
        .toEqual(['Case 17', 'Page 1 of 2', 'Page 2 of 2']);
      // A text page has no typed text to keep apart.
      const text = setup();
      text.surface.mount(DOCUMENT, 1);
      text.surface.addPage({ index: 0, blocks: [block('Texte')] });
      expect(text.surface.typedText(0)).toEqual([]);
      expect(text.surface.scannedPages()).toEqual([]);
      expect(text.surface.isUnconfirmedScan(0)).toBe(false);
    });

    it('makes a page that is not a scan a text page, as it stands', async () => {
      const { surface, pages, sink } = stamped();
      const before = pages.get(1);
      const waiting = surface.waitForText(new AbortController().signal);
      surface.dismissScannedPage(1);
      await expect(waiting).resolves.toBeUndefined();
      expect(surface.unreadScannedPages()).toEqual([0]);
      expect(surface.scannedPages()).toEqual([0]);
      expect(surface.typedText(1)).toEqual([]);
      // Its text stays where it is: nothing was given to the view again.
      expect(pages.get(1)).toBe(before);
      expect(sink.setPageText).toHaveBeenCalledTimes(2);
      expect(surface.snapshot()?.records.map((record) => record.source))
        .toEqual(['Case 17', 'Page 1 of 2', 'Page 2 of 2']);
      // OCR text does not reach a text page.
      surface.setScannedPage(1, [at('Stray', 100)], 'fra');
      expect(pages.get(1)).toBe(before);
      // A confirmed scan, and a page pdf.js found empty, are not dismissed.
      surface.confirmScannedPage(0);
      surface.dismissScannedPage(0);
      expect(surface.unreadScannedPages()).toEqual([0]);
      const scans = mounted();
      scans.surface.dismissScannedPage(1);
      expect(scans.surface.unreadScannedPages()).toEqual([1, 2, 3]);
      expect(scans.surface.isUnconfirmedScan(1)).toBe(false);
    });

    it('adds the scan\'s text between the typed blocks, which keep their ids', () => {
      const { surface, pages } = stamped();
      const typed = pages.get(0)!.map((each) => each.id);
      surface.setScannedPage(0, [at('Le port', 100), at('La ville', 300)], 'fra');
      expect(pages.get(0)?.map((each) => each.text))
        .toEqual(['Case 17', 'Le port', 'La ville', 'Page 1 of 2']);
      expect([pages.get(0)![0]!.id, pages.get(0)![3]!.id]).toEqual(typed);
      expect(surface.unreadScannedPages()).toEqual([1]);
      expect(surface.snapshot()?.records.map((record) => record.source))
        .toEqual(['Case 17', 'Le port', 'La ville', 'Page 1 of 2', 'Page 2 of 2']);
      // The typed blocks still take their translations.
      surface.beginProjection({ translationEpoch: 4, pairKey: 'fr>en' });
      expect(surface.project(projection(surface, typed[0]!, 'Case 17'))).toBe(true);

      // Read again: the earlier reading goes, the typed text stays.
      surface.setScannedPage(0, [at('Le port et la ville', 100)], 'fra');
      expect(pages.get(0)?.map((each) => each.text))
        .toEqual(['Case 17', 'Le port et la ville', 'Page 1 of 2']);
      expect(surface.snapshot()?.records).toHaveLength(4);
      // A reading that finds nothing leaves the typed text.
      surface.setScannedPage(1, [], 'fra');
      expect(pages.get(1)?.map((each) => each.text)).toEqual(['Page 2 of 2']);
      expect(surface.unreadScannedPages()).toEqual([]);
    });

    it('keeps the scan\'s own order, with typed blocks that land together in theirs', () => {
      const { surface, pages } = stamped();
      // Two columns: OCR reads the left one down, then the right one.
      surface.setScannedPage(
        0,
        [at('Left top', 100), at('Left bottom', 500), at('Right top', 100), at('Right bottom', 500)],
        'fra',
      );
      expect(pages.get(0)?.map((each) => each.text)).toEqual([
        'Case 17', 'Left top', 'Left bottom', 'Right top', 'Right bottom', 'Page 1 of 2',
      ]);
      // Nothing below either typed block: both go last, header first.
      surface.setScannedPage(0, [at('Above everything', 5)], 'fra');
      expect(pages.get(0)?.map((each) => each.text))
        .toEqual(['Above everything', 'Case 17', 'Page 1 of 2']);
    });

    it('forgets only the scan\'s text when another OCR model group reads', () => {
      const { surface, pages } = stamped();
      const typed = pages.get(0)!.map((each) => each.id);
      surface.setScannedPage(0, [at('Read in English', 100)], 'eng');
      surface.forgetScannedPages('fra');
      expect(surface.unreadScannedPages()).toEqual([0, 1]);
      expect(pages.get(0)?.map((each) => each.text)).toEqual(['Case 17', 'Page 1 of 2']);
      expect(pages.get(0)?.map((each) => each.id)).toEqual(typed);
      expect(surface.typedText(0)).toHaveLength(2);
      expect(surface.snapshot()?.records.map((record) => record.source))
        .toEqual(['Case 17', 'Page 1 of 2', 'Page 2 of 2']);
    });

    it('says when the only text is on scanned pages', () => {
      const { surface } = stamped();
      expect(surface.textOnScannedPagesOnly).toBe(true);
      surface.setScannedPage(0, [at('Le port', 100)], 'fra');
      expect(surface.textOnScannedPagesOnly).toBe(true);

      // A text page beside them: its text names the language.
      const mixed = mounted();
      expect(mixed.surface.textOnScannedPagesOnly).toBe(false);
      // A page that turned out to be a text page names the language again.
      surface.dismissScannedPage(1);
      expect(surface.textOnScannedPagesOnly).toBe(false);
      // No text at all yet: nothing to weigh.
      const scans = setup();
      scans.surface.mount(DOCUMENT, 1);
      scans.surface.addPage({ index: 0, blocks: [], scanned: true });
      expect(scans.surface.textOnScannedPagesOnly).toBe(false);
      scans.surface.setScannedPage(0, [block('Numérisé')], 'fra');
      expect(scans.surface.textOnScannedPagesOnly).toBe(true);
      expect(setup().surface.textOnScannedPagesOnly).toBe(false);
    });

    it('forgets the typed text with the document', () => {
      const { surface } = stamped();
      surface.mount(DOCUMENT, 2);
      expect(surface.typedText(0)).toEqual([]);
      expect(surface.scannedPages()).toEqual([]);
      expect(surface.isUnconfirmedScan(0)).toBe(false);
    });

    it('takes a page pdf.js found empty for a scan whatever else is said', () => {
      const { surface } = setup();
      surface.mount(DOCUMENT, 2);
      surface.addPage({ index: 0, blocks: [], scanned: true, littleText: true });
      // Only rotated text: no blocks, perhaps a scan.
      surface.addPage({ index: 1, blocks: [], littleText: true });
      expect(surface.unreadScannedPages()).toEqual([0, 1]);
      expect(surface.isUnconfirmedScan(0)).toBe(false);
      expect(surface.isUnconfirmedScan(1)).toBe(true);
      expect(surface.typedText(1)).toEqual([]);
    });

    it('confirms a page that is read, and keeps the text of any scanned page', () => {
      const { surface, pages } = stamped();
      surface.setScannedPage(0, [at('Le port', 100)], 'fra');
      expect(surface.isUnconfirmedScan(0)).toBe(false);
      // Read: no longer to be made a text page.
      surface.dismissScannedPage(0);
      expect(surface.scannedPages()).toEqual([0, 1]);

      // A page given as scanned with text of its own keeps that text too.
      const other = setup();
      other.surface.mount(DOCUMENT, 1);
      other.surface.addPage({ index: 0, blocks: [at('Tampon', 20)], scanned: true });
      other.surface.setScannedPage(0, [at('Numérisé', 100)], 'fra');
      expect(other.pages.get(0)?.map((each) => each.text)).toEqual(['Tampon', 'Numérisé']);
      expect(pages.get(0)?.map((each) => each.text)).toEqual(['Case 17', 'Le port', 'Page 1 of 2']);
    });
  });

  it('reads pages again in another OCR model group, and not in the same one', () => {
    const { surface, pages } = mounted();
    surface.setScannedPage(1, [block('Lu en anglais')], 'eng');
    surface.setScannedPage(2, [block('Lu en français')], 'fra');
    expect(surface.unreadScannedPages('fra')).toEqual([1, 3]);
    surface.forgetScannedPages('fra');
    expect(surface.unreadScannedPages()).toEqual([1, 3]);
    expect(pages.get(1)).toEqual([]);
    expect(surface.snapshot()?.records.map((record) => record.source)).toEqual([
      'Texte',
      'Lu en français',
    ]);
  });

  it('uses a language hint only when the PDF names no language it knows', () => {
    const { surface } = mounted();
    surface.languageHint = 'ja';
    expect(surface.snapshot()?.documentLanguage).toBe('ja');
    expect(surface.snapshot()?.documentLanguageSource).toBe('scanned-pages');
    const unknown = setup().surface;
    unknown.mount(DOCUMENT, 1);
    unknown.addPage({ index: 0, blocks: [], language: 'x-private', scanned: true });
    unknown.markTextComplete();
    expect(unknown.snapshot()?.documentLanguage).toBe('x-private');
    unknown.languageHint = 'ru';
    expect(unknown.snapshot()).toMatchObject({
      documentLanguage: 'ru',
      documentLanguageSource: 'scanned-pages',
    });
    const named = setup().surface;
    named.mount(DOCUMENT, 1);
    named.addPage({ index: 0, blocks: [], language: 'fr-FR', scanned: true });
    named.markTextComplete();
    named.languageHint = 'ja';
    expect(named.snapshot()?.documentLanguage).toBe('fr-FR');
    expect(named.snapshot()?.documentLanguageSource).toBeUndefined();
  });

  it('wakes a waiting run on each page read and when reading ends', async () => {
    const { surface } = mounted();
    const token = surface.beginReading();
    expect(surface.isReading()).toBe(true);
    const signal = new AbortController().signal;
    const first = surface.waitForText(signal);
    surface.setScannedPage(1, [block('Page deux')], 'fra');
    await first;
    const second = surface.waitForText(signal);
    surface.endReading({});
    expect(surface.isReading()).toBe(true);
    surface.endReading(token);
    await second;
    expect(surface.isReading()).toBe(false);
  });

  it('stops a waiting run on abort, clear and a new mount', async () => {
    const { surface } = mounted();
    surface.beginReading();
    const controller = new AbortController();
    const aborted = surface.waitForText(controller.signal);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    const cleared = surface.waitForText(new AbortController().signal);
    surface.clear();
    await cleared;
    expect(surface.isReading()).toBe(false);
    expect(surface.unreadScannedPages()).toEqual([]);
  });
});
