/** 移动端排版预览：仅 URL ?preview=30 / 1 / true，或案例 id 为 preview-case-N；正式联调默认关闭 */
export const PREVIEW_CASE_ID = 'preview-30';
export const PREVIEW_QUERY = '30';
const STORAGE_KEY = 'yangguang.mobileLayoutPreview';

export function isMobilePreviewQuery(search: string | URLSearchParams | null | undefined): boolean {
  if (!search) return false;
  const raw =
    typeof search === 'string'
      ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
      : search;
  const v = raw.get('preview');
  return v === PREVIEW_QUERY || v === '1' || v === 'true';
}

export function parsePreviewCaseIndex(id?: string | null): number | null {
  if (!id) return null;
  if (id === PREVIEW_CASE_ID || id === 'preview') return 1;
  const m = /^preview-case-(\d+)$/.exec(id);
  if (!m) return null;
  return Math.max(1, Number(m[1]) || 1);
}

export function isPreviewCaseId(id?: string | null): boolean {
  return parsePreviewCaseIndex(id) != null;
}

export function previewCasePath(index: number): string {
  return `/m/finance-cases/preview-case-${Math.max(1, index)}`;
}

/** 本机是否打开了排版预览（给工程师看长列表用） */
export function getLayoutPreviewFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setLayoutPreviewFlag(on: boolean) {
  if (typeof window === 'undefined') return;
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** 关闭本机排版预览开关（正式联调默认走真实数据） */
export function clearLayoutPreviewFlag() {
  setLayoutPreviewFlag(false);
}

export function isMobilePreviewMode(
  search: string | URLSearchParams | null | undefined,
  caseId?: string | null,
): boolean {
  return (
    isMobilePreviewQuery(search) ||
    isPreviewCaseId(caseId) ||
    getLayoutPreviewFlag()
  );
}
