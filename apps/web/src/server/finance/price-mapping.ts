import { adminGql } from "@/lib/hasura-admin";
import { builtinTargetCode, isIgnoredItem, modelMatches, normalizeItemName, pickMappedPrice } from "./item-matcher";
import { gqlPages } from "./gql";
import { mapPrice, money, monthKeyShanghai, PRICE_GQL_FIELDS, type MappingLike, type PriceLike } from "./types";

const ITEM_FIELDS =
  "id po_order_id source_row item_category item_code item_name item_desc unit qty settle_price perf_price item_revenue item_perf price_status";

type ItemRow = {
  id: string;
  po_order_id: string;
  item_category: string;
  item_code: string;
  item_name: string;
  qty: string | number;
  settle_price: string | number | null;
  perf_price: string | number | null;
  item_revenue: string | number;
  item_perf: string | number;
  price_status: string;
};

type OrderRow = {
  id: string;
  po_no: string;
  gsp_case_no: string;
  service_case_id: string | null;
  project_scene: string | null;
  product_model: string | null;
  demand_type: string | null;
};

type CaseRow = {
  id: string;
  gsp_case_no: string;
  inspector_id: string | null;
  region: string | null;
  status: string;
  finish_time: string | null;
};

function isPriceFrozen(
  serviceCase: CaseRow | null | undefined,
  reviewStatus: string | null | undefined,
  ignoreApprovedFreeze?: boolean,
) {
  if (!serviceCase) return false;
  if (serviceCase.status === "month_locked") return true;
  if (ignoreApprovedFreeze) return false;
  return reviewStatus === "approved";
}

function pickPerfPrice(
  prices: PriceLike[],
  code: string,
  scene: string | null,
  model: string | null,
  region: string | null,
) {
  return prices
    .filter(
      (p) =>
        p.priceType === "perf" &&
        p.status === "active" &&
        p.itemCode === code &&
        (!p.productModel || modelMatches(p.productModel, model)) &&
        (!p.scene || p.scene === scene) &&
        (!p.region || p.region === region) &&
        (!p.coopType || p.coopType === "self"),
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.scene)) - Number(Boolean(a.scene)) ||
        Number(Boolean(b.productModel)) - Number(Boolean(a.productModel)) ||
        Number(Boolean(b.region)) - Number(Boolean(a.region)) ||
        String(b.effectiveDate).localeCompare(String(a.effectiveDate)),
    )[0];
}

export async function loadActivePrices(): Promise<PriceLike[]> {
  const rows = await gqlPages<Record<string, unknown>>(
    "price_library",
    "price_library_bool_exp",
    PRICE_GQL_FIELDS,
    { status: { _eq: "active" } },
    "[{ effective_date: desc }, { id: asc }]",
  );
  return rows.map(mapPrice);
}

export async function loadActiveMappings(): Promise<MappingLike[]> {
  const rows = await gqlPages<{ source_item_name: string; target_item_code: string }>(
    "item_price_mappings",
    "item_price_mappings_bool_exp",
    "source_item_name target_item_code",
    { status: { _eq: "active" } },
  );
  return rows.map((r) => ({ sourceItemName: r.source_item_name, targetItemCode: r.target_item_code }));
}

export async function listPriceMappings() {
  const [items, ignored, mappings, prices] = await Promise.all([
    gqlPages<ItemRow>("po_items", "po_items_bool_exp", ITEM_FIELDS, {
      price_status: { _neq: "ignored" },
    }),
    gqlPages<ItemRow>("po_items", "po_items_bool_exp", ITEM_FIELDS, {
      price_status: { _eq: "ignored" },
    }),
    loadActiveMappings(),
    loadActivePrices(),
  ]);
  const agg = new Map<string, { totalCount: number; pendingCount: number }>();
  for (const it of items) {
    const key = it.item_code;
    const cur = agg.get(key) || { totalCount: 0, pendingCount: 0 };
    cur.totalCount += 1;
    if (it.price_status === "pending_price") cur.pendingCount += 1;
    agg.set(key, cur);
  }
  const ignoredAgg = new Map<string, { totalCount: number; qty: number }>();
  for (const it of ignored) {
    const cur = ignoredAgg.get(it.item_code) || { totalCount: 0, qty: 0 };
    cur.totalCount += 1;
    cur.qty += Number(it.qty || 0);
    ignoredAgg.set(it.item_code, cur);
  }
  const targetCodes = [...new Set(prices.filter((p) => p.priceType === "settle").map((p) => p.itemCode))];
  const list = [...agg.entries()]
    .sort((a, b) => b[1].pendingCount - a[1].pendingCount || a[0].localeCompare(b[0]))
    .map(([sourceItemName, row]) => {
      const saved = mappings.find((m) => m.sourceItemName === sourceItemName);
      const suggestion = saved ? null : builtinTargetCode(sourceItemName, targetCodes);
      return {
        sourceItemName,
        totalCount: row.totalCount,
        pendingCount: row.pendingCount,
        targetItemCode: saved?.targetItemCode || null,
        mappingType: saved ? "manual" : null,
        suggestedTargetCode: suggestion?.targetItemCode || null,
        confidence: saved ? 1 : suggestion?.confidence || null,
      };
    });
  return {
    list,
    ignoredList: [...ignoredAgg.entries()].map(([sourceItemName, row]) => ({
      sourceItemName,
      totalCount: row.totalCount,
      qty: row.qty,
    })),
    targetCodes,
  };
}

