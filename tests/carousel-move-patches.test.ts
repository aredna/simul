import { parseHTML } from 'linkedom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHtmlMirrorAck,
  createHtmlMirrorPortName,
  createHtmlMirrorStart,
  type HtmlMirrorCheckpoint,
  type HtmlMirrorPatchBatch,
} from '../lib/replica/html-mirror-protocol';
import {
  HtmlMirrorSourceSession,
  WeakNodeIdRegistry,
} from '../lib/replica/html-mirror-source';
import { createReplicaIdentity } from '../lib/replica/replica-identity';
import { rememberSourceMutationSecrets } from '../lib/replica/semantic-source-session';
import { hasSourceCredentialSecretAncestor } from '../lib/replica/source-privacy-policy';
import { StickySourceSecretClassifier } from '../lib/replica/source-secret-classifier';

const identity = createReplicaIdentity({
  sessionId: 'carousel-session',
  pageEpoch: 1,
  generation: 1,
  documentId: 'carousel-document',
  frameId: 0,
  sequence: 0,
});

// A Swiper 8 carousel after init with `loop: true`: duplicate slides, the
// accessibility module's wrapper id and `aria-controls`, slide state classes,
// and pagination bullets. Every slide holds an activation control.
const CAROUSEL = `
<div class="kv-carousel swiper swiper-initialized swiper-horizontal">
  <div id="swiper-wrapper-1" class="swiper-wrapper" aria-live="off"
    style="transition-duration: 0ms; transform: translate3d(-1068px, 0px, 0px);">
    <div class="swiper-slide kvslide3 swiper-slide-duplicate swiper-slide-prev" role="group" aria-label="3 / 3" data-swiper-slide-index="2" style="width: 1068px;"><a href="/three">Slide three headline</a></div>
    <div class="swiper-slide kvslide1 swiper-slide-active" role="group" aria-label="1 / 3" data-swiper-slide-index="0" style="width: 1068px;"><h2>Slide one headline</h2><button class="signup">Start</button></div>
    <div class="swiper-slide kvslide-individual swiper-slide-next" role="group" aria-label="2 / 3" data-swiper-slide-index="1" style="width: 1068px;"><button class="signup"><img id="banner" src="/kv.png" alt="Banner label" width="2136" height="600"></button></div>
    <div class="swiper-slide kvslide3" role="group" aria-label="3 / 3" data-swiper-slide-index="2" style="width: 1068px;"><a href="/three">Slide three headline</a></div>
    <div class="swiper-slide kvslide1 swiper-slide-duplicate" role="group" aria-label="1 / 3" data-swiper-slide-index="0" style="width: 1068px;"><h2>Slide one headline</h2><button class="signup">Start</button></div>
  </div>
  <div class="nav">
    <div class="swiper-button-prev" role="button" tabindex="0" aria-label="Previous slide" aria-controls="swiper-wrapper-1"></div>
    <div class="swiper-button-next" role="button" tabindex="0" aria-label="Next slide" aria-controls="swiper-wrapper-1"></div>
  </div>
</div>
<div class="swiper-pagination">
  <span id="b1" class="swiper-pagination-bullet swiper-pagination-bullet-active" tabindex="0" role="button" aria-label="Go to slide 1" aria-current="true"></span>
  <span id="b2" class="swiper-pagination-bullet" tabindex="0" role="button" aria-label="Go to slide 2"></span>
  <span id="b3" class="swiper-pagination-bullet" tabindex="0" role="button" aria-label="Go to slide 3"></span>
</div>
`;

class FakePort {
  readonly posts: unknown[] = [];
  readonly #listeners: Array<(message: unknown) => void> = [];
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => {
      this.#listeners.push(listener);
    },
    removeListener: vi.fn(),
  };
  readonly onDisconnect = { addListener: vi.fn(), removeListener: vi.fn() };
  readonly disconnect = vi.fn();
  constructor(readonly name: string) {}
  postMessage(message: unknown): void {
    this.posts.push(message);
  }
  emitMessage(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }
}

function rectList(): DOMRectList {
  const rect = {
    left: 0, top: 0, width: 320, height: 40, right: 320, bottom: 40, x: 0, y: 0,
    toJSON: () => ({}),
  };
  const list = [rect] as unknown as DOMRectList;
  Object.defineProperty(list, 'item', {
    value: (index: number) => (index === 0 ? rect : null),
  });
  return list;
}

function installPainted(document: Document, window: Window): void {
  for (const element of document.querySelectorAll('*')) {
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: rectList,
    });
  }
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    value: ((element: Element) => {
      const hidden = element.hasAttribute('hidden') ||
        element.getAttribute('aria-hidden') === 'true';
      return {
        display: hidden ? 'none' : 'block',
        visibility: 'visible',
        opacity: '1',
        overflowX: 'visible',
        overflowY: 'visible',
        backgroundColor: 'rgba(0, 0, 0, 0)',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' ? 'none'
            : name === 'content-visibility' ? 'visible'
              : name === 'clip' ? 'auto'
                : name === 'clip-path' ? 'none'
                  : name.startsWith('overflow') ? 'visible' : '',
      } as unknown as CSSStyleDeclaration;
    }) as Window['getComputedStyle'],
  });
}

