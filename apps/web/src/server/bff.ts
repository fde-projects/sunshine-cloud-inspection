import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { adminGql } from "@/lib/hasura-admin";
import { issueRoleSession, loginWithPassword, requireActiveRole } from "./auth-login";
import { analyzePhotos, draftRuleFromSamples, suggestPassViewLabels } from "@/lib/vision";
import { createUploadToken } from "@/lib/storage";
import { fail, HttpError, ok, parseBody, q, requireUser, type AppUser } from "./http";
import {
  CASE_FIELDS,
  caseWhere,
  loadCase,
  loadCaseDetail,
  mapCase,
  mapCaseDetail,
  mapHardRule,
  mapPoOrder,
  mapRecord,
  mapTask,
  mapTemplate,
  mapUser,
  PO_ITEM_FIELDS,
  PO_ORDER_FIELDS,
} from "./map";
import { getHardRuleDefault } from "./hard-rule-defaults";
import { composeHardRulePrompt, resolveHardRuleMatch } from "@/lib/hard-rule-prompt";
import {
  HARD_RULE_REVIEW_WINDOW_DAYS,
  normalizeHardRuleSamples,
  parseHardRuleBindings,
  parseHardRuleSamples,
  serializeHardRuleHint,
  takeLatestPhotos,
} from "@/lib/hard-rule-match";
import {
  accumulateHardRuleReviewStats,
  matchHardRuleCodes,
  stampHardRuleReview,
} from "@/lib/hard-rule-stats";
import { ensureOriginalCatalog } from "./catalog-seed";
import { rematchCasesForTemplate, syncBoundCaseNames } from "./finance/demand-type-match";
import {
  downloadTemplate,
  fileFromForm,
  importGsp,
  importPerfPrices,
  importPo,
  importSettlePrices,
} from "./finance/finance-import";
import {
  clearCases,
  clearPoOrders,
  clearPrices,
  exportFinanceCases,
  exportPoOrders,
  generateCasesFromPo,
  matchPoToCase,
  updatePo,
  xlsxResponse,
  assertFinanceClearAllowed,
} from "./finance/finance-ops";
import { getFinanceDashboard, getFinanceVariance } from "./finance/dashboard";
import { listPriceMappings, recalculate, recalculateLedgers, savePriceMapping } from "./finance/price-mapping";
import { DEFAULT_ASSESSMENT_SCORE_RULES } from "./finance/assessment-score-rule.catalog";
import { ASSESSMENT_EVENT_CATALOG } from "./finance/assessment-event.catalog";

type Handler = (args: {
  req: Request;
  user: AppUser | null;
  path: string;
  parts: string[];
  method: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}) => Promise<NextResponse>;

function need(user: AppUser | null): AppUser {
  if (!user) throw new HttpError(401, "未登录");
  return user;
}

function needAdmin(user: AppUser | null): AppUser {
  const u = need(user);
  if (u.role !== "super_admin") throw new HttpError(403, "仅管理员可操作");
  return u;
}

function needFinanceMgr(user: AppUser | null): AppUser {
  const u = need(user);
  if (u.role !== "super_admin" && u.role !== "site_manager") throw new HttpError(403, "无权限");
  return u;
}

function match(path: string, pattern: string) {
  const pp = pattern.split("/").filter(Boolean);
  const sp = path.split("/").filter(Boolean);
  if (pp.length !== sp.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(sp[i]);
    else if (pp[i] !== sp[i]) return null;
  }
  return params;
}

export async function handleBff(req: Request, path: string): Promise<NextResponse> {
  const method = req.method.toUpperCase();
  const query = q(req);
  let body: Record<string, unknown> = {};
  const ct = req.headers.get("content-type") || "";
  let form: FormData | null = null;
  if (method !== "GET" && method !== "DELETE") {
    if (ct.includes("multipart/form-data")) {
      form = await req.formData();
    } else {
      body = await parseBody(req);
    }
  }

  let user: AppUser | null = null;
  try {
    if (!(method === "POST" && path === "auth/login")) {
      user = await requireUser(req);
    }
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message, e.extra);
    throw e;
  }

  try {
    if (user) await ensureOriginalCatalog();
    return await dispatch({ req, user, path, parts: path.split("/").filter(Boolean), method, query, body, form });
  } catch (e) {
    if (e instanceof HttpError) return fail(e.status, e.message, e.extra);
    const msg = e instanceof Error ? e.message : "服务器错误";
    return fail(400, msg);
  }
}

