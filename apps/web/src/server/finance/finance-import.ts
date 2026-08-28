import { adminGql } from "@/lib/hasura-admin";
import { HttpError } from "../http";
import { applyDemandTypeForCases } from "./demand-type-match";
import { ExcelParserService, type ParsedPoOrder } from "./excel-parser";
import { gqlPages } from "./gql";
import { isIgnoredItem, modelMatches, pickMappedPrice } from "./item-matcher";
import { loadActiveMappings, loadActivePrices, recalculate, recalculateLedgers } from "./price-mapping";
import { mapPrice, money, PRICE_GQL_FIELDS, type FailRow, type ImportDupPlan, type MappingLike, type PriceLike, type UploadFile } from "./types";
import { decodeUploadFilename, resolveUploadFilename } from "./upload-filename";

const parser = new ExcelParserService();
const PO_CHUNK = 40;
const PRICE_CHUNK = 200;
const PARSE_CACHE_TTL_MS = 15 * 60 * 1000;
const PLAN_SAMPLE = 200;

type ParseCacheEntry = { expires: number; data: unknown };
const parseCache = new Map<string, ParseCacheEntry>();

type BatchRow = {
  id: string;
  import_type: string;
  file_name: string;
  total_rows: number;
  success_rows: number;
  fail_rows: number;
  fail_detail: FailRow[];
};

function fileName(file: UploadFile, clientFilename?: string | null) {
  file.originalname = resolveUploadFilename(file, clientFilename) || file.originalname;
  return file.originalname;
}

function assertExcel(file?: UploadFile) {
  if (!file?.buffer?.length) throw new HttpError(400, "请选择Excel文件");
  const name = decodeUploadFilename(file.originalname);
  if (!name.toLowerCase().endsWith(".xlsx")) throw new HttpError(400, "仅支持.xlsx文件");
}

function fileCacheKey(kind: string, file: UploadFile) {
  return `${kind}|${file.originalname}|${file.size}|${file.buffer.length}`;
}

function getCached<T>(key: string): T | null {
  const hit = parseCache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    parseCache.delete(key);
    return null;
  }
  return hit.data as T;
}

function setCached(key: string, data: unknown) {
  if (parseCache.size >= 24) {
    const oldest = parseCache.keys().next().value;
    if (oldest) parseCache.delete(oldest);
  }
  parseCache.set(key, { expires: Date.now() + PARSE_CACHE_TTL_MS, data });
}

function settlePriceKey(itemCode: string, productModel: string | null, scene: string | null) {
  return `${itemCode}|${productModel || ""}|${scene || ""}`;
}

function perfPriceKey(
  itemCode: string,
  productModel: string | null,
  scene: string | null,
  region: string | null,
  coopType: string | null,
  effectiveDate: string,
) {
  return `${itemCode}|${productModel || ""}|${scene || ""}|${region || ""}|${coopType || ""}|${effectiveDate}`;
}

