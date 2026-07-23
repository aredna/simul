import { describe, expect, it } from 'vitest';

import {
  PAGE_ONLY_REPLICA_READ_SCOPE,
  REPLICA_READ_SCOPE_SETUP_VERSION,
  deriveReplicaReadScopeProfile,
  effectiveReplicaReadScope,
  intersectReplicaReadScopes,
  readExactReplicaReadScope,
  repairReplicaReadScope,
  replicaReadScopeFingerprint,
  replicaReadScopeForProfile,
  replicaReadScopeNarrows,
} from '../lib/replica/read-scope-policy';

describe('replica read scope policy', () => {
  it('uses exact fail-closed six-toggle objects', () => {
    expect(repairReplicaReadScope({ controlSemantics: true })).toEqual(
      PAGE_ONLY_REPLICA_READ_SCOPE,
    );
    expect(readExactReplicaReadScope({
      controlSemantics: true,
      controlImages: true,
      disclosureContent: true,
      formValues: false,
      personalDataValues: true,
      editableContent: false,
    })).toBeUndefined();
    expect(readExactReplicaReadScope({
      ...replicaReadScopeForProfile('standard'),
      surprise: false,
    })).toBeUndefined();
  });

  it('derives presets and custom state from capabilities', () => {
    expect(deriveReplicaReadScopeProfile(
      replicaReadScopeForProfile('page-only'),
    )).toBe('page-only');
    expect(deriveReplicaReadScopeProfile(
      replicaReadScopeForProfile('standard'),
    )).toBe('standard');
    expect(deriveReplicaReadScopeProfile(
      replicaReadScopeForProfile('full-visible'),
    )).toBe('full-visible');
    expect(deriveReplicaReadScopeProfile({
      ...replicaReadScopeForProfile('standard'),
      editableContent: true,
    })).toBe('custom');
  });

  it('enforces setup and computes safe narrowing intersections', () => {
    const broad = replicaReadScopeForProfile('full-visible');
    const narrow = replicaReadScopeForProfile('standard');
    expect(effectiveReplicaReadScope(broad, 0)).toEqual(
      PAGE_ONLY_REPLICA_READ_SCOPE,
    );
    expect(effectiveReplicaReadScope(
      broad,
      REPLICA_READ_SCOPE_SETUP_VERSION,
    )).toEqual(broad);
    expect(replicaReadScopeNarrows(broad, narrow)).toBe(true);
    expect(intersectReplicaReadScopes(broad, narrow)).toEqual(narrow);
    expect(replicaReadScopeFingerprint(narrow)).toMatch(/^read-v1-[01]{6}$/u);
  });
});
