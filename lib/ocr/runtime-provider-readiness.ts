import type { ImageTextProviderId } from './known-provider-ids';
import type { OcrProviderRuntimeStatus } from './provider-status-protocol';

/** Any generated provider module has a matching local offscreen runner. */
export function hasOcrRuntimeProvider(
  providerIds: readonly ImageTextProviderId[],
): boolean {
  return providerIds.length > 0;
}

export type OcrProviderRuntimeReadiness =
  | OcrProviderRuntimeStatus
  | 'checking';

/** Removes only providers whose platform preflight has not proven usable. */
export function runtimeReadyOcrProviderOrder(
  providerIds: readonly ImageTextProviderId[],
  statuses: ReadonlyMap<ImageTextProviderId, OcrProviderRuntimeReadiness>,
): readonly ImageTextProviderId[] {
  return Object.freeze(providerIds.filter((providerId) => {
    if (providerId !== 'chrome-text-detector') return true;
    const status = statuses.get(providerId);
    return status !== undefined &&
      status !== 'checking' &&
      status.status === 'available';
  }));
}

/** Allows one retry only for an inconclusive platform probe. */
export function shouldRetryOcrProviderProbe(
  status: OcrProviderRuntimeStatus,
  retryUsed: boolean,
): boolean {
  return !retryUsed &&
    status.providerId === 'chrome-text-detector' &&
    status.status === 'unavailable' &&
    status.reason === 'probe-failed';
}
