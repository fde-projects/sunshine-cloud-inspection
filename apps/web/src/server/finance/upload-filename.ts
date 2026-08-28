export function decodeUploadFilename(name: string | undefined | null): string {
  const raw = String(name || "").trim();
  if (!raw) return "";
  try {
    const fixed = Buffer.from(raw, "latin1").toString("utf8");
    if (!fixed || fixed.includes("\uFFFD") || fixed === raw) return raw;
    const rawCJK = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
    const fixedCJK = (fixed.match(/[\u4e00-\u9fff]/g) || []).length;
    if (fixedCJK > rawCJK || (rawCJK === 0 && /[ÃÂæçåéøï]/.test(raw))) {
      return fixed;
    }
  } catch {
    /* keep raw */
  }
  return raw;
}

export function resolveUploadFilename(
  file: { originalname?: string },
  clientFilename?: string | null,
): string {
  const fromClient = String(clientFilename || "").trim();
  if (fromClient) return fromClient;
  return decodeUploadFilename(file?.originalname);
}
