// Tạo tài sản thương hiệu, font tự host và bộ icon cho website lẫn Electron.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fontkit = require("fontkit");
import sharp from "sharp";
import { optimize } from "svgo";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRAND = path.join(ROOT, "brand");
const EXPORTS = path.join(BRAND, "exports");
const FONTKIT_FONT = path.join(ROOT, "node_modules", "@fontsource-variable", "montserrat", "files", "montserrat-latin-wght-normal.woff2");
const MARK = [
  '<defs>',
  '<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFE58A"/><stop offset=".55" stop-color="#F5B82E"/><stop offset="1" stop-color="#B8791A"/></linearGradient>',
  '<linearGradient id="navy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#22345C"/><stop offset="1" stop-color="#0B1020"/></linearGradient>',
  '</defs>',
  '<path class="shield" d="M100 8 179 37v68c0 43-31 77-79 100-48-23-79-57-79-100V37z"/>',
  '<path class="inner" d="M100 20 167 45v59c0 37-27 67-67 87-40-20-67-50-67-87V45z"/>',
  '<path class="t-cap" d="M64 55h72a5 5 0 0 1 5 5v8H59v-8a5 5 0 0 1 5-5z"/>',
  '<path class="t-stem" d="M93 68h14v66l-7 12-7-12z"/>',
  '<g class="bars"><rect class="bar bar-a" x="57" y="91" width="7" height="34" rx="3.5"/><rect class="bar bar-b" x="69" y="81" width="7" height="54" rx="3.5"/><rect class="bar bar-c" x="81" y="88" width="7" height="40" rx="3.5"/><rect class="bar bar-c" x="112" y="88" width="7" height="40" rx="3.5"/><rect class="bar bar-b" x="124" y="81" width="7" height="54" rx="3.5"/><rect class="bar bar-a" x="136" y="91" width="7" height="34" rx="3.5"/></g>'
].join("");

function svgDocument(content, viewBox = "0 0 200 220", extra = "") {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" ' + extra + '>' + content + "</svg>";
}

function markSvg(mode = "color") {
  if (mode === "white" || mode === "black" || mode === "gold") {
    const color = mode === "white" ? "#FFFFFF" : mode === "black" ? "#0B1020" : "#F5B82E";
    return svgDocument(
      '<path d="M100 8 179 37v68c0 43-31 77-79 100-48-23-79-57-79-100V37z" fill="none" stroke="' + color + '" stroke-width="5" stroke-linejoin="round"/>' +
      '<path d="M100 20 167 45v59c0 37-27 67-67 87-40-20-67-50-67-87V45z" fill="none" stroke="' + color + '" stroke-width="1.5" opacity=".5"/>' +
      '<path d="M64 55h72a5 5 0 0 1 5 5v8H59v-8a5 5 0 0 1 5-5zM93 68h14v66l-7 12-7-12z" fill="' + color + '"/>' +
      '<g fill="' + color + '"><rect x="57" y="91" width="7" height="34" rx="3.5"/><rect x="69" y="81" width="7" height="54" rx="3.5"/><rect x="81" y="88" width="7" height="40" rx="3.5"/><rect x="112" y="88" width="7" height="40" rx="3.5"/><rect x="124" y="81" width="7" height="54" rx="3.5"/><rect x="136" y="91" width="7" height="34" rx="3.5"/></g>',
      "0 0 200 220",
      'role="img" aria-label="Biểu tượng Taylor ND Audio"'
    );
  }
  return svgDocument(
    '<style>.shield{fill:url(#navy);stroke:url(#gold);stroke-width:5;stroke-linejoin:round}.inner{fill:none;stroke:url(#gold);stroke-width:1.5;opacity:.48}.t-cap,.t-stem,.bars{fill:url(#gold)}</style>' + MARK,
    "0 0 200 220",
    'role="img" aria-label="Khiên Taylor ND Audio với chữ T và thanh equalizer đối xứng"'
  );
}

