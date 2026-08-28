import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    graphqlUrl: process.env.HASURA_GRAPHQL_URL,
  });
}
