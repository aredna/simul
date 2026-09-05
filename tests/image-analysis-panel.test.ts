import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  ImageAnalysisPanel,
  imageReadingMethodName,
  imageScanPolicyName,
  type ImageAnalysisPanelView,
} from '../entrypoints/sidepanel/image-analysis-panel';
import type { ImageTextProviderId } from '../lib/ocr/known-provider-ids';

const COMPILED: readonly ImageTextProviderId[] = ['chrome-text-detector', 'tesseract'];

function setup(initial: Partial<ImageAnalysisPanelView> = {}) {
  const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
  let view: ImageAnalysisPanelView = {
    imageTranslationEnabled: false,
    imageCaptureAccess: 'granted',
    permissionInFlight: false,
    imageTextProviderOrder: ['chrome-text-detector', 'tesseract'],
    disabledImageTextProviderIds: [],
    imageReadingMethodOrder: ['accessibility-text', 'chrome-text-detector', 'tesseract'],
    disabledImageReadingMethodIds: [],
    ocrMinimumConfidence: 0.65,
    imageScanPolicy: 'visible-only',
    skipSmallImages: true,
    usePromptForImageLanguage: false,
    usePromptForImageText: false,
    providerRuntimeStatuses: new Map([
      ['chrome-text-detector', 'checking'],
    ]),
    usablePixelProviderCount: 1,
    ...initial,
  };
  const commitPatch = vi.fn(async () => undefined);
  const changeImageTranslationEnabled = vi.fn(async () => undefined);
  const panel = new ImageAnalysisPanel({
    document: document as unknown as Document,
    host: document.getElementById('host') as unknown as HTMLElement,
    capabilities: { promptImageLanguage: true, promptImageText: false },
    compiledProviderOrder: (order, disabled = []) =>
      order.filter((id) => COMPILED.includes(id) && !disabled.includes(id)),
    hasCompiledCapability: () => true,
    readView: () => view,
    setUiText: (element, english) => {
      element.dataset.uiLabel = english;
      element.textContent = english;
    },
    changeImageTranslationEnabled,
    commitPatch,
  });
  return {
    document,
    window,
    panel,
    commitPatch,
    changeImageTranslationEnabled,
    setView: (next: Partial<ImageAnalysisPanelView>) => {
      view = { ...view, ...next };
    },
  };
}

