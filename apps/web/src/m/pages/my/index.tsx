"use client";

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useRouter } from 'next/navigation';
import { Cell, Button, Dialog, Empty } from '@/m/lib/react-vant';
import { useAuthStore } from '../../stores/auth';
import { canSwitchPortal, normalizeRoles } from '@/lib/portal';
import type { AppRole } from '@/lib/types';
import { fetchInspectorSummary, type InspectorSummary } from '../../api/stats';
import { mobileCacheKeys } from '../../utils/mobileCacheKeys';
import { useCachedResource } from '../../utils/useCachedResource';
import { prefetchMobileSecondaryAssets } from '../../utils/prefetchMobileTabs';
import { prefetchMobileHref } from '../../hooks/useViewportPrefetch';
import { isStandaloneDisplay, isIosDevice, isSecureInstallContext, tryNativeInstall } from '../../utils/addToHome';
import AddToHomePrompt from '../../components/AddToHomePrompt';
import './my.css';

/** 我的：头像、网格、统计、设置 */
export default function MyPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const { user, currentSite, logout } = useAuthStore();
  const [showA2hs, setShowA2hs] = useState(false);
  /** SSR 与首屏统一为 false，挂载后再判断是否展示「添加到桌面」 */
  const [showInstallEntry, setShowInstallEntry] = useState(false);

  useEffect(() => {
    prefetchMobileSecondaryAssets(router);
  }, [router]);

  useEffect(() => {
    setShowInstallEntry(!isStandaloneDisplay());
  }, []);

  const go = (href: string) => {
    prefetchMobileHref(router, href);
    navigate(href);
  };

  const loader = useCallback(
    () => fetchInspectorSummary(currentSite?.id),
    [currentSite?.id],
  );
  const { data: summary, loading, error, reload } = useCachedResource<InspectorSummary>(
    mobileCacheKeys.inspectorSummary(user?.id, currentSite?.id),
    loader,
  );

  const onLogout = async () => {
    try {
      await Dialog.confirm({
        title: '提示',
        message: '确定退出登录？',
      });
    } catch {
      return;
    }
    await logout();
    navigate('/m/login', { replace: true });
  };

  const month = summary?.month && typeof summary.month === "object" ? summary.month : undefined;

  return (
    <div className="my-page">
      <header className="my-hero">
        <div className="my-hero__profile">
          <div className="my-hero__avatar" aria-hidden>
            {(user?.realName || 'U').slice(0, 1)}
          </div>
          <div className="my-hero__meta">
            <h1>{user?.realName || '-'}</h1>
            <p>{user?.phone || user?.username || '工程师账号'}</p>
          </div>
        </div>
      </header>

      <div className="my-body">
        <Cell.Group inset>
          <div data-prefetch="/m/sites">
            <Cell
              title="当前网格"
              value={currentSite?.name || '未选择'}
              isLink
              onClick={() => go('/m/sites')}
            />
          </div>
        </Cell.Group>

        <div className="my-stats-card">
          <h3 className="my-stats-card__title">本月统计</h3>
          {loading ? (
            <div className="mobile-summary-skeleton" aria-label="正在加载本月统计">
              <i />
              <i />
              <i />
            </div>
          ) : error && !summary ? (
            <button type="button" className="mobile-load-error" onClick={() => void reload()}>
              统计暂时没有加载成功，点击重试
            </button>
          ) : month ? (
            <div className="my-stats-grid">
              <button type="button" data-prefetch="/m/tasks" onClick={() => go('/m/tasks')}>
                <b>{month.total ?? 0}</b>
                <span>作业数</span>
              </button>
              <button type="button" data-prefetch="/m/tasks" onClick={() => go('/m/tasks')}>
                <b>{month.completed ?? 0}</b>
                <span>已完成</span>
              </button>
              <button type="button" data-prefetch="/m/income" onClick={() => go('/m/income')}>
                <b>{month.completionRate ?? 0}%</b>
                <span>完成率</span>
              </button>
            </div>
          ) : (
            <Empty description="暂无数据" imageSize={64} />
          )}
        </div>

        <Cell.Group inset>
          <div data-prefetch="/m/income">
            <Cell
              title="我的收入"
              label="每单绩效与审核状态"
              isLink
              onClick={() => go('/m/income')}
            />
          </div>
          <div data-prefetch="/m/settings">
            <Cell title="个人资料" isLink onClick={() => go('/m/settings')} />
          </div>
          <div data-prefetch="/m/help">
            <Cell
              title="使用帮助"
              label="图文手册，按步骤对照操作"
              isLink
              onClick={() => go('/m/help')}
            />
          </div>
          {showInstallEntry ? (
            <Cell
              title="添加到手机桌面"
              label="下次点图标直接进入作业端"
              isLink
              onClick={() => {
                void (async () => {
                  const showGuide = () => {
                    setShowA2hs(true);
                  };
                  // 局域网 http / iOS：系统装不了，直接出说明弹窗
                  if (!isSecureInstallContext() || isIosDevice()) {
                    showGuide();
                    return;
                  }
                  try {
                    const installed = await Promise.race([
                      tryNativeInstall(),
                      new Promise<false>((resolve) => {
                        window.setTimeout(() => resolve(false), 1200);
                      }),
                    ]);
                    if (!installed) showGuide();
                  } catch {
                    showGuide();
                  }
                })();
              }}
            />
          ) : null}
          {canSwitchPortal(
            normalizeRoles(user?.roles as AppRole[] | undefined, (user?.role as AppRole) || 'inspector'),
          ) ? (
            <Cell
              title="切换入口"
              label="回首页选择管理后台或作业端"
              isLink
              onClick={() => {
                window.location.href = '/';
              }}
            />
          ) : null}
        </Cell.Group>

        {showA2hs ? <AddToHomePrompt onClose={() => setShowA2hs(false)} /> : null}

        <div className="my-logout">
          <Button block round type="danger" plain onClick={onLogout}>
            退出登录
          </Button>
        </div>
      </div>
    </div>
  );
}
