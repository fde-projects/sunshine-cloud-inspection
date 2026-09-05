import { compressImageForUpload } from '../utils/compress-image';
import { directUploadWithRetry } from '../utils/direct-upload';

function errorMessage(error: unknown, fallback = '图片上传失败'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    const m = String((error as { message?: string }).message || '');
    if (m) return m;
  }
  return fallback;
}

/**
 * 管理端图片上传（模板样张、硬规则、品牌图等）：
 * 压缩 → 直传重试 → 服务端代传（与工程师端同一套规则）。
 */
export async function uploadImage(
  file: File,
  meta?: { siteName?: string; serialNumber?: string },
) {
  const compressed = await compressImageForUpload(file);
  try {
    const uploaded = await directUploadWithRetry(compressed, {
      skipErrorToast: true,
      serverFormFields: {
        ...(meta?.siteName ? { siteName: meta.siteName } : {}),
        ...(meta?.serialNumber ? { serialNumber: meta.serialNumber } : {}),
      },
    });
    if (!uploaded?.url || !/^https?:\/\//i.test(String(uploaded.url))) {
      throw new Error('上传未返回有效图片地址');
    }
    return {
      url: uploaded.url,
      objectName: uploaded.key || '',
    };
  } catch (error) {
    throw new Error(errorMessage(error, '图片上传失败'));
  }
}
