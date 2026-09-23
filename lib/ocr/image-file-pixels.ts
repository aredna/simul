import {
  selectOcrPreprocessingPlan,
  type OcrPreprocessingVersion,
} from './preprocessing-profile';

/**
 * Where an `<img>` paints its file inside its own border box. The source
 * rectangle is a fraction of the image's natural size, so the same placement
 * applies to any loaded copy of the same resource (the source tab's, the
 * mirror's, or a downloaded file) whatever resolution it decoded at. The
 * destination is in CSS pixels relative to the border box.
 */
export interface ImageFilePlacement {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly destX: number;
  readonly destY: number;
  readonly destWidth: number;
  readonly destHeight: number;
  readonly boxWidth: number;
  readonly boxHeight: number;
}

/**
 * How an `<img>` box lays out its file, read from the source tab: the border
 * box, its border+padding insets, and the computed fit and position. It does
 * not depend on the file, so it also describes a lazy image the tab has not
 * fetched yet; the placement is computed once a copy's size is known.
 */
export interface ImageFileLayout {
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly insetLeft: number;
  readonly insetTop: number;
  readonly insetRight: number;
  readonly insetBottom: number;
  readonly objectFit: ImageObjectFit;
  readonly objectPosition: string;
}

export type ImageObjectFit = 'fill' | 'contain' | 'cover' | 'none' | 'scale-down';

const OBJECT_FITS: ReadonlySet<string> = new Set([
  'fill', 'contain', 'cover', 'none', 'scale-down',
]);
const MAX_OBJECT_POSITION_LENGTH = 128;

export interface ImageFilePlacementInput extends Omit<ImageFileLayout, 'objectFit'> {
  readonly objectFit: string;
  readonly naturalWidth: number;
  readonly naturalHeight: number;
}

interface PositionComponent {
  readonly percent: number;
  readonly pixels: number;
}

const MAX_CSS_EXTENT = 1_000_000;
const FRACTION_EPSILON = 1e-6;

/**
 * Maps `object-fit` and `object-position` onto the content box, then clips
 * the painted image to it. Unknown fit values or positions fail closed.
 */
export function computeImageFilePlacement(
  input: ImageFilePlacementInput,
): ImageFilePlacement | undefined {
  const values = [
    input.boxWidth, input.boxHeight, input.insetLeft, input.insetTop,
    input.insetRight, input.insetBottom, input.naturalWidth,
    input.naturalHeight,
  ];
  if (!values.every((value) =>
    Number.isFinite(value) && value >= 0 && value <= MAX_CSS_EXTENT)) {
    return undefined;
  }
  const contentX = input.insetLeft;
  const contentY = input.insetTop;
  const contentWidth = input.boxWidth - input.insetLeft - input.insetRight;
  const contentHeight = input.boxHeight - input.insetTop - input.insetBottom;
  if (
    contentWidth <= 0 || contentHeight <= 0 ||
    input.naturalWidth <= 0 || input.naturalHeight <= 0
  ) return undefined;
  const position = parseObjectPosition(input.objectPosition);
  if (!position) return undefined;
  const contain = Math.min(
    contentWidth / input.naturalWidth,
    contentHeight / input.naturalHeight,
  );
  const cover = Math.max(
    contentWidth / input.naturalWidth,
    contentHeight / input.naturalHeight,
  );
  let paintedWidth: number;
  let paintedHeight: number;
  switch (input.objectFit.trim().toLowerCase()) {
    case '':
    case 'fill':
      paintedWidth = contentWidth;
      paintedHeight = contentHeight;
      break;
    case 'contain':
      paintedWidth = input.naturalWidth * contain;
      paintedHeight = input.naturalHeight * contain;
      break;
    case 'cover':
      paintedWidth = input.naturalWidth * cover;
      paintedHeight = input.naturalHeight * cover;
      break;
    case 'none':
      paintedWidth = input.naturalWidth;
      paintedHeight = input.naturalHeight;
      break;
    case 'scale-down': {
      const scale = Math.min(1, contain);
      paintedWidth = input.naturalWidth * scale;
      paintedHeight = input.naturalHeight * scale;
      break;
    }
    default:
      return undefined;
  }
  const paintedX = contentX + (contentWidth - paintedWidth) *
    position.x.percent / 100 + position.x.pixels;
  const paintedY = contentY + (contentHeight - paintedHeight) *
    position.y.percent / 100 + position.y.pixels;
  const left = Math.max(contentX, paintedX);
  const top = Math.max(contentY, paintedY);
  const right = Math.min(contentX + contentWidth, paintedX + paintedWidth);
  const bottom = Math.min(contentY + contentHeight, paintedY + paintedHeight);
  if (right - left <= 0 || bottom - top <= 0) return undefined;
  return Object.freeze({
    sourceX: clampFraction((left - paintedX) / paintedWidth),
    sourceY: clampFraction((top - paintedY) / paintedHeight),
    sourceWidth: clampFraction((right - left) / paintedWidth),
    sourceHeight: clampFraction((bottom - top) / paintedHeight),
    destX: left,
    destY: top,
    destWidth: right - left,
    destHeight: bottom - top,
    boxWidth: input.boxWidth,
    boxHeight: input.boxHeight,
  });
}

