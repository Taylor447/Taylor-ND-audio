// Giao diện, preset, kiểm tra âm thanh và visualizer không truy cập trực tiếp Node.js.
const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const THEMES = ['amber', 'violet', 'ocean', 'forest', 'rose'];
const DEFAULT_PROFILE = () => ({
  eq: Array(10).fill(0),
  effects: { bass: 0, treble: 0, dialogue: 0, width: 0, balance: 0, reverbEnabled: false, impulsePath: '', compressorEnabled: false, vstPluginPath: '' },
  bypass: false
});
const BUILT_INS = [
  { id: 'music', name: 'Nhạc', icon: '♫', description: 'Âm nhạc cân bằng, giàu chi tiết.', profile: { eq: [2, 1.5, 1, 0, -0.5, 0.5, 1, 1.4, 1.6, 1], effects: { bass: 1, treble: 1 } } },
  { id: 'movie', name: 'Phim', icon: '▣', description: 'Lời thoại rõ, nền âm trầm sâu.', profile: { eq: [2, 2, 1, 0, 0, 1, 1.5, 1, 1, 1], effects: { bass: 2, dialogue: 2 } } },
  { id: 'game', name: 'Game', icon: '⌖', description: 'Nhấn 2–4 kHz để nghe bước chân.', profile: { eq: [0, 0, 0, 0, 0, 1, 3, 4, 1, 0], effects: { dialogue: 1 } } },
  { id: 'voice', name: 'Giọng nói', icon: '◖', description: 'Tập trung vào giọng và lời thoại.', profile: { eq: [-2, -1, 0, 1, 2, 2, 3, 2, 1, 0], effects: { bass: -2, dialogue: 3 } } },
  { id: 'bass', name: 'Bass mạnh', icon: '♫', description: 'Dải trầm nổi bật, giàu năng lượng.', profile: { eq: [4, 4, 3, 2, 0, 0, 0, 0, 0, 0], effects: { bass: 4 } } },
  { id: 'headphone', name: 'Tai nghe', icon: '◉', description: 'Âm trường rộng và cân bằng khi nghe gần.', profile: { eq: [1, 1, 0, 0, 0, 0, 1, 1, 1, 0], effects: { width: -8 } } },
  { id: 'custom', name: 'Tùy chỉnh', icon: '✧', description: 'Chất âm do bạn tự tạo.', profile: DEFAULT_PROFILE() }
];

let profile = DEFAULT_PROFILE();
let integration = { state: 'loading', message: 'Đang kiểm tra Equalizer APO…' };
let appSettings = { launchAtLogin: false, hotkey: 'Ctrl+Alt+F12', theme: 'amber', lightMode: false, engineMode: 'apo', inputId: '', outputId: '', bufferMs: 10 };
let selectedPresetId = 'custom';
let activeAutomationPresetId = null;
let renderedRuleKey = '';
const storedCustomPresets = readStored('taylor-custom-presets', []);
let customPresets = Array.isArray(storedCustomPresets) ? storedCustomPresets : [];
let debounceTimer = null;
let audioContext = null;
let testNodes = [];
let captureStream = null;
let captureContext = null;
let analyser = null;
let captureFrame = 0;
let engineDevices = [];
let engineState = { running: false, sampleRate: 0, latencyMs: 0, xruns: 0 };
let engineTelemetry = null;
let engineAnalysisLive = false;

function readStored(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function formatBand(value) { return Number(value) > 0 ? `+${value}` : `${value}`; }
function frequencyLabel(value) { return value >= 1000 ? `${value / 1000}k` : String(value); }

function setPage(page) {
  document.querySelectorAll('.page').forEach((element) => element.classList.toggle('active', element.dataset.page === page));
  document.querySelectorAll('.nav-item').forEach((element) => element.classList.toggle('active', element.dataset.go === page));
  document.getElementById('appMain').scrollTop = 0;
  if (page === 'equalizer') requestAnimationFrame(drawEqCurve);
  if (page === 'analysis' && (captureFrame || engineAnalysisLive)) requestAnimationFrame(drawCaptureFrame);
}

function setTheme(theme, persist = true) {
  if (!THEMES.includes(theme)) theme = 'amber';
  appSettings.theme = theme;
  document.body.dataset.theme = theme;
  document.querySelectorAll('[data-theme-choice]').forEach((button) => button.classList.toggle('selected', button.dataset.themeChoice === theme));
  if (persist) window.audioApp.updateSettings({ theme });
  requestAnimationFrame(drawEqCurve);
}

function setLightMode(enabled, persist = true) {
  appSettings.lightMode = Boolean(enabled);
  document.body.classList.toggle('light-mode', appSettings.lightMode);
  document.getElementById('modeGlyph').textContent = appSettings.lightMode ? '☾' : '☼';
  document.getElementById('modeToggle').lastChild.textContent = appSettings.lightMode ? ' Chế độ tối' : ' Chế độ sáng';
  document.getElementById('lightModeSetting').checked = appSettings.lightMode;
  if (persist) window.audioApp.updateSettings({ lightMode: appSettings.lightMode });
  requestAnimationFrame(drawEqCurve);
}

function syncEffectControls() {
  const effects = profile.effects;
  const fields = [
    ['bass', 'bassSlider', 'bassValue', 'quickBass', 'quickBassValue', 'dB'],
    ['treble', 'trebleSlider', 'trebleValue', null, null, 'dB'],
    ['dialogue', 'dialogueSlider', 'dialogueValue', 'quickDialogue', 'quickDialogueValue', 'dB'],
    ['width', 'widthSlider', 'widthValue', 'quickWidth', 'quickWidthValue', '%'],
    ['balance', 'balanceSlider', 'balanceValue', null, null, '']
  ];
  for (const [key, inputId, outputId, quickId, quickOutput, unit] of fields) {
    const value = Number(effects[key] || 0);
    const input = document.getElementById(inputId);
    const output = document.getElementById(outputId);
    if (input) input.value = value;
    if (output) output.textContent = key === 'width' ? `${formatBand(value)}%` : `${formatBand(value)} ${unit}`.trim();
    if (quickId) document.getElementById(quickId).value = value;
    if (quickOutput) document.getElementById(quickOutput).textContent = key === 'width' ? `${formatBand(value)}%` : `${formatBand(value)} dB`;
  }
  document.getElementById('reverbToggle').checked = Boolean(effects.reverbEnabled);
  document.getElementById('compressorToggle').checked = Boolean(effects.compressorEnabled);
  document.getElementById('impulseName').textContent = effects.impulsePath ? effects.impulsePath.split(/[\\/]/).pop() : 'Chưa chọn file impulse';
  document.getElementById('vstName').textContent = effects.vstPluginPath ? effects.vstPluginPath.split(/[\\/]/).pop() : 'Chưa chọn plugin';
  document.getElementById('vstWarning').classList.toggle('hidden', appSettings.engineMode === 'taylor' || Boolean(effects.vstPluginPath) || !effects.compressorEnabled);
}

function syncEqControls() {
  const container = document.getElementById('eqSliders');
  if (!container.children.length) {
    container.innerHTML = BANDS.map((frequency, index) => `<div class="eq-band"><output id="eqValue${index}">0</output><input aria-label="${frequency} Hz" data-band="${index}" type="range" min="-12" max="12" step="1" value="0"><label>${frequencyLabel(frequency)}</label></div>`).join('');
    container.querySelectorAll('input').forEach((input) => input.addEventListener('input', () => {
      const index = Number(input.dataset.band);
      profile.eq[index] = Number(input.value);
      document.getElementById(`eqValue${index}`).textContent = formatBand(profile.eq[index]);
      markPresetModified();
      updateScore();
      drawEqCurve();
      scheduleApply();
    }));
  }
  container.querySelectorAll('input').forEach((input) => {
    const index = Number(input.dataset.band);
    input.value = profile.eq[index] ?? 0;
    document.getElementById(`eqValue${index}`).textContent = formatBand(profile.eq[index] ?? 0);
  });
  requestAnimationFrame(drawEqCurve);
}

function scheduleApply() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    const result = await window.audioApp.applyProfile(clone(profile));
    if (result?.status) renderIntegration(result.status);
  }, 100);
}

