import { IMAGE_SCAN_POLICIES, isImageScanPolicy } from '../../lib/ocr/contracts';
import { ImageTranslationDiagnosticHistory } from '../../lib/ocr/diagnostic-history';
import type { ImageTextProviderId } from '../../lib/ocr/known-provider-ids';
import type { CompanionImageAnalysisSettingsPatch } from '../../lib/preferences';

export type ImageScanPolicyValue = (typeof IMAGE_SCAN_POLICIES)[number];
export type ImageCaptureAccessState = 'checking' | 'granted' | 'missing';
type ImageTranslationDiagnostic =
  Parameters<ImageTranslationDiagnosticHistory['append']>[0];

/** Everything the section displays; a change in any field triggers a rebuild. */
export interface ImageAnalysisPanelView {
  readonly imageTranslationEnabled: boolean;
  readonly imageCaptureAccess: ImageCaptureAccessState;
  readonly permissionInFlight: boolean;
  readonly imageTextProviderOrder: readonly ImageTextProviderId[];
  readonly imageScanPolicy: ImageScanPolicyValue;
  readonly skipSmallImages: boolean;
  readonly usePromptForImageLanguage: boolean;
  readonly usePromptForImageText: boolean;
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
  ) => readonly ImageTextProviderId[];
  readonly hasCompiledCapability: () => boolean;
  readonly readView: () => ImageAnalysisPanelView;
  readonly setUiText: (element: HTMLElement, english: string) => void;
  readonly changeImageTranslationEnabled: (enabled: boolean) => Promise<void>;
  readonly commitPatch: (patch: CompanionImageAnalysisSettingsPatch) => Promise<void>;
  readonly diagnostics?: ImageTranslationDiagnosticHistory;
}

/**
 * The "Image text" section under Advanced & experimental: the OCR toggle and
 * access grant, provider priority, scan policy, Prompt sidecars, and the
 * memory-only diagnostics log. It rebuilds only when something it shows
 * changed, so the control that fired a change is never destroyed under the
 * user's focus and the diagnostics disclosure keeps its open state.
 */
export class ImageAnalysisPanel {
  readonly diagnostics: ImageTranslationDiagnosticHistory;
  #root: HTMLElement | undefined;
  #renderKey: string | undefined;
  #output: HTMLOutputElement | undefined;

  constructor(private readonly environment: ImageAnalysisPanelEnvironment) {
    this.diagnostics = environment.diagnostics ?? new ImageTranslationDiagnosticHistory();
  }

  /** The section element, present only when an OCR provider is compiled in. */
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

  renderDiagnostics(): void {
    const output = this.#output;
    if (!output) return;
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
      view.imageScanPolicy,
      view.skipSmallImages,
      view.usePromptForImageLanguage,
      view.usePromptForImageText,
    ]);
    if (renderKey === this.#renderKey && root.childElementCount > 0) return;
    this.#renderKey = renderKey;
    const diagnosticsWereOpen =
      root.querySelector<HTMLDetailsElement>('details.image-diagnostics')?.open ?? false;
    root.replaceChildren();

    const heading = document.createElement('h3');
    setUiText(heading, 'Image text');
    root.append(heading);

    root.append(this.#createToggle(
      'Translate text inside images (local, experimental)',
      view.imageTranslationEnabled,
      this.environment.changeImageTranslationEnabled,
      view.permissionInFlight || view.imageCaptureAccess === 'checking',
    ));
    const privacyNote = document.createElement('p');
    privacyNote.className = 'microcopy';
    if (view.imageTranslationEnabled && view.imageCaptureAccess === 'missing') {
      setUiText(
        privacyNote,
        'Image translation is saved but paused. Grant image access so Chrome can capture visible pixels for local OCR.',
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
    if (view.imageTranslationEnabled && view.imageCaptureAccess === 'missing') {
      const grant = document.createElement('button');
      grant.type = 'button';
      grant.className = 'image-access-grant';
      setUiText(grant, 'Grant image access');
      grant.disabled = view.permissionInFlight;
      grant.addEventListener('click', () => {
        void this.environment.changeImageTranslationEnabled(true);
      });
      root.append(grant);
    }

    const compiledOrder = this.environment.compiledProviderOrder(view.imageTextProviderOrder);
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
        const up = this.#createOrderButton('↑', 'Move earlier', index === 0, () =>
          this.#moveProvider(view.imageTextProviderOrder, compiledOrder, index, -1),
        );
        const down = this.#createOrderButton(
          '↓',
          'Move later',
          index === compiledOrder.length - 1,
          () => this.#moveProvider(view.imageTextProviderOrder, compiledOrder, index, 1),
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
    }

    if (this.environment.capabilities.promptImageLanguage) {
      root.append(this.#createToggle(
        'Use local Prompt for image language',
        view.usePromptForImageLanguage,
        (checked) => this.environment.commitPatch({ usePromptForImageLanguage: checked }),
      ));
    }
    if (this.environment.capabilities.promptImageText) {
      root.append(this.#createToggle(
        'Use local Prompt to interpret image text',
        view.usePromptForImageText,
        (checked) => this.environment.commitPatch({ usePromptForImageText: checked }),
      ));
    }

    const diagnostics = document.createElement('details');
    diagnostics.className = 'image-diagnostics';
    diagnostics.open = diagnosticsWereOpen;
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
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'image-diagnostics-clear';
    setUiText(clear, 'Clear diagnostics');
    clear.addEventListener('click', () => {
      this.diagnostics.clear();
      this.renderDiagnostics();
    });
    diagnostics.append(summary, note, output, clear);
    root.append(diagnostics);
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

  #moveProvider(
    savedOrder: readonly ImageTextProviderId[],
    compiledOrder: readonly ImageTextProviderId[],
    index: number,
    direction: -1 | 1,
  ): void {
    const current = compiledOrder[index];
    const adjacent = compiledOrder[index + direction];
    if (!current || !adjacent) return;
    const next = [...savedOrder];
    const currentIndex = next.indexOf(current);
    const adjacentIndex = next.indexOf(adjacent);
    if (currentIndex < 0 || adjacentIndex < 0) return;
    [next[currentIndex], next[adjacentIndex]] = [
      next[adjacentIndex] as ImageTextProviderId,
      next[currentIndex] as ImageTextProviderId,
    ];
    void this.environment.commitPatch({ imageTextProviderOrder: next });
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

export function imageProviderName(id: ImageTextProviderId): string {
  const names: Record<ImageTextProviderId, string> = {
    'chrome-text-detector': 'Chrome Text Detector',
    tesseract: 'Tesseract.js',
    transformers: 'Transformers.js',
    'paddleocr-wasm': 'PaddleOCR Wasm',
    'chromium-screen-ai': 'Chromium Screen AI',
  };
  return names[id];
}

export function imageScanPolicyName(value: ImageScanPolicyValue): string {
  if (value === 'visible-only') return 'Only when visible';
  if (value === 'eager-all') return 'Everything immediately';
  return 'Visible first, then background';
}
