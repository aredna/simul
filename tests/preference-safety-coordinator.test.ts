import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PREFERENCE_SAFETY_PORT_NAME,
  PreferenceSafetyCoordinator,
  readPreferenceSafetyJournalSnapshot,
  readPreferenceSafetyPrepareMessage,
  type PreferenceSafetyJournalAdapter,
  type PreferenceSafetyJournalSnapshot,
  type PreferenceSafetyPort,
} from '../lib/preference-safety-coordinator';
import { replicaReadScopeForProfile } from '../lib/replica/read-scope-policy';

describe('PreferenceSafetyCoordinator', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for every live panel before allowing a narrowing commit', async () => {
    const coordinator = new PreferenceSafetyCoordinator(1_000, () => 'narrow-1');
    const first = new FakeSafetyPort(true);
    const second = new FakeSafetyPort(true);
    coordinator.connect(first);
    coordinator.connect(second);

    const ticket = await coordinator.prepare(
      'read-narrow',
      replicaReadScopeForProfile('standard'),
    );
    expect(ticket).toEqual({ requestId: 'narrow-1' });
    expect(first.prepares()).toHaveLength(1);
    expect(second.prepares()).toHaveLength(1);

    await coordinator.release(ticket, true);
    expect(first.posted.at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:release',
      requestId: 'narrow-1',
      committed: true,
    });
  });

  it('fails closed on a missed ack and applies the ceiling to later panels', async () => {
    vi.useFakeTimers();
    const coordinator = new PreferenceSafetyCoordinator(25, () => 'failed-1');
    const responsive = new FakeSafetyPort(true);
    const stuck = new FakeSafetyPort(false);
    coordinator.connect(responsive);
    coordinator.connect(stuck);

    const preparation = coordinator.prepare(
      'read-narrow',
      replicaReadScopeForProfile('standard'),
    );
    const rejection = expect(preparation).rejects.toThrow(
      'preference-safety-timeout',
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(responsive.posted.at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:release',
      requestId: 'failed-1',
      committed: false,
    });

    const later = new FakeSafetyPort(true);
    coordinator.connect(later);
    later.hello('later-connection');
    await Promise.resolve();
    expect(later.prepares()).toEqual([
      expect.objectContaining({
        requestId: 'failed-1',
        targetFingerprint: 'read-v1-111000',
      }),
    ]);
    expect(later.posted).toContainEqual({
      kind: 'simul:preference-safety-v1:ready',
      version: 1,
      connectionNonce: 'later-connection',
    });

    await coordinator.observeCommittedReadScope(
      replicaReadScopeForProfile('full-visible'),
    );
    expect(later.prepares().at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:prepare',
    });
    await coordinator.observeCommittedReadScope(
      replicaReadScopeForProfile('page-only'),
    );
    expect(later.posted.at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:release',
      requestId: 'failed-1',
      committed: true,
    });
  });

  it('rejects a preparation when a pending panel disconnects', async () => {
    const coordinator = new PreferenceSafetyCoordinator(1_000, () => 'lost-1');
    const responsive = new FakeSafetyPort(true);
    const lost = new FakeSafetyPort(false);
    coordinator.connect(responsive);
    coordinator.connect(lost);

    const preparation = coordinator.prepare(
      'read-narrow',
      replicaReadScopeForProfile('standard'),
    );
    const rejection = expect(preparation).rejects.toThrow(
      'preference-safety-disconnected',
    );
    await coordinator.whenHydrated();
    await Promise.resolve();
    lost.disconnect();
    await rejection;

    expect(responsive.posted.at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:release',
      requestId: 'lost-1',
      committed: false,
    });
  });

  it('replays a failed ceiling after a service-worker restart before ready', async () => {
    vi.useFakeTimers();
    const journal = new MemorySafetyJournal();
    const first = new PreferenceSafetyCoordinator(
      25,
      () => 'restart-ceiling',
      journal,
    );
    const stuck = new FakeSafetyPort(false);
    first.connect(stuck);

    const preparation = first.prepare(
      'read-narrow',
      replicaReadScopeForProfile('standard'),
    );
    const rejection = preparation.catch((error: unknown) => error);
    await first.whenHydrated();
    for (let turn = 0; turn < 10 && stuck.prepares().length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(stuck.prepares()).toHaveLength(1);
    await first.observeCommittedReadScope(
      replicaReadScopeForProfile('standard'),
    );
    expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([
      expect.objectContaining({ requestId: 'restart-ceiling' }),
    ]);
    await vi.advanceTimersByTimeAsync(25);
    await expect(rejection).resolves.toMatchObject({
      message: 'preference-safety-timeout',
    });
    expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([
      expect.objectContaining({ requestId: 'restart-ceiling' }),
    ]);

    const restarted = new PreferenceSafetyCoordinator(
      1_000,
      () => 'unused',
      journal,
    );
    const later = new FakeSafetyPort(true);
    restarted.connect(later);
    later.hello('after-restart');
    await restarted.whenHydrated();
    await Promise.resolve();

    expect(later.prepares()).toEqual([
      expect.objectContaining({
        requestId: 'restart-ceiling',
        targetFingerprint: 'read-v1-111000',
      }),
    ]);
    expect(later.posted.at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:ready',
      connectionNonce: 'after-restart',
    });

    await restarted.observeCommittedReadScope(
      replicaReadScopeForProfile('page-only'),
    );
    expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([]);
  });

  it('fails closed to Page-only when a stored journal is malformed', async () => {
    const journal = new MemorySafetyJournal({ unsafe: 'unknown ceiling' });
    const coordinator = new PreferenceSafetyCoordinator(
      1_000,
      () => 'unused',
      journal,
    );
    const port = new FakeSafetyPort(true);
    coordinator.connect(port);
    port.hello('corrupt-journal');
    await coordinator.whenHydrated();
    await Promise.resolve();

    expect(port.prepares()).toEqual([
      expect.objectContaining({
        requestId: 'journal-recovery-page-only',
        operation: 'reset',
        targetFingerprint: 'read-v1-000000',
      }),
    ]);
    expect(port.posted.at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:ready',
      connectionNonce: 'corrupt-journal',
    });
  });

  it('fails closed to Page-only when the journal key is absent on restart', async () => {
    const journal = new MemorySafetyJournal();
    journal.value = undefined;
    const coordinator = new PreferenceSafetyCoordinator(
      1_000,
      () => 'unused',
      journal,
    );
    const port = new FakeSafetyPort(true);
    coordinator.connect(port);
    port.hello('missing-journal');
    await coordinator.whenHydrated();
    await Promise.resolve();

    expect(port.prepares()).toContainEqual(expect.objectContaining({
      requestId: 'journal-recovery-page-only',
      operation: 'reset',
      targetFingerprint: 'read-v1-000000',
    }));
    expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([
      expect.objectContaining({ requestId: 'journal-recovery-page-only' }),
    ]);

    await coordinator.observeCommittedReadScope(
      replicaReadScopeForProfile('standard'),
    );
    expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([
      expect.objectContaining({ requestId: 'journal-recovery-page-only' }),
    ]);

    const restarted = new PreferenceSafetyCoordinator(
      1_000,
      () => 'unused-after-missing',
      journal,
    );
    const afterRestart = new FakeSafetyPort(true);
    restarted.connect(afterRestart);
    afterRestart.hello('missing-after-restart');
    await restarted.whenHydrated();
    await Promise.resolve();
    expect(afterRestart.prepares()).toContainEqual(expect.objectContaining({
      requestId: 'journal-recovery-page-only',
      targetFingerprint: 'read-v1-000000',
    }));
  });

  it.each([
    ['deleted', undefined],
    ['malformed', { unsafe: 'unknown ceiling' }],
    ['equivocated', journalSnapshot([])],
  ])(
    'installs and persists Page-only recovery when a live journal is %s',
    async (_case, replacement) => {
      const storedCeiling = readPreferenceSafetyPrepareMessage({
        kind: 'simul:preference-safety-v1:prepare',
        version: 1,
        requestId: 'stored-standard-ceiling',
        operation: 'read-narrow',
        targetReadScope: replicaReadScopeForProfile('standard'),
        targetFingerprint: 'read-v1-111000',
      })!;
      const journal = new MemorySafetyJournal(journalSnapshot([storedCeiling]));
      const coordinator = new PreferenceSafetyCoordinator(
        1_000,
        () => 'unused',
        journal,
      );
      const live = new FakeSafetyPort(true);
      coordinator.connect(live);
      live.hello('live-corruption');
      await coordinator.whenHydrated();
      await Promise.resolve();
      live.posted.length = 0;

      journal.value = replacement;
      await expect(
        coordinator.observeJournalStorageChange(replacement),
      ).resolves.toBe('recovered');

      expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([
        expect.objectContaining({ requestId: 'stored-standard-ceiling' }),
        expect.objectContaining({
          requestId: 'journal-recovery-page-only',
          operation: 'reset',
          targetFingerprint: 'read-v1-000000',
        }),
      ]);
      expect(live.prepares()).toContainEqual(expect.objectContaining({
        requestId: 'journal-recovery-page-only',
        targetFingerprint: 'read-v1-000000',
      }));

      const restarted = new PreferenceSafetyCoordinator(
        1_000,
        () => 'unused-after-restart',
        journal,
      );
      const afterRestart = new FakeSafetyPort(true);
      restarted.connect(afterRestart);
      afterRestart.hello('after-live-corruption');
      await restarted.whenHydrated();
      await Promise.resolve();
      expect(afterRestart.prepares()).toContainEqual(expect.objectContaining({
        requestId: 'journal-recovery-page-only',
        targetFingerprint: 'read-v1-000000',
      }));
    },
  );

  it('accepts a delayed notification from an earlier serialized write', async () => {
    const journal = new MemorySafetyJournal();
    const coordinator = new PreferenceSafetyCoordinator(
      1_000,
      () => 'legitimate-write',
      journal,
    );
    const port = new FakeSafetyPort(true);
    coordinator.connect(port);
    const ticket = await coordinator.prepare(
      'read-narrow',
      replicaReadScopeForProfile('standard'),
    );
    const earlierWrite = structuredClone(journal.value);
    await coordinator.release(ticket, true);
    expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([]);

    await expect(
      coordinator.observeJournalStorageChange(earlierWrite),
    ).resolves.toBe('current');
    expect(readPreferenceSafetyJournalSnapshot(journal.value)).toEqual([]);
  });

  it('does not send ready or purge until durable journal state is loaded/saved', async () => {
    const load = deferred<unknown>();
    const save = deferred<void>();
    const journal: PreferenceSafetyJournalAdapter = {
      load: () => load.promise,
      save: () => save.promise,
    };
    const coordinator = new PreferenceSafetyCoordinator(
      1_000,
      () => 'durable-first',
      journal,
    );
    const port = new FakeSafetyPort(true);
    coordinator.connect(port);
    port.hello('waiting-for-journal');
    await Promise.resolve();
    expect(port.posted).toEqual([]);

    load.resolve(undefined);
    await Promise.resolve();
    expect(port.posted).toEqual([]);
    save.resolve();
    await coordinator.whenHydrated();
    await Promise.resolve();
    expect(port.prepares()).toContainEqual(expect.objectContaining({
      requestId: 'journal-recovery-page-only',
      targetFingerprint: 'read-v1-000000',
    }));
    expect(port.posted.at(-1)).toMatchObject({
      kind: 'simul:preference-safety-v1:ready',
    });

    const preparation = coordinator.prepare(
      'read-narrow',
      replicaReadScopeForProfile('standard'),
    );
    const ticket = await preparation;
    expect(ticket).toEqual({ requestId: 'durable-first' });
    await coordinator.release(ticket, false);
  });

  it('rejects forged or content-bearing prepare payloads', () => {
    const valid = {
      kind: 'simul:preference-safety-v1:prepare',
      version: 1,
      requestId: 'safe-1',
      operation: 'reset',
      targetReadScope: replicaReadScopeForProfile('page-only'),
      targetFingerprint: 'read-v1-000000',
    };
    expect(readPreferenceSafetyPrepareMessage(valid)).toBeDefined();
    expect(readPreferenceSafetyPrepareMessage({
      ...valid,
      sourceText: 'must not cross the barrier',
    })).toBeUndefined();
    expect(readPreferenceSafetyPrepareMessage({
      ...valid,
      targetFingerprint: 'read-v1-111111',
    })).toBeUndefined();
  });
});

