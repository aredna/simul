import type * as Pdfjs from 'pdfjs-dist';

import {
  REGULAR_FONT_FACE,
  fontFaceFromName,
  type PdfFontFace,
} from './pdf-overlay-style';
import { pdfImageCoverage, type PdfPaintOperator } from './pdf-scanned-page';

/**
 * The packaged pdf.js (`vendor/pdfjs/`, shipped as `pdfjs/`) behind a narrow
 * interface. pdf.js loads by URL at run time, after Simul's shim, so it never
 * enters Simul's own bundles.
 */
export const PDFJS_ASSET_DIRECTORY = '/pdfjs/';

type PdfjsModule = typeof Pdfjs;

export interface PdfjsEnvironment {
  /** URL of the packaged pdfjs folder, ending in `/`; modules and the worker load from here. */
  readonly moduleBase: string;
  /** Where pdf.js reads CMaps, fonts, Wasm and the ICC profile, ending in `/`. */
  readonly dataBase: string;
  /** Whether the pdf.js worker fetches those data files itself. */
  readonly workerFetch: boolean;
  /** Loads a module by URL; tests replace it. */
  readonly importModule?: (url: string) => Promise<unknown>;
}

/** Extension pages: everything loads from the extension's own `pdfjs/`. */
export function chromePdfjsEnvironment(
  getUrl: (path: string) => string,
): PdfjsEnvironment {
  const base = getUrl(PDFJS_ASSET_DIRECTORY);
  return { moduleBase: base, dataBase: base, workerFetch: true };
}

/**
 * `runtime` means the packaged pdf.js itself failed to start, not the file:
 * a packaging or loading fault the reader cannot fix.
 */
export type PdfjsOpenErrorKind = 'password' | 'unreadable' | 'aborted' | 'runtime';

/** The largest canvas `render` draws; a larger request is drawn smaller. */
export const MAX_RENDER_PIXELS = 16 * 1024 * 1024;
const MAX_RENDER_SIDE = 16_384;

export class PdfjsOpenError extends Error {
  constructor(
    public readonly kind: PdfjsOpenErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PdfjsOpenError';
  }
}

/** Page size in PDF points at scale 1, rotation applied. */
export interface PdfPageSize {
  readonly width: number;
  readonly height: number;
  /** Maps PDF user space to page pixels at scale 1 (pdf.js viewport transform). */
  readonly transform: readonly number[];
}

/** One text run as pdf.js reports it, with pdf.js's field names. */
export interface PdfTextItem {
  readonly str: string;
  readonly dir: string;
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly fontName: string;
  readonly hasEOL: boolean;
}

export interface PdfTextStyle {
  readonly fontFamily: string;
  readonly ascent: number;
  readonly descent: number;
  readonly vertical: boolean;
}

export interface PdfTextContent {
  readonly items: readonly PdfTextItem[];
  readonly styles: Readonly<Record<string, PdfTextStyle>>;
  readonly lang: string | null;
}

export interface PdfDocumentHandle {
  readonly pageCount: number;
  getPageSize(pageNumber: number): Promise<PdfPageSize>;
  getTextContent(pageNumber: number): Promise<PdfTextContent>;
  /** Whether the page paints any image (a scanned page, a photo, a figure). */
  hasImages(pageNumber: number): Promise<boolean>;
  /**
   * The share of the page (0 to 1) its images cover, by their boxes. pdf.js
   * decodes the page's images for it; `releasePage` frees them.
   */
  imageCoverage(pageNumber: number): Promise<number>;
  /**
   * Draws the page into `canvas` at `scale` and resizes the canvas to fit,
   * or at a smaller scale if the canvas would exceed `MAX_RENDER_PIXELS`.
   * Resolves with the scale drawn. A new render on the same canvas cancels
   * the one in progress.
   */
  render(
    pageNumber: number,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    scale: number,
    signal?: AbortSignal,
  ): Promise<number>;
  /**
   * Weight and slant of fonts by their pdf.js id (a text item's `fontName`).
   * pdf.js knows a font's real name only once a page using it has been drawn;
   * a font it does not know yet reads as regular.
   */
  fontFaces(
    pageNumber: number,
    fontIds: readonly string[],
  ): Promise<Readonly<Record<string, PdfFontFace>>>;
  /**
   * Lets pdf.js drop what it keeps for a drawn page (its parsed drawing
   * commands, images and fonts). A render still in progress finishes first;
   * pdf.js frees the page when it ends.
   */
  releasePage(pageNumber: number): Promise<void>;
  /** Ends the document and its worker. Safe to call more than once. */
  destroy(): Promise<void>;
}

