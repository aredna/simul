import {
  MAX_SEMANTIC_SOURCE_BATCH_BYTES,
  MAX_SEMANTIC_SOURCE_NODE_IDENTITIES,
  MAX_SEMANTIC_SOURCE_PROOFS,
  MAX_SEMANTIC_SOURCE_RECORDS,
  MAX_SEMANTIC_SELECT_SIZE,
  MAX_SEMANTIC_SELECTED_OPTION_NODE_IDS,
  createSemanticSourceBatch,
  readSemanticSourceControllerMessage,
  readSemanticSourcePortIdentity,
  semanticDisclosureRelationId,
  semanticStructuralMenuRelationId,
  semanticTabRelationId,
  semanticSourceProofIdentity,
  semanticSourceProofSignature,
  semanticSourceRecordId,
  semanticSourceBatchByteLength,
  type SemanticSourceBatch,
  type SemanticSourceBridgeId,
  type SemanticDisclosurePopupRole,
  type SemanticSourceGate,
  type SemanticSourcePortIdentity,
  type SemanticSourcePresentation,
  type SemanticSourceProof,
  type SemanticSourceRecord,
  isSemanticAriaStateValue,
  semanticAriaStateGate,
  type SemanticAriaState,
} from './semantic-source-protocol';
import {
  SOURCE_SECRET_CLASSIFIER_VERSION,
  StickySourceSecretClassifier,
  replicaReadScopeAdmits,
  sourceDocumentSecretClassifier,
  type SourceClassificationFacts,
  type SourceEvidenceCategory,
} from './source-secret-classifier';
import {
  createSourceControlledContentPolicy,
  hasSourceCredentialSecretAncestor,
  isSourcePrivateContentEditableValue,
  isSourceSelectLabelElementPublic,
  readSourceFlatTreeElementPath,
  readSourceSelectLabel,
  readSourceStructuralAttributes,
  sourceElementPathIsPainted,
  sourceAttributesArePrivate,
  type SourceControlledContentPolicy,
} from './source-privacy-policy';
import type { ReplicaReadScope } from './read-scope-policy';
import type { ReplicaSourceDocumentIdentity } from './source-identity';
import { sourceMutationMayChangeCurrentValue } from './source-mutation-filter';

interface MessageEventPort {
  addListener(listener: (message: unknown) => void): void;
  removeListener(listener: (message: unknown) => void): void;
}

interface DisconnectEventPort {
  addListener(listener: () => void): void;
  removeListener(listener: () => void): void;
}

export interface SemanticSourcePort {
  readonly name: string;
  readonly onMessage: MessageEventPort;
  readonly onDisconnect: DisconnectEventPort;
  postMessage(message: SemanticSourceBatch): void;
  disconnect(): void;
}

export interface SemanticSourceSessionEnvironment {
  readonly port: SemanticSourcePort;
  readonly document: Document;
  readonly window: Window;
  readonly bridge: SemanticSourceBridgeId;
  readonly getNodeId: (node: Node) => number | undefined;
  /** Shared by every reconnect for this bridge's source-document lifetime. */
  readonly secretClassifier?: StickySourceSecretClassifier;
  readonly createMutationObserver?: (
    callback: MutationCallback,
  ) => Pick<MutationObserver, 'observe' | 'disconnect'>;
  readonly schedule?: (callback: () => void) => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
  readonly onDispose?: () => void;
}

interface ElementClassification {
  readonly category: SourceEvidenceCategory;
  readonly facts: SourceClassificationFacts;
}

interface RevisionState {
  readonly signature: string;
  readonly revision: number;
}

interface SemanticSourceScan {
  readonly records: readonly SemanticSourceRecord[];
  readonly proofs: readonly SemanticSourceProof[];
}

interface ValidatedDisclosure {
  readonly trigger: Element;
  readonly panel: Element;
  readonly expanded: boolean;
  readonly popupRole: SemanticDisclosurePopupRole;
}

interface ValidatedStructuralMenu {
  readonly container: Element;
  readonly trigger: Element;
  readonly panel: Element;
  readonly expanded: boolean;
}

interface ValidatedTab {
  readonly trigger: Element;
  readonly panel: Element;
  readonly selected: boolean;
}

interface SelectStateSnapshot {
  readonly classification: ElementClassification;
  readonly optionElements: readonly HTMLOptionElement[];
  readonly optionLabels: readonly string[];
  readonly optionNodeIds: readonly number[];
  readonly multiple: boolean;
  readonly pickerOpen: boolean;
}

type SemanticSourceProofDraft =
  | Omit<Extract<SemanticSourceProof, { kind: 'select-state' }>, 'revision'>
  | Omit<Extract<SemanticSourceProof, { kind: 'select-presentation' }>, 'revision'>
  | Omit<Extract<SemanticSourceProof, { kind: 'tab-state' }>, 'revision'>
  | Omit<Extract<SemanticSourceProof, { kind: 'disclosure-state' }>, 'revision'>
  | Omit<Extract<SemanticSourceProof, { kind: 'structural-menu' }>, 'revision'>
  | Omit<Extract<SemanticSourceProof, { kind: 'choice-state' }>, 'revision'>
  | Omit<Extract<SemanticSourceProof, { kind: 'control-state' }>, 'revision'>
  | Omit<Extract<SemanticSourceProof, { kind: 'aria-state' }>, 'revision'>;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const MAX_SEMANTIC_DISCLOSURE_SUBTREE_NODES = 1_024;
const SEMANTIC_CONTROL_POLL_INTERVAL_MS = 500;
const MAX_SEMANTIC_CONTROL_POLL_CANDIDATES = 1_024;
const SEMANTIC_SELECT_ACTIVATION_EVENTS = Object.freeze([
  'pointerdown',
  'click',
  'keydown',
] as const);
const SEMANTIC_DOM_CHANGE_EVENTS = Object.freeze([
  'beforeinput', 'input', 'change', 'toggle',
] as const);
const SEMANTIC_PRESENTATION_CHANGE_EVENTS = Object.freeze([
  'pointerover', 'pointerout', 'focusin', 'focusout',
] as const);
const SEMANTIC_CONTROL_ROLES = new Set([
  'button', 'checkbox', 'combobox', 'link', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'switch', 'tab', 'treeitem',
]);
const SEMANTIC_CONTROL_TAGS = new Set([
  'a', 'button', 'input', 'option', 'optgroup', 'select', 'summary',
]);
const SEMANTIC_DISABLEABLE_TAGS = new Set([
  'button', 'fieldset', 'input', 'optgroup', 'option', 'select', 'textarea',
]);
const SEMANTIC_ARIA_CHECKED_ROLES = new Set([
  'checkbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'switch',
]);
const SEMANTIC_ARIA_MIXED_ROLES = new Set([
  'checkbox', 'menuitemcheckbox',
]);
const SEMANTIC_ARIA_SELECTED_ROLES = new Set([
  'option', 'treeitem',
]);
const SEMANTIC_ARIA_PRESSED_ROLES = new Set(['button']);
const SEMANTIC_ARIA_CURRENT_TAGS = new Set([
  'a', 'button', 'li', 'option', 'summary',
]);
const SEMANTIC_ARIA_CURRENT_ROLES = new Set([
  'button', 'gridcell', 'link', 'listitem', 'menuitem', 'menuitemradio',
  'option', 'row', 'tab', 'treeitem',
]);
/** Read-only indicators only: slider and spinbutton carry user values. */
const SEMANTIC_ARIA_RANGE_INDICATOR_ROLES = new Set([
  'meter', 'progressbar', 'scrollbar',
]);
const SEMANTIC_ACTIVATION_ROLES = new Set([
  'button', 'combobox', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'tab', 'treeitem',
]);
const SEMANTIC_POPUP_ROLES = new Set([
  'dialog', 'grid', 'listbox', 'menu', 'tree',
]);

/**
 * Reads only policy-admitted source evidence. One full-state batch is allowed
 * in flight; mutations coalesce behind its exact applied acknowledgement.
 */
