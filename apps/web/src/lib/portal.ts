import type { AppRole } from "@/lib/types";
import { ROLE_LABEL } from "@/lib/types";

export function normalizeRoles(roles: AppRole[] | null | undefined, fallback: AppRole): AppRole[] {
  if (Array.isArray(roles) && roles.length) return [...new Set(roles)];
  return [fallback];
}

export function needsRolePick(roles: AppRole[]): boolean {
  return canSwitchPortal(roles);
}

/** 账号同时有管理端身份和工程师身份时，回入口页换端即可 */
export function canSwitchPortal(roles: AppRole[]): boolean {
  const pc = roles.includes("super_admin") || roles.includes("site_manager");
  return pc && roles.includes("inspector");
}

export function parseRoleInput(raw: unknown, roles: AppRole[] = []): AppRole | null {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (v === "super_admin" || v === "site_manager" || v === "inspector") {
    if (roles.length && !roles.includes(v)) return null;
    return v;
  }
  if (v === "h5" || v === "m" || v === "mobile") {
    return roles.length === 0 || roles.includes("inspector") ? "inspector" : null;
  }
  if (v === "pc" || v === "web" || v === "admin") {
    if (roles.includes("super_admin")) return "super_admin";
    if (roles.includes("site_manager")) return "site_manager";
    return null;
  }
  return null;
}

export function roleForPortal(portal: unknown, roles: AppRole[]): AppRole | null {
  return parseRoleInput(portal, roles);
}

export function roleHome(role: AppRole): string {
  return role === "inspector" ? "/m" : "/dashboard";
}

export const ROLE_CARD: Record<
  AppRole,
  { title: string; place: string; desc: string }
> = {
  super_admin: {
    title: ROLE_LABEL.super_admin,
    place: "管理工作台",
    desc: "用户、网格、系统配置与全局数据",
  },
  site_manager: {
    title: ROLE_LABEL.site_manager,
    place: "管理工作台",
    desc: "网格编制、巡检验图、结算审核",
  },
  inspector: {
    title: ROLE_LABEL.inspector,
    place: "现场作业端",
    desc: "开检、拍照、定位与提交报告",
  },
};

export const ROLE_ORDER: AppRole[] = ["super_admin", "site_manager", "inspector"];
