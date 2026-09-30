import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DOMMatrix, ImageData, Path2D, createCanvas } from '@napi-rs/canvas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sampleBlockColours } from '../lib/pdf/colour-sample';
import { openPdfDocument, type PdfDocumentHandle } from '../lib/pdf/pdfjs-runtime';
import { pdfTextBlocks } from '../lib/pdf/text-blocks';

const vendorDirectory = resolve('vendor/pdfjs');
const opened: PdfDocumentHandle[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(opened.splice(0).map((document) => document.destroy()));
});

/** The overlay colours of every block of page 1, drawn at `scale`. */
async function drawnColours(name: string, scale: number) {
  vi.stubGlobal('DOMMatrix', DOMMatrix);
  vi.stubGlobal('ImageData', ImageData);
  vi.stubGlobal('Path2D', Path2D);
  const bytes = new Uint8Array(await readFile(resolve('tests/fixtures/pdf', name)));
  const document = await openPdfDocument(bytes, {
    moduleBase: `${pathToFileURL(vendorDirectory).href}/`,
    dataBase: `${vendorDirectory}/`,
    workerFetch: false,
  });
  opened.push(document);
  const size = await document.getPageSize(1);
  const blocks = pdfTextBlocks(await document.getTextContent(1), size.transform, size.width);
  const canvas = createCanvas(1, 1);
  const drawn = await document.render(1, canvas as unknown as OffscreenCanvas, scale);
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  return blocks.map((block) => ({
    text: block.text,
    align: block.align,
    ...sampleBlockColours(pixels, block.lines.map((line) => ({
      left: line.left * drawn,
      top: line.top * drawn,
      width: line.width * drawn,
      height: line.height * drawn,
    }))),
  }));
}

function channels(colour: string): number[] {
  return (/rgb\((\d+), (\d+), (\d+)\)/u.exec(colour) ?? []).slice(1).map(Number);
}

describe('overlay colours on a real pdf.js drawing', () => {
  // A side panel at Fit draws a Letter page about 0.65 pixels per point on
  // a standard screen, 1.3 on a high-density one. At 0.65 the darkest pixel
  // of black 10.5-point text is about 71: nothing darker exists to find.
  it.each([
    [0.65, 95],
    [1.3, 70],
  ])('reads black body text as dark and #777 text as grey at %s px/pt', async (scale, darkest) => {
    const blocks = await drawnColours('grey-text.pdf', scale);
    const body = blocks.find((block) => block.text.startsWith('The harbor'))!;
    const footnote = blocks.find((block) => block.text.startsWith('Footnote'))!;

    expect(channels(body.background)).toEqual([255, 255, 255]);
    for (const value of channels(body.ink)) expect(value).toBeLessThanOrEqual(darkest);
    const grey = channels(footnote.ink);
    for (const value of grey) {
      // #777 is 119: allow the antialiased edge a little lighter, never black.
      expect(value).toBeGreaterThanOrEqual(105);
      expect(value).toBeLessThanOrEqual(170);
    }
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThanOrEqual(8);
  });

  it('finds the centred title and the right-aligned signature', async () => {
    const blocks = await drawnColours('grey-text.pdf', 1);
    expect(blocks.map((block) => [block.text, block.align])).toEqual([
      ['Quarterly Harbor Report', 'center'],
      [
        'The harbor received many ships this quarter, and the weather stayed calm ' +
          'for most of the season. Dock workers unloaded grain, timber, and machinery ' +
          'while the port authority planned a new pier for the coming year.',
        'left',
      ],
      [
        'Footnote: the figures above are provisional and will be revised after the ' +
          'annual audit. Tonnage is reported in metric tons and includes transit cargo.',
        'left',
      ],
      ['Signed, the port authority', 'left'],
    ]);
  });

  it.each([0.65, 1.3])('covers a snug header cell and a tinted band with their own fill at %s px/pt', async (scale) => {
    const blocks = await drawnColours('cell.pdf', scale);
    const header = blocks.find((block) => block.text.startsWith('Quarter'))!;
    const note = blocks.find((block) => block.text.startsWith('Note'))!;
    const body = blocks.find((block) => block.text.startsWith('The harbor'))!;

    expect(channels(header.background)).toEqual([20, 41, 110]);
    for (const value of channels(header.ink)) expect(value).toBeGreaterThanOrEqual(190);
    expect(channels(note.background)).toEqual([255, 245, 191]);
    const [red, green, blue] = channels(note.ink);
    expect(red! - green!).toBeGreaterThan(60);
    expect(red! - blue!).toBeGreaterThan(60);
    expect(channels(body.background)).toEqual([255, 255, 255]);
  });
});
