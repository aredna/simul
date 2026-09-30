/**
 * Reads the colours a translation overlay needs from a drawn PDF page: the
 * background around a block's lines (to cover them) and the colour of its
 * text (to write the translation in). Works on plain RGBA pixels, so it runs
 * the same on a canvas's `ImageData` and in tests.
 */

export interface RgbaPixels {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** A rectangle in the pixels' own coordinates. */
export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface BlockColours {
  /** CSS colours, `rgb(r, g, b)`. */
  readonly background: string;
  readonly ink: string;
}

export const DEFAULT_BLOCK_COLOURS: BlockColours = Object.freeze({
  background: 'rgb(255, 255, 255)',
  ink: 'rgb(0, 0, 0)',
});

// At most this many pixels are read around, and inside, one block.
const MAX_RING_SAMPLES = 480;
const MAX_INSIDE_SAMPLES = 12_000;
// The ring runs this many pixels outside the lines.
const RING_OFFSETS = [2, 3] as const;
// Ink must differ from the background at least this much (RGB distance).
const MIN_INK_DISTANCE = 64;
// Faint text (light grey, pastel) that never gets that far is still text
// when its farthest pixel is this far from the background.
const MIN_FAINT_DISTANCE = 16;
// With fewer pixels than this inside the lines, the ring alone gives the
// background.
const MIN_INSIDE_FOR_BACKGROUND = 24;
// The pixels inside the lines count this many times as much, all together,
// as the ring around them: the ring only settles a near tie.
const INSIDE_WEIGHT = 10;
// The ink colour is the average of this share of the text pixels farthest
// from the background (at least three of them): small text drawn at one
// device pixel per CSS pixel has few pixels at its full colour.
const INK_SHARE = 0.005;
// A colour whose spread between channels is below this share of its distance
// from the background is grey with the coloured fringes of subpixel
// antialiasing.
const NEUTRAL_CHROMA = 0.1;

type Rgb = readonly [number, number, number];

interface PixelBounds {
  readonly left: number;
  readonly top: number;
  /** Exclusive. */
  readonly right: number;
  readonly bottom: number;
}

export interface SampleOptions {
  /**
   * How far past each line its cover reaches, in pixels. The ring is read
   * just outside that, so it never meets the covered text.
   */
  readonly ringPadding?: number;
}

/**
 * `lines` are the text's own line boxes (not padded). The background is the
 * dominant colour inside those boxes together with a ring around them,
 * weighting the inside, so a fill snug around the text (a table header)
 * wins over the page beyond it. The ink is read from the boxes slightly
 * inset, so a neighbouring line's descenders cannot reach it.
 */
export function sampleBlockColours(
  pixels: RgbaPixels,
  lines: readonly PixelRect[],
  options: SampleOptions = {},
): BlockColours {
  if (!(pixels.width > 0) || !(pixels.height > 0)) return DEFAULT_BLOCK_COLOURS;
  const boxes = lines.flatMap((line) => {
    const clipped = clip(pixels, line, 0);
    return clipped ? [{ line, clipped }] : [];
  });
  if (boxes.length === 0) return DEFAULT_BLOCK_COLOURS;
  const padding = Number.isFinite(options.ringPadding) && options.ringPadding! > 0
    ? options.ringPadding!
    : 0;
  const ring = ringSamples(pixels, boxes.map(({ line }) => grow(line, padding)));
  const inside = insideSamples(pixels, boxes.map(({ line, clipped }) =>
    clip(pixels, inset(line), 0) ?? clipped));
  const background = inside.length >= MIN_INSIDE_FOR_BACKGROUND
    ? dominantColour([
        { colours: inside, weight: INSIDE_WEIGHT * Math.max(1, ring.length) / inside.length },
        { colours: ring, weight: 1 },
      ])
    : dominantColour([{ colours: ring.length > 0 ? ring : inside, weight: 1 }]);
  if (!background) return DEFAULT_BLOCK_COLOURS;
  const byDistance = inside
    .map((colour) => ({ colour, distance: distance(colour, background) }))
    .sort((left, right) => right.distance - left.distance);
  // Small text is mostly antialiased edge; its own colour is where the
  // pixels are farthest from the background. Nothing is pushed past them.
  const distant = byDistance.filter(({ distance: value }) => value >= MIN_INK_DISTANCE);
  const faint = byDistance.filter(({ distance: value }) => value >= MIN_FAINT_DISTANCE);
  const pool = distant.length > 0 ? distant : faint;
  const ink = pool.length > 0
    ? neutral(background, averageColour(pool
      .slice(0, Math.max(3, Math.ceil(pool.length * INK_SHARE)))
      .map(({ colour }) => colour)))
    : contrasting(background);
  return { background: css(background), ink: css(ink) };
}

function grow(rect: PixelRect, by: number): PixelRect {
  return {
    left: rect.left - by,
    top: rect.top - by,
    width: rect.width + 2 * by,
    height: rect.height + 2 * by,
  };
}

/** A line box less a pixel or so on each side. */
function inset(rect: PixelRect): PixelRect {
  const by = Math.max(1, 0.08 * rect.height);
  return grow(rect, -by);
}

/**
 * `rect` grown by `margin` and cut to the pixels, in whole pixels; nothing
 * when no pixel is left or the rect is not a finite area. Clipping first
 * keeps every loop short, whatever the coordinates.
 */
function clip(pixels: RgbaPixels, rect: PixelRect, margin: number): PixelBounds | undefined {
  if (
    ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) ||
    !(rect.width > 0) || !(rect.height > 0)
  ) return undefined;
  const left = Math.max(0, Math.floor(rect.left) - margin);
  const top = Math.max(0, Math.floor(rect.top) - margin);
  const right = Math.min(pixels.width, Math.ceil(rect.left + rect.width) + margin);
  const bottom = Math.min(pixels.height, Math.ceil(rect.top + rect.height) + margin);
  return right > left && bottom > top ? { left, top, right, bottom } : undefined;
}