function setEffect(key, value) {
  profile.effects[key] = value;
  syncEffectControls();
  markPresetModified();
  updateScore();
  scheduleApply();
}

function bindEffectSlider(inputId, key) {
  document.getElementById(inputId).addEventListener('input', (event) => {
    const value = Number(event.target.value);
    profile.effects[key] = value;
    syncEffectControls();
    markPresetModified();
    updateScore();
    scheduleApply();
  });
}

function applyProfileToUi(nextProfile, presetName = 'Tùy chỉnh', presetId = 'custom', writeToEngine = true) {
  const base = DEFAULT_PROFILE();
  profile = { ...base, ...clone(nextProfile), effects: { ...base.effects, ...(nextProfile.effects || {}) } };
  profile.eq = Array.from({ length: 10 }, (_, index) => clamp(profile.eq?.[index], -12, 12));
  selectedPresetId = presetId;
  document.getElementById('currentPresetName').textContent = presetName;
  syncEqControls();
  syncEffectControls();
  updateScore();
  renderPresets();
  if (writeToEngine) scheduleApply();
}

function presetProfile(preset) {
  const result = DEFAULT_PROFILE();
  const spec = preset.profile || {};
  if (Array.isArray(spec.eq)) result.eq = Array.from({ length: 10 }, (_, index) => clamp(spec.eq[index], -12, 12));
  if (spec.effects) result.effects = { ...result.effects, ...spec.effects };
  result.bypass = false;
  return result;
}

function allPresets() { return [...BUILT_INS, ...customPresets]; }

function syncAutomationPresets() {
  const payload = allPresets().map((preset) => ({ id: preset.id, name: preset.name, profile: presetProfile(preset) }));
  window.audioApp.updateAutomationPresets(payload);
  renderAutomationPresetOptions();
}

function renderAutomationPresetOptions() {
  const select = document.getElementById('autoPresetSelect');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = allPresets().map((preset) => `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</option>`).join('');
  if (allPresets().some((preset) => preset.id === previous)) select.value = previous;
}

function renderAutomationRules() {
  const rules = Array.isArray(appSettings.appRules) ? appSettings.appRules : [];
  const wrapper = document.getElementById('automationRules');
  if (!wrapper) return;
  wrapper.innerHTML = rules.map((rule, index) => {
    const preset = allPresets().find((item) => item.id === rule.presetId);
    return `<div class="automation-rule"><code>${escapeHtml(rule.processName)}</code><span>→ ${escapeHtml(preset?.name || 'Preset không còn tồn tại')}</span><button aria-label="Xóa quy tắc" data-remove-rule="${index}">×</button></div>`;
  }).join('');
  wrapper.querySelectorAll('[data-remove-rule]').forEach((button) => button.addEventListener('click', () => {
    const nextRules = [...rules]; nextRules.splice(Number(button.dataset.removeRule), 1); saveAutomationSettings({ appRules: nextRules });
  }));
}

async function saveAutomationSettings(patch) {
  const result = await window.audioApp.updateSettings(patch);
  if (!result.ok) { document.getElementById('settingsFeedback').textContent = result.message || 'Không lưu được quy tắc.'; return; }
  appSettings = { ...appSettings, ...result.settings };
  document.getElementById('autoPresetSetting').checked = Boolean(appSettings.autoPresetEnabled);
  renderAutomationRules();
  renderedRuleKey = JSON.stringify(appSettings.appRules || []);
  document.getElementById('settingsFeedback').textContent = 'Đã lưu tự động hóa preset.';
}