function waveConcept() {
  return svgDocument(
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFE58A"/><stop offset=".55" stop-color="#F5B82E"/><stop offset="1" stop-color="#B8791A"/></linearGradient></defs>' +
    '<path d="M34 62h132" stroke="url(#g)" stroke-width="12" stroke-linecap="round"/><path d="M100 62v74" stroke="url(#g)" stroke-width="12" stroke-linecap="round"/>' +
    '<g fill="url(#g)"><rect x="25" y="96" width="9" height="34" rx="4.5"/><rect x="43" y="83" width="9" height="60" rx="4.5"/><rect x="61" y="101" width="9" height="24" rx="4.5"/><rect x="79" y="88" width="9" height="50" rx="4.5"/><rect x="112" y="88" width="9" height="50" rx="4.5"/><rect x="130" y="101" width="9" height="24" rx="4.5"/><rect x="148" y="83" width="9" height="60" rx="4.5"/><rect x="166" y="96" width="9" height="34" rx="4.5"/></g>' +
    '<path d="M27 164c20 0 20-10 40-10s20 20 40 20 20-20 40-20 20 10 26 10" fill="none" stroke="#F5B82E" stroke-width="4" stroke-linecap="round"/>',
    "0 0 200 220",
    'role="img" aria-label="Chữ T tối giản trên sóng âm"'
  );
}

function monogramConcept() {
  return svgDocument(
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFE58A"/><stop offset=".55" stop-color="#F5B82E"/><stop offset="1" stop-color="#B8791A"/></linearGradient><linearGradient id="n" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#22345C"/><stop offset="1" stop-color="#0B1020"/></linearGradient></defs>' +
    '<path d="M100 8 179 37v68c0 43-31 77-79 100-48-23-79-57-79-100V37z" fill="url(#n)" stroke="url(#g)" stroke-width="5" stroke-linejoin="round"/>' +
    '<rect x="48" y="73" width="104" height="74" rx="19" fill="none" stroke="url(#g)" stroke-width="2"/>' +
    '<text x="100" y="119" text-anchor="middle" fill="url(#g)" font-family="Arial,sans-serif" font-size="31" font-weight="800" letter-spacing="1">TND</text>',
    "0 0 200 220",
    'role="img" aria-label="Monogram TND dạng huy hiệu"'
  );
}

function outlineText(font, text, x, baseline, size, weight, color, letterSpacing) {
  const face = font.getVariation({ wght: weight });
  const run = face.layout(text);
  const scale = size / face.unitsPerEm;
  let cursor = 0;
  const glyphPaths = run.glyphs.map((glyph, index) => {
    const position = run.positions[index];
    const start = cursor + position.xOffset;
    cursor += position.xAdvance + letterSpacing / scale;
    if (!glyph.path || !glyph.path.commands.length) return "";
    return '<path transform="translate(' + start.toFixed(2) + ' 0)" d="' + glyph.path.toSVG() + '"/>';
  }).join("");
  return '<g fill="' + color + '" transform="translate(' + x + " " + baseline + ') scale(' + scale.toFixed(5) + " " + (-scale).toFixed(5) + ')">' + glyphPaths + "</g>";
}

function logoHorizontal(font, textColor = "#F8F7F4", mode = "color") {
  const symbol = markSvg(mode).replace(/^<svg[^>]*>/, '<g transform="translate(5 4) scale(.86)">').replace(/<\/svg>$/, "</g>");
  const audioColor = mode === "gold" ? "#F5B82E" : mode === "black" ? "#0B1020" : mode === "white" ? "#FFFFFF" : "url(#gold)";
  const defs = mode === "color" ? '<defs><linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFE58A"/><stop offset=".55" stop-color="#F5B82E"/><stop offset="1" stop-color="#B8791A"/></linearGradient></defs>' : "";
  const text = outlineText(font, "TAYLOR ND", 224, 92, 35, 800, textColor, 5.2) +
    outlineText(font, "AUDIO", 227, 139, 24, 800, audioColor, 7.8) +
    outlineText(font, "POWER YOUR SOUND", 228, 171, 10, 700, textColor === "#0B1020" ? "#44506A" : "#AAB2C2", 3.3);
  return svgDocument(defs + symbol + text, "0 0 590 190", 'role="img" aria-label="Taylor ND Audio — Power Your Sound"');
}

