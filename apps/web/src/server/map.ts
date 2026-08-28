import { adminGql } from "@/lib/hasura-admin";
import type { AppUser } from "./http";

export const CASE_FIELDS = `
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
  case_performance { case_revenue }
  po_orders { id }
`;

export function mapCase(row: Record<string, unknown>) {
  const site = row.site as { id?: string; name?: string; manager?: { real_name?: string } } | null;
  const inspector = row.inspector as { id?: string; real_name?: string } | null;
  const tpl = row.task_template as { id?: string; name?: string } | null;
  const assignments = (row.case_assignments as Array<Record<string, unknown>>) || [];
  const names = assignments
    .map((a) => (a.inspector as { real_name?: string } | null)?.real_name)
    .filter(Boolean);
  const perf = row.case_performance as { case_revenue?: string | number } | null;
  const pos = (row.po_orders as unknown[]) || [];
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
    caseRevenue: String(perf?.case_revenue ?? "0"),
    hasPo: pos.length > 0,
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

export function mapHardRule(row: Record<string, unknown>) {
  return {
    id: row.id,
    code: row.code,
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
