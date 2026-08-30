"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import TabLayout from "@/m/layouts/TabLayout";
import { nextPathAfterAuth, useAuthStore } from "@/stores/auth";
import "react-vant/lib/index.css";
import "@/styles/h5-shell.css";

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  const { user, hydrated, hydrate } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const isLogin = pathname === "/m/login";
  const [ready, setReady] = useState(isLogin);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (isLogin) {
      setReady(true);
      return;
    }
    if (!user) {
      router.replace("/m/login");
      return;
    }
    if (user.role !== "inspector") {
      router.replace(nextPathAfterAuth(user));
      return;
    }
    setReady(true);
  }, [hydrated, user, pathname, router, isLogin]);

  const inner = (() => {
    if (isLogin) return <>{children}</>;
    if (!hydrated) return <div style={{ padding: 48, textAlign: "center" }}>加载中…</div>;
    if (!user || !ready) {
      return <div style={{ padding: 48, textAlign: "center" }}>正在进入作业端…</div>;
    }
    return <TabLayout>{children}</TabLayout>;
  })();

  return (
    <div className="h5-app">
      <div className="h5-shell">{inner}</div>
    </div>
  );
}
