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
  reverseTranslationPair,
  toolbarActivityLabel,
  toolbarProgressState,
  type CompanionOverlay,
  type ToolbarActivity,
} from '../../lib/companion-ui-state';
import {
  resolveUiLabelTranslations,
  toolbarAttentionTarget,
  type CompanionStatusTone,
  type ToolbarAttentionTarget,
} from '../../lib/companion-ui-localization';
import { resolveSourceLanguage } from '../../lib/language-detection';
import {
  LANGUAGE_OPTION_ORDER,
  createSourceLanguageLabeler,
  languageEndonym,
} from '../../lib/language-options';
import {
  captureLivePageDelta,
  installLivePageObserver,
  parseLivePageDelta,
  readLivePageDirtyMessage,
  readLivePageObserverInstallation,
  readLivePageScrollMessage,
  unregisterLivePageObserver,
  type LivePageDirtyMessage,
  type LivePageDelta,
  type LiveVisualNode,
} from '../../lib/live-page-mirror';
import {
  type CapturedPageIdentity,
  isSamePageIdentity,
  parseDetachedPageIdentityHint,
} from '../../lib/page-identity';
import {
  createDetachedCompanionUrl,
  createDetachedWindowData,
  isNewerCompanionLaunchStamp,
  sameCompanionSourcePage,
  shouldFollowActivatedTab,
  type CompanionLaunchStamp,
} from '../../lib/companion-surface';
import {
  capturePageSnapshot,
  parsePageSnapshot,
  type PageSnapshot,
  type SnapshotTextRole,
} from '../../lib/page-snapshot';
import {
  compiledImageAnalysisCapabilities,
  effectiveCompiledProviderOrder,
  hasCompiledImageAnalysisCapability,
} from '../../lib/ocr/provider-registry';
import {
  IMAGE_SCAN_POLICIES,
  isImageScanPolicy,
} from '../../lib/ocr/contracts';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import { ImageTranslationDiagnosticHistory } from '../../lib/ocr/diagnostic-history';
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
  PREFERENCE_LOCK_NAME,
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
  isReplicaEnginePreference,
  isReplicaViewMode,
  isTextLayoutMode,
  parseCompanionPreferences,
  permissionOriginsForMode,
  withAutoTranslationMode,
  withImageAnalysisSettings,
  withViewSettings,
  type AutoTranslationMode,
  type CompanionLaunchBehavior,
  type CompanionPreferences,
  type CompanionSurface,
  type CompanionImageAnalysisSettings,
  type CompanionImageAnalysisSettingsPatch,
  type CompanionViewSettings,
  type CompanionViewSettingsPatch,
  type PopoutTabMode,
  type ReplicaEnginePreference,
  type ReplicaViewMode,
} from '../../lib/preferences';
import { translateWithSession } from '../../lib/translation-pipeline';
import {
  type ReplicaCaptureRequest,
  type ReplicaCheckpointResponse,
  type ReplicaDiagnosticCode,
} from '../../lib/replica/contracts';
import {
  ReplicaEngineController,
  selectReplicaEngineMode,
  selectReplicaTranslationMode,
  type ReplicaEngineMode,
} from '../../lib/replica/engine-selection';
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
import { openChromeReplicaLiveStream } from '../../lib/replica/live-stream-client';
import {
  createCheckpointCommand,
  createReplicaIdentity,
  readCheckpointResponse,
} from '../../lib/replica/protocol-v2';
import {
  ReplicaCaptureBoundaryError,
  RrwebShadowReplicaEngine,
} from '../../lib/replica/rrweb-shadow-engine';
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
import { replicaSourceCommitAction } from '../../lib/translation/replica-translation-lifecycle';
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
  type TranslationAvailability,
  type TranslationPair,
  type TranslationSession,
} from '../../lib/translation-provider';
import {
  applyLivePageDelta,
  applyMirrorTextLayout,
  countVisualMirrorTranslationFields,
  computeMirrorExtent,
  computeMirrorScale,
  createVisualMirror,
  resetVisualMirrorText,
  translateVisualMirror,
} from '../../lib/visual-renderer';

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

interface AuthorizedTabMessage {
  type: 'simul:authorized-tab';
  tabId: number;
  windowId: number;
  url: string;
  launchEpoch?: string;
  launchSequence?: number;
}

interface AuthorizedTabRequest {
  identity: CapturedPageIdentity;
  launchStamp?: CompanionLaunchStamp;
}

interface PendingLiveUpdate {
  generation: number;
  firstSequence: number;
  sequence: number;
  nodeIds: Set<string>;
}

interface PendingImageReplicaActivation {
  readonly request: ReplicaCaptureRequest;
  readonly sourceWindowId: number;
  readonly mode: ReplicaEngineMode;
  readonly signal: AbortSignal;
  activated: boolean;
}

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
const replicaEngineSelect = requireElement<HTMLSelectElement>('#replica-engine');
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

let preferences: CompanionPreferences = parseCompanionPreferences(
  DEFAULT_COMPANION_PREFERENCES,
);
const provider = new ChromeTranslatorProvider();
const captureCoordinator = new LatestWorkCoordinator<CaptureRequest>();
const detachedIdentityHint = parseDetachedPageIdentityHint(window.location.search);
const isDetachedWindow = detachedIdentityHint !== undefined;
const liveSessionId = crypto.randomUUID();
const replicaBuildEnvironment = {
  DEV: import.meta.env.DEV,
  WXT_SIMUL_RRWEB_SHADOW: import.meta.env.WXT_SIMUL_RRWEB_SHADOW,
  WXT_SIMUL_RRWEB_TRANSLATION: import.meta.env.WXT_SIMUL_RRWEB_TRANSLATION,
};
if (replicaBuildEnvironment.WXT_SIMUL_RRWEB_SHADOW === '0') {
  replicaEngineSelect.querySelector('option[value="rrweb"]')?.remove();
}
let replicaEngineMode = selectReplicaEngineMode(replicaBuildEnvironment);
const replicaTranslationMode = selectReplicaTranslationMode({
  DEV: import.meta.env.DEV,
  WXT_SIMUL_RRWEB_SHADOW: import.meta.env.WXT_SIMUL_RRWEB_SHADOW,
  WXT_SIMUL_RRWEB_TRANSLATION: import.meta.env.WXT_SIMUL_RRWEB_TRANSLATION,
}, replicaEngineMode);
const visibleReplayHost = new VisibleReplayHost({
  hostDocument: document,
  legacySurface: snapshotContainer,
  previewSurface: replicaPreviewContainer,
  badge: replicaModeBadge,
});
let replicaEngineController!: ReplicaEngineController;
let replicaTranslationCoordinator!: ReplicaTranslationCoordinator;
let imageTranslationController!: ImageTranslationController;
const imageTranslationDiagnosticHistory =
  new ImageTranslationDiagnosticHistory();
