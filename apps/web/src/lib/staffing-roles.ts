import type { AccountRole, UserRole } from "@/types";
import type { SiteDutyFlags } from "@/lib/site-duties";

export type StaffingAppointment = "primary" | "deputy" | "none";

export function userRolesOf(record: {
  roles?: UserRole[];
  role?: UserRole;
}): UserRole[] {
  return record.roles?.length ? record.roles : record.role ? [record.role] : [];
}

export function roleTagsOf(
  record: {
    id: string;
    roles?: UserRole[];
    role?: UserRole;
    accountRole?: string;
  },
  opts?: {
    appointment?: StaffingAppointment;
    duties?: SiteDutyFlags;
    currentUserId?: string;
  },
): string[] {
  const list = userRolesOf(record);
  if (record.accountRole === "admin") return ["管理员"];
  if (record.accountRole === "super_admin" || list.includes("super_admin")) return ["超级管理员"];

  const tags: string[] = [];
  const duties = opts?.duties;
  if (duties) {
    if (duties.primary) tags.push("正网格长");
    if (duties.deputy) tags.push("副网格长");
    if (duties.inspector) tags.push("工程师");
    if (!tags.length) tags.push("普通账号");
    return tags;
  }

  const appt = opts?.appointment || "none";
  if (appt === "primary") tags.push("正网格长");
  else if (appt === "deputy") tags.push("副网格长");
  if (list.includes("inspector") || appt === "none") {
    if (list.includes("inspector") && !tags.includes("工程师")) tags.push("工程师");
  }
  if (!tags.length) tags.push("普通账号");
  return tags;
}

/** 仅管理员可开设平台普通账号；任职由网格编制决定 */
export function assertCreatableRoles(input: {
  viewerRole: UserRole;
  viewerAccountRole?: AccountRole;
  viewerIsPrimary?: boolean;
  viewerIsDeputyOnly?: boolean;
  roles?: UserRole[];
  createAdmin?: boolean;
  accountRole?: AccountRole;
}) {
  if (input.viewerRole !== "super_admin") {
    throw new Error("仅管理员可开设平台账号");
  }
  const next = input.accountRole || (input.createAdmin ? "admin" : "user");
  if (next !== "user" && input.viewerAccountRole !== "super_admin") {
    throw new Error("仅超级管理员可指定管理员或超级管理员身份");
  }
  return [] as UserRole[];
}
