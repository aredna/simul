import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// How often a reader has stopped listening: nothing else tells that a closed
// session has let go of the page.
const stopped = vi.hoisted(() => ({ count: 0 }));
vi.mock('../lib/replica/source-held-animation', async (importOriginal) => {
  const real = await importOriginal<
    typeof import('../lib/replica/source-held-animation')
  >();
  return {
    ...real,
    listenForSourceHeldAnimations: (
      ...given: Parameters<typeof real.listenForSourceHeldAnimations>
    ) => {
      const stop = real.listenForSourceHeldAnimations(...given);
      return () => {
        stopped.count += 1;
        stop();
      };
    },
  };
});

import {
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  decodeHtmlMirrorWireMessage,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchBatch,
} from '../lib/replica/html-mirror-protocol';
import {
  createHtmlMirrorRepresentabilityCollector,
  sanitizeCss,
  sanitizeSourceDocument,
  type HtmlMirrorNode,
} from '../lib/replica/html-mirror-sanitizer';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
} from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import {
  beginSourceHeldAnimationPass,
  listenForSourceHeldAnimations,
  listSourceHeldAnimations,
  readSourceHeldAnimationStyle,
} from '../lib/replica/source-held-animation';
import { SourceVisibilityBoundaryIndex } from
  '../lib/replica/source-visibility-boundary';

/** A stand-in for what `element.animate()` returns. */
class FakeAnimation {
  playState = 'finished';
  /** Where it rests: 1 at its end, 0 at its start (reversed). */
  progress: number | null = 1;
  pseudoElement: string | null = null;
  composite = 'replace';
  iterationComposite: string | undefined;
  keyframeReads = 0;
  readonly #listeners = new Map<string, Array<() => void>>();

  constructor(
    public target: Element | null,
    public keyframes: readonly Record<string, unknown>[],
  ) {}

  get effect() {
    return {
      target: this.target,
      pseudoElement: this.pseudoElement,
      composite: this.composite,
      iterationComposite: this.iterationComposite,
      getKeyframes: () => {
        this.keyframeReads += 1;
        return this.keyframes;
      },
      getComputedTiming: () => ({ progress: this.progress }),
    };
  }

  addEventListener(type: string, listener: () => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  listenerCount(type: string): number {
    return this.#listeners.get(type)?.length ?? 0;
  }

  emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

/** Keyframes as `getKeyframes()` gives them: spread evenly, a lone one at the end. */
function frames(
  ...list: Record<string, unknown>[]
): Record<string, unknown>[] {
  return list.map((frame, index) => ({
    offset: null,
    easing: 'linear',
    composite: 'auto',
    computedOffset: list.length === 1 ? 1 : index / (list.length - 1),
    ...frame,
  }));
}

const fade = () => frames({ opacity: '0.01' }, { opacity: '1' });

/** What the tree lists: the animations of its elements, as one list. */
function animate(
  tree: object,
  animations: readonly unknown[] | (() => readonly unknown[]),
): { calls: number } {
  const counter = { calls: 0 };
  Object.defineProperty(tree, 'getAnimations', {
    configurable: true,
    value: () => {
      counter.calls += 1;
      return [...(typeof animations === 'function' ? animations() : animations)];
    },
  });
  return counter;
}

/** One pass that lists the given trees. */
function pass(
  document: unknown,
  trees: readonly unknown[] = [document],
  whole = false,
  now: () => number = () => 1,
): void {
  const open = beginSourceHeldAnimationPass(document as Document, whole, now);
  for (const tree of trees) open.list(tree as Document);
  open.end();
}

/** Computed values by element; anything else reads as the given default. */
function computeStyles(
  window: unknown,
  values: (element: Element) => Record<string, string>,
): { asked: Element[] } {
  const record = { asked: [] as Element[] };
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: (element: Element) => {
      record.asked.push(element);
      const own = values(element);
      return {
        display: own.display ?? 'block',
        visibility: own.visibility ?? 'visible',
        opacity: own.opacity ?? '1',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: (name: string) => own[name] ?? ({
          'content-visibility': 'visible',
          clip: 'auto',
          'clip-path': 'none',
          'overflow-x': 'visible',
          'overflow-y': 'visible',
        } as Record<string, string>)[name] ?? '',
      };
    },
  });
  return record;
}

function page(markup: string) {
  const { document, window } = parseHTML(
    `<!doctype html><html><head></head><body>${markup}</body></html>`,
  );
  return { document, window, box: document.querySelector('#box')! };
}

function hears(document: unknown) {
  const heard = { changed: [] as Element[], ended: 0 };
  const stop = listenForSourceHeldAnimations(document as Document, {
    changed: (element) => heard.changed.push(element),
    ended: () => {
      heard.ended += 1;
    },
  });
  return { heard, stop };
}

