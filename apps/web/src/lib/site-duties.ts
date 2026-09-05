export const SITE_DUTIES = ["primary_manager", "deputy_manager", "inspector"] as const;
export type SiteDuty = (typeof SITE_DUTIES)[number];

export type SiteDutyFlags = {
  primary: boolean;
  deputy: boolean;
  inspector: boolean;
};

export function isSiteDuty(value: unknown): value is SiteDuty {
  return value === "primary_manager" || value === "deputy_manager" || value === "inspector";
}

export function normalizeDuties(raw: unknown): SiteDuty[] {
  const list = Array.isArray(raw) ? raw : [];
  return [...new Set(list.filter(isSiteDuty))];
}

export function dutiesOf(raw: unknown, fallback?: string | null): SiteDuty[] {
  const roles = normalizeDuties(raw);
  if (roles.length) return roles;
  return isSiteDuty(fallback) ? [fallback] : [];
}

export function dutyFlagsOf(roles: Iterable<string>): SiteDutyFlags {
  const set = new Set(roles);
  return {
    primary: set.has("primary_manager"),
    deputy: set.has("deputy_manager"),
    inspector: set.has("inspector"),
  };
}

export function legacyMemberRole(roles: SiteDuty[]): SiteDuty {
  if (roles.includes("deputy_manager")) return "deputy_manager";
  if (roles.includes("inspector")) return "inspector";
  return "primary_manager";
}

export function memberHasDuty(
  member: { roles?: string[] | null; memberRoles?: string[] | null; member_roles?: string[] | null },
  duty: SiteDuty,
): boolean {
  return Boolean(
    member.roles?.includes(duty) ||
      member.memberRoles?.includes(duty) ||
      member.member_roles?.includes(duty),
  );
}

/** Hasura text[]：member_roles @> '{duty}' */
export function hasuraDutyContains(duty: SiteDuty) {
  return { member_roles: { _contains: [duty] } };
}
