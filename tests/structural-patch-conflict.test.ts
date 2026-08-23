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

  it('rejects a structural ancestor or descendant in one batch', () => {
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
      { target: main, structural: false },
      { target: span, structural: true },
    ])).toBe(true);
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
});
