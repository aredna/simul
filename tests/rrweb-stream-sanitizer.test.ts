import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';

import {
  createCheckpointEnvelope,
  createReplicaIdentity,
} from '../lib/replica/protocol-v2';
import {
  MAX_REPLICA_STREAM_STYLE_IDS,
  RrwebStreamSanitizer,
} from '../lib/replica/rrweb-stream-sanitizer';

describe('rrweb live incremental sanitizer', () => {
  it('tracks private ancestry and strips live resource or handler attributes', () => {
    const sanitizer = readySanitizer();
    const prepared = sanitizer.prepareBatch([
      mutationEvent({
        texts: [
          { id: 5, value: 'public update' },
          { id: 7, value: 'PRIVATE-LIVE-CANARY' },
        ],
        attributes: [
          {
            id: 8,
            attributes: {
              src: 'https://tracker.example/live.png',
              onclick: 'LIVE-HANDLER-CANARY',
              alt: 'safe label',
            },
          },
        ],
      }),
    ]);

    expect(prepared).toBeDefined();
    const serialized = JSON.stringify(prepared?.events);
    expect(serialized).toContain('public update');
    expect(serialized).not.toContain('PRIVATE-LIVE-CANARY');
    expect(serialized).not.toContain('tracker.example');
    expect(serialized).not.toContain('LIVE-HANDLER-CANARY');
    expect(prepared?.events).toMatchObject([
      {
        data: {
          texts: [{ id: 5, value: 'public update' }, { id: 7, value: '*******************' }],
          attributes: [
            {
              id: 8,
              attributes: { src: null, onclick: null, alt: 'safe label' },
            },
          ],
        },
      },
    ]);
  });

  it('advances node identity only when a prepared batch commits', () => {
    const sanitizer = readySanitizer();
    const removal = sanitizer.prepareBatch([
      mutationEvent({ removes: [{ parentId: 3, id: 8 }] }),
    ]);
    expect(removal).toBeDefined();

    expect(sanitizer.prepareBatch([
      mutationEvent({ attributes: [{ id: 8, attributes: { alt: 'still present' } }] }),
    ])).toBeDefined();

    removal?.commit();
    expect(sanitizer.prepareBatch([
      mutationEvent({ attributes: [{ id: 8, attributes: { alt: 'now stale' } }] }),
    ])).toBeUndefined();
  });

  it('requests a checkpoint for unknown IDs or privacy-boundary mutations', () => {
    const sanitizer = readySanitizer();
    expect(sanitizer.prepareBatch([
      mutationEvent({ texts: [{ id: 999, value: 'unknown' }] }),
    ])).toBeUndefined();
    expect(sanitizer.prepareBatch([
      mutationEvent({
        attributes: [{ id: 4, attributes: { contenteditable: 'true' } }],
      }),
    ])).toBeUndefined();
  });

  it('rejects incremental operations that cannot apply to the tracked node type', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([
      mutationEvent({ texts: [{ id: 4, value: 'not a text node' }] }),
    ])).toBeUndefined();
    expect(sanitizer.prepareBatch([scrollEvent(5)])).toBeUndefined();
    expect(sanitizer.prepareBatch([mutationEvent({
      adds: [{
        parentId: 5,
        nextId: null,
        node: { type: 3, id: 12, textContent: 'invalid child' },
      }],
    })])).toBeUndefined();
    expect(sanitizer.prepareBatch([mutationEvent({
      removes: [{ parentId: 3, id: 8, isShadow: true }],
    })])).toBeUndefined();
  });

  it('omits unsafe added trees consistently without sequencing later tails', () => {
    const source = readySanitizer();
    const unsafe = source.sanitizeForRecorder(mutationEvent({
      adds: [
        {
          parentId: 4,
          nextId: null,
          node: {
            type: 2,
            id: 10,
            tagName: 'script',
            attributes: { src: 'https://evil.example/code.js' },
            childNodes: [{ type: 3, id: 11, textContent: 'SCRIPT-CANARY' }],
          },
        },
      ],
    }));
    expect(unsafe.status).toBe('accepted');
    expect(JSON.stringify(unsafe)).not.toContain('evil.example');
    expect(JSON.stringify(unsafe)).not.toContain('SCRIPT-CANARY');

    const receiver = readySanitizer();
    if (unsafe.status !== 'accepted') throw new Error('Expected an inert mutation.');
    expect(receiver.prepareBatch([unsafe.event])).toBeDefined();
    expect(source.sanitizeForRecorder(scrollEvent(10))).toEqual({ status: 'ignored' });

    const adjacent = source.sanitizeForRecorder(mutationEvent({
      adds: [
        {
          parentId: 4,
          previousId: null,
          nextId: 10,
          node: {
            type: 2,
            id: 12,
            tagName: 'span',
            attributes: {},
            childNodes: [],
          },
        },
      ],
    }));
    expect(adjacent).toMatchObject({
      status: 'accepted',
      event: { data: { adds: [{ previousId: null, nextId: null }] } },
    });
  });

  it('projects an omitted mid-list anchor to the nearest surviving sibling', () => {
    const sanitizer = readySanitizer();
    const unsafe = sanitizer.sanitizeForRecorder(mutationEvent({
      adds: [
        {
          parentId: 4,
          previousId: null,
          nextId: 5,
          node: {
            type: 2,
            id: 10,
            tagName: 'script',
            attributes: {},
            childNodes: [],
          },
        },
      ],
    }));
    expect(unsafe).toMatchObject({
      status: 'accepted',
      event: { data: { adds: [] } },
    });

    const adjacent = sanitizer.sanitizeForRecorder(mutationEvent({
      adds: [
        {
          parentId: 4,
          previousId: null,
          nextId: 10,
          node: {
            type: 2,
            id: 12,
            tagName: 'span',
            attributes: {},
            childNodes: [],
          },
        },
      ],
    }));

    expect(adjacent).toMatchObject({
      status: 'accepted',
      event: { data: { adds: [{ previousId: null, nextId: 5 }] } },
    });
  });

  it('rejects a sibling anchor from another parent', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([mutationEvent({
      adds: [
        {
          parentId: 3,
          previousId: null,
          nextId: 5,
          node: {
            type: 2,
            id: 12,
            tagName: 'span',
            attributes: {},
            childNodes: [],
          },
        },
      ],
    })])).toBeUndefined();
  });

  it('survives JSON serialization of optional CSS priority and removes CSS URLs', () => {
    const sanitizer = readySanitizer();
    const event = JSON.parse(JSON.stringify({
      type: 3,
      data: {
        source: 13,
        id: 30,
        index: [0],
        set: {
          property: 'background-image',
          value: 'url("https://images.example/background.png")',
        },
      },
      timestamp: 20,
    }));
    const prepared = sanitizer.prepareBatch([event]);
    expect(prepared).toBeDefined();
    expect(JSON.stringify(prepared?.events)).not.toContain('images.example');
    expect(prepared?.events).toMatchObject([
      {
        data: {
          set: {
            property: 'background-image',
            value: 'url("about:blank")',
          },
        },
      },
    ]);

    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      styleId: undefined,
      index: [0],
      set: { property: 'margin', value: 4, priority: 'IMPORTANT' },
    }, 21)])?.events).toMatchObject([{
      data: {
        set: { property: 'margin', value: '4', priority: 'important' },
      },
    }]);
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      styleId: undefined,
      index: [0],
      set: { property: '--x', value: null },
    }, 21)])?.events).toMatchObject([{
      data: { set: { property: '--x', value: '' } },
    }]);
  });

  it('rejects CSS declaration paths that do not resolve to a style-bearing rule', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      index: [1],
      set: { property: 'color', value: 'red' },
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      index: [],
      remove: { property: 'color' },
    }, 20)])).toBeUndefined();
  });

  it('advances CSS rule topology only after a prepared batch commits', () => {
    const sanitizer = readySanitizer();
    const addition = sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: 'p { color: blue; }', index: 1 }],
    }, 20)]);
    const declaration = styleDeclarationEvent({
      id: 30,
      index: [1],
      set: { property: 'font-weight', value: 'bold' },
    }, 21);

    expect(addition).toBeDefined();
    expect(sanitizer.prepareBatch([declaration])).toBeUndefined();
    addition?.commit();
    expect(sanitizer.prepareBatch([declaration])).toBeDefined();
  });

  it('accepts rrweb CSS callback shapes with an unused target and default index', () => {
    const sanitizer = readySanitizer();
    const nodeUpdate = sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      styleId: undefined,
      adds: [{ rule: 'aside { display: block; }', index: undefined }],
    }, 20)]);

    expect(nodeUpdate).toBeDefined();
    expect(nodeUpdate?.events).toMatchObject([{
      data: {
        id: 30,
        adds: [{ rule: 'aside {display: block;}' }],
      },
    }]);
    expect(nodeUpdate?.events[0]).not.toHaveProperty('data.styleId');
    nodeUpdate?.commit();

    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      styleId: undefined,
      index: [0],
      set: { property: 'color', value: 'green', priority: undefined },
    }, 21)])).toBeDefined();

    const adopted = sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 1,
        styleIds: [20],
        styles: [{ styleId: 20, rules: [] }],
      },
      timestamp: 22,
    }]);
    expect(adopted).toBeDefined();
    adopted?.commit();

    const constructedUpdate = sanitizer.prepareBatch([styleRuleEvent({
      id: undefined,
      styleId: 20,
      adds: [{ rule: 'main { display: grid; }', index: undefined }],
    }, 23)]);
    expect(constructedUpdate).toBeDefined();
    expect(constructedUpdate?.events[0]).not.toHaveProperty('data.id');
  });

  it('checkpoints ambiguous or non-applicable CSSOM operations', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: 'aside { display: block; }', index: 1 }],
      removes: [{ index: 0 }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: 'p {} trailing-garbage', index: 1 }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: '@media not all {}', index: 1 }],
    }, 20)])).toBeDefined();
    const invalidDisplay = sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{
        rule: 'p { display: url("https://invalid.example/a"); }',
        index: 1,
      }],
    }, 20)]);
    expect(invalidDisplay).toBeDefined();
    expect(JSON.stringify(invalidDisplay?.events)).toContain('url(\\"about:blank\\")');
    expect(JSON.stringify(invalidDisplay?.events)).not.toContain('display:none');
  });

  it('tracks whether style and link nodes actually materialize a stylesheet', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 32,
      adds: [{ rule: 'p {}', index: 0 }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 33,
      adds: [{ rule: 'p {}', index: 1 }],
    }, 20)])).toBeUndefined();

    const enableStyle = sanitizer.prepareBatch([mutationEvent({
      attributes: [{ id: 33, attributes: { type: 'text/css' } }],
    })]);
    expect(enableStyle).toBeDefined();
    enableStyle?.commit();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 33,
      adds: [{ rule: 'aside {}', index: 1 }],
    }, 20)])).toBeDefined();

    const enableLink = sanitizer.prepareBatch([mutationEvent({
      attributes: [{ id: 32, attributes: { _cssText: ' ' } }],
    })]);
    expect(enableLink).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 41,
      adds: [{ rule: 'main {}', index: 0 }],
    }, 20)])).toBeDefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 43,
      adds: [{ rule: 'main {}', index: 1 }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 39,
      adds: [{ rule: 'footer {}', index: 0 }],
    }, 20)])).toBeDefined();
  });

  it('rejects live attribute shapes rrweb cannot replay exactly', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([mutationEvent({
      attributes: [{ id: 30, attributes: { _CSSTEXT: 'p {}' } }],
    })])).toBeUndefined();
    expect(sanitizer.prepareBatch([mutationEvent({
      attributes: [{ id: 8, attributes: { alt: 42 } }],
    })])).toBeUndefined();
    expect(sanitizer.prepareBatch([mutationEvent({
      texts: [{ id: 31, value: 'p { display: url(https://invalid.example/a); }' }],
    })])).toBeUndefined();
  });

  it('preserves comment-separated rule indexes and protects rewritten preludes', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 35,
      removes: [{ index: 1 }],
    }, 20)])).toBeDefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 37,
      removes: [{ index: 0 }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 37,
      adds: [{ rule: 'aside {}', index: 1 }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 45,
      index: [1],
      set: { property: 'color', value: 'green' },
    }, 20)])).toBeDefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 45,
      adds: [{ rule: 'aside {}', index: [0, 0] }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 45,
      removes: [{ index: 0 }],
    }, 20)])).toBeDefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 47,
      adds: [{ rule: 'p {}', index: [0, 0] }],
    }, 20)])).toBeUndefined();
  });

  it('preserves valid grouping-rule topology while rejecting dynamic CSS preludes', () => {
    const sanitizer = readySanitizer();
    const groupingRule = sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{
        rule: '@media screen {}',
        index: 1,
      }],
    }, 20)]);

    expect(groupingRule).toBeDefined();
    groupingRule?.commit();

    const nestedRule = sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: 'span { color: green; }', index: [1, 0] }],
    }, 21)]);
    expect(nestedRule).toBeDefined();
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      index: [1, 0],
      set: { property: 'color', value: 'blue' },
    }, 22)])).toBeUndefined();
    nestedRule?.commit();
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      index: [1, 0],
      set: { property: 'color', value: 'blue' },
    }, 22)])).toBeDefined();
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: 30,
      index: [1],
      set: { property: 'color', value: 'blue' },
    }, 22)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: '@import url("https://styles.example/live.css");', index: 2 }],
    }, 23)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: '@namespace svg "https://www.w3.org/2000/svg";', index: 0 }],
    }, 23)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{
        rule: '@font-face { font-family: local-test; src: local(local-test); }',
        index: [1, 0],
      }],
    }, 23)])).toBeUndefined();
  });

  it('rejects CSS rule operations whose nested target cannot apply', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      adds: [{ rule: 'span { color: red; }', index: [0, 0] }],
    }, 20)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      removes: [{ index: 1 }],
    }, 20)])).toBeUndefined();
  });

  it('admits compact rrweb StyleOM diffs while removing CSS resources', () => {
    const sanitizer = readySanitizer();
    const prepared = sanitizer.prepareBatch([mutationEvent({
      attributes: [
        {
          id: 4,
          attributes: {
            style: {
              color: 'red',
              'background-image': 'url("https://images.example/live.png")',
              display: false,
              margin: ['2px', 'important'],
            },
          },
        },
      ],
    })]);

    expect(prepared).toBeDefined();
    expect(JSON.stringify(prepared?.events)).not.toContain('images.example');
    expect(prepared?.events).toMatchObject([
      {
        data: {
          attributes: [
            {
              id: 4,
              attributes: {
                style: {
                  color: 'red',
                  'background-image': 'url("about:blank")',
                  display: false,
                  margin: ['2px', 'important'],
                },
              },
            },
          ],
        },
      },
    ]);
  });

  it('tracks constructed stylesheet identity only after its adopted batch commits', () => {
    const sanitizer = readySanitizer();
    expect(sanitizer.hasConstructedStyleIdentity).toBe(false);
    const adopted = sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 1,
        styleIds: [20],
        styles: [
          {
            styleId: 20,
            rules: [{ rule: 'p { color: red; }', index: 0 }],
          },
        ],
      },
      timestamp: 20,
    }]);
    const update = {
      type: 3,
      data: {
        source: 8,
        styleId: 20,
        adds: [{ rule: 'p { color: blue; }', index: 1 }],
      },
      timestamp: 21,
    };

    expect(adopted).toBeDefined();
    expect(sanitizer.hasConstructedStyleIdentity).toBe(false);
    expect(sanitizer.prepareBatch([update])).toBeUndefined();
    adopted?.commit();
    expect(sanitizer.hasConstructedStyleIdentity).toBe(true);
    expect(sanitizer.prepareBatch([update])).toBeDefined();
  });

  it('keeps namespace rules and dependent selectors aligned in adopted sheets', () => {
    const sanitizer = readySanitizer();
    const adopted = sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 1,
        styleIds: [20],
        styles: [{
          styleId: 20,
          rules: [
            { rule: '@namespace svg "urn:source";', index: 0 },
            { rule: 'svg|p { color: red; }', index: 1 },
          ],
        }],
      },
      timestamp: 20,
    }]);

    expect(adopted).toBeDefined();
    expect(JSON.stringify(adopted?.events)).toContain('urn:simul:inert');
    expect(JSON.stringify(adopted?.events)).not.toContain('urn:source');
    adopted?.commit();
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      id: undefined,
      styleId: 20,
      index: [1],
      set: { property: 'color', value: 'blue' },
    }, 21)])).toBeDefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: undefined,
      styleId: 20,
      adds: [{ rule: 'body {}', index: 2 }],
    }, 21)])).toBeUndefined();
  });

  it('validates replaceSync topology for constructed stylesheets only', () => {
    const sanitizer = readySanitizer();
    const adopted = sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 1,
        styleIds: [20],
        styles: [{ styleId: 20, rules: [] }],
      },
      timestamp: 20,
    }]);
    expect(adopted).toBeDefined();
    adopted?.commit();

    const replacement = sanitizer.prepareBatch([styleRuleEvent({
      styleId: 20,
      replaceSync: 'article { display: block; }',
    }, 21)]);
    expect(replacement).toBeDefined();
    replacement?.commit();
    expect(sanitizer.prepareBatch([styleDeclarationEvent({
      styleId: 20,
      index: [0],
      set: { property: 'display', value: 'grid' },
    }, 22)])).toBeDefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      id: 30,
      replaceSync: 'p { color: red; }',
    }, 22)])).toBeUndefined();
    expect(sanitizer.prepareBatch([styleRuleEvent({
      styleId: 20,
      adds: [{ rule: '@import url("https://styles.example/constructed.css");', index: 1 }],
    }, 22)])).toBeUndefined();
  });

  it('requests a checkpoint before constructed stylesheet identity grows unbounded', () => {
    const sanitizer = readySanitizer();
    const styleIds = Array.from(
      { length: MAX_REPLICA_STREAM_STYLE_IDS },
      (_, index) => 20 + index,
    );
    const withinLimit = sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 1,
        styleIds,
        styles: styleIds.map((styleId) => ({ styleId, rules: [] })),
      },
      timestamp: 20,
    }]);
    expect(withinLimit).toBeDefined();
    withinLimit?.commit();

    expect(sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 1,
        styleIds: [MAX_REPLICA_STREAM_STYLE_IDS + 100],
        styles: [{
          styleId: MAX_REPLICA_STREAM_STYLE_IDS + 100,
          rules: [],
        }],
      },
      timestamp: 21,
    }])).toBeUndefined();
  });

  it('accepts adopted stylesheets only on a document or serialized shadow host', () => {
    const sanitizer = readySanitizer();

    expect(sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 4,
        styleIds: [20],
        styles: [{ styleId: 20, rules: [] }],
      },
      timestamp: 20,
    }])).toBeUndefined();
    expect(sanitizer.prepareBatch([{
      type: 3,
      data: {
        source: 15,
        id: 1,
        styleIds: [20, 20],
        styles: [{ styleId: 20, rules: [] }],
      },
      timestamp: 20,
    }])).toBeDefined();
  });

  it('rejects decreasing admitted timestamps transactionally', () => {
    const sanitizer = readySanitizer();
    const first = sanitizer.prepareBatch([
      mutationEvent({ texts: [{ id: 5, value: 'newer' }] }),
    ]);
    expect(first).toBeDefined();
    first?.commit();

    expect(sanitizer.prepareBatch([{
      ...mutationEvent({ texts: [{ id: 5, value: 'older' }] }),
      timestamp: 9,
    }])).toBeUndefined();
  });
});

