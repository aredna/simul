import type { ImageTextProviderId } from './known-provider-ids';

/** Any generated provider module has a matching local offscreen runner. */
export function hasOcrRuntimeProvider(
  providerIds: readonly ImageTextProviderId[],
): boolean {
  return providerIds.length > 0;
}
