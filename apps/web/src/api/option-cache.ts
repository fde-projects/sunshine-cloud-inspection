import { fetchSites } from "@/api/site";
import { fetchTemplates } from "@/api/template";
import type { SiteItem } from "@/types";

type CacheEntry<T> = { at: number; value: T };

const TTL_MS = 60_000;

let sitesInflight: Promise<SiteItem[]> | null = null;
let sitesCache: CacheEntry<SiteItem[]> | null = null;

let templatesInflight: Promise<Awaited<ReturnType<typeof fetchTemplates>>> | null = null;
let templatesCache: CacheEntry<Awaited<ReturnType<typeof fetchTemplates>>> | null = null;

/** 筛选项用网格列表：60s 内复用，同屏多页不重复打 Hasura。 */
export function fetchActiveSitesCached(limit = 100): Promise<SiteItem[]> {
  if (sitesCache && Date.now() - sitesCache.at < TTL_MS) {
    return Promise.resolve(sitesCache.value);
  }
  if (!sitesInflight) {
    sitesInflight = fetchSites({ page: 1, limit, status: "active" })
      .then((res) => {
        const list = res.list || [];
        sitesCache = { at: Date.now(), value: list };
        return list;
      })
      .finally(() => {
        sitesInflight = null;
      });
  }
  return sitesInflight;
}

/** 服务类型列表缓存（无过滤参数时）。 */
export function fetchTemplatesCached(): Promise<Awaited<ReturnType<typeof fetchTemplates>>> {
  if (templatesCache && Date.now() - templatesCache.at < TTL_MS) {
    return Promise.resolve(templatesCache.value);
  }
  if (!templatesInflight) {
    templatesInflight = fetchTemplates()
      .then((list) => {
        templatesCache = { at: Date.now(), value: list };
        return list;
      })
      .finally(() => {
        templatesInflight = null;
      });
  }
  return templatesInflight;
}

export function invalidateOptionCaches() {
  sitesCache = null;
  templatesCache = null;
}
