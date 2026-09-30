/** How a translation overlay borrows the look of the PDF text it covers. */

export interface PdfFontFace {
  readonly bold: boolean;
  readonly italic: boolean;
}

export const REGULAR_FONT_FACE: PdfFontFace = Object.freeze({ bold: false, italic: false });

/** A translation shrinks to no less than this share of the source font size. */
export const MIN_PDF_FIT_SCALE = 0.5;

// Style words in a font name, whole or abbreviated (MinionPro-It,
// HelveticaNeueLTStd-BdIt, Arial,BoldItalic, NimbusRomNo9L-MediItal, where
// "Medi" is Nimbus's bold; "Medium" alone is not bold).
const BOLD_WORD = /^(?:(?:semi|demi|extra|ultra)?bold|black|heavy|demi|bd|blk|hv|medi)$/iu;
const ITALIC_WORD = /^(?:italic|oblique|ital|it|obl)$/iu;
// TeX's Computer Modern and its relatives name the style in the family:
// CMBX10 (bold extended), CMB10, CMSSBX10, SFBX1000, ECBX1000; CMTI10
// (italic), CMSL10 (slanted), CMBXTI10, CMSSI10, SFTI1000, SFSL1000.
const TEX_BOLD = /^(?:CMBX|CMB\d|CMSSBX|SFBX|ECBX)/u;
const TEX_ITALIC = /^(?:CMTI|CMSL|CMBXTI|CMSSI|SFTI|SFSL)/u;

/**
 * Weight and slant from a PDF font name such as `ABCDEF+Calibri-BoldItalic`
 * (the six-letter prefix marks an embedded subset). Only the style part is
 * read: after the last `-` or `,`, or the whole name when there is neither,
 * split into its capitalised words.
 */
export function fontFaceFromName(name: unknown): PdfFontFace {
  if (typeof name !== 'string' || name.length === 0) return REGULAR_FONT_FACE;
  const base = name.replace(/^[A-Z]{6}\+/u, '');
  const style = base.slice(Math.max(base.lastIndexOf('-'), base.lastIndexOf(',')) + 1);
  const words = style.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/gu) ?? [];
  return {
    bold: TEX_BOLD.test(base) || words.some((word) => BOLD_WORD.test(word)),
    italic: TEX_ITALIC.test(base) || words.some((word) => ITALIC_WORD.test(word)),
  };
}

export interface FitSize {
  readonly width: number;
  readonly height: number;
}

export interface FitStep {
  /** The translation fits at the scale measured. */
  readonly fits: boolean;
  /** The scale the overflow suggests trying next, within 0.5–1. */
  readonly next: number;
  /** It does not fit even at the smallest scale: fitting stops there. */
  readonly overflowsAtMinimum: boolean;
}

/**
 * One step of fitting a translation drawn at `current` that needs `needed`
 * room where `available` is given. Wrapping text shrinks in both
 * directions, so a height overflow takes the square root; a line that
 * cannot wrap shrinks with its width.
 */
export function fitStep(current: number, needed: FitSize, available: FitSize): FitStep {
  const start = Number.isFinite(current) && current > 0 ? Math.min(1, current) : 1;
  const height = overflows(needed.height, available.height)
    ? Math.sqrt(available.height / needed.height)
    : 1;
  const width = overflows(needed.width, available.width)
    ? available.width / needed.width
    : 1;
  const ratio = Math.min(height, width);
  const fits = ratio >= 1;
  return {
    fits,
    next: Math.max(MIN_PDF_FIT_SCALE, Math.min(1, start * ratio)),
    overflowsAtMinimum: !fits && start <= MIN_PDF_FIT_SCALE,
  };
}

/** Half a pixel of slack absorbs rounding. */
function overflows(needed: number, available: number): boolean {
  return Number.isFinite(needed) && Number.isFinite(available) &&
    available > 0 && needed > available + 0.5;
}
