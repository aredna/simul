import { parseHTML } from 'linkedom';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import {
  createSliceClock,
  DEFAULT_SLICE_BUDGET_MS,
} from '../lib/browser-scheduling';
import {
  eagerlyClassifySourceDocumentSecrets,
  rememberSourceMutationSecrets,
  startSourceDocumentSecretScan,
} from '../lib/replica/semantic-source-session';
import {
  beginSourceControlledContentPolicy,
  createSourceControlledContentPolicy,
  hasSourceCredentialSecretAncestor,
  type SourceControlledContentPolicy,
} from '../lib/replica/source-privacy-policy';
import { StickySourceSecretClassifier } from '../lib/replica/source-secret-classifier';
import {
  installSourceShadowRootReader,
  readSourceShadowRoot,
} from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

// A small node budget, so a page past it can be built in a test. Every other
// fixture here stays well under it.
vi.mock('../lib/replica/semantic-source-protocol', async (importOriginal) => ({
  ...await importOriginal<
    typeof import('../lib/replica/semantic-source-protocol')
  >(),
  MAX_SEMANTIC_SOURCE_NODE_IDENTITIES: 300,
}));

/**
 * A clock that moves one millisecond each time it is read, and a yield that
 * runs `between` first: with a budget of `budgetMs`, a slice ends after a
 * known number of nodes.
 */
function steppingClock(
  budgetMs: number,
  between: (yields: number) => void = () => undefined,
) {
  let time = 0;
  let turns = 0;
  return createSliceClock({
    budgetMs,
    now: () => (time += 1),
    yield: async () => {
      turns += 1;
      between(turns);
    },
  });
}

/** Every node of the page, through open and closed roots, in document order. */
function allNodes(root: Node): Node[] {
  const nodes: Node[] = [];
  const visit = (node: Node): void => {
    nodes.push(node);
    for (const child of node.childNodes) visit(child);
    if (node.nodeType === 1) {
      const shadow = readSourceShadowRoot(node as Element);
      if (shadow) {
        nodes.push(shadow);
        for (const child of shadow.childNodes) visit(child);
      }
    }
  };
  visit(root);
  return nodes;
}

const SECRET_PAGE =
  '<html><body><main id="main">' +
  '<p id="public">public text</p>' +
  '<form id="form"><input id="pw" type="password">' +
  '<input id="cc" autocomplete="cc-number"><input id="name" type="text">' +
  '<section id="cc-section" autocomplete="cc-exp"><b id="cc-digit">12</b></section>' +
  '</form>' +
  '<div id="masked" class="masked"><b id="masked-child">m</b></div>' +
  '<x-open id="open"></x-open><x-closed id="closed"></x-closed>' +
  '<section id="later"><input id="turn" type="text"><p id="tail">tail</p></section>' +
  '</main></body></html>';

/** The secret page, its roots attached, and a window that masks `.masked`. */
function secretPage() {
  const { document } = parseHTML(SECRET_PAGE);
  const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
  open.innerHTML =
    '<input id="open-pw" type="password"><p id="open-public">open public</p>';
  const reader = closedRootReader();
  reader.attach(
    document.querySelector('#closed')!,
    '<section autocomplete="one-time-code"><i id="closed-digit">1</i></section>' +
      '<p id="closed-public">closed public</p>',
  );
  installSourceShadowRootReader(document as unknown as Document, reader.read);
  const sourceWindow = {
    getComputedStyle: (element: Element) => ({
      getPropertyValue: (name: string) =>
        name === '-webkit-text-security' &&
          element.getAttribute?.('class') === 'masked'
          ? 'disc'
          : 'none',
    }),
  } as unknown as Window;
  return { document: document as unknown as Document, sourceWindow };
}

function secretMarks(
  document: Document,
  classifier: StickySourceSecretClassifier,
): boolean[] {
  return allNodes(document.documentElement).map((node) => classifier.isSecret(node));
}

