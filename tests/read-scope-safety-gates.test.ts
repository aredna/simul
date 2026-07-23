import { describe, expect, it } from 'vitest';

import { RemoteReadScopeSafetyGates } from '../lib/replica/read-scope-safety-gates';
import { replicaReadScopeForProfile } from '../lib/replica/read-scope-policy';

describe('RemoteReadScopeSafetyGates', () => {
  it('requires both a committed release and a satisfying preference snapshot', () => {
    const gates = new RemoteReadScopeSafetyGates();
    const pageOnly = replicaReadScopeForProfile('page-only');
    const full = replicaReadScopeForProfile('full-visible');

    expect(gates.prepare('reset-1', pageOnly)).toBe(true);
    expect(gates.releaseSatisfied(pageOnly)).toBe(0);
    expect(gates.scopes()).toEqual([pageOnly]);

    expect(gates.authorizeCommittedRelease('reset-1')).toBe(true);
    expect(gates.releaseSatisfied(full)).toBe(0);
    expect(gates.scopes()).toEqual([pageOnly]);

    expect(gates.releaseSatisfied(pageOnly)).toBe(1);
    expect(gates.scopes()).toEqual([]);
  });

  it('revokes an old release authorization when a ceiling is replayed', () => {
    const gates = new RemoteReadScopeSafetyGates();
    const standard = replicaReadScopeForProfile('standard');

    gates.prepare('narrow-1', standard);
    gates.authorizeCommittedRelease('narrow-1');
    gates.prepare('narrow-1', standard);

    expect(gates.releaseSatisfied(standard)).toBe(0);
    expect(gates.scopes()).toEqual([standard]);
    expect(gates.authorizeCommittedRelease('unknown')).toBe(false);
  });
});
