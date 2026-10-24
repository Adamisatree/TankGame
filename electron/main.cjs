/**
 * Desktop shell.
 *
 * Starts the bundled LAN server (so "创建房间" is literally one click and the
 * page is same-origin with the WebSocket), then shows the game in a window.
 *
 * Kept as CommonJS because Electron loads the main process directly and the
 * rest of the project is ESM.
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const { startLanServer } = require('./lan-boot.cjs');

const DEV_URL = process.env.TANK_DEV_URL; // set to http://localhost:5173 while developing the UI
let serverHandle = null;
let win = null;

async function startServer() {
  const appRoot = app.isPackaged ? app.getAppPath() : path.join(__dirname, '..');
  // 8787 first, then a few neighbours, and finally any free port.
  return startLanServer({ appRoot });
}

function buildMenu(port) {
  const lanUrl = port ? `http://${require('node:os').hostname()}:${port}` : '';
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
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const url = DEV_URL ?? `http://127.0.0.1:${serverHandle.port}/`;
  await win.loadURL(url);
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(async () => {
  try {
    serverHandle = await startServer();
    console.log(`[desktop] LAN server on port ${serverHandle.port}`);
  } catch (err) {
    dialog.showErrorBox('无法启动局域网服务', String(err));
  }
  buildMenu(serverHandle?.port ?? 0);
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void serverHandle?.close();
});
