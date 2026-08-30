const TOKEN_KEY = "yangguang.jwt";
const USER_KEY = "yangguang.user";
const ROLE_PICKED_KEY = "yangguang.rolePicked";

export type StoredUser = {
  id: string;
  username: string;
  realName: string;
  role: string;
  roles: string[];
  phone: string;
};

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY) || localStorage.getItem("accessToken");
}

export function getStoredUser(): StoredUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY) || localStorage.getItem("userInfo");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: StoredUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  localStorage.setItem("accessToken", token);
  localStorage.setItem("refreshToken", token);
  localStorage.setItem("userInfo", JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("userInfo");
  localStorage.removeItem(ROLE_PICKED_KEY);
}

export function isRolePicked(): boolean | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ROLE_PICKED_KEY);
  if (raw === "1") return true;
  if (raw === "0") return false;
  return null;
}

export function setRolePicked(picked: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(ROLE_PICKED_KEY, picked ? "1" : "0");
}