export class SemanticSourceSession {
  readonly #portIdentity: SemanticSourcePortIdentity;
  readonly #classifier: StickySourceSecretClassifier;
  readonly #revisions = new Map<number, RevisionState>();
  readonly #proofRevisions = new Map<string, RevisionState>();
  readonly #structuralMenus = new WeakMap<Element, {
    readonly trigger: Element;
    readonly panel: Element;
  }>();
  #documentIdentity: ReplicaSourceDocumentIdentity | undefined;
  #scope: ReplicaReadScope | undefined;
  #policyFingerprint: string | undefined;
  #observer: Pick<MutationObserver, 'observe' | 'disconnect'> | undefined;
  readonly #observedSemanticRoots = new WeakSet<Document | ShadowRoot>();
  readonly #semanticEventRoots = new Set<Document | ShadowRoot>();
  #sequence = 0;
  #inFlightSequence: number | undefined;
  #dirty = false;
  #scheduled = false;
  #lastEmittedScanSignature: string | undefined;
  #controlPollTimer: unknown;
  #selectActivationTimer: unknown;
  #controlPollCandidates: Element[] = [];
  #controlPollFingerprints = new WeakMap<Element, string>();
  #controlPollCursor = 0;
  #presentationChangeCandidates = new WeakSet<Element>();
  #disposed = false;

  constructor(private readonly environment: SemanticSourceSessionEnvironment) {
    const identity = readSemanticSourcePortIdentity(
      environment.port.name,
      environment.bridge,
    );
    if (!identity) throw new Error('Invalid semantic source Port.');
    this.#portIdentity = identity;
    this.#classifier = environment.secretClassifier ??
      sourceDocumentSecretClassifier(environment.document);
    environment.port.onMessage.addListener(this.#onMessage);
    environment.port.onDisconnect.addListener(this.#onDisconnect);
  }

  dispose(disconnect = false): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.environment.port.onMessage.removeListener(this.#onMessage);
    this.environment.port.onDisconnect.removeListener(this.#onDisconnect);
    this.#observer?.disconnect();
    this.#observer = undefined;
    this.#cancelControlPoll();
    this.#cancelSelectActivationRefresh();
    this.#controlPollCandidates = [];
    this.#controlPollFingerprints = new WeakMap<Element, string>();
    this.#controlPollCursor = 0;
    this.#presentationChangeCandidates = new WeakSet<Element>();
    for (const root of this.#semanticEventRoots) {
      for (const type of SEMANTIC_DOM_CHANGE_EVENTS) {
        root.removeEventListener(type, this.#onDomChange, true);
      }
      for (const type of SEMANTIC_SELECT_ACTIVATION_EVENTS) {
        root.removeEventListener(type, this.#onSelectActivation, true);
      }
      for (const type of SEMANTIC_PRESENTATION_CHANGE_EVENTS) {
        root.removeEventListener(type, this.#onPresentationChange, true);
      }
    }
    this.#semanticEventRoots.clear();
    this.#documentIdentity = undefined;
    this.#scope = undefined;
    this.#policyFingerprint = undefined;
    this.#revisions.clear();
    this.#proofRevisions.clear();
    this.#lastEmittedScanSignature = undefined;
    try {
      this.environment.onDispose?.();
    } catch {
      // The Port remains disposed even if its owner cleanup fails.
    }
    if (disconnect) {
      try {
        this.environment.port.disconnect();
      } catch {
        // The document may already have destroyed the Port.
      }
    }
  }

  /** Test and bridge hook for state changes outside observable DOM mutation. */
  refresh(): void {
    if (!this.#documentIdentity || this.#disposed) return;
    this.#dirty = true;
    this.#scheduleScan();
  }

  readonly #onMessage = (input: unknown): void => {
    if (this.#disposed) return;
    const message = readSemanticSourceControllerMessage(
      input,
      this.#portIdentity,
      this.#documentIdentity,
      this.#policyFingerprint,
    );
    if (!message) {
      this.dispose(true);
      return;
    }
    if (message.kind === 'simul:semantic-source-v2:start') {
      if (this.#documentIdentity) {
        this.dispose(true);
        return;
      }
      this.#start(
        message.document,
        message.scope,
        message.policyFingerprint,
      );
      return;
    }
    if (
      !this.#documentIdentity ||
      this.#inFlightSequence === undefined ||
      message.sequence !== this.#inFlightSequence
    ) {
      this.dispose(true);
      return;
    }
    this.#inFlightSequence = undefined;
    if (this.#dirty) this.#scheduleScan();
  };

  readonly #onDisconnect = (): void => this.dispose(false);
  readonly #onDomChange = (event: Event): void => {
    rememberSourceEventSecret(
      event,
      this.environment.window,
      this.#classifier,
    );
    this.refresh();
  };
  readonly #onPresentationChange = (event: Event): void => {
    if (
      !this.#scope?.disclosureContent ||
      !this.#presentationEventTouchesCandidate(event)
    ) return;
    this.refresh();
  };
  readonly #onSelectActivation = (event: Event): void => {
    if (!this.#scope?.formValues) return;
    let path: readonly EventTarget[] = [];
    try {
      path = event.composedPath();
    } catch {
      // Use the retargeted event target when a synthetic path is unreadable.
    }
    const retargeted = safelyRead(() => event.target);
    const candidates = path.length > 0
      ? path
      : retargeted ? [retargeted] : [];
    for (const candidate of candidates) {
      if (!isElementNode(candidate)) continue;
      const select = candidate.localName.toLowerCase() === 'select'
        ? candidate
        : safelyRead(() => candidate.closest('select'));
      if (select?.ownerDocument !== this.environment.document) continue;
      this.refresh();
      this.#scheduleSelectActivationRefresh();
      return;
    }
  };

  #start(
    documentIdentity: ReplicaSourceDocumentIdentity,
    scope: ReplicaReadScope,
    policyFingerprint: string,
  ): void {
    this.#documentIdentity = documentIdentity;
    this.#scope = scope;
    this.#policyFingerprint = policyFingerprint;
    try {
      const createObserver = this.environment.createMutationObserver ??
        ((callback: MutationCallback) => new MutationObserver(callback));
      this.#observer = createObserver((records) => {
        rememberSourceMutationSecrets(
          records,
          this.environment.window,
          this.#classifier,
        );
        if (!records.some(sourceMutationMayChangeCurrentValue)) return;
        this.refresh();
      });
      this.#observeSemanticRoot(this.environment.document);
      this.#dirty = true;
      this.#flush();
      this.#scheduleControlPoll();
    } catch {
      this.dispose(true);
    }
  }

  #scheduleScan(): void {
    if (this.#scheduled || this.#inFlightSequence !== undefined || this.#disposed) {
      return;
    }
    this.#scheduled = true;
    const schedule = this.environment.schedule ?? queueMicrotask;
    schedule(() => {
      this.#scheduled = false;
      this.#flush();
    });
  }

  #observeSemanticRoot(root: Document | ShadowRoot): void {
    if (!this.#observer || this.#observedSemanticRoots.has(root)) return;
    this.#observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
      attributes: true,
      attributeOldValue: true,
    });
    this.#observedSemanticRoots.add(root);
    this.#semanticEventRoots.add(root);
    for (const type of SEMANTIC_DOM_CHANGE_EVENTS) {
      root.addEventListener(type, this.#onDomChange, true);
    }
    for (const type of SEMANTIC_SELECT_ACTIVATION_EVENTS) {
      root.addEventListener(type, this.#onSelectActivation, true);
    }
    for (const type of SEMANTIC_PRESENTATION_CHANGE_EVENTS) {
      root.addEventListener(type, this.#onPresentationChange, true);
    }
  }

  #scheduleControlPoll(): void {
    if (
      this.#disposed ||
      this.#controlPollCandidates.length === 0 ||
      this.#controlPollTimer !== undefined
    ) return;
    const setTimer = this.environment.setTimer ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#controlPollTimer = setTimer(() => {
      this.#controlPollTimer = undefined;
      this.#pollSilentControlState();
      this.#scheduleControlPoll();
    }, SEMANTIC_CONTROL_POLL_INTERVAL_MS);
  }

  #cancelControlPoll(): void {
    if (this.#controlPollTimer === undefined) return;
    (this.environment.clearTimer ?? ((timer) => clearTimeout(
      timer as ReturnType<typeof setTimeout>,
    )))(this.#controlPollTimer);
    this.#controlPollTimer = undefined;
  }

  #scheduleSelectActivationRefresh(): void {
    if (this.#disposed || this.#selectActivationTimer !== undefined) return;
    const setTimer = this.environment.setTimer ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.#selectActivationTimer = setTimer(() => {
      this.#selectActivationTimer = undefined;
      // Native picker state can change in the browser's default action, after
      // the activation listener and its immediate scan have already run.
      this.refresh();
    }, 0);
  }

  #cancelSelectActivationRefresh(): void {
    if (this.#selectActivationTimer === undefined) return;
    (this.environment.clearTimer ?? ((timer) => clearTimeout(
      timer as ReturnType<typeof setTimeout>,
    )))(this.#selectActivationTimer);
    this.#selectActivationTimer = undefined;
  }

  #pollSilentControlState(): void {
    if (this.#disposed || !this.#documentIdentity) return;
    const retained = this.#controlPollCandidates.filter((element) =>
      element.isConnected && element.ownerDocument === this.environment.document);
    if (retained.length !== this.#controlPollCandidates.length) {
      this.#controlPollCandidates = retained;
      this.#controlPollCursor = retained.length === 0
        ? 0
        : this.#controlPollCursor % retained.length;
    }
    if (retained.length === 0) return;
    const count = Math.min(
      retained.length,
      MAX_SEMANTIC_CONTROL_POLL_CANDIDATES,
    );
    let changed = false;
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.#controlPollCursor + offset) % retained.length;
      const element = retained[index];
      if (!element) continue;
      const fingerprint = this.#controlPollFingerprint(element);
      if (fingerprint === undefined) continue;
      if (this.#controlPollFingerprints.get(element) !== fingerprint) {
        this.#controlPollFingerprints.set(element, fingerprint);
        changed = true;
      }
    }
    this.#controlPollCursor = (this.#controlPollCursor + count) % retained.length;
    if (changed) this.refresh();
  }

  #replaceControlPollCandidates(
    elements: readonly Element[],
    complete: boolean,
  ): void {
    const scope = this.#scope;
    if (!complete || !scope || (!scope.formValues && !scope.controlSemantics)) {
      this.#cancelControlPoll();
      this.#controlPollCandidates = [];
      this.#controlPollFingerprints = new WeakMap<Element, string>();
      this.#controlPollCursor = 0;
      return;
    }
    const candidates = elements.filter((element) => {
      const tagName = element.localName.toLowerCase();
      return tagName === 'input' || tagName === 'textarea' || tagName === 'select';
    });
    const fingerprints = new WeakMap<Element, string>();
    for (const element of candidates) {
      const fingerprint = this.#controlPollFingerprint(element);
      if (fingerprint !== undefined) fingerprints.set(element, fingerprint);
    }
    this.#controlPollCandidates = candidates;
    this.#controlPollFingerprints = fingerprints;
    this.#controlPollCursor = candidates.length === 0
      ? 0
      : this.#controlPollCursor % candidates.length;
    if (candidates.length === 0) this.#cancelControlPoll();
    else this.#scheduleControlPoll();
  }

  #replacePresentationChangeCandidates(
    elements: readonly Element[],
    complete: boolean,
  ): void {
    const candidates = new WeakSet<Element>();
    if (complete && this.#scope?.disclosureContent) {
      for (const element of elements) {
        if (!isDisclosureActivationController(element)) continue;
        candidates.add(element);
        // Structural hover menus commonly use a trigger and panel beneath one
        // wrapper. Marking only that immediate neighborhood catches the panel
        // transition without turning body-level pointer movement into scans.
        const parent = safelyRead(() => element.parentElement);
        const parentTagName = parent?.localName.toLowerCase();
        if (parent && parentTagName !== 'body' && parentTagName !== 'html') {
          candidates.add(parent);
        }
      }
    }
    this.#presentationChangeCandidates = candidates;
  }

  #presentationEventTouchesCandidate(event: Event): boolean {
    let path: readonly EventTarget[] = [];
    try {
      path = event.composedPath();
    } catch {
      // Fall through to the bounded parent walk below.
    }
    for (const candidate of path) {
      if (isElementNode(candidate) &&
        this.#presentationChangeCandidates.has(candidate)) return true;
    }
    let current = safelyRead(() => event.target) as Node | null | undefined;
    for (let depth = 0; current && depth < 64; depth += 1) {
      if (
        current.nodeType === ELEMENT_NODE &&
        this.#presentationChangeCandidates.has(current as Element)
      ) return true;
      const parent: Node | null | undefined = safelyRead(() => current?.parentNode);
      if (parent) {
        current = parent;
        continue;
      }
      const root: Node | undefined = safelyRead(() => current?.getRootNode());
      current = root?.nodeType === 11 && 'host' in root
        ? (root as ShadowRoot).host
        : null;
    }
    return false;
  }

  #controlPollFingerprint(element: Element): string | undefined {
    const scope = this.#scope;
    if (!scope) return undefined;
    const classification = this.#classifyElement(element, false, false);
    const tagName = classification.facts.tagName;
    const type = normalizedToken(classification.facts.type);
    const parts = [tagName, type, classification.category];
    if (
      classification.category === 'secret' ||
      classification.category === 'withheld'
    ) return parts.join(':');

    if (
      scope.controlSemantics && tagName === 'input' &&
      ['button', 'submit', 'reset'].includes(type) &&
      classification.category === 'public-semantic'
    ) {
      parts.push(`label=${semanticTextFingerprint(safelyRead(
        () => (element as HTMLInputElement).value,
      ))}`);
    }

    if (!scope.formValues) return parts.join(':');
    if (tagName === 'input' && (type === 'checkbox' || type === 'radio')) {
      if (classification.category !== 'public-semantic') return parts.join(':');
      const checked = safelyRead(() => (element as HTMLInputElement).checked);
      const indeterminate = safelyRead(
        () => (element as HTMLInputElement).indeterminate,
      );
      parts.push(`checked=${String(checked)}`, `mixed=${String(indeterminate)}`);
      return parts.join(':');
    }
    if (tagName === 'input' || tagName === 'textarea') {
      if (!replicaReadScopeAdmits(scope, classification.category)) {
        return parts.join(':');
      }
      const valueClassification = this.#classifyElement(element, false, true);
      if (valueClassification.category !== classification.category) {
        return `${parts.join(':')}:reclassified=${valueClassification.category}`;
      }
      parts.push(`value=${semanticTextFingerprint(safelyRead(
        () => (element as HTMLInputElement | HTMLTextAreaElement).value,
      ))}`);
      return parts.join(':');
    }
    if (tagName !== 'select') return parts.join(':');
    const valueClassification = this.#classifyElement(element, false, true);
    if (valueClassification.category !== 'ordinary-form') {
      return `${parts.join(':')}:reclassified=${valueClassification.category}`;
    }
    const select = element as HTMLSelectElement;
    const optionCount = safelyRead(() => select.options.length);
    const selectedIndex = safelyRead(() => select.selectedIndex);
    if (typeof optionCount !== 'number' || typeof selectedIndex !== 'number') {
      return `${parts.join(':')}:unreadable`;
    }
    parts.push(`count=${optionCount}`, `index=${selectedIndex}`);
    parts.push(
      `open=${String(safelyRead(() => element.matches(':open')) === true)}`,
    );
    const selectedOptions = safelyRead(() => [...select.selectedOptions]);
    if (!selectedOptions) return `${parts.join(':')}:selection=unreadable`;
    parts.push(`selected-count=${selectedOptions.length}`);
    const limit = Math.min(
      selectedOptions.length,
      MAX_SEMANTIC_SELECTED_OPTION_NODE_IDS,
    );
    for (let index = 0; index < limit; index += 1) {
      const option = selectedOptions[index];
      const optionNodeId = option && option.ownerDocument === element.ownerDocument &&
          element.contains(option)
        ? this.#nodeId(option)
        : undefined;
      parts.push(`selected=${optionNodeId ?? 'invalid'}`);
    }
    if (selectedOptions.length > limit) parts.push('selection-overflow');
    return parts.join(':');
  }

  #flush(): void {
    const documentIdentity = this.#documentIdentity;
    const policyFingerprint = this.#policyFingerprint;
    if (
      this.#disposed || !this.#dirty || this.#inFlightSequence !== undefined ||
      !documentIdentity || !policyFingerprint
    ) return;
    this.#dirty = false;
    let scan: SemanticSourceScan;
    try {
      scan = this.#scan();
    } catch {
      this.dispose(true);
      return;
    }
    const scanSignature = semanticSourceScanSignature(scan);
    if (scanSignature === this.#lastEmittedScanSignature) return;
    const sequence = this.#sequence + 1;
    let batch: SemanticSourceBatch;
    try {
      batch = createSemanticSourceBatch(
        documentIdentity,
        policyFingerprint,
        sequence,
        scan.records,
        scan.proofs,
      );
      this.environment.port.postMessage(batch);
    } catch {
      this.dispose(false);
      return;
    }
    this.#lastEmittedScanSignature = scanSignature;
    this.#sequence = sequence;
    this.#inFlightSequence = sequence;
  }

  #scan(): SemanticSourceScan {
    const scope = this.#scope;
    const root = this.environment.document.documentElement;
    if (!scope || !root) return Object.freeze({
      records: Object.freeze([]),
      proofs: Object.freeze([]),
    });
    const elements: Element[] = [];
    const classifications = new WeakMap<Element, ElementClassification>();
    const stack: Array<{ node: Node; secretAncestor: boolean }> = [
      { node: root, secretAncestor: false },
    ];
    let visited = 0;
    while (stack.length > 0 && visited < MAX_SEMANTIC_SOURCE_NODE_IDENTITIES) {
      const current = stack.pop();
      if (!current) break;
      visited += 1;
      const node = current.node;
      if (node.nodeType !== ELEMENT_NODE) continue;
      const element = node as Element;
      const classification = this.#classifyElement(
        element,
        current.secretAncestor,
        false,
      );
      classifications.set(element, classification);
      elements.push(element);
      const secret = classification.category === 'secret';
      if (secret) continue;
      const children: Node[] = [...element.childNodes];
      const shadowRoot = safelyReadShadowRoot(element);
      if (shadowRoot) {
        this.#observeSemanticRoot(shadowRoot);
        children.push(...shadowRoot.childNodes);
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index]!, secretAncestor: secret });
      }
    }

    const validatedDisclosures = scope.disclosureContent && stack.length === 0
      ? this.#validatedDisclosures(elements, classifications)
      : Object.freeze([]);
    const validatedStructuralMenus = scope.disclosureContent && stack.length === 0
      ? this.#validatedStructuralMenus(elements, classifications)
      : Object.freeze([]);
    let validatedTabs: readonly ValidatedTab[] = Object.freeze([]);
    if (scope.controlSemantics && stack.length === 0) {
      const controlledContent = createSourceControlledContentPolicy(
        this.environment.document,
        this.environment.window,
        MAX_SEMANTIC_SOURCE_NODE_IDENTITIES,
      );
      if (!controlledContent.overflow) {
        validatedTabs = this.#validatedTabs(controlledContent, classifications);
      }
    }
    const proofs: SemanticSourceProof[] = [];
    const proofIds = new Set<string>();
    let batchBytes = 0;
    const selectStates = new WeakMap<Element, SelectStateSnapshot>();
    const disclosurePanels = new Set<Element>();
    const admittedDisclosureTextNodes = new Set<Node>();
    const structuralMenuPanels = new WeakMap<Element, string>();
    const addProof = (draft: SemanticSourceProofDraft): boolean => {
      if (proofs.length >= MAX_SEMANTIC_SOURCE_PROOFS) return false;
      const provisional = Object.freeze({ ...draft, revision: 1 }) as
        SemanticSourceProof;
      const proofId = semanticSourceProofIdentity(provisional);
      if (proofIds.has(proofId)) return false;
      const signature = semanticSourceProofSignature(provisional);
      const previous = this.#proofRevisions.get(proofId);
      const revision = previous?.signature === signature
        ? previous.revision
        : this.#sequence + 1;
      const proof = Object.freeze({ ...draft, revision }) as SemanticSourceProof;
      const proofBytes = semanticSourceBatchByteLength([], [proof]);
      if (batchBytes + proofBytes > MAX_SEMANTIC_SOURCE_BATCH_BYTES) return false;
      this.#proofRevisions.set(proofId, { signature, revision });
      proofIds.add(proofId);
      batchBytes += proofBytes;
      proofs.push(proof);
      return true;
    };

    if (scope.controlSemantics && stack.length === 0) {
      for (const element of elements) {
        const classification = classifications.get(element);
        if (classification?.facts.tagName !== 'select' ||
          classification.category === 'secret' ||
          classification.category === 'withheld') continue;
        const currentClassification = this.#classifyElement(element, false, false);
        if (currentClassification.category === 'secret' ||
          currentClassification.category === 'withheld') continue;
        const multiple = safelyRead(() => (element as HTMLSelectElement).multiple);
        const rawSize = safelyRead(() => element.getAttribute('size'));
        const selectNodeId = this.#nodeId(element);
        if (typeof multiple !== 'boolean' || rawSize === undefined ||
          !selectNodeId) continue;
        const size = canonicalAuthoredSelectSize(rawSize);
        addProof({
          kind: 'select-presentation',
          bridge: this.environment.bridge,
          nodeId: selectNodeId,
          gate: 'controlSemantics',
          multiple,
          size,
          classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
        });
      }
    }

    if (scope.formValues && stack.length === 0) {
      for (const element of elements) {
        const classification = classifications.get(element);
        if (classification?.facts.tagName !== 'select' ||
          classification.category === 'secret' ||
          classification.category === 'withheld') continue;
        const stateClassification = this.#classifyElement(element, false, true);
        if (stateClassification.category !== 'ordinary-form') continue;
        const state = this.#readSelectState(
          element,
          classifications,
          stateClassification,
        );
        const selectNodeId = this.#nodeId(element);
        if (!state || !selectNodeId || !addProof({
          kind: 'select-state',
          bridge: this.environment.bridge,
          nodeId: selectNodeId,
          gate: 'formValues',
          selectedOptionNodeIds: state.optionNodeIds,
          multiple: state.multiple,
          pickerOpen: state.pickerOpen,
          classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
        })) continue;
        selectStates.set(element, state);
      }
    }

    if (scope.formValues && stack.length === 0) {
      for (const element of elements) {
        const classification = classifications.get(element);
        const type = normalizedToken(classification?.facts.type);
        if (classification?.facts.tagName !== 'input' ||
          (type !== 'checkbox' && type !== 'radio') ||
          classification.category !== 'public-semantic') continue;
        const currentClassification = this.#classifyElement(element, false, false);
        if (currentClassification.category !== 'public-semantic') continue;
        const input = element as HTMLInputElement;
        const checked = safelyRead(() => input.checked);
        const indeterminate = safelyRead(() => input.indeterminate);
        const choiceNodeId = this.#nodeId(element);
        if (typeof checked !== 'boolean' || typeof indeterminate !== 'boolean' ||
          !choiceNodeId) continue;
        addProof({
          kind: 'choice-state',
          bridge: this.environment.bridge,
          nodeId: choiceNodeId,
          gate: 'formValues',
          checked,
          indeterminate: type === 'checkbox' && indeterminate,
          classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
        });
      }
    }

    if ((scope.formValues || scope.controlSemantics) && stack.length === 0) {
      for (const element of elements) {
        const classification = classifications.get(element);
        if (classification?.category !== 'public-semantic') continue;
        const role = normalizedToken(classification.facts.role);
        const states = semanticAriaStatesFor(classification.facts.tagName, role);
        if (states.length === 0) continue;
        let currentClassification: ElementClassification | undefined;
        for (const state of states) {
          const gate = semanticAriaStateGate(state);
          if (!scope[gate]) continue;
          const value = readSemanticAriaStateValue(element, state, role);
          if (value === undefined) continue;
          currentClassification ??= this.#classifyElement(element, false, false);
          if (currentClassification.category !== 'public-semantic') break;
          const ariaNodeId = this.#nodeId(element);
          if (!ariaNodeId) break;
          addProof({
            kind: 'aria-state',
            bridge: this.environment.bridge,
            nodeId: ariaNodeId,
            gate,
            state,
            value,
            classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
          });
        }
      }
    }

    if (scope.controlSemantics && stack.length === 0) {
      for (const element of elements) {
        const classification = classifications.get(element);
        if (!classification ||
          classification.category === 'secret' ||
          classification.category === 'withheld') continue;
        const tagName = classification.facts.tagName;
        const role = normalizedToken(classification.facts.role);
        const nativeDisableable = SEMANTIC_DISABLEABLE_TAGS.has(tagName);
        const ariaDisableable = SEMANTIC_CONTROL_TAGS.has(tagName) ||
          SEMANTIC_CONTROL_ROLES.has(role);
        if (!nativeDisableable && !ariaDisableable) continue;
        const currentClassification = this.#classifyElement(element, false, false);
        if (currentClassification.category === 'secret' ||
          currentClassification.category === 'withheld') continue;
        const disabled = nativeDisableable
          ? safelyRead(
              () => (element as HTMLButtonElement | HTMLFieldSetElement |
                HTMLInputElement | HTMLOptGroupElement | HTMLOptionElement |
                HTMLSelectElement | HTMLTextAreaElement).disabled,
            )
          : false;
        const ariaDisabled = normalizedToken(
          safelyReadAttribute(element, 'aria-disabled'),
        ) === 'true';
        const controlNodeId = this.#nodeId(element);
        if (!controlNodeId) continue;
        addProof({
          kind: 'control-state',
          bridge: this.environment.bridge,
          nodeId: controlNodeId,
          gate: 'controlSemantics',
          disabled: ariaDisabled || (typeof disabled === 'boolean'
            ? disabled
            : safelyRead(() => element.hasAttribute('disabled')) === true) ||
            safelyRead(() => element.matches(':disabled')) === true,
          classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
        });
      }
    }

    for (const tab of validatedTabs) {
      const tabNodeId = this.#nodeId(tab.trigger);
      const panelNodeId = this.#nodeId(tab.panel);
      if (!tabNodeId || !panelNodeId) continue;
      const relationId = semanticTabRelationId(tabNodeId, panelNodeId);
      if (scope.controlSemantics && relationId) {
        addProof({
          kind: 'tab-state',
          bridge: this.environment.bridge,
          relationId,
          gate: 'controlSemantics',
          tabNodeId,
          panelNodeId,
          selected: tab.selected,
          classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
        });
      }
    }

    for (const disclosure of validatedDisclosures) {
      const triggerNodeId = this.#nodeId(disclosure.trigger);
      const panelNodeId = this.#nodeId(disclosure.panel);
      if (!triggerNodeId || !panelNodeId) continue;
      const relationId = semanticDisclosureRelationId(triggerNodeId, panelNodeId);
      if (!relationId || !addProof({
        kind: 'disclosure-state',
        bridge: this.environment.bridge,
        relationId,
        gate: 'disclosureContent',
        triggerNodeId,
        panelNodeId,
        popupRole: disclosure.popupRole,
        expanded: disclosure.expanded,
        classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
      })) continue;
      disclosurePanels.add(disclosure.panel);
    }

    for (const menu of validatedStructuralMenus) {
      const containerNodeId = this.#nodeId(menu.container);
      const triggerNodeId = this.#nodeId(menu.trigger);
      const panelNodeId = this.#nodeId(menu.panel);
      if (!containerNodeId || !triggerNodeId || !panelNodeId) continue;
      const relationId = semanticStructuralMenuRelationId(
        containerNodeId,
        triggerNodeId,
        panelNodeId,
      );
      if (!relationId || !addProof({
        kind: 'structural-menu',
        bridge: this.environment.bridge,
        relationId,
        gate: 'disclosureContent',
        containerNodeId,
        triggerNodeId,
        panelNodeId,
        popupRole: 'menu',
        expanded: menu.expanded,
        classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
      })) continue;
      disclosurePanels.add(menu.panel);
      structuralMenuPanels.set(menu.panel, relationId);
    }

    const records: SemanticSourceRecord[] = [];
    const recordIds = new Set<number>();
    const add = (
      node: Node,
      classification: ElementClassification,
      gate: SemanticSourceGate,
      presentation: SemanticSourcePresentation,
      text: string | undefined,
    ): void => {
      if (!text || records.length >= MAX_SEMANTIC_SOURCE_RECORDS) return;
      if (!scope[gate] || !semanticGateAdmits(
        scope,
        gate,
        classification.category,
        presentation,
      )) return;
      const nodeId = this.#nodeId(node);
      if (!nodeId) return;
      const recordId = semanticSourceRecordId(nodeId, presentation);
      if (!recordId || recordIds.has(recordId)) return;
      const signature = [
        classification.category, gate, presentation, text,
        classification.facts.tagName, classification.facts.type ?? '',
        classification.facts.autocomplete ?? '', classification.facts.role ?? '',
        classification.facts.contentEditable ?? '',
      ].join('\u0000');
      const previous = this.#revisions.get(recordId);
      const nodeRevision = previous?.signature === signature
        ? previous.revision
        : this.#sequence + 1;
      const record: SemanticSourceRecord = Object.freeze({
        bridge: this.environment.bridge,
        recordId,
        nodeId,
        nodeRevision,
        category: classification.category as SemanticSourceRecord['category'],
        gate,
        tagName: classification.facts.tagName,
        type: classification.facts.type ?? '',
        autocomplete: classification.facts.autocomplete ?? '',
        role: classification.facts.role ?? '',
        contentEditable: classification.facts.contentEditable ?? '',
        text,
        presentation,
        classifierVersion: SOURCE_SECRET_CLASSIFIER_VERSION,
      });
      const recordBytes = semanticSourceBatchByteLength([record]);
      if (batchBytes + recordBytes > MAX_SEMANTIC_SOURCE_BATCH_BYTES) return;
      this.#revisions.set(recordId, { signature, revision: nodeRevision });
      recordIds.add(recordId);
      batchBytes += recordBytes;
      records.push(record);
      if (gate === 'disclosureContent' && presentation === 'text') {
        admittedDisclosureTextNodes.add(node);
      }
    };

    for (const element of elements) {
      if (records.length >= MAX_SEMANTIC_SOURCE_RECORDS) break;
      const classification = classifications.get(element);
      if (!classification || classification.category === 'secret' ||
        classification.category === 'withheld') continue;
      const tagName = classification.facts.tagName;
      const role = normalizedToken(classification.facts.role);

      if (
        scope.controlSemantics &&
        (
          classification.category === 'public-semantic' ||
          classification.category === 'ordinary-form' ||
          classification.category === 'personal'
        ) &&
        tagName !== 'img' &&
        (SEMANTIC_CONTROL_TAGS.has(tagName) || SEMANTIC_CONTROL_ROLES.has(role))
      ) {
        add(
          element,
          classification,
          'controlSemantics',
          'label',
          readDirectControlLabel(element, tagName),
        );
      }

      if (
        (classification.category === 'ordinary-form' ||
          classification.category === 'personal') &&
        replicaReadScopeAdmits(scope, classification.category)
      ) {
        const valueClassification = this.#classifyElement(element, false, true);
        if (valueClassification.category !== classification.category) continue;
        if (tagName === 'input' || tagName === 'textarea') {
          add(
            element,
            valueClassification,
            classification.category === 'personal'
              ? 'personalDataValues'
              : 'formValues',
            'value',
            readControlValue(element),
          );
          if (classification.category === 'ordinary-form') {
            add(
              element,
              valueClassification,
              'formValues',
              'placeholder',
              readControlPlaceholder(element),
            );
          }
        }
      }

      if (tagName === 'select' && scope.formValues) {
        const state = selectStates.get(element);
        if (state) {
          add(
            element,
            state.classification,
            'formValues',
            'selection',
            this.#readSelectedLabels(state.optionElements, state.optionLabels),
          );
        }
      }
    }

    const textStack: Array<{
      node: Node;
      editable: ElementClassification | undefined;
      disclosure: boolean;
      secret: boolean;
    }> = [{
      node: root,
      editable: undefined,
      disclosure: false,
      secret: false,
    }];
    while (textStack.length > 0 && records.length < MAX_SEMANTIC_SOURCE_RECORDS) {
      const current = textStack.pop();
      if (!current) break;
      if (current.node.nodeType === TEXT_NODE) {
        // A light-DOM Text node may render through a default slot beneath a
        // secret shadow ancestor. Classify that flat-tree path before any
        // content accessor is evaluated, and keep the node decision sticky.
        if (
          current.secret ||
          hasSourceCredentialSecretAncestor(
            current.node,
            this.#classifier,
            this.environment.window,
          )
        ) continue;
        const parent = current.node.parentElement;
        const classification = parent && classifications.get(parent);
        if (!classification) continue;
        if (current.editable && scope.editableContent) {
          add(
            current.node,
            current.editable,
            'editableContent',
            'text',
            readTextNode(current.node),
          );
        } else if (current.disclosure && scope.disclosureContent &&
          classification.category === 'public-semantic') {
          add(
            current.node,
            classification,
            'disclosureContent',
            'text',
            readTextNode(current.node),
          );
        }
        continue;
      }
      if (current.node.nodeType !== ELEMENT_NODE) continue;
      const element = current.node as Element;
      const classification = classifications.get(element);
      if (!classification) continue;
      const secret = current.secret || classification.category === 'secret';
      if (secret) continue;
      const editable = current.editable ??
        (classification.category === 'editable' ? classification : undefined);
      const disclosure = current.disclosure || disclosurePanels.has(element);
      const children: Node[] = [...element.childNodes];
      const shadowRoot = safelyReadShadowRoot(element);
      if (shadowRoot) children.push(...shadowRoot.childNodes);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        textStack.push({
          node: children[index]!,
          editable,
          disclosure,
          secret,
        });
      }
    }
    const structuralMenuRelationsWithText = new Set<string>();
    for (const node of admittedDisclosureTextNodes) {
      const path = readSourceFlatTreeElementPath(node);
      if (!path) continue;
      for (const element of path) {
        const relationId = structuralMenuPanels.get(element);
        if (relationId) structuralMenuRelationsWithText.add(relationId);
      }
    }
    const emittedProofs = proofs.filter((proof) =>
      proof.kind !== 'structural-menu' ||
      structuralMenuRelationsWithText.has(proof.relationId));
    this.#retainCurrentRevisionHistory(
      recordIds,
      new Set(emittedProofs.map(semanticSourceProofIdentity)),
    );
    this.#replaceControlPollCandidates(elements, stack.length === 0);
    this.#replacePresentationChangeCandidates(elements, stack.length === 0);
    return Object.freeze({
      records: Object.freeze(records),
      proofs: Object.freeze(emittedProofs),
    });
  }

  #retainCurrentRevisionHistory(
    recordIds: ReadonlySet<number>,
    proofIds: ReadonlySet<string>,
  ): void {
    for (const recordId of this.#revisions.keys()) {
      if (!recordIds.has(recordId)) this.#revisions.delete(recordId);
    }
    for (const proofId of this.#proofRevisions.keys()) {
      if (!proofIds.has(proofId)) this.#proofRevisions.delete(proofId);
    }
  }

  #validatedDisclosures(
    elements: readonly Element[],
    classifications: WeakMap<Element, ElementClassification>,
  ): readonly ValidatedDisclosure[] {
    const disclosures: ValidatedDisclosure[] = [];
    for (const trigger of elements) {
      const classification = classifications.get(trigger);
      if (classification?.category !== 'public-semantic') continue;
      let expanded: string | null;
      let controlled: string | null;
      try {
        expanded = trigger.getAttribute('aria-expanded');
        controlled = trigger.getAttribute('aria-controls');
      } catch {
        continue;
      }
      const expandedState = normalizedToken(expanded);
      if ((expandedState !== 'true' && expandedState !== 'false') || !controlled) {
        continue;
      }
      if (normalizedToken(classification.facts.role) === 'tab') continue;
      const ids = controlled.trim().split(/\s+/u).filter(isSafeDomId);
      if (
        ids.length !== 1 ||
        !isDisclosureActivationController(trigger) ||
        !this.#isVisibleDisclosureController(trigger) ||
        !hasValidPopupSemantics(trigger)
      ) continue;
      const root = trigger.getRootNode();
      const panel = findUniqueElementById(elements, root, ids[0]!);
      if (
        !panel || panel === trigger || panel.ownerDocument !== trigger.ownerDocument ||
        panel.getRootNode() !== root || panel.contains(trigger) ||
        trigger.contains(panel)
      ) continue;
      const panelClassification = classifications.get(panel);
      if (
        panelClassification?.category !== 'public-semantic' ||
        normalizedToken(panelClassification.facts.role) === 'tabpanel' ||
        !popupTargetSemanticsMatch(trigger, panel) ||
        !isBoundedSafeDisclosurePanel(panel, classifications) ||
        (expandedState === 'true'
          ? !this.#isVisibleDisclosureController(panel)
          : !this.#isCollapsedDisclosurePanel(panel))
      ) continue;
      disclosures.push(Object.freeze({
        trigger,
        panel,
        expanded: expandedState === 'true',
        popupRole: disclosurePopupRole(trigger, panel),
      }));
    }
    return Object.freeze(disclosures);
  }

  #validatedStructuralMenus(
    elements: readonly Element[],
    classifications: WeakMap<Element, ElementClassification>,
  ): readonly ValidatedStructuralMenu[] {
    const menus: ValidatedStructuralMenu[] = [];
    for (const container of elements) {
      const retained = this.#structuralMenus.get(container);
      if (
        classifications.get(container)?.category !== 'public-semantic' ||
        !hasNavigationContext(container) ||
        !this.#isPaintedStructuralMenuController(container)
      ) {
        this.#structuralMenus.delete(container);
        continue;
      }
      const children = safelyRead(() => [...container.children]);
      if (!children || children.length !== 2) {
        this.#structuralMenus.delete(container);
        continue;
      }
      const triggers = children.filter((element) =>
        classifications.get(element)?.category === 'public-semantic' &&
        isDisclosureActivationController(element) &&
        this.#isPaintedStructuralMenuController(element));
      if (triggers.length !== 1) {
        this.#structuralMenus.delete(container);
        continue;
      }
      const trigger = triggers[0]!;
      if (
        safelyRead(() => trigger.hasAttribute('aria-expanded')) !== false ||
        safelyRead(() => trigger.hasAttribute('aria-controls')) !== false
      ) {
        this.#structuralMenus.delete(container);
        continue;
      }
      const panel = children.find((element) => element !== trigger);
      const collapsed = panel
        ? this.#isCollapsedStructuralMenuPanel(panel)
        : false;
      const visible = panel
        ? this.#isVisibleDisclosureController(panel)
        : false;
      const retainedRelationship = retained?.trigger === trigger &&
        retained.panel === panel;
      if (
        !panel || panel.ownerDocument !== container.ownerDocument ||
        panel.getRootNode() !== container.getRootNode() ||
        classifications.get(panel)?.category !== 'public-semantic' ||
        (!collapsed && (!retainedRelationship || !visible)) ||
        !isBoundedSafeDisclosurePanel(trigger, classifications, true) ||
        !isBoundedSafeDisclosurePanel(panel, classifications, true) ||
        normalizeSemanticText(safelyRead(() => panel.textContent)) === undefined
      ) {
        this.#structuralMenus.delete(container);
        continue;
      }
      this.#structuralMenus.set(container, { trigger, panel });
      menus.push(Object.freeze({
        container,
        trigger,
        panel,
        // The replica owns structural-menu presentation. Source visibility is
        // retained only to keep the relationship valid through a real hover;
        // it never opens or drives the actionless replica control.
        expanded: false,
      }));
    }
    return Object.freeze(menus);
  }

  #validatedTabs(
    controlledContent: SourceControlledContentPolicy,
    classifications: WeakMap<Element, ElementClassification>,
  ): readonly ValidatedTab[] {
    const tabs: ValidatedTab[] = [];
    for (const relationship of controlledContent.tabs) {
      const triggerClassification = classifications.get(relationship.trigger);
      const panelClassification = classifications.get(relationship.panel);
      if (
        triggerClassification?.category !== 'public-semantic' ||
        panelClassification?.category !== 'public-semantic' ||
        !isBoundedSafeTabPanel(relationship.panel, classifications)
      ) continue;
      tabs.push(Object.freeze({
        trigger: relationship.trigger,
        panel: relationship.panel,
        selected: relationship.selected,
      }));
    }
    return Object.freeze(tabs);
  }

  #isVisibleDisclosureController(trigger: Element): boolean {
    if (isExplicitlyHidden(trigger)) return false;
    try {
      const style = this.environment.window.getComputedStyle(trigger);
      return normalizedToken(style.display) !== 'none' &&
        normalizedToken(style.visibility) !== 'hidden' &&
        normalizedToken(style.visibility) !== 'collapse';
    } catch {
      return false;
    }
  }

  #isPaintedStructuralMenuController(element: Element): boolean {
    return sourceElementPathIsPainted(element, this.environment.window);
  }

  #isCollapsedDisclosurePanel(panel: Element): boolean {
    const authoredCollapsed = isExplicitlyHidden(panel) ||
      safelyRead(() => panel.hasAttribute('popover') &&
        !panel.matches(':popover-open')) === true;
    if (!authoredCollapsed) return false;
    try {
      const style = this.environment.window.getComputedStyle(panel);
      return normalizedToken(style.display) === 'none' ||
        normalizedToken(style.visibility) === 'hidden' ||
        normalizedToken(style.visibility) === 'collapse';
    } catch {
      return false;
    }
  }

  #isCollapsedStructuralMenuPanel(panel: Element): boolean {
    try {
      const path = readSourceFlatTreeElementPath(panel);
      const parent = path?.[1];
      if (!parent || !sourceElementPathIsPainted(parent, this.environment.window)) {
        return false;
      }
      const style = this.environment.window.getComputedStyle(panel);
      const contentVisibility = normalizedToken(
        style.getPropertyValue('content-visibility'),
      );
      const opacity = normalizedToken(style.opacity);
      const numericOpacity = opacity === '' ? undefined : Number(opacity);
      return normalizedToken(style.display) === 'none' ||
        normalizedToken(style.visibility) === 'hidden' ||
        normalizedToken(style.visibility) === 'collapse' ||
        contentVisibility === 'hidden' ||
        (numericOpacity !== undefined && Number.isFinite(numericOpacity) &&
          numericOpacity <= 0);
    } catch {
      return false;
    }
  }

  #readSelectState(
    element: Element,
    classifications: WeakMap<Element, ElementClassification>,
    classification: ElementClassification,
  ): SelectStateSnapshot | undefined {
    if (element.localName.toLowerCase() !== 'select') return undefined;
    let optionElements: readonly HTMLOptionElement[];
    try {
      optionElements = [...(element as HTMLSelectElement).selectedOptions];
    } catch {
      return undefined;
    }
    if (optionElements.length > MAX_SEMANTIC_SELECTED_OPTION_NODE_IDS) {
      return undefined;
    }
    const optionNodeIds: number[] = [];
    const optionLabels: string[] = [];
    const seen = new Set<number>();
    for (const option of optionElements) {
      if (option.localName.toLowerCase() !== 'option' ||
        option.ownerDocument !== element.ownerDocument ||
        !element.contains(option) ||
        classifications.get(option)?.category !== 'public-semantic' ||
        !isSourceSelectLabelElementPublic(option)) {
        return undefined;
      }
      const label = readSourceSelectLabel(option);
      const optionNodeId = this.#nodeId(option);
      if (!optionNodeId || seen.has(optionNodeId)) return undefined;
      seen.add(optionNodeId);
      optionNodeIds.push(optionNodeId);
      optionLabels.push(label?.text ?? '');
    }
    const multiple = safelyRead(() => (element as HTMLSelectElement).multiple);
    if (typeof multiple !== 'boolean') return undefined;
    return Object.freeze({
      classification,
      optionElements: Object.freeze([...optionElements]),
      optionLabels: Object.freeze(optionLabels),
      optionNodeIds: Object.freeze(optionNodeIds),
      multiple,
      pickerOpen: safelyRead(() => element.matches(':open')) === true,
    });
  }

  #readSelectedLabels(
    selected: readonly HTMLOptionElement[],
    labels: readonly string[],
  ): string | undefined {
    if (selected.length !== labels.length) return undefined;
    return normalizeSemanticText(labels.filter(Boolean).join(', '));
  }

  #classifyElement(
    element: Element,
    secretAncestor: boolean,
    valueBearing: boolean,
  ): ElementClassification {
    const flatTreeSecret = hasSourceCredentialSecretAncestor(
      element,
      this.#classifier,
      this.environment.window,
    );
    const facts = sourceClassificationFacts(
      element,
      this.environment.window,
      secretAncestor || flatTreeSecret,
      valueBearing,
    );
    return Object.freeze({
      category: this.#classifier.classify(element, facts),
      facts,
    });
  }

  #nodeId(node: Node): number | undefined {
    try {
      const nodeId = this.environment.getNodeId(node);
      return Number.isSafeInteger(nodeId) && Number(nodeId) > 0
        ? nodeId
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Primes the document-lifetime credential ledger without touching text,
 * values, labels, alt text, or any other content-bearing field.
 */
export function eagerlyClassifySourceDocumentSecrets(
  sourceDocument: Document,
  sourceWindow: Window,
  classifier: StickySourceSecretClassifier = sourceDocumentSecretClassifier(
    sourceDocument,
  ),
): void {
  const root = sourceDocument.documentElement;
  if (!root) return;
  const stack: Array<{ readonly node: Node; readonly secretAncestor: boolean }> = [
    { node: root, secretAncestor: false },
  ];
  let visited = 0;
  try {
    while (stack.length > 0 && visited < MAX_SEMANTIC_SOURCE_NODE_IDENTITIES) {
      const current = stack.pop();
      if (!current) break;
      visited += 1;
      // Do not short-circuit on inherited secrecy: every visited identity
      // must become sticky before a later move can detach it from the secret
      // ancestor. Flat-tree ancestry and conservative DOM traversal context
      // are both retained.
      const flatTreeSecret = hasSourceCredentialSecretAncestor(
        current.node,
        classifier,
        sourceWindow,
      );
      if (current.secretAncestor && !flatTreeSecret) {
        rememberSourceNodeSecret(current.node, classifier);
      }
      const secret = current.secretAncestor || flatTreeSecret;
      const children = [...current.node.childNodes];
      if (current.node.nodeType === ELEMENT_NODE) {
        const shadowRoot = safelyReadShadowRoot(current.node as Element);
        if (shadowRoot) children.push(...[...shadowRoot.childNodes]);
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index]!, secretAncestor: secret });
      }
    }
  } catch {
    rememberSourceNodeSecret(root, classifier);
    return;
  }
  if (stack.length > 0) rememberSourceNodeSecret(root, classifier);
}

