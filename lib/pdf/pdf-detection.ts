/** The media type Chrome reports as `document.contentType` for a PDF tab. */
export const PDF_MEDIA_TYPE = 'application/pdf';

/** How far into the file the `%PDF-` header may start (as in pdf.js and Chrome). */
export const PDF_SIGNATURE_WINDOW = 1024;

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/** Whether a content type names a PDF; parameters and letter case are ignored. */
export function isPdfContentType(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const essence = value.split(';', 1)[0] ?? '';
  return essence.trim().toLowerCase() === PDF_MEDIA_TYPE;
}

/** Whether `%PDF-` appears within the first 1 KiB. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, PDF_SIGNATURE_WINDOW) - PDF_SIGNATURE.length;
  for (let start = 0; start <= end; start += 1) {
    if (PDF_SIGNATURE.every((byte, offset) => bytes[start + offset] === byte)) {
      return true;
    }
  }
  return false;
}

/**
 * `pdf`: the bytes are a PDF. `failed`: the download did not return the file,
 * for example an error status or a sign-in page in its place. `not-pdf`: the
 * file came back but is not a PDF.
 */
export type PdfResponseVerdict = 'pdf' | 'failed' | 'not-pdf';

export interface PdfResponseFacts {
  readonly status: number;
  readonly contentType: string | null | undefined;
  /** The start of the body; only the first 1 KiB is read. */
  readonly head: Uint8Array;
}

export function classifyPdfResponse(response: PdfResponseFacts): PdfResponseVerdict {
  if (!Number.isInteger(response.status) || response.status < 200 || response.status > 299) {
    return 'failed';
  }
  if (hasPdfSignature(response.head)) return 'pdf';
  return isHtmlContentType(response.contentType) || startsLikeHtml(response.head)
    ? 'failed'
    : 'not-pdf';
}

function isHtmlContentType(value: string | null | undefined): boolean {
  const essence = (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return essence === 'text/html' || essence === 'application/xhtml+xml';
}

/**
 * Markup in place of the file: an HTML page however it starts (doctype,
 * comment, `<meta>`, `<script>`) or an XML error document. No PDF starts
 * with `<`.
 */
function startsLikeHtml(head: Uint8Array): boolean {
  const text = new TextDecoder('latin1')
    .decode(head.subarray(0, PDF_SIGNATURE_WINDOW))
    .replace(/^﻿|^ï»¿/u, '')
    .trimStart();
  return text.startsWith('<');
}
