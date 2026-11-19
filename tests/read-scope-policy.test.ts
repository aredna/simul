import { describe, expect, it } from 'vitest';

import {
  DEFAULT_REPLICA_READ_SCOPE,
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
  replicaReadScopeProfileWithin,
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

    const invalid = {
      ...replicaReadScopeForProfile('full-visible'),
      surprise: false,
    } as unknown as ReturnType<typeof replicaReadScopeForProfile>;
    expect(deriveReplicaReadScopeProfile(invalid)).toBe('page-only');
    expect(replicaReadScopeFingerprint(invalid)).toBe(
      replicaReadScopeFingerprint(PAGE_ONLY_REPLICA_READ_SCOPE),
    );
    expect(replicaReadScopeNarrows(
      invalid,
      PAGE_ONLY_REPLICA_READ_SCOPE,
    )).toBe(false);
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

  it('encodes every valid capability combination in canonical key order', () => {
    for (let mask = 0; mask < 64; mask += 1) {
      const scope = {
        controlSemantics: Boolean(mask & 32),
        controlImages: Boolean(mask & 16),
        disclosureContent: Boolean(mask & 8),
        formValues: Boolean(mask & 4),
        personalDataValues: Boolean(mask & 2),
        editableContent: Boolean(mask & 1),
      };
      const invalid = scope.personalDataValues && !scope.formValues;
      expect(readExactReplicaReadScope(scope) === undefined).toBe(invalid);
      expect(replicaReadScopeFingerprint(scope)).toBe(
        invalid
          ? 'read-v1-000000'
          : `read-v1-${(64 | mask).toString(2).slice(1)}`,
      );
    }
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

describe('public edition read scope', () => {
  it('picks the widest profile that reads nothing more than the scope', () => {
    const standard = replicaReadScopeForProfile('standard');
    const full = replicaReadScopeForProfile('full-visible');
    expect(replicaReadScopeProfileWithin(full)).toBe('full-visible');
    expect(replicaReadScopeProfileWithin(standard)).toBe('standard');
    expect(replicaReadScopeProfileWithin({ ...standard, formValues: true })).toBe('standard');
    expect(replicaReadScopeProfileWithin({ ...full, personalDataValues: false })).toBe('standard');
    expect(replicaReadScopeProfileWithin({ ...standard, controlImages: false })).toBe('page-only');
    expect(replicaReadScopeProfileWithin(PAGE_ONLY_REPLICA_READ_SCOPE)).toBe('page-only');
  });

  it('never reads more than the stored scope, and skips first-run setup', () => {
    const custom = {
      ...replicaReadScopeForProfile('standard'),
      disclosureContent: false,
      formValues: true,
    };
    const shown = effectiveReplicaReadScope(
      custom,
      REPLICA_READ_SCOPE_SETUP_VERSION,
      'public',
    );
    expect(shown).toEqual(PAGE_ONLY_REPLICA_READ_SCOPE);
    expect(replicaReadScopeNarrows(custom, shown)).toBe(true);
    expect(replicaReadScopeNarrows(shown, custom)).toBe(false);
    expect(effectiveReplicaReadScope(custom, 0, 'public')).toEqual(DEFAULT_REPLICA_READ_SCOPE);
    // The dev edition keeps the custom scope and its setup gate.
    expect(effectiveReplicaReadScope(custom, REPLICA_READ_SCOPE_SETUP_VERSION, 'dev'))
      .toEqual(custom);
    expect(effectiveReplicaReadScope(custom, 0, 'dev')).toEqual(PAGE_ONLY_REPLICA_READ_SCOPE);
  });
});
