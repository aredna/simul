#!/usr/bin/env node
// Bumps the beta build suffix (`beta v.YYYYMMDD.NN` -> `.NN+1`) everywhere
// the build identity is written: wxt.config.ts, README (two places) and the
// two identity tests. Every shipped change bumps it (review process item).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const FILES = [
  'wxt.config.ts',
  'README.md',
  'tests/build-identity.test.ts',
  'tests/extension-artifact.test.mjs',
];

const config = readFileSync(`${root}wxt.config.ts`, 'utf8');
const match = /const betaBuildSuffix = 'beta v\.(\d{8})\.(\d+)';/u.exec(config);
if (!match) {
  console.error('betaBuildSuffix not found in wxt.config.ts');
  process.exit(1);
}
const [, date, number] = match;
const current = `${date}.${number}`;
const next = `${date}.${String(Number(number) + 1).padStart(number.length, '0')}`;

// Check every file before writing any, so a miss leaves nothing half-bumped.
const updates = FILES.map((file) => {
  const path = `${root}${file}`;
  const text = readFileSync(path, 'utf8');
  const count = text.split(current).length - 1;
  if (count === 0) {
    console.error(`${file} does not mention ${current}; nothing changed.`);
    process.exit(1);
  }
  return { file, path, text, count };
});
for (const { file, path, text, count } of updates) {
  writeFileSync(path, text.replaceAll(current, next));
  console.log(`${file}: ${count} × ${current} -> ${next}`);
}
console.log(`Build identity is now beta v.${next}. Run npm run artifact:sync next.`);
