import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  SourceStyleNameCensus,
  collectSourceStyleNames,
  createSourceStyleNames,
  createSourceStyleSheetCollection,
  sourceClassChangeNamesHidingRule,
  sourceVisibilityEventMaySkip,
  sourceVisibilityMutationMaySkip,
  type SourceStyleNames,
} from '../lib/replica/source-style-names';

/**
 * The names the page's sheets mention, and the changes the comparison of
 * what the page paints leaves out because of them (D164).
 */

function namesOf(...texts: string[]): SourceStyleNames {
  const names = createSourceStyleNames();
  for (const text of texts) collectSourceStyleNames(text, names);
  return names;
}

function attributeRecord(
  target: Element,
  attributeName: string,
  oldValue: string | null = null,
  attributeNamespace: string | null = null,
): MutationRecord {
  return {
    type: 'attributes',
    target,
    attributeName,
    attributeNamespace,
    oldValue,
  } as unknown as MutationRecord;
}

function page(markup: string) {
  const { document } = parseHTML(`<html><head></head><body>${markup}</body></html>`);
  return {
    document,
    byId: (id: string) => document.getElementById(id) as unknown as Element,
  };
}

describe('the names a style sheet mentions (D164)', () => {
  it('collects classes, ids, attributes, attribute reads and pseudo-classes', () => {
    const names = namesOf(
      '.menu.Open > a#Home:hover, [data-State="open"] ~ .panel { color: red; }',
      'li::before { content: attr( title ); }',
      '[*|aria-expanded], [svg|href], [ lang|="en"] { display: none; }',
      'nav:has(:focus-visible) .x:is(:active) {}',
    );
    expect([...names.classes].sort()).toEqual(['menu', 'open', 'panel', 'x']);
    expect([...names.ids]).toContain('home');
    expect([...names.attributes].sort())
      .toEqual(['aria-expanded', 'data-state', 'href', 'lang']);
    expect([...names.attributeReads]).toEqual(['title']);
    expect([...names.pseudoClasses].sort())
      .toEqual(['active', 'focus-visible', 'has', 'hover', 'is']);
    expect([...names.pseudoElements]).toEqual(['before']);
  });

  it('reads no pseudo-class out of a quoted string, and every other name', () => {
    const names = namesOf(
      '.icon { background: url("data:image/svg+xml;utf8,<svg class=\'a:b\'/>") }',
      "a[title='x:checked'] .y::after { content: 'see: here \\' :target' }",
    );
    expect([...names.pseudoClasses]).toEqual([]);
    expect(names.classes.has('icon')).toBe(true);
    expect(names.classes.has('y')).toBe(true);
    expect([...names.pseudoElements]).toEqual(['after']);
  });

  it('undoes the escapes Chrome writes in a selector', () => {
    // One whitespace after a hexadecimal escape belongs to the escape:
    // `.caf\e9 x` is the class `caféx`.
    const names = namesOf(
      '.md\\:flex {} .w-1\\/2 {} .\\31 0 {} .\\[\\&\\>\\*\\]\\:p-4 {} .caf\\e9 {} .caf\\e9 x {}',
    );
    expect(names.classes).toEqual(new Set(['md:flex', 'w-1/2', '10', '[&>*]:p-4', 'café', 'caféx']));
  });

  it('reads no pseudo-class out of a media feature', () => {
    const names = namesOf('@media (hover: hover) { .card { opacity: .5 } }');
    expect(names.pseudoClasses.has('hover')).toBe(false);
    expect(names.classes.has('card')).toBe(true);
  });
});

describe('the classes of the rules that hide (D180)', () => {
  it('lists the classes of a plain rule that hides, and only those', () => {
    const names = namesOf(
      '.closed, .tab.hidden > p { display: none } .faded{opacity:0} .dim { opacity: 0.5 }',
      '.gone { visibility : hidden !important } .wide { width: 0 } .idle{content-visibility:hidden}',
      '@media (width < 1px) { .narrow { display: none } }',
    );
    expect([...names.hidingClasses].sort()).toEqual(
      ['closed', 'faded', 'gone', 'hidden', 'idle', 'narrow', 'tab'],
    );
  });

  it('knows a change of class that adds or takes away such a class', () => {
    const { byId } = page('<p id="p" class="wide open">x</p>');
    const names = namesOf('.closed { display: none } .wide { width: 100% }');
    const target = byId('p');
    expect(sourceClassChangeNamesHidingRule(attributeRecord(target, 'class', 'wide'), names)).toBe(false);
    expect(sourceClassChangeNamesHidingRule(
      attributeRecord(target, 'class', 'wide open closed'), names)).toBe(true);
    target.setAttribute('class', 'closed');
    expect(sourceClassChangeNamesHidingRule(attributeRecord(target, 'class', 'wide'), names)).toBe(true);
    expect(sourceClassChangeNamesHidingRule(attributeRecord(target, 'data-x', null), names)).toBe(false);
    expect(sourceClassChangeNamesHidingRule(attributeRecord(target, 'class', 'wide'), undefined)).toBe(false);
  });
});

