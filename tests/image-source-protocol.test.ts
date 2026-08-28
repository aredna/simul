import { describe, expect, it } from 'vitest';

import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import {
  IMAGE_SOURCE_PROTOCOL_VERSION,
  createImageSourcePortName,
  readImageSourceControllerMessage,
  readImageSourcePortIdentity,
  readImageSourcePortSessionId,
  readImageSourceRecorderMessage,
  readSourceImageCaptureMetrics,
  sameImageCaptureMetrics,
} from '../lib/ocr/image-source-protocol';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const documentIdentity: ReplicaSourceDocumentIdentity = {
  sessionId: 'session-image',
  pageEpoch: 2,
  generation: 2,
  documentId: 'document-image',
  frameId: 0,
};

const descriptor: SourceImageDescriptor = {
  document: documentIdentity,
  nodeId: 9,
  sourceKind: 'img',
  contentRevision: 3,
  observationRevision: 4,
  visibility: 'visible',
  connected: true,
  renderedWidth: 320,
  renderedHeight: 180,
  intrinsicWidth: 1_280,
  intrinsicHeight: 720,
};

const metrics = {
  document: documentIdentity,
  nodeId: 9,
  contentRevision: 3,
  observationRevision: 4,
  left: 12,
  top: 16,
  width: 320,
  height: 180,
  viewportWidth: 1_200,
  viewportHeight: 800,
  scrollX: 0,
  scrollY: 40,
  devicePixelRatio: 2,
};

