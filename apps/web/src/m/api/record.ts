import request from '../utils/request';
import type { ApiResponse } from '../types';

export interface RecordEntry {
  templateEntryId: string;
  photos: string[];
  aiResult: {
    status: string;
    confidence: number;
    reason: string;
    startedAt?: string;
  };
  manualResult: string;
  finalResult: string | null;
  remark: string;
}

export interface RecordItem {
  id: string;
  taskId: string;
  deviceType: string;
  entries: RecordEntry[];
  location?: {
    status?: 'ok' | 'weak' | 'failed' | 'skipped';
    latitude?: number | null;
    longitude?: number | null;
    accuracyMeters?: number;
    capturedAt?: string;
    address?: string;
    distanceToSiteMeters?: number;
    reasonCode?: string;
    reason?: string;
  } | null;
  status: string;
  submittedAt?: string | null;
  rejectReason?: { reason: string; entryIds?: string[]; rejectedAt?: string } | null;
  task?: {
    id: string;
    taskName: string;
    siteId: string;
    deviceId: string;
    aiEnabled: boolean;
    templateSnapshot?: Array<{
      id: string;
      name: string;
      description: string;
      isRequired: boolean;
      samplePhotos?: string[];
      checkType?: 'photo' | 'text';
      aiEnabled?: boolean;
      entryKind?: 'check' | 'record';
      isOptionalModule?: boolean;
    }>;
  };
}

/** 条目是否启用 AI（含旧数据推断） */
export function resolveEntryAiEnabled(entry: {
  aiEnabled?: boolean;
  entryKind?: 'check' | 'record' | string;
  checkType?: 'photo' | 'text' | string;
}): boolean {
  if (entry.aiEnabled === true) return true;
  if (entry.aiEnabled === false) return false;
  if (entry.entryKind === 'record') return false;
  if (entry.entryKind === 'check') return true;
  if (entry.checkType === 'text') return false;
  return true;
}

/** @deprecated 请用 resolveEntryAiEnabled */
export function resolveEntryKind(entry: {
  entryKind?: 'check' | 'record' | string;
  checkType?: 'photo' | 'text' | string;
  aiEnabled?: boolean;
}): 'check' | 'record' {
  return resolveEntryAiEnabled(entry) ? 'check' : 'record';
}

export async function fetchRecord(id: string) {
  const { data } = await request.get<ApiResponse<RecordItem>>(`/records/${id}`);
  return data.data;
}

export async function saveDraft(id: string, entries: Partial<RecordEntry>[]) {
  const { data } = await request.put<ApiResponse<RecordItem>>(`/records/${id}/draft`, {
    entries,
  });
  return data.data;
}

export async function submitRecord(
  id: string,
  payload?: {
    enabledOptionalModuleIds?: string[];
    gps?: string;
    accuracy?: string;
    capturedAt?: string;
    locationStatus?: 'ok' | 'weak' | 'failed' | 'skipped';
    locationReasonCode?: string;
    locationReason?: string;
  },
) {
  const { data } = await request.put<ApiResponse<RecordItem>>(
    `/records/${id}/submit`,
    payload || {},
  );
  return data.data;
}

export async function uploadPhoto(
  file: File,
  meta: {
    taskId?: string;
    gps?: string;
    accuracy?: string;
    capturedAt?: string;
    photoTakenAt?: string;
    locationStatus?: string;
    locationReasonCode?: string;
    locationReason?: string;
  },
  onProgress?: (percent: number) => void,
) {
  const contentType = file.type || 'image/jpeg';
  try {
    const { data } = await request.get<
      ApiResponse<{
        method?: 'POST' | 'PUT';
        token?: string;
        uploadUrl: string;
        key: string;
        publicUrl?: string;
        domain?: string;
        headers?: Record<string, string>;
        contentType?: string;
      }>
    >('/upload/token', {
      timeout: 10000,
      params: { filename: file.name || 'photo.jpg', contentType },
    });
    const tok = data.data;
    if (tok?.uploadUrl && tok.key) {
      if (tok.method === 'PUT') {
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('PUT', tok.uploadUrl);
          const headers = {
            ...(tok.headers || {}),
            'Content-Type': tok.contentType || contentType,
          };
          Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
          xhr.upload.onprogress = (event) => {
            if (!event.total) return;
            onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`直传失败: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('直传网络错误'));
          xhr.send(file);
        });
        onProgress?.(100);
        return {
          url: tok.publicUrl || `${(tok.domain || '').replace(/\/$/, '')}/${tok.key}`,
          original: true,
        };
      }
      if (tok.token) {
        const fd = new FormData();
        fd.append('token', tok.token);
        fd.append('key', tok.key);
        fd.append('file', file);
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', tok.uploadUrl);
          xhr.upload.onprogress = (event) => {
            if (!event.total) return;
            onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve();
            else reject(new Error(`直传失败: ${xhr.status}`));
          };
          xhr.onerror = () => reject(new Error('直传网络错误'));
          xhr.send(fd);
        });
        onProgress?.(100);
        return {
          url: tok.publicUrl || `${(tok.domain || '').replace(/\/$/, '')}/${tok.key}`,
          original: true,
        };
      }
    }
  } catch {
    // 回退服务端代传
  }

  const form = new FormData();
  form.append('file', file);
  Object.entries(meta).forEach(([key, value]) => {
    if (value) form.append(key, value);
  });
  const { data } = await request.post<
    ApiResponse<{ url: string; original: boolean }>
  >('/upload/photo', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 45_000,
    onUploadProgress: (event) => {
      if (!event.total) return;
      onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    },
  });
  return data.data;
}

export interface LocationVerification {
  verified: boolean;
  status?: 'ok' | 'weak' | 'failed' | 'skipped';
  latitude?: number | null;
  longitude?: number | null;
  distanceMeters: number;
  distanceToSiteMeters?: number;
  radiusMeters: number;
  accuracyMeters: number;
  capturedAt?: string;
  checkedAt: string;
  siteName: string;
  reasonCode?: string;
  reason?: string;
}

export async function checkTaskLocation(payload: {
  taskId: string;
  gps?: string;
  accuracy?: string;
  capturedAt?: string;
  locationStatus?: string;
  locationReasonCode?: string;
  locationReason?: string;
}) {
  const { data } = await request.post<ApiResponse<LocationVerification>>(
    '/upload/location-check',
    payload,
  );
  return data.data;
}

export async function analyzeAi(payload: {
  recordId: string;
  templateEntryId: string;
  photoUrl?: string;
  photoUrls?: string[];
  samplePhotoUrls?: string[];
}) {
  const { data } = await request.post<
    ApiResponse<{ queued: boolean; completed?: boolean }>
  >('/ai/analyze', payload, { timeout: 180_000 });
  return data.data;
}

export async function setRecordManualResult(
  recordId: string,
  templateEntryId: string,
  manualResult: 'pass' | 'fail',
) {
  const { data } = await request.put<ApiResponse<RecordItem>>(
    `/records/${recordId}/entries/${encodeURIComponent(templateEntryId)}/manual-result`,
    { manualResult },
  );
  return data.data;
}

export async function fetchAiResult(templateEntryId: string, recordId: string) {
  const { data } = await request.get<
    ApiResponse<{
      aiResult?: { status: string; confidence: number; reason: string };
      status?: string;
    }>
  >(`/ai/result/${templateEntryId}`, { params: { recordId } });
  return data.data;
}