let imageTranslationDiagnosticOutput: HTMLOutputElement | undefined;
const replicaSurfaceRouter = new ReplicaSurfaceRouter();
const shadowReplicaEngine = new RrwebShadowReplicaEngine({
  presentationHost: visibleReplayHost,
  capture: captureReplicaCheckpoint,
  openStream: openChromeReplicaLiveStream,
  shouldReplayScroll: () => preferences.syncScroll,
  onLiveApplied: () => {
    legacyTransitionGate.markDirty();
  },
  onLayoutChanged: () => {
    imageTranslationController?.refreshOverlays();
  },
  onSourceCommit: handleReplicaSourceCommit,
  onLiveFailure: (code) => handleReplicaLiveFailure(code, 'rrweb-shadow'),
});
const isolatedHtmlReplicaEngine = new IsolatedHtmlReplicaEngine({
  presentationHost: visibleReplayHost,
  openStream: openChromeHtmlMirrorStream,
  getReplicaFidelityPolicy: () => preferences.replicaFidelityPolicy,
  onLiveApplied: () => legacyTransitionGate.markDirty(),
  onLayoutChanged: () => imageTranslationController?.refreshOverlays(),
  onSourceCommit: handleReplicaSourceCommit,
  onLiveFailure: (code) => handleReplicaLiveFailure(code, 'isolated-html'),
  onInfo: (info) => {
    // Counts and bounded stages only: never source text, URLs, pixels, IDs, or hashes.
    const event = info.eventRepresentability;
    console.info(
      `[Simul isolated mirror] stage=${info.stage}; code=${info.code ?? 'none'}; nodes=${info.nodeCount}; text=${info.textCount}; images=${info.imageCount}; shadow-roots=${info.openShadowRootCount}; adopted-styles=${info.adoptedStyleCount}; hidden-labels=${info.visuallyHiddenCount}; selected-image-sources=${info.selectedImageSourceCount}; stylesheet-links=${info.stylesheetLinkCount}; stylesheet-loaded=${info.stylesheetLoadedCount}; stylesheet-errors=${info.stylesheetErrorCount}; stylesheet-timeouts=${info.stylesheetTimedOutCount}; operations=${info.operationCount}; text-ops=${info.textOperationCount}; attribute-ops=${info.attributeOperationCount}; children-ops=${info.childrenOperationCount}; reconcile-children-ops=${info.reconcileChildrenOperationCount}; dimension-ops=${info.dimensionOperationCount}; replacement-nodes=${info.replacementNodeCount}; largest-replacement=${info.largestReplacementNodeCount}; retained-nodes=${info.retainedNodeCount}; inserted-nodes=${info.insertedNodeCount}; moved-nodes=${info.movedNodeCount}; removed-nodes=${info.removedNodeCount}; full-replacement-fallbacks=${info.fullReplacementFallbackCount}; rejected-reconciliations=${info.reconciliationRejectedCount}; baseline-unsafe-elements=${info.unsafeElementOmissionCount}; baseline-unsupported-nodes=${info.unsupportedNodeOmissionCount}; baseline-depth-omissions=${info.depthBoundaryOmissionCount}; baseline-private-redactions=${info.privateTextRedactionCount}; baseline-stripped-active=${info.strippedActiveAttributeCount}; baseline-stripped-resources=${info.strippedUnsafeResourceCount}; baseline-unreadable-styles=${info.unreadableStyleCount}; baseline-capacity=${info.capacityOmissionCount}; baseline-custom-hosts=${info.customElementHostCount}; baseline-custom-hosts-without-open-root=${info.customElementHostWithoutAccessibleOpenRootCount}; baseline-open-roots=${info.accessibleOpenShadowRootCount}; baseline-missing-proof-fallbacks=${info.missingReconciliationProofFallbackCount}; baseline-covered-dirty-fallbacks=${info.coveredDirtyBranchFallbackCount}; baseline-attribute-context-fallbacks=${info.attributeContextFallbackCount}; baseline-cross-parent-fallbacks=${info.crossParentFallbackCount}; event-unsafe-elements=${event.unsafeElementOmissionCount}; event-unsupported-nodes=${event.unsupportedNodeOmissionCount}; event-depth-omissions=${event.depthBoundaryOmissionCount}; event-private-redactions=${event.privateTextRedactionCount}; event-stripped-active=${event.strippedActiveAttributeCount}; event-stripped-resources=${event.strippedUnsafeResourceCount}; event-unreadable-styles=${event.unreadableStyleCount}; event-capacity=${event.capacityOmissionCount}; event-custom-hosts=${event.customElementHostCount}; event-custom-hosts-without-open-root=${event.customElementHostWithoutAccessibleOpenRootCount}; event-open-roots=${event.accessibleOpenShadowRootCount}; event-missing-proof-fallbacks=${event.missingReconciliationProofFallbackCount}; event-covered-dirty-fallbacks=${event.coveredDirtyBranchFallbackCount}; event-attribute-context-fallbacks=${event.attributeContextFallbackCount}; event-cross-parent-fallbacks=${event.crossParentFallbackCount}; sequence=${info.sequence}`,
    );
    console.info(
      `[Simul fidelity resources] policy=${info.fidelityPolicy}; baseline-preserved-stylesheets=${info.preservedStyleSheetCount}; baseline-flattened-stylesheets=${info.flattenedStyleSheetCount}; baseline-omitted-stylesheets=${info.omittedStyleSheetCount}; baseline-preserved-svg=${info.preservedSvgResourceCount}; baseline-blocked-svg=${info.blockedSvgResourceCount}; baseline-request-capable=${info.replicaRequestCapableResourceCount}; baseline-execution-risk-blocks=${info.executionRiskBlockCount}; baseline-navigation-blocks=${info.navigationBlockCount}; baseline-unsupported-scheme-blocks=${info.unsupportedSchemeBlockCount}; baseline-browser-inaccessible=${info.browserInaccessibleResourceCount}; baseline-strict-policy-blocks=${info.strictResourcePolicyBlockCount}; event-preserved-stylesheets=${event.preservedStyleSheetCount}; event-flattened-stylesheets=${event.flattenedStyleSheetCount}; event-omitted-stylesheets=${event.omittedStyleSheetCount}; event-preserved-svg=${event.preservedSvgResourceCount}; event-blocked-svg=${event.blockedSvgResourceCount}; event-request-capable=${event.replicaRequestCapableResourceCount}; event-execution-risk-blocks=${event.executionRiskBlockCount}; event-navigation-blocks=${event.navigationBlockCount}; event-unsupported-scheme-blocks=${event.unsupportedSchemeBlockCount}; event-browser-inaccessible=${event.browserInaccessibleResourceCount}; event-strict-policy-blocks=${event.strictResourcePolicyBlockCount}; replica-requests-may-occur=${info.replicaRequestsMayOccur}; sequence=${info.sequence}`,
    );
  },
});
replicaEngineController = new ReplicaEngineController({
  mode: replicaEngineMode,
  legacy: new LegacyReplicaEngine(),
  shadow: shadowReplicaEngine,
  isolated: isolatedHtmlReplicaEngine,
  onDiagnostics: (diagnostics) => {
    // This object is intentionally content-free: local size/timing/extent
    // numbers and a bounded code only. It never includes page text or URLs.
    console.info('[Simul replica]', diagnostics);
  },
  onFallback: () => {
    imageTranslationController?.releaseReplica();
    if (replicaTranslationMode === 'rrweb-projection') {
      replicaTranslationCoordinator.selectPair(undefined);
    }
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
  openSource: (request, onChange, signal) => openChromeImageSource(
    request,
    onChange,
    signal,
    replicaEngineController.mode === 'isolated-html'
      ? 'isolated-html'
      : 'rrweb',
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
  const pending = pendingImageReplicaActivation;
  const selectedSnapshot = replicaSurfaceRouter.snapshot();
  if (
    pending &&
    !pending.activated &&
    !pending.signal.aborted &&
    pending.mode === replicaEngineController.mode &&
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
  if (replicaTranslationMode !== 'rrweb-projection') return;
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
  expectedMode: ReplicaEngineMode,
): void {
  if (replicaEngineController.mode !== expectedMode) return;
  const identity = followedPageIdentity ?? capturedPageIdentity;
  const action = identity
    ? liveReplicaFailureRecoveryGate.decide(
        visibleReplayHost.hasCommittedReplica,
      )
    : 'fallback';
  // Content-free by construction: bounded enums only, with no page identity,
  // source text, URL, DOM identifier, pixels, or resource metadata.
  console.info('[Simul replica live failure]', {
    engine: expectedMode,
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
  if (replicaTranslationMode === 'rrweb-projection') {
    replicaTranslationCoordinator.selectPair(undefined);
  }
  legacyTransitionGate.release();
  replicaEngineController.disableSelected(code);
  if (identity) queueCapture({ identity, reason: 'desynchronized' });
}

let snapshot: PageSnapshot | undefined;
let followedPageIdentity: CapturedPageIdentity | undefined;
let capturedPageIdentity: CapturedPageIdentity | undefined;
let capturedPageDocumentId: string | undefined;
let resolvedSourceLanguage: SupportedLanguage | undefined;
let availability: TranslationAvailability = 'unavailable';
let availabilityRequestId = 0;
let replicaLanguageRefreshVersion = 0;
let identityRequestId = 0;
let captureInFlight = false;
let translationInFlight = false;
let permissionInFlight = false;
let imageCaptureAccess: 'checking' | 'granted' | 'missing' = 'checking';
let imageCaptureAccessRevision = 0;
let composerInFlight = false;
let imageTranslationInFlight = false;
let translationDesired = false;
let translationComplete = false;
let openCompanionOverlay: CompanionOverlay | undefined;
let toolbarDeterminateRatio: number | undefined;
let activeAbortController: AbortController | undefined;
let activeTranslationKey: string | undefined;
let composerAbortController: AbortController | undefined;
let liveDeltaAbortController: AbortController | undefined;
let replicaShadowAbortController: AbortController | undefined;
let activeTranslationTask: Promise<void> | undefined;
let navigationTimer: ReturnType<typeof setTimeout> | undefined;
let mirrorResizeObserver: ResizeObserver | undefined;
let panelWindowId: number | undefined;
let detachedSourceWindowId = detachedIdentityHint?.windowId;
let visualRoot: HTMLElement | undefined;
let mirrorScroller: HTMLElement | undefined;
let mirrorStage: HTMLElement | undefined;
let mirrorScaleLayer: HTMLElement | undefined;
let mirrorViewportWidth = 1;
let mirrorDocumentWidth = 1;
let mirrorDocumentHeight = 1;
let currentMirrorScale = 1;
let liveDeltaInFlight = false;
let pendingLiveUpdate: PendingLiveUpdate | undefined;
let activeLiveUpdate: PendingLiveUpdate | undefined;
const legacyTransitionGate = new LegacyTransitionGate();
const liveReplicaFailureRecoveryGate = new LiveReplicaFailureRecoveryGate();
let latestLiveSequence = 0;
let highestReceivedLiveSequence = 0;
let liveSequenceBaselineReady = false;
let liveObservationAvailable = true;
let lastSourceScroll: ReturnType<typeof readLivePageScrollMessage>;
let availabilityCheckedForPair: string | undefined;
let viewPreferenceRevision = 0;
let replicaFidelityCommitInFlight = false;
let imageAnalysisPreferenceRevision = 0;
let imageAnalysisControls: HTMLElement | undefined;
let surfaceTransitionInFlight = false;
let latestToolbarLaunchStamp: CompanionLaunchStamp | undefined;
let pendingImageReplicaActivation: PendingImageReplicaActivation | undefined;
let toolbarAttention: ToolbarAttentionTarget | undefined;
let toolbarAttentionTone: Extract<CompanionStatusTone, 'warning' | 'error'> =
  'warning';
let uiLocalizationRequestId = 0;
let uiLocalizationInputKey = '';
let uiLocalizationScheduled = false;
let uiLocalizationAbortController: AbortController | undefined;
let uiLocalizedTarget: SupportedLanguage = 'en';
let uiLabelTranslations: ReadonlyMap<string, string> = new Map();
const pendingViewPreferences = new Map<
  keyof CompanionViewSettings,
  { revision: number; value: CompanionViewSettings[keyof CompanionViewSettings] }
>();
const pendingImageAnalysisPreferences = new Map<
  keyof CompanionImageAnalysisSettings,
  {
    revision: number;
    value: CompanionImageAnalysisSettings[keyof CompanionImageAnalysisSettings];
  }
>();

const companionBuildIdentity = createExtensionBuildIdentity(
  browser.runtime.getManifest(),
);
renderExtensionBuildIdentity(buildVersionElement, companionBuildIdentity);
console.info(companionBuildIdentity.companionReadyMessage);

populateLanguageOptions();
initializeImageAnalysisControls();
configureSurfaceButton();
observeReplicaStateLabel();
scheduleUiLocalization();

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
  void changeImageTranslationEnabled(
    !preferences.imageTranslationEnabled || imageCaptureAccess !== 'granted',
  );
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
  if (visualRoot) applyMirrorTextLayout(visualRoot, mode);
  updateMirrorLayout();
});

replicaFidelityPolicySelect.addEventListener('change', () => {
  const replicaFidelityPolicy: SelectableReplicaFidelityPolicy =
    isSelectableReplicaFidelityPolicy(replicaFidelityPolicySelect.value)
      ? replicaFidelityPolicySelect.value
      : 'passive';
  void changeReplicaFidelityPolicy(replicaFidelityPolicy);
});

replicaEngineSelect.addEventListener('change', () => {
  const replicaEngine: ReplicaEnginePreference =
    isReplicaEnginePreference(replicaEngineSelect.value)
      ? replicaEngineSelect.value
      : 'isolated-html';
  void changeReplicaEngine(replicaEngine);
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
  if (preferences.syncScroll && lastSourceScroll) followSourceScroll(lastSourceScroll);
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
  const composerCancelled = cancelComposerTranslation();
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
translateComposerButton.addEventListener('click', () => void translateComposer());
copyComposerButton.addEventListener('click', () => void copyComposerOutput());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openCompanionOverlay) {
    event.preventDefault();
    setCompanionOverlay();
  }
});
window.addEventListener('pagehide', () => {
  uiLocalizationAbortController?.abort();
  replicaShadowAbortController?.abort();
  imageTranslationController.dispose();
  replicaTranslationCoordinator.dispose();
  replicaEngineController.dispose();
  releaseLiveSession();
});

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const authorizedTab = readAuthorizedTabMessage(message);
  if (authorizedTab) {
    void acceptAuthorizedTab(authorizedTab);
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
    lastSourceScroll = scroll;
    if (preferences.syncScroll) followSourceScroll(scroll);
  }
});

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
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
  const requestId = ++identityRequestId;
  clearNavigationTimer();
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
  const nextUrl = changeInfo.url ?? tab.url ?? followed.url;
  if (!isSupportedPage(nextUrl)) {
    if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
      clearNavigationTimer();
      invalidateCompanion(
        'The source tab opened a restricted page. Return to a regular HTTP or HTTPS page and select the extension again.',
      );
    }
    return;
  }
  const nextIdentity = { tabId, windowId: tab.windowId, url: nextUrl };
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    identityRequestId += 1;
    captureCoordinator.invalidate();
    availabilityRequestId += 1;
    activeAbortController?.abort();
    liveDeltaAbortController?.abort();
    replicaShadowAbortController?.abort();
    imageTranslationController.releaseReplica();
    invalidateComposerOutput();
    pendingLiveUpdate = undefined;
    followedPageIdentity = nextIdentity;
    clearNavigationTimer();
    setStatus('The source page is changing; the current mirror stays visible until the new page is ready.');
  }
  if (
    changeInfo.status === 'complete' ||
    (typeof changeInfo.url === 'string' && changeInfo.status !== 'loading')
  ) {
    scheduleNavigationRefresh(nextIdentity);
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (followedPageIdentity?.tabId === tabId) {
    invalidateCompanion('The source tab was closed.');
  }
});

browser.permissions.onAdded.addListener(() => {
  void refreshImageCaptureAccess();
});

