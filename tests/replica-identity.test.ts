import { describe, expect, it } from 'vitest';

import { REPLICA_PROTOCOL_VERSION } from '../lib/replica/contracts';
import {
  createReplicaIdentity,
  readReplicaIdentity,
  sameReplicaIdentity,
} from '../lib/replica/protocol-v2';

const parts = {
  sessionId: 'session-1234',
  pageEpoch: 2,
  generation: 2,
  documentId: 'ABCDEF0123456789ABCDEF0123456789',
  frameId: 0,
  sequence: 7,
} as const;

describe('replica document identity', () => {
  it('stamps the protocol version and freezes the identity', () => {
    const identity = createReplicaIdentity(parts);
    expect(identity).toEqual({ protocolVersion: REPLICA_PROTOCOL_VERSION, ...parts });
    expect(Object.isFrozen(identity)).toBe(true);
    expect(readReplicaIdentity(identity)).toEqual(identity);
  });

  it('rejects malformed, extra-keyed, or mismatched identities', () => {
    const identity = createReplicaIdentity(parts);
    expect(readReplicaIdentity({ ...identity, protocolVersion: 1 })).toBeUndefined();
    expect(readReplicaIdentity({ ...identity, extra: true })).toBeUndefined();
    expect(readReplicaIdentity({ ...identity, sessionId: 'has space' })).toBeUndefined();
    expect(readReplicaIdentity({ ...identity, sessionId: 'x'.repeat(129) })).toBeUndefined();
    expect(readReplicaIdentity({ ...identity, pageEpoch: 3 })).toBeUndefined();
    expect(readReplicaIdentity({ ...identity, generation: 0 })).toBeUndefined();
    expect(readReplicaIdentity({ ...identity, frameId: -1 })).toBeUndefined();
    expect(readReplicaIdentity({ ...identity, sequence: 1.5 })).toBeUndefined();
    expect(readReplicaIdentity(null)).toBeUndefined();
    expect(readReplicaIdentity([identity])).toBeUndefined();
  });

  it('compares every field', () => {
    const identity = createReplicaIdentity(parts);
    expect(sameReplicaIdentity(identity, createReplicaIdentity(parts))).toBe(true);
    expect(sameReplicaIdentity(identity, createReplicaIdentity({ ...parts, sequence: 8 })))
      .toBe(false);
    expect(sameReplicaIdentity(identity, createReplicaIdentity({ ...parts, frameId: 1 })))
      .toBe(false);
  });
});
