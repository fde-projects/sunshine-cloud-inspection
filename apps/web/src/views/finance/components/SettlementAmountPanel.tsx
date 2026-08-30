"use client";

import { useEffect, useState } from "react";
import { Empty, Spin, Table, Tag, Tooltip, Typography } from "antd";
import { Link } from "react-router-dom";
import { fetchReviewAmountBreakdown } from "../../../api/finance";
import type { ReviewAmountBreakdown } from "../../../types/finance";

const money = (v: string | number | null | undefined) => `¥${Number(v || 0).toFixed(2)}`;

export type PriceRow = {
  itemCode?: string;
  itemName?: string;
  unit?: string | null;
  itemDesc?: string | null;
};

export function priceCreatePath(type: "settle" | "perf", row: PriceRow) {
  const params = new URLSearchParams({
    type,
    add: "1",
    itemCode: row.itemCode || "",
    itemName: row.itemName || row.itemCode || "",
  });
  if (row.unit) params.set("unit", row.unit);
  if (row.itemDesc) params.set("itemDesc", row.itemDesc);
  return `/finance/prices?${params.toString()}`;
}

export function MissingPriceLink({
  type,
  row,
  onNavigate,
}: {
  type: "settle" | "perf";
  row: PriceRow;
  onNavigate?: () => void;
}) {
  return (
    <Tooltip title={type === "settle" ? "去价格库补甲方结算价" : "去价格库补内部绩效价"}>
      <Link
        to={priceCreatePath(type, row)}
        className="finance-missing-price-link"
        onClick={onNavigate}
      >
        <span style={{ color: "#b54708" }}>未配</span>
      </Link>
    </Tooltip>
  );
}

const expenseStatusTag = (status?: string) => {
  if (status === "approved") return <Tag color="green">已通过</Tag>;
  if (status === "rejected") return <Tag color="red">已驳回</Tag>;
  if (status === "submitted") return <Tag color="gold">待审核</Tag>;
  if (status === "draft") return <Tag>草稿/无行程</Tag>;
  return <Tag>{status || "-"}</Tag>;
};

type BreakdownItem = ReviewAmountBreakdown["items"][number];

type PanelProps = {
  data: ReviewAmountBreakdown;
  showPerf?: boolean;
  compactTip?: boolean;
  onNavigate?: () => void;
};

