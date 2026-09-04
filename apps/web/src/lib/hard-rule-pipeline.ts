import type { HardRulePassView } from "./hard-rule-match";

export type VisionGate =
  | "no_photos"
  | "short_of_shots"
  | "mock"
  | "cover_uncovered"
  | "fault_tabs"
  | "nit_override_pass"
  | "vision_error"
  | "model";

export const VISION_GATE_LABEL: Record<VisionGate, string> = {
  no_photos: "请先上传照片",
  short_of_shots: "照片张数与合格样不一致",
  mock: "开发模拟（未配识图密钥）",
  cover_uncovered: "引擎拦截 · 视角未盖全",
  fault_tabs: "引擎拦截 · 故障页签未拍齐",
  nit_override_pass: "引擎纠正 · 误杀改合格",
  vision_error: "识图接口失败",
  model: "模型判定",
};

export type PipelineLayer = "match" | "engine" | "model" | "post";

export type PipelineStep = {
  id: string;
  title: string;
  active: boolean;
  layer: PipelineLayer;
  detail: string;
};

export function visionGateLabel(gate: VisionGate | string | undefined | null): string {
  if (!gate) return VISION_GATE_LABEL.model;
  return VISION_GATE_LABEL[gate as VisionGate] || String(gate);
}

export function describeHardRulePipeline(input: {
  enabled?: boolean;
  enforceMode?: string;
  boundLabel?: string;
  keywordFallback?: string;
  passViews?: Array<Pick<HardRulePassView, "label"> | string>;
  failCount?: number;
}): PipelineStep[] {
  const enabled = input.enabled !== false && input.enforceMode !== "off";
  const passViews = (input.passViews || []).map((item, i) =>
    typeof item === "string" ? { label: item || `视角${i + 1}` } : { label: item.label || `视角${i + 1}` },
  );
  const kinds = passViews.map((item) => item.label).filter(Boolean);
  const kindCount = kinds.length;
  const coverGate = kindCount >= 2;
  const bound = String(input.boundLabel || "").trim();
  const keyword = String(input.keywordFallback || "").trim();

  const steps: PipelineStep[] = [
    {
      id: "match",
      title: bound ? "按检查项绑定" : keyword ? "按关键词匹配" : "尚未匹配检查项",
      active: enabled && Boolean(bound || keyword),
      layer: "match",
      detail: bound
        ? bound
        : keyword
          ? `标题含「${keyword}」才套用。检查项改名后可能套不上，请改成绑定检查项。`
          : "请先选择检查项，否则现场分析不会套这条规则。",
    },
    {
      id: "samples",
      title: kindCount ? `合格样 ${kindCount} 种` : "还没有合格样",
      active: enabled && kindCount > 0,
      layer: "match",
      detail: kindCount
        ? `拍照和试跑须正好 ${kindCount} 张，与示范图一致。必拍：${kinds.join("、")}。不合格样 ${input.failCount || 0} 张。`
        : "没有合格样时，主要靠下面的合格/不合格文字，误判会更多。",
    },
    {
      id: "cover_match",
      title: "视角对号",
      active: enabled && coverGate,
      layer: "engine",
      detail: coverGate
        ? "模型先给每张现场图对号；缺某一种会再对一次。对不齐全部种类则不合格。"
        : "合格样不足 2 种时不启用。",
    },
    {
      id: "model",
      title: "模型判定",
      active: enabled,
      layer: "model",
      detail: enabled
        ? `对照样张 + 合格/不合格正文。强度：${
            input.enforceMode === "normal" ? "标准" : "严格（拿不准判不合格）"
          }。`
        : "规则已停用，不发给模型。",
    },
    {
      id: "status_reconcile",
      title: "理由与结论对齐",
      active: enabled,
      layer: "post",
      detail: "模型理由末尾写不合格但 status 写成合格时，以理由为准。",
    },
  ];

  if (!enabled) {
    return [
      {
        id: "off",
        title: "已停用",
        active: true,
        layer: "match",
        detail: "关闭或校验强度为「关闭」时，现场分析不套这条规则。",
      },
      ...steps.filter((s) => s.id !== "match"),
    ];
  }
  return steps;
}

export function pipelineSummary(steps: PipelineStep[]): string {
  const bits = steps
    .filter((s) => s.active && s.id !== "model" && s.id !== "status_reconcile" && s.id !== "samples")
    .map((s) => s.title);
  const samples = steps.find((s) => s.id === "samples");
  if (samples?.active) bits.unshift(samples.title);
  return bits.slice(0, 4).join(" · ") || "仅模型";
}
