import { UI_STRINGS } from '../../lib/companion-ui-strings';
import { IMAGE_SCAN_POLICIES, isImageScanPolicy } from '../../lib/ocr/contracts';
import { ImageTranslationDiagnosticHistory } from '../../lib/ocr/diagnostic-history';
import {
  ACCESSIBILITY_TEXT_METHOD_ID,
  visibleImageReadingMethodOrder,
  type ImageReadingMethodId,
} from '../../lib/ocr/image-reading-methods';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import type { OcrProviderRuntimeStatus } from '../../lib/ocr/provider-status-protocol';
import {
  OCR_MINIMUM_CONFIDENCE_OPTIONS,
  isOcrMinimumConfidence,
} from '../../lib/ocr/result-quality';
import type { CompanionImageAnalysisSettingsPatch } from '../../lib/preferences';

export type ImageScanPolicyValue = (typeof IMAGE_SCAN_POLICIES)[number];
export type ImageCaptureAccessState = 'checking' | 'granted' | 'missing';
export type ImageTranslationDiagnostic =
  Parameters<ImageTranslationDiagnosticHistory['append']>[0];
export type ProviderRuntimeStatuses = ReadonlyMap<
  ImageTextProviderId,
  OcrProviderRuntimeStatus | 'checking'
>;

/** Everything the section displays; a change in any field triggers a rebuild. */
export interface ImageAnalysisPanelView {
  readonly imageTranslationEnabled: boolean;
  readonly imageCaptureAccess: ImageCaptureAccessState;
  readonly permissionInFlight: boolean;
  readonly imageTextProviderOrder: readonly ImageTextProviderId[];
  readonly disabledImageTextProviderIds: readonly ImageTextProviderId[];
  readonly imageReadingMethodOrder: readonly ImageReadingMethodId[];
  readonly disabledImageReadingMethodIds: readonly ImageReadingMethodId[];
  readonly ocrMinimumConfidence: number;
  readonly imageScanPolicy: ImageScanPolicyValue;
  readonly skipSmallImages: boolean;
  readonly usePromptForImageLanguage: boolean;
  readonly usePromptForImageText: boolean;
  readonly providerRuntimeStatuses: ProviderRuntimeStatuses;
  /** Pixel OCR providers that are enabled and ready in this runtime. */
  readonly usablePixelProviderCount: number;
}

export interface ImageAnalysisPanelEnvironment {
  readonly document: Document;
  readonly host: HTMLElement;
  readonly capabilities: {
    readonly promptImageLanguage: boolean;
    readonly promptImageText: boolean;
  };
  /** The saved provider order filtered to providers compiled into this build. */
  readonly compiledProviderOrder: (
    order: readonly ImageTextProviderId[],
    disabledProviderIds?: readonly ImageTextProviderId[],
  ) => readonly ImageTextProviderId[];
  readonly hasCompiledCapability: () => boolean;
  readonly readView: () => ImageAnalysisPanelView;
  readonly setUiText: (element: HTMLElement, english: string) => void;
  readonly setUiAttr: (
    element: HTMLElement,
    attribute: 'title' | 'aria-label' | 'placeholder',
    english: string,
  ) => void;
  /** Localizes one English catalogue string for imperatively set text. */
  readonly localizeUi: (english: string) => string;
  /** Localizes a template frame and fills its numbered placeholders. */
  readonly localizeTemplate: (
    frame: string,
    ...args: readonly (string | number)[]
  ) => string;
  readonly changeImageTranslationEnabled: (
    enabled: boolean,
    requestPixelAccess?: boolean,
  ) => Promise<void>;
  readonly commitPatch: (patch: CompanionImageAnalysisSettingsPatch) => Promise<void>;
  readonly diagnostics?: ImageTranslationDiagnosticHistory;
}

/**
 * The "Image text" section under Advanced & experimental: the image
 * translation toggle and access grant, the minimum OCR confidence, the
 * image-reading method order with per-method toggles and runtime status,
 * scan policy, Prompt sidecars, and the memory-only diagnostics log. It
 * rebuilds only when something it shows changed, so the control that fired
 * a change is never destroyed under the user's focus and the diagnostics
 * disclosure keeps its open state.
 */