/**
 * MutationObserver supplies old structural facts for same-task transitions.
 * Remember those credential states before any later semantic/base scan can
 * inspect the node in its apparently ordinary state.
 */
export function rememberSourceMutationSecrets(
  records: readonly MutationRecord[],
  sourceWindow: Window,
  classifier: StickySourceSecretClassifier,
): void {
  const addedRoots: Node[] = [];
  const styleMutationCounts = new WeakMap<Element, Map<string, number>>();
  const transientStyleBoundaries = new WeakSet<Element>();
  for (const record of records) {
    if (record.type === 'childList') addedRoots.push(...record.addedNodes);
    if (record.type !== 'attributes' || !isElementNode(record.target)) continue;
    const name = record.attributeName?.toLowerCase();
    if (name !== 'class' && name !== 'style') continue;
    let counts = styleMutationCounts.get(record.target);
    if (!counts) {
      counts = new Map<string, number>();
      styleMutationCounts.set(record.target, counts);
    }
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (count >= 2) transientStyleBoundaries.add(record.target);
  }
  const addedRootIdentities = new Set<Node>(addedRoots);
  for (const record of records) {
    if (record.type !== 'attributes' || !isElementNode(record.target)) {
      continue;
    }
    const element = record.target;
    const name = record.attributeName?.toLowerCase();
    if (!name) continue;
    const facts = sourceClassificationFacts(element, sourceWindow, false, false);
    const oldValue = record.oldValue ?? '';
    const addedSubtreeStyleTransition =
      (name === 'class' || name === 'style') &&
      oldValue.trim() !== '' &&
      sourceNodeIsWithinAddedSubtree(element, addedRootIdentities);
    const oldFacts: SourceClassificationFacts = {
      ...facts,
      ...(name === 'type' ? { type: oldValue } : {}),
      ...(name === 'autocomplete' ? { autocomplete: oldValue } : {}),
      ...(name === 'role' ? { role: oldValue } : {}),
      ...(name === 'contenteditable' ? { contentEditable: oldValue } : {}),
      ...(
        (name === 'style' && oldStyleUsedTextSecurity(oldValue)) ||
        (
          (name === 'class' || name === 'style') &&
          (
            transientStyleBoundaries.has(element) ||
            addedSubtreeStyleTransition
          ) &&
          sourceMutationBoundaryMayHoldValue(element, records)
        )
        ? { computedTextSecurity: 'disc' }
        : {}),
      // MutationObserver cannot recover an intermediate CSSOM/class match.
      // When a class changes in the same batch as descendant content, retain
      // the conservative credential decision for an existing node too.
      ...(name === 'class' && sourceMutationBatchChangesValueBearingContentWithin(
        element,
        records,
      )
        ? { computedTextSecurity: 'disc' }
        : {}),
    };
    classifier.classify(element, oldFacts);
  }
  const removalBudget = { visited: 0 };
  for (const record of records) {
    if (
      record.type !== 'childList' ||
      !record.removedNodes ||
      record.removedNodes.length === 0
    ) {
      continue;
    }
    if (!hasSourceCredentialSecretAncestor(
      record.target,
      classifier,
      sourceWindow,
    )) continue;
    for (const removed of record.removedNodes) {
      if (!rememberRemovedSourceSubtreeSecret(
        removed,
        classifier,
        removalBudget,
      )) {
        const documentRoot = sourceDocumentElementForNode(record.target);
        if (documentRoot) rememberSourceNodeSecret(documentRoot, classifier);
        break;
      }
    }
  }
  for (const root of addedRoots) {
    if (root.nodeType !== ELEMENT_NODE) continue;
    const element = root as Element;
    eagerlyClassifySourceDocumentSubtree(element, sourceWindow, classifier);
  }
}

