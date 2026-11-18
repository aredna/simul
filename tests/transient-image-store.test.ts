import { afterEach, describe, expect, it, vi } from 'vitest';

import { OffscreenComputeHost } from '../lib/ocr/offscreen-host';
import {
  IndexedDbTransientImageStore,
  MAX_TRANSIENT_IMAGE_BYTES,
  TRANSIENT_IMAGE_DATABASE,
  TRANSIENT_IMAGE_STORE,
  TRANSIENT_IMAGE_TTL_MS,
  sweepExpiredTransientImageInputs,
} from '../lib/ocr/transient-image-store';

const NOW = 1_000_000;

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

  it('keeps a stored blob for exactly two minutes and then deletes it on read', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    let now = NOW;
    const store = new IndexedDbTransientImageStore(() => now);
    const blob = new Blob([new Uint8Array([1, 2, 3])]);

    const id = await store.put(blob);
    expect(id).toMatch(/^[A-Za-z0-9._:-]+$/u);
    expect(factory.record(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, id))
      .toMatchObject({
        id,
        byteLength: 3,
        createdAt: NOW,
        expiresAt: NOW + TRANSIENT_IMAGE_TTL_MS,
      });
    const stored = await store.get(id);
    expect(stored).toBeInstanceOf(Blob);
    // The fake returns the stored reference; real IndexedDB structured-clones,
    // so assert on content rather than identity.
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    // One millisecond before the TTL it is still an input.
    now = NOW + TRANSIENT_IMAGE_TTL_MS - 1;
    expect((await store.get(id))?.size).toBe(3);
    // At the TTL it is expired, and reading it removes it.
    now = NOW + TRANSIENT_IMAGE_TTL_MS;
    expect(await store.get(id)).toBeUndefined();
    expect(factory.has(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, id))
      .toBe(false);
  });

  it('refuses empty, oversized and malformed inputs at put()', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    const store = new IndexedDbTransientImageStore(() => NOW);
    const valid = new Blob([new Uint8Array([1])]);

    await expect(store.put(new Blob([]))).rejects.toThrow(
      'Invalid transient image input.',
    );
    // The cap is checked before anything is written.
    await expect(store.put({
      size: MAX_TRANSIENT_IMAGE_BYTES + 1,
    } as unknown as Blob)).rejects.toThrow('Invalid transient image input.');
    await expect(store.put(valid, 'not a key!')).rejects.toThrow(
      'Invalid transient image input.',
    );
    await expect(store.put(valid, 'x'.repeat(129))).rejects.toThrow(
      'Invalid transient image input.',
    );
    expect(await store.get('not a key!')).toBeUndefined();
    await expect(store.remove('not a key!')).resolves.toBeUndefined();
    expect(factory.record(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, 'x'))
      .toBeUndefined();
  });

  it('accepts a blob at exactly the 32 MB cap', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    const store = new IndexedDbTransientImageStore(() => NOW);
    const atCap = new Blob([new Uint8Array(MAX_TRANSIENT_IMAGE_BYTES)]);

    const id = await store.put(atCap, 'at-cap');

    expect(factory.record(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, id))
      .toMatchObject({ byteLength: MAX_TRANSIENT_IMAGE_BYTES });
    expect((await store.get(id))?.size).toBe(MAX_TRANSIENT_IMAGE_BYTES);
  });

  it('refuses and deletes records outside the accepted bounds on read', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    const store = new IndexedDbTransientImageStore(() => NOW);
    const small = new Blob([new Uint8Array([1])]);
    const oversized = new Blob([
      new Uint8Array(MAX_TRANSIENT_IMAGE_BYTES + 1),
    ]);
    const base = {
      id: 'record',
      blob: small,
      byteLength: 1,
      createdAt: NOW - 1_000,
      expiresAt: NOW + 1_000,
    };
    const invalid = [
      { ...base, id: 'bad-blob', blob: { size: 1 } },
      { ...base, id: 'bad-length', byteLength: 2 },
      { ...base, id: 'bad-empty', blob: new Blob([]), byteLength: 0 },
      {
        ...base,
        id: 'bad-cap',
        blob: oversized,
        byteLength: oversized.size,
      },
      { ...base, id: 'bad-created', createdAt: Number.NaN },
      { ...base, id: 'bad-expiry-order', expiresAt: NOW - 2_000 },
      {
        ...base,
        id: 'bad-ttl',
        expiresAt: base.createdAt + TRANSIENT_IMAGE_TTL_MS + 1,
      },
    ];
    factory.seed(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, [
      ...invalid,
      { ...base, id: 'keep' },
    ]);
    // Replace one seeded value with a non-object to prove the shape guard.
    factory.write(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, 'scalar', 7);

    for (const record of invalid) {
      expect(await store.get(record.id)).toBeUndefined();
      expect(factory.has(
        TRANSIENT_IMAGE_DATABASE,
        TRANSIENT_IMAGE_STORE,
        record.id,
      )).toBe(false);
    }
    expect(await store.get('scalar')).toBeUndefined();
    expect((await store.get('keep'))?.size).toBe(1);
  });

  it('sweeps expired and malformed records with the cursor and keeps live ones', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    const store = new IndexedDbTransientImageStore(() => NOW);
    const blob = new Blob([new Uint8Array([1])]);
    factory.seed(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, [
      {
        id: 'live',
        blob,
        byteLength: 1,
        createdAt: NOW,
        expiresAt: NOW + 1_000,
      },
      {
        id: 'expired',
        blob,
        byteLength: 1,
        createdAt: NOW - TRANSIENT_IMAGE_TTL_MS - 1,
        expiresAt: NOW - 1,
      },
      {
        id: 'bad-ttl',
        blob,
        byteLength: 1,
        createdAt: NOW,
        expiresAt: NOW + TRANSIENT_IMAGE_TTL_MS + 1,
      },
    ]);

    await store.clearExpired();

    expect(factory.has(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, 'live'))
      .toBe(true);
    expect(factory.has(
      TRANSIENT_IMAGE_DATABASE,
      TRANSIENT_IMAGE_STORE,
      'expired',
    )).toBe(false);
    expect(factory.has(
      TRANSIENT_IMAGE_DATABASE,
      TRANSIENT_IMAGE_STORE,
      'bad-ttl',
    )).toBe(false);
  });

  it('clears every transient input with clearAll()', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    const store = new IndexedDbTransientImageStore(() => NOW);
    const id = await store.put(new Blob([new Uint8Array([1])]));

    await store.clearAll();

    expect(factory.has(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, id))
      .toBe(false);
  });
});

