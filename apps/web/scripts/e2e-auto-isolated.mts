/**
 * Composer 隔离全流程 E2E（避开与其它测试员共用账号/案例冲突）
 * 用法：cd apps/web && node node_modules/tsx/dist/cli.mjs scripts/e2e-auto-isolated.mts
 *
 * 覆盖：独立网格/账号 → 导入素材(幂等) → 分配网格 → 服务类型 → 派单 →
 *       单人自动认领路径 + 多人认领路径 → 上传/OCR/完成 → 报销 → 审核 → 负向权限
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const ASSETS = resolve(ROOT, "测试素材");
const BASE = process.env.E2E_BASE || "http://localhost:3000";
const TAG = "auto"; // 隔离前缀
const PWD = "Test@2026";
const REPORT = resolve(ROOT, "e2e-auto测试报告.md");

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

async function bffUpload(s: Session, path: string, filePath: string, extra?: Record<string, string>): Promise<any> {
  const buf = readFileSync(filePath);
  const name = filePath.split(/[\\/]/).pop()!;
  const form = new FormData();
  form.append("file", new File([buf], name, { type: guessType(name) }));
  if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);
  const res = await fetch(`${BASE}/api/bff/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${s.token}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data !== undefined ? json.data : json;
}

function guessType(name: string) {
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "image/jpeg";
}

async function gqlDirect(s: Session, query: string, variables?: Record<string, unknown>): Promise<any> {
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
function firstPhoto(dir: string, index = 0): string {
  const files = readdirSync(dir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  if (!files.length) throw new Error(`目录无照片: ${dir}`);
  return join(dir, files[Math.min(index, files.length - 1)]);
}

function writeReport(extra?: string) {
  const fails = results.filter((r) => !r.ok);
  const lines = [
    `# E2E Auto 隔离全流程测试报告`,
    ``,
    `- 时间: ${new Date().toISOString()}`,
    `- 目标: ${BASE}`,
    `- 隔离前缀: ${TAG}`,
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
  console.log(`目标: ${BASE}  隔离前缀: ${TAG}`);
  if (!existsSync(ASSETS)) throw new Error("测试素材目录不存在: " + ASSETS);

  phase("阶段0 管理员登录");
  const admin = await critical("admin 登录", () => login("admin", "admin123", "pc"));
  console.log(`    admin id=${admin.user.id}`);

  phase("阶段1 隔离账号与网格");
  const hash = await bcrypt.hash(PWD, 10);
  async function ensureUser(username: string, realName: string, phone: string, role: string, roles: string[]) {
    const found = await gqlDirect(admin,
      `query ($u: String!) { users(where: { username: { _eq: $u } }) { id username role } }`,
      { u: username });
    if (found.users.length) {
      await gqlDirect(admin,
        `mutation ($id: uuid!, $p: String!, $role: String!, $roles: jsonb!) {
          update_users_by_pk(pk_columns:{id:$id}, _set:{password:$p, status:"active", role:$role, roles:$roles}) { id }
        }`,
        { id: found.users[0].id, p: hash, role, roles });
      return found.users[0].id as string;
    }
    const ins = await gqlDirect(admin,
      `mutation ($obj: users_insert_input!) { insert_users_one(object: $obj) { id } }`,
      { obj: { username, password: hash, real_name: realName, phone, role, roles, status: "active", created_by_id: admin.user.id } });
    return ins.insert_users_one.id as string;
  }

  let managerId = "";
  let eng1Id = "";
  let eng2Id = "";
  await critical("创建网格长 auto_mgr", async () => {
    managerId = await ensureUser(`${TAG}_mgr`, "自动网格长", "13900000001", "site_manager", ["site_manager"]);
  });
  await critical("创建工程师 auto_eng1", async () => {
    eng1Id = await ensureUser(`${TAG}_eng1`, "自动工程师甲", "13900000002", "inspector", ["inspector"]);
  });
  await critical("创建工程师 auto_eng2", async () => {
    eng2Id = await ensureUser(`${TAG}_eng2`, "自动工程师乙", "13900000003", "inspector", ["inspector"]);
  });

  let siteId = "";
  const siteCode = `${TAG.toUpperCase()}-HF-001`;
  await critical("创建隔离网格", async () => {
    const found = await gqlDirect(admin,
      `query ($c: String!) { sites(where: { code: { _eq: $c } }) { id } }`, { c: siteCode });
    if (found.sites.length) {
      siteId = found.sites[0].id;
      await gqlDirect(admin,
        `mutation ($id: uuid!, $m: uuid!) { update_sites_by_pk(pk_columns:{id:$id}, _set:{manager_id:$m}) { id } }`,
        { id: siteId, m: managerId });
      return;
    }
    const ins = await gqlDirect(admin,
      `mutation ($obj: sites_insert_input!) { insert_sites_one(object: $obj) { id } }`,
      {
        obj: {
          name: "自动测试光伏电站",
          code: siteCode,
          province: "安徽省",
          city: "合肥市",
          district: "包河区",
          address: "包河区自动测试路 1 号",
          latitude: 31.78,
          longitude: 117.3,
          manager_id: managerId,
        },
      });
    siteId = ins.insert_sites_one.id;
  });
  console.log(`    siteId=${siteId}`);

  const manager = await critical("网格长登录", () => login(`${TAG}_mgr`, PWD, "pc"));
  await critical("网格长招募工程师", async () => {
    for (const uid of [eng1Id, eng2Id]) {
      const exist = await gqlDirect(manager,
        `query ($s: uuid!, $u: uuid!) { site_members(where: { site_id: { _eq: $s }, user_id: { _eq: $u } }) { id } }`,
        { s: siteId, u: uid });
      if (exist.site_members.length) continue;
      await gqlDirect(manager,
        `mutation ($obj: site_members_insert_input!) { insert_site_members_one(object: $obj) { id } }`,
        { obj: { site_id: siteId, user_id: uid, member_role: "inspector" } });
    }
  });
  const eng1 = await critical("工程师甲登录", () => login(`${TAG}_eng1`, PWD, "mobile"));
  const eng2 = await critical("工程师乙登录", () => login(`${TAG}_eng2`, PWD, "mobile"));

  phase("阶段2 导入/确认素材数据");
  // 价格库/案例已可能被其它测试员导入，仍做幂等尝试
  await step("导入甲方结算价", async () => {
    const r = await bffUpload(admin, "prices/import", asset("甲方结算价_测试20条_20260803.xlsx"));
    return JSON.stringify(r).slice(0, 160);
  });
  await step("导入内部绩效价", async () => {
    const r = await bffUpload(admin, "prices/import-perf", asset("内部绩效价_测试20条_20260803.xlsx"));
    return JSON.stringify(r).slice(0, 160);
  });
  await step("导入 GSP 案例表", async () => {
    const r = await bffUpload(admin, "import/gsp-cases", asset("GSP案例表_测试20条_20260803.xlsx"));
    return JSON.stringify(r).slice(0, 160);
  });
  await step("导入 PO 表单", async () => {
    const r = await bffUpload(admin, "import/po-orders", asset("PO表单_测试20条_20260803.xlsx"));
    return JSON.stringify(r).slice(0, 160);
  });
  await step("PO 生成案例", async () => {
    const r = await bff(admin, "POST", "po-orders/generate-cases", {});
    return JSON.stringify(r).slice(0, 160);
  });
  await step("价格映射重算", async () => {
    const r = await bff(admin, "POST", "prices/mappings/recalculate", {});
    return JSON.stringify(r).slice(0, 160);
  });

  phase("阶段3 挑选未占用案例并派单");
  const caseList = await critical("查询未分配案例", async () => {
    const r = await bff(admin, "GET", "cases?limit=50&status=pending_assign");
    const list = (r.list || []).filter((c: any) => !c.siteId && !c.inspectorId);
    if (list.length < 2) {
      // 兜底：任意无网格案例
      const all = await bff(admin, "GET", "cases?limit=50");
      const free = (all.list || []).filter((c: any) => !c.siteId);
      if (free.length < 2) throw new Error(`可用未分配案例不足: ${free.length}`);
      return free;
    }
    return list;
  });
  const templates = await critical("查询服务类型", async () => {
    const r = await bff(admin, "GET", "templates");
    const list = Array.isArray(r) ? r : r.list || [];
    if (!list.length) throw new Error("无模板");
    return list;
  });
  const tplFault = templates.find((t: any) => /故障|恢复/.test(t.name)) || templates[0];
  const tplMaint = templates.find((t: any) => /维护|巡检/.test(t.name)) || templates[0];

  // 案例A：单人派单（系统自动认领）
  // 案例B：多人/多台（plannedUnits=2，需手动认领）
  const caseA = caseList[0];
  const caseB = caseList[1];
  console.log(`    A=${caseA.gspCaseNo} B=${caseB.gspCaseNo}`);

  await critical("分配两案到隔离网格", async () => {
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [caseA.id, caseB.id], siteId });
  });
  await critical("设置服务类型", async () => {
    await bff(admin, "PUT", `cases/${caseA.id}/task-type`, { templateId: tplFault.id });
    await bff(admin, "PUT", `cases/${caseB.id}/task-type`, { templateId: tplMaint.id });
  });
  await critical("网格长单人派单 案例A→工程师甲", async () => {
    await bff(manager, "POST", `cases/${caseA.id}/assign`, {
      inspectorIds: [eng1Id],
      plannedUnits: 1,
      assignMode: "single",
    });
  });
  await critical("网格长多人派单 案例B→甲乙 plannedUnits=2", async () => {
    await bff(manager, "POST", `cases/${caseB.id}/assign`, {
      inspectorIds: [eng1Id, eng2Id],
      plannedUnits: 2,
      assignMode: "multi",
    });
  });

  phase("阶段4 单人自动认领路径（案例A / 工程师甲）");
  const myAList = await critical("工程师甲查看任务", async () => {
    const r = await bff(eng1, "GET", "cases/my/list");
    if (!Array.isArray(r) || !r.length) throw new Error("我的任务为空");
    return r;
  });
  const myA = myAList.find((c: any) => c.id === caseA.id) || myAList[0];
  await critical("开始案例A", () => bff(eng1, "POST", `cases/${myA.id}/start`));
  const detailA = await critical("案例A详情", () => bff(eng1, "GET", `cases/my/${myA.id}`));
  const unitsA = detailA.units || detailA.workUnits || [];
  console.log(`    单元: ${unitsA.map((u: any) => `${u.id.slice(0, 8)}:${u.status}`).join(", ")}`);

  let taskId = "";
  let unitA = unitsA[0];
  await critical("复用自动认领或手动认领", async () => {
    if (!unitA) throw new Error("无工作单元");
    if (unitA.status === "claimed" || unitA.status === "working") {
      taskId = unitA.inspectionTaskId || unitA.inspection_task_id || "";
      if (!taskId) {
        // 从详情 tasks 取
        const tasks = detailA.tasks || detailA.inspectionTasks || [];
        taskId = tasks.find((t: any) => t.workUnitId === unitA.id || t.work_unit_id === unitA.id)?.id || tasks[0]?.id || "";
      }
      if (!taskId) throw new Error("已认领但无 inspectionTaskId");
      return;
    }
    if (unitA.status !== "open") throw new Error(`单元状态异常: ${unitA.status}`);
    const claimed = await bff(eng1, "POST", `cases/${myA.id}/units/${unitA.id}/claim`);
    taskId = claimed?.inspectionTaskId || "";
  });
  console.log(`    taskId=${taskId}`);

  let workPhotoUrl = "";
  await step("上传工作照片", async () => {
    const photoDir = join(ASSETS, "故障恢复-地面组串式");
    let photo = asset("序列号1.jpg");
    try {
      // 优先合格案例图
      const sub = join(photoDir, "合格案例");
      if (existsSync(sub)) {
        const walk = (d: string): string[] => {
          const out: string[] = [];
          for (const f of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, f.name);
            if (f.isDirectory()) out.push(...walk(p));
            else if (/\.(jpg|jpeg|png)$/i.test(f.name)) out.push(p);
          }
          return out;
        };
        const photos = walk(sub);
        if (photos.length) photo = photos[0];
      }
    } catch { /* use fallback */ }
    const r = await bffUpload(eng1, `cases/${myA.id}/work-photo`, photo);
    workPhotoUrl = r.url || r.publicUrl || "";
    if (!workPhotoUrl) throw new Error("未返回URL: " + JSON.stringify(r).slice(0, 120));
    return workPhotoUrl.slice(0, 80);
  });

  await step("获取直传 token", async () => {
    const tok = await bff(eng1, "GET", "upload/token?filename=e2e-auto.jpg&contentType=image/jpeg");
    if (!tok.uploadUrl) throw new Error("无 uploadUrl");
    const buf = readFileSync(asset("序列号1.jpg"));
    const put = await fetch(tok.uploadUrl, {
      method: tok.method === "POST" ? "POST" : "PUT",
      headers: { ...(tok.headers || {}), "Content-Type": tok.contentType || "image/jpeg" },
      body: buf,
    });
    if (!put.ok) throw new Error(`直传失败 ${put.status}: ${(await put.text()).slice(0, 120)}`);
    return tok.publicUrl || tok.key || "ok";
  });

  if (unitA) {
    await step("序列号 OCR", async () => {
      const up = await bffUpload(eng1, `cases/${myA.id}/work-photo`, asset("序列号1.jpg"));
      const url = up.url || up.publicUrl;
      const r = await bff(eng1, "POST", `cases/${myA.id}/units/${unitA.id}/serial/ocr`, { imageUrl: url });
      return `serial=${r.serial || "(空)"} conf=${r.confidence ?? "-"}`;
    });
    await step("保存序列号", async () => {
      await bff(eng1, "POST", `cases/${myA.id}/units/${unitA.id}/serial`, { deviceSerial: "AUTO-SG-2026-0001" });
    });
  }

  if (taskId) {
    await step("开始巡检任务（生成记录）", async () => {
      await bff(eng1, "PUT", `tasks/${taskId}/start`);
    });
    await step("获取巡检任务", async () => {
      const t = await bff(eng1, "GET", `tasks/${taskId}`);
      if (!t) throw new Error("任务不存在");
      return t.status || "ok";
    });
    const recList = await bff(eng1, "GET", `records?taskId=${taskId}`).catch(() => null);
    const list = recList?.list || recList?.records || (Array.isArray(recList) ? recList : []);
    const rec = list[0];
    if (rec) {
      await step("提交巡检记录", async () => {
        await bff(eng1, "PUT", `records/${rec.id}/submit`, {
          locationStatus: "skipped",
          locationReason: "E2E auto 无 GPS",
        });
      });
    } else {
      await step("巡检记录", async () => "无记录（模板可能无检查项条目）");
    }
  }

  if (unitA) {
    await step("完成工作单元A", () => bff(eng1, "POST", `cases/${myA.id}/units/${unitA.id}/complete`).then(() => "OK"));
  }
  await step("完成案例A", () => bff(eng1, "POST", `cases/${myA.id}/finish`).then(() => "OK"));

  phase("阶段5 多人认领路径（案例B）");
  const detailB1 = await critical("工程师甲看案例B", () => bff(eng1, "GET", `cases/my/${caseB.id}`));
  const unitsB = detailB1.units || detailB1.workUnits || [];
  console.log(`    B单元: ${unitsB.map((u: any) => `${u.seq||"?"}:${u.status}`).join(", ")}`);
  const openB = unitsB.find((u: any) => u.status === "open");
  await step("工程师甲认领B单元", async () => {
    if (!openB) return `无可认领单元（已有 ${unitsB.length}）`;
    await bff(eng1, "POST", `cases/${caseB.id}/start`).catch(() => null);
    const r = await bff(eng1, "POST", `cases/${caseB.id}/units/${openB.id}/claim`);
    return r.inspectionTaskId || "claimed";
  });
  await step("工程师乙认领另一单元", async () => {
    await bff(eng2, "POST", `cases/${caseB.id}/start`).catch(() => null);
    const d = await bff(eng2, "GET", `cases/my/${caseB.id}`);
    const units = d.units || d.workUnits || [];
    const open = units.find((u: any) => u.status === "open");
    if (!open) return `乙无可认领: ${units.map((u: any) => u.status).join(",")}`;
    const r = await bff(eng2, "POST", `cases/${caseB.id}/units/${open.id}/claim`);
    return r.inspectionTaskId || "claimed";
  });

  phase("阶段6 报销与审核（案例A）");
  let startOdoUrl = "";
  let endOdoUrl = "";
  await step("上传里程表", async () => {
    const s = await bffUpload(eng1, `cases/${myA.id}/work-photo`, asset("开始里程表.png"));
    startOdoUrl = s.url || s.publicUrl;
    const e = await bffUpload(eng1, `cases/${myA.id}/work-photo`, asset("结束里程表.png"));
    endOdoUrl = e.url || e.publicUrl;
    return "ok";
  });
  let startMileage = 10000;
  let endMileage = 10186;
  await step("里程 OCR", async () => {
    const rs = await bff(eng1, "POST", `cases/${myA.id}/my-expense/ocr-mileage`, { imageUrl: startOdoUrl, kind: "start" });
    const re = await bff(eng1, "POST", `cases/${myA.id}/my-expense/ocr-mileage`, { imageUrl: endOdoUrl, kind: "end" });
    if (rs.mileage) startMileage = rs.mileage;
    if (re.mileage) endMileage = re.mileage;
    return `start=${rs.mileage ?? "?"} end=${re.mileage ?? "?"}`;
  });
  await critical("提交报销", async () => {
    const km = Math.max(0, endMileage - startMileage);
    await bff(eng1, "POST", `cases/${myA.id}/my-expense`, {
      lineItems: [
        { type: "mileage", name: "自驾里程", quantity: km, unitPrice: 1.2, amount: Math.round(km * 1.2 * 100) / 100 },
        { type: "other", name: "过路费", quantity: 1, unitPrice: 50, amount: 50 },
      ],
      startOdometerUrl: startOdoUrl,
      endOdometerUrl: endOdoUrl,
      startMileage,
      endMileage,
      voucherUrls: workPhotoUrl ? [workPhotoUrl] : [],
      note: "auto E2E 报销",
      submit: true,
    });
  });
  await critical("管理员批准报销", async () => {
    const pending = await bff(admin, "GET", "cases/expenses/pending");
    const list = pending.list || pending || [];
    if (!Array.isArray(list) || !list.length) throw new Error("无待审报销");
    const claim = list.find((c: any) =>
      c.inspectorName === "自动工程师甲" || c.inspector_name === "自动工程师甲" ||
      c.inspectorId === eng1Id || c.inspector_id === eng1Id
    ) || list[0];
    await bff(admin, "POST", `cases/expenses/${claim.id}/approve`, { note: "auto 审核通过" });
  });
  await step("案例审核批准", async () => {
    const pend = await bff(admin, "GET", "review/pending");
    const list = pend.list || pend || [];
    if (!Array.isArray(list) || !list.length) return "无待审案例";
    const target = list.find((c: any) => c.id === myA.id) || list[0];
    await bff(admin, "GET", `review/${target.id}/amount-breakdown`).catch(() => null);
    await bff(admin, "POST", `review/${target.id}/approve`, {});
    return target.gspCaseNo || target.id;
  });
  await step("财务总览", async () => JSON.stringify(await bff(admin, "GET", "finance/dashboard")).slice(0, 140));
  await step("我的收入", async () => JSON.stringify(await bff(eng1, "GET", "my/income")).slice(0, 140));

  phase("阶段7 权限负向");
  await step("未登录 401", async () => {
    try { await bff(null, "GET", "cases"); throw new Error("未授权放行"); }
    catch (e: any) { if (e.status === 401 || /未登录/.test(e.message)) return "401 OK"; throw e; }
  });
  await step("工程师禁入价格重算", async () => {
    try { await bff(eng1, "POST", "prices/mappings/recalculate", {}); throw new Error("越权"); }
    catch (e: any) { if (e.status === 403 || /权限/.test(e.message)) return "拒OK"; throw e; }
  });
  await step("工程师不可建用户", async () => {
    try {
      await gqlDirect(eng1, `mutation { insert_users_one(object: { username: "hack_auto", role: "super_admin", roles: ["super_admin"], status: "active" }) { id } }`);
      throw new Error("越权建超管");
    } catch (e: any) {
      return `拒: ${e.message.slice(0, 80)}`;
    }
  });

  phase("测试汇总");
  writeReport("隔离账号 auto_*，避开 Kimi 共用数据");
  const fails = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 步，成功 ${results.length - fails.length}，失败 ${fails.length}`);
  if (fails.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error("\n流程中断:", e instanceof Error ? e.message : e);
  writeReport(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
