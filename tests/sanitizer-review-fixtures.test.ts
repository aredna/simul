import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  readHtmlMirrorNode,
  sanitizeCss,
  sanitizeSourceAttributes,
  type HtmlMirrorNamespace,
} from '../lib/replica/html-mirror-sanitizer';

/** A transported element as the source writer would send it. */
function node(
  tagName: string,
  attributes: readonly (readonly [string, string])[],
  children: unknown[] = [],
  namespace: HtmlMirrorNamespace = 'html',
): unknown {
  return {
    kind: 'element',
    id: 1,
    namespace,
    tagName,
    attributes,
    children,
  };
}

function readTransported(
  input: unknown,
  fidelityPolicy: 'passive' | 'conservative' = 'conservative',
): unknown {
  return readHtmlMirrorNode(
    input,
    new Set(),
    0,
    undefined,
    false,
    false,
    false,
    false,
    false,
    fidelityPolicy,
  );
}

describe('receiver referrer and privacy token attributes (R2)', () => {
  it('refuses a transported per-element referrer policy on every element', () => {
    for (const fidelityPolicy of ['passive', 'conservative'] as const) {
      for (const tagName of ['img', 'link', 'iframe', 'div', 'a']) {
        const attributes: Array<readonly [string, string]> = [
          ['referrerpolicy', 'unsafe-url'],
        ];
        if (tagName === 'img') attributes.push(['src', 'https://example.test/a.png']);
        if (tagName === 'link') {
          attributes.push(['rel', 'stylesheet'], ['href', 'https://example.test/a.css']);
        }
        expect(readTransported(node(tagName, attributes), fidelityPolicy), tagName)
          .toBeUndefined();
      }
      expect(readTransported(node('img', [
        ['src', 'https://example.test/a.png'],
        ['privatetoken', 'abc'],
      ]), fidelityPolicy)).toBeUndefined();
    }
    // Without them the element travels as before.
    expect(readTransported(node('img', [
      ['src', 'https://example.test/a.png'],
      ['loading', 'lazy'],
    ]))).toBeDefined();
  });

  it('strips them from the source attributes the writer sends', () => {
    const { document } = parseHTML(
      '<!doctype html><html><body>' +
      '<img id="picture" src="https://cdn.example.test/a.png" ' +
      'referrerpolicy="unsafe-url" privatetoken="secret">' +
      '<div id="plain" referrerpolicy="origin">text</div>' +
      '</body></html>',
    );
    Object.defineProperty(document, 'baseURI', {
      configurable: true,
      value: 'https://example.test/page',
    });
    for (const id of ['picture', 'plain']) {
      const attributes = sanitizeSourceAttributes(
        document.querySelector(`#${id}`)!,
        'https://example.test/page',
        undefined,
        'passive',
      );
      const names = attributes?.map(([name]) => name) ?? [];
      expect(names, id).not.toContain('referrerpolicy');
      expect(names, id).not.toContain('privatetoken');
    }
  });
});

describe('receiver CSS url token boundaries (R4)', () => {
  it('never makes a live request of an unquoted url holding a space', () => {
    expect(sanitizeCss(
      'a{background:url(foo bar)}',
      'https://page.example/',
    )).toBeUndefined();
    expect(sanitizeCss(
      'a{background:url(foo\tbar)}',
      'https://page.example/',
    )).toBeUndefined();
    // Quoted strings may hold the space; they are still rewritten.
    expect(sanitizeCss(
      'a{background:url("foo bar")}',
      'https://page.example/',
    )).toBe('a{background:url("https://page.example/foo%20bar")}');
  });

  it('does not read a no-break space as the space before url( ', () => {
    const css = 'a{background:url\u00A0(https://evil.example/t.png)}';
    // The browser reads no url() token here: the text is left as it is, not
    // rewritten into a token the replica would fetch.
    expect(sanitizeCss(css, 'https://page.example/')).toBe(css);
  });

  it('does not read ASCII whitespace before url( as part of the function', () => {
    for (const space of [' ', '\t', '\n', '\r', '\f']) {
      const css = `a{background:url${space}(https://evil.example/t.png)}`;
      // CSS has no `url (` token: leave it inert instead of rewriting it into
      // one the replica would fetch.
      expect(sanitizeCss(css, 'https://page.example/')).toBe(css);
    }
  });

  it('keeps a hexadecimal escape and its terminating space in an unquoted url', () => {
    expect(sanitizeCss(
      String.raw`.filtered{filter:url(\23 brand-filter)}`,
      'https://page.example/',
    )).toBe('.filtered{filter:url("#brand-filter")}');
  });
});

