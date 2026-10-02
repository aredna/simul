import { describe, expect, it } from 'vitest';

import type { DetachedWindowCreateData } from '../lib/companion-surface';
import type { AuthorizedTabMessage, UnreadableTabMessage } from '../lib/page-identity';
import {
  ToolbarLauncher,
  type ToolbarLaunchEnvironment,
  type ToolbarLaunchTab,
} from '../lib/toolbar-launch';

const WINDOW_A = 1;
const WINDOW_B = 2;
const tabA: ToolbarLaunchTab = { id: 11, windowId: WINDOW_A, url: 'https://a.example/page' };
const tabB: ToolbarLaunchTab = { id: 22, windowId: WINDOW_B, url: 'https://b.example/page' };

describe('toolbar launch', () => {
  it('opens the side panel in the click\'s own turn and authorizes the clicked tab', async () => {
    const fixture = createFixture({ surface: 'side-panel', hydrated: true });
    const launch = fixture.launcher.click(tabA);
    // Before anything is awaited: Chrome needs the open inside the gesture.
    expect(fixture.calls).toEqual(['open:1']);
    await launch;
    expect(fixture.calls).toEqual(['open:1', 'send:authorized:11', 'remember:side-panel']);
    expect(fixture.messages).toEqual([{
      type: 'simul:authorized-tab',
      tabId: 11,
      windowId: WINDOW_A,
      url: 'https://a.example/page',
      launchEpoch: '7.epoch',
      launchSequence: 1,
    }]);
  });

  it('does not open a side panel once the saved choice is the separate window', async () => {
    const fixture = createFixture({ surface: 'popout', hydrated: true });
    await fixture.launcher.click(tabA);
    expect(fixture.calls).toEqual([
      'get:1', 'create', 'remember:popout', 'close:1',
    ]);
    expect(fixture.created).toMatchObject([{
      type: 'popup',
      focused: true,
      url: 'chrome-extension://simul/sidepanel.html?sourceTabId=11&sourceWindowId=1',
    }]);
  });

  it('closes the panel a click opened before the saved choice was read', async () => {
    const fixture = createFixture({ surface: 'popout', hydrated: false });
    const launch = fixture.launcher.click(tabA);
    expect(fixture.calls).toEqual(['open:1']);
    fixture.hydrate();
    await launch;
    expect(fixture.calls).toEqual([
      'open:1', 'get:1', 'create', 'remember:popout', 'close:1',
    ]);
  });

  it('falls back to closing every panel where Chrome has no per-window close', async () => {
    const fixture = createFixture({
      surface: 'popout', hydrated: false, perWindowClose: false,
    });
    const launch = fixture.launcher.click(tabA);
    fixture.hydrate();
    await launch;
    expect(fixture.calls.slice(-2)).toEqual(['enabled:false', 'enabled:true']);
  });

  it('tells an open side panel about a tab Simul cannot read, without its address (D112)', async () => {
    const fixture = createFixture({ surface: 'side-panel', hydrated: true });
    await fixture.launcher.click({
      id: 31, windowId: WINDOW_A, url: 'file:///reports/private.pdf',
    });
    expect(fixture.messages).toEqual([{
      type: 'simul:unreadable-tab',
      tabId: 31,
      windowId: WINDOW_A,
      localFile: true,
      launchEpoch: '7.epoch',
      launchSequence: 1,
    }]);
    // A tab still loading a web page is not called unreadable.
    await fixture.launcher.click({
      id: 32, windowId: WINDOW_A, url: 'about:blank', pendingUrl: 'https://a.example/next',
    });
    expect(fixture.messages).toHaveLength(1);
  });

  it('reuses the window it opened, and retargets it through the ordered message', async () => {
    const fixture = createFixture({ surface: 'popout', hydrated: true });
    await fixture.launcher.click(tabA);
    fixture.calls.length = 0;
    await fixture.launcher.click(tabB);
    expect(fixture.calls).toEqual([
      'get:100', 'focus:100', 'send:authorized:22', 'close:2',
    ]);
    expect(fixture.messages.at(-1)).toMatchObject({
      type: 'simul:authorized-tab', tabId: 22, launchEpoch: '7.epoch', launchSequence: 2,
    });
    expect(fixture.created).toHaveLength(1);
  });

  it('keeps the newest authorization for a window whose page is not listening yet (D121)', async () => {
    const fixture = createFixture({ surface: 'popout', hydrated: true });
    await fixture.launcher.click(tabA);
    // The click that opened the window sent it nothing: its address names
    // the tab.
    expect(fixture.launcher.windowAuthorization(100)).toBeUndefined();

    // A newer click takes the window over. The message goes out whether or
    // not the window's page listens yet, and the same message is kept.
    fixture.fail('send:authorized:22', 'Could not establish connection. Receiving end does not exist.');
    await fixture.launcher.click(tabB);
    expect(fixture.messages).toHaveLength(1);
    expect(fixture.launcher.windowAuthorization(100)).toEqual({
      type: 'simul:authorized-tab',
      tabId: 22,
      windowId: WINDOW_B,
      url: 'https://b.example/page',
      launchEpoch: '7.epoch',
      launchSequence: 2,
    });
    expect(fixture.launcher.windowAuthorization(100)).toBe(fixture.messages[0]);
    // Only the window it was sent to may have it.
    expect(fixture.launcher.windowAuthorization(WINDOW_A)).toBeUndefined();
    expect(fixture.launcher.windowAuthorization(undefined)).toBeUndefined();

    // A click on a tab Simul cannot read only brings the window forward:
    // the newest authorization is still the earlier click's.
    await fixture.launcher.click({ id: 31, windowId: WINDOW_A, url: 'file:///reports/a.pdf' });
    expect(fixture.launcher.windowAuthorization(100)).toMatchObject({ tabId: 22, launchSequence: 2 });

    fixture.launcher.windowRemoved(100);
    expect(fixture.launcher.windowAuthorization(100)).toBeUndefined();
  });

  it('keeps the newer click\'s authorization when two sends cross (D121)', async () => {
    const fixture = createFixture({ surface: 'popout', hydrated: true });
    await fixture.launcher.click(tabA);
    // The older click is held while the window is brought forward; the
    // newer one overtakes it.
    const held = fixture.hold('focus:100');
    const older = fixture.launcher.click(tabA);
    await held.reached;
    await fixture.launcher.click(tabB);
    expect(fixture.launcher.windowAuthorization(100)).toMatchObject({ tabId: 22, launchSequence: 3 });
    held.release();
    await older;
    // The older message still goes out, as before; the window orders the
    // two by their stamps. What is kept is the newer one.
    expect(fixture.messages.map((message) => message.launchSequence)).toEqual([3, 2]);
    expect(fixture.launcher.windowAuthorization(100)).toMatchObject({ tabId: 22, launchSequence: 3 });
  });

  it('opens the window for a tab Simul cannot read, and only brings an open one forward (D107)', async () => {
    const fixture = createFixture({ surface: 'popout', hydrated: true });
    const file: ToolbarLaunchTab = {
      id: 31, windowId: WINDOW_A, url: 'file:///reports/private.pdf',
    };
    await fixture.launcher.click(file);
    expect(fixture.created).toHaveLength(1);
    fixture.calls.length = 0;
    await fixture.launcher.click(file);
    expect(fixture.calls).toEqual(['get:100', 'focus:100', 'close:1']);
    expect(fixture.messages).toEqual([]);
  });

  it('opens another window for another tab while the first one is pinned', async () => {
    const fixture = createFixture({
      surface: 'popout', hydrated: true, popoutTabMode: 'locked',
    });
    await fixture.launcher.click(tabA);
    await fixture.launcher.click(tabB);
    expect(fixture.created).toHaveLength(2);
    // The newer window is the one remembered.
    fixture.calls.length = 0;
    await fixture.launcher.click(tabB);
    expect(fixture.calls).toEqual([
      'get:101', 'focus:101', 'send:authorized:22', 'close:2',
    ]);
  });

  it('forgets the window once it closes', async () => {
    const fixture = createFixture({ surface: 'popout', hydrated: true });
    await fixture.launcher.click(tabA);
    fixture.launcher.windowRemoved(100);
    await fixture.launcher.click(tabA);
    expect(fixture.created).toHaveLength(2);
  });

  describe('when a browser call fails', () => {
    const noReceiver = 'Could not establish connection. Receiving end does not exist.';

    it('does not treat a missing receiver of the side-panel message as an error', async () => {
      const fixture = createFixture({ surface: 'side-panel', hydrated: true });
      fixture.fail('send:authorized:11', noReceiver);
      await fixture.launcher.click(tabA);
      expect(fixture.calls).toEqual(['open:1', 'send:authorized:11', 'remember:side-panel']);
    });

    it('rejects the launch on another send error and remembers nothing', async () => {
      const fixture = createFixture({ surface: 'side-panel', hydrated: true });
      fixture.fail('send:authorized:11', 'boom');
      await expect(fixture.launcher.click(tabA)).rejects.toThrow('boom');
      expect(fixture.calls).toEqual(['open:1', 'send:authorized:11']);
    });

    it('still authorizes and remembers when the panel could not be opened', async () => {
      const fixture = createFixture({ surface: 'side-panel', hydrated: true });
      fixture.fail('open:1', 'sidePanel.open() may only be called in response to a user gesture.');
      await fixture.launcher.click(tabA);
      expect(fixture.calls).toEqual(['open:1', 'send:authorized:11', 'remember:side-panel']);
    });

    it('rejects when the window cannot be created, records nothing and tries again on the next click', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      fixture.fail('create', 'Invalid value for bounds.');
      await expect(fixture.launcher.click(tabA)).rejects.toThrow('bounds');
      expect(fixture.calls).toEqual(['get:1', 'create']);
      await expect(fixture.launcher.click(tabA)).rejects.toThrow('bounds');
      expect(fixture.calls).toEqual(['get:1', 'create', 'get:1', 'create']);
    });

    it('does not record a window that was created without an id', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true, createsNoWindow: true });
      await fixture.launcher.click(tabA);
      await fixture.launcher.click(tabA);
      expect(fixture.calls.filter((call) => call === 'create')).toHaveLength(2);
    });

    it('rejects when the clicked window has closed', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      fixture.fail('get:1', 'No window with id: 1.');
      await expect(fixture.launcher.click(tabA)).rejects.toThrow('No window');
      expect(fixture.created).toEqual([]);
    });

    it('replaces a recorded window that closed without its removal event', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      await fixture.launcher.click(tabA);
      fixture.closeWithoutEvent(100);
      fixture.calls.length = 0;
      await fixture.launcher.click(tabA);
      expect(fixture.calls).toEqual(['get:100', 'get:1', 'create', 'remember:popout', 'close:1']);
      expect(fixture.openWindows()).toEqual([101]);
    });

    it('falls back to closing every panel when the per-window close is rejected', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      fixture.fail('close:1', 'No active side panel.');
      await fixture.launcher.click(tabA);
      expect(fixture.calls).toEqual([
        'get:1', 'create', 'remember:popout', 'close:1', 'enabled:false', 'enabled:true',
      ]);
    });

    it('still closes the panel when the surface could not be remembered', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      fixture.fail('remember:popout', 'storage');
      await fixture.launcher.click(tabA);
      expect(fixture.calls).toEqual(['get:1', 'create', 'remember:popout', 'close:1']);
    });
  });

  describe('two windows clicked in quick succession', () => {
    it('closes the first window\'s panel when both clicks came before the saved choice was read', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: false });
      const first = fixture.launcher.click(tabA);
      const second = fixture.launcher.click(tabB);
      expect(fixture.calls).toEqual(['open:1', 'open:2']);
      fixture.hydrate();
      await Promise.all([first, second]);
      expect(fixture.calls).toEqual([
        'open:1', 'open:2', 'get:2', 'close:1', 'create', 'remember:popout', 'close:2',
      ]);
      expect(fixture.openWindows()).toEqual([100]);
    });

    it('closes the first window\'s panel when the second click comes while the source window is read (D121)', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: false });
      const held = fixture.hold('get:1');
      const first = fixture.launcher.click(tabA);
      fixture.hydrate();
      await held.reached;
      const second = fixture.launcher.click(tabB);
      held.release();
      await Promise.all([first, second]);
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual([
        'close:1', 'close:2',
      ]);
      expect(fixture.created).toHaveLength(1);
      expect(fixture.openWindows()).toEqual([100]);
      expect(fixture.calls).not.toContain('enabled:false');
    });

    it('closes the first window\'s panel and its own new window when the second click comes while that window opens (D121)', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: false });
      const held = fixture.hold('create');
      const first = fixture.launcher.click(tabA);
      fixture.hydrate();
      await held.reached;
      const second = fixture.launcher.click(tabB);
      held.release();
      await Promise.all([first, second]);
      expect(fixture.calls).toContain('close:1');
      expect(fixture.calls).toContain('remove:100');
      // The second click's window is the one left.
      expect(fixture.openWindows()).toEqual([101]);
      expect(fixture.calls).not.toContain('enabled:false');
    });

    it('keeps the window the second click took over, and closes the first window\'s panel (D121)', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: false });
      const held = fixture.hold('remember:popout');
      const first = fixture.launcher.click(tabA);
      fixture.hydrate();
      await held.reached;
      // The first click's window is open and remembered; the second click
      // retargets it instead of opening another.
      const second = fixture.launcher.click(tabB);
      await second;
      expect(fixture.calls.slice(-4)).toEqual([
        'get:100', 'focus:100', 'send:authorized:22', 'close:2',
      ]);
      held.release();
      await first;
      expect(fixture.calls).toContain('close:1');
      expect(fixture.calls).not.toContain('remove:100');
      expect(fixture.openWindows()).toEqual([100]);
      expect(fixture.calls).not.toContain('enabled:false');
    });

    it('closes the first window\'s panel when the second click comes while an open window is checked (D121)', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      await fixture.launcher.click(tabA);
      fixture.calls.length = 0;
      // A click handled as if the saved choice were not read yet.
      fixture.setHydrated(false);
      const held = fixture.hold('get:100');
      const first = fixture.launcher.click(tabA);
      expect(fixture.calls).toEqual(['open:1']);
      fixture.setHydrated(true);
      await held.reached;
      const second = fixture.launcher.click(tabB);
      held.release();
      await Promise.all([first, second]);
      expect(fixture.calls).toContain('close:1');
      expect(fixture.calls).not.toContain('enabled:false');
      expect(fixture.openWindows()).toEqual([100]);
    });

    it('closes the first window\'s panel when the second click comes while the open window is retargeted (D121)', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      await fixture.launcher.click(tabA);
      fixture.calls.length = 0;
      fixture.setHydrated(false);
      const held = fixture.hold('send:authorized:11');
      const first = fixture.launcher.click(tabA);
      fixture.setHydrated(true);
      await held.reached;
      const second = fixture.launcher.click(tabB);
      held.release();
      await Promise.all([first, second]);
      expect(fixture.calls).toContain('close:1');
      expect(fixture.calls).not.toContain('enabled:false');
    });

    it('closes a panel that was already open in the first window, as a click that was not superseded does (D121)', async () => {
      // The saved choice is known, so the click opens no panel itself; one
      // may be open in its window from before.
      for (const step of ['get:1', 'create', 'remember:popout'] as const) {
        const fixture = createFixture({ surface: 'popout', hydrated: true });
        const held = fixture.hold(step);
        const first = fixture.launcher.click(tabA);
        await held.reached;
        const second = fixture.launcher.click(tabB);
        held.release();
        await Promise.all([first, second]);
        expect(fixture.calls, step).not.toContain('open:1');
        expect(fixture.calls.filter((call) => call === 'close:1'), step).toHaveLength(1);
        expect(fixture.calls, step).not.toContain('enabled:false');
      }
      // The same when the click reuses the window that is already open.
      const fixture = createFixture({ surface: 'popout', hydrated: true });
      await fixture.launcher.click(tabA);
      fixture.calls.length = 0;
      const held = fixture.hold('send:authorized:11');
      const first = fixture.launcher.click(tabA);
      await held.reached;
      const second = fixture.launcher.click(tabB);
      held.release();
      await Promise.all([first, second]);
      expect(fixture.calls.filter((call) => call === 'close:1')).toHaveLength(1);
      expect(fixture.calls).not.toContain('enabled:false');
    });

    it('closes only a panel it opened itself when superseded before the saved choice was read', async () => {
      // No window id, so the first click could open no panel.
      const fixture = createFixture({ surface: 'popout', hydrated: false });
      const first = fixture.launcher.click({ id: 11, url: 'https://a.example/page' });
      const second = fixture.launcher.click(tabB);
      fixture.hydrate();
      await Promise.all([first, second]);
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual(['close:2']);
    });

    it('never closes every panel for a click that lost, where Chrome has no per-window close (D121)', async () => {
      for (const step of ['hydration', 'get:1', 'create', 'remember:popout'] as const) {
        const fixture = createFixture({
          surface: 'side-panel', hydrated: false, perWindowClose: false,
        });
        // The second click's side panel is the surface that won.
        const held = step === 'hydration' ? undefined : fixture.hold(step);
        const first = fixture.launcher.click(tabA);
        if (held) {
          // Only a click that takes the separate window reaches these steps.
          fixture.setSurface('popout');
          fixture.hydrate();
          await held.reached;
          fixture.setSurface('side-panel');
        }
        const second = fixture.launcher.click(tabB);
        if (held) held.release();
        else fixture.hydrate();
        await Promise.all([first, second]);
        expect(fixture.calls, step).not.toContain('enabled:false');
        expect(fixture.calls, step).toContain('send:authorized:22');
        expect(fixture.calls, step).not.toContain('close:2');
      }
    });

    it('closes a panel an earlier click of the same window opened, on three clicks (D121)', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: false });
      // The first click opens the panel ahead of the saved choice.
      const reading = fixture.hold('get:1');
      const first = fixture.launcher.click(tabA);
      fixture.hydrate();
      await reading.reached;
      // The second, in the same window, opens none and is itself
      // superseded from the other window.
      const opening = fixture.hold('create');
      const second = fixture.launcher.click({ ...tabA, id: 12 });
      await opening.reached;
      const third = fixture.launcher.click(tabB);
      reading.release();
      opening.release();
      await Promise.all([first, second, third]);
      expect(fixture.calls.filter((call) => call === 'open:1')).toHaveLength(1);
      expect(fixture.calls).toContain('close:1');
      expect(fixture.calls).not.toContain('enabled:false');
      expect(fixture.openWindows()).toEqual([101]);
    });

    it('leaves the panel alone when the newer click is in the same window', async () => {
      const fixture = createFixture({ surface: 'popout', hydrated: false });
      const held = fixture.hold('get:1');
      const first = fixture.launcher.click(tabA);
      fixture.hydrate();
      await held.reached;
      const second = fixture.launcher.click({ ...tabA, id: 12 });
      held.release();
      await first;
      // The first click stops without closing; the second closes the panel
      // as the click that opened the window.
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual([]);
      await second;
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual(['close:1']);
      expect(fixture.created).toHaveLength(1);
    });

    it('keeps both side panels when the side panel is the saved choice', async () => {
      const fixture = createFixture({ surface: 'side-panel', hydrated: true });
      const held = fixture.hold('send:authorized:11');
      const first = fixture.launcher.click(tabA);
      await held.reached;
      const second = fixture.launcher.click(tabB);
      held.release();
      await Promise.all([first, second]);
      expect(fixture.calls.filter((call) => call.startsWith('close:'))).toEqual([]);
      expect(fixture.calls).not.toContain('enabled:false');
    });
  });
});

