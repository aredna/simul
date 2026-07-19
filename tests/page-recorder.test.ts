import { describe, expect, it } from 'vitest';

import { captureMaskedCheckpoint } from '../lib/replica/page-recorder';
import {
  MAX_REPLICA_STRING_LENGTH,
  createReplicaIdentity,
} from '../lib/replica/protocol-v2';

const identity = createReplicaIdentity({
  sessionId: 'session-recorder',
  pageEpoch: 1,
  generation: 1,
  documentId: 'document-recorder',
  frameId: 0,
  sequence: 0,
});

describe('page recorder checkpoint', () => {
  it('configures one full masked snapshot with interaction and canvas tails disabled', async () => {
    let observedOptions: Record<string, unknown> | undefined;
    let stopped = false;
    const sourceWindow = createWindow();
    const response = await captureMaskedCheckpoint(identity, {
      document: createDocument(),
      window: sourceWindow,
      now: increasingClock(),
      start: (options) => {
        observedOptions = options as unknown as Record<string, unknown>;
        options.emit({
          type: 4,
          data: { href: 'https://example.test/', width: 800, height: 600 },
          timestamp: 1,
        });
        options.emit({
          type: 2,
          data: {
            node: {
              type: 0,
              id: 1,
              childNodes: [
                {
                  type: 2,
                  id: 2,
                  tagName: 'textarea',
                  attributes: {},
                  childNodes: [
                    { type: 3, id: 3, textContent: 'RECORDER-PRIVATE-CANARY' },
                  ],
                },
              ],
            },
            initialOffset: { top: 0, left: 0 },
          },
          timestamp: 2,
        });
        return () => {
          stopped = true;
        };
      },
    });

    expect(response.kind).toBe('simul:replica-v2:checkpoint');
    expect(JSON.stringify(response)).not.toContain('RECORDER-PRIVATE-CANARY');
    expect(observedOptions).toMatchObject({
      maskAllInputs: true,
      inlineStylesheet: true,
      inlineImages: false,
      recordCanvas: false,
      recordCrossOriginIframes: false,
      collectFonts: false,
      userTriggeredOnInput: false,
      blockSelector: 'iframe,frame',
      sampling: { mousemove: false, mouseInteraction: false },
    });
    expect(stopped).toBe(true);
  });

  it('fails closed outside the requested top-frame identity', async () => {
    const childWindow = createWindow();
    Object.defineProperty(childWindow, 'top', {
      configurable: true,
      value: {} as Window,
    });

    await expect(
      captureMaskedCheckpoint(identity, {
        document: createDocument(),
        window: childWindow,
      }),
    ).resolves.toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'capture_failed' },
    });
  });

  it('rejects an oversized source before starting synchronous rrweb capture', async () => {
    const oversizedDocument = createDocument() as Document & {
      childNodes: NodeListOf<ChildNode>;
      nodeType: number;
      styleSheets: StyleSheetList;
    };
    const oversizedText = {
      nodeType: 3,
      nodeValue: 'x'.repeat(MAX_REPLICA_STRING_LENGTH + 1),
      childNodes: nodeList(),
    } as unknown as ChildNode;
    Object.defineProperties(oversizedDocument, {
      nodeType: { configurable: true, value: 9 },
      childNodes: { configurable: true, value: nodeList(oversizedText) },
      styleSheets: { configurable: true, value: [] },
    });
    let recorderStarted = false;

    const response = await captureMaskedCheckpoint(identity, {
      document: oversizedDocument,
      window: createWindow(),
      start: () => {
        recorderStarted = true;
        return () => undefined;
      },
    });

    expect(response).toMatchObject({
      kind: 'simul:replica-v2:checkpoint-error',
      payload: { code: 'checkpoint_too_large' },
    });
    expect(recorderStarted).toBe(false);
  });
});

function createWindow(): Window {
  const sourceWindow = {
    innerWidth: 800,
    innerHeight: 600,
  } as unknown as Window;
  Object.defineProperty(sourceWindow, 'top', {
    configurable: true,
    value: sourceWindow,
  });
  return sourceWindow;
}

function createDocument(): Document {
  return {
    documentElement: { scrollWidth: 1_200, scrollHeight: 2_000 },
    body: { scrollWidth: 1_100, scrollHeight: 1_900 },
  } as unknown as Document;
}

function increasingClock(): () => number {
  let value = 0;
  return () => ++value;
}

function nodeList(...nodes: ChildNode[]): NodeListOf<ChildNode> {
  return {
    length: nodes.length,
    item: (index: number) => nodes[index] ?? null,
    forEach: (callback: (value: ChildNode, key: number, parent: NodeListOf<ChildNode>) => void) => {
      const list = nodeList(...nodes);
      nodes.forEach((node, index) => callback(node, index, list));
    },
    [Symbol.iterator]: () => nodes[Symbol.iterator](),
    entries: () => nodes.entries(),
    keys: () => nodes.keys(),
    values: () => nodes.values(),
  } as NodeListOf<ChildNode>;
}
