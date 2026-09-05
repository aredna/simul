import { describe, expect, it, vi } from 'vitest';

import {
  type BrowserTranslatorApi,
  ChromeTranslatorProvider,
  readTranslatorApi,
} from '../lib/chrome-translator';
import { TranslationProviderError } from '../lib/translation-provider';

const pair = {
  sourceLanguage: 'ja',
  targetLanguage: 'en',
} as const;

describe('ChromeTranslatorProvider', () => {
  it('detects Chrome\'s function-valued WebIDL interface object', async () => {
    const translatorInterface = Object.assign(function Translator() {}, {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue({
        translate: vi.fn().mockResolvedValue('Hello'),
        destroy: vi.fn(),
      }),
    });
    vi.stubGlobal('Translator', translatorInterface);

    expect(readTranslatorApi()).toBe(translatorInterface);
    await expect(
      new ChromeTranslatorProvider().availability(pair),
    ).resolves.toBe('available');

    vi.unstubAllGlobals();
  });

  it('returns an explicit capability error when Chrome has no Translator API', async () => {
    const provider = new ChromeTranslatorProvider(undefined);

    await expect(provider.availability(pair)).rejects.toMatchObject({
      name: 'TranslationProviderError',
      code: 'api-unavailable',
    });
  });

  it.each([
    'available',
    'downloadable',
    'downloading',
    'unavailable',
  ] as const)('reports Chrome availability: %s', async (state) => {
    const provider = new ChromeTranslatorProvider(
      createApi({ availability: vi.fn().mockResolvedValue(state) }),
    );

    await expect(provider.availability(pair)).resolves.toBe(state);
  });

  it('normalizes unknown capability responses to unavailable', async () => {
    const provider = new ChromeTranslatorProvider(
      createApi({ availability: vi.fn().mockResolvedValue('maybe') }),
    );
    await expect(provider.availability(pair)).resolves.toBe('unavailable');
  });

  it('starts a local session, reports download progress, and destroys once', async () => {
    const destroy = vi.fn();
    const translate = vi.fn().mockResolvedValue('Hello');
    const create = vi.fn(async (options: Parameters<BrowserTranslatorApi['create']>[0]) => {
      options.monitor?.({
        addEventListener(_type, listener) {
          listener({ loaded: 25, total: 100 });
        },
      });
      return { translate, destroy };
    });
    const provider = new ChromeTranslatorProvider(createApi({ create }));
    const progress = vi.fn();

    const session = await provider.createSession(pair, {
      onDownloadProgress: progress,
    });
    await expect(session.translate('こんにちは')).resolves.toBe('Hello');
    session.destroy();
    session.destroy();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLanguage: 'ja',
        targetLanguage: 'en',
        monitor: expect.any(Function),
      }),
    );
    expect(progress).toHaveBeenCalledWith(0.25);
    expect(translate).toHaveBeenCalledWith('こんにちは', undefined);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('passes cancellation through creation and translation', async () => {
    const create = vi.fn().mockResolvedValue({
      translate: vi.fn().mockResolvedValue('Hello'),
      destroy: vi.fn(),
    });
    const provider = new ChromeTranslatorProvider(createApi({ create }));
    const controller = new AbortController();
    const session = await provider.createSession(pair, {
      signal: controller.signal,
    });
    await session.translate('こんにちは', controller.signal);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('destroys a session that resolves after its creation was cancelled', async () => {
    let resolveCreate!: (instance: Awaited<ReturnType<BrowserTranslatorApi['create']>>) => void;
    const destroy = vi.fn();
    const create = vi.fn(
      () => new Promise<Awaited<ReturnType<BrowserTranslatorApi['create']>>>((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const provider = new ChromeTranslatorProvider(createApi({ create }));
    const controller = new AbortController();

    const pending = provider.createSession(pair, { signal: controller.signal });
    controller.abort();
    resolveCreate({
      translate: vi.fn().mockResolvedValue('Hello'),
      destroy,
    });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('exposes valid Chrome input quota measurements to the pipeline', async () => {
    const measureInputUsage = vi.fn().mockResolvedValue(3);
    const provider = new ChromeTranslatorProvider(
      createApi({
        create: vi.fn().mockResolvedValue({
          inputQuota: 12,
          measureInputUsage,
          translate: vi.fn().mockResolvedValue('Hello'),
          destroy: vi.fn(),
        }),
      }),
    );
    const controller = new AbortController();
    const session = await provider.createSession(pair);

    expect(session.inputQuota).toBe(12);
    await expect(
      session.measureInputUsage?.('abc', controller.signal),
    ).resolves.toBe(3);
    expect(measureInputUsage).toHaveBeenCalledWith('abc', {
      signal: controller.signal,
    });
  });

  it('counts Unicode code points without a native quota measurer', async () => {
    const provider = new ChromeTranslatorProvider(
      createApi({
        create: vi.fn().mockResolvedValue({
          inputQuota: 12,
          translate: vi.fn().mockResolvedValue('Hello'),
          destroy: vi.fn(),
        }),
      }),
    );
    const session = await provider.createSession(pair);

    await expect(session.measureInputUsage?.('A😀𐐷')).resolves.toBe(3);
  });

  it('rejects all work after the native session is destroyed', async () => {
    const measureInputUsage = vi.fn().mockResolvedValue(3);
    const translate = vi.fn().mockResolvedValue('Hello');
    const provider = new ChromeTranslatorProvider(
      createApi({
        create: vi.fn().mockResolvedValue({
          inputQuota: 12,
          measureInputUsage,
          translate,
          destroy: vi.fn(),
        }),
      }),
    );
    const session = await provider.createSession(pair);

    session.destroy();

    await expect(session.measureInputUsage?.('abc')).rejects.toMatchObject({
      code: 'translation-failed',
    });
    await expect(session.translate('abc')).rejects.toMatchObject({
      code: 'translation-failed',
    });
    expect(measureInputUsage).not.toHaveBeenCalled();
    expect(translate).not.toHaveBeenCalled();
  });

  it('treats same-language pairs as a local no-op', async () => {
    const api = createApi();
    const provider = new ChromeTranslatorProvider(api);

    await expect(
      provider.availability({ sourceLanguage: 'en', targetLanguage: 'en' }),
    ).resolves.toBe('available');
    const session = await provider.createSession({
      sourceLanguage: 'en',
      targetLanguage: 'en',
    });
    await expect(session.translate('unchanged')).resolves.toBe('unchanged');
    expect(api.availability).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('reports a download that needs user activation as activation-required', async () => {
    const provider = new ChromeTranslatorProvider(
      createApi({
        availability: vi.fn().mockResolvedValue('downloadable'),
        create: vi.fn().mockRejectedValue(
          new DOMException('Requires a user gesture.', 'NotAllowedError'),
        ),
      }),
    );

    await expect(provider.createSession(pair)).rejects.toMatchObject({
      name: 'TranslationProviderError',
      code: 'activation-required',
      message: expect.stringContaining('click'),
    });
  });

  it('keeps other creation failures on the generic code', async () => {
    const provider = new ChromeTranslatorProvider(
      createApi({
        create: vi.fn().mockRejectedValue(
          new DOMException('Not allowed.', 'InvalidStateError'),
        ),
      }),
    );

    await expect(provider.createSession(pair)).rejects.toMatchObject({
      name: 'TranslationProviderError',
      code: 'creation-failed',
    });
  });

  it('reports an oversized input as quota-exceeded', async () => {
    const provider = new ChromeTranslatorProvider(
      createApi({
        create: vi.fn().mockResolvedValue({
          translate: vi.fn().mockRejectedValue(
            new DOMException('Too large.', 'QuotaExceededError'),
          ),
          destroy: vi.fn(),
        }),
      }),
    );
    const session = await provider.createSession(pair);

    await expect(session.translate('x'.repeat(10))).rejects.toMatchObject({
      name: 'TranslationProviderError',
      code: 'quota-exceeded',
    });
  });

  describe('Hebrew language tags', () => {
    const hebrewSource = { sourceLanguage: 'he', targetLanguage: 'en' } as const;
    const hebrewTarget = { sourceLanguage: 'en', targetLanguage: 'he' } as const;
    const sourceTagOf = (call: unknown[]) =>
      (call[0] as { sourceLanguage: string }).sourceLanguage;

    it('probes the documented he tag first and stops when Chrome accepts it', async () => {
      const api = createApi();
      const provider = new ChromeTranslatorProvider(api);

      await expect(provider.availability(hebrewSource)).resolves.toBe('available');
      await provider.createSession(hebrewSource);

      expect(api.availability).toHaveBeenCalledTimes(1);
      expect(api.availability).toHaveBeenCalledWith({
        sourceLanguage: 'he',
        targetLanguage: 'en',
      });
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLanguage: 'he', targetLanguage: 'en' }),
      );
    });

    it('falls back to the legacy iw tag when he is refused and keeps it for sessions', async () => {
      const availability = vi.fn(
        async (options: { sourceLanguage: string; targetLanguage: string }) =>
          options.sourceLanguage === 'iw' ? 'downloadable' : 'unavailable',
      );
      const api = createApi({ availability });
      const provider = new ChromeTranslatorProvider(api);

      await expect(provider.availability(hebrewSource)).resolves.toBe('downloadable');
      expect(availability.mock.calls.map(sourceTagOf)).toEqual(['he', 'iw']);

      await provider.createSession(hebrewSource);
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLanguage: 'iw', targetLanguage: 'en' }),
      );
      // The accepted tag is reused: no second probe round before the session,
      // and the next availability check asks Chrome about iw only.
      expect(availability).toHaveBeenCalledTimes(2);
      await expect(provider.availability(hebrewSource)).resolves.toBe('downloadable');
      expect(availability).toHaveBeenCalledTimes(3);
      expect(availability).toHaveBeenLastCalledWith({
        sourceLanguage: 'iw',
        targetLanguage: 'en',
      });
    });

    it('resolves the tag for a Hebrew target language as well', async () => {
      const availability = vi.fn(
        async (options: { sourceLanguage: string; targetLanguage: string }) =>
          options.targetLanguage === 'iw' ? 'available' : 'unavailable',
      );
      const api = createApi({ availability });
      const provider = new ChromeTranslatorProvider(api);

      await expect(provider.availability(hebrewTarget)).resolves.toBe('available');
      await provider.createSession(hebrewTarget);

      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLanguage: 'en', targetLanguage: 'iw' }),
      );
    });

    it('reports unavailable only after every tag was refused', async () => {
      const availability = vi.fn().mockResolvedValue('unavailable');
      const provider = new ChromeTranslatorProvider(createApi({ availability }));

      await expect(provider.availability(hebrewSource)).resolves.toBe('unavailable');
      expect(availability.mock.calls.map(sourceTagOf)).toEqual(['he', 'iw']);
    });

    it('settles the tag with a probe before the first session when none was accepted yet', async () => {
      const availability = vi.fn(
        async (options: { sourceLanguage: string; targetLanguage: string }) =>
          options.sourceLanguage === 'iw' ? 'available' : 'unavailable',
      );
      const api = createApi({ availability });
      const provider = new ChromeTranslatorProvider(api);

      await provider.createSession(hebrewSource);

      expect(availability.mock.calls.map(sourceTagOf)).toEqual(['he', 'iw']);
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLanguage: 'iw' }),
      );
    });

    it('sends the documented tag to creation when Chrome refused both, so Chrome reports the failure', async () => {
      const availability = vi.fn().mockResolvedValue('unavailable');
      const create = vi.fn().mockRejectedValue(
        new DOMException('Unsupported.', 'NotSupportedError'),
      );
      const provider = new ChromeTranslatorProvider(createApi({ availability, create }));

      await expect(provider.createSession(hebrewSource)).rejects.toMatchObject({
        code: 'creation-failed',
      });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ sourceLanguage: 'he' }),
      );
    });

    it('treats a probe that throws for one tag as a refusal of that tag only', async () => {
      const availability = vi.fn(
        async (options: { sourceLanguage: string; targetLanguage: string }) => {
          if (options.sourceLanguage === 'he') throw new RangeError('bad tag');
          return 'available';
        },
      );
      const provider = new ChromeTranslatorProvider(createApi({ availability }));

      await expect(provider.availability(hebrewSource)).resolves.toBe('available');
    });

    it('still surfaces a capability error when the only probe throws', async () => {
      const availability = vi.fn().mockRejectedValue(new Error('broken'));
      const provider = new ChromeTranslatorProvider(createApi({ availability }));

      await expect(provider.availability(pair)).rejects.toMatchObject({
        code: 'api-unavailable',
      });
    });

    it('probes other languages exactly once with their own tag', async () => {
      const api = createApi();
      const provider = new ChromeTranslatorProvider(api);

      await provider.availability(pair);
      await provider.createSession(pair);

      expect(api.availability).toHaveBeenCalledTimes(1);
      expect(api.availability).toHaveBeenCalledWith({
        sourceLanguage: 'ja',
        targetLanguage: 'en',
      });
    });
  });
});

function createApi(overrides: Partial<BrowserTranslatorApi> = {}): BrowserTranslatorApi {
  return {
    availability: vi.fn().mockResolvedValue('available'),
    create: vi.fn().mockResolvedValue({
      translate: vi.fn().mockResolvedValue('translated'),
      destroy: vi.fn(),
    }),
    ...overrides,
  };
}
