import {
  readImageTextRegionHints,
  readImageTextResult,
  type ImageTextRegion,
  type ImageTextResult,
} from './contracts';
import {
  readSourceDocumentIdentity,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';

export const OCR_OFFSCREEN_PROTOCOL_VERSION = 1;

export const OCR_HOST_ERROR_CODES = Object.freeze([
  'host-unavailable',
  'host-overflow',
  'input-missing',
  'provider-unavailable',
  'unsupported-language',
  'recognition-failed',
  'worker-lost',
  'cancelled',
  'invalid-result',
] as const);
export type OcrHostErrorCode = (typeof OCR_HOST_ERROR_CODES)[number];

export interface EnsureOcrHostCommand {
  readonly kind: 'simul:ocr-v1:ensure-host';
  readonly version: 1;
}

export interface EnsureOcrHostResponse {
  readonly kind: 'simul:ocr-v1:host-ready';
  readonly version: 1;
  readonly ready: boolean;
}

interface BaseOffscreenOcrJob {
  readonly jobId: string;
  readonly clientId: string;
  readonly attempt: 0 | 1;
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly contentRevision: number;
  readonly observationRevision: number;
  readonly inputKey: string;
  readonly pixelHash: string;
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly hints?: readonly ImageTextRegion[];
  readonly preprocessingVersion: 'visible-crop-v1';
  readonly schemaVersion: 1;
}

export interface TesseractOffscreenOcrJob extends BaseOffscreenOcrJob {
  readonly providerId: 'tesseract';
  readonly languageGroup: string;
  readonly providerVersion: 'tesseract.js-7.0.0';
  readonly modelVersion: string;
}

export interface ChromeTextDetectorOffscreenOcrJob extends BaseOffscreenOcrJob {
  readonly providerId: 'chrome-text-detector';
  readonly languageGroup: string;
  readonly providerVersion: 'chrome-text-detector-v1';
  readonly modelVersion: 'platform';
}

export type OffscreenOcrJob =
  | TesseractOffscreenOcrJob
  | ChromeTextDetectorOffscreenOcrJob;

export interface RunOffscreenOcrCommand {
  readonly kind: 'simul:ocr-v1:run';
  readonly version: 1;
  readonly job: OffscreenOcrJob;
}

export interface CancelOffscreenOcrCommand {
  readonly kind: 'simul:ocr-v1:cancel';
  readonly version: 1;
  readonly clientId: string;
  readonly jobId: string;
}

export type OffscreenOcrCommand =
  | RunOffscreenOcrCommand
  | CancelOffscreenOcrCommand;

export type OffscreenOcrResponse =
  | {
      readonly kind: 'simul:ocr-v1:result';
      readonly version: 1;
      readonly jobId: string;
      readonly clientId: string;
      readonly attempt: 0 | 1;
      readonly document: ReplicaSourceDocumentIdentity;
      readonly nodeId: number;
      readonly contentRevision: number;
      readonly observationRevision: number;
      readonly pixelHash: string;
      readonly result: ImageTextResult;
    }
  | {
      readonly kind: 'simul:ocr-v1:error';
      readonly version: 1;
      readonly jobId: string;
      readonly clientId: string;
      readonly attempt: 0 | 1;
      readonly code: OcrHostErrorCode;
    };

export function readEnsureOcrHostCommand(input: unknown): EnsureOcrHostCommand | undefined {
  return isExactRecord(input, ['kind', 'version']) &&
    input.kind === 'simul:ocr-v1:ensure-host' && input.version === 1
    ? Object.freeze({ kind: input.kind, version: 1 })
    : undefined;
}

export function readEnsureOcrHostResponse(input: unknown): EnsureOcrHostResponse | undefined {
  return isExactRecord(input, ['kind', 'version', 'ready']) &&
    input.kind === 'simul:ocr-v1:host-ready' &&
    input.version === 1 &&
    typeof input.ready === 'boolean'
    ? Object.freeze({ kind: input.kind, version: 1, ready: input.ready })
    : undefined;
}

export function readOffscreenOcrCommand(input: unknown): OffscreenOcrCommand | undefined {
  if (!isRecord(input) || input.version !== 1 || typeof input.kind !== 'string') {
    return undefined;
  }
  if (input.kind === 'simul:ocr-v1:cancel') {
    if (!isExactRecord(input, ['kind', 'version', 'clientId', 'jobId']) ||
      !isSafeToken(input.clientId) || !isSafeToken(input.jobId)) return undefined;
    return Object.freeze({
      kind: input.kind,
      version: 1,
      clientId: input.clientId,
      jobId: input.jobId,
    });
  }
  if (input.kind !== 'simul:ocr-v1:run' ||
    !isExactRecord(input, ['kind', 'version', 'job'])) return undefined;
  const job = readOffscreenOcrJob(input.job);
  return job ? Object.freeze({ kind: input.kind, version: 1, job }) : undefined;
}

export function readOffscreenOcrJob(input: unknown): OffscreenOcrJob | undefined {
  if (!isExactRecordWithOptionalKeys(input, [
    'jobId',
    'clientId',
    'attempt',
    'document',
    'nodeId',
    'contentRevision',
    'observationRevision',
    'inputKey',
    'pixelHash',
    'bitmapWidth',
    'bitmapHeight',
    'providerId',
    'languageGroup',
    'providerVersion',
    'modelVersion',
    'preprocessingVersion',
    'schemaVersion',
  ], ['hints'])) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  if (
    !document ||
    !isSafeToken(input.jobId) ||
    !isSafeToken(input.clientId) ||
    (input.attempt !== 0 && input.attempt !== 1) ||
    !isPositiveSafeInteger(input.nodeId) ||
    !isPositiveSafeInteger(input.contentRevision) ||
    !isPositiveSafeInteger(input.observationRevision) ||
    !isSafeToken(input.inputKey) ||
    typeof input.pixelHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(input.pixelHash) ||
    !isBitmapDimension(input.bitmapWidth) ||
    !isBitmapDimension(input.bitmapHeight) ||
    input.bitmapWidth * input.bitmapHeight > 4_000_000 ||
    input.preprocessingVersion !== 'visible-crop-v1' ||
    input.schemaVersion !== 1
  ) return undefined;
  const hints = input.hints === undefined
    ? undefined
    : readImageTextRegionHints(
        input.hints,
        input.bitmapWidth,
        input.bitmapHeight,
      );
  if (input.hints !== undefined && !hints) return undefined;
  const base = {
    jobId: input.jobId,
    clientId: input.clientId,
    attempt: input.attempt,
    document,
    nodeId: input.nodeId,
    contentRevision: input.contentRevision,
    observationRevision: input.observationRevision,
    inputKey: input.inputKey,
    pixelHash: input.pixelHash,
    bitmapWidth: input.bitmapWidth,
    bitmapHeight: input.bitmapHeight,
    ...(hints ? { hints } : {}),
    preprocessingVersion: 'visible-crop-v1',
    schemaVersion: 1,
  } as const;
  if (
    input.providerId === 'tesseract' &&
    isLanguageGroup(input.languageGroup) &&
    input.providerVersion === 'tesseract.js-7.0.0' &&
    typeof input.modelVersion === 'string' &&
    /^[A-Za-z0-9._:+/-]{1,128}$/u.test(input.modelVersion)
  ) {
    return Object.freeze({
      ...base,
      providerId: 'tesseract',
      languageGroup: input.languageGroup,
      providerVersion: 'tesseract.js-7.0.0',
      modelVersion: input.modelVersion,
    });
  }
  if (
    input.providerId === 'chrome-text-detector' &&
    isLanguageTag(input.languageGroup) &&
    input.providerVersion === 'chrome-text-detector-v1' &&
    input.modelVersion === 'platform'
  ) {
    return Object.freeze({
      ...base,
      providerId: 'chrome-text-detector',
      languageGroup: input.languageGroup,
      providerVersion: 'chrome-text-detector-v1',
      modelVersion: 'platform',
    });
  }
  return undefined;
}

export function readOffscreenOcrResponse(
  input: unknown,
  expected: OffscreenOcrJob,
): OffscreenOcrResponse | undefined {
  if (!isRecord(input) || input.version !== 1 || typeof input.kind !== 'string') {
    return undefined;
  }
  if (input.kind === 'simul:ocr-v1:error') {
    if (!isExactRecord(input, [
      'kind', 'version', 'jobId', 'clientId', 'attempt', 'code',
    ]) || !sameResponseIdentity(input, expected) || !isOcrHostErrorCode(input.code)) {
      return undefined;
    }
    return Object.freeze({
      kind: input.kind,
      version: 1,
      jobId: expected.jobId,
      clientId: expected.clientId,
      attempt: expected.attempt,
      code: input.code,
    });
  }
  if (input.kind !== 'simul:ocr-v1:result' || !isExactRecord(input, [
    'kind',
    'version',
    'jobId',
    'clientId',
    'attempt',
    'document',
    'nodeId',
    'contentRevision',
    'observationRevision',
    'pixelHash',
    'result',
  ]) || !sameResponseIdentity(input, expected)) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  const result = readImageTextResult(input.result);
  if (
    !document || !sameSourceDocument(document, expected.document) ||
    input.nodeId !== expected.nodeId ||
    input.contentRevision !== expected.contentRevision ||
    input.observationRevision !== expected.observationRevision ||
    input.pixelHash !== expected.pixelHash ||
    !result || result.providerId !== expected.providerId ||
    result.bitmapWidth !== expected.bitmapWidth ||
    result.bitmapHeight !== expected.bitmapHeight
  ) return undefined;
  return Object.freeze({
    kind: input.kind,
    version: 1,
    jobId: expected.jobId,
    clientId: expected.clientId,
    attempt: expected.attempt,
    document,
    nodeId: expected.nodeId,
    contentRevision: expected.contentRevision,
    observationRevision: expected.observationRevision,
    pixelHash: expected.pixelHash,
    result,
  });
}

export function createOffscreenOcrError(
  job: OffscreenOcrJob,
  code: OcrHostErrorCode,
): OffscreenOcrResponse {
  return Object.freeze({
    kind: 'simul:ocr-v1:error',
    version: 1,
    jobId: job.jobId,
    clientId: job.clientId,
    attempt: job.attempt,
    code,
  });
}

function sameResponseIdentity(
  input: Record<string, unknown>,
  expected: OffscreenOcrJob,
): boolean {
  return input.jobId === expected.jobId &&
    input.clientId === expected.clientId &&
    input.attempt === expected.attempt;
}

function isOcrHostErrorCode(value: unknown): value is OcrHostErrorCode {
  return OCR_HOST_ERROR_CODES.includes(value as OcrHostErrorCode);
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isLanguageGroup(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 3 && value.length <= 64 &&
    /^[a-z]{3}(?:_(?:sim|tra|vert))?(?:\+[a-z]{3}(?:_(?:sim|tra|vert))?)*$/u
      .test(value);
}

function isLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 &&
    /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isBitmapDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 32_768;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isExactRecordWithOptionalKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key));
}
