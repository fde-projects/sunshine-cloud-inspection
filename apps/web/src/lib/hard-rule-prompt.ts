import {
  normalizeHardRuleSamples,
  serializeHardRuleHint,
  splitHardRuleParts,
  type HardRuleBinding,
  type HardRuleSamples,
} from "./hard-rule-match";

export type HardRuleEnforceMode = "strict" | "normal" | "off";

const STRICT_LINE = "拿不准时必须判不合格，禁止猜测通过。";
const NOTES_HEAD = "判定补充";

export function composeHardRulePrompt(input: {
  name?: string;
  passCriteria?: string;
  failCriteria?: string;
  judgeNotes?: string;
  enforceMode?: string;
}): string {
  const name = String(input.name || "").trim() || "自定义检查";
  const pass = String(input.passCriteria || "").trim();
  const fail = String(input.failCriteria || "").trim();
  const notes = String(input.judgeNotes || "").trim();
  const lines = [`【${name}】`];
  if (pass) {
    lines.push("合格：", pass);
  }
  if (fail) {
    if (pass) lines.push("");
    lines.push("必须不合格：", fail);
  }
  if (notes) {
    if (pass || fail) lines.push("");
    lines.push(`${NOTES_HEAD}：`, notes);
  }
  if (input.enforceMode === "strict") {
    lines.push("", STRICT_LINE);
  }
  return lines.join("\n").trim();
}

/** 有多张合格样时，用「种类覆盖」写标准，避免旧版 A/B 每张都要锁紧点把样张自己否掉。 */
export function criteriaFromPassSamples(input: {
  title?: string;
  labels: string[];
}): { passCriteria: string; failCriteria: string } {
  const labels = input.labels.map((x) => String(x || "").trim()).filter(Boolean);
  const title = String(input.title || "").trim() || "该检查项";
  if (labels.length >= 2) {
    return {
      passCriteria: [
        `${title}：现场须拍齐 ${labels.length} 种视角，并达到上方合格样同级：${labels.join("、")}。`,
        "上传顺序不限，按画面内容对号即可；不同种类不算构图重复。",
        "达到对应合格样同级即合格，不额外要求合格样里看不清或没有的细节。",
        "各类证据由不同照片分担（例如整机看安装关系，抱箍看锁紧点，线缆看接线），禁止要求每一张同时满足所有要点。",
      ].join("\n"),
      failCriteria: [
        `缺「${labels.join("、")}」中任一种、两张都属同一种、明显差于对应合格样，或设备倾斜/支架开裂/螺母明显未压实 → 不合格。`,
        "拿不准是否已拍齐全部种类时，按不合格处理。",
      ].join("\n"),
    };
  }
  return {
    passCriteria: `${title}：按合格样视角拍摄，关键部位清晰、不遮挡。`,
    failCriteria: "缺必要视角、看不清判定点、照片重复或可见明显缺陷 → 不合格。",
  };
}

/** 旧版安装固定类文案：容易与「多张合格样分工」冲突。 */
export function looksLikeLegacyMountCriteria(text: string): boolean {
  const t = String(text || "");
  return (
    /mountPointsVisible|multiAngleCoverage|两类证据|A\)\s*整机|B\)\s*固定点/.test(t) &&
    /每一张|同时具备|缺一不可|锁紧螺母本体/.test(t)
  );
}

function stripStrictLine(value: string) {
  return value.replace(new RegExp(`\\n*${STRICT_LINE}\\s*$`), "").trim();
}

export function parseHardRulePrompt(promptText: string | null | undefined): {
  passCriteria: string;
  failCriteria: string;
  judgeNotes: string;
  structured: boolean;
} {
  const text = String(promptText || "").replace(/\r\n/g, "\n").trim();
  if (!text) return { passCriteria: "", failCriteria: "", judgeNotes: "", structured: false };

  const notesRe = new RegExp(`(?:^|\\n)${NOTES_HEAD}[：:]\\s*([\\s\\S]*)$`);
  const notesHit = text.match(notesRe);
  const withoutNotes = notesHit
    ? text.slice(0, notesHit.index).replace(/\n+$/, "")
    : text;
  const judgeNotes = stripStrictLine(notesHit?.[1] || "");

  const passNew = withoutNotes.match(/(?:^|\n)合格[：:]\s*([\s\S]*?)(?=\n必须不合格[：:]|$)/);
  const failNew = withoutNotes.match(/\n必须不合格[：:]\s*([\s\S]*)$/);
  if (passNew && failNew) {
    return {
      passCriteria: stripStrictLine(passNew[1] || ""),
      failCriteria: stripStrictLine(failNew[1] || ""),
      judgeNotes,
      structured: true,
    };
  }

  const lines = withoutNotes.split("\n");
  let passStart = -1;
  let failStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (passStart < 0 && /^合格[：:]/.test(line)) passStart = i;
    if (failStart < 0 && /^不合格/.test(line)) failStart = i;
  }
  if (passStart >= 0 || failStart >= 0) {
    const slice = (from: number, until: number) => {
      if (from < 0) return "";
      const first = lines[from].replace(/^合格[：:]\s*|^不合格[^：\n]*[：:]?\s*/, "");
      const rest = lines.slice(from + 1, until).join("\n");
      return stripStrictLine([first, rest].filter(Boolean).join("\n"));
    };
    return {
      passCriteria: slice(passStart, failStart >= 0 ? failStart : lines.length),
      failCriteria: slice(failStart, lines.length),
      judgeNotes,
      structured: true,
    };
  }

  if (judgeNotes) {
    return { passCriteria: "", failCriteria: "", judgeNotes, structured: true };
  }
  return { passCriteria: "", failCriteria: "", judgeNotes: "", structured: false };
}

