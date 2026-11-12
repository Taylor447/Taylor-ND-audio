// Tạo file ICO nhiều kích cỡ bằng Node.js thuần, không cần thư viện ảnh bên ngoài.
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(__dirname, '..', 'assets', 'taylor-nd-audio.ico');
const SVG_SOURCE = path.join(__dirname, '..', 'assets', 'logo.svg');
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 3;
const BASE = 256;
const SCALE = BASE * SUPERSAMPLE / 220;
const HIGH = BASE * SUPERSAMPLE;
const pixels = new Uint8Array(HIGH * HIGH * 4);

function point(x, y) { return { x: HIGH / 2 + (x - 100) * SCALE, y: y * SCALE }; }
function mix(a, b, amount) { return Math.round(a + (b - a) * amount); }
function colorAt(y, stops) {
  const t = Math.max(0, Math.min(1, y / (220 * SCALE)));
  for (let index = 0; index < stops.length - 1; index += 1) {
    const [start, first] = stops[index], [end, second] = stops[index + 1];
    if (t <= end) {
      const part = (t - start) / (end - start);
      return [mix(first[0], second[0], part), mix(first[1], second[1], part), mix(first[2], second[2], part), 255];
    }
  }
  return [...stops.at(-1)[1], 255];
}
function setPixel(x, y, color) {
  if (x < 0 || x >= HIGH || y < 0 || y >= HIGH) return;
  const offset = (y * HIGH + x) * 4;
  const sourceAlpha = (color[3] ?? 255) / 255;
  const destinationAlpha = pixels[offset + 3] / 255;
  const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
  if (outputAlpha === 0) return;
  for (let channel = 0; channel < 3; channel += 1) {
    const premultiplied = color[channel] * sourceAlpha + pixels[offset + channel] * destinationAlpha * (1 - sourceAlpha);
    pixels[offset + channel] = Math.round(premultiplied / outputAlpha);
  }
  pixels[offset + 3] = Math.round(outputAlpha * 255);
}
function polygonContains(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    const crosses = (a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
function polygonDistance(x, y, polygon) {
  let minimum = Infinity;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy)));
    minimum = Math.min(minimum, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return minimum;
}
function parseSvgPath(data) {
  const tokens = data.match(/[MLVHCZ]|-?\d*\.?\d+/gi) || [];
  const points = [];
  let index = 0, command = '', x = 0, y = 0, startX = 0, startY = 0;
  const readNumber = () => Number(tokens[index++]);
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++].toUpperCase();
    if (command === 'M' || command === 'L') {
      x = readNumber(); y = readNumber();
      if (command === 'M') { startX = x; startY = y; command = 'L'; }
      points.push([x, y]);
    } else if (command === 'H') {
      x = readNumber(); points.push([x, y]);
    } else if (command === 'V') {
      y = readNumber(); points.push([x, y]);
    } else if (command === 'C') {
      const x0 = x, y0 = y;
      const x1 = readNumber(), y1 = readNumber(), x2 = readNumber(), y2 = readNumber(), x3 = readNumber(), y3 = readNumber();
      for (let step = 1; step <= 16; step += 1) {
        const t = step / 16, u = 1 - t;
        const px = u ** 3 * x0 + 3 * u ** 2 * t * x1 + 3 * u * t ** 2 * x2 + t ** 3 * x3;
        const py = u ** 3 * y0 + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3;
        points.push([px, py]);
      }
      x = x3; y = y3;
    } else if (command === 'Z') {
      x = startX; y = startY;
    } else {
      throw new Error(`Lệnh SVG chưa hỗ trợ: ${command}`);
    }
  }
  return points;
}
function drawPolygon(points, fill, stroke, strokeWidth = 0) {
  const polygon = points.map(([x, y]) => point(x, y));
  const minX = Math.max(0, Math.floor(Math.min(...polygon.map((p) => p.x)) - strokeWidth - 1));
  const maxX = Math.min(HIGH, Math.ceil(Math.max(...polygon.map((p) => p.x)) + strokeWidth + 1));
  const minY = Math.max(0, Math.floor(Math.min(...polygon.map((p) => p.y)) - strokeWidth - 1));
  const maxY = Math.min(HIGH, Math.ceil(Math.max(...polygon.map((p) => p.y)) + strokeWidth + 1));
  for (let y = minY; y < maxY; y += 1) for (let x = minX; x < maxX; x += 1) {
    if (fill && polygonContains(x + .5, y + .5, polygon)) setPixel(x, y, fill(y));
    if (stroke && polygonDistance(x + .5, y + .5, polygon) <= strokeWidth / 2) setPixel(x, y, stroke(y));
  }
}
function drawRoundRect(x, y, width, height, radius, fill, opacity = 1) {
  const left = point(x, y), right = point(x + width, y + height);
  const r = radius * SCALE;
  for (let py = Math.max(0, Math.floor(left.y)); py < Math.min(HIGH, Math.ceil(right.y)); py += 1) {
    for (let px = Math.max(0, Math.floor(left.x)); px < Math.min(HIGH, Math.ceil(right.x)); px += 1) {
      const cx = Math.max(left.x + r, Math.min(right.x - r, px + .5));
      const cy = Math.max(left.y + r, Math.min(right.y - r, py + .5));
      if (Math.hypot(px + .5 - cx, py + .5 - cy) > r) continue;
      const base = fill(py);
      setPixel(px, py, [base[0], base[1], base[2], Math.round(255 * opacity)]);
    }
  }
}
function renderLogo() {
  const gold = (y) => colorAt(y, [[0, [255, 229, 138]], [.55, [245, 184, 46]], [1, [184, 121, 26]]]);
  const navy = (y) => colorAt(y, [[0, [34, 52, 92]], [1, [11, 16, 32]]]);
  // Đọc trực tiếp các path và rect của SVG thương hiệu để các biến thể ICO bám cùng logo.
  const svg = fs.readFileSync(SVG_SOURCE, 'utf8');
  const paths = [...svg.matchAll(/<path\s+d="([^"]+)"/g)].map((match) => parseSvgPath(match[1]));
  const rectangles = [...svg.matchAll(/<rect\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"\s+rx="([^"]+)"([^>]*)\/>/g)];
  if (paths.length < 3 || rectangles.length < 7) throw new Error('Không đọc được các hình trong assets/logo.svg.');
  const outer = paths[0], inner = paths[1], letter = paths[2];
  drawPolygon(outer, navy, gold, 5 * SCALE);
  drawPolygon(inner, null, (y) => { const value = gold(y); return [value[0], value[1], value[2], 145]; }, 1.5 * SCALE);
  const drawRect = (match) => {
    const [, x, y, width, height, radius, attributes] = match;
    const alpha = Number(attributes.match(/fill-opacity="([^"]+)"/)?.[1] || 1);
    drawRoundRect(Number(x), Number(y), Number(width), Number(height), Number(radius), gold, alpha);
  };
  drawRect(rectangles[0]);
  drawPolygon(letter, gold, null);
  rectangles.slice(1).forEach(drawRect);
}
function scaledPixels(size) {
  const out = new Uint8Array(size * size * 4);
  const scale = HIGH / size;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const sums = [0, 0, 0];
    let alphaSum = 0;
    const fromX = Math.floor(x * scale), toX = Math.floor((x + 1) * scale);
    const fromY = Math.floor(y * scale), toY = Math.floor((y + 1) * scale);
    let samples = 0;
    for (let sy = fromY; sy < toY; sy += 1) for (let sx = fromX; sx < toX; sx += 1) {
      const offset = (sy * HIGH + sx) * 4;
      const alpha = pixels[offset + 3] / 255;
      for (let c = 0; c < 3; c += 1) sums[c] += pixels[offset + c] * alpha;
      alphaSum += alpha;
      samples += 1;
    }
    const offset = (y * size + x) * 4;
    for (let c = 0; c < 3; c += 1) out[offset + c] = alphaSum > 0 ? Math.round(sums[c] / alphaSum) : 0;
    out[offset + 3] = Math.round(alphaSum / samples * 255);
  }
  return out;
}
function makeDib(size, rgba) {
  const rowBytes = size * 4;
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const imageSize = rowBytes * size + maskRowBytes * size;
  const dib = Buffer.alloc(40 + imageSize);
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14); dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(imageSize, 20); dib.writeInt32LE(0, 24); dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32); dib.writeUInt32LE(0, 36);
  let cursor = 40;
  for (let y = size - 1; y >= 0; y -= 1) for (let x = 0; x < size; x += 1) {
    const source = (y * size + x) * 4;
    dib[cursor++] = rgba[source + 2]; dib[cursor++] = rgba[source + 1]; dib[cursor++] = rgba[source]; dib[cursor++] = rgba[source + 3];
  }
  cursor += maskRowBytes * size;
  return dib;
}
function makeIco() {
  const entries = SIZES.map((size) => makeDib(size, scaledPixels(size)));
  const headerSize = 6 + entries.length * 16;
  const totalSize = headerSize + entries.reduce((sum, entry) => sum + entry.length, 0);
  const ico = Buffer.alloc(totalSize);
  ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(entries.length, 4);
  let offset = headerSize;
  entries.forEach((entry, index) => {
    const base = 6 + index * 16;
    ico[base] = SIZES[index] === 256 ? 0 : SIZES[index]; ico[base + 1] = SIZES[index] === 256 ? 0 : SIZES[index];
    ico[base + 2] = 0; ico[base + 3] = 0; ico.writeUInt16LE(1, base + 4); ico.writeUInt16LE(32, base + 6);
    ico.writeUInt32LE(entry.length, base + 8); ico.writeUInt32LE(offset, base + 12);
    entry.copy(ico, offset); offset += entry.length;
  });
  fs.writeFileSync(TARGET, ico);
}

renderLogo();
makeIco();
console.log(`Đã tạo icon Taylor ND Audio: ${TARGET}`);
