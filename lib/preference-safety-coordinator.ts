import {
  PAGE_ONLY_REPLICA_READ_SCOPE,
  readExactReplicaReadScope,
  replicaReadScopeFingerprint,
  type ReplicaReadScope,
} from './replica/read-scope-policy';

export const PREFERENCE_SAFETY_PORT_NAME = 'simul:preference-safety-v1';
export const PREFERENCE_SAFETY_PROTOCOL_VERSION = 1;
export const PREFERENCE_SAFETY_JOURNAL_STORAGE_KEY =
  'simul.preferenceSafetyCeilings.v1';

const PREFERENCE_SAFETY_JOURNAL_KIND =
  'simul:preference-safety-ceilings-v1' as const;
const RECOVERY_CEILING_REQUEST_ID = 'journal-recovery-page-only';
const MAX_JOURNALED_CEILINGS = 64;

export type PreferenceSafetyOperation = 'read-narrow' | 'reset';

export interface PreferenceSafetyPrepareMessage {
  readonly kind: 'simul:preference-safety-v1:prepare';
  readonly version: 1;
  readonly requestId: string;
  readonly operation: PreferenceSafetyOperation;
  readonly targetReadScope: ReplicaReadScope;
  readonly targetFingerprint: string;
}

export interface PreferenceSafetyAckMessage {
  readonly kind: 'simul:preference-safety-v1:ack';
  readonly version: 1;
  readonly requestId: string;
}

export interface PreferenceSafetyReleaseMessage {
  readonly kind: 'simul:preference-safety-v1:release';
  readonly version: 1;
  readonly requestId: string;
  readonly committed: boolean;
}

export interface PreferenceSafetyHelloMessage {
  readonly kind: 'simul:preference-safety-v1:hello';
  readonly version: 1;
  readonly connectionNonce: string;
}

export interface PreferenceSafetyReadyMessage {
  readonly kind: 'simul:preference-safety-v1:ready';
  readonly version: 1;
  readonly connectionNonce: string;
}

export interface PreferenceSafetyPort {
  readonly name: string;
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
  postMessage(message: unknown): void;
}

export interface PreferenceSafetyTicket {
  readonly requestId: string;
}

export interface PreferenceSafetyJournalSnapshot {
  readonly kind: typeof PREFERENCE_SAFETY_JOURNAL_KIND;
  readonly version: 1;
  readonly ceilings: readonly PreferenceSafetyPrepareMessage[];
}

export interface PreferenceSafetyJournalAdapter {
  load(): Promise<unknown>;
  save(snapshot: PreferenceSafetyJournalSnapshot): Promise<void>;
}

export type PreferenceSafetyJournalObservation = 'current' | 'recovered';

interface ActivePreparation {
  readonly message: PreferenceSafetyPrepareMessage;
  readonly pending: Set<PreferenceSafetyPort>;
  readonly ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  timeout: ReturnType<typeof setTimeout> | undefined;
  settled: boolean;
}

interface PortListeners {
  readonly message: (message: unknown) => void;
  readonly disconnect: () => void;
}

/**
 * A background-owned, content-free barrier for source-derived memory. Every
 * connected companion must acknowledge its purge before a narrowing/reset is
 * allowed to reach durable storage.
 */
export class PreferenceSafetyCoordinator {
  readonly #ports = new Set<PreferenceSafetyPort>();
  readonly #listeners = new Map<PreferenceSafetyPort, PortListeners>();
  readonly #unresolvedCeilings =
    new Map<string, PreferenceSafetyPrepareMessage>();
  readonly #helloNonces = new Map<PreferenceSafetyPort, string>();
  readonly #hydration: Promise<void>;
  #journalWrites: Promise<void> = Promise.resolve();
  #journalObservations: Promise<void> = Promise.resolve();
  #active: ActivePreparation | undefined;

  constructor(
    private readonly timeoutMs = 2_000,
    private readonly createRequestId: () => string = () => crypto.randomUUID(),
    private readonly journal?: PreferenceSafetyJournalAdapter,
  ) {
    this.#hydration = this.hydrateJournal();
  }

  whenHydrated(): Promise<void> {
    return this.#hydration;
  }

