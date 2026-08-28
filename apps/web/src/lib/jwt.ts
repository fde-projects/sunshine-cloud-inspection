import { SignJWT } from "jose";

export type AppRole = "super_admin" | "site_manager" | "inspector";

const claimsNamespace =
  process.env.HASURA_JWT_CLAIMS_NAMESPACE ?? "https://hasura.io/jwt/claims";

function getJwtSecret(): Uint8Array {
  const secret = process.env.HASURA_JWT_SECRET;
  if (!secret) throw new Error("HASURA_JWT_SECRET is not configured");
  return new TextEncoder().encode(secret);
}

const rank: AppRole[] = ["super_admin", "site_manager", "inspector"];

export function pickDefaultRole(roles: AppRole[], fallback: AppRole): AppRole {
  for (const r of rank) {
    if (roles.includes(r) || r === fallback) {
      if (roles.includes(r)) return r;
    }
  }
  return fallback;
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
    [claimsNamespace]: {
      "x-hasura-default-role": role,
      "x-hasura-allowed-roles": allowed,
      "x-hasura-user-id": userId,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}
