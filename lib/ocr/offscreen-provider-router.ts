import type { ImageTextResult } from './contracts';
import type {
  OffscreenOcrProviderRunner,
  OffscreenOcrProviderRunnerFactory,
} from './offscreen-host';
import type { OffscreenOcrJob } from './offscreen-protocol';

/** Lazily constructs only the provider selected by the current ordered job. */
export class OffscreenOcrProviderRouter implements OffscreenOcrProviderRunner {
  readonly #factories: Map<string, OffscreenOcrProviderRunnerFactory>;
  readonly #runners = new Map<string, OffscreenOcrProviderRunner>();
  #active: OffscreenOcrProviderRunner | undefined;
  #disposed = false;

  constructor(
    private readonly factories: readonly OffscreenOcrProviderRunnerFactory[],
  ) {
    this.#factories = new Map(
      factories.map((factory) => [factory.id, factory] as const),
    );
    if (this.#factories.size !== factories.length) {
      throw new Error('The offscreen OCR runtime registry contains duplicates.');
    }
  }

  async recognize(
    job: OffscreenOcrJob,
    encoded: Blob,
    signal: AbortSignal,
  ): Promise<ImageTextResult> {
    if (this.#disposed) throw new ProviderUnavailableError();
    const runner = this.#runner(job.providerId);
    if (!runner) throw new ProviderUnavailableError();
    this.#active = runner;
    try {
      return await runner.recognize(job, encoded, signal);
    } finally {
      if (this.#active === runner) this.#active = undefined;
    }
  }

  async cancelActive(): Promise<void> {
    await this.#active?.cancelActive?.();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const runners = [...this.#runners.values()];
    this.#runners.clear();
    this.#active = undefined;
    await Promise.allSettled(runners.map((runner) => runner.dispose()));
  }

  #runner(providerId: string): OffscreenOcrProviderRunner | undefined {
    const existing = this.#runners.get(providerId);
    if (existing) return existing;
    const factory = this.#factories.get(providerId);
    if (!factory) return undefined;
    const runner = factory.create();
    this.#runners.set(providerId, runner);
    return runner;
  }
}

export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';

  constructor() {
    super('The requested OCR provider is unavailable in this build.');
  }
}
