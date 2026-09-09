import { gql } from "@/lib/gql";
import {
  canAssignAccountRole,
  canManagePlatformAccount,
  isAdminAccount,
  parseAccountRole,
  parseRequestedAccountRole,
  sessionAccountRole,
} from "@/lib/account";
import { getStoredUser } from "@/lib/session";
import { type SiteDutyFlags } from "@/lib/site-duties";
import { assertCreatableRoles, type StaffingAppointment } from "@/lib/staffing-roles";
import request from "@/utils/request";
import type { AccountRole, ApiResponse, CommonStatus, Paginated, UserInfo, UserRole } from "@/types";

export interface UserQuery {
  role?: UserRole;
  status?: CommonStatus;
  keyword?: string;
  page?: number;
  limit?: number;
}

const USER_FIELDS = `
  id username real_name employee_no phone email avatar role status region org_unit created_by_id created_at
`;

function mapUser(r: Record<string, unknown>): UserInfo {
  const accountRole = parseAccountRole(String(r.accountRole || r.account_role || r.role || "user"));
  const platform = isAdminAccount(accountRole);
  return {
    id: String(r.id),
    username: String(r.username),
    realName: String(r.real_name ?? r.realName ?? ""),
    employeeNo: (r.employee_no as string) ?? (r.employeeNo as string) ?? null,
    phone: String(r.phone ?? ""),
    email: r.email as string | undefined,
    avatar: r.avatar as string | undefined,
    role: platform ? "super_admin" : ((r.role as UserRole) || "inspector"),
    roles: platform ? ["super_admin"] : ((r.roles as UserRole[]) || []),
    accountRole,
    status: String(r.status ?? "active"),
    region: r.region as string | undefined,
    orgUnit: (r.org_unit as string) ?? (r.orgUnit as string) ?? undefined,
    createdBy: (r.created_by_id as string) ?? (r.createdBy as string) ?? null,
    createdAt: (r.created_at as string) ?? (r.createdAt as string) ?? undefined,
    duties: r.duties as UserInfo["duties"],
  };
}

function hasRoleWhere(role: UserRole) {
  if (role === "super_admin") return { role: { _in: ["super_admin", "admin"] } };
  return { role: { _eq: "user" } };
}

function keywordWhere(keyword: string) {
  return {
    _or: [
      { username: { _ilike: `%${keyword}%` } },
      { real_name: { _ilike: `%${keyword}%` } },
      { phone: { _ilike: `%${keyword}%` } },
      { employee_no: { _ilike: `%${keyword}%` } },
    ],
  };
}

