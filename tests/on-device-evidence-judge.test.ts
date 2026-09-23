import { describe, expect, it, vi } from 'vitest';

import {
  EVIDENCE_JUDGE_RECHECK_MS,
  OnDeviceEvidenceJudge,
  type EvidenceJudgeKind,
  type OnDeviceAiGlobals,
} from '../lib/ocr/on-device-evidence-judge';

const input = {
  altText: 'Spring campaign banner',
  ocrText: 'SPRING SALE 50% OFF',
  sourceLanguage: 'en' as const,
  image: new Blob([new Uint8Array([1])], { type: 'image/png' }),
};

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

function fakeNano(options: {
  readonly image: Availability;
  readonly text: Availability;
  readonly answer?: string;
}) {
  const prompts: unknown[] = [];
  const destroyed = vi.fn();
  const session = {
    prompt: vi.fn(async (message: unknown, _options?: unknown) => {
      prompts.push(message);
      return options.answer ?? '{"choice":"B"}';
    }),
    clone: vi.fn(async () => session),
    destroy: destroyed,
  };
  const model = {
    availability: vi.fn(async (request: { readonly expectedInputs: readonly { readonly type: string }[] }) =>
      request.expectedInputs.some(({ type }) => type === 'image')
        ? options.image
        : options.text),
    create: vi.fn(async () => session),
  };
  return { model, session, prompts, destroyed };
}

function fakeDetector(
  availability: Availability,
  results: readonly { detectedLanguage: string; confidence: number }[] = [],
) {
  return {
    availability: vi.fn(async () => availability),
    create: vi.fn(async () => ({ detect: vi.fn(async () => results) })),
  };
}

function judgeWith(globals: OnDeviceAiGlobals, now = () => 0) {
  const kinds: EvidenceJudgeKind[] = [];
  const judge = new OnDeviceEvidenceJudge({
    globals,
    now,
    onResolved: (kind) => kinds.push(kind),
  });
  return { judge, kinds };
}

describe('OnDeviceEvidenceJudge', () => {
  it('never creates a model that is not already installed', async () => {
    for (const state of ['downloadable', 'downloading', 'unavailable'] as const) {
      const nano = fakeNano({ image: state, text: state });
      const detector = fakeDetector(state);
      const { judge, kinds } = judgeWith({
        LanguageModel: nano.model,
        LanguageDetector: detector,
      });
      expect(await judge.judge(input)).toBeUndefined();
      expect(nano.model.create).not.toHaveBeenCalled();
      expect(detector.create).not.toHaveBeenCalled();
      expect(kinds).toEqual(['none']);
    }
  });

  it('shows Gemini Nano the picture and follows its structured choice', async () => {
    const nano = fakeNano({ image: 'available', text: 'available' });
    const { judge, kinds } = judgeWith({ LanguageModel: nano.model });

    expect(await judge.judge(input)).toEqual({ selected: 'ocr', method: 'nano-judge' });
    expect(kinds).toEqual(['nano-image']);
    expect(nano.model.create).toHaveBeenCalledOnce();
    const [message] = nano.prompts as [{ content: { type: string }[] }[]];
    expect(message[0]!.content.map(({ type }) => type)).toEqual(['image', 'text']);
    expect(nano.session.prompt.mock.calls[0]![1]).toMatchObject({
      responseConstraint: { properties: { choice: { enum: ['A', 'B', 'either'] } } },
    });
    // Each judgment runs in a fresh clone that is released afterwards.
    expect(nano.destroyed).toHaveBeenCalledOnce();

    for (const [answer, expected] of [
      ['{"choice":"A"}', { selected: 'semantic', method: 'nano-judge' }],
      ['{"choice":"either"}', undefined],
      ['not json', undefined],
    ] as const) {
      const other = fakeNano({ image: 'available', text: 'available', answer });
      expect(await judgeWith({ LanguageModel: other.model }).judge.judge(input))
        .toEqual(expected);
    }
  });

  it('asks a text-only Nano without the picture', async () => {
    const nano = fakeNano({ image: 'downloadable', text: 'available' });
    const { judge, kinds } = judgeWith({ LanguageModel: nano.model });
    expect(await judge.judge(input)).toEqual({ selected: 'ocr', method: 'nano-judge' });
    expect(kinds).toEqual(['nano-text']);
    const [message] = nano.prompts as [{ content: { type: string }[] }[]];
    expect(message[0]!.content.map(({ type }) => type)).toEqual(['text']);
  });

  it('prefers confident same-language OCR with the Language Detector', async () => {
    const cases = [
      [[{ detectedLanguage: 'en', confidence: 0.92 }], { selected: 'ocr', method: 'language-check' }],
      [[{ detectedLanguage: 'fr', confidence: 0.9 }], { selected: 'semantic', method: 'language-check' }],
      [[{ detectedLanguage: 'en', confidence: 0.1 }], { selected: 'semantic', method: 'language-check' }],
      [[{ detectedLanguage: 'en', confidence: 0.5 }], undefined],
    ] as const;
    for (const [results, expected] of cases) {
      const { judge, kinds } = judgeWith({
        LanguageModel: fakeNano({ image: 'downloadable', text: 'downloadable' }).model,
        LanguageDetector: fakeDetector('available', results),
      });
      expect(await judge.judge(input)).toEqual(expected);
      expect(kinds).toEqual(['language-detector']);
    }
  });

  it('checks again later when no model was installed', async () => {
    let now = 0;
    const nano = fakeNano({ image: 'downloadable', text: 'downloadable' });
    const { judge, kinds } = judgeWith({ LanguageModel: nano.model }, () => now);
    await judge.judge(input);
    await judge.judge(input);
    expect(nano.model.availability).toHaveBeenCalledTimes(2);
    now = EVIDENCE_JUDGE_RECHECK_MS;
    await judge.judge(input);
    expect(nano.model.availability).toHaveBeenCalledTimes(4);
    expect(kinds).toEqual(['none', 'none']);
  });

  it('propagates cancellation and skips empty candidates', async () => {
    const nano = fakeNano({ image: 'available', text: 'available' });
    const { judge } = judgeWith({ LanguageModel: nano.model });
    const controller = new AbortController();
    controller.abort();
    await expect(judge.judge(input, controller.signal)).rejects.toThrow();
    expect(await judge.judge({ ...input, ocrText: '   ' })).toBeUndefined();
    expect(nano.session.prompt).not.toHaveBeenCalled();
  });
});
