'use strict';

const { app, BrowserWindow, Menu, ipcMain, shell, safeStorage, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const APP_NAME = 'Veil';
const APP_ID = 'com.veil.p2p';

// Portable Windows / AppImage builds keep their data next to the binary when possible.
const portableDirectory = process.env.PORTABLE_EXECUTABLE_DIR || (process.env.APPIMAGE ? path.dirname(process.env.APPIMAGE) : '');
if (portableDirectory) {
  try {
    const portableDataPath = path.join(portableDirectory, 'VeilData');
    fs.mkdirSync(portableDataPath, { recursive: true });
    app.setPath('userData', portableDataPath);
  } catch { /* fall back to the standard user folder */ }
}

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const PAIRINGS_PATH = path.join(app.getPath('userData'), 'pairings.json');
const LEGACY_PAIRING_PATH = path.join(app.getPath('userData'), 'pairing.json');

const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
const SECRET_PATTERN = /^[A-HJ-NP-Z2-9]{24}$/;

// Visible, backup-friendly folder holding the profile, avatar and emojis.
const ACCOUNT_DIR = path.join(app.getPath('userData'), 'account');
const ACCOUNT_JSON = new Set(['profiles', 'emojis']);
const ACCOUNT_FILE = /^(avatars\/(local|remote-[a-z0-9]{10})|emojis\/[a-z0-9_-]{1,24})\.(png|jpg)$/;
const MAX_ACCOUNT_FILE = 6 * 1024 * 1024;

let mainWindow;

function readDefaultSignalUrl() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-config.json'), 'utf8'));
    const value = typeof parsed.signalUrl === 'string' ? parsed.signalUrl.trim() : '';
    return value.includes('YOUR-') ? '' : value;
  } catch { return ''; }
}

function readSettings() {
  const defaultSignalUrl = readDefaultSignalUrl();
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      signalUrl: typeof parsed.signalUrl === 'string' && parsed.signalUrl ? parsed.signalUrl : defaultSignalUrl,
      turnUrl: typeof parsed.turnUrl === 'string' ? parsed.turnUrl : '',
      turnUsername: typeof parsed.turnUsername === 'string' ? parsed.turnUsername : '',
      turnCredential: typeof parsed.turnCredential === 'string' ? parsed.turnCredential : '',
      soundEnabled: parsed.soundEnabled !== false,
      notificationsEnabled: parsed.notificationsEnabled !== false
    };
  } catch {
    return {
      signalUrl: defaultSignalUrl,
      turnUrl: '',
      turnUsername: '',
      turnCredential: '',
      soundEnabled: true,
      notificationsEnabled: true
    };
  }
}

function writeSettings(value) {
  if (!value || typeof value.signalUrl !== 'string' || value.signalUrl.length > 500) {
    throw new Error('Invalid rendezvous service address.');
  }
  let parsed;
  try { parsed = new URL(value.signalUrl.trim()); }
  catch { throw new Error('Enter a valid WebSocket address, for example wss://signal.example.com'); }
  if (!['wss:', 'ws:'].includes(parsed.protocol)) {
    throw new Error('The address must start with wss:// (or ws:// for local testing).');
  }
  if (parsed.protocol === 'ws:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error('Use a secure wss:// address over the Internet. ws:// is for local testing only.');
  }
  const turnUrl = typeof value.turnUrl === 'string' ? value.turnUrl.trim().slice(0, 500) : '';
  if (turnUrl && !/^turns?:[^\s]+$/i.test(turnUrl)) throw new Error('Invalid TURN address. Example: turns:turn.example.com:5349');
  const settings = {
    signalUrl: parsed.toString().replace(/\/$/, ''),
    turnUrl,
    turnUsername: typeof value.turnUsername === 'string' ? value.turnUsername.slice(0, 200) : '',
    turnCredential: typeof value.turnCredential === 'string' ? value.turnCredential.slice(0, 500) : '',
    soundEnabled: value.soundEnabled !== false,
    notificationsEnabled: value.notificationsEnabled !== false
  };
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), { mode: 0o600 });
  return settings;
}

// ---------------------------------------------------------------------------
// Permanent links. The whole list is encrypted with the OS vault when available.
// ---------------------------------------------------------------------------

