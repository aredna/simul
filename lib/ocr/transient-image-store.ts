export const TRANSIENT_IMAGE_DATABASE = 'simul-ocr-transient-v1';
export const TRANSIENT_IMAGE_STORE = 'inputs';
export const TRANSIENT_IMAGE_TTL_MS = 2 * 60_000;
export const MAX_TRANSIENT_IMAGE_BYTES = 32 * 1024 * 1024;

interface TransientImageRecord {
  readonly id: string;
  readonly blob: Blob;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface TransientImageInputStore {
  put(blob: Blob, id?: string): Promise<string>;
  get(id: string): Promise<Blob | undefined>;
  remove(id: string): Promise<void>;
  clearExpired(): Promise<void>;
  clearAll?(): Promise<void>;
}

/**
 * Enforces the transient-input TTL without an OCR host. A side panel that dies
 * mid-job never runs its own cleanup, and the offscreen host's 30 s sweep only
 * exists while that document does. Expiry is enforced by that periodic host
 * sweep while a host lives, by the service worker's startup call
 * (entrypoints/background.ts), and by the next host construction. The side
 * panel deliberately does not sweep: opening storage during panel boot would
 * run ahead of the preference-safety connection for no extra coverage. A
 * browser restart that never starts the service worker is not covered.
 */
export async function sweepExpiredTransientImageInputs(
  store: TransientImageInputStore = new IndexedDbTransientImageStore(),
): Promise<void> {
  try {
    await store.clearExpired();
  } catch {
    // Storage being unavailable leaves nothing this context can sweep; the
    // next host construction retries the same sweep.
  }
}

export class IndexedDbTransientImageStore implements TransientImageInputStore {
  readonly #now: () => number;
  #databasePromise: Promise<IDBDatabase> | undefined;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  async put(blob: Blob, id: string = crypto.randomUUID()): Promise<string> {
    if (!isInputKey(id) || blob.size < 1 || blob.size > MAX_TRANSIENT_IMAGE_BYTES) {
      throw new Error('Invalid transient image input.');
    }
    const now = this.#now();
    const record: TransientImageRecord = Object.freeze({
      id,
      blob,
      byteLength: blob.size,
      createdAt: now,
      expiresAt: now + TRANSIENT_IMAGE_TTL_MS,
    });
    const database = await this.#database();
    await transactionDone(database, 'readwrite', (store) => store.put(record));
    return id;
  }

  async get(id: string): Promise<Blob | undefined> {
    if (!isInputKey(id)) return undefined;
    const database = await this.#database();
    const record = await requestResult<TransientImageRecord | undefined>(
      database.transaction(TRANSIENT_IMAGE_STORE, 'readonly')
        .objectStore(TRANSIENT_IMAGE_STORE)
        .get(id),
    );
    if (!validRecord(record, id) || record.expiresAt <= this.#now()) {
      await this.remove(id);
      return undefined;
    }
    return record.blob;
  }

  async remove(id: string): Promise<void> {
    if (!isInputKey(id)) return;
    const database = await this.#database();
    await transactionDone(database, 'readwrite', (store) => store.delete(id));
  }

  async clearExpired(): Promise<void> {
    const database = await this.#database();
    const now = this.#now();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(TRANSIENT_IMAGE_STORE, 'readwrite');
      const store = transaction.objectStore(TRANSIENT_IMAGE_STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const value = current.value as unknown;
        if (!validRecord(value) || value.expiresAt <= now) current.delete();
        current.continue();
      };
      cursor.onerror = () => reject(cursor.error ?? new Error('Transient image cleanup failed.'));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Transient image cleanup failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Transient image cleanup aborted.'));
    });
  }

  async clearAll(): Promise<void> {
    const database = await this.#database();
    await transactionDone(database, 'readwrite', (store) => store.clear());
  }

  #database(): Promise<IDBDatabase> {
    if (this.#databasePromise) return this.#databasePromise;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(TRANSIENT_IMAGE_DATABASE, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TRANSIENT_IMAGE_STORE)) {
          database.createObjectStore(TRANSIENT_IMAGE_STORE, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Transient image storage failed.'));
      request.onblocked = () => reject(new Error('Transient image storage is blocked.'));
    });
    this.#databasePromise = pending;
    void pending.catch(() => {
      if (this.#databasePromise === pending) this.#databasePromise = undefined;
    });
    return pending;
  }
}

function transactionDone(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(TRANSIENT_IMAGE_STORE, mode);
    operation(transaction.objectStore(TRANSIENT_IMAGE_STORE));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Transient image transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Transient image transaction aborted.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Transient image request failed.'));
  });
}

function validRecord(
  value: unknown,
  expectedId?: string,
): value is TransientImageRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Partial<TransientImageRecord>;
  return isInputKey(record.id) &&
    (expectedId === undefined || record.id === expectedId) &&
    record.blob instanceof Blob &&
    record.byteLength === record.blob.size &&
    record.byteLength >= 1 && record.byteLength <= MAX_TRANSIENT_IMAGE_BYTES &&
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) &&
    typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) &&
    record.expiresAt >= record.createdAt &&
    record.expiresAt - record.createdAt <= TRANSIENT_IMAGE_TTL_MS;
}

function isInputKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}
