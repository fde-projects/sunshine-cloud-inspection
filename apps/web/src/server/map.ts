import { parseHardRuleBindings, parseHardRuleSamples } from "@/lib/hard-rule-match";
import { adminGql } from "@/lib/hasura-admin";
import type { AppUser } from "./http";
import { resolveEntryAiEnabled } from "./record-audit-route";

function summarizeRecordAi(entries: unknown, snapshot: unknown) {
  const list = Array.isArray(entries) ? entries : [];
  const snaps = Array.isArray(snapshot) ? snapshot : [];
  const byId = new Map<string, { aiEnabled?: boolean; entryKind?: string; checkType?: string }>();
  for (const raw of snaps) {
    const item = (raw || {}) as {
      id?: string;
      aiEnabled?: boolean;
      entryKind?: string;
      checkType?: string;
    };
    if (item.id) byId.set(String(item.id), item);
  }
  const summary = { pass: 0, fail: 0, pending: 0, error: 0 };
  for (const raw of list) {
    const entry = (raw || {}) as {
      templateEntryId?: string;
      aiResult?: { status?: string } | null;
    };
    const tpl = byId.get(String(entry.templateEntryId || ""));
    const aiOn = tpl ? resolveEntryAiEnabled(tpl) : !!entry.aiResult;
    if (!aiOn) continue;
    const status = entry.aiResult?.status || "error";
    if (status === "pass") summary.pass += 1;
    else if (status === "fail") summary.fail += 1;
    else if (status === "pending") summary.pending += 1;
    else summary.error += 1;
  }
  return summary;
}

function personName(raw: unknown) {
  const person = (raw || {}) as { real_name?: string; realName?: string };
  return person.real_name || person.realName || null;
}

function inspectorNameFromRecord(row: Record<string, unknown>, task?: Record<string, unknown>) {
  const fromTask = personName(task?.inspector);
  if (fromTask) return fromTask;
  const fromUnit = personName((task?.work_unit as { inspector?: unknown } | undefined)?.inspector);
  if (fromUnit) return fromUnit;
  const trail = Array.isArray(row.audit_trail) ? row.audit_trail : [];
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const ev = (trail[i] || {}) as { action?: string; byName?: string; by_name?: string };
    const name = ev.byName || ev.by_name;
    if ((ev.action === "submitted" || ev.action === "resubmitted") && name && name !== "系统") {
      return String(name);
    }
  }
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const ev = (trail[i] || {}) as { byName?: string; by_name?: string };
    const name = ev.byName || ev.by_name;
    if (name && name !== "系统") return String(name);
  }
  return null;
}

export const CASE_CORE_FIELDS = `
  id gsp_case_no project_name service_type product_line creator province city site_desc
  site_id task_type task_template_id assign_mode planned_units completed_units
  expense_enabled unit_label region status inspector_id assign_remark finish_time
  updated_at created_at assign_time
  site { id name manager { real_name } }
  inspector { id real_name username phone }
  task_template { id name unit_label product_lines assign_mode }
  case_assignments(where: { status: { _neq: "withdrawn" } }) {
    inspector_id status completed_units
    inspector { real_name username phone }
  }
  case_performance {
    id case_revenue perf_base perf_final deduction review_status review_comment
    inspector_id month
  }
`;

export const CASE_FIELDS = `
  ${CASE_CORE_FIELDS}
  po_orders { id }
`;

export const PO_ITEM_FIELDS = `
  id po_order_id item_category item_code item_name item_desc unit qty
  settle_price perf_price item_revenue item_perf price_status
`;

export const PO_ORDER_FIELDS = `
  id po_no gsp_case_no service_case_id po_total_amount demand_date demander demand_type
  product_line product_model product_qty match_status
  fault_phenomenon fault_level duration_req demand_desc
  project_area project_country project_region province project_name project_scene
  submitter dingtalk_created_at dingtalk_updated_at
`;

