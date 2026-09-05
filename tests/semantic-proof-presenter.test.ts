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

  it('does not restore stale dropdown state after same-value mirror updates', () => {
    const { document } = parseHTML(`<html><body>
      <select><option selected>One</option><option>Two</option></select>
      <iframe></iframe></body></html>`);
    const select = document.querySelector<HTMLSelectElement>('select')!;
    const first = select.options[0]!;
    const second = select.options[1]!;
    const frame = document.querySelector('iframe') as unknown as HTMLIFrameElement;
    const proofs: readonly ResolvedSemanticSourceProof[] = [{
      kind: 'select-presentation',
      proof: {
        kind: 'select-presentation', bridge: 'isolated-html', nodeId: 7,
        revision: 1, gate: 'controlSemantics', multiple: true, size: 2,
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

    // Attribute patching clears extension-owned select markers before applying
    // its own values. The new source values happen to equal the proof values.
    select.removeAttribute('data-simul-source-select-presentation');
    select.removeAttribute('data-simul-source-selection-state');
    select.removeAttribute('data-simul-source-picker-open');
    select.multiple = true;
    select.setAttribute('size', '2');
    first.selected = false;
    second.selected = true;

    presenter.clear();

    expect(select.multiple).toBe(true);
    expect(select.getAttribute('size')).toBe('2');
    expect(first.selected).toBe(false);
    expect(second.selected).toBe(true);
    expect(second.hasAttribute('data-simul-source-option-selected')).toBe(false);
  });

  it('preserves same-value mirror updates to typed control state', () => {
    const { document } = parseHTML(`<html><body>
      <input id="choice" type="checkbox">
      <button id="control">Continue</button>
      <div id="aria" role="checkbox" aria-checked="false"></div>
    </body></html>`);
    const choice = document.querySelector<HTMLInputElement>('#choice')!;
    const control = document.querySelector<HTMLButtonElement>('#control')!;
    const aria = document.querySelector<HTMLElement>('#aria')!;
    const proofs: readonly ResolvedSemanticSourceProof[] = [{
      kind: 'choice-state',
      proof: {
        kind: 'choice-state', bridge: 'isolated-html', nodeId: 1,
        revision: 1, gate: 'formValues', checked: true, indeterminate: false,
        classifierVersion: 1,
      },
      target: choice,
    }, {
      kind: 'control-state',
      proof: {
        kind: 'control-state', bridge: 'isolated-html', nodeId: 2,
        revision: 1, gate: 'controlSemantics', disabled: true,
        classifierVersion: 1,
      },
      target: control,
    }, {
      kind: 'aria-state',
      proof: {
        kind: 'aria-state', bridge: 'isolated-html', nodeId: 3,
        revision: 1, gate: 'formValues', state: 'checked', value: 'true',
        classifierVersion: 1,
      },
      target: aria,
    }];
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
    });
    expect(presenter.apply(proofs)).toBe(true);

    choice.removeAttribute('data-simul-source-choice-state');
    choice.checked = true;
    control.removeAttribute('data-simul-source-control-state');
    control.disabled = true;
    control.setAttribute('aria-disabled', 'true');
    aria.removeAttribute('data-simul-source-aria-checked-state');
    aria.setAttribute('aria-checked', 'true');

    presenter.clear();

    expect(choice.checked).toBe(true);
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(aria.getAttribute('aria-checked')).toBe('true');
  });

  it('presents toggle, current-item and indicator range state and restores them', () => {
    const { document } = parseHTML(`<html><body>
      <button id="bold">Bold</button>
      <a id="here" href="/here">Here</a>
      <div id="upload" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
    </body></html>`);
    const bold = document.querySelector<HTMLElement>('#bold')!;
    const here = document.querySelector<HTMLElement>('#here')!;
    const upload = document.querySelector<HTMLElement>('#upload')!;
    const base = {
      kind: 'aria-state', bridge: 'isolated-html', revision: 1,
      classifierVersion: 1,
    } as const;
    const proofs: readonly ResolvedSemanticSourceProof[] = [{
      kind: 'aria-state',
      proof: { ...base, nodeId: 1, gate: 'formValues', state: 'pressed', value: 'true' },
      target: bold,
    }, {
      kind: 'aria-state',
      proof: { ...base, nodeId: 2, gate: 'controlSemantics', state: 'current', value: 'page' },
      target: here,
    }, {
      kind: 'aria-state',
      proof: { ...base, nodeId: 3, gate: 'controlSemantics', state: 'valuenow', value: '42' },
      target: upload,
    }];
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
    });
    expect(presenter.apply(proofs)).toBe(true);
    expect(bold.getAttribute('aria-pressed')).toBe('true');
    expect(here.getAttribute('aria-current')).toBe('page');
    expect(upload.getAttribute('aria-valuenow')).toBe('42');
    expect(upload.getAttribute('aria-valuemin')).toBe('0');

    expect(presenter.apply([{
      kind: 'aria-state',
      proof: { ...base, nodeId: 1, revision: 2, gate: 'formValues', state: 'pressed', value: 'false' },
      target: bold,
    }])).toBe(true);
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    expect(here.hasAttribute('aria-current')).toBe(false);
    expect(upload.hasAttribute('aria-valuenow')).toBe(false);

    presenter.clear();
    expect(bold.hasAttribute('aria-pressed')).toBe(false);
    expect(bold.hasAttribute('data-simul-source-aria-pressed-state')).toBe(false);
    expect(upload.getAttribute('aria-valuemax')).toBe('100');
  });

  it('preserves same-value mirror updates to disclosure relationships', () => {
    const { document } = parseHTML(`<html><body>
      <button id="trigger">Menu</button><section id="original">Items</section>
      <iframe></iframe>
    </body></html>`);
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('section')!;
    const frame = document.querySelector('iframe') as unknown as HTMLIFrameElement;
    const relationId = 'semantic-disclosure-relation-v1:1:2';
    const proofs: readonly ResolvedSemanticSourceProof[] = [{
      kind: 'disclosure-state',
      proof: {
        kind: 'disclosure-state', bridge: 'isolated-html', relationId,
        revision: 1, gate: 'disclosureContent', triggerNodeId: 1,
        panelNodeId: 2, popupRole: 'menu', expanded: true,
        classifierVersion: 1,
      },
      trigger,
      panel,
    }];
    const presenter = new SemanticProofPresenter({
      document: document as unknown as Document,
      iframe: frame,
    });
    expect(presenter.apply(proofs)).toBe(true);

    trigger.removeAttribute('data-simul-source-disclosure-state');
    panel.removeAttribute('data-simul-source-disclosure-state');
    trigger.setAttribute('aria-controls', relationId);
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-haspopup', 'menu');
    panel.setAttribute('id', relationId);

    presenter.clear();

    expect(trigger.getAttribute('aria-controls')).toBe(relationId);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(panel.getAttribute('id')).toBe(relationId);
  });
});
