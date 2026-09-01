import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { jwtVerify } from "jose";

const CLAIMS_NS =
  process.env.HASURA_JWT_CLAIMS_NAMESPACE || "https://hasura.io/jwt/claims";

export async function POST(req: Request) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = process.env.HASURA_JWT_SECRET;
  if (!token || !secret) {
    return NextResponse.json({ message: "未登录" }, { status: 401 });
  }
  let role = "";
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    const claims = (payload as Record<string, unknown>)[CLAIMS_NS] as
      | { "x-hasura-default-role"?: string }
      | undefined;
    role = String(claims?.["x-hasura-default-role"] || "");
  } catch {
    return NextResponse.json({ message: "未登录" }, { status: 401 });
  }
  if (role !== "super_admin" && role !== "site_manager") {
    return NextResponse.json({ message: "无权处理密码哈希" }, { status: 403 });
  }
  const body = (await req.json()) as { password?: string };
  if (!body.password || body.password.length < 4) {
    return NextResponse.json({ message: "密码太短" }, { status: 400 });
  }
  const hash = await bcrypt.hash(body.password, 10);
  return NextResponse.json({ hash });
}
