import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { openChromeHtmlMirrorStream } from '../lib/replica/html-mirror-client';
import { applyHtmlMirrorLimitSettings } from '../lib/replica/html-mirror-limits';
import {
  assembleHtmlMirrorCheckpoint,
  createHtmlMirrorAck,
  createHtmlMirrorCheckpoint,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  decodeHtmlMirrorWireMessage,
  encodeHtmlMirrorWireMessage,
  readHtmlMirrorCheckpointPart,
  readHtmlMirrorSourceMessage,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorCheckpointPart,
  type HtmlMirrorPatchBatch,
} from '../lib/replica/html-mirror-protocol';
import {
  createHtmlMirrorRepresentabilityCollector,
  sanitizeSourceDocument,
} from '../lib/replica/html-mirror-sanitizer';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
} from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import { createSourceControlledContentPolicy } from '../lib/replica/source-privacy-policy';

/**
 * The page reader's first read in slices (D163), end to end in the page
 * script: a clock that moves with every reading of it, and turns between
 * the slices that the test hands out one by one.
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
  sessionId: 'orchestration-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'orchestration-document',
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
    // Over the wire, as the panel reads it.
    this.posts.push(decodeHtmlMirrorWireMessage(
      JSON.parse(JSON.stringify(encodeHtmlMirrorWireMessage(message))),
    ));
  }

  emit(message: unknown): void {
    for (const listener of [...this.#listeners]) listener(message);
  }
}

/**
 * Gives every element a box (`data-top` places it, 40 px high at the top
 * otherwise) and the window a size and a computed style: inline tags are
 * inline, the rest block.
 */
function paint(document: Document, window: Window): void {
  for (const element of document.querySelectorAll('*')) {
    const top = Number(element.getAttribute('data-top') ?? 0);
    const rect = {
      x: 0, y: top, left: 0, top, right: 320, bottom: top + 40,
      width: 320, height: 40, toJSON: () => ({}),
    } as DOMRect;
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => rect,
    });
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => Object.assign([rect], { item: (i: number) => i === 0 ? rect : null }),
    });
  }
  const style = (element: Element) => ({
    display: ['span', 'b', 'i', 'a', 'em', 'label'].includes(element.localName)
      ? 'inline'
      : 'block',
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
  });
  for (const [name, value] of [
    ['getComputedStyle', style],
    ['innerWidth', 1200],
    ['innerHeight', 800],
  ] as const) {
    Object.defineProperty(window, name, { configurable: true, value });
  }
  onTestFinished(() => {
    // linkedom's windows share one object: leave none of this to the next.
    for (const name of ['getComputedStyle', 'innerWidth', 'innerHeight']) {
      delete (window as unknown as Record<string, unknown>)[name];
    }
  });
}

interface FixtureOptions {
  /** How far the clock moves at each reading; 0 stands it still. */
  readonly tick?: number;
}

function fixture(markup: string, options: FixtureOptions = {}) {
  const { document, window } = parseHTML(
    `<!doctype html><html><head></head><body>${markup}</body></html>`,
  );
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.test/',
  });
  paint(document as unknown as Document, window as unknown as Window);
  const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
  const registry = new WeakNodeIdRegistry();
  const frames: Array<() => void> = [];
  const turns: Array<() => void> = [];
  let time = 0;
  let tick = options.tick ?? 0;
  let mutationCallback: MutationCallback | undefined;
  const session = new HtmlMirrorSourceSession({
    port: port as unknown as Browser.runtime.Port,
    document: document as unknown as Document,
    window: window as unknown as Window,
    registry,
    now: () => (time += tick),
    yieldToMain: () => new Promise<void>((resolve) => turns.push(resolve)),
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
    setTimer: () => 1,
    clearTimer: () => {},
  });
  const ofKind = <T,>(kind: string) => () =>
    port.posts.filter((message): message is T =>
      (message as { kind?: string }).kind === kind);
  const checkpoints = ofKind<HtmlMirrorCheckpoint>('simul:html-mirror-v2:checkpoint');
  const parts = ofKind<HtmlMirrorCheckpointPart>('simul:html-mirror-v2:checkpoint-part');
  const patches = ofKind<HtmlMirrorPatchBatch>('simul:html-mirror-v2:patch');
  const errors = ofKind<{ code: string }>('simul:html-mirror-v2:error');
  /** Gives the page the turn it waits for, and lets the read go on to its next. */
  const turn = async (): Promise<void> => {
    const next = turns.shift();
    if (!next) throw new Error('No turn is waited for.');
    next();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return {
    document: document as unknown as Document,
    window: window as unknown as Window,
    port,
    registry,
    session,
    frames,
    turns,
    checkpoints,
    parts,
    patches,
    errors,
    turn,
    setTick: (value: number) => {
      tick = value;
    },
    start: (limits?: Parameters<typeof createHtmlMirrorStart>[2]) =>
      port.emit(createHtmlMirrorStart(identity, 'conservative', limits)),
    mutate: (...records: MutationRecord[]) =>
      mutationCallback!(records, {} as MutationObserver),
    /** Hands out turns until none is waited for; `between` runs before each. */
    async settle(between: () => void = () => {}): Promise<number> {
      let count = 0;
      for (; turns.length > 0; count += 1) {
        if (count > 20_000) throw new Error('The read does not end.');
        between();
        await turn();
      }
      return count;
    },
    byId: (id: string) => document.getElementById(id) as unknown as Element,
  };
}

