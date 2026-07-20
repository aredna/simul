export const OCR_PROVIDER_VIRTUAL_MODULE_ID =
  'virtual:simul-ocr-provider-registry';

export const OCR_BUILD_FLAGS = Object.freeze([
  'SIMUL_OCR_TEXT_DETECTOR',
  'SIMUL_OCR_TESSERACT',
  'SIMUL_OCR_TRANSFORMERS',
  'SIMUL_OCR_PADDLE',
  'SIMUL_OCR_SCREEN_AI',
] as const);

export type OcrBuildFlag = (typeof OCR_BUILD_FLAGS)[number];

interface OcrProviderBuildDefinition {
  readonly flag: OcrBuildFlag;
  readonly id: string;
  readonly implemented: false;
  readonly importPath: string;
}

/** E reserves every profile switch but deliberately implements no provider. */
export const OCR_PROVIDER_BUILD_DEFINITIONS = Object.freeze([
  {
    flag: 'SIMUL_OCR_TEXT_DETECTOR',
    id: 'chrome-text-detector',
    implemented: false,
    importPath: '/lib/ocr/providers/chrome-text-detector/index.ts',
  },
  {
    flag: 'SIMUL_OCR_TESSERACT',
    id: 'tesseract',
    implemented: false,
    importPath: '/lib/ocr/providers/tesseract/index.ts',
  },
  {
    flag: 'SIMUL_OCR_TRANSFORMERS',
    id: 'transformers',
    implemented: false,
    importPath: '/lib/ocr/providers/transformers/index.ts',
  },
  {
    flag: 'SIMUL_OCR_PADDLE',
    id: 'paddleocr-wasm',
    implemented: false,
    importPath: '/lib/ocr/providers/paddleocr-wasm/index.ts',
  },
  {
    flag: 'SIMUL_OCR_SCREEN_AI',
    id: 'chromium-screen-ai',
    implemented: false,
    importPath: '/lib/ocr/providers/chromium-screen-ai/index.ts',
  },
] as const satisfies readonly OcrProviderBuildDefinition[]);

export interface OcrBuildProfile {
  readonly enabledProviderIds: readonly string[];
}

export function readOcrBuildProfile(
  environment: Readonly<Record<string, string | undefined>>,
): OcrBuildProfile {
  const enabledProviderIds: string[] = [];
  for (const definition of OCR_PROVIDER_BUILD_DEFINITIONS) {
    const value = environment[definition.flag];
    if (value === undefined || value === '0') continue;
    if (value !== '1') {
      throw new Error(
        `${definition.flag} must be exactly 0, 1, or unset; received ${JSON.stringify(value)}.`,
      );
    }
    if (!definition.implemented) {
      throw new Error(
        `${definition.flag}=1 requested ${definition.id}, but Checkpoint E contains contracts only. Implement and approve that provider in a later checkpoint before enabling it.`,
      );
    }
    enabledProviderIds.push(definition.id);
  }
  return Object.freeze({
    enabledProviderIds: Object.freeze(enabledProviderIds),
  });
}

export function createOcrProviderRegistryModule(
  profile: OcrBuildProfile,
): string {
  if (profile.enabledProviderIds.length > 0) {
    throw new Error('Checkpoint E cannot generate an enabled OCR provider registry.');
  }
  return [
    'export const compiledOcrProviderModules = Object.freeze([]);',
    'export const compiledOcrCapabilities = Object.freeze({',
    '  promptImageLanguage: false,',
    '  promptImageText: false,',
    '});',
  ].join('\n');
}

export function createOcrBuildProfilePlugin(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const resolvedId = `\0${OCR_PROVIDER_VIRTUAL_MODULE_ID}`;
  const moduleSource = createOcrProviderRegistryModule(
    readOcrBuildProfile(environment),
  );
  return {
    name: 'simul-ocr-build-profile',
    enforce: 'pre' as const,
    resolveId(id: string) {
      return id === OCR_PROVIDER_VIRTUAL_MODULE_ID ? resolvedId : null;
    },
    load(id: string) {
      return id === resolvedId ? moduleSource : null;
    },
  };
}
