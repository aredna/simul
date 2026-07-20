export interface ExtensionBuildIdentity {
  readonly version: string;
  readonly label: string;
  readonly companionReadyMessage: string;
  readonly backgroundReadyMessage: string;
}

export function createExtensionBuildIdentity(
  manifest: Readonly<{ version: string }>,
): ExtensionBuildIdentity {
  const version = manifest.version;
  const label = `Build ${version}`;
  return Object.freeze({
    version,
    label,
    companionReadyMessage: `[Simul] Companion ready. ${label}.`,
    backgroundReadyMessage:
      `[Simul] Background service worker ready. ${label}.`,
  });
}

export function renderExtensionBuildIdentity(
  target: Pick<HTMLElement, 'textContent'>,
  identity: ExtensionBuildIdentity,
): void {
  target.textContent = identity.label;
}
