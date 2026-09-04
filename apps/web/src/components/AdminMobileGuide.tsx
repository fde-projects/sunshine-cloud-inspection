"use client";

import { useEffect, useMemo, useState } from "react";
import { Button, Grid, message } from "antd";
import { CloseOutlined, DesktopOutlined, LinkOutlined } from "@ant-design/icons";
import { brandMarkText, useBrandingStore } from "@/stores/branding";
import {
  dismissBannerToday,
  dismissGateToday,
  isBannerDismissedToday,
  isGateDismissedToday,
  matchDesktopPreferred,
} from "@/utils/adminMobileGuide";
import "@/styles/admin-mobile-guide.css";

type Props = {
  pathname: string;
};

export default function AdminMobileGuide({ pathname }: Props) {
  const branding = useBrandingStore((s) => s.branding);
  const screens = Grid.useBreakpoint();
  const [mounted, setMounted] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);

  const preferred = useMemo(() => matchDesktopPreferred(pathname), [pathname]);
  const isMobile = mounted && !screens.md;
  const systemName = branding.systemName?.trim() || "阳光运维系统";

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted || screens.md) {
      setBannerOpen(false);
      setGateOpen(false);
      return;
    }
    setBannerOpen(!isBannerDismissedToday());
    if (preferred && !isGateDismissedToday(preferred.prefix)) {
      setGateOpen(true);
    } else {
      setGateOpen(false);
    }
  }, [mounted, screens.md, preferred]);

  if (!isMobile) return null;

  const copyDesktopLink = async () => {
    const url = typeof window !== "undefined" ? window.location.href : "";
    try {
      await navigator.clipboard.writeText(url);
      message.success("链接已复制，请到电脑浏览器打开");
    } catch {
      message.info(url || "请手动复制地址栏链接到电脑打开");
    }
  };

  return (
    <>
      {bannerOpen && !gateOpen ? (
        <div className="admin-mobile-guide-banner" role="status">
          <div className="admin-mobile-guide-banner__icon" aria-hidden>
            <DesktopOutlined />
          </div>
          <div className="admin-mobile-guide-banner__text">
            <strong>管理后台建议使用电脑</strong>
            <span>
              手机可浏览与审批；配置、导入、地图等复杂操作请在 Chrome / Edge 完成。
            </span>
          </div>
          <button
            type="button"
            className="admin-mobile-guide-banner__close"
            aria-label="今日不再提示"
            onClick={() => {
              dismissBannerToday();
              setBannerOpen(false);
            }}
          >
            <CloseOutlined />
          </button>
        </div>
      ) : null}

      {gateOpen && preferred ? (
        <div className="admin-mobile-guide-gate" role="dialog" aria-modal="true">
          <div className="admin-mobile-guide-gate__card">
            <div className="admin-mobile-guide-gate__visual" aria-hidden>
              <div className="admin-mobile-guide-gate__desk">
                <div className="admin-mobile-guide-gate__desk-bar">
                  <span />
                  <span />
                  <span />
                </div>
                <div className="admin-mobile-guide-gate__desk-body">
                  <div className="admin-mobile-guide-gate__mark">
                    {branding.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={branding.logoUrl} alt="" />
                    ) : (
                      brandMarkText(systemName)
                    )}
                  </div>
                  <div className="admin-mobile-guide-gate__desk-lines">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
              <div className="admin-mobile-guide-gate__phone">
                <div className="admin-mobile-guide-gate__phone-notch" />
                <div className="admin-mobile-guide-gate__phone-body">
                  <span>现场端</span>
                </div>
              </div>
            </div>

            <h2 className="admin-mobile-guide-gate__title">{preferred.title}</h2>
            <p className="admin-mobile-guide-gate__lead">
              {systemName} 已区分现场端与管理端：现场作业用手机，管理配置请用电脑浏览器（Chrome /
              Edge），操作更稳、不易出错。
            </p>
            <p className="admin-mobile-guide-gate__reason">{preferred.reason}</p>

            <div className="admin-mobile-guide-gate__actions">
              <Button
                type="primary"
                icon={<LinkOutlined />}
                block
                onClick={() => void copyDesktopLink()}
              >
                复制链接，到电脑打开
              </Button>
              <Button
                block
                onClick={() => {
                  dismissGateToday(preferred.prefix);
                  dismissBannerToday();
                  setGateOpen(false);
                  setBannerOpen(false);
                }}
              >
                仍用手机继续浏览
              </Button>
            </div>
            <p className="admin-mobile-guide-gate__hint">今日选择后本页不再打扰；列表与审批仍可手机使用。</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
