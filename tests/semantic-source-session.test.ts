import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  FULL_VISIBLE_REPLICA_READ_SCOPE,
  PAGE_ONLY_REPLICA_READ_SCOPE,
  STANDARD_REPLICA_READ_SCOPE,
} from '../lib/replica/read-scope-policy';
import {
  MAX_SEMANTIC_SOURCE_RECORDS,
  createSemanticSourceAck,
  createSemanticSourcePortName,
  createSemanticSourceStart,
  type SemanticSourceBatch,
} from '../lib/replica/semantic-source-protocol';
import {
  SemanticSourceSession,
  eagerlyClassifySourceDocumentSecrets,
  rememberSourceEventSecret,
  rememberSourceMutationSecrets,
  type SemanticSourcePort,
} from '../lib/replica/semantic-source-session';
import { StickySourceSecretClassifier } from '../lib/replica/source-secret-classifier';
import { hasSourceCredentialSecretAncestor } from '../lib/replica/source-privacy-policy';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const identity: ReplicaSourceDocumentIdentity = {
  sessionId: 'semantic-source-session',
  pageEpoch: 2,
  generation: 2,
  documentId: 'semantic-source-document',
  frameId: 0,
};

describe('semantic source session', () => {
  it('classifies before value access and keeps credential classification sticky', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="safe" type="text"><input id="secret" type="password"></body></html>',
    );
    const safe = document.querySelector<HTMLInputElement>('#safe')!;
    const secret = document.querySelector<HTMLInputElement>('#secret')!;
    safe.value = 'visible draft';
    let secretReads = 0;
    Object.defineProperty(secret, 'value', {
      configurable: true,
      get: () => {
        secretReads += 1;
        throw new Error('secret value must not be read');
      },
      set: () => undefined,
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);

    port.emit(createSemanticSourceStart(
      'isolated-html',
      identity,
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    const first = port.messages[0]!;
    expect(first.records.map((record) => record.text)).toContain('visible draft');
    expect(first.records.some((record) => record.nodeId === nodeId(secret)))
      .toBe(false);
    expect(secretReads).toBe(0);

    secret.setAttribute('type', 'text');
    port.emit(createSemanticSourceAck(
      identity,
      first.policyFingerprint,
      first.sequence,
    ));
    session.refresh();
    const second = port.messages.at(-1)!;
    expect(second.records.some((record) => record.nodeId === nodeId(secret)))
      .toBe(false);
    expect(secretReads).toBe(0);
    session.dispose();
  });

  it('remembers same-task computed masking from synchronous edit events', () => {
    const { document } = parseHTML(
      '<html><body><div id="draft" contenteditable="true">public</div></body></html>',
    );
    const draft = document.querySelector('#draft')!;
    const classifier = new StickySourceSecretClassifier();
    const sourceWindow = {
      getComputedStyle: (element: Element) => ({
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element.classList.contains('masked')
            ? 'disc'
            : 'none',
      }),
    } as unknown as Window;
    draft.classList.add('masked');
    rememberSourceEventSecret({
      target: draft,
      composedPath: () => [draft],
    } as unknown as Event, sourceWindow, classifier);
    draft.textContent = 'same-task secret';
    draft.classList.remove('masked');

    expect(hasSourceCredentialSecretAncestor(
      draft,
      classifier,
      sourceWindow,
    )).toBe(true);
  });

  it('wires synchronous edit classification before the deferred rescan', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="draft" contenteditable="true">public</div></body></html>',
    );
    const draft = document.querySelector('#draft')!;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      (element) => ({
        display: 'block',
        visibility: 'visible',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element.classList.contains('masked')
            ? 'disc'
            : 'none',
      }) as unknown as CSSStyleDeclaration,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const first = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      first.policyFingerprint,
      first.sequence,
    ));

    draft.classList.add('masked');
    draft.textContent = 'same-task secret';
    draft.dispatchEvent(new window.Event('input', { bubbles: true }));
    draft.classList.remove('masked');

    expect(port.messages[1]!.records.some(
      ({ text }) => text === 'same-task secret',
    )).toBe(false);
    port.emit(createSemanticSourceAck(
      identity,
      port.messages[1]!.policyFingerprint,
      port.messages[1]!.sequence,
    ));
    session.refresh();
    expect(port.messages.at(-1)!.records.some(
      ({ text }) => text === 'same-task secret',
    )).toBe(false);
    session.dispose();
  });

  it('conservatively remembers existing-node class and content transitions', () => {
    const { document } = parseHTML(
      '<html><body><div id="draft" contenteditable="true">secret</div></body></html>',
    );
    const draft = document.querySelector('#draft')!;
    const classifier = new StickySourceSecretClassifier();
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;
    rememberSourceMutationSecrets([
      {
        type: 'attributes',
        target: draft,
        attributeName: 'class',
        oldValue: 'masked',
      } as unknown as MutationRecord,
      {
        type: 'childList',
        target: draft,
        addedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ], sourceWindow, classifier);

    expect(hasSourceCredentialSecretAncestor(
      draft,
      classifier,
      sourceWindow,
    )).toBe(true);
  });

  it('withholds a property-only value written inside a same-task CSS mask', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="otp" type="text"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#otp')!;
    const classifier = new StickySourceSecretClassifier();
    input.classList.add('masked');
    input.value = 'property-only otp';
    input.classList.remove('masked');
    rememberSourceMutationSecrets([
      {
        type: 'attributes',
        target: input,
        attributeName: 'class',
        oldValue: '',
      } as unknown as MutationRecord,
      {
        type: 'attributes',
        target: input,
        attributeName: 'class',
        oldValue: 'masked',
      } as unknown as MutationRecord,
    ], {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window, classifier);
    let valueReads = 0;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => {
        valueReads += 1;
        throw new Error('sticky secret values must not be read');
      },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      classifier,
    );

    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.records.some(
      ({ nodeId: recordNodeId }) => recordNodeId === nodeId(input),
    )).toBe(false);
    expect(valueReads).toBe(0);
    session.dispose();
  });

  it('remembers one mask-removal record on a newly added value control', () => {
    const { document, window } = parseHTML('<html><body></body></html>');
    const input = document.createElement('input') as HTMLInputElement;
    input.type = 'text';
    input.className = 'masked';
    input.value = 'detached property-only otp';
    document.body.append(input);
    input.className = '';
    const classifier = new StickySourceSecretClassifier();
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;

    rememberSourceMutationSecrets([
      {
        type: 'childList',
        target: document.body,
        addedNodes: [input] as unknown as NodeList,
      } as unknown as MutationRecord,
      {
        type: 'attributes',
        target: input,
        attributeName: 'class',
        oldValue: 'masked',
      } as unknown as MutationRecord,
    ], sourceWindow, classifier);

    expect(hasSourceCredentialSecretAncestor(
      input,
      classifier,
      sourceWindow,
    )).toBe(true);
    let valueReads = 0;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => {
        valueReads += 1;
        throw new Error('newly added masked values must not be read');
      },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      classifier,
    );

    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.records.some(
      ({ nodeId: recordNodeId }) => recordNodeId === nodeId(input),
    )).toBe(false);
    expect(valueReads).toBe(0);
    session.dispose();
  });

  it('taints a subtree removed from a sticky secret target before public addition', () => {
    const { document } = parseHTML(`
      <html><body>
        <section id="secret" autocomplete="one-time-code">
          <input id="draft" type="text">
        </section>
        <main id="public"></main>
      </body></html>
    `);
    const secret = document.querySelector('#secret')!;
    const draft = document.querySelector<HTMLInputElement>('#draft')!;
    const publicTarget = document.querySelector('#public')!;
    const classifier = new StickySourceSecretClassifier();
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;
    expect(hasSourceCredentialSecretAncestor(
      secret,
      classifier,
      sourceWindow,
    )).toBe(true);
    expect(classifier.isSecret(draft)).toBe(false);

    publicTarget.append(draft);
    rememberSourceMutationSecrets([
      {
        type: 'childList',
        target: secret,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [draft] as unknown as NodeList,
      } as unknown as MutationRecord,
      {
        type: 'childList',
        target: publicTarget,
        addedNodes: [draft] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ], sourceWindow, classifier);

    expect(hasSourceCredentialSecretAncestor(
      draft,
      classifier,
      sourceWindow,
    )).toBe(true);
  });

  it('primes secret descendants so public moves stay withheld across reconnects', () => {
    const { document, window } = parseHTML(`
      <html><body>
        <section autocomplete="webauthn">
          <input id="draft" type="text"><span id="secret-text">ancestor text credential</span>
        </section>
        <main id="public" contenteditable="true"></main>
      </body></html>
    `);
    const draft = document.querySelector<HTMLInputElement>('#draft')!;
    const secretText = document.querySelector('#secret-text')!.firstChild!;
    draft.value = 'ancestor credential';
    const classifier = new StickySourceSecretClassifier();
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;
    eagerlyClassifySourceDocumentSecrets(document, sourceWindow, classifier);
    document.querySelector('#public')!.append(draft, secretText);
    let valueReads = 0;
    let textReads = 0;
    Object.defineProperty(draft, 'value', {
      configurable: true,
      get: () => {
        valueReads += 1;
        throw new Error('primed secret descendants must not be read');
      },
    });
    Object.defineProperty(secretText, 'nodeValue', {
      configurable: true,
      get: () => {
        textReads += 1;
        throw new Error('primed secret Text must not be read');
      },
    });

    const bridge = 'isolated-html' as const;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, bridge),
    );
    const session = createSession(
      port,
      document,
      window,
      bridge,
      classifier,
    );
    port.emit(createSemanticSourceStart(
      bridge, identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(port.messages[0]!.records.some(
      ({ nodeId: recordNodeId }) =>
        recordNodeId === nodeId(draft) || recordNodeId === nodeId(secretText),
    )).toBe(false);
    session.dispose();
    expect(valueReads).toBe(0);
    expect(textReads).toBe(0);
  });

  it('does not turn ordinary dynamic class and text updates into credentials', () => {
    const { document } = parseHTML(
      '<html><body><div id="status">updated</div></body></html>',
    );
    const status = document.querySelector('#status')!;
    const classifier = new StickySourceSecretClassifier();
    const sourceWindow = {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window;
    rememberSourceMutationSecrets([
      {
        type: 'attributes',
        target: status,
        attributeName: 'class',
        oldValue: 'loading',
      } as unknown as MutationRecord,
      {
        type: 'childList',
        target: status,
        addedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ], sourceWindow, classifier);

    expect(hasSourceCredentialSecretAncestor(
      status,
      classifier,
      sourceWindow,
    )).toBe(false);
  });

  it('coalesces mutations behind apply ACK and emits full-state removals', () => {
    const { document, window } = parseHTML(
      '<html><body><textarea id="draft">first</textarea></body></html>',
    );
    const draft = document.querySelector<HTMLTextAreaElement>('#draft')!;
    draft.value = 'first';
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window, 'isolated-html');
    port.emit(createSemanticSourceStart(
      'isolated-html',
      identity,
      FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const first = port.messages[0]!;

    draft.value = 'second';
    session.refresh();
    session.refresh();
    expect(port.messages).toHaveLength(1);

    port.emit(createSemanticSourceAck(
      identity,
      first.policyFingerprint,
      first.sequence,
    ));
    expect(port.messages).toHaveLength(2);
    expect(port.messages[1]!.records.map((record) => record.text))
      .toContain('second');

    draft.remove();
    session.refresh();
    expect(port.messages).toHaveLength(2);
    port.emit(createSemanticSourceAck(
      identity,
      first.policyFingerprint,
      port.messages[1]!.sequence,
    ));
    expect(port.messages[2]!.records).toEqual([]);
    session.dispose();
  });

  it('polls silent programmatic control property changes without a DOM event', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="query" type="search"><textarea id="draft"></textarea>' +
      '<select id="choice" multiple><option>One</option><option>Two</option></select></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#query')!;
    const textarea = document.querySelector<HTMLTextAreaElement>('#draft')!;
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const firstOption = select.options.item(0)!;
    const secondOption = select.options.item(1)!;
    let selectedOption = firstOption;
    input.value = 'first query';
    textarea.value = 'first draft';
    Object.defineProperties(select, {
      selectedIndex: {
        configurable: true,
        get: () => selectedOption === firstOption ? 0 : 1,
      },
      selectedOptions: {
        configurable: true,
        get: () => [selectedOption],
      },
      multiple: {
        configurable: true,
        get: () => true,
      },
    });
    Object.defineProperty(firstOption, 'selected', {
      configurable: true,
      get: () => selectedOption === firstOption,
    });
    Object.defineProperty(secondOption, 'selected', {
      configurable: true,
      get: () => selectedOption === secondOption,
    });
    const timers: Array<() => void> = [];
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      undefined,
      timers,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const first = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      first.policyFingerprint,
      first.sequence,
    ));

    input.value = 'second query';
    textarea.value = 'second draft';
    selectedOption = secondOption;
    const poll = timers.shift();
    expect(poll).toBeTypeOf('function');
    poll?.();

    expect(port.messages).toHaveLength(2);
    expect(port.messages[1]!.records.map(({ text }) => text)).toEqual(
      expect.arrayContaining(['second query', 'second draft']),
    );
    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-state',
      selectedOptionNodeIds: [nodeId(secondOption)],
    }));
    session.dispose();
  });

  it('polls selected options beyond the first option-scan window', () => {
    const options = Array.from(
      { length: 1_026 },
      (_, index) => `<option>Choice ${index}</option>`,
    ).join('');
    const { document, window } = parseHTML(
      `<html><body><select id="choice" multiple>${options}</select></body></html>`,
    );
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const first = select.options.item(0)!;
    const penultimate = select.options.item(1_024)!;
    const last = select.options.item(1_025)!;
    let tail = last;
    Object.defineProperties(select, {
      selectedIndex: { configurable: true, get: () => 0 },
      selectedOptions: { configurable: true, get: () => [first, tail] },
      multiple: { configurable: true, get: () => true },
    });
    for (const option of [first, penultimate, last]) {
      Object.defineProperty(option, 'selected', {
        configurable: true,
        get: () => option === first || option === tail,
      });
    }
    const timers: Array<() => void> = [];
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      undefined,
      timers,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const firstBatch = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      firstBatch.policyFingerprint,
      firstBatch.sequence,
    ));

    tail = penultimate;
    timers.shift()?.();

    expect(port.messages).toHaveLength(2);
    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-state',
      selectedOptionNodeIds: [nodeId(first), nodeId(penultimate)],
    }));
    session.dispose();
  });

  it('sleeps the control poller until a pollable control is discovered', () => {
    const { document, window } = parseHTML(
      '<html><body><main>Article text</main></body></html>',
    );
    const timers: Array<() => void> = [];
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      undefined,
      timers,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    expect(timers).toHaveLength(0);

    const input = document.createElement('input');
    input.value = 'new draft';
    document.body.append(input);
    session.refresh();
    port.emit(createSemanticSourceAck(
      identity,
      initial.policyFingerprint,
      initial.sequence,
    ));

    expect(port.messages.at(-1)?.records.map(({ text }) => text))
      .toContain('new draft');
    expect(timers).toHaveLength(1);
    session.dispose();
  });

  it('tracks native select picker state on activation and silent close', () => {
    const { document, window } = parseHTML(
      '<html><body><select id="choice"><option selected>One</option></select></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const option = select.options.item(0)!;
    const originalMatches = select.matches.bind(select);
    let pickerOpen = false;
    Object.defineProperties(select, {
      selectedIndex: { configurable: true, get: () => 0 },
      selectedOptions: { configurable: true, get: () => [option] },
      multiple: { configurable: true, get: () => false },
    });
    Object.defineProperty(option, 'selected', {
      configurable: true,
      get: () => true,
    });
    select.matches = ((selector: string) => selector === ':open'
      ? pickerOpen
      : originalMatches(selector)) as typeof select.matches;
    const timers: Array<() => void> = [];
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      undefined,
      timers,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    expect(initial.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-state',
      pickerOpen: false,
    }));
    port.emit(createSemanticSourceAck(
      identity,
      initial.policyFingerprint,
      initial.sequence,
    ));

    pickerOpen = true;
    expect(select.matches(':open')).toBe(true);
    select.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-state',
      pickerOpen: true,
    }));
    port.emit(createSemanticSourceAck(
      identity,
      port.messages[1]!.policyFingerprint,
      port.messages[1]!.sequence,
    ));

    pickerOpen = false;
    const poll = timers.shift();
    expect(poll).toBeTypeOf('function');
    poll?.();
    expect(port.messages[2]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-state',
      pickerOpen: false,
    }));
    session.dispose();
  });

  it('rechecks native picker state after the browser activation action', () => {
    const { document, window } = parseHTML(
      '<html><body><select><option selected>One</option></select></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('select')!;
    const option = select.options.item(0)!;
    const originalMatches = select.matches.bind(select);
    let pickerOpen = false;
    Object.defineProperties(select, {
      selectedIndex: { configurable: true, get: () => 0 },
      selectedOptions: { configurable: true, get: () => [option] },
      multiple: { configurable: true, get: () => false },
    });
    Object.defineProperty(option, 'selected', {
      configurable: true,
      get: () => true,
    });
    select.matches = ((selector: string) => selector === ':open'
      ? pickerOpen
      : originalMatches(selector)) as typeof select.matches;
    const timers: Array<() => void> = [];
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port, document, window, 'isolated-html', undefined, undefined, timers,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity, initial.policyFingerprint, initial.sequence,
    ));

    select.dispatchEvent(new window.Event('click', { bubbles: true }));
    expect(port.messages).toHaveLength(1);
    pickerOpen = true;
    const postActivation = timers.pop();
    expect(postActivation).toBeTypeOf('function');
    postActivation?.();

    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-state',
      pickerOpen: true,
    }));
    session.dispose();
  });

  it('tracks a shadow-root select through its composed activation path', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="host"></div></body></html>',
    );
    const host = document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<select><option selected>One</option></select>';
    const select = shadow.querySelector<HTMLSelectElement>('select')!;
    const option = select.options.item(0)!;
    let pickerOpen = false;
    Object.defineProperties(select, {
      selectedIndex: { configurable: true, get: () => 0 },
      selectedOptions: { configurable: true, get: () => [option] },
      multiple: { configurable: true, get: () => false },
    });
    Object.defineProperty(option, 'selected', {
      configurable: true,
      get: () => true,
    });
    const originalMatches = select.matches.bind(select);
    select.matches = ((selector: string) => selector === ':open'
      ? pickerOpen
      : originalMatches(selector)) as typeof select.matches;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      initial.policyFingerprint,
      initial.sequence,
    ));

    pickerOpen = true;
    const activation = new window.Event('click', {
      bubbles: true,
      composed: true,
    });
    Object.defineProperty(activation, 'composedPath', {
      configurable: true,
      value: () => [select, shadow, host, document.body, document],
    });
    host.dispatchEvent(activation);

    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-state',
      pickerOpen: true,
    }));
    session.dispose();
  });

  it('observes controls inserted inside an open shadow root', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="host"></div></body></html>',
    );
    const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
    const mutationHarness: SemanticMutationHarness = { observed: [] };
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      undefined,
      undefined,
      mutationHarness,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(mutationHarness.observed).toEqual(expect.arrayContaining([
      document,
      shadow,
    ]));
    const initial = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      initial.policyFingerprint,
      initial.sequence,
    ));

    const select = document.createElement('select');
    select.innerHTML = '<option selected>Late choice</option>';
    Object.defineProperty(select, 'multiple', {
      configurable: true,
      get: () => false,
    });
    shadow.append(select);
    mutationHarness.callback?.([{
      type: 'childList',
      target: shadow,
      addedNodes: [select],
      removedNodes: [],
    } as unknown as MutationRecord], {} as MutationObserver);

    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-presentation',
      nodeId: nodeId(select),
    }));
    session.dispose();
  });

  it('skips semantic rescans for provable same-value mutations', () => {
    const { document, window } = parseHTML(
      '<html><body><main class="stable">Article</main></body></html>',
    );
    const target = document.querySelector('main')!;
    let styleReads = 0;
    const mutationHarness: SemanticMutationHarness = { observed: [] };
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      () => {
        styleReads += 1;
        return {
          display: 'block',
          visibility: 'visible',
          getPropertyValue: () => 'none',
        } as unknown as CSSStyleDeclaration;
      },
      undefined,
      mutationHarness,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      initial.policyFingerprint,
      initial.sequence,
    ));
    styleReads = 0;

    mutationHarness.callback?.([{
      type: 'attributes',
      target,
      attributeName: 'class',
      attributeNamespace: null,
      oldValue: 'stable',
    } as unknown as MutationRecord], {} as MutationObserver);

    // The sticky secret ledger still performs its one mandatory classification
    // read; the full semantic scan would add more reads after that boundary.
    expect(styleReads).toBe(1);
    expect(port.messages).toHaveLength(1);
    session.dispose();
  });

  it('suppresses replacement batches when source churn leaves proofs unchanged', () => {
    const { document, window } = parseHTML(
      '<html><body><main class="stable">Article</main></body></html>',
    );
    const target = document.querySelector('main')!;
    const mutationHarness: SemanticMutationHarness = { observed: [] };
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port, document, window, 'isolated-html', undefined, undefined, undefined,
      mutationHarness,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity, initial.policyFingerprint, initial.sequence,
    ));

    target.className = 'framework-maintenance-tick';
    mutationHarness.callback?.([{
      type: 'attributes',
      target,
      attributeName: 'class',
      attributeNamespace: null,
      oldValue: 'stable',
    } as unknown as MutationRecord], {} as MutationObserver);

    expect(port.messages).toHaveLength(1);
    session.dispose();
  });

  it('ignores presentation events outside disclosure neighborhoods', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger" aria-expanded="false" ' +
      'aria-controls="panel">Menu</button><div id="panel" hidden>Items</div>' +
      '<div id="unrelated">Article</div></body></html>',
    );
    let styleReads = 0;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      ((element: Element) => {
        styleReads += 1;
        return {
          display: element.hasAttribute('hidden') ? 'none' : 'block',
          visibility: 'visible',
          getPropertyValue: () => 'none',
        } as unknown as CSSStyleDeclaration;
      }) as Window['getComputedStyle'],
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      initial.policyFingerprint,
      initial.sequence,
    ));
    styleReads = 0;

    document.querySelector('#unrelated')!.dispatchEvent(
      new window.Event('pointerover', { bubbles: true, composed: true }),
    );
    expect(styleReads).toBe(0);

    document.querySelector('#trigger')!.dispatchEvent(
      new window.Event('pointerover', { bubbles: true, composed: true }),
    );
    expect(styleReads).toBeGreaterThan(0);
    session.dispose();
  });

  it('reads text only from a validated disclosure, including its closed state', () => {
    const { document, window } = parseHTML(
      '<html><body><button aria-expanded="false" aria-controls="menu">Menu</button><div id="menu" hidden>Account notices</div><div id="other">Not controlled</div></body></html>',
    );
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html',
      identity,
      { ...FULL_VISIBLE_REPLICA_READ_SCOPE, controlSemantics: false },
    ));
    const texts = port.messages[0]!.records.map((record) => record.text);
    expect(texts).toContain('Account notices');
    expect(texts).not.toContain('Not controlled');
    const firstProof = port.messages[0]!.proofs.find(
      (proof) => proof.kind === 'disclosure-state',
    );
    expect(firstProof).toEqual(expect.objectContaining({
      kind: 'disclosure-state',
      triggerNodeId: nodeId(document.querySelector('button')!),
      panelNodeId: nodeId(document.querySelector('#menu')!),
      popupRole: 'region',
      expanded: false,
      revision: 1,
    }));
    const trigger = document.querySelector('button')!;
    const panel = document.querySelector('#menu')!;
    trigger.setAttribute('aria-expanded', 'true');
    panel.removeAttribute('hidden');
    port.emit(createSemanticSourceAck(
      identity,
      port.messages[0]!.policyFingerprint,
      port.messages[0]!.sequence,
    ));
    session.refresh();
    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'disclosure-state',
      relationId: firstProof?.kind === 'disclosure-state'
        ? firstProof.relationId
        : '',
      expanded: true,
      revision: 2,
    }));
    session.dispose();
  });

  it('infers one bounded non-ARIA navigation menu and admits its hidden text', () => {
    const { document, window } = parseHTML(`<html><body><nav>
      <div id="wrapper"><a id="trigger" href="/library">Resources</a>
        <div id="panel" class="collapsed"><a href="/school">Startup School</a></div>
      </div></nav></body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      structuralMenuStyle((element) =>
        element.classList.contains('collapsed') ? 'display' : undefined),
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    const batch = port.messages[0]!;
    expect(batch.proofs).toContainEqual(expect.objectContaining({
      kind: 'structural-menu',
      containerNodeId: nodeId(document.querySelector('#wrapper')!),
      triggerNodeId: nodeId(document.querySelector('#trigger')!),
      panelNodeId: nodeId(document.querySelector('#panel')!),
      popupRole: 'menu',
      expanded: false,
      gate: 'disclosureContent',
    }));
    expect(batch.records).toContainEqual(expect.objectContaining({
      text: 'Startup School',
      gate: 'disclosureContent',
      presentation: 'text',
    }));
    expect(batch.proofs.some((proof) => proof.kind === 'disclosure-state'))
      .toBe(false);
    session.dispose();
  });

  it.each(['content-visibility', 'opacity'] as const)(
    'infers a structural menu collapsed with %s',
    (collapse) => {
      const { document, window } = parseHTML(`<html><body><nav>
        <div id="wrapper"><button id="trigger">Resources</button>
          <div id="panel"><a href="/school">Startup School</a></div>
        </div></nav></body></html>`);
      installPaintedTabFixture(document, window as unknown as Window);
      const panel = document.querySelector('#panel')!;
      const port = new FakeSemanticPort(
        createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
      );
      const session = createSession(
        port,
        document,
        window,
        'isolated-html',
        undefined,
        structuralMenuStyle((element) => element === panel ? collapse : undefined),
      );

      port.emit(createSemanticSourceStart(
        'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
      ));
      expect(port.messages[0]!.proofs).toContainEqual(expect.objectContaining({
        kind: 'structural-menu',
        panelNodeId: nodeId(panel),
      }));
      session.dispose();
    },
  );

  it('rejects a structural menu beneath an unpainted flat-tree ancestor', () => {
    const { document, window } = parseHTML(`<html><body><section id="outer"><nav>
      <div id="wrapper"><button id="trigger">Resources</button>
        <div id="panel"><a href="/school">Startup School</a></div>
      </div></nav></section></body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const outer = document.querySelector('#outer')!;
    const panel = document.querySelector('#panel')!;
    Object.defineProperty(outer, 'getClientRects', {
      configurable: true,
      value: () => Object.assign([], { item: () => null }) as DOMRectList,
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      structuralMenuStyle((element) => element === panel ? 'display' : undefined),
    );

    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(port.messages[0]!.proofs.some((proof) =>
      proof.kind === 'structural-menu')).toBe(false);
    expect(port.messages[0]!.records.map((record) => record.text))
      .not.toContain('Startup School');
    session.dispose();
  });

  it('omits only a structural menu whose required panel text exceeds record capacity', () => {
    const editable = Array.from(
      { length: MAX_SEMANTIC_SOURCE_RECORDS },
      (_, index) => `<div contenteditable="true">Editable ${index}</div>`,
    ).join('');
    const { document, window } = parseHTML(`<html><body>
      <button id="stable"></button>${editable}<nav><div id="wrapper">
        <button id="trigger">Resources</button><div id="panel">
          <a href="/school">Startup School</a></div></div></nav>
      </body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const panel = document.querySelector('#panel')!;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      structuralMenuStyle((element) => element === panel ? 'display' : undefined),
    );

    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const batch = port.messages[0]!;
    expect(batch.records).toHaveLength(MAX_SEMANTIC_SOURCE_RECORDS);
    expect(batch.records.map((record) => record.text)).not.toContain('Startup School');
    expect(batch.proofs.some((proof) => proof.kind === 'structural-menu'))
      .toBe(false);
    expect(batch.proofs).toContainEqual(expect.objectContaining({
      kind: 'control-state',
      nodeId: nodeId(document.querySelector('#stable')!),
    }));
    session.dispose();
  });

  it('emits inline tab state without reading hidden panels and revisions follow A-B-A', () => {
    const { document, window } = parseHTML(`
      <html><body><div role="tablist">
        <div id="tab-a" role="tab" aria-selected="true" aria-expanded="true"
          aria-controls="panel-a">A</div>
        <div id="tab-b" role="tab" aria-selected="false" aria-expanded="false"
          aria-controls="panel-b">B</div>
      </div>
      <section id="panel-a" role="tabpanel" aria-hidden="false">Active news</section>
      <section id="panel-b" role="tabpanel" aria-hidden="true" hidden>Inactive news</section>
      </body></html>
    `);
    installPaintedTabFixture(document, window as unknown as Window);
    const inactiveText = document.querySelector('#panel-b')!.firstChild!;
    Object.defineProperty(inactiveText, 'nodeValue', {
      configurable: true,
      get: () => {
        throw new Error('inactive tab text must stay unread');
      },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      tabFixtureComputedStyle,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    const tabProofs = port.messages[0]!.proofs.filter(
      (proof) => proof.kind === 'tab-state',
    );
    expect(tabProofs).toHaveLength(2);
    expect(tabProofs.map((proof) => proof.kind === 'tab-state' && proof.selected))
      .toEqual(expect.arrayContaining([true, false]));
    expect(port.messages[0]!.proofs.some(
      (proof) => proof.kind === 'disclosure-state',
    )).toBe(false);
    expect(port.messages[0]!.records.some(
      ({ gate }) => gate === 'disclosureContent',
    )).toBe(false);

    port.emit(createSemanticSourceAck(
      identity,
      port.messages[0]!.policyFingerprint,
      port.messages[0]!.sequence,
    ));
    selectTab(document, 'b');
    session.refresh();
    expect(port.messages[1]!.proofs.filter(
      (proof) => proof.kind === 'tab-state',
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ selected: false, revision: 2 }),
      expect.objectContaining({ selected: true, revision: 2 }),
    ]));

    port.emit(createSemanticSourceAck(
      identity,
      port.messages[1]!.policyFingerprint,
      port.messages[1]!.sequence,
    ));
    selectTab(document, 'a');
    session.refresh();
    expect(port.messages[2]!.proofs.filter(
      (proof) => proof.kind === 'tab-state',
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ selected: true, revision: 3 }),
      expect.objectContaining({ selected: false, revision: 3 }),
    ]));
    session.dispose();
  });

  it('keeps visible tab text and optional tab state on independent gates', () => {
    const { document, window } = parseHTML(`
      <html><body><div role="tab" aria-selected="true" aria-controls="panel">A</div>
      <section id="panel" role="tabpanel">Visible news</section></body></html>
    `);
    installPaintedTabFixture(document, window as unknown as Window);
    const controlOnly = {
      controlSemantics: true,
      controlImages: false,
      disclosureContent: false,
      formValues: false,
      personalDataValues: false,
      editableContent: false,
    } as const;
    const controlPort = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const controlSession = createSession(
      controlPort, document, window, 'isolated-html', undefined,
      tabFixtureComputedStyle,
    );
    controlPort.emit(createSemanticSourceStart(
      'isolated-html', identity, controlOnly,
    ));
    expect(controlPort.messages[0]!.proofs.some(
      (proof) => proof.kind === 'tab-state',
    )).toBe(true);
    expect(controlPort.messages[0]!.records).toEqual([]);
    controlSession.dispose();

    const disclosureOnly = {
      ...controlOnly,
      controlSemantics: false,
      disclosureContent: true,
    } as const;
    const disclosurePort = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const disclosureSession = createSession(
      disclosurePort, document, window, 'isolated-html', undefined,
      tabFixtureComputedStyle,
    );
    disclosurePort.emit(createSemanticSourceStart(
      'isolated-html', identity, disclosureOnly,
    ));
    expect(disclosurePort.messages[0]!.proofs.some(
      (proof) => proof.kind === 'tab-state',
    )).toBe(false);
    expect(disclosurePort.messages[0]!.records).toEqual([]);
    disclosureSession.dispose();
  });

  it('emits toggle, current-item, indicator and input range state through typed ARIA proofs', () => {
    const { document, window } = parseHTML(
      '<html><body><nav><a id="here" href="/here" aria-current="page">Here</a>' +
      '<a id="there" href="/there">There</a></nav>' +
      '<button id="bold" aria-pressed="true">Bold</button>' +
      '<ol><li id="step" aria-current="Step">Step two</li></ol>' +
      '<div id="upload" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42">Uploading</div>' +
      '<div id="volume" role="slider" aria-valuemin="0" aria-valuemax="10" aria-valuenow="7" aria-valuetext="seven">Volume</div>' +
      '<div id="toggle" role="button" aria-pressed="mixed">Mixed</div>' +
      '</body></html>',
    );
    const here = document.querySelector<HTMLElement>('#here')!;
    const there = document.querySelector<HTMLElement>('#there')!;
    const bold = document.querySelector<HTMLElement>('#bold')!;
    const step = document.querySelector<HTMLElement>('#step')!;
    const upload = document.querySelector<HTMLElement>('#upload')!;
    const volume = document.querySelector<HTMLElement>('#volume')!;
    const toggle = document.querySelector<HTMLElement>('#toggle')!;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const ariaProofs = (index: number) => port.messages[index]!.proofs
      .filter((proof) => proof.kind === 'aria-state')
      .map((proof) => proof.kind === 'aria-state'
        ? [proof.nodeId, proof.gate, proof.state, proof.value, proof.revision]
        : [])
      .sort((left, right) => Number(left[0]) - Number(right[0]));
    expect(ariaProofs(0)).toEqual([
      [nodeId(here), 'controlSemantics', 'current', 'page', 1],
      [nodeId(bold), 'formValues', 'pressed', 'true', 1],
      [nodeId(step), 'controlSemantics', 'current', 'step', 1],
      [nodeId(upload), 'controlSemantics', 'valuenow', '42', 1],
      [nodeId(volume), 'formValues', 'valueinput', '7', 1],
      [nodeId(toggle), 'formValues', 'pressed', 'mixed', 1],
    ]);
    // The slider's numeric aria-valuenow travels under formValues, but its
    // free-text aria-valuetext ("seven") is never carried.
    expect(JSON.stringify(port.messages[0])).not.toContain('seven');
    expect(port.messages[0]!.proofs.some((proof) =>
      proof.kind === 'aria-state' && proof.nodeId === nodeId(there),
    )).toBe(false);

    const first = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity, first.policyFingerprint, first.sequence,
    ));
    bold.setAttribute('aria-pressed', 'false');
    upload.setAttribute('aria-valuenow', '1e3');
    session.refresh();
    expect(ariaProofs(1)).toEqual([
      [nodeId(here), 'controlSemantics', 'current', 'page', 1],
      [nodeId(bold), 'formValues', 'pressed', 'false', 2],
      [nodeId(step), 'controlSemantics', 'current', 'step', 1],
      [nodeId(volume), 'formValues', 'valueinput', '7', 1],
      [nodeId(toggle), 'formValues', 'pressed', 'mixed', 1],
    ]);
    session.dispose();

    const structurePort = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const structureSession = createSession(structurePort, document, window);
    structurePort.emit(createSemanticSourceStart('isolated-html', identity, {
      ...FULL_VISIBLE_REPLICA_READ_SCOPE,
      formValues: false,
      personalDataValues: false,
    }));
    expect(structurePort.messages[0]!.proofs
      .filter((proof) => proof.kind === 'aria-state')
      .map((proof) => proof.kind === 'aria-state' ? proof.state : '')
      .sort()).toEqual(['current', 'current']);
    structureSession.dispose();
  });

  it('carries native range and number values under the form-value gate', () => {
    const { document, window } = parseHTML(
      '<html><body>' +
      '<input id="volume" type="range" min="0" max="10" value="5">' +
      '<input id="count" type="number" value="42">' +
      '</body></html>',
    );
    const volume = document.querySelector<HTMLInputElement>('#volume')!;
    const count = document.querySelector<HTMLInputElement>('#count')!;
    volume.value = '5';
    count.value = '42';
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const valueRecord = (node: object) => port.messages[0]!.records.find(
      (record) => record.nodeId === nodeId(node) &&
        record.presentation === 'value',
    );
    expect(valueRecord(volume)).toMatchObject({
      category: 'ordinary-form', gate: 'formValues', text: '5',
    });
    expect(valueRecord(count)).toMatchObject({
      category: 'ordinary-form', gate: 'formValues', text: '42',
    });
    session.dispose();

    const pageOnlyPort = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const pageOnlySession = createSession(pageOnlyPort, document, window);
    pageOnlyPort.emit(createSemanticSourceStart('isolated-html', identity, {
      ...FULL_VISIBLE_REPLICA_READ_SCOPE,
      formValues: false,
      personalDataValues: false,
    }));
    expect(pageOnlyPort.messages[0]!.records.some(
      (record) => record.presentation === 'value',
    )).toBe(false);
    pageOnlySession.dispose();
  });

  it('carries aria-labelledby and aria-describedby as native-id relationships', () => {
    const { document, window } = parseHTML(
      '<html><body>' +
      '<h2 id="title">Billing</h2>' +
      '<p id="desc">Your billing address</p>' +
      '<input id="pw" type="password">' +
      '<div id="region" role="group" aria-labelledby="title" aria-describedby="desc">Fields</div>' +
      '<div id="mixed" role="group" aria-labelledby="title pw">More</div>' +
      '<div id="dangling" role="group" aria-labelledby="missing">Nope</div>' +
      '</body></html>',
    );
    const title = document.querySelector<HTMLElement>('#title')!;
    const desc = document.querySelector<HTMLElement>('#desc')!;
    const region = document.querySelector<HTMLElement>('#region')!;
    const mixed = document.querySelector<HTMLElement>('#mixed')!;
    const dangling = document.querySelector<HTMLElement>('#dangling')!;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const relationships = port.messages[0]!.proofs
      .filter((proof) => proof.kind === 'aria-relationship')
      .map((proof) => proof.kind === 'aria-relationship'
        ? [proof.nodeId, proof.gate, proof.relation, [...proof.targetNodeIds]]
        : []);
    expect(relationships).toEqual(expect.arrayContaining([
      [nodeId(region), 'controlSemantics', 'labelledby', [nodeId(title)]],
      [nodeId(region), 'controlSemantics', 'describedby', [nodeId(desc)]],
      // The secret password reference is dropped; the public heading survives.
      [nodeId(mixed), 'controlSemantics', 'labelledby', [nodeId(title)]],
    ]));
    // A dangling reference produces no relationship proof, and no source id
    // string ever travels.
    expect(relationships.some((entry) => entry[0] === nodeId(dangling)))
      .toBe(false);
    expect(JSON.stringify(port.messages[0])).not.toContain('title');
    expect(JSON.stringify(port.messages[0])).not.toContain('missing');
    session.dispose();

    const pageOnly = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const pageOnlySession = createSession(pageOnly, document, window);
    pageOnly.emit(createSemanticSourceStart('isolated-html', identity, {
      ...FULL_VISIBLE_REPLICA_READ_SCOPE,
      controlSemantics: false,
    }));
    expect(pageOnly.messages[0]!.proofs.some(
      (proof) => proof.kind === 'aria-relationship',
    )).toBe(false);
    pageOnlySession.dispose();
  });

  it('emits revisioned native select and choice state only through typed proofs', () => {
    const { document, window } = parseHTML(
      '<html><body><select id="choice" multiple><option id="one" selected>One</option><option id="two">Two</option></select><input id="toggle" type="checkbox"><div id="aria" role="checkbox" aria-checked="mixed" aria-disabled="true">ARIA choice</div></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const one = document.querySelector<HTMLOptionElement>('#one')!;
    const two = document.querySelector<HTMLOptionElement>('#two')!;
    const toggle = document.querySelector<HTMLInputElement>('#toggle')!;
    const aria = document.querySelector<HTMLElement>('#aria')!;
    let selected = [one];
    let disabled = false;
    let checked = true;
    Object.defineProperties(select, {
      selectedOptions: { configurable: true, get: () => selected },
      multiple: { configurable: true, get: () => true },
      disabled: { configurable: true, get: () => disabled },
    });
    Object.defineProperties(toggle, {
      checked: { configurable: true, get: () => checked },
      indeterminate: { configurable: true, get: () => false },
      disabled: { configurable: true, get: () => false },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'select-state',
        nodeId: nodeId(select),
        selectedOptionNodeIds: [nodeId(one)],
        multiple: true,
        pickerOpen: false,
        revision: 1,
      }),
      expect.objectContaining({
        kind: 'choice-state',
        nodeId: nodeId(toggle),
        checked: true,
        indeterminate: false,
        revision: 1,
      }),
      expect.objectContaining({
        kind: 'control-state',
        nodeId: nodeId(select),
        disabled: false,
        revision: 1,
      }),
      expect.objectContaining({
        kind: 'control-state',
        nodeId: nodeId(toggle),
        disabled: false,
        revision: 1,
      }),
      expect.objectContaining({
        kind: 'control-state',
        nodeId: nodeId(aria),
        disabled: true,
        revision: 1,
      }),
      expect.objectContaining({
        kind: 'aria-state',
        nodeId: nodeId(aria),
        state: 'checked',
        value: 'mixed',
        revision: 1,
      }),
    ]));

    selected = [two];
    disabled = true;
    checked = false;
    const first = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity, first.policyFingerprint, first.sequence,
    ));
    session.refresh();
    expect(port.messages[1]!.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'select-state',
        selectedOptionNodeIds: [nodeId(two)],
        revision: 2,
      }),
      expect.objectContaining({
        kind: 'choice-state', checked: false, revision: 2,
      }),
      expect.objectContaining({
        kind: 'control-state', nodeId: nodeId(select), disabled: true,
        revision: 2,
      }),
    ]));
    session.dispose();
  });

  it('advances a semantic identity after it leaves and reenters a live SPA', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="draft" type="text" value="Current draft"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#draft')!;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const initial = port.messages[0]!;
    const initialValue = initial.records.find(
      (record) => record.nodeId === nodeId(input) &&
        record.presentation === 'value',
    );
    expect(initialValue?.nodeRevision).toBe(1);

    port.emit(createSemanticSourceAck(
      identity,
      initial.policyFingerprint,
      initial.sequence,
    ));
    input.remove();
    session.refresh();
    const removed = port.messages[1]!;
    expect(removed.records.some((record) => record.nodeId === nodeId(input)))
      .toBe(false);

    port.emit(createSemanticSourceAck(
      identity,
      removed.policyFingerprint,
      removed.sequence,
    ));
    document.body.append(input);
    session.refresh();
    const reenteredValue = port.messages[2]!.records.find(
      (record) => record.nodeId === nodeId(input) &&
        record.presentation === 'value',
    );
    expect(reenteredValue?.nodeRevision).toBe(3);
    session.dispose();
  });

  it('does not aggregate selected option labels with secret descendants', () => {
    const { document, window } = parseHTML(`
      <html><body><select id="choice" multiple>
        <option id="otp" selected><span autocomplete="one-time-code">otp secret</span></option>
        <option id="masked" selected><span class="masked">masked secret</span></option>
      </select></body></html>
    `);
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const options = [...document.querySelectorAll<HTMLOptionElement>('option')];
    let aggregateReads = 0;
    for (const option of options) {
      Object.defineProperty(option, 'label', {
        configurable: true,
        get: () => {
          aggregateReads += 1;
          throw new Error('option.label must remain unread');
        },
      });
    }
    Object.defineProperties(select, {
      selectedOptions: { configurable: true, get: () => options },
      multiple: { configurable: true, get: () => true },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      (element) => ({
        display: 'block',
        visibility: 'visible',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element.classList.contains('masked')
            ? 'disc'
            : 'none',
      }) as unknown as CSSStyleDeclaration,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.records.some(
      ({ nodeId: id }) => options.some((option) => nodeId(option) === id),
    )).toBe(false);
    expect(port.messages[0]!.proofs.some(
      (proof) => proof.kind === 'select-state' && proof.nodeId === nodeId(select),
    )).toBe(false);
    expect(aggregateReads).toBe(0);
    session.dispose();
  });

  it('withholds slotted form evidence below a secret shadow wrapper', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="host"><input id="draft" type="text"></div></body></html>',
    );
    const host = document.querySelector('#host')!;
    const draft = document.querySelector<HTMLInputElement>('#draft')!;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<section autocomplete="webauthn"><slot></slot></section>';
    const slot = shadow.querySelector('slot')!;
    Object.defineProperty(draft, 'assignedSlot', {
      configurable: true,
      value: slot,
    });
    let valueReads = 0;
    Object.defineProperty(draft, 'value', {
      configurable: true,
      get: () => {
        valueReads += 1;
        return 'must-not-read';
      },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.records.some(
      ({ nodeId: id }) => id === nodeId(draft),
    )).toBe(false);
    expect(valueReads).toBe(0);
    session.dispose();
  });

  it('withholds directly slotted editable Text before reading nodeValue', () => {
    const canary = 'direct-slot-editable-secret';
    const { document, window } = parseHTML(
      '<html><body><div id="host" contenteditable="true"></div><div id="public" contenteditable="true"></div></body></html>',
    );
    const host = document.querySelector('#host')!;
    const text = document.createTextNode(canary);
    host.append(text);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<section autocomplete="one-time-code"><slot></slot></section>';
    Object.defineProperty(text, 'assignedSlot', {
      configurable: true,
      value: shadow.querySelector('slot'),
    });
    let textReads = 0;
    Object.defineProperty(text, 'nodeValue', {
      configurable: true,
      get: () => {
        textReads += 1;
        return canary;
      },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);

    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.records.some(
      ({ nodeId: recordNodeId }) => recordNodeId === nodeId(text),
    )).toBe(false);
    expect(JSON.stringify(port.messages[0])).not.toContain(canary);
    expect(textReads).toBe(0);

    const first = port.messages[0]!;
    port.emit(createSemanticSourceAck(
      identity,
      first.policyFingerprint,
      first.sequence,
    ));
    Object.defineProperty(text, 'assignedSlot', {
      configurable: true,
      value: null,
    });
    document.querySelector('#public')!.append(text);
    session.refresh();
    expect(port.messages.at(-1)!.records.some(
      ({ nodeId: recordNodeId }) => recordNodeId === nodeId(text),
    )).toBe(false);
    expect(JSON.stringify(port.messages.at(-1))).not.toContain(canary);
    expect(textReads).toBe(0);
    session.dispose();
  });

  it('separates Standard disabled state from Full current form state', () => {
    const { document, window } = parseHTML(
      '<html><body><select id="choice" disabled><option id="one" selected>One</option></select><input id="toggle" type="checkbox" disabled><div id="aria" role="checkbox" aria-checked="true" aria-disabled="true">Choice</div></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const one = document.querySelector<HTMLOptionElement>('#one')!;
    const toggle = document.querySelector<HTMLInputElement>('#toggle')!;
    let formStateReads = 0;
    let presentationStateReads = 0;
    Object.defineProperties(select, {
      selectedOptions: {
        configurable: true,
        get: () => {
          formStateReads += 1;
          return [one];
        },
      },
      multiple: {
        configurable: true,
        get: () => {
          presentationStateReads += 1;
          return false;
        },
      },
      disabled: { configurable: true, get: () => true },
    });
    Object.defineProperties(toggle, {
      checked: {
        configurable: true,
        get: () => {
          formStateReads += 1;
          return true;
        },
      },
      indeterminate: { configurable: true, get: () => false },
      disabled: { configurable: true, get: () => true },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, STANDARD_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.proofs.length).toBeGreaterThan(0);
    expect(port.messages[0]!.proofs.every(
      (proof) => proof.kind === 'control-state' ||
        proof.kind === 'select-presentation' ||
        proof.kind === 'disclosure-state',
    )).toBe(true);
    expect(port.messages[0]!.proofs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'control-state', nodeId: nodeId(select), disabled: true,
      }),
      expect.objectContaining({
        kind: 'control-state', nodeId: nodeId(toggle), disabled: true,
      }),
      expect.objectContaining({
        kind: 'select-presentation', nodeId: nodeId(select), multiple: false,
        size: null,
      }),
    ]));
    expect(formStateReads).toBe(0);
    expect(presentationStateReads).toBe(1);
    session.dispose();
  });

  it('does not read select, choice, or disclosure state in Page-only scope', () => {
    const { document, window } = parseHTML(
      '<html><body><select id="choice"><option>One</option></select><input id="toggle" type="checkbox"><button id="trigger" aria-expanded="false" aria-controls="panel">Open</button><div id="panel" hidden>Private panel</div></body></html>',
    );
    const select = document.querySelector<HTMLSelectElement>('#choice')!;
    const toggle = document.querySelector<HTMLInputElement>('#toggle')!;
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    let stateReads = 0;
    Object.defineProperty(select, 'selectedOptions', {
      configurable: true,
      get: () => {
        stateReads += 1;
        throw new Error('select state must remain unread');
      },
    });
    Object.defineProperty(toggle, 'checked', {
      configurable: true,
      get: () => {
        stateReads += 1;
        throw new Error('choice state must remain unread');
      },
    });
    Object.defineProperty(toggle, 'disabled', {
      configurable: true,
      get: () => {
        stateReads += 1;
        throw new Error('disabled state must remain unread');
      },
    });
    const originalGetAttribute = trigger.getAttribute.bind(trigger);
    trigger.getAttribute = ((name: string) => {
      if (name === 'aria-expanded' || name === 'aria-controls') {
        stateReads += 1;
        throw new Error('disclosure state must remain unread');
      }
      return originalGetAttribute(name);
    }) as typeof trigger.getAttribute;
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, PAGE_ONLY_REPLICA_READ_SCOPE,
    ));
    expect(port.messages[0]!.proofs).toEqual([]);
    expect(stateReads).toBe(0);
    session.dispose();
  });

  it('does not read editable or disclosure text while both gates are disabled', () => {
    const { document, window } = parseHTML(
      '<html><body><div contenteditable="true">private draft</div><button aria-controls="panel" aria-expanded="false">Open</button><div id="panel" hidden>private panel</div></body></html>',
    );
    let textReads = 0;
    for (const text of [
      document.querySelector('[contenteditable]')!.firstChild!,
      document.querySelector('#panel')!.firstChild!,
    ]) {
      Object.defineProperty(text, 'nodeValue', {
        configurable: true,
        get: () => {
          textReads += 1;
          throw new Error('disabled text gate must remain unread');
        },
      });
    }
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, PAGE_ONLY_REPLICA_READ_SCOPE,
    ));
    expect(port.messages[0]!.records).toEqual([]);
    expect(textReads).toBe(0);
    session.dispose();
  });

  it('fails closed before value or state access when computed style throws', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="draft" type="text"><input id="toggle" type="checkbox"></body></html>',
    );
    const draft = document.querySelector<HTMLInputElement>('#draft')!;
    const toggle = document.querySelector<HTMLInputElement>('#toggle')!;
    let sensitiveReads = 0;
    Object.defineProperty(draft, 'value', {
      configurable: true,
      get: () => {
        sensitiveReads += 1;
        throw new Error('value must remain unread');
      },
    });
    Object.defineProperty(toggle, 'checked', {
      configurable: true,
      get: () => {
        sensitiveReads += 1;
        throw new Error('state must remain unread');
      },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      document,
      window,
      'isolated-html',
      undefined,
      (element) => {
        if (element === draft || element === toggle) {
          throw new Error('computed style unavailable');
        }
        return {
          display: 'block',
          visibility: 'visible',
          getPropertyValue: () => 'none',
        } as unknown as CSSStyleDeclaration;
      },
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(port.messages[0]!.records.some(
      ({ nodeId: id }) => id === nodeId(draft) || id === nodeId(toggle),
    )).toBe(false);
    expect(port.messages[0]!.proofs.some(
      (proof) => 'nodeId' in proof &&
        (proof.nodeId === nodeId(draft) || proof.nodeId === nodeId(toggle)),
    )).toBe(false);
    expect(sensitiveReads).toBe(0);
    session.dispose();
  });

  it('carries public labels without touching withheld ordinary or personal values', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="query" type="text" aria-label="Search"><input id="email" type="email" aria-label="Email address"></body></html>',
    );
    for (const control of document.querySelectorAll<HTMLInputElement>('input')) {
      Object.defineProperty(control, 'value', {
        configurable: true,
        get: () => {
          throw new Error('withheld values must not be read');
        },
      });
    }
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart('isolated-html', identity, {
      ...FULL_VISIBLE_REPLICA_READ_SCOPE,
      formValues: false,
      personalDataValues: false,
    }));

    expect(port.messages[0]!.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'ordinary-form', gate: 'controlSemantics',
        presentation: 'label', text: 'Search',
      }),
      expect.objectContaining({
        category: 'personal', gate: 'controlSemantics',
        presentation: 'label', text: 'Email address',
      }),
    ]));
    expect(port.messages[0]!.records.some(
      ({ presentation }) => presentation === 'value',
    )).toBe(false);
    session.dispose();
  });

  it('shares sticky secret history across reconnects for one bridge document', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="secret" type="password"></body></html>',
    );
    const secret = document.querySelector<HTMLInputElement>('#secret')!;
    let reads = 0;
    Object.defineProperty(secret, 'value', {
      configurable: true,
      get: () => {
        reads += 1;
        return 'credential';
      },
    });
    const classifier = new StickySourceSecretClassifier();
    const firstPort = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const first = createSession(
      firstPort,
      document,
      window,
      'isolated-html',
      classifier,
    );
    firstPort.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(firstPort.messages[0]!.records).toEqual([]);
    first.dispose();

    secret.setAttribute('type', 'text');
    const secondPort = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const second = createSession(
      secondPort,
      document,
      window,
      'isolated-html',
      classifier,
    );
    secondPort.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(secondPort.messages[0]!.records).toEqual([]);
    expect(reads).toBe(0);
    second.dispose();
  });

  it('rejects ambiguous, non-activating, invalid, secret, and oversized disclosures', () => {
    const cases = [
      '<button aria-expanded="false" aria-controls="panel">Menu</button><div id="panel">visible closed leak</div>',
      '<div aria-expanded="false" aria-controls="panel">No controller</div><div id="panel">leak one</div>',
      '<button aria-expanded="false" aria-controls="panel">Menu</button><div id="panel">leak two</div><div id="panel">duplicate</div>',
      '<button aria-expanded="false" aria-haspopup="false" aria-controls="panel">Menu</button><div id="panel">leak three</div>',
      '<button aria-expanded="false" aria-controls="panel">Menu</button><div id="panel"><input type="password">leak four</div>',
      `<button aria-expanded="false" aria-controls="panel">Menu</button><div id="panel">${'<span>x</span>'.repeat(1_025)}</div>`,
    ];
    for (const markup of cases) {
      const { document, window } = parseHTML(`<html><body>${markup}</body></html>`);
      const port = new FakeSemanticPort(
        createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
      );
      const session = createSession(port, document, window);
      port.emit(createSemanticSourceStart(
        'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
      ));
      expect(port.messages[0]!.records.some(
        ({ gate }) => gate === 'disclosureContent',
      )).toBe(false);
      session.dispose();
    }
  });
});

const ids = new WeakMap<object, number>();
let nextId = 1;
function nodeId(node: object): number {
  let id = ids.get(node);
  if (!id) {
    id = nextId++;
    ids.set(node, id);
  }
  return id;
}

function createSession(
  port: FakeSemanticPort,
  sourceDocument: unknown,
  sourceWindow: unknown,
  bridge: 'isolated-html' = 'isolated-html',
  secretClassifier?: StickySourceSecretClassifier,
  getComputedStyle?: Window['getComputedStyle'],
  timers?: Array<() => void>,
  mutationHarness?: SemanticMutationHarness,
): SemanticSourceSession {
  return new SemanticSourceSession({
    port,
    document: sourceDocument as Document,
    window: {
      ...(sourceWindow as object),
      getComputedStyle: getComputedStyle ?? ((element: Element) => ({
          display: element.hasAttribute('hidden') ? 'none' : 'block',
          visibility: 'visible',
          getPropertyValue: () => 'none',
        }) as unknown as CSSStyleDeclaration),
    } as unknown as Window,
    bridge,
    ...(secretClassifier ? { secretClassifier } : {}),
    getNodeId: (node) => nodeId(node),
    createMutationObserver: (callback) => {
      if (mutationHarness) mutationHarness.callback = callback;
      return {
        observe: (target) => mutationHarness?.observed.push(target),
        disconnect: () => undefined,
      };
    },
    schedule: (callback) => callback(),
    setTimer: (callback) => {
      if (timers) timers.push(callback);
      return callback;
    },
    clearTimer: (timer) => {
      if (!timers) return;
      const index = timers.indexOf(timer as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
}

interface SemanticMutationHarness {
  readonly observed: Node[];
  callback?: MutationCallback;
}

function installPaintedTabFixture(
  document: Document,
  _window: Window,
): void {
  for (const element of [...document.querySelectorAll('*')]) {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => paintedRectList(),
    });
  }
}

function paintedRectList(): DOMRectList {
  const rect = {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 320,
    bottom: 40,
    width: 320,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect;
  return Object.assign([rect], {
    item: (index: number) => index === 0 ? rect : null,
  }) as unknown as DOMRectList;
}

function structuralMenuStyle(
  collapseFor: (
    element: Element,
  ) => 'display' | 'content-visibility' | 'opacity' | undefined,
): Window['getComputedStyle'] {
  return ((element: Element) => {
    const collapse = collapseFor(element);
    return {
      display: collapse === 'display' ? 'none' : 'block',
      visibility: 'visible',
      opacity: collapse === 'opacity' ? '0' : '1',
      overflowX: 'visible',
      overflowY: 'visible',
      getPropertyValue: (name: string) => {
        if (name === '-webkit-text-security') return 'none';
        if (name === 'content-visibility') {
          return collapse === 'content-visibility' ? 'hidden' : 'visible';
        }
        if (name === 'clip') return 'auto';
        if (name === 'clip-path') return 'none';
        if (name === 'overflow-x' || name === 'overflow-y') return 'visible';
        return '';
      },
    } as unknown as CSSStyleDeclaration;
  }) as Window['getComputedStyle'];
}

const tabFixtureComputedStyle = ((element: Element) => {
  const hidden = element.hasAttribute('hidden') ||
    element.getAttribute('aria-hidden')?.trim().toLowerCase() === 'true';
  return {
    display: hidden ? 'none' : 'block',
    visibility: 'visible',
    opacity: '1',
    getPropertyValue: (name: string) => {
      if (name === '-webkit-text-security') return 'none';
      if (name === 'content-visibility') return 'visible';
      if (name === 'clip') return 'auto';
      if (name === 'clip-path') return 'none';
      return '';
    },
  } as unknown as CSSStyleDeclaration;
}) as Window['getComputedStyle'];

function selectTab(document: Document, selected: 'a' | 'b'): void {
  for (const name of ['a', 'b'] as const) {
    const active = name === selected;
    const trigger = document.querySelector(`#tab-${name}`)!;
    const panel = document.querySelector(`#panel-${name}`)!;
    trigger.setAttribute('aria-selected', active ? 'true' : 'false');
    trigger.setAttribute('aria-expanded', active ? 'true' : 'false');
    panel.setAttribute('aria-hidden', active ? 'false' : 'true');
    if (active) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  }
}

class FakeSemanticPort implements SemanticSourcePort {
  readonly messages: SemanticSourceBatch[] = [];
  readonly #messageListeners = new Set<(message: unknown) => void>();
  readonly #disconnectListeners = new Set<() => void>();
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) =>
      this.#messageListeners.add(listener),
    removeListener: (listener: (message: unknown) => void) =>
      this.#messageListeners.delete(listener),
  };
  readonly onDisconnect = {
    addListener: (listener: () => void) => this.#disconnectListeners.add(listener),
    removeListener: (listener: () => void) =>
      this.#disconnectListeners.delete(listener),
  };
  disconnects = 0;

  constructor(readonly name: string) {}

  postMessage(message: SemanticSourceBatch): void {
    this.messages.push(message);
  }

  disconnect(): void {
    this.disconnects += 1;
  }

  emit(message: unknown): void {
    for (const listener of [...this.#messageListeners]) listener(message);
  }
}
