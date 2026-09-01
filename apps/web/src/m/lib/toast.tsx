"use client";

import { createRoot, type Root } from "react-dom/client";
import { createElement, useEffect, useState } from "react";

type ToastKind = "info" | "success" | "fail" | "loading";

let toastHost: HTMLDivElement | null = null;
let toastRoot: Root | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function ensureToastRoot() {
  if (typeof document === "undefined") return null;
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.id = "m-toast-root";
    document.body.appendChild(toastHost);
    toastRoot = createRoot(toastHost);
  }
  return toastRoot;
}

function showToast(message: string, kind: ToastKind, duration = 2200) {
  const root = ensureToastRoot();
  if (!root) return;
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  root.render(
    createElement(
      "div",
      { className: `m-app-toast m-app-toast--${kind}`, role: "status" },
      createElement("span", null, message),
    ),
  );
  if (kind !== "loading" && duration > 0) {
    toastTimer = setTimeout(() => {
      root.render(null);
      toastTimer = null;
    }, duration);
  }
}

/** React 19 下替代 react-vant Toast（其 imperative 渲染依赖已移除的 ReactDOM.render） */
export const Toast = {
  info: (message: string) => showToast(String(message ?? ""), "info"),
  success: (message: string) => showToast(String(message ?? ""), "success"),
  fail: (message: string) => showToast(String(message ?? ""), "fail"),
  loading: (message?: string) => showToast(String(message || "加载中…"), "loading", 0),
  clear: () => {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastRoot?.render(null);
  },
};

type ConfirmOpts = {
  title?: string;
  message?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
};

let dialogHost: HTMLDivElement | null = null;
let dialogRoot: Root | null = null;

function ConfirmDialog(props: {
  opts: ConfirmOpts;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return createElement(
    "div",
    { className: `m-app-dialog ${visible ? "is-open" : ""}` },
    createElement("div", { className: "m-app-dialog__mask", onClick: props.onCancel }),
    createElement(
      "div",
      { className: "m-app-dialog__panel", role: "dialog", "aria-modal": true },
      props.opts.title
        ? createElement("div", { className: "m-app-dialog__title" }, props.opts.title)
        : null,
      createElement("div", { className: "m-app-dialog__message" }, props.opts.message || ""),
      createElement(
        "div",
        { className: "m-app-dialog__actions" },
        createElement(
          "button",
          { type: "button", className: "m-app-dialog__btn", onClick: props.onCancel },
          props.opts.cancelButtonText || "取消",
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "m-app-dialog__btn m-app-dialog__btn--primary",
            onClick: props.onConfirm,
          },
          props.opts.confirmButtonText || "确认",
        ),
      ),
    ),
  );
}

function ensureDialogRoot() {
  if (typeof document === "undefined") return null;
  if (!dialogHost) {
    dialogHost = document.createElement("div");
    dialogHost.id = "m-dialog-root";
    document.body.appendChild(dialogHost);
    dialogRoot = createRoot(dialogHost);
  }
  return dialogRoot;
}

/** React 19 下替代 react-vant Dialog.confirm */
export const Dialog = {
  confirm(opts: ConfirmOpts = {}) {
    return new Promise<void>((resolve, reject) => {
      const root = ensureDialogRoot();
      if (!root) {
        reject(new Error("Dialog unavailable"));
        return;
      }
      const close = () => root.render(null);
      root.render(
        createElement(ConfirmDialog, {
          opts,
          onConfirm: () => {
            close();
            resolve();
          },
          onCancel: () => {
            close();
            reject(new Error("cancel"));
          },
        }),
      );
    });
  },
};
