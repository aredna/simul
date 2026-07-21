import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseHTML } from 'linkedom';

import type { LivePageDelta } from '../lib/live-page-mirror';
import {
  capturePageSnapshot,
  parsePageSnapshot,
  SNAPSHOT_LIMITS,
  type PageSnapshot,
  type VisualElementNode,
} from '../lib/page-snapshot';
import type { TranslatedSnapshot } from '../lib/translation-pipeline';
import {
  applyLivePageDelta,
  applyMirrorTextLayout,
  computeMirrorExtent,
  computeMirrorScale,
  countVisualMirrorTranslationFields,
  createVisualMirror,
  resetVisualMirrorText,
  translateVisualMirror,
} from '../lib/visual-renderer';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('visual snapshot boundary', () => {
  it('keeps safe presentation data while rejecting executable and private fields', () => {
    const snapshot = buildParsedVisualSnapshot();
    const visual = snapshot.visual;

    expect(visual).toBeDefined();
    expect(visual?.styles[0]).toEqual({
      color: 'rgb(12, 34, 56)',
      display: 'grid',
    });
    expect(visual?.styles[1]).toEqual({
      'background-image': 'url("https://cdn.example.com/background.png")',
      width: '100px',
    });

    const root = visual?.root;
    expect(root?.children.some(isTag('script'))).toBe(false);
    expect(root?.children.some(isTag('a'))).toBe(false);

    const image = root?.children.find(isTag('img'));
    expect(image).toMatchObject({
      itemId: 'image-2',
      attributes: {
        alt: '山',
        src: 'https://cdn.example.com/image.png',
      },
    });
    expect(image?.attributes).not.toHaveProperty('onclick');

    const input = root?.children.find(isTag('input'));
    expect(input).toMatchObject({
      controlShell: 'input',
      children: [],
    });
    expect(input).not.toHaveProperty('attributes');

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('javascript:');
    expect(serialized).not.toContain('cursor');
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('typed parser secret');
    expect(serialized).not.toContain('script parser secret');
    expect(serialized).not.toContain('link parser secret');
  });

  it('captures public native-select labels while keeping editable controls private', () => {
    const { document } = installCapturePage(`
      <main style="display: grid; color: rgb(1, 2, 3)">
        <p>Public copy</p>
        <input value="input capture secret">
        <textarea>textarea capture secret</textarea>
        <select name="private-select-name"><option value="private-option-value">Public option label</option></select>
        <div contenteditable="true">contenteditable capture secret</div>
        <span role="textbox">role capture secret</span>
        <span role="note textbox">fallback role capture secret</span>
        <output>output capture secret</output>
        <datalist><option>datalist capture secret</option></datalist>
      </main>
    `);
    const input = document.querySelector('input');
    const editable = document.querySelector('[contenteditable]');

    const snapshot = capturePageSnapshot();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).toContain('Public copy');
    expect(serialized).not.toContain('input capture secret');
    expect(serialized).not.toContain('textarea capture secret');
    expect(serialized).toContain('Public option label');
    expect(serialized).not.toContain('private-select-name');
    expect(serialized).not.toContain('private-option-value');
    expect(serialized).not.toContain('contenteditable capture secret');
    expect(serialized).not.toContain('role capture secret');
    expect(serialized).not.toContain('fallback role capture secret');
    expect(serialized).not.toContain('output capture secret');
    expect(serialized).not.toContain('datalist capture secret');
    expect(snapshot.omissions.controls).toBeGreaterThanOrEqual(8);

    expect(input?.getAttribute('value')).toBe('input capture secret');
    expect(editable?.textContent).toBe('contenteditable capture secret');

    const shells = collectElements(snapshot.visual?.root).filter(
      (node) => node.controlShell !== undefined,
    );
    expect(shells.map((node) => node.controlShell)).toEqual([
      'input',
      'textarea',
      'select',
      'input',
      'input',
      'input',
      'input',
      'input',
    ]);
    expect(
      shells
        .filter((node) => node.controlShell !== 'select')
        .every((node) => node.children.length === 0),
    ).toBe(true);
    expect(
      shells.find((node) => node.controlShell === 'select')?.children,
    ).toHaveLength(1);
    expect(shells.every((node) => node.attributes === undefined)).toBe(true);
  });

  it('captures bounded native select structure and current presentation state', () => {
    installCapturePage(`
      <select multiple disabled name="private-name">
        <optgroup label="Regions" disabled data-private="group-secret">
          <option selected value="private-tokyo">Tokyo</option>
          <option disabled value="private-osaka">Osaka</option>
        </optgroup>
        <option selected value="private-seoul">Seoul</option>
        <option role="textbox" selected label="private role label">private role text</option>
        <option><span contenteditable="true">private editor label</span></option>
      </select>
    `);

    const snapshot = capturePageSnapshot();
    const select = collectElements(snapshot.visual?.root).find(
      (node) => node.controlShell === 'select',
    );
    const serialized = JSON.stringify(select);

    expect(select?.selectState).toEqual({
      disabled: true, multiple: true, open: false,
    });
    expect(select?.children).toHaveLength(4);
    expect(serialized).toContain('Regions');
    expect(serialized).toContain('Tokyo');
    expect(serialized).toContain('Osaka');
    expect(serialized).toContain('Seoul');
    expect(serialized).toContain('"selected":true');
    expect(serialized).toContain('"disabled":true');
    expect(serialized).not.toContain('private-name');
    expect(serialized).not.toContain('private-tokyo');
    expect(serialized).not.toContain('private-osaka');
    expect(serialized).not.toContain('private-seoul');
    expect(serialized).not.toContain('private role label');
    expect(serialized).not.toContain('private role text');
    expect(serialized).not.toContain('private editor label');
    expect(serialized).not.toContain('group-secret');
  });

  it('fails native selects closed for private roles and activation ancestry', () => {
    installCapturePage(`
      <main>
        <select role="combobox"><option>private role option</option></select>
        <select role="button"><option>private activation option</option></select>
        <div role="button">
          <select><option>private nested activation option</option></select>
        </div>
      </main>
    `);

    const snapshot = capturePageSnapshot();
    const serialized = JSON.stringify(snapshot.visual);
    const elements = collectElements(snapshot.visual?.root);

    expect(serialized).not.toContain('private role option');
    expect(serialized).not.toContain('private activation option');
    expect(serialized).not.toContain('private nested activation option');
    expect(elements.some((node) => node.tag === 'select')).toBe(false);
    expect(
      elements.filter((node) => node.controlShell === 'input').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('bounds rich option privacy scans and omits entry resource URLs', () => {
    const { document } = installCapturePage(`
      <select>
        <optgroup label="Public group" style="background-image: url('https://private.example/group.png'); color: red">
          <option style="background-image: url('https://private.example/option.png'); color: blue">Public option</option>
        </optgroup>
      </select>
    `);
    const select = document.querySelector('select');
    const oversized = document.createElement('option');
    for (let index = 0; index < 513; index += 1) {
      oversized.append(document.createElement('span'));
    }
    const privateEditor = document.createElement('span');
    privateEditor.setAttribute('contenteditable', 'true');
    privateEditor.textContent = 'private late editor';
    oversized.append(privateEditor);
    select?.append(oversized);

    const snapshot = capturePageSnapshot();
    const serialized = JSON.stringify(snapshot.visual);
    const visualSelect = collectElements(snapshot.visual?.root).find(
      (node) => node.controlShell === 'select',
    );
    const oversizedOption = visualSelect?.children.at(-1);

    expect(serialized).toContain('Public group');
    expect(serialized).toContain('Public option');
    expect(serialized).not.toContain('private.example');
    expect(serialized).not.toContain('private late editor');
    expect(oversizedOption).toMatchObject({
      kind: 'element',
      tag: 'option',
      children: [],
    });
    expect(snapshot.omissions.truncated).toBe(true);
  });

  it('omits hidden and offscreen backing entries without exposing fallback text', () => {
    installCapturePage(`
      <select style="position:absolute;left:-10000px;width:100px">
        <option>offscreen backing secret</option>
      </select>
      <select>
        <option label="   ">whitespace fallback secret</option>
        <option hidden>hidden option secret</option>
        <optgroup label="Public group">
          <legend hidden>hidden legend secret</legend>
          <option>Public child</option>
        </optgroup>
      </select>
    `);

    const snapshot = capturePageSnapshot();
    const serialized = JSON.stringify(snapshot.visual);
    const visibleSelect = collectElements(snapshot.visual?.root).find(
      (node) => node.controlShell === 'select',
    );

    expect(serialized).toContain('Public child');
    expect(serialized).not.toContain('offscreen backing secret');
    expect(serialized).not.toContain('whitespace fallback secret');
    expect(serialized).not.toContain('hidden option secret');
    expect(serialized).not.toContain('hidden legend secret');
    expect(visibleSelect?.children.filter(
      (child) => child.kind === 'element' && child.tag === 'option',
    )).toHaveLength(1);
  });

  it('accepts only typed public labels and state in untrusted select visual data', () => {
    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Select boundary',
      url: 'https://example.com/',
      capturedAt: '2026-07-21T00:00:00.000Z',
      items: [],
      omissions: {},
      visual: {
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 600,
        styles: [
          {},
          {
            'background-image': 'url("https://private.example/option.png")',
            color: 'red',
          },
        ],
        root: {
          kind: 'element',
          tag: 'select',
          styleId: 0,
          controlShell: 'select',
          selectState: { disabled: false, multiple: true, open: false },
          attributes: { name: 'private-name', value: 'private-value' },
          children: [
            {
              kind: 'element',
              tag: 'option',
              styleId: 1,
              optionState: { disabled: false, selected: true },
              attributes: { value: 'private-option', onclick: 'attack()' },
              children: [{ kind: 'text', text: 'Public option' }],
            },
          ],
        },
      },
    });
    const select = snapshot.visual?.root;

    expect(select?.selectState).toEqual({
      disabled: false, multiple: true, open: false,
    });
    expect(select?.attributes).toBeUndefined();
    expect(select?.children).toHaveLength(1);
    expect(select?.children[0]).toMatchObject({
      kind: 'element',
      tag: 'option',
      optionState: { disabled: false, selected: true },
    });
    expect(select?.children[0]).not.toHaveProperty('attributes');
    expect(JSON.stringify(select)).toContain('Public option');
    expect(JSON.stringify(select)).not.toContain('private-option');
    expect(JSON.stringify(select)).not.toContain('arbitrary private child');

    const { document } = parseHTML('<html><body></body></html>');
    const mirror = createVisualMirror(snapshot, undefined, document);
    const option = mirror?.querySelector<HTMLElement>(
      '[data-simul-select-option]',
    );
    expect(option?.style.backgroundImage).toBe('');
    expect(option?.style.color).toBe('red');
  });

  it('requires raw select tags and select control shells to imply each other', () => {
    const rawSnapshot = (controlShell?: string) => ({
      version: 1,
      title: 'Forged select boundary',
      url: 'https://example.com/',
      capturedAt: '2026-07-21T00:00:00.000Z',
      items: [],
      omissions: {},
      visual: {
        viewportWidth: 800,
        viewportHeight: 600,
        documentWidth: 800,
        documentHeight: 600,
        styles: [{}],
        root: {
          kind: 'element',
          tag: 'select',
          styleId: 0,
          ...(controlShell ? { controlShell } : {}),
          ...(controlShell === 'select'
            ? {
                selectState: {
                  disabled: false,
                  multiple: false,
                  open: false,
                },
              }
            : {}),
          children: [],
        },
      },
    });

    expect(() => parsePageSnapshot(rawSnapshot())).toThrow();
    expect(() => parsePageSnapshot(rawSnapshot('input'))).toThrow();
    expect(() => parsePageSnapshot(rawSnapshot('select'))).not.toThrow();
    const malformed = rawSnapshot('select');
    (malformed.visual.root.selectState as { disabled: unknown }).disabled = 'yes';
    expect(() => parsePageSnapshot(malformed)).toThrow();
    const malformedChild = rawSnapshot('select');
    (malformedChild.visual.root.children as unknown[]).push({
      kind: 'element', tag: 'div', styleId: 0, children: [],
    });
    expect(() => parsePageSnapshot(malformedChild)).toThrow();
    const placeholderChild = rawSnapshot('select');
    (placeholderChild.visual.root.children as unknown[]).push({
      kind: 'placeholder', styleId: 0, label: 'Canvas content omitted',
    });
    expect(() => parsePageSnapshot(placeholderChild)).toThrow();
    const optgroupPlaceholder = rawSnapshot('select');
    (optgroupPlaceholder.visual.root.children as unknown[]).push({
      kind: 'element',
      tag: 'optgroup',
      styleId: 0,
      optgroupState: { disabled: false },
      children: [{
        kind: 'placeholder', styleId: 0, label: 'Canvas content omitted',
      }],
    });
    expect(() => parsePageSnapshot(optgroupPlaceholder)).toThrow();
  });

  it('retains public button labels in inert shells', () => {
    installCapturePage(`
      <main>
        <button>Sign in</button>
        <span role="button">Related articles</span>
        <button aria-label="Open menu"><svg></svg></button>
        <span role="button" title="Save article"><svg></svg></span>
      </main>
    `);

    const snapshot = capturePageSnapshot();
    const shells = collectElements(snapshot.visual?.root).filter(
      (node) => node.controlShell === 'button',
    );

    expect(snapshot.items.some((item) => item.kind === 'text' && item.text.includes('Sign in'))).toBe(true);
    expect(JSON.stringify(shells)).toContain('Sign in');
    expect(JSON.stringify(shells)).toContain('Related articles');
    expect(JSON.stringify(shells)).toContain('Open menu');
    expect(JSON.stringify(shells)).toContain('Save article');
  });

  it('does not confuse accessibility-only state with visual hiding', () => {
    installCapturePage(
      '<main><aside aria-hidden="true">Visible decorative rail</aside><div inert>Visible inert backdrop</div></main>',
    );

    const snapshot = capturePageSnapshot();

    expect(JSON.stringify(snapshot)).toContain('Visible decorative rail');
    expect(JSON.stringify(snapshot)).toContain('Visible inert backdrop');
  });

  it('captures accessible content from an open shadow tree', () => {
    const { document } = installCapturePage('<main><reader-rail></reader-rail></main>');
    const host = document.querySelector('reader-rail');
    if (!host || typeof host.attachShadow !== 'function') {
      throw new Error('Expected open shadow-root support in the test DOM.');
    }
    host.attachShadow({ mode: 'open' }).innerHTML = '<aside><p>Late related rail</p></aside>';

    const snapshot = capturePageSnapshot();

    expect(JSON.stringify(snapshot)).toContain('Late related rail');
  });

  it('retains late side rails beyond the former shallow visual bound', () => {
    const longCenter = Array.from(
      { length: 1_700 },
      (_value, index) => `<div>Center item ${index}</div>`,
    ).join('');
    installCapturePage(
      `<main>${longCenter}</main><aside>Sign in rail</aside><aside>Related articles rail</aside>`,
    );

    const snapshot = capturePageSnapshot();
    const visual = JSON.stringify(snapshot.visual);

    expect(visual).toContain('Sign in rail');
    expect(visual).toContain('Related articles rail');
  });

  it('enforces aggregate visual style and attribute budgets', () => {
    const styles = Array.from(
      { length: SNAPSHOT_LIMITS.maxVisualStyles },
      () => ({
        color: 'x'.repeat(SNAPSHOT_LIMITS.maxVisualValueLength),
        'font-family': 'y'.repeat(SNAPSHOT_LIMITS.maxVisualValueLength),
        'box-shadow': 'z'.repeat(SNAPSHOT_LIMITS.maxVisualValueLength),
      }),
    );
    const children = Array.from(
      { length: SNAPSHOT_LIMITS.maxVisualNodes - 1 },
      () => ({
        kind: 'element',
        tag: 'path',
        styleId: 0,
        attributes: {
          d: 'M'.repeat(SNAPSHOT_LIMITS.maxVisualAttributeLength),
        },
        children: [],
      }),
    );

    const snapshot = parsePageSnapshot({
      version: 1,
      title: 'Bounded visual',
      url: 'https://example.com/',
      capturedAt: '2026-07-19T00:00:00.000Z',
      items: [],
      omissions: {},
      visual: {
        viewportWidth: 1_200,
        viewportHeight: 800,
        documentWidth: 1_200,
        documentHeight: 2_000,
        styles,
        root: {
          kind: 'element',
          tag: 'svg',
          styleId: 0,
          children,
        },
      },
    });

    const styleCharacters = (snapshot.visual?.styles ?? []).reduce(
      (total, style) =>
        total +
        Object.entries(style).reduce(
          (styleTotal, [property, value]) =>
            styleTotal + property.length + value.length,
          0,
        ),
      0,
    );
    const attributeCharacters = collectElements(snapshot.visual?.root).reduce(
      (total, node) =>
        total +
        Object.entries(node.attributes ?? {}).reduce(
          (nodeTotal, [name, value]) =>
            nodeTotal + name.length + value.length,
          0,
        ),
      0,
    );

    expect(styleCharacters).toBeLessThanOrEqual(
      SNAPSHOT_LIMITS.maxVisualStyleCharacters,
    );
    expect(attributeCharacters).toBeLessThanOrEqual(
      SNAPSHOT_LIMITS.maxVisualAttributeCharacters,
    );
  });
});

