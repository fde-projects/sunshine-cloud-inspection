import { adminGql } from "@/lib/hasura-admin";
import { resolveEntryAiEnabled } from "./record-audit-route";

export const AI_ANALYZE_ATTEMPTS = 3;
export const AI_STALE_MS = 4 * 60 * 1000;

export type StoredAiResult = {
  status: string;
  confidence: number;
  reason: string;
  startedAt?: string;
  attempts?: number;
  provider?: string;
  gate?: string;
  gateLabel?: string;
};

export function isPassOrFail(status?: string | null) {
  return status === "pass" || status === "fail";
}

export function aiErrorResult(reason: string, attempts?: number): StoredAiResult {
  return {
    status: "error",
    confidence: 0,
    reason,
    attempts,
  };
}

export function isLiveAnalyzing(
  ai?: { status?: string; startedAt?: string } | null,
  now = Date.now(),
) {
  if (!ai || ai.status !== "pending") return false;
  const started = ai.startedAt ? Date.parse(ai.startedAt) : NaN;
  return !Number.isNaN(started) && now - started < AI_STALE_MS;
}

export async function patchEntryAiResult(
  recordId: string,
  entryId: string,
  aiResult: StoredAiResult,
) {
  const rec = await adminGql<{
    inspection_records_by_pk: { entries: Array<Record<string, unknown>> } | null;
  }>(`query ($id: uuid!) { inspection_records_by_pk(id: $id) { entries } }`, {
    id: recordId,
  });
  const entries = rec.inspection_records_by_pk?.entries || [];
  const next = entries.map((entry) =>
    String(entry.templateEntryId || "") === entryId ? { ...entry, aiResult } : entry,
  );
  await adminGql(
    `mutation ($id: uuid!, $entries: jsonb!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: { entries: $entries }) { id }
    }`,
    { id: recordId, entries: next },
  );
}

export function finalizeStaleAiEntries(
  entries: unknown,
  snapshot: unknown,
  opts?: { submittedAt?: string | null; recordStatus?: string | null; now?: number },
): { entries: Array<Record<string, unknown>>; changed: boolean } {
  const now = opts?.now ?? Date.now();
  const submitted = String(opts?.recordStatus || "") !== "draft" && !!opts?.submittedAt;
  const list = Array.isArray(entries) ? [...(entries as Array<Record<string, unknown>>)] : [];
  const snaps = Array.isArray(snapshot) ? snapshot : [];
  const byId = new Map<string, { aiEnabled?: boolean; entryKind?: string; checkType?: string }>();
  for (const raw of snaps) {
    const item = (raw || {}) as {
      id?: string;
      aiEnabled?: boolean;
      entryKind?: string;
      checkType?: string;
    };
    if (item.id) byId.set(String(item.id), item);
  }

  let changed = false;
  const next = list.map((entry) => {
    const id = String(entry.templateEntryId || "");
    const tpl = byId.get(id);
    if (tpl && !resolveEntryAiEnabled(tpl)) return entry;
    const ai = (entry.aiResult || null) as StoredAiResult | null;
    if (ai && isPassOrFail(ai.status)) return entry;
    if (ai?.status === "error") return entry;
    if (isLiveAnalyzing(ai, now)) return entry;
    const hadAttempt = !!(ai?.startedAt || (ai?.attempts && ai.attempts > 0));
    if (!hadAttempt && !submitted) return entry;
    changed = true;
    return {
      ...entry,
      aiResult: aiErrorResult("分析未写出合格或不合格，已转为异常", ai?.attempts),
    };
  });
  return { entries: next, changed };
}

export async function persistFinalizedAiEntries(
  recordId: string,
  entries: unknown,
  snapshot: unknown,
  opts?: { submittedAt?: string | null; recordStatus?: string | null },
) {
  const finalized = finalizeStaleAiEntries(entries, snapshot, opts);
  if (!finalized.changed) return false;
  await adminGql(
    `mutation ($id: uuid!, $entries: jsonb!) {
      update_inspection_records_by_pk(pk_columns: { id: $id }, _set: { entries: $entries }) { id }
    }`,
    { id: recordId, entries: finalized.entries },
  );
  return true;
}
