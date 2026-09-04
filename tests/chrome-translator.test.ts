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

  it('uses Chrome\'s documented legacy Hebrew code at the API boundary', async () => {
    const api = createApi();
    const provider = new ChromeTranslatorProvider(api);

    await provider.availability({ sourceLanguage: 'he', targetLanguage: 'en' });

    expect(api.availability).toHaveBeenCalledWith({
      sourceLanguage: 'iw',
      targetLanguage: 'en',
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
