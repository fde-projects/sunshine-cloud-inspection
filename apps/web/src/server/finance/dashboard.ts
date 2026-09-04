import type { AppUser } from "../http";
import { chunkIn, gqlPages } from "./gql";

const moneyNum = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

type DashPo = {
  id: string;
  po_no: string;
  gsp_case_no: string | null;
  service_case_id: string | null;
  po_total_amount: string | number | null;
  demand_date: string | null;
  match_status: string | null;
  project_name: string | null;
  service_case: {
    id: string;
    gsp_case_no: string;
    project_name: string | null;
    site_id: string | null;
    case_performance: { case_revenue?: string | number | null; perf_final?: string | number | null } | null;
  } | null;
};

type DashItem = {
  id: string;
  po_order_id: string;
  item_code: string;
  item_category: string;
  qty: string | number;
  item_revenue: string | number;
  price_status: string;
};

const PO_FIELDS = `
  id po_no gsp_case_no service_case_id po_total_amount demand_date match_status project_name
  service_case {
    id gsp_case_no project_name site_id
    case_performance { case_revenue perf_final }
  }
`;

function monthKey(value: unknown) {
  const match = String(value || "").match(/^(\d{4}-\d{2})/);
  return match ? match[1] : "未知月份";
}

function emptyDashboard() {
  return {
    summary: {
      income: 0,
      poTotalAmount: 0,
      varianceAmount: 0,
      varianceRate: 0,
      poCount: 0,
      caseCount: 0,
      pendingMatch: 0,
      pendingPrice: 0,
      ignoredCount: 0,
      okCount: 0,
      performanceExpense: 0,
      otherCost: 0,
      grossProfit: 0,
    },
    ignoredItems: [] as Array<{ itemCode: string; count: number; qty: number }>,
    trend: [] as Array<{ month: string; income: string }>,
  };
}

function poWhere(user: AppUser, query: URLSearchParams) {
  const and: Record<string, unknown>[] = [];
  if (user.role === "site_manager") {
    if (!user.managedSiteIds.length) return null;
    and.push({ service_case: { site_id: { _in: user.managedSiteIds } } });
  }
  const from = query.get("from") || query.get("dateFrom");
  const to = query.get("to") || query.get("dateTo");
  if (from || to) {
    and.push({
      demand_date: {
        ...(from ? { _gte: from } : {}),
        ...(to ? { _lte: to } : {}),
      },
    });
  }
  if (query.get("project")) and.push({ project_name: { _eq: query.get("project") } });
  if (query.get("province")) and.push({ province: { _eq: query.get("province") } });
  if (query.get("demandType")) and.push({ demand_type: { _eq: query.get("demandType") } });
  if (!and.length) return {};
  return { _and: and };
}

async function loadDashRows(user: AppUser, query: URLSearchParams) {
  const where = poWhere(user, query);
  if (where === null) return { orders: [] as DashPo[], items: [] as DashItem[] };
  const orders = await gqlPages<DashPo>("po_orders", "po_orders_bool_exp", PO_FIELDS, where, "{ created_at: desc }");
  const items = await chunkIn(orders.map((o) => o.id), (slice) =>
    gqlPages<DashItem>(
      "po_items",
      "po_items_bool_exp",
      "id po_order_id item_code item_category qty item_revenue price_status",
      { po_order_id: { _in: slice } },
    ),
  );
  return { orders, items };
}

