import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  hasSafeCaptureGeometry,
  ImageSourceSession,
  nearestValidElementLanguage,
} from '../lib/ocr/image-source-session';
import { createImageSourcePortName } from '../lib/ocr/image-source-protocol';
import { SourceImageObserver } from '../lib/ocr/source-image-observer';
import type { ReplicaSourceDocumentIdentity } from '../lib/replica/source-identity';

const baseStyle = {
  display: 'block',
  visibility: 'visible',
  opacity: '1',
  contentVisibility: 'visible',
  clipPath: 'none',
  maskImage: 'none',
  perspective: 'none',
  rotate: 'none',
  transform: 'none',
  overflowX: 'visible',
  overflowY: 'visible',
} as unknown as CSSStyleDeclaration;

describe('image source capture safety', () => {
  it('reports content-free initial candidate and observed image counts', () => {
    const { document, window } = parseHTML(
      '<html><body><img id="tracked"><button><img id="private"></button></body></html>',
    );
    const tracked = document.querySelector<HTMLImageElement>('#tracked')!;
    const privateImage = document.querySelector<HTMLImageElement>('#private')!;
    setImageFacts(tracked);
    setImageFacts(privateImage);
    const identity: ReplicaSourceDocumentIdentity = {
      sessionId: 'image-ready-session',
      pageEpoch: 1,
      generation: 1,
      documentId: 'image-ready-document',
      frameId: 0,
    };
    const port = new FakeImageSourcePort(
      createImageSourcePortName(identity.sessionId),
    );
    const session = new ImageSourceSession({
      port,
      document: document as unknown as Document,
      window: window as unknown as Window,
      resolveNode: () => null,
      getNodeId: (image) => image === tracked ? 7 : 9,
      createObserver: (environment) => new SourceImageObserver({
        ...environment,
        createIntersectionObserver: () => new NoopElementObserver(),
        createResizeObserver: () => new NoopElementObserver(),
        createMutationObserver: () => new NoopMutationObserver(),
      }),
    });

    port.emitMessage({
      kind: 'simul:image-source-v1:start',
      document: identity,
    });

    expect(port.messages.at(-1)).toEqual({
      kind: 'simul:image-source-v1:ready',
      document: identity,
      summary: { candidateImages: 2, observedImages: 1 },
    });
    expect(JSON.stringify(port.messages.at(-1))).not.toMatch(
      /(?:src|url|pixels|text|hash|nodeId)/iu,
    );
    session.dispose();
  });

  it('skips an invalid closest lang and uses the nearest valid ancestor', () => {
    const { document } = parseHTML(
      '<html lang="ja"><body><section lang="not-a-language"><img></section></body></html>',
    );
    expect(nearestValidElementLanguage(document.querySelector('img')!)).toBe('ja');
  });

  it('rejects hidden, rotated, and private-control-overlapped pixels', () => {
    const { document } = parseHTML(
      '<html><body><img id="image"><input id="private"></body></html>',
    );
    const image = document.querySelector('#image')! as unknown as HTMLImageElement;
    const control = document.querySelector('#private')!;
    const imageRect = rect(10, 10, 200, 100);
    Object.defineProperty(image, 'getBoundingClientRect', {
      value: () => imageRect,
    });
    Object.defineProperty(control, 'getBoundingClientRect', {
      value: () => rect(50, 30, 80, 30),
    });
    const styles = new Map<Element, CSSStyleDeclaration>();
    const sourceWindow = {
      getComputedStyle: (element: Element) => styles.get(element) ?? baseStyle,
    } as unknown as Window;

    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);

    control.remove();
    styles.set(image, { ...baseStyle, visibility: 'hidden' });
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);

    styles.set(image, { ...baseStyle, transform: 'matrix(0, 1, -1, 0, 0, 0)' });
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(false);

    styles.set(image, baseStyle);
    expect(hasSafeCaptureGeometry(
      image,
      imageRect,
      document as unknown as Document,
      sourceWindow,
    )).toBe(true);
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function setImageFacts(image: HTMLImageElement): void {
  Object.defineProperties(image, {
    naturalWidth: { configurable: true, value: 200 },
    naturalHeight: { configurable: true, value: 100 },
    getBoundingClientRect: {
      configurable: true,
      value: () => rect(0, 0, 200, 100),
    },
  });
}

class FakeImageSourcePort {
  readonly messages: unknown[] = [];
  readonly onMessage = new FakeEvent<(message: unknown) => void>();
  readonly onDisconnect = new FakeEvent<() => void>();

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  disconnect(): void {}

  emitMessage(message: unknown): void {
    this.onMessage.emit(message);
  }
}

class FakeEvent<T extends (...args: never[]) => void> {
  readonly #listeners = new Set<T>();

  addListener(listener: T): void {
    this.#listeners.add(listener);
  }

  removeListener(listener: T): void {
    this.#listeners.delete(listener);
  }

  emit(...args: Parameters<T>): void {
    for (const listener of this.#listeners) listener(...args);
  }
}

class NoopElementObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class NoopMutationObserver {
  observe(): void {}
  disconnect(): void {}
}
