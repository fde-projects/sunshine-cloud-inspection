import type { UserRole } from "@/types";

/** 登录身份标签：正网格长仅在任命后才显示 */
export type StaffingAppointment = "primary" | "deputy" | "none";

export function userRolesOf(record: {
  roles?: UserRole[];
  role?: UserRole;
}): UserRole[] {
  return record.roles?.length ? record.roles : record.role ? [record.role] : [];
}

export function roleTagsOf(
  record: { id: string; roles?: UserRole[]; role?: UserRole },
  opts?: {
    appointment?: StaffingAppointment;
    currentUserId?: string;
  },
): string[] {
  const list = userRolesOf(record);
  const tags: string[] = [];
  if (list.includes("super_admin")) {
    tags.push("超级管理员");
    return tags;
  }
  if (list.includes("site_manager")) {
    const appt = opts?.appointment || "none";
    if (appt === "primary") tags.push("正网格长");
    else if (appt === "deputy") tags.push("副网格长");
    else tags.push("网格长（待任命）");
  }
  if (list.includes("inspector")) tags.push("工程师");
  if (!tags.length) tags.push("未知角色");
  return tags;
}

/** 创建/更新账号时允许的登录角色（按操作者身份） */
export function assertCreatableRoles(input: {
  viewerRole: UserRole;
  /** 操作者是否为正网格长（至少一站） */
  viewerIsPrimary: boolean;
  /** 操作者是否为副网格长（且非正长时可收紧） */
  viewerIsDeputyOnly: boolean;
  roles: UserRole[];
}) {
  const roles = [...new Set(input.roles.filter(Boolean))];
  if (!roles.length) throw new Error("请选择登录身份");
  if (roles.includes("super_admin")) throw new Error("不能创建或设为超级管理员");

  if (input.viewerRole === "super_admin") {
    if (roles.some((r) => r !== "site_manager" && r !== "inspector")) {
      throw new Error("管理员只能创建网格长登录账号或工程师账号");
    }
    return roles;
  }

  if (input.viewerRole !== "site_manager") {
    throw new Error("无权创建账号");
  }

  if (input.viewerIsDeputyOnly) {
    if (roles.some((r) => r !== "inspector")) {
      throw new Error("副网格长只能创建工程师账号");
    }
    return roles;
  }

  if (input.viewerIsPrimary) {
    if (roles.some((r) => r !== "site_manager" && r !== "inspector")) {
      throw new Error("只能创建副网格长或工程师登录账号");
    }
    return roles;
  }

  throw new Error("请先被任命为正网格长或副网格长后再创建账号");
}
