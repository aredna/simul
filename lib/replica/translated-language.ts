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
  const declared = pageLanguage(element);
  if (sameLanguage(declared, language)) {
    clearTranslatedLanguage(element);
    return;
  }
  setReplicaAttributeOverride(
    element,
    PAGE_LANGUAGE_ATTRIBUTE,
    declared ?? '',
    XML_NAMESPACE,
  );
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
 * The language the page declares for `element`: its own `lang` or the nearest
 * ancestor's, through shadow hosts, as HTML defines it. Simul's own `lang`
 * values do not count. `undefined` when nothing declares one.
 */
export function pageLanguage(element: Element): string | undefined {
  let current: Element | undefined = element;
  for (let depth = 0; current && depth < MAX_LANGUAGE_DEPTH; depth += 1) {
    const declared = pageAttribute(current, 'lang');
    if (declared !== null) return declared.trim();
    current = composedParentElement(current);
  }
  return undefined;
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
