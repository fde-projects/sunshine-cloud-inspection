"use client";

import type { ReactNode } from "react";
import type { SavedAccount } from "@/lib/remember-login";
import "./login-account-menu.css";

export function LoginIconBtn({
  label,
  onClick,
  extraClass,
  children,
}: {
  label: string;
  onClick: () => void;
  extraClass?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`login-icon-btn${extraClass ? ` ${extraClass}` : ""}`}
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

export function IconClear() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <path d="M8.2 8.2l7.6 7.6M15.8 8.2l-7.6 7.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevron({ open }: { open?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden
      style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .16s" }}
    >
      <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconEye({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path
        d="M2.5 12s3.4-6.5 9.5-6.5S21.5 12 21.5 12 18.1 18.5 12 18.5 2.5 12 2.5 12z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.7" />
      {hidden ? (
        <path
          d="M4 4l16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      ) : null}
    </svg>
  );
}

export function LoginAccountMenu({
  accounts,
  onSelect,
  onRemove,
}: {
  accounts: SavedAccount[];
  onSelect: (account: SavedAccount) => void;
  onRemove: (username: string) => void;
}) {
  if (!accounts.length) return null;
  return (
    <ul className="login-account-menu" role="listbox">
      {accounts.map((account) => (
        <li key={account.username} className="login-account-menu__item">
          <button
            type="button"
            className="login-account-menu__pick"
            onClick={() => onSelect(account)}
          >
            <span className="login-account-menu__avatar" aria-hidden>
              {(account.realName || account.username).slice(0, 1)}
            </span>
            <span className="login-account-menu__meta">
              <strong>{account.username}</strong>
              {account.realName ? <small>{account.realName}</small> : null}
            </span>
          </button>
          <button
            type="button"
            className="login-account-menu__remove"
            aria-label={`删除 ${account.username}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRemove(account.username);
            }}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
