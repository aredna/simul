/**
 * Simul ships as two editions from one code base. The public edition is what
 * the release zips and the Chrome Web Store carry: the options anybody needs,
 * with the tuning settings pinned to their defaults. The dev edition keeps
 * every option for the owner's own testing.
 *
 * The build picks the edition from `SIMUL_EDITION` (wxt.config.ts) and
 * replaces `__SIMUL_EDITION__` with it, so the bundler can drop code that
 * only the other edition reaches. Logic that differs by edition takes the
 * edition as a parameter; only entrypoints and default parameters read the
 * build constant below.
 */
export const SIMUL_EDITIONS = Object.freeze(['public', 'dev'] as const);

export type SimulEdition = (typeof SIMUL_EDITIONS)[number];

/** Anything other than exactly `dev` is the public edition. */
export function parseSimulEdition(value: unknown): SimulEdition {
  return typeof value === 'string' && value.trim().toLowerCase() === 'dev'
    ? 'dev'
    : 'public';
}

declare const __SIMUL_EDITION__: string | undefined;

/**
 * The edition this bundle was built as. A bundle built without the define
 * (which the build never does) is the public edition, never the dev one.
 */
export const SIMUL_EDITION: SimulEdition =
  typeof __SIMUL_EDITION__ !== 'undefined' && __SIMUL_EDITION__ === 'dev'
    ? 'dev'
    : 'public';

export const IS_DEV_EDITION: boolean = SIMUL_EDITION === 'dev';