browser.permissions.onRemoved.addListener(() => {
  void refreshImageCaptureAccess(true);
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !(STORAGE_KEY in changes)) return;
  const previous = preferences;
  preferences = mergePendingViewPreferences(
    parseCompanionPreferences(changes[STORAGE_KEY]?.newValue),
  );
  if (
    isDetachedWindow &&
    previous.popoutTabMode !== preferences.popoutTabMode &&
    preferences.popoutTabMode === 'active'
  ) {
    void followCurrentActiveSourceTab();
  }
  if (previous.replicaEngine !== preferences.replicaEngine) {
    liveReplicaFailureRecoveryGate.reset();
    replicaTranslationCoordinator.selectPair(undefined);
    applyReplicaEnginePreference();
    activeAbortController?.abort();
    liveDeltaAbortController?.abort();
    replicaShadowAbortController?.abort();
    imageTranslationController.releaseReplica();
    legacyTransitionGate.release();
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'preference' });
  } else if (
    previous.replicaFidelityPolicy !== preferences.replicaFidelityPolicy &&
    replicaEngineController.mode === 'isolated-html'
  ) {
    liveReplicaFailureRecoveryGate.reset();
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'preference' });
  }
  if (previous.replicaViewMode !== preferences.replicaViewMode) {
    applyReplicaViewMode(previous.replicaViewMode);
  }
  syncPreferenceControls();
  updateMirrorLayout();
  if (visualRoot) applyMirrorTextLayout(visualRoot, preferences.textLayoutMode);
  if (
    snapshot &&
    (previous.sourceLanguage !== preferences.sourceLanguage ||
      previous.targetLanguage !== preferences.targetLanguage)
  ) {
    const needsFreshCapture = releaseReplicaPresentationForLegacyWork();
    activeAbortController?.abort();
    abortAndRequeueLiveDelta();
    invalidateComposerOutput();
    if (!isLiveSourceOnlyMode()) translationDesired = true;
    translationComplete = false;
    availabilityCheckedForPair = undefined;
    resetVisualMirrorTextIfPresent();
    if (needsFreshCapture) {
      const identity = followedPageIdentity ?? capturedPageIdentity;
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
  await Promise.all([loadPreferences(), loadPanelWindowId()]);
  await refreshImageCaptureAccess();
  applyReplicaEnginePreference();
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
    preferences = (await sendPreferenceCommand({ type: 'simul:preferences:reconcile' })).preferences;
  } catch {
    try {
      const stored = await browser.storage.local.get(STORAGE_KEY);
      preferences = parseCompanionPreferences(stored[STORAGE_KEY]);
    } catch {
      preferences = parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES);
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
  preferences = withViewSettings(preferences, patch);
  syncPreferenceControls();
  const revision = ++viewPreferenceRevision;
  for (const [key, value] of Object.entries(patch)) {
    pendingViewPreferences.set(key as keyof CompanionViewSettings, {
      revision,
      value: value as CompanionViewSettings[keyof CompanionViewSettings],
    });
  }
  try {
    const result =
      await sendPreferenceCommand({
        type: 'simul:preferences:patch-view',
        patch,
      });
    clearCommittedViewPreferences(patch, revision);
    preferences = mergePendingViewPreferences(result.preferences);
    syncPreferenceControls();
    updateMirrorLayout();
    if (visualRoot) {
      applyMirrorTextLayout(visualRoot, preferences.textLayoutMode);
    }
    return true;
  } catch (error) {
    clearCommittedViewPreferences(patch, revision);
    try {
      preferences = mergePendingViewPreferences(await readStoredPreferences());
      syncPreferenceControls();
      updateMirrorLayout();
      if (visualRoot) {
        applyMirrorTextLayout(visualRoot, preferences.textLayoutMode);
      }
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
  preferences = withImageAnalysisSettings(preferences, patch);
  syncPreferenceControls();
  const revision = ++imageAnalysisPreferenceRevision;
  for (const [key, value] of Object.entries(patch)) {
    pendingImageAnalysisPreferences.set(
      key as keyof CompanionImageAnalysisSettings,
      {
        revision,
        value: value as CompanionImageAnalysisSettings[
          keyof CompanionImageAnalysisSettings
        ],
      },
    );
  }
  try {
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:patch-image-analysis',
      patch,
    });
    clearCommittedImageAnalysisPreferences(patch, revision);
    preferences = mergePendingViewPreferences(result.preferences);
    syncPreferenceControls();
  } catch (error) {
    clearCommittedImageAnalysisPreferences(patch, revision);
    try {
      preferences = mergePendingViewPreferences(await readStoredPreferences());
      syncPreferenceControls();
    } catch {
      // A later storage event can reconcile optimistic controls.
    }
    setStatus(`Could not save image options: ${readableError(error)}`, 'error');
  }
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
      'Image access was removed. Your image-translation setting is saved but paused; open options and choose Grant image access to resume.',
      'warning',
    );
  }
}

async function changeImageTranslationEnabled(enabled: boolean): Promise<void> {
  if (permissionInFlight) {
    syncPreferenceControls();
    return;
  }
  permissionInFlight = true;
  renderImageAnalysisControls();
  updateControls();
  try {
    if (!navigator.locks) throw new Error('Chrome Web Locks are unavailable.');
    const outcome = await navigator.locks.request(
      PREFERENCE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return { kind: 'busy' } as const;
        const userActivationAvailable = navigator.userActivation.isActive;
        let freshPreferences: CompanionPreferences | undefined;
        let newlyGranted = false;
        let removedImageCaptureGrant = false;
        try {
          const hadImageCaptureGrant = await browser.permissions.contains({
            origins: [...ALL_SITES_PERMISSION_ORIGINS],
          });
          if (enabled && !hadImageCaptureGrant) {
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
            patch: { imageTranslationEnabled: enabled },
          });
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
      },
    );

    if (outcome.kind === 'busy') {
      await reloadPreferencesFromStorage();
      setStatus(
        'Another companion window is saving image access. Try again.',
        'warning',
      );
      return;
    }
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
          ? 'Image translation remains paused. Choose Grant image access when you are ready to retry.'
          : 'Chrome did not grant image access, so image translation remains off. You can retry from options.',
        'warning',
      );
      return;
    }

    preferences = mergePendingViewPreferences(outcome.result.preferences);
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

function clearCommittedViewPreferences(
  patch: CompanionViewSettingsPatch,
  revision: number,
): void {
  for (const key of Object.keys(patch) as Array<keyof CompanionViewSettings>) {
    if (pendingViewPreferences.get(key)?.revision === revision) {
      pendingViewPreferences.delete(key);
    }
  }
}

function clearCommittedImageAnalysisPreferences(
  patch: CompanionImageAnalysisSettingsPatch,
  revision: number,
): void {
  for (const key of Object.keys(patch) as Array<
    keyof CompanionImageAnalysisSettings
  >) {
    if (pendingImageAnalysisPreferences.get(key)?.revision === revision) {
      pendingImageAnalysisPreferences.delete(key);
    }
  }
}

function mergePendingViewPreferences(
  stored: CompanionPreferences,
): CompanionPreferences {
  const pending = Object.fromEntries(
    [...pendingViewPreferences].map(([key, entry]) => [key, entry.value]),
  ) as CompanionViewSettingsPatch;
  const pendingImage = Object.fromEntries(
    [...pendingImageAnalysisPreferences].map(([key, entry]) => [
      key,
      entry.value,
    ]),
  ) as CompanionImageAnalysisSettingsPatch;
  return withImageAnalysisSettings(
    withViewSettings(stored, pending),
    pendingImage,
  );
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
  }
}

async function followFocusedBrowserWindow(
  windowId: number,
  requestId: number,
): Promise<void> {
  try {
    const sourceWindow = await browser.windows.get(windowId);
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    if (sourceWindow.type !== undefined && sourceWindow.type !== 'normal') return;
    const [tab] = await browser.tabs.query({ active: true, windowId });
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    detachedSourceWindowId = windowId;
    if (tab?.id !== undefined) {
      await followActivatedSourceTab(tab.id, windowId, tab, requestId);
    }
  } catch {
    // A closing or restricted browser window is not a new source candidate.
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
  clearNavigationTimer();
  try {
    const sourceWindow = await browser.windows.get(windowId);
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    if (sourceWindow.type !== undefined && sourceWindow.type !== 'normal') return;
    const identity = identityFromTab(
      knownTab ?? await browser.tabs.get(tabId),
      undefined,
      true,
    );
    if (
      requestId !== identityRequestId ||
      preferences.popoutTabMode !== 'active'
    ) return;
    detachedSourceWindowId = windowId;
    if (sameCompanionSourcePage(
      followedPageIdentity,
      identity,
      normalizedPageUrl,
    )) return;
    queueCapture({ identity, reason: 'navigation' });
  } catch (error) {
    if (requestId !== identityRequestId) return;
    invalidateCompanion(
      `${readPageError(error)} Active-tab following needs page access for each newly selected site.`,
    );
  }
}

function queueCapture(request: CaptureRequest): void {
  const previousIdentity = capturedPageIdentity ?? followedPageIdentity;
  const samePage = sameCompanionSourcePage(
    previousIdentity,
    request.identity,
    normalizedPageUrl,
  );
  if (!samePage) liveReplicaFailureRecoveryGate.reset();
  if (!samePage || request.reason === 'navigation') {
    lastSourceScroll = undefined;
    visibleReplayHost.resetSourceScroll();
  }
  const retainTranslationIntent =
    samePage &&
    (request.reason === 'manual' ||
      request.reason === 'desynchronized' ||
      request.reason === 'preference');
  if (!retainTranslationIntent) {
    if (replicaTranslationMode === 'rrweb-projection') {
      replicaTranslationCoordinator.selectPair(undefined);
    }
    translationDesired = false;
    translationComplete = false;
    availabilityCheckedForPair = undefined;
    invalidateComposerOutput();
  }
  if (previousIdentity && previousIdentity.tabId !== request.identity.tabId) {
    releaseLiveSession(previousIdentity);
  }
  activeAbortController?.abort();
  liveDeltaAbortController?.abort();
  replicaShadowAbortController?.abort();
  pendingImageReplicaActivation = undefined;
  imageTranslationController.releaseReplica();
  availabilityRequestId += 1;
  pendingLiveUpdate = undefined;
  latestLiveSequence = 0;
  highestReceivedLiveSequence = 0;
  liveSequenceBaselineReady = false;
  followedPageIdentity = request.identity;
  if (!snapshot) renderLoadingState();
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
    void processPendingLiveUpdate();
  }
}

