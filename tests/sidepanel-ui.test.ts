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
    expect(probeSource).toContain('resetEpoch: state.preferences.resetRevision');
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

  it('places common controls before OCR experiments', () => {
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
      'expectedSetupVersion: state.preferences.readScopeSetupVersion',
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
      'usablePixelProviderCount: enabledUsablePixelOcrProviderOrder().length,',
    );
    expect(script).toContain(
      "imageCaptureAccess !== 'granted' &&\n    enabledUsablePixelOcrProviderOrder().length > 0",
    );
    expect(permissionFlows).toContain(
      'const shouldRequestPixelAccess = requestPixelAccess &&',
    );
    expect(permissionFlows).toContain(
      'Accessibility image text remains active; only pixel OCR is paused.',
    );
    expect(script).toContain('handlePreferenceSafetyMessage(message, reply)');
    expect(script).toContain('preferenceSafetyConnectionReady = false');
    expect(script).toContain('await purge;');
    expect(script).toContain('isolatedHtmlReplicaEngine.releasePresentation()');
    expect(script).not.toContain('invokeLivePageObserverUnregisterBridge');
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
    expect(purgeFunction).not.toContain('imageTranslationMemory.clear()');
    expect(purgeFunction).toContain(
      'imageTranslationController.purgeSourceDerivedCache()',
    );
    expect(script).toContain('resetEpoch: state.preferences.resetRevision');
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
    const captureStart = script.indexOf('async function capturePage(');
    const captureEnd = script.indexOf(
      '\nasync function runReplicaEngineCheckpoint(',
      captureStart,
    );
    const captureSource = script.slice(captureStart, captureEnd);

    expect(captureStart).toBeGreaterThanOrEqual(0);
    expect(captureSource.indexOf('await runReplicaEngineCheckpoint('))
      .toBeLessThan(captureSource.indexOf(
        'capturedPageIdentity = committedIdentity;',
      ));
    expect(captureSource.indexOf('snapshot = replicaSurfaceRouter.snapshot();'))
      .toBeLessThan(captureSource.indexOf(
        'capturedPageIdentity = committedIdentity;',
      ));
    expect(captureSource).toContain(
      'const committedIdentity = state.followedPageIdentity && sameCompanionSourcePage(',
    );

    const checkpointStart = script.indexOf(
      'async function runReplicaEngineCheckpoint(',
    );
    const checkpointEnd = script.indexOf(
      '\nfunction ',
      checkpointStart,
    );
    const checkpointSource = script.slice(checkpointStart, checkpointEnd);
    expect(checkpointSource).toContain('sameCompanionSourcePage(');
    expect(checkpointSource).not.toContain(
      'capturedPageIdentity === identity',
    );
  });

  it('routes every tab and window event through the source follower', () => {
    expect(script).toContain('new NavigationRefreshGate()');
    expect(script).toContain('navigationRefreshGate.consumeCapture(');
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

  it('saves a zoom drag that has not settled when the page unloads', () => {
    const pagehide = sliceBetween(
      "window.addEventListener('pagehide'",
      'browser.runtime.onMessage.addListener(',
    );
    expect(pagehide).toContain('preferenceClient.flushPendingZoom();');
    expect(script).toContain("zoomInput.addEventListener('input', () => preferenceClient.setZoom(");
  });

  it('lets UI labels follow a page translation that prepared their pair', () => {
    const translation = sliceBetween(
      'async function runTranslation(',
      '\nfunction describePartialReplicaTranslation(',
    );
    expect(translation).toContain('uiLocalizer.retryAfterPagePairPrepared();');
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
      '\nasync function applyLanguagePreferences(',
    );
    expect(selectionChanged).toContain(
      'if (!state.isLiveSourceOnlyMode) state.translationDesired = true;',
    );
    const apply = sliceBetween(
      'async function applyLanguagePreferences(',
      '\nasync function checkAvailability(',
    );
    expect(apply).toContain('if (!fromUserAction) {');
    expect(apply).toContain('await maybeTranslateAutomatically(');
    expect(apply).not.toContain('startTranslation(!fromUserAction');
    expect(apply).toContain('await startTranslation(false, captureCoordinator.generation)');
  });

  it('records the checked pair only after an availability result is accepted', () => {
    const check = sliceBetween(
      'async function checkAvailability(',
      '\nasync function maybeTranslateAutomatically(',
    );
    expect(check).not.toContain(
      "availabilityCheckedForPair = checkedPairKey;\n  state.availability = 'unavailable';",
    );
    expect(check.indexOf('availabilityCheckedForPair = checkedPairKey;'))
      .toBeGreaterThan(check.indexOf('pair.sourceLanguage === pair.targetLanguage'));
    expect(check).toContain(
      'if (!isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) return;\n' +
        '    state.availabilityCheckedForPair = checkedPairKey;\n' +
        '    state.availability = next;',
    );
    expect(check).toContain(
      'if (!isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) return;\n' +
        '    state.availabilityCheckedForPair = checkedPairKey;\n' +
        "    state.availability = 'unavailable';",
    );
    // A discarded check leaves the pair unrecorded, so the next text commit
    // re-establishes availability instead of skipping preparation.
    const reconcile = sliceBetween(
      'async function reconcileReplicaTranslationAfterCommit(',
      '\nfunction* replicaRecordSources(',
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
