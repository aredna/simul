import { describe, expect, it } from 'vitest';

import {
  OCR_BUILD_FLAGS,
  OCR_PROVIDER_BUILD_DEFINITIONS,
  createOcrProviderRegistryModule,
  readOcrBuildProfile,
} from '../tools/ocr-build-profile';

describe('OCR build profile', () => {
  it('enables only packaged Tesseract by default and emits its one import', () => {
    const profile = readOcrBuildProfile({});
    const source = createOcrProviderRegistryModule(profile);

    expect(profile.enabledProviderIds).toEqual(['tesseract']);
    expect(source).toContain('/lib/ocr/providers/tesseract/index.ts');
    expect(source).toContain('compiledOcrProviderModules = Object.freeze([provider0])');
    for (const definition of OCR_PROVIDER_BUILD_DEFINITIONS) {
      if (definition.id !== 'tesseract') {
        expect(source).not.toContain(definition.importPath);
      }
    }
  });

  it.each(OCR_BUILD_FLAGS.filter((flag) => flag !== 'SIMUL_OCR_TESSERACT'))(
    'fails clearly when unimplemented %s is enabled',
    (flag) => {
      expect(() => readOcrBuildProfile({
        SIMUL_OCR_TESSERACT: '0',
        [flag]: '1',
      })).toThrow(/not implemented in this build/u);
    },
  );

  it('accepts only exact zero, one, or an absent flag', () => {
    expect(readOcrBuildProfile({ SIMUL_OCR_TESSERACT: '0' })).toEqual({
      enabledProviderIds: [],
    });
    expect(readOcrBuildProfile({ SIMUL_OCR_TESSERACT: '1' })).toEqual({
      enabledProviderIds: ['tesseract'],
    });
    expect(() => readOcrBuildProfile({
      SIMUL_OCR_TESSERACT: 'true',
    })).toThrow(/exactly 0, 1, or unset/u);
    expect(() => readOcrBuildProfile({
      SIMUL_OCR_TESSERACT: '',
    })).toThrow(/exactly 0, 1, or unset/u);
  });
});