async function capturePage(work: GenerationWork<CaptureRequest>): Promise<void> {
  const identity = work.value.identity;
  let currentLegacyReady = false;
  try {
    const observerResults = await withCaptureTimeout(
      browser.scripting.executeScript({
        target: { tabId: identity.tabId, frameIds: [0] },
        func: installLivePageObserver,
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
    liveObservationAvailable = observerInstallation.installed;
    if (observerInstallation.installed) {
      initializeLiveSequenceBaseline(
        work.generation,
        observerInstallation.sequence,
      );
    }
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
    // New identities hand authority back to v1 before serialization. A
    // same-page manual/recovery rebuild keeps last-good visible while the
    // selected engine stages its replacement offscreen and swaps atomically.
    if (!preserveLastGoodReplica) {
      releaseReplicaPresentationForLegacyWork(true);
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
    assertSnapshotIsCurrent(currentTab, identity);
    if (!captureCoordinator.isCurrent(work.generation)) return;

    translationComplete = false;
    renderSnapshot(nextSnapshot);
    snapshot = nextSnapshot;
    capturedPageIdentity = identity;
    capturedPageDocumentId = typeof snapshotInjection?.documentId === 'string'
      ? snapshotInjection.documentId
      : undefined;
    followedPageIdentity = identity;
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

    if (isLiveSourceOnlyMode()) {
      availability = 'unavailable';
      availabilityCheckedForPair = undefined;
      setStatus(
        'Live source only is active. The sanitized mirror keeps updating without text or image translation.',
        'success',
      );
      return;
    }

    if (currentTranslationFieldCount(visualRoot as HTMLElement) === 0) {
      availability = 'unavailable';
      availabilityCheckedForPair = undefined;
      const accessWasRevoked = await reconcileAutomaticAccess(identity.url);
      if (!captureCoordinator.isCurrent(work.generation)) return;
      setStatus(
        accessWasRevoked
          ? 'Chrome removed a saved automatic-access grant. The mirror is waiting for page text.'
          : liveObservationAvailable
            ? 'The page mirror is live and will prepare translation when visible text arrives.'
            : 'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
        'warning',
      );
      return;
    }
    await checkAvailability(work.generation);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    const accessWasRevoked = await reconcileAutomaticAccess(identity.url);
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (accessWasRevoked) {
      setStatus('Chrome removed a saved automatic-access grant, so that scope was turned off.', 'warning');
      return;
    }
    await maybeTranslateAutomatically(work.generation, identity.url);
    if (!liveObservationAvailable && captureCoordinator.isCurrent(work.generation)) {
      setStatus(
        'The page was captured, but live updates are unavailable because too many companion views are open. Close one and refresh.',
        'warning',
      );
    }
  } catch (error) {
    if (!captureCoordinator.isCurrent(work.generation)) return;
    if (shouldReleaseReplicaAfterCaptureFailure(
      currentLegacyReady,
      capturedPageIdentity === identity,
      visibleReplayHost.hasCommittedReplica,
    )) {
      imageTranslationController.releaseReplica();
      replicaEngineController.releasePresentation(true);
    }
    const message = readPageError(error);
    if (!snapshot) renderErrorState(message);
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
    sessionId: liveSessionId,
    pageEpoch: work.generation,
    generation: work.generation,
    tabId: identity.tabId,
    frameId: 0,
    documentId,
    isCurrent: () =>
      captureCoordinator.isCurrent(work.generation) &&
      capturedPageIdentity === identity &&
      followedPageIdentity?.tabId === identity.tabId &&
      normalizedPageUrl(followedPageIdentity.url) === normalizedPageUrl(identity.url),
  };
  let shadowCommitted = false;
  const imageActivation: PendingImageReplicaActivation = {
    request,
    sourceWindowId: identity.windowId,
    mode: replicaEngineController.mode,
    signal: abortController.signal,
    activated: false,
  };
  pendingImageReplicaActivation = imageActivation;
  const shadowOwnershipStarted = replicaEngineController.shadowAvailable;
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
          pendingImageReplicaActivation === imageActivation &&
          !imageActivation.signal.aborted &&
          imageActivation.mode === replicaEngineController.mode &&
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
      updateMirrorLayout();
    }
  } finally {
    if (pendingImageReplicaActivation === imageActivation) {
      pendingImageReplicaActivation = undefined;
    }
    if (shadowOwnershipStarted && !shadowCommitted) {
      const needsFreshCapture = legacyTransitionGate.release();
      if (needsFreshCapture && request.isCurrent()) {
        queueCapture({ identity, reason: 'desynchronized' });
      }
    }
    if (
      replicaShadowAbortController === abortController &&
      !visibleReplayHost.hasCommittedReplica
    ) {
      replicaShadowAbortController = undefined;
    }
  }
}

async function captureReplicaCheckpoint(
  request: ReplicaCaptureRequest,
  signal?: AbortSignal,
): Promise<ReplicaCheckpointResponse> {
  signal?.throwIfAborted();
  if (!request.isCurrent()) {
    throw new ReplicaCaptureBoundaryError('stale_identity');
  }
  const injectionResults = await browser.scripting.executeScript({
    target: { tabId: request.tabId, documentIds: [request.documentId] },
    files: ['/page-recorder.js'],
  });
  signal?.throwIfAborted();
  const injection = injectionResults.find(
    (result) =>
      result.frameId === request.frameId &&
      result.documentId === request.documentId,
  );
  if (!injection || !request.isCurrent()) {
    throw new ReplicaCaptureBoundaryError('stale_identity');
  }
  const expectedIdentity = createReplicaIdentity({
    sessionId: request.sessionId,
    pageEpoch: request.pageEpoch,
    generation: request.generation,
    documentId: request.documentId,
    frameId: request.frameId,
    sequence: 0,
  });
  const response: unknown = await browser.tabs.sendMessage(
    request.tabId,
    createCheckpointCommand(expectedIdentity),
    { documentId: request.documentId },
  );
  signal?.throwIfAborted();
  if (!request.isCurrent()) {
    throw new ReplicaCaptureBoundaryError('stale_identity');
  }
  const checkpoint = readCheckpointResponse(response, expectedIdentity);
  if (!checkpoint) {
    throw new ReplicaCaptureBoundaryError('invalid_message');
  }
  return checkpoint;
}

interface LiveLanguageContext {
  documentLanguage?: string;
  visibleText: string;
  preserveOnUnknown: boolean;
}

async function resolveSelectedSourceLanguage(
  liveContext?: LiveLanguageContext,
): Promise<boolean> {
  if (!snapshot) {
    resolvedSourceLanguage = undefined;
    syncQuickTranslationPanel();
    configureImageTranslation();
    return true;
  }
  if (liveContext) {
    const { documentLanguage: _previousLanguage, ...snapshotWithoutLanguage } =
      snapshot;
    snapshot = liveContext.documentLanguage
      ? {
          ...snapshotWithoutLanguage,
          documentLanguage: liveContext.documentLanguage,
        }
      : snapshotWithoutLanguage;
  }
  const requestedSnapshot = snapshot;
  const requestedPreference = preferences.sourceLanguage;
  const previousLanguage = resolvedSourceLanguage;
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
    snapshot !== requestedSnapshot ||
    preferences.sourceLanguage !== requestedPreference
  ) return false;
  resolvedSourceLanguage =
    detected.language ??
    (liveContext?.preserveOnUnknown ? previousLanguage : undefined);
  detectedLanguageElement.textContent = resolvedSourceLanguage
    ? requestedPreference === 'auto'
      ? detected.language
        ? `Detected ${languageName(resolvedSourceLanguage)} from ${detected.source === 'html' ? 'the page language' : 'visible page text'}.`
        : `Using the previously detected ${languageName(resolvedSourceLanguage)} source language.`
      : ''
    : 'The page language could not be detected. Choose a From language.';
  detectedLanguageElement.hidden = !detectedLanguageElement.textContent;
  syncQuickTranslationPanel();
  configureImageTranslation();
  return true;
}

function mirrorLanguageSample(): string {
  if (usesReplicaTranslationProjection()) {
    return buildBoundedLanguageSample(
      replicaRecordSources(replicaSurfaceRouter.snapshot()?.records ?? []),
    );
  }
  if (!visualRoot) return '';
  const parts = [visualRoot.textContent ?? ''];
  for (const image of visualRoot.querySelectorAll('img[alt]')) {
    const alt = image.getAttribute('alt');
    if (alt) parts.push(alt);
  }
  return parts.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 20_000);
}

function currentTranslationFieldCount(root: HTMLElement): number {
  return usesReplicaTranslationProjection()
    ? replicaSurfaceRouter.snapshot()?.records.filter(
      ({ source }) => source.trim().length > 0,
    ).length ?? 0
    : countVisualMirrorTranslationFields(root);
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
    invalidateComposerOutput();
    replicaTranslationCoordinator.selectPair(nextPair);
  }
  const expectedAvailabilityKey = nextPair
    ? availabilityPairKey(nextPair, generation)
    : undefined;
  const needsPreparation =
    prepareForNewText &&
    currentTranslationFieldCount(visualRoot as HTMLElement) > 0 &&
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
  const needsFreshCapture = releaseReplicaPresentationForLegacyWork();
  activeAbortController?.abort();
  abortAndRequeueLiveDelta();
  invalidateComposerOutput();
  if (!isLiveSourceOnlyMode()) translationDesired = true;
  translationComplete = false;
  availabilityCheckedForPair = undefined;
  resetVisualMirrorTextIfPresent();
  await commitViewPreferencePatch({ sourceLanguage, targetLanguage });
  if (needsFreshCapture) {
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) {
      queueCapture({ identity, reason: 'preference' });
      return;
    }
  }
  await applyLanguagePreferences(true);
}

async function applyLanguagePreferences(fromUserAction: boolean): Promise<void> {
  if (!snapshot) return;
  await resolveSelectedSourceLanguage();
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
  if (replicaTranslationMode === 'rrweb-projection') {
    replicaTranslationCoordinator.selectPair(selectedPair());
  }
  await checkAvailability(captureCoordinator.generation);
  if (availability === 'available') {
    await startTranslation(!fromUserAction, captureCoordinator.generation);
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
  if (replicaTranslationMode === 'rrweb-projection') {
    replicaTranslationCoordinator.selectPair(pair);
  }
  if (
    !requestedSnapshot ||
    !visualRoot ||
    !pair ||
    currentTranslationFieldCount(visualRoot) === 0
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
  availabilityCheckedForPair = checkedPairKey;
  availability = 'unavailable';
  updateControls();
  if (pair.sourceLanguage === pair.targetLanguage) {
    availability = 'available';
    resetVisualMirrorTextIfPresent();
    translationComplete = true;
    setStatus('The source and target languages match, so the original text is unchanged.', 'success');
    updateControls();
    return;
  }
  try {
    const next = await provider.availability(pair);
    if (!isCurrentAvailabilityRequest(requestId, requestedSnapshot, pair, generation)) return;
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
  const needsFreshCapture = releaseReplicaPresentationForLegacyWork();
  if (needsFreshCapture) {
    translationDesired = true;
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'desynchronized' });
    return Promise.resolve();
  }
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
    void processPendingLiveUpdate();
  }, () => {
    if (activeTranslationTask === task) {
      activeTranslationTask = undefined;
      activeTranslationKey = undefined;
    }
    void processPendingLiveUpdate();
  });
  return task;
}

async function runTranslation(automatic: boolean, generation: number): Promise<void> {
  const pair = selectedPair();
  const root = visualRoot;
  const identity = capturedPageIdentity;
  if (
    !pair ||
    !root ||
    !identity ||
    isLiveSourceOnlyMode() ||
    translationInFlight ||
    availability === 'unavailable' ||
    (automatic && availability !== 'available')
  ) return;
  if (pair.sourceLanguage === pair.targetLanguage) {
    if (usesReplicaTranslationProjection()) {
      replicaTranslationCoordinator.selectPair(pair);
    }
    resetVisualMirrorText(root);
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
  showProgress('Preparing Chrome\'s on-device language model…', 0, 1);
  updateControls();
  let session: TranslationSession | undefined;
  try {
    const tab = await browser.tabs.get(identity.tabId);
    assertSnapshotIsCurrent(tab, identity);
    if (
      !captureCoordinator.isCurrent(generation) ||
      visualRoot !== root ||
      !isCurrentTranslationPair(pair) ||
      isLiveSourceOnlyMode()
    ) return;
    availability = 'available';
    availabilityCheckedForPair = availabilityPairKey(pair, generation);
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
      visualRoot !== root ||
      !isCurrentTranslationPair(pair) ||
      isLiveSourceOnlyMode()
    ) return;
    if (usesReplicaTranslationProjection()) {
      const replicaResult = result as ReplicaTranslationRunResult;
      translationComplete =
        replicaResult.total > 0 &&
        replicaTranslationCoordinator.isResultCurrent(replicaResult) &&
        isCompleteReplicaTranslationResult(replicaResult);
      setStatus(
        translationComplete
          ? automatic
            ? 'Automatic translation is complete and live updates will translate as they arrive.'
            : 'Translation is complete and live updates will translate as they arrive.'
          : describePartialReplicaTranslation(
            replicaResult,
            'Translation remains partial',
          ),
        translationComplete ? 'success' : 'warning',
      );
    } else {
      translationComplete = result.failed === 0;
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
        !isLiveSourceOnlyMode() &&
        captureCoordinator.isCurrent(generation) &&
        visualRoot === root &&
        isCurrentTranslationPair(pair)
      ) {
        setStatus('Translation cancelled. Existing translated text was kept.', 'warning');
      }
    } else if (!isLiveSourceOnlyMode()) {
      setStatus(readableError(error), 'error');
    }
  } finally {
    session?.destroy();
    logTranslationCache('page', translationMemory);
    if (activeAbortController === abortController) activeAbortController = undefined;
    translationInFlight = false;
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
  latestLiveSequence = sequence;
  highestReceivedLiveSequence = sequence;
  liveSequenceBaselineReady = true;
  if (!pendingLiveUpdate || pendingLiveUpdate.generation !== generation) return;
  if (pendingLiveUpdate.sequence <= sequence) {
    pendingLiveUpdate = undefined;
    return;
  }
  if (pendingLiveUpdate.firstSequence > sequence + 1) {
    pendingLiveUpdate = undefined;
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) queueCapture({ identity, reason: 'desynchronized' });
    return;
  }
  highestReceivedLiveSequence = pendingLiveUpdate.sequence;
}

