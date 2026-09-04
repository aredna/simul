import { ChromeTranslatorProvider } from '../../lib/chrome-translator';
import {
  createExtensionBuildIdentity,
  renderExtensionBuildIdentity,
} from '../../lib/build-identity';
import {
  LatestWorkCoordinator,
  isAvailabilityRequestCurrent,
  mergeLiveUpdateBatches,
  replicaViewTranslationAction,
  type GenerationWork,
} from '../../lib/companion-lifecycle';
import {
  nextCompanionOverlay,
  type CompanionOverlay,
} from '../../lib/companion-ui-state';
import {
  type CompanionStatusTone,
} from '../../lib/companion-ui-localization';
import { resolveSourceLanguage } from '../../lib/language-detection';
import {
  LANGUAGE_OPTION_ORDER,
  languageEndonym,
} from '../../lib/language-options';
import {
  captureLivePageDelta,
  invokeLivePageObserverBridge,
  invokeLivePageObserverUnregisterBridge,
  parseLivePageDelta,
  readLivePageDirtyMessage,
  readLivePageObserverInstallation,
  readLivePageScrollMessage,
  type LivePageDirtyMessage,
  type LivePageDelta,
  type LiveVisualNode,
} from '../../lib/live-page-mirror';
import {
  PageAccessError,
  assertSnapshotIsCurrent,
  isSupportedPage,
  normalizedPageUrl,
  parseDetachedPageIdentityHint,
  readAuthorizedTabMessage,
  readPageError,
  readableError,
  withPageTimeout,
  type CapturedPageIdentity,
} from '../../lib/page-identity';
import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
  sameCompanionSourcePage,
} from '../../lib/companion-surface';
import {
  capturePageSnapshot,
  parsePageSnapshot,
  type PageSnapshot,
} from '../../lib/page-snapshot';
import {
  compiledImageAnalysisCapabilities,
  effectiveCompiledProviderOrder,
  hasCompiledImageAnalysisCapability,
} from '../../lib/ocr/provider-registry';
import {
  ImageTranslationController,
  type ImageTranslationDiagnostic,
} from '../../lib/ocr/image-translation-controller';
import { openChromeImageSource } from '../../lib/ocr/image-source-client';
import {
  PixelAcquisitionCoordinator,
  createBrowserPixelAcquisitionEnvironment,
} from '../../lib/ocr/pixel-acquisition';
import { createBrowserImageRecognitionCoordinator } from '../../lib/ocr/image-analysis-coordinator';
import { IndexedDbTransientImageStore } from '../../lib/ocr/transient-image-store';
import {
  STORAGE_KEY,
  autoTranslationModeForPage,
  clampZoomPercent,
  isCompanionLaunchBehavior,
  isAutoTranslationEnabled,
  isAutoTranslationMode,
  isMirrorDisplayMode,
  isPopoutTabMode,
  isReplicaViewMode,
  isTextLayoutMode,
  parseCompanionPreferences,
  withViewSettings,
  type CompanionLaunchBehavior,
  type CompanionPreferences,
  type CompanionSurface,
  type CompanionImageAnalysisSettingsPatch,
  type CompanionViewSettingsPatch,
  type PopoutTabMode,
  type ReplicaViewMode,
} from '../../lib/preferences';
import { translateWithSession } from '../../lib/translation-pipeline';
import {
  CompanionState,
  availabilityPairKey,
  sameTranslationPair,
  type CaptureRequest,
  type PendingImageReplicaActivation,
  type PendingLiveUpdate,
} from './companion-state';
import { Currency, type CurrencyToken } from './currency';
import { ImageAnalysisPanel } from './image-analysis-panel';
import { MirrorView } from './mirror-view';
import { PermissionFlows } from './permission-flows';
import { PreferenceClient } from './preference-client';
import { QuickComposer } from './quick-composer';
import { SourceFollower } from './source-follower';
import { ToolbarStatus } from './toolbar-status';
import { UiLocalizer } from './ui-localizer';
import {
  type ReplicaCaptureRequest,
  type ReplicaDiagnosticCode,
} from '../../lib/replica/contracts';
import { ReplicaEngineController } from '../../lib/replica/engine-selection';
import { openChromeHtmlMirrorStream } from '../../lib/replica/html-mirror-client';
import {
  isSelectableReplicaFidelityPolicy,
  type SelectableReplicaFidelityPolicy,
} from '../../lib/replica/fidelity-policy';
import { IsolatedHtmlReplicaEngine } from '../../lib/replica/isolated-html-engine';
import {
  LiveReplicaFailureRecoveryGate,
  LegacyTransitionGate,
  isCommittedShadowReplica,
  shouldPreserveCommittedReplicaForCapture,
  shouldReleaseReplicaAfterCaptureFailure,
} from '../../lib/replica/legacy-transition-gate';
import { LegacyReplicaEngine } from '../../lib/replica/legacy-engine';
import {
  LEGACY_FALLBACK_LABEL,
  LIVE_REPLAY_LABEL,
  STATIC_REPLAY_LABEL,
  VisibleReplayHost,
} from '../../lib/replica/visible-replay-host';
import { ReplicaSurfaceRouter } from '../../lib/replica/replica-surface-router';
import {
  captureRequestMatchesSourceDocument,
  sameSourceReplicaLease,
} from '../../lib/replica/source-identity';
import { buildBoundedLanguageSample } from '../../lib/translation/language-sample';
import {
  replicaSourceCommitAction,
  snapshotWithLiveDocumentLanguage,
} from '../../lib/translation/replica-translation-lifecycle';
import {
  ReplicaTranslationCoordinator,
  isCompleteReplicaTranslationResult,
  splitBoundaryWhitespace,
  type ReplicaSourceCommit,
  type ReplicaTranslationRunResult,
} from '../../lib/translation/replica-translation-coordinator';
import { TranslationMemory } from '../../lib/translation/translation-memory';
import {
  SUPPORTED_LANGUAGES,
  languageName,
  type SupportedLanguage,
  type TranslationPair,
  type TranslationSession,
} from '../../lib/translation-provider';
import {
  applyLivePageDelta,
  resetVisualMirrorText,
  translateVisualMirror,
} from '../../lib/visual-renderer';

const ZOOM_COMMIT_DEBOUNCE_MS = 150;
const NAVIGATION_DEBOUNCE_MS = 350;
const CAPTURE_TIMEOUT_MS = 12_000;
const DYNAMIC_UI_LABELS = [
  'Fit',
  '1:1',
  'Current',
  'Active',
  'Translate',
  'Translating…',
  'Translate page',
  'Translation current',
  'Image text',
  'OCR On',
  'OCR Off',
  'Translate text inside images (local, experimental)',
  'Image translation is saved but paused. Grant image access so Chrome can capture visible pixels for local OCR.',
  'Checking Chrome image access…',
  'Off by default. Visible image pixels stay on this device and are discarded after OCR.',
  'Grant image access',
  'OCR priority',
  'Scan images',
  'Skip very small images',
  'Use local Prompt for image language',
  'Use local Prompt to interpret image text',
  'OCR diagnostics',
  'Memory-only stages and counts; page text, URLs, pixels, and identifiers are never included.',
  'Clear diagnostics',
  'Only when visible',
  'Everything immediately',
  'Visible first, then background',
  'Waiting for website language',
  'Simul is still detecting the website language. If detection remains inconclusive, choose From in the toolbar.',
  'The languages match, so Simul will copy the text unchanged.',
  'Your draft stays only in this companion window and is not saved.',
  STATIC_REPLAY_LABEL,
  LIVE_REPLAY_LABEL,
  LEGACY_FALLBACK_LABEL,
] as const;

const sourceSelect = requireElement<HTMLSelectElement>('#source-language');
const targetSelect = requireElement<HTMLSelectElement>('#target-language');
const autoTranslateSelect = requireElement<HTMLSelectElement>('#auto-translate-mode');
const displayModeSelect = requireElement<HTMLSelectElement>('#mirror-display-mode');
const textLayoutSelect = requireElement<HTMLSelectElement>('#text-layout-mode');
const replicaFidelityPolicySelect = requireElement<HTMLSelectElement>(
  '#replica-fidelity-policy',
);
const replicaViewModeSelect = requireElement<HTMLSelectElement>('#replica-view-mode');
const launchBehaviorSelect = requireElement<HTMLSelectElement>('#launch-behavior');
const popoutTabModeSelect = requireElement<HTMLSelectElement>('#popout-tab-mode');
const syncScrollInput = requireElement<HTMLInputElement>('#sync-scroll');
const zoomInput = requireElement<HTMLInputElement>('#zoom');
const zoomOutput = requireElement<HTMLOutputElement>('#zoom-value');
const zoomInButton = requireElement<HTMLButtonElement>('#zoom-in');
const zoomOutButton = requireElement<HTMLButtonElement>('#zoom-out');
const swapButton = requireElement<HTMLButtonElement>('#swap-languages');
const translateButton = requireElement<HTMLButtonElement>('#translate');
const refreshButton = requireElement<HTMLButtonElement>('#refresh');
const compactRefreshButton = requireElement<HTMLButtonElement>('#compact-refresh');
const refreshAttention = requireElement<HTMLElement>('#refresh-attention');
const toolbarAutoDetectButton = requireElement<HTMLButtonElement>('#toolbar-auto-detect');
const toolbarSizeToggleButton = requireElement<HTMLButtonElement>('#toolbar-size-toggle');
const toolbarSizeLabel = requireElement<HTMLElement>('#toolbar-size-label');
const toolbarOcrToggleButton = requireElement<HTMLButtonElement>('#toolbar-ocr-toggle');
const toolbarOcrLabel = requireElement<HTMLElement>('#toolbar-ocr-label');
const toolbarTabFollowButton = requireElement<HTMLButtonElement>('#toolbar-tab-follow');
const toolbarTabFollowLabel = requireElement<HTMLElement>('#toolbar-tab-follow-label');
const cancelButton = requireElement<HTMLButtonElement>('#cancel');
const toggleSettingsButton = requireElement<HTMLButtonElement>('#toggle-settings');
const toggleQuickTranslateButton = requireElement<HTMLButtonElement>('#toggle-quick-translate');
const closeSettingsButton = requireElement<HTMLButtonElement>('#close-settings');
const closeQuickTranslateButton = requireElement<HTMLButtonElement>('#close-quick-translate');
const popoutButton = requireElement<HTMLButtonElement>('#open-popout');
const compactToolbar = requireElement<HTMLElement>('#compact-toolbar');
const toolbarProgress = requireElement<HTMLElement>('#toolbar-progress');
const toolbarProgressFill = requireElement<HTMLElement>('#toolbar-progress-fill');
const controlsOverlay = requireElement<HTMLElement>('#control-overlay');
const quickTranslatorOverlay = requireElement<HTMLElement>('#quick-translator');
const buildVersionElement = requireElement<HTMLElement>('#build-version');
const imageAnalysisHost = requireElement<HTMLElement>('#image-analysis-host');
const statusElement = requireElement<HTMLElement>('#status');
const settingsAttention = requireElement<HTMLElement>('#settings-attention');
const detectedLanguageElement = requireElement<HTMLElement>('#detected-language');
const captureNotes = requireElement<HTMLElement>('#capture-notes');
const progressRegion = requireElement<HTMLElement>('#progress-region');
const progressLabel = requireElement<HTMLLabelElement>('#progress-label');
const progressElement = requireElement<HTMLProgressElement>('#progress');
const placementGuidance = requireElement<HTMLElement>('#placement-guidance');
const snapshotContainer = requireElement<HTMLElement>('#snapshot');
const replicaPreviewContainer = requireElement<HTMLElement>('#replica-preview');
const replicaModeBadge = requireElement<HTMLElement>('#replica-mode-badge');
const composerInput = requireElement<HTMLTextAreaElement>('#composer-input');
const composerOutput = requireElement<HTMLTextAreaElement>('#composer-output');
const translateComposerButton = requireElement<HTMLButtonElement>('#translate-composer');
const copyComposerButton = requireElement<HTMLButtonElement>('#copy-composer');
const composerFromLanguage = requireElement<HTMLElement>('#composer-from-language');
const composerToLanguage = requireElement<HTMLElement>('#composer-to-language');
const composerGuidance = requireElement<HTMLElement>('#composer-guidance');
const composerStatus = requireElement<HTMLElement>('#composer-status');

