/**
 * Can the Electron main process actually load?
 *
 * v1.6.3: 1.6.2 shipped to every desktop user with
 *
 *     Error [ERR_REQUIRE_ESM]: require() of ES Module
 *     …\resources\app\shared\asset-guard.mjs not supported
 *
 * — `electron/updater.cjs` is CommonJS (Electron loads the main process
 * directly, so it has to be) and it used `require()` on the new `.mjs` guard.
 * The throw happened at module load, before any window existed, so the game
 * died on launch and its own updater could never run. Nothing in the suite ever
 * loaded that file, which is why a fully green release was broken.
 *
 * This script closes that hole: it requires the real main-process modules with a
 * stub `electron`, so it needs no Electron binary, no display and no network.
 * `scripts/desktop-test.ts` runs it and also passes
 * `--no-experimental-require-module` on Node ≥ 22, which restores Node 20's
 * rule (the Node that Electron 31 ships) — the exact failure the players saw.
 *
 *   node scripts/electron-load-check.cjs            # exit 0 = the app can start
 */
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
// v1.6.4: the main process now creates `<app>/log` while it loads, so the stub
// points `getAppPath()` at a scratch folder — loading the app must never leave
// files in the checkout. `TANK_APP_ROOT` lets the test inspect what was written.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tankgame-load-'));
const appRoot = process.env.TANK_APP_ROOT || sandbox;
const userData = path.join(sandbox, 'userData');
fs.mkdirSync(userData, { recursive: true });

const noop = () => {};
const app = {
  isPackaged: true,
  getPath: (key) => (key === 'userData' ? userData : path.join(userData, String(key))),
  getAppPath: () => appRoot,
  getVersion: () => require(path.join(root, 'package.json')).version,
  // Never resolves: no window, no LAN server, nothing to clean up afterwards.
  whenReady: () => new Promise(noop),
  on: noop,
  once: noop,
  off: noop,
  quit: noop,
  exit: noop,
  setName: noop,
  setAppUserModelId: noop,
  requestSingleInstanceLock: () => true,
  commandLine: { appendSwitch: noop, appendArgument: noop },
};

const electron = new Proxy(
  {
    app,
    ipcMain: { handle: noop, on: noop, removeHandler: noop },
    Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
    shell: { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop },
    dialog: {
      showMessageBox: async () => ({ response: 0 }),
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
    BrowserWindow: class BrowserWindow {
      constructor() {
        this.webContents = { send: noop, on: noop, setWindowOpenHandler: noop, openDevTools: noop };
      }
      loadURL() {
        return Promise.resolve();
      }
      loadFile() {
        return Promise.resolve();
      }
      on() {}
      once() {}
      show() {}
      focus() {}
      setMenu() {}
    },
  },
  { get: (target, prop) => (prop in target ? target[prop] : noop) }
);

// Electron itself is only available inside Electron; the stub keeps this script
// runnable on a plain Node (CI installs packages without the binary sometimes).
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'electron') return electron;
  return originalLoad.apply(this, arguments);
};

const results = [];
const check = (name, ok, detail) => results.push([name, !!ok, detail]);

async function main() {
  let updater;
  try {
    updater = require(path.join(root, 'electron', 'updater.cjs'));
    check('the updater module loads in the main process', true);
  } catch (error) {
    check('the updater module loads in the main process', false, `${error.code || ''} ${error.message}`.trim());
  }

  // `electron/main.cjs` is the real entry point: if it cannot be loaded, the
  // app cannot start, whatever the rest of the suite says.
  try {
    require(path.join(root, 'electron', 'main.cjs'));
    check('the main process entry point loads', true);
  } catch (error) {
    check('the main process entry point loads', false, `${error.code || ''} ${error.message}`.trim());
  }

  if (updater) {
    const name = await updater.safeAssetName('TankGame-1.6.3-x64-setup.exe');
    check('a plain asset name survives the guard', name === 'TankGame-1.6.3-x64-setup.exe', name);
    const evil = await updater.safeAssetName('..\\..\\evil.exe');
    check('a path in the asset name is still refused', evil === '', evil);

    const repo = 'Adamisatree/TankGame';
    const official = `https://github.com/${repo}/releases/download/v1.6.3/TankGame-1.6.3-x64-setup.exe`;
    check('the official asset URL is still allowed', await updater.isAllowedAssetUrl(official));
    check(
      'a mirror prefix is still allowed',
      await updater.isAllowedAssetUrl(`https://ghfast.top/${official}`)
    );
    check(
      'a mirror wrapping another host is still refused',
      !(await updater.isAllowedAssetUrl('https://ghfast.top/https://attacker.example/x.exe'))
    );

    // The guard has to arrive through `import()`, never `require()`: that is the
    // whole bug. Node ≥ 22 would happily `require()` it and hide the problem.
    const requiredGuard = Object.keys(Module._cache).filter((file) => file.endsWith('asset-guard.mjs'));
    check('the ES-module guard is not loaded through require()', requiredGuard.length === 0, requiredGuard.join(', '));
  }

  // --- v1.6.4: the app opens a log file as soon as it starts.
  const mainLog = path.join(appRoot, 'log', 'tankgame-main.log');
  const mainText = fs.existsSync(mainLog) ? fs.readFileSync(mainLog, 'utf8') : '';
  check('starting the app writes log/tankgame-main.log', mainText.length > 0, mainLog);
  check('the first line names the version and the log folder', /=== TankGame \d+\.\d+\.\d+ started/.test(mainText), mainText.split('\n')[0]);
  check('the crash handlers are installed', process.listenerCount('uncaughtException') >= 1 && process.listenerCount('unhandledRejection') >= 1);

  // `--crash`: throw *after* the checks so the parent can prove a crash still
  // reaches the log file (and that the process still exits non-zero).
  if (process.argv.includes('--crash')) {
    setTimeout(() => {
      throw new Error('boom-from-test');
    }, 5);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

main()
  .catch((error) => check('the loader check itself ran', false, String(error && error.stack ? error.stack : error)))
  .then(() => {
    let failed = 0;
    for (const [name, ok, detail] of results) {
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` — ${detail}` : ''}`);
      if (!ok) failed++;
    }
    if (!process.env.TANK_APP_ROOT) fs.rmSync(sandbox, { recursive: true, force: true });
    console.log(failed ? `electron-load FAILED (${failed})` : `electron-load ok (${results.length})`);
    process.exit(failed ? 1 : 0);
  });
