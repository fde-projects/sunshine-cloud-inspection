import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { jwtVerify } from "jose";

export async function POST(req: Request) {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = process.env.HASURA_JWT_SECRET;
  if (!token || !secret) {
    return NextResponse.json({ message: "未登录" }, { status: 401 });
  }
  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
  } catch {
    return NextResponse.json({ message: "未登录" }, { status: 401 });
  }
  const body = (await req.json()) as { password?: string };
  if (!body.password || body.password.length < 4) {
    return NextResponse.json({ message: "密码太短" }, { status: 400 });
  }
  const hash = await bcrypt.hash(body.password, 10);
  return NextResponse.json({ hash });
}