export function mapPoItem(it: Record<string, unknown>, hidePerf = false) {
  return {
    id: it.id,
    poId: it.po_order_id,
    itemCategory: it.item_category,
    itemCode: it.item_code,
    itemName: it.item_name,
    itemDesc: it.item_desc,
    unit: it.unit,
    qty: it.qty,
    settlePrice: it.settle_price,
    perfPrice: hidePerf ? undefined : it.perf_price,
    itemRevenue: it.item_revenue,
    itemPerf: hidePerf ? undefined : it.item_perf,
    priceStatus: it.price_status,
  };
}

export function mapPoOrder(
  r: Record<string, unknown>,
  opts?: { hidePerf?: boolean; linkedCase?: Record<string, unknown> | null },
) {
  const hidePerf = Boolean(opts?.hidePerf);
  const items = ((r.po_items as Record<string, unknown>[]) || []).map((it) =>
    mapPoItem(it, hidePerf),
  );
  const linked = (opts?.linkedCase ?? (r.service_case as Record<string, unknown> | null)) || null;
  return {
    id: r.id,
    poNo: r.po_no,
    gspCaseNo: r.gsp_case_no,
    serviceCaseId: r.service_case_id,
    poTotalAmount: String(r.po_total_amount ?? 0),
    demandDate: r.demand_date,
    demander: r.demander,
    demandType: r.demand_type,
    productLine: r.product_line,
    productModel: r.product_model,
    productQty: r.product_qty,
    faultPhenomenon: r.fault_phenomenon ?? null,
    faultLevel: r.fault_level ?? null,
    durationReq: r.duration_req ?? null,
    demandDesc: r.demand_desc ?? null,
    projectArea: r.project_area ?? null,
    projectCountry: r.project_country ?? null,
    projectRegion: r.project_region ?? null,
    province: r.province ?? null,
    projectName: r.project_name ?? null,
    projectScene: r.project_scene ?? null,
    submitter: r.submitter ?? null,
    dingtalkCreatedAt: r.dingtalk_created_at ?? null,
    dingtalkUpdatedAt: r.dingtalk_updated_at ?? null,
    matchStatus: r.service_case_id ? "matched" : "pending",
    linkedCase: linked
      ? {
          id: linked.id,
          gspCaseNo: linked.gsp_case_no,
          projectName: linked.project_name,
          province: linked.province,
          city: linked.city,
          siteDesc: linked.site_desc,
          serviceType: linked.service_type,
          productLine: linked.product_line,
          region: linked.region,
          status: linked.status,
        }
      : null,
    items,
    specialItemCount: items.filter((x) => x.itemCategory === "special").length,
    generalItemCount: items.filter((x) => x.itemCategory === "general").length,
  };
}