type Fixture = ReturnType<typeof fixture>;

/** The checkpoint a read in one task sends of the page as it is now. */
function oneTaskCheckpoint(target: Fixture, sequence: number): HtmlMirrorCheckpoint {
  const representability = createHtmlMirrorRepresentabilityCollector();
  const graph = sanitizeSourceDocument(
    target.document,
    target.window,
    target.registry,
    representability,
    'conservative',
    createSourceControlledContentPolicy(target.document, target.window),
  )!;
  expect(graph).toBeDefined();
  return createHtmlMirrorCheckpoint(
    { ...identity, sequence },
    {
      root: graph.root,
      adoptedStyleSheets: graph.adoptedStyleSheets,
      documentMode: graph.documentMode,
      captureMs: 0,
      viewportWidth: graph.viewportWidth,
      viewportHeight: graph.viewportHeight,
      documentWidth: graph.documentWidth,
      documentHeight: graph.documentHeight,
      representability,
    },
  )!;
}

/** What the panel assembles from the closing checkpoint and its parts. */
function assembled(target: Fixture, closing: HtmlMirrorCheckpoint): HtmlMirrorCheckpoint {
  const received = readHtmlMirrorSourceMessage(closing, identity);
  expect(received?.kind).toBe('simul:html-mirror-v2:checkpoint');
  const parts = target.parts()
    .filter((part) => part.identity.sequence === closing.identity.sequence)
    .map((part) => readHtmlMirrorCheckpointPart(part, identity)!);
  expect(parts.every(Boolean)).toBe(true);
  const whole = assembleHtmlMirrorCheckpoint(
    received as HtmlMirrorCheckpoint,
    parts,
  );
  expect(whole).toBeDefined();
  return whole!;
}

function sameGraph(actual: HtmlMirrorCheckpoint, expected: HtmlMirrorCheckpoint): void {
  expect(actual.payload.root).toEqual(expected.payload.root);
  expect(actual.payload.adoptedStyleSheets).toEqual(expected.payload.adoptedStyleSheets);
  expect(actual.payload.representability).toEqual(expected.payload.representability);
  expect(actual.payload.documentMode).toBe(expected.payload.documentMode);
}

/** Whether a part fills the node, or holds it among what it fills. */
function partHolds(part: HtmlMirrorCheckpointPart, nodeId: number): boolean {
  return part.fills.some((fill) =>
    fill.nodeId === nodeId || JSON.stringify(fill.children).includes(`"id":${nodeId},`));
}

function characterDataRecord(target: Node): MutationRecord {
  return { type: 'characterData', target, oldValue: '' } as unknown as MutationRecord;
}

function attributeRecord(target: Element, attributeName: string): MutationRecord {
  return { type: 'attributes', target, attributeName, oldValue: null } as unknown as MutationRecord;
}

function childListRecord(target: Node, addedNodes: Node[], removedNodes: Node[] = []): MutationRecord {
  return { type: 'childList', target, addedNodes, removedNodes } as unknown as MutationRecord;
}