const provider = new ChromeTranslatorProvider();
const captureCoordinator = new LatestWorkCoordinator<CaptureRequest>();
const detachedIdentityHint = parseDetachedPageIdentityHint(window.location.search);
const isDetachedWindow = detachedIdentityHint !== undefined;
const liveSessionId = crypto.randomUUID();
const state = new CompanionState({
  isDetachedWindow,
  ...(detachedIdentityHint ? { detachedSourceWindowId: detachedIdentityHint.windowId } : {}),
});
const currency = new Currency();
const legacyTransitionGate = new LegacyTransitionGate();
const liveReplicaFailureRecoveryGate = new LiveReplicaFailureRecoveryGate();
const visibleReplayHost = new VisibleReplayHost({
  hostDocument: document,
  legacySurface: snapshotContainer,
  previewSurface: replicaPreviewContainer,
  badge: replicaModeBadge,
});
const mirrorView = new MirrorView({
  document,
  container: snapshotContainer,
  replayHost: visibleReplayHost,
  readPreferences: () => state.preferences,
  readSourceScroll: () => state.lastSourceScroll,
  onLayoutUpdated: () => imageTranslationController?.refreshOverlays(),
});
let replicaEngineController!: ReplicaEngineController;
let replicaTranslationCoordinator!: ReplicaTranslationCoordinator;
let imageTranslationController!: ImageTranslationController;
const replicaSurfaceRouter = new ReplicaSurfaceRouter();
const isolatedHtmlReplicaEngine = new IsolatedHtmlReplicaEngine({
  presentationHost: visibleReplayHost,
  openStream: openChromeHtmlMirrorStream,
  getReplicaFidelityPolicy: () => state.preferences.replicaFidelityPolicy,
  onLiveApplied: () => legacyTransitionGate.markDirty(),
  onLayoutChanged: () => imageTranslationController?.refreshOverlays(),
  onSourceCommit: handleReplicaSourceCommit,
  onLiveFailure: (code) => handleReplicaLiveFailure(code),
  onInfo: (info) => {
    // Counts and bounded stages only: never source text, URLs, pixels, IDs, or hashes.
    if (!shouldLogIsolatedMirrorInfo(info.stage)) return;
    const event = info.eventRepresentability;
    console.info(
      `[Simul isolated mirror] stage=${info.stage}; code=${info.code ?? 'none'}; nodes=${info.nodeCount}; text=${info.textCount}; images=${info.imageCount}; shadow-roots=${info.openShadowRootCount}; adopted-styles=${info.adoptedStyleCount}; hidden-labels=${info.visuallyHiddenCount}; selected-image-sources=${info.selectedImageSourceCount}; stylesheet-links=${info.stylesheetLinkCount}; stylesheet-loaded=${info.stylesheetLoadedCount}; stylesheet-errors=${info.stylesheetErrorCount}; stylesheet-timeouts=${info.stylesheetTimedOutCount}; operations=${info.operationCount}; text-ops=${info.textOperationCount}; attribute-ops=${info.attributeOperationCount}; children-ops=${info.childrenOperationCount}; reconcile-children-ops=${info.reconcileChildrenOperationCount}; dimension-ops=${info.dimensionOperationCount}; replacement-nodes=${info.replacementNodeCount}; largest-replacement=${info.largestReplacementNodeCount}; retained-nodes=${info.retainedNodeCount}; inserted-nodes=${info.insertedNodeCount}; moved-nodes=${info.movedNodeCount}; removed-nodes=${info.removedNodeCount}; full-replacement-fallbacks=${info.fullReplacementFallbackCount}; rejected-reconciliations=${info.reconciliationRejectedCount}; baseline-unsafe-elements=${info.unsafeElementOmissionCount}; baseline-unsupported-nodes=${info.unsupportedNodeOmissionCount}; baseline-depth-omissions=${info.depthBoundaryOmissionCount}; baseline-private-redactions=${info.privateTextRedactionCount}; baseline-stripped-active=${info.strippedActiveAttributeCount}; baseline-stripped-resources=${info.strippedUnsafeResourceCount}; baseline-unreadable-styles=${info.unreadableStyleCount}; baseline-capacity=${info.capacityOmissionCount}; baseline-custom-hosts=${info.customElementHostCount}; baseline-custom-hosts-without-open-root=${info.customElementHostWithoutAccessibleOpenRootCount}; baseline-open-roots=${info.accessibleOpenShadowRootCount}; baseline-missing-proof-fallbacks=${info.missingReconciliationProofFallbackCount}; baseline-covered-dirty-fallbacks=${info.coveredDirtyBranchFallbackCount}; baseline-attribute-context-fallbacks=${info.attributeContextFallbackCount}; baseline-cross-parent-fallbacks=${info.crossParentFallbackCount}; event-unsafe-elements=${event.unsafeElementOmissionCount}; event-unsupported-nodes=${event.unsupportedNodeOmissionCount}; event-depth-omissions=${event.depthBoundaryOmissionCount}; event-private-redactions=${event.privateTextRedactionCount}; event-stripped-active=${event.strippedActiveAttributeCount}; event-stripped-resources=${event.strippedUnsafeResourceCount}; event-unreadable-styles=${event.unreadableStyleCount}; event-capacity=${event.capacityOmissionCount}; event-custom-hosts=${event.customElementHostCount}; event-custom-hosts-without-open-root=${event.customElementHostWithoutAccessibleOpenRootCount}; event-open-roots=${event.accessibleOpenShadowRootCount}; event-missing-proof-fallbacks=${event.missingReconciliationProofFallbackCount}; event-covered-dirty-fallbacks=${event.coveredDirtyBranchFallbackCount}; event-attribute-context-fallbacks=${event.attributeContextFallbackCount}; event-cross-parent-fallbacks=${event.crossParentFallbackCount}; sequence=${info.sequence}`,
    );
    console.info(
      `[Simul fidelity resources] policy=${info.fidelityPolicy}; baseline-preserved-stylesheets=${info.preservedStyleSheetCount}; baseline-flattened-stylesheets=${info.flattenedStyleSheetCount}; baseline-omitted-stylesheets=${info.omittedStyleSheetCount}; baseline-preserved-svg=${info.preservedSvgResourceCount}; baseline-blocked-svg=${info.blockedSvgResourceCount}; baseline-request-capable=${info.replicaRequestCapableResourceCount}; baseline-execution-risk-blocks=${info.executionRiskBlockCount}; baseline-navigation-blocks=${info.navigationBlockCount}; baseline-unsupported-scheme-blocks=${info.unsupportedSchemeBlockCount}; baseline-browser-inaccessible=${info.browserInaccessibleResourceCount}; baseline-strict-policy-blocks=${info.strictResourcePolicyBlockCount}; event-preserved-stylesheets=${event.preservedStyleSheetCount}; event-flattened-stylesheets=${event.flattenedStyleSheetCount}; event-omitted-stylesheets=${event.omittedStyleSheetCount}; event-preserved-svg=${event.preservedSvgResourceCount}; event-blocked-svg=${event.blockedSvgResourceCount}; event-request-capable=${event.replicaRequestCapableResourceCount}; event-execution-risk-blocks=${event.executionRiskBlockCount}; event-navigation-blocks=${event.navigationBlockCount}; event-unsupported-scheme-blocks=${event.unsupportedSchemeBlockCount}; event-browser-inaccessible=${event.browserInaccessibleResourceCount}; event-strict-policy-blocks=${event.strictResourcePolicyBlockCount}; replica-requests-may-occur=${info.replicaRequestsMayOccur}; sequence=${info.sequence}`,
    );
  },
});
let lastPatchInfoLogAt = 0;
let coalescedPatchInfoLogs = 0;
const PATCH_INFO_LOG_INTERVAL_MS = 2_000;

/**
 * Checkpoint, recovery and failure summaries always log. Per-patch summaries
 * are several hundred characters each and arrive many times per second on a
 * busy page, so they are coalesced to one line per interval.
 */
function shouldLogIsolatedMirrorInfo(stage: string): boolean {
  if (stage !== 'patch') return true;
  const now = Date.now();
  if (now - lastPatchInfoLogAt < PATCH_INFO_LOG_INTERVAL_MS) {
    coalescedPatchInfoLogs += 1;
    return false;
  }
  lastPatchInfoLogAt = now;
  if (coalescedPatchInfoLogs > 0) {
    console.info(
      `[Simul isolated mirror] coalesced=${coalescedPatchInfoLogs} patch summaries in the last ${PATCH_INFO_LOG_INTERVAL_MS}ms`,
    );
    coalescedPatchInfoLogs = 0;
  }
  return true;
}

replicaEngineController = new ReplicaEngineController({
  legacy: new LegacyReplicaEngine(),
  isolated: isolatedHtmlReplicaEngine,
  onDiagnostics: (diagnostics) => {
    // This object is intentionally content-free: local size/timing/extent
    // numbers and a bounded code only. It never includes page text or URLs.
    console.info('[Simul replica]', diagnostics);
  },
  onFallback: () => {
    imageTranslationController?.releaseReplica();
    replicaTranslationCoordinator.selectPair(undefined);
  },
});
replicaSurfaceRouter.select(isolatedHtmlReplicaEngine);

const translationMemory = new TranslationMemory({
  maxEntries: 2_048,
  maxCharacters: 500_000,
});
const imageTranslationMemory = new TranslationMemory({
  maxEntries: 512,
  maxCharacters: 250_000,
});
const uiLocalizer = new UiLocalizer({
  document,
  provider,
  dynamicLabels: DYNAMIC_UI_LABELS,
  getTargetLanguage: () => state.preferences.targetLanguage,
  translateRemembered,
});
const quickComposer = new QuickComposer({
  elements: {
    input: composerInput,
    output: composerOutput,
    copyButton: copyComposerButton,
    fromLanguage: composerFromLanguage,
    toLanguage: composerToLanguage,
    guidance: composerGuidance,
    status: composerStatus,
  },
  provider,
  selectedPair: () => state.selectedPair(),
  getTargetLanguage: () => state.preferences.targetLanguage,
  translateRemembered,
  setUiText: (element, english) => uiLocalizer.setText(element, english),
  setStatus,
  onActivityChange: () => updateControls(),
  onTranslated: () => logTranslationCache('quick', translationMemory),
  readableError,
});
const imageAnalysisPanel = new ImageAnalysisPanel({
  document,
  host: imageAnalysisHost,
  capabilities: compiledImageAnalysisCapabilities,
  compiledProviderOrder: effectiveCompiledProviderOrder,
  hasCompiledCapability: hasCompiledImageAnalysisCapability,
  readView: () => ({
    imageTranslationEnabled: state.preferences.imageTranslationEnabled,
    imageCaptureAccess: state.imageCaptureAccess,
    permissionInFlight: state.permissionInFlight,
    imageTextProviderOrder: state.preferences.imageTextProviderOrder,
    imageScanPolicy: state.preferences.imageScanPolicy,
    skipSmallImages: state.preferences.skipSmallImages,
    usePromptForImageLanguage: state.preferences.usePromptForImageLanguage,
    usePromptForImageText: state.preferences.usePromptForImageText,
  }),
  setUiText: (element, english) => uiLocalizer.setText(element, english),
  changeImageTranslationEnabled: (enabled) =>
    permissionFlows.changeImageTranslationEnabled(enabled),
  commitPatch: commitImageAnalysisPreferencePatch,
});
const toolbarStatus = new ToolbarStatus({
  elements: {
    status: statusElement,
    refreshAttention,
    settingsAttention,
    toolbarProgress,
    toolbarProgressFill,
    compactToolbar,
    progressRegion,
    progressLabel,
    progressElement,
  },
  readActivity: () => ({
    ...state.activity,
    composerInFlight: quickComposer.inFlight,
  }),
  isSettingsOpen: () => state.openCompanionOverlay === 'settings',
});
const preferenceClient = new PreferenceClient({
  store: {
    get: () => state.preferences,
    set: (next) => {
      state.preferences = next;
      syncPreferenceControls();
    },
  },
  sendMessage: (command) => browser.runtime.sendMessage(command),
  readStorage: () => browser.storage.local.get(STORAGE_KEY),
  onViewSettled: () => {
    mirrorView.updateLayout();
    mirrorView.applyTextLayout(state.preferences.textLayoutMode);
  },
  onError: (message) => setStatus(message, 'error'),
  readableError,
});
const permissionFlows = new PermissionFlows({
  state,
  currency,
  permissions: {
    contains: (permissions) => browser.permissions.contains(permissions),
    request: (permissions) => browser.permissions.request(permissions),
    remove: (permissions) => browser.permissions.remove(permissions),
    getAll: () => browser.permissions.getAll(),
  },
  locks: () => navigator.locks,
  isUserActivationActive: () => navigator.userActivation.isActive,
  preferenceClient,
  setStatus,
  syncPreferenceControls: () => syncPreferenceControls(),
  updateControls: () => updateControls(),
  renderImagePanel: () => imageAnalysisPanel.render(),
  configureImageTranslation: () => configureImageTranslation(),
  requestAutomaticTranslation: async (pageUrl) => {
    if (!state.snapshot || state.isLiveSourceOnlyMode) return;
    state.translationDesired = true;
    await maybeTranslateAutomatically(captureCoordinator.generation, pageUrl);
  },
});
const sourceFollower = new SourceFollower({
  state,
  currency,
  browser: {
    getTab: (tabId) => browser.tabs.get(tabId),
    queryActiveTab: async (windowId) => {
      const [tab] = await browser.tabs.query(
        windowId === undefined
          ? { active: true, currentWindow: true }
          : { active: true, windowId },
      );
      return tab;
    },
    getWindow: (windowId) => browser.windows.get(windowId),
    getCurrentWindowId: async () => (await browser.windows.getCurrent()).id,
    getLastFocusedNormalWindowId: async () =>
      (await browser.windows.getLastFocused({ windowTypes: ['normal'] })).id,
    windowIdNone: browser.windows.WINDOW_ID_NONE,
  },
  detachedIdentityHint,
  navigationDebounceMs: NAVIGATION_DEBOUNCE_MS,
  queueCapture,
  invalidateCompanion,
  onSourceNavigationStarted: () => {
    captureCoordinator.invalidate();
    currency.supersedePage();
    state.abortPageWork();
    imageTranslationController.releaseReplica();
    quickComposer.invalidate();
    state.pendingLiveUpdate = undefined;
  },
  onFollowedTabActivated: () => imageTranslationController?.resume(),
  setStatus,
  renderError: (message) => mirrorView.renderError(message),
  updateControls: () => updateControls(),
});
replicaTranslationCoordinator = new ReplicaTranslationCoordinator(
  provider,
  replicaSurfaceRouter,
  {
    memory: translationMemory,
    onBackgroundResult: (result) => {
      if (!replicaTranslationCoordinator.isResultCurrent(result)) return;
      logTranslationCache('page', translationMemory);
      if (!isCompleteReplicaTranslationResult(result)) {
        state.translationComplete = false;
        setStatus(
          describePartialReplicaTranslation(
            result,
            'Live page changes were only partially translated',
          ),
          'warning',
        );
      } else if (result.completed > 0) {
        setStatus(
          state.translationComplete
            ? 'Live page changes were mirrored and translated.'
            : 'Live page changes were translated, but earlier incomplete text still needs Translate page.',
          state.translationComplete ? 'success' : 'warning',
        );
      }
      updateControls();
    },
  },
);

