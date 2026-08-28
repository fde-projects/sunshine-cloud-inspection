"use client";

import NextLink from "next/link";
import {
  useRouter,
  usePathname,
  useParams as useNextParams,
  useSearchParams as useNextSearchParams,
} from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";

type NavOpts = { replace?: boolean; state?: unknown };

const LocationStateContext = createContext<unknown>(undefined);

export function useNavigate() {
  const router = useRouter();
  return useCallback(
    (to: string | number, opts?: NavOpts) => {
      if (typeof to === "number") {
        router.back();
        return;
      }
      if (opts?.state !== undefined && typeof window !== "undefined") {
        try {
          sessionStorage.setItem("rr-location-state", JSON.stringify(opts.state));
        } catch {
          /* ignore */
        }
      }
      if (opts?.replace) router.replace(to);
      else router.push(to);
    },
    [router],
  );
}

export function useLocation() {
  const pathname = usePathname() || "";
  const searchParams = useNextSearchParams() ?? new URLSearchParams();
  const search = searchParams.toString();
  const ctxState = useContext(LocationStateContext);
  let state = ctxState;
  if (state === undefined && typeof window !== "undefined") {
    try {
      const raw = sessionStorage.getItem("rr-location-state");
      state = raw ? JSON.parse(raw) : null;
    } catch {
      state = null;
    }
  }
  return {
    pathname,
    search: search ? `?${search}` : "",
    hash: "",
    state: state ?? null,
    key: pathname,
  };
}

export function useParams<T extends Record<string, string> = Record<string, string>>(): T {
  return useNextParams() as T;
}

export function useSearchParams() {
  const sp = useNextSearchParams() ?? new URLSearchParams();
  const router = useRouter();
  const pathname = usePathname() || "";
  const setSearchParams = useCallback(
    (
      next: URLSearchParams | Record<string, string> | ((prev: URLSearchParams) => URLSearchParams),
      opts?: { replace?: boolean },
    ) => {
      const current = new URLSearchParams(sp.toString());
      const resolved =
        typeof next === "function"
          ? next(current)
          : next instanceof URLSearchParams
            ? next
            : new URLSearchParams(next);
      const q = resolved.toString();
      const href = q ? `${pathname}?${q}` : pathname;
      if (opts?.replace === false) router.push(href);
      else router.replace(href);
    },
    [pathname, router, sp],
  );
  return [sp, setSearchParams] as const;
}

export function Link({
  to,
  children,
  className,
  replace,
  ...rest
}: {
  to: string;
  children?: ReactNode;
  className?: string;
  replace?: boolean;
  [key: string]: unknown;
}) {
  return (
    <NextLink href={to} replace={replace} className={className} {...rest}>
      {children}
    </NextLink>
  );
}

export function Navigate({ to, replace }: { to: string; replace?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (replace) router.replace(to);
    else router.push(to);
  }, [to, replace, router]);
  return null;
}

export function Outlet() {
  return null;
}

export function useRouteError() {
  return new Error("页面出错");
}

export function RouterStateProvider({ children }: { children: ReactNode }) {
  const value = useMemo(() => undefined, []);
  return <LocationStateContext.Provider value={value}>{children}</LocationStateContext.Provider>;
}
