import type { AppRole } from "@/lib/types";
import { normalizeDuties } from "@/lib/site-duties";

export type AccountRole = "super_admin" | "user";

export function isAdminAccount(role: string | null | undefined): boolean {
  return role === "super_admin";
}

/** 登录 JWT / 会话角色：管理员固定；普通账号由网格任职推导。 */
export function loginRolesFromDuties(accountRole: string, duties: Iterable<string>): AppRole[] {
  if (isAdminAccount(accountRole)) return ["super_admin"];
  const all = normalizeDuties([...duties]);
  const next: AppRole[] = [];
  if (all.includes("primary_manager") || all.includes("deputy_manager")) next.push("site_manager");
  if (all.includes("inspector")) next.push("inspector");
  return next.length ? next : ["inspector"];
}
