export const OCR_PROVIDER_VIRTUAL_MODULE_ID =
  'virtual:simul-ocr-provider-registry';
export const OCR_PROVIDER_RUNTIME_VIRTUAL_MODULE_ID =
  'virtual:simul-ocr-provider-runtime-registry';

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
  readonly runtimeImportPath?: string;
  readonly enabledByDefault?: boolean;
}

/** Providers stay independently removable from every extension entrypoint. */
export const OCR_PROVIDER_BUILD_DEFINITIONS = Object.freeze([
  {
    flag: 'SIMUL_OCR_TEXT_DETECTOR',
    id: 'chrome-text-detector',
    implemented: true,
    enabledByDefault: true,
    importPath: '/lib/ocr/providers/chrome-text-detector/index.ts',
    runtimeImportPath:
      '/lib/ocr/providers/chrome-text-detector/offscreen.ts',
  },
  {
    flag: 'SIMUL_OCR_TESSERACT',
    id: 'tesseract',
    implemented: true,
    enabledByDefault: true,
    importPath: '/lib/ocr/providers/tesseract/index.ts',
    runtimeImportPath: '/lib/ocr/providers/tesseract/offscreen.ts',
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

export function createOcrProviderRuntimeRegistryModule(
  profile: OcrBuildProfile,
): string {
  const imports: string[] = [];
  const bindings: string[] = [];
  for (const id of profile.enabledProviderIds) {
    const definition = OCR_PROVIDER_BUILD_DEFINITIONS.find(
      (candidate) => candidate.id === id && candidate.implemented,
    );
    if (!definition || !('runtimeImportPath' in definition) ||
      !definition.runtimeImportPath) {
      throw new Error(`Enabled OCR provider has no offscreen runtime: ${id}.`);
    }
    const binding = `providerRuntime${bindings.length}`;
    imports.push(
      `import ${binding} from ${JSON.stringify(definition.runtimeImportPath)};`,
    );
    bindings.push(binding);
  }
  return [
    ...imports,
    `export const compiledOcrProviderRunnerFactories = Object.freeze([${bindings.join(', ')}]);`,
  ].join('\n');
}

export function createOcrBuildProfilePlugin(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const resolvedId = `\0${OCR_PROVIDER_VIRTUAL_MODULE_ID}`;
  const runtimeResolvedId = `\0${OCR_PROVIDER_RUNTIME_VIRTUAL_MODULE_ID}`;
  const profile = readOcrBuildProfile(environment);
  const moduleSource = createOcrProviderRegistryModule(profile);
  const runtimeModuleSource = createOcrProviderRuntimeRegistryModule(profile);
  return {
    name: 'simul-ocr-build-profile',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === OCR_PROVIDER_VIRTUAL_MODULE_ID) return resolvedId;
      if (id === OCR_PROVIDER_RUNTIME_VIRTUAL_MODULE_ID) {
        return runtimeResolvedId;
      }
      return null;
    },
    load(id: string) {
      if (id === resolvedId) return moduleSource;
      if (id === runtimeResolvedId) return runtimeModuleSource;
      return null;
    },
  };
}