function queueLiveUpdate(message: LivePageDirtyMessage): void {
  if (message.sequence <= latestLiveSequence) return;
  if (legacyTransitionGate.markDirty()) return;
  if (
    liveSequenceBaselineReady &&
    highestReceivedLiveSequence > 0 &&
    message.sequence > highestReceivedLiveSequence + 1
  ) {
    releaseReplicaPresentationForLegacyWork();
    const identity = followedPageIdentity ?? capturedPageIdentity;
    if (identity) {
      setStatus('A live update was missed. Rebuilding once while keeping the current mirror visible…', 'warning');
      queueCapture({ identity, reason: 'desynchronized' });
    }
    return;
  }
  if (message.sequence <= highestReceivedLiveSequence) return;
  highestReceivedLiveSequence = message.sequence;
  if (!pendingLiveUpdate || pendingLiveUpdate.generation !== message.generation) {
    pendingLiveUpdate = {
      generation: message.generation,
      firstSequence: message.sequence,
      sequence: message.sequence,
      nodeIds: new Set(message.nodeIds),
    };
  } else {
    pendingLiveUpdate.sequence = Math.max(pendingLiveUpdate.sequence, message.sequence);
    for (const nodeId of message.nodeIds) pendingLiveUpdate.nodeIds.add(nodeId);
  }
  releaseReplicaPresentationForLegacyWork();
  void processPendingLiveUpdate();
}

async function processPendingLiveUpdate(): Promise<void> {
  if (
    liveDeltaInFlight ||
    captureInFlight ||
    translationInFlight ||
    !pendingLiveUpdate ||
    !capturedPageIdentity ||
    !visualRoot ||
    legacyTransitionGate.shadowOwnsPage
  ) return;
  const update = pendingLiveUpdate;
  pendingLiveUpdate = undefined;
  const requestedNodeIds = [...update.nodeIds];
  const nodeIds = requestedNodeIds.slice(0, 48);
  if (requestedNodeIds.length > nodeIds.length) {
    pendingLiveUpdate = {
      generation: update.generation,
      firstSequence: update.firstSequence,
      sequence: update.sequence,
      nodeIds: new Set(requestedNodeIds.slice(48)),
    };
  }
  if (!captureCoordinator.isCurrent(update.generation)) return;
  const identity = capturedPageIdentity;
  const beforeRoot = visualRoot;
  const abortController = new AbortController();
  const activeUpdate: PendingLiveUpdate = {
    generation: update.generation,
    firstSequence: update.firstSequence,
    sequence: update.sequence,
    nodeIds: new Set(nodeIds),
  };
  activeLiveUpdate = activeUpdate;
  liveDeltaAbortController = abortController;
  liveDeltaInFlight = true;
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
      delta.sequence < latestLiveSequence ||
      normalizedPageUrl(delta.url) !== normalizedPageUrl(identity.url)
    ) return;
    if (delta.desynchronized) {
      queueCapture({ identity: capturedPageIdentity, reason: 'desynchronized' });
      return;
    }
    const pairBeforeRefresh = selectedPair();
    let pairChanged = false;
    const visibleLanguageText = liveDeltaLanguageSample(delta);
    if (preferences.sourceLanguage === 'auto') {
      const resolutionCommitted = await resolveSelectedSourceLanguage({
        documentLanguage: delta.documentLanguage,
        visibleText: visibleLanguageText,
        preserveOnUnknown: true,
      });
      if (
        !resolutionCommitted ||
        abortController.signal.aborted ||
        visualRoot !== beforeRoot ||
        !captureCoordinator.isCurrent(delta.generation)
      ) return;
      const refreshedPair = selectedPair();
      pairChanged = !sameTranslationPair(pairBeforeRefresh, refreshedPair);
      if (pairChanged) {
        availabilityCheckedForPair = undefined;
        translationComplete = false;
        invalidateComposerOutput();
        resetVisualMirrorText(beforeRoot);
      }
      await checkAvailability(delta.generation);
      if (
        abortController.signal.aborted ||
        visualRoot !== beforeRoot ||
        !captureCoordinator.isCurrent(delta.generation) ||
        (refreshedPair && !isCurrentTranslationPair(refreshedPair))
      ) return;
    }

    const pair = selectedPair();
    const wantsTranslation =
      !isLiveSourceOnlyMode() &&
      (translationDesired || isAutoTranslationEnabled(preferences, identity.url));
    const shouldTranslate = Boolean(
      pair &&
      pair.sourceLanguage !== pair.targetLanguage &&
      wantsTranslation &&
      !pairChanged &&
      availability === 'available',
    );
    if (shouldTranslate && pair) {
      session = await provider.createSession(pair, { signal: abortController.signal });
    }
    const applied = await applyLivePageDelta(beforeRoot, delta, {
      textLayoutMode: preferences.textLayoutMode,
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
      visualRoot !== beforeRoot ||
      !captureCoordinator.isCurrent(delta.generation) ||
      (pair && !isCurrentTranslationPair(pair))
    ) return;
    visualRoot = applied.root;
    mirrorDocumentWidth = delta.documentWidth;
    mirrorDocumentHeight = delta.documentHeight;
    latestLiveSequence = delta.sequence;
    if (activeLiveUpdate === activeUpdate) activeLiveUpdate = undefined;
    updateMirrorLayout();
    if (applied.missingTarget) {
      queueCapture({ identity, reason: 'desynchronized' });
      return;
    }
    if (applied.translation.failed > 0) {
      translationComplete = false;
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
    if (currentTranslationFieldCount(visualRoot) > 0) {
      const currentPair = selectedPair();
      const pairKey = currentPair
        ? availabilityPairKey(currentPair, update.generation)
        : undefined;
      if (!currentPair || availabilityCheckedForPair !== pairKey) {
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
    if (!abortController.signal.aborted && capturedPageIdentity) {
      setStatus(`A live update could not be applied: ${readableError(error)}`, 'warning');
      queueCapture({ identity: capturedPageIdentity, reason: 'desynchronized' });
    }
  } finally {
    session?.destroy();
    if (liveDeltaAbortController === abortController) {
      liveDeltaAbortController = undefined;
    }
    if (activeLiveUpdate === activeUpdate) activeLiveUpdate = undefined;
    liveDeltaInFlight = false;
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

function renderSnapshot(page: PageSnapshot): void {
  disconnectMirror();
  const article = document.createElement('article');
  article.className = 'page-copy';
  const mirror = createVisualMirror(page, undefined, document);
  if (mirror && page.visual) {
    const scroller = document.createElement('div');
    scroller.className = 'mirror-scroll';
    const stage = document.createElement('div');
    stage.className = 'mirror-stage';
    const scaleLayer = document.createElement('div');
    scaleLayer.className = 'mirror-scale-layer';
    scaleLayer.append(mirror);
    stage.append(scaleLayer);
    scroller.append(stage);
    article.append(scroller);
    snapshotContainer.replaceChildren(article);

    visualRoot = mirror;
    mirrorScroller = scroller;
    mirrorStage = stage;
    mirrorScaleLayer = scaleLayer;
    mirrorViewportWidth = page.visual.viewportWidth;
    mirrorDocumentWidth = page.visual.documentWidth;
    mirrorDocumentHeight = page.visual.documentHeight;
    applyMirrorTextLayout(mirror, preferences.textLayoutMode);
    updateMirrorLayout();
    if (typeof ResizeObserver === 'function') {
      mirrorResizeObserver = new ResizeObserver(updateMirrorLayout);
      mirrorResizeObserver.observe(scroller);
      mirrorResizeObserver.observe(scaleLayer);
    }
    requestAnimationFrame(updateMirrorLayout);
    return;
  }
  renderFlatSnapshot(article, page);
  snapshotContainer.replaceChildren(article);
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
  if (!mirrorScroller || !mirrorStage || !mirrorScaleLayer || !visualRoot) return;
  const scale = computeMirrorScale(
    mirrorScroller.clientWidth,
    mirrorViewportWidth,
    preferences.displayMode,
    preferences.zoomPercent,
  );
  currentMirrorScale = scale;
  mirrorScaleLayer.style.width = `${mirrorViewportWidth}px`;
  mirrorScaleLayer.style.minHeight = `${mirrorDocumentHeight}px`;
  visualRoot.style.width = `${mirrorViewportWidth}px`;
  const extent = computeMirrorExtent(
    scale,
    mirrorDocumentWidth,
    mirrorDocumentHeight,
    Math.max(mirrorScaleLayer.scrollWidth, visualRoot.scrollWidth),
    Math.max(mirrorScaleLayer.scrollHeight, visualRoot.scrollHeight),
  );
  mirrorScaleLayer.style.transform = `scale(${scale})`;
  mirrorStage.style.width = `${extent.width}px`;
  mirrorStage.style.height = `${extent.height}px`;
  if (preferences.syncScroll && lastSourceScroll) followSourceScroll(lastSourceScroll);
}

function followSourceScroll(scroll: NonNullable<typeof lastSourceScroll>): void {
  visibleReplayHost.followSourceScroll(scroll);
  if (!mirrorScroller) return;
  const maxMirrorX = Math.max(0, mirrorScroller.scrollWidth - mirrorScroller.clientWidth);
  const maxMirrorY = Math.max(0, mirrorScroller.scrollHeight - mirrorScroller.clientHeight);
  const faithful = preferences.textLayoutMode === 'faithful' &&
    scroll.scrollTarget !== 'nested';
  mirrorScroller.scrollLeft = faithful
    ? Math.min(maxMirrorX, scroll.scrollX * currentMirrorScale)
    : scroll.maxScrollX > 0
      ? (scroll.scrollX / scroll.maxScrollX) * maxMirrorX
      : 0;
  mirrorScroller.scrollTop = faithful
    ? Math.min(maxMirrorY, scroll.scrollY * currentMirrorScale)
    : scroll.maxScrollY > 0
      ? (scroll.scrollY / scroll.maxScrollY) * maxMirrorY
      : 0;
}

function disconnectMirror(): void {
  mirrorResizeObserver?.disconnect();
  mirrorResizeObserver = undefined;
  visualRoot = undefined;
  mirrorScroller = undefined;
  mirrorStage = undefined;
  mirrorScaleLayer = undefined;
}

function resetVisualMirrorTextIfPresent(): void {
  if (visualRoot) resetVisualMirrorText(visualRoot);
}

function renderFlatSnapshot(article: HTMLElement, page: PageSnapshot): void {
  for (const item of page.items) {
    if (item.kind === 'text') {
      article.append(renderText(item.role, item.text));
      continue;
    }
    const image = document.createElement('img');
    image.className = 'translated-image';
    image.src = item.src;
    image.alt = item.altText ?? '';
    image.referrerPolicy = 'no-referrer';
    article.append(image);
  }
  if (page.items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No eligible visible content was found.';
    article.append(empty);
  }
}

function renderText(role: SnapshotTextRole, text: string): HTMLElement {
  const element = role.startsWith('heading-')
    ? document.createElement(
        `h${Math.min(6, Math.max(2, Number(role.at(-1))))}` as keyof HTMLElementTagNameMap,
      )
    : role === 'quote'
      ? document.createElement('blockquote')
      : role === 'code'
        ? document.createElement('pre')
        : document.createElement('p');
  element.className = 'translated-text';
  element.textContent = text;
  element.dir = 'auto';
  return element;
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
  renderToolbarAttention();
  if (settingsOpen) {
    closeSettingsButton.focus();
    return;
  }
  if (quickTranslateOpen) {
    syncQuickTranslationPanel();
    composerInput.focus();
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
  element.dataset.uiLabel = english;
  const translated = uiLocalizedTarget === preferences.targetLanguage
    ? uiLabelTranslations.get(english)
    : undefined;
  const text = translated ?? english;
  if (element.textContent !== text) element.textContent = text;
  if (translated && translated !== english) element.lang = uiLocalizedTarget;
  else element.removeAttribute('lang');
  if (
    preferences.targetLanguage !== 'en' &&
    !uiLabelTranslations.has(english)
  ) {
    if (uiLabelTranslations.size > 0) {
      prepareUiEnglishFallback(preferences.targetLanguage, true);
    }
    scheduleUiLocalization();
  }
}

function scheduleUiLocalization(): void {
  prepareUiEnglishFallback(preferences.targetLanguage);
  if (uiLocalizationScheduled) return;
  uiLocalizationScheduled = true;
  queueMicrotask(() => {
    uiLocalizationScheduled = false;
    void localizeUiLabels();
  });
}

function prepareUiEnglishFallback(
  targetLanguage: SupportedLanguage,
  force = false,
): void {
  if (uiLocalizedTarget === targetLanguage && !force) return;
  uiLocalizationAbortController?.abort();
  uiLocalizationInputKey = '';
  uiLabelTranslations = new Map();
  uiLocalizedTarget = targetLanguage;
  applyUiLabelsToDom();
}

async function localizeUiLabels(): Promise<void> {
  const targetLanguage = preferences.targetLanguage;
  prepareUiEnglishFallback(targetLanguage);
  const sources = [...new Set(
    [
      ...DYNAMIC_UI_LABELS,
      ...[...document.querySelectorAll<HTMLElement>('[data-ui-label]')]
        .map((element) => element.dataset.uiLabel ?? '')
        .filter(Boolean),
    ],
  )];
  const inputKey = JSON.stringify([targetLanguage, sources]);
  if (uiLocalizationInputKey === inputKey) return;
  uiLocalizationInputKey = inputKey;
  const requestId = ++uiLocalizationRequestId;
  uiLocalizationAbortController?.abort();
  const abortController = new AbortController();
  uiLocalizationAbortController = abortController;
  const pair: TranslationPair = {
    sourceLanguage: 'en',
    targetLanguage,
  };
  let session: TranslationSession | undefined;
  let sessionTask: Promise<TranslationSession> | undefined;
  try {
    const result = await resolveUiLabelTranslations(
      sources,
      targetLanguage,
      (source) => translateRemembered(pair, source, async (core) => {
        sessionTask ??= (async () => {
          const uiAvailability = await provider.availability(pair);
          abortController.signal.throwIfAborted();
          if (uiAvailability === 'unavailable') {
            throw new Error('The UI language pair is unavailable.');
          }
          return provider.createSession(pair, {
            signal: abortController.signal,
          });
        })();
        session = await sessionTask;
        return translateWithSession(session, core, abortController.signal);
      }),
    );
    if (
      abortController.signal.aborted ||
      uiLocalizationAbortController !== abortController ||
      requestId !== uiLocalizationRequestId ||
      preferences.targetLanguage !== targetLanguage ||
      uiLocalizationInputKey !== inputKey
    ) return;
    uiLocalizedTarget = targetLanguage;
    uiLabelTranslations = result.labels;
    applyUiLabelsToDom();
  } finally {
    session?.destroy();
    if (uiLocalizationAbortController === abortController) {
      uiLocalizationAbortController = undefined;
    }
  }
}

function applyUiLabelsToDom(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-ui-label]')) {
    const english = element.dataset.uiLabel;
    if (!english) continue;
    const translated = uiLabelTranslations.get(english) ?? english;
    if (element.textContent !== translated) element.textContent = translated;
    if (translated === english) element.removeAttribute('lang');
    else element.lang = uiLocalizedTarget;
  }
  updateSourceLanguageOptionLabels(preferences.targetLanguage);
}

function updateSourceLanguageOptionLabels(locale: SupportedLanguage): void {
  const labelLanguage = createSourceLanguageLabeler(locale);
  for (const option of document.querySelectorAll<HTMLOptionElement>(
    '#source-language [data-language-code]',
  )) {
    const language = option.dataset.languageCode as SupportedLanguage | undefined;
    if (!language) continue;
    option.textContent = labelLanguage(language);
    option.lang = locale;
    option.dir = 'auto';
  }
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
    setUiText(replicaModeBadge, english);
  }).observe(replicaModeBadge, { childList: true, characterData: true });
}

function setZoom(value: number): void {
  const zoomPercent = clampZoomPercent(value);
  void commitViewPreferencePatch({
    displayMode: 'custom',
    zoomPercent,
  });
  updateMirrorLayout();
}

async function changePopoutTabMode(popoutTabMode: PopoutTabMode): Promise<void> {
  const saved = await commitViewPreferencePatch({ popoutTabMode });
  if (!saved || preferences.popoutTabMode !== popoutTabMode) return;
  if (isDetachedWindow && popoutTabMode === 'active') {
    await followCurrentActiveSourceTab();
  }
}

async function changeReplicaEngine(
  replicaEngine: ReplicaEnginePreference,
): Promise<void> {
  if (replicaEngine === preferences.replicaEngine) return;
  liveReplicaFailureRecoveryGate.reset();
  activeAbortController?.abort();
  replicaShadowAbortController?.abort();
  imageTranslationController.releaseReplica();
  replicaTranslationCoordinator.selectPair(undefined);
  legacyTransitionGate.release();
  await commitViewPreferencePatch({ replicaEngine });
  applyReplicaEnginePreference();
  const identity = followedPageIdentity ?? capturedPageIdentity;
  if (identity) queueCapture({ identity, reason: 'preference' });
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
      preferences.replicaFidelityPolicy !== replicaFidelityPolicy ||
      replicaEngineController.mode !== 'isolated-html'
    ) return;
    liveReplicaFailureRecoveryGate.reset();
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
  abortAndRequeueLiveDelta();
  replicaTranslationCoordinator.selectPair(undefined);
  resetVisualMirrorTextIfPresent();
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
    snapshot !== requestedSnapshot ||
    capturedPageIdentity !== identity ||
    !captureCoordinator.isCurrent(generation)
  ) return;
  const pair = selectedPair();
  if (replicaTranslationMode === 'rrweb-projection') {
    replicaTranslationCoordinator.selectPair(pair);
  }
  await checkAvailability(generation);
  if (
    isLiveSourceOnlyMode() ||
    !pair ||
    !isCurrentTranslationPair(pair) ||
    snapshot !== requestedSnapshot ||
    capturedPageIdentity !== identity ||
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
  const interrupted = activeLiveUpdate;
  if (
    interrupted &&
    interrupted.sequence > latestLiveSequence &&
    captureCoordinator.isCurrent(interrupted.generation)
  ) {
    const merged = mergeLiveUpdateBatches(pendingLiveUpdate, interrupted);
    pendingLiveUpdate = {
      ...merged,
      nodeIds: new Set(merged.nodeIds),
    };
  }
  liveDeltaAbortController?.abort();
}

