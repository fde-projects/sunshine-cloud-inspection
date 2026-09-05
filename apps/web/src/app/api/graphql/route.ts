import { NextResponse } from "next/server";

/**
 * 浏览器只打同源 /api/graphql，由服务端转发 Hasura。
 * 避免前端直连内网 GraphQL 被 CORS / 防火墙拦成「网络连接失败」。
 */
export async function POST(req: Request) {
  const url = String(process.env.HASURA_GRAPHQL_URL || "").trim();
  if (!url) {
    return NextResponse.json({ errors: [{ message: "未配置数据服务地址" }] }, { status: 500 });
  }

  const incoming = req.headers;
  const headers: Record<string, string> = {
    "content-type": incoming.get("content-type") || "application/json",
  };
  const auth = incoming.get("authorization");
  const role = incoming.get("x-hasura-role");
  if (auth) headers.authorization = auth;
  if (role) headers["x-hasura-role"] = role;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: await req.text(),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") || "application/json" },
    });
  } catch {
    return NextResponse.json({ errors: [{ message: "数据服务暂时连不上，请稍后重试" }] }, { status: 502 });
  }
}
