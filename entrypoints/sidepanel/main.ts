import { ChromeTranslatorProvider } from '../../lib/chrome-translator';
import {
  createExtensionBuildIdentity,
  renderExtensionBuildIdentity,
} from '../../lib/build-identity';
import {
  startBestEffortBackgroundTasks,
} from '../../lib/browser-scheduling';
import {
  LatestWorkCoordinator,
} from '../../lib/companion-lifecycle';
import {
  nextCompanionOverlay,
  type CompanionOverlay,
} from '../../lib/companion-ui-state';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { CapturePipeline } from './capture-pipeline';
import {
  CompanionState,
  type CaptureRequest,
} from './companion-state';
import { Currency, type CurrencyToken } from './currency';
import { ImageAnalysisPanel } from './image-analysis-panel';
import { PermissionFlows } from './permission-flows';
import { PreferenceClient } from './preference-client';
import { QuickComposer } from './quick-composer';
import { ReadScopeController } from './read-scope-controller';
import { SourceFollower } from './source-follower';
import { ToolbarStatus } from './toolbar-status';
import {
  TranslationDriver,
  describePartialReplicaTranslation,
  type PendingAutoImageLanguageEvidence,
} from './translation-driver';
import { UiLocalizer } from './ui-localizer';
import { isQuickTranslationShortcut } from '../../lib/quick-translation-shortcut';
import {
  AutoLanguageEvidencePrecedence,
  autoImageLanguageConfigurationKey,
  shouldClearAutoImageLanguageForDocument,
  shouldClearAutoImageLanguageResolution,
} from '../../lib/language-detection';
import {
  LANGUAGE_OPTION_ORDER,
  languageEndonym,
} from '../../lib/language-options';
import {
  isSupportedPage,
  parseDetachedPageIdentityHint,
  readAuthorizedTabMessage,
  readPageError,
  readableError,
} from '../../lib/page-identity';
import { NavigationRefreshGate } from '../../lib/navigation-refresh-gate';
import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
} from '../../lib/companion-surface';
import {
  compiledImageAnalysisCapabilities,
  compiledImageTextProviderIds,
  effectiveCompiledProviderOrder,
  hasCompiledImageAnalysisCapability,
} from '../../lib/ocr/provider-registry';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  enabledOcrProviderOrder,
  type ImageReadingMethodId,
} from '../../lib/ocr/image-reading-methods';
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
import { readEnsureOcrHostResponse } from '../../lib/ocr/offscreen-protocol';
import {
  createProbeOcrProviderCommand,
  readProbeOcrProviderResponse,
  type OcrProviderRuntimeStatus,
} from '../../lib/ocr/provider-status-protocol';
import {
  runtimeReadyOcrProviderOrder,
  shouldRetryOcrProviderProbe,
} from '../../lib/ocr/runtime-provider-readiness';
import {
  STORAGE_KEY,
  autoTranslationModeForPage,
  isCompanionLaunchBehavior,
  isAutoTranslationMode,
  isMirrorDisplayMode,
  isPopoutTabMode,
  isReplicaViewMode,
  isTextLayoutMode,
  selectLiveCompanionPreferenceChange,
  type CompanionLaunchBehavior,
  type PopoutTabMode,
  type ReplicaViewMode,
} from '../../lib/preferences';
import { ViewPreferencePatchLedger } from '../../lib/view-preference-ledger';
import {
  PREFERENCE_SAFETY_PORT_NAME,
} from '../../lib/preference-safety-coordinator';
import { PreferenceSafetyClient } from '../../lib/preference-safety-client';
import type { ReplicaRunResult } from '../../lib/replica/contracts';
import { openChromeHtmlMirrorStream } from '../../lib/replica/html-mirror-client';
import {
  isSelectableReplicaFidelityPolicy,
  type SelectableReplicaFidelityPolicy,
} from '../../lib/replica/fidelity-policy';
import {
  IsolatedHtmlReplicaEngine,
  type IsolatedMirrorInfo,
} from '../../lib/replica/isolated-html-engine';
import {
  REPLICA_READ_SCOPE_SETUP_VERSION,
  replicaReadScopeFingerprint,
} from '../../lib/replica/read-scope-policy';
import {
  IsolatedReplicaFailureRecoveryGate,
} from '../../lib/replica/replica-recovery';
import { openChromeSemanticSource } from '../../lib/replica/semantic-source-client';
import {
  LIVE_REPLAY_LABEL,
  STATIC_REPLAY_LABEL,
  VisibleReplayHost,
} from '../../lib/replica/visible-replay-host';
import { ReplicaSurfaceRouter } from '../../lib/replica/replica-surface-router';
import {
  ReplicaTranslationCoordinator,
  isCompleteReplicaTranslationResult,
  splitBoundaryWhitespace,
} from '../../lib/translation/replica-translation-coordinator';
import { TranslationMemory } from '../../lib/translation/translation-memory';
import {
  SUPPORTED_LANGUAGES,
  languageName,
  type SupportedLanguage,
  type TranslationPair,
} from '../../lib/translation-provider';

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
  'Accessibility text can run without image access. Grant image access only to enable local pixel OCR fallbacks.',
  'Image translation is saved but pixel OCR needs image access. Click to grant access.',
  'Checking Chrome image access…',
  'Off by default. Visible image pixels stay on this device and are discarded after OCR.',
  'Grant image access',
  'Image reading priority',
  'Methods are attempted from top to bottom. Uncertain accessibility text may be compared with later OCR; the saved order breaks close ties.',
  'Minimum OCR confidence',
  'Higher values reduce false text detections but may miss faint or stylized text.',
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
const readScopeSetup = requireElement<HTMLDialogElement>('#read-scope-setup');
const setupReadProfile = requireElement<HTMLSelectElement>('#setup-read-profile');
const setupReadScopeControls = requireElement<HTMLElement>(
  '#setup-read-scope-controls',
);
const completeReadScopeSetupButton = requireElement<HTMLButtonElement>(
  '#complete-read-scope-setup',
);
const setupReadScopeStatus = requireElement<HTMLElement>(
  '#setup-read-scope-status',
);
const setupResetCleanup = requireElement<HTMLElement>('#setup-reset-cleanup');
const setupResetCleanupStatus = requireElement<HTMLElement>(
  '#setup-reset-cleanup-status',
);
const retrySetupResetCleanupButton = requireElement<HTMLButtonElement>(
  '#retry-setup-reset-cleanup',
);
const readScopeProfile = requireElement<HTMLSelectElement>('#read-scope-profile');
const readScopeControls = requireElement<HTMLElement>('#read-scope-controls');
const resetAllSettingsButton = requireElement<HTMLButtonElement>(
  '#reset-all-settings',
);
const resetSettingsDialog = requireElement<HTMLDialogElement>(
  '#reset-settings-dialog',
);
const resetSettingsStatus = requireElement<HTMLElement>('#reset-settings-status');
const statusElement = requireElement<HTMLElement>('#status');
const settingsAttention = requireElement<HTMLElement>('#settings-attention');
const detectedLanguageElement = requireElement<HTMLElement>('#detected-language');
const captureNotes = requireElement<HTMLElement>('#capture-notes');
const progressRegion = requireElement<HTMLElement>('#progress-region');
const progressLabel = requireElement<HTMLLabelElement>('#progress-label');
const progressElement = requireElement<HTMLProgressElement>('#progress');
const placementGuidance = requireElement<HTMLElement>('#placement-guidance');
const replicaStatusContainer = requireElement<HTMLElement>('#replica-status');
const replicaPreviewContainer = requireElement<HTMLElement>('#replica-preview');
const replicaModeBadge = requireElement<HTMLElement>('#replica-mode-badge');
const composerInput = requireElement<HTMLTextAreaElement>('#composer-input');
const composerCharacterCount = requireElement<HTMLOutputElement>(
  '#composer-character-count',
);
const composerOutput = requireElement<HTMLTextAreaElement>('#composer-output');
const translateComposerButton = requireElement<HTMLButtonElement>('#translate-composer');
const copyComposerButton = requireElement<HTMLButtonElement>('#copy-composer');
const composerFromLanguage = requireElement<HTMLElement>('#composer-from-language');
const composerToLanguage = requireElement<HTMLElement>('#composer-to-language');
const composerGuidance = requireElement<HTMLElement>('#composer-guidance');
const composerStatus = requireElement<HTMLElement>('#composer-status');

