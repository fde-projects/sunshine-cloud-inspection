import bcrypt from "bcryptjs";
import { loginRolesFromDuties } from "@/lib/account";
import { adminGql } from "@/lib/hasura-admin";
import { signHasuraUserJwt, type AppRole } from "@/lib/jwt";
import { parseRoleInput, roleForPortal } from "@/lib/portal";
import { HttpError } from "./http";

export type LoginRow = {
  id: string;
  username: string;
  password: string;
  real_name: string;
  phone: string;
  role: string;
  status: string;
};

export type AuthSession = {
  token: string;
  needsRolePick: boolean;
  user: {
    id: string;
    username: string;
    realName: string;
    phone: string;
    role: AppRole;
    roles: AppRole[];
    status: string;
  };
};

export function requireActiveRole(body: Record<string, unknown>, roles: AppRole[]): AppRole {
  const role = parseRoleInput(body.role ?? body.portal ?? body.client, roles);
  if (!role || !roles.includes(role)) {
    throw new HttpError(403, "该账号没有此身份", { code: "ROLE_DENIED" });
  }
  return role;
}

export async function issueRoleSession(input: {
  id: string;
  username: string;
  realName: string;
  phone: string;
  status: string;
  role: AppRole;
  roles: AppRole[] | null | undefined;
  activeRole: AppRole;
}): Promise<AuthSession> {
  const roles = input.roles?.length ? [...new Set(input.roles)] : [input.role];
  if (!roles.includes(input.activeRole)) {
    throw new HttpError(403, "该账号没有此身份", { code: "ROLE_DENIED" });
  }
  const token = await signHasuraUserJwt(input.id, roles, input.activeRole);
  return {
    token,
    needsRolePick: false,
    user: {
      id: input.id,
      username: input.username,
      realName: input.realName,
      phone: input.phone,
      role: input.activeRole,
      roles,
      status: input.status,
    },
  };
}

export async function loginWithPassword(
  username: string,
  password: string,
  portal?: unknown,
): Promise<AuthSession> {
  if (!username || !password) throw new HttpError(400, "请输入用户名和密码");
  const data = await adminGql<{
    users: LoginRow[];
  }>(
    `query ($username: String!) {
      users(where: { username: { _eq: $username } }, limit: 1) {
        id username password real_name phone role status
      }
    }`,
    { username },
  );
  const row = data.users[0];
  if (!row || row.status !== "active") throw new HttpError(401, "用户名或密码错误");
  const pass = await bcrypt.compare(password, row.password);
  if (!pass) throw new HttpError(401, "用户名或密码错误");
  const mem = await adminGql<{ site_members: Array<{ member_roles: string[] | null }> }>(
    `query ($uid: uuid!) {
      site_members(where: { user_id: { _eq: $uid }, status: { _eq: "active" } }) { member_roles }
    }`,
    { uid: row.id },
  );
  const roles = loginRolesFromDuties(
    row.role,
    mem.site_members.flatMap((m) => m.member_roles || []),
  );
  const hinted = portal != null && String(portal).trim() !== "" ? roleForPortal(portal, roles) : null;
  if (portal != null && String(portal).trim() !== "" && !hinted) {
    const v = String(portal).toLowerCase();
    if (v === "h5" || v === "m" || v === "mobile" || v === "inspector") {
      throw new HttpError(403, "此账号没有工程师身份，请从电脑管理后台登录");
    }
    throw new HttpError(403, "此账号没有管理端身份，请从手机作业端登录");
  }
  const activeRole = hinted || roles[0];
  return issueRoleSession({
    id: row.id,
    username: row.username,
    realName: row.real_name,
    phone: row.phone,
    status: row.status,
    role: roles[0],
    roles,
    activeRole,
  });
}
