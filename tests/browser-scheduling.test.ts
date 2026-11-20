import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LIVE_PASS_SHARE,
  createPassShareLedger,
  PASS_HELD_RECHECK_MS,
  PASS_HOLD_LIMIT_MS,
  receiverSafeAnimationFrameCanceller,
  receiverSafeAnimationFrameScheduler,
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
  startBestEffortBackgroundTasks,
  type AnimationFrameCanceller,
  type AnimationFrameScheduler,
  type TimeoutCanceller,
  type TimeoutScheduler,
} from '../lib/browser-scheduling';

afterEach(() => vi.unstubAllGlobals());

describe('receiver-safe browser scheduling', () => {
  it('invokes native defaults with globalThis even when the adapter is a field call', () => {
    const callback = vi.fn();
    const setTimer = vi.fn(function (
      this: unknown,
      _callback: () => void,
      _milliseconds?: number,
    ) {
      expect(this).toBe(globalThis);
      return 17;
    });
    const clearTimer = vi.fn(function (this: unknown, _handle: number) {
      expect(this).toBe(globalThis);
    });
    const scheduleFrame = vi.fn(function (
      this: unknown,
      _callback: () => void,
    ) {
      expect(this).toBe(globalThis);
      return 23;
    });
    const cancelFrame = vi.fn(function (this: unknown, _handle: number) {
      expect(this).toBe(globalThis);
    });
    vi.stubGlobal('setTimeout', setTimer);
    vi.stubGlobal('clearTimeout', clearTimer);
    vi.stubGlobal('requestAnimationFrame', scheduleFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);

    const schedulingField = receiverSafeTimeoutScheduler();
    const cancellationField = receiverSafeTimeoutCanceller();
    const frameField = receiverSafeAnimationFrameScheduler();
    const frameCancellationField = receiverSafeAnimationFrameCanceller();

    expect(Reflect.apply(schedulingField, { wrong: true }, [callback, 50]))
      .toBe(17);
    Reflect.apply(cancellationField, { wrong: true }, [17]);
    expect(Reflect.apply(frameField, { wrong: true }, [callback])).toBe(23);
    Reflect.apply(frameCancellationField, { wrong: true }, [23]);

    expect(setTimer).toHaveBeenCalledWith(callback, 50);
    expect(clearTimer).toHaveBeenCalledWith(17);
    expect(scheduleFrame).toHaveBeenCalledWith(callback);
    expect(cancelFrame).toHaveBeenCalledWith(23);
  });

  it('keeps injected scheduler callbacks receiver-free', () => {
    const receivers: unknown[] = [];
    const setTimer: TimeoutScheduler = function (
      this: unknown,
      _callback,
      _milliseconds,
    ) {
      receivers.push(this);
      return 31 as unknown as ReturnType<typeof setTimeout>;
    };
    const clearTimer: TimeoutCanceller = function (this: unknown, _handle) {
      receivers.push(this);
    };
    const scheduleFrame: AnimationFrameScheduler = function (
      this: unknown,
      _callback,
    ) {
      receivers.push(this);
      return 37;
    };
    const cancelFrame: AnimationFrameCanceller = function (
      this: unknown,
      _handle,
    ) {
      receivers.push(this);
    };

    Reflect.apply(receiverSafeTimeoutScheduler(setTimer), {}, [() => {}, 1]);
    Reflect.apply(receiverSafeTimeoutCanceller(clearTimer), {}, [31]);
    Reflect.apply(receiverSafeAnimationFrameScheduler(scheduleFrame), {}, [
      () => {},
    ]);
    Reflect.apply(receiverSafeAnimationFrameCanceller(cancelFrame), {}, [37]);

    expect(receivers).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('best-effort background startup work', () => {
  it('yields the primary turn and settles independent failures', async () => {
    const order: string[] = [];
    startBestEffortBackgroundTasks([
      async () => {
        order.push('first');
        throw new Error('optional failure');
      },
      async () => {
        order.push('second');
      },
    ]);
    order.push('primary');

    expect(order).toEqual(['primary']);
    await Promise.resolve();
    expect(order).toEqual(['primary', 'first', 'second']);
  });
});

describe('share ledger of the live passes (D164)', () => {
  it('lets the first pass run at once and the next after four times its busy time', () => {
    let time = 1_000;
    const ledger = createPassShareLedger({ now: () => time });
    expect(LIVE_PASS_SHARE).toBe(5);
    expect(ledger.waitMs()).toBe(0);

    // A pass kept the tab busy 30 ms (its slices' work, not its wall time).
    time = 1_200;
    ledger.note(30);
    expect(ledger.notBefore).toBe(1_320);
    expect(ledger.waitMs()).toBe(120);
    time = 1_300;
    expect(ledger.waitMs()).toBe(20);
    time = 1_320;
    expect(ledger.waitMs()).toBe(0);
    // A pass that asks after notBefore runs at once.
    time = 5_000;
    expect(ledger.waitMs()).toBe(0);
  });

  it('is one ledger for both passes: either one waits for the other', () => {
    let time = 0;
    const ledger = createPassShareLedger({ now: () => time });
    // The scan ends at 100 after 10 ms of work.
    time = 100;
    ledger.note(10);
    expect(ledger.notBefore).toBe(140);
    // The comparison ran beside it (it had started before) and ends at 120
    // after 20 ms: its rest comes on top of the scan's.
    time = 120;
    ledger.note(20);
    expect(ledger.notBefore).toBe(220);
    // A pass that ended after the rest was over rests from its own end.
    time = 500;
    ledger.note(5);
    expect(ledger.notBefore).toBe(520);
  });

  it('ignores a pass that took no time, and takes another share when asked', () => {
    let time = 10;
    const ledger = createPassShareLedger({ now: () => time, share: 2 });
    ledger.note(0);
    ledger.note(Number.NaN);
    expect(ledger.waitMs()).toBe(0);
    ledger.note(7);
    expect(ledger.notBefore).toBe(17);
    time = 12;
    expect(ledger.waitMs()).toBe(5);
  });

  it('lets one pass run at a time: the other asks again while it holds the page', () => {
    let time = 0;
    const ledger = createPassShareLedger({ now: () => time });
    const scan = {};
    const comparison = {};
    ledger.begin(scan);
    // The scan holds the page: the comparison waits, the scan itself does not.
    expect(ledger.waitMs(comparison)).toBe(PASS_HELD_RECHECK_MS);
    expect(ledger.waitMs(comparison, true)).toBe(PASS_HELD_RECHECK_MS);
    expect(ledger.waitMs(scan)).toBe(0);
    // Its end frees the page and starts its rest.
    time = 40;
    ledger.note(10, scan);
    expect(ledger.waitMs(comparison)).toBe(40);
    // A first scan waits for a pass that holds the page, not for the rest.
    expect(ledger.waitMs(scan, true)).toBe(0);
    // A cancelled pass frees the page with no rest of its own.
    ledger.begin(comparison);
    expect(ledger.waitMs(scan, true)).toBe(PASS_HELD_RECHECK_MS);
    ledger.release(comparison);
    expect(ledger.waitMs(scan, true)).toBe(0);
    // Only the holder frees the page.
    ledger.begin(comparison);
    ledger.release(scan);
    ledger.note(5, scan);
    expect(ledger.waitMs(scan, true)).toBe(PASS_HELD_RECHECK_MS);
  });

  it('stops honouring a hold that was never released', () => {
    let time = 0;
    const ledger = createPassShareLedger({ now: () => time });
    ledger.begin({});
    time = PASS_HOLD_LIMIT_MS;
    expect(ledger.waitMs({}, true)).toBe(PASS_HELD_RECHECK_MS);
    time = PASS_HOLD_LIMIT_MS + 1;
    expect(ledger.waitMs({}, true)).toBe(0);
  });

  it('keeps the hold of a long pass that touches it at every slice', () => {
    let time = 0;
    const ledger = createPassShareLedger({ now: () => time });
    const scan = {};
    const comparison = {};
    ledger.begin(scan);
    // Slices with turns between them, longer in all than the limit.
    for (let slice = 1; slice <= 4; slice += 1) {
      time = slice * (PASS_HOLD_LIMIT_MS - 1);
      ledger.touch(scan);
      expect(ledger.waitMs(comparison), `slice ${slice}`).toBe(PASS_HELD_RECHECK_MS);
    }
    // Another owner's touch does not take or keep the page.
    ledger.touch(comparison);
    time += PASS_HOLD_LIMIT_MS + 1;
    ledger.touch(comparison);
    expect(ledger.waitMs(comparison, true)).toBe(0);
    // Once lost, a touch does not take the hold back.
    ledger.touch(scan);
    expect(ledger.waitMs(comparison, true)).toBe(0);
  });

  it('notes the work of a pass cancelled after it did some', () => {
    let time = 0;
    const ledger = createPassShareLedger({ now: () => time });
    const comparison = {};
    ledger.begin(comparison);
    time = 50;
    // Cancelled after 12 ms of work: the hold ends and the rest is paid.
    ledger.note(12, comparison);
    expect(ledger.waitMs({})).toBe(48);
  });
});
