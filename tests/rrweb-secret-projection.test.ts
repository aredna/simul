import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  projectRrwebSourceSecretsInCheckpoint,
  projectRrwebSourceSecretsInIncrementalEvent,
  rrwebMutationTouchesSourceSecret,
} from '../lib/replica/rrweb-secret-projection';
import {
  eagerlyClassifySourceDocumentSecrets,
  rememberSourceMutationSecrets,
} from '../lib/replica/semantic-source-session';
import {
  sourceDocumentSecretClassifier,
} from '../lib/replica/source-secret-classifier';
import {
  hasSourceCredentialSecretAncestor,
} from '../lib/replica/source-privacy-policy';

describe('rrweb source secret projection', () => {
  it('projects computed-only secret roots before selectors or descendants cross', () => {
    const { document, window } = parseHTML(
      '<html><body><section class="credential"><img src="private.png"></section></body></html>',
    );
    const section = document.querySelector('section')!;
    const image = document.querySelector('img')!;
    let textSecurity = 'disc';
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        getPropertyValue: (name: string) =>
          name === '-webkit-text-security' && element === section
            ? textSecurity
            : '',
      }),
    });
    Object.defineProperty(document, 'defaultView', {
      configurable: true,
      value: window,
    });
    const nodes = new Map<number, Node>([
      [1, document],
      [2, document.documentElement],
      [3, document.body],
      [4, section],
      [5, image],
    ]);
    const resolveNode = (id: number) => nodes.get(id) ?? null;
    const checkpoint = checkpointEvents();

    const projected = projectRrwebSourceSecretsInCheckpoint(
      checkpoint,
      resolveNode,
    )!;
    expect(serializedNodeById(projected, 4)).toEqual({
      type: 2,
      id: 4,
      tagName: 'simul-opaque-region-4',
      attributes: {},
      childNodes: [],
    });
    expect(JSON.stringify(projected)).not.toContain('private.png');

    // The document-lifetime classifier remains sticky after hostile reversion.
    textSecurity = 'none';
    section.removeAttribute('class');
    const addition = projectRrwebSourceSecretsInIncrementalEvent({
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [{
          parentId: 3,
          nextId: null,
          node: serializedNodeById(checkpoint, 4),
        }],
      },
    }, resolveNode)!;
    expect(JSON.stringify(addition)).toContain('simul-opaque-region-4');
    expect(JSON.stringify(addition)).not.toContain('private.png');
    expect(rrwebMutationTouchesSourceSecret({
      type: 3,
      timestamp: 4,
      data: {
        source: 0,
        texts: [],
        attributes: [{ id: 4, attributes: { class: null } }],
        removes: [],
        adds: [],
      },
    }, resolveNode)).toBe(true);
  });

  it('projects directly slotted secret Text as a sticky opaque identity shell', () => {
    const canary = 'direct-slot-rrweb-secret';
    const { document } = parseHTML(
      '<html><body><x-credential id="host"></x-credential></body></html>',
    );
    const host = document.querySelector('#host')!;
    const text = document.createTextNode(canary);
    host.append(text);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<section autocomplete="webauthn"><slot></slot></section>';
    Object.defineProperty(text, 'assignedSlot', {
      configurable: true,
      value: shadow.querySelector('slot'),
    });
    let contentReads = 0;
    Object.defineProperty(text, 'nodeValue', {
      configurable: true,
      get: () => {
        contentReads += 1;
        return canary;
      },
    });
    const nodes = new Map<number, Node>([
      [4, host],
      [5, text],
    ]);
    const resolveNode = (id: number) => nodes.get(id) ?? null;
    const checkpoint = directSlottedTextCheckpoint(canary);

    const projected = projectRrwebSourceSecretsInCheckpoint(
      checkpoint,
      resolveNode,
    )!;

    expect(serializedNodeById(projected, 5)).toEqual({
      type: 2,
      id: 5,
      tagName: 'simul-opaque-region-5',
      attributes: {},
      childNodes: [],
    });
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(contentReads).toBe(0);
    expect(rrwebMutationTouchesSourceSecret({
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        texts: [{ id: 5, value: canary }],
        attributes: [],
        removes: [],
        adds: [],
      },
    }, resolveNode)).toBe(true);

    Object.defineProperty(text, 'assignedSlot', {
      configurable: true,
      value: null,
    });
    document.body.append(text);
    const addition = projectRrwebSourceSecretsInIncrementalEvent({
      type: 3,
      timestamp: 4,
      data: {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [{
          parentId: 3,
          nextId: null,
          node: serializedNodeById(checkpoint, 5),
        }],
      },
    }, resolveNode)!;
    expect(JSON.stringify(addition)).toContain('simul-opaque-region-5');
    expect(JSON.stringify(addition)).not.toContain(canary);
    expect(contentReads).toBe(0);
  });

  it('keeps eagerly primed secret Text opaque after a public move', () => {
    const canary = 'rrweb-ancestor-text-move-secret';
    const { document, window } = parseHTML(
      `<html><body><section autocomplete="one-time-code"><span id="payload">${canary}</span></section><main id="public"></main></body></html>`,
    );
    const text = document.querySelector('#payload')!.firstChild!;
    eagerlyClassifySourceDocumentSecrets(
      document,
      window as unknown as Window,
    );
    document.querySelector('#public')!.append(text);
    let contentReads = 0;
    Object.defineProperty(text, 'nodeValue', {
      configurable: true,
      get: () => {
        contentReads += 1;
        return canary;
      },
    });
    const resolveNode = (id: number) => id === 5 ? text : null;
    const event = {
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [{
          parentId: 3,
          nextId: null,
          node: { type: 3, id: 5, textContent: canary },
        }],
      },
    };

    const first = projectRrwebSourceSecretsInIncrementalEvent(
      event,
      resolveNode,
    )!;
    const reconnected = projectRrwebSourceSecretsInIncrementalEvent(
      event,
      resolveNode,
    )!;

    for (const projected of [first, reconnected]) {
      expect(JSON.stringify(projected)).toContain('simul-opaque-region-5');
      expect(JSON.stringify(projected)).not.toContain(canary);
    }
    expect(contentReads).toBe(0);
  });

  it('projects Text tainted by a sticky removal target after public addition', () => {
    const canary = 'rrweb-removal-history-secret';
    const { document, window } = parseHTML(
      `<html><body><section id="secret" autocomplete="webauthn">${canary}</section><main id="public"></main></body></html>`,
    );
    const secret = document.querySelector('#secret')!;
    const publicTarget = document.querySelector('#public')!;
    const text = secret.firstChild!;
    const classifier = sourceDocumentSecretClassifier(document);
    expect(hasSourceCredentialSecretAncestor(
      secret,
      classifier,
      window as unknown as Window,
    )).toBe(true);
    expect(classifier.isSecret(text)).toBe(false);

    publicTarget.append(text);
    rememberSourceMutationSecrets([
      {
        type: 'childList',
        target: secret,
        addedNodes: [] as unknown as NodeList,
        removedNodes: [text] as unknown as NodeList,
      } as unknown as MutationRecord,
      {
        type: 'childList',
        target: publicTarget,
        addedNodes: [text] as unknown as NodeList,
        removedNodes: [] as unknown as NodeList,
      } as unknown as MutationRecord,
    ], window as unknown as Window, classifier);
    const projected = projectRrwebSourceSecretsInIncrementalEvent({
      type: 3,
      timestamp: 3,
      data: {
        source: 0,
        texts: [],
        attributes: [],
        removes: [],
        adds: [{
          parentId: 3,
          nextId: null,
          node: { type: 3, id: 5, textContent: canary },
        }],
      },
    }, (id) => id === 5 ? text : null)!;

    expect(JSON.stringify(projected)).toContain('simul-opaque-region-5');
    expect(JSON.stringify(projected)).not.toContain(canary);
  });
});