export function mapCase(row: Record<string, unknown>) {
  const site = row.site as { id?: string; name?: string; manager?: { real_name?: string } } | null;
  const inspector = row.inspector as { id?: string; real_name?: string } | null;
  const tpl = row.task_template as { id?: string; name?: string } | null;
  const assignments = (row.case_assignments as Array<Record<string, unknown>>) || [];
  const names = assignments
    .map((a) => (a.inspector as { real_name?: string } | null)?.real_name)
    .filter(Boolean);
  const perf = row.case_performance as {
    id?: string;
    case_revenue?: string | number;
    perf_base?: string | number;
    perf_final?: string | number;
    deduction?: string | number;
    review_status?: string;
    review_comment?: string | null;
  } | null;
  const pos = (row.po_orders as unknown[]) || [];
  const perfBase = Number(perf?.perf_base ?? 0);
  const deduction = Number(perf?.deduction ?? 0);
  const perfFinal = Number(perf?.perf_final ?? Math.max(0, perfBase - deduction));
  return {
    id: row.id,
    gspCaseNo: row.gsp_case_no,
    projectName: row.project_name,
    serviceType: row.service_type,
    productLine: row.product_line,
    creator: row.creator,
    province: row.province,
    city: row.city,
    siteDesc: row.site_desc,
    region: row.region,
    status: row.status,
    siteId: row.site_id,
    siteName: site?.name || null,
    siteManagerName: site?.manager?.real_name || null,
    taskType: row.task_type,
    taskTemplateId: row.task_template_id,
    taskTypeName: tpl?.name || null,
    assignMode: row.assign_mode || "single",
    plannedUnits: row.planned_units,
    completedUnits: row.completed_units,
    expenseEnabled: row.expense_enabled,
    unitLabel: row.unit_label || "台",
    inspectorId: row.inspector_id,
    inspectorName: names.join("、") || inspector?.real_name || null,
    assignRemark: row.assign_remark,
    finishTime: row.finish_time,
    updatedAt: row.updated_at,
    hasPo: pos.length > 0,
    caseRevenue: pos.length > 0 ? String(perf?.case_revenue ?? "0") : "0",
    perfBase: perfBase.toFixed(2),
    deduction: deduction.toFixed(2),
    perfFinal: perfFinal.toFixed(2),
    reviewStatus: String(perf?.review_status || "pending"),
    reviewComment: perf?.review_comment ?? null,
    deductionStatus: "none",
    missingPerf: 0,
    missingSettle: 0,
    pendingExpenseCount: 0,
    approvalReady: !!row.inspector_id,
    overdue: false,
    assignments: assignments.map((a) => {
      const ins = a.inspector as { real_name?: string; username?: string; phone?: string } | null;
      return {
        inspectorId: a.inspector_id,
        inspectorName: ins?.real_name,
        username: ins?.username,
        phone: ins?.phone,
        status: a.status,
        completedUnits: a.completed_units,
      };
    }),
  };
}

export function caseWhere(user: AppUser, query: URLSearchParams) {
  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];
  if (user.role === "site_manager") {
    if (!user.managedSiteIds.length) return { _and: [{ id: { _is_null: true } }] };
    and.push({ site_id: { _in: user.managedSiteIds } });
  }
  const siteId = query.get("siteId");
  if (siteId) and.push({ site_id: { _eq: siteId } });
  if (query.get("siteBind") === "unassigned") and.push({ site_id: { _is_null: true } });
  if (query.get("siteBind") === "assigned_site") and.push({ site_id: { _is_null: false } });
  if (query.get("region")) and.push({ region: { _eq: query.get("region") } });
  if (query.get("province")?.trim()) and.push({ province: { _eq: query.get("province")!.trim() } });
  if (query.get("city")?.trim()) and.push({ city: { _eq: query.get("city")!.trim() } });
  if (query.get("status")) and.push({ status: { _eq: query.get("status") } });
  const taskType = query.get("taskType")?.trim();
  if (taskType) and.push({ task_template_id: { _eq: taskType } });
  const productLine = query.get("productLine")?.trim();
  if (productLine === "__empty__") {
    and.push({
      _or: [{ product_line: { _is_null: true } }, { product_line: { _eq: "" } }],
    });
  } else if (productLine) {
    and.push({ product_line: { _eq: productLine } });
  }
  const dateFrom = query.get("dateFrom")?.trim();
  const dateTo = query.get("dateTo")?.trim();
  if (dateFrom || dateTo) {
    const finishRange: Record<string, string> = {};
    const createdRange: Record<string, string> = {};
    if (dateFrom) {
      finishRange._gte = dateFrom;
      createdRange._gte = dateFrom;
    }
    if (dateTo) {
      // 含结束日当天
      finishRange._lte = `${dateTo}T23:59:59.999`;
      createdRange._lte = `${dateTo}T23:59:59.999`;
    }
    and.push({
      _or: [
        { finish_time: finishRange },
        {
          _and: [{ finish_time: { _is_null: true } }, { created_at: createdRange }],
        },
      ],
    });
  }
  const keyword = query.get("keyword")?.trim();
  if (keyword) {
    and.push({
      _or: [
        { gsp_case_no: { _ilike: `%${keyword}%` } },
        { project_name: { _ilike: `%${keyword}%` } },
      ],
    });
  }
  if (and.length) where._and = and;
  return where;
}

