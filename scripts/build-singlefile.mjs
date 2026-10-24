/**
 * Turns the Vite build into ONE portable HTML file: scripts and styles are
 * inlined, so `release/坦克大作战.html` can be double-clicked on any OS with no
 * install and no server. (LAN play needs the server scripts.)
 *
 * Two details matter here:
 *  - only the tags inside <head> are rewritten, because the bundled Phaser code
 *    itself contains the literal string `<script ... src="/assets/...">`
 *  - `</script` inside the inlined JS is escaped, otherwise the browser would
 *    end the script element early
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not url.pathname: on Windows that would yield "/C:/..." and
// every read below would fail.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = join(root, 'dist-single');
const outDir = join(root, 'release');

const original = await readFile(join(dist, 'index.html'), 'utf8');

const bodyAt = original.indexOf('<body');
if (bodyAt < 0) throw new Error('index.html has no <body>');
let head = original.slice(0, bodyAt);
const rest = original.slice(bodyAt);

const readAsset = async (url) => readFile(join(dist, url.replace(/^\//, '')), 'utf8');

// --- inline scripts
// A classic inline script runs the moment it is parsed, so it has to sit at the
// end of <body>; otherwise the app would query #overlay before it exists.
let inlineScripts = '';
const scriptTags = [...head.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)];
for (const match of scriptTags) {
  const [tag, src] = match;
  const code = (await readAsset(src)).replace(/<\/script/gi, '<\\/script');
  head = head.replace(tag, () => '');
  inlineScripts += `<script>\n${code}\n</script>\n`;
}

// --- inline stylesheets
const linkTags = [...head.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
for (const match of linkTags) {
  const [tag, href] = match;
  if (/^https?:/i.test(href)) continue;
  const css = (await readAsset(href)).replace(/<\/style/gi, '<\\/style');
  head = head.replace(tag, () => `<style>\n${css}\n</style>`);
}

// --- nothing left to preload
head = head.replace(/<link[^>]*rel="modulepreload"[^>]*>/g, '');

let body = rest;
if (inlineScripts) {
  // NB: pass a function, not a string — minified code is full of `$&` / `$1`,
  // which String.replace would expand into the matched text.
  body = body.includes('</body>')
    ? body.replace('</body>', () => `${inlineScripts}</body>`)
    : body + inlineScripts;
}

const html = head + body;

await mkdir(outDir, { recursive: true });
const target = join(outDir, '坦克大作战.html');
await writeFile(target, html, 'utf8');

const leftovers = [...html.matchAll(/(?:src|href)="(?!data:|#|https?:)([^"]+)"/g)].map((m) => m[1]);
const scriptEnds = (html.match(/<\/script>/g) ?? []).length;

console.log(`single file: ${target}`);
console.log(`size: ${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB`);
console.log(`script elements: ${scriptEnds}`);
if (leftovers.length) {
  console.error('warning: still references local files:', leftovers.slice(0, 5));
  process.exitCode = 1;
} else if (scriptEnds !== 1) {
  console.error('warning: expected exactly one script element');
  process.exitCode = 1;
} else {
  console.log('all assets inlined ✔');
}