describe('image source protocol', () => {
  it('binds a safe session and accepts strict exact-document commands', () => {
    const name = createImageSourcePortName(documentIdentity.sessionId);
    expect(readImageSourcePortSessionId(name)).toBe(documentIdentity.sessionId);
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:start',
      document: documentIdentity,
    }, documentIdentity.sessionId)).toEqual({
      kind: 'simul:image-source-v2:start',
      document: documentIdentity,
    });
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'request-1',
      descriptor,
    }, documentIdentity.sessionId, documentIdentity)).toMatchObject({
      requestId: 'request-1',
      descriptor: { nodeId: 9 },
    });
  });

  it('routes each image Port to the isolated replica owner', () => {
    expect(IMAGE_SOURCE_PROTOCOL_VERSION).toBe(2);
    const isolated = createImageSourcePortName(
      documentIdentity.sessionId,
      'isolated-html',
    );
    expect(readImageSourcePortIdentity(isolated, 'isolated-html')).toEqual({
      bridge: 'isolated-html',
      sessionId: documentIdentity.sessionId,
    });
    expect(readImageSourcePortSessionId('simul:image-source-v2:legacy-session'))
      .toBeUndefined();
    expect(readImageSourcePortSessionId(
      `simul:image-source-v1:legacy:${documentIdentity.sessionId}`,
    )).toBeUndefined();
  });

  it('admits accessibility text only through an explicit policy-bound read', () => {
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:start',
      document: documentIdentity,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      accessibilityTextEnabled: true,
    }, documentIdentity.sessionId)).toMatchObject({
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
      accessibilityTextEnabled: true,
    });
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:start',
      document: documentIdentity,
      policyFingerprint: 'read-v1-101000',
      controlImages: true,
      accessibilityTextEnabled: true,
    }, documentIdentity.sessionId)).toBeUndefined();
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'alt-1',
      descriptor,
      policyFingerprint: 'read-v1-111000',
      controlImages: true,
    }, documentIdentity.sessionId, documentIdentity)).toBeDefined();
    expect(readImageSourceRecorderMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'alt-1',
      descriptor,
      status: 'ready',
      evidence: {
        document: documentIdentity,
        nodeId: descriptor.nodeId,
        contentRevision: descriptor.contentRevision,
        observationRevision: descriptor.observationRevision,
        text: 'お知らせ',
        source: 'alt',
        nearestElementLanguage: 'ja',
      },
    }, documentIdentity)).toMatchObject({
      status: 'ready',
      evidence: { source: 'alt', nearestElementLanguage: 'ja' },
    });
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'alt-1',
      descriptor,
      policyFingerprint: 'forged',
      controlImages: true,
    }, documentIdentity.sessionId, documentIdentity)).toBeUndefined();
  });

  it('revalidates canonical accessibility text at the receiver boundary', () => {
    const ready = (text: string) => readImageSourceRecorderMessage({
      kind: 'simul:image-source-v2:accessibility-text',
      requestId: 'alt-canonical',
      descriptor,
      status: 'ready',
      evidence: {
        document: documentIdentity,
        nodeId: descriptor.nodeId,
        contentRevision: descriptor.contentRevision,
        observationRevision: descriptor.observationRevision,
        text,
        source: 'alt',
      },
    }, documentIdentity);

    expect(ready('News and updates')).toMatchObject({
      status: 'ready',
      evidence: { text: 'News and updates' },
    });
    for (const text of [
      '/assets/logo.svg?rev=1',
      'assets/logo.svg?rev=1',
      'www.example.com/logo.png',
      'file:///tmp/a.png',
      '//host/a.jpg',
      'logo.gif#current',
      ' News  and updates ',
    ]) expect(ready(text)).toBeUndefined();
  });

  it('rejects extra fields, wrong documents, URLs, and malformed geometry', () => {
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'request-1',
      descriptor,
      url: 'https://private.example/image.png',
    }, documentIdentity.sessionId, documentIdentity)).toBeUndefined();
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v2:measure',
      requestId: 'request-1',
      descriptor: {
        ...descriptor,
        document: { ...documentIdentity, documentId: 'different-document' },
      },
    }, documentIdentity.sessionId, documentIdentity)).toBeUndefined();
    expect(readSourceImageCaptureMetrics({ ...metrics, width: Infinity }))
      .toBeUndefined();
    expect(readSourceImageCaptureMetrics({ ...metrics, pixels: 'forbidden' }))
      .toBeUndefined();
    expect(readSourceImageCaptureMetrics({
      ...metrics,
      nearestElementLanguage: 'not-a-supported-language',
    })).toBeUndefined();
  });

  it('parses changes and capture responses without disclosing source data', () => {
    const ready = readImageSourceRecorderMessage({
      kind: 'simul:image-source-v2:ready',
      document: documentIdentity,
      summary: { candidateImages: 4, observedImages: 3 },
    }, documentIdentity);
    const change = readImageSourceRecorderMessage({
      kind: 'simul:image-source-v2:change',
      change: { kind: 'upsert', descriptor },
    }, documentIdentity);
    const response = readImageSourceRecorderMessage({
      kind: 'simul:image-source-v2:metrics',
      requestId: 'request-1',
      status: 'ready',
      metrics,
    }, documentIdentity);
    expect(ready).toEqual({
      kind: 'simul:image-source-v2:ready',
      document: documentIdentity,
      summary: { candidateImages: 4, observedImages: 3 },
    });
    expect(change).toMatchObject({ change: { descriptor: { nodeId: 9 } } });
    expect(response).toMatchObject({ status: 'ready', metrics: { width: 320 } });
    expect(JSON.stringify([ready, change, response])).not.toMatch(
      /private|https|"(?:src|url|pixels|text|hash)"/iu,
    );
    expect(sameImageCaptureMetrics(metrics, { ...metrics })).toBe(true);
    expect(readSourceImageCaptureMetrics({
      ...metrics,
      nearestElementLanguage: 'ja',
    })).toMatchObject({ nearestElementLanguage: 'ja' });
    expect(sameImageCaptureMetrics(metrics, { ...metrics, scrollY: 41 })).toBe(false);
    expect(sameImageCaptureMetrics(
      { ...metrics, nearestElementLanguage: 'ja' },
      { ...metrics, nearestElementLanguage: 'en' },
    )).toBe(false);
    expect(readImageSourceRecorderMessage({
      kind: 'simul:image-source-v2:ready',
      document: documentIdentity,
      summary: { candidateImages: 1, observedImages: 2 },
    }, documentIdentity)).toBeUndefined();
    expect(readImageSourceRecorderMessage({
      kind: 'simul:image-source-v2:ready',
      document: { ...documentIdentity, documentId: 'wrong-document' },
      summary: { candidateImages: 1, observedImages: 1 },
    }, documentIdentity)).toBeUndefined();
  });
});
