"use client";

import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useRouter } from 'next/navigation';
import { Tabbar } from '@/m/lib/react-vant';
import { HomeO, OrdersO, UserO } from '@react-vant/icons';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useTransition,
  type ComponentType,
  type ReactNode,
} from 'react';
import { useAuthStore } from '../stores/auth';
import { initAddToHomeRuntime } from '../utils/addToHome';
import {
  MOBILE_TAB_PATHS,
  prefetchMobileTabAssets,
  prefetchMobileTabData,
} from '../utils/prefetchMobileTabs';
import {
  clearMobilePendingIfMatched,
  useMobilePendingPath,
} from '../nav/mobilePendingPath';
import {
  isMobileHideTabPath,
  matchMobileClientRoute,
} from '../nav/mobileClientRoutes';
import { useViewportPrefetch } from '../hooks/useViewportPrefetch';
import MobileSecondaryHost from '../components/MobileSecondaryHost';
import HomePage from '../pages/home';
import TasksPage from '../pages/tasks';
import MyPage from '../pages/my';

// @react-vant/icons 的旧类型声明与当前 React 类型不兼容，运行时组件正常。
const HomeIcon = HomeO as unknown as ComponentType;
const TasksIcon = OrdersO as unknown as ComponentType;
const UserIcon = UserO as unknown as ComponentType;

type TabPath = (typeof MOBILE_TAB_PATHS)[number];

function isTabPath(path: string): path is TabPath {
  return (MOBILE_TAB_PATHS as readonly string[]).includes(path);
}

/** 底部 Tab 导航：预取 + keep-alive，二级页也由壳客户端挂载。 */
export default function TabLayout({ children }: { children?: ReactNode }) {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  const pendingPath = useMobilePendingPath();
  const user = useAuthStore((s) => s.user);
  const currentSite = useAuthStore((s) => s.currentSite);
  const [pendingTab, setPendingTab] = useState<string | null>(null);
  const [, startTabTransition] = useTransition();
  const [mountedTabs, setMountedTabs] = useState<Record<TabPath, boolean>>({
    '/m': true,
    '/m/tasks': true,
    '/m/my': true,
  });

  useViewportPrefetch('.h5-shell');

  const displayPath = pendingPath || location.pathname;

  useEffect(() => {
    clearMobilePendingIfMatched(location.pathname);
  }, [location.pathname]);

  const pathActive = useMemo(() => {
    if (displayPath.startsWith('/m/tasks')) return '/m/tasks';
    if (displayPath.startsWith('/m/my')) return '/m/my';
    return '/m';
  }, [displayPath]);

  const hideTab = isMobileHideTabPath(displayPath);
  const onMainTab = !hideTab && isTabPath(pathActive);
  const clientSecondary = matchMobileClientRoute(displayPath);

  useLayoutEffect(() => {
    if (onMainTab) {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    }
  }, [pathActive, onMainTab]);

  useEffect(() => {
    initAddToHomeRuntime();
  }, []);

  useEffect(() => {
    prefetchMobileTabAssets(router);
  }, [router]);

  useEffect(() => {
    prefetchMobileTabData(user?.id, currentSite?.id);
  }, [currentSite?.id, user?.id]);

  useEffect(() => {
    if (!onMainTab) return;
    setMountedTabs((prev) => ({ ...prev, [pathActive]: true }));
  }, [onMainTab, pathActive]);

  useEffect(() => {
    const warmAll = () =>
      setMountedTabs({
        '/m': true,
        '/m/tasks': true,
        '/m/my': true,
      });
    let idleId: number | undefined;
    let timerId: number | undefined;
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(warmAll, { timeout: 1200 });
    } else if (typeof globalThis !== 'undefined') {
      timerId = globalThis.setTimeout(warmAll, 320) as unknown as number;
    }
    return () => {
      if (idleId != null && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
      if (timerId != null) window.clearTimeout(timerId);
    };
  }, []);

  useEffect(() => {
    if (!pendingTab) return;
    if (pathActive === pendingTab) setPendingTab(null);
  }, [pathActive, pendingTab]);

  const active = pendingTab || pathActive;

  const goTab = (path: string) => {
    if (!isTabPath(path)) return;
    if (pathActive === path && onMainTab) {
      setPendingTab(null);
      return;
    }
    setMountedTabs((prev) => ({ ...prev, [path]: true }));
    setPendingTab(path);
    startTabTransition(() => {
      navigate(path);
    });
  };

  return (
    <div className={`tab-layout${hideTab ? ' tab-layout--no-tab' : ''}`}>
      <div className="tab-layout__content">
        {/* 主 Tab keep-alive：进详情也不卸载，返回时状态还在 */}
        {mountedTabs['/m'] ? (
          <div
            className="tab-pane"
            hidden={!(onMainTab && active === '/m')}
            aria-hidden={!(onMainTab && active === '/m')}
          >
            <HomePage />
          </div>
        ) : null}
        {mountedTabs['/m/tasks'] ? (
          <div
            className="tab-pane"
            hidden={!(onMainTab && active === '/m/tasks')}
            aria-hidden={!(onMainTab && active === '/m/tasks')}
          >
            <TasksPage />
          </div>
        ) : null}
        {mountedTabs['/m/my'] ? (
          <div
            className="tab-pane"
            hidden={!(onMainTab && active === '/m/my')}
            aria-hidden={!(onMainTab && active === '/m/my')}
          >
            <MyPage />
          </div>
        ) : null}

        {/* 二级页宿主始终挂载：eager 预挂 + keep-alive；主 Tab 时全部 hidden */}
        <MobileSecondaryHost pathname={displayPath} />

        {/* 未登记路由仍走 Next children（如登录后偶发路径） */}
        {!onMainTab && !clientSecondary ? children ?? <Outlet /> : null}
      </div>
      {!hideTab && (
        <Tabbar
          value={active}
          onChange={(v) => goTab(String(v))}
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
