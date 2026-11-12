// Tiến trình chính: cửa sổ, quyền hệ thống, tray, phím tắt và lưu hồ sơ DSP.
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell, dialog, globalShortcut, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const dsp = require('./dsp/engine');

const APP_ID = 'com.taylorn.audio';
const DEFAULT_HOTKEY = 'Ctrl+Alt+F12';
let mainWindow = null;
let tray = null;
let initPromise = Promise.resolve();
let integration = { state: 'loading', message: 'Đang kiểm tra engine âm thanh…' };
let currentProfile = {
  eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  effects: { bass: 0, treble: 0, dialogue: 0, width: 0, balance: 0, reverbEnabled: false, impulsePath: '', compressorEnabled: false, vstPluginPath: '' },
  bypass: false
};
let settings = { launchAtLogin: false, hotkey: DEFAULT_HOTKEY, theme: 'amber', lightMode: false, engineMode: 'apo', inputId: '', outputId: '', bufferMs: 10, autoPresetEnabled: false, appRules: [] };
let knownPresets = [];
let activeAutoPresetId = null;
let writeQueue = Promise.resolve();
let foregroundCheckRunning = false;

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
app.setName('Taylor ND Audio');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function dataFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function finiteClamp(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : 0;
}

function safeAudioPath(value, extension) {
  if (typeof value !== 'string') return '';
  const candidate = value.trim();
  if (!candidate || candidate.length > 2048 || /[\r\n\0]/.test(candidate)) return '';
  return path.extname(candidate).toLowerCase() === extension ? candidate : '';
}

function normalizeProfile(source) {
  const effects = source?.effects && typeof source.effects === 'object' ? source.effects : {};
  const eq = Array.isArray(source?.eq) ? source.eq : [];
  return {
    eq: Array.from({ length: 10 }, (_value, index) => finiteClamp(eq[index], -12, 12)),
    effects: {
      bass: finiteClamp(effects.bass, -12, 12),
      treble: finiteClamp(effects.treble, -12, 12),
      dialogue: finiteClamp(effects.dialogue, -12, 12),
      width: finiteClamp(effects.width, -35, 35),
      balance: finiteClamp(effects.balance, -100, 100),
      reverbEnabled: Boolean(effects.reverbEnabled),
      impulsePath: safeAudioPath(effects.impulsePath, '.wav'),
      compressorEnabled: Boolean(effects.compressorEnabled),
      vstPluginPath: safeAudioPath(effects.vstPluginPath, '.dll')
    },
    bypass: Boolean(source?.bypass)
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function loadSavedData() {
  const savedProfile = readJson(dataFile('profile.json'), null);
  const savedSettings = readJson(dataFile('settings.json'), null);
  knownPresets = readJson(dataFile('known-presets.json'), []);
  if (savedProfile && Array.isArray(savedProfile.eq)) currentProfile = normalizeProfile(savedProfile);
  if (savedSettings && typeof savedSettings === 'object') settings = { ...settings, ...savedSettings };
  settings.engineMode = settings.engineMode === 'taylor' ? 'taylor' : 'apo';
  settings.inputId = typeof settings.inputId === 'string' ? settings.inputId.slice(0, 512) : '';
  settings.outputId = typeof settings.outputId === 'string' ? settings.outputId.slice(0, 512) : '';
  settings.bufferMs = [5, 10, 20].includes(Number(settings.bufferMs)) ? Number(settings.bufferMs) : 10;
  settings.appRules = Array.isArray(settings.appRules) ? settings.appRules.filter((rule) =>
    rule && typeof rule.processName === 'string' && typeof rule.presetId === 'string' && /^[a-z0-9_. -]{1,64}$/i.test(rule.processName)
  ).map((rule) => ({ processName: rule.processName.replace(/\.exe$/i, ''), presetId: rule.presetId })) : [];
}

function publishStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:status', { integration, profile: currentProfile, settings, engineMode: settings.engineMode, engineState: dsp.getStatus(), automationPresetId: activeAutoPresetId });
  }
  rebuildTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 700,
    frame: false,
    show: false,
    backgroundColor: '#0B1020',
    title: 'Taylor ND Audio',
    icon: path.join(__dirname, '..', 'assets', 'taylor-nd-audio.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized', true));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized', false));
  // Đóng cửa sổ xuống tray để bộ xử lý hệ thống và phím tắt vẫn hoạt động.
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      hideToTray();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideToTray() {
  if (!mainWindow) return;
  mainWindow.webContents.send('app:window-hidden');
  mainWindow.hide();
}

