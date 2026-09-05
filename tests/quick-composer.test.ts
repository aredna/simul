import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { QuickComposer, localizedLanguageName } from '../entrypoints/sidepanel/quick-composer';
import type { TranslationPair, TranslationProvider } from '../lib/translation-provider';

function setup(options: {
  pair?: TranslationPair | undefined;
  availability?: 'available' | 'downloadable' | 'unavailable';
  translate?: (text: string) => Promise<string>;
} = {}) {
  const { document, window } = parseHTML(`<html><body>
    <textarea id="in" maxlength="20"></textarea>
    <output id="count"></output>
    <textarea id="out"></textarea>
    <button id="go"></button>
    <button id="copy" disabled></button>
    <strong id="from"></strong>
    <strong id="to"></strong>
    <p id="guidance"></p>
    <p id="status"></p>
  </body></html>`);
  const element = <T extends Element>(id: string) => document.getElementById(id) as unknown as T;
  const elements = {
    input: element<HTMLTextAreaElement>('in'),
    characterCount: element<HTMLOutputElement>('count'),
    output: element<HTMLTextAreaElement>('out'),
    translateButton: element<HTMLButtonElement>('go'),
    copyButton: element<HTMLButtonElement>('copy'),
    fromLanguage: element<HTMLElement>('from'),
    toLanguage: element<HTMLElement>('to'),
    guidance: element<HTMLElement>('guidance'),
    status: element<HTMLElement>('status'),
  };
  let pair: TranslationPair | undefined =
    'pair' in options ? options.pair : { sourceLanguage: 'ja', targetLanguage: 'en' };
  const destroy = vi.fn();
  const translate = vi.fn(options.translate ?? (async (text: string) => `<${text}>`));
  const provider = {
    availability: vi.fn(async () => options.availability ?? 'available'),
    createSession: vi.fn(async () => ({ translate, destroy })),
  } as unknown as TranslationProvider;
  const statuses: string[] = [];
  const activity: boolean[] = [];
  const writeText = vi.fn(async () => undefined);
  const onTranslated = vi.fn();
  const composer = new QuickComposer({
    elements,
    provider,
    selectedPair: () => pair,
    getTargetLanguage: () => pair?.targetLanguage ?? 'en',
    translateRemembered: async (_pair, source, load) => load(source),
    setUiText: (target, english) => {
      target.textContent = english;
    },
    setStatus: (message) => statuses.push(message),
    onActivityChange: () => activity.push(composer.inFlight),
    onTranslated,
    readableError: (error) => (error instanceof Error ? error.message : String(error)),
    isSubmitShortcut: (event) => event.key === 'Enter' && event.ctrlKey,
    clipboard: { writeText },
  });
  return {
    window,
    composer,
    elements,
    provider,
    destroy,
    translate,
    statuses,
    activity,
    writeText,
    onTranslated,
    setPair: (next: TranslationPair | undefined) => {
      pair = next;
    },
  };
}