async function dispatch(ctx: {
  req: Request;
  user: AppUser | null;
  path: string;
  parts: string[];
  method: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
  form: FormData | null;
}): Promise<NextResponse> {
  const { path, method, query, body, user, form } = ctx;

  if (method === "POST" && path === "auth/login") return login(body);
  if (method === "POST" && path === "auth/switch-portal") return switchPortal(need(user), body);
  if (method === "GET" && path === "auth/me") return ok(toPublicUser(need(user)));
  if (method === "POST" && path === "auth/logout") return ok({ success: true });
  if (method === "PUT" && path === "auth/profile") return updateProfile(need(user), body);
  if (method === "PUT" && path === "auth/change-password") return changePassword(need(user), body);

  if (method === "GET" && path === "geocode") {
    const url = new URL(ctx.req.url);
    url.pathname = "/api/geocode";
    const res = await fetch(url.toString(), { headers: { cookie: ctx.req.headers.get("cookie") || "" } });
    const json = await res.json();
    if (!res.ok) throw new HttpError(res.status, json.message || "地理编码失败");
    return ok(json);
  }
  if (method === "GET" && path === "geocode/regeo") {
    const url = new URL(ctx.req.url);
    url.pathname = "/api/geocode/regeo";
    const res = await fetch(url.toString());
    const json = await res.json();
    if (!res.ok) throw new HttpError(res.status, json.message || "逆地理失败");
    return ok(json);
  }
  if (method === "GET" && path === "upload/qiniu-token") {
    const u = need(user);
    const filename = String(query.get("filename") || "photo.jpg");
    const token = createUploadToken(filename, u.id);
    return ok({
      token: token.token,
      domain: process.env.QINIU_DOMAIN?.replace(/\/$/, "") || "",
      uploadUrl: token.uploadUrl,
      bucket: process.env.QINIU_BUCKET,
      key: token.key,
    });
  }
  if (method === "POST" && path === "upload/photo") return uploadPhoto(form, need(user));
  if (method === "POST" && path === "upload/location-check") return checkLocation(body);

  if (method === "GET" && path === "system/branding") return getBranding();
  if (method === "PUT" && path === "system/branding") return saveBranding(needAdmin(user), body);
  if (method === "GET" && path === "system/status") {
    return ok({
      overall: "healthy",
      checkedAt: new Date().toISOString(),
      services: [{ key: "hasura", name: "Hasura", status: "healthy", detail: "已连接" }],
      metrics: { aiFailures24h: 0, dataRetentionMonths: 12, monitoring: "ok" },
      support: {
        servicePeriod: "工作日",
        workdayResponseHours: 8,
        holidayMajorResponseHours: 24,
        scope: ["巡检", "结算"],
      },
    });
  }

  if (path === "templates" && method === "GET") return listTemplates(query);
  if (path === "templates" && method === "POST") return saveTemplate(null, body);
  {
    const m = match(path, "templates/:id");
    if (m && method === "PUT") return saveTemplate(m.id, body);
    if (m && method === "DELETE") {
      const used = await adminGql<{ service_cases_aggregate: { aggregate: { count: number } } }>(
        `query ($id: uuid!) {
          service_cases_aggregate(where: { task_template_id: { _eq: $id } }) { aggregate { count } }
        }`,
        { id: m.id },
      );
      const caseCount = used.service_cases_aggregate.aggregate.count;
      if (caseCount > 0) {
        throw new HttpError(
          400,
          `该服务类型已被 ${caseCount} 个案例引用，无法删除。请先在案例中改绑服务类型，或清空相关案例后再删。`,
        );
      }
      await adminGql(`mutation ($id: uuid!) { delete_inspection_templates_by_pk(id: $id) { id } }`, {
        id: m.id,
      });
      return ok({ success: true });
    }
  }
  {
    const m = match(path, "templates/:id/clone");
    if (m && method === "POST") return cloneTemplate(m.id, body);
  }

  if (path === "ai-hard-rules" && method === "GET") {
    const d = await adminGql<{ ai_hard_rules: Record<string, unknown>[] }>(
      `query { ai_hard_rules(order_by: { created_at: asc }) { id code name match_mode match_pattern prompt_text json_schema_hint enabled enforce_mode version change_note updated_by_id created_at updated_at } }`,
    );
    const stats = await loadHardRuleReviewStats(d.ai_hard_rules).catch(() => ({} as Record<string, never>));
    return ok(
      d.ai_hard_rules
        .map((row) => {
          const mapped = mapHardRule(row);
          return {
            ...mapped,
            reviewStats: stats[mapped.code] || {
              reviewed: 0,
              agreed: 0,
              windowDays: HARD_RULE_REVIEW_WINDOW_DAYS,
            },
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN")),
    );
  }
  if (path === "ai-hard-rules/catalog" && method === "GET") return hardRuleCatalog();
  if (path === "ai-hard-rules/preview" && method === "POST") {
    return previewHardRule(body, needAdmin(user));
  }
  if (path === "ai-hard-rules/draft" && method === "POST") {
    return draftHardRule(body, needAdmin(user));
  }
  if (path === "ai-hard-rules/label-samples" && method === "POST") {
    return labelPassSamples(body, needAdmin(user));
  }
  if (path === "ai-hard-rules" && method === "POST") return saveHardRule(null, body, needAdmin(user));
  {
    const reset = match(path, "ai-hard-rules/:code/reset");
    if (reset && method === "POST") {
      const def = getHardRuleDefault(reset.code);
      if (!def) throw new HttpError(404, "无此内置默认规则");
      return saveHardRule(
        reset.code,
        {
          name: def.name,
          matchMode: def.matchMode,
          matchPattern: def.matchPattern,
          promptText: def.promptText,
          jsonSchemaHint: def.jsonSchemaHint,
          enabled: true,
          enforceMode: def.enforceMode,
          changeNote: body.changeNote || "恢复内置默认硬规则",
          replaceContent: true,
        },
        needAdmin(user),
      );
    }
    const m = match(path, "ai-hard-rules/:code");
    if (m && method === "GET") {
      const d = await adminGql<{ ai_hard_rules: Record<string, unknown>[] }>(
        `query ($c: String!) { ai_hard_rules(where: { code: { _eq: $c } }) { id code name match_mode match_pattern prompt_text json_schema_hint enabled enforce_mode version change_note updated_by_id created_at updated_at } }`,
        { c: m.code },
      );
      if (!d.ai_hard_rules[0]) throw new HttpError(404, "规则不存在");
      return ok(mapHardRule(d.ai_hard_rules[0]));
    }
    if (m && method === "PUT") return saveHardRule(m.code, body, needAdmin(user));
    if (m && method === "DELETE") {
      needAdmin(user);
      await adminGql(`mutation ($c: String!) { delete_ai_hard_rules(where: { code: { _eq: $c } }) { affected_rows } }`, {
        c: m.code,
      });
      return ok({ ok: true, code: m.code });
    }
  }

  if (path === "dashboard/admin" || path === "dashboard/site") return dashboard(need(user));
  if (path === "stats/completion") return completionStats();
  if (path === "stats/defects") return defectStats();
  if (path === "stats/inspector/me") return inspectorSummary(need(user), query);

  if (path === "devices" && method === "GET") return listDevices(query);
  if (path === "devices" && method === "POST") return saveDevice(null, body);
  {
    const h = match(path, "devices/:id/history");
    if (h && method === "GET") return deviceHistory(h.id);
    const m = match(path, "devices/:id");
    if (m && method === "PUT") return saveDevice(m.id, body);
  }

  if (path === "cases" && method === "GET") return listCases(need(user), query);
  if (path === "cases/export" && method === "POST") {
    needAdmin(user);
    const file = await exportFinanceCases(body);
    return xlsxResponse(file.filename, file.buffer);
  }
  if (path === "cases/clear" && method === "DELETE") {
    needAdmin(user);
    return ok(await clearCases(query.get("confirm")));
  }
  if (path === "cases/location-options" && method === "GET") return locationOptions(need(user));
  if (path === "cases/my/list" && method === "GET") return myCases(need(user));
  {
    const m = match(path, "cases/my/:id");
    if (m && method === "GET") return myCase(need(user), m.id);
  }
  if (path === "cases/expenses/pending" && method === "GET") return pendingExpenses(query);
  {
    const m = match(path, "cases/expenses/:id/approve");
    if (m && method === "POST") return reviewExpense(m.id, true, body, need(user));
    const r = match(path, "cases/expenses/:id/reject");
    if (r && method === "POST") return reviewExpense(r.id, false, body, need(user));
  }
  if (path === "cases/assign-sites" && method === "POST") return assignSites(need(user), body);
  if (path === "cases/batch-create-tasks" && method === "POST") return batchCreateTasks(need(user), body);
  {
    const m = match(path, "cases/:id/inspectors");
    if (m && method === "GET") return caseInspectors(m.id);
    const a = match(path, "cases/:id/assign");
    if (a && method === "POST") return assignCase(need(user), a.id, body);
    const s = match(path, "cases/:id/site");
    if (s && method === "PUT") return setCaseSite(need(user), s.id, body);
    const t = match(path, "cases/:id/task-type");
    if (t && method === "PUT") return setCaseTaskType(need(user), t.id, body);
    const w = match(path, "cases/:id/work-plan");
    if (w && method === "PUT") return setWorkPlan(w.id, body);
    const p = match(path, "cases/:id/profile");
    if (p && method === "PATCH") return updateCaseProfile(p.id, body);
    const st = match(path, "cases/:id/start");
    if (st && method === "POST") return startMyCase(need(user), st.id);
    const fin = match(path, "cases/:id/finish");
    if (fin && method === "POST") return finishMyCase(need(user), fin.id);
    const wd = match(path, "cases/:id/assignees/:inspectorId/withdraw");
    if (wd && method === "POST") return withdrawAssignee(wd.id, wd.inspectorId);
    const cl = match(path, "cases/:id/units/:unitId/claim");
    if (cl && method === "POST") return claimUnit(need(user), cl.id, cl.unitId);
    const cu = match(path, "cases/:id/units/:unitId/complete");
    if (cu && method === "POST") return completeUnit(need(user), cu.id, cu.unitId);
    const ex = match(path, "cases/:id/my-expense");
    if (ex && method === "POST") return saveExpense(need(user), ex.id, null, body);
    const uex = match(path, "cases/:id/units/:unitId/expense");
    if (uex && method === "POST") return saveExpense(need(user), uex.id, uex.unitId, body);
    const ser = match(path, "cases/:id/units/:unitId/serial");
    if (ser && method === "POST") return saveSerial(ser.unitId, body);
    const c1 = match(path, "cases/:id");
    if (c1 && method === "GET") {
      const row = await loadCaseDetail(c1.id);
      if (!row) throw new HttpError(404, "案例不存在");
      const linked = (row.po_orders as unknown[]) || [];
      if (!linked.length) await recalculateLedgers([c1.id]);
      return ok(mapCaseDetail(row, need(user)));
    }
  }

  if (path === "tasks" && method === "GET") return listTasks(need(user), query);
  if (path === "tasks" && method === "POST") return createTask(need(user), body);
  {
    const m = match(path, "tasks/:id");
    if (m && method === "GET") return getTask(m.id);
    if (m && method === "PUT") return updateTask(m.id, body);
    const st = match(path, "tasks/:id/start");
    if (st && method === "PUT") return startTask(need(user), st.id);
    const rm = match(path, "tasks/:id/remove");
    if (rm && method === "PUT") return removeTask(rm.id);
  }

  if (path === "records" && method === "GET") return listRecords(query);
  if (path === "records/case-groups" && method === "GET") return recordCaseGroups(query);
  {
    const m = match(path, "records/by-case/:groupKey");
    if (m && method === "GET") return recordsByCase(m.groupKey);
    const d = match(path, "records/:id");
    if (d && method === "GET") return getRecord(d.id);
    const dr = match(path, "records/:id/draft");
    if (dr && method === "PUT") return saveDraft(dr.id, body);
    const sub = match(path, "records/:id/submit");
    if (sub && method === "PUT") return submitRecord(need(user), sub.id, body);
    const ap = match(path, "records/:id/approve");
    if (ap && method === "PUT") return approveRecord(need(user), ap.id);
    const rj = match(path, "records/:id/reject");
    if (rj && method === "PUT") return rejectRecord(need(user), rj.id, body);
    const man = match(path, "records/:id/entries/:entryId/manual-result");
    if (man && method === "PUT") return setManualResult(man.id, man.entryId, body);
  }
  if (path === "ai/analyze" && method === "POST") return runAnalyze(body);
  {
    const m = match(path, "ai/result/:entryId");
    if (m && method === "GET") return aiResult(m.entryId, query.get("recordId"));
  }
  if (path === "records/check-location" && method === "POST") return checkLocation(body);

  if (path === "po-orders" && method === "GET") return listPo(query);
  if (path === "po-orders/export" && method === "POST") {
    needAdmin(user);
    const file = await exportPoOrders(body);
    return xlsxResponse(file.filename, file.buffer);
  }
  if (path === "po-orders/clear" && method === "DELETE") {
    needAdmin(user);
    return ok(await clearPoOrders(query.get("confirm")));
  }
  if (path === "po-orders/generate-cases" && method === "POST") {
    needAdmin(user);
    return ok(await generateCasesFromPo());
  }
  {
    const m = match(path, "po-orders/:id");
    if (m && method === "PATCH") {
      needAdmin(user);
      return ok(await updatePo(m.id, body));
    }
    const mt = match(path, "po-orders/:id/match");
    if (mt && method === "POST") {
      needAdmin(user);
      return ok(await matchPoToCase(mt.id, String(body.gspCaseNo || "")));
    }
  }
  if (path === "prices/mappings" && method === "GET") {
    needAdmin(user);
    return ok(await listPriceMappings());
  }
  if (path === "prices/mappings" && method === "POST") {
    const u = needAdmin(user);
    return ok(await savePriceMapping(String(body.sourceItemName || ""), String(body.targetItemCode || ""), u.id));
  }
  if (path === "prices/mappings/recalculate" && method === "POST") {
    needAdmin(user);
    return ok(await recalculate());
  }
  if (path === "prices/import" && method === "POST") {
    const u = needAdmin(user);
    const file = await fileFromForm(form);
    return ok(
      await importSettlePrices(file, u.id, query.get("preview") === "true", {
        offset: query.get("offset") ? Number(query.get("offset")) : undefined,
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        batchId: query.get("batchId") || undefined,
        clientFilename: String(form?.get("originalFilename") || ""),
      }),
    );
  }
  if (path === "prices/import-perf" && method === "POST") {
    const u = needAdmin(user);
    const file = await fileFromForm(form);
    return ok(
      await importPerfPrices(file, u.id, query.get("preview") === "true", {
        offset: query.get("offset") ? Number(query.get("offset")) : undefined,
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        batchId: query.get("batchId") || undefined,
        clientFilename: String(form?.get("originalFilename") || ""),
      }),
    );
  }
  if (path === "prices/clear" && method === "DELETE") {
    needAdmin(user);
    return ok(await clearPrices(query.get("type"), query.get("confirm")));
  }
  if (path === "prices" && method === "GET") return listPrices(query);
  if (path === "prices" && method === "POST") return savePrice(needAdmin(user), null, body);
  {
    const m = match(path, "prices/:id");
    if (m && method === "PUT") return savePrice(needAdmin(user), m.id, body);
    if (m && method === "DELETE") {
      needAdmin(user);
      await adminGql(`mutation ($id: uuid!) { delete_price_library_by_pk(id: $id) { id } }`, { id: m.id });
      const applied = await recalculate().catch(() => null);
      return ok({ id: m.id, deleted: true, applied });
    }
  }

  if (path === "review/pending" && method === "GET") return pendingReviews(query);
  {
    const m = match(path, "review/:id/amount-breakdown");
    if (m && method === "GET") return amountBreakdown(m.id);
    const ap = match(path, "review/:id/approve");
    if (ap && method === "POST") return reviewApprove(need(user), ap.id, body, true);
    const rj = match(path, "review/:id/reject");
    if (rj && method === "POST") return reviewApprove(need(user), rj.id, body, false);
  }

  if (path === "finance/dashboard" && method === "GET") {
    return ok(await getFinanceDashboard(need(user), query));
  }
  if (path === "finance/dashboard/variance" && method === "GET") {
    return ok(await getFinanceVariance(need(user), query));
  }

  if (path === "assessments" && method === "GET") return listAssessments(query);
  if (path === "assessments" && method === "POST") return saveAssessment(body);
  if (path === "assessments/score-rule" && method === "GET") return scoreRule();
  if (path === "assessments/score-rule" && method === "POST") return saveScoreRule(needAdmin(user), body);
  if (path === "assessments/score" && method === "POST") return saveAssessmentScore(need(user), body);
  if (path === "assessments/clear" && method === "DELETE") {
    needAdmin(user);
    assertFinanceClearAllowed(query.get("confirm"));
    const n = await adminGql<{ assessments_aggregate: { aggregate: { count: number } } }>(
      `query { assessments_aggregate { aggregate { count } } }`,
    );
    await adminGql(`mutation { delete_assessments(where: {}) { affected_rows } }`);
    return ok({ deleted: n.assessments_aggregate.aggregate.count });
  }
  if (path === "assessments/event-catalog" && method === "GET") return eventCatalog();
  if (path === "assessments/events" && method === "GET") return listEvents(query);
  if (path === "assessments/events" && method === "POST") return createEvent(need(user), body);
  {
    const m = match(path, "assessments/events/:id");
    if (m && method === "DELETE") {
      await adminGql(`mutation ($id: uuid!) { delete_assessment_events_by_pk(id: $id) { id } }`, { id: m.id });
      return ok({ id: m.id });
    }
    const rk = match(path, "assessments/:month/rank");
    if (rk && method === "POST") return rankAssessments(rk.month, body);
  }

  if (path === "monthly-settlements" && method === "GET") return listMonthly(query);
  {
    const exp = match(path, "monthly-settlements/:month/export");
    if (exp && method === "GET") {
      needFinanceMgr(user);
      return exportMonthly(exp.month, query.get("template") || "reconcile");
    }
    const m = match(path, "monthly-settlements/:month/lock");
    if (m && method === "POST") return lockMonth(m.month, true);
    const u = match(path, "monthly-settlements/:month/unlock");
    if (u && method === "POST") return lockMonth(u.month, false);
    const c = match(path, "monthly-settlements/:month/correct");
    if (c && method === "POST") return correctMonthly(c.month, body);
  }

  if (path === "my/income" && method === "GET") return myIncome(need(user), query);

  {
    const tpl = match(path, "import/templates/:kind");
    if (tpl && method === "GET") {
      needFinanceMgr(user);
      const file = await downloadTemplate(tpl.kind);
      return xlsxResponse(file.filename, Buffer.from(file.buffer));
    }
  }
  if (path === "import/gsp-cases" && method === "POST") {
    const u = needFinanceMgr(user);
    const file = await fileFromForm(form);
    return ok(
      await importGsp(file, u.id, query.get("preview") === "true", {
        clientFilename: String(form?.get("originalFilename") || ""),
      }),
    );
  }
  if (path === "import/po-orders" && method === "POST") {
    const u = needAdmin(user);
    const file = await fileFromForm(form);
    return ok(
      await importPo(file, u.id, query.get("preview") === "true", {
        offset: query.get("offset") ? Number(query.get("offset")) : undefined,
        limit: query.get("limit") ? Number(query.get("limit")) : undefined,
        batchId: query.get("batchId") || undefined,
        clientFilename: String(form?.get("originalFilename") || ""),
      }),
    );
  }

  throw new HttpError(404, `接口不存在: ${method} /${path}`);
}

function defaultBranding() {
  return {
    systemName: "阳光运维系统",
    subtitle: "阳光运维平台",
    logoUrl: null as string | null,
    updatedAt: null as string | null,
  };
}

function mapBranding(value: unknown, updatedAt?: string | null) {
  const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const fallback = defaultBranding();
  return {
    systemName: String(row.systemName || fallback.systemName).trim() || fallback.systemName,
    subtitle: (row.subtitle as string) ?? fallback.subtitle,
    logoUrl: (row.logoUrl as string) || null,
    updatedAt: updatedAt ?? (row.updatedAt as string) ?? null,
  };
}

async function getBranding() {
  try {
    const data = await adminGql<{
      app_settings_by_pk: { value: unknown; updated_at: string } | null;
    }>(`query { app_settings_by_pk(key: "branding") { value updated_at } }`);
    if (!data.app_settings_by_pk) return ok(defaultBranding());
    return ok(mapBranding(data.app_settings_by_pk.value, data.app_settings_by_pk.updated_at));
  } catch {
    return ok(defaultBranding());
  }
}

async function saveBranding(_user: AppUser, body: Record<string, unknown>) {
  const next = mapBranding({
    systemName: body.systemName,
    subtitle: body.subtitle,
    logoUrl: body.logoUrl,
  });
  await adminGql(
    `mutation ($obj: app_settings_insert_input!) {
      insert_app_settings_one(
        object: $obj
        on_conflict: { constraint: app_settings_pkey, update_columns: [value, updated_at] }
      ) { key updated_at }
    }`,
    { obj: { key: "branding", value: next, updated_at: new Date().toISOString() } },
  );
  return ok({ ...next, updatedAt: new Date().toISOString() });
}

function toPublicUser(u: AppUser) {
  return {
    id: u.id,
    username: u.username,
    realName: u.realName,
    phone: u.phone,
    email: u.email,
    avatar: u.avatar,
    role: u.role,
    roles: u.roles,
    status: u.status,
    region: u.region,
    orgUnit: u.orgUnit,
  };
}

async function login(body: Record<string, unknown>) {
  const session = await loginWithPassword(
    String(body.username || "").trim(),
    String(body.password || ""),
    body.portal ?? body.role ?? body.client,
  );
  return ok({
    accessToken: session.token,
    refreshToken: session.token,
    user: session.user,
    needsRolePick: session.needsRolePick,
  });
}

async function switchPortal(user: AppUser, body: Record<string, unknown>) {
  const activeRole = requireActiveRole(body, user.roles);
  const session = await issueRoleSession({
    id: user.id,
    username: user.username,
    realName: user.realName,
    phone: user.phone,
    status: user.status,
    role: user.role,
    roles: user.roles,
    activeRole,
  });
  return ok({
    accessToken: session.token,
    refreshToken: session.token,
    user: session.user,
    needsRolePick: session.needsRolePick,
  });
}

async function updateProfile(user: AppUser, body: Record<string, unknown>) {
  const d = await adminGql<{ update_users_by_pk: Record<string, unknown> }>(
    `mutation ($id: uuid!, $set: users_set_input!) {
      update_users_by_pk(pk_columns: { id: $id }, _set: $set) {
        id username real_name phone email avatar role roles status region org_unit created_at
      }
    }`,
    {
      id: user.id,
      set: {
        real_name: body.realName ?? undefined,
        phone: body.phone ?? undefined,
        email: body.email ?? undefined,
        region: body.region ?? undefined,
        avatar: body.avatar ?? undefined,
      },
    },
  );
  return ok(mapUser(d.update_users_by_pk));
}

async function changePassword(user: AppUser, body: Record<string, unknown>) {
  const oldPassword = String(body.oldPassword || "");
  const newPassword = String(body.newPassword || "");
  if (newPassword.length < 4) throw new HttpError(400, "新密码太短");
  const d = await adminGql<{ users_by_pk: { password: string } | null }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { password } }`,
    { id: user.id },
  );
  if (!d.users_by_pk) throw new HttpError(404, "用户不存在");
  const okOld = await bcrypt.compare(oldPassword, d.users_by_pk.password);
  if (!okOld) throw new HttpError(400, "原密码不正确");
  const hash = await bcrypt.hash(newPassword, 10);
  await adminGql(`mutation ($id: uuid!, $password: String!) {
    update_users_by_pk(pk_columns: { id: $id }, _set: { password: $password }) { id }
  }`, { id: user.id, password: hash });
  return ok({ success: true });
}

async function listTemplates(query: URLSearchParams) {
  const where: Record<string, unknown> = {};
  if (query.get("deviceType")) where.device_type = { _eq: query.get("deviceType") };
  if (query.get("keyword")) where.name = { _ilike: `%${query.get("keyword")}%` };
  const d = await adminGql<{ inspection_templates: Record<string, unknown>[] }>(
    `query ($where: inspection_templates_bool_exp) {
      inspection_templates(where: $where, order_by: { created_at: desc }) {
        id name device_type entries product_lines is_global site_id assign_mode unit_label expense_enabled_default version created_at
      }
    }`,
    { where },
  );
  return ok(d.inspection_templates.map(mapTemplate));
}

const TEMPLATE_RETURNING = `
  id name device_type entries product_lines is_global site_id assign_mode unit_label expense_enabled_default version created_at
`;

function checklistFingerprint(productLines: unknown, entries: unknown) {
  return JSON.stringify({ productLines: productLines ?? [], entries: entries ?? [] });
}

async function assertTemplateNameFree(name: string, exceptId?: string | null) {
  const where: Record<string, unknown> = { name: { _eq: name } };
  if (exceptId) where.id = { _neq: exceptId };
  const d = await adminGql<{ inspection_templates: Array<{ id: string }> }>(
    `query ($where: inspection_templates_bool_exp) {
      inspection_templates(where: $where, limit: 1) { id }
    }`,
    { where },
  );
  if (d.inspection_templates[0]) throw new HttpError(400, `服务类型「${name}」已存在`);
}

async function saveTemplate(id: string | null, body: Record<string, unknown>) {
  const name = String(body.name || "").trim();
  if (!name) throw new HttpError(400, "服务类型名称不能为空");
  const isGlobal = body.isGlobal ?? body.is_global ?? true;
  const obj = {
    name,
    device_type: body.deviceType || body.device_type || "string_inverter",
    entries: body.entries ?? [],
    product_lines: body.productLines ?? body.product_lines ?? [],
    is_global: isGlobal,
    site_id: body.siteId ?? body.site_id ?? null,
    assign_mode: body.assignMode === "multi" || body.assign_mode === "multi" ? "multi" : "single",
    unit_label: "台",
    expense_enabled_default: !!(body.expenseEnabledDefault ?? body.expense_enabled_default),
  };
  if (!id) {
    await assertTemplateNameFree(name);
    const d = await adminGql<{ insert_inspection_templates_one: Record<string, unknown> }>(
      `mutation ($obj: inspection_templates_insert_input!) {
        insert_inspection_templates_one(object: $obj) { ${TEMPLATE_RETURNING} }
      }`,
      { obj },
    );
    const saved = d.insert_inspection_templates_one;
    const rematched = obj.is_global
      ? await rematchCasesForTemplate({ id: String(saved.id), name })
      : 0;
    return ok({ ...mapTemplate(saved), rematchedCases: rematched });
  }
  const prev = await adminGql<{ inspection_templates_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { inspection_templates_by_pk(id: $id) { ${TEMPLATE_RETURNING} } }`,
    { id },
  );
  const current = prev.inspection_templates_by_pk;
  if (!current) throw new HttpError(404, "模板不存在");
  await assertTemplateNameFree(name, id);
  const oldTypeName = String(current.name || "").trim();
  const oldLines = Array.isArray(current.product_lines)
    ? (current.product_lines as Array<{ id?: string; name?: string }>)
    : [];
  const nextLines = Array.isArray(obj.product_lines)
    ? (obj.product_lines as Array<{ id?: string; name?: string }>)
    : [];
  const oldLineById = new Map(
    oldLines.filter((p) => p?.id).map((p) => [String(p.id), String(p.name || "").trim()] as const),
  );
  const versionChanged =
    checklistFingerprint(current.product_lines, current.entries) !==
    checklistFingerprint(obj.product_lines, obj.entries);
  const d = await adminGql<{ update_inspection_templates_by_pk: Record<string, unknown> }>(
    `mutation ($id: uuid!, $set: inspection_templates_set_input!) {
      update_inspection_templates_by_pk(pk_columns: { id: $id }, _set: $set) { ${TEMPLATE_RETURNING} }
    }`,
    {
      id,
      set: {
        ...obj,
        version: versionChanged ? Number(current.version || 1) + 1 : current.version,
      },
    },
  );
  const saved = d.update_inspection_templates_by_pk;
  const lineRenames: Array<{ from: string; to: string }> = [];
  for (const line of nextLines) {
    const idKey = String(line.id || "");
    const next = String(line.name || "").trim();
    const prevName = oldLineById.get(idKey) || "";
    if (idKey && prevName && next && prevName !== next) {
      lineRenames.push({ from: prevName, to: next });
    }
  }
  const syncedCases = await syncBoundCaseNames(id, {
    oldTypeName,
    newTypeName: name,
    lineRenames,
  });
  const rematched = obj.is_global ? await rematchCasesForTemplate({ id, name }) : 0;
  return ok({
    ...mapTemplate(saved),
    versionChanged,
    rematchedCases: rematched,
    syncedCases,
  });
}

async function cloneTemplate(id: string, body: Record<string, unknown>) {
  const d = await adminGql<{ inspection_templates_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { inspection_templates_by_pk(id: $id) { name device_type entries product_lines assign_mode unit_label expense_enabled_default } }`,
    { id },
  );
  const src = d.inspection_templates_by_pk;
  if (!src) throw new HttpError(404, "模板不存在");
  const baseName = `${src.name}（网格副本）`;
  let cloneName = baseName;
  for (let i = 2; i <= 50; i += 1) {
    try {
      await assertTemplateNameFree(cloneName);
      break;
    } catch {
      cloneName = `${baseName}${i}`;
      if (i === 50) throw new HttpError(400, "无法生成不重名的网格副本名称");
    }
  }
  return saveTemplate(null, {
    ...src,
    name: cloneName,
    siteId: body.siteId,
    isGlobal: false,
    deviceType: src.device_type,
    productLines: src.product_lines,
    assignMode: src.assign_mode,
    unitLabel: src.unit_label,
    expenseEnabledDefault: src.expense_enabled_default,
    entries: src.entries,
  });
}

const HARD_RULE_RETURNING =
  "id code name match_mode match_pattern prompt_text json_schema_hint enabled enforce_mode version change_note updated_by_id created_at updated_at";

function collectTemplateEntries(
  templates: Array<{
    id?: string;
    name?: string;
    entries?: unknown;
    product_lines?: unknown;
  }>,
) {
  const items: Array<{
    key: string;
    templateId: string;
    templateName: string;
    productLineId: string;
    productLineName: string;
    entryId: string;
    entryName: string;
    description: string;
    samplePhotos: string[];
  }> = [];
  const push = (
    tplId: string,
    tplName: string,
    lineId: string,
    lineName: string,
    raw: unknown,
  ) => {
    const item = (raw || {}) as { id?: string; name?: string; description?: string; samplePhotos?: unknown };
    const entryName = String(item.name || "").trim();
    if (!entryName) return;
    const entryId = String(item.id || `${tplId}:${lineId}:${entryName}`).trim();
    items.push({
      key: `${tplId}:${entryId}`,
      templateId: tplId,
      templateName: tplName,
      productLineId: lineId,
      productLineName: lineName,
      entryId,
      entryName,
      description: String(item.description || ""),
      samplePhotos: Array.isArray(item.samplePhotos)
        ? item.samplePhotos.map((url) => String(url || "").trim()).filter(Boolean)
        : [],
    });
  };
  for (const tpl of templates) {
    const tplId = String(tpl.id || "").trim();
    const tplName = String(tpl.name || "").trim() || "未命名服务类型";
    if (!tplId) continue;
    const lines = Array.isArray(tpl.product_lines) ? tpl.product_lines : [];
    if (lines.length) {
      for (const line of lines) {
        const row = (line || {}) as { id?: string; name?: string; entries?: unknown };
        const lineId = String(row.id || "").trim();
        const lineName = String(row.name || "").trim();
        for (const entry of Array.isArray(row.entries) ? row.entries : []) {
          push(tplId, tplName, lineId, lineName, entry);
        }
      }
    }
    for (const entry of Array.isArray(tpl.entries) ? tpl.entries : []) {
      push(tplId, tplName, "", "", entry);
    }
  }
  return items.sort((a, b) => {
    const left = `${a.templateName}${a.productLineName}${a.entryName}`;
    const right = `${b.templateName}${b.productLineName}${b.entryName}`;
    return left.localeCompare(right, "zh-CN");
  });
}

async function hardRuleCatalog() {
  const d = await adminGql<{
    inspection_templates: Array<{ id: string; name: string; entries: unknown; product_lines: unknown }>;
  }>(`query {
    inspection_templates(limit: 500) {
      id name entries product_lines
    }
  }`);
  return ok({ items: collectTemplateEntries(d.inspection_templates || []) });
}

function resolveCustomPromptText(body: Record<string, unknown>, fallbackName: string) {
  const pass = String(body.passCriteria || "").trim();
  const fail = String(body.failCriteria || "").trim();
  const override = String(body.promptText || "").trim();
  if (pass || fail) {
    return composeHardRulePrompt({
      name: String(body.name || fallbackName || "").trim(),
      passCriteria: pass,
      failCriteria: fail,
      enforceMode: String(body.enforceMode || "strict"),
    });
  }
  if (override) return override;
  throw new HttpError(400, "请填写合格标准或不合格标准");
}

async function previewHardRule(body: Record<string, unknown>, _user: AppUser) {
  const photos = Array.isArray(body.photoUrls) ? body.photoUrls.map((x) => String(x || "")).filter(Boolean) : [];
  if (!photos.length) throw new HttpError(400, "请先上传试跑照片");
  const title = String(body.title || body.name || "").trim() || "检查项";
  const promptText = (() => {
    try {
      return resolveCustomPromptText(body, title);
    } catch {
      return String(body.promptText || "").trim();
    }
  })();
  if (!promptText) throw new HttpError(400, "请先填写合格/不合格标准");
  const samples = normalizeHardRuleSamples({
    pass: body.passSampleViews ?? body.passSampleUrls ?? (body.samples as { pass?: unknown } | undefined)?.pass,
    fail: body.failSampleUrls ?? (body.samples as { fail?: unknown } | undefined)?.fail,
  });
  const result = await analyzePhotos({
    title,
    description: String(body.description || ""),
    photoUrls: takeLatestPhotos(photos),
    ruleOverride: {
      name: String(body.name || title),
      promptText,
      enforceMode: String(body.enforceMode || "strict"),
      samplePassViews: samples.pass,
      sampleFailUrls: samples.fail,
    },
  });
  return ok(result);
}

async function labelPassSamples(body: Record<string, unknown>, _user: AppUser) {
  const samples = normalizeHardRuleSamples({
    pass: body.views ?? body.passSampleViews ?? body.passSampleUrls ?? (body.samples as { pass?: unknown } | undefined)?.pass,
  });
  if (!samples.pass.length) throw new HttpError(400, "请先上传合格样");
  const titled = String(body.title || body.name || "").trim() || "检查项";
  const result = await suggestPassViewLabels({ title: titled, views: samples.pass });
  return ok(result);
}

async function draftHardRule(body: Record<string, unknown>, _user: AppUser) {
  const passPhotoUrls = Array.isArray(body.passPhotoUrls)
    ? body.passPhotoUrls.map((x) => String(x || "")).filter(Boolean)
    : [];
  const failPhotoUrls = Array.isArray(body.failPhotoUrls)
    ? body.failPhotoUrls.map((x) => String(x || "")).filter(Boolean)
    : [];
  if (!passPhotoUrls.length && !failPhotoUrls.length) {
    throw new HttpError(400, "请至少上传一张合格或不合格样张");
  }
  try {
    const drafted = await draftRuleFromSamples({
      name: String(body.name || "").trim() || "检查项",
      title: String(body.title || body.name || "").trim() || "检查项",
      description: String(body.description || ""),
      passPhotoUrls,
      failPhotoUrls,
      failNote: String(body.failNote || "").trim(),
    });
    return ok({ ...drafted, draft: true });
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : "生成草稿失败");
  }
}

async function saveHardRule(code: string | null, body: Record<string, unknown>, user: AppUser) {
  const existing = code
    ? (
        await adminGql<{ ai_hard_rules: Record<string, unknown>[] }>(
          `query ($c: String!) { ai_hard_rules(where: { code: { _eq: $c } }, limit: 1) { ${HARD_RULE_RETURNING} } }`,
          { c: code },
        )
      ).ai_hard_rules[0]
    : null;
  if (code && !existing) throw new HttpError(404, "规则不存在");

  const replaceContent = body.replaceContent === true;

  let matchMode = String(existing?.match_mode || "title_includes");
  let matchPattern = String(existing?.match_pattern || "");
  let promptText = String(existing?.prompt_text || "");
  let jsonSchemaHint = (existing?.json_schema_hint as string | null | undefined) ?? null;
  const hasSampleFields =
    body.passSampleUrls !== undefined ||
    body.passSampleViews !== undefined ||
    body.failSampleUrls !== undefined ||
    body.samples !== undefined;
  const incomingSamples = hasSampleFields
    ? normalizeHardRuleSamples({
        pass:
          body.passSampleViews ??
          body.passSampleUrls ??
          (body.samples as { pass?: unknown } | undefined)?.pass,
        fail: body.failSampleUrls ?? (body.samples as { fail?: unknown } | undefined)?.fail,
      })
    : parseHardRuleSamples({ jsonSchemaHint });

  try {
    const resolved = resolveHardRuleMatch({ ...body, samples: incomingSamples });
    matchMode = resolved.matchMode;
    matchPattern = resolved.matchPattern;
    jsonSchemaHint = resolved.jsonSchemaHint;
  } catch (e) {
    if (!code) throw new HttpError(400, e instanceof Error ? e.message : "请选择要套用的检查项");
    if (body.matchPattern) {
      matchMode = String(body.matchMode || matchMode || "title_includes");
      matchPattern = String(body.matchPattern);
    }
    if (hasSampleFields) {
      jsonSchemaHint = serializeHardRuleHint({
        bindings: parseHardRuleBindings({ jsonSchemaHint }),
        samples: incomingSamples,
      });
    }
  }

  if (replaceContent) {
    promptText = String(body.promptText || promptText);
    jsonSchemaHint = (body.jsonSchemaHint as string | null | undefined) ?? jsonSchemaHint;
    if (body.matchPattern) matchPattern = String(body.matchPattern);
    if (body.matchMode) matchMode = String(body.matchMode);
  } else {
    promptText = resolveCustomPromptText(body, String(body.name || existing?.name || ""));
    if (body.jsonSchemaHint !== undefined && !Array.isArray(body.bindings)) {
      jsonSchemaHint = (body.jsonSchemaHint as string | null) || null;
    }
  }

  const obj = {
    name: body.name || existing?.name,
    match_mode: matchMode,
    match_pattern: matchPattern,
    prompt_text: promptText,
    json_schema_hint: jsonSchemaHint,
    enabled: body.enabled ?? existing?.enabled ?? true,
    enforce_mode: body.enforceMode || existing?.enforce_mode || "strict",
    change_note: body.changeNote || (code ? "更新硬规则" : "新建自定义硬规则"),
    updated_by_id: user.id,
  };

  if (!code) {
    const c = `rule_${Date.now().toString(36)}`;
    const d = await adminGql<{ insert_ai_hard_rules_one: Record<string, unknown> }>(
      `mutation ($obj: ai_hard_rules_insert_input!) { insert_ai_hard_rules_one(object: $obj) { ${HARD_RULE_RETURNING} } }`,
      { obj: { ...obj, code: c, version: 1 } },
    );
    return ok(mapHardRule(d.insert_ai_hard_rules_one));
  }

  const d = await adminGql<{ update_ai_hard_rules: { returning: Record<string, unknown>[] } }>(
    `mutation ($c: String!, $set: ai_hard_rules_set_input!) {
      update_ai_hard_rules(where: { code: { _eq: $c } }, _set: $set) {
        returning { ${HARD_RULE_RETURNING} }
      }
    }`,
    {
      c: code,
      set: {
        ...obj,
        version: Number(existing?.version || 1) + 1,
      },
    },
  );
  return ok(mapHardRule(d.update_ai_hard_rules.returning[0]));
}

async function dashboard(user: AppUser) {
  const siteFilter =
    user.role === "site_manager" && user.managedSiteIds.length
      ? { site_id: { _in: user.managedSiteIds } }
      : {};
  const d = await adminGql<{
    sites_aggregate: { aggregate: { count: number } };
    devices_aggregate: { aggregate: { count: number } };
    inspection_tasks: { status: string }[];
    inspection_records: { status: string; id: string; submitted_at?: string; device_type: string; task?: { task_name: string } }[];
    sites: Array<{ id: string; name: string; city: string; province: string; latitude: number; longitude: number; devices_aggregate: { aggregate: { count: number } } }>;
  }>(`query ($tw: inspection_tasks_bool_exp) {
    sites_aggregate(where: { deleted_at: { _is_null: true } }) { aggregate { count } }
    devices_aggregate { aggregate { count } }
    inspection_tasks(where: $tw) { status }
    inspection_records(where: { status: { _in: ["submitted","approved"] } }, order_by: { submitted_at: desc }, limit: 8) {
      id status submitted_at device_type
      task { task_name }
    }
    sites(where: { deleted_at: { _is_null: true } }, limit: 50) {
      id name city province latitude longitude
      devices_aggregate { aggregate { count } }
    }
  }`, { tw: siteFilter });
  const tasks = { total: 0, pending: 0, inProgress: 0, submitted: 0, approved: 0, rejected: 0 };
  for (const t of d.inspection_tasks) {
    tasks.total += 1;
    if (t.status === "pending") tasks.pending += 1;
    if (t.status === "in_progress") tasks.inProgress += 1;
    if (t.status === "submitted") tasks.submitted += 1;
    if (t.status === "approved") tasks.approved += 1;
    if (t.status === "rejected") tasks.rejected += 1;
  }
  const recs = d.inspection_records;
  return ok({
    sites: d.sites_aggregate.aggregate.count,
    devices: d.devices_aggregate.aggregate.count,
    tasks,
    records: {
      total: recs.length,
      submitted: recs.filter((r) => r.status === "submitted").length,
      approved: recs.filter((r) => r.status === "approved").length,
    },
    pendingAudit: recs.filter((r) => r.status === "submitted").length,
    recentPending: recs
      .filter((r) => r.status === "submitted")
      .map((r) => ({
        id: r.id,
        taskName: r.task?.task_name,
        deviceType: r.device_type,
        submittedAt: r.submitted_at,
      })),
    trend: [],
    siteMarkers: d.sites.map((s) => ({
      id: s.id,
      name: s.name,
      city: s.city,
      province: s.province,
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
      deviceCount: s.devices_aggregate.aggregate.count,
    })),
  });
}

async function completionStats() {
  const d = await adminGql<{ inspection_tasks: { status: string }[] }>(`query { inspection_tasks { status } }`);
  const total = d.inspection_tasks.length;
  const completed = d.inspection_tasks.filter((t) => t.status === "approved").length;
  const submitted = d.inspection_tasks.filter((t) => t.status === "submitted").length;
  const inProgress = d.inspection_tasks.filter((t) => t.status === "in_progress").length;
  return ok({
    totalTasks: total,
    completedTasks: completed,
    submittedTasks: submitted,
    inProgressTasks: inProgress,
    completionRate: total ? completed / total : 0,
    byDate: [],
    bySite: [],
  });
}

async function defectStats() {
  return ok({
    totalInspections: 0,
    totalEntries: 0,
    failCount: 0,
    failRate: 0,
    passRate: 1,
    byDate: [],
    bySite: [],
    byDeviceType: [],
    byEntry: [],
    inspectorRanking: [],
  });
}

async function inspectorSummary(user: AppUser, query: URLSearchParams) {
  const d = await adminGql<{
    inspection_tasks_aggregate: { aggregate: { count: number } };
    case_assignments_aggregate: { aggregate: { count: number } };
  }>(`query ($uid: uuid!) {
    inspection_tasks_aggregate(where: { inspector_id: { _eq: $uid } }) { aggregate { count } }
    case_assignments_aggregate(where: { inspector_id: { _eq: $uid }, status: { _neq: "withdrawn" } }) { aggregate { count } }
  }`, { uid: user.id });
  return ok({
    month: query.get("month") || new Date().toISOString().slice(0, 7),
    taskCount: d.inspection_tasks_aggregate.aggregate.count,
    caseCount: d.case_assignments_aggregate.aggregate.count,
  });
}

async function listDevices(query: URLSearchParams) {
  const page = Number(query.get("page") || 1);
  const limit = Number(query.get("limit") || 20);
  const where: Record<string, unknown> = {};
  if (query.get("siteId")) where.site_id = { _eq: query.get("siteId") };
  const d = await adminGql<{ devices: Record<string, unknown>[]; devices_aggregate: { aggregate: { count: number } } }>(
    `query ($where: devices_bool_exp!, $limit: Int!, $offset: Int!) {
      devices(where: $where, limit: $limit, offset: $offset, order_by: { created_at: desc }) {
        id site_id serial_number device_type model manufacturer install_date status created_at
        site { id name code }
      }
      devices_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return ok({
    list: d.devices.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      serialNumber: r.serial_number,
      deviceType: r.device_type,
      model: r.model,
      manufacturer: r.manufacturer,
      installDate: r.install_date,
      status: r.status,
      createdAt: r.created_at,
      site: r.site,
    })),
    total: d.devices_aggregate.aggregate.count,
    page,
    limit,
  });
}

