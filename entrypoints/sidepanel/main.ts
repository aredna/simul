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
  isAvailabilityRequestCurrent,
  replicaViewTranslationAction,
  shouldResetReplicaScrollForCapture,
  type GenerationWork,
} from '../../lib/companion-lifecycle';
import {
  nextCompanionOverlay,
  type CompanionOverlay,
} from '../../lib/companion-ui-state';
import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import {
  CompanionState,
  availabilityPairKey,
  sameTranslationPair,
  type CaptureRequest,
} from './companion-state';
import { Currency, type CurrencyToken } from './currency';
import { ImageAnalysisPanel } from './image-analysis-panel';
import { QuickComposer } from './quick-composer';
import { ToolbarStatus } from './toolbar-status';
import { UiLocalizer } from './ui-localizer';
import { isQuickTranslationShortcut } from '../../lib/quick-translation-shortcut';
import {
  AutoLanguageEvidencePrecedence,
  autoImageLanguageConfigurationKey,
  resolveSourceLanguage,
  shouldClearAutoImageLanguageForDocument,
  shouldClearAutoImageLanguageResolution,
} from '../../lib/language-detection';
import {
  LANGUAGE_OPTION_ORDER,
  languageEndonym,
} from '../../lib/language-options';
import {
  PageAccessError,
  assertSourceTabIsCurrent,
  hasNonDefaultPort,
  identityFromTab,
  isSupportedPage,
  navigationPageIdentityKey,
  navigationPageScopeKey,
  normalizedPageUrl,
  parseDetachedPageIdentityHint,
  readAuthorizedTabMessage,
  readPageError,
  readableError,
  withPageTimeout,
  type AuthorizedTabRequest,
  type CapturedPageIdentity,
} from '../../lib/page-identity';
import {
  isUrlOnlyNavigationSignal,
  NavigationRefreshGate,
  resolveNavigationUpdateStatus,
} from '../../lib/navigation-refresh-gate';
import { shouldRebuildStaleFollowedReplica } from '../../lib/followed-replica-currency';
import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
  isFocusedNormalBrowserWindow,
  isNewerCompanionLaunchStamp,
  sameCompanionSourcePage,
  shouldFollowActivatedTab,
  shouldIgnoreInactiveFollowedTabUpdate,
  shouldRecoverRemovedActiveSource,
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
import type { AutoLanguageProbeEvidence } from '../../lib/ocr/auto-language-probe';
import {
  ImageTranslationController,
  type AutoImageLanguageEvidenceOrigin,
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
  activateImageReplicaAfterRun,
  imageReplicaActivationFailureReason,
} from '../../lib/ocr/replica-activation';
import {
  readPreferenceCommandResult,
  type PreferenceCommand,
  type PreferenceCommandResult,
} from '../../lib/preference-coordinator';
import {
  ALL_SITES_PERMISSION_ORIGINS,
  DEFAULT_COMPANION_PREFERENCES,
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
  permissionOriginsForMode,
  selectLiveCompanionPreferenceChange,
  selectLatestCompanionPreferences,
  withAutoTranslationMode,
  type AutoTranslationMode,
  type CompanionLaunchBehavior,
  type CompanionPreferences,
  type CompanionSurface,
  type CompanionImageAnalysisSettingsPatch,
  type CompanionViewSettingsPatch,
  type PopoutTabMode,
  type ReplicaViewMode,
} from '../../lib/preferences';
import { ViewPreferencePatchLedger } from '../../lib/view-preference-ledger';
import {
  PREFERENCE_SAFETY_PORT_NAME,
  PREFERENCE_SAFETY_PROTOCOL_VERSION,
  readPreferenceSafetyPrepareMessage,
  readPreferenceSafetyReleaseMessage,
} from '../../lib/preference-safety-coordinator';
import { PreferenceSafetyClient } from '../../lib/preference-safety-client';
import { installResetConfirmationController } from '../../lib/reset-confirmation-controller';
import {
  type ReplicaCaptureRequest,
  type ReplicaDiagnosticCode,
} from '../../lib/replica/contracts';
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
  PAGE_ONLY_REPLICA_READ_SCOPE,
  effectiveReplicaReadScope,
  REPLICA_READ_SCOPE_KEYS,
  REPLICA_READ_SCOPE_SETUP_VERSION,
  deriveReplicaReadScopeProfile,
  intersectReplicaReadScopes,
  replicaReadScopeForProfile,
  replicaReadScopeFingerprint,
  replicaReadScopeNarrows,
  type ReplicaReadScope,
  type ReplicaReadScopeKey,
  type ReplicaReadScopeProfileId,
} from '../../lib/replica/read-scope-policy';
import {
  IsolatedReplicaFailureRecoveryGate,
  isCommittedPrimaryReplica,
  shouldPreserveCommittedReplicaForCapture,
} from '../../lib/replica/replica-recovery';
import { openChromeSemanticSource } from '../../lib/replica/semantic-source-client';
import {
  LIVE_REPLAY_LABEL,
  STATIC_REPLAY_LABEL,
  VisibleReplayHost,
} from '../../lib/replica/visible-replay-host';
import { ReplicaSurfaceRouter } from '../../lib/replica/replica-surface-router';
import {
  captureRequestMatchesSourceDocument,
  sameSourceDocument,
  sameSourceReplicaLease,
  type ReplicaSourceDocumentIdentity,
} from '../../lib/replica/source-identity';
import { buildBoundedLanguageSample } from '../../lib/translation/language-sample';
import { replicaSourceCommitAction } from '../../lib/translation/replica-translation-lifecycle';
import {
  ReplicaTranslationCoordinator,
  isCompleteReplicaTranslationResult,
  splitBoundaryWhitespace,
  type ReplicaSourceCommit,
  type ReplicaTranslationSnapshot,
  type ReplicaTranslationRunResult,
} from '../../lib/translation/replica-translation-coordinator';
import { TranslationMemory } from '../../lib/translation/translation-memory';
import {
  SUPPORTED_LANGUAGES,
  languageName,
  type SupportedLanguage,
  type TranslationPair,
} from '../../lib/translation-provider';

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
  getReplicaReadScope: () => currentReplicaReadScope(),
  onLayoutChanged: () => imageTranslationController.refreshOverlays(),
  onSourceScroll: (scroll) => {
    state.lastSourceScroll = scroll;
    if (state.preferences.syncScroll) visibleReplayHost.followSourceScroll(scroll);
  },
  onSourceCommit: handleReplicaSourceCommit,
  onLiveFailure: handleReplicaLiveFailure,
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
  onAutoLanguageDetected: (language, evidence, document, origin) => {
    if (state.preferences.sourceLanguage !== 'auto' || state.resolvedSourceLanguage) return;
    const ready = autoLanguageEvidencePrecedence.offerImageEvidence({
      language,
      evidence,
      document,
      origin,
      replayLease: state.snapshot?.replayLease,
      identity: state.capturedPageIdentity,
      generation: captureCoordinator.generation,
      configurationKey: currentAutoImageLanguageConfigurationKey(),
    });
    if (ready) commitAutoDetectedImageLanguage(ready);
  },
  onAutoLanguageInvalidated: handleAutoImageLanguageInvalidated,
});

function handleReplicaSourceCommit(commit: ReplicaSourceCommit): void {
  const selectedSnapshot = replicaSurfaceRouter.snapshot();
  if (selectedSnapshot && sameSourceReplicaLease(selectedSnapshot, commit)) {
    state.snapshot = selectedSnapshot;
    replicaStatusContainer.hidden = true;
    clearAutoImageLanguageForDifferentDocument(commit.document);
    // Initial activation is deliberately deferred until the engine run has
    // settled. Checkpoint/live callbacks can only advance an existing lease.
    imageTranslationController.notifyReplicaCommit(
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

function handleReplicaLiveFailure(
  code: ReplicaDiagnosticCode,
): void {
  const identity = state.followedPageIdentity ?? state.capturedPageIdentity;
  const action = identity
    ? isolatedReplicaFailureRecoveryGate.decide(
        visibleReplayHost.hasCommittedReplica,
      )
    : 'terminal-error';
  // Content-free by construction: bounded enums only, with no page identity,
  // source text, URL, DOM identifier, pixels, or resource metadata.
  if (import.meta.env.DEV) {
    console.info('[Simul replica live failure]', {
      engine: 'isolated-html',
      code,
      state: action,
    });
  }
  if (action === 'rebuild-last-good' && identity) {
    setStatus(
      'The live mirror disconnected. Rebuilding once while keeping the last good replica visible…',
      'warning',
    );
    queueCapture({ identity, reason: 'desynchronized' });
    return;
  }

  isolatedReplicaFailureRecoveryGate.reset();
  setStatus(
    'The live replica disconnected again. The last good replica is preserved; choose Refresh to retry.',
    'error',
  );
  updateControls();
}

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
  changeImageTranslationEnabled,
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
    if (!applyCommittedPreferences(await readStoredPreferences())) {
      throw new Error('The committed settings state.snapshot was older than this panel.');
    }
  },
  onSafetyMessage: (message, reply) => {
    return handlePreferenceSafetyMessage(message, reply);
  },
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
  void commitViewPreferencePatch({ displayMode });
  updateMirrorLayout();
});
toolbarOcrToggleButton.addEventListener('click', () => {
  if (!state.preferences.imageTranslationEnabled) {
    void changeImageTranslationEnabled(true);
  } else if (
    state.imageCaptureAccess !== 'granted' &&
    enabledUsablePixelOcrProviderOrder().length > 0
  ) {
    void changeImageTranslationEnabled(true, true);
  } else {
    void changeImageTranslationEnabled(false);
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
  void changeAutoTranslationMode(mode);
});

displayModeSelect.addEventListener('change', () => {
  const mode = isMirrorDisplayMode(displayModeSelect.value)
    ? displayModeSelect.value
    : 'fit';
  void commitViewPreferencePatch({ displayMode: mode });
  updateMirrorLayout();
});

textLayoutSelect.addEventListener('change', () => {
  const mode = isTextLayoutMode(textLayoutSelect.value)
    ? textLayoutSelect.value
    : 'adaptive';
  void commitViewPreferencePatch({ textLayoutMode: mode });
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
  if (state.preferences.syncScroll && state.lastSourceScroll) {
    visibleReplayHost.followSourceScroll(state.lastSourceScroll);
  }
});

readScopeProfile.addEventListener('change', () => {
  if (!isReplicaReadScopeProfileId(readScopeProfile.value)) return;
  void commitReplicaReadScope(
    replicaReadScopeForProfile(readScopeProfile.value),
    false,
  );
});

setupReadProfile.addEventListener('change', () => {
  if (!isReplicaReadScopeProfileId(setupReadProfile.value)) return;
  state.setupReadScopeDraft = replicaReadScopeForProfile(setupReadProfile.value);
  renderReadScopeControls();
});

completeReadScopeSetupButton.addEventListener('click', () => {
  void commitReplicaReadScope(state.setupReadScopeDraft, true);
});

retrySetupResetCleanupButton.addEventListener('click', () => {
  void resetAllExtensionSettings();
});

readScopeSetup.addEventListener('cancel', (event) => {
  // Choosing a read scope is mandatory. Keep the effective policy at Page-only
  // until a setup choice has been committed successfully.
  event.preventDefault();
});

installResetConfirmationController({
  dialog: resetSettingsDialog,
  trigger: resetAllSettingsButton,
  shouldBypassConfirmation: () =>
    state.preferences.resetCleanupPendingRevision > 0,
  onConfirm: resetAllExtensionSettings,
});

zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
zoomInButton.addEventListener('click', () => setZoom(state.preferences.zoomPercent + 10));
zoomOutButton.addEventListener('click', () => setZoom(state.preferences.zoomPercent - 10));
const requestManualRefresh = (): void => {
  void refreshFollowedPage('manual');
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
  commitPendingZoom();
  uiLocalizer.dispose();
  state.replicaShadowAbortController?.abort();
  imageTranslationController.dispose();
  replicaTranslationCoordinator.dispose();
  isolatedHtmlReplicaEngine.dispose();
});

