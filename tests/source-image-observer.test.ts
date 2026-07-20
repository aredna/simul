import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  SourceImageObserver,
  type SourceImageObservationEvent,
} from '../lib/ocr/source-image-observer';
import { SourceImageModel } from '../lib/ocr/source-image-model';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const documentIdentity: ReplicaSourceDocumentIdentity = {
  sessionId: 'session-a',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document-a',
  frameId: 0,
};

describe('SourceImageObserver', () => {
  it('shares one observer set, emits only safe facts, and feeds revisioned model changes', () => {
    const fixture = createFixture();
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const firstEvents: SourceImageObservationEvent[] = [];
    const stopFirst = fixture.observer.subscribe((event) => {
      firstEvents.push(event);
      if (event.kind === 'upsert') model.upsert(event.input);
      else model.remove(event.document, event.nodeId);
    });

    expect(fixture.observer.readySummary).toEqual({
      candidateImages: 1,
      observedImages: 1,
    });

    expect(firstEvents).toMatchObject([
      {
        kind: 'upsert',
        input: {
          nodeId: 7,
          contentChanged: true,
          visibility: 'background',
          renderedWidth: 200,
          renderedHeight: 100,
          intrinsicWidth: 800,
          intrinsicHeight: 400,
        },
      },
    ]);
    expect(JSON.stringify(firstEvents)).not.toContain('private.example');
    expect(JSON.stringify(firstEvents)).not.toMatch(/(?:src|url|text|pixel|hash)/iu);
    expect(model.get(7)).toMatchObject({
      contentRevision: 1,
      observationRevision: 1,
    });

    const secondEvents: SourceImageObservationEvent[] = [];
    const stopSecond = fixture.observer.subscribe((event) => secondEvents.push(event));
    expect(secondEvents).toHaveLength(1);
    expect(fixture.intersections).toHaveLength(2);

    fixture.intersections[1]!.trigger(fixture.image, true);
    fixture.intersections[0]!.trigger(fixture.image, true);
    expect(firstEvents.at(-1)).toMatchObject({
      input: { visibility: 'visible', contentChanged: false },
    });
    expect(model.get(7)).toMatchObject({
      contentRevision: 1,
      observationRevision: 3,
    });

    fixture.image.setAttribute('src', 'https://private.example/changed.png');
    fixture.mutation.trigger([{
      type: 'attributes',
      target: fixture.image,
      attributeName: 'src',
    } as unknown as MutationRecord]);
    expect(firstEvents.at(-1)).toMatchObject({
      input: { contentChanged: true },
    });
    expect(model.get(7)).toMatchObject({
      contentRevision: 2,
      observationRevision: 4,
    });

    stopFirst();
    expect(fixture.intersections[0]!.disconnected).toBe(false);
    stopSecond();
    expect(fixture.intersections[0]!.disconnected).toBe(true);
    expect(fixture.intersections[1]!.disconnected).toBe(true);
    expect(fixture.resize.disconnected).toBe(true);
    expect(fixture.mutation.disconnected).toBe(true);
  });

  it('handles resize, mirror-ID reuse, removal, and late callbacks without stale upserts', () => {
    const fixture = createFixture();
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    fixture.bounds.width = 320;
    fixture.resize.trigger(fixture.image);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 7, renderedWidth: 320, contentChanged: false },
    });

    fixture.nodeIds.set(fixture.image, 11);
    fixture.resize.trigger(fixture.image);
    expect(events.slice(-2)).toMatchObject([
      { kind: 'remove', nodeId: 7 },
      { kind: 'upsert', input: { nodeId: 11, contentChanged: true } },
    ]);

    fixture.image.remove();
    fixture.intersections[0]!.trigger(fixture.image, true);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 11 });
    const countAfterRemove = events.length;
    fixture.intersections[1]!.trigger(fixture.image, true);
    fixture.resize.trigger(fixture.image);
    expect(events).toHaveLength(countAfterRemove);
    stop();
  });

  it('discovers late images and skips images inside private controls', () => {
    const fixture = createFixture('<button><img id="private" src="secret.png"></button>');
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toEqual([7]);
    expect(fixture.observer.readySummary).toEqual({
      candidateImages: 2,
      observedImages: 1,
    });

    const late = fixture.document.createElement('img');
    late.setAttribute('src', 'late.png');
    setImageMetrics(late, fixture.bounds);
    fixture.nodeIds.set(late, 19);
    fixture.document.body.append(late);
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.body,
      addedNodes: [late],
      removedNodes: [],
    } as unknown as MutationRecord]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 19 },
    });
    stop();
  });

  it('tracks load/currentSrc, picture source, and viewport geometry changes', () => {
    const fixture = createFixture(
      '<picture><source id="source" srcset="a.webp"><img id="picture" src="fallback.png"></picture>',
    );
    const pictureImage = fixture.document.querySelector<HTMLImageElement>('#picture')!;
    const source = fixture.document.querySelector('#source')!;
    setImageMetrics(pictureImage, fixture.bounds);
    fixture.nodeIds.set(pictureImage, 13);
    Object.defineProperty(fixture.image, 'currentSrc', {
      configurable: true,
      writable: true,
      value: 'https://private.example/original.png',
    });
    Object.defineProperty(pictureImage, 'currentSrc', {
      configurable: true,
      writable: true,
      value: 'a.webp',
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    (fixture.image as HTMLImageElement & { currentSrc: string }).currentSrc =
      'https://private.example/from-load.png';
    fixture.image.dispatchEvent(new fixture.document.defaultView!.Event('load', {
      bubbles: true,
    }));
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 7, contentChanged: true },
    });

    (pictureImage as HTMLImageElement & { currentSrc: string }).currentSrc =
      'b.webp';
    source.setAttribute('srcset', 'b.webp');
    fixture.mutation.trigger([{
      type: 'attributes',
      target: source,
      attributeName: 'srcset',
    } as unknown as MutationRecord]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 13, contentChanged: true },
    });

    fixture.bounds.height = 240;
    fixture.document.defaultView!.dispatchEvent(
      new fixture.document.defaultView!.Event('resize'),
    );
    expect(events.some((event) =>
      event.kind === 'upsert' &&
      event.input.nodeId === 13 &&
      event.input.renderedHeight === 240
    )).toBe(true);
    stop();
  });

  it('coalesces source scrolls and revises a still-visible image when its crop moves', () => {
    const fixture = createFixture();
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      if (event.kind === 'upsert') model.upsert(event.input);
    });
    fixture.intersections[0]!.trigger(fixture.image, true);
    const revisionBeforeScroll = model.get(7)?.observationRevision;
    events.length = 0;

    fixture.bounds.top = -50;
    const scroll = new fixture.document.defaultView!.Event('scroll');
    fixture.document.dispatchEvent(scroll);
    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );

    expect(fixture.frames.pending).toBe(1);
    expect(events).toEqual([]);
    fixture.frames.flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
        visibility: 'visible',
      },
    });
    expect(model.get(7)?.contentRevision).toBe(1);
    expect(model.get(7)?.observationRevision).toBe(
      (revisionBeforeScroll ?? 0) + 1,
    );
    stop();
  });

  it('cancels a production animation frame when observation stops', () => {
    const fixture = createFixture('', { useDefaultFrames: true });
    const view = fixture.document.defaultView!;
    const receivers: unknown[] = [];
    Object.defineProperties(view, {
      requestAnimationFrame: {
        configurable: true,
        value: function (this: unknown, callback: () => void): number {
          receivers.push(this);
          return fixture.frames.schedule(callback);
        },
      },
      cancelAnimationFrame: {
        configurable: true,
        value: function (this: unknown, frame: number): void {
          receivers.push(this);
          fixture.frames.cancel(frame);
        },
      },
    });
    const stop = fixture.observer.subscribe(() => undefined);
    fixture.intersections[0]!.trigger(fixture.image, true);

    fixture.document.dispatchEvent(new view.Event('scroll'));
    expect(fixture.frames.pending).toBe(1);

    stop();
    expect(fixture.frames.pending).toBe(0);
    expect(receivers).toEqual([view, view]);
  });

  it('fails closed on invalid dimensions without replaying an undefined event', () => {
    const fixture = createFixture();
    fixture.bounds.width = Number.NaN;
    const first: SourceImageObservationEvent[] = [];
    const second: SourceImageObservationEvent[] = [];
    const stopFirst = fixture.observer.subscribe((event) => first.push(event));
    const stopSecond = fixture.observer.subscribe((event) => second.push(event));

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    fixture.bounds.width = 200;
    fixture.observer.refreshAll();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    stopFirst();
    stopSecond();
  });

  it('guards stale callbacks across stop and restart generations', () => {
    const fixture = createFixture();
    const first: SourceImageObservationEvent[] = [];
    const stopFirst = fixture.observer.subscribe((event) => first.push(event));
    const staleVisible = fixture.intersections[0]!;
    const staleResize = fixture.resize.callback;
    const staleMutation = fixture.mutation.callback;
    stopFirst();

    const restarted: SourceImageObservationEvent[] = [];
    const stopRestarted = fixture.observer.subscribe((event) =>
      restarted.push(event),
    );
    expect(restarted).toHaveLength(1);
    staleVisible.trigger(fixture.image, true);
    staleResize([{
      target: fixture.image,
    } as unknown as ResizeObserverEntry]);
    staleMutation([{
      type: 'attributes',
      target: fixture.image,
      attributeName: 'src',
    } as unknown as MutationRecord]);
    expect(restarted).toHaveLength(1);
    stopRestarted();
  });

  it('reconsiders descendants when an ancestor privacy role changes', () => {
    const fixture = createFixture(
      '<div id="privacy"><img id="role-image" src="role.png"></div>',
    );
    const wrapper = fixture.document.querySelector('#privacy')!;
    const roleImage = fixture.document.querySelector<HTMLImageElement>(
      '#role-image',
    )!;
    setImageMetrics(roleImage, fixture.bounds);
    fixture.nodeIds.set(roleImage, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toEqual([7, 19]);

    wrapper.setAttribute('role', 'checkbox');
    fixture.mutation.trigger([{
      type: 'attributes',
      target: wrapper,
      attributeName: 'role',
    } as unknown as MutationRecord]);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });

    wrapper.removeAttribute('role');
    fixture.mutation.trigger([{
      type: 'attributes',
      target: wrapper,
      attributeName: 'role',
    } as unknown as MutationRecord]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 19, contentChanged: true },
    });

    wrapper.setAttribute('contenteditable', '');
    fixture.mutation.trigger([{
      type: 'attributes',
      target: wrapper,
      attributeName: 'contenteditable',
    } as unknown as MutationRecord]);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });
    wrapper.setAttribute('contenteditable', 'false');
    fixture.mutation.trigger([{
      type: 'attributes',
      target: wrapper,
      attributeName: 'contenteditable',
    } as unknown as MutationRecord]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 19, contentChanged: true },
    });
    stop();
  });

  it('admits capacity-skipped images deterministically when a slot opens', () => {
    const fixture = createFixture(
      '<img id="second" src="second.png">',
      { maxImages: 1 },
    );
    const second = fixture.document.querySelector<HTMLImageElement>('#second')!;
    setImageMetrics(second, fixture.bounds);
    fixture.nodeIds.set(second, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toEqual([7]);

    fixture.image.remove();
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.body,
      addedNodes: [],
      removedNodes: [fixture.image],
    } as unknown as MutationRecord]);
    expect(events.slice(-2).map(eventNodeId)).toEqual([7, 19]);
    expect(events.slice(-2).map((event) => event.kind)).toEqual([
      'remove',
      'upsert',
    ]);
    stop();
  });

  it('keeps oversized private tokens stable between explicit source mutations', () => {
    const fixture = createFixture();
    fixture.image.setAttribute('src', `https://example.test/${'x'.repeat(70_000)}`);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    fixture.resize.trigger(fixture.image);

    expect(events).toHaveLength(1);
    fixture.mutation.trigger([{
      type: 'attributes',
      target: fixture.image,
      attributeName: 'src',
    } as unknown as MutationRecord]);

    expect(events).toHaveLength(2);
    expect(events).toMatchObject([
      { kind: 'upsert', input: { contentChanged: true } },
      { kind: 'upsert', input: { contentChanged: true } },
    ]);
    expect(JSON.stringify(events)).not.toContain('x'.repeat(1_000));
    stop();
  });

  it('invalidates image content routing when an ancestor lang changes', () => {
    const fixture = createFixture();
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    fixture.document.body.setAttribute('lang', 'ja');
    fixture.mutation.trigger([{
      type: 'attributes',
      target: fixture.document.body,
      attributeName: 'lang',
    } as unknown as MutationRecord]);

    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 7, contentChanged: true },
    });
    stop();
  });

  it('uses duplicate-subscription errors and subscriber snapshots deterministically', () => {
    const fixture = createFixture();
    const deliveries: string[] = [];
    let mutateSubscribers = false;
    let stopSecond: () => void = () => undefined;
    let stopThird: () => void = () => undefined;
    const third = () => deliveries.push('third');
    const first = () => {
      deliveries.push('first');
      if (!mutateSubscribers) return;
      stopSecond();
      stopThird = fixture.observer.subscribe(third);
      mutateSubscribers = false;
    };
    const second = () => deliveries.push('second');
    const stopFirst = fixture.observer.subscribe(first);
    stopSecond = fixture.observer.subscribe(second);
    expect(() => fixture.observer.subscribe(first)).toThrow(
      'already subscribed',
    );
    deliveries.length = 0;
    mutateSubscribers = true;
    fixture.intersections[0]!.trigger(fixture.image, true);

    expect(deliveries).toEqual(['first', 'third', 'second']);
    stopFirst();
    stopSecond();
    stopThird();
  });
});

