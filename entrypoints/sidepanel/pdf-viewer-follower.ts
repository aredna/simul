import type { PdfPagePoints, PdfReadingPosition } from '../../lib/pdf/pdf-layout';
import {
  createPdfViewerPortName,
  readPdfViewerPortMessage,
} from '../../lib/pdf/pdf-viewer-protocol';
import { PdfViewerTracker, type PdfViewerDoubt } from '../../lib/pdf/pdf-viewer-tracker';

/** The PDF tab whose viewer is followed. */
export interface PdfViewerTarget {
  readonly tabId: number;
  readonly documentId: string;
}

/** A connection to the bridge in the PDF tab. */
export interface PdfViewerConnection {
  onMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  disconnect(): void;
}

export interface PdfViewerFollowerDependencies {
  /** Injects the bridge into the tab's document and connects to it. */
  readonly connect: (target: PdfViewerTarget) => Promise<PdfViewerConnection>;
  readonly view: {
    readingPosition(): PdfReadingPosition | undefined;
    followPosition(position: PdfReadingPosition): void;
    /** Sideways: scrolled across by a share of the widest page's width. */
    followLeft(left: number): void;
  };
  /** Follow source scrolling: whether the view moves with the viewer. */
  readonly enabled: () => boolean;
  /** Content-free: whether the tab's viewer could be reached. */
  readonly onDiagnostic?: (state: 'connected' | 'unavailable') => void;
  /**
   * Finds which page a doubted reading shows, from the page box of the
   * viewer's toolbar in a capture of the tab (D133). Resolves with the page
   * (0-based), with `undefined` when it cannot tell, or with `stop` when
   * looking again is no use: Chrome does not allow the capture. Then it is
   * not asked again until the PDF is shown anew (a Refresh, another PDF).
   * Returns `undefined` at once when it cannot try (Simul's text
   * recognition is off).
   */
  readonly locate?: (
    target: PdfViewerTarget,
    doubt: PdfViewerDoubt,
    signal: AbortSignal,
  ) => Promise<number | undefined | 'stop'> | undefined;
  /** The tab's zoom, which is the viewer's (D104); `undefined` when unknown. */
  readonly viewerZoom?: () => number | undefined;
  /**
   * Asks Chrome for the tab's zoom (D146): the viewer has rested on a
   * report that fits no page at the zoom `viewerZoom` gives. A zoom that
   * differs comes back as any zoom change does, through `zoomChanged`.
   */
  readonly askViewerZoom?: (target: PdfViewerTarget) => void;
}

/**
 * The viewer must have been still this long before the tab is captured:
 * longer than the tracker holds a movement, and time for the toolbar to
 * show the page the viewer went to.
 */
export const PDF_LOCATE_REST_MS = 350;
/** One doubt is looked into at most this many times. */
export const PDF_LOCATE_MAX_TRIES = 3;
// The view counts as where the follower put it within this share of a page.
const SAME_PLACE_SHARE = 0.02;

interface Session {
  readonly target: PdfViewerTarget;
  readonly pageSizes: readonly PdfPagePoints[];
  readonly tracker: PdfViewerTracker;
  /** Whether guessing starts from a given place, not the view's. */
  readonly anchored: boolean;
  /** The viewer's sideways place the view was last told of. */
  left: number | undefined;
  connection: PdfViewerConnection | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Waits for the viewer to rest before a doubt is looked into. */
  locateTimer: ReturnType<typeof setTimeout> | undefined;
  /** Stops a look in progress. */
  locating: AbortController | undefined;
  /** A rest came while a look ran: look again when it ends. */
  locateAgain: boolean;
  /** The doubt last looked into and how many times. */
  episode: number | undefined;
  tries: number;
  /** Looking is no use here (no capture allowed): no more looks. */
  stopped: boolean;
  /** Where the follower last put the view. */
  movedTo: PdfReadingPosition | undefined;
}

/**
 * Moves the PDF view with Chrome's PDF viewer in the followed tab (D108).
 * Every report is read, so the latest guess is known even while following
 * is off; the view moves only while it is on, and only when the viewer
 * moved, so the reader's own scrolling of the view stays until then. The
 * viewer's sideways place is followed the same way, apart from its place
 * down the PDF (D115). A tab where nothing answers (no grant, Edge, a
 * changed viewer) is not followed.
 *
 * A reading that could be whole pages off (a jump, the first report) is
 * looked into once the viewer has rested (D133): `locate` reads the page
 * from one capture of the tab, the tracker takes it, and the view goes
 * there if it is still where the guess put it. Only while following is on;
 * without `locate`, or when it finds nothing, the guess stays. No page is
 * taken without a reading, however few pages fit the report.
 *
 * A guess can be looked into only once the pages its report fits at the
 * tab's zoom are known. Chrome tells of a zoom apart from the viewer's
 * reports; when the viewer rests on a report that fits no page at the zoom
 * the panel holds, the follower does not wait to be told and asks (D146).
 */
export class PdfViewerFollower {
  readonly #dependencies: PdfViewerFollowerDependencies;
  #session: Session | undefined;
  /** The last session, whose guess a Refresh of the same PDF keeps. */
  #previous: Session | undefined;

