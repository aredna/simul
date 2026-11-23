/**
 * The reader in another site's frame (D246): it reads the frame's document
 * with the read profile of the page and sends it, with the token the page's
 * reader posted the frame, to the panel. It reads again when the frame
 * changes, and sends only what differs. See `html-mirror-frame.ts`.
 */
import {
  HTML_MIRROR_FRAME_TOKEN_KEY,
  MAX_HTML_MIRROR_FRAME_BYTES,
  MAX_HTML_MIRROR_FRAME_NODES,
  countHtmlMirrorNodes,
  isFrameToken,
  readHtmlMirrorFramePortSessionId,
  readHtmlMirrorFrameStart,
  type HtmlMirrorFrameContent,
  type HtmlMirrorFrameGraph,
} from './html-mirror-frame';
import {
  createHtmlMirrorRepresentabilityCollector,
  htmlMirrorJsonBytes,
  readHtmlMirrorDocumentContent,
  sanitizeSourceDocument,
  type HtmlMirrorIdRegistry,
} from './html-mirror-sanitizer';
import { applyHtmlMirrorLimitSettings } from './html-mirror-limits';
import { applySourcePrivacyFiltersOff } from './source-privacy-mode';
import type { SelectableReplicaFidelityPolicy } from './fidelity-policy';
import type { SourceDocumentSecretScan } from './semantic-source-session';

/** A change is read after the frame is quiet this long. */
const FRAME_READ_DELAY_MS = 150;
/** At most one read in this time. */
const FRAME_READ_INTERVAL_MS = 400;
/**
 * A read this often too: what a frame's shadow roots and sheets change
 * reaches no observer of its document. Only while a read is cheap.
 */
const FRAME_POLL_MS = 2_000;
const FRAME_POLL_MAX_READ_MS = 8;

/** The token the page's reader posted this frame, and who waits for it. */
export interface HtmlMirrorFrameTokenListener {
  readonly token: () => string | undefined;
  readonly listen: (callback: () => void) => () => void;
}

/**
 * Listens, from the frame's start, for the token of the page's reader: a
 * message from the parent, which must be the top page, with the token alone.
 */
