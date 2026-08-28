import { describe, expect, it } from 'vitest';

import {
  ImageTranslationDiagnosticHistory,
  MAX_IMAGE_TRANSLATION_DIAGNOSTICS,
  formatImageTranslationDiagnostic,
} from '../lib/ocr/diagnostic-history';
import type { ImageTranslationDiagnostic } from '../lib/ocr/image-translation-controller';

describe('ImageTranslationDiagnosticHistory', () => {
  it('formats only the allowlisted content-free diagnostic fields', () => {
    expect(formatImageTranslationDiagnostic({
      stage: 'source-summary',
      candidateImages: 7,
      observedImages: 3,
    })).toBe('source scan: candidates=7; observed=3');
    expect(formatImageTranslationDiagnostic({
      stage: 'source-read-policy',
      controlImagesEnabled: false,
    })).toBe('image read policy: control-images=off; controls blocked before text and pixel reads');
    expect(formatImageTranslationDiagnostic({
      stage: 'recognition-failed',
      code: 'provider-unavailable',
      ordinal: 7,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 7 recognition failed: code=provider-unavailable; rendered=603x381; bitmap=1206x761');
    expect(formatImageTranslationDiagnostic({
      stage: 'recognition-complete',
      provider: 'tesseract',
      regions: 4,
      cacheHit: true,
      ordinal: 2,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 recognition complete: provider=tesseract; regions=4; bitmap=1206x761; cache=hit');
    expect(formatImageTranslationDiagnostic({
      stage: 'recognition-cache',
      access: 'join',
      entries: 3,
      weight: 99,
      hits: 4,
      misses: 5,
      joins: 2,
      loads: 3,
    })).toBe('recognition cache: access=join; entries=3; weight=99; hits=4; misses=5; joins=2; loads=3; expirations=0; purges=0');
    expect(formatImageTranslationDiagnostic({
      stage: 'image-evidence-cache',
      access: 'hit',
      entries: 2,
      weight: 144,
      hits: 3,
      misses: 1,
      revalidations: 3,
      expirations: 1,
      purges: 2,
    })).toBe('image evidence cache: access=hit; entries=2; weight=144; hits=3; misses=1; revalidations=3; expirations=1; purges=2');
    expect(formatImageTranslationDiagnostic({
      stage: 'image-final-cache',
      access: 'rebind',
      entries: 2,
      weight: 155,
      hits: 4,
      misses: 1,
      rebinds: 2,
      expirations: 1,
      purges: 3,
    })).toBe('image final cache: access=rebind; entries=2; weight=155; hits=4; misses=1; rebinds=2; expirations=1; purges=3');
    expect(formatImageTranslationDiagnostic({
      stage: 'recognition-quality',
      candidateRegions: 8,
      acceptedRegions: 5,
      corroboratedRegions: 2,
      uncertainRegions: 3,
      rejectedBlankRegions: 1,
      rejectedPunctuationRegions: 1,
      rejectedLowConfidenceRegions: 1,
      rejectedUncorroboratedRegions: 1,
    })).toBe('recognition quality: candidates=8; accepted=5; corroborated=2; uncertain=3; rejected-blank=1; rejected-punctuation=1; rejected-low-confidence=1; rejected-uncorroborated=1');
    expect(formatImageTranslationDiagnostic({
      stage: 'evidence-selection',
      selected: 'ocr',
      reason: 'ocr-decisive',
    })).toBe('evidence selection: selected=ocr; reason=ocr-decisive');
    expect(formatImageTranslationDiagnostic({
      stage: 'auto-language-probe-resolved',
      language: 'ja',
      evidence: 'single-strong-script',
      attempts: 1,
      samples: 1,
    })).toBe('Auto language resolved: language=ja; evidence=single-strong-script; attempts=1; samples=1');
    expect(formatImageTranslationDiagnostic({
      stage: 'auto-language-probe-inconclusive',
      reason: 'route-budget',
      attempts: 18,
      samples: 3,
    })).toBe('Auto language inconclusive: reason=route-budget; attempts=18; samples=3; choose From to retry');
    expect(formatImageTranslationDiagnostic({
      stage: 'translation-started',
      ordinal: 2,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 translation started: rendered=603x381; bitmap=1206x761');
    expect(formatImageTranslationDiagnostic({
      stage: 'translation-failed',
      ordinal: 2,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 translation failed: rendered=603x381; bitmap=1206x761');
    expect(formatImageTranslationDiagnostic({
      stage: 'translation-empty',
      ordinal: 2,
      renderedWidth: 603,
      renderedHeight: 381,
      bitmapWidth: 1206,
      bitmapHeight: 761,
    })).toBe('job 2 translation empty: rendered=603x381; bitmap=1206x761');
  });

  it('keeps only the newest bounded in-memory entries', () => {
    const history = new ImageTranslationDiagnosticHistory();
    for (let index = 0; index < MAX_IMAGE_TRANSLATION_DIAGNOSTICS + 2; index += 1) {
      history.append('image-discovered');
    }

    expect(history.entries).toHaveLength(MAX_IMAGE_TRANSLATION_DIAGNOSTICS);
    expect(history.entries[0]).toMatch(/^3\. image discovered$/u);
    expect(history.entries.at(-1)).toMatch(
      new RegExp(`^${MAX_IMAGE_TRANSLATION_DIAGNOSTICS + 2}\\. image discovered$`, 'u'),
    );

    history.clear();
    expect(history.entries).toEqual([]);
    history.append('disabled');
    expect(history.entries).toEqual(['1. disabled']);
  });

  it('reports a bounded reason when OCR never activates for a replica run', () => {
    const history = new ImageTranslationDiagnosticHistory();
    history.append({
      stage: 'replica-not-activated',
      reason: 'snapshot-mismatch',
    });

    expect(history.entries).toEqual([
      '1. replica not activated: reason=snapshot-mismatch',
    ]);
  });

  it('never formats unallowlisted content from a diagnostic object', () => {
    const diagnostic = {
      stage: 'recognition-cache',
      access: 'hit',
      entries: 1,
      weight: 42,
      hits: 1,
      misses: 0,
      joins: 0,
      loads: 1,
      text: 'private page text',
      url: 'https://private.example/',
      pixelHash: 'secret-hash',
      nodeId: 44,
      documentId: 'private-document',
    } as ImageTranslationDiagnostic;

    const formatted = formatImageTranslationDiagnostic(diagnostic);
    expect(formatted).toBe(
      'recognition cache: access=hit; entries=1; weight=42; hits=1; misses=0; joins=0; loads=1; expirations=0; purges=0',
    );
    expect(formatted).not.toMatch(/private|secret|44/u);

    const evidenceDiagnostic = {
      stage: 'evidence-selection',
      selected: 'semantic',
      reason: 'priority-tie',
      text: 'private page text',
      sourceUrl: 'https://private.example/',
      nodeId: 44,
    } as ImageTranslationDiagnostic;
    const formattedEvidence = formatImageTranslationDiagnostic(
      evidenceDiagnostic,
    );
    expect(formattedEvidence).toBe(
      'evidence selection: selected=semantic; reason=priority-tie',
    );
    expect(formattedEvidence).not.toMatch(/private|44/u);

    const imageEvidenceDiagnostic = {
      stage: 'image-evidence-cache',
      access: 'hit',
      entries: 1,
      weight: 42,
      hits: 1,
      misses: 0,
      revalidations: 1,
      expirations: 0,
      purges: 0,
      text: 'private page text',
      url: 'https://private.example/',
      pixelHash: 'secret-hash',
      nodeId: 44,
      documentId: 'private-document',
    } as ImageTranslationDiagnostic;
    const formattedImageEvidence = formatImageTranslationDiagnostic(
      imageEvidenceDiagnostic,
    );
    expect(formattedImageEvidence).toBe(
      'image evidence cache: access=hit; entries=1; weight=42; hits=1; misses=0; revalidations=1; expirations=0; purges=0',
    );
    expect(formattedImageEvidence).not.toMatch(/private|secret|44/u);

    const finalDiagnostic = {
      stage: 'image-final-cache',
      access: 'hit',
      entries: 1,
      weight: 42,
      hits: 1,
      misses: 0,
      rebinds: 1,
      expirations: 0,
      purges: 0,
      text: 'private page text',
      url: 'https://private.example/',
      pixelHash: 'secret-hash',
      nodeId: 44,
    } as ImageTranslationDiagnostic;
    const formattedFinal = formatImageTranslationDiagnostic(finalDiagnostic);
    expect(formattedFinal).toBe(
      'image final cache: access=hit; entries=1; weight=42; hits=1; misses=0; rebinds=1; expirations=0; purges=0',
    );
    expect(formattedFinal).not.toMatch(/private|secret|44/u);
  });
});
