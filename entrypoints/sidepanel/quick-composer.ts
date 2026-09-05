import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { reverseTranslationPair } from '../../lib/companion-ui-state';
import { translateWithSession } from '../../lib/translation-pipeline';
import {
  languageName,
  type SupportedLanguage,
  type TranslationPair,
  type TranslationProvider,
  type TranslationSession,
} from '../../lib/translation-provider';

export interface QuickComposerElements {
  readonly input: HTMLTextAreaElement;
  readonly characterCount: HTMLOutputElement;
  readonly output: HTMLTextAreaElement;
  readonly translateButton: HTMLButtonElement;
  readonly copyButton: HTMLButtonElement;
  readonly fromLanguage: HTMLElement;
  readonly toLanguage: HTMLElement;
  readonly guidance: HTMLElement;
  readonly status: HTMLElement;
}

export interface QuickComposerEnvironment {
  readonly elements: QuickComposerElements;
  readonly provider: TranslationProvider;
  /** The page pair; the composer translates in the reverse direction. */
  readonly selectedPair: () => TranslationPair | undefined;
  readonly getTargetLanguage: () => SupportedLanguage;
  readonly translateRemembered: (
    pair: TranslationPair,
    source: string,
    load: (core: string) => Promise<string>,
  ) => Promise<string>;
  readonly setUiText: (element: HTMLElement, english: string) => void;
  /** Companion-level status line. */
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  /** Called whenever the in-flight state or the draft changes. */
  readonly onActivityChange: () => void;
  readonly onTranslated?: () => void;
  readonly readableError: (error: unknown) => string;
  /** The keyboard shortcut that submits the draft. */
  readonly isSubmitShortcut: (event: KeyboardEvent) => boolean;
  readonly clipboard?: Pick<Clipboard, 'writeText'>;
  readonly numberFormat?: Intl.NumberFormat;
}

export type ComposerStatusTone = 'normal' | 'success' | 'warning' | 'error';

/**
 * The private reverse-translation composer. Drafts and output live only in
 * this window and are never saved; a result is applied only if the input and
 * the page pair are unchanged when it arrives. Unlike label localization the
 * composer is an explicit click, so it may prepare a downloadable pair.
 */
export class QuickComposer {
  #inFlight = false;
  #abortController: AbortController | undefined;
  readonly #numberFormat: Intl.NumberFormat;

  constructor(private readonly environment: QuickComposerEnvironment) {
    this.#numberFormat = environment.numberFormat ?? new Intl.NumberFormat();
  }

  get inFlight(): boolean {
    return this.#inFlight;
  }

  /** Wires the draft's input and shortcut listeners and renders its count. */
  install(): void {
    const { input, translateButton } = this.environment.elements;
    input.addEventListener('input', () => {
      this.syncCharacterCount();
      this.invalidate();
    });
    input.addEventListener('keydown', (event) => {
      if (
        !this.environment.isSubmitShortcut(event) ||
        translateButton.disabled
      ) return;
      event.preventDefault();
      void this.translate();
    });
    this.syncCharacterCount();
  }

  focusInput(): void {
    this.environment.elements.input.focus();
  }

  /** Shows the draft length against its limit without announcing keystrokes. */
  syncCharacterCount(): void {
    const { input, characterCount } = this.environment.elements;
    const current = input.value.length;
    const maximum = readMaxLength(input);
    const currentLabel = this.#numberFormat.format(current);
    const maximumLabel = this.#numberFormat.format(maximum);
    characterCount.value = `${currentLabel} / ${maximumLabel}`;
    characterCount.setAttribute(
      'aria-label',
      `${currentLabel} of ${maximumLabel} characters used`,
    );
    characterCount.dataset.nearLimit = String(
      maximum > 0 && current >= maximum * 0.9,
    );
  }

  /** Reflects the current page pair in the From/To header and guidance. */
  syncPanel(): void {
    const { elements, setUiText } = this.environment;
    const targetLanguage = this.environment.getTargetLanguage();
    const pair = reverseTranslationPair(this.environment.selectedPair());
    elements.fromLanguage.textContent = localizedLanguageName(targetLanguage, targetLanguage);
    elements.fromLanguage.setAttribute('lang', targetLanguage);
    if (!pair) {
      setUiText(elements.toLanguage, 'Waiting for website language');
      setUiText(
        elements.guidance,
        'Simul is still detecting the website language. If detection remains inconclusive, choose From in the toolbar.',
      );
      return;
    }
    delete elements.toLanguage.dataset.uiLabel;
    elements.toLanguage.textContent = localizedLanguageName(pair.targetLanguage, targetLanguage);
    elements.toLanguage.setAttribute('lang', targetLanguage);
    setUiText(
      elements.guidance,
      pair.sourceLanguage === pair.targetLanguage
        ? 'The languages match, so Simul will copy the text unchanged.'
        : 'Your draft stays only in this companion window and is not saved.',
    );
  }

