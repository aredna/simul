import { describe, expect, it } from 'vitest';

import { computeReplicaDisclosurePlacement } from
  '../lib/replica/read-only-disclosure';

describe('read-only replica disclosure placement', () => {
  it('keeps a popup below its anchor when the viewport has room', () => {
    expect(computeReplicaDisclosurePlacement({
      anchor: {
        bottom: 140,
        height: 40,
        left: 120,
        right: 320,
        top: 100,
        width: 200,
      },
      panelHeight: 240,
      panelWidth: 260,
      viewportHeight: 700,
      viewportWidth: 900,
    })).toMatchObject({
      left: 120,
      placement: 'below',
      top: 144,
      minWidth: 200,
      maxHeight: 548,
    });
  });

  it('flips above and clamps an oversized popup inside the viewport', () => {
    const placement = computeReplicaDisclosurePlacement({
      anchor: {
        bottom: 590,
        height: 30,
        left: 760,
        right: 920,
        top: 560,
        width: 160,
      },
      panelHeight: 900,
      panelWidth: 600,
      viewportHeight: 620,
      viewportWidth: 800,
    });

    expect(placement.placement).toBe('above');
    expect(placement.left).toBe(192);
    expect(placement.top).toBe(8);
    expect(placement.maxHeight).toBe(548);
    expect(placement.maxWidth).toBe(784);
    expect(placement.minWidth).toBe(160);
  });
});
