import { NextResponse } from "next/server";
import { createUploadToken } from "@/lib/storage";
import { jwtVerify } from "jose";

async function userIdFromAuth(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = process.env.HASURA_JWT_SECRET;
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const userId = await userIdFromAuth(req);
  if (!userId) {
    return NextResponse.json({ message: "未登录" }, { status: 401 });
  }
  const body = (await req.json()) as { filename?: string; contentType?: string };
  try {
    const token = createUploadToken(body.filename || "photo.jpg", userId, {
      contentType: body.contentType || "image/jpeg",
    });
    return NextResponse.json(token);
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "上传凭证失败" },
      { status: 500 },
    );
  }
}