describe('visual mirror renderer', () => {
  it('renders and translates an inert expandable native-select facsimile', async () => {
    const { document: sourceDocument } = installCapturePage(`
      <select multiple>
        <optgroup label="Regions" disabled>
          <option selected value="private-tokyo">Tokyo</option>
          <option disabled value="private-osaka">Osaka</option>
        </optgroup>
        <option selected value="private-seoul">Seoul</option>
      </select>
    `);
    const sourceSelect = sourceDocument.querySelector('select')!;
    Object.defineProperty(sourceSelect, 'matches', {
      configurable: true,
      value: (selector: string) => selector === ':open',
    });
    const snapshot = capturePageSnapshot();
    const { document } = parseHTML('<html><body></body></html>');
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected a visual mirror.');
    document.body.append(mirror);

    const disclosure = mirror.querySelector<HTMLElement>(
      '[data-simul-select-facsimile]',
    );
    const summary = disclosure?.querySelector<HTMLElement>(
      '[data-simul-select-summary]',
    );
    const list = disclosure?.querySelector<HTMLElement>(
      '[data-simul-select-options]',
    );
    const options = [
      ...(disclosure?.querySelectorAll<HTMLElement>('[data-simul-select-option]') ?? []),
    ];

    expect(disclosure?.tagName).toBe('DETAILS');
    expect(disclosure?.dataset.simulSelectMultiple).toBe('true');
    expect(disclosure?.getAttribute('aria-disabled')).toBe('true');
    expect(disclosure?.style.pointerEvents).toBe('auto');
    expect(disclosure?.hasAttribute('open')).toBe(true);
    expect(summary?.getAttribute('aria-label')).toBe('Show translated options');
    expect(summary?.textContent).toBe('Tokyo, Seoul');
    expect(list?.style.maxHeight).toBe('min(20rem, 50vh)');
    expect(list?.style.overflowY).toBe('auto');
    expect(options).toHaveLength(3);
    expect(options.map((option) => option.textContent)).toEqual([
      'Tokyo',
      'Osaka',
      'Seoul',
    ]);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-disabled')).toBe('true');
    expect(mirror.querySelector('select')).toBeNull();
    expect(mirror.querySelector('script')).toBeNull();
    expect(mirror.outerHTML).not.toContain('private-tokyo');

    const sources: string[] = [];
    await translateVisualMirror(mirror, async (source) => {
      sources.push(source);
      return `[${source}]`;
    });

    expect(sources).toEqual(['Regions', 'Tokyo', 'Osaka', 'Seoul']);
    expect(summary?.textContent).toBe('[Tokyo], [Seoul]');
    expect(options.map((option) => option.textContent)).toEqual([
      '[Tokyo]',
      '[Osaka]',
      '[Seoul]',
    ]);
    expect(list?.style.overflowY).toBe('auto');

    resetVisualMirrorText(mirror);
    expect(summary?.textContent).toBe('Tokyo, Seoul');
  });

  it('does not invent a selected value when the source select has none', () => {
    installCapturePage(`
      <select multiple>
        <option>Tokyo</option>
        <option>Osaka</option>
      </select>
    `);
    const snapshot = capturePageSnapshot();
    const { document } = parseHTML('<html><body></body></html>');
    const mirror = createVisualMirror(snapshot, undefined, document);

    expect(
      mirror?.querySelector('[data-simul-select-summary]')?.textContent,
    ).toBe('\u2014');
    expect([
      ...(mirror?.querySelectorAll<HTMLElement>('[data-simul-select-option]') ?? []),
    ].map((option) => option.textContent)).toEqual(['Tokyo', 'Osaka']);
  });

  it('translates every select label admitted by the visual capture budget', async () => {
    const optionCount = 1_501;
    installCapturePage(`
      <select multiple>
        ${Array.from(
          { length: optionCount },
          (_, index) => `<option>Option ${index}</option>`,
        ).join('')}
      </select>
    `);
    const snapshot = capturePageSnapshot();
    const { document } = parseHTML('<html><body></body></html>');
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected a visual mirror.');
    document.body.append(mirror);

    expect(countVisualMirrorTranslationFields(mirror)).toBe(optionCount);
    const result = await translateVisualMirror(
      mirror,
      async (source) => `[${source}]`,
    );
    const options = [
      ...mirror.querySelectorAll<HTMLElement>('[data-simul-select-option]'),
    ];

    expect(result).toEqual({
      completed: optionCount,
      failed: 0,
      total: optionCount,
    });
    expect(options.at(-1)?.textContent).toBe(`[Option ${optionCount - 1}]`);
  });

  it('renders translated text and image alt text into an inert mirror', () => {
    const snapshot = buildParsedVisualSnapshot();
    const translated = buildTranslatedSnapshot(snapshot);
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);

    expect(mirror).toBeDefined();
    expect(mirror?.getAttribute('data-simul-inert-mirror')).toBe('');
    expect(mirror?.style.pointerEvents).toBe('none');
    expect(mirror?.textContent).toContain('Hello');
    expect(mirror?.textContent).not.toContain('こんにちは');

    const image = mirror?.querySelector('img');
    expect(image?.getAttribute('src')).toBe(
      'https://cdn.example.com/image.png',
    );
    expect(image?.getAttribute('alt')).toBe('Mountain');
    expect(image?.loading).toBe('lazy');
    expect(image?.referrerPolicy).toBe('no-referrer');

    const input = mirror?.querySelector<HTMLElement>('[data-simul-control-shell="input"]');
    expect(input?.getAttribute('aria-disabled')).toBe('true');
    expect(input?.tabIndex).toBe(-1);
    expect(input?.textContent).toBe('');
    expect(mirror?.querySelector('input')).toBeNull();
    expect(mirror?.querySelector('script')).toBeNull();
    expect(mirror?.querySelector('a')).toBeNull();
    expect(mirror?.outerHTML).not.toContain('typed parser secret');
    expect(mirror?.outerHTML).not.toContain('onclick');
  });

  it('translates and resets bound bootstrap text and safe image alt fields', async () => {
    const snapshot = buildParsedVisualSnapshot();
    const { document } = parseHTML('<html><body></body></html>');
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected a visual mirror.');
    expect(countVisualMirrorTranslationFields(mirror)).toBe(2);
    document.body.append(mirror);
    const sources: string[] = [];

    const result = await translateVisualMirror(mirror, async (source) => {
      sources.push(source);
      return `[${source}]`;
    });

    expect(result).toEqual({ completed: 2, failed: 0, total: 2 });
    expect(sources).toEqual(['こんにちは', '山']);
    expect(mirror.textContent).toContain('[こんにちは]');
    expect(mirror.querySelector('img')?.getAttribute('alt')).toBe('[山]');

    resetVisualMirrorText(mirror);

    expect(mirror.textContent).toContain('こんにちは');
    expect(mirror.querySelector('img')?.getAttribute('alt')).toBe('山');
  });

  it('keeps restored source text when a provider resolves after cancellation', async () => {
    const snapshot = buildParsedVisualSnapshot();
    const { document } = parseHTML('<html><body></body></html>');
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected a visual mirror.');
    document.body.append(mirror);
    await translateVisualMirror(mirror, async (source) => `[${source}]`);
    expect(mirror.textContent).toContain('[こんにちは]');

    const abortController = new AbortController();
    let announceTranslation!: () => void;
    let releaseTranslation!: (value: string) => void;
    const translationStarted = new Promise<void>((resolve) => {
      announceTranslation = resolve;
    });
    const blockedTranslation = new Promise<string>((resolve) => {
      releaseTranslation = resolve;
    });
    const lateTranslation = translateVisualMirror(
      mirror,
      async () => {
        announceTranslation();
        return blockedTranslation;
      },
      { signal: abortController.signal },
    );
    await translationStarted;

    abortController.abort();
    resetVisualMirrorText(mirror);
    releaseTranslation('Late translated text');

    await expect(lateTranslation).rejects.toMatchObject({ name: 'AbortError' });
    expect(mirror.textContent).toContain('こんにちは');
    expect(mirror.textContent).not.toContain('Late translated text');
    expect(mirror.querySelector('img')?.getAttribute('alt')).toBe('山');
  });

  it('commits a translated live root atomically and preserves the old root on abort', async () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    vi.stubGlobal('HTMLImageElement', window.HTMLImageElement);
    const snapshot = buildLiveRootSnapshot();
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected a visual mirror.');
    document.body.append(mirror);
    const delta: LivePageDelta = {
      version: 1,
      generation: 1,
      sequence: 1,
      url: 'https://example.com/',
      documentWidth: 800,
      documentHeight: 600,
      desynchronized: false,
      replacements: [
        {
          targetId: 'n1',
          node: {
            kind: 'element',
            nodeId: 'n1',
            tag: 'main',
            style: { display: 'block' },
            children: [
              { kind: 'text', nodeId: 'n3', text: 'New live copy' },
            ],
          },
        },
      ],
    };
    const abortController = new AbortController();
    let announceTranslation!: () => void;
    let releaseTranslation!: (value: string) => void;
    const translationStarted = new Promise<void>((resolve) => {
      announceTranslation = resolve;
    });
    const blockedTranslation = new Promise<string>((resolve) => {
      releaseTranslation = resolve;
    });

    const abortedUpdate = applyLivePageDelta(mirror, delta, {
      textLayoutMode: 'adaptive',
      signal: abortController.signal,
      translate: async () => {
        announceTranslation();
        return blockedTranslation;
      },
    });
    await translationStarted;

    expect(document.body.firstElementChild).toBe(mirror);
    expect(mirror.isConnected).toBe(true);
    expect(mirror.textContent).toBe('Old live copy');

    abortController.abort();
    releaseTranslation('Aborted translation');
    await expect(abortedUpdate).rejects.toMatchObject({ name: 'AbortError' });

    expect(document.body.firstElementChild).toBe(mirror);
    expect(mirror.isConnected).toBe(true);
    expect(mirror.textContent).toBe('Old live copy');
    expect(countVisualMirrorTranslationFields(mirror)).toBe(1);

    const completedUpdate = await applyLivePageDelta(mirror, delta, {
      textLayoutMode: 'adaptive',
      translate: async (source) => `[${source}]`,
    });

    expect(completedUpdate.root).not.toBe(mirror);
    expect(document.body.firstElementChild).toBe(completedUpdate.root);
    expect(completedUpdate.root.textContent).toBe('[New live copy]');
    expect(countVisualMirrorTranslationFields(mirror)).toBe(0);
    expect(countVisualMirrorTranslationFields(completedUpdate.root)).toBe(1);
  });

  it('preserves layout whitespace around translated inline text', () => {
    const snapshot = buildParsedVisualSnapshot();
    const textNode = snapshot.visual?.root.children[0];
    if (!textNode || textNode.kind !== 'text') {
      throw new Error('Expected the visual text fixture.');
    }
    textNode.text = '  こんにちは\n';
    const translated = buildTranslatedSnapshot(snapshot);
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);

    expect(mirror?.textContent).toContain('  Hello\n');
  });

  it('translates an inline-formatted sentence as one grammatical unit', () => {
    installCapturePage('<p>I <em>love</em> cats</p>');
    const snapshot = capturePageSnapshot();
    const textItem = snapshot.items.find((item) => item.kind === 'text');
    if (!textItem || textItem.kind !== 'text') {
      throw new Error('Expected a grouped text item.');
    }
    expect(textItem.text).toBe('I love cats');

    const translated: TranslatedSnapshot = {
      snapshot,
      items: [
        {
          ...textItem,
          translation: {
            source: textItem.text,
            translated: '私は猫が大好きです',
            state: 'translated',
          },
        },
      ],
      state: 'complete',
      completed: 1,
      total: 1,
      failed: 0,
    };
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);

    expect(mirror?.textContent).toContain('私は猫が大好きです');
    expect(mirror?.textContent).not.toContain('I love cats');
    expect(mirror?.querySelector('em')).not.toBeNull();
  });

  it('redistributes grouped inline translations without splitting target segments', () => {
    installCapturePage('<p>I <em>love</em> cats</p>');
    const snapshot = capturePageSnapshot();
    const textItem = snapshot.items.find((item) => item.kind === 'text');
    if (!textItem || textItem.kind !== 'text') {
      throw new Error('Expected a grouped text item.');
    }
    const target = 'extraordinary hi 👩‍💻 collaboration';
    const translated: TranslatedSnapshot = {
      snapshot,
      items: [
        {
          ...textItem,
          translation: {
            source: textItem.text,
            translated: target,
            state: 'translated',
          },
        },
      ],
      state: 'complete',
      completed: 1,
      total: 1,
      failed: 0,
    };
    const { document } = parseHTML('<html><body></body></html>');

    const mirror = createVisualMirror(snapshot, translated, document);
    const paragraph = mirror?.querySelector('p');
    const chunks = Array.from(
      paragraph?.childNodes ?? [],
      (node) => node.textContent ?? '',
    );
    const wordBoundaries = segmentBoundaries(target, 'word');
    const graphemeBoundaries = segmentBoundaries(target, 'grapheme');
    let consumed = 0;

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
    expect(chunks.join('')).toBe(target);
    for (const chunk of chunks.slice(0, -1)) {
      consumed += chunk.length;
      expect(wordBoundaries.has(consumed)).toBe(true);
      expect(graphemeBoundaries.has(consumed)).toBe(true);
    }
  });

  it('fits wide pages down without enlarging them and supports actual size', () => {
    expect(computeMirrorScale(600, 1_200, 'fit')).toBe(0.5);
    expect(computeMirrorScale(1_600, 1_200, 'fit')).toBe(1);
    expect(computeMirrorScale(600, 1_200, 'actual')).toBe(1);
    expect(computeMirrorScale(600, 1_200, 'custom', 175)).toBe(1.75);
    expect(computeMirrorScale(600, 1_200, 'custom', 999)).toBe(3);
    expect(computeMirrorScale(600, 1_200, 'custom', 1)).toBe(0.25);
    expect(computeMirrorScale(0, 1_200, 'fit')).toBe(1);
    expect(computeMirrorScale(600, Number.NaN, 'fit')).toBe(1);
    expect(computeMirrorExtent(0.5, 1_200, 2_000, 1_200, 2_600)).toEqual({
      width: 600,
      height: 1_300,
    });
  });

  it('opens every clipping ancestor through the mirror root for translated text', async () => {
    const snapshot = buildDeepClippingSnapshot(24);
    const { document } = parseHTML('<html><body></body></html>');
    const mirror = createVisualMirror(snapshot, undefined, document);
    if (!mirror) throw new Error('Expected a visual mirror.');
    document.body.append(mirror);
    applyMirrorTextLayout(mirror, 'adaptive');

    await translateVisualMirror(mirror, async () =>
      'A much longer translated sentence that needs room to wrap.',
    );

    const closest = mirror.querySelector<HTMLElement>(
      '[data-simul-node-id="n24"]',
    );
    const outermost = mirror;
    expect(closest?.style.getPropertyValue('overflow-x')).toBe('visible');
    expect(closest?.style.getPropertyValue('height')).toBe('auto');
    expect(outermost.getAttribute('data-simul-node-id')).toBe('n1');
    expect(outermost.style.getPropertyValue('overflow-x')).toBe('visible');
    expect(outermost.style.getPropertyValue('height')).toBe('auto');

    applyMirrorTextLayout(mirror, 'faithful');

    expect(closest?.style.getPropertyValue('overflow-x')).toBe('visible');
    expect(closest?.style.getPropertyValue('height')).toBe('10px');
    expect(outermost.style.getPropertyValue('overflow-x')).toBe('visible');
    expect(outermost.style.getPropertyValue('height')).toBe('10px');

    resetVisualMirrorText(mirror);

    expect(closest?.style.getPropertyValue('overflow-x')).toBe('hidden');
    expect(closest?.style.getPropertyValue('height')).toBe('10px');
    expect(outermost.style.getPropertyValue('overflow-x')).toBe('hidden');
    expect(outermost.style.getPropertyValue('height')).toBe('10px');
  });
});

