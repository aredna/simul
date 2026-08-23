import { describe, expect, it } from 'vitest';

import { StableSignatureTracker } from
  '../lib/replica/stable-signature-tracker';

describe('StableSignatureTracker', () => {
  it('promotes a changed signature only after enough observations', () => {
    const owner = {};
    const tracker = new StableSignatureTracker(3);
    tracker.prime(owner, 'initial');

    expect(tracker.observe(owner, 'changed')).toBe(false);
    expect(tracker.observe(owner, 'changed')).toBe(false);
    expect(tracker.observe(owner, 'changed')).toBe(true);
    expect(tracker.observe(owner, 'changed')).toBe(false);
  });

  it('drops transient and superseded candidates', () => {
    const owner = {};
    const tracker = new StableSignatureTracker(2);
    tracker.prime(owner, 'initial');

    expect(tracker.observe(owner, 'transient')).toBe(false);
    expect(tracker.observe(owner, 'initial')).toBe(false);
    expect(tracker.observe(owner, 'transient')).toBe(false);
    expect(tracker.observe(owner, 'replacement')).toBe(false);
    expect(tracker.observe(owner, 'replacement')).toBe(true);
  });

  it('primes unknown owners and forgets state after reset', () => {
    const owner = {};
    const tracker = new StableSignatureTracker(1);

    expect(tracker.observe(owner, 'first')).toBe(false);
    expect(tracker.observe(owner, 'second')).toBe(true);
    tracker.reset();
    expect(tracker.observe(owner, 'third')).toBe(false);
  });

  it('rejects invalid observation thresholds', () => {
    expect(() => new StableSignatureTracker(0)).toThrow(
      'positive integer',
    );
  });
});
