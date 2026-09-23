import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  StickySourceSecretClassifier,
  classifySourceEvidence,
  replicaReadScopeAdmits,
  sourceDocumentSecretClassifier,
} from '../lib/replica/source-secret-classifier';
import { replicaReadScopeForProfile } from '../lib/replica/read-scope-policy';
import {
  createSourceSecretAncestorMemo,
  hasSourceControlOrEditableElementAncestor,
  hasSourceCredentialSecretAncestor,
  isSourceSelectEntryVisuallyHidden,
  isSourceSelectLabelElementPublic,
  readSourceFlatTreeElementPath,
  readSourceSelectLabel,
  readSourceStructuralAttributes,
} from '../lib/replica/source-privacy-policy';

describe('source secret classifier', () => {
  it.each([
    { tagName: 'input', type: 'password' },
    { tagName: 'input', type: 'hidden' },
    { tagName: 'input', type: 'file' },
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
});