function createFixture(
  extraHtml = '',
  options: {
    readonly maxImages?: number;
    readonly useDefaultFrames?: boolean;
  } = {},
) {
  const { document } = parseHTML(
    `<html><body><img id="main" src="https://private.example/original.png">${extraHtml}</body></html>`,
  );
  const image = document.querySelector<HTMLImageElement>('#main')!;
  const privateImage = document.querySelector<HTMLImageElement>('#private');
  const bounds = { left: 0, top: 0, width: 200, height: 100 };
  setImageMetrics(image, bounds);
  if (privateImage) setImageMetrics(privateImage, bounds);
  const nodeIds = new Map<HTMLImageElement, number>([[image, 7]]);
  if (privateImage) nodeIds.set(privateImage, 9);
  const intersections: FakeIntersectionObserver[] = [];
  const resize = new FakeResizeObserver();
  const mutation = new FakeMutationObserver();
  const frames = new FakeFrameScheduler();
  const observer = new SourceImageObserver({
    document: document as unknown as Document,
    documentIdentity,
    getNodeId: (candidate) => nodeIds.get(candidate),
    createIntersectionObserver: (callback) => {
      const fake = new FakeIntersectionObserver(callback);
      intersections.push(fake);
      return fake;
    },
    createResizeObserver: (callback) => {
      resize.callback = callback;
      return resize;
    },
    createMutationObserver: (callback) => {
      mutation.callback = callback;
      return mutation;
    },
    ...(options.useDefaultFrames
      ? {}
      : {
          scheduleFrame: (callback: () => void) => frames.schedule(callback),
          cancelFrame: (frame: number) => frames.cancel(frame),
        }),
    ...(options.maxImages === undefined
      ? {}
      : { maxImages: options.maxImages }),
  });
  return {
    document,
    image,
    bounds,
    nodeIds,
    observer,
    intersections,
    resize,
    mutation,
    frames,
  };
}