export async function savePriceMapping(sourceItemName: string, targetItemCode: string, userId: string) {
  const name = String(sourceItemName || "").trim();
  const code = String(targetItemCode || "").trim();
  if (!name || !code) throw new Error("映射参数不完整");
  const hit = await adminGql<{ price_library: { id: string }[] }>(
    `query ($code: String!) {
      price_library(where: { price_type: { _eq: "settle" }, item_code: { _eq: $code }, status: { _eq: "active" } }, limit: 1) { id }
    }`,
    { code },
  );
  if (!hit.price_library[0]) throw new Error("目标价格条目不存在或未启用");
  const existing = await adminGql<{ item_price_mappings: { id: string }[] }>(
    `query ($name: String!) { item_price_mappings(where: { source_item_name: { _eq: $name } }, limit: 1) { id } }`,
    { name },
  );
  const obj = {
    source_item_name: name,
    normalized_source: normalizeItemName(name),
    target_item_code: code,
    mapping_type: "manual",
    confidence: 1,
    status: "active",
    created_by_id: userId,
  };
  if (existing.item_price_mappings[0]) {
    await adminGql(
      `mutation ($id: uuid!, $set: item_price_mappings_set_input!) {
        update_item_price_mappings_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: existing.item_price_mappings[0].id, set: obj },
    );
  } else {
    await adminGql(
      `mutation ($obj: item_price_mappings_insert_input!) { insert_item_price_mappings_one(object: $obj) { id } }`,
      { obj },
    );
  }
  return recalculate(name);
}

export async function recalculate(sourceItemName?: string) {
  return repriceItems({ sourceItemName });
}

export async function repriceByPoIds(poIds: string[], options?: { ignoreFreeze?: boolean }) {
  const ids = [...new Set(poIds.filter(Boolean))];
  if (!ids.length) {
    return { affectedItems: 0, pricedItems: 0, skippedFrozen: 0, pendingPrice: 0, income: "0.00" };
  }
  return repriceItems({ poIds: ids, ignoreFreeze: options?.ignoreFreeze === true });
}

async function repriceItems(filter: { sourceItemName?: string; poIds?: string[]; ignoreFreeze?: boolean }) {
  const [prices, mappings] = await Promise.all([loadActivePrices(), loadActiveMappings()]);
  const orderWhere = filter.poIds?.length ? { id: { _in: filter.poIds } } : {};
  const orders = await gqlPages<OrderRow>(
    "po_orders",
    "po_orders_bool_exp",
    "id po_no gsp_case_no service_case_id project_scene product_model demand_type",
    orderWhere,
  );
  const caseIds = [...new Set(orders.map((o) => o.service_case_id).filter((id): id is string => !!id))];
  const cases = caseIds.length
    ? await gqlPages<CaseRow>(
        "service_cases",
        "service_cases_bool_exp",
        "id gsp_case_no inspector_id region status finish_time",
        { id: { _in: caseIds } },
      )
    : [];
  const ledgers = caseIds.length
    ? await gqlPages<{ service_case_id: string; review_status: string }>(
        "case_performances",
        "case_performances_bool_exp",
        "service_case_id review_status",
        { service_case_id: { _in: caseIds } },
      )
    : [];
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const caseMap = new Map(cases.map((c) => [c.id, c]));
  const reviewByCase = new Map(ledgers.map((r) => [r.service_case_id, r.review_status]));

  const itemWhere = filter.poIds?.length
    ? { po_order_id: { _in: filter.poIds } }
    : filter.sourceItemName
      ? { item_code: { _eq: filter.sourceItemName } }
      : {};
  const entries = await gqlPages<ItemRow>("po_items", "po_items_bool_exp", ITEM_FIELDS, itemWhere);
  const contextEntries =
    filter.sourceItemName && !filter.poIds?.length
      ? await gqlPages<ItemRow>("po_items", "po_items_bool_exp", ITEM_FIELDS, {})
      : entries;
  const entriesByPo = new Map<string, ItemRow[]>();
  for (const entry of contextEntries) {
    if (!entriesByPo.has(entry.po_order_id)) entriesByPo.set(entry.po_order_id, []);
    entriesByPo.get(entry.po_order_id)!.push(entry);
  }

  const affectedCases = new Set<string>();
  const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
  let priced = 0;
  let skippedFrozen = 0;

  for (const entry of entries) {
    const order = orderMap.get(entry.po_order_id);
    if (!order) continue;
    const serviceCase = order.service_case_id ? caseMap.get(order.service_case_id) : null;
    const reviewStatus = order.service_case_id ? reviewByCase.get(order.service_case_id) : null;
    if (isPriceFrozen(serviceCase, reviewStatus, filter.ignoreFreeze)) {
      skippedFrozen += 1;
      continue;
    }
    if (isIgnoredItem(entry.item_code)) {
      updates.push({
        id: entry.id,
        set: {
          settle_price: null,
          item_revenue: "0.00",
          perf_price: null,
          item_perf: "0.00",
          price_status: "ignored",
        },
      });
      if (order.service_case_id) affectedCases.add(order.service_case_id);
      continue;
    }
    const contextItemNames = (entriesByPo.get(entry.po_order_id) || [])
      .filter((item) => item.item_category === "special" && !isIgnoredItem(item.item_code))
      .map((item) => item.item_code);
    const matched = pickMappedPrice(
      prices,
      entry.item_code,
      order.project_scene,
      order.product_model,
      mappings,
      contextItemNames,
      order.demand_type,
    );
    const settlePrice = matched?.price.unitPrice ?? null;
    const revenue = money(Number(entry.qty) * Number(matched?.price.unitPrice || 0));
    const priceStatus = matched ? "ok" : "pending_price";
    const perfCodes = [
      ...new Set([matched?.price.itemCode, matched?.targetItemCode, entry.item_code].filter(Boolean)),
    ] as string[];
    const perf =
      perfCodes
        .map((code) => pickPerfPrice(prices, code, order.project_scene, order.product_model, serviceCase?.region || null))
        .find(Boolean) || null;
    updates.push({
      id: entry.id,
      set: {
        settle_price: settlePrice,
        item_revenue: revenue,
        price_status: priceStatus,
        perf_price: perf?.unitPrice ?? null,
        item_perf: money(Number(entry.qty) * Number(perf?.unitPrice || 0)),
      },
    });
    if (matched) priced += 1;
    if (order.service_case_id) affectedCases.add(order.service_case_id);
  }

  for (const u of updates) {
    await adminGql(
      `mutation ($id: uuid!, $set: po_items_set_input!) {
        update_po_items_by_pk(pk_columns: { id: $id }, _set: $set) { id }
      }`,
      { id: u.id, set: u.set },
    );
  }
  await recalculateLedgers([...affectedCases], caseMap);

  const totalsWhere = filter.poIds?.length ? { po_order_id: { _in: filter.poIds } } : {};
  const totals = await adminGql<{
    pending: { aggregate: { count: number } };
    income: { aggregate: { sum: { item_revenue: number | null } } };
  }>(
    `query ($where: po_items_bool_exp!) {
      pending: po_items_aggregate(where: { _and: [$where, { price_status: { _eq: "pending_price" } }] }) { aggregate { count } }
      income: po_items_aggregate(where: $where) { aggregate { sum { item_revenue } } }
    }`,
    { where: totalsWhere },
  );

  return {
    affectedItems: updates.length,
    pricedItems: priced,
    skippedFrozen,
    pendingPrice: totals.pending.aggregate.count,
    income: money(Number(totals.income.aggregate.sum.item_revenue || 0)),
  };
}

export async function recalculateLedgers(caseIds: string[], caseMap?: Map<string, CaseRow>) {
  const ids = [...new Set(caseIds.filter(Boolean))];
  if (!ids.length) return;
  let map = caseMap;
  if (!map) {
    const cases = await gqlPages<CaseRow>(
      "service_cases",
      "service_cases_bool_exp",
      "id gsp_case_no inspector_id region status finish_time",
      { id: { _in: ids } },
    );
    map = new Map(cases.map((c) => [c.id, c]));
  }
  const items = await gqlPages<ItemRow & { po_order?: { service_case_id: string | null } }>(
    "po_items",
    "po_items_bool_exp",
    `${ITEM_FIELDS} po_order { service_case_id }`,
    { po_order: { service_case_id: { _in: ids } } },
  );
  const totalMap = new Map<string, { revenue: number; perf: number }>();
  for (const it of items) {
    const cid = it.po_order?.service_case_id;
    if (!cid) continue;
    const cur = totalMap.get(cid) || { revenue: 0, perf: 0 };
    cur.revenue += Number(it.item_revenue || 0);
    cur.perf += Number(it.item_perf || 0);
    totalMap.set(cid, cur);
  }
  const existing = await gqlPages<{
    id: string;
    service_case_id: string;
    deduction: string | number;
    month: string | null;
  }>("case_performances", "case_performances_bool_exp", "id service_case_id deduction month", {
    service_case_id: { _in: ids },
  });
  const ledgerMap = new Map(existing.map((r) => [r.service_case_id, r]));
  for (const caseId of ids) {
    const serviceCase = map.get(caseId);
    if (!serviceCase) continue;
    const total = totalMap.get(caseId);
    const revenue = money(Number(total?.revenue || 0));
    const perfBase = money(Number(total?.perf || 0));
    const ledger = ledgerMap.get(caseId);
    const deduction = Number(ledger?.deduction || 0);
    const month =
      serviceCase.finish_time || !ledger?.month ? monthKeyShanghai(serviceCase.finish_time || new Date()) : ledger.month;
    const set = {
      gsp_case_no: serviceCase.gsp_case_no,
      inspector_id: serviceCase.inspector_id,
      case_revenue: revenue,
      perf_base: perfBase,
      perf_final: money(Number(perfBase) - deduction),
      month,
    };
    if (ledger) {
      await adminGql(
        `mutation ($id: uuid!, $set: case_performances_set_input!) {
          update_case_performances_by_pk(pk_columns: { id: $id }, _set: $set) { id }
        }`,
        { id: ledger.id, set },
      );
    } else {
      await adminGql(
        `mutation ($obj: case_performances_insert_input!) { insert_case_performances_one(object: $obj) { id } }`,
        {
          obj: {
            service_case_id: caseId,
            deduction: "0.00",
            review_status: "pending",
            ...set,
          },
        },
      );
    }
  }

  await syncCasePerfShares(ids);
}

/** 按已完成作业单元重写多人绩效分账；单人案例不写分账行（收入走台账全额） */
export async function syncCasePerfShares(caseIds: string[]) {
  const ids = [...new Set(caseIds.filter(Boolean))];
  for (const caseId of ids) {
    const d = await adminGql<{
      service_cases_by_pk: {
        id: string;
        assign_mode: string | null;
        inspector_id: string | null;
        case_performance: { perf_final: number | string } | null;
        case_assignments: Array<{
          inspector_id: string;
          completed_units: number | null;
          status: string;
        }>;
        case_work_units: Array<{ inspector_id: string | null; status: string }>;
      } | null;
    }>(
      `query ($id: uuid!) {
        service_cases_by_pk(id: $id) {
          id assign_mode inspector_id
          case_performance { perf_final }
          case_assignments(where: { status: { _neq: "withdrawn" } }) {
            inspector_id completed_units status
          }
          case_work_units { inspector_id status }
        }
      }`,
      { id: caseId },
    );
    const sc = d.service_cases_by_pk;
    if (!sc) continue;

    await adminGql(
      `mutation ($cid: uuid!) {
        delete_case_perf_shares(where: { service_case_id: { _eq: $cid } }) { affected_rows }
      }`,
      { cid: caseId },
    );

    const byInspector = new Map<string, number>();
    for (const u of sc.case_work_units || []) {
      if (u.status !== "completed" || !u.inspector_id) continue;
      byInspector.set(u.inspector_id, (byInspector.get(u.inspector_id) || 0) + 1);
    }
    if (!byInspector.size) {
      for (const a of sc.case_assignments || []) {
        const n = Number(a.completed_units || 0);
        if (n > 0) byInspector.set(a.inspector_id, n);
      }
    }

    const multi = sc.assign_mode === "multi" || byInspector.size > 1;
    if (!multi) continue;

    if (!byInspector.size && sc.inspector_id) {
      byInspector.set(sc.inspector_id, 1);
    }
    if (!byInspector.size) continue;

    const perfFinal = Number(sc.case_performance?.perf_final || 0);
    const totalUnits = [...byInspector.values()].reduce((s, n) => s + n, 0);
    if (totalUnits <= 0) continue;

    const entries = [...byInspector.entries()];
    let allocated = 0;
    const objects = entries.map(([inspectorId, units], index) => {
      const ratio = units / totalUnits;
      let amount: number;
      if (index === entries.length - 1) {
        amount = Math.round((perfFinal - allocated) * 100) / 100;
      } else {
        amount = Math.round(perfFinal * ratio * 100) / 100;
        allocated += amount;
      }
      return {
        service_case_id: caseId,
        inspector_id: inspectorId,
        completed_units: units,
        share_ratio: Math.round(ratio * 1_000_000) / 1_000_000,
        perf_amount: money(amount),
      };
    });

    await adminGql(
      `mutation ($objects: [case_perf_shares_insert_input!]!) {
        insert_case_perf_shares(objects: $objects) { affected_rows }
      }`,
      { objects },
    );
  }
}
