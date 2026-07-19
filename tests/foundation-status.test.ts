import { describe, expect, it } from 'vitest';

import { createFoundationStatus } from '../lib/foundation-status';

describe('createFoundationStatus', () => {
  it('formats a project-ready message', () => {
    expect(createFoundationStatus(' Simul ')).toBe(
      'Simul is ready for product discovery.',
    );
  });

  it('rejects an empty project name', () => {
    expect(() => createFoundationStatus('  ')).toThrow(
      'Project name is required.',
    );
  });
});
