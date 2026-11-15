/**
 * 一次性维护脚本：改仓库的 About 描述与 README 首页语言。
 *
 * PowerShell 传中文 body 会被主机转成本地代码页（中文全变 `?`），
 * 所以这类写操作统一用这里的 Node 脚本，fetch 天然按 UTF-8 编码。
 *
 * 跑法：
 *   GITHUB_TOKEN=... node scripts/update-repo.mjs --description "中文描述"
 */
import { readFileSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN;
if (TOKEN === undefined || TOKEN === "") {
  console.error("GITHUB_TOKEN is required");
  process.exit(2);
}

const OWNER = "tinyhan9";
const REPO = "dsh-ding";
const headers = {
  Authorization: `token ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json; charset=utf-8",
  "User-Agent": "dsh-ding-maintenance",
};

/**
 * 解析命令行参数。
 * @param {string[]} argv - `process.argv.slice(2)`。
 * @returns {{description: string|undefined, topics: string[]|undefined}} 参数。
 */
function parseArgs(argv) {
  const out = { description: undefined, topics: undefined };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--description") out.description = argv[++index];
    else if (argv[index] === "--topics") {
      const list = [];
      while (index + 1 < argv.length && !argv[index + 1].startsWith("--")) list.push(argv[++index]);
      out.topics = list;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.description !== undefined) {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, {
    method: "PATCH",
    headers,
    /* JSON.stringify 保留中文，Body 以 UTF-8 字节发送。 */
    body: JSON.stringify({ description: args.description }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`PATCH description → ${response.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  const updated = JSON.parse(text);
  console.log(`description set (${updated.description.length} chars):`);
  console.log(updated.description);
}

if (args.topics !== undefined && args.topics.length > 0) {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/topics`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ names: args.topics }),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(`PUT topics → ${response.status}: ${text.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`topics: ${JSON.parse(text).names.join(", ")}`);
}

/* 回读确认落库的字节没问题（不是 `?`）。 */
const check = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}`, { headers });
const repo = await check.json();
if (repo.description !== null && repo.description.includes("?")) {
  console.error("description contains '?' — encoding was mangled");
  process.exit(1);
}
console.log("read-back ok: no mojibake");
readFileSync;
