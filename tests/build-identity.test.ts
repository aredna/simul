import { describe, expect, it } from 'vitest';

import {
  createExtensionBuildIdentity,
  renderExtensionBuildIdentity,
} from '../lib/build-identity';

describe('extension build identity', () => {
  it('renders and logs the exact runtime manifest version', () => {
    const identity = createExtensionBuildIdentity({ version: '0.2.0' });
    const target: Pick<HTMLElement, 'textContent'> = { textContent: '' };

    renderExtensionBuildIdentity(target, identity);

    expect(identity).toEqual({
      version: '0.2.0',
      label: 'Build 0.2.0',
      companionReadyMessage: '[Simul] Companion ready. Build 0.2.0.',
      backgroundReadyMessage:
        '[Simul] Background service worker ready. Build 0.2.0.',
    });
    expect(target.textContent).toBe('Build 0.2.0');
  });
});
