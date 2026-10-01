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
const imageConfig = readFileSync(
  new URL('../entrypoints/sidepanel/image-translation-config.ts', import.meta.url),
  'utf8',
);
const readScope = readFileSync(
  new URL('../entrypoints/sidepanel/read-scope-controller.ts', import.meta.url),
  'utf8',
);
const capturePipeline = readFileSync(
  new URL('../entrypoints/sidepanel/capture-pipeline.ts', import.meta.url),
  'utf8',
);
const translationDriver = readFileSync(
  new URL('../entrypoints/sidepanel/translation-driver.ts', import.meta.url),
  'utf8',
);
const permissionFlows = readFileSync(
  new URL('../entrypoints/sidepanel/permission-flows.ts', import.meta.url),
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
      "replicaPreviewContainer.setAttribute('aria-busy', String(state.captureInFlight))",
    );
    expect(script).toContain(
      'state.captureInFlight ? UI_STRINGS.rebuildingMirrorEllipsis : UI_STRINGS.rebuildMirror',
    );
    expect(script).toContain('state.translationInFlight\n      ? UI_STRINGS.translating');
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
    expect(script).toContain('quickComposer.install();');
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
    expect(script).toContain(
      'state.preferences.imageTranslationEnabled ? UI_STRINGS.ocrOn : UI_STRINGS.ocrOff',
    );
    expect(style).toContain('.toolbar-button {');
    expect(style).toContain('border: 1px solid var(--line)');
    expect(style).toContain('.toolbar-button[aria-pressed="true"]');
    expect(style).toContain('background: var(--control-background)');
  });

  it('binds OCR provider availability probes to the current reset epoch', () => {
    const probeStart = imageConfig.indexOf('async refreshProviderRuntimeStatuses(');
    const probeEnd = imageConfig.indexOf('#disabledMethodIds(', probeStart);
    const probeSource = imageConfig.slice(probeStart, probeEnd);

    expect(probeStart).toBeGreaterThanOrEqual(0);
    expect(probeSource).toContain("kind: 'simul:ocr-v1:ensure-host'");
    expect(probeSource).toContain('resetEpoch: state.preferences.resetRevision');
    expect(script).toContain('() => imageTranslationConfig.refreshProviderRuntimeStatuses(),');
  });

  it('does not block the first mirror on optional OCR readiness probes', () => {
    const initializeStart = script.indexOf('async function initialize()');
    const initializeEnd = script.indexOf(
      '\nasync function initializeSourcePage()',
      initializeStart,
    );
    const initializeSource = script.slice(initializeStart, initializeEnd);

    expect(initializeStart).toBeGreaterThanOrEqual(0);
    expect(initializeSource).toContain(
      'startBestEffortBackgroundTasks([',
    );
    expect(initializeSource).toContain('initializeSourcePage(),');
    expect(initializeSource).not.toContain(
      'await Promise.all([\n    refreshImageCaptureAccess()',
    );
    expect(initializeSource).not.toContain('await optionalReadiness;');
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
    expect(script).toContain('new UiLocalizer({');
    expect(script).toContain('dynamicLabels: DYNAMIC_UI_LABELS,');
  });

  it('gives every code-written text surface its language and direction (review L9)', () => {
    const list = /const CODE_WRITTEN_TEXT_SELECTOR = \[([^\]]*)\]/u.exec(script)?.[1] ?? '';
    const ids = [...list.matchAll(/'#([a-z-]+)'/gu)].map((match) => match[1]!);
    expect(ids).toEqual(expect.arrayContaining([
      'status', 'progress-label', 'detected-language', 'composer-status',
    ]));
    for (const id of ids) expect(markup, id).toContain(`id="${id}"`);
    expect(script).toContain("element.setAttribute('dir', 'auto');");
  });

  it('places common controls before OCR experiments', () => {
    const { document } = parseHTML(markup);
    const experimental = document.querySelector('#experimental-options');

    expect(document.querySelector('#settings-grid #auto-translate-mode')).not.toBeNull();
    expect(document.querySelector('#settings-grid #sync-scroll')).not.toBeNull();
    expect(document.querySelector('#settings-grid #replica-fidelity-policy'))
      .toBeNull();
    expect(document.querySelector('#replica-engine')).toBeNull();
    expect(experimental?.querySelector('#replica-view-mode')).not.toBeNull();
    // D64: fidelity and the mirror's size limits are Advanced settings.
    expect(experimental?.querySelector('#replica-fidelity-policy')).not.toBeNull();
    for (const [id, min, max] of [
      ['mirror-item-megabytes', '1', '30'],
      ['mirror-page-megabytes', '1', '60'],
      ['mirror-max-elements', '1000', '1000000'],
    ]) {
      const input = experimental?.querySelector<HTMLInputElement>(`#${id}`);
      expect(input?.getAttribute('type'), id).toBe('number');
      expect([input?.getAttribute('min'), input?.getAttribute('max')], id)
        .toEqual([min, max]);
      expect(input?.closest('label')?.querySelector('[data-ui-label]'), id)
        .not.toBeNull();
    }
    expect(experimental?.querySelector('#restore-mirror-limits')?.hasAttribute('data-ui-label'))
      .toBe(true);
    // D75: the testing switch that turns every privacy filter off.
    const showEverything = experimental?.querySelector<HTMLInputElement>(
      '#mirror-show-everything',
    );
    expect(showEverything?.getAttribute('type')).toBe('checkbox');
    expect(showEverything?.closest('label')?.querySelector('[data-ui-label]'))
      .not.toBeNull();
    const disclosureId = showEverything?.getAttribute('aria-describedby');
    expect(experimental?.querySelector(`#${disclosureId}`)
      ?.hasAttribute('data-ui-label')).toBe(true);
    expect(experimental?.querySelector('#image-analysis-host')).not.toBeNull();
    expect(markup.indexOf('id="settings-grid"'))
      .toBeLessThan(markup.indexOf('id="experimental-options"'));
  });

  it('styles the persisted OCR confidence control', () => {
    expect(style).toContain('.ocr-confidence-control');
    expect(style).toContain('.ocr-confidence-row input');
  });

  it('keeps every image-reading method visible, toggleable, and ordered', () => {
    expect(script).toContain('commitPatch: (patch) => preferenceClient.commitImageAnalysis(patch),');
    expect(DEFAULT_COMPANION_PREFERENCES.imageReadingMethodOrder.slice(0, 3))
      .toEqual([
        'accessibility-text',
        'chrome-text-detector',
        'tesseract',
      ]);
    expect(providerRegistry).toContain(
      'ACCESSIBILITY_IMAGE_TEXT_COMPILED ||',
    );
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
    expect(readScope).toContain('for (const key of REPLICA_READ_SCOPE_KEYS)');
    expect(readScope).toContain('READ_SCOPE_COPY[key].label');
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
    expect(readScope).toContain('installResetConfirmationController({');
    expect(readScope).toContain('readScopeSetup.showModal()');
    expect(readScope).toContain("readScopeSetup.addEventListener('cancel'");
    expect(readScope).toContain("resetSettingsDialog.close('cancel')");
    expect(readScope).toContain('preferences.resetCleanupPendingRevision > 0');
    expect(readScope).toContain("type: 'simul:preferences:patch-read-scope'");
    expect(readScope).toContain("type: 'simul:preferences:complete-read-scope-setup'");
    expect(readScope).toContain(
      'expectedSetupVersion: state.preferences.readScopeSetupVersion',
    );
    expect(readScope).toContain("type: 'simul:preferences:reset-all'");
    expect(script).toContain('purgeSourceDerivedRuntime(');
    expect(readScope).toContain(
      'localReadScopeNarrowingGates.set(sequence',
    );
    expect(readScope).toContain(
      'remoteReadScopeNarrowingGates.prepare(',
    );
    expect(readScope).toContain(
      'remoteReadScopeNarrowingGates.authorizeCommittedRelease(',
    );
    expect(script).toContain('new PreferenceSafetyClient({');
    expect(script).toContain(
      'usablePixelProviderCount: imageTranslationConfig.usablePixelProviderOrder().length,',
    );
    // The toolbar asks for pixel access only while a pixel provider could use
    // it and Chrome has not refused in this panel (toolbarOcrClickAction, G3).
    expect(script).toContain(
      "accessGranted: state.imageCaptureAccess === 'granted',\n    usablePixelProviders: imageTranslationConfig.usablePixelProviderOrder().length,",
    );
    expect(permissionFlows).toContain(
      'const shouldRequestPixelAccess = requestPixelAccess &&',
    );
    expect(permissionFlows).toContain(
      'UI_STRINGS.statusImageAccessRemovedAccessibilityActive',
    );
    expect(script).toContain('readScopeController.handleSafetyMessage(message, reply)');
    expect(script).toContain('preferenceSafetyConnectionReady = false');
    expect(readScope).toContain('await purge;');
    expect(script).toContain('isolatedHtmlReplicaEngine.releasePresentation()');
    expect(script).not.toContain('invokeLivePageObserverUnregisterBridge');
    expect(readScope).toContain(
      'scope = intersectReplicaReadScopes(scope, PAGE_ONLY_REPLICA_READ_SCOPE)',
    );
    expect(script).toContain('livePreferenceStorageFailClosed');
    expect(script).toContain('selectLiveCompanionPreferenceChange(');
    expect(readScope).toContain('retrySetupResetCleanupButton.focus()');
    expect(readScope).toContain(
      "retrySetupResetCleanupButton.addEventListener('click'",
    );
    expect(readScope).toContain('expectedReadScopeFingerprint:');
    const purgeStart = script.indexOf(
      'function purgeSourceDerivedRuntime(message: string)',
    );
    const purgeEnd = script.indexOf(
      'function clearResetOnlyRuntimeState()',
      purgeStart,
    );
    const purgeFunction = script.slice(purgeStart, purgeEnd);
    expect(purgeFunction).toContain('translationMemory.clear()');
    expect(purgeFunction).not.toContain('imageTranslationMemory.clear()');
    expect(purgeFunction).toContain(
      'imageTranslationController.purgeSourceDerivedCache()',
    );
    expect(imageConfig).toContain('resetEpoch: state.preferences.resetRevision');
    expect(readScope).toContain(
      'preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION',
    );

    const resetStart = readScope.indexOf('async resetAllExtensionSettings()');
    const resetEnd = readScope.indexOf('async handleSafetyMessage(', resetStart);
    const resetFunction = readScope.slice(resetStart, resetEnd);
    expect(resetFunction.indexOf("result.code === 'stale-reset-revision'"))
      .toBeLessThan(resetFunction.indexOf('purgeSourceDerivedRuntime('));
  });

  it('never waits for the background while holding the background preference lock', () => {
    for (const source of [script, permissionFlows]) {
      expect(source).not.toContain('navigator.locks.request(');
      expect(source).not.toContain('PREFERENCE_LOCK_NAME');
    }
    expect(permissionFlows).toContain(
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
      'const saved = await preferenceClient.commitView({ replicaFidelityPolicy })',
    );
    expect(script).toContain('!saved ||');
    expect(script).toContain("reason: 'preference'");
  });

  it('keeps From target-localized and To native while using explicit order', () => {
    expect(script).toContain('for (const language of LANGUAGE_OPTION_ORDER)');
    expect(script).toContain('languageEndonym(language)');
    expect(script).toContain("source.dataset.languageCode = language;");
    expect(script).not.toContain("target.dataset.uiLabel");
  });

  it('does not follow a new active tab when its mode preference failed to save', () => {
    expect(script).toContain(
      'const saved = await preferenceClient.commitView({ popoutTabMode })',
    );
    expect(script).toContain(
      '!saved || state.preferences.popoutTabMode !== popoutTabMode',
    );
  });

  it('publishes captured identity only after the replacement replica commits', () => {
    const captureStart = capturePipeline.indexOf('async #capturePage(');
    const captureEnd = capturePipeline.indexOf(
      'async #runReplicaEngineCheckpoint(',
      captureStart,
    );
    const captureSource = capturePipeline.slice(captureStart, captureEnd);

    expect(captureStart).toBeGreaterThanOrEqual(0);
    expect(captureSource.indexOf('await this.#runReplicaEngineCheckpoint('))
      .toBeLessThan(captureSource.indexOf(
        'capturedPageIdentity = committedIdentity;',
      ));
    expect(captureSource.indexOf('snapshot = surface.snapshot();'))
      .toBeLessThan(captureSource.indexOf(
        'capturedPageIdentity = committedIdentity;',
      ));
    expect(captureSource).toContain(
      'const committedIdentity = state.followedPageIdentity && sameCompanionSourcePage(',
    );

    const checkpointSource = capturePipeline.slice(captureEnd);
    expect(checkpointSource).toContain('sameCompanionSourcePage(');
    expect(checkpointSource).not.toContain(
      'capturedPageIdentity === identity',
    );
    // The only injected function reads the content type and nothing else.
    expect(script).toContain('func: () => document.contentType,');
  });

  it('routes every tab and window event through the source follower', () => {
    expect(script).toContain('new NavigationRefreshGate()');
    expect(capturePipeline).toContain('navigationRefreshGate.consumeCapture(');
    for (const handler of [
      'sourceFollower.acceptAuthorizedTab(authorizedTab)',
      'sourceFollower.handleTabActivated(tabId, windowId)',
      'sourceFollower.handleWindowFocusChanged(windowId)',
      'sourceFollower.handleTabAttached(tabId, newWindowId)',
      'sourceFollower.handleTabUpdated(tabId, changeInfo, tab)',
      'sourceFollower.handleTabReplaced(addedTabId, removedTabId)',
      'sourceFollower.handleTabRemoved(tabId, removeInfo)',
    ]) {
      expect(script).toContain(handler);
    }
  });

  it('keeps progress non-interactive and supports dark, narrow, and reduced-motion users', () => {
    expect(style).toContain('pointer-events: none');
    expect(style).toContain('@media (prefers-color-scheme: dark)');
    expect(style).toContain('@media (max-width: 360px)');
    expect(style).toContain('@media (prefers-reduced-motion: reduce)');
    expect(style).toContain('--surface: #111814');
    expect(style).toContain('grid-template-rows: auto minmax(0, 1fr)');
    expect(style).toContain('overflow-x: auto');
    const replicaStyle = style.slice(
      style.lastIndexOf('.replica-preview {'),
      style.indexOf('.empty-state {'),
    );
    expect(replicaStyle).toContain('background: transparent');
    expect(replicaStyle).not.toContain('color-scheme: light');
    expect(replicaStyle).not.toContain('background: #fff');
  });

  it('keeps the focus ring visible in dark mode', () => {
    const darkBlock = style.slice(
      style.indexOf('@media (prefers-color-scheme: dark)'),
      style.indexOf('@media (max-width: 360px)'),
    );

    expect(darkBlock).toContain('button:focus-visible,');
    expect(darkBlock).toContain('select:focus-visible,');
    expect(darkBlock).toContain('textarea:focus-visible,');
    expect(darkBlock).toContain(
      'input:focus-visible { outline-color: rgb(123 217 170 / 75%); }',
    );
  });

  it('shows PDFs in their own focusable, labelled section after the replica', () => {
    const { document } = parseHTML(markup);
    const sections = [...document.querySelectorAll('main > section')].map(
      (section) => section.id,
    );
    const pdfView = document.querySelector('#pdf-view');

    expect(sections).toEqual(['replica-status', 'replica-preview', 'pdf-view']);
    expect(pdfView?.hasAttribute('hidden')).toBe(true);
    expect(pdfView?.getAttribute('tabindex')).toBe('0');
    expect(pdfView?.getAttribute('aria-label')).toBe('PDF pages');
    expect(pdfView?.getAttribute('data-ui-aria-label')).toBe('PDF pages');
    expect(pdfView?.getAttribute('aria-busy')).toBe('false');
    expect(script).toContain(
      "pdfViewContainer.setAttribute('aria-busy', String(state.captureInFlight))",
    );
    const pdfStyle = style.slice(style.indexOf('.pdf-view {'));
    expect(pdfStyle).toContain('overflow: auto');
    expect(pdfStyle).toContain('overscroll-behavior: contain');
    expect(pdfStyle).toContain('color-scheme: light');
    expect(style).toContain('.pdf-view[hidden] { display: none; }');
  });

  it('offers a PDF from this computer in every error panel, and by drop (D107)', () => {
    const { document } = parseHTML(markup);
    const input = document.querySelector<HTMLInputElement>('main > #pdf-file-input');
    expect(input?.getAttribute('type')).toBe('file');
    expect(input?.getAttribute('accept')).toBe('application/pdf,.pdf');
    expect(input?.hasAttribute('hidden')).toBe(true);
    expect(input?.getAttribute('data-ui-aria-label')).toBe('Open a PDF file…');
    // Not inside the status section, which every render replaces.
    expect(document.querySelector('#replica-status #pdf-file-input')).toBeNull();

    const errorPanel = sliceBetween('function renderErrorState(', 'function openDroppedFiles(');
    expect(errorPanel).toContain('setUiText(openFile, UI_STRINGS.openPdfFile);');
    expect(errorPanel).toContain("openFile.addEventListener('click', () => pdfFileInput.click());");
    expect(errorPanel).toContain('setUiText(fileHint, UI_STRINGS.openPdfFileDropHint);');
    // The hint introduces the button, after the reason the panel is empty.
    expect(errorPanel).toContain('wrapper.append(text, fileHint, openFile);');

    const fileWiring = sliceBetween(
      "pdfFileInput.addEventListener('change', () => {",
      "translateComposerButton.addEventListener('click'",
    );
    // The same file chosen twice is a change both times.
    expect(fileWiring).toContain("pdfFileInput.value = '';");
    expect(fileWiring).toContain('capturePipeline.openLocalPdf(file);');
    // A dragged file never navigates the panel away.
    expect(fileWiring).toContain("document.addEventListener('dragover', (event) => {");
    expect(fileWiring).toContain("document.addEventListener('drop', (event) => {");
    expect(fileWiring.match(/event\.preventDefault\(\);/gu)).toHaveLength(2);
    expect(fileWiring).toContain('openDroppedFiles([...(event.dataTransfer?.files ?? [])]);');
    expect(script).toContain("return event.dataTransfer?.types.includes('Files') ?? false;");
    // Drops over the mirror frame come back from the engine; the first PDF opens.
    expect(script).toContain('onFileDrop: (files) => openDroppedFiles(files),');
    const dropped = sliceBetween('function openDroppedFiles(', 'function renderUi(');
    expect(dropped).toContain('const file = chooseDroppedPdf(files);');

    // A chosen file has no tab: Refresh and settings rebuilds read it again.
    const refresh = sliceBetween('const requestManualRefresh = (): void => {', 'refreshButton.addEventListener(');
    expect(refresh).toContain("if (state.localPdf) capturePipeline.reopenLocalPdf('manual');");
    const recapture = sliceBetween('function recaptureShownPage(', 'async function languageSelectionChanged(');
    // Mirror settings leave a shown local PDF alone; one a purge closed reopens.
    expect(recapture).toContain("else if (!pdfController.shown) capturePipeline.reopenLocalPdf('preference');");
    // Every settings rebuild goes through recaptureShownPage.
    expect(script.match(/reason: 'preference' \}\)/gu)).toHaveLength(1);
    // The OCR cache is kept per chosen file.
    expect(script).toContain(
      'const origin = state.localPdf?.key ?? pageOrigin(state.capturedPageIdentity?.url);',
    );
    expect(style).toContain('.empty-state__open-pdf { color: var(--text); }');
  });

  it('closes the PDF on purge and unload, and lays it out with the tab zoom', () => {
    const purge = sliceBetween(
      'function purgeSourceDerivedRuntimeInternal(',
      'function clearResetOnlyRuntimeState(',
    );
    expect(purge).toContain('pdfController.close();');
    const pagehide = sliceBetween(
      "window.addEventListener('pagehide', () => {\n  preferenceClient.flushPendingZoom();",
      'browser.runtime.onMessage.addListener(',
    );
    expect(pagehide).toContain('state.pdfAbortController?.abort();');
    expect(pagehide).toContain('pdfController.close();');
    const layout = sliceBetween('function updateMirrorLayout(', 'function setCompanionOverlay(');
    expect(layout).toContain('sourceZoomFactor: state.sourceZoomFactor');
    expect(layout).toContain('pdfController.updateLayout(layout);');
    expect(script).toContain('browser.tabs.onZoomChange.addListener(');
    expect(script).toContain('capturePipeline.handleSourceZoomChange(tabId, newZoomFactor)');
    expect(script).toContain('browser.tabs.getZoom(tabId)');
  });

  it('translates PDFs through the page coordinator on their own surface', () => {
    expect(script).toContain('const pdfTextSurface = new PdfTextSurface(pdfView);');
    expect(script).toContain(
      "kind === 'pdf' ? pdfTextSurface : isolatedHtmlReplicaEngine,",
    );
    // PDFs make no background commits, so background results need no PDF case.
    expect(script).not.toContain('handlePdfTextCommit');
    const background = sliceBetween('onBackgroundResult: (result) => {', 'const evidenceJudge');
    expect(background).not.toContain('pdfController');
    expect(script).toContain('onPriorityChange: () => replicaTranslationCoordinator.reprioritize(),');
    expect(script).toContain('onReadingPageChange: (index) => pdfController.handleReadingPage(index),');
    const relocalize = sliceBetween(
      'function relocalizeDynamicSurfaces(',
      'function relocalizeSizeToggle(',
    );
    expect(relocalize).toContain('pdfView.relabelPages();');
    const layer = style.slice(style.indexOf('.pdf-text-layer {'));
    expect(layer).toContain('pointer-events: none');
    expect(layer).toContain('user-select: none');
    expect(style).toContain('.pdf-block {\n  position: absolute;\n  color: transparent;');
    expect(style).toContain('.pdf-block--translated { color: var(--pdf-ink, #000); }');
  });

  it('keeps every cover under every block text in the PDF view', () => {
    const rule = (selector: string) => {
      const start = style.indexOf(`${selector} {`);
      return style.slice(start, style.indexOf('}', start));
    };
    expect(rule('.pdf-block-cover')).toContain('z-index: 0;');
    expect(rule('.pdf-block-text')).toContain('position: relative;');
    expect(rule('.pdf-block-text')).toContain('z-index: 1;');
    // A block with its own stacking context would trap its text above only
    // its own covers.
    for (const property of ['z-index', 'opacity', 'transform', 'isolation', 'filter']) {
      expect(rule('.pdf-block')).not.toContain(`${property}:`);
      expect(rule('.pdf-text-layer')).not.toContain(`${property}:`);
    }
    const view = style.slice(style.indexOf('.pdf-view {\n  position: relative;'));
    expect(view.slice(0, view.indexOf('}'))).toContain('isolation: isolate;');
  });

  it('shows PDF translations only on drawn pages, and not in forced colours', () => {
    const layer = style.slice(style.indexOf('.pdf-text-layer {'));
    expect(layer.slice(0, layer.indexOf('}'))).toContain('forced-color-adjust: none;');
    expect(style).toContain(
      '.pdf-page:not([data-overlays]) .pdf-block--translated { color: transparent; }',
    );
    expect(style).toContain(
      '.pdf-page:not([data-overlays]) .pdf-block--translated .pdf-block-cover { display: none; }',
    );
    // Hidden with transparency, never `visibility`, so screen readers keep the text.
    expect(style).not.toMatch(/pdf-block[^{]*\{[^}]*visibility: hidden/u);
    expect(script).toContain('isPdfShown: () => pdfController.shown,');
  });

  it('saves a zoom drag that has not settled when the page unloads', () => {
    const pagehide = sliceBetween(
      "window.addEventListener('pagehide'",
      'browser.runtime.onMessage.addListener(',
    );
    expect(pagehide).toContain('preferenceClient.flushPendingZoom();');
    expect(script).toContain("zoomInput.addEventListener('input', () => preferenceClient.setZoom(");
  });

  it('lets UI labels follow a page translation that prepared their pair', () => {
    expect(script).toContain('onPairPrepared: () => uiLocalizer.retryAfterPagePairPrepared(),');
    const translation = translationDriver.slice(
      translationDriver.indexOf('async #runTranslation('),
      translationDriver.indexOf('applyReplicaViewMode('),
    );
    expect(translation).toContain('this.environment.onPairPrepared();');
  });

  it('keeps translation intent local to the window that changed the languages', () => {
    const storageListener = sliceBetween(
      'browser.storage.onChanged.addListener(',
      '\nvoid initialize();',
    );
    expect(storageListener).not.toContain('translationDesired = true');
    expect(storageListener).toContain('applyLanguagePreferences(false, previousPair)');
    const selectionChanged = sliceBetween(
      'async function languageSelectionChanged(',
      '\nasync function translateRemembered(',
    );
    expect(selectionChanged).toContain(
      'if (!state.isLiveSourceOnlyMode) state.translationDesired = true;',
    );
    const apply = translationDriver.slice(
      translationDriver.indexOf('async applyLanguagePreferences('),
      translationDriver.indexOf('async checkAvailability('),
    );
    expect(apply).toContain('if (!fromUserAction) {');
    expect(apply).toContain('await this.maybeTranslateAutomatically(');
    expect(apply).not.toContain('startTranslation(!fromUserAction');
    expect(apply).toContain('await this.startTranslation(false, captureCoordinator.generation)');
  });

  it('records the checked pair only after an availability result is accepted', () => {
    const check = translationDriver.slice(
      translationDriver.indexOf('async checkAvailability('),
      translationDriver.indexOf('async maybeTranslateAutomatically('),
    );
    expect(check.indexOf('availabilityCheckedForPair = checkedPairKey;'))
      .toBeGreaterThan(check.indexOf('pair.sourceLanguage === pair.targetLanguage'));
    expect(check).toContain(
      'if (!isCurrent()) return;\n' +
        '      state.availabilityCheckedForPair = checkedPairKey;\n' +
        '      state.availability = next;',
    );
    expect(check).toContain(
      'if (!isCurrent()) return;\n' +
        '      state.availabilityCheckedForPair = checkedPairKey;\n' +
        "      state.availability = 'unavailable';",
    );
    // A discarded check leaves the pair unrecorded, so the next text commit
    // re-establishes availability instead of skipping preparation.
    const reconcile = translationDriver.slice(
      translationDriver.indexOf('async reconcileAfterCommit('),
      translationDriver.indexOf('async applyLanguagePreferences('),
    );
    expect(reconcile).toContain('availabilityCheckedForPair !== expectedAvailabilityKey');
  });

  it('does not guard the definitely assigned image translation controller', () => {
    expect(script).toContain('let imageTranslationController!: ImageTranslationController;');
    expect(script).not.toContain('imageTranslationController?.');
  });
});

function sliceBetween(start: string, end: string): string {
  const startIndex = script.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = script.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return script.slice(startIndex, endIndex);
}
