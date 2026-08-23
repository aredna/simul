import { describe, expect, it } from 'vitest';

import { DEFAULT_COMPANION_PREFERENCES } from '../lib/preferences';
import { ViewPreferencePatchLedger } from '../lib/view-preference-ledger';

describe('ViewPreferencePatchLedger', () => {
  it('applies a view patch immediately', () => {
    const ledger = new ViewPreferencePatchLedger();

    const pending = ledger.begin(DEFAULT_COMPANION_PREFERENCES, {
      displayMode: 'custom',
      zoomPercent: 175,
    });

    expect(pending.expectedResetRevision).toBe(0);
    expect(pending.preferences).toMatchObject({
      displayMode: 'custom',
      zoomPercent: 175,
    });
  });

  it('replays newer pending choices over an older committed response', () => {
    const ledger = new ViewPreferencePatchLedger();
    const first = ledger.begin(DEFAULT_COMPANION_PREFERENCES, {
      zoomPercent: 125,
    });
    const second = ledger.begin(first.preferences, { zoomPercent: 150 });
    ledger.settle(first.requestId);

    expect(ledger.project({
      ...DEFAULT_COMPANION_PREFERENCES,
      zoomPercent: 125,
      settingsRevision: 1,
    })).toMatchObject({
      zoomPercent: 150,
      settingsRevision: 1,
    });

    ledger.settle(second.requestId);
    expect(ledger.project({
      ...DEFAULT_COMPANION_PREFERENCES,
      zoomPercent: 150,
      settingsRevision: 2,
    }).zoomPercent).toBe(150);
  });

  it('does not replay obsolete patches after a reset boundary', () => {
    const ledger = new ViewPreferencePatchLedger();
    ledger.begin(DEFAULT_COMPANION_PREFERENCES, { syncScroll: false });

    const reset = {
      ...DEFAULT_COMPANION_PREFERENCES,
      resetRevision: 1,
      settingsRevision: 1,
    };

    expect(ledger.project(reset)).toEqual(reset);
  });
});
