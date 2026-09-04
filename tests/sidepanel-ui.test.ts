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
const localizerScript = readFileSync(
  new URL('../entrypoints/sidepanel/ui-localizer.ts', import.meta.url),
  'utf8',
);
const composerScript = readFileSync(
  new URL('../entrypoints/sidepanel/quick-composer.ts', import.meta.url),
  'utf8',
);
const toolbarStatusScript = readFileSync(
  new URL('../entrypoints/sidepanel/toolbar-status.ts', import.meta.url),
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
    expect(localizerScript).toContain('resolveUiLabelTranslations(');
    expect(localizerScript).toContain('translateRemembered(pair, source');
    expect(localizerScript).toContain("sourceLanguage: 'en'");
  });

  it('places common controls before engine and OCR experiments', () => {
    const { document } = parseHTML(markup);
    const experimental = document.querySelector('#experimental-options');

    expect(document.querySelector('#settings-grid #auto-translate-mode')).not.toBeNull();
    expect(document.querySelector('#settings-grid #sync-scroll')).not.toBeNull();
    expect(document.querySelector('#settings-grid #replica-fidelity-policy'))
      .not.toBeNull();
    expect(document.querySelector('#replica-engine')).toBeNull();
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
    expect(localizerScript).toContain('createSourceLanguageLabeler(locale)');
    expect(script).toContain('languageEndonym(language)');
    expect(localizerScript).toContain("'#source-language [data-language-code]'");
    expect(localizerScript).not.toContain(
      "'#source-language [data-language-code], #target-language [data-language-code]'",
    );
  });

  it('does not follow a new active tab when its mode preference failed to save', () => {
    expect(script).toContain(
      'const saved = await commitViewPreferencePatch({ popoutTabMode })',
    );
    expect(script).toContain(
      '!saved || state.preferences.popoutTabMode !== popoutTabMode',
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
    expect(toolbarStatusScript).toContain("toolbarProgress.setAttribute('aria-valuenow'");
    expect(composerScript).toContain('translateRemembered(pair, text');
    // The composer applies a result only if its own request is still current.
    expect(composerScript).toContain('this.#abortController !== abortController');
    const replicaStyle = style.slice(
      style.lastIndexOf('.replica-preview {'),
      style.indexOf('.page-copy {'),
    );
    expect(replicaStyle).toContain('background: transparent');
    expect(replicaStyle).not.toContain('color-scheme: light');
    expect(replicaStyle).not.toContain('background: #fff');
  });
});

describe('availability check currency', () => {
  it('records the checked pair only after a result is accepted', () => {
    const start = script.indexOf('async function checkAvailability(');
    const end = script.indexOf('async function maybeTranslateAutomatically(');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = script.slice(start, end);
    const awaitIndex = body.indexOf('await provider.availability(pair)');
    const recordIndex = body.indexOf('availabilityCheckedForPair = checkedPairKey;');
    expect(awaitIndex).toBeGreaterThan(0);
    // The same-language shortcut records synchronously; the awaited path must
    // record only after the currency guard so a superseded request cannot
    // leave the pair marked as checked while availability stays unavailable.
    const awaitedRecord = body.indexOf(
      'availabilityCheckedForPair = checkedPairKey;',
      awaitIndex,
    );
    expect(recordIndex).toBeGreaterThan(0);
    expect(awaitedRecord).toBeGreaterThan(awaitIndex);
    expect(body.slice(awaitIndex, awaitedRecord)).toContain(
      'isCurrentAvailabilityRequest(',
    );
    expect(body.slice(0, awaitIndex)).not.toMatch(
      /availabilityCheckedForPair = checkedPairKey;[\s\S]*availability = 'unavailable';/u,
    );
  });

  it('re-establishes availability after any language-refreshing commit', () => {
    const start = script.indexOf('async function reconcileReplicaTranslationAfterCommit(');
    const end = script.indexOf('function* replicaRecordSources(');
    const body = script.slice(start, end);
    expect(body).toContain('(prepareForNewText || refreshDetectedLanguage) &&');

    const resolveStart = script.indexOf('async function resolveSelectedSourceLanguage(');
    const resolveEnd = script.indexOf('function mirrorLanguageSample(');
    const resolveBody = script.slice(resolveStart, resolveEnd);
    expect(resolveBody).toContain('snapshotWithLiveDocumentLanguage(');
    expect(resolveBody).not.toContain('...snapshotWithoutLanguage');
  });
});

describe('source navigation handling', () => {
  it('treats a hash or query change without a load as the same document', () => {
    const start = script.indexOf('browser.tabs.onUpdated.addListener(');
    const end = script.indexOf('browser.tabs.onRemoved.addListener(');
    const body = script.slice(start, end);
    const sameDocument = body.indexOf(
      "normalizedPageUrl(nextUrl) === normalizedPageUrl(followed.url)",
    );
    const invalidate = body.indexOf('captureCoordinator.invalidate();');
    expect(sameDocument).toBeGreaterThan(0);
    expect(invalidate).toBeGreaterThan(sameDocument);
  });

  it('leaves the navigation refresh armed while focus moves between windows', () => {
    const start = script.indexOf('browser.windows.onFocusChanged.addListener(');
    const end = script.indexOf('browser.tabs.onAttached.addListener(');
    expect(script.slice(start, end)).not.toContain('clearNavigationTimer()');

    const followStart = script.indexOf('async function followActivatedSourceTab(');
    const followEnd = script.indexOf('\nasync function ', followStart + 1);
    expect(followStart).toBeGreaterThan(0);
    expect(followEnd).toBeGreaterThan(followStart);
    const follow = script.slice(followStart, followEnd);
    expect(follow).not.toContain('clearNavigationTimer()');
    expect(follow).toContain("queueCapture({ identity, reason: 'navigation' });");
  });
});

describe('dark-mode focus ring', () => {
  it('overrides the light focus ring inside the dark color-scheme block', () => {
    const darkBlock = style.slice(style.indexOf('@media (prefers-color-scheme: dark)'));
    expect(darkBlock).toContain('input:focus-visible { outline-color: rgb(123 217 170 / 75%); }');
  });
});
