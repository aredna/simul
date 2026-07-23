import { describe, expect, it } from 'vitest';

import type { ImageTextResult } from '../lib/ocr/contracts';
import {
  assessSemanticImageEvidence,
  ImageSemanticEvidenceIndex,
  selectImageTextEvidence,
  type RankableOcrImageEvidence,
  type RankableSemanticImageEvidence,
} from '../lib/ocr/image-evidence-ranker';
import type { ImageTextQualitySummary } from '../lib/ocr/result-quality';

const noCorroboration: ImageTextQualitySummary = Object.freeze({
  candidateRegions: 1,
  acceptedRegions: 1,
  corroboratedRegions: 0,
  uncertainRegions: 0,
  rejectedBlankRegions: 0,
  rejectedPunctuationRegions: 0,
  rejectedLowConfidenceRegions: 0,
  rejectedUncorroboratedRegions: 0,
});

const corroborated: ImageTextQualitySummary = Object.freeze({
  ...noCorroboration,
  corroboratedRegions: 1,
});

describe('deterministic image evidence ranking', () => {
  it('treats short and repeated semantic evidence as provisional', () => {
    expect(assessSemanticImageEvidence(semantic('CDN Media'))).toEqual({
      provisional: true,
      reason: 'semantic-provisional-short',
    });
    expect(assessSemanticImageEvidence(semantic(
      'A detailed description of the illustrated public notice',
      { repeated: true },
    ))).toEqual({
      provisional: true,
      reason: 'semantic-provisional-repeated',
    });
    expect(assessSemanticImageEvidence(semantic(
      'A detailed description of the illustrated public notice',
    ))).toEqual({
      provisional: false,
      reason: 'semantic-preferred',
    });
  });

  it('selects materially richer high-confidence OCR over a short label', () => {
    expect(selectImageTextEvidence(
      semantic('CDN Media'),
      ocr('Important community meeting today', {
        transcriptConfidence: 0.96,
      }),
    )).toEqual({ selected: 'ocr', reason: 'ocr-decisive' });
  });

  it('keeps descriptive semantic text over weak, sparse OCR', () => {
    expect(selectImageTextEvidence(
      semantic('A detailed description of the illustrated public notice'),
      ocr('Notice', { transcriptConfidence: 0.7 }),
    )).toEqual({ selected: 'semantic', reason: 'semantic-decisive' });
  });

  it('uses repetition only to compare and keeps an earlier accurate label over a confident OCR typo', () => {
    expect(selectImageTextEvidence(
      semantic('Search', { methodIndex: 2, repeated: true }),
      ocr('Seareh', { methodIndex: 1, transcriptConfidence: 0.95 }),
    )).toEqual({ selected: 'semantic', reason: 'semantic-decisive' });
    expect(selectImageTextEvidence(
      semantic('Search', { repeated: true }),
      ocr('Search', { transcriptConfidence: 0.95, methodIndex: 1 }),
    )).toEqual({ selected: 'semantic', reason: 'agreement-priority' });
    const descriptive = 'Official corporate registration news and public notices';
    const competingOcr = ocr('Registration news', {
      transcriptConfidence: 0.95,
    });
    expect(selectImageTextEvidence(
      semantic(descriptive, { repeated: true }),
      competingOcr,
    )).toEqual(selectImageTextEvidence(
      semantic(descriptive),
      competingOcr,
    ));
  });

  it('honors saved method order for exact agreement and close ties', () => {
    expect(selectImageTextEvidence(
      semantic('Public Notice', { methodIndex: 2 }),
      ocr(' public—notice ', {
        methodIndex: 1,
        transcriptConfidence: 0.95,
      }),
    )).toEqual({ selected: 'ocr', reason: 'agreement-priority' });
    expect(selectImageTextEvidence(
      semantic('Public Notice', { methodIndex: 0 }),
      ocr('PUBLIC NOTICE', {
        methodIndex: 1,
        transcriptConfidence: 0.95,
      }),
    )).toEqual({ selected: 'semantic', reason: 'agreement-priority' });

    expect(selectImageTextEvidence(
      semantic('Menu', { methodIndex: 0 }),
      ocr('News', {
        methodIndex: 1,
        transcriptConfidence: 0.7,
        quality: corroborated,
      }),
    )).toEqual({ selected: 'semantic', reason: 'priority-tie' });
    expect(selectImageTextEvidence(
      semantic('Menu', { methodIndex: 2 }),
      ocr('News', {
        methodIndex: 1,
        transcriptConfidence: 0.7,
        quality: corroborated,
      }),
    )).toEqual({ selected: 'ocr', reason: 'priority-tie' });
  });

  it('bounds duplicate tracking and clears repetition when a peer leaves', () => {
    const index = new ImageSemanticEvidenceIndex(2);

    expect(index.register(1, 1, 'ＣＤＮ   Media')).toEqual({
      indexed: true,
      repeated: false,
      reevaluateNodeIds: [],
    });
    expect(index.register(2, 1, 'cdn-media!')).toEqual({
      indexed: true,
      repeated: true,
      reevaluateNodeIds: [1, 2],
    });

    expect(index.unregister(2)).toEqual({
      removed: true,
      reevaluateNodeIds: [1],
    });
    expect(index.register(1, 1, 'CDN Media')).toEqual({
      indexed: true,
      repeated: false,
      reevaluateNodeIds: [],
    });
    expect(index.register(3, 1, 'Different label')).toMatchObject({
      indexed: true,
    });
    expect(index.register(4, 1, 'A third bounded record')).toEqual({
      indexed: false,
      repeated: true,
      reevaluateNodeIds: [1, 3],
    });
    expect(index.register(1, 1, 'CDN Media')).toEqual({
      indexed: true,
      repeated: true,
      reevaluateNodeIds: [],
    });

    index.clear();
    expect(index.register(1, 1, 'CDN Media')).toMatchObject({
      indexed: true,
      repeated: false,
    });
  });

  it('reports peers affected by duplicate-forming and duplicate-dissolving mutations', () => {
    const index = new ImageSemanticEvidenceIndex(3);

    index.register(1, 1, 'Shared label');
    index.register(2, 1, 'Shared label');

    expect(index.register(2, 2, 'Unique label')).toEqual({
      indexed: true,
      repeated: false,
      reevaluateNodeIds: [1],
    });
    expect(index.register(3, 1, 'Unique label')).toEqual({
      indexed: true,
      repeated: true,
      reevaluateNodeIds: [2, 3],
    });
    expect(index.register(2, 3, '   ')).toEqual({
      indexed: false,
      repeated: false,
      reevaluateNodeIds: [3],
    });
    expect(index.unregister(2)).toEqual({
      removed: false,
      reevaluateNodeIds: [],
    });
  });

  it('does not re-evaluate peers while a three-member group remains repeated', () => {
    const index = new ImageSemanticEvidenceIndex(3);

    index.register(1, 1, 'Shared label');
    index.register(2, 1, 'Shared label');
    expect(index.register(3, 1, 'Shared label')).toEqual({
      indexed: true,
      repeated: true,
      reevaluateNodeIds: [],
    });
    expect(index.unregister(3)).toEqual({
      removed: true,
      reevaluateNodeIds: [],
    });
    expect(index.unregister(2)).toEqual({
      removed: true,
      reevaluateNodeIds: [1],
    });
  });

  it('stays bounded and exact across unlimited label mutations', () => {
    const index = new ImageSemanticEvidenceIndex(2);

    for (let sequence = 0; sequence < 20; sequence += 1) {
      const label = `Shared label ${sequence}`;
      index.register(1, sequence * 2 + 1, label);
      index.register(2, sequence * 2 + 2, label);
    }

    expect(index.register(1, 100, 'Current label')).toEqual({
      indexed: true,
      repeated: false,
      reevaluateNodeIds: [2],
    });
    expect(index.register(2, 101, 'Current label')).toEqual({
      indexed: true,
      repeated: true,
      reevaluateNodeIds: [1, 2],
    });
  });
});

