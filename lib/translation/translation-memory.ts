import type { TranslationPair } from '../translation-provider';

export interface TranslationMemoryScope {
  readonly provider: string;
  readonly pair: TranslationPair;
}

export interface TranslationMemoryOptions {
  readonly maxEntries?: number;
  readonly maxCharacters?: number;
  readonly maxInFlight?: number;
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

export interface TranslationMemoryStats {
  readonly entries: number;
  readonly characters: number;
  readonly hits: number;
  readonly misses: number;
  readonly inFlightJoins: number;
  readonly providerLoads: number;
  readonly expirations: number;
  readonly purges: number;
}

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_CHARACTERS = 500_000;
const DEFAULT_MAX_IN_FLIGHT = 64;
export const TRANSLATION_MEMORY_TTL_MS = 15 * 60 * 1_000;
const EMPTY_TRANSLATION_ERROR =
  'The translation provider returned an empty translation.';
const IN_FLIGHT_LIMIT_ERROR =
  'The translation memory in-flight request limit was reached.';

interface InFlightTranslation {
  readonly generation: number;
  readonly task: Promise<string>;
}

interface StoredTranslation {
  readonly translated: string;
  readonly expiresAt: number;
}

/** Bounded, exact-source, provider/pair-scoped in-memory translation LRU. */
export class TranslationMemory {
  readonly #maxEntries: number;
  readonly #maxCharacters: number;
  readonly #maxInFlight: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #values = new Map<string, StoredTranslation>();
  readonly #inFlight = new Map<string, InFlightTranslation>();
  #characters = 0;
  #generation = 0;
  #hits = 0;
  #misses = 0;
  #inFlightJoins = 0;
  #providerLoads = 0;
  #activeProviderLoads = 0;
  #expirations = 0;
  #purges = 0;

  constructor(options: TranslationMemoryOptions = {}) {
    this.#maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.#maxCharacters = positiveInteger(
      options.maxCharacters,
      DEFAULT_MAX_CHARACTERS,
    );
    this.#maxInFlight = positiveInteger(
      options.maxInFlight,
      DEFAULT_MAX_IN_FLIGHT,
    );
    this.#maxAgeMs = positiveDuration(
      options.maxAgeMs,
      TRANSLATION_MEMORY_TTL_MS,
    );
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    this.#expireRetained();
    return this.#values.size;
  }

  get characters(): number {
    this.#expireRetained();
    return this.#characters;
  }

  snapshotStats(): TranslationMemoryStats {
    this.#expireRetained();
    return Object.freeze({
      entries: this.#values.size,
      characters: this.#characters,
      hits: this.#hits,
      misses: this.#misses,
      inFlightJoins: this.#inFlightJoins,
      providerLoads: this.#providerLoads,
      expirations: this.#expirations,
      purges: this.#purges,
    });
  }

  get(scope: TranslationMemoryScope, source: string): string | undefined {
    return this.#get(memoryKey(scope, source));
  }

  #get(key: string): string | undefined {
    const stored = this.#values.get(key);
    if (stored === undefined) return undefined;
    if (stored.expiresAt <= this.#now()) {
      this.#delete(key, stored);
      this.#expirations += 1;
      return undefined;
    }
    this.#values.delete(key);
    this.#values.set(key, stored);
    return stored.translated;
  }

  set(
    scope: TranslationMemoryScope,
    source: string,
    translated: string,
  ): void {
    if (!translated.trim()) return;
    this.#set(memoryKey(scope, source), translated);
  }

  #set(key: string, translated: string): void {
    this.#expireRetained();
    const characters = key.length + translated.length;
    if (characters > this.#maxCharacters) return;
    const replaced = this.#values.get(key);
    if (replaced !== undefined) {
      this.#delete(key, replaced);
    }
    this.#values.set(key, Object.freeze({
      translated,
      expiresAt: expiresAt(this.#now(), this.#maxAgeMs),
    }));
    this.#characters += characters;
    this.#evict();
  }

  getOrCreate(
    scope: TranslationMemoryScope,
    source: string,
    load: () => Promise<string>,
  ): Promise<string> {
    return this.#getOrCreate(scope, source, load, this.#generation);
  }

  clear(): void {
    this.#generation += 1;
    this.#values.clear();
    // A clear is a retention boundary, not merely a cache-generation bump.
    // Drop exact-source join keys for old work immediately. Detached tasks may
    // still settle for their original callers and keep consuming provider
    // capacity until then, but their generation can never refill this memory.
    this.#inFlight.clear();
    this.#characters = 0;
    this.#hits = 0;
    this.#misses = 0;
    this.#inFlightJoins = 0;
    this.#providerLoads = 0;
    this.#expirations = 0;
    this.#purges += 1;
  }

  #getOrCreate(
    scope: TranslationMemoryScope,
    source: string,
    load: () => Promise<string>,
    generation: number,
  ): Promise<string> {
    const cacheKey = memoryKey(scope, source);
    const cached = this.#get(cacheKey);
    if (cached !== undefined) {
      this.#hits += 1;
      return Promise.resolve(cached);
    }
    this.#misses += 1;
    const key = inFlightKey(generation, cacheKey);
    const running = this.#inFlight.get(key);
    if (running?.generation === generation) {
      this.#inFlightJoins += 1;
      return running.task.catch((error: unknown) => {
        if (!isAbortError(error) || generation !== this.#generation) {
          throw error;
        }
        return this.#getOrCreate(scope, source, load, generation);
      });
    }
    if (generation !== this.#generation) {
      return Promise.reject(
        new DOMException('Translation memory was cleared.', 'AbortError'),
      );
    }
    if (this.#activeProviderLoads >= this.#maxInFlight) {
      return Promise.reject(new Error(IN_FLIGHT_LIMIT_ERROR));
    }
    this.#providerLoads += 1;
    this.#activeProviderLoads += 1;
    const task = (async () => {
      const translated = await load();
      if (!translated.trim()) throw new Error(EMPTY_TRANSLATION_ERROR);
      if (generation === this.#generation) {
        this.#set(cacheKey, translated);
      }
      return translated;
    })().finally(() => {
      if (this.#inFlight.get(key)?.task === task) this.#inFlight.delete(key);
      this.#activeProviderLoads -= 1;
    });
    this.#inFlight.set(key, { generation, task });
    return task;
  }

  #evict(): void {
    while (
      this.#values.size > this.#maxEntries ||
      this.#characters > this.#maxCharacters
    ) {
      const oldest = this.#values.entries().next().value as
        | [string, StoredTranslation]
        | undefined;
      if (!oldest) return;
      this.#delete(oldest[0], oldest[1]);
    }
  }

  #delete(key: string, stored: StoredTranslation): void {
    if (!this.#values.delete(key)) return;
    this.#characters -= key.length + stored.translated.length;
  }

  #expireRetained(): void {
    const now = this.#now();
    for (const [key, stored] of this.#values) {
      if (stored.expiresAt > now) continue;
      this.#delete(key, stored);
      this.#expirations += 1;
    }
  }
}

function memoryKey(scope: TranslationMemoryScope, source: string): string {
  return JSON.stringify([
    scope.provider,
    scope.pair.sourceLanguage,
    scope.pair.targetLanguage,
    source,
  ]);
}

function inFlightKey(generation: number, cacheKey: string): string {
  return `${generation}\u0000${cacheKey}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function expiresAt(now: number, maxAgeMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, now + maxAgeMs);
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'AbortError',
  );
}