// Keyed by module URL: one pdf.js module, and one worker URL, per location.
const loadedModules = new Map<string, Promise<PdfjsModule>>();

function loadPdfjs(environment: PdfjsEnvironment): Promise<PdfjsModule> {
  let loaded = loadedModules.get(environment.moduleBase);
  if (!loaded) {
    const importModule =
      environment.importModule ??
      ((url: string) => import(/* @vite-ignore */ url));
    loaded = (async () => {
      // The shim defines the built-ins pdf.js calls and Chrome 138 lacks; it
      // must run before pdf.js evaluates.
      await importModule(`${environment.moduleBase}simul-shim.mjs`);
      const pdfjs = (await importModule(
        `${environment.moduleBase}pdf.min.mjs`,
      )) as PdfjsModule;
      pdfjs.GlobalWorkerOptions.workerSrc =
        `${environment.moduleBase}simul-worker.mjs`;
      return pdfjs;
    })();
    // A failed load is not kept here, so the next open tries again.
    loaded.catch(() => loadedModules.delete(environment.moduleBase));
    loadedModules.set(environment.moduleBase, loaded);
  }
  return loaded;
}

/**
 * Opens a PDF from its bytes. pdf.js hands `data`'s buffer to its worker, so
 * the caller must not use it afterwards.
 */
export async function openPdfDocument(
  data: Uint8Array,
  environment: PdfjsEnvironment,
  signal?: AbortSignal,
): Promise<PdfDocumentHandle> {
  if (signal?.aborted) throw abortedError();
  let pdfjs: PdfjsModule;
  let task: Pdfjs.PDFDocumentLoadingTask;
  try {
    pdfjs = await loadPdfjs(environment);
    if (signal?.aborted) throw abortedError();
    const { dataBase } = environment;
    task = pdfjs.getDocument({
      data,
      cMapUrl: `${dataBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${dataBase}standard_fonts/`,
      wasmUrl: `${dataBase}wasm/`,
      iccUrl: `${dataBase}iccs/`,
      useWorkerFetch: environment.workerFetch,
      enableXfa: false,
      verbosity: pdfjs.VerbosityLevel.ERRORS,
    });
  } catch (error) {
    if (error instanceof PdfjsOpenError) throw error;
    throw runtimeError(error);
  }
  const destroyTask = () => task.destroy().catch(() => {});
  let document: Pdfjs.PDFDocumentProxy;
  try {
    // pdf.js does not always settle the loading promise when the task is
    // destroyed mid-parse, so an abort rejects here without waiting for it.
    document = await new Promise<Pdfjs.PDFDocumentProxy>((resolve, reject) => {
      const cancel = () => {
        void destroyTask();
        reject(abortedError(signal?.reason));
      };
      signal?.addEventListener('abort', cancel, { once: true });
      task.promise
        .then(resolve, reject)
        .finally(() => signal?.removeEventListener('abort', cancel));
    });
  } catch (error) {
    if (error instanceof PdfjsOpenError) throw error;
    await destroyTask();
    const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
    if (name === 'PasswordException') {
      throw new PdfjsOpenError('password', 'The PDF needs a password.', { cause: error });
    }
    // pdf.js's own words when neither its worker nor the in-page fallback starts.
    if (typeof message === 'string' && message.startsWith('Setting up fake worker failed')) {
      throw runtimeError(error);
    }
    throw new PdfjsOpenError('unreadable', 'The file is not a readable PDF.', {
      cause: error,
    });
  }
  if (signal?.aborted) {
    // Aborted just as the document arrived.
    await destroyTask();
    throw abortedError(signal.reason);
  }
  return createDocumentHandle(pdfjs, document, destroyTask);
}

