import {
  REPLICA_PROTOCOL_VERSION,
  type ReplicaCheckpointCommand,
  type ReplicaCheckpointEnvelope,
  type ReplicaCheckpointErrorEnvelope,
  type ReplicaCheckpointResponse,
  type ReplicaDocumentIdentity,
} from './contracts';

export const MAX_REPLICA_CHECKPOINT_BYTES = 8 * 1024 * 1024;
export const MAX_REPLICA_EVENTS = 4;
export const MAX_REPLICA_NODES = 50_000;
export const MAX_REPLICA_NODE_DEPTH = 64;
export const MAX_REPLICA_STRING_LENGTH = 512 * 1024;
export const MAX_REPLICA_DIMENSION = 1_000_000;

const RRWEB_FULL_SNAPSHOT_EVENT = 2;
const RRWEB_META_EVENT = 4;
const RRWEB_DOCUMENT_NODE = 0;
const RRWEB_DOCUMENT_TYPE_NODE = 1;
const RRWEB_ELEMENT_NODE = 2;
const RRWEB_TEXT_NODE = 3;
const RRWEB_CDATA_NODE = 4;
const RRWEB_COMMENT_NODE = 5;

const UNSAFE_ELEMENT_NAMES = new Set([
  'animate',
  'animatecolor',
  'animatemotion',
  'animatetransform',
  'applet',
  'base',
  'discard',
  'embed',
  'fencedframe',
  'frame',
  'frameset',
  'iframe',
  'mpath',
  'object',
  'portal',
  'script',
  'set',
  'webview',
]);
const NETWORK_ATTRIBUTE_NAMES = new Set([
  'action',
  'archive',
  'background',
  'cite',
  'classid',
  'code',
  'codebase',
  'data',
  'dynsrc',
  'formaction',
  'href',
  'icon',
  'imagesrcset',
  'longdesc',
  'lowsrc',
  'manifest',
  'ping',
  'poster',
  'profile',
  'src',
  'srcdoc',
  'srcset',
  'usemap',
  'xlink:href',
]);
const CSS_RESOURCE_ATTRIBUTE_NAMES = new Set([
  'clip-path',
  'cursor',
  'fill',
  'filter',
  'marker',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
]);
const PRIVATE_ELEMENT_NAMES = new Set([
  'input',
  'option',
  'output',
  'select',
  'textarea',
]);
const PRIVATE_CONTROL_ROLES = new Set([
  'checkbox',
  'combobox',
  'listbox',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
]);
const PRIVATE_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'hidden',
  'image',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'reset',
  'search',
  'submit',
  'tel',
  'text',
  'time',
  'url',
  'week',
]);

interface NodeBudget {
  count: number;
  bytes: number;
  ids: Set<number>;
}

export function createReplicaIdentity(
  value: Omit<ReplicaDocumentIdentity, 'protocolVersion'>,
): ReplicaDocumentIdentity {
  return Object.freeze({
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    ...value,
  });
}

export function createCheckpointCommand(
  identity: ReplicaDocumentIdentity,
): ReplicaCheckpointCommand {
  return Object.freeze({
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:capture-checkpoint',
    identity,
  });
}

export function readCheckpointCommand(
  input: unknown,
): ReplicaCheckpointCommand | undefined {
  if (!isRecordWithExactKeys(input, ['protocolVersion', 'kind', 'identity'])) {
    return undefined;
  }
  if (
    input.protocolVersion !== REPLICA_PROTOCOL_VERSION ||
    input.kind !== 'simul:replica-v2:capture-checkpoint'
  ) {
    return undefined;
  }
  const identity = readReplicaIdentity(input.identity);
  return identity ? createCheckpointCommand(identity) : undefined;
}

export function createCheckpointError(
  identity: ReplicaDocumentIdentity,
  code: ReplicaCheckpointErrorEnvelope['payload']['code'],
): ReplicaCheckpointErrorEnvelope {
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:checkpoint-error',
    identity,
    payload: { code },
  };
}

export function createCheckpointEnvelope(
  identity: ReplicaDocumentIdentity,
  input: {
    events: readonly unknown[];
    captureMs: number;
    viewportWidth: number;
    viewportHeight: number;
    documentWidth: number;
    documentHeight: number;
  },
): ReplicaCheckpointEnvelope | ReplicaCheckpointErrorEnvelope {
  const rawShape = inspectBoundedJsonShape(input.events);
  if (rawShape === 'too_large') {
    return createCheckpointError(identity, 'checkpoint_too_large');
  }
  if (rawShape === 'invalid') {
    return createCheckpointError(identity, 'privacy_rejected');
  }
  const sanitizedEvents = sanitizeRrwebCheckpointEvents(input.events);
  if (!sanitizedEvents) {
    return createCheckpointError(identity, 'privacy_rejected');
  }
  const byteLength = jsonByteLength(sanitizedEvents);
  if (byteLength > MAX_REPLICA_CHECKPOINT_BYTES) {
    return createCheckpointError(identity, 'checkpoint_too_large');
  }
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:checkpoint',
    identity,
    payload: {
      events: sanitizedEvents,
      byteLength,
      captureMs: boundedDuration(input.captureMs),
      viewportWidth: boundedDimension(input.viewportWidth),
      viewportHeight: boundedDimension(input.viewportHeight),
      documentWidth: boundedDimension(input.documentWidth),
      documentHeight: boundedDimension(input.documentHeight),
    },
  };
}