describe('slice clock (D163)', () => {
  it('gives a first slice its own budget, then the usual one (D169)', async () => {
    let time = 0;
    const clock = createSliceClock({
      budgetMs: 30,
      firstBudgetMs: 10,
      now: () => time,
      yield: async () => undefined,
    });
    time = 9;
    expect(clock.expired()).toBe(false);
    time = 10;
    expect(clock.expired()).toBe(true);
    await clock.next();
    time = 39;
    expect(clock.expired()).toBe(false);
    time = 40;
    expect(clock.expired()).toBe(true);
  });

  it('runs out at its budget and starts again after each yield', async () => {
    let time = 100;
    const yields: number[] = [];
    const clock = createSliceClock({
      budgetMs: 10,
      now: () => time,
      yield: async () => {
        yields.push(time);
        time += 4;
      },
    });
    expect(clock.budgetMs).toBe(10);
    expect(clock.yields).toBe(0);
    time = 109;
    expect(clock.expired()).toBe(false);
    time = 110;
    expect(clock.expired()).toBe(true);
    await clock.next();
    expect(yields).toEqual([110]);
    expect(clock.yields).toBe(1);
    // The new slice starts once the turn is over, not when it was asked for.
    time = 123;
    expect(clock.expired()).toBe(false);
    time = 124;
    expect(clock.expired()).toBe(true);
  });

  it('defaults to a 35 ms budget', () => {
    expect(DEFAULT_SLICE_BUDGET_MS).toBe(35);
    expect(createSliceClock({ now: () => 0 }).budgetMs).toBe(35);
  });
});

