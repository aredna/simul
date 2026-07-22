import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { ISOLATED_PUBLIC_MENU_SHADOW_CSS } from
  '../lib/replica/isolated-html-engine';

const chrome = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

describe.skipIf(!chrome)('isolated disclosure shadow cascade in Chrome', () => {
  it('hides closed panels and computes open panels as fixed overlays', () => {
    const profile = mkdtempSync(join(tmpdir(), 'simul-disclosure-chrome-'));
    const html = `<!doctype html><html><body><pre id="result"></pre><script>
      const host = document.createElement('simul-owned-menu-test');
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(ISOLATED_PUBLIC_MENU_SHADOW_CSS)};
      shadow.append(style, document.createElement('div'));
      host.setAttribute('data-simul-replica-disclosure-panel', 'v1');
      host.hidden = true;
      document.body.append(host);
      const closed = getComputedStyle(host);
      const result = { closed: { display: closed.display } };
      host.hidden = false;
      host.setAttribute('data-simul-replica-disclosure-overlay', 'v1');
      host.style.setProperty('--simul-replica-disclosure-left', '123px', 'important');
      host.style.setProperty('--simul-replica-disclosure-top', '45px', 'important');
      host.style.setProperty('--simul-replica-disclosure-max-height', '210px', 'important');
      host.style.setProperty('--simul-replica-disclosure-max-width', '320px', 'important');
      host.style.setProperty('--simul-replica-disclosure-min-width', '180px', 'important');
      host.style.setProperty('--simul-replica-disclosure-visibility', 'visible', 'important');
      const open = getComputedStyle(host);
      result.open = {
        display: open.display,
        left: open.left,
        maxHeight: open.maxHeight,
        position: open.position,
        top: open.top,
        visibility: open.visibility,
      };
      document.getElementById('result').textContent = JSON.stringify(result);
    </script></body></html>`;
    const url = `data:text/html;base64,${Buffer.from(html).toString('base64')}`;

    try {
      const run = spawnSync(chrome!, [
        '--headless=new',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-gpu',
        '--no-sandbox',
        '--no-default-browser-check',
        '--no-first-run',
        `--user-data-dir=${profile}`,
        '--dump-dom',
        url,
      ], { encoding: 'utf8', maxBuffer: 2_000_000, timeout: 5_000 });
      expect(run.status, run.stderr).toBe(0);
      const payload = run.stdout.match(/<pre id="result">([^<]+)<\/pre>/u)?.[1];
      expect(payload).toBeDefined();
      expect(JSON.parse(payload ?? '{}')).toEqual({
        closed: { display: 'none' },
        open: {
          display: 'block',
          left: '123px',
          maxHeight: '210px',
          position: 'fixed',
          top: '45px',
          visibility: 'visible',
        },
      });
    } finally {
      rmSync(profile, { force: true, recursive: true });
    }
  }, 10_000);
});
