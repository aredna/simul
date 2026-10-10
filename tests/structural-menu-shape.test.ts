import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  MAX_STRUCTURAL_MENU_PANEL_WRAPPERS,
  isStructuralButtonMenu,
  mayBeStructuralButtonMenu,
  structuralMenuOpening,
  structuralMenuPanelCandidates,
} from '../lib/replica/structural-menu-shape';

describe('structural menu shapes (D132)', () => {
  const page = (markup: string) => parseHTML(
    `<html><body>${markup}</body></html>`,
  ).document;

  it('opens on hover in navigation, a header or a list item, with one trigger or two', () => {
    const document = page(`
      <nav><div id="nav"><a href="/a">A</a><ul><li>x</li></ul></div></nav>
      <header><div id="header"><span>B</span><div><a href="/b">y</a></div></div></header>
      <ul><li id="item"><a href="/c">C</a><button>v</button><ul><li>z</li></ul></li></ul>`);
    for (const id of ['nav', 'header', 'item']) {
      const container = document.querySelector(`#${id}`)!;
      const children = [...container.children];
      const panel = children.at(-1)!;
      expect(structuralMenuOpening(container, children.slice(0, -1), panel), id)
        .toBe('hover');
    }
    // Never more than two triggers, never none.
    const item = document.querySelector('#item')!;
    const [link, arrow, list] = [...item.children] as [Element, Element, Element];
    expect(structuralMenuOpening(item, [link, arrow, link], list)).toBeUndefined();
    expect(structuralMenuOpening(item, [], list)).toBeUndefined();
  });

  it('takes only a button beside a list for a menu anywhere else, opened by a click', () => {
    const document = page(`
      <div id="actions"><button>Actions</button><ul><li>Edit</li></ul></div>
      <div id="role"><div role="button">More</div><div role="menu">Items</div></div>
      <div id="accordion"><button>Section</button><div>Body</div></div>
      <div id="link"><a href="/x">Link</a><ul><li>x</li></ul></div>
      <div id="tab"><button role="tab">Tab</button><ul><li>x</li></ul></div>
      <div id="split"><a href="/x">Link</a><button>v</button><ul><li>x</li></ul></div>`);
    const opening = (id: string) => {
      const container = document.querySelector(`#${id}`)!;
      const children = [...container.children];
      return structuralMenuOpening(container, children.slice(0, -1), children.at(-1)!);
    };
    expect(opening('actions')).toBe('click');
    expect(opening('role')).toBe('click');
    // A block beside a button is as often an accordion's body or a dialog.
    expect(opening('accordion')).toBeUndefined();
    expect(opening('link')).toBeUndefined();
    expect(opening('tab')).toBeUndefined();
    // Two triggers only where menus are expected.
    expect(opening('split')).toBeUndefined();
    const [button, list] = [...document.querySelector('#actions')!.children] as
      [Element, Element];
    expect(isStructuralButtonMenu(button, list)).toBe(true);
    expect(isStructuralButtonMenu(list, button)).toBe(false);
  });

  it('looks for a panel inside wrappers that hold one element and no text', () => {
    const document = page(`
      <div id="plain">
        <ul id="plain-list"><li>x</li><li>y</li></ul>
      </div>
      <div id="two"><div id="two-inner">
        <ul id="two-list"><li>x</li><li>y</li></ul>
      </div></div>
      <div id="text">A note <ul><li>x</li></ul></div>
      <div id="pair"><span></span><ul><li>x</li></ul></div>
      <div id="comment"><!-- a comment is nothing --><ul id="comment-list"><li>x</li><li>y</li></ul></div>
      <a id="link" href="/x"><span>Inside a link</span></a>
      <label id="label"><span>Inside a label</span></label>
      <div id="empty"></div>`);
    const ids = (id: string) => structuralMenuPanelCandidates(
      document.querySelector(`#${id}`)!,
    ).map((element) => element.id);
    // The child itself comes first: the page side takes the outermost
    // candidate that is collapsed. One wrapper, and no deeper.
    expect(ids('plain')).toEqual(['plain', 'plain-list']);
    expect(ids('two')).toEqual(['two', 'two-inner']);
    expect(ids('comment')).toEqual(['comment', 'comment-list']);
    // Text or a second element beside it: page content, not a wrapper.
    expect(ids('text')).toEqual(['text']);
    expect(ids('pair')).toEqual(['pair']);
    expect(ids('empty')).toEqual(['empty']);
    // Nothing is looked for inside a link or a control.
    expect(ids('link')).toEqual(['link']);
    expect(ids('label')).toEqual(['label']);
  });

  it('looks no deeper than the wrappers it allows', () => {
    const depth = MAX_STRUCTURAL_MENU_PANEL_WRAPPERS + 3;
    const document = page(
      `${Array.from({ length: depth }, (_, index) => `<div id="w${index}">`).join('')}` +
      `<ul><li>x</li><li>y</li></ul>${'</div>'.repeat(depth)}`,
    );
    const candidates = structuralMenuPanelCandidates(document.querySelector('#w0')!);
    expect(candidates.map((element) => element.id)).toEqual(
      Array.from({ length: MAX_STRUCTURAL_MENU_PANEL_WRAPPERS + 1 }, (_, index) =>
        `w${index}`),
    );
  });

  it('tells a button beside a list, also inside wrappers, before the panel is known', () => {
    const document = page(`
      <div id="direct"><button>Actions</button><ul><li>Edit</li></ul></div>
      <div id="wrapped"><button>Actions</button><div><ul><li>Edit</li></ul></div></div>
      <div id="deep"><button>Actions</button><div><div><ul><li>Edit</li></ul></div></div></div>
      <div id="role"><span role="button">More</span><div><div role="menu">Items</div></div></div>
      <div id="block"><button>Section</button><div><p>Body</p></div></div>
      <div id="link"><a href="/x">Link</a><div><ul><li>x</li></ul></div></div>
      <div id="tab"><button role="tab">Tab</button><div><ul><li>x</li></ul></div></div>`);
    const may = (id: string) => {
      const [first, second] = [...document.querySelector(`#${id}`)!.children] as
        [Element, Element];
      return [
        mayBeStructuralButtonMenu(first, second),
        mayBeStructuralButtonMenu(second, first),
      ];
    };
    expect(may('direct')).toEqual([true, false]);
    expect(may('wrapped')).toEqual([true, false]);
    expect(may('deep')).toEqual([false, false]);
    expect(may('role')).toEqual([true, false]);
    // No list anywhere inside: an accordion's body.
    expect(may('block')).toEqual([false, false]);
    // Not a button.
    expect(may('link')).toEqual([false, false]);
    expect(may('tab')).toEqual([false, false]);
    // The opening itself is asked of the panel, never of a wrapper around it.
    const wrapped = document.querySelector('#wrapped')!;
    const [button, wrapper] = [...wrapped.children] as [Element, Element];
    expect(structuralMenuOpening(wrapped, [button], wrapper)).toBeUndefined();
    expect(structuralMenuOpening(wrapped, [button], wrapper.querySelector('ul')!))
      .toBe('click');
  });
});
