import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  sourceElementHidesItselfByVisibility,
  sourceElementScalesItselfToNothing,
} from '../lib/replica/source-own-hiding';

interface FakeRule {
  readonly selectorText?: string;
  readonly style?: { getPropertyValue(name: string): string };
  readonly media?: { readonly mediaText: string };
  readonly cssRules?: readonly FakeRule[];
  readonly styleSheet?: FakeSheet;
}

interface FakeSheet {
  readonly cssRules: readonly FakeRule[];
  readonly disabled?: boolean;
  readonly media?: { readonly mediaText: string };
}

const declarations = (text: string) => {
  const values = new Map(text.split(';').filter(Boolean).map((part) => {
    const [name, value] = part.split(':');
    return [name!.trim(), value!.trim()] as const;
  }));
  return { getPropertyValue: (name: string) => values.get(name) ?? '' };
};
const rule = (selectorText: string, text: string, cssRules?: readonly FakeRule[]): FakeRule => ({
  selectorText,
  style: declarations(text),
  ...(cssRules ? { cssRules } : {}),
});

/**
 * A menu's panel that hides everything under it by `visibility`, as a panel
 * that fades does: every dropdown in it computes to hidden, and only what
 * the page wrote says which of them the page hides itself.
 */
function page(body: string, sheets: FakeSheet[]) {
  const { document, window } = parseHTML(
    `<html><body><div id="panel">${body}</div></body></html>`,
  );
  Object.defineProperty(document, 'styleSheets', { configurable: true, value: sheets });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: () => ({ visibility: 'hidden' }),
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: !query.includes('print') }),
  });
  const select = (id: string) => document.querySelector(`#${id}`)! as unknown as Element;
  return {
    hides: (id: string) => sourceElementHidesItselfByVisibility(select(id)),
    scales: (id: string) => sourceElementScalesItselfToNothing(select(id)),
  };
}

/** The rules of a tree are compared once for a run of the reader. */
const nextRun = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('what the page itself wrote for a dropdown under something hidden', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, { Node: window.Node, Element: window.Element });
  });

  it('asks the style attribute and the rules that name the dropdown', () => {
    const { hides, scales } = page(
      `<select id="plain"></select>
       <select id="inline" style="visibility:hidden"></select>
       <select id="ruled" class="backing"></select>
       <select id="other" class="other"></select>
       <select id="shrunk" class="shrunk"></select>
       <select id="flat" class="flat"></select>
       <select id="turned" class="turned"></select>`,
      [{
        cssRules: [
          rule('.backing', 'visibility:hidden'),
          rule('.shrunk', 'transform:scale(0)'),
          rule('.flat', 'scale:0 1'),
          rule('.turned', 'transform:rotate(2deg)'),
          rule('.other', 'color:red'),
        ],
      }],
    );
    expect(hides('plain')).toBe(false);
    expect(hides('inline')).toBe(true);
    expect(hides('ruled')).toBe(true);
    expect(hides('other')).toBe(false);
    // A rule about its scale says nothing of its visibility, and the other
    // way round.
    expect(hides('shrunk')).toBe(false);
    expect(scales('shrunk')).toBe(true);
    expect(scales('flat')).toBe(true);
    expect(scales('turned')).toBe(false);
    expect(scales('ruled')).toBe(false);
  });

  it('reads a rule nested in another, under the rule around it', () => {
    const { hides } = page(
      `<div class="menu"><select id="amp" class="nest"></select>
         <select id="bare" class="bare"></select><select id="cond" class="cond"></select></div>
       <select id="carded" class="card"></select>
       <select id="outside" class="nest bare cond"></select>`,
      [{
        cssRules: [
          rule('.menu', 'color:red', [
            // `&` stands for the rule around it; without one the nested
            // selector is meant under it.
            rule('& .nest', 'visibility:hidden'),
            rule('.bare', 'visibility:hidden'),
            // Declarations straight in a condition are the outer rule's.
            {
              media: { mediaText: 'screen' },
              cssRules: [rule('& .cond', 'visibility:hidden')],
            },
          ]),
          rule('.card', 'color:red', [
            { media: { mediaText: 'screen' }, cssRules: [{ style: declarations('visibility:hidden') }] },
          ]),
        ],
      }],
    );
    expect(hides('amp')).toBe(true);
    expect(hides('bare')).toBe(true);
    expect(hides('cond')).toBe(true);
    expect(hides('carded')).toBe(true);
    // The same classes outside the rule around them are not named.
    expect(hides('outside')).toBe(false);
  });

  it('passes over a rule whose media condition does not hold, when it asks', () => {
    const { hides } = page(
      `<select id="printed" class="printed"></select>
       <select id="screened" class="screened"></select>
       <select id="sheet" class="sheet"></select>
       <select id="off" class="off"></select>`,
      [
        {
          cssRules: [
            { media: { mediaText: 'print' }, cssRules: [rule('.printed', 'visibility:hidden')] },
            { media: { mediaText: 'screen' }, cssRules: [rule('.screened', 'visibility:hidden')] },
          ],
        },
        // A whole sheet for print; and a sheet that is switched off.
        { media: { mediaText: 'print' }, cssRules: [rule('.sheet', 'visibility:hidden')] },
        { disabled: true, cssRules: [rule('.off', 'visibility:hidden')] },
      ],
    );
    expect(hides('printed')).toBe(false);
    expect(hides('screened')).toBe(true);
    expect(hides('sheet')).toBe(false);
    expect(hides('off')).toBe(false);
  });

  it('takes a sheet it cannot read for one that says nothing', () => {
    const unreadable = {
      get cssRules(): readonly FakeRule[] {
        throw new Error('SecurityError');
      },
    };
    const { hides } = page(
      '<select id="far" class="far"></select><select id="near" class="near"></select>',
      [unreadable, { cssRules: [rule('.near', 'visibility:hidden')] }],
    );
    expect(hides('far')).toBe(false);
    expect(hides('near')).toBe(true);
  });

  it('reads the rules of a tree once, until its sheets change', async () => {
    let read = 0;
    const rules: FakeRule[] = [rule('.backing', 'visibility:hidden')];
    const counted = new Proxy(rules, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/u.test(key)) read += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const sheets: FakeSheet[] = [{ cssRules: counted }];
    const { hides } = page(
      '<select id="one" class="backing"></select><select id="late" class="late"></select>' +
        '<select id="other" class="other"></select>',
      sheets,
    );
    expect(hides('one')).toBe(true);
    expect(hides('late')).toBe(false);
    expect(read).toBe(1);
    // The next change of the page: the same sheets, and no rule is read.
    await nextRun();
    expect(hides('one')).toBe(true);
    expect(read).toBe(1);
    // A rule more in a sheet, or a sheet more, and they are read again.
    await nextRun();
    rules.push(rule('.late', 'visibility:hidden'));
    expect(hides('late')).toBe(true);
    expect(read).toBe(3);
    await nextRun();
    sheets.push({ cssRules: [rule('.other', 'visibility:hidden')] });
    expect(hides('other')).toBe(true);
    expect(read).toBe(5);
    // A sheet less, the others as they were.
    await nextRun();
    sheets.pop();
    expect(hides('other')).toBe(false);
    sheets.push({ cssRules: [rule('.other', 'visibility:hidden')] });
    // Within one run nothing is compared twice: a sheet added in the middle
    // of it is seen at the next.
    await nextRun();
    expect(hides('one')).toBe(true);
    sheets.pop();
    rules.pop();
    expect(hides('late')).toBe(true);
    await nextRun();
    expect(hides('late')).toBe(false);
  });
});
