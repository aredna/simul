import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReplicaCaptureRequest } from '../lib/replica/contracts';
import { FULL_VISIBLE_REPLICA_READ_SCOPE } from '../lib/replica/read-scope-policy';
import { openChromeSemanticSource } from '../lib/replica/semantic-source-client';
import {
  createSemanticSourceBatch,
  type SemanticSourceRecord,
} from '../lib/replica/semantic-source-protocol';

afterEach(() => vi.unstubAllGlobals());

const request: ReplicaCaptureRequest = {
  sessionId: 'semantic-client-session',
  pageEpoch: 4,
  generation: 4,
  tabId: 9,
  frameId: 0,
  documentId: 'semantic-client-document',
  isCurrent: () => true,
};
const documentIdentity = {
  sessionId: request.sessionId,
  pageEpoch: request.pageEpoch,
  generation: request.generation,
  documentId: request.documentId,
  frameId: request.frameId,
};
const record: SemanticSourceRecord = {
  bridge: 'isolated-html',
  recordId: 27,
  nodeId: 3,
  nodeRevision: 1,
  category: 'ordinary-form',
  gate: 'formValues',
  tagName: 'input',
  type: 'text',
  autocomplete: '',
  role: '',
  contentEditable: '',
  text: 'draft',
  presentation: 'value',
  classifierVersion: 1,
};

describe('Chrome semantic source client', () => {
  it('binds a document-targeted bridge and ACKs only after receiver apply', async () => {
    const port = new FakePort();
    const connect = installBrowser(port);
    const lease = await openChromeSemanticSource(
      request,
      'isolated-html',
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    );
    const onBatch = vi.fn(() => true);
    lease.setObserver({ onBatch, onFailure: vi.fn() });

    expect(connect).toHaveBeenCalledWith(request.tabId, expect.objectContaining({
      documentId: request.documentId,
      frameId: request.frameId,
      name: `simul:semantic-source-v2:isolated-html:${request.sessionId}`,
    }));
    expect(port.messages[0]).toMatchObject({
      kind: 'simul:semantic-source-v2:start',
      bridge: 'isolated-html',
      policyFingerprint: 'read-v1-111111',
    });

    const batch = createSemanticSourceBatch(
      documentIdentity,
      'read-v1-111111',
      1,
      [record],
    );
    port.emitMessage(batch);
    expect(onBatch).toHaveBeenCalledWith(batch);
    expect(port.messages[1]).toMatchObject({
      kind: 'simul:semantic-source-v2:ack',
      sequence: 1,
    });
    lease.dispose();
  });

  it('fails closed without ACK on rejected or gapped batches', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeSemanticSource(
      request,
      'isolated-html',
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    );
    const onFailure = vi.fn();
    lease.setObserver({ onBatch: () => false, onFailure });
    port.emitMessage(createSemanticSourceBatch(
      documentIdentity,
      'read-v1-111111',
      1,
      [record],
    ));
    expect(onFailure).toHaveBeenCalledOnce();
    expect(port.messages).toHaveLength(1);
    expect(port.disconnects).toBe(1);
  });

  it('suppresses a terminal failure after the lease is explicitly disposed', async () => {
    const port = new FakePort();
    installBrowser(port);
    const lease = await openChromeSemanticSource(
      request,
      'isolated-html',
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    );
    port.emitDisconnect();
    lease.dispose();
    const onFailure = vi.fn();

    lease.setObserver({ onBatch: () => true, onFailure });

    expect(onFailure).not.toHaveBeenCalled();
  });

  // D179: a page script of a build before batches of what changed refuses a
  // start of version 3; the next start for that document asks for version 2.
  it('asks a page that let a start of version 3 go for whole states only', async () => {
    const stale = { ...request, documentId: 'semantic-client-stale-document' };
    const staleIdentity = { ...documentIdentity, documentId: stale.documentId };
    const refused = new FakePort();
    installBrowser(refused);
    const first = await openChromeSemanticSource(stale, 'isolated-html', FULL_VISIBLE_REPLICA_READ_SCOPE);
    const onFailure = vi.fn();
    first.setObserver({ onBatch: () => true, onFailure });
    expect(refused.messages[0]).toMatchObject({ protocolVersion: 3 });
    refused.emitDisconnect();
    expect(onFailure).toHaveBeenCalledOnce();

    const port = new FakePort();
    installBrowser(port);
    const second = await openChromeSemanticSource(stale, 'isolated-html', FULL_VISIBLE_REPLICA_READ_SCOPE);
    const onBatch = vi.fn(() => true);
    const secondFailure = vi.fn();
    second.setObserver({ onBatch, onFailure: secondFailure });
    expect(port.messages[0]).toMatchObject({
      kind: 'simul:semantic-source-v2:start',
      protocolVersion: 2,
    });
    const whole = createSemanticSourceBatch(
      staleIdentity, 'read-v1-111111', 1, [record], [], { protocolVersion: 2 },
    );
    port.emitMessage(whole);
    expect(onBatch).toHaveBeenCalledWith(whole);
    expect(port.messages[1]).toMatchObject({ kind: 'simul:semantic-source-v2:ack', protocolVersion: 2 });
    // A batch of what changed is not for a panel that asked for whole states.
    port.emitMessage(createSemanticSourceBatch(
      staleIdentity, 'read-v1-111111', 2, [{ ...record, nodeRevision: 2, text: 'next' }], [],
      { delta: {
        base: 1, removedRecordIds: [], removedProofIds: [], recordPlacements: [],
        proofPlacements: [], recordCount: 1, proofCount: 0,
      } },
    ));
    expect(secondFailure).toHaveBeenCalledOnce();
    expect(onBatch).toHaveBeenCalledOnce();

    // Another document still asks for version 3.
    const other = new FakePort();
    installBrowser(other);
    const third = await openChromeSemanticSource(
      { ...request, documentId: 'semantic-client-other-document' },
      'isolated-html',
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    );
    expect(other.messages[0]).toMatchObject({ protocolVersion: 3 });
    third.dispose();
  });

});

function installBrowser(port: FakePort): ReturnType<typeof vi.fn> {
  const connect = vi.fn(() => port);
  vi.stubGlobal('browser', { tabs: { connect } });
  return connect;
}

class FakePort {
  readonly messages: unknown[] = [];
  readonly #messages = new Set<(message: unknown) => void>();
  readonly #disconnects = new Set<() => void>();
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => this.#messages.add(listener),
    removeListener: (listener: (message: unknown) => void) =>
      this.#messages.delete(listener),
  };
  readonly onDisconnect = {
    addListener: (listener: () => void) => this.#disconnects.add(listener),
    removeListener: (listener: () => void) => this.#disconnects.delete(listener),
  };
  disconnects = 0;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  emitMessage(message: unknown): void {
    for (const listener of [...this.#messages]) listener(message);
  }

  emitDisconnect(): void {
    for (const listener of [...this.#disconnects]) listener();
  }
}
