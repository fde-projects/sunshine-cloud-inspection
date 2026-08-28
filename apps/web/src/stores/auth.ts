"use client";

import { create } from "zustand";
import type { SiteBrief, UserInfo } from "@/types";
import { getMeApi } from "@/api/auth";
import { clearSession, getStoredUser, getToken, setSession } from "@/lib/session";

const SITE_KEY = "currentSite";

type AuthState = {
  token: string | null;
  user: UserInfo | null;
  currentSite: SiteBrief | null;
  hydrated: boolean;
  loading: boolean;
  hydrate: () => void;
  login: (username: string, password: string, remember?: boolean) => Promise<UserInfo>;
  logout: () => void;
  fetchMe: () => Promise<void>;
  setCurrentSite: (site: SiteBrief) => void;
};

function toUser(raw: Partial<UserInfo> & { id: string; username: string; realName: string; role: UserInfo["role"] }): UserInfo {
  return {
    status: raw.status || "active",
    phone: raw.phone || "",
    roles: raw.roles || [raw.role],
    ...raw,
  };
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  currentSite: null,
  hydrated: false,
  loading: false,
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
      set({
        token,
        user: toUser({
          id: stored.id,
          username: stored.username,
          realName: stored.realName,
          phone: stored.phone,
          role: stored.role as UserInfo["role"],
          roles: (stored.roles || []) as UserInfo["role"][],
        }),
        currentSite,
        hydrated: true,
      });
      return;
    }
    set({ token: null, user: null, currentSite: null, hydrated: true });
  },
  login: async (username, password, remember) => {
    set({ loading: true, token: null, user: null, currentSite: null });
    clearSession();
    localStorage.removeItem(SITE_KEY);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "登录失败");
      const user = toUser(data.user);
      setSession(data.token, {
        id: user.id,
        username: user.username,
        realName: user.realName,
        role: user.role,
        roles: user.roles || [user.role],
        phone: user.phone,
      });
      if (remember) localStorage.setItem("rememberedUsername", username);
      else localStorage.removeItem("rememberedUsername");
      set({ token: data.token, user, loading: false });
      return user;
    } catch (e) {
      set({ loading: false });
      throw e;
    }
  },
  logout: () => {
    clearSession();
    localStorage.removeItem(SITE_KEY);
    set({ token: null, user: null, currentSite: null });
  },
  fetchMe: async () => {
    const user = toUser(await getMeApi());
    const token = getToken();
    if (token) {
      setSession(token, {
        id: user.id,
        username: user.username,
        realName: user.realName,
        role: user.role,
        roles: user.roles || [user.role],
        phone: user.phone,
      });
    }
    set({ user });
  },
  setCurrentSite: (site) => {
    localStorage.setItem(SITE_KEY, JSON.stringify(site));
    set({ currentSite: site });
  },
}));
