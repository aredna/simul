import { describe, expect, it } from 'vitest';

import {
  OCR_BUILD_FLAGS,
  OCR_PROVIDER_BUILD_DEFINITIONS,
  createOcrProviderRegistryModule,
  readOcrBuildProfile,
} from '../tools/ocr-build-profile';

describe('OCR build profile', () => {
  it('defaults every provider off and emits an import-free empty registry', () => {
    const profile = readOcrBuildProfile({});
    const source = createOcrProviderRegistryModule(profile);

    expect(profile.enabledProviderIds).toEqual([]);
    expect(source).toContain('compiledOcrProviderModules = Object.freeze([])');
    for (const definition of OCR_PROVIDER_BUILD_DEFINITIONS) {
      expect(source).not.toContain(definition.importPath);
    }
  });

  it.each(OCR_BUILD_FLAGS)('fails clearly when unimplemented %s is enabled', (flag) => {
    expect(() => readOcrBuildProfile({ [flag]: '1' })).toThrow(
      /Checkpoint E contains contracts only/u,
    );
  });

  it('accepts only exact zero, one, or an absent flag', () => {
    expect(readOcrBuildProfile({ SIMUL_OCR_TESSERACT: '0' })).toEqual({
      enabledProviderIds: [],
    });
    expect(() => readOcrBuildProfile({
      SIMUL_OCR_TESSERACT: 'true',
    })).toThrow(/exactly 0, 1, or unset/u);
    expect(() => readOcrBuildProfile({
      SIMUL_OCR_TESSERACT: '',
    })).toThrow(/exactly 0, 1, or unset/u);
  });
});
