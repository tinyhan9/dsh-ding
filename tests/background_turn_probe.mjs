/**
 * 复现「在 A 会话发问、看着 B 会话，A 结束时没响」这个场景 ——
 * 也就是「当前主会话」判定把后台结束吞掉的那一类。
 *
 * 做法：开一个页面 → 在会话 A 里发一句话 → 立刻切到另一个会话 →
 * 等 A 那一轮在后台跑完 → 看 rings 有没有涨。
 *
 * 跑法：node tests/background_turn_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./find_chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:37952";
const SECRET = process.argv[3];
const CHROME = findChrome(process.argv[4]);
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node background_turn_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
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

profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-bg-"));
const port = 9391;
chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--disable-gpu", "--autoplay-policy=no-user-gesture-required", "--window-size=1440,1000", "about:blank"],
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
await send("Page.navigate", { url: `${BASE}/` });
await sleep(5000);

for (let attempt = 0; attempt < 80; attempt++) {
  const ready = await evaluate(`!!(window.__DSH_DING__ && window.__DSH_DING__.watching)`);
  if (ready) break;
  await sleep(250);
}
console.log("plugin:", await evaluate(`window.__DSH_DING__ ? window.__DSH_DING__.version : "MISSING"`));
console.log("settings:", JSON.stringify(await evaluate(`window.__DSH_DING__ ? window.__DSH_DING__.settings() : null`)));

/* 关掉首次安装的两个弹窗。 */
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

const before = await evaluate(`window.__DSH_DING__.rings`);

/* 在 A 会话发一句话。 */
const focused = await evaluate(`(function () {
  var editor = document.querySelector('[contenteditable="true"]');
  if (editor === null) return 'no editor';
  editor.focus();
  return 'focused';
})()`);
if (focused !== "focused") {
  console.error(`FAIL  composer not usable: ${focused}`);
  cleanup();
  process.exit(1);
}
await send("Input.insertText", { text: "只回复两个字：收到" });
await sleep(400);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
console.log("prompt sent; now switching to another session while the turn runs…");
await sleep(900);

/* 切到「新会话」—— 让 A 变成后台会话。 */
await evaluate(`(function () {
  var hit = Array.from(document.querySelectorAll('button')).find(function (n) {
    return n.getAttribute('aria-label') === '新建会话' && (n.textContent || '').trim() === '';
  });
  if (hit !== undefined) { hit.click(); return true; }
  var byText = Array.from(document.querySelectorAll('button')).find(function (n) {
    return (n.textContent || '').trim().startsWith('新会话');
  });
  if (byText !== undefined) { byText.click(); return true; }
  return false;
})()`);
await sleep(1500);
console.log("still on the background turn, watching another session");

let observed = before;
for (let attempt = 0; attempt < 200; attempt++) {
  await sleep(500);
  observed = await evaluate(`window.__DSH_DING__.rings`);
  if (observed > before) break;
}

const trace = await evaluate(`window.__DSH_DING__.trace.slice(-12)`);
console.log(`rings ${before} → ${observed} (delta ${observed - before})`);
console.log("trace:", JSON.stringify(trace, null, 0));

socket.close();
cleanup();
if (observed > before) {
  console.log("OK  a turn that finishes while you look at another session still rings");
  process.exit(0);
}
console.log("FAIL  background turn end did not ring");
process.exit(4);
