import {
  readSourceImageChange,
  readSourceImageDescriptor,
  type SourceImageChange,
  type SourceImageDescriptor,
} from './contracts';
import {
  readSourceDocumentIdentity,
  sameSourceDocument,
  type ReplicaSourceDocumentIdentity,
} from '../replica/source-identity';
import {
  isSupportedLanguage,
  type SupportedLanguage,
} from '../translation-provider';

export const IMAGE_SOURCE_PROTOCOL_VERSION = 1;
export const IMAGE_SOURCE_PORT_PREFIX = 'simul:image-source-v1:';
export const MAX_IMAGE_SOURCE_REQUEST_ID_LENGTH = 96;
export type ImageSourceBridgeId = 'rrweb' | 'isolated-html';

export interface ImageSourcePortIdentity {
  readonly bridge: ImageSourceBridgeId;
  readonly sessionId: string;
}

export interface ImageSourceStartMessage {
  readonly kind: 'simul:image-source-v1:start';
  readonly document: ReplicaSourceDocumentIdentity;
}

export interface ImageSourceMetricsRequest {
  readonly kind: 'simul:image-source-v1:measure';
  readonly requestId: string;
  readonly descriptor: SourceImageDescriptor;
}

export type ImageSourceControllerMessage =
  | ImageSourceStartMessage
  | ImageSourceMetricsRequest;

export interface SourceImageCaptureMetrics {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly contentRevision: number;
  readonly observationRevision: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly devicePixelRatio: number;
  readonly nearestElementLanguage?: SupportedLanguage;
}

/** Content-free inventory reported after the initial synchronous DOM scan. */
export interface ImageSourceReadySummary {
  readonly candidateImages: number;
  readonly observedImages: number;
}

export type ImageSourceRecorderMessage =
  | {
      readonly kind: 'simul:image-source-v1:ready';
      readonly document: ReplicaSourceDocumentIdentity;
      readonly summary: ImageSourceReadySummary;
    }
  | {
      readonly kind: 'simul:image-source-v1:change';
      readonly change: SourceImageChange;
    }
  | {
      readonly kind: 'simul:image-source-v1:metrics';
      readonly requestId: string;
      readonly status: 'ready';
      readonly metrics: SourceImageCaptureMetrics;
    }
  | {
      readonly kind: 'simul:image-source-v1:metrics';
      readonly requestId: string;
      readonly status: 'stale' | 'hidden';
    };

export function createImageSourcePortName(
  sessionId: string,
  bridge: ImageSourceBridgeId = 'rrweb',
): string {
  if (!isSafeToken(sessionId)) throw new Error('Invalid image source session.');
  return `${IMAGE_SOURCE_PORT_PREFIX}${bridge}:${sessionId}`;
}

export function readImageSourcePortIdentity(
  name: unknown,
  expectedBridge?: ImageSourceBridgeId,
): ImageSourcePortIdentity | undefined {
  if (typeof name !== 'string' || !name.startsWith(IMAGE_SOURCE_PORT_PREFIX)) {
    return undefined;
  }
  const suffix = name.slice(IMAGE_SOURCE_PORT_PREFIX.length);
  const separator = suffix.indexOf(':');
  if (separator < 1) return undefined;
  const bridge = suffix.slice(0, separator);
  const sessionId = suffix.slice(separator + 1);
  if (
    (bridge !== 'rrweb' && bridge !== 'isolated-html') ||
    expectedBridge && bridge !== expectedBridge ||
    !isSafeToken(sessionId)
  ) return undefined;
  return Object.freeze({ bridge, sessionId });
}

export function readImageSourcePortSessionId(
  name: unknown,
  expectedBridge?: ImageSourceBridgeId,
): string | undefined {
  return readImageSourcePortIdentity(name, expectedBridge)?.sessionId;
}

export function readImageSourceControllerMessage(
  input: unknown,
  expectedSessionId: string,
  expectedDocument?: ReplicaSourceDocumentIdentity,
): ImageSourceControllerMessage | undefined {
  if (!isRecord(input) || typeof input.kind !== 'string') return undefined;
  if (input.kind === 'simul:image-source-v1:start') {
    if (!hasExactKeys(input, ['kind', 'document'])) return undefined;
    const document = readSourceDocumentIdentity(input.document);
    if (!document || document.sessionId !== expectedSessionId) return undefined;
    return Object.freeze({ kind: input.kind, document });
  }
  if (
    input.kind !== 'simul:image-source-v1:measure' ||
    !hasExactKeys(input, ['kind', 'requestId', 'descriptor']) ||
    !isRequestId(input.requestId)
  ) return undefined;
  const descriptor = readSourceImageDescriptor(input.descriptor);
  if (
    !descriptor ||
    descriptor.document.sessionId !== expectedSessionId ||
    (expectedDocument &&
      !sameSourceDocument(descriptor.document, expectedDocument))
  ) return undefined;
  return Object.freeze({
    kind: input.kind,
    requestId: input.requestId,
    descriptor,
  });
}

