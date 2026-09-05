import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  MAX_SOURCE_IMAGE_IDENTITY_RETRY_FRAMES,
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
  it('waits for both initial visibility tiers before scheduling an image', () => {
    const fixture = createFixture('', { settleIntersectionsOnObserve: false });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    expect(events).toEqual([]);
    fixture.intersections[1]!.trigger(fixture.image, true);
    expect(events).toEqual([]);
    fixture.intersections[0]!.trigger(fixture.image, true);
    expect(events).toMatchObject([
      { kind: 'upsert', input: { visibility: 'visible' } },
    ]);
    expect(events.some((event) =>
      event.kind === 'upsert' && event.input.visibility === 'background'
    )).toBe(false);
    stop();
  });

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
    expect(events.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'upsert',
        input: expect.objectContaining({ nodeId: 19 }),
      }),
      expect.objectContaining({
        kind: 'upsert',
        input: expect.objectContaining({
          nodeId: 7,
          observationChanged: true,
        }),
      }),
    ]));
    stop();
  });

  it('discovers an external SVG img without exposing its resource URL', () => {
    const fixture = createFixture(
      '<img id="external-svg" src="https://assets.example/header_logo.svg">',
    );
    const svg = fixture.document.querySelector<HTMLImageElement>(
      '#external-svg',
    )!;
    setImageMetrics(svg, { left: 20, top: 30, width: 275, height: 30 });
    fixture.nodeIds.set(svg, 23);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'upsert',
        input: expect.objectContaining({
          nodeId: 23,
          renderedWidth: 275,
          renderedHeight: 30,
        }),
      }),
    ]));
    expect(JSON.stringify(events)).not.toContain('header_logo.svg');
    expect(JSON.stringify(events)).not.toContain('assets.example');
    stop();
  });

  it('discovers images in stable viewport-attention order without exposing coordinates', () => {
    const fixture = createFixture(
      '<img id="middle" src="middle.png"><img id="top" src="top.png">',
    );
    const middle = fixture.document.querySelector<HTMLImageElement>('#middle')!;
    const top = fixture.document.querySelector<HTMLImageElement>('#top')!;
    fixture.bounds.top = -50;
    setImageMetrics(middle, { left: 300, top: 40, width: 200, height: 100 });
    setImageMetrics(top, { left: 20, top: 40, width: 200, height: 100 });
    fixture.nodeIds.set(middle, 19);
    fixture.nodeIds.set(top, 23);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    expect(events.map(eventNodeId)).toEqual([23, 19, 7]);
    for (const event of events) {
      if (event.kind !== 'upsert') continue;
      expect(Object.keys(event.input)).not.toEqual(expect.arrayContaining([
        'left',
        'top',
        'visibleRatio',
        'area',
      ]));
    }
    stop();
  });

  it('admits the most visible image first when discovery exceeds the capacity', () => {
    // Two offscreen images precede the visible one in DOM order and the
    // observer has room for a single image. Ranking by attention must decide
    // admission, not the DOM-order prefix the traversal happened to reach.
    const fixture = createFixture(
      '<img id="far-a" src="far-a.png"><img id="far-b" src="far-b.png">',
      { maxImages: 1 },
    );
    const farA = fixture.document.querySelector<HTMLImageElement>('#far-a')!;
    const farB = fixture.document.querySelector<HTMLImageElement>('#far-b')!;
    setImageMetrics(farA, { left: 20, top: 9_000, width: 200, height: 100 });
    setImageMetrics(farB, { left: 20, top: 9_400, width: 200, height: 100 });
    fixture.nodeIds.set(farA, 31);
    fixture.nodeIds.set(farB, 37);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    expect(events.map(eventNodeId)).toEqual([7]);
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
      input: { nodeId: 7, contentChanged: true, captureChanged: true },
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

  it('coalesces scrolls, ignores fully-visible movement, and revises clipping', () => {
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

    fixture.bounds.top = 50;
    const scroll = new fixture.document.defaultView!.Event('scroll');
    fixture.document.dispatchEvent(scroll);
    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );

    expect(fixture.frames.pending).toBe(1);
    expect(events).toEqual([]);
    fixture.frames.flush();
    expect(events).toEqual([]);
    expect(model.get(7)?.observationRevision).toBe(revisionBeforeScroll);

    fixture.bounds.top = -50;
    fixture.document.dispatchEvent(scroll);
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

  it('advances only visible images that newly overlap a fixed control on scroll', () => {
    const fixture = createFixture(
      '<input id="fixed-control" type="password">' +
        '<img id="distant" src="distant.png">',
    );
    const control = fixture.document.querySelector('#fixed-control')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    const controlBounds = { left: 320, top: 0, width: 80, height: 40 };
    setElementBounds(control, controlBounds);
    setImageMetrics(distant, { left: 600, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    fixture.intersections[0]!.trigger(fixture.image, true);
    fixture.intersections[0]!.trigger(distant, true);
    events.length = 0;

    controlBounds.left = 40;
    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );
    fixture.frames.flush();

    expect(events.map(eventNodeId)).toEqual([7]);
    expect(events[0]).toMatchObject({
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    });
    stop();
  });

  it('keeps capture revisions stable when scrolling preserves control overlap', () => {
    const fixture = createFixture(
      '<input id="fixed-control" type="password">',
    );
    const control = fixture.document.querySelector('#fixed-control')!;
    const controlBounds = { left: 40, top: 0, width: 80, height: 40 };
    setElementBounds(control, controlBounds);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    fixture.intersections[0]!.trigger(fixture.image, true);
    const captureRevision = model.get(7)?.captureRevision;
    events.length = 0;

    for (const offset of [20, 40, 60]) {
      fixture.bounds.left = offset;
      controlBounds.left = offset + 40;
      fixture.document.dispatchEvent(
        new fixture.document.defaultView!.Event('scroll'),
      );
      fixture.frames.flush();
    }

    expect(events).toEqual([]);
    expect(model.get(7)?.captureRevision).toBe(captureRevision);
    stop();
  });

  it('invalidates clear endpoints when a control crosses an image between scroll frames', () => {
    const fixture = createFixture(
      '<input id="crossing-control" type="password">',
    );
    const control = fixture.document.querySelector('#crossing-control')!;
    const controlBounds = { left: 320, top: 0, width: 40, height: 40 };
    setElementBounds(control, controlBounds);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    fixture.intersections[0]!.trigger(fixture.image, true);
    events.length = 0;

    controlBounds.left = -80;
    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );
    fixture.frames.flush();

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    stop();
  });

  it('does not rescan unrelated control classification on stable scroll', () => {
    const fixture = createFixture(
      '<input id="unrelated-control" type="password">',
    );
    const control = fixture.document.querySelector('#unrelated-control')!;
    setElementBounds(control, { left: 600, top: 0, width: 80, height: 40 });
    const stop = fixture.observer.subscribe(() => undefined);
    fixture.intersections[0]!.trigger(fixture.image, true);
    let classificationReads = 0;
    const matches = control.matches;
    Object.defineProperty(control, 'matches', {
      configurable: true,
      value(this: Element, selector: string): boolean {
        classificationReads += 1;
        return matches.call(this, selector);
      },
    });

    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );
    fixture.frames.flush();

    expect(classificationReads).toBe(0);
    stop();
  });

  it('advances only images swept by responsive control reflow on resize', () => {
    const fixture = createFixture(
      '<input id="responsive-control" type="password">' +
        '<img id="distant" src="distant.png">',
    );
    const control = fixture.document.querySelector('#responsive-control')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    const controlBounds = { left: 320, top: 0, width: 80, height: 40 };
    setElementBounds(control, controlBounds);
    setImageMetrics(distant, { left: 600, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    controlBounds.left = 40;
    fixture.document.defaultView!.dispatchEvent(
      new fixture.document.defaultView!.Event('resize'),
    );

    expect(events.map(eventNodeId)).toEqual([7]);
    expect(events[0]).toMatchObject({
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    });
    stop();
  });

  it('tracks nested overflow crops without revising fully exposed pixels', () => {
    const fixture = createFixture(
      '<div id="clip"><img id="nested" src="nested.png"></div>',
    );
    const clip = fixture.document.querySelector('#clip')!;
    const nested = fixture.document.querySelector<HTMLImageElement>('#nested')!;
    const clipBounds = { left: 0, top: 100, width: 240, height: 160 };
    const nestedBounds = { left: 20, top: 80, width: 120, height: 100 };
    setElementBounds(clip, clipBounds);
    setImageMetrics(nested, nestedBounds);
    fixture.nodeIds.set(nested, 19);
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: '1',
        clipPath: 'none',
        maskImage: 'none',
        perspective: 'none',
        rotate: 'none',
        transform: 'none',
        overflowX: element === clip ? 'hidden' : 'visible',
        overflowY: element === clip ? 'auto' : 'visible',
        getPropertyValue: () => '',
      }),
    });
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      if (event.kind === 'upsert') model.upsert(event.input);
    });
    fixture.intersections[0]!.trigger(nested, true);
    events.length = 0;
    const initialRevision = model.get(19)?.observationRevision;

    nestedBounds.top = 60;
    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );
    fixture.frames.flush();
    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 19,
        contentChanged: false,
        observationChanged: true,
      },
    }]);
    expect(model.get(19)).toMatchObject({
      contentRevision: 1,
      observationRevision: (initialRevision ?? 0) + 1,
    });

    nestedBounds.top = 120;
    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );
    fixture.frames.flush();
    events.length = 0;
    const fullyVisibleRevision = model.get(19)?.observationRevision;

    nestedBounds.top = 130;
    fixture.document.dispatchEvent(
      new fixture.document.defaultView!.Event('scroll'),
    );
    fixture.frames.flush();
    expect(events).toEqual([]);
    expect(model.get(19)?.observationRevision).toBe(fullyVisibleRevision);
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

  it('recovers a late mirror identity without inventing a node ID', () => {
    const fixture = createFixture();
    fixture.nodeIds.delete(fixture.image);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    expect(fixture.observer.readySummary).toEqual({
      candidateImages: 1,
      observedImages: 0,
    });
    expect(events).toEqual([]);
    expect(fixture.frames.pending).toBe(1);

    fixture.frames.flush();
    expect(events).toEqual([]);
    fixture.nodeIds.set(fixture.image, 37);
    fixture.frames.flush();

    expect(events).toMatchObject([
      { kind: 'upsert', input: { nodeId: 37, contentChanged: true } },
    ]);
    expect(JSON.stringify(events)).not.toContain('private.example');
    expect(fixture.frames.pending).toBe(0);
    stop();
  });

  it('bounds retries for an image never assigned to its mirror', () => {
    const fixture = createFixture();
    fixture.nodeIds.delete(fixture.image);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    for (let attempt = 0; attempt < MAX_SOURCE_IMAGE_IDENTITY_RETRY_FRAMES; attempt += 1) {
      expect(fixture.frames.pending).toBe(1);
      fixture.frames.flush();
    }
    expect(fixture.frames.pending).toBe(0);
    expect(events).toEqual([]);

    // A recorder full-snapshot synchronization may still explicitly recover
    // the same document after the autonomous retry budget is exhausted.
    fixture.nodeIds.set(fixture.image, 41);
    fixture.observer.refreshAll();
    expect(events).toMatchObject([
      { kind: 'upsert', input: { nodeId: 41 } },
    ]);
    expect(fixture.frames.pending).toBe(0);
    stop();
  });

  it('releases an exhausted identity slot for a later image', () => {
    const fixture = createFixture('', { maxImages: 1 });
    fixture.nodeIds.delete(fixture.image);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    for (let attempt = 0; attempt < MAX_SOURCE_IMAGE_IDENTITY_RETRY_FRAMES; attempt += 1) {
      fixture.frames.flush();
    }
    const late = fixture.document.createElement('img');
    setImageMetrics(late, fixture.bounds);
    fixture.document.body.append(late);
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.body,
      addedNodes: [late],
      removedNodes: [],
    } as unknown as MutationRecord]);
    expect(fixture.frames.pending).toBe(1);

    fixture.nodeIds.set(late, 43);
    fixture.frames.flush();
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 43 },
    });
    stop();
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

    wrapper.setAttribute('autocomplete', 'one-time-code');
    fixture.mutation.trigger([attributeRecord(wrapper, 'autocomplete')]);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });
    const afterSecret = events.length;
    wrapper.removeAttribute('autocomplete');
    fixture.mutation.trigger([attributeRecord(wrapper, 'autocomplete')]);
    expect(events).toHaveLength(afterSecret);
    stop();
  });

  it('invalidates descendants for computed-security class and stylesheet changes', () => {
    let stylesheetSecret = false;
    const fixture = createFixture(
      '<style id="rules"></style><div id="privacy"><img id="styled"></div>',
      {
        isPrivateImage: (image) =>
          stylesheetSecret || Boolean(image.closest('.text-security')),
      },
    );
    const wrapper = fixture.document.querySelector('#privacy')!;
    const styled = fixture.document.querySelector<HTMLImageElement>('#styled')!;
    const rules = fixture.document.querySelector('#rules')!;
    setImageMetrics(styled, fixture.bounds);
    fixture.nodeIds.set(styled, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toEqual([7, 19]);

    wrapper.classList.add('text-security');
    fixture.mutation.trigger([attributeRecord(wrapper, 'class')]);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });

    wrapper.classList.remove('text-security');
    fixture.mutation.trigger([attributeRecord(wrapper, 'class')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 19, contentChanged: true },
    });

    stylesheetSecret = true;
    const ruleText = fixture.document.createTextNode(
      '.secret {-webkit-text-security: disc}',
    );
    rules.append(ruleText);
    fixture.mutation.trigger([{
      type: 'characterData',
      target: ruleText,
    } as unknown as MutationRecord]);
    expect(events.slice(-2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'remove', nodeId: 7 }),
      expect.objectContaining({ kind: 'remove', nodeId: 19 }),
    ]));
    stop();
  });

  it('coalesces broad class and style churn when image routing facts stay equal', () => {
    const fixture = createFixture(
      '<section id="shell"><img id="stable" src="stable.png" alt="News"></section>',
    );
    const shell = fixture.document.querySelector('#shell')!;
    const stable = fixture.document.querySelector<HTMLImageElement>('#stable')!;
    setImageMetrics(stable, fixture.bounds);
    fixture.nodeIds.set(stable, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toEqual([7, 19]);

    const beforeFrameworkChurn = events.length;
    fixture.document.body.classList.add('hydrated');
    shell.setAttribute('style', '--theme-state: ready');
    fixture.mutation.trigger([
      attributeRecord(fixture.document.body, 'class'),
      attributeRecord(shell, 'style'),
    ]);

    expect(events).toHaveLength(beforeFrameworkChurn);

    stable.setAttribute('alt', 'Updated news');
    fixture.mutation.trigger([attributeRecord(stable, 'alt')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 19, contentChanged: true },
    });
    stop();
  });

  it('invalidates when a class mutation materially changes computed visibility', () => {
    const fixture = createFixture(
      '<section id="shell"><img id="styled-visible" src="stable.png"></section>',
    );
    const shell = fixture.document.querySelector('#shell')!;
    const styled = fixture.document.querySelector<HTMLImageElement>(
      '#styled-visible',
    )!;
    setImageMetrics(styled, fixture.bounds);
    fixture.nodeIds.set(styled, 19);
    let imageVisibility = 'visible';
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: element === styled ? imageVisibility : 'visible',
        contentVisibility: 'visible',
        opacity: '1',
        clipPath: 'none',
        maskImage: 'none',
        perspective: 'none',
        rotate: 'none',
        transform: 'none',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    imageVisibility = 'hidden';
    shell.classList.add('collapsed');
    fixture.mutation.trigger([attributeRecord(shell, 'class')]);

    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: {
        nodeId: 19,
        contentChanged: false,
        observationChanged: true,
      },
    });
    stop();
  });

  it('coalesces safe carousel translation and invalidates unsafe transforms', () => {
    const fixture = createFixture(
      '<section id="carousel"><img id="slide" src="slide.png"></section>',
    );
    const carousel = fixture.document.querySelector('#carousel')!;
    const slide = fixture.document.querySelector<HTMLImageElement>('#slide')!;
    setImageMetrics(slide, fixture.bounds);
    fixture.nodeIds.set(slide, 19);
    let carouselTransform =
      'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -200, 0, 0, 1)';
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: '1',
        clipPath: 'none',
        maskImage: 'none',
        perspective: 'none',
        rotate: 'none',
        scale: 'none',
        transform: element === carousel ? carouselTransform : 'none',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    const initialEvents = events.length;

    carouselTransform =
      'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -400, 0, 0, 1)';
    carousel.setAttribute('style', 'transform: translate3d(-400px, 0, 0)');
    fixture.mutation.trigger([attributeRecord(carousel, 'style')]);
    expect(events).toHaveLength(initialEvents);

    carouselTransform = 'matrix(0, 1, -1, 0, 0, 0)';
    carousel.setAttribute('style', 'transform: rotate(90deg)');
    fixture.mutation.trigger([attributeRecord(carousel, 'style')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: {
        nodeId: 19,
        contentChanged: false,
        observationChanged: true,
      },
    });
    stop();
  });

  it('reconsiders a partially clipped carousel image once after motion settles', () => {
    const fixture = createFixture(
      '<section id="carousel"><img id="settling-slide" src="slide.png"></section>',
    );
    const carousel = fixture.document.querySelector('#carousel')!;
    const slide = fixture.document.querySelector<HTMLImageElement>(
      '#settling-slide',
    )!;
    const slideBounds = { left: -80, top: 20, width: 200, height: 100 };
    setImageMetrics(slide, slideBounds);
    const readSlideBounds = slide.getBoundingClientRect.bind(slide);
    let settleGeometryReads = 0;
    Object.defineProperty(slide, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        settleGeometryReads += 1;
        return readSlideBounds();
      },
    });
    fixture.nodeIds.set(slide, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;
    settleGeometryReads = 0;

    slideBounds.left = 20;
    carousel.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    carousel.dispatchEvent(new fixture.document.defaultView!.Event(
      'animationend',
      { bubbles: true },
    ));

    expect(fixture.frames.pending).toBe(1);
    expect(events).toEqual([]);
    expect(settleGeometryReads).toBe(0);
    fixture.frames.flush();
    expect(settleGeometryReads).toBe(1);
    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 19,
        contentChanged: false,
        observationChanged: true,
      },
    }]);

    events.length = 0;
    carousel.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    fixture.frames.flush();
    expect(events).toEqual([]);
    expect(fixture.frames.pending).toBe(0);
    stop();
  });

  it('coalesces an image-class burst to one selector proof and changed slides', () => {
    let globalRefreshes = 0;
    const fixture = createFixture(
      '<img id="slide-a" class="current"><img id="slide-b">' +
        '<img id="stable-slide">',
      { beforeRefreshAll: () => { globalRefreshes += 1; } },
    );
    const slideA = fixture.document.querySelector<HTMLImageElement>('#slide-a')!;
    const slideB = fixture.document.querySelector<HTMLImageElement>('#slide-b')!;
    const stable = fixture.document.querySelector<HTMLImageElement>('#stable-slide')!;
    for (const [image, nodeId] of [
      [slideA, 19],
      [slideB, 20],
      [stable, 21],
    ] as const) {
      setImageMetrics(image, fixture.bounds);
      fixture.nodeIds.set(image, nodeId);
    }
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: element === slideA || element === slideB
          ? (element.classList.contains('current') ? '1' : '0')
          : '1',
        clipPath: 'none',
        maskImage: 'none',
        perspective: 'none',
        rotate: 'none',
        scale: 'none',
        transform: 'none',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    slideA.classList.remove('current');
    slideB.classList.add('current');
    fixture.mutation.trigger([
      attributeRecord(slideA, 'class'),
      attributeRecord(slideB, 'class'),
    ]);
    slideA.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    slideB.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();

    expect(events.map(eventNodeId)).toEqual([19, 20]);
    expect(events.every((event) =>
      event.kind === 'upsert' && event.input.captureChanged === true
    )).toBe(true);
    expect(globalRefreshes).toBe(1);
    stop();
  });

  it('observes arbitrary selector attributes but advances only changed images', () => {
    const fixture = createFixture(
      '<section id="state-shell" data-state="shown">' +
        '<img id="state-image" src="state.png"></section>' +
        '<img id="stable-image" src="stable.png">',
    );
    const shell = fixture.document.querySelector<HTMLElement>('#state-shell')!;
    const affected = fixture.document.querySelector<HTMLImageElement>(
      '#state-image',
    )!;
    const stable = fixture.document.querySelector<HTMLImageElement>(
      '#stable-image',
    )!;
    setImageMetrics(affected, fixture.bounds);
    setImageMetrics(stable, fixture.bounds);
    fixture.nodeIds.set(affected, 19);
    fixture.nodeIds.set(stable, 20);
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: element === affected && shell.dataset.state === 'hidden'
          ? '0'
          : '1',
        clipPath: 'none',
        maskImage: 'none',
        perspective: 'none',
        rotate: 'none',
        scale: 'none',
        transform: 'none',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    shell.dataset.state = 'hidden';
    fixture.mutation.trigger([attributeRecord(shell, 'data-state')]);

    expect(events.map(eventNodeId)).toEqual([19]);
    expect(events[0]).toMatchObject({
      kind: 'upsert',
      input: { observationChanged: true },
    });
    expect(fixture.mutation.options?.attributeFilter).toBeUndefined();
    stop();
  });

  it('performs one bounded selector-safety scan for known attributes', () => {
    const fixture = createFixture(
      '<section id="label-shell"><span id="filler"></span></section>',
    );
    const shell = fixture.document.querySelector('#label-shell')!;
    const filler = fixture.document.querySelector('#filler')!;
    const stop = fixture.observer.subscribe(() => undefined);
    let descendantMatches = 0;
    const matches = filler.matches;
    Object.defineProperty(filler, 'matches', {
      configurable: true,
      value(this: Element, selector: string): boolean {
        descendantMatches += 1;
        return matches.call(this, selector);
      },
    });

    shell.setAttribute('aria-label', 'Updated public label');
    fixture.mutation.trigger([attributeRecord(shell, 'aria-label')]);

    expect(descendantMatches).toBe(1);
    stop();
  });

  it('detects a sibling class that changes image object positioning', () => {
    const fixture = createFixture('<button id="remote-state">State</button>');
    const state = fixture.document.querySelector('#remote-state')!;
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block', visibility: 'visible', opacity: '1', filter: 'none',
        mixBlendMode: 'normal', objectFit: 'cover',
        objectPosition: element === fixture.image && state.classList.contains('right')
          ? '100% 50%'
          : '0% 50%',
        imageRendering: 'auto', overflowX: 'visible', overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    state.classList.add('right');
    fixture.mutation.trigger([attributeRecord(state, 'class')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: { nodeId: 7, observationChanged: true, captureChanged: true },
    }]);
    stop();
  });

  it('reroutes remote images for known attributes and image-bearing class targets', () => {
    const fixture = createFixture(
      '<section id="remote-state"><img id="contained" src="inside.png"></section>' +
        '<img id="remote-image" src="remote.png">',
    );
    const state = fixture.document.querySelector('#remote-state')!;
    const contained = fixture.document.querySelector<HTMLImageElement>('#contained')!;
    const remote = fixture.document.querySelector<HTMLImageElement>('#remote-image')!;
    setImageMetrics(contained, fixture.bounds);
    setImageMetrics(remote, fixture.bounds);
    fixture.nodeIds.set(contained, 19);
    fixture.nodeIds.set(remote, 20);
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block', visibility: 'visible', opacity: '1', filter: 'none',
        mixBlendMode: 'normal', objectFit: 'cover',
        objectPosition: element === remote
          ? state.getAttribute('aria-expanded') === 'true'
            ? '50% 50%'
            : state.classList.contains('active')
              ? '100% 50%'
              : '0% 50%'
          : '50% 50%',
        imageRendering: 'auto', overflowX: 'visible', overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;
    let containedGeometryReads = 0;
    let remoteGeometryReads = 0;
    const readContainedBounds = contained.getBoundingClientRect.bind(contained);
    const readRemoteBounds = remote.getBoundingClientRect.bind(remote);
    Object.defineProperty(contained, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        containedGeometryReads += 1;
        return readContainedBounds();
      },
    });
    Object.defineProperty(remote, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        remoteGeometryReads += 1;
        return readRemoteBounds();
      },
    });

    state.setAttribute('aria-expanded', 'true');
    fixture.mutation.trigger([attributeRecord(state, 'aria-expanded')]);
    expect(events.map(eventNodeId)).toEqual([19, 20]);
    expect(containedGeometryReads).toBe(1);
    expect(remoteGeometryReads).toBe(1);

    events.length = 0;
    containedGeometryReads = 0;
    remoteGeometryReads = 0;
    state.removeAttribute('aria-expanded');
    state.classList.add('active');
    fixture.mutation.trigger([
      attributeRecord(state, 'aria-expanded'),
      attributeRecord(state, 'class'),
    ]);
    expect(events.map(eventNodeId)).toEqual([19, 20]);
    expect(containedGeometryReads).toBe(1);
    expect(remoteGeometryReads).toBe(1);
    stop();
  });

  it('reroutes remote images for character-data and child-presence selectors', () => {
    const fixture = createFixture(
      '<div id="selector-marker"></div><img id="remote-image" src="remote.png">',
    );
    const marker = fixture.document.querySelector('#selector-marker')!;
    const remote = fixture.document.querySelector<HTMLImageElement>('#remote-image')!;
    const markerText = fixture.document.createTextNode('');
    marker.append(markerText);
    setImageMetrics(remote, fixture.bounds);
    fixture.nodeIds.set(remote, 19);
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block', visibility: 'visible', opacity: '1', filter: 'none',
        mixBlendMode: 'normal', objectFit: 'cover',
        objectPosition: element === remote && marker.childNodes.length > 0 &&
            marker.textContent
          ? '100% 50%'
          : '0% 50%',
        imageRendering: 'auto', overflowX: 'visible', overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    markerText.data = 'active';
    fixture.mutation.trigger([{
      type: 'characterData',
      target: markerText,
    } as unknown as MutationRecord]);
    expect(events.map(eventNodeId)).toEqual([19]);

    events.length = 0;
    markerText.remove();
    fixture.mutation.trigger([{
      type: 'childList',
      target: marker,
      addedNodes: [],
      removedNodes: [markerText],
    } as unknown as MutationRecord]);
    expect(events.map(eventNodeId)).toEqual([19]);
    stop();
  });

  it('includes image background and border pixels in capture currency', () => {
    const fixture = createFixture();
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block', visibility: 'visible', opacity: '1', filter: 'none',
        mixBlendMode: 'normal', objectFit: 'cover', objectPosition: '50% 50%',
        imageRendering: 'auto', overflowX: 'visible', overflowY: 'visible',
        background: element === fixture.image && element.classList.contains('painted')
          ? 'rgb(1, 2, 3)'
          : 'none',
        border: element === fixture.image && element.classList.contains('painted')
          ? '2px solid rgb(4, 5, 6)'
          : '0px none',
        padding: '0px',
        content: 'normal',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    fixture.image.classList.add('painted');
    fixture.mutation.trigger([attributeRecord(fixture.image, 'class')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: { nodeId: 7, observationChanged: true, captureChanged: true },
    }]);
    stop();
  });

  it('withdraws admitted images when mutation policy refresh fails', () => {
    let failPolicy = false;
    const fixture = createFixture('', {
      beforeMutationRead: () => {
        if (failPolicy) throw new Error('policy unavailable');
        return false;
      },
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    failPolicy = true;
    fixture.image.classList.add('changed');
    fixture.mutation.trigger([attributeRecord(fixture.image, 'class')]);

    expect(events).toEqual([{
      kind: 'remove',
      document: documentIdentity,
      nodeId: 7,
    }]);
    stop();
  });

  it('re-proves an image when its selector id changes', () => {
    const fixture = createFixture();
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: element === fixture.image && element.id === 'inactive'
          ? '0'
          : '1',
        clipPath: 'none',
        maskImage: 'none',
        perspective: 'none',
        rotate: 'none',
        scale: 'none',
        transform: 'none',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    fixture.image.id = 'inactive';
    fixture.mutation.trigger([attributeRecord(fixture.image, 'id')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: { nodeId: 7, observationChanged: true },
    }]);
    stop();
  });

  it('forces capture reproof after a CSSOM-only style change', () => {
    const fixture = createFixture('<img id="second" src="second.png">');
    const second = fixture.document.querySelector<HTMLImageElement>('#second')!;
    setImageMetrics(second, fixture.bounds);
    fixture.nodeIds.set(second, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    fixture.observer.refreshAfterStyleChange();

    expect(events.map(eventNodeId)).toEqual([7, 19]);
    expect(events.every((event) => event.kind === 'upsert' &&
      event.input.captureChanged === true)).toBe(true);
    stop();
  });

  it('advances images after a sibling protected control moves into or away from them', () => {
    const fixture = createFixture(
      '<input id="moving-secret" type="password">',
    );
    const secret = fixture.document.querySelector('#moving-secret')!;
    const secretBounds = { left: 320, top: 0, width: 80, height: 40 };
    setElementBounds(secret, secretBounds);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    secretBounds.left = 40;
    secret.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    secret.dispatchEvent(new fixture.document.defaultView!.Event(
      'animationend',
      { bubbles: true },
    ));
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();
    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    }]);

    events.length = 0;
    secretBounds.left = 320;
    secret.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitioncancel',
      { bubbles: true },
    ));
    fixture.frames.flush();
    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    expect(JSON.stringify(events)).not.toMatch(/password|moving-secret/iu);
    stop();
  });

  it('advances underlying evidence when an ordinary overlay is removed', () => {
    const fixture = createFixture('<div id="ordinary-overlay"></div>');
    const overlay = fixture.document.querySelector('#ordinary-overlay')!;
    setElementBounds(overlay, { left: 20, top: 0, width: 80, height: 40 });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    overlay.remove();
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.body,
      addedNodes: [],
      removedNodes: [overlay],
    } as unknown as MutationRecord]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: { nodeId: 7, observationChanged: true },
    }]);
    expect(JSON.stringify(events)).not.toContain('ordinary-overlay');
    stop();
  });

  it('suppresses generic relationship rescans after a prepared irrelevant batch', () => {
    let globalRefreshes = 0;
    let mutationPreparations = 0;
    const fixture = createFixture(
      '<div id="controller" aria-controls="panel"></div><div id="panel"></div>',
      {
        beforeRefreshAll: () => { globalRefreshes += 1; },
        beforeMutationRead: () => {
          mutationPreparations += 1;
          return false;
        },
      },
    );
    const controller = fixture.document.querySelector('#controller')!;
    const panel = fixture.document.querySelector('#panel')!;
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    controller.setAttribute('aria-controls', 'other-panel');
    panel.setAttribute('id', 'other-panel');
    fixture.mutation.trigger([
      attributeRecord(controller, 'aria-controls'),
      attributeRecord(panel, 'id'),
    ]);

    expect(mutationPreparations).toBe(1);
    expect(globalRefreshes).toBe(0);
    expect(events).toEqual([]);
    stop();
  });

  it('coalesces stylesheet settling without invalidating a stable capture', () => {
    let policyRefreshes = 0;
    const fixture = createFixture(
      '<link id="late-theme" rel="stylesheet" href="theme.css">',
      {
        beforeRefreshAll: () => { policyRefreshes += 1; },
        beforeMutationRead: () => false,
      },
    );
    const stylesheet = fixture.document.querySelector('#late-theme')!;
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    stylesheet.setAttribute('media', '(min-width: 1px)');
    fixture.mutation.trigger([attributeRecord(stylesheet, 'media')]);
    // External stylesheet state needs one explicit admission refresh even when
    // the generic mutation hook proved controlled relationships unchanged.
    expect(policyRefreshes).toBe(1);
    expect(events).toEqual([]);

    stylesheet.dispatchEvent(new fixture.document.defaultView!.Event(
      'load',
      { bubbles: true },
    ));
    stylesheet.dispatchEvent(new fixture.document.defaultView!.Event(
      'load',
      { bubbles: true },
    ));

    expect(policyRefreshes).toBe(1);
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();
    expect(policyRefreshes).toBe(2);
    expect(events).toEqual([]);
    expect(fixture.frames.pending).toBe(0);
    stop();
  });

  it('remeasures only images overlapped by a moved sibling control', () => {
    const fixture = createFixture(
      '<img id="distant" src="distant.png"><input id="secret" type="password">',
    );
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    const secret = fixture.document.querySelector('#secret')!;
    const distantBounds = { left: 500, top: 0, width: 200, height: 100 };
    const secretBounds = { left: 300, top: 0, width: 80, height: 40 };
    setImageMetrics(distant, distantBounds);
    setElementBounds(secret, secretBounds);
    fixture.nodeIds.set(distant, 19);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      if (event.kind === 'upsert') model.upsert(event.input);
    });
    events.length = 0;
    const mainRevision = model.get(7)?.observationRevision;
    const distantRevision = model.get(19)?.observationRevision;

    secretBounds.left = 40;
    secret.setAttribute('style', 'position:fixed;left:40px');
    fixture.mutation.trigger([attributeRecord(secret, 'style')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
      },
    }]);
    expect(events).toHaveLength(1);
    expect(model.get(7)?.observationRevision).toBe((mainRevision ?? 0) + 1);
    expect(model.get(19)?.observationRevision).toBe(distantRevision);
    expect(JSON.stringify(events)).not.toMatch(/password|secret|style/iu);

    events.length = 0;
    secret.remove();
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.body,
      addedNodes: [],
      removedNodes: [secret],
    } as unknown as MutationRecord]);
    expect(events.map(eventNodeId)).toEqual([7]);
    expect(events.every((event) =>
      event.kind === 'upsert' &&
      event.input.observationChanged &&
      event.input.captureChanged === true
    )).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/password|secret|style/iu);
    stop();
  });

  it('rechecks overlap when protected control text changes its geometry', () => {
    const fixture = createFixture('<button id="growing-control">Short</button>');
    const control = fixture.document.querySelector('#growing-control')!;
    const controlBounds = { left: 220, top: 0, width: 40, height: 40 };
    setElementBounds(control, controlBounds);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    controlBounds.left = 160;
    controlBounds.width = 120;
    const text = control.firstChild!;
    text.textContent = 'A much wider protected control';
    fixture.mutation.trigger([{
      type: 'characterData',
      target: text,
    } as unknown as MutationRecord]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: { nodeId: 7, observationChanged: true, captureChanged: true },
    }]);
    stop();
  });

  it('invalidates an image crossed between non-overlapping motion endpoints', () => {
    const fixture = createFixture('<input id="crossing-secret" type="password">');
    const secret = fixture.document.querySelector('#crossing-secret')!;
    const secretBounds = { left: 320, top: 0, width: 40, height: 40 };
    setElementBounds(secret, secretBounds);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    secretBounds.left = -80;
    secret.setAttribute('style', 'transform:translateX(-400px)');
    fixture.mutation.trigger([attributeRecord(secret, 'style')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    stop();
  });

  it('tracks a generic computed text-security surface in overlap safety', () => {
    const fixture = createFixture(
      '<div id="computed-secret">Protected rendered surface</div>',
    );
    const secret = fixture.document.querySelector('#computed-secret')!;
    setElementBounds(secret, { left: 300, top: 0, width: 80, height: 40 });
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block',
        visibility: 'visible',
        contentVisibility: 'visible',
        opacity: '1',
        position: 'static',
        clipPath: 'none',
        maskImage: 'none',
        perspective: 'none',
        rotate: 'none',
        scale: 'none',
        transform: 'none',
        overflowX: 'visible',
        overflowY: 'visible',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element === secret
            ? 'disc'
            : '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    fixture.bounds.left = 290;
    fixture.image.className = 'moved';
    fixture.mutation.trigger([attributeRecord(fixture.image, 'class')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    stop();
  });

  it('tracks generic computed text-security movement after layout settles', () => {
    const fixture = createFixture(
      '<div id="computed-secret">Protected rendered surface</div>',
    );
    const secret = fixture.document.querySelector('#computed-secret')!;
    const secretBounds = { left: 320, top: 0, width: 80, height: 40 };
    setElementBounds(secret, secretBounds);
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: 'block', visibility: 'visible', contentVisibility: 'visible',
        opacity: '1', position: 'static', clipPath: 'none', maskImage: 'none',
        perspective: 'none', rotate: 'none', scale: 'none', transform: 'none',
        overflowX: 'visible', overflowY: 'visible',
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element === secret ? 'disc' : '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    secretBounds.left = 40;
    secret.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    stop();
  });

  it('remeasures only current control overlaps after stylesheet changes', () => {
    const fixture = createFixture(
      '<style id="rules">#secret { left: 300px }</style>' +
      '<img id="distant" src="distant.png">' +
      '<input id="secret" type="password">',
    );
    const rules = fixture.document.querySelector('#rules')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    const secret = fixture.document.querySelector('#secret')!;
    const distantBounds = { left: 500, top: 0, width: 200, height: 100 };
    const secretBounds = { left: 300, top: 0, width: 80, height: 40 };
    setImageMetrics(distant, distantBounds);
    setElementBounds(secret, secretBounds);
    fixture.nodeIds.set(distant, 19);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      if (event.kind === 'upsert') model.upsert(event.input);
    });
    const readSecretBounds = secret.getBoundingClientRect;
    let secretBoundsReads = 0;
    Object.defineProperty(secret, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        secretBoundsReads += 1;
        return readSecretBounds.call(secret);
      },
    });
    events.length = 0;
    const mainRevision = model.get(7)?.observationRevision;
    const distantRevision = model.get(19)?.observationRevision;

    secretBounds.left = 40;
    const ruleText = rules.firstChild!;
    ruleText.textContent = '#secret { left: 40px }';
    fixture.mutation.trigger([{
      type: 'characterData',
      target: ruleText,
    } as unknown as MutationRecord]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
      },
    }]);
    expect(events).toHaveLength(1);
    expect(model.get(7)?.observationRevision).toBe((mainRevision ?? 0) + 1);
    expect(model.get(19)?.observationRevision).toBe(distantRevision);
    expect(secretBoundsReads).toBe(1);
    expect(JSON.stringify(events)).not.toMatch(/password|secret|style/iu);
    stop();
  });

  it.each(['style', 'class'] as const)(
    'advances old and new protected-control overlaps after a %s move',
    (attributeName) => {
      const fixture = createFixture(
        '<img id="destination" src="destination.png">' +
          '<img id="distant" src="distant.png">' +
          '<input id="moving-secret" type="password">',
      );
      const destination = fixture.document.querySelector<HTMLImageElement>(
        '#destination',
      )!;
      const distant = fixture.document.querySelector<HTMLImageElement>(
        '#distant',
      )!;
      const secret = fixture.document.querySelector('#moving-secret')!;
      fixture.bounds.left = 0;
      const destinationBounds = {
        left: 220,
        top: 0,
        width: 100,
        height: 100,
      };
      const distantBounds = {
        left: 600,
        top: 0,
        width: 100,
        height: 100,
      };
      const secretBounds = { left: 20, top: 0, width: 60, height: 40 };
      setImageMetrics(destination, destinationBounds);
      setImageMetrics(distant, distantBounds);
      setElementBounds(secret, secretBounds);
      fixture.nodeIds.set(destination, 19);
      fixture.nodeIds.set(distant, 23);
      const model = new SourceImageModel();
      model.beginDocument(documentIdentity);
      const events: SourceImageObservationEvent[] = [];
      const stop = fixture.observer.subscribe((event) => {
        events.push(event);
        applyObservationEvent(model, event);
      });
      const initialMain = model.get(7)!;
      const initialDestination = model.get(19)!;
      const initialDistant = model.get(23)!;
      events.length = 0;

      secretBounds.left = 240;
      secret.setAttribute(
        attributeName,
        attributeName === 'style' ? 'left:240px' : 'at-destination',
      );
      fixture.mutation.trigger([attributeRecord(secret, attributeName)]);

      expect(events.map(eventNodeId).sort((left, right) => left - right)).toEqual([
        7,
        19,
      ]);
      expect(events.every((event) =>
        event.kind === 'upsert' &&
        event.input.contentChanged === false &&
        event.input.observationChanged === true &&
        event.input.captureChanged === true
      )).toBe(true);
      expect(model.get(7)).toMatchObject({
        contentRevision: initialMain.contentRevision,
        captureRevision: (initialMain.captureRevision ?? 0) + 1,
      });
      expect(model.get(19)).toMatchObject({
        contentRevision: initialDestination.contentRevision,
        captureRevision: (initialDestination.captureRevision ?? 0) + 1,
      });
      expect(model.get(23)).toMatchObject({
        contentRevision: initialDistant.contentRevision,
        captureRevision: initialDistant.captureRevision,
        observationRevision: initialDistant.observationRevision,
      });
      expect(JSON.stringify(events)).not.toMatch(/password|moving-secret/iu);
      stop();
    },
  );

  it('advances only a moving image that crosses a stationary protected control', () => {
    const fixture = createFixture(
      '<input id="stationary-secret" type="password">' +
        '<img id="distant" src="distant.png">',
    );
    const secret = fixture.document.querySelector('#stationary-secret')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    const secretBounds = { left: 300, top: 0, width: 80, height: 40 };
    setElementBounds(secret, secretBounds);
    setImageMetrics(distant, { left: 700, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initialMain = model.get(7)!;
    const initialDistant = model.get(19)!;
    events.length = 0;

    fixture.bounds.left = 280;
    fixture.image.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    expect(model.get(7)?.captureRevision).toBe(
      (initialMain.captureRevision ?? 0) + 1,
    );
    expect(model.get(19)).toMatchObject({
      captureRevision: initialDistant.captureRevision,
      observationRevision: initialDistant.observationRevision,
    });

    const overlappedMain = model.get(7)!;
    events.length = 0;
    fixture.bounds.left = 0;
    fixture.image.dispatchEvent(new fixture.document.defaultView!.Event(
      'transitionend',
      { bubbles: true },
    ));
    fixture.frames.flush();

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    expect(model.get(7)?.captureRevision).toBe(
      (overlappedMain.captureRevision ?? 0) + 1,
    );
    expect(model.get(19)).toMatchObject({
      captureRevision: initialDistant.captureRevision,
      observationRevision: initialDistant.observationRevision,
    });
    stop();
  });

  it('tracks a moving image inside a captioned presentation wrapper', () => {
    const fixture = createFixture(
      '<input id="stationary-secret" type="password">' +
        '<section id="captioned-shell"><img id="nested" src="nested.png">' +
        '<span>Visible caption</span></section>' +
        '<img id="distant" src="distant.png">',
    );
    const secret = fixture.document.querySelector('#stationary-secret')!;
    const shell = fixture.document.querySelector('#captioned-shell')!;
    const nested = fixture.document.querySelector<HTMLImageElement>('#nested')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    setElementBounds(secret, { left: 300, top: 0, width: 80, height: 40 });
    setImageMetrics(nested, { left: 500, top: 0, width: 100, height: 100 });
    setImageMetrics(distant, { left: 700, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(nested, 19);
    fixture.nodeIds.set(distant, 23);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initialMain = model.get(7)!;
    const initialNested = model.get(19)!;
    const initialDistant = model.get(23)!;
    events.length = 0;

    setImageMetrics(nested, { left: 290, top: 0, width: 100, height: 100 });
    shell.classList.add('moved');
    fixture.mutation.trigger([attributeRecord(shell, 'class')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 19,
        contentChanged: false,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    expect(model.get(19)?.captureRevision).toBe(
      (initialNested.captureRevision ?? 0) + 1,
    );
    expect(model.get(7)).toMatchObject({
      captureRevision: initialMain.captureRevision,
      observationRevision: initialMain.observationRevision,
    });
    expect(model.get(23)).toMatchObject({
      captureRevision: initialDistant.captureRevision,
      observationRevision: initialDistant.observationRevision,
    });
    stop();
  });

  it('keeps connected remove-add reparenting free of removal and capture invalidation', () => {
    const fixture = createFixture(
      '<div id="left-parent"></div><div id="right-parent"></div>' +
        '<img id="distant" src="distant.png">',
    );
    const left = fixture.document.querySelector('#left-parent')!;
    const right = fixture.document.querySelector('#right-parent')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    left.append(fixture.image);
    setImageMetrics(distant, { left: 500, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initialMain = model.get(7)!;
    const initialDistant = model.get(19)!;
    events.length = 0;

    right.append(fixture.image);
    fixture.mutation.trigger([
      {
        type: 'childList',
        target: left,
        addedNodes: [],
        removedNodes: [fixture.image],
      } as unknown as MutationRecord,
      {
        type: 'childList',
        target: right,
        addedNodes: [fixture.image],
        removedNodes: [],
      } as unknown as MutationRecord,
    ]);

    expect(events.some((event) => event.kind === 'remove')).toBe(false);
    expect(events.every((event) =>
      event.kind === 'upsert' &&
      event.input.contentChanged === false &&
      event.input.captureChanged !== true
    )).toBe(true);
    expect(model.get(7)).toMatchObject({
      contentRevision: initialMain.contentRevision,
      captureRevision: initialMain.captureRevision,
    });
    expect(model.get(19)).toMatchObject({
      contentRevision: initialDistant.contentRevision,
      captureRevision: initialDistant.captureRevision,
      observationRevision: initialDistant.observationRevision,
    });
    stop();
  });

  it('uses a bounded removed-subtree graph before the global identity fallback', () => {
    const fixture = createFixture(
      '<section id="removed-shell"><img id="removed-image" src="gone.png">' +
        '</section><img id="distant" src="distant.png">',
    );
    const shell = fixture.document.querySelector('#removed-shell')!;
    const removed = fixture.document.querySelector<HTMLImageElement>(
      '#removed-image',
    )!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    setImageMetrics(removed, { left: 220, top: 0, width: 100, height: 100 });
    setImageMetrics(distant, { left: 600, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(removed, 19);
    fixture.nodeIds.set(distant, 23);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    let identityContainmentReads = 0;
    Object.defineProperty(shell, 'contains', {
      configurable: true,
      value: () => {
        identityContainmentReads += 1;
        return false;
      },
    });
    events.length = 0;

    shell.remove();
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.body,
      addedNodes: [],
      removedNodes: [shell],
    } as unknown as MutationRecord]);

    expect(events).toContainEqual({
      kind: 'remove',
      document: documentIdentity,
      nodeId: 19,
    });
    expect(identityContainmentReads).toBe(0);
    stop();
  });

  it('fails closed with global capture invalidation for unreadable safety geometry', () => {
    const fixture = createFixture(
      '<img id="distant" src="distant.png">' +
        '<input id="unreadable-secret" type="password">',
    );
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    const secret = fixture.document.querySelector('#unreadable-secret')!;
    setImageMetrics(distant, { left: 500, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    let readable = true;
    Object.defineProperty(secret, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        if (!readable) throw new Error('unreadable geometry');
        return {
          x: 300,
          y: 0,
          top: 0,
          left: 300,
          right: 380,
          bottom: 40,
          width: 80,
          height: 40,
          toJSON: () => undefined,
        };
      },
    });
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initialMain = model.get(7)!;
    const initialDistant = model.get(19)!;
    events.length = 0;

    readable = false;
    secret.classList.add('moved-by-css');
    fixture.mutation.trigger([attributeRecord(secret, 'class')]);

    expect(events.map(eventNodeId).sort((left, right) => left - right)).toEqual([
      7,
      19,
    ]);
    expect(events.every((event) =>
      event.kind === 'upsert' &&
      event.input.contentChanged === false &&
      event.input.observationChanged === true &&
      event.input.captureChanged === true
    )).toBe(true);
    expect(model.get(7)?.captureRevision).toBe(
      (initialMain.captureRevision ?? 0) + 1,
    );
    expect(model.get(19)?.captureRevision).toBe(
      (initialDistant.captureRevision ?? 0) + 1,
    );
    expect(JSON.stringify(events)).not.toMatch(/password|unreadable-secret/iu);
    stop();
  });

  it('fails closed globally when a passive subtree shadow root is unreadable', () => {
    const fixture = createFixture(
      '<div id="passive-shell"><img id="nested" src="nested.png"></div>' +
        '<img id="distant" src="distant.png">',
    );
    const shell = fixture.document.querySelector('#passive-shell')!;
    const nested = fixture.document.querySelector<HTMLImageElement>('#nested')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    setElementBounds(shell, { left: 220, top: 0, width: 100, height: 100 });
    setImageMetrics(nested, { left: 220, top: 0, width: 100, height: 100 });
    setImageMetrics(distant, { left: 600, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(nested, 19);
    fixture.nodeIds.set(distant, 23);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initial = new Map([
      [7, model.get(7)!],
      [19, model.get(19)!],
      [23, model.get(23)!],
    ]);
    events.length = 0;

    Object.defineProperty(shell, 'shadowRoot', {
      configurable: true,
      get: () => {
        throw new Error('unreadable shadow root');
      },
    });
    shell.classList.add('motion-settled');
    fixture.mutation.trigger([attributeRecord(shell, 'class')]);

    expect(events.map(eventNodeId).sort((left, right) => left - right)).toEqual([
      7,
      19,
      23,
    ]);
    expect(events.every((event) =>
      event.kind === 'upsert' &&
      event.input.observationChanged === true &&
      event.input.captureChanged === true
    )).toBe(true);
    for (const nodeId of [7, 19, 23]) {
      expect(model.get(nodeId)?.captureRevision).toBe(
        (initial.get(nodeId)?.captureRevision ?? 0) + 1,
      );
    }
    expect(JSON.stringify(events)).not.toContain('unreadable shadow root');
    stop();
  });

  it('uses flat-tree ancestry when native contains throws', () => {
    const fixture = createFixture(
      '<section id="moving-shell"><input id="moving-secret" type="password">' +
        '</section><img id="destination" src="destination.png">' +
        '<img id="distant" src="distant.png">',
    );
    const shell = fixture.document.querySelector('#moving-shell')!;
    const secret = fixture.document.querySelector('#moving-secret')!;
    const destination = fixture.document.querySelector<HTMLImageElement>(
      '#destination',
    )!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    const secretBounds = { left: 20, top: 0, width: 60, height: 40 };
    setElementBounds(secret, secretBounds);
    setImageMetrics(destination, { left: 220, top: 0, width: 100, height: 100 });
    setImageMetrics(distant, { left: 600, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(destination, 19);
    fixture.nodeIds.set(distant, 23);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    Object.defineProperty(shell, 'contains', {
      configurable: true,
      value: () => {
        throw new Error('unreadable native containment');
      },
    });
    secretBounds.left = 240;
    shell.classList.add('moved');
    fixture.mutation.trigger([attributeRecord(shell, 'class')]);

    expect(events.map(eventNodeId).sort((left, right) => left - right)).toEqual([
      7,
      19,
    ]);
    expect(events.every((event) =>
      event.kind === 'upsert' &&
      event.input.contentChanged === false &&
      event.input.observationChanged === true &&
      event.input.captureChanged === true
    )).toBe(true);
    expect(events.some((event) => eventNodeId(event) === 23)).toBe(false);
    expect(JSON.stringify(events)).not.toContain('unreadable native containment');
    stop();
  });

  it('fails closed globally when containment and flat-tree ancestry are unreadable', () => {
    const fixture = createFixture(
      '<div id="passive-shell"><img id="nested" src="nested.png"></div>' +
        '<input id="known-control" type="password">' +
        '<img id="distant" src="distant.png">',
    );
    const shell = fixture.document.querySelector('#passive-shell')!;
    const nested = fixture.document.querySelector<HTMLImageElement>('#nested')!;
    const control = fixture.document.querySelector('#known-control')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    setElementBounds(shell, { left: 220, top: 0, width: 100, height: 100 });
    setImageMetrics(nested, { left: 220, top: 0, width: 100, height: 100 });
    setElementBounds(control, { left: 800, top: 0, width: 80, height: 40 });
    setImageMetrics(distant, { left: 600, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(nested, 19);
    fixture.nodeIds.set(distant, 23);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    Object.defineProperty(shell, 'contains', {
      configurable: true,
      value: () => {
        throw new Error('unreadable native containment');
      },
    });
    Object.defineProperty(control, 'parentElement', {
      configurable: true,
      get: () => {
        throw new Error('unreadable flat-tree ancestry');
      },
    });
    shell.classList.add('motion-settled');
    fixture.mutation.trigger([attributeRecord(shell, 'class')]);

    expect(events.map(eventNodeId).sort((left, right) => left - right)).toEqual([
      7,
      19,
      23,
    ]);
    expect(events.every((event) =>
      event.kind === 'upsert' &&
      event.input.observationChanged === true &&
      event.input.captureChanged === true
    )).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(
      /unreadable (?:native containment|flat-tree ancestry)/u,
    );
    stop();
  });

  it('retains stable captures after stylesheet and font layout settles', () => {
    const fixture = createFixture(
      '<link id="late-layout" rel="stylesheet" href="layout.css">' +
        '<img id="distant" src="distant.png">',
    );
    const stylesheet = fixture.document.querySelector('#late-layout')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    setImageMetrics(distant, { left: 500, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    const fontSettles = new FakeFontSettleTarget();
    Object.defineProperty(fixture.document, 'fonts', {
      configurable: true,
      value: fontSettles,
    });
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initialMain = model.get(7)!;
    const initialDistant = model.get(19)!;
    events.length = 0;

    stylesheet.dispatchEvent(new fixture.document.defaultView!.Event(
      'load',
      { bubbles: true },
    ));
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();

    expect(events).toEqual([]);
    expect(model.get(7)?.captureRevision).toBe(initialMain.captureRevision);
    expect(model.get(19)?.captureRevision).toBe(
      initialDistant.captureRevision,
    );

    const afterStylesheetMain = model.get(7)!;
    const afterStylesheetDistant = model.get(19)!;
    events.length = 0;
    fontSettles.dispatchLoadingDone();
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();

    expect(events).toEqual([]);
    expect(model.get(7)?.captureRevision).toBe(
      afterStylesheetMain.captureRevision,
    );
    expect(model.get(19)?.captureRevision).toBe(
      afterStylesheetDistant.captureRevision,
    );
    stop();
  });

  it('treats details open mutations as bounded capture-safety changes', () => {
    const fixture = createFixture(
      '<details id="disclosure"><summary>More</summary></details>' +
        '<img id="distant" src="distant.png">',
    );
    const disclosure = fixture.document.querySelector('#disclosure')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    setElementBounds(disclosure, { left: 20, top: 0, width: 80, height: 40 });
    setImageMetrics(distant, { left: 500, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initialMain = model.get(7)!;
    const initialDistant = model.get(19)!;
    events.length = 0;

    expect(fixture.mutation.options).toMatchObject({ attributes: true });
    expect(fixture.mutation.options?.attributeFilter).toBeUndefined();
    disclosure.setAttribute('open', '');
    fixture.mutation.trigger([attributeRecord(disclosure, 'open')]);

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    expect(model.get(7)?.captureRevision).toBe(
      (initialMain.captureRevision ?? 0) + 1,
    );
    expect(model.get(19)).toMatchObject({
      captureRevision: initialDistant.captureRevision,
      observationRevision: initialDistant.observationRevision,
    });
    stop();
  });

  it('coalesces popover beforetoggle and toggle into bounded capture safety', () => {
    const fixture = createFixture(
      '<div id="popover" popover="auto" role="dialog"></div>' +
        '<img id="distant" src="distant.png">',
    );
    const popover = fixture.document.querySelector('#popover')!;
    const distant = fixture.document.querySelector<HTMLImageElement>('#distant')!;
    setElementBounds(popover, { left: 20, top: 0, width: 80, height: 40 });
    setImageMetrics(distant, { left: 500, top: 0, width: 100, height: 100 });
    fixture.nodeIds.set(distant, 19);
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      applyObservationEvent(model, event);
    });
    const initialMain = model.get(7)!;
    const initialDistant = model.get(19)!;
    events.length = 0;

    popover.dispatchEvent(new fixture.document.defaultView!.Event(
      'beforetoggle',
      { bubbles: true },
    ));
    expect(fixture.frames.pending).toBe(1);
    popover.dispatchEvent(new fixture.document.defaultView!.Event(
      'toggle',
      { bubbles: true },
    ));
    expect(fixture.frames.pending).toBe(1);
    fixture.frames.flush();

    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
        captureChanged: true,
      },
    }]);
    expect(model.get(7)?.captureRevision).toBe(
      (initialMain.captureRevision ?? 0) + 1,
    );
    expect(model.get(19)).toMatchObject({
      captureRevision: initialDistant.captureRevision,
      observationRevision: initialDistant.observationRevision,
    });
    stop();
  });

  it('admits HTTP(S) navigation images with passive disclosure metadata', () => {
    const fixture = createFixture(`
      <a href="/news" role="button"><img data-node="19"></a>
      <a href="https://other.example/news" role="presentation button"><img data-node="20"></a>
      <a href="#news" role="button"><img data-node="21"></a>
      <a href="https://page.example/root/#news" role="button"><img data-node="22"></a>
      <a href="javascript:void(0)" role="button"><img data-node="23"></a>
      <a href="data:text/plain,button" role="button"><img data-node="24"></a>
      <a href="/tab" role="tab"><img data-node="25"></a>
      <div role="button"><a href="/nested" role="button"><img data-node="26"></a></div>
      <button><a href="/native" role="button"><img data-node="27"></a></button>
      <a href="/private" role="textbox button"><img data-node="28"></a>
      <div contenteditable><a href="/editable" role="button"><img data-node="29"></a></div>
      <a href="/expanded" role="button" aria-expanded="false"><img data-node="30"></a>
      <a href="/popup" role="button" aria-haspopup="menu"><img data-node="31"></a>
      <a href="/controlled" role="button" aria-controls="menu"><img data-node="32"></a>
      <a href="/pressed" role="button" aria-pressed="false"><img data-node="33"></a>
    `);
    for (const image of fixture.document.querySelectorAll<HTMLImageElement>(
      'img[data-node]',
    )) {
      setImageMetrics(image, fixture.bounds);
      fixture.nodeIds.set(image, Number(image.getAttribute('data-node')));
    }
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));

    expect(events.map(eventNodeId)).toEqual([7, 19, 30, 31, 32]);
    expect(JSON.stringify(events)).not.toContain('/news');
    expect(JSON.stringify(events)).not.toContain('other.example');
    expect(fixture.mutation.options).toMatchObject({ attributes: true });
    expect(fixture.mutation.options?.attributeFilter).toBeUndefined();
    stop();
  });

  it('coalesces role and href mutations and re-evaluates dynamic base URLs', () => {
    const fixture = createFixture(
      '<a id="navigation" role="button"><img id="dynamic" src="dynamic.png"></a>',
    );
    const link = fixture.document.querySelector('#navigation')!;
    const dynamic = fixture.document.querySelector<HTMLImageElement>('#dynamic')!;
    const base = fixture.document.querySelector('base')!;
    setImageMetrics(dynamic, fixture.bounds);
    fixture.nodeIds.set(dynamic, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toEqual([7]);

    link.setAttribute('href', '/news');
    fixture.mutation.trigger([attributeRecord(link, 'href')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 19, contentChanged: true },
    });

    const beforeCoalescedChange = events.length;
    link.setAttribute('role', 'presentation button');
    link.setAttribute('href', '/other-news');
    fixture.mutation.trigger([
      attributeRecord(link, 'role'),
      attributeRecord(link, 'href'),
    ]);
    expect(events).toHaveLength(beforeCoalescedChange + 1);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });

    link.setAttribute('role', 'button');
    fixture.mutation.trigger([attributeRecord(link, 'role')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert', input: { nodeId: 19, contentChanged: true },
    });

    link.removeAttribute('href');
    fixture.mutation.trigger([attributeRecord(link, 'href')]);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });
    const afterRemoval = events.length;
    for (const href of ['#menu', 'javascript:void(0)', 'data:text/plain,no']) {
      link.setAttribute('href', href);
      fixture.mutation.trigger([attributeRecord(link, 'href')]);
    }
    expect(events).toHaveLength(afterRemoval);

    link.setAttribute('href', 'restored');
    fixture.mutation.trigger([attributeRecord(link, 'href')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 19, contentChanged: true },
    });

    base.setAttribute('href', 'about:blank');
    fixture.mutation.trigger([attributeRecord(base, 'href')]);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });
    base.setAttribute('href', 'https://page.example/root/');
    fixture.mutation.trigger([attributeRecord(base, 'href')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert', input: { nodeId: 19, contentChanged: true },
    });

    const beforeBaseRemoval = events.length;
    base.remove();
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.head,
      addedNodes: [],
      removedNodes: [base],
    } as unknown as MutationRecord]);
    expect(events.slice(beforeBaseRemoval)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'remove', nodeId: 19 }),
    ]));
    fixture.document.head.append(base);
    fixture.mutation.trigger([{
      type: 'childList',
      target: fixture.document.head,
      addedNodes: [base],
      removedNodes: [],
    } as unknown as MutationRecord]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert', input: { nodeId: 19, contentChanged: true },
    });
    stop();
  });

  it('coalesces stateful navigation mutations into removal and re-admission', () => {
    const fixture = createFixture(
      '<a id="navigation" href="/news" role="button"><img id="dynamic"></a>',
    );
    const link = fixture.document.querySelector('#navigation')!;
    const dynamic = fixture.document.querySelector<HTMLImageElement>('#dynamic')!;
    setImageMetrics(dynamic, fixture.bounds);
    fixture.nodeIds.set(dynamic, 19);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toEqual([7, 19]);

    const statefulAttributes = [
      ['aria-expanded', 'false'],
      ['aria-haspopup', 'menu'],
      ['aria-controls', 'menu'],
      ['aria-pressed', 'false'],
    ] as const;
    const beforeRemoval = events.length;
    for (const [attribute, value] of statefulAttributes) {
      link.setAttribute(attribute, value);
    }
    fixture.mutation.trigger(
      statefulAttributes.map(([attribute]) => attributeRecord(link, attribute)),
    );
    expect(events).toHaveLength(beforeRemoval + 1);
    expect(events.at(-1)).toMatchObject({ kind: 'remove', nodeId: 19 });

    const beforeReadmission = events.length;
    for (const [attribute] of statefulAttributes) link.removeAttribute(attribute);
    fixture.mutation.trigger(
      statefulAttributes.map(([attribute]) => attributeRecord(link, attribute)),
    );
    expect(events).toHaveLength(beforeReadmission + 1);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert', input: { nodeId: 19, contentChanged: true },
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

  it('advances changed oversized alt routing without a geometry refresh loop', () => {
    const fixture = createFixture();
    fixture.image.setAttribute('alt', `A${'x'.repeat(70_000)}`);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    fixture.image.setAttribute('alt', `B${'y'.repeat(70_000)}`);
    fixture.mutation.trigger([attributeRecord(fixture.image, 'alt')]);
    expect(events).toMatchObject([{
      kind: 'upsert',
      input: { nodeId: 7, contentChanged: true },
    }]);
    events.length = 0;
    fixture.resize.trigger(fixture.image);
    expect(events).toEqual([]);
    expect(JSON.stringify(events)).not.toContain('y'.repeat(1_000));
    stop();
  });

  it('invalidates stable boxes when object-position changes displayed pixels', () => {
    const fixture = createFixture();
    let objectPosition = '0% 50%';
    Object.defineProperty(fixture.document.defaultView!, 'getComputedStyle', {
      configurable: true,
      value: () => ({
        display: 'block', visibility: 'visible', contentVisibility: 'visible',
        opacity: '1', clipPath: 'none', maskImage: 'none', perspective: 'none',
        rotate: 'none', scale: 'none', transform: 'none', filter: 'none',
        mixBlendMode: 'normal', objectFit: 'cover', objectPosition,
        imageRendering: 'auto', overflowX: 'visible', overflowY: 'visible',
        getPropertyValue: () => '',
      }),
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;

    objectPosition = '100% 50%';
    fixture.image.className = 'crop-right';
    fixture.mutation.trigger([attributeRecord(fixture.image, 'class')]);
    expect(events).toMatchObject([{
      kind: 'upsert',
      input: {
        nodeId: 7,
        contentChanged: false,
        observationChanged: true,
      },
    }]);
    stop();
  });

  it('discovers and observes existing and added open shadow-root images only', () => {
    const fixture = createFixture(
      '<div id="existing-host"></div><div id="late-host"></div>',
    );
    const host = fixture.document.querySelector('#existing-host')!;
    const open = host.attachShadow({ mode: 'open' });
    Object.defineProperty(open, 'mode', { configurable: true, value: 'open' });
    const existing = fixture.document.createElement('img');
    setImageMetrics(existing, fixture.bounds);
    fixture.nodeIds.set(existing, 19);
    open.append(existing);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    expect(events.map(eventNodeId)).toContain(19);
    expect(fixture.mutation.targets).toContain(open);

    const late = fixture.document.createElement('img');
    setImageMetrics(late, fixture.bounds);
    fixture.nodeIds.set(late, 23);
    open.append(late);
    fixture.mutation.trigger([{
      type: 'childList', target: open, addedNodes: [late], removedNodes: [],
    } as unknown as MutationRecord]);
    expect(events.map(eventNodeId)).toContain(23);

    const lateHost = fixture.document.querySelector('#late-host')!;
    const attached = lateHost.attachShadow({ mode: 'open' });
    Object.defineProperty(attached, 'mode', {
      configurable: true,
      value: 'open',
    });
    const attachedImage = fixture.document.createElement('img');
    setImageMetrics(attachedImage, fixture.bounds);
    fixture.nodeIds.set(attachedImage, 27);
    attached.append(attachedImage);
    fixture.timers.run();
    expect(events.map(eventNodeId)).toContain(27);
    expect(fixture.mutation.targets).toContain(attached);

    const closedHost = fixture.document.createElement('div');
    const closed = closedHost.attachShadow({ mode: 'closed' });
    Object.defineProperty(closed, 'mode', { configurable: true, value: 'closed' });
    const hidden = fixture.document.createElement('img');
    setImageMetrics(hidden, fixture.bounds);
    fixture.nodeIds.set(hidden, 29);
    closed.append(hidden);
    fixture.document.body.append(closedHost);
    fixture.mutation.trigger([{
      type: 'childList', target: fixture.document.body,
      addedNodes: [closedHost], removedNodes: [],
    } as unknown as MutationRecord]);
    expect(events.map(eventNodeId)).not.toContain(29);
    stop();
  });

  it('checks rotating shadow hosts without periodically rereading images', () => {
    let admissionReads = 0;
    const fixture = createFixture('<div id="late-shadow-host"></div>', {
      isPrivateImage: () => {
        admissionReads += 1;
        return false;
      },
    });
    const readMainBounds = fixture.image.getBoundingClientRect.bind(fixture.image);
    let geometryReads = 0;
    Object.defineProperty(fixture.image, 'getBoundingClientRect', {
      configurable: true,
      value: () => {
        geometryReads += 1;
        return readMainBounds();
      },
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;
    admissionReads = 0;
    geometryReads = 0;

    fixture.timers.run();
    expect(admissionReads).toBe(0);
    expect(geometryReads).toBe(0);
    expect(events).toEqual([]);

    const host = fixture.document.querySelector('#late-shadow-host')!;
    const root = host.attachShadow({ mode: 'open' });
    Object.defineProperty(root, 'mode', { configurable: true, value: 'open' });
    let settledHostReads = 0;
    Object.defineProperty(host, 'shadowRoot', {
      configurable: true,
      get: () => {
        settledHostReads += 1;
        return root;
      },
    });
    const image = fixture.document.createElement('img');
    setImageMetrics(image, fixture.bounds);
    fixture.nodeIds.set(image, 31);
    root.append(image);
    fixture.timers.run();
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'upsert',
        input: expect.objectContaining({ nodeId: 31 }),
      }),
    ]));
    expect(fixture.mutation.targets).toContain(root);
    const readsAfterDiscovery = settledHostReads;
    fixture.timers.run();
    expect(settledHostReads).toBe(readsAfterDiscovery);
    stop();
  });

  it('coalesces an oversized mutation delivery into one bounded global refresh', () => {
    let policyRefreshes = 0;
    const fixture = createFixture('', {
      beforeRefreshAll: () => { policyRefreshes += 1; },
    });
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => events.push(event));
    events.length = 0;
    fixture.mutation.trigger(Array.from({ length: 2_049 }, () =>
      attributeRecord(fixture.document.body, 'class')
    ));
    expect(policyRefreshes).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 7, contentChanged: true, observationChanged: true },
    });
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
      input: { nodeId: 7, contentChanged: true, captureChanged: false },
    });
    stop();
  });

  it('invalidates image content when alt or aria-label changes', () => {
    const fixture = createFixture();
    const model = new SourceImageModel();
    model.beginDocument(documentIdentity);
    const events: SourceImageObservationEvent[] = [];
    const stop = fixture.observer.subscribe((event) => {
      events.push(event);
      if (event.kind === 'upsert') model.upsert(event.input);
      else model.remove(event.document, event.nodeId);
    });
    expect(model.get(7)?.contentRevision).toBe(1);

    fixture.image.setAttribute('alt', 'お知らせ');
    fixture.mutation.trigger([attributeRecord(fixture.image, 'alt')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 7, contentChanged: true, captureChanged: false },
    });
    expect(model.get(7)?.contentRevision).toBe(2);
    expect(model.get(7)?.captureRevision).toBe(1);

    fixture.image.setAttribute('aria-label', 'Updated announcement');
    fixture.mutation.trigger([attributeRecord(fixture.image, 'aria-label')]);
    expect(events.at(-1)).toMatchObject({
      kind: 'upsert',
      input: { nodeId: 7, contentChanged: true, captureChanged: false },
    });
    expect(model.get(7)?.contentRevision).toBe(3);
    expect(model.get(7)?.captureRevision).toBe(1);
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
    readonly settleIntersectionsOnObserve?: boolean;
    readonly isPrivateImage?: (image: HTMLImageElement) => boolean;
    readonly beforeRefreshAll?: () => void;
    readonly beforeMutationRead?: (
      records: readonly MutationRecord[],
    ) => boolean | undefined;
    readonly layoutSettleRequiresRefreshAll?: (target: Element) => boolean;
  } = {},
) {
  const { document } = parseHTML(
    `<html><head><base href="https://page.example/root/"></head><body><img id="main" src="https://private.example/original.png">${extraHtml}</body></html>`,
  );
  Object.defineProperties(document.defaultView!, {
    innerWidth: { configurable: true, value: 1024 },
    innerHeight: { configurable: true, value: 768 },
  });
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
  const timers = new FakeTimerScheduler();
  const observer = new SourceImageObserver({
    document: document as unknown as Document,
    documentIdentity,
    getNodeId: (candidate) => nodeIds.get(candidate),
    createIntersectionObserver: (callback) => {
      const fake = new FakeIntersectionObserver(
        callback,
        options.settleIntersectionsOnObserve !== false,
      );
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
    ...(options.isPrivateImage
      ? { isPrivateImage: options.isPrivateImage }
      : {}),
    ...(options.beforeRefreshAll
      ? { beforeRefreshAll: options.beforeRefreshAll }
      : {}),
    ...(options.beforeMutationRead
      ? { beforeMutationRead: options.beforeMutationRead }
      : {}),
    ...(options.layoutSettleRequiresRefreshAll
      ? { layoutSettleRequiresRefreshAll: options.layoutSettleRequiresRefreshAll }
      : {}),
    ...(options.useDefaultFrames
      ? {}
      : {
          scheduleFrame: (callback: () => void) => frames.schedule(callback),
          cancelFrame: (frame: number) => frames.cancel(frame),
          setTimer: (callback: () => void) => timers.schedule(callback),
          clearTimer: (handle: unknown) => timers.cancel(handle as number),
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
    timers,
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

function setElementBounds(
  element: Element,
  bounds: { left: number; top: number; width: number; height: number },
): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
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
  });
}

class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(
    readonly callback: (entries: readonly IntersectionObserverEntry[]) => void,
    readonly settleOnObserve: boolean,
  ) {}

  observe(target: Element): void {
    this.targets.add(target);
    if (this.settleOnObserve) this.trigger(target, false);
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
  options: MutationObserverInit | undefined;
  readonly targets: Node[] = [];

  observe(target: Node, options?: MutationObserverInit): void {
    this.targets.push(target);
    this.options = options;
  }

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

class FakeTimerScheduler {
  readonly #callbacks = new Map<number, () => void>();
  #sequence = 0;

  schedule(callback: () => void): number {
    const handle = ++this.#sequence;
    this.#callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.#callbacks.delete(handle);
  }

  run(): void {
    const entry = this.#callbacks.entries().next().value as
      | [number, () => void]
      | undefined;
    if (!entry) throw new Error('Expected a scheduled timer.');
    this.#callbacks.delete(entry[0]);
    entry[1]();
  }
}

class FakeFontSettleTarget {
  readonly #loadingDoneListeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === 'loadingdone') this.#loadingDoneListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'loadingdone') this.#loadingDoneListeners.delete(listener);
  }

  dispatchLoadingDone(): void {
    for (const listener of [...this.#loadingDoneListeners]) listener();
  }
}

function applyObservationEvent(
  model: SourceImageModel,
  event: SourceImageObservationEvent,
): void {
  if (event.kind === 'upsert') model.upsert(event.input);
  else model.remove(event.document, event.nodeId);
}

function eventNodeId(event: SourceImageObservationEvent): number {
  return event.kind === 'upsert' ? event.input.nodeId : event.nodeId;
}

function attributeRecord(target: Element, attributeName: string): MutationRecord {
  return {
    type: 'attributes',
    target,
    attributeName,
  } as unknown as MutationRecord;
}
