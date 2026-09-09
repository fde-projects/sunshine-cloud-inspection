/** 给浏览器走查留 3 条 E2EUI 案例，不清现网 */
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BASE = process.env.E2E_BASE || "http://localhost:3000";
for (const raw of readFileSync(resolve(ROOT, ".env"), "utf8").split(/\r?\n/)) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const i = line.indexOf("=");
  if (i > 0) process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}

async function login(username: string, password: string, portal?: string) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, portal }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message);
  return { token: json.token, user: json.user };
}
async function bff(s: { token: string }, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}/api/bff/${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `${res.status}`);
  return json.data !== undefined ? json.data : json;
}
async function gql(s: { token: string; user: { role: string } }, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(process.env.HASURA_GRAPHQL_URL!, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.token}`,
      "x-hasura-role": s.user.role,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e: { message: string }) => e.message).join("; "));
  return json.data;
}

const admin = await login("admin", "admin123", "pc");
const mgr = await login("e2emgr", "Test@2026", "pc");
const tpls = await bff(admin, "GET", "templates");
const templates = Array.isArray(tpls) ? tpls : tpls.list || [];
const tpl = templates.find((t: { name: string }) => /故障|恢复/.test(t.name)) || templates[0];
const line = (tpl.productLines || []).map((p: { name?: string }) => String(p.name || "").trim()).find(Boolean) || "";
const siteA = (await gql(admin, `{ sites(where: { code: { _eq: "E2E-A" } }) { id } }`)).sites[0];
const acc = await bff(admin, "GET", "staffing/accounts?keyword=e2eeng1&limit=20");
const people = acc.list || acc.accounts || [];
const eng1 = people.find((x: { username: string }) => x.username === "e2eeng1");
if (!siteA?.id || !eng1?.id) throw new Error("缺少 E2E 网格或工程师，先跑 e2e-case-lifecycle");

const nos = ["E2EUI-PEND", "E2EUI-ASN", "E2EUI-RST"];
const exist = await gql(admin, `query ($nos: [String!]!) { service_cases(where: { gsp_case_no: { _in: $nos } }) { id gsp_case_no status } }`, { nos });
for (const c of exist.service_cases || []) {
  try {
    if (!["pending_assign", "assigned"].includes(c.status)) {
      await bff(admin, "POST", `cases/${c.id}/reset`, { confirm: c.gsp_case_no });
    }
    await bff(admin, "DELETE", `cases/${c.id}?confirm=${encodeURIComponent(c.gsp_case_no)}`);
  } catch (e) {
    console.log("cleanup", c.gsp_case_no, e);
  }
}

const wb = new ExcelJS.Workbook();
const sheet = wb.addWorksheet("GSP案例");
sheet.addRow(["服务案例号", "项目名称", "服务类型", "产品线", "创建人", "省份", "城市", "失效现象描述"]);
sheet.addRow(["E2EUI-PEND", "E2E待分配可删", tpl.name, line, "E2E", "安徽", "合肥", "UI待分配"]);
sheet.addRow(["E2EUI-ASN", "E2E已派单可编", tpl.name, line, "E2E", "安徽", "合肥", "UI已派单"]);
sheet.addRow(["E2EUI-RST", "E2E待派单可重置", tpl.name, line, "E2E", "安徽", "合肥", "UI待派单"]);
const buf = Buffer.from(await wb.xlsx.writeBuffer());
const form = new FormData();
form.append("file", new File([buf], "e2e-ui.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
const up = await fetch(`${BASE}/api/bff/import/gsp-cases`, { method: "POST", headers: { authorization: `Bearer ${admin.token}` }, body: form });
const imported = await up.json();
if (!up.ok) throw new Error(imported.message || "import fail");

const listed = await bff(admin, "GET", "cases?keyword=E2EUI&limit=20");
const byNo = new Map((listed.list || []).map((c: { gspCaseNo: string }) => [c.gspCaseNo, c]));
const asn = byNo.get("E2EUI-ASN") as { id: string };
const rst = byNo.get("E2EUI-RST") as { id: string };
await bff(admin, "POST", "cases/assign-sites", { caseIds: [asn.id, rst.id], siteId: siteA.id });
await bff(admin, "PUT", `cases/${asn.id}/task-type`, { templateId: tpl.id, productLine: line || undefined });
await bff(admin, "PUT", `cases/${rst.id}/task-type`, { templateId: tpl.id, productLine: line || undefined });
await bff(mgr, "POST", `cases/${asn.id}/assign`, { inspectorIds: [eng1.id], plannedUnits: 1, assignMode: "single" });
console.log(JSON.stringify({ imported: imported.data || imported, siteA: siteA.id, asn: asn.id, rst: rst.id }, null, 2));
