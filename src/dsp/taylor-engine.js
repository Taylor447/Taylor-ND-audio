// Adapter sidecar: Electron chỉ điều khiển bằng JSON/WebSocket cục bộ có token.
const { spawn } = require('node:child_process');
const path = require('node:path');
const WebSocket = require('ws');

class TaylorEngineAdapter {
  constructor(onUpdate = () => {}) {
    this.onUpdate = onUpdate;
    this.child = null;
    this.socket = null;
    this.boot = null;
    this.intentionalStop = false;
    this.restartCount = 0;
    this.restartTimer = null;
    this.status = { state: 'disconnected', message: 'Taylor Engine chưa khởi chạy.' };
    this.devices = [];
    this.latestState = { running: false, sampleRate: 0, latencyMs: 0, xruns: 0 };
    this.pending = new Map();
    this.deviceWaiters = [];
    this.restartInFlight = false;
    this.lastStartOptions = null;
    this.lastProfile = null;
  }

  get executablePath() {
    if (process.resourcesPath) return path.join(process.resourcesPath, 'engine', 'tnd-engine.exe');
    return path.resolve(__dirname, '..', '..', 'engine', 'target', 'release', 'tnd-engine.exe');
  }

  getStatus() { return { ...this.status, ...this.latestState, mode: 'taylor' }; }
  getDetails() { return { executablePath: this.executablePath, port: this.boot?.port || null }; }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return this.getStatus();
    this.intentionalStop = false;
    try {
      await this.launchSidecar();
      this.restartCount = 0;
      this.send({ type: 'listDevices' });
      this.status = { state: 'connected', message: 'Taylor Engine đã sẵn sàng. Chọn thiết bị đầu vào và đầu ra để bắt đầu.' };
    } catch (error) {
      // Dọn sidecar lỗi khởi động để không để lại tiến trình mồ côi.
      this.socket?.close();
      this.socket = null;
      const child = this.child;
      this.child = null;
      if (child && !child.killed) child.kill();
      this.status = { state: 'error', message: `Không khởi chạy được Taylor Engine: ${error.message}` };
    }
    this.onUpdate({ integration: this.getStatus(), engineMode: 'taylor', devices: this.devices });
    return this.getStatus();
  }

  launchSidecar() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executablePath, [], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      this.boot = null;
      let stdoutBuffer = '';
      let stderrTail = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`Sidecar không gửi thông tin khởi động. ${stderrTail}`.trim()));
      }, 8000);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0 || settled) return;
        const line = stdoutBuffer.slice(0, newline).trim();
        try {
          const boot = JSON.parse(line);
          if (!boot.ready || !Number.isInteger(boot.port) || typeof boot.token !== 'string') throw new Error('Thông tin khởi động sidecar không hợp lệ.');
          this.boot = boot;
          this.openSocket(boot, resolve, reject, timer, () => { settled = true; });
        } catch (error) {
          settled = true; clearTimeout(timer); reject(error);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderrTail = `${stderrTail}${chunk}`.slice(-1600); });
      child.once('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(error); }
      });
      child.once('close', (code, signal) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`tnd-engine.exe kết thúc sớm (mã ${code ?? signal ?? 'không rõ'}). ${stderrTail}`.trim())); }
        this.handleUnexpectedExit(child, code, signal);
      });
    });
  }

  openSocket(boot, resolve, reject, timer, settle) {
    const socket = new WebSocket(`ws://127.0.0.1:${boot.port}`);
    this.socket = socket;
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'auth', token: boot.token }));
      settle(); clearTimeout(timer); resolve();
    });
    socket.on('message', (data) => this.receive(data));
    socket.once('error', (error) => {
      if (socket.readyState !== WebSocket.OPEN) { clearTimeout(timer); reject(error); }
      this.status = { state: 'error', message: `Kết nối IPC tới Taylor Engine gặp lỗi: ${error.message}` };
      this.onUpdate({ integration: this.getStatus(), engineMode: 'taylor' });
    });
    socket.once('close', () => {
      if (this.socket === socket) this.socket = null;
    });
  }

  receive(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (message.type === 'devices') {
      this.devices = Array.isArray(message.devices) ? message.devices : [];
      for (const resolve of this.deviceWaiters.splice(0)) resolve(this.devices);
      this.onUpdate({ devices: this.devices, cableDetected: Boolean(message.cableDetected), engineMode: 'taylor' });
    } else if (message.type === 'state') {
      this.latestState = { running: Boolean(message.running), sampleRate: Number(message.sampleRate) || 0,
        latencyMs: Number(message.latencyMs) || 0, xruns: Number(message.xruns) || 0, engineMessage: message.message || '' };
      this.onUpdate({ engineState: this.latestState, integration: this.getStatus(), engineMode: 'taylor' });
    } else if (message.type === 'telemetry') {
      this.onUpdate({ telemetry: message, engineMode: 'taylor' });
    } else if (message.type === 'error') {
      this.onUpdate({ engineError: { code: message.code, message: message.message }, engineMode: 'taylor' });
    } else if (message.type === 'ack') {
      const waiting = this.pending.get(message.request);
      if (waiting) {
        this.pending.delete(message.request);
        waiting.resolve({ ok: Boolean(message.ok), message: message.message || '' });
      }
    }
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  request(type, fields = {}) {
    if (!this.send({ type, ...fields })) return Promise.resolve({ ok: false, message: 'Taylor Engine chưa kết nối.' });
    return new Promise((resolve) => {
      const key = type === 'setProfile' ? 'setProfile' : type;
      const timer = setTimeout(() => {
        this.pending.delete(key);
        resolve({ ok: false, message: `Taylor Engine không phản hồi lệnh ${type}. Hãy kiểm tra trạng thái engine.` });
      }, 1800);
      const previous = this.pending.get(key);
      if (previous) { clearTimeout(previous.timer); previous.resolve({ ok: true, message: 'Đã thay bằng cập nhật mới hơn.' }); }
      this.pending.set(key, { resolve: (result) => { clearTimeout(timer); resolve(result); }, timer });
    });
  }

  async applyProfile(profile) {
    this.lastProfile = JSON.parse(JSON.stringify(profile));
    const result = await this.request('setProfile', { profile });
    return { ...result, status: this.getStatus() };
  }

  async listDevices() {
    if (!this.send({ type: 'listDevices' })) return this.devices;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.deviceWaiters = this.deviceWaiters.filter((waiter) => waiter !== finish);
        resolve(this.devices);
      }, 450);
      const finish = (devices) => { clearTimeout(timer); resolve(devices); };
      this.deviceWaiters.push(finish);
    });
  }

  async start(options) {
    const result = await this.request('start', options);
    if (result.ok) this.lastStartOptions = { ...options };
    return result;
  }
  async stop() {
    const result = await this.request('stop');
    if (result.ok) this.lastStartOptions = null;
    return result;
  }
  async setBypass(bypass) { return this.request('setBypass', { bypass }); }
  async loadImpulse(filePath) { return this.request('loadImpulse', { path: filePath }); }

  async disconnect() {
    this.intentionalStop = true;
    clearTimeout(this.restartTimer);
    this.lastStartOptions = null;
    if (this.latestState.running) this.send({ type: 'stop' });
    this.socket?.close();
    this.socket = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, message: 'Engine đã dừng.' }); }
    this.pending.clear();
    for (const resolve of this.deviceWaiters.splice(0)) resolve(this.devices);
    this.status = { state: 'disconnected', message: 'Taylor Engine đã dừng.' };
    this.latestState = { running: false, sampleRate: 0, latencyMs: 0, xruns: 0 };
  }

  handleUnexpectedExit(child, code, signal) {
    // Bỏ sự kiện close của tiến trình đã được thay thế hoặc dừng có chủ ý.
    if (child !== this.child || this.intentionalStop || this.restartInFlight) return;
    this.socket = null;
    this.child = null;
    this.latestState = { running: false, sampleRate: 0, latencyMs: 0, xruns: 0 };
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ ok: false, message: 'Taylor Engine đã đóng kết nối.' }); }
    this.pending.clear();
    const reason = `Taylor Engine đóng bất ngờ (mã ${code ?? signal ?? 'không rõ'}).`;
    this.status = { state: 'error', message: reason };
    this.onUpdate({ integration: this.getStatus(), engineError: { code: 'ENGINE_EXIT', message: reason }, engineMode: 'taylor' });
    this.scheduleRestart(reason);
  }

  scheduleRestart(reason) {
    if (this.restartCount >= 3) {
      this.status.message = `${reason} Đã thử khởi động lại 3 lần; hãy chuyển về Equalizer APO trong Cài đặt.`;
      this.onUpdate({ integration: this.getStatus(), engineError: { code: 'FALLBACK_SUGGESTED', message: this.status.message }, engineMode: 'taylor' });
      return;
    }
    this.restartCount += 1;
    const attempt = this.restartCount;
    this.restartTimer = setTimeout(async () => {
      this.restartInFlight = true;
      try {
        await this.launchSidecar();
        this.restartInFlight = false;
        this.status = { state: 'connected', message: `Taylor Engine đã tự khởi động lại (${attempt}/3).` };
        this.send({ type: 'listDevices' });
        if (this.lastProfile) await this.applyProfile(this.lastProfile);
        // Khôi phục tuyến audio đã chọn trước khi engine gặp sự cố.
        if (this.lastStartOptions) {
          const startResult = await this.request('start', this.lastStartOptions);
          if (startResult.ok) {
            this.latestState = { ...this.latestState, running: true };
          } else {
            this.status = { state: 'error', message: `Engine đã mở lại nhưng chưa thể khôi phục thiết bị: ${startResult.message}` };
          }
        }
        this.onUpdate({ integration: this.getStatus(), engineMode: 'taylor' });
      } catch (error) {
        this.restartInFlight = false;
        this.status = { state: 'error', message: `Lần khởi động lại ${attempt}/3 thất bại: ${error.message}` };
        const child = this.child;
        this.child = null;
        if (child && !child.killed) child.kill();
        this.onUpdate({ integration: this.getStatus(), engineError: { code: 'ENGINE_RESTART_FAILED', message: this.status.message }, engineMode: 'taylor' });
        this.scheduleRestart(this.status.message);
      }
    }, 500 * 2 ** (attempt - 1));
  }
}

module.exports = { TaylorEngineAdapter };
