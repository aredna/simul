import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  hasSafeCaptureGeometry,
  nearestValidElementLanguage,
} from '../lib/ocr/image-source-session';

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
