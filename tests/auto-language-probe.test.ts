import { describe, expect, it } from 'vitest';

import {
  AUTO_LANGUAGE_PROBE_CANDIDATES,
  AutoImageLanguageProbe,
  createAutoLanguageProbeSampleIdentity,
  MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS,
  MAX_AUTO_LANGUAGE_PROBE_IMAGES,
  MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE,
  strongScriptEvidence,
  type AutoLanguageProbeSampleIdentity,
} from '../lib/ocr/auto-language-probe';
import type { SupportedLanguage } from '../lib/translation-provider';

function sample(): AutoLanguageProbeSampleIdentity {
  return createAutoLanguageProbeSampleIdentity();
}

function hash(part: string): string {
  return part.repeat(32);
}

function completeRoutes(
  probe: AutoImageLanguageProbe,
  identity: AutoLanguageProbeSampleIdentity,
  pixelHash: string,
): readonly SupportedLanguage[] {
  const routes = probe.candidateLanguages(identity, pixelHash);
  for (const route of routes) {
    expect(probe.beginAttempt(identity, pixelHash, route, 1)).toBe(true);
    expect(probe.completeAttempt(identity, pixelHash, route)).toBe(true);
  }
  return routes;
}

describe('AutoImageLanguageProbe', () => {
  it('identifies only unambiguous supported scripts', () => {
    expect(strongScriptEvidence('お知らせ')).toEqual({
      language: 'ja',
      characters: 3,
    });
    expect(strongScriptEvidence('안녕하세요')?.language).toBe('ko');
    expect(strongScriptEvidence('Ελλάδα')?.language).toBe('el');
    expect(strongScriptEvidence('مرحبا بالعالم')).toBeUndefined();
    expect(strongScriptEvidence('English only')).toBeUndefined();
    expect(strongScriptEvidence('法人番号')).toBeUndefined();
    expect(strongScriptEvidence('お知らせ어')).toBeUndefined();
  });

  it('promotes the supplied Japanese navigation label from one strong result', () => {
    const pixelHash = hash('ab');
    const identity = sample();
    const probe = new AutoImageLanguageProbe(1_000, 0.65);
    expect(AUTO_LANGUAGE_PROBE_CANDIDATES[0]).toBe('ja');
    expect(probe.beginAttempt(identity, pixelHash, 'ja', 1_001)).toBe(true);
    expect(probe.observe({
      sampleIdentity: identity,
      pixelHash,
      routeLanguage: 'ja',
      transcript: 'お知らせ',
      confidence: 0.94,
    })).toEqual({
      status: 'resolved',
      language: 'ja',
      evidence: 'single-strong-script',
      attempts: 1,
      images: 1,
    });
  });

  it('corroborates distinct source images even when their pixels match', () => {
    const pixelHash = hash('11');
    const first = sample();
    const second = sample();
    const probe = new AutoImageLanguageProbe(0);
    expect(probe.beginAttempt(first, pixelHash, 'en', 1)).toBe(true);
    expect(probe.observe({
      sampleIdentity: first,
      pixelHash,
      routeLanguage: 'en',
      transcript: 'Public notice',
      confidence: 0.95,
      detectedLanguage: 'en',
    })).toEqual({ status: 'continue' });
    expect(probe.candidateLanguages(second, pixelHash)[0]).toBe('en');
    expect(probe.beginAttempt(second, pixelHash, 'en', 2)).toBe(true);
    expect(probe.observe({
      sampleIdentity: second,
      pixelHash,
      routeLanguage: 'en',
      transcript: 'Latest news',
      confidence: 0.92,
      detectedLanguage: 'en',
    })).toMatchObject({
      status: 'resolved',
      language: 'en',
      evidence: 'distinct-images',
    });
  });

  it('keeps pixel revisions of one source image as one sample and one six-route budget', () => {
    const firstPixels = hash('21');
    const revisedPixels = hash('22');
    const identity = sample();
    const otherIdentity = sample();
    const probe = new AutoImageLanguageProbe(0);

    expect(probe.beginAttempt(identity, firstPixels, 'ja', 1)).toBe(true);
    expect(probe.observe({
      sampleIdentity: identity,
      pixelHash: firstPixels,
      routeLanguage: 'ja',
      transcript: 'お知らせ',
      confidence: 0.89,
    })).toEqual({ status: 'continue' });
    expect(probe.candidateLanguages(identity, revisedPixels)).not.toContain('ja');
    expect(probe.beginAttempt(identity, revisedPixels, 'ja', 2)).toBe(false);

    for (const route of probe.candidateLanguages(identity, revisedPixels)) {
      expect(probe.beginAttempt(identity, revisedPixels, route, 2)).toBe(true);
      expect(probe.completeAttempt(identity, revisedPixels, route)).toBe(true);
    }
    expect(probe.candidateLanguages(identity, hash('23'))).toEqual([]);
    expect(probe.attempts).toBe(MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE);

    expect(probe.beginAttempt(otherIdentity, revisedPixels, 'ja', 3)).toBe(true);
    expect(probe.observe({
      sampleIdentity: otherIdentity,
      pixelHash: revisedPixels,
      routeLanguage: 'ja',
      transcript: 'あたらしい',
      confidence: 0.89,
    })).toMatchObject({
      status: 'resolved',
      language: 'ja',
      evidence: 'distinct-images',
    });
  });

  it('lets confidence-free evidence corroborate without single-image promotion', () => {
    const firstPixels = hash('31');
    const secondPixels = hash('32');
    const first = sample();
    const second = sample();
    const probe = new AutoImageLanguageProbe(0);
    expect(probe.beginAttempt(first, firstPixels, 'ja', 1)).toBe(true);
    expect(probe.observe({
      sampleIdentity: first,
      pixelHash: firstPixels,
      routeLanguage: 'ja',
      transcript: 'お知らせ',
    })).toEqual({ status: 'continue' });
    expect(probe.observe({
      sampleIdentity: first,
      pixelHash: firstPixels,
      routeLanguage: 'ja',
      transcript: 'お知らせ',
    })).toEqual({ status: 'ignored' });

    expect(probe.beginAttempt(second, secondPixels, 'ja', 2)).toBe(true);
    expect(probe.observe({
      sampleIdentity: second,
      pixelHash: secondPixels,
      routeLanguage: 'ja',
      transcript: 'あたらしい',
    })).toMatchObject({
      status: 'resolved',
      language: 'ja',
      evidence: 'distinct-images',
    });
  });

  it('reuses one bounded route across provider continuations', () => {
    const identity = sample();
    const pixelHash = hash('33');
    const probe = new AutoImageLanguageProbe(0);
    expect(probe.beginAttempt(identity, pixelHash, 'en', 1)).toBe(true);
    expect(probe.observe({
      sampleIdentity: identity,
      pixelHash,
      routeLanguage: 'en',
      transcript: 'Public notice',
      confidence: 0.95,
      detectedLanguage: 'en',
    })).toEqual({ status: 'continue' });

    expect(probe.resumeAttempt(identity, pixelHash, 'en', 2)).toBe(true);
    expect(probe.attempts).toBe(1);
    expect(probe.completeAttempt(identity, pixelHash, 'en')).toBe(true);
  });

  it('requires two distinct semantic image labels before resolving the page', () => {
    const first = sample();
    const second = sample();
    const probe = new AutoImageLanguageProbe(0);
    expect(probe.observeSemantic({
      sampleIdentity: first,
      text: 'お知らせ',
      detectedLanguage: 'ja',
      now: 1,
    })).toEqual({ status: 'continue' });
    expect(probe.observeSemantic({
      sampleIdentity: first,
      text: '最新情報',
      detectedLanguage: 'ja',
      now: 2,
    })).toEqual({ status: 'continue' });
    expect(probe.attempts).toBe(0);
    expect(probe.images).toBe(1);

    expect(probe.observeSemantic({
      sampleIdentity: second,
      text: '法人番号',
      detectedLanguage: 'ja',
      now: 3,
    })).toEqual({
      status: 'resolved',
      language: 'ja',
      evidence: 'distinct-images',
      attempts: 0,
      images: 2,
    });
  });

  it('releases cancelled attempts without permanently consuming a sample', () => {
    const pixelHash = hash('41');
    const identity = sample();
    const probe = new AutoImageLanguageProbe(0);
    expect(probe.beginAttempt(identity, pixelHash, 'ja', 1)).toBe(true);
    expect(probe.images).toBe(1);
    expect(probe.attempts).toBe(1);

    expect(probe.rollbackAttempt(identity, pixelHash, 'ja')).toBe(true);
    expect(probe.images).toBe(0);
    expect(probe.attempts).toBe(0);
    expect(probe.candidateLanguages(identity, pixelHash)).toContain('ja');
    expect(probe.beginAttempt(identity, pixelHash, 'ja', 2)).toBe(true);
    expect(probe.observe({
      sampleIdentity: identity,
      pixelHash,
      routeLanguage: 'ja',
      transcript: 'お知らせ',
      confidence: 0.89,
    })).toEqual({ status: 'continue' });
    expect(probe.beginAttempt(identity, pixelHash, 'en', 3)).toBe(true);
    expect(probe.rollbackAttempt(identity, pixelHash, 'en')).toBe(true);
    expect(probe.images).toBe(1);
    expect(probe.attempts).toBe(1);
  });

  it('makes every representative model route reachable within bounded windows', () => {
    const probe = new AutoImageLanguageProbe(0);
    const identities = [sample(), sample(), sample()];
    const hashes = ['51', '52', '53'].map(hash);
    const reached = new Set<string>();
    for (const [index, pixelHash] of hashes.entries()) {
      const routes = completeRoutes(probe, identities[index]!, pixelHash);
      expect(routes.length).toBe(MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE);
      routes.forEach((route) => reached.add(route));
    }

    expect([...reached]).toEqual(expect.arrayContaining([
      ...AUTO_LANGUAGE_PROBE_CANDIDATES,
    ]));
    expect(reached.size).toBe(AUTO_LANGUAGE_PROBE_CANDIDATES.length);
    expect(probe.attempts).toBe(MAX_AUTO_LANGUAGE_PROBE_ATTEMPTS);
    expect(probe.inconclusiveReason(1)).toBe('route-budget');
  });

  it('retries Japanese on every distinct source sample', () => {
    const probe = new AutoImageLanguageProbe(0);
    const logo = sample();
    const navigation = sample();
    completeRoutes(probe, logo, hash('54'));

    expect(probe.candidateLanguages(navigation, hash('55'))).toContain('ja');
    expect(probe.beginAttempt(navigation, hash('55'), 'ja', 2)).toBe(true);
    expect(probe.observe({
      sampleIdentity: navigation,
      pixelHash: hash('55'),
      routeLanguage: 'ja',
      transcript: 'お知らせ',
      confidence: 0.94,
    })).toMatchObject({
      status: 'resolved',
      language: 'ja',
      evidence: 'single-strong-script',
    });
  });

  it('uses representative routes for related Latin, Cyrillic, and Devanagari results', () => {
    const cases = [
      { route: 'en', detected: 'es', text: 'Aviso público', needsSlotOne: false },
      { route: 'ru', detected: 'uk', text: 'Важливе повідомлення', needsSlotOne: false },
      { route: 'hi', detected: 'mr', text: 'महत्त्वाची सूचना', needsSlotOne: true },
    ] as const;
    for (const [index, candidate] of cases.entries()) {
      const probe = new AutoImageLanguageProbe(0);
      if (candidate.needsSlotOne) {
        completeRoutes(probe, sample(), hash(`${index + 6}0`));
      }
      const first = sample();
      const second = sample();
      const firstPixels = hash(`${index + 6}1`);
      const secondPixels = hash(`${index + 6}2`);
      expect(probe.beginAttempt(first, firstPixels, candidate.route, 1)).toBe(true);
      expect(probe.observe({
        sampleIdentity: first,
        pixelHash: firstPixels,
        routeLanguage: candidate.route,
        transcript: candidate.text,
        confidence: 0.95,
        detectedLanguage: candidate.detected,
      })).toEqual({ status: 'continue' });
      expect(probe.candidateLanguages(second, secondPixels)[0])
        .toBe(candidate.route);
      expect(probe.beginAttempt(second, secondPixels, candidate.route, 2)).toBe(true);
      expect(probe.observe({
        sampleIdentity: second,
        pixelHash: secondPixels,
        routeLanguage: candidate.route,
        transcript: candidate.text,
        confidence: 0.95,
        detectedLanguage: candidate.detected,
      })).toMatchObject({
        status: 'resolved',
        language: candidate.detected,
        evidence: 'distinct-images',
      });
    }
  });

  it('does not let minority Kana noise override reliable transcript detection', () => {
    const first = sample();
    const second = sample();
    const firstPixels = hash('71');
    const secondPixels = hash('72');
    const probe = new AutoImageLanguageProbe(0);
    expect(probe.beginAttempt(first, firstPixels, 'en', 1)).toBe(true);
    expect(probe.observe({
      sampleIdentity: first,
      pixelHash: firstPixels,
      routeLanguage: 'en',
      transcript: 'Public お notice 123',
      confidence: 0.95,
      detectedLanguage: 'en',
    })).toEqual({ status: 'continue' });
    expect(probe.beginAttempt(second, secondPixels, 'en', 2)).toBe(true);
    expect(probe.observe({
      sampleIdentity: second,
      pixelHash: secondPixels,
      routeLanguage: 'en',
      transcript: 'Latest カ news 456',
      confidence: 0.95,
      detectedLanguage: 'en',
    })).toMatchObject({ status: 'resolved', language: 'en' });

    const wrongRoute = new AutoImageLanguageProbe(0);
    const wrongSample = sample();
    expect(wrongRoute.beginAttempt(wrongSample, firstPixels, 'ja', 1)).toBe(true);
    expect(wrongRoute.observe({
      sampleIdentity: wrongSample,
      pixelHash: firstPixels,
      routeLanguage: 'ja',
      transcript: 'Public お notice 123',
      confidence: 0.95,
      detectedLanguage: 'en',
    })).toEqual({ status: 'ignored' });
  });

  it('freezes a sample route plan and rejects excess samples and stale completions', () => {
    const probe = new AutoImageLanguageProbe(0);
    const first = sample();
    const firstPixels = hash('81');
    const plan = probe.candidateLanguages(first, firstPixels);
    expect(plan).toHaveLength(MAX_AUTO_LANGUAGE_PROBE_ROUTES_PER_IMAGE);
    expect(probe.beginAttempt(first, firstPixels, plan[0]!, 1)).toBe(true);
    expect(probe.completeAttempt(first, hash('82'), plan[0]!)).toBe(false);
    expect(probe.completeAttempt(first, firstPixels, plan[0]!)).toBe(true);
    expect(probe.candidateLanguages(first, hash('82'))).toEqual(plan.slice(1));
    for (const route of plan.slice(1)) {
      expect(probe.beginAttempt(first, hash('82'), route, 2)).toBe(true);
      expect(probe.completeAttempt(first, hash('82'), route)).toBe(true);
    }
    const seventh = AUTO_LANGUAGE_PROBE_CANDIDATES.find(
      (route) => !plan.includes(route),
    )!;
    expect(probe.beginAttempt(first, hash('83'), seventh, 3)).toBe(false);

    completeRoutes(probe, sample(), hash('84'));
    completeRoutes(probe, sample(), hash('85'));
    expect(probe.candidateLanguages(sample(), hash('86'))).toEqual([]);
    expect(probe.images).toBe(MAX_AUTO_LANGUAGE_PROBE_IMAGES);

    const deadline = new AutoImageLanguageProbe(10_000);
    expect(deadline.remainingMs(29_999)).toBe(1);
    expect(deadline.inconclusiveReason(30_000)).toBe('deadline');
  });
});
