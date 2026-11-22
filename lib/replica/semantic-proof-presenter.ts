import {
  disposeReadOnlyReplicaDisclosures,
  installReadOnlyReplicaDisclosure,
  type ReadOnlyReplicaDisclosure,
} from './read-only-disclosure';
import {
  changedReplicaRegion,
  resolvedProofTouchesRegion,
  sameResolvedSemanticSourceProof,
  semanticProofSetComesFromBatch,
  semanticProofSetComesFromScopedRefresh,
  semanticSourceProofIdentityOfResolved,
  type ResolvedSemanticSourceProof,
} from './semantic-source-receiver';
import { semanticAriaStateAttribute } from './semantic-source-protocol';
import {
  sourceCall,
  sourceProperty,
} from './source-node-accessors';

export interface SemanticProofPresenterOptions {
  readonly document: Document;
  readonly iframe?: HTMLIFrameElement;
  readonly beforeApply?: () => void;
  readonly afterApply?: () => void;
  readonly setAncestorAccessibility?: (accessible: boolean) => boolean;
}

/** Applies only receiver-resolved state and owns every reversible DOM change. */
export class SemanticProofPresenter {
  /**
   * What takes each proof's state down, by proof id, in the order put up
   * (D185: kept by proof, so that a refresh puts up again only the proofs a
   * live patch touched).
   */
  readonly #cleanups = new Map<string, () => void>();
  /**
   * The site menus shown, by proof id, each with what takes it down (D179):
   * kept apart from the other cleanups so that a batch can change one menu
   * and leave the others as they are.
   */
  readonly #menus = new Map<string, InstalledStructuralMenu>();
  #proofs: readonly ResolvedSemanticSourceProof[] = Object.freeze([]);
  #firewallCleanup: (() => void) | undefined;
  #ancestorCleanup: (() => void) | undefined;
  /**
   * The page popovers this presenter is showing, each with its `popover`
   * attribute and marker as they were. They are kept apart from the other
   * proofs, which are taken down and put up again at every presentation: a
   * popover hidden and shown again goes to the top of the top layer, over a
   * dropdown list the reader opened inside it (D132).
   */
  readonly #popovers = new Map<HTMLElement, {
    popover: string | null;
    readonly marker: string | null;
  }>();

  constructor(private readonly options: SemanticProofPresenterOptions) {}

  apply(proofs: readonly ResolvedSemanticSourceProof[]): boolean {
    const previous = this.#proofs;
    if (semanticProofSetComesFromBatch(proofs) && this.#applyMenusInPlace(proofs)) {
      return true;
    }
    if (
      semanticProofSetComesFromScopedRefresh(proofs) &&
      this.#applyTouchedInPlace(proofs)
    ) return true;
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
      this.#presentPopovers([]);
      try {
        this.options.afterApply?.();
      } catch {
        // Presentation is already cleared after both installations failed.
      }
    }
    return false;
  }

  /**
   * Before a live patch: takes down the site menus on or around what the
   * patch will change, and only those (D185). A menu's controller writes on
   * its trigger and panel; one the patch writes over is put up again after
   * it. The others stay up through the patch: the engine's own pass leaves
   * them (`survivesRefresh`) unless their nodes are gone. With a region too
   * large to walk, every menu is taken down.
   */
  takeDownMenusTouching(roots: readonly Node[]): void {
    if (this.#menus.size === 0) return;
    const region = changedReplicaRegion(roots);
    const resolvedById = new Map<string, ResolvedSemanticSourceProof>();
    if (region) {
      for (const resolved of this.#proofs) {
        resolvedById.set(semanticSourceProofIdentityOfResolved(resolved), resolved);
      }
    }
    for (const [proofId, installed] of [...this.#menus]) {
      const resolved = resolvedById.get(proofId);
      if (region && resolved && !resolvedProofTouchesRegion(resolved, region)) continue;
      this.#menus.delete(proofId);
      try {
        installed.dispose();
      } catch {
        // The next presentation puts the menu up again or presents whole.
      }
    }
  }

  clear(): void {
    this.#teardown();
    this.#proofs = Object.freeze([]);
    this.#presentPopovers([]);
  }

  /**
   * A batch whose proofs differ from what is shown only in site menus puts
   * up and takes down only those menus (D179). Every preview used to be
   * taken down and put up again at every change: 3,000 menus at each of a
   * page's changes. Anything else that differs, a menu whose controller is
   * gone, or a set with no interactive proof on either side is presented
   * whole (false). Nothing between two batches changes the replica but the
   * presenter: every live patch presents the whole set again.
   */
  #applyMenusInPlace(proofs: readonly ResolvedSemanticSourceProof[]): boolean {
    const previous = new Map<string, ResolvedSemanticSourceProof>();
    for (const resolved of this.#proofs) {
      previous.set(semanticSourceProofIdentityOfResolved(resolved), resolved);
    }
    const next = new Map<string, ResolvedSemanticSourceProof>();
    const previousPopovers: string[] = [];
    const nextPopovers: string[] = [];
    let interactive = false;
    for (const resolved of this.#proofs) {
      if (resolved.kind === 'popover-open') {
        previousPopovers.push(semanticSourceProofIdentityOfResolved(resolved));
      }
    }
    for (const resolved of proofs) {
      const proofId = semanticSourceProofIdentityOfResolved(resolved);
      if (next.has(proofId)) return false;
      next.set(proofId, resolved);
      if (resolved.kind === 'popover-open') nextPopovers.push(proofId);
      interactive ||= resolved.kind === 'select-presentation' ||
        resolved.kind === 'disclosure-state' ||
        resolved.kind === 'structural-menu';
    }
    if (
      !interactive || !this.#firewallCleanup ||
      previousPopovers.join('\u0000') !== nextPopovers.join('\u0000')
    ) return false;
    const changedMenus: string[] = [];
    for (const [proofId, resolved] of next) {
      const before = previous.get(proofId);
      const same = before !== undefined && sameResolvedSemanticSourceProof(before, resolved);
      if (resolved.kind !== 'structural-menu') {
        if (!same) return false;
        continue;
      }
      const installed = this.#menus.get(proofId);
      if (!same || !installed || installed.isDisposed()) changedMenus.push(proofId);
    }
    const goneMenus: string[] = [];
    for (const [proofId, resolved] of previous) {
      if (next.has(proofId)) continue;
      if (resolved.kind !== 'structural-menu') return false;
      goneMenus.push(proofId);
    }
    if (changedMenus.length === 0 && goneMenus.length === 0 &&
      previous.size === next.size) {
      this.#proofs = Object.freeze([...proofs]);
      return true;
    }
    // The menu's relation (`aria-controls`, `aria-expanded`, the panel's
    // id) is written by its typed proof, and is written again with it
    // (D185: a menu the page opened kept the `aria-expanded` it had).
    for (const proofId of [...goneMenus, ...changedMenus]) {
      const installed = this.#menus.get(proofId);
      this.#menus.delete(proofId);
      const cleanup = this.#cleanups.get(proofId);
      this.#cleanups.delete(proofId);
      try {
        installed?.dispose();
        cleanup?.();
      } catch {
        // Continue: the menu is shown again or the set is presented whole.
      }
    }
    for (const proofId of changedMenus) {
      const resolved = next.get(proofId);
      if (resolved?.kind !== 'structural-menu') return false;
      const cleanup = applyTypedProof(resolved, new Set());
      if (!cleanup) return false;
      this.#cleanups.set(proofId, cleanup);
      const installed = installStructuralMenuDisclosure(resolved);
      // Presented whole instead, which takes down what was put up here.
      if (!installed) return false;
      this.#menus.set(proofId, installed);
    }
    this.#proofs = Object.freeze([...proofs]);
    return true;
  }

  /**
   * After a live patch, puts up again only the proofs the refresh resolved
   * again, and the menus the patch took down (D185). Every proof used to be
   * taken down and put up again at each patch: on a page of 3,000 menus,
   * every change of one label. A proof that is the same object as the one
   * shown was not touched by the patch, and what was written for it stands.
   * Anything that the engine's own pass reads (a dropdown's shape or state,
   * a disclosure's relation, the popovers' order), or a set with no
   * interactive proof, is presented whole (false). The engine's pass has run
   * with the patch, so it is not run again here.
   */
  #applyTouchedInPlace(proofs: readonly ResolvedSemanticSourceProof[]): boolean {
    if (!this.#firewallCleanup) return false;
    const previous = new Map<string, ResolvedSemanticSourceProof>();
    const previousPopovers: string[] = [];
    for (const resolved of this.#proofs) {
      const proofId = semanticSourceProofIdentityOfResolved(resolved);
      previous.set(proofId, resolved);
      if (resolved.kind === 'popover-open') previousPopovers.push(proofId);
    }
    const next = new Map<string, ResolvedSemanticSourceProof>();
    const nextPopovers: string[] = [];
    let interactive = false;
    const changed: string[] = [];
    for (const resolved of proofs) {
      const proofId = semanticSourceProofIdentityOfResolved(resolved);
      if (next.has(proofId)) return false;
      next.set(proofId, resolved);
      if (resolved.kind === 'popover-open') nextPopovers.push(proofId);
      interactive ||= resolved.kind === 'select-presentation' ||
        resolved.kind === 'disclosure-state' ||
        resolved.kind === 'structural-menu';
      const before = previous.get(proofId);
      if (resolved.kind === 'structural-menu') {
        const installed = this.#menus.get(proofId);
        if (before !== resolved || !installed || installed.isDisposed()) {
          changed.push(proofId);
        }
        continue;
      }
      if (before === resolved && this.#cleanups.has(proofId)) continue;
      if (!PUT_UP_ALONE.has(resolved.kind)) return false;
      changed.push(proofId);
    }
    const gone: string[] = [];
    for (const [proofId, resolved] of previous) {
      if (next.has(proofId)) continue;
      if (resolved.kind !== 'structural-menu' && !PUT_UP_ALONE.has(resolved.kind)) {
        return false;
      }
      gone.push(proofId);
    }
    if (
      !interactive ||
      previousPopovers.join('\u0000') !== nextPopovers.join('\u0000')
    ) return false;
    for (const proofId of [...gone, ...changed]) {
      const installed = this.#menus.get(proofId);
      this.#menus.delete(proofId);
      const cleanup = this.#cleanups.get(proofId);
      this.#cleanups.delete(proofId);
      try {
        installed?.dispose();
        cleanup?.();
      } catch {
        // Continue: the proof is put up again or the set is presented whole.
      }
    }
    const presentedSelects = new Set<number>();
    for (const resolved of proofs) {
      if (resolved.kind === 'select-presentation') presentedSelects.add(resolved.proof.nodeId);
    }
    // What each proof writes, a menu's relation included, then the menus'
    // controllers, as a whole presentation does.
    for (const proofId of changed) {
      const resolved = next.get(proofId)!;
      const cleanup = applyTypedProof(resolved, presentedSelects);
      // Presented whole instead, which takes down what was put up here.
      if (!cleanup) return false;
      this.#cleanups.set(proofId, cleanup);
    }
    for (const proofId of changed) {
      const resolved = next.get(proofId)!;
      if (resolved.kind !== 'structural-menu') continue;
      const installed = installStructuralMenuDisclosure(resolved);
      if (!installed) return false;
      this.#menus.set(proofId, installed);
    }
    this.#presentPopovers(proofs);
    this.#proofs = Object.freeze([...proofs]);
    return true;
  }

  /**
   * Shows the popovers the page shows and hides the others, leaving alone
   * one already shown. In the replica a shown popover is `manual`, so a
   * click there cannot dismiss what the page still shows.
   */
  #presentPopovers(proofs: readonly ResolvedSemanticSourceProof[]): void {
    const wanted = new Set<HTMLElement>();
    for (const resolved of proofs) {
      if (resolved.kind === 'popover-open') wanted.add(resolved.target);
    }
    for (const [element, original] of this.#popovers) {
      if (wanted.has(element)) continue;
      this.#popovers.delete(element);
      toggleReplicaPopover(element, false);
      if (sourceCall(element, 'getAttribute', POPOVER_OPEN_MARKER) !== 'v1') continue;
      if (sourceCall(element, 'getAttribute', 'popover') === 'manual') {
        restoreAttribute(element, 'popover', original.popover);
      }
      restoreAttribute(element, POPOVER_OPEN_MARKER, original.marker);
    }
    for (const element of wanted) {
      const known = this.#popovers.get(element);
      const marked = sourceCall(element, 'getAttribute', POPOVER_OPEN_MARKER) === 'v1';
      if (
        known && marked && sourceCall(element, 'getAttribute', 'popover') === 'manual' &&
        replicaPopoverIsShown(element) !== false
      ) continue;
      // New, or a patch has written the page's attributes over it, which
      // hides a shown popover.
      if (!known) {
        this.#popovers.set(element, {
          popover: sourceCall(element, 'getAttribute', 'popover'),
          marker: sourceCall(element, 'getAttribute', POPOVER_OPEN_MARKER),
        });
      } else if (!marked) {
        known.popover = sourceCall(element, 'getAttribute', 'popover');
      }
      sourceCall(element, 'setAttribute', 'popover', 'manual');
      sourceCall(element, 'setAttribute', POPOVER_OPEN_MARKER, 'v1');
      toggleReplicaPopover(element, true);
    }
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
        this.#cleanups.set(semanticSourceProofIdentityOfResolved(resolved), cleanup);
      }
      for (const resolved of proofs) {
        if (resolved.kind === 'select-presentation') continue;
        const cleanup = applyTypedProof(resolved, presentedSelects);
        if (!cleanup) throw new Error('Typed semantic proof could not apply.');
        this.#cleanups.set(semanticSourceProofIdentityOfResolved(resolved), cleanup);
      }
      this.#presentPopovers(proofs);
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
        const installed = installStructuralMenuDisclosure(resolved);
        if (!installed) throw new Error('Structural menu presentation failed.');
        this.#menus.set(semanticSourceProofIdentityOfResolved(resolved), installed);
      }
      return true;
    } catch {
      return false;
    }
  }

  #teardown(notify = true): void {
    // The menus were put up last: they go first.
    for (const installed of [...this.#menus.values()].reverse()) {
      try {
        installed.dispose();
      } catch {
        // Continue restoring every independent renderer-owned state slot.
      }
    }
    this.#menus.clear();
    disposeReadOnlyReplicaDisclosures(this.options.document, true);
    this.#ancestorCleanup?.();
    this.#ancestorCleanup = undefined;
    this.#firewallCleanup?.();
    this.#firewallCleanup = undefined;
    for (const cleanup of [...this.#cleanups.values()].reverse()) {
      try {
        cleanup();
      } catch {
        // Continue restoring every independent renderer-owned state slot.
      }
    }
    this.#cleanups.clear();
    if (notify) {
      try {
        this.options.afterApply?.();
      } catch {
        // Teardown is already fail-closed when a derived refresh is unavailable.
      }
    }
  }
}

