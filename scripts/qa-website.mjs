// Kiểm tra HTML, thao tác bàn phím, demo, axe và Lighthouse trên website tĩnh.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import lighthouse from "lighthouse";
import { HtmlValidate } from "html-validate";

const require = createRequire(import.meta.url);
const chromeLauncher = require("chrome-launcher");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = path.join(ROOT, "website");
const REPORTS = path.join(ROOT, "brand", "exports", "preview");
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8" };

async function validateHtml() {
  const validator = new HtmlValidate();
  const files = [path.join(SITE, "index.html"), path.join(SITE, "privacy.html"), path.join(SITE, "terms.html"), path.join(SITE, "licenses.html"), path.join(ROOT, "brand", "explorations.html"), path.join(ROOT, "brand", "guidelines.html")];
  const errors = [];
  for (const file of files) {
    const result = await validator.validateString(fs.readFileSync(file, "utf8"), file);
    if (!result.valid) errors.push(...result.results.flatMap((item) => item.messages.map((message) => path.relative(ROOT, file) + ":" + message.line + ":" + message.column + " " + message.message)));
  }
  if (errors.length) throw new Error("Kiểm tra HTML thất bại:\n" + errors.join("\n"));
  console.log("HTML hợp lệ: " + files.length + " trang.");
}

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(SITE, relative);
    if (!file.startsWith(SITE + path.sep) && file !== path.join(SITE, "index.html")) {
      response.writeHead(403); response.end("Forbidden"); return;
    }
    fs.readFile(file, (error, data) => {
      if (error) { response.writeHead(404); response.end("Not found"); return; }
      const compressible = /\.(html|css|js|json|svg|xml|txt|webmanifest)$/i.test(file);
      const compressed = compressible && /\bgzip\b/.test(request.headers["accept-encoding"] || "") ? gzipSync(data) : data;
      const headers = { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "cache-control": "public, max-age=3600" };
      if (compressed !== data) { headers["content-encoding"] = "gzip"; headers.vary = "accept-encoding"; }
      response.writeHead(200, headers);
      response.end(compressed);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function axeCheck(page, label) {
  await page.addScriptTag({ path: require.resolve("axe-core") });
  const results = await page.evaluate(async () => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] }
  }));
  const violations = results.violations.map((item) => ({
    id: item.id,
    impact: item.impact,
    description: item.help,
    nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary }))
  }));
  console.log("axe " + label + ": " + results.passes.length + " mục đạt, " + violations.length + " lỗi.");
  violations.forEach((item) => console.log("  " + item.id + ": " + item.description + " — " + item.nodes.map((node) => node.target.join(" ")).join(", ")));
  return violations;
}

// Tắt hoãn vẽ chỉ trong ảnh chụp, để ảnh dài vẫn chứa đủ mọi mục ở xa màn hình.
async function captureFullPage(page, file) {
  const style = await page.addStyleTag({ content: "main > .section, main > .demo-section, main > .download-section, .feature-card { content-visibility: visible !important; contain-intrinsic-size: auto !important; }" });
  await page.screenshot({ path: file, fullPage: true });
  await style.evaluate((element) => element.remove());
}

async function main() {
  await validateHtml();
  fs.mkdirSync(REPORTS, { recursive: true });
  const server = await startServer();
  const origin = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => { if (response.status() >= 400) consoleErrors.push(response.status() + " " + response.url()); });
  await page.goto(origin, { waitUntil: "networkidle" });
  await captureFullPage(page, path.join(REPORTS, "website-desktop.png"));
  let violations = await axeCheck(page, "tiếng Việt, giao diện tối");

  await page.locator("#languageToggle").click();
  await page.waitForFunction(() => document.documentElement.lang === "en");
  if (!(await page.locator("html").getAttribute("lang") === "en")) throw new Error("Nút ngôn ngữ không chuyển sang English.");
  violations.push(...await axeCheck(page, "English, giao diện tối"));
  await page.locator("#themeToggle").click();
  if (!(await page.locator("body").evaluate((element) => element.classList.contains("light-mode")))) throw new Error("Nút giao diện sáng không hoạt động.");
  await captureFullPage(page, path.join(REPORTS, "website-light.png"));
  violations.push(...await axeCheck(page, "English, giao diện sáng"));

  await page.locator("#languageToggle").click();
  await page.locator("#themeToggle").click();
  await page.getByRole("button", { name: "Phát âm thanh mẫu" }).click();
  await page.getByRole("button", { name: /A\/B/ }).click();
  await page.waitForTimeout(250);
  const demoStatus = await page.locator("#demoStatus").textContent();
  if (!(await demoStatus).includes("Đang phát")) throw new Error("Demo Web Audio chưa khởi động.");
  await page.getByRole("button", { name: "Dừng âm thanh mẫu" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileWidth = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  if (mobileWidth.document > mobileWidth.viewport || mobileWidth.body > mobileWidth.viewport) throw new Error("Trang bị tràn ngang trên di động: " + JSON.stringify(mobileWidth));
  await captureFullPage(page, path.join(REPORTS, "website-mobile.png"));
  const menu = page.getByRole("button", { name: "Mở điều hướng" });
  await menu.click();
  if (!(await page.locator("#mobileNav").isVisible())) throw new Error("Menu di động chưa mở.");
  await page.getByRole("link", { name: "Tính năng" }).last().click();
  if (!(await page.locator("#mobileNav").isHidden())) throw new Error("Menu di động chưa tự đóng.");
  violations.push(...await axeCheck(page, "giao diện di động"));

  for (const pathName of ["privacy.html", "terms.html", "licenses.html"]) {
    await page.goto(origin + "/" + pathName, { waitUntil: "networkidle" });
    violations.push(...await axeCheck(page, pathName));
  }
  if (consoleErrors.length) throw new Error("Lỗi JavaScript trong trình duyệt:\n" + consoleErrors.join("\n"));
  if (violations.length) {
    fs.writeFileSync(path.join(REPORTS, "axe-violations.json"), JSON.stringify(violations, null, 2));
    throw new Error("axe phát hiện " + violations.length + " trường hợp cần xử lý; xem brand/exports/preview/axe-violations.json.");
  }
  fs.rmSync(path.join(REPORTS, "axe-violations.json"), { force: true });
  console.log("Tương tác Việt/Anh, sáng/tối, menu di động và demo Web Audio: đạt.");
  await browser.close();

  const chrome = await chromeLauncher.launch({
    chromePath: chromium.executablePath(),
    chromeFlags: ["--headless", "--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const report = await lighthouse(origin, {
      port: chrome.port,
      output: ["json"],
      onlyCategories: ["performance", "accessibility", "best-practices", "seo"],
      formFactor: "desktop",
      throttlingMethod: "provided",
      throttling: { rttMs: 0, throughputKbps: 100000, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 100000, uploadThroughputKbps: 100000 },
      screenEmulation: { mobile: false, width: 1440, height: 960, deviceScaleFactor: 1, disabled: false }
    });
    const categories = report.lhr.categories;
    const scores = Object.fromEntries(Object.entries(categories).map(([name, category]) => [name, Math.round(category.score * 100)]));
    fs.writeFileSync(path.join(REPORTS, "lighthouse-report.json"), report.report[0], "utf8");
    console.log("Lighthouse desktop: " + Object.entries(scores).map(([name, score]) => name + " " + score).join(" · "));
    if (Object.values(scores).some((score) => score < 95)) {
      console.warn("Có mục Lighthouse dưới 95; xem báo cáo Lighthouse và tiếp tục tối ưu.");
    }
  } finally {
    await chrome.kill();
    server.closeAllConnections();
    server.close();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
