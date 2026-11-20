/**
 * Trusted Types for Simul's own pages and workers (D161).
 *
 * The extension pages' CSP has `require-trusted-types-for 'script'`, so the
 * browser takes no plain string where the string would become HTML or a
 * script URL. Simul needs two exceptions, each a named policy:
 *
 * - `simul-mirror-shell` turns the mirror's constant shell documents into
 *   HTML, and nothing else: a shell must be registered first, and only a
 *   registered string passes.
 * - `default` lets a script URL through only when it is a file of this
 *   extension. pdf.js and tesseract.js start their workers from URL strings,
 *   and tesseract's worker loads its engine with `importScripts(string)`;
 *   neither library can be given a TrustedScriptURL, so the browser asks the
 *   default policy. A URL of any other origin is refused (and reported).
 *
 * Where the browser has no Trusted Types (tests, older engines) the helpers
 * hand the plain string back.
 */

export const MIRROR_SHELL_POLICY_NAME = 'simul-mirror-shell';
export const DEFAULT_POLICY_NAME = 'default';

interface TrustedTypePolicyLike {
  createHTML?(input: string): unknown;
}

interface TrustedTypePolicyRules {
  createHTML?: (input: string) => string;
  createScriptURL?: (input: string) => string;
}

export interface TrustedTypesScope {
  readonly trustedTypes?: {
    createPolicy(name: string, rules: TrustedTypePolicyRules): TrustedTypePolicyLike;
  };
  readonly location: { readonly href: string };
}

const registeredShells = new Set<string>();
let shellPolicy: TrustedTypePolicyLike | undefined;

/** Allows these exact strings, and only these, as mirror shell HTML. */
export function registerTrustedShells(...shells: readonly string[]): void {
  for (const shell of shells) registeredShells.add(shell);
}

/**
 * The shell as TrustedHTML where Trusted Types exist (typed as a string,
 * which is what `srcdoc` and `document.write` are declared to take).
 */
export function trustedShellHtml(
  shell: string,
  scope: Partial<TrustedTypesScope> = globalThis as Partial<TrustedTypesScope>,
): string {
  if (!registeredShells.has(shell)) {
    throw new TypeError('Only a registered mirror shell can become HTML.');
  }
  const trustedTypes = scope.trustedTypes;
  if (!trustedTypes) return shell;
  shellPolicy ??= trustedTypes.createPolicy(MIRROR_SHELL_POLICY_NAME, {
    createHTML: (input) => {
      if (!registeredShells.has(input)) {
        throw new TypeError('Only a registered mirror shell can become HTML.');
      }
      return input;
    },
  });
  return shellPolicy.createHTML!(shell) as string;
}

/** The URL itself when it resolves to this extension's own origin. */
export function ownScriptUrl(input: string, base: string): string {
  // Protocol and host, not `origin`: URL gives non-web schemes such as
  // chrome-extension: the origin "null" outside Chrome.
  const own = new URL(base);
  let url: URL;
  try {
    url = new URL(input, base);
  } catch {
    throw new TypeError('A script URL Simul cannot read was refused.');
  }
  if (url.protocol !== own.protocol || url.host !== own.host || url.host === '') {
    throw new TypeError(
      `A script URL outside the extension was refused: ${url.protocol}//${url.host}`,
    );
  }
  return input;
}

/**
 * Creates the `default` policy for script URLs in this page or worker. Returns
 * false where there are no Trusted Types or the policy exists already.
 */
export function installDefaultScriptUrlPolicy(
  scope: TrustedTypesScope = globalThis as unknown as TrustedTypesScope,
): boolean {
  const trustedTypes = scope.trustedTypes;
  if (!trustedTypes) return false;
  try {
    trustedTypes.createPolicy(DEFAULT_POLICY_NAME, {
      createScriptURL: (input) => ownScriptUrl(input, scope.location.href),
    });
    return true;
  } catch {
    return false;
  }
}
