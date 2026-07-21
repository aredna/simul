import { describe, expect, it, vi } from 'vitest';

import type {
  ReplicaSourceDocumentIdentity,
  ReplicaSourceTextRecord,
} from '../lib/replica/source-value-model';
import {
  ReplicaTranslationCoordinator,
  isCompleteReplicaTranslationResult,
  type ReplicaProjectionContext,
  type ReplicaTextProjection,
  type ReplicaTranslationSnapshot,
  type ReplicaTranslationSurface,
} from '../lib/translation/replica-translation-coordinator';
import type {
  TranslationPair,
  TranslationProvider,
  TranslationSession,
} from '../lib/translation-provider';

const documentIdentity: ReplicaSourceDocumentIdentity = {
  sessionId: 'session-translation',
  pageEpoch: 2,
  generation: 2,
  documentId: 'document-translation',
  frameId: 0,
};
const pair: TranslationPair = { sourceLanguage: 'es', targetLanguage: 'en' };

describe('ReplicaTranslationCoordinator', () => {
  it.each(['failed', 'stale', 'skipped', 'overflow'] as const)(
    'does not classify a run with %s work as complete',
    (field) => {
      const result = {
        translationEpoch: 1,
        total: 2,
        completed: 1,
        failed: 0,
        stale: 0,
        skipped: 0,
        overflow: 0,
        [field]: 1,
      };

      expect(isCompleteReplicaTranslationResult(result)).toBe(false);
    },
  );

  it('translates sequentially, deduplicates exact text, and retains one session', async () => {
    const surface = new FakeSurface([
      record(4, 1, 'Hola'),
      record(5, 1, 'Hola'),
      record(6, 1, 'Mundo'),
    ]);
    let concurrent = 0;
    let maximumConcurrent = 0;
    const translate = vi.fn(async (source: string) => {
      concurrent += 1;
      maximumConcurrent = Math.max(maximumConcurrent, concurrent);
      await Promise.resolve();
      concurrent -= 1;
      return `en:${source}`;
    });
    const { provider, destroy } = fakeProvider(translate);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);

    const first = await coordinator.translateCurrent(pair);
    surface.projections.length = 0;
    const second = await coordinator.translateCurrent(pair);

    expect(first).toMatchObject({ completed: 3, failed: 0 });
    expect(second).toMatchObject({ completed: 3, failed: 0 });
    expect(translate.mock.calls.map(([source]) => source)).toEqual(['Hola', 'Mundo']);
    expect(maximumConcurrent).toBe(1);
    expect(provider.createSession).toHaveBeenCalledOnce();
    expect(surface.projections).toHaveLength(3);
    expect(destroy).not.toHaveBeenCalled();
  });

  it('rejects a late result after source revision changes', async () => {
    let resolve!: (value: string) => void;
    const { provider } = fakeProvider(
      () => new Promise<string>((done) => {
        resolve = done;
      }),
    );
    const surface = new FakeSurface([record(4, 1, 'Hola')]);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);

    const translating = coordinator.translateCurrent(pair);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    surface.records = [record(4, 2, 'Adiós')];
    resolve('Hello');

    await expect(translating).resolves.toMatchObject({ completed: 0, stale: 1 });
    expect(surface.projections).toEqual([]);
  });

  it('rejects run results with stale document, pair, epoch, or lease identity', async () => {
    const surface = new FakeSurface([record(4, 1, 'Hola')]);
    const { provider } = fakeProvider(async () => 'Hello');
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);
    const result = await coordinator.translateCurrent(pair);
    expect(coordinator.isResultCurrent(result)).toBe(true);

    expect(coordinator.isResultCurrent({
      ...result,
      pairKey: 'es>ja',
    })).toBe(false);
    expect(coordinator.isResultCurrent({
      ...result,
      translationEpoch: result.translationEpoch + 1,
    })).toBe(false);
    expect(coordinator.isResultCurrent({
      ...result,
      replayLease: (result.replayLease ?? 0) + 1,
    })).toBe(false);
    expect(coordinator.isResultCurrent({
      ...result,
      document: { ...documentIdentity, documentId: 'other-document' },
    })).toBe(false);
  });

  it('restores source and destroys the retained session when projection is disabled', async () => {
    const surface = new FakeSurface([record(4, 1, 'Hola')]);
    const { provider, destroy } = fakeProvider(async (source) => `en:${source}`);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);
    await coordinator.translateCurrent(pair);

    coordinator.selectPair(undefined);

    expect(destroy).toHaveBeenCalledOnce();
    expect(surface.contexts.at(-1)).toMatchObject({ pairKey: undefined });
    expect(surface.projections).toHaveLength(1);
  });

  it('translates only committed changed revisions and reuses cache on recovery', async () => {
    const surface = new FakeSurface([record(4, 1, 'Hola')]);
    const translate = vi.fn(async (source: string) => `en:${source}`);
    const { provider } = fakeProvider(translate);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);
    await coordinator.translateCurrent(pair);
    surface.projections.length = 0;

    surface.lease = 2;
    coordinator.handleSourceCommit({
      document: documentIdentity,
      documentLanguageChanged: false,
      replayLease: 2,
      records: surface.records,
      changes: [{ kind: 'upsert', record: surface.records[0] as ReplicaSourceTextRecord }],
      reason: 'recovery',
    });
    await vi.waitFor(() => expect(surface.projections).toHaveLength(1));

    expect(translate).toHaveBeenCalledOnce();
    expect(surface.projections[0]).toMatchObject({ replayLease: 2, translated: 'en:Hola' });
  });

  it('does not reuse an obsolete page translation after navigation', async () => {
    const surface = new FakeSurface([record(4, 1, 'Inicio')]);
    const translate = vi.fn(async (source: string) =>
      `${surface.document.documentId}:${source}`);
    const { provider } = fakeProvider(translate);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);

    await coordinator.translateCurrent(pair);

    const nextDocument = {
      ...documentIdentity,
      pageEpoch: documentIdentity.pageEpoch + 1,
      generation: documentIdentity.generation + 1,
      documentId: 'next-document',
    };
    surface.document = nextDocument;
    surface.lease = 2;
    surface.records = [record(4, 1, 'Inicio', nextDocument)];
    surface.projections.length = 0;

    await coordinator.translateCurrent(pair);

    expect(translate).toHaveBeenCalledTimes(2);
    expect(surface.projections).toEqual([
      expect.objectContaining({
        document: nextDocument,
        translated: 'next-document:Inicio',
      }),
    ]);
  });

  it('reuses translation memory across a rebuild of the same source document', async () => {
    const surface = new FakeSurface([record(4, 1, 'Inicio')]);
    const translate = vi.fn(async (source: string) => `en:${source}`);
    const { provider } = fakeProvider(translate);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);

    await coordinator.translateCurrent(pair);

    const rebuiltIdentity = {
      ...documentIdentity,
      pageEpoch: documentIdentity.pageEpoch + 1,
      generation: documentIdentity.generation + 1,
    };
    surface.document = rebuiltIdentity;
    surface.lease = 2;
    surface.records = [record(4, 1, 'Inicio', rebuiltIdentity)];
    surface.projections.length = 0;

    await coordinator.translateCurrent(pair);

    expect(translate).toHaveBeenCalledOnce();
    expect(surface.projections).toEqual([
      expect.objectContaining({
        document: rebuiltIdentity,
        translated: 'en:Inicio',
      }),
    ]);
  });

  it('never sends whitespace-only or removed values to the provider', async () => {
    const surface = new FakeSurface([
      record(4, 1, '   '),
      record(5, 1, 'Visible'),
    ]);
    const translate = vi.fn(async (source: string) => `en:${source}`);
    const { provider } = fakeProvider(translate);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);

    await coordinator.translateCurrent(pair);
    coordinator.handleSourceCommit({
      document: documentIdentity,
      documentLanguageChanged: false,
      replayLease: 1,
      records: surface.records,
      changes: [
        { kind: 'remove', document: documentIdentity, nodeId: 5, revision: 2 },
      ],
      reason: 'batch',
    });

    expect(translate).toHaveBeenCalledOnce();
    expect(translate).toHaveBeenCalledWith('Visible', expect.anything());
  });

  it('preserves exact boundary whitespace while translating only the text core', async () => {
    const source = '\n\u00a0Hola \u00a0';
    const surface = new FakeSurface([record(4, 1, source)]);
    const translate = vi.fn(async () => '  Hello  ');
    const { provider } = fakeProvider(translate);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);

    await coordinator.translateCurrent(pair);

    expect(translate).toHaveBeenCalledWith('Hola', expect.anything());
    expect(surface.projections[0]?.translated).toBe('\n\u00a0Hello \u00a0');
  });

  it('reuses one core translation across records with different boundary whitespace', async () => {
    const surface = new FakeSurface([
      record(4, 1, '  Hola\n'),
      record(5, 1, '\tHola\u00a0'),
    ]);
    const translate = vi.fn(async () => 'Hello');
    const { provider } = fakeProvider(translate);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);

    await coordinator.translateCurrent(pair);

    expect(translate).toHaveBeenCalledOnce();
    expect(surface.projections.map(({ translated }) => translated)).toEqual([
      '  Hello\n',
      '\tHello\u00a0',
    ]);
  });

  it('combines pair and caller cancellation while creating the retained session', async () => {
    let creationSignal: AbortSignal | undefined;
    const provider: TranslationProvider = {
      availability: async () => 'available',
      createSession: vi.fn((_pair, options) => {
        creationSignal = options?.signal;
        return new Promise<TranslationSession>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }),
    };
    const controller = new AbortController();
    const coordinator = new ReplicaTranslationCoordinator(
      provider,
      new FakeSurface([record(4, 1, 'Hola')]),
    );

    const translating = coordinator.translateCurrent(pair, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(creationSignal).toBeDefined());
    controller.abort();

    await expect(translating).rejects.toMatchObject({ name: 'AbortError' });
    expect(creationSignal?.aborted).toBe(true);
  });

  it('aborts retained-session creation when source-only clears the pair', async () => {
    let creationSignal: AbortSignal | undefined;
    const provider: TranslationProvider = {
      availability: async () => 'available',
      createSession: vi.fn((_pair, options) => {
        creationSignal = options?.signal;
        return new Promise<TranslationSession>((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        });
      }),
    };
    const coordinator = new ReplicaTranslationCoordinator(
      provider,
      new FakeSurface([record(4, 1, 'Hola')]),
    );
    const translating = coordinator.translateCurrent(pair);
    await vi.waitFor(() => expect(creationSignal).toBeDefined());

    coordinator.selectPair(undefined);

    await expect(translating).rejects.toMatchObject({ name: 'AbortError' });
    expect(creationSignal?.aborted).toBe(true);
  });

  it('propagates caller cancellation during node translation', async () => {
    const translate = vi.fn(
      (_source: string, signal?: AbortSignal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const { provider } = fakeProvider(translate);
    const surface = new FakeSurface([record(4, 1, 'Hola')]);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);
    const controller = new AbortController();

    const translating = coordinator.translateCurrent(pair, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    controller.abort();

    await expect(translating).rejects.toMatchObject({ name: 'AbortError' });
    expect(surface.projections).toEqual([]);
  });

  it('reports initial job and character limit omissions as overflow', async () => {
    const surface = new FakeSurface([
      record(4, 1, '1234'),
      record(5, 1, '56'),
      record(6, 1, 'a'),
    ]);
    const { provider } = fakeProvider(async (source) => `en:${source}`);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface, {
      maxPendingJobs: 2,
      maxPendingCharacters: 5,
    });

    const result = await coordinator.translateCurrent(pair);

    expect(result).toMatchObject({
      total: 3,
      completed: 2,
      failed: 0,
      stale: 0,
      skipped: 0,
      overflow: 1,
    });
    expect(isCompleteReplicaTranslationResult(result)).toBe(false);
    expect(surface.projections.map(({ nodeId }) => nodeId)).toEqual([4, 6]);
  });

  it('reports initial candidates omitted by the pending-job limit', async () => {
    const surface = new FakeSurface([
      record(4, 1, 'Uno'),
      record(5, 1, 'Dos'),
      record(6, 1, 'Tres'),
    ]);
    const { provider } = fakeProvider(async (source) => `en:${source}`);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface, {
      maxPendingJobs: 2,
      maxPendingCharacters: 100,
    });

    await expect(coordinator.translateCurrent(pair)).resolves.toMatchObject({
      total: 3,
      completed: 2,
      overflow: 1,
    });
  });

  it('reports live jobs evicted by the bounded lane exactly once per drain', async () => {
    const surface = new FakeSurface([record(4, 1, 'Seed')]);
    const translate = vi.fn(async (source: string) => `en:${source}`);
    const { provider } = fakeProvider(translate);
    const onBackgroundResult = vi.fn();
    const coordinator = new ReplicaTranslationCoordinator(provider, surface, {
      maxPendingJobs: 2,
      maxPendingCharacters: 100,
      onBackgroundResult,
    });
    await coordinator.translateCurrent(pair);
    surface.projections.length = 0;
    surface.records = [
      record(10, 1, 'Uno'),
      record(11, 1, 'Dos'),
      record(12, 1, 'Tres'),
    ];

    coordinator.handleSourceCommit(commitFor(surface));

    await vi.waitFor(() => expect(onBackgroundResult).toHaveBeenCalledOnce());
    expect(onBackgroundResult).toHaveBeenCalledWith(expect.objectContaining({
      total: 3,
      completed: 2,
      overflow: 1,
    }));
    expect(surface.projections.map(({ nodeId }) => nodeId)).toEqual([11, 12]);
  });

  it('reports live jobs evicted by the pending-character limit', async () => {
    const surface = new FakeSurface([record(4, 1, 'Seed')]);
    const { provider } = fakeProvider(async (source) => `en:${source}`);
    const onBackgroundResult = vi.fn();
    const coordinator = new ReplicaTranslationCoordinator(provider, surface, {
      maxPendingJobs: 10,
      maxPendingCharacters: 5,
      onBackgroundResult,
    });
    await coordinator.translateCurrent(pair);
    surface.projections.length = 0;
    surface.records = [
      record(10, 1, '1234'),
      record(11, 1, '56'),
      record(12, 1, 'a'),
    ];

    coordinator.handleSourceCommit(commitFor(surface));

    await vi.waitFor(() => expect(onBackgroundResult).toHaveBeenCalledOnce());
    expect(onBackgroundResult).toHaveBeenCalledWith(expect.objectContaining({
      total: 3,
      completed: 2,
      overflow: 1,
    }));
    expect(surface.projections.map(({ nodeId }) => nodeId)).toEqual([11, 12]);
  });

  it('deduplicates background completion and rejects an obsolete drain callback', async () => {
    let resolveLive!: (value: string) => void;
    const translate = vi.fn((source: string) =>
      source === 'Seed'
        ? Promise.resolve('en:Seed')
        : new Promise<string>((resolve) => {
          resolveLive = resolve;
        }));
    const { provider } = fakeProvider(translate);
    const surface = new FakeSurface([record(4, 1, 'Seed')]);
    const onBackgroundResult = vi.fn();
    const coordinator = new ReplicaTranslationCoordinator(provider, surface, {
      onBackgroundResult,
    });
    await coordinator.translateCurrent(pair);
    surface.records = [record(10, 1, 'Uno')];
    coordinator.handleSourceCommit(commitFor(surface));
    await vi.waitFor(() => expect(resolveLive).toBeTypeOf('function'));

    surface.records = [record(10, 1, 'Uno'), record(11, 1, 'Dos')];
    coordinator.handleSourceCommit(commitFor(surface, [surface.records[1] as ReplicaSourceTextRecord]));
    surface.lease = 2;
    resolveLive('en:Uno');

    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(onBackgroundResult).not.toHaveBeenCalled();
  });

  it('notifies once when multiple commits join one background drain', async () => {
    let resolveFirst!: (value: string) => void;
    const translate = vi.fn((source: string) => {
      if (source === 'Seed' || source === 'Dos') {
        return Promise.resolve(`en:${source}`);
      }
      return new Promise<string>((resolve) => {
        resolveFirst = resolve;
      });
    });
    const { provider } = fakeProvider(translate);
    const surface = new FakeSurface([record(4, 1, 'Seed')]);
    const onBackgroundResult = vi.fn();
    const coordinator = new ReplicaTranslationCoordinator(provider, surface, {
      onBackgroundResult,
    });
    await coordinator.translateCurrent(pair);
    surface.records = [record(10, 1, 'Uno')];
    coordinator.handleSourceCommit(commitFor(surface));
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    surface.records = [record(10, 1, 'Uno'), record(11, 1, 'Dos')];
    coordinator.handleSourceCommit(
      commitFor(surface, [surface.records[1] as ReplicaSourceTextRecord]),
    );

    resolveFirst('en:Uno');

    await vi.waitFor(() => expect(onBackgroundResult).toHaveBeenCalledOnce());
    expect(onBackgroundResult).toHaveBeenCalledWith(expect.objectContaining({
      total: 2,
      completed: 2,
    }));
  });

  it('waits for a background drain before giving a user run its own progress', async () => {
    let resolveLive!: (value: string) => void;
    const translate = vi.fn((source: string) =>
      source === 'Seed'
        ? Promise.resolve('en:Seed')
        : new Promise<string>((resolve) => {
          resolveLive = resolve;
        }));
    const { provider } = fakeProvider(translate);
    const surface = new FakeSurface([record(4, 1, 'Seed')]);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);
    await coordinator.translateCurrent(pair);
    surface.records = [record(10, 1, 'Uno')];
    coordinator.handleSourceCommit(commitFor(surface));
    await vi.waitFor(() => expect(resolveLive).toBeTypeOf('function'));
    const onProgress = vi.fn();

    const requested = coordinator.translateCurrent(pair, { onProgress });
    expect(onProgress).not.toHaveBeenCalled();
    resolveLive('en:Uno');

    await expect(requested).resolves.toMatchObject({
      total: 1,
      completed: 1,
      failed: 0,
    });
    expect(onProgress).toHaveBeenLastCalledWith(1, 1);
  });

  it('lets a new caller retry after a previous caller-owned abort', async () => {
    let attempt = 0;
    const translate = vi.fn((_source: string, signal?: AbortSignal) => {
      attempt += 1;
      if (attempt > 1) return Promise.resolve('Hello');
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const { provider } = fakeProvider(translate);
    const surface = new FakeSurface([record(4, 1, 'Hola')]);
    const coordinator = new ReplicaTranslationCoordinator(provider, surface);
    const oldController = new AbortController();
    const old = coordinator.translateCurrent(pair, {
      signal: oldController.signal,
    });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledOnce());
    const current = coordinator.translateCurrent(pair);

    oldController.abort();

    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await expect(current).resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(translate).toHaveBeenCalledTimes(2);
  });
});