imageTranslationController = new ImageTranslationController({
  openSource: (request, onChange, signal) => openChromeImageSource(
    request,
    onChange,
    signal,
    'isolated-html',
  ),
  createPixelCoordinator: (source, sourceTabId, sourceWindowId) =>
    new PixelAcquisitionCoordinator(
      createBrowserPixelAcquisitionEnvironment(
        source,
        sourceTabId,
        sourceWindowId,
      ),
    ),
  createRecognitionCoordinator: () =>
    createBrowserImageRecognitionCoordinator(
      new IndexedDbTransientImageStore(),
    ),
  resolveAnchor: (sourceDocument, nodeId) =>
    replicaSurfaceRouter.resolveImageAnchor(sourceDocument, nodeId),
  translationProvider: provider,
  translationMemory: imageTranslationMemory,
  onBusyChange: (busy) => setImageTranslationBusy(busy),
  onDiagnostic: logImageTranslationDiagnostic,
});

function handleReplicaSourceCommit(commit: ReplicaSourceCommit): void {
  const pending = state.pendingImageReplicaActivation;
  const selectedSnapshot = replicaSurfaceRouter.snapshot();
  if (
    pending &&
    !pending.activated &&
    !pending.signal.aborted &&
    pending.request.isCurrent() &&
    captureRequestMatchesSourceDocument(pending.request, commit.document) &&
    selectedSnapshot &&
    captureRequestMatchesSourceDocument(
      pending.request,
      selectedSnapshot.document,
    ) &&
    sameSourceReplicaLease(selectedSnapshot, commit)
  ) {
    pending.activated = imageTranslationController?.activateReplica(
      pending.request,
      pending.sourceWindowId,
      commit.replayLease,
    ) ?? false;
  } else if (
    selectedSnapshot &&
    sameSourceReplicaLease(selectedSnapshot, commit)
  ) {
    imageTranslationController?.notifyReplicaCommit(
      commit.document,
      commit.replayLease,
    );
  }
  if (state.isLiveSourceOnlyMode) return;
  replicaTranslationCoordinator.handleSourceCommit(commit);
  const action = replicaSourceCommitAction(
    commit,
    state.preferences.sourceLanguage === 'auto',
  );
  if (!action.prepareForNewText && !action.refreshDetectedLanguage) return;
  const refresh = currency.begin('language-refresh');
  void reconcileReplicaTranslationAfterCommit(
    commit,
    refresh,
    action.refreshDetectedLanguage,
    action.prepareForNewText,
  );
}

function handleReplicaLiveFailure(code: ReplicaDiagnosticCode): void {
  const identity = state.followedOrCapturedIdentity;
  const action = identity
    ? liveReplicaFailureRecoveryGate.decide(
        visibleReplayHost.hasCommittedReplica,
      )
    : 'fallback';
  // Content-free by construction: bounded enums only, with no page identity,
  // source text, URL, DOM identifier, pixels, or resource metadata.
  console.info('[Simul replica live failure]', {
    engine: 'isolated-html',
    code,
    state: action,
  });
  if (action === 'rebuild-last-good' && identity) {
    setStatus(
      'The live mirror disconnected. Rebuilding once while keeping the last good replica visible…',
      'warning',
    );
    queueCapture({ identity, reason: 'desynchronized' });
    return;
  }

  liveReplicaFailureRecoveryGate.reset();
  imageTranslationController?.releaseReplica();
  replicaTranslationCoordinator.selectPair(undefined);
  legacyTransitionGate.release();
  replicaEngineController.disableSelected(code);
  if (identity) queueCapture({ identity, reason: 'desynchronized' });
}

const companionBuildIdentity = createExtensionBuildIdentity(
  browser.runtime.getManifest(),
);
renderExtensionBuildIdentity(buildVersionElement, companionBuildIdentity);
console.info(companionBuildIdentity.companionReadyMessage);

populateLanguageOptions();
imageAnalysisPanel.initialize();
configureSurfaceButton();
observeReplicaStateLabel();
uiLocalizer.schedule();

toggleSettingsButton.addEventListener('click', () => {
  setCompanionOverlay(nextCompanionOverlay(state.openCompanionOverlay, 'settings'));
});
toggleQuickTranslateButton.addEventListener('click', () => {
  setCompanionOverlay(
    nextCompanionOverlay(state.openCompanionOverlay, 'quick-translate'),
  );
});
closeSettingsButton.addEventListener('click', () => setCompanionOverlay());
closeQuickTranslateButton.addEventListener('click', () => setCompanionOverlay());
popoutButton.addEventListener('click', () => {
  if (state.surfaceTransitionInFlight) return;
  state.surfaceTransitionInFlight = true;
  updateControls();
  void (isDetachedWindow ? returnToSidePanel() : openDetachedWindow()).finally(() => {
    state.surfaceTransitionInFlight = false;
    updateControls();
  });
});
toolbarAutoDetectButton.addEventListener('click', () => {
  sourceSelect.value = 'auto';
  void languageSelectionChanged();
});
toolbarSizeToggleButton.addEventListener('click', () => {
  const displayMode = state.preferences.displayMode === 'fit' ? 'actual' : 'fit';
  void commitViewPreferencePatch({ displayMode });
  mirrorView.updateLayout();
});
toolbarOcrToggleButton.addEventListener('click', () => {
  void permissionFlows.changeImageTranslationEnabled(
    !state.preferences.imageTranslationEnabled || state.imageCaptureAccess !== 'granted',
  );
});
toolbarTabFollowButton.addEventListener('click', () => {
  if (!isDetachedWindow) return;
  void changePopoutTabMode(
    state.preferences.popoutTabMode === 'active' ? 'locked' : 'active',
  );
});

sourceSelect.addEventListener('change', () => void languageSelectionChanged());
targetSelect.addEventListener('change', () => void languageSelectionChanged());
swapButton.addEventListener('click', () => {
  if (!state.resolvedSourceLanguage) return;
  const previousTarget = targetSelect.value;
  sourceSelect.value = previousTarget;
  targetSelect.value = state.resolvedSourceLanguage;
  void languageSelectionChanged();
});

autoTranslateSelect.addEventListener('change', () => {
  const mode = isAutoTranslationMode(autoTranslateSelect.value)
    ? autoTranslateSelect.value
    : 'off';
  void permissionFlows.changeAutoTranslationMode(mode);
});

displayModeSelect.addEventListener('change', () => {
  const mode = isMirrorDisplayMode(displayModeSelect.value)
    ? displayModeSelect.value
    : 'fit';
  void commitViewPreferencePatch({ displayMode: mode });
  mirrorView.updateLayout();
});

textLayoutSelect.addEventListener('change', () => {
  const mode = isTextLayoutMode(textLayoutSelect.value)
    ? textLayoutSelect.value
    : 'adaptive';
  void commitViewPreferencePatch({ textLayoutMode: mode });
  mirrorView.applyTextLayout(mode);
  mirrorView.updateLayout();
});

replicaFidelityPolicySelect.addEventListener('change', () => {
  const replicaFidelityPolicy: SelectableReplicaFidelityPolicy =
    isSelectableReplicaFidelityPolicy(replicaFidelityPolicySelect.value)
      ? replicaFidelityPolicySelect.value
      : 'passive';
  void changeReplicaFidelityPolicy(replicaFidelityPolicy);
});

replicaViewModeSelect.addEventListener('change', () => {
  const replicaViewMode: ReplicaViewMode =
    isReplicaViewMode(replicaViewModeSelect.value)
      ? replicaViewModeSelect.value
      : 'translated';
  void changeReplicaViewMode(replicaViewMode);
});

launchBehaviorSelect.addEventListener('change', () => {
  const launchBehavior: CompanionLaunchBehavior =
    isCompanionLaunchBehavior(launchBehaviorSelect.value)
      ? launchBehaviorSelect.value
      : 'last-used';
  void commitViewPreferencePatch({ launchBehavior });
});

popoutTabModeSelect.addEventListener('change', () => {
  const popoutTabMode: PopoutTabMode = isPopoutTabMode(popoutTabModeSelect.value)
    ? popoutTabModeSelect.value
    : 'locked';
  void changePopoutTabMode(popoutTabMode);
});

syncScrollInput.addEventListener('change', () => {
  void commitViewPreferencePatch({ syncScroll: syncScrollInput.checked });
  if (state.preferences.syncScroll && state.lastSourceScroll) mirrorView.followSourceScroll(state.lastSourceScroll);
});

zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
zoomInButton.addEventListener('click', () => setZoom(state.preferences.zoomPercent + 10));
zoomOutButton.addEventListener('click', () => setZoom(state.preferences.zoomPercent - 10));
const requestManualRefresh = (): void => {
  void sourceFollower.refreshFollowedPage('manual');
};
refreshButton.addEventListener('click', requestManualRefresh);
compactRefreshButton.addEventListener('click', requestManualRefresh);
translateButton.addEventListener('click', () => {
  if (!state.isLiveSourceOnlyMode) state.translationDesired = true;
  void startTranslation(false, captureCoordinator.generation);
});
cancelButton.addEventListener('click', () => {
  state.activeAbortController?.abort();
  const composerCancelled = quickComposer.cancel();
  imageTranslationController.cancelCurrent();
  setStatus(
    state.translationInFlight || state.imageTranslationInFlight
      ? 'Cancelling on-device translation…'
      : composerCancelled
        ? 'Quick translation cancelled.'
        : 'Nothing is currently being translated.',
    composerCancelled && !state.translationInFlight && !state.imageTranslationInFlight
      ? 'warning'
      : 'normal',
  );
});
translateComposerButton.addEventListener('click', () => void quickComposer.translate());
copyComposerButton.addEventListener('click', () => void quickComposer.copy());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.openCompanionOverlay) {
    event.preventDefault();
    setCompanionOverlay();
  }
});
window.addEventListener('pagehide', () => {
  uiLocalizer.cancel();
  state.replicaShadowAbortController?.abort();
  imageTranslationController.dispose();
  replicaTranslationCoordinator.dispose();
  replicaEngineController.dispose();
  releaseLiveSession();
});

browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const authorizedTab = readAuthorizedTabMessage(message);
  if (authorizedTab) {
    void sourceFollower.acceptAuthorizedTab(authorizedTab);
    return;
  }
  const dirty = readLivePageDirtyMessage(message);
  if (
    dirty &&
    isMessageFromFollowedTab(
      sender.tab,
      dirty.sessionId,
      dirty.generation,
      dirty.url,
    )
  ) {
    queueLiveUpdate(dirty);
    // Acknowledge so the page-side bridge does not treat a consumed message
    // as undelivered and resend it.
    sendResponse(true);
    return;
  }
  const scroll = readLivePageScrollMessage(message);
  if (
    scroll &&
    isMessageFromFollowedTab(
      sender.tab,
      scroll.sessionId,
      scroll.generation,
      scroll.url,
    )
  ) {
    state.lastSourceScroll = scroll;
    state.acceptedScrollMessageCount += 1;
    const logScroll = state.acceptedScrollMessageCount <= 3 ||
      state.acceptedScrollMessageCount % 50 === 0;
    if (logScroll) {
      console.info(
        `[Simul scroll] received; count=${state.acceptedScrollMessageCount}; target=${scroll.scrollTarget}`,
      );
    }
    if (state.preferences.syncScroll) {
      mirrorView.followSourceScroll(scroll);
      if (logScroll) {
        console.info(
          `[Simul scroll] projected; count=${state.acceptedScrollMessageCount}; target=${scroll.scrollTarget}`,
        );
      }
    }
    sendResponse(true);
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) imageTranslationController?.resume();
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  sourceFollower.handleTabActivated(tabId, windowId);
});
browser.windows.onFocusChanged.addListener((windowId) => {
  sourceFollower.handleWindowFocusChanged(windowId);
});
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  sourceFollower.handleTabAttached(tabId, newWindowId);
});
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  sourceFollower.handleTabUpdated(tabId, changeInfo, tab);
});
browser.tabs.onRemoved.addListener((tabId) => {
  sourceFollower.handleTabRemoved(tabId);
});