function checkpointEvents(): readonly unknown[] {
  return [{
    type: 4,
    timestamp: 1,
    data: { href: 'https://example.test/', width: 800, height: 600 },
  }, {
    type: 2,
    timestamp: 2,
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [{
          type: 2,
          id: 2,
          tagName: 'html',
          attributes: {},
          childNodes: [{
            type: 2,
            id: 3,
            tagName: 'body',
            attributes: {},
            childNodes: [{
              type: 2,
              id: 4,
              tagName: 'section',
              attributes: { class: 'credential' },
              childNodes: [{
                type: 2,
                id: 5,
                tagName: 'img',
                attributes: { src: 'private.png' },
                childNodes: [],
              }],
            }],
          }],
        }],
      },
    },
  }];
}

function directSlottedTextCheckpoint(canary: string): readonly unknown[] {
  return [{
    type: 4,
    timestamp: 1,
    data: { href: 'https://example.test/', width: 800, height: 600 },
  }, {
    type: 2,
    timestamp: 2,
    data: {
      initialOffset: { top: 0, left: 0 },
      node: {
        type: 0,
        id: 1,
        childNodes: [{
          type: 2,
          id: 2,
          tagName: 'html',
          attributes: {},
          childNodes: [{
            type: 2,
            id: 3,
            tagName: 'body',
            attributes: {},
            childNodes: [{
              type: 2,
              id: 4,
              tagName: 'x-credential',
              attributes: {},
              childNodes: [{
                type: 3,
                id: 5,
                textContent: canary,
              }],
            }],
          }],
        }],
      },
    },
  }];
}

function serializedNodeById(
  input: readonly unknown[],
  id: number,
): Record<string, unknown> | undefined {
  const pending: unknown[] = [...input];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (record.id === id) return record;
    pending.push(...Object.values(record));
  }
  return undefined;
}
