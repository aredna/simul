import type { ImageTextResult } from './contracts';
import type { SourceImageAccessibilityTextEvidence } from './image-source-protocol';
import type { ImageTextQualitySummary } from './result-quality';

export const IMAGE_EVIDENCE_RANKING_POLICY_VERSION = 'deterministic-v1';
export const MAX_IMAGE_SEMANTIC_EVIDENCE_RECORDS = 512;
const MAX_RANKING_TEXT = 4_000;
const DECISIVE_SCORE_MARGIN = 2;
const MEANINGFUL_CHARACTER = /[\p{L}\p{N}]/u;

export type SemanticEvidenceAssessmentReason =
  | 'semantic-preferred'
  | 'semantic-provisional-short'
  | 'semantic-provisional-repeated';

export type ImageEvidenceSelectionReason =
  | 'agreement-priority'
  | 'ocr-decisive'
  | 'semantic-decisive'
  | 'priority-tie';

export interface RankableSemanticImageEvidence {
  readonly kind: 'semantic';
  readonly text: string;
  readonly source: SourceImageAccessibilityTextEvidence['source'];
  readonly methodIndex: number;
  readonly repeated: boolean;
}

export interface RankableOcrImageEvidence {
  readonly kind: 'ocr';
  readonly result: ImageTextResult;
  readonly selectedQuality: ImageTextQualitySummary;
  readonly methodIndex: number;
  readonly minimumConfidence: number;
}

export interface SemanticEvidenceAssessment {
  readonly provisional: boolean;
  readonly reason: SemanticEvidenceAssessmentReason;
}

export interface ImageEvidenceSelection {
  readonly selected: 'semantic' | 'ocr';
  readonly reason: ImageEvidenceSelectionReason;
}

export interface SemanticEvidenceIndexRegistration {
  readonly indexed: boolean;
  readonly repeated: boolean;
  readonly reevaluateNodeIds: readonly number[];
}

export interface SemanticEvidenceIndexRemoval {
  readonly removed: boolean;
  readonly reevaluateNodeIds: readonly number[];
}

interface IndexedSemanticEvidence {
  readonly contentRevision: number;
  readonly key: string;
}

/**
 * Exact-controller-lifetime duplicate tracking. Source text remains bounded,
 * memory-only, and never leaves this class through diagnostics or snapshots.
 */
export class ImageSemanticEvidenceIndex {
  readonly #maxRecords: number;
  readonly #nodes = new Map<number, IndexedSemanticEvidence>();
  readonly #groups = new Map<string, Set<number>>();
  #saturated = false;

  constructor(maxRecords = MAX_IMAGE_SEMANTIC_EVIDENCE_RECORDS) {
    this.#maxRecords = positiveBoundedInteger(
      maxRecords,
      MAX_IMAGE_SEMANTIC_EVIDENCE_RECORDS,
    );
  }

  register(
    nodeId: number,
    contentRevision: number,
    text: string,
  ): SemanticEvidenceIndexRegistration {
    if (!isPositiveSafeInteger(nodeId) || !isPositiveSafeInteger(contentRevision)) {
      return emptyRegistration();
    }
    const previous = this.#nodes.get(nodeId);
    const key = normalizeComparableImageEvidenceText(text);
    if (!key) {
      return Object.freeze({
        ...emptyRegistration(),
        reevaluateNodeIds: this.#removeNode(nodeId, previous),
      });
    }
    if (previous?.contentRevision === contentRevision && previous.key === key) {
      return Object.freeze({
        indexed: true,
        repeated: this.#saturated || (this.#groups.get(key)?.size ?? 0) >= 2,
        reevaluateNodeIds: Object.freeze([]),
      });
    }
    if (previous?.key === key) {
      this.#nodes.set(nodeId, Object.freeze({ contentRevision, key }));
      return Object.freeze({
        indexed: true,
        repeated: this.#saturated || (this.#groups.get(key)?.size ?? 0) >= 2,
        reevaluateNodeIds: Object.freeze([]),
      });
    }
    if (!previous && this.#nodes.size >= this.#maxRecords) {
      const newlySaturated = !this.#saturated;
      this.#saturated = true;
      return Object.freeze({
        indexed: false,
        // Once exact tracking reaches its hard bound, fail safely toward
        // comparison for all remaining evidence in this document epoch.
        repeated: true,
        reevaluateNodeIds: newlySaturated
          ? Object.freeze([...this.#nodes.keys()])
          : Object.freeze([]),
      });
    }
    const reevaluateNodeIds = new Set(
      this.#removeNode(nodeId, previous),
    );
    let group = this.#groups.get(key);
    if (!group) {
      group = new Set();
      this.#groups.set(key, group);
    }
    const wasRepeated = group.size >= 2;
    group.add(nodeId);
    this.#nodes.set(nodeId, Object.freeze({ contentRevision, key }));
    if (!wasRepeated && group.size >= 2) {
      for (const affectedNodeId of group) {
        reevaluateNodeIds.add(affectedNodeId);
      }
    }
    return Object.freeze({
      indexed: true,
      repeated: this.#saturated || group.size >= 2,
      reevaluateNodeIds: freezeNodeIds(reevaluateNodeIds),
    });
  }

  unregister(nodeId: number): SemanticEvidenceIndexRemoval {
    const previous = this.#nodes.get(nodeId);
    if (!previous) return emptyRemoval();
    return Object.freeze({
      removed: true,
      reevaluateNodeIds: this.#removeNode(nodeId, previous),
    });
  }

  clear(): void {
    this.#nodes.clear();
    this.#groups.clear();
    this.#saturated = false;
  }

  #removeNode(
    nodeId: number,
    previous: IndexedSemanticEvidence | undefined,
  ): readonly number[] {
    if (!previous) return Object.freeze([]);
    this.#nodes.delete(nodeId);
    const group = this.#groups.get(previous.key);
    const wasRepeated = (group?.size ?? 0) >= 2;
    group?.delete(nodeId);
    if (group?.size === 0) this.#groups.delete(previous.key);
    return !this.#saturated && wasRepeated && group?.size === 1
      ? Object.freeze([...group])
      : Object.freeze([]);
  }
}

