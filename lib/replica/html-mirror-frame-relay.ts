/**
 * The panel's side of another site's frame (D246): runs the reader in the
 * page's own frames when the page's reader asks, and hands what each frame
 * reads to the page's reader, with the frame's token. See
 * `html-mirror-frame.ts`.
 */
import {
  MAX_HTML_MIRROR_FRAMES,
  createHtmlMirrorFramePortName,
  probeHtmlMirrorChildFrame,
  readHtmlMirrorFrameContent,
  type HtmlMirrorFrameControllerMessage,
  type HtmlMirrorFrameStart,
} from './html-mirror-frame';
import type { HtmlMirrorLimitSettings } from './html-mirror-limits';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';

/** A frame whose document went is looked for again after this long. */
const FRAME_LOOK_AGAIN_MS = 1_000;

export interface HtmlMirrorFrameRelayEnvironment {
  readonly tabId: number;
  readonly sessionId: string;
  readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
  readonly limits: HtmlMirrorLimitSettings;
  readonly showEverything: boolean;
  /** To the page's reader. */
  readonly post: (message: HtmlMirrorFrameControllerMessage) => void;
  /** The frames of the page: their documents, and whether each is one of its own. */
  readonly listFrames?: (tabId: number) => Promise<readonly {
    readonly frameId: number;
    readonly documentId?: string;
    readonly result?: unknown;
  }[]>;
  readonly injectReader?: (tabId: number, documentId: string) => Promise<void>;
  readonly connect?: (
    tabId: number,
    frameId: number,
    documentId: string,
    name: string,
  ) => Browser.runtime.Port;
  readonly setTimer?: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export class HtmlMirrorFrameRelay {
  readonly #ports = new Map<string, {
    readonly port: Browser.runtime.Port;
    token?: string;
  }>();
  #looking = false;
  #lookAgain = false;
  #lookTimer: unknown;
  #disposed = false;

  constructor(private readonly environment: HtmlMirrorFrameRelayEnvironment) {}

  /** Runs the reader in each of the page's frames it does not run in yet. */
  look(): void {
    if (this.#disposed) return;
    if (this.#looking) {
      this.#lookAgain = true;
      return;
    }
    this.#looking = true;
    void this.#look().finally(() => {
      this.#looking = false;
      if (this.#lookAgain && !this.#disposed) {
        this.#lookAgain = false;
        this.look();
      }
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#lookTimer !== undefined) {
      if (this.environment.clearTimer) this.environment.clearTimer(this.#lookTimer);
      else clearTimeout(this.#lookTimer as ReturnType<typeof setTimeout>);
    }
    for (const { port } of this.#ports.values()) {
      try {
        port.disconnect();
      } catch {
        // Already gone with its frame.
      }
    }
    this.#ports.clear();
  }

  async #look(): Promise<void> {
    const { tabId } = this.environment;
    let frames: Awaited<ReturnType<NonNullable<HtmlMirrorFrameRelayEnvironment['listFrames']>>>;
    try {
      frames = await (this.environment.listFrames ?? listChromeFrames)(tabId);
    } catch {
      return;
    }
    let started = false;
    for (const frame of frames) {
      if (this.#disposed || this.#ports.size >= MAX_HTML_MIRROR_FRAMES) break;
      const documentId = frame.documentId;
      if (
        frame.frameId === 0 || frame.result !== true ||
        typeof documentId !== 'string' || this.#ports.has(documentId)
      ) continue;
      try {
        await (this.environment.injectReader ?? injectChromeReader)(tabId, documentId);
        if (this.#disposed || this.#ports.has(documentId)) continue;
        const port = (this.environment.connect ?? connectChromeFrame)(
          tabId,
          frame.frameId,
          documentId,
          createHtmlMirrorFramePortName(this.environment.sessionId),
        );
        const entry: { readonly port: Browser.runtime.Port; token?: string } = { port };
        this.#ports.set(documentId, entry);
        port.onMessage.addListener((input: unknown) => {
          const content = readHtmlMirrorFrameContent(input);
          if (this.#disposed || this.#ports.get(documentId) !== entry) return;
          if (!content) {
            port.disconnect();
            this.#forget(documentId, entry);
            return;
          }
          entry.token = content.token;
          this.#post({
            protocolVersion: 2,
            kind: 'simul:html-mirror-v2:frame-content',
            sessionId: this.environment.sessionId,
            token: content.token,
            graph: content.graph,
          });
        });
        port.onDisconnect.addListener(() => this.#forget(documentId, entry));
        const start: HtmlMirrorFrameStart = {
          kind: 'simul:html-mirror-frame-v1:start',
          fidelityPolicy: this.environment.fidelityPolicy,
          limits: this.environment.limits,
          showEverything: this.environment.showEverything,
        };
        port.postMessage(start);
        started = true;
      } catch {
        // A frame that went, or takes no reader, stays blank.
      }
    }
    // Every frame's reader listens for its token before the page's reader
    // posts it: the reader is injected before this.
    if (started || frames.some((frame) =>
      typeof frame.documentId === 'string' && this.#ports.has(frame.documentId))) {
      this.#post({
        protocolVersion: 2,
        kind: 'simul:html-mirror-v2:frames-ready',
        sessionId: this.environment.sessionId,
      });
    }
  }

  /** A frame's document went: its box is blank, and its frame is looked at again. */
  #forget(documentId: string, entry: { readonly port: Browser.runtime.Port; token?: string }): void {
    if (this.#disposed || this.#ports.get(documentId) !== entry) return;
    this.#ports.delete(documentId);
    if (entry.token) {
      this.#post({
        protocolVersion: 2,
        kind: 'simul:html-mirror-v2:frame-content',
        sessionId: this.environment.sessionId,
        token: entry.token,
        graph: null,
      });
    }
    if (this.#lookTimer !== undefined) return;
    const lookAgain = (): void => {
      this.#lookTimer = undefined;
      this.look();
    };
    this.#lookTimer = this.environment.setTimer
      ? this.environment.setTimer(lookAgain, FRAME_LOOK_AGAIN_MS)
      : setTimeout(lookAgain, FRAME_LOOK_AGAIN_MS);
  }

  #post(message: HtmlMirrorFrameControllerMessage): void {
    if (this.#disposed) return;
    try {
      this.environment.post(message);
    } catch {
      this.dispose();
    }
  }
}

async function listChromeFrames(tabId: number) {
  return browser.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: probeHtmlMirrorChildFrame,
  });
}

async function injectChromeReader(tabId: number, documentId: string): Promise<void> {
  await browser.scripting.executeScript({
    target: { tabId, documentIds: [documentId] },
    files: ['/page-mirror.js'],
  });
}

function connectChromeFrame(
  tabId: number,
  frameId: number,
  documentId: string,
  name: string,
): Browser.runtime.Port {
  return browser.tabs.connect(tabId, { frameId, documentId, name });
}