describe('ImageAnalysisPanel', () => {
  it('renders the section once and keeps the same nodes while nothing changed', () => {
    const { document, panel } = setup();
    panel.initialize();
    const root = panel.root!;
    expect(document.querySelector('.image-analysis-settings')).toBe(root);
    expect(root.querySelectorAll('.ocr-provider-order li')).toHaveLength(3);
    const firstHeading = root.querySelector('h3');

    panel.render();
    expect(root.querySelector('h3')).toBe(firstHeading);
  });

  it('rebuilds when the view changes and keeps the diagnostics disclosure open', () => {
    const { panel, setView } = setup();
    panel.initialize();
    const root = panel.root!;
    const details = root.querySelector<HTMLDetailsElement>('details.image-diagnostics')!;
    details.open = true;
    const before = root.querySelector('h3');

    setView({ imageTranslationEnabled: true, imageCaptureAccess: 'missing' });
    panel.render();

    expect(root.querySelector('h3')).not.toBe(before);
    expect(root.querySelector<HTMLDetailsElement>('details.image-diagnostics')?.open).toBe(true);
    expect(root.querySelector('.image-access-grant')).not.toBeNull();
    expect(root.querySelector('.microcopy')?.textContent).toContain('Grant image access only');

    // Without a usable pixel provider there is nothing to grant access for.
    setView({ usablePixelProviderCount: 0 });
    panel.render();
    expect(root.querySelector('.image-access-grant')).toBeNull();
    expect(root.querySelector('.microcopy')?.textContent).toContain('Off by default');
  });

  it('toggles image translation and requests pixel access from the grant button', () => {
    const { window, panel, changeImageTranslationEnabled } = setup({
      imageTranslationEnabled: true,
      imageCaptureAccess: 'missing',
    });
    panel.initialize();
    const root = panel.root!;
    root.querySelector<HTMLButtonElement>('.image-access-grant')!
      .dispatchEvent(new window.Event('click'));
    expect(changeImageTranslationEnabled).toHaveBeenCalledWith(true, true);

    const toggle = root.querySelector<HTMLInputElement>('.image-prompt-toggle input')!;
    toggle.checked = false;
    toggle.dispatchEvent(new window.Event('change'));
    expect(changeImageTranslationEnabled).toHaveBeenCalledWith(false);
  });

  it('renders the confidence slider in five-percent steps and saves a listed value', () => {
    const { window, panel, commitPatch } = setup();
    panel.initialize();
    const root = panel.root!;
    const input = root.querySelector<HTMLInputElement>('#ocr-minimum-confidence')!;
    expect(input.type).toBe('range');
    expect([input.min, input.max, input.step]).toEqual(['25', '95', '5']);
    expect(input.value).toBe('65');
    expect(input.getAttribute('aria-describedby')).toBe('ocr-minimum-confidence-help');
    expect(root.querySelector('#ocr-minimum-confidence-help')).not.toBeNull();
    const output = root.querySelector<HTMLOutputElement>('.ocr-confidence-row output')!;
    expect(output.value).toBe('65%');

    input.value = '80';
    input.dispatchEvent(new window.Event('input'));
    expect(output.value).toBe('80%');
    input.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledWith({ ocrMinimumConfidence: 0.8 });

    input.value = '82';
    input.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledTimes(1);
  });

  it('lists every reading method with its status, toggles them, and reorders in saved order', () => {
    const { window, panel, commitPatch, setView } = setup({
      imageReadingMethodOrder: ['accessibility-text', 'transformers', 'chrome-text-detector', 'tesseract'],
      providerRuntimeStatuses: new Map([
        ['chrome-text-detector', { status: 'unavailable', providerId: 'chrome-text-detector', reason: 'api-missing' }],
      ]),
    });
    panel.initialize();
    const root = panel.root!;
    const items = [...root.querySelectorAll('.ocr-provider-order li')];
    // The uncompiled transformers method is hidden; accessibility text stays.
    expect(items.map((item) => item.querySelector('label span')?.textContent)).toEqual([
      'Accessibility text (aria-label / alt)',
      'Chrome TextDetector (platform)',
      'Tesseract.js (local)',
    ]);
    expect(items[0]?.querySelector('.ocr-provider-status')?.textContent).toBe('No pixels');
    const detectorStatus = items[1]?.querySelector('.ocr-provider-status');
    expect(detectorStatus?.textContent).toBe('Unavailable');
    expect(detectorStatus?.getAttribute('title')).toContain('does not expose');
    expect(items[2]?.querySelector('.ocr-provider-status')).toBeNull();

    const detectorToggle = items[1]!.querySelector<HTMLInputElement>('input')!;
    expect(detectorToggle.getAttribute('aria-label')).toBe('Disable Chrome TextDetector (platform)');
    detectorToggle.checked = false;
    detectorToggle.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledWith({
      disabledImageReadingMethodIds: ['chrome-text-detector'],
    });

    const buttons = items[1]!.querySelectorAll<HTMLButtonElement>('.ocr-order-buttons button');
    expect(buttons[0]?.disabled).toBe(false);
    buttons[1]!.dispatchEvent(new window.Event('click'));
    expect(commitPatch).toHaveBeenLastCalledWith({
      imageReadingMethodOrder: ['accessibility-text', 'transformers', 'tesseract', 'chrome-text-detector'],
    });
    expect(items[0]!.querySelectorAll<HTMLButtonElement>('.ocr-order-buttons button')[0]?.disabled)
      .toBe(true);

    setView({
      disabledImageReadingMethodIds: ['chrome-text-detector'],
      providerRuntimeStatuses: new Map([['chrome-text-detector', 'checking']]),
    });
    panel.render();
    const rerendered = [...root.querySelectorAll('.ocr-provider-order li')];
    expect(rerendered[1]?.querySelector('input')?.getAttribute('aria-label'))
      .toBe('Enable Chrome TextDetector (platform)');
    expect(rerendered[1]?.querySelector('.ocr-provider-status')?.textContent).toBe('Checking…');
  });

  it('notes platform providers and a fully paused OCR set', () => {
    const { panel, setView } = setup();
    panel.initialize();
    const root = panel.root!;
    const notes = () => [...root.querySelectorAll('p.microcopy')].map((p) => p.textContent);
    expect(notes().some((text) => text?.startsWith('Chrome TextDetector is experimental'))).toBe(true);
    expect(notes().some((text) => text?.startsWith('Tesseract.js runs locally'))).toBe(true);
    expect(root.querySelector('.ocr-provider-paused')).toBeNull();

    setView({ disabledImageTextProviderIds: ['chrome-text-detector', 'tesseract'] });
    panel.render();
    expect(root.querySelector('.ocr-provider-paused')?.textContent)
      .toBe('OCR is paused because every compiled provider is off.');
  });

  it('saves scan policy, small-image and Prompt changes from their controls', () => {
    const { window, panel, commitPatch } = setup();
    panel.initialize();
    const root = panel.root!;
    const policy = root.querySelector<HTMLSelectElement>('.settings-grid select')!;
    expect(policy.querySelector('option[selected]')?.getAttribute('value')).toBe('visible-only');
    Object.defineProperty(policy, 'value', { configurable: true, value: 'eager-all' });
    policy.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledWith({ imageScanPolicy: 'eager-all' });

    const small = root.querySelector<HTMLInputElement>('.settings-grid .check-label input')!;
    small.checked = false;
    small.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledWith({ skipSmallImages: false });

    const prompt = [...root.querySelectorAll<HTMLInputElement>('.image-prompt-toggle input')].at(-1)!;
    prompt.checked = true;
    prompt.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledWith({ usePromptForImageLanguage: true });
  });

  it('shows recorded diagnostics only while the disclosure is open and clears them', () => {
    const { window, panel } = setup();
    panel.initialize();
    const root = panel.root!;
    const details = root.querySelector<HTMLDetailsElement>('details.image-diagnostics')!;
    const output = root.querySelector('output.image-diagnostics-output')!;
    // Closed disclosure: the log is not rendered until it opens.
    expect(output.textContent).toBe('');
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
    expect(output.textContent).toContain('No OCR activity');

    details.open = false;
    panel.recordDiagnostic('image-discovered');
    expect(output.textContent).toContain('No OCR activity');
    details.open = true;
    details.dispatchEvent(new window.Event('toggle'));
    expect(output.textContent).toContain('image discovered');

    root.querySelector<HTMLButtonElement>('.image-diagnostics-clear')!
      .dispatchEvent(new window.Event('click'));
    expect(output.textContent).toContain('No OCR activity');
    expect(panel.diagnostics.entries).toHaveLength(0);
  });

  it('renders nothing without a compiled image-analysis capability', () => {
    const { document } = parseHTML('<html><body><div id="host"></div></body></html>');
    const panel = new ImageAnalysisPanel({
      document: document as unknown as Document,
      host: document.getElementById('host') as unknown as HTMLElement,
      capabilities: { promptImageLanguage: false, promptImageText: false },
      compiledProviderOrder: () => [],
      hasCompiledCapability: () => false,
      readView: () => {
        throw new Error('should not read the view');
      },
      setUiText: () => undefined,
      changeImageTranslationEnabled: async () => undefined,
      commitPatch: async () => undefined,
    });
    panel.initialize();
    expect(panel.root).toBeUndefined();
    expect(document.getElementById('host')?.childElementCount).toBe(0);
    panel.recordDiagnostic('image-discovered');
    expect(panel.diagnostics.entries).toHaveLength(1);
  });

  it('names methods and scan policies', () => {
    expect(imageReadingMethodName('accessibility-text')).toBe('Accessibility text (aria-label / alt)');
    expect(imageReadingMethodName('tesseract')).toBe('Tesseract.js (local)');
    expect(imageScanPolicyName('visible-only')).toBe('Only when visible');
    expect(imageScanPolicyName('eager-all')).toBe('Everything immediately');
    expect(imageScanPolicyName('visible-first-background-prescan')).toBe('Visible first, then background');
  });
});
