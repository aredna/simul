import { describe, expect, it, vi } from 'vitest';

import {
  PDF_VIEWER_MAX_HELLOS,
  PDF_VIEWER_REHELLO_AFTER_MS,
  installPdfViewerBridge,
  type PdfViewerBridgeEnvironment,
} from '../lib/pdf/pdf-viewer-bridge';
import {
  PDF_VIEWER_HELLO_TYPE,
  PDF_VIEWER_ORIGIN,
  createPdfViewerPortName,
  pdfViewerPageZoom,
  pdfViewerShowsToolbar,
} from '../lib/pdf/pdf-viewer-protocol';

type Listener = Parameters<NonNullable<PdfViewerBridgeEnvironment['window']>['addEventListener']>[1];

const REPORT = {
  type: 'viewport',
  pageX: 5,
  pageY: -297,
  pageWidth: 794,
  viewportWidth: 593,
  viewportHeight: 749,
};

function setup(options: {
  frame?: boolean;
  measureScrollbar?: () => number | undefined;
  devicePixelRatio?: () => number;
  innerHeight?: () => number;
  locationHash?: () => string;
} = {}) {
  const viewerWindow = { postMessage: vi.fn() };
  let frame = { contentWindow: viewerWindow };
  let clock = 4_321;
  const listeners = new Set<Listener>();
  let connect: ((port: never) => void) | undefined;
  const intervals: Array<{ callback: () => void; cleared: boolean }> = [];
  const environment: PdfViewerBridgeEnvironment = {
    global: {},
    runtime: { onConnect: { addListener: (listener) => { connect = listener as never; } } },
    document: { body: {} as HTMLElement },
    window: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    openShadowRoot: () => ({
      querySelector: (selector: string) =>
        options.frame === false || selector !== 'iframe[type="application/pdf"]' ? null : frame,
    }) as unknown as ShadowRoot,
    now: () => clock,
    measureScrollbar: options.measureScrollbar ?? (() => undefined),
    devicePixelRatio: options.devicePixelRatio ?? (() => Number.NaN),
    ...(options.innerHeight ? { innerHeight: options.innerHeight } : {}),
    ...(options.locationHash ? { locationHash: options.locationHash } : {}),
    setInterval: (callback) => {
      const handle = { callback, cleared: false };
      intervals.push(handle);
      return handle;
    },
    clearInterval: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  };
  installPdfViewerBridge(environment);
  const open = (name = createPdfViewerPortName('session-1')) => {
    const sent: unknown[] = [];
    const disconnect: Array<() => void> = [];
    connect!({
      name,
      postMessage: (message: unknown) => sent.push(message),
      onDisconnect: { addListener: (listener: () => void) => disconnect.push(listener) },
    } as never);
    return { sent, disconnect: () => disconnect.forEach((listener) => listener()) };
  };
  const deliver = (data: unknown, origin = PDF_VIEWER_ORIGIN, source: unknown = viewerWindow) => {
    for (const listener of [...listeners]) listener({ origin, source, data });
  };
  /** Chrome's viewer reloads its frame: the next look finds this one. */
  const replaceFrame = () => {
    const next = { postMessage: vi.fn() };
    frame = { contentWindow: next };
    return next;
  };
  return { environment, viewerWindow, replaceFrame, listeners, intervals, open, deliver,
    advanceClock: (ms: number) => { clock += ms; } };
}

