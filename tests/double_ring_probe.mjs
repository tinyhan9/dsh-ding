/**
 * 复现「一轮结束听到两声重叠」：跑一轮，把 trace 里每条 turn-end / ring / skip 的
 * 时间戳与来源全部记下来，看是一个会话响了两次，还是两个会话各响一次。
 *
 * 跑法：node tests/double_ring_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
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
  console.error("usage: node double_ring_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
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

profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-double-"));
const port = 9401;
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
console.log("watched:", await evaluate(`window.__DSH_DING__.watched`));

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

const baseline = await evaluate(`window.__DSH_DING__.rings`);
const traceStart = await evaluate(`window.__DSH_DING__.trace.length`);

await evaluate(`(function () {
  var editor = document.querySelector('[contenteditable="true"]');
  if (editor === null) return 'no editor';
  editor.focus();
  return 'focused';
})()`);
await send("Input.insertText", { text: "只回复两个字：收到" });
await sleep(400);
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

/* 等到第一声之后再多观察 12 秒，捕捉「第二声」。 */
let firstRingAt = 0;
for (let attempt = 0; attempt < 200; attempt++) {
  await sleep(400);
  const rings = await evaluate(`window.__DSH_DING__.rings`);
  if (rings > baseline) {
    firstRingAt = Date.now();
    break;
  }
}
if (firstRingAt === 0) {
  console.error("FAIL  no ring observed");
  socket.close();
  cleanup();
  process.exit(1);
}
await sleep(12000);

const rings = await evaluate(`window.__DSH_DING__.rings`);
const trace = await evaluate(`window.__DSH_DING__.trace.slice(-30)`);

console.log(`rings ${baseline} → ${rings} (delta ${rings - baseline})`);
console.log("trace:");
for (const entry of trace) {
  console.log(`  +${String(entry.at - trace[0].at).padStart(6)}ms  ${entry.kind.padEnd(9)} ${entry.detail}`);
}

const ends = trace.filter((entry) => entry.kind === "turn-end");
console.log(`\nturn-end entries: ${ends.length}`);
for (let index = 1; index < ends.length; index++) {
  console.log(`  gap between turn-end #${index} and #${index + 1}: ${ends[index].at - ends[index - 1].at} ms`);
}

socket.close();
cleanup();
if (rings - baseline > 1) {
  console.log(`\nREPRODUCED  ${rings - baseline} rings for a single turn`);
  process.exit(4);
}
console.log("\nOK  exactly one ring for this turn");