export function readImageSourceRecorderMessage(
  input: unknown,
  expectedDocument: ReplicaSourceDocumentIdentity,
): ImageSourceRecorderMessage | undefined {
  if (!isRecord(input) || typeof input.kind !== 'string') return undefined;
  if (input.kind === 'simul:image-source-v1:ready') {
    if (!hasExactKeys(input, ['kind', 'document', 'summary'])) return undefined;
    const document = readSourceDocumentIdentity(input.document);
    const summary = readImageSourceReadySummary(input.summary);
    return document &&
      sameSourceDocument(document, expectedDocument) &&
      summary
      ? Object.freeze({ kind: input.kind, document, summary })
      : undefined;
  }
  if (input.kind === 'simul:image-source-v1:change') {
    if (!hasExactKeys(input, ['kind', 'change'])) return undefined;
    const change = readSourceImageChange(input.change);
    const document = change?.kind === 'upsert'
      ? change.descriptor.document
      : change?.document;
    if (!change || !document || !sameSourceDocument(document, expectedDocument)) {
      return undefined;
    }
    return Object.freeze({ kind: input.kind, change });
  }
  if (
    input.kind !== 'simul:image-source-v1:metrics' ||
    !isRequestId(input.requestId) ||
    typeof input.status !== 'string'
  ) return undefined;
  if (input.status === 'stale' || input.status === 'hidden') {
    if (!hasExactKeys(input, ['kind', 'requestId', 'status'])) return undefined;
    return Object.freeze({
      kind: input.kind,
      requestId: input.requestId,
      status: input.status,
    });
  }
  if (
    input.status !== 'ready' ||
    !hasExactKeys(input, ['kind', 'requestId', 'status', 'metrics'])
  ) return undefined;
  const metrics = readSourceImageCaptureMetrics(input.metrics);
  if (!metrics || !sameSourceDocument(metrics.document, expectedDocument)) {
    return undefined;
  }
  return Object.freeze({
    kind: input.kind,
    requestId: input.requestId,
    status: 'ready',
    metrics,
  });
}

export function readImageSourceReadySummary(
  input: unknown,
): ImageSourceReadySummary | undefined {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, ['candidateImages', 'observedImages']) ||
    !isBoundedNonNegativeSafeInteger(input.candidateImages, 10_000) ||
    !isBoundedNonNegativeSafeInteger(input.observedImages, 10_000) ||
    input.observedImages > input.candidateImages
  ) return undefined;
  return Object.freeze({
    candidateImages: input.candidateImages,
    observedImages: input.observedImages,
  });
}

export function readSourceImageCaptureMetrics(
  input: unknown,
): SourceImageCaptureMetrics | undefined {
  if (!isRecord(input) || !hasExactKeysWithOptional(input, [
    'document',
    'nodeId',
    'contentRevision',
    'observationRevision',
    'left',
    'top',
    'width',
    'height',
    'viewportWidth',
    'viewportHeight',
    'scrollX',
    'scrollY',
    'devicePixelRatio',
  ], ['nearestElementLanguage'])) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  if (
    !document ||
    !isPositiveSafeInteger(input.nodeId) ||
    !isPositiveSafeInteger(input.contentRevision) ||
    !isPositiveSafeInteger(input.observationRevision) ||
    !isFiniteBounded(input.left, -1_000_000, 1_000_000) ||
    !isFiniteBounded(input.top, -1_000_000, 1_000_000) ||
    !isFiniteBounded(input.width, 0.01, 1_000_000) ||
    !isFiniteBounded(input.height, 0.01, 1_000_000) ||
    !isFiniteBounded(input.viewportWidth, 1, 1_000_000) ||
    !isFiniteBounded(input.viewportHeight, 1, 1_000_000) ||
    !isFiniteBounded(input.scrollX, 0, 1_000_000) ||
    !isFiniteBounded(input.scrollY, 0, 1_000_000) ||
    !isFiniteBounded(input.devicePixelRatio, 0.1, 16) ||
    (input.nearestElementLanguage !== undefined &&
      !isSupportedLanguage(input.nearestElementLanguage))
  ) return undefined;
  return Object.freeze({
    document,
    nodeId: input.nodeId,
    contentRevision: input.contentRevision,
    observationRevision: input.observationRevision,
    left: input.left,
    top: input.top,
    width: input.width,
    height: input.height,
    viewportWidth: input.viewportWidth,
    viewportHeight: input.viewportHeight,
    scrollX: input.scrollX,
    scrollY: input.scrollY,
    devicePixelRatio: input.devicePixelRatio,
    ...(isSupportedLanguage(input.nearestElementLanguage)
      ? { nearestElementLanguage: input.nearestElementLanguage }
      : {}),
  });
}

export function sameImageCaptureMetrics(
  left: SourceImageCaptureMetrics,
  right: SourceImageCaptureMetrics,
): boolean {
  return (
    sameSourceDocument(left.document, right.document) &&
    left.nodeId === right.nodeId &&
    left.contentRevision === right.contentRevision &&
    left.observationRevision === right.observationRevision &&
    left.left === right.left &&
    left.top === right.top &&
    left.width === right.width &&
    left.height === right.height &&
    left.viewportWidth === right.viewportWidth &&
    left.viewportHeight === right.viewportHeight &&
    left.scrollX === right.scrollX &&
    left.scrollY === right.scrollY &&
    left.devicePixelRatio === right.devicePixelRatio
    && left.nearestElementLanguage === right.nearestElementLanguage
  );
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= MAX_IMAGE_SOURCE_REQUEST_ID_LENGTH &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isBoundedNonNegativeSafeInteger(
  value: unknown,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= maximum;
}

function isFiniteBounded(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasExactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    actual.every((key) => allowed.has(key));
}