function rememberRemovedSourceSubtreeSecret(
  root: Node,
  classifier: StickySourceSecretClassifier,
  budget: { visited: number },
): boolean {
  const stack: Node[] = [root];
  const seen = new Set<Node>();
  try {
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      if (
        seen.has(current) ||
        budget.visited >= MAX_SEMANTIC_SOURCE_NODE_IDENTITIES
      ) {
        rememberSourceNodeSecret(root, classifier);
        return false;
      }
      seen.add(current);
      budget.visited += 1;
      rememberSourceNodeSecret(current, classifier);
      stack.push(...[...current.childNodes]);
      if (current.nodeType === ELEMENT_NODE) {
        const shadowRoot = safelyReadShadowRoot(current as Element);
        if (shadowRoot) stack.push(...[...shadowRoot.childNodes]);
      }
    }
    return true;
  } catch {
    rememberSourceNodeSecret(root, classifier);
    return false;
  }
}

function rememberSourceNodeSecret(
  node: Node,
  classifier: StickySourceSecretClassifier,
): void {
  classifier.classify(node, {
    tagName: node.nodeType === TEXT_NODE ? '#text' : '#node',
    secretAncestor: true,
  });
}

function sourceDocumentElementForNode(node: Node): Element | undefined {
  try {
    if (node.nodeType === 9) {
      return (node as Document).documentElement ?? undefined;
    }
    return node.ownerDocument?.documentElement ?? undefined;
  } catch {
    return undefined;
  }
}

