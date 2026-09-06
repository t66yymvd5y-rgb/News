#!/usr/bin/env node
/**
 * Kertas asset stamping.
 *
 * Rewrites the stylesheet and script URLs in index.html to carry a hash of the
 * file they point at, so a published change is never served from the browser's
 * copy of the one before it.
 *
 * GitHub Pages sends every file with Cache-Control: max-age=600 and no
 * fingerprint in the name. Without a stamp a phone that has the site cached will
 * keep the old app.js and styles.css alongside a freshly fetched index.html —
 * new markup driven by old code, which is worse than either on its own.
 *
 * Run in CI just before the site is uploaded. The stamp is applied to the copy
 * that is published, not to the copy in the repository: index.html stays
 * readable in git and opening it from disk still works.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = resolve(ROOT, 'index.html');
const ASSETS = ['assets/css/styles.css', 'assets/js/app.js'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  let page = await readFile(PAGE, 'utf8');

  for (const path of ASSETS) {
    const hash = createHash('sha256')
      .update(await readFile(resolve(ROOT, path)))
      .digest('hex')
      .slice(0, 10);

    // Matches the bare path and an already-stamped one, so re-running over an
    // already-stamped page is a no-op rather than a double stamp.
    const ref = new RegExp(`(["'])${escape(path)}(?:\\?v=[0-9a-f]+)?\\1`, 'g');

    // A renamed or re-quoted asset must not fail silently: an unstamped URL
    // would go back to being cached for ten minutes without anyone noticing.
    // Counted rather than inferred from the rewrite, which is a no-op when the
    // file has not changed since the last stamp.
    const found = page.match(ref);
    if (!found) {
      console.error(`stamp-assets: no reference to ${path} found in index.html`);
      process.exitCode = 1;
      return;
    }

    page = page.replace(ref, `$1${path}?v=${hash}$1`);
    console.log(`stamp-assets: ${path} -> ?v=${hash} (${found.length} reference${found.length === 1 ? '' : 's'})`);
  }

  await writeFile(PAGE, page);
}

await main();