function createDocumentHandle(
  pdfjs: PdfjsModule,
  document: Pdfjs.PDFDocumentProxy,
  destroy: () => Promise<void>,
): PdfDocumentHandle {
  // Operators that paint a raster or stencil image. Left out: the one-pixel
  // masks producers use for rules, and the inline-image bracket markers.
  const imageOperators = new Set(
    [
      'paintImageXObject',
      'paintImageXObjectRepeat',
      'paintInlineImageXObject',
      'paintInlineImageXObjectGroup',
      'paintImageMaskXObject',
      'paintImageMaskXObjectGroup',
      'paintImageMaskXObjectRepeat',
    ].map((name) => pdfjs.OPS[name as keyof typeof pdfjs.OPS]),
  );
  // Where images land on the page: the operators that move or paint them.
  const paintOperators = new Map<number, PdfPaintOperator>();
  const paints = (kind: PdfPaintOperator, ...names: string[]) => {
    for (const name of names) {
      const code: unknown = pdfjs.OPS[name as keyof typeof pdfjs.OPS];
      if (typeof code === 'number') paintOperators.set(code, kind);
    }
  };
  paints('save', 'save', 'beginGroup');
  paints('restore', 'restore', 'endGroup', 'paintFormXObjectEnd', 'endAnnotation');
  paints('transform', 'transform');
  paints('form-begin', 'paintFormXObjectBegin');
  paints('annotation-begin', 'beginAnnotation');
  paints('image', 'paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject');
  paints('image-repeat', 'paintImageXObjectRepeat');
  paints('mask-repeat', 'paintImageMaskXObjectRepeat');
  paints('image-group', 'paintImageMaskXObjectGroup');
  paints('inline-group', 'paintInlineImageXObjectGroup');
  const rendering = new WeakMap<object, Pdfjs.RenderTask>();
  return {
    pageCount: document.numPages,
    async getPageSize(pageNumber) {
      const viewport = (await document.getPage(pageNumber)).getViewport({ scale: 1 });
      return {
        width: viewport.width,
        height: viewport.height,
        transform: [...viewport.transform],
      };
    },
    async getTextContent(pageNumber) {
      const content = await (await document.getPage(pageNumber)).getTextContent();
      type ContentItem = (typeof content.items)[number];
      return {
        items: content.items.filter(
          (item): item is Extract<ContentItem, { str: string }> => 'str' in item,
        ),
        styles: content.styles,
        lang: content.lang,
      };
    },
    async hasImages(pageNumber) {
      const operators = await (await document.getPage(pageNumber)).getOperatorList();
      return operators.fnArray.some((code) => imageOperators.has(code));
    },
    async imageCoverage(pageNumber) {
      const page = await document.getPage(pageNumber);
      return pdfImageCoverage(await page.getOperatorList(), paintOperators, page.view);
    },
    async render(pageNumber, canvas, scale, signal) {
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new RangeError(`Render scale must be a positive number, not ${scale}.`);
      }
      signal?.throwIfAborted();
      const page = await document.getPage(pageNumber);
      signal?.throwIfAborted();
      const unit = page.getViewport({ scale: 1 });
      const drawnScale = Math.min(
        scale,
        MAX_RENDER_SIDE / unit.width,
        MAX_RENDER_SIDE / unit.height,
        Math.sqrt(MAX_RENDER_PIXELS / (unit.width * unit.height)),
      );
      const viewport = page.getViewport({ scale: drawnScale });
      // pdf.js refuses a canvas it is still drawing on, and resizing clears
      // it, so the earlier render ends before this one touches the canvas.
      const previous = rendering.get(canvas);
      if (previous) {
        previous.cancel();
        await previous.promise.catch(() => {});
        signal?.throwIfAborted();
      }
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const renderTask = page.render({
        // pdf.js only calls getContext('2d'), which an OffscreenCanvas also
        // has; its type names only the element.
        canvas: canvas as HTMLCanvasElement,
        viewport,
      });
      rendering.set(canvas, renderTask);
      const cancel = () => renderTask.cancel();
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        await renderTask.promise;
        return drawnScale;
      } catch (error) {
        signal?.throwIfAborted();
        throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (rendering.get(canvas) === renderTask) rendering.delete(canvas);
      }
    },
    async fontFaces(pageNumber, fontIds) {
      const { commonObjs } = await document.getPage(pageNumber);
      const faces: Record<string, PdfFontFace> = {};
      for (const id of new Set(fontIds)) {
        let face = REGULAR_FONT_FACE;
        try {
          if (commonObjs.has(id)) {
            face = fontFaceFromName((commonObjs.get(id) as { name?: unknown } | null)?.name);
          }
        } catch {
          // Not loaded after all: regular.
        }
        faces[id] = face;
      }
      return faces;
    },
    async releasePage(pageNumber) {
      // The boolean only says whether it freed at once or after a render.
      (await document.getPage(pageNumber)).cleanup();
    },
    destroy,
  };
}

function runtimeError(cause: unknown): PdfjsOpenError {
  return new PdfjsOpenError('runtime', 'The packaged pdf.js could not start.', { cause });
}

function abortedError(cause?: unknown): PdfjsOpenError {
  return new PdfjsOpenError('aborted', 'Opening the PDF was cancelled.', { cause });
}
