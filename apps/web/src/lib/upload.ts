import { directUploadWithRetry } from "@/utils/direct-upload";

/** 通用直传入口：与全站同一套「直传重试 → 服务端代传」规则。 */
export async function uploadFile(file: File): Promise<string> {
  const res = await directUploadWithRetry(file, { skipErrorToast: true });
  return res.url;
}