async function deviceHistory(id: string) {
  const d = await adminGql<{
    devices_by_pk: Record<string, unknown> | null;
    inspection_tasks: Record<string, unknown>[];
  }>(
    `query ($id: uuid!) {
      devices_by_pk(id: $id) { id serial_number device_type model }
      inspection_tasks(where: { device_id: { _eq: $id } }, order_by: { created_at: desc }, limit: 50) {
        id task_name status completed_at created_at
        inspection_records { id task_id status submitted_at approved_at created_at }
      }
    }`,
    { id },
  );
  if (!d.devices_by_pk) throw new HttpError(404, "设备不存在");
  const recs = d.inspection_tasks.flatMap((t) => (t.inspection_records as Record<string, unknown>[]) || []);
  return ok({
    device: {
      id: d.devices_by_pk.id,
      serialNumber: d.devices_by_pk.serial_number,
      deviceType: d.devices_by_pk.device_type,
      model: d.devices_by_pk.model,
    },
    tasks: d.inspection_tasks.map((t) => ({
      id: t.id,
      taskName: t.task_name,
      status: t.status,
      completedAt: t.completed_at,
      createdAt: t.created_at,
    })),
    records: recs,
  });
}

async function saveDevice(id: string | null, body: Record<string, unknown>) {
  const obj = {
    site_id: body.siteId,
    serial_number: body.serialNumber,
    device_type: body.deviceType || "string_inverter",
    model: body.model,
    manufacturer: body.manufacturer,
    install_date: body.installDate || null,
    status: body.status || "active",
  };
  if (!id) {
    const d = await adminGql<{ insert_devices_one: Record<string, unknown> }>(
      `mutation ($obj: devices_insert_input!) { insert_devices_one(object: $obj) { id site_id serial_number device_type model manufacturer install_date status created_at } }`,
      { obj },
    );
    return ok(d.insert_devices_one);
  }
  const d = await adminGql<{ update_devices_by_pk: Record<string, unknown> }>(
    `mutation ($id: uuid!, $set: devices_set_input!) { update_devices_by_pk(pk_columns: { id: $id }, _set: $set) { id site_id serial_number device_type model manufacturer install_date status created_at } }`,
    { id, set: obj },
  );
  return ok(d.update_devices_by_pk);
}

