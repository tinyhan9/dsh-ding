/**
 * 自动播放策略验收：复现「桌面端真实情况」——不给 Chrome 任何 autoplay 豁免。
 *
 * 这是这次「对话结束没有提示音」的现场复现：
 *   ① 页面刚加载时 AudioContext 是 suspended；
 *   ② 没有用户手势时 resume() 的 promise 一直悬着，于是旧代码既不发声也不走兜底；
 *   ③ 真实点击一次之后，插件应把音频通道解锁（AudioContext → running）；
 *   ④ 之后再跑一轮，提示音必须自己响，且走的是 WebAudio 而不是兜底。
 *
 * 跑法：node tests/autoplay_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./find_chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:17868";
const SECRET = process.argv[3];
const CHROME = findChrome(process.argv[4]);
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node autoplay_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
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
const fail = (message) => {
  console.error(`FAIL  ${message}`);
  cleanup();
  process.exit(1);
};
const ok = (message) => console.log(`ok    ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* cookie */
const authority = new URL(BASE).host;
const b64url = (buffer) =>
  Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now();
const body = b64url(
  Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 6 * 3600 * 1000 }), "utf8"),
);
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

/* chrome：故意不加 --autoplay-policy，保持浏览器默认策略 */
profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-autoplay-"));
const port = 9352;
chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1440,1000",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let version;
for (let attempt = 0; attempt < 80; attempt++) {
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    break;
  } catch {
    await sleep(250);
  }
}
if (version === undefined) fail("chrome debugging endpoint never came up");
ok(`chrome ${version.Browser} (default autoplay policy, no exemption flag)`);

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
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? "threw");
  return result.result.value;
};
const clickText = (text) =>
  evaluate(`(function () {
    var hit = Array.from(document.querySelectorAll('button,[role="tab"],a')).find(function (node) {
      return (node.textContent || '').trim() === ${JSON.stringify(text)};
    });
    if (hit === undefined) return false;
    hit.click();
    return true;
  })()`);

await send("Runtime.enable");
await send("Page.enable");
await send("Network.enable");
await send("Network.setCookie", {
  name: cookieName,
  value: cookieValue,
  domain: "127.0.0.1",
  path: "/",
  httpOnly: true,
  sameSite: "Strict",
});
await send("Page.navigate", { url: `${BASE}/` });
await sleep(4800);

/* ① 插件活没活 */
let diag = null;
for (let attempt = 0; attempt < 60; attempt++) {
  diag = await evaluate(`window.__DSH_DING__ === undefined ? null : window.__DSH_DING__.audio()`);
  if (diag !== null) break;
  await sleep(250);
}
if (diag === null) fail("window.__DSH_DING__ missing: bundle never materialized");
ok(`plugin alive, audio before any gesture: ${JSON.stringify(diag)}`);
if (diag.unlocked !== false) fail("audio must not be reported as unlocked before any gesture");

/* ② 关掉首次安装的两屏（这两下需要真实点击，正好也当解锁手势） */
await evaluate(`(function () {
  Array.from(document.querySelectorAll('input[type=checkbox]')).forEach(function (box) { if (!box.checked) box.click(); });
  return true;
})()`);
await sleep(300);

/* 用真实鼠标事件点一下正文，代替 any 合成 click —— 浏览器只认 isTrusted 的输入。 */
for (const type of ["mousePressed", "mouseReleased"]) {
  await send("Input.dispatchMouseEvent", { type, x: 720, y: 500, button: "left", clickCount: 1 });
}
await sleep(700);

diag = await evaluate(`window.__DSH_DING__.audio()`);
ok(`audio after a real click: ${JSON.stringify(diag)}`);
if (diag.unlocked !== true) fail("a real pointerdown must unlock audio");
if (diag.state !== "running") fail(`AudioContext must reach running after unlocking, got ${diag.state}`);

/* ③ 关掉两个弹窗，进入可输入状态 */
if (await clickText("我已知晓并继续")) await sleep(1100);
if (await clickText("继续")) await sleep(1400);

/* ④ 打字并回车，等这一轮结束 */
const focused = await evaluate(`(function () {
  var editor = document.querySelector('[contenteditable="true"]');
  if (editor === null) return 'no editor';
  editor.focus();
  return 'focused';
})()`);
if (focused !== "focused") fail(`composer not usable: ${focused}`);

const baseline = await evaluate(`window.__DSH_DING__.rings`);
await send("Input.insertText", { text: "只回复两个字：收到" });
await sleep(500);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

let observed = null;
for (let attempt = 0; attempt < 180; attempt++) {
  await sleep(500);
  observed = await evaluate(`({ rings: window.__DSH_DING__.rings, path: window.__DSH_DING__.lastPath, audio: window.__DSH_DING__.audio() })`);
  if (observed.rings > baseline) break;
}
if (observed === null || observed.rings <= baseline) fail("no ring observed at turn end");
ok(`ring fired: rings ${baseline} → ${observed.rings}, path=${observed.path}, audio=${JSON.stringify(observed.audio)}`);
if (observed.path !== "webaudio") fail(`expected the WebAudio path, got ${observed.path}`);

socket.close();
console.log("OK  autoplay: default policy, gesture unlock, turn end rings through WebAudio");
cleanup();
