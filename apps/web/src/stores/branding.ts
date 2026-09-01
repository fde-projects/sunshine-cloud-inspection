"use client";

import { create } from 'zustand';
import { fetchSystemBranding, type SystemBranding } from '../api/system';

const CACHE_KEY = 'systemBranding';
/** 同源代理，保证标签图标可随品牌 Logo 更新 */
const FAVICON_API = '/api/system/favicon';

export const DEFAULT_BRANDING: SystemBranding = {
  systemName: '阳光运维系统',
  subtitle: '阳光运维平台',
  logoUrl: null,
};

function readCache(): SystemBranding {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return DEFAULT_BRANDING;
    const parsed = JSON.parse(raw) as Partial<SystemBranding>;
    return {
      systemName: parsed.systemName?.trim() || DEFAULT_BRANDING.systemName,
      subtitle: parsed.subtitle ?? DEFAULT_BRANDING.subtitle,
      logoUrl: parsed.logoUrl || null,
      updatedAt: parsed.updatedAt ?? null,
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

function writeCache(branding: SystemBranding) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(branding));
  } catch {
    // ignore quota
  }
}

/** 同步浏览器标签标题（对抗 App Router metadata 回写） */
export function applyDocumentTitle(name: string) {
  if (typeof document === 'undefined') return;
  const title = (name || DEFAULT_BRANDING.systemName).trim() || DEFAULT_BRANDING.systemName;
  if (document.title !== title) {
    document.title = title;
  }
  const el = document.querySelector('head > title');
  if (el && el.textContent !== title) {
    el.textContent = title;
  }
}

/**
 * 同步浏览器标签图标。
 * 覆盖所有 rel=icon 相关 link（含 Next metadata / app/icon），并维护自有节点。
 */
export function applyFavicon(_logoUrl: string | null, version?: string | null) {
  if (typeof document === 'undefined' || !document.head) return;
  const v = version || String(Date.now());
  const href = `${FAVICON_API}?v=${encodeURIComponent(v)}`;

  const ensure = (rel: string, attrs?: Record<string, string>) => {
    const selector = `link[data-branding-favicon="1"][rel="${rel}"]`;
    let link = document.head.querySelector(selector) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.setAttribute('data-branding-favicon', '1');
      link.rel = rel;
      document.head.appendChild(link);
    }
    if (attrs) {
      for (const [k, val] of Object.entries(attrs)) {
        link.setAttribute(k, val);
      }
    }
    if (link.getAttribute('href') !== href) {
      link.setAttribute('href', href);
    }
  };

  ensure('icon', { type: 'image/png' });
  ensure('shortcut icon');
  ensure('apple-touch-icon');

  // Next.js metadata / app/icon 注入的节点也改成品牌接口，避免标签仍显示默认图
  document.head
    .querySelectorAll('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')
    .forEach((node) => {
      const link = node as HTMLLinkElement;
      if (link.getAttribute('data-branding-favicon') === '1') return;
      if (link.getAttribute('href') !== href) {
        link.setAttribute('href', href);
      }
    });
}

export function applyBrandingToDocument(branding: SystemBranding) {
  applyDocumentTitle(branding.systemName);
  applyFavicon(branding.logoUrl, branding.updatedAt);
}

type BrandingState = {
  branding: SystemBranding;
  loaded: boolean;
  loading: boolean;
  hydrate: () => void;
  refresh: () => Promise<SystemBranding>;
  setBranding: (branding: SystemBranding) => void;
};

export const useBrandingStore = create<BrandingState>((set, get) => ({
  branding: DEFAULT_BRANDING,
  loaded: false,
  loading: false,
  hydrate: () => {
    const cached = readCache();
    set({ branding: cached, loaded: true });
    applyBrandingToDocument(cached);
  },
  setBranding: (branding) => {
    writeCache(branding);
    applyBrandingToDocument(branding);
    set({ branding, loaded: true });
  },
  refresh: async () => {
    if (get().loading) return get().branding;
    set({ loading: true });
    try {
      const data = await fetchSystemBranding();
      const next: SystemBranding = {
        systemName: data?.systemName?.trim() || DEFAULT_BRANDING.systemName,
        subtitle: data?.subtitle ?? DEFAULT_BRANDING.subtitle,
        logoUrl: data?.logoUrl || null,
        updatedAt: data?.updatedAt ?? null,
      };
      const cached = readCache();
      const serverIsDefault =
        next.systemName === DEFAULT_BRANDING.systemName && !next.logoUrl;
      const cacheIsCustom =
        cached.systemName !== DEFAULT_BRANDING.systemName || Boolean(cached.logoUrl);
      if (serverIsDefault && cacheIsCustom && !next.updatedAt) {
        applyBrandingToDocument(cached);
        return cached;
      }
      get().setBranding(next);
      return next;
    } catch {
      if (!get().loaded) get().hydrate();
      else applyBrandingToDocument(get().branding);
      return get().branding;
    } finally {
      set({ loading: false });
    }
  },
}));

/** 品牌徽标：有 logo 显示图，否则取系统名首字 */
export function brandMarkText(systemName?: string | null) {
  const name = (systemName || DEFAULT_BRANDING.systemName).trim();
  return name.charAt(0) || '光';
}
