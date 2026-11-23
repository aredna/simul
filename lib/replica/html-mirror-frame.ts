/**
 * Another site's frame in the mirror (D246). Simul's reader in the page
 * cannot see inside a frame from another site (Google's sign-in button, an
 * embedded form): Chrome keeps the frame's document from the page. The panel
 * runs a second reader in the frame itself, and the page's reader puts what
 * it reads in the box the frame holds (D239), as the page shows it.
 *
 * - The page's reader asks the panel for its frames (`frames`) when it holds
 *   a frame it has nothing for.
 * - The panel runs the reader in each frame of the page's own frames and
 *   says so to the page's reader (`frames-ready`).
 * - The page's reader posts each frame it holds a token, the one link
 *   between a frame element and the frame's document. A frame inside a
 *   shadow root is not in `window.frames`, so its index cannot be used.
 * - The frame's reader reads its document, with the read profile of the
 *   page, and sends it with the token to the panel, which hands it to the
 *   page's reader. What a frame reads never goes through the page: only the
 *   token does.
 */
import type {
  HtmlMirrorDocumentContent,
  HtmlMirrorElementNode,
  HtmlMirrorHeldBox,
  HtmlMirrorNode,
} from './html-mirror-sanitizer';
import type { HtmlMirrorLimitSettings } from './html-mirror-limits';
import { sourceSecretPlaceholderTagName } from './source-secret-classifier';
import {
  isSelectableReplicaFidelityPolicy,
  type SelectableReplicaFidelityPolicy,
} from './fidelity-policy';

/**
 * `HTML_MIRROR_PROTOCOL_VERSION`, written here: the sanitizer imports this
 * module, and the protocol imports the sanitizer.
 */
const HTML_MIRROR_PROTOCOL_VERSION = 2 as const;

export const HTML_MIRROR_FRAME_PORT_PREFIX = 'simul:html-mirror-frame-v1:';
/** The key of the token the page's reader posts a frame. */
export const HTML_MIRROR_FRAME_TOKEN_KEY = 'simulHtmlMirrorFrameToken';
/** The most frames of one page the panel reads. */
export const MAX_HTML_MIRROR_FRAMES = 12;
/** A frame larger than this stays a blank box. */
export const MAX_HTML_MIRROR_FRAME_NODES = 4_000;
export const MAX_HTML_MIRROR_FRAME_BYTES = 1_000_000;
/**
 * IDs of what a frame holds, in the page's mirror: far above the IDs the
 * page's reader gives its own nodes, which count up from 1.
 */
const FRAME_NODE_ID_BASE = 2 ** 50;

export type HtmlMirrorFrameGraph = HtmlMirrorDocumentContent;

export interface HtmlMirrorFrameStart {
  readonly kind: 'simul:html-mirror-frame-v1:start';
  readonly fidelityPolicy: SelectableReplicaFidelityPolicy;
  readonly limits?: HtmlMirrorLimitSettings;
  readonly showEverything?: boolean;
}

export interface HtmlMirrorFrameContent {
  readonly kind: 'simul:html-mirror-frame-v1:content';
  readonly token: string;
  /** Null: the frame cannot be shown (too large, or it could not be read). */
  readonly graph: HtmlMirrorFrameGraph | null;
}

/** From the page's reader to the panel: it holds a frame it has nothing for. */
export interface HtmlMirrorFramesWanted {
  readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
  readonly kind: 'simul:html-mirror-v2:frames';
}

/** From the panel to the page's reader. */
export type HtmlMirrorFrameControllerMessage =
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v2:frames-ready';
      readonly sessionId: string;
    }
  | {
      readonly protocolVersion: typeof HTML_MIRROR_PROTOCOL_VERSION;
      readonly kind: 'simul:html-mirror-v2:frame-content';
      readonly sessionId: string;
      readonly token: string;
      readonly graph: unknown;
    };

export function createHtmlMirrorFramePortName(sessionId: string): string {
  if (!isSafeToken(sessionId)) throw new Error('Invalid HTML mirror session.');
  return `${HTML_MIRROR_FRAME_PORT_PREFIX}${sessionId}`;
}

