import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndexedDbTransientImageStore } from '../lib/ocr/transient-image-store';

describe('IndexedDbTransientImageStore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries after a transient database-open failure', async () => {
    let openAttempts = 0;
    const database = fakeDatabase();
    vi.stubGlobal('indexedDB', {
      open: () => {
        openAttempts += 1;
        const request = {
          result: database,
          error: new Error('temporary failure'),
        } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => {
          if (openAttempts === 1) request.onerror?.(new Event('error'));
          else request.onsuccess?.(new Event('success'));
        });
        return request;
      },
    });

    const store = new IndexedDbTransientImageStore();
    await expect(store.clearAll()).rejects.toThrow('temporary failure');
    await expect(store.clearAll()).resolves.toBeUndefined();
    expect(openAttempts).toBe(2);
  });
});

function fakeDatabase(): IDBDatabase {
  const objectStore = { clear: () => ({}) } as unknown as IDBObjectStore;
  return {
    transaction: () => {
      const transaction = {
        objectStore: () => objectStore,
      } as unknown as IDBTransaction;
      queueMicrotask(() => transaction.oncomplete?.(new Event('complete')));
      return transaction;
    },
  } as unknown as IDBDatabase;
}
