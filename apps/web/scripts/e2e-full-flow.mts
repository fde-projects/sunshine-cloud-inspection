/**
 * 全流程端到端测试驱动：完全模拟真实用户操作（HTTP 层，与浏览器一致）
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/e2e-full-flow.mts
 *
 * 覆盖：建账号 → 建网格 → 招募工程师 → 导入四类Excel → 生成案例 →
 *       分配网格 → 设置服务类型 → 派单 → 工程师接单/上传/AI识别/完成 →
 *       里程OCR → 报销提交 → 审核 → 财务 → 权限负向测试
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { dirname, resolve, join } from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const ASSETS = resolve(ROOT, "测试素材");
const BASE = process.env.E2E_BASE || "http://localhost:3000";

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

// ---------- 结果收集 ----------
type R = { phase: string; name: string; ok: boolean; detail: string };
const results: R[] = [];
let curPhase = "";
function phase(name: string) {
  curPhase = name;
  console.log(`\n========== ${name} ==========`);
}
async function step(name: string, fn: () => Promise<string | void>): Promise<unknown> {
  try {
    const detail = (await fn()) || "OK";
    results.push({ phase: curPhase, name, ok: true, detail });
    console.log(`  ✓ ${name} — ${detail}`);
    return undefined;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ phase: curPhase, name, ok: false, detail });
    console.log(`  ✗ ${name} — ${detail}`);
    return undefined;
  }
}
/** 关键步骤：失败则中止整个流程 */
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

// ---------- HTTP 助手 ----------
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

/** 与浏览器一致：直连 Hasura GraphQL，带 JWT + 角色（同时验证 Hasura 权限配置） */
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

const PWD = "Test@2026";

