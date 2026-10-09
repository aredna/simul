import { describe, expect, it, vi } from 'vitest';

import {
  PDF_VIEWER_MAX_HELLOS,
  installPdfViewerBridge,
  type PdfViewerBridgeEnvironment,
} from '../lib/pdf/pdf-viewer-bridge';
import {
  PDF_VIEWER_HELLO_TYPE,
  PDF_VIEWER_ORIGIN,
  createPdfViewerPortName,
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
} = {}) {
  const viewerWindow = { postMessage: vi.fn() };
  const frame = { contentWindow: viewerWindow };
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
    now: () => 4_321,
    measureScrollbar: options.measureScrollbar ?? (() => undefined),
    devicePixelRatio: options.devicePixelRatio ?? (() => Number.NaN),
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
  return { environment, viewerWindow, listeners, intervals, open, deliver };
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
    expect(timer!.cleared).toBe(true);

    const slow = setup({ frame: false });
    slow.open();
    const [slowTimer] = slow.intervals;
    for (let hello = 1; hello < PDF_VIEWER_MAX_HELLOS; hello += 1) slowTimer!.callback();
    expect(slowTimer!.cleared).toBe(true);
  });

  it('sends a later panel one hello once the viewer has answered', () => {
    const { viewerWindow, intervals, open, deliver } = setup();
    const first = open();
    deliver(REPORT);
    expect(intervals[0]!.cleared).toBe(true);
    // Refresh, or the separate window: the viewer sends no second answer.
    const second = open(createPdfViewerPortName('session-2'));
    expect(viewerWindow.postMessage).toHaveBeenCalledTimes(2);
    expect(intervals).toHaveLength(1);
    deliver(REPORT);
    expect(first.sent).toHaveLength(2);
    expect(second.sent).toHaveLength(1);
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
