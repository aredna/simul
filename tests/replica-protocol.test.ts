import { describe, expect, it } from 'vitest';

import {
  REPLICA_PROTOCOL_VERSION,
  type ReplicaDocumentIdentity,
} from '../lib/replica/contracts';
import {
  MAX_REPLICA_STRING_LENGTH,
  createCheckpointCommand,
  createCheckpointEnvelope,
  createReplicaIdentity,
  readCheckpointCommand,
  readCheckpointResponse,
  sanitizeCssText,
  sanitizeCssTextDetailed,
  sanitizeRrwebIncrementalAttributes,
} from '../lib/replica/protocol-v2';

const identity: ReplicaDocumentIdentity = createReplicaIdentity({
  sessionId: 'session-1',
  pageEpoch: 7,
  generation: 7,
  documentId: 'document-1',
  frameId: 0,
  sequence: 0,
});

describe('replica protocol v2', () => {
  it('accepts only an exact v2 document-scoped command', () => {
    expect(REPLICA_PROTOCOL_VERSION).toBe(2);
    const command = createCheckpointCommand(identity);

    expect(readCheckpointCommand(command)).toEqual(command);
    expect(readCheckpointCommand({ ...command, protocolVersion: 1 })).toBeUndefined();
    expect(readCheckpointCommand({ ...command, extra: true })).toBeUndefined();
    expect(
      readCheckpointCommand({
        ...command,
        identity: { ...identity, pageEpoch: identity.pageEpoch + 1 },
      }),
    ).toBeUndefined();
  });

  it('masks control and contenteditable canaries before transport', () => {
    const canaries = {
      input: 'INPUT-CANARY-9281',
      textarea: 'TEXTAREA-CANARY-7821',
      editable: 'EDITABLE-CANARY-1192',
      uppercaseEditable: 'UPPERCASE-EDITABLE-CANARY-6241',
    };
    const envelope = createCheckpointEnvelope(identity, {
      events: fixtureEvents(canaries),
      captureMs: 4,
      viewportWidth: 1_280,
      viewportHeight: 720,
      documentWidth: 1_600,
      documentHeight: 2_400,
    });

    expect(envelope.kind).toBe('simul:replica-v2:checkpoint');
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain(canaries.input);
    expect(serialized).not.toContain(canaries.textarea);
    expect(serialized).not.toContain(canaries.editable);
    expect(serialized).not.toContain(canaries.uppercaseEditable);
    expect(serialized).not.toContain('checked');
    expect(serialized).not.toContain('PRIVATE-ATTRIBUTE-CANARY');
    expect(serialized).toContain('*'.repeat(canaries.editable.length));
  });

  it('removes executable elements, interaction hooks, and passive resource requests', () => {
    const envelope = createCheckpointEnvelope(identity, {
      events: fixtureEvents(),
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 900,
    });
    expect(envelope.kind).toBe('simul:replica-v2:checkpoint');
    if (envelope.kind !== 'simul:replica-v2:checkpoint') return;

    const serialized = JSON.stringify(envelope.payload.events);
    expect(serialized).not.toContain('SCRIPT-CANARY');
    expect(serialized).not.toContain('onclick');
    expect(serialized).not.toContain('cdn.example.test/image.png');
    expect(serialized).not.toContain('cdn.example.test/font.woff2');
    expect(serialized).not.toContain('cdn.example.test/svg-filter.svg');
    expect(serialized).not.toContain('cdn.example.test/smil-target.svg');
    expect(serialized).not.toContain('srcdoc');
    expect(serialized).toContain('https://example.test/private/path');
    expect(serialized).not.toContain('user:password');
    expect(serialized).not.toContain('secret=query');
    expect(serialized).toContain('"rr_mediaMuted":false');
  });

  it('revalidates bytes and exact identity before accepting a recorder response', () => {
    const envelope = createCheckpointEnvelope(identity, {
      events: fixtureEvents(),
      captureMs: 5,
      viewportWidth: 1_024,
      viewportHeight: 768,
      documentWidth: 1_024,
      documentHeight: 2_048,
    });
    expect(envelope.kind).toBe('simul:replica-v2:checkpoint');
    if (envelope.kind !== 'simul:replica-v2:checkpoint') return;

    expect(readCheckpointResponse(envelope, identity)).toEqual(envelope);
    expect(
      readCheckpointResponse(envelope, { ...identity, documentId: 'document-2' }),
    ).toBeUndefined();
    expect(
      readCheckpointResponse(
        {
          ...envelope,
          payload: {
            ...envelope.payload,
            byteLength: envelope.payload.byteLength + 1,
          },
        },
        identity,
      ),
    ).toBeUndefined();
  });

  it('rejects event tails, excess depth, and oversized checkpoints', () => {
    const withInteraction = fixtureEvents();
    withInteraction.push({
      type: 3,
      data: { source: 1, positions: [] },
      timestamp: 3,
    });
    expect(
      createCheckpointEnvelope(identity, {
        events: withInteraction,
        captureMs: 1,
        viewportWidth: 10,
        viewportHeight: 10,
        documentWidth: 10,
        documentHeight: 10,
      }).kind,
    ).toBe('simul:replica-v2:checkpoint-error');

    let deepNode: Record<string, unknown> = {
      type: 3,
      id: 200,
      textContent: 'leaf',
    };
    for (let index = 0; index < 70; index += 1) {
      deepNode = {
        type: 2,
        id: 199 - index,
        tagName: 'div',
        attributes: {},
        childNodes: [deepNode],
      };
    }
    const deep = createCheckpointEnvelope(identity, {
      events: checkpointEventsForNode({
        type: 0,
        id: 1,
        childNodes: [deepNode],
      }),
      captureMs: 1,
      viewportWidth: 10,
      viewportHeight: 10,
      documentWidth: 10,
      documentHeight: 10,
    });
    expect(deep).toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'privacy_rejected' },
    });

    const largeChildren = Array.from({ length: 17 }, (_, index) => ({
      type: 3,
      id: index + 2,
      textContent: 'x'.repeat(MAX_REPLICA_STRING_LENGTH),
    }));
    const oversized = createCheckpointEnvelope(identity, {
      events: checkpointEventsForNode({
        type: 0,
        id: 1,
        childNodes: largeChildren,
      }),
      captureMs: 1,
      viewportWidth: 10,
      viewportHeight: 10,
      documentWidth: 10,
      documentHeight: 10,
    });
    expect(oversized).toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'checkpoint_too_large' },
    });
  });

  it('sanitizes CSS network-bearing constructs without executable fallbacks', () => {
    const sanitized = sanitizeCssText(
      '@import url("https://cdn.example.test/a.css");' +
        '.a{background:url(https://cdn.example.test/a.png)}' +
        '.b{src:"//cdn.example.test/font.woff2"}',
    );
    expect(sanitized).not.toContain('cdn.example.test');
    expect(sanitized).not.toContain('@import');
    expect(sanitized).toContain('@media not all {}');
    expect(sanitized).toContain('.a{');
    expect(sanitized).toContain('.b{');
    expect(
      sanitizeCssText(String.raw`.a{background:\75rl(/escaped.png)}`),
    ).not.toContain('\\');
    expect(sanitizeCssText('.a{background-image:image-set("/a.png" 1x)}'))
      .toBe('.a{background-image:url("about:blank")}');
    expect(sanitizeCssText('@import "relative.css"')).toBe('@media not all {}');
    expect(sanitizeCssText('.a{background-image:image("relative.png")}'))
      .toBe('.a{background-image:url("about:blank")}');
    expect(sanitizeCssText('.a{background:url(/relative.png)}')).not.toContain(
      'relative.png',
    );
    expect(sanitizeCssText('@media/**/screen {p{}} q{}'))
      .toBe('@media screen {p{}} q{}');
    expect(sanitizeCssText(
      '@namespace svg url("https://www.w3.org/2000/svg");p{}',
    )).toBe('@namespace svg "urn:simul:inert";p{}');
  });

  it('preserves escaped identifiers, strings, comments, and rule topology', () => {
    const escapedMedia = String.raw`@\6d edia screen{.a{color:red}}.b{color:blue}`;
    const splitUrlStrings = '.a{content:"url("}.b{content:")"}.c{color:red}';
    const splitCommentStrings = '.a{content:"/*"}.b{content:"*/"}.c{color:red}';

    expect(sanitizeCssText(escapedMedia)).toBe(escapedMedia);
    expect(sanitizeCssText(splitUrlStrings)).toBe(splitUrlStrings);
    expect(sanitizeCssText(splitCommentStrings)).toBe(splitCommentStrings);
    expect(sanitizeCssText('@media/**/screen{.a{color:red}}.b{}'))
      .toBe('@media screen{.a{color:red}}.b{}');
  });

  it('classifies only real top-level resource at-rules', () => {
    const escapedImport = sanitizeCssTextDetailed(
      String.raw`@\69mport/**/url("https://cdn.example.test/a.css");p{}`,
    );
    expect(escapedImport).toEqual({
      text: '@media not all {}p{}',
      neutralizedImport: true,
      neutralizedNamespace: false,
    });

    const noWhitespaceImport = sanitizeCssTextDetailed(
      '@import"relative.css";p{}',
    );
    expect(noWhitespaceImport).toEqual({
      text: '@media not all {}p{}',
      neutralizedImport: true,
      neutralizedNamespace: false,
    });

    const namespace = sanitizeCssTextDetailed(
      String.raw`@\6e amespace svg/**/url("https://www.w3.org/2000/svg");p{}`,
    );
    expect(namespace).toEqual({
      text: '@namespace svg "urn:simul:inert";p{}',
      neutralizedImport: false,
      neutralizedNamespace: true,
    });
    expect(namespace.text).not.toContain('https://www.w3.org/2000/svg');

    const declarationText =
      '.a{--rule:@import "relative.css";' +
      'content:"@namespace url(https://example.test/ns);/*"}';
    expect(sanitizeCssTextDetailed(declarationText)).toEqual({
      text: declarationText,
      neutralizedImport: false,
      neutralizedNamespace: false,
    });

    const rulePreludeText =
      '@supports selector(@import"literal.css"){p{color:red}}' +
      'q[data-rule=@namespace]{color:blue}';
    expect(sanitizeCssTextDetailed(rulePreludeText)).toEqual({
      text: rulePreludeText,
      neutralizedImport: false,
      neutralizedNamespace: false,
    });

    const htmlCommentImport = sanitizeCssTextDetailed(
      '<!-- @import"data:text/css,p%7B%7D"; --> q{}',
    );
    expect(htmlCommentImport).toEqual({
      text: '<!-- @media not all {} --> q{}',
      neutralizedImport: true,
      neutralizedNamespace: false,
    });

    const chainedHtmlTokens = sanitizeCssTextDetailed(
      String.raw`--><!--@\69mport"relative.css";--><!--q{}`,
    );
    expect(chainedHtmlTokens).toEqual({
      text: '--><!--@media not all {}--><!--q{}',
      neutralizedImport: true,
      neutralizedNamespace: false,
    });

    const lateImport = 'p{}@import"relative.css";q{}';
    expect(sanitizeCssTextDetailed(lateImport)).toEqual({
      text: lateImport,
      neutralizedImport: false,
      neutralizedNamespace: false,
    });
    expect(sanitizeCssTextDetailed('@layer base;@import"relative.css";p{}'))
      .toEqual({
        text: '@layer base;@media not all {}p{}',
        neutralizedImport: true,
        neutralizedNamespace: false,
      });
  });

  it('neutralizes only resource-bearing function tokens', () => {
    const sanitized = sanitizeCssText(
      String.raw`.a{a:\75rl(/a);b:image("/b");c:image-set("/c" 1x);` +
      'd:-webkit-image-set("/d" 1x);e:src("/e");' +
      'f:cross-fade(url(/f),red);g:element(#g);' +
      'h:url(foo\\)bar);' +
      'content:"url(/literal) image(/* literal */)"}',
    );

    expect(sanitized).toBe(
      '.a{a:url("about:blank");b:url("about:blank");' +
      'c:url("about:blank");d:url("about:blank");' +
      'e:url("about:blank");f:url("about:blank");' +
      'g:url("about:blank");h:url("about:blank");' +
      'content:"url(/literal) image(/* literal */)"}',
    );
    expect(sanitizeCssText('.a{background:url(unclosed}.b{}.c{}'))
      .toBe('.a{background:url("about:blank")}.b{}.c{}');
  });

  it('requires rrweb exact-case _cssText attributes', () => {
    expect(sanitizeRrwebIncrementalAttributes(
      { _CSStext: 'p {}' },
      'style',
      false,
    )).toBeUndefined();
    expect(sanitizeRrwebIncrementalAttributes(
      { _cssText: 'p {}' },
      'style',
      false,
    )).toEqual({ _cssText: 'p {}' });

    const malformedCheckpoint = createCheckpointEnvelope(identity, {
      events: checkpointEventsForNode({
        type: 0,
        id: 1,
        childNodes: [{
          type: 2,
          id: 2,
          tagName: 'style',
          attributes: { _CSSTEXT: 'p {}' },
          childNodes: [],
        }],
      }),
      captureMs: 1,
      viewportWidth: 10,
      viewportHeight: 10,
      documentWidth: 10,
      documentHeight: 10,
    });
    expect(malformedCheckpoint).toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'privacy_rejected' },
    });
  });
});