export function readCheckpointResponse(
  input: unknown,
  expectedIdentity: ReplicaDocumentIdentity,
): ReplicaCheckpointResponse | undefined {
  if (!isRecord(input)) return undefined;
  if (
    input.protocolVersion !== REPLICA_PROTOCOL_VERSION ||
    (input.kind !== 'simul:replica-v2:checkpoint' &&
      input.kind !== 'simul:replica-v2:checkpoint-error')
  ) {
    return undefined;
  }
  if (!hasOnlyKeys(input, ['protocolVersion', 'kind', 'identity', 'payload'])) {
    return undefined;
  }
  const identity = readReplicaIdentity(input.identity);
  if (!identity || !sameReplicaIdentity(identity, expectedIdentity)) return undefined;

  if (input.kind === 'simul:replica-v2:checkpoint-error') {
    if (!isRecordWithExactKeys(input.payload, ['code'])) return undefined;
    const code = input.payload.code;
    if (
      code !== 'capture_busy' &&
      code !== 'capture_failed' &&
      code !== 'capture_timeout' &&
      code !== 'checkpoint_too_large' &&
      code !== 'privacy_rejected'
    ) return undefined;
    return createCheckpointError(identity, code);
  }

  if (
    !isRecordWithExactKeys(input.payload, [
      'events',
      'byteLength',
      'captureMs',
      'viewportWidth',
      'viewportHeight',
      'documentWidth',
      'documentHeight',
    ]) ||
    !Array.isArray(input.payload.events) ||
    !isBoundedInteger(input.payload.byteLength, 0, MAX_REPLICA_CHECKPOINT_BYTES) ||
    !isBoundedNumber(input.payload.captureMs, 0, 60_000) ||
    !isDimension(input.payload.viewportWidth) ||
    !isDimension(input.payload.viewportHeight) ||
    !isDimension(input.payload.documentWidth) ||
    !isDimension(input.payload.documentHeight)
  ) return undefined;

  if (inspectBoundedJsonShape(input.payload.events) !== 'valid') return undefined;
  const rawByteLength = jsonByteLength(input.payload.events);
  if (
    rawByteLength !== input.payload.byteLength ||
    rawByteLength > MAX_REPLICA_CHECKPOINT_BYTES
  ) return undefined;
  const sanitizedEvents = sanitizeRrwebCheckpointEvents(input.payload.events);
  if (!sanitizedEvents) return undefined;
  const sanitizedByteLength = jsonByteLength(sanitizedEvents);
  if (sanitizedByteLength > MAX_REPLICA_CHECKPOINT_BYTES) return undefined;

  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    kind: 'simul:replica-v2:checkpoint',
    identity,
    payload: {
      events: sanitizedEvents,
      byteLength: sanitizedByteLength,
      captureMs: input.payload.captureMs,
      viewportWidth: input.payload.viewportWidth,
      viewportHeight: input.payload.viewportHeight,
      documentWidth: input.payload.documentWidth,
      documentHeight: input.payload.documentHeight,
    },
  };
}

export function readReplicaIdentity(
  input: unknown,
): ReplicaDocumentIdentity | undefined {
  if (
    !isRecordWithExactKeys(input, [
      'protocolVersion',
      'sessionId',
      'pageEpoch',
      'generation',
      'documentId',
      'frameId',
      'sequence',
    ]) ||
    input.protocolVersion !== REPLICA_PROTOCOL_VERSION ||
    !isSafeToken(input.sessionId) ||
    !isBoundedInteger(input.pageEpoch, 1, Number.MAX_SAFE_INTEGER) ||
    !isBoundedInteger(input.generation, 1, Number.MAX_SAFE_INTEGER) ||
    input.pageEpoch !== input.generation ||
    !isSafeToken(input.documentId) ||
    !isBoundedInteger(input.frameId, 0, 1_000_000) ||
    !isBoundedInteger(input.sequence, 0, Number.MAX_SAFE_INTEGER)
  ) return undefined;
  return createReplicaIdentity({
    sessionId: input.sessionId,
    pageEpoch: input.pageEpoch,
    generation: input.generation,
    documentId: input.documentId,
    frameId: input.frameId,
    sequence: input.sequence,
  });
}

export function sameReplicaIdentity(
  left: ReplicaDocumentIdentity,
  right: ReplicaDocumentIdentity,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.sessionId === right.sessionId &&
    left.pageEpoch === right.pageEpoch &&
    left.generation === right.generation &&
    left.documentId === right.documentId &&
    left.frameId === right.frameId &&
    left.sequence === right.sequence
  );
}

