"use client";

import { useEffect, useState, type ComponentType } from "react";
import {
  MOBILE_CLIENT_ROUTES,
  matchMobileClientRoute,
  type MobileClientRoute,
} from "../nav/mobileClientRoutes";

type AliveSlot = {
  route: MobileClientRoute;
  path: string;
};

/**
 * 二级页 keep-alive：全部 eager 真组件。
 * 进页即页面自己的结构；数据区由各页局部骨架填充，无整页 Suspense 灰壳。
 */
export default function MobileSecondaryHost({ pathname }: { pathname: string }) {
  const active = matchMobileClientRoute(pathname);
  const [alive, setAlive] = useState<Record<string, AliveSlot>>(() => {
    const initial: Record<string, AliveSlot> = {};
    if (active) initial[active.slot] = { route: active, path: pathname };
    return initial;
  });

  useEffect(() => {
    if (!active) return;
    setAlive((prev) => {
      const cur = prev[active.slot];
      if (cur && cur.path === pathname && cur.route.slot === active.slot) return prev;
      return { ...prev, [active.slot]: { route: active, path: pathname } };
    });
  }, [active, pathname]);

  // 空闲预挂静态页，点「我的收入」等时组件已在（可顺带预拉数据）
  useEffect(() => {
    const warm = () => {
      setAlive((prev) => {
        let next = prev;
        for (const route of MOBILE_CLIENT_ROUTES) {
          if (!route.keep) continue;
          if (prev[route.slot]) continue;
          if (next === prev) next = { ...prev };
          next[route.slot] = { route, path: `warm:${route.slot}` };
        }
        return next;
      });
    };
    let idleId: number | undefined;
    let timerId: number | undefined;
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(warm, { timeout: 900 });
    } else {
      timerId = globalThis.setTimeout(warm, 200) as unknown as number;
    }
    return () => {
      if (idleId != null && typeof window !== "undefined" && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timerId != null) globalThis.clearTimeout(timerId);
    };
  }, []);

  if (!active && Object.keys(alive).length === 0) return null;

  return (
    <>
      {Object.entries(alive).map(([slot, item]) => {
        const show = active?.slot === slot;
        const reactKey = item.route.keep ? slot : item.path;
        const Page = item.route.Component as ComponentType;
        return (
          <div
            key={slot}
            className="tab-pane"
            hidden={!show}
            aria-hidden={!show}
          >
            <Page key={reactKey} />
          </div>
        );
      })}
    </>
  );
}
