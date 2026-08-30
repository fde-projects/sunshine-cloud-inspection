"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** 入口页已承担选端；旧「选择身份」地址回入口 */
export default function ChooseRolePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return <div className="p-10 text-center text-[var(--muted)]">正在返回入口…</div>;
}
