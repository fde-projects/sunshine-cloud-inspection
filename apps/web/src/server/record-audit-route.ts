/** 验图报告自动分拣：全合格/纯记录自动通过；不合格·异常·整单关 AI 进人审 */

export type AuditRouteDecision = "auto_approve" | "need_audit" | "wait_ai";

type SnapEntry = {
  id?: string;
  aiEnabled?: boolean;
  entryKind?: string;
  checkType?: string;
};

type RecordEntry = {
  templateEntryId?: string;
  manualResult?: string | null;
  finalResult?: string | null;
  aiResult?: { status?: string } | null;
};

/** 与前端 resolveEntryAiEnabled 对齐 */
export function resolveEntryAiEnabled(entry: SnapEntry): boolean {
  if (entry.aiEnabled === true) return true;
  if (entry.aiEnabled === false) return false;
  if (entry.entryKind === "record") return false;
  if (entry.entryKind === "check") return true;
  if (entry.checkType === "text") return false;
  return true;
}

function entryOutcome(entry: RecordEntry): "pass" | "fail" | "error" | "pending" | "missing" {
  const manual = String(entry.finalResult || entry.manualResult || "");
  // 作业端默认会写 manualResult=pending，只有明确合格/不合格才算人工结论
  if (manual === "fail") return "fail";
  if (manual === "pass") return "pass";
  const raw = entry.aiResult?.status;
  if (raw == null || raw === "") return "missing";
  const st = String(raw);
  if (st === "pass") return "pass";
  if (st === "fail") return "fail";
  if (st === "error") return "error";
  if (st === "pending") return "pending";
  return "error";
}

/**
 * 决定报告去向。
 * - auto_approve：进历史（全合格或无可 AI 项）
 * - need_audit：进验图待审（不合格/异常/整单关 AI/AI 从未出结果）
 * - wait_ai：仍 submitted，等分析完成后再判（仅 aiResult=pending）
 */
export function decideRecordAuditRoute(opts: {
  taskAiEnabled: boolean | null | undefined;
  templateSnapshot: SnapEntry[] | null | undefined;
  entries: RecordEntry[] | null | undefined;
}): AuditRouteDecision {
  if (opts.taskAiEnabled === false) return "need_audit";

  const snap = Array.isArray(opts.templateSnapshot) ? opts.templateSnapshot : [];
  const entries = Array.isArray(opts.entries) ? opts.entries : [];
  const snapById = new Map(snap.filter((s) => s.id).map((s) => [String(s.id), s]));

  const aiEntries = entries.filter((e) => {
    const id = String(e.templateEntryId || "");
    const tpl = snapById.get(id);
    if (tpl) return resolveEntryAiEnabled(tpl);
    if (e.aiResult) return true;
    return false;
  });

  // 没有任何要 AI 看的项（纯记录单）→ 自动过
  if (!aiEntries.length) {
    if (!entries.length && snap.some((s) => resolveEntryAiEnabled(s))) {
      return "wait_ai";
    }
    return "auto_approve";
  }

  let sawPending = false;
  for (const e of aiEntries) {
    const out = entryOutcome(e);
    if (out === "fail" || out === "error" || out === "missing") return "need_audit";
    if (out === "pending") sawPending = true;
  }
  if (sawPending) return "wait_ai";
  return "auto_approve";
}

/** 已提交报告是否应出现在验图待审：仅不合格/异常/整单关 AI（分析中的不进待审） */
export function recordNeedsHumanAudit(opts: {
  status: string | null | undefined;
  taskAiEnabled: boolean | null | undefined;
  templateSnapshot: SnapEntry[] | null | undefined;
  entries: RecordEntry[] | null | undefined;
}): boolean {
  if (String(opts.status || "") !== "submitted") return false;
  return decideRecordAuditRoute(opts) === "need_audit";
}
