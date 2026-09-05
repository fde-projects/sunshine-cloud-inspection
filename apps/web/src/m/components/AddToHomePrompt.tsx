"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { isIosDevice, isSecureInstallContext } from "../utils/addToHome";
import "./add-to-home.css";

type Props = {
  onClose?: () => void;
};

/**
 * 视口居中弹窗：点遮罩 / 「知道了」关闭；弹层内可滚，不锁死整页误触。
 */
export default function AddToHomePrompt({ onClose }: Props) {
  const ios = isIosDevice();
  const secure = isSecureInstallContext();

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const node = (
    <div
      className="m-a2hs-mask"
      role="dialog"
      aria-modal="true"
      aria-labelledby="m-a2hs-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="m-a2hs-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="m-a2hs-dialog__head">
          <h2 id="m-a2hs-title">把作业端放到桌面</h2>
          <button type="button" className="m-a2hs-dialog__close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
        <div className="m-a2hs-dialog__body">
          <p className="m-a2hs-dialog__lead">
            {ios
              ? "iPhone 不支持一键安装，按下面三步即可。"
              : secure
                ? "当前浏览器没有弹出系统安装框，可按菜单手动添加。"
                : "当前是局域网地址（http），浏览器不会弹出「一键添加」，请用菜单手动添加。"}
          </p>
          {ios ? (
            <ol className="m-a2hs-steps">
              <li>
                点击底部分享按钮 <span className="m-a2hs-share">□↑</span>
              </li>
              <li>
                下滑找到并点 <b>添加到主屏幕</b>
              </li>
              <li>
                确认名称后点 <b>添加</b>
              </li>
            </ol>
          ) : (
            <ol className="m-a2hs-steps">
              <li>打开浏览器菜单（右上角 ⋮ 或 ···）</li>
              <li>
                选择 <b>安装应用</b> / <b>添加到主屏幕</b>
              </li>
              <li>确认后桌面会出现「现场作业」图标</li>
            </ol>
          )}
        </div>
        <div className="m-a2hs-dialog__foot">
          <button type="button" className="m-a2hs__primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(node, document.body);
}
