import { NextResponse } from "next/server";
import { HttpError, requireUser } from "@/server/http";
import { issueRoleSession, requireActiveRole } from "@/server/auth-login";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const user = await requireUser(req);
    const activeRole = requireActiveRole(body, user.roles);
    const session = await issueRoleSession({
      id: user.id,
      username: user.username,
      realName: user.realName,
      phone: user.phone,
      status: user.status,
      role: user.role,
      roles: user.roles,
      activeRole,
    });
    return NextResponse.json({
      token: session.token,
      user: session.user,
      needsRolePick: session.needsRolePick,
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ message: e.message, ...e.extra }, { status: e.status });
    }
    return NextResponse.json({ message: "切换失败" }, { status: 500 });
  }
}
