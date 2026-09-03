import { adminGql } from "./hasura-admin";
import {
  failReasonIfShortOfRequiredShots,
  failReasonIfSlotsUncovered,
  failReasonIfFaultTabsNotDistinct,
  fallbackViewLabel,
  HARD_RULE_FAIL_SAMPLE_LIMIT,
  HARD_RULE_PASS_SAMPLE_LIMIT,
  HARD_RULE_VIEW_LABEL_MAX,
  labeledPassViews,
  matchHardRule,
  parseCoverIndexes,
  parseHardRuleSamples,
  ruleNeedsFaultTabs,
  sanitizePassViews,
  sanitizeSampleUrls,
  sanitizeViewLabel,
  takeLatestPhotos,
  type HardRulePassView,
} from "./hard-rule-match";
import { visionGateLabel, type VisionGate } from "./hard-rule-pipeline";

export type VisionAnalyzeResult = {
  status: "pass" | "fail" | "error";
  confidence: number;
  reason: string;
  provider: string;
  gate: VisionGate;
  gateLabel: string;
};

function visionResult(
  input: Omit<VisionAnalyzeResult, "gateLabel"> & { gateLabel?: string },
): VisionAnalyzeResult {
  return {
    ...input,
    gateLabel: input.gateLabel || visionGateLabel(input.gate),
  };
}

type HardRule = {
  code: string;
  name: string;
  match_mode: string;
  match_pattern: string;
  prompt_text: string;
  json_schema_hint?: string | null;
  enforce_mode: string;
};

function extractJson(text: string): Record<string, unknown> {
  const fenced = text.match(/\{[\s\S]*\}/);
  if (!fenced) return {};
  try {
    return JSON.parse(fenced[0]) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 模型常把 status 与 reason 最后结论写反；以理由末尾结论为准对齐 status。 */
export function reconcileStatusWithReason(
  status: "pass" | "fail",
  reason: string,
): "pass" | "fail" {
  const t = reason.trim();
  if (!t) return status;
  const tail = t.slice(-80);
  // 先认不合格结论，避免「不能判合格」被合格规则误伤
  const failTail =
    /因此不合格|故不合格|判定为不合格|结论[:：]\s*不合格|必须判\s*fail|不能判合格|不算合格|并非合格|不合格[。．!！]?$/i.test(
      tail,
    );
  if (failTail) return "fail";
  const passTail =
    /因此[^。；;]{0,24}合格|故合格|判定为合格|结论[:：]\s*合格|(?:本检查项|此项|该项)合格|必须判\s*pass|合格[。．!！]?$/i.test(
      tail,
    );
  if (passTail) return "pass";
  return status;
}

function uniqueUrls(urls: string[], limit: number) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

/** 多视角对号专用：只问 covers，避免和合格/不合格总判搅在一起（左/背/右易糊）。 */
async function assignCoversByVision(input: {
  apiKey: string;
  base: string;
  model: string;
  title: string;
  passViews: HardRulePassView[];
  fieldPhotos: string[];
}): Promise<number[]> {
  const { passViews, fieldPhotos } = input;
  const slotLine = passViews.map((item, i) => `${i + 1}=${item.label}`).join("，");
  const prompt = `你只做「视角对号」，不要判断最终合格/不合格。
检查项：${input.title}
合格样编号：${slotLine}
待判定共 ${fieldPhotos.length} 张（顺序可与合格样不同）。
要求：
1. covers 长度必须等于待判定张数；covers[i] 是第 i 张待判定最接近的合格样编号，对不上填 0。
2. 左/右/背面、整机/抱箍/线缆等相近视角必须区分：看电杆在画面左还是右、是否看见柜门/警示贴、是否看见抱箍锁紧点、线缆特写还是整机。
3. 禁止图省事把多张都标成同一个编号，除非画面真的几乎同一视角。
4. why 里用一句话写出每张的对号依据（朝向/部件）。
只输出 JSON：{"covers":[与待判定张数相同的编号],"why":["图1→…","图2→…"]}`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  passViews.forEach((item, i) => {
    content.push({
      type: "text",
      text: `【合格样 ${i + 1}=${item.label}】请记住编号 ${i + 1}`,
    });
    content.push({ type: "image_url", image_url: { url: item.url } });
  });
  fieldPhotos.forEach((url, i) => {
    content.push({
      type: "text",
      text: `【待判定第 ${i + 1} 张】请填 covers[${i}]`,
    });
    content.push({ type: "image_url", image_url: { url } });
  });

  const res = await fetch(`${input.base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`,
    },
    body: JSON.stringify({
      model: input.model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 400,
    }),
  });
  if (!res.ok) return Array.from({ length: fieldPhotos.length }, () => 0);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const parsed = extractJson(json.choices?.[0]?.message?.content || "");
  return parseCoverIndexes(parsed.covers, fieldPhotos.length, passViews);
}

