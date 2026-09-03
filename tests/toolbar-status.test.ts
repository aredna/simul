import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  IMAGE_PROGRESS_LABEL,
  ToolbarStatus,
  type ToolbarActivityFlags,
} from '../entrypoints/sidepanel/toolbar-status';

const IDLE: ToolbarActivityFlags = {
  captureInFlight: false,
  translationInFlight: false,
  permissionInFlight: false,
  composerInFlight: false,
  liveDeltaInFlight: false,
  imageTranslationInFlight: false,
  surfaceTransitionInFlight: false,
};

function setup() {
  const { document } = parseHTML(`<html><body>
    <nav id="toolbar">
      <span id="progress" hidden><span id="fill"></span></span>
      <button><span id="refresh-attention" hidden></span></button>
      <button><span id="settings-attention" hidden></span></button>
    </nav>
    <div id="region" hidden><label id="label"></label><progress id="bar" max="1" value="0"></progress></div>
    <p id="status"></p>
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
    },
    readActivity: () => activity,
    isSettingsOpen: () => settingsOpen,
  });
  return {
    el,
    status,
    setActivity: (next: Partial<ToolbarActivityFlags>) => {
      activity = { ...activity, ...next };
    },
    setSettingsOpen: (open: boolean) => {
      settingsOpen = open;
    },
  };
}

describe('ToolbarStatus', () => {
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
  });

  it('hides the settings marker while the settings overlay is open', () => {
    const { el, status, setSettingsOpen } = setup();
    status.setStatus('Choose a From language in Options.', 'warning');
    expect(el('settings-attention').hidden).toBe(false);
    setSettingsOpen(true);
    status.renderAttention();
    expect(el('settings-attention').hidden).toBe(true);
  });

  it('presents determinate translation progress with accessible values', () => {
    const { el, status, setActivity } = setup();
    setActivity({ translationInFlight: true });
    status.showProgress('Translating page', 3, 4);
    const bar = el('progress');
    expect(bar.hidden).toBe(false);
    expect(el<HTMLElement>('progress').dataset.mode).toBe('determinate');
    expect(bar.getAttribute('aria-valuenow')).toBe('75');
    expect(bar.getAttribute('aria-valuetext')).toBe('Translating page 75%');
    expect(el('toolbar').getAttribute('aria-busy')).toBe('true');
    expect(el('bar').getAttribute('max')).toBe('4');
    expect(el('bar').getAttribute('value')).toBe('3');

    setActivity({ translationInFlight: false });
    status.hideProgress();
    expect(el('region').hidden).toBe(true);
    expect(bar.hidden).toBe(true);
    expect(bar.getAttribute('aria-label')).toBe('Companion idle');
    expect(el('toolbar').getAttribute('aria-busy')).toBe('false');
  });

  it('keeps the image progress row while OCR still runs after translation ends', () => {
    const { el, status, setActivity } = setup();
    setActivity({ translationInFlight: true, imageTranslationInFlight: true });
    status.showProgress('Translating page', 1, 2);
    setActivity({ translationInFlight: false });
    status.hideProgress();
    expect(el('region').hidden).toBe(false);
    expect(el('label').textContent).toBe(IMAGE_PROGRESS_LABEL);
    expect(el<HTMLElement>('progress').dataset.mode).toBe('indeterminate');
    expect(el('progress').getAttribute('aria-label')).toBe('Recognizing image text');
    expect(el('bar').hasAttribute('value')).toBe(false);
  });
});
