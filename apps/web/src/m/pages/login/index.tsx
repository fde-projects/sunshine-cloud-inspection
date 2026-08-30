"use client";

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Form, Field, Toast } from "react-vant";
import { nextPathAfterAuth, useAuthStore } from "@/stores/auth";
import { brandMarkText, useBrandingStore } from "@/stores/branding";
import "./login.css";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, loading, token, user, hydrate } = useAuthStore();
  const branding = useBrandingStore((s) => s.branding);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const redirectAfterLogin = (loggedUser: NonNullable<typeof user>) => {
    if (loggedUser.role !== "inspector") {
      window.location.replace(nextPathAfterAuth(loggedUser));
      return;
    }
    const memberships = (loggedUser.siteMemberships || []).filter((m) => m.site);
    if (memberships.length === 0) {
      navigate("/m/sites", { replace: true });
      return;
    }
    if (memberships.length === 1 && memberships[0].site) {
      useAuthStore.getState().setCurrentSite(memberships[0].site);
      navigate("/m", { replace: true });
      return;
    }
    if (!useAuthStore.getState().currentSite) {
      navigate("/m/sites", { replace: true });
      return;
    }
    navigate("/m", { replace: true });
  };

  const onSubmit = async () => {
    if (!username || !password) {
      Toast.info("请输入用户名和密码");
      return;
    }
    try {
      const loggedUser = await login(username.trim(), password, false, "h5");
      try {
        await useAuthStore.getState().fetchMe();
      } catch {
        /* 网格列表稍后在选站页再拉 */
      }
      const fresh = useAuthStore.getState().user || loggedUser;
      Toast.success(`登录成功（${fresh.realName}）`);
      redirectAfterLogin(fresh);
    } catch (e) {
      Toast.fail(e instanceof Error ? e.message : "登录失败");
    }
  };

  return (
    <div className="h5-login-page">
      <button type="button" className="login-back" onClick={() => (window.location.href = "/")}>
        <span className="login-back__arrow" aria-hidden>
          ←
        </span>
        返回入口
      </button>

      <div className="h5-login-page__inner">
        <div className="h5-login-brand">
          <div className="h5-login-brand__logo" aria-hidden>
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt="" />
            ) : (
              brandMarkText(branding.systemName)
            )}
          </div>
          <div className="h5-login-brand__eyebrow">现场作业端</div>
          <h1>{branding.systemName}</h1>
          <p>现场作业、照片与报告，随时掌握</p>
        </div>

        <div className="h5-login-card">
          <div className="h5-login-card__head">
            <h2>工程师登录</h2>
            <span>请使用已聘用的工程师账号</span>
          </div>
          <Form>
            {token && user ? (
              <div className="h5-login-switch-hint">
                当前：{user.realName}。输入其他账号可切换，或先退出再登。
              </div>
            ) : null}
            <Field label="用户名" placeholder="请输入用户名" value={username} onChange={setUsername} />
            <Field
              type="password"
              label="密码"
              placeholder="请输入密码"
              value={password}
              onChange={setPassword}
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onSubmit();
                }
              }}
            />
          </Form>
          <div className="h5-login-actions">
            <Button
              type="primary"
              block
              round
              loading={loading}
              nativeType="button"
              onClick={() => void onSubmit()}
              className="h5-login-btn"
            >
              进入作业端
            </Button>
          </div>
        </div>
        <div className="h5-login-trust">
          <i /> 数据安全传输 · 作业记录自动保存
        </div>
      </div>
    </div>
  );
}