export function readHtmlMirrorFramePortSessionId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(HTML_MIRROR_FRAME_PORT_PREFIX)) {
    return undefined;
  }
  const sessionId = value.slice(HTML_MIRROR_FRAME_PORT_PREFIX.length);
  return isSafeToken(sessionId) ? sessionId : undefined;
}

export function readHtmlMirrorFrameStart(input: unknown): HtmlMirrorFrameStart | undefined {
  if (
    !isRecord(input) ||
    input.kind !== 'simul:html-mirror-frame-v1:start' ||
    !isSelectableReplicaFidelityPolicy(input.fidelityPolicy) ||
    (input.showEverything !== undefined && typeof input.showEverything !== 'boolean') ||
    (input.limits !== undefined && !isRecord(input.limits))
  ) return undefined;
  return {
    kind: input.kind,
    fidelityPolicy: input.fidelityPolicy,
    ...(input.limits !== undefined
      ? { limits: input.limits as unknown as HtmlMirrorLimitSettings }
      : {}),
    ...(input.showEverything !== undefined ? { showEverything: input.showEverything } : {}),
  };
}

/** The shape only: the page's reader checks the graph itself. */
export function readHtmlMirrorFrameContent(input: unknown): HtmlMirrorFrameContent | undefined {
  if (
    !isRecord(input) ||
    input.kind !== 'simul:html-mirror-frame-v1:content' ||
    !isFrameToken(input.token) ||
    (input.graph !== null && !isRecord(input.graph))
  ) return undefined;
  return input as unknown as HtmlMirrorFrameContent;
}

export function isHtmlMirrorFramesWanted(input: unknown): boolean {
  return isRecord(input) &&
    input.protocolVersion === HTML_MIRROR_PROTOCOL_VERSION &&
    input.kind === 'simul:html-mirror-v2:frames';
}

export function readHtmlMirrorFrameControllerMessage(
  input: unknown,
  expectedSessionId: string,
): HtmlMirrorFrameControllerMessage | undefined {
  if (
    !isRecord(input) ||
    input.protocolVersion !== HTML_MIRROR_PROTOCOL_VERSION ||
    input.sessionId !== expectedSessionId
  ) return undefined;
  if (input.kind === 'simul:html-mirror-v2:frames-ready') {
    return input as unknown as HtmlMirrorFrameControllerMessage;
  }
  if (
    input.kind === 'simul:html-mirror-v2:frame-content' &&
    isFrameToken(input.token) &&
    (input.graph === null || isRecord(input.graph))
  ) return input as unknown as HtmlMirrorFrameControllerMessage;
  return undefined;
}

export function isFrameToken(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{16,64}$/u.test(value);
}

/**
 * Whether the frame this runs in is one of the page's own frames, the
 * frames whose box the page's reader holds. Injected on its own by the
 * panel: it references nothing outside its body.
 */
export function probeHtmlMirrorChildFrame(): boolean {
  try {
    return window.top !== window && window.parent === window.top;
  } catch {
    return false;
  }
}

/** The number of nodes in a graph, its elements' roots counted. */
export function countHtmlMirrorNodes(node: HtmlMirrorNode): number {
  let count = 0;
  const pending: HtmlMirrorNode[] = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    count += 1;
    if (current.kind === 'text') continue;
    pending.push(...current.children);
    if (current.shadowRoot) {
      count += 1;
      pending.push(...current.shadowRoot.children);
    }
  }
  return count;
}

/** How deep a graph goes, its elements' roots counted as a level. */
export function htmlMirrorGraphDepth(node: HtmlMirrorNode): number {
  let deepest = 0;
  const pending: Array<readonly [HtmlMirrorNode, number]> = [[node, 1]];
  while (pending.length > 0) {
    const [current, depth] = pending.pop()!;
    deepest = Math.max(deepest, depth);
    if (current.kind === 'text') continue;
    for (const child of current.children) pending.push([child, depth + 1]);
    if (current.shadowRoot) {
      for (const child of current.shadowRoot.children) pending.push([child, depth + 2]);
    }
  }
  return deepest;
}

let nextFrameNodeId = FRAME_NODE_ID_BASE;

function takeFrameNodeId(): number {
  const id = nextFrameNodeId;
  nextFrameNodeId += 1;
  return id;
}

