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

  append(diagnostic: ImageTranslationDiagnostic): void {
    this.#sequence += 1;
    this.#entries.push(
      `${this.#sequence}. ${formatImageTranslationDiagnostic(diagnostic)}`,
    );
    while (this.#entries.length > MAX_IMAGE_TRANSLATION_DIAGNOSTICS) {
      this.#entries.shift();
    }
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
  if (diagnostic.stage === 'replica-not-activated') {
    return `replica not activated: reason=${diagnostic.reason}`;
  }
  if (diagnostic.stage === 'source-summary') {
    return `source scan: candidates=${diagnostic.candidateImages}; observed=${diagnostic.observedImages}`;
  }
  if (diagnostic.stage === 'source-read-policy') {
    return 'image read policy: control-images=off; controls blocked before text and pixel reads';
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
    return [
      `recognition cache: access=${diagnostic.access}`,
      `entries=${diagnostic.entries}`,
      `weight=${diagnostic.weight}`,
      `hits=${diagnostic.hits}`,
      `misses=${diagnostic.misses}`,
      `joins=${diagnostic.joins}`,
      `loads=${diagnostic.loads}`,
      `expirations=${diagnostic.expirations ?? 0}`,
      `purges=${diagnostic.purges ?? 0}`,
      diagnostic.providerEntries === undefined
        ? undefined
        : `provider-entries=${diagnostic.providerEntries}`,
      diagnostic.providerWeight === undefined
        ? undefined
        : `provider-weight=${diagnostic.providerWeight}`,
      diagnostic.providerHits === undefined
        ? undefined
        : `provider-hits=${diagnostic.providerHits}`,
      diagnostic.providerMisses === undefined
        ? undefined
        : `provider-misses=${diagnostic.providerMisses}`,
    ].filter(Boolean).join('; ');
  }
  if (diagnostic.stage === 'image-evidence-cache') {
    return `image evidence cache: access=${diagnostic.access}; entries=${diagnostic.entries}; weight=${diagnostic.weight}; hits=${diagnostic.hits}; misses=${diagnostic.misses}; revalidations=${diagnostic.revalidations}; expirations=${diagnostic.expirations}; purges=${diagnostic.purges}`;
  }
  if (diagnostic.stage === 'image-final-cache') {
    return `image final cache: access=${diagnostic.access}; entries=${diagnostic.entries}; weight=${diagnostic.weight}; hits=${diagnostic.hits}; misses=${diagnostic.misses}; rebinds=${diagnostic.rebinds}; expirations=${diagnostic.expirations}; purges=${diagnostic.purges}`;
  }
  if (diagnostic.stage === 'recognition-quality') {
    return `recognition quality: candidates=${diagnostic.candidateRegions}; accepted=${diagnostic.acceptedRegions}; corroborated=${diagnostic.corroboratedRegions}; uncertain=${diagnostic.uncertainRegions}; rejected-blank=${diagnostic.rejectedBlankRegions}; rejected-punctuation=${diagnostic.rejectedPunctuationRegions}; rejected-low-confidence=${diagnostic.rejectedLowConfidenceRegions}; rejected-uncorroborated=${diagnostic.rejectedUncorroboratedRegions}`;
  }
  if (diagnostic.stage === 'evidence-selection') {
    return `evidence selection: selected=${diagnostic.selected}; reason=${diagnostic.reason}`;
  }
  if (diagnostic.stage === 'auto-language-probe-started') {
    return `Auto language probe started: images<=${diagnostic.maxImages}; routes<=${diagnostic.maxAttempts}`;
  }
  if (diagnostic.stage === 'auto-language-probe-attempt') {
    return `Auto language probe: attempt=${diagnostic.attempt}; sample=${diagnostic.sample}; candidate=${diagnostic.candidateLanguage}`;
  }
  if (diagnostic.stage === 'auto-language-probe-resolved') {
    return `Auto language resolved: language=${diagnostic.language}; evidence=${diagnostic.evidence}; attempts=${diagnostic.attempts}; samples=${diagnostic.samples}`;
  }
  if (diagnostic.stage === 'auto-language-probe-inconclusive') {
    return `Auto language inconclusive: reason=${diagnostic.reason}; attempts=${diagnostic.attempts}; samples=${diagnostic.samples}; choose From to retry`;
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
