import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeReplicaDisclosurePlacement,
  installReadOnlyReplicaDisclosure,
  isReadOnlyReplicaDisclosureEvent,
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
    // A menu the site collapses with opacity (freee) must not open invisible.
    expect(panel.style.getPropertyValue('opacity')).toBe('1');

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

  it('skips permanent lists and closed popups during scroll layout work', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="list">One</div>' +
      '<button id="closed-trigger">Closed</button><div id="closed">Panel</div>' +
      '<button id="open-trigger">Open</button><div id="open">Panel</div>' +
      '</body></html>',
    );
    const list = document.querySelector<HTMLElement>('#list')!;
    const closedTrigger = document.querySelector<HTMLElement>('#closed-trigger')!;
    const closedPanel = document.querySelector<HTMLElement>('#closed')!;
    const openTrigger = document.querySelector<HTMLElement>('#open-trigger')!;
    const openPanel = document.querySelector<HTMLElement>('#open')!;
    const listRect = vi.fn(() => ({
      bottom: 20, height: 20, left: 0, right: 100, top: 0, width: 100,
    }));
    const closedRect = vi.fn(() => ({
      bottom: 50, height: 20, left: 0, right: 100, top: 30, width: 100,
    }));
    const openRect = vi.fn(() => ({
      bottom: 80, height: 20, left: 0, right: 100, top: 60, width: 100,
    }));
    Object.defineProperty(list, 'getBoundingClientRect', { value: listRect });
    Object.defineProperty(closedTrigger, 'getBoundingClientRect', {
      value: closedRect,
    });
    Object.defineProperty(openTrigger, 'getBoundingClientRect', { value: openRect });
    Object.defineProperty(openPanel, 'getBoundingClientRect', {
      value: () => ({
        bottom: 180, height: 100, left: 0, right: 100, top: 80, width: 100,
      }),
    });
    const listController = installReadOnlyReplicaDisclosure({
      anchor: list,
      panel: list,
      presentation: 'list',
    });
    const closedController = installReadOnlyReplicaDisclosure({
      anchor: closedTrigger,
      trigger: closedTrigger,
      panel: closedPanel,
      presentation: 'popup',
    });
    const openController = installReadOnlyReplicaDisclosure({
      anchor: openTrigger,
      trigger: openTrigger,
      panel: openPanel,
      presentation: 'popup',
    });
    openController.open();
    openRect.mockClear();

    document.dispatchEvent(new window.Event('scroll'));

    expect(listRect).not.toHaveBeenCalled();
    expect(closedRect).not.toHaveBeenCalled();
    expect(openRect).toHaveBeenCalledOnce();
    openController.dispose();
    closedController.dispose();
    listController.dispose();
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

  it('reveals an inline menu where the page draws it and restores it on close', () => {
    // A CSS or scripted hover menu (D82): the page's own panel opens in place
    // with the page's styles, including content the page fades in once open,
    // and a display:none mobile-only copy stays hidden.
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><ul><li id="item"><span id="trigger">Deposits</span>' +
      '<div id="panel" style="top: 84px"><div id="wrap" class="fade">' +
      '<a href="/yen">Yen deposits</a></div><div id="mobile" class="gone">' +
      'Deposits</div></div></li></ul></body></html>',
    );
    // linkedom windows share this property, so it is restored below.
    const pageStyle = Object.getOwnPropertyDescriptor(window, 'getComputedStyle');
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: (element: Element) => ({
        display: element.id === 'panel' || element.classList.contains('gone')
          ? 'none'
          : 'block',
        visibility: 'visible',
        opacity: element.classList.contains('fade') ? '0' : '1',
      }),
    });
    try {
      const item = document.querySelector<HTMLElement>('#item')!;
      const trigger = document.querySelector<HTMLElement>('#trigger')!;
      const panel = document.querySelector<HTMLElement>('#panel')!;
      const wrap = document.querySelector<HTMLElement>('#wrap')!;
      const mobile = document.querySelector<HTMLElement>('#mobile')!;
      const controller = installReadOnlyReplicaDisclosure({
        anchor: trigger,
        trigger,
        panel,
        presentation: 'inline',
        manageTriggerExpanded: true,
      });

      expect(panel.hasAttribute('hidden')).toBe(false);
      expect(panel.style.getPropertyValue('display')).toBe('');
      expect(panel.style.getPropertyValue('pointer-events')).toBe('none');

      trigger.dispatchEvent(new window.Event('pointerenter'));
      expect(controller.isOpen()).toBe(true);
      expect(panel.parentElement).toBe(item);
      expect(panel.style.getPropertyValue('display')).toBe('block');
      expect(panel.style.getPropertyValue('visibility')).toBe('visible');
      expect(panel.style.getPropertyValue('top')).toBe('84px');
      expect(panel.style.getPropertyValue('position')).toBe('');
      expect(wrap.style.getPropertyValue('opacity')).toBe('1');
      expect(mobile.getAttribute('style')).toBeNull();
      // The wheel over an open in-place menu scrolls the page, as on the page;
      // the pointer still belongs to the menu.
      const over = (type: string) => ({
        type,
        composedPath: () => [wrap, panel, item],
      }) as unknown as Event;
      expect(isReadOnlyReplicaDisclosureEvent(over('wheel'))).toBe(false);
      expect(isReadOnlyReplicaDisclosureEvent(over('pointerenter'))).toBe(true);

      trigger.dispatchEvent(new window.Event('pointerleave'));
      vi.advanceTimersByTime(100);
      expect(controller.isOpen()).toBe(false);
      expect(wrap.getAttribute('style')).toBeNull();
      expect(panel.style.getPropertyValue('display')).toBe('');
      expect(panel.style.getPropertyValue('top')).toBe('84px');
      controller.dispose();
      expect(panel.getAttribute('style')).toBe('top: 84px');
      expect(trigger.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(false);
    } finally {
      if (pageStyle) Object.defineProperty(window, 'getComputedStyle', pageStyle);
      else delete (window as { getComputedStyle?: unknown }).getComputedStyle;
    }
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

  it('dismisses an open popup when another permanent list is clicked', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Open</button><div id="popup">Panel</div>' +
      '<div id="list"><button id="list-item">One</button></div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const popup = document.querySelector<HTMLElement>('#popup')!;
    const list = document.querySelector<HTMLElement>('#list')!;
    const listItem = document.querySelector<HTMLElement>('#list-item')!;
    const popupController = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel: popup,
      presentation: 'popup',
    });
    const listController = installReadOnlyReplicaDisclosure({
      anchor: list,
      panel: list,
      presentation: 'list',
    });
    popupController.open();

    const pointerDown = new window.Event('pointerdown', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(pointerDown, 'composedPath', {
      configurable: true,
      value: () => [
        listItem,
        list,
        document.body,
        document.documentElement,
        document,
      ],
    });
    // Linkedom runs element capture listeners before document capture, unlike
    // browsers. Dispatch at the document while preserving the browser path so
    // this test exercises the document-owned dismissal decision directly.
    document.dispatchEvent(pointerDown);

    expect(popupController.isOpen()).toBe(false);
    popupController.dispose();
    listController.dispose();
  });

  it('limits identity checks to disclosure subtrees removed from the replica', async () => {
    const { document } = parseHTML(
      '<html><body><div id="owned"><button id="trigger">Open</button>' +
      '<div id="panel">Panel</div></div><div id="unrelated"></div></body></html>',
    );
    const owned = document.querySelector<HTMLElement>('#owned')!;
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const unrelated = document.querySelector<HTMLElement>('#unrelated')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
    });
    const triggerConnected = vi.fn(() => true);
    const panelConnected = vi.fn(() => true);
    Object.defineProperty(trigger, 'isConnected', {
      configurable: true,
      get: triggerConnected,
    });
    Object.defineProperty(panel, 'isConnected', {
      configurable: true,
      get: panelConnected,
    });
    document.body.append(document.createElement('div'));
    unrelated.remove();
    await Promise.resolve();
    expect(triggerConnected).not.toHaveBeenCalled();
    expect(panelConnected).not.toHaveBeenCalled();

    owned.remove();
    await Promise.resolve();
    expect(triggerConnected).toHaveBeenCalled();
    expect(panelConnected).toHaveBeenCalled();
    controller.dispose();
  });

  it('closes a popup when an item is chosen, not on empty space (D71)', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Menu</button><div id="panel">' +
      '<p id="heading">Products</p><a id="item" href="/team">Team</a></div></body></html>',
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
    const click = (target: Element) => {
      const event = new window.Event('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'button', { value: 0 });
      target.dispatchEvent(event);
      return event;
    };

    controller.open();
    click(document.querySelector('#heading')!);
    expect(controller.isOpen()).toBe(true);
    const chosen = click(document.querySelector('#item')!);
    // The choice closes the menu; the link itself is still never followed.
    expect(controller.isOpen()).toBe(false);
    expect(chosen.defaultPrevented).toBe(true);
    controller.dispose();
  });

  it('opens a select only on click and closes it on an enabled option (D71)', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Pick</button><div id="panel">' +
      '<div id="apple" data-simul-owned-select-option="v1">Apple</div>' +
      '<div id="banana" data-simul-owned-select-option="v1" aria-disabled="true">Banana</div>' +
      '</div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const rows = { apple: 0, banana: 20 };
    for (const [id, top] of Object.entries(rows)) {
      Object.defineProperty(document.querySelector(`#${id}`)!, 'getBoundingClientRect', {
        value: () => ({ left: 0, right: 100, top, bottom: top + 20, width: 100, height: 20 }),
      });
    }
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      manageTriggerExpanded: true,
      openOnHover: false,
    });
    // Owned options ignore pointer input, so a click lands on their list.
    const clickPanelAt = (clientY: number) => {
      const event = new window.Event('click', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'button', { value: 0 });
      Object.defineProperty(event, 'clientX', { value: 10 });
      Object.defineProperty(event, 'clientY', { value: clientY });
      panel.dispatchEvent(event);
    };

    trigger.dispatchEvent(new window.Event('pointerenter'));
    expect(controller.isOpen()).toBe(false);
    trigger.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(controller.isOpen()).toBe(true);
    clickPanelAt(30);
    expect(controller.isOpen()).toBe(true);
    clickPanelAt(60);
    expect(controller.isOpen()).toBe(true);
    clickPanelAt(10);
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
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
