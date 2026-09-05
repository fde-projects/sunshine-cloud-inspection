import { gql } from "@/lib/gql";
import { dutiesOf, type SiteDuty } from "@/lib/site-duties";
import request from "@/utils/request";
import type { ApiResponse, Paginated, SiteItem } from "@/types";

export interface SiteQuery {
  province?: string;
  city?: string;
  managerId?: string;
  status?: string;
  keyword?: string;
  page?: number;
  limit?: number;
}

export type SiteMemberRole = SiteDuty;

export interface SiteMemberItem {
  id: string;
  siteId: string;
  userId: string;
  memberRole: SiteMemberRole;
  roles: SiteDuty[];
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
}

function mapSite(r: Record<string, unknown>): SiteItem {
  const manager = r.manager as Record<string, unknown> | null;
  return {
    id: String(r.id),
    name: String(r.name),
    code: String(r.code),
    province: String(r.province ?? ""),
    city: String(r.city ?? ""),
    district: String(r.district ?? ""),
    address: String(r.address ?? ""),
    latitude: Number(r.latitude ?? 0),
    longitude: Number(r.longitude ?? 0),
    inspectionRadiusMeters: Number(r.inspection_radius_meters ?? 500),
    managerId: (r.manager_id as string) ?? null,
    status: (r.status as SiteItem["status"]) || "active",
    createdAt: String(r.created_at ?? ""),
    manager: manager
      ? {
          id: String(manager.id),
          username: String(manager.username ?? ""),
          realName: String(manager.real_name ?? ""),
          phone: String(manager.phone ?? ""),
        }
      : null,
  };
}

const SITE_FIELDS = `
  id name code province city district address latitude longitude
  inspection_radius_meters manager_id status created_at
  manager { id username real_name phone }
`;

/** 当前用户可编制人员的电站：正网格长（manager_id）或副网格长 */
export async function fetchMyStaffSites(userId: string): Promise<{
  list: SiteItem[];
  isPrimary: boolean;
  isDeputy: boolean;
}> {
  const data = await gql<{
    as_manager: Record<string, unknown>[];
    as_deputy: Array<{ site: Record<string, unknown> | null }>;
  }>(
    `query ($uid: uuid!) {
      as_manager: sites(
        where: {
          manager_id: { _eq: $uid }
          deleted_at: { _is_null: true }
          status: { _eq: "active" }
        }
      ) { ${SITE_FIELDS} }
      as_deputy: site_members(
        where: {
          user_id: { _eq: $uid }
          member_roles: { _contains: ["deputy_manager"] }
          site: { deleted_at: { _is_null: true }, status: { _eq: "active" } }
        }
      ) {
        site { ${SITE_FIELDS} }
      }
    }`,
    { uid: userId },
  );
  const primary = data.as_manager.map(mapSite);
  const deputy = data.as_deputy
    .map((row) => (row.site ? mapSite(row.site) : null))
    .filter((site): site is SiteItem => Boolean(site));
  const byId = new Map<string, SiteItem>();
  for (const site of [...primary, ...deputy]) byId.set(site.id, site);
  return {
    list: [...byId.values()],
    isPrimary: primary.length > 0,
    isDeputy: deputy.length > 0,
  };
}

export async function fetchSites(params: SiteQuery = {}): Promise<Paginated<SiteItem>> {
  const page = params.page || 1;
  const limit = params.limit || 50;
  const where: Record<string, unknown> = { deleted_at: { _is_null: true } };
  const keyword = params.keyword?.trim();
  if (keyword) {
    where._or = [
      { name: { _ilike: `%${keyword}%` } },
      { code: { _ilike: `%${keyword}%` } },
      { province: { _ilike: `%${keyword}%` } },
      { city: { _ilike: `%${keyword}%` } },
      { district: { _ilike: `%${keyword}%` } },
      { address: { _ilike: `%${keyword}%` } },
    ];
  }
  const province = params.province?.trim();
  if (province) where.province = { _ilike: `%${province}%` };
  const city = params.city?.trim();
  if (city) where.city = { _ilike: `%${city}%` };
  if (params.status) where.status = { _eq: params.status };
  const data = await gql<{
    sites: Record<string, unknown>[];
    sites_aggregate: { aggregate: { count: number } };
  }>(
    `query ($where: sites_bool_exp!, $limit: Int!, $offset: Int!) {
      sites(where: $where, limit: $limit, offset: $offset, order_by: { created_at: desc }) {
        ${SITE_FIELDS}
      }
      sites_aggregate(where: $where) { aggregate { count } }
    }`,
    { where, limit, offset: (page - 1) * limit },
  );
  return {
    list: data.sites.map(mapSite),
    total: data.sites_aggregate.aggregate.count,
    page,
    limit,
  };
}

export async function isSiteCodeTaken(code: string, excludeId?: string): Promise<boolean> {
  const trimmed = String(code || "").trim();
  if (!trimmed) return false;
  const data = await gql<{ sites: { id: string }[] }>(
    `query ($code: String!) {
      sites(where: { code: { _eq: $code } }, limit: 2) { id }
    }`,
    { code: trimmed },
  );
  return data.sites.some((row) => row.id !== excludeId);
}

