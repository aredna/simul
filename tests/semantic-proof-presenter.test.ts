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

  it('does not roll stale dropdown proof state over newer mirror updates', () => {
    const { document } = parseHTML(`<html><body>
      <select multiple size="2"><option selected>One</option><option>Two</option></select>
      <iframe></iframe></body></html>`);
    const select = document.querySelector<HTMLSelectElement>('select')!;
    const first = select.options[0]!;
    const second = select.options[1]!;
    const frame = document.querySelector('iframe') as unknown as HTMLIFrameElement;
    const proofs = (revision: number, selected: HTMLOptionElement, multiple: boolean) =>
      [{
        kind: 'select-presentation' as const,
        proof: {
          kind: 'select-presentation' as const, bridge: 'isolated-html' as const,
          nodeId: 7, revision, gate: 'controlSemantics' as const, multiple,
          size: multiple ? 2 : null, classifierVersion: 1 as const,
        },
        target: select,
      }, {
        kind: 'select-state' as const,
        proof: {
          kind: 'select-state' as const, bridge: 'isolated-html' as const,
          nodeId: 7, revision, gate: 'formValues' as const,
          selectedOptionNodeIds: [selected === first ? 8 : 9], multiple,
          pickerOpen: false, classifierVersion: 1 as const,
        },
        target: select,
        selectedOptions: [selected],
      }] satisfies readonly ResolvedSemanticSourceProof[];
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
      iframe: frame,
    });

    expect(presenter.apply(proofs(1, first, true))).toBe(true);

    // A mirror patch lands before its matching semantic proof batch.
    select.multiple = false;
    select.removeAttribute('size');
    first.selected = false;
    first.removeAttribute('data-simul-source-option-selected');
    second.selected = true;
    second.setAttribute('data-simul-source-option-selected', 'v1');

    expect(presenter.apply(proofs(2, second, false))).toBe(true);
    presenter.clear();

    expect(select.multiple).toBe(false);
    expect(select.hasAttribute('size')).toBe(false);
    expect(first.selected).toBe(false);
    expect(second.selected).toBe(true);
  });
});