function toggleBypass() {
  currentProfile = { ...currentProfile, bypass: !currentProfile.bypass };
  writeJson(dataFile('profile.json'), currentProfile);
  queueProfileWrite(currentProfile).finally(publishStatus);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const template = [
    { label: 'Mở Taylor ND Audio', click: showWindow },
    { label: currentProfile.bypass ? 'Bật xử lý âm thanh' : 'Tắt xử lý (Bypass)', click: toggleBypass },
    { type: 'separator' },
    { label: 'Thoát Taylor ND Audio', click: () => { app.isQuitting = true; app.quit(); } }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'taylor-nd-audio.ico');
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('Taylor ND Audio · Power Your Sound');
  tray.on('click', showWindow);
  rebuildTrayMenu();
}

async function initializeEngine() {
  integration = await dsp.connect(settings.engineMode);
  const result = await queueProfileWrite(currentProfile);
  if (result?.status) integration = result.status;
  publishStatus();
}

function queueProfileWrite(profile) {
  writeQueue = writeQueue.then(async () => {
    const result = await dsp.applyProfile(profile);
    if (result.status) integration = result.status;
    return result;
  }).catch((error) => {
    integration = { state: 'error', message: `Không ghi được cấu hình: ${error.message}` };
    return { ok: false, status: integration };
  });
  return writeQueue;
}

function pollForegroundApplication() {
  if (process.platform !== 'win32' || !settings.autoPresetEnabled || !settings.appRules?.length || foregroundCheckRunning) return;
  foregroundCheckRunning = true;
  const source = [
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class TaylorForegroundWindow {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);',
    '}',
    "'@",
    '$handle = [TaylorForegroundWindow]::GetForegroundWindow()',
    '[uint32]$processId = 0',
    '[void][TaylorForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$processId)',
    'try { (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { }'
  ].join('\n');
  execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', source], { encoding: 'utf8', windowsHide: true, timeout: 2200 }, (error, stdout) => {
    foregroundCheckRunning = false;
    if (error) return;
    const processName = String(stdout || '').trim().split(/\r?\n/).at(-1)?.trim().toLowerCase();
    const rule = settings.appRules.find((item) => String(item.processName || '').trim().replace(/\.exe$/i, '').toLowerCase() === processName);
    if (!rule) {
      if (activeAutoPresetId !== null) { activeAutoPresetId = null; publishStatus(); }
      return;
    }
    if (rule.presetId === activeAutoPresetId) return;
    const preset = knownPresets.find((item) => item.id === rule.presetId);
    if (!preset?.profile) return;
    activeAutoPresetId = preset.id;
    currentProfile = { ...preset.profile, effects: { ...currentProfile.effects, ...(preset.profile.effects || {}) }, bypass: false };
    writeJson(dataFile('profile.json'), currentProfile);
    queueProfileWrite(currentProfile).finally(publishStatus);
  });
}

