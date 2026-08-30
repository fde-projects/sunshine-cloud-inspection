"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { nextPathAfterAuth, useAuthStore } from "@/stores/auth";
import { brandMarkText, useBrandingStore } from "@/stores/branding";
import { canSwitchPortal, normalizeRoles, roleForPortal, roleHome } from "@/lib/portal";
import type { AppRole } from "@/lib/types";
import "@/styles/portal.css";

export default function PortalPage() {
  const router = useRouter();
  const { token, user, hydrate, selectRole } = useAuthStore();
  const branding = useBrandingStore((s) => s.branding);
  const [entering, setEntering] = useState<"pc" | "h5" | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const enter = async (portal: "pc" | "h5") => {
    if (entering) return;
    const roles = user
      ? normalizeRoles(user.roles as AppRole[] | undefined, user.role as AppRole)
      : [];
    const wanted = token && user ? roleForPortal(portal, roles) : null;
    if (wanted) {
      setEntering(portal);
      try {
        if (user && user.role !== wanted) await selectRole(wanted);
        router.push(roleHome(wanted));
      } catch {
        router.push(portal === "pc" ? "/login" : "/m/login");
      } finally {
        setEntering(null);
      }
      return;
    }
    router.push(portal === "pc" ? "/login" : "/m/login");
  };

  return (
    <div className="portal-page">
      <div className="portal-page__inner">
        <div className="portal-brand">
          <div className="portal-brand__logo" aria-hidden>
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt="" />
            ) : (
              brandMarkText(branding.systemName)
            )}
          </div>
          <div className="portal-brand__eyebrow">{branding.subtitle || "阳光运维平台"}</div>
          <h1 className="portal-brand__title">{branding.systemName}</h1>
          <p className="portal-brand__subtitle">为管理与现场作业提供清晰、可靠的一体化工作台</p>
          {token && user ? (
            <p className="portal-brand__subtitle" style={{ marginTop: 8, opacity: 0.9 }}>
              当前账号：{user.realName} ·{" "}
              <a
                style={{ color: "#16835f", textDecoration: "underline", cursor: "pointer" }}
                onClick={() => router.push(nextPathAfterAuth(user))}
              >
                继续进入
              </a>
              {canSwitchPortal(
                normalizeRoles(user.roles as AppRole[] | undefined, user.role as AppRole),
              )
                ? "（点下方卡片可换到另一端）"
                : ""}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          className="portal-card"
          disabled={entering !== null}
          onClick={() => void enter("pc")}
        >
          <span className="portal-card__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="26" height="26">
              <rect x="3" y="3" width="8" height="8" rx="1.5" fill="#fff" />
              <rect x="13" y="3" width="8" height="8" rx="1.5" fill="#fff" />
              <rect x="3" y="13" width="8" height="8" rx="1.5" fill="#fff" />
              <rect x="13" y="13" width="8" height="8" rx="1.5" fill="#fff" />
            </svg>
          </span>
          <span className="portal-card__text">
            <span className="portal-card__title">电脑管理后台</span>
            <span className="portal-card__desc">管理员 / 网格长入口</span>
          </span>
          <span className="portal-card__arrow">{entering === "pc" ? "…" : "›"}</span>
        </button>

        <button type="button" className="portal-card" disabled={entering !== null} onClick={() => void enter("h5")}>
          <span className="portal-card__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="26" height="26">
              <rect x="7" y="2" width="10" height="20" rx="2" fill="none" stroke="#fff" strokeWidth="2" />
              <circle cx="12" cy="18" r="1.2" fill="#fff" />
            </svg>
          </span>
          <span className="portal-card__text">
            <span className="portal-card__title">手机作业端</span>
            <span className="portal-card__desc">工程师现场作业入口</span>
          </span>
          <span className="portal-card__arrow">{entering === "h5" ? "…" : "›"}</span>
        </button>
        <div className="portal-note">
          <span /> 系统服务正常　·　请根据工作场景选择入口
        </div>
      </div>
    </div>
  );
}
