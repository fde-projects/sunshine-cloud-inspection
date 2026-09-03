import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { adminGql } from "@/lib/hasura-admin";
import { issueRoleSession, loginWithPassword, requireActiveRole } from "./auth-login";
import { analyzePhotos, draftRuleFromSamples, suggestPassViewLabels, ocrMileageFromImage, ocrDeviceSerialFromImage } from "@/lib/vision";
import { createUploadToken, uploadBufferWithToken } from "@/lib/storage";
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
import { ensureOriginalCatalog, healBuiltinHardRuleBindings } from "./catalog-seed";
import { rematchCasesForTemplate, syncBoundCaseNames } from "./finance/demand-type-match";
import { decideRecordAuditRoute, recordNeedsHumanAudit } from "./record-audit-route";
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
import { listPriceMappings, recalculate, recalculateLedgers, repriceByPoIds, savePriceMapping } from "./finance/price-mapping";
import { DEFAULT_ASSESSMENT_SCORE_RULES } from "./finance/assessment-score-rule.catalog";
import { ASSESSMENT_EVENT_CATALOG, rankRewardAmount } from "./finance/assessment-event.catalog";

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
  if (method === "GET" && path === "auth/me") return getMe(need(user));
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
  if (method === "GET" && (path === "upload/qiniu-token" || path === "upload/token")) {
    const u = need(user);
    const filename = String(query.get("filename") || "photo.jpg");
    const contentType = String(query.get("contentType") || "image/jpeg");
    const token = createUploadToken(filename, u.id, { contentType });
    const domain =
      token.provider === "tianyi"
        ? (process.env.TIANYI_DOMAIN || "").replace(/\/$/, "")
        : (process.env.QINIU_DOMAIN || "").replace(/\/$/, "");
    const bucket =
      token.provider === "tianyi" ? process.env.TIANYI_BUCKET : process.env.QINIU_BUCKET;
    return ok({
      provider: token.provider,
      method: token.method,
      token: token.token,
      domain,
      uploadUrl: token.uploadUrl,
      bucket,
      key: token.key,
      publicUrl: token.publicUrl,
      headers: token.headers || {},
      contentType: token.contentType,
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
  if (path === "templates" && method === "POST") {
    needFinanceMgr(user);
    return saveTemplate(null, body);
  }
  {
    const m = match(path, "templates/:id");
    if (m && method === "PUT") {
      needFinanceMgr(user);
      return saveTemplate(m.id, body);
    }
    if (m && method === "DELETE") {
      needFinanceMgr(user);
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
    if (m && method === "POST") {
      needFinanceMgr(user);
      return cloneTemplate(m.id, body);
    }
  }

  if (path === "ai-hard-rules" && method === "GET") {
    await healBuiltinHardRuleBindings().catch(() => null);
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
  if (path === "devices" && method === "POST") {
    needFinanceMgr(user);
    return saveDevice(null, body);
  }
  {
    const h = match(path, "devices/:id/history");
    if (h && method === "GET") return deviceHistory(h.id);
    const m = match(path, "devices/:id");
    if (m && method === "PUT") {
      needFinanceMgr(user);
      return saveDevice(m.id, body);
    }
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
    if (m && method === "POST") return reviewExpense(m.id, true, body, needAdmin(user));
    const r = match(path, "cases/expenses/:id/reject");
    if (r && method === "POST") return reviewExpense(r.id, false, body, needAdmin(user));
  }
  if (path === "cases/assign-sites" && method === "POST") return assignSites(needAdmin(user), body);
  if (path === "cases/batch-create-tasks" && method === "POST") return batchCreateTasks(needFinanceMgr(user), body);
  {
    const m = match(path, "cases/:id/inspectors");
    if (m && method === "GET") return caseInspectors(m.id);
    const a = match(path, "cases/:id/assign");
    if (a && method === "POST") return assignCase(needFinanceMgr(user), a.id, body);
    const s = match(path, "cases/:id/site");
    if (s && method === "PUT") return setCaseSite(needAdmin(user), s.id, body);
    const t = match(path, "cases/:id/task-type");
    if (t && method === "PUT") return setCaseTaskType(needFinanceMgr(user), t.id, body);
    const w = match(path, "cases/:id/work-plan");
    if (w && method === "PUT") return setWorkPlan(needFinanceMgr(user), w.id, body);
    const p = match(path, "cases/:id/profile");
    if (p && method === "PATCH") return updateCaseProfile(needFinanceMgr(user), p.id, body);
    const st = match(path, "cases/:id/start");
    if (st && method === "POST") return startMyCase(need(user), st.id);
    const fin = match(path, "cases/:id/finish");
    if (fin && method === "POST") return finishMyCase(need(user), fin.id);
    const wd = match(path, "cases/:id/assignees/:inspectorId/withdraw");
    if (wd && method === "POST") return withdrawAssignee(needFinanceMgr(user), wd.id, wd.inspectorId);
    const cl = match(path, "cases/:id/units/:unitId/claim");
    if (cl && method === "POST") return claimUnit(need(user), cl.id, cl.unitId);
    const ucl = match(path, "cases/:id/units/:unitId/unclaim");
    if (ucl && method === "POST") return unclaimUnit(need(user), ucl.id, ucl.unitId);
    const cu = match(path, "cases/:id/units/:unitId/complete");
    if (cu && method === "POST") return completeUnit(need(user), cu.id, cu.unitId);
    const ocrMy = match(path, "cases/:id/my-expense/ocr-mileage");
    if (ocrMy && method === "POST") return ocrCaseMileage(body);
    const ocrUnit = match(path, "cases/:id/units/:unitId/expense/ocr-mileage");
    if (ocrUnit && method === "POST") return ocrCaseMileage(body);
    const ocrSerial = match(path, "cases/:id/units/:unitId/serial/ocr");
    if (ocrSerial && method === "POST") return ocrCaseSerial(body);
    const ex = match(path, "cases/:id/my-expense");
    if (ex && method === "POST") return saveExpense(need(user), ex.id, null, body);
    const uex = match(path, "cases/:id/units/:unitId/expense");
    if (uex && method === "POST") return saveExpense(need(user), uex.id, uex.unitId, body);
    const ser = match(path, "cases/:id/units/:unitId/serial");
    if (ser && method === "POST") return saveSerial(need(user), ser.id, ser.unitId, body);
    const expenses = match(path, "cases/:id/expenses");
    if (expenses && method === "POST") {
      const workUnitId = body.workUnitId ? String(body.workUnitId) : null;
      return saveExpense(need(user), expenses.id, workUnitId, body);
    }
    const workPhoto = match(path, "cases/:id/work-photo");
    if (workPhoto && method === "POST") return uploadPhoto(form, need(user));
    const workRecord = match(path, "cases/:id/work-record");
    if (workRecord && method === "PUT") return saveWorkRecord(need(user), body);
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
    if (m && method === "PUT") return updateTask(needFinanceMgr(user), m.id, body);
    const st = match(path, "tasks/:id/start");
    if (st && (method === "PUT" || method === "POST")) return startTask(need(user), st.id);
    const rm = match(path, "tasks/:id/remove");
    if (rm && method === "PUT") return removeTask(needFinanceMgr(user), rm.id);
  }

  if (path === "records" && method === "GET") return listRecords(query);
  if (path === "records/case-groups" && method === "GET") return recordCaseGroups(query);
  {
    const m = match(path, "records/by-case/:groupKey");
    if (m && method === "GET") return recordsByCase(m.groupKey, query);
    const d = match(path, "records/:id");
    if (d && method === "GET") return getRecord(d.id);
    const dr = match(path, "records/:id/draft");
    if (dr && method === "PUT") return saveDraft(need(user), dr.id, body);
    const sub = match(path, "records/:id/submit");
    if (sub && method === "PUT") return submitRecord(need(user), sub.id, body);
    const ap = match(path, "records/:id/approve");
    if (ap && method === "PUT") return approveRecord(needFinanceMgr(user), ap.id);
    const rj = match(path, "records/:id/reject");
    if (rj && method === "PUT") return rejectRecord(needFinanceMgr(user), rj.id, body);
    const man = match(path, "records/:id/entries/:entryId/manual-result");
    if (man && method === "PUT") return setManualResult(need(user), man.id, man.entryId, body);
  }
  if (path === "ai/analyze" && method === "POST") return runAnalyze(need(user), body);
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
    const ignoreFreeze = body.ignoreFreeze === true || query.get("ignoreFreeze") === "1";
    if (ignoreFreeze) {
      const all = await adminGql<{ po_orders: { id: string }[] }>(`query { po_orders { id } }`);
      return ok(
        await repriceByPoIds(
          all.po_orders.map((o) => o.id),
          { ignoreFreeze: true },
        ),
      );
    }
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
    if (ap && method === "POST") return reviewApprove(needAdmin(user), ap.id, body, true);
    const rj = match(path, "review/:id/reject");
    if (rj && method === "POST") return reviewApprove(needAdmin(user), rj.id, body, false);
  }

  if (path === "finance/dashboard" && method === "GET") {
    return ok(await getFinanceDashboard(need(user), query));
  }
  if (path === "finance/dashboard/variance" && method === "GET") {
    return ok(await getFinanceVariance(need(user), query));
  }

  if (path === "assessments" && method === "GET") return listAssessments(need(user), query);
  if (path === "assessments" && method === "POST") return saveAssessment(needFinanceMgr(user), body);
  if (path === "assessments/score-rule" && method === "GET") return scoreRule();
  if (path === "assessments/score-rule" && method === "POST") return saveScoreRule(needAdmin(user), body);
  if (path === "assessments/score" && method === "POST") return saveAssessmentScore(needFinanceMgr(user), body);
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
  if (path === "assessments/events" && method === "POST") return createEvent(needFinanceMgr(user), body);
  {
    const m = match(path, "assessments/events/:id");
    if (m && method === "DELETE") {
      needAdmin(user);
      await adminGql(`mutation ($id: uuid!) { delete_assessment_events_by_pk(id: $id) { id } }`, { id: m.id });
      return ok({ id: m.id });
    }
    const rk = match(path, "assessments/:month/rank");
    if (rk && method === "POST") return rankAssessments(needFinanceMgr(user), rk.month, body);
  }

  if (path === "monthly-settlements" && method === "GET") return listMonthly(needFinanceMgr(user), query);
  {
    const exp = match(path, "monthly-settlements/:month/export");
    if (exp && method === "GET") {
      // 薪资对账表/发薪表含全员薪酬，仅超管可导出
      const admin = needAdmin(user);
      return exportMonthly(admin, exp.month, query.get("template") || "reconcile");
    }
    const m = match(path, "monthly-settlements/:month/lock");
    if (m && method === "POST") {
      needAdmin(user);
      return lockMonth(m.month, true);
    }
    const u = match(path, "monthly-settlements/:month/unlock");
    if (u && method === "POST") {
      needAdmin(user);
      return lockMonth(u.month, false);
    }
    const c = match(path, "monthly-settlements/:month/correct");
    if (c && method === "POST") {
      const admin = needAdmin(user);
      return correctMonthly(admin, c.month, body);
    }
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
    employeeNo: u.employeeNo ?? null,
    role: u.role,
    roles: u.roles,
    status: u.status,
    region: u.region,
    orgUnit: u.orgUnit,
  };
}

/** 当前用户资料 + 可作业网格（H5 选站依赖 siteMemberships） */
async function getMe(user: AppUser) {
  const data = await adminGql<{
    site_members: Array<{
      id: string;
      site_id: string;
      status: string;
      member_role: string;
      site: {
        id: string;
        name: string;
        code: string;
        province: string | null;
        city: string | null;
      } | null;
    }>;
    as_manager: Array<{
      id: string;
      name: string;
      code: string;
      province: string | null;
      city: string | null;
    }>;
  }>(
    `query ($uid: uuid!) {
      site_members(
        where: {
          user_id: { _eq: $uid }
          status: { _eq: "active" }
          site: { deleted_at: { _is_null: true }, status: { _eq: "active" } }
        }
      ) {
        id site_id status member_role
        site { id name code province city }
      }
      as_manager: sites(
        where: {
          manager_id: { _eq: $uid }
          deleted_at: { _is_null: true }
          status: { _eq: "active" }
        }
      ) { id name code province city }
    }`,
    { uid: user.id },
  );

  const bySiteId = new Map<
    string,
    {
      id: string;
      siteId: string;
      status: string;
      site: {
        id: string;
        name: string;
        code: string;
        province?: string;
        city?: string;
      };
    }
  >();

  // 工程师编制优先；副网格长若无工程师行则不进作业站列表
  for (const m of data.site_members) {
    if (!m.site) continue;
    if (m.member_role !== "inspector") continue;
    bySiteId.set(m.site_id, {
      id: m.id,
      siteId: m.site_id,
      status: m.status,
      site: {
        id: m.site.id,
        name: m.site.name,
        code: m.site.code,
        province: m.site.province || undefined,
        city: m.site.city || undefined,
      },
    });
  }

  // 正网格长兼工程师：若尚未写入 site_members，仍用 manager 站点兜底（仅当前会话角色含工程师时）
  if (user.roles.includes("inspector") || user.role === "inspector") {
    for (const s of data.as_manager) {
      if (bySiteId.has(s.id)) continue;
      bySiteId.set(s.id, {
        id: `manager:${s.id}`,
        siteId: s.id,
        status: "active",
        site: {
          id: s.id,
          name: s.name,
          code: s.code,
          province: s.province || undefined,
          city: s.city || undefined,
        },
      });
    }
  }

  const siteMemberships = [...bySiteId.values()];
  return ok({
    ...toPublicUser(user),
    siteMemberships,
    membershipCount: siteMemberships.length,
    managedSites: data.as_manager.map((s) => ({
      id: s.id,
      name: s.name,
      code: s.code,
      province: s.province || undefined,
      city: s.city || undefined,
    })),
  });
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
    } else {
      for (const entry of Array.isArray(tpl.entries) ? tpl.entries : []) {
        push(tplId, tplName, "", "", entry);
      }
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
  const notes = String(body.judgeNotes || "").trim();
  const override = String(body.promptText || "").trim();
  if (pass || fail || notes) {
    return composeHardRulePrompt({
      name: String(body.name || fallbackName || "").trim(),
      passCriteria: pass,
      failCriteria: fail,
      judgeNotes: notes,
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
    inspection_records: {
      status: string;
      id: string;
      submitted_at?: string;
      device_type: string;
      entries?: unknown;
      task?: {
        task_name?: string;
        ai_enabled?: boolean | null;
        template_snapshot?: unknown;
      };
    }[];
    sites: Array<{ id: string; name: string; city: string; province: string; latitude: number; longitude: number; devices_aggregate: { aggregate: { count: number } } }>;
  }>(`query ($tw: inspection_tasks_bool_exp) {
    sites_aggregate(where: { deleted_at: { _is_null: true } }) { aggregate { count } }
    devices_aggregate { aggregate { count } }
    inspection_tasks(where: $tw) { status }
    inspection_records(where: { status: { _in: ["submitted","approved"] } }, order_by: { submitted_at: desc }, limit: 80) {
      id status submitted_at device_type entries
      task { task_name ai_enabled template_snapshot }
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
  const auditPending = recs.filter((r) =>
    recordNeedsHumanAudit({
      status: r.status,
      taskAiEnabled: r.task?.ai_enabled,
      templateSnapshot: (r.task?.template_snapshot || []) as Array<{
        id?: string;
        aiEnabled?: boolean;
        entryKind?: string;
        checkType?: string;
      }>,
      entries: (r.entries || []) as Array<{
        templateEntryId?: string;
        manualResult?: string | null;
        finalResult?: string | null;
        aiResult?: { status?: string } | null;
      }>,
    }),
  );
  return ok({
    sites: d.sites_aggregate.aggregate.count,
    devices: d.devices_aggregate.aggregate.count,
    tasks,
    records: {
      total: recs.length,
      submitted: recs.filter((r) => r.status === "submitted").length,
      approved: recs.filter((r) => r.status === "approved").length,
    },
    pendingAudit: auditPending.length,
    recentPending: auditPending.slice(0, 8).map((r) => ({
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
    completionRate: total ? Math.round((completed / total) * 100) : 0,
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
    passRate: 0,
    byDate: [],
    bySite: [],
    byDeviceType: [],
    byEntry: [],
    inspectorRanking: [],
  });
}

function shanghaiMonthKey(date = new Date()) {
  return date.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 7);
}

function shanghaiMonthBounds(month: string) {
  const [yy, mm] = month.split("-").map(Number);
  const from = `${month}-01T00:00:00+08:00`;
  const to =
    mm === 12
      ? `${yy + 1}-01-01T00:00:00+08:00`
      : `${yy}-${String(mm + 1).padStart(2, "0")}-01T00:00:00+08:00`;
  return { from, to };
}

function inspectorItemBucket(status: string) {
  if (status === "completed" || status === "approved" || status === "archived") return "completed";
  if (status === "submitted") return "submitted";
  if (status === "claimed" || status === "in_progress" || status === "draft") return "inProgress";
  if (status === "pending" || status === "open") return "pending";
  return "pending";
}

async function inspectorSummary(user: AppUser, query: URLSearchParams) {
  const month = /^\d{4}-\d{2}$/.test(query.get("month") || "")
    ? (query.get("month") as string)
    : shanghaiMonthKey();
  const { from, to } = shanghaiMonthBounds(month);

  const d = await adminGql<{
    case_work_units: Array<{
      id: string;
      status: string;
      inspection_task_id: string | null;
    }>;
    inspection_tasks: Array<{
      id: string;
      status: string;
      work_unit_id: string | null;
    }>;
    recent_tasks: Array<{
      id: string;
      task_name: string | null;
      status: string;
      completed_at: string | null;
      created_at: string;
      planned_date: string | null;
      site: { name: string } | null;
      device: { serial_number: string } | null;
    }>;
  }>(
    `query ($uid: uuid!, $from: timestamptz!, $to: timestamptz!) {
      case_work_units(where: {
        inspector_id: { _eq: $uid }
        _or: [
          { claimed_at: { _gte: $from, _lt: $to } }
          { submitted_at: { _gte: $from, _lt: $to } }
          { completed_at: { _gte: $from, _lt: $to } }
          { status: { _in: ["claimed", "submitted"] } }
        ]
      }) {
        id status inspection_task_id
      }
      inspection_tasks(
        where: {
          inspector_id: { _eq: $uid }
          _or: [
            { created_at: { _gte: $from, _lt: $to } }
            { started_at: { _gte: $from, _lt: $to } }
            { completed_at: { _gte: $from, _lt: $to } }
          ]
        }
      ) {
        id status work_unit_id
      }
      recent_tasks: inspection_tasks(
        where: { inspector_id: { _eq: $uid } }
        order_by: { created_at: desc }
        limit: 30
      ) {
        id task_name status completed_at created_at planned_date
        site { name }
        device { serial_number }
      }
    }`,
    { uid: user.id, from, to },
  );

  const units = d.case_work_units || [];
  const linkedTaskIds = new Set(units.map((u) => u.inspection_task_id).filter(Boolean) as string[]);
  const standaloneTasks = (d.inspection_tasks || []).filter(
    (t) => !t.work_unit_id && !linkedTaskIds.has(t.id),
  );

  let completed = 0;
  let inProgress = 0;
  let pending = 0;
  let submitted = 0;
  for (const item of [...units, ...standaloneTasks]) {
    const bucket = inspectorItemBucket(item.status);
    if (bucket === "completed") completed += 1;
    else if (bucket === "submitted") submitted += 1;
    else if (bucket === "inProgress") inProgress += 1;
    else pending += 1;
  }
  const total = completed + inProgress + pending + submitted;

  return ok({
    month: {
      total,
      completed,
      inProgress,
      pending,
      submitted,
      completionRate: total ? Math.round((completed / total) * 100) : 0,
    },
    recentTasks: (d.recent_tasks || []).map((t) => ({
      id: t.id,
      taskName: t.task_name || "巡检作业",
      status: t.status,
      siteName: t.site?.name || "",
      deviceSerial: t.device?.serial_number || "",
      plannedDate: t.planned_date || undefined,
      completedAt: t.completed_at || undefined,
      createdAt: t.created_at,
    })),
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

const MOBILE_CASE_NESTED = `
  case_work_units(order_by: { seq: asc }) {
    id seq title status inspector_id inspection_task_id device_serial serial_photo_url serial_confirmed_at
  }
  inspection_tasks(
    where: { inspector_id: { _eq: $uid } }
    order_by: { created_at: desc }
  ) {
    id status work_unit_id inspector_id
  }
  case_expense_claims(
    where: { inspector_id: { _eq: $uid } }
    order_by: { created_at: desc }
  ) {
    id service_case_id work_unit_id inspector_id amount claim_amount
    line_items voucher_urls trip_skipped note status review_note month created_at
  }
`;

function mapExpenseClaim(r: Record<string, unknown>) {
  return {
    id: String(r.id),
    workUnitId: (r.work_unit_id as string) || null,
    inspectorId: (r.inspector_id as string) || undefined,
    amount: String(r.amount ?? 0),
    claimAmount: String(r.claim_amount ?? r.amount ?? 0),
    note: (r.note as string) || null,
    lineItems: Array.isArray(r.line_items) ? r.line_items : [],
    voucherUrls: Array.isArray(r.voucher_urls) ? r.voucher_urls : [],
    tripSkipped: !!r.trip_skipped,
    status: String(r.status || "draft"),
    reviewNote: (r.review_note as string) || null,
  };
}

function sumExpenseLineAmount(lineItems: unknown): number {
  if (!Array.isArray(lineItems)) return 0;
  let total = 0;
  for (const raw of lineItems) {
    const line = (raw || {}) as { amount?: unknown };
    const n = Number(line.amount);
    if (Number.isFinite(n)) total += n;
  }
  return Math.round(total * 100) / 100;
}

async function myCases(user: AppUser) {
  const d = await adminGql<{ case_assignments: Array<{ service_case: Record<string, unknown> | null }> }>(
    `query ($uid: uuid!) {
      case_assignments(where: { inspector_id: { _eq: $uid }, status: { _neq: "withdrawn" } }) {
        service_case { ${CASE_FIELDS}
          ${MOBILE_CASE_NESTED}
        }
      }
    }`,
    { uid: user.id },
  );
  const list = d.case_assignments
    .map((a) => a.service_case)
    .filter(Boolean)
    .map((row) => mapMobileCase(row as Record<string, unknown>, user.id));
  return ok(list);
}

async function ensureCaseWorkUnits(caseId: string, plannedUnits: number) {
  const planned = Math.max(1, Number(plannedUnits) || 1);
  const existing = await adminGql<{ case_work_units_aggregate: { aggregate: { count: number } } }>(
    `query ($id: uuid!) {
      case_work_units_aggregate(where: { service_case_id: { _eq: $id } }) { aggregate { count } }
    }`,
    { id: caseId },
  );
  const count = existing.case_work_units_aggregate.aggregate.count || 0;
  if (count >= planned) return false;
  const objects = [];
  for (let seq = count + 1; seq <= planned; seq++) {
    objects.push({
      service_case_id: caseId,
      seq,
      title: `第${seq}台`,
      status: "open",
    });
  }
  await adminGql(
    `mutation ($objects: [case_work_units_insert_input!]!) {
      insert_case_work_units(objects: $objects) { affected_rows }
    }`,
    { objects },
  );
  return true;
}

function mapMobileCaseUnits(
  rows: Record<string, unknown>[],
  userId: string,
) {
  const units = rows.map((u) => ({
    id: String(u.id),
    seq: Number(u.seq) || 0,
    title: (u.title as string) || null,
    status: String(u.status || "open"),
    inspectorId: (u.inspector_id as string) || null,
    inspectionTaskId: (u.inspection_task_id as string) || null,
    deviceSerial: (u.device_serial as string) || null,
    serialPhotoUrl: (u.serial_photo_url as string) || null,
    serialConfirmedAt: (u.serial_confirmed_at as string) || null,
  }));
  const myActiveUnits = units.filter(
    (u) =>
      u.inspectorId === userId &&
      (u.status === "claimed" || u.status === "submitted"),
  );
  return {
    units,
    workUnits: units,
    activeUnit: myActiveUnits[0] || null,
    myActiveUnits,
  };
}

function mapMobileCase(row: Record<string, unknown>, userId: string) {
  const mapped = mapCase(row);
  const rawUnits = ((row.case_work_units as Record<string, unknown>[]) || []);
  const unitPack = mapMobileCaseUnits(rawUnits, userId);
  const tasks = ((row.inspection_tasks as Record<string, unknown>[]) || []).map((t) => ({
    id: String(t.id),
    status: String(t.status || "pending"),
    workUnitId: (t.work_unit_id as string) || null,
  }));
  const byActiveUnit = unitPack.activeUnit?.inspectionTaskId
    ? tasks.find((t) => t.id === unitPack.activeUnit!.inspectionTaskId)
    : null;
  const mine = byActiveUnit || tasks.find((t) => !t.workUnitId) || tasks[0] || null;
  const status = mine?.status || null;
  const expenses = ((row.case_expense_claims as Record<string, unknown>[]) || []).map(mapExpenseClaim);
  const approved = expenses.filter((e) => e.status === "approved");
  const submitted = expenses.filter((e) => e.status === "submitted" || e.status === "approved");
  const doneFromUnits = unitPack.units.filter((u) => u.status === "completed").length;
  // 有台次明细时以实计为准，避免 case.completed_units 未同步导致一直 0/N
  const completedUnits = unitPack.units.length
    ? doneFromUnits
    : Number(mapped.completedUnits) || 0;
  return {
    ...mapped,
    ...unitPack,
    completedUnits,
    expenses,
    expenseSummary: {
      totalAmount: money(expenses.reduce((s, e) => s + Number(e.claimAmount || e.amount || 0), 0)),
      approvedAmount: money(approved.reduce((s, e) => s + Number(e.amount || 0), 0)),
      submittedAmount: money(submitted.reduce((s, e) => s + Number(e.claimAmount || e.amount || 0), 0)),
      count: expenses.length,
    },
    inspectionTaskId: mine?.id || unitPack.activeUnit?.inspectionTaskId || null,
    inspectionTaskStatus: status,
    inspectionDone: status === "submitted" || status === "approved",
  };
}

/** 按案例产品线取检查项快照；勿把所有产品线条目拼在一起 */
async function loadTemplateSnapshot(
  templateId: string | null | undefined,
  productLine?: string | null,
) {
  if (!templateId) return [] as unknown[];
  const d = await adminGql<{
    inspection_templates_by_pk: { entries: unknown; product_lines: unknown } | null;
  }>(
    `query ($id: uuid!) {
      inspection_templates_by_pk(id: $id) { entries product_lines }
    }`,
    { id: templateId },
  );
  const tpl = d.inspection_templates_by_pk;
  if (!tpl) return [];
  const lines = Array.isArray(tpl.product_lines) ? tpl.product_lines : [];
  const want = String(productLine || "").trim();
  if (lines.length) {
    const hit = want
      ? lines.find((p) => String((p as { name?: string })?.name || "").trim() === want)
      : null;
    const line = (hit || (lines.length === 1 ? lines[0] : null)) as
      | { entries?: unknown }
      | null;
    if (line && Array.isArray(line.entries)) return line.entries;
    // 有产品线配置但案例未匹配到：不回落成「全部拼一起」
    if (want) return [];
  }
  if (Array.isArray(tpl.entries) && tpl.entries.length) return tpl.entries;
  return [];
}

/** 单人单台：开工时若尚无 inspection_tasks，补建并挂到第 1 台 */
async function ensureInspectorInspectionTask(
  user: AppUser,
  caseId: string,
  row: Record<string, unknown>,
) {
  const planned = Math.max(1, Number(row.planned_units) || 1);
  const assignMode = String(row.assign_mode || "single");
  await ensureCaseWorkUnits(caseId, planned);

  const existing = await adminGql<{
    inspection_tasks: Array<{ id: string }>;
  }>(
    `query ($cid: uuid!, $uid: uuid!) {
      inspection_tasks(
        where: { service_case_id: { _eq: $cid }, inspector_id: { _eq: $uid } }
        order_by: { created_at: desc }
        limit: 1
      ) { id }
    }`,
    { cid: caseId, uid: user.id },
  );
  if (existing.inspection_tasks[0]?.id) {
    const tid = existing.inspection_tasks[0].id;
    const cur = await adminGql<{ inspection_tasks_by_pk: Record<string, unknown> | null }>(
      `query ($id: uuid!) {
        inspection_tasks_by_pk(id: $id) {
          id service_case_id work_unit_id inspector_id
        }
      }`,
      { id: tid },
    );
    if (cur.inspection_tasks_by_pk) await healTaskWorkUnitLink(cur.inspection_tasks_by_pk);
    return tid;
  }

  // 多人认领 / 多台：必须走认领，不自动建任务
  if (assignMode === "multi" || planned > 1) return null;
  if (!row.site_id) throw new HttpError(400, "案例未分配网格");

  const units = await adminGql<{
    case_work_units: Array<{ id: string; inspection_task_id: string | null; status: string }>;
  }>(
    `query ($id: uuid!) {
      case_work_units(where: { service_case_id: { _eq: $id } }, order_by: { seq: asc }, limit: 1) {
        id inspection_task_id status
      }
    }`,
    { id: caseId },
  );
  const unit = units.case_work_units[0] || null;
  const snap = await loadTemplateSnapshot(
    row.task_template_id as string | null,
    row.product_line as string | null,
  );

  const task = await adminGql<{ insert_inspection_tasks_one: { id: string } }>(
    `mutation ($obj: inspection_tasks_insert_input!) {
      insert_inspection_tasks_one(object: $obj) { id }
    }`,
    {
      obj: {
        site_id: row.site_id,
        task_name: `${row.gsp_case_no} ${row.project_name}`,
        inspector_id: user.id,
        created_by_id: user.id,
        service_case_id: caseId,
        work_unit_id: unit?.id || null,
        task_type: "service",
        status: "pending",
        ai_enabled: true,
        template_snapshot: snap,
      },
    },
  );
  const taskId = task.insert_inspection_tasks_one.id;
  if (unit && !unit.inspection_task_id) {
    await adminGql(
      `mutation ($id: uuid!, $uid: uuid!, $tid: uuid!, $now: timestamptz!) {
        update_case_work_units_by_pk(pk_columns: { id: $id }, _set: {
          status: "claimed", inspector_id: $uid, inspection_task_id: $tid, claimed_at: $now
        }) { id }
      }`,
      { id: unit.id, uid: user.id, tid: taskId, now: new Date().toISOString() },
    );
  }
  return taskId;
}

async function loadMyCaseData(user: AppUser, id: string) {
  const d = await adminGql<{
    case_assignments: Array<{ service_case: Record<string, unknown> | null }>;
  }>(
    `query ($uid: uuid!, $cid: uuid!) {
      case_assignments(
        where: {
          inspector_id: { _eq: $uid }
          service_case_id: { _eq: $cid }
          status: { _neq: "withdrawn" }
        }
        limit: 1
      ) {
        service_case { ${CASE_FIELDS}
          ${MOBILE_CASE_NESTED}
        }
      }
    }`,
    { uid: user.id, cid: id },
  );
  let row = d.case_assignments[0]?.service_case;
  if (!row) throw new HttpError(404, "案例不存在或无权查看");

  const planned = Math.max(1, Number(row.planned_units) || 1);
  const created = await ensureCaseWorkUnits(id, planned);
  if (created) {
    const again = await adminGql<{
      case_work_units: Record<string, unknown>[];
      inspection_tasks: Record<string, unknown>[];
      case_expense_claims: Record<string, unknown>[];
    }>(
      `query ($id: uuid!, $uid: uuid!) {
        case_work_units(where: { service_case_id: { _eq: $id } }, order_by: { seq: asc }) {
          id seq title status inspector_id inspection_task_id device_serial serial_photo_url serial_confirmed_at
        }
        inspection_tasks(
          where: { service_case_id: { _eq: $id }, inspector_id: { _eq: $uid } }
          order_by: { created_at: desc }
        ) { id status work_unit_id inspector_id }
        case_expense_claims(
          where: { service_case_id: { _eq: $id }, inspector_id: { _eq: $uid } }
          order_by: { created_at: desc }
        ) {
          id service_case_id work_unit_id inspector_id amount claim_amount
          line_items voucher_urls trip_skipped note status review_note month created_at
        }
      }`,
      { id, uid: user.id },
    );
    row = {
      ...row,
      case_work_units: again.case_work_units,
      inspection_tasks: again.inspection_tasks,
      case_expense_claims: again.case_expense_claims,
    };
  }

  return mapMobileCase(row, user.id);
}

async function myCase(user: AppUser, id: string) {
  const data = await loadMyCaseData(user, id);
  const units = data.units || [];
  if (!units.length) return ok(data);
  const doneFromUnits = units.filter((u: { status: string }) => u.status === "completed").length;
  const stored = Number((await loadCase(id))?.completed_units || 0);
  if (doneFromUnits !== stored) {
    await syncCaseUnitProgress(id);
    return ok(await loadMyCaseData(user, id));
  }
  return ok(data);
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
  if (user.role === "site_manager") {
    // 越权防护：网格长只能给本人管理（正/副）的网格派单
    const manages = await adminGql<{
      sites: Array<{ id: string }>;
      site_members: Array<{ id: string }>;
    }>(
      `query ($sid: uuid!, $uid: uuid!) {
        sites(where: { id: { _eq: $sid }, manager_id: { _eq: $uid } }, limit: 1) { id }
        site_members(
          where: { site_id: { _eq: $sid }, user_id: { _eq: $uid }, member_role: { _eq: "deputy_manager" }, status: { _eq: "active" } }
          limit: 1
        ) { id }
      }`,
      { sid: row.site_id, uid: user.id },
    );
    if (!manages.sites.length && !manages.site_members.length) {
      throw new HttpError(403, "只能给本人管理的网格派单");
    }
    // 越权防护：被指派的工程师必须在本网格编制内（含正网格长兼任工程师场景）
    const memberRows = await adminGql<{ site_members: Array<{ user_id: string }> }>(
      `query ($sid: uuid!, $uids: [uuid!]!) {
        site_members(where: { site_id: { _eq: $sid }, user_id: { _in: $uids }, status: { _eq: "active" } }) { user_id }
      }`,
      { sid: row.site_id, uids: ids },
    );
    const memberSet = new Set(memberRows.site_members.map((m) => m.user_id));
    const siteRow = await adminGql<{ sites_by_pk: { manager_id: string | null } | null }>(
      `query ($id: uuid!) { sites_by_pk(id: $id) { manager_id } }`,
      { id: row.site_id },
    );
    if (siteRow.sites_by_pk?.manager_id) memberSet.add(siteRow.sites_by_pk.manager_id);
    const outsiders = ids.filter((id) => !memberSet.has(id));
    if (outsiders.length) throw new HttpError(400, "所选工程师不在本网格编制内");
  }
  if (!row.task_template_id && !row.task_type) throw new HttpError(400, "请先设置案例服务类型");
  const assignMode = (body.assignMode as string) || (row.assign_mode as string) || "single";
  const plannedUnits = Math.max(1, Number(body.plannedUnits ?? row.planned_units ?? 1));
  const remark = body.reason !== undefined ? String(body.reason || "").trim() : row.assign_remark;
  const tpl = row.task_template as {
    id?: string;
    name?: string;
    entries?: unknown[];
    product_lines?: unknown[];
    device_type?: string;
  } | null;

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

  await ensureCaseWorkUnits(caseId, plannedUnits);

  if (assignMode === "single" && ids.length === 1 && plannedUnits <= 1) {
    const snap = await loadTemplateSnapshot(
      (row.task_template_id as string) || tpl?.id || null,
      row.product_line as string | null,
    );
    const units = await adminGql<{
      case_work_units: Array<{ id: string }>;
    }>(
      `query ($id: uuid!) {
        case_work_units(where: { service_case_id: { _eq: $id } }, order_by: { seq: asc }, limit: 1) {
          id
        }
      }`,
      { id: caseId },
    );
    const unitId = units.case_work_units[0]?.id || null;
    const created = await adminGql<{ insert_inspection_tasks_one: { id: string } }>(
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
          work_unit_id: unitId,
          task_type: "service",
          status: "pending",
          ai_enabled: true,
          template_snapshot: snap,
        },
      },
    );
    if (unitId) {
      await adminGql(
        `mutation ($id: uuid!, $uid: uuid!, $tid: uuid!, $now: timestamptz!) {
          update_case_work_units_by_pk(pk_columns: { id: $id }, _set: {
            status: "claimed", inspector_id: $uid, inspection_task_id: $tid, claimed_at: $now
          }) { id }
        }`,
        {
          id: unitId,
          uid: ids[0],
          tid: created.insert_inspection_tasks_one.id,
          now: new Date().toISOString(),
        },
      );
    }
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

async function setWorkPlan(user: AppUser, caseId: string, body: Record<string, unknown>) {
  const planned =
    body.plannedUnits != null ? Math.max(1, Number(body.plannedUnits) || 1) : undefined;
  await adminGql(
    `mutation ($id: uuid!, $set: service_cases_set_input!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: caseId,
      set: {
        planned_units: planned,
        expense_enabled: body.expenseEnabled,
      },
    },
  );
  if (planned != null) {
    await ensureCaseWorkUnits(caseId, planned);
  }
  return ok(mapCase((await loadCase(caseId))!));
}

async function updateCaseProfile(user: AppUser, caseId: string, body: Record<string, unknown>) {
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

async function withdrawAssignee(user: AppUser, caseId: string, inspectorId: string) {
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
  const row = await loadCase(caseId);
  if (row) await ensureInspectorInspectionTask(user, caseId, row);
  return myCase(user, caseId);
}

async function finishMyCase(user: AppUser, caseId: string) {
  await adminGql(
    `mutation ($id: uuid!, $now: timestamptz!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: { status: "settle_review", finish_time: $now }) { id }
    }`,
    { id: caseId, now: new Date().toISOString() },
  );
  // 完工后刷新绩效台账，供结算审核/我的收入使用
  await recalculateLedgers([caseId]).catch(() => null);
  return myCase(user, caseId);
}

async function claimUnit(user: AppUser, caseId: string, unitId: string) {
  const row = await loadCase(caseId);
  if (!row?.site_id) throw new HttpError(400, "案例未分配网格");
  const unitRow = await adminGql<{
    case_work_units_by_pk: {
      id: string;
      status: string;
      inspector_id: string | null;
      service_case_id: string;
    } | null;
  }>(
    `query ($id: uuid!) {
      case_work_units_by_pk(id: $id) { id status inspector_id service_case_id }
    }`,
    { id: unitId },
  );
  const unit = unitRow.case_work_units_by_pk;
  if (!unit || unit.service_case_id !== caseId) throw new HttpError(404, "作业单元不存在");
  if (unit.status !== "open") throw new HttpError(400, "该台已被认领或不可认领");

  const snap = await loadTemplateSnapshot(
    row.task_template_id as string | null,
    row.product_line as string | null,
  );
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
        template_snapshot: snap,
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
  return ok({
    inspectionTaskId: task.insert_inspection_tasks_one.id,
    case: await loadMyCaseData(user, caseId),
  });
}

/** 取消认领：仅本人认领、未确认序列号、检查项无照片时可退回可认领池 */
async function unclaimUnit(user: AppUser, caseId: string, unitId: string) {
  const unitRow = await adminGql<{
    case_work_units_by_pk: {
      id: string;
      status: string;
      inspector_id: string | null;
      inspection_task_id: string | null;
      device_serial: string | null;
      serial_photo_url: string | null;
      serial_confirmed_at: string | null;
      service_case_id: string;
    } | null;
  }>(
    `query ($id: uuid!) {
      case_work_units_by_pk(id: $id) {
        id status inspector_id inspection_task_id
        device_serial serial_photo_url serial_confirmed_at service_case_id
      }
    }`,
    { id: unitId },
  );
  const unit = unitRow.case_work_units_by_pk;
  if (!unit || unit.service_case_id !== caseId) throw new HttpError(404, "作业单元不存在");
  if (unit.inspector_id !== user.id) throw new HttpError(403, "只能取消自己认领的台次");
  if (unit.status !== "claimed") {
    throw new HttpError(400, unit.status === "open" ? "该台尚未认领" : "已提交或已完成，不能取消认领");
  }
  if (unit.device_serial || unit.serial_confirmed_at || unit.serial_photo_url) {
    throw new HttpError(400, "已录入序列号或铭牌照片，不能取消认领");
  }

  const taskId = unit.inspection_task_id;
  if (taskId) {
    const taskData = await adminGql<{
      inspection_tasks_by_pk: {
        id: string;
        status: string;
        inspector_id: string | null;
        inspection_records: Array<{ status: string; entries: unknown }>;
      } | null;
    }>(
      `query ($id: uuid!) {
        inspection_tasks_by_pk(id: $id) {
          id status inspector_id
          inspection_records { status entries }
        }
      }`,
      { id: taskId },
    );
    const task = taskData.inspection_tasks_by_pk;
    if (task) {
      if (task.inspector_id && task.inspector_id !== user.id) {
        throw new HttpError(403, "只能取消自己的作业");
      }
      if (task.status === "submitted" || task.status === "approved") {
        throw new HttpError(400, "作业已提交，不能取消认领");
      }
      for (const rec of task.inspection_records || []) {
        if (rec.status !== "draft") {
          throw new HttpError(400, "作业记录已提交，不能取消认领");
        }
        const entries = Array.isArray(rec.entries) ? rec.entries : [];
        const hasPhotos = entries.some((e) => {
          const photos = (e as { photos?: unknown })?.photos;
          return Array.isArray(photos) && photos.length > 0;
        });
        if (hasPhotos) throw new HttpError(400, "已上传检查照片，不能取消认领");
      }
    }

    // 先断开单元对任务的引用，再删任务（记录级联删除）
    await adminGql(
      `mutation ($id: uuid!) {
        update_case_work_units_by_pk(pk_columns: { id: $id }, _set: {
          status: "open",
          inspector_id: null,
          inspection_task_id: null,
          claimed_at: null,
          device_serial: null,
          serial_photo_url: null,
          serial_confirmed_at: null
        }) { id }
      }`,
      { id: unitId },
    );
    await adminGql(
      `mutation ($id: uuid!) { delete_inspection_tasks_by_pk(id: $id) { id } }`,
      { id: taskId },
    );
  } else {
    await adminGql(
      `mutation ($id: uuid!) {
        update_case_work_units_by_pk(pk_columns: { id: $id }, _set: {
          status: "open",
          inspector_id: null,
          inspection_task_id: null,
          claimed_at: null,
          device_serial: null,
          serial_photo_url: null,
          serial_confirmed_at: null
        }) { id }
      }`,
      { id: unitId },
    );
  }

  return ok(await loadMyCaseData(user, caseId));
}

async function syncCaseUnitProgress(caseId: string) {
  const d = await adminGql<{
    service_cases_by_pk: {
      id: string;
      status: string;
      planned_units: number | null;
    } | null;
    case_work_units: Array<{ id: string; status: string; inspector_id: string | null }>;
  }>(
    `query ($id: uuid!) {
      service_cases_by_pk(id: $id) { id status planned_units }
      case_work_units(where: { service_case_id: { _eq: $id } }) {
        id status inspector_id
      }
    }`,
    { id: caseId },
  );
  const row = d.service_cases_by_pk;
  if (!row) return { completed: 0, planned: 1, finished: false };
  const planned = Math.max(1, Number(row.planned_units) || 1);
  const units = d.case_work_units || [];
  const completed = units.filter((u) => u.status === "completed").length;

  const byInspector = new Map<string, number>();
  for (const u of units) {
    if (u.status !== "completed" || !u.inspector_id) continue;
    byInspector.set(u.inspector_id, (byInspector.get(u.inspector_id) || 0) + 1);
  }
  for (const [uid, n] of byInspector) {
    await adminGql(
      `mutation ($cid: uuid!, $uid: uuid!, $n: Int!) {
        update_case_assignments(
          where: {
            service_case_id: { _eq: $cid }
            inspector_id: { _eq: $uid }
            status: { _neq: "withdrawn" }
          }
          _set: { completed_units: $n }
        ) { affected_rows }
      }`,
      { cid: caseId, uid, n },
    );
  }

  const shouldFinish =
    completed >= planned && ["assigned", "working"].includes(String(row.status || ""));
  if (shouldFinish) {
    await adminGql(
      `mutation ($id: uuid!, $n: Int!, $now: timestamptz!) {
        update_service_cases_by_pk(
          pk_columns: { id: $id }
          _set: { status: "settle_review", finish_time: $now, completed_units: $n }
        ) { id }
      }`,
      { id: caseId, n: completed, now: new Date().toISOString() },
    );
    await recalculateLedgers([caseId]).catch(() => null);
  } else {
    await adminGql(
      `mutation ($id: uuid!, $n: Int!) {
        update_service_cases_by_pk(pk_columns: { id: $id }, _set: { completed_units: $n }) { id }
      }`,
      { id: caseId, n: completed },
    );
  }

  return { completed, planned, finished: shouldFinish };
}

async function completeUnit(user: AppUser, caseId: string, unitId: string) {
  const unitRow = await adminGql<{
    case_work_units_by_pk: {
      id: string;
      status: string;
      inspector_id: string | null;
      service_case_id: string;
    } | null;
  }>(
    `query ($id: uuid!) {
      case_work_units_by_pk(id: $id) { id status inspector_id service_case_id }
    }`,
    { id: unitId },
  );
  const unit = unitRow.case_work_units_by_pk;
  if (!unit || unit.service_case_id !== caseId) throw new HttpError(404, "作业单元不存在");
  if (unit.inspector_id && unit.inspector_id !== user.id) {
    throw new HttpError(403, "只能完成自己认领的台次");
  }

  if (unit.status !== "completed") {
    await adminGql(
      `mutation ($id: uuid!, $now: timestamptz!) {
        update_case_work_units_by_pk(pk_columns: { id: $id }, _set: {
          status: "completed", completed_at: $now
        }) { id }
      }`,
      { id: unitId, now: new Date().toISOString() },
    );
  }

  await syncCaseUnitProgress(caseId);
  return myCase(user, caseId);
}

function normalizeDeviceSerial(raw: string) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

async function saveSerial(user: AppUser, caseId: string, unitId: string, body: Record<string, unknown>) {
  const deviceSerial = normalizeDeviceSerial(String(body.deviceSerial || body.serial || ""));
  if (deviceSerial.length < 4) throw new HttpError(400, "请填写至少 4 位的设备序列号");
  const unitRow = await adminGql<{
    case_work_units_by_pk: {
      id: string;
      seq: number;
      inspector_id: string | null;
      service_case_id: string;
      status: string;
    } | null;
    case_work_units: Array<{ id: string; seq: number; device_serial: string | null; status: string }>;
  }>(
    `query ($id: uuid!, $cid: uuid!) {
      case_work_units_by_pk(id: $id) { id seq inspector_id service_case_id status }
      case_work_units(
        where: {
          service_case_id: { _eq: $cid }
          id: { _neq: $id }
          status: { _neq: "cancelled" }
          device_serial: { _is_null: false }
        }
      ) { id seq device_serial status }
    }`,
    { id: unitId, cid: caseId },
  );
  const unit = unitRow.case_work_units_by_pk;
  if (!unit || unit.service_case_id !== caseId) throw new HttpError(404, "作业单元不存在");
  if (unit.inspector_id && unit.inspector_id !== user.id && user.role === "inspector") {
    throw new HttpError(403, "只能填写本人认领台的序列号");
  }
  const dup = unitRow.case_work_units.find(
    (row) => normalizeDeviceSerial(row.device_serial || "") === deviceSerial,
  );
  if (dup) {
    throw new HttpError(400, `序列号 ${deviceSerial} 已用于本案例台 #${dup.seq}，同一案例不能录两台相同设备`);
  }
  const serialPhotoUrl = (body.serialPhotoUrl || body.photoUrl || null) as string | null;
  const now = new Date().toISOString();
  const d = await adminGql<{
    update_case_work_units_by_pk: {
      id: string;
      seq: number;
      device_serial: string | null;
      serial_photo_url: string | null;
      serial_confirmed_at: string | null;
    } | null;
  }>(
    `mutation ($id: uuid!, $set: case_work_units_set_input!) {
      update_case_work_units_by_pk(pk_columns: { id: $id }, _set: $set) {
        id seq device_serial serial_photo_url serial_confirmed_at
      }
    }`,
    {
      id: unitId,
      set: {
        device_serial: deviceSerial || null,
        serial_photo_url: serialPhotoUrl,
        serial_confirmed_at: now,
      },
    },
  );
  const row = d.update_case_work_units_by_pk;
  if (!row) throw new HttpError(404, "作业单元不存在");
  return ok({
    id: row.id,
    seq: row.seq,
    deviceSerial: row.device_serial || deviceSerial,
    serialPhotoUrl: row.serial_photo_url,
    serialConfirmedAt: row.serial_confirmed_at || now,
  });
}

async function ocrCaseMileage(body: Record<string, unknown>) {
  const imageUrl = String(body.imageUrl || body.url || "").trim();
  if (!imageUrl) throw new HttpError(400, "请先上传里程表照片");
  const kind = String(body.kind || "start");
  const result = await ocrMileageFromImage(imageUrl, kind);
  return ok(result);
}

async function ocrCaseSerial(body: Record<string, unknown>) {
  const imageUrl = String(body.imageUrl || body.url || "").trim();
  if (!imageUrl) throw new HttpError(400, "请先上传序列号照片");
  const result = await ocrDeviceSerialFromImage(imageUrl);
  return ok(result);
}

/** 旧版作业记录接口占位（行程费用已迁到 my-expense） */
async function saveWorkRecord(user: AppUser, body: Record<string, unknown>) {
  return ok({
    workload: body.workload || {},
    mileage: String(body.mileage ?? ""),
    expenses: String(body.expenses ?? ""),
    expenseNote: body.expenseNote || "",
    mileageScreenshotUrls: Array.isArray(body.mileageScreenshotUrls)
      ? body.mileageScreenshotUrls
      : [],
    workNote: body.workNote || "",
  });
}

async function saveExpense(user: AppUser, caseId: string, unitId: string | null, body: Record<string, unknown>) {
  const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
  const voucherUrls = Array.isArray(body.voucherUrls) ? body.voucherUrls : [];
  const fromLines = sumExpenseLineAmount(lineItems);
  const amount = Number(body.amount ?? body.claimAmount ?? fromLines ?? 0);
  const tripSkipped = !!body.tripSkipped;
  const note = body.note != null ? String(body.note) : null;
  const wantSubmit = body.submit === true || body.submit === "true";
  const workUnitId = unitId || (body.workUnitId ? String(body.workUnitId) : null);

  const existing = await adminGql<{
    case_expense_claims: Array<{ id: string; status: string }>;
  }>(
    `query ($cid: uuid!, $uid: uuid!) {
      case_expense_claims(
        where: { service_case_id: { _eq: $cid }, inspector_id: { _eq: $uid } }
        order_by: { created_at: desc }
        limit: 5
      ) { id status }
    }`,
    { cid: caseId, uid: user.id },
  );
  const open = existing.case_expense_claims.find((c) =>
    ["draft", "rejected"].includes(String(c.status)),
  );
  const locked = existing.case_expense_claims.find((c) =>
    ["submitted", "approved"].includes(String(c.status)),
  );
  if (locked && !open) {
    throw new HttpError(400, "费用已提交或已通过，暂不可修改；驳回后可再改");
  }

  const nextStatus = wantSubmit ? "submitted" : "draft";
  const set = {
    work_unit_id: workUnitId,
    amount,
    claim_amount: amount,
    line_items: lineItems,
    voucher_urls: voucherUrls,
    trip_skipped: tripSkipped,
    note,
    status: nextStatus,
    month: new Date().toISOString().slice(0, 7),
    ...(wantSubmit
      ? {}
      : { review_by_id: null, review_at: null, review_note: null }),
  };

  const fields = `
    id service_case_id work_unit_id inspector_id amount claim_amount
    line_items voucher_urls trip_skipped note status review_note month created_at
  `;

  let row: Record<string, unknown>;
  if (open) {
    const upd = await adminGql<{ update_case_expense_claims_by_pk: Record<string, unknown> | null }>(
      `mutation ($id: uuid!, $set: case_expense_claims_set_input!) {
        update_case_expense_claims_by_pk(pk_columns: { id: $id }, _set: $set) { ${fields} }
      }`,
      { id: open.id, set },
    );
    if (!upd.update_case_expense_claims_by_pk) throw new HttpError(404, "费用单不存在");
    row = upd.update_case_expense_claims_by_pk;
  } else {
    const ins = await adminGql<{ insert_case_expense_claims_one: Record<string, unknown> }>(
      `mutation ($obj: case_expense_claims_insert_input!) {
        insert_case_expense_claims_one(object: $obj) { ${fields} }
      }`,
      {
        obj: {
          service_case_id: caseId,
          inspector_id: user.id,
          ...set,
        },
      },
    );
    row = ins.insert_case_expense_claims_one;
  }

  return ok(mapExpenseClaim(row));
}

async function pendingExpenses(query: URLSearchParams) {
  const statusParam = String(query.get("status") || "pending").trim();
  // 前端「待审核」传 pending；库内提交态为 submitted
  const statusWhere =
    statusParam === "all"
      ? { _neq: "draft" }
      : statusParam === "pending"
        ? { _eq: "submitted" }
        : { _eq: statusParam };

  const and: Record<string, unknown>[] = [{ status: statusWhere }];
  const keyword = String(query.get("keyword") || "").trim();
  if (keyword) {
    and.push({
      _or: [
        { note: { _ilike: `%${keyword}%` } },
        { service_case: { gsp_case_no: { _ilike: `%${keyword}%` } } },
        { service_case: { project_name: { _ilike: `%${keyword}%` } } },
        { inspector: { real_name: { _ilike: `%${keyword}%` } } },
      ],
    });
  }
  const month = String(query.get("month") || "").trim();
  if (month) and.push({ month: { _eq: month.slice(0, 7) } });

  const d = await adminGql<{
    case_expense_claims: Array<Record<string, unknown>>;
  }>(
    `query ($where: case_expense_claims_bool_exp!) {
      case_expense_claims(where: $where, order_by: { created_at: desc }, limit: 500) {
        id service_case_id work_unit_id inspector_id amount claim_amount
        line_items voucher_urls trip_skipped note status month review_note review_at created_at
        inspector { id real_name }
        service_case {
          id gsp_case_no project_name unit_label completed_units
          case_work_units { id status inspector_id }
          case_expense_claims { id claim_amount amount status }
        }
      }
    }`,
    { where: { _and: and } },
  );

  return ok(
    d.case_expense_claims.map((r) => {
      const sc = (r.service_case || {}) as {
        id?: string;
        gsp_case_no?: string;
        project_name?: string;
        unit_label?: string;
        completed_units?: number;
        case_work_units?: Array<{ status?: string; inspector_id?: string }>;
        case_expense_claims?: Array<{
          claim_amount?: unknown;
          amount?: unknown;
          status?: string;
        }>;
      };
      const inspectorId = String(r.inspector_id || "");
      const units = sc.case_work_units || [];
      const completedUnits = units.filter(
        (u) =>
          u.inspector_id === inspectorId &&
          (u.status === "completed" || u.status === "submitted"),
      ).length;
      const caseExpenseTotal = (sc.case_expense_claims || [])
        .filter((e) => ["submitted", "approved", "rejected"].includes(String(e.status)))
        .reduce((s, e) => s + Number(e.claim_amount ?? e.amount ?? 0), 0);
      const lineItems = Array.isArray(r.line_items) ? r.line_items : [];
      const mapped = mapExpenseClaim(r);
      return {
        ...mapped,
        serviceCaseId: String(r.service_case_id),
        gspCaseNo: sc.gsp_case_no,
        projectName: sc.project_name,
        unitLabel: sc.unit_label || "台",
        completedUnits,
        inspectorName: (r.inspector as { real_name?: string } | null)?.real_name,
        caseExpenseTotal: money(caseExpenseTotal),
        month: (r.month as string) || null,
        reviewAt: (r.review_at as string) || null,
        createdAt: (r.created_at as string) || null,
        lineItems,
      };
    }),
  );
}

async function reviewExpense(id: string, pass: boolean, body: Record<string, unknown>, user: AppUser) {
  await adminGql(
    `mutation ($id: uuid!, $set: case_expense_claims_set_input!) {
      update_case_expense_claims_by_pk(pk_columns: { id: $id }, _set: $set) { id month }
    }`,
    {
      id,
      set: {
        status: pass ? "approved" : "rejected",
        review_by_id: user.id,
        review_at: new Date().toISOString(),
        review_note: body.note || null,
        amount: pass && body.approvedAmount != null ? Number(body.approvedAmount) : undefined,
        ...(pass ? { month: new Date().toISOString().slice(0, 7) } : {}),
      },
    },
  );
  if (pass) {
    const claim = await adminGql<{ case_expense_claims_by_pk: { month: string | null } | null }>(
      `query ($id: uuid!) { case_expense_claims_by_pk(id: $id) { month } }`,
      { id },
    );
    const month = claim.case_expense_claims_by_pk?.month || new Date().toISOString().slice(0, 7);
    await syncMonthlySettlements(month).catch(() => null);
  }
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
  service_case {
    id gsp_case_no project_name task_type service_type product_line task_template_id
    task_template { id name }
  }
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
  let healed = await healServiceTaskSnapshot(id, d.inspection_tasks_by_pk);
  healed = await healTaskWorkUnitLink(healed);
  return ok(mapTask(healed));
}

/**
 * 单人一台旧任务缺 work_unit_id 时补挂作业台。
 * 否则 H5 判定不需要「识别序列号」步骤，工程师会误以为系统没做序列号识别。
 */
async function healTaskWorkUnitLink(task: Record<string, unknown>) {
  if (task.work_unit_id) return task;
  const caseId = task.service_case_id as string | null;
  const inspectorId = task.inspector_id as string | null;
  const taskId = String(task.id || "");
  if (!caseId || !inspectorId || !taskId) return task;

  const d = await adminGql<{
    service_cases_by_pk: { assign_mode: string; planned_units: number } | null;
    case_work_units: Array<{
      id: string;
      status: string;
      inspection_task_id: string | null;
      inspector_id: string | null;
    }>;
  }>(
    `query ($cid: uuid!) {
      service_cases_by_pk(id: $cid) { assign_mode planned_units }
      case_work_units(where: { service_case_id: { _eq: $cid } }, order_by: { seq: asc }) {
        id status inspection_task_id inspector_id
      }
    }`,
    { cid: caseId },
  );
  const sc = d.service_cases_by_pk;
  if (!sc) return task;
  const planned = Math.max(1, Number(sc.planned_units) || 1);
  if (String(sc.assign_mode || "single") === "multi" || planned > 1) return task;

  const unit = d.case_work_units[0];
  if (!unit) return task;
  if (unit.inspection_task_id && unit.inspection_task_id !== taskId) return task;

  const now = new Date().toISOString();
  await adminGql(
    `mutation ($tid: uuid!, $uid: uuid!, $unitId: uuid!, $now: timestamptz!) {
      update_inspection_tasks_by_pk(pk_columns: { id: $tid }, _set: { work_unit_id: $unitId }) { id }
      update_case_work_units_by_pk(pk_columns: { id: $unitId }, _set: {
        status: "claimed"
        inspector_id: $uid
        inspection_task_id: $tid
        claimed_at: $now
      }) { id }
    }`,
    { tid: taskId, uid: inspectorId, unitId: unit.id, now },
  );
  return { ...task, work_unit_id: unit.id };
}

/** 服务作业：纠正「把所有产品线检查项拼在一起」的错误快照（仅草稿且未拍照时） */
async function healServiceTaskSnapshot(id: string, task: Record<string, unknown>) {
  const sc = task.service_case as Record<string, unknown> | null;
  if (!sc) return task;
  const tplId =
    (sc.task_template_id as string) ||
    ((sc.task_template as { id?: string } | null)?.id ?? null);
  if (!tplId) return task;

  const rebuilt = (await loadTemplateSnapshot(
    tplId,
    sc.product_line as string | null,
  )) as Array<{ id?: string; name?: string }>;
  if (!rebuilt.length) return task;

  const current = (task.template_snapshot as Array<{ id?: string; name?: string }>) || [];
  const names = current.map((e) => String(e.name || "").trim()).filter(Boolean);
  const hasDupNames = names.length > 0 && new Set(names).size < names.length;
  const tooMany = current.length > rebuilt.length;
  if (!hasDupNames && !tooMany && current.length === rebuilt.length) return task;

  const recs = (task.inspection_records as Array<Record<string, unknown>>) || [];
  const rec = recs[0];
  if (rec) {
    const status = String(rec.status || "");
    if (status !== "draft") return task;
    const entries = (rec.entries as Array<{ photos?: unknown[] }>) || [];
    const hasPhotos = entries.some((e) => Array.isArray(e.photos) && e.photos.length > 0);
    if (hasPhotos) return task;
  }

  await adminGql(
    `mutation ($id: uuid!, $snap: jsonb!) {
      update_inspection_tasks_by_pk(pk_columns: { id: $id }, _set: { template_snapshot: $snap }) { id }
    }`,
    { id, snap: rebuilt },
  );

  if (rec?.id) {
    await adminGql(
      `mutation ($id: uuid!, $entries: jsonb!) {
        update_inspection_records_by_pk(pk_columns: { id: $id }, _set: { entries: $entries }) { id }
      }`,
      {
        id: rec.id,
        entries: rebuilt.map((e) => ({
          templateEntryId: e.id,
          photos: [],
          aiResult: { status: "pending", confidence: 0, reason: "" },
          manualResult: "pending",
          finalResult: null,
          remark: "",
        })),
      },
    );
  }

  const again = await adminGql<{ inspection_tasks_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { inspection_tasks_by_pk(id: $id) { ${TASK_FIELDS} } }`,
    { id },
  );
  return again.inspection_tasks_by_pk || { ...task, template_snapshot: rebuilt };
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
  let task = t.inspection_tasks_by_pk!;
  task = await healServiceTaskSnapshot(id, task);
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

async function updateTask(user: AppUser, id: string, body: Record<string, unknown>) {
  await adminGql(
    `mutation ($id: uuid!, $set: inspection_tasks_set_input!) {
      update_inspection_tasks_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    { id, set: { task_name: body.taskName, ai_enabled: body.aiEnabled } },
  );
  return getTask(id);
}

async function removeTask(user: AppUser, id: string) {
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

/** 提交后 / AI 完成后：全合格自动通过；需人审则保持 submitted */
async function routeRecordAudit(recordId: string): Promise<"auto_approve" | "need_audit" | "wait_ai" | "skip"> {
  const d = await adminGql<{
    inspection_records_by_pk: {
      id: string;
      status: string;
      entries: unknown;
      audit_trail: unknown;
      task_id: string | null;
      task?: {
        id?: string;
        ai_enabled?: boolean | null;
        template_snapshot?: unknown;
      } | null;
    } | null;
  }>(
    `query ($id: uuid!) {
      inspection_records_by_pk(id: $id) {
        id status entries audit_trail task_id
        task { id ai_enabled template_snapshot }
      }
    }`,
    { id: recordId },
  );
  const row = d.inspection_records_by_pk;
  if (!row) return "skip";
  if (row.status !== "submitted") return "skip";

  const decision = decideRecordAuditRoute({
    taskAiEnabled: row.task?.ai_enabled,
    templateSnapshot: (row.task?.template_snapshot || []) as Array<{
      id?: string;
      aiEnabled?: boolean;
      entryKind?: string;
      checkType?: string;
    }>,
    entries: (row.entries || []) as Array<{
      templateEntryId?: string;
      manualResult?: string | null;
      finalResult?: string | null;
      aiResult?: { status?: string } | null;
    }>,
  });

  if (decision !== "auto_approve") return decision;

  const trail = Array.isArray(row.audit_trail) ? [...(row.audit_trail as unknown[])] : [];
  trail.push({
    action: "auto_approved",
    at: new Date().toISOString(),
    by: null,
    byName: "系统",
    reason: "AI 全部合格自动通过",
  });
  const now = new Date().toISOString();
  await adminGql(
    `mutation ($id: uuid!, $set: inspection_records_set_input!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: recordId,
      set: {
        status: "approved",
        approved_at: now,
        audit_trail: trail,
      },
    },
  );
  if (row.task_id) {
    await adminGql(
      `mutation ($id: uuid!, $now: timestamptz!) {
        update_inspection_tasks_by_pk(pk_columns: { id: $id }, _set: { status: "approved", completed_at: $now }) { id }
      }`,
      { id: row.task_id, now },
    ).catch(() => null);
  }
  return "auto_approve";
}

async function saveDraft(user: AppUser, id: string, body: Record<string, unknown>) {
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
  await routeRecordAudit(id).catch(() => null);
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
  const page = Number(query.get("page") || 1);
  const limit = Number(query.get("limit") || 25);
  const where: Record<string, unknown> = {};
  if (query.get("status")) where.status = { _eq: query.get("status") };
  // scope=audit：待审；无 status 时历史查询不限
  if (query.get("scope") === "audit" && !query.get("status")) {
    where.status = { _eq: "submitted" };
  }
  const d = await adminGql<{
    inspection_records: Array<{
      id: string;
      status?: string;
      submitted_at?: string | null;
      created_at?: string;
      entries?: unknown;
      task?: {
        id?: string;
        ai_enabled?: boolean | null;
        template_snapshot?: unknown;
        service_case?: {
          id?: string;
          gsp_case_no?: string | null;
          project_name?: string | null;
          status?: string | null;
          planned_units?: number | null;
          completed_units?: number | null;
          unit_label?: string | null;
          assign_mode?: string | null;
          site_id?: string | null;
        } | null;
        site?: { id?: string; name?: string } | null;
      } | null;
    }>;
  }>(
    `query ($where: inspection_records_bool_exp!) {
      inspection_records(where: $where, order_by: { created_at: desc }, limit: 500) {
        id status submitted_at created_at entries
        task {
          id ai_enabled template_snapshot
          site { id name }
          service_case {
            id gsp_case_no project_name status planned_units completed_units unit_label assign_mode site_id
          }
        }
      }
    }`,
    { where },
  );
  type Agg = {
    groupKey: string;
    serviceCaseId: string | null;
    gspCaseNo: string | null;
    projectName: string | null;
    unitLabel: string | null;
    assignMode: string | null;
    siteId: string | null;
    plannedUnits: number | null;
    completedUnits: number | null;
    caseStatus: string | null;
    recordCount: number;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
    latestSubmittedAt: string | null;
  };
  const map = new Map<string, Agg>();
  for (const rec of d.inspection_records || []) {
    const sc = rec.task?.service_case;
    const taskId = rec.task?.id;
    const groupKey = sc?.id ? `case-${sc.id}` : taskId ? `task-${taskId}` : `rec-${rec.id}`;
    let row = map.get(groupKey);
    if (!row) {
      row = {
        groupKey,
        serviceCaseId: sc?.id || null,
        gspCaseNo: sc?.gsp_case_no || null,
        projectName: sc?.project_name || (rec.task?.site?.name ? `${rec.task.site.name}任务` : null),
        unitLabel: sc?.unit_label || null,
        assignMode: sc?.assign_mode || null,
        siteId: sc?.site_id || rec.task?.site?.id || null,
        plannedUnits: sc?.planned_units ?? null,
        completedUnits: sc?.completed_units ?? null,
        caseStatus: sc?.status || null,
        recordCount: 0,
        pendingCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
        latestSubmittedAt: null,
      };
      map.set(groupKey, row);
    }
    row.recordCount += 1;
    const st = String(rec.status || "");
    const needsAudit =
      st === "submitted" &&
      recordNeedsHumanAudit({
        status: st,
        taskAiEnabled: rec.task?.ai_enabled,
        templateSnapshot: (rec.task?.template_snapshot || []) as Array<{
          id?: string;
          aiEnabled?: boolean;
          entryKind?: string;
          checkType?: string;
        }>,
        entries: (rec.entries || []) as Array<{
          templateEntryId?: string;
          manualResult?: string | null;
          finalResult?: string | null;
          aiResult?: { status?: string } | null;
        }>,
      });
    if (needsAudit) row.pendingCount += 1;
    if (st === "approved") row.approvedCount += 1;
    if (st === "rejected") row.rejectedCount += 1;
    const ts = rec.submitted_at || rec.created_at || null;
    if (ts && (!row.latestSubmittedAt || String(ts) > row.latestSubmittedAt)) {
      row.latestSubmittedAt = String(ts);
    }
  }
  let list = [...map.values()];
  if (query.get("scope") === "audit") {
    list = list.filter((g) => g.pendingCount > 0);
  }
  if (query.get("status") === "rejected") {
    list = list.filter((g) => g.rejectedCount > 0);
  }
  list.sort((a, b) => String(b.latestSubmittedAt || "").localeCompare(String(a.latestSubmittedAt || "")));
  const total = list.length;
  const offset = (page - 1) * limit;
  return ok({ list: list.slice(offset, offset + limit), total, page, limit });
}

async function recordsByCase(groupKey: string, query: URLSearchParams = new URLSearchParams()) {
  const raw = String(groupKey || "").trim();
  const kind = raw.startsWith("task-") ? "task" : "case";
  const id = raw.startsWith("case-") || raw.startsWith("task-") ? raw.slice(5) : raw;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, "无效的案例标识");
  }
  const where: Record<string, unknown> =
    kind === "task"
      ? { task_id: { _eq: id } }
      : { task: { service_case_id: { _eq: id } } };
  if (query.get("status")) where.status = { _eq: query.get("status") };
  if (query.get("scope") === "audit" && !query.get("status")) {
    where.status = { _eq: "submitted" };
  }
  const d = await adminGql<{ inspection_records: Record<string, unknown>[] }>(
    `query ($where: inspection_records_bool_exp!) {
      inspection_records(where: $where, order_by: { created_at: desc }) { ${RECORD_FIELDS} }
    }`,
    { where },
  );
  let list = d.inspection_records.map(mapRecord) as Array<Record<string, unknown>>;
  if (query.get("scope") === "audit") {
    list = list.filter((row) => {
      const task = row.task as
        | {
            aiEnabled?: boolean;
            templateSnapshot?: unknown;
          }
        | undefined;
      return recordNeedsHumanAudit({
        status: String(row.status || ""),
        taskAiEnabled: task?.aiEnabled,
        templateSnapshot: (task?.templateSnapshot || []) as Array<{
          id?: string;
          aiEnabled?: boolean;
          entryKind?: string;
          checkType?: string;
        }>,
        entries: (row.entries || []) as Array<{
          templateEntryId?: string;
          manualResult?: string | null;
          finalResult?: string | null;
          aiResult?: { status?: string } | null;
        }>,
      });
    });
  }
  return ok({ list, total: list.length, groupKey: raw });
}

async function runAnalyze(user: AppUser, body: Record<string, unknown>) {
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
    await routeRecordAudit(recordId).catch(() => null);
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

async function setManualResult(user: AppUser, recordId: string, entryId: string, body: Record<string, unknown>) {
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
  await routeRecordAudit(recordId).catch(() => null);
  return getRecord(recordId);
}

async function uploadPhoto(form: FormData | null, user: AppUser) {
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "请选择照片");
  const contentType = file.type || "image/jpeg";
  const buf = Buffer.from(await file.arrayBuffer());
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = createUploadToken(file.name || "photo.jpg", user.id, { contentType });
    try {
      await uploadBufferWithToken(token, buf);
      return ok({ url: token.publicUrl, original: true });
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  throw new HttpError(
    500,
    lastErr instanceof Error ? lastErr.message : "图片上传失败",
  );
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
  const reviewStatus = query.get("reviewStatus") || "pending";
  const keyword = (query.get("keyword") || "").trim();
  const siteId = (query.get("siteId") || "").trim();
  const month = (query.get("month") || "").trim(); // YYYY-MM，按完工时间过滤
  const and: Record<string, unknown>[] = [];

  if (reviewStatus === "pending") {
    // 仍待结算的案例：含从未审过、以及驳回后需再审（status 仍为 settle_review/finished）
    and.push({ status: { _in: ["finished", "settle_review"] } });
    and.push({
      _or: [
        { case_performance: { review_status: { _in: ["pending", "rejected"] } } },
        { _not: { case_performance: {} } },
      ],
    });
  } else if (reviewStatus === "approved") {
    and.push({ case_performance: { review_status: { _eq: "approved" } } });
  } else if (reviewStatus === "rejected") {
    and.push({ case_performance: { review_status: { _eq: "rejected" } } });
  } else {
    and.push({
      _or: [
        { status: { _in: ["finished", "settle_review", "settled"] } },
        { case_performance: {} },
      ],
    });
  }

  if (siteId) and.push({ site_id: { _eq: siteId } });
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [yy, mm] = month.split("-").map(Number);
    const from = `${month}-01T00:00:00+08:00`;
    const to =
      mm === 12
        ? `${yy + 1}-01-01T00:00:00+08:00`
        : `${yy}-${String(mm + 1).padStart(2, "0")}-01T00:00:00+08:00`;
    and.push({ finish_time: { _gte: from, _lt: to } });
  }
  if (keyword) {
    and.push({
      _or: [
        { gsp_case_no: { _ilike: `%${keyword}%` } },
        { project_name: { _ilike: `%${keyword}%` } },
        { inspector: { real_name: { _ilike: `%${keyword}%` } } },
      ],
    });
  }

  const d = await adminGql<{ service_cases: Record<string, unknown>[] }>(
    `query ($where: service_cases_bool_exp!) {
      service_cases(where: $where, order_by: { updated_at: desc }, limit: 200) { ${CASE_FIELDS} }
    }`,
    { where: and.length ? { _and: and } : {} },
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
  const comment = String(body.comment || body.reason || "").trim() || null;
  const row = await loadCase(caseId);
  if (!row) throw new HttpError(404, "案例不存在");

  // 先按最新 PO 计价刷新台账，再写入审核结论与工程师
  await recalculateLedgers([caseId]).catch(() => null);

  const ledger = await adminGql<{
    case_performances: Array<{ id: string }>;
  }>(
    `query ($id: uuid!) {
      case_performances(where: { service_case_id: { _eq: $id } }, limit: 1) { id }
    }`,
    { id: caseId },
  );
  const ledgerId = ledger.case_performances[0]?.id;
  const reviewSet = {
    review_status: pass ? "approved" : "rejected",
    review_comment: comment,
    inspector_id: (row.inspector_id as string) || null,
  };
  if (ledgerId) {
    await adminGql(
      `mutation ($id: uuid!, $set: case_performances_set_input!) {
        update_case_performances_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: ledgerId, set: reviewSet },
    );
  } else {
    await adminGql(
      `mutation ($obj: case_performances_insert_input!) {
        insert_case_performances_one(object: $obj) { id }
      }`,
      {
        obj: {
          service_case_id: caseId,
          gsp_case_no: row.gsp_case_no,
          case_revenue: "0.00",
          perf_base: "0.00",
          perf_final: "0.00",
          deduction: "0.00",
          month: new Date().toISOString().slice(0, 7),
          ...reviewSet,
        },
      },
    );
  }

  await adminGql(
    `mutation ($id: uuid!, $st: String!) {
      update_service_cases_by_pk(pk_columns: { id: $id }, _set: { status: $st }) { id }
    }`,
    { id: caseId, st: pass ? "settled" : "settle_review" },
  );
  const month =
    (await adminGql<{ case_performances: Array<{ month: string | null }> }>(
      `query ($id: uuid!) {
        case_performances(where: { service_case_id: { _eq: $id } }, limit: 1) { month }
      }`,
      { id: caseId },
    ).then((d) => d.case_performances[0]?.month)) || new Date().toISOString().slice(0, 7);
  // 通过/驳回都重算：驳回后应从月结计件中剔除
  await syncMonthlySettlements(month).catch(() => null);
  return ok({ success: true, comment: comment || undefined, reviewStatus: pass ? "approved" : "rejected" });
}

async function listAssessments(user: AppUser, query: URLSearchParams) {
  const month = query.get("month") || new Date().toISOString().slice(0, 7);
  const keyword = (query.get("keyword") || "").trim().toLowerCase();
  const roleFilter = (query.get("role") || "").trim();
  const siteIdQ = (query.get("siteId") || "").trim();

  /** 网格长考核范围：仅正管站 + 副长任职站，不含本人只当工程师的站 */
  let siteIds: string[] | undefined;
  if (user.role === "site_manager") {
    const scope = await adminGql<{
      sites: { id: string }[];
      site_members: { site_id: string }[];
    }>(
      `query ($uid: uuid!) {
        sites(
          where: {
            manager_id: { _eq: $uid }
            deleted_at: { _is_null: true }
            status: { _eq: "active" }
          }
        ) { id }
        site_members(
          where: {
            user_id: { _eq: $uid }
            status: { _eq: "active" }
            member_role: { _eq: "deputy_manager" }
            site: { deleted_at: { _is_null: true }, status: { _eq: "active" } }
          }
        ) { site_id }
      }`,
      { uid: user.id },
    );
    siteIds = [
      ...new Set([
        ...scope.sites.map((s) => s.id),
        ...scope.site_members.map((m) => m.site_id),
      ]),
    ];
    if (siteIdQ) {
      siteIds = siteIds.includes(siteIdQ) ? [siteIdQ] : [];
    }
    if (!siteIds.length) return ok([]);
  } else if (siteIdQ) {
    siteIds = [siteIdQ];
  }

  type MemberRow = {
    user_id: string;
    site_id: string;
    site: { id: string; name: string } | null;
    user: {
      id: string;
      username: string;
      real_name: string;
      role: string;
      roles: string[] | null;
      status: string;
    } | null;
  };

  const wantInspectors = !roleFilter || roleFilter === "inspector";
  const wantManagers = user.role === "super_admin" && (!roleFilter || roleFilter === "site_manager");

  const roster = new Map<
    string,
    {
      userId: string;
      realName: string;
      username: string;
      userRole: string;
      sites: Array<{ id: string; name: string }>;
    }
  >();

  const pushSite = (
    row: {
      userId: string;
      realName: string;
      username: string;
      userRole: string;
      sites: Array<{ id: string; name: string }>;
    },
    siteId: string,
    siteName: string,
  ) => {
    if (!siteId) return;
    if (row.sites.some((s) => s.id === siteId)) return;
    row.sites.push({ id: siteId, name: siteName || "未命名网格" });
  };

  if (wantInspectors) {
    const d = await adminGql<{ site_members: MemberRow[] }>(
      `query ($where: site_members_bool_exp!) {
        site_members(where: $where, order_by: [{ site: { name: asc } }, { joined_at: asc }]) {
          user_id site_id
          site { id name }
          user { id username real_name role roles status }
        }
      }`,
      {
        where: {
          status: { _eq: "active" },
          member_role: { _eq: "inspector" },
          ...(siteIds ? { site_id: { _in: siteIds } } : {}),
          user: { status: { _eq: "active" } },
        },
      },
    );
    for (const m of d.site_members) {
      if (!m.user) continue;
      const roles = m.user.roles || [];
      const isMgr = roles.includes("site_manager") || m.user.role === "site_manager";
      let row = roster.get(m.user_id);
      if (!row) {
        row = {
          userId: m.user_id,
          realName: m.user.real_name,
          username: m.user.username,
          userRole: isMgr ? "dual" : "inspector",
          sites: [],
        };
        roster.set(m.user_id, row);
      } else if (isMgr) {
        row.userRole = "dual";
      }
      pushSite(row, m.site_id, m.site?.name || "");
    }
  }

  if (wantManagers) {
    const d = await adminGql<{
      sites: Array<{
        id: string;
        name: string;
        manager: {
          id: string;
          username: string;
          real_name: string;
          role: string;
          roles: string[] | null;
          status: string;
        } | null;
      }>;
    }>(
      `query ($where: sites_bool_exp!) {
        sites(where: $where, order_by: { name: asc }) {
          id name
          manager { id username real_name role roles status }
        }
      }`,
      {
        where: {
          deleted_at: { _is_null: true },
          status: { _eq: "active" },
          manager_id: { _is_null: false },
          ...(siteIds ? { id: { _in: siteIds } } : {}),
        },
      },
    );
    for (const s of d.sites) {
      const mgr = s.manager;
      if (!mgr || mgr.status !== "active") continue;
      let row = roster.get(mgr.id);
      if (!row) {
        row = {
          userId: mgr.id,
          realName: mgr.real_name,
          username: mgr.username,
          userRole: "site_manager",
          sites: [],
        };
        roster.set(mgr.id, row);
      } else {
        row.userRole = "dual";
      }
      pushSite(row, s.id, s.name);
    }
  }

  const userIds = [...roster.keys()];
  if (!userIds.length) return ok([]);

  const [assessments, events] = await Promise.all([
    adminGql<{ assessments: Record<string, unknown>[] }>(
      `query ($m: String!, $ids: [uuid!]!) {
        assessments(where: { month: { _eq: $m }, user_id: { _in: $ids } }) {
          id user_id month internal_score total_score rank_result site_rank_result
          reward_amount event_penalty tool_subsidy other_subsidy subsidy_remark score_detail
        }
      }`,
      { m: month, ids: userIds },
    ),
    adminGql<{ assessment_events: Array<{ user_id: string; amount: number | string }> }>(
      `query ($m: String!, $ids: [uuid!]!) {
        assessment_events(where: { month: { _eq: $m }, user_id: { _in: $ids } }) {
          user_id amount
        }
      }`,
      { m: month, ids: userIds },
    ),
  ]);

  const byAssessment = new Map(
    assessments.assessments.map((r) => [String(r.user_id), r] as const),
  );
  const eventPenaltyByUser = new Map<string, number>();
  for (const ev of events.assessment_events) {
    const uid = String(ev.user_id);
    eventPenaltyByUser.set(uid, (eventPenaltyByUser.get(uid) || 0) + Number(ev.amount || 0));
  }

  let list = [...roster.values()].map((person) => {
    const a = byAssessment.get(person.userId);
    const detail = a?.score_detail as { items?: unknown[]; total?: number } | null | undefined;
    const scored = Boolean(detail && Array.isArray(detail.items) && detail.items.length);
    const eventPenalty = eventPenaltyByUser.get(person.userId) || 0;
    const siteNames = person.sites.map((s) => s.name).filter(Boolean);
    return {
      id: a?.id ? String(a.id) : undefined,
      month,
      userId: person.userId,
      realName: person.realName,
      username: person.username,
      userRole: person.userRole,
      siteId: person.sites[0]?.id || null,
      siteName: siteNames.length ? siteNames.join("、") : null,
      internalScore: a?.internal_score == null ? undefined : String(a.internal_score),
      totalScore: a?.total_score == null ? undefined : String(a.total_score),
      siteRankResult: a?.site_rank_result == null ? undefined : String(a.site_rank_result),
      rankResult: a?.rank_result == null ? undefined : String(a.rank_result),
      rewardAmount: a?.reward_amount == null ? undefined : String(a.reward_amount),
      eventPenalty: String(eventPenalty),
      toolSubsidy: a?.tool_subsidy == null ? undefined : String(a.tool_subsidy),
      otherSubsidy: a?.other_subsidy == null ? undefined : String(a.other_subsidy),
      subsidyRemark: a?.subsidy_remark == null ? undefined : String(a.subsidy_remark),
      scored,
      scoreDetail: detail || null,
    };
  });

  if (keyword) {
    list = list.filter(
      (row) =>
        row.realName.toLowerCase().includes(keyword) ||
        row.username.toLowerCase().includes(keyword),
    );
  }

  list.sort((a, b) => a.realName.localeCompare(b.realName, "zh-CN"));
  return ok(list);
}

async function saveAssessment(user: AppUser, body: Record<string, unknown>) {
  const userId = String(body.userId || "");
  const month = String(body.month || "");
  if (!userId || !month) throw new HttpError(400, "请选择人员和月份");
  if (user.role === "site_manager" && userId === user.id) {
    throw new HttpError(403, "不能修改本人考核补助，请由管理员录入");
  }

  const target = await adminGql<{ users_by_pk: { id: string; role: string; roles: string[] | null } | null }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { id role roles } }`,
    { id: userId },
  );
  if (!target.users_by_pk) throw new HttpError(404, "考核人员不存在");
  const roles = target.users_by_pk.roles || [];
  const isManager = roles.includes("site_manager") || target.users_by_pk.role === "site_manager";

  const patch: Record<string, unknown> = {
    user_role: body.role || (isManager ? "site_manager" : "inspector"),
    rank_group: body.rankGroup || (isManager ? "station_manager" : "inspector"),
  };
  // UI 补助保存字段
  if (body.rewardAmount != null || body.bonus != null) {
    patch.reward_amount = Number(body.rewardAmount ?? body.bonus ?? 0);
  }
  if (body.toolSubsidy != null) patch.tool_subsidy = Number(body.toolSubsidy || 0);
  if (body.otherSubsidy != null || body.subsidy != null) {
    patch.other_subsidy = Number(body.otherSubsidy ?? body.subsidy ?? 0);
  }
  if (body.subsidyRemark != null || body.remark != null) {
    patch.subsidy_remark = body.subsidyRemark ?? body.remark ?? null;
  }
  if (body.score != null) {
    patch.total_score = Number(body.score);
    patch.internal_score = Number(body.score);
  }
  if (body.penalty != null) patch.event_penalty = Number(body.penalty);

  const existing = await adminGql<{ assessments: { id: string }[] }>(
    `query ($m: String!, $uid: uuid!) {
      assessments(where: { month: { _eq: $m }, user_id: { _eq: $uid } }, limit: 1) { id }
    }`,
    { m: month, uid: userId },
  );

  if (existing.assessments[0]) {
    await adminGql(
      `mutation ($id: uuid!, $set: assessments_set_input!) {
        update_assessments_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: existing.assessments[0].id, set: patch },
    );
    await syncMonthlySettlements(month).catch(() => null);
    return ok({ id: existing.assessments[0].id, month, userId, ...patch });
  }

  const ins = await adminGql<{ insert_assessments_one: { id: string } }>(
    `mutation ($obj: assessments_insert_input!) { insert_assessments_one(object: $obj) { id } }`,
    {
      obj: {
        user_id: userId,
        month,
        ...patch,
      },
    },
  );
  await syncMonthlySettlements(month).catch(() => null);
  return ok({ id: ins.insert_assessments_one.id, month, userId, ...patch });
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
  const month = String(body.month || "");
  if (month) await syncMonthlySettlements(month).catch(() => null);
  return ok({ id: d.insert_assessment_events_one.id });
}

type ScoredAssessmentRow = {
  userId: string;
  realName: string;
  userRole: string;
  siteIds: string[];
  assessmentId?: string;
  totalScore: number;
  scored: boolean;
};

function assessmentScored(detail: unknown): boolean {
  const d = detail as { items?: unknown[] } | null | undefined;
  return Boolean(d && Array.isArray(d.items) && d.items.length);
}

async function loadScoredAssessmentRows(
  month: string,
  opts: { siteId?: string; pool: "site_inspectors" | "company_inspectors" | "company_managers" },
): Promise<ScoredAssessmentRow[]> {
  const siteId = opts.siteId?.trim();
  const roster = new Map<string, ScoredAssessmentRow>();

  const push = (row: Omit<ScoredAssessmentRow, "totalScore" | "scored" | "assessmentId">) => {
    const existing = roster.get(row.userId);
    if (!existing) {
      roster.set(row.userId, { ...row, totalScore: 0, scored: false });
      return;
    }
    for (const sid of row.siteIds) {
      if (sid && !existing.siteIds.includes(sid)) existing.siteIds.push(sid);
    }
    if (row.userRole === "dual" || existing.userRole === "dual") {
      existing.userRole = "dual";
    } else if (row.userRole === "site_manager") {
      existing.userRole = "site_manager";
    }
  };

  if (opts.pool === "site_inspectors" || opts.pool === "company_inspectors") {
    type RankMemberRow = {
      user_id: string;
      site_id: string;
      site: { id: string; name: string } | null;
      user: {
        id: string;
        username: string;
        real_name: string;
        role: string;
        roles: string[] | null;
        status: string;
      } | null;
    };
    const d = await adminGql<{ site_members: RankMemberRow[] }>(
      `query ($where: site_members_bool_exp!) {
        site_members(where: $where, order_by: [{ site: { name: asc } }, { joined_at: asc }]) {
          user_id site_id
          site { id name }
          user { id username real_name role roles status }
        }
      }`,
      {
        where: {
          status: { _eq: "active" },
          member_role: { _eq: "inspector" },
          ...(siteId ? { site_id: { _eq: siteId } } : {}),
          user: { status: { _eq: "active" } },
        },
      },
    );
    for (const m of d.site_members) {
      if (!m.user) continue;
      const roles = m.user.roles || [];
      const isMgr = roles.includes("site_manager") || m.user.role === "site_manager";
      push({
        userId: m.user_id,
        realName: m.user.real_name,
        userRole: isMgr ? "dual" : "inspector",
        siteIds: m.site_id ? [m.site_id] : [],
      });
    }
  }

  if (opts.pool === "company_managers") {
    const d = await adminGql<{
      sites: Array<{
        id: string;
        manager: {
          id: string;
          real_name: string;
          role: string;
          roles: string[] | null;
          status: string;
        } | null;
      }>;
    }>(
      `query {
        sites(
          where: { deleted_at: { _is_null: true }, status: { _eq: "active" }, manager_id: { _is_null: false } }
          order_by: { name: asc }
        ) {
          id
          manager { id real_name role roles status }
        }
      }`,
    );
    for (const s of d.sites) {
      const mgr = s.manager;
      if (!mgr || mgr.status !== "active") continue;
      const roles = mgr.roles || [];
      const isDual = roles.includes("inspector") || mgr.role === "inspector";
      push({
        userId: mgr.id,
        realName: mgr.real_name,
        userRole: isDual ? "dual" : "site_manager",
        siteIds: [s.id],
      });
    }
  }

  const userIds = [...roster.keys()];
  if (!userIds.length) return [];

  const assessRows = await adminGql<{
    assessments: Array<{
      id: string;
      user_id: string;
      total_score: number | null;
      score_detail: unknown;
    }>;
  }>(
    `query ($m: String!, $ids: [uuid!]!) {
      assessments(where: { month: { _eq: $m }, user_id: { _in: $ids } }) {
        id user_id total_score score_detail
      }
    }`,
    { m: month, ids: userIds },
  );

  for (const a of assessRows.assessments) {
    const row = roster.get(String(a.user_id));
    if (!row) continue;
    row.assessmentId = String(a.id);
    row.totalScore = Number(a.total_score || 0);
    row.scored = assessmentScored(a.score_detail);
  }

  let list = [...roster.values()].filter((r) => r.scored && r.assessmentId);
  if (opts.pool === "company_inspectors") {
    list = list.filter((r) => r.userRole === "inspector");
  } else if (opts.pool === "company_managers") {
    list = list.filter((r) => r.userRole === "site_manager" || r.userRole === "dual");
  }
  list.sort(
    (a, b) =>
      b.totalScore - a.totalScore || a.realName.localeCompare(b.realName, "zh-CN"),
  );
  return list;
}

async function patchAssessmentRank(
  assessmentId: string,
  patch: {
    site_rank_result?: string | null;
    rank_result?: string | null;
    reward_amount?: number;
  },
) {
  await adminGql(
    `mutation ($id: uuid!, $set: assessments_set_input!) {
      update_assessments_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    { id: assessmentId, set: patch },
  );
}

async function rankAssessments(user: AppUser, month: string, body: Record<string, unknown>) {
  const mode = String(body.mode || "");
  const siteId = String(body.siteId || "").trim();

  if (mode === "site_preview") {
    if (user.role === "super_admin" && !siteId) {
      throw new HttpError(400, "请先选择网格，再生成网格内名次");
    }
    const targetSiteId =
      siteId ||
      (user.role === "site_manager"
        ? (
            await adminGql<{ sites: Array<{ id: string }> }>(
              `query ($uid: uuid!) {
                sites(where: { manager_id: { _eq: $uid }, status: { _eq: "active" } }, limit: 1) { id }
              }`,
              { uid: user.id },
            )
          ).sites[0]?.id
        : undefined);
    if (!targetSiteId) throw new HttpError(400, "请先选择网格，再生成网格内名次");

    const rows = await loadScoredAssessmentRows(month, {
      siteId: targetSiteId,
      pool: "site_inspectors",
    });
    for (let i = 0; i < rows.length; i++) {
      await patchAssessmentRank(rows[i].assessmentId!, {
        site_rank_result: String(i + 1),
      });
    }
    return listAssessments(user, new URLSearchParams({ month, siteId: targetSiteId }));
  }

  if (mode === "company_inspectors") {
    needAdmin(user);
    const rows = await loadScoredAssessmentRows(month, { pool: "company_inspectors" });
    const n = rows.length;
    const topN = Math.min(3, n);
    const bottomN = Math.min(3, n);
    const topIds = new Set(rows.slice(0, topN).map((r) => r.userId));
    const bottomIds = rows
      .slice(n - bottomN)
      .map((r) => r.userId)
      .filter((id) => !topIds.has(id));

    for (const row of rows) {
      let rankResult: string | null = null;
      if (topIds.has(row.userId)) rankResult = "优秀";
      else if (bottomIds.includes(row.userId)) rankResult = "不称职";
      await patchAssessmentRank(row.assessmentId!, {
        rank_result: rankResult,
        reward_amount: rankRewardAmount("inspector", rankResult),
      });
    }
    await syncMonthlySettlements(month).catch(() => null);
    return listAssessments(user, new URLSearchParams({ month }));
  }

  if (mode === "company_managers") {
    needAdmin(user);
    const rows = await loadScoredAssessmentRows(month, { pool: "company_managers" });
    const n = rows.length;
    const topId = n > 0 ? rows[0].userId : null;
    const bottomId = n > 1 ? rows[n - 1].userId : null;

    for (const row of rows) {
      let rankResult: string | null = null;
      if (row.userId === topId) rankResult = "优秀";
      else if (row.userId === bottomId) rankResult = "不称职";
      await patchAssessmentRank(row.assessmentId!, {
        rank_result: rankResult,
        reward_amount: rankRewardAmount("station_manager", rankResult),
      });
    }
    await syncMonthlySettlements(month).catch(() => null);
    return listAssessments(user, new URLSearchParams({ month }));
  }

  throw new HttpError(400, "无效的排名模式");
}

type MonthSettlementTotals = {
  perf: number;
  expense: number;
  reward: number;
  eventPenalty: number;
  subsidy: number;
  correction: number;
};

function emptyMonthTotals(): MonthSettlementTotals {
  return { perf: 0, expense: 0, reward: 0, eventPenalty: 0, subsidy: 0, correction: 0 };
}

function bumpMonthTotals(
  map: Map<string, MonthSettlementTotals>,
  userId: string | null | undefined,
  patch: Partial<MonthSettlementTotals>,
) {
  if (!userId) return;
  const row = map.get(userId) || emptyMonthTotals();
  if (patch.perf) row.perf += patch.perf;
  if (patch.expense) row.expense += patch.expense;
  if (patch.reward) row.reward += patch.reward;
  if (patch.eventPenalty) row.eventPenalty += patch.eventPenalty;
  if (patch.subsidy) row.subsidy += patch.subsidy;
  if (patch.correction) row.correction += patch.correction;
  map.set(userId, row);
}

/** 按当月已审绩效/报销/考核汇总写入 monthly_settlements（跳过 locked/corrected） */
async function syncMonthlySettlements(month: string) {
  const monthStart = `${month}-01`;
  const [yy, mm] = month.split("-").map(Number);
  const next = mm === 12 ? `${yy + 1}-01-01` : `${yy}-${String(mm + 1).padStart(2, "0")}-01`;

  const frozen = await adminGql<{
    monthly_settlements: Array<{ user_id: string; status: string }>;
  }>(
    `query ($m: String!) {
      monthly_settlements(where: { month: { _eq: $m }, status: { _eq: "locked" } }) {
        user_id status
      }
    }`,
    { m: month },
  );
  const skipUsers = new Set(frozen.monthly_settlements.map((r) => r.user_id));

  const totals = new Map<string, MonthSettlementTotals>();

  const perfRows = await adminGql<{
    case_performances: Array<{
      perf_final: number;
      inspector_id: string | null;
      service_case: {
        case_perf_shares: Array<{ inspector_id: string; perf_amount: number }>;
      } | null;
    }>;
  }>(
    `query ($m: String!) {
      case_performances(
        where: { month: { _eq: $m }, review_status: { _eq: "approved" } }
      ) {
        perf_final inspector_id
        service_case { case_perf_shares { inspector_id perf_amount } }
      }
    }`,
    { m: month },
  );
  for (const row of perfRows.case_performances) {
    const shares = row.service_case?.case_perf_shares || [];
    if (shares.length) {
      for (const s of shares) {
        bumpMonthTotals(totals, s.inspector_id, { perf: Number(s.perf_amount || 0) });
      }
    } else {
      bumpMonthTotals(totals, row.inspector_id, { perf: Number(row.perf_final || 0) });
    }
  }

  const expRows = await adminGql<{
    case_expense_claims: Array<{ inspector_id: string | null; amount: number }>;
  }>(
    `query ($m: String!) {
      case_expense_claims(where: { month: { _eq: $m }, status: { _eq: "approved" } }) {
        inspector_id amount
      }
    }`,
    { m: month },
  );
  for (const e of expRows.case_expense_claims) {
    bumpMonthTotals(totals, e.inspector_id, { expense: Number(e.amount || 0) });
  }

  const assessRows = await adminGql<{
    assessments: Array<{
      user_id: string;
      reward_amount: number;
      event_penalty: number | null;
      tool_subsidy: number;
      other_subsidy: number;
      correction_amount: number | null;
    }>;
  }>(
    `query ($m: String!) {
      assessments(where: { month: { _eq: $m } }) {
        user_id reward_amount event_penalty tool_subsidy other_subsidy correction_amount
      }
    }`,
    { m: month },
  );
  for (const a of assessRows.assessments) {
    bumpMonthTotals(totals, a.user_id, {
      reward: Number(a.reward_amount || 0),
      subsidy: Number(a.tool_subsidy || 0) + Number(a.other_subsidy || 0),
      correction: Number(a.correction_amount || 0),
    });
  }

  // 事件扣罚以 assessment_events.month 为准；不再叠加 assessments.event_penalty，避免双计
  const eventRows = await adminGql<{
    assessment_events: Array<{ user_id: string; amount: number }>;
  }>(
    `query ($m: String!) {
      assessment_events(where: { month: { _eq: $m }, user_id: { _is_null: false } }) {
        user_id amount
      }
    }`,
    { m: month },
  );
  for (const e of eventRows.assessment_events) {
    bumpMonthTotals(totals, e.user_id, { eventPenalty: Number(e.amount || 0) });
  }

  const objects: Array<Record<string, unknown>> = [];
  for (const [userId, t] of totals) {
    if (skipUsers.has(userId)) continue;
    const hasActivity =
      t.perf !== 0 ||
      t.expense !== 0 ||
      t.reward !== 0 ||
      t.eventPenalty !== 0 ||
      t.subsidy !== 0 ||
      t.correction !== 0;
    if (!hasActivity) continue;
    const final = t.perf + t.expense + t.reward - t.eventPenalty + t.subsidy + t.correction;
    objects.push({
      month,
      user_id: userId,
      perf_total: t.perf.toFixed(2),
      expense_total: t.expense.toFixed(2),
      reward_total: t.reward.toFixed(2),
      event_penalty: t.eventPenalty.toFixed(2),
      subsidy_total: t.subsidy.toFixed(2),
      correction_total: t.correction.toFixed(2),
      final_amount: final.toFixed(2),
      status: "draft",
    });
  }

  if (!objects.length) return;

  await adminGql(
    `mutation ($objects: [monthly_settlements_insert_input!]!) {
      insert_monthly_settlements(
        objects: $objects
        on_conflict: {
          constraint: monthly_settlements_month_user_id_key
          update_columns: [
            perf_total expense_total reward_total event_penalty
            subsidy_total correction_total final_amount updated_at
          ]
        }
      ) { affected_rows }
    }`,
    { objects },
  );
}

async function listMonthly(user: AppUser, query: URLSearchParams) {
  const month = query.get("month") || new Date().toISOString().slice(0, 7);
  await syncMonthlySettlements(month).catch(() => null);
  // 网格长仅能查看本人管理网格成员的结算，超管可看全部
  let scopedUserIds: Set<string> | null = null;
  if (user.role === "site_manager") {
    const managed = await adminGql<{
      sites: Array<{ id: string }>;
      deputy: Array<{ site_id: string }>;
    }>(
      `query ($uid: uuid!) {
        sites(where: { manager_id: { _eq: $uid }, deleted_at: { _is_null: true } }) { id }
        deputy: site_members(where: { user_id: { _eq: $uid }, member_role: { _eq: "deputy_manager" }, status: { _eq: "active" } }) { site_id }
      }`,
      { uid: user.id },
    );
    const siteIds = [
      ...managed.sites.map((s) => s.id),
      ...managed.deputy.map((d) => d.site_id),
    ];
    scopedUserIds = new Set<string>([user.id]);
    if (siteIds.length) {
      const members = await adminGql<{ site_members: Array<{ user_id: string }> }>(
        `query ($ids: [uuid!]!) {
          site_members(where: { site_id: { _in: $ids }, status: { _eq: "active" } }) { user_id }
        }`,
        { ids: siteIds },
      );
      for (const m of members.site_members) scopedUserIds.add(m.user_id);
    }
  }
  const d = await adminGql<{ monthly_settlements: Record<string, unknown>[] }>(
    `query ($m: String!) {
      monthly_settlements(where: { month: { _eq: $m } }) {
        id user_id month perf_total expense_total reward_total event_penalty subsidy_total correction_total final_amount status
        user { real_name username role roles }
      }
    }`,
    { m: month },
  );
  let rows = scopedUserIds
    ? d.monthly_settlements.filter((r) => scopedUserIds!.has(String(r.user_id)))
    : d.monthly_settlements;

  const keyword = (query.get("keyword") || "").trim().toLowerCase();
  const roleFilter = (query.get("role") || "").trim();
  const siteIdQ = (query.get("siteId") || "").trim();
  if (keyword || roleFilter || siteIdQ) {
    let siteUserIds: Set<string> | null = null;
    if (siteIdQ) {
      const members = await adminGql<{ site_members: Array<{ user_id: string }> }>(
        `query ($sid: uuid!) {
          site_members(where: { site_id: { _eq: $sid }, status: { _eq: "active" } }) { user_id }
        }`,
        { sid: siteIdQ },
      );
      siteUserIds = new Set(members.site_members.map((m) => m.user_id));
    }
    rows = rows.filter((r) => {
      const u = r.user as { real_name?: string; username?: string; role?: string; roles?: string[] } | undefined;
      if (siteUserIds && !siteUserIds.has(String(r.user_id))) return false;
      if (roleFilter) {
        const roles = u?.roles || [];
        const primary = u?.role || "";
        const isMgr = primary === "site_manager" || roles.includes("site_manager");
        if (roleFilter === "site_manager" && !isMgr) return false;
        if (roleFilter === "inspector" && isMgr && primary !== "inspector") return false;
      }
      if (keyword) {
        const name = `${u?.real_name || ""} ${u?.username || ""}`.toLowerCase();
        if (!name.includes(keyword)) return false;
      }
      return true;
    });
  }

  return ok(
    rows.map((r) => ({
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

async function exportMonthly(user: AppUser, month: string, template: string) {
  const listed = await listMonthly(user, new URLSearchParams({ month }));
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

async function correctMonthly(user: AppUser, month: string, body: Record<string, unknown>) {
  const userId = String(body.userId || "");
  const amount = Number(body.amount || 0);
  const reason = String(body.reason || "").trim();
  if (!userId) throw new HttpError(400, "请选择人员");
  if (!reason) throw new HttpError(400, "请填写校正原因");
  if (!Number.isFinite(amount)) throw new HttpError(400, "校正金额无效");

  const target = await adminGql<{ users_by_pk: { id: string; role: string; roles: string[] | null } | null }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { id role roles } }`,
    { id: userId },
  );
  if (!target.users_by_pk) throw new HttpError(404, "结算人员不存在");
  const roles = target.users_by_pk.roles || [];
  const isManager = roles.includes("site_manager") || target.users_by_pk.role === "site_manager";

  const existing = await adminGql<{ assessments: { id: string }[] }>(
    `query ($m: String!, $uid: uuid!) {
      assessments(where: { month: { _eq: $m }, user_id: { _eq: $uid } }, limit: 1) { id }
    }`,
    { m: month, uid: userId },
  );
  const patch = {
    correction_amount: amount,
    correction_reason: reason,
    updated_by_id: user.id,
  };
  if (existing.assessments[0]) {
    await adminGql(
      `mutation ($id: uuid!, $set: assessments_set_input!) {
        update_assessments_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: existing.assessments[0].id, set: patch },
    );
  } else {
    await adminGql(
      `mutation ($obj: assessments_insert_input!) { insert_assessments_one(object: $obj) { id } }`,
      {
        obj: {
          month,
          user_id: userId,
          user_role: isManager ? "site_manager" : "inspector",
          rank_group: isManager ? "station_manager" : "inspector",
          ...patch,
        },
      },
    );
  }

  await syncMonthlySettlements(month);
  await adminGql(
    `mutation ($m: String!, $uid: uuid!) {
      update_monthly_settlements(
        where: { month: { _eq: $m }, user_id: { _eq: $uid } }
        _set: { status: "corrected" }
      ) { affected_rows }
    }`,
    { m: month, uid: userId },
  );
  return listMonthly(user, new URLSearchParams({ month }));
}

async function myIncome(user: AppUser, query: URLSearchParams) {
  const month = query.get("month") || new Date().toISOString().slice(0, 7);
  const uid = user.id;

  type PerfRow = {
    id: string;
    gsp_case_no: string;
    perf_base: number;
    deduction: number;
    deduction_reason: string | null;
    perf_final: number;
    case_revenue: number;
    review_status: string;
    review_comment: string | null;
    month: string | null;
    service_case: {
      id: string;
      gsp_case_no: string;
      project_name: string;
      status: string;
      finish_time: string | null;
      planned_units: number | null;
      assign_mode: string | null;
      case_perf_shares: Array<{
        inspector_id: string;
        completed_units: number;
        share_ratio: number;
        perf_amount: number;
      }>;
      case_expense_claims: Array<{
        id: string;
        service_case_id: string;
        work_unit_id: string | null;
        inspector_id: string | null;
        amount: number;
        claim_amount: number | null;
        note: string | null;
        status: string;
        review_note: string | null;
        trip_skipped: boolean | null;
        work_unit?: { seq: number | null } | null;
      }>;
      assessment_events: Array<{
        id: string;
        category: string;
        content: string;
        amount: number;
        remark: string | null;
        user_id: string;
      }>;
      po_orders: Array<{
        po_items: Array<{
          item_name: string | null;
          item_code: string | null;
          qty: number;
          perf_price: number | null;
          item_perf: number | null;
          price_status: string | null;
        }>;
      }>;
    } | null;
  };

  const d = await adminGql<{
    case_performances: PerfRow[];
    monthly_settlements: Array<{
      perf_total: number;
      expense_total: number;
      reward_total: number;
      event_penalty: number;
      subsidy_total: number;
      correction_total: number;
      final_amount: number;
      status: string;
    }>;
    assessments: Array<{
      total_score: number;
      rank_result: string | null;
      reward_amount: number;
      event_penalty: number | null;
      tool_subsidy: number;
      other_subsidy: number;
      subsidy_remark: string | null;
      correction_amount: number | null;
      correction_reason: string | null;
    }>;
    assessment_events: Array<{
      id: string;
      category: string;
      content: string;
      amount: number;
      remark: string | null;
      service_case_id: string | null;
      created_at: string;
    }>;
  }>(
    `query ($m: String!, $uid: uuid!) {
      case_performances(
        where: {
          month: { _eq: $m }
          _or: [
            { inspector_id: { _eq: $uid } }
            { service_case: { case_perf_shares: { inspector_id: { _eq: $uid } } } }
          ]
        }
        order_by: { updated_at: desc }
      ) {
        id gsp_case_no perf_base deduction deduction_reason perf_final case_revenue
        review_status review_comment month
        service_case {
          id gsp_case_no project_name status finish_time planned_units assign_mode
          case_perf_shares(where: { inspector_id: { _eq: $uid } }) {
            inspector_id completed_units share_ratio perf_amount
          }
          case_expense_claims(where: { inspector_id: { _eq: $uid } }) {
            id service_case_id work_unit_id inspector_id amount claim_amount note status
            review_note trip_skipped
            work_unit { seq }
          }
          assessment_events(where: { user_id: { _eq: $uid } }) {
            id category content amount remark user_id
          }
          po_orders {
            po_items {
              item_name item_code qty perf_price item_perf price_status
            }
          }
        }
      }
      monthly_settlements(where: { month: { _eq: $m }, user_id: { _eq: $uid } }, limit: 1) {
        perf_total expense_total reward_total event_penalty subsidy_total correction_total
        final_amount status
      }
      assessments(where: { month: { _eq: $m }, user_id: { _eq: $uid } }, limit: 1) {
        total_score rank_result reward_amount event_penalty tool_subsidy other_subsidy
        subsidy_remark correction_amount correction_reason
      }
      assessment_events(
        where: {
          user_id: { _eq: $uid }
          month: { _eq: $m }
          service_case_id: { _is_null: true }
        }
        order_by: { created_at: desc }
      ) {
        id category content amount remark service_case_id created_at
      }
    }`,
    { m: month, uid },
  );

  const settlement = d.monthly_settlements[0] || null;
  const assessment = d.assessments[0] || null;
  const orphanEventPenalty = d.assessment_events.reduce((sum, e) => sum + Number(e.amount || 0), 0);

  const INCOME_CASE_STATUS = new Set(["finished", "settle_review", "settled", "month_locked"]);

  const list = d.case_performances
    .filter((row) => row.service_case && INCOME_CASE_STATUS.has(row.service_case.status))
    .map((row) => {
    const sc = row.service_case;
    const share = sc?.case_perf_shares?.[0];
    const shared = !!share;
    const myPerf = shared ? Number(share.perf_amount || 0) : Number(row.perf_final || 0);
    const events = sc?.assessment_events || [];
    const eventPenaltyTotal = events.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const expenses = (sc?.case_expense_claims || []).map((e) => ({
      id: e.id,
      serviceCaseId: e.service_case_id,
      workUnitId: e.work_unit_id,
      unitSeq: e.work_unit?.seq ?? null,
      amount: String(e.amount ?? 0),
      claimAmount: e.claim_amount == null ? null : String(e.claim_amount),
      note: e.note,
      status: e.status,
      reviewNote: e.review_note,
      tripSkipped: !!e.trip_skipped,
    }));
    const items = (sc?.po_orders || [])
      .flatMap((po) => po.po_items || [])
      .filter((it) => it.price_status !== "ignored")
      .map((it) => ({
        itemName: String(it.item_name || it.item_code || ""),
        qty: String(it.qty ?? 0),
        perfPrice: it.perf_price == null ? "0" : String(it.perf_price),
        itemPerf: String(it.item_perf ?? 0),
        caseItemPerf: String(it.item_perf ?? 0),
      }));

    return {
      id: row.id,
      gspCaseNo: row.gsp_case_no,
      perfBase: String(row.perf_base ?? 0),
      deduction: String(row.deduction ?? 0),
      deductionReason: row.deduction_reason,
      perfFinal: myPerf.toFixed(2),
      casePerfFinal: String(row.perf_final ?? 0),
      caseRevenue: String(row.case_revenue ?? 0),
      myShareRatio: share ? String(share.share_ratio ?? 0) : undefined,
      myCompletedUnits: share?.completed_units ?? null,
      plannedUnits: sc?.planned_units ?? null,
      assignMode: (sc?.assign_mode as "single" | "multi") || "single",
      isShared: shared,
      reviewStatus: row.review_status as "pending" | "approved" | "rejected",
      reviewComment: row.review_comment,
      serviceCase: sc
        ? {
            id: sc.id,
            gspCaseNo: sc.gsp_case_no,
            projectName: sc.project_name,
            status: sc.status,
            finishTime: sc.finish_time,
          }
        : undefined,
      items,
      eventPenalties: events.map((e) => ({
        id: e.id,
        category: e.category,
        content: e.content,
        amount: String(e.amount ?? 0),
        remark: e.remark,
      })),
      eventPenaltyTotal: eventPenaltyTotal.toFixed(2),
      expenses,
    };
  });

  const approvedAmount = list
    .filter((x) => x.reviewStatus === "approved")
    .reduce((sum, x) => sum + Number(x.perfFinal || 0), 0);
  const pendingAmount = list
    .filter((x) => x.reviewStatus === "pending")
    .reduce((sum, x) => sum + Number(x.perfFinal || 0), 0);
  const rejectedAmount = list
    .filter((x) => x.reviewStatus === "rejected")
    .reduce((sum, x) => sum + Number(x.perfFinal || 0), 0);

  return ok({
    month,
    approvedAmount: String(settlement?.perf_total ?? approvedAmount),
    pendingAmount: pendingAmount.toFixed(2),
    rejectedAmount: rejectedAmount.toFixed(2),
    totalAmount: String(settlement?.final_amount ?? approvedAmount),
    caseCount: list.length,
    list,
    assessment: assessment
      ? {
          totalScore: String(assessment.total_score ?? 0),
          rankResult: assessment.rank_result || undefined,
          rewardAmount: String(assessment.reward_amount ?? 0),
          eventPenalty: String(
            settlement?.event_penalty ??
              Number(assessment.event_penalty || 0) + orphanEventPenalty,
          ),
          toolSubsidy: String(assessment.tool_subsidy ?? 0),
          otherSubsidy: String(assessment.other_subsidy ?? 0),
          subsidyRemark: assessment.subsidy_remark || undefined,
          correctionAmount: String(assessment.correction_amount ?? 0),
          correctionReason: assessment.correction_reason,
        }
      : null,
    monthlySettlement: settlement
      ? {
          perfTotal: String(settlement.perf_total ?? 0),
          expenseTotal: String(settlement.expense_total ?? 0),
          rewardTotal: String(settlement.reward_total ?? 0),
          eventPenalty: String(settlement.event_penalty ?? 0),
          subsidyTotal: String(settlement.subsidy_total ?? 0),
          correctionTotal: String(settlement.correction_total ?? 0),
          finalAmount: String(settlement.final_amount ?? 0),
          status: settlement.status,
        }
      : null,
    otherEventPenalties: d.assessment_events.map((e) => ({
      id: e.id,
      category: e.category,
      content: e.content,
      amount: String(e.amount ?? 0),
      remark: e.remark,
    })),
  });
}

void (null as unknown as Handler);
