import { describe, expect, it } from 'vitest';

import {
  classifyPdfResponse,
  hasPdfSignature,
  isPdfContentType,
} from '../lib/pdf/pdf-detection';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('isPdfContentType', () => {
  it.each([
    'application/pdf',
    'APPLICATION/PDF',
    ' application/pdf ',
    'application/pdf; charset=binary',
  ])('accepts %j', (value) => {
    expect(isPdfContentType(value)).toBe(true);
  });

  it.each([
    'text/html',
    'application/x-pdf',
    'application/pdfx',
    'text/plain; application/pdf',
    '',
    undefined,
    null,
    42,
    { contentType: 'application/pdf' },
  ])('rejects %j', (value) => {
    expect(isPdfContentType(value)).toBe(false);
  });
});

describe('hasPdfSignature', () => {
  it('finds %PDF- at the start or anywhere in the first 1 KiB', () => {
    expect(hasPdfSignature(bytes('%PDF-1.7\n'))).toBe(true);
    expect(hasPdfSignature(bytes(`${' '.repeat(1019)}%PDF-`))).toBe(true);
  });

  it('ignores a signature that starts or ends past 1 KiB', () => {
    expect(hasPdfSignature(bytes(`${' '.repeat(1020)}%PDF-`))).toBe(false);
    expect(hasPdfSignature(bytes(`${' '.repeat(2000)}%PDF-1.4`))).toBe(false);
  });

  it('rejects short, empty and near-miss inputs', () => {
    expect(hasPdfSignature(new Uint8Array(0))).toBe(false);
    expect(hasPdfSignature(bytes('%PDF'))).toBe(false);
    expect(hasPdfSignature(bytes('%pdf-1.4'))).toBe(false);
  });
});

describe('classifyPdfResponse', () => {
  const pdf = bytes('%PDF-1.4\n');

  it('accepts PDF bytes whatever the declared type', () => {
    for (const contentType of ['application/pdf', 'application/octet-stream', null]) {
      expect(classifyPdfResponse({ status: 200, contentType, head: pdf })).toBe('pdf');
    }
  });

  it('treats an error status as a failed download', () => {
    for (const status of [0, 199, 304, 404, 500]) {
      expect(classifyPdfResponse({ status, contentType: 'application/pdf', head: pdf }))
        .toBe('failed');
    }
  });

  it('treats a web page in place of the PDF as a failed download', () => {
    expect(classifyPdfResponse({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      head: bytes('Please sign in'),
    })).toBe('failed');
    expect(classifyPdfResponse({
      status: 200,
      contentType: 'application/octet-stream',
      head: bytes('﻿  <!DOCTYPE html><html><body>Sign in</body></html>'),
    })).toBe('failed');
    // However the markup starts, and an XML error document too.
    for (const start of [
      '<!-- login --><html>',
      '<meta charset="utf-8"><title>Sign in</title>',
      '\n<script>location = "/login"</script>',
      '<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>',
    ]) {
      expect(classifyPdfResponse({
        status: 200,
        contentType: 'application/pdf',
        head: bytes(start),
      })).toBe('failed');
    }
  });

  it('reports other bytes as not a PDF', () => {
    expect(classifyPdfResponse({
      status: 200,
      contentType: 'application/pdf',
      head: bytes('PK\u0003\u0004 not a pdf'),
    })).toBe('not-pdf');
    expect(classifyPdfResponse({ status: 200, contentType: 'application/pdf', head: new Uint8Array(0) }))
      .toBe('not-pdf');
  });
});
