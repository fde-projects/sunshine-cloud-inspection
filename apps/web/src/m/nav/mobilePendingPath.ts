import { useSyncExternalStore } from "react";

type Listener = () => void;

let pendingPath: string | null = null;
const listeners = new Set<Listener>();

function normalize(path: string) {
  return path.split("?")[0].split("#")[0];
}

/** 乐观路径：点链接后立刻切壳，不等 Next RSC 段交换。 */
export function setMobilePendingPath(path: string | null) {
  const next = path ? normalize(path) : null;
  if (pendingPath === next) return;
  pendingPath = next;
  listeners.forEach((l) => l());
}

export function getMobilePendingPath() {
  return pendingPath;
}

export function subscribeMobilePendingPath(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMobilePendingPath() {
  return useSyncExternalStore(
    subscribeMobilePendingPath,
    getMobilePendingPath,
    () => null,
  );
}

/** pathname 追上后清掉乐观态。 */
export function clearMobilePendingIfMatched(pathname: string) {
  if (!pendingPath) return;
  if (pathname === pendingPath || pathname.startsWith(`${pendingPath}/`)) {
    setMobilePendingPath(null);
  }
}
