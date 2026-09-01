/**
 * 清空业务测试数据，保留 admin 账号与 app_settings（品牌配置）。
 * 用法：npx tsx apps/web/scripts/reset-test-data.mts
 */
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

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

async function adminGql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const url = process.env.HASURA_GRAPHQL_URL;
  const secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  if (!url || !secret) throw new Error("Hasura 配置缺失（HASURA_GRAPHQL_URL / HASURA_GRAPHQL_ADMIN_SECRET）");

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": secret },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  if (!json.data) throw new Error("GraphQL 无数据");
  return json.data;
}

type DeleteResult = { affected_rows: number };

async function wipe(table: string): Promise<number> {
  const data = await adminGql<Record<string, DeleteResult>>(
    `mutation { delete_${table}(where: {}) { affected_rows } }`,
  );
  const rows = data[`delete_${table}`]?.affected_rows ?? 0;
  console.log(`  ${table}: ${rows}`);
  return rows;
}

const ADMIN_PASSWORD = "admin123";

async function main() {
  loadEnv();
  console.log("开始清空业务数据…\n");

  const steps = [
    "vision_jobs",
    "inspection_records",
    "case_expense_claims",
    "assessment_events",
    "case_perf_shares",
    "case_performances",
    "po_items",
    "po_orders",
    "case_work_units",
    "case_assignments",
    "inspection_tasks",
    "service_cases",
    "import_batches",
    "monthly_settlements",
    "assessments",
    "assessment_score_rules",
    "site_members",
    "devices",
    "sites",
    "inspection_templates",
    "ai_hard_rules",
    "price_library",
    "item_price_mappings",
    "change_logs",
  ];

  for (const table of steps) {
    await wipe(table);
  }

  const users = await adminGql<{ delete_users: DeleteResult }>(
    `mutation { delete_users(where: { username: { _neq: "admin" } }) { affected_rows } }`,
  );
  console.log(`  users (non-admin): ${users.delete_users.affected_rows}`);

  const adminHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  await adminGql(
    `mutation ($hash: String!) {
      update_users(
        where: { username: { _eq: "admin" } }
        _set: { password: $hash, status: "active", role: "super_admin" }
      ) { affected_rows }
    }`,
    { hash: adminHash },
  );
  console.log(`  admin: 已重置为 admin / ${ADMIN_PASSWORD}`);

  console.log("\n正在恢复内置服务类型与 AI 硬规则…");
  const { restoreBuiltinCatalog } = await import("../src/server/catalog-seed.ts");
  const restored = await restoreBuiltinCatalog();
  console.log(`  硬规则: ${restored.hardRules.inserted} 条`);
  console.log(`  服务类型: ${restored.demandTypes} 个（巡检含 ${restored.productLines} 条产品线）`);

  console.log("\n完成。");
}

main().catch((err) => {
  console.error("清空失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
