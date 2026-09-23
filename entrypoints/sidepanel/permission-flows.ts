import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { UI_STRINGS } from '../../lib/companion-ui-strings';
import { uiText, type UiText } from '../../lib/ui-text';
import { ACCESSIBILITY_TEXT_METHOD_ID } from '../../lib/ocr/image-reading-methods';
import { hasNonDefaultPort, readableError } from '../../lib/page-identity';
import type { PreferenceCommandResult } from '../../lib/preference-coordinator';
import {
  ALL_SITES_PERMISSION_ORIGINS,
  autoTranslationModeForPage,
  permissionOriginsForMode,
  withAutoTranslationMode,
  type AutoTranslationMode,
  type CompanionPreferences,
} from '../../lib/preferences';
import type { CompanionState, ImageCaptureAccess } from './companion-state';
import type { Currency } from './currency';
import type { PreferenceClient } from './preference-client';

export interface OriginPermissions {
  readonly origins: string[];
}

/** The subset of chrome.permissions the flows use; faked in tests. */
export interface PermissionApi {
  contains(permissions: OriginPermissions): Promise<boolean>;
  request(permissions: OriginPermissions): Promise<boolean>;
  remove(permissions: OriginPermissions): Promise<boolean>;
  getAll(): Promise<{ origins?: string[] | undefined }>;
}

export interface PermissionFlowsEnvironment {
  readonly state: CompanionState;
  readonly currency: Currency;
  readonly permissions: PermissionApi;
  readonly isUserActivationActive: () => boolean;
  readonly preferenceClient: PreferenceClient;
  /** Pixel OCR providers that are enabled and ready in this runtime. */
  readonly usablePixelProviderCount: () => number;
  readonly setStatus: (message: UiText, tone?: CompanionStatusTone) => void;
  readonly localizeTemplate: (
    frame: string,
    ...args: readonly (string | number)[]
  ) => string;
  readonly syncPreferenceControls: () => void;
  readonly updateControls: () => void;
  readonly renderImagePanel: () => void;
  readonly configureImageTranslation: () => void;
  /** The broad grant was revoked; image-derived caches must go. */
  readonly purgeImageCache: () => void;
  /** Automatic translation was just enabled for a scope that has a page. */
  readonly requestAutomaticTranslation: (pageUrl: string) => Promise<void>;
}

/** The broad grant was released, the save failed, and Chrome kept it released. */
class ImageAccessReleasedError extends Error {
  constructor(cause: unknown) {
    super(UI_STRINGS.statusImageAccessNotRestored, { cause });
    this.name = 'ImageAccessReleasedError';
  }
}

/** What a request to change image translation ended with. */
export type ImageTranslationChangeResult =
  | 'applied'
  | 'denied'
  | 'activation'
  | 'busy'
  | 'failed';

type ImageChangeOutcome =
  | { readonly kind: 'activation' }
  | { readonly kind: 'denied' }
  | {
      readonly kind: 'complete';
      readonly result: PreferenceCommandResult;
      readonly narrowAccessRestored: boolean;
    };

type AutoChangeOutcome =
  | { readonly kind: 'activation' }
  | { readonly kind: 'limit'; readonly preferences: CompanionPreferences }
  | {
      readonly kind: 'failed';
      readonly error: unknown;
      readonly result: PreferenceCommandResult | undefined;
    }
  | {
      readonly kind: 'denied' | 'complete' | 'not-applied';
      readonly result: PreferenceCommandResult;
    };

/**
 * The two preference changes that also change Chrome grants: image
 * translation (broad host access for pixel capture) and automatic translation
 * (per-site or all-sites access). Neither waits for the background while
 * holding its preference lock; each rolls its grant back when the save fails
 * and re-reads storage when Chrome refuses.
 */