const detachedIdentityHint = parseDetachedPageIdentityHint(window.location.search);
const isDetachedWindow = detachedIdentityHint !== undefined;
const state = new CompanionState({
  isDetachedWindow,
  detachedSourceWindowId: detachedIdentityHint?.windowId,
});
const currency = new Currency();
const provider = new ChromeTranslatorProvider();
const captureCoordinator = new LatestWorkCoordinator<CaptureRequest>();
const viewPreferencePatchLedger = new ViewPreferencePatchLedger();
const mirrorSessionId = crypto.randomUUID();
const visibleReplayHost = new VisibleReplayHost({
  hostDocument: document,
  previewSurface: replicaPreviewContainer,
  badge: replicaModeBadge,
});
let replicaTranslationCoordinator!: ReplicaTranslationCoordinator;
let imageTranslationController!: ImageTranslationController;
const replicaSurfaceRouter = new ReplicaSurfaceRouter();
const isolatedHtmlReplicaEngine = new IsolatedHtmlReplicaEngine({
  presentationHost: visibleReplayHost,
  openStream: openChromeHtmlMirrorStream,
  getReplicaFidelityPolicy: () => state.preferences.replicaFidelityPolicy,
  openSemanticStream: openChromeSemanticSource,
  getReplicaReadScope: () => readScopeController.currentReplicaReadScope(),
  onLayoutChanged: () => imageTranslationController.refreshOverlays(),
  onSourceScroll: (scroll) => {
    state.lastSourceScroll = scroll;
    if (state.preferences.syncScroll) visibleReplayHost.followSourceScroll(scroll);
  },
  onSourceCommit: (commit) => capturePipeline.handleReplicaSourceCommit(commit),
  onLiveFailure: (code) => capturePipeline.handleReplicaLiveFailure(code),
  ...(import.meta.env.DEV
    ? {
        onInfo: (info: IsolatedMirrorInfo) => {
          // Counts and bounded stages only: never source text, URLs, pixels, IDs, or hashes.
          const event = info.eventRepresentability;
          console.info(
      `[Simul isolated mirror] stage=${info.stage}; code=${info.code ?? 'none'}; nodes=${info.nodeCount}; text=${info.textCount}; images=${info.imageCount}; shadow-roots=${info.openShadowRootCount}; adopted-styles=${info.adoptedStyleCount}; hidden-labels=${info.visuallyHiddenCount}; selected-image-sources=${info.selectedImageSourceCount}; stylesheet-links=${info.stylesheetLinkCount}; stylesheet-loaded=${info.stylesheetLoadedCount}; stylesheet-errors=${info.stylesheetErrorCount}; stylesheet-timeouts=${info.stylesheetTimedOutCount}; operations=${info.operationCount}; text-ops=${info.textOperationCount}; attribute-ops=${info.attributeOperationCount}; children-ops=${info.childrenOperationCount}; reconcile-children-ops=${info.reconcileChildrenOperationCount}; dimension-ops=${info.dimensionOperationCount}; replacement-nodes=${info.replacementNodeCount}; largest-replacement=${info.largestReplacementNodeCount}; retained-nodes=${info.retainedNodeCount}; inserted-nodes=${info.insertedNodeCount}; moved-nodes=${info.movedNodeCount}; removed-nodes=${info.removedNodeCount}; full-replacement-fallbacks=${info.fullReplacementFallbackCount}; rejected-reconciliations=${info.reconciliationRejectedCount}; baseline-unsafe-elements=${info.unsafeElementOmissionCount}; baseline-unsupported-nodes=${info.unsupportedNodeOmissionCount}; baseline-depth-omissions=${info.depthBoundaryOmissionCount}; baseline-private-redactions=${info.privateTextRedactionCount}; baseline-stripped-active=${info.strippedActiveAttributeCount}; baseline-stripped-resources=${info.strippedUnsafeResourceCount}; baseline-unreadable-styles=${info.unreadableStyleCount}; baseline-capacity=${info.capacityOmissionCount}; baseline-custom-hosts=${info.customElementHostCount}; baseline-custom-hosts-without-open-root=${info.customElementHostWithoutAccessibleOpenRootCount}; baseline-open-roots=${info.accessibleOpenShadowRootCount}; baseline-missing-proof-fallbacks=${info.missingReconciliationProofFallbackCount}; baseline-covered-dirty-fallbacks=${info.coveredDirtyBranchFallbackCount}; baseline-attribute-context-fallbacks=${info.attributeContextFallbackCount}; baseline-cross-parent-fallbacks=${info.crossParentFallbackCount}; event-unsafe-elements=${event.unsafeElementOmissionCount}; event-unsupported-nodes=${event.unsupportedNodeOmissionCount}; event-depth-omissions=${event.depthBoundaryOmissionCount}; event-private-redactions=${event.privateTextRedactionCount}; event-stripped-active=${event.strippedActiveAttributeCount}; event-stripped-resources=${event.strippedUnsafeResourceCount}; event-unreadable-styles=${event.unreadableStyleCount}; event-capacity=${event.capacityOmissionCount}; event-custom-hosts=${event.customElementHostCount}; event-custom-hosts-without-open-root=${event.customElementHostWithoutAccessibleOpenRootCount}; event-open-roots=${event.accessibleOpenShadowRootCount}; event-missing-proof-fallbacks=${event.missingReconciliationProofFallbackCount}; event-covered-dirty-fallbacks=${event.coveredDirtyBranchFallbackCount}; event-attribute-context-fallbacks=${event.attributeContextFallbackCount}; event-cross-parent-fallbacks=${event.crossParentFallbackCount}; sequence=${info.sequence}`,
          );
          console.info(
      `[Simul fidelity resources] policy=${info.fidelityPolicy}; baseline-preserved-stylesheets=${info.preservedStyleSheetCount}; baseline-flattened-stylesheets=${info.flattenedStyleSheetCount}; baseline-omitted-stylesheets=${info.omittedStyleSheetCount}; baseline-preserved-svg=${info.preservedSvgResourceCount}; baseline-blocked-svg=${info.blockedSvgResourceCount}; baseline-request-capable=${info.replicaRequestCapableResourceCount}; baseline-execution-risk-blocks=${info.executionRiskBlockCount}; baseline-navigation-blocks=${info.navigationBlockCount}; baseline-unsupported-scheme-blocks=${info.unsupportedSchemeBlockCount}; baseline-browser-inaccessible=${info.browserInaccessibleResourceCount}; baseline-strict-policy-blocks=${info.strictResourcePolicyBlockCount}; event-preserved-stylesheets=${event.preservedStyleSheetCount}; event-flattened-stylesheets=${event.flattenedStyleSheetCount}; event-omitted-stylesheets=${event.omittedStyleSheetCount}; event-preserved-svg=${event.preservedSvgResourceCount}; event-blocked-svg=${event.blockedSvgResourceCount}; event-request-capable=${event.replicaRequestCapableResourceCount}; event-execution-risk-blocks=${event.executionRiskBlockCount}; event-navigation-blocks=${event.navigationBlockCount}; event-unsupported-scheme-blocks=${event.unsupportedSchemeBlockCount}; event-browser-inaccessible=${event.browserInaccessibleResourceCount}; event-strict-policy-blocks=${event.strictResourcePolicyBlockCount}; replica-requests-may-occur=${info.replicaRequestsMayOccur}; sequence=${info.sequence}`,
          );
        },
      }
    : {}),
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
  openSource: (request, onChange, signal, policy) => openChromeImageSource(
    request,
    onChange,
    signal,
    'isolated-html',
    policy,
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
      state.preferences.resetRevision,
    ),
  resolveAnchor: (sourceDocument, nodeId) =>
    replicaSurfaceRouter.resolveImageAnchor(sourceDocument, nodeId),
  translationProvider: provider,
  translationMemory: imageTranslationMemory,
  onBusyChange: (busy) => setImageTranslationBusy(busy),
  onDiagnostic: logImageTranslationDiagnostic,
  detectLanguage: async (text) => browser.i18n.detectLanguage(text),
  onAutoLanguageDetected: (language, evidence, document, origin) =>
    translationDriver.offerImageLanguageEvidence(language, evidence, document, origin),
  onAutoLanguageInvalidated: (document) =>
    translationDriver.handleAutoImageLanguageInvalidated(document),
});