const SECTIONS = Array.from({ length: 8 }, (_, section) =>
  `<section id="s${section}"><h2 id="t${section}">Title ${section}</h2>` +
  Array.from({ length: 6 }, (_, row) =>
    `<div id="r${section}-${row}"><p id="p${section}-${row}">Row ${section}.${row} ` +
    `<b>bold</b> <i>it</i></p></div>`).join('') +
  `<form id="f${section}"><input id="in${section}" type="text" value="field ${section}"></form>` +
  '</section>').join('');

/** About 4,500 elements: past the preview's threshold. */
const LARGE = '<main id="main">' + Array.from({ length: 150 }, (_, block) =>
  `<section id="b${block}" data-top="${block * 1200}">` +
  Array.from({ length: 10 }, (_, row) =>
    `<p>Block ${block} row ${row} <b>x</b> <i>y</i></p>`).join('') +
  '</section>').join('') + '</main>';

/** About 1,250 elements: under the preview's threshold, over the lowest node limit. */
const MEDIUM = Array.from({ length: 40 }, (_, block) =>
  `<section id="m${block}">` +
  Array.from({ length: 10 }, (_, row) =>
    `<p>Block ${block} row ${row} <b>x</b> <i>y</i></p>`).join('') +
  '</section>').join('');

describe('the first read of a page in slices (D163)', () => {
  it('sends a page whose read fits one slice whole, in the task that starts it', () => {
    const target = fixture(SECTIONS, { tick: 0 });
    target.start();
    expect(target.checkpoints()).toHaveLength(1);
    expect(target.parts()).toEqual([]);
    expect(target.turns).toHaveLength(0);
    const [checkpoint] = target.checkpoints();
    expect(checkpoint!.identity.sequence).toBe(0);
    expect(checkpoint!.payload.partCount).toBeUndefined();
    expect(checkpoint!.payload.preview).toBeUndefined();
    sameGraph(checkpoint!, oneTaskCheckpoint(target, 0));
  });

  it('sends no preview of a large page whose read fits one slice', () => {
    const target = fixture(LARGE, { tick: 0 });
    target.start();
    expect(target.turns).toHaveLength(0);
    const [checkpoint, ...more] = target.checkpoints();
    expect(more).toEqual([]);
    expect(checkpoint!.payload.preview).toBeUndefined();
    expect(checkpoint!.identity.sequence).toBe(0);
    expect(target.parts()).toEqual([]);
  });

  it('sends a large page as a preview, then parts, then the checkpoint that closes them', async () => {
    const target = fixture(LARGE, { tick: 0.02 });
    expect(target.document.querySelectorAll('*').length).toBeGreaterThanOrEqual(4_000);
    target.start();
    const yields = await target.settle();
    expect(yields).toBeGreaterThan(3);
    const kinds = target.port.posts.map((message) =>
      (message as { kind: string }).kind.replace('simul:html-mirror-v2:', ''));
    // The preview and the document's place, then every part, then the
    // checkpoint, then the whole scroll state.
    expect(kinds[0]).toBe('checkpoint');
    expect(kinds[1]).toBe('scroll');
    const lastPart = kinds.lastIndexOf('checkpoint-part');
    expect(kinds.indexOf('checkpoint-part')).toBe(2);
    expect(kinds.slice(2, lastPart + 1).every((kind) => kind === 'checkpoint-part')).toBe(true);
    expect(kinds[lastPart + 1]).toBe('checkpoint');
    expect(kinds[lastPart + 2]).toBe('scroll');
    const [preview, closing] = target.checkpoints();
    expect(preview!.payload.preview).toBe(true);
    expect(preview!.identity.sequence).toBe(0);
    expect(JSON.stringify(preview)).toContain('"placeholder"');
    expect(JSON.stringify(preview)).not.toContain('Block 149 row 3');
    const parts = target.parts();
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.index)).toEqual(parts.map((_, index) => index));
    expect(parts.every((part) => part.identity.sequence === 1)).toBe(true);
    expect(closing!.identity.sequence).toBe(1);
    expect(closing!.payload.partCount).toBe(parts.length);
    sameGraph(assembled(target, closing!), oneTaskCheckpoint(target, 1));
    expect(target.errors()).toEqual([]);
  });

  it('installs the copy in a task of its own, after the last part (D221)', async () => {
    const target = fixture(LARGE, { tick: 0.02 });
    target.start();
    // What each task posted: the start's, then one list a turn.
    const tasks: string[][] = [];
    let seen = 0;
    const take = (): void => {
      tasks.push(target.port.posts.slice(seen).map((message) =>
        (message as { kind: string }).kind.replace('simul:html-mirror-v2:', '')));
      seen = target.port.posts.length;
    };
    await target.settle(take);
    take();
    const closing = tasks.findIndex((kinds, index) =>
      index > 0 && kinds.includes('checkpoint') &&
      tasks.slice(0, index).some((earlier) => earlier.includes('checkpoint-part')));
    expect(closing).toBeGreaterThan(0);
    expect(tasks[closing]).not.toContain('checkpoint-part');
    expect(tasks[closing - 1]).toContain('checkpoint-part');
  });

  it('resumes the stream at the copy\'s ACK, not the preview\'s, and patches what changed in a part read', async () => {
    const target = fixture(LARGE, { tick: 0.2 });
    const texts = [...target.document.querySelectorAll('section > p:first-child')]
      .map((paragraph) => paragraph.firstChild as Text);
    target.start();
    while (target.checkpoints().length === 0) await target.turn();
    expect(target.checkpoints()[0]!.payload.preview).toBe(true);
    // The panel acknowledges the preview while the page is read.
    target.port.emit(createHtmlMirrorAck(identity, 0));
    let changed = false;
    await target.settle(() => {
      if (changed) return;
      // A text a part already sent.
      const sent = texts.find((text) => target.parts().some((part) =>
        partHolds(part, target.registry.getId(text))));
      if (!sent) return;
      sent.data = 'Changed after its part';
      target.mutate(characterDataRecord(sent));
      changed = true;
    });
    expect(changed).toBe(true);
    const closing = target.checkpoints().at(-1)!;
    expect(closing.identity.sequence).toBe(1);
    // The part had been read before the change.
    expect(JSON.stringify(target.parts())).not.toContain('Changed after its part');
    expect(target.frames).toHaveLength(0);
    target.port.emit(createHtmlMirrorAck(identity, 0));
    expect(target.frames).toHaveLength(0);
    expect(target.patches()).toEqual([]);
    target.port.emit(createHtmlMirrorAck(identity, 1));
    expect(target.frames.length).toBeGreaterThan(0);
    while (target.frames.length > 0) target.frames.shift()!();
    const patches = target.patches();
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0]!.firstSequence).toBe(2);
    expect(JSON.stringify(patches)).toContain('Changed after its part');
    expect(target.errors()).toEqual([]);
  });

  it('patches after the ACK what a script animation in a wide root came to hold after its part was read', async () => {
    const target = fixture(`<div id="host"></div>${LARGE}`, { tick: 0.2 });
    const shadow = target.byId('host').attachShadow({ mode: 'open' });
    shadow.innerHTML = Array.from({ length: 400 }, (_, index) =>
      `<p id="sp${index}">root ${index} <b>b</b></p>`).join('');
    const first = shadow.firstElementChild!;
    let listed: unknown[] = [];
    Object.defineProperty(shadow, 'getAnimations', {
      configurable: true,
      value: () => [...listed],
    });
    target.start();
    while (target.checkpoints().length === 0) await target.turn();
    target.port.emit(createHtmlMirrorAck(identity, 0));
    await target.settle(() => {
      if (listed.length > 0) return;
      if (!target.parts().some((part) => partHolds(part, target.registry.getId(first)))) return;
      // A fade a script ran on the root's first paragraph, ended after its
      // part was read; the root's list goes on in a later run.
      listed = [{
        playState: 'finished',
        effect: {
          target: first,
          pseudoElement: null,
          composite: 'replace',
          getKeyframes: () => [
            { offset: null, easing: 'linear', composite: 'auto', computedOffset: 0, opacity: '0.01' },
            { offset: null, easing: 'linear', composite: 'auto', computedOffset: 1, opacity: '0.5' },
          ],
          getComputedTiming: () => ({ progress: 1 }),
        },
        addEventListener: () => {},
      }];
    });
    expect(listed).toHaveLength(1);
    const fills = target.parts().flatMap((part) => part.fills);
    const rootId = target.registry.getId(shadow);
    // The root's list was read over several fills.
    expect(fills.filter((fill) => fill.nodeId === rootId).length).toBeGreaterThan(1);
    expect(JSON.stringify(target.parts())).not.toContain('opacity:0.5');
    const closing = target.checkpoints().at(-1)!;
    target.port.emit(createHtmlMirrorAck(identity, closing.identity.sequence));
    while (target.frames.length > 0) target.frames.shift()!();
    expect(JSON.stringify(target.patches())).toContain('opacity:0.5');
    expect(target.errors()).toEqual([]);
  });

  it('reads again, rather than overflowing the copy\'s first patch, when the read\'s changes name too many nodes', async () => {
    const target = fixture(LARGE, { tick: 0.2 });
    const changed = [...target.document.querySelectorAll('p, b, i')].slice(0, 4_001);
    expect(changed.length).toBe(4_001);
    target.start();
    let flooded = false;
    await target.settle(() => {
      if (flooded || target.parts().length === 0) return;
      for (const element of changed) element.setAttribute('title', 'new');
      target.mutate(...changed.map((element) => attributeRecord(element, 'title')));
      flooded = true;
    });
    expect(flooded).toBe(true);
    const closing = target.checkpoints().at(-1)!;
    expect(closing.payload.preview).toBeUndefined();
    // Read again after the flood: the copy holds the new titles.
    expect(JSON.stringify(assembled(target, closing).payload.root)).toContain('"title","new"');
    target.port.emit(createHtmlMirrorAck(identity, closing.identity.sequence));
    while (target.frames.length > 0) target.frames.shift()!();
    expect(target.errors()).toEqual([]);
  });

  it('reads a part changed before its turn as it is then', async () => {
    const target = fixture(SECTIONS, { tick: 1 });
    target.start();
    expect(target.checkpoints()).toEqual([]);
    const lastText = target.byId('p7-5').firstChild as Text;
    const lastId = target.registry.getId(lastText);
    let changed = false;
    await target.settle(() => {
      if (changed || target.parts().length === 0) return;
      expect(target.parts().some((part) => partHolds(part, lastId))).toBe(false);
      lastText.data = 'Changed before its part ';
      target.mutate(characterDataRecord(lastText));
      changed = true;
    });
    expect(changed).toBe(true);
    expect(JSON.stringify(target.parts())).toContain('Changed before its part');
    const closing = target.checkpoints().at(-1)!;
    expect(closing.payload.partCount).toBe(target.parts().length);
    sameGraph(assembled(target, closing), oneTaskCheckpoint(target, closing.identity.sequence));
  });

  it('starts again when the page moves a node read into what is not read yet, and reads in one task the third time', async () => {
    const target = fixture(SECTIONS, { tick: 1 });
    target.start();
    const movedIn = new Set<number>();
    await target.settle(() => {
      const parts = target.parts();
      const last = parts.at(-1);
      if (!last || movedIn.has(last.identity.sequence)) return;
      // Each attempt sees another title, read early, move.
      const title = target.byId(`t${movedIn.size}`);
      const titleId = target.registry.getId(title);
      const ofAttempt = parts.filter((part) => part.identity.sequence === last.identity.sequence);
      if (!ofAttempt.some((part) => partHolds(part, titleId))) return;
      // Into one of the last sections, whose content is not read yet.
      const destination = ['7', '6', '5'].find((section) =>
        !ofAttempt.some((part) =>
          partHolds(part, target.registry.getId(target.byId(`r${section}-0`)))));
      if (!destination) return;
      const from = title.parentNode!;
      const into = target.byId(`r${destination}-5`);
      into.append(title);
      target.mutate(childListRecord(from, [], [title]), childListRecord(into, [title]));
      movedIn.add(last.identity.sequence);
    });
    // Three attempts in parts, each at a sequence of its own.
    expect([...movedIn]).toEqual([0, 1, 2]);
    expect(new Set(target.parts().map((part) => part.identity.sequence))).toEqual(new Set([0, 1, 2]));
    const [checkpoint, ...more] = target.checkpoints();
    expect(more).toEqual([]);
    // Then the page is read in one task, at a sequence no part carried.
    expect(checkpoint!.identity.sequence).toBe(3);
    expect(checkpoint!.payload.partCount).toBeUndefined();
    sameGraph(checkpoint!, oneTaskCheckpoint(target, 3));
    expect(target.errors()).toEqual([]);
    target.port.emit(createHtmlMirrorAck(identity, 2));
    expect(target.frames).toHaveLength(0);
    target.port.emit(createHtmlMirrorAck(identity, 3));
    // What was kept meanwhile is judged against the copy: nothing is owed.
    while (target.frames.length > 0) target.frames.shift()!();
    expect(target.errors()).toEqual([]);
  });

  it('masks a field that becomes a password before its part, and has the live path mask one already sent', async () => {
    const target = fixture(SECTIONS, { tick: 1 });
    target.start();
    const early = target.byId('in0') as HTMLInputElement;
    const late = target.byId('in7') as HTMLInputElement;
    const earlyId = target.registry.getId(early);
    const lateSection = target.registry.getId(late);
    let changed = false;
    await target.settle(() => {
      if (changed) return;
      const parts = target.parts();
      if (!parts.some((part) => partHolds(part, earlyId))) return;
      expect(parts.some((part) => partHolds(part, lateSection))).toBe(false);
      for (const field of [early, late]) {
        field.setAttribute('type', 'password');
        target.mutate(attributeRecord(field, 'type'));
      }
      changed = true;
    });
    expect(changed).toBe(true);
    // The early field went as a text field, the late one as a password field.
    const fieldIn = (id: string) => {
      const json = JSON.stringify(target.parts());
      const at = json.indexOf(`["id","${id}"]`);
      return json.slice(at, json.indexOf(']]', at) + 2);
    };
    expect(fieldIn('in0')).toContain('["type","text"]');
    expect(fieldIn('in7')).toContain('["type","password"]');
    expect(JSON.stringify(target.port.posts)).not.toContain('field 7');
    const closing = target.checkpoints().at(-1)!;
    target.port.emit(createHtmlMirrorAck(identity, closing.identity.sequence));
    while (target.frames.length > 0) target.frames.shift()!();
    // After the ACK: the field already sent is sent again without its value,
    // or the page is read afresh.
    const after = target.port.posts.slice(target.port.posts.indexOf(closing) + 1);
    const gap = target.errors().some((error) => error.code === 'stream_gap');
    expect(gap || JSON.stringify(after).includes('"password"')).toBe(true);
    expect(JSON.stringify(after)).not.toContain('field 0');
  });

  it('cancels a read when a checkpoint is asked for, and reads anew at a sequence of its own', async () => {
    const target = fixture(SECTIONS, { tick: 1 });
    target.start();
    while (target.parts().length === 0) await target.turn();
    expect(target.parts()[0]!.identity.sequence).toBe(0);
    const before = target.port.posts.length;
    target.port.emit(createHtmlMirrorCheckpointRequest(identity, 0));
    await target.settle();
    const after = target.port.posts.slice(before);
    const parts = after.filter((message): message is HtmlMirrorCheckpointPart =>
      (message as { kind: string }).kind === 'simul:html-mirror-v2:checkpoint-part');
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((part) => part.identity.sequence === 1)).toBe(true);
    expect(parts.map((part) => part.index)).toEqual(parts.map((_, index) => index));
    const checkpoints = target.checkpoints();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.identity.sequence).toBe(1);
    sameGraph(assembled(target, checkpoints[0]!), oneTaskCheckpoint(target, 1));
  });

  it('stops at its next turn when the session ends', async () => {
    const target = fixture(SECTIONS, { tick: 1 });
    target.start();
    await target.turn();
    const posted = target.port.posts.length;
    target.session.dispose();
    await target.settle();
    expect(target.port.posts).toHaveLength(posted);
  });

  it('hands the panel\'s client a preview, then the full copy it assembles, then patches after its ACK', async () => {
    const target = fixture(LARGE, { tick: 0.2 });
    // The client's port: what it posts reaches the page, and what the page
    // posts (over the wire) reaches it.
    const clientListeners = new Set<(message: unknown) => void>();
    const clientPort = {
      onMessage: {
        addListener: (listener: (message: unknown) => void) => clientListeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => clientListeners.delete(listener),
      },
      onDisconnect: { addListener: () => {}, removeListener: () => {} },
      postMessage: (message: unknown) =>
        target.port.emit(JSON.parse(JSON.stringify(message))),
      disconnect: vi.fn(),
    };
    const pagePost = target.port.postMessage.bind(target.port);
    target.port.postMessage = (message: unknown) => {
      pagePost(message);
      for (const listener of [...clientListeners]) listener(target.port.posts.at(-1));
    };
    vi.stubGlobal('browser', {
      scripting: {
        executeScript: vi.fn(async () => [{ frameId: 0, documentId: identity.documentId }]),
      },
      tabs: { connect: vi.fn(() => clientPort) },
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const lease = await openChromeHtmlMirrorStream({
      sessionId: identity.sessionId,
      pageEpoch: identity.pageEpoch,
      generation: identity.generation,
      documentId: identity.documentId,
      frameId: identity.frameId,
      tabId: 1,
      isCurrent: () => true,
    });
    onTestFinished(() => lease.dispose());
    let preview: HtmlMirrorCheckpoint | undefined;
    void (async () => {
      preview = await lease.initialCheckpoint;
    })();
    await target.settle();
    expect(preview?.payload.preview).toBe(true);
    expect(preview?.identity.sequence).toBe(0);
    expect(target.parts().length).toBeGreaterThan(1);

    const checkpoints: HtmlMirrorCheckpoint[] = [];
    const patches: HtmlMirrorPatchBatch[] = [];
    const failures: string[] = [];
    lease.setObserver({
      onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      onPatch: (batch) => patches.push(batch),
      onScroll: () => {},
      onFailure: (code) => failures.push(code),
    });
    expect(failures).toEqual([]);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]!.identity.sequence).toBe(1);
    expect(checkpoints[0]!.payload).not.toHaveProperty('partCount');
    sameGraph(checkpoints[0]!, oneTaskCheckpoint(target, 1));

    // The preview's ACK resumes nothing; the copy's does.
    lease.acknowledge(0);
    const text = target.document.querySelector('section > p')!.firstChild as Text;
    text.data = 'Changed after the copy';
    target.mutate(characterDataRecord(text));
    expect(target.frames).toHaveLength(0);
    lease.acknowledge(1);
    while (target.frames.length > 0) target.frames.shift()!();
    expect(patches.length).toBeGreaterThan(0);
    expect(patches[0]!.firstSequence).toBe(2);
    expect(JSON.stringify(patches)).toContain('Changed after the copy');
    expect(failures).toEqual([]);
  });

  it('answers a page over the limits with stream_overflow, once, and reads no more', async () => {
    const limits = { itemMegabytes: 10, pageMegabytes: 60, maxElements: 1_000 };
    try {
      const target = fixture(MEDIUM, { tick: 1 });
      target.start(limits);
      await target.settle();
      expect(target.checkpoints()).toEqual([]);
      expect(target.errors().map((error) => error.code)).toEqual(['stream_overflow']);
      expect(target.turns).toHaveLength(0);
    } finally {
      applyHtmlMirrorLimitSettings();
    }
  });
});

