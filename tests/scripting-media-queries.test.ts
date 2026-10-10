import { parseHTML } from 'linkedom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  answerScriptingMediaFeatures,
  createHtmlMirrorStyleWorkBudget,
  readHtmlMirrorNode,
  sanitizeCss,
  sanitizeSourceAdoptedStyleSheets,
  sanitizeSourceDocument,
  type HtmlMirrorElementNode,
  type HtmlMirrorNode,
} from '../lib/replica/html-mirror-sanitizer';
import { WeakNodeIdRegistry } from '../lib/replica/html-mirror-source';

const BASE = 'https://example.test/app/';
const ALWAYS = '(width >= 0px)';
const NEVER = '(width < 0px)';

const sheet = (css: string, policy: 'passive' | 'conservative' = 'passive') =>
  sanitizeCss(css, BASE, false, undefined, policy);

/** The tab's own answer to `(scripting: none)`, as `matchMedia` gives it. */
function tabWithoutScripts(): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: /scripting:\s*none/u.test(query),
  });
}

describe('media queries about scripts, read as the tab reads them', () => {
  beforeEach(() => {
    const { window } = parseHTML('<html><body></body></html>');
    Object.assign(globalThis, {
      Node: window.Node,
      Element: window.Element,
      Text: window.Text,
    });
  });
  afterEach(() => {
    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });

  it('answers each form of the feature for a tab that runs scripts', () => {
    expect(sheet('@media (scripting: none){.a{display:none}}'))
      .toBe(`@media ${NEVER}{.a{display:none}}`);
    expect(sheet('@media (scripting: enabled){.a{display:block}}'))
      .toBe(`@media ${ALWAYS}{.a{display:block}}`);
    expect(sheet('@media (scripting){.a{display:block}}'))
      .toBe(`@media ${ALWAYS}{.a{display:block}}`);
    expect(sheet('@media (scripting: initial-only){.a{display:none}}'))
      .toBe(`@media ${NEVER}{.a{display:none}}`);
  });

  it('keeps what stands around the feature, so not, and, or and commas mean what they meant', () => {
    expect(sheet('@media not (scripting: none){.a{color:red}}'))
      .toBe(`@media not ${NEVER}{.a{color:red}}`);
    expect(sheet('@media screen and (scripting:none) and (max-width: 40em){.a{color:red}}'))
      .toBe(`@media screen and ${NEVER} and (max-width: 40em){.a{color:red}}`);
    expect(sheet('@media (scripting: none), print{.a{color:red}}'))
      .toBe(`@media ${NEVER}, print{.a{color:red}}`);
    expect(sheet('@media (min-width: 1px) and (not (scripting: none)){.a{color:red}}'))
      .toBe(`@media (min-width: 1px) and (not ${NEVER}){.a{color:red}}`);
    expect(sheet('@media not all and (scripting: enabled){.a{color:red}}'))
      .toBe(`@media not all and ${ALWAYS}{.a{color:red}}`);
    expect(sheet('@media ( SCRIPTING :  None ){.a{color:red}}'))
      .toBe(`@media ${NEVER}{.a{color:red}}`);
    expect(sheet('@MEDIA(scripting:none){.a{color:red}}'))
      .toBe(`@MEDIA${NEVER}{.a{color:red}}`);
  });

  it('answers a nested media rule and one inside other at-rules', () => {
    expect(sheet('.a{color:red;@media (scripting: none){display:none}}'))
      .toBe(`.a{color:red;@media ${NEVER}{display:none}}`);
    expect(sheet(
      '@layer base{@supports (display:grid){@media (scripting: none){.a{display:none}}}}',
    )).toBe(
      `@layer base{@supports (display:grid){@media ${NEVER}{.a{display:none}}}}`,
    );
    expect(sheet(
      '@media (scripting: none){.a{display:none}}.b{color:red}@media (scripting){.c{display:block}}',
    )).toBe(
      `@media ${NEVER}{.a{display:none}}.b{color:red}@media ${ALWAYS}{.c{display:block}}`,
    );
  });

  it('answers the media query of an import that travels', () => {
    expect(sheet('@import "theme.css" (scripting: none);.a{color:red}'))
      .toBe(`@import url("https://example.test/app/theme.css") ${NEVER};.a{color:red}`);
    expect(sheet('@import url(theme.css) layer(t) screen and (scripting);'))
      .toBe(`@import url("https://example.test/app/theme.css") layer(t) screen and ${ALWAYS};`);
  });

  it('leaves alone everything that only spells a query', () => {
    for (const css of [
      // A string, an attribute value, a custom property and a class name.
      '.a::before{content:"(scripting: none)"}',
      "[data-q='(scripting: none)']{color:red}",
      '.a{--q:(scripting: none)}',
      '.scripting\\:none\\(x\\){color:red}',
      // Other at-rules, a value the feature does not have, a longer name.
      '@supports (scripting: none){.a{color:red}}',
      '@container (scripting: none){.a{color:red}}',
      '@media (scripting: sometimes){.a{color:red}}',
      '@media (scripting-level: none){.a{color:red}}',
      '@media-like (scripting: none){.a{color:red}}',
      '@media2 (scripting: none){.a{color:red}}',
      '@media_x (scripting: none){.a{color:red}}',
      // A string, a block and a comment hold whatever they hold.
      '.a::after{content:"};@media (scripting: none){"}',
      "[data-q='};@media (scripting){']{color:red}",
      '.a{width:calc(1px;@media (scripting){x})}',
      '.a[b;@media (scripting){c}]{color:red}',
      // CSS names are ASCII: a long s or a dotless i makes another name.
      '@med\u0131a (scripting: none){.a{color:red}}',
      '@media screen{.a::after{content:"@media (scripting: none){"}}',
    ]) {
      expect(sheet(css), css).toBe(css);
    }
    expect(sheet('@media (\u017fcripting: none), (scripting: none){.a{color:red}}'))
      .toBe(`@media (\u017fcripting: none), ${NEVER}{.a{color:red}}`);
    // A style attribute holds no media query.
    expect(sanitizeCss('--q:(scripting: none);color:red', BASE, true, undefined, 'passive'))
      .toBe('--q:(scripting: none);color:red');
    // A query ends where its rule's block begins, an import's at its
    // semicolon, and a media rule with nothing after its name with the block
    // it is in: a selector after any of them is no query.
    for (const css of [
      '@media screen{.a:not(scripting){color:red}}',
      '@import url("https://example.test/t.css") screen;.a:not(scripting){color:red}',
      '.a{color:red;@media}.b:not(scripting){color:blue}',
      // Brackets that would be a condition's, were they still in the query.
      '@import url("https://example.test/t.css") screen;.a (scripting){color:red}',
      '.a{@media}.b (scripting){color:red}',
    ]) {
      expect(sheet(css), css).toBe(css);
    }
    // What comes after is read as rules again, a rule inside a block too.
    expect(sheet('@media screen{@media (scripting){.a{color:red}}}'))
      .toBe(`@media screen{@media ${ALWAYS}{.a{color:red}}}`);
    expect(sheet('@import url("https://example.test/t.css") screen;.a{@media (scripting){color:red}}'))
      .toBe(`@import url("https://example.test/t.css") screen;.a{@media ${ALWAYS}{color:red}}`);
    expect(sheet('.a{@media}.b{@media (scripting){color:red}}'))
      .toBe(`.a{@media}.b{@media ${ALWAYS}{color:red}}`);
  });

  it('reads a string and an escaped bracket inside a query as CSS reads them', () => {
    expect(answerScriptingMediaFeatures('"(scripting: none)" and (scripting: none)'))
      .toBe(`"(scripting: none)" and ${NEVER}`);
    expect(answerScriptingMediaFeatures("'it\\'s (scripting)' (scripting)"))
      .toBe(`'it\\'s (scripting)' ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('\\(scripting) and (scripting)'))
      .toBe(`\\(scripting) and ${ALWAYS}`);
    // The address of an import is a string of the rule's prelude.
    expect(sheet('@import "a(scripting:none).css" (scripting:none);')).toBe(
      `@import url("https://example.test/app/a(scripting:none).css") ${NEVER};`,
    );
  });

  it('passes over escapes and odd tokens of real sheets as CSS reads them (D83)', () => {
    const tailwind = ".before\\:content-\\[\\'\\2022\\'\\]:before{content:\"\\2022\"}" +
      '.bg-\\[url\\(x\\)\\]{color:red}.\\@media\\(scripting\\:none\\){color:blue}';
    expect(sheet(tailwind)).toBe(tailwind);
    expect(sheet(`${tailwind}@media (scripting: none){.a{display:none}}${tailwind}`))
      .toBe(`${tailwind}@media ${NEVER}{.a{display:none}}${tailwind}`);
    // A quote that an escape hides opens no string: the query after it is one.
    expect(sheet(".a\\'b{color:red}@media (scripting: none){.c{color:red}}"))
      .toBe(`.a\\'b{color:red}@media ${NEVER}{.c{color:red}}`);
    // A bracket inside a string or a URL does not end the prelude early.
    expect(sheet('@import url("https://example.test/a;b{c.css") (scripting: none);'))
      .toBe(`@import url("https://example.test/a;b%7Bc.css") ${NEVER};`);
    // The end of the text closes what is open, as it does for a browser.
    expect(answerScriptingMediaFeatures('screen and (scripting: none'))
      .toBe(`screen and ${NEVER}`);
    expect(answerScriptingMediaFeatures('screen and ((scripting'))
      .toBe(`screen and (${ALWAYS}`);
  });

  it('parts tokens by CSS white space only: any other space is a letter of a name', () => {
    for (const space of [' ', '\t', '\n', '\r', '\f', '\r\n', ' \n\t ']) {
      expect(sheet(`@media (${space}scripting${space}:${space}none${space}){.a{color:red}}`), JSON.stringify(space))
        .toBe(`@media ${NEVER}{.a{color:red}}`);
    }
    // The last of them, a vertical tab, is no letter either: a token of its own.
    for (const letter of [
      '\u00a0', '\u3000', '\ufeff', '\u2028', '\u2029', '\u1680', '\u2003', '\u000b',
    ]) {
      for (const css of [
        `@media (scripting:${letter}none){.a{color:red}}`,
        `@media (${letter}scripting){.a{color:red}}`,
        `@media (scripting${letter}){.a{color:red}}`,
        `@media (scripting${letter}: none){.a{color:red}}`,
        `@media (scripting: none${letter}){.a{color:red}}`,
      ]) {
        expect(sheet(css), JSON.stringify(css)).toBe(css);
      }
      expect(answerScriptingMediaFeatures(`(scripting:${letter}none)`))
        .toBe(`(scripting:${letter}none)`);
    }
    // A rule's name that such a letter lengthens is another rule's.
    expect(sheet('@media\u00a0(scripting){.a{color:red}}'))
      .toBe('@media\u00a0(scripting){.a{color:red}}');
  });

  it('reads a comment as what parts two names: a feature only its removal makes is none', () => {
    // To a browser these are no feature and no media rule. The comments are
    // taken out all the same, as before, which joins the halves: what that
    // makes is written as two names, which is no feature and never applies.
    const NONE = '(scrip ting)';
    expect(sheet('@media (scrip/**/ting){.a{color:red}}'))
      .toBe(`@media ${NONE}{.a{color:red}}`);
    expect(sheet('@media not (scripting: no/* */ne){.a{color:red}}'))
      .toBe(`@media not ${NONE}{.a{color:red}}`);
    expect(sheet('@med/**/ia (scripting){.a{color:red}}'))
      .toBe(`@media ${NONE}{.a{color:red}}`);
    expect(sheet('@/**/media screen and (scripting: none){.a{color:red}}'))
      .toBe(`@media screen and ${NONE}{.a{color:red}}`);
    expect(sheet('@im/**/port "a.css" (scripting);.a{color:red}'))
      .toBe(`@import url("https://example.test/app/a.css") ${NONE};.a{color:red}`);
    expect(sheet('.a{-/**/-q:x;@me/**/dia (scripting){color:red}}'))
      .toBe(`.a{--q:x;@media ${NONE}{color:red}}`);
    // One that a comment does not cut is answered, beside one that it does.
    expect(sheet('@media (scripting), (scrip/**/ting){.a{color:red}}'))
      .toBe(`@media ${ALWAYS}, ${NONE}{.a{color:red}}`);
    // A comment between two tokens that stay two changes nothing.
    expect(sheet('@media/**/(/**/scripting/**/:/**/none/**/)/**/{.a{color:red}}'))
      .toBe(`@media ${NEVER}{.a{color:red}}`);
    expect(sheet('@media screen /**/and/* x */ (scripting){.a{color:red}}'))
      .toBe(`@media screen and ${ALWAYS}{.a{color:red}}`);
    // The answer stays apart from the word a comment parted it from.
    expect(sheet('@media not/**/(scripting: none){.a{color:red}}'))
      .toBe(`@media not ${NEVER}{.a{color:red}}`);
    expect(sheet('@media screen and/* x */(scripting){.a{color:red}}'))
      .toBe(`@media screen and ${ALWAYS}{.a{color:red}}`);
    // An escaped colon is a letter of the name it stands in.
    expect(sheet('@media (scripting/**/\\3a none){.a{color:red}}'))
      .toBe('@media (scripting\\3a none){.a{color:red}}');
    // Elsewhere a comment is taken out as before.
    expect(sheet('.a{color:r/**/ed}@media (scripting){.b{mar/**/gin:0}}'))
      .toBe(`.a{color:red}@media ${ALWAYS}{.b{margin:0}}`);
    // What is written reads the same when read again, and is no feature.
    expect(sheet(`@media not ${NONE}{.a{color:red}}`))
      .toBe(`@media not ${NONE}{.a{color:red}}`);
    // The conservative reading takes an import out, however it is spelled.
    expect(sheet('@im/**/port "a.css" (scripting);.a{color:red}', 'conservative'))
      .toBe('.a{color:red}');
    // An attribute's value keeps its comments: nothing is joined there.
    expect(answerScriptingMediaFeatures('(scrip/**/ting) or (scripting/* x */)'))
      .toBe(`(scrip/**/ting) or ${ALWAYS}`);
    // A comment that never ends runs to the end of the text.
    expect(answerScriptingMediaFeatures('(scripting) /* and (scripting)'))
      .toBe(`${ALWAYS} /* and (scripting)`);
  });

  it('reads an escape as the letter it spells', () => {
    expect(sheet('@media (\\73 cripting: none){.a{color:red}}'))
      .toBe(`@media ${NEVER}{.a{color:red}}`);
    expect(sheet('@media (s\\63ripting){.a{color:red}}'))
      .toBe(`@media ${ALWAYS}{.a{color:red}}`);
    expect(sheet('@media (scriptin\\g: \\6e\\6f ne){.a{color:red}}'))
      .toBe(`@media ${NEVER}{.a{color:red}}`);
    expect(sheet('@media (\\000053\\43\r\nripting){.a{color:red}}'))
      .toBe(`@media ${ALWAYS}{.a{color:red}}`);
    expect(sheet('@\\6d edia (scripting){.a{color:red}}'))
      .toBe(`@\\6d edia ${ALWAYS}{.a{color:red}}`);
    expect(answerScriptingMediaFeatures('(\\73 cripting)')).toBe(ALWAYS);
    // A long s, a letter past the last one, a zero and half a pair spell no `s`.
    for (const css of [
      '@media (\\17f cripting){.a{color:red}}',
      '@media (\\110073 cripting){.a{color:red}}',
      '@media (\\0 scripting){.a{color:red}}',
      '@media (\\d800 scripting){.a{color:red}}',
      '@media (scripting\\){.a{color:red}}',
      '@media (scripting\\: none){.a{color:red}}',
    ]) {
      expect(sheet(css), css).toBe(css);
    }
  });

  it('answers the feature only: a name alone, or a name, a colon and one of its values', () => {
    for (const query of [
      '(scripting: none none)', '(scripting:)', '(scripting none)', '(scripting = none)',
      '(scripting: "none")', '(scripting >= 1)', '(none: scripting)', '(: scripting)',
      '(scripting: none;)', '(scripting: (none))', '(scripting, none)', '(scripting: none: none)',
      '(scripting scripting)', '(scripting: enabled!)', '[scripting]', '(scripting: 1)',
    ]) {
      expect(answerScriptingMediaFeatures(query), query).toBe(query);
      expect(sheet(`@media ${query}{.a{color:red}}`), query)
        .toBe(`@media ${query}{.a{color:red}}`);
    }
  });

  it('answers it inside brackets that hold conditions, and nowhere else', () => {
    expect(sheet('@media not ((min-width: 1px) and (scripting: none)){.a{color:red}}'))
      .toBe(`@media not ((min-width: 1px) and ${NEVER}){.a{color:red}}`);
    expect(sheet('@media ((scripting) or ((hover) and (not (scripting: none)))){.a{color:red}}'))
      .toBe(`@media (${ALWAYS} or ((hover) and (not ${NEVER}))){.a{color:red}}`);
    for (const css of [
      // The brackets of a function are not a condition's.
      '@import url("https://example.test/a.css") layer(scripting);',
      '@import url("https://example.test/a.css") layer((scripting));',
      '@import url("https://example.test/a.css") supports((scripting));',
      '@media calc(scripting){.a{color:red}}',
      '@media not(scripting){.a{color:red}}',
      '@media screen and(scripting){.a{color:red}}',
      '@media (not(scripting)){.a{color:red}}',
      '@media fn((scripting)){.a{color:red}}',
      // Nor are those of a feature's value, or of anything unknown.
      '@media (min-width: (scripting)){.a{color:red}}',
      '@media (foo (scripting)){.a{color:red}}',
      '@media ((scripting) 1px){.a{color:red}}',
      '@media ((scripting), (scripting)){.a{color:red}}',
      '@media [(scripting)]{.a{color:red}}',
    ]) {
      expect(sheet(css), css).toBe(css);
    }
    // After the function, the import's own query is one.
    expect(sheet('@import url("https://example.test/a.css") layer(scripting) (scripting);'))
      .toBe(`@import url("https://example.test/a.css") layer(scripting) ${ALWAYS};`);
  });

  it('reads brackets nested as deep as a text is long, in time that grows with the text', () => {
    const deep = (depth: number) =>
      `@media ${'('.repeat(depth)}scripting${')'.repeat(depth)}{.a{color:red}}`;
    // Conditions are read 32 deep; deeper, the brackets are passed over.
    expect(sheet(deep(32)))
      .toBe(`@media ${'('.repeat(31)}${ALWAYS}${')'.repeat(31)}{.a{color:red}}`);
    expect(sheet(deep(33))).toBe(deep(33));
    const started = performance.now();
    for (const css of [
      `@media ${'(scripting'.repeat(200_000)}`,
      '(scripting'.repeat(200_000),
      `.a{width:${'calc('.repeat(200_000)}`,
      `@media ${'['.repeat(300_000)}(scripting)`,
      // Every `@` is one place a rule's name could begin.
      `${'@'.repeat(300_000)}media (scripting){.a{color:red}}`,
      `${'@media x '.repeat(100_000)}\\`,
      `@media (scripting:${'a'.repeat(1_000_000)}`,
      `@media ${'\\'.repeat(300_000)}`,
    ]) {
      expect(() => sheet(css)).not.toThrow();
      expect(() => answerScriptingMediaFeatures(css)).not.toThrow();
    }
    // Seconds would be a text read once for each of its brackets or `@`s.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  it('reads a rule only where one can begin, and never the value of a custom property', () => {
    for (const css of [
      '.a{--q:@media (scripting: none){.b{color:red}}}',
      '.a{--q:{@media (scripting: none){.b{color:red}}};color:red}',
      '.a{--q: x;--r:[;@media (scripting){}];color:red}',
      ':root{--\\71 :@media (scripting){}}',
      '.a{color:red @media (scripting){}}',
      '.a @media (scripting){color:red}',
      // Not after a string or a bracket in the middle of something either.
      '.a{content:"x" @media (scripting){}}',
      '.a:is(.b) @media (scripting){color:red}',
      ".a::after{content:'};@media (scripting: none){'}",
      '.a{background:url("https://example.test/a.png?@media(scripting){")}',
    ]) {
      expect(sheet(css), css).toBe(css);
    }
    // After the property's end, a rule is one again.
    expect(sheet('.a{--q:@media (scripting){};@media (scripting){color:red}}'))
      .toBe(`.a{--q:@media (scripting){};@media ${ALWAYS}{color:red}}`);
    expect(sheet('.a{--q:(scripting)}@media (scripting){.b{color:red}}'))
      .toBe(`.a{--q:(scripting)}@media ${ALWAYS}{.b{color:red}}`);
    // A name that only begins like one is a rule's selector.
    expect(sheet('--x{@media (scripting){color:red}}'))
      .toBe(`--x{@media ${ALWAYS}{color:red}}`);
    expect(sheet('-x:hover{@media (scripting){color:red}}'))
      .toBe(`-x:hover{@media ${ALWAYS}{color:red}}`);
    // A quote inside a comment opens no string.
    expect(sheet(".a{color:red/* ' */}@media (scripting){.b{color:red}}"))
      .toBe(`.a{color:red}@media ${ALWAYS}{.b{color:red}}`);
  });

  it('passes over a function, an address and a string inside a query as CSS reads them', () => {
    // An address without quotes runs to its bracket, quotes and all.
    expect(answerScriptingMediaFeatures('url(a"b) (scripting)'))
      .toBe(`url(a"b) ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('url(a\\)"b) (scripting)'))
      .toBe(`url(a\\)"b) ${ALWAYS}`);
    // One in quotes is a string in a function.
    expect(answerScriptingMediaFeatures('url( "a)b") (scripting)'))
      .toBe(`url( "a)b") ${ALWAYS}`);
    // Inside a function: a string, a bracket of another kind, an escaped
    // bracket and an address are passed over, and its own bracket ends it.
    expect(answerScriptingMediaFeatures('fn(")" (scripting)) and (scripting)'))
      .toBe(`fn(")" (scripting)) and ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('fn(a ] (scripting)) and (scripting)'))
      .toBe(`fn(a ] (scripting)) and ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('fn(a\\) (scripting)) and (scripting)'))
      .toBe(`fn(a\\) (scripting)) and ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('fn(\\) (scripting)) and (scripting)'))
      .toBe(`fn(\\) (scripting)) and ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('fn(url(a"b) (scripting)) and (scripting)'))
      .toBe(`fn(url(a"b) (scripting)) and ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('fn([{(scripting)}]) and (scripting)'))
      .toBe(`fn([{(scripting)}]) and ${ALWAYS}`);
    // An attribute's value is all query, whatever stands in it.
    expect(answerScriptingMediaFeatures('(scripting), x; (scripting) } (scripting) { (scripting'))
      .toBe(`${ALWAYS}, x; ${ALWAYS} } ${ALWAYS} { (scripting`);
    // A backslash before a line break spells nothing: the name ends there.
    expect(sheet('@media\\\n(scripting){.a{color:red}}'))
      .toBe(`@media\\\n${ALWAYS}{.a{color:red}}`);
  });

  it('asks the tab once for a text, however many features it holds', () => {
    let asked = 0;
    (globalThis as { matchMedia?: unknown }).matchMedia = () => {
      asked += 1;
      return { matches: false };
    };
    sheet('@media (scripting){.a{color:red}}@media (scripting: none) or (scripting){.b{color:red}}');
    expect(asked).toBe(1);
    // And not at all for one that holds none.
    sheet('@media (scripting: sometimes){.a{color:red}}');
    expect(asked).toBe(1);
  });

  it('refuses a sheet in which a line break cuts a string', () => {
    // For a browser the string ends at the line break and what follows is
    // the sheet again. The passes that drop imports and read addresses end a
    // string only at its quote: they took the import here for string text,
    // and it stayed in.
    for (const policy of ['conservative', 'passive'] as const) {
      for (const css of [
        '@x "a\n;@import url(https://example.test/evil0.css);.z{content:"}',
        ".a{content:'a\n}.b{background:url(https://example.test/p0.png)}.z{content:'}",
        '@import "https://example.test/evi\nl1.css";',
        '.a{content:"a\nb"}',
        '.a{content:"a\rb"}',
        '.a{content:"a\fb"}',
        '.a{content:"a\r\nb"}',
        '.a{content:"a\\\\\nb"}',
        '.a{content:"a\n}@media (scripting){.b{color:red}}.c{content:"}',
      ]) {
        expect(sheet(css, policy), JSON.stringify(css)).toBeUndefined();
      }
    }
    // A line break that a backslash escapes is part of its string; one
    // outside a string, or inside a comment, cuts none.
    for (const css of [
      '.a{content:"a\\\nb"}',
      '.a{content:"a\\\r\nb"}',
      '.a{content:"a\\\fb"}',
      ".a{content:'a\\\nb'}",
      '.a{content:"a"}\n.b{content:"b"}',
      '.a\\"b\n{color:red}',
    ]) {
      expect(sheet(css), JSON.stringify(css)).toBe(css);
    }
    expect(sheet('.a{color:red}/* "a\n */.b{color:blue}'))
      .toBe('.a{color:red}.b{color:blue}');
    // A declaration list holds no import; it is read as it was.
    expect(sanitizeCss("font-family:'A\nB';color:red", BASE, true, undefined, 'passive'))
      .toBe("font-family:'A\nB';color:red");
    // An attribute's query is read as a browser reads it: the string ends
    // at the line break, and an escaped line break is part of it.
    expect(answerScriptingMediaFeatures('"x\n(scripting) "(scripting)"'))
      .toBe(`"x\n${ALWAYS} "(scripting)"`);
    expect(answerScriptingMediaFeatures('"x\\\n(scripting)" (scripting)'))
      .toBe(`"x\\\n(scripting)" ${ALWAYS}`);
    expect(answerScriptingMediaFeatures('"x\\\r\n(scripting)" (scripting)'))
      .toBe(`"x\\\r\n(scripting)" ${ALWAYS}`);
    // Without a break the string runs on, and what it holds is text.
    const open = '.a{content:"a b}@media (scripting){.b{color:red}}.c{content:"}';
    expect(sheet(open)).toBe(open);
  });

  it('leaves an import to be dropped or kept by what its conditions held', () => {
    // The passes that follow drop an import whose conditions hold a
    // backslash: a feature spelled with one is left for them to see.
    expect(sheet('@import url("https://example.test/a15.css") (scr\\69pting);.a{color:red}'))
      .toBe('.a{color:red}');
    expect(sheet('@import url("https://example.test/a.css") (scripting) and (min-w\\69 dth: 1px);.a{color:red}'))
      .toBe('.a{color:red}');
    // In a media rule, which nothing drops, it is answered.
    expect(sheet('@media (scr\\69pting){.a{color:red}}'))
      .toBe(`@media ${ALWAYS}{.a{color:red}}`);
    // They drop one whose conditions are longer than 2,048 characters. An
    // answer is shorter or longer than what it stands for, so conditions
    // longer than half of that are not answered: the import is dropped or
    // kept as it was, and a feature in one that is kept is written as none.
    const long = (spaces: number) =>
      `@import url("https://example.test/a.css") (scripting:${' '.repeat(spaces)}none);.a{color:red}`;
    expect(sheet(long(900)))
      .toBe(`@import url("https://example.test/a.css") ${NEVER};.a{color:red}`);
    expect(sheet(long(1_100)))
      .toBe('@import url("https://example.test/a.css") (scrip ting);.a{color:red}');
    expect(sheet(long(2_100))).toBe('.a{color:red}');
    // Under the conservative reading no import travels, whatever it holds.
    expect(sheet(long(900), 'conservative')).toBe('.a{color:red}');
  });

  it('reads no rule in a declaration list', () => {
    for (const css of [
      '@media (scripting: none){color:red}',
      'color:red;@media (scripting){color:blue}',
    ]) {
      expect(sanitizeCss(css, BASE, true, undefined, 'passive'), css).toBe(css);
    }
  });

  it('gives the same text when any text it wrote is read again', () => {
    const around = [
      '@media', '@import', '@', 'media', '(', ')', 'scripting', ':', 'none', '/**/',
      ' ', '\n', '"', "'", '\\', '{', '}', ';', '--x', ':', 'layer(', 'url(', '.a', 'x',
    ];
    const inside = [
      '(', ')', '(', ')', 'scripting', 'scripting', 'scrip', 'ting', ':', 'none', 'enabled',
      'not', 'and', 'or', ',', '/**/', '/* ( */', ' ', ' ', '\n', '\u00a0', '"', "'", '\\',
      '\\73 ', 'layer(', '(scripting)', '(scripting: none)', 'screen',
    ];
    let seed = 20261011;
    const next = (below: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % below;
    };
    const some = (parts: readonly string[], most: number) => {
      let text = '';
      for (let length = next(most + 1); length > 0; length -= 1) {
        text += parts[next(parts.length)];
      }
      return text;
    };
    let answered = 0;
    let read = 0;
    for (let round = 0; round < 6_000; round += 1) {
      const query = some(inside, 9);
      const css = `${some(around, 5)}@media ${query}{.a{color:red}}${some(around, 5)}`;
      for (const policy of ['passive', 'conservative'] as const) {
        const once = sheet(css, policy);
        if (once === undefined) continue;
        read += 1;
        if (once.includes('(width')) answered += 1;
        expect(sheet(once, policy), JSON.stringify(css)).toBe(once);
      }
      const once = answerScriptingMediaFeatures(query);
      expect(answerScriptingMediaFeatures(once), JSON.stringify(query)).toBe(once);
    }
    // The texts are read, and do reach the rule.
    expect(read).toBeGreaterThan(3_000);
    expect(answered).toBeGreaterThan(100);
  });

  it('returns a sheet that does not ask about scripts as it was', () => {
    const css = '@media screen and (min-width: 30em){.a{color:red}}.b{color:blue}';
    expect(sheet(css)).toBe(css);
    expect(answerScriptingMediaFeatures('screen and (min-width: 30em)'))
      .toBe('screen and (min-width: 30em)');
  });

  it('gives the same text when what it wrote is read again, under both policies', () => {
    for (const policy of ['passive', 'conservative'] as const) {
      const once = sheet(
        '@media (scripting: none){.a{display:none}}@media not (scripting){.b{color:red}}',
        policy,
      )!;
      expect(once).not.toMatch(/scripting/u);
      expect(sheet(once, policy)).toBe(once);
    }
  });

  it('asks the tab: where scripts do not run, none matches and enabled does not', () => {
    tabWithoutScripts();
    expect(sheet('@media (scripting: none){.a{display:none}}'))
      .toBe(`@media ${ALWAYS}{.a{display:none}}`);
    expect(sheet('@media (scripting: enabled){.a{display:block}}'))
      .toBe(`@media ${NEVER}{.a{display:block}}`);
    expect(sheet('@media (scripting){.a{display:block}}'))
      .toBe(`@media ${NEVER}{.a{display:block}}`);
    // A page that ran scripts once and no longer does is no tab's answer.
    expect(sheet('@media (scripting: initial-only){.a{display:none}}'))
      .toBe(`@media ${NEVER}{.a{display:none}}`);
  });

  it('takes a tab that cannot be asked for one that runs scripts', () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = () => {
      throw new Error('unreadable');
    };
    expect(answerScriptingMediaFeatures('(scripting: none)')).toBe(NEVER);
  });

  it('answers the media attribute of a sheet and a picture source, and an image\'s sizes', () => {
    const { document, window } = parseHTML(`<!doctype html><html><head>
      <style id="s" media="(scripting: none)">.a{display:none}</style>
      <link id="l" rel="stylesheet" media="not (scripting: none)" href="https://example.test/a.css">
    </head><body>
      <picture><source id="p" media="(scripting: enabled)" srcset="https://example.test/a.png">
        <img id="i" src="https://example.test/b.png" srcset="https://example.test/c.png 8w"
          sizes="(scripting: none) 8px, 64px" alt=""></picture>
      <p id="t" media="(scripting: none)" sizes="(scripting: none) 1px"
        title="(scripting: none)">text</p>
    </body></html>`);
    const graph = sanitizeSourceDocument(
      document as unknown as Document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
      undefined,
      'passive',
    )!;
    expect(attributesOf(graph.root, 's').media).toBe(NEVER);
    expect(attributesOf(graph.root, 'l').media).toBe(`not ${NEVER}`);
    expect(attributesOf(graph.root, 'p').media).toBe(ALWAYS);
    expect(attributesOf(graph.root, 'i').sizes).toBe(`${NEVER} 8px, 64px`);
    // Any other attribute, and the same names on another element, are the
    // page's own text.
    expect(attributesOf(graph.root, 't').title).toBe('(scripting: none)');
    expect(attributesOf(graph.root, 't').media).toBe('(scripting: none)');
    expect(attributesOf(graph.root, 't').sizes).toBe('(scripting: none) 1px');
    // The style element's own rules are untouched by its media attribute.
    expect(JSON.stringify(graph)).toMatch(/\.a ?\{display: ?none;?\}/u);
  });

  it('answers the queries of a sheet read through the CSSOM, and its own media', () => {
    const rules = [
      { cssText: '@media (scripting: none) { .a { display: none; } }' },
      { cssText: '.b { color: red; }' },
    ];
    const adopted = {
      disabled: false,
      media: { mediaText: 'not (scripting: none)' },
      cssRules: Object.assign([...rules], {
        item: (index: number) => rules[index] ?? null,
      }),
    };
    const owner = { adoptedStyleSheets: [adopted] } as unknown as ShadowRoot;
    expect(sanitizeSourceAdoptedStyleSheets(
      owner,
      BASE,
      createHtmlMirrorStyleWorkBudget(),
      undefined,
      'passive',
    )).toEqual([
      `@media not ${NEVER}{@media ${NEVER} { .a { display: none; } }\n.b { color: red; }}`,
    ]);
  });

  it('is refused by the panel when a sheet still asks about scripts', () => {
    const node = (css: string) => readHtmlMirrorNode({
      kind: 'element',
      id: 1,
      namespace: 'html',
      tagName: 'style',
      attributes: [],
      children: [],
      resolvedStyleSheetText: css,
    }, new Set(), 0, undefined, false, false, false, false, false, 'passive') as
      HtmlMirrorElementNode | undefined;
    expect(node(`@media ${NEVER}{.a{display:none}}`)?.resolvedStyleSheetText)
      .toBe(`@media ${NEVER}{.a{display:none}}`);
    expect(node('@media (scripting: none){.a{display:none}}')?.resolvedStyleSheetText)
      .toBeUndefined();
  });

  it('leaves out what a page keeps for browsers without scripts', () => {
    const { document, window } = parseHTML(`<!doctype html><html><head>
      <noscript><style>.js{display:none}</style></noscript>
    </head><body><p id="a">with scripts</p>
      <noscript><p id="b">without scripts</p></noscript></body></html>`);
    const graph = sanitizeSourceDocument(
      document as unknown as Document,
      window as unknown as Window,
      new WeakNodeIdRegistry(),
    )!;
    const serialized = JSON.stringify(graph);
    expect(serialized).toContain('with scripts');
    expect(serialized).not.toContain('noscript');
    expect(serialized).not.toContain('without scripts');
    expect(serialized).not.toContain('.js{display:none}');
  });
});

function attributesOf(root: HtmlMirrorNode, id: string): Record<string, string> {
  const pending: HtmlMirrorNode[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind !== 'element') continue;
    const attributes = Object.fromEntries(node.attributes);
    if (attributes.id === id) return attributes;
    pending.push(...node.children, ...(node.shadowRoot?.children ?? []));
  }
  throw new Error(`No element #${id}.`);
}
