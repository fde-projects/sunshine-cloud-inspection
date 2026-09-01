/** 重置 admin 密码为 admin123（bcrypt 正确哈希） */
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

async function main() {
  loadEnv();
  const url = process.env.HASURA_GRAPHQL_URL;
  const secret = process.env.HASURA_GRAPHQL_ADMIN_SECRET;
  if (!url || !secret) throw new Error("Hasura 配置缺失");

  const hash = await bcrypt.hash("admin123", 10);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": secret },
    body: JSON.stringify({
      query: `mutation ($hash: String!) {
        update_users(where: { username: { _eq: "admin" } }, _set: { password: $hash, status: "active", role: "super_admin" }) {
          affected_rows
        }
      }`,
      variables: { hash },
    }),
  });
  const json = (await res.json()) as { data?: { update_users: { affected_rows: number } }; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  const rows = json.data?.update_users.affected_rows ?? 0;
  if (!rows) throw new Error("未找到 admin 账号");
  console.log("admin 密码已重置为 admin123");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
