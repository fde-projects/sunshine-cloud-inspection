import { fetchTasks } from "../api/task";
import { fetchInspectorSummary } from "../api/stats";
import { fetchMyIncome } from "../api/finance";
import { mobileCacheKeys } from "./mobileCacheKeys";
import { prefetchResource } from "./useCachedResource";
import {
  prefetchMobileClientModule,
} from "../nav/mobileClientRoutes";

export const MOBILE_TAB_PATHS = ["/m", "/m/tasks", "/m/my"] as const;

export const MOBILE_SECONDARY_PATHS = [
  "/m/income",
  "/m/settings",
  "/m/help",
  "/m/sites",
] as const;

function safePrefetch(
  router: { prefetch: (href: string) => void } | null | undefined,
  path: string,
) {
  try {
    router?.prefetch(path);
  } catch {
    /* ignore */
  }
}

/** 预热三个 Tab 的路由与页面模块（登录后尽早调用）。 */
export function prefetchMobileTabAssets(router?: { prefetch: (href: string) => void } | null) {
  MOBILE_TAB_PATHS.forEach((path) => safePrefetch(router, path));
  void import("../pages/home");
  void import("../pages/tasks");
  void import("../pages/my");
  const warmSecondary = () => prefetchMobileSecondaryAssets(router);
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    window.requestIdleCallback(warmSecondary, { timeout: 1800 });
  } else if (typeof globalThis !== "undefined") {
    globalThis.setTimeout(warmSecondary, 400);
  } else {
    warmSecondary();
  }
}

/** 预热常用二级页路由（模块已在主包，主要预热 Next 路由与收入数据）。 */
export function prefetchMobileSecondaryAssets(
  router?: { prefetch: (href: string) => void } | null,
) {
  MOBILE_SECONDARY_PATHS.forEach((path) => {
    safePrefetch(router, path);
    prefetchMobileClientModule(path);
  });
}

/** 预热三个 Tab 常用接口缓存，与页面 cacheKey 对齐。 */
export function prefetchMobileTabData(userId?: string, siteId?: string) {
  void prefetchResource(
    mobileCacheKeys.homeTasks(userId, siteId) + ":site-scoped-v1",
    () =>
      Promise.all([
        fetchTasks({ page: 1, limit: 50, siteId }),
        import("../api/finance").then((m) => m.fetchMyFinanceCases().catch(() => [])),
      ]).then(([taskPage, financeCases]) => ({
        tasks: taskPage.list,
        financeCases,
      })),
  );
  void prefetchResource(
    mobileCacheKeys.taskList(userId, siteId, "site-jobs|all|"),
    () =>
      Promise.all([
        fetchTasks({ page: 1, limit: 200, siteId }),
        import("../api/finance").then((m) => m.fetchMyFinanceCases().catch(() => [])),
      ]).then(([taskPage, financeCases]) => ({
        tasks: taskPage.list,
        financeCases,
      })),
  );
  void prefetchResource(mobileCacheKeys.inspectorSummary(userId, siteId), () =>
    fetchInspectorSummary(siteId),
  );
  const ym = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  void prefetchResource(mobileCacheKeys.myIncome(userId, ym), () => fetchMyIncome(ym));
}
