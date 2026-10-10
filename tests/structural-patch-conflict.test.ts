import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { hasStructuralPatchTargetConflict } from '../lib/replica/structural-patch-conflict';

describe('hasStructuralPatchTargetConflict', () => {
  it('allows independent siblings and multiple operations on one target', () => {
    const { document } = parseHTML(
      '<main><section></section><aside></aside></main>',
    );
    const main = document.querySelector('main')!;
    const section = document.querySelector('section')!;
    const aside = document.querySelector('aside')!;

    expect(hasStructuralPatchTargetConflict([
      { target: section, structural: true },
      { target: aside, structural: false },
    ])).toBe(false);
    expect(hasStructuralPatchTargetConflict([
      { target: main, structural: true },
      { target: main, structural: false },
    ])).toBe(false);
  });

  it('rejects any update inside a structural target in one batch', () => {
    const { document } = parseHTML(
      '<main><section><span>value</span></section></main>',
    );
    const main = document.querySelector('main')!;
    const span = document.querySelector('span')!;

    expect(hasStructuralPatchTargetConflict([
      { target: main, structural: true },
      { target: span.firstChild!, structural: false },
    ])).toBe(true);
    expect(hasStructuralPatchTargetConflict([
      { target: span, structural: false },
      { target: main, structural: true },
    ])).toBe(true);
    expect(hasStructuralPatchTargetConflict([
      { target: main, structural: true },
      { target: span, structural: true },
    ])).toBe(true);
  });

  it('allows an attribute update on an ancestor of a structural target', () => {
    // A carousel move: the wrapper's transform changes while a slide's
    // content is replaced. The slide stays in place under the wrapper.
    const { document } = parseHTML(
      '<div class="wrapper"><div class="slide"><img></div></div>',
    );
    const wrapper = document.querySelector('.wrapper')!;
    const slide = document.querySelector('.slide')!;

    expect(hasStructuralPatchTargetConflict([
      { target: slide, structural: true },
      { target: wrapper, structural: false },
    ])).toBe(false);
    expect(hasStructuralPatchTargetConflict([
      { target: wrapper, structural: false },
      { target: slide, structural: true },
      { target: slide, structural: false },
    ])).toBe(false);
  });

  it('crosses open shadow-root boundaries', () => {
    const { document } = parseHTML('<main><div></div></main>');
    const main = document.querySelector('main')!;
    const host = document.querySelector('div')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const label = document.createElement('span');
    shadow.append(label);

    expect(hasStructuralPatchTargetConflict([
      { target: main, structural: true },
      { target: label, structural: false },
    ])).toBe(true);
  });

  it('lets a shadow root be replaced beside its own host\'s children (D132)', () => {
    // Replacing a host's children leaves its root in place: a host the page
    // shows again gets both read again in one batch.
    const { document } = parseHTML('<main><div></div></main>');
    const main = document.querySelector('main')!;
    const host = document.querySelector('div')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const label = document.createElement('span');
    shadow.append(label);

    expect(hasStructuralPatchTargetConflict([
      { target: host, structural: true },
      { target: shadow, structural: true },
    ])).toBe(false);
    // What is above the host still takes the root with it,
    expect(hasStructuralPatchTargetConflict([
      { target: main, structural: true },
      { target: shadow, structural: true },
    ])).toBe(true);
    // and what replaces the root's children takes what is inside it.
    expect(hasStructuralPatchTargetConflict([
      { target: shadow, structural: true },
      { target: label, structural: false },
    ])).toBe(true);
  });

  it('lets what is inside a root be patched beside its own host\'s children', () => {
    // A slot is told which nodes it holds in the batch that brings its host
    // a new child: the host's children are replaced, its root stays.
    const { document } = parseHTML('<main><x-outer><x-light></x-light></x-outer></main>');
    const main = document.querySelector('main')!;
    const outer = document.querySelector('x-outer')!;
    const light = document.querySelector('x-light')!;
    const outerRoot = outer.attachShadow({ mode: 'open' });
    outerRoot.innerHTML = '<div><slot></slot><x-inner></x-inner></div>';
    const slot = outerRoot.querySelector('slot')!;
    const inner = outerRoot.querySelector('x-inner')!;
    const innerRoot = inner.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<span>label</span>';
    const lightRoot = light.attachShadow({ mode: 'open' });
    lightRoot.innerHTML = '<span>label</span>';

    for (const structural of [false, true]) {
      expect(hasStructuralPatchTargetConflict([
        { target: outer, structural: true },
        { target: slot, structural },
      ])).toBe(false);
      // Deeper in the same root, through a root of its own, too.
      expect(hasStructuralPatchTargetConflict([
        { target: innerRoot.firstChild!, structural },
        { target: outer, structural: true },
      ])).toBe(false);
    }
    // A child of the host is replaced, and its own root with it.
    expect(hasStructuralPatchTargetConflict([
      { target: outer, structural: true },
      { target: lightRoot.firstChild!, structural: false },
    ])).toBe(true);
    // Above the host everything goes; inside the root what is below goes.
    expect(hasStructuralPatchTargetConflict([
      { target: main, structural: true },
      { target: slot, structural: false },
    ])).toBe(true);
    expect(hasStructuralPatchTargetConflict([
      { target: slot.parentNode!, structural: true },
      { target: slot, structural: false },
    ])).toBe(true);
    expect(hasStructuralPatchTargetConflict([
      { target: inner, structural: true },
      { target: innerRoot.firstChild!, structural: false },
    ])).toBe(false);
  });
});
