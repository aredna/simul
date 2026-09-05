import {
  resolveUiLabelTranslations,
  shouldRetryUiLabelLocalization,
} from '../../lib/companion-ui-localization';
import { createSourceLanguageLabeler } from '../../lib/language-options';
import { translateWithSession } from '../../lib/translation-pipeline';
import type {
  SupportedLanguage,
  TranslationPair,
  TranslationProvider,
  TranslationSession,
} from '../../lib/translation-provider';

export const UI_LOCALIZATION_RETRY_DELAY_MS = 1_500;

export interface UiLocalizerEnvironment {
  readonly document: Document;
  readonly provider: TranslationProvider;
  /** English labels that are set from code rather than present in the markup. */
  readonly dynamicLabels: readonly string[];
  readonly getTargetLanguage: () => SupportedLanguage;
  /** Memory-backed translation of one label; the loader runs on a miss. */
  readonly translateRemembered: (
    pair: TranslationPair,
    source: string,
    load: (core: string) => Promise<string>,
  ) => Promise<string>;
  /** Defers one localization pass; defaults to queueMicrotask. */
  readonly schedule?: (callback: () => void) => void;
  /** Delay before the single retry of a label set that was not installed. */
  readonly retryDelayMs?: number;
}

/**
 * Localizes every `[data-ui-label]` element into the target language as one
 * complete set. If any label cannot be translated locally the whole interface
 * stays English rather than mixing languages, and a stale asynchronous
 * result can never overwrite a newer target selection.
 *
 * Localization runs without a user gesture, so it only uses an installed
 * language pair. A set that could not be localized is retried once after a
 * delay, and again when a page translation has prepared the pair.
 */
export class UiLocalizer {
  #requestId = 0;
  #inputKey = '';
  #scheduled = false;
  #abortController: AbortController | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retriedInputKey = '';
  #localizedTarget: SupportedLanguage = 'en';
  #translations: ReadonlyMap<string, string> = new Map();

  constructor(private readonly environment: UiLocalizerEnvironment) {}

  /** The language the current label set is rendered in. */
  get localizedTarget(): SupportedLanguage {
    return this.#localizedTarget;
  }

  get translations(): ReadonlyMap<string, string> {
    return this.#translations;
  }

  /** True while the single delayed retry for the current label set is armed. */
  get retryPending(): boolean {
    return this.#retryTimer !== undefined;
  }