const autoLanguageEvidencePrecedence =
  new AutoLanguageEvidencePrecedence<PendingAutoImageLanguageEvidence>();
const navigationRefreshGate = new NavigationRefreshGate();
const isolatedReplicaFailureRecoveryGate =
  new IsolatedReplicaFailureRecoveryGate();
if (compiledImageTextProviderIds.includes('chrome-text-detector')) {
  state.ocrProviderRuntimeStatuses.set('chrome-text-detector', 'checking');
}
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
    characterCount: composerCharacterCount,
    output: composerOutput,
    translateButton: translateComposerButton,
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
  setUiText,
  setStatus,
  onActivityChange: () => updateControls(),
  onTranslated: () => logTranslationCache('quick', translationMemory),
  readableError,
  isSubmitShortcut: isQuickTranslationShortcut,
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
    disabledImageTextProviderIds: state.preferences.disabledImageTextProviderIds,
    imageReadingMethodOrder: state.preferences.imageReadingMethodOrder,
    disabledImageReadingMethodIds: state.preferences.disabledImageReadingMethodIds,
    ocrMinimumConfidence: state.preferences.ocrMinimumConfidence,
    imageScanPolicy: state.preferences.imageScanPolicy,
    skipSmallImages: state.preferences.skipSmallImages,
    usePromptForImageLanguage: state.preferences.usePromptForImageLanguage,
    usePromptForImageText: state.preferences.usePromptForImageText,
    providerRuntimeStatuses: state.ocrProviderRuntimeStatuses,
    usablePixelProviderCount: enabledUsablePixelOcrProviderOrder().length,
  }),
  setUiText,
  changeImageTranslationEnabled: (enabled, requestPixelAccess) =>
    permissionFlows.changeImageTranslationEnabled(enabled, requestPixelAccess),
  commitPatch: (patch) => preferenceClient.commitImageAnalysis(patch),
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
  state,
  ledger: viewPreferencePatchLedger,
  sendMessage: (command) => browser.runtime.sendMessage(command),
  readStorage: () => browser.storage.local.get(STORAGE_KEY),
  onCommitted: (previous) => readScopeController.handleCommittedPreferences(previous),
  onControlsChanged: () => syncPreferenceControls(),
  onLayoutChanged: () => updateMirrorLayout(),
  onZoomApplied: () => {
    zoomInput.value = String(state.preferences.zoomPercent);
    zoomOutput.value = `${state.preferences.zoomPercent}%`;
    zoomInput.disabled = false;
    displayModeSelect.value = state.preferences.displayMode;
    syncToolbarPreferenceControls();
    updateMirrorLayout();
  },
  onError: (message) => setStatus(message, 'error'),
});

