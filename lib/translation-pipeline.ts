import type {
  PageSnapshot,
  SnapshotImageItem,
  SnapshotTextItem,
} from './page-snapshot';
import type { TranslationSession } from './translation-provider';

export type TranslationFieldState =
  | 'pending'
  | 'translated'
  | 'failed'
  | 'cancelled';

export interface TranslationValue {
  source: string;
  translated?: string;
  state: TranslationFieldState;
  error?: string;
}

export interface TranslatedTextItem extends SnapshotTextItem {
  translation: TranslationValue;
}

export interface TranslatedImageItem extends SnapshotImageItem {
  altTranslation?: TranslationValue;
  captionTranslation?: TranslationValue;
}

export type TranslatedSnapshotItem =
  | TranslatedTextItem
  | TranslatedImageItem;

export type TranslationRunState =
  | 'ready'
  | 'translating'
  | 'complete'
  | 'partial'
  | 'cancelled';

export interface TranslatedSnapshot {
  snapshot: PageSnapshot;
  items: TranslatedSnapshotItem[];
  state: TranslationRunState;
  completed: number;
  total: number;
  failed: number;
}

export interface TranslationProgress {
  completed: number;
  total: number;
  source: string;
  state: Exclude<TranslationFieldState, 'pending'>;
}

export interface TranslationPipelineOptions {
  signal?: AbortSignal;
  onProgress?: (progress: TranslationProgress) => void;
  maxUniqueTexts?: number;
  maxCharacters?: number;
  maxInputCharacters?: number;
}

const DEFAULT_MAX_UNIQUE_TEXTS = 500;
const DEFAULT_MAX_CHARACTERS = 60_000;
const DEFAULT_MAX_INPUT_CHARACTERS = 3_500;
const LIMIT_ERROR = 'This page exceeds Simul\'s bounded local translation limit.';

export async function translateSnapshot(
  snapshot: PageSnapshot,
  session: TranslationSession,
  options: TranslationPipelineOptions = {},
): Promise<TranslatedSnapshot> {
  return runTranslation(createTranslationResult(snapshot), session, options, [
    'pending',
  ]);
}

export async function retryIncompleteTranslations(
  previous: TranslatedSnapshot,
  session: TranslationSession,
  options: TranslationPipelineOptions = {},
): Promise<TranslatedSnapshot> {
  return runTranslation(cloneResult(previous), session, options, [
    'failed',
    'cancelled',
  ]);
}

export function countIncompleteTranslations(result: TranslatedSnapshot): number {
  return deduplicateFields(collectFields(result)).filter((group) =>
    group.fields.some(
      (field) => field.state === 'failed' || field.state === 'cancelled',
    ),
  ).length;
}

export function displayTranslation(value: TranslationValue): string {
  return value.state === 'translated' && value.translated
    ? value.translated
    : value.source;
}

function createTranslationResult(snapshot: PageSnapshot): TranslatedSnapshot {
  const items = snapshot.items.map<TranslatedSnapshotItem>((item) => {
    if (item.kind === 'text') {
      return {
        ...item,
        translation: pendingValue(item.text),
      };
    }

    return {
      ...item,
      ...(item.altText
        ? { altTranslation: pendingValue(item.altText) }
        : {}),
      ...(item.caption
        ? { captionTranslation: pendingValue(item.caption) }
        : {}),
    };
  });

  return {
    snapshot,
    items,
    state: 'ready',
    completed: 0,
    total: deduplicateFields(collectFieldsFromItems(items)).length,
    failed: 0,
  };
}

async function runTranslation(
  base: TranslatedSnapshot,
  session: TranslationSession,
  options: TranslationPipelineOptions,
  selectedStates: TranslationFieldState[],
): Promise<TranslatedSnapshot> {
  const result = cloneResult(base);
  const selected = collectFields(result).filter((field) =>
    selectedStates.includes(field.state),
  );
  for (const field of selected) {
    field.state = 'pending';
    delete field.translated;
    delete field.error;
  }

  const groups = deduplicateFields(selected);
  result.state = 'translating';
  result.total = groups.length;
  result.completed = 0;
  result.failed = 0;

  if (groups.length === 0) {
    return finishResult(result);
  }

  const maxUniqueTexts = finiteNonNegativeInteger(
    options.maxUniqueTexts,
    DEFAULT_MAX_UNIQUE_TEXTS,
  );
  const maxCharacters = finiteNonNegativeInteger(
    options.maxCharacters,
    DEFAULT_MAX_CHARACTERS,
  );
  const maxInputCharacters = finitePositiveInteger(
    options.maxInputCharacters,
    DEFAULT_MAX_INPUT_CHARACTERS,
  );
  let acceptedCharacters = 0;

  for (const [index, group] of groups.entries()) {
    if (options.signal?.aborted) {
      cancelPending(selected);
      result.state = 'cancelled';
      return summarizeResult(result, index, groups.length);
    }

    if (
      index >= maxUniqueTexts ||
      acceptedCharacters + countCodePoints(group.source) > maxCharacters
    ) {
      updateGroup(group.fields, 'failed', undefined, LIMIT_ERROR);
      reportProgress(result, group.source, 'failed', options);
      continue;
    }
    acceptedCharacters += countCodePoints(group.source);

    try {
      const translated = await translateInChunks(
        group.source,
        session,
        maxInputCharacters,
        options.signal,
      );
      if (!translated.trim()) {
        throw new Error('Chrome returned an empty translation.');
      }
      updateGroup(group.fields, 'translated', translated);
      reportProgress(result, group.source, 'translated', options);
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted) {
        cancelPending(selected);
        result.state = 'cancelled';
        return summarizeResult(result, result.completed, groups.length);
      }
      updateGroup(group.fields, 'failed', undefined, readableError(error));
      reportProgress(result, group.source, 'failed', options);
    }
  }

  return finishResult(result);
}

