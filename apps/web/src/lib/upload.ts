export async function uploadFile(file: File, jwt: string): Promise<string> {
  const contentType = file.type || "application/octet-stream";
  const res = await fetch("/api/upload/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ filename: file.name, contentType }),
  });
  const tok = (await res.json()) as {
    message?: string;
    provider?: "qiniu" | "tianyi";
    method?: "POST" | "PUT";
    token: string;
    key: string;
    uploadUrl: string;
    publicUrl: string;
    headers?: Record<string, string>;
    contentType?: string;
  };
  if (!res.ok) throw new Error(tok.message || "获取上传凭证失败");

  if (tok.method === "PUT") {
    const up = await fetch(tok.uploadUrl, {
      method: "PUT",
      headers: {
        ...(tok.headers || {}),
        "Content-Type": tok.contentType || contentType,
      },
      body: file,
    });
    if (!up.ok) throw new Error("天翼云上传失败");
    return tok.publicUrl;
  }

  const fd = new FormData();
  fd.append("token", tok.token);
  fd.append("key", tok.key);
  fd.append("file", file);
  const up = await fetch(tok.uploadUrl, { method: "POST", body: fd });
  if (!up.ok) throw new Error("对象存储上传失败");
  return tok.publicUrl;
}