/**
 * What a refresh may put up again by itself (D185): state written on its
 * own element that the engine's pass does not read. A dropdown's shape and
 * state, a disclosure's relation and a popover go through a whole
 * presentation.
 */
const PUT_UP_ALONE = new Set<ResolvedSemanticSourceProof['kind']>([
  'choice-state', 'masked-length', 'control-state', 'aria-state',
  'aria-relationship', 'tab-state',
]);

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
  if (resolved.kind === 'masked-length') {
    // The page draws one dot per character; the replica never has the
    // characters, only their count (D91).
    const target = resolved.target;
    const originalValue = target.value;
    const originalMarker = target.getAttribute('data-simul-source-masked-length');
    const presentedValue = '\u2022'.repeat(resolved.proof.length);
    target.value = presentedValue;
    target.setAttribute('data-simul-source-masked-length', 'v1');
    return () => {
      const stillOwned = target.getAttribute(
        'data-simul-source-masked-length',
      ) === 'v1';
      if (stillOwned && target.value === presentedValue) {
        target.value = originalValue;
      }
      if (stillOwned) {
        restoreAttribute(
          target,
          'data-simul-source-masked-length',
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
    const originalAriaDisabled = sourceCall(target, 'getAttribute', 'aria-disabled');
    const originalMarker = sourceCall(target, 'getAttribute', 'data-simul-source-control-state');
    if (originalDisabled !== undefined) target.disabled = resolved.proof.disabled;
    // `aria-disabled` is written only for a disabled control, or where the
    // page's element has the attribute (D179): `aria-disabled="false"` on
    // every enabled button matched a page rule that names the attribute
    // whatever its value (`button[aria-disabled] { opacity: .4 }`).
    const presentedAriaDisabled = resolved.proof.disabled
      ? 'true'
      : originalAriaDisabled === null ? null : 'false';
    if (presentedAriaDisabled !== null) {
      sourceCall(target, 'setAttribute', 'aria-disabled', presentedAriaDisabled);
    }
    sourceCall(target, 'setAttribute', 'data-simul-source-control-state', 'v1');
    return () => {
      const stillOwned = sourceCall(target, 'getAttribute', 'data-simul-source-control-state') === 'v1';
      if (
        stillOwned &&
        (originalDisabled === undefined || target.disabled === resolved.proof.disabled) &&
        sourceCall(target, 'getAttribute', 'aria-disabled') === presentedAriaDisabled
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
    const attribute = semanticAriaStateAttribute(resolved.proof.state);
    const marker = `data-simul-source-aria-${resolved.proof.state}-state`;
    const original = sourceCall(resolved.target, 'getAttribute', attribute);
    const originalMarker = sourceCall(resolved.target, 'getAttribute', marker);
    sourceCall(resolved.target, 'setAttribute', attribute, resolved.proof.value);
    sourceCall(resolved.target, 'setAttribute', marker, 'v1');
    return () => {
      const stillOwned = sourceCall(resolved.target, 'getAttribute', marker) === 'v1';
      if (
        stillOwned &&
        sourceCall(resolved.target, 'getAttribute', attribute) === resolved.proof.value
      ) restoreAttribute(resolved.target, attribute, original);
      if (stillOwned) restoreAttribute(resolved.target, marker, originalMarker);
    };
  }
  // Shown by the presenter itself, which leaves a shown popover alone.
  if (resolved.kind === 'popover-open') return () => undefined;
  if (resolved.kind === 'aria-relationship') {
    // No represented reference resolved: leave the control untouched.
    if (resolved.references.length === 0) return () => undefined;
    const doc = sourceProperty(resolved.target, 'ownerDocument');
    const attribute = `aria-${resolved.proof.relation}`;
    const marker =
      `data-simul-source-aria-${resolved.proof.relation}-relationship`;
    // Point the control at the already-present replica nodes it named,
    // assigning a replica-owned id only when the node has no usable unique one.
    const assigned: Array<{ element: Element; id: string; added: boolean }> = [];
    const ids: string[] = [];
    for (const ref of resolved.references) {
      const existing = sourceCall(ref, 'getAttribute', 'id');
      if (existing && doc.getElementById(existing) === ref) {
        assigned.push({ element: ref, id: existing, added: false });
        ids.push(existing);
        continue;
      }
      const id = uniqueReplicaAriaReferenceId(doc);
      sourceCall(ref, 'setAttribute', 'id', id);
      sourceCall(ref, 'setAttribute', ARIA_RELATIONSHIP_REF_MARKER, 'v1');
      assigned.push({ element: ref, id, added: true });
      ids.push(id);
    }
    const joined = ids.join(' ');
    const original = sourceCall(resolved.target, 'getAttribute', attribute);
    const originalMarker = sourceCall(resolved.target, 'getAttribute', marker);
    sourceCall(resolved.target, 'setAttribute', attribute, joined);
    sourceCall(resolved.target, 'setAttribute', marker, 'v1');
    return () => {
      const stillOwned = sourceCall(resolved.target, 'getAttribute', marker) === 'v1';
      if (stillOwned && sourceCall(resolved.target, 'getAttribute', attribute) === joined) {
        restoreAttribute(resolved.target, attribute, original);
      }
      if (stillOwned) restoreAttribute(resolved.target, marker, originalMarker);
      for (const entry of assigned) {
        if (
          entry.added &&
          sourceCall(entry.element, 'getAttribute', ARIA_RELATIONSHIP_REF_MARKER) === 'v1' &&
          sourceCall(entry.element, 'getAttribute', 'id') === entry.id
        ) {
          sourceCall(entry.element, 'removeAttribute', 'id');
          sourceCall(entry.element, 'removeAttribute', ARIA_RELATIONSHIP_REF_MARKER);
        }
      }
    };
  }
  if (resolved.kind === 'tab-state') {
    const { trigger, panel, proof } = resolved;
    const controlId = resolved.panelId ?? proof.relationId;
    const originalControls = sourceCall(trigger, 'getAttribute', 'aria-controls');
    const originalSelected = sourceCall(trigger, 'getAttribute', 'aria-selected');
    const originalHasPopup = sourceCall(trigger, 'getAttribute', 'aria-haspopup');
    const originalPanelId = sourceCall(panel, 'getAttribute', 'id');
    const originalPanelHidden = sourceCall(panel, 'getAttribute', 'aria-hidden');
    if (resolved.panelId === undefined) sourceCall(panel, 'setAttribute', 'id', controlId);
    sourceCall(panel, 'setAttribute', 'aria-hidden', proof.selected ? 'false' : 'true');
    sourceCall(trigger, 'setAttribute', 'aria-controls', controlId);
    sourceCall(trigger, 'setAttribute', 'aria-selected', proof.selected ? 'true' : 'false');
    sourceCall(trigger, 'removeAttribute', 'aria-haspopup');
    return () => {
      restoreAttribute(trigger, 'aria-controls', originalControls);
      restoreAttribute(trigger, 'aria-selected', originalSelected);
      restoreAttribute(trigger, 'aria-haspopup', originalHasPopup);
      restoreAttribute(panel, 'id', originalPanelId);
      restoreAttribute(panel, 'aria-hidden', originalPanelHidden);
    };
  }
  const { trigger, panel, proof } = resolved;
  const originalControls = sourceCall(trigger, 'getAttribute', 'aria-controls');
  const originalExpanded = sourceCall(trigger, 'getAttribute', 'aria-expanded');
  const originalHasPopup = sourceCall(trigger, 'getAttribute', 'aria-haspopup');
  const originalPanelId = sourceCall(panel, 'getAttribute', 'id');
  const originalTriggerMarker = sourceCall(trigger, 'getAttribute', 'data-simul-source-disclosure-state');
  const originalPanelMarker = sourceCall(panel, 'getAttribute', 'data-simul-source-disclosure-state');
  const presentedExpanded = proof.expanded ? 'true' : 'false';
  sourceCall(panel, 'setAttribute', 'id', proof.relationId);
  sourceCall(trigger, 'setAttribute', 'aria-controls', proof.relationId);
  sourceCall(trigger, 'setAttribute', 'aria-expanded', presentedExpanded);
  sourceCall(trigger, 'setAttribute', 'aria-haspopup', proof.popupRole);
  sourceCall(trigger, 'setAttribute', 'data-simul-source-disclosure-state', 'v1');
  sourceCall(panel, 'setAttribute', 'data-simul-source-disclosure-state', 'v1');
  return () => {
    const triggerStillOwned = sourceCall(trigger, 'getAttribute', 'data-simul-source-disclosure-state') === 'v1';
    const panelStillOwned = sourceCall(panel, 'getAttribute', 'data-simul-source-disclosure-state') === 'v1';
    if (
      triggerStillOwned &&
      sourceCall(trigger, 'getAttribute', 'aria-controls') === proof.relationId &&
      sourceCall(trigger, 'getAttribute', 'aria-expanded') === presentedExpanded &&
      sourceCall(trigger, 'getAttribute', 'aria-haspopup') === proof.popupRole
    ) {
      restoreAttribute(trigger, 'aria-controls', originalControls);
      restoreAttribute(trigger, 'aria-expanded', originalExpanded);
      restoreAttribute(trigger, 'aria-haspopup', originalHasPopup);
    }
    if (panelStillOwned && sourceCall(panel, 'getAttribute', 'id') === proof.relationId) {
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

interface InstalledStructuralMenu {
  dispose(): void;
  isDisposed(): boolean;
}

function installStructuralMenuDisclosure(
  resolved: Extract<ResolvedSemanticSourceProof, {
    kind: 'structural-menu';
  }>,
): InstalledStructuralMenu | undefined {
  const { panel, trigger, otherTriggers, proof } = resolved;
  if (!sourceProperty(panel, 'parentNode') || !sourceProperty(trigger, 'parentNode')) return undefined;
  const opensOnHover = resolved.opening === 'hover';
  let controller: ReadOnlyReplicaDisclosure;
  try {
    // The page's own panel opens where the page draws it. It opens while the
    // page shows it (a hover on the source), and stays open through a
    // re-install while the reader's pointer is on it. A button menu outside
    // navigation opens on a click only (D132).
    controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      additionalTriggers: otherTriggers,
      panel,
      presentation: 'inline',
      manageTriggerExpanded: true,
      // The engine's pass after a live patch leaves it up unless its nodes
      // are gone (D185): one the patch touches is taken down before it
      // (`takeDownMenusTouching`), and the refresh puts it up again.
      survivesRefresh: true,
      openOnHover: opensOnHover,
      shownByPage: proof.expanded,
      initiallyOpen: opensOnHover && (
        isHovered(trigger) || isHovered(panel) || otherTriggers.some(isHovered)
      ),
    });
  } catch {
    return undefined;
  }
  return {
    dispose: () => controller.dispose(),
    isDisposed: () => controller.isDisposed(),
  };
}

function isHovered(element: Element): boolean {
  try {
    return sourceCall(element, 'matches', ':hover');
  } catch {
    return false;
  }
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
  if (value === null) sourceCall(element, 'removeAttribute', name);
  else sourceCall(element, 'setAttribute', name, value);
}

const POPOVER_OPEN_MARKER = 'data-simul-source-popover-open';

/** Whether a replica popover is in the top layer; undefined if it cannot be told. */
function replicaPopoverIsShown(element: Element): boolean | undefined {
  try {
    return sourceCall(element, 'matches', ':popover-open');
  } catch {
    return undefined;
  }
}

/** Shows or hides a replica popover; one already in that state stays. */
function toggleReplicaPopover(element: HTMLElement, show: boolean): void {
  try {
    const popover = element as HTMLElement & {
      showPopover?: () => void;
      hidePopover?: () => void;
    };
    if (show) popover.showPopover?.();
    else popover.hidePopover?.();
  } catch {
    // Not connected, or already shown or hidden.
  }
}

/** Marks a replica id assigned by an aria-relationship proof so teardown can
 * remove exactly the ids it added and leave source-authored ids untouched. */
const ARIA_RELATIONSHIP_REF_MARKER = 'data-simul-aria-relationship-ref';
let ariaRelationshipReferenceCounter = 0;

/** A replica-owned id that no current replica node already uses. */
function uniqueReplicaAriaReferenceId(doc: Document): string {
  for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
    const candidate =
      `simul-aria-ref-${(ariaRelationshipReferenceCounter++).toString(36)}`;
    if (!doc.getElementById(candidate)) return candidate;
  }
  return `simul-aria-ref-x${Date.now().toString(36)}` +
    Math.random().toString(36).slice(2);
}
