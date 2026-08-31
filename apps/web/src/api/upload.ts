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
      throw new Error(`直传失败: ${resp.status} ${text}`);
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
    throw new Error(`直传失败: ${resp.status} ${text}`);
  }
  return {
    url: tokenInfo.publicUrl || `${tokenInfo.domain}/${key}`,
    objectName: key,
  };
}

/** 上传图片（模板样本图、巡检原图等）：先压缩，优先直传对象存储。 */
export async function uploadImage(
  file: File,
  meta?: { siteName?: string; serialNumber?: string },
) {
  const compressed = await compressImageForUpload(file);
  const contentType = compressed.type || 'image/jpeg';
  const tokenInfo = await fetchUploadToken(
    compressed.name || file.name || 'photo.jpg',
    contentType,
  );
  if (tokenInfo) {
    try {
      return await uploadDirect(compressed, tokenInfo);
    } catch (error) {
      console.warn('对象存储直传失败，回退服务端上传', error);
    }
  }

  const form = new FormData();
  form.append('file', compressed);
  if (meta?.siteName) form.append('siteName', meta.siteName);
  if (meta?.serialNumber) form.append('serialNumber', meta.serialNumber);
  const { data } = await request.post<
    ApiResponse<{ url: string; objectName: string }>
  >('/upload/photo', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000,
  });
  return data.data;
}
