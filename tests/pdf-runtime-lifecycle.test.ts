import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  openPdfDocument,
  type PdfDocumentHandle,
  type PdfjsEnvironment,
} from '../lib/pdf/pdfjs-runtime';

/**
 * The packaged pdf.js is replaced by a small fake here (it loads through
 * `importModule`, which tests inject): these tests are about what Simul asks
 * of pdf.js, not about drawing.
 */

interface FakePage {
  getViewport(options: { scale: number }): { width: number; height: number; transform: number[] };
  readonly getTextContent: ReturnType<typeof vi.fn>;
  readonly render: ReturnType<typeof vi.fn>;
  readonly cleanup: ReturnType<typeof vi.fn>;
  readonly commonObjs: { has(id: string): boolean; get(id: string): unknown };
  readonly view: readonly number[];
}

function fakePage(unit = 100): FakePage {
  return {
    getViewport: ({ scale }) => ({
      width: unit * scale,
      height: unit * scale,
      transform: [1, 0, 0, 1, 0, 0],
    }),
    getTextContent: vi.fn(async () => ({ items: [], styles: {}, lang: null })),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    cleanup: vi.fn<() => unknown>(() => true),
    commonObjs: { has: () => false, get: () => null },
    view: [0, 0, unit, unit],
  };
}

function fakeDocument(page: FakePage, getPage?: () => Promise<FakePage>) {
  return {
    numPages: 1,
    getPage: vi.fn(getPage ?? (async () => page)),
    cleanup: vi.fn(async () => undefined),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const opened: PdfDocumentHandle[] = [];
let locations = 0;

async function open(document: unknown): Promise<PdfDocumentHandle> {
  locations += 1;
  const base = `fake://pdfjs-${locations}/`;
  const module = {
    GlobalWorkerOptions: { workerSrc: '' },
    VerbosityLevel: { ERRORS: 0 },
    OPS: {},
    getDocument: () => ({
      promise: Promise.resolve(document),
      destroy: async () => undefined,
    }),
  };
  const environment: PdfjsEnvironment = {
    moduleBase: base,
    dataBase: base,
    workerFetch: false,
    importModule: async (url) => (url.endsWith('simul-shim.mjs') ? {} : module),
  };
  const handle = await openPdfDocument(new Uint8Array([0x25]), environment);
  opened.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((handle) => handle.destroy()));
});

describe('pdf.js document cleanup (P2)', () => {
  it('lets a page go once its text has been read', async () => {
    const page = fakePage();
    const handle = await open(fakeDocument(page));

    await expect(handle.getTextContent(1)).resolves.toEqual({
      items: [],
      styles: {},
      lang: null,
    });
    // The text is out; the page's parsed state is not kept for a page that
    // may only ever be read.
    expect(page.cleanup).toHaveBeenCalledTimes(1);
  });

  it('sweeps the document, and copes with a page that is being drawn', async () => {
    const document = fakeDocument(fakePage());
    const handle = await open(document);

    await expect(handle.cleanup()).resolves.toBeUndefined();
    expect(document.cleanup).toHaveBeenCalledTimes(1);

    // pdf.js throws when a page is rendering: the sweep is best effort.
    document.cleanup.mockRejectedValueOnce(new Error('startCleanup: Page 1 is currently rendering.'));
    await expect(handle.cleanup()).resolves.toBeUndefined();
    expect(document.cleanup).toHaveBeenCalledTimes(2);
  });

  it('does not fail a text read when a page\'s cleanup throws or rejects', async () => {
    const rejecting = fakePage();
    rejecting.cleanup.mockImplementationOnce(async () => {
      throw new Error('cleanup failed');
    });
    const rejected = await open(fakeDocument(rejecting));
    await expect(rejected.getTextContent(1)).resolves.toMatchObject({ items: [] });

    const throwing = fakePage();
    throwing.cleanup.mockImplementationOnce(() => {
      throw new Error('cleanup failed');
    });
    const threw = await open(fakeDocument(throwing));
    await expect(threw.getTextContent(1)).resolves.toMatchObject({ items: [] });
  });
});

describe('pdf.js renders on one canvas (P7)', () => {
  it('runs them one at a time, so a slower first render cannot overwrite the second', async () => {
    const slow = deferred<FakePage>();
    const fast = deferred<FakePage>();
    const page = fakePage();
    let calls = 0;
    const document = fakeDocument(page, () => {
      calls += 1;
      return calls === 1 ? slow.promise : fast.promise;
    });
    const handle = await open(document);
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;

    // Both start at once; the first page arrives last (a busy worker, a big
    // page). Serialized, the second cannot draw until the first has let go.
    const first = handle.render(1, canvas, 1);
    const second = handle.render(1, canvas, 2);
    fast.resolve(page);
    await Promise.resolve();
    slow.resolve(page);
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);

    // The render begun last is the one the canvas holds.
    expect(canvas.width).toBe(200);
    expect(page.render).toHaveBeenCalledTimes(2);
  });

  it('passes a replaced render\'s cancellation on as pdf.js reports it', async () => {
    const page = fakePage();
    const ready = deferred<FakePage>();
    const handle = await open(fakeDocument(page, () => ready.promise));
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    let rejectFirst!: (reason: unknown) => void;
    page.render.mockImplementationOnce(() => ({
      promise: new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      }),
      cancel: vi.fn(() => {
        rejectFirst(Object.assign(new Error('Render cancelled.'), {
          name: 'RenderingCancelledException',
        }));
      }),
    }));

    const first = handle.render(1, canvas, 1);
    ready.resolve(page);
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    // The replacement cancels the render in progress and waits for its canvas.
    const second = handle.render(1, canvas, 2);

    await expect(first).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    await expect(second).resolves.toBe(2);
  });

  it('replaces the middle of three renders started together on one canvas', async () => {
    const page = fakePage();
    const arrivals = [deferred<FakePage>(), deferred<FakePage>(), deferred<FakePage>()];
    let calls = 0;
    const document = fakeDocument(page, () => arrivals[calls++]!.promise);
    const handle = await open(document);
    const canvas = { width: 0, height: 0 } as unknown as HTMLCanvasElement;
    let active = 0;
    let maxActive = 0;
    page.render.mockImplementation(() => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      let settle!: () => void;
      let fail!: (reason: unknown) => void;
      const promise = new Promise<void>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const done = () => {
        active -= 1;
      };
      void promise.then(done, done);
      // A draw that is not replaced finishes; a replaced one is cancelled
      // before this runs.
      queueMicrotask(() => settle());
      return {
        promise,
        cancel: vi.fn(() => {
          fail(Object.assign(new Error('Render cancelled.'), {
            name: 'RenderingCancelledException',
          }));
        }),
      };
    });

    const first = handle.render(1, canvas, 1);
    const second = handle.render(1, canvas, 2);
    const third = handle.render(1, canvas, 3);
    // The replaced ones reject while the arrivals drain, before the
    // assertions below look at them.
    void first.catch(() => undefined);
    void second.catch(() => undefined);
    // The second and third both wait on the first and wake together: the
    // third must replace the second, not draw beside it.
    arrivals[0]!.resolve(page);
    await vi.waitFor(() => expect(page.render).toHaveBeenCalledTimes(1));
    arrivals[1]!.resolve(page);
    arrivals[2]!.resolve(page);

    await expect(first).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    await expect(second).rejects.toMatchObject({ name: 'RenderingCancelledException' });
    await expect(third).resolves.toBe(3);
    expect(maxActive).toBe(1);
    expect(canvas.width).toBe(300);
  });
});