import { readImageTextResult, type ImageTextResult } from '../../contracts';

export const PADDLE_SANDBOX_PROTOCOL_VERSION = 1;
export const PADDLE_SANDBOX_MAX_INPUT_BYTES = 32 * 1024 * 1024;

const PADDLE_SANDBOX_ASSET_PATHS = Object.freeze({
  runtimeModule: '/ocr/paddle/worker/worker-entry.js',
  detectionModel:
    '/ocr/paddle/models/PP-OCRv6_tiny_det_onnx_infer.tar',
  recognitionModel:
    '/ocr/paddle/models/PP-OCRv6_tiny_rec_onnx_infer.tar',
  runtimeLoader: '/ocr/paddle/runtime/ort-wasm-simd-threaded.mjs',
  runtimeWasm: '/ocr/paddle/runtime/ort-wasm-simd-threaded.wasm',
} as const);

export const PADDLE_SANDBOX_ERROR_CODES = Object.freeze([
  'runtime-loader-failed',
  'runtime-startup-failed',
  'recognition-failed',
  'worker-lost',
  'invalid-result',
] as const);

export type PaddleSandboxErrorCode =
  (typeof PADDLE_SANDBOX_ERROR_CODES)[number];

export interface PaddleSandboxAssetUrls {
  readonly runtimeModule: string;
  readonly detectionModel: string;
  readonly recognitionModel: string;
  readonly runtimeLoader: string;
  readonly runtimeWasm: string;
}

export interface PaddleSandboxReadyMessage {
  readonly kind: 'simul:paddle-sandbox-v1:ready';
  readonly version: 1;
}

export interface PaddleSandboxRunRequest {
  readonly kind: 'simul:paddle-sandbox-v1:run';
  readonly version: 1;
  readonly requestId: number;
  readonly input: Blob;
  readonly bitmapWidth: number;
  readonly bitmapHeight: number;
  readonly assets: PaddleSandboxAssetUrls;
}

export type PaddleSandboxResponse =
  | {
      readonly kind: 'simul:paddle-sandbox-v1:result';
      readonly version: 1;
      readonly requestId: number;
      readonly result: ImageTextResult;
    }
  | {
      readonly kind: 'simul:paddle-sandbox-v1:error';
      readonly version: 1;
      readonly requestId: number;
      readonly code: PaddleSandboxErrorCode;
    };

export interface PaddleSandboxDisposeRequest {
  readonly kind: 'simul:paddle-sandbox-v1:dispose';
  readonly version: 1;
}

export function createPaddleSandboxReadyMessage(): PaddleSandboxReadyMessage {
  return Object.freeze({
    kind: 'simul:paddle-sandbox-v1:ready',
    version: PADDLE_SANDBOX_PROTOCOL_VERSION,
  });
}

export function readPaddleSandboxReadyMessage(
  input: unknown,
): PaddleSandboxReadyMessage | undefined {
  return isExactRecord(input, ['kind', 'version']) &&
    input.kind === 'simul:paddle-sandbox-v1:ready' &&
    input.version === PADDLE_SANDBOX_PROTOCOL_VERSION
    ? createPaddleSandboxReadyMessage()
    : undefined;
}

export function readPaddleSandboxRunRequest(
  input: unknown,
): PaddleSandboxRunRequest | undefined {
  if (
    !isExactRecord(input, [
      'kind',
      'version',
      'requestId',
      'input',
      'bitmapWidth',
      'bitmapHeight',
      'assets',
    ]) ||
    input.kind !== 'simul:paddle-sandbox-v1:run' ||
    input.version !== PADDLE_SANDBOX_PROTOCOL_VERSION ||
    !isPositiveSafeInteger(input.requestId) ||
    !(input.input instanceof Blob) ||
    input.input.size > PADDLE_SANDBOX_MAX_INPUT_BYTES ||
    !isBitmapDimension(input.bitmapWidth) ||
    !isBitmapDimension(input.bitmapHeight) ||
    input.bitmapWidth * input.bitmapHeight > 4_000_000
  ) return undefined;
  const assets = readAssetUrls(input.assets);
  if (!assets) return undefined;
  return Object.freeze({
    kind: input.kind,
    version: PADDLE_SANDBOX_PROTOCOL_VERSION,
    requestId: input.requestId,
    input: input.input,
    bitmapWidth: input.bitmapWidth,
    bitmapHeight: input.bitmapHeight,
    assets,
  });
}

