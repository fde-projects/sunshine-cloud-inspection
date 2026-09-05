"use client";

import { isIosDevice, isSecureInstallContext } from "../utils/addToHome";
import "./add-to-home.css";

type Props = {
  onClose?: () => void;
};

/**
 * 仅「我的」入口打开：浏览器不能直接弹系统安装框时，给出操作说明。
 */
export default function AddToHomePrompt({ onClose }: Props) {
  const ios = isIosDevice();
  const secure = isSecureInstallContext();

  return (
    <div className="m-a2hs-mask" role="dialog" aria-modal="true" aria-labelledby="m-a2hs-title">
      <div className="m-a2hs-sheet">
        <h2 id="m-a2hs-title">把作业端放到桌面</h2>
        <p className="m-a2hs-sheet__lead">
          {ios
            ? "iPhone 不支持一键安装，按下面三步即可。"
            : secure
              ? "当前浏览器没有弹出系统安装框，可按菜单手动添加。"
              : "当前是网页地址（非安全链接），浏览器不会弹出「一键添加」，请用菜单手动添加。"}
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
        <div className="m-a2hs-sheet__foot">
          <button type="button" className="m-a2hs__primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