/** 旧版整段正文拆进两栏；拆不出结构时把全文放入合格，并补一条通用不合格。 */
export function hydrateCriteriaFromPrompt(promptText: string | null | undefined): {
  passCriteria: string;
  failCriteria: string;
  judgeNotes: string;
  structured: boolean;
  source: "structured" | "legacy" | "empty";
} {
  const parsed = parseHardRulePrompt(promptText);
  if (parsed.passCriteria || parsed.failCriteria || parsed.judgeNotes) {
    return { ...parsed, source: "structured" };
  }
  const text = String(promptText || "").replace(/\r\n/g, "\n").trim();
  if (!text) {
    return {
      passCriteria: "",
      failCriteria: "",
      judgeNotes: "",
      structured: false,
      source: "empty",
    };
  }
  const body = text.replace(/^【[^】]+】\s*\n?/, "").trim();
  const failAt = body.search(/\n(?:不合格|必须\s*fail|禁止放行|拿不准.*不合格)/i);
  if (failAt > 20) {
    return {
      passCriteria: body.slice(0, failAt).trim(),
      failCriteria: body.slice(failAt).replace(/^\n/, "").trim(),
      judgeNotes: "",
      structured: true,
      source: "legacy",
    };
  }
  return {
    passCriteria: body,
    failCriteria: "缺关键证据、视角不完整、照片重复或看不清判定点时必须不合格。",
    judgeNotes: "",
    structured: true,
    source: "legacy",
  };
}

function resolveSamples(input: {
  samples?: unknown;
  passSampleUrls?: unknown;
  passSampleViews?: unknown;
  failSampleUrls?: unknown;
}): HardRuleSamples {
  if (input.samples !== undefined) return normalizeHardRuleSamples(input.samples);
  return normalizeHardRuleSamples({
    pass: input.passSampleViews ?? input.passSampleUrls,
    fail: input.failSampleUrls,
  });
}

export function resolveHardRuleMatch(input: {
  bindings?: unknown;
  entryNames?: unknown;
  extraKeywords?: unknown;
  matchMode?: unknown;
  matchPattern?: unknown;
  samples?: unknown;
  passSampleUrls?: unknown;
  passSampleViews?: unknown;
  failSampleUrls?: unknown;
}): {
  matchMode: "title_exact" | "title_includes" | "criteria_includes";
  matchPattern: string;
  jsonSchemaHint: string | null;
} {
  const samples = resolveSamples(input);
  const hintFor = (bindings: HardRuleBinding[]) => serializeHardRuleHint({ bindings, samples });
  const bindings = Array.isArray(input.bindings)
    ? input.bindings
        .map((raw) => {
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
          } satisfies HardRuleBinding;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
    : [];
  if (bindings.length) {
    return {
      matchMode: "title_exact",
      matchPattern: bindings.map((item) => item.entryName).join("|"),
      jsonSchemaHint: hintFor(bindings),
    };
  }
  const entries = Array.isArray(input.entryNames)
    ? input.entryNames.map((x) => String(x || "").trim()).filter(Boolean)
    : [];
  const extras = splitHardRuleParts(String(input.extraKeywords || ""));
  const parts = [...entries, ...extras];
  if (parts.length) {
    return {
      matchMode: extras.length ? "criteria_includes" : "title_exact",
      matchPattern: parts.join("|"),
      jsonSchemaHint: hintFor([]),
    };
  }
  const fallback = String(input.matchPattern || "").trim();
  if (fallback) {
    const mode = input.matchMode;
    if (mode === "title_exact" || mode === "title_includes" || mode === "criteria_includes") {
      return { matchMode: mode, matchPattern: fallback, jsonSchemaHint: hintFor([]) };
    }
    return { matchMode: "title_includes", matchPattern: fallback, jsonSchemaHint: hintFor([]) };
  }
  throw new Error("请选择要套用的检查项");
}