async function translateInChunks(
  source: string,
  session: TranslationSession,
  maxInputCharacters: number,
  signal?: AbortSignal,
): Promise<string> {
  const configuredChunks = splitText(source, maxInputCharacters);
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
  let remaining = sourcePoints;
  while (remaining.length > boundedLength) {
    const splitAt = findTextBoundary(remaining, boundedLength);
    const chunk = remaining.slice(0, splitAt).join('').trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitAt);
    while (remaining[0] !== undefined && /\s/u.test(remaining[0])) {
      remaining = remaining.slice(1);
    }
  }
  const finalChunk = remaining.join('').trim();
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

function findTextBoundary(points: string[], maxLength: number): number {
  const minimumUsefulBoundary = Math.max(1, Math.ceil(maxLength / 2));
  for (let index = maxLength - 1; index >= minimumUsefulBoundary - 1; index -= 1) {
    const point = points[index];
    if (
      point !== undefined &&
      (/\s/u.test(point) || /[。．.!?！？]/u.test(point))
    ) {
      return index + 1;
    }
  }
  return maxLength;
}

function pendingValue(source: string): TranslationValue {
  return { source, state: 'pending' };
}

function cloneValue(value: TranslationValue): TranslationValue {
  return { ...value };
}

function cloneResult(result: TranslatedSnapshot): TranslatedSnapshot {
  return {
    ...result,
    items: result.items.map((item): TranslatedSnapshotItem => {
      if (item.kind === 'text') {
        return { ...item, translation: cloneValue(item.translation) };
      }
      return {
        ...item,
        ...(item.altTranslation
          ? { altTranslation: cloneValue(item.altTranslation) }
          : {}),
        ...(item.captionTranslation
          ? { captionTranslation: cloneValue(item.captionTranslation) }
          : {}),
      };
    }),
  };
}

function collectFields(result: TranslatedSnapshot): TranslationValue[] {
  return collectFieldsFromItems(result.items);
}

function collectFieldsFromItems(
  items: TranslatedSnapshotItem[],
): TranslationValue[] {
  const fields: TranslationValue[] = [];
  for (const item of items) {
    if (item.kind === 'text') {
      fields.push(item.translation);
    } else {
      if (item.altTranslation) fields.push(item.altTranslation);
      if (item.captionTranslation) fields.push(item.captionTranslation);
    }
  }
  return fields;
}

function deduplicateFields(fields: TranslationValue[]): Array<{
  source: string;
  fields: TranslationValue[];
}> {
  const grouped = new Map<string, TranslationValue[]>();
  for (const field of fields) {
    const existing = grouped.get(field.source);
    if (existing) existing.push(field);
    else grouped.set(field.source, [field]);
  }
  return [...grouped].map(([source, groupFields]) => ({
    source,
    fields: groupFields,
  }));
}

function updateGroup(
  fields: TranslationValue[],
  state: Exclude<TranslationFieldState, 'pending'>,
  translated?: string,
  error?: string,
): void {
  for (const field of fields) {
    field.state = state;
    if (translated) field.translated = translated;
    else delete field.translated;
    if (error) field.error = error;
    else delete field.error;
  }
}

function reportProgress(
  result: TranslatedSnapshot,
  source: string,
  state: 'translated' | 'failed',
  options: TranslationPipelineOptions,
): void {
  result.completed += 1;
  if (state === 'failed') result.failed += 1;
  options.onProgress?.({
    completed: result.completed,
    total: result.total,
    source,
    state,
  });
}

function cancelPending(fields: TranslationValue[]): void {
  for (const field of fields) {
    if (field.state === 'pending') {
      field.state = 'cancelled';
      field.error = 'Translation was cancelled. You can continue from here.';
    }
  }
}

function finishResult(result: TranslatedSnapshot): TranslatedSnapshot {
  const groups = deduplicateFields(collectFields(result));
  result.failed = groups.filter((group) =>
    group.fields.some((field) => field.state === 'failed'),
  ).length;
  result.completed = result.total;
  const incomplete = groups.some((group) =>
    group.fields.some(
      (field) => field.state === 'failed' || field.state === 'cancelled',
    ),
  );
  result.state = incomplete ? 'partial' : 'complete';
  return result;
}

function summarizeResult(
  result: TranslatedSnapshot,
  completed: number,
  total: number,
): TranslatedSnapshot {
  result.completed = Math.min(completed, total);
  result.total = total;
  result.failed = deduplicateFields(collectFields(result)).filter((group) =>
    group.fields.some((field) => field.state === 'failed'),
  ).length;
  return result;
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Chrome could not translate this part of the page.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function countCodePoints(value: string): number {
  return [...value].length;
}

function finiteNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}

function finitePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : fallback;
}
