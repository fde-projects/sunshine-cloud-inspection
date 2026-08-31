"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Layout, Menu, Dropdown, Avatar, Drawer, Button, Grid } from "antd";
import type { MenuProps } from "antd";
import {
  DashboardOutlined,
  EnvironmentOutlined,
  TeamOutlined,
  ClusterOutlined,
  FileTextOutlined,
  ScheduleOutlined,
  HistoryOutlined,
  AuditOutlined,
  BarChartOutlined,
  AlertOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  UserOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  AccountBookOutlined,
} from "@ant-design/icons";
import { useAuthStore } from "@/stores/auth";
import { brandMarkText, useBrandingStore } from "@/stores/branding";
import { flattenMenus, getMenusByRole } from "@/router/menus";
import type { MenuConfig } from "@/types";
import { canSwitchPortal, normalizeRoles, roleHome } from "@/lib/portal";
import type { AppRole } from "@/lib/types";
import "@/styles/basic-layout.css";

const { Header, Sider, Content } = Layout;

const iconMap: Record<string, React.ReactNode> = {
  DashboardOutlined: <DashboardOutlined />,
  EnvironmentOutlined: <EnvironmentOutlined />,
  TeamOutlined: <TeamOutlined />,
  ClusterOutlined: <ClusterOutlined />,
  FileTextOutlined: <FileTextOutlined />,
  ScheduleOutlined: <ScheduleOutlined />,
  HistoryOutlined: <HistoryOutlined />,
  AuditOutlined: <AuditOutlined />,
  BarChartOutlined: <BarChartOutlined />,
  AlertOutlined: <AlertOutlined />,
  SafetyCertificateOutlined: <SafetyCertificateOutlined />,
  SettingOutlined: <SettingOutlined />,
  AccountBookOutlined: <AccountBookOutlined />,
};

const roleLabel: Record<string, string> = {
  super_admin: "超级管理员",
  site_manager: "网格长",
  inspector: "工程师",
};

function toMenuItems(items: MenuConfig[]): MenuProps["items"] {
  return items.map((m) => {
    if (m.children?.length) {
      return {
        key: m.key,
        icon: m.icon ? iconMap[m.icon] : null,
        label: m.label,
        children: toMenuItems(m.children),
      };
    }
    return {
      key: m.path,
      icon: m.icon ? iconMap[m.icon] : null,
      label: m.label,
    };
  });
}

const PAGE_SCROLL_PATHS = ["/dashboard", "/settings", "/analysis", "/finance/dashboard", "/403", "/income"];