browser.permissions.onAdded.addListener(() => {
  void permissionFlows.refreshImageCaptureAccess();
});

browser.permissions.onRemoved.addListener(() => {
  void permissionFlows.refreshImageCaptureAccess(true);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
  const previous = state.preferences;
  state.preferences = mergePendingViewPreferences(
    parseCompanionPreferences(changes[STORAGE_KEY]?.newValue),
  );
  if (
    isDetachedWindow &&
    previous.popoutTabMode !== state.preferences.popoutTabMode &&
    state.preferences.popoutTabMode === 'active'
  ) {
    void sourceFollower.followCurrentActiveSourceTab();
  }
  if (previous.replicaFidelityPolicy !== state.preferences.replicaFidelityPolicy) {
    liveReplicaFailureRecoveryGate.reset();
    const identity = state.followedOrCapturedIdentity;
    if (identity) queueCapture({ identity, reason: 'preference' });
  }
  if (previous.replicaViewMode !== state.preferences.replicaViewMode) {
    applyReplicaViewMode(previous.replicaViewMode);
  }
  syncPreferenceControls();
  mirrorView.updateLayout();
  mirrorView.applyTextLayout(state.preferences.textLayoutMode);
  if (
    state.snapshot &&
    (previous.sourceLanguage !== state.preferences.sourceLanguage ||
      previous.targetLanguage !== state.preferences.targetLanguage)
  ) {
    const needsFreshCapture = releaseReplicaPresentationForLegacyWork();
    state.activeAbortController?.abort();
    abortAndRequeueLiveDelta();
    quickComposer.invalidate();
    // The window that changed the languages already recorded its own intent
    // in languageSelectionChanged. A change made in another companion window
    // must not opt this one into translating.
    state.translationComplete = false;
    state.availabilityCheckedForPair = undefined;
    mirrorView.resetTextIfPresent();
    if (needsFreshCapture) {
      const identity = state.followedOrCapturedIdentity;
      if (identity) {
        queueCapture({ identity, reason: 'preference' });
        return;
      }
    }
    void applyLanguagePreferences(false);
  }
});

void initialize();

async function initialize(): Promise<void> {
  await Promise.all([loadPreferences(), sourceFollower.loadPanelWindowId()]);
  await permissionFlows.refreshImageCaptureAccess();
  const [, sourceResult] = await Promise.allSettled([
    checkPanelPlacement(),
    sourceFollower.initializeSourcePage(),
  ]);
  if (sourceResult.status === 'rejected') {
    const message = readPageError(sourceResult.reason);
    mirrorView.renderError(message);
    setStatus(message, 'error');
    updateControls();
  }
}

async function loadPreferences(): Promise<void> {
  await preferenceClient.load();
}

function commitViewPreferencePatch(
  patch: CompanionViewSettingsPatch,
): Promise<boolean> {
  return preferenceClient.commitView(patch);
}

function commitImageAnalysisPreferencePatch(
  patch: CompanionImageAnalysisSettingsPatch,
): Promise<void> {
  return preferenceClient.commitImageAnalysis(patch);
}

function mergePendingViewPreferences(
  stored: CompanionPreferences,
): CompanionPreferences {
  return preferenceClient.mergePending(stored);
}

function queueCapture(request: CaptureRequest): void {
  const previousIdentity = state.capturedOrFollowedIdentity;
  const samePage = sameCompanionSourcePage(
    previousIdentity,
    request.identity,
    normalizedPageUrl,
  );
  if (!samePage) liveReplicaFailureRecoveryGate.reset();
  if (!samePage || request.reason === 'navigation') {
    state.lastSourceScroll = undefined;
    visibleReplayHost.resetSourceScroll();
  }
  const retainTranslationIntent =
    samePage &&
    (request.reason === 'manual' ||
      request.reason === 'desynchronized' ||
      request.reason === 'preference');
  if (!retainTranslationIntent) {
    replicaTranslationCoordinator.selectPair(undefined);
    state.resetTranslationIntent();
    quickComposer.invalidate();
  }
  if (previousIdentity && previousIdentity.tabId !== request.identity.tabId) {
    releaseLiveSession(previousIdentity);
  }
  state.abortPageWork();
  state.pendingImageReplicaActivation = undefined;
  imageTranslationController.releaseReplica();
  currency.supersede('availability');
  state.resetLiveSequence();
  state.followedPageIdentity = request.identity;
  if (!state.snapshot) mirrorView.renderLoading();
  setStatus(
    request.reason === 'desynchronized'
      ? 'A live update could not be reconciled. Rebuilding once while keeping the current mirror visible…'
      : request.reason === 'navigation'
        ? 'Building the live mirror for the newly loaded page…'
        : 'Building the initial live read-only mirror…',
  );
  const enqueued = captureCoordinator.enqueue(request);
  updateControls();
  if (enqueued.startNow) void runCaptureWork(enqueued.work);
}

async function runCaptureWork(work: GenerationWork<CaptureRequest>): Promise<void> {
  state.captureInFlight = true;
  updateControls();
  try {
    await capturePage(work);
  } finally {
    const next = captureCoordinator.finish(work.generation);
    if (next) {
      void runCaptureWork(next);
      return;
    }
    state.captureInFlight = false;
    updateControls();
    void processPendingLiveUpdate();
  }
}

async function capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
  const identity = work.value.identity;
  let currentLegacyReady = false;
  try {
    const observerBundleResults = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        files: ['/page-live-observer.js'],
      }),
    );
    if (observerBundleResults.length === 0) {
      throw new PageAccessError('The page could not load its live update bridge.');
    }
    const observerResults = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: invokeLivePageObserverBridge,
        args: [liveSessionId, work.generation],
      }),
    );
    const observerInstallation = readLivePageObserverInstallation(
      observerResults[0]?.result,
    );
    if (
      !observerInstallation ||
      observerInstallation.generation !== work.generation
    ) {
      throw new PageAccessError('The page could not start its live update bridge.');
    }
    state.liveObservationAvailable = observerInstallation.installed;
    console.info(
      `[Simul scroll] observer-${observerInstallation.installed ? 'installed' : 'limited'}; generation=${work.generation}`,
    );
    if (observerInstallation.installed) {
      initializeLiveSequenceBaseline(
        work.generation,
        observerInstallation.sequence,
      );
    }
    const sameCapturedPage = Boolean(
      state.capturedPageIdentity &&
        state.capturedPageIdentity.tabId === identity.tabId &&
        state.capturedPageIdentity.windowId === identity.windowId &&
        normalizedPageUrl(state.capturedPageIdentity.url) ===
          normalizedPageUrl(identity.url),
    );
    const preserveLastGoodReplica =
      shouldPreserveCommittedReplicaForCapture(
        work.value.reason,
        sameCapturedPage,
        visibleReplayHost.hasCommittedReplica,
      );
    // New identities hand authority back to v1 before serialization. A
    // same-page manual/recovery rebuild keeps last-good visible while the
    // selected engine stages its replacement offscreen and swaps atomically.
    if (!preserveLastGoodReplica) {
      // A new page is being built, not a fallback: no "fallback" badge.
      releaseReplicaPresentationForLegacyWork(true, false);
    }
    const results = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: capturePageSnapshot,
      }),
    );
    const snapshotInjection = results[0];
    const nextSnapshot = parsePageSnapshot(snapshotInjection?.result);
    const currentTab = await browser.tabs.get(identity.tabId);
    assertSnapshotIsCurrent(currentTab, identity, state.requiresActiveSourceTab);
    if (!captureCoordinator.isCurrent(work.generation)) return;

    state.translationComplete = false;
    mirrorView.renderSnapshot(nextSnapshot);
    state.snapshot = nextSnapshot;
    state.capturedPageIdentity = identity;
    state.capturedPageDocumentId = typeof snapshotInjection?.documentId === 'string'
      ? snapshotInjection.documentId
      : undefined;
    state.followedPageIdentity = identity;
    currentLegacyReady = true;
    showCaptureNotes(nextSnapshot);
    if (snapshotInjection?.documentId) {
      await runReplicaEngineCheckpoint(
        work,
        identity,
        snapshotInjection.documentId,
      );
      if (!captureCoordinator.isCurrent(work.generation)) return;
    } else if (!snapshotInjection?.documentId) {
      imageTranslationController.releaseReplica();
      replicaEngineController.releasePresentation(true);
    }
    await resolveSelectedSourceLanguage();

    if (state.isLiveSourceOnlyMode) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      setStatus(
        'Live source only is active. The sanitized mirror keeps updating without text or image translation.',
        'success',
      );
      return;
    }

    if (currentTranslationFieldCount() === 0) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      const accessWasRevoked = await permissionFlows.reconcileAutomaticAccess(identity.url);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      setStatus(
        accessWasRevoked
          ? 'Chrome removed a saved automatic-access grant. The mirror is waiting for page text.'
          : state.liveObservationAvailable
            ? 'The page mirror is live and will prepare translation when visible text arrives.'
            : 'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
        'warning',
      );
      return;
    }
    await checkAvailability(work.generation);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const accessWasRevoked = await permissionFlows.reconcileAutomaticAccess(identity.url);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (accessWasRevoked) {
      setStatus('Chrome removed a saved automatic-access grant, so that scope was turned off.', 'warning');
      return;
    }
    await maybeTranslateAutomatically(work.generation, identity.url);
    if (!state.liveObservationAvailable && captureCoordinator.isCurrent(work.generation)) {
      setStatus(
        'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
        'warning',
      );
    }
  } catch (error) {
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (shouldReleaseReplicaAfterCaptureFailure(
      currentLegacyReady,
      state.capturedPageIdentity === identity,
      visibleReplayHost.hasCommittedReplica,
    )) {
      imageTranslationController.releaseReplica();
      replicaEngineController.releasePresentation(true);
    }
    const message = readPageError(error);
    if (!state.snapshot) mirrorView.renderError(message);
    setStatus(message, 'error');
  } finally {
    updateControls();
  }
}

async function runReplicaEngineCheckpoint(
  work: GenerationWork<CaptureRequest>,
  identity: CapturedPageIdentity,
  documentId: string,
): Promise<void> {
  state.replicaShadowAbortController?.abort();
  const abortController = new AbortController();
  state.replicaShadowAbortController = abortController;
  const request: ReplicaCaptureRequest = {
    sessionId: liveSessionId,
    pageEpoch: work.generation,
    generation: work.generation,
    tabId: identity.tabId,
    frameId: 0,
    documentId,
    isCurrent: () =>
      captureCoordinator.isCurrent(work.generation) &&
      state.capturedPageIdentity === identity &&
      state.followedPageIdentity?.tabId === identity.tabId &&
      normalizedPageUrl(state.followedPageIdentity.url) === normalizedPageUrl(identity.url),
  };
  let shadowCommitted = false;
  const imageActivation: PendingImageReplicaActivation = {
    request,
    sourceWindowId: identity.windowId,
    signal: abortController.signal,
    activated: false,
  };
  state.pendingImageReplicaActivation = imageActivation;
  const shadowOwnershipStarted = replicaEngineController.selectedAvailable;
  if (shadowOwnershipStarted) {
    legacyTransitionGate.beginShadowOwnership();
  }
  try {
    const result = await replicaEngineController.run(request, abortController.signal);
    shadowCommitted = isCommittedShadowReplica(
      result,
      visibleReplayHost.hasCommittedReplica,
    );
    if (shadowCommitted) {
      liveReplicaFailureRecoveryGate.markCommitted();
      if (!imageActivation.activated) {
        const selectedSnapshot = replicaSurfaceRouter.snapshot();
        if (
          state.pendingImageReplicaActivation === imageActivation &&
          !imageActivation.signal.aborted &&
          request.isCurrent() &&
          selectedSnapshot &&
          captureRequestMatchesSourceDocument(
            request,
            selectedSnapshot.document,
          )
        ) {
          imageActivation.activated = imageTranslationController.activateReplica(
            request,
            identity.windowId,
            selectedSnapshot.replayLease,
          );
        }
      }
      mirrorView.updateLayout();
    }
  } finally {
    if (state.pendingImageReplicaActivation === imageActivation) {
      state.pendingImageReplicaActivation = undefined;
    }
    if (shadowOwnershipStarted && !shadowCommitted) {
      const needsFreshCapture = legacyTransitionGate.release();
      if (needsFreshCapture && request.isCurrent()) {
        queueCapture({ identity, reason: 'desynchronized' });
      }
    }
    if (
      state.replicaShadowAbortController === abortController &&
      !visibleReplayHost.hasCommittedReplica
    ) {
      state.replicaShadowAbortController = undefined;
    }
  }
}

