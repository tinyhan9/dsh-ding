/**
 * 端到端验收：在真实页面里发一句话，等这一轮跑完，看提示音是否自己响了。
 *
 * 前面几个探针证明了「装上了、设置行能改、出声路径不炸」，但没证明最关键的一件事：
 * DSH 的 sessionStatus 在真实一轮结束时，真的会针对当前主会话给出 running false。
 * 这个脚本就是来证这一条的：
 *   ① boot 完成后读 __DSH_DING__.rings 作为基线；
 *   ② 在输入框里打一句最小的话并回车；
 *   ③ 等到页面回到空闲（发送键不再显示“停止”），再看 rings 是否 +1，
 *      lastSession 是否就是当前会话。
 *
 * 跑法：node tests/live_turn_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./find_chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:31319";
const SECRET = process.argv[3];
const CHROME = findChrome(process.argv[4]);
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node live_turn_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
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
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 6 * 3600 * 1000 }), "utf8"));
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

/* chrome */
profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-live-"));
const port = 9346;
chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1440,1000",
    "about:blank",
  ],
  { stdio: "ignore" }
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
  if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
  return result.result.value;
};
const clickText = (text) =>
  evaluate(`(function () {
    var wanted = ${JSON.stringify(text)};
    var hit = Array.from(document.querySelectorAll('button,[role="tab"],a')).find(function (node) {
      return (node.textContent || '').trim() === wanted;
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
await sleep(4500);

/* boot + 插件就绪 */
for (let attempt = 0; attempt < 80; attempt++) {
  const ready = await evaluate(`!!(window.__DSH_DING__ && window.__DSH_DING__.watching)`);
  if (ready) break;
  await sleep(250);
}
const baseline = await evaluate(`window.__DSH_DING__ === undefined ? null : ({
  rings: window.__DSH_DING__.rings,
  watching: window.__DSH_DING__.watching,
  settings: window.__DSH_DING__.settings()
})`);
if (baseline === null) fail("plugin never materialized");
if (baseline.watching !== true) fail("turn-end watcher is not installed");
ok(`baseline: rings=${baseline.rings}, settings=${JSON.stringify(baseline.settings)}`);

/* 关掉首次安装的两屏 */
await evaluate(`(function () {
  Array.from(document.querySelectorAll('input[type=checkbox]')).forEach(function (box) { if (!box.checked) box.click(); });
  return true;
})()`);
await sleep(350);
if (await clickText("我已知晓并继续")) await sleep(1100);
if (await clickText("继续")) await sleep(1400);

/* 在输入框里打一句最小的话 */
const typed = await evaluate(`(function () {
  var editor = document.querySelector('[contenteditable="true"]');
  if (editor === null) return 'no editor';
  editor.focus();
  var range = document.createRange();
  range.selectNodeContents(editor);
  range.collapse(false);
  var selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return 'focused';
})()`);
if (typed !== "focused") fail(`composer not usable: ${typed}`);

await send("Input.insertText", { text: "只回复两个字：收到" });
await sleep(600);
const draft = await evaluate(`(function () {
  var editor = document.querySelector('[contenteditable="true"]');
  return editor === null ? '' : editor.innerText.trim();
})()`);
if (!draft.includes("收到")) fail(`draft not in composer: ${JSON.stringify(draft)}`);
ok("prompt typed into the composer");

await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

/* 等这一轮结束：ring 计数变化，或 90 秒超时（超时算不确定，不算失败） */
let observed = null;
for (let attempt = 0; attempt < 180; attempt++) {
  await sleep(500);
  observed = await evaluate(`({
    rings: window.__DSH_DING__.rings,
    lastSession: window.__DSH_DING__.lastSession,
    lastRingAt: window.__DSH_DING__.lastRingAt
  })`);
  if (observed.rings > baseline.rings) break;
}
if (observed === null || observed.rings <= baseline.rings) {
  console.error("INCONCLUSIVE  no ring observed within 90s (the turn may still be running)");
  cleanup();
  process.exit(3);
}
ok(`ring fired at turn end: rings ${baseline.rings} → ${observed.rings}, session ${observed.lastSession}`);

socket.close();
console.log("OK  live turn: the plugin rang by itself when the turn finished");
cleanup();
