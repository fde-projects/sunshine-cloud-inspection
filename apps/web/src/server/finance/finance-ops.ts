import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { adminGql } from "@/lib/hasura-admin";
import { HttpError } from "../http";
import { applyDemandTypeForCases } from "./demand-type-match";
import { gqlPages } from "./gql";
import { recalculate, recalculateLedgers, repriceByPoIds } from "./price-mapping";
import { money } from "./types";

const FINANCE_CLEAR_CONFIRM_TEXT = "清空";
const EXPORT_MAX_ROWS = 5000;

export function assertFinanceClearAllowed(confirm?: string | null) {
  if (String(confirm || "").trim() !== FINANCE_CLEAR_CONFIRM_TEXT) {
    throw new HttpError(400, `请输入确认文案「${FINANCE_CLEAR_CONFIRM_TEXT}」`);
  }
  const explicit = process.env.ALLOW_FINANCE_DATA_CLEAR === "true";
  const vercelEnv = String(process.env.VERCEL_ENV || "").toLowerCase();
  const nodeEnv = String(process.env.NODE_ENV || "").toLowerCase();
  const allowed =
    explicit || vercelEnv === "preview" || vercelEnv === "development" || nodeEnv !== "production";
  if (!allowed) {
    throw new HttpError(403, "生产环境禁止一键清空，请在 Preview/测试环境操作或设置 ALLOW_FINANCE_DATA_CLEAR");
  }
}

export async function generateCasesFromPo() {
  const pending = await gqlPages<{
    id: string;
    po_no: string;
    gsp_case_no: string;
    project_name: string | null;
    demand_type: string | null;
    product_line: string | null;
    submitter: string | null;
    province: string | null;
    project_region: string | null;
    demand_desc: string | null;
    project_area: string | null;
    import_batch_id: string | null;
    dingtalk_updated_at: string | null;
    demand_date: string | null;
    updated_at: string;
  }>(
    "po_orders",
    "po_orders_bool_exp",
    "id po_no gsp_case_no project_name demand_type product_line submitter province project_region demand_desc project_area import_batch_id dingtalk_updated_at demand_date updated_at",
    { match_status: { _eq: "pending" } },
    "{ demand_date: asc }",
  );
  const failures: Array<{ poNo: string; reason: string }> = [];
  if (!pending.length) {
    return { pendingOrders: 0, generatedCases: 0, matchedOrders: 0, failRows: 0, failures };
  }
  const gspNos = pending.map((o) => o.gsp_case_no);
  const existing: Array<{ id: string; gsp_case_no: string; service_type: string | null; product_line: string | null; task_template_id: string | null }> = [];
  for (let i = 0; i < gspNos.length; i += 200) {
    const d = await adminGql<{ service_cases: typeof existing }>(
      `query ($nos: [String!]!) {
        service_cases(where: { gsp_case_no: { _in: $nos } }) { id gsp_case_no service_type product_line task_template_id }
      }`,
      { nos: gspNos.slice(i, i + 200) },
    );
    existing.push(...d.service_cases);
  }
  const caseMap = new Map(existing.map((r) => [r.gsp_case_no, r]));
  let generated = 0;
  for (const order of pending) {
    if (caseMap.has(order.gsp_case_no)) continue;
    try {
      const d = await adminGql<{ insert_service_cases_one: { id: string } }>(
        `mutation ($obj: service_cases_insert_input!) { insert_service_cases_one(object: $obj) { id } }`,
        {
          obj: {
            gsp_case_no: order.gsp_case_no,
            project_name: order.project_name || order.po_no,
            service_type: order.demand_type,
            product_line: order.product_line,
            creator: order.submitter,
            province: order.province,
            city: order.project_region,
            site_desc: order.demand_desc || order.project_area,
            region: order.province?.includes("云南") ? "yunnan" : "south_china",
            status: "settle_review",
            finish_time: order.dingtalk_updated_at || (order.demand_date ? `${order.demand_date}T12:00:00+08:00` : order.updated_at),
            import_batch_id: order.import_batch_id,
            version: 1,
          },
        },
      );
      caseMap.set(order.gsp_case_no, {
        id: d.insert_service_cases_one.id,
        gsp_case_no: order.gsp_case_no,
        service_type: order.demand_type,
        product_line: order.product_line,
        task_template_id: null,
      });
      generated += 1;
    } catch (error) {
      failures.push({ poNo: order.po_no, reason: error instanceof Error ? error.message : "建案例失败" });
    }
  }
  await applyDemandTypeForCases(
    [...caseMap.values()].map((c) => ({
      id: c.id,
      gspCaseNo: c.gsp_case_no,
      serviceType: c.service_type,
      productLine: c.product_line,
      taskTemplateId: c.task_template_id,
    })),
  );
  const matchedIds: string[] = [];
  for (const order of pending) {
    const sc = caseMap.get(order.gsp_case_no);
    if (!sc) continue;
    await adminGql(
      `mutation ($id: uuid!, $cid: uuid!) {
        update_po_orders_by_pk(pk_columns: { id: $id }, _set: { service_case_id: $cid, match_status: "matched" }) { id }
      }`,
      { id: order.id, cid: sc.id },
    );
    matchedIds.push(sc.id);
  }
  await recalculateLedgers(matchedIds);
  return {
    pendingOrders: pending.length,
    generatedCases: generated,
    matchedOrders: matchedIds.length,
    failRows: failures.length,
    failures,
  };
}

