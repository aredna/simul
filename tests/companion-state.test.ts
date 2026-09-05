import { describe, expect, it } from 'vitest';

import {
  CompanionState,
  availabilityPairKey,
  sameTranslationPair,
} from '../entrypoints/sidepanel/companion-state';
import { withViewSettings } from '../lib/preferences';

const identity = { tabId: 4, windowId: 2, url: 'https://example.com/a' };

describe('CompanionState', () => {
  it('derives the translation pair from the detected language and the target', () => {
    const state = new CompanionState({ isDetachedWindow: false });
    expect(state.selectedPair()).toBeUndefined();
    state.resolvedSourceLanguage = 'ja';
    state.preferences = withViewSettings(state.preferences, { targetLanguage: 'en' });
    expect(state.selectedPair()).toEqual({ sourceLanguage: 'ja', targetLanguage: 'en' });
    expect(state.isCurrentTranslationPair({ sourceLanguage: 'ja', targetLanguage: 'en' })).toBe(true);
    expect(state.isCurrentTranslationPair({ sourceLanguage: 'ja', targetLanguage: 'fr' })).toBe(false);
    expect(state.currentTranslationTaskKey(7)).toBe('7:ja>en');
    state.resolvedSourceLanguage = undefined;
    expect(state.currentTranslationTaskKey(7)).toBe('7:unresolved');
  });

  it('prefers the followed identity for rebuilds and the captured one for releases', () => {
    const state = new CompanionState({ isDetachedWindow: false });
    const captured = { ...identity, url: 'https://example.com/old' };
    state.capturedPageIdentity = captured;
    expect(state.followedOrCapturedIdentity).toBe(captured);
    expect(state.capturedOrFollowedIdentity).toBe(captured);
    state.followedPageIdentity = identity;
    expect(state.followedOrCapturedIdentity).toBe(identity);
    expect(state.capturedOrFollowedIdentity).toBe(captured);
    expect(state.pageUrl).toBe(identity.url);
  });

  it('requires the active tab for side panels and active-following windows only', () => {
    const panel = new CompanionState({ isDetachedWindow: false });
    expect(panel.requiresActiveSourceTab).toBe(true);
    const popout = new CompanionState({ isDetachedWindow: true, detachedSourceWindowId: 9 });
    expect(popout.detachedSourceWindowId).toBe(9);
    expect(popout.requiresActiveSourceTab).toBe(false);
    popout.preferences = withViewSettings(popout.preferences, { popoutTabMode: 'active' });
    expect(popout.requiresActiveSourceTab).toBe(true);
    expect(popout.isLiveSourceOnlyMode).toBe(false);
    popout.preferences = withViewSettings(popout.preferences, { replicaViewMode: 'source-only' });
    expect(popout.isLiveSourceOnlyMode).toBe(true);
  });

  it('aborts every page work handle and clears the page as one unit', () => {
    const state = new CompanionState({ isDetachedWindow: false });
    const controllers = [new AbortController(), new AbortController()];
    [state.activeAbortController, state.replicaShadowAbortController] = controllers;
    state.followedPageIdentity = identity;
    state.capturedPageIdentity = identity;
    state.resolvedSourceLanguage = 'de';
    state.resolvedSourceLanguageOrigin = 'image';
    state.resolvedImageLanguageConfigurationKey = 'key';
    state.resolvedImageLanguageDocument = {} as never;
    state.pageLanguageResolutionPending = true;
    state.availability = 'available';
    state.availabilityCheckedForPair = '1:de>en';
    state.translationDesired = true;
    state.translationComplete = true;
    state.lastSourceScroll = {} as never;
    state.imageCaptureAccess = 'granted';
    state.panelWindowId = 3;
    state.preferenceSafetyConnectionReady = true;

    state.abortPageWork();
    expect(controllers.every((controller) => controller.signal.aborted)).toBe(true);

    state.clearPage();
    expect(state.followedPageIdentity).toBeUndefined();
    expect(state.capturedPageIdentity).toBeUndefined();
    expect(state.snapshot).toBeUndefined();
    expect(state.resolvedSourceLanguage).toBeUndefined();
    expect(state.resolvedSourceLanguageOrigin).toBeUndefined();
    expect(state.resolvedImageLanguageConfigurationKey).toBeUndefined();
    expect(state.resolvedImageLanguageDocument).toBeUndefined();
    expect(state.pageLanguageResolutionPending).toBe(false);
    expect(state.availability).toBe('unavailable');
    expect(state.availabilityCheckedForPair).toBeUndefined();
    expect(state.translationDesired).toBe(false);
    expect(state.translationComplete).toBe(false);
    expect(state.lastSourceScroll).toBeUndefined();
    // Device, window and settings facts survive a page invalidation.
    expect(state.imageCaptureAccess).toBe('granted');
    expect(state.panelWindowId).toBe(3);
    expect(state.preferenceSafetyConnectionReady).toBe(true);
  });

  it('reports the activity flags the toolbar reads', () => {
    const state = new CompanionState({ isDetachedWindow: false });
    state.captureInFlight = true;
    state.imageTranslationInFlight = true;
    expect(state.activity).toEqual({
      captureInFlight: true,
      translationInFlight: false,
      permissionInFlight: false,
      imageTranslationInFlight: true,
      surfaceTransitionInFlight: false,
    });
  });
});

describe('pair helpers', () => {
  it('keys availability by generation and pair and compares pairs by value', () => {
    expect(availabilityPairKey({ sourceLanguage: 'fr', targetLanguage: 'en' }, 3)).toBe('3:fr>en');
    expect(sameTranslationPair(undefined, undefined)).toBe(true);
    expect(sameTranslationPair({ sourceLanguage: 'fr', targetLanguage: 'en' }, undefined)).toBe(false);
    expect(sameTranslationPair(
      { sourceLanguage: 'fr', targetLanguage: 'en' },
      { sourceLanguage: 'fr', targetLanguage: 'en' },
    )).toBe(true);
  });
});
