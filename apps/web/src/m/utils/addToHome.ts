export type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type Listener = (event: BeforeInstallPromptEvent | null) => void;

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let runtimeReady = false;
const listeners = new Set<Listener>();

function notify() {
  listeners.forEach((fn) => fn(deferredPrompt));
}

export function getDeferredInstall(): BeforeInstallPromptEvent | null {
  return deferredPrompt;
}

export function subscribeInstallPrompt(fn: Listener): () => void {
  listeners.add(fn);
  fn(deferredPrompt);
  return () => {
    listeners.delete(fn);
  };
}

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
    navigator.platform === "MacIntel" &&
    (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints! > 1;
  return /iPhone|iPad|iPod/i.test(ua) || iPadOs;
}

export function isSecureInstallContext(): boolean {
  if (typeof window === "undefined") return false;
  return window.isSecureContext || window.location.hostname === "localhost";
}

/** 有系统安装能力时直接弹出；否则返回 false，由页面展示操作说明。 */
export async function tryNativeInstall(): Promise<boolean> {
  const event = deferredPrompt;
  if (!event) return false;
  await event.prompt();
  await event.userChoice;
  deferredPrompt = null;
  notify();
  return true;
}

export function initAddToHomeRuntime(): void {
  if (typeof window === "undefined" || runtimeReady) return;
  runtimeReady = true;
  ensureMobileManifestLink();
  registerMobileServiceWorker();

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    notify();
  });
}

export function registerMobileServiceWorker(): void {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (!window.location.pathname.startsWith("/m")) return;
  void navigator.serviceWorker.register("/m/sw.js", { scope: "/m" }).catch(() => undefined);
}

export function ensureMobileManifestLink(): void {
  if (typeof document === "undefined") return;
  let link = document.querySelector<HTMLLinkElement>('link[rel="manifest"][data-m-pwa="1"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "manifest";
    link.setAttribute("data-m-pwa", "1");
    document.head.appendChild(link);
  }
  link.href = "/m/manifest.json";

  ensureMeta("apple-mobile-web-app-capable", "yes");
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
