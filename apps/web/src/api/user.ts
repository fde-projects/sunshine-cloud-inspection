import { gql } from "@/lib/gql";
import { getToken } from "@/lib/session";
import type { CommonStatus, Paginated, UserInfo, UserRole } from "@/types";

export interface UserQuery {
  role?: UserRole;
  status?: CommonStatus;
  keyword?: string;
  page?: number;
  limit?: number;
}

const ROLE_RANK: UserRole[] = ["super_admin", "site_manager", "inspector"];

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

const USER_FIELDS = `
  id username real_name employee_no phone email avatar role roles status region org_unit created_by_id created_at
`;

export async function fetchUsers(params: UserQuery): Promise<Paginated<UserInfo>> {
  const page = params.page || 1;
  const limit = params.limit || 10;
  const and: Record<string, unknown>[] = [];
  if (params.role) {
    and.push({
      _or: [{ role: { _eq: params.role } }, { roles: { _contains: [params.role] } }],
    });
  }
  if (params.status) and.push({ status: { _eq: params.status } });
  if (params.keyword) {
    and.push({
      _or: [
        { username: { _ilike: `%${params.keyword}%` } },
        { real_name: { _ilike: `%${params.keyword}%` } },
        { phone: { _ilike: `%${params.keyword}%` } },
      ],
    });
  }
  const where = and.length ? { _and: and } : {};
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

export async function createUser(payload: Record<string, unknown>): Promise<UserInfo> {
  const password = payload.password ? await hashPassword(String(payload.password)) : undefined;
  const roles = asRoles(payload.roles, (payload.role as UserRole) || "inspector");
  const role = primaryRole(roles, (payload.role as UserRole) || "inspector");
  const { getStoredUser } = await import("@/lib/session");
  const me = getStoredUser();
  const obj = {
    username: payload.username,
    password,
    real_name: payload.realName ?? payload.real_name,
    phone: payload.phone,
    employee_no: payload.employeeNo ?? payload.employee_no ?? null,
    role,
    roles,
    org_unit: payload.orgUnit ?? payload.org_unit ?? null,
    created_by_id: payload.createdBy ?? payload.created_by_id ?? me?.id ?? null,
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
  const set: Record<string, unknown> = {};
  if (payload.realName !== undefined) set.real_name = payload.realName;
  if (payload.phone !== undefined) set.phone = payload.phone;
  if (payload.employeeNo !== undefined) set.employee_no = payload.employeeNo;
  if (payload.role !== undefined || payload.roles !== undefined) {
    const roles = asRoles(payload.roles, payload.role as UserRole);
    set.roles = roles;
    set.role = primaryRole(roles, (payload.role as UserRole) || "inspector");
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
  return updateUser(id, { status });
}

export async function resetUserPassword(id: string, newPassword: string) {
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
