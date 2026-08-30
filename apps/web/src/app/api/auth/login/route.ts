import { NextResponse } from "next/server";
import { HttpError } from "@/server/http";
import { loginWithPassword } from "@/server/auth-login";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    const session = await loginWithPassword(username, password, body.portal);
    return NextResponse.json({
      token: session.token,
      user: session.user,
      needsRolePick: session.needsRolePick,
    });
  } catch (e) {
    if (e instanceof HttpError) {
      return NextResponse.json({ message: e.message, ...e.extra }, { status: e.status });
    }
    return NextResponse.json({ message: "登录失败" }, { status: 500 });
  }
}