export class ImageAnalysisPanel {
  readonly diagnostics: ImageTranslationDiagnosticHistory;
  #root: HTMLElement | undefined;
  #renderKey: string | undefined;
  #details: HTMLDetailsElement | undefined;
  #output: HTMLOutputElement | undefined;
  /**
   * Re-applies each method toggle's templated aria-label. The label is
   * written with `localizeTemplate` rather than the `data-ui` marker path, so
   * the localizer's DOM pass cannot re-drive it; these thunks are rebuilt
   * whenever the method list is.
   */
  #methodToggleRelocalizers: readonly (() => void)[] = [];

  constructor(private readonly environment: ImageAnalysisPanelEnvironment) {
    this.diagnostics =
      environment.diagnostics ?? new ImageTranslationDiagnosticHistory();
  }

  /** The section element, present only when image analysis is compiled in. */
  get root(): HTMLElement | undefined {
    return this.#root;
  }

  initialize(): void {
    if (!this.environment.hasCompiledCapability()) return;
    const { document, host } = this.environment;
    this.#root = document.createElement('section');
    this.#root.className = 'image-analysis-settings';
    this.environment.setUiAttr(this.#root, 'aria-label', UI_STRINGS.imagePanelOptions);
    host.append(this.#root);
    this.render();
  }

  /** Appends one content-free diagnostic and refreshes the log output. */
  recordDiagnostic(diagnostic: ImageTranslationDiagnostic): void {
    this.diagnostics.append(diagnostic);
    this.renderDiagnostics();
  }

  clearDiagnostics(): void {
    this.diagnostics.clear();
    this.renderDiagnostics();
  }

  /**
   * Re-renders the panel's imperatively written text after a language switch
   * (finding F2): the diagnostics empty-state placeholder and each method
   * toggle's templated aria-label. Both are written outside the `data-ui`
   * marker path, so the localizer's DOM pass does not re-drive them; the rest
   * of the panel re-localizes through that pass. Recorded diagnostic lines are
   * content-free and language-independent, so re-joining them is harmless.
   */
  relocalize(): void {
    for (const apply of this.#methodToggleRelocalizers) apply();
    this.renderDiagnostics();
  }

  renderDiagnostics(): void {
    const output = this.#output;
    if (!output || this.#details?.open === false) return;
    const entries = this.diagnostics.entries;
    output.textContent = entries.length > 0
      ? entries.join('\n')
      : this.environment.localizeUi(UI_STRINGS.imagePanelNoActivity);
  }

  render(): void {
    const root = this.#root;
    if (!root) return;
    const { document, setUiText } = this.environment;
    const view = this.environment.readView();
    const renderKey = JSON.stringify([
      view.imageTranslationEnabled,
      view.imageCaptureAccess,
      view.permissionInFlight,
      view.imageTextProviderOrder,
      view.disabledImageTextProviderIds,
      view.imageReadingMethodOrder,
      view.disabledImageReadingMethodIds,
      view.ocrMinimumConfidence,
      view.imageScanPolicy,
      view.skipSmallImages,
      view.usePromptForImageLanguage,
      view.usePromptForImageText,
      [...view.providerRuntimeStatuses],
      view.usablePixelProviderCount,
    ]);
    if (renderKey === this.#renderKey && root.childElementCount > 0) return;
    this.#renderKey = renderKey;
    const diagnosticsWereOpen = this.#details?.open ?? false;
    root.replaceChildren();

    const heading = document.createElement('h3');
    setUiText(heading, UI_STRINGS.imagePanelHeading);
    root.append(heading);

    root.append(this.#createToggle(
      UI_STRINGS.imageEnableLabel,
      view.imageTranslationEnabled,
      (checked) => this.environment.changeImageTranslationEnabled(checked),
      view.permissionInFlight || view.imageCaptureAccess === 'checking',
    ));
    const privacyNote = document.createElement('p');
    privacyNote.className = 'microcopy';
    const pixelAccessMissing =
      view.imageTranslationEnabled &&
      view.imageCaptureAccess === 'missing' &&
      view.usablePixelProviderCount > 0;
    if (pixelAccessMissing) {
      setUiText(privacyNote, UI_STRINGS.imageAccessibilityHint);
    } else if (view.imageCaptureAccess === 'checking') {
      setUiText(privacyNote, UI_STRINGS.imageCheckingAccess);
    } else {
      setUiText(privacyNote, UI_STRINGS.imageOnByDefault);
    }
    root.append(privacyNote);
    if (pixelAccessMissing) {
      const grant = document.createElement('button');
      grant.type = 'button';
      grant.className = 'image-access-grant';
      setUiText(grant, UI_STRINGS.imageGrantAccess);
      grant.disabled = view.permissionInFlight;
      grant.addEventListener('click', () => {
        void this.environment.changeImageTranslationEnabled(true, true);
      });
      root.append(grant);
    }

    const compiledOrder = this.environment.compiledProviderOrder(
      view.imageTextProviderOrder,
    );
    if (compiledOrder.length > 0) {
      root.append(this.#createConfidenceControl(view.ocrMinimumConfidence));
    }

    const orderLabel = document.createElement('p');
    orderLabel.className = 'microcopy';
    setUiText(orderLabel, UI_STRINGS.imageReadingPriority);
    this.environment.setUiAttr(orderLabel, 'title', UI_STRINGS.imagePriorityOrderHint);
    root.append(orderLabel);
    const orderHelp = document.createElement('p');
    orderHelp.className = 'microcopy';
    setUiText(orderHelp, UI_STRINGS.imagePriorityMethodsHint);
    root.append(orderHelp);
    root.append(this.#createMethodList(view, compiledOrder));
    if (compiledOrder.includes('chrome-text-detector')) {
      const platformNote = document.createElement('p');
      platformNote.className = 'microcopy';
      setUiText(platformNote, UI_STRINGS.imageTextDetectorHint);
      root.append(platformNote);
    }
    if (compiledOrder.includes('tesseract')) {
      const tesseractNote = document.createElement('p');
      tesseractNote.className = 'microcopy';
      setUiText(tesseractNote, UI_STRINGS.imageTesseractNote);
      root.append(tesseractNote);
    }
    if (
      this.environment.compiledProviderOrder(
        view.imageTextProviderOrder,
        view.disabledImageTextProviderIds,
      ).length === 0
    ) {
      const paused = document.createElement('p');
      paused.className = 'microcopy ocr-provider-paused';
      setUiText(paused, UI_STRINGS.imageProvidersPaused);
      root.append(paused);
    }

    const grid = document.createElement('div');
    grid.className = 'settings-grid';
    const policyLabel = document.createElement('label');
    this.environment.setUiAttr(policyLabel, 'title', UI_STRINGS.imageScanScopeHint);
    const policyTitle = document.createElement('span');
    setUiText(policyTitle, UI_STRINGS.imageScanImages);
    const policy = document.createElement('select');
    for (const value of IMAGE_SCAN_POLICIES) {
      const label = imageScanPolicyName(value);
      const option = document.createElement('option');
      option.setAttribute('value', value);
      if (value === view.imageScanPolicy) option.setAttribute('selected', '');
      setUiText(option, label);
      policy.append(option);
    }
    policy.addEventListener('change', () => {
      if (isImageScanPolicy(policy.value)) {
        void this.environment.commitPatch({ imageScanPolicy: policy.value });
      }
    });
    policyLabel.append(policyTitle, policy);
    const smallLabel = document.createElement('label');
    smallLabel.className = 'check-label';
    this.environment.setUiAttr(smallLabel, 'title', UI_STRINGS.imageSkipSmallHint);
    const small = document.createElement('input');
    small.type = 'checkbox';
    small.checked = view.skipSmallImages;
    small.addEventListener('change', () => {
      void this.environment.commitPatch({ skipSmallImages: small.checked });
    });
    const smallTitle = document.createElement('span');
    setUiText(smallTitle, UI_STRINGS.imageSkipSmall);
    smallLabel.append(small, smallTitle);
    grid.append(policyLabel, smallLabel);
    root.append(grid);

    if (this.environment.capabilities.promptImageLanguage) {
      root.append(this.#createToggle(
        UI_STRINGS.imagePromptLanguage,
        view.usePromptForImageLanguage,
        (checked) => this.environment.commitPatch({
          usePromptForImageLanguage: checked,
        }),
      ));
    }
    if (this.environment.capabilities.promptImageText) {
      root.append(this.#createToggle(
        UI_STRINGS.imagePromptInterpret,
        view.usePromptForImageText,
        (checked) => this.environment.commitPatch({
          usePromptForImageText: checked,
        }),
      ));
    }

    const diagnostics = document.createElement('details');
    diagnostics.className = 'image-diagnostics';
    diagnostics.open = diagnosticsWereOpen;
    this.#details = diagnostics;
    const summary = document.createElement('summary');
    setUiText(summary, UI_STRINGS.imageDiagnostics);
    this.environment.setUiAttr(summary, 'title', UI_STRINGS.imageDiagnosticsHint);
    const note = document.createElement('p');
    note.className = 'microcopy';
    setUiText(note, UI_STRINGS.imageDiagnosticsPrivacy);
    const output = document.createElement('output');
    output.className = 'image-diagnostics-output';
    output.setAttribute('aria-live', 'polite');
    this.#output = output;
    this.renderDiagnostics();
    diagnostics.addEventListener('toggle', () => this.renderDiagnostics());
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'image-diagnostics-clear';
    setUiText(clear, UI_STRINGS.imageClearDiagnostics);
    clear.addEventListener('click', () => this.clearDiagnostics());
    diagnostics.append(summary, note, output, clear);
    root.append(diagnostics);
  }

  #createConfidenceControl(current: number): HTMLLabelElement {
    const { document, setUiText } = this.environment;
    const confidence = document.createElement('label');
    confidence.className = 'ocr-confidence-control';
    this.environment.setUiAttr(confidence, 'title', UI_STRINGS.imageConfidenceHint);
    const confidenceTitle = document.createElement('span');
    setUiText(confidenceTitle, UI_STRINGS.imageMinConfidence);
    const confidenceRow = document.createElement('span');
    confidenceRow.className = 'ocr-confidence-row';
    const confidenceInput = document.createElement('input');
    confidenceInput.id = 'ocr-minimum-confidence';
    confidenceInput.type = 'range';
    confidenceInput.min = '25';
    confidenceInput.max = '95';
    confidenceInput.step = '5';
    confidenceInput.value = String(current * 100);
    confidenceInput.setAttribute('aria-describedby', 'ocr-minimum-confidence-help');
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
        void this.environment.commitPatch({ ocrMinimumConfidence: selected });
      }
    });
    confidenceRow.append(confidenceInput, confidenceOutput);
    const confidenceHelp = document.createElement('small');
    confidenceHelp.id = 'ocr-minimum-confidence-help';
    confidenceHelp.className = 'microcopy';
    setUiText(confidenceHelp, UI_STRINGS.imageHigherConfidenceHint);
    confidence.append(confidenceTitle, confidenceRow, confidenceHelp);
    return confidence;
  }

