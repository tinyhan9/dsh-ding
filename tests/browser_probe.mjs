/**
 * 真浏览器验收：用无头 Chrome 打开运行中的 DSH 页面，证明插件在真实页面里
 * 真的挂上了、设置行真的画在「通用设置」里、交互真的能改状态。
 *
 * 走 CDP（--remote-debugging-port）+ 原生 WebSocket，不引入任何 npm 依赖。
 * 断言链：
 *   ① 首页 boot 完成，#root 有内容；
 *   ② window.__DSH_DING__ 存在（bundle 已 materialize、apply 已跑）；
 *   ③ 关掉首次安装的两个弹窗后，Ctrl+Alt+, 打开设置 → 通用设置；
 *   ④ 页面上出现「对话结束提示音」这一行，且带 开关 / 音色 / 音量 / 试听；
 *   ⑤ 点开关能写入 localStorage，再点回来能恢复；
 *   ⑥ 诊断面的 ring 路径在真实页面里不抛错；
 *   ⑦ 控制台没有来自 dsh-ding 的报错。
 *
 * 跑法：node tests/browser_probe.mjs <baseUrl> <secretBase64Url> [chromePath]
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
  console.error("usage: node browser_probe.mjs <baseUrl> <secretBase64Url> [chromePath]");
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
      /* 临时目录清不掉不影响验收结论。 */
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