class FakeSurface implements ReplicaTranslationSurface {
  lease = 1;
  document = documentIdentity;
  records: ReplicaSourceTextRecord[];
  readonly contexts: ReplicaProjectionContext[] = [];
  readonly projections: ReplicaTextProjection[] = [];
  #context: ReplicaProjectionContext = { translationEpoch: 0, pairKey: undefined };

  constructor(records: ReplicaSourceTextRecord[]) {
    this.records = records;
  }

  beginProjection(context: ReplicaProjectionContext): void {
    this.#context = context;
    this.contexts.push(context);
  }

  snapshot(): ReplicaTranslationSnapshot {
    return {
      document: this.document,
      replayLease: this.lease,
      records: this.records,
    };
  }

  project(projection: ReplicaTextProjection): boolean {
    const current = this.records.find(({ nodeId }) => nodeId === projection.nodeId);
    if (
      projection.replayLease !== this.lease ||
      projection.translationEpoch !== this.#context.translationEpoch ||
      projection.pairKey !== this.#context.pairKey ||
      current?.revision !== projection.sourceRevision ||
      current.source !== projection.source
    ) return false;
    this.projections.push(projection);
    return true;
  }
}

function commitFor(
  surface: FakeSurface,
  changedRecords: readonly ReplicaSourceTextRecord[] = surface.records,
) {
  return {
    document: surface.document,
    documentLanguageChanged: false,
    replayLease: surface.lease,
    records: surface.records,
    changes: changedRecords.map((changed) => ({
      kind: 'upsert' as const,
      record: changed,
    })),
    reason: 'batch' as const,
  };
}

function record(
  nodeId: number,
  revision: number,
  source: string,
  document: ReplicaSourceDocumentIdentity = documentIdentity,
): ReplicaSourceTextRecord {
  return {
    document,
    nodeId,
    nodeType: 3,
    revision,
    source,
  };
}

function fakeProvider(
  translate: (source: string, signal?: AbortSignal) => Promise<string>,
): {
  provider: TranslationProvider & { createSession: ReturnType<typeof vi.fn> };
  destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn();
  const session: TranslationSession = { translate, destroy };
  const createSession = vi.fn(async () => session);
  return {
    provider: {
      availability: async () => 'available',
      createSession,
    },
    destroy,
  };
}
