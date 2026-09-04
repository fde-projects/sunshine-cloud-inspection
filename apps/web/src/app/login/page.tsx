"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox, Form, Input, message } from "antd";
import {
  LockOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  CloudSyncOutlined,
} from "@ant-design/icons";
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
import "@/styles/pc-login.css";

type BackendStatus = "checking" | "ok" | "fail";

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, token, user, hydrate, logout } = useAuthStore();
  const branding = useBrandingStore((s) => s.branding);
  const [form] = Form.useForm();
  const [remember, setRemember] = useState(false);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [accountOpen, setAccountOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const accountBoxRef = useRef<HTMLDivElement>(null);
  const usernameValue = Form.useWatch("username", form) || "";
  const passwordValue = Form.useWatch("password", form) || "";
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("checking");

  useEffect(() => {
    hydrate();
    const saved = listSavedAccounts("pc");
    setAccounts(saved);
    const remembered = loadRememberedLogin("pc");
    if (remembered) {
      form.setFieldsValue({
        username: remembered.username,
        password: remembered.password,
      });
      setRemember(Boolean(remembered.password));
    }
  }, [form, hydrate]);

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setBackendStatus(d?.ok ? "ok" : "fail");
      })
      .catch(() => {
        if (!cancelled) setBackendStatus("fail");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onFinish = async (values: { username: string; password: string }) => {
    try {
      const loggedUser = await login(values.username, values.password, remember, "pc");
      rememberAccountAfterLogin("pc", {
        username: values.username,
        password: values.password,
        realName: loggedUser.realName,
        rememberPassword: remember,
      });
      message.success(`登录成功（${loggedUser.realName}）`);
      router.replace(nextPathAfterAuth(loggedUser));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "登录失败";
      if (msg.includes("手机作业端") || msg.includes("管理端身份")) {
        message.error(`${msg}。请打开 /m/login（首页 → 手机作业端）`);
      } else {
        message.error(msg);
      }
    }
  };

  const statusText =
    backendStatus === "checking"
      ? "正在检测后端连接…"
      : backendStatus === "ok"
        ? "后端已连接"
        : "后端不可用，请检查接口地址或网络";

  const continuePath = user ? nextPathAfterAuth(user) : "/login";

  return (
    <div className="pc-login-page">
      <div className="pc-login-shell">
        <section className="pc-login-visual">
          <div className="pc-login-visual__glow" />
          <div className="pc-login-visual__content">
            <div className="pc-login-visual__brand">
              <span className="pc-login-visual__mark" aria-hidden>
                {branding.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={branding.logoUrl} alt="" />
                ) : (
                  brandMarkText(branding.systemName)
                )}
              </span>
              <span>{branding.systemName}</span>
            </div>
            <div className="pc-login-visual__mobile-brand">
              <div className="pc-login-visual__mobile-logo" aria-hidden>
                {branding.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={branding.logoUrl} alt="" />
                ) : (
                  brandMarkText(branding.systemName)
                )}
              </div>
              <div className="pc-login-visual__eyebrow">管理工作台</div>
              <h1>{branding.systemName}</h1>
              <p>网格、任务与报告，统一管理</p>
            </div>
            <div className="pc-login-visual__main">
              <div className="pc-login-visual__eyebrow">智能能源运营管理</div>
              <h1>
                让每一次巡检
                <br />
                都清晰、可靠、可追溯
              </h1>
              <p>网格、任务、设备与报告统一管理，让团队专注现场和决策。</p>
              <div className="pc-login-features">
                <div>
                  <SafetyCertificateOutlined />
                  <span>
                    <b>规范巡检</b>
                    <small>流程标准化</small>
                  </span>
                </div>
                <div>
                  <ThunderboltOutlined />
                  <span>
                    <b>高效协同</b>
                    <small>多角色联动</small>
                  </span>
                </div>
                <div>
                  <CloudSyncOutlined />
                  <span>
                    <b>数据归档</b>
                    <small>全程可追溯</small>
                  </span>
                </div>
              </div>
            </div>
            <div className="pc-login-visual__foot">光伏 · 储能 · 安全 · 效率</div>
          </div>
        </section>

        <section className="pc-login-panel">
          <div className="pc-login-card">
            <a className="login-back" href="/">
              <span className="login-back__arrow" aria-hidden>
                ←
              </span>
              返回入口
            </a>

            <div className="pc-login-brand">
              <div className="pc-login-brand__logo" aria-hidden>
                {branding.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={branding.logoUrl} alt="" />
                ) : (
                  brandMarkText(branding.systemName)
                )}
              </div>
              <div>
                <div className="pc-login-brand__eyebrow">管理工作台</div>
                <h2>欢迎回来</h2>
                <p>请使用网格长或管理员账号登录</p>
              </div>
            </div>

            <div className="pc-login-card__head">
              <h2>管理端登录</h2>
              <span>请使用网格长或管理员账号</span>
            </div>

            <Form
              form={form}
              name="login"
              className="pc-login-form"
              onFinish={onFinish}
              size="large"
              layout="vertical"
              requiredMark={false}
            >
              {token && user ? (
                <div className="pc-login-session">
                  当前仍登录为 {user.realName}。可直接切换账号，或{" "}
                  <a
                    onClick={() => {
                      logout();
                      message.info("已退出，请重新登录");
                    }}
                  >
                    退出当前账号
                  </a>
                  ，也可 <a onClick={() => router.replace(continuePath)}>继续进入</a>
                </div>
              ) : null}
              <div className="login-account-field" ref={accountBoxRef}>
                <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                  <Input
                    prefix={<UserOutlined />}
                    placeholder="请输入用户名"
                    autoComplete="username"
                    suffix={
                      <span className="login-field-actions">
                        {String(usernameValue).trim() ? (
                          <LoginIconBtn
                            label="清空用户名"
                            onClick={() => form.setFieldsValue({ username: "" })}
                          >
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
                </Form.Item>
                {accountOpen ? (
                  accounts.length ? (
                    <LoginAccountMenu
                      accounts={accounts}
                      onSelect={(account) => {
                        form.setFieldsValue({
                          username: account.username,
                          password: account.password,
                        });
                        setRemember(Boolean(account.password));
                        setAccountOpen(false);
                      }}
                      onRemove={(username) => {
                        removeSavedAccount("pc", username);
                        const next = listSavedAccounts("pc");
                        setAccounts(next);
                        if (form.getFieldValue("username") === username) {
                          form.setFieldsValue({ username: "", password: "" });
                          setRemember(false);
                        }
                      }}
                    />
                  ) : (
                    <div className="login-account-menu login-account-menu--empty">登录成功后，账号会出现在这里</div>
                  )
                ) : null}
              </div>
              <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                <Input
                  prefix={<LockOutlined />}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  type={showPassword ? "text" : "password"}
                  suffix={
                    <span className="login-field-actions">
                      {String(passwordValue) ? (
                        <LoginIconBtn
                          label="清空密码"
                          onClick={() => form.setFieldsValue({ password: "" })}
                        >
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
                />
              </Form.Item>
              <div className="pc-login-options">
                <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
                  记住密码
                </Checkbox>
              </div>
              <Button type="primary" htmlType="submit" block loading={loading} className="pc-login-btn">
                进入管理端
              </Button>
            </Form>
            <p className="pc-login-alt">
              工程师请用手机打开{" "}
              <a href="/m/login">手机作业端</a>
              ；管理账号请继续在此登录。也可{" "}
              <a href="/">返回门户</a>
              {" "}重新选择入口。
            </p>
          </div>
          <div
            className={`pc-login-support${backendStatus === "fail" ? " is-fail" : ""}${
              backendStatus === "ok" ? " is-ok" : ""
            }`}
          >
            <span /> {statusText}
          </div>
        </section>
      </div>
    </div>
  );
}
