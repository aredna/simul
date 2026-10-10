import {
  clearReplicaAttributeOverride,
  pageAttribute,
  setReplicaAttributeOverride,
} from './replica-attribute-override';

/**
 * `lang` is also what Chrome draws by. It picks fonts by it (a generic
 * family resolves per language, and so does the fallback for a character the
 * page's fonts lack), the marks around a `<q>`, and which `:lang()` rules of
 * the page match. Measured on Wikipedia with Japanese fonts installed, the
 * tag alone redrew Latin letters in another font, rewrapped lines, and with
 * "Keep geometry" left the page's layout by hundreds of pixels; a `<q>` in
 * an English page got Japanese brackets.
 *
 * HTML gives an element two places to declare its language: `lang`, and
 * `lang` in the XML namespace, which wins. Chrome follows that for
 * everything it draws, and reads the plain `lang` alone for the
 * accessibility tree (Chrome 138 and 154). So a tagged element also carries
 * the page's own language for it in the XML namespace (empty when the page
 * declares none): the mirror is drawn as before, and only a screen reader
 * hears the difference (D124).
 *
 * The attribute's name is Simul's own. A page written the XHTML way carries
 * a plain attribute named `xml:lang`, which does nothing in HTML, and two
 * attributes of one name could not be told apart by name.
 */
export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
export const PAGE_LANGUAGE_ATTRIBUTE = 'simul:lang';

/**
 * A page's own `lang` in the XML namespace, by mirrored element: `xml:lang`
 * as an XHTML document writes it, as the HTML parser reads it on SVG and
 * MathML, or as a script set it. It is the page's language for the element
 * before the plain `lang`, and Chrome draws by it. An element has one place
 * for a `lang` in that namespace, whatever the attribute is called, so the
 * page's own and `simul:lang` cannot both be there: where the page has one,
 * Simul writes none, and the page's already says what to draw by.
 */
const pageXmlLanguages = new WeakMap<Element, string>();

/**
 * Writes the page's `xml:lang` onto a mirrored element, in its namespace.
 * The engine calls it wherever it writes an element's attributes.
 */
export function writePageXmlLanguage(element: Element, language: string): void {
  // Simul's own leaves the place first; shown again, it would write over
  // the page's value.
  clearReplicaAttributeOverride(element, PAGE_LANGUAGE_ATTRIBUTE);
  element.setAttributeNS(XML_NAMESPACE, 'xml:lang', language);
  pageXmlLanguages.set(element, language);
}

/** The element's attributes are being written again: it has none so far. */
export function forgetPageXmlLanguage(element: Element): void {
  pageXmlLanguages.delete(element);
}

/** The page's own `xml:lang` on `element`, or `null`. */
export function pageXmlLanguage(element: Element): string | null {
  return pageXmlLanguages.get(element) ?? null;
}

/**
 * The language of translated text in the mirror, for screen readers (D124).
 * While an element shows a translation (as the parent of a translated text
 * node, or in its own value, placeholder or label) it carries `lang` set to
 * the language translated to, so a screen reader that switches voices reads
 * it with the right one. When its last translation goes, the element gets
 * back exactly what the page had. An element the page already declares to be
 * in that language is left alone, and so is one whose text the translator
 * gave back unchanged (`shownTranslationLanguage`).
 */
export class TranslatedLanguageTags {
  /** The element that shows each translation, by its projection's node id. */
  readonly #shown = new Map<number, Element>();
  readonly #elements = new Map<Element, { count: number; language: string }>();

  /** How many elements show a translation. */
  get size(): number {
    return this.#elements.size;
  }

  /** `element` now shows the translation of record `nodeId`, in `language`. */
  show(
    nodeId: number,
    element: Element | undefined,
    language: string | undefined,
  ): void {
    const previous = this.#shown.get(nodeId);
    if (previous) {
      if (
        previous === element && language &&
        this.#elements.get(element)?.language === language
      ) return;
      this.hide(nodeId);
    }
    if (!element || !language) return;
    this.#shown.set(nodeId, element);
    const entry = this.#elements.get(element);
    if (entry) {
      entry.count += 1;
      if (entry.language === language) return;
      entry.language = language;
    } else {
      this.#elements.set(element, { count: 1, language });
    }
    applyTranslatedLanguage(element, language);
  }

  /**
   * The translation of record `nodeId` no longer shows. Returns the element
   * that showed it, if any.
   */
  hide(nodeId: number): Element | undefined {
    const element = this.#shown.get(nodeId);
    if (!element) return undefined;
    this.#shown.delete(nodeId);
    const entry = this.#elements.get(element);
    if (entry && entry.count > 1) {
      entry.count -= 1;
      return element;
    }
    this.#elements.delete(element);
    clearTranslatedLanguage(element);
    return element;
  }

