"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Empty, Toast } from '@/m/lib/react-vant';
import { useAuthStore } from '../../stores/auth';
import { fetchTasks, type TaskItem } from '../../api/task';
import { fetchMyFinanceCases, type MobileFinanceCase } from '../../api/finance';
import { mobileCacheKeys } from '../../utils/mobileCacheKeys';
import { useCachedResource } from '../../utils/useCachedResource';
import { useNewOrderNotice, useVisiblePolling } from '../../utils/useVisiblePolling';
import {
  clearLayoutPreviewFlag,
  isMobilePreviewMode,
  isMobilePreviewQuery,
  setLayoutPreviewFlag,
} from '../../utils/mobilePreview';
import { buildPreviewHomeItems } from '../../utils/mobilePreviewData';
import type { SiteBrief } from '../../types';
import './home.css';

const STATUS_TEXT: Record<string, string> = {
  pending: '未开始',
  in_progress: '进行中',
  submitted: '已完成',
  approved: '已完成',
  rejected: '需返工',
  archived: '已归档',
  draft: '进行中',
  assigned: '待接单',
  working: '作业中',
  finished: '已完成',
};

type HomeItem = {
  key: string;
  title: string;
  meta: string;
  status: string;
  statusLabel: string;
  href: string;
};

type OtherSiteTip = {
  siteId: string;
  siteName: string;
  count: number;
  site: SiteBrief;
};

function primaryAction(item?: HomeItem) {
  if (!item) return { title: '查看全部作业', hint: '本网格暂无待办，可切换网格或等待派单' };
  if (item.status === 'rejected') return { title: '去返工', hint: item.title };
  if (item.status === 'assigned' || item.status === 'pending') {
    return { title: '去接单', hint: item.title };
  }
  if (item.status === 'working' || item.status === 'in_progress') {
    return { title: '继续作业', hint: item.title };
  }
  return { title: '查看作业', hint: item.title };
}

