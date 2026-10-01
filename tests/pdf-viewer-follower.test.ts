import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PdfViewerFollower,
  type PdfViewerConnection,
} from '../entrypoints/sidepanel/pdf-viewer-follower';
import {
  PDF_VIEWER_MOVEMENT_SETTLE_MS,
  PDF_VIEWER_SETTLE_MS,
} from '../lib/pdf/pdf-viewer-tracker';
import type { PdfPagePoints, PdfReadingPosition } from '../lib/pdf/pdf-layout';

const PAGES: PdfPagePoints[] = Array.from({ length: 300 }, () => ({ width: 612, height: 792 }));
const TARGET = { tabId: 7, documentId: 'DOC' };
// Letter at 100%: 816 × 1056 px, a page every 1,070 px, the first top at 3.
const PITCH = 1070;

function report(scroll: number, time: number, viewportHeight = 700, scrollX = 0) {
  const page = Math.max(0, Math.round((scroll - 3) / PITCH));
  return {
    kind: 'viewport',
    // The page is 16 px wider than the view: scrolled across by `scrollX`.
    pageX: 5 - scrollX,
    pageY: 3 + page * PITCH - scroll,
    pageWidth: 816,
    viewportWidth: 800,
    viewportHeight,
    time,
  };
}

function setup(options: { enabled?: boolean; connectFails?: boolean } = {}) {
  let enabled = options.enabled ?? true;
  let deliver: ((message: unknown) => void) | undefined;
  let dropped: (() => void) | undefined;
  const connection = {
    onMessage: (listener: (message: unknown) => void) => { deliver = listener; },
    onDisconnect: (listener: () => void) => { dropped = listener; },
    disconnect: vi.fn((): void => undefined),
  } satisfies PdfViewerConnection;
  const connect = vi.fn(async () => {
    if (options.connectFails) throw new Error('no grant');
    return connection;
  });
  const view = {
    position: { index: 0, fraction: 0 } as PdfReadingPosition | undefined,
    readingPosition: vi.fn((): PdfReadingPosition | undefined => view.position),
    followPosition: vi.fn((position: PdfReadingPosition) => { view.position = position; }),
    left: undefined as number | undefined,
    followLeft: vi.fn((left: number) => { view.left = left; }),
  };
  const diagnostics: string[] = [];
  const follower = new PdfViewerFollower({
    connect,
    view,
    enabled: () => enabled,
    onDiagnostic: (state) => diagnostics.push(state),
  });
  return {
    follower,
    diagnostics,
    connect,
    connection,
    view,
    send: (message: unknown) => deliver?.(message),
    drop: () => dropped?.(),
    setEnabled: (value: boolean) => { enabled = value; },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PdfViewerFollower', () => {
  it('moves the view with the viewer while following is on', async () => {
    vi.useFakeTimers();
    const { follower, connect, view, send } = setup();
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    expect(connect).toHaveBeenCalledWith(TARGET);
    send(report(0, 1_000));
    send(report(30, 1_016));
    send(report(60, 1_032));
    expect(view.followPosition).toHaveBeenCalledTimes(3);
    expect(view.position?.fraction).toBeCloseTo(57 / 1056, 5);
    // A lone jump to page 3 fits every page equally: once the viewer is
    // still, the guess is the page nearest the previous place.
    send(report(2 * PITCH + 500, 2_000));
    expect(view.followPosition).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(PDF_VIEWER_SETTLE_MS);
    expect(view.position?.index).toBe(0);
    send(report(2 * PITCH + 500, 2_200));
    send({ kind: 'text', text: 'secret' });
    send({ ...report(9, 2_400), pageY: Number.NaN });
    expect(view.followPosition).toHaveBeenCalledTimes(4);
  });

  it('keeps reading while following is off and realigns when it is turned on', async () => {
    const { follower, view, send, setEnabled } = setup({ enabled: false });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(0, 1_000));
    for (let step = 1; step <= 50; step += 1) send(report(step * 30, 1_000 + step * 16));
    expect(view.followPosition).not.toHaveBeenCalled();
    setEnabled(true);
    follower.realign();
    expect(view.followPosition).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(1);
  });

  it('starts from the reader’s place in the view', async () => {
    const { follower, view, send } = setup();
    view.position = { index: 40, fraction: 0 };
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(40 * PITCH + 100, 1_000));
    expect(view.position?.index).toBe(40);
  });

  it('starts from the viewer’s start in a newly opened tab, whatever the view shows', async () => {
    const { follower, view, send } = setup();
    // The view reopened at a remembered page; the tab was reloaded.
    view.position = { index: 40, fraction: 0 };
    follower.start(TARGET, PAGES, { index: 0, fraction: 0 });
    await Promise.resolve();
    send(report(60, 1_000));
    expect(view.position?.index).toBe(0);
  });

  it('keeps its guess when the same tab document is shown again (Refresh)', async () => {
    const { follower, view, send, setEnabled } = setup();
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(0, 1_000));
    for (let step = 1; step <= 100; step += 1) send(report(step * 30, 1_000 + step * 16));
    expect(view.position?.index).toBe(2);
    // Refresh while following is off and the reader has scrolled away.
    setEnabled(false);
    view.position = { index: 30, fraction: 0 };
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(3_030, 5_000));
    setEnabled(true);
    follower.realign();
    expect(view.position?.index).toBe(2);

    // Another document starts over from the view's place.
    view.position = { index: 30, fraction: 0 };
    follower.start({ tabId: 7, documentId: 'OTHER' }, PAGES);
    await Promise.resolve();
    send(report(30 * PITCH + 50, 1_000));
    expect(view.position?.index).toBe(30);
  });

  it('settles a held movement after the viewer stops', async () => {
    vi.useFakeTimers();
    const { follower, view, send } = setup();
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(10_000, 1_000));
    // The bottom: the document is 300 pitches less the last separator.
    const end = 300 * PITCH - 4 - 700;
    // End: Chrome animates it over about ten frames, easing in and out.
    for (let frame = 1; frame <= 10; frame += 1) {
      const share = (1 - Math.cos((Math.PI * frame) / 10)) / 2;
      send(report(10_000 + (end - 10_000) * share, 1_000 + frame * 16));
    }
    const before = view.followPosition.mock.calls.length;
    vi.advanceTimersByTime(PDF_VIEWER_SETTLE_MS);
    // A movement waits longer than a lone report: the viewer may stall.
    expect(view.followPosition.mock.calls.length).toBe(before);
    vi.advanceTimersByTime(PDF_VIEWER_MOVEMENT_SETTLE_MS - PDF_VIEWER_SETTLE_MS);
    expect(view.followPosition.mock.calls.length).toBe(before + 1);
    expect(view.position?.index).toBeGreaterThanOrEqual(298);
  });

  it('moves the view sideways only when the viewer moved sideways (D115)', async () => {
    const { follower, view, send, setEnabled } = setup();
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    // The first report: the viewer's far left.
    send(report(0, 1_000));
    expect(view.followLeft).toHaveBeenCalledTimes(1);
    expect(view.left).toBe(0);
    // Down only: the reader's own sideways scroll of the view stays.
    send(report(400, 2_000));
    send(report(800, 3_000));
    expect(view.followLeft).toHaveBeenCalledTimes(1);
    // Sideways only, then both at once.
    send(report(800, 4_000, 700, 10));
    expect(view.followLeft).toHaveBeenCalledTimes(2);
    expect(view.left).toBeCloseTo(10 / 816, 6);
    send(report(840, 5_000, 700, 16));
    expect(view.followLeft).toHaveBeenCalledTimes(3);
    expect(view.left).toBeCloseTo(16 / 816, 6);

    // Following off: read, not followed; on again: the view goes there.
    setEnabled(false);
    send(report(840, 6_000, 700, 4));
    expect(view.followLeft).toHaveBeenCalledTimes(3);
    setEnabled(true);
    follower.realign();
    expect(view.followLeft).toHaveBeenCalledTimes(4);
    expect(view.left).toBeCloseTo(4 / 816, 6);
    // Turned on again without a move: the view is still put back there.
    follower.realign();
    expect(view.followLeft).toHaveBeenCalledTimes(5);
  });

  it('puts a view shown again back at the viewer\'s sideways place', async () => {
    const { follower, view, send } = setup();
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(0, 1_000, 700, 12));
    expect(view.left).toBeCloseTo(12 / 816, 6);
    // Refresh: the same tab document is mounted again, at its far left.
    follower.stop();
    view.left = undefined;
    follower.start(TARGET, PAGES);
    expect(view.left).toBeCloseTo(12 / 816, 6);
    // Another document starts with no place until its viewer reports.
    follower.stop();
    view.left = undefined;
    follower.start({ tabId: 7, documentId: 'OTHER' }, PAGES);
    expect(view.left).toBeUndefined();
  });

  it('ignores reports after stop and disconnects', async () => {
    const { follower, connection, view, send } = setup();
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    follower.stop();
    expect(connection.disconnect).toHaveBeenCalled();
    send(report(500, 1_000));
    expect(view.followPosition).not.toHaveBeenCalled();
    follower.realign();
    expect(view.followPosition).not.toHaveBeenCalled();
  });

  it('drops a connection that arrives after another start or a stop', async () => {
    const { follower, connection, connect } = setup();
    follower.start(TARGET, PAGES);
    follower.stop();
    await Promise.resolve();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connection.disconnect).toHaveBeenCalled();
  });

  it('does nothing when the tab cannot be reached or goes away', async () => {
    const failing = setup({ connectFails: true });
    failing.follower.start(TARGET, PAGES);
    await Promise.resolve();
    await Promise.resolve();
    failing.follower.realign();
    expect(failing.view.followPosition).not.toHaveBeenCalled();
    expect(failing.diagnostics).toEqual(['unavailable']);

    const { follower, view, send, drop, diagnostics: setupDiagnostics } = setup();
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    drop();
    send(report(500, 1_000));
    expect(view.followPosition).not.toHaveBeenCalled();
    expect(setupDiagnostics).toEqual(['connected']);
  });
});
