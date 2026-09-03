/**
 * 从种子超管开始：清空旧业务/测试数据，再跑全流程 E2E
 * 用法：cd apps/web && node node_modules/tsx/dist/cli.mjs scripts/e2e-seed-reset-and-run.mts
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const ASSETS = resolve(ROOT, "测试素材");
const BASE = process.env.E2E_BASE || "http://localhost:3000";
const PWD = "Test@2026";
const REPORT = resolve(ROOT, "e2e-seed测试报告.md");

function loadEnv() {
  const text = readFileSync(resolve(ROOT, ".env"), "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}
loadEnv();
// 开发环境允许清空财务测试数据
process.env.ALLOW_FINANCE_DATA_CLEAR = process.env.ALLOW_FINANCE_DATA_CLEAR || "true";
const GQL_URL = process.env.HASURA_GRAPHQL_URL!;

type R = { phase: string; name: string; ok: boolean; detail: string };
const results: R[] = [];
let curPhase = "";
function phase(name: string) {
  curPhase = name;
  console.log(`\n========== ${name} ==========`);
}
async function step(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = (await fn()) || "OK";
    results.push({ phase: curPhase, name, ok: true, detail: String(detail) });
    console.log(`  ✓ ${name} — ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ phase: curPhase, name, ok: false, detail });
    console.log(`  ✗ ${name} — ${detail}`);
  }
}
async function critical<T>(name: string, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    results.push({ phase: curPhase, name, ok: true, detail: "OK" });
    console.log(`  ✓ ${name}`);
    return out;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ phase: curPhase, name, ok: false, detail: `【阻断】${detail}` });
    console.log(`  ✗ ${name} — 【阻断】${detail}`);
    throw e;
  }
}

type Session = { token: string; user: { id: string; username: string; role: string; real_name?: string } };

async function login(username: string, password: string, portal?: string): Promise<Session> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password, portal }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`登录失败(${res.status}): ${json.message || JSON.stringify(json)}`);
  return { token: json.token, user: json.user };
}

async function bff(s: Session | null, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}/api/bff/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(s ? { authorization: `Bearer ${s.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get("content-type") || "";
  const json = ct.includes("json") ? await res.json() : { message: await res.text() };
  if (!res.ok) {
    const err = new Error(json.message || `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return json.data !== undefined ? json.data : json;
}

async function bffUpload(s: Session, path: string, filePath: string): Promise<any> {
  const buf = readFileSync(filePath);
  const name = filePath.split(/[\\/]/).pop()!;
  const form = new FormData();
  const type = name.endsWith(".png")
    ? "image/png"
    : name.endsWith(".xlsx")
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "image/jpeg";
  form.append("file", new File([buf], name, { type }));
  const res = await fetch(`${BASE}/api/bff/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data !== undefined ? json.data : json;
}

async function bffDelete(s: Session, path: string): Promise<any> {
  const res = await fetch(`${BASE}/api/bff/${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${s.token}` },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data !== undefined ? json.data : json;
}

async function gql(s: Session, query: string, variables?: Record<string, unknown>): Promise<any> {
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.token}`,
      "x-hasura-role": s.user.role,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json.data;
}

function asset(...parts: string[]) {
  const p = join(ASSETS, ...parts);
  if (!existsSync(p)) throw new Error(`素材不存在: ${p}`);
  return p;
}

function writeReport(extra?: string) {
  const fails = results.filter((r) => !r.ok);
  const lines = [
    `# E2E 种子重置全流程测试报告`,
    ``,
    `- 时间: ${new Date().toISOString()}`,
    `- 目标: ${BASE}`,
    `- 总步数: ${results.length}，成功 ${results.length - fails.length}，失败 ${fails.length}`,
    extra ? `- 备注: ${extra}` : "",
    ``,
    `| 阶段 | 步骤 | 结果 | 说明 |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.phase} | ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "/").slice(0, 140)} |`),
  ].filter(Boolean);
  writeFileSync(REPORT, lines.join("\n"), "utf8");
  console.log(`\n报告已写入 ${REPORT}`);
}

async function main() {
  console.log(`目标: ${BASE}`);
  if (!existsSync(ASSETS)) throw new Error("测试素材目录不存在: " + ASSETS);

  phase("阶段0 种子管理员登录");
  const admin = await critical("admin 登录", () => login("admin", "admin123", "pc"));
  console.log(`    admin id=${admin.user.id} role=${admin.user.role}`);

  phase("阶段0.5 清空旧测试数据");
  await step("清空案例/关联 PO/任务", async () => {
    const r = await bffDelete(admin, `cases/clear?confirm=${encodeURIComponent("清空")}`);
    return JSON.stringify(r);
  });
  await step("清空残留 PO", async () => {
    try {
      const r = await bffDelete(admin, `po-orders/clear?confirm=${encodeURIComponent("清空")}`);
      return JSON.stringify(r);
    } catch (e: any) {
      return `跳过: ${e.message?.slice(0, 80)}`;
    }
  });
  await step("删除非 admin 用户与网格", async () => {
    // 先拆关联
    await gql(admin, `mutation { delete_site_members(where: {}) { affected_rows } }`);
    await gql(admin, `mutation { delete_case_assignments(where: {}) { affected_rows } }`).catch(() => null);
    await gql(admin, `mutation { delete_case_work_units(where: {}) { affected_rows } }`).catch(() => null);
    await gql(admin, `mutation { delete_case_expense_claims(where: {}) { affected_rows } }`).catch(() => null);
    await gql(admin, `mutation { delete_case_performances(where: {}) { affected_rows } }`).catch(() => null);
    await gql(admin, `mutation { delete_inspection_records(where: {}) { affected_rows } }`).catch(() => null);
    await gql(admin, `mutation { delete_inspection_tasks(where: {}) { affected_rows } }`).catch(() => null);
    const sites = await gql(admin, `mutation { delete_sites(where: {}) { affected_rows } }`);
    const users = await gql(admin,
      `mutation { delete_users(where: { username: { _neq: "admin" } }) { affected_rows } }`);
    return `sites=${sites.delete_sites.affected_rows} users=${users.delete_users.affected_rows}`;
  });

  phase("阶段1 创建账号与网格");
  const hash = await bcrypt.hash(PWD, 10);
  async function createUser(username: string, realName: string, phone: string, role: string, roles: string[]) {
    const ins = await gql(admin,
      `mutation ($obj: users_insert_input!) { insert_users_one(object: $obj) { id } }`,
      {
        obj: {
          username,
          password: hash,
          real_name: realName,
          phone,
          role,
          roles,
          status: "active",
          created_by_id: admin.user.id,
        },
      });
    return ins.insert_users_one.id as string;
  }

  const managerId = await critical("创建网格长 张伟", () =>
    createUser("zhangwei", "张伟", "13800000001", "site_manager", ["site_manager"]));
  const eng1Id = await critical("创建工程师 李强", () =>
    createUser("liqiang", "李强", "13800000002", "inspector", ["inspector"]));
  const eng2Id = await critical("创建工程师 王芳", () =>
    createUser("wangfang", "王芳", "13800000003", "inspector", ["inspector"]));

  const siteIns = await critical("创建网格 合肥阳光光伏电站", async () => {
    const ins = await gql(admin,
      `mutation ($obj: sites_insert_input!) { insert_sites_one(object: $obj) { id } }`,
      {
        obj: {
          name: "合肥阳光光伏电站",
          code: "HF-001",
          province: "安徽省",
          city: "合肥市",
          district: "蜀山区",
          address: "蜀山区科学大道 88 号",
          latitude: 31.8206,
          longitude: 117.2272,
          manager_id: managerId,
          status: "active",
        },
      });
    return ins.insert_sites_one.id as string;
  });
  const siteId = siteIns;
  console.log(`    siteId=${siteId}`);

  const manager = await critical("网格长登录", () => login("zhangwei", PWD, "pc"));
  await critical("网格长招募李强、王芳", async () => {
    for (const uid of [eng1Id, eng2Id]) {
      await gql(manager,
        `mutation ($obj: site_members_insert_input!) { insert_site_members_one(object: $obj) { id } }`,
        { obj: { site_id: siteId, user_id: uid, member_role: "inspector" } });
    }
  });
  const eng1 = await critical("工程师李强登录", () => login("liqiang", PWD, "mobile"));
  const eng2 = await critical("工程师王芳登录", () => login("wangfang", PWD, "mobile"));

  phase("阶段2 导入生产素材");
  await critical("导入甲方结算价", async () => {
    const r = await bffUpload(admin, "prices/import", asset("甲方结算价_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 160)}`);
  });
  await critical("导入内部绩效价", async () => {
    const r = await bffUpload(admin, "prices/import-perf", asset("内部绩效价_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 160)}`);
  });
  await critical("导入 GSP 案例", async () => {
    const r = await bffUpload(admin, "import/gsp-cases", asset("GSP案例表_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 160)}`);
  });
  await critical("导入 PO", async () => {
    const r = await bffUpload(admin, "import/po-orders", asset("PO表单_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 160)}`);
  });
  await step("PO 生成案例", async () => JSON.stringify(await bff(admin, "POST", "po-orders/generate-cases", {})).slice(0, 160));
  await step("价格映射重算", async () => JSON.stringify(await bff(admin, "POST", "prices/mappings/recalculate", {})).slice(0, 160));

  phase("阶段3 分配与派单");
  const caseList = await critical("查询案例", async () => {
    const r = await bff(admin, "GET", "cases?limit=50");
    const list = r.list || [];
    if (list.length < 2) throw new Error(`案例不足: ${list.length}`);
    return list;
  });
  const templates = await critical("查询服务类型", async () => {
    const r = await bff(admin, "GET", "templates");
    const list = Array.isArray(r) ? r : r.list || [];
    if (!list.length) throw new Error("无模板");
    return list;
  });
  const tplFault = templates.find((t: any) => /故障|恢复/.test(t.name)) || templates[0];
  const tplMaint = templates.find((t: any) => /维护/.test(t.name)) || templates[0];

  // 挑未分配的前两个；优先故障/维护类型
  const free = caseList.filter((c: any) => !c.siteId && !c.inspectorId);
  const caseA = free.find((c: any) => /故障|恢复|RW/.test(`${c.serviceType}${c.gspCaseNo}`)) || free[0] || caseList[0];
  const caseB = free.find((c: any) => c.id !== caseA.id) || caseList[1];
  console.log(`    A=${caseA.gspCaseNo} B=${caseB.gspCaseNo}`);

  await critical("分配到网格", () =>
    bff(admin, "POST", "cases/assign-sites", { caseIds: [caseA.id, caseB.id], siteId }));
  await critical("设置服务类型", async () => {
    await bff(admin, "PUT", `cases/${caseA.id}/task-type`, { templateId: tplFault.id });
    await bff(admin, "PUT", `cases/${caseB.id}/task-type`, { templateId: tplMaint.id });
  });
  await critical("单人派单 A→李强", () =>
    bff(manager, "POST", `cases/${caseA.id}/assign`, {
      inspectorIds: [eng1Id],
      plannedUnits: 1,
      assignMode: "single",
    }));
  await critical("多人派单 B→李强+王芳", () =>
    bff(manager, "POST", `cases/${caseB.id}/assign`, {
      inspectorIds: [eng1Id, eng2Id],
      plannedUnits: 2,
      assignMode: "multi",
    }));

  phase("阶段4 李强作业（案例A 自动认领）");
  await critical("开始案例A", () => bff(eng1, "POST", `cases/${caseA.id}/start`));
  const detailA = await critical("案例A详情", () => bff(eng1, "GET", `cases/my/${caseA.id}`));
  const unitsA = detailA.units || detailA.workUnits || [];
  const unitA = unitsA[0];
  if (!unitA) throw new Error("无工作单元");
  let taskId = unitA.inspectionTaskId || unitA.inspection_task_id || "";
  await critical("确认自动认领任务", async () => {
    if (unitA.status === "open") {
      const r = await bff(eng1, "POST", `cases/${caseA.id}/units/${unitA.id}/claim`);
      taskId = r.inspectionTaskId;
    }
    if (!taskId) {
      const tasks = detailA.tasks || detailA.inspectionTasks || [];
      taskId = tasks[0]?.id || "";
    }
    if (!taskId) throw new Error("无 inspectionTaskId");
    console.log(`    unit=${unitA.status} task=${taskId}`);
  });

  let workPhotoUrl = "";
  await critical("上传工作照片", async () => {
    const photo = asset("故障恢复-地面组串式", "合格案例", "上传故障记录", "合格-上传故障记录-01.jpg");
    const r = await bffUpload(eng1, `cases/${caseA.id}/work-photo`, photo);
    workPhotoUrl = r.url || r.publicUrl || "";
    if (!workPhotoUrl) throw new Error(JSON.stringify(r).slice(0, 120));
  });
  await step("天翼云直传", async () => {
    const tok = await bff(eng1, "GET", "upload/token?filename=seed-e2e.jpg&contentType=image/jpeg");
    const buf = readFileSync(asset("序列号1.jpg"));
    const put = await fetch(tok.uploadUrl, {
      method: "PUT",
      headers: { ...(tok.headers || {}), "Content-Type": tok.contentType || "image/jpeg" },
      body: buf,
    });
    if (!put.ok) throw new Error(`直传 ${put.status}: ${(await put.text()).slice(0, 100)}`);
    return tok.publicUrl || tok.key;
  });
  await step("序列号 OCR", async () => {
    const up = await bffUpload(eng1, `cases/${caseA.id}/work-photo`, asset("序列号1.jpg"));
    const r = await bff(eng1, "POST", `cases/${caseA.id}/units/${unitA.id}/serial/ocr`, {
      imageUrl: up.url || up.publicUrl,
    });
    return `serial=${r.serial || "(空)"} conf=${r.confidence ?? "-"}`;
  });
  await critical("保存序列号", () =>
    bff(eng1, "POST", `cases/${caseA.id}/units/${unitA.id}/serial`, { deviceSerial: "SEED-SG-2026-0001" }));

  await step("开始巡检任务", () => bff(eng1, "PUT", `tasks/${taskId}/start`).then(() => "OK"));
  await step("提交巡检记录", async () => {
    const recList = await bff(eng1, "GET", `records?taskId=${taskId}`);
    const list = recList?.list || recList?.records || (Array.isArray(recList) ? recList : []);
    if (!list.length) return "无记录（模板条目可能为空）";
    const rec = list[0];
    const detail = await bff(eng1, "GET", `records/${rec.id}`);
    const entries = detail.entries || [];
    const photoEntry = entries.find((e: any) => e.kind === "photo" || e.aiEnabled || e.ai_enabled);
    if (photoEntry && workPhotoUrl) {
      await bff(eng1, "POST", "ai/analyze", {
        recordId: rec.id,
        templateEntryId: photoEntry.templateEntryId || photoEntry.template_entry_id || photoEntry.id,
        photoUrl: workPhotoUrl,
      }).catch((e: any) => console.log(`    AI跳过: ${e.message?.slice(0, 80)}`));
    }
    await bff(eng1, "PUT", `records/${rec.id}/submit`, {
      locationStatus: "skipped",
      locationReason: "E2E 种子测试无 GPS",
    });
    return `entries=${entries.length}`;
  });
  await critical("完成单元A", () => bff(eng1, "POST", `cases/${caseA.id}/units/${unitA.id}/complete`));
  await critical("完成案例A", () => bff(eng1, "POST", `cases/${caseA.id}/finish`));

  phase("阶段5 案例B 多人认领");
  await step("李强认领B台1", async () => {
    await bff(eng1, "POST", `cases/${caseB.id}/start`).catch(() => null);
    const d = await bff(eng1, "GET", `cases/my/${caseB.id}`);
    const open = (d.units || d.workUnits || []).find((u: any) => u.status === "open");
    if (!open) return "无可认领";
    const r = await bff(eng1, "POST", `cases/${caseB.id}/units/${open.id}/claim`);
    return r.inspectionTaskId || "ok";
  });
  await step("王芳认领B台2", async () => {
    await bff(eng2, "POST", `cases/${caseB.id}/start`).catch(() => null);
    const d = await bff(eng2, "GET", `cases/my/${caseB.id}`);
    const open = (d.units || d.workUnits || []).find((u: any) => u.status === "open");
    if (!open) return `无可认领 ${(d.units || []).map((u: any) => u.status)}`;
    const r = await bff(eng2, "POST", `cases/${caseB.id}/units/${open.id}/claim`);
    return r.inspectionTaskId || "ok";
  });

  phase("阶段6 报销与审核");
  let startOdoUrl = "";
  let endOdoUrl = "";
  await critical("上传里程表", async () => {
    startOdoUrl = (await bffUpload(eng1, `cases/${caseA.id}/work-photo`, asset("开始里程表.png"))).url;
    endOdoUrl = (await bffUpload(eng1, `cases/${caseA.id}/work-photo`, asset("结束里程表.png"))).url;
  });
  let startMileage = 10000;
  let endMileage = 10186;
  await step("里程 OCR", async () => {
    const rs = await bff(eng1, "POST", `cases/${caseA.id}/my-expense/ocr-mileage`, { imageUrl: startOdoUrl, kind: "start" });
    const re = await bff(eng1, "POST", `cases/${caseA.id}/my-expense/ocr-mileage`, { imageUrl: endOdoUrl, kind: "end" });
    if (rs.mileage) startMileage = rs.mileage;
    if (re.mileage) endMileage = re.mileage;
    return `${rs.mileage ?? "?"} → ${re.mileage ?? "?"}`;
  });
  await critical("提交报销", async () => {
    const km = Math.max(0, endMileage - startMileage);
    await bff(eng1, "POST", `cases/${caseA.id}/my-expense`, {
      lineItems: [
        { type: "mileage", name: "自驾里程", quantity: km, unitPrice: 1.2, amount: Math.round(km * 1.2 * 100) / 100 },
        { type: "other", name: "过路费", quantity: 1, unitPrice: 50, amount: 50 },
      ],
      startOdometerUrl: startOdoUrl,
      endOdometerUrl: endOdoUrl,
      startMileage,
      endMileage,
      voucherUrls: workPhotoUrl ? [workPhotoUrl] : [],
      note: "种子 E2E 报销",
      submit: true,
    });
  });
  await critical("批准报销", async () => {
    const pending = await bff(admin, "GET", "cases/expenses/pending");
    const list = pending.list || pending || [];
    if (!Array.isArray(list) || !list.length) throw new Error("无待审报销");
    const claim = list.find((c: any) => c.inspectorName === "李强" || c.inspector_name === "李强") || list[0];
    await bff(admin, "POST", `cases/expenses/${claim.id}/approve`, { note: "种子审核通过" });
  });
  await critical("结算审核通过", async () => {
    const pend = await bff(admin, "GET", "review/pending?reviewStatus=pending");
    const list = Array.isArray(pend) ? pend : pend.list || [];
    const target = list.find((c: any) => c.id === caseA.id) || list[0];
    if (!target) throw new Error("无待审结算案例");
    await bff(admin, "GET", `review/${target.id}/amount-breakdown`).catch(() => null);
    await bff(admin, "POST", `review/${target.id}/approve`, { comment: "种子结算通过" });
    console.log(`    通过 ${target.gspCaseNo || target.id}`);
  });
  await step("我的收入", async () => {
    const r = await bff(eng1, "GET", "my/income");
    return `cases=${r.caseCount} approved=${r.approvedAmount} pending=${r.pendingAmount}`;
  });
  await step("财务总览", async () => JSON.stringify(await bff(admin, "GET", "finance/dashboard")).slice(0, 140));

  phase("阶段7 权限负向");
  await step("未登录401", async () => {
    try { await bff(null, "GET", "cases"); throw new Error("未授权放行"); }
    catch (e: any) { if (e.status === 401 || /未登录/.test(e.message)) return "OK"; throw e; }
  });
  await step("工程师禁价格重算", async () => {
    try { await bff(eng1, "POST", "prices/mappings/recalculate", {}); throw new Error("越权"); }
    catch (e: any) { if (e.status === 403 || /权限/.test(e.message)) return "OK"; throw e; }
  });

  phase("汇总");
  writeReport("从 admin 种子清空后重建 zhangwei/liqiang/wangfang");
  const fails = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 步，成功 ${results.length - fails.length}，失败 ${fails.length}`);
  console.log(`\n账号: admin/admin123 | zhangwei|liqiang|wangfang / ${PWD}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\n流程中断:", e instanceof Error ? e.message : e);
  writeReport(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
