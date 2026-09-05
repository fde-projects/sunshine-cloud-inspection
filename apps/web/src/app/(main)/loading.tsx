"use client";

import { Spin } from "antd";

/** 路由切换时立即给出反馈，避免菜单点了像没点到。 */
export default function MainLoading() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        minHeight: 240,
        padding: 24,
      }}
    >
      <Spin size="large" />
      <span style={{ color: "rgba(0,0,0,0.45)", fontSize: 14 }}>加载中…</span>
    </div>
  );
}
