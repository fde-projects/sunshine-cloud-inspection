import { NextResponse } from "next/server";

export async function GET() {
  const url = process.env.HASURA_GRAPHQL_URL;
  if (!url) return NextResponse.json({ ok: false }, { status: 500 });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    return NextResponse.json({ ok: res.ok, graphql: res.ok });
  } catch {
    return NextResponse.json({ ok: false, graphql: false }, { status: 503 });
  }
}