const readScopeController = new ReadScopeController({
  state,
  document,
  elements: {
    readScopeSetup,
    setupReadProfile,
    setupReadScopeControls,
    completeReadScopeSetupButton,
    setupReadScopeStatus,
    setupResetCleanup,
    setupResetCleanupStatus,
    retrySetupResetCleanupButton,
    readScopeProfile,
    readScopeControls,
    resetAllSettingsButton,
    resetSettingsDialog,
    resetSettingsStatus,
  },
  preferenceClient,
  purgeSourceDerivedRuntime: purgeSourceDerivedRuntimeForSafety,
  clearResetOnlyRuntimeState: () => clearResetOnlyRuntimeState(),
  restartReplica: () => restartReplicaAfterReadPolicyChange(),
  syncPreferenceControls: () => syncPreferenceControls(),
  setStatus,
});

const permissionFlows = new PermissionFlows({
  state,
  currency,
  permissions: browser.permissions,
  isUserActivationActive: () => navigator.userActivation.isActive,
  preferenceClient,
  usablePixelProviderCount: () => enabledUsablePixelOcrProviderOrder().length,
  setStatus,
  syncPreferenceControls: () => syncPreferenceControls(),
  updateControls: () => updateControls(),
  renderImagePanel: () => imageAnalysisPanel.render(),
  configureImageTranslation: () => configureImageTranslation(),
  purgeImageCache: () => imageTranslationController.purgeSourceDerivedCache(),
  requestAutomaticTranslation: async (pageUrl) => {
    state.translationDesired = true;
    await translationDriver.maybeTranslateAutomatically(captureCoordinator.generation, pageUrl);
  },
});

const translationDriver = new TranslationDriver({
  state,
  currency,
  provider,
  coordinator: replicaTranslationCoordinator,
  captureCoordinator,
  evidence: autoLanguageEvidencePrecedence,
  detectLanguage: async (text) => browser.i18n.detectLanguage(text),
  getTab: (tabId) => browser.tabs.get(tabId),
  autoImageLanguageConfigurationKey: () => currentAutoImageLanguageConfigurationKey(),
  configureImageTranslation: () => configureImageTranslation(),
  setStatus,
  updateControls: () => updateControls(),
  showProgress: (label, value, max) => toolbarStatus.showProgress(label, value, max),
  hideProgress: () => toolbarStatus.hideProgress(),
  renderDetectedLanguage: (text) => {
    detectedLanguageElement.textContent = text;
    detectedLanguageElement.hidden = !text;
  },
  invalidateComposer: () => quickComposer.invalidate(),
  syncComposerPanel: () => quickComposer.syncPanel(),
  onPairPrepared: () => uiLocalizer.retryAfterPagePairPrepared(),
  onTranslationSettled: () => logTranslationCache('page', translationMemory),
});

const capturePipeline = new CapturePipeline({
  state,
  currency,
  captureCoordinator,
  navigationRefreshGate,
  recoveryGate: isolatedReplicaFailureRecoveryGate,
  engine: isolatedHtmlReplicaEngine,
  surface: replicaSurfaceRouter,
  presentation: visibleReplayHost,
  coordinator: replicaTranslationCoordinator,
  imageController: imageTranslationController,
  translationDriver,
  evidence: autoLanguageEvidencePrecedence,
  mirrorSessionId,
  captureTimeoutMs: CAPTURE_TIMEOUT_MS,
  readDocumentId: async (tabId) => {
    // The injected function is bodiless on purpose: only the frame's
    // documentId is read from the injection result.
    const results = await browser.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => undefined,
    });
    return results.find(({ frameId }) => frameId === 0)?.documentId;
  },
  getTab: (tabId) => browser.tabs.get(tabId),
  reconcileAutomaticAccess: (pageUrl) => permissionFlows.reconcileAutomaticAccess(pageUrl),
  cancelNavigationRefresh: () => sourceFollower.cancelNavigationRefresh(),
  invalidateComposer: () => quickComposer.invalidate(),
  setStatus,
  updateControls: () => updateControls(),
  renderLoading: renderLoadingState,
  renderError: renderErrorState,
  hideReplicaStatus: () => {
    replicaStatusContainer.hidden = true;
  },
  clearCaptureNotes: () => {
    captureNotes.hidden = true;
    captureNotes.textContent = '';
  },
  updateMirrorLayout: () => updateMirrorLayout(),
  logImageDiagnostic: logImageTranslationDiagnostic,
  ...(import.meta.env.DEV
    ? {
        onEngineResult: (result: ReplicaRunResult) => {
          console.info('[Simul replica]', result.diagnostics);
        },
      }
    : {}),
});

const sourceFollower = new SourceFollower({
  state,
  currency,
  browser: {
    getTab: (tabId) => browser.tabs.get(tabId),
    queryActiveTab: async (windowId) => (await browser.tabs.query(
      windowId === undefined
        ? { active: true, currentWindow: true }
        : { active: true, windowId },
    ))[0],
    getWindow: (windowId) => browser.windows.get(windowId),
    getCurrentWindowId: async () => (await browser.windows.getCurrent()).id,
    getLastFocusedNormalWindowId: async () =>
      (await browser.windows.getLastFocused({ windowTypes: ['normal'] })).id,
    windowIdNone: browser.windows.WINDOW_ID_NONE,
  },
  detachedIdentityHint,
  navigationDebounceMs: NAVIGATION_DEBOUNCE_MS,
  navigationRefreshGate,
  queueCapture: (request) => capturePipeline.queueCapture(request),
  invalidateCompanion: (message) => capturePipeline.invalidateCompanion(message),
  onSourceNavigationStarted: (next) => capturePipeline.beginSourceNavigation(next),
  onFollowedUrlChanged: (next) =>
    imageTranslationController.setTopPageOrigin(next.url),
  onFollowedTabActivated: () => imageTranslationController.resume(),
  setStatus,
  renderError: renderErrorState,
  updateControls,
});

const companionBuildIdentity = createExtensionBuildIdentity(
  browser.runtime.getManifest(),
);
renderExtensionBuildIdentity(buildVersionElement, companionBuildIdentity);
if (import.meta.env.DEV) {
  console.info(companionBuildIdentity.companionReadyMessage);
}

