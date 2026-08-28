"use client";

import "@ant-design/v5-patch-for-react-19";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth";

const theme = {
  token: {
    colorPrimary: "#16835f",
    colorInfo: "#16835f",
    colorSuccess: "#18a573",
    colorWarning: "#e7a23b",
    colorText: "#18332a",
    colorTextSecondary: "#657a72",
    colorBgLayout: "#f3f7f5",
    borderRadius: 10,
    borderRadiusLG: 16,
    controlHeight: 40,
    fontFamily: "'Inter', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    boxShadowSecondary: "0 18px 48px rgba(22, 70, 52, 0.12)",
  },
  components: {
    Button: { primaryShadow: "0 8px 20px rgba(22, 131, 95, 0.2)" },
    Card: { headerBg: "transparent" },
    Table: { headerBg: "#f5f8f7", headerColor: "#49635a" },
    Menu: { darkItemBg: "transparent", darkSubMenuItemBg: "transparent" },
  },
} as const;

ConfigProvider.config({
  holderRender: (children) => (
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  ),
});

export default function AntdProvider({ children }: { children: React.ReactNode }) {
  const hydrate = useAuthStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  return (
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntApp>{children}</AntApp>
    </ConfigProvider>
  );
}