export async function clearPoOrders(confirm?: string | null) {
  assertFinanceClearAllowed(confirm);
  const count = await adminGql<{ po_orders_aggregate: { aggregate: { count: number } } }>(
    `query { po_orders_aggregate { aggregate { count } } }`,
  );
  await adminGql(`mutation { delete_po_orders(where: {}) { affected_rows } }`);
  return { deleted: count.po_orders_aggregate.aggregate.count };
}

export async function clearPrices(type: string | null, confirm?: string | null) {
  assertFinanceClearAllowed(confirm);
  if (type !== "settle" && type !== "perf") throw new HttpError(400, "请指定要清空的价格类型");
  const count = await adminGql<{ price_library_aggregate: { aggregate: { count: number } } }>(
    `query ($t: String!) { price_library_aggregate(where: { price_type: { _eq: $t } }) { aggregate { count } } }`,
    { t: type },
  );
  await adminGql(
    `mutation ($t: String!) { delete_price_library(where: { price_type: { _eq: $t } }) { affected_rows } }`,
    { t: type },
  );
  const applied = await recalculate().catch(() => null);
  return { priceType: type, deleted: count.price_library_aggregate.aggregate.count, applied };
}

export async function clearCases(confirm?: string | null) {
  assertFinanceClearAllowed(confirm);
  const count = await adminGql<{ service_cases_aggregate: { aggregate: { count: number } } }>(
    `query { service_cases_aggregate { aggregate { count } } }`,
  );
  await adminGql(`mutation { delete_po_orders(where: {}) { affected_rows } }`);
  await adminGql(
    `mutation { delete_inspection_tasks(where: { service_case_id: { _is_null: false } }) { affected_rows } }`,
  );
  await adminGql(`mutation { delete_devices(where: { serial_number: { _like: "CASE-%" } }) { affected_rows } }`);
  await adminGql(`mutation { delete_service_cases(where: {}) { affected_rows } }`);
  return { deleted: count.service_cases_aggregate.aggregate.count };
}

