import { SignJWT, type JWTPayload } from "jose";
import type { AppRole } from "@/lib/types";

export type { AppRole };

export const HASURA_CLAIMS_NAMESPACE =
  process.env.HASURA_JWT_CLAIMS_NAMESPACE ?? "https://hasura.io/jwt/claims";

function getJwtSecret(): Uint8Array {
  const secret = process.env.HASURA_JWT_SECRET;
  if (!secret) throw new Error("HASURA_JWT_SECRET is not configured");
  return new TextEncoder().encode(secret);
}

const rank: AppRole[] = ["super_admin", "site_manager", "inspector"];

/** 仅用于写入用户表 role 列，登录身份由入口（pc/h5）决定。 */
export function pickDefaultRole(roles: AppRole[], fallback: AppRole): AppRole {
  for (const r of rank) {
    if (roles.includes(r) || r === fallback) {
      if (roles.includes(r)) return r;
    }
  }
  return fallback;
}

export function roleFromJwtPayload(payload: JWTPayload): AppRole | null {
  const claims = payload[HASURA_CLAIMS_NAMESPACE];
  if (!claims || typeof claims !== "object") return null;
  const role = (claims as Record<string, unknown>)["x-hasura-default-role"];
  if (role === "super_admin" || role === "site_manager" || role === "inspector") return role;
  return null;
}

/** Sign a Hasura-compatible user JWT (server-only). */
export async function signHasuraUserJwt(
  userId: string,
  roles: AppRole[],
  defaultRole: AppRole,
  expiresIn = "7d",
): Promise<string> {
  const secret = getJwtSecret();
  const allowed = roles.length ? roles : [defaultRole];
  const role = allowed.includes(defaultRole) ? defaultRole : allowed[0];

  return new SignJWT({
    [HASURA_CLAIMS_NAMESPACE]: {
      "x-hasura-default-role": role,
      "x-hasura-allowed-roles": allowed,
      "x-hasura-user-id": userId,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    // 签发时间向前回拨 60 秒：容忍应用服务器时钟略快于 Hasura 服务端，
    // 避免 JWTIssuedAtFuture 导致刚签发的 token 被拒绝
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
    .setExpirationTime(expiresIn)
    .sign(secret);
}
