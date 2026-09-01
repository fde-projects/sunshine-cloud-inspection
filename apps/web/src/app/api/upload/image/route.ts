import { NextRequest, NextResponse } from "next/server";

const ALLOWED_HOST_RE =
  /(clouddn\.com|qiniucdn\.com|ctyunzos\.cn|\.qiniu\.com)$/i;

/** 对象存储直链代理：统一 inline，避免 attachment 导致后台预览裂图。 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("url") || "";
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ message: "无效图片地址" }, { status: 400 });
  }
  if (!/^https?:$/i.test(target.protocol)) {
    return NextResponse.json({ message: "仅支持 http/https" }, { status: 400 });
  }
  if (!ALLOWED_HOST_RE.test(target.hostname)) {
    return NextResponse.json({ message: "域名未允许代理" }, { status: 403 });
  }

  try {
    const upstream = await fetch(target.toString(), {
      headers: { Accept: "image/*,*/*" },
      cache: "force-cache",
    });
    if (!upstream.ok) {
      return NextResponse.json(
        { message: `拉取图片失败: ${upstream.status}` },
        { status: 502 },
      );
    }
    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    const buf = await upstream.arrayBuffer();
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": contentType.startsWith("image/")
          ? contentType
          : "image/jpeg",
        "Content-Disposition": "inline",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return NextResponse.json({ message: "图片代理失败" }, { status: 502 });
  }
}
