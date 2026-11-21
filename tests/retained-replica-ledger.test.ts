import { parseHTML } from 'linkedom';
import { describe, expect, it, vi } from 'vitest';

import {
  RetainedReplicaLedger,
  walkRetainedReplica,
} from '../lib/replica/retained-replica-ledger';
import {
  JournaledMap,
  ReplicaNodeMap,
  ReplicaTextMap,
  replicaTextBytes,
} from '../lib/replica/replica-state-maps';

const LARGE = Number.MAX_SAFE_INTEGER;

/** A small deterministic generator, so a failure names its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function fixture() {
  const { document } = parseHTML(
    '<!doctype html><html lang="en"><head><style>p{}</style></head><body>' +
      '<section id="s1"><p>One <b>two</b></p><p class="x">Three</p></section>' +
      '<div id="host"></div><input placeholder="name"><!-- note -->' +
      '<textarea placeholder="p">t</textarea></body></html>',
  );
  const ownedAdoptedStyles = new Set<Node>();
  // Two shadow roots holding copies of one adopted sheet, counted once.
  for (const id of ['host']) {
    const host = document.getElementById(id)!;
    const shadow = host.attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.textContent = 'inside';
    shadow.append(span);
    for (let copy = 0; copy < 2; copy += 1) {
      const style = document.createElement('style');
      style.textContent = '.adopted { color: red }';
      shadow.append(style);
      ownedAdoptedStyles.add(style);
    }
  }
  return { document, ownedAdoptedStyles };
}

function allNodes(root: Node): Node[] {
  const nodes: Node[] = [];
  const pending: Node[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    if (node.nodeType === 1) {
      const shadow = (node as Element).shadowRoot;
      if (shadow) pending.push(shadow);
    }
    for (const child of node.childNodes) pending.push(child);
  }
  return nodes;
}

describe('retained replica ledger (D165)', () => {
  it('keeps the count the full walk makes over random changes', async () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const next = random(seed);
      const { document, ownedAdoptedStyles } = fixture();
      const root = document.documentElement;
      const ledger = new RetainedReplicaLedger({
        root,
        ownedAdoptedStyles,
        MutationObserver: document.defaultView!.MutationObserver,
      });
      expect(ledger.fits(0, LARGE, LARGE)).toBe(true);
      const detached: Node[] = [];
      for (let step = 0; step < 120; step += 1) {
        const nodes = allNodes(root);
        const elements = nodes.filter(
          (node): node is Element => node.nodeType === 1,
        );
        const pick = <T,>(list: readonly T[]): T =>
          list[Math.floor(next() * list.length)]!;
        const choice = next();
        const element = pick(elements);
        if (choice < 0.15) {
          element.setAttribute(pick(['id', 'class', 'title', 'aria-controls']),
            'v'.repeat(Math.floor(next() * 20)));
        } else if (choice < 0.22) {
          element.removeAttribute(pick(['id', 'class', 'title']));
        } else if (choice < 0.37) {
          const texts = nodes.filter((node) => node.nodeType === 3);
          if (texts.length > 0) {
            pick(texts).nodeValue = 'w'.repeat(Math.floor(next() * 30));
          }
        } else if (choice < 0.5) {
          const added = document.createElement(pick(['p', 'span', 'input']));
          added.setAttribute('data-k', String(step));
          added.setAttribute('placeholder', '');
          added.append(document.createTextNode(`added ${step}`));
          if (next() < 0.3) {
            const shadow = added.attachShadow({ mode: 'open' });
            shadow.append(document.createTextNode('shadow text'));
          }
          if (element !== root && element.nodeType === 1) element.append(added);
        } else if (choice < 0.62) {
          if (element !== root && element.parentNode && element.localName !== 'body' &&
            element.localName !== 'head') {
            element.remove();
            detached.push(element);
          }
        } else if (choice < 0.7) {
          if (detached.length > 0) {
            const back = detached.pop()!;
            // A detached node changed before it comes back.
            if (back.nodeType === 1) (back as Element).setAttribute('data-back', 'y');
            document.body.append(back);
          }
        } else if (choice < 0.78) {
          const inputs = elements.filter((candidate) =>
            candidate.localName === 'input' || candidate.localName === 'textarea');
          if (inputs.length > 0) {
            (pick(inputs) as HTMLInputElement).value = 'typed'.repeat(
              Math.floor(next() * 4),
            );
          }
        } else if (choice < 0.85) {
          const styles = [...ownedAdoptedStyles] as Element[];
          pick(styles).textContent = next() < 0.5
            ? '.adopted { color: red }'
            : '.adopted { color: blue }';
        } else if (choice < 0.92) {
          // A move inside the replica.
          const parent = pick(elements.filter((candidate) =>
            candidate !== root && candidate.localName !== 'html'));
          if (
            element !== root && element.localName !== 'body' &&
            element.localName !== 'head' && !allNodes(element).includes(parent) &&
            parent.localName !== 'head'
          ) parent.append(element);
        } else {
          // Await a turn: the observer's callback takes the records.
          await Promise.resolve();
        }
        ledger.flush();
        const walked = walkRetainedReplica(root, ownedAdoptedStyles, LARGE, LARGE);
        expect({ seed, step, totals: ledger.totals() })
          .toEqual({ seed, step, totals: walked });
      }
      ledger.dispose();
    }
  });

  it('answers as the full walk does at the limits', () => {
    const { document, ownedAdoptedStyles } = fixture();
    const root = document.documentElement;
    const ledger = new RetainedReplicaLedger({
      root,
      ownedAdoptedStyles,
      MutationObserver: document.defaultView!.MutationObserver,
    });
    const walked = walkRetainedReplica(root, ownedAdoptedStyles, LARGE, LARGE)!;
    expect(ledger.fits(10, walked.bytes + 10, walked.nodes)).toBe(true);
    expect(ledger.fits(11, walked.bytes + 10, walked.nodes)).toBe(false);
    expect(ledger.fits(0, LARGE, walked.nodes - 1)).toBe(false);
    // Counted again after the refusal; then a small change far from the
    // limits needs no walk.
    expect(ledger.fits(0, LARGE, LARGE)).toBe(true);
    const walks = ledger.fullWalks;
    document.body.setAttribute('title', 'x'.repeat(100));
    expect(ledger.fits(0, LARGE, LARGE)).toBe(true);
    expect(ledger.fullWalks).toBe(walks);
    // Near a limit, the walk answers.
    const now = walkRetainedReplica(root, ownedAdoptedStyles, LARGE, LARGE)!;
    expect(ledger.fits(0, now.bytes, LARGE)).toBe(true);
    expect(ledger.fullWalks).toBe(walks + 1);
    ledger.dispose();
  });

  it('asks for the whole ARIA index after a count that stopped over the budget', () => {
    const { document, ownedAdoptedStyles } = fixture();
    const ledger = new RetainedReplicaLedger({
      root: document.documentElement,
      ownedAdoptedStyles,
      MutationObserver: document.defaultView!.MutationObserver,
    });
    // The first count stops: roots past where it stopped are not watched.
    expect(ledger.fits(0, LARGE, 1)).toBe(false);
    ledger.takeAriaElements();
    // The next count starts over, and the index is read anew.
    expect(ledger.fits(0, LARGE, LARGE)).toBe(true);
    expect(ledger.takeAriaElements()).toBeUndefined();
    // A count after a whole one asks for nothing more.
    expect(ledger.fits(0, LARGE, LARGE)).toBe(true);
    expect(ledger.takeAriaElements()).toBeDefined();
    ledger.dispose();
  });

  it('names the elements the ARIA index must look at again', () => {
    const { document, ownedAdoptedStyles } = fixture();
    const ledger = new RetainedReplicaLedger({
      root: document.documentElement,
      ownedAdoptedStyles,
      MutationObserver: document.defaultView!.MutationObserver,
    });
    expect(ledger.fits(0, LARGE, LARGE)).toBe(true);
    ledger.takeAriaElements();
    const section = document.getElementById('s1')!;
    section.setAttribute('id', 's2');
    const added = document.createElement('div');
    added.setAttribute('aria-controls', 's2');
    document.body.append(added);
    const elements = ledger.takeAriaElements();
    expect(elements?.has(section)).toBe(true);
    expect(elements?.has(added)).toBe(true);
    expect(ledger.contains(added)).toBe(true);
    added.remove();
    expect(ledger.takeAriaElements()?.has(added)).toBe(true);
    expect(ledger.contains(added)).toBe(false);
    ledger.dispose();
  });
});

describe('journaled replica maps (D165)', () => {
  it('puts back values and order without a copy when nothing was deleted', () => {
    const map = new JournaledMap<number, string>();
    for (const key of [1, 2, 3]) map.set(key, `v${key}`);
    map.beginJournal();
    map.set(2, 'changed');
    map.set(4, 'new');
    map.delete(4);
    map.set(5, 'new');
    expect(map.journalStartValue(2)).toBe('v2');
    expect(map.journalStartValue(5)).toBeUndefined();
    map.rollbackJournal();
    expect([...map]).toEqual([[1, 'v1'], [2, 'v2'], [3, 'v3']]);
  });

  it('puts back the order of a key deleted and set again', () => {
    const map = new JournaledMap<number, string>();
    for (const key of [1, 2, 3]) map.set(key, `v${key}`);
    map.beginJournal();
    map.set(1, 'changed');
    map.set(9, 'new');
    map.delete(2);
    map.set(2, 'again');
    expect(map.journalStartValue(1)).toBe('v1');
    map.rollbackJournal();
    expect([...map]).toEqual([[1, 'v1'], [2, 'v2'], [3, 'v3']]);
    map.beginJournal();
    map.clear();
    map.rollbackJournal();
    expect([...map]).toEqual([[1, 'v1'], [2, 'v2'], [3, 'v3']]);
  });

  it('keeps each node id, the counts, and the text bytes in step', () => {
    const { document } = parseHTML('<html><body></body></html>');
    const nodes = new ReplicaNodeMap();
    const image = document.createElement('img');
    const paragraph = document.createElement('p');
    nodes.set(1, image);
    nodes.set(2, paragraph);
    nodes.beginJournal();
    const replacement = document.createElement('p');
    nodes.set(2, replacement);
    expect(nodes.idOf(paragraph)).toBeUndefined();
    expect(nodes.idOf(replacement)).toBe(2);
    expect(nodes.journalStartHasNode(replacement)).toBe(false);
    expect(nodes.journalStartHasNode(image)).toBe(true);
    nodes.delete(1);
    expect(nodes.imageCount).toBe(0);
    nodes.rollbackJournal();
    expect(nodes.idOf(paragraph)).toBe(2);
    expect(nodes.idOf(image)).toBe(1);
    expect(nodes.imageCount).toBe(1);
    expect([...nodes.ids]).toEqual(
      expect.arrayContaining([[image, 1], [paragraph, 2]]),
    );

    const texts = new ReplicaTextMap<{ text: string }>();
    texts.set(1, { text: 'abc' });
    texts.set(2, { text: '' });
    texts.beginJournal();
    texts.set(1, { text: 'abcdef' });
    texts.delete(2);
    texts.set(3, { text: 'x' });
    const sum = () => [...texts.values()].reduce(
      (total, value) => total + replicaTextBytes(value),
      0,
    );
    expect(texts.bytes).toBe(sum());
    texts.rollbackJournal();
    expect(texts.bytes).toBe(sum());
    expect(texts.bytes).toBe(6 + 32 + 32);
  });

  // D178: a delete took a copy of the whole map, so removing one node cost
  // as much as the mirror. The node map has no order to keep; the text maps
  // put each key back in its place.
  it('deletes from the node and text maps without copying them, and puts the order back', () => {
    const texts = new ReplicaTextMap<{ text: string }>();
    for (const key of [1, 2, 3, 4]) texts.set(key, { text: `t${key}` });
    const places = () => [...texts.keys()].map((key) => texts.placeOf(key));
    const before = places();
    texts.beginJournal();
    const copy = vi.spyOn(Map.prototype, 'entries');
    texts.delete(2);
    texts.delete(3);
    texts.set(3, { text: 'moved' });
    texts.set(5, { text: 'new' });
    expect(copy).not.toHaveBeenCalled();
    copy.mockRestore();
    expect([...texts.keys()]).toEqual([1, 4, 3, 5]);
    expect(texts.journalStartPlace(2)).toBe(before[1]);
    expect(texts.journalStartPlace(3)).toBe(before[2]);
    expect(texts.journalStartPlace(4)).toBe(before[3]);
    expect(texts.journalStartPlace(5)).toBeUndefined();
    expect(texts.journalTouchedKeys()).toEqual([
      [2, { text: 't2' }], [3, { text: 't3' }], [5, undefined],
    ]);
    texts.rollbackJournal();
    expect([...texts]).toEqual([1, 2, 3, 4].map((key) => [key, { text: `t${key}` }]));
    expect(places()).toEqual(before);
    expect(texts.bytes).toBe(4 * (4 + 32));

    const { document } = parseHTML('<html><body></body></html>');
    const nodes = new ReplicaNodeMap();
    const elements = [1, 2, 3].map(() => document.createElement('p'));
    elements.forEach((element, index) => nodes.set(index + 1, element));
    nodes.beginJournal();
    const nodeCopy = vi.spyOn(Map.prototype, 'entries');
    nodes.delete(1);
    expect(nodeCopy).not.toHaveBeenCalled();
    nodeCopy.mockRestore();
    expect(nodes.journalStartHasNode(elements[1]!)).toBe(true);
    nodes.rollbackJournal();
    expect(nodes.get(1)).toBe(elements[0]);
    expect(nodes.idOf(elements[0]!)).toBe(1);
  });
});