interface LiveLanguageContext {
  documentLanguage?: string;
  visibleText: string;
  preserveOnUnknown: boolean;
}

async function resolveSelectedSourceLanguage(
  liveContext?: LiveLanguageContext,
): Promise<boolean> {
  if (!state.snapshot) {
    state.resolvedSourceLanguage = undefined;
    quickComposer.syncPanel();
    configureImageTranslation();
    return true;
  }
  if (liveContext) {
    // Keep the snapshot identity stable unless the language really changed;
    // an in-flight availability check is discarded when the identity moves.
    state.snapshot = snapshotWithLiveDocumentLanguage(
      state.snapshot,
      liveContext.documentLanguage,
    );
  }
  const requestedSnapshot = state.snapshot;
  const requestedPreference = state.preferences.sourceLanguage;
  const previousLanguage = state.resolvedSourceLanguage;
  const detectionSnapshot = liveContext
    ? { ...requestedSnapshot, items: [] }
    : requestedSnapshot;
  const detected = await resolveSourceLanguage(
    requestedPreference,
    detectionSnapshot,
    async (text) => browser.i18n.detectLanguage(text),
    liveContext?.visibleText ?? mirrorLanguageSample(),
  );
  if (
    state.snapshot !== requestedSnapshot ||
    state.preferences.sourceLanguage !== requestedPreference
  ) return false;
  state.resolvedSourceLanguage =
    detected.language ??
    (liveContext?.preserveOnUnknown ? previousLanguage : undefined);
  detectedLanguageElement.textContent = state.resolvedSourceLanguage
    ? requestedPreference === 'auto'
      ? detected.language
        ? `Detected ${languageName(state.resolvedSourceLanguage)} from ${detected.source === 'html' ? 'the page language' : 'visible page text'}.`
        : `Using the previously detected ${languageName(state.resolvedSourceLanguage)} source language.`
      : ''
    : 'The page language could not be detected. Choose a From language.';
  detectedLanguageElement.hidden = !detectedLanguageElement.textContent;
  quickComposer.syncPanel();
  configureImageTranslation();
  return true;
}

function mirrorLanguageSample(): string {
  if (usesReplicaTranslationProjection()) {
    return buildBoundedLanguageSample(
      replicaRecordSources(replicaSurfaceRouter.snapshot()?.records ?? []),
    );
  }
  return mirrorView.languageSample();
}

function currentTranslationFieldCount(): number {
  return usesReplicaTranslationProjection()
    ? replicaSurfaceRouter.snapshot()?.records.filter(
      ({ source }) => source.trim().length > 0,
    ).length ?? 0
    : mirrorView.translationFieldCount();
}

