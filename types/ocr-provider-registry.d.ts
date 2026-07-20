declare module 'virtual:simul-ocr-provider-registry' {
  import type { ImageTextProviderModule } from '../lib/ocr/contracts';

  export const compiledOcrProviderModules: readonly ImageTextProviderModule[];
  export const compiledOcrCapabilities: Readonly<{
    promptImageLanguage: boolean;
    promptImageText: boolean;
  }>;
}
