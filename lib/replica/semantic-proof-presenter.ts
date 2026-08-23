import {
  disposeReadOnlyReplicaDisclosures,
  installReadOnlyReplicaDisclosure,
  isReadOnlyReplicaDisclosureEvent,
  type ReadOnlyReplicaDisclosure,
} from './read-only-disclosure';
import {
  semanticSelectionTextFor,
  type ResolvedSemanticSourceProof,
} from './semantic-source-receiver';

export interface SemanticProofPresenterOptions {
  readonly document: Document;
  readonly iframe?: HTMLIFrameElement;
  readonly mode: 'isolated-html' | 'rrweb';
  readonly beforeApply?: () => void;
  readonly afterApply?: () => void;
  readonly setAncestorAccessibility?: (accessible: boolean) => boolean;
}

/** Applies only receiver-resolved state and owns every reversible DOM change. */
export class SemanticProofPresenter {
  readonly #cleanups: Array<() => void> = [];
  #proofs: readonly ResolvedSemanticSourceProof[] = Object.freeze([]);
  #firewallCleanup: (() => void) | undefined;
  #ancestorCleanup: (() => void) | undefined;

  constructor(private readonly options: SemanticProofPresenterOptions) {}

  apply(proofs: readonly ResolvedSemanticSourceProof[]): boolean {
    const previous = this.#proofs;
    try {
      this.options.beforeApply?.();
    } catch {
      // Preview-state retention is best effort and cannot widen source proof.
    }
    this.#teardown(false);
    if (this.#install(proofs)) {
      this.#proofs = Object.freeze([...proofs]);
      return true;
    }
    this.#teardown(false);
    if (this.#install(previous)) this.#proofs = previous;
    else {
      this.#teardown(false);
      this.#proofs = Object.freeze([]);
      try {
        this.options.afterApply?.();
      } catch {
        // Presentation is already cleared after both installations failed.
      }
    }
    return false;
  }

  clear(): void {
    this.#teardown();
    this.#proofs = Object.freeze([]);
  }

  #install(proofs: readonly ResolvedSemanticSourceProof[]): boolean {
    try {
      const presentedSelects = new Set(
        proofs.filter((resolved) => resolved.kind === 'select-presentation')
          .map((resolved) => resolved.proof.nodeId),
      );
      const ordered = [
        ...proofs.filter((resolved) => resolved.kind === 'select-presentation'),
        ...proofs.filter((resolved) => resolved.kind !== 'select-presentation'),
      ];
      for (const resolved of ordered) {
        const cleanup = applyTypedProof(resolved, presentedSelects);
        if (!cleanup) throw new Error('Typed semantic proof could not apply.');
        this.#cleanups.push(cleanup);
      }
      const interactive = proofs.filter((resolved) =>
        resolved.kind === 'select-presentation' ||
        resolved.kind === 'disclosure-state');
      if (this.options.mode === 'rrweb') {
        const selectStates = new Map<number, Extract<
          ResolvedSemanticSourceProof,
          { kind: 'select-state' }
        >>();
        for (const resolved of proofs) {
          if (resolved.kind === 'select-state') {
            selectStates.set(resolved.proof.nodeId, resolved);
          }
        }
        for (const resolved of interactive) {
          const cleanup = resolved.kind === 'select-presentation'
            ? createRrwebSelectFacsimile(
                resolved,
                selectStates.get(resolved.proof.nodeId),
              )
            : createRrwebDisclosureFacsimile(resolved);
          if (!cleanup) throw new Error('rrweb semantic facsimile failed.');
          this.#cleanups.push(cleanup);
        }
        if (interactive.length > 0) {
          this.#firewallCleanup = installRrwebSemanticFirewall(
            this.options.document,
            this.options.iframe,
          );
          if (!this.#firewallCleanup) {
            throw new Error('rrweb semantic action firewall failed.');
          }
        }
      } else if (interactive.length > 0) {
        this.#firewallCleanup = installSemanticFrameAccessibility(
          this.options.document,
          this.options.iframe,
        );
        if (!this.#firewallCleanup) {
          throw new Error('isolated semantic accessibility boundary failed.');
        }
      }
      if (interactive.length > 0 && this.options.setAncestorAccessibility) {
        if (this.options.setAncestorAccessibility(true) !== true) {
          throw new Error('semantic ancestor accessibility boundary failed.');
        }
        this.#ancestorCleanup = () => {
          this.options.setAncestorAccessibility?.(false);
        };
      }
      this.options.afterApply?.();
      return true;
    } catch {
      return false;
    }
  }

  #teardown(notify = true): void {
    disposeReadOnlyReplicaDisclosures(this.options.document);
    this.#ancestorCleanup?.();
    this.#ancestorCleanup = undefined;
    this.#firewallCleanup?.();
    this.#firewallCleanup = undefined;
    for (let index = this.#cleanups.length - 1; index >= 0; index -= 1) {
      try {
        this.#cleanups[index]?.();
      } catch {
        // Continue restoring every independent renderer-owned state slot.
      }
    }
    this.#cleanups.length = 0;
    if (notify) {
      try {
        this.options.afterApply?.();
      } catch {
        // Teardown is already fail-closed when a derived refresh is unavailable.
      }
    }
  }
}

