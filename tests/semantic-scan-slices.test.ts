import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  createPassShareLedger,
  PASS_HELD_RECHECK_MS,
  PASS_HOLD_LIMIT_MS,
  type PassShareLedger,
} from '../lib/browser-scheduling';
import { FULL_VISIBLE_REPLICA_READ_SCOPE } from '../lib/replica/read-scope-policy';
import {
  createSemanticSourceAck,
  createSemanticSourcePortName,
  createSemanticSourceStart,
  type SemanticSourceBatch,
} from '../lib/replica/semantic-source-protocol';
import {
  SemanticSourceSession,
  semanticSourceProofNodeIds,
  type SemanticSourcePort,
} from '../lib/replica/semantic-source-session';
import type { SemanticSourceProof } from '../lib/replica/semantic-source-protocol';
import { StickySourceSecretClassifier } from '../lib/replica/source-secret-classifier';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import { installSourceShadowRootReader } from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

// The control-text scan in slices (D164): the same batch as the one-task
// scan for a page that did not change, sealed against secrets, posted in one
// task, and at most a fifth of the tab's time with the comparison.

const identity: ReplicaSourceDocumentIdentity = {
  sessionId: 'semantic-scan-slices',
  pageEpoch: 1,
  generation: 1,
  documentId: 'semantic-scan-slices-document',
  frameId: 0,
};

const MANY = Array.from({ length: 12 }, (_, index) =>
  `<p>Paragraph ${index} <a href="/p${index}">link ${index}</a> ` +
  `<button id="act-${index}" aria-label="Act ${index}">Act</button></p>`).join('');

const PAGE = `<html><body>
  <nav><div id="wrapper"><a id="trigger" href="/library">Resources</a>
    <div id="panel" class="collapsed"><a href="/school">Startup School</a></div>
  </div></nav>
  <button id="disclose" aria-expanded="false" aria-controls="details">Details</button>
  <div id="details" hidden>Account notices</div>
  <div role="tablist">
    <div id="tab-a" role="tab" aria-selected="true" aria-expanded="true"
      aria-controls="panel-a">A</div>
    <div id="tab-b" role="tab" aria-selected="false" aria-expanded="false"
      aria-controls="panel-b">B</div>
  </div>
  <section id="panel-a" role="tabpanel" aria-hidden="false">Active news</section>
  <section id="panel-b" role="tabpanel" aria-hidden="true" hidden>Inactive news</section>
  <form>
    <span id="name-label">Name</span>
    <div id="region" role="group" aria-labelledby="name-label">Fields</div>
    <input id="name" value="Ada">
    <input id="pw" type="password" value="hunter22">
    <textarea id="notes">typed notes</textarea>
    <select id="pick"><option>One</option><option selected>Two</option></select>
    <input id="agree" type="checkbox" checked>
    <div id="switch" role="switch" aria-checked="true">Wifi</div>
    <button id="go" disabled>Go</button>
  </form>
  <div id="draft" contenteditable="true">editable words</div>
  ${MANY}
  <div id="host"><input id="late" value="late value"></div>
</body></html>`;

const ids = new WeakMap<object, number>();
let nextId = 1;
function nodeId(node: object): number {
  let id = ids.get(node);
  if (!id) {
    id = nextId++;
    ids.set(node, id);
  }
  return id;
}

/** `hidden`, `.collapsed` and `aria-hidden` hide; `.mask` masks. */
function pageStyle(onRead: () => void = () => {}): Window['getComputedStyle'] {
  return ((element: Element) => {
    onRead();
    const hidden = element.hasAttribute('hidden') ||
      element.classList.contains('collapsed') ||
      element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
    return {
      display: hidden ? 'none' : 'block',
      visibility: 'visible',
      opacity: '1',
      overflowX: 'visible',
      overflowY: 'visible',
      getPropertyValue: (name: string) => {
        if (name === '-webkit-text-security') {
          return element.classList.contains('mask') ? 'disc' : 'none';
        }
        if (name === 'content-visibility') return 'visible';
        if (name === 'clip') return 'auto';
        if (name === 'clip-path') return 'none';
        if (name === 'overflow-x' || name === 'overflow-y') return 'visible';
        return '';
      },
    } as unknown as CSSStyleDeclaration;
  }) as Window['getComputedStyle'];
}

