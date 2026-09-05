"use client";

import { useEffect, useState } from "react";

/** 问候语/日期仅客户端计算，避免 SSR 与浏览器时区不一致导致 hydration 报错 */
export function useClientNow() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);
  return now;
}
