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
  type CompanionLaunchStamp,
} from '../../lib/companion-surface';
import {
  compiledImageAnalysisCapabilities,
  compiledImageTextProviderIds,
  effectiveCompiledProviderOrder,
  hasCompiledImageAnalysisCapability,
} from '../../lib/ocr/provider-registry';
import {
  IMAGE_SCAN_POLICIES,
  isImageScanPolicy,
} from '../../lib/ocr/contracts';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  enabledOcrProviderOrder,
  visibleImageReadingMethodOrder,
  type ImageReadingMethodId,
} from '../../lib/ocr/image-reading-methods';
import type { AutoLanguageProbeEvidence } from '../../lib/ocr/auto-language-probe';
import { ImageTranslationDiagnosticHistory } from '../../lib/ocr/diagnostic-history';
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
  OCR_MINIMUM_CONFIDENCE_OPTIONS,
  isOcrMinimumConfidence,
} from '../../lib/ocr/result-quality';
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
import type { HtmlMirrorScrollState } from '../../lib/replica/html-mirror-protocol';
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
import { RemoteReadScopeSafetyGates } from '../../lib/replica/read-scope-safety-gates';
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
  type TranslationAvailability,
  type TranslationPair,
} from '../../lib/translation-provider';

interface CaptureRequest {
  identity: CapturedPageIdentity;
  reason:
    | 'initial'
    | 'manual'
    | 'navigation'
    | 'authorized'
    | 'preference'
    | 'desynchronized';
}

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

let preferences: CompanionPreferences = parseCompanionPreferences(
  DEFAULT_COMPANION_PREFERENCES,
);
let readScopeCommitSequence = 0;
const localReadScopeNarrowingGates = new Map<
  number,
  { readonly scope: ReplicaReadScope; failed: boolean }
>();
const remoteReadScopeNarrowingGates = new RemoteReadScopeSafetyGates();
let setupReadScopeDraft = replicaReadScopeForProfile('standard');
let preferenceSafetyConnectionReady = false;
let livePreferenceStorageFailClosed = false;
let setupCleanupWasPending = false;
let resetInFlight = false;
const provider = new ChromeTranslatorProvider();
const captureCoordinator = new LatestWorkCoordinator<CaptureRequest>();
const viewPreferencePatchLedger = new ViewPreferencePatchLedger();
const detachedIdentityHint = parseDetachedPageIdentityHint(window.location.search);
const isDetachedWindow = detachedIdentityHint !== undefined;
const mirrorSessionId = crypto.randomUUID();
const visibleReplayHost = new VisibleReplayHost({
  hostDocument: document,
  previewSurface: replicaPreviewContainer,
  badge: replicaModeBadge,
});
let replicaTranslationCoordinator!: ReplicaTranslationCoordinator;
let imageTranslationController!: ImageTranslationController;
const imageTranslationDiagnosticHistory =
  new ImageTranslationDiagnosticHistory();
let imageTranslationDiagnosticsDetails: HTMLDetailsElement | undefined;
let imageTranslationDiagnosticOutput: HTMLOutputElement | undefined;
const replicaSurfaceRouter = new ReplicaSurfaceRouter();
const isolatedHtmlReplicaEngine = new IsolatedHtmlReplicaEngine({
  presentationHost: visibleReplayHost,
  openStream: openChromeHtmlMirrorStream,
  getReplicaFidelityPolicy: () => preferences.replicaFidelityPolicy,
  openSemanticStream: openChromeSemanticSource,
  getReplicaReadScope: () => currentReplicaReadScope(),
  onLayoutChanged: () => imageTranslationController.refreshOverlays(),
  onSourceScroll: (scroll) => {
    lastSourceScroll = scroll;
    if (preferences.syncScroll) visibleReplayHost.followSourceScroll(scroll);
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
        translationComplete = false;
        setStatus(
          describePartialReplicaTranslation(
            result,
            'Live page changes were only partially translated',
          ),
          'warning',
        );
      } else if (result.completed > 0) {
        setStatus(
          translationComplete
            ? 'Live page changes were mirrored and translated.'
            : 'Live page changes were translated, but earlier incomplete text still needs Translate page.',
          translationComplete ? 'success' : 'warning',
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
      preferences.resetRevision,
    ),
  resolveAnchor: (sourceDocument, nodeId) =>
    replicaSurfaceRouter.resolveImageAnchor(sourceDocument, nodeId),
  translationProvider: provider,
  translationMemory: imageTranslationMemory,
  onBusyChange: (busy) => setImageTranslationBusy(busy),
  onDiagnostic: logImageTranslationDiagnostic,
  detectLanguage: async (text) => browser.i18n.detectLanguage(text),
  onAutoLanguageDetected: (language, evidence, document, origin) => {
    if (preferences.sourceLanguage !== 'auto' || resolvedSourceLanguage) return;
    const ready = autoLanguageEvidencePrecedence.offerImageEvidence({
      language,
      evidence,
      document,
      origin,
      replayLease: snapshot?.replayLease,
      identity: capturedPageIdentity,
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
    snapshot = selectedSnapshot;
    replicaStatusContainer.hidden = true;
    clearAutoImageLanguageForDifferentDocument(commit.document);
    // Initial activation is deliberately deferred until the engine run has
    // settled. Checkpoint/live callbacks can only advance an existing lease.
    imageTranslationController.notifyReplicaCommit(
      commit.document,
      commit.replayLease,
    );
  }
  if (isLiveSourceOnlyMode()) return;
  replicaTranslationCoordinator.handleSourceCommit(commit);
  const action = replicaSourceCommitAction(
    commit,
    preferences.sourceLanguage === 'auto',
  );
  if (!action.prepareForNewText && !action.refreshDetectedLanguage) return;
  const refreshVersion = ++replicaLanguageRefreshVersion;
  void reconcileReplicaTranslationAfterCommit(
    commit,
    refreshVersion,
    action.refreshDetectedLanguage,
    action.prepareForNewText,
  );
}

function handleReplicaLiveFailure(
  code: ReplicaDiagnosticCode,
): void {
  const identity = followedPageIdentity ?? capturedPageIdentity;
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

let snapshot: ReplicaTranslationSnapshot | undefined;
let followedPageIdentity: CapturedPageIdentity | undefined;
let capturedPageIdentity: CapturedPageIdentity | undefined;
let resolvedSourceLanguage: SupportedLanguage | undefined;
let resolvedSourceLanguageOrigin: 'page' | 'image' | 'explicit' | undefined;
let resolvedImageLanguageConfigurationKey: string | undefined;
let resolvedImageLanguageDocument: ReplicaSourceDocumentIdentity | undefined;
let availability: TranslationAvailability = 'unavailable';
let availabilityRequestId = 0;
let replicaLanguageRefreshVersion = 0;
let sourceLanguageResolutionRevision = 0;
const autoLanguageEvidencePrecedence =
  new AutoLanguageEvidencePrecedence<PendingAutoImageLanguageEvidence>();
let pageLanguageResolutionPending = false;
let identityRequestId = 0;
let activeFollowRequestId: number | undefined;
let captureInFlight = false;
let translationInFlight = false;
let permissionInFlight = false;
let imageCaptureAccess: 'checking' | 'granted' | 'missing' = 'checking';
let imageCaptureAccessRevision = 0;
let imageTranslationInFlight = false;
let translationDesired = false;
let translationComplete = false;
let openCompanionOverlay: CompanionOverlay | undefined;
let activeAbortController: AbortController | undefined;
let activeTranslationKey: string | undefined;
let replicaShadowAbortController: AbortController | undefined;
let activeTranslationTask: Promise<void> | undefined;
let navigationTimer: ReturnType<typeof setTimeout> | undefined;
const navigationRefreshGate = new NavigationRefreshGate();
let panelWindowId: number | undefined;
let detachedSourceWindowId = detachedIdentityHint?.windowId;
const isolatedReplicaFailureRecoveryGate =
  new IsolatedReplicaFailureRecoveryGate();
let lastSourceScroll: HtmlMirrorScrollState | undefined;
let availabilityCheckedForPair: string | undefined;
let replicaFidelityCommitInFlight = false;
let zoomCommitTimer: ReturnType<typeof setTimeout> | undefined;
let pendingZoomPatch:
  | { readonly requestId: number; readonly patch: CompanionViewSettingsPatch }
  | undefined;
let imageAnalysisControls: HTMLElement | undefined;
let imageAnalysisRenderKey: string | undefined;
let surfaceTransitionInFlight = false;
let latestToolbarLaunchStamp: CompanionLaunchStamp | undefined;
const ocrProviderRuntimeStatuses = new Map<
  ImageTextProviderId,
  OcrProviderRuntimeStatus | 'checking'
>();
let textDetectorProbeRetryUsed = false;
if (compiledImageTextProviderIds.includes('chrome-text-detector')) {
  ocrProviderRuntimeStatuses.set('chrome-text-detector', 'checking');
}
const uiLocalizer = new UiLocalizer({
  document,
  provider,
  dynamicLabels: DYNAMIC_UI_LABELS,
  getTargetLanguage: () => preferences.targetLanguage,
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
  selectedPair,
  getTargetLanguage: () => preferences.targetLanguage,
  translateRemembered,
  setUiText,
  setStatus,
  onActivityChange: () => updateControls(),
  onTranslated: () => logTranslationCache('quick', translationMemory),
  readableError,
  isSubmitShortcut: isQuickTranslationShortcut,
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
    captureInFlight,
    translationInFlight,
    permissionInFlight,
    composerInFlight: quickComposer.inFlight,
    imageTranslationInFlight,
    surfaceTransitionInFlight,
  }),
  isSettingsOpen: () => openCompanionOverlay === 'settings',
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
      throw new Error('The committed settings snapshot was older than this panel.');
    }
  },
  onSafetyMessage: (message, reply) => {
    return handlePreferenceSafetyMessage(message, reply);
  },
  onFailClosed: () => {
    preferenceSafetyConnectionReady = false;
    purgeSourceDerivedRuntime(
      'The settings safety connection was lost. Read access is Page-only while Simul reconnects…',
    );
    syncPreferenceControls();
  },
  onReady: () => {
    preferenceSafetyConnectionReady = true;
    syncPreferenceControls();
    restartReplicaAfterReadPolicyChange();
  },
});
preferenceSafetyClient.start();
window.addEventListener('pagehide', () => preferenceSafetyClient.dispose(), {
  once: true,
});

populateLanguageOptions();
initializeImageAnalysisControls();
configureSurfaceButton();
observeReplicaStateLabel();
uiLocalizer.schedule();

toggleSettingsButton.addEventListener('click', () => {
  setCompanionOverlay(nextCompanionOverlay(openCompanionOverlay, 'settings'));
});
toggleQuickTranslateButton.addEventListener('click', () => {
  setCompanionOverlay(
    nextCompanionOverlay(openCompanionOverlay, 'quick-translate'),
  );
});
closeSettingsButton.addEventListener('click', () => setCompanionOverlay());
closeQuickTranslateButton.addEventListener('click', () => setCompanionOverlay());
popoutButton.addEventListener('click', () => {
  if (surfaceTransitionInFlight) return;
  surfaceTransitionInFlight = true;
  updateControls();
  void (isDetachedWindow ? returnToSidePanel() : openDetachedWindow()).finally(() => {
    surfaceTransitionInFlight = false;
    updateControls();
  });
});
toolbarAutoDetectButton.addEventListener('click', () => {
  sourceSelect.value = 'auto';
  void languageSelectionChanged();
});
toolbarSizeToggleButton.addEventListener('click', () => {
  const displayMode = preferences.displayMode === 'fit' ? 'actual' : 'fit';
  void commitViewPreferencePatch({ displayMode });
  updateMirrorLayout();
});
toolbarOcrToggleButton.addEventListener('click', () => {
  if (!preferences.imageTranslationEnabled) {
    void changeImageTranslationEnabled(true);
  } else if (
    imageCaptureAccess !== 'granted' &&
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
    preferences.popoutTabMode === 'active' ? 'locked' : 'active',
  );
});

sourceSelect.addEventListener('change', () => void languageSelectionChanged());
targetSelect.addEventListener('change', () => void languageSelectionChanged());
swapButton.addEventListener('click', () => {
  if (!resolvedSourceLanguage) return;
  const previousTarget = targetSelect.value;
  sourceSelect.value = previousTarget;
  targetSelect.value = resolvedSourceLanguage;
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
  if (preferences.syncScroll && lastSourceScroll) {
    visibleReplayHost.followSourceScroll(lastSourceScroll);
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
  setupReadScopeDraft = replicaReadScopeForProfile(setupReadProfile.value);
  renderReadScopeControls();
});

completeReadScopeSetupButton.addEventListener('click', () => {
  void commitReplicaReadScope(setupReadScopeDraft, true);
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
    preferences.resetCleanupPendingRevision > 0,
  onConfirm: resetAllExtensionSettings,
});

zoomInput.addEventListener('input', () => setZoom(Number(zoomInput.value)));
zoomInButton.addEventListener('click', () => setZoom(preferences.zoomPercent + 10));
zoomOutButton.addEventListener('click', () => setZoom(preferences.zoomPercent - 10));
const requestManualRefresh = (): void => {
  void refreshFollowedPage('manual');
};
refreshButton.addEventListener('click', requestManualRefresh);
compactRefreshButton.addEventListener('click', requestManualRefresh);
translateButton.addEventListener('click', () => {
  if (!isLiveSourceOnlyMode()) translationDesired = true;
  void startTranslation(false, captureCoordinator.generation);
});
cancelButton.addEventListener('click', () => {
  activeAbortController?.abort();
  const composerCancelled = quickComposer.cancel();
  imageTranslationController.cancelCurrent();
  setStatus(
    translationInFlight || imageTranslationInFlight
      ? 'Cancelling on-device translation…'
      : composerCancelled
        ? 'Quick translation cancelled.'
        : 'Nothing is currently being translated.',
    composerCancelled && !translationInFlight && !imageTranslationInFlight
      ? 'warning'
      : 'normal',
  );
});
translateComposerButton.addEventListener('click', () => void quickComposer.translate());
copyComposerButton.addEventListener('click', () => void quickComposer.copy());
quickComposer.install();
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openCompanionOverlay) {
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
  replicaShadowAbortController?.abort();
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
  if (followedPageIdentity?.tabId === tabId) imageTranslationController.resume();
  if (
    shouldFollowActivatedTab(
      isDetachedWindow,
      preferences.popoutTabMode,
      panelWindowId,
      windowId,
    )
  ) {
    void followActivatedSourceTab(tabId, windowId);
    return;
  }
  if (
    !isDetachedWindow &&
    followedPageIdentity?.windowId === windowId &&
    followedPageIdentity.tabId !== tabId
  ) {
    identityRequestId += 1;
    followedPageIdentity = undefined;
    clearNavigationTimer();
    invalidateCompanion(
      'The active tab changed. Select the extension on the page you want to follow.',
    );
  }
});