describe('sliced credential scan (D163)', () => {
  it('marks what the one-task scan marks, across forced slice boundaries', async () => {
    const reference = secretPage();
    const referenceClassifier = new StickySourceSecretClassifier();
    eagerlyClassifySourceDocumentSecrets(
      reference.document,
      reference.sourceWindow,
      referenceClassifier,
    );
    const expected = secretMarks(reference.document, referenceClassifier);
    // The fixture has both kinds, through both kinds of root.
    const byId = (id: string): boolean => {
      const nodes = allNodes(reference.document.documentElement);
      const node = nodes.find((candidate) =>
        (candidate as Element).id === id)!;
      return referenceClassifier.isSecret(node);
    };
    expect(byId('pw')).toBe(true);
    expect(byId('cc')).toBe(true);
    expect(byId('cc-digit')).toBe(true);
    expect(byId('masked-child')).toBe(true);
    expect(byId('open-pw')).toBe(true);
    expect(byId('closed-digit')).toBe(true);
    expect(byId('public')).toBe(false);
    expect(byId('open-public')).toBe(false);
    expect(byId('closed-public')).toBe(false);
    expect(byId('turn')).toBe(false);

    for (const budget of [1, 2, 3, 7]) {
      const page = secretPage();
      const classifier = new StickySourceSecretClassifier();
      const clock = steppingClock(budget);
      const scan = startSourceDocumentSecretScan(
        page.document,
        page.sourceWindow,
        classifier,
        clock,
      );
      expect(scan.done).toBe(false);
      await scan.finished;
      expect(scan.done).toBe(true);
      expect(clock.yields).toBeGreaterThan(1);
      expect(secretMarks(page.document, classifier)).toEqual(expected);
    }
  });

  it('scans a page that fits one slice in the calling task', () => {
    const page = secretPage();
    const classifier = new StickySourceSecretClassifier();
    const clock = createSliceClock({
      now: () => 0,
      yield: () => {
        throw new Error('a page that fits one slice never yields');
      },
    });
    const scan = startSourceDocumentSecretScan(
      page.document,
      page.sourceWindow,
      classifier,
      clock,
    );
    expect(scan.done).toBe(true);
    expect(clock.yields).toBe(0);
    expect(classifier.isSecret(page.document.querySelector('#pw')!)).toBe(true);
  });

  it('keeps a field that became a password between slices secret', async () => {
    const page = secretPage();
    const turn = page.document.querySelector('#turn')!;
    const classifier = new StickySourceSecretClassifier();
    const scan = startSourceDocumentSecretScan(
      page.document,
      page.sourceWindow,
      classifier,
      steppingClock(1, (turns) => {
        if (turns === 1) turn.setAttribute('type', 'password');
      }),
    );
    expect(scan.done).toBe(false);
    expect(classifier.isSecret(turn)).toBe(false);
    await scan.finished;
    expect(classifier.isSecret(turn)).toBe(true);
  });

  it('leaves what is added to the scanned part to the lifetime observer', async () => {
    const page = secretPage();
    const classifier = new StickySourceSecretClassifier();
    const added = page.document.createElement('input');
    added.setAttribute('type', 'password');
    const publicParagraph = page.document.querySelector('#public')!;
    const scan = startSourceDocumentSecretScan(
      page.document,
      page.sourceWindow,
      classifier,
      steppingClock(1, (turns) => {
        // Behind the cursor by now: the scan does not come back here.
        if (turns === 12) {
          publicParagraph.append(added);
          rememberSourceMutationSecrets([{
            type: 'childList',
            target: publicParagraph,
            addedNodes: [added],
            removedNodes: [],
          } as unknown as MutationRecord], page.sourceWindow, classifier, {
            freshRoots: true,
          });
        }
      }),
    );
    await scan.finished;
    expect(classifier.isSecret(added)).toBe(true);
  });

  it('reads a parent of many children one child at a time (D217)', async () => {
    // Under the node budget this file sets (300).
    const children = 250;
    const { document } = parseHTML(
      `<html><body><div id="box">${'<i></i>'.repeat(children - 1)}` +
        '<input id="last-pw" type="password"></div></body></html>',
    );
    const page = document as unknown as Document;
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;
    const box = page.querySelector('#box')!;
    // Every child the walk reads of the box's list, by index or iterator.
    const read = new Set<Node>();
    const list = box.childNodes;
    const counted = new Proxy(list, {
      get(target, property) {
        if (property === Symbol.iterator) {
          return function* () {
            for (const node of target) {
              read.add(node);
              yield node;
            }
          };
        }
        const value = Reflect.get(target, property) as unknown;
        if (typeof property === 'string' && /^\d+$/u.test(property) && value) {
          read.add(value as Node);
        }
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    Object.defineProperty(box, 'childNodes', {
      configurable: true,
      get: () => counted,
    });
    onTestFinished(() => {
      delete (box as unknown as Record<string, unknown>).childNodes;
    });
    const classifier = new StickySourceSecretClassifier();
    const scan = startSourceDocumentSecretScan(
      page,
      sourceWindow,
      classifier,
      steppingClock(8),
    );
    // The first slice met the box and a few of its children, not all of
    // them: copying 131,000 onto the stack in one step kept that slice at
    // twice its budget.
    expect(scan.done).toBe(false);
    expect(read.size).toBeLessThan(10);
    await scan.finished;
    expect(classifier.isSecret(page.querySelector('#last-pw')!)).toBe(true);
    expect(classifier.isSecret(page.documentElement)).toBe(false);
  });

  it('walks a list again when the page takes out the child it was at (D217)', async () => {
    const { document } = parseHTML(
      '<html><body><div id="box"><p id="first">a</p><p id="second">b</p>' +
        '<input id="later-pw" type="password"></div></body></html>',
    );
    const page = document as unknown as Document;
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;
    const first = page.querySelector('#first')!;
    const classifier = new StickySourceSecretClassifier();
    let reached = false;
    const scan = startSourceDocumentSecretScan(
      page,
      sourceWindow,
      classifier,
      steppingClock(1, () => {
        // Once the walk has given the first child, the page takes it out.
        if (!reached && first.firstChild && classifier.isSecret(first) === false) {
          reached = true;
          first.remove();
        }
      }),
    );
    await scan.finished;
    expect(reached).toBe(true);
    expect(classifier.isSecret(page.querySelector('#later-pw')!)).toBe(true);
    expect(classifier.isSecret(page.documentElement)).toBe(false);
  });

  it('marks the whole document secret past the node budget, sliced or not', async () => {
    const markup = `<html><body>${'<p>x</p>'.repeat(200)}</body></html>`;
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;
    const oneTask = parseHTML(markup).document as unknown as Document;
    const oneTaskClassifier = new StickySourceSecretClassifier();
    eagerlyClassifySourceDocumentSecrets(oneTask, sourceWindow, oneTaskClassifier);
    expect(oneTaskClassifier.isSecret(oneTask.documentElement)).toBe(true);

    const sliced = parseHTML(markup).document as unknown as Document;
    const classifier = new StickySourceSecretClassifier();
    const scan = startSourceDocumentSecretScan(
      sliced,
      sourceWindow,
      classifier,
      steppingClock(5),
    );
    expect(classifier.isSecret(sliced.documentElement)).toBe(false);
    await scan.finished;
    expect(classifier.isSecret(sliced.documentElement)).toBe(true);
    const last = sliced.body.lastChild!.firstChild!;
    expect(hasSourceCredentialSecretAncestor(last, classifier, sourceWindow))
      .toBe(true);
  });

  it('marks the whole document secret when a later slice cannot read a node', async () => {
    const page = secretPage();
    Object.defineProperty(page.document.querySelector('#tail')!, 'childNodes', {
      configurable: true,
      get: () => {
        throw new Error('unreadable');
      },
    });
    const classifier = new StickySourceSecretClassifier();
    const scan = startSourceDocumentSecretScan(
      page.document,
      page.sourceWindow,
      classifier,
      steppingClock(2),
    );
    await scan.finished;
    expect(classifier.isSecret(page.document.documentElement)).toBe(true);
  });

  it('marks the whole document secret when the page cannot be given a turn', async () => {
    const page = secretPage();
    const classifier = new StickySourceSecretClassifier();
    let time = 0;
    const scan = startSourceDocumentSecretScan(
      page.document,
      page.sourceWindow,
      classifier,
      createSliceClock({
        budgetMs: 1,
        now: () => (time += 1),
        yield: () => Promise.reject(new Error('no turn')),
      }),
    );
    await scan.finished;
    expect(scan.done).toBe(true);
    expect(classifier.isSecret(page.document.documentElement)).toBe(true);
  });
});

const POLICY_PAGE =
  '<html><body>' +
  '<p>filler</p>'.repeat(30) +
  '<div role="tablist">' +
  '<button id="t1" role="tab" aria-selected="true" aria-controls="p1">A</button>' +
  '<button id="t2" role="tab" aria-selected="false" aria-controls="p2">B</button>' +
  '</div>' +
  '<section id="p1" role="tabpanel">one</section>' +
  '<section id="p2" role="tabpanel" hidden>two</section>' +
  '<button id="d1" aria-expanded="true" aria-controls="r1">Open</button>' +
  '<div id="r1">painted region</div>' +
  '<button id="d2" aria-expanded="false" aria-controls="r2">Closed</button>' +
  '<div id="r2" class="collapsed">collapsed region</div>' +
  '<button id="d3" aria-haspopup="menu" aria-controls="box">Menu</button>' +
  '<div id="box" class="contents"><a id="inner" href="#x">link</a>' +
  '<span id="unpainted" class="collapsed">no</span></div>' +
  '<button id="multi" aria-controls="r1 r2">Both</button>' +
  '<button id="cross" aria-controls="closed-panel">Across</button>' +
  '<x-open id="open"></x-open><x-closed id="closed"></x-closed>' +
  '<p>filler</p>'.repeat(30) +
  '</body></html>';

/** A painted page: every element 320 by 40 unless collapsed or hidden. */
function policyPage() {
  const { document } = parseHTML(POLICY_PAGE);
  const open = document.querySelector('#open')!.attachShadow({ mode: 'open' });
  open.innerHTML =
    '<button id="open-trigger" aria-expanded="true" aria-controls="open-panel">x</button>' +
    '<div id="open-panel">open panel</div>';
  const reader = closedRootReader();
  reader.attach(
    document.querySelector('#closed')!,
    '<div id="closed-panel">closed panel</div>',
  );
  installSourceShadowRootReader(document as unknown as Document, reader.read);
  let styleReads = 0;
  for (const node of allNodes(document.documentElement)) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const collapsed = element.getAttribute('class') === 'collapsed';
    const rect = {
      left: 0, top: 0, width: 320, height: collapsed ? 0 : 40,
      right: 320, bottom: collapsed ? 0 : 40, x: 0, y: 0,
    };
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => {
        const list = [{ ...rect, toJSON: () => rect }];
        Object.defineProperty(list, 'item', {
          value: (index: number) => list[index] ?? null,
        });
        return list;
      },
    });
    Object.defineProperty(element, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ ...rect, toJSON: () => rect }),
    });
  }
  const sourceWindow = {
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: (element: Element) => {
      styleReads += 1;
      const display = element.hasAttribute('hidden')
        ? 'none'
        : element.getAttribute('class') === 'contents' ? 'contents' : 'block';
      return {
        display,
        visibility: 'visible',
        opacity: '1',
        position: 'static',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: (name: string) => {
          if (name === 'display') return display;
          if (name === 'visibility') return 'visible';
          if (name === 'opacity') return '1';
          if (name === '-webkit-text-security') return 'none';
          if (name === 'content-visibility') return 'visible';
          if (name === 'clip') return 'auto';
          if (name === 'clip-path') return 'none';
          if (name.startsWith('overflow')) return 'visible';
          return '';
        },
      } as unknown as CSSStyleDeclaration;
    },
  } as unknown as Window;
  return {
    document: document as unknown as Document,
    sourceWindow,
    styleReads: () => styleReads,
  };
}

