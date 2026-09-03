import request from '../utils/request';
import type { ApiResponse } from '../types';

export type HardRuleMatchMode = 'title_exact' | 'title_includes' | 'criteria_includes';
export type HardRuleEnforceMode = 'strict' | 'normal' | 'off';

export interface HardRuleBinding {
  templateId: string;
  entryId: string;
  templateName: string;
  entryName: string;
  productLineName?: string;
}

export interface HardRulePassView {
  url: string;
  label: string;
}

export interface HardRuleSamples {
  pass: HardRulePassView[];
  fail: string[];
}

export interface HardRuleItem {
  id: string;
  code: string;
  name: string;
  matchMode: HardRuleMatchMode | string;
  matchPattern: string;
  promptText: string;
  jsonSchemaHint: string | null;
  enabled: boolean;
  enforceMode: HardRuleEnforceMode | string;
  version: number;
  changeNote: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  builtin?: boolean;
  hasDefault?: boolean;
  bindings?: HardRuleBinding[];
  samples?: HardRuleSamples;
  reviewStats?: {
    reviewed: number;
    agreed: number;
    windowDays: number;
  };
}

export interface HardRuleCatalogItem {
  key: string;
  templateId: string;
  templateName: string;
  productLineId?: string;
  productLineName?: string;
  entryId: string;
  entryName: string;
  description: string;
  samplePhotos?: string[];
  name?: string;
  templates?: string[];
}

export interface HardRulePreviewResult {
  status: 'pass' | 'fail' | 'error';
  confidence: number;
  reason: string;
  provider: string;
}

export type HardRuleWritePayload = {
  name: string;
  bindings?: HardRuleBinding[];
  entryNames?: string[];
  extraKeywords?: string;
  matchMode?: HardRuleMatchMode;
  matchPattern?: string;
  promptText?: string;
  passCriteria?: string;
  failCriteria?: string;
  judgeNotes?: string;
  jsonSchemaHint?: string | null;
  enabled?: boolean;
  enforceMode?: HardRuleEnforceMode;
  changeNote?: string;
  passSampleUrls?: string[];
  passSampleViews?: HardRulePassView[];
  failSampleUrls?: string[];
  samples?: HardRuleSamples;
};

export async function fetchHardRules() {
  const { data } = await request.get<ApiResponse<HardRuleItem[]>>('/ai-hard-rules');
  return data.data;
}

export async function fetchHardRuleCatalog() {
  const { data } = await request.get<ApiResponse<{ items: HardRuleCatalogItem[] }>>(
    '/ai-hard-rules/catalog',
  );
  return data.data.items;
}

export async function draftHardRule(payload: {
  name?: string;
  title?: string;
  description?: string;
  passPhotoUrls: string[];
  failPhotoUrls: string[];
  failNote?: string;
}) {
  const { data } = await request.post<
    ApiResponse<{ passCriteria: string; failCriteria: string; provider: string; draft: boolean }>
  >('/ai-hard-rules/draft', payload, { timeout: 90000 });
  return data.data;
}

export async function previewHardRule(payload: {
  title: string;
  description?: string;
  photoUrls: string[];
  name?: string;
  passCriteria?: string;
  failCriteria?: string;
  judgeNotes?: string;
  promptText?: string;
  enforceMode?: HardRuleEnforceMode | string;
  passSampleUrls?: string[];
  passSampleViews?: HardRulePassView[];
  failSampleUrls?: string[];
}) {
  const { data } = await request.post<ApiResponse<HardRulePreviewResult>>(
    '/ai-hard-rules/preview',
    payload,
    { timeout: 90000 },
  );
  return data.data;
}

export async function labelHardRuleSamples(payload: {
  title?: string;
  views: HardRulePassView[];
}) {
  const { data } = await request.post<ApiResponse<{ labels: string[]; provider: string }>>(
    '/ai-hard-rules/label-samples',
    payload,
    { timeout: 90000 },
  );
  return data.data;
}

export async function fetchHardRule(code: string) {
  const { data } = await request.get<ApiResponse<HardRuleItem>>(`/ai-hard-rules/${code}`);
  return data.data;
}

export async function createHardRule(payload: HardRuleWritePayload) {
  const { data } = await request.post<ApiResponse<HardRuleItem>>('/ai-hard-rules', payload);
  return data.data;
}

export async function updateHardRule(code: string, payload: HardRuleWritePayload) {
  const { data } = await request.put<ApiResponse<HardRuleItem>>(`/ai-hard-rules/${code}`, payload);
  return data.data;
}

export async function deleteHardRule(code: string) {
  const { data } = await request.delete<ApiResponse<{ ok: boolean; code: string }>>(
    `/ai-hard-rules/${code}`,
  );
  return data.data;
}

export async function resetHardRule(code: string, changeNote?: string) {
  const { data } = await request.post<ApiResponse<HardRuleItem>>(`/ai-hard-rules/${code}/reset`, {
    changeNote: changeNote || '恢复内置默认硬规则',
  });
  return data.data;
}