describe('what a script animation leaves an element at', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });

  it('writes the values the keyframe it rests at states, as stated', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    const computed = computeStyles(window, () => ({ width: '200px', height: '21px' }));
    animate(document, [new FakeAnimation(box, frames(
      { opacity: '0.01', transform: 'translateY(40px)', width: '10px' },
      {
        opacity: '1',
        transform: 'none',
        backgroundColor: 'red',
        cssFloat: 'left',
        cssOffset: 'none',
        '--shiftX': ' 4px ',
        width: '50%',
        height: 'auto',
      },
    ))]);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    pass(document);
    // A share of the parent stays a share, and `auto` grows with its text.
    expect(readSourceHeldAnimationStyle(box)).toBe(
      'opacity:1;transform:none;background-color:red;float:left;offset:none;' +
      '--shiftX:4px;width:50%;height:auto',
    );
    expect(computed.asked).toEqual([]);
  });

  it('writes the first keyframe for an animation that rests at its start', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    computeStyles(window, () => ({}));
    const reversed = new FakeAnimation(box, frames(
      { opacity: '0.3', color: 'red' },
      { opacity: '1' },
    ));
    reversed.progress = 0;
    animate(document, [reversed]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:0.3;color:red');
  });

  it('writes the computed value where the keyframe does not state what is drawn', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    const element = (id: string) => document.querySelector(`#${id}`) ?? box;
    computeStyles(window, () => ({
      opacity: '0.5',
      width: '120px',
      color: 'rgb(1, 2, 3)',
    }));
    // Added to what lies under it, by the effect or by the keyframe.
    const added = new FakeAnimation(box, frames({ width: '0px' }, { width: '20px' }));
    added.composite = 'add';
    animate(document, [added]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('width:120px');
    added.composite = 'accumulate';
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('width:120px');
    // A keyframe that says `replace` in an effect that adds is stated.
    added.keyframes = frames({ width: '0px' }, { width: '20px', composite: 'replace' });
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('width:20px');
    added.composite = 'replace';
    added.keyframes = frames(
      { width: '0px', opacity: '0' },
      { width: '20px', opacity: '1', composite: 'add' },
    );
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('width:120px;opacity:0.5');
    added.keyframes = frames({ width: '0px' }, { width: '20px' });
    added.iterationComposite = 'accumulate';
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('width:120px');
    // Resting between two keyframes: every property either names.
    const halfway = new FakeAnimation(box, frames(
      { opacity: '0', color: 'red' },
      { opacity: '1' },
    ));
    halfway.progress = 0.5;
    animate(document, [halfway]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:0.5;color:rgb(1, 2, 3)');
    expect(element('box')).toBe(box);
  });

  it('leaves to the page\'s own style a property no keyframe states where it rests', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    const computed = computeStyles(window, () => ({ opacity: '1', color: 'blue' }));
    // The end keyframe is at 0.8: at 1 an implicit one holds the element's own value.
    const early = new FakeAnimation(box, [
      { computedOffset: 0, composite: 'auto', opacity: '0', color: 'red' },
      { computedOffset: 0.8, composite: 'auto', opacity: '0.5' },
    ]);
    animate(document, [early]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    // Stated at the end for one property only: that one.
    early.keyframes = [
      { computedOffset: 0, composite: 'auto', opacity: '0', color: 'red' },
      { computedOffset: 1, composite: 'auto', opacity: '0.5' },
    ];
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:0.5');
    // Of several keyframes at the end, the last is the one drawn.
    early.keyframes = [
      { computedOffset: 1, composite: 'auto', opacity: '0.5', color: 'red' },
      { computedOffset: 1, composite: 'auto', opacity: '0.7' },
    ];
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:0.7;color:red');
    expect(computed.asked).toEqual([]);
  });

  it('gives each property the value of the last animation that holds it', () => {
    const { document, window, box } = page('<div id="box">text</div><p id="other">x</p>');
    computeStyles(window, () => ({ color: 'rgb(9, 9, 9)' }));
    const other = document.querySelector('#other')!;
    const added = new FakeAnimation(box, frames({ color: 'red' }));
    added.composite = 'add';
    animate(document, [
      new FakeAnimation(box, frames({ opacity: '0.5', width: '10px' })),
      new FakeAnimation(other, frames({ opacity: '0.2' })),
      new FakeAnimation(box, frames({ opacity: '1' })),
      added,
    ]);
    pass(document);
    // Named again by a later one: that one's value, in that one's place.
    expect(readSourceHeldAnimationStyle(box))
      .toBe('width:10px;opacity:1;color:rgb(9, 9, 9)');
    expect(readSourceHeldAnimationStyle(other)).toBe('opacity:0.2');
  });

  it('holds nothing for an animation that runs, is paused, or a sheet made', () => {
    const { document, window, box } = page('<div id="box">text</div><p id="other"></p>');
    computeStyles(window, () => ({ opacity: '1' }));
    const running = new FakeAnimation(box, fade());
    running.playState = 'running';
    const paused = new FakeAnimation(box, fade());
    paused.playState = 'paused';
    const idle = new FakeAnimation(box, fade());
    idle.playState = 'idle';
    const before = new FakeAnimation(box, fade());
    before.pseudoElement = '::before';
    const nowhere = new FakeAnimation(null, fade());
    const cssAnimation = Object.assign(new FakeAnimation(box, fade()), {
      animationName: 'fade',
    });
    const cssTransition = Object.assign(new FakeAnimation(box, fade()), {
      transitionProperty: 'opacity',
    });
    for (const animation of [
      running, paused, idle, before, nowhere, cssAnimation, cssTransition,
    ]) {
      animate(document, [animation]);
      pass(document);
      expect(readSourceHeldAnimationStyle(box)).toBe('');
    }
    // One that holds, among them, is read.
    animate(document, [running, cssAnimation, new FakeAnimation(box, fade()), paused]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
  });

  it('reads nothing where animations cannot be listed or read', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    computeStyles(window, () => ({ opacity: '1' }));
    // A tree that cannot list.
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: () => {
        throw new Error('unreadable');
      },
    });
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    const broken = new FakeAnimation(box, fade());
    Object.defineProperty(broken, 'effect', {
      get: () => {
        throw new Error('unreadable');
      },
    });
    animate(document, [broken, null, 'text', 7]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    // Keyframes that cannot be read hold nothing; another animation's do.
    const unreadable = new FakeAnimation(box, []);
    unreadable.keyframes = new Proxy([], {
      get: () => {
        throw new Error('unreadable');
      },
    });
    animate(document, [unreadable, new FakeAnimation(box, fade())]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    // A computed style that cannot be read leaves that property out.
    const added = new FakeAnimation(box, frames({ width: '1px' }));
    added.composite = 'add';
    animate(document, [new FakeAnimation(box, fade()), added]);
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: () => {
        throw new Error('unreadable');
      },
    });
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
  });

  it('writes no value that is empty, too long, or could end the declaration', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    computeStyles(window, () => ({ '--a': 'computed', '--e': 'x}y' }));
    animate(document, [new FakeAnimation(box, frames({
      color: '',
      '--a': 'x;y',
      '--b': '{z',
      '--c': 'c'.repeat(4_097),
      '--d': 'd'.repeat(4_096),
      '--e': 'e}',
      opacity: 1,
    }))]);
    pass(document);
    // What cannot be written as stated is written as computed, if that can be.
    expect(readSourceHeldAnimationStyle(box))
      .toBe(`--a:computed;--d:${'d'.repeat(4_096)}`);
  });

  it('names at most 64 properties for one animation', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    computeStyles(window, () => ({}));
    const many = (from: number) => Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`--p${from + index}`, String(index)]),
    );
    const animation = new FakeAnimation(box, [
      { computedOffset: 1, composite: 'auto', ...many(0) },
      // One already named may still change; a new one is not taken.
      { computedOffset: 1, composite: 'auto', '--p0': 'again', '--q': 'new' },
    ]);
    animate(document, [animation]);
    pass(document);
    const held = readSourceHeldAnimationStyle(box).split(';');
    expect(held).toHaveLength(64);
    expect(held[0]).toBe('--p0:again');
    expect(held.at(-1)).toBe('--p63:63');
  });

  it('writes a held name only when it is one name', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    const computed = computeStyles(window, () => ({ color: 'rgb(200, 0, 0)' }));
    // Chrome takes any key that begins with `--` for a custom property.
    animate(document, [new FakeAnimation(box, frames({
      '--a;color:rgb(200,0,0);position:fixed;--b': '1',
      '--a b': '1',
      '--a:b': '1',
      '--a{b': '1',
      '--a}b': '1',
      '--a\\b': '1',
      '--a"b': '1',
      '--a/**/b': '1',
      '--a(b)': '1',
      '--a,b': '1',
      '--a!b': '1',
      '--': '1',
      'color;position': 'fixed',
      // These are names.
      '--shiftX': '2',
      '--a_b-c9': '3',
      '--9': '4',
      '---x': '5',
      '--gr\u00f6\u00dfe': '6',
      WebkitLineClamp: '7',
      opacity: '1',
    }))]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe(
      '--shiftX:2;--a_b-c9:3;--9:4;---x:5;--gr\u00f6\u00dfe:6;-webkit-line-clamp:7;opacity:1',
    );
    // A key that is no name is not read as computed either.
    const added = new FakeAnimation(box, frames({ '--a;color:red': '1', width: '1px' }));
    added.composite = 'add';
    animate(document, [added]);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    expect(computed.asked).toEqual([box]);
  });

  it('lists a tree once in a pass and asks nothing of an element', () => {
    const { document, window, box } = page('<div id="box">text</div><div id="host"></div>');
    computeStyles(window, () => ({}));
    const host = document.querySelector('#host')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<b id="inner">inner</b>';
    const inner = root.querySelector('#inner')!;
    let asked = 0;
    for (const element of [box, host, inner]) {
      Object.defineProperty(element, 'getAnimations', {
        configurable: true,
        value: () => {
          asked += 1;
          return [];
        },
      });
    }
    const documentList = animate(document, [new FakeAnimation(box, fade())]);
    // A root lists its own; the document's list leaves them out.
    const rootList = animate(root, [new FakeAnimation(inner, frames({ color: 'red' }))]);

    // No pass is open: the reader entering a root lists nothing.
    listSourceHeldAnimations(root as unknown as ShadowRoot);
    expect(rootList.calls).toBe(0);

    const open = beginSourceHeldAnimationPass(document as unknown as Document, false, () => 1);
    open.list(document as unknown as Document);
    open.list(document as unknown as Document);
    expect(readSourceHeldAnimationStyle(inner)).toBe('');
    listSourceHeldAnimations(root as unknown as ShadowRoot);
    listSourceHeldAnimations(root as unknown as ShadowRoot);
    open.list(root as unknown as ShadowRoot);
    open.end();
    expect(documentList.calls).toBe(1);
    expect(rootList.calls).toBe(1);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    expect(readSourceHeldAnimationStyle(inner)).toBe('color:red');
    // The next pass lists them again.
    pass(document, [document, root]);
    expect(documentList.calls).toBe(2);
    expect(rootList.calls).toBe(2);
    // And after it, with none open, nothing is listed.
    listSourceHeldAnimations(root as unknown as ShadowRoot);
    expect(rootList.calls).toBe(2);
    expect(asked).toBe(0);
  });

  it('keeps what a root lists for an element that came to it from the document', () => {
    const { document, window, box } = page('<div id="box">text</div><div id="host"></div>');
    computeStyles(window, () => ({}));
    const root = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    const animation = new FakeAnimation(box, fade());
    let inRoot = false;
    animate(document, () => (inRoot ? [] : [animation]));
    animate(root, () => (inRoot ? [animation] : []));
    const { heard } = hears(document);
    pass(document, [document, root]);
    expect(heard.changed).toEqual([box]);
    // Moved: whichever tree is listed first, the root's answer stands.
    inRoot = true;
    pass(document, [root, document]);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    inRoot = false;
    pass(document, [root, document]);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    inRoot = true;
    pass(document, [document, root]);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    // Gone from both: withdrawn.
    animate(root, []);
    pass(document, [document, root]);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
  });

  it('tells its listeners whose held values changed, and when a running one ends', () => {
    const { document, window, box } = page('<div id="box">text</div><p id="other">x</p>');
    computeStyles(window, () => ({ opacity: '1' }));
    const other = document.querySelector('#other')!;
    const running = new FakeAnimation(box, fade());
    running.playState = 'running';
    const css = Object.assign(new FakeAnimation(box, fade()), { animationName: 'fade' });
    css.playState = 'running';
    const paused = new FakeAnimation(other, fade());
    paused.playState = 'paused';
    animate(document, [running, css, paused]);
    const failing = listenForSourceHeldAnimations(document as unknown as Document, {
      changed: () => {
        throw new Error('another reader fails');
      },
      ended: () => {
        throw new Error('another reader fails');
      },
    });
    const { heard, stop } = hears(document);
    // A reader of another document hears nothing of this one.
    const elsewhere = hears(page('<p id="box"></p>').document);
    pass(document);
    pass(document);
    // Its end is listened for once, however often it is listed; never a
    // sheet's, nor one that does not run.
    expect(running.listenerCount('finish')).toBe(1);
    expect(running.listenerCount('cancel')).toBe(0);
    expect(css.listenerCount('finish')).toBe(0);
    expect(paused.listenerCount('finish')).toBe(0);
    expect(heard).toEqual({ changed: [], ended: 0 });

    running.playState = 'finished';
    running.emit('finish');
    expect(heard).toEqual({ changed: [], ended: 1 });
    pass(document);
    expect(heard).toEqual({ changed: [box], ended: 1 });
    // The same again is no change.
    pass(document);
    expect(heard.changed).toEqual([box]);
    expect(elsewhere.heard).toEqual({ changed: [], ended: 0 });

    stop();
    failing();
    running.emit('finish');
    animate(document, []);
    pass(document);
    expect(heard).toEqual({ changed: [box], ended: 1 });
  });

  it('withdraws or renews at the next pass what the page changed without an event', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    let width = '120px';
    computeStyles(window, () => ({ width }));
    const animation = new FakeAnimation(box, fade());
    let listed: unknown[] = [animation];
    animate(document, () => listed);
    const { heard } = hears(document);
    pass(document);
    expect(heard.changed).toEqual([box]);

    // The fill taken away, or the effect removed: no longer listed.
    listed = [];
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    expect(heard.changed).toEqual([box, box]);
    pass(document);
    expect(heard.changed).toHaveLength(2);

    // Set back and paused: listed, and holding nothing at rest.
    listed = [animation];
    pass(document);
    animation.playState = 'paused';
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    expect(heard.changed).toHaveLength(4);

    // Other keyframes (`setKeyframes`): the new value.
    animation.playState = 'finished';
    pass(document);
    animation.keyframes = frames({ opacity: '0.01' }, { opacity: '0.3' });
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:0.3');
    expect(heard.changed).toHaveLength(6);

    // Run again the other way: what it rests at then is read afresh.
    animation.playState = 'running';
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    animation.playState = 'finished';
    animation.progress = 0;
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:0.01');

    // A computed value is read again at every pass.
    animation.composite = 'add';
    animation.keyframes = frames({ width: '10px' });
    animation.progress = 1;
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('width:120px');
    width = '60px';
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('width:60px');
  });

  it('keeps hold of the animations it listed, for a browser that forgets one nothing refers to', async () => {
    const { document, window, box } = page('<div id="box">text</div><p id="other">x</p>');
    computeStyles(window, () => ({}));
    const other = document.querySelector('#other')!;
    // As Chrome 138 lists: only the animations something still refers to.
    const listed: WeakRef<object>[] = [];
    (() => {
      const running = new FakeAnimation(other, fade());
      running.playState = 'running';
      listed.push(new WeakRef(new FakeAnimation(box, fade())), new WeakRef(running));
    })();
    const alive = () => listed
      .map((reference) => reference.deref())
      .filter((animation) => animation !== undefined);
    animate(document, alive);
    const { stop } = hears(document);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    await collectGarbage();
    // Both are still there: the ended one, and the one whose end is awaited.
    expect(alive()).toHaveLength(2);
    pass(document);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    // With no reader left, nothing of the page is kept hold of.
    stop();
    await collectGarbage();
    expect(alive()).toHaveLength(0);
  });

  it('reads the keyframes of 512 ended animations again in a pass, the next ones in the next', () => {
    const { document, window } = page('<div id="box"></div>');
    computeStyles(window, () => ({}));
    const elements = Array.from({ length: 1_200 }, () => {
      const element = document.createElement('i');
      document.body.append(element);
      return element;
    });
    const animations = elements.map((element) => new FakeAnimation(element, fade()));
    const running = new FakeAnimation(elements[0]!, fade());
    running.playState = 'running';
    // One that does not hold is not counted among them.
    const list = animate(document, [running, ...animations]);
    const reads = () => animations.reduce((sum, animation) => sum + animation.keyframeReads, 0);
    pass(document);
    expect(reads()).toBe(1_200);
    expect(list.calls).toBe(1);

    // Changed since: each is noticed when its turn comes. The first pass
    // read them all, so the turn is now with the 513th.
    animations[3]!.keyframes = frames({ opacity: '0.2' });
    animations[600]!.keyframes = frames({ opacity: '0.6' });
    animations[1_100]!.keyframes = frames({ opacity: '0.4' });
    const held = () => [3, 600, 1_100].map(
      (index) => readSourceHeldAnimationStyle(elements[index]!),
    );
    pass(document);
    expect(reads()).toBe(1_200 + 512);
    expect(held()).toEqual(['opacity:1', 'opacity:0.6', 'opacity:1']);
    pass(document);
    expect(reads()).toBe(1_200 + 512 + 176);
    expect(held()).toEqual(['opacity:1', 'opacity:0.6', 'opacity:0.4']);
    // And from the start again.
    pass(document);
    expect(reads()).toBe(1_200 + 512 + 176 + 512);
    expect(held()).toEqual(['opacity:0.2', 'opacity:0.6', 'opacity:0.4']);
    expect(list.calls).toBe(4);
    // A tree that holds no more than 512 has them all read again in every pass.
    animate(document, animations.slice(0, 512));
    pass(document);
    pass(document);
    animations[511]!.keyframes = frames({ opacity: '0.7' });
    pass(document);
    expect(readSourceHeldAnimationStyle(elements[511]!)).toBe('opacity:0.7');
    animate(document, [running, ...animations]);
    pass(document);

    // One seen running in between is read afresh when it has ended, though
    // its turn has not come (the turn is with the 1,025th by then).
    const early = animations[100]!;
    early.playState = 'running';
    pass(document);
    early.playState = 'finished';
    early.progress = 0;
    const before = early.keyframeReads;
    pass(document);
    expect(early.keyframeReads).toBe(before + 1);
    expect(readSourceHeldAnimationStyle(elements[100]!)).toBe('opacity:0.01');
  });

  it('lists no oftener than a twentieth of the time, except for a whole read', () => {
    const { document, window, box } = page('<div id="box">text</div>');
    computeStyles(window, () => ({}));
    let time = 1_000;
    let listed: unknown[] = [];
    const list = { calls: 0 };
    Object.defineProperty(document, 'getAnimations', {
      configurable: true,
      value: () => {
        list.calls += 1;
        // Listing takes 10 ms.
        time += 10;
        return [...listed];
      },
    });
    const now = () => time;
    pass(document, [document], false, now);
    expect(list.calls).toBe(1);
    // Within 200 ms of its end, a pass lists nothing and reads what was worked out.
    listed = [new FakeAnimation(box, fade())];
    time += 199;
    pass(document, [document], false, now);
    expect(list.calls).toBe(1);
    expect(readSourceHeldAnimationStyle(box)).toBe('');
    // A whole read lists whenever it comes, and a pass inside another is that one.
    const outer = beginSourceHeldAnimationPass(document as unknown as Document, false, now);
    outer.list(document as unknown as Document);
    expect(list.calls).toBe(1);
    const inner = beginSourceHeldAnimationPass(document as unknown as Document, true, now);
    inner.list(document as unknown as Document);
    inner.end();
    outer.list(document as unknown as Document);
    outer.end();
    expect(list.calls).toBe(2);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:1');
    // And so does a whole read that comes by itself.
    listed = [new FakeAnimation(box, frames({ opacity: '0.5' }))];
    pass(document, [document], true, now);
    expect(list.calls).toBe(3);
    expect(readSourceHeldAnimationStyle(box)).toBe('opacity:0.5');
    // After its share of the time has passed, the next pass lists again.
    time += 199;
    pass(document, [document], false, now);
    expect(list.calls).toBe(3);
    time += 1;
    pass(document, [document], false, now);
    expect(list.calls).toBe(4);
    // A pass that did not list sets no new wait.
    time += 200;
    pass(document, [], false, now);
    pass(document, [document], false, now);
    expect(list.calls).toBe(5);
  });

  it('travels after the element\'s own style, each read through the sanitizer', () => {
    const { document, window } = page(`
      <div id="plain">plain</div>
      <div id="styled" style="opacity:0.2; color: rgb(150, 20, 20)">styled</div>
      <div id="none">none</div>
      <div id="unsafe">unsafe</div>
      <div id="unsafe2">unsafe too</div>
      <div id="escaped" style="font-family: 'a\\'('; width: calc(1px">an escaped quote</div>
      <div id="mismatch" style="width: calc(1px ] + (2px">a bracket of another kind</div>
      <div id="mixed" style="--a: (1px [2px">two kinds of bracket</div>
      <div id="bracket" style="width: calc(10px + (2px">cut off in a bracket</div>
      <div id="string" style="color: red; font-family: 'Open">cut off in a string</div>
      <div id="broken" style="content: 'a&#10;(b'">a string a line break ends</div>
      <div id="comment" style="color: red; /* cut off">cut off in a comment</div>
      <div id="escape" style="color: red\\">cut off in an escape</div>
      <div id="refused" style="width: expression(alert(1))">refused</div>
      <div id="blank" style="  ">blank</div>
      <select id="pick"><option id="choice">One</option></select>`);
    const element = (id: string) => document.querySelector(`#${id}`)!;
    computeStyles(window, () => ({}));
    const held = (id: string, keyframe: Record<string, unknown> = { opacity: '1', transform: 'none' }) =>
      new FakeAnimation(element(id), frames({ opacity: '0.01' }, keyframe));
    animate(document, [
      held('plain'),
      held('styled'),
      held('unsafe', { backgroundImage: 'url("javascript:alert(1)")', opacity: '1' }),
      // The same again: what was made safe once is made safe each time.
      held('unsafe2', { backgroundImage: 'url("javascript:alert(1)")', opacity: '1' }),
      held('escaped'),
      held('mismatch'),
      held('mixed'),
      held('bracket'),
      held('string'),
      held('broken'),
      held('comment'),
      held('escape'),
      held('refused'),
      held('blank'),
      held('choice'),
    ]);
    pass(document);
    const graph = sanitizeSourceDocument(
      document as unknown as Document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      undefined,
      'passive',
    )!;
    const style = (id: string) => attributesOf(graph.root, id).style;
    expect(style('plain')).toBe('opacity:1;transform:none');
    expect(style('styled'))
      .toBe('opacity:0.2; color: rgb(150, 20, 20);opacity:1;transform:none');
    expect(style('none')).toBeUndefined();
    // A held value is made safe like any other the page's style holds.
    expect(style('unsafe')).not.toContain('javascript');
    expect(style('unsafe2')).toBe(style('unsafe'));
    expect(style('escaped'))
      .toBe("font-family: 'a\\'('; width: calc(1px);opacity:1;transform:none");
    expect(style('mismatch'))
      .toBe('width: calc(1px ] + (2px));opacity:1;transform:none');
    expect(style('mixed')).toBe('--a: (1px [2px]);opacity:1;transform:none');
    expect(JSON.stringify(graph)).not.toContain('javascript');
    // What the page's own style leaves open is closed before the held values.
    expect(style('bracket'))
      .toBe('width: calc(10px + (2px));opacity:1;transform:none');
    expect(style('escape')).toBe('color: red;opacity:1;transform:none');
    // An own style that is refused does not take the held values with it,
    // nor does one that would not read, with them, as it was written.
    for (const id of ['string', 'comment', 'refused', 'broken']) {
      expect(style(id), id).toBe('opacity:1;transform:none');
    }
    expect(style('blank')).toBe('opacity:1;transform:none');
    // An option's style never travels, held or not.
    expect(JSON.stringify(graph)).not.toMatch(/"choice"[^\]]*\]\s*,\s*\["style"/u);
    // Each of them reads the same when the panel reads it again.
    for (const id of ['styled', 'bracket', 'string', 'broken', 'comment', 'escape']) {
      const value = style(id)!;
      expect(sanitizeCss(value, 'https://example.test/', true, undefined, 'passive'), id)
        .toBe(value);
    }
  });

  it('reads what a slotted element holds as for one in the same kind of box of the page, and none of its text', () => {
    // A child of a host is read by the boxes around its slot: hidden, or
    // edited. What its ended animation holds is how the element is drawn,
    // not the page's text: it is read with the element's style in either
    // tree, in a hidden box and in an editor as anywhere, and the text is
    // withheld in both trees alike.
    const { document, window } = page(`
      <p id="plain">plain text</p>
      <div hidden><p id="in-hidden">in a hidden box</p></div>
      <div contenteditable="true"><p id="in-editor">in an editor</p></div>
      <x-one id="one"><p id="slotted-hidden">slotted into a hidden box</p></x-one>
      <x-two id="two"><p id="slotted-editor">slotted into an editor</p></x-two>`);
    const element = (id: string) => document.querySelector(`#${id}`)!;
    for (const [host, markup] of [
      ['one', '<div hidden><slot></slot></div>'],
      ['two', '<div contenteditable="true"><slot></slot></div>'],
    ] as const) {
      const root = element(host).attachShadow({ mode: 'open' });
      root.innerHTML = markup;
      // linkedom assigns no slots: the test says what Chrome would.
      Object.defineProperty(element(host).firstElementChild, 'assignedSlot', {
        configurable: true,
        value: root.querySelector('slot'),
      });
      animate(root, []);
    }
    computeStyles(
      window,
      (given): Record<string, string> => given.hasAttribute('hidden') ? { display: 'none' } : {},
    );
    const ids = ['plain', 'in-hidden', 'in-editor', 'slotted-hidden', 'slotted-editor'];
    animate(document, ids.map((id) => new FakeAnimation(element(id), fade())));
    pass(document);
    const graph = sanitizeSourceDocument(
      document as unknown as Document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      undefined,
      'passive',
    )!;
    for (const id of ids) {
      expect(attributesOf(graph.root, id).style, id).toBe('opacity:1');
    }
    const sent = JSON.stringify(graph.root);
    expect(sent).toContain('plain text');
    for (const withheld of [
      'in a hidden box', 'in an editor',
      'slotted into a hidden box', 'slotted into an editor',
    ]) expect(sent, withheld).not.toContain(withheld);
  });

  it('sends one style for an element, with what it holds, however the page spells its own', () => {
    const { document, window } = page(`
      <div id="twin" style="color: red">the page's style and another spelled STYLE</div>
      <div id="alone">only one spelled STYLE</div>
      <div id="none">no style at all</div>
      <select><option id="choice" style="color: red">One</option></select>`);
    const element = (id: string) => document.querySelector(`#${id}`)!;
    computeStyles(window, () => ({}));
    // As `setAttributeNS(null, 'STYLE', …)` in an HTML document: another
    // attribute to Chrome, which travels as `style` when it stands alone.
    element('twin').setAttribute('STYLE', 'color: blue');
    element('alone').setAttribute('STYLE', 'color: green');
    const read = () => {
      const counted = createHtmlMirrorRepresentabilityCollector();
      const graph = sanitizeSourceDocument(
        document as unknown as Document,
        window as unknown as Window,
        new WeakNodeIdRegistry(),
        counted,
        'passive',
      )!;
      return { graph, counted };
    };
    // Nothing is held yet: what is left out of the page is counted once.
    animate(document, []);
    pass(document);
    const before = read().counted;

    animate(document, ['twin', 'alone', 'none', 'choice'].map(
      (id) => new FakeAnimation(element(id), fade()),
    ));
    pass(document);
    const { graph, counted } = read();
    const styles = (id: string) => nodeOf(graph.root, id).attributes
      .filter(([name]) => name === 'style')
      .map(([, value]) => value);
    expect(styles('twin')).toEqual(['color: red;opacity:1']);
    expect(styles('alone')).toEqual(['color: green;opacity:1']);
    expect(styles('none')).toEqual(['opacity:1']);
    // An element that has a style is not read as if it had a second one: an
    // option's, which never travels, is counted as left out once, as before.
    expect(counted.strippedActiveAttributeCount)
      .toBe(before.strippedActiveAttributeCount);
  });

  it('compares afresh only what the given elements hold', () => {
    const { document, window } = page(`
      <section id="held"><p id="inside">inside</p></section>
      <section id="apart"><p id="outside">outside</p></section>`);
    void document.head;
    const element = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
    for (const current of [...document.querySelectorAll('*')]) {
      Object.defineProperty(current, 'getClientRects', {
        configurable: true,
        value: () => rectList(),
      });
    }
    const hidden = new Set<Element>([element('held'), element('apart')]);
    computeStyles(window, (current) => ({
      visibility: [...hidden].some((box) => box.contains(current))
        ? 'hidden'
        : 'visible',
    }));
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      100,
    );
    // Both boxes are shown now, and only one is asked about.
    hidden.clear();
    expect(index.refreshWithin([])).toEqual({ changedTargets: [], overflow: false });
    expect(index.refreshWithin([element('held')]))
      .toEqual({ changedTargets: [element('held')], overflow: false });
    expect(index.refreshWithin([element('held')]).changedTargets).toEqual([]);
    // The other is found by the next whole comparison, as before.
    expect(index.refreshAll().changedTargets).toEqual([element('apart')]);
    // One of them inside the other is one root, and a gone one is none.
    hidden.add(element('held'));
    expect(index.refreshWithin([element('inside'), element('held')]).changedTargets)
      .toEqual([element('held')]);
    const apart = element('apart');
    apart.remove();
    expect(index.refreshWithin([apart]).changedTargets).toEqual([]);
    index.dispose();
  });

  it('walks a nest of given elements once, not once for each of them', () => {
    const depth = 40;
    const { document, window } = page(
      `${'<div class="n">'.repeat(depth)}innermost${'</div>'.repeat(depth)}`,
    );
    void document.head;
    const nest = [...document.querySelectorAll<HTMLElement>('.n')];
    for (const current of [...document.querySelectorAll('*')]) {
      Object.defineProperty(current, 'getClientRects', {
        configurable: true,
        value: () => rectList(),
      });
    }
    computeStyles(window, () => ({}));
    // It may walk 200 elements: the page holds 43, and the nest walked once
    // for each of its 40 would be 820.
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      200,
    );
    expect(index.refreshWithin(nest)).toEqual({ changedTargets: [], overflow: false });
    expect(index.refreshWithin([...nest].reverse()).overflow).toBe(false);
    index.dispose();
  });

  it('says so when what the given elements hold is more than it may walk', () => {
    const { document, window } = page(
      '<section id="held"><p>one</p><p>two</p><p>three</p></section>',
    );
    void document.head;
    for (const current of [...document.querySelectorAll('*')]) {
      Object.defineProperty(current, 'getClientRects', {
        configurable: true,
        value: () => rectList(),
      });
    }
    computeStyles(window, () => ({}));
    const index = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      8,
    );
    const held = document.querySelector('#held')!;
    expect(index.refreshWithin([held]).overflow).toBe(false);
    // The box holds more now than the index may walk: this answer says so,
    // and so does every later one.
    for (let count = 0; count < 12; count += 1) {
      const more = document.createElement('p');
      Object.defineProperty(more, 'getClientRects', {
        configurable: true,
        value: () => rectList(),
      });
      held.append(more);
    }
    expect(index.refreshWithin([held]).overflow).toBe(true);
    expect(index.refreshWithin([]).overflow).toBe(true);
    const small = new SourceVisibilityBoundaryIndex(
      document as unknown as Document,
      window as unknown as Window,
      3,
    );
    // The first walk already ran out: every later answer says so.
    expect(small.refreshWithin([document.querySelector('#held')!]).overflow)
      .toBe(true);
  });

  it('sends the held values with the page, and again when the animation ends or lets go', () => {
    const fixture = sessionFixture(`
      <div id="box" class="wrapper"><p id="inside">dialog text</p></div>
      <p id="apart">other text</p>`);
    const box = fixture.document.querySelector<HTMLElement>('#box')!;
    computeStyles(fixture.window, () => ({}));
    const animation = new FakeAnimation(box, fade());
    animation.playState = 'running';
    let listed: unknown[] = [animation];
    const list = animate(fixture.document, () => listed);
    let asked = 0;
    Object.defineProperty(box, 'getAnimations', {
      configurable: true,
      value: () => {
        asked += 1;
        return [];
      },
    });

    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    // Running: the sheet's value stands, and nothing of Simul's is added.
    expect(attributesOf(fixture.checkpoints()[0]!.payload.root, 'box').style)
      .toBeUndefined();
    expect(fixture.frames).toHaveLength(0);
    // The whole read listed the page's animations once.
    expect(list.calls).toBe(1);

    // It ends holding its last frame: nothing in the page records that.
    animation.playState = 'finished';
    animation.emit('finish');
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(list.calls).toBe(2);
    expect(fixture.patches()).toHaveLength(1);
    expect(fixture.patches()[0]!.operations).toEqual([
      expect.objectContaining({
        kind: 'attributes',
        nodeId: fixture.registry.peekId(box),
        attributes: expect.arrayContaining([['style', 'opacity:1']]),
      }),
    ]);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    expect(fixture.frames).toHaveLength(0);

    // The same end heard twice sends nothing more.
    animation.emit('finish');
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    expect(fixture.frames).toHaveLength(0);

    // The page takes the fill away, which no event tells: the reader's
    // periodic look finds the value gone, and the element is back at what
    // the sheet says.
    listed = [];
    fixture.tick();
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(2);
    const attributes = (fixture.patches()[1]!.operations[0] as {
      attributes: readonly (readonly [string, string])[];
    }).attributes;
    expect(attributes.some(([name]) => name === 'style')).toBe(false);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 2));

    // An animation a timer started and that ended since, with nothing else
    // happening on the page: found by the same look.
    listed = [new FakeAnimation(box, frames({ color: 'red' }))];
    fixture.tick();
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches()[2])).toContain('color:red');
    // A look that finds nothing new asks for no frame.
    fixture.tick();
    expect(fixture.frames).toHaveLength(0);
    expect(asked).toBe(0);
  });

  it('reads the held values of the page and of each shadow root with the whole page, and after', () => {
    const fixture = sessionFixture('<div id="box">held from the start</div><div id="host"></div>');
    computeStyles(fixture.window, () => ({}));
    const box = fixture.document.querySelector('#box')!;
    const root = fixture.document.querySelector('#host')!.attachShadow({ mode: 'open' });
    root.innerHTML = '<b id="inner">inner</b>';
    const inner = root.querySelector('#inner')!;
    const documentList = animate(fixture.document, [new FakeAnimation(box, fade())]);
    const held = new FakeAnimation(inner, fade());
    const rootList = animate(root, [held]);
    fixture.start();
    expect(documentList.calls).toBe(1);
    expect(rootList.calls).toBe(1);
    const page = fixture.checkpoints()[0]!.payload.root;
    expect(attributesOf(page, 'box').style).toBe('opacity:1');
    expect(attributesOf(page, 'inner').style).toBe('opacity:1');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    // Nothing of that read is owed again.
    expect(fixture.frames).toHaveLength(0);
    fixture.tick();
    expect(fixture.frames).toHaveLength(0);
    // The root is listed with the page from then on (the look after one
    // that found nothing is a second away).
    held.keyframes = frames({ opacity: '0.4' });
    fixture.tick();
    fixture.tick();
    fixture.flushFrame();
    expect(fixture.patches()).toHaveLength(1);
    expect(JSON.stringify(fixture.patches()[0])).toContain('opacity:0.4');
  });

  it('lists for a whole read even when a look is not due', () => {
    let time = 1_000;
    const fixture = sessionFixture('<div id="box">text</div>', () => time);
    computeStyles(fixture.window, () => ({}));
    const box = fixture.document.querySelector('#box')!;
    let listed: unknown[] = [];
    const list = { calls: 0 };
    Object.defineProperty(fixture.document, 'getAnimations', {
      configurable: true,
      value: () => {
        list.calls += 1;
        // Listing takes 10 ms.
        time += 10;
        return [...listed];
      },
    });
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(list.calls).toBe(1);
    // Within the wait that listing set, the periodic look lists nothing.
    listed = [new FakeAnimation(box, fade())];
    fixture.tick();
    expect(list.calls).toBe(1);
    expect(fixture.frames).toHaveLength(0);
    // A whole read does, and has the value.
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(list.calls).toBe(2);
    expect(attributesOf(fixture.checkpoints()[1]!.payload.root, 'box').style)
      .toBe('opacity:1');
  });

  it('looks less often at a page at rest, and every half second again when something happens', () => {
    const fixture = sessionFixture('<div id="box">text</div>');
    const box = fixture.document.querySelector('#box')!;
    computeStyles(fixture.window, () => ({}));
    let listed: unknown[] = [];
    const list = animate(fixture.document, () => listed);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(list.calls).toBe(1);
    // Each tick is half a second. A look that changes nothing doubles the
    // wait: after 1, 2, 4 and 8 ticks, and every 8 from then on.
    const looks: number[] = [];
    for (let tick = 1; tick <= 40; tick += 1) {
      const before = list.calls;
      fixture.tick();
      if (list.calls > before) looks.push(tick);
    }
    expect(looks).toEqual([1, 3, 7, 15, 23, 31, 39]);
    expect(fixture.frames).toHaveLength(0);

    // An animation that a timer started and that ended since is found by the
    // next look, 4 s after the last at worst; what it finds is sent, and the
    // look is half a second off again.
    listed = [new FakeAnimation(box, fade())];
    for (let tick = 0; tick < 8; tick += 1) fixture.tick();
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('opacity:1');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    let calls = list.calls;
    fixture.tick();
    expect(list.calls).toBe(calls + 1);
    fixture.tick();
    expect(list.calls).toBe(calls + 1);

    // So it is after any flush, whatever asked for it: here the end of an
    // animation that was running.
    const running = new FakeAnimation(box, fade());
    running.playState = 'running';
    listed = [...listed, running];
    fixture.tick();
    expect(running.listenerCount('finish')).toBe(1);
    for (let tick = 0; tick < 3; tick += 1) fixture.tick();
    calls = list.calls;
    running.emit('finish');
    fixture.flushFrame();
    expect(list.calls).toBe(calls + 1);
    fixture.tick();
    expect(list.calls).toBe(calls + 2);
    // And after a whole read.
    for (let tick = 0; tick < 3; tick += 1) fixture.tick();
    calls = list.calls;
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 1));
    expect(list.calls).toBe(calls + 1);
    fixture.port.emitMessage(createHtmlMirrorAck(
      identity,
      fixture.checkpoints().at(-1)!.identity.sequence,
    ));
    expect(fixture.errors()).toEqual([]);
    fixture.tick();
    expect(list.calls).toBe(calls + 2);
  });

  it('reads again what an element holds when its animation shows it, and not the page', () => {
    const fixture = sessionFixture(`
      <div id="box"><p id="inside">shown by the animation</p></div>
      <p id="apart">other text</p>`);
    const { document } = fixture;
    void document.head;
    const box = document.querySelector<HTMLElement>('#box')!;
    for (const current of [...document.querySelectorAll('*')]) {
      Object.defineProperty(current, 'getClientRects', {
        configurable: true,
        value: () => rectList(),
      });
    }
    let visibility = 'hidden';
    const computed = computeStyles(fixture.window, (current) => ({
      visibility: box.contains(current) ? visibility : 'visible',
    }));
    const show = new FakeAnimation(
      box,
      frames({ visibility: 'hidden' }, { visibility: 'visible' }),
    );
    show.playState = 'running';
    let listed: unknown[] = [show];
    animate(document, () => listed);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(JSON.stringify(fixture.checkpoints()[0])).not.toContain('shown by the animation');

    show.playState = 'finished';
    visibility = 'visible';
    computed.asked.length = 0;
    show.emit('finish');
    fixture.flushFrame();
    const patch = JSON.stringify(fixture.patches().at(-1));
    expect(patch).toContain('shown by the animation');
    expect(patch).toContain('visibility:visible');
    // Only the element and what it holds were compared, not the page.
    expect(computed.asked).not.toContain(document.querySelector('#apart'));
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    // And only once: the next change, to another element, leaves it alone.
    const apart = document.querySelector('#apart')!;
    listed = [show, new FakeAnimation(apart, frames({ color: 'red' }))];
    computed.asked.length = 0;
    fixture.tick();
    fixture.flushFrame();
    expect(computed.asked).toContain(apart);
    expect(computed.asked).not.toContain(box);
  });

  it('sends thousands of held values that come at once as a few patches, never more pending than the stream takes', () => {
    const fixture = sessionFixture('<div id="box"></div>');
    const { document } = fixture;
    computeStyles(fixture.window, () => ({}));
    const elements = Array.from({ length: 4_500 }, () => {
      const element = document.createElement('i');
      document.body.append(element);
      return element;
    });
    let listed: unknown[] = [];
    animate(document, () => listed);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    listed = elements.map((element) => new FakeAnimation(element, fade()));
    fixture.tick();
    const sizes: number[] = [];
    while (fixture.frames.length > 0) {
      fixture.flushFrame();
      const patch = fixture.patches().at(-1)!;
      sizes.push(patch.operations.length);
      fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().length));
    }
    expect(sizes).toEqual([1_000, 1_000, 1_000, 1_000, 500]);
    expect(fixture.errors()).toEqual([]);

    // A panel that does not keep up is sent a whole read instead, as for
    // any stream it falls behind on: that read has every held value.
    listed = elements.map((element) => new FakeAnimation(element, frames({ opacity: '0.5' })));
    fixture.tick();
    while (fixture.frames.length > 0) fixture.flushFrame();
    expect(fixture.errors()).toEqual(['stream_overflow']);
    const sequence = fixture.patches().length;
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, sequence));
    const checkpoint = JSON.stringify(fixture.checkpoints().at(-1));
    expect(checkpoint.match(/opacity:0\.5/gu)).toHaveLength(4_500);
    // Nothing of what that read holds is sent again after it.
    fixture.port.emitMessage(createHtmlMirrorAck(identity, sequence + 1));
    expect(fixture.frames).toHaveLength(0);
  });

  it('hears nothing for an element the mirror does not hold, or after it is closed', () => {
    const fixture = sessionFixture('<div id="box">text</div>');
    const box = fixture.document.querySelector('#box')!;
    computeStyles(fixture.window, () => ({}));
    const animation = new FakeAnimation(box, fade());
    animation.playState = 'running';
    let listed: unknown[] = [animation];
    const list = animate(fixture.document, () => listed);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    // An element that is not in the page, and one that has left it.
    const apart = fixture.document.createElement('div');
    box.remove();
    listed = [new FakeAnimation(apart, fade()), new FakeAnimation(box, fade())];
    fixture.tick();
    while (fixture.frames.length > 0) fixture.flushFrame();
    expect(fixture.patches()).toEqual([]);

    // A closed session no longer listens or looks.
    const stops = stopped.count;
    fixture.session.dispose();
    expect(stopped.count).toBe(stops + 1);
    const calls = list.calls;
    animation.emit('finish');
    fixture.tick();
    expect(fixture.frames).toHaveLength(0);
    expect(list.calls).toBe(calls);
  });
});