function sourceNodeIsWithinAddedSubtree(
  node: Node,
  addedRoots: ReadonlySet<Node>,
): boolean {
  if (addedRoots.size === 0) return false;
  const seen = new Set<Node>();
  try {
    let current: Node | null = node;
    while (current) {
      if (addedRoots.has(current)) return true;
      if (
        seen.has(current) ||
        seen.size >= MAX_SEMANTIC_SOURCE_NODE_IDENTITIES
      ) return true;
      seen.add(current);
      current = current.parentNode;
    }
    return false;
  } catch {
    // Unreadable or malformed ancestry cannot prove independence from a new
    // subtree whose pre-insertion masking state was not observable.
    return true;
  }
}

function sourceMutationBoundaryMayHoldValue(
  boundary: Element,
  records: readonly MutationRecord[],
): boolean {
  const stack = [boundary];
  const visited = new Set<Element>();
  while (stack.length > 0) {
    const element = stack.pop();
    if (!element || visited.has(element)) continue;
    visited.add(element);
    if (visited.size > MAX_SEMANTIC_SOURCE_NODE_IDENTITIES) return true;
    if (sourceElementIsValueOrControlBoundary(element, records)) return true;
    stack.push(...[...element.children]);
    const shadowRoot = safelyReadShadowRoot(element);
    if (shadowRoot) stack.push(...[...shadowRoot.children]);
    if (element.localName.toLowerCase() === 'slot') {
      try {
        const assigned = (element as HTMLSlotElement).assignedElements?.({
          flatten: true,
        });
        if (assigned) stack.push(...assigned);
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * beforeinput/input/change run synchronously while the page's intermediate
 * computed masking is still observable. Classify only structural/style facts;
 * the event's authored content is never read.
 */
export function rememberSourceEventSecret(
  event: Event,
  sourceWindow: Window,
  classifier: StickySourceSecretClassifier,
): void {
  let candidate: unknown;
  try {
    const path = typeof event.composedPath === 'function'
      ? event.composedPath()
      : [];
    candidate = path.find(isElementNode) ?? event.target;
  } catch {
    try {
      candidate = event.target;
    } catch {
      return;
    }
  }
  if (!isElementNode(candidate)) return;
  hasSourceCredentialSecretAncestor(candidate, classifier, sourceWindow);
}

function sourceMutationBatchChangesValueBearingContentWithin(
  boundary: Element,
  records: readonly MutationRecord[],
): boolean {
  for (const record of records) {
    let contentElement: Element | undefined;
    if (record.type === 'characterData') {
      contentElement = record.target.parentElement ?? undefined;
    } else if (record.type === 'childList') {
      contentElement = isElementNode(record.target)
        ? record.target
        : record.target.parentElement ?? undefined;
    } else if (
      record.type === 'attributes' &&
      ['value', 'placeholder'].includes(record.attributeName?.toLowerCase() ?? '')
    ) {
      contentElement = isElementNode(record.target) ? record.target : undefined;
    }
    if (!contentElement) continue;
    const path = readSourceFlatTreeElementPath(contentElement);
    if (!path) return true;
    const boundaryIndex = path.indexOf(boundary);
    if (boundaryIndex < 0) continue;
    if (path.slice(0, boundaryIndex + 1).some(
      (element) => sourceElementIsValueOrControlBoundary(element, records),
    )) return true;
  }
  return false;
}

function sourceElementIsValueOrControlBoundary(
  element: Element,
  records: readonly MutationRecord[],
): boolean {
  const tagName = element.localName.toLowerCase();
  const attributes = readSourceStructuralAttributes(element);
  if (
    SEMANTIC_CONTROL_TAGS.has(tagName) ||
    ['label', 'output', 'textarea'].includes(tagName) ||
    sourceRoleHasControlToken(attributes.role) ||
    sourceAttributesArePrivate(attributes)
  ) return true;
  for (const record of records) {
    if (record.type !== 'attributes' || record.target !== element) continue;
    const name = record.attributeName?.toLowerCase();
    if (
      name === 'contenteditable' &&
      record.oldValue !== null &&
      isSourcePrivateContentEditableValue(record.oldValue)
    ) return true;
    if (
      name === 'role' &&
      (
        sourceRoleHasControlToken(record.oldValue) ||
        sourceAttributesArePrivate({ role: record.oldValue })
      )
    ) return true;
  }
  return false;
}

function sourceRoleHasControlToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase()
    .split(/\s+/u).some((role) => SEMANTIC_CONTROL_ROLES.has(role));
}

function isElementNode(value: unknown): value is Element {
  return typeof value === 'object' && value !== null &&
    (value as Node).nodeType === ELEMENT_NODE;
}

function eagerlyClassifySourceDocumentSubtree(
  root: Element,
  sourceWindow: Window,
  classifier: StickySourceSecretClassifier,
): void {
  const stack: Array<{
    readonly node: Node;
    readonly secretAncestor: boolean;
  }> = [{ node: root, secretAncestor: false }];
  let visited = 0;
  try {
    while (stack.length > 0 && visited < MAX_SEMANTIC_SOURCE_NODE_IDENTITIES) {
      const current = stack.pop();
      if (!current) break;
      visited += 1;
      const flatTreeSecret = hasSourceCredentialSecretAncestor(
        current.node,
        classifier,
        sourceWindow,
      );
      if (current.secretAncestor && !flatTreeSecret) {
        rememberSourceNodeSecret(current.node, classifier);
      }
      const secret = current.secretAncestor || flatTreeSecret;
      const children = [...current.node.childNodes];
      if (current.node.nodeType === ELEMENT_NODE) {
        const shadowRoot = safelyReadShadowRoot(current.node as Element);
        if (shadowRoot) children.push(...[...shadowRoot.childNodes]);
      }
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index]!, secretAncestor: secret });
      }
    }
  } catch {
    rememberSourceNodeSecret(root, classifier);
    return;
  }
  if (stack.length > 0) rememberSourceNodeSecret(root, classifier);
}

