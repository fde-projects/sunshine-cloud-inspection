import { gql } from "@/lib/gql";
import { getToken, getStoredUser } from "@/lib/session";
import {
  assertCreatableRoles,
  type StaffingAppointment,
} from "@/lib/staffing-roles";
import type { CommonStatus, Paginated, UserInfo, UserRole } from "@/types";

export interface UserQuery {
  role?: UserRole;
  status?: CommonStatus;
  keyword?: string;
  page?: number;
  limit?: number;
}

const ROLE_RANK: UserRole[] = ["super_admin", "site_manager", "inspector"];

const USER_FIELDS = `
  id username real_name employee_no phone email avatar role roles status region org_unit created_by_id created_at
`;

function asRoles(value: unknown, fallback?: UserRole): UserRole[] {
  const list = Array.isArray(value) ? (value.filter(Boolean) as UserRole[]) : [];
  if (list.length) return [...new Set(list)];
  return fallback ? [fallback] : [];
}

function primaryRole(roles: UserRole[], fallback: UserRole = "inspector"): UserRole {
  for (const role of ROLE_RANK) {
    if (roles.includes(role)) return role;
  }
  return fallback;
}

function mapUser(r: Record<string, unknown>): UserInfo {
  const roles = asRoles(r.roles, r.role as UserRole);
  return {
    id: String(r.id),
    username: String(r.username),
    realName: String(r.real_name ?? r.realName ?? ""),
    employeeNo: (r.employee_no as string) ?? null,
    phone: String(r.phone ?? ""),
    email: r.email as string | undefined,
    avatar: r.avatar as string | undefined,
    role: primaryRole(roles, (r.role as UserRole) || "inspector"),
    roles,
    status: String(r.status ?? "active"),
    region: r.region as string | undefined,
    orgUnit: (r.org_unit as string) ?? undefined,
    createdBy: (r.created_by_id as string) ?? null,
    createdAt: r.created_at as string | undefined,
  };
}

function hasRoleWhere(role: UserRole) {
  return {
    _or: [{ role: { _eq: role } }, { roles: { _contains: [role] } }],
  };
}

