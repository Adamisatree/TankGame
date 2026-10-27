/**
 * Checks the desktop layout without Electron itself: boots the same LAN server
 * bootstrap the app uses, pointed at `dist/`, and confirms the window would get
 * a playable page.
 *
 *   npm run test:desktop   (needs `npm run build` first)
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';

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

// --- v1.6.2: the update path must not launch anything it was told to fetch.
{
  // The guards are pure (shared/asset-guard.mjs), so they can be checked without
  // an Electron binary — which is also why they live there now.
  const guard = (await import('../shared/asset-guard.mjs')) as unknown as {
    safeAssetName: (name: unknown) => string;
    assetUrlAllowed: (url: string, options: { hosts: string[]; repo: string }) => boolean;
  };
  const mirrors = JSON.parse(readFileSync(resolve('mirrors.json'), 'utf8')) as { mirrors: { prefix: string }[] };
  const hosts = [
    'github.com',
    'objects.githubusercontent.com',
    ...mirrors.mirrors.map((m) => new URL(m.prefix).hostname),
  ];
  const repo = 'Adamisatree/TankGame';
  const allowed = (url: string): boolean => guard.assetUrlAllowed(url, { hosts, repo });

  check('a plain asset name is accepted', guard.safeAssetName('TankGame-1.6.2-x64-setup.exe') === 'TankGame-1.6.2-x64-setup.exe');
  check('a windows path in the asset name is refused', guard.safeAssetName('..\\..\\evil.exe') === '', guard.safeAssetName('..\\..\\evil.exe'));
  check('a posix path in the asset name is refused', guard.safeAssetName('../../evil.exe') === '');
  check('a name that is just dots is refused', guard.safeAssetName('..') === '');

  const official = `https://github.com/${repo}/releases/download/v1.6.2/TankGame-1.6.2-x64-setup.exe`;
  check('the official asset URL is allowed', allowed(official));
  check('a mirror prefix in front of the official URL is allowed', allowed(`https://ghfast.top/${official}`));
  check(
    'a mirror prefix in front of *another* host is refused',
    !allowed('https://ghfast.top/https://attacker.example/x.exe')
  );
  check('an unrelated host is refused', !allowed('https://attacker.example/x.exe'));
  check(
    'a lookalike repository path is refused',
    !allowed('https://github.com/Adamisatree/TankGame-evil/releases/download/v1/TankGame.exe')
  );
  check('plain http is refused', !allowed(`http://github.com/${repo}/releases/download/v1/x.exe`));
}

// --- v1.6.3: the app itself must be able to start -----------------------
{
  // 1.6.2 shipped with `require('../shared/asset-guard.mjs')` in a CommonJS
  // main-process file. On the Node inside Electron that is a load-time
  // ERR_REQUIRE_ESM, so every desktop user got a crash instead of a game — and
  // nothing here loaded that file, which is how a green suite shipped it.
  const offenders: string[] = [];
  const scan = (dir: string): void => {
    for (const entry of readdirSync(resolve(dir), { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') scan(full);
        continue;
      }
      if (!/\.(cjs|js)$/.test(entry.name)) continue;
      const hit = readFileSync(full, 'utf8').match(/require\(\s*['"][^'"]+\.mjs['"]\s*\)/);
      if (hit) offenders.push(`${relative('.', full)}: ${hit[0]}`);
    }
  };
  for (const dir of ['electron', 'server', 'shared', 'scripts']) scan(dir);
  check('no CommonJS file requires an ES module', offenders.length === 0, offenders.join('; '));

  // 2. Actually load the main-process modules (stub `electron`, no binary).
  //    `--no-experimental-require-module` restores Node 20's rule on Node ≥ 22,
  //    where `require()` of ESM would otherwise silently work and hide it again.
  const major = Number(process.versions.node.split('.')[0]);
  const flags = major >= 22 ? ['--no-experimental-require-module'] : [];
  const run = spawnSync(process.execPath, [...flags, 'scripts/electron-load-check.cjs'], {
    cwd: resolve('.'),
    encoding: 'utf8',
  });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failures = output
    .split('\n')
    .filter((line) => line.includes('FAIL'))
    .map((line) => line.trim())
    .join(' | ');
  check(
    'the main process loads (updater.cjs + main.cjs)',
    run.status === 0 && output.includes('electron-load ok'),
    failures || `exit ${run.status}`
  );
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `desktop FAILED (${failed})` : `desktop ok (${checks.length})`);
if (failed) throw new Error('desktop check failed');
