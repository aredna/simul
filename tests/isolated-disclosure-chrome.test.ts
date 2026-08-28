import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

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

const FIXTURE_RUNS = 5;
const MAX_CHROME_OUTPUT_BYTES = 2_000_000;
const CHROME_FIXTURE_TIMEOUT_MS = 8_000;

function readChromeFixture(profile: string, url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome!, [
      '--headless=new',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-gpu',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-sandbox',
      '--no-default-browser-check',
      '--no-first-run',
      '--password-store=basic',
      '--use-mock-keychain',
      `--user-data-dir=${profile}`,
      '--dump-dom',
      url,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let payload: string | undefined;
    let terminalError: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      terminalError = new Error(
        `Chrome fixture timed out after ${CHROME_FIXTURE_TIMEOUT_MS}ms. ${stderr}`,
      );
      child.kill('SIGKILL');
    }, CHROME_FIXTURE_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_CHROME_OUTPUT_BYTES) {
        terminalError = new Error('Chrome fixture exceeded its stdout bound.');
        child.kill('SIGKILL');
        return;
      }

      const match = stdout.match(
        /<pre(?=[^>]*\bid="result")(?=[^>]*\bdata-simul-fixture-ready="true")[^>]*>([^<]+)<\/pre>/u,
      );
      if (!match || payload !== undefined || terminalError) {
        return;
      }

      payload = match[1];
      clearTimeout(timeout);
      child.kill('SIGTERM');
      forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_CHROME_OUTPUT_BYTES);
    });
    child.once('error', (error) => {
      terminalError = error;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (forceKill) {
        clearTimeout(forceKill);
      }
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (payload === undefined) {
        reject(new Error(
          `Chrome fixture exited before producing a result (code ${String(code)}, signal ${String(signal)}). ${stderr}`,
        ));
        return;
      }

      try {
        resolve(JSON.parse(payload));
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe.skipIf(!chrome)('isolated disclosure shadow cascade in Chrome', () => {
  it('is stable across five fresh Chrome profiles', async () => {
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
      document.getElementById('result').setAttribute('data-simul-fixture-ready', 'true');
    </script></body></html>`;
    const url = `data:text/html;base64,${Buffer.from(html).toString('base64')}`;

    for (let attempt = 0; attempt < FIXTURE_RUNS; attempt += 1) {
      const profile = mkdtempSync(join(tmpdir(), 'simul-disclosure-chrome-'));
      try {
        await expect(readChromeFixture(profile, url)).resolves.toEqual({
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
    }
  }, 60_000);
});