function planByKeys(keys: string[], existing: Set<string>, frozen?: Set<string>): ImportDupPlan {
  const counts = new Map<string, number>();
  for (const key of keys) {
    const k = String(key || "").trim();
    if (!k) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const unique = [...counts.keys()];
  const frozenSet = frozen || new Set<string>();
  const fileDupKeys = unique.filter((k) => (counts.get(k) || 0) > 1);
  const frozenKeys = unique.filter((k) => existing.has(k) && frozenSet.has(k));
  const updateKeys = unique.filter((k) => existing.has(k));
  const createKeys = unique.filter((k) => !existing.has(k));
  const sample = (arr: string[]) => arr.slice(0, PLAN_SAMPLE);
  return {
    createCount: createKeys.length,
    updateCount: updateKeys.length,
    fileDupCount: fileDupKeys.reduce((n, k) => n + Math.max((counts.get(k) || 1) - 1, 0), 0),
    frozenSkipCount: frozenKeys.length,
    createSamples: sample(createKeys),
    updateSamples: sample(updateKeys),
    fileDupSamples: sample(fileDupKeys.map((k) => `${k}（${counts.get(k)}次）`)),
    frozenSkipSamples: sample(frozenKeys),
  };
}

async function createBatch(type: string, fileNameValue: string, totalRows: number, operatorId: string) {
  const d = await adminGql<{ insert_import_batches_one: BatchRow }>(
    `mutation ($obj: import_batches_insert_input!) {
      insert_import_batches_one(object: $obj) {
        id import_type file_name total_rows success_rows fail_rows fail_detail
      }
    }`,
    {
      obj: {
        import_type: type,
        file_name: fileNameValue,
        total_rows: totalRows,
        success_rows: 0,
        fail_rows: 0,
        fail_detail: [],
        operator_id: operatorId,
      },
    },
  );
  return d.insert_import_batches_one;
}

async function resolveBatch(
  batchId: string | undefined,
  type: string,
  fileNameValue: string,
  totalRows: number,
  operatorId: string,
) {
  if (batchId) {
    const d = await adminGql<{ import_batches_by_pk: BatchRow | null }>(
      `query ($id: uuid!) {
        import_batches_by_pk(id: $id) { id import_type file_name total_rows success_rows fail_rows fail_detail }
      }`,
      { id: batchId },
    );
    if (!d.import_batches_by_pk) throw new HttpError(404, "导入批次不存在");
    return d.import_batches_by_pk;
  }
  return createBatch(type, fileNameValue, totalRows, operatorId);
}

async function finishBatch(batch: BatchRow, success: number, failures: FailRow[]) {
  await adminGql(
    `mutation ($id: uuid!, $set: import_batches_set_input!) {
      update_import_batches_by_pk(pk_columns: { id: $id }, _set: $set) { id }
    }`,
    {
      id: batch.id,
      set: { success_rows: success, fail_rows: failures.length, fail_detail: failures },
    },
  );
  batch.success_rows = success;
  batch.fail_rows = failures.length;
  batch.fail_detail = failures;
}

async function findCasesByGsp(gspNos: string[]) {
  const unique = [...new Set(gspNos.filter(Boolean))];
  if (!unique.length) return [];
  const rows: Array<{
    id: string;
    gsp_case_no: string;
    project_name: string;
    service_type: string | null;
    product_line: string | null;
    region: string | null;
    status: string;
    version: number;
    inspector_id: string | null;
    task_template_id: string | null;
  }> = [];
  for (let i = 0; i < unique.length; i += 200) {
    const slice = unique.slice(i, i + 200);
    const d = await adminGql<{ service_cases: typeof rows }>(
      `query ($nos: [String!]!) {
        service_cases(where: { gsp_case_no: { _in: $nos } }) {
          id gsp_case_no project_name service_type product_line region status version inspector_id task_template_id
        }
      }`,
      { nos: slice },
    );
    rows.push(...d.service_cases);
  }
  return rows;
}

async function findOrdersByPo(poNos: string[]) {
  const unique = [...new Set(poNos.filter(Boolean))];
  if (!unique.length) return [];
  const rows: Array<{ id: string; po_no: string; service_case_id: string | null }> = [];
  for (let i = 0; i < unique.length; i += 200) {
    const d = await adminGql<{ po_orders: typeof rows }>(
      `query ($nos: [String!]!) {
        po_orders(where: { po_no: { _in: $nos } }) { id po_no service_case_id }
      }`,
      { nos: unique.slice(i, i + 200) },
    );
    rows.push(...d.po_orders);
  }
  return rows;
}

async function findFrozenPoNos(poNos: string[]) {
  const existing = await findOrdersByPo(poNos);
  const caseIds = [...new Set(existing.map((r) => r.service_case_id).filter((id): id is string => !!id))];
  if (!caseIds.length) return new Set<string>();
  const [cases, ledgers] = await Promise.all([
    adminGql<{ service_cases: { id: string; status: string }[] }>(
      `query ($ids: [uuid!]!) { service_cases(where: { id: { _in: $ids } }) { id status } }`,
      { ids: caseIds },
    ),
    adminGql<{ case_performances: { service_case_id: string; review_status: string }[] }>(
      `query ($ids: [uuid!]!) { case_performances(where: { service_case_id: { _in: $ids } }) { service_case_id review_status } }`,
      { ids: caseIds },
    ),
  ]);
  const statusByCase = new Map(cases.service_cases.map((r) => [r.id, r.status]));
  const reviewByCase = new Map(ledgers.case_performances.map((r) => [r.service_case_id, r.review_status]));
  const frozen = new Set<string>();
  for (const order of existing) {
    if (!order.service_case_id) continue;
    const status = statusByCase.get(order.service_case_id);
    const review = reviewByCase.get(order.service_case_id);
    if (status === "settled" || status === "month_locked" || review === "approved") frozen.add(order.po_no);
  }
  return frozen;
}

function pickPrice(
  prices: PriceLike[],
  type: "settle" | "perf",
  code: string,
  scene: string | null,
  model: string | null,
  region: string | null,
  coop: string | null,
) {
  return prices
    .filter(
      (p) =>
        p.priceType === type &&
        p.itemCode === code &&
        (!p.productModel || modelMatches(p.productModel, model)) &&
        (!p.scene || p.scene === scene) &&
        (!p.region || p.region === region) &&
        (!p.coopType || p.coopType === coop),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.scene)) - Number(Boolean(a.scene)) ||
        Number(Boolean(b.productModel)) - Number(Boolean(a.productModel)) ||
        Number(Boolean(b.region)) - Number(Boolean(a.region)) ||
        String(b.effectiveDate).localeCompare(String(a.effectiveDate)),
    )[0];
}