/** Pixels on the outline of each line grown by the ring offsets, inside the canvas. */
function ringSamples(pixels: RgbaPixels, rects: readonly PixelRect[]): Rgb[] {
  const rings = rects.flatMap((rect) => RING_OFFSETS.flatMap((offset) => {
    const unclipped = {
      left: Math.floor(rect.left) - offset,
      top: Math.floor(rect.top) - offset,
      right: Math.ceil(rect.left + rect.width) + offset,
      bottom: Math.ceil(rect.top + rect.height) + offset,
    };
    const clipped = clip(pixels, rect, offset);
    return clipped ? [{ unclipped, clipped }] : [];
  }));
  const perimeter = rings.reduce((sum, { clipped }) =>
    sum + 2 * (clipped.right - clipped.left + clipped.bottom - clipped.top), 0);
  const step = Math.max(1, perimeter / MAX_RING_SAMPLES);
  const samples: Rgb[] = [];
  for (const { unclipped, clipped } of rings) {
    // An edge of the ring outside the canvas has no pixels to read.
    for (let x = clipped.left; x < clipped.right; x += step) {
      if (unclipped.top >= 0) pushPixel(samples, pixels, x, unclipped.top);
      if (unclipped.bottom < pixels.height) pushPixel(samples, pixels, x, unclipped.bottom);
    }
    for (let y = clipped.top; y < clipped.bottom; y += step) {
      if (unclipped.left >= 0) pushPixel(samples, pixels, unclipped.left, y);
      if (unclipped.right < pixels.width) pushPixel(samples, pixels, unclipped.right, y);
    }
  }
  return samples;
}

function insideSamples(pixels: RgbaPixels, rects: readonly PixelBounds[]): Rgb[] {
  const area = rects.reduce((sum, rect) =>
    sum + (rect.right - rect.left) * (rect.bottom - rect.top), 0);
  const step = Math.max(1, Math.sqrt(area / MAX_INSIDE_SAMPLES));
  const samples: Rgb[] = [];
  for (const rect of rects) {
    for (let y = rect.top; y < rect.bottom; y += step) {
      for (let x = rect.left; x < rect.right; x += step) {
        pushPixel(samples, pixels, x, y);
      }
    }
  }
  return samples;
}

function pushPixel(samples: Rgb[], pixels: RgbaPixels, x: number, y: number): void {
  const column = Math.floor(x);
  const row = Math.floor(y);
  if (column < 0 || row < 0 || column >= pixels.width || row >= pixels.height) return;
  const offset = (row * pixels.width + column) * 4;
  const alpha = pixels.data[offset + 3] ?? 255;
  // A transparent pixel shows the white page under the canvas.
  if (alpha < 128) {
    samples.push([255, 255, 255]);
    return;
  }
  samples.push([
    pixels.data[offset] ?? 0,
    pixels.data[offset + 1] ?? 0,
    pixels.data[offset + 2] ?? 0,
  ]);
}

/**
 * The most common colour over weighted groups of samples: the coarse bucket
 * with the most weight, then the exact colour weighing most in it (so
 * antialiased edges of the same hue do not shift it).
 */
function dominantColour(
  groups: readonly { readonly colours: readonly Rgb[]; readonly weight: number }[],
): Rgb | undefined {
  const buckets = new Map<number, { weight: number; colours: Map<number, { colour: Rgb; weight: number }> }>();
  for (const { colours, weight } of groups) {
    for (const colour of colours) {
      const key = ((colour[0] >> 4) << 8) | ((colour[1] >> 4) << 4) | (colour[2] >> 4);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { weight: 0, colours: new Map() };
        buckets.set(key, bucket);
      }
      bucket.weight += weight;
      const exact = (colour[0] << 16) | (colour[1] << 8) | colour[2];
      const entry = bucket.colours.get(exact);
      if (entry) entry.weight += weight;
      else bucket.colours.set(exact, { colour, weight });
    }
  }
  let best: { weight: number; colours: Map<number, { colour: Rgb; weight: number }> } | undefined;
  for (const bucket of buckets.values()) {
    if (!best || bucket.weight > best.weight) best = bucket;
  }
  let top: { colour: Rgb; weight: number } | undefined;
  for (const entry of best?.colours.values() ?? []) {
    if (!top || entry.weight > top.weight) top = entry;
  }
  return top?.colour;
}

function averageColour(colours: readonly Rgb[]): Rgb {
  const sum: [number, number, number] = [0, 0, 0];
  for (const colour of colours) {
    sum[0] += colour[0];
    sum[1] += colour[1];
    sum[2] += colour[2];
  }
  return [
    Math.round(sum[0] / colours.length),
    Math.round(sum[1] / colours.length),
    Math.round(sum[2] / colours.length),
  ];
}

/** A nearly grey colour, tinted only by antialiasing fringes, as grey. */
function neutral(background: Rgb, colour: Rgb): Rgb {
  const chroma = Math.max(...colour) - Math.min(...colour);
  if (chroma >= NEUTRAL_CHROMA * distance(background, colour)) return colour;
  const grey = Math.round((colour[0] + colour[1] + colour[2]) / 3);
  return [grey, grey, grey];
}

function distance(left: Rgb, right: Rgb): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function contrasting(background: Rgb): Rgb {
  const luminance = 0.2126 * background[0] + 0.7152 * background[1] + 0.0722 * background[2];
  return luminance > 140 ? [0, 0, 0] : [255, 255, 255];
}

function css(colour: Rgb): string {
  return `rgb(${colour[0]}, ${colour[1]}, ${colour[2]})`;
}
