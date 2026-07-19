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

  it('rejects same-language pairs before invoking Chrome', async () => {
    const api = createApi();
    const provider = new ChromeTranslatorProvider(api);

    await expect(
      provider.availability({ sourceLanguage: 'en', targetLanguage: 'en' }),
    ).rejects.toBeInstanceOf(TranslationProviderError);
    expect(api.availability).not.toHaveBeenCalled();
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
