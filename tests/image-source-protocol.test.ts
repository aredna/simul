import { describe, expect, it } from 'vitest';

import type { SourceImageDescriptor } from '../lib/ocr/contracts';
import {
  createImageSourcePortName,
  readImageSourceControllerMessage,
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
      kind: 'simul:image-source-v1:start',
      document: documentIdentity,
    }, documentIdentity.sessionId)).toEqual({
      kind: 'simul:image-source-v1:start',
      document: documentIdentity,
    });
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'request-1',
      descriptor,
    }, documentIdentity.sessionId, documentIdentity)).toMatchObject({
      requestId: 'request-1',
      descriptor: { nodeId: 9 },
    });
  });

  it('rejects extra fields, wrong documents, URLs, and malformed geometry', () => {
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v1:measure',
      requestId: 'request-1',
      descriptor,
      url: 'https://private.example/image.png',
    }, documentIdentity.sessionId, documentIdentity)).toBeUndefined();
    expect(readImageSourceControllerMessage({
      kind: 'simul:image-source-v1:measure',
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
    const change = readImageSourceRecorderMessage({
      kind: 'simul:image-source-v1:change',
      change: { kind: 'upsert', descriptor },
    }, documentIdentity);
    const response = readImageSourceRecorderMessage({
      kind: 'simul:image-source-v1:metrics',
      requestId: 'request-1',
      status: 'ready',
      metrics,
    }, documentIdentity);
    expect(change).toMatchObject({ change: { descriptor: { nodeId: 9 } } });
    expect(response).toMatchObject({ status: 'ready', metrics: { width: 320 } });
    expect(JSON.stringify([change, response])).not.toMatch(
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
  });
});
