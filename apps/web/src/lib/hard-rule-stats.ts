import {
  HARD_RULE_REVIEW_WINDOW_DAYS,
  matchHardRule,
  type HardRuleMatchInput,
} from "./hard-rule-match";

export type HardRuleReviewStats = {
  reviewed: number;
  agreed: number;
  windowDays: number;
};

export type HardRuleReviewStamp = {
  aiStatus: string | null;
  manualStatus: "pass" | "fail";
  agreed: boolean | null;
  reviewedAt: string;
  ruleCodes: string[];
};

type RuleRow = HardRuleMatchInput & { code?: string };

export function emptyHardRuleReviewStats(): HardRuleReviewStats {
  return { reviewed: 0, agreed: 0, windowDays: HARD_RULE_REVIEW_WINDOW_DAYS };
}

export function stampHardRuleReview(input: {
  aiStatus?: unknown;
  manualStatus: "pass" | "fail";
  ruleCodes: string[];
}): HardRuleReviewStamp {
  const aiStatus = String(input.aiStatus || "").trim() || null;
  const comparable = aiStatus === "pass" || aiStatus === "fail";
  return {
    aiStatus,
    manualStatus: input.manualStatus,
    agreed: comparable ? aiStatus === input.manualStatus : null,
    reviewedAt: new Date().toISOString(),
    ruleCodes: input.ruleCodes.filter(Boolean),
  };
}

export function matchHardRuleCodes(
  rules: RuleRow[],
  context: { title?: string; description?: string; templateId?: string; entryId?: string },
): string[] {
  return rules
    .filter((rule) =>
      matchHardRule(rule, {
        title: context.title || "",
        description: context.description || "",
        templateId: context.templateId,
        entryId: context.entryId,
      }),
    )
    .map((rule) => String(rule.code || "").trim())
    .filter(Boolean);
}

export function accumulateHardRuleReviewStats(
  records: Array<{
    entries?: unknown;
    createdAt?: string;
    created_at?: string;
    submittedAt?: string;
    submitted_at?: string;
    approvedAt?: string;
    approved_at?: string;
    task?: {
      template_snapshot?: Array<{ id?: string; name?: string; description?: string }>;
      templateSnapshot?: Array<{ id?: string; name?: string; description?: string }>;
      service_case?: { task_template_id?: string };
      serviceCase?: { task_template_id?: string; taskTemplateId?: string };
    };
  }>,
  rules: RuleRow[],
): Record<string, HardRuleReviewStats> {
  const since = Date.now() - HARD_RULE_REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const stats: Record<string, HardRuleReviewStats> = {};
  const bump = (code: string, agreed: boolean) => {
    if (!stats[code]) stats[code] = emptyHardRuleReviewStats();
    stats[code].reviewed += 1;
    if (agreed) stats[code].agreed += 1;
  };

  for (const record of records) {
    const recordAt = Date.parse(
      String(record.submittedAt || record.submitted_at || record.approvedAt || record.approved_at || record.createdAt || record.created_at || ""),
    );
    const snapshot =
      record.task?.template_snapshot || record.task?.templateSnapshot || [];
    const templateId = String(
      record.task?.service_case?.task_template_id ||
        record.task?.serviceCase?.task_template_id ||
        record.task?.serviceCase?.taskTemplateId ||
        "",
    );
    const entries = Array.isArray(record.entries) ? record.entries : [];
    for (const raw of entries) {
      const entry = (raw || {}) as Record<string, unknown>;
      const manual = String(entry.manualResult || "");
      if (manual !== "pass" && manual !== "fail") continue;
      const ai = (entry.aiResult || {}) as { status?: string };
      if (ai.status !== "pass" && ai.status !== "fail") continue;

      const review = (entry.review || {}) as {
        ruleCodes?: unknown;
        agreed?: unknown;
        reviewedAt?: unknown;
      };
      const reviewedAt = Date.parse(String(review.reviewedAt || ""));
      const when = reviewedAt || recordAt;
      if (when && when < since) continue;
      const stampedCodes = Array.isArray(review.ruleCodes)
        ? review.ruleCodes.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      const entryId = String(entry.templateEntryId || "");
      const snap = snapshot.find((item) => item.id === entryId);
      const codes = stampedCodes.length
        ? stampedCodes
        : matchHardRuleCodes(rules, {
            title: String(snap?.name || ""),
            description: String(snap?.description || ""),
            templateId,
            entryId,
          });
      if (!codes.length) continue;
      const agreed =
        typeof review.agreed === "boolean" ? review.agreed : ai.status === manual;
      for (const code of codes) bump(code, agreed);
    }
  }
  return stats;
}