async function reconcileReplicaTranslationAfterCommit(
  commit: ReplicaSourceCommit,
  refresh: CurrencyToken,
  refreshDetectedLanguage: boolean,
  prepareForNewText: boolean,
): Promise<void> {
  if (state.isLiveSourceOnlyMode) return;
  const generation = commit.document.generation;
  const identity = state.capturedPageIdentity;
  if (
    !identity ||
    !state.snapshot ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  const previousPair = state.selectedPair();
  if (refreshDetectedLanguage) {
    const committed = await resolveSelectedSourceLanguage({
      documentLanguage: commit.documentLanguage,
      visibleText: buildBoundedLanguageSample(
        replicaRecordSources(commit.records),
      ),
      preserveOnUnknown: true,
    });
    if (!committed) return;
  }
  if (
    !currency.isCurrent(refresh) ||
    !captureCoordinator.isCurrent(generation) ||
    state.capturedPageIdentity !== identity ||
    (state.preferences.sourceLanguage === 'auto') !== refreshDetectedLanguage
  ) return;
  const nextPair = state.selectedPair();
  const pairChanged = !sameTranslationPair(previousPair, nextPair);
  if (pairChanged) {
    state.activeAbortController?.abort();
    state.translationComplete = false;
    state.availabilityCheckedForPair = undefined;
    quickComposer.invalidate();
    replicaTranslationCoordinator.selectPair(nextPair);
  }
  const expectedAvailabilityKey = nextPair
    ? availabilityPairKey(nextPair, generation)
    : undefined;
  // A language refresh can replace the snapshot identity and discard an
  // in-flight availability check, so any refreshing commit re-establishes
  // the pair's availability when it is not yet recorded for this generation.
  const needsPreparation =
    (prepareForNewText || refreshDetectedLanguage) &&
    currentTranslationFieldCount() > 0 &&
    (!expectedAvailabilityKey ||
      state.availabilityCheckedForPair !== expectedAvailabilityKey);
  if (!pairChanged && !needsPreparation) return;
  await checkAvailability(generation);
  if (
    currency.isCurrent(refresh) &&
    captureCoordinator.isCurrent(generation) &&
    state.capturedPageIdentity === identity &&
    sameTranslationPair(nextPair, state.selectedPair())
  ) {
    await maybeTranslateAutomatically(generation, identity.url);
  }
}

function* replicaRecordSources(
  records: readonly { readonly source: string }[],
): Generator<string> {
  for (const record of records) yield record.source;
}

async function languageSelectionChanged(): Promise<void> {
  const sourceLanguage = sourceSelect.value === 'auto'
    ? 'auto'
    : readLanguage(sourceSelect.value);
  const targetLanguage = readLanguage(targetSelect.value);
  const needsFreshCapture = releaseReplicaPresentationForLegacyWork();
  state.activeAbortController?.abort();
  abortAndRequeueLiveDelta();
  quickComposer.invalidate();
  if (!state.isLiveSourceOnlyMode) state.translationDesired = true;
  state.translationComplete = false;
  state.availabilityCheckedForPair = undefined;
  mirrorView.resetTextIfPresent();
  await commitViewPreferencePatch({ sourceLanguage, targetLanguage });
  if (needsFreshCapture) {
    const identity = state.followedOrCapturedIdentity;
    if (identity) {
      queueCapture({ identity, reason: 'preference' });
      return;
    }
  }
  await applyLanguagePreferences(true);
}

async function applyLanguagePreferences(fromUserAction: boolean): Promise<void> {
  if (!state.snapshot) return;
  await resolveSelectedSourceLanguage();
  if (state.isLiveSourceOnlyMode) {
    replicaTranslationCoordinator.selectPair(undefined);
    state.availability = 'unavailable';
    state.availabilityCheckedForPair = undefined;
    setStatus(
      'Live source only is active. Language choices are saved for translated mode.',
      'success',
    );
    updateControls();
    return;
  }
  replicaTranslationCoordinator.selectPair(state.selectedPair());
  await checkAvailability(captureCoordinator.generation);
  if (state.availability === 'available') {
    await startTranslation(!fromUserAction, captureCoordinator.generation);
  } else if (state.availability === 'downloadable' || state.availability === 'downloading') {
    setStatus('This language pair needs its on-device pack. Choose Translate once to prepare it.', 'warning');
  }
}

async function checkAvailability(generation: number): Promise<void> {
  const request = currency.begin('availability');
  const requestedSnapshot = state.snapshot;
  const pair = state.selectedPair();
  if (state.isLiveSourceOnlyMode) {
    replicaTranslationCoordinator.selectPair(undefined);
    state.availability = 'unavailable';
    state.availabilityCheckedForPair = undefined;
    updateControls();
    return;
  }
  replicaTranslationCoordinator.selectPair(pair);
  if (
    !requestedSnapshot ||
    !mirrorView.root ||
    !pair ||
    currentTranslationFieldCount() === 0
  ) {
    state.availability = 'unavailable';
    state.availabilityCheckedForPair = undefined;
    if (!pair && requestedSnapshot) {
      setStatus('Choose a From language because automatic detection was inconclusive.', 'warning');
    }
    updateControls();
    return;
  }
  const checkedPairKey = availabilityPairKey(pair, generation);
  // The pair is recorded as checked only once a result is accepted. Recording
  // it before the await let a superseded request leave the pair marked as
  // checked while availability stayed 'unavailable', which disabled Translate
  // until a manual rebuild.
  state.availabilityCheckedForPair = undefined;
  state.availability = 'unavailable';
  updateControls();
  if (pair.sourceLanguage === pair.targetLanguage) {
    state.availabilityCheckedForPair = checkedPairKey;
    state.availability = 'available';
    mirrorView.resetTextIfPresent();
    state.translationComplete = true;
    setStatus('The source and target languages match, so the original text is unchanged.', 'success');
    updateControls();
    return;
  }
  try {
    const next = await provider.availability(pair);
    if (!isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) return;
    state.availabilityCheckedForPair = checkedPairKey;
    state.availability = next;
    switch (next) {
      case 'available':
        setStatus(`Ready to translate ${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} on-device.`);
        break;
      case 'downloadable':
      case 'downloading':
        setStatus('Choose Translate once so Chrome can prepare this on-device language pair.', 'warning');
        break;
      default:
        setStatus(`${languageName(pair.sourceLanguage)} to ${languageName(pair.targetLanguage)} is unavailable on this device.`, 'error');
    }
  } catch (error) {
    if (!isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) return;
    state.availabilityCheckedForPair = checkedPairKey;
    state.availability = 'unavailable';
    setStatus(readableError(error), 'error');
  } finally {
    if (isCurrentAvailabilityRequest(request, requestedSnapshot, pair, generation)) updateControls();
  }
}

async function maybeTranslateAutomatically(
  generation: number,
  pageUrl: string,
): Promise<void> {
  const action = replicaViewTranslationAction(
    state.preferences.replicaViewMode,
    isAutoTranslationEnabled(state.preferences, pageUrl),
    state.translationDesired,
    state.availability,
  );
  if (action === 'translate') {
    await startTranslation(true, generation);
  } else if (action === 'needs-user-action') {
    setStatus('Automatic translation is ready, but this pair needs one Translate click to prepare its local pack.', 'warning');
  }
}

function startTranslation(automatic: boolean, generation: number): Promise<void> {
  if (state.isLiveSourceOnlyMode) return Promise.resolve();
  const needsFreshCapture = releaseReplicaPresentationForLegacyWork();
  if (needsFreshCapture) {
    state.translationDesired = true;
    const identity = state.followedOrCapturedIdentity;
    if (identity) queueCapture({ identity, reason: 'desynchronized' });
    return Promise.resolve();
  }
  const requestedKey = state.currentTranslationTaskKey(generation);
  if (state.activeTranslationTask) {
    if (state.activeTranslationKey === requestedKey) return state.activeTranslationTask;
    state.activeAbortController?.abort();
    const previousTask = state.activeTranslationTask;
    return previousTask.catch(() => undefined).then(async () => {
      if (
        !captureCoordinator.isCurrent(generation) ||
        state.currentTranslationTaskKey(generation) !== requestedKey
      ) return;
      await startTranslation(automatic, generation);
    });
  }
  const task = runTranslation(automatic, generation);
  state.activeTranslationTask = task;
  state.activeTranslationKey = requestedKey;
  void task.then(() => {
    if (state.activeTranslationTask === task) {
      state.activeTranslationTask = undefined;
      state.activeTranslationKey = undefined;
    }
    void processPendingLiveUpdate();
  }, () => {
    if (state.activeTranslationTask === task) {
      state.activeTranslationTask = undefined;
      state.activeTranslationKey = undefined;
    }
    void processPendingLiveUpdate();
  });
  return task;
}

async function runTranslation(automatic: boolean, generation: number): Promise<void> {
  const pair = state.selectedPair();
  const root = mirrorView.root;
  const identity = state.capturedPageIdentity;
  if (
    !pair ||
    !root ||
    !identity ||
    state.isLiveSourceOnlyMode ||
    state.translationInFlight ||
    state.availability === 'unavailable' ||
    (automatic && state.availability !== 'available')
  ) return;
  if (pair.sourceLanguage === pair.targetLanguage) {
    if (usesReplicaTranslationProjection()) {
      replicaTranslationCoordinator.selectPair(pair);
    }
    resetVisualMirrorText(root);
    state.translationComplete = true;
    updateControls();
    return;
  }

  const abortController = new AbortController();
  state.activeAbortController = abortController;
  state.translationInFlight = true;
  configureImageTranslation();
  state.translationDesired = true;
  state.translationComplete = false;
  showProgress('Preparing Chrome\'s on-device language model…', 0, 1);
  updateControls();
  let session: TranslationSession | undefined;
  try {
    const tab = await browser.tabs.get(identity.tabId);
    assertSnapshotIsCurrent(tab, identity, state.requiresActiveSourceTab);
    if (
      !captureCoordinator.isCurrent(generation) ||
      mirrorView.root !== root ||
      !state.isCurrentTranslationPair(pair) ||
      state.isLiveSourceOnlyMode
    ) return;
    state.availability = 'available';
    state.availabilityCheckedForPair = availabilityPairKey(pair, generation);
    const result = usesReplicaTranslationProjection()
      ? await replicaTranslationCoordinator.translateCurrent(pair, {
        signal: abortController.signal,
        onDownloadProgress: (progress) =>
          showProgress(`Downloading language pack… ${Math.round(progress * 100)}%`, progress, 1),
        onProgress: (completed, total) =>
          showProgress(`Translating ${completed} of ${total}…`, completed, Math.max(1, total)),
      })
      : await (async () => {
        session = await provider.createSession(pair, {
          signal: abortController.signal,
          onDownloadProgress: (progress) =>
            showProgress(`Downloading language pack… ${Math.round(progress * 100)}%`, progress, 1),
        });
        abortController.signal.throwIfAborted();
        return translateVisualMirror(
          root,
          (source, signal) => translateCached(
            pair,
            session as TranslationSession,
            source,
            signal,
          ),
          {
            signal: abortController.signal,
            onProgress: (completed, total) =>
              showProgress(`Translating ${completed} of ${total}…`, completed, Math.max(1, total)),
          },
        );
      })();
    if (
      !captureCoordinator.isCurrent(generation) ||
      mirrorView.root !== root ||
      !state.isCurrentTranslationPair(pair) ||
      state.isLiveSourceOnlyMode
    ) return;
    if (usesReplicaTranslationProjection()) {
      const replicaResult = result as ReplicaTranslationRunResult;
      state.translationComplete =
        replicaResult.total > 0 &&
        replicaTranslationCoordinator.isResultCurrent(replicaResult) &&
        isCompleteReplicaTranslationResult(replicaResult);
      setStatus(
        state.translationComplete
          ? automatic
            ? 'Automatic translation is complete and live updates will translate as they arrive.'
            : 'Translation is complete and live updates will translate as they arrive.'
          : describePartialReplicaTranslation(
            replicaResult,
            'Translation remains partial',
          ),
        state.translationComplete ? 'success' : 'warning',
      );
    } else {
      state.translationComplete = result.failed === 0;
      setStatus(
        result.failed
          ? `${result.failed} text segment(s) could not be translated; the original remains for those parts.`
          : automatic
            ? 'Automatic translation is complete and live updates will translate as they arrive.'
            : 'Translation is complete and live updates will translate as they arrive.',
        result.failed ? 'warning' : 'success',
      );
    }
  } catch (error) {
    if (isAbortError(error) || abortController.signal.aborted) {
      if (
        !state.isLiveSourceOnlyMode &&
        captureCoordinator.isCurrent(generation) &&
        mirrorView.root === root &&
        state.isCurrentTranslationPair(pair)
      ) {
        setStatus('Translation cancelled. Existing translated text was kept.', 'warning');
      }
    } else if (!state.isLiveSourceOnlyMode) {
      setStatus(readableError(error), 'error');
    }
  } finally {
    session?.destroy();
    logTranslationCache('page', translationMemory);
    if (state.activeAbortController === abortController) state.activeAbortController = undefined;
    state.translationInFlight = false;
    configureImageTranslation();
    hideProgress();
    updateControls();
  }
}

function describePartialReplicaTranslation(
  result: ReplicaTranslationRunResult,
  prefix: string,
): string {
  const details: string[] = [];
  if (result.failed > 0) details.push(`${result.failed} failed`);
  if (result.stale > 0) details.push(`${result.stale} became stale`);
  if (result.skipped > 0) details.push(`${result.skipped} were superseded`);
  if (result.overflow > 0) {
    details.push(`${result.overflow} exceeded the bounded local queue`);
  }
  if (result.completed < result.total && details.length === 0) {
    details.push(`${result.total - result.completed} were not projected`);
  }
  return `${prefix}: ${details.join(', ') || 'no current text was projected'}. Original text remains for those segments; choose Translate page to retry.`;
}

async function translateCached(
  pair: TranslationPair,
  session: TranslationSession,
  source: string,
  signal?: AbortSignal,
): Promise<string> {
  return translateRemembered(
    pair,
    source,
    (core) => translateWithSession(session, core, signal),
  );
}

async function translateRemembered(
  pair: TranslationPair,
  source: string,
  load: (core: string) => Promise<string>,
): Promise<string> {
  const boundary = splitBoundaryWhitespace(source);
  if (!boundary.core) return source;
  const translated = await translationMemory.getOrCreate(
    {
      provider: 'chrome-translator-v1',
      pair,
    },
    boundary.core,
    () => load(boundary.core),
  );
  return `${boundary.leading}${translated.trim()}${boundary.trailing}`;
}

function initializeLiveSequenceBaseline(generation: number, sequence: number): void {
  if (!captureCoordinator.isCurrent(generation)) return;
  state.latestLiveSequence = sequence;
  state.highestReceivedLiveSequence = sequence;
  state.liveSequenceBaselineReady = true;
  if (!state.pendingLiveUpdate || state.pendingLiveUpdate.generation !== generation) return;
  if (state.pendingLiveUpdate.sequence <= sequence) {
    state.pendingLiveUpdate = undefined;
    return;
  }
  if (state.pendingLiveUpdate.firstSequence > sequence + 1) {
    state.pendingLiveUpdate = undefined;
    const identity = state.followedOrCapturedIdentity;
    if (identity) queueCapture({ identity, reason: 'desynchronized' });
    return;
  }
  state.highestReceivedLiveSequence = state.pendingLiveUpdate.sequence;
}

function queueLiveUpdate(message: LivePageDirtyMessage): void {
  if (message.sequence <= state.latestLiveSequence) return;
  if (legacyTransitionGate.markDirty()) return;
  if (
    state.liveSequenceBaselineReady &&
    state.highestReceivedLiveSequence > 0 &&
    message.sequence > state.highestReceivedLiveSequence + 1
  ) {
    releaseReplicaPresentationForLegacyWork();
    const identity = state.followedOrCapturedIdentity;
    if (identity) {
      setStatus('A live update was missed. Rebuilding once while keeping the current mirror visible…', 'warning');
      queueCapture({ identity, reason: 'desynchronized' });
    }
    return;
  }
  if (message.sequence <= state.highestReceivedLiveSequence) return;
  state.highestReceivedLiveSequence = message.sequence;
  if (!state.pendingLiveUpdate || state.pendingLiveUpdate.generation !== message.generation) {
    state.pendingLiveUpdate = {
      generation: message.generation,
      firstSequence: message.sequence,
      sequence: message.sequence,
      nodeIds: new Set(message.nodeIds),
    };
  } else {
    state.pendingLiveUpdate.sequence = Math.max(state.pendingLiveUpdate.sequence, message.sequence);
    for (const nodeId of message.nodeIds) state.pendingLiveUpdate.nodeIds.add(nodeId);
  }
  releaseReplicaPresentationForLegacyWork();
  void processPendingLiveUpdate();
}

async function processPendingLiveUpdate(): Promise<void> {
  if (
    state.liveDeltaInFlight ||
    state.captureInFlight ||
    state.translationInFlight ||
    !state.pendingLiveUpdate ||
    !state.capturedPageIdentity ||
    !mirrorView.root ||
    legacyTransitionGate.shadowOwnsPage
  ) return;
  const update = state.pendingLiveUpdate;
  state.pendingLiveUpdate = undefined;
  const requestedNodeIds = [...update.nodeIds];
  const nodeIds = requestedNodeIds.slice(0, 48);
  if (requestedNodeIds.length > nodeIds.length) {
    state.pendingLiveUpdate = {
      generation: update.generation,
      firstSequence: update.firstSequence,
      sequence: update.sequence,
      nodeIds: new Set(requestedNodeIds.slice(48)),
    };
  }
  if (!captureCoordinator.isCurrent(update.generation)) return;
  const identity = state.capturedPageIdentity;
  const beforeRoot = mirrorView.root;
  const abortController = new AbortController();
  const activeUpdate: PendingLiveUpdate = {
    generation: update.generation,
    firstSequence: update.firstSequence,
    sequence: update.sequence,
    nodeIds: new Set(nodeIds),
  };
  state.activeLiveUpdate = activeUpdate;
  state.liveDeltaAbortController = abortController;
  state.liveDeltaInFlight = true;
  updateControls();
  let session: TranslationSession | undefined;
  try {
    const results = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: captureLivePageDelta,
        args: [liveSessionId, update.generation, update.sequence, nodeIds],
      }),
    );
    const delta = parseLivePageDelta(results[0]?.result);
    if (
      !captureCoordinator.isCurrent(delta.generation) ||
      delta.sequence < state.latestLiveSequence ||
      normalizedPageUrl(delta.url) !== normalizedPageUrl(identity.url)
    ) return;
    if (delta.desynchronized) {
      queueCapture({ identity: state.capturedPageIdentity, reason: 'desynchronized' });
      return;
    }
    const pairBeforeRefresh = state.selectedPair();
    let pairChanged = false;
    const visibleLanguageText = liveDeltaLanguageSample(delta);
    if (state.preferences.sourceLanguage === 'auto') {
      const resolutionCommitted = await resolveSelectedSourceLanguage({
        documentLanguage: delta.documentLanguage,
        visibleText: visibleLanguageText,
        preserveOnUnknown: true,
      });
      if (
        !resolutionCommitted ||
        abortController.signal.aborted ||
        mirrorView.root !== beforeRoot ||
        !captureCoordinator.isCurrent(delta.generation)
      ) return;
      const refreshedPair = state.selectedPair();
      pairChanged = !sameTranslationPair(pairBeforeRefresh, refreshedPair);
      if (pairChanged) {
        state.availabilityCheckedForPair = undefined;
        state.translationComplete = false;
        quickComposer.invalidate();
        resetVisualMirrorText(beforeRoot);
      }
      await checkAvailability(delta.generation);
      if (
        abortController.signal.aborted ||
        mirrorView.root !== beforeRoot ||
        !captureCoordinator.isCurrent(delta.generation) ||
        (refreshedPair && !state.isCurrentTranslationPair(refreshedPair))
      ) return;
    }

    const pair = state.selectedPair();
    const wantsTranslation =
      !state.isLiveSourceOnlyMode &&
      (state.translationDesired || isAutoTranslationEnabled(state.preferences, identity.url));
    const shouldTranslate = Boolean(
      pair &&
      pair.sourceLanguage !== pair.targetLanguage &&
      wantsTranslation &&
      !pairChanged &&
      state.availability === 'available',
    );
    if (shouldTranslate && pair) {
      session = await provider.createSession(pair, { signal: abortController.signal });
    }
    const applied = await applyLivePageDelta(beforeRoot, delta, {
      textLayoutMode: state.preferences.textLayoutMode,
      signal: abortController.signal,
      ...(shouldTranslate && pair && session
        ? {
            translate: (source: string, signal?: AbortSignal) =>
              translateCached(pair, session as TranslationSession, source, signal),
          }
        : {}),
    });
    if (
      abortController.signal.aborted ||
      mirrorView.root !== beforeRoot ||
      !captureCoordinator.isCurrent(delta.generation) ||
      (pair && !state.isCurrentTranslationPair(pair))
    ) return;
    mirrorView.replaceRoot(applied.root, delta.documentWidth, delta.documentHeight);
    state.latestLiveSequence = delta.sequence;
    if (state.activeLiveUpdate === activeUpdate) state.activeLiveUpdate = undefined;
    mirrorView.updateLayout();
    if (applied.missingTarget) {
      queueCapture({ identity, reason: 'desynchronized' });
      return;
    }
    if (applied.translation.failed > 0) {
      state.translationComplete = false;
      setStatus(
        `${applied.translation.failed} changed text segment(s) could not be translated; their original text remains.`,
        'warning',
      );
      return;
    }

    let translationStatusWasHandled = shouldTranslate;
    if (shouldTranslate && applied.applied > 0) {
      setStatus('Live page changes were mirrored and translated.', 'success');
    }
    if (currentTranslationFieldCount() > 0) {
      const currentPair = state.selectedPair();
      const pairKey = currentPair
        ? availabilityPairKey(currentPair, update.generation)
        : undefined;
      if (!currentPair || state.availabilityCheckedForPair !== pairKey) {
        await checkAvailability(update.generation);
      }
      if ((!shouldTranslate || pairChanged) && wantsTranslation) {
        translationStatusWasHandled = true;
        await maybeTranslateAutomatically(update.generation, identity.url);
      }
    }
    if (applied.applied > 0 && !translationStatusWasHandled) {
      setStatus(
        'Live page changes were mirrored.',
        'success',
      );
    }
  } catch (error) {
    if (!abortController.signal.aborted && state.capturedPageIdentity) {
      setStatus(`A live update could not be applied: ${readableError(error)}`, 'warning');
      queueCapture({ identity: state.capturedPageIdentity, reason: 'desynchronized' });
    }
  } finally {
    session?.destroy();
    if (state.liveDeltaAbortController === abortController) {
      state.liveDeltaAbortController = undefined;
    }
    if (state.activeLiveUpdate === activeUpdate) state.activeLiveUpdate = undefined;
    state.liveDeltaInFlight = false;
    updateControls();
    void processPendingLiveUpdate();
  }
}

