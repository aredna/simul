/**
 * What a script animation leaves an element at.
 *
 * `element.animate()` with `fill: 'forwards'` or `'both'` goes on setting its
 * last frame after it has ended: the element is drawn with those values and
 * nothing in the page's markup or style sheets says so. A dialog whose sheet
 * says `opacity: 0.01` and which a script fades in that way is drawn in the
 * tab and stayed invisible in the mirror, which has the sheet and cannot run
 * the page's script. So the values such an animation holds are worked out
 * here and travel as declarations at the end of the element's `style`
 * attribute, where they outrank the sheets as the animation does (an
 * `!important` rule still wins there, as it does in the tab).
 *
 * Animations made by style sheets (CSS animations and transitions) are left
 * alone: the mirror has the sheets and runs them itself. So is a script
 * animation that is still running: its end is listened for.
 *
 * Nothing is asked of an element. A tree's animations are listed once in a
 * pass (`document.getAnimations()`, and each shadow root's own: the
 * document's list leaves them out) and grouped by the element they move;
 * reading an element then looks its held values up. Asking each element for
 * its own animations costs, in Chrome, by how many animations the document
 * holds: a page of 5,000 elements that each hold one took seconds to read.
 * Every pass works the held values out afresh from the list, so one that the
 * page lets go of without an event (a fill taken away, an effect removed, an
 * animation set back and paused) is withdrawn at the next pass.
 *
 * The animations a pass lists are kept hold of until the next. Chrome 138
 * lets go of an ended animation that nothing refers to and keeps only the
 * value it draws: after a garbage collection it lists the animation no
 * more, and the value would be taken for one the page let go of. (154 goes
 * on listing it. One that 138 had forgotten before the page was first
 * listed is not found, there as before.)
 */

/** A tree whose animations are listed as one: the document or a shadow root. */
type AnimationTree = Document | ShadowRoot;

export interface SourceHeldAnimationListener {
  /** What the element's animations hold is other than what was last read. */
  changed(element: Element): void;
  /** A script animation that was running has ended: a pass is wanted. */
  ended(): void;
}

export interface SourceHeldAnimationPass {
  /** Whether this pass lists at all (see `LISTING_SHARE`). */
  readonly lists: boolean;
  /** Lists the tree's animations, once in this pass. */
  list(tree: AnimationTree): void;
  end(): void;
}

interface AnimationLike {
  readonly playState?: string;
  readonly effect?: {
    readonly target?: unknown;
    readonly pseudoElement?: string | null;
    readonly composite?: string;
    readonly iterationComposite?: string;
    getKeyframes?(): readonly Record<string, unknown>[];
    getComputedTiming?(): { readonly progress?: number | null };
  } | null;
  addEventListener?(type: string, listener: () => void): void;
}

/** One property an ended animation holds: at the value its end states, or as computed. */
type HeldProperty = readonly [name: string, stated: string | undefined];

interface AnimationFacts {
  readonly properties: readonly HeldProperty[];
  /** The declarations, when every property's value is stated. */
  readonly style: string | undefined;
}

interface HeldStyle {
  readonly style: string;
  readonly tree: Node;
}

interface Ledger {
  readonly listeners: Set<SourceHeldAnimationListener>;
  /** The open pass and the trees it has listed. */
  listed: Set<AnimationTree> | undefined;
  /** Whether the open pass lists at all (see `LISTING_SHARE`). */
  listing: boolean;
  /** The open pass's clock, and what its listings have taken by it. */
  now: () => number;
  elapsed: number;
  /** No pass lists before this time, unless it reads the whole page. */
  notBefore: number;
  /** The script animations each tree last listed, so that they stay listed. */
  kept: WeakMap<AnimationTree, readonly AnimationLike[]>;
  readonly ended: () => void;
}