function paintedRects(): DOMRectList {
  const rect = {
    x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 40, width: 320, height: 40,
    toJSON: () => ({}),
  } as DOMRect;
  return Object.assign([rect], {
    item: (index: number) => index === 0 ? rect : null,
  }) as unknown as DOMRectList;
}

function loadPage(html = PAGE) {
  const { document, window } = parseHTML(html);
  for (const element of [...document.querySelectorAll('*')]) {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => paintedRects(),
    });
  }
  const byId = <T extends Element = HTMLElement>(id: string) =>
    document.querySelector(`#${id}`) as unknown as T;
  // What linkedom does not compute: the chosen option and the box's state.
  const pick = document.querySelector('#pick');
  if (pick) {
    const chosen = pick.querySelectorAll('option')[1];
    Object.defineProperties(pick, {
      selectedOptions: { configurable: true, get: () => [chosen] },
      selectedIndex: { configurable: true, get: () => 1 },
      multiple: { configurable: true, get: () => false },
    });
  }
  const agree = document.querySelector('#agree');
  if (agree) {
    Object.defineProperties(agree, {
      checked: { configurable: true, get: () => true },
      indeterminate: { configurable: true, get: () => false },
    });
  }
  return {
    document: document as unknown as Document,
    window: window as unknown as Window,
    byId,
  };
}

interface Harness {
  readonly session: SemanticSourceSession;
  readonly port: FakeSemanticPort;
  readonly classifier: StickySourceSecretClassifier;
  /** How many turns the page was given. */
  turns(): number;
  /** Delivers records to the session's observer, as the page's change would. */
  deliver(records: readonly MutationRecord[]): void;
  /** Queues records the observer has not delivered: `takeRecords()` drains them. */
  queue(records: readonly MutationRecord[]): void;
  readonly timers: Array<{ callback: () => void; delayMs: number }>;
  start(): void;
  ack(): void;
}

interface HarnessOptions {
  /** A slice budget on a clock that moves a millisecond each time it is read. */
  readonly budgetMs?: number;
  /** Runs at each turn the page is given, by its number. */
  readonly between?: (turn: number) => void;
  readonly now?: () => number;
  readonly getComputedStyle?: Window['getComputedStyle'];
  readonly passShare?: PassShareLedger;
}

function createHarness(
  page: ReturnType<typeof loadPage>,
  options: HarnessOptions = {},
): Harness {
  const port = new FakeSemanticPort(
    createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
  );
  const classifier = new StickySourceSecretClassifier();
  let time = 0;
  let turns = 0;
  let observerCallback: MutationCallback | undefined;
  const pending: MutationRecord[] = [];
  const timers: Harness['timers'] = [];
  const sliced = options.budgetMs !== undefined || options.now !== undefined;
  const session = new SemanticSourceSession({
    port,
    document: page.document,
    window: {
      ...(page.window as object),
      getComputedStyle: options.getComputedStyle ?? pageStyle(),
    } as unknown as Window,
    bridge: 'isolated-html',
    secretClassifier: classifier,
    getNodeId: (node) => nodeId(node),
    createMutationObserver: (callback) => {
      observerCallback = callback;
      return {
        observe: () => undefined,
        disconnect: () => undefined,
        takeRecords: () => pending.splice(0),
      };
    },
    schedule: (callback) => callback(),
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      const index = timers.indexOf(timer as Harness['timers'][number]);
      if (index >= 0) timers.splice(index, 1);
    },
    ...(sliced
      ? {
          now: options.now ?? (() => (time += 1)),
          sliceBudgetMs: options.budgetMs,
          // A look at the clock after every unit, so a slice can end at any.
          sliceClockEvery: 1,
          yieldToMain: async () => {
            turns += 1;
            options.between?.(turns);
          },
        }
      : {}),
    ...(options.passShare ? { passShare: options.passShare } : {}),
  });
  return {
    session,
    port,
    classifier,
    timers,
    turns: () => turns,
    deliver: (records) => observerCallback?.(
      [...records],
      {} as MutationObserver,
    ),
    queue: (records) => {
      pending.push(...records);
    },
    start: () => port.emit(createSemanticSourceStart(
      'isolated-html',
      identity,
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    )),
    ack: () => {
      const last = port.messages.at(-1)!;
      port.emit(createSemanticSourceAck(identity, last.policyFingerprint, last.sequence));
    },
  };
}

