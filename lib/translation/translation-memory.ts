import type { TranslationPair } from '../translation-provider';

export interface TranslationMemoryScope {
  readonly provider: string;
  readonly pair: TranslationPair;
}

export interface TranslationMemoryOptions {
  readonly maxEntries?: number;
  readonly maxCharacters?: number;
  readonly maxInFlight?: number;
}

export interface TranslationMemoryStats {
  readonly entries: number;
  readonly characters: number;
  readonly hits: number;
  readonly misses: number;
  readonly inFlightJoins: number;
  readonly providerLoads: number;
}

const DEFAULT_MAX_ENTRIES = 512;
const DEFAULT_MAX_CHARACTERS = 500_000;
const DEFAULT_MAX_IN_FLIGHT = 64;
const EMPTY_TRANSLATION_ERROR =
  'The translation provider returned an empty translation.';
const IN_FLIGHT_LIMIT_ERROR =
  'The translation memory in-flight request limit was reached.';

interface InFlightTranslation {
  readonly generation: number;
  readonly task: Promise<string>;
}

/** Bounded, exact-source, provider/pair-scoped in-memory translation LRU. */
export class TranslationMemory {
  readonly #maxEntries: number;
  readonly #maxCharacters: number;
  readonly #maxInFlight: number;
  readonly #values = new Map<string, string>();
  readonly #inFlight = new Map<string, InFlightTranslation>();
  #characters = 0;
  #generation = 0;
  #hits = 0;
  #misses = 0;
  #inFlightJoins = 0;
  #providerLoads = 0;

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
  }

  get size(): number {
    return this.#values.size;
  }

  get characters(): number {
    return this.#characters;
  }

  snapshotStats(): TranslationMemoryStats {
    return Object.freeze({
      entries: this.#values.size,
      characters: this.#characters,
      hits: this.#hits,
      misses: this.#misses,
      inFlightJoins: this.#inFlightJoins,
      providerLoads: this.#providerLoads,
    });
  }

  get(scope: TranslationMemoryScope, source: string): string | undefined {
    const key = memoryKey(scope, source);
    const value = this.#values.get(key);
    if (value === undefined) return undefined;
    this.#values.delete(key);
    this.#values.set(key, value);
    return value;
  }

  set(
    scope: TranslationMemoryScope,
    source: string,
    translated: string,
  ): void {
    if (!translated.trim()) return;
    const key = memoryKey(scope, source);
    const characters = key.length + translated.length;
    if (characters > this.#maxCharacters) return;
    const replaced = this.#values.get(key);
    if (replaced !== undefined) {
      this.#characters -= key.length + replaced.length;
      this.#values.delete(key);
    }
    this.#values.set(key, translated);
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
    this.#characters = 0;
    this.#hits = 0;
    this.#misses = 0;
    this.#inFlightJoins = 0;
    this.#providerLoads = 0;
  }

  #getOrCreate(
    scope: TranslationMemoryScope,
    source: string,
    load: () => Promise<string>,
    generation: number,
  ): Promise<string> {
    const cached = this.get(scope, source);
    if (cached !== undefined) {
      this.#hits += 1;
      return Promise.resolve(cached);
    }
    this.#misses += 1;
    const cacheKey = memoryKey(scope, source);
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
    if (this.#inFlight.size >= this.#maxInFlight) {
      return Promise.reject(new Error(IN_FLIGHT_LIMIT_ERROR));
    }
    this.#providerLoads += 1;
    const task = (async () => {
      const translated = await load();
      if (!translated.trim()) throw new Error(EMPTY_TRANSLATION_ERROR);
      if (generation === this.#generation) {
        this.set(scope, source, translated);
      }
      return translated;
    })().finally(() => {
      if (this.#inFlight.get(key)?.task === task) this.#inFlight.delete(key);
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
        | [string, string]
        | undefined;
      if (!oldest) return;
      this.#values.delete(oldest[0]);
      this.#characters -= oldest[0].length + oldest[1].length;
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

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      error.name === 'AbortError',
  );
}