function isLiveSourceOnlyMode(): boolean {
  return preferences.replicaViewMode === 'source-only';
}

function applyReplicaEnginePreference(): void {
  const nextMode = selectReplicaEngineMode(
    replicaBuildEnvironment,
    preferences.replicaEngine,
  );
  replicaEngineMode = nextMode;
  replicaEngineController.selectMode(nextMode);
  replicaSurfaceRouter.select(
    nextMode === 'rrweb-shadow'
      ? shadowReplicaEngine
      : nextMode === 'isolated-html'
        ? isolatedHtmlReplicaEngine
        : undefined,
  );
}

function syncPreferenceControls(): void {
  const pageUrl = followedPageIdentity?.url ?? capturedPageIdentity?.url;
  sourceSelect.value = preferences.sourceLanguage;
  targetSelect.value = preferences.targetLanguage;
  autoTranslateSelect.value = autoTranslationModeForPage(preferences, pageUrl);
  displayModeSelect.value = preferences.displayMode;
  textLayoutSelect.value = preferences.textLayoutMode;
  replicaFidelityPolicySelect.value = preferences.replicaFidelityPolicy;
  replicaEngineSelect.value =
    preferences.replicaEngine === 'rrweb' &&
    replicaBuildEnvironment.WXT_SIMUL_RRWEB_SHADOW === '0'
      ? 'isolated-html'
      : preferences.replicaEngine;
  replicaViewModeSelect.value = preferences.replicaViewMode;
  launchBehaviorSelect.value = preferences.launchBehavior;
  popoutTabModeSelect.value = preferences.popoutTabMode;
  syncScrollInput.checked = preferences.syncScroll;
  zoomInput.value = String(preferences.zoomPercent);
  zoomOutput.value = `${preferences.zoomPercent}%`;
  zoomInput.disabled = preferences.displayMode !== 'custom';
  syncToolbarPreferenceControls();
  syncQuickTranslationPanel();
  renderImageAnalysisControls();
  configureImageTranslation();
  scheduleUiLocalization();
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
  toolbarOcrToggleButton.title = preferences.imageTranslationEnabled
    ? imageCaptureAccess === 'granted'
      ? 'Image text translation is on. Click to turn it off.'
      : 'Image text translation is saved but needs image access. Click to grant access.'
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
  imageTranslationController.configure({
    enabled:
      preferences.imageTranslationEnabled &&
      imageCaptureAccess === 'granted' &&
      !isLiveSourceOnlyMode() &&
      hasCompiledImageAnalysisCapability(),
    scanPolicy: preferences.imageScanPolicy,
    skipSmallImages: preferences.skipSmallImages,
    providerOrder: effectiveCompiledProviderOrder(
      preferences.imageTextProviderOrder,
    ),
    sourceLanguage: preferences.sourceLanguage,
    ...(resolvedSourceLanguage
      ? { detectedSourceLanguage: resolvedSourceLanguage }
      : {}),
    targetLanguage: preferences.targetLanguage,
    translationIdle: !translationInFlight,
  });
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
  if (preferences.imageTranslationEnabled && imageCaptureAccess === 'missing') {
    setUiText(
      privacyNote,
      'Image translation is saved but paused. Grant image access so Chrome can capture visible pixels for local OCR.',
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
  if (preferences.imageTranslationEnabled && imageCaptureAccess === 'missing') {
    const grant = document.createElement('button');
    grant.type = 'button';
    grant.className = 'image-access-grant';
    setUiText(grant, 'Grant image access');
    grant.disabled = permissionInFlight;
    grant.addEventListener('click', () => {
      void changeImageTranslationEnabled(true);
    });
    root.append(grant);
  }

  const compiledOrder = effectiveCompiledProviderOrder(
    preferences.imageTextProviderOrder,
  );
  if (compiledOrder.length > 0) {
    const orderLabel = document.createElement('p');
    orderLabel.className = 'microcopy';
    setUiText(orderLabel, 'OCR priority');
    orderLabel.title = 'Simul tries locally available OCR providers from top to bottom.';
    root.append(orderLabel);
    const list = document.createElement('ol');
    list.className = 'ocr-provider-order';
    compiledOrder.forEach((id, index) => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = imageProviderName(id);
      item.append(name);
      const buttons = document.createElement('span');
      buttons.className = 'ocr-order-buttons';
      const up = createOrderButton('↑', 'Move earlier', index === 0, () =>
        moveCompiledProvider(compiledOrder, index, -1),
      );
      const down = createOrderButton(
        '↓',
        'Move later',
        index === compiledOrder.length - 1,
        () => moveCompiledProvider(compiledOrder, index, 1),
      );
      buttons.append(up, down);
      item.append(buttons);
      list.append(item);
    });
    root.append(list);

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
  }

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

function moveCompiledProvider(
  compiledOrder: readonly ImageTextProviderId[],
  index: number,
  direction: -1 | 1,
): void {
  const current = compiledOrder[index];
  const adjacent = compiledOrder[index + direction];
  if (!current || !adjacent) return;
  const next = [...preferences.imageTextProviderOrder];
  const currentIndex = next.indexOf(current);
  const adjacentIndex = next.indexOf(adjacent);
  if (currentIndex < 0 || adjacentIndex < 0) return;
  [next[currentIndex], next[adjacentIndex]] = [
    next[adjacentIndex]!,
    next[currentIndex]!,
  ];
  void commitImageAnalysisPreferencePatch({ imageTextProviderOrder: next });
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

function imageProviderName(id: ImageTextProviderId): string {
  const names: Record<ImageTextProviderId, string> = {
    'chrome-text-detector': 'Chrome Text Detector',
    tesseract: 'Tesseract.js',
    transformers: 'Transformers.js',
    'paddleocr-wasm': 'PaddleOCR Wasm',
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

function syncQuickTranslationPanel(): void {
  const pair = reverseTranslationPair(selectedPair());
  composerFromLanguage.textContent = localizedLanguageName(
    preferences.targetLanguage,
    preferences.targetLanguage,
  );
  composerFromLanguage.lang = preferences.targetLanguage;
  if (!pair) {
    setUiText(composerToLanguage, 'Waiting for website language');
    setUiText(
      composerGuidance,
      'Simul is still detecting the website language. If detection remains inconclusive, choose From in the toolbar.',
    );
    return;
  }
  delete composerToLanguage.dataset.uiLabel;
  composerToLanguage.textContent = localizedLanguageName(
    pair.targetLanguage,
    preferences.targetLanguage,
  );
  composerToLanguage.lang = preferences.targetLanguage;
  setUiText(
    composerGuidance,
    pair.sourceLanguage === pair.targetLanguage
      ? 'The languages match, so Simul will copy the text unchanged.'
      : 'Your draft stays only in this companion window and is not saved.',
  );
}

function localizedLanguageName(
  language: SupportedLanguage,
  locale: SupportedLanguage,
): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(language) ??
      languageName(language);
  } catch {
    return languageName(language);
  }
}

function setComposerStatus(
  message: string,
  tone: 'normal' | 'success' | 'warning' | 'error' = 'normal',
): void {
  composerStatus.textContent = message;
  composerStatus.dataset.tone = tone;
}

async function translateComposer(): Promise<void> {
  const text = composerInput.value;
  const forwardPair = selectedPair();
  const pair = reverseTranslationPair(forwardPair);
  if (!text.trim() || !forwardPair || !pair || composerInFlight) return;
  composerAbortController?.abort();
  const abortController = new AbortController();
  composerAbortController = abortController;
  composerInFlight = true;
  composerOutput.value = '';
  copyComposerButton.disabled = true;
  setComposerStatus('Translating locally…');
  updateControls();
  let session: TranslationSession | undefined;
  try {
    let translated: string;
    if (pair.sourceLanguage === pair.targetLanguage) {
      translated = text;
    } else {
      translated = await translateRemembered(pair, text, async (core) => {
        const composerAvailability = await provider.availability(pair);
        abortController.signal.throwIfAborted();
        if (composerAvailability === 'unavailable') {
          throw new Error('The reverse language pair is unavailable on this device.');
        }
        session = await provider.createSession(pair, {
          signal: abortController.signal,
        });
        return translateWithSession(session, core, abortController.signal);
      });
    }
    const currentForwardPair = selectedPair();
    if (
      abortController.signal.aborted ||
      composerAbortController !== abortController ||
      composerInput.value !== text ||
      !currentForwardPair ||
      currentForwardPair.sourceLanguage !== forwardPair.sourceLanguage ||
      currentForwardPair.targetLanguage !== forwardPair.targetLanguage
    ) return;
    composerOutput.value = translated;
    copyComposerButton.disabled = composerOutput.value.length === 0;
    setComposerStatus('Translation is ready to copy.', 'success');
    setStatus('Reply translation is ready to copy. It was not saved.', 'success');
    logTranslationCache('quick', translationMemory);
  } catch (error) {
    if (!isAbortError(error) && !abortController.signal.aborted) {
      const message = `Could not translate the reply: ${readableError(error)}`;
      setComposerStatus(message, 'error');
      setStatus(message, 'error');
    } else if (composerAbortController === abortController) {
      setComposerStatus('');
    }
  } finally {
    session?.destroy();
    if (composerAbortController === abortController) {
      composerAbortController = undefined;
      composerInFlight = false;
      updateControls();
    }
  }
}

function cancelComposerTranslation(): boolean {
  const abortController = composerAbortController;
  const wasInFlight = composerInFlight || abortController !== undefined;
  composerAbortController = undefined;
  composerInFlight = false;
  abortController?.abort();
  if (wasInFlight) setComposerStatus('');
  updateControls();
  return wasInFlight;
}

function invalidateComposerOutput(): void {
  cancelComposerTranslation();
  composerOutput.value = '';
  copyComposerButton.disabled = true;
  setComposerStatus('');
  updateControls();
}

async function copyComposerOutput(): Promise<void> {
  if (!composerOutput.value) return;
  try {
    await navigator.clipboard.writeText(composerOutput.value);
    setComposerStatus('Translated text copied.', 'success');
    setStatus('Translated reply copied.', 'success');
  } catch {
    composerOutput.focus();
    composerOutput.select();
    setComposerStatus(
      'Chrome could not copy automatically. The output is selected.',
      'warning',
    );
    setStatus('Chrome could not copy automatically. The result is selected for copying.', 'warning');
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
    if (!navigator.locks) throw new Error('Chrome Web Locks are unavailable.');
    const outcome = await navigator.locks.request(
      PREFERENCE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return { kind: 'busy' } as const;
        return performLockedAutoTranslationChange(mode, pageUrl, requestedOrigins);
      },
    );
    if (outcome.kind === 'busy') {
      await reloadPreferencesFromStorage();
      setStatus('Another companion window is saving this setting. Try again.', 'warning');
      return;
    }
    if (outcome.kind === 'activation') {
      await reloadPreferencesFromStorage();
      setStatus('Choose the setting again so Chrome can show its access prompt.', 'warning');
      return;
    }
    if (outcome.kind === 'limit') {
      preferences = mergePendingViewPreferences(outcome.preferences);
      syncPreferenceControls();
      setStatus('The saved-site limit has been reached.', 'warning');
      return;
    }
    if (outcome.kind === 'failed') {
      if (outcome.result) {
        preferences = mergePendingViewPreferences(outcome.result.preferences);
      }
      else await reloadPreferencesFromStorage();
      syncPreferenceControls();
      setStatus(`Chrome could not update automatic access: ${readableError(outcome.error)}`, 'error');
      return;
    }
    preferences = mergePendingViewPreferences(outcome.result.preferences);
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
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    if (repaired) preferences = mergePendingViewPreferences(repaired.preferences);
    else await reloadPreferencesFromStorage();
    syncPreferenceControls();
    setStatus(`Chrome could not update automatic access: ${readableError(error)}`, 'error');
  } finally {
    permissionInFlight = false;
    updateControls();
  }
}

async function performLockedAutoTranslationChange(
  mode: AutoTranslationMode,
  pageUrl: string | undefined,
  requestedOrigins: string[],
) {
  try {
    const freshPreferences = await readStoredPreferences();
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
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      });
      return { kind: 'denied', result } as const;
    }
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:commit-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    });
    return { kind: result.applied ? 'complete' : 'not-applied', result } as const;
  } catch (error) {
    const result = await sendPreferenceCommand({
      type: 'simul:preferences:abort-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    }).catch(() => undefined);
    return { kind: 'failed', error, result } as const;
  }
}

async function reconcileAutomaticAccess(pageUrl: string | undefined): Promise<boolean> {
  const before = autoTranslationModeForPage(preferences, pageUrl);
  const result = await sendPreferenceCommand({ type: 'simul:preferences:reconcile' });
  preferences = mergePendingViewPreferences(result.preferences);
  syncPreferenceControls();
  return before !== autoTranslationModeForPage(preferences, pageUrl);
}

async function readStoredPreferences(): Promise<CompanionPreferences> {
  const stored = await browser.storage.local.get(STORAGE_KEY);
  return parseCompanionPreferences(stored[STORAGE_KEY]);
}

async function reloadPreferencesFromStorage(): Promise<void> {
  try {
    preferences = mergePendingViewPreferences(await readStoredPreferences());
  } catch {
    preferences = mergePendingViewPreferences(
      parseCompanionPreferences(DEFAULT_COMPANION_PREFERENCES),
    );
  }
  syncPreferenceControls();
}

function scheduleNavigationRefresh(identity: CapturedPageIdentity): void {
  clearNavigationTimer();
  navigationTimer = setTimeout(() => {
    navigationTimer = undefined;
    if (
      followedPageIdentity?.tabId !== identity.tabId ||
      followedPageIdentity.windowId !== identity.windowId
    ) return;
    queueCapture({ identity, reason: 'navigation' });
  }, NAVIGATION_DEBOUNCE_MS);
}

function clearNavigationTimer(): void {
  if (navigationTimer !== undefined) clearTimeout(navigationTimer);
  navigationTimer = undefined;
}

function withCaptureTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new PageAccessError('The page took too long to respond. Retry the current page.')),
      CAPTURE_TIMEOUT_MS,
    );
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function invalidateCompanion(message: string): void {
  identityRequestId += 1;
  releaseLiveSession(capturedPageIdentity ?? followedPageIdentity);
  captureCoordinator.invalidate();
  availabilityRequestId += 1;
  activeAbortController?.abort();
  liveDeltaAbortController?.abort();
  replicaShadowAbortController?.abort();
  imageTranslationController.releaseReplica();
  replicaEngineController.releasePresentation(false);
  invalidateComposerOutput();
  followedPageIdentity = undefined;
  snapshot = undefined;
  capturedPageIdentity = undefined;
  capturedPageDocumentId = undefined;
  resolvedSourceLanguage = undefined;
  availability = 'unavailable';
  availabilityCheckedForPair = undefined;
  translationDesired = false;
  translationComplete = false;
  if (replicaTranslationMode === 'rrweb-projection') {
    replicaTranslationCoordinator.selectPair(undefined);
  }
  pendingLiveUpdate = undefined;
  latestLiveSequence = 0;
  highestReceivedLiveSequence = 0;
  liveSequenceBaselineReady = false;
  legacyTransitionGate.reset();
  liveReplicaFailureRecoveryGate.reset();
  lastSourceScroll = undefined;
  visibleReplayHost.resetSourceScroll();
  disconnectMirror();
  renderErrorState(message);
  setStatus(message, 'warning');
  updateControls();
}