function oldStyleUsedTextSecurity(value: string): boolean {
  const match = /(?:^|;)\s*-webkit-text-security\s*:\s*([^;]+)/iu.exec(value);
  return Boolean(match && normalizedToken(match[1]) !== 'none');
}

function sourceClassificationFacts(
  element: Element,
  sourceWindow: Window,
  secretAncestor: boolean,
  valueBearing: boolean,
): SourceClassificationFacts {
  let computedTextSecurity = '';
  let getComputedStyle: Window['getComputedStyle'] | undefined;
  try {
    const styleApiPresent = 'getComputedStyle' in sourceWindow;
    getComputedStyle = sourceWindow.getComputedStyle;
    if (styleApiPresent && typeof getComputedStyle !== 'function') {
      computedTextSecurity = 'unreadable';
    }
  } catch {
    computedTextSecurity = 'unreadable';
  }
  if (typeof getComputedStyle === 'function') {
    try {
      const style = getComputedStyle.call(sourceWindow, element);
      if (typeof style.getPropertyValue !== 'function') {
        computedTextSecurity = 'unreadable';
      } else {
        const value = style.getPropertyValue('-webkit-text-security');
        computedTextSecurity = typeof value === 'string' ? value : 'unreadable';
      }
    } catch {
      // An installed style API that cannot classify text security fails closed.
      computedTextSecurity = 'unreadable';
    }
  }
  return {
    tagName: element.localName.toLowerCase(),
    type: safelyReadAttribute(element, 'type'),
    autocomplete: safelyReadAttribute(element, 'autocomplete'),
    role: safelyReadAttribute(element, 'role'),
    contentEditable: safelyReadAttribute(element, 'contenteditable'),
    computedTextSecurity,
    secretAncestor,
    valueBearing,
  };
}

