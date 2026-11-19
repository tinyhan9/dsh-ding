/**
 * 查「一轮结束听到两声重叠」：在一轮里记录**页面上所有**音频播放调用
 * （HTMLMediaElement.play 与 WebAudio 的 BufferSource / Oscillator 起播），
 * 再看每一项来自哪个插件。
 *
 * 跑法：node tests/audio_sources_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./find_chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:17770";
const SECRET = process.argv[3];
const CHROME = findChrome(process.argv[4]);
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node audio_sources_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
  process.exit(2);
}

let chrome;
let profileDir;
const cleanup = () => {
  try {
    chrome?.kill();
  } catch {
    /* 已退出。 */
  }
  if (profileDir !== undefined) {
    try {
      rmSync(profileDir, { recursive: true, force: true });
    } catch {
      /* 忽略。 */
    }
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const authority = new URL(BASE).host;
const b64url = (buffer) =>
  Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now();
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600 * 1000 }), "utf8"));
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

profileDir = mkdtempSync(join(tmpdir(), "dsh-audio-src-"));
const port = 9411;
chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await sleep(250);
  }
}
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id === undefined) return;
  const entry = pending.get(message.id);
  if (entry === undefined) return;
  pending.delete(message.id);
  if (message.error !== undefined) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) return undefined;
  return result.result.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Network.setCookie", { name: cookieName, value: cookieValue, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Strict" });

/* 在页面加载前就装好钩子：任何 play() / start() 都会记一笔，带上调用栈。 */
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(function () {
  if (window.__AUDIO_TRACE__ !== undefined) return;
  var trace = [];
  window.__AUDIO_TRACE__ = trace;
  function caller(stack) {
    var lines = String(stack || "").split("\\n").slice(2, 7).join(" | ");
    return lines.slice(0, 240);
  }
  var mediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    trace.push({ kind: "media", src: String(this.src || "").slice(0, 80), at: Date.now(), where: caller(new Error().stack) });
    return mediaPlay.apply(this, arguments);
  };
  if (window.AudioContext) {
    var startBuf = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function () {
      trace.push({ kind: "buffer", at: Date.now(), where: caller(new Error().stack) });
      return startBuf.apply(this, arguments);
    };
    var startOsc = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function () {
      trace.push({ kind: "oscillator", at: Date.now(), where: caller(new Error().stack) });
      return startOsc.apply(this, arguments);
    };
  }
})();
`,
});

await send("Page.navigate", { url: `${BASE}/` });
await sleep(5500);

await evaluate(`(function () {
  Array.from(document.querySelectorAll('input[type=checkbox]')).forEach(function (box) { if (!box.checked) box.click(); });
  return true;
})()`);
await sleep(350);
for (const label of ["我已知晓并继续", "继续"]) {
  await evaluate(`(function () {
    var hit = Array.from(document.querySelectorAll('button,[role="tab"],a')).find(function (n) {
      return (n.textContent || '').trim() === ${JSON.stringify(label)};
    });
    if (hit !== undefined) hit.click();
    return hit !== undefined;
  })()`);
  await sleep(1200);
}

/* 清空 trace，只看这一轮。 */
await evaluate(`window.__AUDIO_TRACE__.length = 0`);

const focused = await evaluate(`(function () {
  var editor = document.querySelector('[contenteditable="true"]');
  if (editor === null) return 'no editor';
  editor.focus();
  return 'focused';
})()`);
if (focused !== "focused") {
  console.error(`FAIL  composer not usable: ${focused}`);
  socket.close();
  cleanup();
  process.exit(1);
}

await send("Input.insertText", { text: "只回复两个字：收到" });
await sleep(400);
const sentAt = Date.now();
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

await sleep(20000);

const trace = await evaluate(`window.__AUDIO_TRACE__`);
const whale = await evaluate(`({
  hasUsageSet: typeof usageSet !== "undefined",
  taskEnd: (typeof usageSet !== "undefined" && usageSet) ? usageSet.taskEnd : "(no usageSet)",
  soundOn: typeof soundOn !== "undefined" ? soundOn : "(undefined)",
  turnCostOn: typeof turnCostOn !== "undefined" ? turnCostOn : "(undefined)",
  soundSet: typeof soundSet !== "undefined" ? soundSet : "(undefined)",
  lastSeq: (function () { try { return localStorage.getItem("dshw-last-seq"); } catch (e) { return "?"; } })()
})`);
const ding = await evaluate(`window.__DSH_DING__ ? { rings: window.__DSH_DING__.rings, trace: window.__DSH_DING__.trace.slice(-8) } : null`);

console.log("=== 页面音频播放调用（本轮）===");
if (Array.isArray(trace)) {
  for (const entry of trace) {
    console.log(`  +${String(entry.at - sentAt).padStart(6)}ms  ${entry.kind.padEnd(11)} ${entry.src ?? ""}`);
    if (entry.where !== undefined && entry.kind !== "media") console.log(`             ${entry.where}`);
  }
  console.log(`  合计 ${trace.length} 次`);
} else {
  console.log("  (未取到 trace)");
}

console.log("\n=== dsh-ding ===");
console.log(JSON.stringify(ding, null, 0));

console.log("\n=== dsh-whale-widget 状态 ===");
console.log(JSON.stringify(whale, null, 2));

socket.close();
cleanup();
