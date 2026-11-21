import { describe, expect, it } from 'vitest';

import {
  createExtensionBuildIdentity,
  extensionBuildHeaderText,
  renderExtensionBuildIdentity,
} from '../lib/build-identity';

describe('extension build identity', () => {
  it('renders and logs the trimmed runtime manifest version name', () => {
    const identity = createExtensionBuildIdentity({
      version: '0.6.7',
      version_name: ' 0.6.7 beta v.20261121.3 ',
    });
    const target: Pick<HTMLElement, 'textContent'> = { textContent: '' };

    renderExtensionBuildIdentity(target, identity);

    expect(identity).toEqual({
      version: '0.6.7',
      label: 'Build 0.6.7 beta v.20261121.3',
      companionReadyMessage:
        '[Simul] Companion ready. Build 0.6.7 beta v.20261121.3.',
      backgroundReadyMessage:
        '[Simul] Background service worker ready. Build 0.6.7 beta v.20261121.3.',
    });
    expect(target.textContent).toBe('Build 0.6.7 beta v.20261121.3');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('falls back to the numeric version for a %s version name', (_case, versionName) => {
    const identity = createExtensionBuildIdentity({ version: '0.2.1' });
    const identityWithVersionName = createExtensionBuildIdentity({
      version: '0.2.1',
      version_name: versionName,
    });
    const target: Pick<HTMLElement, 'textContent'> = { textContent: '' };

    renderExtensionBuildIdentity(target, identityWithVersionName);

    expect(identityWithVersionName).toEqual({
      version: '0.2.1',
      label: 'Build 0.2.1',
      companionReadyMessage: '[Simul] Companion ready. Build 0.2.1.',
      backgroundReadyMessage:
        '[Simul] Background service worker ready. Build 0.2.1.',
    });
    expect(target.textContent).toBe('Build 0.2.1');
    expect(identityWithVersionName).toEqual(identity);
  });
});

describe('options header build text', () => {
  it('shows the plain version in the public edition and the build in the dev one', () => {
    const publicIdentity = createExtensionBuildIdentity({
      version: '0.6.7',
      version_name: '0.6.7 beta v.20261121.3',
    });
    const devIdentity = createExtensionBuildIdentity({
      version: '0.6.7',
      version_name: '0.6.7 beta v.20261121.3 dev',
    });
    const target: Pick<HTMLElement, 'textContent'> = { textContent: '' };

    expect(extensionBuildHeaderText(publicIdentity, 'public')).toBe('0.6.7');
    expect(extensionBuildHeaderText(devIdentity, 'dev'))
      .toBe('Build 0.6.7 beta v.20261121.3 dev');
    renderExtensionBuildIdentity(target, publicIdentity, 'public');
    expect(target.textContent).toBe('0.6.7');
    // The console line keeps the full identity in both editions.
    expect(publicIdentity.companionReadyMessage)
      .toBe('[Simul] Companion ready. Build 0.6.7 beta v.20261121.3.');
  });
});
