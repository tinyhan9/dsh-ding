/**
 * 读/写 dsh-whale-widget 的用量设置（`/dsh-whale/usage-settings.json`）。
 *
 * 用途：确认「任务结束音」这个由另一个插件产生的第二声是否开着。
 * 走它自己的 HTTP 接口，而不是直接改 .dshw-usage.json —— 宿主进程内有缓存，
 * 手改文件会被它下一次写盘覆盖。
 *
 * 跑法：
 *   node scripts/whale-usage-settings.mjs <baseUrl> <secretBase64Url> [--set-task-end off]
 */
import { createHash, createHmac } from "node:crypto";

const BASE = process.argv[2];
const SECRET = process.argv[3];
if (BASE === undefined || SECRET === undefined || SECRET === "") {
  console.error("usage: node whale-usage-settings.mjs <baseUrl> <secretBase64Url> [--set-task-end off|on]");
  process.exit(2);
}

const patchIndex = process.argv.indexOf("--set-task-end");
const desired = patchIndex === -1 ? undefined : process.argv[patchIndex + 1];

const authority = new URL(BASE).host;
const b64url = (buffer) =>
  Buffer.from(buffer).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const secret = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now();
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 3600 * 1000 }), "utf8"));
const cookie = `${cookieName}=v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

const url = `${BASE}/dsh-whale/usage-settings.json`;

const before = await fetch(url, { headers: { cookie } });
const beforeBody = await before.text();
console.log(`GET ${before.status}`);
let parsedBefore;
try {
  parsedBefore = JSON.parse(beforeBody);
} catch {
  console.log(beforeBody.slice(0, 400));
}
if (parsedBefore !== undefined) {
  console.log(`  taskEnd: ${JSON.stringify(parsedBefore.settings?.taskEnd)}`);
  console.log(`  subagent: ${JSON.stringify(parsedBefore.settings?.subagent)}`);
}

if (desired !== undefined) {
  const on = desired !== "off";
  const put = await fetch(url, {
    method: "PUT",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ taskEnd: { on } }),
  });
  const putBody = await put.text();
  console.log(`\nPUT {taskEnd:{on:${on}}} → ${put.status}`);
  console.log(`  ${putBody.slice(0, 300)}`);

  const after = await fetch(url, { headers: { cookie } });
  const parsedAfter = JSON.parse(await after.text());
  console.log(`  after: taskEnd = ${JSON.stringify(parsedAfter.settings?.taskEnd)}`);
}
