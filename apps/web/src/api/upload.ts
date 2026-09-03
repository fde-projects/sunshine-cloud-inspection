import request from '../utils/request';
import type { ApiResponse } from '../types';
import { compressImageForUpload } from '../utils/compress-image';

type DirectUploadToken = {
  provider: 'qiniu' | 'tianyi';
  method: 'POST' | 'PUT';
  token: string;
  domain: string;
  uploadUrl: string;
  bucket?: string;
  key?: string;
  publicUrl?: string;
  headers?: Record<string, string>;
  contentType?: string;
};

/** 浏览器直传一旦因 CORS/网络失败，本页会话内改走服务端，避免批量每张都先撞墙。 */
let skipDirectUpload = false;

function isLikelyCorsOrNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message || '';
  return (
    error.name === 'TypeError' ||
    /failed to fetch|networkerror|load failed|cors/i.test(msg)
  );
}

function errorMessage(error: unknown, fallback = '图片上传失败'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    const m = String((error as { message?: string }).message || '');
    if (m) return m;
  }
  return fallback;
}

async function fetchUploadToken(
  filename: string,
  contentType: string,
): Promise<DirectUploadToken | null> {
  try {
    const { data } = await request.get<ApiResponse<DirectUploadToken>>('/upload/token', {
      timeout: 10000,
      params: { filename, contentType },
    });
    const payload = data.data;
    if (!payload?.uploadUrl || !payload.domain) return null;
    if (payload.method === 'POST' && !payload.token) return null;
    if (!payload.key) return null;
    return {
      ...payload,
      domain: payload.domain.replace(/\/$/, ''),
      method: payload.method || 'POST',
      provider: payload.provider || 'qiniu',
      headers: payload.headers || {},
    };
  } catch {
    return null;
  }
}

/** 浏览器直传对象存储，避免大图绕行服务端。 */
async function uploadDirect(file: File, tokenInfo: DirectUploadToken) {
  const key = tokenInfo.key;
  if (!key) throw new Error('上传凭证缺少文件名');

  if (tokenInfo.method === 'PUT') {
    const resp = await fetch(tokenInfo.uploadUrl, {
      method: 'PUT',
      headers: {
        ...(tokenInfo.headers || {}),
        'Content-Type':
          tokenInfo.contentType || file.type || 'application/octet-stream',
      },
      body: file,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`直传失败: ${resp.status} ${text}`.trim());
    }
    return {
      url: tokenInfo.publicUrl || `${tokenInfo.domain}/${key}`,
      objectName: key,
    };
  }

  const form = new FormData();
  form.append('token', tokenInfo.token);
  form.append('key', key);
  form.append('file', file);

  const resp = await fetch(tokenInfo.uploadUrl, {
    method: 'POST',
    body: form,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`直传失败: ${resp.status} ${text}`.trim());
  }
  return {
    url: tokenInfo.publicUrl || `${tokenInfo.domain}/${key}`,
    objectName: key,
  };
}

async function uploadViaServer(
  file: File,
  meta?: { siteName?: string; serialNumber?: string },
) {
  const form = new FormData();
  form.append('file', file);
  if (meta?.siteName) form.append('siteName', meta.siteName);
  if (meta?.serialNumber) form.append('serialNumber', meta.serialNumber);
  const { data } = await request.post<
    ApiResponse<{ url: string; objectName: string }>
  >('/upload/photo', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 180000,
    skipErrorToast: true,
  });
  if (!data?.data?.url) throw new Error(data?.message || '上传未返回地址');
  return data.data;
}

/** 上传图片（模板样本图、巡检原图等）：先压缩，优先直传对象存储。 */
export async function uploadImage(
  file: File,
  meta?: { siteName?: string; serialNumber?: string },
) {
  const compressed = await compressImageForUpload(file);

  if (!skipDirectUpload) {
    const contentType = compressed.type || 'image/jpeg';
    const tokenInfo = await fetchUploadToken(
      compressed.name || file.name || 'photo.jpg',
      contentType,
    );
    if (tokenInfo) {
      try {
        const uploaded = await uploadDirect(compressed, tokenInfo);
        if (!uploaded?.url || !/^https?:\/\//i.test(String(uploaded.url))) {
          throw new Error('直传未返回有效图片地址');
        }
        return uploaded;
      } catch (error) {
        if (isLikelyCorsOrNetworkError(error)) {
          skipDirectUpload = true;
          console.warn(
            '对象存储直传不可用（多为桶 CORS 未放行当前站点），后续改走服务端上传',
            error,
          );
        } else {
          console.warn('对象存储直传失败，回退服务端上传', error);
        }
      }
    }
  }

  try {
    return await uploadViaServer(compressed, meta);
  } catch (error) {
    throw new Error(errorMessage(error, '图片上传失败'));
  }
}