export async function analyzePhotos(input: {
  title: string;
  description: string;
  photoUrls: string[];
  templateId?: string;
  entryId?: string;
  samplePassUrls?: string[];
  sampleFailUrls?: string[];
  samplePassViews?: HardRulePassView[];
  ruleOverride?: {
    name: string;
    promptText: string;
    enforceMode?: string;
    samplePassUrls?: string[];
    sampleFailUrls?: string[];
    samplePassViews?: HardRulePassView[];
  };
}): Promise<VisionAnalyzeResult> {
  const apiKey = (process.env.VISION_API_KEY || "").trim();
  const base = (process.env.VISION_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
  const model = process.env.VISION_MODEL || "Qwen/Qwen3-VL-8B-Instruct";

  if (!input.photoUrls.length) {
    return visionResult({
      status: "fail",
      confidence: 0,
      reason: "未上传照片",
      provider: "siliconflow",
      gate: "no_photos",
    });
  }

  let ruleBlock = "";
  let strict = false;
  let samplePass = sanitizePassViews(
    input.ruleOverride?.samplePassViews ??
      input.samplePassViews ??
      input.ruleOverride?.samplePassUrls ??
      input.samplePassUrls,
    HARD_RULE_PASS_SAMPLE_LIMIT,
  );
  let sampleFail = uniqueUrls(
    sanitizeSampleUrls(input.ruleOverride?.sampleFailUrls ?? input.sampleFailUrls, HARD_RULE_FAIL_SAMPLE_LIMIT),
    HARD_RULE_FAIL_SAMPLE_LIMIT,
  );
  if (input.ruleOverride?.promptText) {
    ruleBlock = `- [${input.ruleOverride.name}] ${input.ruleOverride.promptText}`;
    strict = input.ruleOverride.enforceMode === "strict";
  } else {
    const rulesData = await adminGql<{
      ai_hard_rules: HardRule[];
    }>(`query {
    ai_hard_rules(where: { enabled: { _eq: true } }) {
      code name match_mode match_pattern prompt_text json_schema_hint enforce_mode
    }
  }`);
    const matched = rulesData.ai_hard_rules.filter(
      (r) =>
        r.enforce_mode !== "off" &&
        matchHardRule(r, {
          title: input.title,
          description: input.description,
          templateId: input.templateId,
          entryId: input.entryId,
        }),
    );
    ruleBlock = matched.map((r) => `- [${r.name}] ${r.prompt_text}`).join("\n");
    strict = matched.some((r) => r.enforce_mode === "strict");
    if (!samplePass.length && !sampleFail.length) {
      const collectedPass: HardRulePassView[] = [];
      const collectedFail: string[] = [];
      for (const rule of matched) {
        const samples = parseHardRuleSamples(rule);
        collectedPass.push(...samples.pass);
        collectedFail.push(...samples.fail);
      }
      samplePass = sanitizePassViews(collectedPass, HARD_RULE_PASS_SAMPLE_LIMIT);
      sampleFail = uniqueUrls(collectedFail, HARD_RULE_FAIL_SAMPLE_LIMIT);
    }
  }

  const fieldPhotos = takeLatestPhotos(input.photoUrls);
  const passViews = labeledPassViews(samplePass);
  const shortReason = failReasonIfShortOfRequiredShots(fieldPhotos.length, passViews.length);
  if (shortReason) {
    return visionResult({
      status: "fail",
      confidence: 1,
      reason: shortReason,
      provider: "rule",
      gate: "short_of_shots",
    });
  }
  if (!apiKey) {
    return visionResult({
      status: "pass",
      confidence: 0,
      reason: "未配置 VISION_API_KEY，开发环境返回模拟合格（未对照样张）",
      provider: "mock",
      gate: "mock",
    });
  }

  const hasRefs = passViews.length + sampleFail.length > 0;
  if (passViews.length >= 2) {
    const slotNames = passViews.map((item, i) => `${i + 1}=${item.label}`).join("，");
    const priority = [
      `【多视角对照优先】合格样：${slotNames}。covers 盖全每一种即可。`,
      "每张待判定只对照自己对上的那一种合格样，不得拿别种样张的要求来卡（例如对上「线缆」的图不必看见抱箍/螺栓）。",
      "禁止要求每一张同时满足所有要点。",
    ].join("");
    ruleBlock = ruleBlock ? `${priority}\n${ruleBlock}` : priority;
  }
  const needFaultTabs = ruleNeedsFaultTabs(
    input.title,
    ruleBlock,
    passViews.map((v) => v.label),
  );
  const slotLine =
    passViews.length >= 2
      ? [
          `合格样共 ${passViews.length} 种拍摄类型，编号 1 到 ${passViews.length}：${passViews
            .map((item, i) => `${i + 1}=${item.label}`)
            .join("，")}。`,
          "covers 与待判定照片一一对应：第 i 个元素表示「第 i 张待判定」对上了哪一种合格样（填编号），对不上填 0。",
          "重要：待判定上传顺序可以和合格样顺序不同，必须按画面内容对号，禁止默认按序号写成 [1,2,3…]。",
          `对号示例：若合格样是 ${passViews
            .map((item, i) => `${i + 1}=${item.label}`)
            .join("、")}，而待判定先拍了「${passViews[passViews.length - 1]?.label}」再拍「${passViews[0]?.label}」，则 covers 前两项应是 [${passViews.length},1,…]，而不是 [1,2,…]。`,
          "每种合格样都必须被至少一张待判定对上；两张都像同一种则 covers 写成同一编号（如[1,1]），status 必须 fail。禁止为凑数把同一种图标成不同编号。",
          "左/右/背面固定等相近视角：必须仔细区分设备朝向、电杆前后关系、可见面板，禁止图省事全部标成同一种。",
        ].join("")
      : "";
  const faultLine = needFaultTabs
    ? `故障页签专项：逐张只认「当前选中」的页签（高亮/下划线/填充色），未选中页签上的标题不算已拍。两张都必须分别是实时故障与历史故障；两张都是历史或都是实时 → fail。evidence.photoTypes 必须与待判定张数相同，取值只能是 realtime / historical / other；也可在 evidence.photoFindings 里写 selectedTab。`
    : "";
  const jsonExtra = [
    passViews.length >= 2
      ? `,"covers":[按内容对号的合格样编号，长度=待判定张数，顺序可变]`
      : "",
    needFaultTabs
      ? `,"evidence":{"photoTypes":["realtime或historical或other", "..."],"photoFindings":[{"photoIndex":1,"selectedTab":"实时故障或历史故障","note":"选中态依据"}]}`
      : "",
  ].join("");
  const prompt = `你是光伏/储能现场质检员。根据照片判断检查项是否合格。
检查项：${input.title}
标准：${input.description}
${ruleBlock ? `硬规则：\n${ruleBlock}` : ""}
${hasRefs ? "下面先给出管理员标注的对照样张，再给出待判定照片。现场图通常是重新拍摄或从相册上传，地址一定与合格样不同，必须以画面内容对照，禁止因「不是同一文件地址」判 fail。" : ""}
${hasRefs ? "及格线=合格样画面：待判定达到与某张合格样同级（同视角、关键部位清晰度相当）即应对上该合格样。禁止额外要求合格样里看不清或没有的细节（例如合格样未清晰出现「PE」字样，就不得以未见PE字样否决）。" : ""}
${hasRefs ? "判定步骤：①先给每张待判定填 covers（对上的合格样编号，顺序可变）；②确认每种合格样都被至少一张对上；③再对照不合格样与硬规则文字。若①②已满足且待判定未明显差于对应合格样，status 必须 pass。" : ""}
${hasRefs ? "若某张待判定与某张合格样画面实质相同（同场景同角度同内容，即使重新拍照/压缩），必须对上该合格样；整组对齐全部分合格样且未明显更差时必须 pass，不得再用构图重复、缺标识等细则否决。" : ""}
${strict ? "判定纪律：相对合格样明显更差、缺某一类必拍视角、或拿不准必须判 fail。不同拍摄类型不算构图重复。" : ""}
必须看完每一张待判定照片再下结论，禁止只根据第一张判定。
页签或按钮上的标题不等于已经拍了那一页：必须单独截到点开后的内容。一张图里同时看见「实时故障」和「历史故障」等标题，只算当前选中的那一页，未点开的那一页视为缺失，必须 fail。
${slotLine}
${faultLine}
status 必须与 reason 最后一句一致：理由写不合格则 status 必须是 fail，写合格则必须是 pass。
只输出 JSON：{"status":"pass 或 fail","confidence":0到1的数字,"reason":"中文理由，最后一句写合格或不合格"${jsonExtra}}`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  passViews.forEach((item, i) => {
    content.push({
      type: "text",
      text: `【对照·合格样 ${i + 1}/${passViews.length}：${item.label}】（类型编号 ${i + 1}，供 covers 对号）`,
    });
    content.push({ type: "image_url", image_url: { url: item.url } });
  });
  for (const url of sampleFail) {
    content.push({ type: "text", text: "【对照·不合格样】" });
    content.push({ type: "image_url", image_url: { url } });
  }
  if (hasRefs) {
    content.push({
      type: "text",
      text: `【待判定照片，共 ${fieldPhotos.length} 张，须全部查看；顺序可与合格样不同，请按内容填写 covers】`,
    });
  }
  fieldPhotos.forEach((url, i) => {
    content.push({
      type: "text",
      text: `【待判定第 ${i + 1}/${fieldPhotos.length} 张】（covers[${i}] = 本张对上的合格样编号，勿默认填 ${i + 1}）`,
    });
    content.push({ type: "image_url", image_url: { url } });
  });

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 800,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return visionResult({
      status: "error",
      confidence: 0,
      reason: `硅基流动调用失败：${res.status} ${t.slice(0, 200)}`,
      provider: "siliconflow",
      gate: "vision_error",
    });
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content || "";
  const parsed = extractJson(text);
  const reason = String(parsed.reason || text.slice(0, 200) || "模型未给出理由");
  let covers = parseCoverIndexes(parsed.covers, fieldPhotos.length, passViews);
  let coverHits = covers.filter((n) => n > 0).length;
  let uncovered = failReasonIfSlotsUncovered(passViews, covers);
  // 总判里 covers 常把左/背/右糊成一种：缺种类时再单独做一次对号（样张试跑与现场重拍同一路径）
  if (uncovered && passViews.length >= 2 && fieldPhotos.length >= 2) {
    const retry = await assignCoversByVision({
      apiKey,
      base,
      model,
      title: input.title,
      passViews,
      fieldPhotos,
    });
    const retryHits = retry.filter((n) => n > 0).length;
    if (retryHits >= coverHits) {
      covers = retry;
      coverHits = retryHits;
      uncovered = failReasonIfSlotsUncovered(passViews, covers);
    }
  }
  const rawStatus = parsed.status === "fail" ? "fail" : parsed.status === "pass" ? "pass" : "fail";
  if (uncovered) {
    if (coverHits > 0 || rawStatus === "pass") {
      return visionResult({
        status: "fail",
        confidence: 1,
        reason: uncovered,
        provider: "siliconflow",
        gate: "cover_uncovered",
      });
    }
  }
  const faultTabs = failReasonIfFaultTabsNotDistinct(parsed, {
    title: input.title,
    ruleText: ruleBlock,
    passLabels: passViews.map((item) => item.label),
    photoCount: fieldPhotos.length,
  });
  if (faultTabs) {
    return visionResult({
      status: "fail",
      confidence: 1,
      reason: faultTabs,
      provider: "siliconflow",
      gate: "fault_tabs",
    });
  }

  const usedFailSample = fieldPhotos.some((url) => sampleFail.includes(url));
  // 种类已盖全时：若模型因「这张没拍到另一种的细节」误杀，纠正为合格，但仍保留模型原话。
  // 试跑里若夹了不合格样原图，或写了倾斜/开裂/未压实，不纠正。
  if (passViews.length >= 2 && !uncovered && !usedFailSample) {
    const filled = new Set(
      covers.filter((n) => Number.isInteger(n) && n >= 1 && n <= passViews.length),
    );
    if (filled.size >= passViews.length) {
      const hardDefect =
        /整机倾斜|设备倾斜|支架开裂|支架断裂|脱落|未压实|未压住垫片|未压住横担|相对支架移位|更接近不合格样/.test(
          reason,
        );
      const crossTypeNit =
        /看不见抱箍|看不清抱箍|未清晰显示固定点|不能看见固定点|至少需要 2 张|A\s*类|B\s*类|multiAngleCoverage/.test(
          reason,
        );
      if (rawStatus === "fail" && !hardDefect && crossTypeNit) {
        return visionResult({
          status: "pass",
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.9,
          reason,
          provider: "siliconflow",
          gate: "nit_override_pass",
        });
      }
    }
  }

  return visionResult({
    status: reconcileStatusWithReason(rawStatus, reason),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    reason,
    provider: "siliconflow",
    gate: "model",
  });
}

export async function draftRuleFromSamples(input: {
  name: string;
  title: string;
  description?: string;
  passPhotoUrls: string[];
  failPhotoUrls: string[];
  failNote?: string;
}): Promise<{ passCriteria: string; failCriteria: string; provider: string }> {
  const apiKey = (process.env.VISION_API_KEY || "").trim();
  const base = (process.env.VISION_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
  const model = process.env.VISION_MODEL || "Qwen/Qwen3-VL-8B-Instruct";
  const passUrls = input.passPhotoUrls.filter(Boolean).slice(0, HARD_RULE_PASS_SAMPLE_LIMIT);
  const failUrls = input.failPhotoUrls.filter(Boolean).slice(0, HARD_RULE_FAIL_SAMPLE_LIMIT);
  if (!passUrls.length && !failUrls.length) {
    throw new Error("请至少上传一张合格或不合格样张");
  }

  if (!apiKey) {
    const note = String(input.failNote || "").trim();
    return {
      passCriteria: `以合格样张为准：能看清「${input.title || input.name}」要求的关键部位，视角完整、不遮挡、不重复连拍。`,
      failCriteria: note
        ? `与合格样差异明显：${note}。关键部位看不清、只拍局部或缺必要视角，必须不合格。`
        : "与合格样差异明显：关键部位看不清、只拍局部、缺必要视角或照片重复，必须不合格。",
      provider: "mock",
    };
  }

  const prompt = `你是光伏/储能现场质检规则撰写员。下面照片已由管理员标注合格或不合格。
检查项：${input.title || input.name}
补充说明：${input.description || "无"}
${input.failNote ? `管理员认为不合格的原因：${input.failNote}` : ""}
请对比合格样与不合格样的可见差异，用白话写出可执行的判定标准。
要求：只写照片里能看见的东西；不要编造没出现的零件；不合格必须写清“看见什么就 fail”。
只输出 JSON：{"passCriteria":"合格标准，可分点","failCriteria":"不合格标准，可分点"}`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const url of passUrls) {
    content.push({ type: "text", text: "【合格样张】" });
    content.push({ type: "image_url", image_url: { url } });
  }
  for (const url of failUrls) {
    content.push({ type: "text", text: "【不合格样张】" });
    content.push({ type: "image_url", image_url: { url } });
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: 0.2,
      max_tokens: 800,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`硅基流动调用失败：${res.status} ${t.slice(0, 200)}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content || "";
  const parsed = extractJson(text) as { passCriteria?: string; failCriteria?: string };
  const passCriteria = String(parsed.passCriteria || "").trim();
  const failCriteria = String(parsed.failCriteria || "").trim();
  if (!passCriteria && !failCriteria) {
    throw new Error("模型未生成可用草稿，请换几张更清楚的样张再试");
  }
  return { passCriteria, failCriteria, provider: "siliconflow" };
}

function uniquifyViewLabels(labels: string[]): string[] {
  const seen = new Map<string, number>();
  return labels.map((raw, index) => {
    const base = sanitizeViewLabel(raw) || fallbackViewLabel(index);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    if (count === 1) return base;
    return sanitizeViewLabel(`${base}${count}`) || fallbackViewLabel(index);
  });
}

/** 给合格样自动起短名字，管理员可再改。多张必须能区分。 */
export async function suggestPassViewLabels(input: {
  title?: string;
  views: HardRulePassView[];
}): Promise<{ labels: string[]; provider: string }> {
  const views = sanitizePassViews(input.views, HARD_RULE_PASS_SAMPLE_LIMIT);
  if (!views.length) return { labels: [], provider: "none" };
  const fallback = uniquifyViewLabels(views.map((item, index) => item.label || fallbackViewLabel(index)));
  const apiKey = (process.env.VISION_API_KEY || "").trim();
  const base = (process.env.VISION_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
  const model = process.env.VISION_MODEL || "Qwen/Qwen3-VL-8B-Instruct";
  if (!apiKey) return { labels: fallback, provider: "mock" };

  const prompt = `你是现场质检配图助手。给下面每张「合格样」起一个短名字（2到${HARD_RULE_VIEW_LABEL_MAX}个字）。
检查项：${input.title || "检查项"}
要求：只写照片里能看见的视角或页签，例如「实时故障」「历史故障」「整机」「抱箍」。不要编造图上没有的词。多张图若不是同一视角，名字必须能区分开。已有名字尽量沿用，重名则改后一张。
只输出 JSON：{"labels":["与样张顺序相同的短名字"]}`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  views.forEach((item, i) => {
    const current = item.label ? `，已有名字「${item.label}」` : "";
    content.push({ type: "text", text: `【合格样 ${i + 1}/${views.length}${current}】` });
    content.push({ type: "image_url", image_url: { url: item.url } });
  });

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      temperature: 0,
      max_tokens: 200,
    }),
  });
  if (!res.ok) return { labels: fallback, provider: "siliconflow" };
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const parsed = extractJson(json.choices?.[0]?.message?.content || "");
  const raw = Array.isArray(parsed.labels) ? parsed.labels.map((item) => sanitizeViewLabel(item)) : [];
  if (raw.length !== views.length || raw.some((item) => !item)) {
    return { labels: fallback, provider: "siliconflow" };
  }
  return { labels: uniquifyViewLabels(raw), provider: "siliconflow" };
}

async function callVisionJson(prompt: string, imageUrl: string): Promise<{
  parsed: Record<string, unknown>;
  rawText: string;
  provider: string;
}> {
  const apiKey = (process.env.VISION_API_KEY || "").trim();
  const base = (process.env.VISION_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
  const model = process.env.VISION_MODEL || "Qwen/Qwen3-VL-8B-Instruct";
  if (!apiKey) {
    return { parsed: {}, rawText: "", provider: "mock" };
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 300,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return {
      parsed: {},
      rawText: `vision_error:${res.status}:${t.slice(0, 120)}`,
      provider: "siliconflow",
    };
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = json.choices?.[0]?.message?.content || "";
  return { parsed: extractJson(text), rawText: text, provider: "siliconflow" };
}

/** 里程表 OCR：读出公里数，失败时 mileage 为 null（前端可手填） */
export async function ocrMileageFromImage(imageUrl: string, kind: "start" | "end" | string = "start") {
  const { parsed, rawText, provider } = await callVisionJson(
    `这是汽车/工程车里程表照片（${kind === "end" ? "结束" : "开始"}里程）。
请识别表上当前显示的总里程数字（单位 km）。忽略小数位以外的干扰字符。
只输出 JSON：{"mileage":数字或null,"confidence":0到1,"rawText":"你看到的数字原文"}`,
    imageUrl,
  );
  const mileageRaw = parsed.mileage;
  const mileage =
    typeof mileageRaw === "number"
      ? mileageRaw
      : typeof mileageRaw === "string" && mileageRaw.trim()
        ? Number(mileageRaw.replace(/[^\d.]/g, ""))
        : null;
  const confidence =
    typeof parsed.confidence === "number" ? parsed.confidence : mileage != null && !Number.isNaN(mileage) ? 0.6 : 0;
  return {
    mileage: mileage != null && !Number.isNaN(mileage) ? mileage : null,
    confidence,
    rawText: String(parsed.rawText || rawText || "").slice(0, 200),
    kind,
    provider,
  };
}

/** 设备铭牌/机身序列号 OCR */
export async function ocrDeviceSerialFromImage(imageUrl: string) {
  const { parsed, rawText, provider } = await callVisionJson(
    `这是光伏/储能设备铭牌或机身序列号照片。
请识别设备序列号（Serial Number / SN），去掉空格，保留字母数字与常见分隔符。
只输出 JSON：{"serial":"序列号或空字符串","confidence":0到1,"rawText":"原文"}`,
    imageUrl,
  );
  const serial = String(parsed.serial || "")
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
  const confidence =
    typeof parsed.confidence === "number" ? parsed.confidence : serial.length >= 4 ? 0.6 : 0;
  return {
    serial: serial.length >= 4 ? serial : null,
    confidence,
    rawText: String(parsed.rawText || rawText || "").slice(0, 200),
    provider,
  };
}
