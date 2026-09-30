import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  openPdfDocument,
  type PdfDocumentHandle,
  type PdfTextContent,
  type PdfTextItem,
  type PdfjsEnvironment,
} from '../lib/pdf/pdfjs-runtime';
import { joinLines, pdfTextBlocks } from '../lib/pdf/text-blocks';

const vendorDirectory = resolve('vendor/pdfjs');
const nodeEnvironment: PdfjsEnvironment = {
  moduleBase: `${pathToFileURL(vendorDirectory).href}/`,
  dataBase: `${vendorDirectory}/`,
  workerFetch: false,
};
const opened: PdfDocumentHandle[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((document) => document.destroy()));
});

async function blocksOf(name: string, page = 1) {
  const bytes = new Uint8Array(await readFile(resolve('tests/fixtures/pdf', name)));
  const document = await openPdfDocument(bytes, nodeEnvironment);
  opened.push(document);
  const size = await document.getPageSize(page);
  return { blocks: pdfTextBlocks(await document.getTextContent(page), size.transform), size };
}

// A page 600 points tall, PDF y upwards: the viewport transform flips it.
const PAGE_TRANSFORM = [1, 0, 0, -1, 0, 600];

function item(
  str: string,
  x: number,
  y: number,
  options: {
    size?: number;
    width?: number;
    eol?: boolean;
    font?: string;
    transform?: number[];
    dir?: string;
  } = {},
): PdfTextItem {
  const size = options.size ?? 10;
  return {
    str,
    dir: options.dir ?? 'ltr',
    transform: options.transform ?? [size, 0, 0, size, x, y],
    width: options.width ?? str.length * size * 0.5,
    height: size,
    fontName: options.font ?? 'f1',
    hasEOL: options.eol ?? false,
  };
}

function content(items: PdfTextItem[], styles: PdfTextContent['styles'] = {}): PdfTextContent {
  return {
    items,
    styles: {
      f1: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: false },
      f2: { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false },
      ...styles,
    },
    lang: null,
  };
}

describe('pdfTextBlocks on real PDFs', () => {
  it('keeps two columns as separate paragraphs, in content order', async () => {
    const { blocks } = await blocksOf('text-two-col.pdf');

    expect(blocks[0]?.text).toBe('Quarterly Harbor Report');
    expect(blocks).toHaveLength(15);
    expect(blocks[1]?.text).toBe(
      'Paragraph 1. The harbor received many ships this quarter, and the weather ' +
        'stayed calm for most of the season. Dock workers unloaded grain, timber, ' +
        'and machinery while the port authority planned a new pier.',
    );
    // Paragraph 8 opens the second column.
    expect(blocks[8]?.text.startsWith('Paragraph 8.')).toBe(true);
    expect(blocks[8]!.box.left).toBeGreaterThan(300);
    expect(blocks[7]!.box.left).toBeLessThan(40);
    expect(blocks[1]?.lines).toHaveLength(5);
    expect(blocks[1]?.fontFamily).toBe('serif');
  });

  it('measures boxes in page points from the top of the page', async () => {
    const { blocks, size } = await blocksOf('text-two-col.pdf');
    const title = blocks[0]!;

    expect(title.fontSize).toBeCloseTo(21, 0);
    expect(title.box.left).toBeCloseTo(30, 0);
    // Baseline at 49.5 points from the top; the ascent reaches above it.
    expect(title.box.top).toBeLessThan(49.5 - 15);
    expect(title.box.top + title.box.height).toBeGreaterThan(49.5);
    expect(title.box.width).toBeCloseTo(291.7, 0);
    expect(title.lineHeight).toBeCloseTo(1.2);
    for (const block of blocks) {
      expect(block.box.left + block.box.width).toBeLessThanOrEqual(size.width);
      expect(block.box.top + block.box.height).toBeLessThanOrEqual(size.height);
    }
    expect(blocks[1]!.lineHeight).toBeCloseTo(1.5, 1);
  });

  it('rejoins a hyphenated word and keeps a same-line run on its line', async () => {
    const { blocks } = await blocksOf('text.pdf');
    const texts = blocks.map((block) => block.text);

    expect(texts).toContain(
      'The survey team visited eleven sites along the northern ridge and recorded ' +
        'soil samples, water levels and vegetation cover. Preliminary results ' +
        'suggest a steady recovery since the last season.',
    );
    expect(texts).toContain(
      'Two sites showed unusual erosion near the creek bed. We recommend a ' +
        'follow-up visit in spring to confirm the pattern.',
    );
    expect(texts.at(-1)).toBe('Page 1 of 1 - Simul pdf.js fixture');
    expect(blocks[0]?.fontFamily).toBe('sans-serif');
  });

  it('finds no text on a scanned page', async () => {
    const { blocks } = await blocksOf('scanned.pdf');
    expect(blocks).toEqual([]);
  });

  it('reads CJK and symbol text from embedded CMaps and standard fonts', async () => {
    const { blocks } = await blocksOf('resources.pdf');
    expect(blocks.map((block) => block.text)).toEqual(['日本語', 'αβγ', '34']);
    expect(blocks[0]?.fontFamily).toBe('monospace');
  });
});

