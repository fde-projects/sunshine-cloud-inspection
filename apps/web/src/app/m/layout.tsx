"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import TabLayout from "@/m/layouts/TabLayout";
import { useAuthStore } from "@/stores/auth";
import "react-vant/lib/index.css";

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  const { user, hydrated, hydrate } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!hydrated) return;
    if (!user && pathname !== "/m/login") router.replace("/login");
  }, [hydrated, user, pathname, router]);

  if (!hydrated) return <div style={{ padding: 48, textAlign: "center" }}>加载中…</div>;
  if (pathname === "/m/login") return <>{children}</>;
  if (!user) return null;

  return <TabLayout>{children}</TabLayout>;
}
