import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  StickySourceSecretClassifier,
  classifySourceEvidence,
  replicaReadScopeAdmits,
  sourceDocumentSecretClassifier,
} from '../lib/replica/source-secret-classifier';
import { replicaReadScopeForProfile } from '../lib/replica/read-scope-policy';
import { applySourcePrivacyFiltersOff } from '../lib/replica/source-privacy-mode';
import {
  beginSourceSelectLabelWalk,
  createSourceSecretAncestorMemo,
  hasSourceControlOrEditableElementAncestor,
  hasSourceCredentialSecretAncestor,
  isSourceSelectEntryVisuallyHidden,
  isSourceSelectLabelElementPublic,
  isSourceSelectWrapper,
  readSourceFlatTreeElementPath,
  readSourceSelectEntries,
  readSourceSelectEntryOwner,
  readSourceSelectLabel,
  readSourceStructuralAttributes,
} from '../lib/replica/source-privacy-policy';
import { installSourceShadowRootReader } from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

describe('source secret classifier', () => {
  afterEach(() => applySourcePrivacyFiltersOff(false));

  it.each([
    { tagName: 'input', type: 'password' },
    { tagName: 'input', type: 'hidden' },
    { tagName: 'input', autocomplete: 'section-login one-time-code' },
    { tagName: 'input', autocomplete: 'shipping cc-number' },
    { tagName: 'div', computedTextSecurity: 'disc' },
  ])('permanently excludes secret facts %#', (facts) => {
    const category = classifySourceEvidence(facts);
    expect(category).toBe('secret');
    expect(replicaReadScopeAdmits(
      replicaReadScopeForProfile('full-visible'),
      category,
    )).toBe(false);
  });

  it('draws a file input as an ordinary control (D75)', () => {
    // The page shows its Choose File button; the value (a file name) is never
    // an ordinary form value, so no read scope carries it.
    expect(classifySourceEvidence({ tagName: 'input', type: 'file' }))
      .toBe('public-semantic');
    expect(classifySourceEvidence({
      tagName: 'input', type: 'file', valueBearing: true,
    })).toBe('withheld');
  });

  it('reads date, time and colour values as ordinary form input (D75)', () => {
    for (const type of [
      'date', 'time', 'datetime-local', 'month', 'week', 'color',
    ]) {
      expect(classifySourceEvidence({ tagName: 'input', type }), type)
        .toBe('ordinary-form');
    }
    expect(classifySourceEvidence({ tagName: 'input', type: 'checkbox' }))
      .toBe('public-semantic');
  });

  it('treats nothing as a secret while Show everything is on (D75)', () => {
    const classifier = new StickySourceSecretClassifier();
    const learned = {};
    expect(classifier.classify(learned, {
      tagName: 'input', type: 'password',
    })).toBe('secret');
    applySourcePrivacyFiltersOff(true);
    for (const facts of [
      { tagName: 'input', type: 'hidden' },
      { tagName: 'div', computedTextSecurity: 'disc' },
      { tagName: 'p', secretAncestor: true },
    ]) {
      expect(classifySourceEvidence(facts)).not.toBe('secret');
    }
    // Card and one-time-code fields read as ordinary values; a password never
    // does, since only its dots show.
    expect(classifySourceEvidence({
      tagName: 'input', type: 'text', autocomplete: 'cc-number',
    })).toBe('ordinary-form');
    expect(classifySourceEvidence({
      tagName: 'input', type: 'password', valueBearing: true,
    })).toBe('withheld');
    // The sticky ledger is set aside, not erased.
    expect(classifier.isSecret(learned)).toBe(false);
    expect(classifier.classify(learned, { tagName: 'p' }))
      .toBe('public-semantic');
    applySourcePrivacyFiltersOff(false);
    expect(classifier.isSecret(learned)).toBe(true);
  });

  it('keeps form, personal and editable gates independent', () => {
    const standard = replicaReadScopeForProfile('standard');
    const full = replicaReadScopeForProfile('full-visible');
    expect(classifySourceEvidence({ tagName: 'input', type: 'text' }))
      .toBe('ordinary-form');
    expect(classifySourceEvidence({ tagName: 'input', type: 'email' }))
      .toBe('personal');
    expect(classifySourceEvidence({
      tagName: 'div',
      contentEditable: 'true',
    })).toBe('editable');
    expect(replicaReadScopeAdmits(standard, 'ordinary-form')).toBe(false);
    expect(replicaReadScopeAdmits(full, 'ordinary-form')).toBe(true);
    expect(replicaReadScopeAdmits(full, 'personal')).toBe(true);
    expect(replicaReadScopeAdmits(full, 'editable')).toBe(true);
  });

  it('admits native range and number values as ordinary form input', () => {
    const standard = replicaReadScopeForProfile('standard');
    const full = replicaReadScopeForProfile('full-visible');
    for (const type of ['range', 'number']) {
      expect(classifySourceEvidence({ tagName: 'input', type }))
        .toBe('ordinary-form');
    }
    // A number field carrying a personal autocomplete keeps the stronger gate.
    expect(classifySourceEvidence({
      tagName: 'input', type: 'number', autocomplete: 'bday-year',
    })).toBe('personal');
    // A payment field stays secret regardless of its input type.
    expect(classifySourceEvidence({
      tagName: 'input', type: 'number', autocomplete: 'cc-number',
    })).toBe('secret');
    expect(replicaReadScopeAdmits(standard, 'ordinary-form')).toBe(false);
    expect(replicaReadScopeAdmits(full, 'ordinary-form')).toBe(true);
  });

  it('treats autocomplete switches and grouping tokens as harmless metadata', () => {
    for (const autocomplete of [
      'on',
      'off',
      'section-checkout off',
      'section-search shipping work',
    ]) {
      expect(classifySourceEvidence({
        tagName: 'input',
        type: 'text',
        autocomplete,
        valueBearing: true,
      })).toBe('ordinary-form');
    }
    expect(classifySourceEvidence({
      tagName: 'input',
      type: 'text',
      autocomplete: 'section-login username',
      valueBearing: true,
    })).toBe('personal');
  });

  it('keeps a secret node secret after hostile attribute mutation', () => {
    const identity = {};
    const classifier = new StickySourceSecretClassifier();
    expect(classifier.classify(identity, {
      tagName: 'input', type: 'password',
    })).toBe('secret');
    expect(classifier.classify(identity, {
      tagName: 'input', type: 'text',
    })).toBe('secret');
  });

  it('advances its content-free revision only for a new sticky secret identity', () => {
    const first = {};
    const second = {};
    const classifier = new StickySourceSecretClassifier();

    expect(classifier.revision).toBe(0);
    expect(classifier.classify(first, { tagName: 'p' })).toBe('public-semantic');
    expect(classifier.revision).toBe(0);
    expect(classifier.classify(first, {
      tagName: 'input', type: 'password',
    })).toBe('secret');
    expect(classifier.revision).toBe(1);
    expect(classifier.classify(first, { tagName: 'p' })).toBe('secret');
    expect(classifier.revision).toBe(1);
    expect(classifier.classify(second, {
      tagName: 'div', computedTextSecurity: 'disc',
    })).toBe('secret');
    expect(classifier.revision).toBe(2);
  });

  it('shares sticky credential history for one source document', () => {
    const { document } = parseHTML(
      '<html><body><section><input id="credential" type="password"></section></body></html>',
    );
    const credential = document.querySelector('#credential')!;
    const classifier = sourceDocumentSecretClassifier(document);

    expect(hasSourceCredentialSecretAncestor(credential, classifier)).toBe(true);
    credential.setAttribute('type', 'text');
    credential.removeAttribute('autocomplete');
    expect(hasSourceCredentialSecretAncestor(credential, classifier)).toBe(true);
  });

  it('classifies from targeted structural getters without enumerating values', () => {
    const { document } = parseHTML(
      '<html><body><input id="credential" type="password" value="must-not-read" data-draft="must-not-read"></body></html>',
    );
    const credential = document.querySelector('#credential')!;
    Object.defineProperty(credential, 'attributes', {
      configurable: true,
      get: () => {
        throw new Error('attribute enumeration is forbidden before classification');
      },
    });

    expect(readSourceStructuralAttributes(credential)).toEqual({
      type: 'password',
    });
    expect(hasSourceCredentialSecretAncestor(credential)).toBe(true);
  });

  it('allows an absent style API but fails closed for a present nonfunction API', () => {
    const absent = parseHTML(
      '<html><body><p id="ordinary">Ordinary</p></body></html>',
    );
    const ordinary = absent.document.querySelector('#ordinary')!;
    expect('getComputedStyle' in absent.window).toBe(false);
    expect(hasSourceCredentialSecretAncestor(ordinary)).toBe(false);

    const present = parseHTML(
      '<html><body><p id="unreadable">Unreadable</p></body></html>',
    );
    const unreadable = present.document.querySelector('#unreadable')!;
    Object.defineProperty(present.window, 'getComputedStyle', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(hasSourceCredentialSecretAncestor(unreadable)).toBe(true);
    } finally {
      Reflect.deleteProperty(present.window, 'getComputedStyle');
    }
  });

  it('gives the same answers and ledger with a per-walk ancestor memo', () => {
    // D63: the memo only skips re-classifying ancestors within one walk.
    const build = () => {
      const { document, window } = parseHTML(
        '<html><body><main><p>text <b>bold</b></p>' +
        '<form><input type="password"><label>label <i>x</i></label></form>' +
        '<div id="masked"><span>masked <em>deep</em></span></div>' +
        '<section autocomplete="one-time-code"><div><span>code</span></div></section>' +
        '<div id="host"><b>slotted</b></div><p>after</p></main></body></html>',
      );
      Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: (element: Element) => ({
          getPropertyValue: (property: string) =>
            property === '-webkit-text-security' && element.id === 'masked'
              ? 'disc'
              : '',
        }),
      });
      const host = document.querySelector('#host')!;
      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = '<section autocomplete="one-time-code"><slot></slot></section><p>open</p>';
      Object.defineProperty(host.firstElementChild!, 'assignedSlot', {
        configurable: true,
        value: shadow.querySelector('slot'),
      });
      const nodes: Node[] = [];
      const stack: Node[] = [document.documentElement];
      while (stack.length > 0) {
        const node = stack.pop()!;
        nodes.push(node);
        const children = [...node.childNodes];
        const nodeShadow = (node as Element).shadowRoot;
        if (nodeShadow) children.push(...nodeShadow.childNodes);
        stack.push(...children.reverse());
      }
      return { window: window as unknown as Window, nodes };
    };
    const plain = build();
    const memoized = build();
    const plainClassifier = new StickySourceSecretClassifier();
    const memoClassifier = new StickySourceSecretClassifier();
    const memo = createSourceSecretAncestorMemo();
    // Document order, then reverse order, so lookups both hit and miss.
    for (const order of [(list: Node[]) => list, (list: Node[]) => [...list].reverse()]) {
      const plainAnswers = order(plain.nodes).map((node) =>
        hasSourceCredentialSecretAncestor(node, plainClassifier, plain.window));
      const memoAnswers = order(memoized.nodes).map((node) =>
        hasSourceCredentialSecretAncestor(node, memoClassifier, memoized.window, memo));
      expect(memoAnswers).toEqual(plainAnswers);
      expect(memoAnswers).toContain(true);
      expect(memoAnswers).toContain(false);
    }
    expect(memoized.nodes.map((node) => memoClassifier.isSecret(node)))
      .toEqual(plain.nodes.map((node) => plainClassifier.isSecret(node)));
    expect(memoClassifier.revision).toBe(plainClassifier.revision);
  });

  it('drops the ancestor memo when the classifier learns a new secret', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="outer"><p id="inner">text</p></div></body></html>',
    );
    const classifier = new StickySourceSecretClassifier();
    const memo = createSourceSecretAncestorMemo();
    const sourceWindow = window as unknown as Window;
    const inner = document.querySelector('#inner')!;
    expect(hasSourceCredentialSecretAncestor(inner, classifier, sourceWindow, memo))
      .toBe(false);
    classifier.classify(document.querySelector('#outer')!, {
      tagName: 'div',
      computedTextSecurity: 'disc',
    });
    expect(hasSourceCredentialSecretAncestor(
      inner.firstChild!,
      classifier,
      sourceWindow,
      memo,
    )).toBe(true);
  });

  it('uses assigned-slot ancestry before the light-DOM parent', () => {
    const { document } = parseHTML(
      '<html><body><div id="host"><img id="secret"><img id="controlled"></div></body></html>',
    );
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <section autocomplete="one-time-code"><slot id="secret-slot"></slot></section>
      <section contenteditable="true"><slot id="control-slot"></slot></section>
    `;
    const secret = document.querySelector('#secret')!;
    const controlled = document.querySelector('#controlled')!;
    const secretSlot = shadow.querySelector('#secret-slot')!;
    const controlSlot = shadow.querySelector('#control-slot')!;
    Object.defineProperty(secret, 'assignedSlot', {
      configurable: true,
      value: secretSlot,
    });
    Object.defineProperty(controlled, 'assignedSlot', {
      configurable: true,
      value: controlSlot,
    });

    expect(readSourceFlatTreeElementPath(secret)?.slice(0, 4)).toEqual([
      secret,
      secretSlot,
      secretSlot.parentElement,
      host,
    ]);
    expect(hasSourceCredentialSecretAncestor(secret)).toBe(true);
    expect(hasSourceControlOrEditableElementAncestor(controlled)).toBe(true);
  });

  it('classifies directly slotted Text from its flat-tree ancestry and keeps it sticky', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="host"></div><main id="public"></main></body></html>',
    );
    const host = document.querySelector('#host')!;
    const text = document.createTextNode('direct slot secret');
    host.append(text);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<section autocomplete="one-time-code"><slot></slot></section>';
    const slot = shadow.querySelector('slot')!;
    Object.defineProperty(text, 'assignedSlot', {
      configurable: true,
      value: slot,
    });
    let contentReads = 0;
    Object.defineProperty(text, 'nodeValue', {
      configurable: true,
      get: () => {
        contentReads += 1;
        return 'direct slot secret';
      },
    });
    const classifier = new StickySourceSecretClassifier();

    expect(readSourceFlatTreeElementPath(text)?.slice(0, 3)).toEqual([
      slot,
      slot.parentElement,
      host,
    ]);
    expect(hasSourceCredentialSecretAncestor(
      text,
      classifier,
      window as unknown as Window,
    )).toBe(true);
    expect(contentReads).toBe(0);

    Object.defineProperty(text, 'assignedSlot', {
      configurable: true,
      value: null,
    });
    document.querySelector('#public')!.append(text);
    expect(hasSourceCredentialSecretAncestor(
      text,
      classifier,
      window as unknown as Window,
    )).toBe(true);
    expect(contentReads).toBe(0);
  });

  it('follows a slot in a closed root for an element and for directly slotted Text (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-mask id="host"><img id="secret">' +
        '<b id="named" slot="clear">clear</b></x-mask></body></html>',
    );
    const host = document.querySelector('#host')!;
    const text = document.createTextNode('direct slot secret');
    host.append(text);
    const reader = closedRootReader();
    const shadow = reader.attach(
      host,
      '<section autocomplete="one-time-code"><slot id="secret-slot"></slot></section>' +
        '<p><slot id="clear-slot" name="clear"></slot></p>',
    );
    const secret = document.querySelector('#secret')!;
    const named = document.querySelector('#named')!;
    const secretSlot = shadow.querySelector('#secret-slot')!;
    // Chrome reads null for a node slotted into a closed root.
    for (const node of [secret, named, text]) {
      Object.defineProperty(node, 'assignedSlot', { configurable: true, value: null });
    }
    let contentReads = 0;
    Object.defineProperty(text, 'nodeValue', {
      configurable: true,
      get: () => {
        contentReads += 1;
        return 'direct slot secret';
      },
    });

    // Without the page reader the slot is out of reach, as before D125.
    expect(readSourceFlatTreeElementPath(secret)).toEqual([
      secret, host, document.body, document.documentElement,
    ]);

    installSourceShadowRootReader(document, reader.read);
    expect(readSourceFlatTreeElementPath(secret)?.slice(0, 4)).toEqual([
      secret, secretSlot, secretSlot.parentElement, host,
    ]);
    expect(readSourceFlatTreeElementPath(text)?.slice(0, 3)).toEqual([
      secretSlot, secretSlot.parentElement, host,
    ]);
    const classifier = new StickySourceSecretClassifier();
    const sourceWindow = window as unknown as Window;
    expect(hasSourceCredentialSecretAncestor(secret, classifier, sourceWindow)).toBe(true);
    expect(hasSourceCredentialSecretAncestor(text, classifier, sourceWindow)).toBe(true);
    // A node in another slot of the same root is not under the credential box.
    expect(hasSourceCredentialSecretAncestor(named, classifier, sourceWindow)).toBe(false);
    expect(contentReads).toBe(0);
    installSourceShadowRootReader(document, undefined);
  });

  it('fails closed on a closed root with too many slots to search (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-many id="host"><b id="child">slotted</b></x-many></body></html>',
    );
    const host = document.querySelector('#host')!;
    const child = document.querySelector('#child')!;
    const reader = closedRootReader();
    reader.attach(host, '<slot name="x"></slot>'.repeat(4_097));
    Object.defineProperty(child, 'assignedSlot', { configurable: true, value: null });
    installSourceShadowRootReader(document, reader.read);

    expect(readSourceFlatTreeElementPath(child)).toBeUndefined();
    expect(hasSourceCredentialSecretAncestor(
      child,
      new StickySourceSecretClassifier(),
      window as unknown as Window,
    )).toBe(true);
    installSourceShadowRootReader(document, undefined);
  });

  it('withholds customizable-option Text slotted beneath a secret wrapper', () => {
    const { document } = parseHTML('<html><body><select></select></body></html>');
    const select = document.querySelector('select')!;
    const option = document.createElement('option');
    const labelHost = document.createElement('x-option-label');
    const text = document.createTextNode('slotted option secret');
    labelHost.append(text);
    option.append(labelHost);
    select.append(option);
    const shadow = labelHost.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<span autocomplete="webauthn"><slot></slot></span>';
    Object.defineProperty(text, 'assignedSlot', {
      configurable: true,
      value: shadow.querySelector('slot'),
    });
    let contentReads = 0;
    Object.defineProperty(text, 'nodeValue', {
      configurable: true,
      get: () => {
        contentReads += 1;
        return 'slotted option secret';
      },
    });

    expect(isSourceSelectLabelElementPublic(option)).toBe(true);
    expect(readSourceSelectLabel(option)).toBeUndefined();
    expect(contentReads).toBe(0);
  });

  it('proves a complete customizable-option label safe before reading it', () => {
    const { document, window } = parseHTML(`
      <html><body><select>
        <option id="otp"><span autocomplete="one-time-code">otp secret</span></option>
        <option id="masked"><span class="masked">masked secret</span></option>
      </select></body></html>
    `);
    const otp = document.querySelector('#otp')!;
    const masked = document.querySelector('#masked')!;
    let aggregateReads = 0;
    for (const option of [otp, masked]) {
      Object.defineProperty(option, 'label', {
        configurable: true,
        get: () => {
          aggregateReads += 1;
          throw new Error('unsafe aggregate option label read');
        },
      });
    }
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element.classList.contains('masked')
            ? 'disc'
            : 'none',
      }),
    });

    expect(isSourceSelectLabelElementPublic(otp)).toBe(false);
    expect(isSourceSelectLabelElementPublic(masked)).toBe(false);
    expect(readSourceSelectLabel(otp)).toBeUndefined();
    expect(readSourceSelectLabel(masked)).toBeUndefined();
    expect(aggregateReads).toBe(0);
  });

  it('reads the options of a transparent select that is the click target over its label', () => {
    // Wikipedia's language picker: an opacity:0 select laid over a styled
    // "EN" label. Clicking it opens the options in the page, so it is not
    // hidden; a transparent select that takes no pointer input still is.
    const { document, window } = parseHTML(`<html><body>
      <span>EN<select id="clickable"><option id="en">English</option></select></span>
      <select id="inert"><option id="fr">Français</option></select></body></html>`);
    const clickable = document.querySelector('#clickable')!;
    const inert = document.querySelector('#inert')!;
    for (const select of [clickable, inert]) {
      Object.defineProperties(select, {
        getClientRects: { configurable: true, value: () => [{}] },
        getBoundingClientRect: {
          configurable: true,
          value: () => ({
            left: 10, top: 10, right: 120, bottom: 34, width: 110, height: 24,
          }),
        },
      });
    }
    const globalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
    Object.defineProperty(globalThis, 'Node', {
      configurable: true,
      writable: true,
      value: (window as unknown as { Node: typeof Node }).Node,
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: 'visible',
        position: 'absolute',
        transform: 'none',
        opacity: element.localName === 'select' ? '0' : '1',
        pointerEvents: element === inert ? 'none' : 'auto',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' ? 'none' : '',
      }),
    });
    try {
      expect(isSourceSelectEntryVisuallyHidden(clickable)).toBe(false);
      expect(readSourceSelectLabel(document.querySelector('#en')!)?.text)
        .toBe('English');
      expect(isSourceSelectEntryVisuallyHidden(inert)).toBe(true);
      expect(readSourceSelectLabel(document.querySelector('#fr')!)).toBeUndefined();
    } finally {
      if (globalNode) Object.defineProperty(globalThis, 'Node', globalNode);
      else delete (globalThis as { Node?: unknown }).Node;
    }
  });

  it('reads each style once for the options of one walk, with the same answers (D132)', () => {
    // Every option walked up to the document three times, reading each
    // ancestor's style: with every label of a large page read, that was most
    // of a second at each change.
    const options = Array.from({ length: 50 }, (_, index) =>
      `<option id="o${index}">Choice ${index}</option>`).join('');
    const { document, window } = parseHTML(`<html><body><form><div>
      <select id="shown">${options}</select>
      <div id="wrap"><select id="hidden"><option id="gone">Gone</option></select></div>
      </div></form></body></html>`);
    for (const select of document.querySelectorAll('select')) {
      Object.defineProperties(select, {
        getClientRects: { configurable: true, value: () => [{}] },
        getBoundingClientRect: {
          configurable: true,
          value: () => ({
            left: 10, top: 10, right: 120, bottom: 34, width: 110, height: 24,
          }),
        },
      });
    }
    const wrap = document.querySelector('#wrap')!;
    const reads = new Map<Element, number>();
    const globalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
    Object.defineProperty(globalThis, 'Node', {
      configurable: true,
      writable: true,
      value: (window as unknown as { Node: typeof Node }).Node,
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => {
        reads.set(element, (reads.get(element) ?? 0) + 1);
        return {
          display: element === wrap ? 'none' : 'block',
          visibility: 'visible',
          position: 'static',
          transform: 'none',
          opacity: '1',
          pointerEvents: 'auto',
          getPropertyValue: (name: string) =>
            name === '-webkit-text-security' ? 'none' : '',
        };
      },
    });
    const readAll = (): Array<string | undefined> =>
      [...document.querySelectorAll('option')].map((option) =>
        readSourceSelectLabel(option)?.text);
    try {
      const without = readAll();
      const body = document.body;
      const readsOfBodyWithout = reads.get(body)!;
      reads.clear();
      const walk = beginSourceSelectLabelWalk();
      let within: Array<string | undefined>;
      try {
        within = readAll();
      } finally {
        walk.end();
      }
      expect(within).toEqual(without);
      expect(within.slice(0, 2)).toEqual(['Choice 0', 'Choice 1']);
      expect(within.at(-1)).toBeUndefined();
      // Once for whether it is hidden, once for whether it masks text.
      expect(reads.get(body)).toBe(2);
      expect(readsOfBodyWithout).toBeGreaterThan(100);
      for (const option of document.querySelectorAll('#shown option')) {
        expect(reads.get(option)).toBe(2);
      }
      // After the walk nothing is remembered: a style may have changed.
      reads.clear();
      readSourceSelectLabel(document.querySelector('#o0')!);
      expect(reads.get(body)).toBeGreaterThan(2);
    } finally {
      if (globalNode) Object.defineProperty(globalThis, 'Node', globalNode);
      else delete (globalThis as { Node?: unknown }).Node;
    }
  });

  it('reads the options of a dropdown through plain wrappers, as Chrome lists them (D135)', () => {
    const { document, window } = parseHTML(`<html><body><form>
      <select id="plain"><option id="p1">One</option><optgroup id="pg" label="G"><option id="p2">Two</option></optgroup></select>
      <select id="ruled"><option>One</option><hr><option>Two</option></select>
      <select id="wrapped">
        <div id="w1"><option id="a">Alpha</option><span id="w2"><option id="b">Beta</option></span></div>
        <optgroup id="g" label="Group"><div id="w3"><option id="c">Gamma</option><optgroup id="nested" label="Nested"><option id="h">Eta</option></optgroup></div><option id="d">Delta</option></optgroup>
        <div id="w4"><optgroup id="g2" label="Second"><option id="e">Epsilon</option></optgroup></div>
        <hr>
        <option id="f">Zeta</option>
      </select>
    </form></body></html>`);
    const byId = (id: string): Element => document.querySelector(`#${id}`)!;
    const ids = (entries: readonly Element[] | undefined): string[] | undefined =>
      entries?.map((entry) => entry.id);
    showEverythingPainted(document, window);

    // No wrapper: the owner's own children are its entries, as always. A
    // rule between two options holds none and is no wrapper.
    expect(readSourceSelectEntries(byId('plain'))).toBeUndefined();
    expect(readSourceSelectEntries(byId('ruled'))).toBeUndefined();
    expect(readSourceSelectEntries(byId('pg'))).toBeUndefined();
    expect(readSourceSelectEntries(byId('g2'))).toBeUndefined();
    // Options and groups in the page's order; a group's own options are the
    // group's.
    expect(ids(readSourceSelectEntries(byId('wrapped')))).toEqual(['a', 'b', 'g', 'g2', 'f']);
    // A group inside a group counts for nothing: its option is the outer one's.
    expect(ids(readSourceSelectEntries(byId('g')))).toEqual(['c', 'h', 'd']);
    expect(readSourceSelectEntryOwner(byId('b'))).toBe(byId('wrapped'));
    expect(readSourceSelectEntryOwner(byId('c'))).toBe(byId('g'));
    expect(readSourceSelectEntryOwner(byId('h'))).toBe(byId('g'));
    expect(readSourceSelectEntryOwner(byId('nested'))).toBeUndefined();
    expect(readSourceSelectLabel(byId('h'))?.text).toBe('Eta');
    expect(readSourceSelectEntryOwner(byId('g2'))).toBe(byId('wrapped'));
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(isSourceSelectLabelElementPublic(byId(id)), id).toBe(true);
    }
    expect(readSourceSelectLabel(byId('b'))?.text).toBe('Beta');
    expect(readSourceSelectLabel(byId('c'))?.text).toBe('Gamma');
    expect(readSourceSelectLabel(byId('g2'))?.text).toBe('Second');
  });

  it('passes no wrapper that makes what it holds private, or that acts (D135)', () => {
    // Built by script: a parser closes a dropdown at some of these tags.
    const { document, window } = parseHTML(
      '<html><body><form><select id="s"></select></form></body></html>',
    );
    const select = document.querySelector('#s')!;
    const option = (id: string): Element => {
      const element = document.createElement('option');
      element.id = id;
      element.textContent = `Label of ${id}`;
      return element;
    };
    const wrap = (
      tagName: string,
      attributes: Readonly<Record<string, string>>,
      optionId: string,
    ): Element => {
      const wrapper = document.createElement(tagName);
      for (const [name, value] of Object.entries(attributes)) {
        wrapper.setAttribute(name, value);
      }
      wrapper.append(option(optionId));
      select.append(wrapper);
      return wrapper;
    };
    const plain = wrap('div', {}, 'shown');
    const refused = [
      wrap('div', { contenteditable: 'true' }, 'typed'),
      wrap('div', { role: 'textbox' }, 'boxed'),
      wrap('button', {}, 'pressed'),
      wrap('div', { role: 'button' }, 'acting'),
      wrap('datalist', {}, 'listed'),
    ];
    // Sixteen wrappers are passed; the seventeenth is one too many.
    const nest = (depth: number, optionId: string): void => {
      let inner: Element = option(optionId);
      for (let index = 0; index < depth; index += 1) {
        const wrapper = document.createElement('div');
        wrapper.append(inner);
        inner = wrapper;
      }
      select.append(inner);
    };
    nest(16, 'sixteen');
    nest(17, 'seventeen');
    const byId = (id: string): Element => document.querySelector(`#${id}`)!;
    for (const id of ['shown', 'typed', 'boxed', 'pressed', 'acting', 'listed', 'sixteen', 'seventeen']) {
      expect(byId(id).closest('select'), id).toBe(select);
    }
    showEverythingPainted(document, window);

    expect(isSourceSelectWrapper(plain)).toBe(true);
    for (const wrapper of refused) {
      expect(isSourceSelectWrapper(wrapper), wrapper.outerHTML.slice(0, 40)).toBe(false);
    }
    expect(readSourceSelectEntries(select)?.map((entry) => entry.id))
      .toEqual(['shown', 'sixteen']);
    for (const id of ['shown', 'sixteen']) {
      expect(readSourceSelectEntryOwner(byId(id)), id).toBe(select);
      expect(readSourceSelectLabel(byId(id))?.text, id).toBe(`Label of ${id}`);
    }
    for (const id of ['typed', 'boxed', 'pressed', 'acting', 'listed', 'seventeen']) {
      expect(readSourceSelectEntryOwner(byId(id)), id).toBeUndefined();
      expect(isSourceSelectLabelElementPublic(byId(id)), id).toBe(false);
      expect(readSourceSelectLabel(byId(id)), id).toBeUndefined();
    }
  });
});

/** Every element is drawn and shown, for tests about structure alone. */
function showEverythingPainted(document: Document, window: object): void {
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperties(select, {
      getClientRects: { configurable: true, value: () => [{}] },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          left: 10, top: 10, right: 120, bottom: 34, width: 110, height: 24,
        }),
      },
    });
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'Node', {
    configurable: true,
    writable: true,
    value: (window as { Node: typeof Node }).Node,
  });
  onTestFinished(() => {
    if (previous) Object.defineProperty(globalThis, 'Node', previous);
    else delete (globalThis as { Node?: unknown }).Node;
  });
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: () => ({
      display: 'block',
      visibility: 'visible',
      position: 'static',
      transform: 'none',
      opacity: '1',
      pointerEvents: 'auto',
      getPropertyValue: (name: string) =>
        name === '-webkit-text-security' ? 'none' : '',
    }),
  });
}