export async function downloadTemplate(kind: string) {
  const allowed = ["gsp", "po", "settle-price", "perf-price"] as const;
  if (!allowed.includes(kind as (typeof allowed)[number])) {
    throw new HttpError(400, "模板类型无效，可选：gsp / po / settle-price / perf-price");
  }
  return parser.buildImportTemplate(kind as (typeof allowed)[number]);
}

export async function importGsp(
  file: UploadFile,
  userId: string,
  preview = false,
  opts?: { clientFilename?: string | null },
) {
  fileName(file, opts?.clientFilename);
  assertExcel(file);
  const parsed = await parser.parseGspCases(file.buffer);
  if (preview) {
    const gspNos = parsed.cases.map((x) => x.gspCaseNo);
    const existing = await findCasesByGsp(gspNos);
    return {
      preview: parsed.cases.slice(0, 20),
      totalRows: parsed.cases.length,
      failures: parsed.failures,
      dupPlan: planByKeys(gspNos, new Set(existing.map((r) => r.gsp_case_no))),
    };
  }
  const batch = await createBatch("gsp_case", file.originalname, parsed.cases.length + parsed.failures.length, userId);
  const existing = await findCasesByGsp(parsed.cases.map((x) => x.gspCaseNo));
  const caseMap = new Map(existing.map((r) => [r.gsp_case_no, r]));
  let success = 0;
  const failures = [...parsed.failures];
  const savedCases: Array<{
    id: string;
    gspCaseNo: string;
    serviceType: string | null;
    productLine: string | null;
    taskTemplateId: string | null;
  }> = [];

  for (const item of parsed.cases) {
    try {
      const old = caseMap.get(item.gspCaseNo);
      const obj = {
        gsp_case_no: item.gspCaseNo,
        project_name: item.projectName || item.gspCaseNo,
        service_type: item.serviceType,
        product_line: item.productLine,
        creator: item.creator,
        province: item.province,
        city: item.city,
        site_desc: item.siteDesc,
        region: item.region,
        import_batch_id: batch.id,
        version: (old?.version || 0) + 1,
      };
      if (old) {
        await adminGql(
          `mutation ($id: uuid!, $set: service_cases_set_input!) {
            update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
          }`,
          { id: old.id, set: obj },
        );
        savedCases.push({
          id: old.id,
          gspCaseNo: item.gspCaseNo,
          serviceType: item.serviceType,
          productLine: item.productLine,
          taskTemplateId: old.task_template_id,
        });
      } else {
        const d = await adminGql<{ insert_service_cases_one: { id: string } }>(
          `mutation ($obj: service_cases_insert_input!) { insert_service_cases_one(object: $obj) { id } }`,
          { obj: { ...obj, status: "pending_assign" } },
        );
        savedCases.push({
          id: d.insert_service_cases_one.id,
          gspCaseNo: item.gspCaseNo,
          serviceType: item.serviceType,
          productLine: item.productLine,
          taskTemplateId: null,
        });
      }
      success += 1;
    } catch (error) {
      failures.push({ row: item.sourceRow, reason: error instanceof Error ? error.message : "导入失败" });
    }
  }

  const matchResult = await applyDemandTypeForCases(savedCases);
  const rowByGsp = new Map(parsed.cases.map((c) => [c.gspCaseNo, c.sourceRow]));
  const matchWarnings = matchResult.warnings.map((w) => ({
    row: w.gspCaseNo ? rowByGsp.get(w.gspCaseNo) : undefined,
    gspCaseNo: w.gspCaseNo,
    code: w.code,
    message: w.message,
  }));
  await finishBatch(batch, success, failures);
  return {
    batchId: batch.id,
    totalRows: parsed.cases.length + parsed.failures.length,
    successRows: success,
    failRows: failures.length,
    matchedTypes: matchResult.matched,
    matchWarnings,
    warnings: [
      ...parsed.cases.filter((x) => x.warning).map((x) => ({ row: x.sourceRow, warning: x.warning })),
      ...matchWarnings.map((w) => ({ row: w.row, warning: w.message })),
    ],
  };
}

