import { createHmac } from "crypto";

function urlSafeBase64(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

export type UploadToken = {
  provider: "qiniu" | "tianyi";
  uploadUrl: string;
  token: string;
  key: string;
  publicUrl: string;
};

export function createUploadToken(filename: string, userId: string): UploadToken {
  const provider = (process.env.STORAGE_PROVIDER || "qiniu").toLowerCase();
  if (provider === "tianyi") {
    throw new Error("天翼云 OSS 尚未接入，请将 STORAGE_PROVIDER 保持为 qiniu");
  }
  const accessKey = process.env.QINIU_ACCESS_KEY?.trim();
  const secretKey = process.env.QINIU_SECRET_KEY?.trim();
  const bucket = process.env.QINIU_BUCKET?.trim();
  const domain = (process.env.QINIU_DOMAIN || "").replace(/\/$/, "");
  const uploadUrl = process.env.QINIU_UPLOAD_URL || "https://upload-z2.qiniup.com";
  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new Error("七牛云未配置完整");
  }

  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  const key = `inspection/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const policy = urlSafeBase64(JSON.stringify({ scope: `${bucket}:${key}`, deadline }));
  const sign = createHmac("sha1", secretKey).update(policy).digest();
  const token = `${accessKey}:${urlSafeBase64(sign)}:${policy}`;
  const publicUrl = `${domain}/${key}`;

  return { provider: "qiniu", uploadUrl, token, key, publicUrl };
}
