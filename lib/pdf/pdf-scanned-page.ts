/**
 * The test for a scanned page that also carries a little typed text (a
 * header, a page number or a stamp over a scan): its own text covers little
 * of the page and its pictures cover most of it. A page with no text at all
 * is a scanned page without this test.
 */

/**
 * A page's own text covers at most this share of it: a header, a page
 * number, a stamp, typed entries on a form. A slide's title and bullets, or
 * a short letter, cover more.
 */
export const PDF_SCAN_TEXT_SHARE = 0.03;
/** The page's pictures cover at least this share of it. */
export const PDF_SCAN_IMAGE_SHARE = 0.8;

// The page is cut into this many cells a side to add up the pictures' boxes.
const GRID = 24;

/**
 * The share of the page its text runs cover: the sum of their boxes (the
 * advance by the font height) over the page's area. Rotated and vertical
 * runs count too. Overlapping runs count twice, which only makes a page with
 * much text look fuller.
 */
export function pdfTextShare(
  items: readonly { readonly str: string; readonly width: number; readonly height: number }[],
  page: { readonly width: number; readonly height: number },
): number {
  const area = page.width * page.height;
  if (!(area > 0) || !Number.isFinite(area)) return 1;
  let covered = 0;
  for (const item of items) {
    if (item.str.trim() === '') continue;
    const box = Math.abs(item.width * item.height);
    // A run pdf.js could not measure counts as a page full: no OCR then.
    if (!Number.isFinite(box)) return 1;
    covered += box;
  }
  return covered / area;
}

/** What an operator does to where pictures land, for `pdfImageCoverage`. */
export type PdfPaintOperator =
  | 'save'
  | 'restore'
  | 'transform'
  /** A form begins: saves, then applies its matrix (the first argument). */
  | 'form-begin'
  /** An annotation begins: saves, then starts from its own two matrices. */
  | 'annotation-begin'
  /** A picture on the unit square. */
  | 'image'
  /** One picture drawn at several places: scale x, scale y, positions. */
  | 'image-repeat'
  /** One stencil at several places: scale x, skew x, skew y, scale y, positions. */
  | 'mask-repeat'
  /** Several pictures, each with its own `transform`, in the first argument. */
  | 'image-group'
  /** Several inline pictures, each with its own `transform`, in the second. */
  | 'inline-group';

export interface PdfOperatorList {
  readonly fnArray: ArrayLike<number>;
  readonly argsArray: ArrayLike<unknown>;
}

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * The share of the page box `view` (`[x0, y0, x1, y1]` in PDF user space)
 * that the page's pictures cover, from its operator list: the union of the
 * pictures' boxes, clipped to the page. Clipping paths are not followed, so
 * a picture counts by its whole box.
 */
export function pdfImageCoverage(
  operators: PdfOperatorList,
  kinds: ReadonlyMap<number, PdfPaintOperator>,
  view: readonly number[],
): number {
  const [x0, y0, x1, y1] = [
    Math.min(view[0]!, view[2]!),
    Math.min(view[1]!, view[3]!),
    Math.max(view[0]!, view[2]!),
    Math.max(view[1]!, view[3]!),
  ];
  const width = x1 - x0;
  const height = y1 - y0;
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width * height)) return 0;
  const cells = new Uint8Array(GRID * GRID);
  const stack: Matrix[] = [];
  let current = IDENTITY;
  const paint = (matrix: Matrix | undefined) => {
    if (!matrix) return;
    // The unit square's corners under the matrix, as a box.
    const [a, b, c, d, e, f] = matrix;
    const xs = [e, e + a, e + c, e + a + c];
    const ys = [f, f + b, f + d, f + b + d];
    const left = (Math.min(...xs) - x0) / width * GRID;
    const right = (Math.max(...xs) - x0) / width * GRID;
    const bottom = (Math.min(...ys) - y0) / height * GRID;
    const top = (Math.max(...ys) - y0) / height * GRID;
    // A cell counts when the box holds its centre.
    const firstColumn = Math.max(0, Math.ceil(left - 0.5));
    const lastColumn = Math.min(GRID - 1, Math.floor(right - 0.5));
    const firstRow = Math.max(0, Math.ceil(bottom - 0.5));
    const lastRow = Math.min(GRID - 1, Math.floor(top - 0.5));
    for (let row = firstRow; row <= lastRow; row += 1) {
      cells.fill(1, row * GRID + firstColumn, row * GRID + lastColumn + 1);
    }
  };
  const count = Math.min(operators.fnArray.length, operators.argsArray.length);
  for (let index = 0; index < count; index += 1) {
    const kind = kinds.get(operators.fnArray[index]!);
    if (!kind) continue;
    const args = operators.argsArray[index];
    const list: ArrayLike<unknown> = Array.isArray(args) || ArrayBuffer.isView(args)
      ? (args as unknown as ArrayLike<unknown>)
      : [];
    switch (kind) {
      case 'save':
        stack.push(current);
        break;
      case 'restore':
        current = stack.pop() ?? current;
        break;
      case 'transform':
        current = multiply(current, readMatrix(list)) ?? current;
        break;
      case 'form-begin':
        stack.push(current);
        current = multiply(current, readMatrix(list[0])) ?? current;
        break;
      case 'annotation-begin':
        // An annotation is placed on the page, not within the content's state.
        stack.push(current);
        current = multiply(IDENTITY, readMatrix(list[2])) ?? IDENTITY;
        current = multiply(current, readMatrix(list[3])) ?? current;
        break;
      case 'image':
        paint(current);
        break;
      case 'image-repeat':
        paintRepeats(current, list[1], 0, 0, list[2], list[3], paint);
        break;
      case 'mask-repeat':
        paintRepeats(current, list[1], list[2], list[3], list[4], list[5], paint);
        break;
      case 'image-group':
        paintGroup(current, list[0], paint);
        break;
      case 'inline-group':
        paintGroup(current, list[1], paint);
        break;
    }
  }
  let covered = 0;
  for (const cell of cells) covered += cell;
  return covered / cells.length;
}

function paintRepeats(
  current: Matrix,
  scaleX: unknown,
  skewX: unknown,
  skewY: unknown,
  scaleY: unknown,
  positions: unknown,
  paint: (matrix: Matrix | undefined) => void,
): void {
  if (!isNumbers(positions)) return;
  for (let index = 0; index + 1 < positions.length; index += 2) {
    paint(multiply(
      current,
      readMatrix([scaleX, skewX, skewY, scaleY, positions[index], positions[index + 1]]),
    ));
  }
}

function paintGroup(
  current: Matrix,
  entries: unknown,
  paint: (matrix: Matrix | undefined) => void,
): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    paint(multiply(current, readMatrix((entry as { transform?: unknown } | null)?.transform)));
  }
}

function isNumbers(value: unknown): value is ArrayLike<number> {
  return Array.isArray(value) || ArrayBuffer.isView(value);
}

function readMatrix(value: unknown): Matrix | undefined {
  if (!isNumbers(value) || value.length < 6) return undefined;
  const matrix = [value[0], value[1], value[2], value[3], value[4], value[5]];
  return matrix.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
    ? (matrix as unknown as Matrix)
    : undefined;
}

/** `outer` after `inner`: a point goes through `inner` first. */
function multiply(outer: Matrix, inner: Matrix | undefined): Matrix | undefined {
  if (!inner) return undefined;
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}
