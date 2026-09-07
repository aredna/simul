import {
  toolbarAttentionTarget,
  type CompanionStatusTone,
  type ToolbarAttentionTarget,
} from '../../lib/companion-ui-localization';
import {
  toolbarActivityLabel,
  toolbarProgressState,
  type ToolbarActivity,
} from '../../lib/companion-ui-state';

export interface ToolbarStatusElements {
  readonly status: HTMLElement;
  readonly refreshAttention: HTMLElement;
  readonly settingsAttention: HTMLElement;
  readonly toolbarProgress: HTMLElement;
  readonly toolbarProgressFill: HTMLElement;
  readonly compactToolbar: HTMLElement;
  readonly progressRegion: HTMLElement;
  readonly progressLabel: HTMLElement;
  readonly progressElement: HTMLElement;
}

/** Activity flags the companion owns; the determinate ratio is owned here. */
export type ToolbarActivityFlags = Omit<ToolbarActivity, 'determinateRatio'>;

export interface ToolbarStatusEnvironment {
  readonly elements: ToolbarStatusElements;
  readonly readActivity: () => ToolbarActivityFlags;
  readonly isSettingsOpen: () => boolean;
  /** Localizes one English catalogue string into the current UI language. */
  readonly localize: (english: string) => string;
}

export const IMAGE_PROGRESS_LABEL = 'Recognizing visible image text locally…';
const IDLE_LABEL = 'Companion idle';
const DETERMINATE_FALLBACK_LABEL = 'Translating page';

/**
 * The status line, the attention markers on Refresh and Settings, and the
 * two progress presentations (the toolbar bar and the settings progress
 * region). Warning and error state attaches to the action that can resolve
 * it; healthy state shows no marker.
 */
export class ToolbarStatus {
  #attention: ToolbarAttentionTarget | undefined;
  #attentionTone: Extract<CompanionStatusTone, 'warning' | 'error'> = 'warning';
  #determinateRatio: number | undefined;
  #englishMessage = '';
  #englishProgressLabel = '';

  constructor(private readonly environment: ToolbarStatusEnvironment) {}

  get attention(): ToolbarAttentionTarget | undefined {
    return this.#attention;
  }

  get attentionTone(): Extract<CompanionStatusTone, 'warning' | 'error'> {
    return this.#attentionTone;
  }

  /**
   * The last English message. Attention routing and the flows that branch on
   * the status text operate on English, while the DOM shows the localized form.
   */
  get statusText(): string {
    return this.#englishMessage;
  }

  setStatus(message: string, tone: CompanionStatusTone = 'normal'): void {
    const { status, refreshAttention, settingsAttention } = this.environment.elements;
    this.#englishMessage = message;
    const localized = this.environment.localize(message);
    status.textContent = localized;
    status.dataset.tone = tone;
    // Attention routing matches English keywords, never the localized text.
    this.#attention = toolbarAttentionTarget(message, tone);
    if (tone === 'warning' || tone === 'error') this.#attentionTone = tone;
    refreshAttention.title = this.#attention === 'refresh' ? localized : '';
    settingsAttention.title = this.#attention === 'settings' ? localized : '';
    this.renderAttention();
  }