function applyTypedProof(
  resolved: ResolvedSemanticSourceProof,
  presentedSelects: ReadonlySet<number>,
): (() => void) | undefined {
  if (resolved.kind === 'select-presentation') {
    const select = resolved.target;
    const originalMultiple = select.multiple;
    const originalSize = select.getAttribute('size');
    const originalMarker = select.getAttribute(
      'data-simul-source-select-presentation',
    );
    const presentedMultiple = resolved.proof.multiple;
    const presentedSize = resolved.proof.size === null
      ? null
      : String(resolved.proof.size);
    select.multiple = presentedMultiple;
    if (presentedSize === null) select.removeAttribute('size');
    else select.setAttribute('size', presentedSize);
    select.setAttribute('data-simul-source-select-presentation', 'v1');
    return () => {
      if (select.multiple === presentedMultiple) {
        select.multiple = originalMultiple;
      }
      if (select.getAttribute('size') === presentedSize) {
        restoreAttribute(select, 'size', originalSize);
      }
      if (select.getAttribute('data-simul-source-select-presentation') === 'v1') {
        restoreAttribute(
          select,
          'data-simul-source-select-presentation',
          originalMarker,
        );
      }
    };
  }
  if (resolved.kind === 'select-state') {
    if (!presentedSelects.has(resolved.proof.nodeId)) return () => undefined;
    const select = resolved.target;
    const options = [...select.options];
    const originalSelected = new Map(options.map((option) =>
      [option, option.selected] as const));
    const originalPickerOpen = select.getAttribute(
      'data-simul-source-picker-open',
    );
    const originalSelectionMarker = select.getAttribute(
      'data-simul-source-selection-state',
    );
    const selected = new Set(resolved.selectedOptions);
    const originalSelectedMarkers = new Map(options.map((option) => [
      option,
      option.getAttribute('data-simul-source-option-selected'),
    ] as const));
    const presentedSelected = new Map<HTMLOptionElement, boolean>();
    for (const option of options) {
      const isSelected = selected.has(option);
      presentedSelected.set(option, isSelected);
      option.selected = isSelected;
      if (isSelected) {
        option.setAttribute('data-simul-source-option-selected', 'v1');
      } else {
        option.removeAttribute('data-simul-source-option-selected');
      }
    }
    if (!select.multiple) {
      const first = resolved.selectedOptions[0];
      select.selectedIndex = first ? options.indexOf(first) : -1;
    }
    if (resolved.proof.pickerOpen) {
      select.setAttribute('data-simul-source-picker-open', 'v1');
    } else {
      select.removeAttribute('data-simul-source-picker-open');
    }
    select.setAttribute('data-simul-source-selection-state', 'v1');
    return () => {
      const ownedOptions = options.filter((option) => {
        if (!select.contains(option)) return false;
        const expectedSelected = presentedSelected.get(option) ?? false;
        const expectedMarker = expectedSelected ? 'v1' : null;
        return !(
          option.selected !== expectedSelected ||
          option.getAttribute('data-simul-source-option-selected') !==
            expectedMarker
        );
      });
      // Snapshot ownership before writing: changing one option can update the
      // selectedness of its siblings in a single-select control.
      for (const option of ownedOptions) {
        option.selected = originalSelected.get(option) ?? false;
        restoreAttribute(
          option,
          'data-simul-source-option-selected',
          originalSelectedMarkers.get(option) ?? null,
        );
      }
      restoreAttribute(select, 'data-simul-source-picker-open', originalPickerOpen);
      restoreAttribute(
        select,
        'data-simul-source-selection-state',
        originalSelectionMarker,
      );
    };
  }
  if (resolved.kind === 'choice-state') {
    const originalChecked = resolved.target.checked;
    const originalIndeterminate = resolved.target.indeterminate;
    resolved.target.checked = resolved.proof.checked;
    resolved.target.indeterminate = resolved.proof.indeterminate;
    return () => {
      resolved.target.checked = originalChecked;
      resolved.target.indeterminate = originalIndeterminate;
    };
  }
  if (resolved.kind === 'control-state') {
    const target = resolved.target as HTMLElement & { disabled?: boolean };
    const originalDisabled = typeof target.disabled === 'boolean'
      ? target.disabled
      : undefined;
    const originalAriaDisabled = target.getAttribute('aria-disabled');
    if (originalDisabled !== undefined) target.disabled = resolved.proof.disabled;
    target.setAttribute('aria-disabled', resolved.proof.disabled ? 'true' : 'false');
    return () => {
      if (originalDisabled !== undefined) target.disabled = originalDisabled;
      restoreAttribute(target, 'aria-disabled', originalAriaDisabled);
    };
  }
  if (resolved.kind === 'aria-state') {
    const attribute = `aria-${resolved.proof.state}`;
    const original = resolved.target.getAttribute(attribute);
    resolved.target.setAttribute(attribute, resolved.proof.value);
    return () => restoreAttribute(resolved.target, attribute, original);
  }
  const { trigger, panel, proof } = resolved;
  const original = new Map<string, string | null>([
    ['aria-controls', trigger.getAttribute('aria-controls')],
    ['aria-expanded', trigger.getAttribute('aria-expanded')],
    ['aria-haspopup', trigger.getAttribute('aria-haspopup')],
    ['id', panel.getAttribute('id')],
  ]);
  panel.setAttribute('id', proof.relationId);
  trigger.setAttribute('aria-controls', proof.relationId);
  trigger.setAttribute('aria-expanded', proof.expanded ? 'true' : 'false');
  trigger.setAttribute('aria-haspopup', proof.popupRole);
  return () => {
    restoreAttribute(trigger, 'aria-controls', original.get('aria-controls') ?? null);
    restoreAttribute(trigger, 'aria-expanded', original.get('aria-expanded') ?? null);
    restoreAttribute(trigger, 'aria-haspopup', original.get('aria-haspopup') ?? null);
    restoreAttribute(panel, 'id', original.get('id') ?? null);
  };
}

