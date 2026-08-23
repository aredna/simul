import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import { SemanticProofPresenter } from '../lib/replica/semantic-proof-presenter';
import type { ResolvedSemanticSourceProof } from '../lib/replica/semantic-source-receiver';

describe('SemanticProofPresenter', () => {
  it('refreshes derived presentation once per successful proof batch', () => {
    const { document } = parseHTML('<html><body></body></html>');
    let refreshes = 0;
    const options = {
      document,
      mode: 'isolated-html' as const,
      afterApply: () => {
        refreshes += 1;
      },
    };
    const presenter = new SemanticProofPresenter(options);

    expect(presenter.apply([])).toBe(true);
    expect(refreshes).toBe(1);
    expect(presenter.apply([])).toBe(true);
    expect(refreshes).toBe(2);

    presenter.clear();
    expect(refreshes).toBe(3);
  });

  it('restores dropdown options by identity without changing later options', () => {
    const { document } = parseHTML(`<html><body>
      <select multiple><option selected>One</option><option>Two</option></select>
      <iframe></iframe></body></html>`);
    const select = document.querySelector<HTMLSelectElement>('select')!;
    const first = select.options[0]!;
    const second = select.options[1]!;
    const frame = document.querySelector('iframe') as unknown as HTMLIFrameElement;
    const proofs: readonly ResolvedSemanticSourceProof[] = [{
      kind: 'select-presentation',
      proof: {
        kind: 'select-presentation', bridge: 'isolated-html', nodeId: 7,
        revision: 1, gate: 'controlSemantics', multiple: true, size: null,
        classifierVersion: 1,
      },
      target: select,
    }, {
      kind: 'select-state',
      proof: {
        kind: 'select-state', bridge: 'isolated-html', nodeId: 7,
        revision: 1, gate: 'formValues', selectedOptionNodeIds: [9],
        multiple: true, pickerOpen: false, classifierVersion: 1,
      },
      target: select,
      selectedOptions: [second],
    }];
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
      iframe: frame,
    });

    expect(presenter.apply(proofs)).toBe(true);
    expect(first.selected).toBe(false);
    expect(second.selected).toBe(true);

    const late = document.createElement('option') as HTMLOptionElement;
    late.textContent = 'Late';
    late.selected = true;
    late.setAttribute('data-simul-source-option-selected', 'late');
    select.prepend(late);
    select.append(first);
    presenter.clear();

    expect(first.selected).toBe(true);
    expect(second.selected).toBe(false);
    expect(late.getAttribute('data-simul-source-option-selected')).toBe('late');
  });
});
