/**
 * A page's `<img name="body">` (or a form, embed, object or frame of that
 * name) is `document.body`: a document answers for those names before its
 * own properties (D207). linkedom has no named access, so the element is put
 * in front of `name` here, for reads from Simul's code; Chrome's own DOM
 * code never meets it, so linkedom's reads still get the property. linkedom
 * keeps some properties on the document itself: those move to a prototype,
 * as Chrome has them. Returns what puts the document back.
 */
export function nameOnDocument(document: Document, name: string, element: Element): () => void {
  const original = Object.getPrototypeOf(document) as object;
  const own = Object.getOwnPropertyDescriptor(document, name);
  // Chrome's prototypes have every name read here; linkedom lacks some
  // (`adoptedStyleSheets`), and a layer stands in for them with what the
  // document had before.
  const prototype = Object.create(original, {
    [name]: !own
      ? { configurable: true, get: () => Reflect.get(original, name, document) as unknown }
      : own.get || own.set
        ? { ...own, configurable: true }
        : typeof own.value === 'function'
          ? { configurable: true, writable: true, value: own.value as unknown }
          : { configurable: true, get: () => own.value as unknown },
  }) as object;
  Object.setPrototypeOf(document, prototype);
  Object.defineProperty(document, name, {
    configurable: true,
    get() {
      const caller = new Error().stack?.split('\n')[2] ?? '';
      return caller.includes('/node_modules/') ? Reflect.get(prototype, name, document) : element;
    },
  });
  return () => {
    delete (document as unknown as Record<string, unknown>)[name];
    Object.setPrototypeOf(document, original);
    if (own) Object.defineProperty(document, name, own);
  };
}

/** Names a page's image or form can take that Simul reads of its document. */
export const DOCUMENT_NAMES = [
  'documentElement', 'body', 'head', 'styleSheets', 'adoptedStyleSheets', 'activeElement',
  'defaultView', 'forms', 'scrollingElement', 'visibilityState', 'readyState', 'fonts',
  'designMode', 'nodeType', 'childNodes', 'ownerDocument', 'getElementById', 'querySelector',
  'querySelectorAll', 'createTreeWalker', 'createElement', 'createRange', 'getSelection',
  'elementFromPoint', 'contains', 'getRootNode', 'addEventListener', 'removeEventListener',
] as const;