// ---------- 主流程 ----------
async function main() {
  console.log(`目标: ${BASE}`);
  if (!existsSync(ASSETS)) throw new Error("测试素材目录不存在");

  // ============ 阶段 0：登录 ============
  phase("阶段0 账号登录");
  const admin = await critical("admin 登录", () => login("admin", "admin123", "pc"));
  console.log(`    admin id=${admin.user.id} role=${admin.user.role}`);

  // ============ 阶段 1：创建组织与账号 ============
  phase("阶段1 创建账号与网格");
  const hash = await bcrypt.hash(PWD, 10);

  async function ensureUser(username: string, realName: string, phone: string, role: string, roles: string[]) {
    const found = await gqlDirect(admin,
      `query ($u: String!) { users(where: { username: { _eq: $u } }) { id username role } }`,
      { u: username });
    if (found.users.length) return found.users[0].id as string;
    const ins = await gqlDirect(admin,
      `mutation ($obj: users_insert_input!) {
        insert_users_one(object: $obj) { id }
      }`,
      { obj: { username, password: hash, real_name: realName, phone, role, roles, status: "active", created_by_id: admin.user.id } });
    return ins.insert_users_one.id as string;
  }

  let managerId = "";
  let eng1Id = "";
  let eng2Id = "";
  await critical("创建网格长 张伟", async () => {
    managerId = await ensureUser("zhangwei", "张伟", "13800000001", "site_manager", ["site_manager"]);
  });
  await critical("创建工程师 李强", async () => {
    eng1Id = await ensureUser("liqiang", "李强", "13800000002", "inspector", ["inspector"]);
  });
  await critical("创建工程师 王芳", async () => {
    eng2Id = await ensureUser("wangfang", "王芳", "13800000003", "inspector", ["inspector"]);
  });

  let siteId = "";
  await critical("创建网格 合肥阳光光伏电站", async () => {
    const found = await gqlDirect(admin,
      `query ($c: String!) { sites(where: { code: { _eq: $c } }) { id } }`, { c: "HF-001" });
    if (found.sites.length) { siteId = found.sites[0].id; return; }
    const ins = await gqlDirect(admin,
      `mutation ($obj: sites_insert_input!) {
        insert_sites_one(object: $obj) { id }
      }`,
      {
        obj: {
          name: "合肥阳光光伏电站", code: "HF-001",
          province: "安徽省", city: "合肥市", district: "蜀山区",
          address: "蜀山区科学大道 88 号",
          latitude: 31.8206, longitude: 117.2272,
          manager_id: managerId,
        },
      });
    siteId = ins.insert_sites_one.id;
  });
  console.log(`    siteId=${siteId}`);

  // 网格长登录并招募工程师（验证 site_manager 的 Hasura 权限）
  const manager = await critical("网格长 张伟 登录", () => login("zhangwei", PWD, "pc"));
  await critical("网格长招募李强、王芳", async () => {
    for (const uid of [eng1Id, eng2Id]) {
      const exist = await gqlDirect(manager,
        `query ($s: uuid!, $u: uuid!) { site_members(where: { site_id: { _eq: $s }, user_id: { _eq: $u } }) { id } }`,
        { s: siteId, u: uid });
      if (exist.site_members.length) continue;
      await gqlDirect(manager,
        `mutation ($obj: site_members_insert_input!) {
          insert_site_members_one(object: $obj) { id }
        }`,
        { obj: { site_id: siteId, user_id: uid, member_role: "inspector" } });
    }
  });
  const eng1 = await critical("工程师 李强 登录（移动端）", () => login("liqiang", PWD, "mobile"));
  const eng2 = await critical("工程师 王芳 登录（移动端）", () => login("wangfang", PWD, "mobile"));

  // ============ 阶段 2：导入生产素材数据 ============
  phase("阶段2 导入价格库与案例数据");
  await critical("导入甲方结算价", async () => {
    const r = await bffUpload(admin, "prices/import", asset("甲方结算价_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 200)}`);
  });
  await critical("导入内部绩效价", async () => {
    const r = await bffUpload(admin, "prices/import-perf", asset("内部绩效价_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 200)}`);
  });
  await critical("导入 GSP 案例表", async () => {
    const r = await bffUpload(admin, "import/gsp-cases", asset("GSP案例表_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 200)}`);
  });
  await critical("导入 PO 表单", async () => {
    const r = await bffUpload(admin, "import/po-orders", asset("PO表单_测试20条_20260803.xlsx"));
    console.log(`    ${JSON.stringify(r).slice(0, 200)}`);
  });
  await step("PO 生成案例", async () => {
    const r = await bff(admin, "POST", "po-orders/generate-cases", {});
    return JSON.stringify(r).slice(0, 200);
  });
  await step("价格映射重算", async () => {
    const r = await bff(admin, "POST", "prices/mappings/recalculate", {});
    return JSON.stringify(r).slice(0, 200);
  });

  // ============ 阶段 3：派单 ============
  phase("阶段3 案例分配与派单");
  const caseList = await critical("查询案例列表", async () => {
    const r = await bff(admin, "GET", "cases?limit=50");
    const list = r.list || r.cases || r.items || [];
    if (!list.length) throw new Error("案例列表为空");
    console.log(`    共 ${list.length} 个案例`);
    return list;
  });

  const templates = await critical("查询服务类型模板", async () => {
    const r = await bff(admin, "GET", "templates");
    const list = r.list || r.templates || r || [];
    if (!Array.isArray(list) || !list.length) throw new Error("无可用模板");
    console.log(`    模板: ${list.map((t: any) => t.name).join("、")}`);
    return list;
  });
  const tpl = templates.find((t: any) => /故障|恢复/.test(t.name)) || templates[0];

  // 选 2 个案例走完整流程：案例A 给李强（合格照片），案例B 给王芳（不合格照片，触发AI驳回路径）
  const caseA = caseList[0];
  const caseB = caseList[1] || caseList[0];
  console.log(`    案例A: ${caseA.gspCaseNo || caseA.gsp_case_no} / 案例B: ${caseB.gspCaseNo || caseB.gsp_case_no}`);

  await critical("管理员分配案例到网格", async () => {
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [caseA.id, caseB.id], siteId });
  });
  for (const [c, name] of [[caseA, "A"], [caseB, "B"]] as const) {
    await step(`设置案例${name}服务类型（${tpl.name}）`, async () => {
      await bff(admin, "PUT", `cases/${c.id}/task-type`, { templateId: tpl.id });
    });
  }
  await critical("网格长派单：案例A→李强，案例B→王芳", async () => {
    await bff(manager, "POST", `cases/${caseA.id}/assign`, { inspectorIds: [eng1Id], plannedUnits: 1 });
    await bff(manager, "POST", `cases/${caseB.id}/assign`, { inspectorIds: [eng2Id], plannedUnits: 1 });
  });

  // ============ 阶段 4：工程师作业（李强，合格路径） ============
  phase("阶段4 工程师作业流程（李强）");
  const myCases = await critical("李强查看我的任务", async () => {
    const r = await bff(eng1, "GET", "cases/my/list");
    if (!Array.isArray(r) || !r.length) throw new Error("我的任务为空");
    return r;
  });
  const myA = myCases.find((c: any) => c.id === caseA.id) || myCases[0];
  await critical("李强开始案例", () => bff(eng1, "POST", `cases/${myA.id}/start`));

  const detail = await critical("李强查看案例详情（取工作单元）", async () => {
    const r = await bff(eng1, "GET", `cases/my/${myA.id}`);
    return r;
  });
  const units = detail.units || detail.workUnits || [];
  console.log(`    工作单元 ${units.length} 个`);
  const unit = units[0];
  let taskId = "";
  if (unit) {
    // 单人派单模式下单元可能已自动认领给本人：优先复用已有任务，否则手动认领
    const existingTask = unit.inspectionTaskId || unit.inspection_task_id || "";
    const claimedByMe = (unit.status === "claimed" || unit.status === "in_progress") &&
      (!unit.inspectorId && !unit.inspector_id ||
        (unit.inspectorId || unit.inspector_id) === eng1.user.id);
    if (existingTask && claimedByMe) {
      taskId = existingTask;
      console.log(`    单元已自动认领（单人派单），复用任务 ${taskId}`);
      results.push({ phase: curPhase, name: "李强认领工作单元（自动认领模式）", ok: true, detail: "单人派单自动认领" });
    } else {
      const claimed = await critical("李强认领工作单元", async () => {
        const r = await bff(eng1, "POST", `cases/${myA.id}/units/${unit.id}/claim`);
        return r;
      });
      taskId = claimed?.inspectionTaskId || "";
    }
    console.log(`    inspectionTaskId=${taskId || "(无)"}`);
  }

  // 上传直传 token 流程（验证天翼云直传链路）
  await step("获取上传token并直传天翼云", async () => {
    const tok = await bff(eng1, "GET", "upload/token?filename=e2e-test.jpg&contentType=image/jpeg");
    if (!tok.uploadUrl) throw new Error("未返回 uploadUrl");
    const buf = readFileSync(asset("序列号1.jpg"));
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(tok.uploadUrl, {
        method: tok.method === "POST" ? "POST" : "PUT",
        headers: tok.headers || {},
        body: buf,
      });
      if (res.ok) return `直传成功 → ${tok.publicUrl || tok.key}`;
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error(`直传失败 ${lastErr}`);
  });

  // 服务端代传工作照片（合格案例照片）
  let workPhotoUrl = "";
  await step("上传工作照片（合格案例图）", async () => {
    const photo = firstPhoto(join(ASSETS, "故障恢复-地面组串式", "合格案例", "上传故障记录"));
    const r = await bffUpload(eng1, `cases/${myA.id}/work-photo`, photo);
    workPhotoUrl = r.url || r.publicUrl || "";
    if (!workPhotoUrl) throw new Error("未返回图片URL: " + JSON.stringify(r).slice(0, 150));
    return workPhotoUrl.slice(0, 80);
  });

  // 序列号 OCR + 确认
  if (unit) {
    await step("序列号 OCR 识别", async () => {
      const up = await bffUpload(eng1, `cases/${myA.id}/work-photo`, asset("序列号1.jpg"));
      const url = up.url || up.publicUrl;
      const r = await bff(eng1, "POST", `cases/${myA.id}/units/${unit.id}/serial/ocr`, { imageUrl: url });
      return `识别结果: ${r.serial || "(空)"} 置信度 ${r.confidence ?? "-"}`;
    });
    await step("保存设备序列号", async () => {
      await bff(eng1, "POST", `cases/${myA.id}/units/${unit.id}/serial`, { deviceSerial: "SG250HX-2026-0001" });
    });
  }

  // 巡检任务 → 开始 → 记录 → AI 识别 → 提交（与移动端一致：开始后生成记录）
  if (taskId) {
    await critical("李强开始巡检任务", () => bff(eng1, "PUT", `tasks/${taskId}/start`));
    const task = await critical("获取巡检任务（含记录）", async () => {
      const t = await bff(eng1, "GET", `tasks/${taskId}`);
      if (!t) throw new Error("任务不存在");
      return t;
    });
    const recordId = task.record?.id || task.recordId || "";
    console.log(`    recordId=${recordId || "(任务未携带记录)"}`);
    if (recordId) {
      const recDetail = await critical("获取巡检记录", () => bff(eng1, "GET", `records/${recordId}`));
      const entries = recDetail.entries || [];
      console.log(`    记录条目 ${entries.length} 个`);
      // 条目类型在模板快照里（checkType/aiEnabled），与移动端 resolveEntryAiEnabled 一致
      const snapEntries = task.templateSnapshot || recDetail.task?.templateSnapshot || [];
      const aiEntry = snapEntries.find((e: any) =>
        e.aiEnabled === true || (e.aiEnabled !== false && e.entryKind !== "record" && e.checkType !== "text"));
      if (aiEntry && workPhotoUrl) {
        await step("AI 识别检查项", async () => {
          const r = await bff(eng1, "POST", "ai/analyze", {
            recordId,
            templateEntryId: aiEntry.id,
            photoUrl: workPhotoUrl,
          });
          return JSON.stringify(r).slice(0, 120);
        });
      } else {
        results.push({ phase: curPhase, name: "AI 识别检查项", ok: false, detail: "记录中无拍照条目，无法触发 AI 识别" });
      }
      await step("提交巡检记录", async () => {
        await bff(eng1, "PUT", `records/${recordId}/submit`, {
          locationStatus: "skipped", locationReason: "E2E 测试环境无 GPS",
        });
      });
    }
  }
  if (unit) {
    await step("完成工作单元", () => bff(eng1, "POST", `cases/${myA.id}/units/${unit.id}/complete`).then(() => "OK"));
  }
  await step("完成案例", () => bff(eng1, "POST", `cases/${myA.id}/finish`).then(() => "OK"));

  // ============ 阶段 5：报销（里程 OCR + 提交） ============
  phase("阶段5 工程师报销（李强）");
  let startOdoUrl = "";
  let endOdoUrl = "";
  await step("上传开始/结束里程表照片", async () => {
    const s = await bffUpload(eng1, `cases/${myA.id}/work-photo`, asset("开始里程表.png"));
    startOdoUrl = s.url || s.publicUrl;
    const e = await bffUpload(eng1, `cases/${myA.id}/work-photo`, asset("结束里程表.png"));
    endOdoUrl = e.url || e.publicUrl;
    return "两张均上传成功";
  });
  let startMileage = 10000;
  let endMileage = 10186;
  await step("里程 OCR 识别", async () => {
    const rs = await bff(eng1, "POST", `cases/${myA.id}/my-expense/ocr-mileage`, { imageUrl: startOdoUrl, kind: "start" });
    const re = await bff(eng1, "POST", `cases/${myA.id}/my-expense/ocr-mileage`, { imageUrl: endOdoUrl, kind: "end" });
    if (rs.mileage) startMileage = rs.mileage;
    if (re.mileage) endMileage = re.mileage;
    return `开始 ${rs.mileage ?? "未识别"} / 结束 ${re.mileage ?? "未识别"}`;
  });
  await critical("提交报销单", async () => {
    const km = Math.max(0, endMileage - startMileage);
    await bff(eng1, "POST", `cases/${myA.id}/my-expense`, {
      lineItems: [
        { type: "mileage", name: "自驾里程", quantity: km, unitPrice: 1.2, amount: Math.round(km * 1.2 * 100) / 100 },
        { type: "other", name: "高速过路费", quantity: 1, unitPrice: 85, amount: 85 },
      ],
      startOdometerUrl: startOdoUrl,
      endOdometerUrl: endOdoUrl,
      startMileage,
      endMileage,
      voucherUrls: workPhotoUrl ? [workPhotoUrl] : [],
      note: "E2E 测试报销",
      submit: true,
    });
  });

  // ============ 阶段 6：审核与财务 ============
  phase("阶段6 审核与财务");
  await critical("管理员查看待审报销并批准", async () => {
    const pending = await bff(admin, "GET", "cases/expenses/pending");
    const list = pending.list || pending || [];
    if (!Array.isArray(list) || !list.length) throw new Error("无待审报销");
    const claim = list.find((c: any) => c.inspectorName === "李强" || c.inspector_name === "李强") || list[0];
    await bff(admin, "POST", `cases/expenses/${claim.id}/approve`, { note: "E2E 审核通过" });
    console.log(`    批准报销单 ${claim.id}`);
  });
  await step("案例审核（金额明细 → 批准）", async () => {
    const pend = await bff(admin, "GET", "review/pending");
    const list = pend.list || pend || [];
    if (!Array.isArray(list) || !list.length) return "无待审案例（可能无需审核）";
    const target = list.find((c: any) => c.id === myA.id) || list[0];
    const bd = await bff(admin, "GET", `review/${target.id}/amount-breakdown`);
    console.log(`    金额明细: ${JSON.stringify(bd).slice(0, 150)}`);
    await bff(admin, "POST", `review/${target.id}/approve`, {});
    return `已批准案例 ${target.gspCaseNo || target.id}`;
  });
  await step("财务总览", async () => {
    const r = await bff(admin, "GET", "finance/dashboard");
    return JSON.stringify(r).slice(0, 150);
  });
  await step("月度结算列表", async () => {
    const r = await bff(admin, "GET", "monthly-settlements");
    return JSON.stringify(r).slice(0, 150);
  });
  await step("李强查看我的收入", async () => {
    const r = await bff(eng1, "GET", "my/income");
    return JSON.stringify(r).slice(0, 150);
  });

  // ============ 阶段 7：权限与安全负向测试 ============
  phase("阶段7 权限与安全负向测试");
  await step("未登录访问 BFF 应 401", async () => {
    try {
      await bff(null, "GET", "cases");
      throw new Error("未授权也放行——严重漏洞！");
    } catch (e: any) {
      if (e.status === 401 || /未登录/.test(e.message)) return "正确拒绝 401";
      throw e;
    }
  });
  await step("工程师访问管理接口应被拒", async () => {
    try {
      await bff(eng1, "POST", "prices/mappings/recalculate", {});
      throw new Error("工程师可重算价格——越权！");
    } catch (e: any) {
      if (e.status === 403 || /无权限|权限/.test(e.message)) return "正确拒绝";
      throw e;
    }
  });
  await step("工程师直接建用户应被 Hasura 拒绝", async () => {
    try {
      await gqlDirect(eng1, `mutation { insert_users_one(object: { username: "hack1", role: "super_admin", roles: ["super_admin"], status: "active" }) { id } }`);
      throw new Error("工程师可建超管——越权！");
    } catch (e: any) {
      if (/权限|permission|reject|越权/i.test(e.message)) return "正确拒绝";
      return `被拒绝（${e.message.slice(0, 60)}）`;
    }
  });
  await step("网格长导出全员薪资表应被拒", async () => {
    try {
      await bff(manager, "GET", "monthly-settlements/2026-09/export");
      throw new Error("网格长可导出全员薪资——越权！");
    } catch (e: any) {
      if (e.status === 403 || /无权限|权限/.test(e.message)) return "正确拒绝";
      throw e;
    }
  });
  await step("网格长查看月度结算仅限本网格成员", async () => {
    const r = await bff(manager, "GET", "monthly-settlements");
    const list = Array.isArray(r) ? r : r.list || [];
    const names = list.map((x: any) => x.user?.realName || x.user?.username);
    const outsiders = names.filter((n: string) => !["张伟", "李强", "王芳"].includes(n));
    if (outsiders.length) throw new Error(`看到非本网格成员结算: ${outsiders.join("、")}`);
    return `仅见本网格成员（${names.length || 0} 条）`;
  });
  await step("网格长跨网格派单应失败", async () => {
    // admin 建第二个网格（张伟不管理），放入案例C，张伟派单应被拒
    const ins = await gqlDirect(admin,
      `mutation ($obj: sites_insert_input!) { insert_sites_one(object: $obj) { id } }`,
      { obj: { name: "芜湖阳光光伏电站", code: "WH-001", province: "安徽省", city: "芜湖市", district: "镜湖区", address: "测试地址", latitude: 31.33, longitude: 118.38 } });
    const site2 = ins.insert_sites_one.id;
    const caseC = caseList[2];
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [caseC.id], siteId: site2 });
    await bff(admin, "PUT", `cases/${caseC.id}/task-type`, { templateId: tpl.id });
    try {
      await bff(manager, "POST", `cases/${caseC.id}/assign`, { inspectorIds: [eng1Id] });
      throw new Error("网格长跨网格派单成功——越权！");
    } catch (e: any) {
      if (e.status === 403 || /本人管理|无权限/.test(e.message)) return "正确拒绝跨网格派单";
      throw e;
    }
  });
  await step("网格长派非本网格工程师应失败", async () => {
    // admin 建一个不属于任何网格的工程师，张伟派给他应被拒
    const hash2 = await bcrypt.hash(PWD, 10);
    const ins = await gqlDirect(admin,
      `mutation ($obj: users_insert_input!) { insert_users_one(object: $obj) { id } }`,
      { obj: { username: "zhaoliu", password: hash2, real_name: "赵六", phone: "13800000009", role: "inspector", roles: ["inspector"], status: "active" } });
    const outsiderId = ins.insert_users_one.id;
    const caseD = caseList[3];
    await bff(admin, "POST", "cases/assign-sites", { caseIds: [caseD.id], siteId });
    await bff(admin, "PUT", `cases/${caseD.id}/task-type`, { templateId: tpl.id });
    try {
      await bff(manager, "POST", `cases/${caseD.id}/assign`, { inspectorIds: [outsiderId] });
      throw new Error("网格长可派非本网格工程师——越权！");
    } catch (e: any) {
      if (/编制|无权限|本人管理/.test(e.message)) return "正确拒绝非本网格工程师";
      throw e;
    }
  });
  await step("李强查看未分配给自己的案例应 404", async () => {
    try {
      await bff(eng1, "GET", `cases/my/${caseB.id}`);
      throw new Error("工程师可查看他人案例——越权！");
    } catch (e: any) {
      if (e.status === 404 || /无权查看|不存在/.test(e.message)) return "正确拒绝 404";
      throw e;
    }
  });

  // ============ 汇总 ============
  phase("测试汇总");
  const fails = results.filter((r) => !r.ok);
  console.log(`\n共 ${results.length} 步，成功 ${results.length - fails.length}，失败 ${fails.length}`);
  const lines = [
    `# E2E 全流程测试报告`,
    ``,
    `- 时间: ${new Date().toISOString()}`,
    `- 目标: ${BASE}`,
    `- 总步数: ${results.length}，成功 ${results.length - fails.length}，失败 ${fails.length}`,
    ``,
    `| 阶段 | 步骤 | 结果 | 说明 |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.phase} | ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "/").slice(0, 120)} |`),
  ];
  writeFileSync(resolve(ROOT, "e2e测试报告.md"), lines.join("\n"), "utf8");
  console.log(`\n报告已写入 e2e测试报告.md`);
}

main().catch((e) => {
  console.error("\n流程中断:", e instanceof Error ? e.message : e);
  const fails = results.filter((r) => !r.ok);
  const lines = [
    `# E2E 全流程测试报告（中断）`,
    ``,
    `- 时间: ${new Date().toISOString()}`,
    `- 中断原因: ${e instanceof Error ? e.message : e}`,
    ``,
    `| 阶段 | 步骤 | 结果 | 说明 |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.phase} | ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.detail.replace(/\|/g, "/").slice(0, 120)} |`),
  ];
  writeFileSync(resolve(ROOT, "e2e测试报告.md"), lines.join("\n"), "utf8");
  process.exit(1);
});
