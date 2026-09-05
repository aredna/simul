/**
 * Scopes of asynchronous side-panel work that can be superseded
 * independently of one another.
 *
 * - `identity`: resolving which tab the companion follows.
 * - `availability`: a translator availability check for the current pair.
 * - `language-refresh`: a commit-driven refresh of the detected language.
 * - `language-resolution`: one resolution of the page's source language.
 * - `image-access`: a check of the image-capture permission grant.
 */
export type CurrencyScope =
  | 'identity'
  | 'availability'
  | 'language-refresh'
  | 'language-resolution'
  | 'image-access';

export interface CurrencyToken {
  readonly scope: CurrencyScope;
  readonly id: number;
}

/** Every scope that belongs to the followed page and dies with it. */
export const PAGE_CURRENCY_SCOPES: readonly CurrencyScope[] = [
  'identity',
  'availability',
  'language-refresh',
  'language-resolution',
];

/**
 * One currency for the superseding counters the side panel used to keep by
 * hand. A token carries its scope, so a guard cannot compare it against the
 * wrong counter, and page-level invalidation supersedes every page-scoped
 * token in a single call. Capture generations stay with the capture
 * coordinator, which already models one running and one queued request.
 */
export class Currency {
  readonly #counters = new Map<CurrencyScope, number>();

  /** Starts a new unit of work in `scope`, superseding the previous one. */
  begin(scope: CurrencyScope): CurrencyToken {
    const id = (this.#counters.get(scope) ?? 0) + 1;
    this.#counters.set(scope, id);
    return Object.freeze({ scope, id });
  }

  /** Supersedes in-flight work in the given scopes without starting new work. */
  supersede(...scopes: readonly CurrencyScope[]): void {
    for (const scope of scopes) this.begin(scope);
  }

  /** Supersedes every page-scoped unit of work. */
  supersedePage(): void {
    this.supersede(...PAGE_CURRENCY_SCOPES);
  }

  isCurrent(token: CurrencyToken): boolean {
    return (this.#counters.get(token.scope) ?? 0) === token.id;
  }
}
