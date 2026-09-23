/**
 * Single source of truth for the companion's code-driven user-facing English
 * text: status lines, toolbar labels/titles/aria, settings and image-panel
 * labels, and the templated status frames.
 *
 * Every string a module shows the user is a key here, so the UI localizer can
 * translate the whole catalogue as one atomic set (`ALL_UI_STRINGS`) and no
 * displayed string can drift out of that set. Static markup text keeps its
 * English in `index.html`; the localizer gathers those `data-ui-*` strings
 * from the DOM and localizes them in the same pass.
 *
 * Template frames carry numbered `{0}`, `{1}` placeholders that survive machine
 * translation; `formatUiTemplate` fills them after the frame is localized, so
 * the interpolated values (counts, already-localized language names, opaque
 * error text) sit in the localized sentence in the target language's order.
 */

/**
 * Fills `{0}`, `{1}`, … in a (possibly localized) template frame. An index with
 * no argument is left as its literal placeholder rather than printing
 * `undefined`, so a translator that drops a token degrades to a visible frame
 * marker instead of corrupt text.
 */
export function formatUiTemplate(
  frame: string,
  args: readonly (string | number)[],
): string {
  return frame.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

export const UI_STRINGS = {
  // Toolbar: text labels set from code (also pre-registered so they localize
  // atomically with the markup `data-ui-label` set).
  autoDetectOption: 'Auto-detect',
  sizeFit: 'Fit',
  sizeActual: '1:1',
  tabFollowCurrent: 'Current',
  tabFollowActive: 'Active',
  ocrOn: 'OCR On',
  ocrOff: 'OCR Off',

  // Toolbar: auto-detect button aria/title.
  autoDetectOnAria: 'From language is using Auto-detect',
  autoDetectOffAria: 'Set From language to Auto-detect',
  autoDetectOnTitle: 'From language is using Auto-detect.',
  autoDetectOffTitle: 'Set From language to Auto-detect.',

  // Toolbar: size toggle aria/title (frames: {0} current size, {1} next size).
  sizeToggleAria: 'Mirror size: {0}. Switch to {1}',
  sizeToggleTitle: 'Mirror size: {0}. Click for {1}.',
  sizeNextActual: '1:1 size',
  sizeNextFit: 'fit width',

  // Toolbar: OCR toggle titles for each saved image-access state.
  ocrTitleOn: 'Image text translation is on. Click to turn it off.',
  ocrTitleNoMethod:
    'Image translation has no enabled reading method. Click to turn it off.',
  ocrTitleAccessibilityOn: 'Accessibility image text is on. Click to turn it off.',
  ocrTitleNeedsAccess:
    'Image translation is saved but pixel OCR needs image access. Click to grant access.',
  ocrTitleAccessibilityPaused:
    'Accessibility image text is on; pixel OCR is paused. Click to grant image access.',
  ocrTitleAccessDeclined:
    'Chrome did not grant image access. Click to turn image text off.',
  ocrTitleOff: 'Image text translation is off. Click to turn it on.',

  // Toolbar: tab-follow aria/title for the detached-window states.
  tabFollowActiveAria: 'Follow the opening tab instead of the active browser tab',
  tabFollowCurrentAria: 'Follow the active browser tab instead of the opening tab',
  tabFollowFixedAria: 'Tab following is fixed to the current side-panel tab',
  tabFollowActiveTitle:
    'Following the active browser tab. Click to stay on the opening tab.',
  tabFollowCurrentTitle:
    'Staying on the opening tab. Click to follow the active browser tab.',
  tabFollowFixedTitle:
    'The side panel is attached to the current tab. Active-tab following is available in a detached window.',

  // Toolbar: refresh button while a rebuild is in flight.
  rebuildMirror: 'Rebuild mirror',
  rebuildingMirror: 'Rebuilding mirror',
  rebuildingMirrorEllipsis: 'Rebuilding mirror…',

  // Translate button states.
  translate: 'Translate',
  translating: 'Translating…',
  translatePage: 'Translate page',
  translationCurrent: 'Translation current',

  // Replica empty state and mode badge.
  preparingMirror: 'Preparing the live read-only mirror…',

  // Progress labels.
  progressPreparingModel: 'Preparing Chrome’s on-device language model…',
  progressDownloadingPack: 'Downloading language pack… {0}%',
  progressTranslating: 'Translating {0} of {1}…',
  progressRecognizingImageText: 'Recognizing visible image text locally…',

  // Toolbar progressbar aria-labels (one per in-flight activity; the idle and
  // determinate fallbacks). Shown to assistive tech, so they localize with the
  // rest of the UI (review finding F1).
  activityChangingView: 'Changing companion view',
  activityUpdatingSiteAccess: 'Updating site access',
  activityBuildingMirror: 'Building page mirror',
  activityTranslatingDraft: 'Translating quick draft',
  activityTranslatingPage: 'Translating page',
  activityRecognizingImageText: 'Recognizing image text',
  activityIdle: 'Companion idle',

  // Translation-driver: detected-language line (`#detected-language`).
  statusDetectedFromPageLanguage: 'Detected {0} from the page language.',
  statusDetectedFromVisibleText: 'Detected {0} from visible page text.',
  statusDetectedFromImage: 'Detected {0} from {1} ({2}).',

  // Translation-driver statuses.
  statusPreviouslyDetectedSource:
    'Using the previously detected {0} source language.',
  statusCouldNotDetect: 'The page language could not be detected. Choose a From language.',
  statusImageEvidenceCleared:
    'Image-derived language evidence was cleared. OCR is checking again with the updated settings.',
  statusLiveSourceLanguagesSaved:
    'Live source only is active. Language choices are saved for translated mode.',
  statusPairNeedsPack:
    'This language pair needs its on-device pack. Choose Translate once to prepare it.',
  statusChooseFromInconclusive:
    'Choose a From language because automatic detection was inconclusive.',
  statusLanguagesMatchUnchanged:
    'The source and target languages match, so the original text is unchanged.',
  statusReadyToTranslate: 'Ready to translate {0} to {1} on-device.',
  statusChooseTranslateOnce:
    'Choose Translate once so Chrome can prepare this on-device language pair.',
  statusPairUnavailable: '{0} to {1} is unavailable on this device.',
  statusAutomaticNeedsOneClick:
    'Automatic translation is ready, but this pair needs one Translate click to prepare its local pack.',
  statusAutomaticComplete:
    'Automatic translation is complete and live updates will translate as they arrive.',
  statusTranslationComplete:
    'Translation is complete and live updates will translate as they arrive.',
  statusTranslationCancelledKept:
    'Translation cancelled. Existing translated text was kept.',
  statusLiveSourceRestored:
    'Live source only is active. The current mirror remains live and all translation overlays were removed.',
  statusTranslatedModeRestored:
    'Translated mode restored. Preparing the saved language settings…',

  // Partial-projection status (frame + count fragments joined into it).
  partialPrefixRemainsPartial: 'Translation remains partial',
  partialPrefixLivePartial: 'Live page changes were only partially translated',
  partialSummary:
    '{0}: {1}. Original text remains for those segments; choose Translate page to retry.',
  partialNoneProjected: 'no current text was projected',
  partialFailed: '{0} failed',
  partialStale: '{0} became stale',
  partialSuperseded: '{0} were superseded',
  partialOverflow: '{0} exceeded the bounded local queue',
  partialNotProjected: '{0} were not projected',

  // Live-change reconciliation statuses (main.ts).
  statusLivePartiallyTranslated: 'Live page changes were only partially translated',
  statusLiveMirroredTranslated: 'Live page changes were mirrored and translated.',
  statusLiveNeedsTranslate:
    'Live page changes were translated, but earlier incomplete text still needs Translate page.',

  // Cancellation / safety statuses (main.ts).
  statusCancellingTranslation: 'Cancelling on-device translation…',
  statusQuickCancelled: 'Quick translation cancelled.',
  statusNothingTranslating: 'Nothing is currently being translated.',
  statusImageProcessingStopped: 'Image text processing stopped.',
  statusSnapshotOlder: 'The committed settings snapshot was older than this panel.',
  statusSafetyLost:
    'The settings safety connection was lost. Read access is Page-only while Simul reconnects…',
  statusSnapshotInvalid:
    'Stored settings became unavailable or invalid. Read access is Page-only until a current valid snapshot is restored…',
  statusReadablePolicyRebuilding: 'Readable-content policy changed; rebuilding safely…',

  // Capture-pipeline statuses.
  statusReconcileRebuild:
    'A live update could not be reconciled. Rebuilding once while keeping the current mirror visible…',
  statusBuildingNewPage: 'Building the live mirror for the newly loaded page…',
  statusBuildingInitial: 'Building the initial live read-only mirror…',
  statusLiveDisconnectedRebuild:
    'The live mirror disconnected. Rebuilding once while keeping the last good replica visible…',
  statusLiveDisconnectedAgain:
    'The live replica disconnected again. The last good replica is preserved; choose Refresh to retry.',
  statusNoDocumentBoundary: 'The page did not expose a current document boundary.',
  statusNoCommittedDocument: 'The isolated replica did not commit a current document.',
  statusLiveSourceKeepsUpdating:
    'Live source only is active. The isolated mirror keeps updating without text or image translation.',
  statusGrantRemovedWaiting:
    'Chrome removed a saved automatic-access grant. The mirror is waiting for page text.',
  statusMirrorLiveWaiting:
    'The page mirror is live and will prepare translation when visible text arrives.',
  statusGrantRemovedScopeOff:
    'Chrome removed a saved automatic-access grant, so that scope was turned off.',
  statusReplicaNotPrepared:
    'The isolated replica could not be prepared. Retry the current page.',

  // Surface-switcher: detached window / return-to-panel.
  returnToSidePanelAria: 'Return companion to the side panel',
  returnToSidePanel: 'Return to side panel',
  statusOpenRegularBeforeDetach: 'Open a regular page before detaching the companion.',
  statusDetachedCouldNotCloseOld:
    'Detached window opened, but Chrome could not close the old side panel automatically. Close it manually.',
  statusDetachedCouldNotRemember:
    'Detached window opened, but Chrome could not remember it as the last-used surface.',
  statusDetachedOpenError: 'Chrome could not open a detached window: {0}',
  statusReturnPanelError: 'Chrome could not return to the side panel: {0}',

  // Source-follower statuses (frames prepend an opaque page-error sentence).
  statusNoActiveReadableTab: 'The source browser window has no active readable tab.',
  statusActiveTabNotWebPage: 'Waiting for a web page in the active tab.',
  statusFollowNeedsAccess:
    '{0} Active-tab following needs page access for each newly selected site.',
  statusActiveTabChanged:
    'The active tab changed. Select the extension on the page you want to follow.',
  statusSourceRestricted:
    'The source tab opened a restricted page. Return to a regular HTTP or HTTPS page and select the extension again.',
  statusSourcePageChanging:
    'The source page is changing; the current mirror stays visible until the new page is ready.',
  statusSourceClosedNoNeighbor:
    'The source tab was closed and no neighboring readable tab became active.',
  statusSourceClosed: 'The source tab was closed.',
  statusLockedTabMovedWindows:
    '{0} The locked source tab could not be followed after it moved windows.',
  statusReplacedTabNotFollowed:
    '{0} Chrome replaced the source tab, but its new page could not be followed.',

  // Permission flows: image access.
  statusImageAccessNotRestored: 'Image access was released and could not be restored.',
  statusImageAccessRemovedPixelPaused:
    'Image access was removed. Pixel OCR is paused; open options and choose Grant image access to resume.',
  statusImageAccessRemovedAccessibilityActive:
    'Image access was removed. Accessibility image text remains active; only pixel OCR is paused.',
  statusChooseImageSettingAgain:
    'Choose the image setting again so Chrome can show its access prompt.',
  statusPixelOcrRemainsPaused:
    'Pixel OCR remains paused. Choose Grant image access when you are ready to retry.',
  statusAccessibilityActiveNoPixel:
    'Accessibility image text remains active without image access; pixel OCR was not enabled.',
  statusImageAccessDeniedOff:
    'Chrome did not grant image access, so image translation remains off. You can retry from options.',
  statusImageTranslationEnabled: 'Image translation is enabled for visible page images.',
  statusImageTranslationOff: 'Image translation is off.',
  statusImageTranslationOffPartialAccess:
    'Image translation is off. Chrome did not retain some saved one-site automatic access.',
  statusImageAccessReleasedNotSaved:
    'Image access was released but the change could not be saved, and Chrome did not give the access back. Pixel OCR is paused until you choose Grant image access in options.',
  statusImageAccessUpdateFailed:
    'Chrome could not update image access. Your saved setting was left unchanged; try again from options.',
  statusImageCaptureRetained: 'Chrome retained image capture access.',
  statusSettingsResetElsewhereImage:
    'Settings were reset in another companion while image access was changing.',

  // Permission flows: automatic-access scope.
  statusNoNarrowPortAccess:
    'Chrome cannot grant narrow one-site access to a non-default port.',
  statusOpenRegularBeforeSiteAuto:
    'Open a regular HTTP or HTTPS page before enabling this-site automation.',
  statusChooseSettingAgain:
    'Choose the setting again so Chrome can show its access prompt.',
  statusSavedSiteLimit: 'The saved-site limit has been reached.',
  statusAutoAccessUpdateError: 'Chrome could not update automatic access: {0}',
  statusAutoScopeNotRetained: 'Chrome did not retain the requested automatic-access scope.',
  statusAutoOffForScope: 'Automatic translation is off for this scope.',
  statusAutoEnabledRegular: 'Automatic translation is enabled for regular web pages.',
  statusAutoEnabledThisSite: 'Automatic translation is enabled for this site.',

  // Read-scope controller: profile choice labels and descriptions.
  scopeControlLabelsTitle: 'Control labels and semantics',
  scopeControlLabelsDesc:
    'Read public button, menu, field-label, and disabled-state text.',
  scopeControlImagesTitle: 'Images inside controls',
  scopeControlImagesDesc:
    'Read non-secret navigation and control images; actions stay disabled.',
  scopeDisclosureTitle: 'Collapsed disclosure content',
  scopeDisclosureDesc:
    'Read validated same-page menus and disclosures even while collapsed.',
  scopeFormValuesTitle: 'Ordinary visible form values',
  scopeFormValuesDesc: 'Read visible text, search, URL, textarea, and selection state.',
  scopePersonalTitle: 'Personal and autofill values',
  scopePersonalDesc:
    'Read visible email, telephone, name, address, and username fields. Credential and card data stay blocked.',
  scopeEditableTitle: 'Editable page content',
  scopeEditableDesc:
    'Read visible non-secret contenteditable and ARIA text editor drafts.',

  // Read-scope controller: save/reset statuses.
  statusApplyingNarrower: 'Applying narrower read settings…',
  statusSaving: 'Saving…',
  statusReadChangedElsewhere:
    'Settings changed in another companion. Review the current choices and try again.',
  statusReadableChangedElsewhere:
    'Readable-content settings changed in another companion. Review the current choices and try again.',
  statusPurgeUnconfirmedChange:
    'Another companion could not confirm its safety purge. Close it or retry the change.',
  statusReadNotApplied: 'The read settings were not applied.',
  statusReadableApplied: 'Readable-content settings applied. The replica is rebuilding.',
  statusCouldNotSaveReadable: 'Could not save readable-content settings: {0}',
  statusResettingSettingsPermissions: 'Resetting settings and optional permissions…',
  statusRetryingCleanup: 'Retrying optional permission and runtime cleanup…',
  statusResetChangedElsewhere:
    'Settings changed in another companion. Review the current state before resetting.',
  statusPurgeUnconfirmedReset:
    'Another companion could not confirm its safety purge. Close it or retry the reset.',
  statusResettingSettings: 'Resetting extension settings…',
  statusResetPendingOne:
    'Core settings are reset. {0} optional permission entry remains and cleanup is still pending; choose Retry cleanup.',
  statusResetPendingMany:
    'Core settings are reset. {0} optional permission entries remain and cleanup is still pending; choose Retry cleanup.',
  statusResetPendingGeneric:
    'Core settings are reset, but permission or runtime cleanup is still pending; choose Retry cleanup.',
  statusResetComplete:
    'Settings and optional permissions were reset. Choose a read profile to continue.',
  statusResetCouldNotFinish: 'Reset could not finish: {0}',
  statusPreparingSafeReset: 'Preparing a safe settings reset…',
  statusPreparingNarrower: 'Preparing narrower read settings…',
  setupCleanupPending:
    'Core settings are already safe, but optional permission or runtime cleanup is still pending.',
  retryResetCleanup: 'Retry reset cleanup',
  resetAllSettings: 'Reset all extension settings…',

  // Preference client statuses.
  statusInvalidPreferenceResponse: 'The preference service returned an invalid response.',
  statusSettingsResetElsewhere:
    'Settings were reset in another companion. Review the current choices and try again.',
  statusCouldNotSaveOptions: 'Could not save options: {0}',
  statusImageOptionsChangedElsewhere:
    'Image options changed in another companion. Review the current choices and try again.',
  statusCouldNotSaveImageOptions: 'Could not save image options: {0}',

  // Quick composer.
  composerCharacterCount: '{0} of {1} characters used',
  composerWaitingLanguage: 'Waiting for website language',
  composerDetecting:
    'Simul is still detecting the website language. If detection remains inconclusive, choose From in the toolbar.',
  composerLanguagesMatch: 'The languages match, so Simul will copy the text unchanged.',
  composerDraftNotSaved: 'Your draft stays only in this companion window and is not saved.',
  composerTranslatingLocally: 'Translating locally…',
  composerReversePairUnavailable: 'The reverse language pair is unavailable on this device.',
  composerReadyToCopy: 'Translation is ready to copy.',
  composerReplyReadyToCopy: 'Reply translation is ready to copy. It was not saved.',
  composerCouldNotTranslate: 'Could not translate the reply: {0}',
  composerCopied: 'Translated text copied.',
  composerReplyCopied: 'Translated reply copied.',
  composerCopyFailedSelected: 'Chrome could not copy automatically. The output is selected.',
  composerCopyFailedSelectedResult:
    'Chrome could not copy automatically. The result is selected for copying.',

  // Image-analysis panel: section labels and descriptions.
  imagePanelHeading: 'Image text',
  imagePanelOptions: 'Image text options',
  imagePanelNoActivity: 'No OCR activity in this companion view yet.',
  imageEnableLabel: 'Translate text inside images (local, experimental)',
  imageAccessibilityHint:
    'Accessibility text can run without image access. Grant image access only to enable local pixel OCR fallbacks.',
  imageCheckingAccess: 'Checking Chrome image access…',
  imageOnByDefault:
    'On by default. Pixel OCR waits for image access; visible image pixels stay on this device and are discarded after OCR.',
  imageGrantAccess: 'Grant image access',
  imageReadingPriority: 'Image reading priority',
  imagePriorityOrderHint:
    'This order controls which methods Simul attempts first and breaks close evidence ties.',
  imagePriorityMethodsHint:
    'Methods are attempted from top to bottom. Uncertain accessibility text may be compared with later OCR; the saved order breaks close ties.',
  imageTextDetectorHint:
    'Chrome TextDetector is experimental and platform-dependent. When its local detect probe is unavailable, Simul skips capture work for it and falls through to the next enabled provider.',
  imageTesseractNote:
    'Tesseract.js runs locally with packaged language models. Simul loads only the language group needed for the current page.',
  imageProvidersPaused: 'OCR is paused because every compiled provider is off.',
  imageScanScopeHint:
    'Choose whether images are recognized only when visible, after visible work, or immediately.',
  imageScanImages: 'Scan images',
  imageSkipSmallHint:
    'Ignore tiny images that are unlikely to contain useful readable text.',
  imageSkipSmall: 'Skip very small images',
  imagePromptLanguage: 'Use local Prompt for image language',
  imagePromptInterpret: 'Use local Prompt to interpret image text',
  imageDiagnostics: 'OCR diagnostics',
  imageDiagnosticsHint: 'Inspect content-free OCR stages and counts for this session.',
  imageDiagnosticsPrivacy:
    'Memory-only stages and counts; page text, URLs, pixels, and identifiers are never included.',
  imageClearDiagnostics: 'Clear diagnostics',
  imageConfidenceHint:
    'Require this provider confidence before OCR text can be used without independent corroboration.',
  imageMinConfidence: 'Minimum OCR confidence',
  imageHigherConfidenceHint:
    'Higher values reduce false text detections but may miss faint or stylized text.',
  imageMethodToggleHint:
    'Turn this local image-reading method on or off without changing its priority.',
  imageNoPixels: 'No pixels',
  imageAccessibilityUses:
    'Uses direct image aria-label or alt text and does not require screenshot permission.',
  imageMoveEarlier: 'Move earlier',
  imageMoveLater: 'Move later',
  imageProviderChecking: 'Checking…',
  imageProviderAvailable: 'Available',
  imageProviderUnavailable: 'Unavailable',
  imageMethodDisable: 'Disable {0}',
  imageMethodEnable: 'Enable {0}',
  imageProbeChecking: 'Checking whether this Chrome runtime can complete a local detect call.',
  imageProbeAvailable: 'This Chrome runtime completed the local capability probe.',
  imageProbeUnavailable:
    'This Chrome runtime does not expose the experimental TextDetector API.',
  imageProbeError:
    'This Chrome runtime could not complete the TextDetector capability probe.',
  imageMethodAccessibility: 'Accessibility text (aria-label / alt)',
  imageMethodTextDetector: 'Chrome TextDetector (platform)',
  imageMethodTesseract: 'Tesseract.js (local)',
  imageMethodTransformers: 'Transformers.js',
  imageMethodScreenAi: 'Chromium Screen AI',
  imageScanVisible: 'Only when visible',
  imageScanImmediate: 'Everything immediately',
  imageScanVisibleFirst: 'Visible first, then background',

  // Image-analysis panel: language-evidence descriptions used by both surfaces.
  imageAccessibilityText: 'accessibility image text',
  imageBoundedOcr: 'bounded image OCR',
} as const;

export type UiStringKey = keyof typeof UI_STRINGS;

/**
 * Every localizable English string, deduped. Derived from the catalogue so the
 * atomic localization set can never fall out of sync with what the modules
 * actually show. Static markup text is added by the localizer from the DOM.
 */
export const ALL_UI_STRINGS: readonly string[] = [
  ...new Set(Object.values(UI_STRINGS)),
];