function buildLiveRootSnapshot(): PageSnapshot {
  return parsePageSnapshot({
    version: 1,
    title: 'Live root',
    url: 'https://example.com/',
    capturedAt: '2026-07-19T00:00:00.000Z',
    items: [
      {
        id: 'live-root-text',
        kind: 'text',
        role: 'paragraph',
        text: 'Old live copy',
      },
    ],
    omissions: {},
    visual: {
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 600,
      styles: [{ display: 'block' }],
      root: {
        kind: 'element',
        tag: 'main',
        styleId: 0,
        nodeId: 'n1',
        children: [
          {
            kind: 'text',
            text: 'Old live copy',
            itemId: 'live-root-text',
            nodeId: 'n2',
          },
        ],
      },
    },
  });
}

function buildDeepClippingSnapshot(depth: number): PageSnapshot {
  let child: VisualElementNode = {
    kind: 'element',
    tag: 'p',
    styleId: 1,
    nodeId: `n${depth + 1}`,
    children: [
      {
        kind: 'text',
        text: 'Short source',
        itemId: 'deep-text',
        nodeId: `n${depth + 2}`,
      },
    ],
  };
  for (let index = depth - 1; index >= 0; index -= 1) {
    child = {
      kind: 'element',
      tag: 'div',
      styleId: 0,
      nodeId: `n${index + 1}`,
      children: [child],
    };
  }
  return parsePageSnapshot({
    version: 1,
    title: 'Clipping layout',
    url: 'https://example.com/',
    capturedAt: '2026-07-19T00:00:00.000Z',
    items: [
      {
        id: 'deep-text',
        kind: 'text',
        role: 'paragraph',
        text: 'Short source',
      },
    ],
    omissions: {},
    visual: {
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 600,
      styles: [
        {
          'overflow-x': 'hidden',
          'overflow-y': 'hidden',
          height: '10px',
          'max-height': '10px',
        },
        { display: 'block' },
      ],
      root: child,
    },
  });
}

