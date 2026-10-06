import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  pageAttribute,
  reapplyReplicaAttributeOverrides,
} from '../lib/replica/replica-attribute-override';
import {
  PAGE_LANGUAGE_ATTRIBUTE,
  TranslatedLanguageTags,
  XML_NAMESPACE,
  applyTranslatedLanguage,
  clearTranslatedLanguage,
  copyTranslatedLanguage,
  hideImageLanguage,
  pageLanguage,
  refreshImageLanguages,
  showImageLanguage,
  showOwnLanguage,
  shownTranslationLanguage,
  translationLanguageTag,
} from '../lib/replica/translated-language';

function page(body: string, htmlAttributes = 'lang="en"'): Document {
  return parseHTML(`<html ${htmlAttributes}><body>${body}</body></html>`)
    .document as unknown as Document;
}

describe('TranslatedLanguageTags (D124)', () => {
  it('tags the element that shows a translation and restores it when the translation goes', () => {
    const document = page('<p id="a">One</p><p id="b" lang="fr">Deux</p>');
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const tags = new TranslatedLanguageTags();

    tags.show(1, a, 'ja');
    tags.show(2, b, 'ja');
    expect(a.getAttribute('lang')).toBe('ja');
    expect(b.getAttribute('lang')).toBe('ja');
    expect(tags.size).toBe(2);

    expect(tags.hide(1)).toBe(a);
    expect(tags.hide(2)).toBe(b);
    expect(a.hasAttribute('lang')).toBe(false);
    expect(b.getAttribute('lang')).toBe('fr');
    expect(tags.size).toBe(0);
    expect(tags.hide(1)).toBeUndefined();
  });

  it('keeps each tagged element drawn by the page\'s own language', () => {
    const document = page(
      '<p id="a">One</p><p id="b" lang="fr">Deux</p><div lang=""><p id="c">Three</p></div><p id="d" lang="ja">四</p>',
    );
    const tags = new TranslatedLanguageTags();
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      tags.show(index, document.getElementById(id)!, 'ja');
    }
    const drawnBy = (id: string): string | null =>
      document.getElementById(id)!.getAttribute(PAGE_LANGUAGE_ATTRIBUTE);
    expect(drawnBy('a')).toBe('en');
    expect(drawnBy('b')).toBe('fr');
    // The page says the language is unknown here.
    expect(drawnBy('c')).toBe('');
    // Already Japanese: nothing of Simul's.
    expect(drawnBy('d')).toBeNull();
    tags.release();
    expect([...document.querySelectorAll('*')].filter((candidate) =>
      candidate.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE))).toEqual([]);

    // A page that declares no language at all.
    const bare = page('<p id="a">One</p>', '');
    const a = bare.getElementById('a')!;
    applyTranslatedLanguage(a, 'ja');
    expect(a.getAttribute('lang')).toBe('ja');
    expect(a.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('');
    clearTranslatedLanguage(a);
    expect(a.attributes.length).toBe(1);
  });

  it('keeps the tag until the element\'s last translation goes', () => {
    const document = page('<p id="a">One <b>two</b> three</p>');
    const a = document.getElementById('a')!;
    const tags = new TranslatedLanguageTags();
    tags.show(1, a, 'ja');
    tags.show(2, a, 'ja');
    tags.hide(1);
    expect(a.getAttribute('lang')).toBe('ja');
    tags.hide(2);
    expect(a.hasAttribute('lang')).toBe(false);
  });

  it('leaves alone an element the page already declares in the language', () => {
    const document = page(
      '<p id="own" lang="ja">一</p>' +
      '<div lang="ja-JP"><p id="inherited">二</p></div>' +
      '<div lang="JA"><section><p id="deep">三</p></section></div>',
    );
    const tags = new TranslatedLanguageTags();
    for (const [index, id] of ['own', 'inherited', 'deep'].entries()) {
      tags.show(index, document.getElementById(id)!, 'ja');
    }
    expect(document.getElementById('own')!.getAttribute('lang')).toBe('ja');
    expect(document.getElementById('inherited')!.hasAttribute('lang')).toBe(false);
    expect(document.getElementById('deep')!.hasAttribute('lang')).toBe(false);
    tags.release();
    expect(document.getElementById('own')!.getAttribute('lang')).toBe('ja');
    expect(document.querySelectorAll('[lang]').length).toBe(4);
  });

  it('does not take a broader or another language for the one translated to', () => {
    const document = page(
      '<p id="broad" lang="zh">一</p><p id="other" lang="en-US">Two</p><p id="unknown" lang="">Three</p>',
      '',
    );
    const tags = new TranslatedLanguageTags();
    tags.show(1, document.getElementById('broad')!, 'zh-Hant');
    tags.show(2, document.getElementById('other')!, 'ja');
    tags.show(3, document.getElementById('unknown')!, 'ja');
    expect(document.getElementById('broad')!.getAttribute('lang')).toBe('zh-Hant');
    expect(document.getElementById('other')!.getAttribute('lang')).toBe('ja');
    expect(document.getElementById('unknown')!.getAttribute('lang')).toBe('ja');
    tags.release();
    expect(document.getElementById('broad')!.getAttribute('lang')).toBe('zh');
    expect(document.getElementById('other')!.getAttribute('lang')).toBe('en-US');
    expect(document.getElementById('unknown')!.getAttribute('lang')).toBe('');
  });

  it('judges the page\'s language by the page\'s own values, not by Simul\'s tags', () => {
    const document = page('<p id="outer">Outer <b id="inner">inner</b></p>');
    const outer = document.getElementById('outer')!;
    const inner = document.getElementById('inner')!;
    const tags = new TranslatedLanguageTags();
    tags.show(1, outer, 'ja');
    // The parent's tag is Simul's: the child still needs its own, or it
    // would lose its language when the parent's translation goes.
    tags.show(2, inner, 'ja');
    expect(inner.getAttribute('lang')).toBe('ja');
    expect(pageLanguage(inner)).toBe('en');
    tags.hide(1);
    expect(outer.hasAttribute('lang')).toBe(false);
    expect(inner.getAttribute('lang')).toBe('ja');
  });

  it('reads the language through a shadow host', () => {
    const document = page('<div id="host" lang="ja"></div>');
    const host = document.getElementById('host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('p');
    shadow.append(inner);
    expect(pageLanguage(inner)).toBe('ja');
    const tags = new TranslatedLanguageTags();
    tags.show(1, inner, 'ja');
    expect(inner.hasAttribute('lang')).toBe(false);
    tags.show(1, inner, 'fr');
    expect(inner.getAttribute('lang')).toBe('fr');
  });

  it('moves a record\'s tag when it shows in another element or language', () => {
    const document = page('<p id="a">One</p><p id="b">Two</p>');
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const tags = new TranslatedLanguageTags();
    tags.show(1, a, 'ja');
    tags.show(1, b, 'ja');
    expect(a.hasAttribute('lang')).toBe(false);
    expect(b.getAttribute('lang')).toBe('ja');
    tags.show(1, b, 'fr');
    expect(b.getAttribute('lang')).toBe('fr');
    tags.show(1, undefined, 'fr');
    expect(b.hasAttribute('lang')).toBe(false);
    tags.show(1, a, undefined);
    expect(a.hasAttribute('lang')).toBe(false);
    expect(tags.size).toBe(0);
  });

  it('does not rewrite the attribute when the same translation is shown again', () => {
    const document = page('<p id="a">One</p>');
    const a = document.getElementById('a')!;
    const tags = new TranslatedLanguageTags();
    tags.show(1, a, 'ja');
    let writes = 0;
    const setAttribute = a.setAttribute.bind(a);
    const removeAttribute = a.removeAttribute.bind(a);
    a.setAttribute = (name: string, value: string) => { writes += 1; setAttribute(name, value); };
    a.removeAttribute = (name: string) => { writes += 1; removeAttribute(name); };
    tags.show(1, a, 'ja');
    expect(writes).toBe(0);
  });

  it('follows a page patch of lang on a tagged element and on an ancestor', () => {
    const document = page('<div id="wrap" lang="ja"><p id="child">子</p></div><p id="own">Own</p>');
    const wrap = document.getElementById('wrap')!;
    const child = document.getElementById('child')!;
    const own = document.getElementById('own')!;
    const tags = new TranslatedLanguageTags();
    tags.show(1, child, 'ja');
    tags.show(2, own, 'ja');
    expect(child.hasAttribute('lang')).toBe(false);

    // The page says the wrapper is English now: the child needs the tag.
    wrap.setAttribute('lang', 'en');
    tags.refresh(new Set([wrap]));
    expect(child.getAttribute('lang')).toBe('ja');
    expect(child.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en');
    wrap.setAttribute('lang', 'en-GB');
    tags.refresh(new Set([wrap]));
    expect(child.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('en-GB');
    wrap.setAttribute('lang', 'ja');
    tags.refresh(new Set([wrap]));
    expect(child.hasAttribute('lang')).toBe(false);
    expect(child.hasAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe(false);

    // The page writes its own lang on a tagged element.
    own.setAttribute('lang', 'de');
    reapplyReplicaAttributeOverrides(own);
    expect(own.getAttribute('lang')).toBe('ja');
    expect(pageAttribute(own, 'lang')).toBe('de');
    tags.hide(2);
    expect(own.getAttribute('lang')).toBe('de');
  });

  it('looks again only at the tags inside the elements whose lang changed', () => {
    const document = page(
      '<div id="a"><p id="in-a">A</p><span id="host"></span></div>' +
      '<div id="b"><p id="in-b">B</p></div>',
    );
    const a = document.getElementById('a')!;
    const b = document.getElementById('b')!;
    const inA = document.getElementById('in-a')!;
    const inB = document.getElementById('in-b')!;
    const inShadow = document.createElement('p');
    document.getElementById('host')!.attachShadow({ mode: 'open' }).append(inShadow);
    const tags = new TranslatedLanguageTags();
    tags.show(1, inA, 'ja');
    tags.show(2, inB, 'ja');
    tags.show(3, inShadow, 'ja');
    const drawnBy = (element: Element): string | null =>
      element.getAttribute(PAGE_LANGUAGE_ATTRIBUTE);
    expect([inA, inB, inShadow].map(drawnBy)).toEqual(['en', 'en', 'en']);

    // The page changes both; only `a` is named. What is under `a`, through a
    // shadow host too, follows; `b` is left as it was until it is named.
    let looked = 0;
    const read = inB.getAttribute.bind(inB);
    inB.getAttribute = (name: string) => { looked += 1; return read(name); };
    a.setAttribute('lang', 'de');
    b.setAttribute('lang', 'fr');
    tags.refresh(new Set([a]));
    expect(looked).toBe(0);
    expect([inA, inB, inShadow].map(drawnBy)).toEqual(['de', 'en', 'de']);
    tags.refresh(new Set([b]));
    expect([inA, inB, inShadow].map(drawnBy)).toEqual(['de', 'fr', 'de']);

    // A tagged element that is itself the one that changed: the page's
    // patch writes its attributes anew, and Simul's show again over them.
    for (const { name } of [...inA.attributes]) inA.removeAttribute(name);
    inA.setAttribute('lang', 'ja');
    reapplyReplicaAttributeOverrides(inA);
    expect(drawnBy(inA)).toBe('de');
    tags.refresh(new Set([inA]));
    expect(inA.getAttribute('lang')).toBe('ja');
    expect(drawnBy(inA)).toBeNull();
  });

  it('writes the page\'s language in the XML namespace', () => {
    const document = page('<p id="a" lang="fr">Deux</p>');
    const a = document.getElementById('a')!;
    const written: (readonly [string | null, string, string])[] = [];
    const write = a.setAttributeNS.bind(a);
    a.setAttributeNS = (namespace, name, value): void => {
      written.push([namespace, name, value]);
      write(namespace, name, value);
    };
    applyTranslatedLanguage(a, 'ja');
    expect(written).toEqual([[XML_NAMESPACE, 'simul:lang', 'fr']]);
  });

  it('has Simul\'s own elements say the language and be drawn by none', () => {
    // A Japanese page: the page's elements are drawn by `ja`; an overlay's
    // box and a facsimile's row never were, and must not start to be.
    const document = page(
      '<p id="tagged">一</p><p id="own" lang="en">Two</p><p id="plain">三</p>' +
      '<span id="row1"></span><span id="row2"></span><span id="row3"></span><span id="box"></span>',
      'lang="ja"',
    );
    const [tagged, own, plain, row1, row2, row3, box] =
      ['tagged', 'own', 'plain', 'row1', 'row2', 'row3', 'box']
        .map((id) => document.getElementById(id)!);
    const written: (readonly [string | null, string, string])[] = [];
    for (const element of [row1!, row2!, row3!, box!]) {
      const write = element.setAttributeNS.bind(element);
      element.setAttributeNS = (namespace, name, value): void => {
        written.push([namespace, name, value]);
        write(namespace, name, value);
      };
    }
    applyTranslatedLanguage(tagged!, 'en');
    expect(tagged!.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('ja');

    // A row copies what its element says, never what it is drawn by.
    copyTranslatedLanguage(tagged!, row1!);
    expect(row1!.getAttribute('lang')).toBe('en');
    expect(row1!.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('');
    // The page's own `lang` on an untranslated element is said the same way.
    copyTranslatedLanguage(own!, row2!);
    expect(row2!.getAttribute('lang')).toBe('en');
    expect(row2!.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('');
    // Nothing to say: nothing written.
    copyTranslatedLanguage(plain!, row3!);
    expect(row3!.attributes.length).toBe(1);

    showOwnLanguage(box!, 'en');
    expect(box!.getAttribute('lang')).toBe('en');
    expect(box!.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)).toBe('');
    expect(written).toEqual([
      [XML_NAMESPACE, 'simul:lang', ''],
      [XML_NAMESPACE, 'simul:lang', ''],
      [XML_NAMESPACE, 'simul:lang', ''],
    ]);
  });

  it('looks again at the images named by a caption when the page changes a lang', () => {
    const document = page(
      '<div id="wrap"><img id="one" alt="One"><span id="host"></span></div>' +
      '<img id="other" alt="Other">',
    );
    const html = document.documentElement;
    const wrap = document.getElementById('wrap')!;
    const one = document.getElementById('one')!;
    const other = document.getElementById('other')!;
    const inShadow = document.createElement('img');
    document.getElementById('host')!.attachShadow({ mode: 'open' }).append(inShadow);
    const state = (image: Element): string =>
      `${image.getAttribute('lang')}|${image.getAttribute(PAGE_LANGUAGE_ATTRIBUTE)}`;

    // The page declares the target language when the captions land: no tag.
    html.setAttribute('lang', 'ja');
    for (const image of [one, other, inShadow]) showImageLanguage(image, 'ja');
    expect([one, other, inShadow].map(state)).toEqual(['null|null', 'null|null', 'null|null']);

    // It changes its mind: every named image under <html> says Japanese.
    html.setAttribute('lang', 'en');
    refreshImageLanguages(document);
    expect([one, other, inShadow].map(state)).toEqual(['ja|en', 'ja|en', 'ja|en']);

    // An ancestor's `lang`, through a shadow host too.
    wrap.setAttribute('lang', 'de');
    refreshImageLanguages(document);
    expect([one, other, inShadow].map(state)).toEqual(['ja|de', 'ja|en', 'ja|de']);

    // The image's own `lang`, written by the page's patch.
    for (const { name } of [...one.attributes]) one.removeAttribute(name);
    one.setAttribute('lang', 'fr');
    reapplyReplicaAttributeOverrides(one);
    refreshImageLanguages(document);
    expect(state(one)).toBe('ja|fr');
    expect(pageAttribute(one, 'lang')).toBe('fr');

    // A name that is gone is not looked at again, and leaves what the page has.
    hideImageLanguage(one);
    expect(state(one)).toBe('fr|null');
    hideImageLanguage(other);
    hideImageLanguage(inShadow);
    html.setAttribute('lang', 'zh');
    refreshImageLanguages(document);
    expect([other, inShadow].map(state)).toEqual(['null|null', 'null|null']);
  });

  it('says no language for text the translator gave back as it was', () => {
    expect(shownTranslationLanguage('fr', 'Mount Fuji', 'Mont Fuji')).toBe('fr');
    expect(shownTranslationLanguage('fr', '富士山', '富士山')).toBeUndefined();
    expect(shownTranslationLanguage('fr', ' 3776\n', '3776')).toBeUndefined();
    expect(shownTranslationLanguage('fr', 'Fuji', 'fuji')).toBe('fr');
    expect(shownTranslationLanguage(undefined, 'Mount Fuji', 'Mont Fuji'))
      .toBeUndefined();
  });

  it('untags an element when its text is the page\'s again', () => {
    const document = page('<p id="a">Mount <span id="b" lang="ja">富士山</span></p>');
    const span = document.getElementById('b')!;
    const tags = new TranslatedLanguageTags();

    tags.show(1, span, shownTranslationLanguage('fr', '富士山', '富士山'));
    expect(span.getAttribute('lang')).toBe('ja');
    expect(tags.size).toBe(0);
    tags.show(1, span, shownTranslationLanguage('fr', '富士山', 'Mont Fuji'));
    expect(span.getAttribute('lang')).toBe('fr');
    tags.show(1, span, shownTranslationLanguage('fr', '富士山', '富士山'));
    expect(span.getAttribute('lang')).toBe('ja');
    expect(span.attributes.length).toBe(2);
    expect(tags.size).toBe(0);
  });

  it('applies and validates a language outside the tag set', () => {
    const document = page('<p><img id="i" alt="A boat"></p>');
    const image = document.getElementById('i')!;
    applyTranslatedLanguage(image, 'ja');
    expect(image.getAttribute('lang')).toBe('ja');
    expect(translationLanguageTag('ja')).toBe('ja');
    expect(translationLanguageTag('zh-Hant')).toBe('zh-Hant');
    expect(translationLanguageTag('ja|policy')).toBeUndefined();
    expect(translationLanguageTag('')).toBeUndefined();
    expect(translationLanguageTag(undefined)).toBeUndefined();
    expect(translationLanguageTag('x" onload="1')).toBeUndefined();
  });
});