browser.runtime.onMessage.addListener((message: unknown) => {
  const authorizedTab = readAuthorizedTabMessage(message);
  if (authorizedTab) {
    void acceptAuthorizedTab(authorizedTab);
    return;
  }
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
  // Images deferred while the followed tab was inactive can be captured
  // again now that it is the active tab.
  if (state.followedPageIdentity?.tabId === tabId) imageTranslationController.resume();
  if (
    shouldFollowActivatedTab(
      isDetachedWindow,
      state.preferences.popoutTabMode,
      state.panelWindowId,
      windowId,
    )
  ) {
    void followActivatedSourceTab(tabId, windowId);
    return;
  }
  if (
    !isDetachedWindow &&
    state.followedPageIdentity?.windowId === windowId &&
    state.followedPageIdentity.tabId !== tabId
  ) {
    currency.supersede('identity');
    state.followedPageIdentity = undefined;
    clearNavigationTimer();
    invalidateCompanion(
      'The active tab changed. Select the extension on the page you want to follow.',
    );
  }
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (
    !isDetachedWindow ||
    state.preferences.popoutTabMode !== 'active' ||
    windowId === browser.windows.WINDOW_ID_NONE ||
    windowId === state.panelWindowId
  ) return;
  // The pending navigation refresh is left armed: its callback re-validates
  // the followed identity, and clearing it here lost the refresh whenever
  // focus moved within the debounce window (review M1).
  const request = currency.begin('identity');
  void followFocusedBrowserWindow(windowId, request);
});

browser.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  if (
    isDetachedWindow &&
    state.followedPageIdentity?.tabId === tabId &&
    newWindowId !== state.panelWindowId
  ) {
    if (state.preferences.popoutTabMode === 'active') {
      void followActivatedSourceTab(tabId, newWindowId);
    } else {
      const request = currency.begin('identity');
      clearNavigationTimer();
      void followMovedLockedSourceTab(tabId, newWindowId, request);
    }
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const followed = state.followedPageIdentity;
  if (!followed || followed.tabId !== tabId) return;
  // An update from the tab being left can race the activation event for the
  // newly selected tab. In active-follow mode it is stale immediately and
  // must not invalidate the newer identity request.
  if (shouldIgnoreInactiveFollowedTabUpdate(
    isDetachedWindow,
    state.preferences.popoutTabMode,
    tab.active,
    state.activeFollowRequest !== undefined,
  )) return;
  const hasUrlChange = typeof changeInfo.url === 'string';
  const navigationStatus = resolveNavigationUpdateStatus(
    changeInfo.status,
    tab.status,
    hasUrlChange,
  );
  const nextUrl = changeInfo.url ?? tab.url ?? followed.url;
  if (!isSupportedPage(nextUrl)) {
    if (navigationStatus === 'loading' || hasUrlChange) {
      clearNavigationTimer();
      invalidateCompanion(
        'The source tab opened a restricted page. Return to a regular HTTP or HTTPS page and select the extension again.',
      );
    }
    return;
  }
  const nextIdentity = { tabId, windowId: tab.windowId, url: nextUrl };
  const navigationScope = navigationPageScopeKey(nextIdentity);
  const navigationKey = navigationPageIdentityKey(nextIdentity);
  if (navigationStatus === 'loading') {
    if (!navigationRefreshGate.beginDocumentLoad(
      navigationScope,
      navigationKey,
    )) {
      state.followedPageIdentity = nextIdentity;
      return;
    }
    imageTranslationController.setTopPageOrigin(nextIdentity.url);
    currency.supersedePage();
    autoLanguageEvidencePrecedence.invalidate();
    state.pageLanguageResolutionPending = false;
    if (state.resolvedSourceLanguageOrigin === 'image') {
      clearAutoImageLanguageResolution();
    }
    captureCoordinator.invalidate();
    state.abortPageWork();
    imageTranslationController.releaseReplica();
    quickComposer.invalidate();
    state.followedPageIdentity = nextIdentity;
    clearNavigationTimer();
    setStatus('The source page is changing; the current mirror stays visible until the new page is ready.');
  } else if (isUrlOnlyNavigationSignal(
    navigationStatus,
    hasUrlChange,
  )) {
    // Chrome emits URL-only updates for history/hash changes in the current
    // document. The isolated mirror stream owns those DOM changes; rebuilding here
    // would discard stable OCR evidence and replay the entire page.
    const retargetScheduledDocument = navigationRefreshGate
      .observeSameDocumentUrl(navigationScope, navigationKey);
    const retargetPendingDocumentCapture = state.navigationTimer !== undefined &&
      retargetScheduledDocument;
    imageTranslationController.setTopPageOrigin(nextIdentity.url);
    state.followedPageIdentity = nextIdentity;
    // A completed new document may update its history URL during our short
    // debounce. Keep that one authoritative initial capture, retargeted to the
    // current same-document URL, instead of letting the stale timer self-drop.
    if (retargetPendingDocumentCapture) {
      scheduleNavigationRefresh(nextIdentity);
    }
  }
  if (navigationStatus === 'complete') {
    // A redirect may expose its final URL only on the completion signal. Keep
    // the followed identity current before arming the debounce, otherwise its
    // stale-identity guard can discard the only finished-document refresh.
    imageTranslationController.setTopPageOrigin(nextIdentity.url);
    state.followedPageIdentity = nextIdentity;
  }
  if (
    navigationStatus === 'complete' &&
    navigationRefreshGate.shouldScheduleComplete(
      navigationScope,
      navigationKey,
      state.capturedPageIdentity
        ? navigationPageIdentityKey(state.capturedPageIdentity)
        : undefined,
    )
  ) {
    scheduleNavigationRefresh(nextIdentity);
  }
});

browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (state.followedPageIdentity?.tabId !== removedTabId) return;
  const request = currency.begin('identity');
  clearNavigationTimer();
  void followReplacedSourceTab(addedTabId, request);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (state.followedPageIdentity?.tabId !== tabId) return;
  if (shouldRecoverRemovedActiveSource(
    isDetachedWindow,
    state.preferences.popoutTabMode,
    state.panelWindowId,
    removeInfo.windowId,
    removeInfo.isWindowClosing,
  )) {
    const request = currency.begin('identity');
    state.activeFollowRequest = request;
    clearNavigationTimer();
    queueMicrotask(() => {
      void followFocusedBrowserWindow(
        removeInfo.windowId,
        request,
        'The source tab was closed and no neighboring readable tab became active.',
      );
    });
    return;
  }
  invalidateCompanion('The source tab was closed.');
});

browser.permissions.onAdded.addListener(() => {
  void refreshImageCaptureAccess();
});

browser.permissions.onRemoved.addListener(() => {
  void refreshImageCaptureAccess(true);
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
      'Stored settings became unavailable or invalid. Read access is Page-only until a current valid state.snapshot is restored…',
    );
    syncPreferenceControls();
    return;
  }
  if (liveChange.status === 'stale') return;
  const previous = state.preferences;
  const previousPair = state.selectedPair();
  const wasStorageFailClosed = state.livePreferenceStorageFailClosed;
  if (!applyCommittedPreferences(liveChange.preferences)) return;
  state.livePreferenceStorageFailClosed = false;
  const previousReadScope = committedReplicaReadScope(previous);
  const nextReadScope = committedReplicaReadScope(state.preferences);
  const readPolicyChanged =
    wasStorageFailClosed ||
    replicaReadScopeFingerprint(previousReadScope) !==
      replicaReadScopeFingerprint(nextReadScope) ||
    previous.resetRevision !== state.preferences.resetRevision;
  if (readPolicyChanged) {
    purgeSourceDerivedRuntime('Readable-content policy changed; rebuilding safely…');
  }
  if (
    isDetachedWindow &&
    previous.popoutTabMode !== state.preferences.popoutTabMode &&
    state.preferences.popoutTabMode === 'active'
  ) {
    void followCurrentActiveSourceTab();
  }
  if (
    previous.replicaFidelityPolicy !== state.preferences.replicaFidelityPolicy
  ) {
    isolatedReplicaFailureRecoveryGate.reset();
    const identity = state.followedPageIdentity ?? state.capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'preference' });
  }
  if (previous.replicaViewMode !== state.preferences.replicaViewMode) {
    applyReplicaViewMode(previous.replicaViewMode);
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
    void applyLanguagePreferences(false, previousPair);
  }
});

void initialize();

async function initialize(): Promise<void> {
  await Promise.all([loadPreferences(), loadPanelWindowId()]);
  // Permission and experimental-provider probes are optional readiness work.
  // Start them after state.preferences load, but never put them on the critical path
  // for the first visible replica.
  startBestEffortBackgroundTasks([
    refreshImageCaptureAccess,
    refreshOcrProviderRuntimeStatuses,
  ]);
  const [, sourceResult] = await Promise.allSettled([
    checkPanelPlacement(),
    initializeSourcePage(),
  ]);
  if (sourceResult.status === 'rejected') {
    const message = readPageError(sourceResult.reason);
    renderErrorState(message);
    setStatus(message, 'error');
    updateControls();
  }
}

async function initializeSourcePage(): Promise<void> {
  if (detachedIdentityHint) {
    state.followedPageIdentity = state.preferences.popoutTabMode === 'active'
      ? await readActivePageIdentity(detachedIdentityHint.windowId)
      : identityFromTab(
          await browser.tabs.get(detachedIdentityHint.tabId),
          undefined,
          false,
        );
    queueCapture({ identity: state.followedPageIdentity, reason: 'initial' });
    return;
  }
  await refreshFollowedPage('initial');
}

async function loadPanelWindowId(): Promise<void> {
  try {
    state.panelWindowId = (await browser.windows.getCurrent()).id;
  } catch {
    state.panelWindowId = undefined;
  }
}

async function loadPreferences(): Promise<void> {
  try {
    applyCommittedPreferences(
      (await sendPreferenceCommand({ type: 'simul:preferences:reconcile' }))
        .preferences,
    );
  } catch {
    try {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      applyCommittedPreferences(stored[STORAGE_KEY]);
    } catch {
      applyCommittedPreferences(DEFAULT_COMPANION_PREFERENCES);
    }
  }
  syncPreferenceControls();
}

async function sendPreferenceCommand(
  command: PreferenceCommand,
): Promise<PreferenceCommandResult> {
  const response: unknown = await browser.runtime.sendMessage(command);
  const result = readPreferenceCommandResult(response);
  if (!result) throw new Error('The preference service returned an invalid response.');
  return result;
}

