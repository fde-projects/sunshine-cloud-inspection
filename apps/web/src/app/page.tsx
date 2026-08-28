"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getStoredUser } from "@/lib/session";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    const u = getStoredUser();
    if (!u) router.replace("/login");
    else router.replace(u.role === "inspector" ? "/jobs" : "/dashboard");
  }, [router]);
  return <div className="p-10 text-center text-[var(--muted)]">正在进入…</div>;
}