function registerHotkey(accelerator) {
  const previous = String(settings.hotkey || '').trim();
  globalShortcut.unregisterAll();
  if (!accelerator) return { ok: true };
  const restorePrevious = () => {
    if (previous && previous !== accelerator) {
      try { globalShortcut.register(previous, toggleBypass); } catch { /* Giữ ứng dụng chạy nếu phím cũ cũng không đăng ký được. */ }
    }
  };
  try {
    const registered = globalShortcut.register(accelerator, toggleBypass);
    if (!registered) {
      restorePrevious();
      return { ok: false, message: `Không thể đăng ký phím tắt ${accelerator}. Phím có thể đang được ứng dụng khác sử dụng.` };
    }
    return { ok: true };
  } catch (error) {
    restorePrevious();
    return { ok: false, message: `Phím tắt không hợp lệ: ${error.message}` };
  }
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function restartAsAdministrator() {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, message: 'Chỉ hỗ trợ Windows.' });
  const args = process.argv.slice(1);
  const windowsArguments = args.map((value) => `"${String(value).replace(/(["\\])/g, '\\$1')}"`).join(' ');
  const command = windowsArguments
    ? `Start-Process -FilePath ${quotePowerShell(process.execPath)} -ArgumentList ${quotePowerShell(windowsArguments)} -Verb RunAs`
    : `Start-Process -FilePath ${quotePowerShell(process.execPath)} -Verb RunAs`;
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-EncodedCommand', encoded], { windowsHide: true }, (error) => {
      if (error) return resolve({ ok: false, message: 'Yêu cầu Administrator chưa được chấp thuận hoặc Windows không khởi chạy lại ứng dụng.' });
      app.isQuitting = true;
      app.quit();
      resolve({ ok: true });
    });
  });
}

