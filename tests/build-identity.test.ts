import { describe, expect, it } from 'vitest';

import {
  createExtensionBuildIdentity,
  extensionBuildHeaderText,
  renderExtensionBuildIdentity,
} from '../lib/build-identity';

describe('extension build identity', () => {
  it('renders and logs the trimmed runtime manifest version name', () => {
    const identity = createExtensionBuildIdentity({
      version: '0.7.0',
      version_name: ' 0.7.0 beta ',
    });
    const target: Pick<HTMLElement, 'textContent'> = { textContent: '' };

    renderExtensionBuildIdentity(target, identity);

    expect(identity).toEqual({
      version: '0.7.0',
      versionName: '0.7.0 beta',
      label: 'Build 0.7.0 beta',
      companionReadyMessage:
        '[Simul] Companion ready. Build 0.7.0 beta.',
      backgroundReadyMessage:
        '[Simul] Background service worker ready. Build 0.7.0 beta.',
    });
    expect(target.textContent).toBe('Build 0.7.0 beta');
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
      versionName: '0.2.1',
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
  it('shows the version with its beta mark in the public edition and the build in the dev one (D249)', () => {
    const publicIdentity = createExtensionBuildIdentity({
      version: '0.7.0',
      version_name: '0.7.0 beta',
    });
    const devIdentity = createExtensionBuildIdentity({
      version: '0.7.0',
      version_name: '0.7.0 beta dev',
    });
    const target: Pick<HTMLElement, 'textContent'> = { textContent: '' };

    expect(extensionBuildHeaderText(publicIdentity, 'public')).toBe('0.7.0 beta');
    expect(extensionBuildHeaderText(devIdentity, 'dev'))
      .toBe('Build 0.7.0 beta dev');
    renderExtensionBuildIdentity(target, publicIdentity, 'public');
    expect(target.textContent).toBe('0.7.0 beta');
    // A manifest with no version_name shows the version.
    expect(extensionBuildHeaderText(createExtensionBuildIdentity({ version: '0.7.0' }), 'public'))
      .toBe('0.7.0');
    // The console line keeps the full identity in both editions.
    expect(publicIdentity.companionReadyMessage)
      .toBe('[Simul] Companion ready. Build 0.7.0 beta.');
  });
});