/**
 * Projects rrweb's initial meta/full-snapshot pair into a scriptless,
 * control-masked, resource-inert subset before transport and again before
 * replay. Unknown or malformed node shapes fail closed.
 */
export function sanitizeRrwebCheckpointEvents(
  events: readonly unknown[],
): readonly unknown[] | undefined {
  if (events.length < 2 || events.length > MAX_REPLICA_EVENTS) return undefined;
  const sanitized: unknown[] = [];
  let metaCount = 0;
  let snapshotCount = 0;
  const budget: NodeBudget = { count: 0, bytes: 0, ids: new Set() };

  for (const event of events) {
    if (!isRecord(event) || !hasOnlyKeys(event, ['type', 'data', 'timestamp', 'delay'])) {
      return undefined;
    }
    if (!isBoundedNumber(event.timestamp, 0, Number.MAX_SAFE_INTEGER)) return undefined;
    if ('delay' in event && !isBoundedNumber(event.delay, 0, 60_000)) return undefined;
    if (event.type === RRWEB_META_EVENT) {
      if (++metaCount > 1 || snapshotCount > 0) return undefined;
      const data = sanitizeMetaData(event.data);
      if (!data) return undefined;
      sanitized.push({ type: RRWEB_META_EVENT, data, timestamp: event.timestamp });
      continue;
    }
    if (event.type === RRWEB_FULL_SNAPSHOT_EVENT) {
      if (metaCount !== 1 || ++snapshotCount > 1 || !isRecord(event.data)) {
        return undefined;
      }
      if (!hasOnlyKeys(event.data, ['node', 'initialOffset'])) return undefined;
      const node = sanitizeSerializedNode(
        event.data.node,
        false,
        false,
        0,
        budget,
      );
      const offset = event.data.initialOffset;
      if (
        !node ||
        !isRecordWithExactKeys(offset, ['top', 'left']) ||
        !isBoundedNumber(offset.top, -MAX_REPLICA_DIMENSION, MAX_REPLICA_DIMENSION) ||
        !isBoundedNumber(offset.left, -MAX_REPLICA_DIMENSION, MAX_REPLICA_DIMENSION)
      ) return undefined;
      sanitized.push({
        type: RRWEB_FULL_SNAPSHOT_EVENT,
        data: { node, initialOffset: { top: offset.top, left: offset.left } },
        timestamp: event.timestamp,
      });
      continue;
    }
    return undefined;
  }
  return metaCount === 1 && snapshotCount === 1 ? Object.freeze(sanitized) : undefined;
}

function sanitizeMetaData(input: unknown): Record<string, unknown> | undefined {
  if (!isRecordWithExactKeys(input, ['href', 'width', 'height'])) return undefined;
  if (!isDimension(input.width) || !isDimension(input.height)) return undefined;
  return {
    href: sanitizePageUrl(input.href),
    width: input.width,
    height: input.height,
  };
}

function sanitizeSerializedNode(
  input: unknown,
  privateRegion: boolean,
  styleRegion: boolean,
  depth: number,
  budget: NodeBudget,
): Record<string, unknown> | undefined {
  if (!isRecord(input) || depth > MAX_REPLICA_NODE_DEPTH) return undefined;
  if (!isBoundedInteger(input.id, 1, Number.MAX_SAFE_INTEGER)) return undefined;
  if (budget.ids.has(input.id) || ++budget.count > MAX_REPLICA_NODES) return undefined;
  if (!consumeNodeBudget(budget, 96)) return undefined;
  budget.ids.add(input.id);
  if (!isBoundedInteger(input.type, 0, RRWEB_COMMENT_NODE)) return undefined;

  const identityFields: Record<string, unknown> = { type: input.type, id: input.id };
  for (const key of ['rootId', 'isShadowHost', 'isShadow'] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (key === 'rootId') {
      if (!isBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER)) return undefined;
    } else if (typeof value !== 'boolean') return undefined;
    identityFields[key] = value;
  }

  switch (input.type) {
    case RRWEB_DOCUMENT_NODE: {
      if (!Array.isArray(input.childNodes)) return undefined;
      const children = sanitizeChildren(
        input.childNodes,
        privateRegion,
        styleRegion,
        depth,
        budget,
      );
      if (!children) return undefined;
      return {
        ...identityFields,
        childNodes: children,
        ...(typeof input.compatMode === 'string'
          ? { compatMode: boundedString(input.compatMode, 64) }
          : {}),
      };
    }
    case RRWEB_DOCUMENT_TYPE_NODE:
      if (
        typeof input.name !== 'string' ||
        typeof input.publicId !== 'string' ||
        typeof input.systemId !== 'string' ||
        input.name.length > 128 ||
        input.publicId.length > 2_048 ||
        !consumeNodeBudget(
          budget,
          (input.name.length + input.publicId.length) * 2,
        )
      ) return undefined;
      return {
        ...identityFields,
        name: boundedString(input.name, 128),
        publicId: boundedString(input.publicId, 2_048),
        systemId: '',
      };
    case RRWEB_ELEMENT_NODE: {
      if (
        typeof input.tagName !== 'string' ||
        !isRecord(input.attributes) ||
        !Array.isArray(input.childNodes)
      ) return undefined;
      const tagName = input.tagName.toLowerCase();
      if (!/^[a-z][a-z0-9:_-]{0,63}$/u.test(tagName)) return undefined;
      if (!consumeNodeBudget(budget, tagName.length * 2)) return undefined;
      if (UNSAFE_ELEMENT_NAMES.has(tagName)) return undefined;
      const nextPrivateRegion =
        privateRegion ||
        PRIVATE_ELEMENT_NAMES.has(tagName) ||
        isContentEditable(input.attributes) ||
        hasPrivateControlRole(input.attributes);
      const attributes = sanitizeAttributes(
        input.attributes,
        tagName,
        nextPrivateRegion,
        budget,
      );
      if (!attributes) return undefined;
      const children = sanitizeChildren(
        input.childNodes,
        nextPrivateRegion,
        styleRegion || tagName === 'style',
        depth,
        budget,
      );
      if (!children) return undefined;
      return {
        ...identityFields,
        tagName,
        attributes,
        childNodes: children,
        ...(input.isSVG === true ? { isSVG: true } : {}),
        ...(input.needBlock === true ? { needBlock: true } : {}),
        ...(input.isCustom === true ? { isCustom: true } : {}),
      };
    }
    case RRWEB_TEXT_NODE: {
      if (typeof input.textContent !== 'string') return undefined;
      if (
        input.textContent.length > MAX_REPLICA_STRING_LENGTH ||
        !consumeNodeBudget(budget, input.textContent.length * 2)
      ) return undefined;
      const text = input.textContent;
      return {
        ...identityFields,
        textContent: privateRegion
          ? maskPrivateText(text)
          : styleRegion || input.isStyle === true
            ? sanitizeCssText(text)
            : text,
        ...(styleRegion || input.isStyle === true ? { isStyle: true } : {}),
      };
    }
    case RRWEB_CDATA_NODE:
      return { ...identityFields, textContent: '' };
    case RRWEB_COMMENT_NODE:
      return { ...identityFields, textContent: '' };
    default:
      return undefined;
  }
}

