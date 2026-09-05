"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Empty, Toast } from '@/m/lib/react-vant';
import { fetchTasks, type TaskItem } from '../../api/task';
import { fetchMyFinanceCases, type MobileFinanceCase } from '../../api/finance';
import { useAuthStore } from '../../stores/auth';
import { mobileCacheKeys } from '../../utils/mobileCacheKeys';
import { useCachedResource } from '../../utils/useCachedResource';
import { useNewOrderNotice, useVisiblePolling } from '../../utils/useVisiblePolling';
import {
  clearLayoutPreviewFlag,
  isMobilePreviewMode,
  isMobilePreviewQuery,
  setLayoutPreviewFlag,
} from '../../utils/mobilePreview';
import { buildPreviewFinanceCases } from '../../utils/mobilePreviewData';
import type { SiteBrief } from '../../types';
import './tasks.css';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'not_started', label: '未开始' },
  { key: 'in_progress', label: '进行中' },
  { key: 'completed', label: '已完成' },
] as const;

/** 首屏与每次触底追加条数 */
const PAGE_SIZE = 20;
/** 排版预览总条数（需大于 PAGE_SIZE，才能演示加载更多） */
const PREVIEW_TOTAL = 60;

interface UnifiedItem {
  key: string;
  title: string;
  statusLabel: string;
  statusClass: string;
  meta: string;
  rejectReason?: string;
  financeCase?: MobileFinanceCase;
}

function statusClass(status: string, label?: string) {
  const t = label || status;
  if (t.includes('完成') || status === 'submitted' || status === 'approved' || status === 'finished') {
    return 'is-done';
  }
  if (
    t.includes('驳回') ||
    t.includes('返工') ||
    status === 'rejected' ||
    status === 'in_progress' ||
    status === 'working'
  ) {
    return 'is-doing';
  }
  return 'is-todo';
}

function financeStatusText(c: MobileFinanceCase) {
  if (['finished', 'settle_review', 'settled', 'month_locked'].includes(c.status)) {
    return '已完成';
  }
  if (c.status === 'working') {
    const planned = Number(c.plannedUnits) || 0;
    const done = Number(c.completedUnits) || 0;
    if ((c.assignMode === 'multi' || planned > 1) && planned > 0) {
      return `进行中 ${done}/${planned}`;
    }
    return '进行中';
  }
  if (c.status === 'assigned') return '待接单';
  return c.status;
}

function financeMatchesTab(status: string, tab: (typeof FILTERS)[number]['key']) {
  if (tab === 'all') return true;
  if (tab === 'not_started') return status === 'assigned';
  if (tab === 'in_progress') return status === 'working';
  if (tab === 'completed') {
    return ['finished', 'settle_review', 'settled', 'month_locked'].includes(status);
  }
  return true;
}