function semantic(
  text: string,
  overrides: Partial<RankableSemanticImageEvidence> = {},
): RankableSemanticImageEvidence {
  return {
    kind: 'semantic',
    text,
    source: 'alt',
    methodIndex: 0,
    repeated: false,
    ...overrides,
  };
}

function ocr(
  transcript: string,
  options: {
    readonly methodIndex?: number;
    readonly transcriptConfidence?: number;
    readonly quality?: ImageTextQualitySummary;
  } = {},
): RankableOcrImageEvidence {
  const result: ImageTextResult = {
    providerId: 'tesseract',
    bitmapWidth: 400,
    bitmapHeight: 200,
    transcript,
    ...(options.transcriptConfidence !== undefined
      ? { transcriptConfidence: options.transcriptConfidence }
      : {}),
    regions: Object.freeze([{
      text: transcript,
      ...(options.transcriptConfidence !== undefined
        ? { confidence: options.transcriptConfidence }
        : {}),
      boundingBox: Object.freeze({ x: 10, y: 12, width: 180, height: 20 }),
    }]),
  };
  return {
    kind: 'ocr',
    result,
    selectedQuality: options.quality ?? noCorroboration,
    methodIndex: options.methodIndex ?? 1,
    minimumConfidence: 0.65,
  };
}
