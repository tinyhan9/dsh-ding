/**
 * 验证一个具体假设：dsh-whale-widget 的「每轮消耗提示」设置**只在页面加载时读一次**，
 * 所以服务端关掉之后，已经打开的页面仍会继续响，必须刷新页面才生效。
 *
 * 三段：
 *   ① 页面加载 → 服务端把 taskEnd 打开 → 跑一轮 → 看 whale 有没有响（预期：**响**，证明页面用的是加载时的值）
 *   ② 页面刷新 → 服务端 taskEnd 已是关 → 跑一轮 → 看 whale 有没有响（预期：**不响**）
 *   ③ 同一页面（未刷新）再把服务端改为开 → 跑一轮 → 看有没有响（预期：**仍不响**，证明没有重新读取）
 *
 * 跑法：node tests/whale_reload_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
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
  console.error("usage: node whale_reload_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
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
/* setCookie 的 value 只要值本身，不要 `name=value` —— 否则服务器收到的是
   `dsh-auth-xxx=dsh-auth-xxx=...`，鉴权失败，页面停在 "authentication required"。 */
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;
/* fetch 请求头要的是完整的 `name=value`。 */
const cookieHeader = `${cookieName}=${cookieValue}`;

/** 读 / 写 whale 的任务结束音开关。 */
async function setTaskEnd(on) {
  const response = await fetch(`${BASE}/dsh-whale/usage-settings.json`, {
    method: "PUT",
    headers: { cookie: cookieHeader, "Content-Type": "application/json" },
    body: JSON.stringify({ taskEnd: { on } }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`PUT taskEnd=${on} → ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).settings.taskEnd;
}

profileDir = mkdtempSync(join(tmpdir(), "dsh-whale-reload-"));
const port = 9421;
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
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
(function () {
  if (window.__AUDIO_TRACE__ !== undefined) return;
  var trace = [];
  window.__AUDIO_TRACE__ = trace;
  function caller(stack) { return String(stack || "").split("\\n").slice(2, 7).join(" | ").slice(0, 240); }
  var mediaPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    trace.push({ kind: "media", at: Date.now(), where: caller(new Error().stack) });
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

/** 让页面进入可输入状态。 */
async function ready() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await evaluate(`!!(window.__DSH_DING__ && window.__DSH_DING__.watching)`)) break;
    await sleep(250);
  }
  await evaluate(`(function () {
    Array.from(document.querySelectorAll('input[type=checkbox]')).forEach(function (box) { if (!box.checked) box.click(); });
    return true;
  })()`);
  await sleep(300);
  for (const label of ["我已知晓并继续", "继续"]) {
    await evaluate(`(function () {
      var hit = Array.from(document.querySelectorAll('button,[role="tab"],a')).find(function (n) {
        return (n.textContent || '').trim() === ${JSON.stringify(label)};
      });
      if (hit !== undefined) hit.click();
      return hit !== undefined;
    })()`);
    await sleep(1100);
  }
}

/** 跑一轮并返回本轮里来自 whale 的播放次数。 */
async function runTurn(label) {
  await evaluate(`window.__AUDIO_TRACE__.length = 0`);
  const focused = await evaluate(`(function () {
    var editor = document.querySelector('[contenteditable="true"]');
    if (editor === null) return false;
    editor.focus();
    return true;
  })()`);
  if (focused !== true) {
    console.error(`${label}: composer not usable`);
    return -1;
  }
  await send("Input.insertText", { text: "只回复两个字：收到" });
  await sleep(400);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(18000);
  const trace = await evaluate(`window.__AUDIO_TRACE__`);
  const whale = Array.isArray(trace) ? trace.filter((entry) => String(entry.where ?? "").includes("dsh-whale")) : [];
  const ding = Array.isArray(trace) ? trace.filter((entry) => String(entry.where ?? "").includes("scheduleScore")) : [];
  console.log(`${label}: whale 播放 ${whale.length} 次，dsh-ding 播放 ${ding.length} 次`);
  return whale.length;
}

/* ---------- ① 页面加载时 taskEnd 是开的 ---------- */
await setTaskEnd(true);
console.log("server taskEnd = true");
await send("Page.navigate", { url: `${BASE}/` });
await sleep(5500);
await ready();
const first = await runTurn("① 页面加载(=on) 后跑一轮");

/* ---------- ② 服务端关掉 + 刷新页面 ---------- */
await setTaskEnd(false);
console.log("\nserver taskEnd = false");
await send("Page.reload", { ignoreCache: false });
await sleep(5500);
await ready();
const second = await runTurn("② 关掉并刷新后跑一轮");

/* ---------- ③ 不刷新，只把服务端改回 on ---------- */
await setTaskEnd(true);
console.log("\nserver taskEnd = true (页面未刷新)");
const third = await runTurn("③ 服务端改回 on、但不刷新，跑一轮");

/* 收尾：保持关闭，与用户当前期望一致。 */
await setTaskEnd(false);
console.log("\nserver taskEnd = false (已恢复为关)");

socket.close();
cleanup();

console.log(`\n结论：① ${first} ② ${second} ③ ${third}`);
if (first > 0 && second === 0 && third === 0) {
  console.log("CONFIRMED  设置只在页面加载时读一次：刷新即生效，不刷新则维持打开时的值");
  process.exit(0);
}
console.log("UNEXPECTED  与预期不符，需要继续查");
process.exit(4);