function createRrwebSelectFacsimile(
  resolved: Extract<ResolvedSemanticSourceProof, {
    kind: 'select-presentation';
  }>,
  state: Extract<ResolvedSemanticSourceProof, {
    kind: 'select-state';
  }> | undefined,
): (() => void) | undefined {
  const select = resolved.target;
  const parent = select.parentNode;
  if (!parent) return undefined;
  const document = select.ownerDocument;
  const originalStyle = select.getAttribute('style');
  const host = document.createElement(randomSemanticHostName('select'));
  host.setAttribute('data-simul-semantic-select-host', 'v1');
  hardenSemanticHost(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = SEMANTIC_FACSIMILE_CSS;
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.setAttribute('data-simul-semantic-select-trigger', 'v1');
  trigger.setAttribute('aria-haspopup', 'listbox');
  const panel = document.createElement('div');
  panel.setAttribute('data-simul-semantic-select-options', 'v1');
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-disabled', 'true');
  if (resolved.proof.multiple) panel.setAttribute('aria-multiselectable', 'true');
  appendSelectRows(select, panel, state !== undefined);
  trigger.textContent = state
    ? semanticSelectionTextFor(select)?.trim() ||
      selectedSelectLabels(select).join(', ') || '\u2014'
    : 'Options';
  shadow.append(style, trigger, panel);
  select.style.setProperty('display', 'none', 'important');
  select.insertAdjacentElement('afterend', host);
  const size = resolved.proof.size ?? 0;
  const presentation = resolved.proof.multiple || size > 1 ? 'list' : 'popup';
  let controller: ReadOnlyReplicaDisclosure;
  try {
    controller = installReadOnlyReplicaDisclosure({
      anchor: host,
      panel,
      presentation,
      ...(presentation === 'popup' ? { trigger } : {}),
      manageTriggerExpanded: presentation === 'popup',
      initiallyOpen: presentation === 'popup' &&
        state !== undefined &&
        select.getAttribute('data-simul-source-picker-open') === 'v1',
      visibleRows: size || 8,
    });
  } catch {
    host.remove();
    restoreAttribute(select, 'style', originalStyle);
    return undefined;
  }
  return () => {
    controller.dispose();
    host.remove();
    restoreAttribute(select, 'style', originalStyle);
  };
}

function createRrwebDisclosureFacsimile(
  resolved: Extract<ResolvedSemanticSourceProof, {
    kind: 'disclosure-state';
  }>,
): (() => void) | undefined {
  const { panel, trigger, proof } = resolved;
  if (!panel.parentNode) return undefined;
  const originalPanelStyle = panel.getAttribute('style');
  const originalTriggerStyle = trigger.getAttribute('style');
  const document = panel.ownerDocument;
  const triggerHost = document.createElement(
    randomSemanticHostName('disclosure-trigger'),
  );
  triggerHost.setAttribute('data-simul-semantic-disclosure-host', 'v1');
  hardenSemanticHost(triggerHost);
  const triggerShadow = triggerHost.attachShadow({ mode: 'open' });
  const triggerStyle = document.createElement('style');
  triggerStyle.textContent = SEMANTIC_FACSIMILE_CSS;
  const ownedTrigger = document.createElement('button');
  ownedTrigger.type = 'button';
  ownedTrigger.textContent = 'Details';
  ownedTrigger.setAttribute('aria-haspopup', proof.popupRole);
  const panelHost = document.createElement(
    randomSemanticHostName('disclosure-panel'),
  );
  panelHost.setAttribute('data-simul-semantic-disclosure-panel-host', 'v1');
  hardenSemanticHost(panelHost);
  const panelShadow = panelHost.attachShadow({ mode: 'open' });
  const panelStyle = document.createElement('style');
  panelStyle.textContent = SEMANTIC_FACSIMILE_CSS;
  const clone = panel.cloneNode(true) as HTMLElement;
  scrubSemanticClone(clone);
  const cloneId = `${proof.relationId}-preview`;
  clone.setAttribute('id', cloneId);
  ownedTrigger.setAttribute('aria-controls', cloneId);
  triggerShadow.append(triggerStyle, ownedTrigger);
  panelShadow.append(panelStyle, clone);
  panel.style.setProperty('display', 'none', 'important');
  trigger.style.setProperty('display', 'none', 'important');
  trigger.insertAdjacentElement('afterend', triggerHost);
  panel.insertAdjacentElement('afterend', panelHost);
  let controller: ReadOnlyReplicaDisclosure;
  try {
    controller = installReadOnlyReplicaDisclosure({
      anchor: triggerHost,
      trigger: ownedTrigger,
      panel: panelHost,
      presentation: 'popup',
      manageTriggerExpanded: true,
      initiallyOpen: proof.expanded,
    });
  } catch {
    triggerHost.remove();
    panelHost.remove();
    restoreAttribute(panel, 'style', originalPanelStyle);
    restoreAttribute(trigger, 'style', originalTriggerStyle);
    return undefined;
  }
  return () => {
    controller.dispose();
    triggerHost.remove();
    panelHost.remove();
    restoreAttribute(panel, 'style', originalPanelStyle);
    restoreAttribute(trigger, 'style', originalTriggerStyle);
  };
}

function appendSelectRows(
  select: HTMLSelectElement,
  panel: HTMLElement,
  exposeSelection: boolean,
): void {
  for (const child of [...select.children]) {
    if (child.localName.toLowerCase() === 'option') {
      panel.append(createSelectRow(
        child as HTMLOptionElement,
        false,
        exposeSelection,
      ));
      continue;
    }
    if (child.localName.toLowerCase() !== 'optgroup') continue;
    const groupElement = child as HTMLOptGroupElement;
    const group = select.ownerDocument.createElement('div');
    group.setAttribute('role', 'group');
    const label = groupElement.getAttribute('label')?.trim();
    if (label) {
      const heading = select.ownerDocument.createElement('div');
      heading.setAttribute('data-simul-semantic-optgroup-label', 'v1');
      heading.textContent = label;
      group.append(heading);
    }
    for (const option of [...groupElement.children]) {
      if (option.localName.toLowerCase() === 'option') {
        group.append(createSelectRow(
          option as HTMLOptionElement,
          groupElement.disabled,
          exposeSelection,
        ));
      }
    }
    panel.append(group);
  }
}

function createSelectRow(
  option: HTMLOptionElement,
  groupDisabled: boolean,
  exposeSelection: boolean,
): HTMLElement {
  const row = option.ownerDocument.createElement('div');
  row.setAttribute('role', 'option');
  if (exposeSelection) {
    row.setAttribute(
      'aria-selected',
      option.getAttribute('data-simul-source-option-selected') === 'v1'
        ? 'true'
        : 'false',
    );
  }
  if (groupDisabled || option.disabled) row.setAttribute('aria-disabled', 'true');
  row.textContent = (option.getAttribute('label') ?? option.textContent ?? '')
    .replace(/\s+/gu, ' ').trim() || '\u00a0';
  return row;
}

function selectedSelectLabels(select: HTMLSelectElement): string[] {
  return [...select.options].filter((option) =>
    option.getAttribute('data-simul-source-option-selected') === 'v1')
    .map((option) =>
    (option.getAttribute('label') ?? option.textContent ?? '')
      .replace(/\s+/gu, ' ').trim()).filter(Boolean);
}

function hardenSemanticHost(host: HTMLElement): void {
  for (const [property, value] of [
    ['all', 'initial'], ['display', 'inline-block'], ['max-width', '100%'],
    ['background', 'none'], ['border', '0'], ['filter', 'none'],
    ['mask', 'none'], ['pointer-events', 'auto'],
  ] as const) host.style.setProperty(property, value, 'important');
}

function scrubSemanticClone(root: HTMLElement): void {
  const pending: Element[] = [root];
  while (pending.length > 0) {
    const element = pending.pop();
    if (!element) continue;
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name === 'id' || name.startsWith('on') || name === 'href' ||
        name === 'src' || name === 'srcset' || name === 'poster' ||
        name === 'action' || name === 'formaction' || name === 'target' ||
        name === 'download'
      ) element.removeAttribute(attribute.name);
    }
    (element as HTMLElement).style?.setProperty(
      'pointer-events',
      'none',
      'important',
    );
    pending.push(...element.children);
  }
}