function readySanitizer(): RrwebStreamSanitizer {
  const checkpoint = createCheckpointEnvelope(
    createReplicaIdentity({
      sessionId: 'session-sanitizer',
      pageEpoch: 1,
      generation: 1,
      documentId: 'document-sanitizer',
      frameId: 0,
      sequence: 0,
    }),
    {
      events: checkpointEvents(),
      captureMs: 1,
      viewportWidth: 800,
      viewportHeight: 600,
      documentWidth: 800,
      documentHeight: 1_200,
    },
  );
  if (checkpoint.kind !== 'simul:replica-v2:checkpoint') {
    throw new Error('Sanitizer checkpoint fixture was rejected.');
  }
  const { document } = parseHTML('<html><head></head><body></body></html>');
  const sanitizer = new RrwebStreamSanitizer(document as unknown as Document);
  if (!sanitizer.reset(checkpoint.payload.events)) {
    throw new Error('Sanitizer checkpoint fixture did not initialize.');
  }
  return sanitizer;
}

function checkpointEvents(): readonly unknown[] {
  return [
    {
      type: 4,
      data: { href: 'https://example.test/', width: 800, height: 600 },
      timestamp: 1,
    },
    {
      type: 2,
      data: {
        node: {
          type: 0,
          id: 1,
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
                  tagName: 'body',
                  attributes: {},
                  childNodes: [
                    {
                      type: 2,
                      id: 4,
                      tagName: 'p',
                      attributes: {},
                      childNodes: [{ type: 3, id: 5, textContent: 'public' }],
                    },
                    {
                      type: 2,
                      id: 6,
                      tagName: 'input',
                      attributes: { value: 'PRIVATE-SNAPSHOT-CANARY' },
                      childNodes: [{ type: 3, id: 7, textContent: 'private' }],
                    },
                    {
                      type: 2,
                      id: 8,
                      tagName: 'img',
                      attributes: { alt: 'image' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 30,
                      tagName: 'style',
                      attributes: { _cssText: 'p { color: black; }' },
                      childNodes: [
                        {
                          type: 3,
                          id: 31,
                          textContent: 'p { color: black; }',
                          isStyle: true,
                        },
                      ],
                    },
                    {
                      type: 2,
                      id: 32,
                      tagName: 'link',
                      attributes: { _cssText: '' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 33,
                      tagName: 'style',
                      attributes: { type: 'text/less', _cssText: 'p {}' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 35,
                      tagName: 'style',
                      attributes: { _cssText: '@media/**/screen { p {} } q {}' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 37,
                      tagName: 'style',
                      attributes: {
                        _cssText: '@import url("https://styles.example/base.css"); p {}',
                      },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 39,
                      tagName: 'style',
                      attributes: { _cssText: 'garbage' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 41,
                      tagName: 'link',
                      attributes: { _cssText: ' ' },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 43,
                      tagName: 'style',
                      attributes: {
                        type: ' text/css ',
                        _cssText: 'p {}',
                      },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 45,
                      tagName: 'style',
                      attributes: {
                        _cssText:
                          '@media all, (simul-inlined-import) { p {} r {} } q {}',
                      },
                      childNodes: [],
                    },
                    {
                      type: 2,
                      id: 47,
                      tagName: 'style',
                      attributes: { _cssText: '@page {}' },
                      childNodes: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        initialOffset: { top: 0, left: 0 },
      },
      timestamp: 2,
    },
  ];
}

function mutationEvent(
  overrides: Partial<{
    texts: unknown[];
    attributes: unknown[];
    removes: unknown[];
    adds: unknown[];
  }>,
): Record<string, unknown> {
  return {
    type: 3,
    data: {
      source: 0,
      texts: overrides.texts ?? [],
      attributes: overrides.attributes ?? [],
      removes: overrides.removes ?? [],
      adds: overrides.adds ?? [],
    },
    timestamp: 10,
  };
}

function scrollEvent(id: number): Record<string, unknown> {
  return {
    type: 3,
    data: { source: 3, id, x: 4, y: 8 },
    timestamp: 11,
  };
}

function styleRuleEvent(
  data: Record<string, unknown>,
  timestamp: number,
): Record<string, unknown> {
  return {
    type: 3,
    data: { source: 8, ...data },
    timestamp,
  };
}

function styleDeclarationEvent(
  data: Record<string, unknown>,
  timestamp: number,
): Record<string, unknown> {
  return {
    type: 3,
    data: { source: 13, ...data },
    timestamp,
  };
}
