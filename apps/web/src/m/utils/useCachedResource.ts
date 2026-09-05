import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type StoredValue<T> = {
  savedAt: number;
  value: T;
};

const CACHE_PREFIX = 'inspection-h5:data:';
const memoryCache = new Map<string, StoredValue<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

function readStored<T>(key: string, maxAge: number): T | undefined {
  const now = Date.now();
  const memory = memoryCache.get(key) as StoredValue<T> | undefined;
  if (memory && now - memory.savedAt <= maxAge) return memory.value;

  if (typeof window === 'undefined') return undefined;
  try {
    const raw = sessionStorage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) return undefined;
    const stored = JSON.parse(raw) as StoredValue<T>;
    if (now - stored.savedAt > maxAge) {
      sessionStorage.removeItem(`${CACHE_PREFIX}${key}`);
      return undefined;
    }
    memoryCache.set(key, stored);
    return stored.value;
  } catch {
    return undefined;
  }
}

function writeStored<T>(key: string, value: T) {
  const stored: StoredValue<T> = { savedAt: Date.now(), value };
  memoryCache.set(key, stored);
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(stored));
  } catch {
    // 浏览器隐私模式或空间不足时仍保留内存缓存。
  }
}

function stableEqual(a: unknown, b: unknown) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

async function requestResource<T>(key: string, loader: () => Promise<T>, force = false) {
  if (force) inflight.delete(key);
  const pending = inflight.get(key) as Promise<T> | undefined;
  if (pending) return pending;

  const request = loader()
    .then((value) => {
      writeStored(key, value);
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
  inflight.set(key, request);
  return request;
}

/** 提前加载底部页签数据，页面打开时可直接展示，避免先闪空状态。 */
export function prefetchResource<T>(key: string, loader: () => Promise<T>) {
  return requestResource(key, loader).catch(() => undefined);
}

/**
 * 移动端 stale-while-revalidate。
 * 注意：首屏不得同步读 sessionStorage（否则 SSR/CSR HTML 不一致触发 hydration error）。
 * 缓存在 useLayoutEffect 注入，仍可在绘制前带上旧数据。
 */
export function useCachedResource<T>(
  key: string,
  loader: () => Promise<T>,
  maxAge = 10 * 60 * 1000,
) {
  // 服务端与客户端首次 render 必须同为「无数据 + loading」
  const [state, setState] = useState<{ key: string; data?: T }>({ key, data: undefined });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const activeKey = useRef(key);
  activeKey.current = key;

  useLayoutEffect(() => {
    const cached = readStored<T>(key, maxAge);
    setState({ key, data: cached });
    setLoading(cached === undefined);
    setRefreshing(cached !== undefined);
    setError(false);
  }, [key, maxAge]);

  const load = useCallback(
    async (force = false) => {
      const cached = readStored<T>(key, maxAge);
      if (cached === undefined) setLoading(true);
      else if (!force) setRefreshing(true);
      setError(false);
      try {
        const value = await requestResource(key, loader, force);
        if (activeKey.current === key) {
          setState((prev) => {
            if (prev.key === key && stableEqual(prev.data, value)) return prev;
            return { key, data: value };
          });
        }
        return value;
      } catch (reason) {
        if (activeKey.current === key) setError(true);
        throw reason;
      } finally {
        if (activeKey.current === key) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [key, loader, maxAge],
  );

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const data = state.key === key ? state.data : undefined;
  const reload = useCallback(() => load(true), [load]);
  return { data, loading, refreshing, error, reload };
}
