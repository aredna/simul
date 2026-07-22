import { normalizePaddleOcrResult } from '../../lib/ocr/providers/paddleocr-wasm/normalize';
import {
  createPaddleSandboxError,
  createPaddleSandboxReadyMessage,
  createPaddleSandboxResult,
  readPaddleSandboxDisposeRequest,
  readPaddleSandboxRunRequest,
  type PaddleSandboxErrorCode,
} from '../../lib/ocr/providers/paddleocr-wasm/sandbox-protocol';
import {
  createPaddleDirectPipeline,
  PaddleRuntimeLoaderError,
  PaddleRuntimeStartupError,
  PaddleWorkerLostError,
  type PaddleDirectPipeline,
} from '../../lib/ocr/providers/paddleocr-wasm/sandbox-worker-pipeline';

let pipeline: PaddleDirectPipeline | undefined;
let creating: Promise<PaddleDirectPipeline> | undefined;
let terminalStartupCode: Extract<
  PaddleSandboxErrorCode,
  'runtime-loader-failed' | 'runtime-startup-failed'
> | undefined;
let disposed = false;
let queue = Promise.resolve();

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent) return;
  const dispose = readPaddleSandboxDisposeRequest(event.data);
  if (dispose) {
    disposed = true;
    disposePipeline();
    return;
  }
  const request = readPaddleSandboxRunRequest(event.data);
  if (!request) return;
  queue = queue.then(async () => {
    if (disposed) return;
    if (terminalStartupCode) {
      post(createPaddleSandboxError(request.requestId, terminalStartupCode));
      return;
    }
    try {
      const active = await pipelineFor(request.assets);
      const raw = await active.predict(request.input);
      const result = normalizePaddleOcrResult(
        raw,
        request.bitmapWidth,
        request.bitmapHeight,
      );
      post(result
        ? createPaddleSandboxResult(request.requestId, result)
        : createPaddleSandboxError(request.requestId, 'invalid-result'));
    } catch (error) {
      const code = sandboxErrorCode(error);
      if (
        code === 'runtime-loader-failed' ||
        code === 'runtime-startup-failed'
      ) terminalStartupCode = code;
      disposePipeline();
      post(createPaddleSandboxError(request.requestId, code));
    }
  }).catch(() => undefined);
});

window.addEventListener('pagehide', () => {
  disposed = true;
  disposePipeline();
}, { once: true });

post(createPaddleSandboxReadyMessage());

async function pipelineFor(
  assets: Parameters<typeof createPaddleDirectPipeline>[0],
): Promise<PaddleDirectPipeline> {
  if (pipeline) return pipeline;
  if (!creating) {
    const task = createPaddleDirectPipeline(assets);
    creating = task;
    void task.finally(() => {
      if (creating === task) creating = undefined;
    }).catch(() => undefined);
  }
  const created = await creating;
  if (disposed) {
    created.terminate();
    throw new PaddleWorkerLostError();
  }
  pipeline = created;
  return created;
}

function disposePipeline(): void {
  const active = pipeline;
  const pending = creating;
  pipeline = undefined;
  creating = undefined;
  active?.terminate();
  if (pending) {
    void pending.then((late) => {
      if (late !== active) late.terminate();
    }, () => undefined);
  }
}

function sandboxErrorCode(error: unknown): PaddleSandboxErrorCode {
  if (error instanceof PaddleRuntimeLoaderError) {
    return 'runtime-loader-failed';
  }
  if (error instanceof PaddleRuntimeStartupError) {
    return 'runtime-startup-failed';
  }
  if (error instanceof PaddleWorkerLostError) return 'worker-lost';
  return 'recognition-failed';
}

function post(message: unknown): void {
  window.parent.postMessage(message, '*');
}
