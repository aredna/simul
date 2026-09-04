import { describe, expect, it } from 'vitest';

import {
  createExtensionBuildIdentity,
  renderExtensionBuildIdentity,
} from '../lib/build-identity';

describe('extension build identity', () => {
  it('renders and logs the trimmed runtime manifest version name', () => {
    const identity = createExtensionBuildIdentity({
      version: '0.4.0',
      version_name: ' 0.4.0 beta v.20260904.1 ',
    });
    const target: Pick<HTMLElement, 'textContent'> = { textContent: '' };

    renderExtensionBuildIdentity(target, identity);

    expect(identity).toEqual({
      version: '0.4.0',
      label: 'Build 0.4.0 beta v.20260904.1',
      companionReadyMessage:
        '[Simul] Companion ready. Build 0.4.0 beta v.20260904.1.',
      backgroundReadyMessage:
        '[Simul] Background service worker ready. Build 0.4.0 beta v.20260904.1.',
    });
    expect(target.textContent).toBe('Build 0.4.0 beta v.20260904.1');
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
