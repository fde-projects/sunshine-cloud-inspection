const DISMISS_KEY = "m-a2hs-dismiss-until";
const DISMISS_DAYS = 14;

export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return true;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone) return true;
  return window.matchMedia("(display-mode: standalone)").matches;
}

export function isIosDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iPadOs =
    navigator.platform === "MacIntel" && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadOs;
}

export function isDismissed(): boolean {
  if (typeof window === "undefined") return true;
  const raw = window.localStorage.getItem(DISMISS_KEY);
  if (!raw) return false;
  const until = Number(raw);
  if (!Number.isFinite(until)) return false;
  return Date.now() < until;
}

export function dismissForWeeks(): void {
  if (typeof window === "undefined") return;
  const until = Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000;
  window.localStorage.setItem(DISMISS_KEY, String(until));
}

export function clearDismiss(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(DISMISS_KEY);
}

export function registerMobileServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.location.pathname.startsWith("/m")) return;
  void navigator.serviceWorker.register("/m/sw.js", { scope: "/m" }).catch(() => undefined);
}

export function ensureMobileManifestLink(): void {
  if (typeof document === "undefined") return;
  const rel = "manifest";
  let link = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"][data-m-pwa="1"]`);
  if (!link) {
    link = document.createElement("link");
    link.rel = rel;
    link.setAttribute("data-m-pwa", "1");
    document.head.appendChild(link);
  }
  link.href = "/m/manifest.json";

  const appleCapable = ensureMeta("apple-mobile-web-app-capable", "yes");
  appleCapable?.setAttribute("content", "yes");
  ensureMeta("apple-mobile-web-app-status-bar-style", "default");
  ensureMeta("apple-mobile-web-app-title", "现场作业");
  ensureMeta("mobile-web-app-capable", "yes");

  let appleIcon = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"][data-m-pwa="1"]');
  if (!appleIcon) {
    appleIcon = document.createElement("link");
    appleIcon.rel = "apple-touch-icon";
    appleIcon.setAttribute("data-m-pwa", "1");
    document.head.appendChild(appleIcon);
  }
  appleIcon.href = "/api/system/favicon";
}

function ensureMeta(name: string, content: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"][data-m-pwa="1"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    meta.setAttribute("data-m-pwa", "1");
    document.head.appendChild(meta);
  }
  meta.content = content;
  return meta;
}
