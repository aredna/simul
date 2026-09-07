import { formatUiTemplate } from '../../lib/companion-ui-strings';

/**
 * A status line written imperatively from code rather than through the
 * `data-ui-*` marker path that the localizer re-drives on its DOM pass. It
 * remembers the last English catalogue frame and its interpolation arguments
 * so the visible text can be re-rendered in the language that is now current
 * after a pure language switch (review finding F2), mirroring
 * `ToolbarStatus.relocalize()`.
 *
 * Only the text content is owned here; the element's `data-tone` is left to
 * the caller, since a tone never changes with the UI language.
 */
export class DynamicStatusText {
  #frame = '';
  #args: readonly (string | number)[] = [];

  constructor(
    private readonly element: HTMLElement,
    private readonly localize: (english: string) => string,
  ) {}

  /**
   * Renders `frame` (an English catalogue entry) filled with `args` and
   * remembers both so a later `relocalize()` can re-render them. An empty
   * frame clears the line.
   */
  set(frame: string, args: readonly (string | number)[] = []): void {
    this.#frame = frame;
    this.#args = args;
    this.#render();
  }

  /** Clears the line and forgets any stored English. */
  clear(): void {
    this.set('');
  }

  /** Re-renders the stored English frame in the language now current. */
  relocalize(): void {
    if (this.#frame) this.#render();
  }

  #render(): void {
    const text = this.#frame
      ? formatUiTemplate(this.localize(this.#frame), this.#args)
      : '';
    if (this.element.textContent !== text) this.element.textContent = text;
  }
}
