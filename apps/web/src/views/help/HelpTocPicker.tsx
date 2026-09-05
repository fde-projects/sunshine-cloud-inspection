"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type HelpTocItem = { id: string; title: string };

export default function HelpTocPicker({
  items,
  value,
  onChange,
}: {
  items: HelpTocItem[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = items.find((item) => item.id === value)?.title || items[0]?.title || "选择章节";

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="help-toc-pick">
      <button
        type="button"
        className="help-toc-pick__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span>{current}</span>
        <i aria-hidden />
      </button>
      {open
        ? createPortal(
            <div className="help-toc-pick__layer" role="presentation">
              <button
                type="button"
                className="help-toc-pick__mask"
                aria-label="关闭章节列表"
                onClick={() => setOpen(false)}
              />
              <div className="help-toc-pick__sheet" role="listbox" aria-label="跳转到章节">
                <div className="help-toc-pick__grab" aria-hidden />
                <p className="help-toc-pick__title">跳转到章节</p>
                <ul className="help-toc-pick__list">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={item.id === value}
                        className={item.id === value ? "is-active" : undefined}
                        onClick={() => {
                          onChange(item.id);
                          setOpen(false);
                        }}
                      >
                        {item.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
