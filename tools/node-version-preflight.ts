/**
 * Test-runtime preflight: the vendored pdf.js 6.3 uses Promise.try, which
 * Node 22 lacks, so the PDF tests fail as cryptic timeouts on the wrong
 * runtime. Vitest runs this before collecting tests (O6).
 */
export const REQUIRED_NODE_MAJOR = 24;

export function assertSupportedNodeVersion(
  version: string = process.version,
): void {
  const match = /^v?(\d+)(?:\.|$)/u.exec(version.trim());
  const major = match?.[1] === undefined ? undefined : Number(match[1]);
  if (major === REQUIRED_NODE_MAJOR) return;
  throw new Error(
    `Simul's test suite needs Node ${REQUIRED_NODE_MAJOR}.x because the ` +
      `vendored pdf.js uses Promise.try; this run is ${version}. ` +
      `Start it with the project's Node ${REQUIRED_NODE_MAJOR} runtime, for example: ` +
      'export PATH="$HOME/.local/node24/node-v24.18.0-linux-x64/bin:$PATH"',
  );
}

export default function nodeVersionPreflight(): void {
  assertSupportedNodeVersion();
}