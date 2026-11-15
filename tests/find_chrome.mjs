/**
 * 找一个可用的 Chromium 内核浏览器，给两个真浏览器探针用。
 *
 * 顺序：显式参数 → CHROME_PATH 环境变量 → 各平台常见安装位置 → PATH 里的
 * chrome / msedge / chromium。只服务于开发期测试，不进运行时。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 各平台常见安装位置的候选路径。 */
function candidates() {
  const list = [];
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  const localAppData = process.env.LOCALAPPDATA;
  const suffixes = [
    ["Google", "Chrome", "Application", "chrome.exe"],
    ["Microsoft", "Edge", "Application", "msedge.exe"],
  ];
  for (const root of [programFiles, programFilesX86, localAppData]) {
    if (root === undefined || root === "") continue;
    for (const suffix of suffixes) list.push(join(root, ...suffix));
  }
  if (process.platform === "darwin") {
    list.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    list.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    list.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  }
  if (process.platform === "linux") {
    list.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
    list.push("/usr/bin/microsoft-edge");
  }
  return list;
}

/**
 * 解析出浏览器可执行文件路径。
 * @param {string|undefined} explicit - 命令行显式传入的路径。
 * @returns {string} 第一个存在的路径，找不到时抛错并列出所有尝试过的位置。
 */
export function findChrome(explicit) {
  const tried = [];
  for (const value of [explicit, process.env.CHROME_PATH]) {
    if (value === undefined || value === "") continue;
    tried.push(value);
    if (existsSync(value)) return value;
  }
  for (const value of candidates()) {
    tried.push(value);
    if (existsSync(value)) return value;
  }
  throw new Error(`no Chromium-based browser found; set CHROME_PATH. Tried:\n  ${tried.join("\n  ")}`);
}