function usesReplicaTranslationProjection(): boolean {
  return (
    replicaTranslationMode === 'rrweb-projection' &&
    legacyTransitionGate.shadowOwnsPage &&
    visibleReplayHost.hasCommittedReplica
  );
}

function releaseReplicaPresentationForLegacyWork(force = false): boolean {
  if (!force && usesReplicaTranslationProjection()) return false;
  if (
    replicaEngineMode === 'legacy' ||
    !legacyTransitionGate.shadowOwnsPage
  ) return false;
  const needsFreshCapture = legacyTransitionGate.release();
  pendingLiveUpdate = undefined;
  replicaShadowAbortController?.abort();
  imageTranslationController.releaseReplica();
  replicaEngineController.releasePresentation(true);
  return needsFreshCapture;
}

function releaseLiveSession(
  identity: CapturedPageIdentity | undefined = capturedPageIdentity ?? followedPageIdentity,
): void {
  if (!identity) return;
  void browser.scripting.executeScript({
    target: { tabId: identity.tabId, frameIds: [0] },
    func: unregisterLivePageObserver,
    args: [liveSessionId],
  }).catch(() => undefined);
}

function renderLoadingState(): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state';
  const text = document.createElement('p');
  text.textContent = 'Preparing the live read-only mirror…';
  wrapper.append(text);
  snapshotContainer.replaceChildren(wrapper);
}

