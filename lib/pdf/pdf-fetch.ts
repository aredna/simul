import { PDF_SIGNATURE_WINDOW, classifyPdfResponse } from './pdf-detection';

/** The largest PDF Simul downloads (128 MiB). */
export const MAX_PDF_BYTES = 128 * 1024 * 1024;
/** How long the download may wait for the server or go without a byte. */
export const PDF_FETCH_TIMEOUT_MS = 60_000;

/**
 * `too-large`: over the size cap. `failed`: no file came back (network error,
 * error status, timeout, or a web page in its place). `not-pdf`: the file is
 * not a PDF. `aborted`: the caller cancelled.
 */
export type PdfFetchErrorKind = 'too-large' | 'failed' | 'not-pdf' | 'aborted';

/** Messages are content-free: never a URL, a file name or a byte of the file. */
export class PdfFetchError extends Error {
  constructor(
    public readonly kind: PdfFetchErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PdfFetchError';
  }
}

export interface PdfFetchOptions {
  readonly signal?: AbortSignal;
  /** Replaces the global fetch; tests pass a fake. */
  readonly fetch?: typeof fetch;
  readonly maxBytes?: number;
  /** A stall limit: the timer restarts with every piece of the file. */
  readonly timeoutMs?: number;
}

/**
 * Downloads the PDF the tab shows. Chrome keeps a separate HTTP cache for the
 * extension, so this is a second download of the tab's file, with the site's
 * cookies as for the tab; normal caching lets a Refresh or a return to the
 * tab reuse Simul's own fresh copy, and revalidates a stale one. The size is
 * capped, and a download that stalls for the timeout fails; a slow one that
 * keeps moving does not.
 */
export async function fetchPdfBytes(
  url: string,
  options: PdfFetchOptions = {},
): Promise<Uint8Array> {
  const { signal } = options;
  const fetchFile = options.fetch ?? globalThis.fetch.bind(globalThis);
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
  const timeoutMs = options.timeoutMs ?? PDF_FETCH_TIMEOUT_MS;
  if (signal?.aborted) throw abortedError(signal.reason);

  // One controller ends the request for either reason; the flags tell a
  // timeout (a failed download) from the caller's cancel.
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restartTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  restartTimer();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const failure = (error: unknown): PdfFetchError => {
    if (signal?.aborted) return abortedError(signal.reason);
    if (timedOut) {
      return new PdfFetchError('failed', 'The PDF download timed out.', { cause: error });
    }
    if (error instanceof PdfFetchError) return error;
    return new PdfFetchError('failed', 'The PDF could not be downloaded.', { cause: error });
  };

  try {
    let response: Response;
    try {
      response = await fetchFile(url, {
        credentials: 'include',
        cache: 'default',
        redirect: 'follow',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
    } catch (error) {
      throw failure(error);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw failure(new PdfFetchError('failed', `The PDF download returned status ${response.status}.`));
    }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw tooLargeError();
    }
    let bytes: Uint8Array;
    try {
      restartTimer();
      bytes = await readBody(
        response,
        maxBytes,
        controller.signal,
        restartTimer,
        Number.isInteger(declared) && declared >= 0 ? declared : undefined,
      );
    } catch (error) {
      throw failure(error);
    }
    const verdict = classifyPdfResponse({
      status: response.status,
      contentType: response.headers.get('content-type'),
      head: bytes.subarray(0, PDF_SIGNATURE_WINDOW),
    });
    if (verdict === 'failed') {
      throw new PdfFetchError('failed', 'The download returned a web page, not the PDF.');
    }
    if (verdict === 'not-pdf') {
      throw new PdfFetchError('not-pdf', 'The downloaded file is not a PDF.');
    }
    return bytes;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Reads the body with a running total and stops as soon as it passes the cap.
 * With a declared length it fills one buffer of that size, so the file is not
 * held twice; pieces are gathered only when the length is unknown or wrong.
 */
async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  onProgress: () => void,
  declaredBytes: number | undefined,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  // A stalled read ends when the request is aborted: cancelling the reader
  // settles the pending read even where the stream ignores the signal.
  const stop = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  let buffer = declaredBytes !== undefined && declaredBytes <= maxBytes
    ? new Uint8Array(declaredBytes)
    : undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      onProgress();
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {});
        throw tooLargeError();
      }
      if (buffer && total + value.byteLength <= buffer.byteLength) {
        buffer.set(value, total);
      } else {
        // More than declared (or no declared length): gather pieces instead.
        if (buffer) {
          chunks.push(buffer.subarray(0, total));
          buffer = undefined;
        }
        chunks.push(value);
      }
      total += value.byteLength;
    }
  } finally {
    signal.removeEventListener('abort', stop);
  }
  if (buffer) return total === buffer.byteLength ? buffer : buffer.slice(0, total);
  if (chunks.length === 1) return chunks[0]!;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tooLargeError(): PdfFetchError {
  return new PdfFetchError('too-large', 'The PDF is larger than Simul downloads.');
}

function abortedError(cause?: unknown): PdfFetchError {
  return new PdfFetchError('aborted', 'The PDF download was cancelled.', { cause });
}
