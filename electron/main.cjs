/**
 * Desktop shell.
 *
 * Starts the bundled LAN server (so "创建房间" is literally one click and the
 * page is same-origin with the WebSocket), then shows the game in a window.
 *
 * Kept as CommonJS because Electron loads the main process directly and the
 * rest of the project is ESM.
 */
const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { startLanServer } = require('./lan-boot.cjs');
const { startBeacon, scanForHosts, localIPv4 } = require('./discovery.cjs');
const updater = require('./updater.cjs');
const { createLogger } = require('./log.cjs');
const { pathToFileURL: toFileUrl } = require('node:url');

const DEV_URL = process.env.TANK_DEV_URL; // set to http://localhost:5173 while developing the UI
let serverHandle = null;
let win = null;
let beacon = null;

// ---------------------------------------------------------------- local logs
//
// v1.6.4: every "it just froze" report needs a file to look at. The log folder
// sits inside the installation (`<app>\log`) so a player can find it without
// digging through AppData; if the install is read-only we fall back to
// `userData\log` and say so in the first line (see electron/log.cjs).
const APP_ROOT = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
const logs = createLogger({
  dir: path.join(APP_ROOT, 'log'),
  fallbackDir: path.join(app.getPath('userData'), 'log'),
});

function writeLog(stream, line) {
  return logs.write(stream, line);
}

function startupBanner() {
  const where = logs.dir() ?? '(nowhere writable)';
  const why = logs.reason();
  writeLog(
    'tankgame-main.log',
    `=== TankGame ${app.getVersion()} started · pid ${process.pid} · ${process.platform} · ` +
      `electron ${process.versions.electron ?? '-'} · node ${process.versions.node} · log ${where}` +
      (why ? ` (${why})` : '') +
      ' ==='
  );
}

startupBanner();