/** Lets every turn the scan asked for pass: the turns here are microtasks. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function attributeRecord(target: Element, attributeName: string, oldValue: string | null) {
  return { type: 'attributes', target, attributeName, oldValue, addedNodes: [], removedNodes: [] } as
    unknown as MutationRecord;
}

/** Two batches: the first read, and the read after the name field changed. */
async function readTwice(
  page: ReturnType<typeof loadPage>,
  options: HarnessOptions,
): Promise<{ batches: SemanticSourceBatch[]; turns: number }> {
  const name = page.byId<HTMLInputElement>('name');
  name.value = 'Ada';
  const harness = createHarness(page, options);
  harness.start();
  await settle();
  harness.ack();
  name.value = 'Grace';
  harness.session.refresh();
  await settle();
  const batches = [...harness.port.messages];
  harness.session.dispose();
  return { batches, turns: harness.turns() };
}

describe('semantic scan in slices (D164)', () => {
  it('posts the one-task batches at every forced slice boundary', async () => {
    const page = loadPage();
    const whole = await readTwice(page, {});
    expect(whole.batches).toHaveLength(2);
    const first = whole.batches[0]!;
    // The page holds what each step of the scan reads.
    expect(first.proofs.map((proof) => proof.kind)).toEqual(expect.arrayContaining([
      'structural-menu', 'disclosure-state', 'tab-state', 'select-state',
      'choice-state', 'masked-length', 'aria-state', 'aria-relationship',
      'control-state',
    ]));
    expect(first.records.map((record) => record.text)).toEqual(expect.arrayContaining([
      'Startup School', 'Account notices', 'Ada', 'typed notes', 'editable words',
      'Act 3', 'late value',
    ]));
    expect(JSON.stringify(whole.batches)).not.toContain('hunter22');
    expect(whole.batches[1]!.records.find((record) => record.text === 'Grace'))
      .toMatchObject({ nodeRevision: 2 });

    let mostTurns = 0;
    for (let budgetMs = 1; budgetMs <= 80; budgetMs += 1) {
      const sliced = await readTwice(page, { budgetMs });
      expect(sliced.batches, `budget ${budgetMs}`).toEqual(whole.batches);
      mostTurns = Math.max(mostTurns, sliced.turns);
    }
    // The smallest budgets cut every step of the scan.
    expect(mostTurns).toBeGreaterThan(200);
  });

  it('posts a scan that fits one slice in the task that started it', () => {
    const page = loadPage();
    const harness = createHarness(page, { budgetMs: 1_000_000 });
    harness.start();
    expect(harness.port.messages).toHaveLength(1);
    expect(harness.turns()).toBe(0);
    harness.ack();
    page.byId<HTMLInputElement>('name').value = 'Grace';
    harness.session.refresh();
    expect(harness.port.messages).toHaveLength(2);
    expect(harness.turns()).toBe(0);
    harness.session.dispose();
  });

  it('never sends a field that became a password between slices, and reads it as secret next', async () => {
    const turnsOf = async (): Promise<number> => {
      const page = loadPage();
      const harness = createHarness(page, { budgetMs: 2 });
      harness.start();
      await settle();
      const turns = harness.turns();
      harness.session.dispose();
      return turns;
    };
    const total = await turnsOf();
    expect(total).toBeGreaterThan(20);
    let sealed = 0;
    for (let at = 1; at <= total; at += 1) {
      const page = loadPage();
      const late = page.byId<HTMLInputElement>('late');
      late.value = 'swordfish-77';
      let harness: Harness | undefined = undefined;
      harness = createHarness(page, {
        budgetMs: 2,
        between: (turn) => {
          if (turn !== at) return;
          late.setAttribute('type', 'password');
          harness!.deliver([attributeRecord(late, 'type', null)]);
        },
      });
      harness.start();
      await settle();
      expect(harness.port.messages, `turn ${at}`).toHaveLength(1);
      expect(JSON.stringify(harness.port.messages), `turn ${at}`)
        .not.toContain('swordfish-77');
      // A scan that had read the field before it changed was sealed.
      if (harness.classifier.isSecret(late)) sealed += 1;
      harness.ack();
      await settle();
      // The next scan reads it as secret.
      const next = harness.port.messages.at(-1)!;
      expect(next.records.some((record) => record.nodeId === nodeId(late)), `turn ${at}`)
        .toBe(false);
      expect(harness.classifier.isSecret(late)).toBe(true);
      harness.session.dispose();
    }
    expect(sealed).toBeGreaterThan(0);
  });

  it('leaves out at the seal what the scan read before it turned secret', async () => {
    const page = loadPage();
    const late = page.byId<HTMLInputElement>('late');
    late.value = 'swordfish-78';
    let harness: Harness | undefined = undefined;
    let at = Number.POSITIVE_INFINITY;
    harness = createHarness(page, {
      budgetMs: 2,
      between: (turn) => {
        if (turn !== at) return;
        late.setAttribute('type', 'password');
        harness!.deliver([attributeRecord(late, 'type', null)]);
      },
    });
    // Count the turns of the first scan, then turn the field into a password
    // at the last turn of the second, long after its value was read.
    harness.start();
    await settle();
    const firstTurns = harness.turns();
    harness.ack();
    late.value = 'swordfish-79';
    at = firstTurns * 2;
    harness.session.refresh();
    await settle();
    expect(harness.port.messages).toHaveLength(2);
    expect(JSON.stringify(harness.port.messages[1])).not.toContain('swordfish-79');
    expect(harness.port.messages[1]!.records.some((record) =>
      record.nodeId === nodeId(late))).toBe(false);
    // Left out, so read again: the next scan follows the ACK.
    harness.ack();
    await settle();
    expect(harness.port.messages).toHaveLength(3);
    harness.session.dispose();
  });

  it('reads the page again for a root attached above a changed node during the scan (D125)', async () => {
    const page = loadPage();
    const reader = closedRootReader();
    installSourceShadowRootReader(page.document, reader.read);
    const host = page.byId('host');
    const late = page.byId<HTMLInputElement>('late');
    // Chrome reads null from `assignedSlot` for a node slotted into a closed root.
    Object.defineProperty(late, 'assignedSlot', { configurable: true, value: null });
    late.value = 'before root';
    let attachAt = Number.POSITIVE_INFINITY;
    const harness = createHarness(page, {
      budgetMs: 2,
      between: (turn) => {
        if (turn !== attachAt) return;
        // Nothing fires for a root attached to an element already read.
        reader.attach(host, '<div class="mask"><slot></slot></div>');
      },
    });
    harness.start();
    await settle();
    const firstTurns = harness.turns();
    expect(harness.port.messages[0]!.records.map((record) => record.text))
      .toContain('before root');
    harness.ack();

    late.value = 'typed-secret-52';
    attachAt = firstTurns + firstTurns - 1;
    harness.session.refresh();
    await settle();
    expect(reader.calls).toContain(host);
    expect(JSON.stringify(harness.port.messages)).not.toContain('typed-secret-52');
    // The page was read again: more turns than one scan takes.
    expect(harness.turns() - firstTurns).toBeGreaterThan(firstTurns);
    harness.session.dispose();
  });

  it('goes on through a change, and reads again after the ACK', async () => {
    const page = loadPage();
    const button = page.byId('act-11');
    const plain = createHarness(loadPage(), { budgetMs: 3 });
    plain.start();
    await settle();
    const plainTurns = plain.turns();
    plain.session.dispose();

    let harness: Harness | undefined = undefined;
    harness = createHarness(page, {
      budgetMs: 3,
      between: (turn) => {
        if (turn !== 1) return;
        button.setAttribute('aria-label', 'Changed label');
        harness!.deliver([attributeRecord(button, 'aria-label', 'Act 11')]);
      },
    });
    harness.start();
    await settle();
    // The scan was not read anew: as many turns as on the unchanged page.
    expect(harness.turns()).toBe(plainTurns);
    expect(harness.port.messages).toHaveLength(1);
    // It read the label after the change, but part of the page before it:
    // the page is read again once the batch is applied.
    expect(harness.port.messages[0]!.records.map((record) => record.text))
      .toContain('Changed label');
    harness.ack();
    await settle();
    expect(harness.turns()).toBeGreaterThan(plainTurns + plainTurns / 2);
    harness.session.dispose();
  });

  it('posts nothing and reads no more once disposed during a scan', async () => {
    const page = loadPage();
    let reads = 0;
    let harness: Harness | undefined = undefined;
    let readsAtDispose = 0;
    harness = createHarness(page, {
      budgetMs: 2,
      getComputedStyle: pageStyle(() => {
        reads += 1;
      }),
      between: (turn) => {
        if (turn !== 3) return;
        harness!.session.dispose();
        readsAtDispose = reads;
      },
    });
    harness.start();
    await settle();
    expect(harness.turns()).toBe(3);
    expect(harness.port.messages).toEqual([]);
    expect(reads).toBe(readsAtDispose);
  });

  it('reads the page anew when its tabs change during the scan', async () => {
    const plain = createHarness(loadPage(), { budgetMs: 2 });
    plain.start();
    await settle();
    const plainTurns = plain.turns();
    plain.session.dispose();

    let restarted = 0;
    for (let at = 1; at <= plainTurns; at += 1) {
      const page = loadPage();
      const tabA = page.byId('tab-a');
      const tabB = page.byId('tab-b');
      let harness: Harness | undefined = undefined;
      harness = createHarness(page, {
        budgetMs: 2,
        between: (turn) => {
          if (turn !== at) return;
          tabA.setAttribute('aria-selected', 'false');
          tabB.setAttribute('aria-selected', 'true');
          harness!.deliver([
            attributeRecord(tabA, 'aria-selected', 'true'),
            attributeRecord(tabB, 'aria-selected', 'false'),
          ]);
        },
      });
      harness.start();
      await settle();
      expect(harness.port.messages, `turn ${at}`).toHaveLength(1);
      // A restart reads the page from its start: many more turns than the
      // few units the change itself adds or takes away.
      if (harness.turns() > plainTurns + 20) {
        restarted += 1;
        // The batch says what the page says now.
        const tabState = harness.port.messages[0]!.proofs.find((proof) =>
          proof.kind === 'tab-state' && proof.tabNodeId === nodeId(tabB));
        expect(tabState).toBeUndefined();
      } else {
        // Read on: the change is read after the ACK.
        expect(Math.abs(harness.turns() - plainTurns), `turn ${at}`)
          .toBeLessThanOrEqual(5);
      }
      harness.session.dispose();
    }
    expect(restarted).toBeGreaterThan(0);
    expect(restarted).toBeLessThan(plainTurns);
  });

  it('reads the page in one task after two restarts', async () => {
    const page = loadPage();
    const tabA = page.byId('tab-a');
    let harness: Harness | undefined = undefined;
    let flips = 0;
    harness = createHarness(page, {
      budgetMs: 2,
      between: () => {
        // The page changes its tabs at every turn it is given.
        flips += 1;
        const selected = flips % 2 === 0 ? 'true' : 'false';
        tabA.setAttribute('aria-selected', selected);
        harness!.deliver([attributeRecord(tabA, 'aria-selected', null)]);
      },
    });
    harness.start();
    await settle();
    expect(harness.port.messages).toHaveLength(1);
    const plain = createHarness(loadPage(), { budgetMs: 2 });
    plain.start();
    await settle();
    // Two sliced reads were cut short, the third took no turn.
    expect(harness.turns()).toBeLessThan(plain.turns() * 2);
    plain.session.dispose();
    harness.session.dispose();
  });

  it('waits four times the busy time of a scan before the next', async () => {
    const page = loadPage();
    let time = 0;
    const now = () => time;
    const passShare = createPassShareLedger({ now });
    const harness = createHarness(page, {
      now,
      budgetMs: 1_000_000,
      passShare,
      // Each style read takes a millisecond of the tab's time.
      getComputedStyle: pageStyle(() => {
        time += 1;
      }),
    });
    // The first scan runs at once.
    harness.start();
    expect(harness.port.messages).toHaveLength(1);
    const busy = time;
    expect(busy).toBeGreaterThan(10);
    harness.ack();

    page.byId<HTMLInputElement>('name').value = 'Grace';
    // The control poll's timer is the session's own.
    const before = harness.timers.length;
    harness.session.refresh();
    expect(harness.port.messages).toHaveLength(1);
    expect(harness.timers).toHaveLength(before + 1);
    const wait = harness.timers.at(-1)!;
    expect(wait.delayMs).toBe(4 * busy);
    // Changes meanwhile set no second timer and start no scan.
    harness.session.refresh();
    expect(harness.timers).toHaveLength(before + 1);
    expect(harness.port.messages).toHaveLength(1);

    time += 4 * busy;
    harness.timers.splice(harness.timers.indexOf(wait), 1);
    wait.callback();
    expect(harness.port.messages).toHaveLength(2);
    expect(harness.port.messages[1]!.records.map((record) => record.text))
      .toContain('Grace');
    harness.session.dispose();
  });
  it('reads no second time for drained records that only wrote the value a node had', async () => {
    const plain = createHarness(loadPage(), { budgetMs: 3 });
    plain.start();
    await settle();
    const plainTurns = plain.turns();
    plain.session.dispose();

    const turnsAfterAck = async (label: string | null): Promise<number> => {
      const page = loadPage();
      const button = page.byId('act-11');
      let harness: Harness | undefined = undefined;
      harness = createHarness(page, {
        budgetMs: 3,
        between: (turn) => {
          if (turn !== 1) return;
          // Queued, not delivered: the end of the scan drains it.
          if (label !== null) button.setAttribute('aria-label', label);
          harness!.queue([attributeRecord(button, 'aria-label', 'Act 11')]);
        },
      });
      harness.start();
      await settle();
      expect(harness.turns()).toBe(plainTurns);
      harness.ack();
      await settle();
      const turns = harness.turns() - plainTurns;
      harness.session.dispose();
      return turns;
    };
    // The label written with the value it had: no scan follows.
    expect(await turnsAfterAck(null)).toBe(0);
    // A real change: the page is read again after the ACK.
    expect(await turnsAfterAck('Changed label')).toBeGreaterThan(plainTurns / 2);
  });

  it('seals a scan that had turns even when no record came (a field masked by a rewritten rule)', async () => {
    const page = loadPage();
    const late = page.byId<HTMLInputElement>('late');
    late.value = 'swordfish-80';
    let masked = false;
    const base = pageStyle();
    // A rule of a sheet rewritten through the CSSOM: no record tells of it.
    const style = ((element: Element) => {
      const read = base(element);
      if (element !== late || !masked) return read;
      return {
        ...read,
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' ? 'disc' : read.getPropertyValue(name),
      } as unknown as CSSStyleDeclaration;
    }) as Window['getComputedStyle'];
    let at = Number.POSITIVE_INFINITY;
    const harness = createHarness(page, {
      budgetMs: 2,
      getComputedStyle: style,
      between: (turn) => {
        if (turn === at) masked = true;
      },
    });
    harness.start();
    await settle();
    const firstTurns = harness.turns();
    expect(JSON.stringify(harness.port.messages[0])).toContain('swordfish-80');
    harness.ack();
    late.value = 'swordfish-81';
    // At the last turn of the second scan, long after the value was read.
    at = firstTurns * 2;
    harness.session.refresh();
    await settle();
    expect(harness.turns()).toBeGreaterThanOrEqual(at);
    expect(harness.port.messages).toHaveLength(2);
    expect(JSON.stringify(harness.port.messages[1])).not.toContain('swordfish-81');
    harness.session.dispose();
  });

  it('gives the page turns in every walk over the elements, the last ones too', async () => {
    const divs = Array.from({ length: 400 }, (_, index) => `<div>block ${index}</div>`).join('');
    const page = loadPage(`<html><body>${divs}</body></html>`);
    let reads = 0;
    for (const element of [...page.document.querySelectorAll('div')]) {
      const read = element.getAttribute.bind(element);
      Object.defineProperty(element, 'getAttribute', {
        configurable: true,
        value: (name: string) => {
          reads += 1;
          return read(name);
        },
      });
    }
    let mostInOneSlice = 0;
    let atTurn = 0;
    const harness = createHarness(page, {
      budgetMs: 2,
      between: () => {
        mostInOneSlice = Math.max(mostInOneSlice, reads - atTurn);
        atTurn = reads;
      },
    });
    harness.start();
    await settle();
    mostInOneSlice = Math.max(mostInOneSlice, reads - atTurn);
    expect(harness.port.messages).toHaveLength(1);
    expect(reads).toBeGreaterThan(400 * 3);
    // A slice reads a few elements; a walk with no turn read all 400.
    expect(mostInOneSlice).toBeLessThan(100);
    harness.session.dispose();
  });

  it('keeps its hold on the page through a scan longer than the hold limit', async () => {
    const page = loadPage();
    let time = 0;
    const passShare = createPassShareLedger({ now: () => time });
    const comparison = {};
    const held: number[] = [];
    const harness = createHarness(page, {
      budgetMs: 3,
      now: () => (time += 1),
      passShare,
      between: () => {
        // A long turn of the page: the scan's wall time passes the limit.
        time += PASS_HOLD_LIMIT_MS - 100;
        held.push(passShare.waitMs(comparison));
      },
    });
    harness.start();
    await settle();
    expect(harness.port.messages).toHaveLength(1);
    expect(held.length).toBeGreaterThan(3);
    expect(held.every((wait) => wait === PASS_HELD_RECHECK_MS)).toBe(true);
    harness.session.dispose();
  });

  it('notes the work of a scan its session ended, and frees the page', async () => {
    const page = loadPage();
    let time = 0;
    const passShare = createPassShareLedger({ now: () => time });
    let harness: Harness | undefined = undefined;
    harness = createHarness(page, {
      budgetMs: 3,
      now: () => time,
      passShare,
      // Each style read takes a millisecond of the tab's time.
      getComputedStyle: pageStyle(() => {
        time += 1;
      }),
      between: (turn) => {
        if (turn === 3) harness!.session.dispose();
      },
    });
    harness.start();
    await settle();
    expect(harness.port.messages).toEqual([]);
    // Not held, and the next pass rests four times the work it did.
    expect(passShare.waitMs({}, true)).toBe(0);
    expect(passShare.waitMs({})).toBeGreaterThan(0);
    expect(passShare.waitMs({}) % 4).toBe(0);
  });
});