async function commitViewPreferencePatch(
  patch: CompanionViewSettingsPatch,
): Promise<boolean> {
  const pending = viewPreferencePatchLedger.begin(state.preferences, patch);
  state.preferences = pending.preferences;
  syncPreferenceControls();
  updateMirrorLayout();
  try {
    const result =
      await sendPreferenceCommand({
        type: 'simul:preferences:patch-view',
        expectedResetRevision: pending.expectedResetRevision,
        patch,
      });
    viewPreferencePatchLedger.settle(pending.requestId);
    applyCommittedPreferences(result.preferences);
    if (!result.applied) {
      throw new Error(
        'Settings were reset in another companion. Review the current choices and try again.',
      );
    }
    syncPreferenceControls();
    updateMirrorLayout();
    return true;
  } catch (error) {
    viewPreferencePatchLedger.settle(pending.requestId);
    try {
      applyCommittedPreferences(await readStoredPreferences());
      syncPreferenceControls();
      updateMirrorLayout();
    } catch {
      // Keep the optimistic controls visible; a later storage event can repair them.
    }
    setStatus(`Could not save options: ${readableError(error)}`, 'error');
    return false;
  }
}

async function commitImageAnalysisPreferencePatch(
  patch: CompanionImageAnalysisSettingsPatch,
): Promise<void> {
  const expectedResetRevision = state.preferences.resetRevision;
  const expectedSettingsRevision = state.preferences.settingsRevision;
  try {
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:patch-image-analysis',
      expectedResetRevision,
      expectedSettingsRevision,
      patch,
    });
    applyCommittedPreferences(result.preferences);
    if (!result.applied) {
      throw new Error(
        result.code === 'stale-settings-revision'
          ? 'Image options changed in another companion. Review the current choices and try again.'
          : 'Settings were reset in another companion. Review the current choices and try again.',
      );
    }
    syncPreferenceControls();
  } catch (error) {
    try {
      applyCommittedPreferences(await readStoredPreferences());
      syncPreferenceControls();
    } catch {
      // A later storage event can reconcile optimistic controls.
    }
    setStatus(`Could not save image options: ${readableError(error)}`, 'error');
  }
}

async function commitReplicaReadScope(
  scope: ReplicaReadScope,
  completeSetup: boolean,
): Promise<void> {
  const sequence = ++state.readScopeCommitSequence;
  const committedAtDispatch = committedReplicaReadScope(state.preferences);
  const current = currentReplicaReadScope();
  const narrowing = replicaReadScopeNarrows(current, scope);
  if (narrowing) {
    state.localReadScopeNarrowingGates.set(sequence, {
      scope: intersectReplicaReadScopes(current, scope),
      failed: false,
    });
    purgeSourceDerivedRuntime('Applying narrower read settings…');
  }
  completeReadScopeSetupButton.disabled = completeSetup;
  setupReadScopeStatus.textContent = completeSetup ? 'Saving…' : '';
  try {
    const result = await sendPreferenceCommand(completeSetup
      ? {
          type: 'simul:preferences:complete-read-scope-setup',
          expectedResetRevision: state.preferences.resetRevision,
          expectedSetupVersion: state.preferences.readScopeSetupVersion,
          expectedReadScopeFingerprint:
            replicaReadScopeFingerprint(committedAtDispatch),
          patch: { replicaReadScope: scope },
        }
      : {
          type: 'simul:preferences:patch-read-scope',
          expectedResetRevision: state.preferences.resetRevision,
          expectedReadScopeFingerprint:
            replicaReadScopeFingerprint(committedAtDispatch),
          patch: { replicaReadScope: scope },
        });
    applyCommittedPreferences(result.preferences);
    if (!result.applied) {
      const gate = state.localReadScopeNarrowingGates.get(sequence);
      if (gate) gate.failed = true;
      throw new Error(result.code === 'stale-reset-revision'
        ? 'Settings changed in another companion. Review the current choices and try again.'
        : result.code === 'stale-read-scope'
          ? 'Readable-content settings changed in another companion. Review the current choices and try again.'
          : result.code === 'safety-ack-failed'
            ? 'Another companion could not confirm its safety purge. Close it or retry the change.'
        : 'The read settings were not applied.');
    }
    for (const pendingSequence of [...state.localReadScopeNarrowingGates.keys()]) {
      if (pendingSequence <= sequence) {
        state.localReadScopeNarrowingGates.delete(pendingSequence);
      }
    }
    state.setupReadScopeDraft = { ...state.preferences.replicaReadScope };
    syncPreferenceControls();
    restartReplicaAfterReadPolicyChange();
    setupReadScopeStatus.textContent = '';
    setStatus('Readable-content settings applied. The replica is rebuilding.', 'success');
  } catch (error) {
    const gate = state.localReadScopeNarrowingGates.get(sequence);
    if (gate) gate.failed = true;
    setupReadScopeStatus.textContent = readableError(error);
    setupReadScopeStatus.dataset.tone = 'error';
    syncPreferenceControls();
    if (state.localReadScopeNarrowingGates.has(sequence)) {
      restartReplicaAfterReadPolicyChange();
    }
    setStatus(`Could not save readable-content settings: ${readableError(error)}`, 'error');
  } finally {
    completeReadScopeSetupButton.disabled = false;
  }
}

