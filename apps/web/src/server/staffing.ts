import bcrypt from "bcryptjs";
import { adminGql } from "@/lib/hasura-admin";
import { loginRolesFromDuties } from "@/lib/account";
import { pickDefaultRole, type AppRole } from "@/lib/jwt";
import {
  dutyFlagsOf,
  legacyMemberRole,
  normalizeDuties,
  type SiteDuty,
  type SiteDutyFlags,
} from "@/lib/site-duties";
import { HttpError, type AppUser } from "./http";

export type StaffUser = {
  id: string;
  username: string;
  realName: string;
  employeeNo: string | null;
  phone: string;
  role: AppRole;
  roles: AppRole[];
  status: string;
  createdBy: string | null;
  createdAt?: string;
  duties: SiteDutyFlags;
};

export type StaffMember = {
  id: string;
  siteId: string;
  userId: string;
  roles: SiteDuty[];
  memberRole: SiteDuty;
  status: string;
  joinedAt: string;
  user: {
    id: string;
    username: string;
    realName: string;
    phone: string;
    role: string;
    status: string;
    avatar?: string;
  } | null;
};

type UserRow = {
  id: string;
  username: string;
  real_name: string;
  employee_no?: string | null;
  phone: string;
  role: string;
  status: string;
  created_by_id?: string | null;
  created_at?: string;
  avatar?: string | null;
};

type MemberRow = {
  id: string;
  site_id: string;
  user_id: string;
  member_roles: string[] | null;
  status: string;
  joined_at?: string;
  user?: UserRow | null;
};

type SiteRow = {
  id: string;
  name: string;
  manager_id: string | null;
  status: string;
  deleted_at?: string | null;
  manager?: {
    id: string;
    username: string;
    real_name: string;
    phone: string;
  } | null;
};

const USER_FIELDS =
  "id username real_name employee_no phone role status created_by_id created_at avatar";

function mapUser(row: UserRow, duties?: SiteDutyFlags): StaffUser {
  const flags = duties || { primary: false, deputy: false, inspector: false };
  const roles = loginRolesFromDuties(row.role, [
    ...(flags.primary ? (["primary_manager"] as const) : []),
    ...(flags.deputy ? (["deputy_manager"] as const) : []),
    ...(flags.inspector ? (["inspector"] as const) : []),
  ]);
  return {
    id: row.id,
    username: row.username,
    realName: row.real_name,
    employeeNo: row.employee_no ?? null,
    phone: row.phone,
    role: pickDefaultRole(roles, "inspector"),
    roles,
    status: row.status,
    createdBy: row.created_by_id ?? null,
    createdAt: row.created_at,
    duties: flags,
  };
}

function mapMember(row: MemberRow): StaffMember {
  const roles = normalizeDuties(row.member_roles);
  const u = row.user;
  return {
    id: row.id,
    siteId: row.site_id,
    userId: row.user_id,
    roles,
    memberRole: legacyMemberRole(roles),
    status: row.status,
    joinedAt: row.joined_at || "",
    user: u
      ? {
          id: u.id,
          username: u.username,
          realName: u.real_name,
          phone: u.phone,
          role: u.role,
          status: u.status,
          avatar: u.avatar || undefined,
        }
      : null,
  };
}

function isAdmin(user: AppUser) {
  return user.role === "super_admin" || user.roles.includes("super_admin");
}

function isStaffViewer(user: AppUser) {
  return isAdmin(user) || user.role === "site_manager" || user.roles.includes("site_manager");
}

async function loadSite(siteId: string): Promise<SiteRow> {
  const d = await adminGql<{ sites_by_pk: SiteRow | null }>(
    `query ($id: uuid!) {
      sites_by_pk(id: $id) {
        id name manager_id status deleted_at
        manager { id username real_name phone }
      }
    }`,
    { id: siteId },
  );
  if (!d.sites_by_pk || d.sites_by_pk.deleted_at) throw new HttpError(404, "网格不存在");
  return d.sites_by_pk;
}

async function loadMembers(siteId: string): Promise<StaffMember[]> {
  const d = await adminGql<{ site_members: MemberRow[] }>(
    `query ($sid: uuid!) {
      site_members(where: { site_id: { _eq: $sid } }, order_by: { joined_at: asc }) {
        id site_id user_id member_roles status joined_at
        user { ${USER_FIELDS} }
      }
    }`,
    { sid: siteId },
  );
  return d.site_members.map(mapMember);
}

async function viewerFlags(user: AppUser, siteId: string) {
  if (isAdmin(user)) {
    return { isAdmin: true, isPrimary: false, isDeputy: false };
  }
  const d = await adminGql<{
    sites_by_pk: { manager_id: string | null } | null;
    site_members: Array<{ member_roles: string[] | null }>;
  }>(
    `query ($sid: uuid!, $uid: uuid!) {
      sites_by_pk(id: $sid) { manager_id }
      site_members(where: { site_id: { _eq: $sid }, user_id: { _eq: $uid } }) { member_roles }
    }`,
    { sid: siteId, uid: user.id },
  );
  const roles = normalizeDuties(d.site_members[0]?.member_roles);
  return {
    isAdmin: false,
    isPrimary: d.sites_by_pk?.manager_id === user.id || roles.includes("primary_manager"),
    isDeputy: roles.includes("deputy_manager"),
  };
}