export function readPaddleSandboxDisposeRequest(
  input: unknown,
): PaddleSandboxDisposeRequest | undefined {
  return isExactRecord(input, ['kind', 'version']) &&
    input.kind === 'simul:paddle-sandbox-v1:dispose' &&
    input.version === PADDLE_SANDBOX_PROTOCOL_VERSION
    ? Object.freeze({ kind: input.kind, version: 1 })
    : undefined;
}

export function createPaddleSandboxResult(
  requestId: number,
  result: ImageTextResult,
): PaddleSandboxResponse {
  return Object.freeze({
    kind: 'simul:paddle-sandbox-v1:result',
    version: PADDLE_SANDBOX_PROTOCOL_VERSION,
    requestId,
    result,
  });
}

export function createPaddleSandboxError(
  requestId: number,
  code: PaddleSandboxErrorCode,
): PaddleSandboxResponse {
  return Object.freeze({
    kind: 'simul:paddle-sandbox-v1:error',
    version: PADDLE_SANDBOX_PROTOCOL_VERSION,
    requestId,
    code,
  });
}

export function readPaddleSandboxResponse(
  input: unknown,
): PaddleSandboxResponse | undefined {
  if (!isRecord(input) || !isPositiveSafeInteger(input.requestId)) {
    return undefined;
  }
  if (
    isExactRecord(input, ['kind', 'version', 'requestId', 'result']) &&
    input.kind === 'simul:paddle-sandbox-v1:result' &&
    input.version === PADDLE_SANDBOX_PROTOCOL_VERSION
  ) {
    const result = readImageTextResult(input.result);
    return result?.providerId === 'paddleocr-wasm'
      ? createPaddleSandboxResult(input.requestId, result)
      : undefined;
  }
  if (
    isExactRecord(input, ['kind', 'version', 'requestId', 'code']) &&
    input.kind === 'simul:paddle-sandbox-v1:error' &&
    input.version === PADDLE_SANDBOX_PROTOCOL_VERSION &&
    PADDLE_SANDBOX_ERROR_CODES.includes(input.code as PaddleSandboxErrorCode)
  ) {
    return createPaddleSandboxError(
      input.requestId,
      input.code as PaddleSandboxErrorCode,
    );
  }
  return undefined;
}

function readAssetUrls(input: unknown): PaddleSandboxAssetUrls | undefined {
  if (!isExactRecord(input, [
    'runtimeModule',
    'detectionModel',
    'recognitionModel',
    'runtimeLoader',
    'runtimeWasm',
  ])) return undefined;
  let extensionHost: string | undefined;
  for (const [key, expectedPath] of Object.entries(
    PADDLE_SANDBOX_ASSET_PATHS,
  )) {
    const parsed = packagedExtensionUrl(input[key], expectedPath);
    if (!parsed) return undefined;
    if (extensionHost === undefined) extensionHost = parsed.hostname;
    if (parsed.hostname !== extensionHost) return undefined;
  }
  return Object.freeze({
    runtimeModule: input.runtimeModule as string,
    detectionModel: input.detectionModel as string,
    recognitionModel: input.recognitionModel as string,
    runtimeLoader: input.runtimeLoader as string,
    runtimeWasm: input.runtimeWasm as string,
  });
}

function packagedExtensionUrl(
  value: unknown,
  expectedPath: string,
): URL | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'chrome-extension:' &&
      parsed.hostname !== '' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.port === '' &&
      parsed.pathname === expectedPath &&
      parsed.search === '' &&
      parsed.hash === ''
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function isBitmapDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 32_768;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
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
