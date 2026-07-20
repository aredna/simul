import { describe, expect, it } from 'vitest';

import {
  MAX_REPLICA_LIVE_EVENT_BYTES,
  createLiveAckMessage,
  createLiveBatchEnvelope,
  createLiveCheckpointAckMessage,
  createReplicaLivePortName,
  createStartLiveMessage,
  readLiveControllerMessage,
  readLiveRecorderMessage,
  readReplicaLivePortSessionId,
} from '../lib/replica/live-protocol';
import {
  createCheckpointEnvelope,
  createReplicaIdentity,
} from '../lib/replica/protocol-v2';

const identity = createReplicaIdentity({
  sessionId: 'session-live-protocol',
  pageEpoch: 7,
  generation: 7,
  documentId: 'document-live-protocol',
  frameId: 0,
  sequence: 0,
});

describe('replica live protocol', () => {
  it('round-trips exact controller messages and binds the Port session', () => {
    const portName = createReplicaLivePortName(identity.sessionId);
    expect(readReplicaLivePortSessionId(portName)).toBe(identity.sessionId);
    expect(readReplicaLivePortSessionId(`${portName}!`)).toBeUndefined();

    expect(
      readLiveControllerMessage(
        JSON.parse(JSON.stringify(createStartLiveMessage(identity))),
        identity.sessionId,
      ),
    ).toEqual(createStartLiveMessage(identity));
    expect(
      readLiveControllerMessage(
        createLiveAckMessage(identity, 4),
        identity.sessionId,
      )?.identity.sequence,
    ).toBe(4);
    expect(
      readLiveControllerMessage(
        createLiveCheckpointAckMessage(identity, 3),
        identity.sessionId,
      ),
    ).toMatchObject({
      kind: 'simul:replica-v2:checkpoint-ack',
      identity: { sequence: 3 },
    });
    expect(
      readLiveControllerMessage(
        { ...createStartLiveMessage(identity), extra: true },
        identity.sessionId,
      ),
    ).toBeUndefined();
    expect(
      readLiveControllerMessage(
        createStartLiveMessage(identity),
        'another-session',
      ),
    ).toBeUndefined();
  });

  it('validates batch count, bytes, sequence, identity, and exact payload shape', () => {
    const events = [scrollEvent(10), scrollEvent(11)];
    const envelope = createLiveBatchEnvelope(identity, 1, events);
    expect(envelope).toBeDefined();
    if (!envelope) throw new Error('Expected a batch fixture.');

    const parsed = readLiveRecorderMessage(
      JSON.parse(JSON.stringify(envelope)),
      identity,
    );
    expect(parsed).toMatchObject({
      kind: 'simul:replica-v2:batch',
      identity: { sequence: 2 },
      payload: { firstSequence: 1, byteLength: envelope.payload.byteLength },
    });

    expect(readLiveRecorderMessage({ ...envelope, extra: true }, identity)).toBeUndefined();
    expect(readLiveRecorderMessage({
      ...envelope,
      identity: { ...envelope.identity, sequence: 3 },
    }, identity)).toBeUndefined();
    expect(readLiveRecorderMessage({
      ...envelope,
      identity: { ...envelope.identity, documentId: 'other-document' },
    }, identity)).toBeUndefined();
    expect(readLiveRecorderMessage({
      ...envelope,
      payload: { ...envelope.payload, byteLength: envelope.payload.byteLength + 1 },
    }, identity)).toBeUndefined();
    expect(readLiveRecorderMessage({
      ...envelope,
      payload: { ...envelope.payload, extra: true },
    }, identity)).toBeUndefined();
  });

  it('rejects oversized individual events before constructing a Port message', () => {
    const oversized = {
      type: 3,
      data: { source: 0, value: 'x'.repeat(MAX_REPLICA_LIVE_EVENT_BYTES) },
      timestamp: 1,
    };
    expect(createLiveBatchEnvelope(identity, 1, [oversized])).toBeUndefined();
    expect(createLiveBatchEnvelope(identity, 0, [scrollEvent(1)])).toBeUndefined();
    expect(createLiveBatchEnvelope(identity, 1, [])).toBeUndefined();
  });

  it('accepts a recovery checkpoint at a new sequence only for the same document', () => {
    const checkpointIdentity = createReplicaIdentity({
      ...identity,
      sequence: 9,
    });
    const checkpoint = createCheckpointEnvelope(checkpointIdentity, {
      events: checkpointEvents(),
      captureMs: 2,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 900,
      documentHeight: 1_200,
    });
    expect(checkpoint.kind).toBe('simul:replica-v2:checkpoint');
    expect(readLiveRecorderMessage(checkpoint, identity)).toMatchObject({
      kind: 'simul:replica-v2:checkpoint',
      identity: { sequence: 9 },
    });
    expect(readLiveRecorderMessage(checkpoint, {
      ...identity,
      generation: 8,
      pageEpoch: 8,
    })).toBeUndefined();
  });
});

function scrollEvent(timestamp: number): Record<string, unknown> {
  return {
    type: 3,
    data: { source: 3, id: 2, x: timestamp, y: timestamp },
    timestamp,
  };
}

function checkpointEvents(): readonly unknown[] {
  return [
    {
      type: 4,
      data: { href: 'https://example.test/', width: 800, height: 600 },
      timestamp: 1,
    },
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
          childNodes: [
            {
              type: 2,
              id: 2,
              tagName: 'html',
              attributes: {},
              childNodes: [],
            },
          ],
        },
        initialOffset: { top: 0, left: 0 },
      },
      timestamp: 2,
    },
  ];
}