  /** Sets an element's English label and renders it in the current set. */
  setText(element: HTMLElement, english: string): void {
    const targetLanguage = this.environment.getTargetLanguage();
    element.dataset.uiLabel = english;
    const translated = this.#localizedTarget === targetLanguage
      ? this.#translations.get(english)
      : undefined;
    const text = translated ?? english;
    if (element.textContent !== text) element.textContent = text;
    if (translated && translated !== english) {
      element.setAttribute('lang', this.#localizedTarget);
    } else {
      element.removeAttribute('lang');
    }
    if (targetLanguage !== 'en' && !this.#translations.has(english)) {
      // A label outside the localized set means the set is incomplete;
      // fall back to English as a whole and localize again.
      if (this.#translations.size > 0) {
        this.prepareEnglishFallback(targetLanguage, true);
      }
      this.schedule();
    }
  }

  schedule(): void {
    this.prepareEnglishFallback(this.environment.getTargetLanguage());
    if (this.#scheduled) return;
    this.#scheduled = true;
    (this.environment.schedule ?? queueMicrotask)(() => {
      this.#scheduled = false;
      void this.localize();
    });
  }

  /** Abandons in-flight and retry work, e.g. when the page is unloading. */
  dispose(): void {
    this.#abortController?.abort();
    this.#abortController = undefined;
    this.#clearRetry();
  }

  prepareEnglishFallback(targetLanguage: SupportedLanguage, force = false): void {
    if (this.#localizedTarget === targetLanguage && !force) return;
    this.#abortController?.abort();
    this.#clearRetry();
    this.#retriedInputKey = '';
    this.#inputKey = '';
    this.#translations = new Map();
    this.#localizedTarget = targetLanguage;
    this.applyToDom();
  }

  async localize(): Promise<void> {
    const { document, provider } = this.environment;
    const targetLanguage = this.environment.getTargetLanguage();
    this.prepareEnglishFallback(targetLanguage);
    const sources = [...new Set(
      [
        ...this.environment.dynamicLabels,
        ...[...document.querySelectorAll<HTMLElement>('[data-ui-label]')]
          .map((element) => element.dataset.uiLabel ?? '')
          .filter(Boolean),
      ],
    )];
    const inputKey = JSON.stringify([targetLanguage, sources]);
    if (this.#inputKey === inputKey) return;
    this.#inputKey = inputKey;
    const requestId = ++this.#requestId;
    this.#abortController?.abort();
    const abortController = new AbortController();
    this.#abortController = abortController;
    const pair: TranslationPair = { sourceLanguage: 'en', targetLanguage };
    let session: TranslationSession | undefined;
    let sessionTask: Promise<TranslationSession> | undefined;
    try {
      const result = await resolveUiLabelTranslations(
        sources,
        targetLanguage,
        (source) => this.environment.translateRemembered(pair, source, async (core) => {
          sessionTask ??= (async () => {
            const availability = await provider.availability(pair);
            abortController.signal.throwIfAborted();
            // Label localization runs without a user gesture, so it may only
            // use an already-installed pair. A downloadable pair would either
            // start a multi-megabyte download as a side effect of a menu
            // choice or throw NotAllowedError (review D14). The Translate page
            // click prepares the pair; labels follow once it has been used.
            if (availability !== 'available') {
              throw new Error('The UI language pair is not installed yet.');
            }
            return provider.createSession(pair, { signal: abortController.signal });
          })();
          session = await sessionTask;
          return translateWithSession(session, core, abortController.signal);
        }),
      );
      if (
        abortController.signal.aborted ||
        this.#abortController !== abortController ||
        requestId !== this.#requestId ||
        this.environment.getTargetLanguage() !== targetLanguage ||
        this.#inputKey !== inputKey
      ) return;
      this.#localizedTarget = targetLanguage;
      this.#translations = result.labels;
      this.applyToDom();
      if (shouldRetryUiLabelLocalization(
        inputKey,
        this.#retriedInputKey,
        targetLanguage,
        result,
      )) {
        this.#retriedInputKey = inputKey;
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = undefined;
          if (
            this.environment.getTargetLanguage() !== targetLanguage ||
            this.#inputKey !== inputKey
          ) return;
          this.#inputKey = '';
          this.schedule();
        }, this.environment.retryDelayMs ?? UI_LOCALIZATION_RETRY_DELAY_MS);
      } else if (result.localized || targetLanguage === 'en') {
        this.#retriedInputKey = '';
      }
    } finally {
      session?.destroy();
      if (this.#abortController === abortController) {
        this.#abortController = undefined;
      }
    }
  }

  /**
   * The retry budget is one pass per label set. A page translation may have
   * just installed the pair that pass was missing, so let the labels follow
   * instead of waiting for the next label-set change or a reload.
   */
  retryAfterPagePairPrepared(): void {
    if (!this.#retriedInputKey) return;
    this.#clearRetry();
    this.#retriedInputKey = '';
    this.#inputKey = '';
    this.schedule();
  }

  applyToDom(): void {
    const { document } = this.environment;
    for (const element of document.querySelectorAll<HTMLElement>('[data-ui-label]')) {
      const english = element.dataset.uiLabel;
      if (!english) continue;
      const translated = this.#translations.get(english) ?? english;
      if (element.textContent !== translated) element.textContent = translated;
      if (translated === english) element.removeAttribute('lang');
      else element.setAttribute('lang', this.#localizedTarget);
    }
    this.updateSourceLanguageOptionLabels(this.environment.getTargetLanguage());
  }

  /** From-menu entries show each language's name in the target language. */
  updateSourceLanguageOptionLabels(locale: SupportedLanguage): void {
    const labelLanguage = createSourceLanguageLabeler(locale);
    for (const option of this.environment.document.querySelectorAll<HTMLOptionElement>(
      '#source-language [data-language-code]',
    )) {
      const language = option.dataset.languageCode as SupportedLanguage | undefined;
      if (!language) continue;
      option.textContent = labelLanguage(language);
      option.setAttribute('lang', locale);
      option.setAttribute('dir', 'auto');
    }
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }
}