function liveDeltaLanguageSample(delta: LivePageDelta): string {
  const parts: string[] = [];
  let characters = 0;
  const append = (value: string | undefined): void => {
    if (!value || characters >= 20_000) return;
    const remaining = 20_000 - characters;
    const text = value.replace(/\s+/gu, ' ').trim().slice(0, remaining);
    if (!text) return;
    parts.push(text);
    characters += text.length + 1;
  };
  const visit = (node: LiveVisualNode): void => {
    if (characters >= 20_000) return;
    if (node.kind === 'text') {
      append(node.text);
      return;
    }
    if (node.kind === 'placeholder') return;
    append(node.attributes?.alt);
    for (const child of node.children) visit(child);
  };
  for (const replacement of delta.replacements) {
    if (replacement.node) visit(replacement.node);
  }
  return parts.join(' ');
}

function setCompanionOverlay(next?: CompanionOverlay): void {
  const previous = state.openCompanionOverlay;
  state.openCompanionOverlay = next;
  const settingsOpen = next === 'settings';
  const quickTranslateOpen = next === 'quick-translate';
  controlsOverlay.hidden = !settingsOpen;
  quickTranslatorOverlay.hidden = !quickTranslateOpen;
  toggleSettingsButton.setAttribute('aria-expanded', String(settingsOpen));
  toggleQuickTranslateButton.setAttribute(
    'aria-expanded',
    String(quickTranslateOpen),
  );
  renderToolbarAttention();
  if (settingsOpen) {
    closeSettingsButton.focus();
    return;
  }
  if (quickTranslateOpen) {
    quickComposer.syncPanel();
    quickComposer.focusInput();
    return;
  }
  if (previous === 'settings') toggleSettingsButton.focus();
  if (previous === 'quick-translate') toggleQuickTranslateButton.focus();
}

function populateLanguageOptions(): void {
  const auto = createLanguageOption('auto', 'Auto-detect');
  uiLocalizer.setText(auto, 'Auto-detect');
  sourceSelect.replaceChildren(auto);
  targetSelect.replaceChildren();
  for (const language of LANGUAGE_OPTION_ORDER) {
    const source = createLanguageOption(language, languageName(language));
    const target = createLanguageOption(language, languageEndonym(language));
    source.dataset.languageCode = language;
    target.dataset.languageCode = language;
    source.lang = 'en';
    source.dir = 'auto';
    target.lang = language;
    target.dir = 'auto';
    sourceSelect.append(source);
    targetSelect.append(target);
  }
}

function createLanguageOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function observeReplicaStateLabel(): void {
  const knownLabels = new Set([
    STATIC_REPLAY_LABEL,
    LIVE_REPLAY_LABEL,
    LEGACY_FALLBACK_LABEL,
  ]);
  new MutationObserver(() => {
    const english = replicaModeBadge.textContent?.trim() ?? '';
    if (!english) {
      delete replicaModeBadge.dataset.uiLabel;
      return;
    }
    if (!knownLabels.has(english)) return;
    uiLocalizer.setText(replicaModeBadge, english);
  }).observe(replicaModeBadge, { childList: true, characterData: true });
}

let zoomCommitTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Applies zoom immediately and saves it once the slider settles. Saving on
 * every input tick sent one storage write per tick, each of which fanned a
 * storage change to every companion view and rebuilt the settings controls.
 */
function setZoom(value: number): void {
  const zoomPercent = clampZoomPercent(value);
  state.preferences = withViewSettings(state.preferences, {
    displayMode: 'custom',
    zoomPercent,
  });
  zoomInput.value = String(zoomPercent);
  zoomOutput.value = `${zoomPercent}%`;
  displayModeSelect.value = 'custom';
  mirrorView.updateLayout();
  if (zoomCommitTimer !== undefined) clearTimeout(zoomCommitTimer);
  zoomCommitTimer = setTimeout(() => {
    zoomCommitTimer = undefined;
    void commitViewPreferencePatch({
      displayMode: 'custom',
      zoomPercent: state.preferences.zoomPercent,
    });
  }, ZOOM_COMMIT_DEBOUNCE_MS);
}

async function changePopoutTabMode(popoutTabMode: PopoutTabMode): Promise<void> {
  const saved = await commitViewPreferencePatch({ popoutTabMode });
  if (!saved || state.preferences.popoutTabMode !== popoutTabMode) return;
  if (isDetachedWindow && popoutTabMode === 'active') {
    await sourceFollower.followCurrentActiveSourceTab();
  }
}

async function changeReplicaFidelityPolicy(
  replicaFidelityPolicy: SelectableReplicaFidelityPolicy,
): Promise<void> {
  if (
    state.replicaFidelityCommitInFlight ||
    replicaFidelityPolicy === state.preferences.replicaFidelityPolicy
  ) return;
  state.replicaFidelityCommitInFlight = true;
  updateControls();
  try {
    const saved = await commitViewPreferencePatch({ replicaFidelityPolicy });
    if (!saved || state.preferences.replicaFidelityPolicy !== replicaFidelityPolicy) return;
    liveReplicaFailureRecoveryGate.reset();
    const identity = state.followedOrCapturedIdentity;
    if (identity) queueCapture({ identity, reason: 'preference' });
  } finally {
    state.replicaFidelityCommitInFlight = false;
    updateControls();
  }
}

async function changeReplicaViewMode(
  replicaViewMode: ReplicaViewMode,
): Promise<void> {
  if (replicaViewMode === state.preferences.replicaViewMode) return;
  const previousMode = state.preferences.replicaViewMode;
  // commitViewPreferencePatch applies the validated preference optimistically
  // before its first await, so projection gates close immediately.
  const save = commitViewPreferencePatch({ replicaViewMode });
  applyReplicaViewMode(previousMode, false);
  await save;
  if (state.preferences.replicaViewMode !== replicaViewMode) {
    applyReplicaViewMode(replicaViewMode);
    return;
  }
  if (replicaViewMode === 'translated' && !state.isLiveSourceOnlyMode) {
    await resumeTranslatedReplicaMode();
  }
}

function applyReplicaViewMode(
  previousMode: ReplicaViewMode,
  resumeTranslated = true,
): void {
  if (previousMode === state.preferences.replicaViewMode) return;
  currency.supersede('availability');
  state.activeAbortController?.abort();
  abortAndRequeueLiveDelta();
  replicaTranslationCoordinator.selectPair(undefined);
  mirrorView.resetTextIfPresent();
  state.translationComplete = false;
  state.availabilityCheckedForPair = undefined;
  configureImageTranslation();
  if (state.isLiveSourceOnlyMode) {
    state.availability = 'unavailable';
    setStatus(
      'Live source only is active. The current mirror remains live and all translation overlays were removed.',
      'success',
    );
  } else {
    setStatus('Translated mode restored. Preparing the saved language settings…');
    if (resumeTranslated) void resumeTranslatedReplicaMode();
  }
  updateControls();
}

