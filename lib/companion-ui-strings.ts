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
  // Owner's words (D66): the mirror follows the active tab, or stays pinned.
  tabFollowCurrent: 'Pinned',
  tabFollowActive: 'Follow',
  ocrOn: 'OCR On',
  ocrOff: 'OCR Off',

  // Toolbar: auto-detect button aria/title.
  autoDetectOnAria: 'From language uses Auto-detect',
  autoDetectOffAria: 'Set From language to Auto-detect',
  autoDetectOnTitle: 'From language uses Auto-detect.',
  autoDetectOffTitle: 'Set From language to Auto-detect.',

  // Toolbar: size toggle aria/title (frames: {0} current size, {1} next size).
  sizeToggleAria: 'Mirror size: {0}. Change to {1}',
  sizeToggleTitle: 'Mirror size: {0}. Select to change to {1}.',
  sizeNextActual: '1:1 size',
  sizeNextFit: 'fit width',

  // Toolbar: OCR toggle titles for each saved image-access state.
  ocrTitleOn: 'Image text translation is on. Select to disable it.',
  ocrTitleNoMethod:
    'Image translation has no enabled reading method. Select to disable it.',
  ocrTitleAccessibilityOn: 'Accessibility image text is on. Select to disable it.',
  ocrTitleNeedsAccess:
    'Image translation is saved, but pixel OCR must have image access. Select to grant access.',
  ocrTitleAccessibilityPaused:
    'Accessibility image text is on. Pixel OCR is paused. Select to grant image access.',
  ocrTitleAccessDeclined:
    'Chrome did not grant image access. Select to disable image text.',
  ocrTitleOff: 'Image text translation is off. Select to enable it.',

  // Toolbar: tab-follow aria/title (side panel and detached window alike).
  tabFollowActiveTitle:
    'The mirror follows the active browser tab. Select to pin the mirror to the tab that it shows.',
  tabFollowCurrentTitle:
    'The mirror is pinned to the tab that it shows. Select to follow the active browser tab.',

  // Toolbar: refresh button while a rebuild is in flight.
  rebuildMirror: 'Rebuild mirror',
  rebuildingMirror: 'Mirror rebuild in progress',
  rebuildingMirrorEllipsis: 'Rebuilding the mirror…',

  // Translate button states.
  translate: 'Translate',
  translating: 'Translating…',
  translatePage: 'Translate page',
  translationCurrent: 'Translation current',

  // Replica empty state and mode badge.
  preparingMirror: 'Preparing the live read-only mirror…',

  // Progress labels.
  progressPreparingModel: 'Preparing Chrome’s on-device language model…',
  progressDownloadingPack: 'Downloading the language pack… {0}%',
  progressTranslating: 'Translating {0} of {1}…',
  progressRecognizingImageText: 'Reading the visible image text on this device…',
  progressPdfReadingScanned: 'Reading the scanned pages: {0} of {1}…',

  // Toolbar progressbar aria-labels (one per in-flight activity; the idle and
  // determinate fallbacks). Shown to assistive tech, so they localize with the
  // rest of the UI (review finding F1).
  activityChangingView: 'Panel view change',
  activityUpdatingSiteAccess: 'Site access update',
  activityBuildingMirror: 'Mirror build',
  activityTranslatingDraft: 'Quick draft translation',
  activityTranslatingPage: 'Page translation',
  activityRecognizingImageText: 'Image text recognition',
  activityIdle: 'No activity',

  // Translation-driver: detected-language line (`#detected-language`).
  statusDetectedFromPageLanguage: 'Simul detected {0} from the page language.',
  statusDetectedFromVisibleText: 'Simul detected {0} from the visible page text.',
  statusDetectedFromScannedPages: 'Simul detected {0} from the scanned pages.',
  statusDetectedFromImage: 'Simul detected {0} from {1} ({2}).',

  // Translation-driver statuses.
  statusPreviouslyDetectedSource:
    'Simul uses the source language that it detected before: {0}.',
  statusCouldNotDetect: 'Simul could not detect the page language. Select a From language.',
  statusImageEvidenceCleared:
    'Simul cleared the language evidence from images. OCR checks again with the updated settings.',
  statusLiveSourceLanguagesSaved:
    'Live source only is active. Simul saves your language choices for translated mode.',
  statusChooseFromInconclusive:
    'Automatic detection did not find one clear language. Select a From language.',
  statusLanguagesMatchUnchanged:
    'The source and target languages are the same. The original text does not change.',
  statusReadyToTranslate: 'Simul is ready to translate {0} to {1} on this device.',
  statusChooseTranslateOnce:
    'Select Translate page once. Then Chrome can prepare this on-device language pair.',
  statusPairUnavailable: '{0} to {1} is not available on this device.',
  statusAutomaticNeedsOneClick:
    'Automatic translation is ready. To prepare the local pack for this pair, select Translate page once.',
  statusAutomaticComplete:
    'Automatic translation is complete. Simul translates new live changes when they arrive.',
  statusTranslationComplete:
    'Translation is complete. Simul translates new live changes when they arrive.',
  statusTranslationCancelledKept:
    'The translation was cancelled. Simul kept the text that it translated before.',
  statusLiveSourceRestored:
    'Live source only is active. The current mirror is still live. Simul removed all translation overlays.',
  statusTranslatedModeRestored:
    'Translated mode is active again. Preparing the saved language settings…',

  // Partial-projection status (frame + count fragments joined into it).
  partialPrefixRemainsPartial: 'Translation is not complete',
  partialSummary:
    '{0}: {1}. The original text is still shown for those segments. To try again, select Translate page.',
  partialNoneProjected: 'no current translated text was shown',
  partialFailed: '{0} failed',
  partialStale: '{0} became out of date',
  partialSuperseded: '{0} were replaced by newer text',
  partialOverflow: '{0} were more than the local queue can hold',
  partialNotProjected: '{0} were not shown',

  // Live-change reconciliation statuses (main.ts).
  statusLivePartiallyTranslated: 'Simul translated only part of the live page changes',
  statusLiveMirroredTranslated: 'Simul copied and translated the live page changes.',
  statusLiveNeedsTranslate:
    'Simul translated the live page changes. To translate the earlier text that is not complete, select Translate page.',

  // Cancellation / safety statuses (main.ts).
  statusCancellingTranslation: 'Cancelling the on-device translation…',
  statusQuickCancelled: 'The quick translation was cancelled.',
  statusNothingTranslating: 'No translation is in progress.',
  statusImageProcessingStopped: 'Image text processing stopped.',
  statusSnapshotOlder: 'The saved settings snapshot was older than this panel.',
  statusSafetyLost:
    'The panel lost its settings safety connection. Read access is Page only until Simul connects again…',
  statusSnapshotInvalid:
    'The saved settings became not available or not valid. Read access is Page only until Simul restores a current, valid snapshot…',
  statusReadablePolicyRebuilding:
    'The readable-content policy changed. Reading the page again safely…',

  // Capture-pipeline statuses.
  statusReconcileRebuild:
    'Simul could not apply a live update. Rebuilding the mirror once. The current mirror shows until then…',
  statusBuildingNewPage: 'Building the live mirror for the new page…',
  statusBuildingInitial: 'Building the first live read-only mirror…',
  statusLiveDisconnectedRebuild:
    'The live mirror lost its connection. Rebuilding the mirror once. The last good mirror shows until then…',
  statusLiveDisconnectedAgain:
    'The live mirror lost its connection again. Simul shows the last good mirror. To try again, select Refresh.',
  statusNoDocumentBoundary: 'The page did not give a current document boundary.',
  statusNoCommittedDocument: 'The mirror did not receive the current page.',
  statusLiveSourceKeepsUpdating:
    'Live source only is active. The isolated mirror continues to update without text or image translation.',
  statusGrantRemovedWaiting:
    'Chrome removed a saved automatic-access grant. The mirror waits for page text.',
  statusMirrorLiveWaiting:
    'The page mirror is live. It will prepare the translation when visible text arrives.',
  statusGrantRemovedScopeOff:
    'Chrome removed a saved automatic-access grant. Thus, that scope is now off.',
  statusReplicaNotPrepared:
    'Simul could not prepare the mirror. Try the current page again.',
  statusReplicaTooLarge: 'This page is too large for Simul to mirror.',

  // PDF statuses (capture pipeline and PDF controller).
  statusPdfReading: 'Reading the PDF…',
  statusPdfPassword: 'This PDF has a password. Simul cannot open it.',
  statusPdfTooLarge: 'This PDF is too large for Simul (more than 128 MB).',
  statusPdfDownloadFailed:
    'Simul could not download the PDF. Reload the tab and select Simul again.',
  statusPdfUnreadable: 'This file is not a readable PDF.',
  statusPdfReaderFailed: 'Simul’s PDF reader could not start.',
  statusPdfFileReadFailed: 'Simul could not read this file. Select it again.',
  statusPdfNoText: 'Simul found no text in this PDF.',
  statusPdfScannedNoMethod:
    'Simul did not read the scanned pages. In Options, under Image reading priority, enable “Tesseract.js (local)”.',
  statusPdfScannedUnsupported:
    'Simul did not read the scanned pages. Simul has no OCR model for {0}.',
  statusPdfScannedFailed: 'Simul could not read these scanned pages: {0}.',
  statusPdfSourceOnly: 'Live source only is active. Simul shows the PDF without translation.',
  statusPdfTranslated: 'The PDF is translated.',
  pdfPageLabel: 'Page {0} of {1}',
  // A PDF on this computer, offered wherever the panel shows an error (D107).
  openPdfFile: 'Open a PDF file…',
  openPdfFileDropHint: 'For a PDF on this computer, open it here or drop it on Simul.',

  // Surface-switcher: detached window / return-to-panel.
  returnToSidePanelAria: 'Return this window to the side panel',
  returnToSidePanel: 'Return to side panel',
  statusOpenRegularBeforeDetach: 'Open a regular page before you detach the panel.',
  statusDetachedCouldNotCloseOld:
    'The detached window opened. Chrome could not close the old side panel automatically. Close it manually.',
  statusDetachedCouldNotRemember:
    'The detached window opened. Chrome could not record it as the last used view.',
  statusDetachedOpenError: 'Chrome could not open a detached window: {0}',
  statusReturnPanelError: 'Chrome could not return to the side panel: {0}',

  // Source-follower statuses (frames prepend an opaque page-error sentence).
  statusNoActiveReadableTab: 'The source browser window has no active readable tab.',
  statusActiveTabNotWebPage: 'Simul waits for a web page in the active tab.',
  statusFollowNeedsAccess:
    '{0} To follow the active tab, Simul must have page access for each new site that you select.',
  statusSourceRestricted:
    'The source tab opened a restricted page. Return to a regular HTTP or HTTPS page. Then select the extension again.',
  statusSourcePageChanging:
    'The source page changes. Simul shows the current mirror until the new page is ready.',
  statusSourceClosedNoNeighbor:
    'The source tab was closed. No readable tab next to it became active.',
  statusSourceClosed: 'The source tab was closed.',
  statusLockedTabMovedWindows:
    '{0} Simul could not follow the pinned source tab after it moved to a different window.',
  statusReplacedTabNotFollowed:
    '{0} Chrome replaced the source tab. Simul could not follow its new page.',

  // Permission flows: image access.
  statusImageAccessNotRestored: 'Simul released image access. Simul could not restore it.',
  statusImageAccessRemovedPixelPaused:
    'Image access was removed. Pixel OCR is paused. To continue, open Options and select Grant image access.',
  statusImageAccessRemovedAccessibilityActive:
    'Image access was removed. Accessibility image text is still active. Only pixel OCR is paused.',
  statusChooseImageSettingAgain:
    'Select the image setting again to show the Chrome access prompt.',
  statusPixelOcrRemainsPaused:
    'Pixel OCR is still paused. When you are ready to try again, select Grant image access.',
  statusAccessibilityActiveNoPixel:
    'Accessibility image text is still active without image access. Pixel OCR was not enabled.',
  statusImageAccessDeniedOff:
    'Chrome did not grant image access. Thus, image translation is still off. You can try again in Options.',
  statusImageTranslationEnabled: 'Image translation is enabled for visible page images.',
  statusImageTranslationOff: 'Image translation is off.',
  statusImageTranslationOffPartialAccess:
    'Image translation is off. Chrome did not keep some saved one-site automatic access.',
  statusImageAccessReleasedNotSaved:
    'Simul released image access but could not save the change. Chrome did not give the access back. Pixel OCR is paused until you select Grant image access in Options.',
  statusImageAccessUpdateFailed:
    'Chrome could not update image access. Your saved setting did not change. Try again in Options.',
  statusImageCaptureRetained: 'Chrome kept image capture access.',
  statusSettingsResetElsewhereImage:
    'Settings were reset in another panel while image access changed.',

  // Permission flows: automatic-access scope.
  statusNoNarrowPortAccess:
    'Chrome cannot grant narrow one-site access to a non-default port.',
  statusOpenRegularBeforeSiteAuto:
    'Open a regular HTTP or HTTPS page before you enable automatic translation for this site.',
  statusChooseSettingAgain:
    'Select the setting again to show the Chrome access prompt.',
  statusSavedSiteLimit: 'The list of saved sites is full.',
  statusAutoAccessUpdateError: 'Chrome could not update automatic access: {0}',
  statusAutoScopeNotRetained: 'Chrome did not keep the requested automatic-access scope.',
  statusAutoOffForScope: 'Automatic translation is off for this scope.',
  statusAutoEnabledRegular: 'Automatic translation is enabled for regular web pages.',
  statusAutoEnabledThisSite: 'Automatic translation is enabled for this site.',

  // Read-scope controller: profile choice labels and descriptions.
  scopeControlLabelsTitle: 'Control labels and semantics',
  scopeControlLabelsDesc:
    'Read the text of public buttons, menus, field labels and disabled states.',
  scopeControlImagesTitle: 'Images inside controls',
  scopeControlImagesDesc:
    'Read navigation and control images that are not secret. Actions are still disabled.',
  scopeDisclosureTitle: 'Collapsed disclosure content',
  scopeDisclosureDesc:
    'Read validated menus and disclosures on the same page, also when they are collapsed.',
  scopeFormValuesTitle: 'Ordinary visible form values',
  scopeFormValuesDesc:
    'Read visible text, search, URL, number, date, time, textarea and selection state.',
  scopePersonalTitle: 'Personal and autofill values',
  scopePersonalDesc:
    'Read visible email, telephone, name, address and username fields. Credential and card data are still blocked.',
  scopeEditableTitle: 'Editable page content',
  scopeEditableDesc:
    'Read visible drafts in contenteditable areas and ARIA text editors that are not secret.',

  // Read-scope controller: save/reset statuses.
  statusApplyingNarrower: 'Applying narrower read settings…',
  statusSaving: 'Saving…',
  statusReadChangedElsewhere:
    'Settings changed in another panel. Look at the current choices and try again.',
  statusReadableChangedElsewhere:
    'Readable-content settings changed in another panel. Look at the current choices and try again.',
  statusPurgeUnconfirmedChange:
    'Another panel could not confirm its safety purge. Close it or try the change again.',
  statusReadNotApplied: 'The read settings were not applied.',
  statusReadableApplied: 'Simul applied the readable-content settings. Simul now rebuilds the mirror.',
  statusCouldNotSaveReadable: 'Simul could not save the readable-content settings: {0}',
  statusResettingSettingsPermissions: 'Resetting the settings and optional permissions…',
  statusRetryingCleanup: 'Trying the optional permission and runtime cleanup again…',
  statusResetChangedElsewhere:
    'Settings changed in another panel. Look at the current state before you reset.',
  statusPurgeUnconfirmedReset:
    'Another panel could not confirm its safety purge. Close it or try the reset again.',
  statusResettingSettings: 'Resetting the extension settings…',
  statusResetPendingOne:
    'Core settings are reset. {0} optional permission entry is still there and cleanup is not complete. Select Retry cleanup.',
  statusResetPendingMany:
    'Core settings are reset. {0} optional permission entries are still there and cleanup is not complete. Select Retry cleanup.',
  statusResetPendingGeneric:
    'Core settings are reset, but permission or runtime cleanup is not complete. Select Retry cleanup.',
  statusResetComplete: 'Settings and optional permissions were reset.',
  statusResetCouldNotFinish: 'The reset could not finish: {0}',
  statusPreparingSafeReset: 'Preparing a safe settings reset…',
  statusPreparingNarrower: 'Preparing narrower read settings…',
  setupCleanupPending:
    'Core settings are already safe, but optional permission or runtime cleanup is not complete.',
  retryResetCleanup: 'Retry reset cleanup',
  resetAllSettings: 'Reset all extension settings…',

  // Page-access guidance, raised as errors by lib/page-identity.ts and shown
  // in the status line and the mirror's error panel (review L5).
  pageAccessGuidance:
    'Open a regular HTTP or HTTPS page. Then select the extension on that page.',
  pageLocalFileGuidance:
    'Simul cannot read a PDF from this computer that is open in a tab. Open the file here instead.',
  pageChangedGuidance:
    'The source page changed or access expired. To give access again, select the extension on the source page.',
  pageTimeoutGuidance: 'The page did not respond in time. Try the current page again.',
  pageAccessLostGuidance:
    'The extension does not have access to this page now. To give access again, select its toolbar icon on the source page.',
  // Offered under the access messages above while Simul may not read every
  // site: Chrome then asks for Simul's toolbar icon on each new site (D165).
  allSitesAccessHint:
    'If you allow Simul to read all sites, it follows all pages that you open. You do not have to select the toolbar icon each time. Chrome asks you once. To change this, use Site access in the Chrome extension settings.',
  allowAllSitesAccess: 'Allow on all sites',

  // Preference client statuses.
  statusInvalidPreferenceResponse: 'The preference service sent a response that is not valid.',
  statusSettingsResetElsewhere:
    'Settings were reset in another panel. Look at the current choices and try again.',
  statusCouldNotSaveOptions: 'Simul could not save the options: {0}',
  statusImageOptionsChangedElsewhere:
    'Image options changed in another panel. Look at the current choices and try again.',
  statusCouldNotSaveImageOptions: 'Simul could not save the image options: {0}',

  // Quick composer.
  composerCharacterCount: '{0} of {1} characters used',
  composerWaitingLanguage: 'Website language not detected yet',
  composerDetecting:
    'Simul has not detected the website language yet. If it cannot find one clear language, select From in the toolbar.',
  composerLanguagesMatch: 'The languages are the same. Simul will copy the text without changes.',
  composerDraftNotSaved: 'Your draft is only in this panel. Simul does not save it.',
  composerTranslatingLocally: 'Translating on this device…',
  composerReversePairUnavailable: 'The reverse language pair is not available on this device.',
  composerReadyToCopy: 'The translation is ready to copy.',
  composerReplyReadyToCopy: 'The reply translation is ready to copy. Simul did not save it.',
  composerCouldNotTranslate: 'Simul could not translate the reply: {0}',
  composerCopied: 'Simul copied the translated text.',
  composerReplyCopied: 'Simul copied the translated reply.',
  composerCopyFailedSelected: 'Chrome could not copy automatically. The output is selected.',
  composerCopyFailedSelectedResult:
    'Chrome could not copy automatically. The result is selected and ready to copy.',

  // Image-analysis panel: section labels and descriptions.
  imagePanelHeading: 'Image text',
  imagePanelOptions: 'Image text options',
  imagePanelNoActivity: 'No OCR activity in this panel yet.',
  imageEnableLabel: 'Translate text inside images (local, experimental)',
  imageAccessibilityHint:
    'Accessibility text works without image access. Grant image access only if you want local pixel OCR as a fallback.',
  imageCheckingAccess: 'Checking Chrome image access…',
  imageOnByDefault:
    'On by default. Pixel OCR waits for image access. Visible image pixels do not leave this device, and Simul discards them after OCR.',
  imageGrantAccess: 'Grant image access',
  imageReadingPriority: 'Image reading priority',
  imagePriorityOrderHint:
    'This order sets which methods Simul tries first. It also decides between results that are almost equal.',
  imagePriorityMethodsHint:
    'Simul tries the methods from top to bottom. Simul can compare uncertain accessibility text with later OCR. The saved order decides between results that are almost equal.',
  imageTextDetectorHint:
    'Chrome TextDetector is experimental and changes with the platform. If its local detect probe is not available, Simul does no capture work for it. Simul then uses the next enabled provider.',
  imageTesseractNote:
    'Tesseract.js runs on this device with packaged language models. Simul loads only the language group that is necessary for the current page.',
  imageProvidersPaused: 'OCR is paused because all compiled providers are off.',
  imageScanScopeHint:
    'Select when Simul reads images: only when they are visible, after the visible work, or immediately.',
  imageScanImages: 'Scan images',
  imageSkipSmallHint:
    'Ignore very small images that probably do not contain useful text.',
  imageSkipSmall: 'Skip very small images',
  imagePromptLanguage: 'Use local Prompt for image language',
  imagePromptInterpret: 'Use local Prompt to interpret image text',
  imageDiagnostics: 'OCR diagnostics',
  imageDiagnosticsHint: 'Look at OCR stages and counts for this session. They contain no page content.',
  imageDiagnosticsPrivacy:
    'Stages and counts are kept in memory only. They never include page text, URLs, pixels or identifiers.',
  imageClearDiagnostics: 'Clear diagnostics',
  imageConfidenceHint:
    'OCR text must have this provider confidence before Simul uses it without a second, independent source.',
  imageMinConfidence: 'Minimum OCR confidence',
  imageHigherConfidenceHint:
    'Higher values give fewer incorrect text detections, but Simul can miss faint or stylized text.',
  imageMethodToggleHint:
    'Enable or disable this local image-reading method. Its priority does not change.',
  imageNoPixels: 'No pixels',
  imageAccessibilityUses:
    'Uses the aria-label or alt text of the image directly. Screenshot permission is not necessary.',
  imageMoveEarlier: 'Move earlier',
  imageMoveLater: 'Move later',
  imageProviderChecking: 'Checking…',
  imageProviderAvailable: 'Available',
  imageProviderUnavailable: 'Not available',
  imageMethodDisable: 'Disable {0}',
  imageMethodEnable: 'Enable {0}',
  imageProbeChecking: 'Simul checks if this Chrome runtime can complete a local detect call.',
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
