"use client";

import { useEffect, useRef, useState, type Key, type ReactNode } from "react";
import { Drawer, Empty, Grid, Pagination, Spin, Table } from "antd";
import type { TablePaginationConfig, TableProps } from "antd";

export const LIST_PAGE_SIZES = [10, 20, 25, 50];

/** 列表统一分页：页码 +「20 条/页」 */
export function listTablePagination(opts: {
  current: number;
  total: number;
  pageSize: number;
  onChange: (page: number, pageSize: number) => void;
  itemLabel?: string;
}): TablePaginationConfig {
  return {
    current: opts.current,
    total: opts.total,
    pageSize: opts.pageSize,
    showSizeChanger: true,
    pageSizeOptions: LIST_PAGE_SIZES,
    showTotal: (t) => `共 ${t} ${opts.itemLabel ?? "条"}`,
    onChange: opts.onChange,
  };
}

function withListPagination(
  pagination: TableProps["pagination"],
): TableProps["pagination"] {
  if (pagination === false) return false;
  const p = pagination && typeof pagination === "object" ? pagination : {};
  return {
    showSizeChanger: true,
    pageSizeOptions: LIST_PAGE_SIZES,
    pageSize: 20,
    ...p,
  };
}

function resolveRowKey<RecordType extends object>(
  rowKey: TableProps<RecordType>["rowKey"],
  record: RecordType,
  index: number,
): Key {
  if (typeof rowKey === "function") return rowKey(record);
  if (typeof rowKey === "string") {
    return (record as Record<string, Key>)[rowKey] ?? index;
  }
  return index;
}

const PAGER_RESERVE = 58;

type FillTableProps<RecordType extends object> = TableProps<RecordType> & {
  /**
   * 小屏列表内容。默认「紧凑行 + 点开底部抽屉看详情/操作」：
   * 列表里隐藏操作区，抽屉里展示完整内容，数据多时更好扫。
   * 第三参 closeSheet：点「编辑」等打开上层弹窗前先关掉抽屉，避免盖住表单。
   */
  mobileCard?: (
    record: RecordType,
    index: number,
    ctx: { closeSheet: () => void },
  ) => ReactNode;
  /** 抽屉标题；默认「详情与操作」 */
  mobileSheetTitle?: string | ((record: RecordType) => ReactNode);
};