describe('installPdfViewerBridge', () => {
  it('says hello to the viewer frame and passes its viewport reports on', () => {
    const { viewerWindow, open, deliver } = setup();
    const port = open();
    expect(viewerWindow.postMessage).toHaveBeenCalledWith(
      { type: PDF_VIEWER_HELLO_TYPE },
      PDF_VIEWER_ORIGIN,
    );
    deliver(REPORT);
    expect(port.sent).toEqual([{
      kind: 'viewport',
      pageX: 5,
      pageY: -297,
      pageWidth: 794,
      viewportWidth: 593,
      viewportHeight: 749,
      time: 4_321,
    }]);
  });

  it('ignores reports from another origin or frame, and other messages', () => {
    const { open, deliver } = setup();
    const port = open();
    deliver(REPORT, 'https://example.com');
    deliver(REPORT, PDF_VIEWER_ORIGIN, {});
    deliver({ ...REPORT, pageY: 'far' });
    deliver({ type: 'getSelectedTextReply', selectedText: 'secret' });
    deliver(null);
    expect(port.sent).toEqual([]);
  });

  it('ignores ports that are not its own and installs once', () => {
    const { environment, listeners, open } = setup();
    open('simul:html-mirror-v2:session');
    expect(listeners.size).toBe(0);
    installPdfViewerBridge(environment);
    open();
    expect(listeners.size).toBe(1);
  });

  it('repeats the hello until the viewer has loaded, at most sixty times', () => {
    const first = setup();
    first.open();
    const [timer] = first.intervals;
    timer!.callback();
    expect(first.viewerWindow.postMessage).toHaveBeenCalledTimes(2);
    first.deliver({ type: 'documentLoaded', load_state: 'success' });
    // Answered: the frame is only looked at now and then, with no hellos.
    const watch = first.intervals.at(-1)!;
    watch.callback();
    expect(watch.cleared).toBe(false);
    expect(first.viewerWindow.postMessage).toHaveBeenCalledTimes(2);

    const slow = setup({ frame: false });
    slow.open();
    for (let hello = 1; hello < PDF_VIEWER_MAX_HELLOS; hello += 1) {
      slow.intervals.at(-1)!.callback();
    }
    expect(slow.intervals).toHaveLength(PDF_VIEWER_MAX_HELLOS - 1);
    // Sixty hellos said: no further look is scheduled.
    slow.intervals.at(-1)!.callback();
    expect(slow.intervals).toHaveLength(PDF_VIEWER_MAX_HELLOS - 1);
  });

  it('sends a later panel one hello once the viewer has answered', () => {
    const { viewerWindow, intervals, open, deliver } = setup();
    const first = open();
    deliver(REPORT);
    expect(first.sent).toHaveLength(1);
    // Refresh, or the separate window: the viewer sends no second answer.
    const second = open(createPdfViewerPortName('session-2'));
    expect(viewerWindow.postMessage).toHaveBeenCalledTimes(2);
    // Each panel keeps a slow watch for a replaced viewer frame.
    expect(intervals).toHaveLength(2);
    deliver(REPORT);
    expect(first.sent).toHaveLength(2);
    expect(second.sent).toHaveLength(1);
  });

  it('finds a replaced viewer frame and says hello to it again (P3)', () => {
    const { open, deliver, replaceFrame, intervals } = setup();
    const port = open();
    deliver(REPORT);
    expect(port.sent).toHaveLength(1);
    const reloaded = replaceFrame();
    // Chrome reloaded the viewer into a new frame: the next look finds it.
    intervals.at(-1)!.callback();
    expect(reloaded.postMessage).toHaveBeenCalledWith(
      { type: PDF_VIEWER_HELLO_TYPE },
      PDF_VIEWER_ORIGIN,
    );
    deliver(REPORT, PDF_VIEWER_ORIGIN, reloaded);
    expect(port.sent).toHaveLength(2);
  });

  it('takes a report from the frame embedded now, and none from the one replaced (P3)', () => {
    const { open, deliver, replaceFrame, viewerWindow } = setup();
    const port = open();
    deliver(REPORT);
    const reloaded = replaceFrame();
    // No hello has reached the new frame yet; a report it sends is still its.
    deliver({ ...REPORT, pageY: -300 }, PDF_VIEWER_ORIGIN, reloaded);
    expect(port.sent).toHaveLength(2);
    expect(port.sent[1]).toMatchObject({ kind: 'viewport', pageY: -300 });
    // The window that is no longer embedded is not taken.
    deliver(REPORT, PDF_VIEWER_ORIGIN, viewerWindow);
    expect(port.sent).toHaveLength(2);
  });

  it('says hello again when an answered viewer has gone quiet in place (P3 repair)', () => {
    const { viewerWindow, open, deliver, intervals, advanceClock } = setup();
    const port = open();
    deliver(REPORT);
    expect(port.sent).toHaveLength(1);
    expect(viewerWindow.postMessage).toHaveBeenCalledTimes(1);

    // Chrome reloaded the viewer's document without replacing the frame: the
    // window is the one that answered, and it sends no reports now.
    advanceClock(PDF_VIEWER_REHELLO_AFTER_MS);
    intervals.at(-1)!.callback();
    expect(viewerWindow.postMessage).toHaveBeenCalledTimes(2);

    // The new document answers, and its reports are taken again.
    deliver(REPORT);
    expect(port.sent).toHaveLength(2);

    // Not again before another quiet window.
    intervals.at(-1)!.callback();
    expect(viewerWindow.postMessage).toHaveBeenCalledTimes(2);

    // Bounded by the hello budget: sixty hellos in all, then no more looks.
    for (let hello = 2; hello < PDF_VIEWER_MAX_HELLOS; hello += 1) {
      advanceClock(PDF_VIEWER_REHELLO_AFTER_MS);
      intervals.at(-1)!.callback();
    }
    expect(viewerWindow.postMessage).toHaveBeenCalledTimes(PDF_VIEWER_MAX_HELLOS);
    expect(intervals).toHaveLength(PDF_VIEWER_MAX_HELLOS);
  });

  it('sends how wide the tab draws a scrollbar with each report (D134)', () => {
    let ratio = 1;
    let width: number | undefined = 15;
    const measureScrollbar = vi.fn(() => width);
    const { open, deliver } = setup({ measureScrollbar, devicePixelRatio: () => ratio });
    const port = open();
    expect(measureScrollbar).not.toHaveBeenCalled();
    deliver(REPORT);
    deliver(REPORT);
    // Measured once for all reports and all panels.
    const second = open(createPdfViewerPortName('session-2'));
    deliver(REPORT);
    expect(measureScrollbar).toHaveBeenCalledTimes(1);
    expect(port.sent).toHaveLength(3);
    expect(second.sent).toHaveLength(1);
    for (const message of [...port.sent, ...second.sent]) {
      expect(message).toMatchObject({ kind: 'viewport', pageY: -297, scrollbar: 15, scale: 1 });
    }
    // The window went to a screen of another scale: measured again.
    ratio = 1.25;
    width = 15.2;
    deliver(REPORT);
    expect(measureScrollbar).toHaveBeenCalledTimes(2);
    expect(port.sent[3]).toMatchObject({ scrollbar: 15.2, scale: 1.25 });
  });

  it('sends the scrollbar and the scale in the viewer\'s pixels under a default zoom (D184)', () => {
    // Chrome for Testing 158 on a screen scaled by 1 (and 1.25 at 150%):
    // the tab's height, scrollbar and scale at each default zoom, and the
    // viewer's viewport, 757 px tall under its 56 px toolbar at every one.
    // The viewer leaves 15 px (19 screen px at 1.25), whatever the zoom.
    for (const [zoom, tab, measured, ratio, screen, scrollbar] of [
      [0.5, 1626, 30, 0.5, 1, 15],
      [0.8333, 979, 18.07, 0.8333, 1, 15],
      [1, 813, 15, 1, 1, 15],
      [1.2, 677, 12.5, 1.2, 1, 15],
      [1.5, 542, 10, 1.5, 1, 15],
      [1.5, 543, 10.13, 1.875, 1.25, 15.2],
    ] as const) {
      const { open, deliver } = setup({
        measureScrollbar: () => measured,
        devicePixelRatio: () => ratio,
        innerHeight: () => tab,
      });
      const port = open();
      deliver({ ...REPORT, viewportHeight: 757 });
      const sent = port.sent[0] as { scrollbar: number; scale: number };
      expect(Math.abs(sent.scrollbar - scrollbar), `${zoom}`).toBeLessThan(0.1);
      expect(sent.scale, `${zoom}`).toBeCloseTo(screen, 2);
    }
    // Not told, or nothing Chrome zooms to: none.
    for (const tab of [undefined, Number.NaN, 0, -5, Number.POSITIVE_INFINITY, 100, 9_000]) {
      expect(pdfViewerPageZoom(757, tab), `${tab}`).toBe(1);
    }
    expect(pdfViewerPageZoom(0, 813)).toBe(1);
    expect(pdfViewerPageZoom(757, 979)).toBeCloseTo(0.8304, 4);
    // A hidden toolbar at 100%: the viewport is the tab's height.
    const hidden = setup({ measureScrollbar: () => 15, devicePixelRatio: () => 1, innerHeight: () => 813 });
    const port = hidden.open();
    hidden.deliver({ ...REPORT, viewportHeight: 813 });
    expect(port.sent[0]).toMatchObject({ scrollbar: 15, scale: 1 });
  });

  it('takes the zoom from the whole viewport where the PDF\'s address hides the toolbar (D189)', () => {
    // Chrome for Testing 158 at a default zoom of 83%, `#toolbar=0`: the
    // viewport is the viewer's whole 813 px in a tab 979 px tall.
    for (const hash of ['#toolbar=0', '#zoom=150&toolbar=0', '#page=3&TOOLBAR=0&zoom=50']) {
      const { open, deliver } = setup({
        measureScrollbar: () => 18.07,
        devicePixelRatio: () => 0.83,
        innerHeight: () => 979,
        locationHash: () => hash,
      });
      const port = open();
      deliver({ ...REPORT, viewportHeight: 813 });
      const sent = port.sent[0] as { scrollbar: number; scale: number };
      expect(Math.abs(sent.scrollbar - 15), hash).toBeLessThan(0.1);
      expect(sent.scale, hash).toBeCloseTo(1, 2);
    }
    expect(pdfViewerShowsToolbar(undefined)).toBe(true);
    expect(pdfViewerShowsToolbar('')).toBe(true);
    expect(pdfViewerShowsToolbar('#toolbar=1')).toBe(true);
    expect(pdfViewerShowsToolbar('#toolbar=0')).toBe(false);
    expect(pdfViewerShowsToolbar('#notoolbar=0')).toBe(true);
    // Shown, the same tab and viewport would be 89%.
    expect(pdfViewerPageZoom(813, 979)).toBeCloseTo(0.888, 3);
    expect(pdfViewerPageZoom(813, 979, false)).toBeCloseTo(0.8304, 4);
  });

  it('sends the screen\'s scale, and the report without it when it is not known (D134)', () => {
    const known = setup({ measureScrollbar: () => 0, devicePixelRatio: () => 1.5 });
    const port = known.open();
    known.deliver(REPORT);
    expect(port.sent).toEqual([{
      kind: 'viewport',
      pageX: 5,
      pageY: -297,
      pageWidth: 794,
      viewportWidth: 593,
      viewportHeight: 749,
      time: 4_321,
      scrollbar: 0,
      scale: 1.5,
    }]);
    for (const devicePixelRatio of [
      () => Number.NaN,
      () => 0,
      () => 400,
      () => { throw new Error('no window'); },
    ]) {
      const measureScrollbar = vi.fn(() => 15);
      const unknown = setup({ measureScrollbar, devicePixelRatio });
      const other = unknown.open();
      unknown.deliver(REPORT);
      unknown.deliver(REPORT);
      // The scrollbar is still measured, once.
      expect(measureScrollbar).toHaveBeenCalledTimes(1);
      expect(other.sent).toHaveLength(2);
      for (const message of other.sent) {
        expect(message).toMatchObject({ scrollbar: 15 });
        expect(message).not.toHaveProperty('scale');
      }
    }
  });

  it('sends the report alone when the scrollbar cannot be measured (D134)', () => {
    for (const measureScrollbar of [
      () => undefined,
      () => Number.NaN,
      () => -3,
      () => 500,
      () => { throw new Error('no layout'); },
    ]) {
      const { open, deliver } = setup({ measureScrollbar });
      const port = open();
      deliver(REPORT);
      expect(port.sent).toEqual([{
        kind: 'viewport',
        pageX: 5,
        pageY: -297,
        pageWidth: 794,
        viewportWidth: 593,
        viewportHeight: 749,
        time: 4_321,
      }]);
    }
  });

  it('stops listening when the panel disconnects', () => {
    const { listeners, intervals, open, deliver } = setup();
    const port = open();
    port.disconnect();
    expect(listeners.size).toBe(0);
    expect(intervals[0]!.cleared).toBe(true);
    deliver(REPORT);
    expect(port.sent).toEqual([]);
  });
});