export async function getFinanceDashboard(user: AppUser, query: URLSearchParams) {
  if (user.role === "site_manager" && !user.managedSiteIds.length) return emptyDashboard();

  const { orders, items } = await loadDashRows(user, query);
  const itemsByPo = new Map<string, DashItem[]>();
  for (const it of items) {
    const list = itemsByPo.get(it.po_order_id) || [];
    list.push(it);
    itemsByPo.set(it.po_order_id, list);
  }

  const caseItemRev = new Map<string, number>();
  const casePerf = new Map<string, number>();
  const monthlyIncome = new Map<string, number>();
  let pendingPrice = 0;
  let ignoredCount = 0;
  let okCount = 0;
  let otherCost = 0;
  const ignoredAgg = new Map<string, { count: number; qty: number }>();

  for (const po of orders) {
    const poItems = itemsByPo.get(po.id) || [];
    let pricedRevenue = 0;
    for (const it of poItems) {
      const revenue = Number(it.item_revenue || 0);
      pricedRevenue += revenue;
      if (it.price_status === "pending_price") pendingPrice += 1;
      else if (it.price_status === "ignored") {
        ignoredCount += 1;
        const cur = ignoredAgg.get(it.item_code) || { count: 0, qty: 0 };
        cur.count += 1;
        cur.qty += Number(it.qty || 0);
        ignoredAgg.set(it.item_code, cur);
      } else if (it.price_status === "ok") okCount += 1;
      if (it.item_category === "general") otherCost += revenue;
    }
    monthlyIncome.set(
      monthKey(po.demand_date),
      (monthlyIncome.get(monthKey(po.demand_date)) || 0) + pricedRevenue,
    );
    const caseId = po.service_case?.id || po.service_case_id;
    if (!caseId) continue;
    caseItemRev.set(caseId, (caseItemRev.get(caseId) || 0) + pricedRevenue);
    casePerf.set(caseId, Number(po.service_case?.case_performance?.perf_final || 0));
  }

  const caseIncome = [...caseItemRev.entries()].map(([, itemSum]) => itemSum);
  const income = moneyNum(caseIncome.reduce((sum, v) => sum + v, 0));
  const poTotalAmount = moneyNum(orders.reduce((sum, po) => sum + Number(po.po_total_amount || 0), 0));
  const performanceExpense = moneyNum([...casePerf.values()].reduce((sum, v) => sum + v, 0));
  const other = moneyNum(otherCost);
  const varianceAmount = moneyNum(poTotalAmount - income);
  const adminOnly =
    user.role === "super_admin"
      ? { performanceExpense, otherCost: other, grossProfit: moneyNum(income - performanceExpense - other) }
      : {};

  return {
    summary: {
      income,
      poTotalAmount,
      varianceAmount,
      varianceRate: poTotalAmount ? Math.abs(income - poTotalAmount) / poTotalAmount : 0,
      poCount: orders.length,
      caseCount: caseItemRev.size,
      pendingMatch: orders.filter((po) => po.match_status === "pending" || !po.service_case_id).length,
      pendingPrice,
      ignoredCount,
      okCount,
      ...adminOnly,
    },
    ignoredItems: [...ignoredAgg.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 50)
      .map(([itemCode, row]) => ({ itemCode, count: row.count, qty: moneyNum(row.qty) })),
    trend: [...monthlyIncome.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, value]) => ({ month, income: moneyNum(value).toFixed(2) })),
  };
}

