/**
 * 发布 dsh-ding 的 GitHub Release：上传 tarball 资产 + 正文。
 *
 * 用 GitHub REST API，不依赖 gh CLI 是否登录。令牌从环境变量 GITHUB_TOKEN 取。
 *
 * 跑法：
 *   GITHUB_TOKEN=<token> node scripts/publish-release.mjs [--notes <file>] [--assets <file...>]
 */
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const OWNER = "tinyhan9";
const REPO = "dsh-ding";
const TAG = "v0.6.0";
const NAME = "dsh-ding 0.6.0";

const TOKEN = process.env.GITHUB_TOKEN;
if (TOKEN === undefined || TOKEN === "") {
  console.error("GITHUB_TOKEN is required");
  process.exit(2);
}

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { notes: ".github/release-notes-v0.6.0.md", assets: [] };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--notes") out.notes = argv[++index];
    else if (argv[index] === "--assets") {
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) out.assets.push(argv[++index]);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const headers = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "dsh-ding-release",
};

/** 调 GitHub REST API。 */
async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, { headers, ...options });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  return text === "" ? undefined : JSON.parse(text);
}

/* ---------- 1. 找或建 release ---------- */
const notes = readFileSync(resolve(args.notes), "utf8");
let release;
try {
  release = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  console.log(`release exists: ${release.html_url}`);
  release = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: NAME, body: notes, draft: false, prerelease: false }),
    headers: { ...headers, "Content-Type": "application/json" },
  });
  console.log(`release updated: ${release.html_url}`);
} catch (error) {
  if (!String(error.message).includes("404")) throw error;
  release = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: TAG,
      name: NAME,
      body: notes,
      draft: false,
      prerelease: false,
      make_latest: "true",
    }),
    headers: { ...headers, "Content-Type": "application/json" },
  });
  console.log(`release created: ${release.html_url}`);
}

/* ---------- 2. 上传资产（已存在的跳过） ---------- */
const uploadBase = release.upload_url.replace(/\{.*$/u, "");
for (const asset of args.assets) {
  const path = resolve(asset);
  const name = basename(path);
  const existing = (release.assets ?? []).find((candidate) => candidate.name === name);
  if (existing !== undefined) {
    console.log(`asset exists, replacing: ${name}`);
    await api(`/repos/${OWNER}/${REPO}/releases/assets/${existing.id}`, { method: "DELETE" });
  }
  const bytes = readFileSync(path);
  const response = await fetch(`${uploadBase}?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`upload ${name} → ${response.status}: ${text.slice(0, 300)}`);
  }
  const uploaded = await response.json();
  console.log(`uploaded ${name} (${statSync(path).size} bytes) → ${uploaded.browser_download_url}`);
}

console.log(`\nOK  ${release.html_url}`);
