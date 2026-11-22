import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { FULL_VISIBLE_REPLICA_READ_SCOPE } from '../lib/replica/read-scope-policy';
import {
  createSemanticSourcePortName,
  createSemanticSourceStart,
  type SemanticSourceBatch,
} from '../lib/replica/semantic-source-protocol';
import {
  SemanticSourceSession,
  type SemanticSourcePort,
} from '../lib/replica/semantic-source-session';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

/**
 * Which text nodes the controlled-content policy withholds apart from their
 * element (D212). The real policy finds them by the page's boxes, which
 * linkedom has none of; here the test names them.
 */
const withheld = vi.hoisted(() => ({ texts: new Set<Node>() }));

vi.mock('../lib/replica/source-privacy-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/replica/source-privacy-policy')>();
  return {
    ...actual,
    beginSourceControlledContentPolicy: (
      ...args: Parameters<typeof actual.beginSourceControlledContentPolicy>
    ) => {
      const builder = actual.beginSourceControlledContentPolicy(...args);
      return {
        ...builder,
        step: (...stepArgs: Parameters<typeof builder.step>) => {
          const policy = builder.step(...stepArgs);
          return policy && { ...policy, withheldTexts: withheld.texts };
        },
      };
    },
  };
});

const identity: ReplicaSourceDocumentIdentity = {
  sessionId: 'withheld-text-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'withheld-text-document',
  frameId: 0,
};

class Port implements SemanticSourcePort {
  readonly posted: SemanticSourceBatch[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => this.#listeners.add(listener),
    removeListener: (listener: (message: unknown) => void) => this.#listeners.delete(listener),
  };
  readonly onDisconnect = { addListener: () => {}, removeListener: () => {} };
  constructor(readonly name: string) {}
  postMessage(message: SemanticSourceBatch): void {
    this.posted.push(message);
  }
  disconnect(): void {}
  emit(message: unknown): void {
    for (const listener of [...this.#listeners]) listener(message);
  }
}

describe('text the controlled-content policy withholds apart from its element (D214)', () => {
  it('is not sent by the semantic scan, as menu text or as editor text', () => {
    const { document, window } = parseHTML(
      '<html><body><button aria-expanded="true" aria-controls="menu">Menu</button>' +
        '<ul id="menu"><li><a href="/a">First</a></li><li><a href="/b">Second</a></li></ul>' +
        '<div contenteditable="true"><p>Typed one</p><p>Typed two</p></div></body></html>',
    );
    const textOf = (selector: string, index: number) =>
      document.querySelectorAll(selector)[index]!.firstChild as unknown as Node;
    const read = () => {
      const port = new Port(createSemanticSourcePortName(identity.sessionId, 'isolated-html'));
      let next = 1;
      const ids = new WeakMap<object, number>();
      const session = new SemanticSourceSession({
        port,
        document: document as unknown as Document,
        window: {
          ...(window as object),
          getComputedStyle: () => ({
            display: 'block',
            visibility: 'visible',
            getPropertyValue: () => 'none',
          }),
        } as unknown as Window,
        bridge: 'isolated-html',
        getNodeId: (node) => {
          let id = ids.get(node);
          if (!id) ids.set(node, id = next++);
          return id;
        },
        createMutationObserver: () => ({
          observe: () => {},
          disconnect: () => {},
          takeRecords: () => [],
        }),
        schedule: (callback) => callback(),
        setTimer: (callback) => callback,
        clearTimer: () => {},
      });
      port.emit(createSemanticSourceStart('isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE));
      session.dispose();
      return port.posted[0]!.records.map(({ text }) => text);
    };

    withheld.texts = new Set();
    expect(read()).toEqual(expect.arrayContaining(['First', 'Second', 'Typed one', 'Typed two']));
    withheld.texts = new Set([textOf('a', 1), textOf('p', 1)]);
    const sent = read();
    expect(sent).toEqual(expect.arrayContaining(['First', 'Typed one']));
    expect(sent).not.toContain('Second');
    expect(sent).not.toContain('Typed two');
  });
});