async function resetAllExtensionSettings(): Promise<void> {
  if (state.resetInFlight) return;
  state.resetInFlight = true;
  resetAllSettingsButton.disabled = true;
  retrySetupResetCleanupButton.disabled = true;
  resetSettingsStatus.textContent = 'Resetting settings and optional permissions…';
  if (state.preferences.resetCleanupPendingRevision > 0) {
    setupResetCleanupStatus.textContent =
      'Retrying optional permission and runtime cleanup…';
  }
  try {
    const retry = state.preferences.resetCleanupPendingRevision > 0;
    const result = await sendPreferenceCommand(retry
      ? {
          type: 'simul:preferences:retry-reset-cleanup',
          expectedResetRevision: state.preferences.resetRevision,
        }
      : {
          type: 'simul:preferences:reset-all',
          expectedResetRevision: state.preferences.resetRevision,
        });
    applyCommittedPreferences(result.preferences);
    if (!result.applied && result.code === 'stale-reset-revision') {
      syncPreferenceControls();
      resetSettingsStatus.textContent =
        'Settings changed in another companion. Review the current state before resetting.';
      if (state.preferences.resetCleanupPendingRevision > 0) {
        setupResetCleanupStatus.textContent = resetSettingsStatus.textContent;
      }
      return;
    }
    if (!result.applied && result.code === 'safety-ack-failed') {
      syncPreferenceControls();
      resetSettingsStatus.textContent =
        'Another companion could not confirm its safety purge. Close it or retry the reset.';
      return;
    }
    purgeSourceDerivedRuntime('Resetting extension settings…');
    clearResetOnlyRuntimeState();
    state.setupReadScopeDraft = replicaReadScopeForProfile('standard');
    syncPreferenceControls();
    if (result.cleanup?.status === 'pending') {
      const cleanupMessage =
        result.cleanup.remainingManagedOrigins > 0
          ? `Core settings are reset. ${result.cleanup.remainingManagedOrigins} optional permission entr${result.cleanup.remainingManagedOrigins === 1 ? 'y remains' : 'ies remain'} and cleanup is still pending; choose Retry cleanup.`
          : 'Core settings are reset, but permission or runtime cleanup is still pending; choose Retry cleanup.';
      resetSettingsStatus.textContent = cleanupMessage;
      setupResetCleanupStatus.textContent = cleanupMessage;
    } else {
      resetSettingsStatus.textContent =
        'Settings and optional permissions were reset. Choose a read profile to continue.';
    }
  } catch (error) {
    resetSettingsStatus.textContent = `Reset could not finish: ${readableError(error)}`;
    if (state.preferences.resetCleanupPendingRevision > 0) {
      setupResetCleanupStatus.textContent = resetSettingsStatus.textContent;
    }
  } finally {
    state.resetInFlight = false;
    resetAllSettingsButton.disabled = false;
    retrySetupResetCleanupButton.disabled = false;
    renderReadScopeControls();
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
    clearAutoImageLanguageResolution();
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
  clearAutoImageLanguageResolution();
}

async function handlePreferenceSafetyMessage(
  value: unknown,
  reply: (message: unknown) => void,
): Promise<void> {
  const prepare = readPreferenceSafetyPrepareMessage(value);
  if (prepare) {
    state.remoteReadScopeNarrowingGates.prepare(
      prepare.requestId,
      prepare.targetReadScope,
    );
    if (prepare.operation === 'reset') {
      state.localReadScopeNarrowingGates.clear();
    }
    const purge = purgeSourceDerivedRuntimeForSafety(
      prepare.operation === 'reset'
        ? 'Preparing a safe settings reset…'
        : 'Preparing narrower read settings…',
    );
    if (prepare.operation === 'reset') clearResetOnlyRuntimeState();
    await purge;
    reply({
      kind: 'simul:preference-safety-v1:ack',
      version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
      requestId: prepare.requestId,
    });
    return;
  }

  const release = readPreferenceSafetyReleaseMessage(value);
  if (!release) return;
  if (
    release.committed &&
    state.remoteReadScopeNarrowingGates.authorizeCommittedRelease(release.requestId)
  ) {
    releaseAuthorizedRemoteReadScopeSafetyGates();
    releaseSatisfiedLocalReadScopeSafetyGates();
  }
}

function applyCommittedPreferences(value: unknown): boolean {
  const candidate = parseCompanionPreferences(value);
  const previous = state.preferences;
  const selected = selectLatestCompanionPreferences(previous, candidate);
  const candidateIsOlder =
    candidate.resetRevision < previous.resetRevision ||
    (
      candidate.resetRevision === previous.resetRevision &&
      candidate.settingsRevision < previous.settingsRevision
    );
  if (candidateIsOlder) return false;
  state.preferences = viewPreferencePatchLedger.project(selected);
  if (
    state.preferences.readScopeSetupVersion !== REPLICA_READ_SCOPE_SETUP_VERSION &&
    (
      previous.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
      state.preferences.resetRevision > previous.resetRevision
    )
  ) {
    state.setupReadScopeDraft = replicaReadScopeForProfile('standard');
  }
  releaseAuthorizedRemoteReadScopeSafetyGates();
  releaseSatisfiedLocalReadScopeSafetyGates();
  return true;
}

function releaseAuthorizedRemoteReadScopeSafetyGates(): void {
  state.remoteReadScopeNarrowingGates.releaseSatisfied(
    committedReplicaReadScope(state.preferences),
  );
}

function releaseSatisfiedLocalReadScopeSafetyGates(): void {
  const committed = committedReplicaReadScope(state.preferences);
  for (const [sequence, gate] of state.localReadScopeNarrowingGates) {
    if (gate.failed && readScopeIsNoBroaderThan(committed, gate.scope)) {
      state.localReadScopeNarrowingGates.delete(sequence);
    }
  }
}

function readScopeIsNoBroaderThan(
  candidate: ReplicaReadScope,
  ceiling: ReplicaReadScope,
): boolean {
  return replicaReadScopeFingerprint(
    intersectReplicaReadScopes(candidate, ceiling),
  ) === replicaReadScopeFingerprint(candidate);
}

function restartReplicaAfterReadPolicyChange(): void {
  const identity = state.followedPageIdentity ?? state.capturedPageIdentity;
  if (identity) queueCapture({ identity, reason: 'preference' });
  configureImageTranslation();
}

function currentReplicaReadScope(): ReplicaReadScope {
  let scope = committedReplicaReadScope(state.preferences);
  if (!state.preferenceSafetyConnectionReady || state.livePreferenceStorageFailClosed) {
    scope = intersectReplicaReadScopes(scope, PAGE_ONLY_REPLICA_READ_SCOPE);
  }
  for (const gate of state.localReadScopeNarrowingGates.values()) {
    scope = intersectReplicaReadScopes(scope, gate.scope);
  }
  for (const gate of state.remoteReadScopeNarrowingGates.scopes()) {
    scope = intersectReplicaReadScopes(scope, gate);
  }
  return scope;
}

function committedReplicaReadScope(
  candidate: CompanionPreferences,
): ReplicaReadScope {
  return effectiveReplicaReadScope(
    candidate.replicaReadScope,
    candidate.readScopeSetupVersion,
  );
}

async function refreshImageCaptureAccess(
  reportRevocation = false,
): Promise<void> {
  const request = currency.begin('image-access');
  const previous = state.imageCaptureAccess;
  let next: typeof state.imageCaptureAccess;
  try {
    next = await browser.permissions.contains({
      origins: [...ALL_SITES_PERMISSION_ORIGINS],
    }) ? 'granted' : 'missing';
  } catch {
    next = 'missing';
  }
  if (!currency.isCurrent(request)) return;
  const capturePermissionRevoked = reportRevocation &&
    previous === 'granted' && next === 'missing';
  if (capturePermissionRevoked) {
    imageTranslationController.purgeSourceDerivedCache();
  }
  state.imageCaptureAccess = next;
  imageAnalysisPanel.render();
  configureImageTranslation();
  updateControls();
  if (
    reportRevocation &&
    previous === 'granted' &&
    state.imageCaptureAccess === 'missing' &&
    state.preferences.imageTranslationEnabled
  ) {
    setStatus(
      state.preferences.disabledImageReadingMethodIds.includes(
        ACCESSIBILITY_TEXT_METHOD_ID,
      )
        ? 'Image access was removed. Pixel OCR is paused; open options and choose Grant image access to resume.'
        : 'Image access was removed. Accessibility image text remains active; only pixel OCR is paused.',
      'warning',
    );
  }
}

async function changeImageTranslationEnabled(
  enabled: boolean,
  requestPixelAccess = false,
): Promise<void> {
  if (state.permissionInFlight) {
    syncPreferenceControls();
    return;
  }
  state.permissionInFlight = true;
  imageAnalysisPanel.render();
  updateControls();
  try {
    const shouldRequestPixelAccess = requestPixelAccess &&
      enabledUsablePixelOcrProviderOrder().length > 0;
    const outcome = await (async () => {
        const userActivationAvailable = navigator.userActivation.isActive;
        let freshPreferences: CompanionPreferences | undefined;
        let newlyGranted = false;
        let removedImageCaptureGrant = false;
        try {
          const hadImageCaptureGrant = await browser.permissions.contains({
            origins: [...ALL_SITES_PERMISSION_ORIGINS],
          });
          if (enabled && shouldRequestPixelAccess && !hadImageCaptureGrant) {
            if (!userActivationAvailable || !navigator.userActivation.isActive) {
              return { kind: 'activation' } as const;
            }
            const granted = await browser.permissions.request({
              origins: [...ALL_SITES_PERMISSION_ORIGINS],
            });
            if (!granted) return { kind: 'denied' } as const;
            newlyGranted = true;
          }

          freshPreferences = await readStoredPreferences();
          let narrowAccessRestored = true;
          if (
            !enabled &&
            freshPreferences.imageTranslationEnabled &&
            !freshPreferences.autoTranslateAllSites &&
            hadImageCaptureGrant
          ) {
            const removed = await browser.permissions.remove({
              origins: [...ALL_SITES_PERMISSION_ORIGINS],
            });
            const broadStillPresent = await browser.permissions.contains({
              origins: [...ALL_SITES_PERMISSION_ORIGINS],
            });
            if (!removed && broadStillPresent) {
              throw new Error('Chrome retained image capture access.');
            }
            removedImageCaptureGrant = !broadStillPresent;
            const exactOrigins = freshPreferences.autoTranslateOrigins.flatMap(
              (origin) => permissionOriginsForMode('site', origin),
            );
            if (exactOrigins.length > 0) {
              narrowAccessRestored = userActivationAvailable &&
                await browser.permissions.request({ origins: exactOrigins });
              if (narrowAccessRestored) {
                const actual = new Set(
                  (await browser.permissions.getAll()).origins ?? [],
                );
                narrowAccessRestored = exactOrigins.every((origin) =>
                  actual.has(origin)
                );
              }
            }
          }

          const result = await sendPreferenceCommand({
            type: 'simul:preferences:patch-image-analysis',
            expectedResetRevision: freshPreferences.resetRevision,
            expectedSettingsRevision: freshPreferences.settingsRevision,
            patch: { imageTranslationEnabled: enabled },
          });
          if (!result.applied) {
            throw new Error(
              'Settings were reset in another companion while image access was changing.',
            );
          }
          return { kind: 'complete', result, narrowAccessRestored } as const;
        } catch (error) {
          const prior = await readStoredPreferences().catch(
            () => freshPreferences ?? state.preferences,
          );
          if (
            newlyGranted &&
            !prior.autoTranslateAllSites &&
            !prior.imageTranslationEnabled
          ) {
            await browser.permissions.remove({
              origins: [...ALL_SITES_PERMISSION_ORIGINS],
            }).catch(() => false);
          }
          if (
            removedImageCaptureGrant &&
            prior.imageTranslationEnabled
          ) {
            await browser.permissions.request({
              origins: [...ALL_SITES_PERMISSION_ORIGINS],
            }).catch(() => false);
          }
          throw error;
        }
    })();
    if (outcome.kind === 'activation') {
      await reloadPreferencesFromStorage();
      setStatus(
        'Choose the image setting again so Chrome can show its access prompt.',
        'warning',
      );
      return;
    }
    if (outcome.kind === 'denied') {
      await reloadPreferencesFromStorage();
      setStatus(
        state.preferences.imageTranslationEnabled
          ? state.preferences.disabledImageReadingMethodIds.includes(
              ACCESSIBILITY_TEXT_METHOD_ID,
            )
            ? 'Pixel OCR remains paused. Choose Grant image access when you are ready to retry.'
            : 'Accessibility image text remains active without image access; pixel OCR was not enabled.'
          : 'Chrome did not grant image access, so image translation remains off. You can retry from options.',
        'warning',
      );
      return;
    }

    applyCommittedPreferences(outcome.result.preferences);
    syncPreferenceControls();
    setStatus(
      enabled
        ? 'Image translation is enabled for visible page images.'
        : outcome.narrowAccessRestored
          ? 'Image translation is off.'
          : 'Image translation is off. Chrome did not retain some saved one-site automatic access.',
      outcome.narrowAccessRestored ? 'success' : 'warning',
    );
  } catch {
    await reloadPreferencesFromStorage();
    setStatus(
      'Chrome could not update image access. Your saved setting was left unchanged; try again from options.',
      'error',
    );
  } finally {
    state.permissionInFlight = false;
    await refreshImageCaptureAccess();
    syncPreferenceControls();
    updateControls();
  }
}

async function acceptAuthorizedTab(authorization: AuthorizedTabRequest): Promise<void> {
  const authorized = authorization.identity;
  const lockedIdentity = state.followedPageIdentity ?? detachedIdentityHint;
  if (
    isDetachedWindow &&
    lockedIdentity &&
    state.preferences.popoutTabMode === 'locked' &&
    (authorized.windowId !== lockedIdentity.windowId ||
      authorized.tabId !== lockedIdentity.tabId)
  ) return;
  if (authorization.launchStamp) {
    if (!isNewerCompanionLaunchStamp(
      state.latestToolbarLaunchStamp,
      authorization.launchStamp,
    )) return;
    state.latestToolbarLaunchStamp = authorization.launchStamp;
  }
  const request = currency.begin('identity');
  if (!isDetachedWindow) {
    if (state.panelWindowId === undefined) await loadPanelWindowId();
    if (
      !currency.isCurrent(request) ||
      state.panelWindowId === undefined ||
      authorized.windowId !== state.panelWindowId
    ) return;
  }
  if (!currency.isCurrent(request)) return;
  clearNavigationTimer();
  state.followedPageIdentity = authorized;
  queueCapture({ identity: authorized, reason: 'authorized' });
}

async function followMovedLockedSourceTab(
  tabId: number,
  windowId: number,
  request: CurrencyToken,
): Promise<void> {
  try {
    const identity = identityFromTab(
      await browser.tabs.get(tabId),
      undefined,
      false,
    );
    if (
      !currency.isCurrent(request) ||
      state.preferences.popoutTabMode !== 'locked' ||
      identity.tabId !== tabId ||
      identity.windowId !== windowId
    ) return;
    state.detachedSourceWindowId = windowId;
    queueCapture({ identity, reason: 'navigation' });
  } catch (error) {
    if (!currency.isCurrent(request)) return;
    invalidateCompanion(
      `${readPageError(error)} The locked source tab could not be followed after it moved windows.`,
    );
  }
}

async function followReplacedSourceTab(
  tabId: number,
  request: CurrencyToken,
): Promise<void> {
  if (!currency.isCurrent(request)) return;
  if (isDetachedWindow && state.preferences.popoutTabMode === 'active') {
    state.activeFollowRequest = request;
  }
  try {
    const identity = identityFromTab(
      await browser.tabs.get(tabId),
      undefined,
      state.requiresActiveSourceTab,
    );
    if (!currency.isCurrent(request)) return;
    state.detachedSourceWindowId = identity.windowId;
    queueCapture({ identity, reason: 'navigation' });
  } catch (error) {
    if (!currency.isCurrent(request)) return;
    invalidateCompanion(
      `${readPageError(error)} Chrome replaced the source tab, but its new page could not be followed.`,
    );
  } finally {
    finishActiveFollowRequest(request);
  }
}

async function refreshFollowedPage(reason: CaptureRequest['reason']): Promise<void> {
  const request = currency.begin('identity');
  try {
    const identity = state.followedPageIdentity
      ? await readCurrentFollowedIdentity(state.followedPageIdentity)
      : await readActivePageIdentity();
    if (!currency.isCurrent(request)) return;
    state.followedPageIdentity = identity;
    queueCapture({ identity, reason });
  } catch (error) {
    if (!currency.isCurrent(request)) return;
    const message = readPageError(error);
    if (!state.snapshot) renderErrorState(message);
    setStatus(message, 'error');
    updateControls();
  }
}

async function followCurrentActiveSourceTab(): Promise<void> {
  if (!detachedIdentityHint || state.preferences.popoutTabMode !== 'active') return;
  const request = currency.begin('identity');
  state.activeFollowRequest = request;
  clearNavigationTimer();
  try {
    const lastFocused = await browser.windows.getLastFocused({
      windowTypes: ['normal'],
    });
    if (
      !currency.isCurrent(request) ||
      state.preferences.popoutTabMode !== 'active'
    ) return;
    const sourceWindowId =
      lastFocused.id ??
      state.followedPageIdentity?.windowId ??
      state.detachedSourceWindowId ??
      detachedIdentityHint.windowId;
    const [tab] = await browser.tabs.query({
      active: true,
      windowId: sourceWindowId,
    });
    if (
      !currency.isCurrent(request) ||
      state.preferences.popoutTabMode !== 'active'
    ) return;
    if (tab?.id === undefined) {
      invalidateCompanion('The source browser window has no active readable tab.');
      return;
    }
    await followActivatedSourceTab(tab.id, sourceWindowId, tab, request);
  } catch (error) {
    if (!currency.isCurrent(request)) return;
    invalidateCompanion(
      `${readPageError(error)} Active-tab following needs page access for each newly selected site.`,
    );
  } finally {
    finishActiveFollowRequest(request);
  }
}

async function followFocusedBrowserWindow(
  windowId: number,
  request: CurrencyToken,
  missingTabMessage?: string,
): Promise<void> {
  if (
    !currency.isCurrent(request) ||
    state.preferences.popoutTabMode !== 'active'
  ) {
    // tabs.onRemoved marks its request before the microtask that reaches
    // here. A request superseded in that gap must still release the marker,
    // or updates for the followed tab stay ignored until the next follow.
    finishActiveFollowRequest(request);
    return;
  }
  state.activeFollowRequest = request;
  try {
    const sourceWindow = await browser.windows.get(windowId);
    if (
      !currency.isCurrent(request) ||
      state.preferences.popoutTabMode !== 'active'
    ) return;
    if (!isFocusedNormalBrowserWindow(sourceWindow)) return;
    const [tab] = await browser.tabs.query({ active: true, windowId });
    if (
      !currency.isCurrent(request) ||
      state.preferences.popoutTabMode !== 'active'
    ) return;
    state.detachedSourceWindowId = windowId;
    if (tab?.id !== undefined) {
      await followActivatedSourceTab(tab.id, windowId, tab, request);
    } else if (missingTabMessage && currency.isCurrent(request)) {
      invalidateCompanion(missingTabMessage);
    }
  } catch {
    if (missingTabMessage && currency.isCurrent(request)) {
      invalidateCompanion(missingTabMessage);
    }
    // A closing or restricted browser window is not a new source candidate.
  } finally {
    finishActiveFollowRequest(request);
  }
}

async function followActivatedSourceTab(
  tabId: number,
  windowId: number,
  knownTab?: Browser.tabs.Tab,
  existingRequest?: CurrencyToken,
): Promise<void> {
  if (
    !shouldFollowActivatedTab(
      isDetachedWindow,
      state.preferences.popoutTabMode,
      state.panelWindowId,
      windowId,
    )
  ) return;

  const request = existingRequest ?? currency.begin('identity');
  if (!currency.isCurrent(request)) return;
  state.activeFollowRequest = request;
  // A pending navigation refresh stays armed (see windows.onFocusChanged);
  // queueCapture clears it once a different page is followed.
  try {
    const sourceWindow = await browser.windows.get(windowId);
    if (
      !currency.isCurrent(request) ||
      state.preferences.popoutTabMode !== 'active'
    ) return;
    if (!isFocusedNormalBrowserWindow(sourceWindow)) return;
    const tab = knownTab ?? await browser.tabs.get(tabId);
    const identity = identityFromTab(tab, undefined, true);
    if (
      !currency.isCurrent(request) ||
      state.preferences.popoutTabMode !== 'active'
    ) return;
    state.detachedSourceWindowId = windowId;
    if (sameCompanionSourcePage(
      state.followedPageIdentity,
      identity,
      normalizedPageUrl,
    )) {
      // Already following this page. If the rendered replica is still an
      // older page of the same tab (a navigation whose refresh never ran),
      // rebuild now instead of leaving the stale mirror frozen (review M1).
      if (shouldRebuildStaleFollowedReplica({
        captureInFlight: state.captureInFlight,
        navigationRefreshPending: state.navigationTimer !== undefined,
        tabStatus: tab.status,
        captured: state.capturedPageIdentity,
        identity,
        normalizeUrl: normalizedPageUrl,
      })) {
        queueCapture({ identity, reason: 'navigation' });
      }
      return;
    }
    queueCapture({ identity, reason: 'navigation' });
  } catch (error) {
    if (!currency.isCurrent(request)) return;
    invalidateCompanion(
      `${readPageError(error)} Active-tab following needs page access for each newly selected site.`,
    );
  } finally {
    finishActiveFollowRequest(request);
  }
}

function finishActiveFollowRequest(request: CurrencyToken): void {
  if (state.activeFollowRequest?.id === request.id) {
    state.activeFollowRequest = undefined;
  }
}

function queueCapture(request: CaptureRequest): void {
  clearNavigationTimer();
  navigationRefreshGate.consumeCapture(
    navigationPageScopeKey(request.identity),
    navigationPageIdentityKey(request.identity),
  );
  const previousIdentity = state.capturedPageIdentity ?? state.followedPageIdentity;
  const samePage = sameCompanionSourcePage(
    previousIdentity,
    request.identity,
    normalizedPageUrl,
  );
  if (!samePage) isolatedReplicaFailureRecoveryGate.reset();
  if (shouldResetReplicaScrollForCapture(request.reason, samePage)) {
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
  state.abortPageWork();
  imageTranslationController.setTopPageOrigin(request.identity.url);
  imageTranslationController.releaseReplica();
  currency.supersede('availability');
  state.followedPageIdentity = request.identity;
  if (!state.snapshot && !visibleReplayHost.hasCommittedReplica) renderLoadingState();
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
  }
}

async function capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
  const identity = work.value.identity;
  try {
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
    // A same-page manual/recovery rebuild keeps last-good visible while the
    // isolated engine stages its replacement offscreen and swaps atomically.
    if (!preserveLastGoodReplica) {
      isolatedHtmlReplicaEngine.releasePresentation();
      state.snapshot = undefined;
    }
    const results = await withPageTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: () => undefined,
      }),
      CAPTURE_TIMEOUT_MS,
    );
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const bootstrap = results.find(({ frameId }) => frameId === 0);
    const documentId = bootstrap?.documentId;
    if (typeof documentId !== 'string' || documentId.length === 0) {
      throw new PageAccessError('The page did not expose a current document boundary.');
    }
    const currentTab = await browser.tabs.get(identity.tabId);
    assertSourceTabIsCurrent(currentTab, identity, state.requiresActiveSourceTab);
    if (!captureCoordinator.isCurrent(work.generation)) return;

    state.translationComplete = false;
    captureNotes.hidden = true;
    captureNotes.textContent = '';
    await runReplicaEngineCheckpoint(work, identity, documentId);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    state.snapshot = replicaSurfaceRouter.snapshot();
    if (!state.snapshot) {
      throw new PageAccessError('The isolated replica did not commit a current document.');
    }
    // Only published replica state is captured state. Keeping the candidate
    // identity in state.followedPageIdentity lets a failed replacement retain an
    // accurate last-good identity instead of pretending the failed page won.
    // A history/replaceState URL can arrive while this same document is
    // staging. Preserve that newer identity instead of writing the capture's
    // older request URL back over it after the replica commits.
    const committedIdentity = state.followedPageIdentity && sameCompanionSourcePage(
        state.followedPageIdentity,
        identity,
        normalizedPageUrl,
      )
      ? state.followedPageIdentity
      : identity;
    state.capturedPageIdentity = committedIdentity;
    state.followedPageIdentity = committedIdentity;
    await resolveSelectedSourceLanguage(currentReplicaLanguageContext());

    if (state.isLiveSourceOnlyMode) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      setStatus(
        'Live source only is active. The isolated mirror keeps updating without text or image translation.',
        'success',
      );
      return;
    }

    if (currentTranslationFieldCount() === 0) {
      state.availability = 'unavailable';
      state.availabilityCheckedForPair = undefined;
      const accessWasRevoked = await reconcileAutomaticAccess(
        committedIdentity.url,
      );
      if (!captureCoordinator.isCurrent(work.generation)) return;
      setStatus(
        accessWasRevoked
          ? 'Chrome removed a saved automatic-access grant. The mirror is waiting for page text.'
          : 'The page mirror is live and will prepare translation when visible text arrives.',
        'warning',
      );
      return;
    }
    await checkAvailability(work.generation);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const accessWasRevoked = await reconcileAutomaticAccess(
      committedIdentity.url,
    );
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (accessWasRevoked) {
      setStatus('Chrome removed a saved automatic-access grant, so that scope was turned off.', 'warning');
      return;
    }
    await maybeTranslateAutomatically(work.generation, committedIdentity.url);
  } catch (error) {
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const message = readPageError(error);
    state.snapshot = replicaSurfaceRouter.snapshot();
    if (!state.snapshot && !visibleReplayHost.hasCommittedReplica) {
      renderErrorState(message);
    }
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
    sessionId: mirrorSessionId,
    pageEpoch: work.generation,
    generation: work.generation,
    tabId: identity.tabId,
    frameId: 0,
    documentId,
    isCurrent: () =>
      captureCoordinator.isCurrent(work.generation) &&
      sameCompanionSourcePage(
        state.followedPageIdentity,
        identity,
        normalizedPageUrl,
      ),
  };
  let replicaCommitted = false;
  let engineRunSettled = false;
  let activationDecisionSettled = false;
  try {
    const result = await isolatedHtmlReplicaEngine.run(
      request,
      abortController.signal,
    );
    if (import.meta.env.DEV) {
      console.info('[Simul replica]', result.diagnostics);
    }
    engineRunSettled = true;
    replicaCommitted = isCommittedPrimaryReplica(
      result,
      visibleReplayHost.hasCommittedReplica,
    );
    const selectedSnapshot = state.snapshot;
    const activation = activateImageReplicaAfterRun({
      runStatus: result.status,
      hasCommittedReplica: replicaCommitted,
      aborted: abortController.signal.aborted,
      modeMatches: true,
      requestCurrent: request.isCurrent(),
      snapshotAvailable: selectedSnapshot !== undefined,
      snapshotMatches: Boolean(
        selectedSnapshot &&
        captureRequestMatchesSourceDocument(
          request,
          selectedSnapshot.document,
        ),
      ),
      activate: () => Boolean(
        selectedSnapshot &&
        imageTranslationController.activateReplica(
          request,
          identity.windowId,
          selectedSnapshot.replayLease,
        ),
      ),
    });
    if (activation.status === 'not-activated') {
      logImageTranslationDiagnostic(Object.freeze({
        stage: 'replica-not-activated' as const,
        reason: activation.reason,
      }));
    }
    activationDecisionSettled = true;
    if (replicaCommitted) {
      isolatedReplicaFailureRecoveryGate.markCommitted();
      updateMirrorLayout();
      return;
    }
    throw new PageAccessError('The isolated replica could not be prepared. Retry the current page.');
  } catch (error) {
    if (!activationDecisionSettled) {
      const reason = imageReplicaActivationFailureReason({
        aborted: abortController.signal.aborted,
        requestCurrent: request.isCurrent(),
        modeMatches: true,
        engineRunSettled,
      });
      logImageTranslationDiagnostic(Object.freeze({
        stage: 'replica-not-activated' as const,
        reason,
      }));
    }
    throw error;
  } finally {
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

interface PendingAutoImageLanguageEvidence {
  readonly language: SupportedLanguage;
  readonly evidence: AutoLanguageProbeEvidence;
  readonly origin: AutoImageLanguageEvidenceOrigin;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly replayLease: number | undefined;
  readonly identity: CapturedPageIdentity | undefined;
  readonly generation: number;
  readonly configurationKey: string;
}

async function resolveSelectedSourceLanguage(
  liveContext?: LiveLanguageContext,
): Promise<boolean> {
  if (shouldClearAutoImageLanguageForDocument(
    state.resolvedSourceLanguageOrigin,
    state.resolvedImageLanguageDocument !== undefined &&
      currentReplicaDocumentMatches(state.resolvedImageLanguageDocument),
  )) {
    clearAutoImageLanguageResolution();
  }
  const resolution = currency.begin('language-resolution');
  const resolutionRevision = resolution.id;
  if (!state.snapshot) {
    autoLanguageEvidencePrecedence.invalidate();
    state.pageLanguageResolutionPending = false;
    state.resolvedSourceLanguage = undefined;
    state.resolvedSourceLanguageOrigin = undefined;
    state.resolvedImageLanguageConfigurationKey = undefined;
    state.resolvedImageLanguageDocument = undefined;
    quickComposer.syncPanel();
    configureImageTranslation();
    return true;
  }
  const requestedSnapshot = state.snapshot;
  const requestedPreference = state.preferences.sourceLanguage;
  const previousLanguage = state.resolvedSourceLanguage;
  const previousOrigin = state.resolvedSourceLanguageOrigin;
  const previousImageConfigurationKey = state.resolvedImageLanguageConfigurationKey;
  const previousImageDocument = state.resolvedImageLanguageDocument;
  if (requestedPreference !== 'auto') autoLanguageEvidencePrecedence.invalidate();
  autoLanguageEvidencePrecedence.beginPageResolution(resolutionRevision);
  state.pageLanguageResolutionPending =
    autoLanguageEvidencePrecedence.pageResolutionPending;
  // This controller gate is raised before page detection yields. It prevents
  // image probing from adopting a language while stronger page evidence is
  // unresolved, instead of trying to undo a projection afterward.
  configureImageTranslation();
  const detected = await resolveSourceLanguage(
    requestedPreference,
    {
      documentLanguage:
        liveContext?.documentLanguage ?? requestedSnapshot.documentLanguage,
      visibleText: liveContext?.visibleText ?? mirrorLanguageSample(),
    },
    async (text) => browser.i18n.detectLanguage(text),
  );
  if (
    !currency.isCurrent(resolution) ||
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
    state.preferences.sourceLanguage !== requestedPreference
  ) {
    autoLanguageEvidencePrecedence.cancelPageResolution(resolutionRevision);
    state.pageLanguageResolutionPending =
      autoLanguageEvidencePrecedence.pageResolutionPending;
    configureImageTranslation();
    return false;
  }
  const previousImageDocumentIsCurrent = previousOrigin === 'image' &&
    previousImageDocument !== undefined &&
    currentReplicaDocumentMatches(previousImageDocument);
  const preservePreviousLanguage = previousOrigin === 'image'
    ? previousImageDocumentIsCurrent
    : previousOrigin === 'page' && Boolean(liveContext?.preserveOnUnknown);
  state.resolvedSourceLanguage =
    detected.language ??
    (preservePreviousLanguage
      ? previousLanguage
      : undefined);
  if (detected.language) {
    const unchangedExplicitImageLanguage =
      requestedPreference !== 'auto' &&
      previousOrigin === 'image' &&
      previousLanguage === detected.language &&
      previousImageDocumentIsCurrent;
    state.resolvedSourceLanguageOrigin = unchangedExplicitImageLanguage
      ? 'image'
      : requestedPreference === 'auto'
        ? 'page'
        : 'explicit';
    state.resolvedImageLanguageConfigurationKey = unchangedExplicitImageLanguage
      ? previousImageConfigurationKey
      : undefined;
    state.resolvedImageLanguageDocument = unchangedExplicitImageLanguage
      ? previousImageDocument
      : undefined;
  } else if (state.resolvedSourceLanguage) {
    state.resolvedSourceLanguageOrigin = previousOrigin;
    state.resolvedImageLanguageConfigurationKey = previousImageConfigurationKey;
    state.resolvedImageLanguageDocument = previousOrigin === 'image'
      ? previousImageDocument
      : undefined;
  } else {
    state.resolvedSourceLanguageOrigin = undefined;
    state.resolvedImageLanguageConfigurationKey = undefined;
    state.resolvedImageLanguageDocument = undefined;
  }
  const pendingImageEvidence =
    autoLanguageEvidencePrecedence.settlePageResolution(
      resolutionRevision,
      Boolean(state.resolvedSourceLanguage),
    );
  state.pageLanguageResolutionPending =
    autoLanguageEvidencePrecedence.pageResolutionPending;
  if (pendingImageEvidence &&
      pendingAutoImageLanguageEvidenceIsCurrent(pendingImageEvidence)) {
    commitAutoDetectedImageLanguage(pendingImageEvidence);
    return true;
  }
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

function commitAutoDetectedImageLanguage(
  proposal: PendingAutoImageLanguageEvidence,
): void {
  if (
    state.preferences.sourceLanguage !== 'auto' ||
    state.resolvedSourceLanguage ||
    !pendingAutoImageLanguageEvidenceIsCurrent(proposal)
  ) return;
  const resolution = currency.begin('language-resolution');
  state.resolvedSourceLanguage = proposal.language;
  state.resolvedSourceLanguageOrigin = 'image';
  state.resolvedImageLanguageConfigurationKey = proposal.configurationKey;
  state.resolvedImageLanguageDocument = proposal.document;
  currency.supersede('availability');
  state.availabilityCheckedForPair = undefined;
  state.translationComplete = false;
  quickComposer.invalidate();
  const evidenceSource = proposal.origin === 'accessibility-text'
    ? 'accessibility image text'
    : 'bounded image OCR';
  detectedLanguageElement.textContent =
    `Detected ${languageName(proposal.language)} from ${evidenceSource} (${proposal.evidence.replaceAll('-', ' ')}).`;
  detectedLanguageElement.hidden = false;
  quickComposer.syncPanel();
  updateControls();
  queueMicrotask(() => {
    void reconcileAutoDetectedImageLanguage(proposal.language, resolution);
  });
}

function pendingAutoImageLanguageEvidenceIsCurrent(
  proposal: PendingAutoImageLanguageEvidence,
): boolean {
  return (
    proposal.configurationKey === currentAutoImageLanguageConfigurationKey() &&
    currentReplicaDocumentMatches(proposal.document) &&
    proposal.replayLease === state.snapshot?.replayLease &&
    proposal.identity === state.capturedPageIdentity &&
    captureCoordinator.isCurrent(proposal.generation)
  );
}

function handleAutoImageLanguageInvalidated(
  document: ReplicaSourceDocumentIdentity,
): void {
  if (
    state.resolvedSourceLanguageOrigin !== 'image' ||
    !state.resolvedImageLanguageDocument ||
    !sameSourceDocument(state.resolvedImageLanguageDocument, document) ||
    !currentReplicaDocumentMatches(document)
  ) return;
  if (state.preferences.sourceLanguage !== 'auto') {
    // Explicit selection remains authoritative and keeps the effective pair
    // running, but the dormant image contributor must not be resurrected if
    // the user later returns to Auto.
    currency.supersede('language-resolution');
    autoLanguageEvidencePrecedence.invalidate();
    state.pageLanguageResolutionPending = false;
    state.resolvedSourceLanguageOrigin = 'explicit';
    state.resolvedImageLanguageConfigurationKey = undefined;
    state.resolvedImageLanguageDocument = undefined;
    return;
  }
  clearAutoImageLanguageResolution();
  queueMicrotask(() => {
    if (
      state.preferences.sourceLanguage !== 'auto' ||
      !currentReplicaDocumentMatches(document)
    ) return;
    configureImageTranslation();
    void applyLanguagePreferences(false);
  });
}

async function reconcileAutoDetectedImageLanguage(
  language: SupportedLanguage,
  resolution: CurrencyToken,
): Promise<void> {
  if (
    !currency.isCurrent(resolution) ||
    state.preferences.sourceLanguage !== 'auto' ||
    state.resolvedSourceLanguage !== language ||
    !state.resolvedImageLanguageDocument ||
    !currentReplicaDocumentMatches(state.resolvedImageLanguageDocument)
  ) return;
  const generation = captureCoordinator.generation;
  const identity = state.capturedPageIdentity;
  const requestedSnapshot = state.snapshot;
  const pair = state.selectedPair();
  if (!state.isLiveSourceOnlyMode) {
    replicaTranslationCoordinator.selectPair(pair);
  }
  configureImageTranslation();
  if (
    !currency.isCurrent(resolution) ||
    !requestedSnapshot ||
    !identity ||
    !pair ||
    !captureCoordinator.isCurrent(generation)
  ) {
    updateControls();
    return;
  }
  await checkAvailability(generation);
  if (
    !currency.isCurrent(resolution) ||
    state.preferences.sourceLanguage !== 'auto' ||
    state.resolvedSourceLanguage !== language ||
    !state.resolvedImageLanguageDocument ||
    !currentReplicaDocumentMatches(state.resolvedImageLanguageDocument) ||
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
    state.capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation) ||
    !state.isCurrentTranslationPair(pair)
  ) return;
  await maybeTranslateAutomatically(generation, identity.url);
}

function mirrorLanguageSample(): string {
  return buildBoundedLanguageSample(
    replicaRecordSources(state.snapshot?.records ?? []),
  );
}

function currentTranslationFieldCount(): number {
  return state.snapshot?.records.some(
    ({ source }) => source.trim().length > 0,
  ) ? 1 : 0;
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
  const needsPreparation =
    prepareForNewText &&
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
  const previousPair = state.selectedPair();
  if (!state.isLiveSourceOnlyMode) state.translationDesired = true;
  const saved = await commitViewPreferencePatch({ sourceLanguage, targetLanguage });
  if (!saved) return;
  await applyLanguagePreferences(true, previousPair);
}

async function applyLanguagePreferences(
  fromUserAction: boolean,
  previousPair = state.selectedPair(),
): Promise<void> {
  if (!state.snapshot) return;
  await resolveSelectedSourceLanguage(currentReplicaLanguageContext());
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
  const nextPair = state.selectedPair();
  const effectivePairChanged = !sameTranslationPair(previousPair, nextPair);
  if (effectivePairChanged) {
    state.activeAbortController?.abort();
    quickComposer.invalidate();
    state.translationComplete = false;
    state.availabilityCheckedForPair = undefined;
  }
  replicaTranslationCoordinator.selectPair(nextPair);
  if (!effectivePairChanged && state.translationComplete) {
    updateControls();
    return;
  }
  await checkAvailability(captureCoordinator.generation);
  if (!fromUserAction) {
    // A change saved by another companion window, or a re-resolved automatic
    // language, re-establishes state.availability here but only resumes a
    // translation this window already wanted; it records no new intent.
    await maybeTranslateAutomatically(
      captureCoordinator.generation,
      state.capturedPageIdentity?.url ?? '',
    );
    return;
  }
  if (state.availability === 'available') {
    await startTranslation(false, captureCoordinator.generation);
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
  // The pair is recorded as checked only once a result passes the currency
  // guard. Recording it before the await let a superseded request leave the
  // pair marked as checked while state.availability stayed 'unavailable', which
  // disabled Translate and skipped automatic translation for that generation
  // because reconcileReplicaTranslationAfterCommit saw nothing to prepare.
  state.availabilityCheckedForPair = undefined;
  state.availability = 'unavailable';
  updateControls();
  if (pair.sourceLanguage === pair.targetLanguage) {
    state.availabilityCheckedForPair = checkedPairKey;
    state.availability = 'available';
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
  }, () => {
    if (state.activeTranslationTask === task) {
      state.activeTranslationTask = undefined;
      state.activeTranslationKey = undefined;
    }
  });
  return task;
}

async function runTranslation(automatic: boolean, generation: number): Promise<void> {
  const pair = state.selectedPair();
  const requestedSnapshot = state.snapshot;
  const identity = state.capturedPageIdentity;
  if (
    !pair ||
    !requestedSnapshot ||
    !identity ||
    state.isLiveSourceOnlyMode ||
    state.translationInFlight ||
    state.availability === 'unavailable' ||
    (automatic && state.availability !== 'available')
  ) return;
  if (pair.sourceLanguage === pair.targetLanguage) {
    replicaTranslationCoordinator.selectPair(pair);
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
  toolbarStatus.showProgress('Preparing Chrome\'s on-device language model…', 0, 1);
  updateControls();
  try {
    const tab = await browser.tabs.get(identity.tabId);
    assertSourceTabIsCurrent(tab, identity, state.requiresActiveSourceTab);
    if (
      !captureCoordinator.isCurrent(generation) ||
      !currentReplicaSnapshotMatches(requestedSnapshot) ||
      !state.isCurrentTranslationPair(pair) ||
      state.isLiveSourceOnlyMode
    ) return;
    state.availability = 'available';
    state.availabilityCheckedForPair = availabilityPairKey(pair, generation);
    const result = await replicaTranslationCoordinator.translateCurrent(pair, {
      signal: abortController.signal,
      onDownloadProgress: (progress) =>
        toolbarStatus.showProgress(
          `Downloading language pack… ${Math.round(progress * 100)}%`,
          progress,
          1,
        ),
      onProgress: (completed, total) =>
        toolbarStatus.showProgress(
          `Translating ${completed} of ${total}…`,
          completed,
          Math.max(1, total),
        ),
    });
    if (
      !captureCoordinator.isCurrent(generation) ||
      !currentReplicaSnapshotMatches(requestedSnapshot) ||
      !state.isCurrentTranslationPair(pair) ||
      state.isLiveSourceOnlyMode
    ) return;
    state.translationComplete =
      result.total > 0 &&
      replicaTranslationCoordinator.isResultCurrent(result) &&
      isCompleteReplicaTranslationResult(result);
    uiLocalizer.retryAfterPagePairPrepared();
    setStatus(
      state.translationComplete
        ? automatic
          ? 'Automatic translation is complete and live updates will translate as they arrive.'
          : 'Translation is complete and live updates will translate as they arrive.'
        : describePartialReplicaTranslation(result, 'Translation remains partial'),
      state.translationComplete ? 'success' : 'warning',
    );
  } catch (error) {
    if (isAbortError(error) || abortController.signal.aborted) {
      if (
        !state.isLiveSourceOnlyMode &&
        captureCoordinator.isCurrent(generation) &&
        currentReplicaSnapshotMatches(requestedSnapshot) &&
        state.isCurrentTranslationPair(pair)
      ) {
        setStatus('Translation cancelled. Existing translated text was kept.', 'warning');
      }
    } else if (!state.isLiveSourceOnlyMode) {
      setStatus(readableError(error), 'error');
    }
  } finally {
    logTranslationCache('page', translationMemory);
    if (state.activeAbortController === abortController) state.activeAbortController = undefined;
    state.translationInFlight = false;
    configureImageTranslation();
    toolbarStatus.hideProgress();
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

/**
 * Applies zoom immediately and saves it once the slider settles. Saving on
 * every input tick sent one storage write per tick, each of which fanned a
 * storage change to every companion view and rebuilt the settings controls.
 * One optimistic ledger entry covers the whole drag, so a committed state.snapshot
 * arriving mid-drag keeps the slider where the user left it.
 */
function setZoom(value: number): void {
  const patch: CompanionViewSettingsPatch = {
    displayMode: 'custom',
    zoomPercent: clampZoomPercent(value),
  };
  if (state.pendingZoomPatch) {
    viewPreferencePatchLedger.settle(state.pendingZoomPatch.requestId);
  }
  const pending = viewPreferencePatchLedger.begin(state.preferences, patch);
  state.pendingZoomPatch = { requestId: pending.requestId, patch };
  state.preferences = pending.preferences;
  zoomInput.value = String(state.preferences.zoomPercent);
  zoomOutput.value = `${state.preferences.zoomPercent}%`;
  zoomInput.disabled = false;
  displayModeSelect.value = state.preferences.displayMode;
  syncToolbarPreferenceControls();
  updateMirrorLayout();
  if (state.zoomCommitTimer !== undefined) clearTimeout(state.zoomCommitTimer);
  state.zoomCommitTimer = setTimeout(commitPendingZoom, ZOOM_COMMIT_DEBOUNCE_MS);
}

function commitPendingZoom(): void {
  if (state.zoomCommitTimer !== undefined) clearTimeout(state.zoomCommitTimer);
  state.zoomCommitTimer = undefined;
  const pending = state.pendingZoomPatch;
  if (!pending) return;
  state.pendingZoomPatch = undefined;
  // commitViewPreferencePatch opens its own ledger entry synchronously, so
  // the drag's entry can be released without a gap in the projection.
  viewPreferencePatchLedger.settle(pending.requestId);
  void commitViewPreferencePatch(pending.patch);
}

async function changePopoutTabMode(popoutTabMode: PopoutTabMode): Promise<void> {
  const saved = await commitViewPreferencePatch({ popoutTabMode });
  if (!saved || state.preferences.popoutTabMode !== popoutTabMode) return;
  if (isDetachedWindow && popoutTabMode === 'active') {
    await followCurrentActiveSourceTab();
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
    if (
      !saved ||
      state.preferences.replicaFidelityPolicy !== replicaFidelityPolicy
    ) return;
    isolatedReplicaFailureRecoveryGate.reset();
    const identity = state.followedPageIdentity ?? state.capturedPageIdentity;
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
  replicaTranslationCoordinator.selectPair(undefined);
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
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
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
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
    state.capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  await maybeTranslateAutomatically(generation, identity.url);
}

function currentReplicaLanguageContext(): LiveLanguageContext | undefined {
  const current = state.snapshot;
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
  renderReadScopeControls();
  imageAnalysisPanel.render();
  configureImageTranslation();
  uiLocalizer.schedule();
}

const READ_SCOPE_COPY: Readonly<Record<
  ReplicaReadScopeKey,
  { readonly label: string; readonly description: string }
>> = Object.freeze({
  controlSemantics: {
    label: 'Control labels and semantics',
    description: 'Read public button, menu, field-label, and disabled-state text.',
  },
  controlImages: {
    label: 'Images inside controls',
    description: 'Read non-secret navigation and control images; actions stay disabled.',
  },
  disclosureContent: {
    label: 'Collapsed disclosure content',
    description: 'Read validated same-page menus and disclosures even while collapsed.',
  },
  formValues: {
    label: 'Ordinary visible form values',
    description: 'Read visible text, search, URL, textarea, and selection state.',
  },
  personalDataValues: {
    label: 'Personal and autofill values',
    description: 'Read visible email, telephone, name, address, and username fields. Credential and card data stay blocked.',
  },
  editableContent: {
    label: 'Editable page content',
    description: 'Read visible non-secret contenteditable and ARIA text editor drafts.',
  },
});

function renderReadScopeControls(): void {
  const setupComplete =
    state.preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION;
  const cleanupPending = state.preferences.resetCleanupPendingRevision > 0;
  const setupDialogWasOpen = readScopeSetup.open;
  if (setupComplete) {
    if (readScopeSetup.open) readScopeSetup.close();
  } else if (!readScopeSetup.open) {
    // A reset committed in another companion can arrive while this panel's
    // reset confirmation is open. Do not leave a stale modal underneath the
    // mandatory setup dialog.
    if (resetSettingsDialog.open) resetSettingsDialog.close('cancel');
    readScopeSetup.showModal();
  }
  const configuredScope = setupComplete
    ? state.preferences.replicaReadScope
    : replicaReadScopeForProfile('page-only');
  readScopeProfile.value = deriveReplicaReadScopeProfile(configuredScope);
  setupReadProfile.value = deriveReplicaReadScopeProfile(state.setupReadScopeDraft);
  renderReadScopeToggleSet(
    readScopeControls,
    configuredScope,
    (key, checked) => {
      const next = normalizeReadScopeToggle(configuredScope, key, checked);
      void commitReplicaReadScope(next, false);
    },
  );
  renderReadScopeToggleSet(
    setupReadScopeControls,
    state.setupReadScopeDraft,
    (key, checked) => {
      state.setupReadScopeDraft = normalizeReadScopeToggle(
        state.setupReadScopeDraft,
        key,
        checked,
      );
      renderReadScopeControls();
    },
  );
  setupResetCleanup.hidden = !cleanupPending;
  retrySetupResetCleanupButton.disabled = state.resetInFlight;
  if (cleanupPending && !state.setupCleanupWasPending && !state.resetInFlight) {
    setupResetCleanupStatus.textContent =
      'Core settings are already safe, but optional permission or runtime cleanup is still pending.';
  }
  if (
    cleanupPending &&
    !setupComplete &&
    (!setupDialogWasOpen || !state.setupCleanupWasPending)
  ) {
    retrySetupResetCleanupButton.focus();
  } else if (
    !cleanupPending &&
    state.setupCleanupWasPending &&
    readScopeSetup.open &&
    document.activeElement === retrySetupResetCleanupButton
  ) {
    setupReadProfile.focus();
  }
  state.setupCleanupWasPending = cleanupPending;
  resetAllSettingsButton.textContent = cleanupPending
    ? 'Retry reset cleanup'
    : 'Reset all extension settings…';
}

function renderReadScopeToggleSet(
  host: HTMLElement,
  scope: ReplicaReadScope,
  onChange: (key: ReplicaReadScopeKey, checked: boolean) => void,
): void {
  const fragment = document.createDocumentFragment();
  for (const key of REPLICA_READ_SCOPE_KEYS) {
    const label = document.createElement('label');
    label.className = 'read-scope-control';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = scope[key];
    input.disabled = key === 'personalDataValues' && !scope.formValues;
    input.dataset.readScopeKey = key;
    const text = document.createElement('span');
    text.textContent = READ_SCOPE_COPY[key].label;
    const description = document.createElement('small');
    description.textContent = READ_SCOPE_COPY[key].description;
    text.append(description);
    label.append(input, text);
    input.addEventListener('change', () => onChange(key, input.checked));
    fragment.append(label);
  }
  host.replaceChildren(fragment);
}

function normalizeReadScopeToggle(
  scope: ReplicaReadScope,
  key: ReplicaReadScopeKey,
  checked: boolean,
): ReplicaReadScope {
  const next = { ...scope, [key]: checked };
  if (key === 'formValues' && !checked) next.personalDataValues = false;
  if (key === 'personalDataValues' && checked) next.formValues = true;
  return next;
}

function isReplicaReadScopeProfileId(
  value: string,
): value is ReplicaReadScopeProfileId {
  return value === 'page-only' || value === 'standard' ||
    value === 'full-visible';
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
  const readScope = currentReplicaReadScope();
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
      currentReplicaDocumentMatches(state.resolvedImageLanguageDocument),
  )) {
    clearAutoImageLanguageResolution();
  }
  if (shouldClearAutoImageLanguageResolution(
    state.resolvedSourceLanguageOrigin,
    state.resolvedImageLanguageConfigurationKey,
    nextAutoLanguageConfigurationKey,
  )) {
    clearAutoImageLanguageResolution();
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
  const readScope = currentReplicaReadScope();
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

function clearAutoImageLanguageResolution(): void {
  currency.supersede('language-resolution');
  autoLanguageEvidencePrecedence.invalidate();
  state.pageLanguageResolutionPending = false;
  state.resolvedSourceLanguage = undefined;
  state.resolvedSourceLanguageOrigin = undefined;
  state.resolvedImageLanguageConfigurationKey = undefined;
  state.resolvedImageLanguageDocument = undefined;
  currency.supersede('availability');
  state.availability = 'unavailable';
  state.availabilityCheckedForPair = undefined;
  state.translationComplete = false;
  state.activeAbortController?.abort();
  quickComposer.invalidate();
  replicaTranslationCoordinator.selectPair(undefined);
  detectedLanguageElement.textContent =
    'Image-derived language evidence was cleared. OCR is checking again with the updated settings.';
  detectedLanguageElement.hidden = false;
  quickComposer.syncPanel();
}

function currentReplicaDocumentMatches(
  document: ReplicaSourceDocumentIdentity,
): boolean {
  const current = state.snapshot?.document;
  return Boolean(current && sameSourceDocument(current, document));
}

function currentReplicaSnapshotMatches(
  requested: Pick<ReplicaTranslationSnapshot, 'document' | 'replayLease'>,
): boolean {
  const current = state.snapshot;
  return Boolean(current && sameSourceReplicaLease(current, requested));
}

function clearAutoImageLanguageForDifferentDocument(
  document: ReplicaSourceDocumentIdentity,
): void {
  if (!shouldClearAutoImageLanguageForDocument(
    state.resolvedSourceLanguageOrigin,
    Boolean(
      state.resolvedImageLanguageDocument &&
      sameSourceDocument(state.resolvedImageLanguageDocument, document),
    ),
  )) return;
  clearAutoImageLanguageResolution();
  configureImageTranslation();
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

async function changeAutoTranslationMode(mode: AutoTranslationMode): Promise<void> {
  if (state.permissionInFlight) {
    syncPreferenceControls();
    return;
  }
  const pageUrl = state.followedPageIdentity?.url ?? state.capturedPageIdentity?.url;
  const requestedOrigins = permissionOriginsForMode(mode, pageUrl);
  if (mode === 'site' && requestedOrigins.length === 0) {
    syncPreferenceControls();
    setStatus(
      hasNonDefaultPort(pageUrl)
        ? 'Chrome cannot grant narrow one-site access to a non-default port.'
        : 'Open a regular HTTP or HTTPS page before enabling this-site automation.',
      'warning',
    );
    return;
  }
  state.permissionInFlight = true;
  updateControls();
  try {
    const outcome = await performAutoTranslationChange(
      mode,
      pageUrl,
      requestedOrigins,
    );
    if (outcome.kind === 'activation') {
      await reloadPreferencesFromStorage();
      setStatus('Choose the setting again so Chrome can show its access prompt.', 'warning');
      return;
    }
    if (outcome.kind === 'limit') {
      applyCommittedPreferences(outcome.preferences);
      syncPreferenceControls();
      setStatus('The saved-site limit has been reached.', 'warning');
      return;
    }
    if (outcome.kind === 'failed') {
      if (outcome.result) {
        applyCommittedPreferences(outcome.result.preferences);
      }
      else await reloadPreferencesFromStorage();
      syncPreferenceControls();
      setStatus(`Chrome could not update automatic access: ${readableError(outcome.error)}`, 'error');
      return;
    }
    applyCommittedPreferences(outcome.result.preferences);
    syncPreferenceControls();
    if (outcome.kind === 'denied' || outcome.kind === 'not-applied') {
      setStatus('Chrome did not retain the requested automatic-access scope.', 'warning');
      return;
    }
    setStatus(
      mode === 'off'
        ? 'Automatic translation is off for this scope.'
        : mode === 'all'
          ? 'Automatic translation is enabled for regular web pages.'
          : 'Automatic translation is enabled for this site.',
      'success',
    );
    if (mode !== 'off' && state.snapshot && !state.isLiveSourceOnlyMode) {
      state.translationDesired = true;
      await maybeTranslateAutomatically(captureCoordinator.generation, pageUrl ?? '');
    }
  } catch (error) {
    const repaired = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      expectedResetRevision: state.preferences.resetRevision,
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    if (repaired) applyCommittedPreferences(repaired.preferences);
    else await reloadPreferencesFromStorage();
    syncPreferenceControls();
    setStatus(`Chrome could not update automatic access: ${readableError(error)}`, 'error');
  } finally {
    state.permissionInFlight = false;
    updateControls();
  }
}

async function performAutoTranslationChange(
  mode: AutoTranslationMode,
  pageUrl: string | undefined,
  requestedOrigins: string[],
) {
  let freshPreferences: CompanionPreferences | undefined;
  try {
    freshPreferences = await readStoredPreferences();
    const candidate = withAutoTranslationMode(freshPreferences, pageUrl, mode);
    if (mode === 'site' && autoTranslationModeForPage(candidate, pageUrl) !== 'site') {
      return { kind: 'limit', preferences: freshPreferences } as const;
    }
    if ((mode === 'site' || mode === 'all') && !navigator.userActivation.isActive) {
      return { kind: 'activation' } as const;
    }
    if (mode === 'site' && !freshPreferences.imageTranslationEnabled) {
      await browser.permissions.remove({ origins: permissionOriginsForMode('all') });
    }
    const granted =
      requestedOrigins.length === 0 ||
      (await browser.permissions.request({ origins: requestedOrigins }));
    if (!granted) {
      const result = await sendPreferenceCommand({
        type: 'simul:preferences:abort-auto',
        expectedResetRevision: freshPreferences.resetRevision,
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      });
      return { kind: 'denied', result } as const;
    }
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:commit-auto',
      expectedResetRevision: freshPreferences.resetRevision,
      expectedSettingsRevision: freshPreferences.settingsRevision,
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    });
    if (result.applied) return { kind: 'complete', result } as const;
    const repaired = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      expectedResetRevision: result.preferences.resetRevision,
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => result);
    return { kind: 'not-applied', result: repaired } as const;
  } catch (error) {
    const latest = await readStoredPreferences().catch(
      () => freshPreferences ?? state.preferences,
    );
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      expectedResetRevision: latest.resetRevision,
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    return { kind: 'failed', error, result } as const;
  }
}

async function reconcileAutomaticAccess(pageUrl: string | undefined): Promise<boolean> {
  const before = autoTranslationModeForPage(state.preferences, pageUrl);
  const result = await sendPreferenceCommand({ type: 'simul:preferences:reconcile' });
  applyCommittedPreferences(result.preferences);
  syncPreferenceControls();
  return before !== autoTranslationModeForPage(state.preferences, pageUrl);
}

async function readStoredPreferences(): Promise<CompanionPreferences> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return parseCompanionPreferences(stored[STORAGE_KEY]);
}

async function reloadPreferencesFromStorage(): Promise<void> {
  try {
    applyCommittedPreferences(await readStoredPreferences());
  } catch {
    applyCommittedPreferences(DEFAULT_COMPANION_PREFERENCES);
  }
  syncPreferenceControls();
}

function scheduleNavigationRefresh(identity: CapturedPageIdentity): void {
  clearNavigationTimer();
  state.navigationTimer = setTimeout(() => {
    state.navigationTimer = undefined;
    if (
      state.followedPageIdentity?.tabId !== identity.tabId ||
      state.followedPageIdentity.windowId !== identity.windowId ||
      navigationPageIdentityKey(state.followedPageIdentity) !==
        navigationPageIdentityKey(identity)
    ) return;
    queueCapture({ identity, reason: 'navigation' });
  }, NAVIGATION_DEBOUNCE_MS);
}

function clearNavigationTimer(): void {
  if (state.navigationTimer !== undefined) clearTimeout(state.navigationTimer);
  state.navigationTimer = undefined;
}

function invalidateCompanion(message: string): void {
  navigationRefreshGate.reset();
  currency.supersedePage();
  state.activeFollowRequest = undefined;
  autoLanguageEvidencePrecedence.invalidate();
  state.pageLanguageResolutionPending = false;
  captureCoordinator.invalidate();
  state.abortPageWork();
  imageTranslationController.setTopPageOrigin(undefined);
  imageTranslationController.releaseReplica();
  isolatedHtmlReplicaEngine.releasePresentation();
  quickComposer.invalidate();
  state.clearPage();
  replicaTranslationCoordinator.selectPair(undefined);
  isolatedReplicaFailureRecoveryGate.reset();
  visibleReplayHost.resetSourceScroll();
  renderErrorState(message);
  setStatus(message, 'warning');
  updateControls();
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

async function readActivePageIdentity(
  sourceWindowId?: number,
): Promise<CapturedPageIdentity> {
  const [tab] = await browser.tabs.query(
    sourceWindowId === undefined
      ? { active: true, currentWindow: true }
      : { active: true, windowId: sourceWindowId },
  );
  return identityFromTab(tab, undefined, true);
}

async function readCurrentFollowedIdentity(
  followed: CapturedPageIdentity,
): Promise<CapturedPageIdentity> {
  const tab = await browser.tabs.get(followed.tabId);
  return identityFromTab(tab, followed.url, state.requiresActiveSourceTab);
}


function isCurrentAvailabilityRequest(
  request: CurrencyToken,
  requestedSnapshot: ReplicaTranslationSnapshot,
  pair: TranslationPair,
  generation: number,
): boolean {
  const currentPair = state.selectedPair();
  return isAvailabilityRequestCurrent({
    replicaViewMode: state.preferences.replicaViewMode,
    requestMatches: currency.isCurrent(request),
    generationMatches: captureCoordinator.isCurrent(generation),
    snapshotMatches: currentReplicaSnapshotMatches(requestedSnapshot),
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
    currentTranslationFieldCount() === 0 ||
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
