import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  receiverSafeAnimationFrameCanceller,
  receiverSafeAnimationFrameScheduler,
  receiverSafeTimeoutCanceller,
  receiverSafeTimeoutScheduler,
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
