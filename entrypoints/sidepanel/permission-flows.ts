import type { CompanionStatusTone } from '../../lib/companion-ui-localization';
import { hasNonDefaultPort, readableError } from '../../lib/page-identity';
import { PREFERENCE_LOCK_NAME } from '../../lib/preference-coordinator';
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
  /** Web Locks, or undefined where unavailable. */
  readonly locks: () => LockManager | undefined;
  readonly isUserActivationActive: () => boolean;
  readonly preferenceClient: PreferenceClient;
  readonly setStatus: (message: string, tone?: CompanionStatusTone) => void;
  readonly syncPreferenceControls: () => void;
  readonly updateControls: () => void;
  readonly renderImagePanel: () => void;
  readonly configureImageTranslation: () => void;
  /** Automatic translation was just enabled for a scope that has a page. */
  readonly requestAutomaticTranslation: (pageUrl: string) => Promise<void>;
}

type LockedImageOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'activation' }
  | { readonly kind: 'denied' }
  | {
      readonly kind: 'complete';
      readonly preferences: CompanionPreferences;
      readonly narrowAccessRestored: boolean;
    };

type LockedAutoOutcome =
  | { readonly kind: 'busy' }
  | { readonly kind: 'activation' }
  | { readonly kind: 'limit'; readonly preferences: CompanionPreferences }
  | {
      readonly kind: 'failed';
      readonly error: unknown;
      readonly preferences: CompanionPreferences | undefined;
    }
  | {
      readonly kind: 'denied' | 'complete' | 'not-applied';
      readonly preferences: CompanionPreferences;
    };

/**
 * The two preference changes that also change Chrome grants: image
 * translation (broad host access for pixel capture) and automatic translation
 * (per-site or all-sites access). Each runs under the shared preference lock
 * so two companion windows cannot interleave a grant and a save, and each
 * rolls its grant back when the save fails.
 */
export class PermissionFlows {
  constructor(private readonly environment: PermissionFlowsEnvironment) {}