async function savePoChunk(
  chunk: ParsedPoOrder[],
  batchId: string,
  prices: PriceLike[],
  mappings: MappingLike[],
  frozenPoNos: Set<string>,
) {
  const gspNos = [...new Set(chunk.map((row) => row.gspCaseNo))];
  const poNos = chunk.map((row) => row.poNo);
  const existingCases = await findCasesByGsp(gspNos);
  const existingOrders = await findOrdersByPo(poNos);
  const caseMap = new Map(existingCases.map((r) => [r.gsp_case_no, r]));
  const orderMap = new Map(existingOrders.map((r) => [r.po_no, r]));

  let success = 0;
  let skippedFrozen = 0;
  const failures: FailRow[] = [];
  const overwriteIds: string[] = [];
  const ordersToUpsert: Array<{ poNo: string; obj: Record<string, unknown> }> = [];
  const itemsByPoNo = new Map<string, Record<string, unknown>[]>();
  const touchedCaseIds = new Set<string>();

  for (const parsed of chunk) {
    try {
      if (frozenPoNos.has(parsed.poNo)) {
        skippedFrozen += 1;
        continue;
      }
      const region = parsed.province?.includes("云南") ? "yunnan" : "south_china";
      const serviceCase = caseMap.get(parsed.gspCaseNo) || null;
      const existing = orderMap.get(parsed.poNo);
      if (existing?.id) overwriteIds.push(existing.id);
      ordersToUpsert.push({
        poNo: parsed.poNo,
        obj: {
          po_no: parsed.poNo,
          gsp_case_no: parsed.gspCaseNo,
          po_total_amount: money(parsed.poTotalAmount),
          demand_date: parsed.demandDate,
          demander: parsed.demander,
          demand_type: parsed.demandType,
          product_line: parsed.productLine,
          product_model: parsed.productModel,
          product_qty: parsed.productQty === null ? null : money(parsed.productQty),
          fault_phenomenon: parsed.faultPhenomenon,
          fault_level: parsed.faultLevel,
          duration_req: parsed.durationReq,
          demand_desc: parsed.demandDesc,
          project_area: parsed.projectArea,
          project_country: parsed.projectCountry,
          project_region: parsed.projectRegion,
          province: parsed.province,
          project_name: parsed.projectName,
          project_scene: parsed.projectScene,
          submitter: parsed.submitter,
          dingtalk_created_at: parsed.dingtalkCreatedAt ? parsed.dingtalkCreatedAt.toISOString() : null,
          dingtalk_updated_at: parsed.dingtalkUpdatedAt ? parsed.dingtalkUpdatedAt.toISOString() : null,
          service_case_id: serviceCase?.id || null,
          match_status: serviceCase ? "matched" : "pending",
          import_batch_id: batchId,
        },
      });
      if (serviceCase) {
        const set: Record<string, unknown> = {};
        if (serviceCase.status === "finished") set.status = "settle_review";
        if (parsed.projectName && (!serviceCase.project_name || serviceCase.project_name.startsWith("待补全-"))) {
          set.project_name = parsed.projectName;
        }
        if (parsed.productLine && !serviceCase.product_line) {
          set.product_line = String(parsed.productLine).trim().slice(0, 64);
        }
        if (parsed.demandType && !serviceCase.service_type) {
          set.service_type = String(parsed.demandType).trim().slice(0, 32);
        }
        if (Object.keys(set).length) {
          await adminGql(
            `mutation ($id: uuid!, $set: service_cases_set_input!) {
              update_service_cases_by_pk(pk_columns: { id: $id }, _set: $set) { id }
            }`,
            { id: serviceCase.id, set },
          );
        }
        touchedCaseIds.add(serviceCase.id);
      } else {
        failures.push({
          row: parsed.items[0]?.sourceRow || 0,
          reason: `${parsed.poNo}: 未找到 GSP 案例 ${parsed.gspCaseNo}，已存为待匹配（请先导入 GSP 或人工挂接）`,
        });
      }
      const caseRegion = serviceCase?.region || region;
      const contextItemNames = parsed.items
        .filter((entry) => entry.itemCategory === "special" && !isIgnoredItem(entry.itemCode))
        .map((entry) => entry.itemCode);
      itemsByPoNo.set(
        parsed.poNo,
        parsed.items.map((item) => {
          const ignored = isIgnoredItem(item.itemCode);
          const settleMatch = pickMappedPrice(
            prices,
            item.itemCode,
            parsed.projectScene,
            parsed.productModel,
            mappings,
            contextItemNames,
            parsed.demandType,
          );
          const settle = settleMatch?.price;
          const perfCodes = [...new Set([settle?.itemCode, item.itemCode].filter(Boolean))] as string[];
          const perf =
            perfCodes
              .map((code) =>
                pickPrice(prices, "perf", code, parsed.projectScene, parsed.productModel, caseRegion, "self"),
              )
              .find(Boolean) || null;
          return {
            source_row: item.sourceRow,
            item_category: item.itemCategory,
            item_code: item.itemCode,
            item_name: item.itemName,
            item_desc: item.itemDesc,
            unit: item.unit,
            qty: money(item.qty),
            settle_price: settle?.unitPrice || null,
            perf_price: perf?.unitPrice || null,
            item_revenue: money(item.qty * Number(settle?.unitPrice || 0)),
            item_perf: money(item.qty * Number(perf?.unitPrice || 0)),
            price_status: ignored ? "ignored" : settle ? "ok" : "pending_price",
          };
        }),
      );
      success += 1;
    } catch (error) {
      failures.push({
        row: parsed.items[0]?.sourceRow || 0,
        reason: `${parsed.poNo}: ${error instanceof Error ? error.message : "导入失败"}`,
      });
    }
  }

  if (overwriteIds.length) {
    await adminGql(
      `mutation ($ids: [uuid!]!) { delete_po_items(where: { po_order_id: { _in: $ids } }) { affected_rows } }`,
      { ids: overwriteIds },
    );
  }

  const idByPo = new Map(existingOrders.map((r) => [r.po_no, r.id]));
  for (const row of ordersToUpsert) {
    const existingId = idByPo.get(row.poNo);
    if (existingId) {
      await adminGql(
        `mutation ($id: uuid!, $set: po_orders_set_input!) {
          update_po_orders_by_pk(pk_columns: { id: $id }, _set: $set) { id }
        }`,
        { id: existingId, set: row.obj },
      );
    } else {
      const d = await adminGql<{ insert_po_orders_one: { id: string } }>(
        `mutation ($obj: po_orders_insert_input!) { insert_po_orders_one(object: $obj) { id } }`,
        { obj: row.obj },
      );
      idByPo.set(row.poNo, d.insert_po_orders_one.id);
    }
  }

  const allItems: Record<string, unknown>[] = [];
  for (const row of ordersToUpsert) {
    const poId = idByPo.get(row.poNo);
    if (!poId) continue;
    for (const item of itemsByPoNo.get(row.poNo) || []) {
      allItems.push({ ...item, po_order_id: poId });
    }
  }
  for (let i = 0; i < allItems.length; i += PRICE_CHUNK) {
    await adminGql(
      `mutation ($objects: [po_items_insert_input!]!) { insert_po_items(objects: $objects) { affected_rows } }`,
      { objects: allItems.slice(i, i + PRICE_CHUNK) },
    );
  }
  if (touchedCaseIds.size) {
    await recalculateLedgers([...touchedCaseIds]);
  }
  return { success, generatedCases: 0, skippedFrozen, failures };
}

