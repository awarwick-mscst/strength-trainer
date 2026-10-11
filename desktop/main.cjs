'use strict';
const { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { FileStore } = require('./store.cjs');
const APP_URL = 'strength-trainer://app/index.html';
const selfTest = process.argv.includes('--self-test');
const testDirectory = process.argv.find(value => value.startsWith('--self-test-dir='))?.slice('--self-test-dir='.length);
if (selfTest && !testDirectory) throw new Error('Self-test requires a separate --self-test-dir.');
app.setPath('userData', selfTest ? path.resolve(testDirectory) : path.join(app.getPath('appData'), 'StrengthTrainer'));
protocol.registerSchemesAsPrivileged([{ scheme: 'strength-trainer', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
let window;

function trusted(event) { return event.sender === window?.webContents && event.senderFrame?.url === APP_URL; }
function makeWindow() {
  window = new BrowserWindow({
    width: 1050, height: 850, minWidth: 390, minHeight: 600,
    title: 'Strength Trainer', backgroundColor: '#101418', show: !selfTest,
    icon: path.join(__dirname, 'resources', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: selfTest },
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.on('closed', () => { window = null; });
  return window.loadURL(APP_URL);
}

async function main() {
  await app.whenReady();
  const store = new FileStore(app.getPath('userData'));
  const assets = app.isPackaged ? path.join(process.resourcesPath, 'ui') : path.join(__dirname, '..', 'public');
  const allowedAssets = new Set(fs.readdirSync(assets).filter(name => fs.statSync(path.join(assets, name)).isFile()));
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
  protocol.handle('strength-trainer', request => {
    const url = new URL(request.url), file = url.pathname.slice(1);
    if (url.host !== 'app' || !allowedAssets.has(file)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(path.join(assets, file)), { headers: {
      'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-src 'none'",
    } });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  ipcMain.on('strength-storage', (event, method, ...args) => {
    try {
      if (!trusted(event) || !['getItem', 'setItem', 'removeItem', 'commitWorkout'].includes(method)) throw new Error('Storage access denied.');
      event.returnValue = { ok: true, value: store[method](...args) ?? null };
    } catch (error) { event.returnValue = { ok: false, error: error.message }; }
  });
  ipcMain.handle('strength-export', async (event, filename, data) => {
    if (!trusted(event)) throw new Error('Export access denied.');
    if (typeof filename !== 'string' || !/^strength-trainer-\d{4}-\d{2}-\d{2}\.xlsx$/.test(filename) || !(data instanceof Uint8Array) || data.length > 50 * 1024 * 1024) throw new Error('Invalid Excel export.');
    const bytes = Buffer.from(data);
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid workbook.');
    const result = selfTest ? { canceled: false, filePath: path.join(app.getPath('userData'), 'export-test.xlsx') } : await dialog.showSaveDialog(window, {
      title: 'Save workout data as Excel', defaultPath: path.join(app.getPath('documents'), filename), filters: [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.writeFile(result.filePath, bytes);
    return { canceled: false };
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Export Excel…', click: () => window?.webContents.executeJavaScript("tab = 'settings'; render(); document.querySelector('#view .primary-btn').click()") }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]));
  await makeWindow();
  if (selfTest) await runSelfTest();
  else app.on('activate', () => { if (!window) makeWindow(); });
}

async function runSelfTest() {
  const evaluate = expression => window.webContents.executeJavaScript(expression);
  const wait = async expression => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Desktop test condition failed: ' + expression);
  };
  await wait("typeof state !== 'undefined' && state !== null");
  if (!await evaluate('isDesktop && isLocal && !isAndroid')) throw new Error('Desktop mode did not initialize.');
  const saved = await evaluate("({count: JSON.parse(StrengthDesktop.getItem('strength-trainer-data-v1') || '{\"workouts\":[]}').workouts.length, weight: state.lifts.squat.weight})");
  await evaluate("startSession(); session.timer.runningSince -= 60000; cycleSet(0, 0)");
  await window.loadURL(APP_URL);
  await wait('session !== null && state !== null');
  if (!await evaluate('session.exercises[0].reps[0] === 5 && StrengthTimer.elapsed(session.timer) >= 60000')) throw new Error('Active workout did not persist.');
  await evaluate("document.querySelector('.timer-button').click()");
  await window.loadURL(APP_URL);
  await wait('session !== null && state !== null');
  if (!await evaluate('session.timer.runningSince === null')) throw new Error('Paused timer did not persist.');
  await evaluate("for (let e=0;e<3;e++) for(let s=0;s<5;s++) if(session.exercises[e].reps[s]===null) cycleSet(e,s); finishWorkout()");
  await wait('session === null && !finishing');
  if (!await evaluate(`state.lifts.squat.weight === ${saved.weight + 5}`)) throw new Error('Progression was not saved.');
  await window.loadURL(APP_URL);
  await wait('state !== null');
  const history = await evaluate("api('/api/workouts')");
  if (history.length !== saved.count + 1 || history[0].durationSeconds < 60) throw new Error('Completed workout did not persist.');
  await evaluate("tab = 'settings'; render(); document.querySelector('#view .primary-btn').click()");
  await wait("document.querySelector('#view .primary-btn').disabled === false");
  if (!fs.existsSync(path.join(app.getPath('userData'), 'export-test.xlsx'))) throw new Error('Excel export was not saved.');
  await new Promise(resolve => setTimeout(resolve, 500));
  const screenshot = await window.webContents.capturePage();
  fs.writeFileSync(path.join(app.getPath('userData'), 'desktop-test.png'), screenshot.toPNG());
  fs.writeFileSync(path.join(app.getPath('userData'), 'self-test-result.json'), JSON.stringify({ passed: true, workoutCount: history.length, durationSeconds: history[0].durationSeconds, packaged: app.isPackaged }));
  app.quit();
}

app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !selfTest) app.quit(); });
if (ownsLock) main().catch(error => {
  if (selfTest) {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'self-test-result.json'), JSON.stringify({ passed: false, error: error.stack }));
  } else dialog.showErrorBox('Could not open Strength Trainer', error.message + '\nYour stored workout file has not been replaced.');
  app.exit(1);
});
