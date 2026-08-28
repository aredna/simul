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
  const configuredChunks = splitText(
    source,
    finitePositiveInteger(
      maxInputCharacters,
      DEFAULT_MAX_INPUT_CHARACTERS,
    ),
  );
  const chunks: string[] = [];
  for (const configuredChunk of configuredChunks) {
    chunks.push(
      ...(await splitForSessionQuota(configuredChunk, session, signal)),
    );
  }
  const translated: string[] = [];
  for (const chunk of chunks) {
    signal?.throwIfAborted();
    translated.push(await session.translate(chunk, signal));
  }
  return translated.join(' ').trim();
}

export function splitText(source: string, maxLength: number): string[] {
  const boundedLength = finitePositiveInteger(
    maxLength,
    DEFAULT_MAX_INPUT_CHARACTERS,
  );
  const sourcePoints = [...source];
  if (sourcePoints.length <= boundedLength) return [source];

  const chunks: string[] = [];
  let start = 0;
  while (sourcePoints.length - start > boundedLength) {
    const splitAt = findTextBoundary(sourcePoints, start, boundedLength);
    const chunk = sourcePoints.slice(start, splitAt).join('').trim();
    if (chunk) chunks.push(chunk);
    start = splitAt;
    while (true) {
      const point = sourcePoints[start];
      if (point === undefined || !/\s/u.test(point)) break;
      start += 1;
    }
  }
  const finalChunk = sourcePoints.slice(start).join('').trim();
  if (finalChunk) chunks.push(finalChunk);
  return chunks.filter(Boolean);
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
