import type { PdfPagePoints, PdfReadingPosition } from '../../lib/pdf/pdf-layout';
import {
  createPdfViewerPortName,
  readPdfViewerPortMessage,
} from '../../lib/pdf/pdf-viewer-protocol';
import { PdfViewerTracker } from '../../lib/pdf/pdf-viewer-tracker';

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
  };
  /** Follow source scrolling: whether the view moves with the viewer. */
  readonly enabled: () => boolean;
  /** Content-free: whether the tab's viewer could be reached. */
  readonly onDiagnostic?: (state: 'connected' | 'unavailable') => void;
}

interface Session {
  readonly target: PdfViewerTarget;
  readonly pageSizes: readonly PdfPagePoints[];
  readonly tracker: PdfViewerTracker;
  /** Whether guessing starts from a given place, not the view's. */
  readonly anchored: boolean;
  connection: PdfViewerConnection | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Moves the PDF view with Chrome's PDF viewer in the followed tab (D108).
 * Every report is read, so the latest guess is known even while following
 * is off; the view moves only while it is on, and only when the viewer
 * moved, so the reader's own scrolling of the view stays until then. A tab
 * where nothing answers (no grant, Edge, a changed viewer) is not followed.
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
      connection: undefined,
      timer: undefined,
    };
    this.#session = session;
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
    const position = this.#session?.tracker.position;
    if (position && this.#dependencies.enabled()) this.#move(position);
  }

  #end(session: Session): void {
    if (session.timer !== undefined) clearTimeout(session.timer);
    session.timer = undefined;
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
    const track = tracker.update(report, report.time);
    if (track.kind === 'hold') {
      if (session.timer !== undefined) clearTimeout(session.timer);
      session.timer = setTimeout(() => {
        session.timer = undefined;
        if (this.#session !== session) return;
        const position = tracker.settle();
        if (position && this.#dependencies.enabled()) this.#move(position);
      }, track.wait);
      return;
    }
    if (session.timer !== undefined) {
      // The tracker read the held movement itself when this report came.
      clearTimeout(session.timer);
      session.timer = undefined;
    }
    if (track.kind === 'move' && this.#dependencies.enabled()) this.#move(track.position);
  }

  #report(state: 'connected' | 'unavailable'): void {
    try {
      this.#dependencies.onDiagnostic?.(state);
    } catch {
      // A failing log line is not a failing follower.
    }
  }

  #move(position: PdfReadingPosition): void {
    try {
      this.#dependencies.view.followPosition(position);
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
