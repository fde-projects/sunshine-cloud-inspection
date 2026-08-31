"use client";

import { useEffect, useRef, useState } from "react";
import { Table } from "antd";
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

/** 分页完整高度（含绿框），不用已被裁切的 DOM 高度回算 */
const PAGER_RESERVE = 58;

/** 按视口剩余高度算表体；给分页固定留白，避免页码被底边裁掉 */
export default function FillTable<RecordType extends object>(props: TableProps<RecordType>) {
  const { scroll, pagination, ...rest } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [bodyY, setBodyY] = useState(240);
  const mergedPagination = withListPagination(pagination);
  const hasPager = mergedPagination !== false;

  useEffect(() => {
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
  }, [hasPager]);

  return (
    <div ref={wrapRef} className="admin-fill-page__table">
      <Table<RecordType>
        size="small"
        {...rest}
        pagination={mergedPagination}
        scroll={{
          ...(scroll?.x ? { x: scroll.x } : {}),
          y: typeof scroll?.y === "number" && scroll.y > 32 ? scroll.y : bodyY,
        }}
      />
    </div>
  );
}
