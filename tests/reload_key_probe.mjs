/**
 * 实测桌面端里「刷新页面」到底有没有快捷键：直接往页面发 Ctrl+R / F5 / Ctrl+Shift+R，
 * 看页面文档有没有真的重新加载（用 performance.timeOrigin 变化判断）。
 *
 * 跑法：node tests/reload_key_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChrome } from "./find_chrome.mjs";

const BASE = process.argv[2] ?? "http://127.0.0.1:43407";
const SECRET = process.argv[3];
const CHROME = findChrome(process.argv[4]);
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node reload_key_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const authority = new URL(BASE).host;
const b64url = (buffer) =>
  Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now();
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600 * 1000 }), "utf8"));
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

const profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-reload-"));
const port = 9381;
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--disable-gpu", "--window-size=1440,1000", "about:blank"],
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

/** 打一组按键，返回页面是否重新加载过。 */
async function tryKeys(label, keys, modifiers) {
  const before = await evaluate(`performance.timeOrigin`);
  for (const key of keys) {
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.vk,
      nativeVirtualKeyCode: key.vk,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      modifiers,
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.vk,
      nativeVirtualKeyCode: key.vk,
    });
  }
  await sleep(2500);
  const after = await evaluate(`performance.timeOrigin`);
  const reloaded = typeof before === "number" && typeof after === "number" && after !== before;
  console.log(`${label.padEnd(22)} reload=${reloaded}  (timeOrigin ${before} → ${after})`);
  return reloaded;
}

const R = { key: "r", code: "KeyR", vk: 82 };
const F5 = { key: "F5", code: "F5", vk: 116 };

await tryKeys("Ctrl+R", [R], 2);
await tryKeys("Ctrl+Shift+R", [R], 3);
await tryKeys("F5", [F5], 0);
await tryKeys("Ctrl+F5", [F5], 2);

socket.close();
chrome.kill();
await sleep(300);
try {
  rmSync(profileDir, { recursive: true, force: true });
} catch {
  /* 忽略。 */
}
