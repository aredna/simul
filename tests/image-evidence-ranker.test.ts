import { describe, expect, it } from 'vitest';

import {
  assessSemanticImageEvidence,
  ImageSemanticEvidenceIndex,
  type RankableSemanticImageEvidence,
} from '../lib/ocr/image-evidence-ranker';

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