describe('the changes the comparison leaves out (D164)', () => {
  const unnamed = () => namesOf('.shown { display: block } :focus { outline: 0 }');

  it('leaves out an attribute no rule names, of the kinds that paint nothing themselves', () => {
    const { byId } = page('<div id="a"></div><link id="l"><style id="s"></style>');
    const a = byId('a');
    for (const name of ['data-x', 'aria-label', 'aria-expanded', 'title']) {
      expect(sourceVisibilityMutationMaySkip(attributeRecord(a, name), unnamed)).toBe(true);
    }
    for (const name of [
      'id', 'style', 'hidden', 'open', 'dir', 'lang', 'aria-hidden', 'slot',
      'src', 'href', 'type', 'value', 'checked', 'disabled', 'width', 'role',
      'popover', 'inert',
    ]) {
      expect(sourceVisibilityMutationMaySkip(attributeRecord(a, name), unnamed)).toBe(false);
    }
    // `title` picks the sheets of a <link> or a <style>.
    expect(sourceVisibilityMutationMaySkip(attributeRecord(byId('l'), 'title'), unnamed))
      .toBe(false);
    expect(sourceVisibilityMutationMaySkip(attributeRecord(byId('s'), 'title'), unnamed))
      .toBe(false);
    // An attribute in a namespace (xlink:title) is never left out.
    expect(sourceVisibilityMutationMaySkip(
      attributeRecord(a, 'title', null, 'http://www.w3.org/1999/xlink'),
      unnamed,
    )).toBe(false);
  });

  it('compares an attribute a rule names or reads with attr()', () => {
    const { byId } = page('<div id="a"></div>');
    const a = byId('a');
    expect(sourceVisibilityMutationMaySkip(
      attributeRecord(a, 'data-x'),
      () => namesOf('[data-x] .panel { display: none }'),
    )).toBe(false);
    expect(sourceVisibilityMutationMaySkip(
      attributeRecord(a, 'data-x'),
      () => namesOf('.tip::after { content: attr(data-x) }'),
    )).toBe(false);
    expect(sourceVisibilityMutationMaySkip(
      attributeRecord(a, 'DATA-X'),
      () => namesOf('[data-x] {}'),
    )).toBe(false);
  });

  it('leaves out a class change only when no token it adds or takes away is named', () => {
    const { byId } = page('<div id="a" class="card is-active"></div>');
    const a = byId('a');
    // `is-active` was added to `card`.
    const record = attributeRecord(a, 'class', 'card');
    expect(sourceVisibilityMutationMaySkip(record, () => namesOf('.card { padding: 0 }')))
      .toBe(true);
    expect(sourceVisibilityMutationMaySkip(record, () => namesOf('.is-active .x {}')))
      .toBe(false);
    // A token taken away counts as well.
    a.setAttribute('class', 'card');
    expect(sourceVisibilityMutationMaySkip(
      attributeRecord(a, 'class', 'card open'),
      () => namesOf('.open {}'),
    )).toBe(false);
    // In quirks mode a class selector ignores case.
    expect(sourceVisibilityMutationMaySkip(
      attributeRecord(a, 'class', 'card OPEN'),
      () => namesOf('.open {}'),
    )).toBe(false);
    // A rule that reads the attribute itself.
    expect(sourceVisibilityMutationMaySkip(
      attributeRecord(a, 'class', 'card x'),
      () => namesOf('[class*="x"] {}'),
    )).toBe(false);
  });

  it('compares an attribute of an element whose inline style may read it with attr()', () => {
    const { byId } = page(
      '<div id="a" style="width: attr(data-w px)"></div>' +
      '<div id="b" style="--w: ATTR( data-w type(<length>) )"></div>' +
      '<div id="c" style="width: \\61ttr(data-w px)"></div>' +
      '<div id="d" style="color: red"></div>',
    );
    for (const id of ['a', 'b', 'c']) {
      for (const name of ['data-w', 'aria-label', 'title']) {
        expect(sourceVisibilityMutationMaySkip(attributeRecord(byId(id), name), unnamed), `${id} ${name}`)
          .toBe(false);
      }
      expect(sourceVisibilityMutationMaySkip(
        attributeRecord(byId(id), 'class', 'x'),
        unnamed,
      ), `${id} class`).toBe(false);
    }
    expect(sourceVisibilityMutationMaySkip(attributeRecord(byId('d'), 'data-w'), unnamed))
      .toBe(true);
  });

  it('compares everything when every name counts', () => {
    const { byId } = page('<div id="a"></div>');
    expect(sourceVisibilityMutationMaySkip(attributeRecord(byId('a'), 'data-x'), () => undefined))
      .toBe(false);
    expect(sourceVisibilityEventMaySkip('pointerover', () => undefined)).toBe(false);
  });

  it('leaves out an event only when no sheet reads the pseudo-classes it changes', () => {
    const none = () => namesOf('.a {}');
    for (const type of [
      'pointerover', 'pointerout', 'pointerdown', 'pointerup',
      'focusin', 'focusout', 'keydown', 'keyup',
    ]) expect(sourceVisibilityEventMaySkip(type, none)).toBe(true);
    for (const type of [
      'click', 'input', 'change', 'beforeinput', 'beforetoggle', 'toggle',
      'transitionend', 'animationend', 'constructor', 'toString',
    ]) expect(sourceVisibilityEventMaySkip(type, none)).toBe(false);

    const hover = () => namesOf('nav li:hover > ul { display: block }');
    expect(sourceVisibilityEventMaySkip('pointerover', hover)).toBe(false);
    expect(sourceVisibilityEventMaySkip('pointerdown', hover)).toBe(false);
    // A key that scrolls the page moves the hover with no pointer event.
    expect(sourceVisibilityEventMaySkip('focusin', hover)).toBe(false);
    expect(sourceVisibilityEventMaySkip('keydown', hover)).toBe(false);

    const active = () => namesOf('button:active + .tip {}');
    expect(sourceVisibilityEventMaySkip('pointerover', active)).toBe(false);
    expect(sourceVisibilityEventMaySkip('pointerup', active)).toBe(false);
    expect(sourceVisibilityEventMaySkip('keyup', active)).toBe(false);

    const within = () => namesOf('.menu:focus-within .list {}');
    expect(sourceVisibilityEventMaySkip('focusout', within)).toBe(false);
    expect(sourceVisibilityEventMaySkip('pointerout', within)).toBe(false);

    const visible = () => namesOf(':focus-visible {}');
    expect(sourceVisibilityEventMaySkip('keydown', visible)).toBe(false);
    expect(sourceVisibilityEventMaySkip('focusin', visible)).toBe(false);

    // A field's error shown once it loses the focus.
    const invalid = () => namesOf('input:user-invalid + .error { display: block }');
    expect(sourceVisibilityEventMaySkip('focusout', invalid)).toBe(false);
    expect(sourceVisibilityEventMaySkip('focusin', invalid)).toBe(false);
  });

  it('compares every event beside a pseudo-class a script can change with no mutation', () => {
    // A property written in a key handler, a custom state, the address, a
    // method, the browser itself, a definition, a vendor's or an unknown name.
    for (const rule of [
      'input:checked + .panel { display: block }',
      'input:placeholder-shown ~ .hint {}',
      'form:invalid .error {}',
      'x-menu:state(open) .list {}',
      ':target {}',
      'dialog:modal {}',
      '[popover]:popover-open {}',
      'details:open > .body {}',
      'video:fullscreen {}',
      'video:playing + .badge {}',
      'input:autofill {}',
      'x-card:not(:defined) { display: none }',
      'input:dir(rtl) {}',
      'input:-webkit-autofill {}',
      'a:future-state {}',
    ]) {
      for (const type of ['pointerover', 'focusin', 'keydown']) {
        expect(sourceVisibilityEventMaySkip(type, () => namesOf(rule)), `${type} ${rule}`)
          .toBe(false);
      }
    }
    // What only a change of the tree or of an attribute can change, which
    // the mutation records bring, leaves an event out; so do pseudo-elements.
    const structural = () => namesOf(
      'li:first-child, li:nth-child(2n+1):not(.x), p:last-of-type:empty {}',
      ':root:lang(en) a:any-link:visited, button:disabled, input:required {}',
      'nav:has(> ul:only-child) :is(a, b):where(.c) {}',
      ':host(.dark) ::slotted(p), p::before, p:after, ::part(label) {}',
    );
    for (const type of [
      'pointerover', 'pointerout', 'pointerdown', 'pointerup',
      'focusin', 'focusout', 'keydown', 'keyup',
    ]) expect(sourceVisibilityEventMaySkip(type, structural), type).toBe(true);
  });
});

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