  /** Re-renders the current status and progress labels in the current set. */
  relocalize(): void {
    const { status, refreshAttention, settingsAttention, progressLabel } =
      this.environment.elements;
    if (this.#englishMessage) {
      const localized = this.environment.localize(this.#englishMessage);
      if (status.textContent !== localized) status.textContent = localized;
      if (this.#attention === 'refresh') refreshAttention.title = localized;
      if (this.#attention === 'settings') settingsAttention.title = localized;
    }
    if (this.#englishProgressLabel) {
      const localized = this.environment.localize(this.#englishProgressLabel);
      if (progressLabel.textContent !== localized) progressLabel.textContent = localized;
      this.syncProgress();
    }
  }

  renderAttention(): void {
    const { refreshAttention, settingsAttention } = this.environment.elements;
    const refreshVisible = this.#attention === 'refresh';
    const settingsVisible =
      this.#attention === 'settings' && !this.environment.isSettingsOpen();
    refreshAttention.hidden = !refreshVisible;
    settingsAttention.hidden = !settingsVisible;
    refreshAttention.dataset.tone = this.#attentionTone;
    settingsAttention.dataset.tone = this.#attentionTone;
  }

  syncProgress(): void {
    const { toolbarProgress, toolbarProgressFill, compactToolbar, progressLabel } =
      this.environment.elements;
    const activity: ToolbarActivity = {
      ...(this.#determinateRatio === undefined
        ? {}
        : { determinateRatio: this.#determinateRatio }),
      ...this.environment.readActivity(),
    };
    const state = toolbarProgressState(activity);
    const busy = state.kind !== 'idle';
    toolbarProgress.hidden = !busy;
    compactToolbar.setAttribute('aria-busy', String(busy));
    if (state.kind === 'idle') {
      delete toolbarProgress.dataset.mode;
      toolbarProgressFill.style.removeProperty('--toolbar-progress-ratio');
      toolbarProgress.setAttribute('aria-label', this.environment.localize(IDLE_LABEL));
      toolbarProgress.removeAttribute('aria-valuenow');
      toolbarProgress.removeAttribute('aria-valuetext');
      return;
    }
    toolbarProgress.dataset.mode = state.kind;
    if (state.kind === 'determinate') {
      const percent = Math.round(state.ratio * 100);
      const label = progressLabel.textContent?.trim() ||
        this.environment.localize(DETERMINATE_FALLBACK_LABEL);
      toolbarProgressFill.style.setProperty(
        '--toolbar-progress-ratio',
        String(state.ratio),
      );
      toolbarProgress.setAttribute('aria-label', label);
      toolbarProgress.setAttribute('aria-valuenow', String(percent));
      toolbarProgress.setAttribute('aria-valuetext', `${label} ${percent}%`);
    } else {
      const label = this.environment.localize(toolbarActivityLabel(activity));
      toolbarProgressFill.style.removeProperty('--toolbar-progress-ratio');
      toolbarProgress.setAttribute('aria-label', label);
      toolbarProgress.removeAttribute('aria-valuenow');
      toolbarProgress.setAttribute('aria-valuetext', label);
    }
  }

  /** Determinate progress for a page translation. */
  showProgress(label: string, value: number, max: number): void {
    const { progressRegion, progressLabel, progressElement } = this.environment.elements;
    const boundedMax = Math.max(1, max);
    const boundedValue = Math.min(boundedMax, Math.max(0, value));
    progressRegion.hidden = false;
    this.#englishProgressLabel = label;
    progressLabel.textContent = this.environment.localize(label);
    progressElement.setAttribute('max', String(boundedMax));
    progressElement.setAttribute('value', String(boundedValue));
    this.#determinateRatio = boundedValue / boundedMax;
    this.syncProgress();
  }

  /** Indeterminate progress while image text is recognized. */
  showImageProgress(): void {
    const { progressRegion, progressLabel, progressElement } = this.environment.elements;
    progressRegion.hidden = false;
    this.#englishProgressLabel = IMAGE_PROGRESS_LABEL;
    progressLabel.textContent = this.environment.localize(IMAGE_PROGRESS_LABEL);
    progressElement.removeAttribute('value');
    this.syncProgress();
  }

  hideProgress(): void {
    const { progressRegion, progressElement } = this.environment.elements;
    this.#determinateRatio = undefined;
    const activity = this.environment.readActivity();
    if (
      activity.imageTranslationInFlight &&
      !activity.translationInFlight &&
      !activity.composerInFlight
    ) {
      this.showImageProgress();
      return;
    }
    progressRegion.hidden = true;
    progressElement.setAttribute('value', '0');
    this.syncProgress();
  }
}
