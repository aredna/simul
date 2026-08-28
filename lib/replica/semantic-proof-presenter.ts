import {
  disposeReadOnlyReplicaDisclosures,
  installReadOnlyReplicaDisclosure,
  type ReadOnlyReplicaDisclosure,
} from './read-only-disclosure';
import {
  type ResolvedSemanticSourceProof,
} from './semantic-source-receiver';

export interface SemanticProofPresenterOptions {
  readonly document: Document;
  readonly iframe?: HTMLIFrameElement;
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
      const presentedSelects = new Set<number>();
      const selectPresentations: Array<Extract<
        ResolvedSemanticSourceProof,
        { kind: 'select-presentation' }
      >> = [];
      const structuralMenus: Array<Extract<
        ResolvedSemanticSourceProof,
        { kind: 'structural-menu' }
      >> = [];
      let hasInteractiveProof = false;
      for (const resolved of proofs) {
        if (resolved.kind === 'select-presentation') {
          presentedSelects.add(resolved.proof.nodeId);
          selectPresentations.push(resolved);
        }
        if (resolved.kind === 'structural-menu') structuralMenus.push(resolved);
        hasInteractiveProof ||= resolved.kind === 'select-presentation' ||
          resolved.kind === 'disclosure-state' ||
          resolved.kind === 'structural-menu';
      }
      for (const resolved of selectPresentations) {
        const cleanup = applyTypedProof(resolved, presentedSelects);
        if (!cleanup) throw new Error('Typed semantic proof could not apply.');
        this.#cleanups.push(cleanup);
      }
      for (const resolved of proofs) {
        if (resolved.kind === 'select-presentation') continue;
        const cleanup = applyTypedProof(resolved, presentedSelects);
        if (!cleanup) throw new Error('Typed semantic proof could not apply.');
        this.#cleanups.push(cleanup);
      }
      if (hasInteractiveProof) {
        this.#firewallCleanup = installSemanticFrameAccessibility(
          this.options.document,
          this.options.iframe,
        );
        if (!this.#firewallCleanup) {
          throw new Error('isolated semantic accessibility boundary failed.');
        }
      }
      if (hasInteractiveProof && this.options.setAncestorAccessibility) {
        if (this.options.setAncestorAccessibility(true) !== true) {
          throw new Error('semantic ancestor accessibility boundary failed.');
        }
        this.#ancestorCleanup = () => {
          this.options.setAncestorAccessibility?.(false);
        };
      }
      this.options.afterApply?.();
      // Integrated refresh rebuilds its native/ARIA facsimiles and disposes
      // existing disclosure controllers. Install structural menus afterward
      // so the isolated replica uses the live translated panel and authored
      // trigger instead of a stale cloned or generic replacement control.
      for (const resolved of structuralMenus) {
        const cleanup = installStructuralMenuDisclosure(resolved);
        if (!cleanup) throw new Error('Structural menu presentation failed.');
        this.#cleanups.push(cleanup);
      }
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
      const stillOwned = select.getAttribute(
        'data-simul-source-select-presentation',
      ) === 'v1';
      if (stillOwned && select.multiple === presentedMultiple) {
        select.multiple = originalMultiple;
      }
      if (stillOwned && select.getAttribute('size') === presentedSize) {
        restoreAttribute(select, 'size', originalSize);
      }
      if (stillOwned) {
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
    const originalPickerOpen = select.getAttribute(
      'data-simul-source-picker-open',
    );
    const originalSelectionMarker = select.getAttribute(
      'data-simul-source-selection-state',
    );
    const selected = new Set(resolved.selectedOptions);
    const originalSelected: boolean[] = [];
    const originalSelectedMarkers: Array<string | null> = [];
    const presentedSelected: boolean[] = [];
    for (const option of options) {
      originalSelected.push(option.selected);
      originalSelectedMarkers.push(
        option.getAttribute('data-simul-source-option-selected'),
      );
    }
    for (const option of options) {
      const isSelected = selected.has(option);
      presentedSelected.push(isSelected);
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
      const markerOwnedIndexes: number[] = [];
      const stateOwnedIndexes: number[] = [];
      const selectionStillOwned = select.getAttribute(
        'data-simul-source-selection-state',
      ) === 'v1';
      for (let index = 0; index < options.length; index += 1) {
        const option = options[index]!;
        if (!select.contains(option)) continue;
        const expectedSelected = presentedSelected[index] ?? false;
        const expectedMarker = expectedSelected ? 'v1' : null;
        if (
          option.getAttribute('data-simul-source-option-selected') !==
            expectedMarker
        ) continue;
        markerOwnedIndexes.push(index);
        if (selectionStillOwned && option.selected === expectedSelected) {
          stateOwnedIndexes.push(index);
        }
      }
      if (selectionStillOwned) {
        // Snapshot ownership before writing: changing one option can update
        // the selectedness of its siblings in a single-select control.
        for (const index of stateOwnedIndexes) {
          options[index]!.selected = originalSelected[index] ?? false;
        }
      }
      // A base mirror patch removes the select-level ownership marker. Clear
      // any option markers that remain ours without rolling source selectedness
      // back over that newer patch.
      for (const index of markerOwnedIndexes) {
        restoreAttribute(
          options[index]!,
          'data-simul-source-option-selected',
          originalSelectedMarkers[index] ?? null,
        );
      }
      if (selectionStillOwned) {
        restoreAttribute(
          select,
          'data-simul-source-picker-open',
          originalPickerOpen,
        );
        restoreAttribute(
          select,
          'data-simul-source-selection-state',
          originalSelectionMarker,
        );
      }
    };
  }
  if (resolved.kind === 'choice-state') {
    const originalChecked = resolved.target.checked;
    const originalIndeterminate = resolved.target.indeterminate;
    const originalMarker = resolved.target.getAttribute(
      'data-simul-source-choice-state',
    );
    resolved.target.checked = resolved.proof.checked;
    resolved.target.indeterminate = resolved.proof.indeterminate;
    resolved.target.setAttribute('data-simul-source-choice-state', 'v1');
    return () => {
      const stillOwned = resolved.target.getAttribute(
        'data-simul-source-choice-state',
      ) === 'v1';
      if (
        stillOwned && resolved.target.checked === resolved.proof.checked &&
        resolved.target.indeterminate === resolved.proof.indeterminate
      ) {
        resolved.target.checked = originalChecked;
        resolved.target.indeterminate = originalIndeterminate;
      }
      if (stillOwned) {
        restoreAttribute(
          resolved.target,
          'data-simul-source-choice-state',
          originalMarker,
        );
      }
    };
  }
  if (resolved.kind === 'control-state') {
    const target = resolved.target as HTMLElement & { disabled?: boolean };
    const originalDisabled = typeof target.disabled === 'boolean'
      ? target.disabled
      : undefined;
    const originalAriaDisabled = target.getAttribute('aria-disabled');
    const originalMarker = target.getAttribute('data-simul-source-control-state');
    if (originalDisabled !== undefined) target.disabled = resolved.proof.disabled;
    const presentedAriaDisabled = resolved.proof.disabled ? 'true' : 'false';
    target.setAttribute('aria-disabled', presentedAriaDisabled);
    target.setAttribute('data-simul-source-control-state', 'v1');
    return () => {
      const stillOwned = target.getAttribute(
        'data-simul-source-control-state',
      ) === 'v1';
      if (
        stillOwned &&
        (originalDisabled === undefined || target.disabled === resolved.proof.disabled) &&
        target.getAttribute('aria-disabled') === presentedAriaDisabled
      ) {
        if (originalDisabled !== undefined) target.disabled = originalDisabled;
        restoreAttribute(target, 'aria-disabled', originalAriaDisabled);
      }
      if (stillOwned) {
        restoreAttribute(target, 'data-simul-source-control-state', originalMarker);
      }
    };
  }
  if (resolved.kind === 'aria-state') {
    const attribute = `aria-${resolved.proof.state}`;
    const marker = `data-simul-source-aria-${resolved.proof.state}-state`;
    const original = resolved.target.getAttribute(attribute);
    const originalMarker = resolved.target.getAttribute(marker);
    resolved.target.setAttribute(attribute, resolved.proof.value);
    resolved.target.setAttribute(marker, 'v1');
    return () => {
      const stillOwned = resolved.target.getAttribute(marker) === 'v1';
      if (
        stillOwned &&
        resolved.target.getAttribute(attribute) === resolved.proof.value
      ) restoreAttribute(resolved.target, attribute, original);
      if (stillOwned) restoreAttribute(resolved.target, marker, originalMarker);
    };
  }
  if (resolved.kind === 'tab-state') {
    const { trigger, panel, proof } = resolved;
    const controlId = resolved.panelId ?? proof.relationId;
    const originalControls = trigger.getAttribute('aria-controls');
    const originalSelected = trigger.getAttribute('aria-selected');
    const originalHasPopup = trigger.getAttribute('aria-haspopup');
    const originalPanelId = panel.getAttribute('id');
    const originalPanelHidden = panel.getAttribute('aria-hidden');
    if (resolved.panelId === undefined) panel.setAttribute('id', controlId);
    panel.setAttribute('aria-hidden', proof.selected ? 'false' : 'true');
    trigger.setAttribute('aria-controls', controlId);
    trigger.setAttribute('aria-selected', proof.selected ? 'true' : 'false');
    trigger.removeAttribute('aria-haspopup');
    return () => {
      restoreAttribute(trigger, 'aria-controls', originalControls);
      restoreAttribute(trigger, 'aria-selected', originalSelected);
      restoreAttribute(trigger, 'aria-haspopup', originalHasPopup);
      restoreAttribute(panel, 'id', originalPanelId);
      restoreAttribute(panel, 'aria-hidden', originalPanelHidden);
    };
  }
  const { trigger, panel, proof } = resolved;
  const originalControls = trigger.getAttribute('aria-controls');
  const originalExpanded = trigger.getAttribute('aria-expanded');
  const originalHasPopup = trigger.getAttribute('aria-haspopup');
  const originalPanelId = panel.getAttribute('id');
  const originalTriggerMarker = trigger.getAttribute(
    'data-simul-source-disclosure-state',
  );
  const originalPanelMarker = panel.getAttribute(
    'data-simul-source-disclosure-state',
  );
  const presentedExpanded = proof.expanded ? 'true' : 'false';
  panel.setAttribute('id', proof.relationId);
  trigger.setAttribute('aria-controls', proof.relationId);
  trigger.setAttribute('aria-expanded', presentedExpanded);
  trigger.setAttribute('aria-haspopup', proof.popupRole);
  trigger.setAttribute('data-simul-source-disclosure-state', 'v1');
  panel.setAttribute('data-simul-source-disclosure-state', 'v1');
  return () => {
    const triggerStillOwned = trigger.getAttribute(
      'data-simul-source-disclosure-state',
    ) === 'v1';
    const panelStillOwned = panel.getAttribute(
      'data-simul-source-disclosure-state',
    ) === 'v1';
    if (
      triggerStillOwned &&
      trigger.getAttribute('aria-controls') === proof.relationId &&
      trigger.getAttribute('aria-expanded') === presentedExpanded &&
      trigger.getAttribute('aria-haspopup') === proof.popupRole
    ) {
      restoreAttribute(trigger, 'aria-controls', originalControls);
      restoreAttribute(trigger, 'aria-expanded', originalExpanded);
      restoreAttribute(trigger, 'aria-haspopup', originalHasPopup);
    }
    if (panelStillOwned && panel.getAttribute('id') === proof.relationId) {
      restoreAttribute(panel, 'id', originalPanelId);
    }
    if (triggerStillOwned) {
      restoreAttribute(
        trigger,
        'data-simul-source-disclosure-state',
        originalTriggerMarker,
      );
    }
    if (panelStillOwned) {
      restoreAttribute(
        panel,
        'data-simul-source-disclosure-state',
        originalPanelMarker,
      );
    }
  };
}

function installStructuralMenuDisclosure(
  resolved: Extract<ResolvedSemanticSourceProof, {
    kind: 'structural-menu';
  }>,
): (() => void) | undefined {
  const { panel, trigger, proof } = resolved;
  if (!panel.parentNode || !trigger.parentNode) return undefined;
  let controller: ReadOnlyReplicaDisclosure;
  try {
    controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      manageTriggerExpanded: true,
      initiallyOpen: proof.expanded,
    });
  } catch {
    return undefined;
  }
  return () => controller.dispose();
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

function restoreAttribute(
  element: Element,
  name: string,
  value: string | null,
): void {
  if (value === null) element.removeAttribute(name);
  else element.setAttribute(name, value);
}
