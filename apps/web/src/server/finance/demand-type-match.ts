import { adminGql } from "@/lib/hasura-admin";

export type DemandMatchWarningCode =
  | "service_type_not_found"
  | "product_line_not_found"
  | "product_line_empty";

export type DemandMatchWarning = {
  row?: number;
  gspCaseNo?: string;
  code: DemandMatchWarningCode;
  message: string;
};

type TemplateLike = {
  id: string;
  name: string;
  is_global: boolean;
  site_id: string | null;
  product_lines: Array<{ name?: string; entries?: unknown[] }> | null;
  entries: unknown[] | null;
  unit_label: string | null;
  assign_mode: string | null;
  expense_enabled_default: boolean | null;
};

type CaseLike = {
  id: string;
  gspCaseNo: string;
  serviceType: string | null;
  productLine: string | null;
  taskTemplateId: string | null;
  plannedUnits?: number | null;
};

const CASE_MATCH_FIELDS = `
  id gsp_case_no service_type product_line task_template_id planned_units
`;

function toCaseLike(row: {
  id: string;
  gsp_case_no: string;
  service_type: string | null;
  product_line: string | null;
  task_template_id: string | null;
  planned_units?: number | null;
}): CaseLike {
  return {
    id: row.id,
    gspCaseNo: row.gsp_case_no,
    serviceType: row.service_type,
    productLine: row.product_line,
    taskTemplateId: row.task_template_id,
    plannedUnits: row.planned_units,
  };
}

function matchProductLine(template: TemplateLike, productLine: string | null | undefined) {
  const lines = Array.isArray(template.product_lines) ? template.product_lines : [];
  const name = String(productLine || "").trim();
  if (!name || !lines.length) return null;
  return lines.find((p) => String(p.name || "").trim() === name) || null;
}

function findTemplate(templates: TemplateLike[], demandType: string | null | undefined) {
  const demand = String(demandType || "").trim();
  if (!demand) return null;
  return (
    templates.find((t) => t.name === demand && t.is_global && !t.site_id) ||
    templates.find((t) => t.name === demand) ||
    null
  );
}

function inspectDemandMatch(serviceCase: CaseLike, template: TemplateLike | null): DemandMatchWarning[] {
  const warnings: DemandMatchWarning[] = [];
  const demand = String(serviceCase.serviceType || "").trim();
  const productLine = String(serviceCase.productLine || "").trim();
  const gspCaseNo = serviceCase.gspCaseNo;

  if (demand && !template && !serviceCase.taskTemplateId) {
    warnings.push({
      gspCaseNo,
      code: "service_type_not_found",
      message: `服务类型「${demand}」未在系统中精确匹配，请到「服务类型」新增同名类型（案例已导入，不阻断）`,
    });
    return warnings;
  }
  if (!template) return warnings;
  const lines = Array.isArray(template.product_lines) ? template.product_lines : [];
  if (productLine) {
    if (!matchProductLine(template, productLine)) {
      warnings.push({
        gspCaseNo,
        code: "product_line_not_found",
        message: lines.length
          ? `产品线「${productLine}」在服务类型「${template.name}」下不存在，请到「服务类型」新增同名产品线（案例已导入，不阻断）`
          : `服务类型「${template.name}」尚未配置产品线，案例需要「${productLine}」，请到「服务类型」新增同名产品线（案例已导入，不阻断）`,
      });
    }
    return warnings;
  }
  if (lines.length) {
    warnings.push({
      gspCaseNo,
      code: "product_line_empty",
      message: `服务类型「${template.name}」已配置产品线，但案例未填写产品线（案例已导入，不阻断）`,
    });
  }
  return warnings;
}

