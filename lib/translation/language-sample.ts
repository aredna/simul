const DEFAULT_LANGUAGE_SAMPLE_CHARACTERS = 20_000;
const WHITESPACE = /\s/u;

/**
 * Builds the bounded visible-text sample used by language detection without
 * first materializing every canonical source record.
 */
export function buildBoundedLanguageSample(
  sources: Iterable<string>,
  maxCharacters = DEFAULT_LANGUAGE_SAMPLE_CHARACTERS,
): string {
  const limit = positiveInteger(
    maxCharacters,
    DEFAULT_LANGUAGE_SAMPLE_CHARACTERS,
  );
  let sample = '';
  let pendingSpace = false;

  sourceLoop:
  for (const source of sources) {
    let hasRecordText = false;
    for (const character of source) {
      if (WHITESPACE.test(character)) {
        if (sample) pendingSpace = true;
        continue;
      }
      if (!hasRecordText && sample) pendingSpace = true;
      hasRecordText = true;
      if (pendingSpace) {
        if (sample.length >= limit) break sourceLoop;
        sample += ' ';
        pendingSpace = false;
      }
      if (sample.length + character.length > limit) break sourceLoop;
      sample += character;
      if (sample.length >= limit) break sourceLoop;
    }
  }

  return sample;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