const LEDGERS = new WeakMap<Document, Ledger>();
/** What each element is held at, and the tree that was listed for it. */
const HELD = new WeakMap<Element, HeldStyle>();
/** The elements of each tree that hold something, to find those that no longer do. */
const HELD_IN_TREE = new WeakMap<AnimationTree, Set<Element>>();
/** What an ended animation's keyframes say (see `MAX_FACTS_READ_AGAIN`). */
const FACTS = new WeakMap<object, AnimationFacts>();
/** Where in each tree's ended animations the next pass reads keyframes again. */
const READ_AGAIN_FROM = new WeakMap<AnimationTree, number>();
/** Running animations whose end is listened for. */
const WATCHED = new WeakSet<object>();

/** Keys of a keyframe that are not properties. */
const KEYFRAME_FACTS = new Set(['offset', 'computedOffset', 'easing', 'composite']);
/** Properties one animation's held state may name; more are not written. */
const MAX_HELD_PROPERTIES = 64;
const MAX_HELD_VALUE_LENGTH = 4_096;
/**
 * In each tree the keyframes of this many ended animations are read again
 * in a pass, the next ones in the next pass, so that keyframes a script has
 * changed since (`setKeyframes`) are noticed: at once where a tree holds no
 * more than this many, after a few passes where it holds thousands. Reading
 * them all costs 38 ms for 20,000 animations, four times the listing.
 */
const MAX_FACTS_READ_AGAIN = 512;
/**
 * Listing may take a twentieth of the time: after a pass that took `t` to
 * list, none lists for `20 t`, and reads use what was last worked out. A list
 * is sorted by Chrome, CSS animations by their place in the tree: 100 of
 * them at the end of 20,000 siblings take 14 ms to list, 2,000 half a second.
 */
const LISTING_SHARE = 20;

function ledgerOf(sourceDocument: Document): Ledger {
  let ledger = LEDGERS.get(sourceDocument);
  if (!ledger) {
    const listeners = new Set<SourceHeldAnimationListener>();
    ledger = {
      listeners,
      listed: undefined,
      listing: false,
      now: () => 0,
      elapsed: 0,
      notBefore: 0,
      kept: new WeakMap(),
      // Called once for each animation that ends: thousands may end together.
      ended: () => {
        for (const listener of listeners) {
          try {
            listener.ended();
          } catch {
            // One reader's failure does not keep the others from hearing.
          }
        }
      },
    };
    LEDGERS.set(sourceDocument, ledger);
  }
  return ledger;
}

/** Hears of held values that changed and of running animations that ended. */
export function listenForSourceHeldAnimations(
  sourceDocument: Document,
  listener: SourceHeldAnimationListener,
): () => void {
  const ledger = ledgerOf(sourceDocument);
  ledger.listeners.add(listener);
  return () => {
    ledger.listeners.delete(listener);
    // With no reader left, nothing of the page is kept hold of.
    if (ledger.listeners.size === 0) ledger.kept = new WeakMap();
  };
}

/**
 * Opens a pass over the document's animations. Within it each tree is listed
 * at most once, by `list` or when the reader enters a shadow root
 * (`listSourceHeldAnimations`). `whole` is a reading of the whole page, which
 * always lists; any other pass lists only if listing has not lately taken
 * more than its share of the time.
 */
export function beginSourceHeldAnimationPass(
  sourceDocument: Document,
  whole = false,
  now: () => number = () => performance.now(),
): SourceHeldAnimationPass {
  const ledger = ledgerOf(sourceDocument);
  const list = (tree: AnimationTree): void => listTree(ledger, tree);
  if (ledger.listed) {
    // A pass inside a pass is the outer one, which lists if this one must.
    ledger.listing ||= whole;
    return { lists: ledger.listing, list, end: () => undefined };
  }
  ledger.listed = new Set();
  ledger.listing = whole || now() >= ledger.notBefore;
  ledger.now = now;
  ledger.elapsed = 0;
  return {
    lists: ledger.listing,
    list,
    end: () => {
      if (ledger.listing) ledger.notBefore = now() + LISTING_SHARE * ledger.elapsed;
      ledger.listed = undefined;
    },
  };
}

/** For the reader, as it enters a shadow root: lists it in the open pass, if one is open. */
export function listSourceHeldAnimations(tree: AnimationTree): void {
  const ledger = LEDGERS.get(tree.ownerDocument ?? (tree as Document));
  if (ledger) listTree(ledger, tree);
}

