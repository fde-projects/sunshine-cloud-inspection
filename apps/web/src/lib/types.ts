export type AppRole = "super_admin" | "site_manager" | "inspector";

export type AuthUser = {
  id: string;
  username: string;
  realName: string;
  role: AppRole;
  roles: AppRole[];
  phone: string;
};

export const ROLE_LABEL: Record<AppRole, string> = {
  super_admin: "管理员",
  site_manager: "网格长",
  inspector: "工程师",
};

export const CASE_STATUS_LABEL: Record<string, string> = {
  pending_assign: "待派单",
  assigned: "已派单",
  working: "作业中",
  finished: "已完工",
  settle_review: "结算审核",
  settled: "已结算",
  month_locked: "月结锁定",
};

export const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "待开始",
  in_progress: "进行中",
  submitted: "待审核",
  approved: "已通过",
  rejected: "已驳回",
  archived: "已归档",
};
