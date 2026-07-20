declare module 'virtual:simul-ocr-provider-registry' {
  import type { ImageTextProviderModule } from '../lib/ocr/contracts';

  export const compiledOcrProviderModules: readonly ImageTextProviderModule[];
  export const compiledOcrCapabilities: Readonly<{
    promptImageLanguage: boolean;
    promptImageText: boolean;
  }>;
}

declare module 'virtual:simul-ocr-provider-runtime-registry' {
  import type {
    OffscreenOcrProviderRunnerFactory,
  } from '../lib/ocr/offscreen-host';

  export const compiledOcrProviderRunnerFactories:
    readonly OffscreenOcrProviderRunnerFactory[];
}
