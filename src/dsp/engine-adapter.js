// Adapter chọn engine; renderer luôn gọi cùng một interface applyProfile(profile).
const { createEqualizerApoEngine } = require('./equalizer-apo');
const { TaylorEngineAdapter } = require('./taylor-engine');

class EngineAdapter {
  constructor(onUpdate = () => {}) {
    this.onUpdate = onUpdate;
    this.mode = 'apo';
    this.apo = createEqualizerApoEngine();
    this.taylor = new TaylorEngineAdapter(onUpdate);
    this.taylorApo = new TaylorEngineAdapter(onUpdate, { mode: 'taylor-apo', binaryName: 'tnd-bridge.exe', resourceFolder: 'apo', displayName: 'Taylor APO' });
    this.active = this.apo;
  }

  async connect(mode = 'apo') {
    const nextMode = ['taylor', 'taylor-apo'].includes(mode) ? mode : 'apo';
    if (this.mode !== nextMode) {
      await this.active.disconnect?.();
      this.mode = nextMode;
      this.active = nextMode === 'taylor' ? this.taylor : nextMode === 'taylor-apo' ? this.taylorApo : this.apo;
    }
    return this.active.connect();
  }

  applyProfile(profile) { return this.active.applyProfile(profile); }
  getStatus() { return this.active.getStatus(); }
  getDetails() { return this.active.getDetails(); }
  getMode() { return this.mode; }
  listDevices() { return this.mode === 'taylor' ? this.taylor.listDevices() : this.mode === 'taylor-apo' ? this.taylorApo.listDevices() : Promise.resolve([]); }
  start(options) { return this.mode === 'taylor' ? this.taylor.start(options) : this.mode === 'taylor-apo' ? this.taylorApo.start(options) : Promise.resolve({ ok: false, message: 'Hãy chọn Taylor Engine trong Cài đặt.' }); }
  stop() { return this.mode === 'taylor' ? this.taylor.stop() : this.mode === 'taylor-apo' ? this.taylorApo.stop() : Promise.resolve({ ok: false }); }
  setBypass(value) { return this.mode === 'taylor' ? this.taylor.setBypass(value) : this.mode === 'taylor-apo' ? this.taylorApo.setBypass(value) : Promise.resolve({ ok: false }); }
  loadImpulse(filePath) { return this.mode === 'taylor' ? this.taylor.loadImpulse(filePath) : this.mode === 'taylor-apo' ? this.taylorApo.loadImpulse(filePath) : Promise.resolve({ ok: false }); }
  disconnect() { return Promise.all([this.taylor.disconnect(), this.taylorApo.disconnect()]); }
}

module.exports = { EngineAdapter };