function renderPresets() {
  const grid = document.getElementById('presetGrid');
  grid.innerHTML = allPresets().map((preset) => `<button class="preset-card ${preset.id === selectedPresetId ? 'selected' : ''}" data-preset="${escapeHtml(preset.name)}" data-preset-id="${escapeHtml(preset.id)}"><i class="preset-selected-mark">✓</i><span class="preset-art">${escapeHtml(preset.icon || '✧')}</span><strong>${escapeHtml(preset.name)}</strong><p>${escapeHtml(preset.description || 'Preset cá nhân của bạn.')}</p><span class="preset-meta">${preset.custom ? 'PRESET CỦA BẠN' : 'TAYLOR ND AUDIO'}</span></button>`).join('');
  grid.querySelectorAll('.preset-card').forEach((card) => card.addEventListener('click', () => {
    const selected = allPresets().find((item) => item.id === card.dataset.presetId);
    if (!selected) return;
    applyProfileToUi(presetProfile(selected), selected.name, selected.id);
  }));
  const current = allPresets().find((item) => item.id === selectedPresetId);
  document.getElementById('currentPresetName').textContent = current?.name || 'Tùy chỉnh';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function markPresetModified() {
  if (selectedPresetId !== 'custom') {
    selectedPresetId = 'custom';
    document.getElementById('currentPresetName').textContent = 'Tùy chỉnh';
    document.querySelectorAll('.preset-card').forEach((card) => card.classList.toggle('selected', card.dataset.presetId === 'custom'));
  }
}

function saveCurrentPreset() {
  const name = prompt('Tên preset mới:');
  if (!name || !name.trim()) return;
  const preset = { id: `custom-${Date.now()}`, name: name.trim(), icon: '✦', description: 'Chất âm do bạn tự lưu.', profile: clone(profile), custom: true };
  customPresets.push(preset);
  localStorage.setItem('taylor-custom-presets', JSON.stringify(customPresets));
  syncAutomationPresets();
  selectedPresetId = preset.id;
  renderPresets();
}

function renameCurrentPreset() {
  const preset = customPresets.find((item) => item.id === selectedPresetId);
  if (!preset) {
    alert('Hãy lưu preset này vào thư viện trước khi đổi tên.');
    return;
  }
  const name = prompt('Tên mới cho preset:', preset.name);
  if (!name || !name.trim()) return;
  preset.name = name.trim();
  localStorage.setItem('taylor-custom-presets', JSON.stringify(customPresets));
  syncAutomationPresets();
  renderPresets();
}

function deleteCurrentPreset() {
  const index = customPresets.findIndex((item) => item.id === selectedPresetId);
  if (index < 0) {
    alert('Preset mặc định của Taylor ND Audio không thể xóa.');
    return;
  }
  if (!confirm(`Xóa preset “${customPresets[index].name}”?`)) return;
  customPresets.splice(index, 1);
  localStorage.setItem('taylor-custom-presets', JSON.stringify(customPresets));
  syncAutomationPresets();
  applyProfileToUi(DEFAULT_PROFILE(), 'Tùy chỉnh', 'custom');
}

function exportCustomPresets() {
  const payload = { app: 'Taylor ND Audio', schemaVersion: 1, exportedAt: new Date().toISOString(), presets: customPresets };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'taylor-nd-audio-presets.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function importPresets(file) {
  try {
    const payload = JSON.parse(await file.text());
    const incoming = Array.isArray(payload) ? payload : payload.presets;
    if (!Array.isArray(incoming)) throw new Error('Tệp không chứa danh sách preset.');
    const valid = incoming.filter((item) => item && typeof item.name === 'string' && item.profile && Array.isArray(item.profile.eq));
    if (!valid.length) throw new Error('Không tìm thấy preset hợp lệ.');
    const normalized = valid.map((item) => ({
      id: `custom-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      name: item.name.slice(0, 48), icon: item.icon || '✦', description: item.description || 'Preset đã nhập.',
      profile: { ...DEFAULT_PROFILE(), ...item.profile, effects: { ...DEFAULT_PROFILE().effects, ...(item.profile.effects || {}) } }, custom: true
    }));
    customPresets.push(...normalized);
    localStorage.setItem('taylor-custom-presets', JSON.stringify(customPresets));
    syncAutomationPresets();
    renderPresets();
    alert(`Đã nhập ${normalized.length} preset.`);
  } catch (error) { alert(`Không nhập được preset: ${error.message}`); }
}

function updateScore() {
  const absEq = profile.eq.reduce((sum, value) => sum + Math.abs(Number(value) || 0), 0) / profile.eq.length;
  const boost = [...profile.eq, profile.effects.bass, profile.effects.treble, profile.effects.dialogue].reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
  const balance = Math.max(0, Math.round(100 - profile.eq.reduce((sum, value) => sum + Math.abs(Number(value) || 0), 0) / 1.2));
  const score = profile.bypass ? 100 : Math.max(0, Math.min(100, Math.round(100 - absEq * 2.15 - boost * .66 - Math.max(0, -profile.effects.width) * .06)));
  document.getElementById('scoreValue').textContent = score;
  document.getElementById('scoreMeter').style.width = `${score}%`;
  document.getElementById('scoreBalance').textContent = `${balance}%`;
  document.getElementById('scoreHeadroom').textContent = boost > 0 ? `−${Math.ceil(boost)} dB` : 'Tốt';
  document.getElementById('scoreLabel').textContent = score > 88 ? 'Cân bằng hoàn hảo' : score > 70 ? 'Chất âm hài hòa' : 'Đường cong cá tính';
  const statusText = profile.bypass ? 'Bypass đang bật · âm thanh nguyên bản' : (absEq < .1 && boost === 0 ? 'Âm thanh đang ở trạng thái trung tính' : `Đang áp dụng ${document.getElementById('currentPresetName').textContent}`);
  document.getElementById('heroStatus').textContent = statusText;
  const bypassButton = document.getElementById('bypassToggle');
  if (bypassButton) {
    bypassButton.textContent = profile.bypass ? 'Tắt bypass' : 'Bypass A/B';
    bypassButton.classList.toggle('bypass-active', profile.bypass);
  }
}

function drawEqCurve() {
  const canvas = document.getElementById('eqCurve');
  if (!canvas || !canvas.clientWidth) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const left = 31, right = width - 14, top = 13, bottom = height - 24;
  const plotHeight = bottom - top;
  const xFor = (frequency) => left + (Math.log(frequency / 20) / Math.log(20000 / 20)) * (right - left);
  const yFor = (gain) => top + ((12 - gain) / 24) * plotHeight;
  const isLight = document.body.classList.contains('light-mode');
  context.font = '8px Be Vietnam Pro, Segoe UI, sans-serif';
  [-12, -6, 0, 6, 12].forEach((db) => {
    const y = yFor(db);
    context.beginPath(); context.moveTo(left, y); context.lineTo(right, y);
    context.strokeStyle = db === 0 ? (isLight ? 'rgba(40,55,85,.26)' : 'rgba(215,225,246,.23)') : (isLight ? 'rgba(40,55,85,.10)' : 'rgba(215,225,246,.085)');
    context.setLineDash(db === 0 ? [] : [3, 5]); context.stroke();
    context.fillStyle = isLight ? '#7c879d' : '#778198'; context.fillText(`${db > 0 ? '+' : ''}${db}`, 3, y + 3);
  });
  context.setLineDash([]);
  [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach((frequency) => {
    const x = xFor(frequency);
    context.beginPath(); context.moveTo(x, top); context.lineTo(x, bottom);
    context.strokeStyle = isLight ? 'rgba(40,55,85,.07)' : 'rgba(215,225,246,.055)'; context.stroke();
    context.fillStyle = isLight ? '#7c879d' : '#778198'; context.textAlign = 'center'; context.fillText(frequencyLabel(frequency), x, height - 5);
  });
  const points = [{ f: 20, g: 0 }, ...BANDS.map((f, index) => ({ f, g: Number(profile.eq[index]) || 0 })), { f: 20000, g: 0 }];
  const steps = 240;
  const values = [];
  for (let step = 0; step <= steps; step += 1) {
    const frequency = 20 * Math.pow(1000, step / steps);
    let index = 0;
    while (index < points.length - 2 && frequency > points[index + 1].f) index += 1;
    const a = points[index], b = points[index + 1];
    const t = (Math.log(frequency) - Math.log(a.f)) / (Math.log(b.f) - Math.log(a.f));
    values.push({ x: xFor(frequency), y: yFor(a.g + (b.g - a.g) * t) });
  }
  const gradient = context.createLinearGradient(0, top, 0, bottom);
  gradient.addColorStop(0, `rgba(${getComputedStyle(document.body).getPropertyValue('--accent-rgb')}, .19)`);
  gradient.addColorStop(.5, `rgba(${getComputedStyle(document.body).getPropertyValue('--accent-rgb')}, .015)`);
  gradient.addColorStop(1, `rgba(${getComputedStyle(document.body).getPropertyValue('--accent-rgb')}, .11)`);
  context.beginPath(); context.moveTo(values[0].x, bottom); values.forEach((point) => context.lineTo(point.x, point.y)); context.lineTo(values.at(-1).x, bottom); context.closePath(); context.fillStyle = gradient; context.fill();
  context.beginPath(); values.forEach((point, index) => index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y));
  context.strokeStyle = getComputedStyle(document.body).getPropertyValue('--accent-light'); context.lineWidth = 2; context.shadowColor = getComputedStyle(document.body).getPropertyValue('--accent'); context.shadowBlur = 8; context.stroke(); context.shadowBlur = 0;
  BANDS.forEach((frequency, index) => {
    const x = xFor(frequency), y = yFor(Number(profile.eq[index]) || 0);
    context.beginPath(); context.arc(x, y, 3.4, 0, Math.PI * 2); context.fillStyle = getComputedStyle(document.body).getPropertyValue('--accent-light'); context.fill();
  });
}

function renderIntegration(next) {
  integration = next || integration;
  const state = integration.state;
  const strip = document.getElementById('connectionStrip');
  const onboarding = document.getElementById('onboardingPanel');
  const appMain = document.getElementById('appMain');
  const nav = document.querySelector('.bottom-nav');
  const connected = state === 'connected';
  const needsSetup = state === 'not-installed' || state === 'unsupported';
  strip.classList.toggle('hidden', connected || needsSetup || state === 'loading');
  strip.dataset.state = state || '';
  onboarding.classList.toggle('hidden', !needsSetup);
  appMain.classList.toggle('onboarding-hidden', needsSetup);
  nav.classList.toggle('nav-hidden', needsSetup);
  document.getElementById('connectionTitle').textContent = state === 'needs-admin' ? 'Cần quyền Administrator' : 'Chưa kết nối engine';
  document.getElementById('connectionMessage').textContent = integration.message || '';
  const adminButton = document.getElementById('adminRestart');
  adminButton.classList.toggle('hidden', state !== 'needs-admin');
  document.getElementById('checkAgain').classList.toggle('hidden', state !== 'error');
  document.getElementById('settingsAdminRestart').classList.toggle('hidden', state !== 'needs-admin');
  document.getElementById('engineBadge').classList.toggle('offline', !connected);
  document.getElementById('engineBadge').innerHTML = `<i></i> ${connected ? 'Đang hoạt động' : 'Chưa kết nối'}`;
  document.getElementById('settingsEngineStatus').textContent = integration.message || (connected ? 'Đang hoạt động.' : 'Chưa kết nối.');
  document.getElementById('heroStatus').textContent = connected ? 'Engine âm thanh đã sẵn sàng' : `${appSettings.engineMode === 'taylor' ? 'Taylor Engine' : 'Equalizer APO'} chưa được kết nối`;
  renderEngineMode();
}

function renderEngineMode() {
  const taylor = appSettings.engineMode === 'taylor';
  document.getElementById('engineModeSetting').value = taylor ? 'taylor' : 'apo';
  document.getElementById('taylorDeviceCard').classList.toggle('hidden', !taylor);
  document.getElementById('settingsEngineTitle').textContent = taylor ? 'Taylor Engine' : 'Equalizer APO';
  document.getElementById('settingsEngineName').textContent = taylor ? 'Taylor Engine' : 'Equalizer APO';
  document.getElementById('settingsEngineFile').parentElement.classList.toggle('hidden', taylor);
  document.getElementById('settingsAdminRestart').classList.toggle('hidden', taylor || integration.state !== 'needs-admin');
  document.getElementById('apoDocsLink').classList.toggle('hidden', taylor);
  document.getElementById('engineModeNote').textContent = taylor
    ? 'Taylor Engine xử lý âm thanh qua VB-CABLE; hãy chọn CABLE Output làm đầu vào và loa/tai nghe thật làm đầu ra.'
    : 'Equalizer APO áp dụng hiệu ứng trên các thiết bị đã được chọn trong Configurator.';
  document.getElementById('compressorDescription').textContent = taylor
    ? 'Taylor Engine có compressor tích hợp và limiter bảo vệ luôn bật.'
    : 'Dùng plugin VST2 compressor tương thích với Equalizer APO.';
  document.getElementById('vstWarning').textContent = taylor
    ? 'Compressor tích hợp đang dùng; limiter brickwall luôn bật ở trần −1 dBFS.'
    : 'Cần chọn plugin VST compressor tương thích trước khi bật.';
  document.getElementById('vstWarning').classList.toggle('hidden', taylor || Boolean(profile.effects.vstPluginPath) || !profile.effects.compressorEnabled);
  document.getElementById('analysisDescription').textContent = taylor
    ? 'Phổ, waveform và mức peak/RMS từ tín hiệu thật đang đi qua Taylor Engine.'
    : 'Phổ, waveform và mức đỉnh từ loopback âm thanh hệ thống.';
  document.getElementById('analysisSourceLabel').textContent = taylor ? '● TAYLOR ENGINE' : '● LOOPBACK';
  document.getElementById('analysisNote').innerHTML = taylor
    ? '<span>i</span> Telemetry lấy trực tiếp từ engine. Âm thanh chỉ đi qua chuỗi xử lý tới loa/tai nghe, không được giao diện phát lại.'
    : '<span>i</span> Windows sẽ cấp quyền loopback khi bạn bắt đầu. Nếu không thấy tín hiệu, hãy phát âm thanh và kiểm tra thiết bị trong Equalizer APO.';
  updateEngineDisplay();
}

function updateDeviceOptions(devices = engineDevices) {
  engineDevices = Array.isArray(devices) ? devices : [];
  const input = document.getElementById('engineInputSelect');
  const output = document.getElementById('engineOutputSelect');
  const inputs = engineDevices.filter((device) => device.direction === 'input');
  const outputs = engineDevices.filter((device) => device.direction === 'output');
  const cableInput = outputs.find((device) => /cable input/i.test(device.name));
  const cableOutput = inputs.find((device) => /cable output/i.test(device.name));
  const previousInput = appSettings.inputId || input.value;
  const previousOutput = appSettings.outputId || output.value;
  const fill = (select, list, selected, preferred, blockVirtualOutput = false) => {
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = ''; placeholder.textContent = list.length ? 'Chọn thiết bị…' : 'Không tìm thấy thiết bị';
    select.append(placeholder);
    for (const device of list) {
      const option = document.createElement('option');
      option.value = device.id; option.textContent = `${device.name} · ${device.sampleRate} Hz`;
      if (blockVirtualOutput && /cable input/i.test(device.name)) { option.disabled = true; option.textContent += ' · không chọn làm đầu ra'; }
      select.append(option);
    }
    const chosen = list.some((device) => device.id === selected && !(blockVirtualOutput && /cable input/i.test(device.name)))
      ? selected : (preferred?.id || '');
    select.value = chosen;
  };
  fill(input, inputs, previousInput, cableOutput);
  fill(output, outputs, previousOutput, outputs.find((device) => !/cable input/i.test(device.name)), true);
  const selectedOutput = outputs.find((device) => device.id === output.value);
  if ((inputs.find((device) => device.id === input.value)?.channels || 2) > 2 || (selectedOutput?.channels || 2) > 2) {
    document.getElementById('deviceFeedback').textContent = 'Thiết bị nhiều kênh sẽ được downmix xuống stereo.';
  } else document.getElementById('deviceFeedback').textContent = '';
  const detected = Boolean(cableInput && cableOutput);
  document.getElementById('cableOnboarding').classList.toggle('hidden', detected);
  document.getElementById('cableTitle').textContent = detected ? 'Đã tìm thấy VB-CABLE' : 'Chưa tìm thấy VB-CABLE';
  document.getElementById('cableMessage').textContent = detected
    ? 'Chọn CABLE Output làm đầu vào. Đầu ra phải là loa/tai nghe thật. Trong Windows, đặt CABLE Input làm thiết bị phát mặc định.'
    : 'Tải driver VB-CABLE từ VB-Audio, giải nén và chạy Setup bằng Administrator, khởi động lại Windows rồi bấm Kiểm tra lại.';
}

function updateEngineDisplay(state = engineState) {
  engineState = { ...engineState, ...(state || {}) };
  document.getElementById('engineRunState').textContent = engineState.running ? 'Đang chạy' : 'Đã dừng';
  document.getElementById('engineRunState').classList.toggle('active', Boolean(engineState.running));
  document.getElementById('engineLatency').textContent = engineState.running ? `${Number(engineState.latencyMs || 0).toFixed(1)} ms · ${engineState.sampleRate} Hz` : '— ms';
  document.getElementById('engineXruns').textContent = String(engineState.xruns || 0);
  document.getElementById('engineStart').disabled = Boolean(engineState.running);
  document.getElementById('engineStop').disabled = !engineState.running;
}

function bindUi() {
  document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.go)));
  document.getElementById('topPresets').addEventListener('click', () => setPage('presets'));
  document.getElementById('heroPresets').addEventListener('click', () => setPage('presets'));
  document.getElementById('eqPresetButton').addEventListener('click', () => setPage('presets'));
  document.getElementById('startTuning').addEventListener('click', () => setPage('equalizer'));
  document.getElementById('continueBanner').addEventListener('click', () => setPage('effects'));
  document.querySelectorAll('[data-window-action]').forEach((button) => button.addEventListener('click', () => window.audioApp.windowAction(button.dataset.windowAction)));
  document.querySelector('.topbar').addEventListener('dblclick', (event) => {
    if (!event.target.closest('button')) window.audioApp.windowAction('maximize');
  });
  window.audioApp.onMaximized((maximized) => { document.getElementById('maximizeButton').textContent = maximized ? '❐' : '□'; });
  window.audioApp.onWindowHidden(() => {
    stopTestSound();
    if (document.getElementById('testDialog').open) document.getElementById('testDialog').close();
    stopCapture();
  });

  bindEffectSlider('bassSlider', 'bass');
  bindEffectSlider('trebleSlider', 'treble');
  bindEffectSlider('dialogueSlider', 'dialogue');
  bindEffectSlider('widthSlider', 'width');
  bindEffectSlider('balanceSlider', 'balance');
  bindEffectSlider('quickBass', 'bass');
  bindEffectSlider('quickDialogue', 'dialogue');
  bindEffectSlider('quickWidth', 'width');
  document.getElementById('reverbToggle').addEventListener('change', (event) => setEffect('reverbEnabled', event.target.checked));
  document.getElementById('compressorToggle').addEventListener('change', (event) => {
    if (event.target.checked && appSettings.engineMode !== 'taylor' && !profile.effects.vstPluginPath) {
      event.target.checked = false;
      document.getElementById('vstWarning').classList.remove('hidden');
      alert('Hãy chọn plugin VST2 compressor tương thích trước.');
      return;
    }
    setEffect('compressorEnabled', event.target.checked);
  });
  document.getElementById('chooseImpulse').addEventListener('click', async () => {
    const selected = await window.audioApp.chooseFile('impulse');
    if (selected) setEffect('impulsePath', selected);
  });
  document.getElementById('chooseVst').addEventListener('click', async () => {
    const selected = await window.audioApp.chooseFile('vst');
    if (selected) setEffect('vstPluginPath', selected);
  });

  document.getElementById('resetEq').addEventListener('click', () => {
    profile.eq = Array(10).fill(0); syncEqControls(); markPresetModified(); updateScore(); scheduleApply();
  });
  document.getElementById('bypassToggle').addEventListener('click', () => {
    profile.bypass = !profile.bypass;
    updateScore();
    scheduleApply();
  });
  document.getElementById('resetEffects').addEventListener('click', () => {
    const retained = { impulsePath: '', vstPluginPath: '', reverbEnabled: false, compressorEnabled: false };
    profile.effects = { ...DEFAULT_PROFILE().effects, ...retained };
    syncEffectControls(); markPresetModified(); updateScore(); scheduleApply();
  });
  document.getElementById('savePreset').addEventListener('click', saveCurrentPreset);
  document.getElementById('renamePreset').addEventListener('click', renameCurrentPreset);
  document.getElementById('deletePreset').addEventListener('click', deleteCurrentPreset);
  document.getElementById('exportPresets').addEventListener('click', exportCustomPresets);
  document.getElementById('importPresets').addEventListener('click', () => document.getElementById('presetFileInput').click());
  document.getElementById('presetFileInput').addEventListener('change', (event) => {
    if (event.target.files[0]) importPresets(event.target.files[0]);
    event.target.value = '';
  });

  document.getElementById('themeMenu').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(appSettings.theme) + 1) % THEMES.length]; setTheme(next);
  });
  document.querySelectorAll('[data-theme-choice]').forEach((button) => button.addEventListener('click', () => setTheme(button.dataset.themeChoice)));
  document.getElementById('modeToggle').addEventListener('click', () => setLightMode(!appSettings.lightMode));
  document.getElementById('lightModeSetting').addEventListener('change', (event) => setLightMode(event.target.checked));
  document.getElementById('autostartSetting').addEventListener('change', async (event) => {
    const result = await window.audioApp.setAutostart(event.target.checked);
    document.getElementById('settingsFeedback').textContent = result.ok ? 'Đã cập nhật tùy chọn khởi động.' : 'Không lưu được tùy chọn.';
  });
  document.getElementById('saveHotkey').addEventListener('click', async () => {
    const shortcut = document.getElementById('hotkeyInput').value.trim();
    const result = await window.audioApp.updateSettings({ hotkey: shortcut });
    document.getElementById('settingsFeedback').textContent = result.ok ? `Đã lưu phím tắt ${shortcut || '(đã tắt)'}.` : result.message;
    if (result.ok) appSettings.hotkey = shortcut;
  });
  document.getElementById('autoPresetSetting').addEventListener('change', (event) => saveAutomationSettings({ autoPresetEnabled: event.target.checked }));
  document.getElementById('engineModeSetting').addEventListener('change', async (event) => {
    const result = await window.audioApp.updateSettings({ engineMode: event.target.value });
    if (!result.ok) { document.getElementById('settingsFeedback').textContent = result.message || 'Không đổi được engine.'; return; }
    appSettings = { ...appSettings, ...result.settings };
    initializeSettings();
    document.getElementById('settingsFeedback').textContent = appSettings.engineMode === 'taylor'
      ? 'Đã chuyển sang Taylor Engine. Chọn thiết bị rồi bấm Bắt đầu engine.'
      : 'Đã chuyển về Equalizer APO.';
    if (appSettings.engineMode === 'taylor') updateDeviceOptions(await window.audioApp.listDevices());
    else stopCapture();
  });
  const saveDeviceChoice = async () => {
    appSettings.inputId = document.getElementById('engineInputSelect').value;
    appSettings.outputId = document.getElementById('engineOutputSelect').value;
    appSettings.bufferMs = Number(document.getElementById('engineBufferSelect').value) || 10;
    await window.audioApp.updateSettings({ inputId: appSettings.inputId, outputId: appSettings.outputId, bufferMs: appSettings.bufferMs });
  };
  document.getElementById('engineInputSelect').addEventListener('change', saveDeviceChoice);
  document.getElementById('engineOutputSelect').addEventListener('change', saveDeviceChoice);
  document.getElementById('engineBufferSelect').addEventListener('change', saveDeviceChoice);
  const refreshEngineDevices = async () => {
    const devices = await window.audioApp.listDevices();
    updateDeviceOptions(devices);
    document.getElementById('deviceFeedback').textContent = 'Đã yêu cầu quét lại thiết bị âm thanh.';
  };
  document.getElementById('refreshDevices').addEventListener('click', refreshEngineDevices);
  document.getElementById('checkCable').addEventListener('click', refreshEngineDevices);
  document.getElementById('openSoundSettings').addEventListener('click', async () => {
    const result = await window.audioApp.openSoundSettings();
    if (!result.ok) document.getElementById('deviceFeedback').textContent = result.message;
  });
  document.getElementById('engineStart').addEventListener('click', async () => {
    await saveDeviceChoice();
    const result = await window.audioApp.startEngine({ inputId: appSettings.inputId, outputId: appSettings.outputId, bufferMs: appSettings.bufferMs });
    document.getElementById('deviceFeedback').textContent = result.ok ? 'Engine đang khởi chạy…' : (result.message || 'Không khởi chạy được engine.');
  });
  document.getElementById('engineStop').addEventListener('click', async () => {
    const result = await window.audioApp.stopEngine();
    document.getElementById('deviceFeedback').textContent = result.message || 'Đã dừng engine.';
  });
  document.getElementById('addAutoRule').addEventListener('click', () => {
    const processName = document.getElementById('autoProcessName').value.trim().replace(/\.exe$/i, '');
    const presetId = document.getElementById('autoPresetSelect').value;
    if (!/^[a-z0-9_. -]{1,64}$/i.test(processName)) {
      document.getElementById('settingsFeedback').textContent = 'Nhập tên tiến trình hợp lệ, ví dụ chrome hoặc Spotify.';
      return;
    }
    const nextRules = (appSettings.appRules || []).filter((rule) => rule.processName.toLowerCase() !== processName.toLowerCase());
    nextRules.push({ processName, presetId });
    document.getElementById('autoProcessName').value = '';
    saveAutomationSettings({ appRules: nextRules });
  });
  document.getElementById('adminRestart').addEventListener('click', restartAdmin);
  document.getElementById('settingsAdminRestart').addEventListener('click', restartAdmin);
  document.getElementById('checkAgain').addEventListener('click', checkAgain);
  document.getElementById('onboardingCheck').addEventListener('click', checkAgain);
  document.getElementById('settingsCheckAgain').addEventListener('click', checkAgain);
  document.querySelectorAll('[data-open-url]').forEach((button) => button.addEventListener('click', () => window.audioApp.openExternal(button.dataset.openUrl)));

  document.getElementById('openTest').addEventListener('click', () => document.getElementById('testDialog').showModal());
  document.getElementById('closeTest').addEventListener('click', closeTestDialog);
  document.getElementById('testDialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) closeTestDialog(); });
  document.getElementById('playTone').addEventListener('click', playTone);
  document.getElementById('playPink').addEventListener('click', playPinkNoise);
  document.getElementById('stopSound').addEventListener('click', stopTestSound);
  document.getElementById('toneFrequency').addEventListener('input', (event) => { document.getElementById('toneFrequencyValue').textContent = `${event.target.value} Hz`; });
  document.getElementById('captureToggle').addEventListener('click', toggleCapture);
  window.addEventListener('resize', () => { drawEqCurve(); if (captureFrame) drawCaptureFrame(); });
}

async function restartAdmin() {
  const result = await window.audioApp.restartAdmin();
  if (!result.ok) alert(result.message);
}

async function checkAgain() {
  document.getElementById('connectionTitle').textContent = 'Đang kiểm tra…';
  const status = await window.audioApp.checkAgain();
  renderIntegration(status);
}

function stopTestSound() {
  for (const node of testNodes) {
    try { node.stop?.(); } catch {}
    try { node.disconnect?.(); } catch {}
  }
  testNodes = [];
  document.getElementById('stopSound').classList.add('hidden');
}

function closeTestDialog() {
  stopTestSound();
  document.getElementById('testDialog').close();
}

async function getAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!audioContext) audioContext = new AudioContextClass();
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}

async function playTone() {
  stopTestSound();
  const context = await getAudioContext();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = Number(document.getElementById('toneFrequency').value);
  gain.gain.value = 0.045;
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  testNodes = [oscillator, gain];
  document.getElementById('stopSound').classList.remove('hidden');
}

async function playPinkNoise() {
  stopTestSound();
  const context = await getAudioContext();
  const length = context.sampleRate * 3;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    b0 = .99886 * b0 + white * .0555179;
    b1 = .99332 * b1 + white * .0750759;
    b2 = .96900 * b2 + white * .1538520;
    b3 = .86650 * b3 + white * .3104856;
    b4 = .55000 * b4 + white * .5329522;
    b5 = -.7616 * b5 - white * .0168980;
    data[index] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * .5362) * .055;
    b6 = white * .115926;
  }
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer; source.loop = true; gain.gain.value = .6;
  source.connect(gain).connect(context.destination); source.start();
  testNodes = [source, gain];
  document.getElementById('stopSound').classList.remove('hidden');
}

async function toggleCapture() {
  if (appSettings.engineMode === 'taylor') {
    engineAnalysisLive = !engineAnalysisLive;
    document.getElementById('captureToggle').textContent = engineAnalysisLive ? 'Dừng phân tích' : 'Bắt đầu phân tích';
    document.getElementById('captureState').textContent = engineState.running
      ? (engineAnalysisLive ? 'Đang nhận telemetry từ Taylor Engine' : 'Đã dừng phân tích')
      : 'Hãy khởi chạy Taylor Engine để có telemetry';
    document.getElementById('captureDot').classList.toggle('active', engineAnalysisLive && engineState.running);
    if (engineAnalysisLive) captureFrame = requestAnimationFrame(drawCaptureFrame);
    else { if (captureFrame) cancelAnimationFrame(captureFrame); captureFrame = 0; }
    return;
  }
  if (captureStream) { stopCapture(); return; }
  try {
    captureStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    // Dừng ngay track video tạm; analyzer chỉ giữ lại loopback audio.
    captureStream.getVideoTracks().forEach((track) => track.stop());
    captureContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = captureContext.createMediaStreamSource(captureStream);
    analyser = captureContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = .78;
    // Chỉ nối nguồn vào analyser; không có kết nối tới destination nên không phát lại loopback.
    source.connect(analyser);
    captureStream.getAudioTracks().forEach((track) => track.addEventListener('ended', stopCapture));
    document.getElementById('captureToggle').textContent = 'Dừng phân tích';
    document.getElementById('captureState').textContent = 'Đang phân tích âm thanh hệ thống';
    document.getElementById('captureDot').classList.add('active');
    captureFrame = requestAnimationFrame(drawCaptureFrame);
  } catch (error) {
    stopCapture();
    document.getElementById('captureState').textContent = error.name === 'NotAllowedError' ? 'Không cấp được quyền loopback' : `Không bắt được âm thanh: ${error.message}`;
  }
}

function stopCapture() {
  engineAnalysisLive = false;
  if (captureFrame) cancelAnimationFrame(captureFrame);
  captureFrame = 0;
  captureStream?.getTracks().forEach((track) => track.stop());
  captureStream = null;
  if (captureContext) captureContext.close().catch(() => {});
  captureContext = null; analyser = null;
  document.getElementById('captureToggle').textContent = 'Bắt đầu phân tích';
  document.getElementById('captureDot').classList.remove('active');
  document.getElementById('captureState').textContent = 'Chưa bắt đầu';
  document.getElementById('peakMeter').innerHTML = '−∞ <small>dBFS</small>';
  document.getElementById('rmsMeter').innerHTML = '−∞ <small>dBFS</small>';
  document.getElementById('peakBar').style.width = '0%';
  document.getElementById('rmsBar').style.width = '0%';
  clearCanvas('spectrumCanvas'); clearCanvas('waveCanvas');
}

function clearCanvas(id) {
  const canvas = document.getElementById(id);
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function prepareCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height) return null;
  canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  const context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawCaptureFrame() {
  if (appSettings.engineMode === 'taylor') {
    if (!engineAnalysisLive) { captureFrame = 0; return; }
    if (engineTelemetry) drawEngineTelemetry(engineTelemetry);
    captureFrame = requestAnimationFrame(drawCaptureFrame);
    return;
  }
  if (!analyser) { captureFrame = 0; return; }
  const spectrum = document.getElementById('spectrumCanvas');
  const waveform = document.getElementById('waveCanvas');
  const spec = prepareCanvas(spectrum), wave = prepareCanvas(waveform);
  if (!spec || !wave) { captureFrame = requestAnimationFrame(drawCaptureFrame); return; }
  const bytes = new Uint8Array(analyser.frequencyBinCount);
  const time = new Float32Array(analyser.fftSize);
  analyser.getByteFrequencyData(bytes); analyser.getFloatTimeDomainData(time);
  drawSpectrum(spec, bytes, captureContext.sampleRate, analyser.fftSize);
  drawWaveform(wave, time);
  let peak = 0, square = 0;
  for (const sample of time) { const absolute = Math.abs(sample); peak = Math.max(peak, absolute); square += sample * sample; }
  const rms = Math.sqrt(square / time.length);
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -96;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -96;
  document.getElementById('peakMeter').innerHTML = `${peakDb.toFixed(1)} <small>dBFS</small>`;
  document.getElementById('rmsMeter').innerHTML = `${rmsDb.toFixed(1)} <small>dBFS</small>`;
  document.getElementById('peakBar').style.width = `${clamp((peakDb + 60) / 60 * 100, 0, 100)}%`;
  document.getElementById('rmsBar').style.width = `${clamp((rmsDb + 60) / 60 * 100, 0, 100)}%`;
  captureFrame = requestAnimationFrame(drawCaptureFrame);
}

function drawEngineTelemetry(data) {
  const spectrum = document.getElementById('spectrumCanvas');
  const waveform = document.getElementById('waveCanvas');
  const spec = prepareCanvas(spectrum), wave = prepareCanvas(waveform);
  if (!spec || !wave) return;
  const fft = new Uint8Array(1025);
  const bins = Array.isArray(data.spectrum) ? data.spectrum : [];
  for (let bin = 1; bin < fft.length; bin += 1) {
    const hz = bin * (Number(data.sampleRate) || 48_000) / 2048;
    const position = clamp(Math.floor(Math.log(Math.max(20, hz) / 20) / Math.log(1000) * 64), 0, Math.max(0, bins.length - 1));
    fft[bin] = clamp(((Number(bins[position]) || -90) + 90) / 90 * 255, 0, 255);
  }
  drawSpectrum(spec, fft, Number(data.sampleRate) || 48_000, 2048);
  drawWaveform(wave, Float32Array.from(data.waveform || []));
  const peak = Math.max(Number(data.peakL) || 0, Number(data.peakR) || 0);
  const rms = Math.max(Number(data.rmsL) || 0, Number(data.rmsR) || 0);
  const peakDb = peak > 0 ? 20 * Math.log10(peak) : -96;
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -96;
  document.getElementById('peakMeter').innerHTML = `${peakDb.toFixed(1)} <small>dBFS</small>`;
  document.getElementById('rmsMeter').innerHTML = `${rmsDb.toFixed(1)} <small>dBFS</small>`;
  document.getElementById('peakBar').style.width = `${clamp((peakDb + 60) / 60 * 100, 0, 100)}%`;
  document.getElementById('rmsBar').style.width = `${clamp((rmsDb + 60) / 60 * 100, 0, 100)}%`;
  document.getElementById('captureState').textContent = `Taylor Engine · ${Number(data.sampleRate) || 0} Hz`;
  document.getElementById('captureDot').classList.toggle('active', Boolean(engineState.running));
}

function drawSpectrum(surface, data, sampleRate, fftSize) {
  const { context, width, height } = surface;
  const isLight = document.body.classList.contains('light-mode');
  context.clearRect(0, 0, width, height);
  const left = 29, right = width - 8, top = 12, bottom = height - 25;
  const lineColor = isLight ? 'rgba(53,68,98,.10)' : 'rgba(212,223,248,.09)';
  context.font = '8px Be Vietnam Pro, Segoe UI, sans-serif';
  [0, .25, .5, .75, 1].forEach((part) => {
    const y = top + part * (bottom - top); context.beginPath(); context.moveTo(left, y); context.lineTo(right, y); context.strokeStyle = lineColor; context.stroke();
  });
  const minFrequency = 20, maxFrequency = sampleRate / 2;
  const logMax = Math.log(Math.min(20000, maxFrequency) / minFrequency);
  [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].forEach((frequency) => {
    if (frequency > maxFrequency) return;
    const x = left + Math.log(frequency / minFrequency) / logMax * (right - left);
    context.beginPath(); context.moveTo(x, top); context.lineTo(x, bottom); context.strokeStyle = lineColor; context.stroke();
    context.fillStyle = isLight ? '#7c879d' : '#778198'; context.textAlign = 'center'; context.fillText(frequencyLabel(frequency), x, height - 7);
  });
  const columns = Math.max(1, Math.floor((right - left) / 3));
  const gradient = context.createLinearGradient(0, bottom, 0, top);
  gradient.addColorStop(0, getComputedStyle(document.body).getPropertyValue('--accent-dark'));
  gradient.addColorStop(.55, getComputedStyle(document.body).getPropertyValue('--accent'));
  gradient.addColorStop(1, getComputedStyle(document.body).getPropertyValue('--accent-light'));
  const binFrequency = sampleRate / fftSize;
  for (let column = 0; column < columns; column += 1) {
    const f0 = minFrequency * Math.pow(Math.min(20000, maxFrequency) / minFrequency, column / columns);
    const f1 = minFrequency * Math.pow(Math.min(20000, maxFrequency) / minFrequency, (column + 1) / columns);
    const start = Math.max(1, Math.floor(f0 / binFrequency));
    const end = Math.max(start + 1, Math.floor(f1 / binFrequency));
    let peak = 0;
    for (let bin = start; bin < Math.min(end, data.length); bin += 1) peak = Math.max(peak, data[bin]);
    const barHeight = Math.max(1, (peak / 255) * (bottom - top));
    context.fillStyle = gradient;
    context.fillRect(left + column * ((right - left) / columns), bottom - barHeight, Math.max(1, (right - left) / columns - .7), barHeight);
  }
}

function drawWaveform(surface, data) {
  const { context, width, height } = surface;
  const isLight = document.body.classList.contains('light-mode');
  context.clearRect(0, 0, width, height);
  const left = 8, right = width - 8, middle = height / 2;
  context.beginPath(); context.moveTo(left, middle); context.lineTo(right, middle); context.strokeStyle = isLight ? 'rgba(53,68,98,.15)' : 'rgba(212,223,248,.12)'; context.stroke();
  const gradient = context.createLinearGradient(left, 0, right, 0);
  gradient.addColorStop(0, getComputedStyle(document.body).getPropertyValue('--accent-dark'));
  gradient.addColorStop(.5, getComputedStyle(document.body).getPropertyValue('--accent-light'));
  gradient.addColorStop(1, getComputedStyle(document.body).getPropertyValue('--accent'));
  context.beginPath();
  const step = Math.ceil(data.length / Math.max(1, (right - left)));
  for (let pixel = 0; pixel < right - left; pixel += 1) {
    let min = 1, max = -1;
    for (let index = pixel * step; index < Math.min(data.length, (pixel + 1) * step); index += 1) { min = Math.min(min, data[index]); max = Math.max(max, data[index]); }
    context.moveTo(left + pixel, middle + min * middle * .88);
    context.lineTo(left + pixel, middle + max * middle * .88);
  }
  context.strokeStyle = gradient; context.lineWidth = 1.25; context.shadowColor = getComputedStyle(document.body).getPropertyValue('--accent'); context.shadowBlur = 6; context.stroke(); context.shadowBlur = 0;
}

function initializeSettings() {
  document.getElementById('autostartSetting').checked = Boolean(appSettings.launchAtLogin);
  document.getElementById('hotkeyInput').value = appSettings.hotkey || '';
  document.getElementById('autoPresetSetting').checked = Boolean(appSettings.autoPresetEnabled);
  document.getElementById('engineBufferSelect').value = String([5, 10, 20].includes(Number(appSettings.bufferMs)) ? Number(appSettings.bufferMs) : 10);
  setTheme(appSettings.theme, false);
  setLightMode(appSettings.lightMode, false);
  renderEngineMode();
  const ruleKey = JSON.stringify(appSettings.appRules || []);
  if (ruleKey !== renderedRuleKey) { renderAutomationPresetOptions(); renderAutomationRules(); renderedRuleKey = ruleKey; }
}

async function initialize() {
  bindUi();
  syncEqControls(); syncEffectControls(); renderPresets(); updateScore();
  syncAutomationPresets();
  window.audioApp.onStatus((payload) => {
    if (payload.integration) renderIntegration(payload.integration);
    if (payload.settings) { appSettings = { ...appSettings, ...payload.settings }; initializeSettings(); }
    if (payload.automationPresetId !== activeAutomationPresetId) {
      activeAutomationPresetId = payload.automationPresetId || null;
      const preset = allPresets().find((item) => item.id === activeAutomationPresetId);
      if (preset && payload.profile) applyProfileToUi(payload.profile, preset.name, preset.id, false);
    }
    if (payload.profile && typeof payload.profile.bypass === 'boolean' && payload.profile.bypass !== profile.bypass) {
      profile.bypass = payload.profile.bypass;
      updateScore();
    }
  });
  window.audioApp.onEngineUpdate((payload) => {
    if (payload.devices) updateDeviceOptions(payload.devices);
    if (payload.engineState) updateEngineDisplay(payload.engineState);
    if (payload.telemetry) {
      engineTelemetry = payload.telemetry;
      if (engineAnalysisLive && !captureFrame) captureFrame = requestAnimationFrame(drawCaptureFrame);
    }
    if (payload.integration) renderIntegration(payload.integration);
    if (payload.engineError) {
      document.getElementById('deviceFeedback').textContent = payload.engineError.message || 'Taylor Engine gặp lỗi.';
      if (payload.engineError.code === 'FALLBACK_SUGGESTED') {
        appSettings.engineMode = 'taylor';
        document.getElementById('engineModeSetting').value = 'taylor';
        renderEngineMode();
        document.getElementById('settingsFeedback').textContent = 'Engine gặp lỗi liên tục. Có thể chuyển sang Equalizer APO trong mục Chế độ xử lý.';
      }
    }
  });
  const initial = await window.audioApp.getState();
  if (initial.profile) {
    profile = { ...DEFAULT_PROFILE(), ...initial.profile, effects: { ...DEFAULT_PROFILE().effects, ...initial.profile.effects } };
    activeAutomationPresetId = initial.automationPresetId || null;
    const activePreset = allPresets().find((item) => item.id === activeAutomationPresetId);
    if (activePreset) applyProfileToUi(profile, activePreset.name, activePreset.id, false);
  }
  if (initial.settings) appSettings = { ...appSettings, ...initial.settings };
  if (initial.devices) updateDeviceOptions(initial.devices);
  if (initial.engineState) updateEngineDisplay(initial.engineState);
  initializeSettings(); syncEqControls(); syncEffectControls(); updateScore(); renderIntegration(initial.integration);
  renderPresets();
  document.getElementById('captureState').textContent = 'Chưa bắt đầu';
}

initialize().catch((error) => {
  document.getElementById('connectionStrip').classList.remove('hidden');
  document.getElementById('connectionTitle').textContent = 'Không thể khởi tạo ứng dụng';
  document.getElementById('connectionMessage').textContent = error.message;
});
