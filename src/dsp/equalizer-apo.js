// Adapter Equalizer APO: phát hiện cài đặt, gắn Include một lần và ghi file DSP riêng.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const INCLUDE_NAME = 'taylor-nd-audio.txt';
const FALLBACK_CONFIG_DIR = 'C:\\Program Files\\EqualizerAPO\\config';
const FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function readConfigPathFromRegistry() {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg.exe', [
      'query', 'HKLM\\SOFTWARE\\EqualizerAPO', '/v', 'ConfigPath'
    ], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const match = output.match(/\bConfigPath\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)\s*$/im);
    if (!match) return null;
    let value = match[1].trim();
    value = value.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
    return value;
  } catch {
    return null;
  }
}

function findConfigDirectory() {
  const registryPath = readConfigPathFromRegistry();
  const candidates = [];
  if (registryPath) {
    candidates.push(registryPath);
    candidates.push(path.join(registryPath, 'config'));
    if (path.basename(registryPath).toLowerCase() === 'config') {
      candidates.unshift(registryPath);
    }
  }
  candidates.push(FALLBACK_CONFIG_DIR);

  for (const candidate of [...new Set(candidates)]) {
    const configDir = path.resolve(candidate);
    if (fs.existsSync(path.join(configDir, 'config.txt'))) {
      return { configDir, source: registryPath && configDir.startsWith(path.resolve(registryPath)) ? 'registry' : 'fallback' };
    }
  }
  return null;
}

function ensureInclude(configDir) {
  const configFile = path.join(configDir, 'config.txt');
  const backupFile = path.join(configDir, 'config.txt.taylor-nd-audio.bak');
  if (!fs.existsSync(configFile)) throw new Error('Không tìm thấy config.txt của Equalizer APO.');

  // Chỉ lưu bản sao đầu tiên, không ghi đè bản backup của người dùng ở các lần chạy sau.
  if (!fs.existsSync(backupFile)) {
    fs.copyFileSync(configFile, backupFile, fs.constants.COPYFILE_EXCL);
  }

  const contents = fs.readFileSync(configFile, 'utf8');
  const alreadyIncluded = contents.split(/\r?\n/).some((line) =>
    /^\s*Include\s*:\s*['"]?taylor-nd-audio\.txt['"]?\s*$/i.test(line)
  );
  if (!alreadyIncluded) {
    const separator = contents.length === 0 || /(?:\r?\n)$/.test(contents) ? '' : '\r\n';
    fs.writeFileSync(configFile, `${contents}${separator}Include: ${INCLUDE_NAME}\r\n`, 'utf8');
  }
  return { configFile, backupFile, includeAdded: !alreadyIncluded };
}

function number(value, min, max, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function format(value) {
  const rounded = Math.round(value * 100) / 100;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function activeFilters(profile) {
  const filters = [];
  const eq = Array.isArray(profile.eq) ? profile.eq : [];
  FREQUENCIES.forEach((frequency, index) => {
    const gain = number(eq[index], -12, 12);
    if (gain !== 0) filters.push({ type: 'PK', frequency, gain, q: 1.41 });
  });
  const effects = profile.effects || {};
  const bass = number(effects.bass, -12, 12);
  const treble = number(effects.treble, -12, 12);
  const dialogue = number(effects.dialogue, -12, 12);
  if (bass !== 0) filters.push({ type: 'LSC', frequency: 100, gain: bass, q: Math.SQRT1_2 });
  if (treble !== 0) filters.push({ type: 'HSC', frequency: 8000, gain: treble, q: Math.SQRT1_2 });
  if (dialogue !== 0) filters.push({ type: 'PK', frequency: 2500, gain: dialogue, q: 1 });
  return filters;
}

function biquadCoefficients(filter, sampleRate) {
  const w0 = 2 * Math.PI * filter.frequency / sampleRate;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const A = Math.pow(10, filter.gain / 40);
  let b0, b1, b2, a0, a1, a2;
  if (filter.type === 'PK') {
    const alpha = sin / (2 * filter.q);
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  } else {
    // RBJ low/high shelf xấp xỉ các shelf LSC/HSC dùng trong file Equalizer APO.
    const slope = 1;
    const alpha = sin / 2 * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2);
    const beta = 2 * Math.sqrt(A) * alpha;
    if (filter.type === 'LSC') {
      b0 = A * ((A + 1) - (A - 1) * cos + beta);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - beta);
      a0 = (A + 1) + (A - 1) * cos + beta;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - beta;
    } else {
      b0 = A * ((A + 1) + (A - 1) * cos + beta);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - beta);
      a0 = (A + 1) - (A - 1) * cos + beta;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - beta;
    }
  }
  return [b0 / a0, b1 / a0, b2 / a0, 1, a1 / a0, a2 / a0];
}

