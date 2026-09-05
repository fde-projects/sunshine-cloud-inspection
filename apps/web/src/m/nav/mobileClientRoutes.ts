import type { ComponentType } from "react";
import IncomePage from "../pages/finance/income";
import SettingsPage from "../pages/settings";
import SitesPage from "../pages/sites";
import StartPage from "../pages/start";
import HelpPage from "../pages/help";
import FinanceCaseDetailPage from "../pages/finance/case-detail";
import FinanceExpensePage from "../pages/finance/expense";
import TaskDetailPage from "../pages/tasks/detail";
import InspectionPage from "../pages/inspection";
import ReportPage from "../pages/report";
import PhotoPage from "../pages/photo";
import SuccessPage from "../pages/success";

export type MobileClientRoute = {
  slot: string;
  title: string;
  /** 离开后再进是否保留组件状态（静态页） */
  keep: boolean;
  test: (pathname: string) => boolean;
  Component: ComponentType;
  load: () => Promise<{ default: ComponentType }>;
};

function defineRoute(
  slot: string,
  title: string,
  keep: boolean,
  test: (pathname: string) => boolean,
  Component: ComponentType,
): MobileClientRoute {
  return {
    slot,
    title,
    keep,
    test,
    Component,
    load: () => Promise.resolve({ default: Component }),
  };
}

/** 全部二级页随主包：进页即真结构，只等接口填数（不再 Suspense 灰整页）。 */
export const MOBILE_CLIENT_ROUTES: MobileClientRoute[] = [
  defineRoute("income", "我的收入", true, (p) => p === "/m/income", IncomePage),
  defineRoute("settings", "个人资料", true, (p) => p === "/m/settings", SettingsPage),
  defineRoute("help", "使用帮助", true, (p) => p === "/m/help", HelpPage),
  defineRoute("sites", "选择站点", true, (p) => p === "/m/sites", SitesPage),
  defineRoute("start", "开始作业", true, (p) => p === "/m/start", StartPage),
  defineRoute(
    "finance-case",
    "作业单",
    false,
    (p) => /^\/m\/finance-cases\/[^/]+\/?$/.test(p),
    FinanceCaseDetailPage,
  ),
  defineRoute(
    "finance-expense",
    "费用报销",
    false,
    (p) => /^\/m\/finance-cases\/[^/]+\/expense\/?$/.test(p),
    FinanceExpensePage,
  ),
  defineRoute(
    "task-detail",
    "作业信息",
    false,
    (p) => /^\/m\/tasks\/[^/]+\/?$/.test(p),
    TaskDetailPage,
  ),
  defineRoute(
    "inspection",
    "现场作业",
    false,
    (p) => /^\/m\/inspection\/[^/]+\/?$/.test(p),
    InspectionPage,
  ),
  defineRoute(
    "report",
    "报告",
    false,
    (p) => /^\/m\/report\/[^/]+\/?$/.test(p),
    ReportPage,
  ),
  defineRoute("photo", "照片预览", false, (p) => p.startsWith("/m/photo"), PhotoPage),
  defineRoute("success", "提交成功", false, (p) => p.startsWith("/m/success"), SuccessPage),
];

export function matchMobileClientRoute(pathname: string): MobileClientRoute | null {
  for (const route of MOBILE_CLIENT_ROUTES) {
    if (route.test(pathname)) return route;
  }
  return null;
}

export function prefetchMobileClientModule(pathname: string) {
  const route = matchMobileClientRoute(pathname);
  if (!route) return;
  void route.load();
}

export function isMobileHideTabPath(pathname: string) {
  return (
    pathname.includes("/inspection/") ||
    pathname.includes("/photo") ||
    pathname.includes("/success") ||
    pathname.includes("/login") ||
    pathname.includes("/finance-cases/") ||
    pathname.includes("/report/") ||
    pathname.includes("/m/sites") ||
    pathname.includes("/m/settings") ||
    pathname.includes("/m/help") ||
    pathname.includes("/m/income") ||
    pathname.includes("/m/history") ||
    pathname.includes("/m/start") ||
    /\/m\/tasks\/[^/]+$/.test(pathname)
  );
}