async function queryUsers(where: Record<string, unknown>, page: number, limit: number) {
  const data = await gql<{
    users: Record<string, unknown>[];
    users_aggregate: { aggregate: { count: number } };
  }>(
    `query ($where: users_bool_exp!, $limit: Int!, $offset: Int!) {
      users(where: $where, limit: $limit, offset: $offset, order_by: { created_at: desc }) {
        ${USER_FIELDS}
      }
      users_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return {
    list: data.users.map(mapUser),
    total: data.users_aggregate.aggregate.count,
    page,
    limit,
  };
}

export async function fetchUsers(params: UserQuery): Promise<Paginated<UserInfo>> {
  const page = params.page || 1;
  const limit = params.limit || 10;
  const and: Record<string, unknown>[] = [];
  if (params.role) and.push(hasRoleWhere(params.role));
  if (params.status) and.push({ status: { _eq: params.status } });
  if (params.keyword) and.push(keywordWhere(params.keyword));
  return queryUsers(and.length ? { _and: and } : {}, page, limit);
}

/** 平台账号池：管理员与网格长都能从全量普通账号里选人 */
export async function fetchStaffingUsers(params: UserQuery): Promise<Paginated<UserInfo>> {
  const { data } = await request.get<ApiResponse<Paginated<UserInfo & { duties?: SiteDutyFlags }>>>(
    "/staffing/accounts",
    {
      params: {
        keyword: params.keyword,
        page: params.page || 1,
        limit: params.limit || 50,
      },
      skipErrorToast: true,
    },
  );
  let list = data.data.list || [];
  if (params.status) list = list.filter((u) => u.status === params.status);
  if (params.role === "site_manager") {
    list = list.filter((u) => u.duties?.primary || u.duties?.deputy);
  } else if (params.role === "inspector") {
    list = list.filter((u) => u.duties?.inspector);
  }
  return {
    list,
    total: params.role || params.status ? list.length : data.data.total,
    page: data.data.page,
    limit: data.data.limit,
  };
}

async function viewerStaffFlags() {
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  if (me.role === "super_admin") {
    return { me, viewerIsPrimary: false, viewerIsDeputyOnly: false };
  }
  if (me.role !== "site_manager") {
    return { me, viewerIsPrimary: false, viewerIsDeputyOnly: false };
  }
  const { fetchMyStaffSites } = await import("@/api/site");
  const staff = await fetchMyStaffSites(me.id);
  return {
    me,
    viewerIsPrimary: staff.isPrimary,
    viewerIsDeputyOnly: staff.isDeputy && !staff.isPrimary,
  };
}

/** 是否允许管理目标账号（重置密码 / 启停 / 改资料） */
export async function assertCanManageAccount(targetId: string, targetAccountRole?: AccountRole) {
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  let targetRole = targetAccountRole;
  if (!targetRole) {
    const data = await gql<{
      users_by_pk: { created_by_id: string | null; role: string } | null;
    }>(`query ($id: uuid!) { users_by_pk(id: $id) { created_by_id role } }`, { id: targetId });
    const row = data.users_by_pk;
    if (!row) throw new Error("账号不存在");
    targetRole = parseAccountRole(row.role);
  }
  if (
    canManagePlatformAccount({
      viewerAccountRole: sessionAccountRole(me),
      targetAccountRole: targetRole,
      viewerId: me.id,
      targetId,
      action: "edit",
    })
  ) {
    return;
  }
  if (targetRole === "super_admin") throw new Error("不能管理超级管理员");
  if (targetRole === "admin") throw new Error("不能管理其他管理员");
  throw new Error("仅管理员可管理平台账号");
}

/** 批量查任命状态：正网格长 / 副网格长 / 待任命 */
export async function fetchStaffingAppointments(
  userIds: string[],
): Promise<Record<string, StaffingAppointment>> {
  const out: Record<string, StaffingAppointment> = {};
  for (const id of userIds) out[id] = "none";
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return out;
  const data = await gql<{
    primaries: Array<{ manager_id: string | null }>;
    deputies: Array<{ user_id: string }>;
  }>(
    `query ($ids: [uuid!]!) {
      primaries: sites(
        where: {
          manager_id: { _in: $ids }
          deleted_at: { _is_null: true }
          status: { _eq: "active" }
        }
      ) { manager_id }
      deputies: site_members(
        where: {
          user_id: { _in: $ids }
          member_roles: { _contains: ["deputy_manager"] }
          site: { deleted_at: { _is_null: true }, status: { _eq: "active" } }
        }
      ) { user_id }
    }`,
    { ids },
  );
  for (const d of data.deputies) {
    if (d.user_id) out[d.user_id] = "deputy";
  }
  for (const s of data.primaries) {
    if (s.manager_id) out[s.manager_id] = "primary";
  }
  return out;
}

export async function createUser(payload: Record<string, unknown>): Promise<UserInfo> {
  const flags = await viewerStaffFlags();
  const accountRole = parseRequestedAccountRole(payload.accountRole ?? payload.accountKind);
  assertCreatableRoles({
    viewerRole: flags.me.role as UserRole,
    viewerAccountRole: sessionAccountRole(flags.me),
    accountRole,
  });
  if (!canAssignAccountRole(sessionAccountRole(flags.me), accountRole)) {
    throw new Error("仅超级管理员可指定管理员或超级管理员身份");
  }
  const { data } = await request.post<ApiResponse<UserInfo>>(
    "/staffing/accounts",
    {
      username: payload.username,
      password: payload.password,
      realName: payload.realName ?? payload.real_name,
      phone: payload.phone,
      employeeNo: payload.employeeNo ?? payload.employee_no,
      accountRole,
    },
    { skipErrorToast: true },
  );
  return mapUser(data.data as unknown as Record<string, unknown>);
}

export async function updateUser(id: string, payload: Record<string, unknown>): Promise<UserInfo> {
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  if (id !== me.id) await assertCanManageAccount(id);
  if (payload.roles !== undefined) {
    throw new Error("网格任职请到「网格管理 → 人员」调整，此处不能改");
  }
  const body: Record<string, unknown> = {
    realName: payload.realName ?? payload.real_name,
    phone: payload.phone,
    employeeNo: payload.employeeNo ?? payload.employee_no,
  };
  if (payload.accountRole != null) {
    const accountRole = parseRequestedAccountRole(payload.accountRole);
    if (!canAssignAccountRole(sessionAccountRole(me), accountRole)) {
      throw new Error("仅超级管理员可调整账号身份");
    }
    body.accountRole = accountRole;
  }
  const { data } = await request.put<ApiResponse<UserInfo>>(
    `/staffing/accounts/${id}`,
    body,
    { skipErrorToast: true },
  );
  return mapUser(data.data as unknown as Record<string, unknown>);
}

export async function updateUserStatus(id: string, status: CommonStatus) {
  await assertCanManageAccount(id);
  const { data } = await request.put<ApiResponse<UserInfo>>(
    `/staffing/accounts/${id}/status`,
    { status },
    { skipErrorToast: true },
  );
  return mapUser(data.data as unknown as Record<string, unknown>);
}

export async function resetUserPassword(id: string, newPassword: string) {
  await assertCanManageAccount(id);
  const { data } = await request.put<ApiResponse<UserInfo>>(
    `/staffing/accounts/${id}/password`,
    { newPassword },
    { skipErrorToast: true },
  );
  return mapUser(data.data as unknown as Record<string, unknown>);
}

export async function enableMyInspector() {
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  const data = await gql<{ users_by_pk: Record<string, unknown> }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { ${USER_FIELDS} } }`,
    { id: me.id },
  );
  return mapUser(data.users_by_pk);
}

export async function fetchInspectorPool(params: { keyword?: string; page?: number; limit?: number }) {
  return fetchUsers({ ...params, role: "inspector" });
}
