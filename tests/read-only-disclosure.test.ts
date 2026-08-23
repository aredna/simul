import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeReplicaDisclosurePlacement,
  installReadOnlyReplicaDisclosure,
} from
  '../lib/replica/read-only-disclosure';

describe('read-only replica disclosure placement', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a popup below its anchor when the viewport has room', () => {
    expect(computeReplicaDisclosurePlacement({
      anchor: {
        bottom: 140,
        height: 40,
        left: 120,
        right: 320,
        top: 100,
        width: 200,
      },
      panelHeight: 240,
      panelWidth: 260,
      viewportHeight: 700,
      viewportWidth: 900,
    })).toMatchObject({
      left: 120,
      placement: 'below',
      top: 144,
      minWidth: 200,
      maxHeight: 548,
    });
  });

  it('flips above and clamps an oversized popup inside the viewport', () => {
    const placement = computeReplicaDisclosurePlacement({
      anchor: {
        bottom: 590,
        height: 30,
        left: 760,
        right: 920,
        top: 560,
        width: 160,
      },
      panelHeight: 900,
      panelWidth: 600,
      viewportHeight: 620,
      viewportWidth: 800,
    });

    expect(placement.placement).toBe('above');
    expect(placement.left).toBe(192);
    expect(placement.top).toBe(8);
    expect(placement.maxHeight).toBe(548);
    expect(placement.maxWidth).toBe(784);
    expect(placement.minWidth).toBe(160);
  });

  it('repositions an open popup on replica scroll and resize', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Open</button><div id="panel">Panel</div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    let top = 80;
    Object.defineProperty(trigger, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: top + 30,
        height: 30,
        left: 40,
        right: 180,
        top,
        width: 140,
      }),
    });
    Object.defineProperty(panel, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 230,
        height: 120,
        left: 40,
        right: 220,
        top: 110,
        width: 180,
      }),
    });
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 800,
    });
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
    });
    controller.open();
    expect(controller.isOpen()).toBe(true);
    expect(panel.style.top).toBe('114px');

    top = 180;
    document.dispatchEvent(new window.Event('scroll'));
    expect(controller.isOpen()).toBe(true);
    expect(panel.style.top).toBe('214px');

    top = 240;
    window.dispatchEvent(new window.Event('resize'));
    expect(controller.isOpen()).toBe(true);
    expect(panel.style.top).toBe('274px');
    controller.dispose();
  });

  it('reveals the selected row when a long dropdown opens', () => {
    const { document } = parseHTML(
      '<html><body><button id="trigger">Open</button>' +
      '<div id="panel"><div role="option">First</div>' +
      '<div id="selected" role="option" aria-selected="true">Current</div></div>' +
      '</body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const selected = document.querySelector<HTMLElement>('#selected')!;
    const scrollIntoView = vi.fn();
    Object.defineProperty(selected, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
    });

    controller.open();

    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    });
    controller.dispose();
  });

  it('opens on hover and keeps the panel open while the pointer crosses the gap', () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><a id="trigger" href="/about">About</a><div id="panel"><a href="/team">Team</a></div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      manageTriggerExpanded: true,
    });

    trigger.dispatchEvent(new window.Event('pointerenter'));
    expect(controller.isOpen()).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    trigger.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(50);
    panel.dispatchEvent(new window.Event('pointerenter'));
    vi.advanceTimersByTime(100);
    expect(controller.isOpen()).toBe(true);

    panel.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(100);
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
  });

  it('does not schedule deferred closes for permanent or closed surfaces', () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><div id="list"><div role="option">One</div></div>' +
      '<button id="trigger">Open</button><div id="popup">Panel</div>' +
      '</body></html>',
    );
    const list = document.querySelector<HTMLElement>('#list')!;
    const listController = installReadOnlyReplicaDisclosure({
      anchor: list,
      panel: list,
      presentation: 'list',
    });
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const popup = document.querySelector<HTMLElement>('#popup')!;
    const popupController = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel: popup,
      presentation: 'popup',
    });

    list.dispatchEvent(new window.Event('pointerleave'));
    trigger.dispatchEvent(new window.Event('pointerleave'));
    expect(vi.getTimerCount()).toBe(0);

    popupController.open();
    trigger.dispatchEvent(new window.Event('pointerleave'));
    expect(vi.getTimerCount()).toBe(1);

    popupController.dispose();
    listController.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a hover-opened popup open on its first click', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Options</button>' +
      '<div id="panel">One</div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      manageTriggerExpanded: true,
    });

    trigger.dispatchEvent(new window.Event('pointerenter'));
    expect(controller.isOpen()).toBe(true);

    const firstClick = new window.Event('click', {
      bubbles: true,
      cancelable: true,
    });
    trigger.dispatchEvent(firstClick);
    expect(firstClick.defaultPrevented).toBe(true);
    expect(controller.isOpen()).toBe(true);

    trigger.dispatchEvent(new window.Event('click', {
      bubbles: true,
      cancelable: true,
    }));
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
  });

  it('opens for local focus, blocks panel actions, and closes on Escape', () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Resources</button><div id="panel"><a id="item" href="/school">Startup School</a></div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const item = document.querySelector<HTMLElement>('#item')!;
    const originalTriggerStyle = trigger.getAttribute('style');
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      manageTriggerExpanded: true,
    });

    trigger.dispatchEvent(new window.Event('focusin'));
    expect(controller.isOpen()).toBe(true);
    const action = new window.Event('click', { bubbles: true, cancelable: true });
    expect(item.dispatchEvent(action)).toBe(false);
    expect(action.defaultPrevented).toBe(true);

    const escape = new window.Event('keydown', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    panel.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true);
    expect(controller.isOpen()).toBe(false);

    controller.dispose();
    expect(trigger.getAttribute('style')).toBe(originalTriggerStyle);
    expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger'))
      .toBe(false);
  });

  it('keeps traversal and scrolling keys native while keyboard activation stays inert', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Resources</button><div id="panel"><a id="item" href="/school">Startup School</a></div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const item = document.querySelector<HTMLElement>('#item')!;
    const itemFocus = vi.fn(() => {
      item.dispatchEvent(new window.Event('focusin', { bubbles: true }));
    });
    const triggerFocus = vi.fn(() => {
      trigger.dispatchEvent(new window.Event('focusin', { bubbles: true }));
    });
    Object.defineProperty(item, 'focus', { configurable: true, value: itemFocus });
    Object.defineProperty(trigger, 'focus', {
      configurable: true,
      value: triggerFocus,
    });
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      manageTriggerExpanded: true,
    });
    const key = (value: string, shiftKey = false): Event => {
      const event = new window.Event('keydown', {
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperties(event, {
        key: { value },
        shiftKey: { value: shiftKey },
      });
      return event;
    };

    const arrowDown = key('ArrowDown');
    expect(trigger.dispatchEvent(arrowDown)).toBe(false);
    expect(controller.isOpen()).toBe(true);
    expect(itemFocus).toHaveBeenCalledOnce();

    for (const event of [
      key('Tab'),
      key('Tab', true),
      key('ArrowDown'),
      key('PageDown'),
      key('Home'),
    ]) {
      expect(item.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
    }
    const scrollSpace = key(' ');
    expect(panel.dispatchEvent(scrollSpace)).toBe(true);
    expect(scrollSpace.defaultPrevented).toBe(false);

    const activation = key('Enter');
    expect(item.dispatchEvent(activation)).toBe(false);
    expect(activation.defaultPrevented).toBe(true);

    const escape = key('Escape');
    expect(item.dispatchEvent(escape)).toBe(false);
    expect(triggerFocus).toHaveBeenCalledOnce();
    expect(controller.isOpen()).toBe(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    controller.dispose();
  });
});