describe('receiver @import token boundaries (R4)', () => {
  it('does not read whitespace between @ and import as an at-rule', () => {
    for (const space of [' ', '\t', '\n', '\r', '\f', '\u00A0']) {
      const css = `@${space}import "https://x.example/a.css";`;
      // CSS tokenizes `@ import` as a delim and an identifier, not an
      // at-keyword: neither normalizing nor stripping it is faithful.
      expect(sanitizeCss(css, 'https://page.example/', false, undefined, 'passive'))
        .toBe(css);
      expect(sanitizeCss(css, 'https://page.example/', false, undefined, 'conservative'))
        .toBe(css);
    }
  });

  it('does not join a comment inside an import name into a live import', () => {
    for (const [css, inert] of [
      ['@/**/import "https://x.example/a.css";', '@ import "https://x.example/a.css";'],
      ['@im/**/port "https://x.example/a.css";', '@im port "https://x.example/a.css";'],
    ] as const) {
      // A browser reads `@im` and `port` as two tokens; the mirror keeps the
      // separation instead of asking for the import the page never made.
      expect(sanitizeCss(css, 'https://page.example/', false, undefined, 'passive'))
        .toBe(inert);
      expect(sanitizeCss(css, 'https://page.example/', false, undefined, 'conservative'))
        .toBe(inert);
    }
  });

  it('parts names a hex escape would join across the comment', () => {
    // The escape takes the first space as its terminator: a second space
    // is what keeps the halves two names, so no import or url() is made.
    expect(sanitizeCss(
      String.raw`@\69/**/mport "https://x.example/a.css";`,
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe(String.raw`@\69  mport "https://x.example/a.css";`);
    expect(sanitizeCss(
      String.raw`a{background:u\72/**/l(http://x.example/a.png)}`,
      'https://page.example/',
    )).toBe(String.raw`a{background:u\72  l(http://x.example/a.png)}`);
  });

  it('does not make a live import of an unquoted url() body holding white space', () => {
    for (const space of [' ', '\t', '\n', '\r', '\f']) {
      const css = `@import url(x${space}y);`;
      // `url(x y)` is a bad-url token: the browser fetches nothing, so the
      // mirror must not ask for a file the page never asked for (R4).
      expect(sanitizeCss(css, 'https://page.example/', false, undefined, 'passive'))
        .toBe('');
      expect(sanitizeCss(css, 'https://page.example/', false, undefined, 'conservative'))
        .toBe('');
    }
    // Only the import statement goes; the rest of the sheet stays.
    expect(sanitizeCss(
      '@import url(x y); .a{color:red}',
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe(' .a{color:red}');
    // The white space around the body is the tokenizer's own, and an escaped
    // space is part of the value: both stay live as the page has them.
    expect(sanitizeCss(
      '@import url( https://x.example/a.css );',
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe('@import url("https://x.example/a.css");');
    expect(sanitizeCss(
      String.raw`@import url(x\ y);`,
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe('@import url("https://page.example/x%20y");');
  });

  it('does not join a comment inside a url name into a live request', () => {
    for (const css of [
      'a{background:u/**/rl(http://x.example/a.png)}',
      'a{background:url/**/(http://x.example/a.png)}',
      'a{background:ur/**/l(p.gif)}',
    ]) {
      // A browser reads `u` and `rl(` as two tokens (or `url` and a bare
      // parenthesis): no url() function, no fetch. The mirror keeps the
      // separation instead of asking for the file the page never asked
      // for, under both policies (R4).
      const passive = sanitizeCss(css, 'https://page.example/', false, undefined, 'passive');
      const conservative = sanitizeCss(css, 'https://page.example/', false, undefined, 'conservative');
      expect(passive).not.toContain('url(');
      expect(conservative).not.toContain('url(');
      expect(passive).not.toContain('x.example/a.png"');
    }
    // The same holds for an at-rule, a hash, and a dimension the comment
    // would otherwise manufacture.
    expect(sanitizeCss('@/**/media screen{a{color:red}}', 'https://page.example/'))
      .toBe('@ media screen{a{color:red}}');
    expect(sanitizeCss('#/**/foo{color:red}', 'https://page.example/'))
      .toBe('# foo{color:red}');
    expect(sanitizeCss('a{width:1/**/px}', 'https://page.example/'))
      .toBe('a{width:1 px}');
    // A hex escape reaches over its terminating white space.
    expect(sanitizeCss(
      String.raw`a{background:\75 /**/rl(http://x.example/a.png)}`,
      'https://page.example/',
    )).not.toContain('url(');
    // A comment across a delimiter joins nothing: the selector stays.
    expect(sanitizeCss('.a/**/.b{color:red}', 'https://page.example/'))
      .toBe('.a.b{color:red}');
  });

  it('keeps comment characters inside an unquoted url body as the URL', () => {
    // Inside a url token `/` and `*` are URL code points, not a comment:
    // the browser requests the literal path, and so does the mirror (R4).
    expect(sanitizeCss(
      'a{background:url(http://x.example/a.pn/**/g)}',
      'https://page.example/',
    )).toBe('a{background:url("http://x.example/a.pn/**/g")}');
    expect(sanitizeCss(
      'a{background:url(http://x.example/a/*b)}',
      'https://page.example/',
    )).toBe('a{background:url("http://x.example/a/*b")}');
    expect(sanitizeCss(
      '@import url(http://x.example/a.pn/**/g);',
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe('@import url("http://x.example/a.pn/**/g");');
    // A quoted body is a string: its comment characters were already text.
    expect(sanitizeCss(
      'a{background:url("http://x.example/a/*b")}',
      'https://page.example/',
    )).toBe('a{background:url("http://x.example/a/*b")}');
  });

  it('keeps no-break spaces at the edges of an unquoted url body', () => {
    // A no-break space is a character of the value, at the edges too: the
    // browser requests the padded URL, and so does the mirror (R4).
    expect(sanitizeCss(
      'a{background:url(\u00A0p.gif\u00A0)}',
      'https://page.example/',
    )).toBe('a{background:url("https://page.example/%C2%A0p.gif%C2%A0")}');
    expect(sanitizeCss(
      '@import url("\u00A0https://x.example/a.css\u00A0");',
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe('@import url("https://page.example/%C2%A0https://x.example/a.css%C2%A0");');
  });

  it('still normalizes the real @import spelling', () => {
    expect(sanitizeCss(
      '@import "https://x.example/a.css";',
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe('@import url("https://x.example/a.css");');
    expect(sanitizeCss(
      '@import "https://x.example/a.css";',
      'https://page.example/',
      false,
      undefined,
      'conservative',
    )).toBe('');
  });
});

describe('receiver passive @import extraction (R5)', () => {
  it('keeps an escaped quote in a bare-string import URL', () => {
    const css = '@import "https://x.example/a\\"";';
    expect(sanitizeCss(css, 'https://page.example/', false, undefined, 'passive'))
      .toBe('@import url("https://x.example/a%22");');
  });

  it('keeps an escaped quote in a quoted url() import URL', () => {
    expect(sanitizeCss(
      '@import url("https://x.example/a\\"") print;',
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBe('@import url("https://x.example/a%22") print;');
  });

  it('still refuses an import whose string never closes', () => {
    expect(sanitizeCss(
      '@import "https://x.example/a;',
      'https://page.example/',
      false,
      undefined,
      'passive',
    )).toBeUndefined();
  });
});

describe('receiver scripting media answers (R6)', () => {
  it('refuses a transported media query that still asks about scripts', () => {
    for (const tagName of ['link', 'style', 'source']) {
      const attributes: Array<readonly [string, string]> = [
        ['media', '(scripting: none)'],
      ];
      if (tagName === 'link') {
        attributes.push(['rel', 'stylesheet'], ['href', 'https://example.test/a.css']);
      }
      expect(readTransported(node(tagName, attributes)), tagName).toBeUndefined();
    }
    for (const tagName of ['img', 'source']) {
      const attributes: Array<readonly [string, string]> = [
        ['sizes', '(scripting: none) 100px'],
      ];
      if (tagName === 'img') attributes.push(['src', 'https://example.test/a.png']);
      expect(readTransported(node(tagName, attributes)), tagName).toBeUndefined();
    }
  });

  it('takes the answers the source sends as fixed points', () => {
    expect(readTransported(node('link', [
      ['rel', 'stylesheet'],
      ['href', 'https://example.test/a.css'],
      ['media', '(width >= 0px)'],
    ]))).toBeDefined();
    expect(readTransported(node('style', [
      ['media', 'print'],
    ]))).toBeDefined();
    expect(readTransported(node('img', [
      ['src', 'https://example.test/a.png'],
      ['sizes', '(max-width: 600px) 100vw, 600px'],
    ]))).toBeDefined();
  });
});