/**
 * Applies the checkpoint node policy to one rrweb mutation subtree. Existing
 * IDs are seeded into the duplicate detector so a mutation cannot replace a
 * live mirror node by smuggling the same ID in an added subtree.
 */
export function sanitizeRrwebIncrementalNode(
  input: unknown,
  privateRegion: boolean,
  styleRegion: boolean,
  existingIds: ReadonlySet<number>,
): Record<string, unknown> | undefined {
  const budget: NodeBudget = {
    count: 0,
    bytes: 0,
    ids: new Set(existingIds),
  };
  return sanitizeSerializedNode(
    input,
    privateRegion,
    styleRegion,
    0,
    budget,
  );
}

export function sanitizeRrwebIncrementalAttributes(
  input: unknown,
  tagName: string,
  privateRegion: boolean,
): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined;
  return sanitizeAttributes(
    input,
    tagName,
    privateRegion,
    { count: 0, bytes: 0, ids: new Set() },
  );
}

export function maskRrwebPrivateText(value: string): string {
  return maskPrivateText(value);
}

function sanitizeChildren(
  children: readonly unknown[],
  privateRegion: boolean,
  styleRegion: boolean,
  depth: number,
  budget: NodeBudget,
): readonly Record<string, unknown>[] | undefined {
  const sanitized: Record<string, unknown>[] = [];
  for (const child of children) {
    if (isRecord(child)) {
      const tagName = typeof child.tagName === 'string'
        ? child.tagName.toLowerCase()
        : undefined;
      if (tagName && UNSAFE_ELEMENT_NAMES.has(tagName)) {
        if (isBoundedInteger(child.id, 1, Number.MAX_SAFE_INTEGER)) {
          if (budget.ids.has(child.id) || ++budget.count > MAX_REPLICA_NODES) return undefined;
          budget.ids.add(child.id);
        }
        continue;
      }
    }
    const next = sanitizeSerializedNode(
      child,
      privateRegion,
      styleRegion,
      depth + 1,
      budget,
    );
    if (!next) return undefined;
    sanitized.push(next);
  }
  return sanitized;
}

