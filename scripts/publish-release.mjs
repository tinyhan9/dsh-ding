/**
 * 发布 dsh-ding 的 GitHub Release：上传 tarball 资产 + 正文（中英双语）。
 *
 * 走 GitHub REST API，不依赖 gh CLI 是否登录。令牌从环境变量 GITHUB_TOKEN 取，
 * 从不写进文件。
 *
 * 跑法：
 *   GITHUB_TOKEN=... node scripts/publish-release.mjs --tag v0.6.0 --notes docs/release-notes.md --assets dist/*.tgz
 *
 * 省略 --tag 时按 package.json 的 version 推成 v<version>；
 * 省略 --notes 时用 docs/release-notes.md。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "tinyhan9";
const REPO = "dsh-ding";

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/**
 * 解析命令行参数。
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{tag: string, notes: string, assets: string[]}} 解析结果。
 */
function parseArgs(argv) {
  const out = { tag: `v${manifest.version}`, notes: "docs/release-notes.md", assets: [] };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "--tag") out.tag = argv[++index];
    else if (flag === "--notes") out.notes = argv[++index];
    else if (flag === "--assets") {
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) out.assets.push(argv[++index]);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.tag !== `v${manifest.version}`) {
  console.error(`tag ${args.tag} does not match package.json version ${manifest.version}`);
  process.exit(2);
}

const TOKEN = process.env.GITHUB_TOKEN;
if (TOKEN === undefined || TOKEN === "") {
  console.error("GITHUB_TOKEN is required");
  process.exit(2);
}

const headers = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "dsh-ding-release",
};

/**
 * 调 GitHub REST API。
 * @param {string} path - API 路径。
 * @param {object} options - fetch 选项。
 * @returns {Promise<unknown>} 解析后的响应体。
 */
async function api(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, { headers, ...options });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${options.method ?? "GET"} ${path} → ${response.status}: ${text.slice(0, 400)}`);
    error.status = response.status;
    throw error;
  }
  return text === "" ? undefined : JSON.parse(text);
}

const notesPath = join(root, args.notes);
if (!existsSync(notesPath)) {
  console.error(`release notes not found: ${args.notes}`);
  process.exit(2);
}
const title = `${manifest.name} ${manifest.version}`;

/* ---------- 先把资产清单和摘要算出来 ---------- */
/* 说明正文里用 <!--ASSETS--> 占位，这里替换成真实的文件名、大小与 SHA-256，
   免得每次改包都要手抄摘要、抄错了还没人发现。 */
const assetPaths = args.assets.map((asset) => resolve(process.cwd(), asset));
for (const path of assetPaths) {
  if (!existsSync(path)) {
    console.error(`asset not found: ${path}`);
    process.exit(2);
  }
}

/**
 * 算一个文件的 SHA-256。
 * @param {string} path - 文件路径。
 * @returns {Promise<string>} 小写十六进制摘要。
 */
async function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

/**
 * 数一个 tarball 里有多少个文件。
 * @param {string} path - tarball 路径。
 * @returns {number} 条目数（含目录）。
 */
function countEntries(path) {
  const listing = execFileSync("tar", ["-tzf", path], { encoding: "utf8" });
  return listing.split("\n").filter((line) => line.trim() !== "").length;
}

const assetLines = [];
for (const path of assetPaths) {
  const name = basename(path);
  const size = statSync(path).size;
  const digest = await sha256(path);
  const entries = name.endsWith(".tgz") ? countEntries(path) : undefined;
  assetLines.push({
    name,
    size,
    digest,
    entries,
    line: `\`${name}\` — ${size} bytes${entries === undefined ? "" : `, ${entries} files`}, SHA-256 \`${digest}\``,
    lineZh: `\`${name}\` —— ${size} 字节${entries === undefined ? "" : `，${entries} 个文件`}，SHA-256 \`${digest}\``,
  });
}

/* 中文段与英文段各替换一次，顺序与正文里的两个占位一致。 */
let notes = readFileSync(notesPath, "utf8");
const markers = notes.split("<!--ASSETS-->");
if (markers.length === 3) {
  const zh = assetLines.map((entry) => `- ${entry.lineZh}`).join("\n");
  const en = assetLines.map((entry) => `- ${entry.line}`).join("\n");
  notes = `${markers[0]}${zh}${markers[1]}${en}${markers[2]}`;
  console.log(`filled <!--ASSETS--> in both language sections (${assetLines.length} asset(s))`);
} else if (markers.length > 1) {
  /* 只有一段时，按该段自己的语言填一次。 */
  const zh = notes.indexOf("中文说明") !== -1 && notes.indexOf("中文说明") < notes.indexOf("<!--ASSETS-->");
  const lines = assetLines.map((entry) => `- ${zh ? entry.lineZh : entry.line}`).join("\n");
  notes = markers.join(lines);
  console.log(`filled ${markers.length - 1} <!--ASSETS--> marker(s)`);
} else {
  console.warn("no <!--ASSETS--> marker in the notes; the body will ship as written");
}

/* ---------- 1. 找或建 release ---------- */
let release;
try {
  release = await api(`/repos/${OWNER}/${REPO}/releases/tags/${args.tag}`);
  console.log(`release exists: ${release.html_url}`);
} catch (error) {
  if (error.status !== 404) throw error;
  release = undefined;
}

if (release === undefined) {
  /* 先把 tag 建到当前提交上：GitHub 会用已有 tag，没有就按 target_commitish 新建。 */
  const head = process.env.GITHUB_SHA ?? undefined;
  release = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: "POST",
    body: JSON.stringify({
      tag_name: args.tag,
      name: title,
      body: notes,
      draft: true,
      prerelease: false,
      ...head === undefined ? {} : { target_commitish: head },
    }),
    headers: { ...headers, "Content-Type": "application/json" },
  });
  console.log(`release created (draft): ${release.html_url}`);
} else {
  release = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}`, {
    method: "PATCH",
    body: JSON.stringify({ name: title, body: notes }),
    headers: { ...headers, "Content-Type": "application/json" },
  });
  console.log(`release notes updated: ${release.html_url}`);
}

/* ---------- 2. 上传资产（同名的删了重传） ---------- */
const uploadBase = release.upload_url.replace(/\{.*$/u, "");
for (const asset of args.assets) {
  const path = resolve(process.cwd(), asset);
  const name = basename(path);
  /* 重新读一次，拿到最新的资产列表（上面的 PATCH 不会带回新资产）。 */
  const current = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}`);
  const existing = (current.assets ?? []).find((candidate) => candidate.name === name);
  if (existing !== undefined) {
    console.log(`replacing existing asset: ${name}`);
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

/* ---------- 3. 最后才把草稿转正式 ---------- */
/* 顺序很重要：中途失败时 release 停在 draft，不会被当成已发布版本。 */
release = await api(`/repos/${OWNER}/${REPO}/releases/${release.id}`, {
  method: "PATCH",
  body: JSON.stringify({ draft: false, prerelease: false, make_latest: "true" }),
  headers: { ...headers, "Content-Type": "application/json" },
});
console.log(`\nreleased: ${release.html_url}`);
console.log(`assets: ${(release.assets ?? []).map((asset) => `${asset.name} (${asset.size} bytes)`).join(", ")}`);