/** A policy in terms of node positions, comparable across builds. */
function policySnapshot(policy: SourceControlledContentPolicy, nodes: Node[]) {
  const at = (node: Node): number => nodes.indexOf(node);
  const elements = (set: Iterable<Node>): number[] => [...set].map(at);
  return {
    targets: [...policy.targets].map(([element, state]) => [at(element), state]),
    tabs: policy.tabs.map(({ trigger, panel, selected }) =>
      [at(trigger), at(panel), selected]),
    controllers: elements(policy.controllers),
    referencedIds: [...policy.referencedIds],
    contextElements: elements(policy.contextElements),
    idElements: elements(policy.idElements),
    unindexableIdTargets: elements(policy.unindexableIdTargets),
    withheldIdRoots: elements(policy.withheldIdRoots),
    overflow: policy.overflow,
    incomplete: policy.incomplete,
  };
}

describe('sliced controlled-content policy (D163)', () => {
  it('builds the one-shot policy across forced slice boundaries', () => {
    const page = policyPage();
    const nodes = allNodes(page.document.documentElement);
    const oneShot = createSourceControlledContentPolicy(
      page.document,
      page.sourceWindow,
    );
    const expected = policySnapshot(oneShot, nodes);
    // Every kind of decision is in the fixture.
    const states = new Set(expected.targets.map(([, state]) => state));
    expect(states).toEqual(new Set(['open-tab', 'withheld', 'controlled-region']));
    expect(expected.tabs).toHaveLength(2);
    expect(expected.incomplete).toBe(false);

    for (const budget of [1, 2, 3, 7, 50]) {
      const builder = beginSourceControlledContentPolicy(
        page.document,
        page.sourceWindow,
      );
      let steps = 0;
      let policy: SourceControlledContentPolicy | undefined;
      while (!policy) {
        steps += 1;
        let asked = 0;
        policy = builder.step(() => (asked += 1) >= budget);
        expect(steps).toBeLessThan(10_000);
      }
      expect(steps).toBeGreaterThan(1);
      expect(policySnapshot(policy, nodes)).toEqual(expected);
      expect(builder.step(() => true)).toBe(policy);
    }
  });

  it('reads layout afresh in every slice', () => {
    const page = policyPage();
    createSourceControlledContentPolicy(page.document, page.sourceWindow);
    const oneShotReads = page.styleReads();
    const builder = beginSourceControlledContentPolicy(
      page.document,
      page.sourceWindow,
    );
    while (!builder.step(() => true)) {
      // One unit a slice: nothing a slice cached is there for the next.
    }
    expect(page.styleReads() - oneShotReads).toBeGreaterThan(oneShotReads);
  });

  it('gives the one-shot policy of a page past its node budget', () => {
    const page = policyPage();
    const nodes = allNodes(page.document.documentElement);
    const oneShot = policySnapshot(
      createSourceControlledContentPolicy(page.document, page.sourceWindow, 40),
      nodes,
    );
    expect(oneShot.incomplete).toBe(true);
    const builder = beginSourceControlledContentPolicy(
      page.document,
      page.sourceWindow,
      40,
    );
    let policy: SourceControlledContentPolicy | undefined;
    while (!policy) policy = builder.step(() => true);
    expect(policySnapshot(policy, nodes)).toEqual(oneShot);
  });
});
