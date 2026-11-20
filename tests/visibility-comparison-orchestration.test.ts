import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  createPassShareLedger,
  PASS_HELD_RECHECK_MS,
  PASS_HOLD_LIMIT_MS,
  type PassShareLedger,
} from '../lib/browser-scheduling';
import {
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  decodeHtmlMirrorWireMessage,
  encodeHtmlMirrorWireMessage,
  type HtmlMirrorPatchBatch,
} from '../lib/replica/html-mirror-protocol';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
} from '../lib/replica/html-mirror-source';
import { FULL_VISIBLE_REPLICA_READ_SCOPE } from '../lib/replica/read-scope-policy';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
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
import { StickySourceSecretClassifier } from '../lib/replica/source-secret-classifier';

/**
 * The comparison of what the page paints in the live mirror (D164): in
 * slices with turns for the page, its requests taken when it starts, the
 * page's changes sent meanwhile, a fifth of the tab's time with the
 * semantic scan, and no comparison for a change no style sheet names.
 */

beforeEach(() => {
  // The readers ask `Node` for node types, as the page's own global.
  const { window } = parseHTML('<html><body></body></html>');
  Object.assign(globalThis, {
    Node: window.Node,
    Element: window.Element,
    Text: window.Text,
  });
});

const identity = createReplicaIdentity({
  sessionId: 'comparison-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'comparison-document',
  frameId: 0,
  sequence: 0,
});

