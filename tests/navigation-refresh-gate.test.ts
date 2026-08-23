import { describe, expect, it } from 'vitest';
import {
  isUrlOnlyNavigationSignal,
  NavigationRefreshGate,
} from '../lib/navigation-refresh-gate';

describe('isUrlOnlyNavigationSignal', () => {
  it('keeps document completions authoritative even when they include a URL', () => {
    expect(isUrlOnlyNavigationSignal(undefined, true)).toBe(true);
    expect(isUrlOnlyNavigationSignal('loading', true)).toBe(false);
    expect(isUrlOnlyNavigationSignal('complete', true)).toBe(false);
    expect(isUrlOnlyNavigationSignal(undefined, false)).toBe(false);
  });
});

describe('NavigationRefreshGate', () => {
  it('coalesces duplicate loading and completion signals', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.beginDocumentLoad('tab', 'tab:next')).toBe(true);
    expect(gate.beginDocumentLoad('tab', 'tab:next')).toBe(false);
    expect(gate.shouldScheduleComplete('tab', 'tab:next')).toBe(true);
    expect(gate.shouldScheduleComplete('tab', 'tab:next')).toBe(false);
  });

  it('coalesces redirected loading signals before one completion', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.beginDocumentLoad('tab', 'tab:start')).toBe(true);
    expect(gate.beginDocumentLoad('tab', 'tab:redirect')).toBe(false);
    expect(gate.beginDocumentLoad('tab', 'tab:final')).toBe(false);

    expect(gate.shouldScheduleComplete('tab', 'tab:final')).toBe(true);
  });

  it('does not rebuild for a URL-only same-document change', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.observeSameDocumentUrl('tab', 'tab:spa')).toBe(false);
    expect(gate.shouldScheduleComplete('tab', 'tab:spa', 'tab:old')).toBe(false);
    expect(gate.shouldScheduleComplete('tab', 'tab:spa', 'tab:old')).toBe(false);
  });

  it('identifies a history URL that retargets a scheduled document capture', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.beginDocumentLoad('tab', 'tab:complete-url')).toBe(true);
    expect(gate.shouldScheduleComplete('tab', 'tab:complete-url')).toBe(true);

    expect(gate.observeSameDocumentUrl('tab', 'tab:history-url')).toBe(true);
    expect(gate.shouldScheduleComplete(
      'tab',
      'tab:history-url',
      'tab:old',
    )).toBe(false);
  });

  it('retargets a pending document load across redirects', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.beginDocumentLoad('tab', 'tab:start')).toBe(true);

    expect(gate.observeSameDocumentUrl('tab', 'tab:redirected')).toBe(false);
    expect(gate.shouldScheduleComplete(
      'tab',
      'tab:redirected',
      'tab:old',
    )).toBe(true);
  });

  it('allows a real reload of the same URL', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.shouldScheduleComplete('tab', 'tab:page')).toBe(true);
    expect(gate.beginDocumentLoad('tab', 'tab:page')).toBe(true);
    expect(gate.shouldScheduleComplete('tab', 'tab:page', 'tab:page')).toBe(true);
  });

  it('schedules an unpaired completion only when it is not already current', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.shouldScheduleComplete(
      'tab',
      'tab:current',
      'tab:current',
    )).toBe(false);
    expect(gate.shouldScheduleComplete('tab', 'tab:new', 'tab:current')).toBe(true);
  });

  it('preserves a pending load when another path captures before completion', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.beginDocumentLoad('tab', 'tab:next')).toBe(true);

    gate.consumeCapture('tab', 'tab:next');

    expect(gate.shouldScheduleComplete('tab', 'tab:next', 'tab:old')).toBe(true);
  });

  it('consumes a URL-only signal when a recovery capture supersedes it', () => {
    const gate = new NavigationRefreshGate();
    gate.observeSameDocumentUrl('tab', 'tab:spa');

    gate.consumeCapture('tab', 'tab:spa');

    expect(gate.shouldScheduleComplete('tab', 'tab:spa', 'tab:old')).toBe(false);
  });

  it('drops a previous tab load when a different followed tab is captured', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.beginDocumentLoad('tab-a', 'tab-a:loading')).toBe(true);

    gate.consumeCapture('tab-b', 'tab-b:ready');

    expect(gate.shouldScheduleComplete(
      'tab-b',
      'tab-b:ready',
      'tab-b:ready',
    )).toBe(false);
  });

  it('does not let a previous tab load suppress current history state', () => {
    const gate = new NavigationRefreshGate();
    expect(gate.beginDocumentLoad('tab-a', 'tab-a:loading')).toBe(true);

    expect(gate.observeSameDocumentUrl('tab-b', 'tab-b:history')).toBe(false);
    gate.consumeCapture('tab-b', 'tab-b:history');

    expect(gate.shouldScheduleComplete(
      'tab-b',
      'tab-b:history',
      'tab-b:history',
    )).toBe(false);
  });
});