function sanitizeAttributes(
  attributes: Record<string, unknown>,
  tagName: string,
  privateRegion: boolean,
  budget: NodeBudget,
): Record<string, unknown> | undefined {
  const sanitized: Record<string, unknown> = {};
  const entries = Object.entries(attributes);
  if (entries.length > 512) return undefined;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (!name || name.length > 128 || /^on/iu.test(name)) continue;
    if (!consumeNodeBudget(budget, name.length * 2)) return undefined;
    if (
      NETWORK_ATTRIBUTE_NAMES.has(name) ||
      name === 'target' ||
      name === 'download' ||
      name === 'integrity' ||
      name === 'nonce' ||
      name === 'rr_dataurl' ||
      name === 'rr_src'
    ) continue;
    if (name === 'http-equiv' && tagName === 'meta') continue;
    if (name === 'content' && tagName === 'meta') continue;
    if (privateRegion) {
      const privateValue = sanitizePrivateAttribute(name, rawValue);
      if (privateValue !== undefined) sanitized[name] = privateValue;
      continue;
    }
    if (name === 'value') {
      sanitized[name] = typeof rawValue === 'string' ? maskPrivateText(rawValue) : '';
      continue;
    }
    if (name === 'style' && isRecord(rawValue)) {
      const styleDiff = sanitizeStyleOmDiff(rawValue, budget);
      if (!styleDiff) return undefined;
      sanitized[rawName] = styleDiff;
      continue;
    }
    if (name === 'style' || name === '_csstext') {
      if (name === '_csstext' && rawName !== '_cssText') return undefined;
      if (
        typeof rawValue !== 'string' ||
        rawValue.length > MAX_REPLICA_STRING_LENGTH ||
        !consumeNodeBudget(budget, rawValue.length * 2)
      ) return undefined;
      sanitized[rawName] = sanitizeCssText(rawValue);
      continue;
    }
    if (
      typeof rawValue !== 'string' &&
      typeof rawValue !== 'number' &&
      typeof rawValue !== 'boolean' &&
      rawValue !== null
    ) return undefined;
    if (typeof rawValue === 'string') {
      if (
        rawValue.length > MAX_REPLICA_STRING_LENGTH ||
        !consumeNodeBudget(budget, rawValue.length * 2)
      ) return undefined;
      sanitized[rawName] = CSS_RESOURCE_ATTRIBUTE_NAMES.has(name)
        ? sanitizeCssText(rawValue)
        : rawValue;
    } else {
      sanitized[rawName] = rawValue;
    }
  }
  return sanitized;
}

function sanitizeStyleOmDiff(
  input: Record<string, unknown>,
  budget: NodeBudget,
): Record<string, string | false | readonly [string, string]> | undefined {
  const entries = Object.entries(input);
  if (entries.length > 512) return undefined;
  const sanitized: Record<string, string | false | readonly [string, string]> = {};
  for (const [property, rawValue] of entries) {
    if (
      property.length < 1 ||
      property.length > 256 ||
      !/^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/u.test(property) ||
      !consumeNodeBudget(budget, property.length * 2)
    ) return undefined;
    if (rawValue === false) {
      sanitized[property] = false;
      continue;
    }
    if (typeof rawValue === 'string') {
      if (
        rawValue.length > MAX_REPLICA_STRING_LENGTH ||
        !consumeNodeBudget(budget, rawValue.length * 2)
      ) return undefined;
      sanitized[property] = sanitizeCssText(rawValue);
      continue;
    }
    if (
      Array.isArray(rawValue) &&
      rawValue.length === 2 &&
      typeof rawValue[0] === 'string' &&
      rawValue[0].length <= MAX_REPLICA_STRING_LENGTH &&
      (rawValue[1] === '' || rawValue[1] === 'important') &&
      consumeNodeBudget(budget, (rawValue[0].length + rawValue[1].length) * 2)
    ) {
      sanitized[property] = [sanitizeCssText(rawValue[0]), rawValue[1]];
      continue;
    }
    return undefined;
  }
  return sanitized;
}

function sanitizePrivateAttribute(
  name: string,
  value: unknown,
): string | number | boolean | null | undefined {
  if (name === 'value') {
    return typeof value === 'string' ? maskPrivateText(value) : '';
  }
  if (name === 'contenteditable') return 'false';
  if (
    name === 'disabled' ||
    name === 'hidden' ||
    name === 'multiple' ||
    name === 'readonly' ||
    name === 'required'
  ) return true;
  if (typeof value === 'string' && value.length > 128) return undefined;
  if (name === 'type' && typeof value === 'string') {
    const type = value.trim().toLowerCase();
    return PRIVATE_INPUT_TYPES.has(type) ? type : 'text';
  }
  if (name === 'role' && typeof value === 'string') {
    const role = value
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .find((entry) => PRIVATE_CONTROL_ROLES.has(entry));
    return role;
  }
  if (name === 'cols' || name === 'rows' || name === 'size') {
    const numeric = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 1 && numeric <= 1_000
      ? numeric
      : undefined;
  }
  return undefined;
}

function isContentEditable(attributes: Record<string, unknown>): boolean {
  const entry = Object.entries(attributes).find(
    ([name]) => name.toLowerCase() === 'contenteditable',
  );
  if (!entry) return false;
  const value = entry[1];
  // Fail private: malformed/unknown contenteditable values are masked too.
  // Only the explicit HTML false state may opt out (unless an ancestor is
  // already private, which the caller preserves).
  if (value === false) return false;
  if (typeof value !== 'string') return true;
  if (value.length > 32) return true;
  return value.trim().toLowerCase() !== 'false';
}

