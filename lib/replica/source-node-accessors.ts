/**
 * Reads of a node's own DOM properties past what a page puts in their place
 * (D181, D187). A form answers `form.<name of one of its fields>` before
 * its own DOM properties, in a content script as in the page.
 */

/**
 * The accessors the prototypes of a node define, looked up once a
 * prototype: a property read by them is never a property of the node
 * itself (D181, as D144's `sourceElementLinks`).
 */
const SOURCE_OWN_ACCESSORS = new WeakMap<
  object,
  Map<string, ((this: object) => unknown) | null>
>();

export function readSourceOwnAccessor(node: object, name: string): unknown {
  const prototype: object | null = Object.getPrototypeOf(node);
  if (!prototype) return (node as Record<string, unknown>)[name];
  let accessors = SOURCE_OWN_ACCESSORS.get(prototype);
  if (!accessors) {
    accessors = new Map();
    SOURCE_OWN_ACCESSORS.set(prototype, accessors);
  }
  let getter = accessors.get(name);
  if (getter === undefined) {
    getter = null;
    for (
      let current: object | null = prototype;
      current;
      current = Object.getPrototypeOf(current)
    ) {
      const found = Object.getOwnPropertyDescriptor(current, name)?.get;
      if (found) {
        getter = found as (this: object) => unknown;
        break;
      }
    }
    accessors.set(name, getter);
  }
  return getter ? getter.call(node) : (node as Record<string, unknown>)[name];
}

/**
 * A node's type, past a form's field names (D181). A form answers
 * `form.<name of one of its fields>` before its own DOM properties, in a
 * content script as in the page: with a field named `nodeType` the form
 * read as no element and the mirror was short; one named `localName` or
 * `attributes` left the page without a mirror, one named `childNodes` too.
 * What a property gives that is not of its kind (a field for a number or a
 * string) is read again by the prototypes' accessor.
 */
export function sourceNodeType(node: Node): number {
  const own = node.nodeType;
  return typeof own === 'number'
    ? own
    : readSourceOwnAccessor(node, 'nodeType') as number;
}

/** An element's local name, past a form's field names; see above. */
export function sourceLocalName(element: Element): string {
  const own = element.localName;
  return typeof own === 'string'
    ? own
    : readSourceOwnAccessor(element, 'localName') as string;
}

/**
 * Whether `node` answers for names put in front of its own properties: a
 * form for its fields', and a document for those of its images, forms,
 * embeds, objects and frames (D207): a page's `<img name="body">` is
 * `document.body`, and `<form name="styleSheets">` its style sheets.
 */
export function sourceAnswersFieldNames(node: Node): boolean {
  const type = sourceNodeType(node);
  return type === 9 ||
    type === 1 && sourceLocalName(node as Element).toLowerCase() === 'form';
}

/** An element's attributes, past a form's field names; see above. */
export function sourceAttributeList(element: Element): NamedNodeMap {
  return sourceAnswersFieldNames(element)
    ? readSourceOwnAccessor(element, 'attributes') as NamedNodeMap
    : element.attributes;
}

/** A node's children, past a form's field names; see above. */
export function sourceChildNodeList(node: Node): NodeListOf<ChildNode> {
  return sourceAnswersFieldNames(node)
    ? readSourceOwnAccessor(node, 'childNodes') as NodeListOf<ChildNode>
    : node.childNodes;
}

/**
 * The methods the prototypes of a node define, looked up once a prototype
 * (D195): a form answers for its fields' ids and names before its methods
 * too ([LegacyOverrideBuiltIns]).
 */
const SOURCE_OWN_METHODS = new WeakMap<
  object,
  Map<string, ((this: object, ...args: unknown[]) => unknown) | null>
>();

function readSourceOwnMethod(
  node: object,
  name: string,
): ((this: object, ...args: unknown[]) => unknown) | null {
  const prototype: object | null = Object.getPrototypeOf(node);
  if (!prototype) return null;
  let methods = SOURCE_OWN_METHODS.get(prototype);
  if (!methods) {
    methods = new Map();
    SOURCE_OWN_METHODS.set(prototype, methods);
  }
  let method = methods.get(name);
  if (method === undefined) {
    method = null;
    for (
      let current: object | null = prototype;
      current;
      current = Object.getPrototypeOf(current)
    ) {
      const found = Object.getOwnPropertyDescriptor(current, name)?.value;
      if (typeof found === 'function') {
        method = found as (this: object, ...args: unknown[]) => unknown;
        break;
      }
    }
    methods.set(name, method);
  }
  return method;
}

type MethodName<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never
}[keyof T];

/**
 * Calls a method of a node past a form's fields (D195), or a document's
 * named elements (D207). A node that answers for names is called through
 * its prototypes: Chrome's `<embed>` and `<object>` can be called, so a
 * function there may be one of those.
 */
export function sourceCall<T extends object, K extends MethodName<T>>(
  node: T,
  name: K,
  ...args: T[K] extends (...args: infer A) => unknown ? A : never
): T[K] extends (...args: never[]) => infer R ? R : never {
  type Result = T[K] extends (...args: never[]) => infer R ? R : never;
  const own = sourceAnswersFieldNames(node as unknown as Node) ? undefined : node[name] as unknown;
  if (typeof own === 'function') {
    return (own as (...values: unknown[]) => unknown).apply(node, args) as Result;
  }
  const method = readSourceOwnMethod(node, String(name));
  if (!method) throw new TypeError(`${String(name)} is not a method of the node.`);
  return method.apply(node, args) as Result;
}

/**
 * A property of a node past a form's fields (D195) or a document's named
 * elements (D207). A field is itself a
 * node, so what it stands in front of cannot be told by its kind: a form's
 * properties are read by the prototypes' accessors.
 */
export function sourceProperty<T extends object, K extends keyof T>(node: T, name: K): T[K] {
  return sourceAnswersFieldNames(node as unknown as Node)
    ? readSourceOwnAccessor(node, String(name)) as T[K]
    : node[name];
}
