/**
 * 恢复内置服务类型与 AI 硬规则（来自 catalog-seed / hard-rule-defaults）。
 * 用法：npx tsx apps/web/scripts/restore-catalog.mts
 */
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const text = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

async function main() {
  loadEnv();
  const { restoreBuiltinCatalog } = await import("../src/server/catalog-seed.ts");
  console.log("正在恢复服务类型与 AI 硬规则…\n");
  const result = await restoreBuiltinCatalog();
  console.log("硬规则：", result.hardRules);
  console.log("服务类型：", result.demandTypes, "个（巡检含", result.productLines, "条产品线）");
  console.log("\n完成。请刷新「服务类型」「AI 硬规则」页面查看。");
}

main().catch((err) => {
  console.error("恢复失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