function isPageScrollPath(pathname: string) {
  return PAGE_SCROLL_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>([]);
  const [mounted, setMounted] = useState(false);
  const [shellReady, setShellReady] = useState(false);
  const router = useRouter();
  const pathname = usePathname() || "";
  const { user, logout, hydrated } = useAuthStore();
  const branding = useBrandingStore((s) => s.branding);
  const screens = Grid.useBreakpoint();
  const isMobile = mounted && !screens.md;

  useEffect(() => {
    setMounted(true);
  }, []);

  const menuTree = useMemo(() => (user ? getMenusByRole(user.role) : []), [user]);
  const leafMenus = useMemo(() => flattenMenus(menuTree), [menuTree]);
  const menus = useMemo(() => toMenuItems(menuTree), [menuTree]);

  const selectedKeys = useMemo(() => {
    const match = leafMenus
      .filter((m) => pathname === m.path || pathname.startsWith(`${m.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    return match ? [match.path] : [];
  }, [pathname, leafMenus]);

  const currentTitle = useMemo(() => {
    const leaf = leafMenus.find((m) => selectedKeys.includes(m.path));
    if (leaf) return leaf.label;
    const group = menuTree.find((m) => pathname.startsWith(m.path));
    return group?.label || "工作台";
  }, [leafMenus, selectedKeys, menuTree, pathname]);

  useEffect(() => {
    if (pathname.startsWith("/finance")) {
      setOpenKeys((prev) => (prev.includes("finance") ? prev : [...prev, "finance"]));
    }
  }, [pathname]);

  useEffect(() => {
    if (!hydrated) return;
    if (!user) {
      setShellReady(false);
      router.replace("/login");
      return;
    }
    if (user.role === "inspector") {
      setShellReady(false);
      router.replace(roleHome("inspector"));
      return;
    }
    setShellReady(true);
  }, [user, router, hydrated]);

  const handleLogout = () => {
    logout();
    router.replace("/login");
  };

  const ready = Boolean(hydrated && user && shellReady);

  const menuNode = (
    <>
      <div className="app-brand">
        <div className="app-brand__mark" aria-hidden>
          {branding.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={branding.logoUrl} alt="" className="app-brand__logo" />
          ) : (
            brandMarkText(branding.systemName)
          )}
        </div>
        {(!collapsed || isMobile) && (
          <div className="app-brand__text">
            <div className="app-brand__title">{branding.systemName || "阳光运维"}</div>
            <div className="app-brand__sub">{branding.subtitle || "阳光运维平台"}</div>
          </div>
        )}
      </div>
      <Menu
        className="app-menu"
        theme="dark"
        mode="inline"
        selectedKeys={selectedKeys}
        openKeys={collapsed && !isMobile ? [] : openKeys}
        onOpenChange={(keys) => setOpenKeys(keys as string[])}
        items={menus}
        onClick={({ key }) => {
          if (String(key).startsWith("/")) {
            router.push(key);
            setMobileMenuOpen(false);
          }
        }}
      />
    </>
  );

  return (
    <Layout className="app-shell">
      {!isMobile && (
        <Sider className="app-sider" collapsed={collapsed} trigger={null} width={232} collapsedWidth={76}>
          {ready ? menuNode : null}
        </Sider>
      )}
      <Drawer
        className="mobile-drawer"
        open={isMobile && mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        placement="left"
        width={268}
        closable={false}
      >
        {ready ? menuNode : null}
      </Drawer>
      <Layout className="app-main">
        <Header className="app-header">
          <div className="app-header__left">
            <Button
              type="text"
              className="app-menu-toggle"
              icon={isMobile || collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => (isMobile ? setMobileMenuOpen(true) : setCollapsed(!collapsed))}
            />
            <div>
              <h1 className="app-page-title">{currentTitle}</h1>
              <div className="app-page-subtitle">{branding.subtitle || "阳光运维工作台"}</div>
            </div>
          </div>
          {user ? (
            <Dropdown
              menu={{
                items: [
                  ...(canSwitchPortal(
                    normalizeRoles(user.roles as AppRole[] | undefined, user.role as AppRole),
                  )
                    ? [
                        {
                          key: "switch-role",
                          icon: <TeamOutlined />,
                          label: "切换入口",
                          onClick: () => router.push("/"),
                        },
                      ]
                    : []),
                  {
                    key: "settings",
                    icon: <SettingOutlined />,
                    label: "系统设置",
                    onClick: () => router.push("/settings"),
                  },
                  {
                    key: "logout",
                    icon: <LogoutOutlined />,
                    label: "退出登录",
                    onClick: handleLogout,
                  },
                ],
              }}
            >
              <div className="app-user">
                <Avatar className="app-user__avatar" icon={<UserOutlined />} src={user.avatar} />
                <div className="app-user__meta">
                  <div className="app-user__name">{user.realName}</div>
                  <div className="app-user__role">{roleLabel[user.role] || "未知角色"}</div>
                </div>
              </div>
            </Dropdown>
          ) : (
            <div className="app-user" />
          )}
        </Header>
        <Content className="app-content">
          {!ready && <div className="p-10 text-center">加载中…</div>}
          <div
            className={`app-content__surface${isPageScrollPath(pathname) ? " is-page-scroll" : ""}`}
            hidden={!ready}
          >
            {children}
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