/** 作业列表：当前站作业 + 其他站有单提示 */
export default function TasksPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [previewMode, setPreviewMode] = useState(false);
  const currentSite = useAuthStore((s) => s.currentSite);
  const user = useAuthStore((s) => s.user);
  const setCurrentSite = useAuthStore((s) => s.setCurrentSite);
  const [tab, setTab] = useState<(typeof FILTERS)[number]['key']>('all');
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    clearLayoutPreviewFlag();
    setPreviewMode(isMobilePreviewMode(searchParams));
  }, [searchParams]);

  const closePreview = () => {
    setLayoutPreviewFlag(false);
    setPreviewMode(isMobilePreviewQuery(searchParams));
  };

  const siteBriefById = useMemo(() => {
    const map = new Map<string, SiteBrief>();
    for (const m of user?.siteMemberships || []) {
      if (m.site?.id) map.set(m.site.id, m.site);
    }
    return map;
  }, [user?.siteMemberships]);

  const loader = useCallback(async () => {
    if (previewMode) {
      return {
        tasks: [] as TaskItem[],
        financeCases: buildPreviewFinanceCases(PREVIEW_TOTAL, currentSite?.id),
      };
    }
    const [taskPage, financeCases] = await Promise.all([
      fetchTasks({
        page: 1,
        limit: 200,
        statusGroup: tab === 'all' ? undefined : tab,
        keyword: appliedKeyword || undefined,
        siteId: currentSite?.id,
      }),
      fetchMyFinanceCases().catch(() => [] as MobileFinanceCase[]),
    ]);
    return { tasks: taskPage.list, financeCases };
  }, [tab, appliedKeyword, currentSite?.id, previewMode]);

  const cacheKey = mobileCacheKeys.taskList(
    user?.id,
    currentSite?.id,
    previewMode
      ? `preview-v2-${PREVIEW_TOTAL}|${tab}|${appliedKeyword}`
      : `site-jobs|${tab}|${appliedKeyword}`,
  );

  const { data, loading, refreshing, error, reload } = useCachedResource(cacheKey, loader);

  useVisiblePolling({ reload, intervalMs: 45_000 });

  const activeCaseIds = useMemo(
    () =>
      (data?.financeCases || [])
        .filter((c) => ['assigned', 'working'].includes(c.status))
        .map((c) => String(c.id)),
    [data?.financeCases],
  );

  const notifyNewOrders = useCallback((count: number) => {
    Toast.info(count === 1 ? '有新派单，已更新列表' : `有 ${count} 笔新派单，已更新列表`);
  }, []);

  useNewOrderNotice(
    activeCaseIds,
    notifyNewOrders,
    `${currentSite?.id || 'all'}|${tab}|${appliedKeyword}`,
  );

  const { list, otherTips } = useMemo(() => {
    const allTasks = (data?.tasks || []).filter((t) => t.status !== 'archived');
    const taskByCaseId = new Map(
      allTasks
        .filter((t) => t.serviceCaseId)
        .map((t) => [String(t.serviceCaseId), t] as const),
    );
    const items: UnifiedItem[] = [];
    const otherCount = new Map<string, number>();
    const kw = appliedKeyword.toLowerCase();

    for (const c of data?.financeCases || []) {
      if (!previewMode) {
        if (currentSite?.id && c.siteId && c.siteId !== currentSite.id) {
          if (['assigned', 'working'].includes(c.status)) {
            otherCount.set(c.siteId, (otherCount.get(c.siteId) || 0) + 1);
          }
          continue;
        }
        if (currentSite?.id && c.siteId && c.siteId !== currentSite.id) continue;
        if (currentSite?.id && !c.siteId) continue;
      }

      const linked = taskByCaseId.get(String(c.id));
      if (!financeMatchesTab(c.status, tab)) continue;
      if (kw && !`${c.projectName} ${c.gspCaseNo}`.toLowerCase().includes(kw)) continue;
      const rejectTask =
        linked?.status === 'rejected'
          ? linked
          : allTasks.find(
              (t) => String(t.serviceCaseId) === String(c.id) && t.status === 'rejected',
            );
      const label =
        rejectTask?.status === 'rejected' ? '需返工' : financeStatusText(c);
      const statusForClass = rejectTask?.status === 'rejected' ? 'rejected' : c.status;
      const reject = rejectTask?.record?.rejectReason?.reason;
      items.push({
        key: `case-${c.id}`,
        title: c.projectName || c.gspCaseNo,
        statusLabel: label,
        statusClass: statusClass(statusForClass, label),
        meta: `${c.gspCaseNo} · ${c.taskTypeName || '未设类型'}`,
        rejectReason: reject
          ? `驳回：${reject}${
              rejectTask?.record?.rejectReason?.entryIds?.length
                ? `（${rejectTask.record.rejectReason.entryIds.length} 项需返工）`
                : ''
            }`
          : undefined,
        financeCase: c,
      });
    }

    const tips = [...otherCount.entries()]
      .map(([siteId, count]) => {
        const site = siteBriefById.get(siteId);
        return site ? { site, count } : null;
      })
      .filter((x): x is { site: SiteBrief; count: number } => !!x);

    return { list: items, otherTips: tips };
  }, [data, tab, appliedKeyword, currentSite?.id, siteBriefById, previewMode]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
    setLoadingMore(false);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [tab, appliedKeyword, previewMode, currentSite?.id, cacheKey]);

  const visibleList = list.slice(0, visibleCount);
  const hasMore = visibleCount < list.length;

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setLoadingMore(true);
        window.setTimeout(() => {
          setVisibleCount((n) => Math.min(n + PAGE_SIZE, list.length));
          setLoadingMore(false);
        }, 180);
      },
      { root: null, rootMargin: '160px 0px', threshold: 0 },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [hasMore, list.length, visibleCount, loading]);

  const onRefresh = async () => {
    setVisibleCount(PAGE_SIZE);
    await reload();
  };

  return (
    <div className={`tasks-page tasks-page--shell${previewMode ? ' is-preview' : ''}`}>
      <div className="tasks-page__sticky">
        <header className="tasks-page__header">
          <div className="tasks-page__title-row">
            <h1 className="tasks-page__title">作业</h1>
            <button
              type="button"
              className="tasks-page__refresh"
              disabled={loading || refreshing}
              onClick={() => {
                void onRefresh().then(() => Toast.success('已刷新'));
              }}
            >
              {refreshing || loading ? '刷新中' : '刷新'}
            </button>
          </div>
          <p className="tasks-page__sub">
            {previewMode
              ? `排版预览 · ${PREVIEW_TOTAL} 条模拟作业（每次加载 ${PAGE_SIZE} 条）`
              : currentSite?.name
                ? `当前网格 · ${currentSite.name}`
                : '未选择网格'}
          </p>
          {!previewMode && !currentSite ? (
            <button
              type="button"
              className="tasks-page__site-cta"
              onClick={() => navigate('/m/sites')}
            >
              去选择网格 ›
            </button>
          ) : null}
        </header>

        {previewMode ? (
          <p className="mobile-preview-badge tasks-page__preview-badge">
            <span>
              预览共 {PREVIEW_TOTAL} 条，滑到底自动加载更多（已显示{' '}
              {Math.min(visibleCount, list.length)}/{list.length}）
            </span>
            <button type="button" className="mobile-preview-close" onClick={closePreview}>
              关闭预览
            </button>
          </p>
        ) : null}

        {otherTips.length > 0 && (
          <div className="tasks-page__other">
            {otherTips.map(({ site, count }) => (
              <button
                key={site.id}
                type="button"
                className="tasks-page__other-item"
                onClick={() => setCurrentSite(site)}
              >
                <span>
                  <b>{site.name}</b> 有 {count} 单待办
                </span>
                <i>切换 ›</i>
              </button>
            ))}
          </div>
        )}

        <div className="tasks-page__search">
          <span className="tasks-page__search-icon" aria-hidden>
            搜
          </span>
          <input
            value={keyword}
            placeholder="搜索项目名 / 案例号"
            onChange={(e) => {
              const v = e.target.value;
              setKeyword(v);
              if (!v.trim() && appliedKeyword) setAppliedKeyword('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setAppliedKeyword(keyword.trim());
            }}
          />
          {keyword && (
            <button
              type="button"
              className="tasks-page__search-clear"
              onClick={() => {
                setKeyword('');
                setAppliedKeyword('');
              }}
            >
              清除
            </button>
          )}
          <button
            type="button"
            className="tasks-page__search-go"
            onClick={() => setAppliedKeyword(keyword.trim())}
          >
            搜索
          </button>
        </div>

        <div className="tasks-page__filters" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              className={`tasks-page__filter${tab === f.key ? ' is-active' : ''}`}
              onClick={() => setTab(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="tasks-page__scroll" ref={scrollRef}>
          <div className="tasks-page__list">
            {loading ? (
              <div className="mobile-list-skeleton" aria-label="正在加载作业">
                <i />
                <i />
                <i />
              </div>
            ) : error && data === undefined ? (
              <button type="button" className="mobile-load-error" onClick={() => void reload()}>
                数据暂时没有加载成功，点击重试
              </button>
            ) : list.length === 0 ? (
              <div className="tasks-page__empty">
                <Empty
                  description={
                    otherTips.length
                      ? '本网格暂无作业，可切换到上方有待办的网格'
                      : '暂无作业，请等待网格长派单'
                  }
                />
              </div>
            ) : (
              <>
                {visibleList.map((item) => {
                  const href = item.financeCase?.id
                    ? `/m/finance-cases/${item.financeCase.id}`
                    : previewMode
                      ? '/m/finance-cases/preview-case-1'
                      : '';
                  return (
                  <div
                    key={item.key}
                    className="tasks-item"
                    role="button"
                    tabIndex={0}
                    data-prefetch={href || undefined}
                onClick={() => {
                  if (previewMode) {
                    navigate(
                      item.financeCase?.id
                        ? `/m/finance-cases/${item.financeCase.id}`
                        : '/m/finance-cases/preview-case-1',
                    );
                    return;
                  }
                  if (item.financeCase) navigate(`/m/finance-cases/${item.financeCase.id}`);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (previewMode) {
                      navigate(
                        item.financeCase?.id
                          ? `/m/finance-cases/${item.financeCase.id}`
                          : '/m/finance-cases/preview-case-1',
                      );
                      return;
                    }
                    if (item.financeCase) navigate(`/m/finance-cases/${item.financeCase.id}`);
                  }
                }}
                  >
                    <div className="tasks-item__top">
                      <div className="tasks-item__name">{item.title}</div>
                      <div className={`tasks-item__status ${item.statusClass}`}>
                        {item.statusLabel}
                      </div>
                    </div>
                    <div className="tasks-item__meta">{item.meta}</div>
                    {item.rejectReason && (
                      <div className="tasks-item__reject">{item.rejectReason}</div>
                    )}
                  </div>
                  );
                })}
                <div ref={sentinelRef} className="tasks-page__sentinel" aria-hidden />
                <div className="tasks-page__footer">
                  {loadingMore
                    ? '加载中…'
                    : hasMore
                      ? '上滑加载更多'
                      : `已显示全部 ${list.length} 条`}
                </div>
              </>
            )}
          </div>
        </div>
    </div>
  );
}
