import { createHash, createHmac } from "crypto";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createUploadToken, uploadBufferWithToken } from "../src/lib/storage.ts";

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
function sha256(data: string) {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

async function putCors() {
  const accessKey = process.env.TIANYI_ACCESS_KEY!;
  const secretKey = process.env.TIANYI_SECRET_KEY!;
  const bucket = process.env.TIANYI_BUCKET!;
  const endpoint = process.env.TIANYI_ENDPOINT!.replace(/\/$/, "");
  const region = process.env.TIANYI_REGION || "huadong-1";
  const host = new URL(endpoint).host;
  const objectHost = `${bucket}.${host}`;

  const corsXml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>POST</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(corsXml);
  const canonicalHeaders = `content-type:application/xml\nhost:${objectHost}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", "/", "cors=", canonicalHeaders, signedHeaders, payloadHash].join(
    "\n",
  );
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256(canonicalRequest)].join(
    "\n",
  );
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  const auth = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const res = await fetch(`https://${objectHost}/?cors`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/xml",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: auth,
    },
    body: corsXml,
  });
  const text = await res.text();
  console.log("CORS_PUT", res.status, text.slice(0, 800) || "ok");
}

async function probeUpload() {
  const t = createUploadToken("cors-probe.jpg", "probe", { contentType: "image/jpeg" });
  await uploadBufferWithToken(t, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const g = await fetch(t.publicUrl);
  console.log("UPLOAD_PROBE", g.status, t.publicUrl);
}

async function main() {
  loadEnv();
  await putCors();
  await probeUpload();
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
