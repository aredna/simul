import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { DEFAULT_COMPANION_PREFERENCES } from '../lib/preferences';

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
const providerRegistry = readFileSync(
  new URL('../lib/ocr/provider-registry.ts', import.meta.url),
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

  it('announces mirror rebuilds and labels controls with their current action', () => {
    const { document } = parseHTML(markup);

    expect(document.querySelector('main > section')?.getAttribute('aria-busy'))
      .toBe('false');
    expect(document.querySelector('#replica-preview')?.getAttribute('aria-busy'))
      .toBe('false');
    expect(script).toContain(
      "replicaPreviewContainer.setAttribute('aria-busy', String(captureInFlight))",
    );
    expect(script).toContain(
      "captureInFlight ? 'Rebuilding mirror…' : 'Rebuild mirror'",
    );
    expect(script).toContain("translationInFlight\n      ? 'Translating…'");
  });

  it('shows the quick-translation input limit without announcing every keystroke', () => {
    const { document } = parseHTML(markup);
    const input = document.querySelector('#composer-input');
    const count = document.querySelector('#composer-character-count');

    expect(input?.getAttribute('maxlength')).toBe('5000');
    expect(input?.getAttribute('aria-describedby')).toContain(
      'composer-character-count',
    );
    expect(count?.textContent).toBe('0 / 5,000');
    expect(count?.hasAttribute('aria-live')).toBe(false);
    expect(script).toContain('function syncComposerCharacterCount()');
    expect(script).toContain('current >= maximum * 0.9');
    expect(style).toContain('.composer-character-count[data-near-limit="true"]');
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

  it('binds OCR provider availability probes to the current reset epoch', () => {
    const probeStart = script.indexOf(
      'async function refreshOcrProviderRuntimeStatuses',
    );
    const probeEnd = script.indexOf('\nfunction ', probeStart + 1);
    const probeSource = script.slice(
      probeStart,
      probeEnd === -1 ? undefined : probeEnd,
    );

    expect(probeStart).toBeGreaterThanOrEqual(0);
    expect(probeSource).toContain("kind: 'simul:ocr-v1:ensure-host'");
    expect(probeSource).toContain('resetEpoch: preferences.resetRevision');
  });

  it('binds ordinary image-option writes to the current settings revision', () => {
    const commitStart = script.indexOf(
      'async function commitImageAnalysisPreferencePatch',
    );
    const commitEnd = script.indexOf('\nasync function ', commitStart + 1);
    const commitSource = script.slice(
      commitStart,
      commitEnd === -1 ? undefined : commitEnd,
    );

    expect(commitStart).toBeGreaterThanOrEqual(0);
    expect(commitSource).toContain(
      'const expectedSettingsRevision = preferences.settingsRevision;',
    );
    expect(commitSource).toContain('expectedSettingsRevision,');
    expect(commitSource).toContain("result.code === 'stale-settings-revision'");
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

  it('renders an accessible persisted OCR confidence control in exact five-percent steps', () => {
    expect(script).toContain("confidenceInput.id = 'ocr-minimum-confidence'");
    expect(script).toContain("confidenceInput.type = 'range'");
    expect(script).toContain("confidenceInput.min = '25'");
    expect(script).toContain("confidenceInput.max = '95'");
    expect(script).toContain("confidenceInput.step = '5'");
    expect(script).toContain(
      "confidenceInput.value = String(preferences.ocrMinimumConfidence * 100)",
    );
    expect(script).toContain("'ocr-minimum-confidence-help'");
    expect(script).toContain('OCR_MINIMUM_CONFIDENCE_OPTIONS.includes(selected)');
    expect(script).toContain('commitImageAnalysisPreferencePatch({');
    expect(script).toContain('ocrMinimumConfidence: selected');
    expect(style).toContain('.ocr-confidence-control');
    expect(style).toContain('.ocr-confidence-row input');
  });

  it('keeps every image-reading method visible, toggleable, and ordered', () => {
    expect(script).toContain("enabled.type = 'checkbox'");
    expect(script).toContain('preferences.disabledImageReadingMethodIds');
    expect(script).toContain('disabledImageReadingMethodIds: preferences.imageReadingMethodOrder');
    expect(script).toContain("return 'Accessibility text (aria-label / alt)'");
    expect(script).toContain("status.textContent = 'No pixels'");
    expect(script).toContain("'paddleocr-wasm': 'PaddleOCR Wasm'");
    expect(script).toContain(
      "'chrome-text-detector': 'Chrome TextDetector (platform)'",
    );
    expect(script).toContain("tesseract: 'Tesseract.js (wrapper A/B)'");
    expect(script).toContain("'tesseract-wasm-direct': 'Tesseract Wasm (direct A/B)'");
    expect(DEFAULT_COMPANION_PREFERENCES.imageReadingMethodOrder.slice(0, 5))
      .toEqual([
        'accessibility-text',
        'paddleocr-wasm',
        'chrome-text-detector',
        'tesseract',
        'tesseract-wasm-direct',
      ]);
    expect(providerRegistry).toContain(
      'ACCESSIBILITY_IMAGE_TEXT_COMPILED ||',
    );
    expect(script).toContain('visibleImageReadingMethodOrder(');
    expect(script).toContain('Chrome TextDetector is experimental and platform-dependent');
    expect(script).toContain('same Tesseract OCR family and local language models');
    expect(script).toContain('do not independently corroborate each other');
    expect(script).toContain('OCR is paused because every compiled provider is off.');
    expect(style).toContain('.ocr-provider-toggle');
  });

  it('offers first-run read-scope setup, live independent controls, and reset', () => {
    const { document } = parseHTML(markup);
    const setup = document.querySelector('#read-scope-setup');
    const controls = document.querySelector('#read-scope-controls');

    expect(setup?.localName).toBe('dialog');
    expect(setup?.getAttribute('aria-modal')).toBe('true');
    expect(setup?.getAttribute('aria-describedby')).toBe(
      'read-scope-setup-description',
    );
    expect(setup?.querySelector('#setup-read-profile')?.hasAttribute('autofocus')).toBe(true);
    expect(setup?.querySelector('#setup-read-profile')).not.toBeNull();
    expect(setup?.querySelector('#complete-read-scope-setup')).not.toBeNull();
    expect(
      setup
        ?.querySelector<HTMLOptionElement>('option[value="custom"]')
        ?.hasAttribute('disabled'),
    ).toBe(true);
    expect(
      document
        .querySelector<HTMLOptionElement>(
          '#read-scope-profile option[value="custom"]',
        )
        ?.hasAttribute('disabled'),
    ).toBe(true);
    const setupCleanup = setup?.querySelector('#setup-reset-cleanup');
    const setupCleanupRetry = setupCleanup?.querySelector(
      '#retry-setup-reset-cleanup',
    );
    expect(setupCleanup).not.toBeNull();
    expect(setupCleanupRetry?.getAttribute('aria-describedby')).toBe(
      'setup-reset-cleanup-status',
    );
    expect(setupCleanup?.querySelector('[role="status"]')).not.toBeNull();
    expect(document.querySelector('#read-scope-profile')).not.toBeNull();
    expect(controls).not.toBeNull();
    expect(script).toContain('for (const key of REPLICA_READ_SCOPE_KEYS)');
    expect(script).toContain('READ_SCOPE_COPY[key].label');
    expect(document.querySelector('#reset-all-settings')).not.toBeNull();
    const resetDialog = document.querySelector('#reset-settings-dialog');
    expect(resetDialog?.localName).toBe('dialog');
    expect(resetDialog?.getAttribute('aria-modal')).toBe('true');
    expect(resetDialog?.getAttribute('aria-labelledby')).toBe(
      'reset-settings-dialog-title',
    );
    expect(resetDialog?.getAttribute('aria-describedby')).toBe(
      'reset-settings-dialog-description',
    );
    expect(resetDialog?.querySelector('button[value="cancel"]')).not.toBeNull();
    expect(resetDialog?.querySelector('button[value="reset"]')).not.toBeNull();
    expect(script).not.toContain('window.confirm(');
    expect(script).toContain('installResetConfirmationController({');
    expect(script).toContain('readScopeSetup.showModal()');
    expect(script).toContain("readScopeSetup.addEventListener('cancel'");
    expect(script).toContain("resetSettingsDialog.close('cancel')");
    expect(script).toContain('preferences.resetCleanupPendingRevision > 0');
    expect(script).toContain("type: 'simul:preferences:patch-read-scope'");
    expect(script).toContain("type: 'simul:preferences:complete-read-scope-setup'");
    expect(script).toContain(
      'expectedSetupVersion: preferences.readScopeSetupVersion',
    );
    expect(script).toContain("type: 'simul:preferences:reset-all'");
    expect(script).toContain('purgeSourceDerivedRuntime(');
    expect(script).toContain(
      'localReadScopeNarrowingGates.set(sequence',
    );
    expect(script).toContain(
      'remoteReadScopeNarrowingGates.prepare(',
    );
    expect(script).toContain(
      'remoteReadScopeNarrowingGates.authorizeCommittedRelease(',
    );
    expect(script).toContain('new PreferenceSafetyClient({');
    expect(script).toContain(
      'const enabledPixelProviders = enabledUsablePixelOcrProviderOrder()',
    );
    expect(script).toContain(
      "imageCaptureAccess !== 'granted' &&\n    enabledUsablePixelOcrProviderOrder().length > 0",
    );
    expect(script).toContain(
      'const shouldRequestPixelAccess = requestPixelAccess &&',
    );
    expect(script).toContain(
      'Accessibility image text remains active; only pixel OCR is paused.',
    );
    expect(script).toContain('handlePreferenceSafetyMessage(message, reply)');
    expect(script).toContain('preferenceSafetyConnectionReady = false');
    expect(script).toContain('await purge;');
    expect(script).toContain('requireConfirmedLegacyTeardown');
    expect(script).toContain('isConfirmedLivePageObserverRelease(results)');
    expect(script).toContain(
      'scope = intersectReplicaReadScopes(scope, PAGE_ONLY_REPLICA_READ_SCOPE)',
    );
    expect(script).toContain('livePreferenceStorageFailClosed');
    expect(script).toContain('selectLiveCompanionPreferenceChange(');
    expect(script).toContain('retrySetupResetCleanupButton.focus()');
    expect(script).toContain(
      "retrySetupResetCleanupButton.addEventListener('click'",
    );
    expect(script).toContain('expectedReadScopeFingerprint:');
    const purgeStart = script.indexOf(
      'function purgeSourceDerivedRuntime(message: string)',
    );
    const purgeEnd = script.indexOf(
      'function clearResetOnlyRuntimeState()',
      purgeStart,
    );
    const purgeFunction = script.slice(purgeStart, purgeEnd);
    expect(purgeFunction).toContain('translationMemory.clear()');
    expect(purgeFunction).toContain('imageTranslationMemory.clear()');
    expect(script).toContain('resetEpoch: preferences.resetRevision');
    expect(script).toContain(
      'preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION',
    );

    const resetStart = script.indexOf(
      'async function resetAllExtensionSettings()',
    );
    const resetEnd = script.indexOf(
      'function purgeSourceDerivedRuntime',
      resetStart,
    );
    const resetFunction = script.slice(resetStart, resetEnd);
    expect(resetFunction.indexOf("result.code === 'stale-reset-revision'"))
      .toBeLessThan(resetFunction.indexOf('purgeSourceDerivedRuntime('));
  });

  it('never waits for the background while holding the background preference lock', () => {
    expect(script).not.toContain('navigator.locks.request(');
    expect(script).not.toContain('PREFERENCE_LOCK_NAME');
    expect(script).toContain(
      'expectedSettingsRevision: freshPreferences.settingsRevision',
    );
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
