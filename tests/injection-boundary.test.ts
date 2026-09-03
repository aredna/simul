import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  invokeLivePageObserverBridge,
  invokeLivePageObserverUnregisterBridge,
} from '../lib/live-page-mirror';
import { capturePageSnapshot } from '../lib/page-snapshot';

/**
 * Chrome serializes a function passed to scripting.executeScript({ func })
 * with Function.prototype.toString and evaluates only that text in the page.
 * Anything the body reaches from module scope (an import, a shared helper, a
 * constant) is undefined there. The shipped 0.3.0 scroll regression was
 * exactly this: the observer's scroll handler called helpers imported from
 * primary-scroll.ts, which became minified free identifiers in the page.
 *
 * These tests re-create the boundary: the serialized source is compiled in a
 * scope where every free identifier resolves against the real global object
 * or throws a ReferenceError, and then exercised.
 */
const INJECTED_BY_REFERENCE: ReadonlyArray<readonly [string, (...args: never[]) => unknown]> = [
  ['capturePageSnapshot', capturePageSnapshot],
  ['invokeLivePageObserverBridge', invokeLivePageObserverBridge],
  ['invokeLivePageObserverUnregisterBridge', invokeLivePageObserverUnregisterBridge],
];

function compileAtInjectionBoundary<T extends (...args: never[]) => unknown>(
  fn: T,
): T {
  const source = fn.toString();
  const boundary = new Proxy(Object.create(null) as Record<string, unknown>, {
    has: () => true,
    get: (_target, name) => {
      if (typeof name !== 'string') return undefined;
      if (name === 'globalThis') return globalThis;
      if (name in globalThis) return (globalThis as Record<string, unknown>)[name];
      throw new ReferenceError(
        `${name} is not defined at the injection boundary; the injected function must be closure-free`,
      );
    },
  });
  // The with-statement routes every free identifier through the proxy.
  const factory = new Function('scope', `with (scope) { return (${source}); }`) as (
    scope: unknown,
  ) => T;
  return factory(boundary);
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (
    globalThis as typeof globalThis & { __simulLivePageObserverBridgeV2?: unknown }
  ).__simulLivePageObserverBridgeV2;
});

describe('functions injected by reference are closure-free', () => {
  it.each(INJECTED_BY_REFERENCE)('%s serializes without module-scope references', (_name, fn) => {
    const source = fn.toString();
    // Bundled helpers, imports and enums would appear as identifiers that do
    // not exist in the page. A quick structural check before the runtime one.
    expect(source).not.toMatch(/\bimport\(/u);
    expect(source).not.toMatch(/\brequire\(/u);
    expect(() => compileAtInjectionBoundary(fn)).not.toThrow();
  });

  it('capturePageSnapshot runs end to end at the boundary', () => {
    const { document, window } = parseHTML(
      '<html lang="ja"><head><title>Test</title></head><body><main><p>Injected capture text</p></main></body></html>',
    );
    Object.defineProperty(document, 'baseURI', { value: 'https://example.com/page' });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new URL('https://example.com/page'),
    });
    Object.defineProperty(window.Element.prototype, 'getClientRects', {
      configurable: true,
      value: () => [{ width: 10, height: 10 }],
    });
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: () => ({ getPropertyValue: () => '' , display: 'block', visibility: 'visible' }),
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    vi.stubGlobal('Node', window.Node);
    vi.stubGlobal('Element', window.Element);
    vi.stubGlobal('HTMLElement', window.HTMLElement);
    vi.stubGlobal('HTMLImageElement', window.HTMLImageElement);
    vi.stubGlobal('Text', window.Text);

    const boundaryCapture = compileAtInjectionBoundary(capturePageSnapshot);
    const snapshot = boundaryCapture();

    expect(snapshot).toBeDefined();
    expect(JSON.stringify(snapshot)).toContain('Injected capture text');
  });

  it('the observer invokers resolve the bridge only through the page global', () => {
    const invoke = compileAtInjectionBoundary(invokeLivePageObserverBridge);
    const unregister = compileAtInjectionBoundary(invokeLivePageObserverUnregisterBridge);

    expect(invoke('session_1234', 1)).toBeUndefined();
    expect(unregister('session_1234')).toBe(false);

    const install = vi.fn(() => ({ installed: true, generation: 1, sequence: 0 }));
    const remove = vi.fn(() => true);
    (globalThis as typeof globalThis & {
      __simulLivePageObserverBridgeV2?: unknown;
    }).__simulLivePageObserverBridgeV2 = {
      implementationRevision: 2,
      install,
      unregister: remove,
    };

    expect(invoke('session_1234', 3)).toEqual({ installed: true, generation: 1, sequence: 0 });
    expect(install).toHaveBeenCalledWith('session_1234', 3);
    expect(unregister('session_1234')).toBe(true);
  });
});