export class PermissionFlows {
  constructor(private readonly environment: PermissionFlowsEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  /** Re-reads the broad image-capture grant and refreshes the image controls. */
  async refreshImageCaptureAccess(reportRevocation = false): Promise<void> {
    const state = this.#state;
    const { currency, permissions } = this.environment;
    const request = currency.begin('image-access');
    const previous = state.imageCaptureAccess;
    let next: ImageCaptureAccess;
    try {
      next = await permissions.contains({
        origins: [...ALL_SITES_PERMISSION_ORIGINS],
      }) ? 'granted' : 'missing';
    } catch {
      next = 'missing';
    }
    if (!currency.isCurrent(request)) return;
    const capturePermissionRevoked = reportRevocation &&
      previous === 'granted' && next === 'missing';
    if (capturePermissionRevoked) this.environment.purgeImageCache();
    state.imageCaptureAccess = next;
    this.environment.renderImagePanel();
    this.environment.configureImageTranslation();
    this.environment.updateControls();
    if (
      reportRevocation &&
      previous === 'granted' &&
      state.imageCaptureAccess === 'missing' &&
      state.preferences.imageTranslationEnabled
    ) {
      this.environment.setStatus(
        state.preferences.disabledImageReadingMethodIds.includes(
          ACCESSIBILITY_TEXT_METHOD_ID,
        )
          ? UI_STRINGS.statusImageAccessRemovedPixelPaused
          : UI_STRINGS.statusImageAccessRemovedAccessibilityActive,
        'warning',
      );
    }
  }

  /**
   * Turns image translation on or off, asking Chrome for image access when
   * requested. Resolves with what happened so the toolbar can tell a refused
   * grant ('denied') from a prompt that needs another gesture ('activation').
   */
  async changeImageTranslationEnabled(
    enabled: boolean,
    requestPixelAccess = false,
  ): Promise<ImageTranslationChangeResult> {
    const state = this.#state;
    const { setStatus, preferenceClient } = this.environment;
    if (state.permissionInFlight) {
      this.environment.syncPreferenceControls();
      return 'busy';
    }
    state.permissionInFlight = true;
    this.environment.renderImagePanel();
    this.environment.updateControls();
    let translatePageAfter = false;
    try {
      const shouldRequestPixelAccess = requestPixelAccess &&
        this.environment.usablePixelProviderCount() > 0;
      const outcome = await this.#performImageTranslationChange(
        enabled,
        shouldRequestPixelAccess,
      );
      if (outcome.kind === 'activation') {
        await preferenceClient.reloadFromStorage();
        setStatus(
          UI_STRINGS.statusChooseImageSettingAgain,
          'warning',
        );
        return 'activation';
      }
      if (outcome.kind === 'denied') {
        await preferenceClient.reloadFromStorage();
        setStatus(
          state.preferences.imageTranslationEnabled
            ? state.preferences.disabledImageReadingMethodIds.includes(
                ACCESSIBILITY_TEXT_METHOD_ID,
              )
              ? UI_STRINGS.statusPixelOcrRemainsPaused
              : UI_STRINGS.statusAccessibilityActiveNoPixel
            : UI_STRINGS.statusImageAccessDeniedOff,
          'warning',
        );
        return 'denied';
      }

      preferenceClient.applyCommitted(outcome.result.preferences);
      this.environment.syncPreferenceControls();
      setStatus(
        enabled
          ? UI_STRINGS.statusImageTranslationEnabled
          : outcome.narrowAccessRestored
            ? UI_STRINGS.statusImageTranslationOff
            : UI_STRINGS.statusImageTranslationOffPartialAccess,
        outcome.narrowAccessRestored ? 'success' : 'warning',
      );
      // Page text and image text translate together: switching image
      // translation on for a mirrored page also asks for the page text, the
      // same way saving an automatic scope does (D46). It runs after the lock
      // is released, so the OCR controls do not stay disabled for the whole
      // translation and its errors are its own, not an image-access failure
      // (review T2).
      translatePageAfter = enabled && Boolean(state.snapshot) &&
        !state.isLiveSourceOnlyMode;
      return 'applied';
    } catch (error) {
      await preferenceClient.reloadFromStorage();
      if (error instanceof ImageAccessReleasedError) {
        // The panel must show the state Chrome is in: purge image-derived
        // caches and report the revocation, then explain why it happened.
        await this.refreshImageCaptureAccess(true);
        setStatus(
          UI_STRINGS.statusImageAccessReleasedNotSaved,
          'error',
        );
        return 'failed';
      }
      setStatus(
        UI_STRINGS.statusImageAccessUpdateFailed,
        'error',
      );
      return 'failed';
    } finally {
      state.permissionInFlight = false;
      await this.refreshImageCaptureAccess();
      this.environment.syncPreferenceControls();
      this.environment.updateControls();
      if (translatePageAfter) {
        void this.environment.requestAutomaticTranslation(state.pageUrl ?? '')
          .catch(() => undefined);
      }
    }
  }