const preferenceSafetyClient = new PreferenceSafetyClient({
  connect: () => browser.runtime.connect({
    name: PREFERENCE_SAFETY_PORT_NAME,
  }),
  refreshCommittedSnapshot: async () => {
    if (!preferenceClient.applyCommitted(await preferenceClient.readStored())) {
      throw new Error('The committed settings snapshot was older than this panel.');
    }
  },
  onSafetyMessage: (message, reply) =>
    readScopeController.handleSafetyMessage(message, reply),
  onFailClosed: () => {
    state.preferenceSafetyConnectionReady = false;
    purgeSourceDerivedRuntime(
      'The settings safety connection was lost. Read access is Page-only while Simul reconnects…',
    );
    syncPreferenceControls();
  },
  onReady: () => {
    state.preferenceSafetyConnectionReady = true;
    syncPreferenceControls();
    restartReplicaAfterReadPolicyChange();
  },
});
preferenceSafetyClient.start();
window.addEventListener('pagehide', () => preferenceSafetyClient.dispose(), {
  once: true,
});

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
  void preferenceClient.commitView({ displayMode });
  updateMirrorLayout();
});
toolbarOcrToggleButton.addEventListener('click', () => {
  if (!state.preferences.imageTranslationEnabled) {
    void permissionFlows.changeImageTranslationEnabled(true);
  } else if (
    state.imageCaptureAccess !== 'granted' &&
    enabledUsablePixelOcrProviderOrder().length > 0
  ) {
    void permissionFlows.changeImageTranslationEnabled(true, true);
  } else {
    void permissionFlows.changeImageTranslationEnabled(false);
  }
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
  void preferenceClient.commitView({ displayMode: mode });
  updateMirrorLayout();
});

textLayoutSelect.addEventListener('change', () => {
  const mode = isTextLayoutMode(textLayoutSelect.value)
    ? textLayoutSelect.value
    : 'adaptive';
  void preferenceClient.commitView({ textLayoutMode: mode });
  updateMirrorLayout();
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
  void preferenceClient.commitView({ launchBehavior });
});

popoutTabModeSelect.addEventListener('change', () => {
  const popoutTabMode: PopoutTabMode = isPopoutTabMode(popoutTabModeSelect.value)
    ? popoutTabModeSelect.value
    : 'locked';
  void changePopoutTabMode(popoutTabMode);
});

syncScrollInput.addEventListener('change', () => {
  void preferenceClient.commitView({ syncScroll: syncScrollInput.checked });
  if (state.preferences.syncScroll && state.lastSourceScroll) {
    visibleReplayHost.followSourceScroll(state.lastSourceScroll);
  }
});

readScopeController.installListeners();

zoomInput.addEventListener('input', () => preferenceClient.setZoom(Number(zoomInput.value)));
zoomInButton.addEventListener('click', () => preferenceClient.setZoom(state.preferences.zoomPercent + 10));
zoomOutButton.addEventListener('click', () => preferenceClient.setZoom(state.preferences.zoomPercent - 10));
const requestManualRefresh = (): void => {
  void sourceFollower.refreshFollowedPage('manual');
};
refreshButton.addEventListener('click', requestManualRefresh);
compactRefreshButton.addEventListener('click', requestManualRefresh);
translateButton.addEventListener('click', () => {
  if (!state.isLiveSourceOnlyMode) state.translationDesired = true;
  void translationDriver.startTranslation(false, captureCoordinator.generation);
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
quickComposer.install();
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.openCompanionOverlay) {
    event.preventDefault();
    setCompanionOverlay();
  }
});
document.addEventListener('visibilitychange', () => {
  // A hidden companion defers image work; re-kick it when it is shown again.
  if (document.visibilityState === 'visible') imageTranslationController.resume();
});
window.addEventListener('pagehide', () => {
  preferenceClient.flushPendingZoom();
  uiLocalizer.dispose();
  state.replicaShadowAbortController?.abort();
  imageTranslationController.dispose();
  replicaTranslationCoordinator.dispose();
  isolatedHtmlReplicaEngine.dispose();
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const authorizedTab = readAuthorizedTabMessage(message);
  if (authorizedTab) {
    void sourceFollower.acceptAuthorizedTab(authorizedTab);
    return;
  }
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

browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  sourceFollower.handleTabReplaced(addedTabId, removedTabId);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  sourceFollower.handleTabRemoved(tabId, removeInfo);
});

browser.permissions.onAdded.addListener(() => {
  void permissionFlows.refreshImageCaptureAccess();
});

browser.permissions.onRemoved.addListener(() => {
  void permissionFlows.refreshImageCaptureAccess(true);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
  const liveChange = selectLiveCompanionPreferenceChange(
    state.preferences,
    state.livePreferenceStorageFailClosed,
    changes[STORAGE_KEY]?.newValue,
  );
  if (liveChange.status === 'invalid') {
    state.livePreferenceStorageFailClosed = true;
    purgeSourceDerivedRuntime(
      'Stored settings became unavailable or invalid. Read access is Page-only until a current valid snapshot is restored…',
    );
    syncPreferenceControls();
    return;
  }
  if (liveChange.status === 'stale') return;
  const previous = state.preferences;
  const previousPair = state.selectedPair();
  const wasStorageFailClosed = state.livePreferenceStorageFailClosed;
  if (!preferenceClient.applyCommitted(liveChange.preferences)) return;
  state.livePreferenceStorageFailClosed = false;
  const readPolicyChanged = readScopeController.readPolicyChanged(
    previous,
    wasStorageFailClosed,
  );
  if (readPolicyChanged) {
    purgeSourceDerivedRuntime('Readable-content policy changed; rebuilding safely…');
  }
  if (
    isDetachedWindow &&
    previous.popoutTabMode !== state.preferences.popoutTabMode &&
    state.preferences.popoutTabMode === 'active'
  ) {
    void sourceFollower.followCurrentActiveSourceTab();
  }
  if (
    previous.replicaFidelityPolicy !== state.preferences.replicaFidelityPolicy
  ) {
    isolatedReplicaFailureRecoveryGate.reset();
    const identity = state.followedPageIdentity ?? state.capturedPageIdentity;
    if (identity) capturePipeline.queueCapture({ identity, reason: 'preference' });
  }
  if (previous.replicaViewMode !== state.preferences.replicaViewMode) {
    translationDriver.applyReplicaViewMode(previous.replicaViewMode);
  }
  syncPreferenceControls();
  updateMirrorLayout();
  if (readPolicyChanged) restartReplicaAfterReadPolicyChange();
  if (
    state.snapshot &&
    (previous.sourceLanguage !== state.preferences.sourceLanguage ||
      previous.targetLanguage !== state.preferences.targetLanguage)
  ) {
    // The window that changed the languages already recorded its own intent
    // in languageSelectionChanged. A change made in another companion window
    // must not opt this one into translating (review L2).
    void translationDriver.applyLanguagePreferences(false, previousPair);
  }
});

void initialize();

