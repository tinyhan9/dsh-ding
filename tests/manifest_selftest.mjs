/**
 * 结构校验：把插件包里那些「DSH 会真的读」的文件逐项验一遍，
 * 免得改完代码、发完版本才发现 Loader 挂不上。
 *
 * 只依赖 Node 内置模块，跑法：
 *   node tests/manifest_selftest.mjs
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const fail = (message) => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};
const ok = (message) => console.log(`ok    ${message}`);

/* ---------- package.json ---------- */
const manifestPath = join(root, "package.json");
if (!existsSync(manifestPath)) fail("package.json is missing");
const raw = readFileSync(manifestPath, "utf8");
if (raw.charCodeAt(0) === 0xfeff) fail("package.json starts with a BOM; npm and the Loader both reject that");
let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  fail(`package.json is not valid JSON: ${error.message}`);
}
ok("package.json parses");

/* ---------- 必需字段 ---------- */
const required = ["name", "version", "type", "main", "exports", "files", "dsh"];
for (const key of required) {
  if (manifest[key] === undefined) fail(`package.json is missing "${key}"`);
}
ok(`required fields present: ${required.join(", ")}`);

/* ---------- dsh 声明 ---------- */
const dsh = manifest.dsh;
if (dsh.bundle === undefined || typeof dsh.bundle.patch !== "string") fail("dsh.bundle.patch is missing");
if (!existsSync(join(root, dsh.bundle.patch))) fail(`dsh.bundle.patch points at a missing file: ${dsh.bundle.patch}`);
ok(`dsh.bundle.patch exists: ${dsh.bundle.patch}`);

if (dsh.client === undefined) fail("dsh.client is missing");
if (dsh.client.platform !== "web") fail(`dsh.client.platform must be "web", got ${String(dsh.client.platform)}`);
if (!Array.isArray(dsh.client.inject)) fail("dsh.client.inject must be an array");
ok(`dsh.client: platform=web, inject=[${dsh.client.inject.join(", ")}]`);

/* ---------- exports ---------- */
for (const key of [".", "./client", "./package.json"]) {
  if (manifest.exports[key] === undefined) fail(`exports["${key}"] is missing`);
}
const hostEntry = resolveExport(manifest.exports["."]);
const clientEntry = resolveExport(manifest.exports["./client"]);
if (!existsSync(join(root, hostEntry))) fail(`host entry is missing on disk: ${hostEntry}`);
if (!existsSync(join(root, clientEntry))) fail(`client entry is missing on disk: ${clientEntry}`);
ok(`entries exist: ${hostEntry}, ${clientEntry}`);

/**
 * 把一条 exports 目标解析成相对路径。
 * @param {unknown} entry - exports 的值，字符串或条件对象。
 * @returns {string} 相对路径。
 */
function resolveExport(entry) {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    for (const key of ["default", "import", "require"]) {
      if (typeof entry[key] === "string") return entry[key];
    }
    for (const value of Object.values(entry)) {
      if (typeof value === "string") return value;
    }
  }
  fail(`cannot resolve an exports entry: ${JSON.stringify(entry)}`);
  return "";
}

/* ---------- main 与 exports["."] 指向同一文件 ---------- */
/* 两者写法允许不同（"lib/index.js" 与 "./lib/index.js"），比的是归一化后的路径。 */
const normalize = (value) => value.replace(/^\.\//u, "");
if (normalize(manifest.main) !== normalize(hostEntry)) {
  fail(`"main" (${manifest.main}) disagrees with exports["."] (${hostEntry})`);
}
ok("main and exports['.'] point at the same file");

/* ---------- files 清单真的覆盖了入口 ---------- */
const patterns = manifest.files;
if (!Array.isArray(patterns) || patterns.length === 0) fail("files must be a non-empty array");
for (const needed of ["lib", "cordis.patch.yml", "README.md", "scripts"]) {
  if (!patterns.includes(needed)) fail(`files does not include "${needed}"`);
}
ok(`files covers the entries: ${patterns.join(", ")}`);

/* ---------- cipher: 宿主半边必须有 apply ---------- */
const hostSource = readFileSync(join(root, hostEntry), "utf8");
if (!/export\s+(function\s+apply|const\s+apply|\{[^}]*\bapply\b)/u.test(hostSource)) {
  fail(`${hostEntry} does not export apply`);
}
ok("host half exports apply");

/* ---------- client bundle 的包装格式 ---------- */
const clientSource = readFileSync(join(root, clientEntry), "utf8");
if (!clientSource.includes("window.__ModuleLoader__.load(")) {
  fail(`${clientEntry} is not wrapped in window.__ModuleLoader__.load(...)`);
}
const idMatch = clientSource.match(/id:\s*"([^"]+)"/u);
if (idMatch === null) fail(`${clientEntry} has no registration id`);
if (idMatch[1] !== manifest.name) fail(`bundle id "${idMatch[1]}" does not match the package name "${manifest.name}"`);
ok(`client bundle registers as "${idMatch[1]}"`);

if (!clientSource.includes("exports.apply")) fail(`${clientEntry} does not export apply`);
if (!clientSource.includes("exports.inject")) fail(`${clientEntry} does not export inject`);
ok("client bundle exports apply and inject");

/* ---------- 不能有 import/export 语句（那是 ESM，loader 不认） ---------- */
const badSyntax = [
  [/^\s*import\s+[\w{*]/mu, "a bare import statement"],
  [/^\s*export\s+(default|const|function|class|\{)/mu, "a bare export statement"],
];
for (const [pattern, label] of badSyntax) {
  if (pattern.test(clientSource)) fail(`${clientEntry} contains ${label}; the bundle must be plain CJS inside the wrapper`);
}
ok("client bundle has no top-level ESM syntax");

/* ---------- version 与代码里的诊断面一致 ---------- */
const declaredVersion = clientSource.match(/version:\s*"([^"]+)"/u);
if (declaredVersion === null) fail("the diagnostics face has no version string");
if (declaredVersion[1] !== manifest.version) {
  fail(`diagnostics version ${declaredVersion[1]} does not match package.json ${manifest.version}`);
}
ok(`diagnostics version matches package.json: ${manifest.version}`);

/* ---------- patch 文件形状 ---------- */
const patchSource = readFileSync(join(root, dsh.bundle.patch), "utf8");
if (!/^\s*-\s*insert:/mu.test(patchSource)) fail(`${dsh.bundle.patch} has no "insert:" entry`);
if (!patchSource.includes(manifest.name)) fail(`${dsh.bundle.patch} does not mention "${manifest.name}"`);
ok(`${dsh.bundle.patch} inserts one Loader row for ${manifest.name}`);

/* ---------- README 存在且有中英两份 ---------- */
for (const readme of ["README.md", "README.en.md", "LICENSE"]) {
  const path = join(root, readme);
  if (!existsSync(path)) fail(`${readme} is missing`);
  if (statSync(path).size < 200) fail(`${readme} looks truncated (${statSync(path).size} bytes)`);
}
ok("README.md, README.en.md and LICENSE are present");

/* ---------- 发布产物里不能有本机绝对路径 ---------- */
const shipped = [hostEntry, clientEntry, dsh.bundle.patch, "README.md", "README.en.md"];
for (const file of shipped) {
  const text = readFileSync(join(root, file), "utf8");
  const hit = text.match(/[A-Za-z]:\\[^\s"')]+/u);
  if (hit !== null) fail(`${file} contains an absolute Windows path: ${hit[0].slice(0, 60)}`);
}
ok("no absolute Windows paths in shipped files");

console.log("\nOK  manifest: package shape, entries, bundle wrapper, version and patch all agree");
