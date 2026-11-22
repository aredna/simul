import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest';

import {
  setSourceOwnHidingSheetReader,
  sourceElementHidesItselfByVisibility,
  sourceElementScalesItselfToNothing,
} from '../lib/replica/source-own-hiding';
import { nameOnDocument } from './support/named-document';

interface FakeRule {
  readonly selectorText?: string;
  readonly conditionText?: string;
  readonly containerName?: string;
  readonly name?: string;
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
  const plain = (name: string) => (values.get(name) ?? '').replace(/\s*!important$/u, '');
  return {
    getPropertyValue: plain,
    getPropertyPriority: (name: string) =>
      (values.get(name) ?? '').endsWith('!important') ? 'important' : '',
  };
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
function page(body: string, sheets: FakeSheet[], supported?: (condition: string) => boolean) {
  const { document, window } = parseHTML(
    `<html><body><div id="panel">${body}</div></body></html>`,
  );
  Object.defineProperty(document, 'styleSheets', { configurable: true, value: sheets });
  // The test window is one object for every page: put `CSS` back.
  const css = Object.getOwnPropertyDescriptor(window, 'CSS');
  onTestFinished(() => {
    delete (window as unknown as Record<string, unknown>).CSS;
    if (css) Object.defineProperty(window, 'CSS', css);
  });
  Object.defineProperty(window, 'CSS', {
    configurable: true,
    value: supported ? { supports: supported } : undefined,
  });
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
    document,
    hides: (id: string, fresh = false) =>
      sourceElementHidesItselfByVisibility(select(id), fresh),
    scales: (id: string, fresh = false) =>
      sourceElementScalesItselfToNothing(select(id), fresh),
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

  it('reads the page\'s window past an image named `defaultView` (D213)', () => {
    const { document, hides, scales } = page(
      '<img id="named" alt=""><select id="ruled" class="backing"></select>' +
        '<select id="shrunk" class="shrunk"></select>',
      [{ cssRules: [rule('.backing', 'visibility:hidden'), rule('.shrunk', 'transform:scale(0)')] }],
    );
    onTestFinished(nameOnDocument(
      document as unknown as Document, 'defaultView', document.querySelector('#named')!,
    ));
    expect(hides('ruled')).toBe(true);
    expect(scales('shrunk')).toBe(true);
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

  it('withholds a dropdown when a sheet it cannot read may hide it (A6)', () => {
    const unreadable = {
      get cssRules(): readonly FakeRule[] {
        throw new Error('SecurityError');
      },
    };
    const { hides } = page(
      '<select id="far" class="far"></select><select id="near" class="near"></select>',
      [unreadable, { cssRules: [rule('.near', 'visibility:hidden')] }],
    );
    // A sheet of another origin may hold the rule that hides either one:
    // the panel opening over them withholds them rather than read them.
    expect(hides('far')).toBe(true);
    expect(hides('near')).toBe(true);
  });

  it('reads a sheet of another origin from the page\'s copy once it has come (D203)', async () => {
    const unreadable = (href: string) => ({
      href,
      get cssRules(): readonly FakeRule[] {
        throw new Error('SecurityError');
      },
    });
    const asked: string[] = [];
    const texts: Record<string, string | undefined> = {
      'https://cdn.example/menu.css': '.far{visibility:hidden}',
      'https://cdn.example/imports.css': '@import url(other.css); .near{visibility:visible}',
    };
    setSourceOwnHidingSheetReader(() => async (href) => {
      asked.push(href);
      return texts[href];
    });
    onTestFinished(() => setSourceOwnHidingSheetReader(undefined));
    const { document, hides } = page(
      '<select id="far" class="far"></select><select id="near" class="near"></select>',
      [unreadable('https://cdn.example/menu.css')],
    );
    // A constructed sheet of the page's own, never applied: the copy's rules.
    const window = document.defaultView as unknown as Record<string, unknown>;
    const had = Object.getOwnPropertyDescriptor(window, 'CSSStyleSheet');
    onTestFinished(() => {
      delete window.CSSStyleSheet;
      if (had) Object.defineProperty(window, 'CSSStyleSheet', had);
    });
    Object.defineProperty(window, 'CSSStyleSheet', {
      configurable: true,
      value: class {
        cssRules: FakeRule[] = [];
        replaceSync(text: string): void {
          this.cssRules = [...text.matchAll(/([^{}]+)\{([^}]*)\}/gu)]
            .map(([, selector, body]) => rule(selector!.trim(), body!));
        }
      },
    });
    // Until the copy has come, either may be hidden by it.
    expect(hides('far', true)).toBe(true);
    expect(hides('near', true)).toBe(true);
    await nextRun();
    expect(hides('far', true)).toBe(true);
    expect(hides('near', true)).toBe(false);
    expect(asked).toEqual(['https://cdn.example/menu.css']);
    // One that imports another is not used; one whose server refused stays
    // unknown.
    Object.defineProperty(document, 'styleSheets', {
      configurable: true,
      value: [unreadable('https://cdn.example/imports.css')],
    });
    expect(hides('near', true)).toBe(true);
    await nextRun();
    expect(hides('near', true)).toBe(true);
    Object.defineProperty(document, 'styleSheets', {
      configurable: true,
      value: [{ cssRules: [{ styleSheet: unreadable('https://cdn.example/refused.css') }] }],
    });
    expect(hides('near', true)).toBe(true);
    await nextRun();
    // An imported sheet that cannot be read may hold the rule too.
    expect(hides('near', true)).toBe(true);
  });

  it('withholds a dropdown whose tree was too big to read (A6)', () => {
    const many = Array.from(
      { length: 513 },
      (_unused, index) => rule(`.c${index}`, 'visibility:hidden'),
    );
    const { hides } = page(
      '<select id="plain" class="plain"></select>',
      [{ cssRules: many }],
    );
    // The list was cut off before its end: a rule past the cut may be its.
    expect(hides('plain')).toBe(true);
  });

  it('reads every way a page writes a scale of nothing (A6)', () => {
    const { scales } = page(
      `<select id="dot" class="dot"></select>
       <select id="minus" class="minus"></select>
       <select id="fraction" class="fraction"></select>
       <select id="percent" class="percent"></select>
       <select id="exponent" class="exponent"></select>
       <select id="exponent-scale" class="exponent-scale"></select>
       <select id="turned" class="turned"></select>`,
      [{
        cssRules: [
          rule('.dot', 'transform:scale(.0)'),
          rule('.minus', 'transform:scale(-0)'),
          rule('.fraction', 'scale:.0 1'),
          rule('.percent', 'scale:0%'),
          rule('.exponent', 'transform:scale(0e0)'),
          rule('.exponent-scale', 'scale:0e+0'),
          rule('.turned', 'transform:scale(1)'),
        ],
      }],
    );
    expect(scales('dot')).toBe(true);
    expect(scales('minus')).toBe(true);
    expect(scales('fraction')).toBe(true);
    expect(scales('percent')).toBe(true);
    expect(scales('exponent')).toBe(true);
    expect(scales('exponent-scale')).toBe(true);
    expect(scales('turned')).toBe(false);
  });

  it('re-reads a rule the page edited where it stands (A5)', async () => {
    const properties = new Map([['visibility', 'hidden']]);
    const style = {
      getPropertyValue: (name: string) => properties.get(name) ?? '',
    };
    const backing = { selectorText: '.backing', style };
    const { hides } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [backing] }],
    );
    expect(hides('one')).toBe(true);
    // The next change of the page: nothing was read again.
    await nextRun();
    expect(hides('one')).toBe(true);
    // `rule.style.setProperty('visibility', 'visible')`: the sheet and its
    // rule count are as they were, and the kept rule no longer hides it.
    await nextRun();
    properties.set('visibility', 'visible');
    expect(hides('one')).toBe(false);
  });

  it('re-reads a rule whose enclosing media condition the page edited (A5)', async () => {
    const media = { mediaText: 'screen' };
    const conditional = {
      media,
      cssRules: [rule('.backing', 'visibility:hidden')],
    };
    const { hides } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [conditional] }],
    );
    expect(hides('one')).toBe(true);
    await nextRun();
    // `mediaRule.media.mediaText = 'print'`: the rule applies nowhere here.
    media.mediaText = 'print';
    expect(hides('one')).toBe(false);
  });

  it('re-reads a nested rule whose parent selector the page rewrote (A5)', async () => {
    const parent = rule('.menu', 'color:red', [
      rule('& .nest', 'visibility:hidden'),
    ]);
    const { hides } = page(
      '<div class="menu"><select id="inside" class="nest"></select></div>' +
        '<select id="renamed" class="nest"></select>',
      [{ cssRules: [parent] }],
    );
    expect(hides('inside')).toBe(true);
    expect(hides('renamed')).toBe(false);
    await nextRun();
    // `parentRule.selectorText = '.other'`: the nested rule no longer names
    // the dropdown, but its kept selector was built from the old parent.
    Object.assign(parent, { selectorText: '.other' });
    expect(hides('inside')).toBe(false);
  });

  it('re-reads a rule whose sheet media the page edited (A5)', async () => {
    const media = { mediaText: 'screen' };
    const { hides } = page(
      '<select id="one" class="backing"></select>',
      [{ media, cssRules: [rule('.backing', 'visibility:hidden')] }],
    );
    expect(hides('one')).toBe(true);
    await nextRun();
    // `link.media = 'print'`: the rule no longer applies in this window.
    media.mediaText = 'print';
    expect(hides('one')).toBe(false);
  });

  it('re-reads a rule that starts hiding in place for the opened panel (A5)', () => {
    const properties = new Map([['color', 'red']]);
    const style = {
      getPropertyValue: (name: string) => properties.get(name) ?? '',
    };
    const backing = { selectorText: '.backing', style };
    const { hides } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [backing] }],
    );
    // The first, cached read kept no rule: this one does not hide yet.
    expect(hides('one')).toBe(false);
    // The page writes `visibility:hidden` into the same rule. The sheet and
    // its rules are as they were, so only a fresh opened-panel read sees it.
    properties.set('visibility', 'hidden');
    expect(hides('one', true)).toBe(true);
  });

  it('sees a rule added inside nested media for the opened panel (A5)', () => {
    const inside: FakeRule[] = [];
    const inner = { media: { mediaText: 'screen' }, cssRules: inside };
    const outer = { media: { mediaText: 'screen' }, cssRules: [inner] };
    const { hides } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [outer] }],
    );
    expect(hides('one')).toBe(false);
    // The outer sheet still holds one rule, and the kept list is empty: the
    // added rule is invisible to a top-level count.
    inside.push(rule('.backing', 'visibility:hidden'));
    expect(hides('one', true)).toBe(true);
  });

  it('sees a rule added to an imported sheet for the opened panel (A5)', () => {
    const imported: FakeRule[] = [];
    const importedSheet: FakeSheet = { cssRules: imported };
    const { hides } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [{ styleSheet: importedSheet }] }],
    );
    expect(hides('one')).toBe(false);
    imported.push(rule('.backing', 'visibility:hidden'));
    expect(hides('one', true)).toBe(true);
  });

  it('sees a scale rule added inside nested media for the opened panel (A5)', () => {
    const inside: FakeRule[] = [];
    const inner = { media: { mediaText: 'screen' }, cssRules: inside };
    const outer = { media: { mediaText: 'screen' }, cssRules: [inner] };
    const { scales } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [outer] }],
    );
    expect(scales('one')).toBe(false);
    // The sheet still holds one rule and the kept list is empty: only a
    // fresh opened-panel read sees the addition, as for visibility.
    inside.push(rule('.backing', 'transform:scale(0)'));
    expect(scales('one', true)).toBe(true);
  });

  it('sees a scale rule added to an imported sheet for the opened panel (A5)', () => {
    const imported: FakeRule[] = [];
    const importedSheet: FakeSheet = { cssRules: imported };
    const { scales } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [{ styleSheet: importedSheet }] }],
    );
    expect(scales('one')).toBe(false);
    imported.push(rule('.backing', 'scale:0'));
    expect(scales('one', true)).toBe(true);
  });

  it('re-reads a rule that starts scaling in place for the opened panel (A5)', () => {
    const properties = new Map([['color', 'red']]);
    const style = {
      getPropertyValue: (name: string) => properties.get(name) ?? '',
    };
    const backing = { selectorText: '.backing', style };
    const { scales } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [backing] }],
    );
    expect(scales('one')).toBe(false);
    properties.set('transform', 'scale(0)');
    expect(scales('one', true)).toBe(true);
  });

  it('fingerprints every media level around a kept rule (A5)', async () => {
    const innerMedia = { mediaText: 'screen' };
    const inner = {
      media: innerMedia,
      cssRules: [rule('.backing', 'visibility:hidden')],
    };
    const outer = { media: { mediaText: 'screen' }, cssRules: [inner] };
    const { hides } = page(
      '<select id="one" class="backing"></select>',
      [{ cssRules: [outer] }],
    );
    expect(hides('one')).toBe(true);
    await nextRun();
    innerMedia.mediaText = 'print';
    expect(hides('one')).toBe(false);
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
  // D173: the cascade between a rule that hides and one that shows (f1, f2).
  it('lets a later or more specific rule that shows the dropdown win', () => {
    const { hides, scales } = page(
      `<div class="menu"><select id="later" class="backing shown"></select>
         <select id="earlier" class="backing first"></select>
         <select id="weaker" class="backing weak"></select>
         <select id="even" class="even"></select>
         <select id="listed" class="backing listed"></select>
         <select id="where" class="backing where"></select>
         <select id="unscaled" class="shrunk grown"></select>
         <select id="other-axis" class="shrunk flat"></select></div>`,
      [{
        cssRules: [
          rule('.menu .first', 'visibility:visible'),
          rule('.menu .backing', 'visibility:hidden'),
          rule('.menu .backing.shown', 'visibility:visible'),
          rule('.weak', 'visibility:visible'),
          rule('.even', 'visibility:hidden'),
          rule('.even', 'visibility:visible'),
          // A list counts the selector of it that names the dropdown.
          rule('.nothing, .menu select.listed', 'visibility:visible'),
          rule(':where(.menu) .where', 'visibility:visible'),
          rule('.shrunk', 'transform:scale(0)'),
          rule('.menu .grown', 'transform:none'),
          // `scale` and `transform` are two properties: one does not undo
          // the other.
          rule('.menu .flat', 'scale:1'),
        ],
      }],
    );
    expect(hides('later')).toBe(false);
    // The rule that shows comes first and weighs the same: it loses.
    expect(hides('earlier')).toBe(true);
    // Later but less specific: it loses.
    expect(hides('weaker')).toBe(true);
    expect(hides('even')).toBe(false);
    expect(hides('listed')).toBe(false);
    // `:where()` weighs nothing: `.where` alone loses to `.menu .backing`.
    expect(hides('where')).toBe(true);
    expect(scales('unscaled')).toBe(false);
    expect(scales('other-axis')).toBe(true);
  });

  it('weighs `!important` and the style attribute as the page does', () => {
    const { hides } = page(
      `<select id="beaten" class="must" style="visibility:hidden"></select>
       <select id="attribute" class="backing" style="visibility:visible"></select>
       <select id="forced" class="forced" style="visibility:visible"></select>
       <select id="both" class="both" style="visibility:hidden !important"></select>`,
      [{
        cssRules: [
          rule('.must', 'visibility:visible !important'),
          rule('.backing', 'visibility:hidden'),
          rule('.forced', 'visibility:hidden !important'),
          rule('#both.both', 'visibility:visible !important'),
        ],
      }],
    );
    expect(hides('beaten')).toBe(false);
    expect(hides('attribute')).toBe(false);
    expect(hides('forced')).toBe(true);
    // `!important` in the attribute beats `!important` in a sheet.
    expect(hides('both')).toBe(true);
  });

  it('lets nothing show the dropdown that is not worked out here', () => {
    const many = Array.from(
      { length: 1_025 },
      (_unused, index) => rule(`.v${index}`, 'visibility:visible'),
    );
    const { hides } = page(
      `<select id="layered" class="backing layered"></select>
       <select id="contained" class="backing contained"></select>
       <select id="variable" class="variable"></select>
       <select id="crowded" class="crowded v3"></select>`,
      [
        {
          cssRules: [
            rule('.backing', 'visibility:hidden'),
            // A cascade layer, a container query.
            { name: 'base', cssRules: [rule('.backing.layered', 'visibility:visible')] },
            {
              conditionText: '(min-width: 1px)',
              containerName: '',
              cssRules: [rule('.backing.contained', 'visibility:visible')],
            },
            rule('.variable', 'visibility:hidden'),
            rule('.variable', 'visibility:var(--shown)'),
            rule('.crowded', 'visibility:hidden'),
          ],
        },
        { cssRules: many },
      ],
    );
    expect(hides('layered')).toBe(true);
    expect(hides('contained')).toBe(true);
    expect(hides('variable')).toBe(true);
    // More rules that show than are kept: none of them is asked.
    expect(hides('crowded')).toBe(true);
  });

  it('honours an `@supports` around a rule (f4)', () => {
    const sheets = (): FakeSheet[] => [{
      cssRules: [
        { conditionText: '(display: frob)', cssRules: [rule('.unheld', 'visibility:hidden')] },
        { conditionText: '(display: grid)', cssRules: [rule('.held', 'visibility:hidden')] },
        rule('.shown-later', 'visibility:hidden'),
        { conditionText: '(display: grid)', cssRules: [rule('.shown-later', 'visibility:visible')] },
      ],
    }];
    const markup = `<select id="unheld" class="unheld"></select>
      <select id="held" class="held"></select>
      <select id="shown-later" class="shown-later"></select>`;
    const asked = page(markup, sheets(), (condition) => condition.includes('grid'));
    expect(asked.hides('unheld')).toBe(false);
    expect(asked.hides('held')).toBe(true);
    expect(asked.hides('shown-later')).toBe(false);
  });

  it('hides by a rule under an `@supports` it cannot ask, and never shows by one', () => {
    const { hides } = page(
      '<select id="unheld" class="unheld"></select><select id="shown-later" class="shown-later"></select>',
      [{
        cssRules: [
          { conditionText: '(display: frob)', cssRules: [rule('.unheld', 'visibility:hidden')] },
          rule('.shown-later', 'visibility:hidden'),
          { conditionText: '(display: grid)', cssRules: [rule('.shown-later', 'visibility:visible')] },
        ],
      }],
    );
    expect(hides('unheld')).toBe(true);
    expect(hides('shown-later')).toBe(true);
  });

  it('asks the `::slotted` rules of the roots the dropdown is slotted into (f15)', () => {
    const { document, hides } = page(
      `<x-outer id="outer"><select id="slotted"></select><select id="shown" class="shown"></select>
         <select id="plain" class="plain"></select></x-outer>`,
      [{ cssRules: [rule('select.shown', 'visibility:visible')] }],
    );
    const outer = document.querySelector('#outer')!;
    const root = outer.attachShadow({ mode: 'open' });
    root.innerHTML = '<div class="wrap"><slot id="s1"></slot></div>';
    const slot = root.querySelector('#s1')!;
    Object.defineProperty(root, 'styleSheets', {
      configurable: true,
      value: [{
        cssRules: [
          rule('.wrap ::slotted(select)', 'visibility:hidden'),
          // A selector without `::slotted` in the root names nothing outside.
          rule('select.plain', 'visibility:hidden'),
        ],
      }],
    });
    for (const id of ['slotted', 'shown', 'plain']) {
      Object.defineProperty(document.querySelector(`#${id}`)!, 'assignedSlot', {
        configurable: true,
        value: slot,
      });
    }
    expect(hides('slotted', true)).toBe(true);
    // Normal declarations of the tree outside win over the root's.
    expect(hides('shown', true)).toBe(false);
    expect(hides('plain', true)).toBe(true);
  });
});