const identity = createReplicaIdentity({
  sessionId: 'animation-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'animation-document',
  frameId: 0,
  sequence: 0,
});

class FakePortEvent<T extends (...arguments_: never[]) => void> {
  readonly #listeners = new Set<T>();
  addListener(listener: T): void {
    this.#listeners.add(listener);
  }
  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }
  emit(...arguments_: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...arguments_);
  }
}

class FakePort {
  readonly posts: unknown[] = [];
  readonly onMessage = new FakePortEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakePortEvent<() => void>();
  readonly disconnect = vi.fn();
  constructor(readonly name: string) {}
  postMessage(message: unknown): void {
    this.posts.push(decodeHtmlMirrorWireMessage(message));
  }
  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

function sessionFixture(markup: string, now: () => number = () => 1) {
  const { document, window } = parseHTML(
    `<!doctype html><html><head></head><body>${markup}</body></html>`,
  );
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.test/',
  });
  const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
  const registry = new WeakNodeIdRegistry();
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const session = new HtmlMirrorSourceSession({
    port: port as unknown as Browser.runtime.Port,
    document,
    window: window as unknown as Window,
    registry,
    now,
    createMutationObserver: () => ({ observe: vi.fn(), disconnect: vi.fn() }),
    scheduleFrame: (callback) => {
      frames.push(callback);
      return callback;
    },
    cancelFrame: (handle) => {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    document,
    window,
    port,
    registry,
    session,
    frames,
    start: () => port.emitMessage(createHtmlMirrorStart(identity, 'passive')),
    flushFrame: () => {
      const frame = frames.shift();
      if (!frame) throw new Error('Expected a scheduled mirror frame.');
      frame();
    },
    /** The reader's periodic look: every timer that is waiting, once. */
    tick: () => {
      for (const timer of timers.splice(0)) timer();
    },
    errors: () => port.posts
      .filter((message) =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:error')
      .map((message) => (message as { code?: string }).code),
    checkpoints: () => port.posts.filter(
      (message): message is HtmlMirrorCheckpoint =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:checkpoint',
    ),
    patches: () => port.posts.filter(
      (message): message is HtmlMirrorPatchBatch =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:patch',
    ),
  };
}

/** A full garbage collection, once what this turn touched may be let go of. */
async function collectGarbage(): Promise<void> {
  setFlagsFromString('--expose-gc');
  const collect = runInNewContext('gc') as () => void;
  await new Promise((resolve) => setTimeout(resolve, 0));
  collect();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function rectList(): DOMRectList {
  const rects = [{
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40,
    toJSON: () => ({}),
  } as DOMRect];
  return Object.assign(rects, {
    item: (index: number) => rects[index] ?? null,
  }) as unknown as DOMRectList;
}

function attributesOf(root: HtmlMirrorNode, id: string): Record<string, string> {
  return Object.fromEntries(nodeOf(root, id).attributes);
}

function nodeOf(root: HtmlMirrorNode, id: string) {
  const pending: HtmlMirrorNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind !== 'element') continue;
    if (node.attributes.some(([name, value]) => name === 'id' && value === id)) {
      return node;
    }
    pending.push(...node.children, ...(node.shadowRoot?.children ?? []));
  }
  throw new Error(`No element #${id}.`);
}
