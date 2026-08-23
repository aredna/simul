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
import { normalizeAccessibilityImageText } from './accessibility-image-text';
import { hasExactKeysWithOptional } from '../exact-record';

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
  readonly policyFingerprint?: string;
  readonly controlImages?: boolean;
  readonly accessibilityTextEnabled?: boolean;
}

export interface ImageSourceMetricsRequest {
  readonly kind: 'simul:image-source-v1:measure';
  readonly requestId: string;
  readonly descriptor: SourceImageDescriptor;
}

export interface ImageSourceAccessibilityTextRequest {
  readonly kind: 'simul:image-source-v1:accessibility-text';
  readonly requestId: string;
  readonly descriptor: SourceImageDescriptor;
  readonly policyFingerprint: string;
  readonly controlImages: boolean;
}

export type ImageSourceControllerMessage =
  | ImageSourceStartMessage
  | ImageSourceMetricsRequest
  | ImageSourceAccessibilityTextRequest;

export interface SourceImageAccessibilityTextEvidence {
  readonly document: ReplicaSourceDocumentIdentity;
  readonly nodeId: number;
  readonly contentRevision: number;
  readonly observationRevision: number;
  readonly text: string;
  readonly source: 'aria-label' | 'alt';
  readonly nearestElementLanguage?: SupportedLanguage;
}

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
    }
  | {
      readonly kind: 'simul:image-source-v1:accessibility-text';
      readonly requestId: string;
      readonly descriptor: SourceImageDescriptor;
      readonly status: 'ready';
      readonly evidence: SourceImageAccessibilityTextEvidence;
    }
  | {
      readonly kind: 'simul:image-source-v1:accessibility-text';
      readonly requestId: string;
      readonly descriptor: SourceImageDescriptor;
      readonly status: 'none' | 'blocked' | 'stale';
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
    if (!(
      hasExactKeys(input, ['kind', 'document']) ||
      (
        hasExactKeys(input, [
          'kind', 'document', 'policyFingerprint', 'controlImages',
          'accessibilityTextEnabled',
        ]) &&
        isPolicyFingerprint(input.policyFingerprint) &&
        typeof input.controlImages === 'boolean' &&
        typeof input.accessibilityTextEnabled === 'boolean' &&
        policyFingerprintControlImages(input.policyFingerprint) ===
          input.controlImages
      )
    )) return undefined;
    const document = readSourceDocumentIdentity(input.document);
    if (!document || document.sessionId !== expectedSessionId) return undefined;
    return Object.freeze({
      kind: input.kind,
      document,
      ...(typeof input.policyFingerprint === 'string'
        ? {
            policyFingerprint: input.policyFingerprint,
            controlImages: input.controlImages === true,
            accessibilityTextEnabled: input.accessibilityTextEnabled === true,
          }
        : {}),
    });
  }
  if (input.kind === 'simul:image-source-v1:accessibility-text') {
    if (!hasExactKeys(input, [
      'kind', 'requestId', 'descriptor', 'policyFingerprint', 'controlImages',
    ]) ||
      !isRequestId(input.requestId) ||
      typeof input.controlImages !== 'boolean' ||
      !isPolicyFingerprint(input.policyFingerprint) ||
      policyFingerprintControlImages(input.policyFingerprint) !==
        input.controlImages
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
      policyFingerprint: input.policyFingerprint,
      controlImages: input.controlImages,
    });
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
  if (input.kind === 'simul:image-source-v1:accessibility-text') {
    if (
      !isRequestId(input.requestId) ||
      typeof input.status !== 'string'
    ) return undefined;
    const descriptor = readSourceImageDescriptor(input.descriptor);
    if (!descriptor || !sameSourceDocument(
      descriptor.document,
      expectedDocument,
    )) return undefined;
    if (
      input.status === 'none' ||
      input.status === 'blocked' ||
      input.status === 'stale'
    ) {
      return hasExactKeys(input, ['kind', 'requestId', 'descriptor', 'status'])
        ? Object.freeze({
            kind: input.kind,
            requestId: input.requestId,
            descriptor,
            status: input.status,
          })
        : undefined;
    }
    if (
      input.status !== 'ready' ||
      !hasExactKeys(input, [
        'kind', 'requestId', 'descriptor', 'status', 'evidence',
      ])
    ) return undefined;
    const evidence = readSourceImageAccessibilityTextEvidence(input.evidence);
    return evidence && sameSourceDocument(evidence.document, expectedDocument) &&
      sameAccessibilityEvidenceDescriptor(evidence, descriptor)
      ? Object.freeze({
          kind: input.kind,
          requestId: input.requestId,
          descriptor,
          status: 'ready' as const,
          evidence,
        })
      : undefined;
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

export function readSourceImageAccessibilityTextEvidence(
  input: unknown,
): SourceImageAccessibilityTextEvidence | undefined {
  if (!isRecord(input) || !hasExactKeysWithOptional(input, [
    'document', 'nodeId', 'contentRevision', 'observationRevision', 'text',
    'source',
  ], ['nearestElementLanguage'])) return undefined;
  const document = readSourceDocumentIdentity(input.document);
  const text = normalizeAccessibilityImageText(input.text);
  if (
    !document ||
    !isPositiveSafeInteger(input.nodeId) ||
    !isPositiveSafeInteger(input.contentRevision) ||
    !isPositiveSafeInteger(input.observationRevision) ||
    !text || text !== input.text ||
    (input.source !== 'aria-label' && input.source !== 'alt') ||
    (input.nearestElementLanguage !== undefined &&
      !isSupportedLanguage(input.nearestElementLanguage))
  ) return undefined;
  return Object.freeze({
    document,
    nodeId: input.nodeId,
    contentRevision: input.contentRevision,
    observationRevision: input.observationRevision,
    text,
    source: input.source,
    ...(isSupportedLanguage(input.nearestElementLanguage)
      ? { nearestElementLanguage: input.nearestElementLanguage }
      : {}),
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

function sameAccessibilityEvidenceDescriptor(
  evidence: SourceImageAccessibilityTextEvidence,
  descriptor: SourceImageDescriptor,
): boolean {
  return sameSourceDocument(evidence.document, descriptor.document) &&
    evidence.nodeId === descriptor.nodeId &&
    evidence.contentRevision === descriptor.contentRevision &&
    evidence.observationRevision === descriptor.observationRevision;
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isPolicyFingerprint(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length >= 10 && value.length <= 64 &&
    /^read-v\d+-[01]{6}$/u.test(value);
}

function policyFingerprintControlImages(value: string): boolean | undefined {
  const match = /^read-v1-([01]{6})$/u.exec(value);
  if (!match) return undefined;
  return match[1]?.[1] === '1';
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
