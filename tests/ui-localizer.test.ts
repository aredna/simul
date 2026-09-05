import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { UiLocalizer } from '../entrypoints/sidepanel/ui-localizer';
import type {
  SupportedLanguage,
  TranslationPair,
  TranslationProvider,
} from '../lib/translation-provider';

const MARKUP = `<html><body>
  <button id="a"><span data-ui-label="Fit">Fit</span></button>
  <label><span data-ui-label="Size">Size</span></label>
  <select id="source-language">
    <option value="auto">Auto-detect</option>
    <option value="ja" data-language-code="ja">Japanese</option>
  </select>
</body></html>`;

function setup(options: {
  target?: SupportedLanguage;
  availability?: 'available' | 'downloadable' | 'unavailable';
  translations?: Record<string, string>;
  failOn?: string;
  retryDelayMs?: number;
} = {}) {
  const { document } = parseHTML(MARKUP);
  let target: SupportedLanguage = options.target ?? 'ja';
  let availability = options.availability ?? 'available';
  const destroy = vi.fn();
  const translate = vi.fn(async (text: string) => {
    if (text === options.failOn) throw new Error('boom');
    return options.translations?.[text] ?? `${target}:${text}`;
  });
  const createSession = vi.fn(async () => ({ translate, destroy }));
  const provider = {
    availability: vi.fn(async () => availability),
    createSession,
  } as unknown as TranslationProvider;
  const scheduled: Array<() => void> = [];
  const localizer = new UiLocalizer({
    document: document as unknown as Document,
    provider,
    dynamicLabels: ['Translate page'],
    getTargetLanguage: () => target,
    translateRemembered: async (_pair: TranslationPair, source, load) => load(source),
    schedule: (callback) => scheduled.push(callback),
    retryDelayMs: options.retryDelayMs ?? 10_000,
  });
  const fit = () => document.querySelector('[data-ui-label="Fit"]')!;
  return {
    document,
    localizer,
    provider,
    createSession,
    destroy,
    translate,
    scheduled,
    fit,
    runScheduled: async () => {
      while (scheduled.length > 0) scheduled.shift()?.();
      await vi.waitFor(() => expect(scheduled).toHaveLength(0));
    },
    setTarget: (next: SupportedLanguage) => {
      target = next;
    },
    setAvailability: (next: typeof availability) => {
      availability = next;
    },
  };
}

describe('UiLocalizer', () => {
  it('localizes the complete label set and marks each element with its language', async () => {
    const { document, localizer, destroy, translate, fit } = setup();

    await localizer.localize();

    expect(fit().textContent).toBe('ja:Fit');
    expect(fit().getAttribute('lang')).toBe('ja');
    expect(document.querySelector('[data-ui-label="Size"]')?.textContent).toBe('ja:Size');
    expect(localizer.translations.get('Translate page')).toBe('ja:Translate page');
    expect(translate.mock.calls.map(([text]) => text)).toEqual(['Translate page', 'Fit', 'Size']);
    expect(destroy).toHaveBeenCalledOnce();
    expect(localizer.retryPending).toBe(false);
    // From-menu entries are named in the target language.
    const option = document.querySelector<HTMLOptionElement>('[data-language-code="ja"]')!;
    expect(option.getAttribute('lang')).toBe('ja');
    expect(option.textContent).not.toBe('');
  });

  it('keeps every label English when one translation fails', async () => {
    const { localizer, fit } = setup({ failOn: 'Size' });

    await localizer.localize();

    expect(fit().textContent).toBe('Fit');
    expect(fit().hasAttribute('lang')).toBe(false);
    expect(localizer.localizedTarget).toBe('ja');
  });

  it('does not download a language pack without a gesture', async () => {
    const { localizer, createSession, fit } = setup({ availability: 'downloadable' });

    await localizer.localize();

    expect(createSession).not.toHaveBeenCalled();
    expect(fit().textContent).toBe('Fit');
  });

  it('retries a not-installed set once after a delay, then follows a page translation', async () => {
    const { localizer, provider, createSession, scheduled, fit, runScheduled, setAvailability } =
      setup({ availability: 'downloadable', retryDelayMs: 20 });

    await localizer.localize();
    expect(localizer.retryPending).toBe(true);
    expect(scheduled).toHaveLength(0);

    // The single delayed retry re-runs the same set once.
    await vi.waitFor(() => expect(scheduled).toHaveLength(1));
    expect(localizer.retryPending).toBe(false);
    await runScheduled();
    await vi.waitFor(() => expect(provider.availability).toHaveBeenCalledTimes(2));
    expect(createSession).not.toHaveBeenCalled();
    expect(fit().textContent).toBe('Fit');
    // Still not installed: no second retry for the same set.
    expect(localizer.retryPending).toBe(false);

    // A page translation prepared the pair; the labels follow.
    setAvailability('available');
    localizer.retryAfterPagePairPrepared();
    expect(scheduled).toHaveLength(1);
    await runScheduled();
    await vi.waitFor(() => expect(fit().textContent).toBe('ja:Fit'));
    expect(fit().getAttribute('lang')).toBe('ja');
    // Nothing was retried, so a later call is a no-op.
    localizer.retryAfterPagePairPrepared();
    expect(scheduled).toHaveLength(0);
  });

  it('drops a pending retry when the target changes or the localizer is disposed', async () => {
    const { localizer, provider, scheduled, setTarget } =
      setup({ availability: 'downloadable' });
    await localizer.localize();
    expect(localizer.retryPending).toBe(true);

    setTarget('fr');
    localizer.schedule();
    expect(localizer.retryPending).toBe(false);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(provider.availability).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(localizer.retryPending).toBe(true));

    localizer.dispose();
    expect(localizer.retryPending).toBe(false);
    expect(scheduled).toHaveLength(0);
  });

  it('drops a result when the target changed while translating', async () => {
    const pending: Array<() => void> = [];
    let immediate = false;
    const { localizer, provider, setTarget, fit } = setup();
    (provider.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      translate: (text: string) => immediate
        ? Promise.resolve(`late:${text}`)
        : new Promise<string>((resolve) => {
          pending.push(() => resolve(`late:${text}`));
        }),
      destroy: vi.fn(),
    }));

    const localizing = localizer.localize();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    // The user picks another target while the first label is in flight.
    setTarget('fr');
    immediate = true;
    pending.shift()?.();
    await localizing;

    expect(fit().textContent).toBe('Fit');
    expect(fit().hasAttribute('lang')).toBe(false);
  });

  it('falls back to English as a set when a new label appears, then re-localizes', async () => {
    const { document, localizer, scheduled, fit } = setup();
    await localizer.localize();
    expect(fit().textContent).toBe('ja:Fit');

    const badge = document.createElement('span') as unknown as HTMLElement;
    document.body.append(badge);
    localizer.setText(badge, 'Live page replica');

    // Unknown label: the whole interface returns to English immediately.
    expect(badge.textContent).toBe('Live page replica');
    expect(fit().textContent).toBe('Fit');
    expect(scheduled).toHaveLength(1);

    scheduled.shift()?.();
    await vi.waitFor(() => expect(fit().textContent).toBe('ja:Fit'));
    expect(badge.textContent).toBe('ja:Live page replica');
    expect(badge.getAttribute('lang')).toBe('ja');
  });

  it('renders English directly for an English target', async () => {
    const { localizer, createSession, fit } = setup({ target: 'en' });
    await localizer.localize();
    expect(createSession).not.toHaveBeenCalled();
    expect(fit().textContent).toBe('Fit');
    expect(localizer.retryPending).toBe(false);
  });
});