export async function createSite(payload: Record<string, unknown>): Promise<SiteItem> {
  const obj = {
    name: payload.name,
    code: payload.code,
    province: payload.province || "",
    city: payload.city || "",
    district: payload.district || "",
    address: payload.address || "",
    latitude: payload.latitude || 0,
    longitude: payload.longitude || 0,
    manager_id: payload.managerId ?? payload.manager_id ?? null,
  };
  const data = await gql<{ insert_sites_one: Record<string, unknown> }>(
    `mutation ($obj: sites_insert_input!) {
      insert_sites_one(object: $obj) { ${SITE_FIELDS} }
    }`,
    { obj },
  );
  return mapSite(data.insert_sites_one);
}

export async function updateSite(id: string, payload: Record<string, unknown>): Promise<SiteItem> {
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "managerId") set.manager_id = v;
    else if (k === "inspectionRadiusMeters") set.inspection_radius_meters = v;
    else set[k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)] = v;
  }
  const data = await gql<{ update_sites_by_pk: Record<string, unknown> }>(
    `mutation ($id: uuid!, $set: sites_set_input!) {
      update_sites_by_pk(pk_columns: { id: $id }, _set: $set) { ${SITE_FIELDS} }
    }`,
    { id, set },
  );
  return mapSite(data.update_sites_by_pk);
}

export async function deleteSite(id: string) {
  await gql(
    `mutation ($id: uuid!, $now: timestamptz!) {
      update_sites_by_pk(pk_columns: { id: $id }, _set: { deleted_at: $now }) { id }
    }`,
    { id, now: new Date().toISOString() },
  );
  return { success: true };
}

type StaffPayload = {
  site: SiteItem & { managerId: string | null };
  members: SiteMemberItem[];
};

function mapStaffMember(m: Record<string, unknown>): SiteMemberItem {
  const u = m.user as Record<string, unknown> | null;
  const roles = dutiesOf(m.roles, String(m.memberRole || m.member_role || ""));
  return {
    id: String(m.id),
    siteId: String(m.siteId || m.site_id),
    userId: String(m.userId || m.user_id),
    roles,
    memberRole: (m.memberRole || m.member_role || roles[0] || "inspector") as SiteMemberRole,
    status: String(m.status),
    joinedAt: String(m.joinedAt || m.joined_at || ""),
    user: u
      ? {
          id: String(u.id),
          username: String(u.username),
          realName: String(u.realName || u.real_name || ""),
          phone: String(u.phone || ""),
          role: String(u.role || ""),
          status: String(u.status || ""),
          avatar: (u.avatar as string | undefined) || undefined,
        }
      : null,
  };
}

export async function fetchSiteStaff(siteId: string) {
  const { data } = await request.get<ApiResponse<StaffPayload>>("/staffing/members", {
    params: { siteId },
  });
  return {
    site: data.data.site,
    members: (data.data.members || []).map((m) => mapStaffMember(m as unknown as Record<string, unknown>)),
  };
}

export async function upsertSiteStaff(siteId: string, userId: string, roles: SiteDuty[]) {
  const { data } = await request.put<ApiResponse<StaffPayload>>("/staffing/members", {
    siteId,
    userId,
    roles,
  });
  return {
    site: data.data.site,
    members: (data.data.members || []).map((m) => mapStaffMember(m as unknown as Record<string, unknown>)),
  };
}

export async function appointManager(id: string, userId: string) {
  const { data } = await request.post<ApiResponse<StaffPayload>>("/staffing/appoint-primary", {
    siteId: id,
    userId,
  });
  return data.data;
}

export async function fetchSiteMembers(id: string, memberRole?: SiteMemberRole): Promise<SiteMemberItem[]> {
  const { members } = await fetchSiteStaff(id);
  if (!memberRole) return members;
  return members.filter((m) => m.roles.includes(memberRole) || m.memberRole === memberRole);
}

export async function addSiteMember(siteId: string, userId: string, memberRole: SiteMemberRole = "inspector") {
  const { members } = await fetchSiteStaff(siteId);
  const current = members.find((m) => m.userId === userId)?.roles || [];
  const next = [...new Set<SiteDuty>([...current, memberRole])].filter((r) => {
    if (memberRole === "primary_manager") return r !== "deputy_manager";
    if (memberRole === "deputy_manager") return r !== "primary_manager";
    return true;
  });
  return upsertSiteStaff(siteId, userId, next);
}

export async function ensureSiteInspector(
  siteId: string,
  userId: string,
): Promise<"created" | "exists" | "skipped_deputy"> {
  const members = await fetchSiteMembers(siteId);
  const mine = members.find((m) => m.userId === userId && m.status === "active");
  if (mine?.roles.includes("inspector")) return "exists";
  await addSiteMember(siteId, userId, "inspector");
  return "created";
}

export async function syncPrimaryManagerInspector(
  siteId: string,
  managerUserId: string,
  hasInspectorRole: boolean,
) {
  if (!hasInspectorRole) return "skipped" as const;
  return ensureSiteInspector(siteId, managerUserId);
}

export async function removeSiteMember(siteId: string, userId: string) {
  await upsertSiteStaff(siteId, userId, []);
  return { success: true };
}

export async function appointDeputy(siteId: string, userId: string) {
  return addSiteMember(siteId, userId, "deputy_manager");
}

export async function removeDeputy(siteId: string, userId: string) {
  const { members } = await fetchSiteStaff(siteId);
  const current = members.find((m) => m.userId === userId)?.roles || [];
  return upsertSiteStaff(
    siteId,
    userId,
    current.filter((r) => r !== "deputy_manager"),
  );
}