/* ---------- 1. 签一枚浏览器 cookie ---------- */
const authority = new URL(BASE).host;
const b64url = (buffer) =>
  Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now();
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 6 * 3600 * 1000 };
const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
const cookieValue = `v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

/* ---------- 2. 起无头 Chrome ---------- */
profileDir = mkdtempSync(join(tmpdir(), "dsh-ding-chrome-"));
const port = 9344;
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
ok(`chrome ${version.Browser}`);

/* ---------- 3. 建标签页并接管 CDP ---------- */
const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    if (entry !== undefined) {
      pending.delete(message.id);
      if (message.error !== undefined) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    pageErrors.push(message.params.exceptionDetails?.exception?.description ?? "unknown exception");
  }
  if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
    pageErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? "").join(" "));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? "evaluate threw");
  }
  return result.result.value;
};

/** 按可见文字点一个按钮/标签；找不到返回 false。 */
const clickText = (text) =>
  evaluate(`(function () {
    var wanted = ${JSON.stringify(text)};
    var candidates = Array.from(document.querySelectorAll('button,[role="tab"],a,[role="menuitem"]'));
    var hit = candidates.find(function (node) { return (node.textContent || '').trim() === wanted; });
    if (hit === undefined) return false;
    hit.click();
    return true;
  })()`);

/** 点掉首次安装的用户须知 / 预览版说明两屏。 */
async function dismissOnboarding() {
  await evaluate(`(function () {
    Array.from(document.querySelectorAll('input[type=checkbox]')).forEach(function (box) {
      if (!box.checked) box.click();
    });
    return true;
  })()`);
  await sleep(350);
  if (await clickText("我已知晓并继续")) await sleep(1100);
  if (await clickText("继续")) await sleep(1400);
}

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

/* ---------- 4. boot 完成 ---------- */
let booted = false;
for (let attempt = 0; attempt < 80; attempt++) {
  booted = await evaluate(`(function () {
    var root = document.getElementById('root');
    return !!window.__ModuleLoader__ && !!root && root.childElementCount > 0;
  })()`);
  if (booted) break;
  await sleep(250);
}
if (!booted) fail("page never finished booting");
ok("page booted and #root rendered");

/* ---------- 5. 插件在真实页面里活着 ---------- */
let diagnostics = null;
for (let attempt = 0; attempt < 60; attempt++) {
  diagnostics = await evaluate(`window.__DSH_DING__ === undefined ? null : ({
    version: window.__DSH_DING__.version,
    rings: window.__DSH_DING__.rings,
    watching: window.__DSH_DING__.watching,
    settings: window.__DSH_DING__.settings()
  })`);
  if (diagnostics !== null) break;
  await sleep(250);
}
if (diagnostics === null) fail("window.__DSH_DING__ missing: bundle never materialized");
if (diagnostics.watching !== true) fail("plugin did not obtain uiSession: turn-end watcher is not installed");
if (diagnostics.settings.enabled !== true) fail(`unexpected default settings ${JSON.stringify(diagnostics.settings)}`);
ok(`plugin alive: v${diagnostics.version}, watcher installed, defaults ${JSON.stringify(diagnostics.settings)}`);

/* ---------- 6. 走进设置 → 通用设置 ---------- */
await dismissOnboarding();
await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 3, key: ",", code: "Comma", windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188 });
await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 3, key: ",", code: "Comma", windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188 });
await sleep(1800);
const settingsOpen = await evaluate(`document.body.innerText.includes('通用设置')`);
if (!settingsOpen) fail("settings shell did not open (Ctrl+Alt+,)");
ok("settings shell opened");
if (!(await clickText("通用设置"))) fail("general settings section is not reachable");
await sleep(1500);

/* ---------- 7. 提示音这一行真的画出来了 ---------- */
const row = await evaluate(`(function () {
  var label = Array.from(document.querySelectorAll('*')).find(function (node) {
    return node.childElementCount === 0 && (node.textContent || '').trim() === '对话结束提示音';
  });
  if (label === undefined) return null;
  var container = label.parentElement.parentElement;
  return {
    hasToggle: container.querySelector('input[type=checkbox]') !== null,
    hasSoundSelect: container.querySelector('select') !== null,
    soundOptions: Array.from(container.querySelectorAll('select option')).map(function (option) { return option.value; }),
    hasVolume: container.querySelector('input[type=range]') !== null,
    hasPreview: Array.from(container.querySelectorAll('button')).some(function (button) {
      return (button.textContent || '').trim() === '试听';
    })
  };
})()`);
if (row === null) fail("「对话结束提示音」row is not rendered on the General settings page");
if (!row.hasToggle) fail("row has no on/off checkbox");
if (!row.hasSoundSelect) fail("row has no sound picker");
if (row.soundOptions.join(",") !== "droplet,waterdrop,waterdrop2,plop,ding,chime,blip") fail(`unexpected sound options ${row.soundOptions.join(",")}`);
if (!row.hasVolume) fail("row has no volume slider");
if (!row.hasPreview) fail("row has no preview button");
ok(`settings row rendered: toggle + sounds(${row.soundOptions.join("/")}) + volume + preview`);

/* ---------- 8. 交互真的写进 localStorage ---------- */
const toggled = await evaluate(`(async function () {
  var label = Array.from(document.querySelectorAll('*')).find(function (node) {
    return node.childElementCount === 0 && (node.textContent || '').trim() === '对话结束提示音';
  });
  var container = label.parentElement.parentElement;
  var box = container.querySelector('input[type=checkbox]');
  box.click();
  await new Promise(function (resolve) { setTimeout(resolve, 250); });
  var stored = window.localStorage.getItem('dsh-ding:settings');
  var enabledAfterOff = window.__DSH_DING__.settings().enabled;
  box.click();
  await new Promise(function (resolve) { setTimeout(resolve, 250); });
  return { stored: stored, enabledAfterOff: enabledAfterOff, enabledBack: window.__DSH_DING__.settings().enabled };
})()`);
if (toggled.enabledAfterOff !== false) fail("toggling the checkbox did not disable the plugin");
if (toggled.enabledBack !== true) fail("toggling back did not re-enable the plugin");
if (toggled.stored === null || !toggled.stored.includes('"enabled":false')) {
  fail(`toggle did not persist to localStorage: ${toggled.stored}`);
}
ok(`toggle persists: ${toggled.stored}`);

/* ---------- 9. 出声路径在真实页面里不炸 ---------- */
const rang = await evaluate(`(function () {
  try {
    window.__DSH_DING__.ring();
    return window.__DSH_DING__.rings;
  } catch (error) {
    return 'threw: ' + String(error);
  }
})()`);
if (typeof rang !== "number") fail(`diagnostic ring failed: ${rang}`);
ok(`ring path executed in a real page, counter = ${rang}`);

/* ---------- 10. 没有来自本插件的报错 ---------- */
const ownErrors = pageErrors.filter((text) => text.includes("dsh-ding"));
if (ownErrors.length > 0) fail(`console errors from dsh-ding:\n${ownErrors.join("\n")}`);
ok(`no dsh-ding console errors (page-wide errors: ${pageErrors.length})`);

socket.close();
console.log("OK  real browser: materialized, settings row live, toggle persists, ring path clean");
cleanup();