function logoVertical(font, textColor = "#F8F7F4", mode = "color") {
  const symbol = markSvg(mode).replace(/^<svg[^>]*>/, '<g transform="translate(75 0) scale(1.25)">').replace(/<\/svg>$/, "</g>");
  const audioColor = mode === "gold" ? "#F5B82E" : mode === "black" ? "#0B1020" : mode === "white" ? "#FFFFFF" : "url(#gold)";
  const defs = mode === "color" ? '<defs><linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFE58A"/><stop offset=".55" stop-color="#F5B82E"/><stop offset="1" stop-color="#B8791A"/></linearGradient></defs>' : "";
  return svgDocument(
    defs + symbol +
    outlineText(font, "TAYLOR ND", 68, 292, 29, 800, textColor, 4.4) +
    outlineText(font, "AUDIO", 116, 333, 23, 800, audioColor, 7.4) +
    outlineText(font, "POWER YOUR SOUND", 99, 359, 9, 700, textColor === "#0B1020" ? "#44506A" : "#AAB2C2", 2.9),
    "0 0 400 380",
    'role="img" aria-label="Taylor ND Audio, logo dọc — Power Your Sound"'
  );
}

function animatedMark() {
  const animationCss = '<style>.shield{fill:url(#navy);stroke:url(#gold);stroke-width:5;stroke-linejoin:round}.inner{fill:none;stroke:url(#gold);stroke-width:1.5;opacity:.48}.t-cap,.t-stem,.bars{fill:url(#gold)}.bar{transform-box:fill-box;transform-origin:center;animation:bob 1.8s ease-in-out infinite alternate}.bar-a{animation-delay:-.7s}.bar-b{animation-delay:-1.2s}.bar-c{animation-delay:-.25s}@keyframes bob{from{transform:scaleY(.72)}to{transform:scaleY(1.08)}}@media(prefers-reduced-motion:reduce){.bar{animation:none}}</style>';
  return svgDocument(animationCss + MARK, "0 0 200 220", 'role="img" aria-label="Logo Taylor ND Audio đang chuyển động nhẹ"');
}

function optimizeSvg(svg) {
  const result = optimize(svg, { multipass: true, plugins: ["preset-default", { name: "removeViewBox", active: false }] });
  if (result.error) throw new Error(result.error);
  return result.data;
}

async function saveSvg(name, svg) {
  const optimized = optimizeSvg(svg);
  fs.writeFileSync(path.join(EXPORTS, name), optimized, "utf8");
  return optimized;
}

async function makeIco(svg, target, sizes) {
  const pngEntries = await Promise.all(sizes.map(async (size) => sharp(Buffer.from(svg)).resize(size, size, { fit: "contain" }).png().toBuffer()));
  const headerSize = 6 + sizes.length * 16;
  const total = headerSize + pngEntries.reduce((sum, png) => sum + png.length, 0);
  const output = Buffer.alloc(total);
  output.writeUInt16LE(0, 0); output.writeUInt16LE(1, 2); output.writeUInt16LE(sizes.length, 4);
  let offset = headerSize;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    output[entry] = size === 256 ? 0 : size;
    output[entry + 1] = size === 256 ? 0 : size;
    output[entry + 2] = 0; output[entry + 3] = 0;
    output.writeUInt16LE(1, entry + 4); output.writeUInt16LE(32, entry + 6);
    output.writeUInt32LE(pngEntries[index].length, entry + 8); output.writeUInt32LE(offset, entry + 12);
    pngEntries[index].copy(output, offset); offset += pngEntries[index].length;
  });
  fs.writeFileSync(target, output);
}

