import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import {
  ISOLATED_HTML_LIMITED_QUIRKS_SHELL,
  ISOLATED_HTML_QUIRKS_SHELL,
  ISOLATED_HTML_SHELL,
} from '../lib/replica/isolated-html-engine';
import {
  installDefaultScriptUrlPolicy,
  ownScriptUrl,
  trustedShellHtml,
  type TrustedTypesScope,
} from '../lib/trusted-types';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

type Rules = {
  createHTML?: (input: string) => string;
  createScriptURL?: (input: string) => string;
};

function fakeTrustedTypes() {
  const policies = new Map<string, Rules>();
  return {
    policies,
    createPolicy: vi.fn((name: string, rules: Rules) => {
      if (policies.has(name)) throw new TypeError(`Policy ${name} exists.`);
      policies.set(name, rules);
      return {
        createHTML: (input: string) => ({ trusted: rules.createHTML!(input) }),
      };
    }),
  };
}

describe('Trusted Types policies (D161)', () => {
  it('turns the three mirror shells, and nothing else, into HTML', () => {
    const trustedTypes = fakeTrustedTypes();
    const scope = { trustedTypes, location: { href: `${ORIGIN}/sidepanel.html` } };
    for (const shell of [
      ISOLATED_HTML_SHELL,
      ISOLATED_HTML_QUIRKS_SHELL,
      ISOLATED_HTML_LIMITED_QUIRKS_SHELL,
    ]) {
      expect(trustedShellHtml(shell, scope)).toEqual({ trusted: shell });
    }
    expect(trustedTypes.createPolicy).toHaveBeenCalledTimes(1);
    expect(trustedTypes.createPolicy.mock.calls[0]![0]).toBe('simul-mirror-shell');
    expect(() => trustedShellHtml('<img src=x onerror=alert(1)>', scope))
      .toThrow(/registered mirror shell/u);
    // The policy itself refuses too, if it is reached some other way.
    const rules = trustedTypes.policies.get('simul-mirror-shell')!;
    expect(() => rules.createHTML!(`${ISOLATED_HTML_SHELL}<script>`)).toThrow();
  });

  it('hands the plain shell back where there are no Trusted Types', () => {
    expect(trustedShellHtml(ISOLATED_HTML_SHELL, {})).toBe(ISOLATED_HTML_SHELL);
    expect(() => trustedShellHtml('<p>page text</p>', {})).toThrow();
  });

  it('lets only the extension\'s own files through as script URLs', () => {
    const base = `${ORIGIN}/sidepanel.html`;
    expect(ownScriptUrl(`${ORIGIN}/pdfjs/simul-worker.mjs`, base))
      .toBe(`${ORIGIN}/pdfjs/simul-worker.mjs`);
    expect(ownScriptUrl('/ocr/tesseract/worker/simul-worker.js', base))
      .toBe('/ocr/tesseract/worker/simul-worker.js');
    expect(() => ownScriptUrl('https://cdn.example.com/pdf.worker.mjs', base))
      .toThrow(/outside the extension/u);
    expect(() => ownScriptUrl('chrome-extension://otherextensionidotherextensio/x.js', base))
      .toThrow(/outside the extension/u);
    expect(() => ownScriptUrl('blob:https://example.com/1234', base)).toThrow();
    expect(() => ownScriptUrl('data:text/javascript,alert(1)', base)).toThrow();
  });

  it('creates the default policy once, and nothing without Trusted Types', () => {
    const trustedTypes = fakeTrustedTypes();
    const scope = {
      trustedTypes,
      location: { href: `${ORIGIN}/offscreen.html` },
    } as unknown as TrustedTypesScope;
    expect(installDefaultScriptUrlPolicy(scope)).toBe(true);
    expect(installDefaultScriptUrlPolicy(scope)).toBe(false);
    const rules = trustedTypes.policies.get('default')!;
    expect(rules.createHTML).toBeUndefined();
    expect(rules.createScriptURL!(`${ORIGIN}/ocr/tesseract/worker/simul-worker.js`))
      .toBe(`${ORIGIN}/ocr/tesseract/worker/simul-worker.js`);
    expect(() => rules.createScriptURL!('https://example.com/a.js')).toThrow();
    expect(installDefaultScriptUrlPolicy({ location: { href: ORIGIN } })).toBe(false);
  });

  it('starts the OCR worker with the default policy, then tesseract.js', () => {
    const source = readFileSync(
      new URL('../vendor/ocr/tesseract/worker/simul-worker.js', import.meta.url),
      'utf8',
    );
    expect(source).toBe(readFileSync(
      new URL('../tools/tesseract-simul-worker.js', import.meta.url),
      'utf8',
    ));
    const trustedTypes = fakeTrustedTypes();
    const imported: string[] = [];
    const self = {
      trustedTypes,
      location: { href: `${ORIGIN}/ocr/tesseract/worker/simul-worker.js`, origin: ORIGIN },
    };
    runInNewContext(source, {
      self,
      URL,
      TypeError,
      importScripts: (url: string) => {
        // Chrome asks the default policy for every string here.
        imported.push(trustedTypes.policies.get('default')!.createScriptURL!(url));
      },
    });
    expect(imported).toEqual(['worker.min.js']);
    const rules = trustedTypes.policies.get('default')!;
    expect(rules.createScriptURL!(`${ORIGIN}/ocr/tesseract/core/tesseract-core-simd-lstm.wasm.js`))
      .toContain('tesseract-core-simd-lstm');
    expect(() => rules.createScriptURL!('https://cdn.jsdelivr.net/npm/tesseract.js-core@7/x.js'))
      .toThrow(/outside the extension/u);
  });
});