describe('the nodes a proof names (D164)', () => {
  // The numbers of a proof that name no node.
  const NOT_NODES = new Set(['revision', 'length', 'size']);

  it('names every node of every kind of proof the protocol declares', () => {
    const source = readFileSync(
      new URL('../lib/replica/semantic-source-protocol.ts', import.meta.url),
      'utf8',
    );
    const proofs = [...source.matchAll(
      /export interface (Semantic\w+Proof) \{([\s\S]*?)\n\}/gu,
    )];
    // Every member of the union of proofs is read here.
    const union = /export type SemanticSourceProof =([^;]+);/u.exec(source)![1]!
      .split('|').map((name) => name.trim()).filter(Boolean);
    expect(union.length).toBeGreaterThanOrEqual(11);
    expect(proofs.map(([, name]) => name).sort()).toEqual(expect.arrayContaining(union));
    for (const [, name, body] of proofs) {
      if (!union.includes(name!)) continue;
      let next = 100;
      const proof: Record<string, unknown> = {};
      const expected: number[] = [];
      for (const [, name, type] of body!.matchAll(/readonly (\w+)\??: ([^;]+);/gu)) {
        const kind = /^'([^']+)'$/u.exec(type!.trim());
        if (name === 'kind' && kind) {
          proof.kind = kind[1];
        } else if (/^(readonly )?number\[\]$/u.test(type!.trim())) {
          const ids = [next++, next++];
          proof[name!] = ids;
          if (!NOT_NODES.has(name!)) expected.push(...ids);
        } else if (/^number( \| null)?$/u.test(type!.trim())) {
          const id = next++;
          proof[name!] = id;
          if (!NOT_NODES.has(name!)) expected.push(id);
        } else {
          proof[name!] = 'x';
        }
      }
      expect(semanticSourceProofNodeIds(proof as unknown as SemanticSourceProof).sort(), String(proof.kind))
        .toEqual(expected.sort());
    }
  });
});

class FakeSemanticPort implements SemanticSourcePort {
  readonly messages: SemanticSourceBatch[] = [];
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #disconnectListeners = new Set<() => void>();
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) =>
      this.#messageListeners.add(listener),
    removeListener: (listener: (message: unknown) => void) =>
      this.#messageListeners.delete(listener),
  };
  readonly onDisconnect = {
    addListener: (listener: () => void) => this.#disconnectListeners.add(listener),
    removeListener: (listener: () => void) =>
      this.#disconnectListeners.delete(listener),
  };
  disconnects = 0;

  constructor(readonly name: string) {}

  postMessage(message: SemanticSourceBatch): void {
    this.messages.push(message);
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  emit(message: unknown): void {
    for (const listener of [...this.#messageListeners]) listener(message);
  }
}
