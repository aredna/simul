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
    expect(callback).toContain(
      'if (ready) commitAutoDetectedImageLanguage(ready)',
    );

    const resolver = script.slice(
      script.indexOf('async function resolveSelectedSourceLanguage'),
      script.indexOf('function mirrorLanguageSample'),
    );
    expect(resolver).toContain(
      'const resolutionRevision = ++sourceLanguageResolutionRevision',
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
    expect(reconciliation).toContain(
      'resolutionRevision !== sourceLanguageResolutionRevision',
    );
  });

  it('clears only image-derived language when provider routes or confidence change', () => {
    const configuration = script.slice(
      script.indexOf('function configureImageTranslation'),
      script.indexOf('async function refreshOcrProviderRuntimeStatuses'),
    );
    expect(configuration).toContain(
      'autoImageLanguageConfigurationKey(\n    usableProviderOrder,\n    preferences.ocrMinimumConfidence',
    );
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
      script.indexOf('browser.tabs.onUpdated.addListener'),
      script.indexOf('browser.tabs.onRemoved.addListener'),
    );
    expect(navigation).toContain("resolvedSourceLanguageOrigin === 'image'");
    expect(navigation).toContain('clearAutoImageLanguageResolution()');
  });
});
