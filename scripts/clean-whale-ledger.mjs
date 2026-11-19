/**
 * 清掉 .dshw-usage.json 里那个**没人读**的顶层 `taskEnd` 键。
 *
 * 来历：早先我为了排查，直接往账本 JSON 里加了一个顶层 `taskEnd`，
 * 但宿主真正读的是 `settings.taskEnd`（见 dsh-whale-widget/lib/index.js 的
 * `readUsageSettings()`）。那个键没有任何消费方，留着只会让下一个人误判。
 *
 * 跑法（宿主运行时也可以跑，宿主下次写盘不会删它 —— 顺手清掉）：
 *   node scripts/clean-whale-ledger.mjs
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ledgerPath = join(homedir(), ".dsh", ".dshw-usage.json");
if (!existsSync(ledgerPath)) {
  console.log(`not found: ${ledgerPath}`);
  process.exit(0);
}

const raw = readFileSync(ledgerPath, "utf8");
let ledger;
try {
  ledger = JSON.parse(raw);
} catch (error) {
  console.error(`cannot parse ${ledgerPath}: ${error.message}`);
  process.exit(1);
}

if (ledger.taskEnd === undefined) {
  console.log("nothing to clean: no stray top-level taskEnd key");
  console.log(`effective settings.taskEnd = ${JSON.stringify(ledger.settings?.taskEnd)}`);
  process.exit(0);
}

const backup = `${ledgerPath}.bak-stray-taskend`;
copyFileSync(ledgerPath, backup);
console.log(`stray top-level taskEnd = ${JSON.stringify(ledger.taskEnd)}`);
delete ledger.taskEnd;
writeFileSync(ledgerPath, JSON.stringify(ledger), "utf8");
console.log(`removed; backup at ${backup}`);
console.log(`effective settings.taskEnd = ${JSON.stringify(ledger.settings?.taskEnd)}`);