function sanitizePairing(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const room = String(entry.room || '').toUpperCase();
  const secret = String(entry.secret || '').toUpperCase();
  if (!ROOM_PATTERN.test(room) || !SECRET_PATTERN.test(secret)) return null;
  const name = String(entry.name || 'New connection').slice(0, 40) || 'New connection';
  const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
  return { room, secret, name, createdAt };
}

function readPairingsRaw() {
  try {
    const stored = JSON.parse(fs.readFileSync(PAIRINGS_PATH, 'utf8'));
    let list = [];
    if (stored.enc && typeof stored.data === 'string') {
      if (!safeStorage.isEncryptionAvailable()) return [];
      list = JSON.parse(safeStorage.decryptString(Buffer.from(stored.data, 'base64')));
    } else if (Array.isArray(stored.list)) {
      list = stored.list;
    }
    return Array.isArray(list) ? list.map(sanitizePairing).filter(Boolean) : [];
  } catch {
    return null;
  }
}

function migrateLegacyPairing() {
  try {
    const stored = JSON.parse(fs.readFileSync(LEGACY_PAIRING_PATH, 'utf8'));
    let code = '';
    if (stored.enc && typeof stored.data === 'string') {
      if (!safeStorage.isEncryptionAvailable()) return [];
      code = safeStorage.decryptString(Buffer.from(stored.data, 'base64'));
    } else if (typeof stored.code === 'string') {
      code = stored.code;
    }
    if (code.length !== 34) return [];
    const entry = sanitizePairing({ room: code.slice(0, 10), secret: code.slice(10), name: 'Connection', createdAt: Date.now() });
    return entry ? [entry] : [];
  } catch { return []; }
}

function readPairings() {
  const list = readPairingsRaw();
  if (list === null) {
    const migrated = migrateLegacyPairing();
    if (migrated.length) {
      writePairings(migrated);
      try { fs.rmSync(LEGACY_PAIRING_PATH, { force: true }); } catch { /* ignore */ }
    }
    return migrated;
  }
  return list;
}

function writePairings(list) {
  const clean = list.map(sanitizePairing).filter(Boolean);
  fs.mkdirSync(path.dirname(PAIRINGS_PATH), { recursive: true });
  const payload = safeStorage.isEncryptionAvailable()
    ? { enc: true, data: safeStorage.encryptString(JSON.stringify(clean)).toString('base64') }
    : { enc: false, list: clean };
  fs.writeFileSync(PAIRINGS_PATH, JSON.stringify(payload), { mode: 0o600 });
  return clean;
}

function addPairing(value) {
  const entry = sanitizePairing(value);
  if (!entry) throw new Error('Invalid link code.');
  const list = readPairings();
  const existing = list.findIndex((item) => item.room === entry.room);
  if (existing >= 0) {
    // Same link already saved: refresh the secret but keep the local name.
    list[existing] = { ...list[existing], secret: entry.secret };
  } else {
    list.push(entry);
  }
  return writePairings(list);
}

function removePairing(room) {
  const list = readPairings().filter((item) => item.room !== room);
  return writePairings(list);
}

function renamePairing(room, name) {
  const list = readPairings();
  const entry = list.find((item) => item.room === room);
  if (entry) entry.name = String(name || '').slice(0, 40) || 'New connection';
  return writePairings(list);
}

// ---------------------------------------------------------------------------
// Account files (profile, avatar, emojis)
// ---------------------------------------------------------------------------

function accountPath(relative) {
  const full = path.resolve(ACCOUNT_DIR, relative);
  if (full !== ACCOUNT_DIR && !full.startsWith(ACCOUNT_DIR + path.sep)) throw new Error('Path refused.');
  return full;
}

