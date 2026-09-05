"use client";

import { useEffect, useState } from "react";
import {
  dismissForWeeks,
  ensureMobileManifestLink,
  isDismissed,
  isIosDevice,
  isStandaloneDisplay,
  registerMobileServiceWorker,
  type BeforeInstallPromptEvent,
} from "../utils/addToHome";
import "./add-to-home.css";

type Props = {
  /** 强制打开引导（如「我的」页入口），忽略 dismiss */
  forceOpen?: boolean;
  onClose?: () => void;
};

/**
 * 工程师端：登录后轻提示「添加到手机桌面」。
 * 安卓可走系统安装；iOS 展示分享步骤；均可关闭两周不再打扰。
 */
export default function AddToHomePrompt({ forceOpen = false, onClose }: Props) {
  const [visible, setVisible] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const ios = isIosDevice();

  useEffect(() => {
    ensureMobileManifestLink();
    registerMobileServiceWorker();

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    const timer = window.setTimeout(() => {
      if (isStandaloneDisplay()) return;
      if (!forceOpen && isDismissed()) return;
      setVisible(true);
      if (forceOpen) setGuideOpen(true);
    }, forceOpen ? 0 : 1600);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
    };
  }, [forceOpen]);

  const closeSoft = () => {
    dismissForWeeks();
    setVisible(false);
    setGuideOpen(false);
    onClose?.();
  };

  const openGuide = () => {
    setGuideOpen(true);
  };

  const installNative = async () => {
    if (!deferred) {
      setGuideOpen(true);
      return;
    }
    setBusy(true);
    try {
      await deferred.prompt();
      await deferred.userChoice;
      setDeferred(null);
      setVisible(false);
      setGuideOpen(false);
      onClose?.();
    } finally {
      setBusy(false);
    }
  };

  if (!visible && !forceOpen) return null;
  if (isStandaloneDisplay() && !forceOpen) return null;

  return (
    <>
      {visible && !guideOpen ? (
        <div className="m-a2hs" role="status">
          <div className="m-a2hs__icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
              <rect x="6" y="2.5" width="12" height="19" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
              <path
                d="M12 8.5v5.2M12 13.7l-2.1-2.1M12 13.7l2.1-2.1"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="17.6" r="0.9" fill="currentColor" />
            </svg>
          </div>
          <div className="m-a2hs__body">
            <strong>添加到手机桌面</strong>
            <p>下次点图标直达作业端</p>
          </div>
          <div className="m-a2hs__actions">
            <button type="button" className="m-a2hs__ghost" onClick={closeSoft}>
              暂不
            </button>
            <button
              type="button"
              className="m-a2hs__primary"
              disabled={busy}
              onClick={() => {
                if (deferred) void installNative();
                else openGuide();
              }}
            >
              {deferred ? "添加" : "方法"}
            </button>
          </div>
        </div>
      ) : null}

      {guideOpen ? (
        <div className="m-a2hs-mask" role="dialog" aria-modal="true" aria-labelledby="m-a2hs-title">
          <div className="m-a2hs-sheet">
            <h2 id="m-a2hs-title">把作业端放到桌面</h2>
            <p className="m-a2hs-sheet__lead">像普通 App 一样打开，拍照提交更顺手。</p>
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
            ) : deferred ? (
              <div className="m-a2hs-steps m-a2hs-steps--simple">
                <p>点击下方按钮，按系统提示完成安装即可。</p>
                <button
                  type="button"
                  className="m-a2hs__primary m-a2hs__primary--block"
                  disabled={busy}
                  onClick={() => void installNative()}
                >
                  {busy ? "请稍候…" : "添加到桌面"}
                </button>
              </div>
            ) : (
              <ol className="m-a2hs-steps">
                <li>打开浏览器菜单（右上角 ⋮ 或 ···）</li>
                <li>
                  选择 <b>安装应用</b> / <b>添加到主屏幕</b>
                </li>
                <li>确认后桌面会出现「现场作业」图标</li>
              </ol>
            )}
            <div className="m-a2hs-sheet__foot">
              <button type="button" className="m-a2hs__ghost" onClick={closeSoft}>
                两周内不再提醒
              </button>
              <button
                type="button"
                className="m-a2hs__ghost"
                onClick={() => {
                  setGuideOpen(false);
                  if (forceOpen) {
                    setVisible(false);
                    onClose?.();
                    return;
                  }
                }}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