describe('QuickComposer', () => {
  it('translates a draft in the reverse direction and enables copy', async () => {
    const { composer, elements, provider, destroy, activity, onTranslated } = setup();
    elements.input.value = 'Thanks!';

    await composer.translate();

    expect(provider.createSession).toHaveBeenCalledWith(
      { sourceLanguage: 'en', targetLanguage: 'ja' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(elements.output.value).toBe('<Thanks!>');
    expect(elements.copyButton.disabled).toBe(false);
    expect(elements.status.textContent).toBe('Translation is ready to copy.');
    expect(destroy).toHaveBeenCalledOnce();
    expect(onTranslated).toHaveBeenCalledOnce();
    expect(activity).toEqual([true, false]);
    expect(composer.inFlight).toBe(false);
  });

  it('copies the text through when the languages match', async () => {
    const { composer, elements, provider } = setup({
      pair: { sourceLanguage: 'en', targetLanguage: 'en' },
    });
    elements.input.value = 'Same';
    await composer.translate();
    expect(elements.output.value).toBe('Same');
    expect(provider.createSession).not.toHaveBeenCalled();
  });

  it('prepares a downloadable pair because the composer is an explicit click', async () => {
    const { composer, elements, provider } = setup({ availability: 'downloadable' });
    elements.input.value = 'Hello';
    await composer.translate();
    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(elements.output.value).toBe('<Hello>');
  });

  it('drops a result when the draft or the page pair changed meanwhile', async () => {
    const pending: Array<() => void> = [];
    const { composer, elements, setPair } = setup({
      translate: (text) => new Promise((resolve) => {
        pending.push(() => resolve(`<${text}>`));
      }),
    });
    elements.input.value = 'first';
    const translating = composer.translate();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    elements.input.value = 'second';
    pending.shift()?.();
    await translating;
    expect(elements.output.value).toBe('');

    elements.input.value = 'third';
    const again = composer.translate();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    setPair({ sourceLanguage: 'fr', targetLanguage: 'en' });
    pending.shift()?.();
    await again;
    expect(elements.output.value).toBe('');
  });

  it('reports an unavailable reverse pair without touching the output', async () => {
    const { composer, elements, statuses } = setup({ availability: 'unavailable' });
    elements.input.value = 'Hello';
    await composer.translate();
    expect(elements.output.value).toBe('');
    expect(elements.status.dataset.tone).toBe('error');
    expect(statuses.at(-1)).toContain('unavailable');
  });

  it('cancels and invalidates without leaving a stale status', async () => {
    const pending: Array<() => void> = [];
    const { composer, elements } = setup({
      translate: (text) => new Promise((resolve) => {
        pending.push(() => resolve(text));
      }),
    });
    elements.input.value = 'draft';
    const translating = composer.translate();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(composer.inFlight).toBe(true);

    expect(composer.cancel()).toBe(true);
    expect(composer.inFlight).toBe(false);
    pending.shift()?.();
    await translating;
    expect(elements.output.value).toBe('');
    expect(elements.status.textContent).toBe('');

    elements.output.value = 'stale';
    composer.invalidate();
    expect(elements.output.value).toBe('');
    expect(elements.copyButton.disabled).toBe(true);
    expect(composer.cancel()).toBe(false);

    elements.input.value = 'draft';
    elements.output.value = 'stale';
    composer.reset();
    expect(elements.input.value).toBe('');
    expect(elements.output.value).toBe('');
    expect(elements.characterCount.value).toBe('0 / 20');
  });

  it('copies through the clipboard and falls back to selecting the output', async () => {
    const { composer, elements, writeText, statuses } = setup();
    elements.output.value = 'copy me';
    await composer.copy();
    expect(writeText).toHaveBeenCalledWith('copy me');
    expect(statuses.at(-1)).toBe('Translated reply copied.');

    writeText.mockRejectedValueOnce(new Error('denied'));
    const select = vi.fn();
    Object.defineProperty(elements.output, 'select', { value: select });
    Object.defineProperty(elements.output, 'focus', { value: vi.fn() });
    await composer.copy();
    expect(select).toHaveBeenCalled();
    expect(elements.status.dataset.tone).toBe('warning');
  });

  it('describes the direction and waits for detection when there is no pair', () => {
    const { composer, elements, setPair } = setup();
    composer.syncPanel();
    expect(elements.fromLanguage.getAttribute('lang')).toBe('en');
    expect(elements.fromLanguage.textContent).toBe('English');
    expect(elements.toLanguage.textContent).toBe('Japanese');
    expect(elements.guidance.textContent).toContain('not saved');

    setPair(undefined);
    composer.syncPanel();
    expect(elements.toLanguage.textContent).toBe('Waiting for website language');
    expect(elements.guidance.textContent).toContain('still detecting');
  });

  it('counts the draft against its limit and submits on the shortcut', async () => {
    const { window, composer, elements, activity } = setup();
    composer.install();
    expect(elements.characterCount.value).toBe('0 / 20');
    expect(elements.characterCount.getAttribute('aria-label')).toBe('0 of 20 characters used');

    elements.input.value = 'eighteen chars....';
    elements.output.value = 'stale';
    elements.input.dispatchEvent(new window.Event('input'));
    expect(elements.characterCount.value).toBe('18 / 20');
    expect(elements.characterCount.dataset.nearLimit).toBe('true');
    expect(elements.output.value).toBe('');
    expect(activity.length).toBeGreaterThan(0);

    const shortcut = () =>
      Object.assign(new window.Event('keydown'), { key: 'Enter', ctrlKey: true });
    elements.translateButton.disabled = true;
    elements.input.dispatchEvent(shortcut());
    expect(composer.inFlight).toBe(false);
    elements.translateButton.disabled = false;
    elements.input.dispatchEvent(shortcut());
    await vi.waitFor(() => expect(elements.output.value).toBe('<eighteen chars....>'));
  });
});

describe('localizedLanguageName', () => {
  it('names a language in the locale and falls back to English', () => {
    expect(localizedLanguageName('ja', 'en')).toBe('Japanese');
    expect(localizedLanguageName('ja', 'ja')).toBe('日本語');
    expect(localizedLanguageName('en', 'ja')).toBe('英語');
  });
});