function hasPrivateControlRole(attributes: Record<string, unknown>): boolean {
  const role = Object.entries(attributes).find(
    ([name]) => name.toLowerCase() === 'role',
  )?.[1];
  if (typeof role !== 'string') return false;
  if (role.length > 256) return true;
  return role
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .some((entry) => PRIVATE_CONTROL_ROLES.has(entry));
}

function maskPrivateText(value: string): string {
  return '*'.repeat(Math.min(value.length, 256));
}

function consumeNodeBudget(budget: NodeBudget, bytes: number): boolean {
  budget.bytes += bytes;
  return budget.bytes <= MAX_REPLICA_CHECKPOINT_BYTES;
}

const CSS_RESOURCE_FUNCTION_NAMES = new Set([
  '-webkit-image-set',
  'cross-fade',
  'element',
  'image',
  'image-set',
  'src',
  'url',
]);
const INERT_CSS_RESOURCE = 'url("about:blank")';

export interface SanitizedCssText {
  text: string;
  neutralizedImport: boolean;
  neutralizedNamespace: boolean;
}

/**
 * Token-aware CSS resource filtering. The scanner intentionally preserves
 * identifiers and escapes verbatim: changing an escape can turn a grouping
 * rule into a qualified rule and shift every later CSSOM index.
 */
