const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function currentServerUrl() {
  return process.env.FLUENTA_URL || readConfig().serverUrl || '';
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

let win = null;

function createWindow() {
  const bounds = readConfig().bounds || {};
  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 820,
    x: bounds.x,
    y: bounds.y,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#08080a',
    title: 'Fluenta',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    const { width, height, x, y } = win.getBounds();
    writeConfig({ bounds: { width, height, x, y } });
  };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('closed', () => {
    win = null;
  });

  // Links that leave the chat open in the user's browser instead of hijacking the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    const server = currentServerUrl();
    if (!server) return;
    try {
      if (new URL(url).origin !== new URL(server).origin) {
        event.preventDefault();
        shell.openExternal(url);
      }
    } catch {
      /* let Electron decide */
    }
  });

  const server = currentServerUrl();
  if (server && isHttpUrl(server)) {
    win.loadURL(server);
  } else {
    win.loadFile(path.join(__dirname, 'setup.html'));
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: 'Fluenta',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [{ role: process.platform === 'darwin' ? 'close' : 'quit' }],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Server',
      submenu: [
        {
          label: 'Change server…',
          click: () => {
            win?.loadFile(path.join(__dirname, 'setup.html'));
          },
        },
        {
          label: 'Open in browser',
          click: () => {
            const server = currentServerUrl();
            if (server) shell.openExternal(server);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('fluenta:get-server-url', () => currentServerUrl());

ipcMain.handle('fluenta:set-server-url', (_event, rawUrl) => {
  if (typeof rawUrl !== 'string' || !isHttpUrl(rawUrl.trim())) {
    return { ok: false, error: 'Enter a full http:// or https:// address.' };
  }
  const url = rawUrl.trim().replace(/\/$/, '');
  writeConfig({ serverUrl: url });
  if (win) void win.loadURL(url);
  return { ok: true, url };
});

ipcMain.handle('fluenta:reset-server-url', () => {
  const config = readConfig();
  delete config.serverUrl;
  writeConfig(config);
  win?.loadFile(path.join(__dirname, 'setup.html'));
  return { ok: true };
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