async function listCases(user: AppUser, query: URLSearchParams) {
  const page = Number(query.get("page") || 1);
  const limit = Math.min(100, Number(query.get("limit") || 10));
  const where = caseWhere(user, query);
  const d = await adminGql<{
    service_cases: Record<string, unknown>[];
    service_cases_aggregate: { aggregate: { count: number } };
  }>(
    `query ($where: service_cases_bool_exp!, $limit: Int!, $offset: Int!) {
      service_cases(where: $where, limit: $limit, offset: $offset, order_by: { updated_at: desc }) {
        ${CASE_FIELDS}
      }
      service_cases_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return ok({
    list: d.service_cases.map(mapCase),
    total: d.service_cases_aggregate.aggregate.count,
    page,
    limit,
  });
}

async function locationOptions(user: AppUser) {
  const where =
    user.role === "site_manager"
      ? { site_id: { _in: user.managedSiteIds } }
      : {};
  const d = await adminGql<{ service_cases: { province: string; city: string }[] }>(
    `query ($where: service_cases_bool_exp!) { service_cases(where: $where) { province city } }`,
    { where },
  );
  const citiesByProvince: Record<string, string[]> = {};
  for (const r of d.service_cases) {
    const p = r.province || "";
    const c = r.city || "";
    if (!p) continue;
    citiesByProvince[p] = citiesByProvince[p] || [];
    if (c && !citiesByProvince[p].includes(c)) citiesByProvince[p].push(c);
  }
  return ok({ provinces: Object.keys(citiesByProvince), citiesByProvince });
}

async function myCases(user: AppUser) {
  const d = await adminGql<{ case_assignments: Array<{ service_case: Record<string, unknown> | null }> }>(
    `query ($uid: uuid!) {
      case_assignments(where: { inspector_id: { _eq: $uid }, status: { _neq: "withdrawn" } }) {
        service_case { ${CASE_FIELDS}
          case_work_units(order_by: { seq: asc }) {
            id seq title status inspector_id inspection_task_id device_serial
          }
        }
      }
    }`,
    { uid: user.id },
  );
  const list = d.case_assignments
    .map((a) => a.service_case)
    .filter(Boolean)
    .map((row) => {
      const mapped = mapCase(row as Record<string, unknown>);
      return {
        ...mapped,
        workUnits: (((row as { case_work_units?: unknown[] }).case_work_units || []) as Record<string, unknown>[]).map((u) => ({
          id: u.id,
          seq: u.seq,
          title: u.title,
          status: u.status,
          inspectorId: u.inspector_id,
          inspectionTaskId: u.inspection_task_id,
          deviceSerial: u.device_serial,
        })),
      };
    });
  return ok(list);
}

async function myCase(user: AppUser, id: string) {
  const all = await myCases(user);
  const json = await all.json();
  const list = json.data as Array<{ id: string }>;
  const row = list.find((x) => x.id === id);
  if (!row) throw new HttpError(404, "案例不存在或无权查看");
  return ok(row);
}

async function caseInspectors(caseId: string) {
  const row = await loadCase(caseId);
  if (!row) throw new HttpError(404, "案例不存在");
  const siteId = row.site_id as string | null;
  if (!siteId) return ok([]);
  const d = await adminGql<{
    site_members: Array<{
      user: { id: string; real_name: string; username: string; phone: string } | null;
    }>;
  }>(
    `query ($sid: uuid!) {
      site_members(where: { site_id: { _eq: $sid }, status: { _eq: "active" } }) {
        user { id real_name username phone }
      }
    }`,
    { sid: siteId },
  );
  return ok(
    d.site_members
      .map((m) => m.user)
      .filter(Boolean)
      .map((u) => ({
        id: u!.id,
        realName: u!.real_name,
        username: u!.username,
        phone: u!.phone,
      })),
  );
}

async function assignCase(user: AppUser, caseId: string, body: Record<string, unknown>) {
  const ids = [
    ...new Set(
      [
        ...((body.inspectorIds as string[]) || []),
        ...(body.inspectorId ? [String(body.inspectorId)] : []),
      ].filter(Boolean),
    ),
  ];
  if (!ids.length) throw new HttpError(400, "请选择至少一名工程师");
  const row = await loadCase(caseId);
  if (!row) throw new HttpError(404, "案例不存在");
  if (!row.site_id) throw new HttpError(400, "请先将案例分配到网格，再派给本网格工程师");
  if (!row.task_template_id && !row.task_type) throw new HttpError(400, "请先设置案例服务类型");
  const assignMode = (body.assignMode as string) || (row.assign_mode as string) || "single";
  const plannedUnits = Math.max(1, Number(body.plannedUnits ?? row.planned_units ?? 1));
  const remark = body.reason !== undefined ? String(body.reason || "").trim() : row.assign_remark;
  const tpl = row.task_template as { name?: string; entries?: unknown[]; product_lines?: unknown[]; device_type?: string } | null;

  await adminGql(
    `mutation ($id: uuid!, $set: service_cases_set_input!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: caseId,
      set: {
        assign_mode: assignMode,
        planned_units: plannedUnits,
        expense_enabled: true,
        unit_label: "台",
        assign_remark: remark || null,
        inspector_id: ids[0],
        assign_by_id: user.id,
        assign_time: new Date().toISOString(),
        status: "assigned",
      },
    },
  );

  for (const inspectorId of ids) {
    const upd = await adminGql<{ update_case_assignments: { affected_rows: number } }>(
      `mutation ($cid: uuid!, $uid: uuid!, $by: uuid!, $now: timestamptz!) {
        update_case_assignments(
          where: { service_case_id: { _eq: $cid }, inspector_id: { _eq: $uid } }
          _set: { status: "assigned", assign_by_id: $by, assign_time: $now }
        ) { affected_rows }
      }`,
      { cid: caseId, uid: inspectorId, by: user.id, now: new Date().toISOString() },
    );
    if (!upd.update_case_assignments.affected_rows) {
      await adminGql(
        `mutation ($obj: case_assignments_insert_input!) {
          insert_case_assignments_one(object: $obj) { id }
        }`,
        {
          obj: {
            service_case_id: caseId,
            inspector_id: inspectorId,
            assign_by_id: user.id,
            assign_time: new Date().toISOString(),
            status: "assigned",
          },
        },
      );
    }
  }

  const existing = await adminGql<{ case_work_units_aggregate: { aggregate: { count: number } } }>(
    `query ($id: uuid!) { case_work_units_aggregate(where: { service_case_id: { _eq: $id } }) { aggregate { count } } }`,
    { id: caseId },
  );
  if ((existing.case_work_units_aggregate.aggregate.count || 0) < plannedUnits) {
    const start = existing.case_work_units_aggregate.aggregate.count + 1;
    const units = [];
    for (let seq = start; seq <= plannedUnits; seq++) {
      units.push({
        service_case_id: caseId,
        seq,
        title: `第${seq}台`,
        status: "open",
      });
    }
    if (units.length) {
      await adminGql(`mutation ($objects: [case_work_units_insert_input!]!) {
        insert_case_work_units(objects: $objects) { affected_rows }
      }`, { objects: units });
    }
  }

  if (assignMode === "single" && ids.length === 1) {
    const snap = tpl?.entries || [];
    await adminGql(
      `mutation ($obj: inspection_tasks_insert_input!) {
        insert_inspection_tasks_one(object: $obj) { id }
      }`,
      {
        obj: {
          site_id: row.site_id,
          task_name: `${row.gsp_case_no} ${row.project_name}`,
          inspector_id: ids[0],
          created_by_id: user.id,
          service_case_id: caseId,
          task_type: "service",
          status: "pending",
          ai_enabled: true,
          template_snapshot: snap,
        },
      },
    );
  }

  const next = await loadCase(caseId);
  return ok(mapCase(next!));
}

