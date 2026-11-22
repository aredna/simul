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

/** Whether `node` is an element that answers for its fields' names. */
export function sourceAnswersFieldNames(node: Node): boolean {
  return sourceNodeType(node) === 1 &&
    sourceLocalName(node as Element).toLowerCase() === 'form';
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