async function initialize(): Promise<void> {
  await Promise.all([preferenceClient.load(), sourceFollower.loadPanelWindowId()]);
  // Permission and experimental-provider probes are optional readiness work.
  // Start them after state.preferences load, but never put them on the critical path
  // for the first visible replica.
  startBestEffortBackgroundTasks([
    () => permissionFlows.refreshImageCaptureAccess(),
    refreshOcrProviderRuntimeStatuses,
  ]);
  const [, sourceResult] = await Promise.allSettled([
    checkPanelPlacement(),
    sourceFollower.initializeSourcePage(),
  ]);
  if (sourceResult.status === 'rejected') {
    const message = readPageError(sourceResult.reason);
    renderErrorState(message);
    setStatus(message, 'error');
    updateControls();
  }
}

function purgeSourceDerivedRuntime(message: string): void {
  void purgeSourceDerivedRuntimeInternal(message);
}

function purgeSourceDerivedRuntimeForSafety(message: string): Promise<void> {
  return purgeSourceDerivedRuntimeInternal(message);
}

function purgeSourceDerivedRuntimeInternal(
  message: string,
): Promise<void> {
  if (state.resolvedSourceLanguageOrigin === 'image') {
    translationDriver.clearAutoImageLanguageResolution();
  }
  captureCoordinator.invalidate();
  currency.supersede('availability');
  state.abortPageWork();
  imageTranslationController.purgeSourceDerivedCache();
  imageTranslationController.releaseReplica();
  isolatedHtmlReplicaEngine.releasePresentation();
  replicaTranslationCoordinator.selectPair(undefined);
  // Read-scope narrowing is a content-retention boundary, not only a visual
  // rebuild. Semantic form/personal text and translated image labels may have
  // populated these memories under the old, broader policy.
  translationMemory.clear();
  state.snapshot = undefined;
  state.translationComplete = false;
  renderLoadingState();
  setStatus(message, 'warning');
  return Promise.resolve();
}

function clearResetOnlyRuntimeState(): void {
  quickComposer.reset();
  imageAnalysisPanel.clearDiagnostics();
  translationDriver.clearAutoImageLanguageResolution();
}

function restartReplicaAfterReadPolicyChange(): void {
  const identity = state.followedPageIdentity ?? state.capturedPageIdentity;
  if (identity) capturePipeline.queueCapture({ identity, reason: 'preference' });
  configureImageTranslation();
}

