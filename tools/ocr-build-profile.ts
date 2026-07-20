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
  readonly implemented: boolean;
  readonly importPath: string;
  readonly enabledByDefault?: boolean;
}

/** Providers stay independently removable; F enables only local Tesseract. */
export const OCR_PROVIDER_BUILD_DEFINITIONS = Object.freeze([
  {
    flag: 'SIMUL_OCR_TEXT_DETECTOR',
    id: 'chrome-text-detector',
    implemented: false,
    enabledByDefault: false,
    importPath: '/lib/ocr/providers/chrome-text-detector/index.ts',
  },
  {
    flag: 'SIMUL_OCR_TESSERACT',
    id: 'tesseract',
    implemented: true,
    enabledByDefault: true,
    importPath: '/lib/ocr/providers/tesseract/index.ts',
  },
  {
    flag: 'SIMUL_OCR_TRANSFORMERS',
    id: 'transformers',
    implemented: false,
    enabledByDefault: false,
    importPath: '/lib/ocr/providers/transformers/index.ts',
  },
  {
    flag: 'SIMUL_OCR_PADDLE',
    id: 'paddleocr-wasm',
    implemented: false,
    enabledByDefault: false,
    importPath: '/lib/ocr/providers/paddleocr-wasm/index.ts',
  },
  {
    flag: 'SIMUL_OCR_SCREEN_AI',
    id: 'chromium-screen-ai',
    implemented: false,
    enabledByDefault: false,
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
    if (value === '0' || (value === undefined && !definition.enabledByDefault)) {
      continue;
    }
    if (value === undefined && definition.enabledByDefault) {
      enabledProviderIds.push(definition.id);
      continue;
    }
    if (value !== '1') {
      throw new Error(
        `${definition.flag} must be exactly 0, 1, or unset; received ${JSON.stringify(value)}.`,
      );
    }
    if (!definition.implemented) {
      throw new Error(
        `${definition.flag}=1 requested ${definition.id}, but that provider is not implemented in this build.`,
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
  const imports: string[] = [];
  const bindings: string[] = [];
  for (const id of profile.enabledProviderIds) {
    const definition = OCR_PROVIDER_BUILD_DEFINITIONS.find(
      (candidate) => candidate.id === id && candidate.implemented,
    );
    if (!definition) throw new Error(`Unknown enabled OCR provider: ${id}.`);
    const binding = `provider${bindings.length}`;
    imports.push(`import ${binding} from ${JSON.stringify(definition.importPath)};`);
    bindings.push(binding);
  }
  return [
    ...imports,
    `export const compiledOcrProviderModules = Object.freeze([${bindings.join(', ')}]);`,
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