export async function importPo(
  file: UploadFile,
  userId: string,
  preview = false,
  options: { offset?: number; limit?: number; batchId?: string; clientFilename?: string | null } = {},
) {
  fileName(file, options.clientFilename);
  assertExcel(file);
  const cacheKey = fileCacheKey("po", file);
  let parsed = preview
    ? null
    : getCached<{
        orders: ParsedPoOrder[];
        sourceItemRows: number;
        normalizedItemCount: number;
        failures: FailRow[];
      }>(cacheKey);
  if (!parsed) {
    parsed = await parser.parsePo(file.buffer);
    if (!preview) setCached(cacheKey, parsed);
  }
  if (!parsed) throw new HttpError(400, "PO 文件解析失败");
  const poNos = parsed.orders.map((row) => row.poNo);
  const frozenPoNos = await findFrozenPoNos(poNos);
  if (preview) {
    const existing = await findOrdersByPo(poNos);
    return {
      preview: parsed.orders.slice(0, 20),
      totalOrders: parsed.orders.length,
      sourceItemRows: parsed.sourceItemRows,
      normalizedItemCount: parsed.normalizedItemCount,
      failures: parsed.failures,
      dupPlan: planByKeys(poNos, new Set(existing.map((r) => r.po_no)), frozenPoNos),
    };
  }

  const totalOrders = parsed.orders.length;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? PO_CHUNK;
  const slice = parsed.orders.slice(offset, offset + limit);
  const nextOffset = Math.min(totalOrders, offset + slice.length);
  const done = nextOffset >= totalOrders;
  const batch = await resolveBatch(options.batchId, "po_order", file.originalname, totalOrders, userId);
  const [prices, mappings] = await Promise.all([loadActivePrices(), loadActiveMappings()]);
  const chunk = await savePoChunk(slice, batch.id, prices, mappings, frozenPoNos);
  const prevFailures = Array.isArray(batch.fail_detail) ? batch.fail_detail : [];
  const mergedFailures = [...(offset === 0 ? parsed.failures : prevFailures), ...chunk.failures].slice(-500);
  const totalSuccess = Number(batch.success_rows || 0) + chunk.success;
  await finishBatch(batch, totalSuccess, mergedFailures);
  return {
    batchId: batch.id,
    totalOrders,
    sourceItemRows: parsed.sourceItemRows,
    normalizedItemCount: parsed.normalizedItemCount,
    successRows: totalSuccess,
    failRows: mergedFailures.length,
    failures: chunk.failures,
    skippedFrozen: chunk.skippedFrozen,
    offset,
    nextOffset,
    done,
    chunkSuccess: chunk.success,
  };
}

