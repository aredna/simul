import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_PDF_BYTES,
  PDF_FETCH_TIMEOUT_MS,
  PdfFetchError,
  fetchPdfBytes,
} from '../lib/pdf/pdf-fetch';

const URL_UNDER_TEST = 'https://example.com/report.pdf';
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');

afterEach(() => {
  vi.useRealTimers();
});

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

function response(
  body: ReadableStream<Uint8Array> | Uint8Array | string | null,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const stream = typeof body === 'string'
    ? streamOf([new TextEncoder().encode(body)])
    : body instanceof Uint8Array
      ? streamOf([body])
      : body;
  return new Response(stream, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'application/pdf' },
  });
}

async function fetchError(promise: Promise<unknown>): Promise<PdfFetchError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(PdfFetchError);
  return error as PdfFetchError;
}

describe('fetchPdfBytes', () => {
  it('downloads the tab URL with normal caching and the site cookies', async () => {
    const fetch = vi.fn(async () => response(streamOf([
      PDF_BYTES.subarray(0, 4),
      PDF_BYTES.subarray(4),
    ])));

    const bytes = await fetchPdfBytes(URL_UNDER_TEST, { fetch });

    expect([...bytes]).toEqual([...PDF_BYTES]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(URL_UNDER_TEST, expect.objectContaining({
      credentials: 'include',
      // Chrome keeps the extension's cache apart from the tab's, so
      // force-cache could only ever serve Simul's own, possibly stale, copy.
      cache: 'default',
      signal: expect.any(AbortSignal),
    }));
  });

  it('sets the limits the plan names', () => {
    expect(MAX_PDF_BYTES).toBe(128 * 1024 * 1024);
    expect(PDF_FETCH_TIMEOUT_MS).toBe(60_000);
  });

  it('reports an error status and a network error as a failed download', async () => {
    const notFound = await fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response('Not found', { status: 404, headers: { 'content-type': 'text/html' } }),
    }));
    expect(notFound.kind).toBe('failed');

    const offline = await fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
    }));
    expect(offline.kind).toBe('failed');
    expect(offline.message).not.toContain(URL_UNDER_TEST);
  });

  it('refuses a declared size over the cap before reading the body', async () => {
    const pull = vi.fn();
    // No read ahead: the source is pulled only when the body is read.
    const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const error = await fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      maxBytes: 10,
      fetch: async () => response(body, {
        headers: { 'content-type': 'application/pdf', 'content-length': '11' },
      }),
    }));

    expect(error.kind).toBe('too-large');
    expect(pull).not.toHaveBeenCalled();
  });

  it('stops reading once the streamed bytes pass the cap', async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(6).fill(0x25));
      },
      cancel,
    });
    const error = await fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      maxBytes: 10,
      fetch: async () => response(body),
    }));

    expect(error.kind).toBe('too-large');
    expect(cancel).toHaveBeenCalled();
    expect(pulls).toBeLessThan(5);
  });

  it('gives up after the timeout as a failed download', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      }));
    const pending = fetchError(fetchPdfBytes(URL_UNDER_TEST, { fetch, timeoutMs: 1_000 }));

    await vi.advanceTimersByTimeAsync(1_000);

    expect((await pending).kind).toBe('failed');
  });

  it('times out a body that stops arriving', async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF_BYTES);
      },
    });
    const pending = fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(stalled),
      timeoutMs: 500,
    }));

    await vi.advanceTimersByTimeAsync(500);

    expect((await pending).kind).toBe('failed');
  });

  it('lets a slow download that keeps moving finish; the timeout is a stall limit', async () => {
    vi.useFakeTimers();
    let sent = 0;
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Each piece takes 400 ms against a 500 ms limit: 2 s in all.
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (sent === 5) {
          controller.close();
          return;
        }
        controller.enqueue(sent === 0 ? PDF_BYTES : new Uint8Array(8));
        sent += 1;
      },
    }, { highWaterMark: 0 });
    const pending = fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(slow),
      timeoutMs: 500,
    });

    await vi.advanceTimersByTimeAsync(2_500);

    expect((await pending).byteLength).toBe(PDF_BYTES.byteLength + 4 * 8);
  });

  it('fills one buffer of the declared length, and copes with a wrong one', async () => {
    const exact = await fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(streamOf([PDF_BYTES.subarray(0, 5), PDF_BYTES.subarray(5)]), {
        headers: { 'content-type': 'application/pdf', 'content-length': String(PDF_BYTES.byteLength) },
      }),
    });
    expect([...exact]).toEqual([...PDF_BYTES]);
    expect(exact.buffer.byteLength).toBe(PDF_BYTES.byteLength);

    // A compressed transfer declares fewer bytes than arrive.
    const longer = await fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(streamOf([PDF_BYTES, PDF_BYTES]), {
        headers: { 'content-type': 'application/pdf', 'content-length': '6' },
      }),
    });
    expect([...longer]).toEqual([...PDF_BYTES, ...PDF_BYTES]);

    const shorter = await fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(streamOf([PDF_BYTES]), {
        headers: { 'content-type': 'application/pdf', 'content-length': '999' },
      }),
    });
    expect([...shorter]).toEqual([...PDF_BYTES]);
  });

  it('copies each piece of a download with no length as it arrives (P5)', async () => {
    // A producer may hand out one buffer again and again. A reader that keeps
    // the pieces by reference would end with the last piece repeated, and
    // would hold every piece next to the finished file near the size cap.
    const piece = new Uint8Array(8);
    const pieces = ['%PDF-1.7', '%PDF-2.0', '%PDF-3.0'];
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      // One buffer, filled again for each piece: a reader that keeps pieces by
      // reference holds the last contents for all of them.
      pull(controller) {
        const text = pieces[index];
        index += 1;
        if (text === undefined) {
          controller.close();
          return;
        }
        piece.set(new TextEncoder().encode(text));
        controller.enqueue(piece);
      },
    }, { highWaterMark: 0 });

    const bytes = await fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(body),
    });

    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7%PDF-2.0%PDF-3.0');
  });

  it('returns a buffer of the file\'s own length after gathering (P5 repair)', async () => {
    // Just above the first gather capacity (64 KiB): the gather buffer doubles
    // to 128 KiB, and a view of it would keep that half-empty buffer alive for
    // as long as the document holds the file.
    const size = 64 * 1024 + 100;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const first = new Uint8Array(64 * 1024);
        first.set(new TextEncoder().encode('%PDF-1.7'));
        controller.enqueue(first);
        controller.enqueue(new Uint8Array(size - first.byteLength));
        controller.close();
      },
    });

    const bytes = await fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(body),
    });

    expect(bytes.byteLength).toBe(size);
    expect(bytes.buffer.byteLength).toBe(size);
  });

  it('returns an exact buffer when transfer is refused (P5 repair)', async () => {
    // Node 24 and this project's Chrome have ArrayBuffer.prototype.transfer, so
    // the test above never reaches the copy. A runtime without it, or one that
    // refuses the transfer, falls back to .slice: the result must still be a
    // buffer of the file's own length, not a view of the gather slack.
    const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'transfer');
    Object.defineProperty(ArrayBuffer.prototype, 'transfer', {
      configurable: true,
      value: () => {
        throw new TypeError('ArrayBuffer.transfer is not available here.');
      },
    });
    try {
      const size = 64 * 1024 + 100;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const first = new Uint8Array(64 * 1024);
          first.set(new TextEncoder().encode('%PDF-1.7'));
          controller.enqueue(first);
          controller.enqueue(new Uint8Array(size - first.byteLength));
          controller.close();
        },
      });

      const bytes = await fetchPdfBytes(URL_UNDER_TEST, {
        fetch: async () => response(body),
      });

      expect(bytes.byteLength).toBe(size);
      expect(bytes.buffer.byteLength).toBe(size);
    } finally {
      if (descriptor) Object.defineProperty(ArrayBuffer.prototype, 'transfer', descriptor);
      else delete (ArrayBuffer.prototype as { transfer?: unknown }).transfer;
    }
  });

  it('reports the caller cancelling, before or during the download', async () => {
    const before = new AbortController();
    before.abort();
    const fetch = vi.fn();
    const early = await fetchError(fetchPdfBytes(URL_UNDER_TEST, { fetch, signal: before.signal }));
    expect(early.kind).toBe('aborted');
    expect(fetch).not.toHaveBeenCalled();

    const during = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(PDF_BYTES);
      },
    });
    const pending = fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(stalled),
      signal: during.signal,
    }));
    await Promise.resolve();
    during.abort();
    expect((await pending).kind).toBe('aborted');
  });

  it('reports a web page in place of the PDF as a failed download', async () => {
    const error = await fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response('<!doctype html><title>Sign in</title>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    }));
    expect(error.kind).toBe('failed');
  });

  it('reports other bytes as not a PDF', async () => {
    const error = await fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])),
    }));
    expect(error.kind).toBe('not-pdf');

    const empty = await fetchError(fetchPdfBytes(URL_UNDER_TEST, {
      fetch: async () => response(null),
    }));
    expect(empty.kind).toBe('not-pdf');
  });
});