async function resumeTranslatedReplicaMode(): Promise<void> {
  const interrupted = state.activeTranslationTask;
  if (interrupted) await interrupted.catch(() => undefined);
  const identity = state.capturedPageIdentity;
  const generation = captureCoordinator.generation;
  if (state.isLiveSourceOnlyMode || !state.snapshot || !identity) return;
  const resolved = await resolveSelectedSourceLanguage(
    currentReplicaLanguageContext(),
  );
  const requestedSnapshot = state.snapshot;
  if (
    !resolved ||
    state.isLiveSourceOnlyMode ||
    !requestedSnapshot ||
    state.snapshot !== requestedSnapshot ||
    state.capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  const pair = state.selectedPair();
  replicaTranslationCoordinator.selectPair(pair);
  await checkAvailability(generation);
  if (
    state.isLiveSourceOnlyMode ||
    !pair ||
    !state.isCurrentTranslationPair(pair) ||
    state.snapshot !== requestedSnapshot ||
    state.capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  await maybeTranslateAutomatically(generation, identity.url);
}

function currentReplicaLanguageContext(): LiveLanguageContext | undefined {
  const current = replicaSurfaceRouter.snapshot();
  if (!current) return undefined;
  return {
    ...(current.documentLanguage
      ? { documentLanguage: current.documentLanguage }
      : {}),
    visibleText: buildBoundedLanguageSample(
      replicaRecordSources(current.records),
    ),
    preserveOnUnknown: true,
  };
}

function abortAndRequeueLiveDelta(): void {
  const interrupted = state.activeLiveUpdate;
  if (
    interrupted &&
    interrupted.sequence > state.latestLiveSequence &&
    captureCoordinator.isCurrent(interrupted.generation)
  ) {
    const merged = mergeLiveUpdateBatches(state.pendingLiveUpdate, interrupted);
    state.pendingLiveUpdate = {
      ...merged,
      nodeIds: new Set(merged.nodeIds),
    };
  }
  state.liveDeltaAbortController?.abort();
}

function syncPreferenceControls(): void {
  const pageUrl = state.pageUrl;
  sourceSelect.value = state.preferences.sourceLanguage;
  targetSelect.value = state.preferences.targetLanguage;
  autoTranslateSelect.value = autoTranslationModeForPage(state.preferences, pageUrl);
  displayModeSelect.value = state.preferences.displayMode;
  textLayoutSelect.value = state.preferences.textLayoutMode;
  replicaFidelityPolicySelect.value = state.preferences.replicaFidelityPolicy;
  replicaViewModeSelect.value = state.preferences.replicaViewMode;
  launchBehaviorSelect.value = state.preferences.launchBehavior;
  popoutTabModeSelect.value = state.preferences.popoutTabMode;
  syncScrollInput.checked = state.preferences.syncScroll;
  zoomInput.value = String(state.preferences.zoomPercent);
  zoomOutput.value = `${state.preferences.zoomPercent}%`;
  zoomInput.disabled = state.preferences.displayMode !== 'custom';
  syncToolbarPreferenceControls();
  quickComposer.syncPanel();
  imageAnalysisPanel.render();
  configureImageTranslation();
  uiLocalizer.schedule();
}

function syncToolbarPreferenceControls(): void {
  const autoDetect = state.preferences.sourceLanguage === 'auto';
  toolbarAutoDetectButton.setAttribute('aria-pressed', String(autoDetect));
  toolbarAutoDetectButton.setAttribute(
    'aria-label',
    autoDetect
      ? 'From language is using Auto-detect'
      : 'Set From language to Auto-detect',
  );
  toolbarAutoDetectButton.title = autoDetect
    ? 'From language is using Auto-detect.'
    : 'Set From language to Auto-detect.';

  const sizeLabel = state.preferences.displayMode === 'fit'
    ? 'Fit'
    : state.preferences.displayMode === 'actual'
      ? '1:1'
      : `${state.preferences.zoomPercent}%`;
  if (state.preferences.displayMode === 'custom') {
    delete toolbarSizeLabel.dataset.uiLabel;
    toolbarSizeLabel.textContent = sizeLabel;
  } else {
    uiLocalizer.setText(toolbarSizeLabel, sizeLabel);
  }
  const nextSize = state.preferences.displayMode === 'fit' ? '1:1 size' : 'fit width';
  toolbarSizeToggleButton.setAttribute(
    'aria-label',
    `Mirror size: ${sizeLabel}. Switch to ${nextSize}`,
  );
  toolbarSizeToggleButton.title = `Mirror size: ${sizeLabel}. Click for ${nextSize}.`;

  toolbarOcrToggleButton.setAttribute(
    'aria-pressed',
    String(state.preferences.imageTranslationEnabled),
  );
  uiLocalizer.setText(
    toolbarOcrLabel,
    state.preferences.imageTranslationEnabled ? 'OCR On' : 'OCR Off',
  );
  toolbarOcrToggleButton.title = state.preferences.imageTranslationEnabled
    ? state.imageCaptureAccess === 'granted'
      ? 'Image text translation is on. Click to turn it off.'
      : 'Image text translation is saved but needs image access. Click to grant access.'
    : 'Image text translation is off. Click to turn it on.';

  const followsActive = isDetachedWindow && state.preferences.popoutTabMode === 'active';
  uiLocalizer.setText(toolbarTabFollowLabel, followsActive ? 'Active' : 'Current');
  toolbarTabFollowButton.setAttribute('aria-pressed', String(followsActive));
  toolbarTabFollowButton.setAttribute(
    'aria-label',
    isDetachedWindow
      ? followsActive
        ? 'Follow the opening tab instead of the active browser tab'
        : 'Follow the active browser tab instead of the opening tab'
      : 'Tab following is fixed to the current side-panel tab',
  );
  toolbarTabFollowButton.title = isDetachedWindow
    ? followsActive
      ? 'Following the active browser tab. Click to stay on the opening tab.'
      : 'Staying on the opening tab. Click to follow the active browser tab.'
    : 'The side panel is attached to the current tab. Active-tab following is available in a detached window.';
}

function configureImageTranslation(): void {
  imageTranslationController.configure({
    enabled:
      state.preferences.imageTranslationEnabled &&
      state.imageCaptureAccess === 'granted' &&
      !state.isLiveSourceOnlyMode &&
      hasCompiledImageAnalysisCapability(),
    scanPolicy: state.preferences.imageScanPolicy,
    skipSmallImages: state.preferences.skipSmallImages,
    providerOrder: effectiveCompiledProviderOrder(
      state.preferences.imageTextProviderOrder,
    ),
    sourceLanguage: state.preferences.sourceLanguage,
    ...(state.resolvedSourceLanguage
      ? { detectedSourceLanguage: state.resolvedSourceLanguage }
      : {}),
    targetLanguage: state.preferences.targetLanguage,
    translationIdle: !state.translationInFlight,
  });
}

function configureSurfaceButton(): void {
  if (!isDetachedWindow) return;
  popoutButton.textContent = '↙';
  popoutButton.setAttribute('aria-label', 'Return companion to the side panel');
  popoutButton.title = 'Return to side panel';
}

async function openDetachedWindow(): Promise<void> {
  const identity = state.capturedOrFollowedIdentity;
  if (!identity) {
    setStatus('Open a regular page before detaching the companion.', 'warning');
    return;
  }
  try {
    const sourceWindow = await browser.windows.get(identity.windowId);
    const url = createDetachedCompanionUrl(
      browser.runtime.getURL('/sidepanel.html'),
      identity,
    );
    await browser.windows.create(createDetachedWindowData(url, sourceWindow));
    let preferenceSaveFailed = false;
    try {
      await rememberCompanionSurface('popout');
    } catch {
      preferenceSaveFailed = true;
    }
    const closed = await closeNativeSidePanel(identity.windowId);
    if (!closed || preferenceSaveFailed) {
      setStatus(
        !closed
          ? 'Detached window opened, but Chrome could not close the old side panel automatically. Close it manually.'
          : 'Detached window opened, but Chrome could not remember it as the last-used surface.',
        'warning',
      );
    }
  } catch (error) {
    setStatus(`Chrome could not open a detached window: ${readableError(error)}`, 'error');
  }
}

async function returnToSidePanel(): Promise<void> {
  const sourceWindowId =
    state.followedPageIdentity?.windowId ??
    state.detachedSourceWindowId ??
    detachedIdentityHint?.windowId;
  if (sourceWindowId === undefined) return;

  // Keep this call before the first await. Chrome requires sidePanel.open() to
  // remain directly associated with the user's button gesture.
  const openPromise = browser.sidePanel.open({ windowId: sourceWindowId });
  const activeTabPromise = browser.tabs.query({
    active: true,
    windowId: sourceWindowId,
  });
  try {
    const [, [tab]] = await Promise.all([openPromise, activeTabPromise]);
    try {
      await rememberCompanionSurface('side-panel');
    } catch {
      // A successfully opened side panel remains authoritative even if the
      // optional last-used preference could not be persisted.
    }
    if (tab?.id !== undefined && isSupportedPage(tab.url)) {
      await browser.runtime.sendMessage({
        type: 'simul:authorized-tab',
        tabId: tab.id,
        windowId: sourceWindowId,
        url: tab.url,
      }).catch((error: unknown) => {
        if (!/receiving end does not exist|could not establish connection/iu.test(
          readableError(error),
        )) throw error;
      });
    }
    if (state.panelWindowId !== undefined) {
      await browser.windows.remove(state.panelWindowId);
    } else {
      window.close();
    }
  } catch (error) {
    setStatus(`Chrome could not return to the side panel: ${readableError(error)}`, 'error');
  }
}

async function rememberCompanionSurface(
  surface: CompanionSurface,
): Promise<void> {
  await commitViewPreferencePatch({ lastLaunchSurface: surface });
}

async function closeNativeSidePanel(windowId: number): Promise<boolean> {
  if (typeof browser.sidePanel.close === 'function') {
    try {
      await browser.sidePanel.close({ windowId });
      return true;
    } catch {
      // Fall through to the pre-close API teardown below.
    }
  }
  try {
    await browser.sidePanel.setOptions({ enabled: false });
    await browser.sidePanel.setOptions({ enabled: true });
    return true;
  } catch {
    return false;
  }
}

async function checkPanelPlacement(): Promise<void> {
  if (detachedIdentityHint) return;
  const sidePanel = browser.sidePanel as typeof browser.sidePanel & {
    getLayout?: () => Promise<{ side: string }>;
  };
  if (typeof sidePanel.getLayout !== 'function') return;
  try {
    const layout = await sidePanel.getLayout();
    placementGuidance.hidden = layout.side !== 'left';
  } catch {
    // Chrome 138 does not expose placement inspection in every channel.
  }
}

function withCaptureTimeout<T>(operation: Promise<T>): Promise<T> {
  return withPageTimeout(operation, CAPTURE_TIMEOUT_MS);
}

function invalidateCompanion(message: string): void {
  releaseLiveSession(state.capturedOrFollowedIdentity);
  captureCoordinator.invalidate();
  currency.supersedePage();
  state.abortPageWork();
  imageTranslationController.releaseReplica();
  replicaEngineController.releasePresentation(false);
  quickComposer.invalidate();
  replicaTranslationCoordinator.selectPair(undefined);
  state.clearPage();
  legacyTransitionGate.reset();
  liveReplicaFailureRecoveryGate.reset();
  visibleReplayHost.resetSourceScroll();
  mirrorView.disconnect();
  mirrorView.renderError(message);
  setStatus(message, 'warning');
  updateControls();
}

function usesReplicaTranslationProjection(): boolean {
  return (
    legacyTransitionGate.shadowOwnsPage &&
    visibleReplayHost.hasCommittedReplica
  );
}

function releaseReplicaPresentationForLegacyWork(
  force = false,
  showFallbackLabel = true,
): boolean {
  if (!force && usesReplicaTranslationProjection()) return false;
  if (!legacyTransitionGate.shadowOwnsPage) return false;
  const needsFreshCapture = legacyTransitionGate.release();
  state.pendingLiveUpdate = undefined;
  state.replicaShadowAbortController?.abort();
  imageTranslationController.releaseReplica();
  replicaEngineController.releasePresentation(showFallbackLabel);
  return needsFreshCapture;
}

function releaseLiveSession(
  identity: CapturedPageIdentity | undefined = state.capturedOrFollowedIdentity,
): void {
  if (!identity) return;
  void browser.scripting.executeScript({
    target: { tabId: identity.tabId, frameIds: [0] },
    func: invokeLivePageObserverUnregisterBridge,
    args: [liveSessionId],
  }).catch(() => undefined);
}

function isMessageFromFollowedTab(
  tab: Browser.tabs.Tab | undefined,
  sessionId: string,
  generation: number,
  url: string,
): boolean {
  const followed = state.followedOrCapturedIdentity;
  return Boolean(
    sessionId === liveSessionId &&
      followed &&
      tab?.id === followed.tabId &&
      tab.windowId === followed.windowId &&
      captureCoordinator.isCurrent(generation) &&
      normalizedPageUrl(url) === normalizedPageUrl(followed.url),
  );
}

function isCurrentAvailabilityRequest(
  request: CurrencyToken,
  requestedSnapshot: PageSnapshot,
  pair: TranslationPair,
  generation: number,
): boolean {
  const currentPair = state.selectedPair();
  return isAvailabilityRequestCurrent({
    replicaViewMode: state.preferences.replicaViewMode,
    requestMatches: currency.isCurrent(request),
    generationMatches: captureCoordinator.isCurrent(generation),
    snapshotMatches: state.snapshot === requestedSnapshot,
    pairMatches: Boolean(
      currentPair &&
        currentPair.sourceLanguage === pair.sourceLanguage &&
        currentPair.targetLanguage === pair.targetLanguage,
    ),
  });
}

function readLanguage(value: string): SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
    ? (value as SupportedLanguage)
    : 'en';
}

function showCaptureNotes(page: PageSnapshot): void {
  const details: string[] = [];
  if (page.omissions.controls) details.push('private form contents');
  if (page.omissions.frames) details.push('embedded frame contents');
  if (page.omissions.hidden) details.push('hidden content');
  if (page.omissions.unsafeImages) details.push('unsupported image sources');
  if (page.omissions.truncated) details.push('content beyond the bounded mirror limit');
  if (!state.liveObservationAvailable) {
    details.push('live updates because too many companion views are open');
  }
  captureNotes.textContent = details.length > 0 ? `Safely omitted: ${details.join(', ')}.` : '';
  captureNotes.hidden = details.length === 0;
}

function updateControls(): void {
  syncToolbarPreferenceControls();
  quickComposer.syncPanel();
  const busy = state.captureInFlight || state.translationInFlight || state.permissionInFlight || quickComposer.inFlight;
  sourceSelect.disabled = busy;
  targetSelect.disabled = busy;
  swapButton.disabled = busy || !state.resolvedSourceLanguage;
  autoTranslateSelect.disabled = busy;
  displayModeSelect.disabled = busy;
  textLayoutSelect.disabled = busy;
  replicaFidelityPolicySelect.disabled = busy || state.replicaFidelityCommitInFlight;
  launchBehaviorSelect.disabled = busy;
  popoutTabModeSelect.disabled = busy;
  syncScrollInput.disabled = busy || !state.liveObservationAvailable;
  zoomInButton.disabled = busy;
  zoomOutButton.disabled = busy;
  refreshButton.disabled = state.captureInFlight;
  compactRefreshButton.disabled = state.captureInFlight;
  toolbarAutoDetectButton.disabled = busy;
  toolbarSizeToggleButton.disabled = busy;
  toolbarOcrToggleButton.disabled = busy ||
    state.imageCaptureAccess === 'checking' ||
    !hasCompiledImageAnalysisCapability();
  toolbarTabFollowButton.disabled = busy || !isDetachedWindow;
  popoutButton.disabled = state.surfaceTransitionInFlight ||
    (!isDetachedWindow && !state.capturedPageIdentity);
  cancelButton.hidden =
    !state.translationInFlight && !quickComposer.inFlight && !state.imageTranslationInFlight;
  cancelButton.disabled =
    !state.translationInFlight && !quickComposer.inFlight && !state.imageTranslationInFlight;
  translateComposerButton.disabled = busy || !composerInput.value.trim() || !state.selectedPair();
  uiLocalizer.setText(
    translateComposerButton,
    quickComposer.inFlight ? 'Translating…' : 'Translate',
  );
  translateButton.disabled =
    busy ||
    state.isLiveSourceOnlyMode ||
    !state.snapshot ||
    !mirrorView.root ||
    !state.selectedPair() ||
    state.availability === 'unavailable' ||
    state.translationComplete;
  uiLocalizer.setText(
    translateButton,
    state.translationComplete ? 'Translation current' : 'Translate page',
  );
  renderToolbarAttention();
  syncToolbarProgress();
}

function setImageTranslationBusy(busy: boolean): void {
  const completed = state.imageTranslationInFlight && !busy;
  state.imageTranslationInFlight = busy;
  if (busy && !state.translationInFlight && !quickComposer.inFlight) {
    toolbarStatus.showImageProgress();
  } else if (!busy && !state.translationInFlight && !quickComposer.inFlight) {
    hideProgress();
  }
  if (completed) {
    logTranslationCache('image-text', imageTranslationMemory);
    if (toolbarStatus.statusText === 'Cancelling on-device translation…') {
      setStatus('Image text processing stopped.', 'warning');
    }
  }
  updateControls();
}

composerInput.addEventListener('input', () => {
  quickComposer.invalidate();
  updateControls();
});

function syncToolbarProgress(): void {
  toolbarStatus.syncProgress();
}

function showProgress(label: string, value: number, max: number): void {
  toolbarStatus.showProgress(label, value, max);
}

function hideProgress(): void {
  toolbarStatus.hideProgress();
}

function setStatus(message: string, tone: CompanionStatusTone = 'normal'): void {
  toolbarStatus.setStatus(message, tone);
}

function renderToolbarAttention(): void {
  toolbarStatus.renderAttention();
}

function logImageTranslationDiagnostic(
  diagnostic: ImageTranslationDiagnostic,
): void {
  // Content-free local diagnostics only; image text, URLs, and pixels are
  // deliberately absent from this channel.
  console.info('[Simul image translation]', diagnostic);
  imageAnalysisPanel.recordDiagnostic(diagnostic);
}

function logTranslationCache(
  label: 'page' | 'image-text' | 'quick',
  memory: TranslationMemory,
): void {
  const stats = memory.snapshotStats();
  console.info(
    `[Simul translation cache] scope=${label}; entries=${stats.entries}; characters=${stats.characters}; hits=${stats.hits}; misses=${stats.misses}; joins=${stats.inFlightJoins}; provider-loads=${stats.providerLoads}`,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing companion element: ${selector}`);
  return element;
}