/**
 * What stands for a frame in the page's mirror: a `<div>` of the frame's box
 * whose shadow root holds the frame's document, `<html>` and all, under IDs
 * of the page's mirror. The root keeps the frame's sheets to the frame, and
 * its first sheet makes the box what the frame is in the tab: of its size,
 * nothing of the page's style on it, and the containing block of what the
 * frame places fixed. Each call gives the frame's nodes new IDs: the mirror
 * replaces the whole box when the frame changes.
 */
export function htmlMirrorFrameInsetNode(
  id: number,
  heldBox: HtmlMirrorHeldBox,
  graph: HtmlMirrorFrameGraph,
): HtmlMirrorElementNode {
  const ids = new Map<number, number>();
  const copy = (node: HtmlMirrorNode): HtmlMirrorNode => {
    const newId = takeFrameNodeId();
    ids.set(node.id, newId);
    if (node.kind === 'text') return Object.freeze({ ...node, id: newId });
    // A placeholder's name is made of its ID.
    const tagName = node.opaquePlaceholder
      ? sourceSecretPlaceholderTagName(newId)
      : node.tagName;
    const children = Object.freeze(node.children.map(copy));
    const shadowRoot = node.shadowRoot && (() => {
      const rootId = takeFrameNodeId();
      ids.set(node.shadowRoot.id, rootId);
      return Object.freeze({
        ...node.shadowRoot,
        id: rootId,
        children: Object.freeze(node.shadowRoot.children.map(copy)),
      });
    })();
    return Object.freeze({
      ...node,
      id: newId,
      tagName,
      children,
      ...(shadowRoot ? { shadowRoot } : {}),
    });
  };
  const root = copy(graph.root) as HtmlMirrorElementNode;
  // Slots assigned by script name the frame's nodes: renamed after the copy.
  const rename = (node: HtmlMirrorNode): HtmlMirrorNode => {
    if (node.kind === 'text') return node;
    const assigned = node.assignedNodeIds?.map((value) => ids.get(value))
      .filter((value): value is number => value !== undefined);
    const children = node.children.map(rename);
    const shadowRoot = node.shadowRoot && Object.freeze({
      ...node.shadowRoot,
      children: Object.freeze(node.shadowRoot.children.map(rename)),
    });
    return Object.freeze({
      ...node,
      children: Object.freeze(children),
      ...(shadowRoot ? { shadowRoot } : {}),
      ...(assigned ? { assignedNodeIds: Object.freeze(assigned) } : {}),
    });
  };
  const hasAssigned = (node: HtmlMirrorNode): boolean =>
    node.kind === 'element' && (
      node.assignedNodeIds !== undefined ||
      node.children.some(hasAssigned) ||
      (node.shadowRoot?.children.some(hasAssigned) ?? false)
    );
  const content = hasAssigned(root) ? rename(root) : root;
  return Object.freeze({
    kind: 'element',
    id,
    namespace: 'html',
    tagName: 'div',
    attributes: Object.freeze([]),
    children: Object.freeze([]),
    shadowRoot: Object.freeze({
      id: takeFrameNodeId(),
      mode: 'open',
      children: Object.freeze([content]),
      adoptedStyleSheets: Object.freeze([
        htmlMirrorFrameBoxCss(heldBox),
        ...graph.adoptedStyleSheets,
      ]),
    }),
  });
}

/**
 * The frame's box: what the tab gives the frame, and nothing the page's
 * style gives the mirror's `<div>`. Important declarations in a root
 * outrank the page's at the boundary.
 */
export function htmlMirrorFrameBoxCss(box: HtmlMirrorHeldBox): string {
  const px = (value: number) => `${Number.isFinite(value) ? value : 0}px`;
  const [top, right, bottom, left] = box.margin;
  return `:host{all:initial!important;display:${box.block ? 'block' : 'inline-block'}!important;` +
    `box-sizing:border-box!important;width:${px(box.width)}!important;` +
    `height:${px(box.height)}!important;max-width:100%!important;` +
    `margin:${px(top)} ${px(right)} ${px(bottom)} ${px(left)}!important;` +
    'vertical-align:baseline!important;overflow:hidden!important;' +
    'position:relative!important;contain:layout paint!important}';
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