describe('a read in parts that follows the page (D171)', () => {
  /** About 4,500 elements in open roots, under a light tree of 160. */
  const COMPONENTS = '<main id="main">' + Array.from({ length: 150 }, (_, block) =>
    `<x-block id="c${block}" data-top="${block * 1200}"></x-block>`).join('') + '</main>';

  function components(tick: number) {
    const target = fixture(COMPONENTS, { tick });
    for (const host of target.document.querySelectorAll('x-block')) {
      host.attachShadow({ mode: 'open' }).innerHTML = Array.from({ length: 10 }, (_, row) =>
        `<p>Root ${host.id} row ${row} <b>x</b> <i>y</i></p>`).join('');
    }
    return target;
  }

  it('offers a page of web components its preview: the roots\' elements count', async () => {
    const target = components(0.02);
    expect(target.document.querySelectorAll('*').length).toBeLessThan(4_000);
    target.start();
    await target.settle();
    const [preview, closing] = target.checkpoints();
    expect(preview!.payload.preview).toBe(true);
    expect(closing!.payload.partCount).toBe(target.parts().length);
    sameGraph(assembled(target, closing!), oneTaskCheckpoint(target, 1));
    expect(target.errors()).toEqual([]);
  });

  /**
   * A controlled panel: painted until it is collapsed, then of no opacity,
   * which only the controlled-content policy withholds.
   */
  function withPanel(at: 'top' | 'end') {
    const panel = '<div id="panel"><p id="panel-text">Panel words</p></div>';
    const target = fixture(
      '<button id="control" aria-controls="panel" aria-expanded="true">More</button>' +
        (at === 'top' ? panel : '') + SECTIONS + (at === 'end' ? panel : ''),
      { tick: 1 },
    );
    const style = target.window.getComputedStyle;
    Object.defineProperty(target.window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        const base = style.call(target.window, element);
        return element.closest?.('[data-collapsed]') ? { ...base, opacity: '0' } : base;
      },
    });
    // Only the control's change is recorded: the panel's look changes with
    // it (a class far above, say).
    const collapse = () => {
      target.byId('panel').setAttribute('data-collapsed', '');
      target.byId('control').setAttribute('aria-expanded', 'false');
      target.mutate(attributeRecord(target.byId('control'), 'aria-expanded'));
    };
    return { target, collapse };
  }

  it('reads with the policy as it is when a panel not read yet collapses between slices', async () => {
    const { target, collapse } = withPanel('end');
    const panelText = target.byId('panel-text').firstChild as Text;
    target.start();
    let collapsed = false;
    while (target.checkpoints().length === 0) {
      if (!collapsed && target.parts().length > 0) {
        expect(target.parts().some((part) =>
          partHolds(part, target.registry.getId(panelText)))).toBe(false);
        collapse();
        collapsed = true;
      }
      await target.turn();
    }
    expect(collapsed).toBe(true);
    // One attempt: nothing read was moved by it.
    expect(new Set(target.parts().map((part) => part.identity.sequence)).size).toBe(1);
    const closing = target.checkpoints().at(-1)!;
    expect(JSON.stringify(target.parts())).not.toContain('Panel words');
    sameGraph(assembled(target, closing), oneTaskCheckpoint(target, closing.identity.sequence));
    // Judged between the slices: the copy is installed with no policy to
    // read again after it.
    expect(target.turns).toHaveLength(0);
    expect(target.errors()).toEqual([]);
  });

  it('sends again after the ACK a panel read already that the policy read again withholds', async () => {
    const { target, collapse } = withPanel('top');
    const panelText = target.byId('panel-text').firstChild as Text;
    target.start();
    let collapsed = false;
    await target.settle(() => {
      if (collapsed) return;
      if (!target.parts().some((part) => partHolds(part, target.registry.getId(panelText)))) {
        return;
      }
      collapse();
      collapsed = true;
    });
    expect(collapsed).toBe(true);
    expect(new Set(target.parts().map((part) => part.identity.sequence)).size).toBe(1);
    expect(JSON.stringify(target.parts())).toContain('Panel words');
    const closing = target.checkpoints().at(-1)!;
    target.port.emit(createHtmlMirrorAck(identity, closing.identity.sequence));
    while (target.frames.length > 0) target.frames.shift()!();
    const after = JSON.stringify(target.patches());
    expect(after).toContain(`${target.registry.getId(target.byId('panel'))}`);
    expect(after).not.toContain('Panel words');
    expect(target.errors()).toEqual([]);
  });

  it('reads the policy in slices after the copy, the first flush held, when the page kept moving it', async () => {
    const { target } = withPanel('end');
    const control = target.byId('control');
    target.start();
    // The control flips at every turn: the policy is read again twice, then
    // left to the replay after the copy.
    let flips = 0;
    while (target.checkpoints().length === 0) {
      const open = control.getAttribute('aria-expanded') !== 'true';
      control.setAttribute('aria-expanded', String(open));
      if (open) target.byId('panel').removeAttribute('data-collapsed');
      else target.byId('panel').setAttribute('data-collapsed', '');
      target.mutate(attributeRecord(control, 'aria-expanded'));
      flips += 1;
      await target.turn();
    }
    expect(flips).toBeGreaterThan(3);
    const closing = target.checkpoints().at(-1)!;
    // The policy is read in slices of its own, from the next turn.
    expect(target.turns.length).toBeGreaterThan(0);
    target.port.emit(createHtmlMirrorAck(identity, closing.identity.sequence));
    while (target.frames.length > 0) target.frames.shift()!();
    // Nothing goes out under the policy the copy was read with.
    expect(target.patches()).toEqual([]);
    await target.settle();
    while (target.frames.length > 0) target.frames.shift()!();
    // Then the panel is as the page shows it now.
    const shown = control.getAttribute('aria-expanded') === 'true';
    const sent = JSON.stringify([assembled(target, closing).payload.root, target.patches()]);
    const lastWords = sent.lastIndexOf('Panel words');
    expect(shown ? lastWords >= 0 : !JSON.stringify(target.patches()).includes('Panel words'))
      .toBe(true);
    expect(target.errors()).toEqual([]);
  });
});
