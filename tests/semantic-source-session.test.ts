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
import { SemanticSourceReceiver } from '../lib/replica/semantic-source-receiver';
import { StickySourceSecretClassifier } from '../lib/replica/source-secret-classifier';
import { hasSourceCredentialSecretAncestor } from '../lib/replica/source-privacy-policy';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';
import { installSourceShadowRootReader } from '../lib/replica/source-shadow-root';
import { closedRootReader } from './support/closed-shadow-roots';

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
    // The password's value is read only for its length (D91), after the
    // field is classified; the characters never reach a message.
    let secretReads = 0;
    Object.defineProperty(secret, 'value', {
      configurable: true,
      get: () => {
        secretReads += 1;
        return 'hunter22';
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
    expect(first.proofs.filter((proof) =>
      'nodeId' in proof && proof.nodeId === nodeId(secret))).toEqual([
      expect.objectContaining({ kind: 'masked-length', length: 8 }),
    ]);
    expect(JSON.stringify(port.messages)).not.toContain('hunter22');
    const readsBeforeTypeChange = secretReads;

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
    // Still a credential (sticky), but no longer drawn as dots: unread.
    expect(second.proofs.some((proof) =>
      'nodeId' in proof && proof.nodeId === nodeId(secret))).toBe(false);
    expect(secretReads).toBe(readsBeforeTypeChange);
    session.dispose();
  });

  it('sends only the length of a credential field, and follows typing (D91)', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="card" type="text" autocomplete="cc-number">' +
      '<input id="code" type="number" autocomplete="one-time-code">' +
      '<section autocomplete="one-time-code"><input id="inner" type="password"></section>' +
      '<input id="plain" type="text"></body></html>',
    );
    const card = document.querySelector<HTMLInputElement>('#card')!;
    const code = document.querySelector<HTMLInputElement>('#code')!;
    const inner = document.querySelector<HTMLInputElement>('#inner')!;
    card.value = '4111111111111111';
    code.value = '123456';
    inner.value = 'region secret';
    document.querySelector<HTMLInputElement>('#plain')!.value = 'plain draft';
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    const first = port.messages[0]!;
    // A number field cannot hold dots, and a field inside a credential region
    // is not drawn at all, so neither sends a length.
    expect(first.proofs.filter((proof) => proof.kind === 'masked-length'))
      .toEqual([expect.objectContaining({
        nodeId: nodeId(card), length: 16, revision: 1, gate: 'formValues',
      })]);
    expect(first.records.map((record) => record.text)).toEqual(['plain draft']);
    const sent = JSON.stringify(port.messages);
    for (const secret of ['4111', '123456', 'region secret']) {
      expect(sent).not.toContain(secret);
    }

    card.value = '41111';
    port.emit(createSemanticSourceAck(
      identity, first.policyFingerprint, first.sequence,
    ));
    session.refresh();
    expect(port.messages.at(-1)!.proofs.filter(
      (proof) => proof.kind === 'masked-length',
    )).toEqual([expect.objectContaining({ length: 5, revision: 2 })]);
    session.dispose();
  });

  it('reads no credential length without the form-values setting (D91)', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="pw" type="password"></body></html>',
    );
    const password = document.querySelector<HTMLInputElement>('#pw')!;
    let reads = 0;
    Object.defineProperty(password, 'value', {
      configurable: true,
      get: () => {
        reads += 1;
        return 'hunter22';
      },
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, PAGE_ONLY_REPLICA_READ_SCOPE,
    ));
    expect(port.messages.flatMap((message) => message.proofs)).toEqual([]);
    expect(reads).toBe(0);
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

  it('does not take a class change beside new content as masking (D75)', () => {
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
    )).toBe(false);
  });

  it('reads a value whose class flipped twice in one task (D75)', () => {
    const { document, window } = parseHTML(
      '<html><body><input id="otp" type="text"></body></html>',
    );
    const input = document.querySelector<HTMLInputElement>('#otp')!;
    const classifier = new StickySourceSecretClassifier();
    input.classList.add('is-focused');
    input.value = 'typed value';
    input.classList.remove('is-focused');
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
        oldValue: 'is-focused',
      } as unknown as MutationRecord,
    ], {
      getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
    } as unknown as Window, classifier);
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

    expect(port.messages[0]!.records.some((record) =>
      record.nodeId === nodeId(input) && record.presentation === 'value' &&
      record.text === 'typed value')).toBe(true);
    session.dispose();
  });

  it('reads a newly added control whose class changed once (D75)', () => {
    const { document } = parseHTML('<html><body></body></html>');
    const input = document.createElement('input') as HTMLInputElement;
    input.type = 'text';
    input.className = 'is-new';
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
        oldValue: 'is-new',
      } as unknown as MutationRecord,
    ], sourceWindow, classifier);

    expect(hasSourceCredentialSecretAncestor(
      input,
      classifier,
      sourceWindow,
    )).toBe(false);
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

  it('reads controls in closed shadow roots and only the length of their credentials (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-form id="form"></x-form></body></html>',
    );
    const reader = closedRootReader();
    const form = reader.attach(
      document.querySelector('#form')!,
      '<input id="name" value="visible draft"><x-vault id="vault"></x-vault>',
    );
    const vault = reader.attach(
      form.querySelector('#vault')!,
      '<input id="pin" type="password"><select id="choice"><option selected>Choice label</option></select>',
    );
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    const name = form.querySelector<HTMLInputElement>('#name')!;
    name.value = 'visible draft';
    const pin = vault.querySelector<HTMLInputElement>('#pin')!;
    let secretReads = 0;
    Object.defineProperty(pin, 'value', {
      configurable: true,
      get: () => {
        secretReads += 1;
        return 'hunter22';
      },
      set: () => undefined,
    });
    const select = vault.querySelector<HTMLSelectElement>('#choice')!;
    const option = select.options.item(0)!;
    Object.defineProperties(select, {
      selectedIndex: { configurable: true, get: () => 0 },
      selectedOptions: { configurable: true, get: () => [option] },
      multiple: { configurable: true, get: () => false },
    });
    Object.defineProperty(option, 'selected', { configurable: true, get: () => true });
    const mutationHarness: SemanticMutationHarness = { observed: [] };
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port, document, window, 'isolated-html',
      undefined, undefined, undefined, mutationHarness,
    );

    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    // Both closed roots are observed, the nested one too.
    expect(mutationHarness.observed).toEqual(expect.arrayContaining([
      document, form, vault,
    ]));
    const first = port.messages[0]!;
    expect(first.records.map((record) => record.text)).toContain('visible draft');
    expect(first.records.some((record) => record.nodeId === nodeId(pin))).toBe(false);
    expect(first.proofs.filter((proof) =>
      'nodeId' in proof && proof.nodeId === nodeId(pin))).toEqual([
      expect.objectContaining({ kind: 'masked-length', length: 8 }),
    ]);
    expect(first.proofs).toContainEqual(expect.objectContaining({
      kind: 'select-presentation',
      nodeId: nodeId(select),
    }));
    expect(JSON.stringify(port.messages)).not.toContain('hunter22');
    expect(secretReads).toBeGreaterThan(0);

    // A password field added later in the nested closed root.
    port.emit(createSemanticSourceAck(identity, first.policyFingerprint, first.sequence));
    const late = document.createElement('input');
    late.setAttribute('type', 'password');
    Object.defineProperty(late, 'value', {
      configurable: true,
      get: () => 'late-secret-99',
      set: () => undefined,
    });
    vault.append(late);
    mutationHarness.callback?.([{
      type: 'childList', target: vault, addedNodes: [late], removedNodes: [],
    } as unknown as MutationRecord], {} as MutationObserver);
    const second = port.messages.at(-1)!;
    expect(second.proofs.filter((proof) =>
      'nodeId' in proof && proof.nodeId === nodeId(late))).toEqual([
      expect.objectContaining({ kind: 'masked-length', length: 14 }),
    ]);
    expect(JSON.stringify(port.messages)).not.toContain('late-secret-99');
    session.dispose();
  });

  it('primes the credential ledger inside closed shadow roots (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><x-form id="form"></x-form><main id="page"></main></body></html>',
    );
    const reader = closedRootReader();
    const form = reader.attach(document.querySelector('#form')!, '<x-vault id="vault"></x-vault>');
    const vault = reader.attach(
      form.querySelector('#vault')!,
      '<input id="pin" type="password"><section id="otp" autocomplete="one-time-code"><b id="digit">1</b></section>',
    );
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    const classifier = new StickySourceSecretClassifier();

    eagerlyClassifySourceDocumentSecrets(
      document as unknown as Document,
      window as unknown as Window,
      classifier,
    );

    expect(classifier.isSecret(vault.querySelector('#pin')!)).toBe(true);
    expect(classifier.isSecret(vault.querySelector('#digit')!)).toBe(true);
    expect(classifier.isSecret(form.querySelector('#vault')!)).toBe(false);

    // A host inserted with its closed root already attached.
    const added = document.createElement('x-added');
    const addedRoot = reader.attach(added, '<input id="late" autocomplete="cc-number">');
    document.querySelector('#page')!.append(added);
    rememberSourceMutationSecrets([{
      type: 'childList',
      target: document.querySelector('#page')!,
      addedNodes: [added],
      removedNodes: [],
    } as unknown as MutationRecord], window as unknown as Window, classifier);
    expect(classifier.isSecret(addedRoot.querySelector('#late')!)).toBe(true);
  });

  it('treats a disclosure panel as able to hold user input when a closed root in it does (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><button aria-expanded="false" aria-controls="menu">Menu</button>' +
        '<div id="menu" hidden><x-field id="field"></x-field>Account notices</div></body></html>',
    );
    const reader = closedRootReader();
    reader.attach(document.querySelector('#field')!, '<input value="panel draft">');
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html',
      identity,
      { ...FULL_VISIBLE_REPLICA_READ_SCOPE, controlSemantics: false },
    ));

    const first = port.messages[0]!;
    expect(first.proofs.some((proof) => proof.kind === 'disclosure-state')).toBe(false);
    expect(first.records.map((record) => record.text)).not.toContain('Account notices');
    session.dispose();
  });

  it('reads the text of a closed root inside a validated disclosure (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><button aria-expanded="true" aria-controls="menu">Menu</button>' +
        '<div id="menu"><x-notice id="notice"></x-notice></div></body></html>',
    );
    const reader = closedRootReader();
    reader.attach(document.querySelector('#notice')!, '<p>Closed root notice</p>');
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html',
      identity,
      { ...FULL_VISIBLE_REPLICA_READ_SCOPE, controlSemantics: false },
    ));

    expect(port.messages[0]!.proofs.some((proof) => proof.kind === 'disclosure-state'))
      .toBe(true);
    expect(port.messages[0]!.records.map((record) => record.text))
      .toContain('Closed root notice');
    session.dispose();
  });

  it('treats a tab panel as able to hold user input when a closed root in it does (D125)', () => {
    const { document, window } = parseHTML(`
      <html><body><div role="tablist">
        <div id="tab-a" role="tab" aria-selected="true" aria-expanded="true"
          aria-controls="panel-a">A</div>
        <div id="tab-b" role="tab" aria-selected="false" aria-expanded="false"
          aria-controls="panel-b">B</div>
      </div>
      <section id="panel-a" role="tabpanel" aria-hidden="false">Active news<x-field id="field"></x-field></section>
      <section id="panel-b" role="tabpanel" aria-hidden="true" hidden>Inactive news</section>
      </body></html>
    `);
    installPaintedTabFixture(document, window as unknown as Window);
    const reader = closedRootReader();
    reader.attach(document.querySelector('#field')!, '<input value="tab draft">');
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port, document, window, 'isolated-html', undefined, tabFixtureComputedStyle,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    const panelA = nodeId(document.querySelector('#panel-a')!);
    expect(port.messages[0]!.proofs.some((proof) =>
      proof.kind === 'tab-state' && proof.panelNodeId === panelA)).toBe(false);
    session.dispose();
  });

  it('remembers what a closed root held when its host left a credential region (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><section id="otp" autocomplete="one-time-code"><x-digit id="digit"></x-digit></section></body></html>',
    );
    const reader = closedRootReader();
    const digit = document.querySelector('#digit')!;
    const root = reader.attach(digit, '<b id="inner">7</b>');
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    const classifier = new StickySourceSecretClassifier();
    const region = document.querySelector('#otp')!;

    digit.remove();
    rememberSourceMutationSecrets([{
      type: 'childList', target: region, addedNodes: [], removedNodes: [digit],
    } as unknown as MutationRecord], window as unknown as Window, classifier);

    expect(classifier.isSecret(digit)).toBe(true);
    expect(classifier.isSecret(root.querySelector('#inner')!)).toBe(true);
  });

  it('reads the page again before sending a value under a closed root attached since (D125)', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="host"><input id="field"></div><p>page</p></body></html>',
    );
    const reader = closedRootReader();
    installSourceShadowRootReader(document as unknown as Document, reader.read);
    const host = document.querySelector('#host')!;
    const field = document.querySelector<HTMLInputElement>('#field')!;
    field.value = 'typed before';
    // Chrome reads null from `assignedSlot` for a node slotted into a closed root.
    Object.defineProperty(field, 'assignedSlot', { configurable: true, value: null });
    const masking = ((element: Element) => ({
      display: 'block',
      visibility: 'visible',
      getPropertyValue: (name: string) =>
        name === '-webkit-text-security' && element.classList.contains('mask')
          ? 'disc'
          : 'none',
    })) as unknown as Window['getComputedStyle'];
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window, 'isolated-html', undefined, masking);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const first = port.messages[0]!;
    expect(first.records.map((record) => record.text)).toContain('typed before');
    port.emit(createSemanticSourceAck(identity, first.policyFingerprint, first.sequence));

    // A closed root wraps the field in a masking box; nothing fires. The
    // value then changes: the root is asked about before it is sent.
    reader.attach(host, '<div class="mask"><slot></slot></div>');
    field.value = 'typed-secret-51';
    session.refresh();

    expect(JSON.stringify(port.messages)).not.toContain('typed-secret-51');
    expect(reader.calls).toContain(host);
    session.dispose();
  });

  it('reads no computed style for an attribute change that cannot be credential evidence (D125)', () => {
    const { document } = parseHTML(
      '<html><body><x-card id="card"><input id="field" type="text"></x-card></body></html>',
    );
    let reads = 0;
    const sourceWindow = {
      getComputedStyle: () => {
        reads += 1;
        return { getPropertyValue: () => 'none' };
      },
    } as unknown as Window;
    const classifier = new StickySourceSecretClassifier();
    const card = document.querySelector('#card')!;
    const field = document.querySelector('#field')!;
    const change = (target: Element, attributeName: string, oldValue: string) =>
      ({ type: 'attributes', target, attributeName, oldValue }) as unknown as MutationRecord;

    // An animation, a class, a data attribute: no style is read.
    card.setAttribute('style', 'transform: rotate(2deg)');
    rememberSourceMutationSecrets([
      change(card, 'style', 'transform: rotate(1deg)'),
      change(card, 'class', 'a'),
      change(card, 'data-frame', '1'),
    ], sourceWindow, classifier);
    expect(reads).toBe(0);

    // A type that was password, and inline masking, are read as before.
    field.setAttribute('type', 'text');
    rememberSourceMutationSecrets([change(field, 'type', 'password')], sourceWindow, classifier);
    expect(reads).toBe(1);
    expect(classifier.isSecret(field)).toBe(true);
    card.setAttribute('style', 'color: red');
    rememberSourceMutationSecrets(
      [change(card, 'style', '-webkit-text-security: disc')],
      sourceWindow,
      classifier,
    );
    expect(reads).toBe(2);
    expect(classifier.isSecret(card)).toBe(true);
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

    // A class change carries no credential evidence, so the sticky secret
    // ledger reads no style for it (D125); the full semantic scan would read
    // more.
    expect(styleReads).toBe(0);
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

  it('infers a navigation menu whose panel holds more text than one record may (D134)', () => {
    // A large site menu: 150 links, 5,000 characters and more in all.
    const links = Array.from({ length: 150 }, (_, index) =>
      `<a href="/section-${index}">Section ${index} of the product catalogue</a>`).join('');
    const { document, window } = parseHTML(`<html><body><nav>
      <div id="wrapper"><a id="trigger" href="/library">Resources</a>
        <div id="panel" class="collapsed">${links}</div>
      </div></nav></body></html>`);
    expect(document.querySelector('#panel')!.textContent!.length).toBeGreaterThan(5_000);
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
      triggerNodeId: nodeId(document.querySelector('#trigger')!),
      panelNodeId: nodeId(document.querySelector('#panel')!),
      expanded: false,
    }));
    const menuText = batch.records.filter((record) =>
      record.gate === 'disclosureContent').map((record) => record.text);
    expect(menuText).toHaveLength(150);
    expect(menuText).toContain('Section 149 of the product catalogue');
    session.dispose();
  });

  it('takes a large hidden block beside a link for a menu only when it is made of links (D134)', () => {
    const prose = 'The council met on the quay and voted on the registers of the town hall. '
      .repeat(80);
    const few = '<a href="/more">Read more</a>';
    const links = (count: number) => Array.from({ length: count }, (_, index) =>
      `<a href="/section-${index}">Section ${index} of the product catalogue</a>`).join('');
    const offered = (panel: string) => {
      const { document, window } = parseHTML(`<html><body><ul>
        <li id="wrapper"><a id="trigger" href="/story">Headline</a>
          <div id="panel" class="collapsed">${panel}</div>
        </li></ul></body></html>`);
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
      const result = {
        menu: batch.proofs.some((proof) => proof.kind === 'structural-menu'),
        hiddenText: batch.records.filter((record) => record.gate === 'disclosureContent').length,
      };
      session.dispose();
      return result;
    };
    // An article's text hidden beside its headline: 6,000 characters of
    // prose and one link. No menu, and none of it travels.
    expect(prose.length).toBeGreaterThan(5_000);
    expect(offered(`<p>${prose}</p>${few}`)).toEqual({ menu: false, hiddenText: 0 });
    // A short hidden block was a menu before, and is.
    expect(offered(`<p>${prose.slice(0, 600)}</p>${few}`).menu).toBe(true);
    // Mostly links: a menu, whatever its size.
    expect(offered(links(150)).menu).toBe(true);
    expect(offered(`<p>${prose.slice(0, 1_500)}</p>${links(150)}`).menu).toBe(true);
    // Mostly prose with many links in it: not one.
    expect(offered(`<p>${prose}</p>${links(40)}`).menu).toBe(false);
    // A button inside a link counts once.
    const nested = Array.from({ length: 150 }, (_, index) =>
      `<a href="/s-${index}"><button>Section ${index} of the product catalogue</button></a>`)
      .join('');
    expect(offered(`<p>${prose.slice(0, 4_000)}</p>${nested}`).menu).toBe(true);
    expect(offered(`<p>${prose}</p>${nested}`).menu).toBe(false);
  });

  it('infers a navigation menu whose trigger carries its own plain aria-expanded', () => {
    // freee's header: the button carries aria-expanded and aria-haspopup but
    // no aria-controls, and its menu is the sibling the page script opens.
    const markup = (expanded: string) => `<html><body><nav>
      <div id="wrapper"><button id="trigger" aria-expanded="${expanded}"
        aria-haspopup="menu">Products</button>
        <div id="panel" class="collapsed"><a href="/books">Accounting</a></div>
      </div></nav></body></html>`;
    for (const [expanded, proven] of [['false', true], ['maybe', false]] as const) {
      const { document, window } = parseHTML(markup(expanded));
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
      expect(port.messages[0]!.proofs.some((proof) =>
        proof.kind === 'structural-menu' &&
        proof.triggerNodeId === nodeId(document.querySelector('#trigger')!)))
        .toBe(proven);
      session.dispose();
    }
  });

  it.each([
    [
      'a header list item whose heading is an anchor without href (CSS :hover)',
      `<header><ul><li id="wrapper"><a id="trigger">Transfers</a>
        <ul id="panel" class="collapsed"><li><a>One-off transfer</a></li></ul>
      </li></ul></header>`,
      'visibility',
    ],
    [
      'a navigation list item whose heading is a span (a scripted mega menu)',
      `<nav><ul><li id="wrapper"><span id="trigger">Deposits</span>
        <div id="panel" class="collapsed"><a href="/yen">One-off transfer</a></div>
      </li></ul></nav>`,
      'display',
    ],
    [
      'a list item outside navigation',
      `<main><ul><li id="wrapper"><span id="trigger">More</span>
        <ul id="panel" class="collapsed"><li><a href="/faq">One-off transfer</a></li></ul>
      </li></ul></main>`,
      'opacity',
    ],
  ] as const)('infers a hover menu in %s (D82)', (_, body, collapse) => {
    const { document, window } = parseHTML(`<html><body>${body}</body></html>`);
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
        element.classList.contains('collapsed') ? collapse : undefined),
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));

    expect(port.messages[0]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'structural-menu',
      containerNodeId: nodeId(document.querySelector('#wrapper')!),
      triggerNodeId: nodeId(document.querySelector('#trigger')!),
      panelNodeId: nodeId(document.querySelector('#panel')!),
      expanded: false,
    }));
    expect(port.messages[0]!.records).toContainEqual(expect.objectContaining({
      text: 'One-off transfer',
      gate: 'disclosureContent',
    }));
    session.dispose();
  });

  it.each([
    [
      'a plain wrapper outside navigation, a header or a list',
      `<main><div id="wrapper"><span id="trigger">Note</span>
        <div id="panel" class="collapsed">Details</div></div></main>`,
    ],
    [
      'a wrapper around a real button (the button is the trigger)',
      `<nav><ul><li id="wrapper"><div id="trigger"><button>Products</button></div>
        <div id="panel" class="collapsed"><a href="/books">Accounting</a></div>
      </li></ul></nav>`,
    ],
    [
      'a hidden mobile-only link beside the heading (freee)',
      `<nav><div id="wrapper"><span id="trigger">Tax advisers</span>
        <a id="panel" class="collapsed" href="/tax">Tax advisers</a></div></nav>`,
    ],
  ] as const)('does not infer a menu from %s (D82)', (_, body) => {
    const { document, window } = parseHTML(`<html><body>${body}</body></html>`);
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

    expect(port.messages[0]!.proofs.some((proof) =>
      proof.kind === 'structural-menu' &&
      proof.triggerNodeId === nodeId(document.querySelector('#trigger')!)))
      .toBe(false);
    session.dispose();
  });

  it.each([
    [
      'a link, an arrow button and a list',
      `<nav><ul><li id="wrapper"><a id="trigger" href="/shop">Shop</a>
        <button id="arrow" aria-label="Open submenu"></button>
        <ul id="panel" class="collapsed"><li><a href="/a">Alpha</a></li></ul>
      </li></ul></nav>`,
    ],
    [
      'a panel with a search box',
      `<nav><ul><li id="wrapper"><a id="trigger" href="/shop">Shop</a>
        <div id="panel" class="collapsed"><input type="search" placeholder="Search">
          <a href="/a">Alpha</a></div>
      </li></ul></nav>`,
    ],
    [
      'a panel with a dropdown',
      `<nav><ul><li id="wrapper"><a id="trigger" href="/shop">Shop</a>
        <div id="panel" class="collapsed"><a href="/a">Alpha</a>
          <select><option>English</option></select></div>
      </li></ul></nav>`,
    ],
    [
      'a button and a list outside navigation, a header or a list',
      `<main><div id="wrapper"><button id="trigger">Row actions</button>
        <ul id="panel" class="collapsed"><li><a href="/a">Alpha</a></li></ul>
      </div></main>`,
    ],
  ] as const)('infers a menu from %s (D132)', (_, body) => {
    const { document, window } = parseHTML(`<html><body>${body}</body></html>`);
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
    // One proof, naming the first trigger; the shape says the rest.
    expect(batch.proofs.filter((proof) => proof.kind === 'structural-menu'))
      .toEqual([expect.objectContaining({
        containerNodeId: nodeId(document.querySelector('#wrapper')!),
        triggerNodeId: nodeId(document.querySelector('#trigger')!),
        panelNodeId: nodeId(document.querySelector('#panel')!),
      })]);
    const menuText = batch.records.filter((record) =>
      record.gate === 'disclosureContent').map((record) => record.text);
    expect(menuText).toEqual(['Alpha']);
    // An option's text is its label, never menu text.
    expect(batch.records.filter((record) => record.presentation === 'text')
      .map((record) => record.text)).not.toContain('English');
    session.dispose();
  });

  it('reads the labels of a dropdown in a menu\'s collapsed panel, and of none hidden elsewhere', () => {
    // The mirror may open the panel for the reader, and drew no dropdown in
    // it: its options had no labels until the page itself showed the menu.
    const prose = 'The council met on the quay and voted on the registers of the town hall. '
      .repeat(80);
    const page = (scope: typeof FULL_VISIBLE_REPLICA_READ_SCOPE) => {
      const { document, window } = parseHTML(`<html><body><form>
        <nav><ul><li id="wrapper"><a id="trigger" href="/shop">Shop</a>
          <div id="panel" class="collapsed"><a href="/a">Alpha</a>
            <select id="pick"><option id="en">English</option>
              <option id="ja" selected>Japanese</option><option hidden>Gone</option></select>
            <div class="collapsed"><select><option>Buried</option></select></div>
          </div></li></ul></nav>
        <div class="collapsed"><select><option>Elsewhere</option></select></div>
        <ul><li><a href="/story">Headline</a>
          <div class="collapsed"><p>${prose}</p><select><option>Unread</option></select></div>
        </li></ul></form></body></html>`);
      installPaintedTabFixture(document, window as unknown as Window);
      // In Chrome nothing under `display: none` has a box.
      for (const element of document.querySelectorAll('.collapsed *')) {
        Object.defineProperty(element, 'getClientRects', {
          configurable: true,
          value: () => Object.assign([], { item: () => null }) as DOMRectList,
        });
      }
      const pick = document.querySelector<HTMLSelectElement>('#pick')!;
      const ja = document.querySelector<HTMLOptionElement>('#ja')!;
      Object.defineProperties(pick, {
        selectedOptions: { configurable: true, value: [ja] },
        multiple: { configurable: true, value: false },
      });
      const style = structuralMenuStyle((element) =>
        element.classList.contains('collapsed') ? 'display' : undefined);
      // The label rules ask the page's own window and name `Node`.
      Object.defineProperty(window, 'getComputedStyle', {
        configurable: true,
        value: style,
      });
      const globalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
      Object.defineProperty(globalThis, 'Node', {
        configurable: true,
        writable: true,
        value: (window as unknown as { Node: typeof Node }).Node,
      });
      const port = new FakeSemanticPort(
        createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
      );
      const session = createSession(
        port, document, window, 'isolated-html', undefined, style,
      );
      let batch: SemanticSourceBatch;
      try {
        port.emit(createSemanticSourceStart('isolated-html', identity, scope));
        batch = port.messages[0]!;
      } finally {
        session.dispose();
        if (globalNode) Object.defineProperty(globalThis, 'Node', globalNode);
        else delete (globalThis as { Node?: unknown }).Node;
      }
      return {
        menus: batch.proofs.filter((proof) => proof.kind === 'structural-menu').length,
        labels: batch.records.filter((record) => record.presentation === 'label' &&
          record.tagName === 'option').map((record) => record.text),
        selected: batch.proofs.flatMap((proof) => proof.kind === 'select-state' &&
          proof.nodeId === nodeId(pick) ? [proof.selectedOptionNodeIds] : []),
        selection: batch.records.filter((record) =>
          record.presentation === 'selection').map((record) => record.text),
        ja: nodeId(ja),
      };
    };
    const full = page(FULL_VISIBLE_REPLICA_READ_SCOPE);
    expect(full.menus).toBe(1);
    // Not the option the page hides, the dropdown in a block that stays
    // hidden, the one in a hidden block that is no menu, nor the one beside
    // an article's hidden text.
    expect(full.labels).toEqual(['English', 'Japanese']);
    expect(full.selected).toEqual([[full.ja]]);
    expect(full.selection).toEqual(['Japanese']);
    // Standard reads labels and menus, and no choice.
    const standard = page(STANDARD_REPLICA_READ_SCOPE);
    expect(standard.labels).toEqual(['English', 'Japanese']);
    expect(standard.selected).toEqual([]);
    expect(standard.selection).toEqual([]);
    // Where no menu is offered, nothing in its panel is read.
    const noMenus = page({ ...FULL_VISIBLE_REPLICA_READ_SCOPE, disclosureContent: false });
    expect(noMenus).toMatchObject({ menus: 0, labels: [], selected: [], selection: [] });
    expect(page(PAGE_ONLY_REPLICA_READ_SCOPE))
      .toMatchObject({ menus: 0, labels: [], selected: [], selection: [] });
  });

  it('reads a dropdown by the page\'s own rule again once the page shows the panel', () => {
    // Collapsed, the panel is read as the mirror opens it, and the mirror
    // shows what a fade hides in it. Shown by the page, it is the page that
    // says what is hidden.
    const { document, window } = parseHTML(`<html><body><form>
      <nav><ul><li id="wrapper"><a id="trigger" href="/shop">Shop</a>
        <div id="panel"><a href="/a">Alpha</a>
          <select id="plain"><option>Plain</option></select>
          <div id="veiled"><select><option>Veiled</option></select></div>
          <select id="own"><option>Own</option></select>
        </div></li></ul></nav></form></body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const panel = document.querySelector('#panel')!;
    // A block that fades in once the menu is open, and a dropdown the page
    // hides by a `visibility` of its own.
    const veiled = document.querySelector('#veiled')!;
    const own = document.querySelector('#own')!;
    let collapsed = true;
    for (const select of document.querySelectorAll('select')) {
      Object.defineProperties(select, {
        // In Chrome nothing under `display: none` has a box.
        getClientRects: {
          configurable: true,
          value: () => collapsed
            ? Object.assign([], { item: () => null }) as DOMRectList
            : paintedRectList(),
        },
        getBoundingClientRect: {
          configurable: true,
          value: () => ({ left: 0, top: 0, right: 320, bottom: 40, width: 320, height: 40 }),
        },
        selectedOptions: { configurable: true, value: [] },
        multiple: { configurable: true, value: false },
      });
    }
    const base = structuralMenuStyle((element) =>
      element === panel && collapsed
        ? 'display'
        : element === veiled || element === own ? 'visibility' : undefined);
    // What the mirror's own answer for a dropdown reads besides.
    const style = ((element: Element) => ({
      ...base(element),
      position: 'static', overflow: 'visible', width: 'auto', height: 'auto',
      left: 'auto', top: 'auto', transform: 'none', clip: 'auto', clipPath: 'none',
    })) as unknown as Window['getComputedStyle'];
    Object.defineProperty(window, 'getComputedStyle', { configurable: true, value: style });
    const globalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
    Object.defineProperty(globalThis, 'Node', {
      configurable: true,
      writable: true,
      value: (window as unknown as { Node: typeof Node }).Node,
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window, 'isolated-html', undefined, style);
    const labels = (batch: SemanticSourceBatch) => batch.records.filter((record) =>
      record.presentation === 'label' && record.tagName === 'option')
      .map((record) => record.text);
    try {
      port.emit(createSemanticSourceStart(
        'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
      ));
      const first = port.messages[0]!;
      expect(first.proofs).toContainEqual(expect.objectContaining({
        kind: 'structural-menu', expanded: false,
      }));
      // The dropdown the page hides by its own rule is unread from the
      // start: the mirror does not draw it in the menu it opens.
      expect(labels(first)).toEqual(['Plain', 'Veiled']);

      collapsed = false;
      port.emit(createSemanticSourceAck(
        identity, first.policyFingerprint, first.sequence,
      ));
      session.refresh();
      const second = port.messages[1]!;
      expect(second.proofs).toContainEqual(expect.objectContaining({
        kind: 'structural-menu', expanded: true,
      }));
      expect(labels(second)).toEqual(['Plain']);
    } finally {
      session.dispose();
      if (globalNode) Object.defineProperty(globalThis, 'Node', globalNode);
      else delete (globalThis as { Node?: unknown }).Node;
    }
  });

  it.each([
    [
      'a credential field in the panel',
      `<nav><ul><li id="wrapper"><a id="trigger" href="/in">Sign in</a>
        <div id="panel" class="collapsed"><input type="password">
          <a href="/a">Alpha</a></div>
      </li></ul></nav>`,
    ],
    [
      'a button beside a block outside navigation (an accordion, a dialog)',
      `<main><div id="wrapper"><button id="trigger">Section</button>
        <div id="panel" class="collapsed"><a href="/a">Alpha</a></div>
      </div></main>`,
    ],
    [
      'a link, an arrow button and a list outside navigation',
      `<main><div id="wrapper"><a id="trigger" href="/shop">Shop</a>
        <button id="arrow">v</button>
        <ul id="panel" class="collapsed"><li><a href="/a">Alpha</a></li></ul>
      </div></main>`,
    ],
    [
      'three triggers',
      `<nav><ul><li id="wrapper"><a id="trigger" href="/shop">Shop</a>
        <button>v</button><button>w</button>
        <ul id="panel" class="collapsed"><li><a href="/a">Alpha</a></li></ul>
      </li></ul></nav>`,
    ],
  ] as const)('does not infer a menu from %s (D132)', (_, body) => {
    const { document, window } = parseHTML(`<html><body>${body}</body></html>`);
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
    expect(port.messages[0]!.proofs.some((proof) =>
      proof.kind === 'structural-menu')).toBe(false);
    expect(port.messages[0]!.records.map((record) => record.text))
      .not.toContain('Alpha');
    session.dispose();
  });

  it('reports a hover menu open while the source page shows it (D82)', () => {
    // A CSS :hover menu changes no DOM on the page; only the painted state of
    // its panel tells the replica to show it.
    const { document, window } = parseHTML(`<html><body><header><ul>
      <li id="wrapper"><a id="trigger">Transfers</a>
        <ul id="panel"><li><a>One-off transfer</a></li></ul></li>
      </ul></header></body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const panel = document.querySelector('#panel')!;
    let hovered = false;
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
        element === panel && !hovered ? 'visibility' : undefined),
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const first = port.messages[0]!.proofs.find(
      (proof) => proof.kind === 'structural-menu',
    );
    expect(first).toEqual(expect.objectContaining({ expanded: false }));

    hovered = true;
    port.emit(createSemanticSourceAck(
      identity,
      port.messages[0]!.policyFingerprint,
      port.messages[0]!.sequence,
    ));
    session.refresh();
    expect(port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'structural-menu',
      relationId: first?.kind === 'structural-menu' ? first.relationId : '',
      expanded: true,
    }));
    session.dispose();
  });

  it('reads a menu again when its fade-out ends (D132)', () => {
    // The page closes a menu that fades out: when that change is read the
    // panel is still painted, and nothing in the DOM changes once the
    // transition is over. The mirror kept the menu open.
    const { document, window } = parseHTML(`<html><body><main>
      <div id="wrapper"><button id="trigger">Row actions</button>
        <ul id="panel"><li><a href="/a">Alpha</a></li></ul></div>
      </main></body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const panel = document.querySelector('#panel')!;
    let painted = false;
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
        element === panel && !painted ? 'visibility' : undefined),
    );
    const acknowledge = (): void => {
      const last = port.messages.at(-1)!;
      port.emit(createSemanticSourceAck(
        identity, last.policyFingerprint, last.sequence,
      ));
    };
    const expanded = (): boolean | undefined => {
      const proof = port.messages.at(-1)!.proofs.find((candidate) =>
        candidate.kind === 'structural-menu');
      return proof?.kind === 'structural-menu' ? proof.expanded : undefined;
    };
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(expanded()).toBe(false);

    painted = true;
    acknowledge();
    session.refresh();
    expect(expanded()).toBe(true);

    // The class that closes it is gone; the panel is still fading.
    acknowledge();
    session.refresh();
    expect(port.messages).toHaveLength(2);
    painted = false;
    panel.dispatchEvent(new (window as unknown as Window & typeof globalThis)
      .Event('transitionend', { bubbles: true }));
    expect(port.messages).toHaveLength(3);
    expect(expanded()).toBe(false);

    // A transition that ends elsewhere on the page reads nothing.
    acknowledge();
    document.querySelector('main')!.dispatchEvent(
      new (window as unknown as Window & typeof globalThis)
        .Event('transitionend', { bubbles: true }),
    );
    expect(port.messages).toHaveLength(3);
    session.dispose();
  });

  it('sends no disabled-state proof for a plain link and sends it after menu proofs', () => {
    const { document, window } = parseHTML(`<html><body>
      <a id="link" href="/about">About</a><button id="button">Go</button>
      <nav><div id="wrapper"><button id="trigger">Products</button>
        <div id="panel" class="collapsed"><a href="/books">Accounting</a></div>
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

    const proofs = port.messages[0]!.proofs;
    const controlStates = proofs.filter((proof) => proof.kind === 'control-state');
    expect(controlStates.map((proof) =>
      proof.kind === 'control-state' ? proof.nodeId : 0)).not.toContain(
      nodeId(document.querySelector('#link')!),
    );
    expect(controlStates.map((proof) =>
      proof.kind === 'control-state' ? proof.nodeId : 0)).toContain(
      nodeId(document.querySelector('#button')!),
    );
    const menuIndex = proofs.findIndex((proof) => proof.kind === 'structural-menu');
    expect(menuIndex).toBeGreaterThanOrEqual(0);
    expect(menuIndex).toBeLessThan(
      proofs.findIndex((proof) => proof.kind === 'control-state'),
    );
    session.dispose();
  });

  it('produces batches the receiver accepts on a page with links, a select and a menu', () => {
    // Before D62 every plain link carried a disabled-state proof the receiver
    // refuses, and one refused proof drops the whole batch: no option labels,
    // menus or tab states reached the replica on a real page.
    const markup = (stripped: boolean) => `<html><body>
      <a id="link" href="/about">About</a><button id="button">Go</button>
      <select id="lang"><option>English</option><option>Deutsch</option></select>
      <select id="stated"${stripped ? '' : ' role="combobox"'}><option>Français</option></select>
      <select id="widget" role="button"><option>Withheld</option></select>
      <nav><div id="wrapper"><button id="trigger"${stripped
        ? ''
        : ' aria-expanded="false" aria-haspopup="menu"'}>Products</button>
        <div id="panel" class="collapsed"><a href="/books">Accounting</a></div>
      </div></nav></body></html>`;
    const source = parseHTML(markup(false));
    // The replica is the sanitized page: private ARIA state is stripped.
    const replica = parseHTML(markup(true));
    installPaintedTabFixture(source.document, source.window as unknown as Window);
    const style = structuralMenuStyle((element) =>
      element.classList.contains('collapsed') ? 'display' : undefined);
    // Option labels are read through the page's own window and need a box.
    const pageStyle = Object.getOwnPropertyDescriptor(
      source.window,
      'getComputedStyle',
    );
    const globalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
    Object.defineProperty(globalThis, 'Node', {
      configurable: true,
      writable: true,
      value: (source.window as unknown as { Node: typeof Node }).Node,
    });
    Object.defineProperty(source.window, 'getComputedStyle', {
      configurable: true,
      value: style,
    });
    for (const id of ['#lang', '#stated', '#widget']) {
      Object.defineProperty(source.document.querySelector(id), 'getBoundingClientRect', {
        configurable: true,
        value: () => ({ left: 0, top: 0, right: 120, bottom: 24, width: 120, height: 24 }),
      });
    }
    const mirrored = new Map<number, Node>();
    const pair = (from: Node, to: Node): void => {
      mirrored.set(nodeId(from), to);
      const fromChildren = [...from.childNodes];
      const toChildren = [...to.childNodes];
      fromChildren.forEach((child, index) => {
        if (toChildren[index]) pair(child, toChildren[index]!);
      });
    };
    pair(source.document.documentElement, replica.document.documentElement);
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port,
      source.document,
      source.window,
      'isolated-html',
      undefined,
      style,
    );
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const receiver = new SemanticSourceReceiver({
      document: identity,
      replicaDocument: replica.document as unknown as Document,
      resolveNode: (id) => mirrored.get(id),
    });

    try {
      expect(receiver.applyBatch(port.messages[0]!)).toBeDefined();
      // A select that states its own implicit `combobox` role reads like a
      // plain one (D98); any other activation role still withholds labels.
      expect([...replica.document.querySelectorAll('option')].map((option) =>
        option.getAttribute('label'))).toEqual(['English', 'Deutsch', 'Français', null]);
    } finally {
      session.dispose();
      if (pageStyle) {
        Object.defineProperty(source.window, 'getComputedStyle', pageStyle);
      } else {
        delete (source.window as { getComputedStyle?: unknown }).getComputedStyle;
      }
      if (globalNode) Object.defineProperty(globalThis, 'Node', globalNode);
      else delete (globalThis as { Node?: unknown }).Node;
    }
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

  it.each([
    ['faded out', 'opacity'],
    ['of no size and clipping', 'clip'],
  ] as const)(
    'rejects a structural menu beneath a flat-tree ancestor that is %s',
    (_name, how) => {
      const { document, window } = parseHTML(`<html><body><section id="outer"><nav>
        <div id="wrapper"><button id="trigger">Resources</button>
          <div id="panel"><a href="/school">Startup School</a></div>
        </div></nav></section></body></html>`);
      installPaintedTabFixture(document, window as unknown as Window);
      const outer = document.querySelector('#outer')!;
      const panel = document.querySelector('#panel')!;
      if (how === 'clip') {
        Object.defineProperty(outer, 'getClientRects', {
          configurable: true,
          value: () => Object.assign([], { item: () => null }) as DOMRectList,
        });
      }
      const style = structuralMenuStyle((element) =>
        element === panel
          ? 'display'
          : element === outer && how === 'opacity' ? 'opacity' : undefined);
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
          const computed = style(element);
          if (element !== outer || how !== 'clip') return computed;
          return {
            ...computed,
            overflowX: 'hidden',
            overflowY: 'hidden',
            getPropertyValue: (name: string) =>
              name === 'overflow-x' || name === 'overflow-y'
                ? 'hidden'
                : computed.getPropertyValue(name),
          };
        }) as Window['getComputedStyle'],
      );

      port.emit(createSemanticSourceStart(
        'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
      ));
      expect(port.messages[0]!.proofs.some((proof) =>
        proof.kind === 'structural-menu')).toBe(false);
      expect(port.messages[0]!.records.map((record) => record.text))
        .not.toContain('Startup School');
      session.dispose();
    },
  );

  it('offers a structural menu inside an ancestor of no height that clips nothing (D135)', () => {
    // A header of no height whose menu bar hangs out of it is drawn, and so
    // is the bar. The box-less ancestor used to count as not painted, and
    // nothing inside one was ever proven painted.
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
    expect(port.messages[0]!.proofs).toContainEqual(expect.objectContaining({
      kind: 'structural-menu',
      panelNodeId: nodeId(panel),
    }));
    session.dispose();
  });

  describe('a site menu whose panel sits inside a wrapper', () => {
    /**
     * Reads a page once. `collapsed` elements are `display: none`, `boxless`
     * ones have no rectangle (as a block of no height has none in Chrome),
     * `clipping` ones clip their overflow.
     */
    const read = (
      markup: string,
      shape: {
        readonly collapsed?: string;
        readonly boxless?: string;
        readonly clipping?: string;
        /** Placed out of the flow (`position: absolute`); `#panel` unless said. */
        readonly positioned?: string;
        /** The same by `position: fixed`. */
        readonly fixed?: string;
      } = {},
    ) => {
      const { document, window } = parseHTML(`<html><body>${markup}</body></html>`);
      installPaintedTabFixture(document, window as unknown as Window);
      const matching = (selector: string | undefined) =>
        new Set<Element>(selector ? [...document.querySelectorAll(selector)] : []);
      const collapsed = matching(shape.collapsed ?? '#panel');
      const clipping = matching(shape.clipping);
      const positioned = matching(shape.positioned ?? '#panel');
      const fixed = matching(shape.fixed);
      for (const element of matching(shape.boxless)) {
        Object.defineProperty(element, 'getClientRects', {
          configurable: true,
          value: () => Object.assign([], { item: () => null }) as DOMRectList,
        });
      }
      const style = structuralMenuStyle((element) =>
        collapsed.has(element) ? 'display' : undefined);
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
          const computed = {
            ...style(element),
            position: fixed.has(element)
              ? 'fixed'
              : positioned.has(element) ? 'absolute' : 'static',
          };
          if (!clipping.has(element)) return computed;
          return {
            ...computed,
            overflowX: 'hidden',
            overflowY: 'hidden',
            getPropertyValue: (name: string) =>
              name === 'overflow-x' || name === 'overflow-y'
                ? 'hidden'
                : computed.getPropertyValue(name),
          };
        }) as Window['getComputedStyle'],
      );
      port.emit(createSemanticSourceStart(
        'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
      ));
      const batch = port.messages[0]!;
      const menus = batch.proofs.filter((proof) => proof.kind === 'structural-menu');
      const idOf = (wanted: number | undefined) => wanted === undefined
        ? undefined
        : [...document.querySelectorAll('[id]')].find((element) =>
            nodeId(element) === wanted)?.id;
      return {
        document,
        session,
        port,
        collapsed,
        menus: menus.map((menu) => menu.kind === 'structural-menu'
          ? [idOf(menu.containerNodeId), idOf(menu.triggerNodeId), idOf(menu.panelNodeId)].join(' ')
          : ''),
        hiddenText: batch.records.filter((record) =>
          record.gate === 'disclosureContent').map((record) => record.text),
      };
    };
    const item = (held: string) => `<nav><ul><li id="item">
      <a id="trigger" href="/products">Products</a>${held}</li></ul></nav>`;
    const list = '<ul id="panel"><li><a href="/alpha">Alpha</a></li><li><a href="/beta">Beta</a></li></ul>';

    it('offers it in a wrapper of no height', () => {
      // A header's `position: relative; height: 0` block around an absolutely
      // placed list: the wrapper has no box to prove painted, and the panel
      // was looked for among the item's own children only.
      const page = read(item(`<div id="wrap">\n${list}</div>`), { boxless: '#wrap' });
      expect(page.menus).toEqual(['item trigger panel']);
      expect(page.hiddenText).toEqual(['Alpha', 'Beta']);
      expect(page.port.messages[0]!.proofs).toContainEqual(expect.objectContaining({
        kind: 'structural-menu', expanded: false, gate: 'disclosureContent',
      }));
      page.session.dispose();
    });

    it('looks through one wrapper, and only one that takes no room', () => {
      // A wrapper with a box is a card's body or a section: what it hides
      // is no menu's panel. Nor is a block that would open in the flow of
      // its wrapper (an answer under a question), nor what sits two
      // wrappers down.
      const boxed = read(item(`<div id="wrap">${list}</div>`));
      expect(boxed.menus).toEqual([]);
      expect(boxed.hiddenText).toEqual([]);
      boxed.session.dispose();
      const inFlow = read(
        item(`<div id="wrap">${list}</div>`),
        { boxless: '#wrap', positioned: '#none' },
      );
      expect(inFlow.menus).toEqual([]);
      expect(inFlow.hiddenText).toEqual([]);
      inFlow.session.dispose();
      // A panel fixed to the window is out of the flow too.
      const pinned = read(
        item(`<div id="wrap">${list}</div>`),
        { boxless: '#wrap', positioned: '#none', fixed: '#panel' },
      );
      expect(pinned.menus).toEqual(['item trigger panel']);
      pinned.session.dispose();
      // The item's own child needs no position: a list that opens in the
      // flow under its link is a menu, as it always was.
      const direct = read(item(list), { positioned: '#none' });
      expect(direct.menus).toEqual(['item trigger panel']);
      direct.session.dispose();
      const deep = read(
        item(`<div id="wrap"><div id="inner">${list}</div></div>`),
        { boxless: '#wrap, #inner' },
      );
      expect(deep.menus).toEqual([]);
      expect(deep.hiddenText).toEqual([]);
      deep.session.dispose();
    });

    it('offers no menu for a panel that its wrapper component does not slot', () => {
      // A light child of a component whose root has no slot for it is drawn
      // nowhere, and Chrome 138 computes `display: none` for it.
      const page = (slotted: boolean, shut = false) => {
        const { document, window } = parseHTML(`<html><body>${
          item(`<x-wrap id="wrap">${list}</x-wrap>`)
        }</body></html>`);
        installPaintedTabFixture(document, window as unknown as Window);
        const wrap = document.querySelector('#wrap')!;
        const panel = document.querySelector('#panel')!;
        const root = wrap.attachShadow({ mode: 'open' });
        root.innerHTML = slotted
          ? '<div id="around"><slot></slot></div>'
          : '<p>Nothing slotted</p>';
        const around = root.querySelector('#around');
        const empty = () => Object.assign([], { item: () => null }) as DOMRectList;
        for (const element of [wrap, ...root.querySelectorAll('*')]) {
          Object.defineProperty(element, 'getClientRects', { configurable: true, value: empty });
        }
        if (slotted) {
          Object.defineProperty(panel, 'assignedSlot', {
            configurable: true,
            value: root.querySelector('slot'),
          });
        }
        const port = new FakeSemanticPort(
          createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
        );
        // `shut`: the root keeps its slot in a box that is itself hidden.
        const style = structuralMenuStyle((element) =>
          element === panel || (shut && element === around) ? 'display' : undefined);
        const session = createSession(
          port, document, window, 'isolated-html', undefined,
          ((element: Element) => ({
            ...style(element),
            position: element === panel ? 'absolute' : 'static',
          })) as unknown as Window['getComputedStyle'],
        );
        port.emit(createSemanticSourceStart(
          'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
        ));
        const batch = port.messages[0]!;
        session.dispose();
        return {
          menus: batch.proofs.filter((proof) => proof.kind === 'structural-menu').length,
          hiddenText: batch.records.filter((record) =>
            record.gate === 'disclosureContent').map((record) => record.text),
        };
      };
      expect(page(false)).toEqual({ menus: 0, hiddenText: [] });
      expect(page(true)).toEqual({ menus: 1, hiddenText: ['Alpha', 'Beta'] });
      // Slotted into a box of the root that is hidden: the box hides it,
      // not its own style, and nothing the mirror opens would show it.
      expect(page(true, true)).toEqual({ menus: 0, hiddenText: [] });
    });

    it('takes the outermost collapsed element for the panel', () => {
      // A hidden block around one list is the panel itself, as it was: what
      // it wraps is not looked at once it is found collapsed.
      const page = read(item(`<div id="panel"><ul id="inner"><li><a href="/alpha">Alpha</a></li></ul></div>`));
      expect(page.menus).toEqual(['item trigger panel']);
      page.session.dispose();
      const both = read(
        item(`<div id="panel"><ul id="inner"><li><a href="/alpha">Alpha</a></li></ul></div>`),
        { collapsed: '#panel, #inner' },
      );
      expect(both.menus).toEqual(['item trigger panel']);
      both.session.dispose();
    });

    it('offers none where the wrapper clips, holds something else, or nothing collapsed', () => {
      const none = (held: string, shape: Parameters<typeof read>[1] = {}) => {
        const page = read(item(held), shape);
        const result = { menus: page.menus, hiddenText: page.hiddenText };
        page.session.dispose();
        return result;
      };
      const refused = { menus: [], hiddenText: [] };
      // A block of no height that clips: the page can never show the list.
      expect(none(`<div id="wrap">${list}</div>`, { boxless: '#wrap', clipping: '#wrap' }))
        .toEqual(refused);
      // Text or a second element beside the list: not a wrapper.
      expect(none(`<div id="wrap">Sale ${list}</div>`, { boxless: '#wrap' }))
        .toEqual(refused);
      expect(none(`<div id="wrap"><span></span>${list}</div>`, { boxless: '#wrap' }))
        .toEqual(refused);
      // Nothing hidden anywhere: no menu.
      expect(none(`<div id="wrap">${list}</div>`, { boxless: '#wrap', collapsed: '#none' }))
        .toEqual(refused);
      // A hidden link in a wrapper is the page's mobile copy, not a panel.
      expect(none(
        '<div id="wrap"><a id="panel" href="/m">Mobile</a></div>',
        { boxless: '#wrap' },
      )).toEqual(refused);
      // A wrapper that something above hides is not shown itself.
      expect(none(
        `<div id="wrap">${list}</div>`,
        { boxless: '#wrap', collapsed: '#panel, nav' },
      )).toEqual(refused);
    });

    it('makes no menu of what is none as the item\'s own child', () => {
      // What a wrapper holds is judged as the item's own child is. The
      // wrapper adds demands of its own (no box, a panel out of the flow)
      // and takes none away: each of these is refused both ways.
      const prose = 'The council met on the quay and voted on the registers of the town hall. '
        .repeat(80);
      const outside = (held: string) => `<div id="item">
        <a id="trigger" href="/products">Products</a>${held}</div>`;
      const besideButton = (held: string) => `<div id="item">
        <button id="trigger" type="button">More</button>${held}</div>`;
      const shapes: readonly (readonly [string, (held: string) => string, string])[] = [
        ['much text that is not links', item,
          `<div id="panel"><p>${prose}</p><a href="/more">Read more</a></div>`],
        ['a hidden link (the mobile copy of a link)', item,
          '<a id="panel" href="/m">Mobile</a>'],
        ['a password field', item,
          '<div id="panel"><a href="/in">Sign in</a><input type="password" name="p"></div>'],
        ['a list beside a link outside navigation', outside, list],
        ['a block beside a button outside navigation', besideButton,
          '<div id="panel"><a href="/alpha">Alpha</a> <a href="/beta">Beta</a></div>'],
      ];
      for (const [name, around, panel] of shapes) {
        const direct = read(around(panel));
        expect(direct.menus, `${name}, the item's own child`).toEqual([]);
        direct.session.dispose();
        const wrapped = read(around(`<div id="wrap">${panel}</div>`), { boxless: '#wrap' });
        expect(wrapped.menus, `${name}, in a wrapper`).toEqual([]);
        expect(wrapped.hiddenText, `${name}, in a wrapper`).toEqual([]);
        wrapped.session.dispose();
      }
      // The control: the same list in navigation is a menu both ways, and a
      // list beside a button anywhere.
      for (const [around, held] of [
        [item, list],
        [item, `<div id="wrap">${list}</div>`],
        [besideButton, list],
        [besideButton, `<div id="wrap">${list}</div>`],
      ] as const) {
        const page = read(around(held), { boxless: '#wrap' });
        expect(page.menus, held).toEqual(['item trigger panel']);
        page.session.dispose();
      }
    });

    it('offers no menu for a large block of prose inside a wrapper', () => {
      const prose = 'The council met on the quay and voted on the registers of the town hall. '
        .repeat(80);
      const page = read(item(
        `<div id="wrap"><div id="panel"><p>${prose}</p><a href="/more">Read more</a></div></div>`,
      ), { boxless: '#wrap' });
      expect(page.menus).toEqual([]);
      expect(page.hiddenText).toEqual([]);
      page.session.dispose();
    });

    it('offers a menu whose own item has no box, and none where that item clips', () => {
      // A list item whose link floats has no height; its menu hangs out of it.
      const floated = read(item(list), { boxless: '#item' });
      expect(floated.menus).toEqual(['item trigger panel']);
      floated.session.dispose();
      const clipped = read(item(list), { boxless: '#item', clipping: '#item' });
      expect(clipped.menus).toEqual([]);
      expect(clipped.hiddenText).toEqual([]);
      clipped.session.dispose();
    });

    it('keeps the menu while the page itself shows the panel in its wrapper', () => {
      // The wrapper holds no link, so painted it could pass for a second
      // trigger: what holds the panel stays what holds it.
      const page = read(item(
        '<div id="wrap"><div id="panel"><span>Alpha</span></div></div>',
      ), { boxless: '#wrap' });
      expect(page.menus).toEqual(['item trigger panel']);
      const first = page.port.messages[0]!;
      const proof = first.proofs.find((candidate) => candidate.kind === 'structural-menu');
      // A real hover on the page: the panel is displayed, the wrapper has a box.
      page.collapsed.clear();
      Object.defineProperty(page.document.querySelector('#wrap')!, 'getClientRects', {
        configurable: true,
        value: () => paintedRectList(),
      });
      page.port.emit(createSemanticSourceAck(
        identity, first.policyFingerprint, first.sequence,
      ));
      page.session.refresh();
      expect(page.port.messages[1]!.proofs).toContainEqual(expect.objectContaining({
        kind: 'structural-menu',
        relationId: proof?.kind === 'structural-menu' ? proof.relationId : '',
        expanded: true,
      }));
      page.session.dispose();
    });

    it('offers a button beside a wrapped list anywhere, and no block beside a button', () => {
      const wrapped = read(
        `<div id="item"><button id="trigger">Actions</button><div id="wrap">${list}</div></div>`,
        { boxless: '#wrap' },
      );
      expect(wrapped.menus).toEqual(['item trigger panel']);
      wrapped.session.dispose();
      // A hidden block that wraps a list is the panel itself, and a block
      // beside a button is no menu outside navigation, as before.
      const block = read(
        `<div id="item"><button id="trigger">Section</button><div id="panel">${list.replace('id="panel"', '')}</div></div>`,
      );
      expect(block.menus).toEqual([]);
      expect(block.hiddenText).toEqual([]);
      block.session.dispose();
    });
  });

  it('knows a menu the page has open again when a new session reads the page', () => {
    // The mirror is built again while the pointer rests on a hover menu in
    // the tab: the session that reads the page anew sees a link beside a
    // shown block, which alone is no menu. The menus read so far are kept
    // for the document, and shared by every session on it.
    const { document, window } = parseHTML(`<html><body><nav><ul>
      <li id="item"><a id="trigger" href="/platform">Platform</a>
        <ul id="panel"><li><a href="/alpha">Alpha</a></li></ul></li>
      </ul></nav></body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const panel = document.querySelector('#panel')!;
    let collapsed = true;
    const style = structuralMenuStyle((element) =>
      element === panel && collapsed ? 'display' : undefined);
    const start = (structuralMenus?: WeakMap<Element, {
      readonly trigger: Element;
      readonly panel: Element;
    }>) => {
      const port = new FakeSemanticPort(
        createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
      );
      const session = new SemanticSourceSession({
        port,
        document: document as unknown as Document,
        window: { ...(window as object), getComputedStyle: style } as unknown as Window,
        bridge: 'isolated-html',
        getNodeId: (node) => nodeId(node),
        createMutationObserver: () => ({ observe: () => undefined, disconnect: () => undefined }),
        schedule: (callback) => callback(),
        ...(structuralMenus ? { structuralMenus } : {}),
      });
      port.emit(createSemanticSourceStart(
        'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
      ));
      const menus = port.messages[0]!.proofs.flatMap((proof) =>
        proof.kind === 'structural-menu' ? [proof.expanded] : []);
      session.dispose();
      return menus;
    };
    const kept = new WeakMap<Element, { readonly trigger: Element; readonly panel: Element }>();
    expect(start(kept)).toEqual([false]);
    // The page shows the panel (a hover in the tab), and the mirror is built again.
    collapsed = false;
    expect(start(kept)).toEqual([true]);
    // A session that was told of no menu takes the shown block for none.
    expect(start()).toEqual([]);
  });

  it('sends text without a letter or a digit as the page has it (D132)', () => {
    // It was dropped here to keep it from the translator, and the label went
    // with it: an option reading `$` was a blank row. The receiver keeps it
    // from the translator now.
    const { document, window } = parseHTML(
      '<html><body><input id="amount" type="text" placeholder="★★★">' +
      '<input id="go" type="submit"><input id="blank" type="text"></body></html>',
    );
    document.querySelector<HTMLInputElement>('#amount')!.value = '$';
    document.querySelector<HTMLInputElement>('#go')!.value = '>>';
    document.querySelector<HTMLInputElement>('#blank')!.value = '   ';
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    expect(port.messages[0]!.records.map(({ presentation, text }) =>
      [presentation, text])).toEqual([
      ['value', '$'], ['placeholder', '★★★'], ['label', '>>'],
    ]);
    session.dispose();
  });

  it('states the page\'s own aria-expanded and its open popovers, apart from its menus (D132)', () => {
    // Page CSS such as `button[aria-expanded="true"] + ul` shows a dropdown,
    // and the Popover API opens one without changing any attribute. Neither
    // was in the mirror.
    const { document, window } = parseHTML(`<html><body>
      <section><button id="toggle" aria-expanded="true">More</button>
        <div>More text</div><p>Third child</p></section>
      <div id="odd" aria-expanded="mixed">Odd</div>
      <div id="pop" popover="auto">Popover text</div>
      <div id="shut" popover="auto">Closed popover</div>
      <nav><div id="wrapper">
        <button id="trigger" aria-expanded="false">Resources</button><div id="panel">
          <a href="/school">Startup School</a></div></div></nav>
      </body></html>`);
    installPaintedTabFixture(document, window as unknown as Window);
    const panel = document.querySelector('#panel')!;
    const pop = document.querySelector('#pop')!;
    let popoverOpen = true;
    const matches = pop.matches.bind(pop);
    Object.defineProperty(pop, 'matches', {
      value: (selector: string) =>
        selector === ':popover-open' ? popoverOpen : matches(selector),
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
    const first = port.messages[0]!;
    // The menu's trigger carries its open state in the menu's own proof.
    expect(first.proofs.filter((proof) =>
      proof.kind === 'aria-state' && proof.state === 'expanded')).toEqual([
      expect.objectContaining({
        nodeId: nodeId(document.querySelector('#toggle')!),
        gate: 'controlSemantics',
        value: 'true',
      }),
    ]);
    expect(first.proofs.some((proof) => proof.kind === 'structural-menu'))
      .toBe(true);
    expect(first.proofs.filter((proof) => proof.kind === 'popover-open'))
      .toEqual([expect.objectContaining({
        nodeId: nodeId(pop),
        gate: 'controlSemantics',
      })]);

    // The page closes the popover: only the `toggle` event says so.
    popoverOpen = false;
    port.emit(createSemanticSourceAck(
      identity, first.policyFingerprint, first.sequence,
    ));
    // In Chrome the event does not bubble and the capturing listener still
    // hears it; linkedom delivers to that listener only what bubbles.
    pop.dispatchEvent(new (window as unknown as Window & typeof globalThis)
      .Event('toggle', { bubbles: true }));
    expect(port.messages).toHaveLength(2);
    expect(port.messages[1]!.proofs.some((proof) =>
      proof.kind === 'popover-open')).toBe(false);
    session.dispose();
  });

  it('lists open popovers in the order the page opened them (D132)', () => {
    // The later one is drawn over the earlier; only the `toggle` events say
    // which that is.
    const { document, window } = parseHTML(`<html><body>
      <div id="first" popover="manual">First in the document</div>
      <div id="second" popover="manual">Second in the document</div></body></html>`);
    const open = new Set<Element>();
    for (const popover of document.querySelectorAll('[popover]')) {
      const matches = popover.matches.bind(popover);
      Object.defineProperty(popover, 'matches', {
        value: (selector: string) =>
          selector === ':popover-open' ? open.has(popover) : matches(selector),
      });
    }
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
    ));
    const toggle = (id: string): void => {
      const popover = document.querySelector(`#${id}`)!;
      if (open.has(popover)) open.delete(popover); else open.add(popover);
      popover.dispatchEvent(new (window as unknown as Window & typeof globalThis)
        .Event('toggle', { bubbles: true }));
    };
    const order = (): number[] => port.messages.at(-1)!.proofs
      .filter((proof) => proof.kind === 'popover-open')
      .map((proof) => 'nodeId' in proof ? proof.nodeId : 0);
    const acknowledge = (): void => {
      const last = port.messages.at(-1)!;
      port.emit(createSemanticSourceAck(
        identity, last.policyFingerprint, last.sequence,
      ));
    };
    const first = nodeId(document.querySelector('#first')!);
    const second = nodeId(document.querySelector('#second')!);

    // Both open before the page is read again (the first batch is still on
    // its way): one read finds both, and lists them in the page's order, not
    // the document's.
    toggle('second');
    toggle('first');
    expect(order()).toEqual([]);
    acknowledge();
    expect(order()).toEqual([second, first]);
    // Closed and opened again, `second` is now the later one.
    acknowledge();
    toggle('second');
    expect(order()).toEqual([first]);
    acknowledge();
    toggle('second');
    expect(order()).toEqual([first, second]);
    session.dispose();
  });

  it('reads no expanded state or popover in Page-only scope (D132)', () => {
    const { document, window } = parseHTML(`<html><body>
      <button aria-expanded="true">More</button>
      <div id="pop" popover="auto">Popover text</div></body></html>`);
    const pop = document.querySelector('#pop')!;
    Object.defineProperty(pop, 'matches', { value: () => true });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(port, document, window);
    port.emit(createSemanticSourceStart(
      'isolated-html', identity, PAGE_ONLY_REPLICA_READ_SCOPE,
    ));
    expect(port.messages.flatMap((message) => message.proofs)).toEqual([]);
    session.dispose();
  });

  it('reads menu text before control labels, and editable text last (D132)', () => {
    // Menu text was read last. On a page whose options and named controls
    // filled the batch no menu had text, and a menu without text is not
    // offered.
    const { document, window } = parseHTML(`<html><body>
      <div contenteditable="true">Editable note</div>
      <button id="stable" title="Stable control"></button>
      <nav><div id="wrapper">
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
    expect(batch.records.map((record) => record.text)).toEqual([
      'Startup School', 'Stable control', 'Editable note',
    ]);
    expect(batch.proofs.some((proof) => proof.kind === 'structural-menu'))
      .toBe(true);
    expect(batch.proofs).toContainEqual(expect.objectContaining({
      kind: 'control-state',
      nodeId: nodeId(document.querySelector('#stable')!),
    }));
    session.dispose();
  });

  it('holds what the counted bytes of one message allow, not a count (D132)', () => {
    // 1,024 labels was the limit: the dropdowns further down a page with
    // more were blank.
    expect(MAX_SEMANTIC_SOURCE_RECORDS).toBe(65_536);
    const options = Array.from(
      { length: 3_000 },
      (_, index) => `<option${index === 7 ? ' disabled' : ''}>Choice ${index}</option>`,
    ).join('');
    const { document, window } = parseHTML(
      `<html><body><select id="many">${options}</select></body></html>`,
    );
    const style = structuralMenuStyle(() => undefined);
    // Option labels are read through the page's own window and need a box.
    const globalNode = Object.getOwnPropertyDescriptor(globalThis, 'Node');
    Object.defineProperty(globalThis, 'Node', {
      configurable: true,
      writable: true,
      value: (window as unknown as { Node: typeof Node }).Node,
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: style,
    });
    const select = document.querySelector('#many')!;
    Object.defineProperty(select, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 0, top: 0, right: 120, bottom: 24, width: 120, height: 24 }),
    });
    const port = new FakeSemanticPort(
      createSemanticSourcePortName(identity.sessionId, 'isolated-html'),
    );
    const session = createSession(
      port, document, window, 'isolated-html', undefined, style,
    );
    try {
      port.emit(createSemanticSourceStart(
        'isolated-html', identity, FULL_VISIBLE_REPLICA_READ_SCOPE,
      ));
      const batch = port.messages[0]!;
      const labels = batch.records
        .filter((record) => record.tagName === 'option')
        .map((record) => record.text);
      expect(labels).toHaveLength(3_000);
      expect(labels.at(-1)).toBe('Choice 2999');
      // An enabled option needs no proof of it, and a page can hold
      // thousands: only the dropdown and its one disabled option are stated.
      expect(batch.proofs.filter((proof) => proof.kind === 'control-state'))
        .toEqual([
          expect.objectContaining({ nodeId: nodeId(select), disabled: false }),
          expect.objectContaining({
            nodeId: nodeId(select.querySelectorAll('option')[7]!),
            disabled: true,
          }),
        ]);
    } finally {
      session.dispose();
      delete (window as { getComputedStyle?: unknown }).getComputedStyle;
      if (globalNode) Object.defineProperty(globalThis, 'Node', globalNode);
      else delete (globalThis as { Node?: unknown }).Node;
    }
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
    // Only the password's length travels (D91).
    expect(JSON.stringify(firstPort.messages)).not.toContain('credential"');
    expect(firstPort.messages[0]!.proofs).toEqual([
      expect.objectContaining({ kind: 'masked-length', length: 10 }),
    ]);
    const readsWhilePassword = reads;
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
    expect(secondPort.messages[0]!.proofs).toEqual([]);
    expect(reads).toBe(readsWhilePassword);
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
  ) => 'display' | 'content-visibility' | 'opacity' | 'visibility' | undefined,
): Window['getComputedStyle'] {
  return ((element: Element) => {
    const collapse = collapseFor(element);
    return {
      display: collapse === 'display' ? 'none' : 'block',
      visibility: collapse === 'visibility' ? 'hidden' : 'visible',
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