async function savePriceEntities(
  rows: Array<{ id?: string; obj: Record<string, unknown>; label: string }>,
) {
  let success = 0;
  const failures: FailRow[] = [];
  for (const row of rows) {
    try {
      if (row.id) {
        await adminGql(
          `mutation ($id: uuid!, $set: price_library_set_input!) {
            update_price_library_by_pk(pk_columns: { id: $id }, _set: $set) { id }
          }`,
          { id: row.id, set: row.obj },
        );
      } else {
        await adminGql(
          `mutation ($obj: price_library_insert_input!) { insert_price_library_one(object: $obj) { id } }`,
          { obj: row.obj },
        );
      }
      success += 1;
    } catch (error) {
      failures.push({ row: 0, reason: `${row.label}: ${error instanceof Error ? error.message : "写入失败"}` });
    }
  }
  return { success, failures };
}

export async function importSettlePrices(
  file: UploadFile,
  userId: string,
  preview = false,
  options: { offset?: number; limit?: number; batchId?: string; clientFilename?: string | null } = {},
) {
  fileName(file, options.clientFilename);
  assertExcel(file);
  const cacheKey = fileCacheKey("settle", file);
  type SettleParsed = {
    prices: Array<{
      sourceRow: number;
      itemCode: string;
      itemName: string;
      itemDesc: string | null;
      unit: string | null;
      productModel: string | null;
      scene: string | null;
      workHours: number | null;
      unitPrice: number;
    }>;
    failures: FailRow[];
    flat?: boolean;
  };
  let parsed = preview ? null : getCached<SettleParsed>(cacheKey);
  let flat = false;
  if (!parsed) {
    flat = await parser.isFlatPriceTemplate(file.buffer);
    parsed = flat
      ? await parser.parsePerfPrices(file.buffer).then((result) => ({
          prices: result.prices.map((price) => ({
            sourceRow: price.sourceRow,
            itemCode: price.itemCode,
            itemName: price.itemName,
            itemDesc: price.itemDesc,
            unit: price.unit,
            productModel: price.productModel,
            scene: price.scene,
            workHours: price.workHours,
            unitPrice: price.unitPrice,
          })),
          failures: result.failures,
          flat: true,
        }))
      : { ...(await parser.parseSettlePrices(file.buffer)), flat: false };
    if (!preview) setCached(cacheKey, parsed);
  } else {
    flat = !!parsed.flat;
  }
  if (!parsed) throw new HttpError(400, "价格文件解析失败");
  const effectiveDate = new Date().toISOString().slice(0, 10);
  if (preview) {
    const keys = parsed.prices.map((p) => settlePriceKey(p.itemCode, p.productModel, p.scene));
    const existingRows = await gqlPages<Record<string, unknown>>(
      "price_library",
      "price_library_bool_exp",
      PRICE_GQL_FIELDS,
      { price_type: { _eq: "settle" }, effective_date: { _eq: effectiveDate } },
    );
    const existing = new Set(existingRows.map((r) => settlePriceKey(String(r.item_code), (r.product_model as string) || null, (r.scene as string) || null)));
    return {
      preview: parsed.prices.slice(0, 20),
      totalRows: parsed.prices.length,
      failures: parsed.failures,
      dupPlan: planByKeys(keys, existing),
    };
  }

  const totalRows = parsed.prices.length;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? totalRows;
  const slice = parsed.prices.slice(offset, offset + limit);
  const nextOffset = Math.min(totalRows, offset + slice.length);
  const done = nextOffset >= totalRows;
  const batch = await resolveBatch(options.batchId, "settle_price", file.originalname, totalRows, userId);
  const existingRows = await gqlPages<Record<string, unknown>>(
    "price_library",
    "price_library_bool_exp",
    PRICE_GQL_FIELDS,
    { price_type: { _eq: "settle" }, effective_date: { _eq: effectiveDate } },
  );
  const priceMap = new Map(
    existingRows.map((r) => [
      settlePriceKey(String(r.item_code), (r.product_model as string) || null, (r.scene as string) || null),
      mapPrice(r),
    ]),
  );
  const failures: FailRow[] = offset === 0 ? [...parsed.failures] : [];
  const toSave: Array<{ id?: string; obj: Record<string, unknown>; label: string }> = [];
  for (const price of slice) {
    try {
      const itemCode = String(price.itemCode || "").trim();
      const itemName = String(price.itemName || itemCode).trim();
      if (!itemCode) throw new Error("条目编码为空");
      const key = settlePriceKey(itemCode, price.productModel, price.scene);
      const entity = priceMap.get(key);
      toSave.push({
        id: entity?.id,
        label: itemCode,
        obj: {
          price_type: "settle",
          item_code: itemCode,
          item_name: itemName,
          item_desc: price.itemDesc,
          unit: price.unit ? String(price.unit).slice(0, 32) : null,
          product_model: price.productModel ? String(price.productModel).slice(0, 64) : null,
          scene: price.scene ? String(price.scene).slice(0, 32) : null,
          region: null,
          coop_type: null,
          status: "active",
          effective_date: effectiveDate,
          unit_price: money(price.unitPrice),
          work_hours: price.workHours === null ? null : money(price.workHours),
          created_by_id: userId,
          change_remark: flat
            ? `由${file.originalname}清单模板导入`
            : `由${file.originalname}初始化，已应用0.990应答系数`,
        },
      });
    } catch (error) {
      failures.push({ row: price.sourceRow, reason: error instanceof Error ? error.message : "价格导入失败" });
    }
  }
  const saved = await savePriceEntities(toSave);
  const mergedFailures = [...(offset === 0 ? [] : batch.fail_detail || []), ...failures, ...saved.failures].slice(-500);
  const totalSuccess = Number(batch.success_rows || 0) + saved.success;
  await finishBatch(batch, totalSuccess, mergedFailures);
  let applied = null;
  if (done && totalSuccess > 0) {
    applied = await recalculate().catch(() => null);
  }
  return {
    batchId: batch.id,
    totalRows,
    successRows: totalSuccess,
    failRows: mergedFailures.length,
    offset,
    nextOffset,
    done,
    chunkSuccess: saved.success,
    applied,
  };
}