/** 桌面锁高表格；小屏紧凑列表 + 操作抽屉，避免横滑宽表和超高卡片。 */
export default function FillTable<RecordType extends object>(props: FillTableProps<RecordType>) {
  const {
    scroll,
    pagination,
    size,
    className,
    mobileCard,
    mobileSheetTitle,
    loading,
    dataSource,
    rowKey,
    ...rest
  } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bodyY, setBodyY] = useState(240);
  const [sheet, setSheet] = useState<{ record: RecordType; index: number } | null>(null);
  const screens = Grid.useBreakpoint();
  const isMobile = !screens.md;
  const mergedPagination = withListPagination(pagination);
  const hasPager = mergedPagination !== false;
  const useMobileList = Boolean(isMobile && mobileCard);

  useEffect(() => {
    if (isMobile || useMobileList) return;
    const el = wrapRef.current;
    if (!el) return;

    const measure = () => {
      const header = el.querySelector(".ant-table-header") as HTMLElement | null;
      const headerH = header?.getBoundingClientRect().height || 39;
      const top = el.getBoundingClientRect().top;
      const pagerH = hasPager ? PAGER_RESERVE : 0;
      const next = Math.floor(window.innerHeight - top - headerH - pagerH - 22);
      setBodyY((prev) => {
        const y = Math.max(200, next);
        return prev === y ? prev : y;
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [hasPager, isMobile, useMobileList]);

  if (useMobileList && mobileCard) {
    const rows = (Array.isArray(dataSource) ? dataSource : []) as RecordType[];
    const pager =
      mergedPagination && typeof mergedPagination === "object" ? mergedPagination : null;
    const selection = rest.rowSelection;
    const selectedKeys = new Set((selection?.selectedRowKeys || []).map(String));
    const selectedCount = selectedKeys.size;

    const toggleRow = (key: Key, checked: boolean) => {
      if (!selection?.onChange) return;
      const prev = (selection.selectedRowKeys || []).map(String);
      const next = checked
        ? Array.from(new Set([...prev, String(key)]))
        : prev.filter((k) => k !== String(key));
      const nextRecords = rows.filter((row, i) =>
        next.includes(String(resolveRowKey(rowKey, row, i))),
      );
      selection.onChange(next as Key[], nextRecords as RecordType[], { type: 'multiple' });
    };

    const sheetTitle =
      sheet &&
      (typeof mobileSheetTitle === "function"
        ? mobileSheetTitle(sheet.record)
        : mobileSheetTitle || "详情与操作");

    const sheetCtx = { closeSheet: () => setSheet(null) };

    return (
      <div className="admin-mobile-list is-dense">
        {selection && selectedCount > 0 ? (
          <div className="admin-mobile-list__batch">
            已选 <b>{selectedCount}</b> 条 · 可点上方批量按钮
          </div>
        ) : null}
        <Spin spinning={Boolean(loading)}>
          {rows.length ? (
            <div className="admin-mobile-list__cards" role="list">
              {rows.map((record, index) => {
                const key = resolveRowKey(rowKey, record, index);
                const checked = selectedKeys.has(String(key));
                return (
                  <div
                    key={String(key)}
                    role="listitem"
                    className={`admin-mobile-card${checked ? " is-selected" : ""}`}
                  >
                    {selection ? (
                      <label
                        className="admin-mobile-card__check"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => toggleRow(key, e.target.checked)}
                        />
                      </label>
                    ) : null}
                    <div
                      role="button"
                      tabIndex={0}
                      className="admin-mobile-card__hit"
                      onClick={() => setSheet({ record, index })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSheet({ record, index });
                        }
                      }}
                    >
                      <div className="admin-mobile-card__body">
                        {mobileCard(record, index, sheetCtx)}
                      </div>
                      <span className="admin-mobile-card__chev" aria-hidden>
                        ›
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="admin-mobile-list__empty">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
            </div>
          )}
        </Spin>
        {pager ? (
          <div className="admin-mobile-list__pager">
            <Pagination
              size="small"
              current={pager.current}
              total={pager.total}
              pageSize={pager.pageSize}
              showSizeChanger={false}
              showTotal={pager.showTotal}
              onChange={(p, ps) => pager.onChange?.(p, ps || pager.pageSize || 20)}
            />
          </div>
        ) : null}

        <Drawer
          rootClassName="admin-mobile-sheet"
          title={sheetTitle}
          placement="bottom"
          height="78%"
          open={!!sheet}
          onClose={() => setSheet(null)}
          destroyOnClose
        >
          {sheet ? (
            <div className="admin-mobile-sheet__content">
              {mobileCard(sheet.record, sheet.index, sheetCtx)}
            </div>
          ) : null}
        </Drawer>
      </div>
    );
  }

  const scrollProp = isMobile
    ? scroll?.x
      ? { x: scroll.x }
      : undefined
    : {
        ...(scroll?.x ? { x: scroll.x } : {}),
        y: typeof scroll?.y === "number" && scroll.y > 32 ? scroll.y : bodyY,
      };

  return (
    <div ref={wrapRef} className="admin-fill-page__table">
      <Table<RecordType>
        size={size ?? (isMobile ? "middle" : "small")}
        className={["admin-fill-table", isMobile ? "is-mobile" : "", className]
          .filter(Boolean)
          .join(" ")}
        loading={loading}
        dataSource={dataSource}
        rowKey={rowKey}
        {...rest}
        pagination={mergedPagination}
        scroll={scrollProp}
      />
    </div>
  );
}
