import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmlMirrorAck,
  createHtmlMirrorCheckpointRequest,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchBatch,
} from '../lib/replica/html-mirror-protocol';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
} from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/protocol-v2';

const YC_LOGO = "data:image/svg+xml,%3csvg%20width='48'%20height='48'%20viewBox='0%200%2048%2048'%20fill='none'%20xmlns='http://www.w3.org/2000/svg'%3e%3cpath%20d='M47.9985%2047.9994H0V8.61853e-07H47.9985V47.9994Z'%20fill='%23FF6600'/%3e%3cpath%20d='M13.9012%2011.7843H17.6595L22.4961%2021.5325C23.203%2022.9836%2023.7984%2024.3976%2023.7984%2024.3976C23.7984%2024.3976%2024.4313%2023.021%2025.175%2021.5325L30.0868%2011.7843H33.5843L25.2865%2027.3746V37.309H22.1244V27.1884L13.9012%2011.7843Z'%20fill='white'/%3e%3c/svg%3e";

describe('HtmlMirrorSourceSession', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });

  it('stays paused through recovery ACK and retains mutations after its checkpoint', () => {
    const fixture = sourceFixture('<main><span>before</span></main>');
    fixture.start();
    expect(fixture.checkpoints()).toHaveLength(1);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints()).toHaveLength(2);
    const text = fixture.document.querySelector('span')!.firstChild as Text;
    text.nodeValue = 'after checkpoint';
    fixture.mutate(characterDataRecord(text));
    expect(fixture.frames).toHaveLength(0);

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    fixture.flushFrame();
    const patch = fixture.patches().at(-1)!;
    expect(patch.identity.sequence).toBe(1);
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'text',
        node: expect.objectContaining({ text: 'after checkpoint' }),
      }),
    ]));
  });

  it('coalesces startup mutations until the initial checkpoint is acknowledged', () => {
    const fixture = sourceFixture('<main><span>initial</span></main>');
    fixture.start();
    expect(fixture.checkpoints()).toHaveLength(1);

    const text = fixture.document.querySelector('span')!.firstChild as Text;
    text.nodeValue = 'changed while replica stages';
    fixture.mutate(characterDataRecord(text));
    expect(fixture.frames).toHaveLength(0);
    expect(fixture.patches()).toHaveLength(0);

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    expect(fixture.frames).toHaveLength(1);
    fixture.flushFrame();

    const patches = fixture.patches();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.firstSequence).toBe(1);
    expect(patches[0]?.lastSequence).toBe(1);
    expect(JSON.stringify(patches[0])).toContain('changed while replica stages');
  });

  it('resanitizes descendants in the same batch when privacy roles enter and leave', () => {
    const fixture = sourceFixture('<main id="target"><span>public value</span></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;

    target.setAttribute('role', 'textbox');
    fixture.mutate(attributeRecord(target, 'role'));
    fixture.flushFrame();
    const privatePatch = fixture.patches().at(-1)!;
    expect(privatePatch.operations.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['attributes', 'children']),
    );
    expect(JSON.stringify(privatePatch)).not.toContain('public value');

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    target.removeAttribute('role');
    fixture.mutate(attributeRecord(target, 'role'));
    fixture.flushFrame();
    const publicPatch = fixture.patches().at(-1)!;
    expect(publicPatch.operations.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(['attributes', 'children']),
    );
    expect(JSON.stringify(publicPatch)).toContain('public value');
  });

  it('streams activation labels and static logos without leaking descendant metadata', () => {
    const fixture = sourceFixture(`
      <button id="duns" data-account="checkpoint-button-secret">
        <span id="duns-label" title="checkpoint-title-secret" data-user="checkpoint-data-secret">D-U-N-S® Numberを検索・取得する</span>
      </button>
      <section id="companies" role="button">
        <span id="company" title="checkpoint-company-secret">Airbnb</span>
      </section>
      <img id="yc-logo">
    `);
    fixture.start();

    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).toContain('D-U-N-S® Numberを検索・取得する');
    expect(checkpointJson).toContain('Airbnb');
    expect(checkpointJson).not.toContain('checkpoint-button-secret');
    expect(checkpointJson).not.toContain('checkpoint-title-secret');
    expect(checkpointJson).not.toContain('checkpoint-data-secret');
    expect(checkpointJson).not.toContain('checkpoint-company-secret');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const dunsLabel = fixture.document.querySelector('#duns-label')!;
    const dunsText = dunsLabel.firstChild as Text;
    dunsText.nodeValue = 'ここをクリック　＞';
    dunsLabel.setAttribute('title', 'patch-title-secret');
    dunsLabel.setAttribute('data-user', 'patch-data-secret');
    const company = fixture.document.querySelector('#company')!;
    const companyText = company.firstChild as Text;
    companyText.nodeValue = 'Coinbase';
    company.setAttribute('title', 'patch-company-secret');
    const logo = fixture.document.querySelector('#yc-logo')!;
    logo.setAttribute('src', YC_LOGO);

    fixture.mutate(characterDataRecord(dunsText));
    fixture.mutate(attributeRecord(dunsLabel, 'title'));
    fixture.mutate(attributeRecord(dunsLabel, 'data-user'));
    fixture.mutate(characterDataRecord(companyText));
    fixture.mutate(attributeRecord(company, 'title'));
    fixture.mutate(attributeRecord(logo, 'src'));
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(patchJson).toContain('ここをクリック　＞');
    expect(patchJson).toContain('Coinbase');
    expect(patchJson).toContain(YC_LOGO);
    expect(patchJson).not.toContain('patch-title-secret');
    expect(patchJson).not.toContain('patch-data-secret');
    expect(patchJson).not.toContain('patch-company-secret');
  });

  it('keeps data srcset payloads local in live attribute patches', () => {
    const fixture = sourceFixture('<main><img id="target"></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;

    target.setAttribute(
      'srcset',
      'data:image/png;base64,AAAA 1x, /updated.png 2x',
    );
    fixture.mutate(attributeRecord(target, 'srcset'));
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(patchJson).toContain(
      'data:image/png;base64,AAAA 1x, https://example.test/updated.png 2x',
    );
    expect(patchJson).not.toContain('https://example.test/AAAA');
  });

  it('refreshes image state on load/error and currentSrc changes without looping', () => {
    const fixture = sourceFixture(
      '<main><img id="light" src="/fallback.jpg"><x-card id="host"></x-card></main>',
    );
    const light = fixture.document.querySelector('#light')!;
    const host = fixture.document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const shadowImage = fixture.document.createElement('img');
    shadowImage.setAttribute('src', '/shadow-fallback.jpg');
    shadow.append(shadowImage);
    Object.defineProperty(light, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/fallback.jpg',
    });
    Object.defineProperty(shadowImage, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/shadow-fallback.jpg',
    });

    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    light.dispatchEvent(new fixture.window.Event('error', { bubbles: true }));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'attributes' }),
    ]));
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));

    Object.defineProperty(shadowImage, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/shadow-selected.jpg',
    });
    shadowImage.dispatchEvent(new fixture.window.Event('load', { bubbles: true }));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      'https://example.test/shadow-selected.jpg',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 2));

    Object.defineProperty(light, 'currentSrc', {
      configurable: true,
      value: 'https://example.test/light-selected.jpg',
    });
    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      'https://example.test/light-selected.jpg',
    );
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 3));

    fixture.window.dispatchEvent(new fixture.window.Event('resize'));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations.every(
      ({ kind }) => kind === 'dimensions',
    )).toBe(true);
  });

  it('ignores mutations below an intentionally omitted mirror ancestor', () => {
    const fixture = sourceFixture('<main>shown</main><script>omitted secret</script>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const omitted = fixture.document.querySelector('script')!.firstChild as Text;
    // Simulate another page-owned subsystem assigning an ID. Mirror ownership,
    // not registry presence alone, decides whether a patch may be emitted.
    fixture.registry.getId(omitted);
    omitted.nodeValue = 'changed omitted secret';
    fixture.mutate(characterDataRecord(omitted));
    fixture.flushFrame();

    const patch = fixture.patches().at(-1)!;
    expect(patch.operations.every(({ kind }) => kind === 'dimensions')).toBe(true);
    expect(JSON.stringify(patch)).not.toContain('secret');
  });

  it('omits embedded frame surfaces from checkpoints and later mutations', () => {
    const fixture = sourceFixture('<main id="page"><p>top document</p></main>');
    const page = fixture.document.querySelector('#page')!;
    const iframe = fixture.document.createElement('iframe');
    iframe.setAttribute('src', 'https://frame.invalid/initial');
    iframe.append(fixture.document.createTextNode('initial iframe secret'));
    const frame = fixture.document.createElement('frame');
    frame.setAttribute('src', 'https://frame.invalid/legacy');
    frame.append(fixture.document.createTextNode('initial frame secret'));
    page.append(iframe, frame);

    fixture.start();
    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).toContain('top document');
    expect(checkpointJson).not.toContain('"tagName":"iframe"');
    expect(checkpointJson).not.toContain('"tagName":"frame"');
    expect(checkpointJson).not.toContain('frame.invalid');
    expect(checkpointJson).not.toContain('iframe secret');
    expect(checkpointJson).not.toContain('frame secret');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('iframe');
    added.setAttribute('srcdoc', '<p>dynamic frame secret</p>');
    added.append(fixture.document.createTextNode('dynamic frame secret'));
    page.append(added);
    fixture.mutate(childListRecord(page, [added]));
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(patchJson).toContain('top document');
    expect(patchJson).not.toContain('"tagName":"iframe"');
    expect(patchJson).not.toContain('dynamic frame secret');

    const foreign = parseHTML('<html><body>foreign frame secret</body></html>');
    const foreignText = foreign.document.body.firstChild as Text;
    const scheduledBeforeForeignMutation = fixture.frames.length;
    const postsBeforeForeignMutation = fixture.port.posts.length;
    fixture.mutate(characterDataRecord(foreignText));
    expect(fixture.frames).toHaveLength(scheduledBeforeForeignMutation);
    expect(fixture.port.posts).toHaveLength(postsBeforeForeignMutation);
  });

  it('captures and live-observes accessible open shadow roots only', () => {
    const fixture = sourceFixture('<main><div id="open"></div><div id="closed"></div></main>');
    const open = fixture.document.querySelector('#open')!;
    const openText = fixture.document.createTextNode('open shadow');
    const openShadow = open.attachShadow({ mode: 'open' });
    Object.defineProperty(openShadow, 'mode', { value: 'open' });
    openShadow.append(openText);
    fixture.document.querySelector('#closed')!.attachShadow({ mode: 'closed' })
      .textContent = 'closed shadow';

    fixture.start();
    const checkpointJson = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpointJson).toContain('open shadow');
    expect(checkpointJson).not.toContain('closed shadow');
    expect(fixture.observed.some((node) => node === openShadow)).toBe(true);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    openText.nodeValue = 'updated shadow';
    fixture.mutate(characterDataRecord(openText));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('updated shadow');
  });

  it('rebuilds when an open-shadow host enters a private context', () => {
    const fixture = sourceFixture('<main><div id="host"></div></main>');
    const host = fixture.document.querySelector('#host')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const label = fixture.document.createElement('span');
    label.setAttribute('title', 'shadow metadata secret');
    label.textContent = 'shadow text secret';
    shadow.append(label);

    fixture.start();
    expect(JSON.stringify(fixture.checkpoints()[0])).toContain('shadow text secret');
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    host.setAttribute('role', 'textbox');
    fixture.mutate(attributeRecord(host, 'role'));
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v1:error',
      code: 'stream_gap',
    });
    expect(fixture.frames).toHaveLength(0);

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    const recoveryJson = JSON.stringify(fixture.checkpoints().at(-1));
    expect(recoveryJson).not.toContain('shadow text secret');
    expect(recoveryJson).not.toContain('shadow metadata secret');
  });

  it('reconciles an open shadow root attached after the initial checkpoint', () => {
    const fixture = sourceFixture('<main><div id="late-shadow"></div></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const host = fixture.document.querySelector('#late-shadow')!;
    const shadow = host.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const text = fixture.document.createTextNode('late shadow text');
    shadow.append(text);

    // attachShadow() itself is not a DOM mutation. The bounded discovery pass
    // must find the newly attached root without relying on an impossible
    // observer callback from a root that was not observable yet.
    fixture.runTimer();

    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v1:error',
      code: 'stream_gap',
    });
    expect(fixture.observed).toContain(shadow);
    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints()).toHaveLength(2);
    expect(JSON.stringify(fixture.checkpoints().at(-1))).toContain(
      'late shadow text',
    );

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    text.nodeValue = 'updated late shadow';
    fixture.mutate(characterDataRecord(text));
    fixture.flushFrame();
    expect(JSON.stringify(fixture.patches().at(-1))).toContain(
      'updated late shadow',
    );
  });

  it('detects CSSOM-only adopted stylesheet changes and recovers once', () => {
    const fixture = sourceFixture('<main class="page">styled content</main>');
    const rule = { cssText: '.page{display:grid}' };
    Object.defineProperty(fixture.document, 'adoptedStyleSheets', {
      configurable: true,
      value: [fakeStyleSheet(rule)],
    });
    fixture.start();
    expect(fixture.checkpoints()[0]?.payload.adoptedStyleSheets).toEqual([
      '.page{display:grid}',
    ]);
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    rule.cssText = '.page{display:flex}';
    fixture.runTimer();
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v1:error',
      code: 'stream_gap',
    });
    const gapsAfterChange = fixture.port.posts.filter(
      (message) => (message as { code?: string }).code === 'stream_gap',
    ).length;
    fixture.runTimer();
    expect(fixture.port.posts.filter(
      (message) => (message as { code?: string }).code === 'stream_gap',
    )).toHaveLength(gapsAfterChange);

    fixture.port.emitMessage(createHtmlMirrorCheckpointRequest(identity, 0));
    expect(fixture.checkpoints().at(-1)?.payload.adoptedStyleSheets).toEqual([
      '.page{display:flex}',
    ]);
  });
});