  get #state(): CompanionState {
    return this.environment.state;
  }

  /** Re-reads the broad image-capture grant and refreshes the image controls. */
  async refreshImageCaptureAccess(reportRevocation = false): Promise<void> {
    const { currency, permissions } = this.environment;
    const request = currency.begin('image-access');
    const previous = this.#state.imageCaptureAccess;
    let next: ImageCaptureAccess;
    try {
      next = await permissions.contains({
        origins: [...ALL_SITES_PERMISSION_ORIGINS],
      }) ? 'granted' : 'missing';
    } catch {
      next = 'missing';
    }
    if (!currency.isCurrent(request)) return;
    this.#state.imageCaptureAccess = next;
    this.environment.renderImagePanel();
    this.environment.configureImageTranslation();
    this.environment.updateControls();
    if (
      reportRevocation &&
      previous === 'granted' &&
      this.#state.imageCaptureAccess === 'missing' &&
      this.#state.preferences.imageTranslationEnabled
    ) {
      this.environment.setStatus(
        'Image access was removed. Your image-translation setting is saved but paused; open options and choose Grant image access to resume.',
        'warning',
      );
    }
  }

  async changeImageTranslationEnabled(enabled: boolean): Promise<void> {
    const state = this.#state;
    const { setStatus, preferenceClient } = this.environment;
    if (state.permissionInFlight) {
      this.environment.syncPreferenceControls();
      return;
    }
    state.permissionInFlight = true;
    this.environment.renderImagePanel();
    this.environment.updateControls();
    try {
      const outcome = await this.#withPreferenceLock<LockedImageOutcome>(
        () => this.#performLockedImageTranslationChange(enabled),
      );

      if (outcome.kind === 'busy') {
        await preferenceClient.reloadFromStorage();
        setStatus(
          'Another companion window is saving image access. Try again.',
          'warning',
        );
        return;
      }
      if (outcome.kind === 'activation') {
        await preferenceClient.reloadFromStorage();
        setStatus(
          'Choose the image setting again so Chrome can show its access prompt.',
          'warning',
        );
        return;
      }
      if (outcome.kind === 'denied') {
        await preferenceClient.reloadFromStorage();
        setStatus(
          state.preferences.imageTranslationEnabled
            ? 'Image translation remains paused. Choose Grant image access when you are ready to retry.'
            : 'Chrome did not grant image access, so image translation remains off. You can retry from options.',
          'warning',
        );
        return;
      }

      this.#applyPreferences(outcome.preferences);
      setStatus(
        enabled
          ? 'Image translation is enabled for visible page images.'
          : outcome.narrowAccessRestored
            ? 'Image translation is off.'
            : 'Image translation is off. Chrome did not retain some saved one-site automatic access.',
        outcome.narrowAccessRestored ? 'success' : 'warning',
      );
    } catch {
      await preferenceClient.reloadFromStorage();
      setStatus(
        'Chrome could not update image access. Your saved setting was left unchanged; try again from options.',
        'error',
      );
    } finally {
      state.permissionInFlight = false;
      await this.refreshImageCaptureAccess();
      this.environment.syncPreferenceControls();
      this.environment.updateControls();
    }
  }

  async #performLockedImageTranslationChange(
    enabled: boolean,
  ): Promise<LockedImageOutcome> {
    const { permissions, preferenceClient, isUserActivationActive } = this.environment;
    const userActivationAvailable = isUserActivationActive();
    let freshPreferences: CompanionPreferences | undefined;
    let newlyGranted = false;
    let removedImageCaptureGrant = false;
    try {
      const hadImageCaptureGrant = await permissions.contains({
        origins: [...ALL_SITES_PERMISSION_ORIGINS],
      });
      if (enabled && !hadImageCaptureGrant) {
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
        const removed = await permissions.remove({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        });
        const broadStillPresent = await permissions.contains({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        });
        if (!removed && broadStillPresent) {
          throw new Error('Chrome retained image capture access.');
        }
        removedImageCaptureGrant = !broadStillPresent;
        const exactOrigins = freshPreferences.autoTranslateOrigins.flatMap(
          (origin) => permissionOriginsForMode('site', origin),
        );
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
        patch: { imageTranslationEnabled: enabled },
      });
      return { kind: 'complete', preferences: result.preferences, narrowAccessRestored };
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
        await permissions.request({
          origins: [...ALL_SITES_PERMISSION_ORIGINS],
        }).catch(() => false);
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
          ? 'Chrome cannot grant narrow one-site access to a non-default port.'
          : 'Open a regular HTTP or HTTPS page before enabling this-site automation.',
        'warning',
      );
      return;
    }
    state.permissionInFlight = true;
    this.environment.updateControls();
    try {
      const outcome = await this.#withPreferenceLock<LockedAutoOutcome>(
        () => this.#performLockedAutoTranslationChange(mode, pageUrl, requestedOrigins),
      );
      if (outcome.kind === 'busy') {
        await preferenceClient.reloadFromStorage();
        setStatus('Another companion window is saving this setting. Try again.', 'warning');
        return;
      }
      if (outcome.kind === 'activation') {
        await preferenceClient.reloadFromStorage();
        setStatus('Choose the setting again so Chrome can show its access prompt.', 'warning');
        return;
      }
      if (outcome.kind === 'limit') {
        this.#applyPreferences(outcome.preferences);
        setStatus('The saved-site limit has been reached.', 'warning');
        return;
      }
      if (outcome.kind === 'failed') {
        if (outcome.preferences) this.#applyPreferences(outcome.preferences);
        else {
          await preferenceClient.reloadFromStorage();
          this.environment.syncPreferenceControls();
        }
        setStatus(`Chrome could not update automatic access: ${readableError(outcome.error)}`, 'error');
        return;
      }
      this.#applyPreferences(outcome.preferences);
      if (outcome.kind === 'denied' || outcome.kind === 'not-applied') {
        setStatus('Chrome did not retain the requested automatic-access scope.', 'warning');
        return;
      }
      setStatus(
        mode === 'off'
          ? 'Automatic translation is off for this scope.'
          : mode === 'all'
            ? 'Automatic translation is enabled for regular web pages.'
            : 'Automatic translation is enabled for this site.',
        'success',
      );
      if (mode !== 'off') {
        await this.environment.requestAutomaticTranslation(pageUrl ?? '');
      }
    } catch (error) {
      const repaired = await preferenceClient.send({
        type: 'simul:preferences:abort-auto',
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      }).catch(() => undefined);
      if (repaired) this.#applyPreferences(repaired.preferences);
      else {
        await preferenceClient.reloadFromStorage();
        this.environment.syncPreferenceControls();
      }
      setStatus(`Chrome could not update automatic access: ${readableError(error)}`, 'error');
    } finally {
      state.permissionInFlight = false;
      this.environment.updateControls();
    }
  }

  async #performLockedAutoTranslationChange(
    mode: AutoTranslationMode,
    pageUrl: string | undefined,
    requestedOrigins: string[],
  ): Promise<LockedAutoOutcome> {
    const { permissions, preferenceClient, isUserActivationActive } = this.environment;
    const abort = () => preferenceClient.send({
      type: 'simul:preferences:abort-auto',
      mode,
      ...(pageUrl ? { pageUrl } : {}),
    });
    try {
      const freshPreferences = await preferenceClient.readStored();
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
        const result = await abort();
        return { kind: 'denied', preferences: result.preferences };
      }
      const result = await preferenceClient.send({
        type: 'simul:preferences:commit-auto',
        mode,
        ...(pageUrl ? { pageUrl } : {}),
      });
      return {
        kind: result.applied ? 'complete' : 'not-applied',
        preferences: result.preferences,
      };
    } catch (error) {
      const result = await abort().catch(() => undefined);
      return { kind: 'failed', error, preferences: result?.preferences };
    }
  }

  /** Reconciles saved automation with Chrome; true when a scope was revoked. */
  async reconcileAutomaticAccess(pageUrl: string | undefined): Promise<boolean> {
    const before = autoTranslationModeForPage(this.#state.preferences, pageUrl);
    const result = await this.environment.preferenceClient.send({
      type: 'simul:preferences:reconcile',
    });
    this.#applyPreferences(result.preferences);
    return before !== autoTranslationModeForPage(this.#state.preferences, pageUrl);
  }

  async #withPreferenceLock<Outcome extends { readonly kind: string }>(
    locked: () => Promise<Outcome>,
  ): Promise<Outcome | { readonly kind: 'busy' }> {
    const locks = this.environment.locks();
    if (!locks) throw new Error('Chrome Web Locks are unavailable.');
    return locks.request(
      PREFERENCE_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => (lock ? locked() : { kind: 'busy' as const }),
    ) as Promise<Outcome | { readonly kind: 'busy' }>;
  }

  #applyPreferences(preferences: CompanionPreferences): void {
    this.#state.preferences = this.environment.preferenceClient.mergePending(preferences);
    this.environment.syncPreferenceControls();
  }
}
