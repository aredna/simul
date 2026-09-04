import type { LivePageScrollMessage } from '../../lib/live-page-mirror';
import type { PageSnapshot, SnapshotTextRole } from '../../lib/page-snapshot';
import type { CompanionPreferences } from '../../lib/preferences';
import type {
  VisibleReplayLayout,
  VisibleReplayScroll,
} from '../../lib/replica/visible-replay-host';
import {
  applyMirrorTextLayout,
  computeMirrorExtent,
  computeMirrorScale,
  countVisualMirrorTranslationFields,
  createVisualMirror,
  resetVisualMirrorText,
} from '../../lib/visual-renderer';

export type MirrorViewPreferences = Pick<
  CompanionPreferences,
  'displayMode' | 'zoomPercent' | 'syncScroll' | 'textLayoutMode'
>;

/** The part of the visible replay host the legacy mirror shares layout with. */
export interface MirrorReplayHost {
  readonly previewVisible: boolean;
  updateLayout(layout: VisibleReplayLayout): void;
  followSourceScroll(scroll: VisibleReplayScroll): void;
}

export interface MirrorViewEnvironment {
  readonly document: Document;
  /** The element that holds the legacy v1 mirror, loading and error states. */
  readonly container: HTMLElement;
  readonly replayHost: MirrorReplayHost;
  readonly readPreferences: () => MirrorViewPreferences;
  readonly readSourceScroll: () => LivePageScrollMessage | undefined;
  /** Runs after each layout pass; overlays anchored to the mirror follow it. */
  readonly onLayoutUpdated?: () => void;
}

/**
 * The legacy v1 visual mirror: rendering a snapshot into the container,
 * scaling it to the display mode, and following the source scroll. The
 * isolated replica renders elsewhere; this view stays the visible fallback
 * and the surface the legacy live-delta path updates in place.
 */
export class MirrorView {
  #root: HTMLElement | undefined;
  #scroller: HTMLElement | undefined;
  #stage: HTMLElement | undefined;
  #scaleLayer: HTMLElement | undefined;
  #viewportWidth = 1;
  #documentWidth = 1;
  #documentHeight = 1;
  #scale = 1;
  #resizeObserver: ResizeObserver | undefined;

  constructor(private readonly environment: MirrorViewEnvironment) {}

  /** The mounted visual mirror root, or undefined for a flat or empty view. */
  get root(): HTMLElement | undefined {
    return this.#root;
  }

  get scale(): number {
    return this.#scale;
  }