  #createMethodList(
    view: ImageAnalysisPanelView,
    compiledOrder: readonly ImageTextProviderId[],
  ): HTMLOListElement {
    const { document } = this.environment;
    const list = document.createElement('ol');
    list.className = 'ocr-provider-order';
    const disabledMethods = new Set(view.disabledImageReadingMethodIds);
    const readingOrder = visibleImageReadingMethodOrder(
      view.imageReadingMethodOrder,
      compiledOrder,
    );
    const toggleRelocalizers: (() => void)[] = [];
    this.#methodToggleRelocalizers = toggleRelocalizers;
    readingOrder.forEach((id, index) => {
      const item = document.createElement('li');
      const providerToggle = document.createElement('label');
      providerToggle.className = 'ocr-provider-toggle';
      this.environment.setUiAttr(providerToggle, 'title', UI_STRINGS.imageMethodToggleHint);
      const enabled = document.createElement('input');
      enabled.type = 'checkbox';
      enabled.checked = !disabledMethods.has(id);
      const applyToggleLabel = (): void => {
        enabled.setAttribute(
          'aria-label',
          this.environment.localizeTemplate(
            enabled.checked ? UI_STRINGS.imageMethodDisable : UI_STRINGS.imageMethodEnable,
            this.environment.localizeUi(imageReadingMethodName(id)),
          ),
        );
      };
      applyToggleLabel();
      toggleRelocalizers.push(applyToggleLabel);
      enabled.addEventListener('change', () => {
        const nextDisabled = new Set(view.disabledImageReadingMethodIds);
        if (enabled.checked) nextDisabled.delete(id);
        else nextDisabled.add(id);
        void this.environment.commitPatch({
          disabledImageReadingMethodIds: view.imageReadingMethodOrder
            .filter((methodId) => nextDisabled.has(methodId)),
        });
      });
      const name = document.createElement('span');
      this.environment.setUiText(name, imageReadingMethodName(id));
      providerToggle.append(enabled, name);
      item.append(providerToggle);
      if (id === ACCESSIBILITY_TEXT_METHOD_ID) {
        const status = document.createElement('span');
        status.className = 'ocr-provider-status ocr-provider-status-available';
        this.environment.setUiText(status, UI_STRINGS.imageNoPixels);
        this.environment.setUiAttr(status, 'title', UI_STRINGS.imageAccessibilityUses);
        item.append(status);
      } else {
        const runtimeStatus = view.providerRuntimeStatuses.get(id);
        if (runtimeStatus) item.append(this.#createRuntimeStatus(runtimeStatus));
      }
      const buttons = document.createElement('span');
      buttons.className = 'ocr-order-buttons';
      const up = this.#createOrderButton('↑', UI_STRINGS.imageMoveEarlier, index === 0, () =>
        this.#moveMethod(view.imageReadingMethodOrder, readingOrder, index, -1),
      );
      const down = this.#createOrderButton(
        '↓',
        UI_STRINGS.imageMoveLater,
        index === readingOrder.length - 1,
        () => this.#moveMethod(view.imageReadingMethodOrder, readingOrder, index, 1),
      );
      buttons.append(up, down);
      item.append(buttons);
      list.append(item);
    });
    return list;
  }

  #createRuntimeStatus(
    runtimeStatus: OcrProviderRuntimeStatus | 'checking',
  ): HTMLSpanElement {
    const status = this.environment.document.createElement('span');
    status.className = runtimeStatus === 'checking'
      ? 'ocr-provider-status'
      : `ocr-provider-status ocr-provider-status-${runtimeStatus.status}`;
    this.environment.setUiText(status, runtimeStatus === 'checking'
      ? UI_STRINGS.imageProviderChecking
      : runtimeStatus.status === 'available'
        ? UI_STRINGS.imageProviderAvailable
        : UI_STRINGS.imageProviderUnavailable);
    this.environment.setUiAttr(status, 'title', runtimeStatus === 'checking'
      ? UI_STRINGS.imageProbeChecking
      : runtimeStatus.status === 'available'
        ? UI_STRINGS.imageProbeAvailable
        : runtimeStatus.reason === 'api-missing'
          ? UI_STRINGS.imageProbeUnavailable
          : UI_STRINGS.imageProbeError);
    return status;
  }

  #createOrderButton(
    text: string,
    label: string,
    disabled: boolean,
    action: () => void,
  ): HTMLButtonElement {
    const button = this.environment.document.createElement('button');
    button.type = 'button';
    button.textContent = text;
    this.environment.setUiAttr(button, 'aria-label', label);
    this.environment.setUiAttr(button, 'title', label);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
  }

  #moveMethod(
    savedOrder: readonly ImageReadingMethodId[],
    renderedOrder: readonly ImageReadingMethodId[],
    index: number,
    direction: -1 | 1,
  ): void {
    const current = renderedOrder[index];
    const adjacent = renderedOrder[index + direction];
    if (!current || !adjacent) return;
    const next = [...savedOrder];
    const currentIndex = next.indexOf(current);
    const adjacentIndex = next.indexOf(adjacent);
    if (currentIndex < 0 || adjacentIndex < 0) return;
    [next[currentIndex], next[adjacentIndex]] = [
      next[adjacentIndex] as ImageReadingMethodId,
      next[currentIndex] as ImageReadingMethodId,
    ];
    void this.environment.commitPatch({ imageReadingMethodOrder: next });
  }

  #createToggle(
    label: string,
    checked: boolean,
    save: (checked: boolean) => Promise<void>,
    disabled = false,
  ): HTMLLabelElement {
    const { document, setUiText } = this.environment;
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
}

export function imageReadingMethodName(id: ImageReadingMethodId): string {
  if (id === ACCESSIBILITY_TEXT_METHOD_ID) {
    return UI_STRINGS.imageMethodAccessibility;
  }
  const names: Record<ImageTextProviderId, string> = {
    'chrome-text-detector': UI_STRINGS.imageMethodTextDetector,
    tesseract: UI_STRINGS.imageMethodTesseract,
    transformers: UI_STRINGS.imageMethodTransformers,
    'chromium-screen-ai': UI_STRINGS.imageMethodScreenAi,
  };
  return names[id];
}

export function imageScanPolicyName(value: ImageScanPolicyValue): string {
  if (value === 'visible-only') return UI_STRINGS.imageScanVisible;
  if (value === 'eager-all') return UI_STRINGS.imageScanImmediate;
  return UI_STRINGS.imageScanVisibleFirst;
}