export async function loadCase(id: string) {
  const data = await adminGql<{ service_cases_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { service_cases_by_pk(id: $id) { ${CASE_FIELDS} } }`,
    { id },
  );
  return data.service_cases_by_pk;
}

export async function loadCaseDetail(id: string) {
  const data = await adminGql<{ service_cases_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) {
      service_cases_by_pk(id: $id) {
        ${CASE_CORE_FIELDS}
        po_orders(order_by: { created_at: desc }) {
          ${PO_ORDER_FIELDS}
          po_items(order_by: { created_at: asc }) { ${PO_ITEM_FIELDS} }
        }
      }
    }`,
    { id },
  );
  return data.service_cases_by_pk;
}

export function mapCaseDetail(row: Record<string, unknown>, user?: { role?: string }) {
  const base = mapCase(row);
  const hidePerf = user?.role !== "super_admin";
  const orders = ((row.po_orders as Record<string, unknown>[]) || []).map((po) =>
    mapPoOrder(po, { hidePerf }),
  );
  const priced = orders.flatMap((o) => o.items).filter((it) => it.priceStatus !== "ignored");
  const itemRevenue = priced.reduce((sum, it) => sum + Number(it.itemRevenue || 0), 0);
  const poTotal = orders.reduce((sum, o) => sum + Number(o.poTotalAmount || 0), 0);
  const revenue = orders.length ? itemRevenue : 0;
  const pendingPrice = priced.filter((it) => it.priceStatus === "pending_price").length;
  const mismatch = poTotal > 0.009 && Math.abs(revenue - poTotal) > 0.01;
  const poLabel = poTotal.toFixed(2);
  const incomeLabel = revenue.toFixed(2);
  let notice: { type: "warning" | "info"; message: string; description: string } | null = null;
  if (pendingPrice > 0) {
    notice = {
      type: "warning",
      message: `有 ${pendingPrice} 条待定价，尚未计入案例收入`,
      description: `PO 表头 ¥${poLabel}，已核算 ¥${incomeLabel}。下表橙色「待定价」就是缺结算价的行，可点「未配」去价格库补。`,
    };
  } else if (mismatch) {
    notice = {
      type: "info",
      message: "案例收入与 PO 表头金额不同",
      description: `PO 表头 ¥${poLabel} 是单据总额；案例收入 ¥${incomeLabel} 是已定价条目加总。差几块通常是表头含未计价项，下表可对行。`,
    };
  }
  return {
    ...base,
    hasPo: orders.length > 0,
    orders,
    caseRevenue: incomeLabel,
    reconciliation: {
      poTotal: poLabel,
      caseRevenue: incomeLabel,
      varianceRate: poTotal ? Math.abs(revenue - poTotal) / poTotal : 0,
      pendingPrice,
      notice,
    },
  };
}

export function mapTask(row: Record<string, unknown>) {
  const site = row.site as Record<string, unknown> | null;
  const device = row.device as Record<string, unknown> | null;
  const inspector = row.inspector as Record<string, unknown> | null;
  const recs = (row.inspection_records as Array<Record<string, unknown>>) || [];
  const rec = recs[0];
  const sc = row.service_case as Record<string, unknown> | null;
  return {
    id: row.id,
    siteId: row.site_id,
    deviceId: row.device_id,
    taskName: row.task_name,
    inspectorId: row.inspector_id,
    status: row.status,
    startedAt: row.started_at,
    createdAt: row.created_at,
    aiEnabled: row.ai_enabled,
    serviceCaseId: row.service_case_id,
    workUnitId: row.work_unit_id,
    taskType: row.task_type,
    taskTypeName: (sc?.task_template as { name?: string } | null)?.name || sc?.task_type,
    serviceType: sc?.service_type,
    gspCaseNo: (sc?.gsp_case_no as string) || null,
    productLine: (sc?.product_line as string) || null,
    templateSnapshot: row.template_snapshot,
    site: site
      ? {
          id: site.id,
          name: site.name,
          code: site.code,
          province: site.province,
          city: site.city,
          district: site.district,
        }
      : undefined,
    device: device
      ? {
          id: device.id,
          serialNumber: device.serial_number,
          deviceType: device.device_type,
          model: device.model,
        }
      : undefined,
    inspector: inspector
      ? { id: inspector.id, realName: inspector.real_name, phone: inspector.phone }
      : undefined,
    record: rec
      ? {
          id: rec.id,
          status: rec.status,
          entries: rec.entries,
          rejectReason: rec.reject_reason,
        }
      : null,
  };
}