describe('transient startup sweep without an OCR host', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes expired inputs and keeps live ones (C3)', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    // The startup sweep uses the real clock, not an injected one.
    const now = Date.now();
    const blob = new Blob([new Uint8Array([1])]);
    factory.seed(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, [
      {
        id: 'live',
        blob,
        byteLength: 1,
        createdAt: now,
        expiresAt: now + TRANSIENT_IMAGE_TTL_MS,
      },
      {
        id: 'expired',
        blob,
        byteLength: 1,
        createdAt: now - TRANSIENT_IMAGE_TTL_MS - 1,
        expiresAt: now - 1,
      },
    ]);

    await sweepExpiredTransientImageInputs();

    expect(factory.has(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, 'live'))
      .toBe(true);
    expect(factory.has(
      TRANSIENT_IMAGE_DATABASE,
      TRANSIENT_IMAGE_STORE,
      'expired',
    )).toBe(false);
  });

  it('does not reject when IndexedDB cannot be opened', async () => {
    vi.stubGlobal('indexedDB', {
      open: () => {
        const request = {} as IDBOpenDBRequest;
        queueMicrotask(() => request.onerror?.(new Event('error')));
        return request;
      },
    });

    await expect(sweepExpiredTransientImageInputs()).resolves.toBeUndefined();
  });
});

