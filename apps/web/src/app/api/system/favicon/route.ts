import { adminGql } from "@/lib/hasura-admin";
import { readFile } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="16" fill="#16835f"/>
  <text x="32" y="42" text-anchor="middle" font-size="32" font-family="Segoe UI, PingFang SC, sans-serif" font-weight="700" fill="#ffffff">光</text>
</svg>`;

async function loadLogoUrl(): Promise<string | null> {
  try {
    const data = await adminGql<{
      app_settings_by_pk: { value: unknown } | null;
    }>(`query { app_settings_by_pk(key: "branding") { value } }`);
    const value = data.app_settings_by_pk?.value;
    if (!value || typeof value !== "object") return null;
    const logoUrl = (value as { logoUrl?: unknown }).logoUrl;
    return typeof logoUrl === "string" && logoUrl.trim() ? logoUrl.trim() : null;
  } catch {
    return null;
  }
}

async function defaultFaviconResponse() {
  try {
    const file = await readFile(path.join(process.cwd(), "public", "brand-favicon.svg"));
    return new Response(file, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      },
    });
  } catch {
    return new Response(DEFAULT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "no-store, must-revalidate",
      },
    });
  }
}

/**
 * 同源 favicon：代理品牌 Logo，避免跨域与浏览器标签图标强缓存导致不更新。
 * 客户端用 /api/system/favicon?v=<updatedAt> 刷新。
 */
export async function GET() {
  const logoUrl = await loadLogoUrl();
  if (logoUrl) {
    try {
      const upstream = await fetch(logoUrl, {
        cache: "no-store",
        headers: { Accept: "image/*,*/*" },
      });
      if (upstream.ok) {
        const contentType = upstream.headers.get("content-type") || "image/png";
        const buf = await upstream.arrayBuffer();
        if (buf.byteLength > 0 && contentType.startsWith("image/")) {
          return new Response(buf, {
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "no-store, must-revalidate",
            },
          });
        }
      }
    } catch {
      // fall through to default
    }
  }
  return defaultFaviconResponse();
}
