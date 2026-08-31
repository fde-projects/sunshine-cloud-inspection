import { createHmac, createHash } from "crypto";

function urlSafeBase64(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/%2F/gi, "/"))
    .join("/");
}

function buildObjectKey(filename: string, userId: string): string {
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : "";
  return `inspection/${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

export type UploadToken = {
  provider: "qiniu" | "tianyi";
  /** 浏览器直传 HTTP 方法 */
  method: "POST" | "PUT";
  uploadUrl: string;
  /** 七牛 upload token；天翼预签名 PUT 时为空字符串 */
  token: string;
  key: string;
  publicUrl: string;
  /** 直传时需带上的请求头（天翼 PUT 常用 Content-Type） */
  headers?: Record<string, string>;
  contentType?: string;
};

function createQiniuUploadToken(filename: string, userId: string): UploadToken {
  const accessKey = process.env.QINIU_ACCESS_KEY?.trim();
  const secretKey = process.env.QINIU_SECRET_KEY?.trim();
  const bucket = process.env.QINIU_BUCKET?.trim();
  const domain = (process.env.QINIU_DOMAIN || "").replace(/\/$/, "");
  const uploadUrl = process.env.QINIU_UPLOAD_URL || "https://upload-z2.qiniup.com";
  if (!accessKey || !secretKey || !bucket || !domain) {
    throw new Error("七牛云未配置完整");
  }

  const key = buildObjectKey(filename, userId);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const policy = urlSafeBase64(JSON.stringify({ scope: `${bucket}:${key}`, deadline }));
  const sign = createHmac("sha1", secretKey).update(policy).digest();
  const token = `${accessKey}:${urlSafeBase64(sign)}:${policy}`;

  return {
    provider: "qiniu",
    method: "POST",
    uploadUrl,
    token,
    key,
    publicUrl: `${domain}/${key}`,
  };
}

/** 天翼云 ZOS（S3 兼容）预签名 PUT，供浏览器直传。 */
function createTianyiUploadToken(
  filename: string,
  userId: string,
  contentType = "application/octet-stream",
): UploadToken {
  const accessKey = process.env.TIANYI_ACCESS_KEY?.trim();
  const secretKey = process.env.TIANYI_SECRET_KEY?.trim();
  const bucket = process.env.TIANYI_BUCKET?.trim();
  const endpoint = (process.env.TIANYI_ENDPOINT || "").replace(/\/$/, "");
  const domain = (process.env.TIANYI_DOMAIN || "").replace(/\/$/, "");
  const region = (process.env.TIANYI_REGION || "huadong-1").trim();
  if (!accessKey || !secretKey || !bucket || !endpoint || !domain) {
    throw new Error("天翼云未配置完整");
  }

  const key = buildObjectKey(filename, userId);
  const expires = 3600;
  const host = new URL(endpoint).host;
  // 虚拟主机风格：bucket.endpoint / key
  const objectHost = `${bucket}.${host}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;
  const acl = "public-read";

  const signedHeaders = "content-type;host;x-amz-acl";
  const canonicalQuery = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expires)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");

  const canonicalHeaders = `content-type:${contentType}\nhost:${objectHost}\nx-amz-acl:${acl}\n`;
  const canonicalRequest = [
    "PUT",
    `/${encodeS3Key(key)}`,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, "s3");
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const uploadUrl = `https://${objectHost}/${encodeS3Key(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`;

  return {
    provider: "tianyi",
    method: "PUT",
    uploadUrl,
    token: "",
    key,
    publicUrl: `${domain}/${key}`,
    contentType,
    headers: {
      "Content-Type": contentType,
      "x-amz-acl": acl,
    },
  };
}

export function createUploadToken(
  filename: string,
  userId: string,
  opts?: { contentType?: string },
): UploadToken {
  const provider = (process.env.STORAGE_PROVIDER || "qiniu").toLowerCase();
  if (provider === "tianyi") {
    return createTianyiUploadToken(filename, userId, opts?.contentType || "image/jpeg");
  }
  return createQiniuUploadToken(filename, userId);
}

/** 服务端代传：按 provider 走七牛 Form POST 或天翼预签名 PUT。 */
export async function uploadBufferWithToken(
  token: UploadToken,
  body: Buffer | Blob | ArrayBuffer,
): Promise<void> {
  if (token.method === "PUT") {
    const res = await fetch(token.uploadUrl, {
      method: "PUT",
      headers: token.headers,
      body: body as BodyInit,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`对象存储上传失败: ${res.status} ${text}`);
    }
    return;
  }

  const fd = new FormData();
  fd.append("token", token.token);
  fd.append("key", token.key);
  const bytes =
    body instanceof Blob
      ? body
      : body instanceof ArrayBuffer
        ? new Blob([body])
        : new Blob([new Uint8Array(body)]);
  fd.append("file", bytes);
  const res = await fetch(token.uploadUrl, { method: "POST", body: fd });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`对象存储上传失败: ${res.status} ${text}`);
  }
}