/** An owner of sheets, read by the census as the poll would read it. */
function owner(sheets: unknown[], adopted: unknown[] = []) {
  return { styleSheets: sheets, adoptedStyleSheets: adopted } as unknown as Document;
}

function read(census: SourceStyleNameCensus, target: Document, signature = 's1') {
  const collection = createSourceStyleSheetCollection();
  for (const each of target.styleSheets as unknown as FakeSheet[]) {
    try {
      const rules = each.cssRules;
      collection.ruleCounts.push([each as unknown as CSSStyleSheet, rules.length]);
      for (const rule of rules) collection.texts.push(rule.cssText);
    } catch {
      collection.complete = false;
    }
  }
  census.noteOrdinary(target, signature, collection);
  census.noteAdopted(target, 'adopted');
}

describe('the census of the names the page mentions (D164)', () => {
  it('is usable once every owner was read whole, by both its sheets and its adopted ones', () => {
    const census = new SourceStyleNameCensus();
    const document = owner([sheet('.a {}')]);
    const root = owner([], [sheet('[data-x] {}')]);
    expect(census.names([document])).toBeUndefined();
    read(census, document);
    expect(census.names([document])?.classes.has('a')).toBe(true);
    // A root not read yet.
    expect(census.names([document, root])).toBeUndefined();
    read(census, root);
    expect(census.names([document, root])?.attributes.has('data-x')).toBe(true);
    // Only the adopted sheets read: not usable.
    const half = owner([sheet('.b {}')]);
    census.noteAdopted(half, 'adopted');
    expect(census.names([document, half])).toBeUndefined();
  });

  it('counts every name when a sheet cannot be read', () => {
    const census = new SourceStyleNameCensus();
    const crossOrigin = {
      get cssRules(): never {
        throw new Error('SecurityError');
      },
      disabled: false,
      media: { mediaText: '' },
    };
    const document = owner([sheet('.a {}'), crossOrigin]);
    read(census, document);
    expect(census.names([document])).toBeUndefined();
  });

  it('counts every name when a sheet was read only by its shape', () => {
    const census = new SourceStyleNameCensus();
    const document = owner([sheet('.a {}')]);
    const collection = createSourceStyleSheetCollection();
    // What the poll leaves when it watches a sheet by its shape.
    collection.complete = false;
    census.noteOrdinary(document, 'shape', collection);
    census.noteAdopted(document, 'adopted');
    expect(census.names([document])).toBeUndefined();
  });

  it('is not believed once a rule was inserted, or a sheet added, until read again', () => {
    const census = new SourceStyleNameCensus();
    const first = sheet('.a {}');
    const sheets: unknown[] = [first];
    const document = owner(sheets);
    read(census, document);
    expect(census.names([document])).toBeDefined();
    first.cssRules.push({ cssText: '[data-x] { display: none }' });
    expect(census.names([document])).toBeUndefined();
    read(census, document, 's2');
    expect(census.names([document])?.attributes.has('data-x')).toBe(true);
    sheets.push(sheet('.b {}'));
    expect(census.names([document])).toBeUndefined();
    read(census, document, 's3');
    expect(census.names([document])?.classes.has('b')).toBe(true);
    // An adopted sheet changed in count.
    const adopted = sheet('.c {}');
    const withAdopted = owner([], [adopted]);
    read(census, withAdopted);
    expect(census.names([withAdopted])?.classes.has('c')).toBe(true);
    adopted.cssRules.push({ cssText: '.d {}' });
    expect(census.names([withAdopted])).toBeUndefined();
  });

  it('reads an owner again after a <style> or <link> of it changed', () => {
    const census = new SourceStyleNameCensus();
    const document = owner([sheet('.a {}')]);
    read(census, document);
    census.forget(document);
    expect(census.names([document])).toBeUndefined();
    read(census, document);
    expect(census.names([document])).toBeDefined();
  });
});
