import { describe, expect, it, vi } from 'vitest';

import { TranslationMemory } from '../lib/translation/translation-memory';

const esEn = {
  provider: 'chrome-v1',
  pair: { sourceLanguage: 'es', targetLanguage: 'en' },
} as const;

describe('TranslationMemory', () => {
  it('keeps exact source values scoped by pair and provider', () => {
    const memory = new TranslationMemory();
    memory.set(esEn, 'Hola', 'Hello');

    expect(memory.get(esEn, 'Hola')).toBe('Hello');
    expect(memory.get(esEn, 'hola')).toBeUndefined();
    expect(
      memory.get(
        { provider: 'other', pair: esEn.pair },
        'Hola',
      ),
    ).toBeUndefined();
    expect(
      memory.get(
        {
          provider: 'chrome-v1',
          pair: { sourceLanguage: 'es', targetLanguage: 'ja' },
        },
        'Hola',
      ),
    ).toBeUndefined();
  });

  it('reuses exact content across page contexts', () => {
    const memory = new TranslationMemory();
    memory.set(esEn, 'Inicio', 'Home');

    expect(memory.get(esEn, 'Inicio')).toBe('Home');
    expect(memory.get({ ...esEn }, 'Inicio')).toBe('Home');
  });

  it('deduplicates in-flight exact translations', async () => {
    let resolve!: (value: string) => void;
    const load = vi.fn(
      () => new Promise<string>((done) => {
        resolve = done;
      }),
    );

    const memory = new TranslationMemory();
    const first = memory.getOrCreate(esEn, 'Hola', load);
    const second = memory.getOrCreate(esEn, 'Hola', load);
    resolve('Hello');

    await expect(Promise.all([first, second])).resolves.toEqual(['Hello', 'Hello']);
    expect(load).toHaveBeenCalledOnce();
    await expect(memory.getOrCreate(esEn, 'Hola', load)).resolves.toBe('Hello');
    expect(memory.snapshotStats()).toEqual({
      entries: 1,
      characters: memory.characters,
      hits: 1,
      misses: 2,
      inFlightJoins: 1,
      providerLoads: 1,
      expirations: 0,
      purges: 0,
    });
  });

  it('expires retained translations after a fixed bounded TTL', async () => {
    let now = 1_000;
    const load = vi.fn(async () => 'Fresh hello');
    const memory = new TranslationMemory({
      maxAgeMs: 100,
      now: () => now,
    });
    memory.set(esEn, 'Hola', 'Hello');

    now = 1_090;
    expect(memory.get(esEn, 'Hola')).toBe('Hello');
    now = 1_100;
    await expect(memory.getOrCreate(esEn, 'Hola', load)).resolves
      .toBe('Fresh hello');

    expect(load).toHaveBeenCalledOnce();
    expect(memory.snapshotStats()).toMatchObject({
      entries: 1,
      hits: 0,
      misses: 1,
      providerLoads: 1,
      expirations: 1,
      purges: 0,
    });
  });

  it('purges expired values from size and character accounting', () => {
    let now = 5_000;
    const memory = new TranslationMemory({
      maxAgeMs: 50,
      now: () => now,
    });
    memory.set(esEn, 'Hola', 'Hello');
    expect(memory.size).toBe(1);
    expect(memory.characters).toBeGreaterThan(0);

    now = 5_050;
    expect(memory.size).toBe(0);
    expect(memory.characters).toBe(0);
    expect(memory.snapshotStats()).toMatchObject({
      expirations: 1,
      purges: 0,
    });

    memory.clear();
    expect(memory.snapshotStats()).toMatchObject({
      expirations: 0,
      purges: 1,
    });
  });

  it('retries a joined translation when the shared caller aborts', async () => {
    let rejectOld!: (reason: unknown) => void;
    const oldLoad = vi.fn(
      () => new Promise<string>((_resolve, reject) => {
        rejectOld = reject;
      }),
    );
    const currentLoad = vi.fn(async () => 'Hello');

    const memory = new TranslationMemory();
    const old = memory.getOrCreate(esEn, 'Hola', oldLoad);
    const current = memory.getOrCreate(esEn, 'Hola', currentLoad);
    rejectOld(new DOMException('Old caller was cancelled.', 'AbortError'));

    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await expect(current).resolves.toBe('Hello');
    expect(oldLoad).toHaveBeenCalledOnce();
    expect(currentLoad).toHaveBeenCalledOnce();
    expect(memory.get(esEn, 'Hola')).toBe('Hello');
  });

  it('rejects empty provider output without caching it', async () => {
    const memory = new TranslationMemory();

    await expect(
      memory.getOrCreate(esEn, 'Hola', async () => ' \n\t '),
    ).rejects.toThrow('empty translation');
    expect(memory.get(esEn, 'Hola')).toBeUndefined();
    await expect(
      memory.getOrCreate(esEn, 'Hola', async () => 'Hello'),
    ).resolves.toBe('Hello');
  });

  it('bounds distinct in-flight translations while allowing exact joins', async () => {
    let resolveOne!: (value: string) => void;
    let resolveTwo!: (value: string) => void;
    const firstLoad = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveOne = resolve;
      }),
    );
    const secondLoad = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveTwo = resolve;
      }),
    );
    const overflowLoad = vi.fn(async () => 'Three');
    const joinedLoad = vi.fn(async () => 'Unused');
    const memory = new TranslationMemory({ maxInFlight: 2 });

    const first = memory.getOrCreate(esEn, 'Uno', firstLoad);
    const second = memory.getOrCreate(esEn, 'Dos', secondLoad);
    const joined = memory.getOrCreate(esEn, 'Uno', joinedLoad);

    await expect(
      memory.getOrCreate(esEn, 'Tres', overflowLoad),
    ).rejects.toThrow('in-flight request limit');
    expect(overflowLoad).not.toHaveBeenCalled();
    expect(joinedLoad).not.toHaveBeenCalled();

    resolveOne('One');
    resolveTwo('Two');
    await expect(Promise.all([first, second, joined])).resolves.toEqual([
      'One',
      'Two',
      'One',
    ]);
  });

  it('drops cleared joins while active provider loads retain capacity', async () => {
    let resolveOld!: (value: string) => void;
    let resolveCurrent!: (value: string) => void;
    const oldLoad = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveOld = resolve;
      }),
    );
    const currentLoad = vi.fn(
      () => new Promise<string>((resolve) => {
        resolveCurrent = resolve;
      }),
    );
    const memory = new TranslationMemory({ maxInFlight: 2 });
    memory.set(esEn, 'Adios', 'Goodbye');
    const old = memory.getOrCreate(esEn, 'Hola', oldLoad);

    memory.clear();

    expect(memory.size).toBe(0);
    expect(memory.characters).toBe(0);
    const current = memory.getOrCreate(esEn, 'Hola', currentLoad);
    const overflowLoad = vi.fn(async () => 'New value');
    await expect(
      memory.getOrCreate(esEn, 'Nuevo', overflowLoad),
    ).rejects.toThrow('in-flight request limit');
    expect(overflowLoad).not.toHaveBeenCalled();

    resolveOld('Stale hello');
    await expect(old).resolves.toBe('Stale hello');
    expect(memory.get(esEn, 'Hola')).toBeUndefined();

    await expect(
      memory.getOrCreate(esEn, 'Nuevo', overflowLoad),
    ).resolves.toBe('New value');
    expect(overflowLoad).toHaveBeenCalledOnce();

    resolveCurrent('Hello');
    await expect(current).resolves.toBe('Hello');
    expect(memory.get(esEn, 'Hola')).toBe('Hello');
    expect(memory.get(esEn, 'Nuevo')).toBe('New value');
  });

  it('evicts least-recently-used values within entry and character bounds', () => {
    const memory = new TranslationMemory({ maxEntries: 2, maxCharacters: 1_000 });
    memory.set(esEn, 'one', '1');
    memory.set(esEn, 'two', '2');
    expect(memory.get(esEn, 'one')).toBe('1');
    memory.set(esEn, 'three', '3');

    expect(memory.get(esEn, 'two')).toBeUndefined();
    expect(memory.get(esEn, 'one')).toBe('1');
    expect(memory.get(esEn, 'three')).toBe('3');
  });
});