class FakeSafetyPort implements PreferenceSafetyPort {
  readonly name = PREFERENCE_SAFETY_PORT_NAME;
  readonly posted: unknown[] = [];
  readonly #message = new FakeEvent<(message: unknown) => void>();
  readonly #disconnect = new FakeEvent<() => void>();
  readonly onMessage = this.#message.api;
  readonly onDisconnect = this.#disconnect.api;

  constructor(private readonly autoAck: boolean) {}

  postMessage(message: unknown): void {
    this.posted.push(message);
    const prepare = readPreferenceSafetyPrepareMessage(message);
    if (prepare && this.autoAck) {
      this.#message.emit({
        kind: 'simul:preference-safety-v1:ack',
        version: 1,
        requestId: prepare.requestId,
      });
    }
  }

  prepares(): unknown[] {
    return this.posted.filter((message) =>
      readPreferenceSafetyPrepareMessage(message) !== undefined
    );
  }

  hello(connectionNonce: string): void {
    this.#message.emit({
      kind: 'simul:preference-safety-v1:hello',
      version: 1,
      connectionNonce,
    });
  }

  disconnect(): void {
    this.#disconnect.emit();
  }
}

class MemorySafetyJournal implements PreferenceSafetyJournalAdapter {
  value: unknown;

  constructor(value: unknown = journalSnapshot([])) {
    this.value = value;
  }

  async load(): Promise<unknown> {
    return this.value;
  }

  async save(snapshot: PreferenceSafetyJournalSnapshot): Promise<void> {
    this.value = structuredClone(snapshot);
  }
}

function journalSnapshot(
  ceilings: PreferenceSafetyJournalSnapshot['ceilings'],
): PreferenceSafetyJournalSnapshot {
  return {
    kind: 'simul:preference-safety-ceilings-v1',
    version: 1,
    ceilings,
  };
}

class FakeEvent<T extends (...args: never[]) => void> {
  readonly #listeners = new Set<T>();
  readonly api = {
    addListener: (listener: T) => this.#listeners.add(listener),
    removeListener: (listener: T) => this.#listeners.delete(listener),
  };

  emit(...args: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...args);
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}
