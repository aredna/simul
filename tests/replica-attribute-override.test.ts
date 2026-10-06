import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  clearReplicaAttributeOverride,
  pageAttribute,
  pageAttributes,
  reapplyReplicaAttributeOverrides,
  setReplicaAttributeOverride,
} from '../lib/replica/replica-attribute-override';

function element(html: string): Element {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  return document.body.firstElementChild as unknown as Element;
}

/** What a page patch does to a replica element: every attribute is rewritten. */
function rewrite(target: Element, attributes: readonly (readonly [string, string])[]): void {
  for (const { name } of [...target.attributes]) target.removeAttribute(name);
  for (const [name, value] of attributes) target.setAttribute(name, value);
  reapplyReplicaAttributeOverrides(target);
}

describe('replica attribute overrides (D124)', () => {
  it('shows a value over the page\'s own and puts the page\'s back exactly', () => {
    const paragraph = element('<p lang="fr" class="a">Bonjour</p>');
    setReplicaAttributeOverride(paragraph, 'lang', 'ja');
    expect(paragraph.getAttribute('lang')).toBe('ja');
    expect(pageAttribute(paragraph, 'lang')).toBe('fr');
    expect(pageAttribute(paragraph, 'class')).toBe('a');

    clearReplicaAttributeOverride(paragraph, 'lang');
    expect(paragraph.getAttribute('lang')).toBe('fr');
    expect(pageAttribute(paragraph, 'lang')).toBe('fr');
  });

  it('removes the attribute when the page had none', () => {
    const paragraph = element('<p>Hello</p>');
    setReplicaAttributeOverride(paragraph, 'lang', 'ja');
    expect(pageAttribute(paragraph, 'lang')).toBeNull();
    clearReplicaAttributeOverride(paragraph, 'lang');
    expect(paragraph.hasAttribute('lang')).toBe(false);
  });

  it('keeps an empty page value apart from no value', () => {
    const image = element('<img alt="" aria-label="">');
    setReplicaAttributeOverride(image, 'aria-label', '翻訳');
    clearReplicaAttributeOverride(image, 'aria-label');
    expect(image.getAttribute('aria-label')).toBe('');
  });

  it('remembers the page value from the first override, not from a later one', () => {
    const paragraph = element('<p lang="fr">Bonjour</p>');
    setReplicaAttributeOverride(paragraph, 'lang', 'ja');
    setReplicaAttributeOverride(paragraph, 'lang', 'de');
    expect(paragraph.getAttribute('lang')).toBe('de');
    clearReplicaAttributeOverride(paragraph, 'lang');
    expect(paragraph.getAttribute('lang')).toBe('fr');
  });

  it('takes a page patch as the value to put back and goes on showing the override', () => {
    const paragraph = element('<p lang="fr">Bonjour</p>');
    setReplicaAttributeOverride(paragraph, 'lang', 'ja');

    rewrite(paragraph, [['lang', 'es'], ['class', 'b']]);
    expect(paragraph.getAttribute('lang')).toBe('ja');
    expect(pageAttribute(paragraph, 'lang')).toBe('es');

    rewrite(paragraph, [['class', 'c']]);
    expect(paragraph.getAttribute('lang')).toBe('ja');
    expect(pageAttribute(paragraph, 'lang')).toBeNull();

    clearReplicaAttributeOverride(paragraph, 'lang');
    expect(paragraph.hasAttribute('lang')).toBe(false);
    expect(paragraph.getAttribute('class')).toBe('c');
  });

  it('lists the page\'s attributes without the overrides', () => {
    const image = element('<img alt="A boat" class="hero">');
    setReplicaAttributeOverride(image, 'aria-label', 'ボート');
    setReplicaAttributeOverride(image, 'class', 'shown');
    expect([...pageAttributes(image)].sort()).toEqual([
      ['alt', 'A boat'],
      ['class', 'hero'],
    ]);
    // Restoring that list as a patch would keeps both overrides.
    rewrite(image, pageAttributes(image));
    expect(image.getAttribute('aria-label')).toBe('ボート');
    expect(image.getAttribute('class')).toBe('shown');
    clearReplicaAttributeOverride(image, 'aria-label');
    clearReplicaAttributeOverride(image, 'class');
    expect(image.hasAttribute('aria-label')).toBe(false);
    expect(image.getAttribute('class')).toBe('hero');
  });

  it('does nothing for an element or attribute that has no override', () => {
    const paragraph = element('<p lang="fr">Bonjour</p>');
    clearReplicaAttributeOverride(paragraph, 'lang');
    reapplyReplicaAttributeOverrides(paragraph);
    expect(paragraph.getAttribute('lang')).toBe('fr');
    expect(pageAttributes(paragraph)).toEqual([['lang', 'fr']]);
  });

  it('writes an attribute in its namespace, each time it writes it', () => {
    const paragraph = element('<p lang="fr">Bonjour</p>');
    const written: (readonly [string | null, string, string])[] = [];
    const write = paragraph.setAttributeNS.bind(paragraph);
    paragraph.setAttributeNS = (namespace, name, value): void => {
      written.push([namespace, name, value]);
      write(namespace, name, value);
    };
    const namespace = 'http://www.w3.org/XML/1998/namespace';

    setReplicaAttributeOverride(paragraph, 'simul:lang', 'fr', namespace);
    expect(paragraph.getAttribute('simul:lang')).toBe('fr');
    setReplicaAttributeOverride(paragraph, 'simul:lang', 'de', namespace);
    // The page's patch takes it off with the rest; it is written back.
    rewrite(paragraph, [['lang', 'de'], ['class', 'a']]);
    expect(written).toEqual([
      [namespace, 'simul:lang', 'fr'],
      [namespace, 'simul:lang', 'de'],
      [namespace, 'simul:lang', 'de'],
    ]);
    // It is Simul's: not among the page's attributes, and gone when cleared.
    expect(pageAttributes(paragraph).map(([name]) => name).sort())
      .toEqual(['class', 'lang']);
    clearReplicaAttributeOverride(paragraph, 'simul:lang');
    expect(paragraph.hasAttribute('simul:lang')).toBe(false);
    expect(paragraph.attributes.length).toBe(2);
  });
});
