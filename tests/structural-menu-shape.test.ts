import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  isStructuralButtonMenu,
  structuralMenuOpening,
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
});