browser.windows.onFocusChanged.addListener((windowId) => {
  if (
    !isDetachedWindow ||
    preferences.popoutTabMode !== 'active' ||
    windowId === browser.windows.WINDOW_ID_NONE ||
    windowId === panelWindowId
  ) return;
  // The pending navigation refresh is left armed: its callback re-validates
  // the followed identity, and clearing it here lost the refresh whenever
  // focus moved within the debounce window (review M1).
  const requestId = ++identityRequestId;
  void followFocusedBrowserWindow(windowId, requestId);
});

browser.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  if (
    isDetachedWindow &&
    followedPageIdentity?.tabId === tabId &&
    newWindowId !== panelWindowId
  ) {
    if (preferences.popoutTabMode === 'active') {
      void followActivatedSourceTab(tabId, newWindowId);
    } else {
      const requestId = ++identityRequestId;
      clearNavigationTimer();
      void followMovedLockedSourceTab(tabId, newWindowId, requestId);
    }
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const followed = followedPageIdentity;
  if (!followed || followed.tabId !== tabId) return;
  // An update from the tab being left can race the activation event for the
  // newly selected tab. In active-follow mode it is stale immediately and
  // must not invalidate the newer identity request.
  if (shouldIgnoreInactiveFollowedTabUpdate(
    isDetachedWindow,
    preferences.popoutTabMode,
    tab.active,
    activeFollowRequestId !== undefined,
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
      followedPageIdentity = nextIdentity;
      return;
    }
    imageTranslationController.setTopPageOrigin(nextIdentity.url);
    identityRequestId += 1;
    sourceLanguageResolutionRevision += 1;
    autoLanguageEvidencePrecedence.invalidate();
    pageLanguageResolutionPending = false;
    if (resolvedSourceLanguageOrigin === 'image') {
      clearAutoImageLanguageResolution();
    }
    captureCoordinator.invalidate();
    availabilityRequestId += 1;
    activeAbortController?.abort();
    replicaShadowAbortController?.abort();
    imageTranslationController.releaseReplica();
    quickComposer.invalidate();
    followedPageIdentity = nextIdentity;
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
    const retargetPendingDocumentCapture = navigationTimer !== undefined &&
      retargetScheduledDocument;
    imageTranslationController.setTopPageOrigin(nextIdentity.url);
    followedPageIdentity = nextIdentity;
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
    followedPageIdentity = nextIdentity;
  }
  if (
    navigationStatus === 'complete' &&
    navigationRefreshGate.shouldScheduleComplete(
      navigationScope,
      navigationKey,
      capturedPageIdentity
        ? navigationPageIdentityKey(capturedPageIdentity)
        : undefined,
    )
  ) {
    scheduleNavigationRefresh(nextIdentity);
  }
});

browser.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (followedPageIdentity?.tabId !== removedTabId) return;
  const requestId = ++identityRequestId;
  clearNavigationTimer();
  void followReplacedSourceTab(addedTabId, requestId);
});

browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (followedPageIdentity?.tabId !== tabId) return;
  if (shouldRecoverRemovedActiveSource(
    isDetachedWindow,
    preferences.popoutTabMode,
    panelWindowId,
    removeInfo.windowId,
    removeInfo.isWindowClosing,
  )) {
    const requestId = ++identityRequestId;
    activeFollowRequestId = requestId;
    clearNavigationTimer();
    queueMicrotask(() => {
      void followFocusedBrowserWindow(
        removeInfo.windowId,
        requestId,
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
    preferences,
    livePreferenceStorageFailClosed,
    changes[STORAGE_KEY]?.newValue,
  );
  if (liveChange.status === 'invalid') {
    livePreferenceStorageFailClosed = true;
    purgeSourceDerivedRuntime(
      'Stored settings became unavailable or invalid. Read access is Page-only until a current valid snapshot is restored…',
    );
    syncPreferenceControls();
    return;
  }
  if (liveChange.status === 'stale') return;
  const previous = preferences;
  const previousPair = selectedPair();
  const wasStorageFailClosed = livePreferenceStorageFailClosed;
  if (!applyCommittedPreferences(liveChange.preferences)) return;
  livePreferenceStorageFailClosed = false;
  const previousReadScope = committedReplicaReadScope(previous);
  const nextReadScope = committedReplicaReadScope(preferences);
  const readPolicyChanged =
    wasStorageFailClosed ||
    replicaReadScopeFingerprint(previousReadScope) !==
      replicaReadScopeFingerprint(nextReadScope) ||
    previous.resetRevision !== preferences.resetRevision;
  if (readPolicyChanged) {
    purgeSourceDerivedRuntime('Readable-content policy changed; rebuilding safely…');
  }
  if (
    isDetachedWindow &&
    previous.popoutTabMode !== preferences.popoutTabMode &&
    preferences.popoutTabMode === 'active'
  ) {
    void followCurrentActiveSourceTab();
  }
  if (
    previous.replicaFidelityPolicy !== preferences.replicaFidelityPolicy
  ) {
    isolatedReplicaFailureRecoveryGate.reset();
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'preference' });
  }
  if (previous.replicaViewMode !== preferences.replicaViewMode) {
    applyReplicaViewMode(previous.replicaViewMode);
  }
  syncPreferenceControls();
  updateMirrorLayout();
  if (readPolicyChanged) restartReplicaAfterReadPolicyChange();
  if (
    snapshot &&
    (previous.sourceLanguage !== preferences.sourceLanguage ||
      previous.targetLanguage !== preferences.targetLanguage)
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
  // Start them after preferences load, but never put them on the critical path
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
    followedPageIdentity = preferences.popoutTabMode === 'active'
      ? await readActivePageIdentity(detachedIdentityHint.windowId)
      : identityFromTab(
          await browser.tabs.get(detachedIdentityHint.tabId),
          undefined,
          false,
        );
    queueCapture({ identity: followedPageIdentity, reason: 'initial' });
    return;
  }
  await refreshFollowedPage('initial');
}

