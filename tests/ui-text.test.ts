import { describe, expect, it } from 'vitest';

import { UI_STRINGS } from '../lib/companion-ui-strings';
import {
  englishUiText,
  renderUiText,
  uiLanguageName,
  uiText,
  type UiTextRenderer,
} from '../lib/ui-text';

const spanish: UiTextRenderer = {
  localize: (english) => ({
    [UI_STRINGS.statusCouldNotSaveOptions]: 'No se pudieron guardar las opciones: {0}',
    [UI_STRINGS.statusSettingsResetElsewhere]: 'La configuración se restableció en otro acompañante.',
    [UI_STRINGS.statusReadyToTranslate]: 'Listo para traducir {0} a {1}.',
  } as Record<string, string>)[english] ?? english,
  languageName: (language) => ({ ja: 'japonés', fr: 'francés' } as Record<string, string>)[language] ?? language,
};

describe('UI text', () => {
  it('localizes a catalogue sentence used as a detail (review L4)', () => {
    const text = uiText(
      UI_STRINGS.statusCouldNotSaveOptions,
      UI_STRINGS.statusSettingsResetElsewhere,
    );
    expect(renderUiText(text, spanish)).toBe(
      'No se pudieron guardar las opciones: La configuración se restableció en otro acompañante.',
    );
    // Text that is not in the catalogue passes through unchanged.
    expect(renderUiText(uiText(UI_STRINGS.statusCouldNotSaveOptions, 'QuotaExceededError'), spanish))
      .toBe('No se pudieron guardar las opciones: QuotaExceededError');
  });

  it('names languages with the renderer, in the language the UI shows (review L3)', () => {
    const text = uiText(
      UI_STRINGS.statusReadyToTranslate,
      uiLanguageName('ja'),
      uiLanguageName('fr'),
    );
    expect(renderUiText(text, spanish)).toBe('Listo para traducir japonés a francés.');
    expect(englishUiText(text)).toBe('Ready to translate Japanese to French on-device.');
  });

  it('renders composed text through the renderer and keeps an English form', () => {
    const text = {
      compose: (renderer: UiTextRenderer) =>
        `${renderer.localize(UI_STRINGS.statusSettingsResetElsewhere)} (2)`,
    };
    expect(renderUiText(text, spanish))
      .toBe('La configuración se restableció en otro acompañante. (2)');
    expect(englishUiText(text)).toBe(`${UI_STRINGS.statusSettingsResetElsewhere} (2)`);
  });
});
