import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { UI_STRINGS } from '../lib/companion-ui-strings';
import type { ImageTranslationConfiguration } from '../lib/ocr/image-translation-controller';
import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import type { PdfViewerDoubt } from '../lib/pdf/pdf-viewer-tracker';
import type { PdfLayoutSettings } from '../lib/pdf/pdf-layout';
import {
  LazyImageTranslationController,
  type ImageTranslationControllerLike,
} from '../entrypoints/sidepanel/lazy-image-translation-controller';
import {
  LazyPdfController,
  type PdfControllerLike,
} from '../entrypoints/sidepanel/lazy-pdf-controller';
import type {
  PdfScannedPagesState,
  PdfScannedReadingOutcome,
} from '../entrypoints/sidepanel/pdf-controller';
import type { LocalPdfFile } from '../lib/pdf/pdf-file';
import type { SupportedLanguage } from '../lib/translation-provider';
import type { UiText } from '../lib/ui-text';
import type { PdfViewerTarget } from '../entrypoints/sidepanel/pdf-viewer-follower';

const main = readFileSync(
  new URL('../entrypoints/sidepanel/main.ts', import.meta.url),
  'utf8',
);

const captureRequest = {} as ReplicaCaptureRequest;
const documentIdentity = {} as ReplicaSourceDocumentIdentity;
const viewerTarget: PdfViewerTarget = { tabId: 3, documentId: 'doc' };
const viewerDoubt = {} as PdfViewerDoubt;
const signal = new AbortController().signal;
const layout: PdfLayoutSettings = {
  displayMode: 'fit',
  zoomPercent: 125,
  sourceZoomFactor: 1,
};

class FakeImageController implements ImageTranslationControllerLike {
  readonly calls: string[] = [];
  busy = false;

  configure(configuration: ImageTranslationConfiguration): void {
    this.calls.push(`configure:${configuration.enabled}`);
  }

  activateReplica(
    _request: ReplicaCaptureRequest,
    sourceWindowId: number,
    replayLease: number,
  ): boolean {
    this.calls.push(`activate:${sourceWindowId}:${replayLease}`);
    return true;
  }

  notifyReplicaCommit(
    _document: ReplicaSourceDocumentIdentity,
    replayLease: number,
  ): boolean {
    this.calls.push(`notify:${replayLease}`);
    return true;
  }

  resume(): void { this.calls.push('resume'); }
  refreshOverlays(): void { this.calls.push('refresh'); }
  cancelCurrent(): boolean { this.calls.push('cancel'); return false; }
  releaseReplica(): void { this.calls.push('release'); }
  setTopPageOrigin(pageUrl: string | undefined): void {
    this.calls.push(`origin:${pageUrl ?? 'undefined'}`);
  }
  purgeSourceDerivedCache(): void { this.calls.push('purge'); }
  dispose(): void { this.calls.push('dispose'); }
}

class FakePdfController implements PdfControllerLike {
  readonly calls: string[] = [];
  shown = false;
  textOnScannedPagesOnly = false;
  textDocument: ReplicaSourceDocumentIdentity | undefined;

  show(
    source: string | LocalPdfFile,
    _signal: AbortSignal,
    _sourceDocument?: ReplicaSourceDocumentIdentity,
    _viewer?: PdfViewerTarget,
  ): Promise<{ readonly pageCount: number }> {
    this.calls.push(`show:${typeof source === 'string' ? source : source.key}`);
    this.shown = true;
    return Promise.resolve({ pageCount: 4 });
  }

  readText(_signal: AbortSignal): Promise<{ readonly hasText: boolean }> {
    this.calls.push('readText');
    return Promise.resolve({ hasText: true });
  }

  readScannedPages(
    _language: SupportedLanguage,
    _signal: AbortSignal,
  ): Promise<PdfScannedReadingOutcome> {
    this.calls.push('readScanned');
    return Promise.resolve({ kind: 'complete' });
  }

  probeLanguage(_signal: AbortSignal): Promise<SupportedLanguage | undefined> {
    this.calls.push('probe');
    return Promise.resolve(undefined);
  }

  stopScannedReading(): void { this.calls.push('stopScanned'); }
  setLanguageHint(language: SupportedLanguage | undefined): void {
    // The real controller only sets the hint on a shown surface; before a
    // document is shown this is a no-op, not a pending setting.
    this.calls.push(this.shown
      ? `hint:${language ?? 'undefined'}`
      : `hint-noop:${language ?? 'undefined'}`);
  }
  scannedPagesState(_language: SupportedLanguage | undefined): PdfScannedPagesState {
    return 'none';
  }
  scannedPagesNote(): UiText | undefined { return undefined; }
  noTextStatus(_language: SupportedLanguage | undefined): UiText {
    return UI_STRINGS.statusPdfNoText;
  }
  locatePage(): undefined { return undefined; }
  close(): void { this.calls.push('close'); this.shown = false; }
  updateLayout(settings: PdfLayoutSettings): void {
    this.calls.push(`layout:${settings.displayMode}:${settings.zoomPercent}`);
  }
  handleReadingPage(index: number): void { this.calls.push(`page:${index}`); }
}