async function setCaseSite(user: AppUser, caseId: string, body: Record<string, unknown>) {
  const siteId = String(body.siteId || "");
  if (!siteId) throw new HttpError(400, "请选择网格");
  await adminGql(
    `mutation ($id: uuid!, $siteId: uuid!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: { site_id: $siteId }) { id }
    }`,
    { id: caseId, siteId },
  );
  return ok(mapCase((await loadCase(caseId))!));
}

async function assignSites(user: AppUser, body: Record<string, unknown>) {
  const caseIds = (body.caseIds as string[]) || [];
  const siteId = String(body.siteId || "");
  if (!siteId || !caseIds.length) throw new HttpError(400, "请选择案例和网格");
  const site = await adminGql<{ sites_by_pk: { name: string } | null }>(
    `query ($id: uuid!) { sites_by_pk(id: $id) { name } }`,
    { id: siteId },
  );
  await adminGql(
    `mutation ($ids: [uuid!]!, $siteId: uuid!) {
      update_service_cases(where: { id: { _in: $ids } }, _set: { site_id: $siteId }) { affected_rows }
    }`,
    { ids: caseIds, siteId },
  );
  return ok({ updated: caseIds.length, siteId, siteName: site.sites_by_pk?.name || "", skipped: [] });
}

async function setCaseTaskType(user: AppUser, caseId: string, body: Record<string, unknown>) {
  const templateId = String(body.templateId || "");
  const tpl = await adminGql<{ inspection_templates_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { inspection_templates_by_pk(id: $id) { id name assign_mode unit_label expense_enabled_default } }`,
    { id: templateId },
  );
  const t = tpl.inspection_templates_by_pk;
  if (!t) throw new HttpError(404, "服务类型不存在");
  await adminGql(
    `mutation ($id: uuid!, $set: service_cases_set_input!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: caseId,
      set: {
        task_template_id: templateId,
        task_type: t.name,
        product_line: body.productLine || null,
        assign_mode: t.assign_mode,
        unit_label: t.unit_label,
        expense_enabled: t.expense_enabled_default,
      },
    },
  );
  return ok(mapCase((await loadCase(caseId))!));
}

async function setWorkPlan(caseId: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: service_cases_set_input!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: caseId,
      set: {
        planned_units: body.plannedUnits != null ? Number(body.plannedUnits) : undefined,
        expense_enabled: body.expenseEnabled,
      },
    },
  );
  return ok(mapCase((await loadCase(caseId))!));
}

async function updateCaseProfile(caseId: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: service_cases_set_input!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: caseId,
      set: {
        project_name: body.projectName,
        province: body.province,
        city: body.city,
        site_desc: body.siteDesc,
        service_type: body.serviceType,
        product_line: body.productLine,
      },
    },
  );
  return ok(mapCase((await loadCase(caseId))!));
}

async function withdrawAssignee(caseId: string, inspectorId: string) {
  await adminGql(
    `mutation ($cid: uuid!, $uid: uuid!) {
      update_case_assignments(
        where: { service_case_id: { _eq: $cid }, inspector_id: { _eq: $uid } }
        _set: { status: "withdrawn" }
      ) { affected_rows }
    }`,
    { cid: caseId, uid: inspectorId },
  );
  return ok({ success: true });
}

async function startMyCase(user: AppUser, caseId: string) {
  await adminGql(
    `mutation ($id: uuid!, $uid: uuid!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: { status: "working" }) { id }
      update_case_assignments(
        where: { service_case_id: { _eq: $id }, inspector_id: { _eq: $uid } }
        _set: { status: "working" }
      ) { affected_rows }
    }`,
    { id: caseId, uid: user.id },
  );
  return myCase(user, caseId);
}

async function finishMyCase(user: AppUser, caseId: string) {
  await adminGql(
    `mutation ($id: uuid!, $now: timestamptz!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: { status: "finished", finish_time: $now }) { id }
    }`,
    { id: caseId, now: new Date().toISOString() },
  );
  return myCase(user, caseId);
}

async function claimUnit(user: AppUser, caseId: string, unitId: string) {
  const row = await loadCase(caseId);
  if (!row?.site_id) throw new HttpError(400, "案例未分配网格");
  const tpl = row.task_template as { entries?: unknown[] } | null;
  const task = await adminGql<{ insert_inspection_tasks_one: { id: string } }>(
    `mutation ($obj: inspection_tasks_insert_input!) { insert_inspection_tasks_one(object: $obj) { id } }`,
    {
      obj: {
        site_id: row.site_id,
        task_name: `${row.gsp_case_no} 单元作业`,
        inspector_id: user.id,
        created_by_id: user.id,
        service_case_id: caseId,
        work_unit_id: unitId,
        task_type: "service",
        status: "pending",
        ai_enabled: true,
        template_snapshot: tpl?.entries || [],
      },
    },
  );
  await adminGql(
    `mutation ($id: uuid!, $uid: uuid!, $tid: uuid!, $now: timestamptz!) {
      update_case_work_units_by_pk(pk_columns: { id: $id }, _set: {
        status: "claimed", inspector_id: $uid, inspection_task_id: $tid, claimed_at: $now
      }) { id }
    }`,
    { id: unitId, uid: user.id, tid: task.insert_inspection_tasks_one.id, now: new Date().toISOString() },
  );
  return ok({ inspectionTaskId: task.insert_inspection_tasks_one.id, case: mapCase((await loadCase(caseId))!) });
}

async function completeUnit(user: AppUser, caseId: string, unitId: string) {
  await adminGql(
    `mutation ($id: uuid!, $now: timestamptz!) {
      update_case_work_units_by_pk(pk_columns: { id: $id }, _set: { status: "completed", completed_at: $now }) { id }
    }`,
    { id: unitId, now: new Date().toISOString() },
  );
  return myCase(user, caseId);
}

async function saveSerial(unitId: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: case_work_units_set_input!) {
      update_case_work_units_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: unitId,
      set: {
        device_serial: body.deviceSerial || body.serial,
        serial_photo_url: body.serialPhotoUrl || body.photoUrl,
        serial_confirmed_at: new Date().toISOString(),
      },
    },
  );
  return ok({ success: true });
}