export function listenForHtmlMirrorFrameToken(
  sourceWindow: Window,
): HtmlMirrorFrameTokenListener | undefined {
  try {
    if (sourceWindow.top === sourceWindow || sourceWindow.parent !== sourceWindow.top) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  let token: string | undefined;
  const callbacks = new Set<() => void>();
  const onMessage = (event: MessageEvent): void => {
    try {
      if (event.source !== sourceWindow.parent) return;
      const data = event.data as unknown;
      if (
        typeof data !== 'object' || data === null ||
        Object.keys(data).length !== 1 ||
        !isFrameToken((data as Record<string, unknown>)[HTML_MIRROR_FRAME_TOKEN_KEY])
      ) return;
      token = (data as Record<string, string>)[HTML_MIRROR_FRAME_TOKEN_KEY];
    } catch {
      return;
    }
    for (const callback of [...callbacks]) callback();
  };
  try {
    sourceWindow.addEventListener('message', onMessage);
  } catch {
    return undefined;
  }
  return {
    token: () => token,
    listen: (callback) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  };
}

export interface HtmlMirrorFrameSourceSessionEnvironment {
  readonly port: Browser.runtime.Port;
  readonly document: Document;
  readonly window: Window;
  readonly registry: HtmlMirrorIdRegistry;
  readonly tokens: HtmlMirrorFrameTokenListener;
  readonly secretScan?: SourceDocumentSecretScan;
  readonly now: () => number;
  readonly createMutationObserver: (
    callback: MutationCallback,
  ) => Pick<MutationObserver, 'observe' | 'disconnect'>;
  readonly setTimer: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export class HtmlMirrorFrameSourceSession {
  #fidelityPolicy: SelectableReplicaFidelityPolicy | undefined;
  #observer: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  #timer: unknown;
  #pollTimer: unknown;
  #lastReadAt = Number.NEGATIVE_INFINITY;
  #lastReadMs = 0;
  #sent: { readonly token: string; readonly text: string } | undefined;
  #stopListening: (() => void) | undefined;
  #disposed = false;

  constructor(private readonly environment: HtmlMirrorFrameSourceSessionEnvironment) {
    if (!readHtmlMirrorFramePortSessionId(environment.port.name)) {
      throw new Error('Invalid HTML mirror frame Port.');
    }
    environment.port.onMessage.addListener(this.#onMessage);
    environment.port.onDisconnect.addListener(this.#onDisconnect);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#observer?.disconnect();
    this.#stopListening?.();
    this.environment.clearTimer(this.#timer);
    this.environment.clearTimer(this.#pollTimer);
    this.environment.window.removeEventListener('resize', this.#onChange);
    this.environment.port.onMessage.removeListener(this.#onMessage);
    this.environment.port.onDisconnect.removeListener(this.#onDisconnect);
    try {
      this.environment.port.disconnect();
    } catch {
      // Already gone with the frame.
    }
  }

  readonly #onMessage = (input: unknown): void => {
    const start = readHtmlMirrorFrameStart(input);
    if (!start || this.#fidelityPolicy) {
      this.dispose();
      return;
    }
    applyHtmlMirrorLimitSettings(start.limits);
    applySourcePrivacyFiltersOff(start.showEverything === true);
    this.#fidelityPolicy = start.fidelityPolicy;
    const begin = (): void => {
      if (this.#disposed) return;
      this.#stopListening = this.environment.tokens.listen(() => this.#read());
      try {
        this.#observer = this.environment.createMutationObserver(this.#onChange);
        this.#observer.observe(this.environment.document, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        this.#observer = undefined;
      }
      this.environment.window.addEventListener('resize', this.#onChange);
      this.#read();
    };
    const scan = this.environment.secretScan;
    if (scan && !scan.done) void scan.finished.then(begin);
    else begin();
  };

  readonly #onDisconnect = (): void => this.dispose();

  readonly #onChange = (): void => this.#schedule(FRAME_READ_DELAY_MS);

  #schedule(delay: number): void {
    if (this.#disposed || this.#timer !== undefined) return;
    const wait = Math.max(
      delay,
      this.#lastReadAt + FRAME_READ_INTERVAL_MS - this.environment.now(),
    );
    this.#timer = this.environment.setTimer(() => {
      this.#timer = undefined;
      this.#read();
    }, wait);
  }

  #read(): void {
    const fidelityPolicy = this.#fidelityPolicy;
    const token = this.environment.tokens.token();
    if (this.#disposed || !fidelityPolicy || !token) return;
    const startedAt = this.environment.now();
    this.#lastReadAt = startedAt;
    let graph: HtmlMirrorFrameGraph | null = null;
    try {
      const read = sanitizeSourceDocument(
        this.environment.document,
        this.environment.window,
        this.environment.registry,
        createHtmlMirrorRepresentabilityCollector(),
        fidelityPolicy,
      );
      const content = read && readHtmlMirrorDocumentContent(
        read.root,
        read.adoptedStyleSheets,
        fidelityPolicy,
      );
      if (
        content &&
        countHtmlMirrorNodes(content.root) <= MAX_HTML_MIRROR_FRAME_NODES &&
        htmlMirrorJsonBytes(content) <= MAX_HTML_MIRROR_FRAME_BYTES
      ) graph = content;
    } catch {
      graph = null;
    }
    this.#lastReadMs = this.environment.now() - startedAt;
    const text = JSON.stringify(graph);
    if (this.#sent?.token !== token || this.#sent.text !== text) {
      this.#sent = { token, text };
      const message: HtmlMirrorFrameContent = {
        kind: 'simul:html-mirror-frame-v1:content',
        token,
        graph,
      };
      try {
        this.environment.port.postMessage(message);
      } catch {
        this.dispose();
        return;
      }
    }
    this.environment.clearTimer(this.#pollTimer);
    this.#pollTimer = graph && this.#lastReadMs <= FRAME_POLL_MAX_READ_MS
      ? this.environment.setTimer(() => {
          this.#pollTimer = undefined;
          this.#schedule(0);
        }, FRAME_POLL_MS)
      : undefined;
  }
}
