import { describe, expect, it } from 'vitest';

import { emptyReplicaDiagnostics } from '../lib/replica/contracts';
import {
  isCommittedShadowReplica,
  LegacyTransitionGate,
} from '../lib/replica/legacy-transition-gate';

describe('legacy transition gate', () => {
  it('coalesces any live-preview dirtiness into one fresh legacy capture', () => {
    const gate = new LegacyTransitionGate();
    gate.beginShadowOwnership();

    expect(gate.markDirty()).toBe(true);
    expect(gate.markDirty()).toBe(true);

    expect(gate.release()).toBe(true);
    expect(gate.shadowOwnsPage).toBe(false);
    expect(gate.release()).toBe(false);
  });

  it('can reset a stale document without requesting legacy work', () => {
    const gate = new LegacyTransitionGate();
    gate.beginShadowOwnership();
    gate.markDirty();

    gate.reset();

    expect(gate.release()).toBe(false);
  });

  it('covers hidden staging and ignores dirtiness after legacy takes ownership', () => {
    const gate = new LegacyTransitionGate();

    gate.beginShadowOwnership();
    expect(gate.shadowOwnsPage).toBe(true);
    expect(gate.markDirty()).toBe(true);
    expect(gate.release()).toBe(true);
    expect(gate.markDirty()).toBe(false);
    expect(gate.release()).toBe(false);
  });

  it('recognizes only a completed rrweb result with a retained committed lease', () => {
    const legacyComplete = {
      status: 'complete' as const,
      diagnostics: emptyReplicaDiagnostics('legacy-v1', 'legacy_selected'),
    };
    const rrwebComplete = {
      status: 'complete' as const,
      diagnostics: emptyReplicaDiagnostics('rrweb-shadow-v2', 'shadow_complete'),
    };

    expect(isCommittedShadowReplica(legacyComplete, true)).toBe(false);
    expect(isCommittedShadowReplica(rrwebComplete, false)).toBe(false);
    expect(isCommittedShadowReplica(rrwebComplete, true)).toBe(true);
  });
});
