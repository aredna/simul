import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  IMAGE_PROGRESS_LABEL,
  ToolbarStatus,
  type ToolbarActivityFlags,
} from '../entrypoints/sidepanel/toolbar-status';
import { UI_STRINGS } from '../lib/companion-ui-strings';
import { uiLanguageName, uiText } from '../lib/ui-text';

const IDLE: ToolbarActivityFlags = {
  captureInFlight: false,
  translationInFlight: false,
  permissionInFlight: false,
  composerInFlight: false,
  imageTranslationInFlight: false,
  surfaceTransitionInFlight: false,
};

function setup() {
  const translations = new Map<string, string>();
  const { document } = parseHTML(`<html><body>
    <nav id="toolbar">
      <span id="progress" hidden><span id="fill"></span></span>
      <button><span id="refresh-attention" hidden></span></button>
      <button><span id="settings-attention" hidden></span></button>
    </nav>
    <div id="region" hidden><label id="label"></label><progress id="bar" max="1" value="0"></progress></div>
    <p id="status"></p>
    <p id="announcer" role="status"></p>
  </body></html>`);
  const el = <T extends Element = HTMLElement>(id: string) =>
    document.getElementById(id) as unknown as T;
  let activity: ToolbarActivityFlags = IDLE;
  let settingsOpen = false;
  const status = new ToolbarStatus({
    elements: {
      status: el('status'),
      refreshAttention: el('refresh-attention'),
      settingsAttention: el('settings-attention'),
      toolbarProgress: el('progress'),
      toolbarProgressFill: el('fill'),
      compactToolbar: el('toolbar'),
      progressRegion: el('region'),
      progressLabel: el('label'),
      progressElement: el('bar'),
      announcer: el('announcer'),
    },
    localize: (english: string) => translations.get(english) ?? english,
    languageName: (language) => translations.get(`language:${language}`) ?? language,
    readActivity: () => activity,
    isSettingsOpen: () => settingsOpen,
  });
  return {
    el,
    status,
    translations,
    setActivity: (next: Partial<ToolbarActivityFlags>) => {
      activity = { ...activity, ...next };
    },
    setSettingsOpen: (open: boolean) => {
      settingsOpen = open;
    },
  };
}

