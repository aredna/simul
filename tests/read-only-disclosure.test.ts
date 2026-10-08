import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeReadOnlyReplicaDisclosures,
  computeReplicaDisclosurePlacement,
  disposeReadOnlyReplicaDisclosures,
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

  it('owns the whole of a press: touch, the release of the pointer and of a key (D132)', () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Pick</button><div id="panel">Rows</div>' +
      '<p id="page">Page</p></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const page = document.querySelector<HTMLElement>('#page')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
      openOnHover: false,
    });
    const owned = (target: HTMLElement, type: string): boolean => {
      let result = false;
      const listener = (event: Event): void => {
        result = isReadOnlyReplicaDisclosureEvent(event);
      };
      document.addEventListener(type, listener, true);
      target.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
      document.removeEventListener(type, listener, true);
      return result;
    };
    // Cancelling a tap's touch events cancels its click, and the frame closes
    // every preview for an input no preview owns.
    for (const type of ['touchstart', 'touchend', 'pointerup', 'keyup', 'keypress']) {
      expect(owned(trigger, type), `trigger ${type}`).toBe(true);
      expect(owned(panel, type), `panel ${type}`).toBe(true);
      expect(owned(page, type), `page ${type}`).toBe(false);
    }
    // The mouse's own press stays cancelled: it would move focus.
    expect(owned(trigger, 'mousedown')).toBe(false);
    expect(owned(trigger, 'input')).toBe(false);
    controller.dispose();
  });

  it('opens a menu by a tap and does not take a finger for a hover (D132)', () => {
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
    const pointer = (type: string, pointerType: string): Event => {
      const event = new window.Event(type);
      Object.defineProperty(event, 'pointerType', { value: pointerType });
      return event;
    };
    const tap = (): void => {
      // A finger enters with its press and leaves with its lift.
      trigger.dispatchEvent(pointer('pointerenter', 'touch'));
      trigger.dispatchEvent(pointer('pointerleave', 'touch'));
      trigger.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    };

    trigger.dispatchEvent(pointer('pointerenter', 'touch'));
    expect(controller.isOpen()).toBe(false);
    trigger.dispatchEvent(pointer('pointerleave', 'touch'));
    tap();
    expect(controller.isOpen()).toBe(true);
    // The lift is not a pointer leaving: the menu stays past the leave grace,
    // also after a touch on the open panel away from its items.
    vi.advanceTimersByTime(500);
    expect(controller.isOpen()).toBe(true);
    panel.dispatchEvent(pointer('pointerenter', 'touch'));
    panel.dispatchEvent(pointer('pointerleave', 'touch'));
    vi.advanceTimersByTime(500);
    expect(controller.isOpen()).toBe(true);
    tap();
    expect(controller.isOpen()).toBe(false);

    // A mouse still opens by hover and closes when it leaves.
    trigger.dispatchEvent(pointer('pointerenter', 'mouse'));
    expect(controller.isOpen()).toBe(true);
    trigger.dispatchEvent(pointer('pointerleave', 'mouse'));
    vi.advanceTimersByTime(150);
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
  });

  it('closes after the leave grace on the timer of its own realm (D132)', () => {
    // The replica frame runs no scripts: a timer set on its window never
    // fires, and a hover-opened menu stayed open after the pointer left.
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><a id="trigger" href="/about">About</a><div id="panel">Team</div></body></html>',
    );
    const frameTimer = vi.fn();
    Object.defineProperty(document, 'defaultView', {
      configurable: true,
      value: {
        setTimeout: frameTimer,
        clearTimeout: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
    });
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'popup',
    });
    trigger.dispatchEvent(new window.Event('pointerenter'));
    trigger.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(150);
    expect(frameTimer).not.toHaveBeenCalled();
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
  });

  it('opens again after a refresh what the reader had opened, not what the page had (D132)', async () => {
    const { document, window } = parseHTML(
      '<html><body><button id="trigger">Menu</button><div id="panel">Items</div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const install = (initiallyOpen = false) => installReadOnlyReplicaDisclosure({
      anchor: trigger,
      trigger,
      panel,
      presentation: 'inline',
      initiallyOpen,
    });
    const click = (): void => {
      trigger.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    };

    // A tap leaves no hover to reopen the menu by.
    let controller = install();
    click();
    expect(controller.isOpen()).toBe(true);
    disposeReadOnlyReplicaDisclosures(document as unknown as Document, true);
    controller = install();
    expect(controller.isOpen()).toBe(true);
    // And through a second refresh in the same task.
    controller.dispose();
    controller = install();
    expect(controller.isOpen()).toBe(true);

    // Closed by the reader: it stays closed.
    click();
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
    controller = install();
    expect(controller.isOpen()).toBe(false);
    controller.dispose();

    // Open only because the page showed it: when the page stops, it closes.
    controller = install(true);
    expect(controller.isOpen()).toBe(true);
    controller.dispose();
    controller = install(false);
    expect(controller.isOpen()).toBe(false);

    // A controller put up later is not the refresh's.
    click();
    controller.dispose();
    await Promise.resolve();
    controller = install();
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
  });

  it('keeps a controller marked to survive a refresh, with its open list (D132)', () => {
    const { document, window } = parseHTML(
      '<html><body><div id="host"><button id="pick">Pick</button><div id="rows">Rows</div></div>' +
      '<button id="menu">Menu</button><div id="items">Items</div></body></html>',
    );
    const host = document.querySelector<HTMLElement>('#host')!;
    const pick = document.querySelector<HTMLElement>('#pick')!;
    const rows = document.querySelector<HTMLElement>('#rows')!;
    const menu = document.querySelector<HTMLElement>('#menu')!;
    const items = document.querySelector<HTMLElement>('#items')!;
    const select = installReadOnlyReplicaDisclosure({
      anchor: host,
      trigger: pick,
      panel: rows,
      presentation: 'popup',
      openOnHover: false,
      survivesRefresh: true,
    });
    const siteMenu = installReadOnlyReplicaDisclosure({
      anchor: menu,
      trigger: menu,
      panel: items,
      presentation: 'inline',
    });
    pick.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(select.isOpen()).toBe(true);
    expect(rows.parentElement).toBe(document.body);

    disposeReadOnlyReplicaDisclosures(document as unknown as Document, true);
    expect(siteMenu.isDisposed()).toBe(true);
    expect(select.isDisposed()).toBe(false);
    // Not moved out and back: the list is where it was, scrolled as it was.
    expect(select.isOpen()).toBe(true);
    expect(rows.parentElement).toBe(document.body);

    // Its dropdown left the page: nothing to keep.
    host.remove();
    disposeReadOnlyReplicaDisclosures(document as unknown as Document, true);
    expect(select.isDisposed()).toBe(true);

    const again = installReadOnlyReplicaDisclosure({
      anchor: menu,
      trigger: menu,
      panel: items,
      presentation: 'inline',
      survivesRefresh: true,
    });
    // Without `refresh` everything goes.
    disposeReadOnlyReplicaDisclosures(document as unknown as Document);
    expect(again.isDisposed()).toBe(true);
  });

  it('opens and closes by any of its triggers (D132)', () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><ul><li id="item"><a id="link" href="/shop">Shop</a>' +
      '<button id="arrow">v</button><ul id="panel"><li>Alpha</li></ul></li></ul>' +
      '</body></html>',
    );
    const link = document.querySelector<HTMLElement>('#link')!;
    const arrow = document.querySelector<HTMLElement>('#arrow')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: link,
      trigger: link,
      additionalTriggers: [arrow],
      panel,
      presentation: 'inline',
      manageTriggerExpanded: true,
    });
    const click = (target: HTMLElement): Event => {
      const event = new window.Event('click', { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    };
    expect(arrow.getAttribute('data-simul-replica-disclosure-trigger')).toBe('v1');
    expect(click(arrow).defaultPrevented).toBe(true);
    expect(controller.isOpen()).toBe(true);
    expect(link.getAttribute('aria-expanded')).toBe('true');
    expect(arrow.hasAttribute('aria-expanded')).toBe(false);
    click(link);
    expect(controller.isOpen()).toBe(false);

    // The pointer may cross from one trigger to the other.
    link.dispatchEvent(new window.Event('pointerenter'));
    link.dispatchEvent(new window.Event('pointerleave'));
    arrow.dispatchEvent(new window.Event('pointerenter'));
    vi.advanceTimersByTime(200);
    expect(controller.isOpen()).toBe(true);
    arrow.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(200);
    expect(controller.isOpen()).toBe(false);

    const style = arrow.getAttribute('style');
    controller.dispose();
    expect(arrow.hasAttribute('data-simul-replica-disclosure-trigger')).toBe(false);
    expect(arrow.getAttribute('style')).not.toBe(style);
  });

  it('keeps a menu open around the dropdown opened inside it (D132)', () => {
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><a id="menu" href="/m">Menu</a><div id="items">' +
      '<div id="host"><button id="pick">Pick</button><div id="rows">Rows</div></div>' +
      '</div><button id="other">Other</button><div id="more">More</div></body></html>',
    );
    const menu = document.querySelector<HTMLElement>('#menu')!;
    const items = document.querySelector<HTMLElement>('#items')!;
    const host = document.querySelector<HTMLElement>('#host')!;
    const pick = document.querySelector<HTMLElement>('#pick')!;
    const rows = document.querySelector<HTMLElement>('#rows')!;
    const outer = installReadOnlyReplicaDisclosure({
      anchor: menu, trigger: menu, panel: items, presentation: 'inline',
    });
    const inner = installReadOnlyReplicaDisclosure({
      anchor: host, trigger: pick, panel: rows, presentation: 'popup',
      openOnHover: false,
    });
    const other = installReadOnlyReplicaDisclosure({
      anchor: document.querySelector<HTMLElement>('#other')!,
      trigger: document.querySelector<HTMLElement>('#other')!,
      panel: document.querySelector<HTMLElement>('#more')!,
      presentation: 'inline',
    });
    const press = (target: HTMLElement, type: string): void => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      // A primary click, as a real one is.
      Object.defineProperty(event, 'button', { value: 0 });
      target.dispatchEvent(event);
    };

    menu.dispatchEvent(new window.Event('pointerenter'));
    expect(outer.isOpen()).toBe(true);
    press(pick, 'pointerdown');
    press(pick, 'click');
    // One open at a time, except what holds the one that opens. And the
    // dropdown's button is not one of the menu's items: a click on it is the
    // dropdown's, not a choice that closes the menu.
    expect(inner.isOpen()).toBe(true);
    expect(outer.isOpen()).toBe(true);
    // Chrome hands a click to the menu's panel first, on its way down to the
    // button (linkedom does not): the panel leaves it to the dropdown.
    const viaPanel = new window.Event('click', { bubbles: true, cancelable: true });
    Object.defineProperties(viaPanel, {
      button: { value: 0 },
      composedPath: { value: () => [pick, host, items, document.body] },
    });
    items.dispatchEvent(viaPanel);
    expect(viaPanel.defaultPrevented).toBe(false);
    expect(outer.isOpen()).toBe(true);
    // The list is drawn at the end of the page, outside the menu: a press on
    // it is still a press inside the menu, and the pointer over it is not the
    // pointer leaving the menu.
    expect(rows.parentElement).toBe(document.body);
    menu.dispatchEvent(new window.Event('pointerleave'));
    press(rows, 'pointerdown');
    vi.advanceTimersByTime(300);
    expect(outer.isOpen()).toBe(true);
    expect(inner.isOpen()).toBe(true);

    // When the dropdown closes, the menu the pointer has left closes too.
    inner.close();
    expect(outer.isOpen()).toBe(true);
    vi.advanceTimersByTime(150);
    expect(outer.isOpen()).toBe(false);

    // And the dropdown closes with the menu around it.
    menu.dispatchEvent(new window.Event('pointerenter'));
    press(pick, 'click');
    expect(inner.isOpen()).toBe(true);
    press(document.querySelector<HTMLElement>('#other')!, 'click');
    expect(other.isOpen()).toBe(true);
    expect(outer.isOpen()).toBe(false);
    expect(inner.isOpen()).toBe(false);
    for (const controller of [outer, inner, other]) controller.dispose();
  });

  it('pins the display of a panel the page\'s own hover rule is showing (D132)', () => {
    // After a tap the rule stops matching at once; the open menu went blank.
    const { document, window } = parseHTML(
      '<html><body><a id="trigger" href="/m">Menu</a><div id="panel">Items</div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    let display = 'flex';
    Object.defineProperty(window, 'getComputedStyle', {
      configurable: true,
      value: () => ({ display, opacity: '1', visibility: 'visible' }),
    });
    try {
      const controller = installReadOnlyReplicaDisclosure({
        anchor: trigger, trigger, panel, presentation: 'inline',
      });
      controller.open();
      expect(panel.style.getPropertyValue('display')).toBe('flex');
      controller.close();
      expect(panel.style.getPropertyValue('display')).toBe('');
      display = 'none';
      controller.open();
      expect(panel.style.getPropertyValue('display')).toBe('block');
      controller.dispose();
    } finally {
      delete (window as { getComputedStyle?: unknown }).getComputedStyle;
    }
  });

  it('keeps what the page itself shows open when the pointer leaves it (D132)', () => {
    // The leave grace is for what the reader's hover opened. With the timer
    // working, a menu the page still showed closed in the replica when the
    // pointer passed over it.
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><a id="trigger" href="/m">Menu</a><div id="panel">Items</div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger, trigger, panel, presentation: 'inline', shownByPage: true,
    });
    expect(controller.isOpen()).toBe(true);
    trigger.dispatchEvent(new window.Event('pointerenter'));
    trigger.dispatchEvent(new window.Event('pointerleave'));
    panel.dispatchEvent(new window.Event('pointerenter'));
    panel.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(500);
    expect(controller.isOpen()).toBe(true);
    // The reader can still close it.
    trigger.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
  });

  it('lets a menu the pointer has just left close on time though a refresh comes in between (D132)', () => {
    // Reopened after the refresh with no memory of the pointer, it had no
    // leave to wait for and stayed open on any page that keeps changing.
    vi.useFakeTimers();
    const { document, window } = parseHTML(
      '<html><body><a id="trigger" href="/m">Menu</a><div id="panel">Items</div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const install = () => installReadOnlyReplicaDisclosure({
      anchor: trigger, trigger, panel, presentation: 'inline',
    });
    const refresh = () => {
      disposeReadOnlyReplicaDisclosures(document as unknown as Document, true);
      return install();
    };

    let controller = install();
    trigger.dispatchEvent(new window.Event('pointerenter'));
    trigger.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(40);
    controller = refresh();
    expect(controller.isOpen()).toBe(true);
    vi.advanceTimersByTime(30);
    controller = refresh();
    // The grace is not started again by each refresh: 100 ms in all.
    vi.advanceTimersByTime(29);
    expect(controller.isOpen()).toBe(true);
    vi.advanceTimersByTime(2);
    expect(controller.isOpen()).toBe(false);

    // The pointer still on the trigger: the menu stays, and closes when the
    // pointer leaves the new controller.
    trigger.dispatchEvent(new window.Event('pointerenter'));
    controller = refresh();
    vi.advanceTimersByTime(500);
    expect(controller.isOpen()).toBe(true);
    trigger.dispatchEvent(new window.Event('pointerleave'));
    vi.advanceTimersByTime(150);
    expect(controller.isOpen()).toBe(false);
    controller.dispose();
  });

  it('keeps apart what the page shows and what the reader opened (D132)', () => {
    // The page may show several at once (rows of an accordion); the reader
    // has one preview at a time, and a press elsewhere in the replica closes
    // that one only.
    const { document, window } = parseHTML(
      '<html><body><button id="a">A</button><ul id="la"><li>a</li></ul>' +
      '<button id="b">B</button><ul id="lb"><li>b</li></ul>' +
      '<a id="c" href="/c">C</a><div id="lc">c</div><p id="page">Page</p></body></html>',
    );
    const element = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
    const shown = (trigger: string, panel: string) => installReadOnlyReplicaDisclosure({
      anchor: element(trigger), trigger: element(trigger), panel: element(panel),
      presentation: 'inline', openOnHover: false, shownByPage: true,
    });
    const first = shown('a', 'la');
    const second = shown('b', 'lb');
    const readers = installReadOnlyReplicaDisclosure({
      anchor: element('c'), trigger: element('c'), panel: element('lc'),
      presentation: 'inline',
    });
    expect(first.isOpen()).toBe(true);
    expect(second.isOpen()).toBe(true);
    element('c').dispatchEvent(new window.Event('pointerenter'));
    expect([first, second, readers].map((controller) => controller.isOpen()))
      .toEqual([true, true, true]);

    element('page').dispatchEvent(
      new window.Event('pointerdown', { bubbles: true, cancelable: true }),
    );
    expect([first, second, readers].map((controller) => controller.isOpen()))
      .toEqual([true, true, false]);
    element('c').dispatchEvent(new window.Event('pointerenter'));
    closeReadOnlyReplicaDisclosures(document as unknown as Document);
    expect([first, second, readers].map((controller) => controller.isOpen()))
      .toEqual([true, true, false]);
    // The reader can still close one at its own button.
    element('a').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(first.isOpen()).toBe(false);
    for (const controller of [first, second, readers]) controller.dispose();
  });

  it('keeps a dropdown open inside a menu through a refresh, and closes it when the menu is gone (D132)', async () => {
    const { document, window } = parseHTML(
      '<html><body><a id="menu" href="/m">Menu</a><div id="items">' +
      '<div id="host"><button id="pick">Pick</button><div id="rows">Rows</div></div>' +
      '</div></body></html>',
    );
    const menu = document.querySelector<HTMLElement>('#menu')!;
    const items = document.querySelector<HTMLElement>('#items')!;
    const host = document.querySelector<HTMLElement>('#host')!;
    const pick = document.querySelector<HTMLElement>('#pick')!;
    const rows = document.querySelector<HTMLElement>('#rows')!;
    // The dropdown has a box while the menu around it is shown.
    let drawn = true;
    Object.defineProperty(host, 'getClientRects', {
      configurable: true,
      value: () => drawn ? [{}] : [],
    });
    const installMenu = () => installReadOnlyReplicaDisclosure({
      anchor: menu, trigger: menu, panel: items, presentation: 'inline',
      shownByPage: true,
    });
    let outer = installMenu();
    const inner = installReadOnlyReplicaDisclosure({
      anchor: host, trigger: pick, panel: rows, presentation: 'popup',
      openOnHover: false, survivesRefresh: true,
    });
    pick.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    expect(inner.isOpen()).toBe(true);

    // The page changes: the menu's preview is taken down and put up again.
    disposeReadOnlyReplicaDisclosures(document as unknown as Document, true);
    expect(inner.isOpen()).toBe(true);
    outer = installMenu();
    await Promise.resolve();
    expect(inner.isOpen()).toBe(true);
    expect(outer.isOpen()).toBe(true);

    // The page closes its menu: the preview is not put up again, and the
    // dropdown is no longer drawn.
    disposeReadOnlyReplicaDisclosures(document as unknown as Document, true);
    drawn = false;
    expect(inner.isOpen()).toBe(true);
    await Promise.resolve();
    expect(inner.isOpen()).toBe(false);
    inner.dispose();
  });

  it('takes no typing in a field inside a menu\'s panel (D132)', () => {
    const { document, window } = parseHTML(
      '<html><body><a id="trigger" href="/m">Menu</a><div id="panel">' +
      '<input id="search" type="search"><a id="item" href="/a">Alpha</a></div></body></html>',
    );
    const trigger = document.querySelector<HTMLElement>('#trigger')!;
    const panel = document.querySelector<HTMLElement>('#panel')!;
    const controller = installReadOnlyReplicaDisclosure({
      anchor: trigger, trigger, panel, presentation: 'inline',
    });
    controller.open();
    const key = (target: string, value: string): Event => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value });
      document.querySelector(target)!.dispatchEvent(event);
      return event;
    };
    expect(key('#search', 'a').defaultPrevented).toBe(true);
    expect(key('#search', 'ArrowLeft').defaultPrevented).toBe(true);
    // Focus can still move on, and keys beside the field scroll as before.
    expect(key('#search', 'Tab').defaultPrevented).toBe(false);
    expect(key('#item', 'ArrowDown').defaultPrevented).toBe(false);
    controller.dispose();
  });
});
