import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { DynamicStatusText } from '../entrypoints/sidepanel/dynamic-status-text';

function setup() {
  const { document } = parseHTML('<html><body><p id="status"></p></body></html>');
  const element = document.getElementById('status') as unknown as HTMLElement;
  // A mutable dictionary so a test can simulate a language switch between the
  // initial set() and a later relocalize().
  const dictionary = new Map<string, string>();
  const localize = (english: string): string => dictionary.get(english) ?? english;
  const status = new DynamicStatusText(element, localize);
  return { element, dictionary, status };
}

describe('DynamicStatusText', () => {
  it('renders a plain catalogue frame in the current language', () => {
    const { element, dictionary, status } = setup();
    dictionary.set('Saving…', 'Guardando…');
    status.set('Saving…');
    expect(element.textContent).toBe('Guardando…');
  });

  it('fills numbered placeholders after localizing the frame', () => {
    const { element, dictionary, status } = setup();
    dictionary.set('{0} sites still need cleanup.', 'Aún faltan {0} sitios por limpiar.');
    status.set('{0} sites still need cleanup.', [3]);
    expect(element.textContent).toBe('Aún faltan 3 sitios por limpiar.');
  });

  it('re-renders the stored frame and arguments on a language switch', () => {
    const { element, dictionary, status } = setup();
    status.set('{0} sites still need cleanup.', [2]);
    expect(element.textContent).toBe('2 sites still need cleanup.');

    dictionary.set('{0} sites still need cleanup.', 'Aún faltan {0} sitios por limpiar.');
    status.relocalize();
    expect(element.textContent).toBe('Aún faltan 2 sitios por limpiar.');
  });

  it('passes a non-catalogue message through unchanged and still re-renders', () => {
    const { element, dictionary, status } = setup();
    // Error detail strings are not catalogue entries; the localizer returns them
    // unchanged, and a language switch must not corrupt them.
    status.set('DOMException: quota exceeded');
    expect(element.textContent).toBe('DOMException: quota exceeded');
    dictionary.set('Saving…', 'Guardando…');
    status.relocalize();
    expect(element.textContent).toBe('DOMException: quota exceeded');
  });

  it('clears the line and stops re-localizing once cleared', () => {
    const { element, dictionary, status } = setup();
    status.set('Saving…');
    status.clear();
    expect(element.textContent).toBe('');

    // A relocalize after clearing leaves the line empty rather than resurrecting
    // the last message in the new language.
    dictionary.set('Saving…', 'Guardando…');
    status.relocalize();
    expect(element.textContent).toBe('');
  });
});