export async function getFinanceVariance(user: AppUser, query: URLSearchParams) {
  const dash = await getFinanceDashboard(user, query);
  const income = Number(dash.summary.income || 0);
  const poTotalAmount = Number(dash.summary.poTotalAmount || 0);
  const varianceAmount = Number(dash.summary.varianceAmount || 0);
  const varianceRate = Number(dash.summary.varianceRate || 0);

  if (user.role === "site_manager" && !user.managedSiteIds.length) {
    return {
      summary: {
        income: 0,
        poTotalAmount: 0,
        varianceAmount: 0,
        varianceRate: 0,
        pendingPrice: 0,
        ignoredCount: 0,
        okCount: 0,
        unmatchedPoCount: 0,
        unmatchedPoAmount: 0,
        caseGapCount: 0,
        caseGapAmount: 0,
        caseShortAmount: 0,
        caseOverAmount: 0,
      },
      buckets: [],
      cases: [],
      unmatchedPos: [],
      ignoredItems: [],
    };
  }

  const { orders, items } = await loadDashRows(user, query);
  const itemsByPo = new Map<string, DashItem[]>();
  for (const it of items) {
    const list = itemsByPo.get(it.po_order_id) || [];
    list.push(it);
    itemsByPo.set(it.po_order_id, list);
  }

  const unmatchedPos = orders
    .filter((po) => !po.service_case_id || po.match_status === "pending")
    .map((po) => ({
      id: po.id,
      poNo: po.po_no,
      gspCaseNo: po.gsp_case_no || po.service_case?.gsp_case_no || "",
      projectName: po.project_name || po.service_case?.project_name || "-",
      poTotalAmount: Number(po.po_total_amount || 0),
      matchStatus: po.match_status || "pending",
    }))
    .sort((a, b) => b.poTotalAmount - a.poTotalAmount)
    .slice(0, 100);
  const unmatchedPoAmount = moneyNum(unmatchedPos.reduce((sum, row) => sum + row.poTotalAmount, 0));

  const byCase = new Map<
    string,
    {
      caseId: string;
      gspCaseNo: string;
      projectName: string;
      poTotalAmount: number;
      caseRevenue: number;
      pendingPrice: number;
      ignoredCount: number;
      okCount: number;
    }
  >();
  for (const po of orders) {
    const caseId = po.service_case?.id || po.service_case_id;
    if (!caseId || po.match_status === "pending") continue;
    const cur = byCase.get(caseId) || {
      caseId,
      gspCaseNo: po.service_case?.gsp_case_no || po.gsp_case_no || "",
      projectName: po.service_case?.project_name || po.project_name || "-",
      poTotalAmount: 0,
      caseRevenue: 0,
      pendingPrice: 0,
      ignoredCount: 0,
      okCount: 0,
    };
    cur.poTotalAmount = moneyNum(cur.poTotalAmount + Number(po.po_total_amount || 0));
    let priced = 0;
    for (const it of itemsByPo.get(po.id) || []) {
      priced += Number(it.item_revenue || 0);
      if (it.price_status === "pending_price") cur.pendingPrice += 1;
      else if (it.price_status === "ignored") cur.ignoredCount += 1;
      else if (it.price_status === "ok") cur.okCount += 1;
    }
    cur.caseRevenue = moneyNum(cur.caseRevenue + priced);
    byCase.set(caseId, cur);
  }

  const cases = [...byCase.values()]
    .map((row) => {
      const gap = moneyNum(row.poTotalAmount - row.caseRevenue);
      return {
        ...row,
        gap,
        reason:
          row.pendingPrice > 0
            ? "存在待定价条目"
            : gap > 0.009
              ? "核算低于 PO 总额"
              : gap < -0.009
                ? "核算高于 PO 总额"
                : "无显著偏差",
      };
    })
    .filter((row) => Math.abs(row.gap) > 0.009 || row.pendingPrice > 0)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 100);

  const caseShortAmount = moneyNum(cases.reduce((sum, row) => sum + Math.max(0, row.gap), 0));
  const caseOverAmount = moneyNum(cases.reduce((sum, row) => sum + Math.min(0, row.gap), 0));
  const caseGapAmount = moneyNum(caseShortAmount + caseOverAmount);

  return {
    summary: {
      income,
      poTotalAmount,
      varianceAmount,
      varianceRate,
      pendingPrice: Number(dash.summary.pendingPrice || 0),
      ignoredCount: Number(dash.summary.ignoredCount || 0),
      okCount: Number(dash.summary.okCount || 0),
      unmatchedPoCount: unmatchedPos.length,
      unmatchedPoAmount,
      caseGapCount: cases.filter((row) => Math.abs(row.gap) > 0.009).length,
      caseGapAmount,
      caseShortAmount,
      caseOverAmount,
    },
    buckets: [
      {
        key: "unmatched",
        label: "未匹配案例的 PO",
        amount: unmatchedPoAmount,
        count: unmatchedPos.length,
        tip: "PO 已计入总额，但尚未挂到案例，核算收入为 0",
      },
      {
        key: "case_short",
        label: "核算低于 PO",
        amount: caseShortAmount,
        count: cases.filter((row) => row.gap > 0.009).length,
        tip: "已匹配案例的条目收入合计少于 PO 头金额",
      },
      {
        key: "case_over",
        label: "核算高于 PO",
        amount: caseOverAmount,
        count: cases.filter((row) => row.gap < -0.009).length,
        tip: "已匹配案例的条目收入合计多于 PO 头金额，是总差额的主要来源时请先核这些单",
      },
      {
        key: "pending_price",
        label: "待定价条目（条数）",
        amount: 0,
        count: Number(dash.summary.pendingPrice || 0),
        tip: "待定价不会进入核算收入，请到价格库批量映射",
      },
      {
        key: "ignored",
        label: "忽略条目（条数）",
        amount: 0,
        count: Number(dash.summary.ignoredCount || 0),
        tip: "名称如「无」「自定义」等不计入核算；没有钱缺口时不列入下方案例",
      },
    ],
    cases,
    unmatchedPos,
    ignoredItems: dash.ignoredItems || [],
  };
}
