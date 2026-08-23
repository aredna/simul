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

/** Direct aria-label/alt reading is local source code, not an OCR build module. */
export const ACCESSIBILITY_IMAGE_TEXT_COMPILED = true;

/** Preserve saved positions while omitting providers absent from this build. */
export function effectiveCompiledProviderOrder(
  savedOrder: readonly ImageTextProviderId[],
  disabledProviderIds: readonly ImageTextProviderId[] = [],
): readonly ImageTextProviderId[] {
  return Object.freeze(
    savedOrder.filter((id) =>
      compiledImageTextProviderIds.includes(id) &&
      !disabledProviderIds.includes(id)
    ),
  );
}

export function hasCompiledImageAnalysisCapability(
  capabilities: Readonly<{
    readonly providerIds: readonly ImageTextProviderId[];
    readonly promptImageLanguage: boolean;
    readonly promptImageText: boolean;
  }> = compiledImageAnalysisCapabilities,
): boolean {
  return (
    ACCESSIBILITY_IMAGE_TEXT_COMPILED ||
    capabilities.providerIds.length > 0 ||
    capabilities.promptImageLanguage ||
    capabilities.promptImageText
  );
}

/** Every compiled provider module in the generated registry has a local runner. */
export function hasCompiledOcrRuntimeProvider(): boolean {
  return compiledImageTextProviderIds.length > 0;
}
