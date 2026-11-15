/**
 * 回答一个很实际的问题：改完插件，**要不要手动刷新页面**？
 *
 * 做法：开一个真页面，读当前 `__DSH_DING__.version`；然后在外部改一下
 * `lib/client.js`（只改 version 字符串，改完立刻还原）；再在**同一个页面**里轮询
 * 那个 version。如果它自己变了，说明 Host 的 HMR 已经把新 bundle 推进来了，
 * 不需要刷新；如果一直不变，就说明必须刷新/重启。
 *
 * 跑法：node tests/hmr_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
 */
import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "./find_chrome.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const clientPath = join(here, "..", "lib", "client.js");
const BASE = process.argv[2] ?? "http://127.0.0.1:43407";
const SECRET = process.argv[3];
const CHROME = findChrome(process.argv[4]);
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node hmr_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
  process.exit(2);
}

let chrome;
let profileDir;
let original;
const restore = () => {
  if (original !== undefined) {
    try {
      writeFileSync(clientPath, original);
    } catch {
      /* 还原失败就明确报出来。 */
      console.error("WARNING: failed to restore lib/client.js — restore it by hand");
    }
  }
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
process.on("exit", restore);
process.on("SIGINT", () => {
  restore();
  process.exit(130);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const authority = new URL(BASE).host;
const b64url = (buffer) =>
  Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now();
const body = b64url(
  Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600 * 1000 }), "utf8"),
);
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-hmr-"));
const port = 9371;
chrome = spawn(
  CHROME,
  [`--headless=new`, `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--disable-gpu", "about:blank"],
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
await send("Network.setCookie", {
  name: cookieName,
  value: cookieValue,
  domain: "127.0.0.1",
  path: "/",
  httpOnly: true,
  sameSite: "Strict",
});
await send("Page.navigate", { url: `${BASE}/` });
await sleep(5000);

let before = null;
for (let attempt = 0; attempt < 60; attempt++) {
  before = await evaluate(`window.__DSH_DING__ === undefined ? null : window.__DSH_DING__.version`);
  if (before !== null) break;
  await sleep(250);
}
if (before === null) {
  console.error("FAIL  plugin never materialized");
  restore();
  process.exit(1);
}
console.log(`version in the open page: ${before}`);

/* 在外部改一下源文件（只改 version 字符串）。 */
original = readFileSync(clientPath, "utf8");
const probeVersion = `${before}+hmrprobe`;
const patched = original.replace(`version: "${before}",`, `version: "${probeVersion}",`);
if (patched === original) {
  console.error("FAIL  could not patch the version string");
  restore();
  process.exit(1);
}
writeFileSync(clientPath, patched);
console.log(`patched the file to ${probeVersion}; watching the same page (no reload)…`);

let after = before;
let sawHot = false;
for (let attempt = 0; attempt < 40; attempt++) {
  await sleep(500);
  after = await evaluate(`window.__DSH_DING__ === undefined ? "(gone)" : window.__DSH_DING__.version`);
  if (after === probeVersion) {
    sawHot = true;
    break;
  }
}

restore();
await sleep(300);

if (sawHot) {
  console.log(`ok    the open page picked up the new bundle WITHOUT a reload (${before} → ${after})`);
  console.log("RESULT: HMR is live — a page refresh is not strictly required");
  process.exit(0);
}
console.log(`      the open page still runs ${after} after 20s`);
console.log("RESULT: no hot update — the page must be refreshed (or the app restarted)");
process.exit(3);