describe('ToolbarStatus', () => {
  it('speaks warnings and errors in the always-present region only while Options is closed (D158)', () => {
    const { el, status, setSettingsOpen, translations } = setup();
    status.setStatus(UI_STRINGS.statusSettingsResetElsewhere, 'error');
    expect(el('announcer').textContent).toBe(UI_STRINGS.statusSettingsResetElsewhere);

    translations.set(UI_STRINGS.statusSettingsResetElsewhere, 'Restablecido en otro acompañante.');
    status.relocalize();
    expect(el('announcer').textContent).toBe('Restablecido en otro acompañante.');

    // Routine progress is not spoken, and clears the last warning.
    status.setStatus(UI_STRINGS.statusSettingsResetElsewhere, 'normal');
    expect(el('announcer').textContent).toBe('');

    // With Options open its own status line is in the page and speaks.
    setSettingsOpen(true);
    status.setStatus(UI_STRINGS.statusSettingsResetElsewhere, 'warning');
    expect(el('announcer').textContent).toBe('');
  });

  it('renders a filled status again in a new UI language (review L2-L4)', () => {
    const { el, status, translations } = setup();
    status.setStatus(uiText(
      UI_STRINGS.statusCouldNotSaveOptions,
      UI_STRINGS.statusSettingsResetElsewhere,
    ), 'error');
    const english = `Simul could not save the options: ${UI_STRINGS.statusSettingsResetElsewhere}`;
    expect(el('status').textContent).toBe(english);

    translations.set(UI_STRINGS.statusCouldNotSaveOptions, 'No se pudieron guardar las opciones: {0}');
    translations.set(UI_STRINGS.statusSettingsResetElsewhere, 'Restablecido en otro acompañante.');
    status.relocalize();
    expect(el('status').textContent)
      .toBe('No se pudieron guardar las opciones: Restablecido en otro acompañante.');
    // Routing and flows keep the English form.
    expect(status.statusText).toBe(english);

    status.setStatus(uiText(UI_STRINGS.statusReadyToTranslate, uiLanguageName('ja'), uiLanguageName('fr')));
    translations.set('language:ja', 'japonés');
    status.relocalize();
    expect(el('status').textContent).toContain('japonés');
  });

  it('routes warnings to the action that resolves them and keeps healthy state unmarked', () => {
    const { el, status } = setup();
    status.setStatus('The source page changed. Rebuild the mirror.', 'warning');
    expect(status.attention).toBe('refresh');
    expect(el('refresh-attention').hidden).toBe(false);
    expect(el('settings-attention').hidden).toBe(true);
    expect(el('refresh-attention').getAttribute('title')).toContain('Rebuild');
    expect(el<HTMLElement>('refresh-attention').dataset.tone).toBe('warning');

    status.setStatus('Grant image access in Options.', 'error');
    expect(status.attention).toBe('settings');
    expect(el('settings-attention').hidden).toBe(false);
    expect(el<HTMLElement>('settings-attention').dataset.tone).toBe('error');

    status.setStatus('Ready to translate.', 'success');
    expect(status.attention).toBeUndefined();
    expect(el('refresh-attention').hidden).toBe(true);
    expect(el('settings-attention').hidden).toBe(true);
    expect(status.statusText).toBe('Ready to translate.');
    expect(el<HTMLElement>('status').dataset.tone).toBe('success');
  });

  it('hides the settings marker while the settings overlay is open', () => {
    const { el, status, setSettingsOpen } = setup();
    status.setStatus('Choose a From language in Options.', 'warning');
    expect(el('settings-attention').hidden).toBe(false);
    setSettingsOpen(true);
    status.renderAttention();
    expect(el('settings-attention').hidden).toBe(true);
  });

  it('keeps a seen warning unmarked until another status replaces it (D241)', () => {
    const { el, status, setSettingsOpen } = setup();
    const marked = () => !el('settings-attention').hidden;
    status.setStatus('Choose a From language in Options.', 'warning');
    expect(marked()).toBe(true);
    // Seen in Options, it stays unmarked once Options closes, and the same
    // message set again meanwhile stays seen. The status line keeps it.
    setSettingsOpen(true);
    status.renderAttention();
    setSettingsOpen(false);
    status.renderAttention();
    expect(marked()).toBe(false);
    status.setStatus('Choose a From language in Options.', 'warning');
    expect(marked()).toBe(false);
    expect(el('status').textContent).toBe('Choose a From language in Options.');

    // Another warning is marked; so is the first one coming back after it.
    status.setStatus('Grant image access in Options.', 'error');
    expect(marked()).toBe(true);
    status.setStatus('Choose a From language in Options.', 'warning');
    expect(marked()).toBe(true);
    // A healthy status in between makes it new as well.
    setSettingsOpen(true);
    status.renderAttention();
    setSettingsOpen(false);
    status.setStatus('Ready to translate.', 'success');
    status.setStatus('Choose a From language in Options.', 'warning');
    expect(marked()).toBe(true);
  });

  it('presents determinate translation progress with accessible values', () => {
    const { el, status, setActivity } = setup();
    setActivity({ translationInFlight: true });
    status.showProgress('Page translation', 3, 4);
    const bar = el('progress');
    expect(bar.hidden).toBe(false);
    expect(el<HTMLElement>('progress').dataset.mode).toBe('determinate');
    expect(bar.getAttribute('aria-valuenow')).toBe('75');
    expect(bar.getAttribute('aria-valuetext')).toBe('Page translation 75%');
    expect(el('toolbar').getAttribute('aria-busy')).toBe('true');
    expect(el('bar').getAttribute('max')).toBe('4');
    expect(el('bar').getAttribute('value')).toBe('3');

    setActivity({ translationInFlight: false });
    status.hideProgress();
    expect(el('region').hidden).toBe(true);
    expect(bar.hidden).toBe(true);
    expect(bar.getAttribute('aria-label')).toBe('No activity');
    expect(bar.hasAttribute('aria-valuenow')).toBe(false);
    expect(el('toolbar').getAttribute('aria-busy')).toBe('false');
  });

  it('bounds progress values and labels indeterminate work by its activity', () => {
    const { el, status, setActivity } = setup();
    setActivity({ translationInFlight: true });
    status.showProgress('Downloading', 7, 0);
    expect(el('bar').getAttribute('max')).toBe('1');
    expect(el('bar').getAttribute('value')).toBe('1');
    expect(el('progress').getAttribute('aria-valuenow')).toBe('100');

    setActivity({ translationInFlight: false, captureInFlight: true });
    status.syncProgress();
    expect(el<HTMLElement>('progress').dataset.mode).toBe('indeterminate');
    expect(el('progress').getAttribute('aria-label')).toBe('Mirror build');
    expect(el('progress').hasAttribute('aria-valuenow')).toBe(false);
  });

  it('keeps the image progress row while OCR still runs after translation ends', () => {
    const { el, status, setActivity } = setup();
    setActivity({ translationInFlight: true, imageTranslationInFlight: true });
    status.showProgress('Page translation', 1, 2);
    setActivity({ translationInFlight: false });
    status.hideProgress();
    expect(el('region').hidden).toBe(false);
    expect(el('label').textContent).toBe(IMAGE_PROGRESS_LABEL);
    expect(el<HTMLElement>('progress').dataset.mode).toBe('indeterminate');
    expect(el('progress').getAttribute('aria-label')).toBe('Image text recognition');
    expect(el('bar').hasAttribute('value')).toBe(false);

    setActivity({ imageTranslationInFlight: false });
    status.hideProgress();
    expect(el('region').hidden).toBe(true);
    expect(el('bar').getAttribute('value')).toBe('0');
  });
});
