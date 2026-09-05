"use client";

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Form, Field, Toast } from "@/m/lib/react-vant";
import { nextPathAfterAuth, useAuthStore } from "@/stores/auth";
import { brandMarkText, useBrandingStore } from "@/stores/branding";
import {
  listSavedAccounts,
  loadRememberedLogin,
  rememberAccountAfterLogin,
  removeSavedAccount,
  type SavedAccount,
} from "@/lib/remember-login";
import { LoginAccountMenu, LoginIconBtn, IconClear, IconChevron, IconEye } from "@/components/login-account-menu";
import { prefetchMobileTabAssets, prefetchMobileTabData } from "@/m/utils/prefetchMobileTabs";
import "./login.css";

export default function LoginPage() {
  const navigate = useNavigate();
  const { login, loading, token, user, hydrate } = useAuthStore();
  const branding = useBrandingStore((s) => s.branding);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [accountOpen, setAccountOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const accountBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
    const saved = listSavedAccounts("h5");
    setAccounts(saved);
    const remembered = loadRememberedLogin("h5");
    if (remembered) {
      setUsername(remembered.username);
      setPassword(remembered.password);
      setRemember(Boolean(remembered.password));
    }
  }, [hydrate]);

  useEffect(() => {
    if (!accountOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!accountBoxRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [accountOpen]);

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
      const loggedUser = await login(username.trim(), password, remember, "h5");
      rememberAccountAfterLogin("h5", {
        username: username.trim(),
        password,
        realName: loggedUser.realName,
        rememberPassword: remember,
      });
      try {
        await useAuthStore.getState().fetchMe();
      } catch {
        /* 网格列表稍后在选站页再拉 */
      }
      const fresh = useAuthStore.getState().user || loggedUser;
      Toast.success(`登录成功（${fresh.realName}）`);
      // 进首页前先预热 Tab 资源，减轻首次切「作业/我的」卡顿
      prefetchMobileTabAssets();
      const siteId = useAuthStore.getState().currentSite?.id;
      prefetchMobileTabData(fresh.id, siteId);
      redirectAfterLogin(fresh);
    } catch (e) {
      Toast.fail(e instanceof Error ? e.message : "登录失败");
    }
  };

  return (
    <div className="h5-login-page">
      <a className="login-back" href="/">
        <span className="login-back__arrow" aria-hidden>
          ←
        </span>
        返回入口
      </a>

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
            <div className="login-account-field" ref={accountBoxRef}>
              <Field
                label="用户名"
                placeholder="请输入用户名"
                value={username}
                onChange={(value) => {
                  setUsername(value);
                }}
                suffix={
                  <span className="login-field-actions">
                    {username ? (
                      <LoginIconBtn label="清空用户名" onClick={() => setUsername("")}>
                        <IconClear />
                      </LoginIconBtn>
                    ) : null}
                    <LoginIconBtn
                      label="选择已登录账号"
                      extraClass={accountOpen ? "is-open" : ""}
                      onClick={() => setAccountOpen((open) => !open)}
                    >
                      <IconChevron open={accountOpen} />
                    </LoginIconBtn>
                  </span>
                }
              />
              {accountOpen ? (
                accounts.length ? (
                  <LoginAccountMenu
                    accounts={accounts}
                    onSelect={(account) => {
                      setUsername(account.username);
                      setPassword(account.password);
                      setRemember(Boolean(account.password));
                      setAccountOpen(false);
                    }}
                    onRemove={(name) => {
                      removeSavedAccount("h5", name);
                      const next = listSavedAccounts("h5");
                      setAccounts(next);
                      if (username === name) {
                        setUsername("");
                        setPassword("");
                        setRemember(false);
                      }
                    }}
                  />
                ) : (
                  <div className="login-account-menu login-account-menu--empty">登录成功后，账号会出现在这里</div>
                )
              ) : null}
            </div>
            <Field
              type={showPassword ? "text" : "password"}
              label="密码"
              placeholder="请输入密码"
              value={password}
              onChange={setPassword}
              suffix={
                <span className="login-field-actions">
                  {password ? (
                    <LoginIconBtn label="清空密码" onClick={() => setPassword("")}>
                      <IconClear />
                    </LoginIconBtn>
                  ) : null}
                  <LoginIconBtn
                    label={showPassword ? "隐藏密码" : "显示密码"}
                    onClick={() => setShowPassword((open) => !open)}
                  >
                    <IconEye hidden={!showPassword} />
                  </LoginIconBtn>
                </span>
              }
              onKeyPress={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onSubmit();
                }
              }}
            />
          </Form>
          <label className="h5-login-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            记住密码
          </label>
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
        <p className="h5-login-alt">
          管理员 / 网格长请使用{" "}
          <a href="/login">电脑管理后台</a>
          {" "}登录，或{" "}
          <a href="/">返回门户</a>
        </p>
        <div className="h5-login-trust">
          <i /> 数据安全传输 · 作业记录自动保存
        </div>
      </div>
    </div>
  );
}
