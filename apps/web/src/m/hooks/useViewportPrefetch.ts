"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { prefetchMobileClientModule } from "../nav/mobileClientRoutes";

const warmed = new Set<string>();

function normalizeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let path = raw.trim();
  if (!path || path.startsWith("#") || path.startsWith("mailto:") || path.startsWith("tel:")) {
    return null;
  }
  try {
    if (path.startsWith("http://") || path.startsWith("https://")) {
      const u = new URL(path);
      if (typeof window !== "undefined" && u.origin !== window.location.origin) return null;
      path = u.pathname + u.search;
    }
  } catch {
    return null;
  }
  path = path.split("#")[0];
  if (!path.startsWith("/m")) return null;
  if (path.startsWith("/m/login")) return null;
  return path.split("?")[0] || null;
}

function warm(router: { prefetch: (href: string) => void }, href: string) {
  if (warmed.has(href)) return;
  warmed.add(href);
  try {
    router.prefetch(href);
  } catch {
    /* ignore */
  }
  prefetchMobileClientModule(href);
}

/**
 * 视口内出现的 /m/* 链接（或 data-prefetch）提前预加载路由 + 页面模块。
 * 挂在作业端壳上即可，对动态插入的列表项也会 MutationObserver 补观察。
 */
export function useViewportPrefetch(rootSelector = ".h5-shell") {
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;

  useEffect(() => {
    if (typeof window === "undefined" || typeof IntersectionObserver === "undefined") return;

    const root = document.querySelector(rootSelector) || document.body;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target as HTMLElement;
          const raw =
            el.getAttribute("data-prefetch") ||
            el.getAttribute("href") ||
            (el.closest("[data-prefetch]") as HTMLElement | null)?.getAttribute("data-prefetch");
          const href = normalizeHref(raw);
          if (href) warm(routerRef.current, href);
        }
      },
      {
        root: root === document.body ? null : (root as Element),
        rootMargin: "160px 0px",
        threshold: 0.01,
      },
    );

    const observed = new WeakSet<Element>();
    const scan = () => {
      root.querySelectorAll<HTMLElement>("[data-prefetch], a[href^='/m']").forEach((el) => {
        if (observed.has(el)) return;
        observed.add(el);
        io.observe(el);
      });
    };

    scan();
    const mo = new MutationObserver(() => scan());
    mo.observe(root, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [rootSelector]);
}

/** 点击/按下前再补一枪预热（列表项等非 <a> 也可调用）。 */
export function prefetchMobileHref(
  router: { prefetch: (href: string) => void } | null | undefined,
  href: string,
) {
  const path = normalizeHref(href);
  if (!path || !router) return;
  warm(router, path);
}