// A crash has to be *recorded* before the process goes away. Node's default for
// an uncaught exception is to exit; keeping that behaviour (rather than silently
// continuing in a half-dead main process) is what the player expects. The write
// is synchronous, so the line is on disk before exit(1).
process.on('uncaughtException', (error) => {
  writeLog('tankgame-main.log', `[main-crash] ${error && error.stack ? error.stack : String(error)}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  writeLog('tankgame-main.log', `[main-rejection] ${reason && reason.stack ? reason.stack : String(reason)}`);
});

// "The picture stopped moving but the window is alive" is not a JS error and not
// a crash: the renderer stops answering. The renderer sends a heartbeat every
// second with the scene phase, so this log line says *where* it stopped.
const FREEZE_MS = 12_000;
let lastHeartbeat = Date.now();
let lastState = 'unknown';
let freezeLoggedAt = 0;

setInterval(() => {
  try {
    if (!win || win.isDestroyed() || !lastState) return;
    const idle = Date.now() - lastHeartbeat;
    if (idle < FREEZE_MS) return;
    // Once a minute while it stays stuck, not four times per second.
    if (Date.now() - freezeLoggedAt < 60_000) return;
    freezeLoggedAt = Date.now();
    writeLog(
      'tankgame-main.log',
      `[freeze] renderer silent for ${Math.round(idle / 1000)}s — last state: ${lastState}`
    );
  } catch {
    /* a watchdog must never be the reason for a crash */
  }
}, 3000).unref();

ipcMain.on('log:heartbeat', (_event, state) => {
  lastHeartbeat = Date.now();
  lastState = typeof state === 'string' ? state.slice(0, 300) : '';
});

ipcMain.on('log:write', (_event, entry) => {
  const item = entry && typeof entry === 'object' ? entry : {};
  const clip = (value, max) => String(value ?? '').slice(0, max);
  writeLog(
    'tankgame-renderer.log',
    `[${clip(item.level, 16) || 'error'}] ${clip(item.source, 64) || 'renderer'} ${clip(item.message, 2000)} ${clip(item.stack, 8000)}`
  );
});

ipcMain.handle('log:path', () => ({ dir: logs.dir() ?? '', reason: logs.reason() }));

ipcMain.handle('log:reveal', async () => {
  const dir = logs.dir();
  if (!dir) return false;
  await shell.openPath(dir);
  return true;
});

async function startServer() {
  // 8787 first, then a few neighbours, and finally any free port.
  return startLanServer({
    appRoot: APP_ROOT,
    logLine: (line) => writeLog('tankgame-server.log', line),
  });
}

function buildMenu(port) {
  // Same address the in-game banner shows: a real IPv4, not the machine name.
  const lanUrl = port ? `http://${localIPv4()}:${port}` : '';
  const template = [
    {
      label: '游戏',
      submenu: [
        { label: '重新开始', accelerator: 'CmdOrCtrl+R', click: () => win?.webContents.reload() },
        { type: 'separator' },
        { label: '全屏', accelerator: 'F11', click: () => win?.setFullScreen(!win.isFullScreen()) },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '联机',
      submenu: [
        {
          label: '复制局域网地址',
          click: () => {
            const { clipboard } = require('electron');
            clipboard.writeText(lanUrl);
          },
        },
        { label: `本机服务端口：${port ?? '-'}`, enabled: false },
      ],
    },
    {
      label: '帮助',
      submenu: [{ label: '项目主页', click: () => shell.openExternal('https://github.com/Adamisatree/TankGame') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f3ead9',
    title: '坦克大作战',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // v1.5.4: the host window is the referee — Chromium throttles a hidden
      // window to ~1 fps, which used to freeze the whole room the moment the
      // host alt-tabbed. A desktop host must keep simulating while backgrounded.
      backgroundThrottling: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // `startServer()` may have failed (port taken, permissions); reading
  // `serverHandle.port` then threw a null dereference on top of the dialog that
  // had already explained the real problem.
  const url = DEV_URL ?? (serverHandle ? `http://127.0.0.1:${serverHandle.port}/` : 'about:blank');
  await win.loadURL(url);
  win.once('ready-to-show', () => win.show());
}

/** Runs a manifest check and pings the renderer if something newer exists. */
async function autoCheckForUpdates() {
  try {
    const result = await updater.fetchManifest({});
    if (!result.manifest || !win || win.isDestroyed()) return;
    const core = await import(toFileUrl(path.join(__dirname, '..', 'shared', 'update-core.mjs')).href);
    const latest = core.latestRelease(result.manifest);
    const settings = await updater.readSettings();
    if (!latest || !core.isNewer(latest.version, app.getVersion())) return;
    if (latest.version === settings.skippedVersion) return;
    win.webContents.send('update:available', { version: latest.version, notes: latest.notes });
  } catch {
    /* offline: nothing to do */
  }
}

app.whenReady().then(async () => {
  try {
    serverHandle = await startServer();
    beacon = startBeacon(serverHandle.port);
    console.log(`[desktop] LAN server on port ${serverHandle.port}`);
    writeLog('tankgame-main.log', `[lan] server on port ${serverHandle.port}`);
  } catch (err) {
    writeLog('tankgame-main.log', `[lan] server failed to start: ${err && err.stack ? err.stack : String(err)}`);
    dialog.showErrorBox('无法启动局域网服务', String(err));
  }
  buildMenu(serverHandle?.port ?? 0);
  await createWindow();

  // Quiet background check a few seconds after launch, then every 6 hours.
  const settings = await updater.readSettings();
  if (settings.autoCheck) {
    setTimeout(() => void autoCheckForUpdates(), 6000);
    setInterval(() => void autoCheckForUpdates(), 6 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------- updater IPC

/** Cached download so "install" doesn't have to re-fetch the file. */
let pendingInstall = null;

async function updateInfo() {
  const settings = await updater.readSettings();
  const { mirrors, rawMirrors } = await updater.readMirrors();
  return {
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    autoCheck: settings.autoCheck,
    mirrorId: settings.mirrorId,
    skippedVersion: settings.skippedVersion,
    lastCheckAt: settings.lastCheckAt,
    mirrors,
    rawMirrors,
    repo: 'Adamisatree/TankGame',
  };
}

ipcMain.handle('update:info', () => updateInfo());

ipcMain.handle('update:check', async (_event, options) => {
  const result = await updater.fetchManifest(options || {});
  const settings = await updater.readSettings();
  // v1.6.2: `cachedManifest` had no writer at all, so 镜像测速 always probed the
  // raw manifest instead of a real installer URL (D3) — it ranked mirrors by the
  // wrong upstream. Store the manifest that just worked.
  await updater.writeSettings({
    ...settings,
    lastCheckAt: Date.now(),
    cachedManifest: result.manifest ?? settings.cachedManifest ?? null,
  });
  if (!result.manifest) return { ok: false, errors: result.errors };

  const core = await import(toFileUrl(path.join(__dirname, '..', 'shared', 'update-core.mjs')).href);
  const latest = core.latestRelease(result.manifest);
  return {
    ok: true,
    current: app.getVersion(),
    manifest: result.manifest,
    source: result.source,
    errors: result.errors,
    latest,
    upToDate: !latest || !core.isNewer(latest.version, app.getVersion()),
    assets: latest ? latest.assets : [],
  };
});

ipcMain.handle('update:probe', async (event) => {
  const result = await updater.probeMirrors((entry) => {
    try {
      event.sender.send('update:probe-progress', entry);
    } catch {
      /* window gone */
    }
  });
  return result;
});

ipcMain.handle('update:download', async (event, payload) => {
  const { assetName: rawName, url: givenUrl, version, sha256: rawSha, size } = payload || {};
  if (!rawName || !version) return { ok: false, error: 'missing asset' };
  // v1.6.2: the manifest is fetched over the network, so its values are input,
  // not trust. A `name` of `..\..\evil.exe` was written outside the version store.
  // v1.6.3: the guard lives in an ES module, so this is a dynamic import now.
  const assetName = await updater.safeAssetName(rawName);
  if (!assetName) return { ok: false, error: '安装包文件名不合法' };
  // Only a real sha256 is worth comparing; a dirty value made every mirror
  // report a mismatch (D5).
  const sha256 = typeof rawSha === 'string' && /^[0-9a-f]{64}$/i.test(rawSha) ? rawSha.toLowerCase() : '';

  const core = await import(toFileUrl(path.join(__dirname, '..', 'shared', 'update-core.mjs')).href);
  const url = givenUrl || `${core.OFFICIAL.releaseDownload}/v${version}/${assetName}`;
  // The renderer (or a tampered manifest) must not be able to aim this at an
  // arbitrary host: only GitHub and the mirrors we ship may serve an installer.
  if (!(await updater.isAllowedAssetUrl(url))) {
    return { ok: false, error: '这个下载地址不在信任列表里（只认 GitHub 和 mirrors.json 里的镜像）' };
  }
  let lastEmit = 0;
  const result = await updater.ensureDownloaded(url, { name: assetName, sha256: sha256 || undefined }, {
    onProgress: ({ received, total }) => {
      const now = Date.now();
      if (now - lastEmit < 120 && received !== total) return;
      lastEmit = now;
      try {
        event.sender.send('update:progress', {
          assetName,
          received,
          total: total || size || 0,
          ratio: total ? received / total : 0,
        });
      } catch {
        /* window gone */
      }
    },
  });

  if (!result.ok) return { ok: false, errors: result.errors };
  pendingInstall = {
    path: result.path,
    // Keep the digest so the install step can check the bytes again (D2).
    asset: { name: assetName, kind: core.classifyAsset(assetName).kind, sha256: sha256 || undefined },
    verified: !!result.verified,
  };
  return {
    ok: true,
    path: result.path,
    sha256: result.sha256,
    cached: !!result.cached,
    verified: !!result.verified,
    source: result.source,
    errors: result.errors,
  };
});

// v1.6.2: a double click used to spawn the installer twice.
let installing = false;
ipcMain.handle('update:install', async (_event, payload) => {
  if (installing) return { ok: false, error: '正在启动安装程序，请稍候' };
  if (!pendingInstall) return { ok: false, error: '还没有下载好的安装包' };
  // An installer we could not verify only runs if the player said so.
  if (!pendingInstall.verified && !payload?.allowUnverified) {
    return { ok: false, error: 'unverified' };
  }
  try {
    installing = true;
    const result = await updater.installDownloaded(pendingInstall.path, pendingInstall.asset);
    if (result.launched === false) return { ok: false, error: result.error ?? '安装失败' };
    return { ok: true, ...result };
  } finally {
    installing = false;
  }
});

ipcMain.handle('update:local', async () => ({
  dir: updater.versionsDir(),
  versions: await updater.localVersions(),
}));

ipcMain.handle('update:install-file', async (_event, payload) => {
  // v1.6.2: resolve first. The old check compared the *raw* string, so
  // `…/versions\..\..\evil.exe` started with the allowed prefix and walked out.
  const filePath = path.resolve(String(payload?.path ?? ''));
  // Only ever launch something from our own version store. The separator
  // matters: `…/versions-x/evil.exe` is not inside `…/versions` (D4).
  const dir = path.resolve(updater.versionsDir());
  const separator = path.sep;
  const inside = filePath.startsWith(dir.endsWith(separator) ? dir : `${dir}${separator}`);
  if (!inside || filePath.includes(`..${separator}`) || !path.basename(filePath).match(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)) {
    return { ok: false, error: '未知的安装包路径' };
  }
  const asset = {
    name: path.basename(filePath),
    kind: (await import(toFileUrl(path.join(__dirname, '..', 'shared', 'update-core.mjs')).href)).classifyAsset(filePath).kind,
  };
  // Switching to a version already in the archive is itself the player's
  // consent (they clicked that exact build), so no extra prompt here.
  if (installing) return { ok: false, error: '正在启动安装程序，请稍候' };
  pendingInstall = { path: filePath, asset, verified: false };
  try {
    installing = true;
    const result = await updater.installDownloaded(filePath, asset);
    if (result.launched === false) return { ok: false, error: result.error ?? '安装失败' };
    return { ok: true, ...result };
  } finally {
    installing = false;
  }
});

ipcMain.handle('update:reveal', async (_event, filePath) => {
  await updater.openFolder(filePath || pendingInstall?.path || app.getPath('downloads'));
  return true;
});

ipcMain.handle('update:settings', async (_event, patch) => {
  const settings = await updater.readSettings();
  const next = { ...settings, ...(patch || {}) };
  await updater.writeSettings(next);
  return next;
});

ipcMain.handle('update:open-release', async (_event, version) => {
  const core = await import(toFileUrl(path.join(__dirname, '..', 'shared', 'update-core.mjs')).href);
  const url = version ? `${core.OFFICIAL.releasePage}/tag/v${version}` : core.OFFICIAL.releasePage;
  await shell.openExternal(url);
  return true;
});

// A guest can find rooms without typing an IP address.
ipcMain.handle('lan:scan', async () => {
  try {
    return await scanForHosts(1300);
  } catch {
    return [];
  }
});

app.on('before-quit', () => {
  beacon?.close();
  void serverHandle?.close();
});
