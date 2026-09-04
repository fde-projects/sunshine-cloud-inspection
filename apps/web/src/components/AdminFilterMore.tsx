"use client";

import type { ReactNode } from "react";
import { Grid } from "antd";

type Props = {
  children: ReactNode;
  /** 小屏折叠标题 */
  summary?: string;
};

/**
 * 桌面强制展开筛选项；小屏才折叠成「更多筛选」。
 * 原生 details 在关闭时即使 display:contents 也会藏内容，导致桌面看不到状态等筛选项。
 */
export default function AdminFilterMore({ children, summary = "更多筛选" }: Props) {
  const screens = Grid.useBreakpoint();
  const desktop = Boolean(screens.md);

  return (
    <details className="admin-filter-more" open={desktop ? true : undefined}>
      <summary>{summary}</summary>
      <div className="admin-filter-more__body">{children}</div>
    </details>
  );
}