  /**
   * The page changed `lang` on the elements of `changed`: an element in one
   * of them that was already in the language may no longer be, and the other
   * way round, and the page's language beside a tag may be another. Nothing
   * outside them is touched, so a page that patches one `lang` on a timer
   * does not have every tag of a long page looked at again. Returns the
   * elements that were.
   */
  refresh(changed: ReadonlySet<Element>): readonly Element[] {
    const refreshed: Element[] = [];
    for (const [element, entry] of this.#elements) {
      if (!isInside(element, changed)) continue;
      applyTranslatedLanguage(element, entry.language);
      refreshed.push(element);
    }
    return refreshed;
  }

  /** Every element gets back what the page had. */
  release(): void {
    for (const element of this.#elements.keys()) {
      clearTranslatedLanguage(element);
    }
    this.#elements.clear();
    this.#shown.clear();
  }
}

/**
 * Shows `language` on a mirrored element, unless the page already declares
 * it there, and keeps the element drawn by the page's language.
 * `clearTranslatedLanguage` undoes it.
 */
export function applyTranslatedLanguage(element: Element, language: string): void {
  const { said, drawn } = pageLanguages(element);
  if (sameLanguage(said, language)) {
    clearTranslatedLanguage(element);
    return;
  }
  // The page's own `xml:lang` is in the same place and already says it.
  if (!pageXmlLanguages.has(element)) {
    setReplicaAttributeOverride(
      element,
      PAGE_LANGUAGE_ATTRIBUTE,
      drawn ?? '',
      XML_NAMESPACE,
    );
  }
  setReplicaAttributeOverride(element, 'lang', language);
}

/** The element gets back exactly what the page had. */
export function clearTranslatedLanguage(element: Element): void {
  clearReplicaAttributeOverride(element, 'lang');
  clearReplicaAttributeOverride(element, PAGE_LANGUAGE_ATTRIBUTE);
}

/**
 * One of Simul's own elements (the box of an image overlay, a row of a
 * select facsimile) says `language` and is drawn as it was without. These
 * elements never took the page's language: Chrome draws them by the
 * browser's own. So the language beside their tag is none, not the page's;
 * with the page's, a Japanese page's captions changed font (D124).
 */
export function showOwnLanguage(element: Element, language: string): void {
  element.setAttribute('lang', language);
  element.setAttributeNS(XML_NAMESPACE, PAGE_LANGUAGE_ATTRIBUTE, '');
}

/** Simul's own copy of a mirrored element's text says the element's language. */
export function copyTranslatedLanguage(from: Element, to: Element): void {
  const language = from.getAttribute('lang');
  if (language !== null) showOwnLanguage(to, language);
}

/**
 * Images named by their caption, by document. The image projector tags them
 * one at a time, outside any `TranslatedLanguageTags`; they are kept here so
 * that a page patch to `lang` has them looked at again like the rest. Without
 * it an image named while the page declared the target language stayed
 * without `lang` when the page changed its mind (D124).
 */
const namedImages = new WeakMap<Document, Map<Element, string>>();

/** `image` is named in `language`: it says so, unless the page already does. */
export function showImageLanguage(image: Element, language: string): void {
  let images = namedImages.get(image.ownerDocument);
  if (!images) {
    images = new Map();
    namedImages.set(image.ownerDocument, images);
  }
  images.set(image, language);
  applyTranslatedLanguage(image, language);
}

/** The name is gone: the image gets back exactly what the page had. */
export function hideImageLanguage(image: Element): void {
  const images = namedImages.get(image.ownerDocument);
  if (images?.delete(image) && images.size === 0) {
    namedImages.delete(image.ownerDocument);
  }
  clearTranslatedLanguage(image);
}

/**
 * The page changed a `lang` in `document`: every image named there is looked
 * at again. They are few (the projector bounds what it keeps), so all of
 * them, wherever the change was.
 */
export function refreshImageLanguages(document: Document): void {
  for (const [image, language] of namedImages.get(document) ?? []) {
    applyTranslatedLanguage(image, language);
  }
}

const MAX_LANGUAGE_DEPTH = 256;

/**
 * The language the page declares for `element`, as HTML defines it and as
 * Chrome draws by it: its own `xml:lang` (in the XML namespace) or `lang`,
 * or the nearest ancestor's, through shadow hosts; with none, the
 * document's own language (`documentContentLanguage`). Simul's own `lang`
 * values do not count. `undefined` when nothing declares one.
 */
export function pageLanguage(element: Element): string | undefined {
  return pageLanguages(element).drawn;
}

/**
 * The page's two languages for `element`. `drawn` is HTML's (see
 * `pageLanguage`). `said` is what Chrome's accessibility tree would say
 * without a tag of Simul's: it reads the plain `lang` alone, the element's
 * or the nearest ancestor's, and then the document's own language; an
 * `xml:lang` is not heard. The two are the same on every page that writes
 * no `xml:lang`.
 * A translation is tagged when the page does not already say its language,
 * and the tagged element is kept drawn by `drawn`.
 */