function buildParsedVisualSnapshot(): PageSnapshot {
  return parsePageSnapshot({
    version: 1,
    title: 'Visual page',
    url: 'https://example.com/private?token=removed',
    capturedAt: '2026-07-19T00:00:00.000Z',
    items: [
      {
        id: 'raw-text',
        kind: 'text',
        role: 'paragraph',
        text: 'こんにちは',
      },
      {
        id: 'raw-image',
        kind: 'image',
        src: 'https://cdn.example.com/image.png',
        altText: '山',
      },
    ],
    omissions: {},
    visual: {
      viewportWidth: 1_200,
      viewportHeight: 800,
      documentWidth: 1_200,
      documentHeight: 2_000,
      styles: [
        {
          display: 'grid',
          color: 'rgb(12, 34, 56)',
          cursor: 'pointer',
          'background-image': 'url("javascript:alert(1)")',
          behavior: 'url(evil.htc)',
        },
        {
          width: '100px',
          'background-image':
            'url("https://cdn.example.com/background.png")',
        },
      ],
      root: {
        kind: 'element',
        tag: 'div',
        styleId: 0,
        attributes: {
          onclick: 'alert(1)',
        },
        children: [
          {
            kind: 'text',
            text: 'こんにちは',
            itemId: 'raw-text',
          },
          {
            kind: 'element',
            tag: 'img',
            styleId: 1,
            itemId: 'raw-image',
            attributes: {
              src: 'https://cdn.example.com/image.png',
              alt: '山',
              onclick: 'alert(1)',
            },
            children: [],
          },
          {
            kind: 'element',
            tag: 'input',
            styleId: 0,
            controlShell: 'input',
            attributes: {
              value: 'typed parser secret',
              oninput: 'alert(1)',
            },
            children: [
              { kind: 'text', text: 'typed parser secret' },
            ],
          },
          {
            kind: 'element',
            tag: 'script',
            styleId: 0,
            children: [
              { kind: 'text', text: 'script parser secret' },
            ],
          },
          {
            kind: 'element',
            tag: 'a',
            styleId: 0,
            attributes: { href: 'https://evil.example/' },
            children: [
              { kind: 'text', text: 'link parser secret' },
            ],
          },
        ],
      },
    },
  });
}

