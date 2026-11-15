/**
 * 本机 Host 验收探针：用 .credentials.yaml 里的 browser-session 密钥自行签一枚
 * DSH 浏览器 cookie，向运行中的 Host 求证——
 *   ① 首页 200；
 *   ② boot 图里出现 dsh-ding 这一行（插件真的被组合进来）；
 *   ③ 按 boot 图给的 combo URL 能取到本包的 client bundle，内容自证身份。
 *
 * 只读、只打本机回环、不进发布产物。跑法：
 *   node tests/host_probe.mjs http://127.0.0.1:31319 <secretBase64Url>
 */
import { createHash, createHmac } from "node:crypto";

const BASE = process.argv[2] ?? "http://127.0.0.1:31319";
const SECRET = process.argv[3];
if (SECRET === undefined || SECRET === "") {
  console.error("usage: node host_probe.mjs <baseUrl> <secretBase64Url>");
  process.exit(2);
}

const authority = new URL(BASE).host;
const b64url = (buffer) =>
  Buffer.from(buffer)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");

const secret = Buffer.from(SECRET.replaceAll("-", "+").replaceAll("_", "/"), "base64");
const cookieName = "dsh-auth-" + b64url(createHash("sha256").update(authority).digest());
const now = Date.now();
const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 6 * 3600 * 1000 };
const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
const cookie = `${cookieName}=v1.${body}.${b64url(createHmac("sha256", secret).update(body).digest())}`;

const fail = (message) => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};
const ok = (message) => console.log(`ok    ${message}`);

const index = await fetch(`${BASE}/`, { headers: { cookie } });
if (index.status !== 200) fail(`index status ${index.status}`);
ok("index 200");

const html = await index.text();
const rowMatch = html.match(/\{"id":"dsh-ding"[^}]*\}/);
if (rowMatch === null) fail("boot graph has no dsh-ding row");
const row = JSON.parse(rowMatch[0]);
ok(`boot graph row: ${rowMatch[0]}`);
if (!Array.isArray(row.inject) || row.inject.length !== 0) fail("unexpected inject list on the bundle row");

const bundleUrl = `${BASE}/${row.url}`;
const bundle = await fetch(bundleUrl, { headers: { cookie } });
if (bundle.status !== 200) fail(`bundle status ${bundle.status} at ${row.url}`);
const text = await bundle.text();
ok(`bundle served over ${row.url} (${text.length} bytes)`);

const proof = [
  ['registration id', 'id: "dsh-ding"'],
  ["apply export", "exports.apply = apply"],
  ["inject export", "exports.inject = inject"],
  ["settings slot", "settings.general.item"],
  ["session status watcher", "sessionStatus"],
  ["turn-end ring", "ring(settings)"],
];
for (const [label, needle] of proof) {
  if (!text.includes(needle)) fail(`served bundle lacks ${label}`);
}
ok(`bundle self-identifies: ${proof.map(([label]) => label).join(", ")}`);
