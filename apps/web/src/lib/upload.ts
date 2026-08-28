export async function uploadFile(file: File, jwt: string): Promise<string> {
  const res = await fetch("/api/upload/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ filename: file.name }),
  });
  const tok = (await res.json()) as {
    message?: string;
    token: string;
    key: string;
    uploadUrl: string;
    publicUrl: string;
  };
  if (!res.ok) throw new Error(tok.message || "获取上传凭证失败");
  const fd = new FormData();
  fd.append("token", tok.token);
  fd.append("key", tok.key);
  fd.append("file", file);
  const up = await fetch(tok.uploadUrl, { method: "POST", body: fd });
  if (!up.ok) throw new Error("七牛上传失败");
  return tok.publicUrl;
}
