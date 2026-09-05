import { Suspense } from "react";
import { Spin } from "antd";
import AppShell from "@/components/AppShell";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 48,
            }}
          >
            <Spin size="large" />
            <span style={{ color: "rgba(0,0,0,0.45)", fontSize: 14 }}>加载中…</span>
          </div>
        }
      >
        {children}
      </Suspense>
    </AppShell>
  );
}