function fixtureEvents(
  canaries: {
    input: string;
    textarea: string;
    editable: string;
    uppercaseEditable: string;
  } = {
    input: 'INPUT-CANARY',
    textarea: 'TEXTAREA-CANARY',
    editable: 'EDITABLE-CANARY',
    uppercaseEditable: 'UPPERCASE-EDITABLE-CANARY',
  },
): Array<Record<string, unknown>> {
  return checkpointEventsForNode({
    type: 0,
    id: 1,
    compatMode: 'CSS1Compat',
    childNodes: [
      {
        type: 2,
        id: 2,
        tagName: 'html',
        attributes: {},
        childNodes: [
          {
            type: 2,
            id: 3,
            tagName: 'head',
            attributes: {},
            childNodes: [
              {
                type: 2,
                id: 4,
                tagName: 'style',
                attributes: {},
                childNodes: [
                  {
                    type: 3,
                    id: 5,
                    textContent:
                      '@font-face{src:url(https://cdn.example.test/font.woff2)}',
                  },
                ],
              },
              {
                type: 2,
                id: 6,
                tagName: 'script',
                attributes: { src: 'https://cdn.example.test/app.js' },
                childNodes: [
                  { type: 3, id: 7, textContent: 'SCRIPT-CANARY' },
                ],
              },
            ],
          },
          {
            type: 2,
            id: 8,
            tagName: 'body',
            attributes: {
              onclick: 'SCRIPT-CANARY()',
              style: 'background:url(https://cdn.example.test/background.png)',
            },
            childNodes: [
              {
                type: 2,
                id: 9,
                tagName: 'input',
                attributes: {
                  value: canaries.input,
                  checked: true,
                  title: 'PRIVATE-ATTRIBUTE-CANARY',
                  'aria-valuetext': 'PRIVATE-ATTRIBUTE-CANARY',
                  'data-value': 'PRIVATE-ATTRIBUTE-CANARY',
                  src: 'https://cdn.example.test/input.png',
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 10,
                tagName: 'textarea',
                attributes: {},
                childNodes: [
                  { type: 3, id: 11, textContent: canaries.textarea },
                ],
              },
              {
                type: 2,
                id: 12,
                tagName: 'div',
                attributes: { contenteditable: 'true' },
                childNodes: [
                  { type: 3, id: 13, textContent: canaries.editable },
                ],
              },
              {
                type: 2,
                id: 14,
                tagName: 'img',
                attributes: {
                  src: 'https://cdn.example.test/image.png',
                  onerror: 'SCRIPT-CANARY()',
                  alt: 'safe description',
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 15,
                tagName: 'iframe',
                attributes: { srcdoc: '<script>SCRIPT-CANARY</script>' },
                childNodes: [],
              },
              {
                type: 2,
                id: 16,
                tagName: 'video',
                attributes: { rr_mediaMuted: false, rr_mediaLoop: false },
                childNodes: [],
              },
              {
                type: 2,
                id: 17,
                tagName: 'div',
                attributes: { contenteditable: 'TRUE' },
                childNodes: [
                  {
                    type: 3,
                    id: 18,
                    textContent: canaries.uppercaseEditable,
                  },
                ],
              },
              {
                type: 2,
                id: 19,
                tagName: 'rect',
                isSVG: true,
                attributes: {
                  fill: 'url(https://cdn.example.test/svg-filter.svg#paint)',
                },
                childNodes: [],
              },
              {
                type: 2,
                id: 21,
                tagName: 'output',
                attributes: { title: 'PRIVATE-ATTRIBUTE-CANARY' },
                childNodes: [
                  { type: 3, id: 22, textContent: 'PRIVATE-ATTRIBUTE-CANARY' },
                ],
              },
              {
                type: 2,
                id: 23,
                tagName: 'div',
                attributes: {
                  role: 'textbox',
                  'aria-valuetext': 'PRIVATE-ATTRIBUTE-CANARY',
                },
                childNodes: [
                  { type: 3, id: 24, textContent: 'PRIVATE-ATTRIBUTE-CANARY' },
                ],
              },
              {
                type: 2,
                id: 20,
                tagName: 'animate',
                isSVG: true,
                attributes: {
                  attributeName: 'href',
                  to: 'https://cdn.example.test/smil-target.svg',
                },
                childNodes: [],
              },
            ],
          },
        ],
      },
    ],
  });
}

function checkpointEventsForNode(
  node: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return [
    {
      type: 4,
      data: {
        href:
          'https://user:password@example.test/private/path?secret=query#private',
        width: 1_280,
        height: 720,
      },
      timestamp: 1,
    },
    {
      type: 2,
      data: { node, initialOffset: { top: 0, left: 0 } },
      timestamp: 2,
    },
  ];
}
