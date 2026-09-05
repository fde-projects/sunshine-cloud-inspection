"use client";

import { useRef } from "react";

type Props = {
  disabled?: boolean;
  /** 是否允许多选（系统相册/文件选择器支持时生效） */
  multiple?: boolean;
  busyLabel?: string;
  className?: string;
  onFiles: (files: File[]) => void;
};

/**
 * 点「＋」直接打开系统图片选择器（相机 / 相册 / 文件由系统分流）。
 * 必须在用户点击栈内同步 input.click()，否则部分 WebView 会拦截。
 */
export default function PhotoAddTile({
  disabled,
  multiple,
  busyLabel,
  className,
  onFiles,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className={["photo-add-tile", className].filter(Boolean).join(" ")}>
      <button
        type="button"
        className="inspection-photo-placeholder is-clickable"
        disabled={disabled}
        aria-label="添加照片"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled) return;
          const input = inputRef.current;
          if (!input) return;
          input.value = "";
          input.click();
        }}
      >
        <strong>{busyLabel || "＋"}</strong>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={!!multiple}
        style={{ display: "none" }}
        onChange={(e) => {
          const list = e.target.files;
          if (list?.length) onFiles(Array.from(list));
          e.target.value = "";
        }}
      />
    </div>
  );
}
