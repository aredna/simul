import { isImageTextProviderId, type ImageTextProviderId } from './known-provider-ids';

export const OCR_PROVIDER_STATUS_REASONS = Object.freeze([
  'not-compiled',
  'api-missing',
  'probe-failed',
] as const);

export type OcrProviderStatusReason =
  (typeof OCR_PROVIDER_STATUS_REASONS)[number];

export type OcrProviderRuntimeStatus =
  | {
      readonly status: 'available';
      readonly providerId: ImageTextProviderId;
    }
  | {
      readonly status: 'unavailable';
      readonly providerId: ImageTextProviderId;
      readonly reason: OcrProviderStatusReason;
    };

export interface ProbeOcrProviderCommand {
  readonly kind: 'simul:ocr-v1:probe-provider';
  readonly version: 1;
  readonly providerId: ImageTextProviderId;
}

export interface ProbeOcrProviderResponse {
  readonly kind: 'simul:ocr-v1:provider-status';
  readonly version: 1;
  readonly provider: OcrProviderRuntimeStatus;
}

export function createProbeOcrProviderCommand(
  providerId: ImageTextProviderId,
): ProbeOcrProviderCommand {
  return Object.freeze({
    kind: 'simul:ocr-v1:probe-provider',
    version: 1,
    providerId,
  });
}

export function readProbeOcrProviderCommand(
  input: unknown,
): ProbeOcrProviderCommand | undefined {
  return isExactRecord(input, ['kind', 'version', 'providerId']) &&
    input.kind === 'simul:ocr-v1:probe-provider' &&
    input.version === 1 &&
    isImageTextProviderId(input.providerId)
    ? createProbeOcrProviderCommand(input.providerId)
    : undefined;
}

export function createProbeOcrProviderResponse(
  provider: OcrProviderRuntimeStatus,
): ProbeOcrProviderResponse {
  return Object.freeze({
    kind: 'simul:ocr-v1:provider-status',
    version: 1,
    provider: Object.freeze({ ...provider }),
  });
}

export function readProbeOcrProviderResponse(
  input: unknown,
  expectedProviderId?: ImageTextProviderId,
): ProbeOcrProviderResponse | undefined {
  if (
    !isExactRecord(input, ['kind', 'version', 'provider']) ||
    input.kind !== 'simul:ocr-v1:provider-status' ||
    input.version !== 1
  ) return undefined;
  const provider = readProviderStatus(input.provider);
  if (!provider || (
    expectedProviderId !== undefined &&
    provider.providerId !== expectedProviderId
  )) return undefined;
  return createProbeOcrProviderResponse(provider);
}

function readProviderStatus(input: unknown): OcrProviderRuntimeStatus | undefined {
  if (!isRecord(input) || !isImageTextProviderId(input.providerId)) {
    return undefined;
  }
  if (
    isExactRecord(input, ['status', 'providerId']) &&
    input.status === 'available'
  ) {
    return Object.freeze({
      status: 'available',
      providerId: input.providerId,
    });
  }
  if (
    isExactRecord(input, ['status', 'providerId', 'reason']) &&
    input.status === 'unavailable' &&
    OCR_PROVIDER_STATUS_REASONS.includes(input.reason as OcrProviderStatusReason)
  ) {
    return Object.freeze({
      status: 'unavailable',
      providerId: input.providerId,
      reason: input.reason as OcrProviderStatusReason,
    });
  }
  return undefined;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
