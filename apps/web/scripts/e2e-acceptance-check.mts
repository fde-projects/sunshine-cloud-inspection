/**
 * 本地验收清单自检（对应 e2e-ui验收报告.md「零、你怎么验」）
 * 用法：node apps/web/scripts/e2e-acceptance-check.mts
 * 环境：NEXT 已在 http://localhost:3000 运行，seed 账号可用
 */
const BASE = process.env.E2E_BASE || "http://localhost:3000";

async function login(username: string, password: string) {
  const j = await (
    await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
  ).json();
  if (!j.token) throw new Error(`login ${username} failed: ${JSON.stringify(j)}`);
  return j.token as string;
}

async function get(token: string, path: string) {
  const j = await (
    await fetch(`${BASE}/api/bff/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  if (j.code && j.code !== 200) throw new Error(`GET ${path}: ${j.message}`);
  return j.data;
}

type Check = { id: number; name: string; ok: boolean; detail: string };

async function main() {
  const admin = await login("admin", "admin123");
  const checks: Check[] = [];

  const monthly = (await get(admin, "monthly-settlements?month=2026-09")) as Array<{
    user?: { realName?: string };
    perfTotal?: string;
    finalAmount?: string;
    status?: string;
  }>;
  const expectMonthly: Record<string, { perf: string; final: string }> = {
    李强: { perf: "1714.68", final: "2274.68" },
    王芳: { perf: "971.37", final: "1431.37" },
    张伟: { perf: "0", final: "500" },
  };
  for (const [name, exp] of Object.entries(expectMonthly)) {
    const row = monthly.find((x) => x.user?.realName === name);
    const ok =
      !!row &&
      Number(row.finalAmount).toFixed(2) === Number(exp.final).toFixed(2) &&
      Number(row.perfTotal).toFixed(2) === Number(exp.perf).toFixed(2);
    checks.push({
      id: 1,
      name: `月结 ${name}`,
      ok,
      detail: `got perf=${row?.perfTotal} final=${row?.finalAmount} ${row?.status}`,
    });
  }

  const settled = (await get(admin, "cases?status=settled&limit=50")) as {
    list?: Array<{ gspCaseNo?: string; perfFinal?: string }>;
  };
  const nos = new Set((settled.list || []).map((c) => c.gspCaseNo));
  for (const no of ["RW2608030012", "RW2608030011", "RC2608030001"]) {
    checks.push({ id: 2, name: `已结算 ${no}`, ok: nos.has(no), detail: nos.has(no) ? "有" : "无" });
  }

  const dash = (await get(admin, "finance/dashboard")) as {
    summary?: { pendingPrice?: number };
  };
  checks.push({
    id: 3,
    name: "待定价",
    ok: Number(dash.summary?.pendingPrice || 0) === 0,
    detail: String(dash.summary?.pendingPrice),
  });

  const ot = (settled.list || []).find((c) => c.gspCaseNo === "OT2608030002");
  checks.push({
    id: 4,
    name: "OT 计件 0",
    ok: Number(ot?.perfFinal || 0) === 0,
    detail: String(ot?.perfFinal),
  });

  for (const [user, name, final, id] of [
    ["liqiang", "李强", "2274.68", 5],
    ["wangfang", "王芳", "1431.37", 6],
  ] as const) {
    const token = await login(user, "Test@2026");
    const income = (await get(token, "my/income?month=2026-09")) as {
      totalAmount?: string;
      list?: Array<{ gspCaseNo?: string; perfFinal?: string; isShared?: boolean; myShareRatio?: string }>;
    };
    const up = (income.list || []).find((x) => x.gspCaseNo === "UP2608030001");
    checks.push({
      id,
      name: `${name} 到手`,
      ok: Number(income.totalAmount).toFixed(2) === final,
      detail: String(income.totalAmount),
    });
    checks.push({
      id,
      name: `${name} UP 分摊`,
      ok: !!up && Number(up.perfFinal) === 579.15 && up.isShared === true,
      detail: up ? `${up.perfFinal} shared=${up.isShared} ratio=${up.myShareRatio}` : "MISSING",
    });
  }

  const assessments = (await get(admin, "assessments?month=2026-09")) as Array<{
    realName?: string;
    totalScore?: string;
    rankResult?: string;
    rewardAmount?: string;
  }>;
  for (const [name, score, rank] of [
    ["李强", "95", "优秀"],
    ["王芳", "60", "优秀"],
    ["张伟", "79", "优秀"],
  ] as const) {
    const row = assessments.find((x) => x.realName === name);
    checks.push({
      id: 7,
      name: `考核 ${name}`,
      ok: !!row && String(Number(row.totalScore)) === score && row.rankResult === rank,
      detail: `${row?.totalScore} ${row?.rankResult} reward=${row?.rewardAmount}`,
    });
  }

  const reviewList = (await get(admin, "cases?status=settle_review&limit=20")) as {
    list?: Array<{ gspCaseNo?: string; perfFinal?: string }>;
  };
  const rw10 = (reviewList.list || []).find((c) => c.gspCaseNo === "RW2608030010");
  checks.push({
    id: 8,
    name: "RW10 待审中间态",
    ok: !!rw10 && Number(rw10.perfFinal) > 0,
    detail: rw10 ? `perf=${rw10.perfFinal}` : "MISSING",
  });

  const engTok = await login("liqiang", "Test@2026");
  async function denied(path: string, method = "POST", body: Record<string, unknown> = {}) {
    const r = await fetch(`${BASE}/api/bff/${path}`, {
      method,
      headers: { Authorization: `Bearer ${engTok}`, "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    return r.status === 403 || j.code === 403;
  }
  for (const [name, path, method, body] of [
    ["工程师禁结算审核", "review/bd2f1073-3bf2-4c3a-bd9b-b6072eac8fe1/approve", "POST", {}],
    ["工程师禁报销审核", "cases/expenses/00000000-0000-0000-0000-000000000001/approve", "POST", {}],
    ["工程师禁分配网格", "cases/assign-sites", "POST", { caseIds: [], siteId: "2c7a3e0f-a90f-400e-aced-3a403ab2ff58" }],
    ["工程师禁改案例主数据", "cases/bd2f1073-3bf2-4c3a-bd9b-b6072eac8fe1/profile", "PATCH", { projectName: "x" }],
    ["工程师禁建服务类型", "templates", "POST", { name: "should-deny" }],
    ["工程师禁验图通过", "records/00000000-0000-0000-0000-000000000099/approve", "PUT", {}],
    ["工程师禁删任务", "tasks/00000000-0000-0000-0000-000000000099/remove", "PUT", {}],
  ] as const) {
    checks.push({
      id: 9,
      name,
      ok: await denied(path, method, body as Record<string, unknown>),
      detail: "expect 403",
    });
  }

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"} [${c.id}] ${c.name} | ${c.detail}`);
    if (!c.ok) failed += 1;
  }
  console.log(failed ? `\nFAILED ${failed}/${checks.length}` : `\nALL PASS (${checks.length}) · settled=${nos.size}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