function attributeRecord(
  target: Element,
  attributeName: string,
  oldValue: string | null,
): MutationRecord {
  return { type: 'attributes', target, attributeName, oldValue } as unknown as MutationRecord;
}

/** Applies one attribute value and returns the observer record for it. */
function setAttribute(target: Element, name: string, value: string): MutationRecord {
  const oldValue = target.getAttribute(name);
  target.setAttribute(name, value);
  return attributeRecord(target, name, oldValue);
}

function removeClasses(target: Element, ...classes: string[]): MutationRecord {
  const current = (target.getAttribute('class') ?? '').split(/\s+/u).filter(Boolean);
  return setAttribute(target, 'class', current.filter((token) => !classes.includes(token)).join(' '));
}

function addClass(target: Element, token: string): MutationRecord {
  return setAttribute(target, 'class', `${target.getAttribute('class') ?? ''} ${token}`.trim());
}

/**
 * The mutation records Swiper 8 produces for one slideNext(): the wrapper's
 * transition and transform written as two style values, every slide's state
 * classes removed and the new active/next/prev added, and the bullets and
 * their `aria-current` moved. `step` 0 moves from slide 1 to 2, and so on.
 */
function swiperMoveRecords(document: Document, step = 0): MutationRecord[] {
  const records: MutationRecord[] = [];
  const wrapper = document.querySelector('#swiper-wrapper-1')!;
  const slides = [...document.querySelectorAll('.swiper-slide')];
  const stateClasses = [
    'swiper-slide-active', 'swiper-slide-next', 'swiper-slide-prev',
    'swiper-slide-duplicate-active', 'swiper-slide-duplicate-next',
    'swiper-slide-duplicate-prev',
  ];
  const active = 2 + step;
  const at = (index: number) => slides[((index % slides.length) + slides.length) % slides.length]!;
  records.push(setAttribute(wrapper, 'style', `transition-duration: 300ms; transform: translate3d(-${1068 * (active - 1)}px, 0px, 0px);`));
  records.push(setAttribute(wrapper, 'style', `transition-duration: 300ms; transform: translate3d(-${1068 * active}px, 0px, 0px);`));
  for (const slide of slides) records.push(removeClasses(slide, ...stateClasses));
  records.push(addClass(at(active), 'swiper-slide-active'));
  records.push(addClass(at(active + 1), 'swiper-slide-next'));
  records.push(addClass(at(active - 1), 'swiper-slide-prev'));
  const bullets = [...document.querySelectorAll('.swiper-pagination-bullet')];
  const current = (1 + step) % bullets.length;
  for (const bullet of bullets) records.push(removeClasses(bullet, 'swiper-pagination-bullet-active'));
  records.push(addClass(bullets[current]!, 'swiper-pagination-bullet-active'));
  for (const [index, bullet] of bullets.entries()) {
    const previous = bullet.getAttribute('aria-current');
    if (index === current) {
      records.push(setAttribute(bullet, 'aria-current', 'true'));
    } else if (previous !== null) {
      bullet.removeAttribute('aria-current');
      records.push(attributeRecord(bullet, 'aria-current', previous));
    }
  }
  return records;
}