async function loadPanelWindowId(): Promise<void> {
  try {
    panelWindowId = (await browser.windows.getCurrent()).id;
  } catch {
    panelWindowId = undefined;
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
  const pending = viewPreferencePatchLedger.begin(preferences, patch);
  preferences = pending.preferences;
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
  const expectedResetRevision = preferences.resetRevision;
  const expectedSettingsRevision = preferences.settingsRevision;
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
  const sequence = ++readScopeCommitSequence;
  const committedAtDispatch = committedReplicaReadScope(preferences);
  const current = currentReplicaReadScope();
  const narrowing = replicaReadScopeNarrows(current, scope);
  if (narrowing) {
    localReadScopeNarrowingGates.set(sequence, {
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
          expectedResetRevision: preferences.resetRevision,
          expectedSetupVersion: preferences.readScopeSetupVersion,
          expectedReadScopeFingerprint:
            replicaReadScopeFingerprint(committedAtDispatch),
          patch: { replicaReadScope: scope },
        }
      : {
          type: 'simul:preferences:patch-read-scope',
          expectedResetRevision: preferences.resetRevision,
          expectedReadScopeFingerprint:
            replicaReadScopeFingerprint(committedAtDispatch),
          patch: { replicaReadScope: scope },
        });
    applyCommittedPreferences(result.preferences);
    if (!result.applied) {
      const gate = localReadScopeNarrowingGates.get(sequence);
      if (gate) gate.failed = true;
      throw new Error(result.code === 'stale-reset-revision'
        ? 'Settings changed in another companion. Review the current choices and try again.'
        : result.code === 'stale-read-scope'
          ? 'Readable-content settings changed in another companion. Review the current choices and try again.'
          : result.code === 'safety-ack-failed'
            ? 'Another companion could not confirm its safety purge. Close it or retry the change.'
        : 'The read settings were not applied.');
    }
    for (const pendingSequence of [...localReadScopeNarrowingGates.keys()]) {
      if (pendingSequence <= sequence) {
        localReadScopeNarrowingGates.delete(pendingSequence);
      }
    }
    setupReadScopeDraft = { ...preferences.replicaReadScope };
    syncPreferenceControls();
    restartReplicaAfterReadPolicyChange();
    setupReadScopeStatus.textContent = '';
    setStatus('Readable-content settings applied. The replica is rebuilding.', 'success');
  } catch (error) {
    const gate = localReadScopeNarrowingGates.get(sequence);
    if (gate) gate.failed = true;
    setupReadScopeStatus.textContent = readableError(error);
    setupReadScopeStatus.dataset.tone = 'error';
    syncPreferenceControls();
    if (localReadScopeNarrowingGates.has(sequence)) {
      restartReplicaAfterReadPolicyChange();
    }
    setStatus(`Could not save readable-content settings: ${readableError(error)}`, 'error');
  } finally {
    completeReadScopeSetupButton.disabled = false;
  }
}

async function resetAllExtensionSettings(): Promise<void> {
  if (resetInFlight) return;
  resetInFlight = true;
  resetAllSettingsButton.disabled = true;
  retrySetupResetCleanupButton.disabled = true;
  resetSettingsStatus.textContent = 'Resetting settings and optional permissions…';
  if (preferences.resetCleanupPendingRevision > 0) {
    setupResetCleanupStatus.textContent =
      'Retrying optional permission and runtime cleanup…';
  }
  try {
    const retry = preferences.resetCleanupPendingRevision > 0;
    const result = await sendPreferenceCommand(retry
      ? {
          type: 'simul:preferences:retry-reset-cleanup',
          expectedResetRevision: preferences.resetRevision,
        }
      : {
          type: 'simul:preferences:reset-all',
          expectedResetRevision: preferences.resetRevision,
        });
    applyCommittedPreferences(result.preferences);
    if (!result.applied && result.code === 'stale-reset-revision') {
      syncPreferenceControls();
      resetSettingsStatus.textContent =
        'Settings changed in another companion. Review the current state before resetting.';
      if (preferences.resetCleanupPendingRevision > 0) {
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
    setupReadScopeDraft = replicaReadScopeForProfile('standard');
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
    if (preferences.resetCleanupPendingRevision > 0) {
      setupResetCleanupStatus.textContent = resetSettingsStatus.textContent;
    }
  } finally {
    resetInFlight = false;
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
  if (resolvedSourceLanguageOrigin === 'image') {
    clearAutoImageLanguageResolution();
  }
  captureCoordinator.invalidate();
  availabilityRequestId += 1;
  activeAbortController?.abort();
  replicaShadowAbortController?.abort();
  imageTranslationController.purgeSourceDerivedCache();
  imageTranslationController.releaseReplica();
  isolatedHtmlReplicaEngine.releasePresentation();
  replicaTranslationCoordinator.selectPair(undefined);
  // Read-scope narrowing is a content-retention boundary, not only a visual
  // rebuild. Semantic form/personal text and translated image labels may have
  // populated these memories under the old, broader policy.
  translationMemory.clear();
  snapshot = undefined;
  translationComplete = false;
  renderLoadingState();
  setStatus(message, 'warning');
  return Promise.resolve();
}

function clearResetOnlyRuntimeState(): void {
  quickComposer.reset();
  imageTranslationDiagnosticHistory.clear();
  renderImageTranslationDiagnosticHistory();
  clearAutoImageLanguageResolution();
}

async function handlePreferenceSafetyMessage(
  value: unknown,
  reply: (message: unknown) => void,
): Promise<void> {
  const prepare = readPreferenceSafetyPrepareMessage(value);
  if (prepare) {
    remoteReadScopeNarrowingGates.prepare(
      prepare.requestId,
      prepare.targetReadScope,
    );
    if (prepare.operation === 'reset') {
      localReadScopeNarrowingGates.clear();
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
    remoteReadScopeNarrowingGates.authorizeCommittedRelease(release.requestId)
  ) {
    releaseAuthorizedRemoteReadScopeSafetyGates();
    releaseSatisfiedLocalReadScopeSafetyGates();
  }
}

function applyCommittedPreferences(value: unknown): boolean {
  const candidate = parseCompanionPreferences(value);
  const previous = preferences;
  const selected = selectLatestCompanionPreferences(previous, candidate);
  const candidateIsOlder =
    candidate.resetRevision < previous.resetRevision ||
    (
      candidate.resetRevision === previous.resetRevision &&
      candidate.settingsRevision < previous.settingsRevision
    );
  if (candidateIsOlder) return false;
  preferences = viewPreferencePatchLedger.project(selected);
  if (
    preferences.readScopeSetupVersion !== REPLICA_READ_SCOPE_SETUP_VERSION &&
    (
      previous.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
      preferences.resetRevision > previous.resetRevision
    )
  ) {
    setupReadScopeDraft = replicaReadScopeForProfile('standard');
  }
  releaseAuthorizedRemoteReadScopeSafetyGates();
  releaseSatisfiedLocalReadScopeSafetyGates();
  return true;
}

function releaseAuthorizedRemoteReadScopeSafetyGates(): void {
  remoteReadScopeNarrowingGates.releaseSatisfied(
    committedReplicaReadScope(preferences),
  );
}

function releaseSatisfiedLocalReadScopeSafetyGates(): void {
  const committed = committedReplicaReadScope(preferences);
  for (const [sequence, gate] of localReadScopeNarrowingGates) {
    if (gate.failed && readScopeIsNoBroaderThan(committed, gate.scope)) {
      localReadScopeNarrowingGates.delete(sequence);
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
  const identity = followedPageIdentity ?? capturedPageIdentity;
  if (identity) queueCapture({ identity, reason: 'preference' });
  configureImageTranslation();
}

function currentReplicaReadScope(): ReplicaReadScope {
  let scope = committedReplicaReadScope(preferences);
  if (!preferenceSafetyConnectionReady || livePreferenceStorageFailClosed) {
    scope = intersectReplicaReadScopes(scope, PAGE_ONLY_REPLICA_READ_SCOPE);
  }
  for (const gate of localReadScopeNarrowingGates.values()) {
    scope = intersectReplicaReadScopes(scope, gate.scope);
  }
  for (const gate of remoteReadScopeNarrowingGates.scopes()) {
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
  const revision = ++imageCaptureAccessRevision;
  const previous = imageCaptureAccess;
  let next: typeof imageCaptureAccess;
  try {
    next = await browser.permissions.contains({
      origins: [...ALL_SITES_PERMISSION_ORIGINS],
    }) ? 'granted' : 'missing';
  } catch {
    next = 'missing';
  }
  if (revision !== imageCaptureAccessRevision) return;
  const capturePermissionRevoked = reportRevocation &&
    previous === 'granted' && next === 'missing';
  if (capturePermissionRevoked) {
    imageTranslationController.purgeSourceDerivedCache();
  }
  imageCaptureAccess = next;
  renderImageAnalysisControls();
  configureImageTranslation();
  updateControls();
  if (
    reportRevocation &&
    previous === 'granted' &&
    imageCaptureAccess === 'missing' &&
    preferences.imageTranslationEnabled
  ) {
    setStatus(
      preferences.disabledImageReadingMethodIds.includes(
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
  if (permissionInFlight) {
    syncPreferenceControls();
    return;
  }
  permissionInFlight = true;
  renderImageAnalysisControls();
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
            () => freshPreferences ?? preferences,
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
        preferences.imageTranslationEnabled
          ? preferences.disabledImageReadingMethodIds.includes(
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
    permissionInFlight = false;
    await refreshImageCaptureAccess();
    syncPreferenceControls();
    updateControls();
  }
}

async function acceptAuthorizedTab(request: AuthorizedTabRequest): Promise<void> {
  const authorized = request.identity;
  const lockedIdentity = followedPageIdentity ?? detachedIdentityHint;
  if (
    isDetachedWindow &&
    lockedIdentity &&
    preferences.popoutTabMode === 'locked' &&
    (authorized.windowId !== lockedIdentity.windowId ||
      authorized.tabId !== lockedIdentity.tabId)
  ) return;
  if (request.launchStamp) {
    if (!isNewerCompanionLaunchStamp(
      latestToolbarLaunchStamp,
      request.launchStamp,
    )) return;
    latestToolbarLaunchStamp = request.launchStamp;
  }
  const requestId = ++identityRequestId;
  if (!isDetachedWindow) {
    if (panelWindowId === undefined) await loadPanelWindowId();
    if (
      requestId !== identityRequestId ||
      panelWindowId === undefined ||
      authorized.windowId !== panelWindowId
    ) return;
  }
  if (requestId !== identityRequestId) return;
  clearNavigationTimer();
  followedPageIdentity = authorized;
  queueCapture({ identity: authorized, reason: 'authorized' });
}

async function followMovedLockedSourceTab(
  tabId: number,
  windowId: number,
  requestId: number,
): Promise<void> {
  try {
    const identity = identityFromTab(
      await browser.tabs.get(tabId),
      undefined,
      false,
    );
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'locked' ||
      identity.tabId !== tabId ||
      identity.windowId !== windowId
    ) return;
    detachedSourceWindowId = windowId;
    queueCapture({ identity, reason: 'navigation' });
  } catch (error) {
    if (requestId !== identityRequestId) return;
    invalidateCompanion(
      `${readPageError(error)} The locked source tab could not be followed after it moved windows.`,
    );
  }
}

async function followReplacedSourceTab(
  tabId: number,
  requestId: number,
): Promise<void> {
  if (requestId !== identityRequestId) return;
  if (isDetachedWindow && preferences.popoutTabMode === 'active') {
    activeFollowRequestId = requestId;
  }
  try {
    const identity = identityFromTab(
      await browser.tabs.get(tabId),
      undefined,
      requiresActiveSourceTab(),
    );
    if (requestId !== identityRequestId) return;
    detachedSourceWindowId = identity.windowId;
    queueCapture({ identity, reason: 'navigation' });
  } catch (error) {
    if (requestId !== identityRequestId) return;
    invalidateCompanion(
      `${readPageError(error)} Chrome replaced the source tab, but its new page could not be followed.`,
    );
  } finally {
    finishActiveFollowRequest(requestId);
  }
}

async function refreshFollowedPage(reason: CaptureRequest['reason']): Promise<void> {
  const requestId = ++identityRequestId;
  try {
    const identity = followedPageIdentity
      ? await readCurrentFollowedIdentity(followedPageIdentity)
      : await readActivePageIdentity();
    if (requestId !== identityRequestId) return;
    followedPageIdentity = identity;
    queueCapture({ identity, reason });
  } catch (error) {
    if (requestId !== identityRequestId) return;
    const message = readPageError(error);
    if (!snapshot) renderErrorState(message);
    setStatus(message, 'error');
    updateControls();
  }
}

async function followCurrentActiveSourceTab(): Promise<void> {
  if (!detachedIdentityHint || preferences.popoutTabMode !== 'active') return;
  const requestId = ++identityRequestId;
  activeFollowRequestId = requestId;
  clearNavigationTimer();
  try {
    const lastFocused = await browser.windows.getLastFocused({
      windowTypes: ['normal'],
    });
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    const sourceWindowId =
      lastFocused.id ??
      followedPageIdentity?.windowId ??
      detachedSourceWindowId ??
      detachedIdentityHint.windowId;
    const [tab] = await browser.tabs.query({
      active: true,
      windowId: sourceWindowId,
    });
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    if (tab?.id === undefined) {
      invalidateCompanion('The source browser window has no active readable tab.');
      return;
    }
    await followActivatedSourceTab(tab.id, sourceWindowId, tab, requestId);
  } catch (error) {
    if (requestId !== identityRequestId) return;
    invalidateCompanion(
      `${readPageError(error)} Active-tab following needs page access for each newly selected site.`,
    );
  } finally {
    finishActiveFollowRequest(requestId);
  }
}

async function followFocusedBrowserWindow(
  windowId: number,
  requestId: number,
  missingTabMessage?: string,
): Promise<void> {
  if (
    requestId !== identityRequestId ||
    preferences.popoutTabMode !== 'active'
  ) {
    // tabs.onRemoved marks its request before the microtask that reaches
    // here. A request superseded in that gap must still release the marker,
    // or updates for the followed tab stay ignored until the next follow.
    finishActiveFollowRequest(requestId);
    return;
  }
  activeFollowRequestId = requestId;
  try {
    const sourceWindow = await browser.windows.get(windowId);
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    if (!isFocusedNormalBrowserWindow(sourceWindow)) return;
    const [tab] = await browser.tabs.query({ active: true, windowId });
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    detachedSourceWindowId = windowId;
    if (tab?.id !== undefined) {
      await followActivatedSourceTab(tab.id, windowId, tab, requestId);
    } else if (missingTabMessage && requestId === identityRequestId) {
      invalidateCompanion(missingTabMessage);
    }
  } catch {
    if (missingTabMessage && requestId === identityRequestId) {
      invalidateCompanion(missingTabMessage);
    }
    // A closing or restricted browser window is not a new source candidate.
  } finally {
    finishActiveFollowRequest(requestId);
  }
}

async function followActivatedSourceTab(
  tabId: number,
  windowId: number,
  knownTab?: Browser.tabs.Tab,
  existingRequestId?: number,
): Promise<void> {
  if (
    !shouldFollowActivatedTab(
      isDetachedWindow,
      preferences.popoutTabMode,
      panelWindowId,
      windowId,
    )
  ) return;

  const requestId = existingRequestId ?? ++identityRequestId;
  if (requestId !== identityRequestId) return;
  activeFollowRequestId = requestId;
  // A pending navigation refresh stays armed (see windows.onFocusChanged);
  // queueCapture clears it once a different page is followed.
  try {
    const sourceWindow = await browser.windows.get(windowId);
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    if (!isFocusedNormalBrowserWindow(sourceWindow)) return;
    const tab = knownTab ?? await browser.tabs.get(tabId);
    const identity = identityFromTab(tab, undefined, true);
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    detachedSourceWindowId = windowId;
    if (sameCompanionSourcePage(
      followedPageIdentity,
      identity,
      normalizedPageUrl,
    )) {
      // Already following this page. If the rendered replica is still an
      // older page of the same tab (a navigation whose refresh never ran),
      // rebuild now instead of leaving the stale mirror frozen (review M1).
      if (shouldRebuildStaleFollowedReplica({
        captureInFlight,
        navigationRefreshPending: navigationTimer !== undefined,
        tabStatus: tab.status,
        captured: capturedPageIdentity,
        identity,
        normalizeUrl: normalizedPageUrl,
      })) {
        queueCapture({ identity, reason: 'navigation' });
      }
      return;
    }
    queueCapture({ identity, reason: 'navigation' });
  } catch (error) {
    if (requestId !== identityRequestId) return;
    invalidateCompanion(
      `${readPageError(error)} Active-tab following needs page access for each newly selected site.`,
    );
  } finally {
    finishActiveFollowRequest(requestId);
  }
}

function finishActiveFollowRequest(requestId: number): void {
  if (activeFollowRequestId === requestId) activeFollowRequestId = undefined;
}

function queueCapture(request: CaptureRequest): void {
  clearNavigationTimer();
  navigationRefreshGate.consumeCapture(
    navigationPageScopeKey(request.identity),
    navigationPageIdentityKey(request.identity),
  );
  const previousIdentity = capturedPageIdentity ?? followedPageIdentity;
  const samePage = sameCompanionSourcePage(
    previousIdentity,
    request.identity,
    normalizedPageUrl,
  );
  if (!samePage) isolatedReplicaFailureRecoveryGate.reset();
  if (shouldResetReplicaScrollForCapture(request.reason, samePage)) {
    lastSourceScroll = undefined;
    visibleReplayHost.resetSourceScroll();
  }
  const retainTranslationIntent =
    samePage &&
    (request.reason === 'manual' ||
      request.reason === 'desynchronized' ||
      request.reason === 'preference');
  if (!retainTranslationIntent) {
    replicaTranslationCoordinator.selectPair(undefined);
    translationDesired = false;
    translationComplete = false;
    availabilityCheckedForPair = undefined;
    quickComposer.invalidate();
  }
  activeAbortController?.abort();
  replicaShadowAbortController?.abort();
  imageTranslationController.setTopPageOrigin(request.identity.url);
  imageTranslationController.releaseReplica();
  availabilityRequestId += 1;
  followedPageIdentity = request.identity;
  if (!snapshot && !visibleReplayHost.hasCommittedReplica) renderLoadingState();
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
  captureInFlight = true;
  updateControls();
  try {
    await capturePage(work);
  } finally {
    const next = captureCoordinator.finish(work.generation);
    if (next) {
      void runCaptureWork(next);
      return;
    }
    captureInFlight = false;
    updateControls();
  }
}

async function capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
  const identity = work.value.identity;
  try {
    const sameCapturedPage = Boolean(
      capturedPageIdentity &&
        capturedPageIdentity.tabId === identity.tabId &&
        capturedPageIdentity.windowId === identity.windowId &&
        normalizedPageUrl(capturedPageIdentity.url) ===
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
      snapshot = undefined;
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
    assertSourceTabIsCurrent(currentTab, identity, requiresActiveSourceTab());
    if (!captureCoordinator.isCurrent(work.generation)) return;

    translationComplete = false;
    captureNotes.hidden = true;
    captureNotes.textContent = '';
    await runReplicaEngineCheckpoint(work, identity, documentId);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    snapshot = replicaSurfaceRouter.snapshot();
    if (!snapshot) {
      throw new PageAccessError('The isolated replica did not commit a current document.');
    }
    // Only published replica state is captured state. Keeping the candidate
    // identity in followedPageIdentity lets a failed replacement retain an
    // accurate last-good identity instead of pretending the failed page won.
    // A history/replaceState URL can arrive while this same document is
    // staging. Preserve that newer identity instead of writing the capture's
    // older request URL back over it after the replica commits.
    const committedIdentity = followedPageIdentity && sameCompanionSourcePage(
        followedPageIdentity,
        identity,
        normalizedPageUrl,
      )
      ? followedPageIdentity
      : identity;
    capturedPageIdentity = committedIdentity;
    followedPageIdentity = committedIdentity;
    await resolveSelectedSourceLanguage(currentReplicaLanguageContext());

    if (isLiveSourceOnlyMode()) {
      availability = 'unavailable';
      availabilityCheckedForPair = undefined;
      setStatus(
        'Live source only is active. The isolated mirror keeps updating without text or image translation.',
        'success',
      );
      return;
    }

    if (currentTranslationFieldCount() === 0) {
      availability = 'unavailable';
      availabilityCheckedForPair = undefined;
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
    snapshot = replicaSurfaceRouter.snapshot();
    if (!snapshot && !visibleReplayHost.hasCommittedReplica) {
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
  replicaShadowAbortController?.abort();
  const abortController = new AbortController();
  replicaShadowAbortController = abortController;
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
        followedPageIdentity,
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
    const selectedSnapshot = snapshot;
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
      replicaShadowAbortController === abortController &&
      !visibleReplayHost.hasCommittedReplica
    ) {
      replicaShadowAbortController = undefined;
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
    resolvedSourceLanguageOrigin,
    resolvedImageLanguageDocument !== undefined &&
      currentReplicaDocumentMatches(resolvedImageLanguageDocument),
  )) {
    clearAutoImageLanguageResolution();
  }
  const resolutionRevision = ++sourceLanguageResolutionRevision;
  if (!snapshot) {
    autoLanguageEvidencePrecedence.invalidate();
    pageLanguageResolutionPending = false;
    resolvedSourceLanguage = undefined;
    resolvedSourceLanguageOrigin = undefined;
    resolvedImageLanguageConfigurationKey = undefined;
    resolvedImageLanguageDocument = undefined;
    quickComposer.syncPanel();
    configureImageTranslation();
    return true;
  }
  const requestedSnapshot = snapshot;
  const requestedPreference = preferences.sourceLanguage;
  const previousLanguage = resolvedSourceLanguage;
  const previousOrigin = resolvedSourceLanguageOrigin;
  const previousImageConfigurationKey = resolvedImageLanguageConfigurationKey;
  const previousImageDocument = resolvedImageLanguageDocument;
  if (requestedPreference !== 'auto') autoLanguageEvidencePrecedence.invalidate();
  autoLanguageEvidencePrecedence.beginPageResolution(resolutionRevision);
  pageLanguageResolutionPending =
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
    resolutionRevision !== sourceLanguageResolutionRevision ||
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
    preferences.sourceLanguage !== requestedPreference
  ) {
    autoLanguageEvidencePrecedence.cancelPageResolution(resolutionRevision);
    pageLanguageResolutionPending =
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
  resolvedSourceLanguage =
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
    resolvedSourceLanguageOrigin = unchangedExplicitImageLanguage
      ? 'image'
      : requestedPreference === 'auto'
        ? 'page'
        : 'explicit';
    resolvedImageLanguageConfigurationKey = unchangedExplicitImageLanguage
      ? previousImageConfigurationKey
      : undefined;
    resolvedImageLanguageDocument = unchangedExplicitImageLanguage
      ? previousImageDocument
      : undefined;
  } else if (resolvedSourceLanguage) {
    resolvedSourceLanguageOrigin = previousOrigin;
    resolvedImageLanguageConfigurationKey = previousImageConfigurationKey;
    resolvedImageLanguageDocument = previousOrigin === 'image'
      ? previousImageDocument
      : undefined;
  } else {
    resolvedSourceLanguageOrigin = undefined;
    resolvedImageLanguageConfigurationKey = undefined;
    resolvedImageLanguageDocument = undefined;
  }
  const pendingImageEvidence =
    autoLanguageEvidencePrecedence.settlePageResolution(
      resolutionRevision,
      Boolean(resolvedSourceLanguage),
    );
  pageLanguageResolutionPending =
    autoLanguageEvidencePrecedence.pageResolutionPending;
  if (pendingImageEvidence &&
      pendingAutoImageLanguageEvidenceIsCurrent(pendingImageEvidence)) {
    commitAutoDetectedImageLanguage(pendingImageEvidence);
    return true;
  }
  detectedLanguageElement.textContent = resolvedSourceLanguage
    ? requestedPreference === 'auto'
      ? detected.language
        ? `Detected ${languageName(resolvedSourceLanguage)} from ${detected.source === 'html' ? 'the page language' : 'visible page text'}.`
        : `Using the previously detected ${languageName(resolvedSourceLanguage)} source language.`
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
    preferences.sourceLanguage !== 'auto' ||
    resolvedSourceLanguage ||
    !pendingAutoImageLanguageEvidenceIsCurrent(proposal)
  ) return;
  const resolutionRevision = ++sourceLanguageResolutionRevision;
  resolvedSourceLanguage = proposal.language;
  resolvedSourceLanguageOrigin = 'image';
  resolvedImageLanguageConfigurationKey = proposal.configurationKey;
  resolvedImageLanguageDocument = proposal.document;
  availabilityRequestId += 1;
  availabilityCheckedForPair = undefined;
  translationComplete = false;
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
    void reconcileAutoDetectedImageLanguage(
      proposal.language,
      resolutionRevision,
    );
  });
}

function pendingAutoImageLanguageEvidenceIsCurrent(
  proposal: PendingAutoImageLanguageEvidence,
): boolean {
  return (
    proposal.configurationKey === currentAutoImageLanguageConfigurationKey() &&
    currentReplicaDocumentMatches(proposal.document) &&
    proposal.replayLease === snapshot?.replayLease &&
    proposal.identity === capturedPageIdentity &&
    captureCoordinator.isCurrent(proposal.generation)
  );
}

function handleAutoImageLanguageInvalidated(
  document: ReplicaSourceDocumentIdentity,
): void {
  if (
    resolvedSourceLanguageOrigin !== 'image' ||
    !resolvedImageLanguageDocument ||
    !sameSourceDocument(resolvedImageLanguageDocument, document) ||
    !currentReplicaDocumentMatches(document)
  ) return;
  if (preferences.sourceLanguage !== 'auto') {
    // Explicit selection remains authoritative and keeps the effective pair
    // running, but the dormant image contributor must not be resurrected if
    // the user later returns to Auto.
    sourceLanguageResolutionRevision += 1;
    autoLanguageEvidencePrecedence.invalidate();
    pageLanguageResolutionPending = false;
    resolvedSourceLanguageOrigin = 'explicit';
    resolvedImageLanguageConfigurationKey = undefined;
    resolvedImageLanguageDocument = undefined;
    return;
  }
  clearAutoImageLanguageResolution();
  queueMicrotask(() => {
    if (
      preferences.sourceLanguage !== 'auto' ||
      !currentReplicaDocumentMatches(document)
    ) return;
    configureImageTranslation();
    void applyLanguagePreferences(false);
  });
}

async function reconcileAutoDetectedImageLanguage(
  language: SupportedLanguage,
  resolutionRevision: number,
): Promise<void> {
  if (
    resolutionRevision !== sourceLanguageResolutionRevision ||
    preferences.sourceLanguage !== 'auto' ||
    resolvedSourceLanguage !== language ||
    !resolvedImageLanguageDocument ||
    !currentReplicaDocumentMatches(resolvedImageLanguageDocument)
  ) return;
  const generation = captureCoordinator.generation;
  const identity = capturedPageIdentity;
  const requestedSnapshot = snapshot;
  const pair = selectedPair();
  if (!isLiveSourceOnlyMode()) {
    replicaTranslationCoordinator.selectPair(pair);
  }
  configureImageTranslation();
  if (
    resolutionRevision !== sourceLanguageResolutionRevision ||
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
    resolutionRevision !== sourceLanguageResolutionRevision ||
    preferences.sourceLanguage !== 'auto' ||
    resolvedSourceLanguage !== language ||
    !resolvedImageLanguageDocument ||
    !currentReplicaDocumentMatches(resolvedImageLanguageDocument) ||
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
    capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation) ||
    !isCurrentTranslationPair(pair)
  ) return;
  await maybeTranslateAutomatically(generation, identity.url);
}

function mirrorLanguageSample(): string {
  return buildBoundedLanguageSample(
    replicaRecordSources(snapshot?.records ?? []),
  );
}

function currentTranslationFieldCount(): number {
  return snapshot?.records.some(
    ({ source }) => source.trim().length > 0,
  ) ? 1 : 0;
}

async function reconcileReplicaTranslationAfterCommit(
  commit: ReplicaSourceCommit,
  refreshVersion: number,
  refreshDetectedLanguage: boolean,
  prepareForNewText: boolean,
): Promise<void> {
  if (isLiveSourceOnlyMode()) return;
  const generation = commit.document.generation;
  const identity = capturedPageIdentity;
  if (
    !identity ||
    !snapshot ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  const previousPair = selectedPair();
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
    refreshVersion !== replicaLanguageRefreshVersion ||
    !captureCoordinator.isCurrent(generation) ||
    capturedPageIdentity !== identity ||
    (preferences.sourceLanguage === 'auto') !== refreshDetectedLanguage
  ) return;
  const nextPair = selectedPair();
  const pairChanged = !sameTranslationPair(previousPair, nextPair);
  if (pairChanged) {
    activeAbortController?.abort();
    translationComplete = false;
    availabilityCheckedForPair = undefined;
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
      availabilityCheckedForPair !== expectedAvailabilityKey);
  if (!pairChanged && !needsPreparation) return;
  await checkAvailability(generation);
  if (
    refreshVersion === replicaLanguageRefreshVersion &&
    captureCoordinator.isCurrent(generation) &&
    capturedPageIdentity === identity &&
    sameTranslationPair(nextPair, selectedPair())
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
  const previousPair = selectedPair();
  if (!isLiveSourceOnlyMode()) translationDesired = true;
  const saved = await commitViewPreferencePatch({ sourceLanguage, targetLanguage });
  if (!saved) return;
  await applyLanguagePreferences(true, previousPair);
}

async function applyLanguagePreferences(
  fromUserAction: boolean,
  previousPair = selectedPair(),
): Promise<void> {
  if (!snapshot) return;
  await resolveSelectedSourceLanguage(currentReplicaLanguageContext());
  if (isLiveSourceOnlyMode()) {
    replicaTranslationCoordinator.selectPair(undefined);
    availability = 'unavailable';
    availabilityCheckedForPair = undefined;
    setStatus(
      'Live source only is active. Language choices are saved for translated mode.',
      'success',
    );
    updateControls();
    return;
  }
  const nextPair = selectedPair();
  const effectivePairChanged = !sameTranslationPair(previousPair, nextPair);
  if (effectivePairChanged) {
    activeAbortController?.abort();
    quickComposer.invalidate();
    translationComplete = false;
    availabilityCheckedForPair = undefined;
  }
  replicaTranslationCoordinator.selectPair(nextPair);
  if (!effectivePairChanged && translationComplete) {
    updateControls();
    return;
  }
  await checkAvailability(captureCoordinator.generation);
  if (!fromUserAction) {
    // A change saved by another companion window, or a re-resolved automatic
    // language, re-establishes availability here but only resumes a
    // translation this window already wanted; it records no new intent.
    await maybeTranslateAutomatically(
      captureCoordinator.generation,
      capturedPageIdentity?.url ?? '',
    );
    return;
  }
  if (availability === 'available') {
    await startTranslation(false, captureCoordinator.generation);
  } else if (availability === 'downloadable' || availability === 'downloading') {
    setStatus('This language pair needs its on-device pack. Choose Translate once to prepare it.', 'warning');
  }
}

async function checkAvailability(generation: number): Promise<void> {
  const requestId = ++availabilityRequestId;
  const requestedSnapshot = snapshot;
  const pair = selectedPair();
  if (isLiveSourceOnlyMode()) {
    replicaTranslationCoordinator.selectPair(undefined);
    availability = 'unavailable';
    availabilityCheckedForPair = undefined;
    updateControls();
    return;
  }
  replicaTranslationCoordinator.selectPair(pair);
  if (
    !requestedSnapshot ||
    !pair ||
    currentTranslationFieldCount() === 0
  ) {
    availability = 'unavailable';
    availabilityCheckedForPair = undefined;
    if (!pair && requestedSnapshot) {
      setStatus('Choose a From language because automatic detection was inconclusive.', 'warning');
    }
    updateControls();
    return;
  }
  const checkedPairKey = availabilityPairKey(pair, generation);
  // The pair is recorded as checked only once a result passes the currency
  // guard. Recording it before the await let a superseded request leave the
  // pair marked as checked while availability stayed 'unavailable', which
  // disabled Translate and skipped automatic translation for that generation
  // because reconcileReplicaTranslationAfterCommit saw nothing to prepare.
  availabilityCheckedForPair = undefined;
  availability = 'unavailable';
  updateControls();
  if (pair.sourceLanguage === pair.targetLanguage) {
    availabilityCheckedForPair = checkedPairKey;
    availability = 'available';
    translationComplete = true;
    setStatus('The source and target languages match, so the original text is unchanged.', 'success');
    updateControls();
    return;
  }
  try {
    const next = await provider.availability(pair);
    if (!isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair, generation)) return;
    availabilityCheckedForPair = checkedPairKey;
    availability = next;
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
    if (!isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair, generation)) return;
    availabilityCheckedForPair = checkedPairKey;
    availability = 'unavailable';
    setStatus(readableError(error), 'error');
  } finally {
    if (isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair, generation)) updateControls();
  }
}

async function maybeTranslateAutomatically(
  generation: number,
  pageUrl: string,
): Promise<void> {
  const action = replicaViewTranslationAction(
    preferences.replicaViewMode,
    isAutoTranslationEnabled(preferences, pageUrl),
    translationDesired,
    availability,
  );
  if (action === 'translate') {
    await startTranslation(true, generation);
  } else if (action === 'needs-user-action') {
    setStatus('Automatic translation is ready, but this pair needs one Translate click to prepare its local pack.', 'warning');
  }
}

function startTranslation(automatic: boolean, generation: number): Promise<void> {
  if (isLiveSourceOnlyMode()) return Promise.resolve();
  const requestedKey = currentTranslationTaskKey(generation);
  if (activeTranslationTask) {
    if (activeTranslationKey === requestedKey) return activeTranslationTask;
    activeAbortController?.abort();
    const previousTask = activeTranslationTask;
    return previousTask.catch(() => undefined).then(async () => {
      if (
        !captureCoordinator.isCurrent(generation) ||
        currentTranslationTaskKey(generation) !== requestedKey
      ) return;
      await startTranslation(automatic, generation);
    });
  }
  const task = runTranslation(automatic, generation);
  activeTranslationTask = task;
  activeTranslationKey = requestedKey;
  void task.then(() => {
    if (activeTranslationTask === task) {
      activeTranslationTask = undefined;
      activeTranslationKey = undefined;
    }
  }, () => {
    if (activeTranslationTask === task) {
      activeTranslationTask = undefined;
      activeTranslationKey = undefined;
    }
  });
  return task;
}

async function runTranslation(automatic: boolean, generation: number): Promise<void> {
  const pair = selectedPair();
  const requestedSnapshot = snapshot;
  const identity = capturedPageIdentity;
  if (
    !pair ||
    !requestedSnapshot ||
    !identity ||
    isLiveSourceOnlyMode() ||
    translationInFlight ||
    availability === 'unavailable' ||
    (automatic && availability !== 'available')
  ) return;
  if (pair.sourceLanguage === pair.targetLanguage) {
    replicaTranslationCoordinator.selectPair(pair);
    translationComplete = true;
    updateControls();
    return;
  }

  const abortController = new AbortController();
  activeAbortController = abortController;
  translationInFlight = true;
  configureImageTranslation();
  translationDesired = true;
  translationComplete = false;
  toolbarStatus.showProgress('Preparing Chrome\'s on-device language model…', 0, 1);
  updateControls();
  try {
    const tab = await browser.tabs.get(identity.tabId);
    assertSourceTabIsCurrent(tab, identity, requiresActiveSourceTab());
    if (
      !captureCoordinator.isCurrent(generation) ||
      !currentReplicaSnapshotMatches(requestedSnapshot) ||
      !isCurrentTranslationPair(pair) ||
      isLiveSourceOnlyMode()
    ) return;
    availability = 'available';
    availabilityCheckedForPair = availabilityPairKey(pair, generation);
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
      !isCurrentTranslationPair(pair) ||
      isLiveSourceOnlyMode()
    ) return;
    translationComplete =
      result.total > 0 &&
      replicaTranslationCoordinator.isResultCurrent(result) &&
      isCompleteReplicaTranslationResult(result);
    uiLocalizer.retryAfterPagePairPrepared();
    setStatus(
      translationComplete
        ? automatic
          ? 'Automatic translation is complete and live updates will translate as they arrive.'
          : 'Translation is complete and live updates will translate as they arrive.'
        : describePartialReplicaTranslation(result, 'Translation remains partial'),
      translationComplete ? 'success' : 'warning',
    );
  } catch (error) {
    if (isAbortError(error) || abortController.signal.aborted) {
      if (
        !isLiveSourceOnlyMode() &&
        captureCoordinator.isCurrent(generation) &&
        currentReplicaSnapshotMatches(requestedSnapshot) &&
        isCurrentTranslationPair(pair)
      ) {
        setStatus('Translation cancelled. Existing translated text was kept.', 'warning');
      }
    } else if (!isLiveSourceOnlyMode()) {
      setStatus(readableError(error), 'error');
    }
  } finally {
    logTranslationCache('page', translationMemory);
    if (activeAbortController === abortController) activeAbortController = undefined;
    translationInFlight = false;
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

function sameTranslationPair(
  left: TranslationPair | undefined,
  right: TranslationPair | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.sourceLanguage === right.sourceLanguage &&
      left.targetLanguage === right.targetLanguage,
  ) || (!left && !right);
}

function updateMirrorLayout(): void {
  visibleReplayHost.updateLayout({
    displayMode: preferences.displayMode,
    zoomPercent: preferences.zoomPercent,
  });
  imageTranslationController.refreshOverlays();
  if (
    visibleReplayHost.previewVisible &&
    preferences.syncScroll &&
    lastSourceScroll
  ) {
    visibleReplayHost.followSourceScroll(lastSourceScroll);
  }
}

function setCompanionOverlay(next?: CompanionOverlay): void {
  const previous = openCompanionOverlay;
  openCompanionOverlay = next;
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
 * One optimistic ledger entry covers the whole drag, so a committed snapshot
 * arriving mid-drag keeps the slider where the user left it.
 */
function setZoom(value: number): void {
  const patch: CompanionViewSettingsPatch = {
    displayMode: 'custom',
    zoomPercent: clampZoomPercent(value),
  };
  if (pendingZoomPatch) {
    viewPreferencePatchLedger.settle(pendingZoomPatch.requestId);
  }
  const pending = viewPreferencePatchLedger.begin(preferences, patch);
  pendingZoomPatch = { requestId: pending.requestId, patch };
  preferences = pending.preferences;
  zoomInput.value = String(preferences.zoomPercent);
  zoomOutput.value = `${preferences.zoomPercent}%`;
  zoomInput.disabled = false;
  displayModeSelect.value = preferences.displayMode;
  syncToolbarPreferenceControls();
  updateMirrorLayout();
  if (zoomCommitTimer !== undefined) clearTimeout(zoomCommitTimer);
  zoomCommitTimer = setTimeout(commitPendingZoom, ZOOM_COMMIT_DEBOUNCE_MS);
}

function commitPendingZoom(): void {
  if (zoomCommitTimer !== undefined) clearTimeout(zoomCommitTimer);
  zoomCommitTimer = undefined;
  const pending = pendingZoomPatch;
  if (!pending) return;
  pendingZoomPatch = undefined;
  // commitViewPreferencePatch opens its own ledger entry synchronously, so
  // the drag's entry can be released without a gap in the projection.
  viewPreferencePatchLedger.settle(pending.requestId);
  void commitViewPreferencePatch(pending.patch);
}

async function changePopoutTabMode(popoutTabMode: PopoutTabMode): Promise<void> {
  const saved = await commitViewPreferencePatch({ popoutTabMode });
  if (!saved || preferences.popoutTabMode !== popoutTabMode) return;
  if (isDetachedWindow && popoutTabMode === 'active') {
    await followCurrentActiveSourceTab();
  }
}

async function changeReplicaFidelityPolicy(
  replicaFidelityPolicy: SelectableReplicaFidelityPolicy,
): Promise<void> {
  if (
    replicaFidelityCommitInFlight ||
    replicaFidelityPolicy === preferences.replicaFidelityPolicy
  ) return;
  replicaFidelityCommitInFlight = true;
  updateControls();
  try {
    const saved = await commitViewPreferencePatch({ replicaFidelityPolicy });
    if (
      !saved ||
      preferences.replicaFidelityPolicy !== replicaFidelityPolicy
    ) return;
    isolatedReplicaFailureRecoveryGate.reset();
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'preference' });
  } finally {
    replicaFidelityCommitInFlight = false;
    updateControls();
  }
}

async function changeReplicaViewMode(
  replicaViewMode: ReplicaViewMode,
): Promise<void> {
  if (replicaViewMode === preferences.replicaViewMode) return;
  const previousMode = preferences.replicaViewMode;
  // commitViewPreferencePatch applies the validated preference optimistically
  // before its first await, so projection gates close immediately.
  const save = commitViewPreferencePatch({ replicaViewMode });
  applyReplicaViewMode(previousMode, false);
  await save;
  if (preferences.replicaViewMode !== replicaViewMode) {
    applyReplicaViewMode(replicaViewMode);
    return;
  }
  if (replicaViewMode === 'translated' && !isLiveSourceOnlyMode()) {
    await resumeTranslatedReplicaMode();
  }
}

function applyReplicaViewMode(
  previousMode: ReplicaViewMode,
  resumeTranslated = true,
): void {
  if (previousMode === preferences.replicaViewMode) return;
  availabilityRequestId += 1;
  activeAbortController?.abort();
  replicaTranslationCoordinator.selectPair(undefined);
  translationComplete = false;
  availabilityCheckedForPair = undefined;
  configureImageTranslation();
  if (isLiveSourceOnlyMode()) {
    availability = 'unavailable';
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
  const interrupted = activeTranslationTask;
  if (interrupted) await interrupted.catch(() => undefined);
  const identity = capturedPageIdentity;
  const generation = captureCoordinator.generation;
  if (isLiveSourceOnlyMode() || !snapshot || !identity) return;
  const resolved = await resolveSelectedSourceLanguage(
    currentReplicaLanguageContext(),
  );
  const requestedSnapshot = snapshot;
  if (
    !resolved ||
    isLiveSourceOnlyMode() ||
    !requestedSnapshot ||
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
    capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  const pair = selectedPair();
  replicaTranslationCoordinator.selectPair(pair);
  await checkAvailability(generation);
  if (
    isLiveSourceOnlyMode() ||
    !pair ||
    !isCurrentTranslationPair(pair) ||
    !currentReplicaSnapshotMatches(requestedSnapshot) ||
    capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  await maybeTranslateAutomatically(generation, identity.url);
}

function currentReplicaLanguageContext(): LiveLanguageContext | undefined {
  const current = snapshot;
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

function isLiveSourceOnlyMode(): boolean {
  return preferences.replicaViewMode === 'source-only';
}

function syncPreferenceControls(): void {
  const pageUrl = followedPageIdentity?.url ?? capturedPageIdentity?.url;
  sourceSelect.value = preferences.sourceLanguage;
  targetSelect.value = preferences.targetLanguage;
  autoTranslateSelect.value = autoTranslationModeForPage(preferences, pageUrl);
  displayModeSelect.value = preferences.displayMode;
  textLayoutSelect.value = preferences.textLayoutMode;
  replicaFidelityPolicySelect.value = preferences.replicaFidelityPolicy;
  replicaViewModeSelect.value = preferences.replicaViewMode;
  launchBehaviorSelect.value = preferences.launchBehavior;
  popoutTabModeSelect.value = preferences.popoutTabMode;
  syncScrollInput.checked = preferences.syncScroll;
  zoomInput.value = String(preferences.zoomPercent);
  zoomOutput.value = `${preferences.zoomPercent}%`;
  zoomInput.disabled = preferences.displayMode !== 'custom';
  syncToolbarPreferenceControls();
  quickComposer.syncPanel();
  renderReadScopeControls();
  renderImageAnalysisControls();
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
    preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION;
  const cleanupPending = preferences.resetCleanupPendingRevision > 0;
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
    ? preferences.replicaReadScope
    : replicaReadScopeForProfile('page-only');
  readScopeProfile.value = deriveReplicaReadScopeProfile(configuredScope);
  setupReadProfile.value = deriveReplicaReadScopeProfile(setupReadScopeDraft);
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
    setupReadScopeDraft,
    (key, checked) => {
      setupReadScopeDraft = normalizeReadScopeToggle(
        setupReadScopeDraft,
        key,
        checked,
      );
      renderReadScopeControls();
    },
  );
  setupResetCleanup.hidden = !cleanupPending;
  retrySetupResetCleanupButton.disabled = resetInFlight;
  if (cleanupPending && !setupCleanupWasPending && !resetInFlight) {
    setupResetCleanupStatus.textContent =
      'Core settings are already safe, but optional permission or runtime cleanup is still pending.';
  }
  if (
    cleanupPending &&
    !setupComplete &&
    (!setupDialogWasOpen || !setupCleanupWasPending)
  ) {
    retrySetupResetCleanupButton.focus();
  } else if (
    !cleanupPending &&
    setupCleanupWasPending &&
    readScopeSetup.open &&
    document.activeElement === retrySetupResetCleanupButton
  ) {
    setupReadProfile.focus();
  }
  setupCleanupWasPending = cleanupPending;
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
  const autoDetect = preferences.sourceLanguage === 'auto';
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

  const sizeLabel = preferences.displayMode === 'fit'
    ? 'Fit'
    : preferences.displayMode === 'actual'
      ? '1:1'
      : `${preferences.zoomPercent}%`;
  if (preferences.displayMode === 'custom') {
    delete toolbarSizeLabel.dataset.uiLabel;
    toolbarSizeLabel.textContent = sizeLabel;
  } else {
    setUiText(toolbarSizeLabel, sizeLabel);
  }
  const nextSize = preferences.displayMode === 'fit' ? '1:1 size' : 'fit width';
  toolbarSizeToggleButton.setAttribute(
    'aria-label',
    `Mirror size: ${sizeLabel}. Switch to ${nextSize}`,
  );
  toolbarSizeToggleButton.title = `Mirror size: ${sizeLabel}. Click for ${nextSize}.`;

  toolbarOcrToggleButton.setAttribute(
    'aria-pressed',
    String(preferences.imageTranslationEnabled),
  );
  setUiText(
    toolbarOcrLabel,
    preferences.imageTranslationEnabled ? 'OCR On' : 'OCR Off',
  );
  toolbarOcrToggleButton.title = preferences.imageTranslationEnabled
    ? imageCaptureAccess === 'granted'
      ? 'Image text translation is on. Click to turn it off.'
      : enabledUsablePixelOcrProviderOrder().length === 0
        ? preferences.disabledImageReadingMethodIds.includes(
            ACCESSIBILITY_TEXT_METHOD_ID,
          )
          ? 'Image translation has no enabled reading method. Click to turn it off.'
          : 'Accessibility image text is on. Click to turn it off.'
      : preferences.disabledImageReadingMethodIds.includes(
          ACCESSIBILITY_TEXT_METHOD_ID,
        )
        ? 'Image translation is saved but pixel OCR needs image access. Click to grant access.'
        : 'Accessibility image text is on; pixel OCR is paused. Click to grant image access.'
    : 'Image text translation is off. Click to turn it on.';

  const followsActive = isDetachedWindow && preferences.popoutTabMode === 'active';
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
    preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
    preferences.disabledImageReadingMethodIds.includes(
      ACCESSIBILITY_TEXT_METHOD_ID,
    )
      ? preferences.disabledImageReadingMethodIds
      : [
          ACCESSIBILITY_TEXT_METHOD_ID,
          ...preferences.disabledImageReadingMethodIds,
        ];
  const enabledMethodIds = new Set(
    preferences.imageReadingMethodOrder.filter((method) =>
      !disabledMethodIds.includes(method),
    ),
  );
  const enabledProviderOrder = effectiveCompiledProviderOrder(
    enabledOcrProviderOrder(
      preferences.imageReadingMethodOrder,
      disabledMethodIds,
    ),
    preferences.disabledImageTextProviderIds,
  );
  const usableProviderOrder = runtimeReadyOcrProviderOrder(
    enabledProviderOrder,
    ocrProviderRuntimeStatuses,
  );
  const routedProviderOrder = imageCaptureAccess === 'granted'
    ? usableProviderOrder
    : [];
  const nextAutoLanguageConfigurationKey = autoImageLanguageConfigurationKey({
    providerOrder: routedProviderOrder,
    enabledMethodOrder: enabledAutoImageLanguageMethodOrder(
      disabledMethodIds,
      routedProviderOrder,
    ),
    minimumConfidence: preferences.ocrMinimumConfidence,
    policyFingerprint: replicaReadScopeFingerprint(readScope),
    controlImages: readScope.controlImages,
  });
  if (shouldClearAutoImageLanguageForDocument(
    resolvedSourceLanguageOrigin,
    resolvedImageLanguageDocument !== undefined &&
      currentReplicaDocumentMatches(resolvedImageLanguageDocument),
  )) {
    clearAutoImageLanguageResolution();
  }
  if (shouldClearAutoImageLanguageResolution(
    resolvedSourceLanguageOrigin,
    resolvedImageLanguageConfigurationKey,
    nextAutoLanguageConfigurationKey,
  )) {
    clearAutoImageLanguageResolution();
  }
  imageTranslationController.configure({
    enabled:
      preferences.imageTranslationEnabled &&
      !isLiveSourceOnlyMode() &&
      (
        enabledMethodIds.has(ACCESSIBILITY_TEXT_METHOD_ID) ||
        (imageCaptureAccess === 'granted' && usableProviderOrder.length > 0)
      ),
    scanPolicy: preferences.imageScanPolicy,
    skipSmallImages: preferences.skipSmallImages,
    providerOrder: routedProviderOrder,
    methodOrder: preferences.imageReadingMethodOrder,
    disabledMethodIds,
    resetEpoch: preferences.resetRevision,
    policyFingerprint: replicaReadScopeFingerprint(readScope),
    controlImages: readScope.controlImages,
    ocrMinimumConfidence: preferences.ocrMinimumConfidence,
    sourceLanguage: preferences.sourceLanguage,
    ...(resolvedSourceLanguage
      ? { detectedSourceLanguage: resolvedSourceLanguage }
      : {}),
    pageLanguageResolutionPending,
    targetLanguage: preferences.targetLanguage,
    translationIdle: !translationInFlight,
  });
}

function enabledUsablePixelOcrProviderOrder(): readonly ImageTextProviderId[] {
  return runtimeReadyOcrProviderOrder(
    effectiveCompiledProviderOrder(
      enabledOcrProviderOrder(
        preferences.imageReadingMethodOrder,
        preferences.disabledImageReadingMethodIds,
      ),
      preferences.disabledImageTextProviderIds,
    ),
    ocrProviderRuntimeStatuses,
  );
}

function currentAutoImageLanguageConfigurationKey(): string {
  const readScope = currentReplicaReadScope();
  const disabledMethodIds =
    preferences.readScopeSetupVersion === REPLICA_READ_SCOPE_SETUP_VERSION ||
    preferences.disabledImageReadingMethodIds.includes(
      ACCESSIBILITY_TEXT_METHOD_ID,
    )
      ? preferences.disabledImageReadingMethodIds
      : [
          ACCESSIBILITY_TEXT_METHOD_ID,
          ...preferences.disabledImageReadingMethodIds,
        ];
  const enabledProviderOrder = effectiveCompiledProviderOrder(
    enabledOcrProviderOrder(
      preferences.imageReadingMethodOrder,
      disabledMethodIds,
    ),
    preferences.disabledImageTextProviderIds,
  );
  const usableProviderOrder = imageCaptureAccess === 'granted'
    ? runtimeReadyOcrProviderOrder(
      enabledProviderOrder,
      ocrProviderRuntimeStatuses,
    )
    : [];
  return autoImageLanguageConfigurationKey({
    providerOrder: usableProviderOrder,
    enabledMethodOrder: enabledAutoImageLanguageMethodOrder(
      disabledMethodIds,
      usableProviderOrder,
    ),
    minimumConfidence: preferences.ocrMinimumConfidence,
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
  return preferences.imageReadingMethodOrder.filter((method) =>
    !disabled.has(method) &&
    (method === ACCESSIBILITY_TEXT_METHOD_ID || providers.has(method)),
  );
}

function clearAutoImageLanguageResolution(): void {
  sourceLanguageResolutionRevision += 1;
  autoLanguageEvidencePrecedence.invalidate();
  pageLanguageResolutionPending = false;
  resolvedSourceLanguage = undefined;
  resolvedSourceLanguageOrigin = undefined;
  resolvedImageLanguageConfigurationKey = undefined;
  resolvedImageLanguageDocument = undefined;
  availabilityRequestId += 1;
  availability = 'unavailable';
  availabilityCheckedForPair = undefined;
  translationComplete = false;
  activeAbortController?.abort();
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
  const current = snapshot?.document;
  return Boolean(current && sameSourceDocument(current, document));
}

function currentReplicaSnapshotMatches(
  requested: Pick<ReplicaTranslationSnapshot, 'document' | 'replayLease'>,
): boolean {
  const current = snapshot;
  return Boolean(current && sameSourceReplicaLease(current, requested));
}

function clearAutoImageLanguageForDifferentDocument(
  document: ReplicaSourceDocumentIdentity,
): void {
  if (!shouldClearAutoImageLanguageForDocument(
    resolvedSourceLanguageOrigin,
    Boolean(
      resolvedImageLanguageDocument &&
      sameSourceDocument(resolvedImageLanguageDocument, document),
    ),
  )) return;
  clearAutoImageLanguageResolution();
  configureImageTranslation();
}

async function refreshOcrProviderRuntimeStatuses(): Promise<void> {
  if (!compiledImageTextProviderIds.includes('chrome-text-detector')) return;
  ocrProviderRuntimeStatuses.set('chrome-text-detector', 'checking');
  renderImageAnalysisControls();
  configureImageTranslation();
  let status: OcrProviderRuntimeStatus;
  try {
    const ensureRaw: unknown = await browser.runtime.sendMessage({
      kind: 'simul:ocr-v1:ensure-host',
      version: 1,
      resetEpoch: preferences.resetRevision,
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
  ocrProviderRuntimeStatuses.set('chrome-text-detector', status);
  renderImageAnalysisControls();
  configureImageTranslation();
  if (shouldRetryOcrProviderProbe(status, textDetectorProbeRetryUsed)) {
    textDetectorProbeRetryUsed = true;
    window.setTimeout(() => {
      void refreshOcrProviderRuntimeStatuses();
    }, 1_000);
  }
}

function initializeImageAnalysisControls(): void {
  if (!hasCompiledImageAnalysisCapability()) return;
  imageAnalysisControls = document.createElement('section');
  imageAnalysisControls.className = 'image-analysis-settings';
  imageAnalysisControls.setAttribute('aria-label', 'Image text options');
  imageAnalysisHost.append(imageAnalysisControls);
  renderImageAnalysisControls();
}

function renderImageAnalysisControls(): void {
  const root = imageAnalysisControls;
  if (!root) return;
  // Rebuilding on every preference sync destroyed the control that fired the
  // change (dropping keyboard focus) and collapsed the diagnostics section.
  // Rebuild only when something the section shows actually changed.
  const renderKey = JSON.stringify([
    preferences.imageTranslationEnabled,
    imageCaptureAccess,
    permissionInFlight,
    preferences.imageTextProviderOrder,
    preferences.disabledImageTextProviderIds,
    preferences.imageReadingMethodOrder,
    preferences.disabledImageReadingMethodIds,
    preferences.ocrMinimumConfidence,
    preferences.imageScanPolicy,
    preferences.skipSmallImages,
    preferences.usePromptForImageLanguage,
    preferences.usePromptForImageText,
    [...ocrProviderRuntimeStatuses],
  ]);
  if (renderKey === imageAnalysisRenderKey && root.childElementCount > 0) return;
  imageAnalysisRenderKey = renderKey;
  const diagnosticsWereOpen = imageTranslationDiagnosticsDetails?.open ?? false;
  root.replaceChildren();
  const heading = document.createElement('h3');
  setUiText(heading, 'Image text');
  root.append(heading);

  root.append(createPromptToggle(
    'Translate text inside images (local, experimental)',
    preferences.imageTranslationEnabled,
    changeImageTranslationEnabled,
    permissionInFlight || imageCaptureAccess === 'checking',
  ));
  const privacyNote = document.createElement('p');
  privacyNote.className = 'microcopy';
  const enabledPixelProviders = enabledUsablePixelOcrProviderOrder();
  if (
    preferences.imageTranslationEnabled &&
    imageCaptureAccess === 'missing' &&
    enabledPixelProviders.length > 0
  ) {
    setUiText(
      privacyNote,
      'Accessibility text can run without image access. Grant image access only to enable local pixel OCR fallbacks.',
    );
  } else if (imageCaptureAccess === 'checking') {
    setUiText(privacyNote, 'Checking Chrome image access…');
  } else {
    setUiText(
      privacyNote,
      'Off by default. Visible image pixels stay on this device and are discarded after OCR.',
    );
  }
  root.append(privacyNote);
  if (
    preferences.imageTranslationEnabled &&
    imageCaptureAccess === 'missing' &&
    enabledPixelProviders.length > 0
  ) {
    const grant = document.createElement('button');
    grant.type = 'button';
    grant.className = 'image-access-grant';
    setUiText(grant, 'Grant image access');
    grant.disabled = permissionInFlight;
    grant.addEventListener('click', () => {
      void changeImageTranslationEnabled(true, true);
    });
    root.append(grant);
  }

  const compiledOrder = effectiveCompiledProviderOrder(
    preferences.imageTextProviderOrder,
  );
  if (compiledOrder.length > 0) {
    const confidence = document.createElement('label');
    confidence.className = 'ocr-confidence-control';
    confidence.title =
      'Require this provider confidence before OCR text can be used without independent corroboration.';
    const confidenceTitle = document.createElement('span');
    setUiText(confidenceTitle, 'Minimum OCR confidence');
    const confidenceRow = document.createElement('span');
    confidenceRow.className = 'ocr-confidence-row';
    const confidenceInput = document.createElement('input');
    confidenceInput.id = 'ocr-minimum-confidence';
    confidenceInput.type = 'range';
    confidenceInput.min = '25';
    confidenceInput.max = '95';
    confidenceInput.step = '5';
    confidenceInput.value = String(preferences.ocrMinimumConfidence * 100);
    confidenceInput.setAttribute(
      'aria-describedby',
      'ocr-minimum-confidence-help',
    );
    const confidenceOutput = document.createElement('output');
    confidenceOutput.setAttribute('for', confidenceInput.id);
    const renderConfidence = (): void => {
      confidenceOutput.value = `${confidenceInput.value}%`;
    };
    renderConfidence();
    confidenceInput.addEventListener('input', renderConfidence);
    confidenceInput.addEventListener('change', () => {
      const selected = Number(confidenceInput.value) / 100;
      if (
        isOcrMinimumConfidence(selected) &&
        OCR_MINIMUM_CONFIDENCE_OPTIONS.includes(selected)
      ) {
        void commitImageAnalysisPreferencePatch({
          ocrMinimumConfidence: selected,
        });
      }
    });
    confidenceRow.append(confidenceInput, confidenceOutput);
    const confidenceHelp = document.createElement('small');
    confidenceHelp.id = 'ocr-minimum-confidence-help';
    confidenceHelp.className = 'microcopy';
    setUiText(
      confidenceHelp,
      'Higher values reduce false text detections but may miss faint or stylized text.',
    );
    confidence.append(confidenceTitle, confidenceRow, confidenceHelp);
    root.append(confidence);
  }

    const orderLabel = document.createElement('p');
    orderLabel.className = 'microcopy';
    setUiText(orderLabel, 'Image reading priority');
    orderLabel.title =
      'This order controls which methods Simul attempts first and breaks close evidence ties.';
    root.append(orderLabel);
    const orderHelp = document.createElement('p');
    orderHelp.className = 'microcopy';
    setUiText(
      orderHelp,
      'Methods are attempted from top to bottom. Uncertain accessibility text may be compared with later OCR; the saved order breaks close ties.',
    );
    root.append(orderHelp);
    const list = document.createElement('ol');
    list.className = 'ocr-provider-order';
    const disabledMethods = new Set(
      preferences.disabledImageReadingMethodIds,
    );
    const readingOrder = visibleImageReadingMethodOrder(
      preferences.imageReadingMethodOrder,
      compiledOrder,
    );
    readingOrder.forEach((id, index) => {
      const item = document.createElement('li');
      const providerToggle = document.createElement('label');
      providerToggle.className = 'ocr-provider-toggle';
      providerToggle.title =
        'Turn this local image-reading method on or off without changing its priority.';
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = !disabledMethods.has(id);
      enabled.setAttribute(
        'aria-label',
        `${enabled.checked ? 'Disable' : 'Enable'} ${imageReadingMethodName(id)}`,
      );
      enabled.addEventListener('change', () => {
        const nextDisabled = new Set(
          preferences.disabledImageReadingMethodIds,
        );
        if (enabled.checked) nextDisabled.delete(id);
        else nextDisabled.add(id);
        void commitImageAnalysisPreferencePatch({
          disabledImageReadingMethodIds: preferences.imageReadingMethodOrder
            .filter((methodId) => nextDisabled.has(methodId)),
        });
      });
      const name = document.createElement('span');
      name.textContent = imageReadingMethodName(id);
      providerToggle.append(enabled, name);
      item.append(providerToggle);
      const runtimeStatus = id === ACCESSIBILITY_TEXT_METHOD_ID
        ? undefined
        : ocrProviderRuntimeStatuses.get(id);
      if (id === ACCESSIBILITY_TEXT_METHOD_ID) {
        const status = document.createElement('span');
        status.className = 'ocr-provider-status ocr-provider-status-available';
        status.textContent = 'No pixels';
        status.title = 'Uses direct image aria-label or alt text and does not require screenshot permission.';
        item.append(status);
      }
      if (runtimeStatus) {
        const status = document.createElement('span');
        status.className = runtimeStatus === 'checking'
          ? 'ocr-provider-status'
          : `ocr-provider-status ocr-provider-status-${runtimeStatus.status}`;
        status.textContent = runtimeStatus === 'checking'
          ? 'Checking…'
          : runtimeStatus.status === 'available'
            ? 'Available'
            : 'Unavailable';
        status.title = runtimeStatus === 'checking'
          ? 'Checking whether this Chrome runtime can complete a local detect call.'
          : runtimeStatus.status === 'available'
            ? 'This Chrome runtime completed the local capability probe.'
            : runtimeStatus.reason === 'api-missing'
              ? 'This Chrome runtime does not expose the experimental TextDetector API.'
              : 'This Chrome runtime could not complete the TextDetector capability probe.';
        item.append(status);
      }
      const buttons = document.createElement('span');
      buttons.className = 'ocr-order-buttons';
      const up = createOrderButton('↑', 'Move earlier', index === 0, () =>
        moveImageReadingMethod(readingOrder, index, -1),
      );
      const down = createOrderButton(
        '↓',
        'Move later',
        index === readingOrder.length - 1,
        () => moveImageReadingMethod(readingOrder, index, 1),
      );
      buttons.append(up, down);
      item.append(buttons);
      list.append(item);
    });
    root.append(list);
    if (compiledOrder.includes('chrome-text-detector')) {
      const platformNote = document.createElement('p');
      platformNote.className = 'microcopy';
      setUiText(
        platformNote,
        'Chrome TextDetector is experimental and platform-dependent. When its local detect probe is unavailable, Simul skips capture work for it and falls through to the next enabled provider.',
      );
      root.append(platformNote);
    }
    if (compiledOrder.includes('tesseract')) {
      const tesseractNote = document.createElement('p');
      tesseractNote.className = 'microcopy';
      setUiText(
        tesseractNote,
        'Tesseract.js runs locally with packaged language models. Simul loads only the language group needed for the current page.',
      );
      root.append(tesseractNote);
    }
    if (
      effectiveCompiledProviderOrder(
        preferences.imageTextProviderOrder,
        preferences.disabledImageTextProviderIds,
      ).length === 0
    ) {
      const paused = document.createElement('p');
      paused.className = 'microcopy ocr-provider-paused';
      setUiText(
        paused,
        'OCR is paused because every compiled provider is off.',
      );
      root.append(paused);
    }

    const grid = document.createElement('div');
    grid.className = 'settings-grid';
    const policyLabel = document.createElement('label');
    policyLabel.title =
      'Choose whether images are recognized only when visible, after visible work, or immediately.';
    const policyTitle = document.createElement('span');
    setUiText(policyTitle, 'Scan images');
    const policy = document.createElement('select');
    for (const value of IMAGE_SCAN_POLICIES) {
      const label = imageScanPolicyName(value);
      const option = createLanguageOption(value, label);
      setUiText(option, label);
      policy.append(option);
    }
    policy.value = preferences.imageScanPolicy;
    policy.addEventListener('change', () => {
      if (isImageScanPolicy(policy.value)) {
        void commitImageAnalysisPreferencePatch({ imageScanPolicy: policy.value });
      }
    });
    policyLabel.append(policyTitle, policy);
    const smallLabel = document.createElement('label');
    smallLabel.className = 'check-label';
    smallLabel.title =
      'Ignore tiny images that are unlikely to contain useful readable text.';
    const small = document.createElement('input');
    small.type = 'checkbox';
    small.checked = preferences.skipSmallImages;
    small.addEventListener('change', () => {
      void commitImageAnalysisPreferencePatch({ skipSmallImages: small.checked });
    });
    const smallTitle = document.createElement('span');
    setUiText(smallTitle, 'Skip very small images');
    smallLabel.append(small, smallTitle);
    grid.append(policyLabel, smallLabel);
    root.append(grid);

  if (compiledImageAnalysisCapabilities.promptImageLanguage) {
    root.append(createPromptToggle(
      'Use local Prompt for image language',
      preferences.usePromptForImageLanguage,
      (checked) => commitImageAnalysisPreferencePatch({
        usePromptForImageLanguage: checked,
      }),
    ));
  }
  if (compiledImageAnalysisCapabilities.promptImageText) {
    root.append(createPromptToggle(
      'Use local Prompt to interpret image text',
      preferences.usePromptForImageText,
      (checked) => commitImageAnalysisPreferencePatch({
        usePromptForImageText: checked,
      }),
    ));
  }

  const diagnostics = document.createElement('details');
  diagnostics.className = 'image-diagnostics';
  diagnostics.open = diagnosticsWereOpen;
  imageTranslationDiagnosticsDetails = diagnostics;
  const summary = document.createElement('summary');
  setUiText(summary, 'OCR diagnostics');
  summary.title = 'Inspect content-free OCR stages and counts for this session.';
  const note = document.createElement('p');
  note.className = 'microcopy';
  setUiText(
    note,
    'Memory-only stages and counts; page text, URLs, pixels, and identifiers are never included.',
  );
  const output = document.createElement('output');
  output.className = 'image-diagnostics-output';
  output.setAttribute('aria-live', 'polite');
  imageTranslationDiagnosticOutput = output;
  renderImageTranslationDiagnosticHistory();
  diagnostics.addEventListener('toggle', renderImageTranslationDiagnosticHistory);
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'image-diagnostics-clear';
  setUiText(clear, 'Clear diagnostics');
  clear.addEventListener('click', () => {
    imageTranslationDiagnosticHistory.clear();
    renderImageTranslationDiagnosticHistory();
  });
  diagnostics.append(summary, note, output, clear);
  root.append(diagnostics);
}

function createOrderButton(
  text: string,
  label: string,
  disabled: boolean,
  action: () => void,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.title = label;
  button.disabled = disabled;
  button.addEventListener('click', action);
  return button;
}

function moveImageReadingMethod(
  renderedOrder: readonly ImageReadingMethodId[],
  index: number,
  direction: -1 | 1,
): void {
  const current = renderedOrder[index];
  const adjacent = renderedOrder[index + direction];
  if (!current || !adjacent) return;
  const next = [...preferences.imageReadingMethodOrder];
  const currentIndex = next.indexOf(current);
  const adjacentIndex = next.indexOf(adjacent);
  if (currentIndex < 0 || adjacentIndex < 0) return;
  [next[currentIndex], next[adjacentIndex]] = [
    next[adjacentIndex]!,
    next[currentIndex]!,
  ];
  void commitImageAnalysisPreferencePatch({ imageReadingMethodOrder: next });
}

function createPromptToggle(
  label: string,
  checked: boolean,
  save: (checked: boolean) => Promise<void>,
  disabled = false,
): HTMLLabelElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'check-label image-prompt-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => void save(input.checked));
  const title = document.createElement('span');
  setUiText(title, label);
  wrapper.append(input, title);
  return wrapper;
}

function imageReadingMethodName(id: ImageReadingMethodId): string {
  if (id === ACCESSIBILITY_TEXT_METHOD_ID) {
    return 'Accessibility text (aria-label / alt)';
  }
  const names: Record<ImageTextProviderId, string> = {
    'chrome-text-detector': 'Chrome TextDetector (platform)',
    tesseract: 'Tesseract.js (local)',
    transformers: 'Transformers.js',
    'chromium-screen-ai': 'Chromium Screen AI',
  };
  return names[id];
}

function imageScanPolicyName(value: (typeof IMAGE_SCAN_POLICIES)[number]): string {
  if (value === 'visible-only') return 'Only when visible';
  if (value === 'eager-all') return 'Everything immediately';
  return 'Visible first, then background';
}

function configureSurfaceButton(): void {
  if (!isDetachedWindow) return;
  popoutButton.textContent = '↙';
  popoutButton.setAttribute('aria-label', 'Return companion to the side panel');
  popoutButton.title = 'Return to side panel';
}

async function openDetachedWindow(): Promise<void> {
  const identity = capturedPageIdentity ?? followedPageIdentity;
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
    followedPageIdentity?.windowId ??
    detachedSourceWindowId ??
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
    if (panelWindowId !== undefined) {
      await browser.windows.remove(panelWindowId);
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
  if (permissionInFlight) {
    syncPreferenceControls();
    return;
  }
  const pageUrl = followedPageIdentity?.url ?? capturedPageIdentity?.url;
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
  permissionInFlight = true;
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
    if (mode !== 'off' && snapshot && !isLiveSourceOnlyMode()) {
      translationDesired = true;
      await maybeTranslateAutomatically(captureCoordinator.generation, pageUrl ?? '');
    }
  } catch (error) {
    const repaired = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      expectedResetRevision: preferences.resetRevision,
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    if (repaired) applyCommittedPreferences(repaired.preferences);
    else await reloadPreferencesFromStorage();
    syncPreferenceControls();
    setStatus(`Chrome could not update automatic access: ${readableError(error)}`, 'error');
  } finally {
    permissionInFlight = false;
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
      () => freshPreferences ?? preferences,
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
  const before = autoTranslationModeForPage(preferences, pageUrl);
  const result = await sendPreferenceCommand({ type: 'simul:preferences:reconcile' });
  applyCommittedPreferences(result.preferences);
  syncPreferenceControls();
  return before !== autoTranslationModeForPage(preferences, pageUrl);
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
  navigationTimer = setTimeout(() => {
    navigationTimer = undefined;
    if (
      followedPageIdentity?.tabId !== identity.tabId ||
      followedPageIdentity.windowId !== identity.windowId ||
      navigationPageIdentityKey(followedPageIdentity) !==
        navigationPageIdentityKey(identity)
    ) return;
    queueCapture({ identity, reason: 'navigation' });
  }, NAVIGATION_DEBOUNCE_MS);
}

function clearNavigationTimer(): void {
  if (navigationTimer !== undefined) clearTimeout(navigationTimer);
  navigationTimer = undefined;
}

function invalidateCompanion(message: string): void {
  navigationRefreshGate.reset();
  identityRequestId += 1;
  activeFollowRequestId = undefined;
  sourceLanguageResolutionRevision += 1;
  autoLanguageEvidencePrecedence.invalidate();
  pageLanguageResolutionPending = false;
  captureCoordinator.invalidate();
  availabilityRequestId += 1;
  activeAbortController?.abort();
  replicaShadowAbortController?.abort();
  imageTranslationController.setTopPageOrigin(undefined);
  imageTranslationController.releaseReplica();
  isolatedHtmlReplicaEngine.releasePresentation();
  quickComposer.invalidate();
  followedPageIdentity = undefined;
  snapshot = undefined;
  capturedPageIdentity = undefined;
  resolvedSourceLanguage = undefined;
  resolvedSourceLanguageOrigin = undefined;
  resolvedImageLanguageConfigurationKey = undefined;
  resolvedImageLanguageDocument = undefined;
  availability = 'unavailable';
  availabilityCheckedForPair = undefined;
  translationDesired = false;
  translationComplete = false;
  replicaTranslationCoordinator.selectPair(undefined);
  isolatedReplicaFailureRecoveryGate.reset();
  lastSourceScroll = undefined;
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
  return identityFromTab(tab, followed.url, requiresActiveSourceTab());
}

/** Side panels and active-following windows must read the active tab only. */
function requiresActiveSourceTab(): boolean {
  return !isDetachedWindow || preferences.popoutTabMode === 'active';
}

function isCurrentAvailabilityRequest(
  requestId: number,
  requestedSnapshot: ReplicaTranslationSnapshot,
  pair: TranslationPair,
  generation: number,
): boolean {
  const currentPair = selectedPair();
  return isAvailabilityRequestCurrent({
    replicaViewMode: preferences.replicaViewMode,
    requestMatches: requestId === availabilityRequestId,
    generationMatches: captureCoordinator.isCurrent(generation),
    snapshotMatches: currentReplicaSnapshotMatches(requestedSnapshot),
    pairMatches: Boolean(
      currentPair &&
        currentPair.sourceLanguage === pair.sourceLanguage &&
        currentPair.targetLanguage === pair.targetLanguage,
    ),
  });
}

function selectedPair(): TranslationPair | undefined {
  return resolvedSourceLanguage
    ? {
        sourceLanguage: resolvedSourceLanguage,
        targetLanguage: preferences.targetLanguage,
      }
    : undefined;
}

function isCurrentTranslationPair(pair: TranslationPair): boolean {
  const current = selectedPair();
  return Boolean(
    current &&
      current.sourceLanguage === pair.sourceLanguage &&
      current.targetLanguage === pair.targetLanguage,
  );
}

function availabilityPairKey(pair: TranslationPair, generation: number): string {
  return `${generation}:${pair.sourceLanguage}>${pair.targetLanguage}`;
}

function currentTranslationTaskKey(generation: number): string {
  const pair = selectedPair();
  return pair
    ? availabilityPairKey(pair, generation)
    : `${generation}:unresolved`;
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
  const busy = captureInFlight || translationInFlight || permissionInFlight || composerInFlight;
  replicaStatusContainer.setAttribute('aria-busy', String(captureInFlight));
  replicaPreviewContainer.setAttribute('aria-busy', String(captureInFlight));
  sourceSelect.disabled = busy;
  targetSelect.disabled = busy;
  swapButton.disabled = busy || !resolvedSourceLanguage;
  autoTranslateSelect.disabled = busy;
  displayModeSelect.disabled = busy;
  textLayoutSelect.disabled = busy;
  replicaFidelityPolicySelect.disabled = busy || replicaFidelityCommitInFlight;
  launchBehaviorSelect.disabled = busy;
  popoutTabModeSelect.disabled = busy;
  syncScrollInput.disabled = busy;
  zoomInButton.disabled = busy;
  zoomOutButton.disabled = busy;
  refreshButton.disabled = captureInFlight;
  compactRefreshButton.disabled = captureInFlight;
  setUiText(
    refreshButton,
    captureInFlight ? 'Rebuilding mirror…' : 'Rebuild mirror',
  );
  compactRefreshButton.setAttribute(
    'aria-label',
    captureInFlight ? 'Rebuilding mirror' : 'Rebuild mirror',
  );
  compactRefreshButton.title = captureInFlight
    ? 'Rebuilding mirror…'
    : 'Rebuild mirror';
  toolbarAutoDetectButton.disabled = busy;
  toolbarSizeToggleButton.disabled = busy;
  toolbarOcrToggleButton.disabled = busy ||
    imageCaptureAccess === 'checking' ||
    !hasCompiledImageAnalysisCapability();
  toolbarTabFollowButton.disabled = busy || !isDetachedWindow;
  popoutButton.disabled = surfaceTransitionInFlight ||
    (!isDetachedWindow && !capturedPageIdentity);
  cancelButton.hidden =
    !translationInFlight && !composerInFlight && !imageTranslationInFlight;
  cancelButton.disabled =
    !translationInFlight && !composerInFlight && !imageTranslationInFlight;
  translateComposerButton.disabled = busy || !composerInput.value.trim() || !selectedPair();
  setUiText(
    translateComposerButton,
    composerInFlight ? 'Translating…' : 'Translate',
  );
  translateButton.disabled =
    busy ||
    isLiveSourceOnlyMode() ||
    !snapshot ||
    currentTranslationFieldCount() === 0 ||
    !selectedPair() ||
    availability === 'unavailable' ||
    translationComplete;
  setUiText(
    translateButton,
    translationInFlight
      ? 'Translating…'
      : translationComplete
        ? 'Translation current'
        : 'Translate page',
  );
  toolbarStatus.renderAttention();
  toolbarStatus.syncProgress();
}

function setImageTranslationBusy(busy: boolean): void {
  const completed = imageTranslationInFlight && !busy;
  imageTranslationInFlight = busy;
  const composerInFlight = quickComposer.inFlight;
  if (busy && !translationInFlight && !composerInFlight) {
    toolbarStatus.showImageProgress();
  } else if (!busy && !translationInFlight && !composerInFlight) {
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
  imageTranslationDiagnosticHistory.append(diagnostic);
  renderImageTranslationDiagnosticHistory();
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

function renderImageTranslationDiagnosticHistory(): void {
  const output = imageTranslationDiagnosticOutput;
  if (!output || imageTranslationDiagnosticsDetails?.open === false) return;
  const entries = imageTranslationDiagnosticHistory.entries;
  output.textContent = entries.length > 0
    ? entries.join('\n')
    : 'No OCR activity in this companion view yet.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing companion element: ${selector}`);
  return element;
}
