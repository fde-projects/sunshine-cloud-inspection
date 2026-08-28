"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Checkbox, Form, Input, message } from "antd";
import {
  LockOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  CloudSyncOutlined,
} from "@ant-design/icons";
import { useAuthStore } from "@/stores/auth";
import { getHomePathByRole } from "@/router/menus";
import "@/styles/pc-login.css";

type BackendStatus = "checking" | "ok" | "fail";

export default function LoginPage() {
  const router = useRouter();
  const { login, loading, token, user, hydrate, logout } = useAuthStore();
  const [form] = Form.useForm();
  const [remember, setRemember] = useState(false);
  const [backendStatus, setBackendStatus] = useState<BackendStatus>("checking");

  useEffect(() => {
    hydrate();
    const remembered = localStorage.getItem("rememberedUsername");
    if (remembered) {
      form.setFieldsValue({ username: remembered });
      setRemember(true);
    }
  }, [form, hydrate]);

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
      const loggedUser = await login(values.username, values.password, remember);
      message.success(`登录成功（${loggedUser.realName}）`);
      router.replace(getHomePathByRole(loggedUser.role));
    } catch (e) {
      message.error(e instanceof Error ? e.message : "登录失败");
    }
  };

  const statusText =
    backendStatus === "checking"
      ? "正在检测服务连接…"
      : backendStatus === "ok"
        ? "服务已连接"
        : "服务不可用，请检查网络";

  return (
    <div className="pc-login-page">
      <div className="pc-login-shell">
        <section className="pc-login-visual">
          <div className="pc-login-visual__glow" />
          <div className="pc-login-visual__content">
            <div className="pc-login-visual__brand">
              <span className="pc-login-visual__mark" aria-hidden>
                阳
              </span>
              <span>阳光运维</span>
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
            <div className="pc-login-brand">
              <div className="pc-login-brand__logo" aria-hidden>
                阳
              </div>
              <div>
                <div className="pc-login-brand__eyebrow">管理工作台</div>
                <h2>欢迎回来</h2>
                <p>管理员、网格长与工程师使用同一入口</p>
              </div>
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
              {token && user && (
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
                </div>
              )}
              <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                <Input prefix={<UserOutlined />} placeholder="请输入用户名" autoComplete="username" />
              </Form.Item>
              <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                <Input.Password prefix={<LockOutlined />} placeholder="请输入密码" autoComplete="current-password" />
              </Form.Item>
              <div className="pc-login-options">
                <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>
                  记住用户名
                </Checkbox>
                <span>安全加密登录</span>
              </div>
              <Button type="primary" htmlType="submit" block loading={loading} className="pc-login-btn">
                进入系统
              </Button>
            </Form>
            <div
              className={`pc-login-support${backendStatus === "fail" ? " is-fail" : ""}${
                backendStatus === "ok" ? " is-ok" : ""
              }`}
            >
              <span /> {statusText}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