interface Hold {
  /** Resolves when the launch reaches the held step. */
  readonly reached: Promise<void>;
  release(): void;
}

function createFixture(options: {
  readonly surface: 'side-panel' | 'popout';
  readonly hydrated: boolean;
  readonly perWindowClose?: boolean;
  readonly popoutTabMode?: 'active' | 'locked';
  /** `windows.create` resolves without a window. */
  readonly createsNoWindow?: boolean;
}) {
  const calls: string[] = [];
  const messages: Array<AuthorizedTabMessage | UnreadableTabMessage> = [];
  const created: DetachedWindowCreateData[] = [];
  const open = new Set<number>();
  const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
  const failures = new Map<string, Error>();
  let surface = options.surface;
  let hydrated = options.hydrated;
  let nextWindowId = 100;
  let resolveReady: () => void = () => undefined;
  const preferencesReady = options.hydrated
    ? Promise.resolve()
    : new Promise<void>((resolve) => { resolveReady = resolve; });

  // Records the step, waits if the test holds it, and rejects if the test
  // makes it fail.
  const step = async (name: string): Promise<void> => {
    calls.push(name);
    const held = holds.get(name);
    if (held) {
      holds.delete(name);
      held.reached();
      await held.released;
    }
    const failure = failures.get(name);
    if (failure) throw failure;
  };

  const environment: ToolbarLaunchEnvironment = {
    sidePanel: {
      open: ({ windowId }) => step(`open:${windowId}`),
      ...(options.perWindowClose === false
        ? {}
        : { close: ({ windowId }: { windowId: number }) => step(`close:${windowId}`) }),
      setOptions: ({ enabled }) => step(`enabled:${enabled}`),
    },
    windows: {
      get: async (windowId) => {
        await step(`get:${windowId}`);
        if (windowId >= 100) {
          if (!open.has(windowId)) throw new Error('No window with id.');
          return { type: 'popup' };
        }
        return { type: 'normal', width: 1200, height: 800, left: 0, top: 0 };
      },
      create: async (data) => {
        if (failures.has('create') || options.createsNoWindow) {
          await step('create');
          return undefined;
        }
        const id = nextWindowId;
        nextWindowId += 1;
        created.push(data);
        open.add(id);
        await step('create');
        return { id };
      },
      update: (windowId) => step(`focus:${windowId}`),
      remove: async (windowId) => {
        await step(`remove:${windowId}`);
        open.delete(windowId);
      },
    },
    sendMessage: async (message) => {
      messages.push(message);
      await step(
        `send:${message.type === 'simul:authorized-tab' ? 'authorized' : 'unreadable'}:${message.tabId}`,
      );
    },
    companionPageUrl: () => 'chrome-extension://simul/sidepanel.html',
    preferences: () => ({
      launchBehavior: surface,
      lastLaunchSurface: 'side-panel',
      popoutTabMode: options.popoutTabMode ?? 'active',
    }),
    preferencesHydrated: () => hydrated,
    preferencesReady,
    launchEpoch: Promise.resolve('7.epoch'),
    rememberSurface: (remembered) => step(`remember:${remembered}`),
  };

  return {
    launcher: new ToolbarLauncher(environment),
    calls,
    messages,
    created,
    openWindows: () => [...open].sort(),
    /** The saved preferences were read: later clicks know the choice. */
    hydrate: () => {
      hydrated = true;
      resolveReady();
    },
    setHydrated: (value: boolean) => { hydrated = value; },
    setSurface: (value: 'side-panel' | 'popout') => { surface = value; },
    /** The named step rejects from now on. */
    fail: (name: string, message: string) => { failures.set(name, new Error(message)); },
    /** The window is gone, and no removal event said so. */
    closeWithoutEvent: (windowId: number) => { open.delete(windowId); },
    hold: (name: string): Hold => {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const hold: Hold = {
        reached: new Promise<void>((resolve) => { reached = resolve; }),
        release: () => release(),
      };
      holds.set(name, {
        reached,
        released: new Promise<void>((resolve) => { release = resolve; }),
      });
      return hold;
    },
  };
}
