"use client";

import { message } from "antd";
import { getToken } from "@/lib/session";
import { chineseErrorMessage } from "./displayLabels";

export type AppAxiosRequestConfig = {
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeout?: number;
  responseType?: "json" | "blob";
  skipErrorToast?: boolean;
  onUploadProgress?: (event: { loaded: number; total?: number }) => void;
  method?: string;
  url?: string;
  data?: unknown;
};

type Envelope<T> = { code: number; message: string; data: T };

function tokenOf() {
  if (typeof window === "undefined") return "";
  return getToken() || localStorage.getItem("accessToken") || "";
}

function qs(params?: Record<string, unknown>) {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      v.forEach((item) => sp.append(k, String(item)));
    } else {
      sp.set(k, String(v));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

async function send<T>(
  method: string,
  url: string,
  data?: unknown,
  config: AppAxiosRequestConfig = {},
): Promise<{ data: T }> {
  const path = url.startsWith("/") ? url : `/${url}`;
  const target = `/api/bff${path}${qs(config.params)}`;
  const headers: Record<string, string> = { ...(config.headers || {}) };
  const tok = tokenOf();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  let body: BodyInit | undefined;
  if (data instanceof FormData) {
    body = data;
    delete headers["Content-Type"];
  } else if (data !== undefined && method !== "GET") {
    headers["Content-Type"] = headers["Content-Type"] || "application/json";
    body = JSON.stringify(data);
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeout || 30000);
  try {
    const res = await fetch(target, { method, headers, body, signal: ac.signal });
    if (config.responseType === "blob") {
      const blob = await res.blob();
      if (!res.ok) {
        const text = await blob.text();
        let msg = "请求失败";
        try {
          msg = JSON.parse(text)?.message || msg;
        } catch {
          /* ignore */
        }
        throw Object.assign(new Error(msg), { response: { status: res.status, data: blob } });
      }
      return { data: blob as unknown as T };
    }
    const json = (await res.json().catch(() => ({}))) as Envelope<unknown> & { message?: string };
    if (!res.ok || (json.code && json.code >= 400)) {
      const msg = json.message || "请求失败";
      if (!config.skipErrorToast) {
        const shown = chineseErrorMessage(msg);
        if (shown) message.error(shown);
      }
      throw Object.assign(new Error(msg), { response: { status: res.status, data: json } });
    }
    if (json.code === undefined) {
      return { data: { code: 200, message: "success", data: json } as T };
    }
    return { data: json as T };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      const msg = "请求超时，请稍后重试";
      if (!config.skipErrorToast) message.error(msg);
      throw new Error(msg);
    }
    if ((error as { response?: unknown }).response) throw error;
    const raw = error instanceof Error ? error.message : "请求失败";
    const msg = chineseErrorMessage(raw) || "网络连接失败，请检查网络后重试";
    if (!config.skipErrorToast && msg) message.error(msg);
    throw new Error(msg);
  } finally {
    clearTimeout(timer);
  }
}

const request = {
  get: <T>(url: string, config?: AppAxiosRequestConfig) => send<T>("GET", url, undefined, config),
  delete: <T>(url: string, config?: AppAxiosRequestConfig) =>
    send<T>("DELETE", url, undefined, config),
  post: <T>(url: string, data?: unknown, config?: AppAxiosRequestConfig) =>
    send<T>("POST", url, data, config),
  put: <T>(url: string, data?: unknown, config?: AppAxiosRequestConfig) =>
    send<T>("PUT", url, data, config),
  patch: <T>(url: string, data?: unknown, config?: AppAxiosRequestConfig) =>
    send<T>("PATCH", url, data, config),
};

export default request;