export function sanitizeCssTextDetailed(value: string): SanitizedCssText {
  const output: string[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  const ruleBlockStack: boolean[] = [];
  let topLevelRuleStart = true;
  let topLevelImportAllowed = true;
  let index = 0;
  let neutralizedImport = false;
  let neutralizedNamespace = false;

  while (index < value.length) {
    if (isCssCommentStart(value, index)) {
      // Comments are whitespace tokens. Keeping one space prevents tokens on
      // either side of a comment from being joined accidentally.
      output.push(' ');
      index = consumeCssComment(value, index);
      continue;
    }

    if (
      braceDepth === 0 &&
      parenthesisDepth === 0 &&
      bracketDepth === 0 &&
      topLevelRuleStart
    ) {
      const ignoredToken = readTopLevelIgnoredCssToken(value, index);
      if (ignoredToken) {
        output.push(ignoredToken);
        index += ignoredToken.length;
        continue;
      }
    }

    const character = value[index] ?? '';
    let preservesImportOrder = false;
    if (character === '"' || character === "'") {
      const end = consumeCssString(value, index);
      output.push(sanitizeCssString(value.slice(index, end)));
      if (braceDepth === 0 && topLevelRuleStart) {
        topLevelRuleStart = false;
        topLevelImportAllowed = false;
      }
      index = end;
      continue;
    }

    if (character === '{') {
      const startsTopLevelRuleBlock =
        braceDepth === 0 && parenthesisDepth === 0 && bracketDepth === 0;
      braceDepth += 1;
      ruleBlockStack.push(startsTopLevelRuleBlock);
      if (startsTopLevelRuleBlock) {
        topLevelRuleStart = false;
        topLevelImportAllowed = false;
      }
      output.push(character);
      index += 1;
      continue;
    }
    if (character === '}') {
      const closesTopLevelRuleBlock = ruleBlockStack.pop() ?? false;
      braceDepth = Math.max(0, braceDepth - 1);
      if (closesTopLevelRuleBlock && braceDepth === 0) topLevelRuleStart = true;
      output.push(character);
      index += 1;
      continue;
    }

    if (braceDepth === 0) {
      if (character === '(') parenthesisDepth += 1;
      else if (character === ')' && parenthesisDepth > 0) parenthesisDepth -= 1;
      else if (character === '[') bracketDepth += 1;
      else if (character === ']' && bracketDepth > 0) bracketDepth -= 1;
      else if (
        character === ';' &&
        parenthesisDepth === 0 &&
        bracketDepth === 0
      ) {
        topLevelRuleStart = true;
      }
    }

    if (
      character === '@' &&
      braceDepth === 0 &&
      parenthesisDepth === 0 &&
      bracketDepth === 0 &&
      topLevelRuleStart
    ) {
      const atKeyword = readCssIdentifier(value, index + 1);
      if (atKeyword?.decoded === 'import' && topLevelImportAllowed) {
        const end = consumeCssAtRule(value, atKeyword.end);
        output.push('@media not all {}');
        neutralizedImport = true;
        index = end;
        topLevelRuleStart = true;
        continue;
      }
      if (atKeyword?.decoded === 'namespace') {
        const end = consumeCssAtRule(value, atKeyword.end);
        const prefix = readNamespacePrefix(value, atKeyword.end, end);
        output.push(
          `@namespace${prefix ? ` ${prefix}` : ''} "urn:simul:inert";`,
        );
        neutralizedNamespace = true;
        topLevelImportAllowed = false;
        index = end;
        topLevelRuleStart = true;
        continue;
      }
      preservesImportOrder = Boolean(
        atKeyword && isImportOrderException(value, atKeyword),
      );
    }

    const identifier = readCssIdentifier(value, index);
    if (
      identifier &&
      value[identifier.end] === '(' &&
      CSS_RESOURCE_FUNCTION_NAMES.has(identifier.decoded)
    ) {
      output.push(INERT_CSS_RESOURCE);
      if (braceDepth === 0 && topLevelRuleStart) {
        topLevelRuleStart = false;
        topLevelImportAllowed = false;
      }
      index = consumeCssFunction(value, identifier.end);
      continue;
    }

    if (identifier) {
      output.push(value.slice(index, identifier.end));
      if (braceDepth === 0 && topLevelRuleStart) {
        topLevelRuleStart = false;
        topLevelImportAllowed = false;
      }
      index = identifier.end;
      continue;
    }

    output.push(character);
    if (
      braceDepth === 0 &&
      topLevelRuleStart &&
      !/\s/u.test(character) &&
      character !== ';'
    ) {
      topLevelRuleStart = false;
      if (!preservesImportOrder) topLevelImportAllowed = false;
    }
    index += 1;
  }

  return {
    text: output.join(''),
    neutralizedImport,
    neutralizedNamespace,
  };
}

export function sanitizeCssText(value: string): string {
  return sanitizeCssTextDetailed(value).text;
}

interface CssIdentifier {
  decoded: string;
  end: number;
}

function isImportOrderException(
  value: string,
  atKeyword: CssIdentifier,
): boolean {
  if (atKeyword.decoded !== 'charset' && atKeyword.decoded !== 'layer') {
    return false;
  }
  const end = consumeCssAtRule(value, atKeyword.end);
  return value[end - 1] === ';';
}

function readCssIdentifier(value: string, start: number): CssIdentifier | undefined {
  let decoded = '';
  let index = start;

  while (index < value.length) {
    const character = value[index];
    if (isCssNameCharacter(character)) {
      decoded += character;
      index += 1;
      continue;
    }
    if (character !== '\\') break;
    const escape = readCssEscape(value, index);
    if (!escape) break;
    decoded += escape.decoded;
    index = escape.end;
  }

  return index === start
    ? undefined
    : { decoded: decoded.toLowerCase(), end: index };
}

function isCssNameCharacter(character: string | undefined): boolean {
  if (!character) return false;
  const code = character.charCodeAt(0);
  return (
    character === '-' ||
    character === '_' ||
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code >= 0x80
  );
}

function readCssEscape(
  value: string,
  start: number,
): { decoded: string; end: number } | undefined {
  if (value[start] !== '\\' || start + 1 >= value.length) return undefined;
  const next = value[start + 1] ?? '';
  if (next === '\n' || next === '\r' || next === '\f') return undefined;

  let index = start + 1;
  let hex = '';
  while (
    index < value.length &&
    hex.length < 6 &&
    /[0-9a-f]/iu.test(value[index] ?? '')
  ) {
    hex += value[index] ?? '';
    index += 1;
  }
  if (hex.length > 0) {
    if (value[index] === '\r' && value[index + 1] === '\n') {
      index += 2;
    } else if (/\s/u.test(value[index] ?? '')) {
      index += 1;
    }
    const codePoint = Number.parseInt(hex, 16);
    const decoded =
      codePoint === 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? '\ufffd'
        : String.fromCodePoint(codePoint);
    return { decoded, end: index };
  }

  return { decoded: next, end: start + 2 };
}

function isCssCommentStart(value: string, index: number): boolean {
  return value[index] === '/' && value[index + 1] === '*';
}

function readTopLevelIgnoredCssToken(
  value: string,
  index: number,
): '<!--' | '-->' | undefined {
  if (value.startsWith('<!--', index)) return '<!--';
  if (value.startsWith('-->', index)) return '-->';
  return undefined;
}

function consumeCssComment(value: string, start: number): number {
  const end = value.indexOf('*/', start + 2);
  return end < 0 ? value.length : end + 2;
}

function consumeCssString(value: string, start: number): number {
  const quote = value[start];
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (character === quote) return index + 1;
    if (character === '\\') {
      if (value[index + 1] === '\r' && value[index + 2] === '\n') {
        index += 3;
      } else {
        index = Math.min(value.length, index + 2);
      }
      continue;
    }
    if (character === '\n' || character === '\r' || character === '\f') {
      return index;
    }
    index += 1;
  }
  return value.length;
}

function sanitizeCssString(value: string): string {
  if (value.length < 2) return value;
  const quote = value[0];
  const content = value.slice(1, -1).trim();
  if (/^(?:https?:)?\/\//iu.test(content)) {
    return `${quote}about:blank${quote}`;
  }
  return value;
}