export function assessSemanticImageEvidence(
  evidence: RankableSemanticImageEvidence,
): SemanticEvidenceAssessment {
  if (evidence.repeated) {
    return Object.freeze({
      provisional: true,
      reason: 'semantic-provisional-repeated',
    });
  }
  const shape = textShape(evidence.text);
  if (semanticShapeIsShort(shape)) {
    return Object.freeze({
      provisional: true,
      reason: 'semantic-provisional-short',
    });
  }
  return Object.freeze({
    provisional: false,
    reason: 'semantic-preferred',
  });
}

/** Select source evidence, never translated output. Close decisions honor order. */
export function selectImageTextEvidence(
  semantic: RankableSemanticImageEvidence,
  ocr: RankableOcrImageEvidence,
): ImageEvidenceSelection {
  const semanticText = normalizeComparableImageEvidenceText(semantic.text);
  const ocrText = normalizeComparableImageEvidenceText(ocr.result.transcript);
  if (semanticText && semanticText === ocrText) {
    return selectByPriority(semantic, ocr, 'agreement-priority');
  }

  const semanticScore = semanticEvidenceScore(semantic);
  const ocrScore = ocrEvidenceScore(ocr, semantic);
  if (ocrScore >= semanticScore + DECISIVE_SCORE_MARGIN) {
    return Object.freeze({ selected: 'ocr', reason: 'ocr-decisive' });
  }
  if (semanticScore >= ocrScore + DECISIVE_SCORE_MARGIN) {
    return Object.freeze({
      selected: 'semantic',
      reason: 'semantic-decisive',
    });
  }
  return selectByPriority(semantic, ocr, 'priority-tie');
}

export function normalizeImageEvidenceText(value: string): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, MAX_RANKING_TEXT)
    : '';
}

export function normalizeComparableImageEvidenceText(value: string): string {
  return normalizeImageEvidenceText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function semanticEvidenceScore(evidence: RankableSemanticImageEvidence): number {
  const shape = textShape(evidence.text);
  // Shortness and repetition decide whether comparison is worthwhile; they
  // do not lower an admitted authored label's baseline credibility.
  let score = 7;
  if (shape.varied) score += 1;
  return score;
}

function ocrEvidenceScore(
  evidence: RankableOcrImageEvidence,
  semantic: RankableSemanticImageEvidence,
): number {
  const shape = textShape(evidence.result.transcript);
  const semanticShape = textShape(semantic.text);
  let score = 2;
  const confidence = evidence.result.transcriptConfidence;
  if (confidence !== undefined && Number.isFinite(confidence)) {
    const decisiveThreshold = Math.min(
      0.95,
      Math.max(0.85, evidence.minimumConfidence + 0.15),
    );
    score += confidence >= decisiveThreshold ? 4 : 2;
  }
  if (evidence.selectedQuality.corroboratedRegions > 0) score += 4;
  if (evidence.result.regions.length >= 2) score += 1;
  if (
    shape.meaningfulCharacters >= semanticShape.meaningfulCharacters + 4 ||
    shape.tokens >= semanticShape.tokens + 2
  ) score += 4;
  return score;
}

function selectByPriority(
  semantic: RankableSemanticImageEvidence,
  ocr: RankableOcrImageEvidence,
  reason: Extract<
    ImageEvidenceSelectionReason,
    'agreement-priority' | 'priority-tie'
  >,
): ImageEvidenceSelection {
  return Object.freeze({
    selected: semantic.methodIndex <= ocr.methodIndex ? 'semantic' : 'ocr',
    reason,
  });
}

function textShape(value: string): Readonly<{
  meaningfulCharacters: number;
  tokens: number;
  varied: boolean;
}> {
  const normalized = normalizeImageEvidenceText(value);
  const unique = new Set<string>();
  let meaningfulCharacters = 0;
  let tokens = 0;
  let insideToken = false;
  for (const character of normalized) {
    if (!MEANINGFUL_CHARACTER.test(character)) {
      insideToken = false;
      continue;
    }
    meaningfulCharacters += 1;
    unique.add(character.toLowerCase());
    if (!insideToken) tokens += 1;
    insideToken = true;
  }
  return Object.freeze({
    meaningfulCharacters,
    tokens,
    varied: meaningfulCharacters > 0 &&
      unique.size / meaningfulCharacters >= 0.4,
  });
}

function semanticShapeIsShort(shape: Readonly<{
  meaningfulCharacters: number;
  tokens: number;
}>): boolean {
  return shape.meaningfulCharacters <= 16 && shape.tokens <= 2;
}

function emptyRegistration(): SemanticEvidenceIndexRegistration {
  return Object.freeze({
    indexed: false,
    repeated: false,
    reevaluateNodeIds: Object.freeze([]),
  });
}

function emptyRemoval(): SemanticEvidenceIndexRemoval {
  return Object.freeze({
    removed: false,
    reevaluateNodeIds: Object.freeze([]),
  });
}

function freezeNodeIds(nodeIds: ReadonlySet<number>): readonly number[] {
  return Object.freeze([...nodeIds]);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function positiveBoundedInteger(value: number, fallback: number): number {
  return Number.isSafeInteger(value) && value > 0 && value <= fallback
    ? value
    : fallback;
}
