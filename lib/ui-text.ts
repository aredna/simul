import { formatUiTemplate } from './companion-ui-strings';
import { languageName, type SupportedLanguage } from './translation-provider';

/**
 * Companion text kept in a form that can be rendered in whatever language the
 * UI is in now. A status line stores it instead of a rendered string, so a
 * language switch re-renders it (review L2). A frame's arguments may be UI
 * text themselves, such as a catalogue sentence used as an error detail
 * (L4), or a language, which is named in the UI's language (L3).
 */
export type UiText =
  | string
  | UiTemplateText
  | UiComposedText;

export interface UiTemplateText {
  readonly frame: string;
  readonly args: readonly UiTextArgument[];
}

/** Several catalogue entries assembled by code (for example a summary). */
export interface UiComposedText {
  readonly compose: (renderer: UiTextRenderer) => string;
}

export type UiTextArgument = UiText | number | UiLanguageName;

export interface UiLanguageName {
  readonly language: SupportedLanguage;
}

export interface UiTextRenderer {
  /** One English catalogue string in the current UI language. */
  readonly localize: (english: string) => string;
  /** A language's name in the language the UI is rendered in. */
  readonly languageName: (language: SupportedLanguage) => string;
}

/** A catalogue frame with its arguments, rendered when shown. */
export function uiText(
  frame: string,
  ...args: readonly UiTextArgument[]
): UiTemplateText {
  return Object.freeze({ frame, args: Object.freeze([...args]) });
}

export function uiLanguageName(language: SupportedLanguage): UiLanguageName {
  return Object.freeze({ language });
}

export function renderUiText(text: UiText, renderer: UiTextRenderer): string {
  if (typeof text === 'string') return renderer.localize(text);
  if ('compose' in text) return text.compose(renderer);
  return formatUiTemplate(
    renderer.localize(text.frame),
    text.args.map((argument) => renderUiTextArgument(argument, renderer)),
  );
}

export const ENGLISH_UI_TEXT_RENDERER: UiTextRenderer = Object.freeze({
  localize: (english: string) => english,
  languageName: (language: SupportedLanguage) => languageName(language),
});

/** The English form, used for attention routing and flows that branch on it. */
export function englishUiText(text: UiText): string {
  return renderUiText(text, ENGLISH_UI_TEXT_RENDERER);
}

function renderUiTextArgument(
  argument: UiTextArgument,
  renderer: UiTextRenderer,
): string | number {
  if (typeof argument === 'number') return argument;
  if (typeof argument === 'object' && 'language' in argument) {
    return renderer.languageName(argument.language);
  }
  return renderUiText(argument, renderer);
}