/** The typed ARIA states a public widget of this tag and role may carry. */
function semanticAriaStatesFor(
  tagName: string,
  role: string,
): readonly SemanticAriaState[] {
  const states: SemanticAriaState[] = [];
  if (SEMANTIC_ARIA_CHECKED_ROLES.has(role)) states.push('checked');
  if (SEMANTIC_ARIA_SELECTED_ROLES.has(role)) states.push('selected');
  if (SEMANTIC_ARIA_PRESSED_ROLES.has(role) || (role === '' && tagName === 'button')) {
    states.push('pressed');
  }
  if (
    SEMANTIC_ARIA_CURRENT_ROLES.has(role) ||
    (role === '' && SEMANTIC_ARIA_CURRENT_TAGS.has(tagName))
  ) states.push('current');
  if (SEMANTIC_ARIA_RANGE_INDICATOR_ROLES.has(role)) states.push('valuenow');
  return states;
}

/** Reads one bounded state token; anything else is left unproven. */
function readSemanticAriaStateValue(
  element: Element,
  state: SemanticAriaState,
  role: string,
): string | undefined {
  const raw = safelyReadAttribute(element, `aria-${state}`);
  if (typeof raw !== 'string') return undefined;
  const value = state === 'valuenow' ? raw.trim() : normalizedToken(raw);
  if (!isSemanticAriaStateValue(state, value)) return undefined;
  if (value === 'mixed' && state === 'checked' && !SEMANTIC_ARIA_MIXED_ROLES.has(role)) {
    return undefined;
  }
  return value;
}

