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
    this.#root.setAttribute('aria-label', 'Image text options');
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

  renderDiagnostics(): void {
    const output = this.#output;
    if (!output || this.#details?.open === false) return;
    const entries = this.diagnostics.entries;
    output.textContent = entries.length > 0
      ? entries.join('\n')
      : 'No OCR activity in this companion view yet.';
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
    setUiText(heading, 'Image text');
    root.append(heading);

    root.append(this.#createToggle(
      'Translate text inside images (local, experimental)',
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
      setUiText(
        privacyNote,
        'Accessibility text can run without image access. Grant image access only to enable local pixel OCR fallbacks.',
      );
    } else if (view.imageCaptureAccess === 'checking') {
      setUiText(privacyNote, 'Checking Chrome image access…');
    } else {
      setUiText(
        privacyNote,
        'Off by default. Visible image pixels stay on this device and are discarded after OCR.',
      );
    }
    root.append(privacyNote);
    if (pixelAccessMissing) {
      const grant = document.createElement('button');
      grant.type = 'button';
      grant.className = 'image-access-grant';
      setUiText(grant, 'Grant image access');
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
    root.append(this.#createMethodList(view, compiledOrder));
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
      this.environment.compiledProviderOrder(
        view.imageTextProviderOrder,
        view.disabledImageTextProviderIds,
      ).length === 0
    ) {
      const paused = document.createElement('p');
      paused.className = 'microcopy ocr-provider-paused';
      setUiText(paused, 'OCR is paused because every compiled provider is off.');
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
    smallLabel.title =
      'Ignore tiny images that are unlikely to contain useful readable text.';
    const small = document.createElement('input');
    small.type = 'checkbox';
    small.checked = view.skipSmallImages;
    small.addEventListener('change', () => {
      void this.environment.commitPatch({ skipSmallImages: small.checked });
    });
    const smallTitle = document.createElement('span');
    setUiText(smallTitle, 'Skip very small images');
    smallLabel.append(small, smallTitle);
    grid.append(policyLabel, smallLabel);
    root.append(grid);

    if (this.environment.capabilities.promptImageLanguage) {
      root.append(this.#createToggle(
        'Use local Prompt for image language',
        view.usePromptForImageLanguage,
        (checked) => this.environment.commitPatch({
          usePromptForImageLanguage: checked,
        }),
      ));
    }
    if (this.environment.capabilities.promptImageText) {
      root.append(this.#createToggle(
        'Use local Prompt to interpret image text',
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
    this.#output = output;
    this.renderDiagnostics();
    diagnostics.addEventListener('toggle', () => this.renderDiagnostics());
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'image-diagnostics-clear';
    setUiText(clear, 'Clear diagnostics');
    clear.addEventListener('click', () => this.clearDiagnostics());
    diagnostics.append(summary, note, output, clear);
    root.append(diagnostics);
  }

  #createConfidenceControl(current: number): HTMLLabelElement {
    const { document, setUiText } = this.environment;
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
    setUiText(
      confidenceHelp,
      'Higher values reduce false text detections but may miss faint or stylized text.',
    );
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
        const nextDisabled = new Set(view.disabledImageReadingMethodIds);
        if (enabled.checked) nextDisabled.delete(id);
        else nextDisabled.add(id);
        void this.environment.commitPatch({
          disabledImageReadingMethodIds: view.imageReadingMethodOrder
            .filter((methodId) => nextDisabled.has(methodId)),
        });
      });
      const name = document.createElement('span');
      name.textContent = imageReadingMethodName(id);
      providerToggle.append(enabled, name);
      item.append(providerToggle);
      if (id === ACCESSIBILITY_TEXT_METHOD_ID) {
        const status = document.createElement('span');
        status.className = 'ocr-provider-status ocr-provider-status-available';
        status.textContent = 'No pixels';
        status.title =
          'Uses direct image aria-label or alt text and does not require screenshot permission.';
        item.append(status);
      } else {
        const runtimeStatus = view.providerRuntimeStatuses.get(id);
        if (runtimeStatus) item.append(this.#createRuntimeStatus(runtimeStatus));
      }
      const buttons = document.createElement('span');
      buttons.className = 'ocr-order-buttons';
      const up = this.#createOrderButton('↑', 'Move earlier', index === 0, () =>
        this.#moveMethod(view.imageReadingMethodOrder, readingOrder, index, -1),
      );
      const down = this.#createOrderButton(
        '↓',
        'Move later',
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
    button.setAttribute('aria-label', label);
    button.title = label;
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

export function imageScanPolicyName(value: ImageScanPolicyValue): string {
  if (value === 'visible-only') return 'Only when visible';
  if (value === 'eager-all') return 'Everything immediately';
  return 'Visible first, then background';
}
