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

  it('emits bounded capacity diagnostics when checkpoint serialization overflows', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      WeakNodeIdRegistry,
      'MAX_TRACKED_NODES',
    )!;
    try {
      Object.defineProperty(WeakNodeIdRegistry, 'MAX_TRACKED_NODES', {
        ...descriptor,
        value: 1,
      });
      const fixture = sourceFixture('<main>capacity source text</main>');

      fixture.start();

      expect(fixture.checkpoints()).toHaveLength(0);
      expect(fixture.port.posts.at(-1)).toMatchObject({
        kind: 'simul:html-mirror-v1:error',
        code: 'stream_overflow',
        representability: {
          capacityOmissionCount: 1,
        },
      });
      expect(JSON.stringify(
        (fixture.port.posts.at(-1) as { representability: unknown })
          .representability,
      )).not.toContain('capacity source text');
    } finally {
      Object.defineProperty(
        WeakNodeIdRegistry,
        'MAX_TRACKED_NODES',
        descriptor,
      );
    }
  });

  it('emits bounded capacity diagnostics when a new-child patch overflows', () => {
    const fixture = sourceFixture('<main id="target"><span>retained</span></main>');
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const descriptor = Object.getOwnPropertyDescriptor(
      WeakNodeIdRegistry,
      'MAX_TRACKED_NODES',
    )!;
    try {
      Object.defineProperty(WeakNodeIdRegistry, 'MAX_TRACKED_NODES', {
        ...descriptor,
        value: fixture.registry.trackedNodeCount,
      });
      const target = fixture.document.querySelector('#target')!;
      const added = fixture.document.createElement('aside');
      added.textContent = 'capacity patch text';
      target.append(added);
      fixture.mutate(childListRecord(target, [added]));

      fixture.flushFrame();

      expect(fixture.patches()).toHaveLength(0);
      expect(fixture.port.posts.at(-1)).toMatchObject({
        kind: 'simul:html-mirror-v1:error',
        code: 'stream_overflow',
        representability: {
          capacityOmissionCount: 1,
        },
      });
      expect(JSON.stringify(
        (fixture.port.posts.at(-1) as { representability: unknown })
          .representability,
      )).not.toContain('capacity patch text');
    } finally {
      Object.defineProperty(
        WeakNodeIdRegistry,
        'MAX_TRACKED_NODES',
        descriptor,
      );
    }
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
    expect(privatePatch.representability.attributeContextFallbackCount).toBe(1);
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
    expect(fixture.checkpoints()[0]?.payload.representability).toMatchObject({
      unsafeElementOmissionCount: 2,
    });
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('iframe');
    added.setAttribute('srcdoc', '<p>dynamic frame secret</p>');
    added.append(fixture.document.createTextNode('dynamic frame secret'));
    page.append(added);
    fixture.mutate(childListRecord(page, [added]));
    fixture.flushFrame();

    const patchJson = JSON.stringify(fixture.patches().at(-1));
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [expect.objectContaining({ kind: 'retain' })],
      }),
    ]));
    expect(patchJson).not.toContain('"tagName":"iframe"');
    expect(patchJson).not.toContain('dynamic frame secret');
    expect(fixture.patches().at(-1)?.representability).toMatchObject({
      unsafeElementOmissionCount: 3,
    });

    const foreign = parseHTML('<html><body>foreign frame secret</body></html>');
    const foreignText = foreign.document.body.firstChild as Text;
    const scheduledBeforeForeignMutation = fixture.frames.length;
    const postsBeforeForeignMutation = fixture.port.posts.length;
    fixture.mutate(characterDataRecord(foreignText));
    expect(fixture.frames).toHaveLength(scheduledBeforeForeignMutation);
    expect(fixture.port.posts).toHaveLength(postsBeforeForeignMutation);
  });

  it('derives final-order retain entries from emitted state across unacknowledged batches', () => {
    const fixture = sourceFixture(`
      <main id="target"><span id="first">first</span><span id="second">second</span></main>
    `);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const first = fixture.document.querySelector('#first')!;
    const second = fixture.document.querySelector('#second')!;
    const firstId = fixture.registry.peekId(first)!;
    const secondId = fixture.registry.peekId(second)!;

    const added = fixture.document.createElement('p');
    added.textContent = 'added';
    target.append(added);
    fixture.mutate(childListRecord(target, [added]));
    fixture.flushFrame();
    const addedId = fixture.registry.peekId(added)!;
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: firstId },
          { kind: 'retain', nodeId: secondId },
          expect.objectContaining({
            kind: 'graph',
            node: expect.objectContaining({ id: addedId }),
          }),
        ],
      }),
    ]));

    target.insertBefore(second, first);
    fixture.mutate(childListRecord(target, [second]));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: secondId },
          { kind: 'retain', nodeId: firstId },
          { kind: 'retain', nodeId: addedId },
        ],
      }),
    ]));

    added.remove();
    fixture.mutate(childListRecord(target, []));
    fixture.flushFrame();
    target.append(added);
    fixture.mutate(childListRecord(target, [added]));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: secondId },
          { kind: 'retain', nodeId: firstId },
          expect.objectContaining({
            kind: 'graph',
            node: expect.objectContaining({ id: addedId }),
          }),
        ],
      }),
    ]));
  });

  it('does not traverse retained direct-child subtrees during append or reorder', () => {
    const fixture = sourceFixture(`
      <main id="target"><section id="retained"><span>stable subtree</span></section></main>
    `);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const retained = fixture.document.querySelector('#retained')!;
    const retainedId = fixture.registry.peekId(retained)!;
    let retainedTraversalCount = 0;
    Object.defineProperty(retained, 'attributes', {
      configurable: true,
      get: () => {
        retainedTraversalCount += 1;
        throw new Error('retained subtree must not be serialized');
      },
    });

    const added = fixture.document.createElement('aside');
    added.textContent = 'new child';
    target.append(added);
    fixture.mutate(childListRecord(target, [added]));
    fixture.flushFrame();
    const addedId = fixture.registry.peekId(added)!;
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: retainedId },
          expect.objectContaining({
            kind: 'graph',
            node: expect.objectContaining({ id: addedId }),
          }),
        ],
      }),
    ]));
    expect(retainedTraversalCount).toBe(0);

    fixture.port.emitMessage(createHtmlMirrorAck(identity, 1));
    target.append(retained);
    fixture.mutate(childListRecord(target, [retained]));
    fixture.flushFrame();
    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reconcile-children',
        children: [
          { kind: 'retain', nodeId: addedId },
          { kind: 'retain', nodeId: retainedId },
        ],
      }),
    ]));
    expect(retainedTraversalCount).toBe(0);
  });

  it('falls back to full children when a structural change covers dirty descendants', () => {
    const fixture = sourceFixture(
      '<main id="target"><span id="label">before</span></main>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const labelText = fixture.document.querySelector('#label')!.firstChild as Text;
    const added = fixture.document.createElement('aside');
    added.textContent = 'new sibling';
    target.append(added);
    labelText.nodeValue = 'after';
    fixture.mutate(childListRecord(target, [added]));
    fixture.mutate(characterDataRecord(labelText));
    fixture.flushFrame();

    expect(fixture.patches().at(-1)?.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'children' }),
    ]));
    expect(
      fixture.patches().at(-1)?.representability.coveredDirtyBranchFallbackCount,
    ).toBe(1);
    expect(JSON.stringify(fixture.patches().at(-1))).toContain('after');
  });

  it('classifies cross-parent churn without retaining the moved identity', () => {
    const fixture = sourceFixture(`
      <section id="left"><span id="moved">move me</span></section>
      <section id="right"></section>
    `);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const left = fixture.document.querySelector('#left')!;
    const right = fixture.document.querySelector('#right')!;
    const moved = fixture.document.querySelector('#moved')!;
    right.append(moved);
    fixture.mutate(childListRecord(left, []));
    fixture.mutate(childListRecord(right, [moved]));
    fixture.flushFrame();

    const patch = fixture.patches().at(-1)!;
    expect(patch.operations.filter(({ kind }) => kind === 'children')).toHaveLength(2);
    expect(patch.operations.some(({ kind }) => kind === 'reconcile-children')).toBe(
      false,
    );
    expect(patch.representability.crossParentFallbackCount).toBe(1);
  });

  it('uses full replacement when a new wrapper contains an emitted identity', () => {
    const fixture = sourceFixture(
      '<main id="target"><span id="moved">move me</span></main>',
    );
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));
    const target = fixture.document.querySelector('#target')!;
    const moved = fixture.document.querySelector('#moved')!;
    const wrapper = fixture.document.createElement('section');
    target.append(wrapper);
    wrapper.append(moved);
    fixture.mutate(childListRecord(target, [wrapper]));
    fixture.flushFrame();

    const patch = fixture.patches().at(-1)!;
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'children' }),
    ]));
    expect(patch.operations.some(({ kind }) => kind === 'reconcile-children'))
      .toBe(false);
    expect(patch.representability.crossParentFallbackCount).toBe(1);
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

  it('uses full replacement when a light-DOM change covers dirty open-shadow content', () => {
    const fixture = sourceFixture('<main id="page"><x-card id="card"></x-card></main>');
    const page = fixture.document.querySelector('#page')!;
    const card = fixture.document.querySelector('#card')!;
    const shadow = card.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const shadowText = fixture.document.createTextNode('before shadow');
    shadow.append(shadowText);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('aside');
    added.textContent = 'new light child';
    page.append(added);
    shadowText.nodeValue = 'after shadow';
    fixture.mutate(childListRecord(page, [added]));
    fixture.mutate(characterDataRecord(shadowText));
    fixture.flushFrame();

    const patch = fixture.patches().at(-1)!;
    expect(patch.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'children' }),
    ]));
    expect(patch.operations.some(({ kind }) => kind === 'reconcile-children')).toBe(
      false,
    );
    expect(JSON.stringify(patch)).toContain('after shadow');
  });

  it('requests a checkpoint when a host child patch cannot carry its own dirty shadow', () => {
    const fixture = sourceFixture('<x-card id="card"><span>light</span></x-card>');
    const card = fixture.document.querySelector('#card')!;
    const shadow = card.attachShadow({ mode: 'open' });
    Object.defineProperty(shadow, 'mode', { value: 'open' });
    const nestedHost = fixture.document.createElement('x-nested');
    shadow.append(nestedHost);
    const nestedShadow = nestedHost.attachShadow({ mode: 'open' });
    Object.defineProperty(nestedShadow, 'mode', { value: 'open' });
    const shadowText = fixture.document.createTextNode('before nested shadow');
    nestedShadow.append(shadowText);
    fixture.start();
    fixture.port.emitMessage(createHtmlMirrorAck(identity, 0));

    const added = fixture.document.createElement('span');
    added.textContent = 'new light child';
    card.append(added);
    shadowText.nodeValue = 'after nested shadow';
    fixture.mutate(childListRecord(card, [added]));
    fixture.mutate(characterDataRecord(shadowText));
    fixture.flushFrame();

    expect(fixture.patches()).toHaveLength(0);
    expect(fixture.port.posts.at(-1)).toMatchObject({
      kind: 'simul:html-mirror-v1:error',
      code: 'stream_gap',
    });
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
