import { handleBff } from "@/server/bff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

async function run(req: Request, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  return handleBff(req, (path || []).join("/"));
}

export const GET = run;
export const POST = run;
export const PUT = run;
export const PATCH = run;
export const DELETE = run;
