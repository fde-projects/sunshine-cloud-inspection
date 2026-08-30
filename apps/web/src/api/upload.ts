import request from '../utils/request';
import type { ApiResponse } from '../types';
import { compressImageForUpload } from '../utils/compress-image';

type QiniuToken = {
  token: string;
  domain: string;
  uploadUrl: string;
  bucket?: string;
  key?: string;
};

async function fetchQiniuToken(filename: string): Promise<QiniuToken | null> {
  try {
    const { data } = await request.get<ApiResponse<QiniuToken>>('/upload/qiniu-token', {
      timeout: 10000,
      params: { filename },
    });
    const payload = data.data;
    if (!payload?.token || !payload.domain || !payload.uploadUrl) return null;
    return {
      token: payload.token,
      domain: payload.domain.replace(/\/$/, ''),
      uploadUrl: payload.uploadUrl,
      bucket: payload.bucket,
      key: payload.key,
    };
  } catch {
    return null;
  }
}

/** 浏览器直传七牛，避免大图绕行 Vercel 函数。 */
async function uploadDirectToQiniu(file: File, tokenInfo: QiniuToken) {
  const key = tokenInfo.key;
  if (!key) throw new Error('上传凭证缺少文件名');
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
    url: `${tokenInfo.domain}/${key}`,
    objectName: key,
  };
}

/** 上传图片（模板样本图、巡检原图等）：先压缩，优先直传七牛。 */
export async function uploadImage(
  file: File,
  meta?: { siteName?: string; serialNumber?: string },
) {
  const compressed = await compressImageForUpload(file);
  const tokenInfo = await fetchQiniuToken(compressed.name || file.name || 'photo.jpg');
  if (tokenInfo) {
    try {
      return await uploadDirectToQiniu(compressed, tokenInfo);
    } catch (error) {
      console.warn('七牛直传失败，回退服务端上传', error);
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