async function saveExpense(user: AppUser, caseId: string, unitId: string | null, body: Record<string, unknown>) {
  const amount = Number(body.amount ?? body.claimAmount ?? 0);
  const d = await adminGql<{ insert_case_expense_claims_one: Record<string, unknown> }>(
    `mutation ($obj: case_expense_claims_insert_input!) { insert_case_expense_claims_one(object: $obj) { id amount claim_amount status note line_items voucher_urls trip_skipped } }`,
    {
      obj: {
        service_case_id: caseId,
        work_unit_id: unitId,
        inspector_id: user.id,
        amount,
        claim_amount: amount,
        line_items: body.lineItems || [],
        voucher_urls: body.voucherUrls || [],
        trip_skipped: body.tripSkipped || false,
        note: body.note || null,
        status: "submitted",
        month: new Date().toISOString().slice(0, 7),
      },
    },
  );
  const row = d.insert_case_expense_claims_one;
  return ok({
    id: row.id,
    amount: String(row.amount),
    claimAmount: String(row.claim_amount),
    status: row.status,
    note: row.note,
    lineItems: row.line_items,
    voucherUrls: row.voucher_urls,
    tripSkipped: row.trip_skipped,
  });
}

async function pendingExpenses(query: URLSearchParams) {
  const where: Record<string, unknown> = {};
  if (query.get("status") && query.get("status") !== "all") where.status = { _eq: query.get("status") };
  else where.status = { _eq: "submitted" };
  const d = await adminGql<{ case_expense_claims: Record<string, unknown>[] }>(
    `query ($where: case_expense_claims_bool_exp!) {
      case_expense_claims(where: $where, order_by: { created_at: desc }) {
        id service_case_id inspector_id amount note voucher_urls status month review_note review_at created_at
        inspector { real_name }
        service_case { gsp_case_no project_name }
      }
    }`,
    { where },
  );
  return ok(
    d.case_expense_claims.map((r) => ({
      id: r.id,
      serviceCaseId: r.service_case_id,
      gspCaseNo: (r.service_case as { gsp_case_no?: string })?.gsp_case_no,
      projectName: (r.service_case as { project_name?: string })?.project_name,
      inspectorId: r.inspector_id,
      inspectorName: (r.inspector as { real_name?: string })?.real_name,
      amount: String(r.amount),
      note: r.note,
      voucherUrls: r.voucher_urls,
      status: r.status,
      month: r.month,
      reviewNote: r.review_note,
      reviewAt: r.review_at,
      createdAt: r.created_at,
    })),
  );
}

async function reviewExpense(id: string, pass: boolean, body: Record<string, unknown>, user: AppUser) {
  await adminGql(
    `mutation ($id: uuid!, $set: case_expense_claims_set_input!) {
      update_case_expense_claims_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id,
      set: {
        status: pass ? "approved" : "rejected",
        review_by_id: user.id,
        review_at: new Date().toISOString(),
        review_note: body.note || null,
        amount: pass && body.approvedAmount != null ? Number(body.approvedAmount) : undefined,
      },
    },
  );
  return ok({ success: true });
}

async function batchCreateTasks(user: AppUser, body: Record<string, unknown>) {
  const caseIds = (body.caseIds as string[]) || [];
  const inspectorId = String(body.inspectorId || "");
  let created = 0;
  const taskIds: string[] = [];
  const skipped: Array<{ caseId: string; reason: string }> = [];
  for (const caseId of caseIds) {
    try {
      const res = await assignCase(user, caseId, { inspectorId });
      created += 1;
      taskIds.push(caseId);
      void res;
    } catch (e) {
      skipped.push({ caseId, reason: e instanceof Error ? e.message : "失败" });
    }
  }
  return ok({ createdTasks: created, serviceAssigned: created, skipped, taskIds });
}

const TASK_FIELDS = `
  id site_id device_id task_name inspector_id created_by_id service_case_id work_unit_id
  task_type status planned_date started_at completed_at ai_enabled template_snapshot created_at
  site { id name code province city district }
  device { id serial_number device_type model }
  inspector { id real_name phone }
  service_case { task_type service_type task_template { name } }
  inspection_records(order_by: { created_at: desc }, limit: 1) {
    id status entries reject_reason
  }
`;

async function listTasks(user: AppUser, query: URLSearchParams) {
  const page = Number(query.get("page") || 1);
  const limit = Number(query.get("limit") || 20);
  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  if (user.role === "inspector") and.push({ inspector_id: { _eq: user.id } });
  if (query.get("siteId")) and.push({ site_id: { _eq: query.get("siteId") } });
  if (query.get("status")) and.push({ status: { _eq: query.get("status") } });
  if (and.length) where._and = and;
  const d = await adminGql<{
    inspection_tasks: Record<string, unknown>[];
    inspection_tasks_aggregate: { aggregate: { count: number } };
  }>(
    `query ($where: inspection_tasks_bool_exp!, $limit: Int!, $offset: Int!) {
      inspection_tasks(where: $where, limit: $limit, offset: $offset, order_by: { created_at: desc }) { ${TASK_FIELDS} }
      inspection_tasks_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return ok({
    list: d.inspection_tasks.map(mapTask),
    total: d.inspection_tasks_aggregate.aggregate.count,
    page,
    limit,
  });
}

async function getTask(id: string) {
  const d = await adminGql<{ inspection_tasks_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { inspection_tasks_by_pk(id: $id) { ${TASK_FIELDS} } }`,
    { id },
  );
  if (!d.inspection_tasks_by_pk) throw new HttpError(404, "任务不存在");
  return ok(mapTask(d.inspection_tasks_by_pk));
}

async function startTask(user: AppUser, id: string) {
  await adminGql(
    `mutation ($id: uuid!, $now: timestamptz!) {
      update_inspection_tasks_by_pk(pk_columns: { id: $id }, _set: { status: "in_progress", started_at: $now }) { id }
    }`,
    { id, now: new Date().toISOString() },
  );
  const t = await adminGql<{ inspection_tasks_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { inspection_tasks_by_pk(id: $id) { ${TASK_FIELDS} } }`,
    { id },
  );
  const task = t.inspection_tasks_by_pk!;
  const recs = (task.inspection_records as unknown[]) || [];
  if (!recs.length) {
    const snap = (task.template_snapshot as Array<{ id: string }>) || [];
    await adminGql(
      `mutation ($obj: inspection_records_insert_input!) { insert_inspection_records_one(object: $obj) { id } }`,
      {
        obj: {
          task_id: id,
          device_type: "string_inverter",
          status: "draft",
          entries: snap.map((e) => ({
            templateEntryId: e.id,
            photos: [],
            aiResult: { status: "pending", confidence: 0, reason: "" },
            manualResult: "pending",
            finalResult: null,
            remark: "",
          })),
        },
      },
    );
  }
  return getTask(id);
}

async function createTask(user: AppUser, body: Record<string, unknown>) {
  const d = await adminGql<{ insert_inspection_tasks_one: Record<string, unknown> }>(
    `mutation ($obj: inspection_tasks_insert_input!) { insert_inspection_tasks_one(object: $obj) { ${TASK_FIELDS} } }`,
    {
      obj: {
        site_id: body.siteId,
        device_id: body.deviceId || null,
        task_name: body.taskName,
        inspector_id: user.id,
        created_by_id: user.id,
        ai_enabled: body.aiEnabled ?? true,
        status: "pending",
        task_type: "inspection",
      },
    },
  );
  return ok(mapTask(d.insert_inspection_tasks_one));
}

async function updateTask(id: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: inspection_tasks_set_input!) {
      update_inspection_tasks_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    { id, set: { task_name: body.taskName, ai_enabled: body.aiEnabled } },
  );
  return getTask(id);
}

async function removeTask(id: string) {
  await adminGql(`mutation ($id: uuid!) { delete_inspection_tasks_by_pk(id: $id) { id } }`, { id });
  return ok({ success: true });
}

const RECORD_FIELDS = `
  id task_id device_type entries report_photos location status submitted_at approved_at reject_reason audit_trail created_at
  task {
    id task_name site_id device_id ai_enabled template_snapshot inspector { id real_name }
    site { id name }
    service_case { id gsp_case_no project_name }
  }
`;

async function listRecords(query: URLSearchParams) {
  const page = Number(query.get("page") || 1);
  const limit = Number(query.get("limit") || 20);
  const where: Record<string, unknown> = {};
  if (query.get("status")) where.status = { _eq: query.get("status") };
  const d = await adminGql<{
    inspection_records: Record<string, unknown>[];
    inspection_records_aggregate: { aggregate: { count: number } };
  }>(
    `query ($where: inspection_records_bool_exp!, $limit: Int!, $offset: Int!) {
      inspection_records(where: $where, limit: $limit, offset: $offset, order_by: { created_at: desc }) { ${RECORD_FIELDS} }
      inspection_records_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return ok({
    list: d.inspection_records.map(mapRecord),
    total: d.inspection_records_aggregate.aggregate.count,
    page,
    limit,
  });
}

async function getRecord(id: string) {
  const d = await adminGql<{ inspection_records_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { inspection_records_by_pk(id: $id) { ${RECORD_FIELDS} } }`,
    { id },
  );
  if (!d.inspection_records_by_pk) throw new HttpError(404, "记录不存在");
  return ok(mapRecord(d.inspection_records_by_pk));
}

async function saveDraft(id: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: inspection_records_set_input!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    { id, set: { entries: body.entries, location: body.location, report_photos: body.reportPhotos } },
  );
  return getRecord(id);
}

async function submitRecord(user: AppUser, id: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: inspection_records_set_input!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: $set) { id task_id }
    }`,
    {
      id,
      set: {
        entries: body.entries,
        location: body.location,
        status: "submitted",
        submitted_at: new Date().toISOString(),
        audit_trail: [{ action: "submitted", at: new Date().toISOString(), by: user.id, byName: user.realName }],
      },
    },
  );
  const rec = await adminGql<{ inspection_records_by_pk: { task_id: string } | null }>(
    `query ($id: uuid!) { inspection_records_by_pk(id: $id) { task_id } }`,
    { id },
  );
  if (rec.inspection_records_by_pk?.task_id) {
    await adminGql(
      `mutation ($id: uuid!, $now: timestamptz!) {
        update_inspection_tasks_by_pk(pk_columns: { id: $id }, _set: { status: "submitted", completed_at: $now }) { id }
      }`,
      { id: rec.inspection_records_by_pk.task_id, now: new Date().toISOString() },
    );
  }
  return getRecord(id);
}

async function approveRecord(user: AppUser, id: string) {
  await adminGql(
    `mutation ($id: uuid!, $uid: uuid!, $now: timestamptz!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: {
        status: "approved", approved_at: $now, approved_by_id: $uid
      }) { id task_id }
    }`,
    { id, uid: user.id, now: new Date().toISOString() },
  );
  return getRecord(id);
}

async function rejectRecord(user: AppUser, id: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $reason: jsonb!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: {
        status: "rejected", reject_reason: $reason
      }) { id }
    }`,
    { id, reason: { reason: body.reason || "驳回", entryIds: body.entryIds || [] } },
  );
  return getRecord(id);
}

async function recordCaseGroups(query: URLSearchParams) {
  const recs = await listRecords(query);
  const json = await recs.json();
  const list = (json.data?.list || []) as Array<{ task?: { serviceCase?: { id: string; gspCaseNo?: string } } }>;
  return ok({ list, total: list.length, page: 1, limit: list.length });
}

async function recordsByCase(groupKey: string) {
  const raw = String(groupKey || "").trim();
  const kind = raw.startsWith("task-") ? "task" : "case";
  const id = raw.startsWith("case-") || raw.startsWith("task-") ? raw.slice(5) : raw;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, "无效的案例标识");
  }
  const where =
    kind === "task"
      ? { task_id: { _eq: id } }
      : { task: { service_case_id: { _eq: id } } };
  const d = await adminGql<{ inspection_records: Record<string, unknown>[] }>(
    `query ($where: inspection_records_bool_exp!) {
      inspection_records(where: $where, order_by: { created_at: desc }) { ${RECORD_FIELDS} }
    }`,
    { where },
  );
  return ok({ list: d.inspection_records.map(mapRecord), total: d.inspection_records.length, groupKey: raw });
}

async function runAnalyze(body: Record<string, unknown>) {
  const recordId = body.recordId as string | undefined;
  const entryId = body.templateEntryId as string | undefined;
  let title = String(body.title || "").trim();
  let description = String(body.description || "").trim();
  let templateId = String(body.templateId || "").trim();
  if (recordId && entryId && (!title || !templateId)) {
    const rec = await adminGql<{
      inspection_records_by_pk: {
        task?: {
          template_snapshot?: Array<{ id?: string; name?: string; description?: string }>;
          service_case?: { task_template_id?: string; task_template?: { id?: string; name?: string } };
        };
      } | null;
    }>(
      `query ($id: uuid!) {
        inspection_records_by_pk(id: $id) {
          task {
            template_snapshot
            service_case { task_template_id task_template { id name } }
          }
        }
      }`,
      { id: recordId },
    );
    const task = rec.inspection_records_by_pk?.task;
    const snap = task?.template_snapshot?.find((item) => item.id === entryId);
    if (!title) title = String(snap?.name || "");
    if (!description) description = String(snap?.description || "");
    if (!templateId) {
      templateId = String(task?.service_case?.task_template_id || task?.service_case?.task_template?.id || "");
    }
  }
  const result = await analyzePhotos({
    title,
    description,
    photoUrls: takeLatestPhotos(body.photoUrls, 8),
    templateId: templateId || undefined,
    entryId: entryId || undefined,
  });
  if (recordId && entryId) {
    const rec = await adminGql<{ inspection_records_by_pk: { entries: Array<Record<string, unknown>> } | null }>(
      `query ($id: uuid!) { inspection_records_by_pk(id: $id) { entries } }`,
      { id: recordId },
    );
    const entries = rec.inspection_records_by_pk?.entries || [];
    const next = entries.map((e) =>
      e.templateEntryId === entryId ? { ...e, aiResult: result } : e,
    );
    await adminGql(
      `mutation ($id: uuid!, $entries: jsonb!) {
        update_inspection_records_by_pk(pk_columns: { id: $id }, _set: { entries: $entries }) { id }
      }`,
      { id: recordId, entries: next },
    );
  }
  return ok({ queued: false, completed: true, ...result, aiResult: result });
}

