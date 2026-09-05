"use client";

import "@/m/lib/patch-react-dom";
import { Suspense, useLayoutEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import TabLayout from "@/m/layouts/TabLayout";
import { nextPathAfterAuth, useAuthStore } from "@/stores/auth";
import "react-vant/lib/index.css";
import "@/styles/h5-shell.css";

/**
 * 理想路径：始终挂真壳 TabLayout（结构先出），
 * 鉴权在 layoutEffect 完成；各页只在「要填数的区域」出骨架，数据到立刻替换。
 * 不再用整页 BootShell 挡住真页面。
 */
export default function MobileLayout({ children }: { children: React.ReactNode }) {
  const { user, hydrated, hydrate } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname() || "/m";
  const isLogin = pathname === "/m/login";

  useLayoutEffect(() => {
    hydrate();
  }, [hydrate]);

  useLayoutEffect(() => {
    if (!hydrated || isLogin) return;
    if (!user) {
      router.replace("/m/login");
      return;
    }
    if (user.role !== "inspector") {
      router.replace(nextPathAfterAuth(user));
    }
  }, [hydrated, user, pathname, router, isLogin]);

  if (isLogin) {
    return (
      <div className="h5-app">
        <div className="h5-shell">
          <Suspense fallback={null}>{children}</Suspense>
        </div>
      </div>
    );
  }

  return (
    <div className="h5-app" suppressHydrationWarning>
      <div className="h5-desktop-hint">
        <span>手机作业端 · 建议用手机打开</span>
        <a href="/">返回门户</a>
      </div>
      <div className="h5-shell">
        {/* 未登录会被上面 effect 踢回登录；此处先出真壳，避免整页启动骨架 */}
        <Suspense fallback={null}>
          <TabLayout>{children}</TabLayout>
        </Suspense>
      </div>
    </div>
  );
}