function buildTranslatedSnapshot(snapshot: PageSnapshot): TranslatedSnapshot {
  const [text, image] = snapshot.items;
  if (text?.kind !== 'text' || image?.kind !== 'image') {
    throw new Error('Expected text and image fixture items.');
  }
  return {
    snapshot,
    items: [
      {
        ...text,
        translation: {
          source: text.text,
          translated: 'Hello',
          state: 'translated',
        },
      },
      {
        ...image,
        altTranslation: {
          source: image.altText ?? '',
          translated: 'Mountain',
          state: 'translated',
        },
      },
    ],
    state: 'complete',
    completed: 2,
    total: 2,
    failed: 0,
  };
}

function isTag(tag: string) {
  return (node: unknown): node is VisualElementNode =>
    typeof node === 'object' &&
    node !== null &&
    'kind' in node &&
    node.kind === 'element' &&
    'tag' in node &&
    node.tag === tag;
}

function collectElements(
  root: VisualElementNode | undefined,
): VisualElementNode[] {
  if (!root) return [];
  const elements = [root];
  for (const child of root.children) {
    if (child.kind === 'element') elements.push(...collectElements(child));
  }
  return elements;
}

function segmentBoundaries(
  value: string,
  granularity: Intl.SegmenterOptions['granularity'],
): Set<number> {
  const boundaries = new Set([0, value.length]);
  const segmenter = new Intl.Segmenter(undefined, { granularity });
  for (const segment of segmenter.segment(value)) {
    boundaries.add(segment.index);
    boundaries.add(segment.index + segment.segment.length);
  }
  return boundaries;
}

