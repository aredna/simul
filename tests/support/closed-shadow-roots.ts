/**
 * A stand-in for `chrome.dom.openOrClosedShadowRoot` (D125): it answers
 * with the roots a test registered and records every element it was asked
 * about. linkedom reads null from `shadowRoot` for a closed root, as Chrome
 * does, and has no `mode`, so the registered root is given one.
 */
export function closedRootReader() {
  const roots = new Map<Element, ShadowRoot>();
  const calls: Element[] = [];
  return {
    calls,
    add(host: Element, root: ShadowRoot): void {
      Object.defineProperty(root, 'mode', {
        configurable: true,
        value: 'closed',
      });
      roots.set(host, root);
    },
    /** `attachShadow({ mode: 'closed' })`, registered. */
    attach(host: Element, markup = ''): ShadowRoot {
      const root = host.attachShadow({ mode: 'closed' });
      if (markup) root.innerHTML = markup;
      this.add(host, root);
      return root;
    },
    read: (element: HTMLElement): ShadowRoot | null => {
      calls.push(element);
      return roots.get(element) ?? null;
    },
  };
}

export type ClosedRootReader = ReturnType<typeof closedRootReader>;