function renderErrorState(message: string): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'empty-state empty-state--error';
  const text = document.createElement('p');
  text.textContent = message;
  wrapper.append(text);
  snapshotContainer.replaceChildren(wrapper);
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
  return identityFromTab(
    tab,
    followed.url,
    !isDetachedWindow || preferences.popoutTabMode === 'active',
  );
}

function identityFromTab(
  tab: Browser.tabs.Tab | undefined,
  fallbackUrl?: string,
  requireActive = true,
): CapturedPageIdentity {
  const url = tab?.url ?? fallbackUrl;
  if (
    tab?.id === undefined ||
    !url ||
    !isSupportedPage(url) ||
    (requireActive && !tab.active)
  ) {
    throw new PageAccessError('Open a regular HTTP or HTTPS page, then select the extension from that page.');
  }
  return { tabId: tab.id, windowId: tab.windowId, url };
}

function assertSnapshotIsCurrent(
  tab: Browser.tabs.Tab | undefined,
  identity: CapturedPageIdentity,
): void {
  if (
    ((!isDetachedWindow || preferences.popoutTabMode === 'active') &&
      !tab?.active) ||
    !isSamePageIdentity(identity, tab)
  ) {
    throw new PageAccessError('The source page changed or access expired. Select the extension on the source page to authorize it again.');
  }
}

function readAuthorizedTabMessage(message: unknown): AuthorizedTabRequest | undefined {
  if (
    typeof message !== 'object' ||
    message === null ||
    !('type' in message) ||
    message.type !== 'simul:authorized-tab' ||
    !('tabId' in message) ||
    !Number.isSafeInteger(message.tabId) ||
    Number(message.tabId) < 0 ||
    !('windowId' in message) ||
    !Number.isSafeInteger(message.windowId) ||
    Number(message.windowId) < 0 ||
    !('url' in message) ||
    typeof message.url !== 'string' ||
    !isSupportedPage(message.url)
  ) return undefined;
  const authorized = message as AuthorizedTabMessage;
  const hasLaunchStamp = authorized.launchEpoch !== undefined ||
    authorized.launchSequence !== undefined;
  if (
    hasLaunchStamp &&
    (typeof authorized.launchEpoch !== 'string' ||
      authorized.launchEpoch.length === 0 ||
      authorized.launchEpoch.length > 128 ||
      !Number.isSafeInteger(authorized.launchSequence) ||
      Number(authorized.launchSequence) <= 0)
  ) return undefined;
  return {
    identity: {
      tabId: authorized.tabId,
      windowId: authorized.windowId,
      url: authorized.url,
    },
    ...(hasLaunchStamp
      ? {
          launchStamp: {
            epoch: authorized.launchEpoch as string,
            sequence: authorized.launchSequence as number,
          },
        }
      : {}),
  };
}

function isMessageFromFollowedTab(
  tab: Browser.tabs.Tab | undefined,
  sessionId: string,
  generation: number,
  url: string,
): boolean {
  const followed = followedPageIdentity ?? capturedPageIdentity;
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
  requestId: number,
  requestedSnapshot: PageSnapshot,
  pair: TranslationPair,
  generation: number,
): boolean {
  const currentPair = selectedPair();
  return isAvailabilityRequestCurrent({
    replicaViewMode: preferences.replicaViewMode,
    requestMatches: requestId === availabilityRequestId,
    generationMatches: captureCoordinator.isCurrent(generation),
    snapshotMatches: snapshot === requestedSnapshot,
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

function showCaptureNotes(page: PageSnapshot): void {
  const details: string[] = [];
  if (page.omissions.controls) details.push('private form contents');
  if (page.omissions.frames) details.push('embedded frame contents');
  if (page.omissions.hidden) details.push('hidden content');
  if (page.omissions.unsafeImages) details.push('unsupported image sources');
  if (page.omissions.truncated) details.push('content beyond the bounded mirror limit');
  if (!liveObservationAvailable) {
    details.push('live updates because too many companion views are open');
  }
  captureNotes.textContent = details.length > 0 ? `Safely omitted: ${details.join(', ')}.` : '';
  captureNotes.hidden = details.length === 0;
}

function updateControls(): void {
  syncToolbarPreferenceControls();
  syncQuickTranslationPanel();
  const busy = captureInFlight || translationInFlight || permissionInFlight || composerInFlight;
  sourceSelect.disabled = busy;
  targetSelect.disabled = busy;
  swapButton.disabled = busy || !resolvedSourceLanguage;
  autoTranslateSelect.disabled = busy;
  displayModeSelect.disabled = busy;
  textLayoutSelect.disabled = busy;
  replicaFidelityPolicySelect.disabled = busy || replicaFidelityCommitInFlight;
  launchBehaviorSelect.disabled = busy;
  popoutTabModeSelect.disabled = busy;
  syncScrollInput.disabled = busy || !liveObservationAvailable;
  zoomInButton.disabled = busy;
  zoomOutButton.disabled = busy;
  refreshButton.disabled = captureInFlight;
  compactRefreshButton.disabled = captureInFlight;
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
    !visualRoot ||
    !selectedPair() ||
    availability === 'unavailable' ||
    translationComplete;
  setUiText(
    translateButton,
    translationComplete ? 'Translation current' : 'Translate page',
  );
  renderToolbarAttention();
  syncToolbarProgress();
}

function syncToolbarProgress(): void {
  const activity: ToolbarActivity = {
    ...(toolbarDeterminateRatio === undefined
      ? {}
      : { determinateRatio: toolbarDeterminateRatio }),
    captureInFlight,
    translationInFlight,
    permissionInFlight,
    composerInFlight,
    liveDeltaInFlight,
    imageTranslationInFlight,
    surfaceTransitionInFlight,
  };
  const state = toolbarProgressState(activity);
  const busy = state.kind !== 'idle';
  toolbarProgress.hidden = !busy;
  compactToolbar.setAttribute('aria-busy', String(busy));
  if (state.kind === 'idle') {
    delete toolbarProgress.dataset.mode;
    toolbarProgressFill.style.removeProperty('--toolbar-progress-ratio');
    toolbarProgress.setAttribute('aria-label', 'Companion idle');
    toolbarProgress.removeAttribute('aria-valuenow');
    toolbarProgress.removeAttribute('aria-valuetext');
    return;
  }
  toolbarProgress.dataset.mode = state.kind;
  if (state.kind === 'determinate') {
    const percent = Math.round(state.ratio * 100);
    const label = progressLabel.textContent?.trim() || 'Translating page';
    toolbarProgressFill.style.setProperty(
      '--toolbar-progress-ratio',
      String(state.ratio),
    );
    toolbarProgress.setAttribute('aria-label', label);
    toolbarProgress.setAttribute('aria-valuenow', String(percent));
    toolbarProgress.setAttribute('aria-valuetext', `${label} ${percent}%`);
  } else {
    const label = toolbarActivityLabel(activity);
    toolbarProgressFill.style.removeProperty('--toolbar-progress-ratio');
    toolbarProgress.setAttribute('aria-label', label);
    toolbarProgress.removeAttribute('aria-valuenow');
    toolbarProgress.setAttribute('aria-valuetext', label);
  }
}

function setImageTranslationBusy(busy: boolean): void {
  const completed = imageTranslationInFlight && !busy;
  imageTranslationInFlight = busy;
  if (busy && !translationInFlight && !composerInFlight) {
    progressRegion.hidden = false;
    progressLabel.textContent = 'Recognizing visible image text locally…';
    progressElement.removeAttribute('value');
  } else if (!busy && !translationInFlight && !composerInFlight) {
    hideProgress();
  }
  if (completed) {
    logTranslationCache('image-text', imageTranslationMemory);
    if (statusElement.textContent === 'Cancelling on-device translation…') {
      setStatus('Image text processing stopped.', 'warning');
    }
  }
  updateControls();
}

composerInput.addEventListener('input', () => {
  invalidateComposerOutput();
  updateControls();
});

function showProgress(label: string, value: number, max: number): void {
  progressRegion.hidden = false;
  progressLabel.textContent = label;
  progressElement.max = Math.max(1, max);
  progressElement.value = Math.min(progressElement.max, Math.max(0, value));
  toolbarDeterminateRatio = progressElement.value / progressElement.max;
  syncToolbarProgress();
}

function hideProgress(): void {
  toolbarDeterminateRatio = undefined;
  if (
    imageTranslationInFlight &&
    !translationInFlight &&
    !composerInFlight
  ) {
    progressRegion.hidden = false;
    progressLabel.textContent = 'Recognizing visible image text locally…';
    progressElement.removeAttribute('value');
    syncToolbarProgress();
    return;
  }
  progressRegion.hidden = true;
  progressElement.setAttribute('value', '0');
  progressElement.value = 0;
  syncToolbarProgress();
}

function setStatus(
  message: string,
  tone: CompanionStatusTone = 'normal',
): void {
  statusElement.textContent = message;
  statusElement.dataset.tone = tone;
  toolbarAttention = toolbarAttentionTarget(message, tone);
  if (tone === 'warning' || tone === 'error') toolbarAttentionTone = tone;
  refreshAttention.title = toolbarAttention === 'refresh' ? message : '';
  settingsAttention.title = toolbarAttention === 'settings' ? message : '';
  renderToolbarAttention();
}

function renderToolbarAttention(): void {
  const refreshVisible = toolbarAttention === 'refresh';
  const settingsVisible =
    toolbarAttention === 'settings' && openCompanionOverlay !== 'settings';
  refreshAttention.hidden = !refreshVisible;
  settingsAttention.hidden = !settingsVisible;
  refreshAttention.dataset.tone = toolbarAttentionTone;
  settingsAttention.dataset.tone = toolbarAttentionTone;
}

function normalizedPageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function isSupportedPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function hasNonDefaultPort(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).port.length > 0;
  } catch {
    return false;
  }
}

function readPageError(error: unknown): string {
  if (error instanceof PageAccessError) return error.message;
  const message = readableError(error);
  return /cannot access|permission|extensions gallery|chrome:\/\//iu.test(message)
    ? 'The extension no longer has access to this page. Select its toolbar icon on the source page to authorize it again.'
    : message;
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Something went wrong. Retry the current step.';
}

function logImageTranslationDiagnostic(
  diagnostic: ImageTranslationDiagnostic,
): void {
  // Content-free local diagnostics only; image text, URLs, and pixels are
  // deliberately absent from this channel.
  console.info('[Simul image translation]', diagnostic);
  imageTranslationDiagnosticHistory.append(diagnostic);
  renderImageTranslationDiagnosticHistory();
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

function renderImageTranslationDiagnosticHistory(): void {
  const output = imageTranslationDiagnosticOutput;
  if (!output) return;
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

class PageAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageAccessError';
  }
}