export async function applyDemandTypeForCases(
  list: CaseLike[],
): Promise<{ matched: number; warnings: DemandMatchWarning[] }> {
  if (!list.length) return { matched: 0, warnings: [] };
  const d = await adminGql<{ inspection_templates: TemplateLike[] }>(
    `query {
      inspection_templates(limit: 1000) {
        id name is_global site_id product_lines entries unit_label assign_mode expense_enabled_default
      }
    }`,
  );
  const templates = d.inspection_templates || [];
  let matched = 0;
  const warnings: DemandMatchWarning[] = [];
  const updates: Array<{
    where: { id: { _eq: string } };
    _set: Record<string, unknown>;
  }> = [];

  for (const item of list) {
    let tpl: TemplateLike | null = null;
    const set: Record<string, unknown> = {};
    if (!item.taskTemplateId) {
      tpl = findTemplate(templates, item.serviceType);
      if (tpl) {
        set.task_template_id = tpl.id;
        set.task_type = String(tpl.name || "").slice(0, 128) || tpl.id;
        set.unit_label = tpl.unit_label || "台";
        set.expense_enabled = true;
        set.assign_mode = tpl.assign_mode || "single";
        if (!item.plannedUnits || item.plannedUnits < 1) set.planned_units = 1;
        item.taskTemplateId = tpl.id;
        matched += 1;
      }
    } else {
      tpl = templates.find((t) => t.id === item.taskTemplateId) || null;
    }
    if (tpl && item.productLine) {
      const m = matchProductLine(tpl, item.productLine);
      if (m?.name && m.name !== item.productLine) {
        set.product_line = m.name;
        item.productLine = m.name;
      }
    }
    if (Object.keys(set).length) {
      updates.push({ where: { id: { _eq: item.id } }, _set: set });
    }
    for (const w of inspectDemandMatch(item, tpl)) {
      warnings.push({ ...w, gspCaseNo: w.gspCaseNo || item.gspCaseNo });
    }
  }

  for (const u of updates) {
    await adminGql(
      `mutation ($id: uuid!, $set: service_cases_set_input!) {
        update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: u.where.id._eq, set: u._set },
    );
  }
  return { matched, warnings };
}

/** 服务类型新建/改产品线后：按同名服务类型或已绑模板精确重匹配 */
export async function rematchCasesForTemplate(template: {
  id?: string | null;
  name?: string | null;
}): Promise<number> {
  const name = String(template.name || "").trim();
  const or: Record<string, unknown>[] = [];
  if (template.id) or.push({ task_template_id: { _eq: template.id } });
  if (name) or.push({ service_type: { _eq: name } });
  if (!or.length) return 0;
  const d = await adminGql<{
    service_cases: Array<{
      id: string;
      gsp_case_no: string;
      service_type: string | null;
      product_line: string | null;
      task_template_id: string | null;
      planned_units: number | null;
    }>;
  }>(
    `query ($where: service_cases_bool_exp) {
      service_cases(where: $where, limit: 5000) { ${CASE_MATCH_FIELDS} }
    }`,
    { where: { _or: or } },
  );
  const { matched } = await applyDemandTypeForCases((d.service_cases || []).map(toCaseLike));
  return matched;
}

export async function rematchUnboundCases() {
  const d = await adminGql<{
    service_cases: Array<{
      id: string;
      gsp_case_no: string;
      service_type: string | null;
      product_line: string | null;
      task_template_id: string | null;
      planned_units: number | null;
    }>;
  }>(
    `query {
      service_cases(where: { task_template_id: { _is_null: true } }, limit: 5000) {
        ${CASE_MATCH_FIELDS}
      }
    }`,
  );
  return applyDemandTypeForCases((d.service_cases || []).map(toCaseLike));
}

export async function syncBoundCaseNames(
  templateId: string,
  opts: {
    oldTypeName: string;
    newTypeName: string;
    lineRenames: Array<{ from: string; to: string }>;
  },
): Promise<number> {
  const d = await adminGql<{
    service_cases: Array<{
      id: string;
      service_type: string | null;
      product_line: string | null;
      task_type: string | null;
    }>;
  }>(
    `query ($id: uuid!) {
      service_cases(where: { task_template_id: { _eq: $id } }, limit: 5000) {
        id service_type product_line task_type
      }
    }`,
    { id: templateId },
  );
  const list = d.service_cases || [];
  if (!list.length) return 0;
  let n = 0;
  const typeChanged =
    !!opts.oldTypeName && !!opts.newTypeName && opts.oldTypeName !== opts.newTypeName;
  for (const item of list) {
    const set: Record<string, unknown> = {};
    if (typeChanged) {
      set.service_type = opts.newTypeName.slice(0, 32);
      set.task_type = opts.newTypeName.slice(0, 128);
    }
    const pl = String(item.product_line || "").trim();
    if (pl) {
      const hit = opts.lineRenames.find((r) => r.from === pl);
      if (hit) set.product_line = hit.to.slice(0, 64);
    }
    if (!Object.keys(set).length) continue;
    await adminGql(
      `mutation ($id: uuid!, $set: service_cases_set_input!) {
        update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: item.id, set },
    );
    n += 1;
  }
  return n;
}