function readDirectControlLabel(
  element: Element,
  tagName: string,
): string | undefined {
  if (tagName === 'option' || tagName === 'optgroup') {
    return normalizeSemanticText(readSourceSelectLabel(element)?.text);
  }
  for (const attribute of ['aria-label', 'title']) {
    const label = normalizeSemanticText(safelyReadAttribute(element, attribute));
    if (label) return label;
  }
  if (tagName === 'input') {
    const type = normalizedToken(safelyReadAttribute(element, 'type'));
    if (type === 'button' || type === 'submit' || type === 'reset') {
      return normalizeSemanticText(
        safelyRead(() => (element as HTMLInputElement).value),
      );
    }
  }
  return undefined;
}

function readControlValue(element: Element): string | undefined {
  return normalizeSemanticText(
    safelyRead(() => (element as HTMLInputElement | HTMLTextAreaElement).value),
  );
}

function readControlPlaceholder(element: Element): string | undefined {
  return normalizeSemanticText(safelyReadAttribute(element, 'placeholder'));
}

function readTextNode(node: Node): string | undefined {
  return normalizeSemanticText(safelyRead(() => node.nodeValue));
}

function normalizeSemanticText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > 3_500 || !/[\p{L}\p{N}]/u.test(text)) {
    return undefined;
  }
  return text;
}

function semanticTextFingerprint(value: unknown): string {
  const text = normalizeSemanticText(value);
  if (!text) return 'none';
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    fnv = Math.imul(fnv ^ code, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) ^ code) >>> 0;
  }
  return `${text.length}:${fnv}:${djb}`;
}

function safelyReadAttribute(element: Element, name: string): string {
  return safelyRead(() => element.getAttribute(name)) ?? '';
}

function canonicalAuthoredSelectSize(value: string | null): number | null {
  const normalized = value?.trim() ?? '';
  if (!/^\d{1,10}$/u.test(normalized)) return null;
  const size = Number(normalized);
  return Number.isSafeInteger(size) && size >= 1 &&
    size <= MAX_SEMANTIC_SELECT_SIZE
    ? size
    : null;
}

function safelyRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function safelyReadShadowRoot(element: Element): ShadowRoot | undefined {
  try {
    return element.shadowRoot ?? undefined;
  } catch {
    return undefined;
  }
}

function isSafeDomId(value: string): boolean {
  return value.length >= 1 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizedToken(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function semanticGateAdmits(
  scope: ReplicaReadScope,
  gate: SemanticSourceGate,
  category: SourceEvidenceCategory,
  presentation: SemanticSourcePresentation,
): boolean {
  if (gate === 'controlSemantics' && presentation === 'label') {
    return category === 'public-semantic' || category === 'ordinary-form' ||
      category === 'personal';
  }
  if (gate === 'disclosureContent' && presentation === 'text') {
    return category === 'public-semantic';
  }
  return replicaReadScopeAdmits(scope, category);
}

function isDisclosureActivationController(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  const role = normalizedToken(safelyReadAttribute(element, 'role'));
  if (SEMANTIC_ACTIVATION_ROLES.has(role)) return true;
  if (tagName === 'button' || tagName === 'summary') return true;
  if (tagName === 'a') {
    return Boolean(safelyReadAttribute(element, 'href').trim());
  }
  if (tagName !== 'input') return false;
  const type = normalizedToken(safelyReadAttribute(element, 'type'));
  return type === 'button' || type === 'reset' || type === 'submit';
}

function hasValidPopupSemantics(trigger: Element): boolean {
  const raw = safelyReadAttribute(trigger, 'aria-haspopup').trim();
  if (!raw) return true;
  const popup = normalizedToken(raw);
  return popup === 'true' || SEMANTIC_POPUP_ROLES.has(popup);
}

function popupTargetSemanticsMatch(
  trigger: Element,
  panel: Element,
): boolean {
  let popup = normalizedToken(safelyReadAttribute(trigger, 'aria-haspopup'));
  if (!popup) return true;
  if (popup === 'true') popup = 'menu';
  const panelRole = normalizedToken(safelyReadAttribute(panel, 'role'));
  if (!panelRole) return true;
  return popup === 'dialog'
    ? panelRole === 'dialog' || panelRole === 'alertdialog'
    : panelRole === popup;
}

function disclosurePopupRole(
  trigger: Element,
  panel: Element,
): SemanticDisclosurePopupRole {
  let popup = normalizedToken(safelyReadAttribute(trigger, 'aria-haspopup'));
  if (popup === 'true') popup = 'menu';
  if (SEMANTIC_POPUP_ROLES.has(popup)) {
    return popup as Exclude<SemanticDisclosurePopupRole, 'region'>;
  }
  const panelRole = normalizedToken(safelyReadAttribute(panel, 'role'));
  if (panelRole === 'alertdialog') return 'dialog';
  if (SEMANTIC_POPUP_ROLES.has(panelRole)) {
    return panelRole as Exclude<SemanticDisclosurePopupRole, 'region'>;
  }
  return 'region';
}

function findUniqueElementById(
  elements: readonly Element[],
  root: Node,
  id: string,
): Element | undefined {
  let match: Element | undefined;
  for (const element of elements) {
    if (element.getRootNode() !== root || safelyReadAttribute(element, 'id') !== id) {
      continue;
    }
    if (match) return undefined;
    match = element;
  }
  return match;
}

function isBoundedSafeDisclosurePanel(
  panel: Element,
  classifications: WeakMap<Element, ElementClassification>,
  requireNonEmpty = false,
): boolean {
  const pending: Node[] = [panel];
  const admitted: Node[] = [];
  while (pending.length > 0) {
    if (admitted.length >= MAX_SEMANTIC_DISCLOSURE_SUBTREE_NODES) return false;
    const node = pending.pop();
    if (!node || node.ownerDocument !== panel.ownerDocument) return false;
    admitted.push(node);
    if (node.nodeType !== ELEMENT_NODE) continue;
    const element = node as Element;
    const classification = classifications.get(element);
    if (
      !classification || classification.category !== 'public-semantic' ||
      disclosureElementCanCarryUserState(element)
    ) return false;
    const children: Node[] = [...element.childNodes];
    const shadowRoot = safelyReadShadowRoot(element);
    if (shadowRoot) children.push(...shadowRoot.childNodes);
    pending.push(...children);
  }
  let textUnits = 0;
  let hasText = false;
  for (const node of admitted) {
    if (node.nodeType !== TEXT_NODE) continue;
    const value = safelyRead(() => node.nodeValue);
    if (typeof value !== 'string') return false;
    textUnits += value.length;
    if (textUnits * 2 > MAX_SEMANTIC_SOURCE_BATCH_BYTES) return false;
    if (value.trim() !== '') hasText = true;
  }
  return !requireNonEmpty || hasText;
}

function isBoundedSafeTabPanel(
  panel: Element,
  classifications: WeakMap<Element, ElementClassification>,
): boolean {
  const pending: Node[] = [panel];
  let visited = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    if (
      !node || ++visited > MAX_SEMANTIC_DISCLOSURE_SUBTREE_NODES ||
      node.ownerDocument !== panel.ownerDocument
    ) return false;
    if (node.nodeType !== ELEMENT_NODE) continue;
    const element = node as Element;
    const classification = classifications.get(element);
    if (
      !classification || classification.category !== 'public-semantic' ||
      disclosureElementCanCarryUserState(element)
    ) return false;
    pending.push(...element.childNodes);
    const shadowRoot = safelyReadShadowRoot(element);
    if (shadowRoot) pending.push(...shadowRoot.childNodes);
  }
  return true;
}

function disclosureElementCanCarryUserState(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  if (
    tagName === 'input' || tagName === 'textarea' || tagName === 'select' ||
    tagName === 'option' || tagName === 'output'
  ) return true;
  const facts = sourceClassificationFacts(
    element,
    element.ownerDocument.defaultView ?? (globalThis as unknown as Window),
    false,
    true,
  );
  return facts.contentEditable?.trim().toLowerCase() !== '' ||
    facts.role?.trim().toLowerCase().split(/\s+/u).some(
      (role) => role === 'textbox' || role === 'searchbox' ||
        role === 'combobox' || role === 'listbox',
    ) === true;
}

function isExplicitlyHidden(element: Element): boolean {
  return element.hasAttribute('hidden') ||
    normalizedToken(safelyReadAttribute(element, 'aria-hidden')) === 'true';
}

function hasNavigationContext(element: Element): boolean {
  const path = readSourceFlatTreeElementPath(element);
  return Boolean(path?.some((ancestor) =>
    ancestor.localName.toLowerCase() === 'nav' ||
    normalizedToken(safelyReadAttribute(ancestor, 'role')) === 'navigation'));
}

function semanticSourceScanSignature(scan: SemanticSourceScan): string {
  return [
    scan.records.map((record) => `${record.recordId}:${record.nodeRevision}`)
      .join(','),
    scan.proofs.map((proof) =>
      `${semanticSourceProofIdentity(proof)}:${proof.revision}`).join(','),
  ].join('|');
}
