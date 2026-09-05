import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../entrypoints/sidepanel/main.ts', import.meta.url),
  'utf8',
);
const driver = readFileSync(
  new URL('../entrypoints/sidepanel/translation-driver.ts', import.meta.url),
  'utf8',
);

function slice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('sidepanel Auto image-language reconciliation', () => {
  it('holds image evidence until an active page resolution settles', () => {
    const offer = slice(driver, 'offerImageLanguageEvidence(', 'commitAutoDetectedImageLanguage(proposal');
    expect(offer).toContain('evidence.offerImageEvidence({');
    expect(offer).toContain('document,');
    expect(offer).toContain('origin,');
    expect(offer).toContain('if (ready) this.commitAutoDetectedImageLanguage(ready)');

    const resolver = slice(driver, 'async resolveSelectedSourceLanguage(', 'offerImageLanguageEvidence(');
    expect(resolver).toContain("const resolution = currency.begin('language-resolution')");
    expect(resolver).toContain('evidence.beginPageResolution(resolutionRevision)');
    expect(resolver).toContain('evidence.settlePageResolution');
    expect(resolver.indexOf('beginPageResolution(resolutionRevision)'))
      .toBeLessThan(resolver.indexOf('await resolveSourceLanguage'));
    expect(resolver).toContain(
      'state.pageLanguageResolutionPending = evidence.pageResolutionPending',
    );
    expect(resolver.indexOf('configureImageTranslation()'))
      .toBeLessThan(resolver.indexOf('await resolveSourceLanguage'));
    expect(resolver.indexOf('settlePageResolution'))
      .toBeGreaterThan(resolver.indexOf('await resolveSourceLanguage'));
  });

  it('labels accessibility-derived and OCR-derived image evidence accurately', () => {
    const proposal = slice(driver, 'interface PendingAutoImageLanguageEvidence', 'handleAutoImageLanguageInvalidated(');
    expect(proposal).toContain('readonly origin: AutoImageLanguageEvidenceOrigin');
    expect(proposal).toContain("proposal.origin === 'accessibility-text'");
    expect(proposal).toContain("'accessibility image text'");
    expect(proposal).toContain("'bounded image OCR'");
  });

  it('runs normal pair, OCR, availability, and automatic-translation reconciliation', () => {
    const reconciliation = slice(driver, 'async #reconcileAutoDetectedImageLanguage(', '#isCurrentAvailabilityRequest(');
    expect(reconciliation).toContain('coordinator.selectPair(pair)');
    expect(reconciliation).toContain('configureImageTranslation()');
    expect(reconciliation).toContain('await this.checkAvailability(generation)');
    expect(reconciliation).toContain('await this.maybeTranslateAutomatically(generation, identity.url)');
    expect(reconciliation).toContain('currency.isCurrent(resolution)');
  });

  it('keys image-derived language to the exact enabled method and read policy', () => {
    const config = readFileSync(
      new URL('../entrypoints/sidepanel/image-translation-config.ts', import.meta.url),
      'utf8',
    );
    const configuration = slice(config, '  configure(): void {', 'usablePixelProviderOrder(): readonly');
    expect(configuration).toContain('autoImageLanguageConfigurationKey({');
    expect(configuration).toContain('providerOrder: routedProviderOrder,');
    expect(configuration).toContain('enabledMethodOrder: this.#enabledAutoImageLanguageMethodOrder(');
    expect(configuration).toContain('policyFingerprint: replicaReadScopeFingerprint(readScope),');
    expect(configuration).toContain('controlImages: readScope.controlImages,');
    expect(configuration).toContain('shouldClearAutoImageLanguageResolution');
    expect(configuration).toContain('shouldClearAutoImageLanguageForDocument');
    expect(configuration).toContain('translationDriver.currentReplicaDocumentMatches');
    expect(configuration).toContain('pageLanguageResolutionPending: state.pageLanguageResolutionPending,');
    expect(configuration).toContain('translationDriver.clearAutoImageLanguageResolution()');
    expect(configuration).not.toContain(
      'preferences.targetLanguage,\n  );\n  if (shouldClearAutoImageLanguageResolution',
    );
    const clear = slice(driver, 'clearAutoImageLanguageResolution(): void {', 'clearAutoImageLanguageForDifferentDocument(');
    expect(clear).toContain('state.clearLanguageResolution()');
    expect(clear).toContain("currency.supersede('language-resolution')");
    expect(clear).toContain("currency.supersede('availability')");
  });

  it('drops image-derived language inside the pre-persist narrowing purge', () => {
    const controller = readFileSync(
      new URL('../entrypoints/sidepanel/read-scope-controller.ts', import.meta.url),
      'utf8',
    );
    const commit = slice(controller, 'async commitReplicaReadScope(', 'async resetAllExtensionSettings(');
    expect(commit.indexOf('purgeSourceDerivedRuntime('))
      .toBeLessThan(commit.indexOf('await preferenceClient.send'));

    const purge = slice(script, 'function purgeSourceDerivedRuntime', 'function clearResetOnlyRuntimeState');
    expect(purge).toContain("resolvedSourceLanguageOrigin === 'image'");
    expect(purge).toContain('translationDriver.clearAutoImageLanguageResolution()');
  });

  it('binds accepted OCR language to the exact replica document and clears it on navigation', () => {
    const callback = slice(script, 'onAutoLanguageDetected:', 'onAutoLanguageInvalidated:');
    expect(callback).toContain('document, origin');

    const proposal = slice(driver, 'interface PendingAutoImageLanguageEvidence', 'handleAutoImageLanguageInvalidated(');
    expect(proposal).toContain('readonly document: ReplicaSourceDocumentIdentity');
    expect(proposal).toContain('state.resolvedImageLanguageDocument = proposal.document');
    const currency = slice(driver, '#pendingImageEvidenceIsCurrent(proposal', 'async #reconcileAutoDetectedImageLanguage(');
    expect(currency).toContain('this.currentReplicaDocumentMatches(proposal.document)');
    expect(currency).toContain('proposal.replayLease === state.snapshot?.replayLease');

    const pipeline = readFileSync(
      new URL('../entrypoints/sidepanel/capture-pipeline.ts', import.meta.url),
      'utf8',
    );
    const navigation = slice(pipeline, 'beginSourceNavigation(next', 'invalidateCompanion(message');
    expect(navigation).toContain("resolvedSourceLanguageOrigin === 'image'");
    expect(navigation).toContain('translationDriver.clearAutoImageLanguageResolution()');
  });

  it('revokes only matching current-document image evidence before reconciling Auto', () => {
    const callback = slice(driver, 'handleAutoImageLanguageInvalidated(document', 'clearAutoImageLanguageResolution(): void {');
    expect(callback).toContain("resolvedSourceLanguageOrigin !== 'image'");
    expect(callback).toContain('!sameSourceDocument(state.resolvedImageLanguageDocument, document)');
    expect(callback).toContain('!this.currentReplicaDocumentMatches(document)');
    expect(callback).toContain("preferences.sourceLanguage !== 'auto'");
    expect(callback).toContain("resolvedSourceLanguageOrigin = 'explicit'");
    expect(callback).toContain('resolvedImageLanguageDocument = undefined');
    expect(callback).toContain('this.clearAutoImageLanguageResolution()');
    expect(callback).toContain('queueMicrotask(() =>');
    expect(callback).toContain('void this.applyLanguagePreferences(false)');
  });

  it('keeps unchanged effective-pair work and image provenance across an explicit toggle', () => {
    const resolver = slice(driver, 'async resolveSelectedSourceLanguage(', 'offerImageLanguageEvidence(');
    expect(resolver).toContain('unchangedExplicitImageLanguage');
    expect(resolver).toContain('previousLanguage === detected.language');
    expect(resolver).toContain('previousImageDocumentIsCurrent');

    const preferences = slice(driver, 'async applyLanguagePreferences(', 'async checkAvailability(');
    expect(preferences).toContain(
      'const effectivePairChanged = !sameTranslationPair(previousPair, nextPair)',
    );
    expect(preferences.indexOf('if (effectivePairChanged)'))
      .toBeLessThan(preferences.indexOf('activeAbortController?.abort()'));
    expect(preferences).toContain('if (!effectivePairChanged && state.translationComplete)');
  });
});