export async function importPerfPrices(
  file: UploadFile,
  userId: string,
  preview = false,
  options: { offset?: number; limit?: number; batchId?: string; clientFilename?: string | null } = {},
) {
  fileName(file, options.clientFilename);
  assertExcel(file);
  const cacheKey = fileCacheKey("perf", file);
  let parsed = preview ? null : getCached<Awaited<ReturnType<ExcelParserService["parsePerfPrices"]>>>(cacheKey);
  if (!parsed) {
    parsed = await parser.parsePerfPrices(file.buffer);
    if (!preview) setCached(cacheKey, parsed);
  }
  if (!parsed) throw new HttpError(400, "绩效价文件解析失败");
  const fallbackDate = new Date().toISOString().slice(0, 10);
  if (preview) {
    const keys = parsed.prices.map((p) =>
      perfPriceKey(p.itemCode, p.productModel, p.scene, p.region, p.coopType, p.effectiveDate || fallbackDate),
    );
    const existingRows = await gqlPages<Record<string, unknown>>(
      "price_library",
      "price_library_bool_exp",
      PRICE_GQL_FIELDS,
      { price_type: { _eq: "perf" } },
    );
    const existing = new Set(
      existingRows.map((r) =>
        perfPriceKey(
          String(r.item_code),
          (r.product_model as string) || null,
          (r.scene as string) || null,
          (r.region as string) || null,
          (r.coop_type as string) || null,
          String(r.effective_date || ""),
        ),
      ),
    );
    return {
      preview: parsed.prices.slice(0, 20),
      totalRows: parsed.prices.length,
      failures: parsed.failures,
      dupPlan: planByKeys(keys, existing),
    };
  }

  const totalRows = parsed.prices.length;
  const offset = Math.max(0, options.offset ?? 0);
  const limit = options.limit ?? totalRows;
  const slice = parsed.prices.slice(offset, offset + limit);
  const nextOffset = Math.min(totalRows, offset + slice.length);
  const done = nextOffset >= totalRows;
  const batch = await resolveBatch(options.batchId, "perf_price", file.originalname, totalRows, userId);
  const existingRows = await gqlPages<Record<string, unknown>>(
    "price_library",
    "price_library_bool_exp",
    PRICE_GQL_FIELDS,
    { price_type: { _eq: "perf" } },
  );
  const priceMap = new Map(
    existingRows.map((r) => [
      perfPriceKey(
        String(r.item_code),
        (r.product_model as string) || null,
        (r.scene as string) || null,
        (r.region as string) || null,
        (r.coop_type as string) || null,
        String(r.effective_date || ""),
      ),
      mapPrice(r),
    ]),
  );
  const failures: FailRow[] = offset === 0 ? [...parsed.failures] : [];
  const toSave: Array<{ id?: string; obj: Record<string, unknown>; label: string }> = [];
  for (const price of slice) {
    try {
      const itemCode = String(price.itemCode || "").trim();
      const itemName = String(price.itemName || itemCode).trim();
      if (!itemCode) throw new Error("条目编码为空");
      const effectiveDate = price.effectiveDate || fallbackDate;
      const key = perfPriceKey(itemCode, price.productModel, price.scene, price.region, price.coopType, effectiveDate);
      const entity = priceMap.get(key);
      toSave.push({
        id: entity?.id,
        label: itemCode,
        obj: {
          price_type: "perf",
          item_code: itemCode,
          item_name: itemName,
          item_desc: price.itemDesc,
          unit: price.unit ? String(price.unit).slice(0, 32) : null,
          product_model: price.productModel ? String(price.productModel).slice(0, 64) : null,
          scene: price.scene ? String(price.scene).slice(0, 32) : null,
          region: price.region,
          coop_type: price.coopType,
          status: price.status,
          effective_date: effectiveDate,
          unit_price: money(price.unitPrice),
          work_hours: price.workHours === null ? null : money(price.workHours),
          created_by_id: userId,
          change_remark: `由${file.originalname}导入内部绩效价`,
        },
      });
    } catch (error) {
      failures.push({ row: price.sourceRow, reason: error instanceof Error ? error.message : "绩效价导入失败" });
    }
  }
  const saved = await savePriceEntities(toSave);
  const mergedFailures = [...(offset === 0 ? [] : batch.fail_detail || []), ...failures, ...saved.failures].slice(-500);
  const totalSuccess = Number(batch.success_rows || 0) + saved.success;
  await finishBatch(batch, totalSuccess, mergedFailures);
  let refreshedItems = 0;
  if (done && totalSuccess > 0) {
    const applied = await recalculate().catch(() => null);
    refreshedItems = applied?.affectedItems || 0;
  }
  return {
    batchId: batch.id,
    totalRows,
    successRows: totalSuccess,
    failRows: mergedFailures.length,
    offset,
    nextOffset,
    done,
    chunkSuccess: saved.success,
    refreshedItems,
  };
}

export async function fileFromForm(form: FormData | null): Promise<UploadFile> {
  const file = form?.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "请选择Excel文件");
  const buf = Buffer.from(await file.arrayBuffer());
  return { buffer: buf, originalname: file.name, size: file.size };
}
