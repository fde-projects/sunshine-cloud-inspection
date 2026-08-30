import { jwtVerify, type JWTPayload } from "jose";
import { NextResponse } from "next/server";
import { adminGql } from "@/lib/hasura-admin";
import { roleFromJwtPayload, type AppRole } from "@/lib/jwt";
import { normalizeRoles } from "@/lib/portal";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type AppUser = {
  id: string;
  username: string;
  realName: string;
  phone: string;
  email?: string | null;
  avatar?: string | null;
  role: AppRole;
  roles: AppRole[];
  status: string;
  region?: string | null;
  orgUnit?: string | null;
  managedSiteIds: string[];
};

export function ok<T>(data: T, status = 200) {
  return NextResponse.json({ code: 200, message: "success", data }, { status });
}

export function fail(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ code: status, message, data: null, ...extra }, { status });
}

export async function requireUser(req: Request): Promise<AppUser> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = process.env.HASURA_JWT_SECRET;
  if (!token || !secret) throw new HttpError(401, "未登录");
  let userId = "";
  let payload: JWTPayload | null = null;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(secret));
    payload = verified.payload;
    userId = typeof verified.payload.sub === "string" ? verified.payload.sub : "";
  } catch {
    throw new HttpError(401, "登录已过期");
  }
  if (!userId) throw new HttpError(401, "未登录");

  const data = await adminGql<{
    users_by_pk: {
      id: string;
      username: string;
      real_name: string;
      phone: string;
      email?: string | null;
      avatar?: string | null;
      role: AppRole;
      roles: AppRole[];
      status: string;
      region?: string | null;
      org_unit?: string | null;
    } | null;
    sites: { id: string }[];
    site_members: { site_id: string }[];
  }>(
    `query ($id: uuid!) {
      users_by_pk(id: $id) {
        id username real_name phone email avatar role roles status region org_unit
      }
      sites(where: { manager_id: { _eq: $id }, deleted_at: { _is_null: true } }) { id }
      site_members(where: { user_id: { _eq: $id }, status: { _eq: "active" } }) { site_id }
    }`,
    { id: userId },
  );
  const row = data.users_by_pk;
  if (!row || row.status !== "active") throw new HttpError(401, "账号不可用");
  const roles = normalizeRoles(row.roles, row.role);
  const jwtRole = payload ? roleFromJwtPayload(payload) : null;
  const role = jwtRole && roles.includes(jwtRole) ? jwtRole : row.role;
  const managed = new Set<string>([
    ...data.sites.map((s) => s.id),
    ...data.site_members.map((m) => m.site_id),
  ]);
  return {
    id: row.id,
    username: row.username,
    realName: row.real_name,
    phone: row.phone,
    email: row.email,
    avatar: row.avatar,
    role,
    roles,
    status: row.status,
    region: row.region,
    orgUnit: row.org_unit,
    managedSiteIds: [...managed],
  };
}

export async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) return {};
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function q(req: Request) {
  return new URL(req.url).searchParams;
}
