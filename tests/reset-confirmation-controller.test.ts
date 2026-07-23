import { describe, expect, it, vi } from 'vitest';

import {
  installResetConfirmationController,
  type ResetConfirmationDialog,
  type ResetConfirmationTrigger,
} from '../lib/reset-confirmation-controller';

describe('reset confirmation controller', () => {
  it('cancels without resetting and returns focus after close', () => {
    const dialog = new FakeDialog();
    const trigger = new FakeTrigger();
    const onConfirm = vi.fn();
    installResetConfirmationController({
      dialog,
      trigger,
      shouldBypassConfirmation: () => false,
      onConfirm,
    });

    trigger.click();
    expect(dialog.showModalCalls).toBe(1);
    dialog.returnValue = 'reset';
    dialog.cancel();
    dialog.close();

    expect(onConfirm).not.toHaveBeenCalled();
    expect(trigger.focusCalls).toBe(1);
  });

  it('confirms exactly once even if a duplicate close follows', async () => {
    const dialog = new FakeDialog();
    const trigger = new FakeTrigger();
    const onConfirm = vi.fn(async () => undefined);
    installResetConfirmationController({
      dialog,
      trigger,
      shouldBypassConfirmation: () => false,
      onConfirm,
    });

    trigger.click();
    dialog.returnValue = 'reset';
    dialog.close();
    dialog.close();
    await Promise.resolve();

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(trigger.focusCalls).toBe(2);
  });

  it('retries pending cleanup directly without opening the dialog', async () => {
    const dialog = new FakeDialog();
    const trigger = new FakeTrigger();
    const onConfirm = vi.fn(async () => undefined);
    installResetConfirmationController({
      dialog,
      trigger,
      shouldBypassConfirmation: () => true,
      onConfirm,
    });

    trigger.click();
    await Promise.resolve();

    expect(dialog.showModalCalls).toBe(0);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

class FakeDialog implements ResetConfirmationDialog {
  open = false;
  returnValue = '';
  showModalCalls = 0;
  readonly #listeners = new Map<string, Set<() => void>>();

  showModal(): void {
    this.showModalCalls += 1;
    this.open = true;
  }

  addEventListener(type: 'cancel' | 'close', listener: () => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: 'cancel' | 'close', listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  cancel(): void {
    for (const listener of this.#listeners.get('cancel') ?? []) listener();
  }

  close(): void {
    this.open = false;
    for (const listener of this.#listeners.get('close') ?? []) listener();
  }
}

class FakeTrigger implements ResetConfirmationTrigger {
  focusCalls = 0;
  readonly #listeners = new Set<() => void>();

  addEventListener(_type: 'click', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'click', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  focus(): void {
    this.focusCalls += 1;
  }

  click(): void {
    for (const listener of this.#listeners) listener();
  }
}