async function aiResult(entryId: string, recordId: string | null) {
  if (!recordId) return ok({ status: "pending" });
  const rec = await adminGql<{ inspection_records_by_pk: { entries: Array<Record<string, unknown>> } | null }>(
    `query ($id: uuid!) { inspection_records_by_pk(id: $id) { entries } }`,
    { id: recordId },
  );
  const entry = (rec.inspection_records_by_pk?.entries || []).find((e) => e.templateEntryId === entryId);
  return ok(entry?.aiResult || { status: "pending" });
}

async function checkLocation(body: Record<string, unknown>) {
  return ok({
    verified: true,
    status: body.locationStatus || "ok",
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
    distanceMeters: 0,
    distanceToSiteMeters: 0,
    radiusMeters: 500,
    accuracyMeters: Number(body.accuracy || 0),
    capturedAt: body.capturedAt,
    checkedAt: new Date().toISOString(),
    siteName: "",
    reasonCode: body.locationReasonCode,
    reason: body.locationReason,
  });
}

async function loadHardRuleReviewStats(rules: Record<string, unknown>[]) {
  const since = new Date(Date.now() - HARD_RULE_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const d = await adminGql<{
    inspection_records: Array<{
      entries?: unknown;
      created_at?: string;
      submitted_at?: string;
      approved_at?: string;
      task?: {
        template_snapshot?: Array<{ id?: string; name?: string; description?: string }>;
        service_case?: { task_template_id?: string };
      };
    }>;
  }>(
    `query ($since: timestamptz!) {
      inspection_records(
        where: {
          _or: [
            { created_at: { _gte: $since } }
            { submitted_at: { _gte: $since } }
            { approved_at: { _gte: $since } }
          ]
        }
        limit: 800
        order_by: { created_at: desc }
      ) {
        entries
        created_at
        submitted_at
        approved_at
        task { template_snapshot service_case { task_template_id } }
      }
    }`,
    { since },
  );
  return accumulateHardRuleReviewStats(d.inspection_records || [], rules);
}

async function setManualResult(recordId: string, entryId: string, body: Record<string, unknown>) {
  const manualStatus = body.manualResult === "fail" ? "fail" : body.manualResult === "pass" ? "pass" : "";
  if (!manualStatus) throw new HttpError(400, "请选择合格或不合格");
  const rec = await adminGql<{
    inspection_records_by_pk: {
      entries: Array<Record<string, unknown>>;
      task?: {
        template_snapshot?: Array<{ id?: string; name?: string; description?: string }>;
        service_case?: { task_template_id?: string };
      };
    } | null;
  }>(
    `query ($id: uuid!) {
      inspection_records_by_pk(id: $id) {
        entries
        task { template_snapshot service_case { task_template_id } }
      }
    }`,
    { id: recordId },
  );
  const row = rec.inspection_records_by_pk;
  const entries = row?.entries || [];
  const snap = (row?.task?.template_snapshot || []).find((item) => item.id === entryId);
  const rules = (
    await adminGql<{
      ai_hard_rules: Array<Record<string, unknown>>;
    }>(`query {
      ai_hard_rules(where: { enabled: { _eq: true } }) {
        code match_mode match_pattern json_schema_hint enforce_mode
      }
    }`)
  ).ai_hard_rules.filter((rule) => String(rule.enforce_mode || "") !== "off");
  const ruleCodes = matchHardRuleCodes(rules, {
    title: String(snap?.name || ""),
    description: String(snap?.description || ""),
    templateId: String(row?.task?.service_case?.task_template_id || ""),
    entryId,
  });
  const next = entries.map((e) => {
    if (e.templateEntryId !== entryId) return e;
    const aiResult = (e.aiResult || {}) as { status?: string };
    return {
      ...e,
      manualResult: manualStatus,
      finalResult: manualStatus,
      review: stampHardRuleReview({
        aiStatus: aiResult.status,
        manualStatus,
        ruleCodes,
      }),
    };
  });
  await adminGql(
    `mutation ($id: uuid!, $entries: jsonb!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: { entries: $entries }) { id }
    }`,
    { id: recordId, entries: next },
  );
  return getRecord(recordId);
}

async function uploadPhoto(form: FormData | null, user: AppUser) {
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "请选择照片");
  const token = createUploadToken(file.name || "photo.jpg", user.id);
  const fd = new FormData();
  fd.append("token", token.token);
  fd.append("key", token.key);
  fd.append("file", file);
  const res = await fetch(token.uploadUrl, { method: "POST", body: fd });
  if (!res.ok) throw new HttpError(500, "图片上传失败");
  return ok({ url: token.publicUrl, original: true });
}

function money(n: number) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