  constructor(dependencies: PdfViewerFollowerDependencies) {
    this.#dependencies = dependencies;
  }

  /** Whether the view moves with the viewer now. */
  get following(): boolean {
    return this.#dependencies.enabled();
  }

  /**
   * Follows the viewer showing a PDF with these page sizes; stops any other.
   * Guessing starts from `anchor` (a newly opened tab's viewer is at its
   * start), else from the view's own place at the first report. The same
   * tab document shown again (Refresh) keeps the guess it had.
   */
  start(
    target: PdfViewerTarget,
    pageSizes: readonly PdfPagePoints[],
    anchor?: PdfReadingPosition,
  ): void {
    this.stop();
    const previous = this.#previous;
    this.#previous = undefined;
    const kept = previous &&
        previous.target.tabId === target.tabId &&
        previous.target.documentId === target.documentId &&
        samePageSizes(previous.pageSizes, pageSizes)
      ? previous.tracker
      : undefined;
    // A held movement of the kept guess is read as it stands.
    kept?.settle();
    const tracker = kept ?? new PdfViewerTracker(pageSizes);
    if (!kept) tracker.anchor(anchor);
    const session: Session = {
      target,
      pageSizes,
      tracker,
      anchored: anchor !== undefined,
      left: undefined,
      connection: undefined,
      timer: undefined,
      locateTimer: undefined,
      locating: undefined,
      locateAgain: false,
      episode: undefined,
      tries: 0,
      stopped: false,
      movedTo: undefined,
    };
    this.#session = session;
    // The view was mounted again at its far left: back to the kept place.
    this.#followLeft(session);
    // A doubt the kept guess still has is looked into (a Refresh while one waited).
    if (kept) this.#rest(session);
    let connecting: Promise<PdfViewerConnection>;
    try {
      connecting = this.#dependencies.connect(target);
    } catch {
      this.#report('unavailable');
      return;
    }
    void connecting.then((connection) => {
      if (this.#session !== session) {
        connection.disconnect();
        return;
      }
      session.connection = connection;
      this.#report('connected');
      connection.onMessage((message) => this.#receive(session, message));
      connection.onDisconnect(() => {
        if (this.#session === session) this.#end(session);
      });
    }, () => {
      // No grant or no document: the view scrolls on its own.
      if (this.#session === session) this.#report('unavailable');
    });
  }

  /** Stops following; reports still on their way are ignored. Idempotent. */
  stop(): void {
    const session = this.#session;
    if (!session) return;
    this.#end(session);
    try {
      session.connection?.disconnect();
    } catch {
      // Already gone with its document.
    }
  }

  /** Following was turned on: the view goes to the latest guess. */
  realign(): void {
    const session = this.#session;
    if (!session || !this.#dependencies.enabled()) return;
    const position = session.tracker.position;
    if (position) this.#move(session, position);
    session.left = undefined;
    this.#followLeft(session);
    this.#rest(session);
  }

  /**
   * The tab's zoom changed: a view turned a quarter shows by it (D123), and
   * so do the pages a doubted report fits, which may be looked into now.
   */
  zoomChanged(): void {
    const session = this.#session;
    if (!session) return;
    session.tracker.setViewerZoom(this.#dependencies.viewerZoom?.());
    this.#rest(session);
  }

  #end(session: Session): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
    if (session.locateTimer !== undefined) clearTimeout(session.locateTimer);
    session.locateTimer = undefined;
    session.locating?.abort();
    session.locating = undefined;
    if (this.#session === session) {
      this.#session = undefined;
      this.#previous = session;
    }
  }

  #receive(session: Session, message: unknown): void {
    if (this.#session !== session) return;
    const report = readPdfViewerPortMessage(message);
    if (!report) return;
    const { tracker } = session;
    if (!tracker.hasFix && !session.anchored) {
      tracker.anchor(this.#dependencies.view.readingPosition());
    }
    tracker.setViewerZoom(this.#dependencies.viewerZoom?.());
    // How wide the tab draws a scrollbar and how its screen is scaled,
    // which the viewer's reports leave out.
    tracker.setScrollbarWidth(report.scrollbar);
    tracker.setScreenScale(report.scale);
    const track = tracker.update(report, report.time);
    this.#rest(session);
    if (track.kind === 'hold') {
      if (session.timer !== undefined) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = undefined;
        if (this.#session !== session) return;
        const position = tracker.settle();
        if (position && this.#dependencies.enabled()) this.#move(session, position);
        this.#followLeft(session);
        // The held movement is read now: where it ended may be a guess.
        this.#rest(session);
      }, track.wait);
      return;
    }
    if (session.timer !== undefined) {
      // The tracker read the held movement itself when this report came.
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (track.kind === 'move' && this.#dependencies.enabled()) this.#move(session, track.position);
    this.#followLeft(session);
  }

  /** The viewer moved, or may be looked at again: wait for it to rest. */
  #rest(session: Session): void {
    if (!this.#dependencies.locate || session.stopped) return;
    if (session.locateTimer !== undefined) clearTimeout(session.locateTimer);
    session.locateTimer = setTimeout(() => {
      session.locateTimer = undefined;
      void this.#locate(session);
    }, PDF_LOCATE_REST_MS);
  }

  /**
   * Looks into the tracker's doubt, if it has one: one capture of the tab,
   * only while following is on. The page found is taken only if the viewer
   * has not moved since; if it has, the next rest looks again.
   */
  async #locate(session: Session): Promise<void> {
    const locate = this.#dependencies.locate;
    if (
      this.#session !== session ||
      !locate ||
      session.stopped ||
      !this.#dependencies.enabled()
    ) return;
    if (session.locating) {
      session.locateAgain = true;
      return;
    }
    const { tracker } = session;
    // The panel holds another zoom than the viewer reports at: Chrome is
    // asked, and a look follows once `zoomChanged` brings its answer.
    if (tracker.zoomUnfitted) {
      try {
        this.#dependencies.askViewerZoom?.(session.target);
      } catch {
        // Following is a convenience; the guess stays.
      }
    }
    const doubt = tracker.doubt;
    if (!doubt) return;
    if (doubt.episode !== session.episode) {
      session.episode = doubt.episode;
      session.tries = 0;
    }
    if (session.tries >= PDF_LOCATE_MAX_TRIES) return;
    const stop = new AbortController();
    let locating: Promise<number | undefined | 'stop'> | undefined;
    try {
      locating = locate(session.target, doubt, stop.signal);
    } catch {
      return;
    }
    // It cannot try: nothing was captured, and the try does not count.
    if (!locating) return;
    session.tries += 1;
    session.locating = stop;
    let page: number | undefined | 'stop';
    try {
      page = await locating;
    } catch {
      page = undefined;
    }
    if (session.locating === stop) session.locating = undefined;
    if (this.#session !== session || stop.signal.aborted) return;
    if (page === 'stop') {
      // No grant for this tab: the guesses stay.
      session.stopped = true;
      return;
    }
    if (page !== undefined) this.#place(session, doubt, page);
    if (session.locateAgain) {
      session.locateAgain = false;
      this.#rest(session);
    }
  }

  /**
   * The tracker takes `page` for its doubt. The view goes there if it is
   * still where the guess put it: the reader's own scrolling since stays.
   */
  #place(session: Session, doubt: PdfViewerDoubt, page: number): void {
    const position = session.tracker.place(doubt, page);
    if (position && this.#dependencies.enabled() && this.#viewWhereMoved(session)) {
      this.#move(session, position);
    }
    this.#followLeft(session);
  }

  /** Whether the view is still where the follower last put it. */
  #viewWhereMoved(session: Session): boolean {
    const moved = session.movedTo;
    if (!moved) return true;
    let now: PdfReadingPosition | undefined;
    try {
      now = this.#dependencies.view.readingPosition();
    } catch {
      return false;
    }
    return now !== undefined &&
      Math.abs(now.index + now.fraction - (moved.index + moved.fraction)) <= SAME_PLACE_SHARE;
  }

  /**
   * Moves the view sideways when the viewer's sideways place changed. While
   * following is off the change is kept for `realign`.
   */
  #followLeft(session: Session): void {
    const left = session.tracker.left;
    if (left === undefined || left === session.left || !this.#dependencies.enabled()) return;
    session.left = left;
    try {
      this.#dependencies.view.followLeft(left);
    } catch {
      // Following is a convenience; the view carries on.
    }
  }

  #report(state: 'connected' | 'unavailable'): void {
    try {
      this.#dependencies.onDiagnostic?.(state);
    } catch {
      // A failing log line is not a failing follower.
    }
  }

  #move(session: Session, position: PdfReadingPosition): void {
    try {
      this.#dependencies.view.followPosition(position);
      // Where the view is now: the end of the PDF stops it short.
      session.movedTo = this.#dependencies.view.readingPosition() ?? position;
    } catch {
      // Following is a convenience; the view carries on.
    }
  }
}

function samePageSizes(left: readonly PdfPagePoints[], right: readonly PdfPagePoints[]): boolean {
  return left.length === right.length &&
    left.every((size, index) =>
      size.width === right[index]!.width && size.height === right[index]!.height);
}

/** Injects the bridge into the PDF tab's document and connects to it. */
export async function connectChromePdfViewer(
  target: PdfViewerTarget,
  sessionId: string,
): Promise<PdfViewerConnection> {
  const injections = await browser.scripting.executeScript({
    target: { tabId: target.tabId, documentIds: [target.documentId] },
    files: ['/pdf-viewer-bridge.js'],
  });
  if (!injections.some((result) => result.documentId === target.documentId)) {
    throw new Error('The PDF tab has another document now.');
  }
  const port = browser.tabs.connect(target.tabId, {
    documentId: target.documentId,
    name: createPdfViewerPortName(sessionId),
  });
  return {
    onMessage: (listener) => port.onMessage.addListener((message: unknown) => listener(message)),
    onDisconnect: (listener) => port.onDisconnect.addListener(() => listener()),
    disconnect: () => port.disconnect(),
  };
}