function sourceFixture(markup: string) {
  const { document, window } = parseHTML(`<!doctype html><html><head></head><body>${markup}</body></html>`);
  Object.defineProperty(window, 'top', { configurable: true, value: window });
  Object.defineProperty(document, 'baseURI', { configurable: true, value: 'https://example.test/' });
  installPainted(document as unknown as Document, window as unknown as Window);
  const port = new FakePort(createHtmlMirrorPortName(identity.sessionId));
  const registry = new WeakNodeIdRegistry();
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  let mutationCallback!: MutationCallback;
  new HtmlMirrorSourceSession({
    port: port as unknown as Browser.runtime.Port,
    document: document as unknown as Document,
    window: window as unknown as Window,
    registry,
    now: () => 1,
    createMutationObserver: (callback) => {
      mutationCallback = callback;
      return { observe: () => {}, disconnect: () => {} } as unknown as MutationObserver;
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
  const kinds = () => port.posts.map((message) => {
    const kind = (message as { kind: string }).kind.replace('simul:html-mirror-v2:', '');
    return kind === 'error' ? `error:${(message as { code: string }).code}` : kind;
  });
  return {
    document: document as unknown as Document,
    port,
    start: () => {
      port.emitMessage(createHtmlMirrorStart(identity, 'passive'));
      port.emitMessage(createHtmlMirrorAck(identity, 0));
    },
    mutate: (records: MutationRecord[]) => {
      mutationCallback(records, {} as MutationObserver);
      while (frames.length > 0) frames.shift()!();
    },
    checkpoints: () => port.posts.filter(
      (message): message is HtmlMirrorCheckpoint =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:checkpoint',
    ),
    patches: () => port.posts.filter(
      (message): message is HtmlMirrorPatchBatch =>
        (message as { kind?: string }).kind === 'simul:html-mirror-v2:patch',
    ),
    kinds,
  };
}

describe('carousel moves', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, { Node: window.Node, Element: window.Element, Text: window.Text });
  });

  it('mirrors a Swiper move as attribute patches, never as a secret rebuild', () => {
    const fixture = sourceFixture(CAROUSEL);
    fixture.start();
    const checkpoint = JSON.stringify(fixture.checkpoints()[0]);
    expect(checkpoint).toContain('Slide one headline');
    expect(checkpoint).toContain('https://example.test/kv.png');

    fixture.mutate(swiperMoveRecords(fixture.document));
    expect(fixture.kinds().filter((kind) => kind.startsWith('error'))).toEqual([]);
    const patch = fixture.patches().at(-1)!;
    expect(patch.operations.every((operation) => operation.kind === 'attributes')).toBe(true);
    const targets = patch.operations.map((operation) => operation.kind === 'attributes' ? operation.tagName : operation.kind);
    expect(targets).toContain('div');
    expect(targets).toContain('span');
    expect(JSON.stringify(patch)).toContain('swiper-slide-active');
    expect(JSON.stringify(patch)).not.toContain('opaquePlaceholder');
  });

  it('keeps every slide and bullet readable across three consecutive moves', () => {
    const fixture = sourceFixture(CAROUSEL);
    fixture.start();
    for (let move = 0; move < 3; move += 1) {
      fixture.mutate(swiperMoveRecords(fixture.document, move));
      fixture.port.emitMessage(createHtmlMirrorAck(identity, fixture.patches().at(-1)!.lastSequence));
    }
    expect(fixture.kinds().filter((kind) => kind.startsWith('error'))).toEqual([]);
    expect(fixture.patches().length).toBeGreaterThanOrEqual(3);
  });
});

describe('transient class boundaries', () => {
  const sourceWindow = {
    getComputedStyle: () => ({ getPropertyValue: () => 'none' }),
  } as unknown as Window;

  function twoClassRecords(element: Element): MutationRecord[] {
    return [
      attributeRecord(element, 'class', 'slide next'),
      attributeRecord(element, 'class', 'slide'),
    ];
  }

  it('does not turn a region holding only activation controls into a credential', () => {
    const { document } = parseHTML(
      '<html><body><div id="slide" class="slide active" role="group">' +
      '<button>Start</button><a href="/more">More</a><span role="button">Go</span>' +
      '<img src="/kv.png" alt="Banner"></div></body></html>',
    );
    const slide = document.querySelector('#slide')!;
    const classifier = new StickySourceSecretClassifier();
    rememberSourceMutationSecrets(twoClassRecords(slide), sourceWindow, classifier);
    expect(hasSourceCredentialSecretAncestor(slide, classifier, sourceWindow)).toBe(false);
    expect(hasSourceCredentialSecretAncestor(slide.querySelector('img')!, classifier, sourceWindow)).toBe(false);
  });

  it('does not turn a region holding a value-bearing control into a credential either (D75)', () => {
    // Frameworks set two classes on a form row on focus and input, and on
    // <body> when a dialog opens; the rule hid whole rows or pages.
    for (const control of [
      '<input type="text">',
      '<textarea></textarea>',
      '<select><option>a</option></select>',
      '<div contenteditable="true">draft</div>',
      '<div role="textbox">draft</div>',
      '<div role="switch" aria-checked="true">on</div>',
    ]) {
      const { document } = parseHTML(
        `<html><body><div id="region" class="slide active"><button>Start</button>${control}</div></body></html>`,
      );
      const region = document.querySelector('#region')!;
      const classifier = new StickySourceSecretClassifier();
      rememberSourceMutationSecrets(twoClassRecords(region), sourceWindow, classifier);
      expect(hasSourceCredentialSecretAncestor(region, classifier, sourceWindow), control).toBe(false);
    }
  });

  it('still remembers explicit masking evidence', () => {
    const { document } = parseHTML(
      '<html><body><div id="field" class="masked" role="textbox">4111</div>' +
      '<input id="shown" type="text"></body></html>',
    );
    const field = document.querySelector('#field')!;
    const shown = document.querySelector('#shown')!;
    const classifier = new StickySourceSecretClassifier();
    rememberSourceMutationSecrets([
      ...twoClassRecords(field),
      attributeRecord(field, 'style', '-webkit-text-security: disc'),
      attributeRecord(shown, 'type', 'password'),
    ], sourceWindow, classifier);
    expect(hasSourceCredentialSecretAncestor(field, classifier, sourceWindow)).toBe(true);
    expect(hasSourceCredentialSecretAncestor(shown, classifier, sourceWindow)).toBe(true);
  });
});
