import {
  compiledOcrCapabilities as generatedCapabilities,
  compiledOcrProviderModules as generatedModules,
} from 'virtual:simul-ocr-provider-registry';

import { isImageTextProviderId } from './known-provider-ids';
import type {
  ImageTextProviderId,
} from './known-provider-ids';
import type { ImageTextProviderModule } from './contracts';

function validateCompiledModules(
  modules: readonly ImageTextProviderModule[],
): readonly ImageTextProviderModule[] {
  const seen = new Set<ImageTextProviderId>();
  const result: ImageTextProviderModule[] = [];
  for (const provider of modules) {
    const id = provider?.descriptor?.id;
    if (!isImageTextProviderId(id) || seen.has(id)) {
      throw new Error('The compiled OCR provider registry is invalid.');
    }
    seen.add(id);
    result.push(provider);
  }
  return Object.freeze(result);
}

export const compiledImageTextProviderModules = validateCompiledModules(
  generatedModules,
);

export const compiledImageTextProviderIds: readonly ImageTextProviderId[] =
  Object.freeze(
    compiledImageTextProviderModules.map((provider) => provider.descriptor.id),
  );

export const compiledImageAnalysisCapabilities = Object.freeze({
  providerIds: compiledImageTextProviderIds,
  promptImageLanguage: generatedCapabilities.promptImageLanguage === true,
  promptImageText: generatedCapabilities.promptImageText === true,
});

/** Preserve saved positions while omitting providers absent from this build. */
export function effectiveCompiledProviderOrder(
  savedOrder: readonly ImageTextProviderId[],
  disabledProviderIds: readonly ImageTextProviderId[] = [],
): readonly ImageTextProviderId[] {
  const available = new Set(compiledImageTextProviderIds);
  const disabled = new Set(disabledProviderIds);
  return Object.freeze(
    savedOrder.filter((id) => available.has(id) && !disabled.has(id)),
  );
}

export function hasCompiledImageAnalysisCapability(): boolean {
  return (
    compiledImageTextProviderIds.length > 0 ||
    compiledImageAnalysisCapabilities.promptImageLanguage ||
    compiledImageAnalysisCapabilities.promptImageText
  );
}

/** Every compiled provider module in the generated registry has a local runner. */
export function hasCompiledOcrRuntimeProvider(): boolean {
  return compiledImageTextProviderIds.length > 0;
}