function assertCanViewStaff(user: AppUser, flags: Awaited<ReturnType<typeof viewerFlags>>) {
  if (flags.isAdmin || flags.isPrimary || flags.isDeputy) return;
  if (isStaffViewer(user)) return;
  throw new HttpError(403, "无权查看本网格编制");
}

function assertRoleChange(
  flags: Awaited<ReturnType<typeof viewerFlags>>,
  current: SiteDuty[],
  next: SiteDuty[],
) {
  const cur = new Set(current);
  const nxt = new Set(next);
  const added = next.filter((r) => !cur.has(r));
  const removed = current.filter((r) => !nxt.has(r));
  const changed = [...added, ...removed];

  if (changed.includes("primary_manager") && !flags.isAdmin) {
    throw new HttpError(403, "仅管理员可任命或撤下正网格长");
  }
  if (changed.includes("deputy_manager") && !(flags.isAdmin || flags.isPrimary)) {
    throw new HttpError(403, "仅正网格长或管理员可设置副网格长");
  }
  if (changed.includes("inspector") && !(flags.isAdmin || flags.isPrimary || flags.isDeputy)) {
    throw new HttpError(403, "无权调整工程师任职");
  }
  if (!next.length) {
    if (cur.has("primary_manager") && !flags.isAdmin) {
      throw new HttpError(403, "仅管理员可撤下正网格长");
    }
    if (cur.has("deputy_manager") && !(flags.isAdmin || flags.isPrimary)) {
      throw new HttpError(403, "仅正网格长或管理员可移除副网格长");
    }
    if (!flags.isAdmin && !flags.isPrimary && !flags.isDeputy) {
      throw new HttpError(403, "无权移出本网格人员");
    }
  }
}

async function syncSitePrimaryCache(siteId: string) {
  const members = await loadMembers(siteId);
  const primary = members.find((m) => m.roles.includes("primary_manager"));
  await adminGql(
    `mutation ($id: uuid!, $mid: uuid) {
      update_sites_by_pk(pk_columns: { id: $id }, _set: { manager_id: $mid }) { id manager_id }
    }`,
    { id: siteId, mid: primary?.userId ?? null },
  );
  return loadSite(siteId);
}

async function writeMember(siteId: string, userId: string, roles: SiteDuty[]) {
  if (!roles.length) {
    await deleteMember(siteId, userId);
    return;
  }
  await adminGql(
    `mutation ($obj: site_members_insert_input!) {
      insert_site_members_one(
        object: $obj
        on_conflict: {
          constraint: site_members_site_id_user_id_key
          update_columns: [member_roles, status]
        }
      ) { id }
    }`,
    {
      obj: {
        site_id: siteId,
        user_id: userId,
        member_roles: roles,
        status: "active",
      },
    },
  );
}

async function deleteMember(siteId: string, userId: string) {
  await adminGql(
    `mutation ($sid: uuid!, $uid: uuid!) {
      delete_site_members(where: { site_id: { _eq: $sid }, user_id: { _eq: $uid } }) { affected_rows }
    }`,
    { sid: siteId, uid: userId },
  );
}

