export type HardRuleMatchInput = {
  matchMode?: string | null;
  match_mode?: string | null;
  matchPattern?: string | null;
  match_pattern?: string | null;
  jsonSchemaHint?: string | null;
  json_schema_hint?: string | null;
};

export type HardRuleBinding = {
  templateId: string;
  entryId: string;
  templateName: string;
  entryName: string;
  productLineName?: string;
};

export type HardRulePassView = {
  url: string;
  label: string;
};

export type HardRuleSamples = {
  pass: HardRulePassView[];
  fail: string[];
};

export const HARD_RULE_PASS_SAMPLE_LIMIT = 4;
export const HARD_RULE_FAIL_SAMPLE_LIMIT = 2;
export const HARD_RULE_FIELD_PHOTO_LIMIT = 4;
export const HARD_RULE_TRIAL_PHOTO_LIMIT = HARD_RULE_FIELD_PHOTO_LIMIT;
export const HARD_RULE_REVIEW_WINDOW_DAYS = 30;
export const HARD_RULE_VIEW_LABEL_MAX = 24;

/** 故障记录类检查项：样张应对上「实时故障 / 历史故障」，不另做页签闸门。 */
export function looksLikeFaultRecordItem(
  title?: string | null,
  extra?: string | null,
): boolean {
  return /上传故障|故障记录|实时故障|历史故障/.test(`${title || ""}\n${extra || ""}`);
}

const MAX_SAMPLE_URL_LEN = 1024;

export type HardRuleMatchContext = {
  title: string;
  description?: string;
  templateId?: string;
  entryId?: string;
};