async function languageSelectionChanged(): Promise<void> {
  const sourceLanguage = sourceSelect.value === 'auto'
    ? 'auto'
    : readLanguage(sourceSelect.value);
  const targetLanguage = readLanguage(targetSelect.value);
  const previousPair = state.selectedPair();
  if (!state.isLiveSourceOnlyMode) state.translationDesired = true;
  const saved = await preferenceClient.commitView({ sourceLanguage, targetLanguage });
  if (!saved) return;
  await translationDriver.applyLanguagePreferences(true, previousPair);
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

function updateMirrorLayout(): void {
  visibleReplayHost.updateLayout({
    displayMode: state.preferences.displayMode,
    zoomPercent: state.preferences.zoomPercent,
  });
  imageTranslationController.refreshOverlays();
  if (
    visibleReplayHost.previewVisible &&
    state.preferences.syncScroll &&
    state.lastSourceScroll
  ) {
    visibleReplayHost.followSourceScroll(state.lastSourceScroll);
  }
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
  toolbarStatus.renderAttention();
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
  setUiText(auto, 'Auto-detect');
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

function setUiText(element: HTMLElement, english: string): void {
  uiLocalizer.setText(element, english);
}

function observeReplicaStateLabel(): void {
  const knownLabels = new Set([
    STATIC_REPLAY_LABEL,
    LIVE_REPLAY_LABEL,
  ]);
  new MutationObserver(() => {
    const english = replicaModeBadge.textContent?.trim() ?? '';
    if (!english) {
      delete replicaModeBadge.dataset.uiLabel;
      return;
    }
    if (!knownLabels.has(english)) return;
    setUiText(replicaModeBadge, english);
  }).observe(replicaModeBadge, { childList: true, characterData: true });
}

async function changePopoutTabMode(popoutTabMode: PopoutTabMode): Promise<void> {
  const saved = await preferenceClient.commitView({ popoutTabMode });
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
    const saved = await preferenceClient.commitView({ replicaFidelityPolicy });
    if (
      !saved ||
      state.preferences.replicaFidelityPolicy !== replicaFidelityPolicy
    ) return;
    isolatedReplicaFailureRecoveryGate.reset();
    const identity = state.followedPageIdentity ?? state.capturedPageIdentity;
    if (identity) capturePipeline.queueCapture({ identity, reason: 'preference' });
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
  const save = preferenceClient.commitView({ replicaViewMode });
  translationDriver.applyReplicaViewMode(previousMode, false);
  await save;
  if (state.preferences.replicaViewMode !== replicaViewMode) {
    translationDriver.applyReplicaViewMode(replicaViewMode);
    return;
  }
  if (replicaViewMode === 'translated' && !state.isLiveSourceOnlyMode) {
    await translationDriver.resumeTranslatedReplicaMode();
  }
}

function syncPreferenceControls(): void {
  const pageUrl = state.followedPageIdentity?.url ?? state.capturedPageIdentity?.url;
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
  readScopeController.renderControls();
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
    setUiText(toolbarSizeLabel, sizeLabel);
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
  setUiText(
    toolbarOcrLabel,
    state.preferences.imageTranslationEnabled ? 'OCR On' : 'OCR Off',
  );
  toolbarOcrToggleButton.title = state.preferences.imageTranslationEnabled
    ? state.imageCaptureAccess === 'granted'
      ? 'Image text translation is on. Click to turn it off.'
      : enabledUsablePixelOcrProviderOrder().length === 0
        ? state.preferences.disabledImageReadingMethodIds.includes(
            ACCESSIBILITY_TEXT_METHOD_ID,
          )
          ? 'Image translation has no enabled reading method. Click to turn it off.'
          : 'Accessibility image text is on. Click to turn it off.'
      : state.preferences.disabledImageReadingMethodIds.includes(
          ACCESSIBILITY_TEXT_METHOD_ID,
        )
        ? 'Image translation is saved but pixel OCR needs image access. Click to grant access.'
        : 'Accessibility image text is on; pixel OCR is paused. Click to grant image access.'
    : 'Image text translation is off. Click to turn it on.';

  const followsActive = isDetachedWindow && state.preferences.popoutTabMode === 'active';
  setUiText(toolbarTabFollowLabel, followsActive ? 'Active' : 'Current');
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
  const readScope = readScopeController.currentReplicaReadScope();
  const disabledMethodIds =
    state.preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
    state.preferences.disabledImageReadingMethodIds.includes(
      ACCESSIBILITY_TEXT_METHOD_ID,
    )
      ? state.preferences.disabledImageReadingMethodIds
      : [
          ACCESSIBILITY_TEXT_METHOD_ID,
          ...state.preferences.disabledImageReadingMethodIds,
        ];
  const enabledMethodIds = new Set(
    state.preferences.imageReadingMethodOrder.filter((method) =>
      !disabledMethodIds.includes(method),
    ),
  );
  const enabledProviderOrder = effectiveCompiledProviderOrder(
    enabledOcrProviderOrder(
      state.preferences.imageReadingMethodOrder,
      disabledMethodIds,
    ),
    state.preferences.disabledImageTextProviderIds,
  );
  const usableProviderOrder = runtimeReadyOcrProviderOrder(
    enabledProviderOrder,
    state.ocrProviderRuntimeStatuses,
  );
  const routedProviderOrder = state.imageCaptureAccess === 'granted'
    ? usableProviderOrder
    : [];
  const nextAutoLanguageConfigurationKey = autoImageLanguageConfigurationKey({
    providerOrder: routedProviderOrder,
    enabledMethodOrder: enabledAutoImageLanguageMethodOrder(
      disabledMethodIds,
      routedProviderOrder,
    ),
    minimumConfidence: state.preferences.ocrMinimumConfidence,
    policyFingerprint: replicaReadScopeFingerprint(readScope),
    controlImages: readScope.controlImages,
  });
  if (shouldClearAutoImageLanguageForDocument(
    state.resolvedSourceLanguageOrigin,
    state.resolvedImageLanguageDocument !== undefined &&
      translationDriver.currentReplicaDocumentMatches(state.resolvedImageLanguageDocument),
  )) {
    translationDriver.clearAutoImageLanguageResolution();
  }
  if (shouldClearAutoImageLanguageResolution(
    state.resolvedSourceLanguageOrigin,
    state.resolvedImageLanguageConfigurationKey,
    nextAutoLanguageConfigurationKey,
  )) {
    translationDriver.clearAutoImageLanguageResolution();
  }
  imageTranslationController.configure({
    enabled:
      state.preferences.imageTranslationEnabled &&
      !state.isLiveSourceOnlyMode &&
      (
        enabledMethodIds.has(ACCESSIBILITY_TEXT_METHOD_ID) ||
        (state.imageCaptureAccess === 'granted' && usableProviderOrder.length > 0)
      ),
    scanPolicy: state.preferences.imageScanPolicy,
    skipSmallImages: state.preferences.skipSmallImages,
    providerOrder: routedProviderOrder,
    methodOrder: state.preferences.imageReadingMethodOrder,
    disabledMethodIds,
    resetEpoch: state.preferences.resetRevision,
    policyFingerprint: replicaReadScopeFingerprint(readScope),
    controlImages: readScope.controlImages,
    ocrMinimumConfidence: state.preferences.ocrMinimumConfidence,
    sourceLanguage: state.preferences.sourceLanguage,
    ...(state.resolvedSourceLanguage
      ? { detectedSourceLanguage: state.resolvedSourceLanguage }
      : {}),
    pageLanguageResolutionPending: state.pageLanguageResolutionPending,
    targetLanguage: state.preferences.targetLanguage,
    translationIdle: !state.translationInFlight,
  });
}

function enabledUsablePixelOcrProviderOrder(): readonly ImageTextProviderId[] {
  return runtimeReadyOcrProviderOrder(
    effectiveCompiledProviderOrder(
      enabledOcrProviderOrder(
        state.preferences.imageReadingMethodOrder,
        state.preferences.disabledImageReadingMethodIds,
      ),
      state.preferences.disabledImageTextProviderIds,
    ),
    state.ocrProviderRuntimeStatuses,
  );
}

function currentAutoImageLanguageConfigurationKey(): string {
  const readScope = readScopeController.currentReplicaReadScope();
  const disabledMethodIds =
    state.preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
    state.preferences.disabledImageReadingMethodIds.includes(
      ACCESSIBILITY_TEXT_METHOD_ID,
    )
      ? state.preferences.disabledImageReadingMethodIds
      : [
          ACCESSIBILITY_TEXT_METHOD_ID,
          ...state.preferences.disabledImageReadingMethodIds,
        ];
  const enabledProviderOrder = effectiveCompiledProviderOrder(
    enabledOcrProviderOrder(
      state.preferences.imageReadingMethodOrder,
      disabledMethodIds,
    ),
    state.preferences.disabledImageTextProviderIds,
  );
  const usableProviderOrder = state.imageCaptureAccess === 'granted'
    ? runtimeReadyOcrProviderOrder(
      enabledProviderOrder,
      state.ocrProviderRuntimeStatuses,
    )
    : [];
  return autoImageLanguageConfigurationKey({
    providerOrder: usableProviderOrder,
    enabledMethodOrder: enabledAutoImageLanguageMethodOrder(
      disabledMethodIds,
      usableProviderOrder,
    ),
    minimumConfidence: state.preferences.ocrMinimumConfidence,
    policyFingerprint: replicaReadScopeFingerprint(readScope),
    controlImages: readScope.controlImages,
  });
}

function enabledAutoImageLanguageMethodOrder(
  disabledMethodIds: readonly ImageReadingMethodId[],
  providerOrder: readonly ImageTextProviderId[],
): ImageReadingMethodId[] {
  const disabled = new Set(disabledMethodIds);
  const providers = new Set<ImageReadingMethodId>(providerOrder);
  return state.preferences.imageReadingMethodOrder.filter((method) =>
    !disabled.has(method) &&
    (method === ACCESSIBILITY_TEXT_METHOD_ID || providers.has(method)),
  );
}

async function refreshOcrProviderRuntimeStatuses(): Promise<void> {
  if (!compiledImageTextProviderIds.includes('chrome-text-detector')) return;
  state.ocrProviderRuntimeStatuses.set('chrome-text-detector', 'checking');
  imageAnalysisPanel.render();
  configureImageTranslation();
  let status: OcrProviderRuntimeStatus;
  try {
    const ensureRaw: unknown = await browser.runtime.sendMessage({
      kind: 'simul:ocr-v1:ensure-host',
      version: 1,
      resetEpoch: state.preferences.resetRevision,
    });
    const ready = readEnsureOcrHostResponse(ensureRaw);
    if (!ready?.ready) throw new Error('OCR host unavailable.');
    const raw: unknown = await browser.runtime.sendMessage(
      createProbeOcrProviderCommand('chrome-text-detector'),
    );
    const response = readProbeOcrProviderResponse(
      raw,
      'chrome-text-detector',
    );
    if (!response) throw new Error('Invalid OCR provider probe response.');
    status = response.provider;
  } catch {
    status = Object.freeze({
      status: 'unavailable',
      providerId: 'chrome-text-detector',
      reason: 'probe-failed',
    });
  }
  state.ocrProviderRuntimeStatuses.set('chrome-text-detector', status);
  imageAnalysisPanel.render();
  configureImageTranslation();
  if (shouldRetryOcrProviderProbe(status, state.textDetectorProbeRetryUsed)) {
    state.textDetectorProbeRetryUsed = true;
    window.setTimeout(() => {
      void refreshOcrProviderRuntimeStatuses();
    }, 1_000);
  }
}

function configureSurfaceButton(): void {
  if (!isDetachedWindow) return;
  popoutButton.textContent = '↙';
  popoutButton.setAttribute('aria-label', 'Return companion to the side panel');
  popoutButton.title = 'Return to side panel';
}

async function openDetachedWindow(): Promise<void> {
  const identity = state.capturedPageIdentity ?? state.followedPageIdentity;
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
      await preferenceClient.rememberSurface('popout');
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
      await preferenceClient.rememberSurface('side-panel');
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

function renderLoadingState(): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  const text = document.createElement('p');
  text.textContent = 'Preparing the live read-only mirror…';
  wrapper.append(text);
  replicaStatusContainer.replaceChildren(wrapper);
  replicaStatusContainer.hidden = false;
}

function renderErrorState(message: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state empty-state--error';
  const text = document.createElement('p');
  text.textContent = message;
  wrapper.append(text);
  replicaStatusContainer.replaceChildren(wrapper);
  replicaStatusContainer.hidden = false;
}

function readLanguage(value: string): SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
    ? (value as SupportedLanguage)
    : 'en';
}

function updateControls(): void {
  syncToolbarPreferenceControls();
  quickComposer.syncPanel();
  const composerInFlight = quickComposer.inFlight;
  const busy = state.captureInFlight || state.translationInFlight || state.permissionInFlight || composerInFlight;
  replicaStatusContainer.setAttribute('aria-busy', String(state.captureInFlight));
  replicaPreviewContainer.setAttribute('aria-busy', String(state.captureInFlight));
  sourceSelect.disabled = busy;
  targetSelect.disabled = busy;
  swapButton.disabled = busy || !state.resolvedSourceLanguage;
  autoTranslateSelect.disabled = busy;
  displayModeSelect.disabled = busy;
  textLayoutSelect.disabled = busy;
  replicaFidelityPolicySelect.disabled = busy || state.replicaFidelityCommitInFlight;
  launchBehaviorSelect.disabled = busy;
  popoutTabModeSelect.disabled = busy;
  syncScrollInput.disabled = busy;
  zoomInButton.disabled = busy;
  zoomOutButton.disabled = busy;
  refreshButton.disabled = state.captureInFlight;
  compactRefreshButton.disabled = state.captureInFlight;
  setUiText(
    refreshButton,
    state.captureInFlight ? 'Rebuilding mirror…' : 'Rebuild mirror',
  );
  compactRefreshButton.setAttribute(
    'aria-label',
    state.captureInFlight ? 'Rebuilding mirror' : 'Rebuild mirror',
  );
  compactRefreshButton.title = state.captureInFlight
    ? 'Rebuilding mirror…'
    : 'Rebuild mirror';
  toolbarAutoDetectButton.disabled = busy;
  toolbarSizeToggleButton.disabled = busy;
  toolbarOcrToggleButton.disabled = busy ||
    state.imageCaptureAccess === 'checking' ||
    !hasCompiledImageAnalysisCapability();
  toolbarTabFollowButton.disabled = busy || !isDetachedWindow;
  popoutButton.disabled = state.surfaceTransitionInFlight ||
    (!isDetachedWindow && !state.capturedPageIdentity);
  cancelButton.hidden =
    !state.translationInFlight && !composerInFlight && !state.imageTranslationInFlight;
  cancelButton.disabled =
    !state.translationInFlight && !composerInFlight && !state.imageTranslationInFlight;
  translateComposerButton.disabled = busy || !composerInput.value.trim() || !state.selectedPair();
  setUiText(
    translateComposerButton,
    composerInFlight ? 'Translating…' : 'Translate',
  );
  translateButton.disabled =
    busy ||
    state.isLiveSourceOnlyMode ||
    !state.snapshot ||
    translationDriver.currentTranslationFieldCount() === 0 ||
    !state.selectedPair() ||
    state.availability === 'unavailable' ||
    state.translationComplete;
  setUiText(
    translateButton,
    state.translationInFlight
      ? 'Translating…'
      : state.translationComplete
        ? 'Translation current'
        : 'Translate page',
  );
  toolbarStatus.renderAttention();
  toolbarStatus.syncProgress();
}

function setImageTranslationBusy(busy: boolean): void {
  const completed = state.imageTranslationInFlight && !busy;
  state.imageTranslationInFlight = busy;
  const composerInFlight = quickComposer.inFlight;
  if (busy && !state.translationInFlight && !composerInFlight) {
    toolbarStatus.showImageProgress();
  } else if (!busy && !state.translationInFlight && !composerInFlight) {
    toolbarStatus.hideProgress();
  }
  if (completed) {
    logTranslationCache('image-text', imageTranslationMemory);
    if (toolbarStatus.statusText === 'Cancelling on-device translation…') {
      setStatus('Image text processing stopped.', 'warning');
    }
  }
  updateControls();
}

function setStatus(
  message: string,
  tone: CompanionStatusTone = 'normal',
): void {
  toolbarStatus.setStatus(message, tone);
}

function logImageTranslationDiagnostic(
  diagnostic: ImageTranslationDiagnostic,
): void {
  // Content-free local diagnostics only; image text, URLs, and pixels are
  // deliberately absent from this channel.
  if (import.meta.env.DEV) {
    console.info('[Simul image translation]', diagnostic);
  }
  imageAnalysisPanel.recordDiagnostic(diagnostic);
}

function logTranslationCache(
  label: 'page' | 'image-text' | 'quick',
  memory: TranslationMemory,
): void {
  if (!import.meta.env.DEV) return;
  const stats = memory.snapshotStats();
  console.info(
    `[Simul translation cache] scope=${label}; entries=${stats.entries}; characters=${stats.characters}; hits=${stats.hits}; misses=${stats.misses}; joins=${stats.inFlightJoins}; provider-loads=${stats.providerLoads}; expirations=${stats.expirations ?? 0}; purges=${stats.purges ?? 0}`,
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