class FakePort {
  readonly posts: unknown[] = [];
  readonly #listeners = new Set<(message: unknown) => void>();
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => this.#listeners.add(listener),
    removeListener: (listener: (message: unknown) => void) => this.#listeners.delete(listener),
  };
  readonly onDisconnect = { addListener: () => {}, removeListener: () => {} };
  readonly disconnect = vi.fn();

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    this.posts.push(decodeHtmlMirrorWireMessage(
      JSON.parse(JSON.stringify(encodeHtmlMirrorWireMessage(message))),
    ));
  }

  emit(message: unknown): void {
    for (const listener of [...this.#listeners]) listener(message);
  }
}

interface FakeSheet {
  cssRules: Array<{ cssText: string }> & { item(index: number): unknown };
  disabled: boolean;
  media: { mediaText: string };
  ownerNode: null;
}

function sheet(...texts: string[]): FakeSheet {
  const rules = texts.map((cssText) => ({ cssText }));
  return {
    cssRules: Object.assign(rules, { item: (index: number) => rules[index] ?? null }),
    disabled: false,
    media: { mediaText: '' },
    ownerNode: null,
  };
}

interface FixtureOptions {
  /** How far the clock moves at each reading; 0 stands it still. */
  readonly tick?: number;
  readonly passShare?: (now: () => number) => PassShareLedger;
  /** The page's style sheets, as `document.styleSheets` lists them. */
  readonly sheets?: unknown[];
}

/**
 * A page reader whose frames, turns, timers and clock are the test's. Every
 * element has a box; class `gone` hides one. `probe()` counts the reads of
 * `#probe`'s style: one a comparison of the whole page.
 */
function fixture(markup: string, options: FixtureOptions = {}) {
  const { document, window } = parseHTML(
    `<!doctype html><html><head></head><body>${markup}<p id="probe">probe</p></body></html>`,
  );
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.test/',
  });
  Object.defineProperty(document, 'styleSheets', {
    configurable: true,
    value: options.sheets ?? [],
  });
  const rect = {
    x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 40, width: 320, height: 40,
    toJSON: () => ({}),
  } as DOMRect;
  const paintRects = () => Object.assign([rect], { item: (i: number) => i === 0 ? rect : null });
  const box = (element: Element) => {
    Object.defineProperty(element, 'getBoundingClientRect', { configurable: true, value: () => rect });
    Object.defineProperty(element, 'getClientRects', { configurable: true, value: paintRects });
  };
  for (const element of document.querySelectorAll('*')) box(element as unknown as Element);
  const probe = document.getElementById('probe') as unknown as Element;
  let probeReads = 0;
  const style = (element: Element) => {
    if (element === probe) probeReads += 1;
    return {
      display: element.classList.contains('gone')
        ? 'none'
        : ['span', 'b', 'i', 'a'].includes(element.localName) ? 'inline' : 'block',
      visibility: 'visible',
      opacity: '1',
      overflowX: 'visible',
      overflowY: 'visible',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      getPropertyValue: (name: string) => {
        if (name === '-webkit-text-security') return 'none';
        if (name === 'content-visibility') return 'visible';
        if (name === 'clip') return 'auto';
        if (name === 'clip-path') return 'none';
        if (name.startsWith('overflow')) return 'visible';
        return '';
      },
    };
  };
  for (const [name, value] of [
    ['getComputedStyle', style],
    ['innerWidth', 1200],
    ['innerHeight', 800],
  ] as const) {
    Object.defineProperty(window, name, { configurable: true, value });
  }
  onTestFinished(() => {
    // linkedom's windows share one object: leave none of this to the next.
    for (const name of ['getComputedStyle', 'innerWidth', 'innerHeight', 'top']) {
      delete (window as unknown as Record<string, unknown>)[name];
    }
  });
  const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
  const frames: Array<() => void> = [];
  const turns: Array<() => void> = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let time = 0;
  let tick = options.tick ?? 0;
  const now = () => (time += tick);
  const passShare = options.passShare?.(() => time);
  let mutationCallback: MutationCallback | undefined;
  const session = new HtmlMirrorSourceSession({
    port: port as unknown as Browser.runtime.Port,
    document: document as unknown as Document,
    window: window as unknown as Window,
    registry: new WeakNodeIdRegistry(),
    now,
    yieldToMain: () => new Promise<void>((resolve) => turns.push(resolve)),
    ...(passShare ? { passShare } : {}),
    createMutationObserver: (callback) => {
      mutationCallback = callback;
      return { observe: () => {}, disconnect: () => {} };
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return callback;
    },
    cancelFrame: (handle) => {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
    setTimer: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const patches = () => port.posts.filter((message): message is HtmlMirrorPatchBatch =>
    (message as { kind?: string }).kind === 'simul:html-mirror-v2:patch');
  const flushFrames = () => {
    for (let count = 0; frames.length > 0; count += 1) {
      if (count > 100) throw new Error('The frames do not end.');
      frames.shift()!();
    }
  };
  return {
    document: document as unknown as Document,
    window: window as unknown as Window,
    port,
    session,
    frames,
    turns,
    timers,
    passShare,
    patches,
    box,
    probe: () => probeReads,
    time: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    setTick: (value: number) => {
      tick = value;
    },
    byId: (id: string) => document.getElementById(id) as unknown as HTMLElement,
    mutate: (...records: MutationRecord[]) =>
      mutationCallback!(records, {} as MutationObserver),
    flushFrames,
    /** Gives the page the turn the comparison waits for. */
    turn: async (): Promise<void> => {
      const next = turns.shift();
      if (!next) throw new Error('No turn is waited for.');
      next();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    /** Every turn, and every frame they ask for, until none is waited for. */
    async settle(between: () => void = () => {}): Promise<void> {
      for (let count = 0; turns.length > 0 || frames.length > 0; count += 1) {
        if (count > 10_000) throw new Error('The comparison does not end.');
        between();
        if (turns.length > 0) {
          turns.shift()!();
          await new Promise((resolve) => setTimeout(resolve, 0));
        } else flushFrames();
      }
    },
    /** Starts the mirror, read in one task, and acknowledges it. */
    open: () => {
      const before = tick;
      tick = 0;
      port.emit(createHtmlMirrorStart(identity, 'conservative'));
      port.emit(createHtmlMirrorAck(identity, 0));
      flushFrames();
      tick = before;
    },
    /** Runs the timers set so far: the periodic look polls the style sheets. */
    runTimers: () => {
      for (const timer of timers.splice(0)) timer.callback();
      flushFrames();
    },
    ack: () => {
      const last = port.posts.at(-1) as { identity?: { sequence: number } };
      port.emit(createHtmlMirrorAck(identity, last.identity?.sequence ?? 0));
    },
    event: (type: string, target: Element) => {
      const event = new window.Event(type, { bubbles: true });
      target.dispatchEvent(event as unknown as Event);
    },
  };
}

function attributeRecord(target: Element, name: string, value: string | null): MutationRecord {
  const oldValue = target.getAttribute(name);
  if (value === null) target.removeAttribute(name);
  else target.setAttribute(name, value);
  return {
    type: 'attributes',
    target,
    attributeName: name,
    attributeNamespace: null,
    oldValue,
    addedNodes: [],
    removedNodes: [],
  } as unknown as MutationRecord;
}

function textRecord(text: Text, value: string): MutationRecord {
  const oldValue = text.data;
  text.data = value;
  return { type: 'characterData', target: text, oldValue } as unknown as MutationRecord;
}

/** About 1,100 elements: several slices on a clock that moves 4 ms a look. */
const LARGE = Array.from({ length: 120 }, (_, block) =>
  `<section id="b${block}">` +
  Array.from({ length: 4 }, (_, row) =>
    `<p id="p${block}-${row}" class="${block === 100 && row === 0 ? 'gone' : ''}">` +
    `Row ${block}.${row} <b>x</b></p>`).join('') +
  '</section>').join('');

const SMALL = '<main><p id="first">One <b>two</b></p><div id="panel" class="gone">Panel text</div></main>';

describe('the comparison of what the page paints, in slices (D164)', () => {
  it('compares a small page in the task of its flush, as before', () => {
    const target = fixture(SMALL, { tick: 4 });
    target.open();
    const compared = target.probe();
    const sent = target.patches().length;
    target.mutate(attributeRecord(target.byId('panel'), 'class', ''));
    expect(target.frames).toHaveLength(1);
    target.frames.shift()!();
    expect(target.turns).toHaveLength(0);
    expect(target.probe()).toBe(compared + 1);
    // The panel it found shown is read again in that same flush.
    expect(target.patches()).toHaveLength(sent + 1);
    expect(JSON.stringify(target.patches().at(-1))).toContain('Panel text');
  });

  it('sends the page\'s changes between the slices, and compares a change made meanwhile in a comparison of its own', async () => {
    const target = fixture(LARGE, { tick: 4 });
    target.open();
    const compared = target.probe();
    target.mutate(attributeRecord(target.byId('p100-0'), 'class', ''));
    target.frames.shift()!();
    // The comparison gives the page a turn before it is done.
    expect(target.turns.length).toBe(1);
    // A change of text meanwhile: its patch goes out in the next frame,
    // and no second comparison starts.
    const sent = target.patches().length;
    const text = target.byId('p3-1').firstChild as Text;
    target.mutate(textRecord(text, 'Changed row'));
    expect(target.frames).toHaveLength(1);
    target.frames.shift()!();
    expect(target.patches()).toHaveLength(sent + 1);
    expect(JSON.stringify(target.patches().at(-1))).toContain('Changed row');
    expect(target.turns.length).toBe(1);
    target.ack();
    // The first comparison ends: what it found (the row it saw shown) is
    // sent, and the change of text gets a comparison of its own.
    await target.settle();
    expect(target.probe()).toBe(compared + 2);
    expect(JSON.stringify(target.patches())).toContain('Row 100.0');
  });

  it('compares once when nothing asks again while it runs', async () => {
    const target = fixture(LARGE, { tick: 4 });
    target.open();
    const compared = target.probe();
    target.mutate(attributeRecord(target.byId('p100-0'), 'class', ''));
    target.frames.shift()!();
    expect(target.turns.length).toBe(1);
    await target.settle();
    expect(target.probe()).toBe(compared + 1);
  });

  it('cancels a comparison that runs when a checkpoint is asked for, or the session ends', async () => {
    const target = fixture(LARGE, { tick: 4 });
    target.open();
    target.mutate(attributeRecord(target.byId('p100-0'), 'class', ''));
    target.frames.shift()!();
    expect(target.turns.length).toBe(1);
    // The new copy is read in one task.
    target.setTick(0);
    target.port.emit(createHtmlMirrorCheckpointRequest(identity, 0));
    const read = target.probe();
    const posts = target.port.posts.length;
    await target.turn();
    expect(target.turns).toHaveLength(0);
    expect(target.probe()).toBe(read);
    expect(target.port.posts).toHaveLength(posts);

    const other = fixture(LARGE, { tick: 4 });
    other.open();
    other.mutate(attributeRecord(other.byId('p100-0'), 'class', ''));
    other.frames.shift()!();
    expect(other.turns.length).toBe(1);
    const before = other.probe();
    const otherPosts = other.port.posts.length;
    other.session.dispose();
    await other.turn();
    expect(other.turns).toHaveLength(0);
    expect(other.probe()).toBe(before);
    expect(other.port.posts).toHaveLength(otherPosts);
  });

  it('notes the work of a comparison a checkpoint cancelled, and frees the page', async () => {
    const target = fixture(LARGE, {
      tick: 4,
      passShare: (now) => createPassShareLedger({ now }),
    });
    target.open();
    const share = target.passShare!;
    target.mutate(attributeRecord(target.byId('p100-0'), 'class', ''));
    target.frames.shift()!();
    expect(target.turns.length).toBe(1);
    target.setTick(0);
    target.port.emit(createHtmlMirrorCheckpointRequest(identity, 0));
    // Not held, and the next pass rests four times the work it did.
    expect(share.waitMs({}, true)).toBe(0);
    expect(share.waitMs({})).toBeGreaterThan(0);
  });

  it('keeps its hold on the page through a comparison longer than the hold limit', async () => {
    const target = fixture(LARGE, {
      tick: 4,
      passShare: (now) => createPassShareLedger({ now }),
    });
    target.open();
    const share = target.passShare!;
    target.mutate(attributeRecord(target.byId('p100-0'), 'class', ''));
    target.frames.shift()!();
    expect(target.turns.length).toBe(1);
    const held: number[] = [];
    await target.settle(() => {
      if (target.turns.length === 0) return;
      // A long turn of the page: the comparison's wall time passes the limit.
      target.advance(PASS_HOLD_LIMIT_MS - 100);
      held.push(share.waitMs({}));
    });
    expect(held.length).toBeGreaterThan(2);
    expect(held.every((wait) => wait === PASS_HELD_RECHECK_MS)).toBe(true);
  });

  it('waits for the share of time a scan used, sending the page\'s changes meanwhile, and notes its own', async () => {
    const target = fixture(SMALL, {
      tick: 1,
      passShare: (now) => createPassShareLedger({ now }),
    });
    target.open();
    const share = target.passShare!;
    // A scan kept the tab busy for 10 ms: the next pass waits 40.
    share.note(10);
    const compared = target.probe();
    const sent = target.patches().length;
    target.mutate(attributeRecord(target.byId('panel'), 'class', ''));
    target.timers.splice(0);
    target.frames.shift()!();
    expect(target.probe()).toBe(compared);
    // The change itself is sent.
    expect(target.patches()).toHaveLength(sent + 1);
    expect(target.timers).toHaveLength(1);
    const wait = target.timers[0]!;
    expect(wait.delay).toBeGreaterThan(30);
    expect(wait.delay).toBeLessThanOrEqual(40);
    // Another change meanwhile sets no second timer.
    target.ack();
    target.mutate(attributeRecord(target.byId('first'), 'data-x', '1'));
    target.flushFrames();
    expect(target.timers).toHaveLength(1);
    expect(target.probe()).toBe(compared);

    target.advance(wait.delay);
    target.timers.splice(0)[0]!.callback();
    expect(target.frames).toHaveLength(1);
    const started = target.time();
    target.flushFrames();
    expect(target.probe()).toBe(compared + 1);
    expect(JSON.stringify(target.patches().at(-1))).toContain('Panel text');
    // Its own busy time is the next pass's wait, four times over.
    const busy = share.waitMs() / 4;
    expect(busy).toBeGreaterThan(0);
    expect(busy).toBeLessThanOrEqual(target.time() - started);
  });

  it('compares at once for a person\'s input, waiting only for a pass that holds the page', () => {
    const target = fixture(SMALL, {
      tick: 1,
      sheets: [sheet('main:hover .gone { display: block }')],
      passShare: (now) => createPassShareLedger({ now }),
    });
    target.open();
    target.runTimers();
    const share = target.passShare!;
    const first = target.byId('first');
    // A scan kept the tab busy for 10 ms: a hover waits for the share.
    share.note(10);
    target.ack();
    let compared = target.probe();
    target.timers.splice(0);
    target.event('pointerover', first);
    target.flushFrames();
    expect(target.probe()).toBe(compared);
    expect(target.timers).toHaveLength(1);
    // A click does not: it is compared in the next frame.
    target.event('click', first);
    target.flushFrames();
    expect(target.probe()).toBe(compared + 1);
    // Its work counts: the share after it is longer still.
    expect(share.waitMs()).toBeGreaterThan(0);

    // While another pass holds the page, a key waits all the same.
    compared = target.probe();
    const other = {};
    share.begin(other);
    target.event('keydown', first);
    target.flushFrames();
    expect(target.probe()).toBe(compared);
    // The wait set for the hover is still armed; once the page is free,
    // it brings the comparison.
    expect(target.timers).toHaveLength(1);
    share.release(other);
    target.timers.splice(0)[0]!.callback();
    target.flushFrames();
    expect(target.probe()).toBe(compared + 1);
  });

  it('keeps a semantic scan waiting for the time a comparison used', () => {
    const target = fixture(SMALL, {
      tick: 0,
      passShare: (now) => createPassShareLedger({ now }),
    });
    const passShare = target.passShare!;
    target.open();
    const messages: SemanticSourceBatch[] = [];
    const listeners = new Set<(message: unknown) => void>();
    const port: SemanticSourcePort = {
      name: createSemanticSourcePortName('comparison-semantic', 'isolated-html'),
      postMessage: (message: SemanticSourceBatch) => messages.push(message),
      onMessage: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
      },
      onDisconnect: { addListener: () => {}, removeListener: () => {} },
      disconnect: () => {},
    } as unknown as SemanticSourcePort;
    const timers: Array<{ callback: () => void; delay: number }> = [];
    let nextId = 1;
    const ids = new WeakMap<object, number>();
    const semantic = new SemanticSourceSession({
      port,
      document: target.document,
      window: target.window,
      bridge: 'isolated-html',
      secretClassifier: new StickySourceSecretClassifier(),
      getNodeId: (node) => {
        if (!ids.has(node)) ids.set(node, nextId++);
        return ids.get(node)!;
      },
      createMutationObserver: () => ({ observe: () => {}, disconnect: () => {}, takeRecords: () => [] }),
      schedule: (callback) => callback(),
      setTimer: (callback, delay) => {
        timers.push({ callback, delay });
        return timers.at(-1);
      },
      clearTimer: () => {},
      now: () => target.time(),
      yieldToMain: async () => {},
      passShare,
    });
    const semanticIdentity = {
      sessionId: 'comparison-semantic',
      pageEpoch: 1,
      generation: 1,
      documentId: 'comparison-document',
      frameId: 0,
    };
    const emit = (message: unknown) => {
      for (const listener of [...listeners]) listener(message);
    };
    emit(createSemanticSourceStart(
      'isolated-html',
      semanticIdentity,
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    emit(createSemanticSourceAck(
      semanticIdentity,
      messages[0]!.policyFingerprint,
      messages[0]!.sequence,
    ));
    expect(messages).toHaveLength(1);
    // A comparison that keeps the tab busy: each style read takes 5 ms.
    const style = target.window.getComputedStyle;
    Object.defineProperty(target.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        target.advance(5);
        return style(element);
      },
    });
    const compared = target.probe();
    target.mutate(attributeRecord(target.byId('panel'), 'class', ''));
    target.flushFrames();
    Object.defineProperty(target.window, 'getComputedStyle', { configurable: true, value: style });
    expect(target.probe()).toBe(compared + 1);
    expect(passShare.waitMs()).toBeGreaterThan(0);
    const before = timers.length;
    semantic.refresh();
    // The scan waits: no batch, a timer for when the share allows it.
    expect(messages).toHaveLength(1);
    expect(timers.length).toBe(before + 1);
    expect(timers.at(-1)!.delay).toBe(passShare.waitMs());
    semantic.dispose();
  });
});

describe('the changes the live comparison leaves out (D164)', () => {
  /** A mirror whose style poll has read the sheets once. */
  function polled(sheets: unknown[], markup = SMALL) {
    const target = fixture(markup, { sheets });
    target.open();
    target.runTimers();
    return target;
  }

  /** How many comparisons `change` led to, its frames flushed. */
  function comparisonsAfter(target: ReturnType<typeof fixture>, change: () => void): number {
    target.ack();
    const before = target.probe();
    change();
    target.flushFrames();
    return target.probe() - before;
  }

  it('sends an attribute no sheet names without comparing, and compares one a sheet names', () => {
    const target = polled([sheet('.gone { display: none }', 'main p { margin: 0 }')]);
    const first = target.byId('first');
    const sent = target.patches().length;
    expect(comparisonsAfter(target, () =>
      target.mutate(attributeRecord(first, 'data-x', 'on')))).toBe(0);
    // The patch of the attribute itself goes out.
    expect(target.patches()).toHaveLength(sent + 1);
    expect(comparisonsAfter(target, () =>
      target.mutate(attributeRecord(first, 'class', 'card')))).toBe(0);
    expect(comparisonsAfter(target, () =>
      target.mutate(attributeRecord(first, 'aria-label', 'First')))).toBe(0);
    expect(comparisonsAfter(target, () =>
      target.mutate(attributeRecord(first, 'aria-hidden', 'false')))).toBe(1);
    expect(comparisonsAfter(target, () =>
      target.mutate(attributeRecord(first, 'id', 'renamed')))).toBe(1);
    expect(comparisonsAfter(target, () =>
      target.mutate(attributeRecord(target.byId('panel'), 'class', '')))).toBe(1);
  });

  it('compares an attribute a sheet names or reads', () => {
    for (const rule of ['[data-x] + div { display: none }', 'p::after { content: attr(data-x) }']) {
      const target = polled([sheet(rule)]);
      expect(comparisonsAfter(target, () =>
        target.mutate(attributeRecord(target.byId('first'), 'data-x', 'on')))).toBe(1);
    }
  });

  it('compares everything before the poll has read every sheet, beside an unreadable sheet, and after a rule was inserted', () => {
    const early = fixture(SMALL, { sheets: [sheet('.gone {}')] });
    early.open();
    expect(comparisonsAfter(early, () =>
      early.mutate(attributeRecord(early.byId('first'), 'data-x', 'on')))).toBe(1);

    const crossOrigin = {
      get cssRules(): never {
        throw new Error('SecurityError');
      },
      disabled: false,
      media: { mediaText: '' },
      ownerNode: null,
    };
    const unreadable = polled([sheet('.gone {}'), crossOrigin]);
    expect(comparisonsAfter(unreadable, () =>
      unreadable.mutate(attributeRecord(unreadable.byId('first'), 'data-x', 'on')))).toBe(1);

    const changing = sheet('.gone {}');
    const inserted = polled([changing]);
    expect(comparisonsAfter(inserted, () =>
      inserted.mutate(attributeRecord(inserted.byId('first'), 'data-x', 'on')))).toBe(0);
    changing.cssRules.push({ cssText: '[data-x] ~ div { display: block }' });
    expect(comparisonsAfter(inserted, () =>
      inserted.mutate(attributeRecord(inserted.byId('first'), 'data-x', 'off')))).toBe(1);
  });

  it('compares everything beside a sheet watched only by its shape', () => {
    const big = sheet(...Array.from({ length: 4_001 }, (_, index) => `.r${index} { margin: 0 }`));
    const target = polled([big]);
    expect(comparisonsAfter(target, () =>
      target.mutate(attributeRecord(target.byId('first'), 'data-x', 'on')))).toBe(1);
  });

  it('leaves out a hover no sheet reads, and compares a click always', () => {
    const plain = polled([sheet('.gone { display: none }')]);
    const first = plain.byId('first');
    expect(comparisonsAfter(plain, () => plain.event('pointerover', first))).toBe(0);
    expect(plain.frames).toHaveLength(0);
    expect(comparisonsAfter(plain, () => plain.event('focusin', first))).toBe(0);
    expect(comparisonsAfter(plain, () => plain.event('click', first))).toBe(1);

    const hover = polled([sheet('main:hover .gone { display: block }')]);
    expect(comparisonsAfter(hover, () => hover.event('pointerover', hover.byId('first')))).toBe(1);
    // A sheet that reads the hover has a focus compared too: a key that
    // scrolls the page moves the hover with no pointer event.
    expect(comparisonsAfter(hover, () => hover.event('focusin', hover.byId('first')))).toBe(1);
    const focus = polled([sheet('main:focus-within .gone { display: block }')]);
    expect(comparisonsAfter(focus, () => focus.event('focusout', focus.byId('first')))).toBe(1);
  });

  it('compares a key or a pointer beside a pseudo-class a script changes with no mutation', () => {
    // A key handler that writes `input.checked` changes no attribute.
    const checked = polled([sheet('input:checked ~ .gone { display: block }')]);
    for (const type of ['keydown', 'keyup', 'pointerover', 'focusin']) {
      expect(comparisonsAfter(checked, () => checked.event(type, checked.byId('first'))), type)
        .toBe(1);
    }
    // What only a mutation changes leaves them out.
    const tree = polled([sheet('main p:first-child:not(.x) ~ .gone, p::before { display: block }')]);
    for (const type of ['keydown', 'keyup', 'pointerover', 'focusin']) {
      expect(comparisonsAfter(tree, () => tree.event(type, tree.byId('first'))), type).toBe(0);
    }
  });
});

describe('a panel a full window of batches behind (D164)', () => {
  /** Four patches the panel has not answered, then a fifth change, held. */
  function behind() {
    const target = fixture(SMALL);
    target.open();
    const first = target.byId('first');
    for (const value of ['one', 'two', 'three', 'four']) {
      target.mutate(attributeRecord(first, 'data-x', value));
      target.flushFrames();
    }
    expect(target.patches()).toHaveLength(4);
    const timers = target.timers.length;
    target.mutate(attributeRecord(first, 'data-x', 'five'));
    target.flushFrames();
    expect(target.patches()).toHaveLength(4);
    // The hold sets one timer, and a change held after it sets no other.
    expect(target.timers).toHaveLength(timers + 1);
    const hold = target.timers.at(-1)!;
    expect(hold.delay).toBe(5_000);
    target.mutate(attributeRecord(first, 'data-x', 'six'));
    target.flushFrames();
    expect(target.timers).toHaveLength(timers + 1);
    const overflowed = () => target.port.posts.some(
      (message) => (message as { code?: string }).code === 'stream_overflow',
    );
    return { target, hold, overflowed };
  }

  it('sends what was held at an ACK within five seconds, and runs nothing over', () => {
    const { target, hold, overflowed } = behind();
    target.advance(4_000);
    target.port.emit(createHtmlMirrorAck(identity, 1));
    target.flushFrames();
    expect(target.timers).not.toContain(hold);
    expect(target.patches()).toHaveLength(5);
    expect(JSON.stringify(target.patches().at(-1))).toContain('six');
    expect(overflowed()).toBe(false);
  });

  it('runs the stream over when no ACK came in five seconds', () => {
    const { target, hold, overflowed } = behind();
    target.advance(5_000);
    target.timers.splice(target.timers.indexOf(hold), 1);
    hold.callback();
    expect(overflowed()).toBe(true);
    // Paused, as before D164: nothing more is sent until a fresh copy.
    const posts = target.port.posts.length;
    target.mutate(attributeRecord(target.byId('first'), 'data-x', 'seven'));
    target.flushFrames();
    expect(target.port.posts).toHaveLength(posts);
  });

  it('ends the hold, and its timer, with a checkpoint or the end of the session', () => {
    const asked = behind();
    asked.target.port.emit(createHtmlMirrorCheckpointRequest(identity, 4));
    expect(asked.target.timers).not.toContain(asked.hold);
    expect(asked.overflowed()).toBe(false);

    const ended = behind();
    ended.target.session.dispose();
    expect(ended.target.timers).not.toContain(ended.hold);
  });
});