export function splitHardRuleParts(raw: string | null | undefined): string[] {
  return String(raw || "")
    .split(/[|\n,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function catalogEntryKey(templateId: string, entryId: string) {
  return `${templateId}:${entryId}`;
}

export function takeLatestPhotos(urls: unknown, limit = HARD_RULE_FIELD_PHOTO_LIMIT): string[] {
  const list = (Array.isArray(urls) ? urls : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  return list.slice(-limit);
}

export type FieldPhotoQuota = {
  sampleCount: number;
  required: number;
  max: number;
  exact: boolean;
};

export function fieldPhotoQuota(tpl?: { samplePhotos?: string[] | null } | null): FieldPhotoQuota {
  const sampleCount = (tpl?.samplePhotos || []).map((url) => String(url || "").trim()).filter(Boolean).length;
  if (sampleCount > 0) {
    return { sampleCount, required: sampleCount, max: sampleCount, exact: true };
  }
  return { sampleCount: 0, required: 1, max: HARD_RULE_FIELD_PHOTO_LIMIT, exact: false };
}

/** 合格样有几张，现场/试跑少一张就不进模型，避免「一张图里看见两个页签」被当成拍齐。 */
export function failReasonIfShortOfRequiredShots(fieldCount: number, requiredCount: number): string | null {
  if (requiredCount < 2 || fieldCount >= requiredCount) return null;
  return `该检查项有 ${requiredCount} 张合格样，必须拍齐 ${requiredCount} 张独立照片。当前只有 ${fieldCount} 张。同一张截图里看见多个页签标题，只算拍了当前选中的那一页，缺的那一页一律不合格。`;
}

export function sanitizeViewLabel(raw: unknown): string {
  return String(raw || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, HARD_RULE_VIEW_LABEL_MAX);
}

export function fallbackViewLabel(index: number): string {
  return `视角${index + 1}`;
}

export function labeledPassViews(views: HardRulePassView[]): HardRulePassView[] {
  return views.map((item, index) => ({
    url: item.url,
    label: sanitizeViewLabel(item.label) || fallbackViewLabel(index),
  }));
}

export function passViewUrls(views: HardRulePassView[] | HardRuleSamples | null | undefined): string[] {
  if (!views) return [];
  const list = Array.isArray(views) ? views : views.pass;
  return list.map((item) => item.url).filter(Boolean);
}

/** covers 与待判定一一对应，值为合格样编号（从 1 起）或 0。缺任一种必拍图则不合格。 */
export function failReasonIfSlotsUncovered(views: HardRulePassView[], covers: number[]): string | null {
  const slots = labeledPassViews(views);
  if (slots.length < 2) return null;
  const filled = new Set<number>();
  for (const raw of covers) {
    const index = Number(raw);
    if (Number.isInteger(index) && index >= 1 && index <= slots.length) filled.add(index);
  }
  const missing = slots.filter((_, i) => !filled.has(i + 1));
  if (!missing.length) return null;
  return `现场图没有对上全部合格样：缺「${missing.map((item) => item.label).join("、")}」。同一种图拍两张不能代替其他必拍图。`;
}

function classifyFaultTab(raw: string): "realtime" | "historical" | "other" {
  const t = String(raw || "").toLowerCase();
  if (/实时|realtime|real[\s_-]?time/.test(t)) return "realtime";
  if (/历史|historical|history/.test(t)) return "historical";
  return "other";
}

/** 检查项/规则/样张名称里同时出现实时与历史故障时，走页签闸门。 */
export function ruleNeedsFaultTabs(title: string, ruleText: string, passLabels: string[] = []): boolean {
  const blob = [title, ruleText, ...passLabels].join("\n");
  return /实时故障/.test(blob) && /历史故障/.test(blob);
}

/** 故障记录类：两张必须分别是实时/历史；同页签拍两张不合格。 */
export function failReasonIfFaultTabsNotDistinct(
  parsed: Record<string, unknown>,
  opts: { title: string; ruleText: string; passLabels: string[]; photoCount: number },
): string | null {
  if (!ruleNeedsFaultTabs(opts.title, opts.ruleText, opts.passLabels)) return null;
  if (opts.photoCount < 2) return null;

  const evidence =
    parsed.evidence && typeof parsed.evidence === "object" && !Array.isArray(parsed.evidence)
      ? (parsed.evidence as Record<string, unknown>)
      : {};

  const rawTabs: string[] = [];
  if (Array.isArray(evidence.photoTypes)) {
    for (const item of evidence.photoTypes) rawTabs.push(String(item || ""));
  }
  if (Array.isArray(evidence.photoFindings)) {
    for (const row of evidence.photoFindings) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const finding = row as Record<string, unknown>;
      const tab = String(finding.selectedTab || finding.tab || finding.type || "");
      if (tab) rawTabs.push(tab);
    }
  }

  const classes = rawTabs.map(classifyFaultTab).filter((x) => x !== "other");
  if (classes.length >= 2) {
    const hasRealtime = classes.includes("realtime");
    const hasHistorical = classes.includes("historical");
    if (!hasRealtime || !hasHistorical) {
      return "两张待判定未分别覆盖「实时故障」与「历史故障」（看起来是同一种页签）。同一种截图拍两张不能合格。";
    }
    return null;
  }

  // 模型没给出逐张页签时，不允许直接放行
  const status = String(parsed.status || "").toLowerCase();
  if (status === "pass" || status === "合格") {
    return "未逐张标明当前选中页签（实时故障/历史故障），无法确认已拍齐两种页签，按不合格处理。";
  }
  return null;
}

export function parseCoverIndexes(raw: unknown, photoCount: number, views: HardRulePassView[] = []): number[] {
  const slots = labeledPassViews(views);
  const resolveOne = (item: unknown): number => {
    if (item == null) return 0;
    if (typeof item === "object" && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      return resolveOne(
        row.matchSample ?? row.sampleIndex ?? row.sample ?? row.view ?? row.label ?? row.value,
      );
    }
    if (typeof item === "string") {
      const text = item.trim();
      if (!text) return 0;
      if (!/^\d+$/.test(text)) {
        const hit = slots.findIndex(
          (slot) => slot.label === text || text.includes(slot.label) || slot.label.includes(text),
        );
        return hit >= 0 ? hit + 1 : 0;
      }
      const n = Number(text);
      return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    }
    const value = Number(item);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value));
  };

  // 支持 [{photoIndex:1,matchSample:2}, ...]（photoIndex 从 1 起）
  if (Array.isArray(raw) && raw.some((item) => item && typeof item === "object" && !Array.isArray(item))) {
    const out = Array.from({ length: photoCount }, () => 0);
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const photoRaw = Number(row.photoIndex ?? row.index ?? row.i);
      const match = resolveOne(row.matchSample ?? row.sampleIndex ?? row.sample ?? row.view ?? row.label);
      if (!Number.isInteger(photoRaw) || photoRaw < 1 || photoRaw > photoCount) continue;
      out[photoRaw - 1] = match;
    }
    if (out.some((n) => n > 0)) return out;
  }

  const list = Array.isArray(raw) ? raw : [];
  return Array.from({ length: photoCount }, (_, i) => resolveOne(list[i]));
}

