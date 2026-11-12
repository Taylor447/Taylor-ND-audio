// Giao diện website thuần JavaScript: i18n, demo âm thanh và đồ họa phổ.
(() => {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const languageButton = document.getElementById("languageToggle");
  const themeButton = document.getElementById("themeToggle");
  const menuButton = document.getElementById("menuToggle");
  const mobileNav = document.getElementById("mobileNav");
  const dictionaries = {};
  const canvasGradientCache = new WeakMap();
  let language = "vi";
  let audio = null;
  let visualFrame = 0;
  let demoAnalyser = null;
  let bypassed = false;
  const demoFilters = [];
  const demoSources = [];

  function textValue(element, value) {
    if (element.hasAttribute("data-i18n-html")) {
      element.innerHTML = value;
      return;
    }
    const firstText = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
    if (firstText && Array.from(element.children).length) {
      firstText.textContent = value + " ";
      return;
    }
    element.textContent = value;
  }

  function applyLanguage(next) {
    const dictionary = dictionaries[next];
    if (!dictionary) return;
    language = next;
    root.lang = next;
    document.title = "Taylor ND Audio · Power Your Sound";
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const value = dictionary[element.dataset.i18n];
      if (typeof value === "string") textValue(element, value);
    });
    const themeLabel = themeButton.querySelector(".theme-label");
    if (themeLabel) themeLabel.textContent = body.classList.contains("light-mode") ? dictionary.themeDark : dictionary.themeLight;
    document.querySelectorAll("[data-i18n-aria]").forEach((element) => {
      const value = dictionary[element.dataset.i18nAria];
      if (typeof value === "string") element.setAttribute("aria-label", value);
    });
    languageButton.textContent = next === "vi" ? "EN" : "VI";
    languageButton.setAttribute("aria-label", next === "vi" ? "EN — Switch language to English" : "VI — Chuyển ngôn ngữ sang tiếng Việt");
    languageButton.title = languageButton.getAttribute("aria-label");
    const themeGlyph = body.classList.contains("light-mode") ? "☾" : "☼";
    const themeText = body.classList.contains("light-mode") ? dictionary.themeDark : dictionary.themeLight;
    themeButton.setAttribute("aria-label", themeGlyph + " " + themeText);
    menuButton.setAttribute("aria-label", mobileNav.hidden ? (next === "vi" ? "Mở điều hướng" : "Open navigation") : (next === "vi" ? "Đóng điều hướng" : "Close navigation"));
    updateDemoLabels();
    const status = document.getElementById("downloadStatus");
    if (status && !config.downloadUrl) status.textContent = dictionary.downloadWait;
  }

  function updateDemoLabels() {
    const dictionary = dictionaries[language] || {};
    const mode = document.getElementById("demoMode");
    const buttonText = document.querySelector("#demoToggle span:last-child");
    const toggle = document.getElementById("abToggle");
    const badge = toggle.querySelector("b");
    if (buttonText) buttonText.textContent = audio ? dictionary.demoStop : dictionary.demoStart;
    if (mode) mode.textContent = audio ? (bypassed ? dictionary.demoBypass : dictionary.demoEnabled) : dictionary.demoDry;
    if (badge) badge.textContent = bypassed ? dictionary.abOff : dictionary.abOn;
  }

  async function loadLanguage(name) {
    if (dictionaries[name]) return dictionaries[name];
    const response = await fetch("i18n/" + name + ".json", { cache: "no-cache" });
    if (!response.ok) throw new Error("Không thể tải gói ngôn ngữ " + name);
    dictionaries[name] = await response.json();
    return dictionaries[name];
  }

  function setTheme(light) {
    body.classList.toggle("light-mode", light);
    themeButton.querySelector("span:first-child").textContent = light ? "☾" : "☼";
    const label = themeButton.querySelector(".theme-label");
    if (label) label.textContent = light ? (dictionaries[language]?.themeDark || "Chế độ tối") : (dictionaries[language]?.themeLight || "Chế độ sáng");
    applyLanguage(language);
  }

  function closeMobileMenu() {
    mobileNav.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
    applyLanguage(language);
  }

  menuButton.addEventListener("click", () => {
    const open = mobileNav.hidden;
    mobileNav.hidden = !open;
    menuButton.setAttribute("aria-expanded", String(open));
    applyLanguage(language);
  });
  mobileNav.querySelectorAll("a").forEach((link) => link.addEventListener("click", closeMobileMenu));
  languageButton.addEventListener("click", async () => {
    const next = language === "vi" ? "en" : "vi";
    try {
      await loadLanguage(next);
      applyLanguage(next);
    } catch (error) {
      console.error("Không tải được gói ngôn ngữ:", error);
    }
  });
  themeButton.addEventListener("click", () => setTheme(!body.classList.contains("light-mode")));
  document.getElementById("year").textContent = String(new Date().getFullYear());

  function dimensions(canvas) {
    const measured = { width: canvas.width, height: canvas.height, ratio: 1 };
    if (canvasGradientCache.has(canvas)) return measured;
    const ctx = canvas.getContext("2d", { alpha: false });
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#ffe58a");
    gradient.addColorStop(.54, "#f5b82e");
    gradient.addColorStop(1, "#b8791a");
    canvasGradientCache.set(canvas, gradient);
    return measured;
  }

  function paintSpectrum(canvas, analyser, phase, isDemo) {
    const ctx = canvas.getContext("2d", { alpha: false });
    const size = dimensions(canvas);
    const w = size.width;
    const h = size.height;
    ctx.setTransform(size.ratio, 0, 0, size.ratio, 0, 0);
    ctx.fillStyle = body.classList.contains("light-mode") ? "#edf0f5" : "#0b1120";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = body.classList.contains("light-mode") ? "rgba(25,39,63,.09)" : "rgba(224,232,250,.09)";
    ctx.lineWidth = 1;
    for (let row = 1; row < 4; row += 1) {
      const y = Math.round((h * row) / 4) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }

    let values = null;
    if (analyser) {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      values = data;
    }
    const count = isDemo ? 48 : 32;
    const gap = isDemo ? 3 : 4;
    const barWidth = Math.max(1, (w - (count - 1) * gap) / count);
    const gradient = canvasGradientCache.get(canvas);
    for (let i = 0; i < count; i += 1) {
      let amplitude;
      if (values) {
        const index = Math.min(values.length - 1, Math.floor((i / count) * values.length * 0.72));
        amplitude = values[index] / 255;
      } else {
        const curve = Math.exp(-Math.pow((i / count - 0.47) * 2.7, 2));
        const wave = .22 + .32 * Math.sin(phase * .0017 + i * .52) + .18 * Math.sin(phase * .00073 + i * .2);
        amplitude = curve * wave + .045;
      }
      const barHeight = Math.max(2, Math.min(h * .84, amplitude * h * .86));
      const x = i * (barWidth + gap);
      ctx.fillStyle = gradient;
      const radius = Math.min(4, barWidth / 2);
      ctx.beginPath();
      ctx.roundRect(x, h - barHeight, barWidth, barHeight, radius);
      ctx.fill();
    }
    ctx.fillStyle = body.classList.contains("light-mode") ? "#7e8797" : "#758198";
    ctx.font = "8px Be Vietnam Pro, sans-serif";
    ctx.fillText(isDemo ? "LOW" : "LOW", 2, h - 4);
    ctx.fillText(isDemo ? "HIGH" : "HIGH", Math.max(2, w - 28), h - 4);
  }

  function animateDemo() {
    const canvas = document.getElementById("demoSpectrum");
    if (!canvas || !audio) return;
    paintSpectrum(canvas, demoAnalyser, performance.now(), true);
    visualFrame = requestAnimationFrame(animateDemo);
  }

  function pinkNoiseBuffer(context) {
    const duration = 2;
    const length = Math.floor(context.sampleRate * duration);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = .99886 * b0 + white * .0555179;
      b1 = .99332 * b1 + white * .0750759;
      b2 = .969 * b2 + white * .153852;
      b3 = .8665 * b3 + white * .3104856;
      b4 = .55 * b4 + white * .5329522;
      b5 = -.7616 * b5 - white * .016898;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * .5362) * .075;
      b6 = white * .115926;
    }
    return buffer;
  }

  function setBypass(enabled) {
    if (!audio) return;
    bypassed = Boolean(enabled);
    const now = audio.context.currentTime;
    audio.dry.gain.cancelScheduledValues(now);
    audio.wet.gain.cancelScheduledValues(now);
    audio.dry.gain.setTargetAtTime(bypassed ? .85 : 0, now, .035);
    audio.wet.gain.setTargetAtTime(bypassed ? 0 : .85, now, .035);
    const button = document.getElementById("abToggle");
    button.setAttribute("aria-pressed", String(bypassed));
    updateDemoLabels();
  }

  async function startDemo() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      document.getElementById("demoStatus").textContent = dictionaries[language].demoUnsupported;
      return;
    }
    const context = new AudioContext();
    await context.resume();
    const bus = context.createGain();
    const dry = context.createGain();
    const wet = context.createGain();
    const master = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = .76;
    master.gain.value = .42;
    dry.gain.value = 0;
    wet.gain.value = .85;

    const oscA = context.createOscillator();
    const oscB = context.createOscillator();
    const toneGain = context.createGain();
    const secondGain = context.createGain();
    oscA.type = "sine"; oscA.frequency.value = 220;
    oscB.type = "sine"; oscB.frequency.value = 440;
    toneGain.gain.value = .14; secondGain.gain.value = .045;
    oscA.connect(toneGain); oscB.connect(secondGain);
    toneGain.connect(bus); secondGain.connect(bus);

    const noise = context.createBufferSource();
    const noiseGain = context.createGain();
    noise.buffer = pinkNoiseBuffer(context);
    noise.loop = true; noiseGain.gain.value = .48;
    noise.connect(noiseGain); noiseGain.connect(bus);

    const frequencies = [100, 300, 1000, 4000, 10000];
    const filters = frequencies.map((frequency) => {
      const filter = context.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = frequency;
      filter.Q.value = 1.05;
      filter.gain.value = 0;
      return filter;
    });
    bus.connect(dry);
    dry.connect(master);
    let chain = bus;
    filters.forEach((filter) => { chain.connect(filter); chain = filter; });
    chain.connect(wet);
    wet.connect(master);
    master.connect(analyser);
    analyser.connect(context.destination);
    oscA.start(); oscB.start(); noise.start();
    audio = { context: context, sources: [oscA, oscB, noise], dry: dry, wet: wet, master: master };
    demoAnalyser = analyser;
    demoFilters.splice(0, demoFilters.length, ...filters);
    document.querySelectorAll("#demoSliders input").forEach((slider) => {
      slider.disabled = false;
    });
    document.getElementById("abToggle").disabled = false;
    document.getElementById("demoStatus").textContent = dictionaries[language].demoPlaying;
    updateDemoLabels();
    if (visualFrame) cancelAnimationFrame(visualFrame);
    animateDemo();
  }

  async function stopDemo() {
    if (!audio) return;
    const current = audio;
    audio = null;
    if (visualFrame) cancelAnimationFrame(visualFrame);
    visualFrame = 0;
    current.sources.forEach((source) => {
      try { source.stop(); } catch { /* Nguồn đã dừng thì bỏ qua. */ }
      try { source.disconnect(); } catch { /* Dọn node đã ngắt. */ }
    });
    await current.context.close();
    demoAnalyser = null;
    bypassed = false;
    document.getElementById("abToggle").disabled = true;
    document.getElementById("abToggle").setAttribute("aria-pressed", "false");
    document.getElementById("demoStatus").textContent = dictionaries[language].demoIdle;
    document.querySelectorAll("#demoSliders input").forEach((slider) => {
      slider.disabled = true;
      slider.value = "0";
      slider.parentElement.querySelector("output").value = "0 dB";
    });
    demoFilters.splice(0);
    updateDemoLabels();
    paintSpectrum(document.getElementById("demoSpectrum"), null, performance.now(), true);
  }

  document.getElementById("demoToggle").addEventListener("click", async () => {
    const button = document.getElementById("demoToggle");
    button.disabled = true;
    try {
      if (audio) await stopDemo();
      else await startDemo();
    } catch (error) {
      if (audio) await stopDemo();
      document.getElementById("demoStatus").textContent = dictionaries[language].demoError;
      console.warn("Demo âm thanh không thể khởi động:", error);
    } finally {
      button.disabled = false;
      updateDemoLabels();
    }
  });
  document.getElementById("abToggle").addEventListener("click", () => {
    setBypass(!bypassed);
    document.getElementById("demoMode").textContent = bypassed ? dictionaries[language].demoBypass : dictionaries[language].demoEnabled;
  });
  document.querySelectorAll("#demoSliders input").forEach((slider) => {
    slider.disabled = true;
    slider.addEventListener("input", () => {
      if (!audio) return;
      const gain = Number(slider.value);
      const filter = demoFilters[Number(slider.dataset.band)];
      if (filter) filter.gain.setTargetAtTime(gain, audio.context.currentTime, .025);
      const output = slider.parentElement.querySelector("output");
      output.value = gain > 0 ? "+" + gain + " dB" : gain + " dB";
    }, { passive: true });
  });
  window.addEventListener("resize", () => {
    if (!audio) paintSpectrum(document.getElementById("demoSpectrum"), null, performance.now(), true);
  }, { passive: true });
  window.addEventListener("pagehide", () => { if (audio) audio.context.close(); });

  const config = window.TAYLOR_SITE_CONFIG || {};
  const downloadButton = document.getElementById("downloadButton");
  const downloadStatus = document.getElementById("downloadStatus");
  if (typeof config.downloadUrl === "string" && /^https:\/\//i.test(config.downloadUrl)) {
    downloadButton.href = config.downloadUrl;
    downloadButton.removeAttribute("aria-disabled");
    downloadButton.setAttribute("download", "");
    downloadButton.querySelector("span:last-child").textContent = "↗";
    document.getElementById("downloadStatus").textContent = config.releaseLabel || "";
  } else {
    downloadButton.href = "#";
    downloadButton.setAttribute("aria-disabled", "true");
    downloadButton.addEventListener("click", (event) => event.preventDefault());
    downloadStatus.textContent = "Chưa có liên kết tải bản phát hành.";
  }

  paintSpectrum(document.getElementById("demoSpectrum"), null, 0, true);
  loadLanguage("vi").then(() => updateDemoLabels()).catch((error) => {
    console.error("Không tải được gói ngôn ngữ:", error);
    document.getElementById("demoStatus").textContent = "Không tải được nội dung ngôn ngữ.";
  });
})();
