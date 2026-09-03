import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  ImageAnalysisPanel,
  type ImageAnalysisPanelView,
} from '../entrypoints/sidepanel/image-analysis-panel';
import type { ImageTextProviderId } from '../lib/ocr/known-provider-ids';

function setup(initial: Partial<ImageAnalysisPanelView> = {}) {
  const { document, window } = parseHTML('<html><body><div id="host"></div></body></html>');
  let view: ImageAnalysisPanelView = {
    imageTranslationEnabled: false,
    imageCaptureAccess: 'granted',
    permissionInFlight: false,
    imageTextProviderOrder: ['chrome-text-detector', 'tesseract'],
    imageScanPolicy: 'visible-only',
    skipSmallImages: true,
    usePromptForImageLanguage: false,
    usePromptForImageText: false,
    ...initial,
  };
  const commitPatch = vi.fn(async () => undefined);
  const changeImageTranslationEnabled = vi.fn(async () => undefined);
  const panel = new ImageAnalysisPanel({
    document: document as unknown as Document,
    host: document.getElementById('host') as unknown as HTMLElement,
    capabilities: { promptImageLanguage: false, promptImageText: false },
    compiledProviderOrder: (order) =>
      order.filter((id): id is ImageTextProviderId =>
        id === 'chrome-text-detector' || id === 'tesseract',
      ),
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
    expect(root.querySelectorAll('.ocr-provider-order li')).toHaveLength(2);
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
    expect(root.querySelector('.microcopy')?.textContent).toContain('paused');
  });

  it('requests access from the grant button and saves reordered providers', () => {
    const { window, panel, commitPatch, changeImageTranslationEnabled, setView } = setup({
      imageTranslationEnabled: true,
      imageCaptureAccess: 'missing',
    });
    panel.initialize();
    const root = panel.root!;
    root.querySelector<HTMLButtonElement>('.image-access-grant')!
      .dispatchEvent(new window.Event('click'));
    expect(changeImageTranslationEnabled).toHaveBeenCalledWith(true);

    setView({ imageTextProviderOrder: ['chrome-text-detector', 'tesseract', 'transformers'] });
    panel.render();
    const buttons = root.querySelectorAll<HTMLButtonElement>('.ocr-order-buttons button');
    expect(buttons[0]?.disabled).toBe(true);
    buttons[1]!.dispatchEvent(new window.Event('click'));
    expect(commitPatch).toHaveBeenCalledWith({
      imageTextProviderOrder: ['tesseract', 'chrome-text-detector', 'transformers'],
    });
  });

  it('saves scan policy and small-image changes from their controls', () => {
    const { window, panel, commitPatch } = setup();
    panel.initialize();
    const root = panel.root!;
    const policy = root.querySelector<HTMLSelectElement>('select')!;
    Object.defineProperty(policy, 'value', { configurable: true, value: 'eager-all' });
    policy.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledWith({ imageScanPolicy: 'eager-all' });

    const small = root.querySelector<HTMLInputElement>('.settings-grid .check-label input')!;
    small.checked = false;
    small.dispatchEvent(new window.Event('change'));
    expect(commitPatch).toHaveBeenCalledWith({ skipSmallImages: false });
  });

  it('shows recorded diagnostics and clears them', () => {
    const { window, panel } = setup();
    panel.initialize();
    const root = panel.root!;
    const output = root.querySelector('output')!;
    expect(output.textContent).toContain('No OCR activity');

    panel.recordDiagnostic('image-discovered');
    expect(output.textContent).toContain('image discovered');

    root.querySelector<HTMLButtonElement>('.image-diagnostics-clear')!
      .dispatchEvent(new window.Event('click'));
    expect(output.textContent).toContain('No OCR activity');
  });

  it('renders nothing without a compiled OCR provider', () => {
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
  });
});
