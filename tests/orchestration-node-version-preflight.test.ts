import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertSupportedNodeVersion,
  REQUIRED_NODE_MAJOR,
} from '../tools/node-version-preflight';

describe('Node version preflight (O6)', () => {
  it('accepts the supported major on either version spelling', () => {
    expect(() => assertSupportedNodeVersion('v24.18.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion('24.0.0')).not.toThrow();
    expect(() => assertSupportedNodeVersion(`v${REQUIRED_NODE_MAJOR}.1.2`))
      .not.toThrow();
  });

  it('rejects another major with the runtime and the reason', () => {
    let error: unknown;
    try {
      assertSupportedNodeVersion('v22.22.1');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Node 24');
    expect((error as Error).message).toContain('v22.22.1');
    expect((error as Error).message).toContain('Promise.try');
    expect(() => assertSupportedNodeVersion('v23.11.0')).toThrow(/Node 24/u);
    expect(() => assertSupportedNodeVersion('v20.19.0')).toThrow(/Node 24/u);
  });

  it('lets this runtime through before test collection', () => {
    expect(() => assertSupportedNodeVersion()).not.toThrow();
  });

  it('is wired into the vitest run as its global setup', () => {
    const config = readFileSync(
      new URL('../vitest.config.ts', import.meta.url),
      'utf8',
    );
    expect(config).toContain(
      "globalSetup: ['./tools/node-version-preflight.ts']",
    );
  });
});