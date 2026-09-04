import type { ScriptPublicPath } from 'wxt/utils/inject-script';

/** One result of a script injection into the followed page. */
export interface InjectionResult {
  readonly result?: unknown;
  readonly documentId?: string | undefined;
}

/**
 * The two injection shapes the side panel uses. A function passed to
 * `runFunction` is serialized by Chrome and evaluated in the page, so it must
 * be closure-free; `tests/injection-boundary.test.ts` proves that for each
 * function injected by reference.
 */
export interface PageScripting {
  runFile(tabId: number, file: ScriptPublicPath): Promise<InjectionResult[]>;
  runFunction<Args extends unknown[]>(
    tabId: number,
    func: (...args: Args) => unknown,
    args: Args,
  ): Promise<InjectionResult[]>;
}
