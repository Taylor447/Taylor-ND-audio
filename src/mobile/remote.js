// Giao diện điện thoại; chỉ gửi các tham số EQ và hiệu ứng an toàn đã chọn.
(() => {
  'use strict';

  const connection = document.getElementById('connectionState');
  const pairingMessage = document.getElementById('pairingMessage');
  const controlApp = document.getElementById('controlApp');
  const feedback = document.getElementById('feedback');
  const eqFrequencies = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];
  const effectDefinitions = [
    { key: 'bass', label: 'Bass', min: -12, max: 12, unit: 'dB' },
    { key: 'treble', label: 'Treble', min: -12, max: 12, unit: 'dB' },
    { key: 'dialogue', label: 'Giọng nói', min: -12, max: 12, unit: 'dB' },
    { key: 'width', label: 'Độ rộng âm trường', min: -35, max: 35, unit: '%' },
    { key: 'balance', label: 'Cân bằng L/R', min: -100, max: 100, unit: '%' }
  ];
  let socket = null;
  let state = null;
  let reconnectTimer = null;
  let applyTimer = null;
  let requestCounter = 0;
  let intentionalClose = false;

  const frequenciesLabel = (value) => /^\d+k$/.test(value) ? `${value.slice(0, -1)} kHz` : `${value} Hz`;
  const formatDb = (value) => `${Number(value) > 0 ? '+' : ''}${Number(value)} dB`;
  const formatEffect = (definition, value) => definition.unit === 'dB'
    ? formatDb(value)
    : `${Number(value) > 0 ? '+' : ''}${Number(value)}${definition.unit ? ` ${definition.unit}` : ''}`;

  function setConnection(kind, message) {
    connection.className = `connection ${kind || ''}`.trim();
    connection.querySelector('span').textContent = message;
  }

  function showFeedback(message, isError = false) {
    feedback.textContent = message || '';
    feedback.style.color = isError ? 'var(--danger)' : 'var(--ok)';
  }

  function makeSliderCard(label, id, value, min, max, outputText) {
    const card = document.createElement('div');
    card.className = 'slider-card';
    const top = document.createElement('div');
    top.className = 'slider-top';
    const caption = document.createElement('label');
    caption.htmlFor = id;
    caption.textContent = label;
    const output = document.createElement('output');
    output.htmlFor = id;
    output.value = outputText;
    const input = document.createElement('input');
    input.type = 'range'; input.id = id; input.min = String(min); input.max = String(max); input.step = '1'; input.value = String(value);
    input.setAttribute('aria-label', label);
    top.append(caption, output);
    card.append(top, input);
    input.addEventListener('input', () => {
      output.value = id.startsWith('eq-') ? formatDb(input.value) : formatEffect(effectDefinitions.find((item) => `effect-${item.key}` === id), input.value);
      if (!state) return;
      if (id.startsWith('eq-')) state.profile.eq[Number(id.slice(3))] = Number(input.value);
      else {
        const effect = effectDefinitions.find((item) => `effect-${item.key}` === id);
        if (effect) state.profile.effects[effect.key] = Number(input.value);
      }
      queueProfileUpdate();
    }, { passive: true });
    return card;
  }

  function renderControls() {
    if (!state) return;
    const eq = document.getElementById('eqControls');
    const effects = document.getElementById('effectControls');
    eq.replaceChildren();
    effects.replaceChildren();
    eqFrequencies.forEach((frequency, index) => {
      eq.append(makeSliderCard(frequenciesLabel(frequency), `eq-${index}`, state.profile.eq[index] || 0, -12, 12, formatDb(state.profile.eq[index] || 0)));
    });
    effectDefinitions.forEach((definition) => {
      const value = state.profile.effects[definition.key] || 0;
      effects.append(makeSliderCard(definition.label, `effect-${definition.key}`, value, definition.min, definition.max, formatEffect(definition, value)));
    });
    renderPresets();
    renderStatus();
  }

  function renderPresets() {
    const target = document.getElementById('presetList');
    target.replaceChildren();
    if (!state.presets?.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'Mở app trên máy tính để đồng bộ danh sách preset.'; target.append(empty); return;
    }
    state.presets.forEach((preset) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'preset-button'; button.textContent = preset.name;
      button.addEventListener('click', () => send({ type: 'applyPreset', id: preset.id }));
      target.append(button);
    });
  }

  function renderStatus() {
    document.getElementById('engineSummary').textContent = state.integration?.message || 'Taylor ND Audio đang chạy trên máy tính.';
    const button = document.getElementById('bypassButton');
    const bypass = Boolean(state.profile?.bypass);
    button.setAttribute('aria-pressed', String(bypass));
    button.textContent = bypass ? 'Bật hiệu ứng' : 'Tắt hiệu ứng';
  }

  function applyState(next, rebuild = false) {
    if (!next?.profile) return;
    state = {
      profile: { ...next.profile, eq: next.profile.eq.slice(0, 10), effects: { ...next.profile.effects } },
      presets: Array.isArray(next.presets) ? next.presets : [],
      integration: next.integration || {},
      engine: next.engine || {}
    };
    if (rebuild) {
      pairingMessage.hidden = true;
      controlApp.hidden = false;
      renderControls();
    } else {
      document.querySelectorAll('#eqControls input[type="range"]').forEach((input) => {
        const value = state.profile.eq[Number(input.id.slice(3))] || 0;
        if (document.activeElement !== input) input.value = String(value);
        input.parentElement.querySelector('output').value = formatDb(value);
      });
      effectDefinitions.forEach((definition) => {
        const input = document.getElementById(`effect-${definition.key}`);
        if (!input) return;
        const value = state.profile.effects[definition.key] || 0;
        if (document.activeElement !== input) input.value = String(value);
        input.parentElement.querySelector('output').value = formatEffect(definition, value);
      });
      renderStatus();
    }
  }

  function queueProfileUpdate() {
    window.clearTimeout(applyTimer);
    showFeedback('Đang cập nhật âm thanh…');
    applyTimer = window.setTimeout(() => send({ type: 'setProfile', profile: state.profile }), 160);
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) { showFeedback('Điện thoại chưa kết nối với máy tính.', true); return; }
    socket.send(JSON.stringify({ ...message, requestId: String(++requestCounter) }));
  }

  function connect() {
    if (intentionalClose) return;
    const storageKey = `tnd-remote-token:${location.origin}`;
    let token = location.hash.slice(1);
    if (token) {
      try { localStorage.setItem(storageKey, token); } catch {}
      history.replaceState(null, '', location.pathname);
    } else {
      try { token = localStorage.getItem(storageKey) || ''; } catch { token = ''; }
    }
    if (!token) {
      setConnection('error', 'Chưa ghép nối'); pairingMessage.hidden = false; controlApp.hidden = true; return;
    }

    setConnection('', 'Đang kết nối…');
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/control`);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'auth', token })));
    socket.addEventListener('message', (event) => {
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'paired') { setConnection('connected', 'Đã kết nối'); applyState(message.state, true); showFeedback('Đã ghép nối với máy tính.'); }
      else if (message.type === 'state') applyState(message.state);
      else if (message.type === 'ack') {
        if (message.state) applyState(message.state);
        showFeedback(message.ok ? (message.message || 'Đã áp dụng.') : (message.message || 'Không áp dụng được.'), !message.ok);
      } else if (message.type === 'error') showFeedback(message.message || 'Có lỗi khi gửi lệnh.', true);
    });
    socket.addEventListener('close', (event) => {
      setConnection('error', 'Mất kết nối');
      if (event.reason) showFeedback(event.reason, true);
      if (event.code === 1008) {
        intentionalClose = true;
        showFeedback('Mã ghép nối không còn hiệu lực. Hãy quét QR mới từ app Windows.', true);
        return;
      }
      if (!intentionalClose) reconnectTimer = window.setTimeout(connect, 3500);
    });
    socket.addEventListener('error', () => setConnection('error', 'Không thấy máy tính'));
  }

  document.getElementById('bypassButton').addEventListener('click', () => {
    if (!state) return;
    send({ type: 'setBypass', bypass: !state.profile.bypass });
  });
  document.getElementById('resetEq').addEventListener('click', () => {
    if (!state) return;
    state.profile.eq = Array(10).fill(0);
    renderControls();
    queueProfileUpdate();
  });
  window.addEventListener('pagehide', () => {
    intentionalClose = true;
    window.clearTimeout(reconnectTimer);
    socket?.close();
  });

  connect();
})();