function parseHintObject(hint: string | null | undefined): Record<string, unknown> | null {
  if (!hint) return null;
  try {
    const parsed = JSON.parse(hint) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function mapBinding(raw: unknown): HardRuleBinding | null {
  const row = (raw || {}) as Record<string, unknown>;
  const templateId = String(row.templateId || "").trim();
  const entryId = String(row.entryId || "").trim();
  const entryName = String(row.entryName || "").trim();
  if (!templateId || !entryId || !entryName) return null;
  return {
    templateId,
    entryId,
    templateName: String(row.templateName || "").trim(),
    entryName,
    productLineName: String(row.productLineName || "").trim(),
  };
}

function sanitizeOneUrl(raw: unknown): string {
  const url = String(raw || "").trim();
  if (!url || url.length > MAX_SAMPLE_URL_LEN) return "";
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

export function sanitizeSampleUrls(raw: unknown, limit = HARD_RULE_PASS_SAMPLE_LIMIT): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const item of list) {
    const url = typeof item === "object" && item ? sanitizeOneUrl((item as { url?: unknown }).url) : sanitizeOneUrl(item);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

export function sanitizePassViews(raw: unknown, limit = HARD_RULE_PASS_SAMPLE_LIMIT): HardRulePassView[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<string>();
  const views: HardRulePassView[] = [];
  for (const item of list) {
    const url =
      typeof item === "string" || typeof item === "number"
        ? sanitizeOneUrl(item)
        : sanitizeOneUrl((item as { url?: unknown } | null)?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const label =
      typeof item === "object" && item
        ? sanitizeViewLabel((item as { label?: unknown; name?: unknown }).label ?? (item as { name?: unknown }).name)
        : "";
    views.push({ url, label });
    if (views.length >= limit) break;
  }
  return views;
}

export function normalizeHardRuleSamples(raw: unknown): HardRuleSamples {
  const row = (raw || {}) as Record<string, unknown>;
  return {
    pass: sanitizePassViews(row.pass ?? row.passPhotoUrls ?? row.passSampleUrls ?? row.passSampleViews, HARD_RULE_PASS_SAMPLE_LIMIT),
    fail: sanitizeSampleUrls(row.fail ?? row.failPhotoUrls ?? row.failSampleUrls, HARD_RULE_FAIL_SAMPLE_LIMIT),
  };
}

export function parseHardRuleBindings(rule: HardRuleMatchInput): HardRuleBinding[] {
  const parsed = parseHintObject(rule.jsonSchemaHint ?? rule.json_schema_hint ?? "");
  if (!Array.isArray(parsed?.bindings)) return [];
  return parsed.bindings.map(mapBinding).filter((item): item is HardRuleBinding => Boolean(item));
}

export function parseHardRuleSamples(rule: HardRuleMatchInput | string | null | undefined): HardRuleSamples {
  const hint = typeof rule === "string" || rule == null ? rule : rule.jsonSchemaHint ?? rule.json_schema_hint ?? "";
  const parsed = parseHintObject(hint);
  return normalizeHardRuleSamples(parsed?.samples);
}

export function serializeHardRuleHint(input: {
  bindings?: HardRuleBinding[];
  samples?: HardRuleSamples | null;
}): string | null {
  const bindings = (input.bindings || []).map((item) => ({
    templateId: item.templateId,
    entryId: item.entryId,
    templateName: item.templateName,
    entryName: item.entryName,
    productLineName: item.productLineName || "",
  }));
  const samples = normalizeHardRuleSamples(input.samples);
  if (!bindings.length && !samples.pass.length && !samples.fail.length) return null;
  return JSON.stringify({ bindings, samples });
}

export function serializeHardRuleBindings(bindings: HardRuleBinding[], samples?: HardRuleSamples | null) {
  return serializeHardRuleHint({ bindings, samples }) || JSON.stringify({ bindings: [] });
}

export function bindingLabel(item: {
  entryName: string;
  templateName?: string;
  productLineName?: string;
}) {
  const scope = [item.templateName, item.productLineName].filter(Boolean).join(" · ");
  return scope ? `${item.entryName}（${scope}）` : item.entryName;
}

export function matchHardRule(rule: HardRuleMatchInput, ctx: HardRuleMatchContext | string, description = ""): boolean {
  const context: HardRuleMatchContext =
    typeof ctx === "string" ? { title: ctx, description } : { description: "", ...ctx };
  const bindings = parseHardRuleBindings(rule);
  if (bindings.length) {
    if (context.entryId && bindings.some((item) => item.entryId === context.entryId)) return true;
    if (
      context.templateId &&
      context.title &&
      bindings.some((item) => item.templateId === context.templateId && item.entryName === context.title)
    ) {
      return true;
    }
    return false;
  }

  const mode = rule.matchMode || rule.match_mode || "title_includes";
  const pattern = rule.matchPattern || rule.match_pattern || "";
  const hay = mode === "criteria_includes" ? `${context.title} ${context.description || ""}` : context.title;
  const parts = splitHardRuleParts(pattern);
  if (!parts.length) return false;
  if (mode === "title_exact") return parts.some((p) => hay === p);
  return parts.some((p) => hay.includes(p));
}
