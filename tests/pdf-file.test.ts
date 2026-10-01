import { describe, expect, it, vi } from 'vitest';

import { PdfFetchError } from '../lib/pdf/pdf-fetch';
import { chooseDroppedPdf, readPdfFile } from '../lib/pdf/pdf-file';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

async function failure(promise: Promise<unknown>): Promise<PdfFetchError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PdfFetchError);
  return error as PdfFetchError;
}

describe('reading a PDF chosen on this computer', () => {
  it('returns the bytes of a PDF', async () => {
    const bytes = await readPdfFile(new Blob([PDF], { type: 'application/pdf' }));

    expect([...bytes]).toEqual([...PDF]);
  });

  it('accepts a PDF whose header follows a little junk, whatever its type', async () => {
    const bytes = await readPdfFile(new Blob([new Uint8Array(40), PDF]));

    expect(bytes.byteLength).toBe(40 + PDF.byteLength);
  });

  it('refuses a file over the cap before reading any of it', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const file = { size: 2_000, arrayBuffer } as unknown as Blob;

    const error = await failure(readPdfFile(file, { maxBytes: 1_000 }));

    expect(error.kind).toBe('too-large');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses a file that is not a PDF, and an empty one', async () => {
    expect((await failure(readPdfFile(new Blob(['<!doctype html><p>Hi'])))).kind)
      .toBe('not-pdf');
    expect((await failure(readPdfFile(new Blob([])))).kind).toBe('not-pdf');
  });

  it('fails as unreadable when the file moved or changed since it was chosen', async () => {
    const file = {
      size: PDF.byteLength,
      arrayBuffer: async () => {
        throw new DOMException('The file changed.', 'NotReadableError');
      },
    } as unknown as Blob;

    const error = await failure(readPdfFile(file));

    expect(error.kind).toBe('failed');
    // Content-free: no file name or path in the message.
    expect(error.message).toBe('The PDF file could not be read.');
  });

  it('stops when cancelled before or during the read', async () => {
    const before = new AbortController();
    before.abort();
    expect((await failure(readPdfFile(new Blob([PDF]), { signal: before.signal }))).kind)
      .toBe('aborted');

    const during = new AbortController();
    const file = {
      size: PDF.byteLength,
      arrayBuffer: async () => {
        during.abort();
        return PDF.buffer.slice(0);
      },
    } as unknown as Blob;
    expect((await failure(readPdfFile(file, { signal: during.signal }))).kind).toBe('aborted');
  });

  it('stops waiting at once when cancelled while a slow drive is still reading', async () => {
    const controller = new AbortController();
    const file = {
      size: PDF.byteLength,
      arrayBuffer: () => new Promise<ArrayBuffer>(() => undefined),
    } as unknown as Blob;

    const pending = failure(readPdfFile(file, { signal: controller.signal }));
    controller.abort();

    expect((await pending).kind).toBe('aborted');
  });
});

describe('choosing the dropped file to open', () => {
  const file = (name: string, type = '') => ({ name, type });

  it('opens the first PDF among the dropped files, by type or by name', () => {
    expect(chooseDroppedPdf([file('notes.txt', 'text/plain'), file('a.pdf', 'application/pdf')]))
      .toEqual(file('a.pdf', 'application/pdf'));
    expect(chooseDroppedPdf([file('photo.png', 'image/png'), file('REPORT.PDF')]))
      .toEqual(file('REPORT.PDF'));
    expect(chooseDroppedPdf([file('scan', 'APPLICATION/PDF')])).toEqual(file('scan', 'APPLICATION/PDF'));
  });

  it('falls back to the first file, which the PDF check refuses, and to nothing', () => {
    expect(chooseDroppedPdf([file('a.docx'), file('b.txt')])).toEqual(file('a.docx'));
    expect(chooseDroppedPdf([])).toBeUndefined();
  });
});