function setImageMetrics(
  image: HTMLImageElement,
  bounds: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 800 },
    naturalHeight: { configurable: true, value: 400 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        x: bounds.left,
        y: bounds.top,
        top: bounds.top,
        left: bounds.left,
        right: bounds.left + bounds.width,
        bottom: bounds.top + bounds.height,
        width: bounds.width,
        height: bounds.height,
        toJSON: () => undefined,
      }),
    },
  });
}

class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(
    readonly callback: (entries: readonly IntersectionObserverEntry[]) => void,
  ) {}

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }

  trigger(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry]);
  }
}

class FakeResizeObserver {
  callback: (entries: readonly ResizeObserverEntry[]) => void = () => undefined;
  readonly targets = new Set<Element>();
  disconnected = false;

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.targets.clear();
  }

  trigger(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry]);
  }
}

class FakeMutationObserver {
  callback: (records: readonly MutationRecord[]) => void = () => undefined;
  disconnected = false;

  observe(): void {}

  disconnect(): void {
    this.disconnected = true;
  }

  trigger(records: readonly MutationRecord[]): void {
    this.callback(records);
  }
}

class FakeFrameScheduler {
  readonly #callbacks = new Map<number, () => void>();
  #sequence = 0;

  get pending(): number {
    return this.#callbacks.size;
  }

  schedule(callback: () => void): number {
    const frame = ++this.#sequence;
    this.#callbacks.set(frame, callback);
    return frame;
  }

  cancel(frame: number): void {
    this.#callbacks.delete(frame);
  }

  flush(): void {
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

function eventNodeId(event: SourceImageObservationEvent): number {
  return event.kind === 'upsert' ? event.input.nodeId : event.nodeId;
}
