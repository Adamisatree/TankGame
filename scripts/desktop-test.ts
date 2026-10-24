/**
 * Checks the desktop layout without Electron itself: boots the same LAN server
 * bootstrap the app uses, pointed at `dist/`, and confirms the window would get
 * a playable page.
 *
 *   npm run test:desktop   (needs `npm run build` first)
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { startLanServer } = require('../electron/lan-boot.cjs') as {
  startLanServer: (o: { appRoot: string; ports?: number[] }) => Promise<{
    port: number;
    addresses: string[];
    close: () => Promise<void>;
  }>;
};

const checks: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail]);

const appRoot = resolve('.');
const handle = await startLanServer({ appRoot, ports: [0] });
const base = `http://127.0.0.1:${handle.port}`;

check('the desktop bootstrap picks a port', handle.port > 0, String(handle.port));
check('it reports LAN addresses', Array.isArray(handle.addresses), JSON.stringify(handle.addresses));

const page = await fetch(`${base}/`);
const html = await page.text();
check('the window would load the game page', page.ok && html.includes('坦克大作战'), `${page.status}`);

const info = await fetch(`${base}/info`).then((r) => r.json() as Promise<Record<string, unknown>>);
check('the info endpoint answers', typeof info.port === 'number', JSON.stringify(info));

const asset = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
if (asset) {
  const res = await fetch(`${base}${asset}`);
  check('the game bundle is served', res.ok && (await res.text()).length > 100_000, `${res.status}`);
} else {
  check('the game bundle is served', false, 'no asset reference found');
}

// Ports must not fight: a second launch should fall through to the next port.
const second = await startLanServer({ appRoot, ports: [handle.port, 0] });
check('a second instance finds another port', second.port !== handle.port, `${second.port} vs ${handle.port}`);
await second.close();

await handle.close();
check('shutting down releases the port', await fetch(`${base}/`).then(() => false).catch(() => true));

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `desktop FAILED (${failed})` : `desktop ok (${checks.length})`);
if (failed) throw new Error('desktop check failed');
