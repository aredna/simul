import { describe, expect, it, vi } from 'vitest';
import {
  manifestHostPermissions,
  removableHostOrigins,
  removeRemovableHostOrigins,
} from '../lib/required-host-permissions';

describe('required host permissions (D166)', () => {
  it('removes nothing that every site the manifest requires covers', () => {
    expect(removableHostOrigins(['<all_urls>'], ['<all_urls>'])).toEqual([]);
    expect(removableHostOrigins(
      ['https://example.com/*', 'http://example.com/*'],
      ['<all_urls>'],
    )).toEqual([]);
  });

  it('removes what the manifest does not require', () => {
    expect(removableHostOrigins(['https://example.com/*'], [])).toEqual([
      'https://example.com/*',
    ]);
    expect(removableHostOrigins(['https://example.com/*'], undefined)).toEqual([
      'https://example.com/*',
    ]);
    expect(removableHostOrigins(
      ['https://a.example/*', 'https://b.example/*'],
      ['https://a.example/*'],
    )).toEqual(['https://b.example/*']);
  });

  it('counts nothing to remove as done, without asking Chrome', async () => {
    const remove = vi.fn(async () => false);
    await expect(removeRemovableHostOrigins(['<all_urls>'], ['<all_urls>'], remove))
      .resolves.toBe(true);
    expect(remove).not.toHaveBeenCalled();
    await expect(removeRemovableHostOrigins(['https://example.com/*'], [], remove))
      .resolves.toBe(false);
    expect(remove).toHaveBeenCalledWith(['https://example.com/*']);
  });

  it('reads the manifest host permissions, and none from a manifest it cannot read', () => {
    expect(manifestHostPermissions(() => ({ host_permissions: ['<all_urls>'] })))
      .toEqual(['<all_urls>']);
    expect(manifestHostPermissions(() => ({}))).toEqual([]);
    expect(manifestHostPermissions(() => {
      throw new Error('no runtime');
    })).toEqual([]);
  });
});
