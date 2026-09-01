/** 列出天翼桶 inspection/ 下对象，确认样本图文件是否还在 */
import { createHash, createHmac } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const text = readFileSync(resolve(__dirname, "../../../.env"), "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    process.env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

function hmac(key: Buffer | string, data: string) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

async function listPrefix(prefix: string, maxKeys = 20) {
  const accessKey = process.env.TIANYI_ACCESS_KEY!;
  const secretKey = process.env.TIANYI_SECRET_KEY!;
  const bucket = process.env.TIANYI_BUCKET!;
  const endpoint = process.env.TIANYI_ENDPOINT!.replace(/\/$/, "");
  const region = process.env.TIANYI_REGION || "huadong-1";
  const host = new URL(endpoint).host;
  const objectHost = `${bucket}.${host}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const credential = `${accessKey}/${credentialScope}`;
  const query = new URLSearchParams({
    "list-type": "2",
    prefix,
    "max-keys": String(maxKeys),
  });
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");
  const canonicalHeaders = `host:${objectHost}\n`;
  const canonicalRequest = [
    "GET",
    "/",
    canonicalQuery,
    canonicalHeaders,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const url = `https://${objectHost}/?${canonicalQuery}&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${encodeURIComponent(credential)}&X-Amz-Date=${amzDate}&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=${signature}`;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return text;
}

async function main() {
  loadEnv();
  const domain = (process.env.TIANYI_DOMAIN || "").replace(/\/$/, "");
  const xml = await listPrefix("inspection/", 50);
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  const total = xml.match(/<KeyCount>(\d+)<\/KeyCount>/)?.[1] ?? String(keys.length);
  console.log(`天翼桶 inspection/ 下约有 ${total} 个对象（展示前 ${keys.length} 个）`);
  for (const key of keys.slice(0, 10)) {
    console.log(`  ${domain}/${key}`);
  }
  if (!keys.length) console.log("  （未找到文件，可能已删或未上传过）");
}

main().catch((e) => {
  console.error("列举失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
