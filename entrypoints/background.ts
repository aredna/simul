import {
  PREFERENCE_LOCK_NAME,
  PreferenceCoordinator,
  createBrowserPreferenceAdapter,
  readPreferenceCommand,
  type PreferenceCommand,
  type PreferenceCommandResult,
} from '../lib/preference-coordinator';

export default defineBackground(() => {
  console.info('[Simul] Background service worker ready.');

  const coordinator = new PreferenceCoordinator(
    createBrowserPreferenceAdapter(),
  );

  browser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse) => {
      const command = readPreferenceCommand(message);
      if (!command) return;

      // Chrome 138 requires the callback + literal-true response pattern.
      // Native Promise-returning onMessage listeners arrived much later.
      void runPreferenceCommand(coordinator, command).then(
        (result) => sendResponse(result),
        (error: unknown) =>
          sendResponse({
            type: 'simul:preferences:error',
            message: readableError(error),
          }),
      );
      return true;
    },
  );

  browser.permissions.onRemoved.addListener(() => {
    void navigator.locks.request(
      PREFERENCE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (lock) {
          await coordinator.run({ type: 'simul:preferences:reconcile' });
        }
      },
    );
  });
});

function runPreferenceCommand(
  coordinator: PreferenceCoordinator,
  command: PreferenceCommand,
): Promise<PreferenceCommandResult> {
  if (command.type !== 'simul:preferences:reconcile') {
    return coordinator.run(command);
  }

  return navigator.locks.request(PREFERENCE_LOCK_NAME, () =>
    coordinator.run(command),
  );
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'The preference service could not complete the request.';
}
