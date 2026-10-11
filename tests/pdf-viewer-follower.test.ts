import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PDF_LOCATE_MAX_TRIES,
  PDF_LOCATE_REST_MS,
  PdfViewerFollower,
  type PdfViewerConnection,
  type PdfViewerFollowerDependencies,
} from '../entrypoints/sidepanel/pdf-viewer-follower';
import {
  PDF_VIEWER_MOVEMENT_SETTLE_MS,
  PDF_VIEWER_SETTLE_MS,
  type PdfViewerDoubt,
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

function setup(options: {
  enabled?: boolean;
  connectFails?: boolean;
  locate?: PdfViewerFollowerDependencies['locate'];
  viewerZoom?: () => number | undefined;
  askViewerZoom?: PdfViewerFollowerDependencies['askViewerZoom'];
} = {}) {
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
    ...(options.locate ? { locate: options.locate } : {}),
    ...(options.viewerZoom ? { viewerZoom: options.viewerZoom } : {}),
    ...(options.askViewerZoom ? { askViewerZoom: options.askViewerZoom } : {}),
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

  it('reads End by the scrollbar the tab says it draws (D134)', async () => {
    vi.useFakeTimers();
    for (const scrollbar of [25, undefined]) {
      const { follower, view, send } = setup();
      follower.start(TARGET, PAGES);
      await Promise.resolve();
      // The page is wider than the view: the viewer stops a scrollbar short
      // of the bottom its reports give. This tab draws one 25 px wide.
      const bottom = 300 * PITCH - 4 - (700 - 25);
      const told = scrollbar === undefined ? {} : { scrollbar };
      send({ ...report(0, 1_000), ...told });
      for (let frame = 1; frame <= 10; frame += 1) {
        send({ ...report((bottom * frame) / 10, 2_000 + frame * 16), ...told });
      }
      vi.advanceTimersByTime(PDF_VIEWER_MOVEMENT_SETTLE_MS);
      // Told nothing, the tracker looks for one of 15 px: not the bottom.
      if (scrollbar === undefined) expect(view.position?.index).toBeLessThan(10);
      else expect(view.position?.index).toBe(299);
      follower.stop();
    }
  });

  it('reads End by the scale the tab says its screen has (D134)', async () => {
    vi.useFakeTimers();
    for (const scale of [1.5, 1, undefined]) {
      const { follower, view, send } = setup();
      follower.start(TARGET, PAGES);
      await Promise.resolve();
      // The tab draws no scrollbar, and Chrome stops a pixel and a half
      // short of the bottom worked out: its rounding on a scaled screen.
      const bottom = 300 * PITCH - 4 - 700 - 1.5;
      const told = { scrollbar: 0, ...(scale === undefined ? {} : { scale }) };
      send({ ...report(0, 1_000), ...told });
      for (let frame = 1; frame <= 10; frame += 1) {
        send({ ...report((bottom * frame) / 10, 2_000 + frame * 16), ...told });
      }
      vi.advanceTimersByTime(PDF_VIEWER_MOVEMENT_SETTLE_MS);
      if (scale === 1.5) expect(view.position?.index).toBe(299);
      else expect(view.position?.index).toBeLessThan(10);
      follower.stop();
    }
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

describe('PdfViewerFollower looks into a doubted place (D133)', () => {
  /** A jump as Chrome reports it: the place, and again a millisecond later. */
  function jump(send: (message: unknown) => void, scroll: number, time: number): void {
    send(report(scroll, time));
    send(report(scroll, time + 1));
  }

  it('asks which page the viewer shows once it has rested, and goes there', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (): Promise<number | undefined> => 200);
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES, { index: 0, fraction: 0 });
    await Promise.resolve();
    send(report(0, 1_000));
    // The first report is a guess: the viewer may have been scrolled already.
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS - 1);
    expect(locate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(locate).toHaveBeenCalledTimes(1);
    const [target, doubt, signal] = locate.mock.calls[0] as unknown as [
      typeof TARGET,
      PdfViewerDoubt,
      AbortSignal,
    ];
    expect(target).toBe(TARGET);
    expect(doubt.page).toBe(0);
    expect(doubt.pages).toHaveLength(300);
    expect(signal.aborted).toBe(false);
    expect(view.position).toEqual({ index: 200, fraction: 0 });

    // Placed: scrolling on asks nothing more.
    for (let step = 1; step <= 20; step += 1) send(report(200 * PITCH + step * 30, 3_000 + step * 16));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(200);
  });

  it('waits for the viewer to rest: one look for a run of reports', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (): Promise<number | undefined> => undefined);
    const { follower, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(0, 1_000));
    for (let step = 1; step <= 30; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
      send(report(step * 30, 1_000 + step * 100));
    }
    expect(locate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it('looks after a jump, after its held report is read', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (_target: unknown, doubt: PdfViewerDoubt) =>
      (doubt.episode === 1 ? 0 : 40));
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(0, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);

    jump(send, 40 * PITCH + 500, 5_000);
    // Held until the viewer is still, then guessed, then looked into.
    await vi.advanceTimersByTimeAsync(PDF_VIEWER_MOVEMENT_SETTLE_MS);
    expect(view.position?.index).toBe(0);
    expect(locate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(2);
    expect(view.position?.index).toBe(40);
    expect(view.position?.fraction).toBeCloseTo(497 / 1056, 3);
  });

  it('does not look while following is off, and looks when it is turned on', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (): Promise<number | undefined> => 7);
    const { follower, view, send, setEnabled } = setup({ locate, enabled: false });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(locate).not.toHaveBeenCalled();

    setEnabled(true);
    follower.realign();
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(7);
  });

  it('keeps the guess when no page is found, and tries a doubt three times at most', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (): Promise<number | undefined> => undefined);
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(0);
    // The viewer scrolls and rests again and again: the same doubt.
    for (let rest = 1; rest <= 6; rest += 1) {
      send(report(100 + rest * 60, 1_000 + rest * 2_000));
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(locate).toHaveBeenCalledTimes(PDF_LOCATE_MAX_TRIES);
    // Another jump is another doubt.
    jump(send, 90 * PITCH + 300, 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(locate).toHaveBeenCalledTimes(PDF_LOCATE_MAX_TRIES + 1);
  });

  it('stops looking when looking again is no use: no capture allowed', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (): Promise<'stop'> => 'stop');
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    jump(send, 90 * PITCH + 300, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    jump(send, 20 * PITCH + 300, 20_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(locate).toHaveBeenCalledTimes(1);
    // The guesses stay, as before.
    expect(view.position?.index).toBe(0);
    // Turning following off and on again does not ask either.
    follower.realign();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(locate).toHaveBeenCalledTimes(1);
    // A PDF shown again (a new toolbar click) is asked again.
    follower.start({ tabId: 7, documentId: 'OTHER' }, PAGES);
    await Promise.resolve();
    send(report(100, 30_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(2);
    // And so is the same PDF shown again (Refresh): once more, no oftener.
    follower.start({ tabId: 7, documentId: 'OTHER' }, PAGES);
    await Promise.resolve();
    send(report(100, 40_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(3);
    jump(send, 50 * PITCH + 300, 50_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(locate).toHaveBeenCalledTimes(3);
  });

  it('takes no page without a look, even when one page alone fits the report', async () => {
    vi.useFakeTimers();
    // Letter pages with one A4 page (page 4): 794 px wide at 100%, not 816.
    const mixed = PAGES.slice(0, 10).map((size, index) =>
      (index === 3 ? { width: 595.5, height: 842 } : size));
    const locate = vi.fn(async (): Promise<number | undefined> => 3);
    const { follower, view, send } = setup({ locate, viewerZoom: () => 1 });
    follower.start(TARGET, mixed, { index: 0, fraction: 0 });
    await Promise.resolve();
    // The first report: a page 794 px wide, 200 px scrolled down it. The
    // tracker takes a Letter page at 97% for it; at the tab's 100% only the
    // A4 page is that wide. The tab's zoom can lag the viewer's, so even
    // then the page is read before it is taken.
    send({ kind: 'viewport', pageX: 5, pageY: -200, pageWidth: 794, viewportWidth: 820, viewportHeight: 700, time: 1_000 });
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS - 1);
    expect(view.position?.index).not.toBe(3);
    await vi.advanceTimersByTimeAsync(1);

    expect(locate).toHaveBeenCalledTimes(1);
    const [, doubt] = locate.mock.calls[0] as unknown as [unknown, { pages: number[] }];
    expect(doubt.pages).toEqual([3]);
    expect(view.position?.index).toBe(3);
    expect(view.position?.fraction).toBeCloseTo(200 / 1122, 2);
  });

  it('looks into a doubt that waited through a Refresh of the same PDF', async () => {
    vi.useFakeTimers();
    const answers: (number | undefined)[] = [undefined, 40];
    const locate = vi.fn(async (): Promise<number | undefined> => answers.shift());
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(40 * PITCH + 300, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(0);

    // Refresh: the same tab document is shown again; the viewer sends nothing.
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(2);
    expect(view.position?.index).toBe(40);
  });

  it('leaves no timer behind when following stops', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (): Promise<number | undefined> => undefined);
    const { follower, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    expect(vi.getTimerCount()).toBe(1);

    follower.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('asks again at the next rest when it could not try (text recognition is off)', async () => {
    vi.useFakeTimers();
    let ready = false;
    const locate = vi.fn((): Promise<number | undefined> | undefined =>
      (ready ? Promise.resolve(12) : undefined));
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(0);
    // Asking that could not be answered does not use up the tries.
    for (let rest = 1; rest <= 5; rest += 1) {
      send(report(100 + rest * 60, 1_000 + rest * 2_000));
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect(locate).toHaveBeenCalledTimes(6);

    // Turned on: the next rest asks, and the doubt has all its tries left.
    ready = true;
    send(report(100 + 6 * 60, 20_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(7);
    expect(view.position?.index).toBe(12);
  });

  it('takes no page for a report that has passed, and looks again at the next rest', async () => {
    vi.useFakeTimers();
    const pending: { answer?: (page: number | undefined) => void } = {};
    const locate = vi.fn((): Promise<number | undefined> =>
      new Promise((resolve) => { pending.answer = resolve; }));
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);

    // The viewer scrolls while the page is being found, and rests.
    send(report(160, 1_500));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    pending.answer?.(50);
    await vi.advanceTimersByTimeAsync(0);
    // The page was for the earlier report: not taken.
    expect(view.position?.index).toBe(0);
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(2);
    pending.answer?.(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.position?.index).toBe(50);
    expect(view.position?.fraction).toBeCloseTo(157 / 1056, 3);
  });

  it('leaves the view where the reader scrolled it, and follows from the found page after', async () => {
    vi.useFakeTimers();
    const pending: { answer?: (page: number | undefined) => void } = {};
    const locate = vi.fn((): Promise<number | undefined> =>
      new Promise((resolve) => { pending.answer = resolve; }));
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    // The reader scrolls the panel while the page is being found.
    view.position = { index: 3, fraction: 0.5 };
    pending.answer?.(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(view.position).toEqual({ index: 3, fraction: 0.5 });

    // The viewer moves: the view follows it, from page 51.
    send(report(50 * PITCH + 130, 5_000));
    expect(view.position?.index).toBe(50);
  });

  it('stops a look when following stops', async () => {
    vi.useFakeTimers();
    const pending: { answer?: (page: number | undefined) => void; signal?: AbortSignal } = {};
    const locate = vi.fn((_target: unknown, _doubt: unknown, signal: AbortSignal) => {
      pending.signal = signal;
      return new Promise<number | undefined>((resolve) => { pending.answer = resolve; });
    });
    const { follower, view, send } = setup({ locate });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    follower.stop();

    expect(pending.signal?.aborted).toBe(true);
    pending.answer?.(50);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(view.position?.index).toBe(0);
    // A rest timer left behind does nothing either.
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 9_000));
    follower.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it('a failing look changes nothing', async () => {
    vi.useFakeTimers();
    const locate = vi.fn((): Promise<number | undefined> => Promise.reject(new Error('no')));
    const throwing = vi.fn((): Promise<number | undefined> => {
      throw new Error('no');
    });
    for (const failing of [locate, throwing]) {
      const { follower, view, send } = setup({ locate: failing });
      follower.start(TARGET, PAGES);
      await Promise.resolve();
      send(report(100, 1_000));
      await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
      expect(failing).toHaveBeenCalledTimes(1);
      send(report(130, 3_000));
      expect(view.position?.fraction).toBeCloseTo(127 / 1056, 3);
    }
  });

  it('stops following a view turned a quarter, by the tab\'s zoom', async () => {
    vi.useFakeTimers();
    let zoom: number | undefined = 1;
    const locate = vi.fn(async (): Promise<number | undefined> => undefined);
    const { follower, view, send } = setup({ locate, viewerZoom: () => zoom });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(0, 1_000));
    for (let step = 1; step <= 10; step += 1) send(report(step * 30, 1_000 + step * 16));
    const before = view.position;
    const moves = view.followPosition.mock.calls.length;

    // Ctrl+]: pages 1,056 px wide at the same zoom.
    for (let step = 0; step < 20; step += 1) {
      send({ ...report(300 + step * 100, 5_000 + step * 40), pageWidth: 1056 });
    }
    await vi.advanceTimersByTimeAsync(5_000);
    expect(view.followPosition).toHaveBeenCalledTimes(moves);
    expect(view.position).toBe(before);

    // In a fit mode the zoom changes with the turn; Chrome tells of it apart.
    zoom = 0.7;
    follower.zoomChanged();
    send({ ...report(900, 20_000), pageWidth: 1056 * 0.7 });
    send({ ...report(1_000, 20_040), pageWidth: 1056 * 0.7 });
    expect(view.followPosition).toHaveBeenCalledTimes(moves);
  });

  it('hears of the tab\'s zoom when it changes, without waiting for a report', async () => {
    vi.useFakeTimers();
    let zoom: number | undefined = 1;
    const locate = vi.fn(async (): Promise<number | undefined> => undefined);
    const { follower, send } = setup({ locate, viewerZoom: () => zoom });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    // Fit to page, turned: the viewer reports first, a page 739 px wide
    // in the middle of the view, which at 100% is neither a page's width
    // nor its height: Chrome has not told of the zoom yet, and until it
    // has there is nothing to look into.
    const turned = { ...report(100, 1_000), pageWidth: 1056 * 0.7, pageX: (800 - 14 - 1056 * 0.7) / 2 };
    send(turned);
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).not.toHaveBeenCalled();
    send({ ...turned, pageY: turned.pageY - 30, time: 3_000 });
    // Then Chrome tells of the zoom: 70%, at which that is a page's height.
    zoom = 0.7;
    follower.zoomChanged();
    await vi.advanceTimersByTimeAsync(5_000);

    // Turned: not followed, and nothing to look into.
    expect(locate).not.toHaveBeenCalled();
  });

  it('looks once Chrome has told of the zoom a doubted report was made at', async () => {
    vi.useFakeTimers();
    let zoom: number | undefined = 1;
    const locate = vi.fn(async (): Promise<number | undefined> => 12);
    const { follower, view, send } = setup({ locate, viewerZoom: () => zoom });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    // The first report comes at 80%, of which Chrome has not told yet.
    send({ ...report(100, 1_000), pageWidth: 816 * 0.8, pageX: (800 - 14 - 816 * 0.8) / 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(locate).not.toHaveBeenCalled();

    zoom = 0.8;
    follower.zoomChanged();
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(12);
  });

  it('asks Chrome for the tab\'s zoom when the viewer rests on a report that fits no page at the zoom held (D146)', async () => {
    vi.useFakeTimers();
    let zoom: number | undefined = 1;
    const locate = vi.fn(async (): Promise<number | undefined> => 12);
    // Chrome answers 80%, and the panel takes it as a zoom change.
    const askViewerZoom = vi.fn(() => {
      void Promise.resolve().then(() => {
        zoom = 0.8;
        harness.follower.zoomChanged();
      });
    });
    const harness = setup({ locate, viewerZoom: () => zoom, askViewerZoom });
    const { follower, view, send } = harness;
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    // The first report comes at 80%, and Chrome never tells of it.
    send({ ...report(100, 1_000), pageWidth: 816 * 0.8, pageX: (800 - 14 - 816 * 0.8) / 2 });
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS - 1);
    expect(askViewerZoom).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(askViewerZoom).toHaveBeenCalledTimes(1);
    expect(askViewerZoom).toHaveBeenCalledWith(TARGET);
    expect(locate).not.toHaveBeenCalled();

    // Its answer is a zoom change: the guess is looked into at the next rest.
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(view.position?.index).toBe(12);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(askViewerZoom).toHaveBeenCalledTimes(1);
  });

  it('does not ask for the zoom while the reports fit the zoom held, while it knows none, or while following is off (D146)', async () => {
    vi.useFakeTimers();
    let zoom: number | undefined = 1;
    const locate = vi.fn(async (): Promise<number | undefined> => undefined);
    const askViewerZoom = vi.fn();
    const { follower, send, setEnabled } = setup({ locate, viewerZoom: () => zoom, askViewerZoom });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    send(report(100, 1_000));
    send(report(130, 1_016));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(askViewerZoom).not.toHaveBeenCalled();

    // No zoom known: nothing to compare the report with.
    zoom = undefined;
    send({ ...report(160, 8_000), pageWidth: 816 * 0.8, pageX: (800 - 14 - 816 * 0.8) / 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(askViewerZoom).not.toHaveBeenCalled();

    // Following off: the view does not move, and nothing is asked.
    zoom = 1;
    setEnabled(false);
    send({ ...report(190, 16_000), pageWidth: 816 * 0.8, pageX: (800 - 14 - 816 * 0.8) / 2 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(askViewerZoom).not.toHaveBeenCalled();
    // Turned on again: asked at the rest that follows.
    setEnabled(true);
    follower.realign();
    await vi.advanceTimersByTimeAsync(PDF_LOCATE_REST_MS);
    expect(askViewerZoom).toHaveBeenCalledTimes(1);
  });

  it('asks once a rest while the view is turned, and stays put when Chrome says the same zoom (D146)', async () => {
    vi.useFakeTimers();
    const locate = vi.fn(async (): Promise<number | undefined> => undefined);
    // Chrome answers the zoom the panel holds, or cannot be asked: no zoom
    // change follows either way.
    const askViewerZoom = vi.fn((): void => undefined);
    askViewerZoom.mockImplementationOnce(() => { throw new Error('No tab'); });
    const { follower, view, send } = setup({ locate, viewerZoom: () => 0.7, askViewerZoom });
    follower.start(TARGET, PAGES);
    await Promise.resolve();
    const turned = { ...report(100, 1_000), pageWidth: 1056 * 0.7, pageX: (800 - 14 - 1056 * 0.7) / 2 };
    send(turned);
    send({ ...turned, pageY: turned.pageY - 30, time: 1_016 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(askViewerZoom).toHaveBeenCalledTimes(1);
    send({ ...turned, pageY: turned.pageY - 60, time: 7_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(askViewerZoom).toHaveBeenCalledTimes(2);
    expect(locate).not.toHaveBeenCalled();
    expect(view.followPosition).not.toHaveBeenCalled();
  });
});
