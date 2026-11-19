import { readFileSync } from 'node:fs';

import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { applyEditionToDocument } from '../lib/edition-markup';

const markup = readFileSync(
  new URL('../entrypoints/sidepanel/index.html', import.meta.url),
  'utf8',
);

describe('sidepanel static control accessibility', () => {
  it.each(['public', 'dev'] as const)('gives every static form control of the %s edition an accessible name', (edition) => {
    const { document } = parseHTML(markup);
    applyEditionToDocument(document as unknown as Document, edition);
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
