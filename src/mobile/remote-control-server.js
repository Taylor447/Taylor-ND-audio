// Máy chủ điều khiển điện thoại chỉ mở khi người dùng chủ động bật.
// Máy chủ chỉ nhận kết nối trong cùng mạng con Wi-Fi và yêu cầu token ngẫu nhiên.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const ASSET_FILES = new Map([
  ['/', ['remote.html', 'text/html; charset=utf-8']],
  ['/remote.html', ['remote.html', 'text/html; charset=utf-8']],
  ['/remote.css', ['remote.css', 'text/css; charset=utf-8']],
  ['/remote.js', ['remote.js', 'text/javascript; charset=utf-8']]
]);

function ipv4ToNumber(address) {
  const parts = String(address || '').replace(/^::ffff:/i, '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
}

function isPrivateAddress(address) {
  const value = ipv4ToNumber(address);
  if (value === null) return false;
  const first = value >>> 24;
  const second = (value >>> 16) & 255;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function findLanAddress() {
  const candidates = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const item of addresses || []) {
      if ((item.family === 'IPv4' || item.family === 4) && !item.internal && isPrivateAddress(item.address) && ipv4ToNumber(item.netmask) !== null) {
        // Ưu tiên địa chỉ Wi-Fi thường gặp; loại adapter ảo sau các mạng riêng phổ biến.
        const first = Number(item.address.split('.')[0]);
        const score = first === 192 ? 0 : first === 10 ? 1 : 2;
        candidates.push({ name, address: item.address, netmask: item.netmask, score });
      }
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0] || null;
}

function sameSubnet(remoteAddress, localAddress) {
  const remote = ipv4ToNumber(remoteAddress);
  const local = ipv4ToNumber(localAddress.address);
  const mask = ipv4ToNumber(localAddress.netmask);
  return remote !== null && local !== null && mask !== null && ((remote & mask) >>> 0) === ((local & mask) >>> 0);
}

function safePublicProfile(profile) {
  const effects = profile?.effects || {};
  return {
    eq: Array.isArray(profile?.eq) ? profile.eq.slice(0, 10).map((value) => Number(value) || 0) : Array(10).fill(0),
    effects: {
      bass: Number(effects.bass) || 0,
      treble: Number(effects.treble) || 0,
      dialogue: Number(effects.dialogue) || 0,
      width: Number(effects.width) || 0,
      balance: Number(effects.balance) || 0
    },
    bypass: Boolean(profile?.bypass)
  };
}

class MobileRemoteServer {
  constructor(options = {}) {
    this.getState = options.getState || (() => ({}));
    this.applyProfile = options.applyProfile || (async () => ({ ok: false, message: 'Chưa nối với hồ sơ âm thanh.' }));
    this.applyPreset = options.applyPreset || (async () => ({ ok: false, message: 'Chưa nối với preset.' }));
    this.setBypass = options.setBypass || (async () => ({ ok: false, message: 'Chưa nối với bypass.' }));
    this.onStatus = options.onStatus || (() => {});
    this.httpServer = null;
    this.webSocketServer = null;
    this.lan = null;
    this.port = 0;
    this.token = '';
    this.pairedSockets = new Set();
  }

  get running() { return Boolean(this.httpServer?.listening); }

  getPublicState() {
    const snapshot = this.getState() || {};
    const profile = safePublicProfile(snapshot.profile);
    const presets = Array.isArray(snapshot.presets) ? snapshot.presets.slice(0, 32).map((preset) => ({
      id: String(preset.id || '').slice(0, 80),
      name: String(preset.name || 'Preset').slice(0, 48),
      profile: safePublicProfile(preset.profile)
    })) : [];
    return {
      profile,
      presets,
      integration: { state: String(snapshot.integration?.state || 'unknown'), message: String(snapshot.integration?.message || '').slice(0, 180) },
      engine: {
        running: Boolean(snapshot.engine?.running),
        sampleRate: Number(snapshot.engine?.sampleRate) || 0,
        latencyMs: Number(snapshot.engine?.latencyMs) || 0,
        xruns: Number(snapshot.engine?.xruns) || 0
      }
    };
  }

  getStatus() {
    if (!this.running) return { running: false, pairedDevices: 0 };
    return { running: true, address: this.lan.address, port: this.port, url: this.getPairingUrl(), pairedDevices: this.pairedSockets.size };
  }

  getPairingUrl() {
    return this.running && this.token ? `http://${this.lan.address}:${this.port}/#${this.token}` : '';
  }

  async start() {
    if (this.running) return this.getStatus();
    this.lan = findLanAddress();
    if (!this.lan) throw new Error('Không tìm thấy Wi-Fi/mạng nội bộ IPv4. Hãy nối máy tính vào cùng Wi-Fi với điện thoại rồi thử lại.');
    this.token = randomBytes(32).toString('hex');

    this.httpServer = http.createServer((request, response) => this.servePage(request, response));
    this.webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
    this.httpServer.on('upgrade', (request, socket, head) => this.acceptUpgrade(request, socket, head));
    this.webSocketServer.on('connection', (socket, request) => this.handleConnection(socket, request));

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { this.httpServer?.off('listening', onListening); reject(error); };
        const onListening = () => { this.httpServer?.off('error', onError); resolve(); };
        this.httpServer.once('error', onError);
        this.httpServer.once('listening', onListening);
        this.httpServer.listen(0, '0.0.0.0');
      });
      this.port = this.httpServer.address().port;
      this.onStatus(this.getStatus());
      return this.getStatus();
    } catch (error) {
      await this.stop();
      throw new Error(`Không mở được kết nối trong mạng nội bộ: ${error.message}`);
    }
  }

  servePage(request, response) {
    const peer = request.socket.remoteAddress;
    const expectedHost = `${this.lan.address}:${this.port}`;
    if (!sameSubnet(peer, this.lan) || String(request.headers.host || '').toLowerCase() !== expectedHost.toLowerCase()) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Chỉ thiết bị trong cùng mạng nội bộ mới được mở trang điều khiển.');
      return;
    }

    let pathname;
    try { pathname = new URL(request.url, `http://${expectedHost}`).pathname; }
    catch { response.writeHead(400); response.end(); return; }
    const asset = ASSET_FILES.get(pathname);
    if (request.method !== 'GET' || !asset) { response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return; }

    const file = path.join(__dirname, asset[0]);
    let body;
    try { body = fs.readFileSync(file); }
    catch { response.writeHead(500, { 'cache-control': 'no-store' }); response.end(); return; }
    response.writeHead(200, {
      'content-type': asset[1],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    });
    response.end(body);
  }

  acceptUpgrade(request, socket, head) {
    const expectedOrigin = `http://${this.lan.address}:${this.port}`;
    const expectedHost = `${this.lan.address}:${this.port}`;
    if (!sameSubnet(request.socket.remoteAddress, this.lan) || request.headers.host !== expectedHost || request.headers.origin !== expectedOrigin || request.url !== '/control') {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => this.webSocketServer.emit('connection', webSocket, request));
  }

  handleConnection(socket) {
    let authenticated = false;
    const authTimer = setTimeout(() => socket.close(1008, 'Cần ghép nối lại bằng mã mới.'), 7000);
    const messageTimes = [];
    socket.on('message', async (raw) => {
      if (raw.length > 8192) { socket.close(1009, 'Tin nhắn quá lớn.'); return; }
      let message;
      try { message = JSON.parse(String(raw)); } catch { socket.close(1007, 'Tin nhắn không hợp lệ.'); return; }

      if (!authenticated) {
        const candidate = Buffer.from(String(message.token || ''), 'utf8');
        const secret = Buffer.from(this.token, 'utf8');
        if (message.type !== 'auth' || candidate.length !== secret.length || !timingSafeEqual(candidate, secret)) {
          socket.close(1008, 'Mã ghép nối không đúng. Hãy quét mã mới trong ứng dụng.');
          return;
        }
        if (this.pairedSockets.size >= 2) { socket.close(1008, 'Đã có đủ thiết bị được kết nối.'); return; }
        authenticated = true;
        clearTimeout(authTimer);
        this.pairedSockets.add(socket);
        socket.send(JSON.stringify({ type: 'paired', state: this.getPublicState() }));
        this.onStatus(this.getStatus());
        return;
      }

      const now = Date.now();
      while (messageTimes.length && now - messageTimes[0] > 1000) messageTimes.shift();
      messageTimes.push(now);
      if (messageTimes.length > 24) { socket.close(1008, 'Quá nhiều thao tác liên tiếp.'); return; }

      try {
        let result;
        if (message.type === 'setProfile') result = await this.applyProfile(message.profile);
        else if (message.type === 'applyPreset') result = await this.applyPreset(String(message.id || '').slice(0, 80));
        else if (message.type === 'setBypass') result = await this.setBypass(Boolean(message.bypass));
        else { socket.send(JSON.stringify({ type: 'error', message: 'Thao tác này chưa được hỗ trợ.' })); return; }

        socket.send(JSON.stringify({ type: 'ack', requestId: String(message.requestId || '').slice(0, 40), ok: Boolean(result?.ok), message: String(result?.message || '').slice(0, 180), state: this.getPublicState() }));
        this.publishState();
      } catch (error) {
        socket.send(JSON.stringify({ type: 'ack', requestId: String(message.requestId || '').slice(0, 40), ok: false, message: `Không áp dụng được: ${String(error.message || 'lỗi không xác định').slice(0, 120)}` }));
      }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (this.pairedSockets.delete(socket)) this.onStatus(this.getStatus());
    });
    socket.on('error', () => {});
  }

  publishState() {
    const payload = JSON.stringify({ type: 'state', state: this.getPublicState() });
    for (const socket of this.pairedSockets) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  }

  async stop() {
    for (const socket of this.webSocketServer?.clients || []) socket.terminate();
    this.pairedSockets.clear();
    const sockets = this.webSocketServer;
    const server = this.httpServer;
    this.webSocketServer = null;
    this.httpServer = null;
    this.port = 0;
    this.token = '';
    if (sockets) await new Promise((resolve) => sockets.close(() => resolve()));
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
    this.lan = null;
    this.onStatus(this.getStatus());
    return this.getStatus();
  }
}

module.exports = { MobileRemoteServer, safePublicProfile, findLanAddress, sameSubnet };
