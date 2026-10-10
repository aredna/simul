const TRANSFORM_EPSILON = 1e-7;
const CSS_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const CSS_PERCENTAGE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)%$/iu;

/** Paint-state gate shared by observation invalidation and final capture. */
export function styleAllowsImageCapture(style: CSSStyleDeclaration): boolean {
  const opacity = Number.parseFloat(style.opacity || '1');
  return style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.visibility !== 'collapse' &&
    style.contentVisibility !== 'hidden' &&
    Number.isFinite(opacity) && opacity > 0 &&
    (style.clipPath === '' || style.clipPath === 'none') &&
    (style.maskImage === '' || style.maskImage === 'none') &&
    (style.perspective === '' || style.perspective === 'none');
}

/**
 * The first part of a computed `content` when it is text and no image.
 * Chrome replaces an `<img>`'s picture only when the first part is an image
 * (`url()`, `image-set()`, a gradient); with a string, a counter or a quote
 * first, the image shows its file, whatever follows. (`attr()` computes to
 * its string, `contents` to `normal`.)
 */
const CONTENT_TEXT_PART =
  /^(?:normal|none|(?:no-)?(?:open|close)-quote|counters?\(|")/u;
/**
 * A computed `object-view-box` that leaves the whole file. Chrome writes
 * `inset()`, `xywh()` and `rect()` alike as insets, and paints the same
 * with a `round` part as without.
 */
const WHOLE_FILE_VIEW_BOX =
  /^inset\(\s*0(?:px|%)?(?:\s+0(?:px|%)?){0,3}(?:\s+round\s[^)]*)?\s*\)$/u;

/**
 * Whether CSS alone decides which picture an `<img>` shows: a computed
 * `content` whose first part is an image, other than the image's own
 * current file, replaces the picture of its file, and an `object-view-box`
 * that is not the whole file shows a part of it. The image's address and
 * its file then say nothing of what it paints, so its text can only be read
 * from the screen. `ownFile` is the image's `currentSrc`. A value this does
 * not know counts as a picture: such an image is read from the screen,
 * which is right whatever it shows.
 */
export function styleReplacesImagePicture(
  style: CSSStyleDeclaration,
  ownFile = '',
): boolean {
  const content = (style.content ?? '').trim();
  const viewBox = (style.getPropertyValue?.('object-view-box') ?? '').trim();
  return (
    content !== '' &&
    !CONTENT_TEXT_PART.test(content) &&
    !contentIsFile(content, ownFile)
  ) || !(viewBox === '' || viewBox === 'none' || WHOLE_FILE_VIEW_BOX.test(viewBox));
}

/** `content: url(<the file>)`, with or without a text alternative. */
function contentIsFile(content: string, file: string): boolean {
  if (file === '') return false;
  const match = /^url\("([^"]*)"\)(?:\s*\/.*)?$/su.exec(content);
  return match?.[1] === file;
}

/**
 * Accept only positive X/Y scaling plus translation. This includes Slick-like
 * translate3d matrices while rejecting reflection, rotation, skew, Z mixing,
 * and perspective that an axis-aligned screenshot crop cannot map safely.
 */
export function imageTransformIsAxisAligned(
  style: CSSStyleDeclaration,
): boolean {
  if (!zeroRotate(style.rotate)) return false;
  if (!positiveAxisAlignedScale(style.scale)) return false;
  const transform = style.transform;
  if (!transform || transform === 'none') return true;

  const matrix = parseComputedMatrix(transform, 'matrix', 6);
  if (matrix) {
    return positive(matrix[0]) && positive(matrix[3]) &&
      zero(matrix[1]) && zero(matrix[2]);
  }

  const matrix3d = parseComputedMatrix(transform, 'matrix3d', 16);
  if (!matrix3d) return false;
  return positive(matrix3d[0]) && positive(matrix3d[5]) &&
    zero(matrix3d[1]) && zero(matrix3d[2]) && zero(matrix3d[3]) &&
    zero(matrix3d[4]) && zero(matrix3d[6]) && zero(matrix3d[7]) &&
    zero(matrix3d[8]) && zero(matrix3d[9]) && one(matrix3d[10]) &&
    zero(matrix3d[11]) && zero(matrix3d[14]) && one(matrix3d[15]);
}

/**
 * CSS individual `scale` composes with `transform`, so it must be validated
 * independently. X/Y may scale only by a positive amount; a third component
 * would move the image out of the screenshot plane unless it is neutral.
 */
function positiveAxisAlignedScale(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === '' || normalized === 'none') return true;
  const parts = normalized.split(/\s+/u);
  if (parts.length < 1 || parts.length > 3) return false;
  const values = parts.map(parseScaleComponent);
  if (values.some((component) => component === undefined)) return false;
  const x = values[0];
  const y = values[1] ?? x;
  const z = values[2] ?? 1;
  return positive(x) && positive(y) && one(z);
}

function parseScaleComponent(value: string): number | undefined {
  if (CSS_NUMBER.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const percentage = CSS_PERCENTAGE.exec(value);
  if (!percentage?.[1]) return undefined;
  const parsed = Number(percentage[1]) / 100;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseComputedMatrix(
  value: string,
  functionName: 'matrix' | 'matrix3d',
  length: number,
): readonly number[] | undefined {
  const match = new RegExp(`^${functionName}\\((.*)\\)$`, 'iu').exec(value);
  if (!match?.[1]) return undefined;
  const rawValues = match[1].split(',').map((part) => part.trim());
  if (rawValues.length !== length || rawValues.some((part) => !CSS_NUMBER.test(part))) {
    return undefined;
  }
  const values = rawValues.map(Number);
  return values.every(Number.isFinite) ? Object.freeze(values) : undefined;
}

function zeroRotate(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized === '' || normalized === 'none' ||
    /^[+-]?(?:0+(?:\.0*)?|\.0+)(?:deg|grad|rad|turn)?$/u.test(normalized);
}

function positive(value: number | undefined): boolean {
  return value !== undefined && value > TRANSFORM_EPSILON;
}

function zero(value: number | undefined): boolean {
  return value !== undefined && Math.abs(value) < TRANSFORM_EPSILON;
}

function one(value: number | undefined): boolean {
  return value !== undefined && Math.abs(value - 1) < TRANSFORM_EPSILON;
}