const identity = createReplicaIdentity({
  sessionId: 'source-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'source-document',
  frameId: 0,
  sequence: 0,
});

function sourceFixture(markup: string) {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${markup}</body></html>`);
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  Object.defineProperty(document, 'baseURI', {
    configurable: true,
    value: 'https://example.test/',
  });
  const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
  const registry = new WeakNodeIdRegistry();
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const observed: Node[] = [];
  let mutationCallback!: MutationCallback;
  const session = new HtmlMirrorSourceSession({
    port: port as unknown as Browser.runtime.Port,
    document,
    window: window as unknown as Window,
    registry,
    now: () => 1,
    createMutationObserver: (callback) => {
      mutationCallback = callback;
      return {
        observe: (target) => observed.push(target),
        disconnect: vi.fn(),
      };
    },
    scheduleFrame: (callback) => {
      frames.push(callback);
      return callback;
    },
    cancelFrame: (handle) => {
      const index = frames.indexOf(handle as () => void);
      if (index >= 0) frames.splice(index, 1);
    },
    setTimer: (callback) => {
      timers.push(callback);
      return callback;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as () => void);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  return {
    document,
    window,
    frames,
    observed,
    port,
    registry,
    session,
    start: () => port.emitMessage(createHtmlMirrorStart(identity)),
    mutate: (record: MutationRecord) => mutationCallback(
      [record],
      {} as MutationObserver,
    ),
    flushFrame: () => {
      const frame = frames.shift();
      if (!frame) throw new Error('Expected a scheduled mirror frame.');
      frame();
    },
    runTimer: () => {
      const timer = timers.shift();
      if (!timer) throw new Error('Expected a scheduled mirror timer.');
      timer();
    },
    checkpoints: () => port.posts.filter(
      (message): message is HtmlMirrorCheckpoint =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v1:checkpoint',
    ),
    patches: () => port.posts.filter(
      (message): message is HtmlMirrorPatchBatch =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v1:patch',
    ),
  };
}

function characterDataRecord(target: Text): MutationRecord {
  return {
    type: 'characterData',
    target,
  } as unknown as MutationRecord;
}

function attributeRecord(target: Element, attributeName: string): MutationRecord {
  return {
    type: 'attributes',
    target,
    attributeName,
  } as unknown as MutationRecord;
}

function childListRecord(
  target: Node,
  addedNodes: readonly Node[],
): MutationRecord {
  return {
    type: 'childList',
    target,
    addedNodes,
    removedNodes: [],
  } as unknown as MutationRecord;
}

function fakeStyleSheet(rule: { cssText: string }): CSSStyleSheet {
  return {
    disabled: false,
    cssRules: {
      0: rule,
      length: 1,
      item: (index: number) => index === 0 ? rule : null,
    },
  } as unknown as CSSStyleSheet;
}

class FakePort {
  readonly posts: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();
  readonly disconnect = vi.fn();

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    this.posts.push(message);
  }

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakeEvent<T extends (...arguments_: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  emit(...arguments_: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...arguments_);
  }
}
