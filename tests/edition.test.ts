import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  IS_DEV_EDITION,
  SIMUL_EDITION,
  SIMUL_EDITIONS,
  parseSimulEdition,
} from '../lib/edition';
import { applyEditionToDocument, hasEditionMarkers } from '../lib/edition-markup';

describe('build edition', () => {
  it('builds the public edition unless asked for exactly the dev one', () => {
    expect(SIMUL_EDITIONS).toEqual(['public', 'dev']);
    expect(parseSimulEdition('dev')).toBe('dev');
    expect(parseSimulEdition(' DEV ')).toBe('dev');
    for (const value of [undefined, '', 'public', 'development', '1', 1, null]) {
      expect(parseSimulEdition(value), String(value)).toBe('public');
    }
  });

  it('runs the test suite as the dev edition (vitest.config.ts)', () => {
    expect(SIMUL_EDITION).toBe('dev');
    expect(IS_DEV_EDITION).toBe(true);
  });
});

describe('edition markup', () => {
  const page = `<!doctype html><html><body>
    <div id="main">
      <label id="layout" data-public-move="slot-layout">Layout</label>
      <button id="rebuild" data-edition="dev">Rebuild</button>
    </div>
    <details id="dev-group" data-edition="dev">
      <label id="opens" data-public-move="slot-opens">Opens</label>
      <input id="testing">
    </details>
    <details id="advanced" data-edition="public">
      <div id="slot-layout" data-edition="public"></div>
      <div id="slot-opens" data-edition="public"></div>
    </details>
  </body></html>`;

  it('moves controls into their public slots and drops dev-only ones', () => {
    const { document } = parseHTML(page);
    applyEditionToDocument(document as unknown as Document, 'public');

    expect([...document.querySelectorAll('#advanced > *')].map((element) => element.id))
      .toEqual(['layout', 'opens']);
    for (const id of ['rebuild', 'dev-group', 'testing', 'slot-layout', 'slot-opens']) {
      expect(document.getElementById(id), id).toBeNull();
    }
    expect(document.querySelector('[data-edition], [data-public-move]')).toBeNull();
  });

  it('keeps the dev layout and drops the public-only elements', () => {
    const { document } = parseHTML(page);
    applyEditionToDocument(document as unknown as Document, 'dev');

    expect(document.querySelector('#main #layout')).not.toBeNull();
    expect(document.querySelector('#dev-group #opens')).not.toBeNull();
    expect(document.getElementById('rebuild')).not.toBeNull();
    expect(document.getElementById('advanced')).toBeNull();
    expect(document.querySelector('[data-edition], [data-public-move]')).toBeNull();
  });

  it('refuses a move whose slot is missing', () => {
    const { document } = parseHTML(
      '<html><body><p data-public-move="nowhere"></p></body></html>',
    );

    expect(() => applyEditionToDocument(document as unknown as Document, 'public'))
      .toThrow('Missing public edition slot: nowhere');
  });

  it('leaves pages without markers alone', () => {
    expect(hasEditionMarkers('<html><body><p>plain</p></body></html>')).toBe(false);
    expect(hasEditionMarkers('<p data-edition="dev"></p>')).toBe(true);
  });
});
