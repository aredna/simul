import type { ImageTranslationDiagnostic } from './image-translation-controller';

export const MAX_IMAGE_TRANSLATION_DIAGNOSTICS = 48;

/**
 * Bounded, memory-only OCR history for the companion options. Formatting is
 * deliberately allowlisted so future diagnostic payloads cannot accidentally
 * expose page text, URLs, image data, hashes, or source identities.
 */
export class ImageTranslationDiagnosticHistory {
  readonly #entries: string[] = [];
  #sequence = 0;

  append(diagnostic: ImageTranslationDiagnostic): readonly string[] {
    this.#sequence += 1;
    this.#entries.push(
      `${this.#sequence}. ${formatImageTranslationDiagnostic(diagnostic)}`,
    );
    while (this.#entries.length > MAX_IMAGE_TRANSLATION_DIAGNOSTICS) {
      this.#entries.shift();
    }
    return this.entries;
  }

  clear(): void {
    this.#entries.length = 0;
    this.#sequence = 0;
  }

  get entries(): readonly string[] {
    return Object.freeze([...this.#entries]);
  }
}

export function formatImageTranslationDiagnostic(
  diagnostic: ImageTranslationDiagnostic,
): string {
  if (typeof diagnostic === 'string') {
    return diagnostic.replaceAll('-', ' ');
  }
  if (diagnostic.stage === 'configuration') {
    return [
      `configuration: ${diagnostic.status}`,
      diagnostic.reason ? `reason=${diagnostic.reason}` : undefined,
    ].filter(Boolean).join('; ');
  }
  if (diagnostic.stage === 'source-summary') {
    return `source scan: candidates=${diagnostic.candidateImages}; observed=${diagnostic.observedImages}`;
  }
  if (diagnostic.stage === 'image-scheduling') {
    return [
      `image scheduling: ${diagnostic.status}`,
      diagnostic.reason ? `reason=${diagnostic.reason}` : undefined,
      `visibility=${diagnostic.visibility}`,
      `size=${diagnostic.renderedWidth}x${diagnostic.renderedHeight}`,
    ].filter(Boolean).join('; ');
  }
  if (diagnostic.stage === 'capture-deferred') {
    return `job ${diagnostic.ordinal} capture deferred: reason=${diagnostic.reason}; size=${diagnostic.renderedWidth}x${diagnostic.renderedHeight}`;
  }
  if (diagnostic.stage === 'recognition-complete') {
    return `job ${diagnostic.ordinal} recognition complete: provider=${diagnostic.provider}; regions=${diagnostic.regions}; bitmap=${diagnostic.bitmapWidth}x${diagnostic.bitmapHeight}; cache=${diagnostic.cacheHit ? 'hit' : 'miss'}`;
  }
  if (diagnostic.stage === 'recognition-cache') {
    return `recognition cache: access=${diagnostic.access}; entries=${diagnostic.entries}; weight=${diagnostic.weight}; hits=${diagnostic.hits}; misses=${diagnostic.misses}; joins=${diagnostic.joins}; loads=${diagnostic.loads}`;
  }
  if (diagnostic.stage === 'recognition-quality') {
    return `recognition quality: candidates=${diagnostic.candidateRegions}; accepted=${diagnostic.acceptedRegions}; rejected-blank=${diagnostic.rejectedBlankRegions}; rejected-punctuation=${diagnostic.rejectedPunctuationRegions}; rejected-low-confidence=${diagnostic.rejectedLowConfidenceRegions}`;
  }
  if (diagnostic.stage === 'recognition-failed') {
    return `job ${diagnostic.ordinal} recognition failed: code=${diagnostic.code}; rendered=${diagnostic.renderedWidth}x${diagnostic.renderedHeight}; bitmap=${diagnostic.bitmapWidth}x${diagnostic.bitmapHeight}`;
  }
  if (
    diagnostic.stage === 'translation-started' ||
    diagnostic.stage === 'translation-failed' ||
    diagnostic.stage === 'translation-empty'
  ) {
    return `job ${diagnostic.ordinal} ${diagnostic.stage.replaceAll('-', ' ')}: rendered=${diagnostic.renderedWidth}x${diagnostic.renderedHeight}; bitmap=${diagnostic.bitmapWidth}x${diagnostic.bitmapHeight}`;
  }
  if (diagnostic.stage === 'job-progress') {
    return [
      `job ${diagnostic.ordinal}: ${diagnostic.status.replaceAll('-', ' ')}`,
      `rendered=${diagnostic.renderedWidth}x${diagnostic.renderedHeight}`,
      diagnostic.bitmapWidth !== undefined && diagnostic.bitmapHeight !== undefined
        ? `bitmap=${diagnostic.bitmapWidth}x${diagnostic.bitmapHeight}`
        : undefined,
      diagnostic.attempt !== undefined ? `attempt=${diagnostic.attempt}` : undefined,
    ].filter(Boolean).join('; ');
  }
  return diagnostic.stage;
}