  /**
   * Reconcile a live storage notification against the coordinator's exact
   * content-free ceiling set. Missing/malformed/rolled-back state is never a
   * new first-run state: it installs a durable Page-only recovery ceiling.
   */
  observeJournalStorageChange(
    value: unknown,
  ): Promise<PreferenceSafetyJournalObservation> {
    const observation = this.#journalObservations.then(
      () => this.reconcileJournalStorageChange(value),
      () => this.reconcileJournalStorageChange(value),
    );
    this.#journalObservations = observation.then(
      () => undefined,
      () => undefined,
    );
    return observation;
  }

  connect(port: PreferenceSafetyPort): boolean {
    if (port.name !== PREFERENCE_SAFETY_PORT_NAME || this.#ports.has(port)) {
      return false;
    }
    const listeners: PortListeners = {
      message: (message) => this.receive(port, message),
      disconnect: () => this.disconnect(port),
    };
    this.#ports.add(port);
    this.#listeners.set(port, listeners);
    port.onMessage.addListener(listeners.message);
    port.onDisconnect.addListener(listeners.disconnect);

    // A panel opened while a commit owns the global lock must purge before it
    // can initialize against the pre-commit snapshot. It remains pending until
    // its hello proves the message listener is installed and it ACKs the purge.
    if (this.#active) {
      if (!this.#active.settled) this.#active.pending.add(port);
    }
    return true;
  }

  async prepare(
    operation: PreferenceSafetyOperation,
    targetReadScope: ReplicaReadScope,
  ): Promise<PreferenceSafetyTicket> {
    await this.#hydration;
    if (this.#active) throw new Error('preference-safety-busy');
    const scope = readExactReplicaReadScope(targetReadScope);
    if (!scope) throw new Error('preference-safety-invalid-scope');
    if (this.#unresolvedCeilings.size >= MAX_JOURNALED_CEILINGS) {
      throw new Error('preference-safety-journal-capacity');
    }
    const requestId = this.createRequestId();
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const message: PreferenceSafetyPrepareMessage = {
      kind: 'simul:preference-safety-v1:prepare',
      version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
      requestId,
      operation,
      targetReadScope: scope,
      targetFingerprint: replicaReadScopeFingerprint(scope),
    };
    this.#unresolvedCeilings.set(requestId, message);
    try {
      await this.persistJournal();
    } catch {
      this.#unresolvedCeilings.delete(requestId);
      throw new Error('preference-safety-journal-unavailable');
    }
    const active: ActivePreparation = {
      message,
      pending: new Set(this.#ports),
      ready,
      resolveReady,
      rejectReady,
      timeout: undefined,
      settled: false,
    };
    this.#active = active;
    active.timeout = setTimeout(() => {
      if (active.settled) return;
      active.settled = true;
      active.rejectReady(new Error('preference-safety-timeout'));
    }, this.timeoutMs);
    for (const port of [...active.pending]) this.postPrepare(port, active);
    this.finishReadyWhenEmpty(active);

    try {
      await active.ready;
      return { requestId };
    } catch (error) {
      await this.release({ requestId }, false);
      throw error;
    }
  }

  async release(
    ticket: PreferenceSafetyTicket,
    committed: boolean,
  ): Promise<void> {
    await this.#hydration;
    const active = this.#active;
    if (!active || active.message.requestId !== ticket.requestId) return;
    if (active.timeout !== undefined) clearTimeout(active.timeout);
    let releaseAsCommitted = committed;
    let persistenceError: Error | undefined;
    if (committed) {
      this.#unresolvedCeilings.delete(ticket.requestId);
      try {
        await this.persistJournal();
      } catch {
        this.#unresolvedCeilings.set(ticket.requestId, active.message);
        releaseAsCommitted = false;
        persistenceError = new Error('preference-safety-journal-unavailable');
      }
    }
    for (const port of this.#ports) {
      this.postMessage(port, {
        kind: 'simul:preference-safety-v1:release',
        version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
        requestId: ticket.requestId,
        committed: releaseAsCommitted,
      } satisfies PreferenceSafetyReleaseMessage);
    }
    this.#active = undefined;
    if (persistenceError) throw persistenceError;
  }

  /** Release failed ceilings only after a durable scope proves them satisfied. */
  async observeCommittedReadScope(scope: ReplicaReadScope): Promise<void> {
    await this.#hydration;
    const committed = readExactReplicaReadScope(scope);
    if (!committed) return;
    const satisfied: Array<readonly [string, PreferenceSafetyPrepareMessage]> = [];
    for (const entry of this.#unresolvedCeilings) {
      const [requestId, failed] = entry;
      // An active purge owns this ceiling until release(). A stale startup or
      // storage observation must never delete its durable recovery record
      // while one or more panels may still fail to acknowledge the purge.
      if (requestId === this.#active?.message.requestId) continue;
      if (!isNoBroaderThan(committed, failed.targetReadScope)) continue;
      this.#unresolvedCeilings.delete(requestId);
      satisfied.push(entry);
    }
    if (satisfied.length === 0) return;
    try {
      await this.persistJournal();
    } catch {
      for (const [requestId, failed] of satisfied) {
        this.#unresolvedCeilings.set(requestId, failed);
      }
      throw new Error('preference-safety-journal-unavailable');
    }
    for (const [requestId] of satisfied) {
      for (const port of this.#ports) {
        this.postMessage(port, {
          kind: 'simul:preference-safety-v1:release',
          version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
          requestId,
          committed: true,
        } satisfies PreferenceSafetyReleaseMessage);
      }
    }
  }

  private receive(port: PreferenceSafetyPort, value: unknown): void {
    const hello = readPreferenceSafetyHelloMessage(value);
    if (hello) {
      this.#helloNonces.set(port, hello.connectionNonce);
      void this.readyAfterHydration(port, hello.connectionNonce);
      return;
    }
    const message = readPreferenceSafetyAckMessage(value);
    const active = this.#active;
    if (!message || !active || message.requestId !== active.message.requestId) {
      return;
    }
    active.pending.delete(port);
    this.finishReadyWhenEmpty(active);
  }

  private disconnect(port: PreferenceSafetyPort): void {
    const listeners = this.#listeners.get(port);
    if (listeners) {
      port.onMessage.removeListener(listeners.message);
      port.onDisconnect.removeListener(listeners.disconnect);
    }
    this.#listeners.delete(port);
    this.#ports.delete(port);
    this.#helloNonces.delete(port);
    const active = this.#active;
    if (active?.pending.delete(port) && !active.settled) {
      // A disconnected panel has not proved that it purged. Reject the whole
      // preparation instead of silently treating a lost lease as an ACK.
      active.settled = true;
      if (active.timeout !== undefined) clearTimeout(active.timeout);
      active.rejectReady(new Error('preference-safety-disconnected'));
    }
  }

  private postPrepare(
    port: PreferenceSafetyPort,
    active: ActivePreparation,
  ): void {
    try {
      this.postMessage(port, active.message);
    } catch {
      this.disconnect(port);
    }
  }

  private postMessage(port: PreferenceSafetyPort, message: unknown): void {
    try {
      port.postMessage(message);
    } catch {
      this.disconnect(port);
    }
  }

  private finishReadyWhenEmpty(active: ActivePreparation): void {
    if (active.pending.size > 0 || active.settled) return;
    active.settled = true;
    if (active.timeout !== undefined) clearTimeout(active.timeout);
    active.resolveReady();
  }

  private async hydrateJournal(): Promise<void> {
    if (!this.journal) return;
    let loaded: readonly PreferenceSafetyPrepareMessage[] | undefined;
    try {
      const value = await this.journal.load();
      // Absence is indistinguishable from an externally deleted journal after
      // a suspended service worker. Start under a durable Page-only ceiling;
      // the subsequently loaded preferences may release it only if their
      // effective scope is already Page-only.
      loaded = value === undefined
        ? undefined
        : readPreferenceSafetyJournalSnapshot(value);
    } catch {
      loaded = undefined;
    }
    if (loaded) {
      for (const ceiling of loaded) {
        this.#unresolvedCeilings.set(ceiling.requestId, ceiling);
      }
      return;
    }
    this.#unresolvedCeilings.set(
      RECOVERY_CEILING_REQUEST_ID,
      createRecoveryCeiling(),
    );
    await this.persistJournal().catch(() => undefined);
  }

  private async reconcileJournalStorageChange(
    value: unknown,
  ): Promise<PreferenceSafetyJournalObservation> {
    await this.#hydration;
    if (
      value !== undefined &&
      journalValueMatchesCeilings(value, this.#unresolvedCeilings.values())
    ) return 'current';

    // A notification for an earlier serialized write can be delivered after a
    // newer write has committed. Verify the current durable value before
    // treating a well-formed mismatch as external rollback/equivocation.
    if (
      value !== undefined &&
      readPreferenceSafetyJournalSnapshot(value) !== undefined &&
      await this.currentDurableJournalMatchesCeilings()
    ) return 'current';

    let recovery = this.#unresolvedCeilings.get(
      RECOVERY_CEILING_REQUEST_ID,
    );
    if (!recovery) {
      recovery = createRecoveryCeiling();
      if (this.#unresolvedCeilings.size >= MAX_JOURNALED_CEILINGS) {
        // Page-only is no broader than every representable ceiling, so it can
        // safely replace an at-capacity set while keeping the journal valid.
        this.#unresolvedCeilings.clear();
      }
      this.#unresolvedCeilings.set(RECOVERY_CEILING_REQUEST_ID, recovery);
      for (const port of this.#ports) this.postMessage(port, recovery);
    }
    try {
      await this.persistJournal();
    } catch {
      // The in-memory recovery ceiling and live-panel purge remain active. A
      // restart will also treat the still-missing/malformed journal as unsafe.
      throw new Error('preference-safety-journal-unavailable');
    }
    return 'recovered';
  }

  private async currentDurableJournalMatchesCeilings(): Promise<boolean> {
    if (!this.journal) return false;
    // State changes always schedule their journal write synchronously before
    // yielding. Retry if a prepare/release changed the expected set while the
    // authoritative read was in flight.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const writes = this.#journalWrites;
      await writes;
      const expected = [...this.#unresolvedCeilings.values()];
      let value: unknown;
      try {
        value = await this.journal.load();
      } catch {
        return false;
      }
      if (
        writes !== this.#journalWrites ||
        !samePreferenceSafetyCeilings(
          expected,
          this.#unresolvedCeilings.values(),
        )
      ) continue;
      return value !== undefined && journalValueMatchesCeilings(value, expected);
    }
    return false;
  }

  private async readyAfterHydration(
    port: PreferenceSafetyPort,
    connectionNonce: string,
  ): Promise<void> {
    await this.#hydration;
    if (
      !this.#ports.has(port) ||
      this.#helloNonces.get(port) !== connectionNonce
    ) return;
    for (const failed of this.#unresolvedCeilings.values()) {
      this.postMessage(port, failed);
    }
    this.postMessage(port, {
      kind: 'simul:preference-safety-v1:ready',
      version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
      connectionNonce,
    } satisfies PreferenceSafetyReadyMessage);
  }

  private persistJournal(): Promise<void> {
    if (!this.journal) return Promise.resolve();
    const snapshot: PreferenceSafetyJournalSnapshot = {
      kind: PREFERENCE_SAFETY_JOURNAL_KIND,
      version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
      ceilings: [...this.#unresolvedCeilings.values()],
    };
    const write = this.#journalWrites.then(
      () => this.journal!.save(snapshot),
      () => this.journal!.save(snapshot),
    );
    this.#journalWrites = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }
}

function createRecoveryCeiling(): PreferenceSafetyPrepareMessage {
  return {
    kind: 'simul:preference-safety-v1:prepare',
    version: PREFERENCE_SAFETY_PROTOCOL_VERSION,
    requestId: RECOVERY_CEILING_REQUEST_ID,
    operation: 'reset',
    targetReadScope: PAGE_ONLY_REPLICA_READ_SCOPE,
    targetFingerprint: replicaReadScopeFingerprint(
      PAGE_ONLY_REPLICA_READ_SCOPE,
    ),
  };
}

function isNoBroaderThan(
  candidate: ReplicaReadScope,
  ceiling: ReplicaReadScope,
): boolean {
  for (const key of Object.keys(candidate) as Array<keyof ReplicaReadScope>) {
    if (candidate[key] && !ceiling[key]) return false;
  }
  return true;
}

function journalValueMatchesCeilings(
  value: unknown,
  expected: Iterable<PreferenceSafetyPrepareMessage>,
): boolean {
  const ceilings = readPreferenceSafetyJournalSnapshot(value);
  return ceilings !== undefined && samePreferenceSafetyCeilings(
    ceilings,
    expected,
  );
}

function samePreferenceSafetyCeilings(
  left: Iterable<PreferenceSafetyPrepareMessage>,
  right: Iterable<PreferenceSafetyPrepareMessage>,
): boolean {
  const first = [...left];
  const second = [...right];
  return first.length === second.length && first.every((ceiling, index) => {
    const candidate = second[index];
    if (!candidate) return false;
    return ceiling.kind === candidate.kind &&
      ceiling.version === candidate.version &&
      ceiling.requestId === candidate.requestId &&
      ceiling.operation === candidate.operation &&
      ceiling.targetFingerprint === candidate.targetFingerprint &&
      replicaReadScopeFingerprint(ceiling.targetReadScope) ===
        replicaReadScopeFingerprint(candidate.targetReadScope);
  });
}

export function readPreferenceSafetyJournalSnapshot(
  value: unknown,
): readonly PreferenceSafetyPrepareMessage[] | undefined {
  // The pure parser represents an absent key as an empty snapshot. Hydration
  // deliberately distinguishes absence from a persisted empty snapshot,
  // because a restarted worker cannot tell first install from key deletion.
  if (value === undefined) return [];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'version', 'ceilings']) ||
    value.kind !== PREFERENCE_SAFETY_JOURNAL_KIND ||
    value.version !== PREFERENCE_SAFETY_PROTOCOL_VERSION ||
    !Array.isArray(value.ceilings) ||
    value.ceilings.length > MAX_JOURNALED_CEILINGS
  ) return undefined;
  const ceilings: PreferenceSafetyPrepareMessage[] = [];
  const requestIds = new Set<string>();
  for (const candidate of value.ceilings) {
    const ceiling = readPreferenceSafetyPrepareMessage(candidate);
    if (!ceiling || requestIds.has(ceiling.requestId)) return undefined;
    requestIds.add(ceiling.requestId);
    ceilings.push(ceiling);
  }
  return ceilings;
}

export function readPreferenceSafetyPrepareMessage(
  value: unknown,
): PreferenceSafetyPrepareMessage | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    'kind',
    'version',
    'requestId',
    'operation',
    'targetReadScope',
    'targetFingerprint',
  ])) return undefined;
  if (
    value.kind !== 'simul:preference-safety-v1:prepare' ||
    value.version !== PREFERENCE_SAFETY_PROTOCOL_VERSION ||
    !isRequestId(value.requestId) ||
    (value.operation !== 'read-narrow' && value.operation !== 'reset') ||
    typeof value.targetFingerprint !== 'string'
  ) return undefined;
  const scope = readExactReplicaReadScope(value.targetReadScope);
  if (
    !scope ||
    value.targetFingerprint !== replicaReadScopeFingerprint(scope)
  ) return undefined;
  return {
    kind: value.kind,
    version: value.version,
    requestId: value.requestId,
    operation: value.operation,
    targetReadScope: scope,
    targetFingerprint: value.targetFingerprint,
  };
}