function installIpcHandlers() {
  ipcMain.handle('app:get-state', async () => {
    await initPromise;
    return { integration, profile: currentProfile, settings, engineMode: settings.engineMode, engineState: dsp.getStatus(), devices: await dsp.listDevices(), automationPresetId: activeAutoPresetId };
  });

  ipcMain.handle('app:check-again', async () => {
    integration = await dsp.connect(settings.engineMode);
    const result = await queueProfileWrite(currentProfile);
    integration = result.status || integration;
    publishStatus();
    return integration;
  });

  ipcMain.handle('profile:apply', async (_event, profile) => {
    if (!profile || !Array.isArray(profile.eq) || !profile.effects) return { ok: false, message: 'Hồ sơ âm thanh không hợp lệ.' };
    currentProfile = normalizeProfile(profile);
    activeAutoPresetId = null;
    writeJson(dataFile('profile.json'), currentProfile);
    const result = await queueProfileWrite(currentProfile);
    publishStatus();
    return result;
  });

  ipcMain.handle('settings:update', async (_event, patch) => {
    const next = { ...settings, ...patch };
    if (Object.hasOwn(patch || {}, 'hotkey')) {
      const result = registerHotkey(String(next.hotkey || '').trim());
      if (!result.ok) return result;
    }
    const modeChanged = next.engineMode !== settings.engineMode;
    settings = next;
    if (Object.hasOwn(patch || {}, 'autoPresetEnabled') || Object.hasOwn(patch || {}, 'appRules')) activeAutoPresetId = null;
    writeJson(dataFile('settings.json'), settings);
    if (modeChanged) {
      integration = await dsp.connect(settings.engineMode);
      const result = await queueProfileWrite(currentProfile);
      integration = result.status || integration;
    }
    publishStatus();
    return { ok: true, settings };
  });

  ipcMain.handle('engine:list-devices', async () => dsp.listDevices());
  ipcMain.handle('engine:start', async (_event, options) => {
    if (settings.engineMode !== 'taylor') return { ok: false, message: 'Hãy chuyển sang Taylor Engine trong Cài đặt trước.' };
    const safeOptions = {
      inputId: String(options?.inputId || settings.inputId || ''),
      outputId: String(options?.outputId || settings.outputId || ''),
      bufferMs: [5, 10, 20].includes(Number(options?.bufferMs ?? settings.bufferMs)) ? Number(options?.bufferMs ?? settings.bufferMs) : 10
    };
    const result = await dsp.start(safeOptions);
    if (result.ok) {
      settings = { ...settings, ...safeOptions };
      writeJson(dataFile('settings.json'), settings);
      const profileResult = await queueProfileWrite(currentProfile);
      if (!profileResult.ok) return profileResult;
    }
    publishStatus();
    return result;
  });
  ipcMain.handle('engine:stop', async () => { const result = await dsp.stop(); publishStatus(); return result; });
  ipcMain.handle('engine:set-bypass', async (_event, bypass) => dsp.setBypass(Boolean(bypass)));
  ipcMain.handle('engine:load-impulse', async (_event, filePath) => {
    const safePath = safeAudioPath(filePath, '.wav');
    return safePath ? dsp.loadImpulse(safePath) : { ok: false, message: 'File impulse WAV không hợp lệ.' };
  });
  ipcMain.handle('engine:open-sound-settings', async () => {
    if (process.platform !== 'win32') return { ok: false, message: 'Chỉ hỗ trợ Windows.' };
    try { await shell.openExternal('ms-settings:sound'); return { ok: true }; }
    catch (error) { return { ok: false, message: `Không mở được cài đặt âm thanh: ${error.message}` }; }
  });

  ipcMain.handle('automation:set-presets', async (_event, presets) => {
    if (!Array.isArray(presets)) return { ok: false };
    knownPresets = presets.filter((item) => item && typeof item.id === 'string' && item.profile && Array.isArray(item.profile.eq))
      .map((item) => ({ id: item.id.slice(0, 100), name: String(item.name || '').slice(0, 48), profile: normalizeProfile(item.profile) }));
    writeJson(dataFile('known-presets.json'), knownPresets);
    return { ok: true };
  });

  ipcMain.handle('settings:set-autostart', async (_event, enabled) => {
    settings.launchAtLogin = Boolean(enabled);
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, openAsHidden: true });
    writeJson(dataFile('settings.json'), settings);
    publishStatus();
    return { ok: true, settings };
  });

  ipcMain.handle('dialog:choose-file', async (_event, kind) => {
    const options = kind === 'impulse'
      ? { title: 'Chọn file impulse response', filters: [{ name: 'Âm thanh WAV', extensions: ['wav'] }] }
      : { title: 'Chọn VST compressor', filters: [{ name: 'Plugin VST2', extensions: ['dll'] }] };
    const result = await dialog.showOpenDialog(mainWindow, { ...options, properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle('app:restart-admin', restartAsAdministrator);
  ipcMain.handle('app:open-external', async (_event, url) => {
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== 'https:') return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch { return false; }
  });

  ipcMain.handle('window:action', (_event, action) => {
    if (!mainWindow) return;
    if (action === 'minimize') mainWindow.minimize();
    if (action === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    if (action === 'close') hideToTray();
  });
}

if (gotLock) app.on('second-instance', showWindow);
if (gotLock) app.whenReady().then(() => {
  loadSavedData();
  createWindow();
  createTray();
  settings.launchAtLogin = app.getLoginItemSettings().openAtLogin || settings.launchAtLogin;
  app.setLoginItemSettings({ openAtLogin: Boolean(settings.launchAtLogin), openAsHidden: true });
  registerHotkey(settings.hotkey || DEFAULT_HOTKEY);

  // Chỉ cấp luồng âm thanh hệ thống cho visualizer; không cấp video và renderer không phát lại luồng.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (request.audioRequested && process.platform === 'win32' && request.frame === mainWindow?.webContents.mainFrame) {
      // Chromium yêu cầu track video cho getDisplayMedia; chỉ cấp frame của chính giao diện.
      callback(request.videoRequested ? { video: request.frame, audio: 'loopback' } : { audio: 'loopback' });
    } else callback(null);
  });

  installIpcHandlers();
  dsp.setUpdateHandler((payload) => {
    if (payload.integration) integration = payload.integration;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('engine:update', payload);
  });
  initPromise = initializeEngine();
  setInterval(pollForegroundApplication, 2500).unref();
  app.on('activate', showWindow);
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  void dsp.disconnect();
});
app.on('window-all-closed', () => {
  // Ứng dụng tiếp tục chạy ở tray cho tới khi người dùng chọn Thoát.
});