function installRrwebSemanticFirewall(
  document: Document,
  providedFrame?: HTMLIFrameElement,
): (() => void) | undefined {
  const frame = semanticFrameFor(document, providedFrame);
  if (!frame) return undefined;
  const originalInert = frame.hasAttribute('inert');
  const originalPointerEvents = frame.style.pointerEvents;
  const originalAriaHidden = frame.getAttribute('aria-hidden');
  frame.removeAttribute('inert');
  frame.removeAttribute('aria-hidden');
  frame.style.setProperty('pointer-events', 'auto', 'important');
  const block = (event: Event): void => {
    if (isReadOnlyReplicaDisclosureEvent(event)) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onWheel = (event: WheelEvent): void => {
    if (isReadOnlyReplicaDisclosureEvent(event)) return;
    const scroller = frame.parentElement?.closest('.replica-replay-scroll');
    if (scroller instanceof HTMLElement) {
      scroller.scrollLeft += event.deltaX;
      scroller.scrollTop += event.deltaY;
    }
    block(event);
  };
  for (const type of SEMANTIC_BLOCKED_EVENTS) {
    document.addEventListener(type, block, true);
  }
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  return () => {
    for (const type of SEMANTIC_BLOCKED_EVENTS) {
      document.removeEventListener(type, block, true);
    }
    document.removeEventListener('wheel', onWheel, true);
    if (originalInert) frame.setAttribute('inert', '');
    else frame.removeAttribute('inert');
    restoreAttribute(frame, 'aria-hidden', originalAriaHidden);
    frame.style.pointerEvents = originalPointerEvents;
  };
}

function installSemanticFrameAccessibility(
  document: Document,
  providedFrame?: HTMLIFrameElement,
): (() => void) | undefined {
  const frame = semanticFrameFor(document, providedFrame);
  if (!frame) return undefined;
  const originalInert = frame.hasAttribute('inert');
  const originalAriaHidden = frame.getAttribute('aria-hidden');
  const originalPointerEvents = frame.style.pointerEvents;
  frame.removeAttribute('inert');
  frame.removeAttribute('aria-hidden');
  frame.style.setProperty('pointer-events', 'auto', 'important');
  return () => {
    if (originalInert) frame.setAttribute('inert', '');
    else frame.removeAttribute('inert');
    restoreAttribute(frame, 'aria-hidden', originalAriaHidden);
    frame.style.pointerEvents = originalPointerEvents;
  };
}

function semanticFrameFor(
  document: Document,
  providedFrame?: HTMLIFrameElement,
): HTMLIFrameElement | undefined {
  try {
    const frame = providedFrame ??
      document.defaultView?.frameElement as HTMLIFrameElement | null;
    if (!frame || (frame.contentDocument && frame.contentDocument !== document)) {
      return undefined;
    }
    return frame;
  } catch {
    return undefined;
  }
}

function randomSemanticHostName(kind: string): string {
  const entropy = globalThis.crypto?.randomUUID?.()
    .replace(/[^a-z0-9]/giu, '').toLowerCase() ??
    Math.random().toString(36).slice(2);
  return `simul-semantic-${kind}-${entropy || 'owned'}`;
}

function restoreAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}

const SEMANTIC_BLOCKED_EVENTS = Object.freeze([
  'auxclick', 'beforeinput', 'change', 'click', 'contextmenu', 'dblclick',
  'dragstart', 'drop', 'input', 'keydown', 'keypress', 'keyup', 'pointerdown',
  'pointerup', 'submit', 'touchstart',
]);

const SEMANTIC_FACSIMILE_CSS = `:host{all:initial!important;display:inline-block!important;box-sizing:border-box!important;max-width:100%!important;color:CanvasText!important;font:menu!important;pointer-events:auto!important}:host([hidden]){display:none!important}button,[role="listbox"]{box-sizing:border-box!important;max-width:100%!important;background:Canvas!important;color:CanvasText!important;border:1px solid GrayText!important;font:inherit!important}button{min-height:1.75em!important;padding:.25rem .5rem!important;pointer-events:auto!important}[role="listbox"]{display:block!important;max-height:min(18rem,70vh)!important;overflow:auto!important;pointer-events:auto!important}[role="option"],[role="group"]{display:block!important;padding:.25rem .5rem!important;pointer-events:none!important;white-space:normal!important}[aria-selected="true"]{font-weight:700!important}`;
