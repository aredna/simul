import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const script = readFileSync(
  new URL('../entrypoints/sidepanel/main.ts', import.meta.url),
  'utf8',
);

describe('sidepanel Auto image-language reconciliation', () => {
  it('holds image evidence until an active page resolution settles', () => {
    const callback = script.slice(
      script.indexOf('onAutoLanguageDetected:'),
      script.indexOf('function handleReplicaSourceCommit'),
    );
    expect(callback).toContain(
      'autoLanguageEvidencePrecedence.offerImageEvidence',
    );
    expect(callback).toContain('document,');
    expect(callback).toContain('origin,');
    expect(callback).toContain(
      'if (ready) commitAutoDetectedImageLanguage(ready)',
    );

    const resolver = script.slice(
      script.indexOf('async function resolveSelectedSourceLanguage'),
      script.indexOf('function mirrorLanguageSample'),
    );
    expect(resolver).toContain(
      "const resolution = currency.begin('language-resolution')",
    );
    expect(resolver).toContain(
      'autoLanguageEvidencePrecedence.beginPageResolution(resolutionRevision)',
    );
    expect(resolver).toContain(
      'autoLanguageEvidencePrecedence.settlePageResolution',
    );
    expect(resolver.indexOf('beginPageResolution(resolutionRevision)'))
      .toBeLessThan(resolver.indexOf('await resolveSourceLanguage'));
    expect(resolver).toContain(
      'pageLanguageResolutionPending =\n    autoLanguageEvidencePrecedence.pageResolutionPending',
    );
    expect(resolver.indexOf('configureImageTranslation()'))
      .toBeLessThan(resolver.indexOf('await resolveSourceLanguage'));
    expect(resolver.indexOf('settlePageResolution'))
      .toBeGreaterThan(resolver.indexOf('await resolveSourceLanguage'));
  });

  it('labels accessibility-derived and OCR-derived image evidence accurately', () => {
    const proposal = script.slice(
      script.indexOf('interface PendingAutoImageLanguageEvidence'),
      script.indexOf('async function reconcileAutoDetectedImageLanguage'),
    );
    expect(proposal).toContain(
      "readonly origin: AutoImageLanguageEvidenceOrigin",
    );
    expect(proposal).toContain(
      "proposal.origin === 'accessibility-text'",
    );
    expect(proposal).toContain("'accessibility image text'");
    expect(proposal).toContain("'bounded image OCR'");
  });

  it('runs normal pair, OCR, availability, and automatic-translation reconciliation', () => {
    const reconciliation = script.slice(
      script.indexOf('async function reconcileAutoDetectedImageLanguage'),
      script.indexOf('function mirrorLanguageSample'),
    );
    expect(reconciliation).toContain(
      'replicaTranslationCoordinator.selectPair(pair)',
    );
    expect(reconciliation).toContain('configureImageTranslation()');
    expect(reconciliation).toContain('await checkAvailability(generation)');
    expect(reconciliation).toContain(
      'await maybeTranslateAutomatically(generation, identity.url)',
    );
    expect(reconciliation).toContain('!currency.isCurrent(resolution)');
  });

  it('keys image-derived language to the exact enabled method and read policy', () => {
    const configuration = script.slice(
      script.indexOf('function configureImageTranslation'),
      script.indexOf('async function refreshOcrProviderRuntimeStatuses'),
    );
    expect(configuration).toContain(
      'autoImageLanguageConfigurationKey({',
    );
    expect(configuration).toContain('providerOrder: routedProviderOrder,');
    expect(configuration).toContain(
      'enabledMethodOrder: enabledAutoImageLanguageMethodOrder(',
    );
    expect(configuration).toContain(
      'policyFingerprint: replicaReadScopeFingerprint(readScope),',
    );
    expect(configuration).toContain('controlImages: readScope.controlImages,');
    expect(configuration).toContain(
      'shouldClearAutoImageLanguageResolution',
    );
    expect(configuration).toContain(
      'shouldClearAutoImageLanguageForDocument',
    );
    expect(configuration).toContain('currentReplicaDocumentMatches');
    expect(configuration).toContain('pageLanguageResolutionPending,');
    expect(configuration).toContain('clearAutoImageLanguageResolution()');
    expect(configuration).toContain("resolvedSourceLanguageOrigin = undefined");
    expect(configuration).not.toContain(
      'preferences.targetLanguage,\n  );\n  if (shouldClearAutoImageLanguageResolution',
    );
  });

  it('drops image-derived language inside the pre-persist narrowing purge', () => {
    const commit = script.slice(
      script.indexOf('async function commitReplicaReadScope'),
      script.indexOf('async function resetAllExtensionSettings'),
    );
    expect(commit.indexOf('purgeSourceDerivedRuntime('))
      .toBeLessThan(commit.indexOf('await preferenceClient.send'));

    const purge = script.slice(
      script.indexOf('function purgeSourceDerivedRuntime'),
      script.indexOf('function clearResetOnlyRuntimeState'),
    );
    expect(purge).toContain("resolvedSourceLanguageOrigin === 'image'");
    expect(purge).toContain('clearAutoImageLanguageResolution()');
  });

  it('binds accepted OCR language to the exact replica document and clears it on navigation', () => {
    const callback = script.slice(
      script.indexOf('onAutoLanguageDetected:'),
      script.indexOf('function handleReplicaSourceCommit'),
    );
    expect(callback).toContain('document,');

    const proposal = script.slice(
      script.indexOf('interface PendingAutoImageLanguageEvidence'),
      script.indexOf('async function reconcileAutoDetectedImageLanguage'),
    );
    expect(proposal).toContain(
      'readonly document: ReplicaSourceDocumentIdentity',
    );
    expect(proposal).toContain(
      'resolvedImageLanguageDocument = proposal.document',
    );
    expect(proposal).toContain(
      'currentReplicaDocumentMatches(proposal.document)',
    );

    const navigation = script.slice(
      script.indexOf('onSourceNavigationStarted: (next) => {'),
      script.indexOf('onFollowedUrlChanged:'),
    );
    expect(navigation).toContain("resolvedSourceLanguageOrigin === 'image'");
    expect(navigation).toContain('clearAutoImageLanguageResolution()');
  });

  it('revokes only matching current-document image evidence before reconciling Auto', () => {
    const callback = script.slice(
      script.indexOf('function handleAutoImageLanguageInvalidated'),
      script.indexOf('async function reconcileAutoDetectedImageLanguage'),
    );
    expect(callback).toContain("resolvedSourceLanguageOrigin !== 'image'");
    expect(callback).toContain(
      '!sameSourceDocument(state.resolvedImageLanguageDocument, document)',
    );
    expect(callback).toContain('!currentReplicaDocumentMatches(document)');
    expect(callback).toContain("preferences.sourceLanguage !== 'auto'");
    expect(callback).toContain("resolvedSourceLanguageOrigin = 'explicit'");
    expect(callback).toContain('resolvedImageLanguageDocument = undefined');
    expect(callback).toContain('clearAutoImageLanguageResolution()');
    expect(callback).toContain('queueMicrotask(() =>');
    expect(callback).toContain('void applyLanguagePreferences(false)');
  });

  it('keeps unchanged effective-pair work and image provenance across an explicit toggle', () => {
    const resolver = script.slice(
      script.indexOf('async function resolveSelectedSourceLanguage'),
      script.indexOf('function commitAutoDetectedImageLanguage'),
    );
    expect(resolver).toContain('unchangedExplicitImageLanguage');
    expect(resolver).toContain('previousLanguage === detected.language');
    expect(resolver).toContain('previousImageDocumentIsCurrent');

    const preferences = script.slice(
      script.indexOf('async function applyLanguagePreferences'),
      script.indexOf('async function checkAvailability'),
    );
    expect(preferences).toContain(
      'const effectivePairChanged = !sameTranslationPair(previousPair, nextPair)',
    );
    expect(preferences.indexOf('if (effectivePairChanged)'))
      .toBeLessThan(preferences.indexOf('activeAbortController?.abort()'));
    expect(preferences).toContain(
      'if (!effectivePairChanged && state.translationComplete)',
    );
  });
});
