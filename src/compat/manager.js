// Compatibility Manager: chỉ khuyến nghị từ thông tin đã dò được, không tự sửa APO hãng.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

const DRIVER_RULES = path.join(__dirname, '..', '..', 'compat', 'drivers.json');

function containsAny(haystack, values = []) {
  const value = String(haystack || '').toLowerCase();
  return values.some((part) => value.includes(String(part).toLowerCase()));
}

function loadRules() {
  try {
    const data = JSON.parse(fs.readFileSync(DRIVER_RULES, 'utf8'));
    if (data.schemaVersion !== 1 || !Array.isArray(data.rules) || !data.fallback) throw new Error('Bộ quy tắc không hợp lệ.');
    return data;
  } catch (error) {
    return { schemaVersion: 1, rules: [], fallback: { recommendation: 'equalizer-apo', status: 'unknown', reason: `Không đọc được rules: ${error.message}` } };
  }
}

function classifyDevice(device, rules) {
  const rule = [...rules.rules].sort((a, b) => b.priority - a.priority).find((item) => {
    const match = item.match || {};
    const textual = [device.name, device.vendor, device.hardwareId].join(' ');
    const hasTerms = (match.nameContains?.length || match.vendorContains?.length || match.hardwareIdContains?.length || match.bus);
    if (!hasTerms) return false;
    if (match.nameContains?.length && !containsAny(device.name, match.nameContains)) return false;
    if (match.vendorContains?.length && !containsAny(device.vendor, match.vendorContains)) return false;
    if (match.hardwareIdContains?.length && !containsAny(device.hardwareId, match.hardwareIdContains)) return false;
    if (match.bus && String(device.bus).toLowerCase() !== match.bus.toLowerCase()) return false;
    return Boolean(textual);
  });
  return rule || { id: 'fallback', ...rules.fallback, knownIssues: [] };
}

class CompatibilityManager {
  constructor({ app, engine, getSettings, getIntegration, onUpdate }) {
    this.app = app;
    this.engine = engine;
    this.getSettings = getSettings;
    this.getIntegration = getIntegration;
    this.onUpdate = onUpdate || (() => {});
    this.timer = null;
    this.snapshotHash = '';
    this.rules = loadRules();
  }

  async scan() {
    const [probe, devices] = await Promise.all([this.runProbe(), this.engine.listDevices()]);
    const reported = Array.isArray(probe?.devices) ? probe.devices : [];
    const baseDevices = devices.length ? devices : reported;
    const enriched = baseDevices.map((device) => {
      const extra = reported.find((item) => item.endpointId === device.id || item.name === device.name) || {};
      const merged = { ...device, ...extra, endpointId: device.id || device.endpointId, name: device.name, direction: device.direction };
      const rule = classifyDevice(merged, this.rules);
      const activeMode = this.getSettings().engineMode;
      const active = activeMode === 'taylor' ? 'taylor' : activeMode === 'taylor-apo' ? 'taylor-apo' : 'equalizer-apo';
      const conflicts = probe?.softwareConflicts || [];
      const conflict = conflicts.length > 0;
      let recommendation = rule.recommendation;
      let reason = rule.reason;
      let status = rule.status;
      if (conflict && active === 'equalizer-apo') {
        recommendation = 'taylor';
        reason = `Phát hiện phần mềm âm thanh có thể xung đột (${conflicts.join(', ')}); chưa xác định được APO nào đang hoạt động.`;
        status = 'conditional';
      }
      return { ...merged, backend: active, recommendedBackend: recommendation, reason, compatibilityStatus: status, knownIssues: rule.knownIssues || [], apoStatus: conflict ? 'conditional' : 'unknown', engineStatus: 'conditional' };
    });
    const report = { generatedAt: new Date().toISOString(), system: probe?.system || { architecture: process.arch, windowsBuild: null }, devices: enriched, softwareConflicts: probe?.softwareConflicts || [], notice: probe?.notice || 'Thông tin driver/APO chưa được xác minh đầy đủ trên máy này.' };
    this.publish(report);
    return report;
  }

  runProbe() {
    if (process.platform !== 'win32') return Promise.resolve({ devices: [], notice: 'Thăm dò driver hiện chỉ hỗ trợ Windows.' });
    const executable = process.resourcesPath
      ? path.join(process.resourcesPath, 'engine', 'tnd-probe.exe')
      : path.join(__dirname, '..', '..', 'engine', 'target', 'release', 'tnd-probe.exe');
    return new Promise((resolve) => {
      const child = spawn(executable, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      const timer = setTimeout(() => { child.kill(); resolve({ devices: [], notice: 'Probe quá thời gian; một số trường driver/APO sẽ hiện chưa xác định.' }); }, 5000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-1024 * 1024); });
      child.once('error', () => { clearTimeout(timer); resolve({ devices: [], notice: 'Chưa có tnd-probe.exe; dùng danh sách thiết bị cơ bản, trường driver/APO chưa xác định.' }); });
      child.once('close', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(output)); } catch { resolve({ devices: [], notice: 'Probe trả dữ liệu không hợp lệ; không thay đổi engine đang chạy.' }); }
      });
    });
  }

  publish(report) {
    const comparable = report.devices.map((device) => [device.endpointId, device.name, device.sampleRate, device.channels, device.recommendedBackend]);
    const hash = crypto.createHash('sha256').update(JSON.stringify(comparable)).digest('hex');
    if (hash === this.snapshotHash) return;
    this.snapshotHash = hash;
    this.onUpdate(report);
  }

  startWatchdog() {
    if (this.timer || process.platform !== 'win32') return;
    // CPAL cập nhật danh sách thiết bị qua event; quét nhẹ định kỳ dự phòng cho thay đổi driver/endpoint.
    this.timer = setInterval(() => this.scan().catch(() => {}), 15_000);
    this.timer.unref?.();
  }

  stopWatchdog() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async exportAnonymous(report) {
    const safe = {
      schemaVersion: 1,
      generatedAt: report.generatedAt,
      system: { architecture: report.system?.architecture || 'unknown', windowsBuild: report.system?.windowsBuild || null },
      devices: report.devices.map((device, index) => ({
        // Thay tên endpoint bằng nhãn chung để không lộ tên Bluetooth cá nhân/serial trong friendly name.
        name: `${device.direction === 'input' ? 'Đầu vào' : 'Đầu ra'} ${index + 1}`,
        type: device.type || 'unknown', bus: device.bus || 'unknown', direction: device.direction || 'unknown',
        vendor: device.vendor || null, driverVersion: device.driverVersion || null, driverDate: device.driverDate || null,
        inboxDriver: device.inboxDriver ?? null, sampleRate: device.sampleRate || null, channels: device.channels || null,
        backend: device.backend, recommendedBackend: device.recommendedBackend, compatibilityStatus: device.compatibilityStatus,
        reason: device.reason
      })),
      softwareConflicts: report.softwareConflicts || [],
      notice: 'Báo cáo ẩn danh cục bộ. Ứng dụng không tự gửi báo cáo.'
    };
    const result = await require('electron').dialog.showSaveDialog({
      title: 'Xuất báo cáo tương thích ẩn danh', defaultPath: 'taylor-audio-compatibility.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
    return { ok: true, filePath: result.filePath };
  }
}

module.exports = { CompatibilityManager, classifyDevice, loadRules };