function responseDb(coefficients, frequency, sampleRate) {
  const w = 2 * Math.PI * frequency / sampleRate;
  const cos = Math.cos(w), sin = Math.sin(w), cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w);
  const [b0, b1, b2, a0, a1, a2] = coefficients;
  const numerator = Math.hypot(b0 + b1 * cos + b2 * cos2, -b1 * sin - b2 * sin2);
  const denominator = Math.hypot(a0 + a1 * cos + a2 * cos2, -a1 * sin - a2 * sin2);
  return 20 * Math.log10(Math.max(1e-12, numerator / denominator));
}

function calculatePreamp(profile) {
  // Lấy đỉnh đáp ứng tổng để trừ đúng phần gain dương lớn nhất trước các filter.
  const active = activeFilters(profile);
  let filterHeadroom = 0;
  for (const sampleRate of [44100, 48000, 88200, 96000, 192000]) {
    const filters = active.map((filter) => ({ filter, coefficients: biquadCoefficients(filter, sampleRate) }));
    const maximumFrequency = Math.min(20000, sampleRate * .499);
    for (let index = 0; index <= 512; index += 1) {
      const frequency = 20 * Math.pow(maximumFrequency / 20, index / 512);
      const response = filters.reduce((sum, item) => sum + responseDb(item.coefficients, frequency, sampleRate), 0);
      filterHeadroom = Math.max(filterHeadroom, response);
    }
  }
  const width = number(profile.effects?.width, -35, 35) / 100;
  const matrixPeak = width < 0 ? 20 * Math.log10(1 - 2 * width) : 0;
  // Thêm 0,15 dB dự phòng cho shelf và bước lấy mẫu đáp ứng.
  // Chỉ cộng biên an toàn khi thực sự có filter đang hoạt động.
  return Math.ceil(Math.max(0, filterHeadroom + matrixPeak + (active.length ? 0.15 : 0)) * 100) / 100;
}