/**
 * Reads a computed `object-position`: two components, each `P%`, `Lpx`, or
 * `calc(P% ± Lpx)`. Chrome resolves keywords to percentages.
 */
export function parseObjectPosition(
  value: string,
): { readonly x: PositionComponent; readonly y: PositionComponent } | undefined {
  const normalized = value.trim().toLowerCase();
  const components = splitTopLevel(normalized === '' ? '50% 50%' : normalized);
  if (components.length !== 2) return undefined;
  const x = parsePositionComponent(components[0]!);
  const y = parsePositionComponent(components[1]!);
  return x && y ? Object.freeze({ x, y }) : undefined;
}

/**
 * `fill`, `contain` and `cover` depend only on the file's aspect ratio, so any
 * decoded copy may supply it; `none` and `scale-down` need the CSS natural size
 * the page itself reports.
 */
export function layoutNeedsCssNaturalSize(layout: ImageFileLayout): boolean {
  return layout.objectFit === 'none' || layout.objectFit === 'scale-down';
}

export function validImageFileLayout(value: unknown): value is ImageFileLayout {
  if (typeof value !== 'object' || value === null) return false;
  const layout = value as Record<string, unknown>;
  const numbers = [
    'boxWidth', 'boxHeight', 'insetLeft', 'insetTop', 'insetRight', 'insetBottom',
  ];
  if (Object.keys(layout).length !== numbers.length + 2) return false;
  if (!numbers.every((key) =>
    typeof layout[key] === 'number' && Number.isFinite(layout[key]) &&
    (layout[key] as number) >= 0 && (layout[key] as number) <= MAX_CSS_EXTENT)) {
    return false;
  }
  return (layout.boxWidth as number) > 0 && (layout.boxHeight as number) > 0 &&
    typeof layout.objectFit === 'string' && OBJECT_FITS.has(layout.objectFit) &&
    typeof layout.objectPosition === 'string' &&
    layout.objectPosition.length <= MAX_OBJECT_POSITION_LENGTH &&
    parseObjectPosition(layout.objectPosition) !== undefined;
}

export function validImageFilePlacement(
  value: unknown,
): value is ImageFilePlacement {
  if (typeof value !== 'object' || value === null) return false;
  const placement = value as Record<string, unknown>;
  const keys = [
    'sourceX', 'sourceY', 'sourceWidth', 'sourceHeight', 'destX', 'destY',
    'destWidth', 'destHeight', 'boxWidth', 'boxHeight',
  ];
  if (
    Object.keys(placement).length !== keys.length ||
    !keys.every((key) =>
      typeof placement[key] === 'number' && Number.isFinite(placement[key]))
  ) return false;
  const v = placement as unknown as ImageFilePlacement;
  return v.sourceX >= 0 && v.sourceY >= 0 &&
    v.sourceWidth > 0 && v.sourceHeight > 0 &&
    v.sourceX + v.sourceWidth <= 1 + FRACTION_EPSILON &&
    v.sourceY + v.sourceHeight <= 1 + FRACTION_EPSILON &&
    v.boxWidth > 0 && v.boxHeight > 0 &&
    v.boxWidth <= MAX_CSS_EXTENT && v.boxHeight <= MAX_CSS_EXTENT &&
    v.destX >= 0 && v.destY >= 0 && v.destWidth > 0 && v.destHeight > 0 &&
    v.destX + v.destWidth <= v.boxWidth + 1 &&
    v.destY + v.destHeight <= v.boxHeight + 1;
}

/** Reads an `<img>` box's layout from its own offsets and computed style. */
export function readImageFileLayout(
  image: HTMLImageElement,
  view: Window,
): ImageFileLayout | undefined {
  try {
    const style = view.getComputedStyle(image);
    const px = (name: string): number => {
      const parsed = Number.parseFloat(style.getPropertyValue(name));
      return Number.isFinite(parsed) ? parsed : Number.NaN;
    };
    const fit = style.getPropertyValue('object-fit').trim().toLowerCase() || 'fill';
    const layout = {
      boxWidth: image.offsetWidth,
      boxHeight: image.offsetHeight,
      insetLeft: px('border-left-width') + px('padding-left'),
      insetTop: px('border-top-width') + px('padding-top'),
      insetRight: px('border-right-width') + px('padding-right'),
      insetBottom: px('border-bottom-width') + px('padding-bottom'),
      objectFit: fit,
      objectPosition: style.getPropertyValue('object-position').trim().toLowerCase() ||
        '50% 50%',
    };
    return validImageFileLayout(layout) ? Object.freeze(layout) : undefined;
  } catch {
    return undefined;
  }
}

