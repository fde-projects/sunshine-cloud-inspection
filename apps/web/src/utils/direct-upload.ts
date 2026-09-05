import request from "@/utils/request";
import type { ApiResponse } from "@/types";

type UploadToken = {
  method?: "POST" | "PUT";
  token?: string;
  uploadUrl: string;
  key: string;
  publicUrl?: string;
  domain?: string;
  headers?: Record<string, string>;
  contentType?: string;
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1000, 2000];

/** 本会话内直传被 CORS/网络拦死后，后续直接走服务端，避免每张都先撞墙。 */
let skipDirectUpload = false;

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function publicUrlOf(tok: UploadToken) {
  return tok.publicUrl || `${(tok.domain || "").replace(/\/$/, "")}/${tok.key}`;
}

function isLikelyBrowserBlocked(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message || "";
  return (
    error.name === "TypeError" ||
    /直传网络错误|failed to fetch|networkerror|load failed|cors/i.test(msg)
  );
}

async function fetchUploadToken(
  file: File,
  opts?: { skipErrorToast?: boolean },
): Promise<UploadToken> {
  const contentType = file.type || "image/jpeg";
  const { data } = await request.get<ApiResponse<UploadToken>>("/upload/token", {
    timeout: 10000,
    params: { filename: file.name || "photo.jpg", contentType },
    ...(opts?.skipErrorToast ? { skipErrorToast: true } : {}),
  } as never);
  const tok = data.data;
  if (!tok?.uploadUrl || !tok.key) {
    throw new Error("未获取到上传凭证");
  }
  return tok;
}

function xhrSend(
  method: "PUT" | "POST",
  url: string,
  body: Blob | FormData,
  headers: Record<string, string> | undefined,
  onProgress?: (percent: number) => void,
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    if (headers) {
      Object.entries(headers).forEach(([k, v]) => {
        if (v != null && v !== "") xhr.setRequestHeader(k, String(v));
      });
    }
    xhr.upload.onprogress = (event) => {
      if (!event.total) return;
      onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }
      const detail = String(xhr.responseText || "")
        .replace(/\s+/g, " ")
        .slice(0, 160);
      reject(new Error(`直传失败: ${xhr.status}${detail ? ` ${detail}` : ""}`));
    };
    xhr.onerror = () =>
      reject(new Error("直传网络错误（多为对象存储 CORS 未放行当前站点）"));
    xhr.ontimeout = () => reject(new Error("直传超时"));
    xhr.timeout = 60_000;
    xhr.send(body);
  });
}

/** 天翼预签名 PUT：token 字段本来就是空的，鉴权在 uploadUrl 查询串里。 */
function isPresignedPut(tok: UploadToken) {
  if (tok.method === "PUT") return true;
  return /[?&]X-Amz-Signature=/i.test(tok.uploadUrl || "");
}

async function directUploadOnce(
  file: File,
  opts?: { onProgress?: (percent: number) => void; skipErrorToast?: boolean },
): Promise<{ url: string; original: true; key?: string }> {
  const contentType = file.type || "image/jpeg";
  const tok = await fetchUploadToken(file, opts);

  if (isPresignedPut(tok)) {
    // 严格使用服务端返回的 headers，勿自行改写，否则签名对不上
    const headers: Record<string, string> = { ...(tok.headers || {}) };
    if (!headers["Content-Type"] && !headers["content-type"]) {
      headers["Content-Type"] = tok.contentType || contentType;
    }
    await xhrSend("PUT", tok.uploadUrl, file, headers, opts?.onProgress);
    opts?.onProgress?.(100);
    return { url: publicUrlOf(tok), original: true, key: tok.key };
  }

  if (!tok.token) {
    throw new Error("未获取到上传凭证");
  }
  const fd = new FormData();
  fd.append("token", tok.token);
  fd.append("key", tok.key);
  fd.append("file", file);
  await xhrSend("POST", tok.uploadUrl, fd, undefined, opts?.onProgress);
  opts?.onProgress?.(100);
  return { url: publicUrlOf(tok), original: true, key: tok.key };
}

async function retryDirectUpload(
  file: File,
  opts?: { onProgress?: (percent: number) => void; skipErrorToast?: boolean },
): Promise<{ url: string; original: true; key?: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 0) opts?.onProgress?.(0);
      return await directUploadOnce(file, opts);
    } catch (err) {
      lastError = err;
      if (isLikelyBrowserBlocked(err)) {
        skipDirectUpload = true;
      }
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BACKOFF_MS[attempt] ?? 2000);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("直传失败，请重试");
}

async function uploadViaServer(
  file: File,
  opts?: {
    onProgress?: (percent: number) => void;
    skipErrorToast?: boolean;
    serverPath?: string;
    serverFormFields?: Record<string, string>;
  },
): Promise<{ url: string; original: true; key?: string }> {
  const form = new FormData();
  form.append("file", file);
  if (opts?.serverFormFields) {
    Object.entries(opts.serverFormFields).forEach(([k, v]) => {
      if (v) form.append(k, v);
    });
  }
  const path = opts?.serverPath || "/upload/photo";
  const { data } = await request.post<
    ApiResponse<{ url: string; original?: boolean; objectName?: string }>
  >(path, form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 180_000,
    ...(opts?.skipErrorToast ? { skipErrorToast: true } : {}),
    onUploadProgress: (event) => {
      if (!event.total) return;
      opts?.onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    },
  } as never);
  if (!data?.data?.url) {
    throw new Error(data?.message || "上传未返回地址");
  }
  opts?.onProgress?.(100);
  return {
    url: data.data.url,
    original: data.data.original ?? true,
    key: data.data.objectName,
  };
}

export type DirectUploadOptions = {
  onProgress?: (percent: number) => void;
  skipErrorToast?: boolean;
  /** 直传失败后的服务端代传路径，默认 /upload/photo */
  serverFallbackPath?: string;
  /** 代传时额外 FormData 字段（如 siteName） */
  serverFormFields?: Record<string, string>;
  /** 设为 false 可禁用代传；默认启用 */
  allowServerFallback?: boolean;
};

/**
 * 全站图片上传统一策略：
 * 1) 浏览器直传（失败自动整文件重试，最多 3 次）
 * 2) 仍失败则服务端代传
 *
 * 天翼 PUT 的 `token` 为空是正常的（签名在 uploadUrl 的 X-Amz-* 里）。
 */
export async function directUploadWithRetry(
  file: File,
  opts?: DirectUploadOptions,
): Promise<{ url: string; original: true; key?: string }> {
  const allowFallback = opts?.allowServerFallback !== false;
  const serverPath = opts?.serverFallbackPath || "/upload/photo";

  if (!skipDirectUpload) {
    try {
      return await retryDirectUpload(file, opts);
    } catch (err) {
      if (!allowFallback) throw err;
      console.warn("对象存储直传失败，回退服务端代传", err);
    }
  }

  if (!allowFallback) {
    throw new Error("直传失败，请重试");
  }

  return uploadViaServer(file, {
    onProgress: opts?.onProgress,
    skipErrorToast: opts?.skipErrorToast,
    serverPath,
    serverFormFields: opts?.serverFormFields,
  });
}
