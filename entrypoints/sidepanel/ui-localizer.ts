import {
  resolveUiLabelTranslations,
  shouldRetryUiLabelLocalization,
} from '../../lib/companion-ui-localization';
import { formatUiTemplate } from '../../lib/companion-ui-strings';
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
  /**
   * Fires after every DOM apply (a completed pass or an English fallback), so
   * imperatively written surfaces such as the status line can re-render their
   * last English message in the set that is now current.
   */
  readonly onApply?: () => void;
}

/**
 * Attributes localized from a `data-ui-*` marker that carries the English
 * source. The marker, not the live attribute, is the source of truth, so a
 * partially localized set can always fall back to English without losing it.
 */
const LOCALIZED_ATTRIBUTES = [
  { selector: '[data-ui-title]', datasetKey: 'uiTitle', attribute: 'title' },
  { selector: '[data-ui-aria-label]', datasetKey: 'uiAriaLabel', attribute: 'aria-label' },
  { selector: '[data-ui-placeholder]', datasetKey: 'uiPlaceholder', attribute: 'placeholder' },
] as const satisfies readonly {
  readonly selector: string;
  readonly datasetKey: string;
  readonly attribute: string;
}[];

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

  /**
   * The localized form of one English catalogue string in the current set, or
   * the English itself when the set is English, incomplete, or stale. Used by
   * imperatively written surfaces (status lines, code-driven attributes).
   */
  localized(english: string): string {
    if (this.#localizedTarget !== this.environment.getTargetLanguage()) {
      return english;
    }
    return this.#translations.get(english) ?? english;
  }

  /**
   * Localizes a template frame, then fills its numbered placeholders. The
   * frame is localized as a unit so the target language controls word order
   * around the interpolated values.
   */
  localizeTemplate(frame: string, ...args: readonly (string | number)[]): string {
    return formatUiTemplate(this.localized(frame), args);
  }

  /**
   * Sets a localized attribute from code. The English source is recorded on the
   * matching `data-ui-*` marker so the next pass re-localizes it, and the live
   * attribute is set to the current localized form immediately.
   */
  setAttribute(
    element: HTMLElement,
    attribute: 'title' | 'aria-label' | 'placeholder',
    english: string,
  ): void {
    const entry = LOCALIZED_ATTRIBUTES.find((item) => item.attribute === attribute);
    if (entry) element.dataset[entry.datasetKey] = english;
    const translated = this.localized(english);
    if (element.getAttribute(attribute) !== translated) {
      element.setAttribute(attribute, translated);
    }
    if (this.environment.getTargetLanguage() !== 'en' && !this.#translations.has(english)) {
      if (this.#translations.size > 0) {
        this.prepareEnglishFallback(this.environment.getTargetLanguage(), true);
      }
      this.schedule();
    }
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
        ...LOCALIZED_ATTRIBUTES.flatMap(({ selector, datasetKey }) =>
          [...document.querySelectorAll<HTMLElement>(selector)]
            .map((element) => element.dataset[datasetKey] ?? '')
            .filter(Boolean)),
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
    for (const { selector, datasetKey, attribute } of LOCALIZED_ATTRIBUTES) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        const english = element.dataset[datasetKey];
        if (!english) continue;
        const translated = this.#translations.get(english) ?? english;
        if (element.getAttribute(attribute) !== translated) {
          element.setAttribute(attribute, translated);
        }
      }
    }
    this.updateSourceLanguageOptionLabels(this.environment.getTargetLanguage());
    this.environment.onApply?.();
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