export async function listPlatformAccounts(
  user: AppUser,
  query: { keyword?: string; page?: number; limit?: number },
) {
  if (!isStaffViewer(user) && !isAdmin(user)) throw new HttpError(403, "无权查看平台账号");
  const page = Math.max(1, query.page || 1);
  const limit = Math.min(500, Math.max(1, query.limit || 50));
  const and: Record<string, unknown>[] = [
    { role: { _neq: "super_admin" } },
  ];
  const kw = query.keyword?.trim();
  if (kw) {
    and.push({
      _or: [
        { username: { _ilike: `%${kw}%` } },
        { real_name: { _ilike: `%${kw}%` } },
        { phone: { _ilike: `%${kw}%` } },
        { employee_no: { _ilike: `%${kw}%` } },
      ],
    });
  }
  const where = { _and: and };
  const d = await adminGql<{
    users: UserRow[];
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
  const ids = d.users.map((u) => u.id);
  const dutyByUser = new Map<string, Set<SiteDuty>>();
  if (ids.length) {
    const mem = await adminGql<{
      site_members: Array<{ user_id: string; member_roles: string[] | null }>;
    }>(
      `query ($ids: [uuid!]!) {
        site_members(
          where: {
            user_id: { _in: $ids }
            status: { _eq: "active" }
            site: { deleted_at: { _is_null: true }, status: { _eq: "active" } }
          }
        ) { user_id member_roles }
      }`,
      { ids },
    );
    for (const m of mem.site_members) {
      const set = dutyByUser.get(m.user_id) || new Set<SiteDuty>();
      for (const r of normalizeDuties(m.member_roles)) set.add(r);
      dutyByUser.set(m.user_id, set);
    }
  }
  return {
    list: d.users.map((u) => mapUser(u, dutyFlagsOf(dutyByUser.get(u.id) || []))),
    total: d.users_aggregate.aggregate.count,
    page,
    limit,
  };
}

export async function createPlatformAccount(
  user: AppUser,
  body: Record<string, unknown>,
): Promise<StaffUser> {
  if (!isAdmin(user)) throw new HttpError(403, "仅管理员可开设平台账号");
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const realName = String(body.realName || body.real_name || "").trim();
  const phone = String(body.phone || "").trim();
  const employeeNo = String(body.employeeNo || body.employee_no || "").trim();
  if (!username) throw new HttpError(400, "请输入用户名");
  if (password.length < 6) throw new HttpError(400, "密码至少 6 位");
  if (!realName) throw new HttpError(400, "请输入姓名");
  if (!/^1\d{10}$/.test(phone)) throw new HttpError(400, "手机号格式不正确");
  if (employeeNo.length < 2 || employeeNo.length > 32) throw new HttpError(400, "工号 2-32 位");
  const taken = await adminGql<{
    by_name: Array<{ username: string }>;
    by_no: Array<{ employee_no: string | null }>;
  }>(
    `query ($username: String!, $eno: String!) {
      by_name: users(where: { username: { _eq: $username } }, limit: 1) { username }
      by_no: users(where: { employee_no: { _eq: $eno } }, limit: 1) { employee_no }
    }`,
    { username, eno: employeeNo },
  );
  if (taken.by_name.length) {
    throw new HttpError(400, `用户名「${username}」已被使用，请换一个`);
  }
  if (taken.by_no.length) {
    throw new HttpError(400, `工号「${employeeNo}」已被使用，请换一个`);
  }
  const hash = await bcrypt.hash(password, 10);
  try {
    const d = await adminGql<{ insert_users_one: UserRow }>(
      `mutation ($obj: users_insert_input!) {
        insert_users_one(object: $obj) { ${USER_FIELDS} }
      }`,
      {
        obj: {
          username,
          password: hash,
          real_name: realName,
          phone,
          employee_no: employeeNo,
          role: "user",
          created_by_id: user.id,
        },
      },
    );
    return mapUser(d.insert_users_one);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (/username/i.test(raw)) throw new HttpError(400, `用户名「${username}」已被使用，请换一个`);
    if (/employee_no/i.test(raw)) throw new HttpError(400, `工号「${employeeNo}」已被使用，请换一个`);
    throw error;
  }
}

export async function listSiteStaff(user: AppUser, siteId: string) {
  if (!siteId) throw new HttpError(400, "缺少网格");
  const site = await loadSite(siteId);
  const flags = await viewerFlags(user, siteId);
  assertCanViewStaff(user, flags);
  const members = await loadMembers(siteId);
  return {
    site: {
      id: site.id,
      name: site.name,
      managerId: site.manager_id,
      manager: site.manager
        ? {
            id: site.manager.id,
            username: site.manager.username,
            realName: site.manager.real_name,
            phone: site.manager.phone,
          }
        : null,
    },
    members,
    viewer: flags,
  };
}

export async function upsertSiteStaff(
  user: AppUser,
  siteId: string,
  targetUserId: string,
  rawRoles: unknown,
) {
  if (!siteId || !targetUserId) throw new HttpError(400, "缺少网格或人员");
  const next = normalizeDuties(rawRoles);
  if (next.includes("primary_manager") && next.includes("deputy_manager")) {
    throw new HttpError(400, "同一网格正网格长与副网格长不能由同一人兼任");
  }
  await loadSite(siteId);
  const flags = await viewerFlags(user, siteId);
  const members = await loadMembers(siteId);
  const current = members.find((m) => m.userId === targetUserId)?.roles || [];
  assertRoleChange(flags, current, next);

  if (next.includes("primary_manager")) {
    for (const m of members) {
      if (m.userId === targetUserId || !m.roles.includes("primary_manager")) continue;
      const remain = m.roles.filter((r) => r !== "primary_manager");
      if (remain.length) await writeMember(siteId, m.userId, remain);
      else await deleteMember(siteId, m.userId);
    }
  }

  if (!next.length) await deleteMember(siteId, targetUserId);
  else await writeMember(siteId, targetUserId, next);

  const site = await syncSitePrimaryCache(siteId);

  return {
    site: {
      id: site.id,
      name: site.name,
      managerId: site.manager_id,
      manager: site.manager
        ? {
            id: site.manager.id,
            username: site.manager.username,
            realName: site.manager.real_name,
            phone: site.manager.phone,
          }
        : null,
    },
    members: await loadMembers(siteId),
  };
}

export async function appointPrimary(user: AppUser, siteId: string, userId: string) {
  if (!isAdmin(user)) throw new HttpError(403, "仅管理员可任命正网格长");
  const members = await loadMembers(siteId);
  const current = members.find((m) => m.userId === userId)?.roles || [];
  const next = [...new Set<SiteDuty>([...current.filter((r) => r !== "deputy_manager"), "primary_manager"])];
  return upsertSiteStaff(user, siteId, userId, next);
}

