import { describe, expect, it } from 'vitest';

import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import {
  captureRequestMatchesSourceDocument,
  sameSourceReplicaLease,
  type ReplicaSourceDocumentIdentity,
} from '../lib/replica/source-identity';

const document: ReplicaSourceDocumentIdentity = {
  sessionId: 'source-identity-session',
  pageEpoch: 3,
  generation: 3,
  documentId: 'source-identity-document',
  frameId: 0,
};

const request: ReplicaCaptureRequest = {
  ...document,
  tabId: 8,
  isCurrent: () => true,
};

describe('capture request source identity', () => {
  it('matches every transported document field exactly', () => {
    expect(captureRequestMatchesSourceDocument(request, document)).toBe(true);
    expect(captureRequestMatchesSourceDocument(
      { ...request, sessionId: 'other-session' },
      document,
    )).toBe(false);
    expect(captureRequestMatchesSourceDocument(
      { ...request, pageEpoch: 4, generation: 4 },
      document,
    )).toBe(false);
    expect(captureRequestMatchesSourceDocument(
      { ...request, documentId: 'other-document' },
      document,
    )).toBe(false);
    expect(captureRequestMatchesSourceDocument(
      { ...request, frameId: 1 },
      document,
    )).toBe(false);
  });

  it('requires the selected source document and replay lease to match together', () => {
    const current = { document, replayLease: 7 };

    expect(sameSourceReplicaLease(current, {
      document: { ...document },
      replayLease: 7,
    })).toBe(true);
    expect(sameSourceReplicaLease(current, {
      document: { ...document, documentId: 'other-document' },
      replayLease: 7,
    })).toBe(false);
    expect(sameSourceReplicaLease(current, {
      document: { ...document },
      replayLease: 6,
    })).toBe(false);
  });
});
