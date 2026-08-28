import { adminGql } from "./hasura-admin";

type HardRule = {
  code: string;
  name: string;
  match_mode: string;
  match_pattern: string;
  prompt_text: string;
  enforce_mode: string;
};

function matchRule(rule: HardRule, title: string, description: string): boolean {
  const hay =
    rule.match_mode === "criteria_includes"
      ? `${title} ${description}`
      : title;
  const parts = rule.match_pattern.split("|").map((s) => s.trim()).filter(Boolean);
  if (rule.match_mode === "title_exact") {
    return parts.some((p) => hay === p);
  }
  return parts.some((p) => hay.includes(p));
}

function extractJson(text: string): { status?: string; reason?: string; confidence?: number } {
  const fenced = text.match(/\{[\s\S]*\}/);
  if (!fenced) return {};
  try {
    return JSON.parse(fenced[0]) as {
      status?: string;
      reason?: string;
      confidence?: number;
    };
  } catch {
    return {};
  }
}

export async function analyzePhotos(input: {
  title: string;
  description: string;
  photoUrls: string[];
}): Promise<{ status: "pass" | "fail" | "error"; confidence: number; reason: string; provider: string }> {
  const apiKey = (process.env.VISION_API_KEY || "").trim();
  const base = (process.env.VISION_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/$/, "");
  const model = process.env.VISION_MODEL || "Qwen/Qwen3-VL-8B-Instruct";

  if (!apiKey) {
    return {
      status: "pass",
      confidence: 0,
      reason: "未配置 VISION_API_KEY，开发环境返回模拟合格",
      provider: "mock",
    };
  }
  if (!input.photoUrls.length) {
    return { status: "fail", confidence: 0, reason: "未上传照片", provider: "siliconflow" };
  }

  const rulesData = await adminGql<{
    ai_hard_rules: HardRule[];
  }>(`query {
    ai_hard_rules(where: { enabled: { _eq: true } }) {
      code name match_mode match_pattern prompt_text enforce_mode
    }
  }`);
  const matched = rulesData.ai_hard_rules.filter(
    (r) => r.enforce_mode !== "off" && matchRule(r, input.title, input.description),
  );
  const ruleBlock = matched
    .map((r) => `- [${r.name}] ${r.prompt_text}`)
    .join("\n");

  const prompt = `你是光伏/储能现场质检员。根据照片判断检查项是否合格。
检查项：${input.title}
标准：${input.description}
${ruleBlock ? `硬规则：\n${ruleBlock}` : ""}
只输出 JSON：{"status":"pass 或 fail","confidence":0到1的数字,"reason":"中文理由"}`;

  const content: unknown[] = [{ type: "text", text: prompt }];
  for (const url of input.photoUrls.slice(0, 4)) {
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
      temperature: 0,
      max_tokens: 400,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    return {
      status: "error",
      confidence: 0,
      reason: `硅基流动调用失败：${res.status} ${t.slice(0, 200)}`,
      provider: "siliconflow",
    };
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = json.choices?.[0]?.message?.content || "";
  const parsed = extractJson(text);
  const status = parsed.status === "fail" ? "fail" : parsed.status === "pass" ? "pass" : "fail";
  return {
    status,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    reason: parsed.reason || text.slice(0, 200) || "模型未给出理由",
    provider: "siliconflow",
  };
}
