"use client";

import { create } from "zustand";
import type { SiteBrief, UserInfo } from "@/types";
import { getMeApi } from "@/api/auth";
import {
  clearSession,
  getStoredUser,
  getToken,
  setRolePicked,
  setSession,
} from "@/lib/session";
import { roleHome } from "@/lib/portal";
import type { AppRole } from "@/lib/types";

const SITE_KEY = "currentSite";

type AuthState = {
  token: string | null;
  user: UserInfo | null;
  currentSite: SiteBrief | null;
  hydrated: boolean;
  loading: boolean;
  rolePicked: boolean;
  hydrate: () => void;
  login: (username: string, password: string, remember?: boolean, portal?: "pc" | "h5") => Promise<UserInfo>;
  selectRole: (role: AppRole) => Promise<UserInfo>;
  logout: () => void;
  fetchMe: () => Promise<void>;
  setCurrentSite: (site: SiteBrief) => void;
};

function toUser(
  raw: Partial<UserInfo> & { id: string; username: string; realName: string; role: UserInfo["role"] },
): UserInfo {
  return {
    status: raw.status || "active",
    phone: raw.phone || "",
    roles: raw.roles || [raw.role],
    ...raw,
  };
}

function persist(token: string, user: UserInfo) {
  setSession(token, {
    id: user.id,
    username: user.username,
    realName: user.realName,
    role: user.role,
    roles: user.roles || [user.role],
    phone: user.phone,
  });
}

export function nextPathAfterAuth(user: UserInfo): string {
  return roleHome(user.role as AppRole);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: null,
  user: null,
  currentSite: null,
  hydrated: false,
  loading: false,
  rolePicked: false,
  hydrate: () => {
    const token = getToken();
    const stored = getStoredUser();
    let currentSite: SiteBrief | null = null;
    try {
      const raw = localStorage.getItem(SITE_KEY);
      currentSite = raw ? (JSON.parse(raw) as SiteBrief) : null;
    } catch {
      localStorage.removeItem(SITE_KEY);
    }
    if (token && stored) {
      const user = toUser({
        id: stored.id,
        username: stored.username,
        realName: stored.realName,
        phone: stored.phone,
        role: stored.role as UserInfo["role"],
        roles: (stored.roles || []) as UserInfo["role"][],
      });
      set({
        token,
        user,
        currentSite,
        rolePicked: true,
        hydrated: true,
      });
      // 本地会话不含网格编制；后台补拉，避免个人资料显示「暂无所属网格」
      void get()
        .fetchMe()
        .catch(() => undefined);
      return;
    }
    set({ token: null, user: null, currentSite: null, rolePicked: false, hydrated: true });
  },
  login: async (username, password, _remember, portal) => {
    set({ loading: true, token: null, user: null, currentSite: null, rolePicked: false });
    clearSession();
    localStorage.removeItem(SITE_KEY);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password, portal }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "登录失败");
      const user = toUser(data.user);
      persist(data.token, user);
      setRolePicked(true);
      set({ token: data.token, user, loading: false, rolePicked: true });
      return user;
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },
  selectRole: async (role) => {
    const token = get().token || getToken();
    if (!token) throw new Error("未登录");
    set({ loading: true });
    try {
      const res = await fetch("/api/auth/switch-portal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "切换入口失败");
      const user = toUser(data.user);
      persist(data.token, user);
      setRolePicked(true);
      set({ token: data.token, user, loading: false, rolePicked: true });
      return user;
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },
  logout: () => {
    clearSession();
    localStorage.removeItem(SITE_KEY);
    set({ token: null, user: null, currentSite: null, rolePicked: false });
  },
  fetchMe: async () => {
    const user = toUser(await getMeApi());
    const token = getToken();
    if (token) persist(token, user);
    set({ user, rolePicked: true });
  },
  setCurrentSite: (site) => {
    localStorage.setItem(SITE_KEY, JSON.stringify(site));
    set({ currentSite: site });
  },
}));
