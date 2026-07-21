import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

const markup = readFileSync(
  new URL('../entrypoints/sidepanel/index.html', import.meta.url),
  'utf8',
);
const style = readFileSync(
  new URL('../entrypoints/sidepanel/style.css', import.meta.url),
  'utf8',
);
const script = readFileSync(
  new URL('../entrypoints/sidepanel/main.ts', import.meta.url),
  'utf8',
);

describe('sidepanel UI structure', () => {
  it('keeps one quick composer outside settings and exposes semantic progress', () => {
    const { document } = parseHTML(markup);
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')]
      .map((element) => element.id);

    expect(new Set(ids).size).toBe(ids.length);
    const progress = document.querySelector('#toolbar-progress');
    expect(progress?.getAttribute('role')).toBe('progressbar');
    expect(progress?.hasAttribute('aria-hidden')).toBe(false);
    expect(document.querySelector('#toggle-quick-translate')).not.toBeNull();
    expect(document.querySelector('#control-overlay #composer-input')).toBeNull();
    expect(document.querySelector('#quick-translator #composer-input')).not.toBeNull();
    expect(document.querySelector('#quick-translator #composer-output')).not.toBeNull();
  });

  it('orders every primary toolbar action in one direct row', () => {
    const { document } = parseHTML(markup);
    const controls = [...document.querySelectorAll<HTMLElement>(
      '#compact-toolbar button, #compact-toolbar select',
    )].map((element) => element.id);

    expect(controls).toEqual([
      'compact-refresh',
      'toolbar-auto-detect',
      'source-language',
      'swap-languages',
      'target-language',
      'toolbar-size-toggle',
      'toolbar-ocr-toggle',
      'toolbar-tab-follow',
      'toggle-quick-translate',
      'toggle-settings',
      'open-popout',
    ]);

    const toolbar = document.querySelector('#compact-toolbar');
    const fromLabel = toolbar?.querySelector('label[for="source-language"]');
    const auto = toolbar?.querySelector('#toolbar-auto-detect');
    const from = toolbar?.querySelector('#source-language');
    const state = toolbar?.querySelector('#replica-mode-badge');
    expect(fromLabel?.textContent?.trim()).toBe('From');
    expect((fromLabel?.compareDocumentPosition(auto as Node) ?? 0) & 4)
      .toBeTruthy();
    expect((auto?.compareDocumentPosition(from as Node) ?? 0) & 4)
      .toBeTruthy();
    expect(toolbar?.lastElementChild).toBe(state);
    expect(document.querySelector('main #replica-mode-badge')).toBeNull();
  });

  it('attaches warning state to actionable toolbar buttons without a healthy dot', () => {
    const { document } = parseHTML(markup);

    expect(document.querySelector('#status-dot')).toBeNull();
    expect(document.querySelector('#compact-refresh > #refresh-attention'))
      .not.toBeNull();
    expect(document.querySelector('#toggle-settings > #settings-attention'))
      .not.toBeNull();
    expect(style).toContain('.toolbar-attention[data-tone="warning"]');
    expect(style).toContain('.toolbar-attention[data-tone="error"]');
    expect(style).not.toContain('.status-dot[data-tone="success"]');
  });

  it('shows explicit OCR state and preserves compact button affordance', () => {
    const { document } = parseHTML(markup);
    expect(document.querySelector('#toolbar-ocr-label')?.textContent).toBe('OCR Off');
    expect(script).toContain("preferences.imageTranslationEnabled ? 'OCR On' : 'OCR Off'");
    expect(style).toContain('.toolbar-button {');
    expect(style).toContain('border: 1px solid var(--line)');
    expect(style).toContain('.toolbar-button[aria-pressed="true"]');
    expect(style).toContain('background: var(--control-background)');
  });

  it('keeps only the owned dropdown disclosure pointer-reachable in replay', () => {
    expect(style).toContain('.replica-replay-mount *');
    expect(style).toContain('pointer-events: none !important');
    expect(style).toContain(
      'iframe[data-simul-interaction-boundary="css-disclosure-v1"]',
    );
    expect(style).toContain('pointer-events: auto !important');
  });

  it('marks toolbar and settings copy for atomic target-language localization', () => {
    const { document } = parseHTML(markup);
    const settingsLabels = document.querySelectorAll(
      '#control-overlay [data-ui-label]',
    );

    expect(settingsLabels.length).toBeGreaterThan(20);
    expect(document.querySelector(
      '#compact-toolbar [data-ui-label="From"]',
    )).not.toBeNull();
    expect(document.querySelector(
      '#compact-toolbar [data-ui-label="To"]',
    )).not.toBeNull();
    expect(style).toContain('.toolbar-language-control select { width: 108px');
    expect(script).toContain('resolveUiLabelTranslations(');
    expect(script).toContain('translateRemembered(pair, source');
    expect(script).toContain("sourceLanguage: 'en'");
  });

  it('places common controls before engine and OCR experiments', () => {
    const { document } = parseHTML(markup);
    const experimental = document.querySelector('#experimental-options');

    expect(document.querySelector('#settings-grid #auto-translate-mode')).not.toBeNull();
    expect(document.querySelector('#settings-grid #sync-scroll')).not.toBeNull();
    expect(document.querySelector('#settings-grid #replica-fidelity-policy'))
      .not.toBeNull();
    expect(experimental?.querySelector('#replica-engine')).not.toBeNull();
    expect(experimental?.querySelector('#replica-view-mode')).not.toBeNull();
    expect(experimental?.querySelector('#image-analysis-host')).not.toBeNull();
    expect(markup.indexOf('id="settings-grid"'))
      .toBeLessThan(markup.indexOf('id="experimental-options"'));
  });

  it('offers only selectable fidelity policies with a visible request disclosure', () => {
    const { document } = parseHTML(markup);
    const select = document.querySelector<HTMLSelectElement>(
      '#replica-fidelity-policy',
    );
    const values = [...select?.querySelectorAll('option') ?? []]
      .map((option) => option.getAttribute('value'));
    const disclosure = document.querySelector('#replica-fidelity-disclosure');

    expect(values).toEqual(['passive', 'conservative']);
    expect(markup).not.toContain('value="strict-local"');
    expect(select?.getAttribute('aria-describedby')).toBe(
      'replica-fidelity-disclosure',
    );
    expect(disclosure?.textContent).toContain('additional HTTP(S) requests');
    expect(disclosure?.hasAttribute('data-ui-label')).toBe(true);
    expect(script).toContain('changeReplicaFidelityPolicy(');
    expect(script).toContain(
      'const saved = await commitViewPreferencePatch({ replicaFidelityPolicy })',
    );
    expect(script).toContain('!saved ||');
    expect(script).toContain("reason: 'preference'");
  });

  it('keeps From target-localized and To native while using explicit order', () => {
    expect(script).toContain('for (const language of LANGUAGE_OPTION_ORDER)');
    expect(script).toContain('createSourceLanguageLabeler(locale)');
    expect(script).toContain('languageEndonym(language)');
    expect(script).toContain("'#source-language [data-language-code]'");
    expect(script).not.toContain(
      "'#source-language [data-language-code], #target-language [data-language-code]'",
    );
  });

  it('does not follow a new active tab when its mode preference failed to save', () => {
    expect(script).toContain(
      'const saved = await commitViewPreferencePatch({ popoutTabMode })',
    );
    expect(script).toContain(
      '!saved || preferences.popoutTabMode !== popoutTabMode',
    );
  });

  it('keeps progress non-interactive and supports dark, narrow, and reduced-motion users', () => {
    expect(style).toContain('pointer-events: none');
    expect(style).toContain('@media (prefers-color-scheme: dark)');
    expect(style).toContain('@media (max-width: 360px)');
    expect(style).toContain('@media (prefers-reduced-motion: reduce)');
    expect(style).toContain('--surface: #111814');
    expect(style).toContain('grid-template-rows: auto minmax(0, 1fr)');
    expect(style).toContain('overflow-x: auto');
    expect(script).toContain("toolbarProgress.setAttribute('aria-valuenow'");
    expect(script).toContain('translateRemembered(pair, text');
    expect(script).toContain('composerAbortController === abortController');
    const replicaStyle = style.slice(
      style.lastIndexOf('.replica-preview {'),
      style.indexOf('.page-copy {'),
    );
    expect(replicaStyle).toContain('background: transparent');
    expect(replicaStyle).not.toContain('color-scheme: light');
    expect(replicaStyle).not.toContain('background: #fff');
  });
});