export function SettlementAmountPanel({
  data,
  showPerf = true,
  compactTip = false,
  onNavigate,
}: PanelProps) {
  const income = data.items.length ? data.caseRevenue : 0;
  const perf = data.items.length ? data.perfBase : 0;
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {compactTip
          ? "结算价决定案例收入，绩效价决定计件；同一行可以一边已配、一边未配。缺哪边点哪边的「未配」。"
          : "三套账不是同一价格：案例收入 = 数量 × 甲方结算价；计件绩效用内部绩效价；事件扣罚单独登记。缺价处点「未配」去价格库补。"}
      </Typography.Paragraph>

      {!data.items.length ? (
        <Empty
          style={{ margin: "12px 0 24px" }}
          description="尚未挂接 PO，没有可乘的核算条目，案例收入与计件绩效均为 ¥0。"
        />
      ) : null}

      <div className="settle-amount-summary">
        {compactTip ? null : (
          <div>
            <span>案例收入</span>
            <strong>{money(income)}</strong>
            <em>Σ 数量 × 结算单价</em>
          </div>
        )}
        {showPerf ? (
          <div>
            <span>计件绩效</span>
            <strong>{money(perf)}</strong>
            <em>Σ 数量 × 绩效单价</em>
          </div>
        ) : null}
        <div>
          <span>事件扣罚</span>
          <strong className="is-neg">{money(data.eventPenalty)}</strong>
          <em>本案例已登记合计</em>
        </div>
      </div>

      {showPerf && Number(data.deduction) > 0 && (
        <Typography.Paragraph type="warning" style={{ marginBottom: 16 }}>
          另有审核扣减 {money(data.deduction)}，计件实得约 {money(data.perfFinal)}
        </Typography.Paragraph>
      )}

      {data.items.length ? (
      <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        条目对照
      </Typography.Title>
      <Table
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={data.items}
        locale={{ emptyText: "无计费条目" }}
        scroll={{ x: showPerf ? 720 : 520 }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={2}>
              合计
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} />
            <Table.Summary.Cell index={3} align="right">
              <strong>{money(income)}</strong>
            </Table.Summary.Cell>
            {showPerf ? (
              <>
                <Table.Summary.Cell index={4} />
                <Table.Summary.Cell index={5} align="right">
                  <strong>{money(perf)}</strong>
                </Table.Summary.Cell>
              </>
            ) : null}
          </Table.Summary.Row>
        )}
        columns={[
          {
            title: "条目",
            dataIndex: "itemName",
            ellipsis: true,
            render: (v: string, row: BreakdownItem) => (
              <Tooltip title={row.itemCode}>
                <span>{v || row.itemCode}</span>
              </Tooltip>
            ),
          },
          {
            title: "数量",
            dataIndex: "qty",
            width: 88,
            render: (v: string, row: BreakdownItem) =>
              `${Number(v).toFixed(2)}${row.unit ? ` ${row.unit}` : ""}`,
          },
          {
            title: "结算单价",
            dataIndex: "settlePrice",
            width: 100,
            align: "right" as const,
            render: (v: string | null, row: BreakdownItem) =>
              v == null || v === "" ? (
                <MissingPriceLink type="settle" row={row} onNavigate={onNavigate} />
              ) : (
                money(v)
              ),
          },
          {
            title: "收入",
            dataIndex: "itemRevenue",
            width: 100,
            align: "right" as const,
            render: (v: string) => money(v),
          },
          ...(showPerf
            ? [
                {
                  title: "绩效单价",
                  dataIndex: "perfPrice",
                  width: 100,
                  align: "right" as const,
                  render: (v: string | null, row: BreakdownItem) =>
                    v == null ? (
                      <MissingPriceLink type="perf" row={row} onNavigate={onNavigate} />
                    ) : (
                      money(v)
                    ),
                },
                {
                  title: "绩效",
                  dataIndex: "itemPerf",
                  width: 100,
                  align: "right" as const,
                  render: (v: string) => money(v),
                },
              ]
            : []),
        ]}
      />
      </>
      ) : null}

      {showPerf ? (
        <>
          <Typography.Title level={5} style={{ marginTop: 24 }}>
            事件扣罚
          </Typography.Title>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={data.events}
            locale={{ emptyText: "本案例暂无事件扣罚" }}
            columns={[
              {
                title: "内容",
                dataIndex: "content",
                ellipsis: true,
                render: (v: string, row: ReviewAmountBreakdown["events"][number]) => (
                  <span>
                    {v}
                    {row.remark ? `（${row.remark}）` : ""}
                  </span>
                ),
              },
              {
                title: "扣罚对象",
                dataIndex: "userName",
                width: 100,
                render: (v: string) => v || "—",
              },
              {
                title: "金额",
                dataIndex: "amount",
                width: 100,
                align: "right" as const,
                render: (v: string) => <span className="is-neg">{money(v)}</span>,
              },
            ]}
          />

          <Typography.Title level={5} style={{ marginTop: 24 }}>
            行程报销
            {Number(data.pendingExpenseCount || 0) > 0 ? (
              <Typography.Text type="warning" style={{ marginLeft: 8, fontSize: 13, fontWeight: 400 }}>
                待审 {data.pendingExpenseCount} 条
              </Typography.Text>
            ) : null}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
            报销在「结算审核 → 行程报销」页签单独核定，与案例结算通过互不影响。
            {Number(data.pendingExpenseCount || 0) > 0 ? (
              <>
                {" "}
                <Link to="/finance/review?scope=expense" onClick={onNavigate}>
                  去核定报销
                </Link>
              </>
            ) : null}
          </Typography.Paragraph>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={data.expenses || []}
            locale={{ emptyText: "本案例暂无行程报销" }}
            columns={[
              {
                title: "工程师",
                dataIndex: "inspectorName",
                width: 100,
                ellipsis: true,
                render: (v: string) => v || "—",
              },
              {
                title: "申报/核定",
                width: 130,
                render: (_: unknown, row: NonNullable<ReviewAmountBreakdown["expenses"]>[number]) => {
                  const claim = row.claimAmount ?? row.amount;
                  const approved = row.status === "approved" ? row.amount : null;
                  return approved != null ? `${money(claim)} → ${money(approved)}` : money(claim);
                },
              },
              {
                title: "状态",
                dataIndex: "status",
                width: 100,
                render: (v: string) => expenseStatusTag(v),
              },
            ]}
          />
        </>
      ) : null}
    </>
  );
}

export function SettlementAmountBody({
  caseId,
  showPerf = true,
  compactTip = false,
  onNavigate,
}: {
  caseId: string;
  showPerf?: boolean;
  compactTip?: boolean;
  onNavigate?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ReviewAmountBreakdown>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchReviewAmountBreakdown(caseId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(undefined);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: "center" }}>
        <Spin />
      </div>
    );
  }
  if (!data) return <Empty description="暂无金额明细" />;
  return (
    <SettlementAmountPanel
      data={data}
      showPerf={showPerf}
      compactTip={compactTip}
      onNavigate={onNavigate}
    />
  );
}
