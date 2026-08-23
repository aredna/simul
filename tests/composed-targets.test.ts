import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { minimizeConnectedComposedTargets } from '../lib/replica/composed-targets';

describe('minimizeConnectedComposedTargets', () => {
  it('keeps independent targets in insertion order', () => {
    const { document } = parseHTML(
      '<main><section></section><aside></aside></main>',
    );
    const section = document.querySelector('section')!;
    const aside = document.querySelector('aside')!;

    expect(minimizeConnectedComposedTargets([aside, section])).toEqual([
      aside,
      section,
    ]);
  });

  it('removes descendants when a connected ancestor is already targeted', () => {
    const { document } = parseHTML(
      '<main><section><span>value</span></section></main>',
    );
    const main = document.querySelector('main')!;
    const section = document.querySelector('section')!;
    const text = document.querySelector('span')!.firstChild!;

    expect(minimizeConnectedComposedTargets([text, main, section])).toEqual([
      main,
    ]);
  });

  it('crosses open shadow-root boundaries', () => {
    const { document } = parseHTML('<main><div></div></main>');
    const host = document.querySelector('div')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const label = document.createElement('span');
    shadow.append(label);

    expect(minimizeConnectedComposedTargets([label, host])).toEqual([host]);
  });

  it('drops disconnected targets and deduplicates repeated ones', () => {
    const { document } = parseHTML('<main><span></span></main>');
    const span = document.querySelector('span')!;
    const detached = document.createElement('div');

    expect(minimizeConnectedComposedTargets([span, detached, span])).toEqual([
      span,
    ]);
  });
});
