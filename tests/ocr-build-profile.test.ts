import { access } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OCR_BUILD_FLAGS,
  OCR_PROVIDER_BUILD_DEFINITIONS,
  createOcrProviderRegistryModule,
  createOcrProviderRuntimeRegistryModule,
  readOcrBuildProfile,
} from '../tools/ocr-build-profile';

describe('OCR build profile', () => {
  it('enables the small platform adapter before packaged Tesseract by default', () => {
    const profile = readOcrBuildProfile({});
    const source = createOcrProviderRegistryModule(profile);
    const runtimeSource = createOcrProviderRuntimeRegistryModule(profile);

    expect(profile.enabledProviderIds).toEqual([
      'chrome-text-detector',
      'tesseract',
    ]);
    expect(source).toContain(
      '/lib/ocr/providers/chrome-text-detector/index.ts',
    );
    expect(source).toContain('/lib/ocr/providers/tesseract/index.ts');
    expect(source).toContain(
      'compiledOcrProviderModules = Object.freeze([provider0, provider1])',
    );
    expect(runtimeSource).toContain(
      '/lib/ocr/providers/chrome-text-detector/offscreen.ts',
    );
    expect(runtimeSource).toContain(
      '/lib/ocr/providers/tesseract/offscreen.ts',
    );
    for (const definition of OCR_PROVIDER_BUILD_DEFINITIONS) {
      if (
        definition.id !== 'tesseract' &&
        definition.id !== 'chrome-text-detector'
      ) {
        expect(source).not.toContain(definition.importPath);
      }
    }
  });

  it.each(OCR_BUILD_FLAGS.filter((flag) =>
    flag !== 'SIMUL_OCR_TESSERACT' && flag !== 'SIMUL_OCR_TEXT_DETECTOR',
  ))(
    'fails clearly when unimplemented %s is enabled',
    (flag) => {
      expect(() => readOcrBuildProfile({
        SIMUL_OCR_TEXT_DETECTOR: '0',
        SIMUL_OCR_TESSERACT: '0',
        [flag]: '1',
      })).toThrow(/not implemented in this build/u);
    },
  );

  it('accepts only exact zero, one, or an absent flag', () => {
    expect(readOcrBuildProfile({
      SIMUL_OCR_TEXT_DETECTOR: '0',
      SIMUL_OCR_TESSERACT: '0',
    })).toEqual({
      enabledProviderIds: [],
    });
    expect(readOcrBuildProfile({
      SIMUL_OCR_TEXT_DETECTOR: '0',
      SIMUL_OCR_TESSERACT: '1',
    })).toEqual({
      enabledProviderIds: ['tesseract'],
    });
    expect(() => readOcrBuildProfile({
      SIMUL_OCR_TEXT_DETECTOR: '0',
      SIMUL_OCR_TESSERACT: 'true',
    })).toThrow(/exactly 0, 1, or unset/u);
    expect(() => readOcrBuildProfile({
      SIMUL_OCR_TEXT_DETECTOR: '0',
      SIMUL_OCR_TESSERACT: '',
    })).toThrow(/exactly 0, 1, or unset/u);
  });

  it('can compile TextDetector without Tesseract or provider assets', () => {
    const profile = readOcrBuildProfile({
      SIMUL_OCR_TEXT_DETECTOR: '1',
      SIMUL_OCR_TESSERACT: '0',
    });
    expect(profile.enabledProviderIds).toEqual(['chrome-text-detector']);
    expect(createOcrProviderRuntimeRegistryModule(profile)).toContain(
      'chrome-text-detector/offscreen.ts',
    );
    expect(createOcrProviderRuntimeRegistryModule(profile)).not.toContain(
      'tesseract/offscreen.ts',
    );
  });

  it('keeps every stable provider behind its own source module seam', async () => {
    await expect(Promise.all(
      OCR_PROVIDER_BUILD_DEFINITIONS.map((definition) =>
        access(path.resolve(`.${definition.importPath}`)),
      ),
    )).resolves.toEqual(OCR_PROVIDER_BUILD_DEFINITIONS.map(() => undefined));
  });
});