async function listPo(query: URLSearchParams) {
  const page = Number(query.get("page") || 1);
  const limit = Number(query.get("limit") || 10);
  const where: Record<string, unknown> = {};
  if (query.get("matchStatus")) {
    where.match_status = { _eq: query.get("matchStatus") };
  }
  if (query.get("keyword")) {
    where._or = [
      { po_no: { _ilike: `%${query.get("keyword")}%` } },
      { gsp_case_no: { _ilike: `%${query.get("keyword")}%` } },
      { project_name: { _ilike: `%${query.get("keyword")}%` } },
    ];
  }
  if (query.get("dateFrom") || query.get("dateTo")) {
    where.demand_date = {
      ...(query.get("dateFrom") ? { _gte: query.get("dateFrom") } : {}),
      ...(query.get("dateTo") ? { _lte: query.get("dateTo") } : {}),
    };
  }
  const d = await adminGql<{ po_orders: Record<string, unknown>[]; po_orders_aggregate: { aggregate: { count: number } } }>(
    `query ($where: po_orders_bool_exp!, $limit: Int!, $offset: Int!) {
      po_orders(where: $where, limit: $limit, offset: $offset, order_by: { created_at: desc }) {
        ${PO_ORDER_FIELDS}
        service_case { id gsp_case_no project_name province city site_desc service_type product_line region status }
        po_items(limit: 500) { ${PO_ITEM_FIELDS} }
      }
      po_orders_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return ok({
    list: d.po_orders.map((r) => mapPoOrder(r)),
    total: d.po_orders_aggregate.aggregate.count,
    page,
    limit,
  });
}

async function listPrices(query: URLSearchParams) {
  const page = Number(query.get("page") || 1);
  const limit = Number(query.get("limit") || 20);
  const where: Record<string, unknown> = {};
  const priceType = query.get("type") || query.get("priceType");
  if (priceType) where.price_type = { _eq: priceType };
  if (query.get("keyword")) {
    where._or = [
      { item_name: { _ilike: `%${query.get("keyword")}%` } },
      { item_code: { _ilike: `%${query.get("keyword")}%` } },
    ];
  }
  const d = await adminGql<{ price_library: Record<string, unknown>[]; price_library_aggregate: { aggregate: { count: number } } }>(
    `query ($where: price_library_bool_exp!, $limit: Int!, $offset: Int!) {
      price_library(where: $where, limit: $limit, offset: $offset, order_by: { created_at: desc }) {
        id price_type item_code item_name item_desc unit product_model scene region coop_type work_hours unit_price effective_date status change_remark
      }
      price_library_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return ok({
    list: d.price_library.map((r) => ({
      id: r.id,
      priceType: r.price_type,
      itemCode: r.item_code,
      itemName: r.item_name,
      itemDesc: r.item_desc,
      unit: r.unit,
      productModel: r.product_model,
      scene: r.scene,
      region: r.region,
      coopType: r.coop_type,
      workHours: r.work_hours,
      unitPrice: String(r.unit_price ?? 0),
      effectiveDate: r.effective_date,
      status: r.status,
      changeRemark: r.change_remark,
    })),
    total: d.price_library_aggregate.aggregate.count,
    page,
    limit,
  });
}

async function savePrice(_user: AppUser, id: string | null, body: Record<string, unknown>) {
  const obj = {
    price_type: body.priceType,
    item_code: body.itemCode,
    item_name: body.itemName,
    item_desc: body.itemDesc,
    unit: body.unit,
    product_model: body.productModel,
    scene: body.scene,
    region: body.region,
    coop_type: body.coopType,
    work_hours: body.workHours,
    unit_price: body.unitPrice,
    effective_date: body.effectiveDate,
    status: body.status || "active",
    change_remark: body.changeRemark,
  };
  let savedId = id;
  if (!id) {
    const d = await adminGql<{ insert_price_library_one: { id: string } }>(
      `mutation ($obj: price_library_insert_input!) { insert_price_library_one(object: $obj) { id } }`,
      { obj },
    );
    savedId = d.insert_price_library_one.id;
  } else {
    await adminGql(
      `mutation ($id: uuid!, $set: price_library_set_input!) {
        update_price_library_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id, set: obj },
    );
  }
  const applied = await recalculate().catch(() => null);
  return ok({ ...body, id: savedId, applied });
}

async function pendingReviews(query: URLSearchParams) {
  const where: Record<string, unknown> = { status: { _eq: query.get("reviewStatus") === "all" ? undefined : query.get("reviewStatus") || "settle_review" } };
  if (!query.get("reviewStatus") || query.get("reviewStatus") === "pending") {
    where.status = { _in: ["finished", "settle_review"] };
  }
  const d = await adminGql<{ service_cases: Record<string, unknown>[] }>(
    `query ($where: service_cases_bool_exp!) { service_cases(where: $where, order_by: { updated_at: desc }) { ${CASE_FIELDS} } }`,
    { where },
  );
  return ok(
    d.service_cases.map((c) => ({
      ...mapCase(c),
      overdue: false,
    })),
  );
}

async function amountBreakdown(caseId: string) {
  const row = await loadCaseDetail(caseId);
  if (!row) throw new HttpError(404, "案例不存在");
  const extra = await adminGql<{
    case_performances: Array<{
      case_revenue?: string | number;
      perf_base?: string | number;
      perf_final?: string | number;
      deduction?: string | number;
    }>;
    assessment_events: Array<{
      id: string;
      category?: string;
      content: string;
      amount: string | number;
      remark?: string | null;
      user_id: string;
      created_at?: string;
      user?: { real_name?: string } | null;
    }>;
  }>(
    `query ($id: uuid!) {
      case_performances(where: { service_case_id: { _eq: $id } }, limit: 1) {
        case_revenue perf_base perf_final deduction
      }
      assessment_events(where: { service_case_id: { _eq: $id } }, order_by: { created_at: desc }) {
        id category content amount remark user_id created_at
        user { real_name }
      }
    }`,
    { id: caseId },
  );
  const orders = (row.po_orders as Record<string, unknown>[]) || [];
  const items = orders.flatMap((po) =>
    ((po.po_items as Record<string, unknown>[]) || [])
      .filter((it) => it.price_status !== "ignored")
      .map((it) => ({
        id: String(it.id),
        poId: String(po.id),
        itemCode: String(it.item_code || ""),
        itemName: String(it.item_name || it.item_code || ""),
        itemDesc: (it.item_desc as string | null) ?? null,
        unit: (it.unit as string | null) ?? null,
        qty: String(it.qty ?? 0),
        settlePrice: it.settle_price == null ? null : String(it.settle_price),
        itemRevenue: String(it.item_revenue ?? 0),
        perfPrice: it.perf_price == null ? null : String(it.perf_price),
        itemPerf: String(it.item_perf ?? 0),
        priceStatus: String(it.price_status || ""),
      })),
  );
  const itemRevenue = items.reduce((sum, it) => sum + Number(it.itemRevenue || 0), 0);
  const itemPerf = items.reduce((sum, it) => sum + Number(it.itemPerf || 0), 0);
  const ledger = extra.case_performances[0];
  const caseRevenue = itemRevenue;
  const perfBase = itemPerf;
  if (!items.length) await recalculateLedgers([caseId]);
  const deduction = Number(ledger?.deduction || 0);
  const events = extra.assessment_events.map((e) => ({
    id: e.id,
    category: e.category,
    content: e.content,
    amount: String(e.amount ?? 0),
    remark: e.remark,
    userId: e.user_id,
    userName: e.user?.real_name || null,
    createdAt: e.created_at,
  }));
  const eventPenalty = events.reduce((sum, e) => sum + Number(e.amount || 0), 0);
  return ok({
    caseId,
    gspCaseNo: row.gsp_case_no,
    projectName: row.project_name,
    finishTime: row.finish_time,
    caseRevenue: caseRevenue.toFixed(2),
    perfBase: perfBase.toFixed(2),
    deduction: deduction.toFixed(2),
    perfFinal: Number(ledger?.perf_final ?? Math.max(0, perfBase - deduction)).toFixed(2),
    eventPenalty: eventPenalty.toFixed(2),
    pendingExpenseCount: 0,
    items,
    events,
    expenses: [],
  });
}

async function reviewApprove(user: AppUser, caseId: string, body: Record<string, unknown>, pass: boolean) {
  await adminGql(
    `mutation ($id: uuid!, $st: String!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: { status: $st }) { id }
    }`,
    { id: caseId, st: pass ? "settled" : "working" },
  );
  return ok({ success: true, comment: body.comment || body.reason });
}

async function listAssessments(query: URLSearchParams) {
  const month = query.get("month") || new Date().toISOString().slice(0, 7);
  const d = await adminGql<{ assessments: Record<string, unknown>[] }>(
    `query ($m: String!) {
      assessments(where: { month: { _eq: $m } }) {
        id user_id month total_score rank_result reward_amount event_penalty tool_subsidy other_subsidy subsidy_remark
        user { real_name role }
      }
    }`,
    { m: month },
  );
  return ok(
    d.assessments.map((r) => ({
      id: r.id,
      userId: r.user_id,
      month: r.month,
      score: r.total_score,
      rank: r.rank_result,
      bonus: r.reward_amount,
      penalty: r.event_penalty,
      subsidy: Number(r.tool_subsidy || 0) + Number(r.other_subsidy || 0),
      remark: r.subsidy_remark,
      userName: (r.user as { real_name?: string })?.real_name,
      role: (r.user as { role?: string })?.role,
    })),
  );
}

async function saveAssessment(body: Record<string, unknown>) {
  const d = await adminGql<{ insert_assessments_one: { id: string } }>(
    `mutation ($obj: assessments_insert_input!) { insert_assessments_one(object: $obj) { id } }`,
    {
      obj: {
        user_id: body.userId,
        month: body.month,
        user_role: body.role || "inspector",
        rank_group: body.rankGroup || "inspector",
        total_score: body.score,
        reward_amount: body.bonus,
        event_penalty: body.penalty,
        other_subsidy: body.subsidy,
        subsidy_remark: body.remark,
      },
    },
  );
  return ok({ id: d.insert_assessments_one.id, ...body });
}

async function scoreRule() {
  let d = await adminGql<{
    assessment_score_rules: Array<{ id: string; items: unknown; version: number; updated_at: string }>;
  }>(
    `query { assessment_score_rules(order_by: { created_at: asc }, limit: 1) { id items version updated_at } }`,
  );
  let row = d.assessment_score_rules[0];
  if (!row || !Array.isArray(row.items) || !row.items.length) {
    const ins = await adminGql<{ insert_assessment_score_rules_one: typeof row }>(
      `mutation ($obj: assessment_score_rules_insert_input!) {
        insert_assessment_score_rules_one(object: $obj) { id items version updated_at }
      }`,
      { obj: { items: DEFAULT_ASSESSMENT_SCORE_RULES, version: 1 } },
    );
    row = ins.insert_assessment_score_rules_one;
  }
  return ok({ id: row.id, version: row.version, items: row.items, updatedAt: row.updated_at });
}

async function saveScoreRule(user: AppUser, body: Record<string, unknown>) {
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, "请至少保留一条打分规则");
  const d = await adminGql<{ assessment_score_rules: Array<{ id: string; version: number }> }>(
    `query { assessment_score_rules(order_by: { created_at: asc }, limit: 1) { id version } }`,
  );
  const existing = d.assessment_score_rules[0];
  if (!existing) {
    const ins = await adminGql<{ insert_assessment_score_rules_one: { id: string; version: number; updated_at: string } }>(
      `mutation ($obj: assessment_score_rules_insert_input!) {
        insert_assessment_score_rules_one(object: $obj) { id version updated_at }
      }`,
      { obj: { items, version: 1, updated_by_id: user.id } },
    );
    return ok({ id: ins.insert_assessment_score_rules_one.id, version: 1, items, updatedAt: ins.insert_assessment_score_rules_one.updated_at });
  }
  const next = Number(existing.version || 1) + 1;
  const upd = await adminGql<{ update_assessment_score_rules_by_pk: { updated_at: string } | null }>(
    `mutation ($id: uuid!, $set: assessment_score_rules_set_input!) {
      update_assessment_score_rules_by_pk(pk_columns: { id: $id }, _set: $set) { updated_at }
    }`,
    { id: existing.id, set: { items, version: next, updated_by_id: user.id } },
  );
  return ok({ id: existing.id, version: next, items, updatedAt: upd.update_assessment_score_rules_by_pk?.updated_at });
}

async function saveAssessmentScore(user: AppUser, body: Record<string, unknown>) {
  const userId = String(body.userId || "");
  const month = String(body.month || "");
  if (!userId || !month) throw new HttpError(400, "请选择人员和月份");
  if (user.role === "site_manager" && userId === user.id) {
    throw new HttpError(403, "不能给自己打分，请由管理员录入本人考核");
  }
  const target = await adminGql<{ users_by_pk: { id: string; role: string; roles: string[] | null } | null }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { id role roles } }`,
    { id: userId },
  );
  if (!target.users_by_pk) throw new HttpError(404, "考核人员不存在");
  const roles = target.users_by_pk.roles || [];
  const isManager = roles.includes("site_manager") || target.users_by_pk.role === "site_manager";
  const rankGroup = isManager ? "station_manager" : "inspector";
  const items = Array.isArray(body.items) ? (body.items as Array<{ ruleItemId?: string; score?: number; remark?: string }>) : [];
  const total = items.reduce((n, it) => n + Number(it.score || 0), 0);
  const existing = await adminGql<{ assessments: { id: string }[] }>(
    `query ($m: String!, $uid: uuid!) {
      assessments(where: { month: { _eq: $m }, user_id: { _eq: $uid } }, limit: 1) { id }
    }`,
    { m: month, uid: userId },
  );
  const obj = {
    month,
    user_id: userId,
    user_role: isManager ? "site_manager" : "inspector",
    rank_group: rankGroup,
    internal_score: total,
    total_score: total,
    score_detail: { items },
    updated_by_id: user.id,
  };
  if (existing.assessments[0]) {
    await adminGql(
      `mutation ($id: uuid!, $set: assessments_set_input!) {
        update_assessments_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: existing.assessments[0].id, set: obj },
    );
    return ok({ id: existing.assessments[0].id, ...obj });
  }
  const ins = await adminGql<{ insert_assessments_one: { id: string } }>(
    `mutation ($obj: assessments_insert_input!) { insert_assessments_one(object: $obj) { id } }`,
    { obj },
  );
  return ok({ id: ins.insert_assessments_one.id, ...obj });
}

async function eventCatalog() {
  return ok(ASSESSMENT_EVENT_CATALOG);
}

async function listEvents(query: URLSearchParams) {
  const where: Record<string, unknown> = {};
  if (query.get("month")) where.month = { _eq: query.get("month") };
  if (query.get("userId")) where.user_id = { _eq: query.get("userId") };
  const d = await adminGql<{ assessment_events: Record<string, unknown>[] }>(
    `query ($where: assessment_events_bool_exp!) {
      assessment_events(where: $where, order_by: { created_at: desc }) {
        id user_id service_case_id month category content unit qty unit_amount amount remark created_at
        user { real_name }
      }
    }`,
    { where },
  );
  return ok(
    d.assessment_events.map((r) => ({
      id: r.id,
      month: r.month,
      userId: r.user_id,
      userName: (r.user as { real_name?: string } | null)?.real_name,
      serviceCaseId: r.service_case_id,
      category: r.category,
      content: r.content,
      unit: r.unit,
      qty: String(r.qty ?? 1),
      unitAmount: r.unit_amount == null ? null : String(r.unit_amount),
      amount: String(r.amount ?? 0),
      remark: r.remark,
    })),
  );
}

async function createEvent(user: AppUser, body: Record<string, unknown>) {
  const catalog = ASSESSMENT_EVENT_CATALOG.find((item) => item.id === String(body.catalogId || ""));
  if (!catalog) throw new HttpError(400, "考核细则不存在");
  const qty = Number(body.qty ?? 1);
  let amount = body.amount == null ? null : Number(body.amount);
  if (catalog.unitAmount == null) {
    if (amount == null || amount < 0) throw new HttpError(400, "该细则需填写自定义扣罚金额");
  } else {
    amount = Math.round(catalog.unitAmount * qty * 100) / 100;
  }
  const d = await adminGql<{ insert_assessment_events_one: { id: string } }>(
    `mutation ($obj: assessment_events_insert_input!) { insert_assessment_events_one(object: $obj) { id } }`,
    {
      obj: {
        user_id: body.userId,
        service_case_id: body.serviceCaseId || null,
        month: body.month,
        category: catalog.category,
        content: catalog.content,
        unit: catalog.unit,
        qty,
        unit_amount: catalog.unitAmount,
        amount,
        remark: body.remark || catalog.remark || null,
        created_by_id: user.id,
      },
    },
  );
  return ok({ id: d.insert_assessment_events_one.id });
}

async function rankAssessments(month: string, body: Record<string, unknown>) {
  void body;
  return listAssessments(new URLSearchParams({ month }));
}

async function listMonthly(query: URLSearchParams) {
  const month = query.get("month") || new Date().toISOString().slice(0, 7);
  const d = await adminGql<{ monthly_settlements: Record<string, unknown>[] }>(
    `query ($m: String!) {
      monthly_settlements(where: { month: { _eq: $m } }) {
        id user_id month perf_total expense_total reward_total event_penalty subsidy_total correction_total final_amount status
        user { real_name username role }
      }
    }`,
    { m: month },
  );
  return ok(
    d.monthly_settlements.map((r) => ({
      id: r.id,
      userId: r.user_id,
      month: r.month,
      perfTotal: String(r.perf_total ?? 0),
      expenseTotal: String(r.expense_total ?? 0),
      rewardTotal: String(r.reward_total ?? 0),
      eventPenalty: String(r.event_penalty ?? 0),
      subsidyTotal: String(r.subsidy_total ?? 0),
      correctionTotal: String((r as { correction_total?: unknown }).correction_total ?? 0),
      finalAmount: String(r.final_amount ?? 0),
      status: r.status,
      user: {
        realName: (r.user as { real_name?: string })?.real_name || "",
        username: (r.user as { username?: string })?.username || "",
      },
    })),
  );
}

async function exportMonthly(month: string, template: string) {
  const listed = await listMonthly(new URLSearchParams({ month }));
  const json = (await listed.json()) as { data?: Array<Record<string, unknown>> };
  const rows = json.data || [];
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(template === "payroll" ? "发薪表" : "对账表");
  sheet.columns = [
    { header: "姓名", key: "name", width: 14 },
    { header: "计件绩效", key: "perf", width: 12 },
    { header: "报销", key: "exp", width: 12 },
    { header: "奖励", key: "reward", width: 12 },
    { header: "扣罚", key: "pen", width: 12 },
    { header: "补贴", key: "sub", width: 12 },
    { header: "应发", key: "final", width: 12 },
  ];
  for (const r of rows) {
    const user = r.user as { realName?: string } | undefined;
    sheet.addRow({
      name: user?.realName || "",
      perf: Number(r.perfTotal || 0),
      exp: Number(r.expenseTotal || 0),
      reward: Number(r.rewardTotal || 0),
      pen: Number(r.eventPenalty || 0),
      sub: Number(r.subsidyTotal || 0),
      final: Number(r.finalAmount || 0),
    });
  }
  sheet.getRow(1).font = { bold: true };
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return xlsxResponse(`${month}-${template === "payroll" ? "发薪表" : "对账表"}.xlsx`, buffer);
}

async function lockMonth(month: string, locked: boolean) {
  const d = await adminGql<{ update_monthly_settlements: { affected_rows: number } }>(
    `mutation ($m: String!, $st: String!) {
      update_monthly_settlements(where: { month: { _eq: $m } }, _set: { status: $st }) { affected_rows }
    }`,
    { m: month, st: locked ? "locked" : "draft" },
  );
  return ok({ month, locked: d.update_monthly_settlements.affected_rows });
}

async function correctMonthly(month: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($m: String!, $uid: uuid!, $amt: numeric!, $reason: String!) {
      update_monthly_settlements(
        where: { month: { _eq: $m }, user_id: { _eq: $uid } }
        _set: { final_amount: $amt, correction_total: $amt }
      ) { affected_rows }
    }`,
    { m: month, uid: body.userId, amt: body.amount, reason: body.reason },
  );
  return listMonthly(new URLSearchParams({ month }));
}

async function myIncome(user: AppUser, query: URLSearchParams) {
  const month = query.get("month") || new Date().toISOString().slice(0, 7);
  const d = await adminGql<{ monthly_settlements: Array<{ final_amount: number; perf_total: number; expense_total: number }> }>(
    `query ($m: String!, $uid: uuid!) {
      monthly_settlements(where: { month: { _eq: $m }, user_id: { _eq: $uid } }) {
        final_amount perf_total expense_total
      }
    }`,
    { m: month, uid: user.id },
  );
  const row = d.monthly_settlements[0];
  return ok({
    month,
    payable: row?.final_amount ?? 0,
    performance: row?.perf_total ?? 0,
    expense: row?.expense_total ?? 0,
  });
}

void (null as unknown as Handler);
