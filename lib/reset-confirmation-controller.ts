export interface ResetConfirmationDialog {
  readonly open: boolean;
  returnValue: string;
  showModal(): void;
  addEventListener(type: 'cancel' | 'close', listener: () => void): void;
  removeEventListener(type: 'cancel' | 'close', listener: () => void): void;
}

export interface ResetConfirmationTrigger {
  addEventListener(type: 'click', listener: () => void): void;
  removeEventListener(type: 'click', listener: () => void): void;
  focus(): void;
}

export interface ResetConfirmationControllerOptions {
  readonly dialog: ResetConfirmationDialog;
  readonly trigger: ResetConfirmationTrigger;
  readonly shouldBypassConfirmation: () => boolean;
  readonly confirmValue?: string;
  readonly onConfirm: () => void | Promise<void>;
}

/** Owns a content-free, in-panel reset confirmation lifecycle. */
export function installResetConfirmationController(
  options: ResetConfirmationControllerOptions,
): () => void {
  const confirmValue = options.confirmValue ?? 'reset';
  let disposed = false;
  let confirmationInFlight = false;

  const run = (): void => {
    confirmationInFlight = true;
    void Promise.resolve()
      .then(() => options.onConfirm())
      .catch(() => undefined)
      .finally(() => {
        confirmationInFlight = false;
      });
  };
  const request = (): void => {
    if (disposed || confirmationInFlight) return;
    // A retry resumes cleanup for an already-committed reset.
    if (options.shouldBypassConfirmation()) {
      run();
      return;
    }
    if (options.dialog.open) return;
    options.dialog.returnValue = '';
    options.dialog.showModal();
  };
  const cancel = (): void => {
    options.dialog.returnValue = '';
  };
  const close = (): void => {
    const confirmed = options.dialog.returnValue === confirmValue;
    options.dialog.returnValue = '';
    options.trigger.focus();
    if (confirmed && !disposed && !confirmationInFlight) run();
  };

  options.trigger.addEventListener('click', request);
  options.dialog.addEventListener('cancel', cancel);
  options.dialog.addEventListener('close', close);
  return () => {
    disposed = true;
    options.trigger.removeEventListener('click', request);
    options.dialog.removeEventListener('cancel', cancel);
    options.dialog.removeEventListener('close', close);
  };
}