export function mapRecord(row: Record<string, unknown>) {
  const task = row.inspection_task || row.task;
  const t = task as Record<string, unknown> | undefined;
  return {
    id: row.id,
    taskId: row.task_id,
    deviceType: row.device_type,
    entries: row.entries || [],
    reportPhotos: row.report_photos,
    location: row.location,
    status: row.status,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    rejectReason: row.reject_reason,
    auditTrail: row.audit_trail || [],
    inspectorName: inspectorNameFromRecord(row, t),
    gspCaseNo: (t?.service_case as { gsp_case_no?: string } | undefined)?.gsp_case_no || null,
    aiSummary: summarizeRecordAi(row.entries, t?.template_snapshot),
    createdAt: row.created_at,
    task: t
      ? {
          id: t.id,
          taskName: t.task_name,
          siteId: t.site_id,
          deviceId: t.device_id,
          aiEnabled: t.ai_enabled,
          templateSnapshot: t.template_snapshot,
          inspector: t.inspector,
          site: t.site,
          serviceCase: t.service_case,
        }
      : undefined,
  };
}

export function mapTemplate(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.device_type,
    entries: row.entries || [],
    productLines: row.product_lines || [],
    isGlobal: row.is_global,
    siteId: row.site_id,
    assignMode: row.assign_mode,
    unitLabel: row.unit_label,
    expenseEnabledDefault: row.expense_enabled_default,
    version: row.version,
    createdAt: row.created_at,
  };
}

export const BUILTIN_HARD_RULE_CODES = new Set([
  "ac_side",
  "grounding",
  "dc_side",
  "fault_record",
  "sungrow",
  "mount_fix",
]);

export function mapHardRule(row: Record<string, unknown>) {
  const code = String(row.code || "");
  return {
    id: row.id,
    code,
    name: row.name,
    matchMode: row.match_mode,
    matchPattern: row.match_pattern,
    promptText: row.prompt_text,
    jsonSchemaHint: row.json_schema_hint,
    enabled: row.enabled,
    enforceMode: row.enforce_mode,
    version: row.version,
    changeNote: row.change_note,
    updatedBy: row.updated_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    builtin: false,
    hasDefault: BUILTIN_HARD_RULE_CODES.has(code),
    bindings: parseHardRuleBindings({
      matchMode: String(row.match_mode || ""),
      matchPattern: String(row.match_pattern || ""),
      jsonSchemaHint: (row.json_schema_hint as string | null) || null,
    }),
    samples: parseHardRuleSamples({
      jsonSchemaHint: (row.json_schema_hint as string | null) || null,
    }),
  };
}

export function mapUser(row: Record<string, unknown>) {
  return {
    id: row.id,
    username: row.username,
    realName: row.real_name,
    employeeNo: row.employee_no,
    phone: row.phone,
    email: row.email,
    avatar: row.avatar,
    role: row.role,
    roles: row.roles || [row.role],
    status: row.status,
    region: row.region,
    orgUnit: row.org_unit,
    createdBy: row.created_by_id,
    createdAt: row.created_at,
  };
}