function consumeCssAtRule(value: string, start: number): number {
  let bracketDepth = 0;
  let parenthesisDepth = 0;
  let index = start;
  while (index < value.length) {
    if (isCssCommentStart(value, index)) {
      index = consumeCssComment(value, index);
      continue;
    }
    const character = value[index];
    if (character === '"' || character === "'") {
      index = consumeCssString(value, index);
      continue;
    }
    if (character === '\\') {
      const escape = readCssEscape(value, index);
      if (escape) {
        index = escape.end;
        continue;
      }
    }
    if (character === '(') parenthesisDepth += 1;
    else if (character === ')' && parenthesisDepth > 0) parenthesisDepth -= 1;
    else if (character === '[') bracketDepth += 1;
    else if (character === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (parenthesisDepth === 0 && bracketDepth === 0) {
      if (character === ';') return index + 1;
      if (character === '}') return index;
      if (character === '{') return consumeCssBlock(value, index);
    }
    index += 1;
  }
  return value.length;
}

function consumeCssBlock(value: string, start: number): number {
  let depth = 1;
  let index = start + 1;
  while (index < value.length) {
    if (isCssCommentStart(value, index)) {
      index = consumeCssComment(value, index);
      continue;
    }
    const character = value[index];
    if (character === '"' || character === "'") {
      index = consumeCssString(value, index);
      continue;
    }
    if (character === '\\') {
      const escape = readCssEscape(value, index);
      if (escape) {
        index = escape.end;
        continue;
      }
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return value.length;
}

function consumeCssFunction(value: string, openParenthesis: number): number {
  let depth = 1;
  let index = openParenthesis + 1;
  while (index < value.length) {
    if (isCssCommentStart(value, index)) {
      index = consumeCssComment(value, index);
      continue;
    }
    const character = value[index];
    if (character === '"' || character === "'") {
      index = consumeCssString(value, index);
      continue;
    }
    if (character === '\\') {
      const escape = readCssEscape(value, index);
      if (escape) {
        index = escape.end;
        continue;
      }
    }
    // An unclosed resource function must not consume a following CSS rule.
    if ((character === '{' || character === '}') && depth === 1) return index;
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
    index += 1;
  }
  return value.length;
}

function readNamespacePrefix(
  value: string,
  start: number,
  end: number,
): string | undefined {
  let index = start;
  while (index < end) {
    if (/\s/u.test(value[index] ?? '')) {
      index += 1;
      continue;
    }
    if (isCssCommentStart(value, index)) {
      index = consumeCssComment(value, index);
      continue;
    }
    break;
  }
  if (value[index] === '"' || value[index] === "'") return undefined;
  const identifier = readCssIdentifier(value, index);
  if (!identifier || identifier.end > end) return undefined;

  let next = identifier.end;
  while (next < end) {
    if (/\s/u.test(value[next] ?? '')) {
      next += 1;
      continue;
    }
    if (isCssCommentStart(value, next)) {
      next = consumeCssComment(value, next);
      continue;
    }
    break;
  }
  if (identifier.decoded === 'url' && value[next] === '(') return undefined;
  return value.slice(index, identifier.end);
}

function sanitizePageUrl(value: unknown): string {
  if (typeof value !== 'string') return 'about:blank';
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'about:blank';
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'about:blank';
  }
}

function inspectBoundedJsonShape(
  value: unknown,
): 'valid' | 'invalid' | 'too_large' {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let entries = 0;
  let estimatedBytes = 0;
  const consumeBytes = (bytes: number): boolean => {
    estimatedBytes += bytes;
    return estimatedBytes <= MAX_REPLICA_CHECKPOINT_BYTES;
  };
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > MAX_REPLICA_NODE_DEPTH + 8) return 'invalid';
    const item = current.value;
    if (item === null) {
      if (!consumeBytes(4)) return 'too_large';
      continue;
    }
    if (typeof item === 'boolean') {
      if (!consumeBytes(item ? 4 : 5)) return 'too_large';
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      if (!consumeBytes(String(item).length)) return 'too_large';
      continue;
    }
    if (typeof item === 'string') {
      if (item.length > MAX_REPLICA_STRING_LENGTH) return 'too_large';
      if (!consumeBytes(jsonByteLength(item))) return 'too_large';
      continue;
    }
    if (typeof item !== 'object') return 'invalid';
    if (seen.has(item)) return 'invalid';
    seen.add(item);
    if (Array.isArray(item)) {
      entries += item.length;
      if (
        entries > MAX_REPLICA_NODES * 20 ||
        !consumeBytes(2 + Math.max(0, item.length - 1))
      ) return 'too_large';
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    const objectEntries = Object.entries(item as Record<string, unknown>);
    entries += objectEntries.length;
    if (
      entries > MAX_REPLICA_NODES * 20 ||
      !consumeBytes(2 + Math.max(0, objectEntries.length - 1))
    ) return 'too_large';
    for (const [key, child] of objectEntries) {
      if (key.length > 128) return 'invalid';
      if (!consumeBytes(jsonByteLength(key) + 1)) return 'too_large';
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return 'valid';
}

function boundedString(value: string, maximum: number): string {
  return value.slice(0, maximum);
}

function boundedDuration(value: number): number {
  return isBoundedNumber(value, 0, 60_000) ? value : 0;
}

function boundedDimension(value: number): number {
  return isDimension(value) ? value : 1;
}

function isDimension(value: unknown): value is number {
  return isBoundedNumber(value, 1, MAX_REPLICA_DIMENSION);
}

function isSafeToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/u.test(value)
  );
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function isBoundedNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isRecordWithExactKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