function installCapturePage(body: string): { document: Document } {
  const { document, window } = parseHTML(
    `<html lang="ja"><head><title>Test</title></head><body>${body}</body></html>`,
  );
  Object.defineProperty(document, 'baseURI', {
    value: 'https://example.com/page',
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: new URL('https://example.com/page?private=yes'),
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: 1_200,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(window.Element.prototype, 'getClientRects', {
    configurable: true,
    value(this: Element) {
      return this.hasAttribute('hidden') ? [] : [{}];
    },
  });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value(element: Element) {
      const declarations = new Map<string, string>();
      for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
        const separator = declaration.indexOf(':');
        if (separator < 0) continue;
        declarations.set(
          declaration.slice(0, separator).trim().toLowerCase(),
          declaration.slice(separator + 1).trim(),
        );
      }
      return {
        display: declarations.get('display') ?? 'block',
        visibility: declarations.get('visibility') ?? 'visible',
        opacity: declarations.get('opacity') ?? '1',
        getPropertyValue(property: string) {
          return declarations.get(property) ?? '';
        },
      };
    },
  });

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLImageElement', window.HTMLImageElement);
  vi.stubGlobal('ShadowRoot', window.ShadowRoot);
  if (window.HTMLSlotElement) {
    vi.stubGlobal('HTMLSlotElement', window.HTMLSlotElement);
  }
  return { document: document as unknown as Document };
}
