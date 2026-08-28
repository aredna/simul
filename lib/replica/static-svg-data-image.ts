const MAX_STATIC_SVG_DATA_IMAGE_LENGTH = 512 * 1024;
const MAX_STATIC_SVG_DEPTH = 64;
const LOCAL_SVG_FRAGMENT_PATTERN = /^#[A-Za-z0-9_.:-]{1,256}$/u;

const STATIC_SVG_ELEMENTS = new Set([
  'circle',
  'clippath',
  'defs',
  'ellipse',
  'feblend',
  'fecolormatrix',
  'fecomposite',
  'fedropshadow',
  'feflood',
  'fegaussianblur',
  'femerge',
  'femergenode',
  'femorphology',
  'feoffset',
  'fetile',
  'feturbulence',
  'filter',
  'g',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'radialgradient',
  'rect',
  'stop',
  'svg',
  'symbol',
  'use',
]);

const STATIC_SVG_ATTRIBUTES = new Set([
  'aria-hidden',
  'basefrequency',
  'class',
  'clip-path',
  'clip-rule',
  'clippathunits',
  'color-interpolation-filters',
  'cx',
  'cy',
  'd',
  'dx',
  'dy',
  'edgemode',
  'fill',
  'fill-opacity',
  'fill-rule',
  'focusable',
  'filter',
  'filterunits',
  'flood-color',
  'flood-opacity',
  'fx',
  'fy',
  'gradienttransform',
  'gradientunits',
  'height',
  'href',
  'id',
  'in',
  'in2',
  'k1',
  'k2',
  'k3',
  'k4',
  'linecap',
  'linejoin',
  'marker-end',
  'marker-mid',
  'marker-start',
  'markerheight',
  'markerunits',
  'markerwidth',
  'mask',
  'maskcontentunits',
  'maskunits',
  'mode',
  'numoctaves',
  'offset',
  'opacity',
  'operator',
  'orient',
  'patterncontentunits',
  'patterntransform',
  'patternunits',
  'points',
  'preserveaspectratio',
  'primitiveunits',
  'r',
  'radius',
  'refx',
  'refy',
  'result',
  'role',
  'rx',
  'ry',
  'scale',
  'seed',
  'stddeviation',
  'stitchtiles',
  'stop-color',
  'stop-opacity',
  'stroke',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-opacity',
  'stroke-width',
  'transform',
  'type',
  'values',
  'vector-effect',
  'viewbox',
  'width',
  'x',
  'x1',
  'x2',
  'xmlns',
  'y',
  'y1',
  'y2',
  'xchannelselector',
  'ychannelselector',
]);

const STATIC_SVG_DIMENSION_ATTRIBUTES = new Set([
  'height', 'markerheight', 'markerwidth', 'width',
]);

/**
 * Admits only a small, URL-encoded, shape-only SVG profile. It deliberately
 * excludes CSS, links, references, animation, text, entities, and every
 * resource-bearing element so an image cannot become a second active graph.
 */
export function isSafeStaticSvgDataImage(value: string): boolean {
  if (value.length > MAX_STATIC_SVG_DATA_IMAGE_LENGTH) return false;
  const match = /^data:image\/svg\+xml(?:;charset=(?:utf-8|us-ascii))?,([\s\S]*)$/iu.exec(
    value,
  );
  if (!match) return false;
  let xml: string;
  try {
    xml = decodeURIComponent(match[1]!);
  } catch {
    return false;
  }
  if (
    xml.length === 0 ||
    xml.length > MAX_STATIC_SVG_DATA_IMAGE_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(xml) ||
    /(?:<!|<\?|&|javascript\s*:|data\s*:)/iu.test(xml)
  ) return false;

  const stack: string[] = [];
  let rootSeen = false;
  let elementCount = 0;
  let filterPrimitiveCount = 0;
  let offset = 0;
  const tokens = xml.matchAll(/<[^<>]*>/gu);
  for (const token of tokens) {
    const index = token.index;
    if (index === undefined || xml.slice(offset, index).trim() !== '') return false;
    const rawToken = token[0];
    offset = index + rawToken.length;
    const parsed = /^<\s*(\/?)\s*([a-z][a-z0-9-]*)\s*([\s\S]*?)\s*(\/?)>$/iu.exec(
      rawToken,
    );
    if (!parsed) return false;
    const closing = parsed[1] === '/';
    const tagName = parsed[2]!.toLowerCase();
    const attributeText = parsed[3] ?? '';
    const selfClosing = parsed[4] === '/';
    if (!STATIC_SVG_ELEMENTS.has(tagName)) return false;
    if (closing) {
      if (selfClosing || attributeText.trim() !== '' || stack.pop() !== tagName) {
        return false;
      }
      continue;
    }
    if (!rootSeen) {
      if (tagName !== 'svg' || stack.length !== 0) return false;
      rootSeen = true;
    } else if (stack.length === 0) {
      return false;
    }
    elementCount += 1;
    if (elementCount > 512) return false;
    if (tagName.startsWith('fe')) {
      filterPrimitiveCount += 1;
      if (filterPrimitiveCount > 64) return false;
    }
    if (!readSafeStaticSvgAttributes(attributeText, tagName)) return false;
    if (!selfClosing) {
      if (stack.length >= MAX_STATIC_SVG_DEPTH) return false;
      stack.push(tagName);
    }
  }
  return rootSeen && stack.length === 0 && xml.slice(offset).trim() === '';
}

