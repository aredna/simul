import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const sidepanelSource = readFileSync(
  new URL('../entrypoints/sidepanel/main.ts', import.meta.url),
  'utf8',
);

describe('sidepanel navigation completion integration', () => {
  it('retargets a completed redirect before arming its refresh debounce', () => {
    const listenerStart = sidepanelSource.indexOf(
      'browser.tabs.onUpdated.addListener',
    );
    const listenerEnd = sidepanelSource.indexOf(
      'browser.tabs.onRemoved.addListener',
      listenerStart,
    );
    const listenerSource = sidepanelSource.slice(listenerStart, listenerEnd);
    const completionRetarget = listenerSource.indexOf(
      "if (changeInfo.status === 'complete') {",
    );
    const completionSchedule = listenerSource.indexOf(
      'scheduleNavigationRefresh(nextIdentity);',
      completionRetarget,
    );

    expect(listenerStart).toBeGreaterThanOrEqual(0);
    expect(completionRetarget).toBeGreaterThanOrEqual(0);
    expect(completionSchedule).toBeGreaterThan(completionRetarget);
    expect(
      listenerSource.slice(completionRetarget, completionSchedule),
    ).toContain('followedPageIdentity = nextIdentity;');
  });
});
