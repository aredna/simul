// Runs the vendored pdf.js on every PDF fixture in a plain Node process and
// prints one JSON report. Node 24 lacks the same built-ins as Chrome 138, so
// a run with the shim that logs no warning or error shows the shim still
// covers what pdf.js calls. `--no-shim` skips the shim to show the gap exists.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../..');
const vendor = resolve(root, 'vendor/pdfjs');
const fixtures = resolve(root, 'tests/fixtures/pdf');
const useShim = !process.argv.includes('--no-shim');

const messages = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  console[level] = (...parts) => messages.push(`${level}: ${parts.join(' ')}`);
}
const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(String(reason)));

const report = { useShim, fixtures: {}, messages, unhandled };
try {
  if (useShim) await import(pathToFileURL(resolve(vendor, 'simul-shim.mjs')).href);
  const pdfjs = await import(pathToFileURL(resolve(vendor, 'pdf.min.mjs')).href);
  // Node runs the worker in this process, so the bare worker keeps the shim out.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    resolve(vendor, useShim ? 'simul-worker.mjs' : 'pdf.worker.min.mjs'),
  ).href;
  const imageOperators = new Set(
    Object.entries(pdfjs.OPS)
      .filter(([name]) => /Image/u.test(name))
      .map(([, code]) => code),
  );
  for (const name of (await readdir(fixtures)).filter((file) => file.endsWith('.pdf')).sort()) {
    const result = {};
    report.fixtures[name] = result;
    const task = pdfjs.getDocument({
      data: new Uint8Array(await readFile(resolve(fixtures, name))),
      cMapUrl: `${vendor}/cmaps/`,
      standardFontDataUrl: `${vendor}/standard_fonts/`,
      wasmUrl: `${vendor}/wasm/`,
      iccUrl: `${vendor}/iccs/`,
      // As in a browser: only Symbol and Dingbats come from standard_fonts.
      useSystemFonts: true,
      password: name === 'password.pdf' ? 'simul' : undefined,
    });
    try {
      const document = await task.promise;
      result.fingerprint = document.fingerprints[0];
      result.pages = [];
      for (let number = 1; number <= document.numPages; number += 1) {
        const page = await document.getPage(number);
        const text = await page.getTextContent();
        const operators = await page.getOperatorList();
        result.pages.push({
          textItems: text.items.filter((item) => item.str).length,
          images: operators.fnArray.filter((code) => imageOperators.has(code)).length,
        });
      }
    } catch (error) {
      result.error = `${error?.name}: ${error?.message}`;
    } finally {
      await task.destroy();
    }
  }
} catch (error) {
  report.error = `${error?.name}: ${error?.message}`;
}
process.stdout.write(`${JSON.stringify(report)}\n`);
