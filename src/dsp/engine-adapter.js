// Adapter chọn engine; renderer luôn gọi cùng một interface applyProfile(profile).
const { createEqualizerApoEngine } = require('./equalizer-apo');
const { TaylorEngineAdapter } = require('./taylor-engine');

class EngineAdapter {
  constructor(onUpdate = () => {}) {
    this.onUpdate = onUpdate;
    this.mode = 'apo';
    this.apo = createEqualizerApoEngine();
    this.taylor = new TaylorEngineAdapter(onUpdate);
    this.active = this.apo;
  }

  async connect(mode = 'apo') {
    const nextMode = mode === 'taylor' ? 'taylor' : 'apo';
    if (this.mode !== nextMode) {
      if (this.active === this.taylor) await this.taylor.disconnect();
      this.mode = nextMode;
      this.active = nextMode === 'taylor' ? this.taylor : this.apo;
    }
    return this.active.connect();
  }

  applyProfile(profile) { return this.active.applyProfile(profile); }
  getStatus() { return this.active.getStatus(); }
  getDetails() { return this.active.getDetails(); }
  getMode() { return this.mode; }
  listDevices() { return this.mode === 'taylor' ? this.taylor.listDevices() : Promise.resolve([]); }
  start(options) { return this.mode === 'taylor' ? this.taylor.start(options) : Promise.resolve({ ok: false, message: 'Hãy chọn Taylor Engine trong Cài đặt.' }); }
  stop() { return this.mode === 'taylor' ? this.taylor.stop() : Promise.resolve({ ok: false }); }
  setBypass(value) { return this.mode === 'taylor' ? this.taylor.setBypass(value) : Promise.resolve({ ok: false }); }
  loadImpulse(filePath) { return this.mode === 'taylor' ? this.taylor.loadImpulse(filePath) : Promise.resolve({ ok: false }); }
  disconnect() { return this.taylor.disconnect(); }
}

module.exports = { EngineAdapter };