/**
 * The declarations an element's ended script animations hold, as
 * `name:value` pairs joined by `;`, or the empty string: what the last
 * listing of the element's tree worked out.
 */
export function readSourceHeldAnimationStyle(element: Element): string {
  return HELD.get(element)?.style ?? '';
}

function listTree(ledger: Ledger, tree: AnimationTree): void {
  if (!ledger.listed || !ledger.listing || ledger.listed.has(tree)) return;
  ledger.listed.add(tree);
  const started = ledger.now();
  let animations: readonly AnimationLike[];
  try {
    const read = (tree as Partial<AnimationTree>).getAnimations;
    animations = typeof read === 'function'
      ? read.call(tree) as readonly AnimationLike[]
      : [];
  } catch {
    animations = [];
  }
  // What each element's ended script animations hold, in the order Chrome
  // lists them, which is the order they apply in: a later one wins.
  const holding = new Map<Element, AnimationFacts[]>();
  const kept: AnimationLike[] = [];
  const againFrom = READ_AGAIN_FROM.get(tree) ?? 0;
  let ended = 0;
  for (const animation of animations) {
    try {
      const target = scriptAnimationTarget(animation);
      if (!target) continue;
      kept.push(animation);
      if (animation.playState !== 'finished') {
        // Where it comes to rest next may be elsewhere (reversed, say).
        FACTS.delete(animation);
        if (animation.playState === 'running') watch(ledger, animation);
        continue;
      }
      // Listed and ended: still setting its last frame (one that holds
      // nothing after its end is not listed).
      const again = ended >= againFrom &&
        ended < againFrom + MAX_FACTS_READ_AGAIN;
      ended += 1;
      const facts = (again ? undefined : FACTS.get(animation)) ??
        readAnimationFacts(animation);
      const list = holding.get(target);
      if (list) list.push(facts);
      else holding.set(target, [facts]);
    } catch {
      // An animation that cannot be read holds nothing the mirror can show.
    }
  }
  const before = HELD_IN_TREE.get(tree);
  const after = new Set<Element>();
  for (const [element, facts] of holding) {
    const style = heldStyleOf(element, facts);
    if (!style) continue;
    after.add(element);
    const known = HELD.get(element);
    if (known?.style === style && known.tree === tree) continue;
    HELD.set(element, { style, tree });
    tell(ledger, element);
  }
  // What the page has let go of, with or without an event.
  if (before) {
    for (const element of before) {
      if (after.has(element)) continue;
      if (HELD.get(element)?.tree === tree) HELD.delete(element);
      tell(ledger, element);
    }
  }
  if (after.size > 0) HELD_IN_TREE.set(tree, after);
  else HELD_IN_TREE.delete(tree);
  ledger.kept.set(tree, kept);
  if (againFrom + MAX_FACTS_READ_AGAIN < ended) {
    READ_AGAIN_FROM.set(tree, againFrom + MAX_FACTS_READ_AGAIN);
  } else {
    READ_AGAIN_FROM.delete(tree);
  }
  ledger.elapsed += ledger.now() - started;
}

/**
 * The element an animation moves, when a script made the animation. A CSS
 * animation says which `@keyframes` it runs and a CSS transition which
 * property it moves; one on `::before` or `::after` has no element of its
 * own in the mirror.
 */
function scriptAnimationTarget(animation: AnimationLike): Element | undefined {
  if ('animationName' in animation || 'transitionProperty' in animation) {
    return undefined;
  }
  const effect = animation.effect;
  return effect?.pseudoElement
    ? undefined
    : (effect?.target as Element | null | undefined) ?? undefined;
}

/**
 * The properties an ended animation holds, and at what. Where the keyframe
 * it rests at states the value itself, that value is what is written, so
 * `50%`, `auto` and `calc()` go on working in the mirror as they do in the
 * tab. Where the keyframe adds to what lies under it, or the animation
 * rests between two keyframes, the element's computed value is written.
 * Where no keyframe states the property at rest (an implicit keyframe), the
 * animation holds the element's own value there, which the mirror has.
 */
