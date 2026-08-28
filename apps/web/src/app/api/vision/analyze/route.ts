import { NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { analyzePhotos } from "@/lib/vision";

async function requireUser(req: Request): Promise<boolean> {
  const header = req.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const secret = process.env.HASURA_JWT_SECRET;
  if (!token || !secret) return false;
  try {
    await jwtVerify(token, new TextEncoder().encode(secret));
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  if (!(await requireUser(req))) {
    return NextResponse.json({ message: "未登录" }, { status: 401 });
  }
  const body = (await req.json()) as {
    title?: string;
    description?: string;
    photoUrls?: string[];
  };
  const result = await analyzePhotos({
    title: body.title || "检查项",
    description: body.description || "",
    photoUrls: body.photoUrls || [],
  });
  return NextResponse.json(result);
}