function pageLanguages(
  element: Element,
): { readonly said: string | undefined; readonly drawn: string | undefined } {
  let said: string | undefined;
  let drawn: string | undefined;
  let current: Element | undefined = element;
  for (let depth = 0; current && depth < MAX_LANGUAGE_DEPTH; depth += 1) {
    const plain = pageAttribute(current, 'lang');
    if (drawn === undefined) {
      const declared = pageXmlLanguages.get(current) ?? plain;
      if (declared !== null) drawn = declared.trim();
    }
    if (plain !== null) {
      said = plain.trim();
      break;
    }
    current = composedParentElement(current);
  }
  if (said === undefined || drawn === undefined) {
    const ofDocument = documentContentLanguage(element.ownerDocument);
    said ??= ofDocument;
    drawn ??= ofDocument;
  }
  return { said, drawn };
}

/** The language each mirror document was given, and the pragma that says it. */
const documentLanguages = new WeakMap<
  Document,
  { language: string; readonly pragma: Element }
>();

/**
 * Gives the mirror's document the page's own language: what Chrome takes
 * for a document where no element declares one, from a
 * `<meta http-equiv="content-language">` or the HTTP header. The page side
 * asks its Chrome what that language is and sends the answer; none of the
 * page's pragmas travels. The mirror says it with one pragma of Simul's own,
 * written again each time the answer changes, so the mirror's Chrome reads it
 * last and holds exactly the page's value, for what it draws and for the
 * accessibility tree. An empty value is a pragma that names no language,
 * which is how a document that had one is brought to say none: Chrome never
 * forgets a pragma.
 */
export function showDocumentLanguage(document: Document, language: string): void {
  const shown = documentLanguages.get(document);
  if (shown?.language === language) return;
  if (shown?.pragma.isConnected) {
    shown.language = language;
    shown.pragma.setAttribute('content', language);
    return;
  }
  const head = document.head;
  if (!head) return;
  const pragma = document.createElement('meta');
  pragma.setAttribute('data-simul-owned-shell', 'language');
  pragma.setAttribute('http-equiv', 'content-language');
  pragma.setAttribute('content', language);
  // After the shell's own elements, before anything of the page's.
  let after: Element | null = null;
  for (let child = head.firstElementChild; child; child = child.nextElementSibling) {
    if (child.hasAttribute('data-simul-owned-shell')) after = child;
  }
  head.insertBefore(pragma, after ? after.nextSibling : head.firstChild);
  documentLanguages.set(document, { language, pragma });
}

/**
 * The language the mirror's document was given (`showDocumentLanguage`):
 * the same value its Chrome holds. `undefined` when it was given none.
 */
export function documentContentLanguage(
  document: Document | null | undefined,
): string | undefined {
  return document ? documentLanguages.get(document)?.language : undefined;
}

/**
 * Whether `element` is one of `roots` or inside one, through shadow hosts.
 * Asked of every tag on each `lang` patch, so it asks the browser rather
 * than walking the parents in script.
 */
function isInside(element: Element, roots: ReadonlySet<Element>): boolean {
  let current: Element | undefined = element;
  for (let depth = 0; current && depth < MAX_LANGUAGE_DEPTH; depth += 1) {
    for (const root of roots) {
      if (root.contains(current)) return true;
    }
    // `contains` stops at a shadow root: go on from its host.
    const top: Node = current.getRootNode();
    current = top.nodeType === 11 && 'host' in top
      ? (top as ShadowRoot).host
      : undefined;
  }
  return false;
}

function composedParentElement(node: Node): Element | undefined {
  if (node.parentElement) return node.parentElement;
  const root = node.parentNode;
  if (root?.nodeType === 11 && 'host' in root) {
    const host = (root as ShadowRoot).host;
    if (host?.nodeType === 1) return host;
  }
  return undefined;
}

/** `en-US` is English; `zh` is not known to be `zh-Hant`. */
function sameLanguage(declared: string | undefined, language: string): boolean {
  if (!declared) return false;
  const page = declared.toLowerCase();
  const target = language.toLowerCase();
  return page === target || page.startsWith(`${target}-`);
}

/**
 * The language to say for a translation: none when the translator gave the
 * text back as it was (a name, a number, a word of a third language the page
 * marks with its own `lang`). That text is still what the page wrote, in the
 * language the page declares for it; calling it the translation's language
 * would have a screen reader mispronounce it, and would take a third
 * language's `lang` away (D124).
 */
export function shownTranslationLanguage(
  language: string | undefined,
  source: string,
  translated: string,
): string | undefined {
  return language && translated.trim() !== source.trim() ? language : undefined;
}

/** A language code as the translation pair gives it, or `undefined`. */
export function translationLanguageTag(value: unknown): string | undefined {
  return typeof value === 'string' &&
      /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,4}$/u.test(value)
    ? value
    : undefined;
}