describe('offscreen host transient cleanup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sweeps an expired input at host startup with the real store (C5)', async () => {
    const factory = new FakeIndexedDbFactory();
    factory.install();
    const store = new IndexedDbTransientImageStore(() => NOW);
    const blob = new Blob([new Uint8Array([1])]);
    factory.seed(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, [
      {
        id: 'live',
        blob,
        byteLength: 1,
        createdAt: NOW,
        expiresAt: NOW + TRANSIENT_IMAGE_TTL_MS,
      },
      {
        id: 'expired',
        blob,
        byteLength: 1,
        createdAt: NOW - TRANSIENT_IMAGE_TTL_MS - 1,
        expiresAt: NOW - 1,
      },
    ]);
    const host = new OffscreenComputeHost(store, {
      recognize: async () => {
        throw new Error('No recognition is started in this test.');
      },
      dispose: async () => undefined,
    }, {
      // The recurring sweep is covered elsewhere; this test only wants the
      // startup sweep, so the timer is a no-op.
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => undefined,
    });

    await vi.waitFor(() => {
      expect(factory.has(
        TRANSIENT_IMAGE_DATABASE,
        TRANSIENT_IMAGE_STORE,
        'expired',
      )).toBe(false);
    });
    expect(factory.has(TRANSIENT_IMAGE_DATABASE, TRANSIENT_IMAGE_STORE, 'live'))
      .toBe(true);
    await host.dispose();
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

interface FakeRequest<T> {
  result: T;
  error: Error | null;
  onsuccess: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
}

/** A small hand-written IndexedDB subset for the transient input store. */
class FakeIndexedDbFactory {
  readonly #databases = new Map<string, FakeDatabase>();

  install(): void {
    vi.stubGlobal('indexedDB', {
      open: (name: string) => this.#open(name),
    });
  }

  seed(
    databaseName: string,
    storeName: string,
    records: readonly unknown[],
  ): void {
    const database = this.#database(databaseName);
    for (const record of records) {
      const id = (record as { readonly id?: unknown }).id;
      if (typeof id === 'string') database.store(storeName).set(id, record);
    }
  }

  write(
    databaseName: string,
    storeName: string,
    id: string,
    value: unknown,
  ): void {
    this.#database(databaseName).store(storeName).set(id, value);
  }

  record(
    databaseName: string,
    storeName: string,
    id: string,
  ): Record<string, unknown> | undefined {
    return this.#databases.get(databaseName)
      ?.store(storeName).get(id) as Record<string, unknown> | undefined;
  }

  has(databaseName: string, storeName: string, id: string): boolean {
    return this.#databases.get(databaseName)?.store(storeName).has(id) ?? false;
  }

  #database(name: string): FakeDatabase {
    let database = this.#databases.get(name);
    if (!database) {
      database = new FakeDatabase();
      this.#databases.set(name, database);
    }
    return database;
  }

  #open(name: string): IDBOpenDBRequest {
    const request = {} as FakeRequest<IDBDatabase | undefined> & {
      onupgradeneeded: ((event: Event) => void) | null;
      onblocked: ((event: Event) => void) | null;
    };
    queueMicrotask(() => {
      const created = !this.#databases.has(name);
      const database = this.#database(name);
      request.result = database as unknown as IDBDatabase;
      if (created) request.onupgradeneeded?.(new Event('upgradeneeded'));
      request.onsuccess?.(new Event('success'));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

class FakeDatabase {
  readonly #stores = new Map<string, Map<string, unknown>>();

  get objectStoreNames(): DOMStringList {
    const stores = this.#stores;
    return {
      contains: (name: string) => stores.has(name),
    } as unknown as DOMStringList;
  }

  createObjectStore(name: string): IDBObjectStore {
    this.store(name);
    return {} as IDBObjectStore;
  }

  store(name: string): Map<string, unknown> {
    let store = this.#stores.get(name);
    if (!store) {
      store = new Map();
      this.#stores.set(name, store);
    }
    return store;
  }

  transaction(name: string, _mode: IDBTransactionMode): IDBTransaction {
    return new FakeTransaction(this.store(name)) as unknown as IDBTransaction;
  }
}

class FakeTransaction {
  oncomplete: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  #pending = 0;

  constructor(private readonly records: Map<string, unknown>) {}

  objectStore(): IDBObjectStore {
    return this as unknown as IDBObjectStore;
  }

  put(value: { readonly id: string }): IDBRequest {
    this.records.set(value.id, value);
    return this.#request(value.id);
  }

  delete(key: IDBValidKey | IDBKeyRange): IDBRequest {
    this.records.delete(String(key));
    return this.#request(undefined);
  }

  get(key: IDBValidKey | IDBKeyRange): IDBRequest {
    return this.#request(this.records.get(String(key)));
  }

  clear(): IDBRequest {
    this.records.clear();
    return this.#request(undefined);
  }

  openCursor(): IDBRequest {
    const entries = [...this.records.entries()];
    const request = {
      result: null,
      error: null,
      onsuccess: null,
      onerror: null,
    } as FakeRequest<IDBCursorWithValue | null>;
    let index = 0;
    const advance = (): void => {
      const entry = entries[index];
      if (!entry) {
        request.result = null;
        request.onsuccess?.(new Event('success'));
        this.#settle();
        return;
      }
      index += 1;
      const [key, value] = entry;
      let continued = false;
      request.result = {
        key,
        primaryKey: key,
        value,
        delete: () => {
          this.records.delete(key);
        },
        continue: () => {
          continued = true;
          queueMicrotask(advance);
        },
        advance: () => {
          continued = true;
          queueMicrotask(advance);
        },
      } as unknown as IDBCursorWithValue;
      request.onsuccess?.(new Event('success'));
      if (!continued) this.#settle();
    };
    this.#pending += 1;
    queueMicrotask(advance);
    return request as unknown as IDBRequest;
  }

  #request<T>(result: T): IDBRequest<T> {
    const request: FakeRequest<T> = {
      result,
      error: null,
      onsuccess: null,
      onerror: null,
    };
    this.#pending += 1;
    queueMicrotask(() => {
      request.onsuccess?.(new Event('success'));
      this.#settle();
    });
    return request as unknown as IDBRequest<T>;
  }

  #settle(): void {
    this.#pending -= 1;
    if (this.#pending > 0) return;
    queueMicrotask(() => this.oncomplete?.(new Event('complete')));
  }
}