/** 首页：只看当前站待办；其他站有单时提示并一键切换 */
export default function HomePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [previewMode, setPreviewMode] = useState(false);
  const { currentSite, user, setCurrentSite } = useAuthStore();
  const profileIncomplete = !user?.realName?.trim() || !user?.phone?.trim();

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
        financeCases: [],
        previewItems: buildPreviewHomeItems(30),
      };
    }
    const [taskPage, financeCases] = await Promise.all([
      fetchTasks({
        page: 1,
        limit: 50,
        siteId: currentSite?.id,
      }),
      // 全量案例仅用于「其他站有单」提示，列表仍按当前站过滤
      fetchMyFinanceCases().catch(() => [] as MobileFinanceCase[]),
    ]);
    return { tasks: taskPage.list as TaskItem[], financeCases };
  }, [currentSite?.id, previewMode]);

  const cacheKey =
    mobileCacheKeys.homeTasks(user?.id, currentSite?.id) +
    (previewMode ? ':preview-home-v2' : ':site-scoped-v1');

  const { data, loading, error, reload } = useCachedResource(cacheKey, loader);

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

  useNewOrderNotice(activeCaseIds, notifyNewOrders, currentSite?.id || 'all');

  const { items, otherSiteTips, previewTotal } = useMemo(() => {
    if (previewMode && data && 'previewItems' in data && data.previewItems) {
      const list = data.previewItems;
      return { items: list, otherSiteTips: [] as OtherSiteTip[], previewTotal: list.length };
    }
    const allTasks = data?.tasks || [];
    const taskByCaseId = new Map(
      allTasks
        .filter((t) => t.serviceCaseId)
        .map((t) => [String(t.serviceCaseId), t] as const),
    );

    const list: HomeItem[] = [];
    const otherCount = new Map<string, number>();

    for (const c of data?.financeCases || []) {
      if (!['assigned', 'working'].includes(c.status)) continue;
      if (!c.siteId) continue;

      if (currentSite?.id && c.siteId === currentSite.id) {
        const linked = taskByCaseId.get(String(c.id));
        const rejectTask =
          linked?.status === 'rejected'
            ? linked
            : allTasks.find(
                (t) => String(t.serviceCaseId) === String(c.id) && t.status === 'rejected',
              );
        const status = rejectTask?.status === 'rejected' ? 'rejected' : c.status;
        const statusLabel =
          rejectTask?.status === 'rejected'
            ? '需返工'
            : STATUS_TEXT[c.status] || c.status;
        list.push({
          key: `case-${c.id}`,
          title: c.projectName || c.gspCaseNo,
          meta: `${c.gspCaseNo} · ${c.taskTypeName || '未设类型'}`,
          status,
          statusLabel,
          href: `/m/finance-cases/${c.id}`,
        });
        continue;
      }

      if (!currentSite?.id || c.siteId !== currentSite.id) {
        otherCount.set(c.siteId, (otherCount.get(c.siteId) || 0) + 1);
      }
    }

    list.sort((a, b) => {
      const rank = (s: string) =>
        s === 'in_progress' || s === 'working' || s === 'rejected' ? 0 : 1;
      return rank(a.status) - rank(b.status);
    });

    const tips: OtherSiteTip[] = [...otherCount.entries()]
      .map(([siteId, count]) => {
        const site = siteBriefById.get(siteId);
        if (!site) return null;
        return { siteId, siteName: site.name, count, site };
      })
      .filter((x): x is OtherSiteTip => !!x)
      .sort((a, b) => b.count - a.count);

    return { items: list, otherSiteTips: tips, previewTotal: 0 };
  }, [data, currentSite?.id, siteBriefById, previewMode]);

  const stats = useMemo(
    () => ({
      pending: items.filter((t) => t.status === 'pending' || t.status === 'assigned').length,
      inProgress: items.filter((t) =>
        ['in_progress', 'working', 'rejected'].includes(t.status),
      ).length,
    }),
    [items],
  );

  const action = primaryAction(items[0]);
  const otherTotal = otherSiteTips.reduce((sum, t) => sum + t.count, 0);

  const switchToSite = (site: SiteBrief) => {
    setCurrentSite(site);
    // 换站后缓存 key 会变，首页会自动重拉
  };

  return (
    <div className={`page-home${previewMode ? ' page-home--preview' : ''} page-home--shell`}>
        <header className="home-hero">
          <div className="home-hero__top">
            <div className="home-brand">
              <span>光</span>
              <b>现场作业台</b>
            </div>
            <div className="home-hero__actions">
              <button
                type="button"
                className="home-site-switch home-site-switch--ghost"
                disabled={loading}
                aria-label="刷新"
                onClick={() => {
                  void reload().then(() => Toast.success('已刷新'));
                }}
              >
                刷新
              </button>
              <button type="button" className="home-site-switch" onClick={() => navigate('/m/sites')}>
                切换网格
              </button>
            </div>
          </div>
          <div className="home-hero__site">
            <div className="home-hero__site-main">
              <small>当前网格</small>
              <h1>{currentSite?.name || '尚未选择网格'}</h1>
              <p>
                {currentSite
                  ? `${[currentSite.province, currentSite.city].filter(Boolean).join('') || '未填省市'} · ${currentSite.code}`
                  : '请先选择今日要作业的网格'}
              </p>
            </div>
          </div>
        </header>

        <main className="home-content">
          {previewMode ? (
            <p className="mobile-preview-badge home-preview-badge">
              <span>排版预览 · 共 {previewTotal || 30} 条待办，首页仅展示 8 条</span>
              <button type="button" className="mobile-preview-close" onClick={closePreview}>
                关闭预览
              </button>
            </p>
          ) : null}
          {profileIncomplete && (
            <button type="button" className="home-profile-tip" onClick={() => navigate('/m/settings')}>
              <span>!</span>
              <b>完善个人信息</b>
              <small>确保报告签署准确</small>
              <i>›</i>
            </button>
          )}

          {otherSiteTips.length > 0 && (
            <section className="home-other-sites" aria-label="其他网格待办提醒">
              <div className="home-other-sites__head">
                <b>其他网格有待办</b>
                <span>共 {otherTotal} 单，点网格即可切换查看</span>
              </div>
              <div className="home-other-sites__list">
                {otherSiteTips.map((tip) => (
                  <button
                    key={tip.siteId}
                    type="button"
                    className="home-other-sites__item"
                    onClick={() => switchToSite(tip.site)}
                  >
                    <span>
                      <b>{tip.siteName}</b>
                      <small>{tip.count} 单待办</small>
                    </span>
                    <i>切换 ›</i>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section className="home-overview">
            <div className="home-overview__head">
              <div className="home-greeting">
                <b>
                  {new Date().getHours() < 12
                    ? '早上好'
                    : new Date().getHours() < 18
                      ? '下午好'
                      : '晚上好'}{' '}
                  {user?.realName || user?.username || '工程师'}
                </b>
              </div>
              <span className="home-date-badge">
                {new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}
              </span>
            </div>

            {loading || data === undefined ? (
              <div className="home-stats home-stats--loading home-stats--2" aria-label="正在加载">
                <i />
                <i />
              </div>
            ) : (
              <div className="home-stats home-stats--2">
                <div>
                  <b>{stats.pending}</b>
                  <span>待接单</span>
                </div>
                <div>
                  <b>{stats.inProgress}</b>
                  <span>作业中</span>
                </div>
              </div>
            )}

            <button
              type="button"
              className="home-start"
              onClick={() => {
                if (previewMode && items[0]) {
                  navigate(items[0].href);
                  return;
                }
                if (!currentSite) {
                  navigate('/m/sites');
                  return;
                }
                if (items[0]) navigate(items[0].href);
                else navigate('/m/tasks');
              }}
            >
              <span className="home-start__icon" aria-hidden>
                ›
              </span>
              <span className="home-start__text">
                <b>{previewMode ? action.title : !currentSite ? '先选择网格' : action.title}</b>
                <small>
                  {previewMode
                    ? action.hint
                    : !currentSite
                      ? '选择网格后查看本网格已派工单'
                      : action.hint}
                </small>
              </span>
              <i>›</i>
            </button>
          </section>

          <div className="home-scroll-area">
          <div className="home-section-title">
            <div>
              <h3>本网格待办</h3>
              <span>
                {previewMode
                  ? `预览 ${previewTotal || items.length} 条`
                  : currentSite
                    ? `仅显示 ${currentSite.name}`
                    : '请先选择网格'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => navigate('/m/tasks')}
            >
              全部 ›
            </button>
          </div>

          {loading ? (
            <div className="mobile-list-skeleton" aria-label="正在加载">
              <i />
              <i />
              <i />
            </div>
          ) : error && data === undefined ? (
            <button type="button" className="mobile-load-error" onClick={() => void reload()}>
              数据暂时没有加载成功，点击重试
            </button>
          ) : !currentSite && !previewMode ? (
            <div className="home-empty">
              <Empty description="请先选择网格" />
            </div>
          ) : items.length === 0 ? (
            <div className="home-empty">
              <Empty
                description={
                  otherSiteTips.length
                    ? '本网格暂无待办，可点上方提示切换到有单的网格'
                    : '本网格暂无待办，等待网格长派单'
                }
              />
            </div>
          ) : (
            <div className="home-task-list">
              {items.slice(0, 8).map((t) => (
                <button
                  type="button"
                  className="home-task"
                  key={t.key}
                  onClick={() => navigate(t.href)}
                >
                  <span className={`home-task__dot is-${t.status}`} />
                  <span className="home-task__main">
                    <b>{t.title}</b>
                    <small>{t.meta}</small>
                  </span>
                  <span className="home-task__status">{t.statusLabel}</span>
                  <i>›</i>
                </button>
              ))}
            </div>
          )}
          </div>
        </main>
    </div>
  );
}
