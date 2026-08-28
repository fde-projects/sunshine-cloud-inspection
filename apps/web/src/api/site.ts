import { gql } from "@/lib/gql";
import type { Paginated, SiteItem } from "@/types";

export interface SiteQuery {
  province?: string;
  city?: string;
  managerId?: string;
  status?: string;
  keyword?: string;
  page?: number;
  limit?: number;
}

export type SiteMemberRole = "deputy_manager" | "inspector";

export interface SiteMemberItem {
  id: string;
  siteId: string;
  userId: string;
  memberRole: SiteMemberRole;
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

/** 当前用户可编制人员的电站：正网格长（manager_id）或副网格长（site_members.deputy_manager） */
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
          member_role: { _eq: "deputy_manager" }
          status: { _eq: "active" }
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
  if (params.keyword) {
    where._or = [
      { name: { _ilike: `%${params.keyword}%` } },
      { code: { _ilike: `%${params.keyword}%` } },
    ];
  }
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

export async function appointManager(id: string, userId: string) {
  return updateSite(id, { managerId: userId });
}

export async function fetchSiteMembers(id: string, memberRole?: SiteMemberRole): Promise<SiteMemberItem[]> {
  const where: Record<string, unknown> = { site_id: { _eq: id } };
  if (memberRole) where.member_role = { _eq: memberRole };
  const data = await gql<{ site_members: Record<string, unknown>[] }>(
    `query ($where: site_members_bool_exp!) {
      site_members(where: $where) {
        id site_id user_id member_role status joined_at
        user { id username real_name phone role status avatar }
      }
    }`,
    { where },
  );
  return data.site_members.map((m) => {
    const u = m.user as Record<string, unknown> | null;
    return {
      id: String(m.id),
      siteId: String(m.site_id),
      userId: String(m.user_id),
      memberRole: m.member_role as SiteMemberRole,
      status: String(m.status),
      joinedAt: String(m.joined_at),
      user: u
        ? {
            id: String(u.id),
            username: String(u.username),
            realName: String(u.real_name),
            phone: String(u.phone),
            role: String(u.role),
            status: String(u.status),
            avatar: u.avatar as string | undefined,
          }
        : null,
    };
  });
}

export async function addSiteMember(siteId: string, userId: string, memberRole: SiteMemberRole = "inspector") {
  const data = await gql<{ insert_site_members_one: { id: string } }>(
    `mutation ($obj: site_members_insert_input!) {
      insert_site_members_one(object: $obj) { id }
    }`,
    { obj: { site_id: siteId, user_id: userId, member_role: memberRole } },
  );
  return data.insert_site_members_one;
}

export async function removeSiteMember(siteId: string, userId: string) {
  await gql(
    `mutation ($siteId: uuid!, $userId: uuid!) {
      delete_site_members(where: { site_id: { _eq: $siteId }, user_id: { _eq: $userId } }) { affected_rows }
    }`,
    { siteId, userId },
  );
  return { success: true };
}

export async function appointDeputy(id: string, userId: string) {
  return addSiteMember(id, userId, "deputy_manager");
}

export async function removeDeputy(id: string, userId: string) {
  return removeSiteMember(id, userId);
}