  async #performImageTranslationChange(
    enabled: boolean,
    shouldRequestPixelAccess: boolean,
  ): Promise<ImageChangeOutcome> {
    const { permissions, preferenceClient, isUserActivationActive } = this.environment;
    const userActivationAvailable = isUserActivationActive();
    let freshPreferences: CompanionPreferences | undefined;
    let newlyGranted = false;
    let removedImageCaptureGrant = false;
    try {
      const hadImageCaptureGrant = await permissions.contains({
        origins: [...ALL_SITES_PERMISSION_ORIGINS],
      });
      if (enabled && shouldRequestPixelAccess && !hadImageCaptureGrant) {
        if (!userActivationAvailable || !isUserActivationActive()) {
          return { kind: 'activation' };
        }
        const granted = await permissions.request({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        });
        if (!granted) return { kind: 'denied' };
        newlyGranted = true;
      }

      freshPreferences = await preferenceClient.readStored();
      let narrowAccessRestored = true;
      if (
        !enabled &&
        freshPreferences.imageTranslationEnabled &&
        !freshPreferences.autoTranslateAllSites &&
        hadImageCaptureGrant
      ) {
        const exactOrigins = freshPreferences.autoTranslateOrigins.flatMap(
          (origin) => permissionOriginsForMode('site', origin),
        );
        // Releasing the broad grant is safe only while the narrower grants it
        // covered can be requested right away. Without a live gesture that
        // request would fail and saved one-site automation would lose its
        // access, so ask for a fresh gesture before touching anything.
        if (
          exactOrigins.length > 0 &&
          (!userActivationAvailable || !isUserActivationActive())
        ) {
          return { kind: 'activation' };
        }
        const removed = await permissions.remove({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        });
        const broadStillPresent = await permissions.contains({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        });
        if (!removed && broadStillPresent) {
          throw new Error(UI_STRINGS.statusImageCaptureRetained);
        }
        removedImageCaptureGrant = !broadStillPresent;
        if (exactOrigins.length > 0) {
          narrowAccessRestored = userActivationAvailable &&
            await permissions.request({ origins: exactOrigins });
          if (narrowAccessRestored) {
            const actual = new Set((await permissions.getAll()).origins ?? []);
            narrowAccessRestored = exactOrigins.every((origin) => actual.has(origin));
          }
        }
      }

      const result = await preferenceClient.send({
        type: 'simul:preferences:patch-image-analysis',
        expectedResetRevision: freshPreferences.resetRevision,
        expectedSettingsRevision: freshPreferences.settingsRevision,
        patch: { imageTranslationEnabled: enabled },
      });
      if (!result.applied) {
        throw new Error(
          UI_STRINGS.statusSettingsResetElsewhereImage,
        );
      }
      return { kind: 'complete', result, narrowAccessRestored };
    } catch (error) {
      const prior = await preferenceClient.readStored().catch(
        () => freshPreferences ?? this.#state.preferences,
      );
      if (newlyGranted && !prior.autoTranslateAllSites && !prior.imageTranslationEnabled) {
        await permissions.remove({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        }).catch(() => false);
      }
      if (removedImageCaptureGrant && prior.imageTranslationEnabled) {
        // The rollback is only a rollback once Chrome confirms the grant is
        // back; a refused or expired re-request leaves the saved setting
        // pointing at access that no longer exists, and the caller must say so.
        const restored = await permissions.request({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        }).catch(() => false) && await permissions.contains({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        }).catch(() => false);
        if (!restored) throw new ImageAccessReleasedError(error);
      }
      throw error;
    }
  }

  async changeAutoTranslationMode(mode: AutoTranslationMode): Promise<void> {
    const state = this.#state;
    const { setStatus, preferenceClient } = this.environment;
    if (state.permissionInFlight) {
      this.environment.syncPreferenceControls();
      return;
    }
    const pageUrl = state.pageUrl;
    const requestedOrigins = permissionOriginsForMode(mode, pageUrl);
    if (mode === 'site' && requestedOrigins.length === 0) {
      this.environment.syncPreferenceControls();
      setStatus(
        hasNonDefaultPort(pageUrl)
          ? UI_STRINGS.statusNoNarrowPortAccess
          : UI_STRINGS.statusOpenRegularBeforeSiteAuto,
        'warning',
      );
      return;
    }
    state.permissionInFlight = true;
    this.environment.updateControls();
    try {
      const outcome = await this.#performAutoTranslationChange(
        mode,
        pageUrl,
        requestedOrigins,
      );
      if (outcome.kind === 'activation') {
        await preferenceClient.reloadFromStorage();
        setStatus(UI_STRINGS.statusChooseSettingAgain, 'warning');
        return;
      }
      if (outcome.kind === 'limit') {
        preferenceClient.applyCommitted(outcome.preferences);
        this.environment.syncPreferenceControls();
        setStatus(UI_STRINGS.statusSavedSiteLimit, 'warning');
        return;
      }
      if (outcome.kind === 'failed') {
        if (outcome.result) preferenceClient.applyCommitted(outcome.result.preferences);
        else await preferenceClient.reloadFromStorage();
        this.environment.syncPreferenceControls();
        setStatus(uiText(UI_STRINGS.statusAutoAccessUpdateError, readableError(outcome.error)), 'error');
        return;
      }
      preferenceClient.applyCommitted(outcome.result.preferences);
      this.environment.syncPreferenceControls();
      if (outcome.kind === 'denied' || outcome.kind === 'not-applied') {
        setStatus(UI_STRINGS.statusAutoScopeNotRetained, 'warning');
        return;
      }
      setStatus(
        mode === 'off'
          ? UI_STRINGS.statusAutoOffForScope
          : mode === 'all'
            ? UI_STRINGS.statusAutoEnabledRegular
            : UI_STRINGS.statusAutoEnabledThisSite,
        'success',
      );
      if (mode !== 'off' && state.snapshot && !state.isLiveSourceOnlyMode) {
        await this.environment.requestAutomaticTranslation(pageUrl ?? '');
      }
    } catch (error) {
      const repaired = await preferenceClient.send({
        type: 'simul:preferences:abort-auto',
        expectedResetRevision: state.preferences.resetRevision,
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      }).catch(() => undefined);
      if (repaired) preferenceClient.applyCommitted(repaired.preferences);
      else await preferenceClient.reloadFromStorage();
      this.environment.syncPreferenceControls();
      setStatus(uiText(UI_STRINGS.statusAutoAccessUpdateError, readableError(error)), 'error');
    } finally {
      state.permissionInFlight = false;
      this.environment.updateControls();
    }
  }

  async #performAutoTranslationChange(
    mode: AutoTranslationMode,
    pageUrl: string | undefined,
    requestedOrigins: string[],
  ): Promise<AutoChangeOutcome> {
    const { permissions, preferenceClient, isUserActivationActive } = this.environment;
    let freshPreferences: CompanionPreferences | undefined;
    try {
      freshPreferences = await preferenceClient.readStored();
      const candidate = withAutoTranslationMode(freshPreferences, pageUrl, mode);
      if (mode === 'site' && autoTranslationModeForPage(candidate, pageUrl) !== 'site') {
        return { kind: 'limit', preferences: freshPreferences };
      }
      if ((mode === 'site' || mode === 'all') && !isUserActivationActive()) {
        return { kind: 'activation' };
      }
      if (mode === 'site' && !freshPreferences.imageTranslationEnabled) {
        await permissions.remove({ origins: permissionOriginsForMode('all') });
      }
      const granted =
        requestedOrigins.length === 0 ||
        (await permissions.request({ origins: requestedOrigins }));
      if (!granted) {
        const result = await preferenceClient.send({
          type: 'simul:preferences:abort-auto',
          expectedResetRevision: freshPreferences.resetRevision,
          mode,
          ...(pageUrl ? { pageUrl } : {}),
        });
        return { kind: 'denied', result };
      }
      const result = await preferenceClient.send({
        type: 'simul:preferences:commit-auto',
        expectedResetRevision: freshPreferences.resetRevision,
        expectedSettingsRevision: freshPreferences.settingsRevision,
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      });
      if (result.applied) return { kind: 'complete', result };
      const repaired = await preferenceClient.send({
        type: 'simul:preferences:abort-auto',
        expectedResetRevision: result.preferences.resetRevision,
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      }).catch(() => result);
      return { kind: 'not-applied', result: repaired };
    } catch (error) {
      const latest = await preferenceClient.readStored().catch(
        () => freshPreferences ?? this.#state.preferences,
      );
      const result = await preferenceClient.send({
        type: 'simul:preferences:abort-auto',
        expectedResetRevision: latest.resetRevision,
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      }).catch(() => undefined);
      return { kind: 'failed', error, result };
    }
  }

  /** Reconciles saved automation with Chrome; true when a scope was revoked. */
  async reconcileAutomaticAccess(pageUrl: string | undefined): Promise<boolean> {
    const state = this.#state;
    const before = autoTranslationModeForPage(state.preferences, pageUrl);
    const result = await this.environment.preferenceClient.send({
      type: 'simul:preferences:reconcile',
    });
    this.environment.preferenceClient.applyCommitted(result.preferences);
    this.environment.syncPreferenceControls();
    return before !== autoTranslationModeForPage(state.preferences, pageUrl);
  }
}