function fontCss(sourceCss, family, destinationDir) {
  const faces = [];
  // Gói Be Vietnam Pro tách file theo nhóm ký tự nhưng stylesheet từng trọng
  // số không lặp lại unicode-range. Gắn đúng phạm vi để trình duyệt chỉ tải
  // file Latin, Latin mở rộng hoặc tiếng Việt khi nội dung thực sự cần.
  const subsetRanges = {
    vietnamese: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB",
    "latin-ext": "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
    latin: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
  };
  for (const match of sourceCss.matchAll(/@font-face\s*\{([^}]+)\}/g)) {
    const body = match[1];
    const fileMatch = body.match(/url\(\.\/files\/([^)'"]+\.woff2)\)/);
    if (!fileMatch) continue;
    const basename = fileMatch[1];
    const fontPath = path.join(destinationDir, basename);
    const sourcePath = path.join(ROOT, "node_modules", family === "Montserrat" ? "@fontsource-variable" : "@fontsource", family === "Montserrat" ? "montserrat" : "be-vietnam-pro", "files", basename);
    fs.copyFileSync(sourcePath, fontPath);
    const weight = body.match(/font-weight:\s*([^;]+);/)?.[1] || "400";
    const subset = basename.match(/be-vietnam-pro-(vietnamese|latin-ext|latin)-/)?.[1];
    const range = body.match(/unicode-range:\s*([^;]+);/)?.[1] || subsetRanges[subset];
    faces.push("@font-face{font-family:'" + family + "';font-style:normal;font-display:optional;font-weight:" + weight + ";src:url('fonts/" + basename + "') format('woff2');" + (range ? "unicode-range:" + range + ";" : "") + "}");
  }
  return faces;
}

function buildGuides() {
  const expl = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Khám phá logo · Taylor ND Audio</title><link rel="stylesheet" href="../website/fonts.css"><link rel="stylesheet" href="brand-pages.css"></head><body><main><a class="back" href="../website/index.html">← Taylor ND Audio</a><p class="eyebrow">NHẬN DIỆN THƯƠNG HIỆU</p><h1>Ba hướng biểu tượng</h1><p class="intro">So sánh ba cách diễn giải tinh thần chính xác, mạnh mẽ và gắn với âm thanh.</p><section class="cards"><article class="card selected"><span class="pick">ĐỀ XUẤT</span><img src="exports/concept-shield.svg" alt="Khiên chữ T và các thanh equalizer đối xứng"><h2>01 · Khiên T Equalizer</h2><p>Khiên tạo cảm giác bảo vệ; chữ T và các vạch cân xứng gợi tinh chỉnh chính xác, dễ nhận ra ở kích thước nhỏ.</p></article><article class="card"><img src="exports/concept-wave.svg" alt="Chữ T tối giản cùng sóng âm"><h2>02 · T + sóng âm</h2><p>Đường nét thoáng và hiện đại, phù hợp bối cảnh nội dung số; dấu ấn bảo vệ và nhận diện ứng dụng yếu hơn.</p></article><article class="card"><img src="exports/concept-tnd.svg" alt="Monogram TND dạng huy hiệu"><h2>03 · Monogram TND</h2><p>Gom tên thương hiệu vào một huy hiệu gọn; nhiều chữ ở tâm khiến biểu tượng khó đọc hơn khi thu nhỏ.</p></article></section><p class="note">Hướng 01 được chọn làm biểu tượng chính cho ứng dụng, website và bộ icon.</p></main></body></html>';
  fs.writeFileSync(path.join(BRAND, "explorations.html"), expl, "utf8");
  const guide = '<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quy chuẩn thương hiệu · Taylor ND Audio</title><link rel="stylesheet" href="../website/fonts.css"><link rel="stylesheet" href="brand-pages.css"></head><body><main><a class="back" href="../website/index.html">← Taylor ND Audio</a><p class="eyebrow">POWER YOUR SOUND</p><h1>Quy chuẩn thương hiệu</h1><p class="intro">Hệ nhận diện dành cho phần mềm tinh chỉnh âm thanh Taylor ND Audio.</p><section class="guide-grid"><article class="card"><h2>Ý nghĩa biểu tượng</h2><img class="guide-logo" src="exports/logo-mark.svg" alt="Khiên T Equalizer"><p>Khiên navy đại diện cho sự bảo vệ và độ tin cậy. Chữ T làm trục trung tâm; các thanh equalizer hai bên tạo nhịp đối xứng và gợi thao tác tinh chỉnh.</p></article><article class="card"><h2>Bảng màu</h2><div class="swatches"><div style="--sw:#0B1020"><b>Navy sâu</b><code>#0B1020 · RGB 11, 16, 32</code></div><div style="--sw:#22345C"><b>Navy xanh</b><code>#22345C · RGB 34, 52, 92</code></div><div style="--sw:#FFE58A"><b>Vàng sáng</b><code>#FFE58A · RGB 255, 229, 138</code></div><div style="--sw:#F5B82E"><b>Vàng chính</b><code>#F5B82E · RGB 245, 184, 46</code></div><div style="--sw:#B8791A"><b>Vàng đồng</b><code>#B8791A · RGB 184, 121, 26</code></div><div style="--sw:#8B3F1F"><b>Cam đất</b><code>#8B3F1F · RGB 139, 63, 31</code></div><div style="--sw:#FFFFFF"><b>Trắng</b><code>#FFFFFF · RGB 255, 255, 255</code></div></div></article><article class="card"><h2>Kiểu chữ</h2><p><strong>Montserrat ExtraBold 800</strong> dành cho wordmark và tiêu đề thương hiệu. <strong>Be Vietnam Pro</strong> dùng cho giao diện và nội dung để hỗ trợ dấu tiếng Việt.</p><p>Font website được tự host dưới WOFF2; giấy phép SIL Open Font License 1.1 nằm trong brand/fonts và website/fonts.</p></article><article class="card"><h2>Vùng an toàn và kích thước</h2><p>Giữ vùng trống quanh biểu tượng ít nhất bằng 1/8 chiều cao khiên. Không đặt văn bản, đường viền hay chi tiết khác vào vùng này.</p><p>Kích thước tối thiểu khuyến nghị: biểu tượng 24 px, logo ngang 180 px, logo dọc 96 px. Dùng favicon chuyên dụng ở cỡ nhỏ.</p></article><article class="card"><h2>Biến thể nền</h2><div class="logo-pair"><div class="light-surface"><img src="exports/logo-horizontal-on-light.svg" alt="Logo dùng trên nền sáng"></div><div class="dark-surface"><img src="exports/logo-horizontal-on-dark.svg" alt="Logo dùng trên nền tối"></div></div><p>Dùng bản chữ navy trên nền sáng; dùng bản chữ trắng trên nền tối. Biểu tượng giữ nền khiên navy và viền vàng.</p></article><article class="card"><h2>Không nên làm</h2><ul><li>Không kéo méo, xoay nghiêng hoặc đổi tỷ lệ riêng của biểu tượng.</li><li>Không đổi gradient, màu navy hay hướng của các vạch cân xứng.</li><li>Không thêm bóng cứng, viền lạ hay họa tiết che khiên.</li><li>Không đặt chữ vàng sáng trên nền trắng cho nội dung nhỏ.</li><li>Không tự dựng lại wordmark bằng font thay thế khi đã có bản SVG path.</li></ul></article><article class="card wide"><h2>Độ tương phản WCAG</h2><p>Tỷ lệ được tính từ màu HEX theo công thức độ chói tương đối WCAG 2.1. Mức AA cho chữ thường yêu cầu ít nhất 4.5:1.</p><div class="contrast"><span>Trắng #FFFFFF trên Navy #0B1020</span><b>18.9:1 · AA</b><span>Vàng #F5B82E trên Navy #0B1020</span><b>10.6:1 · AA</b><span>Trắng #FFFFFF trên Navy xanh #22345C</span><b>12.3:1 · AA</b><span>Trắng #FFFFFF trên Cam đất #8B3F1F</span><b>7.4:1 · AA</b><span>Navy #0B1020 trên vàng #FFE58A</span><b>15.2:1 · AA</b><span>Vàng #F5B82E trên trắng #FFFFFF</span><b>1.8:1 · Không đạt</b></div></article></section><footer>© Taylor ND Audio · Power Your Sound</footer></main></body></html>';
  fs.writeFileSync(path.join(BRAND, "guidelines.html"), guide, "utf8");
  const guideCss = ':root{color-scheme:dark;--bg:#0b1020;--panel:#151f38;--text:#f8f7f4;--soft:#c0c8d7;--gold:#f5b82e}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 82% 0,#63381966,transparent 38%),var(--bg);color:var(--text);font-family:"Be Vietnam Pro",Segoe UI,sans-serif;line-height:1.65}main{width:min(1120px,calc(100% - 36px));margin:0 auto;padding:42px 0 70px}.back{color:#ffe58a;text-decoration:none}.eyebrow{margin-top:42px;color:#f5b82e;font-size:.75rem;font-weight:800;letter-spacing:.16em}h1{font-size:clamp(2.3rem,7vw,4.5rem);line-height:1.05;margin:.4em 0}.intro{max-width:680px;color:var(--soft);font-size:1.1rem}.cards,.guide-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:34px}.guide-grid{grid-template-columns:repeat(2,1fr)}.card{position:relative;border:1px solid #ffffff1c;border-radius:24px;background:#ffffff0a;padding:24px;backdrop-filter:blur(16px)}.card.selected{border-color:#f5b82e;box-shadow:0 18px 50px #f5b82e16}.pick{position:absolute;right:18px;top:18px;color:#0b1020;background:linear-gradient(#ffe58a,#f5b82e);border-radius:30px;padding:5px 10px;font-size:.68rem;font-weight:800}.cards img{width:100%;height:180px;object-fit:contain;padding:18px;background:#0b1020;border-radius:18px}.cards h2,.card h2{font-size:1.15rem}.card p,.card li{color:var(--soft)}.note{margin-top:24px;color:#ffe58a}.guide-logo{display:block;height:190px;width:100%;object-fit:contain}.swatches{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.swatches div{background:var(--sw);color:#fff;padding:14px;border-radius:12px;min-height:85px;text-shadow:0 1px 4px #000}.swatches code{display:block;font-size:.72rem}.swatches div[style*="#FFE58A"],.swatches div[style*="#F5B82E"],.swatches div[style*="#FFFFFF"]{color:#0b1020;text-shadow:none}.logo-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.logo-pair>div{border-radius:12px;padding:18px;display:grid;place-items:center;min-height:90px}.logo-pair img{max-width:100%;height:auto}.light-surface{background:#f4f5f8}.dark-surface{background:#0b1020}.contrast{display:grid;grid-template-columns:1fr auto;gap:10px;border-top:1px solid #ffffff1c;padding-top:14px}.contrast span{color:var(--soft)}.contrast b{color:#ffe58a}footer{margin-top:42px;color:#9ca6ba}@media(max-width:800px){.cards{grid-template-columns:1fr}.guide-grid{grid-template-columns:1fr}.cards img{height:155px}.contrast{font-size:.83rem}}';
  fs.writeFileSync(path.join(BRAND, "brand-pages.css"), guideCss, "utf8");
}

async function main() {
  for (const dir of [EXPORTS, path.join(EXPORTS, "png"), path.join(EXPORTS, "preview"), path.join(BRAND, "fonts"), path.join(ROOT, "website", "fonts"), path.join(ROOT, "src", "renderer", "fonts")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const fontFaceCss = [];
  const montCss = fs.readFileSync(path.join(ROOT, "node_modules", "@fontsource-variable", "montserrat", "wght.css"), "utf8");
  fontFaceCss.push(...fontCssFor(montCss, "Montserrat"));
  // Giữ hai trọng số nội dung cần thiết; trình duyệt nội suy các mức trung gian.
  for (const weight of [400, 700]) {
    // Nội dung thương hiệu chỉ dùng tiếng Việt và Latin phổ thông; bỏ bộ
    // Latin mở rộng để tránh tải trùng các chữ Việt đã có trong subset VN.
    for (const subset of ["vietnamese", "latin"]) {
      const source = fs.readFileSync(path.join(ROOT, "node_modules", "@fontsource", "be-vietnam-pro", subset + "-" + weight + ".css"), "utf8");
      fontFaceCss.push(...fontCssFor(source, "Be Vietnam Pro"));
    }
  }
  function fontCssFor(sourceCss, family) {
    const websiteDir = path.join(ROOT, "website", "fonts");
    const faces = fontCss(sourceCss, family, websiteDir);
    for (const face of sourceCss.matchAll(/url\(\.\/files\/([^)'"]+\.woff2)\)/g)) {
      for (const folder of [path.join(BRAND, "fonts"), path.join(ROOT, "src", "renderer", "fonts")]) {
        fs.copyFileSync(path.join(ROOT, "node_modules", family === "Montserrat" ? "@fontsource-variable" : "@fontsource", family === "Montserrat" ? "montserrat" : "be-vietnam-pro", "files", face[1]), path.join(folder, face[1]));
      }
    }
    return faces;
  }
  fs.writeFileSync(path.join(ROOT, "website", "fonts.css"), fontFaceCss.join("\n"), "utf8");
  const rendererCss = fontFaceCss.map((face) => face.replaceAll("fonts/", "fonts/"));
  fs.writeFileSync(path.join(ROOT, "src", "renderer", "fonts.css"), rendererCss.join("\n"), "utf8");
  fs.copyFileSync(path.join(ROOT, "node_modules", "@fontsource-variable", "montserrat", "LICENSE"), path.join(BRAND, "fonts", "Montserrat-OFL.txt"));
  fs.copyFileSync(path.join(ROOT, "node_modules", "@fontsource", "be-vietnam-pro", "LICENSE"), path.join(BRAND, "fonts", "Be-Vietnam-Pro-OFL.txt"));
  fs.copyFileSync(path.join(ROOT, "node_modules", "@fontsource-variable", "montserrat", "LICENSE"), path.join(ROOT, "website", "fonts", "Montserrat-OFL.txt"));
  fs.copyFileSync(path.join(ROOT, "node_modules", "@fontsource", "be-vietnam-pro", "LICENSE"), path.join(ROOT, "website", "fonts", "Be-Vietnam-Pro-OFL.txt"));

  const font = fontkit.openSync(FONTKIT_FONT);
  const concepts = {
    "concept-shield.svg": markSvg("color"),
    "concept-wave.svg": waveConcept(),
    "concept-tnd.svg": monogramConcept()
  };
  const svgFiles = new Map(Object.entries(concepts));
  svgFiles.set("logo-mark.svg", markSvg("color"));
  svgFiles.set("logo-mark-mono-white.svg", markSvg("white"));
  svgFiles.set("logo-mark-mono-black.svg", markSvg("black"));
  svgFiles.set("logo-mark-mono-gold.svg", markSvg("gold"));
  svgFiles.set("logo-horizontal.svg", logoHorizontal(font));
  svgFiles.set("logo-vertical.svg", logoVertical(font));
  svgFiles.set("logo-horizontal-mono-white.svg", logoHorizontal(font, "#FFFFFF", "white"));
  svgFiles.set("logo-horizontal-mono-black.svg", logoHorizontal(font, "#0B1020", "black"));
  svgFiles.set("logo-horizontal-mono-gold.svg", logoHorizontal(font, "#F5B82E", "gold"));
  svgFiles.set("logo-horizontal-on-light.svg", logoHorizontal(font, "#0B1020"));
  svgFiles.set("logo-horizontal-on-dark.svg", logoHorizontal(font, "#F8F7F4"));
  svgFiles.set("logo-vertical-on-light.svg", logoVertical(font, "#0B1020"));
  svgFiles.set("logo-vertical-on-dark.svg", logoVertical(font, "#F8F7F4"));
  svgFiles.set("logo-animated.svg", animatedMark());
  const optimized = new Map();
  for (const [name, svg] of svgFiles) optimized.set(name, await saveSvg(name, svg));
  fs.copyFileSync(path.join(EXPORTS, "logo-mark.svg"), path.join(ROOT, "assets", "logo.svg"));
  fs.copyFileSync(path.join(EXPORTS, "logo-horizontal.svg"), path.join(ROOT, "assets", "logo-lockup.svg"));
  fs.copyFileSync(path.join(EXPORTS, "logo-animated.svg"), path.join(ROOT, "assets", "logo-animated.svg"));
  fs.copyFileSync(path.join(EXPORTS, "logo-mark.svg"), path.join(ROOT, "website", "logo.svg"));
  fs.copyFileSync(path.join(EXPORTS, "logo-animated.svg"), path.join(ROOT, "website", "logo-animated.svg"));

  for (const [name, svg] of optimized) {
    const dimensions = await sharp(Buffer.from(svg)).metadata();
    const logoPreview = await sharp(Buffer.from(svg)).resize({ width: 1000, height: 600, fit: "contain" }).png().toBuffer();
    const lightPreview = name.includes("on-light") || name.includes("mono-black");
    const previewColor = lightPreview ? { r: 244, g: 245, b: 248 } : { r: 11, g: 16, b: 32 };
    const preview = await sharp({ create: { width: 1000, height: 600, channels: 3, background: previewColor } }).composite([{ input: logoPreview }]).png().toBuffer();
    fs.writeFileSync(path.join(EXPORTS, "preview", name.replace(".svg", ".png")), preview);
    if (name === "logo-animated.svg") continue;
    if (name.startsWith("concept-")) continue;
    if (name !== "logo-mark.svg") continue;
    for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
      const png = await sharp(Buffer.from(svg)).resize(size, size, { fit: "contain" }).png().toBuffer();
      fs.writeFileSync(path.join(EXPORTS, "png", "logo-mark-" + size + ".png"), png);
    }
    if (!dimensions.width || !dimensions.height) throw new Error("Logo thiếu kích thước SVG: " + name);
  }
  const appSvg = optimized.get("logo-mark.svg");
  await makeIco(appSvg, path.join(EXPORTS, "icon-app.ico"), [16, 24, 32, 48, 64, 128, 256]);
  await makeIco(appSvg, path.join(EXPORTS, "favicon.ico"), [16, 32, 48]);
  fs.copyFileSync(path.join(EXPORTS, "favicon.ico"), path.join(ROOT, "website", "favicon.ico"));
  fs.copyFileSync(path.join(EXPORTS, "logo-mark.svg"), path.join(ROOT, "website", "favicon.svg"));
  await sharp(Buffer.from(appSvg)).resize(180, 180, { fit: "contain" }).png().toFile(path.join(EXPORTS, "apple-touch-icon.png"));
  await sharp(Buffer.from(appSvg)).resize(400, 400, { fit: "contain" }).png().toFile(path.join(EXPORTS, "avatar-400.png"));
  const maskableSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#0B1020"/><image href="data:image/svg+xml;base64,' + Buffer.from(appSvg).toString("base64") + '" x="76" y="74" width="360" height="364" preserveAspectRatio="xMidYMid meet"/></svg>';
  await sharp(Buffer.from(optimizeSvg(maskableSvg))).resize(512, 512).png().toFile(path.join(EXPORTS, "icon-maskable-512.png"));
  const og = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><defs><radialGradient id="bg" cx="85%" cy="7%" r="75%"><stop stop-color="#8B3F1F" stop-opacity=".72"/><stop offset="1" stop-color="#0B1020"/></radialGradient></defs><rect width="1200" height="630" fill="url(#bg)"/><circle cx="1040" cy="120" r="235" fill="none" stroke="#F5B82E" stroke-opacity=".13" stroke-width="2"/><circle cx="1040" cy="120" r="190" fill="none" stroke="#F5B82E" stroke-opacity=".1" stroke-width="2"/><image href="data:image/svg+xml;base64,' + Buffer.from(appSvg).toString("base64") + '" x="90" y="145" width="270" height="300" preserveAspectRatio="xMidYMid meet"/><image href="data:image/svg+xml;base64,' + Buffer.from(optimized.get("logo-horizontal.svg")).toString("base64") + '" x="390" y="196" width="690" height="222" preserveAspectRatio="xMinYMid meet"/><text x="398" y="484" fill="#F8F7F4" font-size="23" font-family="Segoe UI,sans-serif">Tinh chỉnh âm thanh toàn hệ thống cho Windows 10/11</text></svg>';
  await sharp(Buffer.from(optimizeSvg(og))).resize(1200, 630).png().toFile(path.join(EXPORTS, "og-image-1200x630.png"));
  fs.copyFileSync(path.join(EXPORTS, "og-image-1200x630.png"), path.join(ROOT, "website", "og-image.png"));
  fs.copyFileSync(path.join(EXPORTS, "apple-touch-icon.png"), path.join(ROOT, "website", "apple-touch-icon.png"));
  fs.copyFileSync(path.join(EXPORTS, "icon-maskable-512.png"), path.join(ROOT, "website", "icon-maskable.png"));
  fs.copyFileSync(path.join(EXPORTS, "icon-app.ico"), path.join(ROOT, "assets", "taylor-nd-audio.ico"));
  buildGuides();
  console.log("Đã tạo " + svgFiles.size + " SVG, PNG, ICO, font tự host và hướng dẫn thương hiệu.");
}

main().catch((error) => {
  console.error("Không thể tạo bộ thương hiệu:", error);
  process.exitCode = 1;
});
