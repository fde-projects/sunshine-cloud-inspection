import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address =
    url.searchParams.get("address") ||
    [url.searchParams.get("province"), url.searchParams.get("city"), url.searchParams.get("district"), url.searchParams.get("detail")]
      .filter(Boolean)
      .join("");
  const key = (process.env.AMAP_WEB_SERVICE_KEY || process.env.AMAP_WEB_KEY || "").trim();
  if (!address) return NextResponse.json({ message: "请提供地址" }, { status: 400 });
  if (!key) return NextResponse.json({ message: "未配置高德 Key" }, { status: 500 });

  const amap = await fetch(
    `https://restapi.amap.com/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(address)}`,
  );
  const data = await amap.json();
  const loc = data?.geocodes?.[0]?.location as string | undefined;
  if (!loc) {
    return NextResponse.json({ message: "未找到该地址对应坐标，可在地图上手动选点" }, { status: 400 });
  }
  const [lng, lat] = loc.split(",").map(Number);
  return NextResponse.json({
    latitude: lat,
    longitude: lng,
    displayName: data.geocodes[0].formatted_address || address,
    provider: "amap",
  });
}
