import type { AppRole } from "@/lib/types";
import { normalizeDuties } from "@/lib/site-duties";

/** 用户表 role：超管 / 管理员 / 普通账号。登录 JWT 仍由本字段 + 网格任职推导。 */
export type AccountRole = "super_admin" | "admin" | "user";

export const ACCOUNT_ROLE_LABEL: Record<AccountRole, string> = {
  super_admin: "超级管理员",
  admin: "管理员",
  user: "普通账号",
};

export function parseAccountRole(role: string | null | undefined): AccountRole {
  if (role === "super_admin" || role === "admin") return role;
  return "user";
}

/** 兼容旧会话：没有 accountRole 时，JWT 为 super_admin 的视为超管。 */
export function sessionAccountRole(user: {
  accountRole?: string | null;
  role?: string | null;
}): AccountRole {
  if (user.accountRole === "admin" || user.accountRole === "super_admin" || user.accountRole === "user") {
    return user.accountRole;
  }
  if (user.role === "super_admin") return "super_admin";
  return "user";
}

export function isAdminAccount(role: string | null | undefined): boolean {
  return role === "super_admin" || role === "admin";
}

export function isSuperAdminAccount(role: string | null | undefined): boolean {
  return role === "super_admin";
}

export function accountLabelOf(user: {
  accountRole?: string | null;
  role?: string | null;
}): string {
  const acc = sessionAccountRole(user);
  if (acc === "admin") return ACCOUNT_ROLE_LABEL.admin;
  if (acc === "super_admin") return ACCOUNT_ROLE_LABEL.super_admin;
  if (user.role === "site_manager") return "网格长";
  if (user.role === "inspector") return "工程师";
  return ACCOUNT_ROLE_LABEL.user;
}

export function canCreateUserAccount(viewerAccountRole: AccountRole): boolean {
  return isAdminAccount(viewerAccountRole);
}

export function canCreateAdminAccount(viewerAccountRole: AccountRole): boolean {
  return viewerAccountRole === "super_admin";
}

export function parseRequestedAccountRole(raw: unknown): AccountRole {
  const v = String(raw || "user").trim();
  if (v === "admin" || v === "super_admin") return v;
  if (v === "admin_account" || v === "administrator") return "admin";
  return "user";
}

/** 管理员只能开普通号；超管可指定普通用户 / 管理员 / 超级管理员。 */
export function canAssignAccountRole(viewerAccountRole: AccountRole, next: AccountRole): boolean {
  if (next === "user") return isAdminAccount(viewerAccountRole);
  return viewerAccountRole === "super_admin";
}

/**
 * 超管可管所有人（含其他超管）。
 * 管理员只能管普通账号，不能管管理员或超管。
 * 不能停用自己。
 */
export function canManagePlatformAccount(input: {
  viewerAccountRole: AccountRole;
  targetAccountRole: AccountRole;
  viewerId: string;
  targetId: string;
  action?: "edit" | "reset" | "status";
}): boolean {
  if (!isAdminAccount(input.viewerAccountRole)) return false;
  if (input.targetId === input.viewerId) return input.action !== "status";
  if (input.viewerAccountRole === "super_admin") return true;
  if (input.targetAccountRole === "super_admin" || input.targetAccountRole === "admin") return false;
  return true;
}

/** 登录 JWT / 会话角色：超管与管理员固定为 super_admin；普通账号由网格任职推导。 */
export function loginRolesFromDuties(accountRole: string, duties: Iterable<string>): AppRole[] {
  if (isAdminAccount(accountRole)) return ["super_admin"];
  const all = normalizeDuties([...duties]);
  const next: AppRole[] = [];
  if (all.includes("primary_manager") || all.includes("deputy_manager")) next.push("site_manager");
  if (all.includes("inspector")) next.push("inspector");
  return next.length ? next : ["inspector"];
}