function notRoleWhere(role: UserRole) {
  return { _not: hasRoleWhere(role) };
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

/** 所管网格上的编制创建人：自己、各网格正网格长、各网格副网格长 */
async function getStaffingCreatorIds(userId: string): Promise<string[]> {
  const data = await gql<{
    as_manager: Array<{ id: string; manager_id: string | null }>;
    as_deputy: Array<{ site_id: string }>;
  }>(
    `query ($uid: uuid!) {
      as_manager: sites(
        where: { manager_id: { _eq: $uid }, deleted_at: { _is_null: true } }
      ) { id manager_id }
      as_deputy: site_members(
        where: {
          user_id: { _eq: $uid }
          status: { _eq: "active" }
          member_role: { _eq: "deputy_manager" }
        }
      ) { site_id }
    }`,
    { uid: userId },
  );
  const siteIds = [
    ...new Set([...data.as_manager.map((s) => s.id), ...data.as_deputy.map((d) => d.site_id)]),
  ];
  if (!siteIds.length) return [];
  const more = await gql<{
    sites: Array<{ manager_id: string | null }>;
    deputies: Array<{ user_id: string }>;
  }>(
    `query ($ids: [uuid!]!) {
      sites(where: { id: { _in: $ids }, deleted_at: { _is_null: true } }) { manager_id }
      deputies: site_members(
        where: {
          site_id: { _in: $ids }
          status: { _eq: "active" }
          member_role: { _eq: "deputy_manager" }
        }
      ) { user_id }
    }`,
    { ids: siteIds },
  );
  const ids = new Set<string>([userId]);
  for (const s of more.sites) {
    if (s.manager_id) ids.add(s.manager_id);
  }
  for (const d of more.deputies) ids.add(d.user_id);
  return [...ids];
}

async function fetchSelfUser(id: string): Promise<UserInfo | null> {
  const data = await gql<{ users_by_pk: Record<string, unknown> | null }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { ${USER_FIELDS} } }`,
    { id },
  );
  return data.users_by_pk ? mapUser(data.users_by_pk) : null;
}

function selfMatchesQuery(self: UserInfo, params: UserQuery) {
  const roles = self.roles?.length ? self.roles : self.role ? [self.role] : [];
  if (params.role === "site_manager" && !roles.includes("site_manager") && self.role !== "site_manager") {
    return false;
  }
  if (params.role === "inspector" && !roles.includes("inspector") && self.role !== "inspector") {
    return false;
  }
  if (params.status && self.status !== params.status) return false;
  const kw = params.keyword?.trim();
  if (kw) {
    const blob = `${self.username}${self.realName}${self.phone}${self.employeeNo || ""}`;
    if (!blob.includes(kw)) return false;
  }
  return true;
}

async function injectSelfOnFirstPage(
  result: Paginated<UserInfo>,
  params: UserQuery,
  selfId: string,
): Promise<Paginated<UserInfo>> {
  if ((params.page || 1) !== 1) return result;
  if (result.list.some((u) => u.id === selfId)) return result;
  const self = await fetchSelfUser(selfId);
  if (!self || !selfMatchesQuery(self, params)) return result;
  return {
    ...result,
    list: [self, ...result.list],
    total: result.total + 1,
  };
}

/**
 * 用户管理编制列表（对齐原版）：
 * 超管只看自己设立的正网格长；网格长只看本网格编制池，首页带上本人。
 */
export async function fetchStaffingUsers(params: UserQuery): Promise<Paginated<UserInfo>> {
  const { getStoredUser } = await import("@/lib/session");
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  const page = params.page || 1;
  const limit = params.limit || 10;
  const viewerRole = me.role;

  if (viewerRole === "super_admin") {
    if (params.role && params.role !== "site_manager") {
      return { list: [], total: 0, page, limit };
    }
    const and: Record<string, unknown>[] = [
      { created_by_id: { _eq: me.id } },
      hasRoleWhere("site_manager"),
      notRoleWhere("super_admin"),
    ];
    if (params.status) and.push({ status: { _eq: params.status } });
    if (params.keyword) and.push(keywordWhere(params.keyword));
    return queryUsers({ _and: and }, page, limit);
  }

  if (viewerRole !== "site_manager") {
    throw new Error("无权查看用户列表");
  }

  const creatorIds = await getStaffingCreatorIds(me.id);
  if (!creatorIds.length) {
    return injectSelfOnFirstPage({ list: [], total: 0, page, limit }, params, me.id);
  }
  const and: Record<string, unknown>[] = [{ created_by_id: { _in: creatorIds } }];
  if (params.role === "inspector" || params.role === "site_manager") {
    and.push(hasRoleWhere(params.role));
  } else if (params.role) {
    return injectSelfOnFirstPage({ list: [], total: 0, page, limit }, params, me.id);
  }
  if (params.status) and.push({ status: { _eq: params.status } });
  if (params.keyword) and.push(keywordWhere(params.keyword));
  const result = await queryUsers({ _and: and }, page, limit);
  return injectSelfOnFirstPage(result, params, me.id);
}

async function hashPassword(password: string) {
  const res = await fetch("/api/auth/hash", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getToken() || ""}`,
    },
    body: JSON.stringify({ password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message || "密码处理失败");
  return json.hash as string;
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
export async function assertCanManageAccount(targetId: string) {
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  if (targetId === me.id) return;
  if (me.role === "super_admin") {
    const data = await gql<{
      users_by_pk: { created_by_id: string | null; role: string; roles: UserRole[] } | null;
    }>(`query ($id: uuid!) { users_by_pk(id: $id) { created_by_id role roles } }`, { id: targetId });
    const row = data.users_by_pk;
    if (!row) throw new Error("账号不存在");
    if (row.created_by_id !== me.id) throw new Error("只能管理自己创建的网格长账号");
    const roles = asRoles(row.roles, row.role as UserRole);
    if (roles.includes("super_admin")) throw new Error("不能管理超级管理员");
    return;
  }
  if (me.role !== "site_manager") throw new Error("无权管理该账号");
  const creatorIds = await getStaffingCreatorIds(me.id);
  if (!creatorIds.length) throw new Error("请先被任命后再管理账号");
  const data = await gql<{ users_by_pk: { created_by_id: string | null } | null }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { created_by_id } }`,
    { id: targetId },
  );
  const createdBy = data.users_by_pk?.created_by_id;
  if (!createdBy || !creatorIds.includes(createdBy)) {
    throw new Error("只能管理本网格编制池内的账号");
  }
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
          member_role: { _eq: "deputy_manager" }
          status: { _eq: "active" }
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
  const roles = assertCreatableRoles({
    viewerRole: flags.me.role as UserRole,
    viewerIsPrimary: flags.viewerIsPrimary,
    viewerIsDeputyOnly: flags.viewerIsDeputyOnly,
    roles: asRoles(payload.roles, (payload.role as UserRole) || "inspector"),
  });
  const password = payload.password ? await hashPassword(String(payload.password)) : undefined;
  const role = primaryRole(roles, (payload.role as UserRole) || "inspector");
  const obj = {
    username: payload.username,
    password,
    real_name: payload.realName ?? payload.real_name,
    phone: payload.phone,
    employee_no: payload.employeeNo ?? payload.employee_no ?? null,
    role,
    roles,
    org_unit: payload.orgUnit ?? payload.org_unit ?? null,
    created_by_id: payload.createdBy ?? payload.created_by_id ?? flags.me.id ?? null,
  };
  const data = await gql<{ insert_users_one: Record<string, unknown> }>(
    `mutation ($obj: users_insert_input!) {
      insert_users_one(object: $obj) { ${USER_FIELDS} }
    }`,
    { obj },
  );
  return mapUser(data.insert_users_one);
}

export async function updateUser(id: string, payload: Record<string, unknown>): Promise<UserInfo> {
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  if (id !== me.id) await assertCanManageAccount(id);

  const set: Record<string, unknown> = {};
  if (payload.realName !== undefined) set.real_name = payload.realName;
  if (payload.phone !== undefined) set.phone = payload.phone;
  if (payload.employeeNo !== undefined) set.employee_no = payload.employeeNo;
  if (payload.role !== undefined || payload.roles !== undefined) {
    const nextRoles = asRoles(payload.roles, payload.role as UserRole);
    if (id === me.id) {
      if (me.role === "super_admin") {
        throw new Error("请勿在此修改超级管理员身份");
      }
      if (!nextRoles.includes("site_manager") && me.role === "site_manager") {
        throw new Error("不能去掉本账号的网格长登录身份");
      }
      if (nextRoles.some((r) => r !== "site_manager" && r !== "inspector")) {
        throw new Error("本账号只能保留网格长，并可开通工程师");
      }
    } else {
      const flags = await viewerStaffFlags();
      assertCreatableRoles({
        viewerRole: flags.me.role as UserRole,
        viewerIsPrimary: flags.viewerIsPrimary,
        viewerIsDeputyOnly: flags.viewerIsDeputyOnly,
        roles: nextRoles,
      });
    }
    set.roles = nextRoles;
    set.role = primaryRole(nextRoles, (payload.role as UserRole) || "inspector");
  }
  if (payload.status !== undefined) set.status = payload.status;
  if (payload.orgUnit !== undefined) set.org_unit = payload.orgUnit;
  const data = await gql<{ update_users_by_pk: Record<string, unknown> }>(
    `mutation ($id: uuid!, $set: users_set_input!) {
      update_users_by_pk(pk_columns: { id: $id }, _set: $set) { ${USER_FIELDS} }
    }`,
    { id, set },
  );
  return mapUser(data.update_users_by_pk);
}

export async function updateUserStatus(id: string, status: CommonStatus) {
  await assertCanManageAccount(id);
  return updateUser(id, { status });
}

export async function resetUserPassword(id: string, newPassword: string) {
  await assertCanManageAccount(id);
  const password = await hashPassword(newPassword);
  const data = await gql<{ update_users_by_pk: Record<string, unknown> }>(
    `mutation ($id: uuid!, $set: users_set_input!) {
      update_users_by_pk(pk_columns: { id: $id }, _set: $set) { ${USER_FIELDS} }
    }`,
    { id, set: { password } },
  );
  return mapUser(data.update_users_by_pk);
}

export async function enableMyInspector() {
  const { getStoredUser } = await import("@/lib/session");
  const me = getStoredUser();
  if (!me) throw new Error("未登录");
  const data = await gql<{ users_by_pk: Record<string, unknown> }>(
    `query ($id: uuid!) { users_by_pk(id: $id) { ${USER_FIELDS} } }`,
    { id: me.id },
  );
  const u = data.users_by_pk;
  const roles = Array.from(new Set([...((u.roles as UserRole[]) || []), "inspector" as UserRole]));
  return updateUser(String(u.id), { role: u.role as UserRole, roles });
}

export async function fetchInspectorPool(params: { keyword?: string; page?: number; limit?: number }) {
  return fetchUsers({ ...params, role: "inspector" });
}