  async translate(): Promise<void> {
    const { elements, provider, setStatus } = this.environment;
    const text = elements.input.value;
    const forwardPair = this.environment.selectedPair();
    const pair = reverseTranslationPair(forwardPair);
    if (!text.trim() || !forwardPair || !pair || this.#inFlight) return;
    this.#abortController?.abort();
    const abortController = new AbortController();
    this.#abortController = abortController;
    this.#inFlight = true;
    elements.output.value = '';
    elements.copyButton.disabled = true;
    this.#setComposerStatus('Translating locally…');
    this.environment.onActivityChange();
    let session: TranslationSession | undefined;
    try {
      let translated: string;
      if (pair.sourceLanguage === pair.targetLanguage) {
        translated = text;
      } else {
        translated = await this.environment.translateRemembered(pair, text, async (core) => {
          const composerAvailability = await provider.availability(pair);
          abortController.signal.throwIfAborted();
          if (composerAvailability === 'unavailable') {
            throw new Error('The reverse language pair is unavailable on this device.');
          }
          session = await provider.createSession(pair, { signal: abortController.signal });
          return translateWithSession(session, core, abortController.signal);
        });
      }
      const currentForwardPair = this.environment.selectedPair();
      if (
        abortController.signal.aborted ||
        this.#abortController !== abortController ||
        elements.input.value !== text ||
        !currentForwardPair ||
        currentForwardPair.sourceLanguage !== forwardPair.sourceLanguage ||
        currentForwardPair.targetLanguage !== forwardPair.targetLanguage
      ) return;
      elements.output.value = translated;
      elements.copyButton.disabled = elements.output.value.length === 0;
      this.#setComposerStatus('Translation is ready to copy.', 'success');
      setStatus('Reply translation is ready to copy. It was not saved.', 'success');
      this.environment.onTranslated?.();
    } catch (error) {
      if (!isAbortError(error) && !abortController.signal.aborted) {
        const message = `Could not translate the reply: ${this.environment.readableError(error)}`;
        this.#setComposerStatus(message, 'error');
        setStatus(message, 'error');
      } else if (this.#abortController === abortController) {
        this.#setComposerStatus('');
      }
    } finally {
      session?.destroy();
      if (this.#abortController === abortController) {
        this.#abortController = undefined;
        this.#inFlight = false;
        this.environment.onActivityChange();
      }
    }
  }

  /** Cancels an in-flight translation; returns whether one was running. */
  cancel(): boolean {
    const abortController = this.#abortController;
    const wasInFlight = this.#inFlight || abortController !== undefined;
    this.#abortController = undefined;
    this.#inFlight = false;
    abortController?.abort();
    if (wasInFlight) this.#setComposerStatus('');
    this.environment.onActivityChange();
    return wasInFlight;
  }

  /** Clears output after anything that changes the page or its languages. */
  invalidate(): void {
    this.cancel();
    this.environment.elements.output.value = '';
    this.environment.elements.copyButton.disabled = true;
    this.#setComposerStatus('');
    this.environment.onActivityChange();
  }

  /** Clears the draft as well; used when every setting is reset. */
  reset(): void {
    this.environment.elements.input.value = '';
    this.syncCharacterCount();
    this.environment.elements.output.value = '';
    this.invalidate();
  }

  async copy(): Promise<void> {
    const { elements, setStatus } = this.environment;
    if (!elements.output.value) return;
    try {
      const clipboard = this.environment.clipboard ?? navigator.clipboard;
      await clipboard.writeText(elements.output.value);
      this.#setComposerStatus('Translated text copied.', 'success');
      setStatus('Translated reply copied.', 'success');
    } catch {
      elements.output.focus();
      elements.output.select();
      this.#setComposerStatus(
        'Chrome could not copy automatically. The output is selected.',
        'warning',
      );
      setStatus('Chrome could not copy automatically. The result is selected for copying.', 'warning');
    }
  }

  #setComposerStatus(message: string, tone: ComposerStatusTone = 'normal'): void {
    this.environment.elements.status.textContent = message;
    this.environment.elements.status.dataset.tone = tone;
  }
}

/** A language's name in the given locale, falling back to its English name. */
export function localizedLanguageName(
  language: SupportedLanguage,
  locale: SupportedLanguage,
): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ??
      languageName(language);
  } catch {
    return languageName(language);
  }
}

/** The IDL property in Chrome; the attribute in DOM shims that lack it. */
function readMaxLength(input: HTMLTextAreaElement): number {
  return Number.isFinite(input.maxLength)
    ? input.maxLength
    : Number(input.getAttribute('maxlength') ?? -1);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