function buildConfiguration(profile) {
  if (profile.bypass) return 'Preamp: 0 dB\r\n';

  const eq = Array.isArray(profile.eq) ? profile.eq : [];
  const effects = profile.effects || {};
  const lines = [];
  const preamp = calculatePreamp(profile);
  lines.push(`Preamp: ${format(-preamp)} dB`);

  FREQUENCIES.forEach((frequency, index) => {
    const gain = number(eq[index], -12, 12);
    if (gain !== 0) lines.push(`Filter: ON PK Fc ${frequency} Hz Gain ${format(gain)} dB Q 1.41`);
  });

  const bass = number(effects.bass, -12, 12);
  const treble = number(effects.treble, -12, 12);
  const dialogue = number(effects.dialogue, -12, 12);
  if (bass !== 0) lines.push(`Filter: ON LSC Fc 100 Hz Gain ${format(bass)} dB`);
  if (treble !== 0) lines.push(`Filter: ON HSC Fc 8000 Hz Gain ${format(treble)} dB`);
  if (dialogue !== 0) lines.push(`Filter: ON PK Fc 2500 Hz Gain ${format(dialogue)} dB Q 1.0`);

  const width = number(effects.width, -35, 35) / 100;
  if (width !== 0) {
    const crossfeed = width < 0 ? width : width * 0.5;
    const direct = 1 - crossfeed;
    lines.push(`Copy: L=${format(direct)}*L+${format(crossfeed)}*R R=${format(direct)}*R+${format(crossfeed)}*L`);
  }

  const balance = number(effects.balance, -100, 100);
  if (balance < 0) {
    const left = 1;
    const right = Math.pow(10, balance / 20);
    lines.push(`Copy: L=${format(left)}*L R=${format(right)}*R`);
  } else if (balance > 0) {
    const left = Math.pow(10, -balance / 20);
    const right = 1;
    lines.push(`Copy: L=${format(left)}*L R=${format(right)}*R`);
  }

  const impulsePath = typeof effects.impulsePath === 'string' && !/[\r\n\0]/.test(effects.impulsePath) && /\.wav$/i.test(effects.impulsePath.trim())
    ? effects.impulsePath.trim()
    : '';
  if (effects.reverbEnabled && impulsePath) {
    lines.push(`Convolution: ${impulsePath}`);
  }

  const pluginPath = typeof effects.vstPluginPath === 'string' && !/[\r\n\0]/.test(effects.vstPluginPath) && /\.dll$/i.test(effects.vstPluginPath.trim())
    ? effects.vstPluginPath.trim()
    : '';
  if (effects.compressorEnabled && pluginPath) {
    const escaped = pluginPath.replace(/"/g, '\\"');
    lines.push(`VSTPlugin: Library "${escaped}"`);
  }

  return `${lines.join('\r\n')}\r\n`;
}

function createEqualizerApoEngine() {
  let status = { state: 'not-checked', message: 'Chưa kiểm tra Equalizer APO.' };
  let install = null;
  let files = null;

  function getStatus() { return { ...status }; }
  function getDetails() {
    return install ? { configDir: install.configDir, configFile: files?.configFile, backupFile: files?.backupFile } : null;
  }

  async function connect() {
    if (process.platform !== 'win32') {
      status = { state: 'unsupported', message: 'Taylor ND Audio cần Windows 10/11 để dùng Equalizer APO.' };
      return getStatus();
    }
    install = findConfigDirectory();
    if (!install) {
      status = { state: 'not-installed', message: 'Chưa tìm thấy Equalizer APO hoặc config.txt.' };
      return getStatus();
    }
    try {
      files = ensureInclude(install.configDir);
      status = {
        state: 'connected',
        message: files.includeAdded ? 'Đã sao lưu và kết nối Equalizer APO.' : 'Đã kết nối Equalizer APO.',
        includeAdded: files.includeAdded,
        backupFile: files.backupFile,
        configDir: install.configDir
      };
    } catch (error) {
      const denied = error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'ERROR_ACCESS_DENIED';
      status = {
        state: denied ? 'needs-admin' : 'error',
        message: denied
          ? 'Windows chặn quyền ghi vào thư mục Equalizer APO. Hãy khởi động lại với quyền Administrator.'
          : `Không thể tích hợp Equalizer APO: ${error.message}`
      };
    }
    return getStatus();
  }

  async function applyProfile(profile) {
    if (!install || status.state !== 'connected') await connect();
    if (status.state !== 'connected') return { ok: false, status: getStatus() };
    const target = path.join(install.configDir, INCLUDE_NAME);
    try {
      // Đây là file cấu hình duy nhất được ghi lại khi người dùng chỉnh âm thanh.
      fs.writeFileSync(target, buildConfiguration(profile), 'utf8');
      status = { ...status, state: 'connected', message: 'Đã cập nhật cấu hình Equalizer APO.', outputFile: target };
      return { ok: true, status: getStatus(), outputFile: target };
    } catch (error) {
      const denied = error.code === 'EACCES' || error.code === 'EPERM';
      status = {
        ...status,
        state: denied ? 'needs-admin' : 'error',
        message: denied ? 'Windows chặn quyền ghi file hiệu ứng. Hãy khởi động lại với quyền Administrator.' : error.message
      };
      return { ok: false, status: getStatus() };
    }
  }

  return { connect, applyProfile, getStatus, getDetails };
}

module.exports = {
  createEqualizerApoEngine,
  buildConfiguration,
  calculatePreamp,
  FREQUENCIES
};
