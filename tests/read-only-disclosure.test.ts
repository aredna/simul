import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  computeReplicaDisclosurePlacement,
  installReadOnlyReplicaDisclosure,
} from
  '../lib/replica/read-only-disclosure';

describe('read-only replica disclosure placement', () => {
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
});