describe('pdfTextBlocks rules', () => {
  it('starts a block at a list marker', () => {
    const blocks = pdfTextBlocks(content([
      item('Things to bring:', 50, 500, { eol: true }),
      item('• a coat', 50, 486, { eol: true }),
      item('• a hat that is', 50, 472, { eol: true }),
      item('warm', 60, 458, { eol: true }),
      item('2. Second step', 50, 444, { eol: true }),
      item('a) sub step', 50, 430),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual([
      'Things to bring:',
      '• a coat',
      '• a hat that is warm',
      '2. Second step',
      'a) sub step',
    ]);
  });

  it('separates text of another size, a far line and a gutter', () => {
    const blocks = pdfTextBlocks(content([
      item('Heading', 50, 500, { size: 20, eol: true }),
      item('Body line one', 50, 470, { eol: true }),
      item('Body line two', 50, 456, { eol: true }),
      item('After a gap', 50, 400, { eol: true }),
      item('Left cell', 50, 380, { width: 40 }),
      item('Right cell', 200, 380, { width: 40 }),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual([
      'Heading',
      'Body line one Body line two',
      'After a gap',
      'Left cell',
      'Right cell',
    ]);
    // Page y flipped: the heading's baseline sits 100 points from the top.
    expect(blocks[0]!.box.top).toBeCloseTo(100 - 16);
    expect(blocks[0]!.box.height).toBeCloseTo(20);
  });

  it('keeps a superscript on its line', () => {
    const blocks = pdfTextBlocks(content([
      item('Water rises', 50, 500, { width: 55 }),
      item('2', 106, 503.5, { size: 6, width: 3 }),
      item(' each year', 110, 500, { eol: true }),
      item('along the coast.', 50, 486),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual([
      'Water rises2 each year along the coast.',
    ]);
    expect(blocks[0]!.fontSize).toBe(10);
  });

  it('joins lines of scripts written without spaces, and keeps real hyphens', () => {
    expect(joinLines('日本語の文', '章です')).toBe('日本語の文章です');
    // A Han character outside the basic plane is still Han.
    expect(joinLines('𠀋', '字')).toBe('𠀋字');
    expect(joinLines('ภาษา', 'ไทย')).toBe('ภาษาไทย');
    expect(joinLines('ພາສາ', 'ລາວ')).toBe('ພາສາລາວ');
    expect(joinLines('ភាសា', 'ខ្មែរ')).toBe('ភាសាខ្មែរ');
    expect(joinLines('မြန်မာ', 'စာ')).toBe('မြန်မာစာ');
    // Korean separates words with spaces.
    expect(joinLines('한국어', '문장')).toBe('한국어 문장');
    expect(joinLines('Anglo-', 'Saxon')).toBe('Anglo-Saxon');
    expect(joinLines('recom-', 'mended')).toBe('recommended');
    expect(joinLines('end.', 'Next')).toBe('end. Next');
  });

  it('leaves rotated and vertical text as drawn', () => {
    const blocks = pdfTextBlocks(content([
      item('Upright', 50, 500, { eol: true }),
      item('Sideways', 20, 300, { transform: [0, 10, -10, 0, 20, 300] }),
      item('縦書き', 300, 500, { font: 'v' }),
    ], {
      v: { fontFamily: 'serif', ascent: 0.8, descent: -0.2, vertical: true },
    }), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual(['Upright']);
  });

  it('adds a space where runs on one line leave a visible gap', () => {
    const blocks = pdfTextBlocks(content([
      item('Hello', 50, 500, { width: 25 }),
      item('world', 80, 500, { width: 25 }),
      item('!', 105, 500, { width: 3 }),
    ]), PAGE_TRANSFORM);

    expect(blocks[0]?.text).toBe('Hello world!');
    expect(blocks[0]?.lines).toHaveLength(1);
  });
});

describe('pdfTextBlocks, the review rules', () => {
  it('drops a run drawn again at almost the same place (fake bold)', () => {
    const blocks = pdfTextBlocks(content([
      item('Title', 50, 500, { width: 25 }),
      item('Title', 50.4, 500.2, { width: 25, eol: true }),
      item('Body text', 50, 470),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual(['Title', 'Body text']);
  });

  it('measures gaps leftwards in right-to-left text', () => {
    const blocks = pdfTextBlocks(content([
      item('שלום', 200, 500, { width: 20, dir: 'rtl' }),
      item('עולם', 175, 500, { width: 20, dir: 'rtl' }),
      // Far to the left: another column.
      item('טור', 50, 500, { width: 15, dir: 'rtl' }),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual(['שלום עולם', 'טור']);
  });

  it('keeps an initial or a dash wrapped mid-sentence in its paragraph', () => {
    const blocks = pdfTextBlocks(content([
      item('The survey was led by', 50, 500, { eol: true }),
      item('J. Smith, who found the results', 50, 486, { eol: true }),
      item('– as expected – encouraging.', 50, 472, { eol: true }),
      item('It rained twice.', 50, 458, { eol: true }),
      item('– A dash after a sentence starts an item.', 50, 444),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual([
      'The survey was led by J. Smith, who found the results – as expected – ' +
        'encouraging. It rained twice.',
      '– A dash after a sentence starts an item.',
    ]);
  });

  it('starts a block at a letter item inside a list, and always at a number', () => {
    const blocks = pdfTextBlocks(content([
      item('(1) First point, which wraps', 50, 500, { eol: true }),
      item('onto a second line', 50, 486, { eol: true }),
      item('a) a sub point', 50, 472, { eol: true }),
      item('ii) another', 50, 458, { eol: true }),
      item('continued text 12 apples and', 50, 444, { eol: true }),
      item('3) third', 50, 430),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual([
      '(1) First point, which wraps onto a second line',
      'a) a sub point',
      'ii) another continued text 12 apples and',
      '3) third',
    ]);
  });

  it('finds centred and right-aligned lines, as physical sides', () => {
    const centred = pdfTextBlocks(content([
      item('A centred heading', 215, 500, { width: 170, eol: true }),
      item('over two lines', 230, 486, { width: 140 }),
    ]), PAGE_TRANSFORM, 600);
    const right = pdfTextBlocks(content([
      item('Right aligned text', 380, 500, { width: 170, eol: true }),
      item('ends here', 460, 486, { width: 90 }),
    ]), PAGE_TRANSFORM, 600);
    const justified = pdfTextBlocks(content([
      item('A justified paragraph line', 50, 500, { width: 300, eol: true }),
      item('and its last line', 50, 486, { width: 120 }),
    ]), PAGE_TRANSFORM, 600);
    const hebrew = pdfTextBlocks(content([
      item('שורה ראשונה ארוכה', 250, 500, { width: 300, dir: 'rtl', eol: true }),
      item('ושורה שנייה', 430, 486, { width: 120, dir: 'rtl' }),
    ]), PAGE_TRANSFORM, 600);

    expect(centred.map((block) => block.align)).toEqual(['center']);
    expect(right.map((block) => block.align)).toEqual(['right']);
    expect(justified.map((block) => block.align)).toEqual(['left']);
    // Right-to-left text sits on the right by nature.
    expect(hebrew.map((block) => block.align)).toEqual(['right']);
  });

  it('keeps a paragraph with an indented first line left-aligned', () => {
    const indented = pdfTextBlocks(content([
      item('An indented first line that runs', 70, 500, { width: 280, eol: true }),
      item('to the same right edge as this one', 50, 486, { width: 300 }),
    ]), PAGE_TRANSFORM, 600);
    const threeLines = pdfTextBlocks(content([
      item('Right aligned first line', 150, 500, { width: 200, eol: true }),
      item('second', 290, 486, { width: 60, eol: true }),
      item('and the third one', 210, 472, { width: 140 }),
    ]), PAGE_TRANSFORM, 600);

    expect(indented[0]?.align).toBe('left');
    expect(threeLines[0]?.align).toBe('right');
  });

  it('centres a single line in the middle of the page, away from the paragraphs\' margin', () => {
    const blocks = pdfTextBlocks(content([
      item('A paragraph of two lines that', 50, 560, { width: 300, eol: true }),
      item('sets the left margin.', 50, 546, { width: 200, eol: true }),
      item('Title', 285, 500, { size: 20, width: 30, eol: true }),
      item('Off-centre', 350, 400, { width: 60, eol: true }),
      item('Full width line at the margin', 50, 300, { width: 500 }),
    ]), PAGE_TRANSFORM, 600);

    expect(blocks.map((block) => [block.text, block.align])).toEqual([
      ['A paragraph of two lines that sets the left margin.', 'left'],
      ['Title', 'center'],
      ['Off-centre', 'left'],
      ['Full width line at the margin', 'left'],
    ]);
    // Without the page width, a single line is never centred.
    expect(pdfTextBlocks(content([item('Title', 285, 500, { width: 30 })]), PAGE_TRANSFORM)[0]?.align)
      .toBe('left');
  });

  it('centres a title page line without any paragraph to set a margin', () => {
    const blocks = pdfTextBlocks(content([
      item('Annual Report', 250, 500, { size: 24, width: 100, eol: true }),
      item('2026', 285, 400, { size: 14, width: 30 }),
    ]), PAGE_TRANSFORM, 600);

    expect(blocks.map((block) => block.align)).toEqual(['center', 'center']);
  });

  it('keeps a left-to-right number inside a right-to-left sentence on its line', () => {
    const blocks = pdfTextBlocks(content([
      item('שנת', 220, 500, { width: 20, dir: 'rtl' }),
      item('2024', 190, 500, { width: 25 }),
      item('הייתה טובה', 100, 500, { width: 85, dir: 'rtl' }),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual(['שנת 2024 הייתה טובה']);
    expect(blocks[0]?.lines).toHaveLength(1);
  });

  it('keeps one copy of a line drawn twice, run by run', () => {
    const blocks = pdfTextBlocks(content([
      item('Alpha', 50, 500, { width: 25 }),
      item('Beta', 80, 500, { width: 20 }),
      item('Gamma', 105, 500, { width: 30, eol: true }),
      item('Alpha', 50.3, 500.1, { width: 25 }),
      item('Beta', 80.3, 500.1, { width: 20 }),
      item('Gamma', 105.3, 500.1, { width: 30, eol: true }),
      item('Next line', 50, 486),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual(['Alpha Beta Gamma Next line']);
  });

  it('starts a block at an Office bullet from the private-use range', () => {
    const blocks = pdfTextBlocks(content([
      item('Items to bring', 50, 500, { eol: true }),
      item('\uf0b7 a coat', 50, 486, { eol: true }),
      item('\uf0a7 a hat', 50, 472),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual([
      'Items to bring',
      '\uf0b7 a coat',
      '\uf0a7 a hat',
    ]);
  });

  it('leaves a block with no area as drawn', () => {
    const blocks = pdfTextBlocks(content([
      item('Zero width', 50, 500, { width: 0 }),
      item('Real text', 50, 400, { width: 40 }),
    ]), PAGE_TRANSFORM);

    expect(blocks.map((block) => block.text)).toEqual(['Real text']);
  });
});