export async function updatePo(id: string, body: Record<string, unknown>) {
  const order = await adminGql<{
    po_orders_by_pk: { id: string; service_case_id: string | null; service_case?: { status: string } | null } | null;
  }>(
    `query ($id: uuid!) { po_orders_by_pk(id: $id) { id service_case_id service_case { status } } }`,
    { id },
  );
  if (!order.po_orders_by_pk) throw new HttpError(404, "PO不存在");
  if (order.po_orders_by_pk.service_case?.status === "month_locked") {
    throw new HttpError(400, "关联案例已月结，不可编辑 PO");
  }
  const set: Record<string, unknown> = {};
  if (body.poTotalAmount !== undefined) set.po_total_amount = money(Number(body.poTotalAmount));
  if (body.productModel !== undefined) {
    set.product_model = body.productModel ? String(body.productModel).trim().slice(0, 64) : null;
  }
  if (body.productQty !== undefined) {
    set.product_qty = body.productQty == null ? null : money(Number(body.productQty));
  }
  if (body.projectScene !== undefined) {
    set.project_scene = body.projectScene ? String(body.projectScene).trim().slice(0, 32) : null;
  }
  if (Object.keys(set).length) {
    await adminGql(
      `mutation ($id: uuid!, $set: po_orders_set_input!) {
        update_po_orders_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id, set },
    );
  }
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) throw new HttpError(400, "条目格式无效");
    const items = body.items as Array<Record<string, unknown>>;
    for (const row of items) {
      const name = String(row.itemName || "").trim();
      if (!name) throw new HttpError(400, "服务条目名称不能为空");
      if (!["special", "general"].includes(String(row.itemCategory))) throw new HttpError(400, "条目分类无效");
      if (Number.isNaN(Number(row.qty)) || Number(row.qty) < 0) {
        throw new HttpError(400, `条目「${name}」数量无效`);
      }
    }
    await adminGql(`mutation ($id: uuid!) { delete_po_items(where: { po_order_id: { _eq: $id } }) { affected_rows } }`, {
      id,
    });
    if (items.length) {
      await adminGql(
        `mutation ($objects: [po_items_insert_input!]!) { insert_po_items(objects: $objects) { affected_rows } }`,
        {
          objects: items.map((row, index) => {
            const itemName = String(row.itemName).trim().slice(0, 255);
            return {
              po_order_id: id,
              source_row: index + 1,
              item_category: row.itemCategory,
              item_code: itemName,
              item_name: itemName,
              item_desc: row.itemDesc ? String(row.itemDesc).trim() : null,
              unit: row.unit ? String(row.unit).trim().slice(0, 32) : null,
              qty: money(Number(row.qty)),
              settle_price: null,
              perf_price: null,
              item_revenue: "0.00",
              item_perf: "0.00",
              price_status: "pending_price",
            };
          }),
        },
      );
    }
  }
  const reprice = await repriceByPoIds([id], { ignoreFreeze: true });
  return { id, reprice };
}

export async function matchPoToCase(id: string, gspCaseNo: string) {
  const gsp = String(gspCaseNo || "").trim();
  if (!gsp) throw new HttpError(400, "请填写 GSP 案例号");
  const c = await adminGql<{ service_cases: { id: string }[] }>(
    `query ($no: String!) { service_cases(where: { gsp_case_no: { _eq: $no } }) { id } }`,
    { no: gsp },
  );
  const cid = c.service_cases[0]?.id;
  if (!cid) throw new HttpError(404, "目标案例不存在");
  await adminGql(
    `mutation ($id: uuid!, $cid: uuid!, $gsp: String!) {
      update_po_orders_by_pk(pk_columns: { id: $id }, _set: { service_case_id: $cid, gsp_case_no: $gsp, match_status: "matched" }) { id }
    }`,
    { id, cid, gsp },
  );
  await repriceByPoIds([id], { ignoreFreeze: true });
  await recalculateLedgers([cid]);
  return { id, gspCaseNo: gsp, serviceCaseId: cid, matchStatus: "matched" };
}

export async function exportPoOrders(body: Record<string, unknown>) {
  const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String).filter(Boolean) : [];
  const where: Record<string, unknown> = {};
  if (ids.length) where.id = { _in: ids };
  else {
    if (body.matchStatus) where.match_status = { _eq: body.matchStatus };
    if (body.keyword) {
      where._or = [
        { po_no: { _ilike: `%${body.keyword}%` } },
        { gsp_case_no: { _ilike: `%${body.keyword}%` } },
        { project_name: { _ilike: `%${body.keyword}%` } },
      ];
    }
  }
  const orders = await gqlPages<Record<string, unknown>>(
    "po_orders",
    "po_orders_bool_exp",
    `id po_no gsp_case_no match_status po_total_amount product_model product_qty project_scene project_name demand_date fault_level duration_req demand_type product_line
     service_case { project_name }
     po_items { item_category item_name item_desc unit qty settle_price perf_price item_revenue item_perf price_status }`,
    where,
    "{ updated_at: desc }",
  );
  if (!orders.length) throw new HttpError(400, "没有可导出的 PO，请调整筛选或勾选");
  if (orders.length > EXPORT_MAX_ROWS) {
    throw new HttpError(400, `匹配 ${orders.length} 条，超过单次上限 ${EXPORT_MAX_ROWS}，请缩小筛选或勾选导出`);
  }
  const workbook = new ExcelJS.Workbook();
  const listSheet = workbook.addWorksheet("PO列表");
  listSheet.columns = [
    { header: "PO单号", key: "poNo", width: 18 },
    { header: "GSP案例号", key: "gspCaseNo", width: 18 },
    { header: "匹配状态", key: "matchStatus", width: 10 },
    { header: "PO总金额", key: "poTotalAmount", width: 12 },
    { header: "产品型号", key: "productModel", width: 20 },
    { header: "产品台数", key: "productQty", width: 10 },
    { header: "项目场景", key: "projectScene", width: 12 },
    { header: "项目名称", key: "projectName", width: 36 },
    { header: "需求日期", key: "demandDate", width: 12 },
    { header: "故障等级", key: "faultLevel", width: 12 },
    { header: "工期要求", key: "durationReq", width: 12 },
    { header: "需求类型", key: "demandType", width: 12 },
    { header: "产品线", key: "productLine", width: 16 },
  ];
  for (const order of orders) {
    const linked = order.service_case as { project_name?: string } | null;
    listSheet.addRow({
      poNo: order.po_no,
      gspCaseNo: order.gsp_case_no,
      matchStatus: order.match_status === "matched" ? "已匹配" : "待匹配",
      poTotalAmount: Number(order.po_total_amount || 0),
      productModel: order.product_model || "",
      productQty: order.product_qty == null ? "" : Number(order.product_qty),
      projectScene: order.project_scene || "",
      projectName: linked?.project_name || order.project_name || "",
      demandDate: order.demand_date || "",
      faultLevel: order.fault_level || "",
      durationReq: order.duration_req || "",
      demandType: order.demand_type || "",
      productLine: order.product_line || "",
    });
  }
  listSheet.getRow(1).font = { bold: true };
  const itemSheet = workbook.addWorksheet("服务条目");
  itemSheet.columns = [
    { header: "PO单号", key: "poNo", width: 18 },
    { header: "分类", key: "itemCategory", width: 10 },
    { header: "服务条目", key: "itemName", width: 28 },
    { header: "说明", key: "itemDesc", width: 28 },
    { header: "单位", key: "unit", width: 8 },
    { header: "数量", key: "qty", width: 8 },
    { header: "结算单价", key: "settlePrice", width: 12 },
    { header: "绩效单价", key: "perfPrice", width: 12 },
    { header: "行收入", key: "itemRevenue", width: 12 },
    { header: "行绩效", key: "itemPerf", width: 12 },
    { header: "价格状态", key: "priceStatus", width: 12 },
  ];
  for (const order of orders) {
    for (const it of (order.po_items as Record<string, unknown>[]) || []) {
      itemSheet.addRow({
        poNo: order.po_no,
        itemCategory: it.item_category === "special" ? "专用" : "通用",
        itemName: it.item_name,
        itemDesc: it.item_desc || "",
        unit: it.unit || "",
        qty: Number(it.qty || 0),
        settlePrice: it.settle_price == null ? "" : Number(it.settle_price),
        perfPrice: it.perf_price == null ? "" : Number(it.perf_price),
        itemRevenue: Number(it.item_revenue || 0),
        itemPerf: Number(it.item_perf || 0),
        priceStatus: it.price_status,
      });
    }
  }
  itemSheet.getRow(1).font = { bold: true };
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename: `PO导出-${new Date().toISOString().slice(0, 10)}.xlsx`, buffer };
}

export async function exportFinanceCases(body: Record<string, unknown>) {
  const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String).filter(Boolean) : [];
  const where: Record<string, unknown> = {};
  if (ids.length) where.id = { _in: ids };
  else {
    if (body.status) where.status = { _eq: body.status };
    if (body.keyword) {
      where._or = [
        { gsp_case_no: { _ilike: `%${body.keyword}%` } },
        { project_name: { _ilike: `%${body.keyword}%` } },
      ];
    }
  }
  const cases = await gqlPages<Record<string, unknown>>(
    "service_cases",
    "service_cases_bool_exp",
    `gsp_case_no project_name service_type product_line province city site_desc region status
     case_performance { case_revenue perf_base perf_final review_status }`,
    where,
    "{ updated_at: desc }",
  );
  if (!cases.length) throw new HttpError(400, "没有可导出的案例");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("案例");
  sheet.columns = [
    { header: "GSP案例号", key: "gsp", width: 18 },
    { header: "项目名称", key: "name", width: 36 },
    { header: "服务类型", key: "type", width: 16 },
    { header: "产品线", key: "line", width: 16 },
    { header: "省", key: "province", width: 10 },
    { header: "市", key: "city", width: 12 },
    { header: "区域", key: "region", width: 12 },
    { header: "状态", key: "status", width: 14 },
    { header: "案例收入", key: "revenue", width: 12 },
    { header: "绩效基数", key: "perf", width: 12 },
    { header: "审核状态", key: "review", width: 12 },
  ];
  for (const c of cases) {
    const p = c.case_performance as Record<string, unknown> | null;
    sheet.addRow({
      gsp: c.gsp_case_no,
      name: c.project_name,
      type: c.service_type,
      line: c.product_line,
      province: c.province,
      city: c.city,
      region: c.region,
      status: c.status,
      revenue: Number(p?.case_revenue || 0),
      perf: Number(p?.perf_base || 0),
      review: p?.review_status || "",
    });
  }
  sheet.getRow(1).font = { bold: true };
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { filename: `案例导出-${new Date().toISOString().slice(0, 10)}.xlsx`, buffer };
}

export function xlsxResponse(filename: string, buffer: Buffer) {
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    },
  });
}