function readSafeStaticSvgAttributes(
  source: string,
  tagName: string,
): boolean {
  const root = tagName === 'svg';
  const seen = new Set<string>();
  let offset = 0;
  while (offset < source.length) {
    while (offset < source.length && /\s/u.test(source[offset]!)) offset += 1;
    if (offset >= source.length) break;
    const attribute = /^([a-z][a-z0-9-]*)\s*=\s*(["'])([\s\S]*?)\2/iu.exec(
      source.slice(offset),
    );
    if (!attribute) return false;
    const name = attribute[1]!.toLowerCase();
    const value = attribute[3] ?? '';
    const decodedValue = decodeCssEscapes(value);
    if (
      seen.has(name) ||
      !STATIC_SVG_ATTRIBUTES.has(name) ||
      value.length > 16_384 ||
      /[<>\u0000-\u001f\u007f]/u.test(value) ||
      /[<>\u0000-\u001f\u007f]/u.test(decodedValue) ||
      !isBoundedStaticSvgAttribute(name, decodedValue) ||
      (name === 'xmlns'
        ? !root || value !== 'http://www.w3.org/2000/svg'
        : name === 'href'
          ? !LOCAL_SVG_FRAGMENT_PATTERN.test(decodedValue)
          : /\burl\s*\(/iu.test(decodedValue)
            ? !/^url\(\s*["']?#[A-Za-z0-9_.:-]{1,256}["']?\s*\)$/u.test(
                decodedValue,
              )
            : /(?:javascript\s*:|https?\s*:|data\s*:)/iu.test(decodedValue))
    ) return false;
    seen.add(name);
    offset += attribute[0].length;
  }
  return true;
}

function isBoundedStaticSvgAttribute(name: string, value: string): boolean {
  const normalized = value.trim();
  if (name === 'viewbox') {
    const values = readStaticSvgNumbers(normalized, 4);
    return Boolean(
      values && values.length === 4 &&
      Math.abs(values[0]!) <= 1_000_000 &&
      Math.abs(values[1]!) <= 1_000_000 &&
      values[2]! >= 0 && values[2]! <= 1_000_000 &&
      values[3]! >= 0 && values[3]! <= 1_000_000,
    );
  }
  if (STATIC_SVG_DIMENSION_ATTRIBUTES.has(name)) {
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(%|px|pt|pc|cm|mm|in|em|ex|rem|ch|vw|vh|vmin|vmax)?$/iu.exec(
      normalized,
    );
    if (!match) return false;
    const numeric = Number(match[1]);
    const maximum = match[2] === '%' ? 10_000 : 32_768;
    return Number.isFinite(numeric) && numeric >= 0 && numeric <= maximum;
  }
  if (name === 'numoctaves') {
    const numeric = Number(normalized);
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 8;
  }
  if (name === 'basefrequency') {
    const values = readStaticSvgNumbers(normalized, 2);
    return Boolean(values && values.length >= 1 && values.every(
      (numeric) => numeric >= 0 && numeric <= 16,
    ));
  }
  if (name === 'stddeviation' || name === 'radius') {
    const values = readStaticSvgNumbers(normalized, 2);
    return Boolean(values && values.length >= 1 && values.every(
      (numeric) => numeric >= 0 && numeric <= 1_024,
    ));
  }
  if (name === 'scale' || name === 'surfacescale') {
    const numeric = Number(normalized);
    return Number.isFinite(numeric) && Math.abs(numeric) <= 1_024;
  }
  if (name === 'seed') {
    const numeric = Number(normalized);
    return Number.isSafeInteger(numeric) && Math.abs(numeric) <= 1_000_000;
  }
  return true;
}

function readStaticSvgNumbers(
  value: string,
  maximumCount: number,
): readonly number[] | undefined {
  const parts = value.split(/[\s,]+/u).filter(Boolean);
  if (parts.length < 1 || parts.length > maximumCount) return undefined;
  const numbers = parts.map(Number);
  return numbers.every(Number.isFinite) ? numbers : undefined;
}

function decodeCssEscapes(value: string): string {
  return value.replace(/\\(?:\r\n|[\n\r\f])/gu, '').replace(
    /\\(?:([0-9a-fA-F]{1,6})[\t\n\f\r ]?|([^\n\r\f0-9a-fA-F]))/gu,
    (_match, hex: string | undefined, escaped: string | undefined) => {
      if (hex) {
        const codePoint = Number.parseInt(hex, 16);
        return codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '\uFFFD';
      }
      return escaped ?? '';
    },
  );
}