  renderSnapshot(page: PageSnapshot): void {
    const { document, container } = this.environment;
    this.disconnect();
    const article = document.createElement('article');
    article.className = 'page-copy';
    const mirror = createVisualMirror(page, undefined, document);
    if (mirror && page.visual) {
      const scroller = document.createElement('div');
      scroller.className = 'mirror-scroll';
      const stage = document.createElement('div');
      stage.className = 'mirror-stage';
      const scaleLayer = document.createElement('div');
      scaleLayer.className = 'mirror-scale-layer';
      scaleLayer.append(mirror);
      stage.append(scaleLayer);
      scroller.append(stage);
      article.append(scroller);
      container.replaceChildren(article);

      this.#root = mirror;
      this.#scroller = scroller;
      this.#stage = stage;
      this.#scaleLayer = scaleLayer;
      this.#viewportWidth = page.visual.viewportWidth;
      this.#documentWidth = page.visual.documentWidth;
      this.#documentHeight = page.visual.documentHeight;
      applyMirrorTextLayout(mirror, this.environment.readPreferences().textLayoutMode);
      this.updateLayout();
      if (typeof ResizeObserver === 'function') {
        this.#resizeObserver = new ResizeObserver(this.updateLayout);
        this.#resizeObserver.observe(scroller);
        this.#resizeObserver.observe(scaleLayer);
      }
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(this.updateLayout);
      }
      return;
    }
    this.#renderFlatSnapshot(article, page);
    container.replaceChildren(article);
  }

  /** Adopts the root a live delta produced, with the page's new extent. */
  replaceRoot(root: HTMLElement, documentWidth: number, documentHeight: number): void {
    this.#root = root;
    this.#documentWidth = documentWidth;
    this.#documentHeight = documentHeight;
  }

  readonly updateLayout = (): void => {
    const preferences = this.environment.readPreferences();
    const { replayHost } = this.environment;
    replayHost.updateLayout({
      displayMode: preferences.displayMode,
      zoomPercent: preferences.zoomPercent,
    });
    this.environment.onLayoutUpdated?.();
    const sourceScroll = this.environment.readSourceScroll();
    if (replayHost.previewVisible && preferences.syncScroll && sourceScroll) {
      replayHost.followSourceScroll(sourceScroll);
    }
    const root = this.#root;
    const scroller = this.#scroller;
    const stage = this.#stage;
    const scaleLayer = this.#scaleLayer;
    if (!scroller || !stage || !scaleLayer || !root) return;
    const scale = computeMirrorScale(
      scroller.clientWidth,
      this.#viewportWidth,
      preferences.displayMode,
      preferences.zoomPercent,
    );
    this.#scale = scale;
    scaleLayer.style.width = `${this.#viewportWidth}px`;
    scaleLayer.style.minHeight = `${this.#documentHeight}px`;
    root.style.width = `${this.#viewportWidth}px`;
    const extent = computeMirrorExtent(
      scale,
      this.#documentWidth,
      this.#documentHeight,
      Math.max(scaleLayer.scrollWidth, root.scrollWidth),
      Math.max(scaleLayer.scrollHeight, root.scrollHeight),
    );
    scaleLayer.style.transform = `scale(${scale})`;
    stage.style.width = `${extent.width}px`;
    stage.style.height = `${extent.height}px`;
    if (preferences.syncScroll && sourceScroll) this.followSourceScroll(sourceScroll);
  };

  followSourceScroll(scroll: LivePageScrollMessage): void {
    this.environment.replayHost.followSourceScroll(scroll);
    const scroller = this.#scroller;
    if (!scroller) return;
    const maxMirrorX = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const maxMirrorY = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const faithful =
      this.environment.readPreferences().textLayoutMode === 'faithful' &&
      scroll.scrollTarget !== 'nested';
    scroller.scrollLeft = faithful
      ? Math.min(maxMirrorX, scroll.scrollX * this.#scale)
      : scroll.maxScrollX > 0
        ? (scroll.scrollX / scroll.maxScrollX) * maxMirrorX
        : 0;
    scroller.scrollTop = faithful
      ? Math.min(maxMirrorY, scroll.scrollY * this.#scale)
      : scroll.maxScrollY > 0
        ? (scroll.scrollY / scroll.maxScrollY) * maxMirrorY
        : 0;
  }

  /** Forgets the mounted mirror without touching the container. */
  disconnect(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = undefined;
    this.#root = undefined;
    this.#scroller = undefined;
    this.#stage = undefined;
    this.#scaleLayer = undefined;
  }

  applyTextLayout(mode: MirrorViewPreferences['textLayoutMode']): void {
    if (this.#root) applyMirrorTextLayout(this.#root, mode);
  }

  resetTextIfPresent(): void {
    if (this.#root) resetVisualMirrorText(this.#root);
  }

  /** Bounded visible text and image alt text for language detection. */
  languageSample(): string {
    const root = this.#root;
    if (!root) return '';
    const parts = [root.textContent ?? ''];
    for (const image of root.querySelectorAll('img[alt]')) {
      const alt = image.getAttribute('alt');
      if (alt) parts.push(alt);
    }
    return parts.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 20_000);
  }

  translationFieldCount(): number {
    return this.#root ? countVisualMirrorTranslationFields(this.#root) : 0;
  }

  renderLoading(): void {
    this.#renderEmptyState('empty-state', 'Preparing the live read-only mirror…');
  }

  renderError(message: string): void {
    this.#renderEmptyState('empty-state empty-state--error', message);
  }

  #renderEmptyState(className: string, message: string): void {
    const { document, container } = this.environment;
    const wrapper = document.createElement('div');
    wrapper.className = className;
    const text = document.createElement('p');
    text.textContent = message;
    wrapper.append(text);
    container.replaceChildren(wrapper);
  }

  #renderFlatSnapshot(article: HTMLElement, page: PageSnapshot): void {
    const { document } = this.environment;
    for (const item of page.items) {
      if (item.kind === 'text') {
        article.append(this.#renderText(item.role, item.text));
        continue;
      }
      const image = document.createElement('img');
      image.className = 'translated-image';
      image.src = item.src;
      image.alt = item.altText ?? '';
      image.referrerPolicy = 'no-referrer';
      article.append(image);
    }
    if (page.items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No eligible visible content was found.';
      article.append(empty);
    }
  }

  #renderText(role: SnapshotTextRole, text: string): HTMLElement {
    const { document } = this.environment;
    const element = role.startsWith('heading-')
      ? document.createElement(
          `h${Math.min(6, Math.max(2, Number(role.at(-1))))}` as keyof HTMLElementTagNameMap,
        )
      : role === 'quote'
        ? document.createElement('blockquote')
        : role === 'code'
          ? document.createElement('pre')
          : document.createElement('p');
    element.className = 'translated-text';
    element.textContent = text;
    element.dir = 'auto';
    return element;
  }
}
