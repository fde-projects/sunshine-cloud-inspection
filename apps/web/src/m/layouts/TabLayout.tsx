"use client";

import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Tabbar } from '@/m/lib/react-vant';
import { HomeO, OrdersO, UserO } from '@react-vant/icons';
import { useEffect, useLayoutEffect, useMemo, type ComponentType, type ReactNode } from 'react';
import { useAuthStore } from '../stores/auth';
import { fetchTasks } from '../api/task';
import { fetchInspectorSummary } from '../api/stats';
import { mobileCacheKeys } from '../utils/mobileCacheKeys';
import { prefetchResource } from '../utils/useCachedResource';
import { initAddToHomeRuntime } from '../utils/addToHome';

// @react-vant/icons 的旧类型声明与当前 React 类型不兼容，运行时组件正常。
const HomeIcon = HomeO as unknown as ComponentType;
const TasksIcon = OrdersO as unknown as ComponentType;
const UserIcon = UserO as unknown as ComponentType;

/** 底部 Tab 导航布局（首页 / 作业 / 我的） */
export default function TabLayout({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const currentSite = useAuthStore((s) => s.currentSite);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [location.pathname]);

  useEffect(() => {
    initAddToHomeRuntime();
  }, []);

  useEffect(() => {
    const siteId = currentSite?.id;
    void prefetchResource(
      mobileCacheKeys.homeTasks(user?.id, siteId) + ':site-scoped-v1',
      () =>
        Promise.all([
          fetchTasks({ page: 1, limit: 50, siteId }),
          import('../api/finance').then((m) => m.fetchMyFinanceCases().catch(() => [])),
        ]).then(([taskPage, financeCases]) => ({
          tasks: taskPage.list,
          financeCases,
        })),
    );
    void prefetchResource(
      mobileCacheKeys.taskList(user?.id, siteId, 'site-jobs|all|'),
      () =>
        Promise.all([
          fetchTasks({ page: 1, limit: 50, siteId }),
          import('../api/finance').then((m) => m.fetchMyFinanceCases().catch(() => [])),
        ]).then(([taskPage, financeCases]) => ({
          tasks: taskPage.list,
          financeCases,
        })),
    );
    void prefetchResource(
      mobileCacheKeys.inspectorSummary(user?.id, siteId),
      () => fetchInspectorSummary(siteId),
    );
  }, [currentSite?.id, user?.id]);

  const active = useMemo(() => {
    if (location.pathname.startsWith('/m/tasks')) return '/m/tasks';
    if (location.pathname.startsWith('/m/my')) return '/m/my';
    return '/m';
  }, [location.pathname]);

  // 详情/二级页不显示底部导航，避免挡内容、抢高度
  const hideTab =
    location.pathname.includes('/inspection/') ||
    location.pathname.includes('/photo') ||
    location.pathname.includes('/success') ||
    location.pathname.includes('/login') ||
    location.pathname.includes('/finance-cases/') ||
    location.pathname.includes('/report/') ||
    location.pathname.includes('/m/sites') ||
    location.pathname.includes('/m/settings') ||
    location.pathname.includes('/m/income') ||
    location.pathname.includes('/m/history') ||
    location.pathname.includes('/m/start') ||
    /\/m\/tasks\/[^/]+$/.test(location.pathname);

  return (
    <div className={`tab-layout${hideTab ? ' tab-layout--no-tab' : ''}`}>
      <div className="tab-layout__content">
        {children ?? <Outlet />}
      </div>
      {!hideTab && (
        <Tabbar
          value={active}
          onChange={(v) => navigate(String(v))}
          fixed
          placeholder={false}
        >
          <Tabbar.Item name="/m" icon={<HomeIcon />}>
            首页
          </Tabbar.Item>
          <Tabbar.Item name="/m/tasks" icon={<TasksIcon />}>
            作业
          </Tabbar.Item>
          <Tabbar.Item name="/m/my" icon={<UserIcon />}>
            我的
          </Tabbar.Item>
        </Tabbar>
      )}
    </div>
  );
}
