import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

const markup = readFileSync(
  new URL('../entrypoints/sidepanel/index.html', import.meta.url),
  'utf8',
);

describe('sidepanel static control accessibility', () => {
  it('gives every static form control an accessible name', () => {
    const { document } = parseHTML(markup);
    const unnamed = [...document.querySelectorAll<HTMLElement>(
      'button, input, select, textarea',
    )].filter((control) => !controlName(control, document));

    expect(unnamed.map((control) => `${control.localName}#${control.id}`))
      .toEqual([]);
  });
});

function controlName(control: HTMLElement, document: Document): string {
  const explicit = control.getAttribute('aria-label') ??
    control.getAttribute('aria-labelledby') ??
    control.getAttribute('title');
  if (explicit?.trim()) return explicit.trim();
  if (control.id) {
    const label = document.querySelector<HTMLLabelElement>(
      `label[for="${control.id}"]`,
    );
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const wrappingLabel = control.closest('label')?.textContent?.trim();
  if (wrappingLabel) return wrappingLabel;
  return control.localName === 'button'
    ? control.textContent?.trim() ?? ''
    : '';
}
