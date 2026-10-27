/**
 * Checks the desktop layout without Electron itself: boots the same LAN server
 * bootstrap the app uses, pointed at `dist/`, and confirms the window would get
 * a playable page.
 *
 *   npm run test:desktop   (needs `npm run build` first)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

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

// --- v1.6.4: the log files a player can send us ---------------------------
{
  const { createLogger } = require('../electron/log.cjs') as {
    createLogger: (options: {
      dir?: string;
      fallbackDir?: string;
      maxBytes?: number;
      keep?: number;
    }) => {
      write: (stream: string, line: unknown) => boolean;
      dir: () => string | null;
      reason: () => string;
      file: (stream: string) => string;
    };
  };

  const scratch = mkdtempSync(join(tmpdir(), 'tankgame-log-'));

  // 1. Plain append.
  const plain = createLogger({ dir: join(scratch, 'log'), fallbackDir: join(scratch, 'fallback') });
  const wrote = plain.write('tankgame-main.log', 'hello from the test');
  const text = readFileSync(join(scratch, 'log', 'tankgame-main.log'), 'utf8');
  check('the logger writes the line it was given', wrote && text.includes('hello from the test'), text.slice(0, 80));
  check('every line is timestamped', /^\d{4}-\d{2}-\d{2}T/.test(text), text.slice(0, 40));

  // 2. Rotation: 512 KB is the production limit, 200 bytes here so the test is quick.
  const rotating = createLogger({ dir: join(scratch, 'rot'), fallbackDir: '', maxBytes: 400, keep: 2 });
  for (let index = 0; index < 60; index += 1) rotating.write('tankgame-renderer.log', `line ${index} ${'x'.repeat(40)}`);
  const rotated = readdirSync(join(scratch, 'rot')).sort();
  check('a full log is rotated, not truncated', rotated.length > 1, rotated.join(','));
  check('only the newest archives are kept', rotated.filter((n) => /-\d+\.log$/.test(n)).length <= 2, rotated.join(','));

  // 3. An unwritable install folder falls back to userData and says why.
  const blocker = join(scratch, 'not-a-folder');
  writeFileSync(blocker, 'x');
  const fallback = createLogger({ dir: join(blocker, 'log'), fallbackDir: join(scratch, 'user', 'log') });
  const fellBack = fallback.write('tankgame-main.log', 'after the fallback');
  check('an unwritable install folder falls back', fellBack && fallback.dir() === join(scratch, 'user', 'log'), String(fallback.dir()));
  check('...and the reason is recorded', fallback.reason().includes('not writable'), fallback.reason());

  // 4. Logging can never be the reason a crash happens.
  let survived = true;
  try {
    const junk = createLogger({ dir: '', fallbackDir: '' });
    junk.write('', undefined);
    junk.write('../../etc/passwd', null);
    junk.write('x'.repeat(500), { toString: () => 'object' });
    (createLogger as unknown as (options: unknown) => { write: (a: unknown, b: unknown) => boolean })(null).write('a', 'b');
  } catch {
    survived = false;
  }
  check('the logger never throws, whatever it is handed', survived);

  // 5. A real crash in the main process lands in the file, and the process still
  //    exits non-zero (logging must not swallow the crash).
  const crashRoot = join(scratch, 'crash');
  mkdirSync(crashRoot, { recursive: true });
  const crash = spawnSync(process.execPath, ['scripts/electron-load-check.cjs', '--crash'], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, TANK_APP_ROOT: crashRoot },
  });
  const crashLog = join(crashRoot, 'log', 'tankgame-main.log');
  const crashText = existsSync(crashLog) ? readFileSync(crashLog, 'utf8') : '';
  check('an uncaught exception is written to the log', crashText.includes('boom-from-test'), crashText.slice(0, 200));
  check('the app still dies after logging it', crash.status === 1, `exit ${crash.status}`);

  rmSync(scratch, { recursive: true, force: true });
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}
console.log(failed ? `desktop FAILED (${failed})` : `desktop ok (${checks.length})`);
if (failed) throw new Error('desktop check failed');
