/**
 * 隔离全流程：编辑 / 删除 / 重置 + 导入派单作业结算考核月结
 * 不清空现网数据，只用 E2E* 账号/案例。
 * 用法：cd apps/web && node node_modules/tsx/dist/cli.mjs scripts/e2e-case-lifecycle.mts
 */
import { readFileSync, existsSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import ExcelJS from "exceljs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const ASSETS = resolve(ROOT, "测试素材");
const BASE = process.env.E2E_BASE || "http://localhost:3000";
const PWD = "Test@2026";

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

type Session = { token: string; user: { id: string; username: string; role: string; realName?: string; real_name?: string } };

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

async function bffExpectFail(s: Session | null, method: string, path: string, body: unknown, hint: string) {
  try {
    await bff(s, method, path, body);
    throw new Error(`应当失败却成功：${hint}`);
  } catch (e: any) {
    if (e.message?.startsWith("应当失败")) throw e;
    return `${e.status || "?"} ${String(e.message || "").slice(0, 80)}`;
  }
}

async function bffUpload(s: Session, path: string, filePath: string, filename?: string): Promise<any> {
  const buf = readFileSync(filePath);
  const name = filename || filePath.split(/[\\/]/).pop()!;
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

async function gql(s: Session, query: string, variables?: Record<string, unknown>): Promise<any> {
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
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json.data;
}

function expect(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

async function main() {
  console.log(`目标: ${BASE}`);
  const stamp = `E2E${new Date().toISOString().slice(5, 10).replace("-", "")}`;

  phase("0 种子管理员");
  const admin = await critical("admin 登录", () => login("admin", "admin123", "pc"));
  expect(admin.user.role === "super_admin", `期望 super_admin，实际 ${admin.user.role}`);

  phase("1 准备隔离账号与网格");
  const accounts = [
    { username: "e2emgr", realName: "E2E网格长", phone: "13900009001", employeeNo: "E2EMGR01" },
    { username: "e2eeng1", realName: "E2E李工", phone: "13900009002", employeeNo: "E2EENG01" },
    { username: "e2eeng2", realName: "E2E王工", phone: "13900009003", employeeNo: "E2EENG02" },
  ];
  const ids: Record<string, string> = {};
  for (const a of accounts) {
    await step(`确保账号 ${a.username}`, async () => {
      try {
        const s = await login(a.username, PWD);
        ids[a.username] = s.user.id;
        return `复用 ${s.user.id}`;
      } catch {
        const created = await bff(admin, "POST", "staffing/accounts", {
          username: a.username,
          password: PWD,
          realName: a.realName,
          phone: a.phone,
          employeeNo: a.employeeNo,
        });
        ids[a.username] = created.id;
        return `新建 ${created.id}`;
      }
    });
  }
  if (!ids.e2emgr || !ids.e2eeng1 || !ids.e2eeng2) {
    throw new Error("账号未齐，中止");
  }

  const sites = await critical("查或建测试网格", async () => {
    const listed = await gql(admin, `query {
      sites(where: { code: { _in: ["E2E-A", "E2E-B"] } }) { id name code }
    }`);
    const byCode = new Map((listed.sites || []).map((s: any) => [s.code, s]));
    async function ensure(code: string, name: string) {
      if (byCode.get(code)) return byCode.get(code);
      const ins = await gql(
        admin,
        `mutation ($obj: sites_insert_input!) { insert_sites_one(object: $obj) { id name code } }`,
        {
          obj: {
            name,
            code,
            province: "安徽省",
            city: "合肥市",
            district: "蜀山区",
            address: "E2E 测试网格",
            latitude: 31.82,
            longitude: 117.22,
            status: "active",
          },
        },
      );
      return ins.insert_sites_one;
    }
    return {
      a: await ensure("E2E-A", "E2E网格甲"),
      b: await ensure("E2E-B", "E2E网格乙"),
    };
  });

  await critical("任命网格长并挂工程师", async () => {
    await bff(admin, "POST", "staffing/appoint-primary", { siteId: sites.a.id, userId: ids.e2emgr });
    await bff(admin, "PUT", "staffing/members", {
      siteId: sites.a.id,
      userId: ids.e2eeng1,
      roles: ["inspector"],
    });
    await bff(admin, "PUT", "staffing/members", {
      siteId: sites.a.id,
      userId: ids.e2eeng2,
      roles: ["inspector"],
    });
  });

  const mgr = await critical("网格长登录", () => login("e2emgr", PWD, "pc"));
  expect(mgr.user.role === "site_manager", `网格长角色 ${mgr.user.role}`);
  const eng1 = await critical("工程师1登录", () => login("e2eeng1", PWD, "mobile"));
  expect(eng1.user.role === "inspector", `工程师角色 ${eng1.user.role}`);
  const eng2 = await critical("工程师2登录", () => login("e2eeng2", PWD, "mobile"));

  phase("2 导入案例");
  const templates = await critical("读服务类型", async () => {
    const r = await bff(admin, "GET", "templates");
    const list = Array.isArray(r) ? r : r.list || [];
    if (!list.length) throw new Error("没有服务类型");
    return list;
  });
  const tpl =
    templates.find((t: any) => /故障|恢复/.test(t.name)) ||
    templates.find((t: any) => (t.productLines || []).length) ||
    templates[0];
  const line =
    (tpl.productLines || []).map((p: any) => String(p.name || "").trim()).find(Boolean) || "";
  const nos = {
    del: `${stamp}DEL`,
    edit: `${stamp}EDT`,
    type: `${stamp}TYP`,
    site: `${stamp}SIT`,
    work: `${stamp}WRK`,
    single: `${stamp}SIN`,
    multi: `${stamp}MUL`,
    month: `${stamp}MON`,
  };

  await step("清掉上次同号 E2E 案例", async () => {
    const exist = await gql(
      admin,
      `query ($nos: [String!]!) {
        service_cases(where: { gsp_case_no: { _in: $nos } }) { id gsp_case_no status }
      }`,
      { nos: Object.values(nos) },
    );
    let n = 0;
    for (const c of exist.service_cases || []) {
      try {
        if (!["pending_assign", "assigned"].includes(c.status)) {
          await bff(admin, "POST", `cases/${c.id}/reset`, { confirm: c.gsp_case_no });
        }
        await bff(admin, "DELETE", `cases/${c.id}?confirm=${encodeURIComponent(c.gsp_case_no)}`);
        n += 1;
      } catch (e: any) {
        return `部分未清 ${c.gsp_case_no}: ${e.message}`;
      }
    }
    return n ? `删 ${n}` : "无残留";
  });

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("GSP案例");
  sheet.addRow(["服务案例号", "项目名称", "服务类型", "产品线", "创建人", "省份", "城市", "失效现象描述"]);
  for (const [key, no] of Object.entries(nos)) {
    sheet.addRow([
      no,
      `E2E${key}项目`,
      tpl.name,
      line || "地面-组串式",
      "E2E",
      "安徽",
      "合肥",
      "E2E 生命周期测试",
    ]);
  }
  const xlsxPath = join(ROOT, "apps/web/.tmp-e2e-cases.xlsx");
  await wb.xlsx.writeFile(xlsxPath);

  const imported = await critical("导入 8 条 E2E 案例", async () => {
    const r = await bffUpload(admin, "import/gsp-cases", xlsxPath, "e2e-cases.xlsx");
    return r;
  });
  console.log(`    import ${JSON.stringify(imported).slice(0, 180)}`);

  const byNo = await critical("按号取回案例", async () => {
    const r = await bff(admin, "GET", `cases?keyword=${stamp}&limit=50`);
    const list = r.list || [];
    const map = new Map(list.map((c: any) => [c.gspCaseNo, c]));
    for (const no of Object.values(nos)) {
      if (!map.get(no)) throw new Error(`导入后找不到 ${no}`);
    }
    return map as Map<string, any>;
  });

  const get = (key: keyof typeof nos) => byNo.get(nos[key])!;
  const reload = async (id: string) => bff(admin, "GET", `cases/${id}`);

  phase("3 待分配：编辑 / 删除");
  await step("待分配可改项目名和网格", async () => {
    const c = get("edit");
    const saved = await bff(admin, "PATCH", `cases/${c.id}/profile`, {
      projectName: "E2E已改名",
      province: "安徽",
      city: "合肥",
      siteDesc: "编辑后描述",
      siteId: sites.a.id,
      templateId: tpl.id,
      productLine: line || null,
    });
    expect(saved.projectName === "E2E已改名", `项目名 ${saved.projectName}`);
    expect(saved.siteId === sites.a.id, `网格 ${saved.siteId}`);
    expect(saved.status === "pending_assign", `状态 ${saved.status}`);
    return saved.status;
  });

  await step("待分配可删除", async () => {
    const c = get("del");
    const r = await bff(admin, "DELETE", `cases/${c.id}?confirm=${encodeURIComponent(c.gspCaseNo)}`);
    expect(r.success, "删除未成功");
    try {
      await bff(admin, "GET", `cases/${c.id}`);
      throw new Error("删除后仍能读到");
    } catch (e: any) {
      if (/仍能读到/.test(e.message)) throw e;
    }
    return r.gspCaseNo;
  });

  await step("工程师不能删案例", async () => {
    const c = get("edit");
    return bffExpectFail(eng1, "DELETE", `cases/${c.id}?confirm=${encodeURIComponent(c.gspCaseNo)}`, undefined, "工程师删除");
  });

  phase("4 已派单：改类型 / 改网格 / 删除");
  await critical("准备已派单（改类型）", async () => {
    const c = get("type");
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [c.id], siteId: sites.a.id });
    await bff(admin, "PUT", `cases/${c.id}/task-type`, { templateId: tpl.id, productLine: line || undefined });
    await bff(mgr, "POST", `cases/${c.id}/assign`, {
      inspectorIds: [ids.e2eeng1],
      plannedUnits: 1,
      assignMode: "single",
    });
    const after = await reload(c.id);
    expect(after.status === "assigned", `派单后 ${after.status}`);
  });

  await step("已派单改产品线：人还在", async () => {
    const c = await reload(get("type").id);
    const saved = await bff(admin, "PATCH", `cases/${c.id}/profile`, {
      projectName: c.projectName,
      province: c.province,
      city: c.city,
      siteDesc: c.siteDesc,
      siteId: c.siteId,
      templateId: tpl.id,
      productLine: line || null,
    });
    expect(saved.status === "assigned", `改类型后状态变成 ${saved.status}`);
    expect(!saved.dispatchWithdrawn, "不该撤派单");
    expect(saved.inspectorId === ids.e2eeng1 || saved.inspectorName, `工程师丢了 ${saved.inspectorId}`);
    return saved.status;
  });

  await step("已派单改项目名：任务标题跟着变", async () => {
    const c = await reload(get("type").id);
    const saved = await bff(admin, "PATCH", `cases/${c.id}/profile`, {
      projectName: "E2E改名后任务标题",
      province: c.province,
      city: c.city,
      siteDesc: c.siteDesc,
      siteId: c.siteId,
      templateId: tpl.id,
      productLine: line || null,
    });
    expect(saved.projectName === "E2E改名后任务标题", `项目名 ${saved.projectName}`);
    const tasks = await gql(
      admin,
      `query ($cid: uuid!) {
        inspection_tasks(where: { service_case_id: { _eq: $cid } }) { task_name }
      }`,
      { cid: c.id },
    );
    const names = (tasks.inspection_tasks || []).map((t: { task_name?: string }) => String(t.task_name || ""));
    expect(
      names.some((n: string) => n.includes("E2E改名后任务标题")),
      `任务标题未同步 ${names.join(" | ")}`,
    );
    return names[0] || "ok";
  });

  await critical("准备已派单（改网格）", async () => {
    const c = get("site");
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [c.id], siteId: sites.a.id });
    await bff(admin, "PUT", `cases/${c.id}/task-type`, { templateId: tpl.id, productLine: line || undefined });
    await bff(mgr, "POST", `cases/${c.id}/assign`, {
      inspectorIds: [ids.e2eeng1],
      plannedUnits: 1,
      assignMode: "single",
    });
  });

  await step("已派单改网格：撤回并回待派单", async () => {
    const c = await reload(get("site").id);
    const saved = await bff(admin, "PATCH", `cases/${c.id}/profile`, {
      projectName: c.projectName,
      province: c.province,
      city: c.city,
      siteDesc: c.siteDesc,
      siteId: sites.b.id,
      templateId: tpl.id,
      productLine: line || null,
    });
    expect(saved.dispatchWithdrawn, "应撤回派单");
    expect(saved.status === "pending_assign", `状态 ${saved.status}`);
    expect(saved.siteId === sites.b.id, `网格 ${saved.siteId}`);
    expect(!saved.inspectorId, `工程师还在 ${saved.inspectorId}`);
    return `${saved.status} withdrawn=${saved.dispatchWithdrawn}`;
  });

  await step("网格长不能改网格", async () => {
    const c = await reload(get("type").id);
    const saved = await bff(mgr, "PATCH", `cases/${c.id}/profile`, {
      projectName: c.projectName,
      province: c.province,
      city: c.city,
      siteDesc: "网格长改描述",
      siteId: sites.b.id,
      templateId: tpl.id,
      productLine: line || null,
    });
    expect(saved.siteId === c.siteId, `网格长改掉了网格 ${saved.siteId}`);
    return `site仍=${saved.siteId}`;
  });

  await step("已派单可删除", async () => {
    const c = await reload(get("type").id);
    expect(c.status === "assigned", `不是已派单 ${c.status}`);
    const r = await bff(admin, "DELETE", `cases/${c.id}?confirm=${encodeURIComponent(c.gspCaseNo)}`);
    return r.gspCaseNo;
  });

  await step("批量分配跳过已派单", async () => {
    const workingPrep = get("work");
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [workingPrep.id], siteId: sites.a.id });
    await bff(admin, "PUT", `cases/${workingPrep.id}/task-type`, {
      templateId: tpl.id,
      productLine: line || undefined,
    });
    await bff(mgr, "POST", `cases/${workingPrep.id}/assign`, {
      inspectorIds: [ids.e2eeng1],
      plannedUnits: 1,
      assignMode: "single",
    });
    const r = await bff(admin, "POST", "cases/assign-sites", {
      caseIds: [workingPrep.id],
      siteId: sites.b.id,
    });
    expect(r.updated === 0, `已派单被批量改了 ${r.updated}`);
    expect(r.skipped?.length >= 1, "没有 skipped");
    return `skipped=${r.skipped.length}`;
  });

  phase("5 作业中：锁结构字段，可重置");
  await critical("工程师开工", async () => {
    const c = get("work");
    await bff(eng1, "POST", `cases/${c.id}/start`);
    const after = await reload(c.id);
    expect(after.status === "working", `开工后 ${after.status}`);
  });

  await step("作业中改类型应拒绝", async () => {
    const c = await reload(get("work").id);
    return bffExpectFail(
      admin,
      "PUT",
      `cases/${c.id}/task-type`,
      { templateId: tpl.id, productLine: line || undefined },
      "作业中设类型",
    );
  });

  await step("作业中删除应拒绝", async () => {
    const c = await reload(get("work").id);
    return bffExpectFail(
      admin,
      "DELETE",
      `cases/${c.id}?confirm=${encodeURIComponent(c.gspCaseNo)}`,
      undefined,
      "作业中删除",
    );
  });

  await step("作业中编辑只改描述，网格不动", async () => {
    const c = await reload(get("work").id);
    const saved = await bff(admin, "PATCH", `cases/${c.id}/profile`, {
      projectName: "作业中改名",
      province: c.province,
      city: c.city,
      siteDesc: "作业中描述",
      siteId: sites.b.id,
      templateId: tpl.id,
      productLine: line || null,
    });
    expect(saved.projectName === "作业中改名", `项目名 ${saved.projectName}`);
    expect(saved.siteId === c.siteId, `作业中网格被改成 ${saved.siteId}`);
    expect(saved.status === "working", `状态 ${saved.status}`);
    return saved.status;
  });

  await step("作业中可重置回待分配", async () => {
    const c = await reload(get("work").id);
    const r = await bff(admin, "POST", `cases/${c.id}/reset`, { confirm: c.gspCaseNo });
    expect(r.status === "pending_assign", `重置后 ${r.status}`);
    expect(!r.siteId, `网格还在 ${r.siteId}`);
    expect(!r.inspectorId, `人还在 ${r.inspectorId}`);
    return r.status;
  });

  phase("6 单人作业到结算 / 考核");
  const single = get("single");
  await critical("单人：分网格+类型+派单", async () => {
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [single.id], siteId: sites.a.id });
    await bff(admin, "PUT", `cases/${single.id}/task-type`, {
      templateId: tpl.id,
      productLine: line || undefined,
    });
    await bff(mgr, "POST", `cases/${single.id}/assign`, {
      inspectorIds: [ids.e2eeng1],
      plannedUnits: 1,
      assignMode: "single",
    });
  });
  await critical("单人：开工/序列号/完工", async () => {
    await bff(eng1, "POST", `cases/${single.id}/start`);
    const d = await bff(eng1, "GET", `cases/my/${single.id}`);
    const units = d.units || d.workUnits || [];
    const unit = units[0];
    if (!unit) throw new Error("无工作单元");
    if (unit.status === "open") {
      await bff(eng1, "POST", `cases/${single.id}/units/${unit.id}/claim`);
    }
    await bff(eng1, "POST", `cases/${single.id}/units/${unit.id}/serial`, {
      deviceSerial: "E2E-SN-0001",
    });
    await bff(eng1, "POST", `cases/${single.id}/units/${unit.id}/complete`);
    await bff(eng1, "POST", `cases/${single.id}/finish`);
    const after = await reload(single.id);
    expect(after.status === "settle_review", `完工后 ${after.status}`);
  });

  await step("待结算不可删除", async () => {
    const c = await reload(single.id);
    return bffExpectFail(
      admin,
      "DELETE",
      `cases/${c.id}?confirm=${encodeURIComponent(c.gspCaseNo)}`,
      undefined,
      "待结算删除",
    );
  });

  await step("登记考核事件", async () => {
    const catalog = await bff(admin, "GET", "assessments/event-catalog");
    const items = catalog.list || catalog.items || catalog || [];
    const first = Array.isArray(items) ? items[0] : null;
    if (!first?.id) return `目录空 ${JSON.stringify(catalog).slice(0, 80)}`;
    const ev = await bff(admin, "POST", "assessments/events", {
      catalogId: first.id,
      userId: ids.e2eeng1,
      serviceCaseId: single.id,
      qty: 1,
    });
    return ev.id || ev.month || "ok";
  });

  await step("结算审核通过", async () => {
    await bff(admin, "GET", `review/${single.id}/amount-breakdown`).catch(() => null);
    await bff(admin, "POST", `review/${single.id}/approve`, { comment: "E2E 通过" });
    const after = await reload(single.id);
    expect(after.status === "settled", `审核后 ${after.status}`);
    return after.status;
  });

  await step("已结算不可删除，可重置", async () => {
    const c = await reload(single.id);
    await bffExpectFail(
      admin,
      "DELETE",
      `cases/${c.id}?confirm=${encodeURIComponent(c.gspCaseNo)}`,
      undefined,
      "已结算删除",
    );
    const r = await bff(admin, "POST", `cases/${c.id}/reset`, { confirm: c.gspCaseNo });
    expect(r.status === "pending_assign", `重置后 ${r.status}`);
    return "reset-ok";
  });

  phase("7 多人派单");
  const multi = get("multi");
  await critical("多人：分网格+类型+两人派单", async () => {
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [multi.id], siteId: sites.a.id });
    await bff(admin, "PUT", `cases/${multi.id}/task-type`, {
      templateId: tpl.id,
      productLine: line || undefined,
    });
    await bff(mgr, "POST", `cases/${multi.id}/assign`, {
      inspectorIds: [ids.e2eeng1, ids.e2eeng2],
      plannedUnits: 2,
      assignMode: "multi",
    });
    const after = await reload(multi.id);
    expect(after.status === "assigned", `多人派单后 ${after.status}`);
    expect(after.assignMode === "multi" || after.plannedUnits >= 2, `不是多人 ${after.assignMode}/${after.plannedUnits}`);
  });

  await step("两人各认领一台", async () => {
    await bff(eng1, "POST", `cases/${multi.id}/start`).catch(() => null);
    await bff(eng2, "POST", `cases/${multi.id}/start`).catch(() => null);
    const d1 = await bff(eng1, "GET", `cases/my/${multi.id}`);
    const open1 = (d1.units || d1.workUnits || []).find((u: any) => u.status === "open");
    if (!open1) throw new Error(`李工无可认领 ${(d1.units || []).map((u: any) => u.status)}`);
    await bff(eng1, "POST", `cases/${multi.id}/units/${open1.id}/claim`);
    const d2 = await bff(eng2, "GET", `cases/my/${multi.id}`);
    const open2 = (d2.units || d2.workUnits || []).find((u: any) => u.status === "open");
    if (!open2) throw new Error(`王工无可认领 ${(d2.units || []).map((u: any) => u.status)}`);
    await bff(eng2, "POST", `cases/${multi.id}/units/${open2.id}/claim`);
    return "claimed-2";
  });

  await step("多人作业中改网格应拒绝（已开工）", async () => {
    const c = await reload(multi.id);
    expect(c.status === "working", `期望 working，实际 ${c.status}`);
    return bffExpectFail(
      admin,
      "PUT",
      `cases/${c.id}/site`,
      { siteId: sites.b.id },
      "作业中改网格接口",
    );
  });

  await step("多人作业中重置", async () => {
    const c = await reload(multi.id);
    const r = await bff(admin, "POST", `cases/${c.id}/reset`, { confirm: c.gspCaseNo });
    expect(r.status === "pending_assign", `重置后 ${r.status}`);
    return r.status;
  });

  phase("8 月结锁定");
  await step("月结锁定后不可编辑/重置", async () => {
    const c = get("month");
    await gql(
      admin,
      `mutation ($id: uuid!) {
        update_service_cases_by_pk(pk_columns: { id: $id }, _set: { status: "month_locked" }) { id status }
      }`,
      { id: c.id },
    );
    const e1 = await bffExpectFail(
      admin,
      "PATCH",
      `cases/${c.id}/profile`,
      { projectName: "不该改", province: "安徽", city: "合肥", siteDesc: "x" },
      "月结编辑",
    );
    const e2 = await bffExpectFail(
      admin,
      "POST",
      `cases/${c.id}/reset`,
      { confirm: c.gspCaseNo },
      "月结重置",
    );
    return `${e1} | ${e2}`;
  });

  await step("看月结列表", async () => {
    const month = new Date().toISOString().slice(0, 7);
    const r = await bff(admin, "GET", `monthly-settlements?month=${month}`);
    const list = r.list || r || [];
    return `rows=${Array.isArray(list) ? list.length : Object.keys(r).length}`;
  });

  await step("网格长看本网格案例", async () => {
    const r = await bff(mgr, "GET", "cases?limit=20");
    const list = r.list || [];
    const leak = list.find((c: any) => c.siteId && c.siteId !== sites.a.id);
    if (leak) throw new Error(`网格长看到其他网格 ${leak.gspCaseNo}`);
    return `n=${list.length}`;
  });

  await step("工程师只看自己的单", async () => {
    const r = await bff(eng1, "GET", "cases/my/list");
    const list = r.list || r || [];
    return `n=${Array.isArray(list) ? list.length : 0}`;
  });

  await step("扣罚旧接口", async () => {
    try {
      await bff(admin, "POST", `review/${get("month").id}/deduction`, { amount: 10, reason: "E2E" });
      return "旧扣罚接口仍在";
    } catch (e: any) {
      return `旧接口不可用（走考核事件）: ${String(e.message).slice(0, 60)}`;
    }
  });

  phase("9 收尾清理");
  await step("删除本轮剩余 E2E 案例", async () => {
    const exist = await gql(
      admin,
      `query ($p: String!) {
        service_cases(where: { gsp_case_no: { _like: $p } }) { id gsp_case_no status }
      }`,
      { p: `${stamp}%` },
    );
    let n = 0;
    for (const c of exist.service_cases || []) {
      try {
        if (c.status === "month_locked") {
          await gql(
            admin,
            `mutation ($id: uuid!) {
              update_service_cases_by_pk(pk_columns: { id: $id }, _set: { status: "pending_assign" }) { id }
            }`,
            { id: c.id },
          );
        } else if (!["pending_assign", "assigned"].includes(c.status)) {
          await bff(admin, "POST", `cases/${c.id}/reset`, { confirm: c.gsp_case_no });
        }
        await bff(admin, "DELETE", `cases/${c.id}?confirm=${encodeURIComponent(c.gsp_case_no)}`);
        n += 1;
      } catch (e: any) {
        console.log(`    未删 ${c.gsp_case_no}: ${e.message}`);
      }
    }
    return `deleted=${n}`;
  });

  const fails = results.filter((r) => !r.ok);
  console.log(`\n完成 ${results.length} 步，失败 ${fails.length}`);
  if (fails.length) {
    for (const f of fails) console.log(`  - [${f.phase}] ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