function readAnimationFacts(animation: AnimationLike): AnimationFacts {
  const effect = animation.effect;
  const frames = effect?.getKeyframes?.() ?? [];
  const progress = effect?.getComputedTiming?.().progress;
  const atKeyframe = progress === 0 || progress === 1;
  const replaces = (effect?.composite ?? 'replace') === 'replace' &&
    (effect?.iterationComposite ?? 'replace') === 'replace';
  const held = new Map<string, string | undefined>();
  for (const frame of frames) {
    if (atKeyframe && frame.computedOffset !== progress) continue;
    for (const key of Object.keys(frame)) {
      if (KEYFRAME_FACTS.has(key)) continue;
      const name = keyframePropertyName(key);
      if (name === undefined) continue;
      if (!held.has(name) && held.size >= MAX_HELD_PROPERTIES) continue;
      const composite = frame.composite ?? 'auto';
      const value = typeof frame[key] === 'string' ? (frame[key] as string).trim() : '';
      held.set(
        name,
        atKeyframe && (composite === 'auto' ? replaces : composite === 'replace') &&
          writable(value)
          ? value
          : undefined,
      );
    }
  }
  const properties = Object.freeze([...held]);
  const facts = Object.freeze({
    properties,
    style: properties.every(([, value]) => value !== undefined)
      ? properties.map(([name, value]) => `${name}:${value}`).join(';')
      : undefined,
  });
  FACTS.set(animation, facts);
  return facts;
}

/** The declarations of what one element's ended animations hold between them. */
function heldStyleOf(element: Element, facts: readonly AnimationFacts[]): string {
  if (facts.length === 1 && facts[0]!.style !== undefined) return facts[0]!.style;
  const values = new Map<string, string | undefined>();
  for (const { properties } of facts) {
    for (const [name, value] of properties) {
      // Named again by a later animation: that one's is the value, and its place.
      values.delete(name);
      values.set(name, value);
    }
  }
  let computed: CSSStyleDeclaration | null | undefined;
  const declarations: string[] = [];
  for (const [name, stated] of values) {
    let value = stated;
    if (value === undefined) {
      try {
        computed ??= element.ownerDocument?.defaultView?.getComputedStyle(element);
        value = computed?.getPropertyValue(name).trim();
      } catch {
        value = undefined;
      }
    }
    if (value !== undefined && writable(value)) declarations.push(`${name}:${value}`);
  }
  return declarations.join(';');
}

/** A value that can stand in a declaration list without ending it. */
function writable(value: string): boolean {
  return value !== '' && value.length <= MAX_HELD_VALUE_LENGTH &&
    !/[;{}]/u.test(value);
}

/**
 * A keyframe's key as a CSS property name: `backgroundColor`, `cssFloat`.
 * `undefined` for a key that is no name. Chrome takes any key that begins
 * with `--` for a custom property, `--a;color:red` too, and such a key
 * written into a `style` attribute would be declarations of its own: a held
 * name is written only when it is one identifier and nothing else.
 */
function keyframePropertyName(key: string): string | undefined {
  const name = key.startsWith('--')
    ? key
    : key === 'cssFloat'
      ? 'float'
      : key === 'cssOffset'
        ? 'offset'
        : key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  return CSS_PROPERTY_NAME.test(name) ? name : undefined;
}

/**
 * A property's name, or a custom property's: `--` and then letters, digits,
 * `_`, `-` and what lies past ASCII, which are the letters of a CSS name.
 */
const CSS_PROPERTY_NAME = /^(?:--[-\w\u0080-\u{10ffff}]+|-?[a-z][-a-z0-9]*)$/u;

/** Listens for the end of an animation met while it runs: nothing else tells of it. */
function watch(ledger: Ledger, animation: AnimationLike): void {
  if (WATCHED.has(animation)) return;
  WATCHED.add(animation);
  animation.addEventListener?.('finish', ledger.ended);
}

function tell(ledger: Ledger, element: Element): void {
  for (const listener of [...ledger.listeners]) {
    try {
      listener.changed(element);
    } catch {
      // One reader's failure does not keep the others from hearing.
    }
  }
}
