import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import { FULL_VISIBLE_REPLICA_READ_SCOPE } from '../lib/replica/read-scope-policy';
import {
  createSemanticSourceAck,
  createSemanticSourcePortName,
  createSemanticSourceStart,
  type SemanticSourceBatch,
} from '../lib/replica/semantic-source-protocol';
import {
  SemanticSourceSession,
  type SemanticSourcePort,
} from '../lib/replica/semantic-source-session';
import type {
  SourceControlledContentPolicy,
  SourceControlledContentReuse,
} from '../lib/replica/source-privacy-policy';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

/** What each scan asked the policy to be built on, and what it got. */
const builds = vi.hoisted(() => ({
  calls: [] as Array<{
    reuse: SourceControlledContentReuse | undefined;
    policy?: SourceControlledContentPolicy;
  }>,
}));

vi.mock('../lib/replica/source-privacy-policy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/replica/source-privacy-policy')>();
  return {
    ...actual,
    beginSourceControlledContentPolicy: (
      ...args: Parameters<typeof actual.beginSourceControlledContentPolicy>
    ) => {
      const builder = actual.beginSourceControlledContentPolicy(...args);
      const call: (typeof builds.calls)[number] = { reuse: args[3] };
      builds.calls.push(call);
      return {
        step: (...stepArgs: Parameters<typeof builder.step>) => {
          const policy = builder.step(...stepArgs);
          if (policy) call.policy = policy;
          return policy;
        },
      };
    },
  };
});

const identity: ReplicaSourceDocumentIdentity = {
  sessionId: 'policy-reuse-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'policy-reuse-document',
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

describe('the policy of controlled content in the semantic scan (D225)', () => {
  it('is built on the index of the one before, until a change may move it', () => {
    builds.calls = [];
    const { document, window } = parseHTML(
      '<html><body><button aria-expanded="false" aria-controls="menu">Menu</button>' +
        '<ul id="menu" hidden><li><a href="/a">First</a></li></ul>' +
        '<p id="note">Note</p><div id="box"></div></body></html>',
    );
    const port = new Port(createSemanticSourcePortName(identity.sessionId, 'isolated-html'));
    let next = 1;
    const ids = new WeakMap<object, number>();
    let observed: MutationCallback | undefined;
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
      createMutationObserver: (callback) => {
        observed = callback;
        return { observe: () => {}, disconnect: () => {}, takeRecords: () => [] };
      },
      schedule: (callback) => callback(),
      setTimer: (callback) => callback,
      clearTimer: () => {},
    });
    port.emit(createSemanticSourceStart('isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE));
    let acked = 0;
    const change = (records: Array<Partial<MutationRecord>>): void => {
      // A batch is acknowledged once; a scan whose batch would be the same
      // posts none.
      const last = port.posted.at(-1)!;
      if (last.sequence !== acked) {
        acked = last.sequence;
        port.emit(createSemanticSourceAck(identity, last.policyFingerprint, last.sequence));
      }
      observed!(records.map((record) => ({
        addedNodes: [] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
        attributeName: null,
        attributeNamespace: null,
        oldValue: null,
        previousSibling: null,
        nextSibling: null,
        ...record,
      })) as MutationRecord[], {} as MutationObserver);
      session.refresh();
    };
    const note = document.querySelector('#note')!;
    const box = document.querySelector('#box')!;

    // What each build after `from` was built on: the index of which build,
    // and the nodes put in since that index's walk.
    const builtOn = (from: number) => builds.calls.slice(from).map(({ reuse }) => reuse
      ? [builds.calls.findIndex(({ policy }) => policy === reuse.policy), reuse.addedSince]
      : 'walked');
    expect(builtOn(0)).toEqual(['walked']);
    // A text changed: the walk's index stands, and each policy after is
    // built on it, without walking the document again.
    let from = builds.calls.length;
    note.firstChild!.nodeValue = 'Changed';
    change([{ type: 'characterData', target: note.firstChild!, oldValue: 'Note' }]);
    expect(builtOn(from)).toEqual(expect.arrayContaining([[from - 1, 0]]));
    expect(builtOn(from)).not.toContain('walked');
    // An element without an id put in: still, counting what came in.
    from = builds.calls.length;
    const span = document.createElement('span');
    box.append(span);
    change([{ type: 'childList', target: box, addedNodes: [span] as unknown as NodeList }]);
    expect(builtOn(from)).toEqual(expect.arrayContaining([[from - 1, 1]]));
    expect(builtOn(from)).not.toContain('walked');
    // An id written may move it: the document is walked again, and that
    // walk's index is the one built on next.
    from = builds.calls.length;
    box.setAttribute('id', 'renamed');
    change([{ type: 'attributes', target: box, attributeName: 'id', oldValue: 'box' }]);
    expect(builtOn(from)[0]).toBe('walked');
    from = builds.calls.length;
    note.firstChild!.nodeValue = 'Again';
    change([{ type: 'characterData', target: note.firstChild!, oldValue: 'Changed' }]);
    expect(builtOn(from)).not.toContain('walked');
    expect(builtOn(from)[0]).toEqual([expect.any(Number), 0]);
    session.dispose();
  });
});
