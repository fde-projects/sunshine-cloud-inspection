import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lng = Number(url.searchParams.get("longitude"));
  const lat = Number(url.searchParams.get("latitude"));
  const key = (process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_WEB_KEY || "").trim();
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return NextResponse.json({ message: "请提供有效坐标" }, { status: 400 });
  }
  if (!key) return NextResponse.json({ message: "未配置高德 Key" }, { status: 500 });
  const amap = await fetch(
    `https://restapi.amap.com/v3/geocode/regeo?key=${encodeURIComponent(key)}&location=${lng},${lat}`,
  );
  const data = await amap.json();
  const c = data?.regeocode?.addressComponent;
  if (!c) return NextResponse.json({ message: "无法解析该坐标对应的地址" }, { status: 400 });
  return NextResponse.json({
    latitude: lat,
    longitude: lng,
    province: c.province || "",
    city: Array.isArray(c.city) ? "" : c.city || "",
    district: c.district || "",
    address: data.regeocode.formatted_address || "",
    displayName: data.regeocode.formatted_address || "",
  });
}
