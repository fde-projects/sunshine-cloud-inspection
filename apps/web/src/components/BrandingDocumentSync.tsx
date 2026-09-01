"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { applyBrandingToDocument, useBrandingStore } from "@/stores/branding";

/**
 * 路由切换时 Next metadata 可能把 title/favicon 盖回默认值，
 * 这里按当前品牌设置重新写回浏览器标签。
 */
export default function BrandingDocumentSync() {
  const pathname = usePathname();
  const branding = useBrandingStore((s) => s.branding);

  useEffect(() => {
    applyBrandingToDocument(branding);
    // metadata / 浏览器偶发晚于 effect 写入，再补两次
    const t1 = window.setTimeout(() => applyBrandingToDocument(branding), 0);
    const t2 = window.setTimeout(() => applyBrandingToDocument(branding), 200);
    const t3 = window.setTimeout(() => applyBrandingToDocument(branding), 800);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [branding.systemName, branding.logoUrl, branding.updatedAt, pathname]);

  return null;
}