function atomicWrite(target, data) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, data);
  fs.renameSync(temporary, target);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 900,
    minHeight: 660,
    title: APP_NAME,
    backgroundColor: '#05070d',
    autoHideMenuBar: process.platform !== 'darwin',
    show: false,
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === 'https:') shell.openExternal(url);
    } catch { /* ignore invalid URL */ }
    return { action: 'deny' };
  });
  const localPage = require('node:url').pathToFileURL(path.join(__dirname, 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (event, destination) => {
    if (destination !== localPage) event.preventDefault();
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

// The app needs the microphone and camera for calls; everything else is denied.
function configurePermissions() {
  const ses = require('electron').session.defaultSession;
  const allowed = new Set(['media', 'audioCapture', 'videoCapture', 'notifications', 'clipboard-read', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((webContents, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((webContents, permission) => allowed.has(permission));
}

// Verifies that the IPC call really comes from the app's main page.
function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try { return new URL(frame.url).protocol === 'file:'; } catch { return false; }
}

ipcMain.handle('veil:get-settings', (event) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  return readSettings();
});
ipcMain.handle('veil:save-settings', (event, value) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  return writeSettings(value);
});
ipcMain.handle('veil:list-pairings', (event) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  return readPairings();
});
ipcMain.handle('veil:add-pairing', (event, value) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  return addPairing(value);
});
ipcMain.handle('veil:remove-pairing', (event, room) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  return removePairing(String(room || ''));
});
ipcMain.handle('veil:rename-pairing', (event, room, name) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  return renamePairing(String(room || ''), name);
});
ipcMain.handle('veil:clear-pairings', (event) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  return writePairings([]);
});
ipcMain.handle('veil:account-read-json', (event, name) => {
  if (!isTrustedSender(event) || !ACCOUNT_JSON.has(name)) throw new Error('Unauthorized action.');
  try { return fs.readFileSync(accountPath(`${name}.json`), 'utf8'); } catch { return null; }
});
ipcMain.handle('veil:account-write-json', (event, name, text) => {
  if (!isTrustedSender(event) || !ACCOUNT_JSON.has(name) || typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('Unauthorized action.');
  JSON.parse(text);
  atomicWrite(accountPath(`${name}.json`), text);
  return true;
});
ipcMain.handle('veil:account-read-file', (event, relative) => {
  if (!isTrustedSender(event) || typeof relative !== 'string' || !ACCOUNT_FILE.test(relative)) throw new Error('Unauthorized action.');
  try { return fs.readFileSync(accountPath(relative)); } catch { return null; }
});
ipcMain.handle('veil:account-write-file', (event, relative, data) => {
  if (!isTrustedSender(event) || typeof relative !== 'string' || !ACCOUNT_FILE.test(relative)) throw new Error('Unauthorized action.');
  const bytes = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  if (!bytes.length || bytes.length > MAX_ACCOUNT_FILE) throw new Error('File too large.');
  atomicWrite(accountPath(relative), bytes);
  return true;
});
ipcMain.handle('veil:account-delete-file', (event, relative) => {
  if (!isTrustedSender(event) || typeof relative !== 'string' || !ACCOUNT_FILE.test(relative)) throw new Error('Unauthorized action.');
  try { fs.rmSync(accountPath(relative), { force: true }); } catch { /* ignore */ }
  return true;
});
ipcMain.handle('veil:account-folder', (event) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  fs.mkdirSync(ACCOUNT_DIR, { recursive: true });
  return ACCOUNT_DIR;
});
ipcMain.handle('veil:account-open-folder', async (event) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  fs.mkdirSync(ACCOUNT_DIR, { recursive: true });
  await shell.openPath(ACCOUNT_DIR);
  return true;
});
ipcMain.handle('veil:open-external', async (event, url) => {
  if (!isTrustedSender(event) || typeof url !== 'string') throw new Error('Unauthorized action.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS links are allowed.');
  await shell.openExternal(parsed.toString());
  return { ok: true };
});

ipcMain.handle('veil:notify', (event, payload) => {
  if (!isTrustedSender(event) || !payload || typeof payload !== 'object') throw new Error('Unauthorized action.');
  if (!Notification.isSupported()) return false;
  const title = String(payload.title || APP_NAME).slice(0, 120);
  const body = String(payload.body || '').slice(0, 400);
  const notification = new Notification({
    title,
    body,
    silent: true,
    icon: path.join(__dirname, 'assets', 'icon.png')
  });
  notification.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('veil:open-session', String(payload.sessionId || ''));
  });
  notification.show();
  return true;
});
ipcMain.handle('veil:set-badge', (event, count) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  const value = Math.max(0, Math.min(999, Number(count) || 0));
  try { app.setBadgeCount(value); } catch { /* unsupported */ }
  return true;
});
ipcMain.handle('veil:attention', (event) => {
  if (!isTrustedSender(event)) throw new Error('Unauthorized action.');
  if (!mainWindow || mainWindow.isFocused()) return false;
  try { mainWindow.flashFrame(true); } catch { /* ignore */ }
  return true;
});

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
  configurePermissions();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: APP_NAME, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [{ label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => mainWindow?.webContents.send('veil:open-settings') }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] }
  ]));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
