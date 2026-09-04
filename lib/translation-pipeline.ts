import type { TranslationSession } from './translation-provider';

const DEFAULT_MAX_INPUT_CHARACTERS = 3_500;

/**
 * Translate one logical value without sending a request over the session's
 * advertised input quota. The configured character bound remains a first
 * pass for sessions that do not expose quota measurement.
 */
export async function translateWithSession(
  session: TranslationSession,
  source: string,
  signal?: AbortSignal,
  maxInputCharacters = DEFAULT_MAX_INPUT_CHARACTERS,
): Promise<string> {
  const segments = splitTextSegments(
    source,
    finitePositiveInteger(
      maxInputCharacters,
      DEFAULT_MAX_INPUT_CHARACTERS,
    ),
  );
  const parts: string[] = [];
  for (const segment of segments) {
    const chunks = await splitForSessionQuota(segment.text, session, signal);
    const translated: string[] = [];
    for (const chunk of chunks) {
      signal?.throwIfAborted();
      translated.push(await session.translate(chunk, signal));
    }
    // Reinsert the whitespace that separated the segments in the source so a
    // paragraph break or newline in a long value survives translation.
    parts.push(translated.join(' ').trim(), segment.separator);
  }
  return parts.join('').trim();
}

export interface TextSegment {
  readonly text: string;
  /** The source whitespace that followed this segment ('' after the last). */
  readonly separator: string;
}

export function splitText(source: string, maxLength: number): string[] {
  return splitTextSegments(source, maxLength).map((segment) => segment.text);
}

/**
 * Split on the same boundaries as splitText but keep the whitespace between
 * chunks so callers can rejoin translations without collapsing line breaks.
 * A boundary without whitespace (sentence punctuation) separates with one
 * space, matching the previous join behavior.
 */
export function splitTextSegments(
  source: string,
  maxLength: number,
): TextSegment[] {
  const boundedLength = finitePositiveInteger(
    maxLength,
    DEFAULT_MAX_INPUT_CHARACTERS,
  );
  const sourcePoints = [...source];
  if (sourcePoints.length <= boundedLength) {
    return [{ text: source, separator: '' }];
  }

  const segments: Array<{ text: string; separator: string }> = [];
  let start = 0;
  while (sourcePoints.length - start > boundedLength) {
    const splitAt = findTextBoundary(sourcePoints, start, boundedLength);
    let textEnd = splitAt;
    while (textEnd > start && isWhitespace(sourcePoints[textEnd - 1])) {
      textEnd -= 1;
    }
    let separatorEnd = splitAt;
    while (isWhitespace(sourcePoints[separatorEnd])) separatorEnd += 1;
    appendTextSegment(
      segments,
      sourcePoints.slice(start, textEnd).join('').trim(),
      sourcePoints.slice(textEnd, separatorEnd).join('') || ' ',
    );
    start = separatorEnd;
  }
  appendTextSegment(segments, sourcePoints.slice(start).join('').trim(), '');
  const last = segments[segments.length - 1];
  if (last) last.separator = '';
  return segments;
}

function appendTextSegment(
  segments: Array<{ text: string; separator: string }>,
  text: string,
  separator: string,
): void {
  if (text) {
    segments.push({ text, separator });
    return;
  }
  // A whitespace-only chunk only extends the gap after the previous segment.
  const previous = segments[segments.length - 1];
  if (previous) previous.separator += separator;
}

async function splitForSessionQuota(
  source: string,
  session: TranslationSession,
  signal?: AbortSignal,
): Promise<string[]> {
  const quota = session.inputQuota;
  if (
    typeof quota !== 'number' ||
    !Number.isFinite(quota) ||
    quota <= 0
  ) {
    return [source];
  }

  if (typeof session.measureInputUsage !== 'function') {
    const conservativeCharacterQuota = Math.trunc(quota);
    if (conservativeCharacterQuota < 1) {
      throw new Error('Chrome reported an unusable local input quota.');
    }
    return splitText(source, conservativeCharacterQuota);
  }

  signal?.throwIfAborted();
  const usage = await session.measureInputUsage(source, signal);
  if (!Number.isFinite(usage) || usage < 0) {
    throw new Error('Chrome returned an invalid translation input measurement.');
  }
  if (usage <= quota) return [source];

  const pointCount = countCodePoints(source);
  if (pointCount <= 1) {
    throw new Error('A translation segment exceeds Chrome\'s local input quota.');
  }

  const halves = splitText(source, Math.max(1, Math.floor(pointCount / 2)));
  if (halves.length < 2) {
    throw new Error('A translation segment could not be split for Chrome\'s input quota.');
  }

  const quotaSafe: string[] = [];
  for (const half of halves) {
    quotaSafe.push(...(await splitForSessionQuota(half, session, signal)));
  }
  return quotaSafe;
}

function findTextBoundary(
  points: string[],
  start: number,
  maxLength: number,
): number {
  const minimumUsefulBoundary = Math.max(1, Math.ceil(maxLength / 2));
  const end = Math.min(points.length, start + maxLength);
  for (
    let index = end - 1;
    index >= start + minimumUsefulBoundary - 1;
    index -= 1
  ) {
    const point = points[index];
    if (
      point !== undefined &&
      (/\s/u.test(point) || /[。．.!?！？]/u.test(point))
    ) {
      return index + 1;
    }
  }
  return end;
}

function isWhitespace(point: string | undefined): boolean {
  return point !== undefined && /\s/u.test(point);
}

function countCodePoints(value: string): number {
  return [...value].length;
}

function finitePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : fallback;
}
