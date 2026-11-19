import { SIMUL_EDITION, type SimulEdition } from './edition';

export interface ExtensionBuildIdentity {
  readonly version: string;
  readonly label: string;
  readonly companionReadyMessage: string;
  readonly backgroundReadyMessage: string;
}

export function createExtensionBuildIdentity(
  manifest: Readonly<{ version: string; version_name?: string }>,
): ExtensionBuildIdentity {
  const version = manifest.version;
  const versionName = manifest.version_name?.trim();
  const label = `Build ${versionName || version}`;
  return Object.freeze({
    version,
    label,
    companionReadyMessage: `[Simul] Companion ready. ${label}.`,
    backgroundReadyMessage:
      `[Simul] Background service worker ready. ${label}.`,
  });
}

/**
 * What the options header shows: the plain version in the public edition
 * ("0.6.5"), the full build identity in the dev edition.
 */
export function extensionBuildHeaderText(
  identity: ExtensionBuildIdentity,
  edition: SimulEdition,
): string {
  return edition === 'public' ? identity.version : identity.label;
}

export function renderExtensionBuildIdentity(
  target: Pick<HTMLElement, 'textContent'>,
  identity: ExtensionBuildIdentity,
  edition: SimulEdition = SIMUL_EDITION,
): void {
  target.textContent = extensionBuildHeaderText(identity, edition);
}
