/**
 * 连续多轮实测：在真实页面里连发 3 轮对话，记录每一轮的 rings 变化与
 * sessionStatus / current 的原始快照，用来定位"有时不响"的原因。
 *
 * 跑法：node tests/multi_turn_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./find_chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:43407";
const SECRET = process.argv[3];
const ROUNDS = Number(process.argv[4] ?? 3);
const CHROME = findChrome(process.argv[5]);
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node multi_turn_probe.mjs <baseUrl> <secretBase64Url> [rounds] [chromePath]");
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
const body = b64url(
  Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 6 * 3600 * 1000 }), "utf8"),
);
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-multi-"));
const port = 9361;
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

for (let attempt = 0; attempt < 80; attempt++) {
  const ready = await evaluate(`!!(window.__DSH_DING__ && window.__DSH_DING__.watching)`);
  if (ready) break;
  await sleep(250);
}

/* 把插件内部的判定过程摊开：装一个观察器，记录每次 status 快照。 */
await evaluate(`(function () {
  if (window.__DSH_DING_TRACE__ !== undefined) return 'already';
  window.__DSH_DING_TRACE__ = [];
  return 'installed';
})()`);

await evaluate(`(function () {
  Array.from(document.querySelectorAll('input[type=checkbox]')).forEach(function (box) { if (!box.checked) box.click(); });
  return true;
})()`);
await sleep(350);
if (await clickText("我已知晓并继续")) await sleep(1100);
if (await clickText("继续")) await sleep(1400);

const results = [];
for (let round = 1; round <= ROUNDS; round++) {
  const before = await evaluate(`({
    rings: window.__DSH_DING__.rings,
    lastSession: window.__DSH_DING__.lastSession,
    watching: window.__DSH_DING__.watching,
    audio: window.__DSH_DING__.audio()
  })`);

  const focused = await evaluate(`(function () {
    var editor = document.querySelector('[contenteditable="true"]');
    if (editor === null) return 'no editor';
    editor.focus();
    return 'focused';
  })()`);
  if (focused !== "focused") {
    console.error(`round ${round}: composer not usable`);
    break;
  }

  await send("Input.insertText", { text: `第${round}轮：只回复两个字——收到` });
  await sleep(500);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

  let after = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    await sleep(500);
    after = await evaluate(`({
      rings: window.__DSH_DING__.rings,
      lastSession: window.__DSH_DING__.lastSession,
      audio: window.__DSH_DING__.audio()
    })`);
    if (after.rings > before.rings) break;
  }
  const delta = after.rings - before.rings;
  results.push({ round, delta, before, after });
  console.log(
    `round ${round}: rings ${before.rings} → ${after.rings} (delta ${delta})` +
      `  session ${after.lastSession ?? "(none)"}  audio ${JSON.stringify(after.audio)}`,
  );
  await sleep(1500);
}

const ok = results.filter((row) => row.delta > 0).length;
console.log(`\n${ok}/${results.length} rounds rang`);
socket.close();
cleanup();
process.exit(ok === results.length ? 0 : 4);
