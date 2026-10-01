import { hasPdfSignature } from './pdf-detection';
import { MAX_PDF_BYTES, PdfFetchError } from './pdf-fetch';

/**
 * A PDF from this computer that the reader chose in the panel (D107). The
 * key names this one choice for reading positions and the OCR cache; it is
 * never the file's name or path.
 */
export interface LocalPdfFile {
  readonly file: Blob;
  readonly key: string;
}

export interface PdfFileReadOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
}

/**
 * Reads a chosen file's bytes, with the same cap and `%PDF-` check as a
 * download: the size is checked before anything is read. A file that moved
 * or changed since it was chosen cannot be read (Chrome refuses a changed
 * file) and fails as `failed`. A cancel ends the wait at once, even while a
 * slow drive is still reading. Errors are content-free.
 */
export async function readPdfFile(
  file: Blob,
  options: PdfFileReadOptions = {},
): Promise<Uint8Array> {
  const { signal } = options;
  const maxBytes = options.maxBytes ?? MAX_PDF_BYTES;
  const aborted = () => new PdfFetchError(
    'aborted',
    'Reading the PDF file was cancelled.',
    { cause: signal?.reason },
  );
  if (signal?.aborted) throw aborted();
  if (file.size > maxBytes) {
    throw new PdfFetchError('too-large', 'The PDF is larger than Simul reads.');
  }
  let bytes: Uint8Array;
  let stopWaiting: (() => void) | undefined;
  try {
    const read = file.arrayBuffer();
    const buffer = signal
      ? await Promise.race([
          read,
          new Promise<never>((_resolve, reject) => {
            stopWaiting = () => reject(aborted());
            signal.addEventListener('abort', stopWaiting, { once: true });
          }),
        ])
      : await read;
    bytes = new Uint8Array(buffer);
  } catch (error) {
    if (signal?.aborted) throw aborted();
    throw new PdfFetchError('failed', 'The PDF file could not be read.', { cause: error });
  } finally {
    if (stopWaiting) signal?.removeEventListener('abort', stopWaiting);
  }
  if (signal?.aborted) throw aborted();
  if (!hasPdfSignature(bytes)) {
    throw new PdfFetchError('not-pdf', 'The chosen file is not a PDF.');
  }
  return bytes;
}

/** What a dropped file shows of itself. */
export interface DroppedFile {
  readonly name: string;
  readonly type: string;
}

/**
 * The file a drop opens: the first PDF by type or name, else the first file
 * (which the PDF check then refuses with its status). Undefined for none.
 */
export function chooseDroppedPdf<T extends DroppedFile>(files: readonly T[]): T | undefined {
  return files.find((file) =>
    file.type.toLowerCase() === 'application/pdf' || /\.pdf$/iu.test(file.name)) ?? files[0];
}