export function readPreferenceSafetyAckMessage(
  value: unknown,
): PreferenceSafetyAckMessage | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'version', 'requestId']) ||
    value.kind !== 'simul:preference-safety-v1:ack' ||
    value.version !== PREFERENCE_SAFETY_PROTOCOL_VERSION ||
    !isRequestId(value.requestId)
  ) return undefined;
  return {
    kind: value.kind,
    version: value.version,
    requestId: value.requestId,
  };
}

export function readPreferenceSafetyReleaseMessage(
  value: unknown,
): PreferenceSafetyReleaseMessage | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'version', 'requestId', 'committed']) ||
    value.kind !== 'simul:preference-safety-v1:release' ||
    value.version !== PREFERENCE_SAFETY_PROTOCOL_VERSION ||
    !isRequestId(value.requestId) ||
    typeof value.committed !== 'boolean'
  ) return undefined;
  return {
    kind: value.kind,
    version: value.version,
    requestId: value.requestId,
    committed: value.committed,
  };
}

export function readPreferenceSafetyHelloMessage(
  value: unknown,
): PreferenceSafetyHelloMessage | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'version', 'connectionNonce']) ||
    value.kind !== 'simul:preference-safety-v1:hello' ||
    value.version !== PREFERENCE_SAFETY_PROTOCOL_VERSION ||
    !isRequestId(value.connectionNonce)
  ) return undefined;
  return {
    kind: value.kind,
    version: value.version,
    connectionNonce: value.connectionNonce,
  };
}

export function readPreferenceSafetyReadyMessage(
  value: unknown,
): PreferenceSafetyReadyMessage | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'version', 'connectionNonce']) ||
    value.kind !== 'simul:preference-safety-v1:ready' ||
    value.version !== PREFERENCE_SAFETY_PROTOCOL_VERSION ||
    !isRequestId(value.connectionNonce)
  ) return undefined;
  return {
    kind: value.kind,
    version: value.version,
    connectionNonce: value.connectionNonce,
  };
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length &&
    actual.every((key) => keys.includes(key));
}