function imageConfiguration(enabled: boolean): ImageTranslationConfiguration {
  return {
    enabled,
    scanPolicy: 'visible-first-background-prescan',
    skipSmallImages: true,
    providerOrder: [],
    methodOrder: [],
    disabledMethodIds: [],
    policyFingerprint: 'test',
    controlImages: true,
    ocrMinimumConfidence: 0.65,
    sourceLanguage: 'auto',
    pageLanguageResolutionPending: false,
    targetLanguage: 'en',
    translationIdle: true,
    resetEpoch: 0,
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('side-panel lazy stacks (O8)', () => {
  it('boots the panel with lazy facades instead of eager controllers', () => {
    expect(main).toContain('new LazyImageTranslationController({');
    expect(main).toContain('new LazyPdfController({');
    // The real constructors exist only inside the dynamic-import loaders.
    expect(main).toContain('return new ImageTranslationController(');
    expect(main).toContain('return new PdfController(');
    expect(main).not.toContain('import { ImageTranslationController }');
    expect(main).toContain('../../lib/ocr/image-translation-controller');
    expect(main).toContain("'./pdf-controller'");
  });

  it('boots without constructing the OCR stack', () => {
    const load = vi.fn();
    const lazy = new LazyImageTranslationController({ load });

    lazy.configure(imageConfiguration(true));
    lazy.setTopPageOrigin('https://a.example/page');
    lazy.releaseReplica();
    lazy.resume();
    lazy.refreshOverlays();

    expect(lazy.cancelCurrent()).toBe(false);
    expect(lazy.busy).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('loads once on the first enabled image use and replays the state', async () => {
    const controller = new FakeImageController();
    const load = vi.fn(async () => controller);
    const lazy = new LazyImageTranslationController({ load });

    lazy.configure(imageConfiguration(true));
    lazy.setTopPageOrigin('https://a.example/page');
    lazy.activateReplica(captureRequest, 7, 3);
    lazy.notifyReplicaCommit(documentIdentity, 3);
    lazy.resume();
    lazy.refreshOverlays();

    expect(load).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(controller.calls).toContain('activate:7:3'));
    expect(controller.calls).toEqual([
      'configure:true',
      'origin:https://a.example/page',
      'activate:7:3',
      'notify:3',
      'resume',
      'refresh',
    ]);

    lazy.configure(imageConfiguration(false));
    expect(controller.calls.at(-1)).toBe('configure:false');
    lazy.activateReplica(captureRequest, 8, 4);
    expect(controller.calls.at(-1)).toBe('activate:8:4');
    expect(load).toHaveBeenCalledOnce();
  });

  it('keeps a disabled image activation queued until images are enabled', async () => {
    const controller = new FakeImageController();
    const load = vi.fn(async () => controller);
    const lazy = new LazyImageTranslationController({ load });

    lazy.configure(imageConfiguration(false));
    lazy.activateReplica(captureRequest, 5, 2);
    expect(load).not.toHaveBeenCalled();

    lazy.configure(imageConfiguration(true));
    expect(load).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(controller.calls).toContain('activate:5:2'));
    expect(controller.calls).toEqual(['configure:true', 'activate:5:2']);
  });

  it('does not load after disposal, and disposes a controller that arrives late', async () => {
    const load = vi.fn();
    const disposed = new LazyImageTranslationController({ load });
    expect(() => disposed.dispose()).not.toThrow();
    disposed.configure(imageConfiguration(true));
    expect(disposed.activateReplica(captureRequest, 1, 1)).toBe(false);
    expect(load).not.toHaveBeenCalled();

    const controller = new FakeImageController();
    const pending = deferred<ImageTranslationControllerLike>();
    const loading = new LazyImageTranslationController({
      load: () => pending.promise,
    });
    loading.configure(imageConfiguration(true));
    loading.activateReplica(captureRequest, 2, 2);
    loading.dispose();
    pending.resolve(controller);

    await vi.waitFor(() => expect(controller.calls).toContain('dispose'));
    expect(controller.calls).not.toContain('activate:2:2');
  });

  it('retries the OCR stack after a failed load and keeps the pending state', async () => {
    const controller = new FakeImageController();
    const onLoadError = vi.fn();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(controller);
    const lazy = new LazyImageTranslationController({ load, onLoadError });

    lazy.configure(imageConfiguration(true));
    lazy.setTopPageOrigin('https://a.example/page');
    lazy.activateReplica(captureRequest, 11, 6);
    expect(load).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(onLoadError).toHaveBeenCalledOnce());
    expect(controller.calls).toEqual([]);

    // The pending configuration, origin and activation survived the failure.
    lazy.configure(imageConfiguration(true));
    expect(load).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(controller.calls).toContain('activate:11:6'));
    expect(controller.calls).toEqual([
      'configure:true',
      'origin:https://a.example/page',
      'activate:11:6',
    ]);
  });

  it('boots without constructing the PDF stack', () => {
    const load = vi.fn();
    const lazy = new LazyPdfController({ load });

    lazy.updateLayout(layout);
    lazy.setLanguageHint('ja');
    lazy.handleReadingPage(2);
    lazy.stopScannedReading();
    lazy.close();

    expect(lazy.shown).toBe(false);
    expect(lazy.scannedPagesState(undefined)).toBe('none');
    expect(lazy.scannedPagesNote()).toBeUndefined();
    expect(lazy.noTextStatus(undefined)).toBe(UI_STRINGS.statusPdfNoText);
    expect(lazy.textOnScannedPagesOnly).toBe(false);
    expect(lazy.textDocument).toBeUndefined();
    expect(lazy.locatePage(viewerTarget, viewerDoubt, signal)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads once on the first PDF show with pending layout and a pre-show hint no-op', async () => {
    const controller = new FakePdfController();
    const load = vi.fn(async () => controller);
    const lazy = new LazyPdfController({ load });

    lazy.updateLayout(layout);
    lazy.setLanguageHint('ja');

    await expect(lazy.show('https://a.example/doc.pdf', signal))
      .resolves.toEqual({ pageCount: 4 });
    expect(load).toHaveBeenCalledOnce();
    expect(controller.calls).toEqual([
      'layout:fit:125',
      'hint-noop:ja',
      'show:https://a.example/doc.pdf',
    ]);
    expect(lazy.shown).toBe(true);

    await lazy.show('/local.pdf', signal);
    expect(load).toHaveBeenCalledOnce();
    expect(controller.calls.at(-1)).toBe('show:/local.pdf');
  });

  it('does not load for reads that need a shown PDF', async () => {
    const load = vi.fn();
    const lazy = new LazyPdfController({ load });

    await expect(lazy.readText(signal)).rejects.toMatchObject({ name: 'AbortError' });
    await expect(lazy.readScannedPages('en', signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(lazy.probeLanguage(signal)).resolves.toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });

  it('surfaces a failed PDF stack load and retries on the next show', async () => {
    const controller = new FakePdfController();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValueOnce(controller);
    const lazy = new LazyPdfController({ load });

    await expect(lazy.show('https://a.example/doc.pdf', signal))
      .rejects.toThrow('chunk failed');
    expect(load).toHaveBeenCalledOnce();

    await expect(lazy.show('https://a.example/doc.pdf', signal))
      .resolves.toEqual({ pageCount: 4 });
    expect(load).toHaveBeenCalledTimes(2);
    expect(controller.calls).toEqual(['show:https://a.example/doc.pdf']);
  });

  it('shows again after a close', async () => {
    const controller = new FakePdfController();
    const load = vi.fn(async () => controller);
    const lazy = new LazyPdfController({ load });

    await expect(lazy.show('/a.pdf', signal)).resolves.toEqual({ pageCount: 4 });
    lazy.close();
    // The close-generation guard is for a close during a load; it must not
    // reject a show the reader starts after the close has finished.
    await expect(lazy.show('/b.pdf', signal)).resolves.toEqual({ pageCount: 4 });

    expect(load).toHaveBeenCalledOnce();
    expect(controller.calls).toEqual(['show:/a.pdf', 'close', 'show:/b.pdf']);
    expect(lazy.shown).toBe(true);
  });

  it('stops a queued PDF show when closed during load, even with a live signal', async () => {
    const controller = new FakePdfController();
    const pending = deferred<PdfControllerLike>();
    const lazy = new LazyPdfController({ load: () => pending.promise });

    const shown = lazy.show('https://a.example/doc.pdf', signal);
    expect(lazy.shown).toBe(false);
    lazy.close();
    pending.resolve(controller);

    // The close is applied to the arriving controller, and the queued show
    // rejects instead of mounting into it even though `signal` is live.
    await expect(shown).rejects.toMatchObject({ name: 'AbortError' });
    expect(controller.calls).toEqual(['close']);
  });
});