export interface ImageFileSurface {
  getContext(contextId: '2d'): {
    drawImage(
      image: CanvasImageSource,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number,
    ): void;
  } | null;
  convertToBlob(options: { readonly type: 'image/png' }): Promise<Blob>;
}

export interface RenderedImageFilePixels {
  readonly encoded: Blob;
  readonly pixelHash: string;
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly preprocessingVersion: OcrPreprocessingVersion;
  readonly cropOffsetXCss: number;
  readonly cropOffsetYCss: number;
  readonly cropWidthCss: number;
  readonly cropHeightCss: number;
  readonly renderedWidthCss: number;
  readonly renderedHeightCss: number;
}

export interface ImageFileRenderEnvironment {
  readonly createSurface: (width: number, height: number) => ImageFileSurface;
  readonly digest: (bytes: ArrayBuffer) => Promise<ArrayBuffer>;
}

const MIN_OCR_BITMAP_AXIS_PX = 3;

/**
 * Draws the painted part of a loaded image copy at its own resolution, under
 * the OCR pixel budget. A cross-origin copy the extension cannot read throws
 * a SecurityError from `convertToBlob`; callers treat any throw as "this copy
 * is not usable" and try the next source.
 */
export async function renderImageFilePixels(
  image: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
  placement: ImageFilePlacement,
  environment: ImageFileRenderEnvironment,
  maxPixels: number,
  signal?: AbortSignal,
): Promise<RenderedImageFilePixels | undefined> {
  if (
    !Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 || naturalHeight <= 0
  ) return undefined;
  const sourceX = placement.sourceX * naturalWidth;
  const sourceY = placement.sourceY * naturalHeight;
  const sourceWidth = placement.sourceWidth * naturalWidth;
  const sourceHeight = placement.sourceHeight * naturalHeight;
  const plan = selectOcrPreprocessingPlan(
    Math.max(1, Math.round(sourceWidth)),
    Math.max(1, Math.round(sourceHeight)),
    maxPixels,
    placement.destWidth,
    placement.destHeight,
  );
  if (
    !plan ||
    plan.width < MIN_OCR_BITMAP_AXIS_PX ||
    plan.height < MIN_OCR_BITMAP_AXIS_PX
  ) return undefined;
  signal?.throwIfAborted();
  const surface = environment.createSurface(plan.width, plan.height);
  const context = surface.getContext('2d');
  if (!context) return undefined;
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    plan.width,
    plan.height,
  );
  const encoded = await surface.convertToBlob({ type: 'image/png' });
  signal?.throwIfAborted();
  if (encoded.size < 1) return undefined;
  const pixelHash = toHex(await environment.digest(await encoded.arrayBuffer()));
  return Object.freeze({
    encoded,
    pixelHash,
    bitmapWidth: plan.width,
    bitmapHeight: plan.height,
    preprocessingVersion: plan.version,
    cropOffsetXCss: placement.destX,
    cropOffsetYCss: placement.destY,
    cropWidthCss: Math.min(placement.destWidth, placement.boxWidth - placement.destX),
    cropHeightCss: Math.min(placement.destHeight, placement.boxHeight - placement.destY),
    renderedWidthCss: placement.boxWidth,
    renderedHeightCss: placement.boxHeight,
  });
}

function parsePositionComponent(value: string): PositionComponent | undefined {
  const percent = /^(-?\d+(?:\.\d+)?)%$/u.exec(value);
  if (percent) return { percent: Number(percent[1]), pixels: 0 };
  const pixels = /^(-?\d+(?:\.\d+)?)px$/u.exec(value);
  if (pixels) return { percent: 0, pixels: Number(pixels[1]) };
  const calc = /^calc\((-?\d+(?:\.\d+)?)%\s*([+-])\s*(\d+(?:\.\d+)?)px\)$/u
    .exec(value);
  if (calc) {
    const sign = calc[2] === '-' ? -1 : 1;
    return { percent: Number(calc[1]), pixels: sign * Number(calc[3]) };
  }
  if (value === '0') return { percent: 0, pixels: 0 };
  return undefined;
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (/\s/u.test(character) && depth === 0) {
      if (current) parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
