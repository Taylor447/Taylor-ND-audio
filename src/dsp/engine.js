// Facade ổn định để mọi lệnh hồ sơ đi qua adapter đang được chọn trong Cài đặt.
const { EngineAdapter } = require('./engine-adapter');

let updateHandler = () => {};
const activeAdapter = new EngineAdapter((payload) => updateHandler(payload));

async function connect(mode) { return activeAdapter.connect(mode); }
async function applyProfile(profile) { return activeAdapter.applyProfile(profile); }
function getStatus() { return activeAdapter.getStatus(); }
function getEngineDetails() { return activeAdapter.getDetails(); }
function setUpdateHandler(handler) { updateHandler = typeof handler === 'function' ? handler : () => {}; }
function listDevices() { return activeAdapter.listDevices(); }
function start(options) { return activeAdapter.start(options); }
function stop() { return activeAdapter.stop(); }
function setBypass(bypass) { return activeAdapter.setBypass(bypass); }
function loadImpulse(filePath) { return activeAdapter.loadImpulse(filePath); }
function disconnect() { return activeAdapter.disconnect(); }
function getMode() { return activeAdapter.getMode(); }

module.exports = { connect, applyProfile, getStatus, getEngineDetails, setUpdateHandler, listDevices, start, stop, setBypass, loadImpulse, disconnect, getMode };
